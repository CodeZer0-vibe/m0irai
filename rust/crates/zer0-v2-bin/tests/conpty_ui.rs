#![cfg(windows)]

//! Real Windows ConPTY proof for the public executable.  This intentionally
//! does not use `PtySession`: the test retains direct child ownership so a
//! failure can clean up only the processes it created.

use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use ptyctl::{
    pty::{PtyChild, PtyConfig, PtyHandle, PtyMaster},
    term::{ScreenOpts, SessionListener, Terminal},
};
use windows::Win32::{
    Foundation::{CloseHandle, WAIT_OBJECT_0},
    System::Threading::{
        OpenProcess, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, TerminateProcess, WaitForSingleObject,
    },
};

// Two budgets, because the waits in this test are two different things and a
// single constant for both was the m0irai Phase 4 flake (F5). Neither is a
// product latency contract -- this is a ConPTY correctness proof, not a
// performance test -- so both are harness budgets derived from measurement.
// Re-derive with `ZER0_CONPTY_TIMING=1 cargo test -p zer0-v2-bin --test conpty_ui
// -- --nocapture`, which prints every satisfied wait with its call-site line.
//
// BOOT covers everything before the first frame: PowerShell spawn, 49 filler
// lines, the debug-profile m0irai binary starting, it spawning the Node host,
// the four-round-trip JSON-RPC handshake, and the first render. Measured on a
// 12-core Windows box, 14 runs:
//   idle                                  2.93 - 3.56 s
//   with a concurrent `CARGO_BUILD_JOBS=8 cargo build`   3.93 - 8.24 s
// Worst observed 8.24 s x 2.4 = 20 s. The old shared 8 s sat *inside* that
// loaded range, which is exactly how it failed: two of six loaded runs timed
// out at 8.02 s with the screen still on PowerShell filler and the host not yet
// at its START checkpoint.
const BOOT: Duration = Duration::from_secs(20);
// STEP covers the 22 single-reaction waits after boot (a keystroke echoing, a
// lane label changing, the PTY going idle). Worst observed across the same 14
// runs is 1.10 s -- the post-shutdown screen -- and every other site is under
// 450 ms. 8 s is 7.3x that worst case; kept unchanged rather than tightened,
// because these budgets only spend wall-clock when the test is already failing,
// and a slower CI host has no measured headroom to give back.
const STEP: Duration = Duration::from_secs(8);
const EXPECTED_HANDSHAKE: &str = "START\nRX initialize\nTX initialize\nRX session/new\nTX session/new\nTX readiness\nRX resync\nTX resync\n";
const ROOM_HEADER: &str = "m0irai · the room";
/// The guidance row while a lane is `Running | Cancelling` — slice B's rung 2,
/// and the room's own honest report of whether it is busy. Used below as a
/// synchronisation point precisely because it is DERIVED from lane state rather
/// than being a transcript row an earlier turn can leave on screen.
const HINT_INTERRUPT: &str = "esc to interrupt";
/// Slice B's rung 1: the quit is armed and the next Ctrl+C ends the room.
const HINT_ARMED: &str = "agents stopped — press ctrl+c again to quit";
/// Turn 2's prompt in the first test: the lane whose 32-chunk answer pushes its
/// own header out of the 40-row viewport. Spelled once and both SUBMITTED and
/// matched from here, because it is load-bearing as a POSITION rather than as
/// text — see [`row_below_row`] — and a marker that drifts from the prompt that
/// produced it silently stops scoping anything.
const LONG_LANE_PROMPT: &str = "long lane";
/// The empty-room hero card, as two things a real terminal must show.
///
/// TRAP: `CARD_NAME` is deliberately NOT used as a substring. The product name
/// is in the room header AND in the room footer, ConPTY announces the console
/// title at startup (the title is the executable's own path), and the footer
/// can carry a working directory that contains it too — so
/// `screen.contains("m0irai")` is true on frames holding no card at all. It is
/// matched as a WHOLE TRIMMED ROW instead: the card centres the name alone on
/// its own line, and no chrome line ever trims to just the name. That makes it
/// a settled-state marker for free, since a half-typed row trims to "m0ir".
///
/// The tagline is the card's only plain-text signature, and it is on the card
/// from its very first frame.
///
/// Both are literals rather than imports from `xai_grok_pager::room_welcome`:
/// this test proves what reaches a real terminal, so it must not share a
/// constant with the code that draws it.
const CARD_TAGLINE: &str = "three minds · one thread";
const CARD_NAME: &str = "m0irai";

/// Whether some row holds `needle` and nothing else but the card's own border.
///
/// A terminal row spans the full width, so the card's name arrives as
/// `│              m0irai              │`. The border glyphs come off
/// first, then the padding, and what is left must be exactly the name. Chrome
/// rows can never reduce to it: the header trims to "m0irai · the room" and
/// the footer to "m0irai · #<session>".
fn card_name_row(screen: &str, needle: &str) -> bool {
    screen.lines().any(|line| {
        line.trim()
            .trim_matches(|glyph| glyph == '│' || glyph == '|')
            .trim()
            == needle
    })
}

/// Whether a row holding `needle` sits strictly BELOW the row holding `prompt`.
///
/// ⚠ **A wait for `"codex — cancelled"` anywhere on the screen is satisfied by
/// the WRONG TURN, and that is not a hypothesis.** Turn 1 of this test cancels
/// codex too and asserts that exact literal, so a page-up loop hunting for it
/// walks straight back towards a row that has been on the feed the whole time.
/// Run with turn 2's `/cancel` deleted and the run stopped at the loop, the test
/// still PASSED — `CONPTY checkpoint: long-lane cancel found after 5 page-ups`,
/// `test result: ok. 1 passed` — after the same five page-ups a real run takes.
///
/// It is LATENT rather than firing, and that was measured rather than assumed:
/// an instrumented build that exited on the old unscoped predicate and then
/// asked, off the very same screen string, whether a turn-2 row existed
/// reported `satisfied after 4 page-ups; a turn-2 scoped row was PRESENT` on
/// three consecutive runs. So today the old wait happens to match the right
/// row — it just never had to. What it lacked was the GUARANTEE, and a wait
/// that is correct by luck is a load-sensitive false pass, not a proof. This is
/// the third stale-match shape in this file, after `wait_progress_count`'s
/// append-only log and the turn-3 wait at the two-turn proof below.
///
/// The prompt row is the turn boundary, and it is one no lane row can cross:
/// `place_lane_block` only ever inserts a lane's rows before another row of the
/// SAME turn (`room_scrollback.rs:965-970`, "Turn-scoped deliberately"), and the
/// operator's own prompt is not a lane row at all. So every row a later turn
/// draws lands below that turn's prompt, and no earlier turn's row can climb
/// past it — a `codex — cancelled` strictly below turn 2's prompt is turn 2's.
///
/// An absent prompt row answers `false` rather than falling through to a
/// screen-wide match: off-screen is "keep paging", never "close enough".
fn row_below_row(screen: &str, prompt: &str, needle: &str) -> bool {
    screen
        .lines()
        .skip_while(|line| !line.contains(prompt))
        .skip(1)
        .any(|line| line.contains(needle))
}

const UNICODE_IDENTITIES: [&str; 3] = ["✻ claude", "⬡ codex", "✦ gemini"];
const EDITOR_SAFE_IDENTITIES: [&str; 3] = ["◆ claude", "● codex", "▲ gemini"];
const ASCII_IDENTITIES: [&str; 3] = ["* claude", "# codex", "+ gemini"];
const SHELL_HISTORY_SENTINEL: &str = "__ZER0_PREAPP_SHELL_HISTORY";

/// One pseudoconsole session at a time, for every test in this file.
///
/// Each test here spawns a real PowerShell, a real `m0irai.exe` and a real Node
/// host, and then asserts on TIMING — quiet windows, render round-trips, a
/// three-second confirmation window. `cargo test` runs the tests in a binary
/// concurrently by default, so two of these would contend for the same machine
/// and manufacture exactly the load-induced REDs this repo has already recorded
/// twice (FL-013, FL-070). The resource being allocated is the machine, and it
/// is allocated by the operation that starts the work rather than by a flag
/// somebody has to remember to pass.
///
/// Poisoning is deliberately ignored: a panicking test has already reported its
/// own failure, and turning that into a second, misleading failure in the next
/// test helps nobody.
static CONPTY_SESSION: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn conpty_session_lock() -> std::sync::MutexGuard<'static, ()> {
    CONPTY_SESSION
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

