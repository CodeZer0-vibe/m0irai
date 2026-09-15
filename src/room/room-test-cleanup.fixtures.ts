/**
 * @file src/room/room-test-cleanup.fixtures.ts
 * @purpose FL-175: the wall-clock defect classes shared by every src/room process-spawning test.
 *   (1) `pollUntil` — one polling implementation whose default deadline has real headroom under load,
 *   replacing the ~10 near-identical `waitFor` functions this directory had grown. (2) `cleanupTestRoot`
 *   — the Windows EBUSY-on-teardown fix, a HARD-bounded retry loop, not `fs.rm`'s own retry math (see
 *   the round-2 correction below). (3) the CWD-lock fixture: a child that provably holds a directory.
 * @exports pollUntil, cleanupTestRoot, DEFAULT_POLL_TIMEOUT_MS, CLEANUP_DEADLINE_MS, lockTakenHold,
 *   shutdownPreservingFailure, LOCK_HOLDER_SRC, LOCK_HOLDER_STUCK_SRC
 * @depends node:child_process, node:fs/promises
 *
 * EVIDENCE (measured 2026-09-01 on this box, ~86-97% CPU load from other concurrent sessions — the
 * documented normal condition here, not an accident):
 *
 * DEFAULT_POLL_TIMEOUT_MS: round-2 F8 correction — none of the available numbers isolate a single poll
 * segment's own cost; every one (the dispatch brief's "13_500 ms and 16_700 ms, twice in isolation", and
 * the 4087a2f receipt's confirmed 26_323 ms for the same test) is the TOTAL test wall time at the point
 * a `waitFor` call's old 5_000 ms deadline fired, not how long that specific condition actually needed.
 * 40_000 ms is a generous per-segment ceiling sized off the largest of those; the real backstop against
 * a genuine hang either way is each affected test's own outer budget (90_000 ms for
 * room-host-carrier.test.ts, >=3.4x the receipt-confirmed 26_323 ms), which this per-call default cannot
 * exceed without the outer timeout firing first regardless.
 *
 * CLEANUP_DEADLINE_MS / CLEANUP_RETRY_INTERVAL_MS (round-2 correction — F4): the first version of this
 * helper passed `maxRetries: 30, retryDelay: 200` straight to `fs.rm`, on the assumption that caps
 * total wait near 30*200=6_000 ms. Node's own retry backoff is NOT linear (undocumented growth,
 * confirmed empirically: `maxRetries: 10, retryDelay: 200` against a lock that never clears ran past
 * 11_000 ms; `maxRetries: 30, retryDelay: 200` against the same ran past 900_000 ms — 15 minutes — never
 * exhausting before the probe's own child released the lock). That outlives vitest's 30_000 ms
 * hookTimeout, so a genuinely leaked process now surfaces as an opaque "Hook timed out in 30000ms" with
 * no path and no EBUSY, instead of the EBUSY-naming-the-directory a leak used to produce (the 4087a2f
 * receipt shows that EBUSY is exactly how a real leak surfaced before this fix existed). Replaced with a
 * hand-rolled loop that owns its own hard deadline instead of delegating to `fs.rm`'s retry math: each
 * attempt is a single un-retried `rm` (`maxRetries: 0`), spaced by a fixed interval, until
 * CLEANUP_DEADLINE_MS elapses, at which point it rethrows an error naming both the directory path and
 * the last real error (the original EBUSY). The legitimate case this exists for — a child that has
 * already been told to exit and is only holding the directory for the OS's post-exit handle-release lag
 * — was measured clearing in 612 ms end to end (child exited ~400-500 ms in).
 *
 * FL-175 round-4 nit (a) correction: round-3's raise to 5_000 ms was defended as ">=8x the 612 ms
 * legitimate case", but 612 ms is not what broke. What broke, per round3-final-1.log, was the 2_000 ms
 * deadline itself: room-host-process.test.ts's "session/list returns only marked rooms" test hit its
 * OWN 45_000 ms vitest timeout first ("Test timed out in 45000ms"), and the afterEach cleanup that then
 * ran against its still-not-fully-exited host raced an active CWD lock and exhausted at the 2_000 ms
 * mark: `cleanupTestRoot: gave up removing '...uyOBbA' after 2000 ms — last error: EBUSY`. Because the
 * deadline fired, that 2_000 ms is only a LOWER bound on what cleanup actually needed that run, not a
 * measurement of it — the true requirement was never captured, and reproducing the exact box contention
 * that produced it is not practical on demand. So 5_000 ms is stated honestly here as 2.5x the number
 * that broke (itself an unmeasured floor), not 8x a number that held; the raise is still the right
 * direction and stays well inside vitest's 30_000 ms hookTimeout. Round 4's own I1 fix independently
 * raises that same test's own RPC wait budgets from a 30_000/45_000 ms family to within 5_000 ms of its
 * outer test budget, which should make hitting this downstream path materially less likely going
 * forward — but if this deadline fires again, treat the fired value as a floor and re-measure, not as
 * evidence the multiplier claimed here.
 */
