/**
 * @file src/evidence/migrations-v20.test.ts
 * @purpose Prove the v20 lane-scope migration preserves legacy rows without assigning them to a V2 room.
 * @exports (test suite)
 * @depends better-sqlite3, node:fs, node:os, node:path, vitest, ./db, ./migrations-v16
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { type Db, closeDb, openLaneStateDb, openMemoryDb } from "./db.js";
import { MIGRATION_V15_TO_V16 } from "./migrations-v16.js";

let root: string | undefined;
const handles: Db[] = [];

afterEach(() => {
  for (const db of handles.splice(0)) closeDb(db);
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

it("moves v16 lane state into the legacy scope and permits independent room scopes", () => {
  const dbPath = legacyV16Db();
  const db = openLaneStateDb(dbPath);
  handles.push(db);

  expect(versions(db)).toBe("14,15,16,20,21"); // M4: the lane opener runs the memory segment first, landing v21
  expect(scopeOf(db, "lane_sessions")).toEqual([""]);
  expect(scopeOf(db, "lane_cursors")).toEqual([""]);
  expect(scopeOf(db, "lane_prompt_attempts")).toEqual(["", "", ""]);
  expectLegacyRowsPreserved(db);

  const insert = db.prepare(
    `INSERT INTO lane_sessions
       (project_id, lane_scope_id, agent, session_id, generation, cwd, adapter_pkg, adapter_version,
        created_at)
     VALUES ('p1', ?, 'claude', ?, 1, 'C:/repo', 'pkg', '1', '2026-08-13T00:00:00Z')`,
  );
  insert.run("chat-a", "native-a");
  insert.run("chat-b", "native-b");
  const rows = db
    .prepare(
      `SELECT lane_scope_id AS scope, session_id AS sessionId FROM lane_sessions
       WHERE project_id = 'p1' AND agent = 'claude' ORDER BY lane_scope_id`,
    )
    .all() as Array<{ scope: string; sessionId: string }>;
  expect(rows).toEqual([
    { scope: "", sessionId: "legacy-native" },
    { scope: "chat-a", sessionId: "native-a" },
    { scope: "chat-b", sessionId: "native-b" },
  ]);
  expect(db.pragma("foreign_key_check")).toEqual([]);
});

function legacyV16Db(): string {
  root = mkdtempSync(path.join(tmpdir(), "zer0-lane-v20-"));
  const dbPath = path.join(root, "evidence.db");
  const memory = openMemoryDb(dbPath);
  memory
    .prepare(
      "INSERT INTO projects(project_id, canonical_root, git_common_dir, created_at) VALUES (?,?,?,?)",
    )
    .run("p1", "C:/repo", "C:/repo/.git", "2026-08-13T00:00:00Z");
  closeDb(memory);

  const raw = new Database(dbPath);
  raw.pragma("foreign_keys = ON");
  raw.exec(MIGRATION_V15_TO_V16);
  raw
    .prepare(
      `INSERT INTO lane_sessions
         (project_id, agent, session_id, generation, cwd, adapter_pkg, adapter_version, created_at)
       VALUES ('p1', 'claude', 'legacy-native', 3, 'C:/repo', 'pkg', '1',
               '2026-08-13T00:00:00Z')`,
    )
    .run();
  raw
    .prepare(
      `INSERT INTO lane_cursors
         (project_id, agent, generation, last_seq, needs_briefing_carry, updated_at)
       VALUES ('p1', 'claude', 3, 9, 1, '2026-08-13T00:00:00Z')`,
    )
    .run();
  seedLegacyAttempts(raw);
  raw.close();
  return dbPath;
}

function seedLegacyAttempts(db: Database.Database): void {
  const insert = db.prepare(
    `INSERT INTO lane_prompt_attempts
       (attempt_id, project_id, agent, generation, session_id, seq_from, seq_to, sent_at, resolved)
     VALUES (?, 'p1', 'claude', 3, 'legacy-native', ?, ?, ?, ?)`,
  );
  insert.run("attempt-open", 8, 9, "2026-08-13T00:00:00Z", null);
  insert.run("attempt-accepted", 4, 5, "2026-08-12T23:59:58Z", "accepted");
  insert.run("attempt-abandoned", 6, 7, "2026-08-12T23:59:59Z", "abandoned");
}

function expectLegacyRowsPreserved(db: Db): void {
  expect(db.prepare("SELECT * FROM lane_sessions WHERE lane_scope_id = ''").get()).toMatchObject({
    project_id: "p1",
    agent: "claude",
    session_id: "legacy-native",
    generation: 3,
    cwd: "C:/repo",
    adapter_pkg: "pkg",
    adapter_version: "1",
    created_at: "2026-08-13T00:00:00Z",
    last_resumed_at: null,
  });
  expect(db.prepare("SELECT * FROM lane_cursors WHERE lane_scope_id = ''").get()).toMatchObject({
    project_id: "p1",
    agent: "claude",
    generation: 3,
    last_seq: 9,
    needs_briefing_carry: 1,
    updated_at: "2026-08-13T00:00:00Z",
  });
  expectLegacyAttemptsPreserved(db);
}

function expectLegacyAttemptsPreserved(db: Db): void {
  const attempts = db
    .prepare(
      `SELECT attempt_id AS id, generation, session_id AS sessionId, seq_from AS seqFrom,
              seq_to AS seqTo, sent_at AS sentAt, resolved
       FROM lane_prompt_attempts WHERE lane_scope_id = '' ORDER BY attempt_id`,
    )
    .all();
  expect(attempts).toEqual([
    {
      id: "attempt-abandoned",
      generation: 3,
      sessionId: "legacy-native",
      seqFrom: 6,
      seqTo: 7,
      sentAt: "2026-08-12T23:59:59Z",
      resolved: "abandoned",
    },
    {
      id: "attempt-accepted",
      generation: 3,
      sessionId: "legacy-native",
      seqFrom: 4,
      seqTo: 5,
      sentAt: "2026-08-12T23:59:58Z",
      resolved: "accepted",
    },
    {
      id: "attempt-open",
      generation: 3,
      sessionId: "legacy-native",
      seqFrom: 8,
      seqTo: 9,
      sentAt: "2026-08-13T00:00:00Z",
      resolved: null,
    },
  ]);
}

function versions(db: Db): string {
  const rows = db.prepare("SELECT version FROM _schema_version ORDER BY version").all() as Array<{
    version: number;
  }>;
  return rows.map(({ version }) => version).join(",");
}

function scopeOf(db: Db, table: string): string[] {
  return (
    db.prepare(`SELECT lane_scope_id AS scope FROM ${table}`).all() as Array<{ scope: string }>
  ).map(({ scope }) => scope);
}
