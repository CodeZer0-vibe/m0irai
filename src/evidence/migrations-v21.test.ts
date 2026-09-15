// M4 — journal_entry_files projection migration (v21): one-shot JSON1 backfill of touched_files,
// malformed/non-array rows skipped, and a SECOND open performs zero writes (byte-identical file).
// Real sqlite. Top-level it() so no callback trips the clamp. No memory-layer imports (evidence
// tests may not import memory) — journal rows are seeded with raw SQL.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { type Db, closeDb, openDb, openMemoryDb } from "./db.js";
import { type AcceptedVersionKeys, chainReadiness } from "./migration-readiness.js";
import { MIGRATION_V14_TO_V15 } from "./migrations-v15.js";
import { MIGRATION_V15_TO_V21, applyFileProjectionStep } from "./migrations-v21.js";

let root: string | undefined;

afterEach(() => {
  if (root !== undefined) {
    rmSync(root, { recursive: true, force: true });
    root = undefined;
  }
});

function tempDbPath(): string {
  root = mkdtempSync(join(tmpdir(), "zer0-migrations-v21-"));
  return join(root, "evidence.db");
}

function versions(db: Db): number[] {
  return (
    db.prepare("SELECT version FROM _schema_version ORDER BY version").all() as Array<{
      version: number;
    }>
  ).map((row) => row.version);
}

function shaOrEmpty(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "";
  }
}

// A pre-M4 DB at exactly the OLD produced memory set {14,15}: global chain via openDb, then the
// v15 step applied directly — NO v21, so journal_entry_files does not exist yet.
function seedPreMigrationDb(dbPath: string): void {
  const base = openDb(dbPath);
  closeDb(base);
  const sculptor = new Database(dbPath);
  sculptor.exec(MIGRATION_V14_TO_V15);
  sculptor.exec(
    "INSERT INTO projects (project_id, canonical_root, git_common_dir, created_at) " +
      "VALUES ('p1', '/repo/p1', '/repo/p1/.git', '2026-08-22T00:00:00.000Z')",
  );
  const insert = sculptor.prepare(
    "INSERT INTO journal_entries " +
      "(entry_id, project_id, category, author, body, touched_files, anchor, superseded_by, seq, created_at) " +
      "VALUES (?, 'p1', 'decision', 'ledger', ?, ?, 0, NULL, ?, '2026-08-22T00:00:00.000Z')",
  );
  insert.run("e1", "dedup inside one array", '["src/a.ts","src/a.ts","src/b.ts"]', 1);
  insert.run("e2", "null touched_files", null, 2);
  // Fixture strings stay brace-free: gate-clamps counts braces naively (string text included), so an
  // open-brace character inside SQL text made this region measure as one unterminated function.
  insert.run("e3", "malformed json", "[oops", 3);
  insert.run("e4", "valid json but not an array", '"just a string"', 4);
  sculptor.close();
}

it("M4 backfill: one openMemoryDb populates journal_entry_files (deduped), skips bad JSON rows, lands version 21", () => {
  const dbPath = tempDbPath();
  seedPreMigrationDb(dbPath);

  const opened = openMemoryDb(dbPath);
  try {
    expect(versions(opened)).toEqual([14, 15, 21]);
    const projected = opened
      .prepare(
        "SELECT entry_id, project_id, file_key, seq FROM journal_entry_files ORDER BY entry_id, file_key",
      )
      .all() as Array<{ entry_id: string; project_id: string; file_key: string; seq: number }>;
    // e1's in-row duplicate collapses (PK entry_id+file_key); e3 (malformed) and e4 (non-array)
    // are skipped entirely; e2 has no files.
    expect(projected).toEqual([
      { entry_id: "e1", project_id: "p1", file_key: "src/a.ts", seq: 1 },
      { entry_id: "e1", project_id: "p1", file_key: "src/b.ts", seq: 1 },
    ]);
  } finally {
    closeDb(opened);
  }
});

