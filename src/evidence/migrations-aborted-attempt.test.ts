/**
 * @file src/evidence/migrations-aborted-attempt.test.ts
 * @purpose FL-150 ROUND 2 (review P2-A) — prove the additive `lane_prompt_attempts.aborted_at` column
 *   lands on an EXISTING lane-state DB, not merely on a fresh one, and that reopening does not try to
 *   add it twice. The operator's machine is the existing case: their evidence DB is already at v20 with
 *   real rows in it, and a migration that only works on a fresh install is a migration that never runs
 *   for the one person it was written for.
 * @exports (test suite — no runtime exports)
 * @depends node:fs, node:os, node:path, vitest, ./db
 *
 * The REAL `openLaneStateDb`, which walks the real chain — nothing here re-implements the migration.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { type Db, closeDb, openLaneStateDb } from "./db.js";

let root: string | undefined;
const handles: Db[] = [];

afterEach(() => {
  for (const db of handles.splice(0)) closeDb(db);
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function columnNames(db: Db, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
  return rows.map(({ name }) => name);
}

function openAt(dbPath: string): Db {
  const db = openLaneStateDb(dbPath);
  handles.push(db);
  return db;
}

it("adds aborted_at to a lane-state DB that already has attempt rows, and keeps them", () => {
  root = mkdtempSync(path.join(tmpdir(), "fl150-aborted-col-"));
  const dbPath = path.join(root, "evidence.db");

  // A DB that already exists and already carries an attempt — the operator's machine, not a fresh box.
  const first = openAt(dbPath);
  first
    .prepare(
      "INSERT INTO projects(project_id, canonical_root, git_common_dir, created_at) VALUES (?,?,?,?)",
    )
    .run("p1", "C:/repo", "C:/repo/.git", "2026-08-22T00:00:00Z");
  first
    .prepare(
      `INSERT INTO lane_prompt_attempts
         (attempt_id, project_id, lane_scope_id, agent, generation, session_id, seq_from, seq_to,
          sent_at, resolved)
       VALUES ('a-existing', 'p1', '', 'claude', 1, 's-1', 1, 2, '2026-08-22T00:00:01Z', 'accepted')`,
    )
    .run();

  expect(columnNames(first, "lane_prompt_attempts")).toContain("aborted_at");
  expect(
    first
      .prepare("SELECT aborted_at FROM lane_prompt_attempts WHERE attempt_id = 'a-existing'")
      .get(),
    "an attempt that predates the column must read NULL, never a fabricated timestamp",
  ).toEqual({ aborted_at: null });

  // Reopening walks the chain again: the add must be a no-op rather than a duplicate-column error.
  closeDb(handles.splice(handles.indexOf(first), 1)[0] as Db);
  const second = openAt(dbPath);

  expect(columnNames(second, "lane_prompt_attempts")).toContain("aborted_at");
  expect(
    second
      .prepare("SELECT resolved FROM lane_prompt_attempts WHERE attempt_id = 'a-existing'")
      .get(),
    "the existing row lost its outcome across the migration",
  ).toEqual({ resolved: "accepted" });
});

it("does not disturb the resolved enum the recovery read depends on", () => {
  root = mkdtempSync(path.join(tmpdir(), "fl150-aborted-check-"));
  const db = openAt(path.join(root, "evidence.db"));
  db.prepare(
    "INSERT INTO projects(project_id, canonical_root, git_common_dir, created_at) VALUES (?,?,?,?)",
  ).run("p1", "C:/repo", "C:/repo/.git", "2026-08-22T00:00:00Z");

  // The CHECK is load-bearing: `resolved IS NULL` means "in flight" to the recovery read, and both
  // partial indexes are built on it. Widening it was the option NOT taken; this proves it stayed shut.
  expect(() =>
    db
      .prepare(
        `INSERT INTO lane_prompt_attempts
           (attempt_id, project_id, lane_scope_id, agent, generation, session_id, seq_from, seq_to,
            sent_at, resolved)
         VALUES ('a-bad', 'p1', '', 'claude', 1, 's-1', 1, 2, '2026-08-22T00:00:01Z', 'escaped')`,
      )
      .run(),
  ).toThrow();
});
