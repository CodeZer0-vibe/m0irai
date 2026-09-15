import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ChatLaunchedPeerRef,
  ChatPeerRef,
  ChatUnlaunchedPeerRef,
  ChatWorkingSetOutcome,
} from "../chat/types.js";
import { type Db, closeDb, openDb } from "./db.js";
import { createQueries } from "./queries.js";

const TEMP_PREFIX: string = "zer0-shared-brain-db-";
const DB_FILE: string = "evidence.db";
const RUN_ID: string = "run-shared-brain";
const SESSION_ID: string = "chat-shared-brain";
const CREATED_AT: string = "2026-06-03T00:00:00.000Z";
const SUCCESS_OUTCOME: ChatWorkingSetOutcome = "ok";

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

describe("v8 to v9 schema migration (M1: shared brain debate persistence)", () => {
  registerFreshDatabaseSpec();
  registerRawConstraintSpec();
  registerQueryPersistenceSpec();
});

function registerFreshDatabaseSpec(): void {
  it("migrates fresh databases to the current schema version and opens idempotently", () => {
    const dbPath = tempDbPath();
    const first = openDb(dbPath);
    assertSharedBrainSchema(first);
    closeDb(first);

    const second = openDb(dbPath);
    try {
      assertSharedBrainSchema(second);
      expect(second.prepare("SELECT version FROM _schema_version").all()).toEqual([
        { version: 14 },
      ]);
    } finally {
      closeDb(second);
    }
  });
}

function registerRawConstraintSpec(): void {
  it("rejects duplicate working sets and unsupported outcomes", () => {
    const db = openDb(tempDbPath());
    try {
      seedSession(db);
      insertWorkingSetRaw(db, { id: "ws-one" });
      expect(() => insertWorkingSetRaw(db, { id: "ws-duplicate" })).toThrow(/constraint/i);
      expect(() => insertUnsupportedOutcome(db)).toThrow(/constraint/i);
    } finally {
      closeDb(db);
    }
  });
}

function registerQueryPersistenceSpec(): void {
  it("inserts and selects working sets and active debate leases through queries", () => {
    const db = openDb(tempDbPath());
    try {
      seedSession(db);
      const queries = createQueries(db);
      insertWorkingSetThroughQueries(queries);
      assertWorkingSetRows(queries);
      assertActiveDebateLease(queries);
    } finally {
      closeDb(db);
    }
  });
}

function insertUnsupportedOutcome(db: Db): void {
  insertWorkingSetRaw(db, {
    agent: "gemini",
    id: "ws-bad-outcome",
    outcome: "unsupported",
  });
}

function insertWorkingSetThroughQueries(queries: SharedBrainQueries): void {
  queries.insertChatWorkingSet({
    agent: "codex",
    contextBlobHash: "blob-context",
    createdAt: CREATED_AT,
    id: "ws-query",
    outcome: SUCCESS_OUTCOME,
    peerRefs: queryPeerRefs(),
    round: 2,
    sessionId: SESSION_ID,
    tokenEstimate: 42,
    turn: 1,
  });
}

function assertWorkingSetRows(queries: SharedBrainQueries): void {
  expect(queries.listChatWorkingSets({ sessionId: SESSION_ID, turn: 1, round: 2 })).toEqual([
    {
      agent: "codex",
      contextBlobHash: "blob-context",
      createdAt: CREATED_AT,
      id: "ws-query",
      outcome: SUCCESS_OUTCOME,
      peerRefs: queryPeerRefs(),
      round: 2,
      sessionId: SESSION_ID,
      tokenEstimate: 42,
      turn: 1,
    },
  ]);
}

function assertActiveDebateLease(queries: SharedBrainQueries): void {
  expect(
    queries.acquireActiveDebate({ sessionId: SESSION_ID, turn: 1, startedAt: CREATED_AT }),
  ).toBe(true);
  expect(
    queries.acquireActiveDebate({ sessionId: SESSION_ID, turn: 2, startedAt: CREATED_AT }),
  ).toBe(false);
  expect(queries.getActiveDebate(SESSION_ID)).toEqual({
    sessionId: SESSION_ID,
    startedAt: CREATED_AT,
    turn: 1,
  });
  expect(queries.releaseActiveDebate(SESSION_ID)).toBe(true);
  expect(queries.getActiveDebate(SESSION_ID)).toBeUndefined();
}

