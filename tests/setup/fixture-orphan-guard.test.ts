/**
 * @file tests/setup/fixture-orphan-guard.test.ts
 * @purpose Falsifiers for the suite-level orphan gate, seam-injected so no process is spawned and no box
 *   is broken to test a broken box. Round 4 exists because all three of codex's findings were in this
 *   gate: a failed enumeration read as "no orphans", ownership judged by the immediate parent (which this
 *   suite kills on purpose), and a teardown that ran first instead of last. The first two are pinned here;
 *   the third is ordering in vitest.config.ts and is pinned by the order assertion at the end.
 * @exports (none — test file)
 * @depends node:fs, node:path, node:url, vitest, ../../src/shared/process-table, ./fixture-orphan-guard
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { SLOWEST_ENUMERATION_MS } from "../../src/shared/process-table.js";
import {
  FIXTURE_TOKEN,
  IDENTITY_PATTERN,
  QUERY_TIMEOUT_MS,
  type RunQuery,
  describeScan,
  scanFixtureOrphans,
} from "./fixture-orphan-guard.js";

const SELF = 4_242;
// Live owners have to be REAL pids, because the classifier probes liveness for real: this process for
// "one of mine", its parent for "alive but somebody else's". A made-up number is a DEAD owner, which is a
// different branch — the first draft of this file used 7_777 for a live owner and proved the wrong thing.
const LIVE_OTHER = process.ppid;
const DEAD_OWNER = 2_147_000_001; // far above any real allocation, so the liveness probe reads ESRCH

/** stdout in the gate's own wire shape. `self` is how many rows CIM matched for the asking pid. */
function stdout(rows: readonly string[], self = 1, nodes = 12): string {
  return [`CONTROL ${String(nodes)} ${String(self)}`, ...rows].join("\r\n");
}

const answering =
  (text: string): RunQuery =>
  async () => ({ code: undefined, ok: true, stdout: text });

// ---------- round-5 item 1 (F2): the bound derives from the ONE measured tail ----------

it("the scan bound is twice the shared enumeration tail, not a second copy of it", () => {
  // Rounds 3 and 4 declared `SLOWEST_CIM_ENUMERATION_MS = 18_055` in the guard, a second copy of the tail
  // that `process-table.ts` measured over 60 samples. Nothing asserted it: the constant's only appearance
  // in this file built an expected string, which tracks ANY value, so mutating the copy to 18_056 left all
  // 12 tests green. Two copies of one measurement cannot both be re-measured, and the one a human forgets
  // becomes a bound nobody took — so this asserts the RELATION to the imported tail, and a copy
  // re-introduced here fails it.
  expect(QUERY_TIMEOUT_MS).toBe(2 * SLOWEST_ENUMERATION_MS);
  // The multiplier is the derivation, so state it: a bound must not cut the largest honest sample.
  expect(QUERY_TIMEOUT_MS).toBeGreaterThan(SLOWEST_ENUMERATION_MS);
});

// ---------- item 1: an enumeration that cannot answer is not an answer ----------

const FAILURES: ReadonlyArray<readonly [string, string]> = [
  ["spawn error", "ENOENT"],
  ["timeout", `timed out after ${String(QUERY_TIMEOUT_MS)} ms`],
  ["non-zero exit", "exit 1"],
];

for (const [shape, code] of FAILURES) {
  it(`a ${shape} FAILS the teardown instead of reporting a clean box (round-4 item 1)`, async () => {
    // At f5b0e01 every one of these resolved "" and the gate reported zero orphans, so a box that could
    // not be queried passed exactly like a clean one — and codex's sandbox, whose CIM access was denied,
    // is a real machine where that happened.
    const scan = await scanFixtureOrphans({
      platform: "win32",
      run: async () => ({ code, ok: false, stdout: "" }),
      selfPid: SELF,
    });

    // Round-5 F4: this `toBeDefined` comes FIRST because without it a scan that reported a clean box
    // failed with vitest's "the given combination of arguments (undefined and string) is invalid for this
    // assertion" — a complaint about types, naming neither the shape nor why a clean box is wrong here.
    expect(
      scan.failure,
      `a ${shape} produced NO failure message, so this scan would be read as a clean box: the gate stopped failing closed and an unqueryable machine now passes like an empty one`,
    ).toBeDefined();
    expect(scan.failure).toContain(code);
    expect(scan.unowned).toEqual([]);
    const message = describeScan(scan);
    expect(message).toContain("could not verify the box");
    expect(message).toContain(code);
  });
}

