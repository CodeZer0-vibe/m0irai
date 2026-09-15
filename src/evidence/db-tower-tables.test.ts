// @size-justified: v11->v12 control-tower migration suite — the 7 tower tables, their FK
// cascade/restrict topology, the proposal decision CAS, and the enum CHECK round-trips each need a
// seeded-state + post-migration assertion. Splitting per-table fragments one atomic migration's
// proof across files. Lives beside db.test.ts (which is at its line ceiling) per the repo's
// db-*.test.ts sibling convention (db-build-tables.test.ts, db-shared-brain.test.ts).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { type Db, closeDb, openDb } from "./db.js";

const TEMP_PREFIX: string = "zer0-tower-db-";
const DB_FILE: string = "evidence.db";
const NOW: string = "2026-06-05T00:00:00.000Z";
const TOWER_TABLES: readonly string[] = [
  "tower_sessions",
  "tower_agent_lanes",
  "tower_turns",
  "tower_proposals",
  "tower_decisions",
  "tower_worktrees",
  "tower_decision_sends",
];

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

describe("v11 to v12 schema migration (control tower tables)", () => {
  it("upgrades a seeded v11 DB to v12 — the 7 tower tables are created BY the migration", () => {
    const dbPath = tempDbPath();
    seedV11Database(dbPath);
    withDb(dbPath, (db) => {
      expect(tableNames(db)).toEqual(expect.arrayContaining([...TOWER_TABLES]));
      expect(schemaVersions(db)).toEqual([14]);
    });
  });

  it("creates a FRESH DB directly at version {14} with all 7 tower tables present", () => {
    withDb(tempDbPath(), (db) => {
      expect(schemaVersions(db)).toEqual([14]);
      expect(tableNames(db)).toEqual(expect.arrayContaining([...TOWER_TABLES]));
    });
  });

  it("rolls back the WHOLE migration on a mid-transaction failure — version stays {11}, zero tower tables", () => {
    const dbPath = tempDbPath();
    seedV11Database(dbPath);
    // Plant an INDEX named like the 3rd tower table. `CREATE TABLE IF NOT EXISTS tower_turns`
    // then throws ("there is already an index named tower_turns") AFTER tower_sessions +
    // tower_agent_lanes were created in the same transaction — a real, seam-free failure that
    // proves atomicity: the rollback must reap the already-created tables too.
    plantTowerNameCollision(dbPath, "tower_turns");

    expect(() => openDb(dbPath)).toThrow();

    const probe = new Database(dbPath);
    try {
      expect(probe.prepare("SELECT version FROM _schema_version ORDER BY version").all()).toEqual([
        { version: 11 },
      ]);
      expect(
        probe
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'tower_%'")
          .all(),
      ).toEqual([]);
    } finally {
      probe.close();
    }
  });
});

describe("v12 tower foreign-key cascade and restrict", () => {
  it("CASCADE deletes the lane/turn/proposal/worktree chain when its session is removed", () => {
    withDb(tempDbPath(), (db) => {
      seedTowerChain(db);
      db.prepare("DELETE FROM tower_sessions WHERE id = ?").run("tw-session");
      expect(towerCount(db, "tower_agent_lanes")).toBe(0);
      expect(towerCount(db, "tower_turns")).toBe(0);
      expect(towerCount(db, "tower_proposals")).toBe(0);
      expect(towerCount(db, "tower_worktrees")).toBe(0);
    });
  });

  it("RESTRICTs deleting a proposal that a decision pins (audit row holds it)", () => {
    withDb(tempDbPath(), (db) => {
      seedTowerChain(db);
      insertTowerDecision(db, "tw-decision", "allow");
      expect(() =>
        db.prepare("DELETE FROM tower_proposals WHERE id = ?").run("tw-proposal"),
      ).toThrow(/FOREIGN KEY/i);
    });
  });

  it("RESTRICTs deleting a chat_sessions row referenced by a tower_sessions row", () => {
    withDb(tempDbPath(), (db) => {
      seedTowerChain(db);
      expect(() =>
        db.prepare("DELETE FROM chat_sessions WHERE id = ?").run("chat-session"),
      ).toThrow(/FOREIGN KEY/i);
    });
  });
});

describe("v12 tower proposal decision CAS (one-shot)", () => {
  it("transitions pending->allow exactly once; a second identical CAS changes 0 rows", () => {
    withDb(tempDbPath(), (db) => {
      seedTowerChain(db);
      const cas = db.prepare(
        "UPDATE tower_proposals SET decision = 'allow', decided_at = ? WHERE id = ? AND decision = 'pending'",
      );
      expect(cas.run(NOW, "tw-proposal").changes).toBe(1);
      expect(cas.run(NOW, "tw-proposal").changes).toBe(0);
    });
  });
});