import type { ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";

export const DEFAULT_POLL_TIMEOUT_MS = 40_000;
// Exported (round-4 reviewer finding): room-host-process.test.ts's cleanup-exhaustion falsifier asserts
// its own `elapsed` against a ceiling that must move WITH this constant, never independently of it — see
// that test's own comment for the coupling this export exists to make structural, not just documented.
export const CLEANUP_DEADLINE_MS = 5_000;
const CLEANUP_RETRY_INTERVAL_MS = 150;
const DEFAULT_POLL_INTERVAL_MS = 10;

export interface PollOptions {
  /** Deadline in ms from the first check. Defaults to {@link DEFAULT_POLL_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Poll interval in ms. Defaults to 10. */
  readonly intervalMs?: number;
  /** Thrown as the Error message on timeout; a thunk so it can capture live state at throw time. */
  readonly message: string | (() => string);
}

/**
 * Polls `predicate` until it returns true or `options.timeoutMs` elapses, at which point it throws
 * `options.message`. There is no promise to await instead here by construction: every caller in this
 * directory polls a room event bus that publishes asynchronously (the journal is flushed, not written
 * inline), so the predicate is the only observable.
 */
export async function pollUntil(predicate: () => boolean, options: PollOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(typeof options.message === "string" ? options.message : options.message());
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Removes a test-owned temp root within a hard, self-owned deadline (see file header for why this does
 * not delegate to `fs.rm`'s own `maxRetries`/`retryDelay`). Safe to call on a root whose owning process
 * was already awaited to exit — the retry exists for the OS-level handle-release lag that follows exit,
 * not as a substitute for awaiting exit. On exhaustion, throws an error naming the directory and the
 * last real removal error, so a genuine leak still surfaces as a diagnosable EBUSY instead of an opaque
 * hook timeout.
 */
export async function cleanupTestRoot(root: string): Promise<void> {
  const deadline = Date.now() + CLEANUP_DEADLINE_MS;
  let lastError: unknown;
  for (;;) {
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 0 });
      return;
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, CLEANUP_RETRY_INTERVAL_MS));
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `cleanupTestRoot: gave up removing '${root}' after ${String(CLEANUP_DEADLINE_MS)} ms — last error: ${detail}`,
  );
}

/**
 * FL-175 round 4 I2: a bare `await host.shutdown()` in a `finally` lets a shutdown failure MASK an
 * already-failed try body — JS gives a finally's exception priority over the try's, so a real assertion
 * failure and a slow/failed quiesce collapse to one generic "room lanes did not terminate" message and
 * the real defect is lost. Extracted here once a third real call site needed the identical logic
 * (room-host-cancel-wiring.test.ts, room-host-bounds.test.ts x2).
 *
 * Shape corrected against a round-4 reviewer finding: the first version, when the try had already
 * failed, only LOGGED a shutdown failure to stderr and swallowed it from the thrown error — which is
 * itself a near-swallow that could hide a genuine shutdown defect happening at the same time as an
 * unrelated real failure (exactly the sites where a real quiesce failure matters most). Fixed shape:
 * when BOTH fail, this throws ONE error reporting both — the original failure's message first, the
 * shutdown failure's appended, `cause` set to the original error for its stack — never silently
 * dropped. When only the try failed (`bodyError` set, shutdown succeeds), this throws nothing and the
 * caller's own rethrow carries the original error unmodified. When only shutdown failed (`bodyError`
 * undefined), that failure is the sole real one and is thrown as-is. Reproduced live at the
 * cancel-wiring call site: injecting `shutdownTimeoutMs: 1` plus a deliberately wrong expected string
 * masked the wrong-string error entirely before this fix existed; the corrected shape surfaces both.
 */
export async function shutdownPreservingFailure(
  shutdown: () => Promise<void>,
  bodyError: unknown,
  label: string,
): Promise<void> {
  try {
    await shutdown();
  } catch (shutdownError) {
    if (bodyError === undefined) throw shutdownError;
    const bodyMessage = bodyError instanceof Error ? bodyError.message : String(bodyError);
    const shutdownMessage =
      shutdownError instanceof Error ? shutdownError.message : String(shutdownError);
    throw new Error(
      `${label}: ${bodyMessage} (shutdown() ALSO failed afterward, not thrown over it: ${shutdownMessage})`,
      { cause: bodyError instanceof Error ? bodyError : undefined },
    );
  }
}

