/**
 * @file src/memory/lane-state.ts
 * @purpose MT7 lane session, cursor, and prompt-attempt store facade.
 * @exports LaneBinding, LaneSessionRow, BumpGenerationInput, BumpGenerationOptions, BumpGenerationResult, AdvanceCursorInput, AdvanceCursorOptions, AdvanceRefusalReason, AdvanceCursorResult, CursorCommitRetryPolicy, CURSOR_COMMIT_RETRY, getLaneSession, laneBindingMatches, bumpGeneration, touchResumed, advanceCursorOnAccept, getLaneCursor, setBriefingCarry, RESOLVED_ATTEMPTS_KEEP, recordPromptAttempt, getPromptAttempt, listUnresolvedAttempts, markAttemptAbortedAfterAccept, listAbortedAttempts, pruneResolvedAttempts
 * @depends ../evidence/db, ./lane-attempts, ./lane-cursor
 */
import type { Db } from "../evidence/db.js";
import { abandonPriorGenerationAttempts, resolveAttemptAccepted } from "./lane-attempts.js";
import { commitAcceptedCursor, setBriefingCarry } from "./lane-cursor.js";

export {
  RESOLVED_ATTEMPTS_KEEP,
  getPromptAttempt,
  listAbortedAttempts,
  listUnresolvedAttempts,
  markAttemptAbortedAfterAccept,
  pruneResolvedAttempts,
  recordPromptAttempt,
} from "./lane-attempts.js";
export type { LanePromptAttemptRow, PromptAttemptInput } from "./lane-attempts.js";
export { getLaneCursor, setBriefingCarry } from "./lane-cursor.js";
export type { LaneCursorRow } from "./lane-cursor.js";

/** The I-2 resume-time binding components (project+scope+agent are the lookup key). */
export interface LaneBinding {
  readonly cwd: string;
  readonly adapterPkg: string;
  readonly adapterVersion: string;
}

/** One lane_sessions row — the active native session for (project, lane scope, agent), decoded camelCase. */
export interface LaneSessionRow {
  readonly projectId: string;
  readonly agent: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly cwd: string;
  readonly adapterPkg: string;
  readonly adapterVersion: string;
  readonly createdAt: string;
  readonly lastResumedAt: string | null;
}

export interface BumpGenerationInput {
  readonly projectId: string;
  readonly laneScopeId?: string;
  readonly agent: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly adapterPkg: string;
  readonly adapterVersion: string;
  readonly now: string;
}

export interface BumpGenerationOptions {
  /** Test-only seam fired INSIDE the transaction between the abandon and the session write (the
   *  journal-store beforeInsert pattern) — proves atomicity by throwing mid-flight. */
  readonly beforeSessionWrite?: () => void;
}

export interface BumpGenerationResult {
  readonly generation: number;
  readonly abandonedAttempts: number;
}

export interface AdvanceCursorInput {
  readonly projectId: string;
  readonly laneScopeId?: string;
  readonly agent: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly sessionId: string;
  readonly lastSeq: number;
  /** True when the accepted prompt CARRIED the briefing (I-8: the accepted carry clears the flag). */
  readonly clearBriefingCarry: boolean;
  readonly now: string;
}

export interface AdvanceCursorOptions {
  readonly retry?: CursorCommitRetryPolicy;
  /** Injected backoff sleeper (controlled-clock testing); defaults to a real setTimeout delay. */
  readonly delayFn?: (ms: number) => Promise<void>;
}

export type AdvanceRefusalReason =
  | "noActiveSession"
  | "staleGeneration"
  | "sessionMismatch"
  | "attemptMissing";

export type AdvanceCursorResult =
  | { readonly outcome: "advanced" }
  | {
      readonly outcome: "refused";
      readonly reason: AdvanceRefusalReason;
      readonly activeGeneration?: number;
    }
  | { readonly outcome: "commitFailed"; readonly attempts: number; readonly cause: unknown };

export interface CursorCommitRetryPolicy {
  readonly retries: number;
  readonly backoffMs: readonly number[];
}

/** The F-14 ladder the plan pins: 3 retries at 150/300/600ms after the initial attempt. */
export const CURSOR_COMMIT_RETRY: CursorCommitRetryPolicy = {
  retries: 3,
  backoffMs: [150, 300, 600],
};

