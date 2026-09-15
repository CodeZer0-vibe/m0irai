/**
 * @file src/shared/kill-tree.ts
 * @purpose Process-tree termination (EXTRACTED VERBATIM from the tower's child-spawn module 2026-07-10 so src/adapters
 *   may use it — dep-cruiser bars adapters→tower). killTree: taskkill /PID /T /F on win32, POSIX group signal + SIGKILL
 *   escalation; idempotent, a VERIFIABLY surviving root throws (MT7 I-13). killTreeVerified adds the DRAIN RECEIPT
 *   (spec §5 row 2 / E-4): the tree is enumerated BEFORE the kill (process-table.ts) and re-checked after by a probe
 *   independent of the kill's exit status; an UNACCOUNTED receipt has NO survivor list, never an empty one.
 * @exports KillResult, KillTreeOptions, killTree, DrainReceipt, KillTreeVerifiedOptions, VERIFY_DEADLINE_MS,
 *   POLL_INTERVAL_MS, KILL_TIMEOUT_MS, killTreeVerified, isDrained
 * @depends node:process, ./process-table
 */
import process from "node:process";
import {
  disownedRootError,
  disownedRootIsTheOnlyReading,
  identityMismatch,
} from "./kill-tree-identity.js";
import {
  ENUMERATE_TIMEOUT_MS,
  type RunCommand,
  descendantsOf,
  readProcessTable,
  refusedStaleChildren,
  runCommand,
} from "./process-table.js";

const WINDOWS = "win32";
const POSIX_KILL_GRACE_MS = 400;

// Every budget below is derived from a measurement quoted at its constant. Ratchets only fall: these are
// bounds on a hang, not room made for slowness, and lowering a measurement lowers the bound with it.

/**
 * Slowest forced tree-kill observed on this box: 4 runs over a live three-deep tree, 2026-09-07,
 * 610 / 700 / 1146 / 1498 ms, with every pid already reading gone at the instant the kill returned.
 *
 * Re-measured 2026-09-12 (lane `receipt-budgets`), 12 sequential drains of the same fixture shape:
 * taskkill itself 441-1_577 ms (median 587), and the post-kill RESIDUAL this figure bounds twice over —
 * from the kill's return until the last enumerated pid reads gone — was 0 ms in 11 of the 12 samples and
 * 1 ms in the twelfth. So the "already gone when the kill returned" half of the 2026-09-07 claim
 * reproduces exactly, and the receipt's own verify wait is nowhere near its ceiling. The 1_577 ms sample
 * is 79 ms past the slowest recorded above, and this constant deliberately does NOT move for it: the
 * bound it produces (2_996 ms) still clears that sample by 1.9x, so nothing honest is being cut, and a
 * ratchet does not rise to accommodate a sample its existing value already covers.
 */
const SLOWEST_FORCED_KILL_MS = 1_498;
/**
 * Ceiling on the post-kill wait: twice the slowest forced kill. A process still alive one whole
 * kill-duration after a forced tree-kill returned is a survivor, not a slow exit.
 */
export const VERIFY_DEADLINE_MS: number = 2 * SLOWEST_FORCED_KILL_MS;
/** Poll step of that wait. The measured residual was 0 ms, so this only bounds the failure path. */
export const POLL_INTERVAL_MS: number = 25;
/** Hang bound on one kill command: twice the slowest forced kill. */
export const KILL_TIMEOUT_MS: number = 2 * SLOWEST_FORCED_KILL_MS;

/** Result of one underlying kill: `ok` true on success; `code` carries the failure reason. */
export interface KillResult {
  readonly ok: boolean;
  readonly code: string | undefined;
}

/** Options for {@link killTree}; `runKill` is an injectable seam for tests. */
export interface KillTreeOptions {
  /** Override the underlying kill (default: real taskkill/process.kill). */
  readonly runKill?: (pid: number) => KillResult;
}

/**
 * Kills the entire process tree rooted at `pid`. win32: `taskkill /PID <pid> /T /F`
 * (tree + force), exit status CHECKED. POSIX: signals the process GROUP via
 * `kill(-pid)` then SIGKILL after a grace window. An already-exited target (ESRCH /
 * taskkill "not found") is swallowed (idempotent); any OTHER genuine failure is
 * SURFACED (throws) so a silent orphan never goes unnoticed.
 *
 * NOT a receipt: it proves nothing about the DESCENDANTS, and `/T` rooted at a pid that
 * has already exited is a no-op (measured: exit 128, "not found", survivors untouched).
 * Callers that must report a seat as stopped use {@link killTreeVerified}.
 *
 * @param pid - the root process id to terminate
 * @param opts - optional injectable kill seam
 */
