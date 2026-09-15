//! Consumer unit tests (Phase 5c R4a).
//!
//! Every test drives the real `consume_digest_requests` against a hand-written
//! request line and a real child process — the seam is a file and a spawn, and a
//! mocked spawn would prove neither.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::{DigestHandoffOutcome, consume_digest_requests, failure_log, request_file};

/// Budget for "consumer returned -> the handed-off child's marker is readable".
///
/// MEASURED 2026-08-19 on this machine (Windows 11, Node v24.18.0) by printing
/// `started.elapsed()` from `await_marker` over 10 runs of this module = 50
/// awaited markers: min 0.6 ms, median 83.5 ms, max 113.2 ms. (Reproduce: add
/// the eprintln back and run `cargo test -p zer0-v2-bin --lib digest_handoff --
/// --nocapture` ten times.) 2 s is ~17x the measured max.
///
/// It is a DIAGNOSIS TRIGGER, not a pass condition: a marker that has not
/// landed in two seconds is not slow, it is absent, and the assertion prints the
/// failure log to say why.
const MARKER_BUDGET: Duration = Duration::from_secs(2);
const POLL: Duration = Duration::from_millis(10);

/// Absolute node path, exactly as the seam requires (`execPath` is Node's own
/// `process.execPath`). Resolving it here rather than relying on a bare "node"
/// keeps the test honest about what the consumer is handed.
fn node_exe() -> PathBuf {
    let output = Command::new(if cfg!(windows) { "node.exe" } else { "node" })
        .args(["-e", "process.stdout.write(process.execPath)"])
        .output()
        .expect("node must be on PATH for the digest handoff tests");
    assert!(
        output.status.success(),
        "node -e failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let path = PathBuf::from(String::from_utf8(output.stdout).expect("node path is utf-8"));
    assert!(path.is_absolute(), "process.execPath must be absolute");
    path
}

/// The child every test spawns: record cwd + the full env key set + argv tail
/// into the marker file, so one child proves the whole spawn contract.
const RECORDER: &str = "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({\
cwd: process.cwd(), envKeys: Object.keys(process.env).sort(), \
env: process.env, argvTail: process.argv.slice(2)}))";

fn request_line(node: &Path, marker: &Path, cwd: &Path, env: Value, session: &str) -> String {
    json!({
        "v": 1,
        "kind": "digest",
        "sessionId": session,
        "projectId": "proj-1",
        "repoRoot": cwd.to_string_lossy(),
        "dbPath": cwd.join(".zer0").join("evidence.db").to_string_lossy(),
        "execPath": node.to_string_lossy(),
        "argv": [
            "-e",
            RECORDER,
            marker.to_string_lossy(),
            "tail-arg",
        ],
        "cwd": cwd.to_string_lossy(),
        "env": env,
        "requestedAt": "2026-08-18T00:00:00.000Z",
    })
    .to_string()
}

/// A minimal but realistic child environment: what the seam actually carries is
/// `childEnv()`'s allowlist, and node needs at least these on Windows.
///
/// One spelling of PATH only. Windows environment blocks are case-insensitive,
/// so asking for both `PATH` and `Path` yields a child with one of them and the
/// exactness assertion below fails on the loser (measured: `Path` came back
/// `None`), which says nothing about the consumer.
fn child_env() -> Value {
    let mut env = serde_json::Map::new();
    for key in ["PATH", "SystemRoot", "TEMP", "TMP"] {
        if let Ok(value) = std::env::var(key) {
            env.insert(key.to_owned(), Value::String(value));
        }
    }
    env.insert(
        "ZER0_DIGEST_FAKE".to_owned(),
        Value::String("{\"facts\":[]}".to_owned()),
    );
    Value::Object(env)
}

fn write_requests(root: &Path, lines: &[String]) {
    let file = request_file(root);
    std::fs::create_dir_all(file.parent().expect("request file has a parent")).unwrap();
    std::fs::write(&file, format!("{}\n", lines.join("\n"))).unwrap();
}

fn await_marker(marker: &Path) -> Value {
    let started = Instant::now();
    loop {
        if let Ok(body) = std::fs::read_to_string(marker) {
            if let Ok(value) = serde_json::from_str::<Value>(&body) {
                return value;
            }
        }
        assert!(
            started.elapsed() <= MARKER_BUDGET,
            "the handed-off child never wrote {} within {MARKER_BUDGET:?}. \
             Failure log: {:?}",
            marker.display(),
            read_failure_log(marker.parent().unwrap())
        );
        std::thread::sleep(POLL);
    }
}

fn read_failure_log(root: &Path) -> String {
    std::fs::read_to_string(failure_log(root)).unwrap_or_else(|_| "<no failure log>".to_owned())
}

fn temp_root(label: &str) -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix(&format!("zer0-digest-handoff-{label}-"))
        .tempdir()
        .unwrap()
}

