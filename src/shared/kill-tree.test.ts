/**
 * @file src/shared/kill-tree.test.ts
 * @purpose Contract for the extracted killTree primitive via the runKill seam, and for the DRAIN RECEIPT
 *   against REAL three-deep process trees (root -> child -> grandchild, the descendants detached the way a
 *   launcher's re-exec'd server is): today's killTree reports success while two descendants keep running,
 *   killTreeVerified reports them, one seat's drain leaves another's alone, and a repeat is idempotent.
 *   The seam-injected half — accounting failure, positive control, backend order, identity, budgets — is in
 *   kill-tree-receipt.test.ts, which needs no processes and runs in milliseconds.
 * @exports (none — test file)
 * @depends node:child_process, node:process, vitest, ./kill-tree, ./process-table
 */
import process from "node:process";
import { afterEach, expect, it } from "vitest";
import {
  IDENTITY_PATTERN,
  QUERY_TIMEOUT_MS,
  scanFixtureOrphans,
} from "../../tests/setup/fixture-orphan-guard.js";
import {
  FIXTURE_REPORT_BUDGET_MS,
  type FixtureTree,
  fixtureArgv,
  fixtureIdentity,
  startFixtureTree,
  sweepSpawnedFixtures,
} from "./kill-tree-fixture.fixtures.js";
import {
  type DrainReceipt,
  KILL_TIMEOUT_MS,
  VERIFY_DEADLINE_MS,
  isDrained,
  killTree,
  killTreeVerified,
} from "./kill-tree.js";
import {
  ENUMERATE_TIMEOUT_MS,
  type ProcessTableResult,
  READ_TABLE_TIMEOUT_MS,
  readProcessTable,
  runCommand,
  wholeReadBound,
} from "./process-table.js";

// The real-fixture tests below rest on Windows-specific process-table facts this repo's own doc comment
// states — a dead parent's pid survives in its children's ParentProcessId (process-table.ts:220-224),
// which is how a launcher's orphans are found after it exits, and which POSIX does not do (an orphan is
// re-parented to init/launchd instead). identityChecked's real-tree pass also depends on Win32_Process
// CreationDate, absent from POSIX's ps entirely (bound (e), review C4). Guarded rather than adjusted for
// POSIX (review B3): this repo runs npm test on both windows-latest and ubuntu-latest
// (.github/workflows/verify.yml), and killTree's own runKill-seam tests just above stay unguarded —
// nothing about THEM depends on the platform, only the real fixture trees below do.
const WIN32_ONLY = process.platform === "win32";

// A pid that (virtually) cannot exist: Windows pids are DWORDs but real allocations stay far below this,
// and POSIX pid_max defaults cap well under it. stillAlive() then reads ESRCH = verifiably gone.
const GONE_PID = 2_147_000_001;

// Each level prints its own pid on the stdout it inherits from the root, then stays alive on a timer.
// `detached: true` on the descendants is what makes this fixture model the real failure: it is the
// launcher-re-execs shape the live Antigravity probe captured (agy-acp-probe/captures/10-lifecycle.json
// — the spawned launcher returned in 106 ms and two descendants kept running). Measured on this box
// 2026-09-07: with `detached: false` the whole tree died with the root inside 500 ms and there was
// nothing left to drain; with `detached: true` both descendants outlived it in every run.
//
// Every level ALSO dies with the TEST, and the two lifetimes are deliberately different because they
// answer opposite questions. Outliving the ROOT is this fixture's subject. Outliving the TEST is a leak:
// vitest kills a worker that misses the 60 s birpc deadline, the afterEach sweep lives in that worker
// and dies with it, and the detached descendants are then owned by nobody — 42 of them, holding 2.3 GB,
// were found on the operator's machine at 23:2x on 2026-09-12 and swept by hand. Reproduced without
// vitest by killing a stand-in worker with `taskkill /PID <it> /F` and no `/T`: 2 of 3 levels survived.
//
// The lifeline is a pid watch, NOT the stdin pipe round 3's brief proposed. The pipe was tried first and
// measured structurally unable to express this: node destroys a child's stdio streams when that child
// exits, so the write end of the root's stdin closes with the root, and descendants sharing that read
// end take EOF and die with it — both tests below that need descendants to OUTLIVE their root failed
// with the pipe leg in, and pass without it. Each level therefore polls the OWNER's pid and exits within
// OWNER_WATCH_INTERVAL_MS of it disappearing, which killing the root cannot trigger because the owner is
// the worker. The absolute TTL is the second leg, for the one case a pid watch cannot see — the owner's
// pid recycled onto a live process. No fixture has business outliving the run by ten minutes; the
// longest budget any test here holds is under three.

