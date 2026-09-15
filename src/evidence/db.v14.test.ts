// U2e-c v13->v14 migration: chat_messages gains a nullable dispatched_agents TEXT (JSON) column so the
// #8 interrupted-lane audit trail (INV-EF7) survives on EXISTING DBs, not just fresh installs. Modeled on
// db.v13.test.ts — seed an OLD-shape DB programmatically, openDb migrates it, assert the column + version.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { type Db, closeDb, openDb } from "./db.js";

const TEMP_PREFIX = "zer0-v14-db-";
const DB_FILE = "evidence.db";
const NOW = "2026-07-04T00:00:00.000Z";

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

function tempDbPath(): string {
  tempRoot = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  return join(tempRoot, DB_FILE);
}

function withDb(dbPath: string, body: (db: Db) => void): void {
  const db = openDb(dbPath);
  try {
    body(db);
  } finally {
    closeDb(db);
  }
}

function schemaVersion(db: Db): number {
  const row = db
    .prepare("SELECT MAX(version) AS v, MIN(version) AS m FROM _schema_version")
    .get() as { v: number; m: number } | undefined;
  return row !== undefined && row.v === row.m ? row.v : -1;
}

function columnNames(db: Db, table: string): string[] {
  return (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
}

// A v13-shape DB: chat_messages WITHOUT dispatched_agents + _schema_version=13. openDb then drives v13->v14.
function seedV13Database(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE _schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO _schema_version(version) VALUES (13);
      CREATE TABLE runs (id TEXT PRIMARY KEY, vision TEXT NOT NULL, started_at TEXT NOT NULL);
      CREATE TABLE chat_sessions (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), repo_root TEXT NOT NULL,
        run_dir TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        default_agent TEXT NOT NULL CHECK (default_agent IN ('claude','codex','gemini')),
        last_agent TEXT CHECK (last_agent IN ('claude','codex','gemini')),
        summary_text TEXT NOT NULL DEFAULT '', summary_through_turn INTEGER NOT NULL DEFAULT 0,
        project_id TEXT, quarantined INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE chat_messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES chat_sessions(id), turn INTEGER NOT NULL,
        round INTEGER NOT NULL DEFAULT 0,
        role TEXT NOT NULL CHECK (role IN ('user','agent','system','error')), agent TEXT NOT NULL,
        text_blob_hash TEXT NOT NULL, created_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('completed','failed','cancelled')),
        token_estimate INTEGER NOT NULL, dispatch_id TEXT
      );
    `);
    db.prepare("INSERT INTO runs (id, vision, started_at) VALUES (?, ?, ?)").run("r1", "test", NOW);
  } finally {
    db.close();
  }
}

describe("evidence db v13->v14: chat_messages.dispatched_agents", () => {
  it("an OLD-shape chat_messages (no dispatched_agents) gains the column and the version bumps to 14", () => {
    const dbPath = tempDbPath();
    seedV13Database(dbPath);
    withDb(dbPath, (db) => {
      expect(columnNames(db, "chat_messages")).toContain("dispatched_agents");
      expect(schemaVersion(db)).toBe(14);
    });
  });

  it("a FRESH DB already carries dispatched_agents at version 14 (schema.sql canonical)", () => {
    withDb(tempDbPath(), (db) => {
      expect(columnNames(db, "chat_messages")).toContain("dispatched_agents");
      expect(schemaVersion(db)).toBe(14);
    });
  });
});
