// FL-077 round 3 (acceptance 4) — WHOLE-TIER ROLLBACK pins.
//
// A tier that fails partway must leave the database at its ENTRY state: nothing partial commits,
// and an earlier committed tier survives a later tier's failure. The mechanism under test is the
// outer BEGIN IMMEDIATE in migration-tiers.ts; a failure is injected deterministically by
// bombing Database.prototype.exec on a statement unique to one late step, so every earlier step
// really does run before the bomb fires.
//
// Honesty note on old behaviour: the GLOBAL case below used to commit partial state — the
// captured pre-fix race showed opener B committing the hybrid set [3,5,14] mid-chain (quoted in
// the round-3 report), which is exactly what this pin now forbids. The MEMORY and LANE cases pin
// TIER SEPARATION on a FRESH database with every earlier tier committed BY THE SAME OPEN (r3b
// finding 3): their previous shape pre-committed the earlier tier in a separate opener call, which
// left them blind to whole-opener coupling of all three tiers — the exact shape MUTATION D
// reproduced green before the rewrite (the fresh-open scenario collapsed with `no such table:
// _schema_version` under that mutation; now both pins go red there).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { closeDb, openDb, openLaneStateDb, openMemoryDb } from "./db.js";

let root: string | undefined;

afterEach(() => {
  unbombExec();
  if (root !== undefined) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    root = undefined;
  }
});

function tempDbPath(): string {
  root = mkdtempSync(join(tmpdir(), "zer0-open-tier-rollback-"));
  return join(root, "evidence.db");
}

function versionSet(db: Database.Database): number[] {
  return (
    db.prepare("SELECT version FROM _schema_version ORDER BY version").all() as Array<{
      version: number;
    }>
  ).map((row) => row.version);
}