export async function killTree(pid: number, opts?: KillTreeOptions): Promise<void> {
  const result = opts?.runKill === undefined ? await defaultKill(pid) : opts.runKill(pid);
  // taskkill /T /F (and POSIX group-kill) are BEST-EFFORT across a partially-gone
  // tree: a non-zero/failed result does NOT prove an orphan. A failure is SURFACED
  // ONLY when the root pid VERIFIABLY survives the kill (re-checked) — so reaping a
  // tree whose grandchild already died is benign (idempotent); a genuine surviving
  // orphan still throws so it is never silently leaked.
  if (!result.ok && !isAlreadyGone(result.code) && stillAlive(pid)) {
    throw new Error(
      `killTree(${pid}) failed and the process VERIFIABLY survives: ${result.code ?? "unknown"}`,
    );
  }
  if (process.platform !== WINDOWS && opts?.runKill === undefined) {
    await escalatePosix(pid);
  }
}

// True only if the pid still exists after the kill attempt. `process.kill(pid, 0)`
// sends no signal — it just probes existence: ESRCH = gone, EPERM = alive but
// not ours (still an orphan to surface), success = alive.
function stillAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function defaultKill(pid: number): Promise<KillResult> {
  if (process.platform === WINDOWS) {
    const out = await runCommand("taskkill", ["/PID", String(pid), "/T", "/F"], KILL_TIMEOUT_MS);
    if (out.ok) return { ok: true, code: undefined };
    // taskkill 128 = "process not found" (already gone); surface anything else.
    return {
      ok: false,
      code: out.code === "exit 128" ? "ESRCH" : `taskkill ${out.code ?? "unknown"}`,
    };
  }
  return killPosixGroup(pid, "SIGTERM");
}

function killPosixGroup(pid: number, signal: NodeJS.Signals): KillResult {
  try {
    process.kill(-pid, signal);
    return { ok: true, code: undefined };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return { ok: false, code: "ESRCH" };
    }
    try {
      process.kill(pid, signal); // no process group — fall back to the bare pid
      return { ok: true, code: undefined };
    } catch (inner) {
      return { ok: false, code: (inner as NodeJS.ErrnoException).code ?? "EUNKNOWN" };
    }
  }
}

function isAlreadyGone(code: string | undefined): boolean {
  return code === "ESRCH";
}

async function escalatePosix(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      killPosixGroup(pid, "SIGKILL");
      resolve();
    }, POSIX_KILL_GRACE_MS);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  });
}

// ---------- the drain receipt ----------

/**
 * What a drain actually proved.
 *
 * `accounted: true` means the process table was read and trusted: `enumerated` is the drain set (the root
 * plus every descendant found BEFORE the kill) and `survivors` are the ones still alive afterwards, by a
 * probe independent of the kill's exit status. `identityChecked` says whether the root's creation time was
 * verified against the caller's own spawn moment.
 *
 * `accounted: false` means the accounting FAILED — and then there is NO `survivors` field at all, because
 * no survivor list was ever obtained. That is deliberate: an empty list would be an answer this receipt
 * has no right to give, and the type makes reading one impossible rather than merely unwise.
 */
export type DrainReceipt =
  | {
      readonly accounted: true;
      readonly rootPid: number;
      readonly rootExited: boolean;
      readonly enumerated: readonly number[];
      readonly survivors: readonly number[];
      readonly forced: boolean;
      readonly identityChecked: boolean;
      /**
       * Whether the table this drain was checked against actually SAW the tree: it carried the root's
       * own row, or the walk found at least one descendant. An empty drain set with `witnessed: false`
       * is the one result this module cannot tell apart from a table that simply did not show the tree
       * (round-3 item 3, the second of round 2's two F1 candidates — reproduced by the reviewer with the
       * root's row present and the children's rows absent, where nothing is killed and `survivors: []`
       * is issued over a live child). It is REPORTING, not a verdict: `isDrained` is unchanged, because
       * the same shape is also exactly what a genuinely empty tree looks like on a second drain. A
       * caller that must not leak — L3's ladder — should treat `isDrained(r) && !r.witnessed` as
       * UNVERIFIED and drain again with `rootStartedAtMs`, not as proof of an empty tree.
       */
      readonly witnessed: boolean;
      /**
       * Direct children the walk REFUSED because their creation time predates this root's. Reported
       * rather than acted on: on Windows these are usually somebody else's (kernel children are
       * recorded older than `System`, and a previous holder of this pid leaves rows behind). They are
       * evidence only in the one shape `disownedRootIsTheOnlyReading` names.
       */
      readonly disowned: readonly number[];
    }
  | {
      readonly accounted: false;
      readonly rootPid: number;
      readonly rootExited: boolean;
      readonly forced: boolean;
      readonly error: string;
    };

