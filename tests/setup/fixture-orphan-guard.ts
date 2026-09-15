/**
 * @file tests/setup/fixture-orphan-guard.ts
 * @purpose N3: vitest globalSetup whose TEARDOWN fails the run when a process-tree fixture of THIS run is
 *   still alive. Origin, measured: 42 orphaned node processes holding 2.3 GB were found on the operator's
 *   machine at 23:2x on 2026-09-12, every one a `src/shared/kill-tree.test.ts` spawn tree, swept by hand.
 *   They leaked because that fixture's cleanup is an `afterEach` living IN the worker, and vitest kills a
 *   worker that misses the 60 s birpc deadline — so the sweep died with what it was meant to clean up.
 *   The fixture carries its own owner watch now; this is the gate that says so when it does not.
 * @exports FIXTURE_TOKEN, IDENTITY_PATTERN, QUERY_TIMEOUT_MS, FixtureProcess, OrphanScan, RunQuery,
 *   scanFixtureOrphans,
 *   describeScan, default (vitest globalSetup)
 * @depends node:child_process, node:process, ../../src/shared/process-table
 */
import { execFile } from "node:child_process";
import process from "node:process";
import { SLOWEST_ENUMERATION_MS } from "../../src/shared/process-table.js";

/**
 * The identity a fixture level publishes about ITSELF, as one trailing argv entry carrying its owner's pid:
 * `zer0-kt-fixture:<ownerPid>`. Matched EXACTLY, token plus digits, never as a substring.
 *
 * Round 4 item 7: rounds 3 and 4 identified a fixture by `CommandLine -like '*KILL_TREE_FIXTURE_DEPTH*'`,
 * so every process whose source text merely NAMES that variable was treated as a fixture — the reviewer's
 * own leak-harness worker (pid 24460) and this lane's probes among them. A script that BUILDS this token
 * still cannot match it, because what follows the colon in such a script is `" + owner`, not digits.
 *
 * Why argv and not an environment variable: the owner pid is an env var to the fixture itself, and
 * Win32_Process exposes a command line but never an environment, so the fixture also publishes it where
 * this gate can see it. The alternatives were a marker file per tree (state that can leak of its own) or
 * reading another process's environment, which Windows does not offer us.
 *
 * A fixture from a build before this token existed is invisible to the gate. That is the deliberate trade:
 * guessing at identity from a substring any harness also carries is what produced the false reports.
 */
export const FIXTURE_TOKEN: string = "zer0-kt-fixture:";

/**
 * How that identity is RECOGNISED, as a pattern string -- the one source of truth both halves read: it is
 * interpolated into the PowerShell query below and compiled by `new RegExp` in the test that asserts it
 * over sample command lines. Group 1 is the owner pid.
 *
 * ANCHORED to the trailing argument (round-6 item 1), because "the token plus digits" was not an identity:
 * `-match` searches the WHOLE command line and `$Matches[1]` takes the FIRST hit, so rounds 4 and 5 carried
 * two live defects, both reproduced on this box with real CIM before this line changed.
 *   (A) A process whose only marker was a documentation string -- an example identity assigned to a
 *       constant, no identity argument at all -- was REPORTED as unowned with the owner read out of the
 *       doc string, and the gate told the operator to kill it. A mention is not a publication.
 *   (B) A process carrying an earlier token naming System (pid 4, alive, foreign) before its GENUINE
 *       trailing identity naming a dead owner was read as owner 4, judged somebody else's live run, and
 *       IGNORED. A real leak, missed silently -- the direction that defeats the gate's whole purpose.
 *
 * `(?:^|\\s)` so a longer word ending in the token cannot qualify; `\\s*$` so only the LAST argument can,
 * which is where a fixture publishes it and where no script text can reach. `\\s*` rather than a bare `$`
 * because .NET lets `$` match before a trailing newline and JavaScript does not: absorbing trailing
 * whitespace makes both engines agree on every shape, which is what lets ONE pattern serve both.
 */
export const IDENTITY_PATTERN: string = `(?:^|\\s)${FIXTURE_TOKEN}(\\d+)\\s*$`;

