/**
 * @file src/chat/evidence.ts
 * @purpose Write chat dispatch rows + prompt/output blobs to evidence DB.
 * @exports recordChatDispatch, recordChatSession, recordChatMessage, recordLaneTurnEvidence, RecordDispatchInput, RecordLaneTurnInput, LaneTurnEvidence, chatTaskId, chatCommandHash, persistDebateTurn
 * @depends ../evidence/db, ../evidence/queries, ../evidence/blobs, ../evidence/runs-bootstrap, ../memory/ledger, ../shared/git-inspect, ../shared/logger, ../shared/types, ./evidence-identity, ./evidence-strict, ./lane-transport, ./prompt-budgeter, ./types
 */
import { type BlobStore, putBlob } from "../evidence/blobs.js";
import { type Db, closeDb, openDb } from "../evidence/db.js";
import { type Queries, createQueries } from "../evidence/queries.js";
import { ensureRunRow } from "../evidence/runs-bootstrap.js";
import { mintSeq, mintSeqInTransaction } from "../memory/ledger.js";
import { GIT_INSPECT_ENV, GIT_INSPECT_TIMEOUT_MS } from "../shared/git-inspect.js";
import { createLogger } from "../shared/logger.js";
import type { AgentName, RunId, TaskId } from "../shared/types.js";
import { chatCommandHash, chatRunId, chatTaskId } from "./evidence-identity.js";
import { persistenceOwnerFor } from "./lane-transport.js";
import { estimatePromptTokens } from "./prompt-budgeter.js";
import type { ChatMessageRole } from "./types.js";
export { chatCommandHash, chatRunId, chatTaskId } from "./evidence-identity.js";
export { persistDebateTurn } from "./evidence-strict.js";
export type { PersistDebateTurnInput, PersistDebateTurnResult } from "./evidence-strict.js";

const PHASE: string = "chat-evidence";

const logger = createLogger();

// The ONLY benign insertTask failure: the task row already exists (idempotent retry). better-sqlite3
// surfaces that PK/unique collision under these codes. Any OTHER constraint breach must propagate to
// recordChatDispatch's catch (which logs the real reason + continues), not be masked as "already exists".
const TASK_EXISTS_CODES: readonly string[] = [
  "SQLITE_CONSTRAINT_PRIMARYKEY",
  "SQLITE_CONSTRAINT_UNIQUE",
];

export interface RecordDispatchInput {
  readonly dbPath: string;
  readonly blobRoot: string;
  readonly sessionId: string;
  readonly turn: number;
  readonly agent: AgentName;
  readonly promptContent: string;
  readonly outputContent: string;
  readonly stderrContent: string;
  readonly durationMs: number;
  readonly exitCode: number;
  readonly repoRoot: string;
  readonly round?: number;
}

export interface RecordChatSessionInput {
  readonly dbPath: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly repoRoot: string;
  readonly runDir: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly defaultAgent: AgentName;
  readonly lastAgent: AgentName | null;
  readonly summaryText: string;
  readonly summaryThroughTurn: number;
  readonly projectId?: string;
}

export interface RecordChatMessageInput {
  readonly dbPath: string;
  readonly blobRoot: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly turn: number;
  readonly role: "user" | "agent" | "system" | "error";
  readonly agent: string;
  readonly text: string;
  readonly createdAt: string;
  readonly status: "completed" | "failed" | "cancelled";
  readonly tokenEstimate: number;
  readonly dispatchId?: string;
  readonly round?: number;
  /** U2e-c #8 (INV-EF7): the user turn's fan-out set, stored as a nullable dispatched_agents TEXT(JSON)
   *  column — the audit-trail cover for the open→tail-flush kill window. */
  readonly dispatchedAgents?: readonly AgentName[];
}

export async function recordChatDispatch(input: RecordDispatchInput): Promise<string | undefined> {
  let db: Db | undefined;
  try {
    db = openDb(input.dbPath);
    return await persistChatDispatch(db, input);
  } catch (error) {
    logger.warn({ phase: PHASE }, "evidence write failed, continuing", {
      reason: error instanceof Error ? error.message : String(error),
      session: input.sessionId,
      turn: input.turn,
    });
  } finally {
    if (db !== undefined) {
      closeDb(db);
    }
  }
  return undefined;
}

