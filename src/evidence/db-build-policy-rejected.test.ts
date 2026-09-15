/**
 * @file src/evidence/db-build-policy-rejected.test.ts
 * @purpose Falsifying gate + assertions for the v10->v11 migration (gemini research/design lane,
 *          Task 2): the chat_build_assignments.state CHECK gains `policy-rejected`; the capability
 *          column gains a CHECK domain `('code','md')`; chat_artifacts gains nullable export_path /
 *          content_hash / policy_violation columns. Proves on a REAL on-disk SQLite DB (no mock): a
 *          fresh DB initializes at version 11 with the new domains; an EXISTING (v11-shaped, pre-this-
 *          change-data) DB upgrades WITHOUT data loss; a `policy-rejected` assignment + a `md`
 *          capability round-trip; an out-of-union state AND an out-of-union capability are REJECTED by
 *          the DB CHECK (the falsifying proof that the closed union is enforced at persistence).
 * @exports (none)
 * @depends node:fs, node:os, node:path, better-sqlite3, vitest, ./db
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import RawDatabase from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { type Db, closeDb, openDb } from "./db.js";

const EXPECTED_VERSION = 14;
let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

function tempDbPath(): string {
  tempRoot = mkdtempSync(join(tmpdir(), "zer0-policy-rejected-"));
  return join(tempRoot, "evidence.db");
}

function seedSessionAndRun(db: Db): void {
  db.prepare("INSERT INTO runs (id, vision, started_at) VALUES (?, ?, ?)").run(
    "run-p",
    "ship",
    "2026-06-05T00:00:00.000Z",
  );
  db.prepare(
    `INSERT INTO chat_sessions (id, run_id, repo_root, run_dir, created_at, updated_at, default_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("sess-p", "run-p", "/repo", "/repo/.council", "now", "now", "claude");
  db.prepare(
    `INSERT INTO chat_build_runs (id, session_id, turn, base_sha, dirty_fingerprint, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("brun-p", "sess-p", 1, "abc", "fp", "now");
}

function insertAssignment(
  db: Db,
  over: { id: string; agent?: string; state?: string; capability?: string },
): void {
  db.prepare(
    `INSERT INTO chat_build_assignments (id, run_id, agent, task, capability, worktree_path, state, created_at)
     VALUES (?, 'brun-p', ?, 'research X', ?, '/wt', ?, 'now')`,
  ).run(over.id, over.agent ?? "gemini", over.capability ?? "md", over.state ?? "policy-rejected");
}

describe("v10 to v11 migration — fresh DB", () => {
  it("initializes a fresh DB at the current head schema version", () => {
    const db = openDb(tempDbPath());
    try {
      expect(db.prepare("SELECT version FROM _schema_version").all()).toEqual([
        { version: EXPECTED_VERSION },
      ]);
    } finally {
      closeDb(db);
    }
  });

  it("round-trips a policy-rejected assignment with capability:md through the real DB", () => {
    const db = openDb(tempDbPath());
    try {
      seedSessionAndRun(db);
      insertAssignment(db, { id: "asg-pr", state: "policy-rejected", capability: "md" });
      const row = db
        .prepare("SELECT state, capability FROM chat_build_assignments WHERE id = ?")
        .get("asg-pr");
      expect(row).toEqual({ state: "policy-rejected", capability: "md" });
    } finally {
      closeDb(db);
    }
  });

  it("persists the artifact export_path / content_hash / policy_violation columns", () => {
    const db = openDb(tempDbPath());
    try {
      seedSessionAndRun(db);
      insertAssignment(db, { id: "asg-art", state: "policy-rejected", capability: "md" });
      db.prepare(
        `INSERT INTO chat_artifacts (id, assignment_id, changed_files_json, export_path, content_hash, policy_violation)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("art-pr", "asg-art", "[]", ".zer0/runs/r/research/l.md", "sha-1", "added .ts entry");
      const row = db
        .prepare(
          "SELECT export_path, content_hash, policy_violation FROM chat_artifacts WHERE id = ?",
        )
        .get("art-pr");
      expect(row).toEqual({
        export_path: ".zer0/runs/r/research/l.md",
        content_hash: "sha-1",
        policy_violation: "added .ts entry",
      });
    } finally {
      closeDb(db);
    }
  });
});

describe("v10 to v11 CHECK enforcement (falsifying — out-of-union rejected at persistence)", () => {
  it("REJECTS an out-of-union assignment state via the DB CHECK", () => {
    const db = openDb(tempDbPath());
    try {
      seedSessionAndRun(db);
      expect(() => insertAssignment(db, { id: "asg-bad", state: "policy_rejected" })).toThrow(
        /CHECK/i,
      );
    } finally {
      closeDb(db);
    }
  });

  it("REJECTS an out-of-union capability via the DB CHECK", () => {
    const db = openDb(tempDbPath());
    try {
      seedSessionAndRun(db);
      expect(() =>
        insertAssignment(db, { id: "asg-cap", state: "captured", capability: "binary" }),
      ).toThrow(/CHECK/i);
    } finally {
      closeDb(db);
    }
  });

  it("still ACCEPTS the legacy capability:code (no regression)", () => {
    const db = openDb(tempDbPath());
    try {
      seedSessionAndRun(db);
      insertAssignment(db, {
        id: "asg-code",
        state: "captured",
        capability: "code",
        agent: "codex",
      });
      expect(
        db.prepare("SELECT capability FROM chat_build_assignments WHERE id = ?").get("asg-code"),
      ).toEqual({ capability: "code" });
    } finally {
      closeDb(db);
    }
  });
});

/**
 * Rebuilds chat_build_assignments back to the OLD (pre-v11) CHECK domain — no `policy-rejected`, no
 * `capability` CHECK — and strips the new artifact columns, on a raw handle. This downgrades a
 * real openDb-built DB to the EXACT shape a pre-this-change v10 DB had, so the reopen exercises the
 * genuine v11 migration over real data (the same raw-handle technique db-build-tables.test.ts uses).
 */
