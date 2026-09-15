/**
 * @file src/shared/process-table.test.ts
 * @purpose Contract for reading and walking the OS process table. The command seam is proven against REAL
 *   child processes (a missing binary, a non-zero exit, and a hung command that the bound actually cuts);
 *   backend order, argv and the positive control are proven through an injected seam; the parser is proven
 *   against BOTH column orders the two Windows backends print; and the descendant walk is proven to work
 *   through a root that no longer exists, which is the case the whole receipt was built for.
 * @exports (none — test file)
 * @depends node:process, vitest, ./process-table
 */
import process from "node:process";
import { expect, it } from "vitest";
import {
  type CommandOutcome,
  type ProcessRow,
  type RunCommand,
  descendantsOf,
  parseProcessRows,
  readProcessTable,
  runCommand,
} from "./process-table.js";

const NO_BOUND_NEEDED = 30_000;
const ROOT = 4242;
const CHILD = 5555;
const GRANDCHILD = 6666;

const ok = (stdout: string): CommandOutcome => ({ code: undefined, ok: true, stdout });
const fail = (code: string): CommandOutcome => ({ code, ok: false, stdout: "" });
const row = (ppid: number, pid: number): ProcessRow => ({ createdAtMs: undefined, pid, ppid });

// ---------- the real command seam ----------

it("a missing binary is reported as ENOENT rather than an empty result", async () => {
  const out = await runCommand("m0irai-no-such-enumerator", ["x"], NO_BOUND_NEEDED);

  expect(out.ok).toBe(false);
  expect(out.code).toBe("ENOENT");
  expect(out.stdout).toBe("");
});

it("a non-zero exit is reported with its code, not swallowed", async () => {
  const out = await runCommand(process.execPath, ["-e", "process.exit(3)"], NO_BOUND_NEEDED);

  expect(out.ok).toBe(false);
  expect(out.code).toBe("exit 3");
});

it("a command that would hang is cut by its bound and says so", async () => {
  const started = Date.now();
  const out = await runCommand(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], 400);
  const elapsed = Date.now() - started;

  expect(out.ok).toBe(false);
  expect(out.code).toBe("timed out after 400 ms");
  expect(elapsed).toBeLessThan(20_000);
});

// Guarded (review B3): this repo runs npm test on both windows-latest and ubuntu-latest
// (.github/workflows/verify.yml), and the createdAtMs assertions below are structurally impossible on
// POSIX — ps -A -o ppid,pid (POSIX_PS_ARGS above) carries no creation-time column at all, ever, so the
// real table this test reads on Linux would have self?.createdAtMs === undefined. Every other test in
// this file drives readProcessTable/descendantsOf/parseProcessRows through an injected seam or a literal
// row, and stays unguarded — this is the one test that reads the REAL table on process.platform itself.
it.runIf(process.platform === "win32")(
  "the REAL process table lists this very process, which is what the positive control rests on",
  async () => {
    const table = await readProcessTable(
      runCommand,
      process.platform,
      NO_BOUND_NEEDED,
      process.pid,
    );

    expect(table.ok).toBe(true);
    if (!table.ok) throw new Error(table.error);
    const self = table.rows.find((entry) => entry.pid === process.pid);
    expect(self).toBeDefined();
    expect(self?.ppid).toBeGreaterThan(0);
    expect(self?.createdAtMs).toBeGreaterThan(Date.now() - 24 * 60 * 60 * 1_000);
    expect(self?.createdAtMs).toBeLessThanOrEqual(Date.now() + 60_000);
  },
);

// ---------- backend selection ----------

function recorder(outcomes: Record<string, CommandOutcome>): {
  run: RunCommand;
  calls: Array<{ cmd: string; args: readonly string[] }>;
} {
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  return {
    calls,
    run: async (cmd, args) => {
      calls.push({ args, cmd });
      return outcomes[cmd] ?? fail("ENOENT");
    },
  };
}

const selfTable = `0 ${String(process.pid)} -`;

