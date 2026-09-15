/**
 * @file src/shared/kill-tree-identity.ts
 * @purpose Who a drain root IS, and when a DISOWNED child is evidence about it — the two questions
 *   kill-tree.ts answers before it kills anything. Extracted when that file passed the 500-line clamp
 *   (ratchets only fall) along the seam its own tests already use: a recycled pid must not take a
 *   stranger's tree with it. Pure functions over a table's rows; no process is touched here.
 * @exports ROOT_IDENTITY_SLACK_MS, identityMismatch, disownedRootIsTheOnlyReading, disownedRootError
 * @depends ./process-table
 */
import type { ProcessRow } from "./process-table.js";

const WINDOWS = "win32";

/**
 * How much later than the caller's own spawn moment the root's creation time may read before the pid is
 * treated as recycled. This covers clock granularity between `Date.now()` and Win32_Process CreationDate,
 * never a process lifetime: the fastest return of a specific pid measured on this box was 25_536 ms
 * (`l2-review-r1.md` I4 — 600 spawns, 572 distinct pids, 28 reuses), so seconds of slack cannot span one.
 */
export const ROOT_IDENTITY_SLACK_MS: number = 5_000;

// A pid the OS handed out again roots a tree this caller never owned; draining it would kill a stranger's
// processes and report a clean success (review I4, reproduced: four unrelated processes killed, isDrained
// true). Windows exposes the discriminator directly — Win32_Process.CreationDate, carried on every row of
// both backends on this box — so a root created materially later than the caller's own spawn moment is
// refused. UNVERIFIED and deliberately NOT relied on: whether an open Win32 process handle blocks reuse of
// that pid, which if true would make this redundant for a caller still holding its ChildProcess.
export function identityMismatch(
  pid: number,
  root: ProcessRow | undefined,
  startedAt: number | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  if (startedAt === undefined) return undefined;
  if (root === undefined) return undefined; // already gone — bound (d) on killTreeVerified
  if (root.createdAtMs === undefined) {
    if (platform !== WINDOWS) {
      // ps -A -o ppid,pid (process-table.ts POSIX_PS_ARGS) has no creation-time column at all, on every
      // row, always — not a transient read failure the way it can be on Windows, but a structural gap in
      // what this platform's chosen backend can report. Refusing here would mean the option this module
      // itself recommends callers use unconditionally disables draining on Linux and macOS (review C4,
      // reproduced: accounted:false / forced:false against a genuinely alive, genuinely-owned root).
      // killTreeVerified reports identityChecked:false — the caller finds out its request could not be
      // honored — and proceeds unchecked rather than refusing outright.
      return undefined;
    }
    return [
      `pid ${String(pid)} is alive but its creation time is unreadable, so the identity check the caller`,
      "asked for cannot be made; refusing to kill a tree that may not be ours. Retry, or omit",
      "rootStartedAtMs to drain without the check.",
    ].join(" ");
  }
  const lateBy = root.createdAtMs - startedAt;
  if (lateBy <= ROOT_IDENTITY_SLACK_MS) return undefined;
  return [
    `pid ${String(pid)} was created ${String(lateBy)} ms after the caller spawned its root, beyond the`,
    `${String(ROOT_IDENTITY_SLACK_MS)} ms identity slack, so the id has been recycled onto another`,
    "process; refusing to kill a tree that is not ours. The original tree is already gone.",
  ].join(" ");
}

/**
 * Whether a disowned child is evidence about THIS root rather than about somebody else's.
 *
 * Round 3 narrowed this after the round-2 version refused genuine drains — 1 run in 10, on a LIVE root
 * whose identity check had just passed in the same call, with a message that asserted pid reuse and
 * advised passing `rootStartedAtMs` to a caller already passing it. The premise it rested on ("a disowned
 * child cannot be anything but a reused pid") is simply false on Windows: `Secure System` (188) and
 * `Registry` (232) name `System` (4) as their parent while recorded 11.59 s OLDER than it — genuine
 * kernel children, no reuse anywhere, and one refused pid across 187 distinct parents on this box.
 *
 * So a disowned row only means something when nothing else does:
 *   - identity PASSED  -> the root is provably the caller's, so disowned rows belong to a previous holder
 *                         of the id and are none of this drain's business.
 *   - the walk found children -> the drain proceeds on what it found; the disowned rows are REPORTED on
 *                         the receipt (`disowned`) instead of cancelling a kill that has real targets.
 *   - neither -> the F1 shape: no identity, an empty walk, and rows insisting this pid is their parent.
 *                Only then is the empty walk the opposite of an empty tree.
 */
export function disownedRootIsTheOnlyReading(
  identityChecked: boolean,
  descendants: readonly number[],
  disowned: readonly number[],
): boolean {
  return !identityChecked && descendants.length === 0 && disowned.length > 0;
}

// ROUND-2 F1. The walk refusing a link is evidence, and this is the one place where the difference
// between "found nothing" and "disowned what it found" decides whether a receipt may say EMPTY. The
// round-1 reviewer's run 9 issued `survivors: []` for a tree whose two descendants were still running:
// the caller's root had exited, a process created LATER took its pid, and every genuine child then looked
// older than its own parent. Nothing downstream could notice — the root pid read gone, so no kill was
// even attempted, and an empty survivor list over an empty drain set looked exactly like success.
//
// Refusing costs the caller a retry in the one case it fires, and it is the safe direction twice over: a
// `/PID <root> /T /F` here would have targeted whatever now holds that pid (bound (c), FL-211's hazard,
// reproduced as four unrelated processes killed with `isDrained` true), and the tree the caller actually
// asked about is left for a retry that can still find it through its own children's links.
export function disownedRootError(pid: number, disowned: readonly number[]): string {
  // ROUND-4 item 5: this sentence used to call the ordering "impossible for a real child", the absolute
  // `disownedRootIsTheOnlyReading` above retires twenty lines earlier — kernel children legitimately carry
  // a creation time older than their parent's. It is the only text a caller ever sees, so it states what
  // is actually true of this refusal: what was observed, what was NOT established, and what was not done.
  return [
    `pid ${String(pid)} is named as the parent of ${String(disowned.length)} process(es)`,
    `(${disowned.join(", ")}) recorded as created BEFORE it, no descendant of it was found, and its`,
    "identity was never verified — no rootStartedAtMs was supplied, or the table carried no creation time",
    "for it. Recorded-older children are normal for some parents (Windows kernel children are), so this is",
    "not proof of reuse on its own; what it does mean is that an EMPTY walk here cannot be read as an empty",
    "tree, because rows are claiming this id as their parent. Nothing was killed: a forced kill would",
    "target whoever holds the id now. Retry, and pass rootStartedAtMs so the root can be identified.",
  ].join(" ");
}