it("M4 backfill: a SECOND openMemoryDb writes nothing (.db and -wal byte-identical)", () => {
  const dbPath = tempDbPath();
  seedPreMigrationDb(dbPath);
  const first = openMemoryDb(dbPath);
  first.pragma("wal_checkpoint(TRUNCATE)");
  closeDb(first);
  const dbBefore = shaOrEmpty(dbPath);
  const walBefore = shaOrEmpty(`${dbPath}-wal`);

  const second = openMemoryDb(dbPath);
  try {
    second.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    closeDb(second);
  }
  expect(shaOrEmpty(dbPath)).toBe(dbBefore);
  expect(shaOrEmpty(`${dbPath}-wal`)).toBe(walBefore);
});

it("M4 r2 (F2): a hostile touched_files value INSERTs fine and projects nothing — the trigger guard", () => {
  const dbPath = tempDbPath();
  seedPreMigrationDb(dbPath);
  const db = openMemoryDb(dbPath);
  try {
    // json_type() THROWS on malformed input, so an unguarded trigger would abort the INSERT and take the
    // journal row with it. Round 2 nests the guard instead of leaning on AND operand order (SQLite
    // documents lazy evaluation for CASE, not for AND); this pins the OUTCOME, which is what a future
    // SQLite could change: the row lands, and the malformed value simply projects nothing.
    const insert = db.prepare(
      "INSERT INTO journal_entries " +
        "(entry_id, project_id, category, author, body, touched_files, anchor, superseded_by, seq, created_at) " +
        "VALUES (?, 'p1', 'decision', 'ledger', 'hostile', ?, 0, NULL, ?, '2026-08-22T00:00:00.000Z')",
    );
    // Fixture strings stay brace-free: gate-clamps counts braces naively, string text included.
    for (const [entryId, touched, seq] of [
      ["h1", "[oops", 11],
      ["h2", '"just a string"', 12],
      ["h3", "42", 13],
      ["h4", null, 14],
    ] as [string, string | null, number][]) {
      expect(() => insert.run(entryId, touched, seq)).not.toThrow();
    }
    const landed = db
      .prepare("SELECT COUNT(*) AS c FROM journal_entries WHERE entry_id LIKE 'h_'")
      .get() as { c: number };
    expect(landed.c).toBe(4);
    const projected = db
      .prepare("SELECT COUNT(*) AS c FROM journal_entry_files WHERE entry_id LIKE 'h_'")
      .get() as { c: number };
    expect(projected.c).toBe(0);
  } finally {
    closeDb(db);
  }
});

it("M4 r2 (F4): backfilledRows counts rows this backfill WROTE, not the table total", () => {
  const dbPath = tempDbPath();
  seedPreMigrationDb(dbPath);
  const raw = new Database(dbPath);
  try {
    raw.pragma("foreign_keys = ON");
    // The one state where the two numbers differ: a DB already carrying projection rows but no
    // version-21 row. CREATE TABLE IF NOT EXISTS keeps those rows, so the table total counted a row this
    // backfill never wrote. No production path produces this state — which is exactly why nothing
    // noticed the number was wrong.
    // REBASE ROUND: the footprint is built from the migration's OWN DDL, not a hand-typed CREATE. Since
    // the body-drift probe (R4-F1) landed, a same-name table with a DIFFERENT body is dropped and
    // rebuilt, which would discard the stray row and dissolve the very state this test needs.
    raw.exec(MIGRATION_V15_TO_V21);
    raw.exec("DELETE FROM _schema_version WHERE version = 21");
    raw.exec("DELETE FROM journal_entry_files");
    raw.prepare("INSERT INTO journal_entry_files VALUES ('e2', 'p1', 'src/stray.ts', 2)").run();

    const result = applyFileProjectionStep(raw);
    // e1 projects two keys after its in-row duplicate collapses; e3 (malformed) and e4 (non-array) are
    // skipped; e2 has no files. The stray row was already there, so 3 rows in the table, 2 written.
    // Both object lists are EMPTY on purpose. repairedObjects (round 2, R5-F6): there is no
    // version-21 row here, so this is a FIRST migration and not a repair. displacedObjects (round 3,
    // R6-F3): the four objects were built from the migration's own DDL, so they match the contract
    // exactly and NOTHING was dropped to make room — which is the whole reason the stray row survives
    // and this test can tell "rows written" apart from "rows in the table".
    expect(result).toEqual({
      backfilledRows: 2,
      skippedRows: 2,
      repairedObjects: [],
      displacedObjects: [],
    });
    const total = raw.prepare("SELECT COUNT(*) AS c FROM journal_entry_files").get() as {
      c: number;
    };
    expect(total.c).toBe(3);
  } finally {
    raw.close();
  }
});