it("stdout with no CONTROL line FAILS: the query never proved it read a table", async () => {
  // The shape `$ErrorActionPreference = 'SilentlyContinue'` used to produce: exit 0, empty stdout.
  const scan = await scanFixtureOrphans({ platform: "win32", run: answering(""), selfPid: SELF });

  expect(
    scan.failure,
    "stdout with no CONTROL line produced NO failure message: the gate accepted output that never proved it read a table, which is the one failure shape indistinguishable from a clean box",
  ).toBeDefined();
  expect(scan.failure).toContain("no CONTROL line");
  expect(describeScan(scan)).toContain("treat this run as unproven");
});

it("a table that cannot see the asking process FAILS the positive control", async () => {
  const scan = await scanFixtureOrphans({
    platform: "win32",
    run: answering(stdout([], 0, 31)),
    selfPid: SELF,
  });

  expect(
    scan.failure,
    "a table that never listed the asking process produced NO failure message: the positive control is gone, so a snapshot of some other machine (or of nothing) would be read as proof this box is clean",
  ).toBeDefined();
  expect(scan.failure).toContain("not this one");
  expect(scan.failure).toContain("31");
});

it("a query that ran and saw an empty table PASSES", async () => {
  const scan = await scanFixtureOrphans({
    platform: "win32",
    run: answering(stdout([])),
    selfPid: SELF,
  });

  expect(scan.failure).toBeUndefined();
  expect(describeScan(scan)).toBeUndefined();
});

// ---------- item 2: ownership, not parentage ----------

it("a fixture whose ROOT was killed but whose owner lives is NOT reported (round-4 item 2)", async () => {
  // What this suite does on purpose, a dozen times per run: kill a root and leave its descendants for the
  // sweep. Round 3 called each of those an orphan because their immediate parent was gone — including
  // another checkout's live tree, on a machine that runs three of them. Here pid 31000's parent 30000 is
  // gone and its owner LIVE_WORKER is alive and is not this process's child, so it is somebody else's
  // business and the gate says nothing.
  const scan = await scanFixtureOrphans({
    platform: "win32",
    run: answering(stdout([`ROW 31000 30000 ${String(LIVE_OTHER)}`])),
    selfPid: SELF,
  });

  expect(scan.unowned).toEqual([]);
  expect(scan.mine).toEqual([]);
  expect(describeScan(scan)).toBeUndefined();
});

it("a fixture whose OWNER is gone IS reported even while its immediate parent is alive", async () => {
  // The mirror image, and the 2026-09-12 shape: the tree's own root is still running (so a parent check
  // sees nothing wrong) while the worker that owned the pair has been killed. Nobody will clean it up.
  const scan = await scanFixtureOrphans({
    platform: "win32",
    run: answering(stdout([`ROW 31000 31001 ${String(DEAD_OWNER)}`])),
    selfPid: SELF,
  });

  expect(scan.unowned).toEqual([{ owner: DEAD_OWNER, pid: 31000, ppid: 31001 }]);
  const message = describeScan(scan);
  expect(message).toContain("whose OWNER is gone");
  expect(message).toContain("pid 31000");
});

it("a fixture owned by THIS run's own worker is reported: every test had already finished", async () => {
  // vitest tears global setups down BEFORE closing the pool (cli-api `close()`), so this run's workers are
  // still alive at this moment. A fixture one of them owns is therefore a leak, not a live run — without
  // this branch the gate would miss exactly the case where a worker survives but loses track of its tree.
  const self = process.pid; // a live owner that IS this run: the classifier seeds mineSet with selfPid
  const scan = await scanFixtureOrphans({
    platform: "win32",
    run: answering(stdout([`ROW 31000 ${String(self)} ${String(self)}`])),
    selfPid: self,
  });

  expect(scan.mine).toEqual([{ owner: self, pid: 31000, ppid: self }]);
  expect(describeScan(scan)).toContain("owned by THIS run and still alive");
});

// ---------- round-6 item 2: the FILTER itself, asserted over command lines ----------

// Until round 6 nothing tested the filtering step. The test that stood here injected output containing no
// ROW line and checked that nothing was reported, and its own comment admitted the circularity: "the proof
// that a non-fixture cannot reach this classifier is that no ROW line is ever emitted for one". It asserted
// the consequence by assuming the premise, so all 13 tests passed while the matcher had two live defects.
// These run the REAL exported pattern over REAL command lines, with no CIM, no PowerShell and no spawning.
//
// Every string below was measured on this box 2026-09-13 (.tmp-rb-r6/red-matcher.mjs), not invented.
const NODE = "C:\\\\Program Files\\\\nodejs\\\\node.exe";
const SCRIPT_TAIL = "setInterval(() => {}, 3600000);";