// Every budget in this file is DERIVED from what the code under test is ALLOWED to take, never from how
// long a run happened to need. vitest.config.ts's blanket 30_000 ms was neither: one drain may legally
// spend READ_TABLE_TIMEOUT_MS enumerating, KILL_TIMEOUT_MS killing and VERIFY_DEADLINE_MS verifying, so a
// test performing two drains was handed less than half the time its own production path is entitled to.
// That is how this file failed: run 10 of round 1's second ten died as "Test timed out in 30000ms" on the
// drain-twice test. A budget below this sum fails while the code under test is still inside its contract,
// which is the one thing a budget must never do.
//
// Round-2 F4 correction: the enumeration term was ENUMERATE_TIMEOUT_MS, which is the bound on ONE BACKEND
// ATTEMPT, not on a read. `readProcessTable` tries every backend for the platform in turn and gives each
// the whole per-attempt bound, so the read is entitled to twice that on Windows and these budgets were
// short by one full attempt — the same class of error as the 30_000 ms blanket, one level down.
const ONE_DRAIN_MS = READ_TABLE_TIMEOUT_MS + KILL_TIMEOUT_MS + VERIFY_DEADLINE_MS;
/**
 * Room for the failure path's own table read (see `assertDrained`), which is ONE read shared by every
 * survivor rather than one per survivor — codex finding 3's structural point, measured there at three
 * PowerShell starts and 106_379 ms for a three-survivor receipt, which the outer timeout would have cut
 * before the message printed. Each attempt inside that read gets half the production per-attempt bound:
 * a diagnostic that gives up still reports "table unreadable", which is more than the bare assertion it
 * replaced, whereas a production drain giving up leaks a process tree.
 */
const DIAGNOSTIC_PER_ATTEMPT_MS = ENUMERATE_TIMEOUT_MS / 2;
const DIAGNOSTIC_ALLOWANCE_MS = wholeReadBound(DIAGNOSTIC_PER_ATTEMPT_MS);

/**
 * Outer budget for a test that starts `trees` fixture trees and performs `drains` verified drains.
 * Spending FIXTURE_REPORT_BUDGET_MS per tree (rather than the raw spawn measurement) is what preserves
 * the ordering the old comment wanted: a test's budget exceeds the fixture budget inside it by exactly
 * the drain and diagnostic allowances, so a half-formed fixture always prints its own diagnostic and the
 * generic outer timeout never wins the race.
 */
function budgetFor(trees: number, drains: number): number {
  return trees * FIXTURE_REPORT_BUDGET_MS + drains * ONE_DRAIN_MS + DIAGNOSTIC_ALLOWANCE_MS;
}

/** Liveness read INDEPENDENTLY of any kill's exit status: signal 0 probes existence only. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** The pid every fixture assertion is about; `pids[i]` is `number | undefined` to the compiler only. */
function at(tree: FixtureTree, index: number): number {
  const pid = tree.pids[index];
  if (pid === undefined) throw new Error(`fixture has no pid at index ${String(index)}`);
  return pid;
}

/**
 * Unwraps an accounted receipt, or throws the reason the drain itself reported.
 *
 * ORDERING IS LOAD-BEARING, not style. Every site in this file used to read `expect(receipt.accounted)
 * .toBe(true)` and only THEN `if (!receipt.accounted) throw new Error(receipt.error)` — so the expect
 * always fired first and the throw carrying the receipt's own error (the per-backend failure reasons, the
 * only text that says WHY enumeration failed) was unreachable in every run that ever hit it. Two failures
 * were lost to exactly that: the 2026-09-08 receipt on tree a816aedb and run 7 of this lane's own ten
 * (2026-09-12), both reporting nothing but "expected false to be true". The unwrap comes first now.
 */
function accounted(receipt: DrainReceipt): Extract<DrainReceipt, { accounted: true }> {
  if (!receipt.accounted) {
    throw new Error(
      `drain of pid ${String(receipt.rootPid)} is UNACCOUNTED (forced=${String(receipt.forced)}, ` +
        `rootExited=${String(receipt.rootExited)}): ${receipt.error}`,
    );
  }
  return receipt;
}

