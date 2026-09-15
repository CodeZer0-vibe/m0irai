//! Parent-side consumption of the room host's close-digest handoff requests.
//!
//! WHY THIS EXISTS (m0irai Phase 5c, finding F10, measured 2026-08-18). The Node
//! room host is enrolled in a Windows Job Object created with
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
//! (`xai_tty_utils::ProcessGroup::new`, `rust/crates/codegen/xai-tty-utils/src/lib.rs:495`).
//! libuv never sets `CREATE_BREAKAWAY_FROM_JOB` for `detached: true`, so the
//! digest child the host forks while closing is *inside* that job and dies the
//! moment this process drops the job handle. The probe
//! (`.lead/tools/job-survival-probe.ps1`) measured: KILL_ON_JOB_CLOSE -> killed;
//! + BREAKAWAY_OK -> killed; + SILENT_BREAKAWAY_OK -> survived, but that flag
//! lets *every* host child (agent CLIs, PTY sessions) escape the reaper, so it
//! was rejected.
//!
//! The fix moves the child's *creation* to the only process outside the job:
//! this one. When launched with `ZER0_DIGEST_HANDOFF=1` the host appends a
//! durable request line instead of spawning, and this module spawns it after the
//! host has exited. Boot catch-up digests keep spawning in-process — they run
//! while the host runs, so the job close is not in their way.
//!
//! The seam is a file, not a channel, deliberately: it survives the host being
//! killed rather than closing gracefully, and it needs no live process on either
//! side at the moment of handover.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::Value;

/// The environment variable that switches the host's CLOSE digest from an
/// in-process fork to a request line. Set by `host_process::apply_host_env` for
/// every host this binary launches; read by the Node host as
/// `process.env.ZER0_DIGEST_HANDOFF === "1"`.
pub const HANDOFF_FLAG: &str = "ZER0_DIGEST_HANDOFF";

/// Seam version this binary consumes. A request carrying any other `v` is a
/// host/binary skew and is recorded rather than guessed at.
const REQUEST_VERSION: u64 = 1;
const REQUEST_KIND: &str = "digest";
const REQUEST_FILE: &str = "digest-requests.jsonl";
const FAILURE_FILE: &str = "digest-failures.log";
/// Stand-in session id for a record that could not name its session.
const UNKNOWN_SESSION: &str = "-";

/// What one consumption pass observed. Counts, not adjectives: a caller (and the
/// tests) can tell "nothing was handed off" from "one request was spawned" from
/// "a request was found and could not be started".
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct DigestHandoffOutcome {
    /// Requests whose child process was created.
    pub spawned: usize,
    /// Lines that did not parse as a v1 digest request; skipped and recorded.
    pub malformed: usize,
    /// Well-formed requests whose spawn failed; recorded.
    pub failed: usize,
}

impl DigestHandoffOutcome {
    /// True when this pass found nothing to do (no request file at all).
    pub fn is_empty(&self) -> bool {
        self.spawned == 0 && self.malformed == 0 && self.failed == 0
    }
}

/// The request folder the host writes into and this consumer reads.
pub fn journal_dir(operator_root: &Path) -> PathBuf {
    operator_root.join(".zer0").join("journal")
}

/// The append-only request file (seam path, both sides).
pub fn request_file(operator_root: &Path) -> PathBuf {
    journal_dir(operator_root).join(REQUEST_FILE)
}

/// The durable failure log shared with the Node child's own `fallbackLog`
/// (`src/memory/digest-failsafe.ts:155-161`).
pub fn failure_log(operator_root: &Path) -> PathBuf {
    journal_dir(operator_root).join(FAILURE_FILE)
}

/// Spawn every close-digest request the host handed off, then remove the file.
///
/// Idempotent: no file is a no-op, so calling this from both `shutdown()` and
/// `drop` costs nothing on the second call. A crash between a spawn and the
/// removal re-spawns at most a duplicate on the next pass, which the digest's
/// single-flight lease (`acquireDigestLock`) and watermark absorb — losing a
/// request would be the unrecoverable direction, so the file is deleted last.
///
/// Never returns an error and never panics: this runs on the shutdown path, and
/// a failure to start the digest must not become a failure to shut down. Every
/// failure lands in `digest-failures.log` instead.
pub fn consume_digest_requests(operator_root: &Path) -> DigestHandoffOutcome {
    debug_assert!(
        !operator_root.as_os_str().is_empty(),
        "consume_digest_requests needs the host's project root, got an empty path"
    );
    let journal = journal_dir(operator_root);
    let requests = journal.join(REQUEST_FILE);
    let mut outcome = DigestHandoffOutcome::default();
    let body = match read_requests(&requests) {
        ReadResult::Absent => return outcome,
        ReadResult::Body(body) => body,
        ReadResult::Unreadable(reason) => {
            record_failure(&journal, UNKNOWN_SESSION, &reason);
            outcome.failed += 1;
            return outcome;
        }
    };
    for (index, line) in body.lines().enumerate() {
        consume_line(&journal, index + 1, line, &mut outcome);
    }
    remove_consumed(&journal, &requests);
    outcome
}