interface CommandLineCase {
  readonly what: string;
  readonly commandLine: string;
  readonly owner: number | undefined;
}

const COMMAND_LINES: readonly CommandLineCase[] = [
  {
    // (A) codex's false positive: a MENTION. The only marker is an example identity in a doc string, and
    // there is no identity argument at all. At a112717 this was reported as unowned with the owner read
    // out of the doc string, and the gate told the operator to kill it.
    commandLine: `${NODE} -e "const EXAMPLE = 'documentation-${FIXTURE_TOKEN}25392-example'; ${SCRIPT_TAIL}"`,
    owner: undefined,
    what: "a doc string carrying an example identity, with no identity argument",
  },
  {
    // (B) codex's false negative, the serious direction: an earlier token naming System (4, alive and
    // foreign) shadows the GENUINE trailing identity. At a112717 the gate read owner 4, judged it somebody
    // else's live run, and ignored a real leak silently.
    commandLine: `${NODE} -e "// names an identity: ${FIXTURE_TOKEN}4${String.fromCharCode(10)}${SCRIPT_TAIL}" ${FIXTURE_TOKEN}2008`,
    owner: 2008,
    what: "an earlier token shadowing the genuine trailing identity",
  },
  {
    // The check that matters most: an anchor that missed a real level would blind the gate completely.
    commandLine: `${NODE} -e "setTimeout(() => {}, 250);${String.fromCharCode(10)}${SCRIPT_TAIL}" ${FIXTURE_TOKEN}4732`,
    owner: 4732,
    what: "a real fixture ROOT",
  },
  {
    // The descendant the fixture spawns itself carries the same identity, forwarded as its own last argv
    // entry. Measured: root 7264 and descendant 36668 both read owner 40776.
    commandLine: `${NODE} -e "setTimeout(() => {}, 250);${String.fromCharCode(10)}${SCRIPT_TAIL}" ${FIXTURE_TOKEN}4732`,
    owner: 4732,
    what: "the DESCENDANT a fixture root spawns",
  },
  {
    // The round-4 impostor: a script that BUILDS the token. What follows the colon is a concatenation.
    commandLine: `${NODE} -e "const id = '${FIXTURE_TOKEN}' + owner; ${SCRIPT_TAIL}"`,
    owner: undefined,
    what: "a script that builds the token rather than publishing one",
  },
  {
    // Why `(?:^|\s)` and not end-anchoring alone: a longer word ENDING in token-plus-digits, last on
    // the line, is still a mention. End-anchoring by itself would accept this one.
    commandLine: `${NODE} -e "${SCRIPT_TAIL}" documentation-${FIXTURE_TOKEN}25392`,
    owner: undefined,
    what: "a longer word ending in the token, last on the command line",
  },
];

for (const probe of COMMAND_LINES) {
  const expectation =
    probe.owner === undefined ? "is NOT an identity" : `publishes owner ${String(probe.owner)}`;
  it(`${probe.what} ${expectation} (round-6 item 2)`, () => {
    const found = new RegExp(IDENTITY_PATTERN).exec(probe.commandLine);
    const read = found?.[1] === undefined ? undefined : Number(found[1]);

    expect(
      read,
      probe.owner === undefined
        ? `this command line is not a published identity, but the pattern read owner ${String(read)} from it: a MENTION is being treated as a publication, which is how a stranger gets reported and the operator told to kill it`
        : `this command line publishes owner ${String(probe.owner)} as its trailing argument, but the pattern read ${String(read)}: an owner read from the wrong place means a real leak is attributed to somebody else and ignored silently`,
    ).toBe(probe.owner);
  });
}

it("the query and the TypeScript assertion read the SAME pattern, byte for byte (round-6 item 2)", async () => {
  // The filter runs in PowerShell on purpose: a fixture's `-e` script contains newlines, so reading command
  // lines out here would break on them. That is why the two halves could drift, and why this exists: the
  // script the gate actually sends is captured through its own seam and must carry the exported pattern.
  let sent = "";
  const capture: RunQuery = async (script) => {
    sent = script;
    return { code: undefined, ok: true, stdout: stdout([], 1, 7) };
  };
  await scanFixtureOrphans({ platform: "win32", run: capture, selfPid: SELF });

  expect(
    sent,
    "the PowerShell query does not contain the exported pattern, so the command-line assertions above are testing a regex the gate no longer uses",
  ).toContain(IDENTITY_PATTERN);
  // `-cmatch`, not `-match`: `-match` is case-insensitive, so the query would accept identities the
  // TypeScript side rejects and the two halves would disagree on exactly the inputs nobody tests.
  expect(
    sent,
    "the query must match case-sensitively or it is not the pattern asserted above",
  ).toContain(`-cmatch '${IDENTITY_PATTERN}'`);
});

