/**
 * @file src/evidence/queries-statements.ts
 * @purpose Prepared-statement factories and their composite type for the evidence query layer.
 * @exports prepareStatements, BasePreparedStatements, ObservabilityPreparedStatements, PreparedStatements
 * @depends ./db
 */
import type { Db } from "./db.js";

export interface BasePreparedStatements {
  insertRun: ReturnType<Db["prepare"]>;
  updateRunStatus: ReturnType<Db["prepare"]>;
  insertTask: ReturnType<Db["prepare"]>;
  insertContextRun: ReturnType<Db["prepare"]>;
  insertContextItem: ReturnType<Db["prepare"]>;
  getContextRun: ReturnType<Db["prepare"]>;
  listContextItems: ReturnType<Db["prepare"]>;
  updateTaskStatus: ReturnType<Db["prepare"]>;
  insertFinding: ReturnType<Db["prepare"]>;
  selectFindingRowid: ReturnType<Db["prepare"]>;
  insertFindingFts: ReturnType<Db["prepare"]>;
  findFindingsByRunId: ReturnType<Db["prepare"]>;
  searchFindings: ReturnType<Db["prepare"]>;
  insertGateTransition: ReturnType<Db["prepare"]>;
  insertDispatch: ReturnType<Db["prepare"]>;
  findDispatchId: ReturnType<Db["prepare"]>;
  insertChatSession: ReturnType<Db["prepare"]>;
  insertChatMessage: ReturnType<Db["prepare"]>;
  insertChatWorkingSet: ReturnType<Db["prepare"]>;
  listChatWorkingSets: ReturnType<Db["prepare"]>;
  insertActiveDebate: ReturnType<Db["prepare"]>;
  getActiveDebate: ReturnType<Db["prepare"]>;
  deleteActiveDebate: ReturnType<Db["prepare"]>;
}

export interface ObservabilityPreparedStatements {
  nextEventSequence: ReturnType<Db["prepare"]>;
  insertEvent: ReturnType<Db["prepare"]>;
  getEventById: ReturnType<Db["prepare"]>;
  insertError: ReturnType<Db["prepare"]>;
  queryErrors: ReturnType<Db["prepare"]>;
  queryErrorsByRun: ReturnType<Db["prepare"]>;
  queryErrorsByCode: ReturnType<Db["prepare"]>;
  queryErrorsByRunAndCode: ReturnType<Db["prepare"]>;
  queryEventsByRun: ReturnType<Db["prepare"]>;
  getLatestStateSnapshot: ReturnType<Db["prepare"]>;
}

export type PreparedStatements = BasePreparedStatements & ObservabilityPreparedStatements;

const FTS_ROW_SELECT: string = "SELECT rowid FROM findings WHERE id = ?";

export function prepareStatements(db: Db): PreparedStatements {
  return {
    ...prepareBaseStatements(db),
    ...prepareObservabilityStatements(db),
  };
}

function prepareBaseStatements(db: Db): BasePreparedStatements {
  return {
    insertRun: db.prepare(
      "INSERT OR IGNORE INTO runs (id, vision, started_at) VALUES (@id, @vision, @startedAt)",
    ),
    updateRunStatus: db.prepare(
      "UPDATE runs SET status = @status, completed_at = @completedAt WHERE id = @id",
    ),
    insertTask: db.prepare(
      // status is written EXPLICITLY as the schema default 'pending' (schema.sql:38) so the insert also
      // satisfies DEPLOYED-legacy DBs whose tasks.status is NOT NULL with NO default (an older schema
      // generation) — omitting it throws `NOT NULL constraint failed: tasks.status` on those DBs.
      "INSERT INTO tasks (id, run_id, objective, agent, status, owned_files, forbidden_files, acceptance) VALUES (@id, @runId, @objective, @agent, 'pending', @ownedFiles, @forbiddenFiles, @acceptance)",
    ),
    updateTaskStatus: db.prepare(
      "UPDATE tasks SET status = @status, result = @result, head_commit = @headCommit WHERE id = @id",
    ),
    ...prepareContextStatements(db),
    ...prepareFindingStatements(db),
    ...prepareGateAndDispatchStatements(db),
    ...prepareChatStatements(db),
  };
}

function prepareContextStatements(
  db: Db,
): Pick<
  BasePreparedStatements,
  "insertContextRun" | "insertContextItem" | "getContextRun" | "listContextItems"
