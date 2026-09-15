//! The launcher's shutdown policy: how long it waits for the room host to exit on its own, and what
//! it records about the death when it stops waiting and terminates the process tree itself.
//!
//! Extracted from `host_process`, which owns the state machine, because these are the numbers a
//! reader has to be able to CHECK. A bound with no derivation beside it is a guess that nobody can
//! tell apart from a measurement, and FL-143 is what that costs: a one-second guess killed a host
//! that was quitting normally, and `TerminateJobObject` then handed the operator exit code 1 and an
//! empty stderr, which reads exactly like a host that crashed. It failed 8 times out of 8 with the
//! box at 100 % CPU and 1 of 4 with it at 31–56 % (H-0, 2026-09-07), which is how a wrong constant
//! spends three weeks looking like an intermittent host defect.

use std::time::Duration;

use crate::host_process::HostError;

/// How long the host gets to ACKNOWLEDGE `zer0/room/shutdown`.
///
/// 250 ms, and it FELL from five seconds. The five was the Node room's four-second close deadline
/// plus a second, because the host used to run its whole close BEFORE answering — the response meant
/// "closed". That made this the launcher's largest budget, and `shutdown()` clamps the graceful wait
/// for the EXIT to whatever is left of `SHUTDOWN_TOTAL_BOUND` once the response has arrived, so a
/// response that spent its budget spent the exit's budget with it. Measured: a 4,100 ms response left
/// the launcher 2,400 ms, and it terminated a host that went on to exit normally at 6,900 ms (H-0 r2
/// cross-check, 2026-09-12). The phase boundary moved rather than the ceiling — the host now
/// acknowledges first and closes after (`src/room/zer0-v2-host.ts`, the `zer0/room/shutdown` arm), so
/// this bound covers one round trip against a handler with nothing left to do, and the close, which
/// is the part that costs time, is waited out by `SHUTDOWN_GRACEFUL_REAP_BOUND` where it belongs.
///
/// Derived rather than chosen, and bounded from BOTH sides. `ACKNOWLEDGEMENT_US` below — ten
/// acknowledgements measured against the real host on this box at 100 % CPU — gives 2 x the
/// nearest-rank p95 = 32 ms, and 250 ms is 15.6x the slowest sample and 7.8x that derivation. Above,
/// `the_graceful_reap_keeps_its_whole_derivation_under_the_ceiling` fails if this rises past 312 ms,
/// because past that the clamp starts cutting the reap below the host's slowest measured exit again.
/// The 62 ms between the two is slack for the lock acquisitions `shutdown()` makes around the
/// response.
/// Treat it as a LIVENESS HINT, not a budget anything may depend on: the acknowledgement goes
/// missing under saturation — two of ten repetitions against the real host on this box
/// (2026-09-13), about one in five on the reviewer's instant mock — so every branch here waits on
/// the EXIT, and reads a missing answer as no news rather than as a verdict.
pub const SHUTDOWN_RESPONSE_BOUND: Duration = Duration::from_millis(250);

/// How long the host gets to EXIT once it has answered, before the launcher terminates the tree.
///
/// 6.2 s, and it is measured rather than chosen: twice the 95th percentile of the host's real
/// post-response exit latency under load (`LOADED_EXIT_LATENCY_MS`), rounded up to the next 100 ms.
/// `the_graceful_reap_bound_covers_twice_the_loaded_p95` recomputes that derivation from the samples,
/// so lowering this literal fails a test instead of quietly restoring FL-143.
///
/// FL-143 had it at one second — above every quiet sample and below every loaded one. That is the
/// whole of the "coin flip": idle, the host exited in 334–772 ms and the launcher waited; loaded, it
/// took 1,140–3,094 ms and the launcher killed a healthy process every time.
pub const SHUTDOWN_GRACEFUL_REAP_BOUND: Duration = Duration::from_millis(6_200);

