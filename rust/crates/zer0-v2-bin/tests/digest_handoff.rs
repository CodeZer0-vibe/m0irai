#![cfg(feature = "test-support")]
//! Phase 5c, finding F10: the close digest must outlive the packaged host's Job
//! Object.
//!
//! The Rust binary enrols the Node host in a job created with
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
//! (`xai_tty_utils::ProcessGroup::new`, `crates/codegen/xai-tty-utils/src/lib.rs`).
//! Every process the host creates is in that job, and libuv's `detached: true`
//! never sets `CREATE_BREAKAWAY_FROM_JOB`, so a digest the host forks while
//! closing dies the instant this process tears the job down. The fix moves the
//! child's *creation* to this process, which is outside the job.
//!
//! Six tests, in order of what they can establish today:
//!
//! 1. [`a_handed_off_child_outlives_the_job_that_kills_a_child_the_host_forked`]
//!    — the mechanism, with no dependency on the Node side. One child is forked
//!    by the host exactly the way libuv forks the digest; one is handed off
//!    through the request file. The job closes; the handed-off child writes its
//!    marker and the host's does not. This is F10 reproduced AND fixed.
//! 2. [`a_host_dropped_without_shutdown_still_starts_the_handed_off_digest`] and
//!    3. [`a_host_that_has_to_be_killed_still_starts_the_handed_off_digest`] —
//!    R3's other two call sites: the drop-without-shutdown path and the kill
//!    branch, the paths a wedged or crashed room takes.
//! 4. [`the_launcher_sets_the_handoff_flag_and_only_the_test_opt_out_removes_it`]
//!    — R1, read back from the host's own environment.
//! 5. [`the_close_digest_survives_the_job_when_the_host_hands_it_off`] — R4(b),
//!    the end-to-end: the real compiled host, a real session, the real digest,
//!    observed as rows in the memory DB.
//! 6. [`without_the_handoff_the_close_digest_does_not_survive_the_job`] — R4(c),
//!    the falsifier: the same sequence with the flag withheld must lose the
//!    digest.
//!
//! 5 and 6 are a matched pair: the SAME fixture, differing only in the flag.
//! They were written against a base with no write side, where 5 failed by
//! construction; since the Node write side landed on master (`src/memory/
//! digest-handoff.ts`) and this branch was rebased onto it, both are green and
//! the pair says something. MEASURED 2026-08-19, the two runs' own counts:
//! flag ON `{"completed":1,"journal":2,"watermark":1}`, flag OFF
//! `{"completed":1,"journal":0,"watermark":0}`. The `completed:1` in BOTH is
//! what makes 6 a falsifier rather than a tautology — the same work was there
//! to digest, and only the handed-off run survived the job close.

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use zer0_v2_bin::digest_handoff::request_file;
use zer0_v2_bin::host_process::{HostClient, HostError, HostProcess, HostProcessOptions};

/// Per-request bound for the room protocol calls. Generous on purpose: these
/// tests share a machine with the rest of the suite and a slow `initialize` is
/// not the failure any of them are looking for.
const STEP: Duration = Duration::from_secs(60);

/// How long the subject children sleep before writing their marker. It has
/// to exceed the time from "the host forked its child" to "the job closed",
/// which is one `initialize` + `session/new` + `shutdown` round trip; the test
/// asserts that margin held instead of assuming it (see `job_closed_by`).
const FORK_DELAY: Duration = Duration::from_secs(3);

/// Budget for "the job closed -> the handed-off child's marker is readable".
/// The child sleeps `FORK_DELAY` by construction; the spawn overhead on top of
/// it was measured by the consumer's own unit tests (10 runs, 50 markers: min
/// 0.6 ms, median 83.5 ms, max 113.2 ms). The 5 s of margin over `FORK_DELAY`
/// is ~44x that measured max. DIAGNOSIS TRIGGER, not a pass condition.
const MARKER_BUDGET: Duration = Duration::from_secs(8);

