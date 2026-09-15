// M4 REBASE ITEM 2 — the "backfill committed" line must describe a COMMIT, not a savepoint release.
//
// THE DEFECT (M5 review r3b FINDING 4, confirmed and owed to this rebase round). M4 logged the v21
// backfill's counts inside `applyMemoryMigration`, right after its own `migrate.immediate()` returned.
// Standalone that is a real COMMIT. Under M5's tiered opener it is not: `runMemoryTier` already holds a
// top-level BEGIN IMMEDIATE, so the inner `.immediate()` degrades to a SAVEPOINT and its release puts
// nothing on disk. The reviewer's probe caught the line firing with `db.inTransaction === true`, after
// which the tier's locked version validation threw and rolled the database back to {14} — no
// journal_entries table at all, while a durable log claimed a committed backfill of 7 rows.
//
// The rollback is driven the way the reviewer drove it: an accepted-key contract whose memory list does
// not contain the set the tier actually produces, so `validateLockedVersionKey` rejects AFTER
// applyMemoryMigration has done all its work. That is the real production failure mode too — it is what
// a genuine mid-flight SCHEMA_DRIFT looks like from inside the tier.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConfigError } from "../shared/errors.js";
import { type Db, closeDb, openDb, openMemoryDb } from "./db.js";
import { runMemoryTier } from "./migration-tiers.js";
import { MIGRATION_V14_TO_V15 } from "./migrations-v15.js";

const { debugSpy, warnSpy } = vi.hoisted(() => ({ debugSpy: vi.fn(), warnSpy: vi.fn() }));
// A SHARED hoisted spy, not a fresh vi.fn() per createLogger call: db.ts and migrations.ts each build
// their own logger at module load, and this test has to see whichever of them emits the line.
vi.mock("../shared/logger.js", () => ({
  createLogger: () => ({ debug: debugSpy, warn: warnSpy, info: vi.fn(), error: vi.fn() }),
}));

const COMMITTED_LINE = "journal_entry_files backfill committed";
const UNCOMMITTED_LINE = "journal_entry_files backfill counted inside an OPEN transaction";

// The tolerance contract db.ts hands the tiers, narrowed to what these cases need.
const ACCEPTING_KEYS = {
  global: ["14", "14,15", "14,15,21"],
  memory: ["14,15,21"],
  lane: ["14,15,16,20,21"],
};
// The same contract with ONE difference: the memory list cannot contain the set the tier produces, so
// the locked validation rejects after every write the tier made.
const REJECTING_KEYS = { ...ACCEPTING_KEYS, memory: ["14,15,99"] };

let root: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  if (root !== undefined) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    root = undefined;
  }
});

// A pre-M4 memory database: {14,15} with journal rows that HAVE touched_files, so the v21 backfill has
// real work and the count that triggers the log is non-zero. Without rows the log never fires and the
// test would pass for the wrong reason.
function seedMemoryDbWithFiles(): string {
  root = mkdtempSync(join(tmpdir(), "zer0-m4-backfill-log-"));
  const dbPath = join(root, "evidence.db");
  closeDb(openDb(dbPath)); // global chain to {14}
  const sculptor = new Database(dbPath);
  sculptor.exec(MIGRATION_V14_TO_V15); // {14,15}, still no v21
  sculptor.exec(
    "INSERT INTO projects (project_id, canonical_root, git_common_dir, created_at) " +
      "VALUES ('p1', '/repo/p1', '/repo/p1/.git', '2026-09-01T00:00:00.000Z')",
  );
  const insert = sculptor.prepare(
    "INSERT INTO journal_entries " +
      "(entry_id, project_id, category, author, body, touched_files, anchor, superseded_by, seq, created_at) " +
      "VALUES (?, 'p1', 'decision', 'ledger', ?, ?, 0, NULL, ?, '2026-09-01T00:00:00.000Z')",
  );
  insert.run("e1", "two files", '["src/a.ts","src/b.ts"]', 1);
  insert.run("e2", "one file", '["src/c.ts"]', 2);
  sculptor.close();
  return dbPath;
}

function linesMatching(spy: typeof debugSpy, needle: string): unknown[][] {
  return spy.mock.calls.filter((call) => String(call[1]).includes(needle));
}