function downgradeToOldV10(dbPath: string): void {
  const raw = new RawDatabase(dbPath);
  raw.pragma("foreign_keys = OFF");
  raw.exec(`
    DROP TABLE chat_artifacts;
    ALTER TABLE chat_build_assignments RENAME TO _old_asg;
    CREATE TABLE chat_build_assignments (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES chat_build_runs(id) ON DELETE CASCADE,
      agent TEXT NOT NULL, task TEXT NOT NULL, capability TEXT NOT NULL, worktree_path TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','running','captured','accepted','rejected',
        'failed','failed_acknowledged','empty','escaped')),
      created_at TEXT NOT NULL, UNIQUE(run_id, agent));
    INSERT INTO chat_build_assignments SELECT id, run_id, agent, task, capability, worktree_path, state, created_at FROM _old_asg;
    DROP TABLE _old_asg;
    CREATE TABLE chat_artifacts (
      id TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL UNIQUE REFERENCES chat_build_assignments(id) ON DELETE CASCADE,
      patch_blob_hash TEXT, changed_files_json TEXT NOT NULL, stdout_blob_hash TEXT, stderr_blob_hash TEXT,
      mergeable INTEGER NOT NULL DEFAULT 0, on_task TEXT NOT NULL DEFAULT 'unverified',
      gate_status TEXT NOT NULL DEFAULT 'not_run' CHECK (gate_status IN ('not_run','passed','failed','skipped')));
    INSERT INTO chat_build_runs (id, session_id, turn, base_sha, dirty_fingerprint, created_at)
      VALUES ('brun-old', 'sess-p', 2, 'sha', 'fp', 'now');
    INSERT INTO chat_build_assignments (id, run_id, agent, task, capability, worktree_path, state, created_at)
      VALUES ('asg-old', 'brun-old', 'codex', 'old task', 'code', '/wt/old', 'captured', 'now');
    INSERT INTO chat_artifacts (id, assignment_id, changed_files_json) VALUES ('art-old', 'asg-old', '["src/x.ts"]');
    DELETE FROM _schema_version;
    INSERT INTO _schema_version(version) VALUES (10);
  `);
  raw.close();
}

describe("v10 to v11 migration — EXISTING DB upgrade (no data loss)", () => {
  it("upgrades a pre-change v10 DB carrying data to v11, preserving rows + enforcing new CHECKs", () => {
    const dbPath = tempDbPath();
    // Establish a real, fully-migrated DB, seed its session/run, then DOWNGRADE the build tables to
    // the genuine pre-v11 v10 shape (old CHECK, no new artifact cols, version=10) via a raw handle.
    const seeded = openDb(dbPath);
    seedSessionAndRun(seeded);
    closeDb(seeded);
    downgradeToOldV10(dbPath);

    const db = openDb(dbPath);
    try {
      // Version advanced through the v10->v11 rebuild to the current head.
      expect(db.prepare("SELECT version FROM _schema_version").all()).toEqual([
        { version: EXPECTED_VERSION },
      ]);
      // Pre-existing rows survived the table rebuild (no data loss).
      expect(
        db
          .prepare("SELECT agent, capability, state FROM chat_build_assignments WHERE id = ?")
          .get("asg-old"),
      ).toEqual({ agent: "codex", capability: "code", state: "captured" });
      expect(
        db.prepare("SELECT changed_files_json FROM chat_artifacts WHERE id = ?").get("art-old"),
      ).toEqual({ changed_files_json: '["src/x.ts"]' });
      // The FK chain still enforces after the rebuild (CASCADE on run delete).
      db.prepare("DELETE FROM chat_build_runs WHERE id = ?").run("brun-old");
      expect(db.prepare("SELECT COUNT(*) AS n FROM chat_build_assignments").get()).toEqual({
        n: 0,
      });
      expect(db.prepare("SELECT COUNT(*) AS n FROM chat_artifacts").get()).toEqual({ n: 0 });
      // The NEW domains are now enforced on the rebuilt table (brun-p was seeded pre-downgrade).
      insertAssignment(db, { id: "asg-new", state: "policy-rejected", capability: "md" });
      expect(
        db
          .prepare("SELECT state, capability FROM chat_build_assignments WHERE id = ?")
          .get("asg-new"),
      ).toEqual({ state: "policy-rejected", capability: "md" });
      expect(() => insertAssignment(db, { id: "asg-x", capability: "binary" })).toThrow(/CHECK/i);
    } finally {
      closeDb(db);
    }
  });
});

