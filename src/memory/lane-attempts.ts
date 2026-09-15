/**
 * @file src/memory/lane-attempts.ts
 * @purpose ALL lane_prompt_attempts SQL — the I-1 pre-send intent ledger. recordPromptAttempt writes the
 *   durable intent BEFORE every delta send (resolved NULL = in flight); resolveAttemptAccepted flips ONLY
 *   an unresolved row matching the claimed (generation, session_id) pair; abandonPriorGenerationAttempts
 *   is the bump's atomic abandon (r3-NB1). Unresolved rows are recovery evidence: the recovery read scopes
 *   to the CURRENT pair, and pruning structurally cannot touch unresolved rows. Mutations here run inside
 *   lane-state.ts transactions; nothing here opens one. Constraint violations propagate as SqliteError.
 * @exports LanePromptAttemptRow, PromptAttemptInput, UnresolvedAttemptQuery, RESOLVED_ATTEMPTS_KEEP, recordPromptAttempt, getPromptAttempt, listUnresolvedAttempts, abandonPriorGenerationAttempts, resolveAttemptAccepted, markAttemptAbortedAfterAccept, listAbortedAttempts, pruneResolvedAttempts
 * @depends ../evidence/db
 */
import type { Db } from "../evidence/db.js";

/** One lane_prompt_attempts row. resolved null = in flight / recovery evidence (never pruned). */
export interface LanePromptAttemptRow {
  readonly attemptId: string;
  readonly projectId: string;
  readonly agent: string;
  readonly generation: number;
  readonly sessionId: string;
  readonly seqFrom: number;
  readonly seqTo: number;
  readonly sentAt: string;
  readonly resolved: "accepted" | "abandoned" | null;
  /** FL-150: set when this prompt was accepted by the agent while its turn was ALREADY ABORTED — the
   *  operator pressed Esc and was answered anyway. NULL on every ordinary attempt, which is all of
   *  them when the room is behaving. See {@link markAttemptAbortedAfterAccept}. */
  readonly abortedAt: string | null;
}

export interface PromptAttemptInput {
  readonly attemptId: string;
  readonly projectId: string;
  readonly laneScopeId?: string;
  readonly agent: string;
  readonly generation: number;
  readonly sessionId: string;
  readonly seqFrom: number;
  readonly seqTo: number;
  readonly sentAt: string;
}

export type UnresolvedAttemptQuery = Pick<
  PromptAttemptInput,
  "projectId" | "laneScopeId" | "agent" | "generation" | "sessionId"
>;

/** The plan's growth cap: resolved attempts beyond the newest 200 per lane are prunable (§5). */
export const RESOLVED_ATTEMPTS_KEEP = 200;

interface AttemptDbRow {
  attempt_id: string;
  project_id: string;
  lane_scope_id: string;
  agent: string;
  generation: number;
  session_id: string;
  seq_from: number;
  seq_to: number;
  sent_at: string;
  resolved: string | null;
  aborted_at: string | null;
}

function decodeAttempt(row: AttemptDbRow): LanePromptAttemptRow {
  return {
    attemptId: row.attempt_id,
    projectId: row.project_id,
    agent: row.agent,
    generation: row.generation,
    sessionId: row.session_id,
    seqFrom: row.seq_from,
    seqTo: row.seq_to,
    sentAt: row.sent_at,
    resolved: row.resolved as LanePromptAttemptRow["resolved"],
    abortedAt: row.aborted_at ?? null,
  };
}

/** Writes the I-1 pre-send intent row (resolved NULL = in flight). Called BEFORE every delta send. */
export function recordPromptAttempt(db: Db, input: PromptAttemptInput): void {
  db.prepare(
    `INSERT INTO lane_prompt_attempts
      (attempt_id, project_id, lane_scope_id, agent, generation, session_id, seq_from, seq_to, sent_at,
       resolved)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    input.attemptId,
    input.projectId,
    input.laneScopeId ?? "",
    input.agent,
    input.generation,
    input.sessionId,
    input.seqFrom,
    input.seqTo,
    input.sentAt,
  );
}

/** Reads one attempt row by id (recovery/trace support). */
export function getPromptAttempt(db: Db, attemptId: string): LanePromptAttemptRow | undefined {
  const row = db
    .prepare("SELECT * FROM lane_prompt_attempts WHERE attempt_id = ? LIMIT 1")
    .get(attemptId) as AttemptDbRow | undefined;
  return row === undefined ? undefined : decodeAttempt(row);
}

/**
 * The I-1 recovery read: unresolved attempts for the CURRENT (generation, sessionId) pair ONLY — an
 * abandoned prior generation's rows are never classified (they don't match, and they're resolved anyway).
 */
export function listUnresolvedAttempts(
  db: Db,
  input: UnresolvedAttemptQuery,
): LanePromptAttemptRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM lane_prompt_attempts
       WHERE project_id = ? AND lane_scope_id = ? AND agent = ? AND generation = ?
         AND session_id = ? AND resolved IS NULL
       ORDER BY sent_at DESC
       LIMIT 100`,
    )
    .all(
      input.projectId,
      input.laneScopeId ?? "",
      input.agent,
      input.generation,
      input.sessionId,
    ) as AttemptDbRow[];
  return rows.map(decodeAttempt);
}

