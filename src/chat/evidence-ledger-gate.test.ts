/**
 * @file src/chat/evidence-ledger-gate.test.ts
 * @purpose Fix-round wave-4 fold #4 falsifiers: recordChatMessage must mint a shared ledger seq ONLY
 *   for ledger-conversation roles (user/agent) -- an error/system row lands durably in chat_messages
 *   but must never ride the carrier's ledger-delta injection into a sibling lane's or a later turn's
 *   live prompt (traced: evidence.ts's unconditional viaLedger mint -> ledger.ts's role-blind
 *   readTailCandidates -> lane-carrier.ts's composeCarrierDelta -> headless-carrier.ts's
 *   projectBodyReader, which resolved ANY minted seq with author:agent regardless of role). Real
 *   sqlite via openLaneStateDb, a real carrier runtime via initCarrierRuntime, real recordChatMessage
 *   writes, real composeCarrierPrompt reads -- zero mocks. Setup mirrors the proven
 *   headless-carrier.test.ts "wave-seal B1" pattern (same helpers, same sequencing).
 * @exports (test suite)
 * @depends node:fs/promises, node:os, node:path, vitest, ../evidence/blobs, ../evidence/db,
 *   ../memory/ledger, ./evidence, ./evidence-identity, ./lane-carrier, ./lane-transport, ./types
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getBlobSync } from "../evidence/blobs.js";
import { type Db, closeDb, openDb, openLaneStateDb } from "../evidence/db.js";
import { currentLedgerSeq, getSeqForMessage } from "../memory/ledger.js";
import { chatRunId } from "./evidence-identity.js";
import {
  type RecordLaneTurnInput,
  recordChatMessage,
  recordChatSession,
  recordLaneTurnEvidence,
} from "./evidence.js";
import { composeCarrierPrompt } from "./lane-carrier.js";
import { initCarrierRuntime, resetCarrierRuntime } from "./lane-transport.js";
import type { ChatMessageRole } from "./types.js";

// The fused writer's own-handle path opens `openDb`; its carrier path rides `carrier.db` and opens NOTHING.
// Wrap openDb as a passthrough spy (real behavior preserved) so the "@all one-open" tests can assert the
// carrier write opens ZERO own handles, with a no-carrier control proving the spy fires on a real open.
// openLaneStateDb / closeDb stay the actual implementations (initCarrierRuntime + the readers need them real).
vi.mock("../evidence/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../evidence/db.js")>();
  return { ...actual, openDb: vi.fn(actual.openDb) };
});

const PROJECT = "p1";
const SESSION_ID = "chat-gate";
const BINDING = { adapterPkg: "pkg", adapterVersion: "1", cwd: "C:/repo" };
const dirs: string[] = [];
const savedFlags = { memory: process.env.ZER0_MEMORY, resume: process.env.ZER0_NATIVE_RESUME };

beforeEach(() => {
  process.env.ZER0_MEMORY = "1";
  process.env.ZER0_NATIVE_RESUME = "1";
});

afterEach(async () => {
  resetCarrierRuntime();
  restoreFlag("ZER0_MEMORY", savedFlags.memory);
  restoreFlag("ZER0_NATIVE_RESUME", savedFlags.resume);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function restoreFlag(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

interface Env {
  readonly dbPath: string;
  readonly blobRoot: string;
  readonly repoRoot: string;
}

async function makeEnv(): Promise<Env> {
  const root = await mkdtemp(path.join(tmpdir(), "evidence-ledger-gate-"));
  dirs.push(root);
  const blobRoot = path.join(root, "blobs");
  await mkdir(blobRoot, { recursive: true });
  const dbPath = path.join(root, "evidence.db");
  const now = new Date().toISOString();
  await recordChatSession({
    dbPath,
    sessionId: SESSION_ID,
    runId: chatRunId(SESSION_ID),
    repoRoot: root,
    runDir: root,
    createdAt: now,
    updatedAt: now,
    defaultAgent: "claude",
    lastAgent: null,
    summaryText: "",
    summaryThroughTurn: 0,
  });
  const db = openLaneStateDb(dbPath);
  db.prepare(
    "INSERT OR IGNORE INTO projects(project_id, canonical_root, git_common_dir, created_at) VALUES (?,?,?,?)",
  ).run(PROJECT, root, path.join(root, ".git"), now);
  closeDb(db);
  initCarrierRuntime({ projectId: PROJECT, dbPath, repoRoot: root, cwd: root });
  return { dbPath, blobRoot, repoRoot: root };
}

function write(
  env: Env,
  messageId: string,
  role: ChatMessageRole,
  text: string,
): Promise<string | undefined> {
  return recordChatMessage({
    dbPath: env.dbPath,
    blobRoot: env.blobRoot,
    sessionId: SESSION_ID,
    messageId,
    turn: 1,
    role,
    agent: role === "user" ? "user" : "claude",
    text,
    createdAt: new Date().toISOString(),
    status: "completed",
    tokenEstimate: 3,
  });
}

// Real DB-backed reader mirroring headless-carrier.ts's own (unexported) projectBodyReader fallback
// branch -- same table, same query, same author-resolution rule. Not a fabricated double: it proves
// what a REAL carrier consumer sees when it resolves a minted seq's body.
function dbBodyReader(db: Db, blobRoot: string) {
  return (messageId: string): { author: string; body: string } => {
    const row = db
      .prepare("SELECT role, agent, text_blob_hash AS hash FROM chat_messages WHERE id = ? LIMIT 1")
      .get(messageId) as { role: string; agent: string; hash: string } | undefined;
    if (row === undefined) throw new Error(`missing body for ${messageId}`);
    return {
      author: row.role === "user" ? "operator" : row.agent,
      body: getBlobSync({ rootDir: blobRoot }, row.hash).toString("utf8"),
    };
  };
}

function carrierPromptText(db: Db, env: Env): { text: string; deliveredSeqs: readonly number[] } {
  return composeCarrierPrompt({
    agent: "codex",
    turn: 1,
    binding: BINDING,
    db,
    projectId: PROJECT,
    readBody: dbBodyReader(db, env.blobRoot),
    setup: "S",
    operatorMessage: "O",
  });
}

it("a role='error' write mints NO ledger seq, but the chat_messages row still lands durably (AC1)", async () => {
  const env = await makeEnv();
  const id = await write(env, "err-1", "error", "review-delta capture failed at stage persist");
  expect(id).toBe("err-1");
  const db = openLaneStateDb(env.dbPath);
  try {
    expect(getSeqForMessage(db, PROJECT, "err-1")).toBeUndefined();
    expect(db.prepare("SELECT role FROM chat_messages WHERE id = ?").get("err-1")).toEqual({
      role: "error",
    });
  } finally {
    closeDb(db);
  }
});

it("an unminted error row never surfaces in a composed carrier delta (AC2)", async () => {
  const env = await makeEnv();
  await write(env, "err-2", "error", "SECRET-CAPTURE-FAILURE-TEXT");
  const db = openLaneStateDb(env.dbPath);
  try {
    const prompt = carrierPromptText(db, env);
    expect(prompt.text).not.toContain("SECRET-CAPTURE-FAILURE-TEXT");
    expect(prompt.deliveredSeqs).toEqual([]);
  } finally {
    closeDb(db);
  }
});

it("no overcorrection: agent and user writes still mint and still appear in the delta (AC3)", async () => {
  const env = await makeEnv();
  await write(env, "agent-1", "agent", "AGENT-REPLY-TEXT");
  await write(env, "user-1", "user", "USER-PROMPT-TEXT");
  const db = openLaneStateDb(env.dbPath);
  try {
    expect(getSeqForMessage(db, PROJECT, "agent-1")).toBe(1);
    expect(getSeqForMessage(db, PROJECT, "user-1")).toBe(2);
    const prompt = carrierPromptText(db, env);
    expect(prompt.text).toContain("AGENT-REPLY-TEXT");
    expect(prompt.text).toContain("USER-PROMPT-TEXT");
  } finally {
    closeDb(db);
  }
});

it("role='system' is excluded by the same gate (AC4)", async () => {
  const env = await makeEnv();
  await write(env, "sys-1", "system", "SYSTEM-NOTICE-TEXT");
  const db = openLaneStateDb(env.dbPath);
  try {
    expect(getSeqForMessage(db, PROJECT, "sys-1")).toBeUndefined();
    expect(carrierPromptText(db, env).text).not.toContain("SYSTEM-NOTICE-TEXT");
  } finally {
    closeDb(db);
  }
});

// ─── B2-b1 SEAL: the fused per-session writer on the CARRIER path (review BLOCK 1 + BLOCK 2) ──────────────
// The evidence.test.ts atomicity test never initializes a carrier, so its recordLaneTurnEvidence takes the
// OWN-handle path where the ledger mint is skipped (`ledger` undefined) — the carrier ledger branch was dead
// in tests. These exercise it live: recordLaneTurnEvidence with `carrier.dbPath === input.dbPath` so
// `viaLedger` is true, the write rides carrier.db, and the mint runs INSIDE the same transaction.

function laneTurnInput(
  env: Env,
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
    messageCreatedAt: new Date().toISOString(),
    messageStatus: "completed",
    ...overrides,
  };
}

function dispatchCount(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS count FROM dispatches").get() as { count: number }).count;
}

function messageCount(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS count FROM chat_messages").get() as { count: number })
    .count;
}

it("carrier writer: a successful lane turn mints a ledger seq atomically with dispatch + message (BLOCK 1)", async () => {
  const env = await makeEnv();
  const result = await recordLaneTurnEvidence(
    laneTurnInput(env, { agent: "codex", messageId: "msg-lane-ok", outputContent: "the reply" }),
  );
  expect(result.dispatchId).toBeDefined();
  expect(result.messageId).toBe("msg-lane-ok");
  const db = openLaneStateDb(env.dbPath);
  try {
    // the seq was minted INSIDE the same transaction as the dispatch + message rows (first mint → seq 1)
    expect(getSeqForMessage(db, PROJECT, "msg-lane-ok")).toBe(1);
    const dispatch = db.prepare("SELECT id, agent FROM dispatches").get() as {
      id: string;
      agent: string;
    };
    const message = db
      .prepare("SELECT dispatch_id FROM chat_messages WHERE id = ?")
      .get("msg-lane-ok") as { dispatch_id: string };
    expect(dispatch.agent).toBe("codex");
    expect(message.dispatch_id).toBe(dispatch.id); // message references the SAME-transaction dispatch
  } finally {
    closeDb(db);
  }
});

it("carrier writer: a mid-transaction failure leaves ZERO dispatch/message/ledger for a concurrent reader (BLOCK 1 + zero-partial)", async () => {
  const env = await makeEnv();
  const reader = openLaneStateDb(env.dbPath); // a concurrent reader opened BEFORE the write
  try {
    expect(dispatchCount(reader)).toBe(0); // nothing written yet
    // An ORPHAN session id (no chat_sessions row) makes the message-row FK fail AFTER the dispatch insert,
    // mid-transaction — so the dispatch rolls back and the ledger stays empty (the failure PRECEDES the mint;
    // the mint-REACHING rollback is proven by the next test). This one proves the concurrent-reader zero-partial.
    const result = await recordLaneTurnEvidence(
      laneTurnInput(env, { sessionId: "chat-orphan-lane", messageId: "msg-orphan" }),
    );
    expect(result.dispatchId).toBeUndefined();
    // The concurrent reader observes NO dispatch-only partial: zero dispatch, zero message, zero ledger seq.
    expect(dispatchCount(reader)).toBe(0);
    expect(messageCount(reader)).toBe(0);
    expect(getSeqForMessage(reader, PROJECT, "msg-orphan")).toBeUndefined();
    expect(currentLedgerSeq(reader, PROJECT)).toBe(0); // the failed turn minted nothing
  } finally {
    closeDb(reader);
  }
});

it("carrier ledger mint rollback: an FK failure AT the mint rolls back dispatch + message + ledger_seq together (BLOCK)", async () => {
  const env = await makeEnv(); // seeds SESSION_ID + projects(PROJECT); makeEnv also inits carrier(PROJECT)
  // Re-point the carrier at a projectId with NO projects row. dispatch + message insert fine (the session FK
  // holds), then mintSeqInTransaction's INSERT into ledger_seq(project_id → projects) THROWS an FK breach — the
  // failure lands AT the mint, AFTER dispatch + message, inside the SAME transaction (the message-FK test above
  // never reaches the mint). Proves the mint's rollback drags the whole turn-record with it.
  resetCarrierRuntime();
  initCarrierRuntime({
    projectId: "no-such-project",
    dbPath: env.dbPath,
    repoRoot: env.repoRoot,
    cwd: env.repoRoot,
  });
  const result = await recordLaneTurnEvidence(laneTurnInput(env, { messageId: "msg-mint-fk" }));
  expect(result.dispatchId).toBeUndefined(); // the whole record rolled back BECAUSE the mint threw
  const db = openLaneStateDb(env.dbPath);
  try {
    expect(dispatchCount(db)).toBe(0); // dispatch (inserted BEFORE the mint) rolled back WITH the mint failure
    expect(messageCount(db)).toBe(0); // message (inserted before the mint) rolled back too
    expect(getSeqForMessage(db, "no-such-project", "msg-mint-fk")).toBeUndefined(); // no ledger seq minted
  } finally {
    closeDb(db);
  }
});

it("carrier-writer-zero-extra-open: the writer rides carrier.db, opening ZERO extra db handles (BLOCK 2)", async () => {
  const env = await makeEnv();
  vi.mocked(openDb).mockClear(); // makeEnv's recordChatSession opened one own handle; reset before the write
  const result = await recordLaneTurnEvidence(laneTurnInput(env, { messageId: "msg-open-0" }));
  expect(result.dispatchId).toBeDefined();
  expect(vi.mocked(openDb)).not.toHaveBeenCalled(); // rode carrier.db — no second handle inside the boundary
});

it("without the carrier the writer opens its OWN handle — the one-open spy is not a no-op (BLOCK 2 control)", async () => {
  const env = await makeEnv();
  resetCarrierRuntime(); // drop the carrier → the writer takes the own-handle path
  vi.mocked(openDb).mockClear();
  const result = await recordLaneTurnEvidence(laneTurnInput(env, { messageId: "msg-own-1" }));
  expect(result.dispatchId).toBeDefined();
  expect(vi.mocked(openDb)).toHaveBeenCalled(); // opened its own handle — the spy DOES fire on a real open
});

it("reader smoke: an independent reader sees the whole committed turn-record after a successful carrier write (BLOCK 2)", async () => {
  const env = await makeEnv();
  const result = await recordLaneTurnEvidence(
    laneTurnInput(env, { agent: "codex", messageId: "msg-smoke" }),
  );
  expect(result.dispatchId).toBeDefined();
  // The review named a reader that opens the DB INDEPENDENTLY of the writer and reads dispatches by run_id.
  // That reader used to be the V1 inspector (`zer0 inspect`, removed with the observability surface in m0irai
  // 3.7); the smoke now reads the same rows through its own handle — the dispatch row must be visible to any
  // second connection, which is what "committed" means here.
  const reader = openDb(env.dbPath);
  try {
    const row = reader
      .prepare(
        "SELECT COUNT(*) AS n FROM dispatches d JOIN tasks t ON t.id = d.task_id WHERE t.run_id = ?",
      )
      .get(chatRunId(SESSION_ID)) as { n: number };
    expect(row.n).toBe(1);
  } finally {
    closeDb(reader);
  }
});

it("CONCERN 4: a rollback returns the ORIGINAL FK error so surfacing classifies schema-drift, not unknown", async () => {
  const env = await makeEnv();
  // orphan session → the message-row FK fails mid-transaction; the writer swallows it and returns the error.
  const result = await recordLaneTurnEvidence(
    laneTurnInput(env, { sessionId: "chat-orphan-c4", messageId: "msg-c4" }),
  );
  expect(result.dispatchId).toBeUndefined();
  const err = result.error as { code?: string; message?: string } | undefined;
  // The FK metadata is preserved (code OR message) — exactly what evidenceFailureReason keys on to return
  // 'schema-drift' (proven end-to-end by evidence-failure.test.ts's SQLITE_CONSTRAINT_FOREIGNKEY case).
  const fkShaped =
    err?.code === "SQLITE_CONSTRAINT_FOREIGNKEY" || /FOREIGN KEY/i.test(err?.message ?? "");
  expect(fkShaped).toBe(true);
});