/**
 * Builds a real v10 DB, downgrades chat_build_assignments to the OLD shape (no policy-rejected / no
 * capability CHECK, version=10), and installs a TRIGGER that aborts the moment version 11 is inserted
 * into `_schema_version`. FAULT-INJECTION construct: the trigger fires at the v11 VERSION-BUMP — the
 * LAST step of the v10->v11 migration, AFTER the assignments rebuild has run. This is the exact seam
 * BLOCK-1 targets: under a two-transaction migration the rebuild commits FIRST, so the version-bump
 * abort strands a v11-shaped table at version 10; under a ONE-transaction migration the abort rolls the
 * rebuild back too. (The trigger is a mechanical stage-two fault, not a real on-disk state.) The
 * pre-existing assignment row drives the no-data-loss assertion. Returns the dbPath.
 */
function makeOldV10WithV11BumpTrigger(): string {
  const dbPath = tempDbPath();
  const seeded = openDb(dbPath);
  seedSessionAndRun(seeded);
  closeDb(seeded);
  const raw = new RawDatabase(dbPath);
  raw.pragma("foreign_keys = OFF");
  raw.exec(`
    ALTER TABLE chat_build_assignments RENAME TO _old_asg;
    CREATE TABLE chat_build_assignments (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES chat_build_runs(id) ON DELETE CASCADE,
      agent TEXT NOT NULL, task TEXT NOT NULL, capability TEXT NOT NULL, worktree_path TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','running','captured','accepted','rejected',
        'failed','failed_acknowledged','empty','escaped')),
      created_at TEXT NOT NULL, UNIQUE(run_id, agent));
    INSERT INTO chat_build_assignments SELECT id, run_id, agent, task, capability, worktree_path, state, created_at FROM _old_asg;
    DROP TABLE _old_asg;
    ALTER TABLE chat_artifacts DROP COLUMN export_path;
    ALTER TABLE chat_artifacts DROP COLUMN content_hash;
    ALTER TABLE chat_artifacts DROP COLUMN policy_violation;
    INSERT INTO chat_build_runs (id, session_id, turn, base_sha, dirty_fingerprint, created_at)
      VALUES ('brun-old', 'sess-p', 2, 'sha', 'fp', 'now');
    INSERT INTO chat_build_assignments (id, run_id, agent, task, capability, worktree_path, state, created_at)
      VALUES ('asg-old', 'brun-old', 'codex', 'old task', 'code', '/wt/old', 'captured', 'now');
    DELETE FROM _schema_version;
    INSERT INTO _schema_version(version) VALUES (10);
    CREATE TRIGGER _block_v11_bump BEFORE INSERT ON _schema_version
      WHEN NEW.version = 11 BEGIN SELECT RAISE(ABORT, 'injected v11 version-bump fault'); END;
  `);
  raw.close();
  return dbPath;
}

