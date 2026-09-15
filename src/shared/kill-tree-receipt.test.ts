/**
 * @file src/shared/kill-tree-receipt.test.ts
 * @purpose The receipt half of the drain, seam-injected so it needs no real processes and runs in
 *   milliseconds: an accounting failure carries the unknown instead of an empty tree, a recycled root pid is
 *   refused rather than drained, the pid guard bites before anything is spawned, and the wait is a polled
 *   deadline rather than a sleep — including the one property no in-process test can see, that a drain with
 *   a survivor still settles when the poll is the only pending work (that one runs in a real child, because
 *   vitest holds the event loop open and would hide it). Enumeration itself is process-table.test.ts.
 * @exports (none — test file)
 * @depends node:child_process, node:process, vitest, ./kill-tree, ./process-table
 */
import { spawn } from "node:child_process";
import process from "node:process";
import { expect, it } from "vitest";
import {
  KILL_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  VERIFY_DEADLINE_MS,
  isDrained,
  killTreeVerified,
} from "./kill-tree.js";
import {
  type CommandOutcome,
  ENUMERATE_TIMEOUT_MS,
  MAX_BACKEND_ATTEMPTS,
  READ_TABLE_TIMEOUT_MS,
  SLOWEST_ENUMERATION_MS,
  wholeReadBound,
} from "./process-table.js";

const ROOT = 4242;
const CHILD = 5555;

const ok = (stdout: string): CommandOutcome => ({ code: undefined, ok: true, stdout });
const fail = (code: string): CommandOutcome => ({ code, ok: false, stdout: "" });

/** A CIM_DATETIME stamp in UTC, the shape both enumeration backends emit. */
function cimStamp(atMs: number): string {
  const at = new Date(atMs);
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  const date = `${String(at.getUTCFullYear())}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}`;
  const time = `${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`;
  return `${date}${time}.${pad(at.getUTCMilliseconds() * 1000, 6)}+000`;
}

function table(rows: ReadonlyArray<readonly [number, number, number | undefined]>): string {
  const self = `0 ${String(process.pid)} -`;
  const body = rows.map(
    ([ppid, pid, at]) => `${String(ppid)} ${String(pid)} ${at === undefined ? "-" : cimStamp(at)}`,
  );
  return [self, ...body].join("\r\n");
}

// ---------- an absent signal is never an empty tree ----------

it("an enumeration failure with a LIVE root reports the unknown and still attempts the reachable kill", async () => {
  const attempted: string[] = [];

  // Pinned "win32": this asserts the wmic/powershell/taskkill sequence specifically, and the forced kill it
  // proves goes through ctx.run, not ctx.killPosix — a claim that is only true on this platform (review C3).
  const receipt = await killTreeVerified(ROOT, {
    isAlive: () => true,
    platform: "win32",
    async runCommand(cmd): Promise<CommandOutcome> {
      attempted.push(cmd);
      return cmd === "taskkill" ? ok("") : fail("ENOENT");
    },
    verifyDeadlineMs: 100,
  });

  expect(receipt.accounted).toBe(false);
  if (receipt.accounted) throw new Error("expected an unaccounted receipt");
  expect(receipt.error).toMatch(/ENOENT/);
  expect(receipt.forced).toBe(true);
  expect(attempted).toEqual(["wmic", "powershell", "taskkill"]);
  expect(isDrained(receipt)).toBe(false);
});

it("an enumeration failure with a root that already exited carries NO survivor list at all", async () => {
  // The production shape: the launcher exits, descendants remain, and the table cannot be read. Nothing
  // is reachable, so the receipt must say "unaccounted" — never "survivors: []", which an operator's
  // ladder would render as an empty pid list while their machine still has orphans running on it.
  const receipt = await killTreeVerified(ROOT, {
    isAlive: () => false,
    runCommand: async () => fail("ENOENT"),
    verifyDeadlineMs: 100,
  });

  expect(receipt.accounted).toBe(false);
  if (receipt.accounted) throw new Error("expected an unaccounted receipt");
  expect("survivors" in receipt).toBe(false);
  expect("enumerated" in receipt).toBe(false);
  expect(receipt.forced).toBe(false);
  expect(receipt.rootExited).toBe(true);
  expect(isDrained(receipt)).toBe(false);
});

it("a hung enumerator is bounded, and that bound is the reason the receipt gives", async () => {
  const receipt = await killTreeVerified(ROOT, {
    isAlive: () => false,
    runCommand: async (_cmd, _args, timeoutMs) => fail(`timed out after ${String(timeoutMs)} ms`),
    verifyDeadlineMs: 100,
  });

  expect(receipt.accounted).toBe(false);
  if (receipt.accounted) throw new Error("expected an unaccounted receipt");
  expect(receipt.error).toMatch(new RegExp(`timed out after ${String(ENUMERATE_TIMEOUT_MS)} ms`));
});