/**
 * The bump's atomic abandon (I-1 r3-NB1): every unresolved attempt from a generation BEFORE the new one
 * flips to `abandoned`. Runs inside bumpGeneration's transaction.
 *
 * @returns how many attempts were abandoned
 */
export function abandonPriorGenerationAttempts(
  db: Db,
  projectId: string,
  agent: string,
  newGeneration: number,
  laneScopeId = "",
): number {
  const result = db
    .prepare(
      `UPDATE lane_prompt_attempts SET resolved = 'abandoned'
       WHERE project_id = ? AND lane_scope_id = ? AND agent = ?
         AND generation < ? AND resolved IS NULL`,
    )
    .run(projectId, laneScopeId, agent, newGeneration);
  return result.changes;
}

/**
 * Resolves ONE unresolved attempt `accepted` — only when it matches the claimed (generation, session_id)
 * pair (I-1: a cursor commit resolves ONLY the attempt matching the active pair). Runs inside
 * advanceCursorOnAccept's transaction.
 *
 * @returns true when exactly one row flipped; false = no matching unresolved attempt
 */
export function resolveAttemptAccepted(
  db: Db,
  input: Pick<
    PromptAttemptInput,
    "attemptId" | "projectId" | "laneScopeId" | "agent" | "generation" | "sessionId"
  >,
): boolean {
  const result = db
    .prepare(
      `UPDATE lane_prompt_attempts SET resolved = 'accepted'
       WHERE attempt_id = ? AND project_id = ? AND lane_scope_id = ? AND agent = ?
         AND generation = ? AND session_id = ? AND resolved IS NULL`,
    )
    .run(
      input.attemptId,
      input.projectId,
      input.laneScopeId ?? "",
      input.agent,
      input.generation,
      input.sessionId,
    );
  return result.changes === 1;
}

/**
 * FL-150 ROUND 2 (review P2-A) — THE DURABLE RECORD OF "IT ANSWERED THROUGH MY ESC".
 *
 * Stamps an attempt whose prompt the agent ACCEPTED while the turn was already aborted. That is the
 * operator's original symptom, and until now the only trace of it was a WARN on a stderr stream nobody
 * reads: `claimScreen()` has no production caller so the file sink is never taken, and in the packaged
 * app the host's stderr lands in a 64 KB ring in the Rust launcher that no production code opens. A row
 * survives the process; a log line did not.
 *
 * `resolved` is deliberately untouched — the prompt genuinely WAS accepted and the cursor genuinely
 * must advance, so this records the extra fact ALONGSIDE that truth rather than overwriting it. The two
 * columns answer different questions: `resolved` is "did the agent take it", `aborted_at` is "had the
 * operator already said stop".
 *
 * Matches on attempt_id alone: the caller minted that id for this turn and holds it, and by this point
 * the row's `resolved` may already have flipped, so re-checking the (generation, session_id) pair would
 * only re-derive what the id already pins.
 *
 * @returns true when the row was stamped; false when there was no such attempt to stamp
 */
export function markAttemptAbortedAfterAccept(
  db: Db,
  input: { readonly attemptId: string; readonly abortedAt: string },
): boolean {
  const result = db
    .prepare("UPDATE lane_prompt_attempts SET aborted_at = ? WHERE attempt_id = ?")
    .run(input.abortedAt, input.attemptId);
  return result.changes === 1;
}

/**
 * Every prompt this project ever delivered through a cancel, newest first — the read a human opens
 * afterwards to answer "did it really answer me after I stopped it, and how often". Bounded by an
 * explicit LIMIT because an unbounded read of a growing table is how a diagnostic becomes an outage.
 */
export function listAbortedAttempts(
  db: Db,
  projectId: string,
  limit = 100,
): LanePromptAttemptRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM lane_prompt_attempts
       WHERE project_id = ? AND aborted_at IS NOT NULL
       ORDER BY aborted_at DESC
       LIMIT ?`,
    )
    .all(projectId, limit) as AttemptDbRow[];
  return rows.map(decodeAttempt);
}

/**
 * Deletes resolved attempts beyond the newest keepNewest per lane (§5 growth cap). The `resolved IS NOT
 * NULL` predicate in BOTH the delete and the keep-window makes unresolved rows structurally unreachable —
 * they are recovery evidence and are NEVER pruned.
 *
 * @returns the number of rows deleted
 */
export function pruneResolvedAttempts(
  db: Db,
  projectId: string,
  agent: string,
  keepNewest: number = RESOLVED_ATTEMPTS_KEEP,
  laneScopeId = "",
): number {
  const result = db
    .prepare(
      `DELETE FROM lane_prompt_attempts
       WHERE project_id = ? AND lane_scope_id = ? AND agent = ? AND resolved IS NOT NULL
         AND attempt_id NOT IN (
           SELECT attempt_id FROM lane_prompt_attempts
           WHERE project_id = ? AND lane_scope_id = ? AND agent = ? AND resolved IS NOT NULL
           ORDER BY sent_at DESC, attempt_id DESC
           LIMIT ?
         )`,
    )
    .run(projectId, laneScopeId, agent, projectId, laneScopeId, agent, keepNewest);
  return result.changes;
}