describe("v10 to v11 migration — ATOMICITY (BLOCK-1: all-or-nothing, no hybrid state)", () => {
  it("rolls the rebuild BACK when the v11 version-bump fails — never a v11-shaped table at v10", () => {
    // The trigger aborts the version bump (the LAST step), AFTER the assignments rebuild has run. A
    // two-transaction migration would have committed the rebuild already, stranding a v11-shaped table
    // at version 10. The fix makes the whole step atomic: on the abort, the rebuild rolls back too —
    // leaving the ORIGINAL old shape at version 10 (a recoverable state openDb can re-migrate).
    const dbPath = makeOldV10WithV11BumpTrigger();

    let opened: Db | undefined;
    expect(() => {
      opened = openDb(dbPath);
    }).toThrow();
    if (opened !== undefined) closeDb(opened); // hygiene: never leak a handle if it somehow opened.

    // Inspect the on-disk state with a RAW handle (openDb would re-attempt the migration).
    const raw = new RawDatabase(dbPath);
    try {
      // Version was NOT bumped to 11 (the bump shares the rebuild's transaction → both rolled back).
      const versions = (
        raw.prepare("SELECT version FROM _schema_version").all() as Array<{ version: number }>
      ).map((r) => r.version);
      expect(versions).not.toContain(11);
      // The assignments table kept its ORIGINAL old shape — the rebuild rolled back atomically (NOT a
      // v11-shaped table with the new CHECK domains stranded below version 11).
      const tableSql = (
        raw
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='chat_build_assignments'",
          )
          .get() as { sql: string }
      ).sql;
      expect(tableSql).not.toContain("policy-rejected");
      expect(tableSql).not.toContain("'code','md'");
      // The pre-existing row survived (no data loss on the rollback).
      expect(
        raw.prepare("SELECT capability FROM chat_build_assignments WHERE id = ?").get("asg-old"),
      ).toEqual({ capability: "code" });
      // The temp rebuild table must NOT linger (the rollback discarded it).
      expect(
        raw
          .prepare("SELECT name FROM sqlite_master WHERE name = '_chat_build_assignments_v10'")
          .get(),
      ).toBeUndefined();
    } finally {
      raw.close();
    }
  });
});

/**
 * Builds a real v10 DB then downgrades chat_build_assignments to a MALFORMED HYBRID: the state CHECK
 * already carries `policy-rejected`, but the capability column has NO `('code','md')` CHECK. The weak
 * (state-only) idempotency probe would WRONGLY bless this and skip the rebuild; the strengthened probe
 * (DECISION-3) must require BOTH domains and therefore STILL rebuild. Returns the dbPath.
 */
function makeHybridV10(): string {
  const dbPath = tempDbPath();
  const seeded = openDb(dbPath);
  seedSessionAndRun(seeded);
  closeDb(seeded);
  const raw = new RawDatabase(dbPath);
  raw.pragma("foreign_keys = OFF");
  raw.exec(`
    ALTER TABLE chat_build_assignments RENAME TO _hyb_asg;
    CREATE TABLE chat_build_assignments (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES chat_build_runs(id) ON DELETE CASCADE,
      agent TEXT NOT NULL, task TEXT NOT NULL, capability TEXT NOT NULL, worktree_path TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','running','captured','accepted','rejected',
        'failed','failed_acknowledged','empty','escaped','policy-rejected')),
      created_at TEXT NOT NULL, UNIQUE(run_id, agent));
    INSERT INTO chat_build_assignments SELECT id, run_id, agent, task, capability, worktree_path, state, created_at FROM _hyb_asg;
    DROP TABLE _hyb_asg;
    DELETE FROM _schema_version;
    INSERT INTO _schema_version(version) VALUES (10);
  `);
  raw.close();
  return dbPath;
}

describe("v10 to v11 migration — idempotency probe (DECISION-3: require BOTH domains to skip)", () => {
  it("REBUILDS a hybrid v10 (policy-rejected present, capability CHECK absent) instead of blessing it", () => {
    const dbPath = makeHybridV10();

    const db = openDb(dbPath);
    try {
      expect(db.prepare("SELECT version FROM _schema_version").all()).toEqual([
        { version: EXPECTED_VERSION },
      ]);
      // The capability CHECK is now present (the rebuild ran despite policy-rejected being present),
      // so an out-of-union capability is rejected at persistence — proving the hybrid was healed.
      expect(() => insertAssignment(db, { id: "asg-h", capability: "binary" })).toThrow(/CHECK/i);
      // And a valid md capability still round-trips.
      insertAssignment(db, { id: "asg-ok", state: "policy-rejected", capability: "md" });
      expect(
        db.prepare("SELECT capability FROM chat_build_assignments WHERE id = ?").get("asg-ok"),
      ).toEqual({ capability: "md" });
    } finally {
      closeDb(db);
    }
  });

  it("does NOT rebuild a correct fresh v11 DB (probe skips when both domains are present)", () => {
    // A fresh openDb builds the canonical v11 shape; reopening must be a clean no-op (no spurious
    // rebuild, version stays 11, data intact) — the probe correctly recognizes both domains present.
    const dbPath = tempDbPath();
    const first = openDb(dbPath);
    seedSessionAndRun(first);
    insertAssignment(first, { id: "asg-keep", state: "policy-rejected", capability: "md" });
    closeDb(first);

    const second = openDb(dbPath);
    try {
      expect(second.prepare("SELECT version FROM _schema_version").all()).toEqual([
        { version: EXPECTED_VERSION },
      ]);
      expect(
        second
          .prepare("SELECT capability FROM chat_build_assignments WHERE id = ?")
          .get("asg-keep"),
      ).toEqual({ capability: "md" });
    } finally {
      closeDb(second);
    }
  });
});
