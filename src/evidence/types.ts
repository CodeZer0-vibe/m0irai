/**
 * @file src/evidence/types.ts
 * @purpose Typed row contracts for append-only observability evidence.
 * @exports InsertRunArgs, UpdateRunStatusArgs, InsertTaskArgs, UpdateTaskStatusArgs, InsertFindingArgs, InsertGateTransitionArgs, InsertDispatchArgs, InsertEventArgs, InsertErrorArgs, QueryErrorsArgs, ErrorRow, EventRow, FindingRow, ContextRunRow, ContextItemRow, RowIdRow, NextSequenceRow, PersistedFinding, InsertChatSessionRow, InsertChatMessageRow, ListChatWorkingSetsArgs, FindDispatchIdArgs, Queries, ListChatWorkingSetsArgsSchema
 * @depends zod, ../shared/error-codes, ../shared/types
 */
import { z } from "zod";
import type { ErrorCategory, ErrorRetryability, Zer0ErrorCode } from "../shared/error-codes.js";
import type {
  AgentName,
  BuildResult,
  ChatPeerRef,
  ChatWorkingSetOutcome,
  ContextItem,
  ContextRun,
  Finding,
  RunId,
  TaskId,
} from "../shared/types.js";

export interface InsertRunArgs {
  id: RunId;
  vision: string;
  startedAt: string;
}

export interface UpdateRunStatusArgs {
  id: RunId;
  status: string;
  completedAt?: string;
}

export interface InsertTaskArgs {
  id: TaskId;
  runId: RunId;
  objective: string;
  agent: AgentName;
  ownedFiles: string[];
  forbiddenFiles: string[];
  acceptance: string[];
}

export interface UpdateTaskStatusArgs {
  id: TaskId;
  status: string;
  result?: BuildResult;
  headCommit?: string;
}

export type InsertFindingArgs = Finding & {
  taskId: TaskId;
  runId: RunId;
  sourceAgent: AgentName;
};

export interface InsertGateTransitionArgs {
  runId: RunId;
  fromState: string;
  toState: string;
  gateName: string;
  passed: boolean;
  evidence: Record<string, unknown>;
}

export interface InsertDispatchArgs {
  taskId: TaskId;
  agent: AgentName;
  commandHash: string;
  exitCode: number;
  stdoutBlob: string;
  stderrBlob?: string;
  diffBlob?: string;
  durationMs: number;
  tokensIn?: number;
  tokensOut?: number;
  argvJson?: string;
  cwd?: string;
  envAllowlistVersion?: string;
  contextBlobHash?: string;
  modelVersion?: string;
  repoCommit?: string;
}

export interface InsertEventArgs {
  id: string;
  runId: RunId;
  kind: string;
  payloadJson: string;
  phase?: string;
  taskId?: TaskId;
  errorId?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
}

export interface InsertErrorArgs {
  id: string;
  runId?: RunId;
  taskId?: TaskId;
  dispatchId?: string;
  gateTransitionId?: string;
  code: string;
  category: string;
  retryability: string;
  message: string;
  causeCode?: string;
  evidenceJson: string;
  evidenceBlob?: string;
  fingerprint: string;
  traceId?: string;
  spanId?: string;
}

export interface QueryErrorsArgs {
  runId?: RunId;
  code?: string;
  limit?: number;
}

export interface ErrorRow {
  id: string;
  run_id: string | null;
  task_id: string | null;
  dispatch_id: string | null;
  gate_transition_id: string | null;
  code: Zer0ErrorCode;
  category: ErrorCategory;
  retryability: ErrorRetryability;
  message: string;
  cause_code: Zer0ErrorCode | null;
  evidence_json: string;
  evidence_blob: string | null;
  fingerprint: string;
  trace_id: string | null;
  span_id: string | null;
  created_at: string;
}

export interface EventRow {
  id: string;
  run_id: string;
  sequence: number;
  kind: string;
  phase: string | null;
  task_id: string | null;
  error_id: string | null;
  trace_id: string | null;
  span_id: string | null;
  parent_span_id: string | null;
  payload_json: string;
  created_at: string;
}

export interface FindingRow {
  severity: Finding["severity"];
  path: string | null;
  line: number | null;
  finding: string;
}

export interface ContextRunRow {
  id: number | string;
  task_id: TaskId;
  run_id: RunId;
  agent: AgentName;
  head_commit: string;
  prompt_hash: string;
  context_hash: string;
  token_count: number;
  token_budget: number;
  blob_path: string;
}

export interface ContextItemRow {
  id: number | string;
  context_run_id: number | string;
  kind: ContextItem["kind"];
  path: string;
  symbol: string | null;
  content_hash: string;
  token_count: number;
  score: number;
  reason: string;
}