it("a drained tree names the kill's own bound, so a hung taskkill cannot stall a shutdown", async () => {
  const bounds: number[] = [];

  await killTreeVerified(ROOT, {
    isAlive: () => false,
    async runCommand(_cmd, _args, timeoutMs): Promise<CommandOutcome> {
      bounds.push(timeoutMs);
      return ok(table([[1, ROOT, undefined]]));
    },
  });

  expect(bounds[0]).toBe(ENUMERATE_TIMEOUT_MS);
  expect(bounds).not.toContain(Number.POSITIVE_INFINITY);
  expect(KILL_TIMEOUT_MS).toBeGreaterThan(0);
});

// ---------- POSIX termination is injectable, exactly like the Windows taskkill seam ----------

// A pid that (virtually) cannot exist, same reasoning as kill-tree.test.ts's GONE_PID: real Windows and
// POSIX allocations stay far below this. Used only as a decoy target — the point of this test is that the
// real syscall is never reached at all, so what pid it names does not matter, but an implausible one keeps
// the intent honest.
const IMPOSSIBLE_PID = 2_147_000_001;

it("a POSIX kill goes through the injected killPosix seam, never a real signal (review C3)", async () => {
  // This file's whole premise is that it "needs no processes and runs in milliseconds" (file header). On
  // win32 that already held for the POSIX branch, because nothing here ever took it. On a non-Windows host
  // — including the Ubuntu runner .github/workflows/verify.yml targets — killAll's non-Windows branch
  // called process.kill(pid, "SIGKILL") on these tests' FIXED, made-up pids directly, with no seam to
  // intercept it (codex cross-check probe: intercepted real SIGKILL calls against 4242 and 5555). Proven
  // here by temporarily replacing the real process.kill with a recorder and restoring it immediately after
  // — the same technique the review used to demonstrate it, and safe regardless of the pid because the
  // replacement means no real syscall happens either way while it is in place.
  const posixCalls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const realKillCalls: unknown[] = [];
  const originalKill = process.kill.bind(process);
  process.kill = ((...args: Parameters<typeof process.kill>) => {
    realKillCalls.push(args);
    return true;
  }) as typeof process.kill;

  try {
    const receipt = await killTreeVerified(IMPOSSIBLE_PID, {
      isAlive: () => true,
      platform: "linux",
      killPosix: (pid, signal) => {
        posixCalls.push({ pid, signal });
      },
      runCommand: async () => ok(table([[9, IMPOSSIBLE_PID, undefined]])),
      verifyDeadlineMs: 100,
    });

    expect(receipt.accounted).toBe(true);
    // The drain's own record of what it killed must come from the INJECTED seam...
    expect(posixCalls).toEqual([{ pid: IMPOSSIBLE_PID, signal: "SIGKILL" }]);
    // ...and the real process-signalling primitive must never be reached at all.
    expect(realKillCalls).toEqual([]);
  } finally {
    process.kill = originalKill;
  }
});

// ---------- the pid guard ----------

it.each([0, -1, 1.5, Number.NaN])("pid %s is refused before anything is spawned", async (pid) => {
  await expect(killTreeVerified(pid)).rejects.toThrow(/positive integer process id/);
});

// ---------- the wait is a polled deadline, not a sleep ----------

it("the wait ends as soon as the last pid reports gone, well inside the deadline", async () => {
  let probes = 0;

  const started = Date.now();
  // Pinned "win32": this test is about the poll loop, not the kill mechanism, but isAlive starts true, so a
  // real kill IS attempted here — pinning keeps it going through the mocked runCommand on every host rather
  // than the platform-default POSIX branch (review C3).
  const receipt = await killTreeVerified(ROOT, {
    isAlive: () => {
      probes += 1;
      return probes <= 4;
    },
    platform: "win32",
    pollIntervalMs: 10,
    runCommand: async () =>
      ok(
        table([
          [1, ROOT, undefined],
          [ROOT, CHILD, undefined],
        ]),
      ),
    verifyDeadlineMs: 10_000,
  });
  const elapsed = Date.now() - started;

  expect(receipt.accounted).toBe(true);
  if (!receipt.accounted) throw new Error(receipt.error);
  expect(receipt.survivors).toEqual([]);
  // An implementation that slept its budget would take 10 s; polling returns in tens of milliseconds.
  expect(elapsed).toBeLessThan(1_000);
  expect(probes).toBeGreaterThan(2);
});

it("a pid that never dies is reported as a survivor once the deadline passes, not waited on forever", async () => {
  const started = Date.now();
  // Pinned "win32" for the same reason as the test above: isAlive is always true here, so the forced kill
  // is real, and must go through the mocked runCommand rather than the platform-default branch.
  const receipt = await killTreeVerified(ROOT, {
    isAlive: () => true,
    platform: "win32",
    pollIntervalMs: 10,
    runCommand: async () =>
      ok(
        table([
          [1, ROOT, undefined],
          [ROOT, CHILD, undefined],
        ]),
      ),
    verifyDeadlineMs: 200,
  });
  const elapsed = Date.now() - started;

  expect(receipt.accounted).toBe(true);
  if (!receipt.accounted) throw new Error(receipt.error);
  expect([...receipt.survivors].sort()).toEqual([ROOT, CHILD].sort());
  expect(isDrained(receipt)).toBe(false);
  expect(elapsed).toBeGreaterThanOrEqual(200);
  expect(elapsed).toBeLessThan(5_000);
});