it("a memory tier that rolls back after the backfill logs NO committed line (r3b FINDING 4)", () => {
  const dbPath = seedMemoryDbWithFiles();
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");

    let threw: unknown;
    try {
      runMemoryTier(db, REJECTING_KEYS);
    } catch (err) {
      threw = err;
    }

    // The tier really did run and really did roll back — otherwise the log's absence proves nothing.
    expect(threw).toBeInstanceOf(ConfigError);
    expect((threw as ConfigError).message).toContain("SCHEMA_DRIFT");
    expect((threw as ConfigError).message).toContain("received 14,15,21");
    expect(db.inTransaction).toBe(false);
    const objects = db
      .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'journal_entry_files'")
      .get() as { c: number };
    expect(objects.c).toBe(0); // the backfill's own table is gone with the rest of the tier
    const versions = (
      db.prepare("SELECT version FROM _schema_version ORDER BY version").all() as Array<{
        version: number;
      }>
    ).map((row) => row.version);
    expect(versions).toEqual([14, 15]);

    // THE PIN: nothing on disk, so nothing may claim a commit.
    expect(linesMatching(debugSpy, COMMITTED_LINE)).toEqual([]);
    expect(linesMatching(warnSpy, COMMITTED_LINE)).toEqual([]);
  } finally {
    db.close();
  }
});

it("a memory tier that COMMITS does log the backfill counts, once, after the commit", () => {
  const dbPath = seedMemoryDbWithFiles();

  const opened = openMemoryDb(dbPath); // the real seam: db.ts logs after runMemoryTier returns
  try {
    const projected = opened.prepare("SELECT COUNT(*) AS c FROM journal_entry_files").get() as {
      c: number;
    };
    expect(projected.c).toBe(3); // e1's two keys + e2's one, really on disk

    const committed = linesMatching(debugSpy, COMMITTED_LINE);
    expect(committed).toHaveLength(1);
    expect(committed[0]?.[2]).toEqual({ backfilledRows: 3, skippedRows: 0 });
    // And it is the COMMITTED wording, never the open-transaction fallback.
    expect(linesMatching(warnSpy, UNCOMMITTED_LINE)).toEqual([]);
  } finally {
    closeDb(opened);
  }
});

it("a steady-state reopen logs nothing: the one-shot backfill is not re-announced", () => {
  const dbPath = seedMemoryDbWithFiles();
  closeDb(openMemoryDb(dbPath));
  vi.clearAllMocks();

  const reopened: Db = openMemoryDb(dbPath);
  try {
    expect(linesMatching(debugSpy, COMMITTED_LINE)).toEqual([]);
  } finally {
    closeDb(reopened);
  }
});

// M4 REBASE ROUND 2 (review R5-F6) — THE REPAIR THAT WRITES NO ROWS MUST STILL BE VISIBLE.
//
// The headline repair this lane exists for is a dropped or body-drifted TRIGGER on a database whose
// projection TABLE and rows are intact. `applyFileProjectionStep` drops the trigger, re-creates all
// four objects, and the backfill's INSERT OR IGNORE writes ZERO rows because every row is already
// there. Both counts come back zero, so before this round the early return in
// logFileProjectionBackfill made a four-object schema rewrite under a writer lock completely silent:
// the reviewer captured the whole logger for such an open and saw exactly ["debug: database opened"].
const REPAIR_LINE = "journal_entry_files objects were drifted and have been rebuilt";
const DISPLACED_LINE = "objects already occupying journal_entry_files names were DROPPED";

function sculptTriggerDrift(dbPath: string, body: string | undefined): void {
  const sculptor = new Database(dbPath);
  sculptor.exec("DROP TRIGGER journal_entry_files_after_insert");
  if (body !== undefined) sculptor.exec(body);
  sculptor.close();
}