interface SessionDbRow {
  project_id: string;
  lane_scope_id: string;
  agent: string;
  session_id: string;
  generation: number;
  cwd: string;
  adapter_pkg: string;
  adapter_version: string;
  created_at: string;
  last_resumed_at: string | null;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Extended busy codes all share the SQLITE_BUSY prefix (SQLITE_BUSY_SNAPSHOT/_RECOVERY/_TIMEOUT);
// SQLITE_LOCKED is the same-connection table-lock sibling. Everything else is NOT transient.
function isBusyError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const code = (err as Error & { code?: unknown }).code;
  return typeof code === "string" && (code.startsWith("SQLITE_BUSY") || code === "SQLITE_LOCKED");
}

function isSqliteError(err: unknown): boolean {
  return err instanceof Error && typeof (err as Error & { code?: unknown }).code === "string";
}

/** Reads the lane's active session row, or undefined when the lane has never opened a generation. */
export function getLaneSession(
  db: Db,
  projectId: string,
  agent: string,
  laneScopeId = "",
): LaneSessionRow | undefined {
  const row = db
    .prepare(
      "SELECT * FROM lane_sessions WHERE project_id = ? AND lane_scope_id = ? AND agent = ? LIMIT 1",
    )
    .get(projectId, laneScopeId, agent) as SessionDbRow | undefined;
  if (row === undefined) {
    return undefined;
  }
  return {
    projectId: row.project_id,
    agent: row.agent,
    sessionId: row.session_id,
    generation: row.generation,
    cwd: row.cwd,
    adapterPkg: row.adapter_pkg,
    adapterVersion: row.adapter_version,
    createdAt: row.created_at,
    lastResumedAt: row.last_resumed_at,
  };
}

/** I-2: the stored binding matches the current environment on EVERY component, or the id is invalid. */
export function laneBindingMatches(session: LaneSessionRow, binding: LaneBinding): boolean {
  return (
    session.cwd === binding.cwd &&
    session.adapterPkg === binding.adapterPkg &&
    session.adapterVersion === binding.adapterVersion
  );
}

/**
 * Opens the lane's next session generation (I-7). ONE immediate transaction: abandon every unresolved
 * prior-generation attempt (I-1 r3-NB1), supersede the lane_sessions row (created_at = the NEW session's
 * birth; last_resumed_at reset), and arm the durable briefing carry — WITHOUT touching the cursor's
 * generation/lastSeq (r2-NB1; a missing cursor gets the generation-0 sentinel). Generation 1 is the
 * degenerate bump from nothing.
 *
 * @param db - lane-state handle from openLaneStateDb
 * @param input - lane key + the new session's binding tuple + caller clock
 * @param options - test-only atomicity seam
 * @returns the new generation number and how many attempts were abandoned
 * @throws the underlying SqliteError on constraint violations (e.g., unknown project)
 * @example
 * const { generation } = bumpGeneration(db, { projectId, agent: "claude", sessionId, cwd, adapterPkg, adapterVersion, now });
 */
export function bumpGeneration(
  db: Db,
  input: BumpGenerationInput,
  options?: BumpGenerationOptions,
): BumpGenerationResult {
  const run = db.transaction((): BumpGenerationResult => {
    const laneScopeId = input.laneScopeId ?? "";
    const prior = getLaneSession(db, input.projectId, input.agent, laneScopeId);
    const generation = (prior?.generation ?? 0) + 1;
    const abandonedAttempts = abandonPriorGenerationAttempts(
      db,
      input.projectId,
      input.agent,
      generation,
      laneScopeId,
    );
    options?.beforeSessionWrite?.();
    db.prepare(
      `INSERT INTO lane_sessions
         (project_id, lane_scope_id, agent, session_id, generation, cwd, adapter_pkg,
          adapter_version, created_at, last_resumed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT (project_id, lane_scope_id, agent) DO UPDATE SET
         session_id = excluded.session_id, generation = excluded.generation, cwd = excluded.cwd,
         adapter_pkg = excluded.adapter_pkg, adapter_version = excluded.adapter_version,
         created_at = excluded.created_at, last_resumed_at = NULL`,
    ).run(
      input.projectId,
      laneScopeId,
      input.agent,
      input.sessionId,
      generation,
      input.cwd,
      input.adapterPkg,
      input.adapterVersion,
      input.now,
    );
    setBriefingCarry(db, input.projectId, input.agent, input.now, laneScopeId);
    return { generation, abandonedAttempts };
  });
  return run.immediate();
}

