#![cfg(feature = "test-support")]

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::json;
use tempfile::TempDir;
use tokio::sync::watch;
use tokio::time::{Instant, timeout};
use zer0_v2_bin::boot_progress::{BootProgress, ProgressWait};
use zer0_v2_bin::host_process::{
    HostClient, HostError, HostEvent, HostEventReceiveError, HostProcess, HostProcessOptions,
};
use zer0_v2_bin::host_shutdown::{
    HostExitCause, LauncherTermination, SHUTDOWN_TOTAL_BOUND, TerminationBranch,
    derived_minimum_graceful_reap,
};
use zer0_v2_bin::{
    cli::{CliMode, start_room},
    host_process::HostProcessOptions as StartupOptions,
};

/// How long this harness tolerates SILENCE from the mock host -- no stage report, no response, no
/// frame -- before it calls the host stalled.
///
/// The number the PRODUCT uses for the same question: `StartupBudget::default().inactivity`
/// (`boot_progress.rs`), derived there from measured stages on this box. The harness is deliberately
/// held to the product's own silence rule rather than to a private one.
///
/// This replaces a 4.5 s budget on the WHOLE of each round trip, and the replacement is a change of
/// kind rather than a bigger number. 3 s was wrong; 4.5 s was derived from twelve samples and was
/// wrong again one review later (the file came back 9/10 at ~100 % CPU, H-0 review 2026-09-12).
/// What both of those actually bounded was Node's own startup -- 1,175-1,977 ms of the measured
/// 1,343-2,162 ms handshake -- and no multiple of one box's measurement bounds that. So the mock host
/// now REPORTS, exactly as the real one does: it announces a stage before it can answer anything, and
/// every wait below is renewed by that evidence and gives up only on real silence.
const HOST_SILENCE: Duration = Duration::from_secs(20);

/// The absolute last-resort ceiling on any single wait in this file.
///
/// It exists so a WEDGED test fails the run instead of hanging it, and for nothing else. Deliberately
/// far outside every measurement rather than a small multiple of one: the slowest mock-host handshake
/// measured at 100 % CPU was 2,162 ms (H-0, 2026-09-07), the slowest real-host response-plus-exit
/// 174 + 3,094 ms, and the slowest whole-file run the reviewer recorded was 128 s for ten tests. A
/// minute is about 28x the first and 19x the second, and that ratio is the property that matters: no
/// working host can reach it and a hung one always does, so it never has to decide whether a slow host
/// is a healthy one. That decision is what `HOST_SILENCE` and the host's own reports are for.
const HARNESS_CEILING: Duration = Duration::from_secs(60);

/// The two bounds together, for the requests whose deadline the host's progress renews.
const fn progress_wait() -> ProgressWait {
    ProgressWait {
        inactivity: HOST_SILENCE,
        ceiling: HARNESS_CEILING,
    }
}

/// What a box held at 100 % CPU adds to a bounded wait before the waiting task runs again.
///
/// Sized from the H-0 measurement rather than picked: across twenty real shutdowns the response
/// frame, whose own work is a few milliseconds, arrived in 28-174 ms, so half a second is about
/// three times the worst scheduling delay seen on this hardware. Only the assertions that pin a
/// CEILING use it; no assertion that proves the fix is allowed to widen.
const LOADED_SCHEDULING_ALLOWANCE: Duration = Duration::from_millis(500);

const MOCK_HOST: &str = r#"
import { spawn } from 'node:child_process';