const WINDOWS = "win32";
/**
 * Hang bound on one scan: twice the measured tail of this class of work, IMPORTED rather than copied.
 *
 * This query's own 26 samples on this box 2026-09-13 are 12 idle (1_153 / median 1_531 / 1_901 ms) and 14
 * under `kill-tree.test.ts`'s contention, which is what this gate sits next to (2_015 / median 2_451 /
 * 2_897 ms); every one printed its CONTROL line. The bound is deliberately NOT twice that 2_897 ms, because
 * those samples do not contain the tail: this query starts PowerShell and enumerates Win32_Process, the
 * same two costs whose tail is logged at `SLOWEST_ENUMERATION_MS` over 60 samples, and a timeout HERE fails
 * the whole run — so a bound sized on a quiet window would turn a slow box red, the exact defect class this
 * lane exists to remove.
 *
 * Round-5 F2: rounds 3 and 4 re-declared that tail here as a local 18_055 rather than importing it, on the
 * reasoning that this query's own samples justify the SHAPE and only the tail was borrowed. That reasoning
 * was right about the shape and wrong about the number: two independent copies of one measurement cannot
 * both be re-measured, so lowering the tail in `process-table.ts` would have left this bound behind as a
 * number nobody measured. The shape stays documented here; the number now has one home.
 */
export const QUERY_TIMEOUT_MS: number = 2 * SLOWEST_ENUMERATION_MS;

/** One fixture process as CIM reported it. `owner` is 0 when the command line carried no owner flag. */
export interface FixtureProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly owner: number;
}

/**
 * What the scan could establish. The three lists stay apart because they are different defects with
 * different messages, and `failure` stays apart from all of them because "the query could not say" is
 * never the same answer as "nothing is running" — round-4 item 1 found this gate reading a missing
 * PowerShell, a timeout and a denied CIM query as proof of a clean box.
 */
export interface OrphanScan {
  /** Fixtures whose owner is gone: nobody will ever clean these up. The 2026-09-12 shape. */
  readonly unowned: readonly FixtureProcess[];
  /** Fixtures owned by THIS run, still alive once every test had finished. */
  readonly mine: readonly FixtureProcess[];
  /** Set when the enumeration could not be trusted; then the lists above mean nothing. */
  readonly failure: string | undefined;
}

/** The injectable child-command seam, so the failure shapes are testable without breaking a box. */
export type RunQuery = (
  script: string,
  timeoutMs: number,
) => Promise<{ ok: boolean; stdout: string; code: string | undefined }>;

// `$ErrorActionPreference = 'Stop'` on purpose: round 3 used 'SilentlyContinue', which turned a denied CIM
// query into empty stdout with exit 0 — the one failure shape indistinguishable from a clean box. The
// CONTROL line is the positive control, the same device `readProcessTable` uses: a snapshot that cannot
// see the process doing the asking is not a picture of this machine. Command lines are filtered and parsed
// INSIDE PowerShell and never printed, because a fixture's `-e` script contains newlines and would break
// any line-oriented read of them out here. That is why the FILTER lives there and the pattern it uses is
// EXPORTED rather than inlined: the filtering step is then asserted in TypeScript over sample command
// lines, with no CIM and no spawning, which is what no test did before round 6.
function queryFor(selfPid: number): string {
  const self = String(selfPid);
  return [
    "$ErrorActionPreference = 'Stop';",
    `$all = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'");`,
    `Write-Output ("CONTROL " + $all.Count + " " + @($all | Where-Object { $_.ProcessId -eq ${self} }).Count);`,
    "foreach ($p in $all) {",
    `  if ($p.ParentProcessId -eq ${self}) { Write-Output ("MINE " + $p.ProcessId) }`,
    // `-cmatch`, not `-match`: PowerShell's `-match` is case-INSENSITIVE, so it would accept identities
    // this gate's own pattern rejects once the same string is compiled in TypeScript. The identity is
    // published in exactly one case, and the two halves have to agree on every input or the test is not a
    // test of the query.
    `  if ($p.CommandLine -cmatch '${IDENTITY_PATTERN}') {`,
    `    Write-Output ("ROW " + $p.ProcessId + " " + $p.ParentProcessId + " " + $Matches[1])`,
    "  }",
    "}",
  ].join(" ");
}

const defaultRun: RunQuery = (script, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", timeout: timeoutMs, windowsHide: true },
      (error, stdout) => {
        resolve(
          error === null ? { code: undefined, ok: true, stdout } : failureOf(error, timeoutMs),
        );
      },
    );
  });