/**
 * The two EBUSY falsifiers below need a child that HOLDS a directory as its CWD before they probe it, and
 * they used to wait a fixed 100 ms for that ("let the CWD lock actually take hold").
 *
 * That wait IS load-bearing, and this paragraph is the correction of a round-1 claim that said it was
 * not. Round 1 measured EBUSY at every settle delay from 0 to 100 ms, 64 of 64 samples, and concluded the
 * lock is always held once `spawn()` returns. The round-1 REVIEWER measured the same instant with 25
 * samples per cell and got the opposite: `rm` DELETED the fixture 17 of 25 with no wait, 4 of 25 one tick
 * later, and EBUSY 10 of 10 after the child's first byte. Both are real. Run back to back in one box
 * state 2026-09-12 (round-2 item 2), 25 fresh fixtures per cell, the option that differed between the two
 * probes (`windowsHide`) isolated:
 *
 *   reviewer's shape, no wait                EBUSY x24, DELETED x1
 *   round 1's shape, no wait                 EBUSY x25
 *   reviewer's shape + windowsHide, no wait  EBUSY x24, DELETED x1
 *   round 1's shape - windowsHide, no wait   EBUSY x25
 *   round 1's shape, after the first byte    EBUSY x25
 *
 * Cells with IDENTICAL options land on different tallies, so `windowsHide` explains nothing and neither
 * probe was wrong about its own run: whether the child's handle or the `rm` gets there first is a race,
 * and the winner depends on the state of the box. Round 1's 64/64 came from a state where the child won
 * every time; the reviewer's 17/25 from one where it usually lost. One deletion in 100 samples here is
 * enough to settle the disputed point — the lock is NOT reliably held when `spawn()` returns.
 *
 * Losing that race does not retry, it DESTROYS the fixture: the probe `rm` runs with `force: false`, so
 * with no lock it succeeds, takes the directory with it, and the assertion then fails on a lock that
 * never happened rather than on the defect it exists to catch. The child's own first byte is a sufficient
 * observable in 40 of 40 samples across both rounds and cannot lose the race in principle, so that is
 * what both falsifiers wait for.
 *
 * Whether this is what failed in the 2026-09-08 receipt's run of the recovery falsifier stays UNVERIFIED:
 * that run's log was overwritten before this lane started, and the cut sleep is a live candidate rather
 * than a finding. The other bound in the same test is not: `cleanupTestRoot`'s own deadline has 119x
 * margin on the measured release (kill to first successful rm, 1-42 ms over 15 samples, against 5_000).
 */
export const LOCK_HOLDER_SRC: string =
  'process.stdout.write("UP\\n"); setTimeout(() => {}, 30_000);';
/** The same, for the exhaustion falsifier, whose child must outlive CLEANUP_DEADLINE_MS but not the run. */
export const LOCK_HOLDER_STUCK_SRC: string =
  'process.stdout.write("UP\\n"); setTimeout(() => {}, 15_000);';
/**
 * Waits until the child has produced output, i.e. until its CWD handle is provably open.
 *
 * `budgetMs` is a HANG DETECTOR and nothing else, so it is sized the way every other wait in
 * `room-host-process.test.ts` is (see that file's own header): the calling test's outer budget minus the
 * margin it reserves for the rest of its body. It is deliberately NOT derived from how long a node start
 * takes. The measurements say why a tight bound would be wrong: a single start to first byte measured
 * 72-107 ms here, but the reviewer of round 1 watched one `tasklist` from node take 27_603 ms under its
 * own load, so any bound sized off the fast case turns a slow box into a test failure — which is the
 * defect class this whole lane exists to remove. Sized off the outer budget it can only fire when the
 * test had no time left anyway, and then it names the cause instead of leaving vitest's generic message.
 *
 * On any rejection the child is KILLED before the error propagates. Without that, a rejection left a live
 * node process holding a temp directory as its CWD and neither call site cleaned it up, so the failure
 * that was meant to be diagnostic leaked a process and an undeletable directory onto the box.
 */
export async function lockTakenHold(child: ChildProcess, budgetMs: number): Promise<void> {
  if (child.stdout === null) {
    // `stdio: "ignore"` gives no stdout to listen to, so the observable this helper waits for can never
    // arrive: the wait would burn the whole budget and then blame the child for a pipe the caller never
    // opened. Refused loudly rather than diagnosed 25 seconds later.
    child.kill();
    throw new Error(
      "lockTakenHold needs the child's stdout piped (stdio: [_, 'pipe', _]); with stdio 'ignore' there " +
        "is no first byte to wait for and this would time out blaming the child",
    );
  }
  await new Promise<void>((resolve, reject) => {
    const failWith = (error: Error): void => {
      child.kill();
      reject(error);
    };
    const timer = setTimeout(() => {
      failWith(
        new Error(
          `the lock-holding child produced no output within ${String(
            budgetMs,
          )} ms, so the CWD lock this falsifier needs was never observed to exist; child killed`,
        ),
      );
    }, budgetMs);
    child.stdout?.once("data", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      failWith(error);
    });
  });
}