describe("v12 tower enum CHECK constraints", () => {
  it("accepts every legal tower_decisions.verdict and rejects an illegal one", () => {
    withDb(tempDbPath(), (db) => {
      seedTowerChain(db);
      // One decision per proposal: UNIQUE(proposal_id) (INV-5) forbids two decisions sharing a proposal,
      // so each verdict gets its own pending proposal.
      const verdicts = ["allow", "deny_continue", "deny_interrupt"];
      verdicts.forEach((verdict, i) => {
        insertProposal(db, `tw-proposal-${i}`, `corr-v-${i}`);
        expect(() =>
          insertTowerDecision(db, `tw-decision-${verdict}`, verdict, `tw-proposal-${i}`),
        ).not.toThrow();
      });
      insertProposal(db, "tw-proposal-bad", "corr-v-bad");
      expect(() => insertTowerDecision(db, "tw-decision-bad", "maybe", "tw-proposal-bad")).toThrow(
        /CHECK/i,
      );
    });
  });

  it("accepts every legal tower_decision_sends.send_state and rejects an illegal one", () => {
    withDb(tempDbPath(), (db) => {
      seedTowerChain(db);
      insertTowerDecision(db, "tw-decision", "allow");
      const insertSend = db.prepare(
        "INSERT INTO tower_decision_sends (decision_id, send_state, attempt_at) VALUES (?, ?, ?)",
      );
      const clearSends = db.prepare("DELETE FROM tower_decision_sends WHERE decision_id = ?");
      for (const sendState of ["send_started", "sent", "native_ack", "send_failed"]) {
        clearSends.run("tw-decision");
        expect(() => insertSend.run("tw-decision", sendState, NOW)).not.toThrow();
      }
      clearSends.run("tw-decision");
      expect(() => insertSend.run("tw-decision", "queued", NOW)).toThrow(/CHECK/i);
    });
  });
});

describe("v12 tower_proposals write-once immutability (INV-14)", () => {
  it("permits ONLY the CAS pending->decided; re-decide, tamper, and CAS+mutate all abort", () => {
    withDb(tempDbPath(), (db) => {
      seedTowerChain(db);
      // The legit CAS pending->allow succeeds (sole permitted update).
      const cas = db.prepare(
        "UPDATE tower_proposals SET decision = 'allow', decided_at = ? WHERE id = ? AND decision = 'pending'",
      );
      expect(cas.run(NOW, "tw-proposal").changes).toBe(1);

      // Re-deciding an already-decided proposal aborts (write-once).
      expect(() =>
        db.prepare("UPDATE tower_proposals SET decision = 'deny' WHERE id = ?").run("tw-proposal"),
      ).toThrow(/decided proposal is immutable \(INV-14\)/);

      // Tampering an immutable column on a STILL-PENDING row aborts.
      insertProposal(db, "tw-proposal-p", "corr-p");
      expect(() =>
        db
          .prepare("UPDATE tower_proposals SET raw_payload = 'tampered' WHERE id = ?")
          .run("tw-proposal-p"),
      ).toThrow(/tower_proposals.*immutable \(INV-14\)/);

      // A CAS that ALSO mutates an immutable column (kind) aborts.
      expect(() =>
        db
          .prepare(
            "UPDATE tower_proposals SET decision = 'allow', kind = 'edit', decided_at = ? WHERE id = ? AND decision = 'pending'",
          )
          .run(NOW, "tw-proposal-p"),
      ).toThrow(/tower_proposals.*immutable \(INV-14\)/);
    });
  });
});