/// The ceiling on the whole of `shutdown()`, acknowledgement and reap together, and it still fires:
/// `shutdown()` clamps the graceful wait to what is left of this, so a slow acknowledgement eats the
/// reap rather than extending the operator's quit.
///
/// SEVEN SECONDS, unchanged through three rounds, and the gap under it is now CLOSED. It was a known
/// gap for two of them: a 5 s response plus a 6.2 s reap plus the kill reserve does not fit in 7 s,
/// and raising a ceiling to make a bound fit is the move this project does not make. Round 2 reported
/// the gap and pinned it; the H-0 r2 cross-check then showed it was not latent — the launcher's own
/// 5 s response budget existed precisely to tolerate the Node room's 4 s close, and a response that
/// took 4 s left the reap 2.4 s, below the host's slowest measured exit, so a healthy host was killed.
/// Round 3 closed it by moving the phase boundary instead of the ceiling: the host acknowledges in
/// milliseconds and closes afterwards, `SHUTDOWN_RESPONSE_BOUND` fell from 5 s to 250 ms, and
/// 250 + 6,200 + 500 = 6,950 ms now fits under this with 50 ms to spare.
/// `the_graceful_reap_keeps_its_whole_derivation_under_the_ceiling` is what holds that, and it fails
/// the moment any of the three grows back into the others.
pub const SHUTDOWN_TOTAL_BOUND: Duration = Duration::from_secs(7);

/// What `shutdown()` holds back from `SHUTDOWN_TOTAL_BOUND` so that a terminate it is forced to issue
/// can still be observed inside the ceiling.
///
/// Without it the graceful wait would consume the entire budget and the reap after `kill_all()` would
/// be handed `Duration::ZERO`: the forced path would return
/// `HostError::Stopped("timed out waiting for host reaping")` even though the kill worked, which is
/// the ceiling firing on the launcher's own action.
///
/// 500 ms, and the measurement behind it is PASSIVE. The first sizing came from ten forced kills run
/// beside a busy-loop load generator, which this project has since banned outright, so those figures
/// are withdrawn. The H-0 r2 reviewer re-measured the same quantity without generating any load, by
/// making the wedged-host test print its own numbers on the box as it was: the post-kill reap took at
/// most 20.1, 8.0 and 18.2 ms across three runs. Those are upper bounds — the arithmetic behind them
/// also contains the response and the writer close — so the true reap is smaller still.
/// `TerminateJobObject` is synchronous and the monitor's `child.wait()` resolves straight after it.
/// Half a second is 25x to 60x that, so the reserve is slack even on a box much slower than this one,
/// while still leaving the graceful wait its whole derivation.
pub const KILL_REAP_RESERVE: Duration = Duration::from_millis(500);

/// How long a host whose transport has ALREADY failed gets to exit before the tree is terminated.
///
/// Deliberately short and deliberately not derived from the shutdown measurement: the room is gone
/// either way, this is the teardown path rather than the operator's quit, and nothing downstream is
/// waiting on a clean exit code.
pub const FAILURE_REAP_GRACE: Duration = Duration::from_millis(250);

/// What the real Node room host takes to exit AFTER it has answered `zer0/room/shutdown`, in
/// milliseconds, ascending.
///
/// Measured 2026-09-07 on this project's reference box (12 logical cores, Windows 11 Pro 26200,
/// Node v24.18.0, `dist/src/room/zer0-v2-host.js` from `npm run build`) with the launcher's terminate
/// disabled so the process was allowed to finish: ten `start_room(New)` + `shutdown()` cycles with
/// the box held at 100 % CPU by ten busy spinners. The same ten cycles on the same box at 33–71 % CPU
/// gave 334, 358, 396, 406, 421, 424, 443, 574, 760, 772 — every one under a second, which is why
/// FL-143 read as an intermittent host bug rather than as a wrong constant.
///
/// Re-measure before changing this. Editing a sample to make a bound fit inverts the derivation.
const LOADED_EXIT_LATENCY_MS: [u64; 10] = [
    1_140, 1_160, 1_292, 1_330, 1_340, 1_654, 1_833, 2_106, 2_369, 3_094,
];