it("wmic is tried first and PowerShell's CIM query is the fallback when it fails", async () => {
  const seam = recorder({ powershell: ok(selfTable) });

  const table = await readProcessTable(seam.run, "win32", NO_BOUND_NEEDED, ROOT);

  expect(table.ok).toBe(true);
  expect(seam.calls.map((call) => call.cmd)).toEqual(["wmic", "powershell"]);
  expect(seam.calls[0]?.args).toEqual(["PROCESS", "get", "CreationDate,ParentProcessId,ProcessId"]);
  expect(seam.calls[1]?.args).toContain("-EncodedCommand");
  expect(seam.calls[1]?.args).toContain("-NoProfile");
  expect(seam.calls[1]?.args).toContain("-NonInteractive");
});

it("a non-Windows platform enumerates with ps, and never reaches for wmic", async () => {
  const seam = recorder({ ps: ok(selfTable) });

  const table = await readProcessTable(seam.run, "linux", NO_BOUND_NEEDED, ROOT);

  expect(table.ok).toBe(true);
  expect(seam.calls.map((call) => call.cmd)).toEqual(["ps"]);
  expect(seam.calls[0]?.args).toEqual(["-A", "-o", "ppid,pid"]);
});

it("a table that omits this very process is an accounting failure, not an empty machine", async () => {
  const seam = recorder({ powershell: ok("0 4 -\r\n4 228 -"), wmic: ok("0 4 -\r\n4 228 -") });

  const table = await readProcessTable(seam.run, "win32", NO_BOUND_NEEDED, ROOT);

  expect(table.ok).toBe(false);
  if (table.ok) throw new Error("expected the positive control to reject this table");
  expect(table.error).toMatch(/omits this process/);
  // BOTH backends are named: a fallback must never mask why the first one was not believed.
  expect(table.error).toMatch(/wmic: .*omits/);
  expect(table.error).toMatch(/powershell: .*omits/);
});

it("every backend's failure reaches the caller, and the message says what to do next", async () => {
  const seam = recorder({ powershell: fail("exit 1"), wmic: fail("ENOENT") });

  const table = await readProcessTable(seam.run, "win32", NO_BOUND_NEEDED, ROOT);

  expect(table.ok).toBe(false);
  if (table.ok) throw new Error("expected an enumeration failure");
  expect(table.error).toMatch(/wmic: ENOENT/);
  expect(table.error).toMatch(/powershell: exit 1/);
  expect(table.error).toMatch(/UNVERIFIED/);
  expect(table.error).toMatch(/reachable on PATH/);
  expect(table.error).toContain(String(ROOT));
});

// ---------- the parser ----------

it("both Windows column orders parse to the same rows, and the header is skipped", () => {
  // wmic prints CreationDate FIRST; the CIM query prints the two ids first. The parser keys off the first
  // two integer tokens, so neither order is privileged.
  const wmicStyle = [
    "CreationDate               ParentProcessId  ProcessId",
    "20260907143012.123456+000  1200             1412",
  ].join("\r\n");
  const cimStyle = "1200 1412 20260907143012.123456+000";

  expect(parseProcessRows(wmicStyle)).toEqual(parseProcessRows(cimStyle));
  expect(parseProcessRows(cimStyle)).toEqual([
    { createdAtMs: Date.UTC(2026, 8, 7, 14, 30, 12, 123), pid: 1412, ppid: 1200 },
  ]);
});

it("a timezone offset is applied, so a local stamp and a UTC stamp of the same instant agree", () => {
  // wmic reports local time with the offset EAST of UTC in minutes; the CIM query reports UTC with +000.
  const local = parseProcessRows("20260907170012.000000+180  1200  1412");
  const utc = parseProcessRows("1200 1412 20260907140012.000000+000");

  expect(local[0]?.createdAtMs).toBe(utc[0]?.createdAtMs);
  expect(local[0]?.createdAtMs).toBe(Date.UTC(2026, 8, 7, 14, 0, 12, 0));
});

it("a row whose creation time is missing keeps its ids and reports the time as unknown", () => {
  expect(parseProcessRows("0 4 -\r\n     0     8")).toEqual([
    { createdAtMs: undefined, pid: 4, ppid: 0 },
    { createdAtMs: undefined, pid: 8, ppid: 0 },
  ]);
});

