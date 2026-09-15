/**
 * @file src/chat/evidence.test.ts
 * @purpose Verifies chat evidence writes: dispatch rows + content-addressed blobs are
 *          persisted to a real temp DB, the dispatch id is returned, chat session/message
 *          rows are written, and the write-failure path swallows errors and returns undefined.
 * @exports (none)
 * @depends vitest, node:fs, node:os, node:path, ../evidence/db, ../shared/crypto, ./evidence
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeDb, openDb } from "../evidence/db.js";
import { blobPath, sha256 } from "../shared/crypto.js";
import type { AgentName } from "../shared/types.js";
import {
  type RecordDispatchInput,
  type RecordLaneTurnInput,
  recordChatDispatch,
  recordChatMessage,
  recordChatSession,
  recordLaneTurnEvidence,
} from "./evidence.js";

const TEMP_PREFIX: string = "zer0-chat-evidence-";
const SESSION_ID: string = "chat-1700000000000";
const CREATED_AT: string = "2026-05-28T00:00:00.000Z";

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

describe("recordChatDispatch", () => {
  it("writes prompt + output blobs to disk at their content-addressed paths", writesBlobsToDisk);
  it("inserts a dispatch row whose stored hashes match the written blobs", insertsDispatchRow);
  it("writes a stderr blob only when stderr content is non-empty", writesStderrBlob);
  it("leaves stderr_blob null when stderr content is empty", leavesStderrNull);
  it("is idempotent on retry: the duplicate identity does not create a second row", isIdempotent);
  it(
    "swallows write failures and returns undefined when the db path is unwritable",
    swallowsWriteFailure,
  );
});

describe("recordChatSession", () => {
  it("writes a chat_sessions row with its run row bootstrapped", writesSessionRow);
  it(
    "swallows failures and writes nothing when the run id is empty (validation breach)",
    swallowsSessionFailure,
  );
});

describe("recordChatMessage", () => {
  it(
    "writes the message text blob and a chat_messages row referencing its session",
    writesMessageRow,
  );
  it(
    "swallows failures and writes nothing when the session FK is unsatisfied",
    swallowsMessageFailure,
  );
  it(
    "persists the user turn's dispatchedAgents as a JSON column (U2e-c #8, acc.1)",
    writesDispatchedAgents,
  );
  it("leaves dispatched_agents NULL when the message carries none", nullDispatchedAgentsWhenAbsent);
});

describe("recordLaneTurnEvidence (B2-b1: the fused per-session writer)", () => {
  it(
    "writes the dispatch row AND the agent message row in ONE transaction (both ids, message → dispatch)",
    writesLaneTurnAtomically,
  );
  it(
    "ATOMICITY: a message-insert failure rolls back the dispatch — ZERO partial rows in BOTH tables",
    laneTurnFailureIsAtomic,
  );
});

async function writesBlobsToDisk(): Promise<void> {
  const env = newEnv();
  const input = dispatchInput(env, {
    promptContent: "the prompt body",
    outputContent: "the agent output",
  });

  const dispatchId = await recordChatDispatch(input);

  expect(dispatchId).toBeDefined();
  expectBlobOnDisk(env.blobRoot, "the prompt body");
  expectBlobOnDisk(env.blobRoot, "the agent output");
}

async function insertsDispatchRow(): Promise<void> {
  const env = newEnv();
  const dispatchId = await recordChatDispatch(
    dispatchInput(env, {
      agent: "codex",
      promptContent: "prompt-X",
      outputContent: "output-Y",
      exitCode: 0,
      durationMs: 4242,
    }),
  );

  const db = openDb(env.dbPath);
  try {
    const row = db
      .prepare(
        "SELECT id, agent, exit_code, duration_ms, stdout_blob, context_blob_hash, tokens_in, tokens_out FROM dispatches",
      )
      .get() as DispatchRow;
    expect(row.id).toBe(dispatchId);
    expect(row.agent).toBe("codex");
    expect(row.exit_code).toBe(0);
    expect(row.duration_ms).toBe(4242);
    expect(row.stdout_blob).toBe(sha256("output-Y"));
    expect(row.context_blob_hash).toBe(sha256("prompt-X"));
    // estimateTokens = ceil(len/4): "prompt-X"=8 → 2, "output-Y"=8 → 2.
    expect(row.tokens_in).toBe(2);
    expect(row.tokens_out).toBe(2);
  } finally {
    closeDb(db);
  }
}

async function writesStderrBlob(): Promise<void> {
  const env = newEnv();
  await recordChatDispatch(dispatchInput(env, { stderrContent: "boom on stderr" }));

  const db = openDb(env.dbPath);
  try {
    const row = db.prepare("SELECT stderr_blob FROM dispatches").get() as StderrRow;
    expect(row.stderr_blob).toBe(sha256("boom on stderr"));
    expectBlobOnDisk(env.blobRoot, "boom on stderr");
  } finally {
    closeDb(db);
  }
}

async function leavesStderrNull(): Promise<void> {
  const env = newEnv();
  await recordChatDispatch(dispatchInput(env, { stderrContent: "" }));

  const db = openDb(env.dbPath);
  try {
    const row = db.prepare("SELECT stderr_blob FROM dispatches").get() as StderrRow;
    expect(row.stderr_blob).toBeNull();
  } finally {
    closeDb(db);
  }
}

async function isIdempotent(): Promise<void> {
  const env = newEnv();
  const input = dispatchInput(env, { agent: "claude" });

  const firstId = await recordChatDispatch(input);
  const secondId = await recordChatDispatch(input);

  expect(firstId).toBeDefined();
  expect(secondId).toBe(firstId);
  const db = openDb(env.dbPath);
  try {
    expect(db.prepare("SELECT COUNT(*) AS count FROM dispatches").get()).toEqual({ count: 1 });
  } finally {
    closeDb(db);
  }
}

async function swallowsWriteFailure(): Promise<void> {
  // A regular file masquerading as the DB's parent directory makes openDb throw ConfigError.
  // recordChatDispatch must catch it, log a warning, and return undefined (evidence is
  // best-effort: a failed evidence write must never abort the chat turn).
  tempRoot = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const fileAsDir = join(tempRoot, "not-a-dir");
  writeFileSync(fileAsDir, "");
  const input: RecordDispatchInput = {
    ...bareDispatchInput(join(fileAsDir, "evidence.db"), join(tempRoot, "blobs"), tempRoot),
  };

  const result = await recordChatDispatch(input);

  expect(result).toBeUndefined();
}

async function writesSessionRow(): Promise<void> {
  const env = newEnv();
  await recordChatSession({
    ...sessionInput(env),
    runDir: join(env.repoRoot, ".council", "runs", SESSION_ID),
    lastAgent: "codex",
    summaryText: "rolling summary",
    summaryThroughTurn: 3,
  });

  const db = openDb(env.dbPath);
  try {
    const row = db
      .prepare(
        "SELECT id, run_id, default_agent, last_agent, summary_text, summary_through_turn FROM chat_sessions WHERE id = ?",
      )
      .get(SESSION_ID);
    expect(row).toEqual({
      id: SESSION_ID,
      run_id: `run-${SESSION_ID}`,
      default_agent: "claude",
      last_agent: "codex",
      summary_text: "rolling summary",
      summary_through_turn: 3,
    });
  } finally {
    closeDb(db);
  }
}

async function swallowsSessionFailure(): Promise<void> {
  const env = newEnv();
  await expect(recordChatSession({ ...sessionInput(env), runId: "" })).resolves.toBeUndefined();

  const db = openDb(env.dbPath);
  try {
    expect(db.prepare("SELECT COUNT(*) AS count FROM chat_sessions").get()).toEqual({ count: 0 });
  } finally {
    closeDb(db);
  }
}

async function writesMessageRow(): Promise<void> {
  const env = newEnv();
  await seedSession(env);
  await recordChatMessage({ ...messageInput(env), messageId: "msg-1", agent: "codex" });

  expectBlobOnDisk(env.blobRoot, "the message text");
  const db = openDb(env.dbPath);
  try {
    const row = db
      .prepare(
        "SELECT id, session_id, turn, role, agent, text_blob_hash, status, token_estimate, dispatch_id FROM chat_messages WHERE id = ?",
      )
      .get("msg-1");
    expect(row).toEqual({
      id: "msg-1",
      session_id: SESSION_ID,
      turn: 1,
      role: "agent",
      agent: "codex",
      text_blob_hash: sha256("the message text"),
      status: "completed",
      token_estimate: 7,
      dispatch_id: null,
    });
  } finally {
    closeDb(db);
  }
}

async function writesDispatchedAgents(): Promise<void> {
  const env = newEnv();
  await seedSession(env);
  await recordChatMessage({
    ...messageInput(env),
    messageId: "msg-da",
    role: "user",
    agent: "user",
    dispatchedAgents: ["claude", "codex", "gemini"],
  });
  const db = openDb(env.dbPath);
  try {
    const row = db
      .prepare("SELECT dispatched_agents FROM chat_messages WHERE id = ?")
      .get("msg-da") as { dispatched_agents: string | null } | undefined;
    expect(row?.dispatched_agents).toBe('["claude","codex","gemini"]'); // real sqlite JSON column (acc.1)
  } finally {
    closeDb(db);
  }
}

async function nullDispatchedAgentsWhenAbsent(): Promise<void> {
  const env = newEnv();
  await seedSession(env);
  await recordChatMessage({ ...messageInput(env), messageId: "msg-none" });
  const db = openDb(env.dbPath);
  try {
    const row = db
      .prepare("SELECT dispatched_agents FROM chat_messages WHERE id = ?")
      .get("msg-none") as { dispatched_agents: string | null } | undefined;
    expect(row?.dispatched_agents).toBeNull(); // old callers / non-user rows → NULL column
  } finally {
    closeDb(db);
  }
}

async function swallowsMessageFailure(): Promise<void> {
  const env = newEnv();
  // No session row seeded → chat_messages.session_id FK to chat_sessions(id) fails.
  await expect(
    recordChatMessage({ ...messageInput(env), sessionId: "chat-orphan", messageId: "msg-orphan" }),
  ).resolves.toBeUndefined();

  const db = openDb(env.dbPath);
  try {
    expect(db.prepare("SELECT COUNT(*) AS count FROM chat_messages").get()).toEqual({ count: 0 });
  } finally {
    closeDb(db);
  }
}

interface DispatchRow {
  readonly id: string;
  readonly agent: string;
  readonly exit_code: number;
  readonly duration_ms: number;
  readonly stdout_blob: string;
  readonly context_blob_hash: string | null;
  readonly tokens_in: number | null;
  readonly tokens_out: number | null;
}

interface StderrRow {
  readonly stderr_blob: string | null;
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

function bareDispatchInput(
  dbPath: string,
  blobRoot: string,
  repoRoot: string,
): RecordDispatchInput {
  return {
    dbPath,
    blobRoot,
    sessionId: SESSION_ID,
    turn: 0,
    agent: "claude",
    promptContent: "p",
    outputContent: "o",
    stderrContent: "",
    durationMs: 1,
    exitCode: 0,
    repoRoot,
  };
}

function dispatchInput(
  env: TestEnv,
  overrides: Partial<RecordDispatchInput> & { agent?: AgentName } = {},
): RecordDispatchInput {
  return {
    ...bareDispatchInput(env.dbPath, env.blobRoot, env.repoRoot),
    promptContent: "default prompt",
    outputContent: "default output",
    durationMs: 100,
    ...overrides,
  };
}

function sessionInput(env: TestEnv): Parameters<typeof recordChatSession>[0] {
  return {
    dbPath: env.dbPath,
    sessionId: SESSION_ID,
    runId: `run-${SESSION_ID}`,
    repoRoot: env.repoRoot,
    runDir: env.repoRoot,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    defaultAgent: "claude",
    lastAgent: null,
    summaryText: "",
    summaryThroughTurn: 0,
  };
}

function messageInput(env: TestEnv): Parameters<typeof recordChatMessage>[0] {
  return {
    dbPath: env.dbPath,
    blobRoot: env.blobRoot,
    sessionId: SESSION_ID,
    messageId: "msg-default",
    turn: 1,
    role: "agent",
    agent: "codex",
    text: "the message text",
    createdAt: CREATED_AT,
    status: "completed",
    tokenEstimate: 7,
  };
}

async function seedSession(env: TestEnv): Promise<void> {
  await recordChatSession(sessionInput(env));
}

function expectBlobOnDisk(blobRoot: string, content: string): void {
  const hash = sha256(content);
  const path = blobPath(blobRoot, hash);
  expect(existsSync(path)).toBe(true);
  expect(readFileSync(path, "utf8")).toBe(content);
}

function laneTurnInput(
  env: TestEnv,
  overrides: Partial<RecordLaneTurnInput> = {},
): RecordLaneTurnInput {
  return {
    dbPath: env.dbPath,
    blobRoot: env.blobRoot,
    sessionId: SESSION_ID,
    turn: 1,
    agent: "claude",
    promptContent: "lane prompt",
    outputContent: "lane output",
    stderrContent: "",
    durationMs: 50,
    exitCode: 0,
    repoRoot: env.repoRoot,
    messageId: "msg-lane-1",
    messageCreatedAt: CREATED_AT,
    messageStatus: "completed",
    ...overrides,
  };
}

interface LaneDispatchRow {
  readonly id: string;
  readonly agent: string;
  readonly stdout_blob: string;
}
interface LaneMessageRow {
  readonly id: string;
  readonly dispatch_id: string;
  readonly text_blob_hash: string;
}

async function writesLaneTurnAtomically(): Promise<void> {
  const env = newEnv();
  await seedSession(env); // the chat_messages session FK must be satisfied for the message row
  const result = await recordLaneTurnEvidence(
    laneTurnInput(env, { agent: "codex", outputContent: "the reply" }),
  );

  expect(result.dispatchId).toBeDefined();
  expect(result.messageId).toBe("msg-lane-1");
  const db = openDb(env.dbPath);
  try {
    const dispatch = db
      .prepare("SELECT id, agent, stdout_blob FROM dispatches")
      .get() as LaneDispatchRow;
    const message = db
      .prepare("SELECT id, dispatch_id, text_blob_hash FROM chat_messages WHERE id = ?")
      .get("msg-lane-1") as LaneMessageRow;
    expect(dispatch.agent).toBe("codex");
    expect(message.dispatch_id).toBe(dispatch.id); // message references the SAME-transaction dispatch
    expect(message.text_blob_hash).toBe(dispatch.stdout_blob); // output IS the message text (one blob)
  } finally {
    closeDb(db);
  }
}

async function laneTurnFailureIsAtomic(): Promise<void> {
  const env = newEnv();
  // NO seedSession → the chat_messages session FK is UNSATISFIED, so the message INSERT throws mid-
  // transaction. The dispatch row inserted earlier in the SAME transaction must roll back with it (zero
  // partial rows) — the failure the old recordChatDispatch→recordChatMessage pair could NOT prevent
  // (separate handles: the dispatch committed before the message failed).
  const result = await recordLaneTurnEvidence(laneTurnInput(env));

  expect(result.dispatchId).toBeUndefined(); // best-effort: the whole record is swallowed
  const db = openDb(env.dbPath);
  try {
    expect(db.prepare("SELECT COUNT(*) AS count FROM dispatches").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM chat_messages").get()).toEqual({ count: 0 });
  } finally {
    closeDb(db);
  }
}
