//! Unit proofs for the shutdown policy: each bound against its own derivation, the clamp that holds
//! the kill's reserve back, and the verdict an observed exit produces.
//!
//! In the crate's own `#[cfg(test)]` tree and in a sibling FILE, the pattern `boot_progress/tests.rs`
//! and `digest_handoff/tests.rs` already use. Inline they were 213 of `host_shutdown.rs`'s 509 lines
//! against the 542 the round-3 brief named, so every further paragraph of policy reasoning would have
//! had to buy its space from the reasoning already there; growth is answered by extraction.

use super::*;

/// The pin contract item 2 asks for: drop the literal below its derivation and this fails.
#[test]
fn the_graceful_reap_bound_covers_twice_the_loaded_p95() {
    let derived = derived_minimum_graceful_reap();
    assert_eq!(
        derived,
        Duration::from_millis(6_188),
        "2 x the nearest-rank p95 of the recorded samples"
    );
    assert!(
        SHUTDOWN_GRACEFUL_REAP_BOUND >= derived,
        "the graceful reap bound is {SHUTDOWN_GRACEFUL_REAP_BOUND:?}, below its derivation \
         {derived:?}; re-measure the host's post-response exit latency before lowering it"
    );
}

/// Nearest-rank reads a position in a sorted sample. Unsorted input silently returns the wrong
/// percentile, so the ordering is a property of the data, not a habit of whoever typed it.
#[test]
fn the_loaded_samples_are_ordered() {
    assert!(
        LOADED_EXIT_LATENCY_MS.is_sorted(),
        "LOADED_EXIT_LATENCY_MS must be ascending: {LOADED_EXIT_LATENCY_MS:?}"
    );
    assert!(
        ACKNOWLEDGEMENT_US.is_sorted(),
        "ACKNOWLEDGEMENT_US must be ascending: {ACKNOWLEDGEMENT_US:?}"
    );
}

/// The acknowledgement bound is derived the same way the reap bound is, from its own samples.
///
/// Round 3's measurement, not an estimate: ten real shutdowns against the compiled host on this
/// box at 100 % CPU answered in 0.6-16.0 ms once the close moved behind the response.
#[test]
fn the_response_bound_covers_twice_the_measured_acknowledgement_p95() {
    let derived = derived_minimum_response_bound();
    assert_eq!(
        derived,
        Duration::from_millis(32),
        "2 x the nearest-rank p95 of the recorded acknowledgements"
    );
    assert!(
        SHUTDOWN_RESPONSE_BOUND >= derived,
        "the response bound is {SHUTDOWN_RESPONSE_BOUND:?}, below its derivation {derived:?}; a \
         bound under what an acknowledgement costs turns every loaded quit into a timeout"
    );
}

#[test]
fn nearest_rank_indexes_the_ceiling_of_the_rank() {
    // ceil(0.95 * 10) = 10 -> the tenth value, zero-based 9.
    assert_eq!(nearest_rank_index(10, 95), 9);
    // ceil(0.50 * 10) = 5 -> the fifth value, zero-based 4.
    assert_eq!(nearest_rank_index(10, 50), 4);
    assert_eq!(nearest_rank_index(10, 100), 9);
    // ceil(0.95 * 20) = 19 -> zero-based 18.
    assert_eq!(nearest_rank_index(20, 95), 18);
    // A zero rank cannot index; the smallest value is the answer.
    assert_eq!(nearest_rank_index(1, 95), 0);
    assert_eq!(nearest_rank_index(10, 0), 0);
}

/// The ceiling is a ratchet: it is never raised to fit a bound. Both waits plus the reserve must
/// fit under it, or the forced path loses the room it needs to reap its own kill.
#[test]
fn the_graceful_reap_and_its_kill_reserve_fit_under_the_total_bound() {
    assert!(
        SHUTDOWN_GRACEFUL_REAP_BOUND + KILL_REAP_RESERVE <= SHUTDOWN_TOTAL_BOUND,
        "{SHUTDOWN_GRACEFUL_REAP_BOUND:?} + {KILL_REAP_RESERVE:?} exceeds \
         {SHUTDOWN_TOTAL_BOUND:?}; extract the wait, do not raise the ceiling"
    );
}