const HOST: &str = r#"
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const sessionId = 'chat-conpty'; const at = '2026-08-01T00:00:00Z';
let seq = 0, turns = 0, initialized = false, buffer = '';
const history = [];
const live = new Map();
const checkpoint = point => fs.appendFileSync(process.env.ZER0_TEST_PROGRESS, point + '\n');
checkpoint('START');
const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
fs.writeFileSync(process.env.ZER0_TEST_PIDS, JSON.stringify({host:process.pid, helper:helper.pid}));
process.stderr.write('HOST_STDERR_MARKER\n');
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
const ok = (id, result) => out({jsonrpc:'2.0',id,result});
const emit = (turnId, type, payload, whenAt) => { const event={protocol:'zer0.room',version:1,sessionId,eventSeq:String(++seq),eventId:`e-${seq}`,turnId,occurredAt:whenAt || at,type,payload}; history.push(event); out({jsonrpc:'2.0',method:'zer0/room/event',params:event}); return event; };
const lane = (turn, agent) => `lane-${turn}-${agent}`;
const settle = (turn, agent) => { const laneId = lane(turn, agent); if (!live.has(laneId)) return; live.delete(laneId); const streamId = `stream-${turn}-${agent}`; emit(turn, 'lane.cancelling', {laneId, streamId, agent}); setTimeout(() => emit(turn, 'lane.cancelled', {laneId, streamId, agent}), 120); };
const STEPS = /STEPS_TURN/;
// Slice D, proof site 20. Additive and keyed on the TEXT, exactly as slice C's
// STEPS trigger above: SLOW_TURN dispatches ONE lane that never settles, and
// WAKE_SLOW commits a lane of its own and then, after a real delay, commits
// the earlier turn's lane. That delay is what makes the answer CROSS-TURN --
// the later turn's `turn.accepted` sits between the slow lane's first draw
// and its commit, which is the whole displacement predicate.
const SLOW = /SLOW_TURN/;
const WAKE = /WAKE_SLOW/;
let slowLane = null;
function beginTurn(text) {
  // The turn-1 fan-out is suppressed for SLOW_TURN: slice D's site needs ONE
  // lane left running, and two extra lanes would keep `lane_busy` true, which
  // gives the guidance row to rung 2 (`esc to interrupt`) forever and hides
  // the pill this site exists to see.
  const turn = `turn-${++turns}`, agents = ((turns === 1 && !SLOW.test(text)) || text.includes('THREE')) ? ['claude','codex','gemini'] : ['codex'];
  emit(turn, 'turn.accepted', {agents,text,messageId:`operator-${turn}`,ledgerSeq:String(turns)});
  emit(turn, 'route.resolved', {agents});
  for (const agent of agents) emit(turn, 'lane.queued', {laneId:lane(turn,agent),agent,expectedMessageId:`message-${turn}-${agent}`,origin:'operator',hopIndex:0});
  for (const agent of agents) { emit(turn, 'lane.started', {laneId:lane(turn,agent),streamId:`stream-${turn}-${agent}`,agent,modelId:'deterministic'}); live.set(lane(turn,agent), {turn,agent}); }
  for (const [index,agent] of agents.entries()) { const text = turns === 2 && agent === 'codex' ? `turn ${turns} ${agent} independently streaming ${index}\n\n${Array.from({length:32},(_,line) => `resize scrollback line ${line + 1}`).join('\n\n')}\n\nRESIZE_READY_32` : `turn ${turns} ${agent} independently streaming ${index}`; emit(turn, 'lane.chunk', {laneId:lane(turn,agent),streamId:`stream-${turn}-${agent}`,agent,streamSeq:'1',chunkIndex:0,channel:'assistant',text}); }
  if (turns === 1 && !SLOW.test(text)) setTimeout(() => { for (const agent of agents) settle(turn, agent); }, 1100);
  if (SLOW.test(text)) slowLane = {turn, agent: 'codex'};
  if (WAKE.test(text)) {
    const agent = 'codex', laneId = lane(turn, agent), streamId = `stream-${turn}-${agent}`;
    emit(turn, 'message.committed', {laneId,agent,messageId:`message-${turn}-${agent}`,ledgerSeq:String(turns * 100),text:Array.from({length:40},(_,line) => `wake line ${line + 1}`).join(String.fromCharCode(10, 10)),origin:'operator',hopIndex:0});
    emit(turn, 'lane.completed', {laneId,streamId,agent});
    live.delete(laneId);
    if (slowLane) {
      const late = slowLane; slowLane = null;
      setTimeout(() => {
        const lateLane = lane(late.turn, late.agent), lateStream = `stream-${late.turn}-${late.agent}`;
        // Only if the lane is STILL live. If something cancelled it in the
        // meantime, a commit here is an invalid transition, the pager treats
        // an invalid event as fatal, and the test dies with `room host exited`
        // instead of with the assertion that would have named the cause.
        if (!live.has(lateLane)) { checkpoint('SKIP late commit: lane already settled'); return; }
        live.delete(lateLane);
        checkpoint('TX late commit');
        emit(late.turn, 'message.committed', {laneId:lateLane,agent:late.agent,messageId:`message-${late.turn}-${late.agent}`,ledgerSeq:'900',text:'SLOW_ANSWER_LANDED',origin:'operator',hopIndex:0});
        emit(late.turn, 'lane.completed', {laneId:lateLane,streamId:lateStream,agent:late.agent});
      }, 900);
    }
  }
  // Slice C, proof site 20. Additive and keyed on the TEXT, not the turn index:
  // turn 1's three-lane cancel is load-bearing for four assertions above, and
  // nothing else in this fixture ever emitted a tool step, a commit or a
  // completion. `occurredAt` is overridden so the run spans a real 12 seconds -
  // before this, every event here shared one instant and any duration the room
  // computed was exactly zero (FL-116).
  if (STEPS.test(text)) {
    const agent = 'codex', laneId = lane(turn, agent), streamId = `stream-${turn}-${agent}`;
    for (let i = 0; i < 6; i++) {
      emit(turn, 'lane.activity', {laneId,streamId,agent,toolCallId:`tool-${i}`,update:'tool_call',title:`conpty tool step ${i}`,status: i === 4 ? 'failed' : 'completed'}, `2026-08-01T00:00:0${i + 1}Z`);
    }
    emit(turn, 'message.committed', {laneId,agent,messageId:`message-${turn}-${agent}`,ledgerSeq:String(turns * 100),text:`turn ${turns} ${agent} independently streaming 0`,origin:'operator',hopIndex:0}, '2026-08-01T00:00:12Z');
    emit(turn, 'lane.completed', {laneId,streamId,agent}, '2026-08-01T00:00:12Z');
  }
}
function control(params) {
  // The scope is RECORDED and OBEYED. It used to be neither: this handler always
  // cancelled the latest turn's codex lane, so an `all`-versus-`latest` mistake in
  // the pager was invisible to every ConPTY assertion here. Slice B's key sends
  // `all` deliberately, and a fixture that cannot see the difference cannot prove it.
  checkpoint(`RX control ${params.command}${params.scope ? ' ' + params.scope : ''}`);
  if (params.command === 'pause') emit('turn-1','room.paused',{});
  if (params.command === 'resume') emit('turn-1','room.resumed',{});
  if (params.command === 'cancel') {
    const scope = params.scope || 'latest';
    const latest = `turn-${turns}`;
    for (const [laneId, entry] of [...live]) {
      if (scope === 'latest' && entry.turn !== latest) continue;
      if (scope === 'agent' && entry.agent !== params.agent) continue;
      settle(entry.turn, entry.agent);
    }
  }
}
process.stdin.on('data', bytes => { buffer += bytes; for (;;) { const atNewline=buffer.indexOf('\n'); if (atNewline < 0) return; const request=JSON.parse(buffer.slice(0,atNewline)); buffer=buffer.slice(atNewline+1); if (request.method === 'initialize') { checkpoint('RX initialize'); initialized=true; ok(request.id,{protocolVersion:1,_meta:{'zer0.room':{version:1}}}); checkpoint('TX initialize'); } else if (request.method === 'session/new') { checkpoint('RX session/new'); if (!initialized) throw new Error('initialize first'); ok(request.id,{sessionId}); checkpoint('TX session/new'); out({jsonrpc:'2.0',method:'zer0/room/event',params:{protocol:'zer0.room',version:1,sessionId,eventSeq:'0',eventId:'ready',turnId:'bootstrap',occurredAt:at,type:'session.saved',payload:{ready:true}}}); checkpoint('TX readiness'); } else if (request.method === 'zer0/room/resync') { checkpoint('RX resync'); ok(request.id,{events:history.filter(event => BigInt(event.eventSeq)>BigInt(request.params.afterEventSeq))}); checkpoint('TX resync'); } else if (request.method === 'zer0/room/submit') { checkpoint('RX submit'); beginTurn(request.params.text); ok(request.id,{accepted:true}); } else if (request.method === 'zer0/room/control') { control(request.params); ok(request.id,{ok:true}); } else if (request.method === 'zer0/room/shutdown') { checkpoint('RX shutdown'); ok(request.id,{ok:true}); } else { ok(request.id,{}); } } });
// This fixture had NO exit path — no `process.exit`, no end-of-input handler — so it acknowledged the
// shutdown and then lived forever on the interval below. That was invisible while a launcher kill exited
// 0 in silence; round 3 made the kill say so and exit 4, and the two proofs in this file that wait for
// `__ZER0_EXIT:0` became unsatisfiable by any screen budget (codex r3, reviewer CX-3).
//
// It now ends the way the real host ends: `main` in `src/room/zer0-v2-host.ts` reads stdin to EOF and
// only then closes, and the launcher closes stdin the moment it has its acknowledgement. Measured on ten
// staged real hosts, the gap from acknowledgement to exit is 89–168 ms; nothing here sleeps to imitate
// that, because what these tests need is the PATH, not the latency. Every termination assertion in this
// file belongs to the fixtures that deliberately refuse to go — `EXIT_HOST`'s wedge and BREAK_TRANSPORT.
process.stdin.on('end', () => process.exit(0));
setInterval(() => {}, 1000);
"#;

struct OwnedProcesses {
    pids: Vec<u32>,
}
impl OwnedProcesses {
    fn terminate_exact(pid: u32) {
        unsafe {
            let handle = OpenProcess(PROCESS_TERMINATE, false, pid).ok();
            if let Some(handle) = handle {
                let _ = TerminateProcess(handle, 1);
                let _ = CloseHandle(handle);
            }
        }
    }
}
impl Drop for OwnedProcesses {
    fn drop(&mut self) {
        for &pid in &self.pids {
            Self::terminate_exact(pid);
        }
    }
}