#[test]
fn every_request_is_spawned_and_the_file_is_removed_afterwards() {
    let root = temp_root("spawn");
    let node = node_exe();
    let first = root.path().join("first.json");
    let second = root.path().join("second.json");
    write_requests(
        root.path(),
        &[
            request_line(&node, &first, root.path(), child_env(), "chat-1"),
            request_line(&node, &second, root.path(), child_env(), "chat-2"),
        ],
    );

    let outcome = consume_digest_requests(root.path());

    assert_eq!(
        outcome,
        DigestHandoffOutcome {
            spawned: 2,
            malformed: 0,
            failed: 0
        }
    );
    // The children were created by the consumer, not waited on: they are only
    // observable through what they leave on disk.
    await_marker(&first);
    await_marker(&second);
    assert!(
        !request_file(root.path()).exists(),
        "consumed requests must not be left on disk to be spawned again next run"
    );
    assert_eq!(read_failure_log(root.path()), "<no failure log>");
}

#[test]
fn the_child_runs_with_exactly_the_request_env_and_cwd_and_argv() {
    let root = temp_root("env");
    let node = node_exe();
    let marker = root.path().join("env.json");
    let workdir = root.path().join("workdir");
    std::fs::create_dir_all(&workdir).unwrap();
    let env = child_env();
    write_requests(
        root.path(),
        &[request_line(
            &node,
            &marker,
            &workdir,
            env.clone(),
            "chat-env",
        )],
    );
    // Present in THIS process's environment and absent from the request: proves
    // the consumer cleared its own environment rather than merging into it.
    // SAFETY: single-threaded section of this test; the value is only read back
    // through the child's env snapshot, never by another thread here.
    unsafe { std::env::set_var("ZER0_HANDOFF_PARENT_ONLY", "must-not-reach-the-child") };

    let outcome = consume_digest_requests(root.path());
    assert_eq!(outcome.spawned, 1);
    let seen = await_marker(&marker);

    let expected = env.as_object().unwrap();
    for (key, value) in expected {
        assert_eq!(
            seen["env"].get(key),
            Some(value),
            "child env key {key} differs from the request"
        );
    }
    let extra: Vec<String> = seen["envKeys"]
        .as_array()
        .unwrap()
        .iter()
        .map(|key| key.as_str().unwrap().to_owned())
        // Windows' loader injects per-drive "=C:" current-directory pseudo-variables
        // into every child; they are not inheritable state and cannot be suppressed.
        .filter(|key| !key.starts_with('=') && !expected.contains_key(key))
        .collect();
    assert!(
        extra.is_empty(),
        "child environment carried keys the request did not ask for: {extra:?}"
    );
    assert_eq!(
        Path::new(seen["cwd"].as_str().unwrap())
            .canonicalize()
            .unwrap(),
        workdir.canonicalize().unwrap(),
        "the child must run in the request's cwd"
    );
    assert_eq!(seen["argvTail"], json!(["tail-arg"]));
}

#[test]
fn a_malformed_line_is_skipped_and_recorded_without_stopping_the_valid_one() {
    let root = temp_root("malformed");
    let node = node_exe();
    let marker = root.path().join("valid.json");
    write_requests(
        root.path(),
        &[
            "{not json at all".to_owned(),
            json!({"v": 2, "kind": "digest", "sessionId": "chat-skew", "projectId": "p",
                   "repoRoot": "r", "dbPath": "d", "execPath": "node", "argv": ["-e", ""],
                   "cwd": ".", "env": {}, "requestedAt": "2026-08-18T00:00:00.000Z"})
            .to_string(),
            json!({"v": 1, "kind": "digest", "sessionId": "chat-noargv", "projectId": "p",
                   "repoRoot": "r", "dbPath": "d", "execPath": "node", "argv": [],
                   "cwd": ".", "env": {}, "requestedAt": "2026-08-18T00:00:00.000Z"})
            .to_string(),
            request_line(&node, &marker, root.path(), child_env(), "chat-good"),
        ],
    );

    let outcome = consume_digest_requests(root.path());

    assert_eq!(
        outcome,
        DigestHandoffOutcome {
            spawned: 1,
            malformed: 3,
            failed: 0
        }
    );
    await_marker(&marker);
    let log = read_failure_log(root.path());
    assert!(log.contains("[digest-catastrophe]"), "log was: {log}");
    assert!(
        log.contains("session=- "),
        "unnamed session line missing: {log}"
    );
    assert!(
        log.contains("session=chat-skew"),
        "skew line missing: {log}"
    );
    assert!(
        log.contains("session=chat-noargv"),
        "argv line missing: {log}"
    );
    assert!(log.contains("not JSON"), "cause missing: {log}");
    assert!(log.contains("v1"), "version cause missing: {log}");
    assert!(log.contains("argv is empty"), "argv cause missing: {log}");
    assert!(
        !request_file(root.path()).exists(),
        "a malformed line must not make the file un-consumable"
    );
}