// M4 ROUND 4 (codex r1-B): every superseded match used to keep its projection rows forever, so a hot key
// carrying a long RETIRED history made the read join-and-reject every one of those rows before LIMIT could
// see an active one — measured 145.366 ms vs 0.078 ms cold at tip (2026-08-25, codex's corpus shape,
// 100,000 retired rows on one key). The fix is WRITE-SIDE: retiring an entry removes its projection rows
// atomically (AFTER UPDATE OF superseded_by), so a retired history stops existing in the projection at all.
function projectedCount(db: Db, entryId: string): number {
  return (
    db.prepare("SELECT COUNT(*) AS c FROM journal_entry_files WHERE entry_id = ?").get(entryId) as {
      c: number;
    }
  ).c;
}

it("M4 r4 (codex r1-B): retiring an entry removes its projection rows — the supersede cleanup trigger", () => {
  const dbPath = tempDbPath();
  seedPreMigrationDb(dbPath);
  const db = openMemoryDb(dbPath);
  try {
    const insert = db.prepare(
      "INSERT INTO journal_entries " +
        "(entry_id, project_id, category, author, body, touched_files, anchor, superseded_by, seq, created_at) " +
        "VALUES (?, 'p1', 'decision', 'ledger', ?, ?, 0, NULL, ?, '2026-08-22T00:00:00.000Z')",
    );
    insert.run("live", "two keys", '["src/a.ts","src/b.ts"]', 5);
    insert.run("victim", "one key", '["src/a.ts"]', 6);
    expect(projectedCount(db, "live")).toBe(2);
    expect(projectedCount(db, "victim")).toBe(1);

    // Retire through the same statement production supersede() runs: the rows go WITHIN the UPDATE's
    // transaction, not eventually.
    db.prepare("UPDATE journal_entries SET superseded_by = 'live' WHERE entry_id = 'victim'").run();
    expect(projectedCount(db, "victim")).toBe(0);

    // Retiring again (idempotent re-supersede) and retiring a file-less entry are both no-ops.
    db.prepare("UPDATE journal_entries SET superseded_by = 'live' WHERE entry_id = 'victim'").run();
    expect(projectedCount(db, "live")).toBe(2);
    expect(projectedCount(db, "victim")).toBe(0);

    // Un-retire is documented one-way (J5 has no resurrection path): the rows stay gone rather than
    // silently reappearing half-projected; recovery is a maintenance pass, like skipped backfill rows.
    db.prepare("UPDATE journal_entries SET superseded_by = NULL WHERE entry_id = 'victim'").run();
    expect(projectedCount(db, "victim")).toBe(0);

    // A row BORN retired (inserted with superseded_by already set — raw/test writes only; appendEntry
    // never does this) is skipped by the insert trigger, keeping the active-entries-only invariant.
    const bornDead = db.prepare(
      "INSERT INTO journal_entries " +
        "(entry_id, project_id, category, author, body, touched_files, anchor, superseded_by, seq, created_at) " +
        "VALUES (?, 'p1', 'decision', 'ledger', ?, ?, 0, ?, ?, '2026-08-22T00:00:00.000Z')",
    );
    bornDead.run("born-dead", "retired at birth", '["src/a.ts"]', "live", 10);
    expect(projectedCount(db, "born-dead")).toBe(0);
  } finally {
    closeDb(db);
  }
});