enum ReadResult {
    Absent,
    Body(String),
    Unreadable(String),
}

fn read_requests(requests: &Path) -> ReadResult {
    match fs::read_to_string(requests) {
        Ok(body) => ReadResult::Body(body),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => ReadResult::Absent,
        Err(error) => ReadResult::Unreadable(format!(
            "parent handoff could not read {}: {error} — the close digest for this run was not \
             started; the request may still be readable by hand",
            requests.display()
        )),
    }
}

/// Validate the whole line first, spawn only after it is fully understood: a
/// half-validated request would otherwise start a child with, say, the right
/// argv and an env that silently lost its allowlist.
fn consume_line(journal: &Path, number: usize, line: &str, outcome: &mut DigestHandoffOutcome) {
    if line.trim().is_empty() {
        return;
    }
    match parse_request(line) {
        Ok(request) => match spawn_request(&request) {
            Ok(()) => outcome.spawned += 1,
            Err(reason) => {
                record_failure(
                    journal,
                    &request.session_id,
                    &format!("parent handoff spawn failed: {reason}"),
                );
                outcome.failed += 1;
            }
        },
        Err(malformed) => {
            record_failure(
                journal,
                &malformed.session_id,
                &format!(
                    "parent handoff skipped a malformed request (line {number}): {} — fix the \
                     writer in src/memory/digest-runner.ts; this session was not digested",
                    malformed.reason
                ),
            );
            outcome.malformed += 1;
        }
    }
}

fn remove_consumed(journal: &Path, requests: &Path) {
    match fs::remove_file(requests) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => record_failure(
            journal,
            UNKNOWN_SESSION,
            &format!(
                "parent handoff could not remove {}: {error} — its requests were already spawned, \
                 so the next run would spawn them again (harmless: the digest lease and watermark \
                 make a duplicate a no-op). Delete the file to silence this.",
                requests.display()
            ),
        ),
    }
}

/// One validated request. Only the four spawn inputs are kept; the rest of the
/// seam's fields are validated for presence and type (a truncated or garbled
/// line must be caught) and then dropped.
#[derive(Debug, Clone, PartialEq, Eq)]
struct DigestRequest {
    session_id: String,
    exec_path: PathBuf,
    argv: Vec<String>,
    cwd: PathBuf,
    env: BTreeMap<String, String>,
}

struct MalformedRequest {
    session_id: String,
    reason: String,
}

fn parse_request(line: &str) -> Result<DigestRequest, MalformedRequest> {
    let value: Value = serde_json::from_str(line).map_err(|error| MalformedRequest {
        session_id: UNKNOWN_SESSION.to_owned(),
        reason: format!("not JSON: {error}"),
    })?;
    let session_id = value
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or(UNKNOWN_SESSION)
        .to_owned();
    let bad = |reason: String| MalformedRequest {
        session_id: session_id.clone(),
        reason,
    };
    check_envelope(&value).map_err(&bad)?;
    // Present-and-typed but unused here: they are the host's own record of what it
    // asked for, and a line missing one of them is a writer bug worth catching
    // before a child is started with the rest. The seam calls every key required,
    // so every key is checked.
    //
    // Extra keys are deliberately NOT rejected: `v` is what governs skew, and
    // refusing a line because a newer host added a field would turn an additive
    // writer change into a silently lost digest for every session.
    for name in [
        "sessionId",
        "projectId",
        "repoRoot",
        "dbPath",
        "requestedAt",
    ] {
        require_string(&value, name).map_err(&bad)?;
    }
    Ok(DigestRequest {
        session_id: session_id.clone(),
        exec_path: PathBuf::from(require_string(&value, "execPath").map_err(&bad)?),
        argv: require_argv(&value).map_err(&bad)?,
        cwd: PathBuf::from(require_string(&value, "cwd").map_err(&bad)?),
        env: require_env(&value).map_err(&bad)?,
    })
}

