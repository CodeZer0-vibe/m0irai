// migrations-v15: the v14→v15 journal DDL constant applied to a REAL in-memory sqlite, in isolation — asserts
// the two tables + their key constraints (author CHECK, UNIQUE(project,seq), the watermark PK), the five
// indexes, the J5 no-delete trigger, and the version bump to 15. Minimal prerequisites (_schema_version at 14
// + projects) so the constant's OWN DDL is exercised, not the whole open chain. Top-level it() (50-line clamp).
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { MIGRATION_V14_TO_V15 } from "./migrations-v15.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("CREATE TABLE _schema_version (version INTEGER PRIMARY KEY);");
  db.exec("INSERT INTO _schema_version(version) VALUES (14);");
  db.exec(
    "CREATE TABLE projects (project_id TEXT PRIMARY KEY, canonical_root TEXT, git_common_dir TEXT, created_at TEXT);",
  );
  // better-sqlite3 enforces foreign_keys by default → seed the parent row the journal/watermark FKs require.
  db.prepare(
    "INSERT INTO projects (project_id, canonical_root, git_common_dir, created_at) VALUES ('p1', '/r', '/r/.git', 't')",
  ).run();
  db.exec(MIGRATION_V14_TO_V15);
});

afterEach(() => {
  db.close();
});

function columns(table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function insertEntry(entryId: string, seq: number, author = "ledger"): void {
  db.prepare(
    "INSERT INTO journal_entries (entry_id, project_id, category, author, body, seq, created_at) VALUES (?, 'p1', 'decision', ?, 'b', ?, 't')",
  ).run(entryId, author, seq);
}

it("creates journal_entries with the §5 columns (author enum, supersession link, seq, anchor)", () => {
  const cols = columns("journal_entries");
  for (const c of [
    "entry_id",
    "project_id",
    "category",
    "author",
    "agent",
    "body",
    "topic_key",
    "touched_files",
    "domain_tags",
    "anchor",
    "superseded_by",
    "seq",
    "created_at",
  ]) {
    expect(cols.has(c)).toBe(true);
  }
});

it("journal_entries enforces UNIQUE(project_id, seq)", () => {
  insertEntry("e1", 1);
  expect(() => insertEntry("e2", 1)).toThrow(/UNIQUE/i);
});

it("journal_entries author CHECK rejects a value outside ('agent','operator','ledger')", () => {
  expect(() => insertEntry("e3", 2, "robot")).toThrow(/CHECK/i);
});

it("digest_watermark exists and is keyed by (project_id, session_id, message_id)", () => {
  const cols = columns("digest_watermark");
  for (const c of ["project_id", "session_id", "message_id", "created_at"]) {
    expect(cols.has(c)).toBe(true);
  }
  db.prepare("INSERT INTO digest_watermark VALUES ('p1','chat-1','m1','t')").run();
  expect(() =>
    db.prepare("INSERT INTO digest_watermark VALUES ('p1','chat-1','m1','t')").run(),
  ).toThrow(/UNIQUE|PRIMARY KEY/i);
});

it("the no-delete trigger ABORTS a DELETE on journal_entries (J5 retire-not-delete)", () => {
  insertEntry("e4", 3);
  expect(() => db.prepare("DELETE FROM journal_entries WHERE entry_id = 'e4'").run()).toThrow(
    /retire via superseded_by/i,
  );
});

it("registers the journal + watermark indexes and bumps the version set to {14,15}", () => {
  const indexes = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]
    ).map((r) => r.name),
  );
  for (const idx of [
    "idx_journal_entries_project",
    "idx_journal_entries_category",
    "idx_journal_entries_anchor",
    "idx_journal_entries_topic",
    "idx_digest_watermark_session",
  ]) {
    expect(indexes.has(idx)).toBe(true);
  }
  const versions = (
    db.prepare("SELECT version FROM _schema_version ORDER BY version").all() as {
      version: number;
    }[]
  ).map((r) => r.version);
  expect(versions).toEqual([14, 15]);
});