/** Options for {@link killTreeVerified}; every field is an injectable seam or a budget. */
export interface KillTreeVerifiedOptions {
  /** Override the child-command seam (default: the real execFile runner). */
  readonly runCommand?: RunCommand;
  /** Override the liveness probe (default: `process.kill(pid, 0)`). */
  readonly isAlive?: (pid: number) => boolean;
  /** Override the platform the backend is chosen for (default: `process.platform`). */
  readonly platform?: NodeJS.Platform;
  /** Override the post-kill wait ceiling (default: {@link VERIFY_DEADLINE_MS}). */
  readonly verifyDeadlineMs?: number;
  /** Override the poll step of that wait (default: {@link POLL_INTERVAL_MS}). */
  readonly pollIntervalMs?: number;
  /** Override the per-enumeration hang bound (default: ENUMERATE_TIMEOUT_MS). */
  readonly enumerateTimeoutMs?: number;
  /**
   * `Date.now()` at the moment the CALLER spawned this root. Supply it and the root's own creation time
   * is checked against it, so a recycled pid is refused instead of drained. Omit it and no identity check
   * is possible — the receipt then reports `identityChecked: false` rather than implying one happened.
   */
  readonly rootStartedAtMs?: number;
  /** Override the POSIX per-pid kill signal (default: real `process.kill`). Never invoked on win32. */
  readonly killPosix?: (pid: number, signal: NodeJS.Signals) => void;
}

interface DrainContext {
  readonly run: RunCommand;
  readonly alive: (pid: number) => boolean;
  readonly platform: NodeJS.Platform;
  readonly deadlineMs: number;
  readonly pollMs: number;
  readonly enumerateTimeoutMs: number;
  readonly rootStartedAtMs: number | undefined;
  readonly killPosix: (pid: number, signal: NodeJS.Signals) => void;
}

/**
 * Kills the tree rooted at `pid` and returns what that actually achieved.
 *
 * The order matters: enumerate FIRST, so a launcher that exits on its own cannot take the knowledge of
 * its children with it; then kill every enumerated pid with `/T`; then re-check each of them until they
 * are gone or the deadline passes. The kill's own exit status is never the proof — a batch containing one
 * already-dead pid exits 128 while terminating all the live ones (measured 2026-09-07), so only the
 * liveness re-check decides.
 *
 * Known bounds, stated rather than hidden. (a) The receipt covers the pids enumerated before the kill; a
 * descendant created after that snapshot dies with its parent under `/T` while the parent is alive at kill
 * time, but one whose parent died inside that window is outside it. (b) A recycled DESCENDANT pid reads as
 * a survivor — the safe direction, and (since `descendantsOf` validates creation-time ordering) is refused
 * a place in the drain set at all when its own creation time predates the parent it claims. (c) A recycled
 * ROOT pid is refused when `rootStartedAtMs` is supplied. WITHOUT it, the refusal is narrow and is not a
 * general "the table contradicts itself" rule: it fires only in the one shape
 * `disownedRootIsTheOnlyReading` names — identity never verified, NO descendants found, and at least one
 * direct child recorded older than this pid. Round 2 refused on the disowned signal alone, which read
 * normal parents (Windows kernel children are recorded older) as reused pids and cost genuine drains 1
 * run in 10; round 3 narrowed it to the shape above, where an empty walk is the only other reading and
 * so nothing is lost by refusing. Outside that shape a disowned child is reported in the receipt and
 * acted on by nobody. What stays unguarded is a reused root with no rows claiming it at all:
 * indistinguishable from an empty tree from inside the table, and `rootStartedAtMs` is the answer to it.
 * (d) A root
 * already absent from the table cannot be identified at all, so its orphans are drained on the strength of
 * their parent link alone. (e) POSIX's `ps` backend never carries a creation time, on any row, so a root
 * identity check requested there is honored as unsupported — `identityChecked: false` — rather than
 * refused; Windows keeps refusing when a row's creation time comes back unreadable, since there it is the
 * exception rather than the platform's permanent shape.
 *
 * WORST CASE, for a caller sizing its own budget around this: READ_TABLE_TIMEOUT_MS for the enumeration
 * (a WHOLE read, every backend in turn — not the per-attempt `ENUMERATE_TIMEOUT_MS`) plus
 * KILL_TIMEOUT_MS for the forced kill plus VERIFY_DEADLINE_MS for the post-kill wait. At today's
 * measurements that is 72_220 + 2_996 + 2_996 = 78_212 ms. It is a ceiling on a hang, not an expectation:
 * the same drain measured 2_562 ms median end to end over 12 sequential samples on this box, because the
 * post-kill residual is ~0 ms and only one backend exists here.
 *
 * @param pid - the root process id of the tree to drain
 * @param opts - optional injectable seams, budgets and the root's spawn moment
 * @throws TypeError when `pid` is not a positive integer
 */
