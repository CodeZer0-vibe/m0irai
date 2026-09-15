// Smoke test — confirms the extracted applyMigrations function wired through openDb
// drives a fresh DB to schema version 14. Uses REAL better-sqlite3 + a temp file (no mocks).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { closeDb, openDb } from "./db.js";

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

it("applyMigrations (extracted) drives a fresh DB to schema version 14", () => {
  tempRoot = mkdtempSync(join(tmpdir(), "zer0-migrations-smoke-"));
  const dbPath = join(tempRoot, "evidence.db");
  const db = openDb({ dbPath });
  try {
    const row = db.prepare("SELECT version FROM _schema_version").get() as
      | { version: number }
      | undefined;
    expect(row?.version).toBe(14);
  } finally {
    closeDb(db);
  }
});
