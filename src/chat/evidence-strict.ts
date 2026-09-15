/**
 * @file src/chat/evidence-strict.ts
 * @purpose Strict debate evidence persistence with pre-launch prompt snapshots; with the carrier
 *   runtime present, the debate message row and its ledger seq mint in one transaction (MT7 F-16).
 * @exports persistDebateTurn, PersistDebateTurnInput, PersistDebateTurnResult
 * @depends node:fs/promises, node:path, zod, ../evidence/blobs, ../evidence/db, ../evidence/queries, ../evidence/runs-bootstrap, ../memory/ledger, ./evidence-identity, ./lane-transport, ./prompt-budgeter, ./types
 */
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { type BlobStore, putBlob } from "../evidence/blobs.js";
import { type Db, closeDb, openDb } from "../evidence/db.js";
import { type Queries, createQueries } from "../evidence/queries.js";
import { ensureRunRow } from "../evidence/runs-bootstrap.js";
import { mintSeq } from "../memory/ledger.js";
import type { TaskId } from "../shared/types.js";
import { chatCommandHash, chatRunId, chatTaskId } from "./evidence-identity.js";
import { persistenceOwnerFor } from "./lane-transport.js";
import { estimatePromptTokens } from "./prompt-budgeter.js";
import { ChatPeerRefsSchema, ChatWorkingSetOutcomeSchema } from "./types.js";
import type { AgentName, ChatPeerRef, ChatWorkingSetOutcome } from "./types.js";

const AGENT_NAMES: readonly ["claude", "codex", "gemini"] = ["claude", "codex", "gemini"];
const MESSAGE_STATUSES = ["completed", "failed", "cancelled"] as const;
const FAILURE_DIR: string = "evidence-failures";
const FAILURE_FILE: string = "strict-debate-failures.jsonl";

// The ONLY benign insertTask failure: the task row already exists (idempotent retry). Mirrors evidence.ts's
// TASK_EXISTS_CODES (evidence.ts:26-29) — the SAME defect class the evidence fix killed. better-sqlite3
// surfaces the PK/unique collision under these codes; any OTHER constraint breach must propagate to
// persistPreparedRows (writeFailureRecord + rethrow), not be masked as a silent "already exists" no-op.
const TASK_EXISTS_CODES: readonly string[] = [
  "SQLITE_CONSTRAINT_PRIMARYKEY",
  "SQLITE_CONSTRAINT_UNIQUE",
];

export interface PersistDebateTurnInput {
  readonly dbPath: string;
  readonly blobRoot: string;
  readonly runDir: string;
  readonly sessionId: string;
  readonly turn: number;
  readonly round: number;
  readonly agent: AgentName;
  readonly promptContent: string;
  readonly outputContent: string;
  readonly stderrContent: string;
  readonly durationMs: number;
  readonly exitCode: number;
  readonly messageId: string;
  readonly messageCreatedAt: string;
  readonly messageStatus?: "completed" | "failed" | "cancelled" | undefined;
  readonly workingSetId: string;
  readonly workingSetCreatedAt: string;
  readonly peerRefs: readonly ChatPeerRef[];
  readonly outcome: ChatWorkingSetOutcome;
  readonly workingSetTokenEstimate: number | null;
}

export type PersistDebateTurnResult = Readonly<{ dispatchId: string; contextBlobHash: string }>;

type StrictWriteStage = "open-db" | "working-set" | "dispatch" | "message" | "ledger-mint";

interface PreparedStrictRows {
  readonly input: PersistDebateTurnInput;
  readonly taskId: TaskId;
  readonly contextBlobHash: string;
  readonly outputBlobHash: string;
  readonly stderrBlobHash?: string;
}

const PersistDebateTurnInputSchema: z.ZodType<PersistDebateTurnInput> = z
  .object({
    dbPath: z.string().min(1),
    blobRoot: z.string().min(1),
    runDir: z.string().min(1),
    sessionId: z.string().min(1),
    turn: z.number().int().nonnegative(),
    round: z.number().int().positive(),
    agent: z.enum(AGENT_NAMES),
    promptContent: z.string(),
    outputContent: z.string(),
    stderrContent: z.string(),
    durationMs: z.number().int().nonnegative(),
    exitCode: z.number().int(),
    messageId: z.string().min(1),
    messageCreatedAt: z.string().min(1),
    messageStatus: z.enum(MESSAGE_STATUSES).optional(),
    workingSetId: z.string().min(1),
    workingSetCreatedAt: z.string().min(1),
    peerRefs: ChatPeerRefsSchema,
    outcome: ChatWorkingSetOutcomeSchema,
    workingSetTokenEstimate: z.number().int().nonnegative().nullable(),
  })
  .strict();