async function persistChatDispatch(
  db: Db,
  input: RecordDispatchInput,
): Promise<string | undefined> {
  const queries = createQueries(db);
  const store: BlobStore = { rootDir: input.blobRoot };
  const runId = chatRunId(input.sessionId);
  const taskId = chatTaskId(input.sessionId, input.turn, input.agent, input.round);

  ensureRunRow(db, runId);
  ensureTaskRow(queries, taskId, runId, input);

  const [promptHash, outputHash] = await Promise.all([
    putBlob(store, input.promptContent),
    putBlob(store, input.outputContent),
  ]);
  const stderrHash =
    input.stderrContent.length > 0 ? await putBlob(store, input.stderrContent) : undefined;
  const commandHash = chatCommandHash(input.agent, input.turn, input.round);
  const commit = await headCommit(input.repoRoot);

  queries.insertDispatch({
    taskId,
    agent: input.agent,
    commandHash,
    exitCode: input.exitCode,
    stdoutBlob: outputHash,
    durationMs: input.durationMs,
    tokensIn: estimatePromptTokens(input.promptContent),
    tokensOut: estimatePromptTokens(input.outputContent),
    contextBlobHash: promptHash,
    ...(stderrHash !== undefined ? { stderrBlob: stderrHash } : {}),
    ...(commit !== undefined ? { repoCommit: commit } : {}),
  });
  return queries.findDispatchId({ taskId, agent: input.agent, commandHash });
}

export async function recordChatSession(input: RecordChatSessionInput): Promise<void> {
  let db: Db | undefined;
  try {
    db = openDb(input.dbPath);
    const queries = createQueries(db);
    const runId = input.runId as RunId;

    ensureRunRow(db, runId);
    queries.insertChatSession({
      id: input.sessionId,
      runId,
      repoRoot: input.repoRoot,
      runDir: input.runDir,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      defaultAgent: input.defaultAgent,
      lastAgent: input.lastAgent,
      summaryText: input.summaryText,
      summaryThroughTurn: input.summaryThroughTurn,
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    });
  } catch (error) {
    logger.warn({ phase: PHASE }, "chat session evidence write failed, continuing", {
      reason: error instanceof Error ? error.message : String(error),
      session: input.sessionId,
    });
  } finally {
    if (db !== undefined) {
      closeDb(db);
    }
  }
}

// The shared ledger carries CONVERSATION — what a resuming or parallel lane legitimately reads back as
// dialogue. Operational roles (system, error) are evidence-only: durable in chat_messages (below), but
// never minted into the cross-lane ledger seq stream. ALLOWLIST, not an error-blocklist, so a future
// fifth ChatMessageRole defaults OUT of the ledger (fail-closed) until deliberately added here.
// Fix-round wave-4 fold #4: an error row minted a seq unconditionally, then rode the carrier's
// ledger-delta injection (ledger.ts's readTailCandidates -> lane-carrier.ts's composeCarrierDelta ->
// headless-carrier.ts's projectBodyReader) into a SIBLING lane's or a later turn's live prompt,
// misattributed as if that agent had said it (authorOf treats any non-user role as agent-authored).
const LEDGER_CONVERSATION_ROLES: ReadonlySet<ChatMessageRole> = new Set(["user", "agent"]);

/**
 * Persists one chat message row + its text blob. Returns the written messageId on success, or
 * `undefined` when the write was swallowed (it never throws — evidence is best-effort). The returned id
 * is the swallowed-failure INDICATOR a TOWER caller (tower-bridge-lane B4) inspects to surface the
 * otherwise-silent failure, mirroring {@link recordChatDispatch}'s dispatch-id contract.
 */