describe("v12 tower_decisions append-only + one-per-proposal (INV-5, INV-14)", () => {
  it("rejects a second decision per proposal, and any UPDATE or DELETE of a decision row", () => {
    withDb(tempDbPath(), (db) => {
      seedTowerChain(db);
      insertTowerDecision(db, "tw-decision", "allow");

      // Second decision for the SAME proposal violates UNIQUE(proposal_id).
      expect(() => insertTowerDecision(db, "tw-decision-2", "deny_continue")).toThrow(/UNIQUE/i);

      // The decision row is append-only: no UPDATE.
      expect(() =>
        db
          .prepare("UPDATE tower_decisions SET verdict = 'deny_continue' WHERE id = ?")
          .run("tw-decision"),
      ).toThrow(/tower_decisions is append-only \(INV-14\)/);

      // And no DELETE.
      expect(() =>
        db.prepare("DELETE FROM tower_decisions WHERE id = ?").run("tw-decision"),
      ).toThrow(/tower_decisions is append-only \(INV-14\)/);
    });
  });
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

function tableNames(db: Db): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual') ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
}

function schemaVersions(db: Db): number[] {
  return db
    .prepare("SELECT version FROM _schema_version ORDER BY version")
    .all()
    .map((row) => (row as { version: number }).version);
}

function towerCount(db: Db, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

function insertTowerDecision(
  db: Db,
  id: string,
  verdict: string,
  proposalId = "tw-proposal",
): void {
  db.prepare(
    "INSERT INTO tower_decisions (id, proposal_id, verdict, created_at) VALUES (?, ?, ?, ?)",
  ).run(id, proposalId, verdict, NOW);
}

/** Inserts an extra PENDING proposal on the seeded lane/turn so a test can pin one decision per id. */
function insertProposal(db: Db, id: string, correlationId: string): void {
  db.prepare(
    `INSERT INTO tower_proposals
       (id, lane_id, turn_id, native_correlation_id, kind, raw_payload, created_at, decision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, "tw-lane", "tw-turn", correlationId, "command", "{}", NOW, "pending");
}

/**
 * Seeds a real v11 evidence DB without depending on the current EXPECTED_SCHEMA_VERSION: writes the
 * minimal pre-tower table set the tower FKs target (runs + chat_sessions) plus _schema_version={11}.
 * openDb then drives the v11->v12 migration over this fixture. PRAGMA foreign_keys=ON mirrors the
 * production posture so the seeded FK to runs is enforced.
 */
function seedV11Database(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE _schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO _schema_version(version) VALUES (11);
      CREATE TABLE runs (id TEXT PRIMARY KEY, vision TEXT NOT NULL, started_at TEXT NOT NULL);
      CREATE TABLE chat_sessions (
        id            TEXT PRIMARY KEY,
        run_id        TEXT NOT NULL REFERENCES runs(id),
        repo_root     TEXT NOT NULL,
        run_dir       TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        default_agent TEXT NOT NULL CHECK (default_agent IN ('claude','codex','gemini')),
        last_agent    TEXT          CHECK (last_agent IN ('claude','codex','gemini')),
        summary_text  TEXT NOT NULL DEFAULT '',
        summary_through_turn INTEGER NOT NULL DEFAULT 0
      );
    `);
  } finally {
    db.close();
  }
}

/**
 * Plants an INDEX whose name collides with a tower table. The migration's
 * `CREATE TABLE IF NOT EXISTS <name>` raises "there is already an index named <name>" — a real,
 * seam-free fault that forces the v11->v12 transaction to roll back partway through.
 */
function plantTowerNameCollision(dbPath: string, towerTableName: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`CREATE INDEX ${towerTableName} ON runs(id);`);
  } finally {
    db.close();
  }
}

/**
 * Seeds a chat_sessions parent + the full tower chain (session->lane->turn->proposal->worktree) on a
 * freshly-migrated v12 DB so cascade/restrict, CAS, and enum tests share one fixture. The proposal is
 * left in 'pending' so the CAS test can transition it exactly once.
 */
function seedTowerChain(db: Db): void {
  db.prepare("INSERT INTO runs (id, vision, started_at) VALUES (?, ?, ?)").run(
    "tw-run",
    "ship",
    NOW,
  );
  db.prepare(
    `INSERT INTO chat_sessions
       (id, run_id, repo_root, run_dir, created_at, updated_at, default_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("chat-session", "tw-run", "/repo", "/repo/.zer0", NOW, NOW, "claude");
  db.prepare(
    "INSERT INTO tower_sessions (id, started_at, operator, chat_session_id) VALUES (?, ?, ?, ?)",
  ).run("tw-session", NOW, "operator", "chat-session");
  db.prepare(
    `INSERT INTO tower_agent_lanes
       (id, agent, session_id, worktree_path, branch, base_sha, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("tw-lane", "claude", "tw-session", "/repo/wt", "feature", "abc123", "working");
  db.prepare("INSERT INTO tower_turns (id, lane_id, status, started_at) VALUES (?, ?, ?, ?)").run(
    "tw-turn",
    "tw-lane",
    "running",
    NOW,
  );
  db.prepare(
    `INSERT INTO tower_proposals
       (id, lane_id, turn_id, native_correlation_id, kind, raw_payload, created_at, decision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("tw-proposal", "tw-lane", "tw-turn", "corr-1", "command", "{}", NOW, "pending");
  db.prepare(
    "INSERT INTO tower_worktrees (path, branch, base_sha, lane_id, state) VALUES (?, ?, ?, ?, ?)",
  ).run("/repo/wt", "feature", "abc123", "tw-lane", "active");
}