export async function persistDebateTurn(
  rawInput: PersistDebateTurnInput,
): Promise<PersistDebateTurnResult> {
  const input = PersistDebateTurnInputSchema.parse(rawInput);
  const prepared = await prepareStrictRows(input);
  return persistPreparedRows(prepared);
}

async function prepareStrictRows(input: PersistDebateTurnInput): Promise<PreparedStrictRows> {
  const store: BlobStore = { rootDir: input.blobRoot };
  const contextBlobHash = await putBlob(store, input.promptContent);
  const [outputBlobHash, stderrBlobHash] = await Promise.all([
    putBlob(store, input.outputContent),
    putOptionalBlob(store, input.stderrContent),
  ]);
  return {
    input,
    taskId: chatTaskId(input.sessionId, input.turn, input.agent, input.round),
    contextBlobHash,
    outputBlobHash,
    ...(stderrBlobHash !== undefined ? { stderrBlobHash } : {}),
  };
}

async function persistPreparedRows(prepared: PreparedStrictRows): Promise<PersistDebateTurnResult> {
  let db: Db | undefined;
  let stage: StrictWriteStage = "open-db";
  try {
    db = openDb(prepared.input.dbPath);
    const dispatchId = persistRowsTransaction(db, prepared, (nextStage) => {
      stage = nextStage;
    });
    return { dispatchId, contextBlobHash: prepared.contextBlobHash };
  } catch (error) {
    await writeFailureRecord(prepared.input, stage, error, prepared.contextBlobHash);
    throw error;
  } finally {
    if (db !== undefined) closeDb(db);
  }
}

function persistRowsTransaction(
  db: Db,
  prepared: PreparedStrictRows,
  setStage: (stage: StrictWriteStage) => void,
): string {
  const queries = createQueries(db);
  // MT7 (wave-seal B1 reopen): a debate turn is a VISIBLE room message — with the carrier runtime on
  // this db it must mint its ledger seq in the SAME transaction as the message row (§5/F-16: both or
  // neither; an unminted visible message is invisible to every lane forever). The mint rides the LOCAL
  // handle: this transaction already holds the file's write lock, so a second connection would
  // deadlock-then-fail — nested on the same handle, mintSeq's transaction becomes a savepoint (the
  // composition recordChatMessage's ghost-project rollback falsifier proves). A mint failure escalates
  // through the strict failure channel (record + rethrow) like any other strict write failure.
  // RA-1: the third fork of the same rule, now the same ONE lookup. A debate turn under a carrier whose
  // dbPath was spelled differently used to mint nothing at all — a visible room message, no seq, forever.
  const mintProjectId = persistenceOwnerFor(prepared.input.dbPath)?.projectId;
  const transaction = db.transaction((): string => {
    ensureRunRow(db, chatRunId(prepared.input.sessionId));
    ensureStrictTaskRow(queries, prepared);
    setStage("working-set");
    insertWorkingSet(queries, prepared);
    setStage("dispatch");
    const dispatchId = insertStrictDispatch(queries, prepared);
    setStage("message");
    insertStrictMessage(db, prepared, dispatchId);
    if (mintProjectId !== undefined) {
      setStage("ledger-mint");
      mintSeq(db, mintProjectId, prepared.input.messageId);
    }
    return dispatchId;
  });
  return transaction();
}

function ensureStrictTaskRow(queries: Queries, prepared: PreparedStrictRows): void {
  try {
    queries.insertTask({
      id: prepared.taskId,
      runId: chatRunId(prepared.input.sessionId),
      objective: `chat turn ${String(prepared.input.turn)} r${String(prepared.input.round)} -> ${prepared.input.agent}`,
      agent: prepared.input.agent,
      ownedFiles: [],
      forbiddenFiles: [],
      acceptance: [],
    });
  } catch (error) {
    if (isTaskAlreadyExists(error)) {
      return; // benign idempotent retry: the task row already exists
    }
    throw error; // any other failure must surface via persistPreparedRows (writeFailureRecord + rethrow), not vanish
  }
}