const mode = process.argv[2] ?? 'normal';
const sessionId = 'mock-session';
const now = '2026-08-01T00:00:00Z';
let initialized = false;
let history = [];
function out(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
function success(id, result) { out({jsonrpc:'2.0', id, result}); }
function notify(event) { out({jsonrpc:'2.0', method:'zer0/room/event', params:event}); }
function event(seq, id, type, payload) {
  return {protocol:'zer0.room',version:1,sessionId,eventSeq:String(seq),eventId:id,turnId:'turn-1',occurredAt:now,type,payload};
}
function queued(seq, id) {
  return event(seq, id, 'lane.queued', {laneId:`lane-${seq}`,agent:'codex',expectedMessageId:`message-${seq}`,origin:'operator',hopIndex:0});
}
function emit(event) { history.push(event); notify(event); }
// The evidence every wait in this file is renewed by, and the whole of A2's fix. Shape is fixed by
// `classify_boot_frame`: exactly {jsonrpc,method,params} and params of {stage,detail?}. These frames
// never reach the room transport -- the stdout reader classifies them out first.
function progress(stage) { out({jsonrpc:'2.0', method:'zer0/room/boot_progress', params:{stage}}); }
// FIRST thing the script does, before it can answer anything: "Node is up and this file is running".
// That is the 1,175-1,977 ms window two fixed budgets died inside, and it is now bounded by a report
// instead of by a clock. `stalled-handshake` reports a DIFFERENT stage and then answers nothing, so
// the failure it produces has to name that stage.
progress(mode === 'stalled-handshake' ? 'journal' : 'evidence');
if (mode === 'malformed') process.stdout.write('not-json\n');
if (mode === 'oversized') process.stdout.write('x'.repeat(1024 * 1024 + 1) + '\n');
if (mode === 'eof-exit7') { process.stdout.end(); setTimeout(() => process.exit(7), 50); }
if (mode === 'grandchild') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
  process.stderr.write(`grandchild:${child.pid}\n`);
}
let buffered = '';
process.stdin.on('data', data => {
  buffered += data;
  for (;;) {
    const end = buffered.indexOf('\n'); if (end < 0) break;
    const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
    const request = JSON.parse(line);
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') { process.exit(11); return; }
    // A host that is up, has reported a stage, and answers nothing at all.
    if (mode === 'stalled-handshake') continue;
    if (request.method === 'initialize') { progress('liveness'); initialized = true; success(request.id, {protocolVersion:1}); continue; }
    if (request.method === 'session/new') {
      if (!initialized) { out({jsonrpc:'2.0',id:request.id,error:{code:-32600,message:'initialize first'}}); continue; }
      progress('session');
      success(request.id, {sessionId});
      setTimeout(() => notify(event(0, 'ready', 'session.saved', {ready:true})), 20);
      continue;
    }
    if (request.method === 'zer0/room/resync') {
      const params = request.params;
      if (params?.sessionId !== sessionId || typeof params?.afterEventSeq !== 'string' || !/^(0|[1-9][0-9]*)$/.test(params.afterEventSeq)) {
        out({jsonrpc:'2.0',id:request.id,error:{code:-32602,message:'invalid resync frontier'}}); continue;
      }
      const after = BigInt(params.afterEventSeq);
      success(request.id, {events:history.filter(event => BigInt(event.eventSeq) > after)}); continue;
    }
    if (request.method === 'zer0/room/shutdown') {
      if (mode === 'no-shutdown') continue;
      // Answers nothing AND never goes -- `no-answer` is in OWNS_ITS_EXIT, so stdin EOF does not end it
      // either. `no-shutdown` is the same silence with a clean exit on EOF; the difference is the whole
      // of round 4's item 2, because only this one reaches the kill branch with nothing acknowledged.
      if (mode === 'no-answer') continue;
      if (mode === 'wedged-shutdown') { success(request.id, {ok:true}); continue; }
      // A close that FAILS after the acknowledgement. The real host reaches this by throwing out of
      // `lifecycle.detach` in `afterResponse`, which ends the process non-zero (codex measured exit 4
      // on a staged real host with an injected close failure). Once the response is out, the error can
      // no longer travel in it -- the exit code is the only carrier left -- so the launcher has to
      // render that exit rather than drop it.
      if (mode === 'failed-close') { success(request.id, {ok:true}); setTimeout(() => process.exit(4), 10); continue; }
      // Codex's counterexample shape, kept as a fixture: a host that answers only after the Node
      // room's whole 4 s close budget -- the shape the product itself produced before round 3 moved
      // the close behind the acknowledgement -- and then does not exit. What it proves is on the
      // LAUNCHER's side: a late answer must no longer be able to eat the reap's budget.
      if (mode === 'late-answer') { setTimeout(() => success(request.id, {ok:true}), 4100); continue; }
      // SLOW TO CLOSE, not slow to answer -- which is the shape the real host produces since round 3
      // moved the close behind the acknowledgement. It acknowledges at once and then takes 4,100 ms,
      // the Node room's whole documented close budget, to go. A launcher that waits this out is the
      // subject; a launcher that clamps its wait on the strength of the response would kill it, which
      // is exactly what the H-0 r2 cross-check caught.
      if (mode === 'slow-close') {
        success(request.id, {ok:true});
        setTimeout(() => process.exit(0), 4100);
        continue;
      }
      success(request.id, {ok:true}); setTimeout(() => process.exit(0), 10); continue;
    }
    // A host that ends ITSELF, cleanly, while the launcher is still holding it. Nothing in this
    // launcher has given up on it, so its exit is `HostExitCause::Host` with `success: true`.
    if (request.method === 'mock/exit') { success(request.id, {ok:true}); setTimeout(() => process.exit(0), 10); continue; }
    if (request.method === 'mock/flood') {
      emit(event(1, 'flood-accepted', 'turn.accepted', {
        agents:['codex'], text:'flood', messageId:'flood-operator', ledgerSeq:'1'
      }));
      emit(event(2, 'flood-route', 'route.resolved', {agents:['codex']}));
      for (let i = 3; i <= 98; i++) emit(event(i, `flood-${i}`, 'backend.failed', {}));
      success(request.id, {flooded:true}); continue;
    }
    success(request.id, {echo:request.params});
  }
});
// The launcher closes stdin the moment it has its acknowledgement, so this handler is what ends most
// of these hosts. The three modes below own their own exit and must not be short-circuited by it:
// `wedged-shutdown` never exits, `late-answer` never exits, and `slow-close` is the whole point of
// taking 4,100 ms to go.
const OWNS_ITS_EXIT = ['wedged-shutdown', 'late-answer', 'slow-close', 'no-answer', 'failed-close'];
process.stdin.on('end', () => { if (!OWNS_ITS_EXIT.includes(mode)) process.exit(0); });
setInterval(() => {}, 1000);
"#;

