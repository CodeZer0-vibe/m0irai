/**
 * @file src/evidence/queries-rows.ts
 * @purpose Read-side query runners and DB-row -> domain projections for the evidence layer.
 * @exports queryErrors, searchFindings, findFindingsByRunId, getContextRun, listContextItems
 * @depends ./queries-statements, ./queries-params, ./types, ../shared/types
 */
import type { ContextItem, ContextRun, Finding, RunId, TaskId } from "../shared/types.js";
import { FindingSchema } from "../shared/types.js";
import { EMPTY_SEARCH_QUERY, SEARCH_DEFAULT_LIMIT } from "./queries-params.js";
import type { PreparedStatements } from "./queries-statements.js";
import type {
  ContextItemRow,
  ContextRunRow,
  ErrorRow,
  FindingRow,
  PersistedFinding,
  QueryErrorsArgs,
} from "./types.js";

export function queryErrors(statements: PreparedStatements, args?: QueryErrorsArgs): ErrorRow[] {
  const limit = args?.limit ?? SEARCH_DEFAULT_LIMIT;
  if (args?.runId !== undefined && args.code !== undefined) {
    return statements.queryErrorsByRunAndCode.all([args.runId, args.code, limit]) as ErrorRow[];
  }
  if (args?.runId !== undefined) {
    return statements.queryErrorsByRun.all([args.runId, limit]) as ErrorRow[];
  }
  if (args?.code !== undefined) {
    return statements.queryErrorsByCode.all([args.code, limit]) as ErrorRow[];
  }
  return statements.queryErrors.all(limit) as ErrorRow[];
}

export function searchFindings(
  statements: PreparedStatements,
  query: string,
  limit: number = SEARCH_DEFAULT_LIMIT,
): Finding[] {
  if (query.trim() === EMPTY_SEARCH_QUERY) {
    return [];
  }
  const rows = statements.searchFindings.all([query, limit]) as FindingRow[];
  return rows.map((row) =>
    FindingSchema.parse({
      severity: row.severity,
      path: row.path ?? "",
      line: row.line ?? undefined,
      finding: row.finding,
      // The findings table is a SEARCH INDEX over a projection of the Finding type, not full
      // storage. PLAN §11 schema does not persist Finding.category or Finding.confidence;
      // those are preserved in the source review blob (see dispatches.stdout_blob). The
      // sentinel category "evidence-search" indicates this row was reconstructed from the
      // FTS projection and that callers wanting the original category/confidence should
      // resolve the source blob via reviewer_context_hash. Schema v2 (Phase 2) may extend
      // findings with category + confidence columns; tracked in docs/MODULE-MAP.md.
      category: "evidence-search",
    }),
  );
}

export function findFindingsByRunId(
  statements: PreparedStatements,
  runId: RunId,
): readonly PersistedFinding[] {
  return statements.findFindingsByRunId.all(runId) as PersistedFinding[];
}

export function getContextRun(
  statements: PreparedStatements,
  runId: RunId,
  taskId: TaskId,
): ContextRun | undefined {
  const row = statements.getContextRun.get([runId, taskId]) as ContextRunRow | undefined;
  return row === undefined ? undefined : toContextRun(row);
}

export function listContextItems(
  statements: PreparedStatements,
  contextRunId: number,
): ContextItem[] {
  const rows = statements.listContextItems.all([contextRunId]) as ContextItemRow[];
  return rows.map(toContextItem);
}

function toContextRun(row: ContextRunRow): ContextRun {
  return {
    agent: row.agent,
    blobPath: row.blob_path,
    contextHash: row.context_hash,
    headCommit: row.head_commit,
    id: Number(row.id),
    promptHash: row.prompt_hash,
    runId: row.run_id,
    taskId: row.task_id,
    tokenBudget: row.token_budget,
    tokenCount: row.token_count,
  };
}

function toContextItem(row: ContextItemRow): ContextItem {
  return {
    contentHash: row.content_hash,
    contextRunId: Number(row.context_run_id),
    id: Number(row.id),
    kind: row.kind,
    path: row.path,
    reason: row.reason,
    score: row.score,
    ...(row.symbol !== null ? { symbol: row.symbol } : {}),
    tokenCount: row.token_count,
  };
}