export async function killTreeVerified(
  pid: number,
  opts?: KillTreeVerifiedOptions,
): Promise<DrainReceipt> {
  assertDrainablePid(pid);
  const ctx = drainContext(opts);
  const table = await readProcessTable(ctx.run, ctx.platform, ctx.enumerateTimeoutMs, pid);
  if (!table.ok) return await enumerationFailureReceipt(pid, ctx, table.error);
  const rootRow = table.rows.find((row) => row.pid === pid);
  const mismatch = identityMismatch(pid, rootRow, ctx.rootStartedAtMs, ctx.platform);
  if (mismatch !== undefined) return unaccounted(pid, ctx, false, mismatch);
  // A check only RAN (identityChecked:true) when rootStartedAtMs was supplied AND a real creation time
  // was compared. Reached with nothing compared in two cases: root absent (bound (d)) and POSIX's
  // structurally-missing timestamp (bound (e), review C4) — root PRESENCE alone was too weak (review B2).
  // Past identityMismatch above, a true value means the check PASSED, which is what the guard reads.
  const identityChecked = ctx.rootStartedAtMs !== undefined && rootRow?.createdAtMs !== undefined;
  const descendants = descendantsOf(pid, table.rows);
  const disowned = refusedStaleChildren(pid, table.rows);
  if (disownedRootIsTheOnlyReading(identityChecked, descendants, disowned)) {
    return unaccounted(pid, ctx, false, disownedRootError(pid, disowned));
  }
  const enumerated = [pid, ...descendants];
  const live = enumerated.filter((target) => ctx.alive(target));
  if (live.length > 0) await killAll(live, ctx);
  const survivors = await waitForDrain(enumerated, ctx);
  return {
    accounted: true,
    disowned,
    enumerated,
    forced: live.length > 0,
    identityChecked,
    rootExited: !ctx.alive(pid),
    rootPid: pid,
    survivors,
    // See DrainReceipt. The table saw this tree if it carried the root's own row or produced a
    // descendant; a drain set of the root alone from a table that mentioned neither is the one shape
    // that cannot tell an empty tree from a tree the table did not show (round-3 item 3).
    witnessed: rootRow !== undefined || descendants.length > 0,
  };
}

// All that is reachable without a table is the root itself, and only while it is still alive: `/T` rooted
// at a pid that has already exited is a measured no-op. Once it is gone there is genuinely nothing left to
// reach, which is why this returns an UNACCOUNTED receipt naming the unknown instead of an empty tree —
// its real orphans, if any, are exactly what nobody could enumerate here.
async function enumerationFailureReceipt(
  pid: number,
  ctx: DrainContext,
  error: string,
): Promise<DrainReceipt> {
  if (ctx.rootStartedAtMs !== undefined) {
    // The caller asked for its root's identity to be verified before anything is killed, and there is no
    // table AT ALL to check it against — not merely one row's creation time (identityMismatch, which on
    // POSIX proceeds unchecked rather than refuses: bound (e)). A TOTAL enumeration failure carries no
    // information in either direction on any platform, so this refuses regardless of platform rather than
    // force a kill nobody could vouch for (review C2: enumeration failing was letting a requested check
    // through unchecked, the one path this module's identity protection did not cover).
    return unaccounted(
      pid,
      ctx,
      false,
      [
        error,
        "The caller also asked for its root's identity to be verified before any kill, and there is no",
        "table at all to check it against, so nothing was killed; refusing to kill a tree that may not be",
        "ours. Retry, or omit rootStartedAtMs to drain unchecked.",
      ].join(" "),
    );
  }
  const forced = ctx.alive(pid);
  if (forced) await killAll([pid], ctx);
  return unaccounted(pid, ctx, forced, error);
}

