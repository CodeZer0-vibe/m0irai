/**
 * @file src/evidence/queries-params.ts
 * @purpose Domain-args -> SQL-named-parameter mappers for evidence prepared statements.
 * @exports toRunStatusParams, toTaskParams, toTaskStatusParams, toContextRunParams, toContextItemParams, toFindingParams, toGateTransitionParams, toDispatchParams, toChatSessionParams, toChatMessageParams, toEventParams, toErrorParams, findingId, nowIso, RUN_STATUS_COMPLETE, TASK_STATUS_COMPLETE, OPEN_FINDING_STATUS, ID_PREFIX_GATE, ID_PREFIX_DISPATCH, EMPTY_SEARCH_QUERY, SEARCH_DEFAULT_LIMIT, FindingParams
 * @depends ./types, ../shared/error-codes, ../shared/errors
 */
import { Zer0ErrorCode } from "../shared/error-codes.js";
import { ConfigError } from "../shared/errors.js";
import type { ContextItem, ContextRun } from "../shared/types.js";
import type {
  InsertChatMessageRow,
  InsertChatSessionRow,
  InsertDispatchArgs,
  InsertErrorArgs,
  InsertEventArgs,
  InsertFindingArgs,
  InsertGateTransitionArgs,
  InsertTaskArgs,
  UpdateRunStatusArgs,
  UpdateTaskStatusArgs,
} from "./types.js";

export const RUN_STATUS_COMPLETE: string = "completed";
export const TASK_STATUS_COMPLETE: string = "completed";
export const OPEN_FINDING_STATUS: string = "open";
export const ID_PREFIX_GATE: string = "gate-";
export const ID_PREFIX_DISPATCH: string = "dispatch-";
export const EMPTY_SEARCH_QUERY: string = "";
export const SEARCH_DEFAULT_LIMIT: number = 100;

export interface FindingParams extends Record<string, string | number | null> {
  id: string;
}

export function toRunStatusParams(args: UpdateRunStatusArgs): Record<string, string | null> {
  return {
    id: args.id,
    status: args.status,
    completedAt: args.completedAt ?? (args.status === RUN_STATUS_COMPLETE ? nowIso() : null),
  };
}

export function toTaskParams(args: InsertTaskArgs): Record<string, string> {
  return {
    id: args.id,
    runId: args.runId,
    objective: args.objective,
    agent: args.agent,
    ownedFiles: JSON.stringify(args.ownedFiles),
    forbiddenFiles: JSON.stringify(args.forbiddenFiles),
    acceptance: JSON.stringify(args.acceptance),
  };
}

export function toTaskStatusParams(args: UpdateTaskStatusArgs): Record<string, string | null> {
  if (args.status === TASK_STATUS_COMPLETE && args.headCommit === undefined) {
    const message = "headCommit is required when task status is 'completed'";
    throw new ConfigError(message, Zer0ErrorCode.ConfigInvalid);
  }
  return {
    id: args.id,
    status: args.status,
    result: args.result === undefined ? null : JSON.stringify(args.result),
    headCommit: args.headCommit ?? null,
  };
}

export function toContextRunParams(run: ContextRun): Record<string, string | number> {
  return {
    agent: run.agent,
    blobPath: run.blobPath,
    contextHash: run.contextHash,
    headCommit: run.headCommit,
    id: run.id,
    promptHash: run.promptHash,
    taskId: run.taskId,
    tokenBudget: run.tokenBudget,
    tokenCount: run.tokenCount,
  };
}

export function toContextItemParams(item: ContextItem): Record<string, string | number | null> {
  if (item.id === undefined || item.contextRunId === undefined) {
    const message = "context item id and contextRunId are required";
    throw new ConfigError(message, Zer0ErrorCode.ConfigInvalid);
  }
  return {
    contentHash: item.contentHash,
    contextRunId: item.contextRunId,
    id: item.id,
    kind: item.kind,
    path: item.path,
    reason: item.reason,
    score: item.score,
    symbol: item.symbol ?? null,
    tokenCount: item.tokenCount,
  };
}