/**
 * Asserts a drain is PROVEN, and when it is not, names every survivor against a FRESH table read.
 *
 * It reports state AT DIAGNOSTIC TIME and says so, which is a correction to its first version (round-2
 * codex finding 2, reproduced there with a real child still alive when the receipt was built and
 * labelled FALSE by this helper). A survivor missing from a table read taken after the fact proves
 * nothing about the verify deadline: the process may have been genuinely alive then and exited in the
 * interval, which is a real leak the label would have talked the reader out of. So the diagnostic adds
 * information and NEVER exonerates the verification — the receipt stays the verdict, this is context for
 * it. The extra read costs one enumeration and is paid on the FAILURE path only.
 */
async function assertDrained(receipt: DrainReceipt): Promise<void> {
  const proven = accounted(receipt);
  if (isDrained(proven)) return;
  // ONE snapshot for every survivor: a read per survivor multiplies a PowerShell start by the length of
  // the very list that says something went wrong (codex finding 3).
  const table = await readProcessTable(
    runCommand,
    process.platform,
    DIAGNOSTIC_PER_ATTEMPT_MS,
    proven.rootPid,
  );
  const described = proven.survivors.map((pid) => describeSurvivor(pid, table));
  throw new Error(
    `drain of pid ${String(proven.rootPid)} left ${String(proven.survivors.length)} of ` +
      `${String(proven.enumerated.length)} enumerated pids alive at the verify deadline: ` +
      `${described.join("; ")}`,
  );
}

function describeSurvivor(pid: number, table: ProcessTableResult): string {
  const probe = alive(pid) ? "probe=alive" : "probe=gone";
  if (!table.ok) return `${String(pid)} (fresh table unreadable: ${table.error}, ${probe})`;
  const row = table.rows.find((candidate) => candidate.pid === pid);
  if (row === undefined) {
    return (
      `${String(pid)} (absent from a table read AFTER the deadline, so it is gone now; whether it was ` +
      `alive AT the deadline is unknown and the receipt's survivor finding stands, ${probe})`
    );
  }
  return `${String(pid)} (still listed: ppid ${String(row.ppid)}, createdAtMs ${String(row.createdAtMs)}, ${probe})`;
}

afterEach(sweepSpawnedFixtures);

it("a successful kill resolves without throwing and the seam receives the target pid", async () => {
  const killed: number[] = [];
  await killTree(1234, {
    runKill: (pid) => {
      killed.push(pid);
      return { ok: true, code: undefined };
    },
  });
  expect(killed).toEqual([1234]);
});

it("an already-gone target (ESRCH) is swallowed — idempotent reaping never throws", async () => {
  await expect(
    killTree(GONE_PID, { runKill: () => ({ ok: false, code: "ESRCH" }) }),
  ).resolves.toBeUndefined();
});

it("a reported failure with a VERIFIABLY gone target is swallowed (partially-dead tree is benign)", async () => {
  await expect(
    killTree(GONE_PID, { runKill: () => ({ ok: false, code: "taskkill exit 1" }) }),
  ).resolves.toBeUndefined();
});

it("a reported failure while the root VERIFIABLY survives THROWS — an orphan is never silent", async () => {
  await expect(
    killTree(process.pid, { runKill: () => ({ ok: false, code: "EPERM" }) }),
  ).rejects.toThrow(/VERIFIABLY survives: EPERM/);
});

// ---------- round-7: the PRODUCER's placement, which no matcher test can see ----------

it("the fixture ROOT publishes its identity as the LAST argument (round-7)", () => {
  // The gate anchors its match to the trailing argument, so this placement IS the contract between the
  // fixture and the gate, and breaking it fails nothing else: see the end-to-end test below, whose RED
  // leaves all 21 matcher tests green. This one is the cheap half, and it covers the ROOT only.
  const argv = fixtureArgv();

  expect(
    argv.at(-1),
    `the root's identity is no longer its last argument (argv ends ${JSON.stringify(argv.slice(-2))}), so the gate's trailing-argument anchor will not match this fixture at all and a leak of it would go unreported`,
  ).toBe(fixtureIdentity());
  // and the gate's own pattern accepts what this producer emits
  expect(new RegExp(IDENTITY_PATTERN).exec(argv.join(" "))?.[1]).toBe(String(process.pid));
});