/// What the real Node room host takes to ACKNOWLEDGE `zer0/room/shutdown`, in MICROSECONDS,
/// ascending.
///
/// Measured 2026-09-13 on this project's reference box with the box at 100 % CPU and nothing added to
/// it: ten sequential rooms, each one a real `dist/src/room/zer0-v2-host.js` spawned the way
/// `spawn_host_command` spawns it, driven through the launcher's own handshake, timed from the write
/// of the shutdown request to the arrival of its response. Microseconds because the answer is smaller
/// than a millisecond nine times out of ten — which is the whole point of the acknowledge-first
/// protocol, and is what let `SHUTDOWN_RESPONSE_BOUND` fall by a factor of twenty.
///
/// The same ten runs measured 763–1,807 ms from that acknowledgement to the process being gone. That
/// second number is the close plus Node's teardown, and it is `SHUTDOWN_GRACEFUL_REAP_BOUND`'s
/// business, not this one's.
///
/// A second batch of ten, on the final tree of the same round and the same box at 100 % CPU, came back
/// 0.6–18.0 ms and 621.6–799.1 ms. The 18.0 ms is ABOVE the slowest sample recorded below, which is
/// what a second batch is for: the bound is 13.9x that number rather than 15.6x, and these samples
/// stay the batch they actually were instead of being edited to cover it.
///
/// Re-measure before changing this. Editing a sample to make a bound fit inverts the derivation.
const ACKNOWLEDGEMENT_US: [u64; 10] = [
    600, 800, 800, 800, 1_000, 1_100, 1_100, 1_300, 2_800, 16_000,
];

/// The margin `SHUTDOWN_RESPONSE_BOUND` has to clear: twice the measured p95 acknowledgement.
///
/// Same rule as the graceful reap's derivation, and deliberately the same rule: nearest-rank p95 of
/// an ordered sample, doubled, because one box's percentile only covers that box.
pub const fn derived_minimum_response_bound() -> Duration {
    let index = nearest_rank_index(ACKNOWLEDGEMENT_US.len(), 95);
    Duration::from_micros(2 * ACKNOWLEDGEMENT_US[index])
}

/// How long `shutdown()` waits for the host's EXIT, given how much of the ceiling has already gone.
///
/// THE CLAMP, and the subject of CX1. It holds the reserve back so a terminate the launcher is forced
/// to issue can still be observed inside the ceiling — without it the graceful wait eats the whole
/// budget and the reap after `kill_all()` is handed `Duration::ZERO`, which reports
/// `Stopped("timed out waiting for host reaping")` for a kill that worked.
///
/// It is also the expression that killed a healthy host. While the host closed BEFORE answering, a
/// 4,100 ms response left this `min` handing back 2,400 ms — under the 3,094 ms slowest exit ever
/// measured — and the launcher terminated a process that went on to exit normally at 6,900 ms. The fix
/// was not here: the host now acknowledges first, so `elapsed` is bounded by a 250 ms response budget
/// rather than by a 4 s close, and `the_graceful_reap_keeps_its_whole_derivation_under_the_ceiling`
/// fails if that ever stops being true.
///
/// Lives here rather than inline in `host_process` because it is policy, and because `host_process` is
/// at its line ratchet: growth is answered by extraction.
pub fn graceful_reap_for(elapsed: Duration) -> Duration {
    SHUTDOWN_GRACEFUL_REAP_BOUND.min(
        SHUTDOWN_TOTAL_BOUND
            .saturating_sub(elapsed)
            .saturating_sub(KILL_REAP_RESERVE),
    )
}

/// What `shutdown()` reports once it has OBSERVED the host exit inside the graceful reap.
///
/// The exit is the evidence that the close finished — that is the contract spec §8 states for this
/// lane ("the reap waits on the host's exit with a measured bound") and it is what makes the
/// acknowledgement a liveness signal rather than a verdict.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShutdownReport {
    /// The host ended itself and reported success. A successful quit, whatever became of the
    /// acknowledgement — and on a loaded box the acknowledgement really does go missing: measured
    /// 2026-09-13, two of ten repetitions lost it at 100 % CPU while the host still exited 0.
    /// Reporting that as a failure is A3's defect pointing the other way.
    Closed,
    /// The host ended ITSELF, badly. News that the acknowledgement result cannot describe, so the
    /// caller reports the exit's own sentence instead.
    HostFailed,
    /// The exit is not the host's own doing — this launcher had already terminated the tree. Round 1's
    /// decision stands: a kill that worked and was reaped inside the ceiling is not an error, and its
    /// cause reaches the operator through `HostExit` rather than through a `Result`.
    AcknowledgementStands,
}