struct TestHost {
    host: HostProcess,
    _root: TempDir,
}

async fn host_with_mode(mode: &str) -> TestHost {
    let root = tempfile::Builder::new()
        .prefix(&format!("zer0-host-{mode}-"))
        .tempdir()
        .unwrap();
    let script = root.path().join("mock-host.mjs");
    fs::write(
        &script,
        MOCK_HOST.replace("process.argv[2] ?? 'normal'", &format!("'{mode}'")),
    )
    .unwrap();
    let options = HostProcessOptions::new(root.path()).with_test_launcher("node", script);
    TestHost {
        host: HostProcess::spawn(options).await.unwrap(),
        _root: root,
    }
}

/// The harness's wait on a RETAINED value, bounded by evidence rather than by a fixed budget.
///
/// It ends the moment `ready` yields a value. Otherwise the deadline is renewed every time the mock
/// host reports a stage, and it is given up only on real silence (`HOST_SILENCE`) or at
/// `HARNESS_CEILING` -- the same two-bound shape `HostInner::await_response_awaiting_progress` uses in
/// production, which is the point: this file's waits were the last fixed budgets left in the lane.
///
/// When it does give up it says what it was waiting for, which stage the host last reported, and what
/// the host wrote to stderr. `Elapsed(())` -- the message the old `timeout(WAIT, ..)` produced at
/// `:367` on the reviewer's run 7 -- names none of those three.
async fn await_retained<T, R>(
    client: &HostClient,
    waiting_for: &str,
    watch: &mut watch::Receiver<T>,
    mut ready: impl FnMut(&T) -> Option<R>,
) -> R {
    let mut progress = client.subscribe_boot_progress();
    // Start the silence clock from NOW rather than from a stage some earlier request left in the
    // channel: the question is whether THIS wait is making headway.
    drop(progress.borrow_and_update());
    let started = Instant::now();
    loop {
        if let Some(value) = ready(&watch.borrow_and_update()) {
            return value;
        }
        let elapsed = started.elapsed();
        let Some(ceiling_left) = HARNESS_CEILING.checked_sub(elapsed) else {
            panic!(
                "{}",
                stalled(client, waiting_for, elapsed, HARNESS_CEILING).await
            );
        };
        let slice = HOST_SILENCE.min(ceiling_left);
        tokio::select! {
            // Every sender lives in the `HostInner` this client holds through an `Arc`, so a closed
            // channel is unreachable while the wait is running. Asserted rather than ignored: a
            // silently-closed channel would turn this loop into the ceiling.
            changed = watch.changed() => changed.expect("the host's retained watch outlives its client"),
            _ = progress.changed() => {}
            () = tokio::time::sleep(slice) => {
                panic!("{}", stalled(client, waiting_for, started.elapsed(), slice).await);
            }
        }
    }
}

/// What the harness prints when it stops waiting: the three things needed to tell a slow host from a
/// dead one, none of which the old fixed budget reported.
async fn stalled(
    client: &HostClient,
    waiting_for: &str,
    waited: Duration,
    budget: Duration,
) -> String {
    let stage = client
        .boot_progress()
        .map_or_else(|| "nothing at all".to_owned(), |stage| stage.describe());
    format!(
        "the mock host went quiet while this harness waited for {waiting_for}: nothing for \
         {budget:?}, {waited:?} into the wait, last stage reported \"{stage}\". Host stderr tail: \
         {:?}",
        client.stderr_tail().await
    )
}

async fn initialize_and_open(client: &HostClient) -> String {
    // `request_awaiting_progress`, not `request`: this is the round trip that died at `:146` on the
    // reviewer's run 7 with `RequestTimedOut("zer0-request-1")`, a message that names an id and
    // nothing else. The production startup already answers this exact question by waiting on the
    // host's reports; the harness now uses the same call.
    let initialize = client
        .request_awaiting_progress(
            "initialize",
            json!({"protocolVersion":1,"clientCapabilities":{}}),
            progress_wait(),
            "the mock host's handshake",
        )
        .await
        .unwrap();
    assert_eq!(initialize, json!({"protocolVersion":1}));
    let created = client
        .request_awaiting_progress(
            "session/new",
            json!({"cwd":"ignored","mcpServers":[]}),
            progress_wait(),
            "opening the mock host's session",
        )
        .await
        .unwrap();
    created["sessionId"].as_str().unwrap().to_owned()
}

async fn wait_ready(client: &HostClient) -> String {
    let mut readiness = client.subscribe_readiness();
    await_retained(client, "the readiness event", &mut readiness, |event| {
        event.as_ref().map(|event| event.session_id.clone())
    })
    .await
}