export async function recordChatMessage(
  input: RecordChatMessageInput,
): Promise<string | undefined> {
  let db: Db | undefined;
  // RA-1: identity, never spelling. The former `carrier.dbPath === input.dbPath` raw compare read one file
  // under two spellings as two stores, fell through to the per-message openDb below, and left the row with
  // NO ledger seq — durable in chat_messages yet invisible to every other lane forever.
  const carrier = persistenceOwnerFor(input.dbPath);
  const viaLedger = carrier !== undefined;
  try {
    const textBlobHash = await putBlob({ rootDir: input.blobRoot }, input.text);
    // MT7 (wave-seal B1): with the carrier runtime present, the message row and its ledger seq mint
    // in ONE immediate transaction on the runtime's lane handle — atomically both or neither, so a
    // persisted message can never be invisible to the room ledger (§5/F-16; minting is runtime-gated,
    // NOT lock-gated: the windowed second cockpit mints too). Flag-off paths below stay byte-identical.
    if (viaLedger) {
      const queries = createQueries(carrier.db);
      const write = carrier.db.transaction(() => {
        insertMessageRow(queries, input, textBlobHash);
        // Mint only for ledger-conversation roles (see LEDGER_CONVERSATION_ROLES above) — an
        // error/system row still lands in chat_messages via insertMessageRow just above, it just never
        // rides the shared ledger into another lane's or a later turn's live prompt.
        if (LEDGER_CONVERSATION_ROLES.has(input.role)) {
          mintSeq(carrier.db, carrier.projectId, input.messageId);
        }
      });
      write.immediate();
      return input.messageId;
    }
    db = openDb(input.dbPath);
    insertMessageRow(createQueries(db), input, textBlobHash);
    return input.messageId;
  } catch (error) {
    logger.warn({ phase: PHASE }, "chat message evidence write failed, continuing", {
      reason: error instanceof Error ? error.message : String(error),
      session: input.sessionId,
      turn: input.turn,
      // A failed LEDGER write is a lost room-delta candidate, not just a lost audit row — name it.
      carrierLedger: viaLedger,
    });
  } finally {
    if (db !== undefined) {
      closeDb(db);
    }
  }
  return undefined;
}

// The one message-row INSERT both persistence paths share (ledger-minting and plain).
function insertMessageRow(
  queries: Queries,
  input: RecordChatMessageInput,
  textBlobHash: string,
): void {
  queries.insertChatMessage({
    id: input.messageId,
    sessionId: input.sessionId,
    turn: input.turn,
    role: input.role,
    agent: input.agent,
    textBlobHash,
    createdAt: input.createdAt,
    status: input.status,
    tokenEstimate: input.tokenEstimate,
    dispatchId: input.dispatchId ?? null,
    ...(input.round !== undefined ? { round: input.round } : {}),
    ...(input.dispatchedAgents !== undefined ? { dispatchedAgents: input.dispatchedAgents } : {}),
  });
}

export interface RecordLaneTurnInput {
  readonly dbPath: string;
  readonly blobRoot: string;
  readonly sessionId: string;
  readonly turn: number;
  readonly agent: AgentName;
  readonly promptContent: string;
  readonly outputContent: string;
  readonly stderrContent: string;
  readonly durationMs: number;
  readonly exitCode: number;
  readonly repoRoot: string;
  readonly round?: number;
  readonly messageId: string;
  readonly messageCreatedAt: string;
  readonly messageStatus: "completed" | "failed" | "cancelled";
}

/** The written ids, or `undefined` fields when the whole record was swallowed (best-effort, never throws).
 *  On a swallowed rollback `error` carries the ORIGINAL failure (CONCERN 4) so the tower surfacing classifies
 *  it honestly — an FK breach reads as schema-drift, not a generic synthetic error that degrades to unknown. */
export interface LaneTurnEvidence {
  readonly dispatchId?: string;
  readonly messageId?: string;
  readonly error?: unknown;
}

/**
 * B2-b1 (E1): the per-session evidence writer — records a lane's dispatch row + its agent message row +
 * the ledger seq mint in ONE synchronous transaction on ONE handle, ALL-OR-NOTHING. Supersedes the old
 * recordChatDispatch-then-recordChatMessage PAIR (persistLane), which wrote the dispatch in a SEPARATE
 * handle + transaction from the message+ledger — a mid-finalize failure could leave a dispatch row with no
 * message (a partial turn-record a concurrent reader could observe). Referee-pinned shape: every async input
 * (blobs, head commit) is precomputed OUTSIDE the transaction; the transaction is synchronous; the handle is
 * the carrier's per-session handle when present (a second-handle write inside the boundary is forbidden —
 * an @all turn opens ZERO extra handles), else ONE own handle closed in `finally`; the ledger mint rides the
 * SAME handle as a nested savepoint (mintSeqInTransaction, no redundant busy-retry). Best-effort like its
 * predecessors: a swallowed failure logs + returns `{}`, and the transaction guarantees zero partial rows.
 */