it("blank lines, prose and single-column noise are skipped rather than misread", () => {
  expect(parseProcessRows("\r\n\r\nWMIC is deprecated.\r\n   \r\n42\r\n1200 1412 -")).toEqual([
    { createdAtMs: undefined, pid: 1412, ppid: 1200 },
  ]);
});

// ---------- the walk ----------

it("descendants are found through a root that is already absent from the table", () => {
  const rows = [row(0, process.pid), row(ROOT, CHILD), row(CHILD, GRANDCHILD), row(9, 9999)];

  const found = descendantsOf(ROOT, rows);

  expect([...found].sort()).toEqual([CHILD, GRANDCHILD].sort());
  expect(found).not.toContain(9999);
  expect(found).not.toContain(ROOT);
});

it("a sibling tree is never reached, however deep either one goes", () => {
  const rows = [row(1, ROOT), row(ROOT, CHILD), row(1, 7000), row(7000, 7001), row(7001, 7002)];

  expect(descendantsOf(ROOT, rows)).toEqual([CHILD]);
  expect([...descendantsOf(7000, rows)].sort()).toEqual([7001, 7002].sort());
});

it("a self-parenting row and a cycle cannot make the walk spin", () => {
  const rows = [row(0, 0), row(ROOT, CHILD), row(CHILD, ROOT), row(CHILD, GRANDCHILD)];

  expect([...descendantsOf(ROOT, rows)].sort()).toEqual([CHILD, GRANDCHILD].sort());
  expect(descendantsOf(0, [row(0, 0)])).toEqual([]);
});

it("a pid an hour older than its claimed parent is a stale link, not a child (review C1)", () => {
  // CHILD names ROOT as its ppid, but CHILD was created an HOUR BEFORE this incarnation of ROOT was. It
  // cannot be this root's descendant: it is a leftover row from a PREVIOUS, already-exited process that
  // happened to hold the pid ROOT now holds, still naming that old pid in its own ppid field the way a
  // Windows table keeps a dead parent's pid on its children (the same fact that lets this walk work
  // through an already-gone root at all). Swept into `taskkill /PID ROOT /PID CHILD /T /F` regardless, it
  // would be an unrelated process, explicitly targeted (codex cross-check probe: exit 0, `killCalls`
  // named both pids, `isDrained:true`).
  const rootCreatedAt = Date.UTC(2026, 8, 8, 9, 0, 0);
  const staleCreatedAt = Date.UTC(2026, 8, 8, 8, 0, 0);
  const rows: ProcessRow[] = [
    { createdAtMs: rootCreatedAt, pid: ROOT, ppid: 9 },
    { createdAtMs: staleCreatedAt, pid: CHILD, ppid: ROOT },
  ];

  const found = descendantsOf(ROOT, rows);

  expect(found).not.toContain(CHILD);
});

it("a genuine child, created after its parent, is still found once creation times are validated", () => {
  const rootCreatedAt = Date.UTC(2026, 8, 8, 9, 0, 0);
  const rows: ProcessRow[] = [
    { createdAtMs: rootCreatedAt, pid: ROOT, ppid: 9 },
    { createdAtMs: rootCreatedAt + 500, pid: CHILD, ppid: ROOT },
    { createdAtMs: rootCreatedAt + 900, pid: GRANDCHILD, ppid: CHILD },
  ];

  expect([...descendantsOf(ROOT, rows)].sort()).toEqual([CHILD, GRANDCHILD].sort());
});

it("a link is trusted, not rejected, when either side's creation time is unknown", () => {
  // The walk's whole reason to exist is working through a root ALREADY ABSENT from the table (no row, no
  // creation time to compare) — validating only when BOTH times are known preserves that, rather than
  // silently reintroducing a requirement the doc comment above explicitly drops.
  const rows: ProcessRow[] = [
    { createdAtMs: undefined, pid: ROOT, ppid: 9 },
    { createdAtMs: Date.UTC(2026, 8, 8, 8, 0, 0), pid: CHILD, ppid: ROOT },
  ];

  expect(descendantsOf(ROOT, rows)).toEqual([CHILD]);
});