struct PtyCleanup {
    child: Option<PtyChild>,
}
impl Drop for PtyCleanup {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut()
            && child.is_alive()
        {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn public_binary_restores_conpty_and_reaps_host_tree() -> Result<()> {
    let _session = conpty_session_lock();
    let root = tempfile::Builder::new()
        .prefix("zer0-v2-conpty-")
        .tempdir()?;
    let binary = binary_under_test()?;
    let binary_name = binary.file_name().context("binary name")?;
    fs::copy(&binary, root.path().join(binary_name))?;
    fs::write(root.path().join("zer0-v2-host.mjs"), HOST)?;
    fs::write(
        root.path().join("run.ps1"),
        "Write-Output '__ZER0_PREAPP_SHELL_HISTORY'\n1..48 | ForEach-Object { Write-Output ('__ZER0_PREAPP_FILLER_' + $_) }\n& (Join-Path $PSScriptRoot 'm0irai.exe')\n$code=$LASTEXITCODE\nWrite-Output \"__ZER0_EXIT:$code\"\n$answer=Read-Host '__ZER0_COOKED'\nWrite-Output \"__ZER0_ECHO:$answer\"\nexit $code\n",
    )?;
    let pid_file = root.path().join("owned-pids.json");
    let progress_file = root.path().join("host-progress.log");
    let mut env = HashMap::new();
    env.insert("ZER0_TEST_PIDS".into(), pid_file.display().to_string());
    env.insert(
        "ZER0_TEST_PROGRESS".into(),
        progress_file.display().to_string(),
    );
    let config = PtyConfig {
        command: vec![
            "powershell.exe".into(),
            "-NoLogo".into(),
            "-NoProfile".into(),
            "-ExecutionPolicy".into(),
            "Bypass".into(),
            "-Command".into(),
            "./run.ps1".into(),
        ],
        cols: 120,
        rows: 40,
        cwd: Some(root.path().to_path_buf()),
        env,
    };
    let (master, child, reader, writer) = PtyHandle::spawn(&config)?.into_parts();
    let mut pty_cleanup = PtyCleanup { child: Some(child) };
    let (input_tx, input_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let (reply_tx, reply_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    let terminal = start_terminal(reader, 120, 40, SessionListener::new(reply_tx));
    start_writer(writer, input_rx, reply_rx);
    let mut owned = OwnedProcesses { pids: Vec::new() };

    if let Err(error) = wait_screen(&terminal, BOOT, |screen| {
        screen.contains(ROOM_HEADER) && screen.contains("type to start")
    }) {
        return Err(error.context(format!(
            "host progress checkpoints (phase is internal to the release binary):\n{}",
            read_progress(&progress_file)
        )));
    }
    let first = screen(&terminal.0);
    assert_eq!(
        read_progress(&progress_file),
        EXPECTED_HANDSHAKE,
        "host handshake must complete in strict order"
    );
    assert!(
        !first.trim().is_empty()
            && !first.contains("{\"jsonrpc\"")
            && !first.contains("HOST_STDERR_MARKER"),
        "first frame must be quiet UI: {first}"
    );
    for expected in [ROOM_HEADER, "type to start"] {
        assert_eq!(
            first.matches(expected).count(),
            1,
            "first frame must render Grok-style room chrome once: {expected}\n{first}"
        );
    }
    // An untouched room introduces the product on a real terminal: the
    // bordered card, the mark, the typed name and the tagline. This waits for
    // the SETTLED state rather than sampling a frame at a fixed offset — the
    // entrance types the name out over ~0.9 s, and racing a real terminal for
    // one mid-entrance frame is exactly the load-sensitive wait that cost this
    // suite a flake before (FL-070). The reveal math is pinned by unit tests,
    // where it is deterministic.
    wait_screen(&terminal, STEP, |screen| card_name_row(screen, CARD_NAME))?;
    let welcome = screen(&terminal.0);
    assert_eq!(
        welcome.matches(CARD_TAGLINE).count(),
        1,
        "the settled empty room shows the hero card exactly once\n{welcome}"
    );

    // The settled card KEEPS PAINTING. The operator overruled freeze on
    // 2026-08-19 ("keep the shining pulsing/going"), so the empty room is
    // deliberately the one surface here that moves on its own — and this is
    // where that is proved against a real terminal instead of a buffer.
    //
    // This REPLACES the assertion that a settled empty room emits NOTHING,
    // which was right under the freeze it was written for and is now wrong by
    // decision. Still condition-based, so there is no fixed-timing wait: it
    // waits for the byte counter to move and fails by timeout if the card has
    // gone silent. The counterpart — that the shine STOPS once content lands —
    // is the idle assertion further down, which now carries that weight.
    let bytes_before_shine = terminal.1.load(Ordering::Acquire);
    wait_bytes_beyond(&terminal.1, bytes_before_shine, STEP)
        .context("a settled welcome card must keep painting its shine")?;

    let identities = [
        &UNICODE_IDENTITIES,
        &EDITOR_SAFE_IDENTITIES,
        &ASCII_IDENTITIES,
    ]
    .into_iter()
    .find(|family| family.iter().all(|identity| first.contains(identity)))
    .expect("quiet boot must use one complete identity glyph family");
    for expected in identities {
        assert_eq!(
            first.matches(expected).count(),
            1,
            "quiet boot must render one complete identity profile: {expected}\n{first}"
        );
    }
    assert_fullscreen_entered(&terminal.2);
    println!("CONPTY checkpoint: first-frame");

    send_keys(&input_tx, "@all prove three lanes\r")?;
    if let Err(error) = wait_screen(&terminal, STEP, |s| {
        s.contains("claude independently")
            && s.contains("codex independently")
            && s.contains("gemini independently")
    }) {
        return Err(error.context(format!(
            "host progress:\n{}\nscrollback:\n{}",
            read_progress(&progress_file),
            scrollback(&terminal.0)
        )));
    }
    let first_stream_screen = screen(&terminal.0);
    // Phase 6: the greeting is gone the moment the room has content, and it is
    // latched gone — the rest of this test never sees it again.
    assert!(
        !first_stream_screen.contains(CARD_TAGLINE),
        "the welcome card must not survive the room's first content\n{first_stream_screen}"
    );
    assert!(
        !card_name_row(first_stream_screen.as_str(), CARD_NAME),
        "the card's name row must go with it\n{first_stream_screen}"
    );
    for expected in [
        "turn 1 claude independently streaming 0",
        "turn 1 codex independently streaming 1",
        "turn 1 gemini independently streaming 2",
    ] {
        assert_eq!(
            first_stream_screen.matches(expected).count(),
            1,
            "each live room stream must be rendered exactly once: {expected}\n{first_stream_screen}"
        );
    }
    send_keys(&input_tx, "draft-visible")?;
    wait_screen(&terminal, STEP, |s| {
        s.contains("draft-visible") && s.contains("turn 1 claude independently streaming 0")
    })?;
    // FL-071 on a real terminal. All three lanes have delivered their answers and
    // none has settled yet -- exactly the window the operator screenshotted on
    // 2026-08-19, where the host was still 0.684-7.910 s from committing. No
    // `working` row may share this screen with the answers.
    let delivered_screen = screen(&terminal.0);
    assert!(
        !delivered_screen.contains("working"),
        "FL-071: a delivered answer must not render beside a working row\n{delivered_screen}"
    );
    for _ in 0..13 {
        send_keys(&input_tx, "\u{8}")?;
    }
    // The real pager keeps the frontend slash dropdown open for an exact
    // command. Escape closes presentation-only completion; the following
    // Enter dispatches the completed room command.
    submit_room_command(&input_tx, "/pause")?;
    wait_progress_contains(&progress_file, "RX control pause", STEP)
        .with_context(|| format!("pager screen after /pause:\n{}", screen(&terminal.0)))?;
    submit_room_command(&input_tx, "/unpause")?;
    wait_progress_contains(&progress_file, "RX control resume", STEP)?;
    println!("CONPTY checkpoint: streams-draft-pause");

    wait_screen(&terminal, STEP, |s| {
        s.contains("claude — cancelled")
            && s.contains("codex — cancelled")
            && s.contains("gemini — cancelled")
    })?;
    // The room with content in it is SILENT. This is the counterpart to the
    // shine probe above and now carries its weight: the empty-room card is the
    // only surface here allowed to move on its own, so the moment the room has
    // anything to say, the animation must be gone with the card. A shine that
    // outlived its card would show up here as bytes on an idle terminal.
    let bytes_at_idle = wait_quiet(&terminal.1, Duration::from_millis(200), STEP)?;
    std::thread::sleep(Duration::from_millis(350));
    assert_eq!(
        bytes_at_idle,
        terminal.1.load(Ordering::Acquire),
        "idle room must not redraw"
    );

    send_keys(&input_tx, &format!("@codex {LONG_LANE_PROMPT}\r"))?;
    wait_screen(&terminal, STEP, |s| s.contains("RESIZE_READY_32"))?;
    let long_lane_screen = screen(&terminal.0);
    assert!(
        !long_lane_screen.contains("working"),
        "FL-071: the long lane's delivered answer must not render beside a working row\n{long_lane_screen}"
    );
    submit_room_command(&input_tx, "/cancel")?;
    wait_progress_contains(&progress_file, "RX control cancel", STEP)?;
    // The FL-071 exemption, proven on a real terminal: this lane's answer is
    // already on screen, and the cancel acknowledgement still has to reach it.
    wait_screen(&terminal, STEP, |s| s.contains("cancelling"))?;
    // FL-141b (operator ruling, 2026-08-22): the word "cancelled" now lives on
    // the lane's own HEADER - exactly ONE gray row per cancelled agent, no
    // second row under the answer. This lane's answer is 32 chunks long, so by
    // the time the cancel lands its header has scrolled out of the 40-row
    // viewport, the same viewport reality this file already records at the
    // two-turn proof below. MEASURED, not reasoned: on 2026-08-22 the plain
    // `wait_screen` for "codex — cancelled" timed out here at 8.007s over
    // 130032 PTY bytes with the answer's tail (resize scrollback line 19..32)
    // on screen and no cancelled row anywhere, while the same wait passed on
    // `ad2dde9`, the tree before the ruling landed.
    //
    // So the acknowledgement is proven where it now is: the proof pages the
    // feed up to it on a real terminal, then pages back down so every later
    // step still sees the bottom of the room. This is a REAL regression in
    // what a cancel shows without scrolling when the answer is longer than the
    // viewport, and it is the ruling's cost, recorded here rather than worked
    // around by putting the word back on a second row.
    //
    // Scoped to THIS turn by [`row_below_row`], and that scoping is the whole
    // difference between a proof and a coincidence: turn 1 above already left a
    // `codex — cancelled` row in the feed, and it lies in the direction this
    // loop pages. The RED is quoted in that helper's docs.
    //
    // Cost of the scoping: the prompt row sits one row above the header, so a
    // page-up that lands the header on the screen's very top row leaves the
    // prompt just off it and costs ONE more page-up. The bound stays 12 —
    // 144 rows, against roughly 48 to the header and a feed that clamps with
    // both rows in view — and the loop's worst case is unchanged at 12 x 120 ms
    // ~ 1.5 s. It is not a `wait_screen` and spends no STEP budget.
    let mut paged = 0;
    while !row_below_row(&screen(&terminal.0), LONG_LANE_PROMPT, "codex — cancelled") {
        assert!(
            paged < 12,
            "no `codex — cancelled` row belonging to the `{LONG_LANE_PROMPT}` turn came \
             into view after {paged} page-ups (that turn's prompt row is {}); screen:\n{}",
            if screen(&terminal.0).contains(LONG_LANE_PROMPT) {
                "on screen"
            } else {
                "off screen"
            },
            screen(&terminal.0)
        );
        send_page_up(&input_tx)?;
        paged += 1;
        thread::sleep(Duration::from_millis(120));
    }
    println!("CONPTY checkpoint: long-lane cancel found after {paged} page-ups");
    for _ in 0..paged + 4 {
        send_page_down(&input_tx)?;
        thread::sleep(Duration::from_millis(60));
    }
    // Back at the bottom: the answer's LAST line is only on screen when the
    // feed is following again, so this discriminates bottom from top rather
    // than merely re-checking that the lane exists.
    wait_screen(&terminal, STEP, |s| s.contains("RESIZE_READY_32"))?;
    wait_quiet(&terminal.1, Duration::from_millis(200), STEP)?;
    let bytes_before_resize = terminal.1.load(Ordering::Acquire);
    resize(&master, &terminal.0, 80, 24)?;
    wait_for_output_then_quiet(
        &terminal.1,
        bytes_before_resize,
        Duration::from_millis(250),
        STEP,
    )?;
    let compact_screen = screen(&terminal.0);
    let compact = active_room_suffix(&compact_screen)?;
    for expected in [ROOM_HEADER] {
        assert_eq!(
            compact.matches(expected).count(),
            1,
            "compact active viewport duplicates {expected}: {compact_screen}"
        );
    }
    assert!(!compact.contains("{\"jsonrpc\"") && !compact.contains("HOST_STDERR_MARKER"));
    // The production pager is full-screen, so room frames belong to its
    // alternate buffer. The shell history is checked after teardown instead
    // of treating the pager's live buffer as primary-screen scrollback.
    assert_no_destructive_terminal_reset(&terminal.2);

    let bytes_before_regrow = terminal.1.load(Ordering::Acquire);
    resize(&master, &terminal.0, 120, 40)?;
    wait_for_output_then_quiet(
        &terminal.1,
        bytes_before_regrow,
        Duration::from_millis(250),
        STEP,
    )?;
    let regrown_screen = screen(&terminal.0);
    let regrown_room = active_room_suffix(&regrown_screen)?;
    for expected in [ROOM_HEADER] {
        assert_eq!(
            regrown_room.matches(expected).count(),
            1,
            "regrown active viewport duplicates {expected}: {regrown_screen}"
        );
    }
    assert_no_destructive_terminal_reset(&terminal.2);

    send_keys(&input_tx, "@codex resize proof\r")?;
    wait_screen(&terminal, STEP, |s| {
        s.contains("turn 3 codex independently streaming 0")
    })?;
    // ⚠ **Changed by slice B, and the old assertion is quoted RED in its
    // handback.** This block used to end at `s.contains("codex — cancelled")`
    // and then send the Ctrl+C below — but turn 2 had already left that exact
    // row in the scrollback, so the wait matched an OLD row and returned while
    // turn 3's lane was still `Cancelling`. The room was busy at that Ctrl+C and
    // nothing here could tell: before slice B, Ctrl+C on an empty composer quit
    // regardless of lane state, so a wrong wait still produced the right outcome.
    // Slice B made lane state decide, and the defect surfaced at once — the key
    // sent a cancel and armed a quit, and the progress log ended `RX control
    // cancel` where `RX shutdown` belonged.
    //
    // The replacement waits on the room's OWN report of what it is doing. The
    // guidance row reads `esc to interrupt` for exactly as long as a lane is
    // `Running | Cancelling`, so it appears while turn 3 streams and goes when
    // the lane settles — it cannot match a stale transcript row, because it is
    // not one. Waited in that order deliberately: an absent hint proves nothing
    // unless the hint was there first, and the pair doubles as the real-terminal
    // proof that slice B's rung 2 paints at all.
    wait_screen(&terminal, STEP, |s| s.contains(HINT_INTERRUPT))?;
    submit_room_command(&input_tx, "/cancel")?;
    wait_screen(&terminal, STEP, |s| s.contains("cancelling"))?;
    wait_screen(&terminal, STEP, |s| s.contains("codex — cancelled"))?;
    wait_screen(&terminal, STEP, |s| !s.contains(HINT_INTERRUPT))?;
    println!("CONPTY checkpoint: resize-cancel");

    // Slice C proof site 20, on a real screen. Six tool calls run, one of them
    // fails, the lane commits. Before slice C this painted six rows above the
    // answer and gave every one of them a check mark; now it is one row that
    // names the count, the failure and the duration.
    //
    // Until this turn existed the site had NO PATH: the fixture emitted
    // `lane.queued`, `lane.started`, `lane.chunk` and `lane.cancelled` and
    // nothing else, so no ConPTY test had ever seen a terminal tool step, a
    // commit or a completion. The spec asserted coverage that was not there.
    send_keys(&input_tx, "@codex steps proof STEPS_TURN\r")?;
    wait_screen(&terminal, STEP, |s| s.contains("6 steps · 1 failed · 12s"))?;
    let folded_screen = screen(&terminal.0);
    for index in 0..6 {
        let label = format!("conpty tool step {index}");
        assert!(
            !folded_screen.contains(&label),
            "the wall of step rows must be gone from the real screen: {label}\n{folded_screen}"
        );
    }
    assert_eq!(
        folded_screen.matches("6 steps · 1 failed · 12s").count(),
        1,
        "exactly one folded summary row, legible at this width\n{folded_screen}"
    );
    assert!(
        !folded_screen.contains("✓ 6 steps"),
        "F-1 on a real terminal: a run containing a failure wears no check mark\n{folded_screen}"
    );
    println!("CONPTY checkpoint: steps-folded");

    let pids: serde_json::Value = wait_file_json(&pid_file, STEP)?;
    for key in ["host", "helper"] {
        owned
            .pids
            .push(pids[key].as_u64().context("owned PID")? as u32);
    }
    send_ctrl_c(&input_tx)?;
    wait_progress_contains(&progress_file, "RX shutdown", STEP)?;
    wait_screen(&terminal, STEP, |s| {
        s.contains("__ZER0_EXIT:0") && s.contains("__ZER0_COOKED")
    })?;
    send_raw(&input_tx, "restored\r")?;
    wait_screen(&terminal, STEP, |s| s.contains("__ZER0_ECHO:restored"))?;
    assert_history_exactly_once(&terminal.0, &[SHELL_HISTORY_SENTINEL]);
    assert_no_destructive_terminal_reset(&terminal.2);
    assert_fullscreen_round_trip(&terminal.2);
    let code = wait_child(pty_cleanup.child.as_mut().context("PTY child")?, STEP)?;
    assert_eq!(code, 0, "wrapper must preserve m0irai exit code");
    let modes = terminal.0.lock().unwrap().terminal_modes();
    assert!(
        !modes.alt_screen && !modes.bracketed_paste && modes.show_cursor,
        "terminal modes not restored: {modes:?}"
    );
    for pid in owned.pids.drain(..) {
        assert_signaled(pid)?;
    }
    pty_cleanup.child.take();
    println!("CONPTY checkpoint: restored-and-reaped");
    Ok(())
}

/// [FALSIFIER] Slice B on the real binary: `Ctrl+C` stops the agents instead of
/// killing the room, and only a second press ends it.
///
/// ⚠ **This is the assertion the slice exists for, and a unit test cannot make
/// it.** The operator's report was that they pressed Ctrl+C in a running room
/// and lost the session. Whether that key even reaches the router is a
/// question about ConPTY key records, raw mode and the pager's input decoder —
/// none of which a `KeyEvent::new` in a unit test touches. Neither is the
/// guidance row, which only exists once something has painted a terminal.
///
/// Four things are proved here that nothing else in this repo can prove:
///
/// 1. **rung 2 renders** — `esc to interrupt` appears on a real screen while
///    lanes are in flight, and goes when they settle.
/// 2. **a real Esc cancels, with `scope: all`, across TWO non-terminal turns.**
///    The fake host now obeys the scope, so a `latest` cancel would leave the
///    first turn's three lanes running — and the hint would stay on screen.
///    That is the finding-7 case: `latest` resolves exactly one turn
///    (`src/room/room-engine.ts:516-520`).
/// 3. **rung 1 renders** — after a real Ctrl+C the room says
///    `agents stopped — press ctrl+c again to quit` instead of exiting.
/// 4. **the second press quits**, and the wrapper still sees exit code 0.
///
/// **Two REDs, both quoted in the handback and both run.**
///
/// - Against the whole of pre-B behaviour it fails at the very first new
///   assertion: the guidance row is blank, so `esc to interrupt` never
///   appears (`RED-05-conpty-site12.log`).
/// - Against a tree carrying the guidance rungs and the Esc arm but with only
///   `route_ctrl_c_at` reverted — the sharper mutation, since it isolates the
///   one behaviour — it fails at the first Ctrl+C, and the progress log ends
///   `RX submit / RX shutdown`: **the room exited on the keypress.** That is
///   the operator's report, reproduced on the real binary
///   (`RED-06-conpty-ctrl-c-ladder-only.log`).
#[tokio::test(flavor = "current_thread")]
async fn a_real_ctrl_c_stops_the_agents_and_a_second_press_quits() -> Result<()> {
    let _session = conpty_session_lock();
    let root = tempfile::Builder::new()
        .prefix("zer0-v2-conpty-cancel-")
        .tempdir()?;
    let binary = binary_under_test()?;
    let binary_name = binary.file_name().context("binary name")?;
    fs::copy(&binary, root.path().join(binary_name))?;
    fs::write(root.path().join("zer0-v2-host.mjs"), HOST)?;
    fs::write(
        root.path().join("run.ps1"),
        "& (Join-Path $PSScriptRoot 'm0irai.exe')\n$code=$LASTEXITCODE\nWrite-Output \"__ZER0_EXIT:$code\"\nexit $code\n",
    )?;
    let pid_file = root.path().join("owned-pids.json");
    let progress_file = root.path().join("host-progress.log");
    let mut env = HashMap::new();
    env.insert("ZER0_TEST_PIDS".into(), pid_file.display().to_string());
    env.insert(
        "ZER0_TEST_PROGRESS".into(),
        progress_file.display().to_string(),
    );
    let config = PtyConfig {
        command: vec![
            "powershell.exe".into(),
            "-NoLogo".into(),
            "-NoProfile".into(),
            "-ExecutionPolicy".into(),
            "Bypass".into(),
            "-Command".into(),
            "./run.ps1".into(),
        ],
        cols: 120,
        rows: 40,
        cwd: Some(root.path().to_path_buf()),
        env,
    };
    let (master, child, reader, writer) = PtyHandle::spawn(&config)?.into_parts();
    let _ = &master;
    let mut pty_cleanup = PtyCleanup { child: Some(child) };
    let (input_tx, input_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let (reply_tx, reply_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    let terminal = start_terminal(reader, 120, 40, SessionListener::new(reply_tx));
    start_writer(writer, input_rx, reply_rx);
    let mut owned = OwnedProcesses { pids: Vec::new() };

    wait_screen(&terminal, BOOT, |screen| {
        screen.contains(ROOM_HEADER) && screen.contains("type to start")
    })
    .with_context(|| {
        format!(
            "host progress checkpoints:\n{}",
            read_progress(&progress_file)
        )
    })?;
    let pids: serde_json::Value = wait_file_json(&pid_file, STEP)?;
    for key in ["host", "helper"] {
        owned
            .pids
            .push(pids[key].as_u64().context("owned PID")? as u32);
    }

    // Two non-terminal turns at once. The first carries the THREE marker, so the
    // fake host starts claude, codex AND gemini on it; the second is codex
    // alone on a later turn. This is the only shape in which `all` and `latest`
    // can be told apart, and the fixture asserts it reached that shape by
    // waiting for both turns' streams before touching a key.
    send_keys(&input_tx, "THREE minds please\r")?;
    wait_screen(&terminal, STEP, |s| {
        s.contains("turn 1 claude independently streaming 0")
            && s.contains("turn 1 codex independently streaming 1")
            && s.contains("turn 1 gemini independently streaming 2")
    })?;
    // Rung 2, on a real terminal. Asserted before any key is pressed, so an
    // absent hint later cannot be confused with a hint that never appeared.
    wait_screen(&terminal, STEP, |s| s.contains(HINT_INTERRUPT))?;
    println!("CONPTY checkpoint: three-lanes-running");

    // ⚠ The first turn's three lanes are auto-cancelled by the fake host 1.1s
    // in, which is how the OTHER test in this file reaches its cancelled rows.
    // Waiting that out first would destroy the two-turn shape this proof needs,
    // so the second turn opens immediately and the Esc lands inside the window.
    send_keys(&input_tx, "@codex a second turn\r")?;
    // Waited on the stream's END marker, not its first line. The fake host
    // gives turn 2's codex lane a 32-line body, so its opening line has
    // scrolled out of a 40-row viewport by the time the lane is delivered, and
    // a wait on that line times out while the lane it is waiting for is right
    // there on screen. That was run, and the timeout is quoted in the handback.
    wait_screen(&terminal, STEP, |s| s.contains("RESIZE_READY_32"))?;

    // A real VK_ESCAPE. Nothing else wants it here: the composer is empty, so
    // no slash menu, no address menu, no file-search dropdown, no picker, no
    // history browser and no permission shelf is open to take it first.
    send_raw_escape(&input_tx)?;
    wait_progress_count(&progress_file, "RX control cancel all", 1, STEP).with_context(|| {
        format!(
            "a real Esc must reach the room-wide cancel; progress:\n{}\nscreen:\n{}",
            read_progress(&progress_file),
            screen(&terminal.0)
        )
    })?;
    // Every lane on BOTH turns settles, so the room reports itself idle. Under a
    // `latest` cancel the first turn's three lanes would still be running here
    // and this hint would never go.
    wait_screen(&terminal, STEP, |s| !s.contains(HINT_INTERRUPT)).with_context(|| {
        format!(
            "a `latest` cancel leaves the older turn running; screen:\n{}",
            screen(&terminal.0)
        )
    })?;
    println!("CONPTY checkpoint: esc-cancelled-both-turns");

    // Now the key the operator actually pressed -- and HELD, which is how they
    // reported it. Only the key-down goes in: the chord stays down until the
    // release below, exactly as a real console reports it.
    send_keys(&input_tx, "THREE minds again\r")?;
    wait_screen(&terminal, STEP, |s| s.contains(HINT_INTERRUPT))?;
    send_ctrl_c_down(&input_tx)?;
    // It cancels rather than killing the room -- the whole defect, on the real
    // binary. Read from the host's own log, not from the screen, so the
    // assertion cannot be satisfied by a render that happens to look right.
    wait_progress_count(&progress_file, "RX control cancel all", 2, STEP).with_context(|| {
        format!(
            "the first Ctrl+C must send its OWN room-wide cancel, not be waved through
             by the Esc's line earlier in this append-only log; progress:\n{}",
            read_progress(&progress_file)
        )
    })?;
    wait_screen(&terminal, STEP, |s| s.contains(HINT_ARMED)).with_context(|| {
        format!(
            "the armed row must paint after the first Ctrl+C; screen:\n{}",
            screen(&terminal.0)
        )
    })?;
    println!("CONPTY checkpoint: ctrl-c-armed");

    // ── The held key, on the real binary ────────────────────────────────────
    //
    // ⚠ **This is the operator's original bug, and the shipped fix did not close
    // it.** Off Kitty there is no `KeyEventKind::Repeat` — this repository's own
    // module header says so
    // (`xai-grok-pager-render/src/terminal/kitty_keyboard.rs:28-31`) — so a held
    // Ctrl+C arrives as a stream of `Press`, and a guard that trusted `Press`
    // let the second one confirm the quit it had just armed. Cancel, then
    // instant exit, from one gesture. Windows is one of those terminals:
    // crossterm's `supports_keyboard_enhancement` returns `Ok(false)`
    // unconditionally here (`crossterm-0.28.1/src/terminal/sys/windows.rs:75-77`).
    //
    // No key-up between these. That is the whole case.
    for _ in 0..3 {
        send_ctrl_c_down(&input_tx)?;
    }
    // Bounded, then asserted. There is no positive event a suppressed keystroke
    // can produce, so the proof is split: this window shows the room did NOT
    // leave, and the confirmed quit further down -- through the same PTY, the
    // same writer, the same key records -- is what proves these key-downs were
    // being delivered and read at all. An assertion that the room is still here
    // is worth nothing without it.
    thread::sleep(Duration::from_millis(600));
    let progress = read_progress(&progress_file);
    assert!(
        !progress.contains("RX shutdown"),
        "a HELD Ctrl+C ended the room: this is the operator's original report, \
         reproduced. progress:\n{progress}"
    );
    assert!(
        !screen(&terminal.0).contains("__ZER0_EXIT"),
        "the room process left while the key was still down; screen:\n{}",
        screen(&terminal.0)
    );
    assert_eq!(
        progress.matches("RX control cancel all").count(),
        2,
        "and the held key did not re-cancel on every autorepeat either; \
         progress:\n{progress}"
    );
    println!("CONPTY checkpoint: held-ctrl-c-did-not-quit");

    // The operator lets go. The gesture is over, and the next press is a tap.
    send_ctrl_c_up(&input_tx)?;

    // A fresh turn, because the cancel above settled the lanes and an idle room
    // with an empty composer quits on the FIRST Ctrl+C -- which would prove
    // nothing about confirmation.
    send_keys(&input_tx, "THREE minds once more\r")?;
    wait_screen(&terminal, STEP, |s| s.contains(HINT_INTERRUPT))?;
    let armed_at = Instant::now();
    send_ctrl_c(&input_tx)?;
    wait_progress_count(&progress_file, "RX control cancel all", 3, STEP).with_context(|| {
        format!(
            "the tap after the release must send its own cancel; progress:\n{}",
            read_progress(&progress_file)
        )
    })?;
    wait_screen(&terminal, STEP, |s| s.contains(HINT_ARMED)).with_context(|| {
        format!(
            "the armed row must paint after the tap; screen:\n{}",
            screen(&terminal.0)
        )
    })?;
    println!("CONPTY checkpoint: tap-armed");

    // ⚠ **The one timing dependency this test creates, separated from the
    // product claim on purpose.** Everything between the two presses has to fit
    // inside the 3-second confirmation window, or the second press re-cancels
    // instead of confirming and the wait below times out looking like a product
    // defect. It is not one. So the gap is measured and asserted HERE, with a
    // message that says which kind of failure it is.
    //
    // MEASURED, not assumed (`TIMING-confirm-window-gap.log`, 7 runs, all
    // green): 21-41 ms on a quiet machine, and 229-360 ms with twelve CPU
    // burners saturating all twelve cores -- heavier than the three-lane load
    // this wave actually runs. Worst observed 360 ms against 3000 ms, an 8x
    // margin. The bound below is half the window: 4x the worst measurement,
    // and still far under the point where the product behaviour changes.
    //
    // If this ever fires, the answer is to shorten the gap or give
    // `QUIT_CONFIRM_WINDOW` a test seam. It is NOT to widen the window, which
    // is a product decision, and it is not to raise this bound, which would
    // just delete the separation.
    let gap = armed_at.elapsed();
    assert!(
        gap < Duration::from_millis(1500),
        "HARNESS LOAD, NOT A PRODUCT FAILURE: {gap:?} elapsed between the two \
         Ctrl+C presses, against a 3s confirmation window. Measured 21-41ms \
         quiet and 229-360ms under full saturation, so this machine is slower \
         than anything that was measured. Re-run alone before reading the \
         result below as a defect."
    );
    // And the second press ends it.
    send_ctrl_c(&input_tx)?;
    wait_progress_contains(&progress_file, "RX shutdown", STEP).with_context(|| {
        format!(
            "the second Ctrl+C must end the room; progress:\n{}\nscreen:\n{}",
            read_progress(&progress_file),
            screen(&terminal.0)
        )
    })?;
    wait_screen(&terminal, STEP, |s| s.contains("__ZER0_EXIT:0"))?;
    assert_no_destructive_terminal_reset(&terminal.2);
    assert_fullscreen_round_trip(&terminal.2);
    let code = wait_child(pty_cleanup.child.as_mut().context("PTY child")?, STEP)?;
    assert_eq!(code, 0, "a confirmed quit is a clean exit");
    for pid in owned.pids.drain(..) {
        assert_signaled(pid)?;
    }
    pty_cleanup.child.take();
    Ok(())
}

/// A real VK_ESCAPE key record.
///
/// The same encoding `submit_room_command` uses, hoisted so a test that means
/// "the operator pressed Escape" does not have to spell a ConPTY key record.
fn send_raw_escape(writer: &std::sync::mpsc::Sender<Vec<u8>>) -> Result<()> {
    writer
        .send(b"\x1b[27;1;27;1;0;1_".to_vec())
        .context("PTY writer stopped")
}

/// A real VK_PRIOR (Page Up) key record: `room_runtime.rs`'s
/// `handle_scrollback_key` maps it to `scroll_up(12)`.
///
/// Same ConPTY win32-input encoding `send_keys` spells out - Vk;Sc;Uc;Kd;Cs;Rc
/// - with the unicode column 0 because a navigation key carries no character.
/// Key-DOWN only: the room drops every release but Ctrl+C's (`accepts_key`).
fn send_page_up(writer: &std::sync::mpsc::Sender<Vec<u8>>) -> Result<()> {
    writer
        .send(b"\x1b[33;73;0;1;0;1_".to_vec())
        .context("PTY writer stopped")
}

/// A real VK_NEXT (Page Down) key record; `scroll_down(12)`.
fn send_page_down(writer: &std::sync::mpsc::Sender<Vec<u8>>) -> Result<()> {
    writer
        .send(b"\x1b[34;81;0;1;0;1_".to_vec())
        .context("PTY writer stopped")
}

fn start_terminal(
    reader: Box<dyn Read + Send>,
    cols: u16,
    rows: u16,
    listener: SessionListener,
) -> (Arc<Mutex<Terminal>>, Arc<AtomicUsize>, Arc<Mutex<Vec<u8>>>) {
    let terminal = Arc::new(Mutex::new(Terminal::new(cols, rows, listener)));
    let bytes = Arc::new(AtomicUsize::new(0));
    let raw = Arc::new(Mutex::new(Vec::new()));
    let terminal_thread = Arc::clone(&terminal);
    let bytes_thread = Arc::clone(&bytes);
    let raw_thread = Arc::clone(&raw);
    thread::spawn(move || {
        let mut reader = reader;
        let mut buffer = [0; 4096];
        while let Ok(read) = reader.read(&mut buffer) {
            if read == 0 {
                break;
            }
            bytes_thread.fetch_add(read, Ordering::AcqRel);
            raw_thread
                .lock()
                .unwrap()
                .extend_from_slice(&buffer[..read]);
            terminal_thread.lock().unwrap().feed(&buffer[..read]);
        }
    });
    (terminal, bytes, raw)
}
fn screen(terminal: &Arc<Mutex<Terminal>>) -> String {
    terminal
        .lock()
        .unwrap()
        .screen_content(&ScreenOpts {
            include_empty: true,
            ..Default::default()
        })
        .lines
        .join("\n")
}
fn scrollback(terminal: &Arc<Mutex<Terminal>>) -> String {
    terminal
        .lock()
        .unwrap()
        .scrollback_lines(500)
        .into_iter()
        .map(|line| line.text)
        .collect::<Vec<_>>()
        .join("\n")
}
fn full_terminal_text(terminal: &Arc<Mutex<Terminal>>) -> String {
    format!("{}\n{}", scrollback(terminal), screen(terminal))
}
fn active_room_suffix(screen: &str) -> Result<&str> {
    let start = screen
        .rfind(ROOM_HEADER)
        .context("active room header missing from physical screen")?;
    Ok(&screen[start..])
}
fn assert_history_exactly_once(terminal: &Arc<Mutex<Terminal>>, sentinels: &[&str]) {
    let history = full_terminal_text(terminal);
    for sentinel in sentinels {
        assert_eq!(
            history.matches(sentinel).count(),
            1,
            "native history must preserve sentinel exactly once: {sentinel}\n{history}"
        );
    }
}
fn assert_no_destructive_terminal_reset(raw: &Arc<Mutex<Vec<u8>>>) {
    let raw = raw.lock().unwrap();
    let output = String::from_utf8_lossy(&raw);
    for forbidden in [
        ("ED3 saved-history purge", "\u{1b}[3J"),
        ("RIS terminal reset", "\u{1b}c"),
    ] {
        assert!(
            !output.contains(forbidden.1),
            "fullscreen pager room emitted forbidden {}",
            forbidden.0
        );
    }
}

fn assert_fullscreen_entered(raw: &Arc<Mutex<Vec<u8>>>) {
    let raw = raw.lock().unwrap();
    let output = String::from_utf8_lossy(&raw);
    assert!(
        output.contains("\u{1b}[?1049h"),
        "the real pager room must enter its fullscreen buffer"
    );
}

fn assert_fullscreen_round_trip(raw: &Arc<Mutex<Vec<u8>>>) {
    let raw = raw.lock().unwrap();
    let output = String::from_utf8_lossy(&raw);
    assert_eq!(
        output.matches("\u{1b}[?1049h").count(),
        1,
        "room must enter the fullscreen buffer once"
    );
    assert_eq!(
        output.matches("\u{1b}[?1049l").count(),
        1,
        "room must leave the fullscreen buffer once"
    );
}
/// Every wait below is `#[track_caller]` so a timeout names the exact call site
/// instead of the helper, and reports how long it actually waited against its
/// budget. `ZER0_CONPTY_TIMING=1` additionally prints each satisfied wait —
/// that is how `STEP` was derived (see its declaration).
fn report_wait(site: &'static std::panic::Location<'static>, started: Instant) {
    if std::env::var_os("ZER0_CONPTY_TIMING").is_some() {
        eprintln!(
            "[conpty timing] {}:{} satisfied in {}ms",
            site.file(),
            site.line(),
            started.elapsed().as_millis()
        );
    }
}

#[track_caller]
fn wait_screen(
    terminal: &(Arc<Mutex<Terminal>>, Arc<AtomicUsize>, Arc<Mutex<Vec<u8>>>),
    timeout: Duration,
    predicate: impl Fn(&str) -> bool,
) -> Result<()> {
    let site = std::panic::Location::caller();
    let started = Instant::now();
    let deadline = started + timeout;
    loop {
        let s = screen(&terminal.0);
        if predicate(&s) {
            report_wait(site, started);
            return Ok(());
        }
        if Instant::now() >= deadline {
            anyhow::bail!(
                "screen predicate at {}:{} timed out after {:?} (budget {timeout:?}) \
                 and {} PTY bytes; last screen:\n{s}",
                site.file(),
                site.line(),
                started.elapsed(),
                terminal.1.load(Ordering::Acquire)
            );
        }
        thread::sleep(Duration::from_millis(20));
    }
}
/// Wait until the PTY has emitted more than `floor` bytes.
///
/// The mirror of [`wait_quiet`], for a surface that is supposed to keep
/// painting. Condition-based like its twin: it waits for a STATE and fails by
/// timeout, so a loaded machine makes it slower rather than wrong.
#[track_caller]
fn wait_bytes_beyond(bytes: &Arc<AtomicUsize>, floor: usize, timeout: Duration) -> Result<usize> {
    let site = std::panic::Location::caller();
    let started = Instant::now();
    let deadline = started + timeout;
    loop {
        let current = bytes.load(Ordering::Acquire);
        if current > floor {
            report_wait(site, started);
            return Ok(current);
        }
        if Instant::now() >= deadline {
            anyhow::bail!(
                "PTY output at {}:{} never moved past {floor} bytes within {timeout:?}",
                site.file(),
                site.line()
            );
        }
        thread::sleep(Duration::from_millis(20));
    }
}
#[track_caller]
fn wait_quiet(bytes: &Arc<AtomicUsize>, quiet_for: Duration, timeout: Duration) -> Result<usize> {
    let site = std::panic::Location::caller();
    let started = Instant::now();
    let deadline = started + timeout;
    let mut last = bytes.load(Ordering::Acquire);
    let mut unchanged_since = Instant::now();
    loop {
        thread::sleep(Duration::from_millis(20));
        let current = bytes.load(Ordering::Acquire);
        if current != last {
            last = current;
            unchanged_since = Instant::now();
        } else if unchanged_since.elapsed() >= quiet_for {
            report_wait(site, started);
            return Ok(current);
        }
        if Instant::now() >= deadline {
            anyhow::bail!(
                "PTY output at {}:{} did not become idle for {quiet_for:?} within {timeout:?}; \
                 last byte count {current}",
                site.file(),
                site.line()
            );
        }
    }
}
#[track_caller]
fn wait_for_output_then_quiet(
    bytes: &Arc<AtomicUsize>,
    starting_count: usize,
    quiet_for: Duration,
    timeout: Duration,
) -> Result<usize> {
    let site = std::panic::Location::caller();
    let started = Instant::now();
    let deadline = started + timeout;
    let mut last = bytes.load(Ordering::Acquire);
    let mut observed_output = last > starting_count;
    let mut unchanged_since = Instant::now();
    loop {
        thread::sleep(Duration::from_millis(20));
        let current = bytes.load(Ordering::Acquire);
        if current != last {
            observed_output |= current > starting_count;
            last = current;
            unchanged_since = Instant::now();
        } else if observed_output && unchanged_since.elapsed() >= quiet_for {
            report_wait(site, started);
            return Ok(current);
        }
        if Instant::now() >= deadline {
            anyhow::bail!(
                "PTY at {}:{} produced no completed post-resize quiet period within {timeout:?}; \
                 start {starting_count}, last {current}",
                site.file(),
                site.line()
            );
        }
    }
}
fn start_writer(
    mut writer: Box<dyn Write + Send>,
    input_rx: std::sync::mpsc::Receiver<Vec<u8>>,
    mut reply_rx: tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
) {
    thread::spawn(move || {
        loop {
            while let Ok(reply) = reply_rx.try_recv() {
                if writer
                    .write_all(&reply)
                    .and_then(|_| writer.flush())
                    .is_err()
                {
                    return;
                }
            }
            match input_rx.recv_timeout(Duration::from_millis(10)) {
                Ok(input) => {
                    if writer
                        .write_all(&input)
                        .and_then(|_| writer.flush())
                        .is_err()
                    {
                        return;
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
    });
}
fn send_raw(writer: &std::sync::mpsc::Sender<Vec<u8>>, text: &str) -> Result<()> {
    writer
        .send(text.as_bytes().to_vec())
        .context("PTY writer stopped")
}
fn send_keys(writer: &std::sync::mpsc::Sender<Vec<u8>>, text: &str) -> Result<()> {
    // portable-pty enables ConPTY's Win32 input mode and ConPTY announces it
    // with CSI ? 9001 h. A terminal must then serialize KEY_EVENT_RECORDs as
    // CSI Vk;Sc;Uc;Kd;Cs;Rc _. Raw text bypasses that terminal-side encoding.
    for unit in text.encode_utf16() {
        let (virtual_key, scan_code) = match unit {
            8 => (8, 14),
            13 => (13, 28),
            _ => (231, 0), // VK_PACKET: synthesized Unicode input
        };
        let encoded = format!("\x1b[{virtual_key};{scan_code};{unit};1;0;1_");
        writer
            .send(encoded.into_bytes())
            .context("PTY writer stopped")?;
        // Match a human terminal instead of flooding crossterm's bounded input
        // channel with an entire command in one ConPTY write.
        thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

fn submit_room_command(writer: &std::sync::mpsc::Sender<Vec<u8>>, command: &str) -> Result<()> {
    send_keys(writer, command)?;
    // ConPTY represents Escape as a byte that may prefix a terminal escape
    // sequence, so send the actual VK_ESCAPE record and leave enough time for
    // the pager's input decoder to distinguish it from the following Enter.
    thread::sleep(Duration::from_millis(80));
    writer
        .send(b"\x1b[27;1;27;1;0;1_".to_vec())
        .context("PTY writer stopped")?;
    thread::sleep(Duration::from_millis(80));
    send_keys(writer, "\r")
}

/// One real Ctrl+C **tap**: the key going down, then coming back up.
///
/// ⚠ **The key-up half was missing, and its absence was a BLOCK finding.** A
/// helper that only ever emits key-downs cannot tell a double-tap from a held
/// key, so its "second press" was indistinguishable from autorepeat — and the
/// room's confirmation was proved by an input a hand cannot produce. A real
/// console emits a `KEY_EVENT_RECORD` with `bKeyDown = FALSE` when the key
/// comes up, and crossterm turns that into `KeyEventKind::Release`
/// (`crossterm-0.28.1/src/event/sys/windows/parse.rs:285-289`). Every tap here
/// now emits both halves; [`send_ctrl_c_down`] is the hold.
/// Type a prompt and press Enter, with NO Escape in between.
///
/// [`submit_room_command`] sends VK_ESCAPE before Enter, and while any lane is
/// running that key is slice B's INTERRUPT: it cancels the room. A slice-D
/// fixture whose whole premise is a lane still running when the next prompt
/// arrives cannot use it — the first attempt did, and the host checkpoint log
/// read `RX submit / RX control cancel all / RX submit`, after which the late
/// commit was an invalid transition and the pager exited.
///
/// The escape is not needed here: it exists to dismiss a composer overlay, and
/// these prompts contain no `/` or `@` to open one.
fn submit_plain_prompt(writer: &std::sync::mpsc::Sender<Vec<u8>>, text: &str) -> Result<()> {
    send_keys(writer, text)?;
    thread::sleep(Duration::from_millis(160));
    send_keys(writer, "\r")
}

fn send_ctrl_c(writer: &std::sync::mpsc::Sender<Vec<u8>>) -> Result<()> {
    send_ctrl_c_down(writer)?;
    send_ctrl_c_up(writer)
}

/// The Ctrl+C chord going DOWN and staying down.
///
/// ConPTY reports a real Ctrl+C as VK_C / scan 46 / U+0003 with
/// LEFT_CTRL_PRESSED (0x0008); the fourth field is `Kd`, key-down. Repeating
/// this with no [`send_ctrl_c_up`] between calls is exactly what a terminal
/// delivers while the operator holds the chord — the autorepeat stream that
/// used to walk straight out of the room.
fn send_ctrl_c_down(writer: &std::sync::mpsc::Sender<Vec<u8>>) -> Result<()> {
    writer
        .send(b"\x1b[67;46;3;1;8;1_".to_vec())
        .context("PTY writer stopped")
}

/// The Ctrl+C chord coming UP: the same record with `Kd = 0`.
///
/// The `c` is released while Ctrl is still held, which is one of the two
/// orderings a hand produces; the room's release predicate deliberately accepts
/// the other one too, where the CONTROL bit is already gone.
fn send_ctrl_c_up(writer: &std::sync::mpsc::Sender<Vec<u8>>) -> Result<()> {
    writer
        .send(b"\x1b[67;46;3;0;8;1_".to_vec())
        .context("PTY writer stopped")
}
fn resize(master: &PtyMaster, terminal: &Arc<Mutex<Terminal>>, cols: u16, rows: u16) -> Result<()> {
    // A real terminal resizes its own grid before notifying the pseudoconsole.
    // Doing this in the opposite order lets the reader race post-resize bytes
    // into an emulator that still has the old dimensions, corrupting history.
    terminal.lock().unwrap().resize(cols, rows);
    master.resize(cols, rows)?;
    Ok(())
}
#[track_caller]
fn wait_file_json(path: &Path, timeout: Duration) -> Result<serde_json::Value> {
    let site = std::panic::Location::caller();
    let started = Instant::now();
    let deadline = started + timeout;
    loop {
        if let Ok(value) = fs::read_to_string(path) {
            report_wait(site, started);
            return Ok(serde_json::from_str(&value)?);
        }
        if Instant::now() >= deadline {
            anyhow::bail!(
                "PID record at {}:{} did not appear within {timeout:?}: {}",
                site.file(),
                site.line(),
                path.display()
            );
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn read_progress(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|error| format!("<unavailable: {error}>"))
}

/// Wait until the host's progress log holds `expected` at least `count` times.
///
/// ⚠ **The reason this exists, found by running the falsifier.** The log is
/// APPEND-ONLY, so a second `wait_progress_contains` for a line an earlier step
/// already produced is satisfied instantly by the OLD line. That is the
/// stale-match shape twice over in this file: once on the screen and once here.
/// It was not hypothetical -- with slice B's Ctrl+C ladder reverted, the second
/// `RX control cancel all` wait passed against the Esc's line while the room had
/// in fact exited on the keypress.
#[track_caller]
fn wait_progress_count(path: &Path, expected: &str, count: usize, timeout: Duration) -> Result<()> {
    let site = std::panic::Location::caller();
    let started = Instant::now();
    let deadline = started + timeout;
    loop {
        let progress = read_progress(path);
        if progress.matches(expected).count() >= count {
            report_wait(site, started);
            return Ok(());
        }
        if Instant::now() >= deadline {
            anyhow::bail!(
                "host progress at {}:{} recorded {expected:?} {} times, wanted {count}, within {timeout:?}:\n{progress}",
                site.file(),
                site.line(),
                progress.matches(expected).count()
            );
        }
        thread::sleep(Duration::from_millis(20));
    }
}

#[track_caller]
fn wait_progress_contains(path: &Path, expected: &str, timeout: Duration) -> Result<()> {
    let site = std::panic::Location::caller();
    let started = Instant::now();
    let deadline = started + timeout;
    loop {
        let progress = read_progress(path);
        if progress.contains(expected) {
            report_wait(site, started);
            return Ok(());
        }
        if Instant::now() >= deadline {
            anyhow::bail!(
                "host progress at {}:{} never recorded {expected:?} within {timeout:?}:\n{progress}",
                site.file(),
                site.line()
            );
        }
        thread::sleep(Duration::from_millis(20));
    }
}

#[track_caller]
fn wait_child(child: &mut PtyChild, timeout: Duration) -> Result<u32> {
    let site = std::panic::Location::caller();
    let started = Instant::now();
    let deadline = started + timeout;
    while child.is_alive() {
        if Instant::now() >= deadline {
            child.kill()?;
            anyhow::bail!(
                "PowerShell wrapper at {}:{} did not exit within {timeout:?}",
                site.file(),
                site.line()
            );
        }
        thread::sleep(Duration::from_millis(20));
    }
    report_wait(site, started);
    child.wait()
}
fn assert_signaled(pid: u32) -> Result<()> {
    unsafe {
        let handle = match OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
            Ok(handle) => handle,
            // Windows reports an already-reaped PID as ERROR_INVALID_PARAMETER.
            Err(error) if error.code().0 as u32 == 0x8007_0057 => return Ok(()),
            Err(error) => return Err(error).context("open exact owned process"),
        };
        let result = WaitForSingleObject(handle, 1_000);
        let _ = CloseHandle(handle);
        if result != WAIT_OBJECT_0 {
            anyhow::bail!("owned process {pid} survived shutdown");
        }
        Ok(())
    }
}

/// Slice D's pill on a real terminal: `↑ codex answered` plus §D.6's suffix.
/// Spelled here rather than imported from the pager, for the same reason the
/// card constants above are: this test proves what reaches a console.
const PILL_CODEX: &str = "↑ codex answered · ctrl+t to jump · end for latest";
/// The D.5 back-reference's opening. The timestamp that follows is the source
/// prompt's own, which this fixture does not fix, so the row is matched by its
/// stable prefix.
const BACK_REFERENCE: &str = "answering your";
const SLOW_PROMPT: &str = "SLOW_TURN take your time";
const WAKE_PROMPT: &str = "WAKE_SLOW never mind look at this";
const SLOW_ANSWER: &str = "SLOW_ANSWER_LANDED";

/// Ctrl+T going down: VK_T (0x54), scan 20, U+0014, key-down, LEFT_CTRL.
///
/// Same ConPTY win32-input encoding as [`send_ctrl_c_down`] — Vk;Sc;Uc;Kd;Cs;Rc
/// — because slice D's chord has to arrive the way a hand produces it, not as
/// a raw control byte the pager would decode down a different path.
fn send_ctrl_t(writer: &std::sync::mpsc::Sender<Vec<u8>>) -> Result<()> {
    writer
        .send(b"\x1b[84;20;20;1;8;1_".to_vec())
        .context("PTY writer stopped")
}

/// A real VK_END key record: slice D binds it to "back to the bottom" while
/// the composer is empty. `Uc` is 0 because a navigation key carries no
/// character, matching [`send_page_up`].
fn send_end(writer: &std::sync::mpsc::Sender<Vec<u8>>) -> Result<()> {
    writer
        .send(b"\x1b[35;79;0;1;0;1_".to_vec())
        .context("PTY writer stopped")
}

/// [FALSIFIER] Slice D proof site 20 — the whole feature on a real Windows
/// console: a cross-turn late answer relocates to the tail with its
/// back-reference, the pill appears while the operator is scrolled away, the
/// viewport does not yank, `Ctrl+T` lands on the answer, and the pill clears.
///
/// Every assertion here is on the REAL SCREEN of a real `m0irai.exe` talking
/// to a real Node host over ConPTY. Nothing in this test can be satisfied by
/// the pager's own view of itself.
///
/// What a weaker assertion would let pass: asserting only that
/// `SLOW_ANSWER_LANDED` appears somewhere is satisfied by the answer staying
/// where it was drawn, which is the FL-090 defect itself. The answer is
/// required to be strictly BELOW the later prompt's row, which no lane row can
/// reach without relocation. And asserting the pill without first proving the
/// operator is scrolled away would pass on a room where everything is on
/// screen and the pill is meaningless.
#[tokio::test(flavor = "current_thread")]
async fn a_cross_turn_late_answer_lands_at_the_tail_on_a_real_terminal() -> Result<()> {
    let _session = conpty_session_lock();
    let root = tempfile::Builder::new()
        .prefix("zer0-v2-conpty-d-")
        .tempdir()?;
    let binary = binary_under_test()?;
    let binary_name = binary.file_name().context("binary name")?;
    fs::copy(&binary, root.path().join(binary_name))?;
    fs::write(root.path().join("zer0-v2-host.mjs"), HOST)?;
    fs::write(
        root.path().join("run.ps1"),
        "& (Join-Path $PSScriptRoot 'm0irai.exe')\nexit $LASTEXITCODE\n",
    )?;
    let pid_file = root.path().join("owned-pids.json");
    let progress_file = root.path().join("host-progress.log");
    let mut env = HashMap::new();
    env.insert("ZER0_TEST_PIDS".into(), pid_file.display().to_string());
    env.insert(
        "ZER0_TEST_PROGRESS".into(),
        progress_file.display().to_string(),
    );
    let config = PtyConfig {
        command: vec![
            "powershell.exe".into(),
            "-NoLogo".into(),
            "-NoProfile".into(),
            "-ExecutionPolicy".into(),
            "Bypass".into(),
            "-Command".into(),
            "./run.ps1".into(),
        ],
        cols: 120,
        rows: 40,
        cwd: Some(root.path().to_path_buf()),
        env,
    };
    let (_master, child, reader, writer) = PtyHandle::spawn(&config)?.into_parts();
    let mut pty_cleanup = PtyCleanup { child: Some(child) };
    let (input_tx, input_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let (reply_tx, reply_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    let terminal = start_terminal(reader, 120, 40, SessionListener::new(reply_tx));
    start_writer(writer, input_rx, reply_rx);

    if let Err(error) = wait_screen(&terminal, BOOT, |screen| {
        screen.contains(ROOM_HEADER) && screen.contains("type to start")
    }) {
        return Err(error.context(format!(
            "host progress checkpoints:\n{}",
            read_progress(&progress_file)
        )));
    }

    // Turn 1: one lane starts and does NOT answer.
    submit_plain_prompt(&input_tx, SLOW_PROMPT)?;
    wait_screen(&terminal, STEP, |screen| screen.contains(HINT_INTERRUPT))
        .context("the slow lane must be running")?;
    let before_answer = screen(&terminal.0);
    assert!(
        !before_answer.contains(SLOW_ANSWER),
        "the slow lane has not answered yet: {before_answer}"
    );

    // Turn 2: the operator moves on. Its own lane answers immediately with 40
    // paragraphs, which is what gives the feed something to scroll through.
    submit_plain_prompt(&input_tx, WAKE_PROMPT)?;
    wait_screen(&terminal, STEP, |screen| screen.contains("wake line 40"))
        .context("turn 2's own answer must land")?;

    // The operator scrolls up to read. Two page-ups is 24 rows on a 40-row
    // terminal, so they end up inside turn 2's answer with content below.
    send_page_up(&input_tx)?;
    send_page_up(&input_tx)?;
    wait_screen(&terminal, STEP, |screen| {
        !screen.contains("wake line 40") && screen.contains("wake line ")
    })
    .context("the operator must end up scrolled away from the bottom")?;
    let scrolled = screen(&terminal.0);
    let anchor_row = scrolled
        .lines()
        .find(|line| line.contains("wake line "))
        .map(str::to_owned)
        .context("a wake line must be on the scrolled screen")?;

    // The slow answer lands, 900 ms after turn 2 was accepted.
    //
    // ⚠ **Waited for on the HOST's own checkpoint, not on the pill.** Both
    // answers here are codex, so the pill reads `↑ codex answered` for turn 2's
    // top-clipped answer ALONE, before the late commit exists — and under load
    // that is exactly what happened in the full `--workspace` run: the walk ran
    // against one unseen answer, the press count came out wrong, and the
    // failure named Ctrl+T for a race in the fixture. A commit is an event, so
    // it is waited for as one.
    wait_progress_contains(&progress_file, "TX late commit", STEP)
        .context("the host must actually emit the late commit")?;
    wait_screen(&terminal, STEP, |screen| screen.contains(PILL_CODEX))
        .context("the unseen-answer pill must appear on the guidance row")?;
    let with_pill = screen(&terminal.0);

    // 1. NO VIEWPORT YANK. The row the operator was reading is still there.
    assert!(
        with_pill.contains(anchor_row.trim()),
        "the viewport must not follow the relocation: was reading {anchor_row:?}, \
         screen is now:\n{with_pill}"
    );
    assert!(
        !with_pill.contains(SLOW_ANSWER),
        "and the answer itself is still off screen, which is why the pill is up:\n{with_pill}"
    );

    // 2. Ctrl+T WALKS to it, top to bottom.
    //
    // TWO answers are unseen here, not one, and that is the room being right
    // rather than the fixture being sloppy: turn 2's own answer is 40
    // paragraphs tall, so following the feed to its bottom left its first row
    // above the top edge — top-clipped, therefore unread (§D.6's threshold).
    // Both are codex, which is why the pill reads `↑ codex answered` and not
    // `↑ 2 agents answered`: it counts AGENTS. So the first press lands on
    // turn 2's answer, the second on the relocated one, and the walk itself is
    // proven on a real console. The first attempt at this test asserted one
    // press and reported the room's correct behaviour as a failure.
    let mut presses = 0;
    loop {
        presses += 1;
        send_ctrl_t(&input_tx)?;
        if wait_screen(&terminal, STEP, |screen| screen.contains(SLOW_ANSWER)).is_ok() {
            break;
        }
        if presses >= 4 {
            return Err(anyhow::anyhow!(
                "Ctrl+T never reached the relocated answer in {presses} presses.                  host checkpoints:
{}
full terminal text:
{}",
                read_progress(&progress_file),
                full_terminal_text(&terminal.0)
            ));
        }
    }
    assert_eq!(
        presses, 2,
        "the walk is exactly two presses: turn 2's top-clipped answer, then          the relocated one"
    );
    let jumped = screen(&terminal.0);

    // 3. The back-reference is on the real screen, above the answer.
    assert!(
        jumped.contains(BACK_REFERENCE),
        "the relocated answer carries its D.5 back-reference:\n{jumped}"
    );
    assert!(
        row_below_row(&jumped, BACK_REFERENCE, SLOW_ANSWER),
        "and the reference sits ABOVE the answer it belongs to:\n{jumped}"
    );

    // 4. The pill clears once its answer's first row is on screen.
    wait_screen(&terminal, STEP, |screen| !screen.contains(PILL_CODEX))
        .context("the pill must clear once the answer has been reached")?;
    let cleared = screen(&terminal.0);
    assert!(
        cleared.contains(SLOW_ANSWER),
        "cleared because it was READ, not because it vanished:\n{cleared}"
    );

    // 5. TAIL RELOCATION, read off the bottom of the feed.
    //
    // NOT by hunting for the later prompt's own row: the room runs on the
    // alternate screen, so nothing reaches the terminal's native scrollback,
    // and a prompt eighty rows above the answer is not in any text this test
    // can read. The available observable is stronger anyway — at the very
    // bottom of the feed, turn 1's answer must read AFTER the last line turn 2
    // produced, and no lane row gets there without being moved.
    //
    // The `End` this uses is slice D's own key, so the same step proves it
    // reaches a real console with an empty composer.
    send_end(&input_tx)?;
    wait_screen(&terminal, STEP, |screen| {
        screen.contains("wake line 40") && screen.contains(SLOW_ANSWER)
    })
    .context("End must return to the bottom, where both turns' tails are visible")?;
    let bottom = screen(&terminal.0);
    assert!(
        row_below_row(&bottom, "wake line 40", SLOW_ANSWER),
        "the displaced answer must close the feed, below everything turn 2 \
         wrote:\n{bottom}"
    );
    assert!(
        row_below_row(&bottom, BACK_REFERENCE, SLOW_ANSWER),
        "with its back-reference still immediately above it:\n{bottom}"
    );

    // Teardown, deliberately unasserted. Every lane here has settled, so which
    // words the quit ladder shows is slice B's subject and not this site's;
    // asserting a hint that depends on lane state would make this test fail for
    // a reason it is not about. Two taps and the child is reaped.
    send_ctrl_c(&input_tx)?;
    thread::sleep(Duration::from_millis(300));
    send_ctrl_c(&input_tx)?;
    if let Some(child) = pty_cleanup.child.as_mut() {
        let _ = wait_child(child, STEP);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// A3 (H-0 review, 2026-09-12): the two exit paths, on a real terminal, against
// the packaged layout the operator actually runs -- the executable with a
// `zer0-v2-host.mjs` beside it.
//
// Why here and not in `host_lifecycle`: the claim under test is "the cause
// reaches a human". A unit test can prove a sentence is rendered into a buffer;
// only this file can show it arriving on a terminal, with the process exiting
// on the code that goes with it.
// ---------------------------------------------------------------------------

/// The host these two proofs drive. Deliberately minimal and separate from
/// [`HOST`]: what they need is the one thing that fixture cannot do -- end while
/// the room is RUNNING -- and the operator's own prompt chooses which way.
const EXIT_HOST: &str = r#"
import fs from 'node:fs';
const sessionId = 'chat-exit'; const at = '2026-08-01T00:00:00Z';
let initialized = false, buffer = '';
// Armed AT SPAWN rather than by a prompt. Round 4 armed this with a submit, and that round trip is a
// second live path the test does not prove: it failed once in codex's r4 full run, where the
// checkpoints stopped at RX and 'TX withholding' never arrived inside the 8 s wait that normally
// costs 62 ms. The path is gone rather than waited on longer; no budget moved (round 5, item 1).
const withholdShutdown = process.env.ZER0_TEST_WITHHOLD_SHUTDOWN === '1';
const checkpoint = point => fs.appendFileSync(process.env.ZER0_TEST_PROGRESS, point + '\n');
checkpoint('START');
if (withholdShutdown) checkpoint('ARMED withholding');
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
const ok = (id, result) => out({jsonrpc:'2.0',id,result});
process.stdin.on('data', bytes => {
  buffer += bytes;
  for (;;) {
    const atNewline = buffer.indexOf('\n'); if (atNewline < 0) return;
    const request = JSON.parse(buffer.slice(0, atNewline)); buffer = buffer.slice(atNewline + 1);
    if (request.method === 'initialize') { checkpoint('RX initialize'); initialized = true; ok(request.id, {protocolVersion:1,_meta:{'zer0.room':{version:1}}}); }
    else if (request.method === 'session/new') {
      checkpoint('RX session/new');
      if (!initialized) throw new Error('initialize first');
      ok(request.id, {sessionId});
      out({jsonrpc:'2.0',method:'zer0/room/event',params:{protocol:'zer0.room',version:1,sessionId,eventSeq:'0',eventId:'ready',turnId:'bootstrap',occurredAt:at,type:'session.saved',payload:{ready:true}}});
    }
    else if (request.method === 'zer0/room/resync') { checkpoint('RX resync'); ok(request.id, {events:[]}); }
    else if (request.method === 'zer0/room/submit') {
      ok(request.id, {accepted:true});
      // Ends itself, cleanly, the way a host that has finished its own work
      // does. Nothing in the launcher has given up on it, so the exit is
      // `HostExitCause::Host` with `success: true`.
      if (request.params.text.includes('QUIT_HOST')) { checkpoint('TX self exit'); setTimeout(() => process.exit(0), 50); }
      // One invalid stdout line, then STAY ALIVE. The launcher records the
      // transport failure and, `FAILURE_REAP_GRACE` later, terminates the tree
      // itself -- a kill, with the room still on screen.
      if (request.params.text.includes('BREAK_TRANSPORT')) { checkpoint('TX invalid frame'); process.stdout.write('not-json\n'); }
    }
    // Answer NOTHING when the shutdown comes, and never go: a host that is up and silent, which is
    // the one shape the round-3 sentence was written for and the one shape nobody had driven through
    // the packaged binary.
    else if (request.method === 'zer0/room/shutdown' && withholdShutdown) { checkpoint('RX shutdown, withheld'); }
    else { ok(request.id, {}); }
  }
});
setInterval(() => {}, 1000);
"#;

/// The window width for these two proofs, and wider than the 120 the rest of
/// this file uses ON PURPOSE.
///
/// What they assert on is the launcher's SENTENCE, printed in cooked mode after
/// the pager restores the terminal. At 120 columns ConPTY hard-wraps that line
/// at whatever character lands on the boundary -- measured on the first run: it
/// fell between "had" and "failed", and rejoining the rows either swallows that
/// space or invents one somewhere else. Either way the assertion would be
/// testing ConPTY's wrap point rather than the message. The room's own
/// 120-column budget is a different contract and is pinned where it belongs, in
/// `xai-grok-pager`'s `a_host_exit_reaches_the_failure_row_whole` and
/// `host_shutdown`'s `every_termination_sentence_fits_the_room_banner_row`.
const PROBE_COLUMNS: u16 = 200;

/// The executable under test.
///
/// `ZER0_CONPTY_EXE` points this at a SPECIFIC binary -- the release-dist
/// artifact `npm run verify:rust` produces -- instead of the debug build cargo
/// makes for its own test run. A proof that has only ever run against a debug
/// profile is a proof about a build nobody installs.
fn binary_under_test() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("ZER0_CONPTY_EXE") {
        let path = PathBuf::from(path);
        anyhow::ensure!(
            path.is_file(),
            "ZER0_CONPTY_EXE names {} and there is no file there",
            path.display()
        );
        return Ok(path);
    }
    Ok(PathBuf::from(
        option_env!("CARGO_BIN_EXE_m0irai")
            .context("Cargo must expose the real m0irai executable")?,
    ))
}

/// One packaged room on a real pseudoconsole, booted to its first frame.
/// The three handles [`start_terminal`] hands back: the parsed terminal, the
/// running PTY byte count, and the raw byte log.
///
/// Named because clippy's complex-type lint fires on it otherwise, and this
/// round is not allowed to add a warning. The two older sites that carry the
/// same tuple spelled out — `start_terminal`'s return and `wait_screen`'s
/// parameter — are deliberately left alone; they are not this round's files.
type TerminalHandles = (Arc<Mutex<Terminal>>, Arc<AtomicUsize>, Arc<Mutex<Vec<u8>>>);

struct PackagedRoom {
    /// Held, not dropped: dropping the pseudoconsole closes it and takes the
    /// writer thread with it ("PTY writer stopped: sending on a closed channel").
    _master: PtyMaster,
    root: tempfile::TempDir,
    progress: PathBuf,
    terminal: TerminalHandles,
    input: std::sync::mpsc::Sender<Vec<u8>>,
    cleanup: PtyCleanup,
}

/// Stage the packaged layout -- the executable with `zer0-v2-host.mjs` beside
/// it, which is the only layout it will start in -- and wait for the room's
/// first frame.
fn boot_packaged_room() -> Result<PackagedRoom> {
    boot_packaged_room_with(&[])
}

/// The same staging, with extra environment for the fixture.
///
/// The seam that arms a fixture behaviour AT SPAWN instead of through a submit
/// round trip the test is not there to prove. A prompt has to reach the host and
/// come back before the test can go on; an environment variable is read once,
/// before the first frame, and cannot be late.
fn boot_packaged_room_with(fixture_env: &[(&str, &str)]) -> Result<PackagedRoom> {
    let root = tempfile::Builder::new()
        .prefix("zer0-v2-conpty-exit-")
        .tempdir()?;
    let binary = binary_under_test()?;
    let binary_name = binary.file_name().context("binary name")?;
    fs::copy(&binary, root.path().join(binary_name))?;
    fs::write(root.path().join("zer0-v2-host.mjs"), EXIT_HOST)?;
    fs::write(
        root.path().join("run.ps1"),
        "& (Join-Path $PSScriptRoot 'm0irai.exe')\n$code=$LASTEXITCODE\nWrite-Output \"__ZER0_EXIT:$code\"\nexit $code\n",
    )?;
    let progress = root.path().join("host-progress.log");
    let mut env = HashMap::new();
    env.insert("ZER0_TEST_PROGRESS".into(), progress.display().to_string());
    for (key, value) in fixture_env {
        env.insert((*key).into(), (*value).to_string());
    }
    let config = PtyConfig {
        command: vec![
            "powershell.exe".into(),
            "-NoLogo".into(),
            "-NoProfile".into(),
            "-ExecutionPolicy".into(),
            "Bypass".into(),
            "-Command".into(),
            "./run.ps1".into(),
        ],
        cols: PROBE_COLUMNS,
        rows: 40,
        cwd: Some(root.path().to_path_buf()),
        env,
    };
    let (master, child, reader, writer) = PtyHandle::spawn(&config)?.into_parts();
    let cleanup = PtyCleanup { child: Some(child) };
    let (input_tx, input_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let (reply_tx, reply_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    let terminal = start_terminal(reader, PROBE_COLUMNS, 40, SessionListener::new(reply_tx));
    start_writer(writer, input_rx, reply_rx);
    let room = PackagedRoom {
        _master: master,
        root,
        progress,
        terminal,
        input: input_tx,
        cleanup,
    };
    if let Err(error) = wait_screen(&room.terminal, BOOT, |screen| {
        screen.contains(ROOM_HEADER) && screen.contains("type to start")
    }) {
        return Err(error.context(format!(
            "host progress checkpoints:\n{}",
            read_progress(&room.progress)
        )));
    }
    Ok(room)
}

/// A3, clean path: a host that ends itself takes the room out at exit code 0,
/// and says so on the terminal the pager has just restored.
///
/// Before this round the same sequence gave the operator exit code 4 and "host
/// is not accepting requests": `RoomUpdate::Failed` made every host exit a
/// runtime failure, and `shutdown()` against an already-exited host answered
/// `AdmissionClosed`.
#[tokio::test(flavor = "current_thread")]
async fn a_host_that_ends_itself_closes_the_packaged_room_at_exit_zero() -> Result<()> {
    let _session = conpty_session_lock();
    let mut room = boot_packaged_room()?;
    submit_plain_prompt(&room.input, "QUIT_HOST")?;

    wait_screen(&room.terminal, BOOT, |screen| {
        screen.contains("__ZER0_EXIT:")
    })
    .with_context(|| {
        format!(
            "the room must end when its host does. Checkpoints:\n{}",
            read_progress(&room.progress)
        )
    })?;
    let final_screen = screen(&room.terminal.0);
    assert!(
        final_screen.contains("__ZER0_EXIT:0"),
        "a host that ended cleanly is not a failure of the room: {final_screen}"
    );
    assert!(
        final_screen.contains("m0irai: the room host exited normally (code 0)"),
        "the operator's terminal has to say why their room ended: {final_screen}"
    );
    if let Some(child) = room.cleanup.child.as_mut() {
        let _ = wait_child(child, STEP);
    }
    drop(room.root);
    Ok(())
}

/// A3, kill path: when m0irai terminates the host itself, the operator is told
/// WHO ended it, WHY, and the bound it gave up on.
///
/// FL-143's whole cost, in one assertion. `TerminateJobObject` hands out exit
/// code 1, the host's stderr is empty, and for three weeks the finding read as a
/// defect in the host because `room host exited: Some(1)` was the only thing any
/// surface ever said.
#[tokio::test(flavor = "current_thread")]
async fn a_launcher_kill_names_itself_on_the_operators_terminal() -> Result<()> {
    let _session = conpty_session_lock();
    let mut room = boot_packaged_room()?;
    submit_plain_prompt(&room.input, "BREAK_TRANSPORT")?;

    wait_screen(&room.terminal, BOOT, |screen| {
        screen.contains("__ZER0_EXIT:")
    })
    .with_context(|| {
        format!(
            "a transport failure must end the room. Checkpoints:\n{}",
            read_progress(&room.progress)
        )
    })?;
    let final_screen = screen(&room.terminal.0);
    // Who ended it, and why. The WAIT is a real `Instant::elapsed()` across a
    // real reap -- 257 ms against a 250 ms grace on the first run -- so the two
    // halves are asserted around it rather than a number being pinned here. The
    // sentence's exact shape, with an exact number in it, is pinned in
    // `host_shutdown`'s unit tests.
    assert!(
        final_screen.contains("m0irai ended the room host after waiting "),
        "the operator must be told that m0irai ended the host, and how long it waited: \
         {final_screen}"
    );
    assert!(
        final_screen.contains(" ms: its transport had failed and it did not exit"),
        "...and WHY it stopped waiting: {final_screen}"
    );
    assert!(
        !final_screen.contains("room host exited: Some(1)"),
        "the pre-FL-143 sentence, which a killed host and a crashed host share, must be gone: \
         {final_screen}"
    );
    if let Some(child) = room.cleanup.child.as_mut() {
        let _ = wait_child(child, STEP);
    }
    drop(room.root);
    Ok(())
}

/// CX2: a kill on the ORDINARY quit path reaches the operator.
///
/// The path the H-0 r2 cross-check drove on this same binary and got
/// `__ZER0_EXIT:0` and nothing else from: two Ctrl+C presses against a host
/// that answers the shutdown and then will not go. `shutdown()` returns `Ok`
/// because the kill and the reap both worked, `pager_room` has already aborted
/// the task that would have banner-ed it, and the `tracing::warn!` in the reap
/// has no subscriber in the shipped path — so every surface was silent while
/// m0irai terminated the operator's host.
///
/// The packaged host needs no special mode for this: it has no stdin-EOF exit
/// and no exit path other than the `QUIT_HOST` prompt, so it acknowledges the
/// shutdown and stays alive, which is exactly the host that has to be killed.
#[tokio::test(flavor = "current_thread")]
async fn a_kill_during_an_ordinary_quit_reaches_the_operators_terminal() -> Result<()> {
    let _session = conpty_session_lock();
    let mut room = boot_packaged_room()?;

    // The operator's own quit: arm, then confirm.
    send_ctrl_c(&room.input)?;
    thread::sleep(Duration::from_millis(400));
    send_ctrl_c(&room.input)?;

    // Longer than STEP on purpose and not a budget for anything: the launcher
    // waits its whole graceful reap before killing, so this wait is the product
    // working as designed rather than a latency contract.
    wait_screen(&room.terminal, BOOT, |screen| {
        screen.contains("__ZER0_EXIT:")
    })
    .with_context(|| {
        format!(
            "the quit must end the process. Checkpoints:\n{}",
            read_progress(&room.progress)
        )
    })?;
    let final_screen = screen(&room.terminal.0);
    assert!(
        final_screen.contains("m0irai ended the room host after waiting "),
        "a quit in which m0irai killed the host must say so, not just end: {final_screen}"
    );
    assert!(
        final_screen.contains(" ms: it answered the shutdown and did not exit"),
        "...and say why it stopped waiting. This host DOES acknowledge, so the sentence has to \
         say that rather than claiming nothing came back (CX3): {final_screen}"
    );
    assert!(
        !final_screen.contains("__ZER0_EXIT:0"),
        "a quit that had to terminate the host is not a clean exit: {final_screen}"
    );
    if let Some(child) = room.cleanup.child.as_mut() {
        let _ = wait_child(child, STEP);
    }
    drop(room.root);
    Ok(())
}

/// Round 4, item 2: a host that NEVER ANSWERS the shutdown is killed, and the
/// operator is told that no acknowledgement came back.
///
/// The one shape round 3's sentence was written for and the one shape nobody had
/// driven through the packaged binary. Codex found it and the reviewer confirmed
/// it: `shutdown()` handed back the acknowledgement's `RequestTimedOut`, `?` at
/// `cli.rs` propagated it before the reporting block could run, and the operator
/// read `m0irai: host request timed out: zer0-shutdown-5` — the generic
/// diagnosis FL-143 spent three weeks behind, on the path where the launcher
/// had in fact terminated their host.
///
/// Exit 4 was always right; what it said was not.
#[tokio::test(flavor = "current_thread")]
async fn a_host_that_never_answers_is_killed_and_the_operator_is_told_so() -> Result<()> {
    let _session = conpty_session_lock();
    // Armed before the first frame: the fixture reads this and answers nothing when
    // the shutdown arrives, so nothing this test proves depends on a submit round trip
    // completing first (round 5, item 1).
    let mut room = boot_packaged_room_with(&[("ZER0_TEST_WITHHOLD_SHUTDOWN", "1")])?;
    send_ctrl_c(&room.input)?;
    thread::sleep(Duration::from_millis(400));
    send_ctrl_c(&room.input)?;

    wait_screen(&room.terminal, BOOT, |screen| {
        screen.contains("__ZER0_EXIT:")
    })
    .with_context(|| {
        format!(
            "a host that answers nothing must still be reaped inside the ceiling. Checkpoints:\n{}",
            read_progress(&room.progress)
        )
    })?;
    let final_screen = screen(&room.terminal.0);
    assert!(
        final_screen.contains("m0irai ended the room host after waiting "),
        "the operator must be told m0irai ended the host, not that a request timed out: {final_screen}"
    );
    assert!(
        final_screen.contains(" ms: no acknowledgement came back from it"),
        "...and that nothing came back, because nothing did. This fixture never answers, so a \
         sentence claiming it answered would be CX3 all over again: {final_screen}"
    );
    assert!(
        !final_screen.contains("host request timed out"),
        "the generic request-timeout sentence belongs to requests that are not the shutdown: \
         {final_screen}"
    );
    assert!(
        !final_screen.contains("__ZER0_EXIT:0"),
        "a quit that had to terminate the host is not a clean exit: {final_screen}"
    );
    if let Some(child) = room.cleanup.child.as_mut() {
        let _ = wait_child(child, STEP);
    }
    drop(room.root);
    Ok(())
}
