/**
 * @file src/shared/process-table.ts
 * @purpose Reading the OS process table and walking it — extracted from kill-tree.ts at the 500-line
 *   clamp. ONE async child-command seam shared by every backend; wmic first with PowerShell's CIM query
 *   as the fallback where wmic is gone; rows carry ppid, pid and creation time in any column order; and
 *   the descendant walk does NOT require the root to still exist, the whole point on Windows.
 * @exports CommandOutcome, RunCommand, ProcessRow, ProcessTableResult, SLOWEST_ENUMERATION_MS,
 *   ENUMERATE_TIMEOUT_MS, runCommand, readProcessTable, parseProcessRows, descendantsOf,
 *   refusedStaleChildren, wholeReadBound, READ_TABLE_TIMEOUT_MS, MAX_BACKEND_ATTEMPTS
 * @depends node:buffer, node:child_process, node:process
 */
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import process from "node:process";

const WINDOWS = "win32";
const COMMAND_MAX_BUFFER_BYTES = 8 << 20;

/**
 * Slowest single enumeration observed on this box. MEASURED, not chosen.
 *
 * Was 5_428 ms from three samples on 2026-09-07 (911 ms quiet over 10 samples, 2_381 ms under that
 * session's load, 5_428 ms under the review's load — `l2-review-r1.md` I2, 8 samples). RE-MEASURED
 * 2026-09-12 (lane `receipt-budgets`) because the bound those numbers produced was cutting honest reads:
 * n=60 enumerations logged during ten real runs of src/shared/kill-tree.test.ts with this deadline
 * lifted to 120_000 ms so nothing was truncated — min 975 ms, median 1_579 ms, p90 4_042 ms, max
 * 18_055 ms, and all 60 SUCCEEDED. Two of the 60 (16_653 and 18_055 ms) landed above the 10_856 ms bound
 * the old value produced.
 *
 * What that bound demonstrably caused, counted from the retained logs rather than summarised (round-2
 * item 6 — the first version of this paragraph overstated it): of 5 failing runs out of 20, THREE carry
 * `powershell: timed out after 10856 ms` (5 failing tests between them), one is the fixture's own report
 * budget, one is an outer `Test timed out in 30000ms`, and one predates this lane's diagnostic fix and
 * carries no reason at all. With the deadline lifted, 18 consecutive runs of that file passed, which is
 * the causal evidence for the timeouts specifically and for nothing else. The 2026-09-08 receipt's own
 * failure in that file is NOT explained by this bound: it was a receipt claiming a survivor, and round 2
 * found the opposite failure — a receipt claiming an empty tree whose descendants were never enumerated
 * (see `descendantsOf` below, which is where that one was fixed).
 *
 * WHY the jump: wmic no longer exists on this machine, so every enumeration here is PowerShell's. On
 * Windows 11 build 26200, C:\WINDOWS\System32\Wbem is on PATH and holds no wmic.exe (directory read
 * 2026-09-12; the node process agrees — 60/60 wmic attempts returned ENOENT, at a median cost of 41 ms).
 * That is the removal the backend-order comment below anticipated, and it retires the wmic half of the
 * 2026-09-07 medians (1_014 and 459 ms) from this bound: those were measurements of a backend that is
 * gone. The remaining cost is NOT reducible by a cheaper query — fetching three properties instead of
 * every property and replacing the per-row pipeline with one join moved the median only from 1_715 ms to
 * 1_439 ms (8 samples each), because the spread is dominated by PowerShell STARTUP under load, which
 * measured 419-2_672 ms on its own (`-NoProfile -Command exit`, 8 samples).
 *
 * A bound must not cut the largest honest sample, so this is that sample.
 *
 * EXPORTED because it is the one home for this tail (round-5 F2). It had grown a second copy in
 * `tests/setup/fixture-orphan-guard.ts` and a third in `kill-tree-receipt.test.ts`, and nothing coupled
 * them — so re-measuring DOWN here would have left the guard holding a bound nobody measured, which is
 * "ratchets only fall" unmechanised. Anything bounding a PowerShell enumeration imports this.
 */