> {
  return {
    insertContextRun: db.prepare(
      "INSERT INTO context_runs (id, task_id, agent, head_commit, prompt_hash, context_hash, token_count, token_budget, blob_path) VALUES (@id, @taskId, @agent, @headCommit, @promptHash, @contextHash, @tokenCount, @tokenBudget, @blobPath)",
    ),
    insertContextItem: db.prepare(
      "INSERT INTO context_items (id, context_run_id, kind, path, symbol, content_hash, token_count, score, reason) VALUES (@id, @contextRunId, @kind, @path, @symbol, @contentHash, @tokenCount, @score, @reason)",
    ),
    getContextRun: db.prepare(
      "SELECT cr.id, cr.task_id, t.run_id, cr.agent, cr.head_commit, cr.prompt_hash, cr.context_hash, cr.token_count, cr.token_budget, cr.blob_path FROM context_runs cr JOIN tasks t ON t.id = cr.task_id WHERE t.run_id = ? AND cr.task_id = ? LIMIT 1",
    ),
    listContextItems: db.prepare(
      "SELECT id, context_run_id, kind, path, symbol, content_hash, token_count, score, reason FROM context_items WHERE context_run_id = ? ORDER BY id",
    ),
  };
}

function prepareFindingStatements(
  db: Db,
): Pick<
  BasePreparedStatements,
  | "insertFinding"
  | "selectFindingRowid"
  | "insertFindingFts"
  | "findFindingsByRunId"
  | "searchFindings"
> {
  return {
    insertFinding: db.prepare(
      "INSERT OR IGNORE INTO findings (id, task_id, run_id, severity, path, line, finding, status, source_agent, reviewer_context_hash) VALUES (@id, @taskId, @runId, @severity, @path, @line, @finding, @status, @sourceAgent, @reviewerContextHash)",
    ),
    selectFindingRowid: db.prepare(FTS_ROW_SELECT),
    insertFindingFts: db.prepare("INSERT INTO findings_fts(rowid, finding) VALUES (?, ?)"),
    findFindingsByRunId: db.prepare(
      "SELECT severity, path, line, finding, source_agent AS sourceAgent FROM findings WHERE run_id = ? ORDER BY CASE severity WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END, rowid DESC",
    ),
    searchFindings: db.prepare(
      "SELECT f.severity, f.path, f.line, f.finding FROM findings_fts x JOIN findings f ON f.rowid = x.rowid WHERE findings_fts MATCH ? ORDER BY rank LIMIT ?",
    ),
  };
}

function prepareGateAndDispatchStatements(
  db: Db,
): Pick<BasePreparedStatements, "insertGateTransition" | "insertDispatch" | "findDispatchId"> {
  return {
    insertGateTransition: db.prepare(
      "INSERT INTO gate_transitions (id, run_id, from_state, to_state, gate_name, passed, evidence_json) VALUES (@idPrefix || lower(hex(randomblob(16))), @runId, @fromState, @toState, @gateName, @passed, @evidenceJson) ON CONFLICT(run_id, gate_name) DO UPDATE SET from_state=excluded.from_state, to_state=excluded.to_state, passed=excluded.passed, evidence_json=excluded.evidence_json",
    ),
    insertDispatch: db.prepare(
      "INSERT OR IGNORE INTO dispatches (id, task_id, agent, command_hash, exit_code, stdout_blob, stderr_blob, diff_blob, duration_ms, tokens_in, tokens_out, argv_json, cwd, env_allowlist_version, context_blob_hash, model_version, repo_commit) VALUES (@idPrefix || lower(hex(randomblob(16))), @taskId, @agent, @commandHash, @exitCode, @stdoutBlob, @stderrBlob, @diffBlob, @durationMs, @tokensIn, @tokensOut, @argvJson, @cwd, @envAllowlistVersion, @contextBlobHash, @modelVersion, @repoCommit)",
    ),
    findDispatchId: db.prepare(
      "SELECT id FROM dispatches WHERE task_id = ? AND agent = ? AND command_hash = ? LIMIT 1",
    ),
  };
}

function prepareChatStatements(
  db: Db,
): Pick<
  BasePreparedStatements,
  | "insertChatSession"
  | "insertChatMessage"
  | "insertChatWorkingSet"
  | "listChatWorkingSets"
  | "insertActiveDebate"
  | "getActiveDebate"
  | "deleteActiveDebate"
