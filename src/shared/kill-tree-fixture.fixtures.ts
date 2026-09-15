/**
 * @file src/shared/kill-tree-fixture.fixtures.ts
 * @purpose The PRODUCER half of kill-tree.test.ts's real process tree, extracted at the 500-line clamp in
 *   round 7: the script each level runs, the identity it publishes about itself, and the sweep that reaps
 *   what it started. One contract with `tests/setup/fixture-orphan-guard.ts`, whose match is anchored to the
 *   TRAILING argument — so where this file puts the identity decides whether a leak is visible at all.
 * @exports FIXTURE_REPORT_BUDGET_MS, FixtureTree, fixtureIdentity, fixtureArgv, startFixtureTree,
 *   sweepSpawnedFixtures
 * @depends node:child_process, node:process, ../../tests/setup/fixture-orphan-guard
 *
 * The assertions pinning that placement live in kill-tree.test.ts, which consumes this. Nothing here is
 * exported unless something outside the file reads it: the fixture source, the owner-watch interval and the
 * lifetime cap are all private. FIXTURE_SRC was exported until round 7c, for a test that read it as text;
 * 7b replaced that test with one driving the real gate, which removed its last reader and left the export
 * behind. An export nothing imports is what round 4b removed from the gate and what codex found here, and
 * no gate catches one (round 5, measured) — so the check is `grep` for the identifier, by hand, per change.
 */
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import { FIXTURE_TOKEN } from "../../tests/setup/fixture-orphan-guard.js";

const OWNER_WATCH_INTERVAL_MS = 250;
const FIXTURE_MAX_LIFETIME_MS = 600_000;
const FIXTURE_SRC = `
const { spawn } = require("node:child_process");
const depth = Number(process.env.KILL_TREE_FIXTURE_DEPTH || "0");
const owner = Number(process.env.KILL_TREE_FIXTURE_OWNER || "0");
process.stdout.write("PID " + process.pid + "\\n");
if (depth > 0) {
  const child = spawn(process.execPath, ["-e", process.env.KILL_TREE_FIXTURE_SRC, "${FIXTURE_TOKEN}" + owner], {
    env: Object.assign({}, process.env, { KILL_TREE_FIXTURE_DEPTH: String(depth - 1) }),
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
    detached: true,
  });
  child.unref();
  child.on("error", (e) => { process.stderr.write("FIXTURE_SPAWN_ERROR " + e.message + "\\n"); });
}
const quit = () => { process.exit(0); };
setTimeout(quit, ${String(FIXTURE_MAX_LIFETIME_MS)}).unref();
setInterval(() => {
  if (owner > 0) {
    try { process.kill(owner, 0); } catch (e) { if (e.code === "ESRCH") quit(); }
  }
}, ${String(OWNER_WATCH_INTERVAL_MS)});
`;

/**
 * The identity every level publishes on its COMMAND LINE, not just in its env: the fixture token plus the
 * pid of the worker that owns the tree. node ignores a trailing argv entry after an `-e` script, and
 * Win32_Process reports a command line but never an environment, so this is the only place
 * `fixture-orphan-guard` can read either fact. It is what lets the gate judge a stray fixture by its OWNER
 * rather than by its immediate parent, which this suite kills on purpose (round-4 item 2), and what lets it
 * tell a real fixture from any script that merely mentions the env var (round-4 item 7).
 */
export function fixtureIdentity(): string {
  return `${FIXTURE_TOKEN}${String(process.pid)}`;
}

/**
 * The root level's argv, extracted so a test can assert the ONE property the gate depends on and no
 * matcher test can see: the identity is the LAST argument. Round-6's six command-line cases pin how the
 * gate READS an identity; nothing pinned where this producer PUTS it, so appending any argument here would
 * make every fixture invisible to the gate with all of those tests still green — the silent direction.
 */
export function fixtureArgv(): readonly string[] {
  return ["-e", FIXTURE_SRC, fixtureIdentity()];
}

const spawnedPids: number[] = [];

export interface FixtureTree {
  readonly pids: number[];
  readonly waitForRootExit: () => Promise<void>;
}