/// Classify an observed exit into what the quit should report.
pub fn classify_shutdown_exit(exit: &HostExit) -> ShutdownReport {
    match (exit.cause, exit.success) {
        (HostExitCause::Host, true) => ShutdownReport::Closed,
        (HostExitCause::Host, false) => ShutdownReport::HostFailed,
        (HostExitCause::LauncherTerminated(_), _) => ShutdownReport::AcknowledgementStands,
    }
}

/// What a quit REPORTS, once an exit is in hand. Both of `shutdown()`'s branches ask here.
///
/// The reap branch is why this is a function rather than two matches. A host that never answered
/// leaves `acknowledgement` holding `RequestTimedOut("zer0-shutdown-N")`, and `cli::run_room`'s `?`
/// propagates that the moment `shutdown()` returns — BEFORE the block that reports the termination —
/// so the operator read `m0irai: host request timed out: zer0-shutdown-5` with exit 4 on a path where
/// m0irai had in fact terminated their host. That is FL-143's invisible kill wearing a request id,
/// found on the release-dist binary by codex (r3 R2-2) and confirmed by the reviewer (CX-2).
///
/// A shutdown's timeout is not a request error. It is the first half of the shutdown protocol and the
/// reap is the second, so on that path the EXIT speaks instead — and its own sentence already
/// separates the two cases, because `TerminationBranch::ShutdownReap` carries `acknowledged`. The
/// operator is told that m0irai ended the host and that no acknowledgement came back from it, which is
/// what the launcher knows, rather than that a request expired, which describes the wrong event.
///
/// An answer that DID come back keeps round 1's decision. There the kill reaches the operator through
/// the recorded `HostExit` rather than through a `Result`, and failing here as well would say it twice.
pub fn quit_outcome(
    exit: &HostExit,
    acknowledgement: Result<(), HostError>,
) -> Result<(), HostError> {
    let unanswered = matches!(
        exit.cause,
        HostExitCause::LauncherTerminated(LauncherTermination {
            branch: TerminationBranch::ShutdownReap {
                acknowledged: false
            },
            ..
        })
    );
    match classify_shutdown_exit(exit) {
        ShutdownReport::Closed => Ok(()),
        ShutdownReport::HostFailed => Err(HostError::Stopped(exit.to_string())),
        ShutdownReport::AcknowledgementStands if unanswered => {
            Err(HostError::Stopped(exit.to_string()))
        }
        ShutdownReport::AcknowledgementStands => acknowledgement,
    }
}

/// The margin `SHUTDOWN_GRACEFUL_REAP_BOUND` has to clear: twice the loaded p95.
///
/// p95 by the nearest-rank method over the ordered sample, doubled — the rule FL-175 fixed for a wait
/// derived from a measurement (mainline `840c05f`). Doubling is what buys headroom for a box slower
/// than the one measured; the percentile alone would only cover this box.
pub const fn derived_minimum_graceful_reap() -> Duration {
    let index = nearest_rank_index(LOADED_EXIT_LATENCY_MS.len(), 95);
    Duration::from_millis(2 * LOADED_EXIT_LATENCY_MS[index])
}

/// Zero-based index of the `percentile`-th value of an ORDERED sample of `len` values, by the
/// nearest-rank method: the 1-based rank is `ceil(percentile / 100 * len)`.
///
/// Integer arithmetic throughout, because this runs in a `const` and because a float percentile on
/// ten samples invites an off-by-one nobody can see. Callers must pass a sorted sample; the ordering
/// is pinned by `the_loaded_samples_are_ordered`.
const fn nearest_rank_index(len: usize, percentile: usize) -> usize {
    let rank = (percentile * len).div_ceil(100);
    if rank == 0 { 0 } else { rank - 1 }
}