function queryPeerRefs(): readonly ChatPeerRef[] {
  return [launchedPeerRef(), unlaunchedPeerRef()];
}

function launchedPeerRef(): ChatLaunchedPeerRef {
  return {
    agent: "claude",
    status: SUCCESS_OUTCOME,
    dispatch_id: "dispatch-claude-r1",
    output_blob_hash: "blob-output",
  };
}

function unlaunchedPeerRef(): ChatUnlaunchedPeerRef {
  return {
    agent: "gemini",
    status: "incomplete",
    attempt_id: "attempt-gemini-r1",
    error_summary_blob_hash: "blob-error-summary",
  };
}

function tempDbPath(): string {
  tempRoot = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  return join(tempRoot, DB_FILE);
}

function assertSharedBrainSchema(db: Db): void {
  expect(tableNames(db)).toEqual(expect.arrayContaining(["chat_working_sets", "active_debates"]));
  expect(columnInfo(db, "chat_messages", "round")).toMatchObject({
    dflt_value: "0",
    name: "round",
    notnull: 1,
    type: "INTEGER",
  });
  expect(indexNames(db, "chat_working_sets")).toContain("idx_chat_working_sets_session_turn_round");
}

function seedSession(db: Db): void {
  db.prepare("INSERT INTO runs (id, vision, started_at) VALUES (?, ?, ?)").run(
    RUN_ID,
    "shared brain",
    CREATED_AT,
  );
  db.prepare(
    "INSERT INTO chat_sessions (id, run_id, repo_root, run_dir, created_at, updated_at, default_agent, summary_text, summary_through_turn) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(SESSION_ID, RUN_ID, "C:/repo", "C:/repo/.council", CREATED_AT, CREATED_AT, "codex", "", 0);
}

function insertWorkingSetRaw(db: Db, overrides: Partial<RawWorkingSetInput> = {}): void {
  const row: RawWorkingSetInput = {
    agent: "codex",
    contextBlobHash: "blob-context",
    createdAt: CREATED_AT,
    id: "ws-default",
    outcome: "ok",
    peerRefs: "[]",
    round: 1,
    sessionId: SESSION_ID,
    tokenEstimate: 12,
    turn: 1,
    ...overrides,
  };
  db.prepare(
    "INSERT INTO chat_working_sets (id, session_id, turn, round, agent, context_blob_hash, peer_refs, outcome, token_estimate, created_at) VALUES (@id, @sessionId, @turn, @round, @agent, @contextBlobHash, @peerRefs, @outcome, @tokenEstimate, @createdAt)",
  ).run(row);
}

function tableNames(db: Db): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual') ORDER BY name")
    .all()
    .map((row) => (row as NameRow).name);
}

function indexNames(db: Db, table: string): string[] {
  return db
    .prepare(`PRAGMA index_list('${table}')`)
    .all()
    .map((row) => (row as NameRow).name);
}

function columnInfo(db: Db, table: string, columnName: string): ColumnInfoRow | undefined {
  return db
    .prepare(`PRAGMA table_info('${table}')`)
    .all()
    .map((row) => row as ColumnInfoRow)
    .find((row) => row.name === columnName);
}

interface RawWorkingSetInput {
  readonly id: string;
  readonly sessionId: string;
  readonly turn: number;
  readonly round: number;
  readonly agent: string;
  readonly contextBlobHash: string;
  readonly peerRefs: string;
  readonly outcome: string;
  readonly tokenEstimate: number | null;
  readonly createdAt: string;
}

interface NameRow {
  readonly name: string;
}

interface ColumnInfoRow {
  readonly name: string;
  readonly notnull: number;
  readonly type: string;
  readonly dflt_value: string | null;
}

type SharedBrainQueries = ReturnType<typeof createQueries>;