/**
 * Hang bound on one fixture tree reporting every level.
 *
 * Round-2 item 5 (codex finding 3) rewrote this derivation. The number it replaces, 8 × 1_264 ms, was a
 * multiplier PICKED to clear a value that had fired — 6 × would have cleared it too, which is what makes
 * the 8 arbitrary. Both inputs are stated for what they are instead: 1_264 ms is the slowest of 68
 * uncensored three-deep spawn samples taken on this box 2026-09-12 with this deadline lifted (56 during
 * eight real runs of this file: min 202, median 247, p90 332, max 422 ms; 12 more from a sequential
 * in-process probe, whose max is the 1_264), and 7_500 ms is a CENSORED observation — the old deadline
 * fired at it ("fixture reported 0/3 pids within 7500 ms"), so the true need that run was at least that
 * and is otherwise unknown. A bound may not cut either one, so it is twice the larger, and the larger is
 * the censored floor. Uncensoring it would need a slow fixture spawn caught with the deadline lifted,
 * which 68 samples did not produce.
 */
const SLOWEST_FIXTURE_SPAWN_MS = 1_264;
const CENSORED_FIXTURE_FLOOR_MS = 7_500;
export const FIXTURE_REPORT_BUDGET_MS: number =
  2 * Math.max(SLOWEST_FIXTURE_SPAWN_MS, CENSORED_FIXTURE_FLOOR_MS);
/** Starts a `levels`-deep tree and resolves once every level has reported its own pid. */
export async function startFixtureTree(levels: number): Promise<FixtureTree> {
  const child = spawn(process.execPath, [...fixtureArgv()], {
    env: {
      ...process.env,
      KILL_TREE_FIXTURE_DEPTH: String(levels - 1),
      KILL_TREE_FIXTURE_OWNER: String(process.pid),
      KILL_TREE_FIXTURE_SRC: FIXTURE_SRC,
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  // Registered for the afterEach sweep the MOMENT a level reports, never after the whole tree is up:
  // a fixture that times out half-formed would otherwise leak the levels that did start onto the box.
  const pids: number[] = [];
  if (child.pid !== undefined) spawnedPids.push(child.pid);
  let stderrText = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrText += chunk.toString();
  });
  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    let buffered = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      for (const line of buffered.split("\n")) {
        const match = /^PID (\d+)$/.exec(line.trim());
        const seen = match?.[1];
        if (seen === undefined || pids.includes(Number(seen))) continue;
        pids.push(Number(seen));
        spawnedPids.push(Number(seen));
      }
      if (pids.length === levels) resolve();
    });
    setTimeout(() => {
      reject(
        new Error(
          `fixture reported ${String(pids.length)}/${String(levels)} pids within ` +
            `${String(FIXTURE_REPORT_BUDGET_MS)} ms; stderr=${stderrText}`,
        ),
      );
    }, FIXTURE_REPORT_BUDGET_MS).unref();
  });
  return { pids, waitForRootExit: () => waitForExit(child) };
}

function waitForExit(child: { exitCode: number | null; on: (e: "exit", fn: () => void) => void }) {
  return new Promise<void>((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.on("exit", () => resolve());
  });
}

/**
 * Best-effort reaping of every level this module started, for the consuming suite's `afterEach`. It lives
 * beside the registry it drains rather than in the test file, because a sweep that cannot see every pid
 * this module pushed is not a sweep. It is cleanup and never a proof: a pid gone between the probe and the
 * kill is the ordinary case, and the gate in tests/setup is what actually decides whether the box is clean.
 */
export function sweepSpawnedFixtures(): void {
  for (const pid of spawnedPids.splice(0)) {
    if (!processAlive(pid)) continue;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { shell: false, windowsHide: true });
      continue;
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone between the probe and the kill; the sweep is best-effort cleanup, never a proof.
    }
  }
}

/** Liveness by signal 0: existence only, never a kill. Duplicated from the test's `alive` on purpose —
 * the sweep must not depend on the assertions it cleans up after. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code !== "ESRCH";
  }
}
