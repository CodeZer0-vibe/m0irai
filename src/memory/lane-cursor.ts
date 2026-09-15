/**
 * @file src/memory/lane-cursor.ts
 * @purpose ALL lane_cursors SQL (the I-1 acceptance record). The cursor is the ONLY durable "accepted"
 *   state: commitAcceptedCursor writes {generation, lastSeq} and clears the I-8 carry only when the
 *   accepted prompt carried the briefing; setBriefingCarry arms the durable re-carry flag WITHOUT touching
 *   generation/lastSeq (a fresh lane gets the generation-0 sentinel — an arm never fabricates an accepted
 *   position, r2-NB1). Callers (lane-state.ts) run these INSIDE their transactions; nothing here opens one.
 * @exports LaneCursorRow, CursorCommitInput, getLaneCursor, setBriefingCarry, commitAcceptedCursor
 * @depends ../evidence/db
 */
import type { Db } from "../evidence/db.js";

/** One lane_cursors row. generation 0 + lastSeq 0 is the SENTINEL: no accept has ever happened. */
export interface LaneCursorRow {
  readonly projectId: string;
  readonly agent: string;
  readonly generation: number;
  readonly lastSeq: number;
  readonly needsBriefingCarry: boolean;
  readonly updatedAt: string;
}

export interface CursorCommitInput {
  readonly projectId: string;
  readonly laneScopeId?: string;
  readonly agent: string;
  readonly generation: number;
  readonly lastSeq: number;
  /** True when the accepted prompt CARRIED the briefing (I-8: the accepted carry clears the flag). */
  readonly clearBriefingCarry: boolean;
  readonly now: string;
}

interface CursorDbRow {
  project_id: string;
  lane_scope_id: string;
  agent: string;
  generation: number;
  last_seq: number;
  needs_briefing_carry: number;
  updated_at: string;
}

/** Reads the lane cursor (the I-1 acceptance record), or undefined before any bump ever ran. */
export function getLaneCursor(
  db: Db,
  projectId: string,
  agent: string,
  laneScopeId = "",
): LaneCursorRow | undefined {
  const row = db
    .prepare(
      "SELECT * FROM lane_cursors WHERE project_id = ? AND lane_scope_id = ? AND agent = ? LIMIT 1",
    )
    .get(projectId, laneScopeId, agent) as CursorDbRow | undefined;
  if (row === undefined) {
    return undefined;
  }
  return {
    projectId: row.project_id,
    agent: row.agent,
    generation: row.generation,
    lastSeq: row.last_seq,
    needsBriefingCarry: row.needs_briefing_carry === 1,
    updatedAt: row.updated_at,
  };
}

/**
 * Arms the durable I-8 re-carry flag (detected OR inferred compaction; a generation bump uses it too).
 * Re-arms freely; preserves an existing cursor's generation/lastSeq; a missing row gets the sentinel.
 */
export function setBriefingCarry(
  db: Db,
  projectId: string,
  agent: string,
  now: string,
  laneScopeId = "",
): void {
  db.prepare(
    `INSERT INTO lane_cursors
       (project_id, lane_scope_id, agent, generation, last_seq, needs_briefing_carry, updated_at)
     VALUES (?, ?, ?, 0, 0, 1, ?)
     ON CONFLICT (project_id, lane_scope_id, agent) DO UPDATE SET
       needs_briefing_carry = 1, updated_at = excluded.updated_at`,
  ).run(projectId, laneScopeId, agent, now);
}

/**
 * The accepted-turn cursor write: commits {generation, lastSeq}, clearing the carry ONLY when told the
 * prompt carried the briefing. Runs inside the caller's transaction (advanceCursorOnAccept) — the
 * sentinel always exists by then (the bump created it), so the INSERT branch is in-contract unreachable
 * but still sound (a fresh row has nothing armed).
 */
export function commitAcceptedCursor(db: Db, input: CursorCommitInput): void {
  db.prepare(
    `INSERT INTO lane_cursors
       (project_id, lane_scope_id, agent, generation, last_seq, needs_briefing_carry, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT (project_id, lane_scope_id, agent) DO UPDATE SET
       generation = excluded.generation, last_seq = excluded.last_seq,
       needs_briefing_carry = CASE WHEN ? THEN 0 ELSE lane_cursors.needs_briefing_carry END,
       updated_at = excluded.updated_at`,
  ).run(
    input.projectId,
    input.laneScopeId ?? "",
    input.agent,
    input.generation,
    input.lastSeq,
    input.now,
    input.clearBriefingCarry ? 1 : 0,
  );
}