export async function recordLaneTurnEvidence(
  input: RecordLaneTurnInput,
): Promise<LaneTurnEvidence> {
  // RA-1: same identity rule as recordChatMessage — one owner lookup, never a per-writer string compare.
  const carrier = persistenceOwnerFor(input.dbPath);
  const viaLedger = carrier !== undefined;
  let ownDb: Db | undefined;
  try {
    const prepared = await prepareLaneTurn(input); // all async I/O OUTSIDE the transaction
    // The ONE handle: the carrier's per-session handle when present (no second handle inside the boundary),
    // else a single own handle closed in `finally`. An @all turn under the carrier opens ZERO extra handles.
    let db: Db;
    if (viaLedger && carrier !== undefined) {
      db = carrier.db;
    } else {
      ownDb = openDb(input.dbPath);
      db = ownDb;
    }
    const queries = createQueries(db);
    const ledger =
      viaLedger && carrier !== undefined ? { db, projectId: carrier.projectId } : undefined;
    const write = db.transaction(
      (): LaneTurnEvidence => insertLaneTurnRows(db, queries, input, prepared, ledger),
    );
    return write.immediate();
  } catch (error) {
    logger.warn({ phase: PHASE }, "lane turn evidence write failed, continuing", {
      reason: error instanceof Error ? error.message : String(error),
      session: input.sessionId,
      turn: input.turn,
      carrierLedger: viaLedger,
    });
    // CONCERN 4: carry the ORIGINAL failure out so the tower's surfaceEvidenceFailure classifies it honestly
    // (an FK breach → schema-drift) instead of the generic synthetic error that degraded the reason to unknown.
    return { error };
  } finally {
    if (ownDb !== undefined) {
      closeDb(ownDb);
    }
  }
}

interface PreparedLaneTurn {
  readonly promptHash: string;
  readonly outputHash: string;
  readonly stderrHash?: string;
  readonly commit?: string;
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly commandHash: string;
}

// Precomputes every async input OUTSIDE the transaction: the prompt + output blobs (the agent message's
// text IS the output, so its blob is the same content-addressed hash), the optional stderr blob, and the
// head commit via the shared git-inspect (G3) conventions. The ids are pure. The transaction that consumes
// this is fully synchronous.
async function prepareLaneTurn(input: RecordLaneTurnInput): Promise<PreparedLaneTurn> {
  const store: BlobStore = { rootDir: input.blobRoot };
  const [promptHash, outputHash] = await Promise.all([
    putBlob(store, input.promptContent),
    putBlob(store, input.outputContent),
  ]);
  const stderrHash =
    input.stderrContent.length > 0 ? await putBlob(store, input.stderrContent) : undefined;
  const commit = await headCommit(input.repoRoot);
  return {
    promptHash,
    outputHash,
    runId: chatRunId(input.sessionId),
    taskId: chatTaskId(input.sessionId, input.turn, input.agent, input.round),
    commandHash: chatCommandHash(input.agent, input.turn, input.round),
    ...(stderrHash !== undefined ? { stderrHash } : {}),
    ...(commit !== undefined ? { commit } : {}),
  };
}