export const SLOWEST_ENUMERATION_MS = 18_055;
/** Hang bound on one enumeration command: twice the slowest honest sample (multiplier unchanged). */
export const ENUMERATE_TIMEOUT_MS: number = 2 * SLOWEST_ENUMERATION_MS;

/** Outcome of one child command: `stdout` on success, `code` naming the failure ("ENOENT", "exit 1"). */
export interface CommandOutcome {
  readonly ok: boolean;
  readonly stdout: string;
  readonly code: string | undefined;
}

/** The injectable child-command seam; command and args stay SEPARATE, never a shell string. */
export type RunCommand = (
  cmd: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<CommandOutcome>;

/** One row of the process table. `createdAtMs` is undefined when the backend could not report it. */
export interface ProcessRow {
  readonly ppid: number;
  readonly pid: number;
  readonly createdAtMs: number | undefined;
}

/** A table that was read and passed its positive control, or the reason it could not be trusted. */
export type ProcessTableResult =
  | { readonly ok: true; readonly rows: readonly ProcessRow[] }
  | { readonly ok: false; readonly error: string };

// THE single child-process seam of this module and of kill-tree.ts — taskkill, wmic, powershell and ps all
// go through here (pidtree funnels its three backends through one spawn the same way, lib/bin.js `run`).
// ASYNCHRONOUS on purpose: a spawnSync here blocked the event loop, so three seats' drains could not
// overlap and no deadline timer could fire during one (review I1, measured 3.19x serialization against
// 1.09x after). `timeout` bounds a hung backend; `shell: false` keeps argv out of a command interpreter.
export function runCommand(
  cmd: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandOutcome> {
  return new Promise<CommandOutcome>((resolve) => {
    execFile(
      cmd,
      [...args],
      {
        encoding: "utf8",
        maxBuffer: COMMAND_MAX_BUFFER_BYTES,
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout) => {
        resolve(commandOutcome(error, stdout, timeoutMs));
      },
    );
  });
}

function commandOutcome(error: Error | null, stdout: string, timeoutMs: number): CommandOutcome {
  if (error === null) return { code: undefined, ok: true, stdout };
  const failure = error as NodeJS.ErrnoException & { readonly killed?: boolean };
  // execFile kills the child when `timeout` elapses and reports it as `killed`, with no exit code.
  if (failure.killed === true) {
    return { code: `timed out after ${String(timeoutMs)} ms`, ok: false, stdout };
  }
  const raw = failure.code;
  const code = typeof raw === "number" ? `exit ${String(raw)}` : (raw ?? "EUNKNOWN");
  return { code, ok: false, stdout };
}

// Backend ORDER is structural, not a stopwatch result: PowerShell's CIM query is the documented
// replacement for wmic, which is deprecated and REMOVED from Windows 11 24H2 and Windows Server 2025, so
// wmic is tried first and CIM is the fallback that keeps working once it is gone — pidtree's own reason
// and ordering (lib/get.js `getWindows`, lib/powershell.js: "Get-CimInstance is the supported replacement
// for the removed wmic utility"). Timing does NOT decide it, because timing does not reproduce: three
// 8-to-10-sample runs on this box on 2026-09-07 gave wmic medians of 1_014 ms and 459 ms against
// PowerShell's 1_182 ms and 1_303 ms (quiet: wmic ~2.8x faster), but 3_959 vs 3_724 ms under the review's
// load, where wmic was the SLOWER one. Load dominates that difference; the removal does not.
const WMIC_ARGS: readonly string[] = ["PROCESS", "get", "CreationDate,ParentProcessId,ProcessId"];
const POSIX_PS_ARGS: readonly string[] = ["-A", "-o", "ppid,pid"];
// InvariantCulture so the timestamp is Latin digits on every locale; the `if` guards a row whose
// CreationDate is null (it emits "-", which reads back as "creation time unknown", never as a time).
const POWERSHELL_SCRIPT =
  "$ProgressPreference = 'SilentlyContinue'; " +
  "$c = [System.Globalization.CultureInfo]::InvariantCulture; " +
  "Get-CimInstance -ClassName Win32_Process | ForEach-Object { " +
  "$t = if ($_.CreationDate) " +
  "{ $_.CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmss.ffffff', $c) + '+000' } else { '-' }; " +
  '"$($_.ParentProcessId) $($_.ProcessId) $t" }';
// -EncodedCommand (UTF-16LE base64) so no quoting of the script survives to a command interpreter, and
// because execution policy restricts SCRIPT FILES, not commands. -NoProfile keeps a user profile from
// writing to stdout and corrupting the table.
const POWERSHELL_ARGS: readonly string[] = [
  "-NoProfile",
  "-NonInteractive",
  "-EncodedCommand",
  Buffer.from(POWERSHELL_SCRIPT, "utf16le").toString("base64"),
];

interface Backend {
  readonly cmd: string;
  readonly args: readonly string[];
}

const WINDOWS_BACKENDS: readonly Backend[] = [
  { args: WMIC_ARGS, cmd: "wmic" },
  { args: POWERSHELL_ARGS, cmd: "powershell" },
];
const POSIX_BACKENDS: readonly Backend[] = [{ args: POSIX_PS_ARGS, cmd: "ps" }];
/**
 * The most backends any platform here tries, which is what a caller's own budget has to cover.
 * EXPORTED so `kill-tree-receipt.test.ts` can pin it: setting this to 1 silently restores exactly the
 * under-budget round 2 existed to fix, and before round 3 that mutation passed all 39 seam tests
 * because nothing asserted on it (round-3 item 2, the reviewer's 2 -> 1 mutation).
 */
export const MAX_BACKEND_ATTEMPTS: number = Math.max(
  WINDOWS_BACKENDS.length,
  POSIX_BACKENDS.length,
);

/**
 * The bound on a WHOLE table read when each backend attempt is given `perBackendMs`.
 *
 * `readProcessTable` tries each backend for the platform IN TURN and hands each one the full per-backend
 * bound, so `ENUMERATE_TIMEOUT_MS` is not what one read can cost — it is what one ATTEMPT can cost, and a
 * caller that budgets the per-attempt figure can time out while the read is still inside its own contract
 * (round-2 F4 / codex finding 1). Derived from the backend lists above rather than written down, so
 * adding a backend moves every budget derived from this instead of silently thinning it.
 *
 * Unreachable on this box today — wmic is gone, so the first attempt fails in ~40 ms — but reachable on
 * any Windows that still ships a wmic that can hang. Whether CI's `windows-latest` still ships one is
 * UNVERIFIED here (no network this pass).
 */
export function wholeReadBound(perBackendMs: number): number {
  return MAX_BACKEND_ATTEMPTS * perBackendMs;
}

/** Hang bound on one whole table read at the production per-attempt bound. */
export const READ_TABLE_TIMEOUT_MS: number = wholeReadBound(ENUMERATE_TIMEOUT_MS);

const INTEGER_TOKEN = /^\d+$/;
// CIM_DATETIME as both backends emit it: yyyymmddHHMMSS.mmmmmm then the UTC offset in minutes.
const CIM_DATETIME = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/;

/**
 * Reads the whole process table, trying each backend for the platform in turn. Unlike pidtree (lib/get.js
 * falls back only on ENOENT) any failure moves to the next backend and BOTH reasons reach the caller, so
 * nothing is masked; the positive control below is what makes that safe.
 *
 * @param run - the child-command seam
 * @param platform - the platform whose backends to try
 * @param timeoutMs - hang bound for each backend
 * @param about - the pid the caller is asking about, named in the failure message
 */
export async function readProcessTable(
  run: RunCommand,
  platform: NodeJS.Platform,
  timeoutMs: number,
  about: number,
): Promise<ProcessTableResult> {
  const attempts = platform === WINDOWS ? WINDOWS_BACKENDS : POSIX_BACKENDS;
  const failures: string[] = [];
  for (const attempt of attempts) {
    const out = await run(attempt.cmd, attempt.args, timeoutMs);
    if (!out.ok) {
      failures.push(`${attempt.cmd}: ${out.code ?? "unknown"}`);
      continue;
    }
    const rows = parseProcessRows(out.stdout);
    // POSITIVE CONTROL. A table that does not contain the process doing the asking cannot be a true
    // picture of the machine, so an empty or unparsable dump is an accounting failure — never the
    // answer "nothing is running". This is the check that keeps a silently broken backend from
    // manufacturing a clean receipt.
    if (!rows.some((row) => row.pid === process.pid)) {
      failures.push(
        `${attempt.cmd}: table of ${String(rows.length)} rows omits this process (pid ${String(process.pid)})`,
      );
      continue;
    }
    return { ok: true, rows };
  }
  return {
    error: [
      `process enumeration failed before the kill of pid ${String(about)} on ${platform}`,
      `(${failures.join("; ")});`,
      "the drain is UNVERIFIED — treat the tree as possibly alive, retry, and check that an",
      "enumeration backend is reachable on PATH",
    ].join(" "),
    ok: false,
  };
}

/**
 * One row per line, order-independent: the first two integer tokens are ppid and pid (wmic prints them
 * after the timestamp, the CIM query before it) and any CIM_DATETIME token is the creation time. Header
 * and stray lines carry fewer than two integers and are skipped, the way pidtree's lib/parse.js does.
 */
export function parseProcessRows(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const rawLine of stdout.split(/\r*\n/)) {
    const tokens = rawLine.trim().split(/\s+/);
    const integers = tokens.filter((token) => INTEGER_TOKEN.test(token));
    const ppid = Number.parseInt(integers[0] ?? "", 10);
    const pid = Number.parseInt(integers[1] ?? "", 10);
    if (Number.isNaN(ppid) || Number.isNaN(pid)) continue;
    rows.push({
      createdAtMs: cimDateToMs(tokens.find((token) => CIM_DATETIME.test(token))),
      pid,
      ppid,
    });
  }
  return rows;
}

function cimDateToMs(token: string | undefined): number | undefined {
  const parts = token === undefined ? null : CIM_DATETIME.exec(token);
  if (parts === null) return undefined;
  const utc = Date.UTC(
    Number(parts[1]),
    Number(parts[2]) - 1,
    Number(parts[3]),
    Number(parts[4]),
    Number(parts[5]),
    Number(parts[6]),
    Math.floor(Number(parts[7]) / 1000),
  );
  if (Number.isNaN(utc)) return undefined;
  // The trailing field is the offset EAST of UTC in minutes, so true UTC is the stamp minus the offset.
  return utc - Number(parts[9]) * 60_000 * (parts[8] === "-" ? -1 : 1);
}

/**
 * Every pid reachable from `rootPid` through the parent links, root excluded and NOT required to still
 * exist: Windows keeps a dead parent's pid in its children's ParentProcessId (live evidence — the probe
 * capture 10-lifecycle.json lists survivor 37776 still naming ParentProcessId 3396 after 3396 exited),
 * which is exactly how a launcher's orphans are found after the launcher is gone. pidtree's own walk
 * (lib/pidtree.js) errors with "No matching pid found" in that case, so its precondition is dropped here.
 *
 * The SAME fact that makes a dead parent's link readable also makes it possible to point at a STRANGER:
 * pid reuse can hand the parent's old number to an unrelated process, and a row that still names it as
 * ppid is then a leftover from whoever held that number BEFORE, not a real child of who holds it now. A
 * genuine child cannot have been created earlier than the parent whose pid it names, so a link is walked
 * only when that ordering holds or when either side's creation time is unknown and cannot be checked
 * (review C1: an hour-old process pulled into a fresh root's drain set, and explicitly `taskkill /PID`'d,
 * by a recycled ppid alone).
 */
export function descendantsOf(rootPid: number, rows: readonly ProcessRow[]): number[] {
  const childrenOf = childrenByParent(rows);
  const createdAtOf = createdAtByPid(rows);
  const found: number[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  let cursor = 0;
  while (cursor < queue.length) {
    const current = queue[cursor];
    cursor += 1;
    if (current === undefined) continue;
    for (const child of unseenGenuineChildren(current, childrenOf, createdAtOf, seen)) {
      seen.add(child);
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

function childrenByParent(rows: readonly ProcessRow[]): Map<number, number[]> {
  const childrenOf = new Map<number, number[]>();
  for (const row of rows) {
    if (row.pid === row.ppid) continue; // a self-parent row (pid 0 on some tables) would loop the walk
    const bucket = childrenOf.get(row.ppid);
    if (bucket === undefined) childrenOf.set(row.ppid, [row.pid]);
    else bucket.push(row.pid);
  }
  return childrenOf;
}

function createdAtByPid(rows: readonly ProcessRow[]): Map<number, number> {
  const createdAtOf = new Map<number, number>();
  for (const row of rows) {
    if (row.createdAtMs !== undefined) createdAtOf.set(row.pid, row.createdAtMs);
  }
  return createdAtOf;
}

/**
 * The DIRECT children of `parentPid` that {@link descendantsOf} refuses because their creation time
 * predates the parent's. Empty whenever the ordering holds or either side is untimed, which is the
 * ordinary case — including an already-exited parent, whose row carries no time to compare.
 *
 * A non-empty result is NOT proof of pid reuse. This comment asserted that it was until round 7, and the
 * refutation is measured, not argued: `Secure System` (188) and `Registry` (232) name `System` (4) as their
 * parent while recorded 11.59 s OLDER than it — genuine Windows kernel children, no reuse anywhere, and one
 * refused pid across 187 distinct parents on this box. Rows left by a previous holder of a pid look exactly
 * the same from in here, which is the whole difficulty. What a non-empty result does
 * mean is narrower and still worth a caller's attention: "no children found" and "children found but
 * disowned" are the same empty array to `descendantsOf` and do not mean the same thing, because the
 * second says rows are claiming this pid as their parent, so an EMPTY walk cannot be read as an empty
 * tree (round-2 F1: a drain read the second as the first and issued a proof of drain for a tree whose
 * descendants were still running).
 *
 * Acting on it is the caller's decision, and exactly one shape justifies refusing a drain:
 * `disownedRootIsTheOnlyReading` in `kill-tree-identity.ts` is the only place that decides, and it requires
 * all three of no verified identity, NO descendants found, and at least one disowned child. Round 2 refused
 * on this signal alone and cost genuine drains 1 run in 10, on live roots whose identity check had just
 * passed. So: pass `rootStartedAtMs` and this signal is none of your drain's business; find descendants and
 * it is reported on the receipt rather than acted on. Do not reintroduce a refusal here.
 */
export function refusedStaleChildren(parentPid: number, rows: readonly ProcessRow[]): number[] {
  const createdAtOf = createdAtByPid(rows);
  const parentCreatedAt = createdAtOf.get(parentPid);
  return (childrenByParent(rows).get(parentPid) ?? []).filter((child) =>
    isStaleLink(parentCreatedAt, createdAtOf.get(child)),
  );
}

// The pids of `parentPid`'s claimed children, minus ones already reached by another path and minus stale
// links (review C1): excluded, and not walked further, so nothing hanging off an unrelated pid is trusted
// either.
function unseenGenuineChildren(
  parentPid: number,
  childrenOf: ReadonlyMap<number, number[]>,
  createdAtOf: ReadonlyMap<number, number>,
  seen: ReadonlySet<number>,
): number[] {
  const parentCreatedAt = createdAtOf.get(parentPid);
  const kids: number[] = [];
  for (const child of childrenOf.get(parentPid) ?? []) {
    if (seen.has(child)) continue;
    if (isStaleLink(parentCreatedAt, createdAtOf.get(child))) continue;
    kids.push(child);
  }
  return kids;
}

// A link is stale only when BOTH creation times are known and the child's predates the parent's — the
// walk keeps trusting a link whenever either side cannot be checked (review C1's own bound: an already-gone
// root, or any row a backend could not time, must not silently start refusing links it used to accept).
function isStaleLink(
  parentCreatedAt: number | undefined,
  childCreatedAt: number | undefined,
): boolean {
  return (
    parentCreatedAt !== undefined &&
    childCreatedAt !== undefined &&
    childCreatedAt < parentCreatedAt
  );
}