it("a trigger-only drift repair is LOGGED with the object name and the reason (R5-F6)", () => {
  const dbPath = seedMemoryDbWithFiles();
  closeDb(openMemoryDb(dbPath)); // first open migrates to {14,15,21} and projects 3 rows
  sculptTriggerDrift(dbPath, undefined);
  vi.clearAllMocks();

  const repaired = openMemoryDb(dbPath);
  try {
    // The repair really happened: the trigger is back and the pre-existing rows were NOT disturbed.
    const trigger = repaired
      .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = ?")
      .get("journal_entry_files_after_insert") as { c: number };
    expect(trigger.c).toBe(1);
    const rows = repaired.prepare("SELECT COUNT(*) AS c FROM journal_entry_files").get() as {
      c: number;
    };
    expect(rows.c).toBe(3);

    // And it wrote NO rows, which is precisely why the old count-only log said nothing.
    expect(linesMatching(debugSpy, COMMITTED_LINE)).toEqual([]);

    const repairLines = linesMatching(debugSpy, REPAIR_LINE);
    expect(repairLines).toHaveLength(1);
    expect(repairLines[0]?.[2]).toEqual({
      objects: ["trigger journal_entry_files_after_insert (missing)"],
    });
    expect(linesMatching(warnSpy, REPAIR_LINE)).toEqual([]);
  } finally {
    closeDb(repaired);
  }
});

it("a BODY-drifted object is logged as body-changed, not as missing", () => {
  const dbPath = seedMemoryDbWithFiles();
  closeDb(openMemoryDb(dbPath));
  sculptTriggerDrift(
    dbPath,
    "CREATE TRIGGER journal_entry_files_after_insert AFTER INSERT ON journal_entries BEGIN SELECT 1; END",
  );
  vi.clearAllMocks();

  const repaired = openMemoryDb(dbPath);
  try {
    const repairLines = linesMatching(debugSpy, REPAIR_LINE);
    expect(repairLines).toHaveLength(1);
    expect(repairLines[0]?.[2]).toEqual({
      objects: ["trigger journal_entry_files_after_insert (body-changed)"],
    });
  } finally {
    closeDb(repaired);
  }
});

it("a FIRST migration is not announced as a repair: nothing was drifted, the step just ran", () => {
  const dbPath = seedMemoryDbWithFiles();

  const first = openMemoryDb(dbPath);
  try {
    // All four objects were absent, but absent-on-a-pre-v21-database is the step doing its job.
    // Calling that a repair would cry wolf on every database that has never been migrated.
    expect(linesMatching(debugSpy, REPAIR_LINE)).toEqual([]);
    expect(linesMatching(debugSpy, COMMITTED_LINE)).toHaveLength(1);
  } finally {
    closeDb(first);
  }
});

// M4 ROUND 3 (review R6-F3, reported UNCONFIRMED) — THE FIRST-MIGRATION BRANCH CAN STILL DESTROY.
//
// applyFileProjectionStep suppresses the repair log when version 21 is ABSENT, on the reasoning that
// four missing objects on a pre-v21 database is the step doing its job rather than a repair. True for
// MISSING objects. Not true for one that EXISTS: if something already occupies a v21 name while
// version 21 is absent, the step DROPS it, and under the suppressed branch that destructive drop was
// as silent as the repair R5-F6 fixed. This test decides the corner by building it.
it("a pre-existing object occupying a v21 name is DROPPED, and the drop is logged (R6-F3)", () => {
  const dbPath = seedMemoryDbWithFiles(); // {14,15}, no version 21 anywhere
  const squatter = new Database(dbPath);
  squatter.exec("CREATE TABLE journal_entry_files (mine TEXT)");
  squatter.prepare("INSERT INTO journal_entry_files (mine) VALUES ('not v21 data')").run();
  squatter.close();
  vi.clearAllMocks();

  const migrated = openMemoryDb(dbPath);
  try {
    // The drop really happened: the squatter's column is gone and v21's shape is in its place.
    const columns = (
      migrated.prepare("PRAGMA table_info('journal_entry_files')").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(columns).toEqual(["entry_id", "project_id", "file_key", "seq"]);

    const displaced = linesMatching(debugSpy, DISPLACED_LINE);
    expect(displaced).toHaveLength(1);
    expect(displaced[0]?.[2]).toEqual({
      objects: ["table journal_entry_files (body-changed)"],
    });
  } finally {
    closeDb(migrated);
  }
});