function failureOf(error: Error, timeoutMs: number): { ok: false; stdout: string; code: string } {
  const failure = error as NodeJS.ErrnoException & { readonly killed?: boolean };
  if (failure.killed === true) {
    return { code: `timed out after ${String(timeoutMs)} ms`, ok: false, stdout: "" };
  }
  const raw = failure.code;
  return {
    code: typeof raw === "number" ? `exit ${String(raw)}` : (raw ?? "EUNKNOWN"),
    ok: false,
    stdout: "",
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const empty = (failure: string | undefined): OrphanScan => ({ failure, mine: [], unowned: [] });

/**
 * Asks what fixture processes exist and who owns them.
 *
 * Ownership, not parentage (round-4 item 2). This suite KILLS fixture roots on purpose, so a dead
 * immediate parent is normal, and round 3 reported those as orphans — including another checkout's live
 * tree, on a machine that runs three. What makes a fixture this run's problem is its OWNER: gone, so
 * nobody will clean it up, or one of this process's own workers while every test has already finished.
 * vitest tears global setups down BEFORE it closes the pool, so those workers are still alive at this
 * moment, which is precisely why "my worker owns it" has to count as a leak rather than as a live run.
 *
 * Known limit, the same one the fixture's own owner watch carries: an owner pid recycled onto a live
 * process reads as a live owner, and such a fixture is attributed to whoever holds the id now. The
 * fixture's absolute TTL is what bounds that case; this gate cannot see it.
 */
export async function scanFixtureOrphans(opts?: {
  readonly run?: RunQuery;
  readonly selfPid?: number;
  readonly platform?: NodeJS.Platform;
}): Promise<OrphanScan> {
  if ((opts?.platform ?? process.platform) !== WINDOWS) return empty(undefined);
  const selfPid = opts?.selfPid ?? process.pid;
  const out = await (opts?.run ?? defaultRun)(queryFor(selfPid), QUERY_TIMEOUT_MS);
  if (!out.ok) return empty(`the process query failed (${out.code ?? "unknown"})`);
  const control = /^CONTROL (\d+) (\d+)$/m.exec(out.stdout);
  if (control?.[1] === undefined || control[2] === undefined) {
    return empty(
      `the process query printed no CONTROL line, so it never reported a table (${String(out.stdout.length)} bytes out)`,
    );
  }
  if (Number(control[2]) < 1) {
    return empty(
      `the process query listed ${control[1]} node processes but not this one (pid ${String(
        selfPid,
      )}), so the snapshot is not a picture of this machine`,
    );
  }
  return classify(out.stdout, selfPid);
}

function classify(stdout: string, selfPid: number): OrphanScan {
  const lines = stdout.split(/\r*\n/).map((line) => line.trim());
  const mineSet = new Set<number>([selfPid]);
  for (const line of lines) {
    const own = /^MINE (\d+)$/.exec(line);
    if (own?.[1] !== undefined) mineSet.add(Number(own[1]));
  }
  const unowned: FixtureProcess[] = [];
  const mine: FixtureProcess[] = [];

  for (const line of lines) {
    const row = /^ROW (\d+) (\d+) (\d+)$/.exec(line);
    if (row?.[1] === undefined || row[2] === undefined || row[3] === undefined) continue;
    const found: FixtureProcess = {
      owner: Number(row[3]),
      pid: Number(row[1]),
      ppid: Number(row[2]),
    };
    if (!alive(found.owner)) unowned.push(found);
    else if (mineSet.has(found.owner)) mine.push(found);
  }
  return { failure: undefined, mine, unowned };
}

/** The failure text, or undefined when the scan proved the box clean of this run's fixtures. */
export function describeScan(scan: OrphanScan): string | undefined {
  if (scan.failure !== undefined) {
    return `fixture-orphan-guard could not verify the box: ${scan.failure}. An enumeration that cannot answer is not an answer; treat this run as unproven.`;
  }
  const parts: string[] = [];
  if (scan.unowned.length > 0) parts.push(`${String(scan.unowned.length)} whose OWNER is gone`);
  if (scan.mine.length > 0)
    parts.push(`${String(scan.mine.length)} owned by THIS run and still alive`);
  if (parts.length === 0) return undefined;
  const all = [...scan.unowned, ...scan.mine];
  return [
    `process-tree fixture(s) outlived this run — ${parts.join("; ")}:`,
    all
      .map((p) => `pid ${String(p.pid)} (parent ${String(p.ppid)}, owner ${String(p.owner)})`)
      .join(", "),
    `. They publish ${FIXTURE_TOKEN}<owner> on their command line and hold ~55 MB each. Sweep with`,
    "`taskkill /PID <pid> /T /F`, and treat it as a defect in whatever spawned them: a fixture has to end",
    "itself when the worker that owns it is killed.",
  ].join(" ");
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  return async () => {
    const message = describeScan(await scanFixtureOrphans());
    if (message !== undefined) throw new Error(message);
  };
}
