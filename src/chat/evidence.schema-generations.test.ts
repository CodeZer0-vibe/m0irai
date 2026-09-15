/**
 * @file src/chat/evidence.schema-generations.test.ts
 * @purpose F1 root-cause proof: a chat dispatch evidence write must create the task row (and thus the
 *   dispatch row + a resolvable dispatch id) on BOTH schema generations — the current schema where
 *   tasks.status carries DEFAULT 'pending', AND a DEPLOYED-legacy shape where tasks.status is NOT NULL
 *   with NO default (the operator's live DB at schema_version 13). Also proves the tightened
 *   ensureTaskRow catch no longer swallows a NON-unique insert failure as "already exists".
 * @exports (test suite — no runtime exports)
 * @depends vitest, better-sqlite3, node:fs, node:os, node:path, ../evidence/db, ./evidence
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeDb, openDb } from "../evidence/db.js";
import type { AgentName } from "../shared/types.js";
import { type RecordDispatchInput, chatTaskId, recordChatDispatch } from "./evidence.js";

const TEMP_PREFIX: string = "zer0-chat-schema-gen-";
const SESSION_ID: string = "chat-1700000000000";

let tempRoot: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

describe("recordChatDispatch across schema generations (F1)", () => {
  it(
    "legacy tasks.status (NOT NULL, no default): still writes task + dispatch rows and returns the id",
    writesAgainstLegacyStatusSchema,
  );
  it(
    "current schema: writes the task at status='pending' plus the dispatch row",
    writesAgainstCurrentSchema,
  );
  it(
    "a NON-unique insertTask failure reaches the logging catch with the real constraint message",
    propagatesNonUniqueTaskFailure,
  );
});

// Acceptance #1: the exact deployed-legacy table shape (status NOT NULL, NO default). openDb's
// CREATE TABLE IF NOT EXISTS then skips it, so the legacy shape survives to schema_version 13.
async function writesAgainstLegacyStatusSchema(): Promise<void> {
  const env = newEnv();
  createTasksTable(env.dbPath, "status TEXT NOT NULL");

  const dispatchId = await recordChatDispatch(dispatchInput(env, { agent: "claude", turn: 2 }));

  expect(dispatchId).toBeDefined();
  const db = openDb(env.dbPath);
  try {
    const taskId = chatTaskId(SESSION_ID, 2, "claude");
    expect(db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE id = ?").get(taskId)).toEqual({
      c: 1,
    });
    expect(db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId)).toEqual({
      status: "pending",
    });
    expect(db.prepare("SELECT COUNT(*) AS c FROM dispatches").get()).toEqual({ c: 1 });
  } finally {
    closeDb(db);
  }
}

// Acceptance #2: on the CURRENT schema (openDb builds it), the explicit status literal still yields
// 'pending' and the write path is unchanged.
async function writesAgainstCurrentSchema(): Promise<void> {
  const env = newEnv();

  const dispatchId = await recordChatDispatch(dispatchInput(env, { agent: "codex", turn: 3 }));

  expect(dispatchId).toBeDefined();
  const db = openDb(env.dbPath);
  try {
    const taskId = chatTaskId(SESSION_ID, 3, "codex");
    expect(db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId)).toEqual({
      status: "pending",
    });
    expect(db.prepare("SELECT COUNT(*) AS c FROM dispatches").get()).toEqual({ c: 1 });
  } finally {
    closeDb(db);
  }
}

// Acceptance #3: a NOT NULL violation on a DIFFERENT column than status (insertTask never populates
// extra_required) is NOT a PK/unique "already exists" case — the tightened catch must propagate it so
// recordChatDispatch's own catch logs the REAL constraint message.
async function propagatesNonUniqueTaskFailure(): Promise<void> {
  const env = newEnv();
  createTasksTable(
    env.dbPath,
    "status TEXT NOT NULL DEFAULT 'pending'",
    "extra_required TEXT NOT NULL",
  );
  const stderr = captureStderr();

  const result = await recordChatDispatch(dispatchInput(env, { agent: "gemini", turn: 4 }));

  expect(result).toBeUndefined();
  const text = stderr();
  expect(text).toContain("NOT NULL constraint failed: tasks.extra_required");
  expect(text).not.toContain("already exists");
}

interface TestEnv {
  readonly dbPath: string;
  readonly blobRoot: string;
  readonly repoRoot: string;
}

function newEnv(): TestEnv {
  tempRoot = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  return {
    dbPath: join(tempRoot, "evidence.db"),
    blobRoot: join(tempRoot, "blobs"),
    repoRoot: tempRoot,
  };
}

// Pre-creates the `tasks` table with a caller-chosen status column (and optional extra columns) BEFORE
// openDb runs; its CREATE TABLE IF NOT EXISTS then leaves this shape untouched. FK to runs(id) resolves
// once openDb creates runs — SQLite permits a forward FK reference at table-create time.
function createTasksTable(dbPath: string, statusColumn: string, ...extraColumns: string[]): void {
  const columns = [
    "id TEXT PRIMARY KEY",
    "run_id TEXT NOT NULL REFERENCES runs(id)",
    "objective TEXT NOT NULL",
    "agent TEXT NOT NULL",
    statusColumn,
    "owned_files TEXT NOT NULL",
    "forbidden_files TEXT NOT NULL",
    "acceptance TEXT NOT NULL",
    "result TEXT",
    "head_commit TEXT",
    ...extraColumns,
  ].join(", ");
  const raw = new Database(dbPath);
  try {
    raw.exec(`CREATE TABLE tasks (${columns})`);
  } finally {
    raw.close();
  }
}

function captureStderr(): () => string {
  const chunks: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  });
  return () => chunks.join("");
}

function dispatchInput(
  env: TestEnv,
  overrides: Partial<RecordDispatchInput> & { agent?: AgentName } = {},
): RecordDispatchInput {
  return {
    dbPath: env.dbPath,
    blobRoot: env.blobRoot,
    sessionId: SESSION_ID,
    turn: 0,
    agent: "claude",
    promptContent: "default prompt",
    outputContent: "default output",
    stderrContent: "",
    durationMs: 100,
    exitCode: 0,
    repoRoot: env.repoRoot,
    ...overrides,
  };
}