/**
 * The acceptance for round-7 item 2, and the only pin that covers the DESCENDANT levels.
 *
 * The deeper levels build their argv inside FIXTURE_SRC, which is source text, so the first version of
 * this asserted placement with a regex over that text. The reviewer's CX was right that such a pin is
 * brittler than the thing it guards — it breaks on any reformatting of the fixture and still proves
 * nothing about what the OS receives. This goes through the gate's own mechanism instead: a real tree,
 * a real CIM scan, and every level expected to come back with this run as its owner. It is the probe
 * that actually caught the mutation, turned into a test.
 */
it.runIf(WIN32_ONLY)(
  "the gate SEES every level of a real fixture, with this run as the owner (round-7, end to end)",
  async () => {
    const tree = await startFixtureTree(3);
    const scan = await scanFixtureOrphans();

    // Fail-closed is the gate's own contract, so an unqueryable box is a failure here too, not a skip.
    expect(
      scan.failure,
      `the gate could not read the process table, so this test proves nothing either way: ${String(scan.failure)}`,
    ).toBeUndefined();

    // Owner, not parent: every level publishes THIS process as its owner, and the gate is expected to
    // read that from each of them. Both buckets are collected because which one a level lands in
    // depends on owner liveness, which is not what this test is about.
    const ownerByPid = new Map(
      [...scan.mine, ...scan.unowned].map((found) => [found.pid, found.owner]),
    );
    for (const [index, pid] of tree.pids.entries()) {
      expect(
        ownerByPid.get(pid),
        `level ${String(index)} (pid ${String(pid)}) is NOT SEEN by the gate, or is seen with the wrong owner. Every level of this tree is alive and publishes owner ${String(process.pid)}. A level the gate cannot see is a leak it will never report: the suite stays green and the process stays on the operator's box.`,
      ).toBe(process.pid);
    }
  },
  // One tree, no drain, plus ONE real scan: the scan's own derived bound is QUERY_TIMEOUT_MS, so the
  // budget is the tree budget plus that rather than a number chosen to look generous.
  budgetFor(1, 0) + QUERY_TIMEOUT_MS,
);
// ---------- the defect this lane exists for ----------

it.runIf(WIN32_ONLY)(
  "RED: killTree on a root that already exited raises nothing while two descendants keep running",
  async () => {
    const tree = await startFixtureTree(3);
    expect(tree.pids.map(alive)).toEqual([true, true, true]);

    // The launcher exits on its own, exactly as the live probe recorded (106 ms).
    process.kill(at(tree, 0));
    await tree.waitForRootExit();
    expect(alive(at(tree, 0))).toBe(false);

    // Today's ladder escalates here and reads "no throw" as stopped.
    await expect(killTree(at(tree, 0))).resolves.toBeUndefined();

    expect(alive(at(tree, 1))).toBe(true);
    expect(alive(at(tree, 2))).toBe(true);
  },
  // One tree, no verified drain: this test's only kill is killTree, whose own KILL_TIMEOUT_MS fits many
  // times inside the diagnostic allowance budgetFor always carries.
  budgetFor(1, 0),
);

it.runIf(WIN32_ONLY)(
  "killTreeVerified drains a tree whose root already exited and the receipt proves it empty",
  async () => {
    const tree = await startFixtureTree(3);
    process.kill(at(tree, 0));
    await tree.waitForRootExit();

    const receipt = await killTreeVerified(at(tree, 0));

    await assertDrained(receipt);
    const proven = accounted(receipt);
    expect(proven.enumerated).toEqual(expect.arrayContaining([at(tree, 1), at(tree, 2)]));
    expect(proven.survivors).toEqual([]);
    expect(proven.rootExited).toBe(true);
    expect(tree.pids.map(alive)).toEqual([false, false, false]);
  },
  budgetFor(1, 1),
);

