/**
 * @file src/shared/kill-tree-identity.test.ts
 * @purpose Root identity for the drain receipt, seam-injected so it needs no real processes: a recycled
 *   root pid must not take a stranger's tree with it, and the round-2/round-3 guard that reads a
 *   DISOWNED child as evidence of reuse must read it only where it is evidence. Extracted from
 *   kill-tree-receipt.test.ts when that file reached the 500-line clamp (ratchets only fall) along the
 *   section boundary it already had; the accounting-failure, POSIX-seam, pid-guard and polled-deadline
 *   halves stay there. The decision table this pins is documented at `disownedRootIsTheOnlyReading`.
 * @exports (none — test file)
 * @depends node:process, vitest, ./kill-tree, ./process-table
 */
import process from "node:process";
import { expect, it } from "vitest";
import { isDrained, killTreeVerified } from "./kill-tree.js";
import type { CommandOutcome } from "./process-table.js";

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
  return [self, ...body].join(String.fromCharCode(13, 10));
}

// ---------- root identity: a recycled pid must not take a stranger's tree with it ----------

it("an enumeration failure does not bypass a requested identity check (review C2)", async () => {
  // Both enumerators failing is exactly as unable to vouch for the root's identity as a readable table
  // whose creation time comes back unreadable (the test below this one) — the caller asked for a check
  // before anything is killed, and there is nothing to check it against either way. Fail closed on both
  // paths instead of forcing the kill through the one where accounting broke first.
  const attempted: string[] = [];

  const receipt = await killTreeVerified(ROOT, {
    isAlive: () => true,
    rootStartedAtMs: Date.now(),
    async runCommand(cmd): Promise<CommandOutcome> {
      attempted.push(cmd);
      return fail("ENOENT");
    },
    verifyDeadlineMs: 100,
  });

  expect(receipt.accounted).toBe(false);
  if (receipt.accounted) throw new Error("expected an unaccounted receipt");
  expect(receipt.forced).toBe(false);
  expect(attempted).not.toContain("taskkill");
});

it("a root created long after the caller spawned it is refused as recycled, and nothing is killed", async () => {
  const spawnedAt = Date.now() - 600_000;
  const calls: string[] = [];

  const receipt = await killTreeVerified(ROOT, {
    isAlive: () => true,
    rootStartedAtMs: spawnedAt,
    async runCommand(cmd): Promise<CommandOutcome> {
      calls.push(cmd);
      return ok(
        table([
          [1, ROOT, Date.now()],
          [ROOT, CHILD, Date.now()],
        ]),
      );
    },
  });

  expect(receipt.accounted).toBe(false);
  if (receipt.accounted) throw new Error("expected an unaccounted receipt");
  expect(receipt.error).toMatch(/recycled/);
  expect(receipt.forced).toBe(false);
  expect(calls).not.toContain("taskkill");
});

it("a recycled root whose children's links are refused as stale is UNACCOUNTED, never an empty tree", async () => {
  // ROUND 2 F1, modelled from run 9 of the round-1 review (`.tmp-rbr1/killtree-tip-run9.raw`): a proof of
  // drain issued for a tree whose descendants were never enumerated. `disownedRootError` in kill-tree.ts
  // carries the mechanism and why refusing is the safe direction twice over; this pins the behaviour. The
  // table below is that shape exactly — the root's row younger than the child that names it as parent,
  // which no real child can be — and the old code read the resulting empty walk as an empty tree.
  const childCreatedAt = Date.UTC(2026, 8, 12, 12, 0, 0);
  const calls: string[] = [];

  const receipt = await killTreeVerified(ROOT, {
    // The children live; the short-lived process that took the root's pid is already gone again, which is
    // why the old code read "root gone, nothing enumerated, nothing survived" as a clean drain.
    isAlive: (pid) => pid === CHILD,
    async runCommand(cmd): Promise<CommandOutcome> {
      calls.push(cmd);
      return ok(
        table([
          [9, ROOT, childCreatedAt + 1_000],
          [ROOT, CHILD, childCreatedAt],
        ]),
      );
    },
    verifyDeadlineMs: 100,
  });

  if (receipt.accounted) {
    throw new Error(
      `expected an UNACCOUNTED receipt; got a proof of drain: ${JSON.stringify(receipt)}`,
    );
  }
  // The message states what was OBSERVED and withholds what was not (round-4 item 5): it names the
  // disowned pid, says the identity was never verified, and does NOT assert reuse — recorded-older
  // children are normal for some parents, which is the absolute this module retired.
  expect(receipt.error).toContain(String(CHILD));
  expect(receipt.error).toContain("identity was never verified");
  expect(receipt.error).toContain("Nothing was killed");
  expect(receipt.error).not.toMatch(/impossible/);
  expect(receipt.forced).toBe(false);
  expect(calls).not.toContain("taskkill");
  expect(isDrained(receipt)).toBe(false);
});

