// v15 lazy memory migration matrix: memory-OFF (global openDb) leaves a fresh DB at {14} with zero v15
// tables (AC5 — the migration does NOT run on the global path); the FIRST memory-ON open (openMemoryDb)
// migrates to {14,15} exactly once, is idempotent on reopen, and the global open accepts an already-
// migrated {14,15} DB without drift. Modeled on db.v14.test.ts. Real sqlite, no mocks. Top-level it() (no
// describe wrapper) so no single callback trips the 50-line function clamp. The AC5 byte-identity golden
// lives in src/memory/baseline-fixture.test.ts (it needs the memory fixture — evidence must not import it).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type Db, closeDb, openDb, openMemoryDb } from "./db.js";

const TEMP_PREFIX = "zer0-v15-db-";
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

function schemaVersions(db: Db): number[] {
  return (
    db.prepare("SELECT version FROM _schema_version ORDER BY version").all() as {
      version: number;
    }[]
  ).map((r) => r.version);
}

function tableExists(db: Db, name: string): boolean {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name) !==
    undefined
  );
}

// Seeds a project + inserts one §5-shaped journal entry, proving the migrated tables accept the shape.
function insertJournalEntry(db: Db): void {
  db.prepare(
    "INSERT INTO projects (project_id, canonical_root, git_common_dir, created_at) VALUES (?, ?, ?, ?)",
  ).run("proj-1", "/repo", "/repo/.git", NOW);
  db.prepare(
    "INSERT INTO journal_entries (entry_id, project_id, category, author, agent, body, topic_key, touched_files, domain_tags, anchor, superseded_by, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "e1",
    "proj-1",
    "decision",
    "operator",
    null,
    "use WAL",
    "storage",
    '["src/db.ts"]',
    "[]",
    1,
    null,
    1,
    NOW,
  );
  db.prepare(
    "INSERT INTO digest_watermark (project_id, session_id, message_id, created_at) VALUES (?, ?, ?, ?)",
  ).run("proj-1", "chat-1", "m1", NOW);
}

it("memory OFF (global openDb) on a fresh DB lands at {14} with zero v15 tables", () => {
  const db = openDb(tempDbPath());
  try {
    expect(schemaVersions(db)).toEqual([14]);
    expect(tableExists(db, "journal_entries")).toBe(false);
    expect(tableExists(db, "digest_watermark")).toBe(false);
  } finally {
    closeDb(db);
  }
});

it("memory ON (openMemoryDb) migrates a fresh DB to {14,15} with the journal + watermark tables", () => {
  const db = openMemoryDb(tempDbPath());
  try {
    // M4: the memory segment now also lands v21 (journal_entry_files) — produced set is {14,15,21}.
    expect(schemaVersions(db)).toEqual([14, 15, 21]);
    expect(tableExists(db, "journal_entries")).toBe(true);
    expect(tableExists(db, "digest_watermark")).toBe(true);
    expect(() => insertJournalEntry(db)).not.toThrow();
  } finally {
    closeDb(db);
  }
});

it("the v15 migration is idempotent: reopening memory-ON stays {14,15} and keeps the row", () => {
  const dbPath = tempDbPath();
  const first = openMemoryDb(dbPath);
  insertJournalEntry(first);
  closeDb(first);
  const second = openMemoryDb(dbPath);
  try {
    expect(schemaVersions(second)).toEqual([14, 15, 21]); // M4: produced set includes v21
    const count = second.prepare("SELECT COUNT(*) AS c FROM journal_entries").get() as {
      c: number;
    };
    expect(count.c).toBe(1);
  } finally {
    closeDb(second);
  }
});

it("a v14 DB migrated to v15 reopens via the GLOBAL openDb without drift (accepts {14,15})", () => {
  const dbPath = tempDbPath();
  closeDb(openMemoryDb(dbPath)); // now {14,15,21} on disk (M4: builder lands v21)
  const db = openDb(dbPath); // memory OFF next session — must accept, not migrate away
  try {
    expect(schemaVersions(db)).toEqual([14, 15, 21]); // M4: accepted as-is, never migrated away
    expect(tableExists(db, "journal_entries")).toBe(true);
  } finally {
    closeDb(db);
  }
});
