// @size-justified: schema migration test suite — every version bump (v1..v8) needs its own describe block with seeded-state + post-migration assertions. Splitting per-version creates 8 nearly-identical test files with shared seeders, worse for navigation. Re-evaluate when v9+ lands.
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError } from "../shared/errors.js";
import { type Db, closeDb, openDb } from "./db.js";

const TEMP_PREFIX: string = "zer0-evidence-db-";
const DB_FILE: string = "evidence.db";
const EXPECTED_TABLES: readonly string[] = [
  "_schema_version",
  "runs",
  "requirements",
  "tasks",
  "context_runs",
  "context_items",
  "findings",
  "gate_transitions",
  "dispatches",
  "errors",
  "events",
  "dispatch_claims",
  "commit_intents",
  "capacity_snapshots",
  "tournament_results",
  "agent_failure_patterns",
  "active_debates",
  "findings_fts",
  "chat_working_sets",
  "chat_build_runs",
  "chat_build_assignments",
  "chat_artifacts",
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

describe("openDb", () => {
  it("creates the database, applies schema, and enables required PRAGMAs", () => {
    const dbPath = tempDbPath();
    const db = openDb({ dbPath });

    try {
      expect(existsSync(dbPath)).toBe(true);
      expect(tableNames(db)).toEqual(expect.arrayContaining([...EXPECTED_TABLES]));
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(db.pragma("busy_timeout", { simple: true })).toBe(5_000);
    } finally {
      closeDb(db);
    }
  });

  it("applies schema idempotently when opened twice", () => {
    const dbPath = tempDbPath();
    const first = openDb(dbPath);
    closeDb(first);

    const second = openDb(dbPath);
    try {
      expect(tableNames(second)).toContain("runs");
      expect(second.prepare("SELECT COUNT(*) AS count FROM _schema_version").get()).toEqual({
        count: 1,
      });
    } finally {
      closeDb(second);
    }
  });
});

describe("evidence schema constraints", () => {
  it("enforces dispatch task foreign keys on clean databases", () => {
    const db = openDb(tempDbPath());

    try {
      expect(() =>
        db
          .prepare(
            "INSERT INTO dispatches (id, task_id, agent, command_hash, exit_code, stdout_blob, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run("dispatch-orphan", "BUILD-missing", "codex", "hash", 0, "blob", 1),
      ).toThrow();
    } finally {
      closeDb(db);
    }
  });

  it("enforces unique dispatch identity on clean databases", () => {
    const db = openDb(tempDbPath());

    try {
      seedRunAndTask(db);
      insertDispatch(db, "dispatch-one");

      expect(() => insertDispatch(db, "dispatch-two")).toThrow();
    } finally {
      closeDb(db);
    }
  });
});

describe("evidence schema unique constraints", () => {
  it("enforces unique gate transition identity on clean databases", () => {
    const db = openDb(tempDbPath());

    try {
      db.prepare("INSERT INTO runs (id, vision, started_at) VALUES (?, ?, ?)").run(
        "run-gate",
        "ship",
        "2026-05-04T00:00:00.000Z",
      );
      insertGateTransition(db, "gate-one");

      expect(() => insertGateTransition(db, "gate-two")).toThrow();
    } finally {
      closeDb(db);
    }
  });

  it("enforces unique dispatch claim identity on clean databases", () => {
    const db = openDb(tempDbPath());

    try {
      db.prepare("INSERT INTO runs (id, vision, started_at) VALUES (?, ?, ?)").run(
        "run-claim",
        "ship",
        "2026-05-04T00:00:00.000Z",
      );
      insertDispatchClaim(db, "claim-one");

      expect(() => insertDispatchClaim(db, "claim-two")).toThrow();
    } finally {
      closeDb(db);
    }
  });
});

describe("v1 to v5 schema migration", () => {
  it("upgrades a v1 DB (passed-in-index) to v5", () => {
    const dbPath = tempDbPath();
    seedV1Database(dbPath);

    const db = openDb(dbPath);
    try {
      const versionRow = db
        .prepare("SELECT MAX(version) AS version, COUNT(*) AS count FROM _schema_version")
        .get();
      expect(versionRow).toEqual({ version: 14, count: 1 });
      const indexInfo = db
        .prepare("PRAGMA index_info('idx_gate_transitions_unique')")
        .all() as Array<{ name: string }>;
      const indexedColumns = indexInfo.map((row) => row.name).sort();
      expect(indexedColumns).toEqual(["gate_name", "run_id"]);
    } finally {
      closeDb(db);
    }
  });
});

describe("v2 to v5 schema migration", () => {
  it("upgrades a v2 DB to v5 with observability tables and replay columns", () => {
    const dbPath = tempDbPath();
    seedV2Database(dbPath);

    const db = openDb(dbPath);
    try {
      const versionRow = db
        .prepare("SELECT MAX(version) AS version, COUNT(*) AS count FROM _schema_version")
        .get();
      expect(versionRow).toEqual({ version: 14, count: 1 });
      expect(tableNames(db)).toEqual(expect.arrayContaining(["errors", "events"]));
      expect(columnNames(db, "dispatches")).toEqual(expect.arrayContaining(["argv_json", "cwd"]));
      expect(columnNames(db, "events")).toContain("sequence");
    } finally {
      closeDb(db);
    }
  });

  it("opens a v3 DB twice without schema churn", () => {
    const dbPath = tempDbPath();
    const first = openDb(dbPath);
    const before = indexSql(first, "idx_events_run_sequence_unique");
    closeDb(first);

    const second = openDb(dbPath);
    try {
      expect(indexSql(second, "idx_events_run_sequence_unique")).toBe(before);
    } finally {
      closeDb(second);
    }
  });
});

describe("v5 to v6 schema migration", () => {
  it("creates idempotency column, partial index, and current version on fresh databases", () => {
    const db = openDb(tempDbPath());
    try {
      expect(columnInfo(db, "events", "idempotency_key")).toMatchObject({
        name: "idempotency_key",
        notnull: 0,
        type: "TEXT",
      });
      expect(indexSql(db, "idx_events_idempotency")).toContain("WHERE idempotency_key IS NOT NULL");
      expect(db.prepare("SELECT version FROM _schema_version ORDER BY version").all()).toEqual([
        { version: 14 },
      ]);
    } finally {
      closeDb(db);
    }
  });

  it("upgrades legacy v5 events tables idempotently", () => {
    const dbPath = tempDbPath();
    seedV5Database(dbPath);

    const first = openDb(dbPath);
    closeDb(first);
    const second = openDb(dbPath);
    try {
      expect(columnInfo(second, "events", "idempotency_key")?.type).toBe("TEXT");
      expect(indexSql(second, "idx_events_idempotency")).toContain(
        "WHERE idempotency_key IS NOT NULL",
      );
      expect(second.prepare("SELECT version FROM _schema_version ORDER BY version").all()).toEqual([
        { version: 14 },
      ]);
      expect(second.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 1 });
    } finally {
      closeDb(second);
    }
  });
});

describe("v6 to v7 schema migration", () => {
  it("migrates v6 DB through v7 to v8 with idx_findings_path", () => {
    const db = openDb(tempDbPath());
    try {
      const row = db.prepare("SELECT version FROM _schema_version").get();
      expect(row).toEqual({ version: 14 });

      const indexes = db.prepare("PRAGMA index_list('findings')").all() as Array<{
        readonly name: string;
      }>;
      const pathIndex = indexes.find((idx) => idx.name === "idx_findings_path");
      expect(pathIndex).toBeDefined();
    } finally {
      closeDb(db);
    }
  });
});

describe("v7 to v8 schema migration (K1: chat_sessions + chat_messages)", () => {
  it("creates chat_sessions + chat_messages + idx_chat_messages_session_turn on fresh databases", () => {
    const db = openDb(tempDbPath());
    try {
      expect(tableNames(db)).toEqual(expect.arrayContaining(["chat_sessions", "chat_messages"]));

      expect(columnNames(db, "chat_sessions")).toEqual(
        expect.arrayContaining([
          "id",
          "run_id",
          "repo_root",
          "run_dir",
          "created_at",
          "updated_at",
          "default_agent",
          "last_agent",
          "summary_text",
          "summary_through_turn",
        ]),
      );

      expect(columnNames(db, "chat_messages")).toEqual(
        expect.arrayContaining([
          "id",
          "session_id",
          "turn",
          "round",
          "role",
          "agent",
          "text_blob_hash",
          "created_at",
          "status",
          "token_estimate",
          "dispatch_id",
        ]),
      );

      const idx = db.prepare("PRAGMA index_list('chat_messages')").all() as Array<{
        readonly name: string;
      }>;
      expect(idx.find((i) => i.name === "idx_chat_messages_session_turn")).toBeDefined();

      expect(db.prepare("SELECT version FROM _schema_version").all()).toEqual([{ version: 14 }]);
    } finally {
      closeDb(db);
    }
  });
});

describe("v7 to v8 schema migration FK enforcement", () => {
  it("enforces chat_messages.session_id FK to chat_sessions(id)", () => {
    const db = openDb(tempDbPath());
    try {
      expect(() => {
        db.prepare(
          `INSERT INTO chat_messages (id, session_id, turn, role, agent, text_blob_hash, created_at, status, token_estimate)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          "msg-x",
          "session-does-not-exist",
          0,
          "user",
          "user",
          "deadbeef",
          new Date().toISOString(),
          "completed",
          1,
        );
      }).toThrow(/FOREIGN KEY/i);
    } finally {
      closeDb(db);
    }
  });
});

describe("openDb error handling", () => {
  it("throws ConfigError for schema version drift", () => {
    const dbPath = tempDbPath();
    const db = openDb(dbPath);
    db.prepare("UPDATE _schema_version SET version = ?").run(99);
    closeDb(db);

    expect(() => openDb(dbPath)).toThrow(ConfigError);
    expect(() => openDb(dbPath)).toThrow("SCHEMA_DRIFT");
  });

  it("throws ConfigError when dbPath is empty", () => {
    expect(() => openDb({ dbPath: "" })).toThrow(ConfigError);
    expect(() => openDb("   ")).toThrow(ConfigError);
  });

  it("wraps an invalid parent path as ConfigError", () => {
    const tmpFile = join(tmpdir(), `zer0-not-a-dir-${process.pid}-${Date.now()}`);
    writeFileSync(tmpFile, "");

    try {
      expect(() => openDb({ dbPath: join(tmpFile, DB_FILE) })).toThrow(ConfigError);
    } finally {
      unlinkSync(tmpFile);
    }
  });
});

describe("closeDb", () => {
  it("closes an open handle and tolerates a second close", () => {
    const db = openDb(tempDbPath());

    closeDb(db);
    closeDb(db);

    expect(db.open).toBe(false);
  });
});

function tempDbPath(): string {
  tempRoot = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  return join(tempRoot, DB_FILE);
}

function tableNames(db: Db): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual') ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
}

function columnNames(db: Db, table: string): string[] {
  return db
    .prepare(`PRAGMA table_info('${table}')`)
    .all()
    .map((row) => (row as { name: string }).name);
}

function columnInfo(
  db: Db,
  table: string,
  columnName: string,
): { readonly name: string; readonly notnull: number; readonly type: string } | undefined {
  return db
    .prepare(`PRAGMA table_info('${table}')`)
    .all()
    .map(
      (row) =>
        row as {
          readonly name: string;
          readonly notnull: number;
          readonly type: string;
        },
    )
    .find((row) => row.name === columnName);
}

function indexSql(db: Db, indexName: string): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(indexName) as { sql: string } | undefined;
  return row?.sql ?? "";
}

function seedRunAndTask(db: Db): void {
  db.prepare("INSERT INTO runs (id, vision, started_at) VALUES (?, ?, ?)").run(
    "run-db",
    "ship",
    "2026-05-04T00:00:00.000Z",
  );
  db.prepare(
    "INSERT INTO tasks (id, run_id, objective, agent, owned_files, forbidden_files, acceptance) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("BUILD-db", "run-db", "ship", "codex", "[]", "[]", "[]");
}

function insertDispatch(db: Db, id: string): void {
  db.prepare(
    "INSERT INTO dispatches (id, task_id, agent, command_hash, exit_code, stdout_blob, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, "BUILD-db", "codex", "hash", 0, "blob", 1);
}

function insertDispatchClaim(db: Db, id: string): void {
  db.prepare(
    "INSERT INTO dispatch_claims (id, run_id, task_id, attempt_hash) VALUES (?, ?, ?, ?)",
  ).run(id, "run-claim", "BUILD-claim", "hash");
}

function insertGateTransition(db: Db, id: string): void {
  db.prepare(
    "INSERT INTO gate_transitions (id, run_id, from_state, to_state, gate_name, passed, evidence_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, "run-gate", "build", "review", "build", 1, "{}");
}

function seedV1Database(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE _schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO _schema_version(version) VALUES (1);
      CREATE TABLE runs (id TEXT PRIMARY KEY, vision TEXT NOT NULL, started_at TEXT NOT NULL);
      CREATE TABLE gate_transitions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        gate_name TEXT NOT NULL,
        passed INTEGER NOT NULL,
        evidence_json TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_gate_transitions_unique ON gate_transitions(run_id, gate_name, passed);
    `);
  } finally {
    db.close();
  }
}

function seedV2Database(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE _schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO _schema_version(version) VALUES (2);
      CREATE TABLE runs (id TEXT PRIMARY KEY, vision TEXT NOT NULL, started_at TEXT NOT NULL);
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        objective TEXT NOT NULL,
        agent TEXT NOT NULL,
        owned_files TEXT NOT NULL,
        forbidden_files TEXT NOT NULL,
        acceptance TEXT NOT NULL
      );
      CREATE TABLE gate_transitions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        gate_name TEXT NOT NULL,
        passed INTEGER NOT NULL,
        evidence_json TEXT NOT NULL
      );
      CREATE TABLE dispatches (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        command_hash TEXT NOT NULL,
        exit_code INTEGER NOT NULL,
        stdout_blob TEXT NOT NULL,
        duration_ms INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_gate_transitions_unique ON gate_transitions(run_id, gate_name);
      CREATE UNIQUE INDEX idx_dispatches_unique ON dispatches(task_id, agent, command_hash);
    `);
  } finally {
    db.close();
  }
}

function seedV5Database(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE _schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO _schema_version(version) VALUES (5);
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        vision TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'init',
        started_at TEXT NOT NULL
      );
      INSERT INTO runs (id, vision, started_at) VALUES ('run-v5', 'ship', '2026-05-09');
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        sequence INTEGER NOT NULL,
        kind TEXT NOT NULL,
        phase TEXT,
        task_id TEXT,
        error_id TEXT,
        trace_id TEXT,
        span_id TEXT,
        parent_span_id TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO events (id, run_id, sequence, kind, payload_json) VALUES ('event-v5', 'run-v5', 1, 'packet.started', '{}');
    `);
  } finally {
    db.close();
  }
}
