//! Unit proofs for boot progress: the frame classifier, the wording, the budget, and the two
//! process-level behaviours the lane exists for — progress renews the wait, silence still ends it.
//!
//! These live in the crate's own `#[cfg(test)]` tree rather than in `tests/`, and that is a decision
//! rather than a convenience: `verify:rust` runs `cargo test --workspace` on DEFAULT features and then
//! two named `--test` targets under `test-support`. An integration file here would need `test-support`
//! to reach `with_test_launcher`, would therefore compile to zero tests in the workspace step, and
//! would never run in the gate at all — a test that guards nothing while looking like it does.

use std::fs;
use std::time::Duration;

use super::*;
use crate::cli::{CliMode, start_room_with_budget};
use crate::host_process::{HostError, HostProcessOptions};

/// A host that answers `session/new` only after `STAGES_MS` of reporting, then goes quiet or not,
/// depending on the mode. `__PROGRESS__` decides whether stages are reported at all — which is the
/// difference between "slow but alive" and "hung".
const STAGED_HOST: &str = r#"
const REPORT = __PROGRESS__;
const STEPS = __STEPS__;
const STEP_MS = __STEP_MS__;
const ANSWER = __ANSWER__;
const READY = __READY__;
const sessionId = 'chat-boot-progress';
const now = '2026-09-06T00:00:00Z';
const stages = ['evidence', 'liveness', 'migrate', 'session', 'journal'];
function out(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
function success(id, result) { out({jsonrpc:'2.0', id, result}); }
function progress(stage, detail) {
  const params = detail === undefined ? {stage} : {stage, detail};
  out({jsonrpc:'2.0', method:'zer0/room/boot_progress', params});
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function slowSessionNew(id) {
  for (let step = 0; step < STEPS; step += 1) {
    await sleep(STEP_MS);
    if (REPORT) {
      const stage = stages[step % stages.length];
      progress(stage, stage === 'migrate' ? '14 -> 14,15,16,20,21' : undefined);
    }
  }
  if (!ANSWER) { await sleep(3600000); return; }
  success(id, {sessionId});
  // READY=false is the I1 case: the request is answered, so the terminal moves on to the LAST wait,
  // and then readiness never arrives.
  if (!READY) { await sleep(3600000); return; }
  await sleep(20);
  out({jsonrpc:'2.0', method:'zer0/room/event', params:{
    protocol:'zer0.room',version:1,sessionId,eventSeq:'0',eventId:'ready',turnId:'turn-1',
    occurredAt:now,type:'session.saved',payload:{ready:true}}});
}
let buffered = '';
process.stdin.on('data', data => {
  buffered += data;
  for (;;) {
    const end = buffered.indexOf('\n'); if (end < 0) break;
    const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
    const request = JSON.parse(line);
    if (request.method === 'initialize') {
      success(request.id, {protocolVersion:1, _meta:{'zer0.room':{version:1}}});
      continue;
    }
    if (request.method === 'session/new') { void slowSessionNew(request.id); continue; }
    if (request.method === 'zer0/room/resync') { success(request.id, {events:[]}); continue; }
    if (request.method === 'zer0/room/shutdown') {
      success(request.id, {ok:true}); setTimeout(() => process.exit(0), 10); continue;
    }
    success(request.id, {});
  }
});
process.stdin.on('end', () => process.exit(0));
setInterval(() => {}, 1000);
"#;

struct StagedHost {
    root: tempfile::TempDir,
    script: std::path::PathBuf,
}

fn staged_host(report: bool, steps: u32, step_ms: u64, answer: bool) -> StagedHost {
    staged_host_with_readiness(report, steps, step_ms, answer, true)
}

fn staged_host_with_readiness(
    report: bool,
    steps: u32,
    step_ms: u64,
    answer: bool,
    ready: bool,
) -> StagedHost {
    let root = tempfile::tempdir().unwrap();
    let script = root.path().join("staged-host.mjs");
    let body = STAGED_HOST
        .replace("__PROGRESS__", if report { "true" } else { "false" })
        .replace("__STEPS__", &steps.to_string())
        .replace("__STEP_MS__", &step_ms.to_string())
        .replace("__ANSWER__", if answer { "true" } else { "false" })
        .replace("__READY__", if ready { "true" } else { "false" });
    fs::write(&script, body).unwrap();
    StagedHost { root, script }
}

impl StagedHost {
    fn options(&self) -> HostProcessOptions {
        HostProcessOptions::new(self.root.path()).with_test_launcher("node", &self.script)
    }

    fn cwd(&self) -> std::path::PathBuf {
        self.root.path().to_path_buf()
    }
}

/// The longest a spawn plus an `initialize` round trip was MEASURED to take on this machine, and the
/// number [`TEST_BUDGET`]'s handshake bound is derived from.
///
/// 52 samples at 100 % CPU with the rest of the wave resident, spawning the PATH interpreter on a mock
/// host and reading its first response: min 398.9 ms, median ~950 ms, max 1,639.5 ms. A lighter window
/// at 57 % CPU over 12 samples ran 85.5 / 180 / 556.4 ms, which is the same shape an order of magnitude
/// down. The harness is `scratchpad/measure-handshake.mjs`; the method is FL-175's.
const MEASURED_HANDSHAKE_MAX: Duration = Duration::from_millis(1_640);

/// The longest gap MEASURED between two reports from an already-running host: a 150 ms timer inside a
/// spawned Node, 80 samples at 100 % CPU, min 156.5 ms, max 283.3 ms.
///
/// This is a different measurement from the one above and that is the whole point. Once the host is
/// running there is no interpreter to start, so the two costs differ by roughly six times, and round 2
/// bounded both with one 700 ms number — below even the loaded MEDIAN of the first. That is why four
/// process-level tests were a coin flip, six red in sixteen runs: `initialize` timed out on the
/// handshake before any of them reached its subject.
const MEASURED_REPORT_GAP_MAX: Duration = Duration::from_millis(284);

/// The budget the process-level tests run under, derived from the two measurements above.
///
/// `handshake` 5 s is 3.0× the loaded maximum; `inactivity` 2 s is 7.1× the loaded maximum report gap.
/// Both clear the brief's "at least twice the loaded max" with room for a box slower than the one this
/// was measured on. The ceiling is well above handshake plus the longest scripted run.
///
/// `the_test_budget_still_clears_what_was_measured` fails if any of these drops back under its
/// derivation, so the numbers cannot be quietly tightened again.
const TEST_BUDGET: StartupBudget = StartupBudget {
    handshake: Duration::from_secs(5),
    inactivity: Duration::from_secs(2),
    ceiling: Duration::from_secs(30),
};

/// The step the scripted host reports on. Chosen so a run of them outlasts the inactivity budget while
/// each individual gap stays far under it — 150 ms measured at most 283.3 ms under load, against a
/// 2 s bound.
const TEST_STEP_MS: u64 = 150;

/// THE DERIVATION, pinned. A budget that came from a measurement stops being one the moment somebody
/// edits the constant, so the relationship is asserted rather than described.
#[test]
fn the_test_budget_still_clears_what_was_measured() {
    assert!(
        TEST_BUDGET.handshake >= MEASURED_HANDSHAKE_MAX * 2,
        "handshake budget {:?} is under 2x the measured {:?}",
        TEST_BUDGET.handshake,
        MEASURED_HANDSHAKE_MAX
    );
    assert!(
        TEST_BUDGET.inactivity >= MEASURED_REPORT_GAP_MAX * 2,
        "inactivity budget {:?} is under 2x the measured {:?}",
        TEST_BUDGET.inactivity,
        MEASURED_REPORT_GAP_MAX
    );
    // The scripted run has to outlast the inactivity budget or the progress-renewal test proves
    // nothing, and it has to fit inside the ceiling with the handshake.
    let scripted = Duration::from_millis(TEST_STEP_MS * REPORTING_STEPS);
    assert!(
        scripted > TEST_BUDGET.inactivity,
        "a scripted run of {scripted:?} no longer outlasts the inactivity budget {:?}",
        TEST_BUDGET.inactivity
    );
    assert!(
        TEST_BUDGET.ceiling > TEST_BUDGET.handshake + scripted,
        "the ceiling must leave room for the handshake plus the scripted run"
    );
    assert!(
        Duration::from_millis(TEST_STEP_MS) * 2 < TEST_BUDGET.inactivity,
        "one report gap must stay well inside the inactivity budget"
    );
}

/// How many reports the progress-renewal test scripts. Times [`TEST_STEP_MS`] this must exceed the
/// inactivity budget, which is what makes that test a proof rather than a formality.
const REPORTING_STEPS: u64 = 20;

/// THE LANE'S REASON. The host takes far longer than the inactivity budget in total, and boots anyway,
/// because it keeps saying what it is doing. Under the fixed budget this replaces, a startup that
/// outran one deadline died no matter how alive the host was.
#[tokio::test]
async fn a_host_that_keeps_reporting_keeps_its_terminal_past_the_inactivity_budget() {
    let host = staged_host(true, REPORTING_STEPS as u32, TEST_STEP_MS, true);
    let started = tokio::time::Instant::now();
    let room = start_room_with_budget(CliMode::New, &host.cwd(), host.options(), TEST_BUDGET)
        .await
        .expect("a host that reports progress must not be killed for taking its time");
    // The proof is not the elapsed number, it is that the wait survived a total far past its own
    // inactivity bound. Asserted as an ordering against the budget, never as a timing expectation.
    assert!(
        started.elapsed() > TEST_BUDGET.inactivity,
        "the fake host must actually outlast one inactivity budget for this to prove anything"
    );
    assert_eq!(room.session_id, "chat-boot-progress");
    room.host.shutdown().await.unwrap();
}

/// The deadline is still a deadline. A host that reports NOTHING dies at the inactivity budget, and
/// the message names the stage it died in rather than a request id.
#[tokio::test]
async fn a_silent_host_still_times_out_and_the_message_names_what_it_was_waiting_for() {
    let host = staged_host(false, 1, 600_000, false);
    let error = start_room_with_budget(CliMode::New, &host.cwd(), host.options(), TEST_BUDGET)
        .await
        .err()
        .expect("silence for a whole inactivity budget must end the startup");
    let HostError::StartupStalled(message) = error else {
        panic!("a stalled startup must be reported as a stall, got {error:?}");
    };
    assert!(
        message.contains("opening a new room"),
        "the stall must name the stage, got: {message}"
    );
    assert!(
        message.contains("What to do: relaunch m0irai"),
        "the stall must say what to do, got: {message}"
    );
    assert!(
        !message.contains("zer0-request"),
        "a request id is what the operator was given last time and could do nothing with: {message}"
    );
}

/// Progress arrives and THEN stops. The stall names the last stage the host reported, with its detail,
/// which is the whole point of carrying one.
#[tokio::test]
async fn a_host_that_stops_reporting_is_named_by_the_stage_it_stopped_in() {
    let host = staged_host(true, 3, TEST_STEP_MS, false);
    let error = start_room_with_budget(CliMode::New, &host.cwd(), host.options(), TEST_BUDGET)
        .await
        .err()
        .expect("progress that stops must still end the startup");
    let HostError::StartupStalled(message) = error else {
        panic!("a stalled startup must be reported as a stall, got {error:?}");
    };
    assert!(
        message.contains("migrating the evidence ledger (14 -> 14,15,16,20,21)"),
        "the stall must name the last stage AND its detail, got: {message}"
    );
}

/// I1: the LAST startup wait. The host answers `session/new` and then never publishes readiness, so
/// the terminal sits in `wait_until_live` — the one step the first round left on the old sentence
/// shape, `host request timed out: room initial resync`, with no stage, no budget and no advice.
#[tokio::test]
async fn readiness_that_never_arrives_is_a_named_stall_like_every_other_step() {
    let host = staged_host_with_readiness(true, 2, TEST_STEP_MS, true, false);
    let error = start_room_with_budget(CliMode::New, &host.cwd(), host.options(), TEST_BUDGET)
        .await
        .err()
        .expect("readiness that never arrives must end the startup");
    let HostError::StartupStalled(message) = error else {
        panic!("the last wait must stall like every other step, got {error:?}");
    };
    assert!(
        message.contains("the room's first sync"),
        "the stall must name the stage, got: {message}"
    );
    assert!(
        message.contains("What to do: relaunch m0irai"),
        "the stall must carry the advice line, got: {message}"
    );
    assert!(
        !message.contains("host request timed out"),
        "the old sentence shape is exactly what this lane deletes: {message}"
    );
}

#[test]
fn a_room_event_is_not_boot_progress_and_never_pays_for_a_parse() {
    let event =
        br#"{"jsonrpc":"2.0","method":"zer0/room/event","params":{"type":"turn.accepted"}}"#;
    assert_eq!(classify_boot_frame(event), BootFrame::RoomFrame);
    assert_eq!(
        classify_boot_frame(br#"{"jsonrpc":"2.0","id":"zer0-request-2","result":{}}"#),
        BootFrame::RoomFrame
    );
    assert_eq!(
        classify_boot_frame(b"not json at all"),
        BootFrame::RoomFrame
    );
}

#[test]
fn a_valid_stage_decodes_with_and_without_a_detail() {
    let bare = classify_boot_frame(
        br#"{"jsonrpc":"2.0","method":"zer0/room/boot_progress","params":{"stage":"liveness"}}"#,
    );
    let BootFrame::Progress(progress) = bare else {
        panic!("a valid stage must decode as progress, got {bare:?}");
    };
    assert_eq!(progress.stage(), "liveness");
    assert_eq!(progress.describe(), "claiming the project lock");

    let detailed = classify_boot_frame(
        br#"{"jsonrpc":"2.0","method":"zer0/room/boot_progress","params":{"stage":"migrate","detail":"14 -> 21"}}"#,
    );
    let BootFrame::Progress(progress) = detailed else {
        panic!("a valid stage must decode as progress, got {detailed:?}");
    };
    assert_eq!(
        progress.describe(),
        "migrating the evidence ledger (14 -> 21)"
    );
}

/// Forward compatibility, deliberately: a stage this terminal has never heard of still counts as
/// progress and is shown verbatim. A newer host must be able to add a stage without a terminal release
/// — the alternative is a startup that dies BECAUSE the host explained itself too well.
#[test]
fn an_unknown_stage_is_still_progress_and_is_shown_as_itself() {
    let frame = classify_boot_frame(
        br#"{"jsonrpc":"2.0","method":"zer0/room/boot_progress","params":{"stage":"warming-caches"}}"#,
    );
    let BootFrame::Progress(progress) = frame else {
        panic!("an unknown stage must still be progress, got {frame:?}");
    };
    assert_eq!(progress.describe(), "warming-caches");
}

#[test]
fn a_frame_claiming_to_be_progress_and_failing_the_shape_is_fatal() {
    let rejected: [&[u8]; 6] = [
        br#"{"jsonrpc":"2.0","method":"zer0/room/boot_progress","params":{},"id":"1"}"#,
        br#"{"jsonrpc":"1.0","method":"zer0/room/boot_progress","params":{"stage":"evidence"}}"#,
        br#"{"jsonrpc":"2.0","method":"zer0/room/boot_progress","params":"evidence"}"#,
        br#"{"jsonrpc":"2.0","method":"zer0/room/boot_progress","params":{"stage":""}}"#,
        br#"{"jsonrpc":"2.0","method":"zer0/room/boot_progress","params":{"stage":"evidence","extra":1}}"#,
        br#"{"jsonrpc":"2.0","method":"zer0/room/boot_progress","params":{"stage":"evidence","detail":7}}"#,
    ];
    for frame in rejected {
        assert!(
            matches!(classify_boot_frame(frame), BootFrame::Malformed(_)),
            "must be fatal: {}",
            String::from_utf8_lossy(frame)
        );
    }
}

/// A stage or detail carrying an escape sequence would be printed straight onto the operator's
/// cooked-mode terminal, where the terminal would EXECUTE it rather than show it.
#[test]
fn a_stage_carrying_a_control_sequence_is_refused_rather_than_printed() {
    // Built through the serializer, which is the only way a real one could arrive: a producer that
    // formats an escape sequence into a detail emits it JSON-ENCODED, and a raw control byte would
    // fail the JSON parse first and never reach the shape check this is about.
    let escaped = serde_json::to_vec(&serde_json::json!({
        "jsonrpc": "2.0",
        "method": BOOT_PROGRESS_METHOD,
        "params": {"stage": "evidence", "detail": format!("{}[2J", char::from(0x1b_u8))},
    }))
    .unwrap();
    assert!(matches!(
        classify_boot_frame(&escaped),
        BootFrame::Malformed(_)
    ));
    let long = format!(
        r#"{{"jsonrpc":"2.0","method":"zer0/room/boot_progress","params":{{"stage":"evidence","detail":"{}"}}}}"#,
        "x".repeat(81)
    );
    assert!(matches!(
        classify_boot_frame(long.as_bytes()),
        BootFrame::Malformed(_)
    ));
}

#[test]
fn the_shipped_budget_is_the_measured_one_and_the_stall_says_which_bound_it_hit() {
    let budget = StartupBudget::default();
    assert_eq!(budget.inactivity, Duration::from_secs(20));
    assert_eq!(budget.ceiling, Duration::from_secs(120));
    assert!(budget.ceiling > budget.inactivity);

    // The two quantities are DIFFERENT here on purpose: 70 s of elapsed time against a 20 s silence
    // budget is the review's I5 case, where round 1 printed "within 70s" and a reader would take 70 s
    // for the rule. Both numbers appear, each labelled by its position in the sentence.
    let silent = stall_message(
        "opening the session",
        StallKind::Silent,
        Duration::from_secs(70),
        budget.inactivity,
    );
    assert_eq!(
        silent,
        "the room host stopped reporting during \"opening the session\": nothing for 20s, 70s into startup"
    );
    let ceiling = stall_message(
        "opening the session",
        StallKind::Ceiling,
        budget.ceiling,
        budget.ceiling,
    );
    assert_eq!(
        ceiling,
        "the room host was still working on \"opening the session\" after 120s, and startup waits at most 120s"
    );
}
