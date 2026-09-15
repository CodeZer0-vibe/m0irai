/**
 * @file src/evidence/db-pre-m4-tolerance.test.ts
 * @purpose M4 round-2 review F6 — the half of GLOBAL_VERSION_KEYS that keeps the operator's EXISTING
 *   evidence DB openable once v21 exists. The global opener never runs the memory segment, so a DB that
 *   has not met openMemoryDb yet still carries a pre-M4 set; openDb must TOLERATE it without migrating
 *   it, while openMemoryDb is the one that lands 21. Nothing pinned this: deleting the un-suffixed keys
 *   from GLOBAL left the whole suite green while openDb threw SCHEMA_DRIFT on the operator's own
 *   {14,15,16,20} database.
 * @exports (none — test file)
 * @depends better-sqlite3, node:fs, node:os, node:path, vitest, ./db, ./migrations-v15, ./migrations-v16,
 *   ./migrations-v20
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { type Db, closeDb, openDb, openMemoryDb } from "./db.js";
import { MIGRATION_V14_TO_V15 } from "./migrations-v15.js";
import { MIGRATION_V15_TO_V16 } from "./migrations-v16.js";
import { MIGRATION_V16_TO_V20 } from "./migrations-v20.js";

let tempRoot: string | undefined;

afterEach(() => {
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

function hasProjection(db: Db): boolean {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'journal_entry_files'")
    .get() as { c: number };
  return row.c > 0;
}

// A GENUINE pre-M4 database: the global chain via openDb lands {14}, then the historical memory/lane SQL
// steps are applied directly, exactly as an open before this lane produced them. No 21 anywhere.
function buildPreM4Db(steps: readonly string[]): string {
  tempRoot = mkdtempSync(join(tmpdir(), "zer0-pre-m4-"));
  const dbPath = join(tempRoot, "evidence.db");
  closeDb(openDb(dbPath));
  const sculptor = new Database(dbPath);
  for (const step of steps) {
    sculptor.exec(step);
  }
  sculptor.close();
  return dbPath;
}

it("F6: openDb TOLERATES a pre-M4 memory DB at 14,15 and does not migrate it", () => {
  const dbPath = buildPreM4Db([MIGRATION_V14_TO_V15]);
  const db = openDb(dbPath);
  try {
    // Tolerated, not drifted: GLOBAL keeps every un-suffixed base set because openDb never runs the
    // memory segment. Remove them and this line throws ConfigError SCHEMA_DRIFT.
    expect(versionSet(db)).toBe("14,15");
    expect(hasProjection(db)).toBe(false);
  } finally {
    closeDb(db);
  }
});

it("F6: openDb TOLERATES the operator's own 14,15,16,20 lane DB and does not migrate it", () => {
  const dbPath = buildPreM4Db([MIGRATION_V14_TO_V15, MIGRATION_V15_TO_V16, MIGRATION_V16_TO_V20]);
  const db = openDb(dbPath);
  try {
    expect(versionSet(db)).toBe("14,15,16,20");
    expect(hasProjection(db)).toBe(false);
  } finally {
    closeDb(db);
  }
});

it("F6: openMemoryDb is what MIGRATES a pre-M4 14,15 DB — landing 14,15,21 with the projection", () => {
  const dbPath = buildPreM4Db([MIGRATION_V14_TO_V15]);
  const db = openMemoryDb(dbPath);
  try {
    expect(versionSet(db)).toBe("14,15,21");
    expect(hasProjection(db)).toBe(true);
  } finally {
    closeDb(db);
  }
});