/// Budget for "the host closed -> the digest's rows are in the DB".
///
/// MEASURED 2026-08-19 on this machine (Windows 11, Node v24.18.0) on the REAL
/// path, after the write side landed: `await_digest`'s own clock, from the job
/// closing to the rows being readable, 8 runs of this test — 508, 527, 548,
/// 672, 716, 737, 783, 829 ms (min 508 / median 694 / max 829). The two
/// fastest are the runs where all six tests ran in parallel and the other six
/// ran the test alone, which is the opposite of what contention would predict,
/// so the spread is recorded as noise rather than explained. Each landing run
/// left exactly 1 `digest_watermark` row and 2 `journal_entries` rows. 20 s is ~24x
/// the measured max. Re-derive the numbers any time with
/// `cargo test ... --test digest_handoff -- --nocapture` — `await_digest`
/// prints each landing latency.
///
/// (The earlier figure in this comment, 776/818.5/829 ms, was the digest CHILD
/// timed out of band before the end-to-end existed. The real path measures the
/// same order, so the budget did not have to move.)
///
/// DIAGNOSIS TRIGGER, not a pass condition: a digest that has not landed in
/// twenty seconds is not slow, it is gone, and the timeout prints the request
/// file, the failure log, the journal folder and the leases to say why.
const DIGEST_BUDGET: Duration = Duration::from_secs(20);

const POLL: Duration = Duration::from_millis(50);

/// The canned extraction the digest child is fed instead of calling codex —
/// copied from `src/memory/digest-runner.test.ts` (`const FAKE`), which is the
/// one shape in the tree that parses into real facts. The oracle's
/// `ZER0_DIGEST_FAKE: "1"` does not: it fails the extraction schema, and the
/// pass then records a failure row and leaves the watermark unmoved, so a test
/// keyed on rows would never see them.
const DIGEST_FAKE: &str =
    r#"{"decisions":[{"topic":"fake","body":"fake decision"}],"summary":"fake"}"#;

// ---------------------------------------------------------------------------
// 1. The mechanism: same job, two ways of creating a child
// ---------------------------------------------------------------------------