> {
  return {
    insertChatSession: db.prepare(
      "INSERT INTO chat_sessions (id, run_id, repo_root, run_dir, created_at, updated_at, default_agent, last_agent, summary_text, summary_through_turn, project_id) VALUES (@id, @runId, @repoRoot, @runDir, @createdAt, @updatedAt, @defaultAgent, @lastAgent, @summaryText, @summaryThroughTurn, @projectId) ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id, repo_root=excluded.repo_root, run_dir=excluded.run_dir, created_at=excluded.created_at, updated_at=excluded.updated_at, default_agent=excluded.default_agent, last_agent=excluded.last_agent, summary_text=excluded.summary_text, summary_through_turn=excluded.summary_through_turn, project_id=COALESCE(excluded.project_id, chat_sessions.project_id)",
    ),
    insertChatMessage: db.prepare(
      "INSERT OR IGNORE INTO chat_messages (id, session_id, turn, round, role, agent, text_blob_hash, created_at, status, token_estimate, dispatch_id, dispatched_agents) VALUES (@id, @sessionId, @turn, @round, @role, @agent, @textBlobHash, @createdAt, @status, @tokenEstimate, @dispatchId, @dispatchedAgents)",
    ),
    insertChatWorkingSet: db.prepare(
      "INSERT INTO chat_working_sets (id, session_id, turn, round, agent, context_blob_hash, peer_refs, outcome, token_estimate, created_at) VALUES (@id, @sessionId, @turn, @round, @agent, @contextBlobHash, @peerRefs, @outcome, @tokenEstimate, @createdAt)",
    ),
    listChatWorkingSets: db.prepare(
      "SELECT id, session_id, turn, round, agent, context_blob_hash, peer_refs, outcome, token_estimate, created_at FROM chat_working_sets WHERE session_id = ? AND turn = ? AND round = ? ORDER BY agent",
    ),
    insertActiveDebate: db.prepare(
      "INSERT OR IGNORE INTO active_debates (session_id, turn, started_at) VALUES (@sessionId, @turn, @startedAt)",
    ),
    getActiveDebate: db.prepare(
      "SELECT session_id, turn, started_at FROM active_debates WHERE session_id = ? LIMIT 1",
    ),
    deleteActiveDebate: db.prepare("DELETE FROM active_debates WHERE session_id = ?"),
  };
}

function prepareObservabilityStatements(db: Db): ObservabilityPreparedStatements {
  return {
    nextEventSequence: db.prepare(
      "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM events WHERE run_id = ?",
    ),
    insertEvent: db.prepare(
      "INSERT INTO events (id, run_id, sequence, kind, phase, task_id, error_id, trace_id, span_id, parent_span_id, payload_json) VALUES (@id, @runId, @sequence, @kind, @phase, @taskId, @errorId, @traceId, @spanId, @parentSpanId, @payloadJson)",
    ),
    getEventById: db.prepare("SELECT * FROM events WHERE id = ? LIMIT 1"),
    insertError: db.prepare(
      "INSERT INTO errors (id, run_id, task_id, dispatch_id, gate_transition_id, code, category, retryability, message, cause_code, evidence_json, evidence_blob, fingerprint, trace_id, span_id) VALUES (@id, @runId, @taskId, @dispatchId, @gateTransitionId, @code, @category, @retryability, @message, @causeCode, @evidenceJson, @evidenceBlob, @fingerprint, @traceId, @spanId)",
    ),
    queryErrors: db.prepare("SELECT * FROM errors ORDER BY created_at DESC LIMIT ?"),
    queryErrorsByRun: db.prepare(
      "SELECT * FROM errors WHERE run_id = ? ORDER BY created_at DESC LIMIT ?",
    ),
    queryErrorsByCode: db.prepare(
      "SELECT * FROM errors WHERE code = ? ORDER BY created_at DESC LIMIT ?",
    ),
    queryErrorsByRunAndCode: db.prepare(
      "SELECT * FROM errors WHERE run_id = ? AND code = ? ORDER BY created_at DESC LIMIT ?",
    ),
    queryEventsByRun: db.prepare(
      "SELECT * FROM events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?",
    ),
    getLatestStateSnapshot: db.prepare(
      "SELECT * FROM events WHERE run_id = ? AND kind = ? ORDER BY sequence DESC LIMIT 1",
    ),
  };
}
