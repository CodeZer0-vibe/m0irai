/**
 * @file src/evidence/migrations-v16.test.ts
 * @purpose T1 contract for the LAZY v16 lane-state migration + the carrier-scoped opener. REAL sqlite on
 *   temp paths, no mocks: version-set model {14,15,16,20}, four lane tables + WITHOUT ROWID ledger,
 *   partial indexes, constraint enforcement, idempotent reopen, memory-open laziness (no v16 without the
 *   lane opener), global/memory accept-set compatibility, old-DB upgrade, and the lane-handle pragmas
 *   (synchronous=NORMAL, temp_store=MEMORY, cache_size=-20000 — the DB-consult fold).
 * @exports (none — test file)
 * @depends vitest, node:fs, node:os, node:path, ./db
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { type Db, closeDb, openDb, openLaneStateDb, openMemoryDb } from "./db.js";

let tempRoot: string | undefined;
const handles: Db[] = [];

function tempDbPath(): string {
  tempRoot = mkdtempSync(path.join(tmpdir(), "v16-"));
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

function tableSql(db: Db, name: string): string {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name) as
    | { sql: string }
    | undefined;
  return row?.sql ?? "";
}

function indexNames(db: Db): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function insertProject(db: Db, projectId: string): void {
  db.prepare(
    "INSERT INTO projects(project_id, canonical_root, git_common_dir, created_at) VALUES (?,?,?,?)",
  ).run(projectId, "C:/tmp/p", "C:/tmp/p/.git", "2026-07-09T00:00:00Z");
}

it("openLaneStateDb lands a fresh DB at {14,15,16,20} with scoped lane tables", () => {
  const dbPath = tempDbPath();
  const db = track(openLaneStateDb(dbPath));
  expect(versionSet(db)).toBe("14,15,16,20,21"); // M4: the memory segment rides every lane open
  for (const table of ["lane_sessions", "lane_cursors", "lane_prompt_attempts", "ledger_seq"]) {
    expect(tableSql(db, table)).not.toBe("");
  }
  closeDb(db);
  const reopened = track(openLaneStateDb(dbPath));
  expect(versionSet(reopened)).toBe("14,15,16,20,21"); // M4: steady state keeps the projected set
});

it("ledger_seq is WITHOUT ROWID with both uniqueness constraints enforced", () => {
  const db = track(openLaneStateDb(tempDbPath()));
  expect(tableSql(db, "ledger_seq").toUpperCase()).toContain("WITHOUT ROWID");
  insertProject(db, "p1");
  const insert = db.prepare("INSERT INTO ledger_seq(project_id, seq, message_id) VALUES (?,?,?)");
  insert.run("p1", 1, "m1");
  expect(() => insert.run("p1", 1, "m2")).toThrow(); // PK(project_id, seq)
  expect(() => insert.run("p1", 2, "m1")).toThrow(); // UNIQUE(project_id, message_id)
  insert.run("p1", 2, "m2");
});

it("lane_prompt_attempts allows NULL (unresolved) and pins the closed outcome enum", () => {
  const db = track(openLaneStateDb(tempDbPath()));
  insertProject(db, "p1");
  const insert = db.prepare(
    "INSERT INTO lane_prompt_attempts(attempt_id, project_id, agent, generation, session_id, seq_from, seq_to, sent_at, resolved) VALUES (?,?,?,?,?,?,?,?,?)",
  );
  insert.run("a1", "p1", "claude", 1, "s1", 1, 3, "2026-07-09T00:00:01Z", null);
  insert.run("a2", "p1", "claude", 1, "s1", 4, 5, "2026-07-09T00:00:02Z", "accepted");
  insert.run("a3", "p1", "claude", 2, "s2", 6, 6, "2026-07-09T00:00:03Z", "abandoned");
  expect(() =>
    insert.run("a4", "p1", "claude", 2, "s2", 7, 7, "2026-07-09T00:00:04Z", "maybe"),
  ).toThrow();
});

it("creates the day-one partial indexes (attempts unresolved/resolved + journal ACTIVE partials)", () => {
  const db = track(openLaneStateDb(tempDbPath()));
  const names = indexNames(db);
  for (const expected of [
    "idx_lane_prompt_attempts_unresolved",
    "idx_lane_prompt_attempts_resolved",
    "idx_journal_entries_active_seq",
    "idx_journal_entries_active_anchor_seq",
    "idx_journal_entries_active_agent_seq",
  ]) {
    expect(names).toContain(expected);
  }
});

it("openMemoryDb alone NEVER creates v16 (lazy: the lane opener is the only v16 path)", () => {
  const dbPath = tempDbPath();
  const db = track(openMemoryDb(dbPath));
  expect(versionSet(db)).toBe("14,15,21"); // M4: memory opens land v21 — and still never v16
  expect(tableSql(db, "lane_sessions")).toBe("");
});

it("openDb and openMemoryDb accept a lane-migrated {14,15,16,20} DB", () => {
  const dbPath = tempDbPath();
  closeDb(track(openLaneStateDb(dbPath)));
  const viaGlobal = track(openDb(dbPath));
  expect(versionSet(viaGlobal)).toBe("14,15,16,20,21"); // M4: global tolerates the projected set untouched
  closeDb(viaGlobal);
  const viaMemory = track(openMemoryDb(dbPath));
  expect(versionSet(viaMemory)).toBe("14,15,16,20,21"); // M4: memory open is steady on the projected set
});

it("upgrades an old pre-memory DB through the scoped lane schema", () => {
  const dbPath = tempDbPath();
  const old = track(openDb(dbPath));
  expect(versionSet(old)).toBe("14");
  closeDb(old);
  const lane = track(openLaneStateDb(dbPath));
  expect(versionSet(lane)).toBe("14,15,16,20,21"); // M4: lane lands include the projection version
});

it("the lane handle carries the consult pragmas: synchronous=NORMAL, temp_store=MEMORY, cache_size=-20000", () => {
  const db = track(openLaneStateDb(tempDbPath()));
  expect(Number(db.pragma("synchronous", { simple: true }))).toBe(1);
  expect(Number(db.pragma("temp_store", { simple: true }))).toBe(2);
  expect(Number(db.pragma("cache_size", { simple: true }))).toBe(-20000);
});

it("the global and memory handles keep their existing pragma profile (no cross-contamination)", () => {
  const dbPath = tempDbPath();
  const db = track(openDb(dbPath));
  // the global default synchronous under WAL in better-sqlite3 is FULL(2) unless set — the lane opener
  // must not change OTHER handles' behavior; this asserts the global handle is NOT the lane profile.
  expect(Number(db.pragma("cache_size", { simple: true }))).not.toBe(-20000);
});