// Mirrors evidence.ts:231-237: a PK/unique collision is the ONLY "already exists" case; everything else
// (a NOT NULL breach, a FK violation) is a real failure the caller must see, not an idempotent retry.
function isTaskAlreadyExists(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" && TASK_EXISTS_CODES.includes(code);
}

function insertWorkingSet(queries: Queries, prepared: PreparedStrictRows): void {
  queries.insertChatWorkingSet({
    id: prepared.input.workingSetId,
    sessionId: prepared.input.sessionId,
    turn: prepared.input.turn,
    round: prepared.input.round,
    agent: prepared.input.agent,
    contextBlobHash: prepared.contextBlobHash,
    peerRefs: prepared.input.peerRefs,
    outcome: prepared.input.outcome,
    tokenEstimate: prepared.input.workingSetTokenEstimate,
    createdAt: prepared.input.workingSetCreatedAt,
  });
}

function insertStrictDispatch(queries: Queries, prepared: PreparedStrictRows): string {
  const inserted = queries.insertDispatch({
    taskId: prepared.taskId,
    agent: prepared.input.agent,
    commandHash: chatCommandHash(prepared.input.agent, prepared.input.turn, prepared.input.round),
    exitCode: prepared.input.exitCode,
    stdoutBlob: prepared.outputBlobHash,
    durationMs: prepared.input.durationMs,
    tokensIn: estimatePromptTokens(prepared.input.promptContent),
    tokensOut: estimatePromptTokens(prepared.input.outputContent),
    contextBlobHash: prepared.contextBlobHash,
    ...(prepared.stderrBlobHash !== undefined ? { stderrBlob: prepared.stderrBlobHash } : {}),
  });
  if (!inserted) throw new Error("strict debate dispatch insert was ignored");
  const id = queries.findDispatchId({
    taskId: prepared.taskId,
    agent: prepared.input.agent,
    commandHash: chatCommandHash(prepared.input.agent, prepared.input.turn, prepared.input.round),
  });
  if (id === undefined) throw new Error("strict debate dispatch id was not found after insert");
  return id;
}

function insertStrictMessage(db: Db, prepared: PreparedStrictRows, dispatchId: string): void {
  db.prepare(
    "INSERT INTO chat_messages (id, session_id, turn, round, role, agent, text_blob_hash, created_at, status, token_estimate, dispatch_id) VALUES (@id, @sessionId, @turn, @round, @role, @agent, @textBlobHash, @createdAt, @status, @tokenEstimate, @dispatchId)",
  ).run({
    id: prepared.input.messageId,
    sessionId: prepared.input.sessionId,
    turn: prepared.input.turn,
    round: prepared.input.round,
    role: "agent",
    agent: prepared.input.agent,
    textBlobHash: prepared.outputBlobHash,
    createdAt: prepared.input.messageCreatedAt,
    status: prepared.input.messageStatus ?? statusFromOutcome(prepared.input.outcome),
    tokenEstimate: estimatePromptTokens(prepared.input.outputContent),
    dispatchId,
  });
}

function statusFromOutcome(outcome: ChatWorkingSetOutcome): "completed" | "failed" | "cancelled" {
  if (outcome === "cancelled") return "cancelled";
  return outcome === "ok" || outcome === "empty" ? "completed" : "failed";
}

async function putOptionalBlob(store: BlobStore, content: string): Promise<string | undefined> {
  return content.length > 0 ? putBlob(store, content) : undefined;
}

async function writeFailureRecord(
  input: PersistDebateTurnInput,
  stage: StrictWriteStage,
  error: unknown,
  contextBlobHash: string,
): Promise<void> {
  const dir = path.join(input.runDir, FAILURE_DIR);
  await mkdir(dir, { recursive: true });
  const record = {
    kind: "strict-debate-evidence-failure",
    sessionId: input.sessionId,
    turn: input.turn,
    round: input.round,
    agent: input.agent,
    stage,
    contextBlobHash,
    reason: error instanceof Error ? error.message : String(error),
    createdAt: new Date().toISOString(),
  };
  await appendFile(path.join(dir, FAILURE_FILE), `${JSON.stringify(record)}\n`, "utf8");
}