function tableNames(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

// --- exec-bomb plumbing -----------------------------------------------------------------
// Instance-level patching silently no-ops on better-sqlite3 (methods are defined non-writable),
// so the bomb lives on the PROTOTYPE and replaces itself through defineProperty, keeping the
// original descriptor for exact restoration. No test may leave it armed: afterEach unbombs too.
const ORIGINAL_EXEC_DESCRIPTOR = Object.getOwnPropertyDescriptor(Database.prototype, "exec");

function bombExec(marker: string): void {
  if (ORIGINAL_EXEC_DESCRIPTOR === undefined || ORIGINAL_EXEC_DESCRIPTOR.value === undefined) {
    throw new Error("Database.prototype.exec not found — the bomb cannot be installed safely");
  }
  const original = ORIGINAL_EXEC_DESCRIPTOR.value;
  Object.defineProperty(Database.prototype, "exec", {
    value: function patchedExec(this: Database.Database, sql: string) {
      if (typeof sql === "string" && sql.includes(marker)) {
        throw new Error(`FL-077 r3 rollback bomb fired (${marker})`);
      }
      return original.call(this, sql);
    },
    writable: true,
    configurable: true,
  });
}

function unbombExec(): void {
  if (
    ORIGINAL_EXEC_DESCRIPTOR !== undefined &&
    Object.getOwnPropertyDescriptor(Database.prototype, "exec") !== ORIGINAL_EXEC_DESCRIPTOR
  ) {
    Object.defineProperty(Database.prototype, "exec", ORIGINAL_EXEC_DESCRIPTOR);
  }
}

// Positive control FIRST: an armed bomb must actually intercept migration SQL, or a green
// rollback assertion below would mean "nothing ran" rather than "the tier rolled back".
it("the exec bomb intercepts real migration statements before any pin relies on it", () => {
  const dbPath = tempDbPath();
  bombExec("CREATE TABLE");
  let threw: unknown;
  try {
    openDb(dbPath);
  } catch (err) {
    threw = err;
  }
  expect(threw).toBeInstanceOf(Error);
  expect((threw as Error).message).toContain("rollback bomb fired (CREATE TABLE)");
});

// Acceptance 4, global half: the bomb sits on applyV12ToV13's quarantine UPDATE — steps v1..v12
// have ALL run inside their savepoints by then, so anything committed would be visible here.
it("a late global-chain failure rolls the WHOLE tier back to the empty entry state", () => {
  const dbPath = tempDbPath();
  bombExec("UPDATE chat_sessions SET quarantined = 1"); // unique to v12->v13
  let threw: unknown;
  try {
    openDb(dbPath);
  } catch (err) {
    threw = err;
  }
  expect(threw).toBeInstanceOf(Error);
  expect((threw as Error).message).toContain("rollback bomb fired");
  unbombExec(); // the recovery open below must run with the tier's real code

  const raw = new Database(dbPath);
  try {
    // Nothing partial survived: no version rows, no tower tables, no chat tables at all.
    expect(tableNames(raw)).toEqual([]);
  } finally {
    raw.close();
  }

  // And the file is healthy: an unbombed open completes the tier normally.
  const recovered = openDb(dbPath);
  try {
    expect(versionSet(recovered)).toEqual([14]);
  } finally {
    closeDb(recovered);
  }
});

// Acceptance 4, memory half — SAME-OPEN tier separation (r3b finding 3): the previous shape of
// this pin pre-committed {14} in a SEPARATE openDb call, so on the open under test the global tier
// was already complete and runGlobalTier was never entered — a whole-opener coupling of all three
// tiers into one transaction would have left it green while a real fresh-database open collapsed
// (`no such table: _schema_version`). This pin drives global AND memory from ONE openMemoryDb on
// an EMPTY file: the memory tier's bomb fires only after the global tier has committed its own
// top-level transaction, so {14} must survive ON DISK.
it("a failed MEMORY tier retains the global tier {14} that the SAME OPEN committed", () => {
  const dbPath = tempDbPath(); // FRESH file: nothing on disk yet, no prior open did the work

  bombExec("journal_entries"); // unique to MIGRATION_V14_TO_V15; absent from schema.sql and v1..v14
  let threw: unknown;
  try {
    openMemoryDb(dbPath);
  } catch (err) {
    threw = err;
  }
  expect(threw).toBeInstanceOf(Error);
  expect((threw as Error).message).toContain("rollback bomb fired");

  const raw = new Database(dbPath);
  try {
    expect(versionSet(raw)).toEqual([14]); // the global tier SURVIVED its sibling tier's failure
    expect(tableNames(raw)).not.toContain("journal_entries");
    expect(tableNames(raw)).not.toContain("digest_watermark");
    expect(tableNames(raw).length).toBeGreaterThan(0); // positive control: schema.sql really committed
  } finally {
    raw.close();
  }
});

// Acceptance 4, lane half — same contract one tier up, still in ONE open: global AND memory AND
// lane from a single openLaneStateDb on an empty file. The lane tier fails; {14,15,21} must survive
// (M4: the memory tier lands v21 in the same committed tier), with nothing partial (no lane tables,
// no v16/v20 rows).
it("a failed LANE tier retains the tiers {14,15,21} that the SAME OPEN committed", () => {
  const dbPath = tempDbPath();

  bombExec("lane_sessions"); // unique to MIGRATION_V15_TO_V16; absent from schema.sql and v1..v15
  let threw: unknown;
  try {
    openLaneStateDb(dbPath);
  } catch (err) {
    threw = err;
  }
  expect(threw).toBeInstanceOf(Error);
  expect((threw as Error).message).toContain("rollback bomb fired");

  const raw = new Database(dbPath);
  try {
    expect(versionSet(raw)).toEqual([14, 15, 21]);
    expect(tableNames(raw)).toContain("journal_entry_files"); // the memory tier's v21 half committed too
    expect(tableNames(raw)).not.toContain("lane_sessions");
    expect(tableNames(raw)).not.toContain("lane_cursors");
    expect(tableNames(raw)).not.toContain("ledger_seq");
  } finally {
    raw.close();
  }
});