/** Stamps last_resumed_at after a successful native resume (T3's write). Binding stays untouched. */
export function touchResumed(
  db: Db,
  projectId: string,
  agent: string,
  now: string,
  laneScopeId = "",
): void {
  db.prepare(
    `UPDATE lane_sessions SET last_resumed_at = ?
     WHERE project_id = ? AND lane_scope_id = ? AND agent = ?`,
  ).run(now, projectId, laneScopeId, agent);
}

function runAcceptCommit(db: Db, input: AdvanceCursorInput): AdvanceCursorResult {
  const session = getLaneSession(db, input.projectId, input.agent, input.laneScopeId ?? "");
  if (session === undefined) {
    return { outcome: "refused", reason: "noActiveSession" };
  }
  if (session.generation !== input.generation) {
    return {
      outcome: "refused",
      reason: "staleGeneration",
      activeGeneration: session.generation,
    };
  }
  if (session.sessionId !== input.sessionId) {
    return {
      outcome: "refused",
      reason: "sessionMismatch",
      activeGeneration: session.generation,
    };
  }
  const resolved = resolveAttemptAccepted(db, {
    attemptId: input.attemptId,
    projectId: input.projectId,
    ...(input.laneScopeId === undefined ? {} : { laneScopeId: input.laneScopeId }),
    agent: input.agent,
    generation: input.generation,
    sessionId: input.sessionId,
  });
  if (!resolved) {
    return { outcome: "refused", reason: "attemptMissing", activeGeneration: session.generation };
  }
  commitAcceptedCursor(db, {
    projectId: input.projectId,
    ...(input.laneScopeId === undefined ? {} : { laneScopeId: input.laneScopeId }),
    agent: input.agent,
    generation: input.generation,
    lastSeq: input.lastSeq,
    clearBriefingCarry: input.clearBriefingCarry,
    now: input.now,
  });
  return { outcome: "advanced" };
}

/**
 * The I-1 acceptance commit: in ONE immediate transaction, resolve the attempt `accepted` (ONLY when it
 * matches the ACTIVE lane_sessions (generation, session_id) — anything else is a distinct refusal with
 * zero writes) and commit the cursor via lane-cursor.ts. Busy-class failures retry the F-14 ladder
 * OUTSIDE the transaction; a non-busy sqlite failure (or an exhausted ladder) reports `commitFailed` —
 * the cursor is not advanced anywhere, the attempt stays unresolved, and the CALLER decides (T5 emits
 * the trace/notice).
 *
 * @param db - lane-state handle from openLaneStateDb
 * @param input - the accepted turn's lane key, attempt id, pair claim, new cursor position, carry clear
 * @param options - retry policy + injected backoff sleeper (tests)
 * @returns advanced | refused{reason} | commitFailed{attempts, cause}
 * @example
 * const result = await advanceCursorOnAccept(db, { projectId, agent, attemptId, generation, sessionId, lastSeq, clearBriefingCarry, now });
 */
export async function advanceCursorOnAccept(
  db: Db,
  input: AdvanceCursorInput,
  options?: AdvanceCursorOptions,
): Promise<AdvanceCursorResult> {
  const retry = options?.retry ?? CURSOR_COMMIT_RETRY;
  const delayFn = options?.delayFn ?? delay;
  const maxAttempts = 1 + retry.retries;
  const commit = db.transaction((): AdvanceCursorResult => runAcceptCommit(db, input));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return commit.immediate();
    } catch (err) {
      if (!isSqliteError(err)) {
        throw err;
      }
      if (!isBusyError(err) || attempt === maxAttempts) {
        return { outcome: "commitFailed", attempts: attempt, cause: err };
      }
      const backoff =
        retry.backoffMs[attempt - 1] ?? retry.backoffMs[retry.backoffMs.length - 1] ?? 0;
      await delayFn(backoff);
    }
  }
  // Unreachable: the loop always returns or throws by attempt === maxAttempts.
  throw new Error("advanceCursorOnAccept: retry loop exited without a result");
}