/// A host that forks a detached child the way libuv does for the close digest:
/// `detached: true`, `stdio: 'ignore'`, `unref()` — the exact options
/// `digestSpawnArgs()` returns. It reports the pid on stderr so the test can
/// wait for the fork to have happened before it closes the job.
const FORKING_MOCK_HOST: &str = r#"
import { spawn } from 'node:child_process';
function fork(marker, delayMs) {
  const child = spawn(process.execPath, ['-e',
    `setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'in-job'), ${delayMs})`,
    marker], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return child.pid;
}
// The CONTROL writes at once, while the job is still open. It proves a child
// forked this way CAN write that marker, so the subject's silence later means
// the job killed it rather than that the fixture never worked.
fork("__CONTROL_MARKER__", 0);
process.stderr.write(`forked:${fork("__MARKER__", __DELAY_MS__)}\n`);
// What the launcher actually handed this host (R1), reported by the host itself
// rather than inferred from the Rust side that set it.
process.stderr.write(`flag:${process.env.ZER0_DIGEST_HANDOFF ?? '<unset>'}\n`);
const sessionId = 'mock-session';
function out(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
let buffered = '';
process.stdin.on('data', data => {
  buffered += data;
  for (;;) {
    const end = buffered.indexOf('\n'); if (end < 0) break;
    const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
    const request = JSON.parse(line);
    if (request.method === 'initialize') { out({jsonrpc:'2.0', id:request.id, result:{protocolVersion:1}}); continue; }
    if (request.method === 'session/new') {
      out({jsonrpc:'2.0', id:request.id, result:{sessionId}});
      setTimeout(() => out({jsonrpc:'2.0', method:'zer0/room/event', params:{
        protocol:'zer0.room', version:1, sessionId, eventSeq:'0', eventId:'ready', turnId:'turn-1',
        occurredAt:'2026-08-01T00:00:00Z', type:'session.saved', payload:{ready:true}}}), 20);
      continue;
    }
    if (request.method === 'zer0/room/resync') {
      // The client resyncs itself the moment readiness lands; an unshaped reply
      // is a fatal transport error, not a test detail.
      out({jsonrpc:'2.0', id:request.id, result:{events:[]}});
      continue;
    }
    if (request.method === 'zer0/room/shutdown') {
      // An UNOBEDIENT host answers nothing and does not die on stdin EOF, which
      // is what drives the shutdown past its response bound and its graceful
      // reap into the kill branch.
      if (__OBEDIENT__) { out({jsonrpc:'2.0', id:request.id, result:{ok:true}}); setTimeout(() => process.exit(0), 10); }
      continue;
    }
    out({jsonrpc:'2.0', id:request.id, result:{}});
  }
});
if (__OBEDIENT__) process.stdin.on('end', () => process.exit(0));
setInterval(() => {}, 1000);
"#;

#[cfg(windows)]
#[tokio::test]
async fn a_handed_off_child_outlives_the_job_that_kills_a_child_the_host_forked() {
    let root = tempfile::Builder::new()
        .prefix("zer0-f10-mechanism-")
        .tempdir()
        .unwrap();
    let node = node_exe();
    let control_marker = root.path().join("in-job-control.marker");
    let in_job_marker = root.path().join("in-job.marker");
    let handed_off_marker = root.path().join("handed-off.marker");
    let script = write_forking_host(root.path(), &control_marker, &in_job_marker);

    let host = HostProcess::spawn(
        HostProcessOptions::new(root.path()).with_test_launcher("node", &script),
    )
    .await
    .unwrap();
    let client = host.client();
    // The host's own fork must exist before the job closes, or the test proves
    // nothing about what a job close does to it.
    let forked_pid = await_forked_pid(&client).await;
    let host_forked_at = Instant::now();
    // The control, first: if a child the host forks cannot write a marker here
    // at all, nothing below this line means anything.
    await_marker(&control_marker, MARKER_BUDGET, || {
        "the host's IMMEDIATE fork never wrote its marker, so this fixture cannot say anything \
         about what the job close does to the delayed one. Fix the fixture before reading the \
         rest of this test."
            .to_owned()
    });
    initialize_and_open(&client).await;

    // The request the Node writer will produce once N1 lands. Written by hand
    // here so the mechanism is provable without it.
    write_request(
        root.path(),
        &marker_request(
            &node,
            root.path(),
            &handed_off_marker,
            FORK_DELAY.as_millis(),
        ),
    );

    host.shutdown().await.unwrap();
    // READ, not assumed: the job handle is the `Arc<ProcessGroup>` that
    // `spawn_monitor` holds (`host_process.rs`, `let _group = group;`), and it is
    // released as soon as the monitor reaps the host — so in practice the job
    // closes at host exit, and at the very latest here. Either way it is shut by
    // the time this line returns, which is all the assertions below need.
    drop(host);
    let job_closed_by = host_forked_at.elapsed();

    await_marker(&handed_off_marker, MARKER_BUDGET, || {
        format!(
            "the handed-off child never wrote its marker. Request file still on disk: {}. \
             Failure log: {}",
            request_file(root.path()).exists(),
            read_failure_log(root.path())
        )
    });
    // Ordering argument, so the negative below is not a race: the host's child
    // was created BEFORE the handed-off one and both sleep the same
    // `FORK_DELAY`, so by the time the handed-off marker exists the host's child
    // is already past its own deadline. Had it survived, its marker would be
    // there first.
    assert!(
        job_closed_by < FORK_DELAY,
        "the job was still open {job_closed_by:?} after the host forked, which is past the \
         {FORK_DELAY:?} the subject child sleeps — it could have written its marker before the \
         job ever closed, so this run proves nothing. Raise FORK_DELAY."
    );
    assert!(
        !in_job_marker.exists(),
        "the child the host forked ({forked_pid}) survived the job close — F10 is either fixed \
         upstream (libuv now breaks away, or the job no longer sets KILL_ON_JOB_CLOSE) or this \
         test no longer forks the way the digest does. Re-derive the finding before deleting it."
    );
}

/// The launcher takes a script and no arguments, so the fixture is templated
/// rather than parameterised. The marker paths are JSON-escaped: a Windows path
/// is full of backslashes and these land inside JS string literals.
fn write_forking_host(root: &Path, control_marker: &Path, subject_marker: &Path) -> PathBuf {
    write_mock_host(root, control_marker, subject_marker, true)
}

fn write_mock_host(
    root: &Path,
    control_marker: &Path,
    subject_marker: &Path,
    obedient: bool,
) -> PathBuf {
    let script = root.join("forking-host.mjs");
    fs::write(
        &script,
        FORKING_MOCK_HOST
            .replace("__DELAY_MS__", &FORK_DELAY.as_millis().to_string())
            .replace("__CONTROL_MARKER__", &js_string(control_marker))
            .replace("__MARKER__", &js_string(subject_marker))
            .replace("__OBEDIENT__", if obedient { "true" } else { "false" }),
    )
    .unwrap();
    script
}

/// One seam-shaped request whose child writes `marker` after `delay_ms`.
fn marker_request(node: &Path, root: &Path, marker: &Path, delay_ms: u128) -> Value {
    json!({
        "v": 1,
        "kind": "digest",
        "sessionId": "chat-mechanism",
        "projectId": "project-mechanism",
        "repoRoot": root,
        "dbPath": root.join(".zer0").join("evidence.db"),
        "execPath": node,
        "argv": [
            "-e",
            format!("setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'handed-off'), {delay_ms})"),
            marker,
        ],
        "cwd": root,
        "env": child_env(),
        "requestedAt": "2026-08-19T00:00:00.000Z",
    })
}

/// R3's second call site. A host that is dropped WITHOUT `shutdown()` — a
/// transport failure, a panic unwind, a caller that simply lets it go — must
/// still start what the host handed off, or the digest is lost exactly on the
/// paths where the operator most needs the session remembered.
#[tokio::test]
async fn a_host_dropped_without_shutdown_still_starts_the_handed_off_digest() {
    let root = tempfile::Builder::new()
        .prefix("zer0-f10-drop-")
        .tempdir()
        .unwrap();
    let node = node_exe();
    let marker = root.path().join("dropped.marker");
    let script = write_forking_host(
        root.path(),
        &root.path().join("drop-control.marker"),
        &root.path().join("drop-subject.marker"),
    );
    let host = HostProcess::spawn(
        HostProcessOptions::new(root.path()).with_test_launcher("node", &script),
    )
    .await
    .unwrap();
    write_request(root.path(), &marker_request(&node, root.path(), &marker, 0));

    drop(host); // no shutdown() at all

    await_marker(&marker, MARKER_BUDGET, || {
        format!(
            "Drop did not consume the handoff. Request file still on disk: {}. Failure log: {}",
            request_file(root.path()).exists(),
            read_failure_log(root.path())
        )
    });
}

/// R3's other branch. A host that answers no shutdown and does not die on stdin
/// EOF is reaped by `scope.kill_all()`, and the handoff must be consumed there
/// too: the host fsyncs its request before the close completes, so a host we had
/// to kill can still have left one. This is the path a wedged host takes, which
/// is exactly when losing the session's memory would hurt most.
#[tokio::test]
async fn a_host_that_has_to_be_killed_still_starts_the_handed_off_digest() {
    let root = tempfile::Builder::new()
        .prefix("zer0-f10-killed-")
        .tempdir()
        .unwrap();
    let node = node_exe();
    let marker = root.path().join("killed.marker");
    let script = write_mock_host(
        root.path(),
        &root.path().join("kill-control.marker"),
        &root.path().join("kill-subject.marker"),
        false,
    );
    let host = HostProcess::spawn(
        HostProcessOptions::new(root.path()).with_test_launcher("node", &script),
    )
    .await
    .unwrap();
    let client = host.client();
    initialize_and_open(&client).await;
    write_request(root.path(), &marker_request(&node, root.path(), &marker, 0));

    // Bounded by SHUTDOWN_TOTAL_BOUND (7 s): the acknowledgement bound elapses,
    // the graceful reap elapses, and only then does the kill branch run.
    //
    // A8: the ERROR, not merely an error — `is_err()` was satisfied equally well
    // by the ceiling firing on the launcher's own kill, which means the opposite
    // of what this fixture proves.
    //
    // The arithmetic moved in round 3 and the sentence in round 4. This host
    // answers nothing, so the acknowledgement bound elapses first — 250 ms now,
    // not 5 s — the reap then gets its full 6.2 s, the kill fires at about
    // 6.45 s, and the reap after the kill is handed what is left of the ceiling,
    // about 550 ms. What comes back is the TERMINATION's sentence rather than the
    // acknowledgement's `RequestTimedOut`, because a shutdown's timeout is part
    // of the shutdown protocol (round 4, item 2); a reap that ran out would say
    // "timed out waiting for host reaping" instead and would be real news.
    let outcome = host.shutdown().await;
    let Err(HostError::Stopped(reported)) = &outcome else {
        panic!(
            "this fixture only proves the kill branch if the graceful one could \
             not finish; shutdown returned {outcome:?}"
        );
    };
    assert!(
        reported.contains("no acknowledgement came back from it"),
        "and it proves the KILL was reaped inside the ceiling only if the report \
         is the termination rather than the reap running out: {reported}"
    );

    await_marker(&marker, MARKER_BUDGET, || {
        format!(
            "the kill branch did not consume the handoff. Request file still on disk: {}. \
             Failure log: {}",
            request_file(root.path()).exists(),
            read_failure_log(root.path())
        )
    });
}

/// R1: the launcher is what turns the handoff on, and the only way to launch a
/// host without it is the test-only opt-out the falsifier uses. Read back from
/// the host's own environment, not from the Rust side that set it — a flag this
/// binary believes it passed and the host never received is exactly how the
/// close digest would go missing with every test still green.
#[tokio::test]
async fn the_launcher_sets_the_handoff_flag_and_only_the_test_opt_out_removes_it() {
    assert_eq!(
        launched_with_flag(true).await,
        "1",
        "the production launcher must hand the host ZER0_DIGEST_HANDOFF=1, or the host forks its \
         close digest inside the job (F10)"
    );
    assert_eq!(
        launched_with_flag(false).await,
        "<unset>",
        "without_digest_handoff() must actually withhold the flag, or the F10 falsifier is \
         measuring the handoff path twice"
    );
}

async fn launched_with_flag(handoff: bool) -> String {
    let root = tempfile::Builder::new()
        .prefix("zer0-f10-flag-")
        .tempdir()
        .unwrap();
    let script = write_forking_host(
        root.path(),
        &root.path().join("flag-control.marker"),
        &root.path().join("flag-subject.marker"),
    );
    let mut options = HostProcessOptions::new(root.path()).with_test_launcher("node", &script);
    if !handoff {
        options = options.without_digest_handoff();
    }
    let host = HostProcess::spawn(options).await.unwrap();
    let flag = await_stderr_line(&host.client(), "flag:").await;
    let _ = host.shutdown().await;
    flag
}

// ---------------------------------------------------------------------------
// 2 + 3. End to end: the real compiled host, the real digest, the real DB
// ---------------------------------------------------------------------------

/// What one full room-open-submit-close cycle left behind.
#[derive(Debug)]
struct RoomRun {
    session_id: String,
    project: PathBuf,
    db_path: PathBuf,
    /// Kept alive for the whole assertion: dropping it deletes the DB.
    _root: tempfile::TempDir,
}

#[tokio::test]
async fn the_close_digest_survives_the_job_when_the_host_hands_it_off() {
    let run = room_open_submit_close(true).await;
    let observed = await_digest(&run, DIGEST_BUDGET);
    assert!(
        observed.is_some(),
        "no digest row for {} within {DIGEST_BUDGET:?} — the close digest did not survive the \
         job close.\n{}",
        run.session_id,
        diagnose(&run)
    );
    let rows = observed.unwrap();
    assert!(
        rows["journal"].as_i64().unwrap() > 0,
        "the watermark advanced but no journal entry was written: {rows}"
    );
}

#[cfg(windows)]
#[tokio::test]
async fn without_the_handoff_the_close_digest_does_not_survive_the_job() {
    let run = room_open_submit_close(false).await;
    // Non-vacuity: a run with nothing to digest would produce no rows whatever
    // the job did. The operator's own message is `status: "completed"`
    // (`src/chat/commands.ts` `createUserMessage`), so a submitted turn always
    // leaves the digest exactly one pending message.
    let counts = read_counts(&run).unwrap_or_else(|error| {
        panic!(
            "the falsifier could not read the memory DB, so it cannot claim anything about the \
             digest: {error}\n{}",
            diagnose(&run)
        )
    });
    assert!(
        counts["completed"].as_i64().unwrap() > 0,
        "this run left no completed message, so there was nothing for a digest to do and the \
         absence below would prove nothing: {counts}\n{}",
        diagnose(&run)
    );
    let observed = await_digest(&run, DIGEST_BUDGET);
    assert!(
        observed.is_none(),
        "the in-process close digest SURVIVED the job close ({observed:?}). Either the host no \
         longer forks it inside the job, or the job no longer kills on close — F10 has changed \
         shape and the handoff's survival test is no longer a proof. Re-measure with \
         .lead/tools/job-survival-probe.ps1 before trusting either test."
    );
}

/// Drives the REAL compiled host through one full cycle in a disposable git
/// project with the oracle's redirected HOME/APPDATA/LOCALAPPDATA/TEMP/
/// CODEX_HOME, then closes the room and lets the job go.
async fn room_open_submit_close(handoff: bool) -> RoomRun {
    let launcher = compiled_node_host();
    let root = tempfile::Builder::new()
        .prefix(if handoff {
            "zer0-f10-handoff-"
        } else {
            "zer0-f10-falsifier-"
        })
        .tempdir()
        .unwrap();
    let project = git_project(root.path());
    let mut options = HostProcessOptions::new(&project)
        .with_test_launcher(OsString::from("node"), &launcher)
        .with_test_env(hermetic_env(root.path()));
    if !handoff {
        options = options.without_digest_handoff();
    }
    let host = HostProcess::spawn(options).await.unwrap();
    let client = host.client();
    client
        .request(
            "initialize",
            json!({"protocolVersion":1,"clientInfo":{"name":"phase5c","version":"0"},"clientCapabilities":{}}),
            STEP,
        )
        .await
        .unwrap();
    let created = client
        .request(
            "session/new",
            json!({"cwd": project, "mcpServers": []}),
            STEP,
        )
        .await
        .unwrap();
    let session_id = created["sessionId"].as_str().unwrap().to_owned();
    client
        .request(
            "zer0/room/submit",
            json!({"sessionId": session_id, "text": "@all hello from the phase 5c survival test"}),
            STEP,
        )
        .await
        .unwrap();
    // The lanes are refused deterministically under ZER0_HERMETIC=1; the
    // operator's own message is already committed and completed, which is the
    // pending work the close digest exists to process.
    host.shutdown().await.unwrap();
    drop(host); // the job closes here — the whole point of the finding
    RoomRun {
        session_id,
        db_path: project.join(".zer0").join("evidence.db"),
        project,
        _root: root,
    }
}

/// Polls the memory DB until the session has a digest watermark row, or the
/// budget runs out. `Some(counts)` means the digest committed.
fn await_digest(run: &RoomRun, budget: Duration) -> Option<Value> {
    let started = Instant::now();
    loop {
        if let Ok(counts) = read_counts(run) {
            if counts["watermark"].as_i64().unwrap_or(0) > 0 {
                // Measured, never guessed: with `-- --nocapture` this prints the
                // real "job closed -> rows readable" latency that DIGEST_BUDGET
                // is sized against, so the budget stays re-derivable on any
                // machine instead of being a number someone has to trust.
                eprintln!(
                    "digest landed {} ms after the job closed (budget {budget:?})",
                    started.elapsed().as_millis()
                );
                return Some(counts);
            }
        }
        if started.elapsed() > budget {
            return None;
        }
        std::thread::sleep(POLL);
    }
}

/// The observable, read with the repo's own `better-sqlite3` exactly as the
/// oracle reads it. `watermark` is session-scoped (only the digest's atomic
/// commit writes it), `journal` is the facts it wrote, `completed` is the work
/// there was to do.
fn read_counts(run: &RoomRun) -> Result<Value, String> {
    const READER: &str = r#"
const path = require('node:path');
const [repo, dbPath, sid] = process.argv.slice(1);
const req = require('node:module').createRequire(path.join(repo, 'package.json'));
const db = new (req('better-sqlite3'))(dbPath, { readonly: true, fileMustExist: true });
try {
  process.stdout.write(JSON.stringify({
    watermark: db.prepare('select count(*) as n from digest_watermark where session_id = ?').get(sid).n,
    journal: db.prepare('select count(*) as n from journal_entries').get().n,
    completed: db.prepare("select count(*) as n from chat_messages where session_id = ? and status = 'completed'").get(sid).n,
  }));
} finally { db.close(); }
"#;
    let output = std::process::Command::new(node_exe())
        .arg("-e")
        .arg(READER)
        .arg(repo_root())
        .arg(&run.db_path)
        .arg(&run.session_id)
        .output()
        .map_err(|error| format!("could not run node: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "reading {} failed: {}",
            run.db_path.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    serde_json::from_slice(&output.stdout).map_err(|error| format!("unreadable counts: {error}"))
}

/// Everything a human needs to tell "the digest was killed" from "no digest was
/// ever asked for" — printed by every failing assertion above rather than left
/// for someone to reconstruct.
fn diagnose(run: &RoomRun) -> String {
    let journal = run.project.join(".zer0").join("journal");
    let requests = request_file(&run.project);
    let leases = run.project.join(".zer0").join("leases");
    format!(
        "  session: {}\n  db: {} (exists: {})\n  counts: {:?}\n  request file {} (exists: {}): {}\n  \
         journal dir: {}\n  failure log: {}\n  leases: {}\n  \
         NOTE, now that the write side is on master: the request file is ABSENT on a healthy \
         handoff run too, because the consumer deletes it after spawning — so read it together \
         with the counts. watermark=0 with an absent request file and a `room-close.log` in the \
         journal folder means the host closed without asking for a digest (check that the \
         launcher still sets ZER0_DIGEST_HANDOFF=1); watermark=0 with the request file still \
         PRESENT means the consumer never ran or could not spawn, and the failure log says which.",
        run.session_id,
        run.db_path.display(),
        run.db_path.exists(),
        read_counts(run),
        requests.display(),
        requests.exists(),
        fs::read_to_string(&requests).unwrap_or_else(|_| "<absent>".to_owned()),
        list_dir(&journal),
        read_failure_log(&run.project),
        list_dir(&leases),
    )
}

fn list_dir(dir: &Path) -> String {
    match fs::read_dir(dir) {
        Ok(entries) => {
            let names: Vec<String> = entries
                .filter_map(Result::ok)
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect();
            if names.is_empty() {
                "<empty>".to_owned()
            } else {
                names.join(", ")
            }
        }
        Err(_) => "<absent>".to_owned(),
    }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

fn repo_root() -> PathBuf {
    // m0irai layout: the Rust tree lives at <repo>/rust.
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("rust/crates/<crate> must live three levels below the repository root")
        .to_path_buf()
}

/// The compiled room host, built once per test binary. Two tests calling `npm
/// run build` at the same time would race each other writing `dist/`.
/// (Same resolution as `tests/host_lifecycle.rs::compiled_node_host`; duplicated
/// rather than shared so this file adds nothing to the test that is already
/// green.)
fn compiled_node_host() -> PathBuf {
    static BUILT: OnceLock<PathBuf> = OnceLock::new();
    BUILT
        .get_or_init(|| {
            let node_root = repo_root();
            let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };
            let status = std::process::Command::new(npm)
                .args(["run", "build"])
                .current_dir(&node_root)
                .status()
                .expect("Node package manager must be available for the survival test");
            assert!(status.success(), "Node room host build must succeed");
            let host = node_root
                .join("dist")
                .join("src")
                .join("room")
                .join("zer0-v2-host.js");
            assert!(host.is_file(), "compiled Node room host must be present");
            host
        })
        .clone()
}

fn node_exe() -> PathBuf {
    static NODE: OnceLock<PathBuf> = OnceLock::new();
    NODE.get_or_init(|| {
        let output = std::process::Command::new(if cfg!(windows) { "node.exe" } else { "node" })
            .args(["-e", "process.stdout.write(process.execPath)"])
            .output()
            .expect("node must be on PATH");
        PathBuf::from(String::from_utf8(output.stdout).expect("node path is utf-8"))
    })
    .clone()
}

/// A disposable project that is its own git top level — the host refuses a cwd
/// that is not one.
fn git_project(root: &Path) -> PathBuf {
    let project = root.join("project");
    fs::create_dir_all(&project).unwrap();
    let status = std::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(&project)
        .status()
        .unwrap();
    assert!(
        status.success(),
        "temp project must become a git repository"
    );
    // The host canonicalises its project root; handing it the canonical path up
    // front keeps `session/new`'s cwd check from tripping on a temp-dir junction.
    canonical_project_path(&project)
}

/// `std::fs::canonicalize` returns a `\\?\` verbatim path on Windows, which is
/// not what Node's `realpathSync` produces and not what the host compares
/// against. Strip the prefix.
fn canonical_project_path(path: &Path) -> PathBuf {
    let canonical = fs::canonicalize(path).unwrap();
    let text = canonical.to_string_lossy().into_owned();
    PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned())
}

/// The oracle's hermetic environment (`scripts/oracle-standalone.mjs`
/// `hermeticEnv`): the minimum a Node process needs, plus every root the room
/// would otherwise write into redirected under the temp dir, so a survival test
/// can never touch the operator's real config.
fn hermetic_env(root: &Path) -> Vec<(OsString, OsString)> {
    let dirs = [
        ("HOME", "home"),
        ("USERPROFILE", "home"),
        ("APPDATA", "appdata"),
        ("LOCALAPPDATA", "localappdata"),
        ("TEMP", "tmp"),
        ("TMP", "tmp"),
        ("CODEX_HOME", "codexhome"),
        ("ZER0_STATUSLINE_DIR", "statusline"),
    ];
    let mut env: Vec<(OsString, OsString)> = Vec::new();
    for key in [
        "PATH",
        "Path",
        "SystemRoot",
        "WINDIR",
        "ComSpec",
        "PATHEXT",
        "SYSTEMDRIVE",
        "SystemDrive",
        "PROGRAMFILES",
        "ProgramFiles",
        "NUMBER_OF_PROCESSORS",
        "OS",
    ] {
        if let Some(value) = std::env::var_os(key) {
            env.push((OsString::from(key), value));
        }
    }
    for (key, folder) in dirs {
        let dir = root.join(folder);
        fs::create_dir_all(&dir).unwrap();
        env.push((OsString::from(key), dir.into_os_string()));
    }
    env.push((OsString::from("ZER0_HERMETIC"), OsString::from("1")));
    env.push((OsString::from("ZER0_MEMORY"), OsString::from("1")));
    env.push((
        OsString::from("ZER0_DIGEST_FAKE"),
        OsString::from(DIGEST_FAKE),
    ));
    env
}

/// The child environment a hand-written request carries: enough for node to
/// start, one spelling of PATH only (Windows environment blocks are
/// case-insensitive, so asking for both yields one of them).
fn child_env() -> Value {
    let mut env = serde_json::Map::new();
    for key in ["PATH", "SystemRoot", "TEMP", "TMP"] {
        if let Ok(value) = std::env::var(key) {
            env.insert(key.to_owned(), Value::String(value));
        }
    }
    Value::Object(env)
}

/// A path as a JS string literal body (no quotes): `Value::to_string` on a
/// string does the escaping, then the surrounding quotes come off.
fn js_string(path: &Path) -> String {
    let quoted = Value::String(path.to_string_lossy().into_owned()).to_string();
    quoted[1..quoted.len() - 1].to_owned()
}

fn write_request(operator_root: &Path, line: &Value) {
    let file = request_file(operator_root);
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(&file, format!("{line}\n")).unwrap();
}

fn read_failure_log(operator_root: &Path) -> String {
    fs::read_to_string(zer0_v2_bin::digest_handoff::failure_log(operator_root))
        .unwrap_or_else(|_| "<no failure log>".to_owned())
}

async fn initialize_and_open(client: &HostClient) {
    client
        .request(
            "initialize",
            json!({"protocolVersion":1,"clientCapabilities":{}}),
            STEP,
        )
        .await
        .unwrap();
    client
        .request(
            "session/new",
            json!({"cwd":"ignored","mcpServers":[]}),
            STEP,
        )
        .await
        .unwrap();
    let mut readiness = client.subscribe_readiness();
    tokio::time::timeout(STEP, async {
        while readiness.borrow().is_none() {
            readiness.changed().await.unwrap();
        }
    })
    .await
    .expect("the mock host must report readiness");
}

async fn await_forked_pid(client: &HostClient) -> u32 {
    await_stderr_line(client, "forked:")
        .await
        .trim()
        .parse::<u32>()
        .expect("the mock host must report a numeric pid")
}

/// The mock host says what it saw on its own stderr; the test never infers it
/// from the Rust side that set it.
async fn await_stderr_line(client: &HostClient, prefix: &str) -> String {
    tokio::time::timeout(STEP, async {
        loop {
            if let Some(value) = client
                .stderr_tail()
                .await
                .lines()
                .find_map(|line| line.strip_prefix(prefix))
            {
                return value.trim().to_owned();
            }
            tokio::time::sleep(POLL).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("the mock host never reported a {prefix:?} line"))
}

fn await_marker(marker: &Path, budget: Duration, diagnosis: impl Fn() -> String) {
    let started = Instant::now();
    while !marker.exists() {
        assert!(
            started.elapsed() <= budget,
            "{} was never written within {budget:?}. {}",
            marker.display(),
            diagnosis()
        );
        std::thread::sleep(POLL);
    }
}