/// The Node room's close budget is covered by the REAP now, not by the response bound.
///
/// Round 2 pinned the other side of this: the response bound had to outlast the close, because the
/// host closed before it answered. Round 3 moved that close behind the acknowledgement, so the
/// budget it can spend is waited out by the graceful reap — and that is the pin worth keeping,
/// because it is the one that fails if either half drifts. Raise `shutdownTimeoutMs` on the Node
/// side past the reap and a launcher that used to wait will start killing; lower the reap under
/// the Node budget and the same thing happens from this side.
///
/// The margin is REAL but not generous, and it is stated rather than rounded away: 6,200 ms of
/// reap against a 4,000 ms close budget leaves 2,200 ms for Node's own teardown after the close,
/// and that teardown measured 763-1,807 ms on this box at 100 % CPU (`ACKNOWLEDGEMENT_US`'s own
/// measurement recorded both intervals). A room that spends its whole close budget on a box slower
/// than this one is the case that eats it.
#[test]
fn the_graceful_reap_covers_the_node_room_close_deadline() {
    let deadline = node_room_close_deadline();
    assert_eq!(
        deadline,
        Duration::from_secs(4),
        "read out of src/room/room-host.ts, so this is the deadline the Node half really uses"
    );
    assert!(
        SHUTDOWN_GRACEFUL_REAP_BOUND > deadline,
        "src/room/room-host.ts gives the room {deadline:?} to close, and since round 3 that close \
         runs AFTER the acknowledgement — so it is {SHUTDOWN_GRACEFUL_REAP_BOUND:?} of reap that \
         has to outlast it, and the reap must also cover Node's teardown on top"
    );
    // And the bound it no longer has to outlast. If someone moves the close back in front of the
    // response, this stops being true and the arithmetic in `shutdown()` goes back to killing
    // healthy hosts.
    assert!(
        SHUTDOWN_RESPONSE_BOUND < deadline,
        "the response bound is {SHUTDOWN_RESPONSE_BOUND:?}, which is no longer smaller than the \
         room's {deadline:?} close budget; either the close moved back in front of the \
         acknowledgement or this bound grew back into it"
    );
}

/// The Node room's own cleanup deadline, READ from the TypeScript that owns it.
///
/// Reading beats copying because the failure this pin exists for arrives from the other side of
/// the language boundary: somebody raises `shutdownTimeoutMs`'s default and a Rust copy of `4`
/// goes on agreeing with itself. Same mechanism the protocol crate already uses to pin itself to
/// shared data — `zer0-room-protocol/tests/conformance.rs:23` `include_str!`s the conformance
/// manifest from four directories up.
///
/// `#[cfg(test)]` only, so the release-dist build never reads the Node tree. The path is relative to
/// THIS file, which is one directory deeper than `host_shutdown.rs` — the compiler catches a stale one
/// (`couldn't read ...`), so it cannot rot silently.
///
/// Narrow on purpose, and LOUD when it stops matching: there is no TypeScript parser here, so the
/// one thing it can honestly do is find the exact expression the comment cites and refuse to guess
/// if the shape has changed. A panic in a test is the correct outcome — somebody restructured that
/// line and a human has to look at what it means now.
fn node_room_close_deadline() -> Duration {
    const SOURCE: &str = include_str!("../../../../../src/room/room-host.ts");
    const ANCHOR: &str = "this.options.shutdownTimeoutMs ?? ";
    let (_, tail) = SOURCE.split_once(ANCHOR).unwrap_or_else(|| {
        panic!(
            "src/room/room-host.ts no longer contains `{ANCHOR}`; the response bound claims to \
             cover that default and cannot check it any more"
        )
    });
    let digits: String = tail
        .chars()
        .take_while(|character| character.is_ascii_digit() || *character == '_')
        .filter(|character| *character != '_')
        .collect();
    let millis: u64 = digits.parse().unwrap_or_else(|error| {
        panic!(
            "src/room/room-host.ts has `{ANCHOR}` followed by {digits:?}, which is not a \
             millisecond literal: {error}"
        )
    });
    Duration::from_millis(millis)
}

/// The ceiling is the one number in this module that NOTHING pinned.
///
/// Every other assertion about it is relative — `GRACEFUL + RESERVE <= TOTAL` passes for any
/// ceiling at or above 6.7 s, and `host_lifecycle`'s `elapsed <= TOTAL + allowance` passes for any
/// ceiling at all, because both sides move together. Measured on 2026-09-12: raising this literal
/// to 20 s left 48 lib tests and all 10 `host_lifecycle` tests green (A4). A ratchet nothing
/// enforces is not a ratchet, so here is the enforcement.
///
/// Both directions are wrong for different reasons. Lowering it without a measurement re-creates
/// FL-143 by squeezing the reap; raising it to make a bound fit is the move this project does not
/// make — growth is answered by extracting the wait. Either way the answer is a MEASUREMENT, and a
/// measurement that says "lower" is the only one that gets to change this line.
#[test]
fn the_total_bound_is_seven_seconds_until_a_measurement_lowers_it() {
    assert_eq!(
        SHUTDOWN_TOTAL_BOUND,
        Duration::from_secs(7),
        "the operator's quit is bounded at 7 s. Re-measure before changing it, and do not raise \
         it to make a bound fit: extract the wait instead"
    );
}

