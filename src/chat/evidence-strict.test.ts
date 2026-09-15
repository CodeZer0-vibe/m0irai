import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { closeDb, openDb, openLaneStateDb } from "../evidence/db.js";
import { createQueries } from "../evidence/queries.js";
import { ensureRunRow } from "../evidence/runs-bootstrap.js";
import { getSeqForMessage } from "../memory/ledger.js";
import { blobPath, sha256 } from "../shared/crypto.js";
import {
  chatCommandHash,
  chatRunId,
  chatTaskId,
  persistDebateTurn,
  recordChatSession,
} from "./evidence.js";
import type { PersistDebateTurnInput } from "./evidence.js";
import { initCarrierRuntime, resetCarrierRuntime } from "./lane-transport.js";

const TEMP_PREFIX: string = "zer0-chat-evidence-strict-";
const SESSION_ID: string = "chat-1700000000000";
const CREATED_AT: string = "2026-06-03T00:00:00.000Z";

let tempRoot: string | undefined;

afterEach(() => {
  // The runtime holds an open handle on a file inside tempRoot — release BEFORE rmSync (Windows EBUSY).
  resetCarrierRuntime();
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

describe("persistDebateTurn", () => {
  it("persists round 1 and round 2 rows for the same session turn and agent", coexists);
  it(
    "throws on a DB write failure after writing the prompt blob and file failure record",
    failsStrict,
  );
});

async function coexists(): Promise<void> {
  const env = newEnv();
  await seedSession(env);

  const first = await persistDebateTurn(turnInput(env, 1));
  const second = await persistDebateTurn(turnInput(env, 2));

  expect(first.dispatchId).not.toBe(second.dispatchId);
  const db = openDb(env.dbPath);
  try {
    expect(countRows(db, "dispatches")).toBe(2);
    expect(countRows(db, "chat_messages")).toBe(2);
    expect(countRows(db, "chat_working_sets")).toBe(2);
    expect(rounds(db, "chat_messages")).toEqual([1, 2]);
    expect(rounds(db, "chat_working_sets")).toEqual([1, 2]);
  } finally {
    closeDb(db);
  }
}

async function failsStrict(): Promise<void> {
  const env = newEnv();
  const input = turnInput(env, 1, { promptContent: "prompt before missing session" });
  const expectedHash = sha256(input.promptContent);

  await expect(persistDebateTurn(input)).rejects.toThrow();

  expect(existsSync(blobPath(env.blobRoot, expectedHash))).toBe(true);
  const failureLog = readFileSync(
    join(env.runDir, "evidence-failures", "strict-debate-failures.jsonl"),
    "utf8",
  );
  expect(failureLog).toContain('"stage":"working-set"');
  expect(failureLog).toContain(`"contextBlobHash":"${expectedHash}"`);
  const db = openDb(env.dbPath);
  try {
    expect(countRows(db, "dispatches")).toBe(0);
    expect(countRows(db, "chat_messages")).toBe(0);
    expect(countRows(db, "chat_working_sets")).toBe(0);
  } finally {
    closeDb(db);
  }
}

interface TestEnv {
  readonly dbPath: string;
  readonly blobRoot: string;
  readonly runDir: string;
}

interface CountRow {
  readonly count: number;
}

interface RoundRow {
  readonly round: number;
}

function newEnv(): TestEnv {
  tempRoot = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  return {
    dbPath: join(tempRoot, "evidence.db"),
    blobRoot: join(tempRoot, "blobs"),
    runDir: join(tempRoot, ".council", "runs", SESSION_ID),
  };
}

async function seedSession(env: TestEnv): Promise<void> {
  await recordChatSession({
    dbPath: env.dbPath,
    sessionId: SESSION_ID,
    runId: `run-${SESSION_ID}`,
    repoRoot: tempRoot ?? env.runDir,
    runDir: env.runDir,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    defaultAgent: "claude",
    lastAgent: null,
    summaryText: "",
    summaryThroughTurn: 0,
  });
}

function turnInput(
  env: TestEnv,
  round: number,
  overrides: Partial<PersistDebateTurnInput> = {},
): PersistDebateTurnInput {
  return {
    dbPath: env.dbPath,
    blobRoot: env.blobRoot,
    runDir: env.runDir,
    sessionId: SESSION_ID,
    turn: 4,
    round,
    agent: "codex",
    promptContent: `prompt r${String(round)}`,
    outputContent: `output r${String(round)}`,
    stderrContent: "",
    durationMs: 100 + round,
    exitCode: 0,
    messageId: `msg-r${String(round)}`,
    messageCreatedAt: CREATED_AT,
    workingSetId: `ws-r${String(round)}`,
    workingSetCreatedAt: CREATED_AT,
    peerRefs: [],
    outcome: "ok",
    workingSetTokenEstimate: 3,
    ...overrides,
  };
}

function countRows(db: ReturnType<typeof openDb>, tableName: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as CountRow;
  return row.count;
}

function rounds(db: ReturnType<typeof openDb>, tableName: string): readonly number[] {
  const rows = db.prepare(`SELECT round FROM ${tableName} ORDER BY round`).all() as RoundRow[];
  return rows.map((row) => row.round);
}

describe("round-aware evidence identity helpers", () => {
  it("keep old identities when round is absent and add round when present", () => {
    expect(chatTaskId(SESSION_ID, 4, "codex")).toBe(`BUILD-${SESSION_ID}-4-codex`);
    expect(chatTaskId(SESSION_ID, 4, "codex", 2)).toBe(`BUILD-${SESSION_ID}-4-r2-codex`);
    expect(chatCommandHash("codex", 4)).toBe(sha256("chat-codex-4"));
    expect(chatCommandHash("codex", 4, 2)).toBe(sha256("chat-codex-4-r2"));
  });
});

// The tightened ensureStrictTaskRow catch (mirrors evidence.ts:223-237): a genuine PK/UNIQUE collision on the
// task row is the ONLY benign case (idempotent retry) and stays silent; any OTHER constraint breach must
// surface through persistPreparedRows' failure record + rethrow, not be masked as an "already exists" no-op.
describe("persistDebateTurn — ensureStrictTaskRow surfaces non-unique task failures", () => {
  it("a pre-existing task row (PK collision) is swallowed — the retry still persists the turn", async () => {
    const env = newEnv();
    await seedSession(env);
    seedExistingTaskRow(env, 1);

    await expect(persistDebateTurn(turnInput(env, 1))).resolves.toBeDefined();

    const db = openDb(env.dbPath);
    try {
      expect(countRows(db, "dispatches")).toBe(1);
      expect(countRows(db, "chat_messages")).toBe(1);
    } finally {
      closeDb(db);
    }
  });

  it("a NON-unique insertTask failure surfaces the REAL constraint message (never 'already exists')", async () => {
    const env = newEnv();
    createTasksTableWithExtra(env.dbPath);

    await expect(persistDebateTurn(turnInput(env, 1))).rejects.toThrow(
      /NOT NULL constraint failed: tasks\.extra_required/,
    );

    const failureLog = readFileSync(
      join(env.runDir, "evidence-failures", "strict-debate-failures.jsonl"),
      "utf8",
    );
    expect(failureLog).toContain("tasks.extra_required");
    expect(failureLog).not.toContain("already exists");
  });
});

// Wave-seal B1 reopen falsifiers: a debate turn is a VISIBLE room message — with the carrier runtime
// present on the same db it must mint its ledger seq ATOMICALLY with the message row (§5/F-16), and
// with the runtime absent/foreign the strict path must not touch lane state at all.
describe("persistDebateTurn — carrier ledger minting (wave-seal B1 reopen)", () => {
  it("mints ledger seqs in room order when the carrier runtime matches the db", mintsInOrder);
  it(
    "rolls back the WHOLE turn when the mint fails (ghost project) — both or neither",
    ghostRollsBack,
  );
  it("without a carrier runtime the db stays lane-free (byte-identity)", noRuntimeNoLaneState);
  it("a runtime on a DIFFERENT db never mints into the strict db", foreignRuntimeSkips);
});

async function mintsInOrder(): Promise<void> {
  const env = newEnv();
  await seedSession(env);
  bootCarrier(env, "p1");
  seedProjectRow(env.dbPath, "p1");

  await persistDebateTurn(turnInput(env, 1));
  await persistDebateTurn(turnInput(env, 2));

  const db = openLaneStateDb(env.dbPath);
  try {
    expect(countRows(db, "chat_messages")).toBe(2);
    expect(getSeqForMessage(db, "p1", "msg-r1")).toBe(1); // room order = persistence order
    expect(getSeqForMessage(db, "p1", "msg-r2")).toBe(2);
  } finally {
    closeDb(db);
  }
}

async function ghostRollsBack(): Promise<void> {
  const env = newEnv();
  await seedSession(env);
  bootCarrier(env, "p-ghost"); // no projects row -> the mint FK-fails inside the strict transaction

  await expect(persistDebateTurn(turnInput(env, 1))).rejects.toThrow(/FOREIGN KEY/);

  const failureLog = readFileSync(
    join(env.runDir, "evidence-failures", "strict-debate-failures.jsonl"),
    "utf8",
  );
  expect(failureLog).toContain('"stage":"ledger-mint"');
  const db = openLaneStateDb(env.dbPath);
  try {
    // Atomicity: the message must NOT be visible-but-unminted — the exact defect class this kills.
    expect(countRows(db, "chat_messages")).toBe(0);
    expect(countRows(db, "dispatches")).toBe(0);
    expect(countRows(db, "chat_working_sets")).toBe(0);
    expect(countRows(db, "ledger_seq")).toBe(0);
  } finally {
    closeDb(db);
  }
}

async function noRuntimeNoLaneState(): Promise<void> {
  const env = newEnv();
  await seedSession(env);

  await persistDebateTurn(turnInput(env, 1));

  const db = openDb(env.dbPath);
  try {
    expect(countRows(db, "chat_messages")).toBe(1);
    // Byte-identity: the flag-off db is never lane-migrated — no ledger_seq table exists at all.
    expect(hasTable(db, "ledger_seq")).toBe(false);
  } finally {
    closeDb(db);
  }
}

async function foreignRuntimeSkips(): Promise<void> {
  const env = newEnv();
  await seedSession(env);
  const otherDbPath = join(tempRoot ?? env.runDir, "other-project.db");
  initCarrierRuntime({
    projectId: "p1",
    dbPath: otherDbPath,
    repoRoot: tempRoot ?? env.runDir,
    cwd: tempRoot ?? env.runDir,
  });

  await persistDebateTurn(turnInput(env, 1));

  const db = openDb(env.dbPath);
  try {
    expect(countRows(db, "chat_messages")).toBe(1);
    expect(hasTable(db, "ledger_seq")).toBe(false); // the strict db was never lane-touched
  } finally {
    closeDb(db);
  }
  const other = openLaneStateDb(otherDbPath);
  try {
    expect(countRows(other, "ledger_seq")).toBe(0); // and nothing minted into the foreign db either
  } finally {
    closeDb(other);
  }
}

// Lane-migrates env.dbPath ({14,15,16}) and points the runtime at it — the production precondition for
// the strict mint gate (the cockpit's carrier boot always lane-opens the db before any debate runs).
function bootCarrier(env: TestEnv, projectId: string): void {
  initCarrierRuntime({
    projectId,
    dbPath: env.dbPath,
    repoRoot: tempRoot ?? env.runDir,
    cwd: tempRoot ?? env.runDir,
  });
}

function seedProjectRow(dbPath: string, projectId: string): void {
  const db = openLaneStateDb(dbPath);
  try {
    db.prepare(
      "INSERT INTO projects(project_id, canonical_root, git_common_dir, created_at) VALUES (?,?,?,?)",
    ).run(projectId, "C:/tmp/p", "C:/tmp/p/.git", CREATED_AT);
  } finally {
    closeDb(db);
  }
}

function hasTable(db: ReturnType<typeof openDb>, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return row !== undefined;
}

// Pre-inserts the run + task rows so persistDebateTurn's ensureStrictTaskRow hits a PK collision (the benign
// idempotent-retry path) while the rest of the turn writes fresh.
function seedExistingTaskRow(env: TestEnv, round: number): void {
  const db = openDb(env.dbPath);
  try {
    ensureRunRow(db, chatRunId(SESSION_ID));
    createQueries(db).insertTask({
      id: chatTaskId(SESSION_ID, 4, "codex", round),
      runId: chatRunId(SESSION_ID),
      objective: "pre-existing row (idempotent-retry probe)",
      agent: "codex",
      ownedFiles: [],
      forbiddenFiles: [],
      acceptance: [],
    });
  } finally {
    closeDb(db);
  }
}

// Pre-creates the tasks table with an extra NOT NULL column insertTask never populates, so the task insert
// fails with a NON-unique NOT NULL breach — the tightened catch must propagate it (mirrors evidence.schema-
// generations.test.ts). openDb's CREATE TABLE IF NOT EXISTS then leaves this deployed-legacy shape untouched.
function createTasksTableWithExtra(dbPath: string): void {
  const columns = [
    "id TEXT PRIMARY KEY",
    "run_id TEXT NOT NULL REFERENCES runs(id)",
    "objective TEXT NOT NULL",
    "agent TEXT NOT NULL",
    "status TEXT NOT NULL DEFAULT 'pending'",
    "owned_files TEXT NOT NULL",
    "forbidden_files TEXT NOT NULL",
    "acceptance TEXT NOT NULL",
    "result TEXT",
    "head_commit TEXT",
    "extra_required TEXT NOT NULL",
  ].join(", ");
  const raw = new Database(dbPath);
  try {
    raw.exec(`CREATE TABLE tasks (${columns})`);
  } finally {
    raw.close();
  }
}