it("every budget is twice the slowest run it was sized against, so lowering a measurement lowers it", () => {
  // These are the numbers the constants' own comments quote; a budget that stops deriving from its
  // measurement fails here rather than drifting into a round number nobody measured.
  const slowestForcedKillMs = 1_498;
  // The enumeration tail is NOT re-declared here (round-5 F2: it had three homes and nothing coupled
  // them). It is imported, and this is the one place that pins the IMPORTED constant to the measurement
  // its own comment documents — 18_055 ms, the largest of 60 enumerations logged with the deadline
  // lifted, all of which succeeded; was 5_428 ms, taken when wmic still existed on this box. So a
  // re-measurement reaches every bound through one edit, and reaches a human through this line.
  expect(SLOWEST_ENUMERATION_MS).toBe(18_055);
  expect(VERIFY_DEADLINE_MS).toBe(2 * slowestForcedKillMs);
  expect(KILL_TIMEOUT_MS).toBe(2 * slowestForcedKillMs);
  expect(ENUMERATE_TIMEOUT_MS).toBe(2 * SLOWEST_ENUMERATION_MS);
  expect(POLL_INTERVAL_MS).toBeLessThan(VERIFY_DEADLINE_MS / 10);
});

it("a WHOLE read is bounded by every backend it may try, not by one of them (round-3 item 2)", () => {
  // Round 2 added `wholeReadBound` and `READ_TABLE_TIMEOUT_MS` and asserted on NEITHER, so setting
  // MAX_BACKEND_ATTEMPTS to 1 — which silently restores the exact under-budget round 2 existed to fix,
  // because `readProcessTable` hands each backend the full per-attempt bound in turn — passed all 39
  // seam tests. The reviewer's 2 -> 1 mutation is what this exists to fail.
  expect(MAX_BACKEND_ATTEMPTS).toBe(2); // wmic, then PowerShell's CIM query: the longer backend list
  expect(READ_TABLE_TIMEOUT_MS).toBe(MAX_BACKEND_ATTEMPTS * ENUMERATE_TIMEOUT_MS);
  expect(wholeReadBound(1_000)).toBe(MAX_BACKEND_ATTEMPTS * 1_000);
  // The number every caller's own budget has to clear, spelled out so a reader sees what it costs.
  expect(READ_TABLE_TIMEOUT_MS + KILL_TIMEOUT_MS + VERIFY_DEADLINE_MS).toBe(78_212);
});

// ---------- the property vitest cannot see ----------

const MODULE_URL = new URL("./kill-tree.js", import.meta.url).href.replace(/\.js$/, ".ts");

// Node strips types from a .ts file it is handed, but does not rewrite the ".js" specifiers TypeScript
// requires under NodeNext, so the module's own import of ./process-table.js would not resolve. The
// registerHooks call maps that one case and nothing else; it is scaffolding for the child, not behaviour
// under test. Pinned "win32": isAlive is always true, so this forces a real kill attempt inside the child
// process. Unpinned, a non-Windows host running this suite would default to the real POSIX branch and
// signal these fixed, made-up pids directly (review C3) — this test is about the timer/ref behaviour, not
// platform-specific kill mechanics, so pinning removes that exposure without changing its intent.
function survivorPollDriverScript(): string {
  return [
    'import { registerHooks } from "node:module";',
    "registerHooks({",
    "  resolve(specifier, context, nextResolve) {",
    '    if (!specifier.startsWith(".") || !specifier.endsWith(".js")) {',
    "      return nextResolve(specifier, context);",
    "    }",
    '    return nextResolve(specifier.replace(/\\.js$/, ".ts"), context);',
    "  },",
    "});",
    `const { killTreeVerified } = await import(${JSON.stringify(MODULE_URL)});`,
    "const receipt = await killTreeVerified(4242, {",
    "  isAlive: () => true,",
    '  platform: "win32",',
    '  runCommand: async () => ({ ok: true, code: undefined, stdout: "0 " + process.pid + "\\n4242 5555\\n" }),',
    "  verifyDeadlineMs: 250,",
    "  pollIntervalMs: 25,",
    "});",
    'process.stdout.write("RECEIPT " + JSON.stringify(receipt));',
  ].join("\n");
}

it("a drain with a survivor still returns a receipt when the poll is the only pending work", async () => {
  // vitest holds the event loop open for the whole run, so an unref'd poll timer looks fine in here and
  // is fatal outside it. This runs the drain in a real child with nothing else pending: with the timer
  // unref'd the child exited 13 with the promise unsettled and printed no receipt at all.
  const driver = survivorPollDriverScript();

  const child = spawn(process.execPath, ["--input-type=module", "-e", driver], {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
  });

  expect(`${String(exitCode)} ${stderr}`).toBe("0 ");
  expect(stdout).toMatch(/^RECEIPT /);
  const receipt = JSON.parse(stdout.slice("RECEIPT ".length)) as { survivors: number[] };
  expect([...receipt.survivors].sort()).toEqual([4242, 5555].sort());
});