/// What ended the host process, as the launcher can honestly tell it.
///
/// FL-143's real cost was not the kill, it was that the kill was INVISIBLE. `TerminateJobObject`
/// gives every process in the job the exit code its caller passed, which here is 1
/// (`xai-tty-utils/src/lib.rs:578` → `:646`), so a host the launcher killed and a host that died on
/// its own arrive as the same two fields — `code: Some(1), success: false` — with an empty stderr
/// either way. Three weeks of that finding read it as a defect in the host. This field says which.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostExitCause {
    /// Nothing in this launcher had given up on the host when the exit was observed, so `code` and
    /// `success` are the host's own and mean what they say.
    Host,
    /// This launcher had already stopped waiting and terminated the process tree when the exit was
    /// observed. `code` is the terminate's, not the host's, and `success` says nothing at all about
    /// whether the host was healthy.
    ///
    /// Stated as "had already stopped waiting" on purpose: the decision is recorded immediately
    /// before `kill_all()`, so a host that happened to finish in the microseconds between the
    /// decision and the terminate lands here too. That case is genuinely indistinguishable from
    /// here, and `waited` — sitting right on the bound — is what tells a reader it was that close.
    LauncherTerminated(LauncherTermination),
}

/// Which of the launcher's waits ran out, and how long it had been running when it did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LauncherTermination {
    pub branch: TerminationBranch,
    pub waited: Duration,
}

/// The launcher paths that terminate the process tree themselves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminationBranch {
    /// `shutdown()`: the host had still not exited within the graceful reap. This is the FL-143
    /// branch.
    ///
    /// `acknowledged` carries whether an answer to `zer0/room/shutdown` actually came back, because
    /// the reap runs either way and the two cases send an operator to different places. It is false
    /// both when the request went out and nothing came back, and when no request went out at all —
    /// `shutdown()` sends none before a session is open — so the sentence it selects says what the
    /// LAUNCHER knows rather than asserting something about the host. That distinction is the whole
    /// of FL-143: the old string said "it answered the shutdown" on a path where the response result
    /// was never consulted, which is an operator-facing claim the launcher could not make.
    ShutdownReap { acknowledged: bool },
    /// A transport failure was already recorded and the host had not exited within
    /// `FAILURE_REAP_GRACE`.
    TransportFailureReap,
    /// The owning `HostProcess` was dropped without a shutdown, or after one. Nothing waited:
    /// whatever is still inside the job dies with it.
    OwnerDropped,
}

/// How the host's process ended, as the launcher can honestly report it.
///
/// Lives HERE rather than in `host_process` because this is the record of a death, and the numbers
/// and the words that make it readable are all in this module; `host_process` owns the state machine
/// that produces one. Moved in this round because A6 grew its `Display` and `host_process` is already
/// 1,795 lines — growth is answered by extraction.
#[derive(Clone, Debug, PartialEq)]
pub struct HostExit {
    pub code: Option<i32>,
    pub success: bool,
    /// Whether THIS launcher had already given up waiting and terminated the tree when the exit was
    /// observed. Read it before `code`: on the terminate path `code` is `TerminateJobObject`'s and
    /// carries no information about the host at all (FL-143).
    pub cause: HostExitCause,
}

impl HostExit {
    /// The host ended ITSELF and reported success: the one exit nobody has to be told about.
    ///
    /// Both fields, and both for the same reason. `success` alone is satisfied by a host the launcher
    /// killed in the microseconds after it had already exited 0, and `cause` alone is satisfied by a
    /// host that crashed on its own. Two callers ask this question — the room, deciding whether the
    /// end is a failure, and the CLI, deciding whether the operator needs a sentence — and they must
    /// not answer it differently.
    pub fn ended_itself_cleanly(&self) -> bool {
        self.success && self.cause == HostExitCause::Host
    }
}

#[cfg(test)]
mod tests;