it.runIf(WIN32_ONLY)(
  "killTreeVerified drains a live tree and enumerates every level before the kill",
  async () => {
    const tree = await startFixtureTree(3);

    const receipt = await killTreeVerified(at(tree, 0));

    await assertDrained(receipt);
    const proven = accounted(receipt);
    // CONTAINS, not equals: a live Windows tree carries more than the pids the fixture printed. Measured
    // here 2026-09-07 — the root also parents its own conhost.exe (name read back from Win32_Process),
    // a genuine member of the tree that /T takes with it. Pinning an exact set would pin an accident.
    // Re-measured 2026-09-12 over 12 sequential drains: the enumerated set was 4 pids in 12/12, i.e. the
    // three fixture levels plus exactly one more, every time.
    expect(proven.enumerated).toEqual(expect.arrayContaining(tree.pids));
    expect(proven.survivors).toEqual([]);
    expect(proven.forced).toBe(true);
    expect(proven.identityChecked).toBe(false);
    expect(tree.pids.map(alive)).toEqual([false, false, false]);
  },
  budgetFor(1, 1),
);

it.runIf(WIN32_ONLY)(
  "draining one seat's tree leaves another seat's tree untouched",
  async () => {
    const doomed = await startFixtureTree(3);
    const bystander = await startFixtureTree(3);

    const receipt = await killTreeVerified(at(doomed, 0));

    await assertDrained(receipt);
    expect(doomed.pids.map(alive)).toEqual([false, false, false]);
    expect(bystander.pids.map(alive)).toEqual([true, true, true]);
    for (const pid of bystander.pids) expect(accounted(receipt).enumerated).not.toContain(pid);
  },
  budgetFor(2, 1),
);

it.runIf(WIN32_ONLY)(
  "a real root's creation time matches its caller's spawn moment, so the identity check passes",
  async () => {
    const startedAt = Date.now();
    const tree = await startFixtureTree(3);

    const receipt = await killTreeVerified(at(tree, 0), { rootStartedAtMs: startedAt });

    await assertDrained(receipt);
    expect(accounted(receipt).identityChecked).toBe(true);
    expect(tree.pids.map(alive)).toEqual([false, false, false]);
  },
  budgetFor(1, 1),
);

it.runIf(WIN32_ONLY)(
  "draining an already-empty tree twice is idempotent and the second receipt is still a proof",
  async () => {
    const tree = await startFixtureTree(3);
    const first = await killTreeVerified(at(tree, 0));
    await assertDrained(first);

    const second = await killTreeVerified(at(tree, 0));

    await assertDrained(second);
    const proven = accounted(second);
    expect(proven.survivors).toEqual([]);
    expect(proven.rootExited).toBe(true);
    expect(proven.forced).toBe(false);
  },
  // TWO drains, hence two enumerations: the 30_000 ms blanket could not cover one of them.
  budgetFor(1, 2),
);

it.runIf(WIN32_ONLY)(
  "RED: a real LIVE tree whose caller names the wrong spawn moment is refused, and nothing is killed",
  async () => {
    // ROUND-4 item 6. The test above already passes `rootStartedAtMs` against a live tree and asserts
    // `identityChecked: true` — but it cannot FAIL if the comparison itself is gone, because that flag is
    // computed from "a start time was supplied and the row carried a creation time", never from the
    // verdict. So the identity-checked path was exercised and never falsified. This is the falsifier: the
    // caller claims a spawn moment ten minutes before this root existed, so the root reads as created far
    // later than the caller's own spawn, beyond ROOT_IDENTITY_SLACK_MS, and the only safe answer is to
    // refuse. Delete the `lateBy` comparison in `identityMismatch` and this test goes green while the one
    // above stays green too — which is exactly why it had to exist.
    //
    // Nothing may die here: a recycled root's tree belongs to whoever holds the id now (FL-211, reproduced
    // as four unrelated processes killed with `isDrained` true). The afterEach sweep takes the fixture.
    const tree = await startFixtureTree(3);
    const tenMinutesBeforeThisRoot = Date.now() - 600_000;

    const receipt = await killTreeVerified(at(tree, 0), {
      rootStartedAtMs: tenMinutesBeforeThisRoot,
    });

    if (receipt.accounted) {
      throw new Error(
        `expected a REFUSAL for a root far younger than the caller's spawn moment; got ${JSON.stringify(receipt)}`,
      );
    }
    expect(receipt.error).toMatch(/recycled/);
    expect(receipt.forced).toBe(false);
    expect(isDrained(receipt)).toBe(false);
    // The whole tree is untouched: the refusal is not a quiet kill.
    expect(tree.pids.map(alive)).toEqual([true, true, true]);
  },
  budgetFor(1, 1),
);