it("M4 r4 (codex r1-B): the migration purges legacy projection rows of ALREADY-retired entries", () => {
  const dbPath = tempDbPath();
  seedPreMigrationDb(dbPath);
  // Sculpt a retired entry WITH files into the pre-v21 DB — the shape every DB written before round 4
  // carries (supersede used to leave the rows behind).
  const sculptor = new Database(dbPath);
  sculptor
    .prepare(
      "INSERT INTO journal_entries " +
        "(entry_id, project_id, category, author, body, touched_files, anchor, superseded_by, seq, created_at) " +
        "VALUES (?, 'p1', 'decision', 'ledger', ?, ?, 0, ?, ?, '2026-08-22T00:00:00.000Z')",
    )
    .run("legacy-active", "active with files", '["src/a.ts","src/cold.ts"]', null, 7);
  const legacy = sculptor.prepare(
    "INSERT INTO journal_entries " +
      "(entry_id, project_id, category, author, body, touched_files, anchor, superseded_by, seq, created_at) " +
      "VALUES (?, 'p1', 'decision', 'ledger', ?, ?, 0, ?, ?, '2026-08-22T00:00:00.000Z')",
  );
  legacy.run("legacy-replacer", "the replacement", null, null, 8);
  legacy.run("legacy-dead", "retired long ago", '["src/a.ts"]', "legacy-replacer", 9);
  sculptor.close();

  const db = openMemoryDb(dbPath);
  try {
    expect(versions(db)).toEqual([14, 15, 21]);
    // The retired history is gone from the projection entirely; the live rows are all still projected.
    expect(projectedCount(db, "legacy-dead")).toBe(0);
    expect(projectedCount(db, "legacy-active")).toBe(2);
    expect(projectedCount(db, "e1")).toBe(2);
  } finally {
    closeDb(db);
  }
});

// M4 ROUND 4 (codex r1-C): version 21 in _schema_version used to mark memory complete by itself, so a DB
// that lost a v21 physical object (sculpted probe: DROP TRIGGER journal_entry_files_after_insert) read as
// fully migrated forever — appends committed but projected nothing and recall silently missed them
// (DRIFT memoryComplete:true projectionRows:0 recalled:[], reproduced at tip 2026-08-25). The accepted-set
// check now ALSO requires the physical footprint; a mismatch re-runs the idempotent migration body under
// BEGIN IMMEDIATE (repair-in-tier), the same shape the lane tier uses for fl150's un-version-bumped column.
const MEMORY_KEYS: AcceptedVersionKeys = {
  global: ["14"],
  memory: [
    "14,15,21",
    "14,15,16,21",
    "14,15,16,17,21",
    "14,15,16,17,18,21",
    "14,15,16,17,18,19,21",
    "14,15,16,20,21",
  ],
  lane: ["14,15,16,20,21", "14,15,16,17,20,21", "14,15,16,17,18,20,21", "14,15,16,17,18,19,20,21"],
};

function hasObject(db: Db, type: string, name: string): boolean {
  return (
    db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = ? AND name = ?").get(type, name) !==
    undefined
  );
}

it("M4 r4 (codex r1-C): chainReadiness memoryComplete requires v21's PHYSICAL objects, not just the version row", () => {
  const dbPath = tempDbPath();
  seedPreMigrationDb(dbPath);
  const healthy = openMemoryDb(dbPath);
  try {
    expect(chainReadiness(healthy, MEMORY_KEYS).memoryComplete).toBe(true);
  } finally {
    closeDb(healthy);
  }
  // Sculpt codex's exact drift: accepted {14,15,21}, one v21 object gone.
  const sculptor = new Database(dbPath);
  sculptor.exec("DROP TRIGGER journal_entry_files_after_insert");
  sculptor.close();
  const drifted = new Database(dbPath);
  try {
    drifted.pragma("foreign_keys = ON");
    expect(versions(drifted)).toEqual([14, 15, 21]); // the version set still looks perfect
    expect(hasObject(drifted, "trigger", "journal_entry_files_after_insert")).toBe(false);
    expect(chainReadiness(drifted, MEMORY_KEYS).memoryComplete).toBe(false);
  } finally {
    drifted.close();
  }
});