/// A3's other half: a host that ended cleanly on its own must not be reported to the operator as a
/// failure, and its exit must say so in words.
///
/// `cli::run_room` calls `host.shutdown()` unconditionally after the room loop returns and then does
/// `shutdown?`. Against an already-exited host the whole sequence used to run into a closed writer,
/// `send_value` answered `AdmissionClosed`, and the operator got exit code 4 and "host is not
/// accepting requests" for a room that ended perfectly normally. The new `RoomUpdate::HostExited`
/// variant is the room's half of that; this is the launcher's.
#[tokio::test]
async fn a_host_that_ended_itself_cleanly_is_not_a_shutdown_failure() {
    let test = host_with_mode("normal").await;
    let client = test.host.client();
    initialize_and_open(&client).await;
    wait_ready(&client).await;
    client
        .request("mock/exit", json!({}), HOST_SILENCE)
        .await
        .unwrap();

    let exit = client.wait_for_exit(HARNESS_CEILING).await.unwrap();
    assert_eq!(exit.cause, HostExitCause::Host, "{exit}");
    assert!(exit.success, "{exit}");
    // The sentence the room puts on screen and `cli` prints, and the one the pager's own banner test
    // renders whole.
    assert_eq!(exit.to_string(), "the room host exited normally (code 0)");

    assert_eq!(
        test.host.shutdown().await,
        Ok(()),
        "shutting down a host that has already ended cleanly is a no-op, not a failed request"
    );
}

/// A2's falsifier, kept as a test rather than run once: a host that is UP, has reported a stage and
/// then answers nothing must fail this harness by NAMING the stage it stopped in.
///
/// The two failures the reviewer's run 7 produced were `RequestTimedOut("zer0-request-1")` and
/// `Elapsed(())`. Neither says whether the host was alive, what it was doing, or which bound ran out,
/// which is how 9/10 read as "flaky test" rather than "the budget is wrong" -- twice.
///
/// The budgets here are deliberately tiny and deliberately local. The subject is the MESSAGE, not the
/// bound: this host is stalled by construction, so waiting out the file's real 20 s of silence would
/// prove nothing and cost the suite 20 s. The stage report is awaited first, on the real evidence
/// wait, so the stage in the message is the one the host reported rather than the fallback.
#[tokio::test]
async fn a_stalled_handshake_names_the_stage_the_host_stopped_in() {
    let test = host_with_mode("stalled-handshake").await;
    let client = test.host.client();
    let mut progress = client.subscribe_boot_progress();
    let stage = await_retained(
        &client,
        "the mock host's first stage report",
        &mut progress,
        |stage| stage.as_ref().map(BootProgress::describe),
    )
    .await;
    assert_eq!(stage, "replaying the room journal");

    let error = client
        .request_awaiting_progress(
            "initialize",
            json!({"protocolVersion":1,"clientCapabilities":{}}),
            ProgressWait {
                inactivity: Duration::from_millis(300),
                ceiling: Duration::from_secs(5),
            },
            "the mock host's handshake",
        )
        .await
        .expect_err("a host that answers nothing must not look like a completed handshake");
    let HostError::StartupStalled(message) = &error else {
        panic!("a stalled handshake must be reported as a stall, got {error:?}");
    };
    assert!(
        message.contains("replaying the room journal"),
        "the failure has to name the stage the host stopped in, not a request id: {message}"
    );
    assert!(
        !message.contains("zer0-request"),
        "a request id is not a diagnosis: {message}"
    );
}