/// THE invariant the clamp has to satisfy, and the one A4's pins did not provide.
///
/// `shutdown()` computes `graceful_reap = GRACEFUL.min(TOTAL - elapsed - RESERVE)`. Round 2
/// asserted the constants against each other, which stayed green while that expression handed the
/// reap 2.4 s and the launcher terminated a host that went on to exit normally at 6.9 s. The
/// assertion that would have caught it is this one: even when the acknowledgement spends its
/// ENTIRE bound, what is left for the reap is still at least the host's slowest measured exit.
///
/// It reads as arithmetic and it is a contract between four numbers. It fails if the response
/// bound grows past 312 ms, if the reserve grows, if the ceiling falls, or if the exit-latency
/// samples say the host got slower. Every one of those is a case where the launcher would start
/// killing healthy hosts again, and every one of them is answered by measuring, not by raising the
/// ceiling.
#[test]
fn the_graceful_reap_keeps_its_whole_derivation_under_the_ceiling() {
    let worst_case_before_the_reap = SHUTDOWN_RESPONSE_BOUND;
    let left_for_the_reap = SHUTDOWN_TOTAL_BOUND
        .saturating_sub(worst_case_before_the_reap)
        .saturating_sub(KILL_REAP_RESERVE);
    assert!(
        left_for_the_reap >= derived_minimum_graceful_reap(),
        "an acknowledgement that spends its whole {SHUTDOWN_RESPONSE_BOUND:?} leaves the reap \
         {left_for_the_reap:?}, below the {:?} that twice the host's measured p95 exit needs. \
         That is FL-143's arithmetic: the launcher gives up before the host it is waiting for has \
         ever been observed to finish. Lower the response bound or re-measure the exit latency — \
         the ceiling does not move",
        derived_minimum_graceful_reap()
    );
    // The three bounds now FIT under the ceiling, which they did not for two rounds. That is the
    // KNOWN GAP on `SHUTDOWN_TOTAL_BOUND` being closed, and this is what holds it closed.
    let all_three = SHUTDOWN_RESPONSE_BOUND + SHUTDOWN_GRACEFUL_REAP_BOUND + KILL_REAP_RESERVE;
    assert!(
        all_three <= SHUTDOWN_TOTAL_BOUND,
        "{SHUTDOWN_RESPONSE_BOUND:?} + {SHUTDOWN_GRACEFUL_REAP_BOUND:?} + \
         {KILL_REAP_RESERVE:?} = {all_three:?} no longer fits under {SHUTDOWN_TOTAL_BOUND:?}. \
         Extract the wait or re-measure it; do not raise the ceiling"
    );
}

/// Round 4, item 2: a reap nothing acknowledged reports the EXIT, not the acknowledgement's timeout.
///
/// The unit pin under `host_lifecycle`'s process-level one, and it is `quit_outcome`'s return that the
/// operator reads: `cli::run_room` prints an `Err` from `shutdown()` with `?` before it reaches the
/// block that reports a termination, which is how a kill came out as `host request timed out:
/// zer0-shutdown-5` (codex r3 R2-2, reviewer CX-2).
#[test]
fn a_reap_with_no_acknowledgement_reports_the_exit_rather_than_the_request() {
    let exit = reaped_exit(false);
    let timed_out = Err(HostError::RequestTimedOut("zer0-shutdown-5".to_owned()));
    let Err(HostError::Stopped(reported)) = quit_outcome(&exit, timed_out) else {
        panic!("a kill the caller can learn about only from here has to be reported as a stop");
    };
    assert_eq!(
        reported,
        exit.to_string(),
        "the exit's own sentence is the report"
    );
    assert!(
        !reported.contains("zer0-shutdown"),
        "a request id names the wrong event on a path where m0irai ended the host: {reported}"
    );
}

/// An acknowledgement that DID come back keeps round 1's answer, because the kill already reaches the
/// operator through the recorded `HostExit`; failing here as well would tell them twice.
#[test]
fn a_reap_after_an_acknowledgement_keeps_the_answer_it_already_had() {
    assert_eq!(quit_outcome(&reaped_exit(true), Ok(())), Ok(()));
}

/// Exits the host chose itself are untouched by item 2: they are classified by their own code.
#[test]
fn an_exit_the_host_chose_is_still_judged_by_its_own_code() {
    let clean = HostExit {
        code: Some(0),
        success: true,
        cause: HostExitCause::Host,
    };
    assert_eq!(quit_outcome(&clean, Ok(())), Ok(()));
    let failed = HostExit {
        code: Some(4),
        success: false,
        cause: HostExitCause::Host,
    };
    assert_eq!(
        quit_outcome(&failed, Ok(())),
        Err(HostError::Stopped(failed.to_string()))
    );
}

/// A host the launcher terminated after the graceful reap ran out, acknowledged or not.
fn reaped_exit(acknowledged: bool) -> HostExit {
    HostExit {
        code: Some(1),
        success: false,
        cause: HostExitCause::LauncherTerminated(LauncherTermination {
            branch: TerminationBranch::ShutdownReap { acknowledged },
            waited: Duration::from_millis(6_206),
        }),
    }
}