it("the fixture token carries no regex metacharacter, so the pattern cannot silently widen", () => {
  // The pattern is built by interpolating the token, which is safe only while the token is regex-inert.
  // A token containing `.` or `*` would widen the match without changing a line of the pattern.
  expect(FIXTURE_TOKEN, "the token is interpolated into a regex unescaped").toMatch(/^[\w:-]+$/);
});

it("a scan of a box holding no fixtures reports nothing", async () => {
  // The classifier half of what the deleted test checked, kept because it is a real property: given a
  // control line and no ROW lines, the gate says the box is clean rather than inventing a verdict.
  const scan = await scanFixtureOrphans({
    platform: "win32",
    run: answering(stdout([], 1, 40)),
    selfPid: SELF,
  });

  expect(scan.failure).toBeUndefined();
  expect(scan.unowned).toEqual([]);
  expect(scan.mine).toEqual([]);
  expect(describeScan(scan)).toBeUndefined();
});
// ---------- item 3: the gate's teardown is the LAST one to run ----------

it("the gate is registered FIRST, because vitest runs global-setup teardowns in reverse", () => {
  // vitest 3.2.4, cli-api.BkDphVBG.js:7090 —
  //   for (const globalSetupFile of [...this._globalSetups].reverse()) await globalSetupFile.teardown?.()
  // so "registered first" IS "torn down last", and that is what keeps a throw in this gate from skipping
  // the real-store fingerprint check and the worker-profile cleanup. Round 3 had it registered last.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const config = readFileSync(path.join(here, "..", "..", "vitest.config.ts"), "utf8");
  const registered = [...config.matchAll(/"\.\/tests\/setup\/([a-z-]+)\.ts"/g)].map((m) => m[1]);

  expect(registered[0]).toBe("fixture-orphan-guard");
  expect(registered).toContain("real-store-guard");
  // codex-home must still be the first file that DOES anything; this gate's setup does nothing.
  expect(registered[1]).toBe("codex-home-global");
  expect(registered.indexOf("worker-store-root")).toBeLessThan(
    registered.indexOf("real-store-guard"),
  );
});

it("the fixture publishes the identity this gate reads, and nothing weaker", () => {
  // A rename on either side would make the gate silently blind, which is the failure mode of every
  // grep-based check. Read from the fixture's own source rather than restated here.
  //
  // The path is the PRODUCER, `kill-tree-fixture.fixtures.ts`, not the test file beside it. Round 7 moved
  // the producer out of `kill-tree.test.ts` at the line clamp and this assertion kept passing against the
  // file it had left behind, because an unrelated pin there still mentioned the token. A grep-based check
  // reading the wrong file is the exact failure it exists to catch, so it now proves it read the right one
  // before believing anything about the contents.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fixture = readFileSync(
    path.join(here, "..", "..", "src", "shared", "kill-tree-fixture.fixtures.ts"),
    "utf8",
  );

  // Positive control: this is the file that carries the fixture, not merely a file lacking a string.
  expect(
    fixture,
    "the producer source was not found at the path this test reads, so every assertion below would pass or fail for the wrong reason",
  ).toContain("KILL_TREE_FIXTURE_DEPTH");

  // The fixture builds its identity FROM this module's export, so the binding is what matters rather than
  // a spelling repeated here: the root's trailing argv entry and the descendants' own inside FIXTURE_SRC.
  expect(fixture).toContain("FIXTURE_TOKEN");
  expect(fixture).toContain("fixtureIdentity()");
  // No leading dashes: node parses `--x=1` after an `-e` script as a node option and dies with "bad
  // option" (measured 2026-09-13); a bare token reaches process.argv untouched.
  expect(FIXTURE_TOKEN.startsWith("-")).toBe(false);
  // The token must not be a substring of the env var name, or item 7's whole point is lost.
  expect("KILL_TREE_FIXTURE_DEPTH").not.toContain(FIXTURE_TOKEN);
});