// The SYNCHRONOUS transaction body: dispatch + message + (carrier) ledger mint, ALL-OR-NOTHING on `db`.
// A throw here rolls back every row (zero partial rows); the ledger mint is nested as a savepoint.
function insertLaneTurnRows(
  db: Db,
  queries: Queries,
  input: RecordLaneTurnInput,
  prepared: PreparedLaneTurn,
  ledger: { readonly db: Db; readonly projectId: string } | undefined,
): LaneTurnEvidence {
  ensureRunRow(db, prepared.runId);
  ensureTaskRow(queries, prepared.taskId, prepared.runId, input);
  queries.insertDispatch({
    taskId: prepared.taskId,
    agent: input.agent,
    commandHash: prepared.commandHash,
    exitCode: input.exitCode,
    stdoutBlob: prepared.outputHash,
    durationMs: input.durationMs,
    tokensIn: estimatePromptTokens(input.promptContent),
    tokensOut: estimatePromptTokens(input.outputContent),
    contextBlobHash: prepared.promptHash,
    ...(prepared.stderrHash !== undefined ? { stderrBlob: prepared.stderrHash } : {}),
    ...(prepared.commit !== undefined ? { repoCommit: prepared.commit } : {}),
  });
  const dispatchId = queries.findDispatchId({
    taskId: prepared.taskId,
    agent: input.agent,
    commandHash: prepared.commandHash,
  });
  if (dispatchId === undefined) {
    throw new Error("lane dispatch id not found after insert");
  }
  insertMessageRow(queries, laneMessageInput(input, dispatchId), prepared.outputHash);
  // agent role is always a LEDGER_CONVERSATION_ROLE — mint the seq in this SAME transaction (F-16), nested
  // on the handle as a savepoint (no redundant busy-retry — the outer immediate() already holds the lock).
  if (ledger !== undefined) {
    mintSeqInTransaction(ledger.db, ledger.projectId, input.messageId);
  }
  return { dispatchId, messageId: input.messageId };
}

// The agent message row a lane persists: its text IS the dispatch output, role always "agent".
function laneMessageInput(input: RecordLaneTurnInput, dispatchId: string): RecordChatMessageInput {
  return {
    dbPath: input.dbPath,
    blobRoot: input.blobRoot,
    sessionId: input.sessionId,
    messageId: input.messageId,
    turn: input.turn,
    role: "agent",
    agent: input.agent,
    text: input.outputContent,
    createdAt: input.messageCreatedAt,
    status: input.messageStatus,
    tokenEstimate: estimatePromptTokens(input.outputContent),
    dispatchId,
    ...(input.round !== undefined ? { round: input.round } : {}),
  };
}

function ensureTaskRow(
  queries: Queries,
  taskId: TaskId,
  runId: RunId,
  input: { readonly turn: number; readonly agent: AgentName },
): void {
  try {
    queries.insertTask({
      id: taskId,
      runId,
      objective: `chat turn ${String(input.turn)} → ${input.agent}`,
      agent: input.agent,
      ownedFiles: [],
      forbiddenFiles: [],
      acceptance: [],
    });
  } catch (error) {
    if (isTaskAlreadyExists(error)) {
      return; // benign idempotent retry: the task row already exists
    }
    throw error; // any other failure must surface, not vanish behind an "already exists" assumption
  }
}

function isTaskAlreadyExists(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" && TASK_EXISTS_CODES.includes(code);
}

// The lane's HEAD sha at write time, precomputed OUTSIDE the transaction. CONCERN 3 (B2-b1 review): this is
// a shared-git-inspect (G3) CONSUMER — the owner never spawns git, so a consumer keeps its own execa spawn but
// MUST share the owner's conventions (git-inspect.ts), exactly like evidence-capture's runGit. It carries
// GIT_INSPECT_ENV (GIT_OPTIONAL_LOCKS=0 so a concurrent lane's rev-parse never writes lock files; LC_ALL=C)
// and the single GIT_INSPECT_TIMEOUT_MS policy — NOT the prior bare 5s + no-env spawn, which was precisely the
// per-consumer timeout/env drift the owner exists to prevent (structure#4). Returns the sha, or undefined on
// any failure (outside a repo, timeout) so the evidence row simply carries no repo_commit — never throws.
async function headCommit(repoRoot: string): Promise<string | undefined> {
  try {
    const { execa: execaFn } = await import("execa");
    const result = await execaFn("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      env: GIT_INSPECT_ENV,
      shell: false,
      timeout: GIT_INSPECT_TIMEOUT_MS,
    });
    return result.stdout.trim();
  } catch {
    return undefined;
  }
}
