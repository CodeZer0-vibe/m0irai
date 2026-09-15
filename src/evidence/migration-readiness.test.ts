// FL-077 round 3 — unit falsifiers for migration-readiness.ts itself (its public seam is already
// covered through openDb/openMemoryDb in schema-version-storage.test.ts). These pin the module's
// own contract directly: strict key validation, the absent-table NOT_READY shape, and the lane
// tier's physical aborted_at probe that an accepted version set alone cannot prove.
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { ConfigError } from "../shared/errors.js";
import {
  type AcceptedVersionKeys,
  chainReadiness,
  columnExists,
  validatedVersionKey,
} from "./migration-readiness.js";
import { MIGRATION_V15_TO_V21 } from "./migrations-v21.js";

// Mirrors db.ts's ACCEPTED_VERSION_KEYS shape: every tier also accepts the sets a LATER lazy
// migration may have produced (a lane-migrated DB must never read as drift to an earlier open).
// M4: the memory and lane lists carry ONLY `,21` sets, matching db.ts — an un-suffixed set there
// would read an un-projected database as complete and version 21 would never run.
const KEYS: AcceptedVersionKeys = {
  global: ["14", "14,15", "14,15,16,20", "14,15,21", "14,15,16,20,21"],
  memory: ["14,15,21", "14,15,16,20,21"],
  lane: ["14,15,16,20,21"],
};

function memoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE _schema_version (version INTEGER PRIMARY KEY)");
  return db;
}

// The v21 physical footprint memoryComplete now requires, built from the migration's OWN SQL so the
// stored bodies are exactly the ones the probe expects. journal_entries is the minimal shape the
// triggers and the backfill name; the migration's version-21 insert is undone by the caller when the
// case needs a different version set.
function buildFileProjection(db: Database.Database): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS journal_entries (entry_id TEXT PRIMARY KEY, project_id TEXT, touched_files TEXT, seq INTEGER, superseded_by TEXT)",
  );
  db.exec(MIGRATION_V15_TO_V21);
}

it("validatedVersionKey joins only validated integer rows", () => {
  const db = memoryDb();
  try {
    db.exec("INSERT INTO _schema_version(version) VALUES (14), (15)");
    expect(validatedVersionKey(db)).toBe("14,15");
  } finally {
    db.close();
  }
});

it("validatedVersionKey throws EvidenceSchemaDrift on a text row instead of joining it", () => {
  const db = new Database(":memory:");
  try {
    // Sculpted TEXT column: the natural INTEGER PRIMARY KEY refuses non-integer storage.
    db.exec("CREATE TABLE _schema_version (version TEXT)");
    db.exec("INSERT INTO _schema_version(version) VALUES ('14,15')");
    let threw: unknown;
    try {
      validatedVersionKey(db);
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(ConfigError);
    expect((threw as ConfigError).code).toBe("ZER0_EVIDENCE_SCHEMA_DRIFT");
    expect((threw as ConfigError).message).toMatch(/text "14,15"/);
  } finally {
    db.close();
  }
});

it("chainReadiness reports every tier not-ready when _schema_version does not exist", () => {
  const db = new Database(":memory:");
  try {
    expect(chainReadiness(db, KEYS)).toEqual({
      globalComplete: false,
      memoryComplete: false,
      laneComplete: false,
    });
  } finally {
    db.close();
  }
});

it("chainReadiness gates each tier on its own accepted key", () => {
  const db = memoryDb();
  try {
    db.exec("INSERT INTO _schema_version(version) VALUES (16), (20)");
    // {16,20} matches none of the three accepted keys.
    const partial = chainReadiness(db, KEYS);
    expect(partial.globalComplete).toBe(false);
    expect(partial.memoryComplete).toBe(false);
    expect(partial.laneComplete).toBe(false);

    buildFileProjection(db); // M4: memoryComplete also needs v21's physical footprint
    db.exec("DELETE FROM _schema_version");
    db.exec("INSERT INTO _schema_version(version) VALUES (14), (15), (16), (20), (21)");
    const full = chainReadiness(db, KEYS);
    expect(full.globalComplete).toBe(true);
    expect(full.memoryComplete).toBe(true);
    // Version set alone is NOT enough for the lane tier — see next case.
    expect(full.laneComplete).toBe(false);
  } finally {
    db.close();
  }
});

// M4 round 4 (codex r1-C) at THIS seam: the memory tier is the mirror image of the lane tier below —
// an accepted version set proves nothing about v21's physical objects, so chainReadiness reads them.
it("the memory tier completes only when v21's physical objects exist too", () => {
  const db = memoryDb();
  try {
    db.exec("INSERT INTO _schema_version(version) VALUES (14), (15), (21)");
    // Accepted key, zero projection objects: the version row is a claim, not a footprint.
    expect(chainReadiness(db, KEYS).memoryComplete).toBe(false);
    buildFileProjection(db);
    expect(chainReadiness(db, KEYS).memoryComplete).toBe(true);
    // And losing any ONE of the four objects takes it back to false.
    db.exec("DROP TRIGGER journal_entry_files_after_insert");
    expect(chainReadiness(db, KEYS).memoryComplete).toBe(false);
  } finally {
    db.close();
  }
});

// M4 rebase round (review r4 finding R4-F1): the half a (type, name) probe could not see. An object
// REPLACED under the same name reads present, and `CREATE ... IF NOT EXISTS` cannot overwrite it, so a
// name-only probe leaves an inert trigger in place forever — reproducing codex r1-C's exact symptom
// (memoryComplete:true, projectionRows:0, recalled:[]) through a different door. The stored BODY is
// what the probe compares now.
it("the memory tier does NOT complete when a v21 object keeps its name but changes its body", () => {
  const db = memoryDb();
  try {
    db.exec("INSERT INTO _schema_version(version) VALUES (14), (15), (21)");
    buildFileProjection(db);
    expect(chainReadiness(db, KEYS).memoryComplete).toBe(true);

    db.exec("DROP TRIGGER journal_entry_files_after_insert");
    db.exec(
      "CREATE TRIGGER journal_entry_files_after_insert AFTER INSERT ON journal_entries BEGIN SELECT 1; END",
    );
    // Same type, same name, inert body — present by every name-based measure.
    const named = db
      .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = ?")
      .get("journal_entry_files_after_insert") as { c: number };
    expect(named.c).toBe(1);
    expect(chainReadiness(db, KEYS).memoryComplete).toBe(false);
  } finally {
    db.close();
  }
});

it("the lane tier completes only when the physical aborted_at column exists too", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE lane_prompt_attempts (id INTEGER PRIMARY KEY)");
    db.exec("CREATE TABLE _schema_version (version INTEGER PRIMARY KEY)");
    db.exec("INSERT INTO _schema_version(version) VALUES (14), (15), (16), (20), (21)");
    expect(chainReadiness(db, KEYS).laneComplete).toBe(false);
    db.exec("ALTER TABLE lane_prompt_attempts ADD COLUMN aborted_at TEXT");
    expect(chainReadiness(db, KEYS).laneComplete).toBe(true);
  } finally {
    db.close();
  }
});

it("columnExists reads PRAGMA table_info and distinguishes present from absent", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE t (a INTEGER)");
    expect(columnExists(db, "t", "a")).toBe(true);
    expect(columnExists(db, "t", "b")).toBe(false);
    expect(columnExists(db, "missing_table", "a")).toBe(false);
  } finally {
    db.close();
  }
});
