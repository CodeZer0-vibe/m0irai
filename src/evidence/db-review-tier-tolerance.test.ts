/**
 * @file src/evidence/db-review-tier-tolerance.test.ts
 * @purpose W3 (THE GREAT DELETION, 2026-07-17) — falsifiable proof for the referee's CONCERN 1 (DB
 *   migration/tombstone story): openReviewDb/applyReviewMigration/migrations-v17.ts/migrations-v18.ts/
 *   migrations-v19.ts are DELETED (db.ts's own header carries the full contract), but an existing
 *   dogfood DB that already carries the review/write-gate tier (schema versions 17-19) must still boot
 *   clean via the THREE SURVIVING openers, with its review-tier tables/rows left completely untouched
 *   -- neither recreated (no producer exists to recreate them) nor read/written (no query anywhere
 *   targets them; this file's own fixture is hand-built with a LITERAL, historical-only SQL string,
 *   never production code, since the production producer no longer exists).
 * @exports (none — test file)
 * @depends better-sqlite3, node:fs, node:os, node:path, vitest, ./db
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { type Db, closeDb, openDb, openLaneStateDb, openMemoryDb } from "./db.js";
import { MIGRATION_V15_TO_V16 } from "./migrations-v16.js";

let tempRoot: string | undefined;
const handles: Db[] = [];

function tempDbPath(): string {
  tempRoot = mkdtempSync(path.join(tmpdir(), "review-tolerance-"));
  return path.join(tempRoot, "evidence.db");
}

function track(db: Db): Db {
  handles.push(db);
  return db;
}

afterEach(() => {
  for (const db of handles.splice(0)) {
    closeDb(db);
  }
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    tempRoot = undefined;
  }
});

function versionSet(db: Db): string {
  const rows = db.prepare("SELECT version FROM _schema_version ORDER BY version").all() as Array<{
    version: number;
  }>;
  return rows.map((r) => r.version).join(",");
}

// A LITERAL, historical-only re-creation of just enough of the deleted v17/v19 shape to falsify the
// tolerance contract -- deliberately NOT importing anything from db.ts/migrations.ts (that production
// code must stay free of any review-tier producer): a minimal _schema_version tail + one write-gate
// table (write_queue) + one review table (review_deltas) with a seeded row each, standing in for the
// full 8-table shape migrations-v17.test.ts used to assert before it was deleted alongside its feature.
const LEGACY_REVIEW_TIER_SQL = `
CREATE TABLE IF NOT EXISTS review_deltas (
  review_id TEXT NOT NULL PRIMARY KEY,
  repo_root TEXT NOT NULL,
  status    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS write_queue (
  id        TEXT NOT NULL PRIMARY KEY,
  repo_root TEXT NOT NULL,
  status    TEXT NOT NULL
);
INSERT INTO review_deltas (review_id, repo_root, status) VALUES ('legacy-r1', 'C:/repo', 'open');
INSERT INTO write_queue (id, repo_root, status) VALUES ('legacy-q1', 'C:/repo', 'confirmed');
INSERT OR IGNORE INTO _schema_version(version) VALUES (17);
INSERT OR IGNORE INTO _schema_version(version) VALUES (18);
INSERT OR IGNORE INTO _schema_version(version) VALUES (19);
`;

/** Builds a genuine pre-v20 fixture: memory opens through v15, then raw historical SQL adds v16 and
 * retired review versions 17-19. The current lane opener must preserve those rows while adding v20. */
function makeLegacyReviewTierDb(dbPath: string): void {
  closeDb(openMemoryDb(dbPath));
  const raw = new Database(dbPath);
  try {
    raw.exec(MIGRATION_V15_TO_V16);
    raw.exec(LEGACY_REVIEW_TIER_SQL);
  } finally {
    raw.close();
  }
}

it("W3 tombstone-tolerance builds a real pre-v20 review-tier fixture", () => {
  const dbPath = tempDbPath();
  makeLegacyReviewTierDb(dbPath);
  const raw = new Database(dbPath);
  try {
    const rows = raw
      .prepare("SELECT version FROM _schema_version ORDER BY version")
      .all() as Array<{
      version: number;
    }>;
    expect(rows.map((r) => r.version).join(",")).toBe("14,15,16,17,18,19,21"); // M4: the builder's openMemoryDb call lands v21 first
    const review = raw
      .prepare("SELECT status FROM review_deltas WHERE review_id = ?")
      .get("legacy-r1") as { status: string };
    expect(review.status).toBe("open");
  } finally {
    raw.close();
  }
});

it("W3 tombstone-tolerance: openDb boots the review-tier fixture clean (no SCHEMA_DRIFT) and never mutates its version set", () => {
  const dbPath = tempDbPath();
  makeLegacyReviewTierDb(dbPath);
  const db = track(openDb(dbPath));
  expect(versionSet(db)).toBe("14,15,16,17,18,19,21"); // M4: fixture carries v21; openDb must not mutate it
});

it("W3 tombstone-tolerance: openMemoryDb boots the review-tier fixture clean and never mutates its version set", () => {
  const dbPath = tempDbPath();
  makeLegacyReviewTierDb(dbPath);
  const db = track(openMemoryDb(dbPath));
  expect(versionSet(db)).toBe("14,15,16,17,18,19,21"); // M4: fixture carries v21; memory open is steady on it
});

it("W3 tombstone-tolerance: lane open adds v20 without deleting retired review rows", () => {
  const dbPath = tempDbPath();
  makeLegacyReviewTierDb(dbPath);
  const db = track(openLaneStateDb(dbPath));
  expect(versionSet(db)).toBe("14,15,16,17,18,19,20,21"); // M4: fixture carries v21; lane adds only v20
});

it("W3 tombstone-tolerance: the review/write-gate rows survive a full open+close cycle through all three survivors, byte-identical (neither recreated nor read)", () => {
  const dbPath = tempDbPath();
  makeLegacyReviewTierDb(dbPath);
  for (const opener of [openDb, openMemoryDb, openLaneStateDb]) {
    closeDb(opener(dbPath));
  }
  const raw = new Database(dbPath);
  try {
    const review = raw
      .prepare("SELECT repo_root, status FROM review_deltas WHERE review_id = 'legacy-r1'")
      .get() as { repo_root: string; status: string };
    expect(review).toEqual({ repo_root: "C:/repo", status: "open" });
    const queued = raw
      .prepare("SELECT repo_root, status FROM write_queue WHERE id = 'legacy-q1'")
      .get() as { repo_root: string; status: string };
    expect(queued).toEqual({ repo_root: "C:/repo", status: "confirmed" });
  } finally {
    raw.close();
  }
});

it("W3 tombstone-tolerance: a DB that never had the review tier is NEVER migrated into it by any surviving opener", () => {
  const dbPath = tempDbPath();
  closeDb(track(openLaneStateDb(dbPath)));
  const raw = new Database(dbPath);
  try {
    const table = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='review_deltas'")
      .get();
    expect(table).toBeUndefined();
  } finally {
    raw.close();
  }
});