#[tokio::test]
async fn room_view_is_retained_only_after_the_initial_resync_is_live() {
    let test = host_with_mode("normal").await;
    let client = test.host.client();
    let session_id = initialize_and_open(&client).await;
    assert!(!client.room_view().session_id().is_some());

    wait_ready(&client).await;
    client.wait_until_live(HARNESS_CEILING).await.unwrap();
    let retained = client.room_view();
    assert_eq!(retained.session_id(), Some(session_id.as_str()));
    let late_subscriber = client.subscribe_room_view();
    assert!(*late_subscriber.borrow() > 0);
    assert_eq!(client.room_view().session_id(), Some(session_id.as_str()));
    test.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn silence_initialize_response_before_readiness_and_retained_watch() {
    let test = host_with_mode("normal").await;
    let client = test.host.client();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(client.subscribe_readiness().borrow().is_none());

    let session_id = initialize_and_open(&client).await;
    // `session/new` has resolved but the notification is intentionally delayed.
    let retained = client.subscribe_readiness();
    assert!(retained.borrow().is_none());
    assert_eq!(wait_ready(&client).await, session_id);
    test.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn bounded_broadcast_reports_lag_and_resync_recovers_order_without_deadlock() {
    let test = host_with_mode("normal").await;
    let client = test.host.client();
    let mut events = client.subscribe_events();
    initialize_and_open(&client).await;
    loop {
        if matches!(events.recv().await.unwrap(), HostEvent::Readiness(_)) {
            break;
        }
    }
    // Both bounds here are last-resort, and neither is a liveness judgement: by this line the host
    // has answered two requests and emitted readiness, so it is proven up. The subject is that stdout
    // does not wait for a presentation consumer, and the outer wait is what catches that deadlock.
    let flood = timeout(
        HARNESS_CEILING,
        client.request("mock/flood", json!({}), HOST_SILENCE),
    )
    .await
    .expect("stdout must not wait for presentation")
    .unwrap();
    assert_eq!(flood, json!({"flooded":true}));
    let frontier = match events.recv().await {
        Err(HostEventReceiveError::Lagged {
            last_delivered_event_seq: Some(frontier),
        }) => frontier,
        other => panic!("expected explicit lag from readiness frontier, got {other:?}"),
    };
    assert_eq!(frontier, "0");
    let replay = client.resync(&frontier, HARNESS_CEILING).await.unwrap();
    assert_eq!(replay.len(), 98);
    assert_eq!(replay.first().unwrap().event_seq, "1");
    assert_eq!(replay.last().unwrap().event_seq, "98");
    let tail = client.resync("97", HARNESS_CEILING).await.unwrap();
    assert_eq!(tail.len(), 1);
    assert_eq!(tail[0].event_seq, "98");
    assert!(matches!(
        client.resync("01", HARNESS_CEILING).await,
        Err(HostError::InvalidArgument(_))
    ));
    test.host.shutdown().await.unwrap();
}

/// A close that FAILS after the acknowledgement reaches the operator as the EXIT, because by then the
/// response has gone and cannot carry an error.
///
/// The hole the acknowledge-first protocol would otherwise have opened, and the reason
/// `classify_shutdown_exit` has a `HostFailed` arm at all. Codex measured the real host on this path —
/// an injected close failure ends it with exit 4 — and this binds what the launcher then says about it.
#[tokio::test]
async fn a_close_that_fails_after_the_acknowledgement_is_reported_as_the_exit() {
    let test = host_with_mode("failed-close").await;
    let client = test.host.client();
    initialize_and_open(&client).await;
    wait_ready(&client).await;

    let outcome = test.host.shutdown().await;
    let Err(HostError::Stopped(reported)) = &outcome else {
        panic!(
            "a host that exited 4 during its own close must not be reported as a clean quit: {outcome:?}"
        );
    };
    assert_eq!(
        reported, "the room host exited on its own with code 4",
        "the exit is the host's OWN, so the sentence must not blame the launcher"
    );
    let exit = client.wait_for_exit(HARNESS_CEILING).await.unwrap();
    assert_eq!(exit.cause, HostExitCause::Host, "{exit}");
    assert!(!exit.success, "{exit}");
}

/// Round 4, item 2: a host that NEVER ANSWERS is killed inside the ceiling, and what `shutdown()`
/// reports is the termination rather than the acknowledgement's timeout.
///
/// The packaged counterpart of this is in `conpty_ui`
/// (`a_host_that_never_answers_is_killed_and_the_operator_is_told_so`), where the same host produced
/// `m0irai: host request timed out: zer0-shutdown-6` on the release-dist binary — a request id, on the
/// one path where the launcher had in fact terminated the operator's host. This test binds the contract
/// that makes that impossible, and the budget it runs inside:
///
/// `SHUTDOWN_RESPONSE_BOUND` (250 ms) elapses with nothing back, then the reap gets its whole
/// `SHUTDOWN_GRACEFUL_REAP_BOUND` (6.2 s) because the clamp has only 250 ms to take away, then the kill
/// is reaped inside `KILL_REAP_RESERVE` (500 ms). 250 + 6,200 + 500 = 6,950 ms, under the 7 s ceiling
/// with 50 ms to spare — asserted below rather than asserted about.
///
/// MEASURED on this path, 2026-09-13, rather than only derived: the clamp handed the reap its full
/// 6,200 ms, the reap waited 6,206.3 ms of it (`Instant::elapsed`, so 6.3 ms of scheduling on top of
/// the bound), and the whole quit — request out, acknowledgement bound spent, reap, kill, reaped exit
/// observed — took 6,476.6 ms against the 7,000 ms ceiling. The kill's own reap cost about 20 ms of
/// the 500 ms held back for it.
#[tokio::test]
async fn a_host_that_never_answers_is_killed_and_the_report_is_the_termination() {
    let test = host_with_mode("no-answer").await;
    let client = test.host.client();
    initialize_and_open(&client).await;
    wait_ready(&client).await;

    let started = Instant::now();
    let outcome = test.host.shutdown().await;
    let elapsed = started.elapsed();

    let Err(HostError::Stopped(reported)) = &outcome else {
        panic!(
            "a host that answered nothing and was killed must report the kill, not the request; got \
             {outcome:?}"
        );
    };
    assert!(
        reported.contains("m0irai ended the room host after waiting "),
        "the report names who ended it and how long it waited: {reported}"
    );
    assert!(
        reported.contains("no acknowledgement came back from it"),
        "and says nothing came back, because nothing did: {reported}"
    );
    assert!(
        !reported.contains("zer0-shutdown"),
        "a request id is not a diagnosis; that is the sentence FL-143 hid behind: {reported}"
    );

    let exit = client.wait_for_exit(HARNESS_CEILING).await.unwrap();
    assert_eq!(
        exit.cause,
        HostExitCause::LauncherTerminated(LauncherTermination {
            branch: TerminationBranch::ShutdownReap {
                acknowledged: false
            },
            waited: exit_wait(&exit),
        }),
        "the exit itself carries the same fact the report does: {exit}"
    );
    // The budget, measured rather than described: the whole quit fits under the ceiling, and the reap
    // kept its full derivation because a 250 ms acknowledgement bound is all the clamp can subtract.
    assert!(
        elapsed <= SHUTDOWN_TOTAL_BOUND + LOADED_SCHEDULING_ALLOWANCE,
        "the ceiling still bounds a host that answers nothing; the quit took {elapsed:?}"
    );
    let HostExitCause::LauncherTerminated(termination) = exit.cause else {
        unreachable!("asserted above");
    };
    assert!(
        termination.waited >= derived_minimum_graceful_reap(),
        "and the reap kept its whole derivation: waited {:?} of {:?}",
        termination.waited,
        derived_minimum_graceful_reap()
    );
}

/// The `waited` the launcher recorded, so an assertion can compare the rest of the cause without
/// pinning a real elapsed measurement to a literal.
fn exit_wait(exit: &zer0_v2_bin::host_shutdown::HostExit) -> Duration {
    match exit.cause {
        HostExitCause::LauncherTerminated(termination) => termination.waited,
        HostExitCause::Host => Duration::ZERO,
    }
}

/// Item 1's behavioural guarantee: a host that answers LATE can no longer take the reap's budget
/// away from itself.
///
/// This is codex's counterexample, on this lane's own mock. Before round 3 the launcher waited up to
/// five seconds for the answer and then clamped its wait for the EXIT to whatever was left of the
/// ceiling, so an answer at 4,100 ms left 2,400 ms — less than the 3,094 ms slowest exit ever measured
/// from the real host, which is the exact invariant FL-143 broke. The launcher now stops waiting for
/// an acknowledgement at 250 ms, so the elapsed time it clamps against is bounded by a number small
/// enough that the reap always keeps its whole derivation.
///
/// Deliberately asserted on `waited` rather than on survival. A host that needs longer than the
/// derived reap is one the launcher is SUPPOSED to give up on; what it may not do is give up sooner
/// than the slowest exit it has ever seen.
#[tokio::test]
async fn a_late_answer_cannot_take_the_reaps_budget_away_from_the_host() {
    let test = host_with_mode("late-answer").await;
    let client = test.host.client();
    initialize_and_open(&client).await;
    wait_ready(&client).await;

    let started = Instant::now();
    // The acknowledgement never arrives inside its bound, and what comes back is the KILL, in the
    // launcher's own words. Round 3 handed back the acknowledgement's `RequestTimedOut` here, and
    // `cli::run_room` propagates that before it can report the termination — so the operator read
    // "host request timed out: zer0-shutdown-N" about a host m0irai had killed (codex r3, reviewer CX-2).
    let outcome = test.host.shutdown().await;
    let Err(HostError::Stopped(reported)) = &outcome else {
        panic!(
            "a kill after silence is reported as the launcher stopping the host, got {outcome:?}"
        );
    };
    assert!(
        reported.contains("no acknowledgement came back from it"),
        "and the sentence is the exit's own, not a request id: {reported}"
    );
    let elapsed = started.elapsed();
    let exit = client.wait_for_exit(HARNESS_CEILING).await.unwrap();

    let HostExitCause::LauncherTerminated(termination) = exit.cause else {
        panic!("this host never exits, so the launcher must have ended it: {exit}");
    };
    // CX3 on a real path: nothing came back inside the bound, and the sentence says exactly that
    // rather than claiming the host answered.
    assert_eq!(
        termination.branch,
        TerminationBranch::ShutdownReap {
            acknowledged: false
        },
        "no acknowledgement arrived, so the sentence must not say one did: {exit}"
    );
    let slowest_measured_exit = derived_minimum_graceful_reap() / 2;
    assert!(
        termination.waited >= slowest_measured_exit,
        "the launcher gave up after {:?}, sooner than the host's slowest measured exit \
         ({slowest_measured_exit:?}); a late answer has taken the reap's budget again",
        termination.waited
    );
    // And the stronger form: not merely above the slowest exit, but the whole derived wait.
    assert!(
        termination.waited >= derived_minimum_graceful_reap(),
        "the launcher waited {:?} of its derived {:?}; the clamp is biting again",
        termination.waited,
        derived_minimum_graceful_reap()
    );
    assert!(
        elapsed <= SHUTDOWN_TOTAL_BOUND + LOADED_SCHEDULING_ALLOWANCE,
        "and the ceiling still bounds the operator's quit; shutdown took {elapsed:?}"
    );
}

#[tokio::test]
async fn clients_do_not_own_the_child_but_owner_drop_reaps_it() {
    let test = host_with_mode("normal").await;
    let client = test.host.client();
    let dropped_client = client.clone();
    drop(dropped_client);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(client.subscribe_exit().borrow().is_none());
    drop(test.host);
    let exit = client.wait_for_exit(HARNESS_CEILING).await.unwrap();
    assert!(!exit.success);
    assert_eq!(
        exit.cause,
        HostExitCause::LauncherTerminated(LauncherTermination {
            branch: TerminationBranch::OwnerDropped,
            waited: Duration::ZERO,
        }),
        "a kill on the owner's drop is the launcher's doing, not the host's: {exit}"
    );
}

/// FL-143's branch, on demand: a host that answers the shutdown and then refuses to exit is still
/// killed -- the forced path is unchanged -- and the exit names the launcher, the branch and the
/// wait. `code` and `success` alone are indistinguishable from a host that crashed, which is exactly
/// what let this read as a host defect for three weeks.
#[tokio::test]
async fn a_host_that_answers_the_shutdown_and_never_exits_is_terminated_and_the_exit_says_so() {
    let test = host_with_mode("wedged-shutdown").await;
    let client = test.host.client();
    initialize_and_open(&client).await;
    wait_ready(&client).await;

    let started = Instant::now();
    // Ok, not Err: the kill worked and was reaped inside the ceiling. The reserve is what keeps this
    // from becoming `Stopped("timed out waiting for host reaping")` once the graceful wait grew.
    test.host.shutdown().await.unwrap();
    let elapsed = started.elapsed();
    let exit = client.wait_for_exit(HARNESS_CEILING).await.unwrap();

    // The only two fields FL-143 had to work from.
    assert!(!exit.success, "a terminated host is not a success: {exit}");
    #[cfg(windows)]
    assert_eq!(
        exit.code,
        Some(1),
        "TerminateJobObject's exit code, not the host's: {exit}"
    );

    let HostExitCause::LauncherTerminated(termination) = exit.cause else {
        panic!("the launcher ended this host and the exit must say so, got: {exit}");
    };
    // `acknowledged: true` is part of the assertion, not incidental: this mock DOES answer the
    // shutdown and then refuses to exit, so a sentence saying otherwise would be the CX3 defect.
    assert_eq!(
        termination.branch,
        TerminationBranch::ShutdownReap { acknowledged: true }
    );
    // The invariant FL-143 broke: never give up on a host sooner than the slowest exit ever measured
    // from it. The exact bound and its 2x margin are pinned separately, in `host_shutdown`'s tests.
    let slowest_measured_exit = derived_minimum_graceful_reap() / 2;
    assert!(
        termination.waited >= slowest_measured_exit,
        "the launcher gave up after {:?}, sooner than the host's slowest measured exit ({slowest_measured_exit:?}); that is the FL-143 defect",
        termination.waited
    );
    // And the ceiling still fires: a wedged host does not hold the quit open.
    assert!(
        elapsed <= SHUTDOWN_TOTAL_BOUND + LOADED_SCHEDULING_ALLOWANCE,
        "the total bound must still bound a host that never exits; shutdown took {elapsed:?}"
    );
}

#[tokio::test]
async fn normal_forced_and_pre_readiness_shutdowns_are_bounded_and_reaped() {
    let pre_room = host_with_mode("normal").await;
    let started = Instant::now();
    pre_room.host.shutdown().await.unwrap();
    assert!(started.elapsed() <= Duration::from_secs(7));
    assert!(
        pre_room
            .host
            .wait_for_exit(HARNESS_CEILING)
            .await
            .unwrap()
            .success
    );

    let normal = host_with_mode("normal").await;
    let normal_client = normal.host.client();
    initialize_and_open(&normal_client).await;
    wait_ready(&normal_client).await;
    let started = Instant::now();
    normal.host.shutdown().await.unwrap();
    assert!(started.elapsed() <= Duration::from_secs(7));
    assert!(
        normal
            .host
            .wait_for_exit(HARNESS_CEILING)
            .await
            .unwrap()
            .success
    );

    // A host that acknowledges NOTHING and then exits cleanly on stdin EOF. Round 3 changed what this
    // leg pins, and the change is the point: the EXIT is the evidence that the close finished, so a
    // missing acknowledgement is not a failed quit. It used to assert `Err(RequestTimedOut)`, which
    // meant an operator whose host was slow to answer got exit code 4 on a quit that worked — A3's
    // defect pointing the other way, and measurable now that the ack bound is 250 ms rather than 5 s.
    // What a host that never answers AND never exits gets is in
    // `a_late_answer_cannot_take_the_reaps_budget_away_from_the_host`: a kill, a timeout, and a
    // sentence that says no acknowledgement came back.
    let forced = host_with_mode("no-shutdown").await;
    let forced_client = forced.host.client();
    initialize_and_open(&forced_client).await;
    wait_ready(&forced_client).await;
    let started = Instant::now();
    assert_eq!(
        forced.host.shutdown().await,
        Ok(()),
        "a host that never acknowledged but exited cleanly has closed; that is a successful quit"
    );
    assert!(started.elapsed() <= Duration::from_secs(7));
    assert!(
        forced
            .host
            .wait_for_exit(HARNESS_CEILING)
            .await
            .unwrap()
            .success
    );

    // The leg that the H-0 r2 cross-check turned into a live defect: a host that takes the Node
    // room's whole 4 s close budget to go. It is waited out and NOT killed, and `shutdown()` reports
    // the success it observed rather than a kill. Before round 3 this same host answered late instead
    // of closing late, and the launcher clamped its reap on the strength of that late answer.
    let slow = host_with_mode("slow-close").await;
    let slow_client = slow.host.client();
    initialize_and_open(&slow_client).await;
    wait_ready(&slow_client).await;
    let started = Instant::now();
    slow.host.shutdown().await.unwrap();
    assert!(started.elapsed() >= Duration::from_secs(4));
    assert!(started.elapsed() <= Duration::from_secs(7));
    assert!(
        slow.host
            .wait_for_exit(HARNESS_CEILING)
            .await
            .unwrap()
            .success
    );
}

#[tokio::test]
async fn malformed_and_oversized_stdout_record_failure_and_reap() {
    for mode in ["malformed", "oversized"] {
        let test = host_with_mode(mode).await;
        let client = test.host.client();
        // The second wait that died on the reviewer's run 7 (`:367`, `Elapsed(())`). The mock writes
        // its invalid line as its first act after the stage report, so what this was really waiting
        // out was Node's startup -- renewed by the report now, and no longer by a clock.
        let mut failure = client.subscribe_transport_failure();
        let retained_failure = await_retained(
            &client,
            "the retained transport failure invalid stdout must become",
            &mut failure,
            |failure| failure.clone(),
        )
        .await;
        assert!(matches!(retained_failure, HostError::Frame(_)));
        assert!(client.wait_for_exit(HARNESS_CEILING).await.is_ok());
    }
}

#[tokio::test]
async fn stdout_eof_is_a_transport_failure_but_monitor_retains_exit_seven() {
    let test = host_with_mode("eof-exit7").await;
    let client = test.host.client();
    let mut failure = client.subscribe_transport_failure();
    let retained_failure = await_retained(
        &client,
        "the retained transport failure a stdout EOF must become",
        &mut failure,
        |failure| failure.clone(),
    )
    .await;
    assert!(matches!(retained_failure, HostError::Stopped(_)));
    assert_eq!(
        client.wait_for_exit(HARNESS_CEILING).await.unwrap().code,
        Some(7)
    );
}

#[cfg(windows)]
#[tokio::test]
async fn owner_drop_kills_a_windows_grandchild_tree() {
    let test = host_with_mode("grandchild").await;
    let client = test.host.client();
    let pid = timeout(HARNESS_CEILING, async {
        loop {
            let tail = client.stderr_tail().await;
            if let Some(pid) = tail
                .lines()
                .find_map(|line| line.strip_prefix("grandchild:"))
                .and_then(|value| value.parse::<u32>().ok())
            {
                return pid;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    drop(test.host);
    client.wait_for_exit(HARNESS_CEILING).await.unwrap();
    let gone = timeout(HARNESS_CEILING, async {
        loop {
            let output = std::process::Command::new("tasklist")
                .args(["/FI", &format!("PID eq {pid}"), "/NH"])
                .output()
                .unwrap();
            if !String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await;
    assert!(gone.is_ok(), "grandchild PID {pid} survived owner drop");
}

#[tokio::test]
async fn actual_node_public_startup_helper_creates_and_continues_the_same_live_room() {
    let launcher = compiled_node_host();
    let operator = tempfile::tempdir().unwrap();
    let git = std::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(operator.path())
        .status()
        .unwrap();
    assert!(
        git.success(),
        "temp operator root must become a Git repository"
    );
    let cwd = operator.path().to_path_buf();
    let created = start_room(
        CliMode::New,
        &cwd,
        StartupOptions::new(&cwd).with_test_launcher(OsString::from("node"), &launcher),
    )
    .await
    .unwrap();
    let created_id = created.session_id.clone();
    let client = created.host.client();
    assert_eq!(client.room_view().session_id(), Some(created_id.as_str()));
    assert!(client.resync("0", Duration::from_secs(15)).await.is_ok());
    created.host.shutdown().await.unwrap();
    let exit = client.wait_for_exit(Duration::from_secs(5)).await.unwrap();
    // FL-143: `success` alone cannot tell a clean quit from a launcher kill, because
    // TerminateJobObject hands out code 1 with an empty stderr either way. The cause is what proves
    // the launcher waited for this host instead of killing it part-way through its own exit.
    assert_eq!(exit.cause, HostExitCause::Host, "{exit}");
    assert!(exit.success, "{exit}");

    let continued = start_room(
        CliMode::Continue,
        &cwd,
        StartupOptions::new(&cwd).with_test_launcher(OsString::from("node"), &launcher),
    )
    .await
    .unwrap();
    assert_eq!(continued.session_id, created_id);
    let client = continued.host.client();
    assert_eq!(client.room_view().session_id(), Some(created_id.as_str()));
    assert!(client.resync("0", Duration::from_secs(15)).await.is_ok());
    continued.host.shutdown().await.unwrap();
    let exit = client.wait_for_exit(Duration::from_secs(5)).await.unwrap();
    assert_eq!(exit.cause, HostExitCause::Host, "{exit}");
    assert!(exit.success, "{exit}");
}

fn source_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .unwrap()
        .to_path_buf()
}

fn compiled_node_host() -> PathBuf {
    // m0irai layout: the Rust tree lives at <repo>/rust and the Node host is the repo root itself.
    let node_root = source_root()
        .parent()
        .expect("rust/ must live directly below the m0irai repository root")
        .to_path_buf();
    let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };
    let status = std::process::Command::new(npm)
        .args(["run", "build"])
        .current_dir(&node_root)
        .status()
        .expect("Node package manager must be available for the public host test");
    assert!(
        status.success(),
        "Node room host production build must succeed"
    );
    let host = node_root
        .join("dist")
        .join("src")
        .join("room")
        .join("zer0-v2-host.js");
    assert!(host.is_file(), "compiled Node room host must be present");
    host
}