it("a root created at the caller's own spawn moment passes identity and is drained", async () => {
  const spawnedAt = Date.now();

  const receipt = await killTreeVerified(ROOT, {
    isAlive: () => false,
    rootStartedAtMs: spawnedAt,
    runCommand: async () =>
      ok(
        table([
          [1, ROOT, spawnedAt + 40],
          [ROOT, CHILD, spawnedAt + 90],
        ]),
      ),
  });

  expect(receipt.accounted).toBe(true);
  if (!receipt.accounted) throw new Error(receipt.error);
  expect(receipt.identityChecked).toBe(true);
  expect([...receipt.enumerated].sort()).toEqual([ROOT, CHILD].sort());
});

it("on win32 an identity check the table cannot answer refuses rather than draining unchecked", async () => {
  // Pinned "win32": on that platform a row with no creation time is the EXCEPTIONAL case (Win32_Process's
  // CreationDate came back null for this one row), so refusing is the safe default. Left unpinned this
  // test's outcome would depend on whatever host runs it — see the POSIX case directly below, where the
  // very same "creation time missing" shape is the platform's UNCONDITIONAL case, not an exception.
  const receipt = await killTreeVerified(ROOT, {
    isAlive: () => true,
    platform: "win32",
    rootStartedAtMs: Date.now(),
    runCommand: async () => ok(table([[1, ROOT, undefined]])),
  });

  expect(receipt.accounted).toBe(false);
  if (receipt.accounted) throw new Error("expected an unaccounted receipt");
  expect(receipt.error).toMatch(/creation time is unreadable/);
});

it("on POSIX, where ps never reports a creation time at all, the identity option is honored as unsupported rather than disabling every drain (review C4)", async () => {
  // ps -A -o ppid,pid (process-table.ts POSIX_PS_ARGS) has no timestamp column, structurally, on every
  // row, always — unlike Windows where a missing CreationDate is the occasional exception handled above.
  // Refusing here the way Windows does would mean supplying rootStartedAtMs — the option the review's own
  // I4 fix recommended callers use — unconditionally disables draining on Linux and macOS (codex
  // cross-check probe: accounted:false, forced:false, rootExited:false, root genuinely alive). Chosen over
  // reading a real POSIX start time (`ps -o lstart=`/`etimes=`): this box has no POSIX host to verify a
  // new parser against, and guessing at one for a kill-identity path is worse than being honest about the
  // limitation. The receipt says identityChecked:false — no comparison happened — but still drains.
  const posixCalls: Array<{ pid: number; signal: NodeJS.Signals }> = [];

  const receipt = await killTreeVerified(ROOT, {
    isAlive: () => false,
    killPosix: (pid, signal) => {
      posixCalls.push({ pid, signal });
    },
    platform: "linux",
    rootStartedAtMs: Date.now(),
    runCommand: async () => ok(table([[1, ROOT, undefined]])),
  });

  expect(receipt.accounted).toBe(true);
  if (!receipt.accounted) throw new Error(receipt.error);
  expect(receipt.identityChecked).toBe(false);
  expect(isDrained(receipt)).toBe(true);
  // isAlive is false throughout, so nothing is actually forced here; this only proves the drain PROCEEDS
  // (accounted, not refused) — review C3's own test proves a POSIX kill, once forced, uses this same seam.
  expect(posixCalls).toEqual([]);
});

it("without a spawn moment the receipt says the identity was NOT checked rather than implying one", async () => {
  const receipt = await killTreeVerified(ROOT, {
    isAlive: () => false,
    runCommand: async () => ok(table([[1, ROOT, Date.now()]])),
  });

  expect(receipt.accounted).toBe(true);
  if (!receipt.accounted) throw new Error(receipt.error);
  expect(receipt.identityChecked).toBe(false);
});

it("with the root already gone from the table, a requested identity check could not run — the receipt must say so, not that it did (review B2)", async () => {
  const spawnedAt = Date.now() - 600_000;

  const receipt = await killTreeVerified(ROOT, {
    isAlive: () => false,
    rootStartedAtMs: spawnedAt,
    // No row for ROOT itself — the launcher already exited before the table was read. Two orphans still
    // name it as their ppid, which is the launcher-exits-orphans-remain shape this lane exists for.
    runCommand: async () =>
      ok(
        table([
          [ROOT, CHILD, undefined],
          [ROOT, 6666, undefined],
        ]),
      ),
  });

  expect(receipt.accounted).toBe(true);
  if (!receipt.accounted) throw new Error(receipt.error);
  // A creation time was never compared: the root had no row to compare against.
  expect(receipt.identityChecked).toBe(false);
  expect([...receipt.enumerated].sort()).toEqual([ROOT, CHILD, 6666].sort());
});

// ---------- round 3: a disowned child is evidence only where it IS evidence ----------