it("M4 r4 (codex r1-C): reopening a drifted {14,15,21} DB REPAIRS it instead of silently dropping appends", () => {
  const dbPath = tempDbPath();
  seedPreMigrationDb(dbPath);
  const first = openMemoryDb(dbPath);
  first.pragma("wal_checkpoint(TRUNCATE)");
  closeDb(first);
  const sculptor = new Database(dbPath);
  sculptor.exec("DROP TRIGGER journal_entry_files_after_insert");
  sculptor.close();

  // The REAL open path: readiness says incomplete, so applyMemoryMigration re-runs its idempotent body.
  const repaired = openMemoryDb(dbPath);
  try {
    expect(hasObject(repaired, "trigger", "journal_entry_files_after_insert")).toBe(true);
    expect(hasObject(repaired, "trigger", "journal_entry_files_supersede_cleanup")).toBe(true);
    // The append that used to vanish now projects: raw INSERT (appendEntry's statement shape).
    repaired
      .prepare(
        "INSERT INTO journal_entries " +
          "(entry_id, project_id, category, author, body, touched_files, anchor, superseded_by, seq, created_at) " +
          "VALUES (?, 'p1', 'decision', 'ledger', ?, ?, 0, NULL, ?, '2026-08-22T00:00:00.000Z')",
      )
      .run("after-repair", "appended after repair", '["src/a.ts","src/b.ts"]', 6);
    expect(projectedCount(repaired, "after-repair")).toBe(2);
    expect(chainReadiness(repaired, MEMORY_KEYS).memoryComplete).toBe(true);
  } finally {
    closeDb(repaired);
  }
});

// M4 REBASE ITEM 6 (review r4 finding R4-F1) — the seam half of the body-drift close. Round 4's probe
// matched (type, name) only, so an object REPLACED under the same name read healthy forever and the
// repair could not touch it: the migration body is `CREATE TRIGGER IF NOT EXISTS`, a no-op against an
// existing name. The reviewer reproduced codex r1-C's exact symptom through that door at tip 72aa9ce
// (BODY-DRIFT memoryComplete:true, projectionRows:0, recalled:[]). Detection alone would not have been
// enough — without the DROP the open would re-run the body on every single open and never converge.
it("M4 rebase (R4-F1): a v21 object rewritten under its own name is REBUILT on the next memory open", () => {
  const dbPath = tempDbPath();
  seedPreMigrationDb(dbPath);
  const first = openMemoryDb(dbPath);
  first.pragma("wal_checkpoint(TRUNCATE)");
  closeDb(first);

  const sculptor = new Database(dbPath);
  sculptor.exec("DROP TRIGGER journal_entry_files_after_insert");
  // Same type, same name, inert body: present to any name-based probe, useless to the projection.
  sculptor.exec(
    "CREATE TRIGGER journal_entry_files_after_insert AFTER INSERT ON journal_entries BEGIN SELECT 1; END",
  );
  expect(hasObject(sculptor, "trigger", "journal_entry_files_after_insert")).toBe(true);
  expect(versions(sculptor)).toEqual([14, 15, 21]); // the version set still looks perfect
  expect(chainReadiness(sculptor, MEMORY_KEYS).memoryComplete).toBe(false);
  sculptor.close();

  const repaired = openMemoryDb(dbPath);
  try {
    // The append that vanished under the inert trigger projects again.
    repaired
      .prepare(
        "INSERT INTO journal_entries " +
          "(entry_id, project_id, category, author, body, touched_files, anchor, superseded_by, seq, created_at) " +
          "VALUES (?, 'p1', 'decision', 'ledger', ?, ?, 0, NULL, ?, '2026-09-01T00:00:00.000Z')",
      )
      .run("after-body-drift", "appended after the rebuild", '["src/a.ts","src/b.ts"]', 7);
    expect(projectedCount(repaired, "after-body-drift")).toBe(2);
    expect(chainReadiness(repaired, MEMORY_KEYS).memoryComplete).toBe(true);
  } finally {
    closeDb(repaired);
  }

  // CONVERGENCE, the property a detector without a repair would have destroyed: the very next open
  // finds the footprint intact and performs ZERO writes, so the file is byte-identical afterwards.
  const settled = openMemoryDb(dbPath);
  settled.pragma("wal_checkpoint(TRUNCATE)");
  closeDb(settled);
  const before = createHash("sha256").update(readFileSync(dbPath)).digest("hex");
  const reopened = openMemoryDb(dbPath);
  reopened.pragma("wal_checkpoint(TRUNCATE)");
  closeDb(reopened);
  expect(createHash("sha256").update(readFileSync(dbPath)).digest("hex")).toBe(before);
});

