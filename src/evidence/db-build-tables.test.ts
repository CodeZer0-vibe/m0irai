/**
 * @file src/evidence/db-build-tables.test.ts
 * @purpose Falsifying gate + assertions for the v9->v10 BUILD-pillar migration (chat_build_runs /
 *          chat_build_assignments / chat_artifacts). Proves on a REAL on-disk SQLite DB: the 3 tables
 *          + FK indexes materialize at version 10; the FKs enforce (session RESTRICT, run/assignment
 *          CASCADE); the state + gate_status CHECK constraints reject bad values; the UNIQUE(run,agent)
 *          + UNIQUE(assignment) hold; and the SCHEMA_DRIFT gate catches a forced wrong version (the
 *          falsifying step: intentionally break the version, verify the catch, restore).
 * @exports (none)
 * @depends node:fs, node:os, node:path, vitest, ./db, ../shared/errors
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import RawDatabase from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError } from "../shared/errors.js";
import { type Db, closeDb, openDb } from "./db.js";

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

function tempDbPath(): string {
  tempRoot = mkdtempSync(join(tmpdir(), "zer0-build-tables-"));
  return join(tempRoot, "evidence.db");
}

function indexNames(db: Db, table: string): string[] {
  const rows = db.prepare(`PRAGMA index_list('${table}')`).all() as Array<{
    readonly name: string;
  }>;
  return rows.map((r) => r.name);
}

/** Opens a fresh seeded v10 DB, runs `body`, and always closes the handle (one open/close per test). */
function withSeededDb(body: (db: Db) => void): void {
  const db = openDb(tempDbPath());
  try {
    seedSessionAndRun(db);
    body(db);
  } finally {
    closeDb(db);
  }
}

function seedSessionAndRun(db: Db): void {
  db.prepare("INSERT INTO runs (id, vision, started_at) VALUES (?, ?, ?)").run(
    "run-b",
    "ship",
    "2026-06-04T00:00:00.000Z",
  );
  db.prepare(
    `INSERT INTO chat_sessions (id, run_id, repo_root, run_dir, created_at, updated_at, default_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("sess-1", "run-b", "/repo", "/repo/.council", "now", "now", "claude");
  db.prepare(
    `INSERT INTO chat_build_runs (id, session_id, turn, base_sha, dirty_fingerprint, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("brun-1", "sess-1", 3, "abc123", "fp-0", "now");
}

function insertAssignment(db: Db, id: string, agent: string, state: string): void {
  db.prepare(
    `INSERT INTO chat_build_assignments (id, run_id, agent, task, capability, worktree_path, state, created_at)
     VALUES (?, 'brun-1', ?, 'do X', 'code', '/wt', ?, 'now')`,
  ).run(id, agent, state);
}

describe("v9 to v10 BUILD-pillar migration — fresh DB", () => {
  it("creates the 3 tables + FK indexes at schema version 10", () => {
    const db = openDb(tempDbPath());
    try {
      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
          readonly name: string;
        }>
      ).map((r) => r.name);
      expect(tables).toEqual(
        expect.arrayContaining(["chat_build_runs", "chat_build_assignments", "chat_artifacts"]),
      );
      expect(indexNames(db, "chat_build_assignments")).toContain("idx_chat_build_assignments_run");
      expect(indexNames(db, "chat_build_runs")).toContain("idx_chat_build_runs_session");
      expect(indexNames(db, "chat_artifacts")).toContain("idx_chat_artifacts_assignment");
      expect(db.prepare("SELECT version FROM _schema_version").all()).toEqual([{ version: 14 }]);
    } finally {
      closeDb(db);
    }
  });
});

describe("v9 to v10 FK behavior", () => {
  it("RESTRICTs deleting a session that a build run references", () => {
    withSeededDb((db) => {
      expect(() => db.prepare("DELETE FROM chat_sessions WHERE id = ?").run("sess-1")).toThrow(
        /FOREIGN KEY/i,
      );
    });
  });

  it("CASCADEs run->assignment->artifact on run delete", () => {
    withSeededDb((db) => {
      insertAssignment(db, "asg-1", "codex", "captured");
      db.prepare(
        "INSERT INTO chat_artifacts (id, assignment_id, changed_files_json) VALUES (?, ?, ?)",
      ).run("art-1", "asg-1", "[]");
      db.prepare("DELETE FROM chat_build_runs WHERE id = ?").run("brun-1");
      expect(db.prepare("SELECT COUNT(*) AS n FROM chat_build_assignments").get()).toEqual({
        n: 0,
      });
      expect(db.prepare("SELECT COUNT(*) AS n FROM chat_artifacts").get()).toEqual({ n: 0 });
    });
  });
});

describe("v9 to v10 UNIQUE + CHECK constraints", () => {
  it("enforces UNIQUE(run_id, agent) on assignments", () => {
    withSeededDb((db) => {
      insertAssignment(db, "asg-1", "codex", "captured");
      expect(() => insertAssignment(db, "asg-2", "codex", "captured")).toThrow(/UNIQUE/i);
    });
  });

  it("rejects an out-of-domain assignment state via CHECK", () => {
    withSeededDb((db) => {
      expect(() => insertAssignment(db, "asg-bad", "codex", "merged")).toThrow(/CHECK/i);
    });
  });

  it("rejects an out-of-domain gate_status via CHECK", () => {
    withSeededDb((db) => {
      insertAssignment(db, "asg-1", "codex", "captured");
      expect(() =>
        db
          .prepare(
            `INSERT INTO chat_artifacts (id, assignment_id, changed_files_json, gate_status)
             VALUES (?, ?, ?, ?)`,
          )
          .run("art-bad", "asg-1", "[]", "exploded"),
      ).toThrow(/CHECK/i);
    });
  });
});

describe("SCHEMA_DRIFT gate (falsifying: break the version, verify catch, restore)", () => {
  it("throws SCHEMA_DRIFT when the on-disk version is forced off 10, and reopens cleanly when restored", () => {
    const dbPath = tempDbPath();
    // Establish a clean v10 DB.
    const seeded = openDb(dbPath);
    closeDb(seeded);

    // FALSIFY: force the on-disk version to a wrong value via a RAW handle (NOT openDb, whose own
    // migration would re-touch _schema_version). One openDb below must reject this exact state.
    const broken = new RawDatabase(dbPath);
    broken.prepare("UPDATE _schema_version SET version = ?").run(99);
    broken.close();
    let caught: unknown;
    try {
      closeDb(openDb(dbPath));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as Error).message).toContain("SCHEMA_DRIFT");

    // RESTORE: reset the version to a valid prior value via a raw handle — the next openDb re-runs the
    // (idempotent) migration to the head version, proving the gate keyed on the version itself, not an
    // unrelated fault. (A failed open above may have left a re-inserted head version alongside 99.)
    const fix = new RawDatabase(dbPath);
    fix.prepare("DELETE FROM _schema_version").run();
    fix.prepare("INSERT INTO _schema_version(version) VALUES (10)").run();
    fix.close();
    const reopened = openDb(dbPath);
    try {
      expect(reopened.prepare("SELECT version FROM _schema_version").all()).toEqual([
        { version: 14 },
      ]);
    } finally {
      closeDb(reopened);
    }
  });
});
