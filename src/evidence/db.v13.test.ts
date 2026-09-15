// @size-justified: v12->v13 evidence-ledger migration suite — 9 new tables, all append-only
// and status-advance triggers, UNIQUE constraints, composite cross-project FKs, chat_sessions
// quarantine columns, and rollback atomicity each require seeded-state + post-migration
// assertions in their own describe block. Mirrors the sibling db-tower-tables.test.ts convention.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { type Db, closeDb, openDb } from "./db.js";

const TEMP_PREFIX: string = "zer0-v13-db-";
const DB_FILE: string = "evidence.db";
const NOW: string = "2026-06-29T00:00:00.000Z";

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

// ─── test helpers ─────────────────────────────────────────────────────────────

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
  const row = db.prepare("SELECT version FROM _schema_version").get() as
    | { version: number }
    | undefined;
  return row?.version ?? -1;
}

function columnNames(db: Db, table: string): string[] {
  return (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
}

/**
 * Inserts one row into each FK parent table required by work_journal / agent_reports:
 * projects → memory_tasks → agent_turns. All downstream tests call this first.
 */
function seedEvidenceChain(db: Db): void {
  db.prepare(
    `INSERT INTO projects (project_id, canonical_root, git_common_dir, remote_fingerprint, aliases_json, quarantined, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("proj-1", "/repo", "/repo/.git", "", "[]", 0, NOW);
  db.prepare(
    `INSERT INTO memory_tasks (task_id, project_id, objective, status, seq, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("mt-1", "proj-1", "test task", "planned", 1, NOW);
  db.prepare(
    `INSERT INTO agent_turns (turn_id, task_id, project_id, agent, ordinal, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("at-1", "mt-1", "proj-1", "claude", 1, NOW);
}

function insertWorkJournal(db: Db, id: string, seq = 1): void {
  db.prepare(
    `INSERT INTO work_journal (event_id, turn_id, project_id, agent, kind, seq, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, "at-1", "proj-1", "claude", "note", seq, NOW);
}

function insertAgentReport(db: Db, id: string, dispatchId: string, seq = 1): void {
  db.prepare(
    `INSERT INTO agent_reports (report_id, turn_id, project_id, agent, dispatch_id, status, seq, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, "at-1", "proj-1", "claude", dispatchId, "draft", seq, NOW);
}

function insertVerification(db: Db, id: string, reportId: string, seq = 1): void {
  db.prepare(
    `INSERT INTO verifications (verification_id, report_id, project_id, result, seq, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, reportId, "proj-1", "match", seq, NOW);
}

/** Seeds a second project row so cross-project FK tests can target proj-2 without the
 *  single-column FK to projects(project_id) firing before the composite FK is checked. */
function seedProjectB(db: Db): void {
  db.prepare(
    `INSERT INTO projects (project_id, canonical_root, git_common_dir, remote_fingerprint, aliases_json, quarantined, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("proj-2", "/repo2", "/repo2/.git", "", "[]", 0, NOW);
}

/**
 * Seeds a minimal v12 DB with a chat_sessions table (without project_id/quarantined columns)
 * and two rows — one with empty repo_root (should be quarantined) and one with a real path.
 * openDb then drives the v12->v13 migration over this fixture.
 */
function seedV12Database(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE _schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO _schema_version(version) VALUES (12);
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, vision TEXT NOT NULL, started_at TEXT NOT NULL
      );
      CREATE TABLE chat_sessions (
        id                   TEXT PRIMARY KEY,
        run_id               TEXT NOT NULL REFERENCES runs(id),
        repo_root            TEXT NOT NULL,
        run_dir              TEXT NOT NULL,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL,
        default_agent        TEXT NOT NULL CHECK (default_agent IN ('claude','codex','gemini')),
        last_agent           TEXT          CHECK (last_agent IN ('claude','codex','gemini')),
        summary_text         TEXT NOT NULL DEFAULT '',
        summary_through_turn INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.prepare("INSERT INTO runs (id, vision, started_at) VALUES (?, ?, ?)").run("r1", "test", NOW);
    // Empty repo_root — migration quarantine UPDATE should set quarantined=1.
    db.prepare(
      `INSERT INTO chat_sessions (id, run_id, repo_root, run_dir, created_at, updated_at, default_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("s-empty", "r1", "", "/dir", NOW, NOW, "claude");
    // Real repo_root — must remain quarantined=0.
    db.prepare(
      `INSERT INTO chat_sessions (id, run_id, repo_root, run_dir, created_at, updated_at, default_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("s-real", "r1", "/real/repo", "/dir", NOW, NOW, "claude");
  } finally {
    db.close();
  }
}

/**
 * Plants an INDEX whose name collides with a v13 table. CREATE TABLE IF NOT EXISTS <tableName>
 * in MIGRATION_V12_TO_V13 then throws, forcing the whole transaction to roll back to {12}.
 */
function plantTableNameCollision(dbPath: string, tableName: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`CREATE INDEX ${tableName} ON runs(id);`);
  } finally {
    db.close();
  }
}

// ─── test scenarios ───────────────────────────────────────────────────────────

describe("v12→v13 migration idempotence (scenario 1)", () => {
  it("opens a fresh DB at schema version 14 and stays at 14 on second open", () => {
    const dbPath = tempDbPath();
    withDb(dbPath, (db) => {
      expect(schemaVersion(db)).toBe(14);
    });
    withDb(dbPath, (db) => {
      expect(schemaVersion(db)).toBe(14);
    });
  });
});

describe("v13 append-only enforcement (scenario 2)", () => {
  it("work_journal rejects UPDATE and rejects DELETE", () => {
    withDb(tempDbPath(), (db) => {
      seedEvidenceChain(db);
      insertWorkJournal(db, "wj-1");
      expect(() =>
        db.prepare("UPDATE work_journal SET kind = 'edit' WHERE event_id = 'wj-1'").run(),
      ).toThrow(/append-only/i);
      expect(() => db.prepare("DELETE FROM work_journal WHERE event_id = 'wj-1'").run()).toThrow(
        /append-only/i,
      );
    });
  });

  it("verifications rejects UPDATE and rejects DELETE", () => {
    withDb(tempDbPath(), (db) => {
      seedEvidenceChain(db);
      insertAgentReport(db, "ar-1", "disp-1");
      insertVerification(db, "vf-1", "ar-1");
      expect(() =>
        db
          .prepare("UPDATE verifications SET result = 'error' WHERE verification_id = 'vf-1'")
          .run(),
      ).toThrow(/append-only/i);
      expect(() =>
        db.prepare("DELETE FROM verifications WHERE verification_id = 'vf-1'").run(),
      ).toThrow(/append-only/i);
    });
  });
});

describe("v13 agent_reports status-advance trigger (scenario 3)", () => {
  it("permits status advance but rejects frozen column mutation and delete", () => {
    withDb(tempDbPath(), (db) => {
      seedEvidenceChain(db);
      insertAgentReport(db, "ar-1", "disp-1");

      // Status advance succeeds — only status column changes.
      expect(() =>
        db.prepare("UPDATE agent_reports SET status = 'verified' WHERE report_id = 'ar-1'").run(),
      ).not.toThrow();

      // Frozen column mutation (claimed_json) throws — evidence body is immutable.
      expect(() =>
        db.prepare("UPDATE agent_reports SET claimed_json = '{}' WHERE report_id = 'ar-1'").run(),
      ).toThrow(/immutable/i);

      // Delete throws — append-only.
      expect(() => db.prepare("DELETE FROM agent_reports WHERE report_id = 'ar-1'").run()).toThrow(
        /append-only/i,
      );
    });
  });
});

describe("v13 uniqueness constraints (scenarios 4 and 5)", () => {
  it("agent_reports rejects duplicate (turn_id, agent, dispatch_id) — scenario 4", () => {
    withDb(tempDbPath(), (db) => {
      seedEvidenceChain(db);
      // Two inserts with identical (turn_id='at-1', agent='claude', dispatch_id='disp-1').
      // Different seq values isolate the (turn_id, agent, dispatch_id) UNIQUE constraint.
      insertAgentReport(db, "ar-1", "disp-1", 1);
      expect(() => insertAgentReport(db, "ar-2", "disp-1", 2)).toThrow(/UNIQUE/i);
    });
  });

  it("work_journal rejects duplicate (project_id, seq) — scenario 5", () => {
    withDb(tempDbPath(), (db) => {
      seedEvidenceChain(db);
      insertWorkJournal(db, "wj-1", 1);
      expect(() => insertWorkJournal(db, "wj-2", 1)).toThrow(/UNIQUE/i);
    });
  });
});

describe("v13 chat_sessions quarantine columns (scenario 6)", () => {
  it("chat_sessions has project_id and quarantined columns after migration", () => {
    withDb(tempDbPath(), (db) => {
      const cols = columnNames(db, "chat_sessions");
      expect(cols).toContain("project_id");
      expect(cols).toContain("quarantined");
    });
  });

  it("migration quarantines chat_sessions rows with empty repo_root", () => {
    const dbPath = tempDbPath();
    seedV12Database(dbPath);
    withDb(dbPath, (db) => {
      const emptyRow = db
        .prepare("SELECT quarantined FROM chat_sessions WHERE id = 's-empty'")
        .get() as { quarantined: number } | undefined;
      const realRow = db
        .prepare("SELECT quarantined FROM chat_sessions WHERE id = 's-real'")
        .get() as { quarantined: number } | undefined;
      expect(emptyRow?.quarantined).toBe(1);
      expect(realRow?.quarantined).toBe(0);
    });
  });
});

describe("v13 migration rollback on failure (scenario 7)", () => {
  it("rolls back the whole v12→v13 migration on mid-transaction failure — version stays 12, no v13 tables", () => {
    const dbPath = tempDbPath();
    seedV12Database(dbPath);
    // Plant an index named "memory_tasks" — CREATE TABLE IF NOT EXISTS memory_tasks in
    // MIGRATION_V12_TO_V13 throws "there is already an index named memory_tasks", forcing rollback.
    plantTableNameCollision(dbPath, "memory_tasks");

    expect(() => openDb(dbPath)).toThrow();

    const probe = new Database(dbPath);
    try {
      expect(probe.prepare("SELECT version FROM _schema_version ORDER BY version").all()).toEqual([
        { version: 12 },
      ]);
      expect(
        probe
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'")
          .all(),
      ).toEqual([]);
    } finally {
      probe.close();
    }
  });
});

// ─── helpers for FTS5 tests ───────────────────────────────────────────────────

function insertDecision(db: Db, id: string, title: string, rationale: string): void {
  db.prepare(
    `INSERT INTO decisions (decision_id, project_id, title, rationale, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, "proj-1", title, rationale, "proposed", NOW);
}

/** Joins work_journal_fts with work_journal to resolve event_id (external-content FTS). */
function ftsWjByTerm(db: Db, term: string): Array<{ event_id: string }> {
  return db
    .prepare(
      `SELECT wj.event_id FROM work_journal wj
       JOIN work_journal_fts f ON wj.rowid = f.rowid
       WHERE work_journal_fts MATCH ?`,
    )
    .all(term) as Array<{ event_id: string }>;
}

/** Joins decisions_fts with decisions to resolve decision_id (external-content FTS). */
function ftsDecisionByTerm(db: Db, term: string): Array<{ decision_id: string }> {
  return db
    .prepare(
      `SELECT d.decision_id FROM decisions_fts f JOIN decisions d ON d.rowid = f.rowid
       WHERE decisions_fts MATCH ?`,
    )
    .all(term) as Array<{ decision_id: string }>;
}

// ─── helpers for cross-project FK tests ──────────────────────────────────────

function insertTurnForProject(db: Db, turnId: string, taskId: string, projectId: string): void {
  db.prepare(
    `INSERT INTO agent_turns (turn_id, task_id, project_id, agent, ordinal, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(turnId, taskId, projectId, "claude", 2, NOW);
}

function insertJournalForProject(db: Db, eventId: string, turnId: string, projectId: string): void {
  db.prepare(
    `INSERT INTO work_journal (event_id, turn_id, project_id, agent, kind, seq, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(eventId, turnId, projectId, "claude", "note", 1, NOW);
}

function insertReportForProject(
  db: Db,
  id: string,
  turnId: string,
  projectId: string,
  dispId: string,
): void {
  db.prepare(
    `INSERT INTO agent_reports (report_id, turn_id, project_id, agent, dispatch_id, status, seq, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, turnId, projectId, "claude", dispId, "draft", 1, NOW);
}

function insertVerifForProject(db: Db, verifId: string, reportId: string, projectId: string): void {
  db.prepare(
    `INSERT INTO verifications (verification_id, report_id, project_id, result, seq, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(verifId, reportId, projectId, "match", 1, NOW);
}

// ─── cross-project FK tests (one describe per table) ─────────────────────────

describe("v13 FK — agent_turns rejects cross-project task_id", () => {
  it("task_id from proj-1 with project_id=proj-2 throws; same-project succeeds", () => {
    withDb(tempDbPath(), (db) => {
      seedEvidenceChain(db);
      seedProjectB(db);
      // Cross-project: mt-1 belongs to proj-1, but this turn claims proj-2.
      expect(() => insertTurnForProject(db, "at-x", "mt-1", "proj-2")).toThrow(/FOREIGN KEY/i);
      // Happy path.
      expect(() => insertTurnForProject(db, "at-ok", "mt-1", "proj-1")).not.toThrow();
    });
  });
});

describe("v13 FK — work_journal rejects cross-project turn_id", () => {
  it("turn_id from proj-1 with project_id=proj-2 throws; same-project succeeds", () => {
    withDb(tempDbPath(), (db) => {
      seedEvidenceChain(db);
      seedProjectB(db);
      // Cross-project: at-1 belongs to proj-1, but this entry claims proj-2.
      expect(() => insertJournalForProject(db, "wj-x", "at-1", "proj-2")).toThrow(/FOREIGN KEY/i);
      // Happy path.
      expect(() => insertJournalForProject(db, "wj-ok", "at-1", "proj-1")).not.toThrow();
    });
  });
});

describe("v13 FK — agent_reports rejects cross-project turn_id", () => {
  it("turn_id from proj-1 with project_id=proj-2 throws; same-project succeeds", () => {
    withDb(tempDbPath(), (db) => {
      seedEvidenceChain(db);
      seedProjectB(db);
      // Cross-project: at-1 belongs to proj-1, but this report claims proj-2.
      expect(() => insertReportForProject(db, "ar-x", "at-1", "proj-2", "d-x")).toThrow(
        /FOREIGN KEY/i,
      );
      // Happy path.
      expect(() => insertReportForProject(db, "ar-ok", "at-1", "proj-1", "d-ok")).not.toThrow();
    });
  });
});

describe("v13 FK — verifications rejects cross-project report_id", () => {
  it("report_id from proj-1 with project_id=proj-2 throws; same-project succeeds", () => {
    withDb(tempDbPath(), (db) => {
      seedEvidenceChain(db);
      seedProjectB(db);
      insertAgentReport(db, "ar-1", "disp-1");
      // Cross-project: ar-1 belongs to proj-1, but this verification claims proj-2.
      expect(() => insertVerifForProject(db, "vf-x", "ar-1", "proj-2")).toThrow(/FOREIGN KEY/i);
      // Happy path.
      expect(() => insertVerifForProject(db, "vf-ok", "ar-1", "proj-1")).not.toThrow();
    });
  });
});

describe("v13 additional seq uniqueness — agent_reports and verifications", () => {
  it("agent_reports rejects duplicate (project_id, seq)", () => {
    withDb(tempDbPath(), (db) => {
      seedEvidenceChain(db);
      insertAgentReport(db, "ar-1", "disp-1", 1);
      // Different dispatch_id so UNIQUE(turn_id, agent, dispatch_id) does not fire first.
      expect(() => insertAgentReport(db, "ar-2", "disp-2", 1)).toThrow(/UNIQUE/i);
    });
  });

  it("verifications rejects duplicate (project_id, seq)", () => {
    withDb(tempDbPath(), (db) => {
      seedEvidenceChain(db);
      insertAgentReport(db, "ar-1", "disp-1");
      insertVerification(db, "vf-1", "ar-1", 1);
      expect(() => insertVerification(db, "vf-2", "ar-1", 1)).toThrow(/UNIQUE/i);
    });
  });
});

describe("v13 FTS5 — work_journal_fts match (scenario 12a)", () => {
  it("matches inserted body term and returns nothing for absent term", () => {
    withDb(tempDbPath(), (db) => {
      seedEvidenceChain(db);
      db.prepare(
        `INSERT INTO work_journal (event_id, turn_id, project_id, agent, kind, body, seq, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("wj-fts-1", "at-1", "proj-1", "claude", "note", "the quick brown fox", 1, NOW);
      // Present term — rowid join resolves via ftsWjByTerm helper.
      const hit = ftsWjByTerm(db, "brown");
      expect(hit).toHaveLength(1);
      expect(hit[0]?.event_id).toBe("wj-fts-1");
      // Absent term — returns nothing.
      const miss = ftsWjByTerm(db, "elephant");
      expect(miss).toHaveLength(0);
    });
  });
});

describe("v13 FTS5 — decisions_fts insert and update (scenario 12b)", () => {
  it("insert trigger indexes title/rationale; update trigger replaces old entry", () => {
    withDb(tempDbPath(), (db) => {
      seedEvidenceChain(db);
      insertDecision(db, "dec-fts-1", "QuantumLeap", "InitialRationale");
      // Title match — external-content FTS5: rowid join retrieves decision_id.
      const byTitle = ftsDecisionByTerm(db, "QuantumLeap");
      expect(byTitle).toHaveLength(1);
      expect(byTitle[0]?.decision_id).toBe("dec-fts-1");
      // Rationale match.
      const byRationale = ftsDecisionByTerm(db, "InitialRationale");
      expect(byRationale).toHaveLength(1);
      // Update rationale — old term must disappear, new term must appear.
      db.prepare(`UPDATE decisions SET rationale = 'RevisedRationale' WHERE decision_id = ?`).run(
        "dec-fts-1",
      );
      const oldGone = ftsDecisionByTerm(db, "InitialRationale");
      expect(oldGone).toHaveLength(0);
      const newHit = ftsDecisionByTerm(db, "RevisedRationale");
      expect(newHit).toHaveLength(1);
      expect(newHit[0]?.decision_id).toBe("dec-fts-1");
    });
  });
});

describe("v13 FTS5 — virtual tables survive close + re-open (scenario 12c)", () => {
  it("schema version stays 13 and FTS tables present after close + re-open", () => {
    const dbPath = tempDbPath();
    withDb(dbPath, (db) => {
      expect(schemaVersion(db)).toBe(14);
    });
    // Second open — must not throw and idempotence must hold.
    withDb(dbPath, (db) => {
      expect(schemaVersion(db)).toBe(14);
      // Verify virtual tables exist in sqlite_master.
      const wjFts = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'work_journal_fts'`,
        )
        .get() as { name: string } | undefined;
      const decFts = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'decisions_fts'`)
        .get() as { name: string } | undefined;
      expect(wjFts?.name).toBe("work_journal_fts");
      expect(decFts?.name).toBe("decisions_fts");
    });
  });
});