// M4 REBASE ROUND 2 (review R5-F4) — the corner where the repair used to STOP converging, and where a
// failure was permanent: a v21 NAME occupied by an object of another KIND. The old drop used the
// EXPECTED type, so it either threw ("use DROP VIEW to delete view journal_entry_files") or silently
// did nothing under IF EXISTS and let the follow-on CREATE throw ("there is already a table named
// idx_journal_entry_files_lookup"). Either way the tier rolled back, the offending object stayed on
// disk, and EVERY later memory open failed identically — the database became unopenable memory-on with
// no recovery short of hand-written SQL. Reachability is low (nothing in the product creates those
// names) but the cost when reached was total, and the header claimed convergence flatly.
it.each([
  ["a VIEW over the projection TABLE name", "CREATE VIEW journal_entry_files AS SELECT 1 AS x"],
  [
    "a TABLE over the projection INDEX name",
    "CREATE TABLE idx_journal_entry_files_lookup (x INTEGER)",
  ],
])("M4 rebase (R5-F4): %s is dropped by its REAL type and the open converges", (_label, sculpt) => {
  const dbPath = tempDbPath();
  seedPreMigrationDb(dbPath);
  const first = openMemoryDb(dbPath);
  first.pragma("wal_checkpoint(TRUNCATE)");
  closeDb(first);

  const sculptor = new Database(dbPath);
  // Take the real object out from under the name, then squat on it with the wrong kind of object.
  sculptor.exec("DROP TABLE IF EXISTS journal_entry_files");
  sculptor.exec("DROP INDEX IF EXISTS idx_journal_entry_files_lookup");
  sculptor.exec(sculpt);
  sculptor.close();

  // 1. The open SUCCEEDS instead of throwing SQLITE_ERROR out of the memory tier.
  const repaired = openMemoryDb(dbPath);
  try {
    expect(versions(repaired)).toEqual([14, 15, 21]);
    expect(chainReadiness(repaired, MEMORY_KEYS).memoryComplete).toBe(true);
    // 2. The projection is whole again, re-derived from journal_entries by the backfill.
    const rows = repaired.prepare("SELECT COUNT(*) AS c FROM journal_entry_files").get() as {
      c: number;
    };
    expect(rows.c).toBe(2); // e1's two file keys; e2/e3/e4 contribute none
  } finally {
    closeDb(repaired);
  }

  // 3. CONVERGENCE, the property the old shape lost: the next open writes nothing at all.
  const settled = openMemoryDb(dbPath);
  settled.pragma("wal_checkpoint(TRUNCATE)");
  closeDb(settled);
  const before = createHash("sha256").update(readFileSync(dbPath)).digest("hex");
  const reopened = openMemoryDb(dbPath);
  reopened.pragma("wal_checkpoint(TRUNCATE)");
  closeDb(reopened);
  expect(createHash("sha256").update(readFileSync(dbPath)).digest("hex")).toBe(before);
});