it("a disowned child does NOT refuse a drain whose walk found real children (round-3 F-R2-1)", async () => {
  // The blast radius of round 2's guard, from the reviewer's probe S2: a genuine LIVE root with a
  // genuine child, plus one older orphan left behind by a previous holder of the root's id. Round 2
  // refused the whole drain and killed nothing, so the real child kept running — a false-refusal traded
  // for the false-empty, at 1 run in 10. The walk found 7777; that is what the drain acts on, and the
  // disowned row is REPORTED instead of cancelling a kill that has a real target.
  const t = Date.UTC(2026, 8, 12, 22, 30, 0);
  const killed: string[][] = [];
  const receipt = await killTreeVerified(ROOT, {
    isAlive: (pid) => pid === ROOT || pid === 7777 || pid === CHILD,
    platform: "win32",
    async runCommand(cmd, args): Promise<CommandOutcome> {
      if (cmd === "taskkill") {
        killed.push([...args]);
        return ok("");
      }
      return ok(
        table([
          [9, ROOT, t + 1_000],
          [ROOT, 7777, t + 2_000],
          [ROOT, CHILD, t],
        ]),
      );
    },
    verifyDeadlineMs: 100,
  });

  if (!receipt.accounted) throw new Error(`expected an accounted receipt: ${receipt.error}`);
  expect(receipt.enumerated).toEqual([ROOT, 7777]);
  expect(receipt.disowned).toEqual([CHILD]);
  expect(receipt.witnessed).toBe(true);
  expect(killed[0]).toContain("7777");
});

it("a disowned child does NOT refuse a drain whose identity check PASSED (round-3 F-R2-2)", async () => {
  // Run 4 of the round-2 review, reduced: the root is ALIVE, the caller passed its own spawn moment, the
  // check passed in this same call — and round 2 still refused, with a message asserting pid reuse and
  // advising `rootStartedAtMs` to a call site already passing it. An identity that passed settles who
  // this root is, so rows older than it belong to a previous holder and are somebody else's business.
  const startedAt = Date.UTC(2026, 8, 12, 22, 30, 0);
  const receipt = await killTreeVerified(ROOT, {
    isAlive: (pid) => pid === ROOT,
    platform: "win32",
    rootStartedAtMs: startedAt,
    runCommand: async (cmd) =>
      ok(
        cmd === "taskkill"
          ? ""
          : table([
              [9, ROOT, startedAt],
              [ROOT, CHILD, startedAt - 11_590],
            ]),
      ),
    verifyDeadlineMs: 100,
  });

  if (!receipt.accounted) throw new Error(`expected an accounted receipt: ${receipt.error}`);
  expect(receipt.identityChecked).toBe(true);
  expect(receipt.disowned).toEqual([CHILD]);
  // PROCEEDED is the claim, not drained: this seam's root never stops reading alive, so it is still a
  // survivor at the deadline. Round 2 refused before any kill was attempted, so `forced` is the
  // discriminator — a kill was tried on the root the caller proved was its own.
  expect(receipt.forced).toBe(true);
  expect(receipt.enumerated).toEqual([ROOT]);
});

// ---------- round 3: an empty drain says whether anything witnessed it ----------

it("an empty drain over a table that never mentioned the root reports witnessed:false", async () => {
  // Round 2's second F1 candidate, which no cheap defence inside this module can refuse: the table comes
  // back without the root's row and without anything linking to it, so the walk is empty for a reason
  // this module cannot tell from a genuinely empty tree. `isDrained` still says true — the same shape is
  // what an idempotent second drain looks like — so the flag is what a caller reads to know the
  // difference. L3 should treat `isDrained(r) && !r.witnessed` as UNVERIFIED and drain again.
  const receipt = await killTreeVerified(ROOT, {
    isAlive: () => false,
    platform: "win32",
    runCommand: async () => ok(table([[1, 9_999, undefined]])),
    verifyDeadlineMs: 100,
  });

  if (!receipt.accounted) throw new Error(`expected an accounted receipt: ${receipt.error}`);
  expect(receipt.enumerated).toEqual([ROOT]);
  expect(receipt.survivors).toEqual([]);
  expect(isDrained(receipt)).toBe(true);
  expect(receipt.witnessed).toBe(false);
});

it("an empty drain whose root the table DID carry reports witnessed:true", async () => {
  const t = Date.UTC(2026, 8, 12, 22, 30, 0);
  const receipt = await killTreeVerified(ROOT, {
    isAlive: () => false,
    platform: "win32",
    runCommand: async () => ok(table([[9, ROOT, t]])),
    verifyDeadlineMs: 100,
  });

  if (!receipt.accounted) throw new Error(`expected an accounted receipt: ${receipt.error}`);
  expect(receipt.enumerated).toEqual([ROOT]);
  expect(receipt.witnessed).toBe(true);
});