fn check_envelope(value: &Value) -> Result<(), String> {
    match value.get("v").and_then(Value::as_u64) {
        Some(REQUEST_VERSION) => {}
        other => {
            return Err(format!(
                "seam version is {other:?}, this binary consumes v{REQUEST_VERSION} — the host and \
                 this binary came from different trees; rebuild both from one"
            ));
        }
    }
    match value.get("kind").and_then(Value::as_str) {
        Some(REQUEST_KIND) => Ok(()),
        other => Err(format!("kind is {other:?}, expected {REQUEST_KIND:?}")),
    }
}

fn require_string<'a>(value: &'a Value, name: &str) -> Result<&'a str, String> {
    match value.get(name).and_then(Value::as_str) {
        Some(text) if !text.is_empty() => Ok(text),
        Some(_) => Err(format!("{name} is empty")),
        None => Err(format!("{name} is missing or not a string")),
    }
}

fn require_argv(value: &Value) -> Result<Vec<String>, String> {
    let items = value
        .get("argv")
        .and_then(Value::as_array)
        .ok_or_else(|| "argv is missing or not an array".to_owned())?;
    if items.is_empty() {
        // A bare interpreter with no script is an interactive REPL that would hang
        // forever holding a process — never spawn one.
        return Err("argv is empty".to_owned());
    }
    items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            item.as_str()
                .map(str::to_owned)
                .ok_or_else(|| format!("argv[{index}] is not a string"))
        })
        .collect()
}

fn require_env(value: &Value) -> Result<BTreeMap<String, String>, String> {
    let object = value
        .get("env")
        .and_then(Value::as_object)
        .ok_or_else(|| "env is missing or not an object".to_owned())?;
    object
        .iter()
        .map(|(key, item)| {
            item.as_str()
                .map(|text| (key.clone(), text.to_owned()))
                .ok_or_else(|| format!("env[{key}] is not a string"))
        })
        .collect()
}

/// Create the child exactly as the host would have, minus the job.
///
/// The child is deliberately never enrolled in the caller's `ProcessScope`:
/// enrolling it would put it back in the job whose close is the whole finding.
/// It is also deliberately not waited on — it must outlive this process.
fn spawn_request(request: &DigestRequest) -> Result<(), String> {
    if !request.cwd.is_dir() {
        return Err(format!(
            "working directory {} does not exist — the request named a cwd that was removed \
             between the host's close and this spawn",
            request.cwd.display()
        ));
    }
    let mut command = Command::new(&request.exec_path);
    command
        .args(&request.argv)
        .current_dir(&request.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env_clear();
    for (key, value) in &request.env {
        command.env(key, value);
    }
    detach(&mut command);
    match command.spawn() {
        Ok(child) => {
            drop(child); // closes this side's handle; std's Drop neither waits nor kills
            Ok(())
        }
        Err(error) => Err(format!(
            "{} {}: {error}",
            request.exec_path.display(),
            request.argv.join(" ")
        )),
    }
}

#[cfg(windows)]
fn detach(command: &mut Command) {
    use std::os::windows::process::CommandExt as _;
    use windows::Win32::System::Threading::{
        CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, DETACHED_PROCESS,
    };
    // `DETACHED_PROCESS` is safe here and is NOT safe in
    // `xai_tty_utils::detach_std_command` (which documents the exclusion): that
    // helper's callers inherit stdio pipes, and detaching from the console breaks
    // pipe inheritance for grandchildren. This child's stdio is null on all three
    // handles, so it has no console to lose.
    command.creation_flags(DETACHED_PROCESS.0 | CREATE_NEW_PROCESS_GROUP.0 | CREATE_NO_WINDOW.0);
}

#[cfg(not(windows))]
fn detach(command: &mut Command) {
    // `setsid`, matching what Node's `detached: true` does on POSIX, so a Ctrl-C
    // in the operator's terminal cannot reach the digest child.
    xai_tty_utils::detach_std_command(command);
}

/// Same line shape as the Node child's `fallbackLog`
/// (`src/memory/digest-failsafe.ts:155-161`) so one file holds both sides'
/// catastrophes and one `tail` reads the whole story.
///
/// Best-effort by design: a log write must never block or fail a shutdown, and
/// there is nothing further to escalate to if the disk refuses.
fn record_failure(journal: &Path, session_id: &str, detail: &str) {
    let line = format!(
        "{} session={session_id} [digest-catastrophe] {detail}\n",
        now_iso()
    );
    if fs::create_dir_all(journal).is_err() {
        return;
    }
    let _ = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(journal.join(FAILURE_FILE))
        .and_then(|mut file| file.write_all(line.as_bytes()));
}

/// `2026-08-18T09:41:07.123Z` — byte-compatible with the Node side's
/// `new Date().toISOString()`, which is what already sits in this log.
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests;