/**
 * The ONLY safe reading of a receipt: a drain is proven only when the tree was accounted for AND nothing
 * survived. An unaccounted receipt has no survivor list to be empty, so this cannot be fooled by one.
 */
export function isDrained(receipt: DrainReceipt): boolean {
  return receipt.accounted && receipt.survivors.length === 0;
}

// pid 0 is not a drainable target in either direction: to POSIX `kill` it means EVERY process in the
// caller's own group (the room host would kill itself) and on Windows it is the System Idle Process,
// whose children include System. A caller that reaches here with 0 has a bug, not a runtime condition.
function assertDrainablePid(pid: number): void {
  if (Number.isInteger(pid) && pid > 0) return;
  throw new TypeError(
    [
      `killTreeVerified received pid ${String(pid)};`,
      "a drain target must be a positive integer process id.",
      "Pass the child's own pid and guard `child.pid !== undefined` at the call site.",
    ].join(" "),
  );
}

function drainContext(opts: KillTreeVerifiedOptions | undefined): DrainContext {
  return {
    alive: opts?.isAlive ?? stillAlive,
    deadlineMs: opts?.verifyDeadlineMs ?? VERIFY_DEADLINE_MS,
    enumerateTimeoutMs: opts?.enumerateTimeoutMs ?? ENUMERATE_TIMEOUT_MS,
    killPosix: opts?.killPosix ?? killPosixPid,
    platform: opts?.platform ?? process.platform,
    pollMs: opts?.pollIntervalMs ?? POLL_INTERVAL_MS,
    rootStartedAtMs: opts?.rootStartedAtMs,
    run: opts?.runCommand ?? runCommand,
  };
}

function unaccounted(pid: number, ctx: DrainContext, forced: boolean, error: string): DrainReceipt {
  return { accounted: false, error, forced, rootExited: !ctx.alive(pid), rootPid: pid };
}

// One forced kill for the whole set. `/T` on every enumerated pid so a descendant spawned after the
// snapshot still dies with its (listed, still-live) parent. The exit status is deliberately unused:
// measured 2026-09-07, three /PID args of which one was already gone returned 128 with "ERROR: The
// process ... not found" on stderr while terminating all the live ones. The receipt is the proof.
async function killAll(pids: readonly number[], ctx: DrainContext): Promise<void> {
  if (ctx.platform === WINDOWS) {
    const args: string[] = [];
    for (const pid of pids) args.push("/PID", String(pid));
    args.push("/T", "/F");
    await ctx.run("taskkill", args, KILL_TIMEOUT_MS);
    return;
  }
  // SIGKILL, not SIGTERM: this is the forced half of the ladder, the peer of taskkill's /F. The graceful
  // close happened before the caller escalated here. Goes through ctx.killPosix, never a bare process.kill
  // — the same injectable-seam discipline the Windows branch above already has through ctx.run, so a
  // seam-injected test can never reach a real signal on this fixed pid (review C3, reproduced: on a
  // non-Windows host this branch called process.kill directly, with nothing to intercept it).
  for (const pid of pids) ctx.killPosix(pid, "SIGKILL");
}

/** Default POSIX kill: the real signal, used only when the caller supplies no {@link killPosix} seam. */
function killPosixPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Swallowed BY DESIGN — ESRCH means already gone and EPERM means not ours, and both are answered by
    // the liveness verification below. A kill's own outcome is never this module's proof.
  }
}

// Polls to a deadline instead of sleeping a fixed span: the wait ends the moment the last pid reports
// gone, so the happy path costs one probe.
async function waitForDrain(pids: readonly number[], ctx: DrainContext): Promise<number[]> {
  const expiresAt = Date.now() + ctx.deadlineMs;
  let survivors = pids.filter((pid) => ctx.alive(pid));
  while (survivors.length > 0 && Date.now() < expiresAt) {
    await sleep(ctx.pollMs);
    survivors = survivors.filter((pid) => ctx.alive(pid));
  }
  return survivors;
}

// The poll timer is REF'd on purpose. It was unref'd once, and a drain with a surviving pid then never
// settled at all: the poll was the only pending work, so Node exited 13 with the promise hanging and no
// receipt returned — in precisely the case the receipt exists to report (review B1, reproduced at exit
// 13). While this wait runs it IS the process's work, and the caller's deadline is what bounds it.
async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