export interface RowIdRow {
  rowid: number;
}

export interface NextSequenceRow {
  sequence: number;
}

export interface PersistedFinding {
  readonly severity: "P0" | "P1" | "P2";
  readonly path: string | null;
  readonly line: number | null;
  readonly finding: string;
  readonly sourceAgent: string;
}

export interface InsertChatSessionRow {
  readonly id: string;
  readonly runId: RunId;
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

export interface InsertChatMessageRow {
  readonly id: string;
  readonly sessionId: string;
  readonly turn: number;
  readonly round?: number;
  readonly role: "user" | "agent" | "system" | "error";
  readonly agent: string;
  readonly textBlobHash: string;
  readonly createdAt: string;
  readonly status: "completed" | "failed" | "cancelled";
  readonly tokenEstimate: number;
  readonly dispatchId: string | null;
  /** U2e-c #8 (INV-EF7): the user turn's fan-out set; serialized to the dispatched_agents TEXT(JSON) column
   *  in toChatMessageParams. Optional ⇒ non-user rows + old callers omit it (column stays NULL). */
  readonly dispatchedAgents?: readonly AgentName[];
}

interface InsertChatWorkingSetRow {
  readonly id: string;
  readonly sessionId: string;
  readonly turn: number;
  readonly round: number;
  readonly agent: AgentName;
  readonly contextBlobHash: string;
  readonly peerRefs: readonly ChatPeerRef[];
  readonly outcome: ChatWorkingSetOutcome;
  readonly tokenEstimate: number | null;
  readonly createdAt: string;
}

export interface ListChatWorkingSetsArgs {
  readonly sessionId: string;
  readonly turn: number;
  readonly round: number;
}

export const ListChatWorkingSetsArgsSchema: z.ZodType<ListChatWorkingSetsArgs> = z
  .object({
    sessionId: z.string().min(1),
    turn: z.number().int().nonnegative(),
    round: z.number().int().nonnegative(),
  })
  .strict();

interface ChatWorkingSetRow {
  readonly id: string;
  readonly sessionId: string;
  readonly turn: number;
  readonly round: number;
  readonly agent: AgentName;
  readonly contextBlobHash: string;
  readonly peerRefs: readonly ChatPeerRef[];
  readonly outcome: ChatWorkingSetOutcome;
  readonly tokenEstimate: number | null;
  readonly createdAt: string;
}

interface InsertActiveDebateRow {
  readonly sessionId: string;
  readonly turn: number;
  readonly startedAt: string;
}

type ActiveDebateRow = InsertActiveDebateRow;

export interface FindDispatchIdArgs {
  readonly taskId: TaskId;
  readonly agent: AgentName;
  readonly commandHash: string;
}

export interface Queries {
  insertRun(args: InsertRunArgs): void;
  updateRunStatus(args: UpdateRunStatusArgs): void;
  insertTask(args: InsertTaskArgs): void;
  insertContextRun(run: ContextRun): void;
  insertContextItem(item: ContextItem): void;
  getContextRun(runId: RunId, taskId: TaskId): ContextRun | undefined;
  listContextItems(contextRunId: number): ContextItem[];
  updateTaskStatus(args: UpdateTaskStatusArgs): void;
  insertFinding(args: InsertFindingArgs): void;
  findFindingsByRunId(runId: RunId): readonly PersistedFinding[];
  searchFindings(query: string, limit?: number): Finding[];
  insertGateTransition(args: InsertGateTransitionArgs): boolean;
  insertDispatch(args: InsertDispatchArgs): boolean;
  findDispatchId(args: FindDispatchIdArgs): string | undefined;
  insertChatSession(row: InsertChatSessionRow): void;
  insertChatMessage(row: InsertChatMessageRow): void;
  insertChatWorkingSet(row: InsertChatWorkingSetRow): void;
  listChatWorkingSets(args: ListChatWorkingSetsArgs): readonly ChatWorkingSetRow[];
  acquireActiveDebate(row: InsertActiveDebateRow): boolean;
  getActiveDebate(sessionId: string): ActiveDebateRow | undefined;
  releaseActiveDebate(sessionId: string): boolean;
  insertEvent(args: InsertEventArgs): EventRow;
  insertError(args: InsertErrorArgs): void;
  queryErrors(args?: QueryErrorsArgs): ErrorRow[];
  queryEventsByRun(runId: RunId, limit?: number, cursor?: number): EventRow[];
  getLatestStateSnapshot(runId: RunId): EventRow | undefined;
  close(): void;
}