export function toFindingParams(args: InsertFindingArgs): FindingParams {
  return {
    id: findingId(args),
    taskId: args.taskId,
    runId: args.runId,
    severity: args.severity,
    path: args.path,
    line: args.line ?? null,
    finding: args.finding,
    status: OPEN_FINDING_STATUS,
    sourceAgent: args.sourceAgent,
    reviewerContextHash: null,
  };
}

export function toGateTransitionParams(
  args: InsertGateTransitionArgs,
): Record<string, string | number> {
  return {
    idPrefix: ID_PREFIX_GATE,
    runId: args.runId,
    fromState: args.fromState,
    toState: args.toState,
    gateName: args.gateName,
    passed: args.passed ? 1 : 0,
    evidenceJson: JSON.stringify(args.evidence),
  };
}

export function toDispatchParams(args: InsertDispatchArgs): Record<string, string | number | null> {
  return {
    idPrefix: ID_PREFIX_DISPATCH,
    taskId: args.taskId,
    agent: args.agent,
    commandHash: args.commandHash,
    exitCode: args.exitCode,
    stdoutBlob: args.stdoutBlob,
    stderrBlob: args.stderrBlob ?? null,
    diffBlob: args.diffBlob ?? null,
    durationMs: args.durationMs,
    tokensIn: args.tokensIn ?? null,
    tokensOut: args.tokensOut ?? null,
    argvJson: args.argvJson ?? null,
    cwd: args.cwd ?? null,
    envAllowlistVersion: args.envAllowlistVersion ?? null,
    contextBlobHash: args.contextBlobHash ?? null,
    modelVersion: args.modelVersion ?? null,
    repoCommit: args.repoCommit ?? null,
  };
}

export function toChatSessionParams(
  args: InsertChatSessionRow,
): Record<string, string | number | null> {
  return {
    id: args.id,
    runId: args.runId,
    repoRoot: args.repoRoot,
    runDir: args.runDir,
    createdAt: args.createdAt,
    updatedAt: args.updatedAt,
    defaultAgent: args.defaultAgent,
    lastAgent: args.lastAgent,
    summaryText: args.summaryText,
    summaryThroughTurn: args.summaryThroughTurn,
    projectId: args.projectId ?? null,
  };
}

export function toChatMessageParams(
  args: InsertChatMessageRow,
): Record<string, string | number | null> {
  return {
    id: args.id,
    sessionId: args.sessionId,
    turn: args.turn,
    round: args.round ?? 0,
    role: args.role,
    agent: args.agent,
    textBlobHash: args.textBlobHash,
    createdAt: args.createdAt,
    status: args.status,
    tokenEstimate: args.tokenEstimate,
    dispatchId: args.dispatchId,
    // U2e-c #8: the fan-out set as a JSON array string, or NULL when absent (non-user rows, old callers).
    dispatchedAgents:
      args.dispatchedAgents !== undefined ? JSON.stringify(args.dispatchedAgents) : null,
  };
}

export function toEventParams(
  args: InsertEventArgs,
  sequence: number,
): Record<string, string | number | null> {
  return {
    id: args.id,
    runId: args.runId,
    sequence,
    kind: args.kind,
    phase: args.phase ?? null,
    taskId: args.taskId ?? null,
    errorId: args.errorId ?? null,
    traceId: args.traceId ?? null,
    spanId: args.spanId ?? null,
    parentSpanId: args.parentSpanId ?? null,
    payloadJson: args.payloadJson,
  };
}

export function toErrorParams(args: InsertErrorArgs): Record<string, string | null> {
  return {
    id: args.id,
    runId: args.runId ?? null,
    taskId: args.taskId ?? null,
    dispatchId: args.dispatchId ?? null,
    gateTransitionId: args.gateTransitionId ?? null,
    code: args.code,
    category: args.category,
    retryability: args.retryability,
    message: args.message,
    causeCode: args.causeCode ?? null,
    evidenceJson: args.evidenceJson,
    evidenceBlob: args.evidenceBlob ?? null,
    fingerprint: args.fingerprint,
    traceId: args.traceId ?? null,
    spanId: args.spanId ?? null,
  };
}

export function findingId(args: InsertFindingArgs): string {
  return `${args.runId}:${args.taskId}:${args.sourceAgent}:${args.severity}:${args.finding}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