#[test]
fn a_request_that_cannot_spawn_is_recorded_and_the_file_is_still_consumed() {
    let root = temp_root("unspawnable");
    let missing = root.path().join("no-such-node.exe");
    write_requests(
        root.path(),
        &[request_line(
            &missing,
            &root.path().join("never.json"),
            root.path(),
            child_env(),
            "chat-missing",
        )],
    );

    let outcome = consume_digest_requests(root.path());

    assert_eq!(
        outcome,
        DigestHandoffOutcome {
            spawned: 0,
            malformed: 0,
            failed: 1
        }
    );
    let log = read_failure_log(root.path());
    assert!(
        log.contains("session=chat-missing [digest-catastrophe] parent handoff spawn failed:"),
        "the seam's failure line shape is not what was written: {log}"
    );
    assert!(
        !request_file(root.path()).exists(),
        "an unspawnable request must not be retried forever"
    );
}

/// The seam calls every key required. This line is otherwise spawnable — a real
/// interpreter, a non-empty argv, an existing cwd — so a consumer that skipped
/// the envelope check would happily start a child from a request it did not
/// fully understand.
#[test]
fn a_request_missing_a_seam_field_is_recorded_rather_than_half_understood() {
    let root = temp_root("incomplete");
    let node = node_exe();
    write_requests(
        root.path(),
        &[
            json!({"v": 1, "kind": "digest", "sessionId": "chat-nostamp", "projectId": "p",
                 "repoRoot": "r", "dbPath": "d", "execPath": node.to_string_lossy(),
                 "argv": ["-e", ""], "cwd": root.path().to_string_lossy(), "env": {}})
            .to_string(),
        ],
    );

    let outcome = consume_digest_requests(root.path());

    assert_eq!(outcome.malformed, 1, "{outcome:?}");
    assert_eq!(outcome.spawned, 0, "{outcome:?}");
    let log = read_failure_log(root.path());
    assert!(log.contains("session=chat-nostamp"), "{log}");
    assert!(
        log.contains("requestedAt is missing"),
        "the record must name the field that was missing: {log}"
    );
}

#[test]
fn a_request_whose_cwd_is_gone_is_recorded_rather_than_started_blind() {
    let root = temp_root("nocwd");
    let node = node_exe();
    write_requests(
        root.path(),
        &[request_line(
            &node,
            &root.path().join("never.json"),
            &root.path().join("deleted-project"),
            child_env(),
            "chat-nocwd",
        )],
    );

    let outcome = consume_digest_requests(root.path());

    assert_eq!(outcome.failed, 1);
    assert_eq!(outcome.spawned, 0);
    assert!(
        read_failure_log(root.path()).contains("working directory"),
        "the record must name the missing directory: {}",
        read_failure_log(root.path())
    );
}

#[test]
fn no_request_file_is_a_no_op_and_stays_one_on_a_second_pass() {
    let root = temp_root("noop");

    let first = consume_digest_requests(root.path());
    let second = consume_digest_requests(root.path());

    assert!(first.is_empty(), "{first:?}");
    assert!(second.is_empty(), "{second:?}");
    assert!(
        !failure_log(root.path()).exists(),
        "a no-op records nothing"
    );
}

#[test]
fn a_consumed_file_is_not_spawned_a_second_time() {
    let root = temp_root("once");
    let node = node_exe();
    let marker = root.path().join("once.json");
    write_requests(
        root.path(),
        &[request_line(
            &node,
            &marker,
            root.path(),
            child_env(),
            "chat-once",
        )],
    );

    assert_eq!(consume_digest_requests(root.path()).spawned, 1);
    await_marker(&marker);
    let second = consume_digest_requests(root.path());

    assert!(
        second.is_empty(),
        "the second pass must find nothing: {second:?}"
    );
}
