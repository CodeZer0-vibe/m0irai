/**
 * @file src/chat/turn-lifecycle.ts
 * @purpose The honest turn/lane lifecycle model (F-2). A lane moves routing→working→{completed|failed|
 *   timed_out|cancelled}; a turn AGGREGATES its lanes' terminals into one TurnState by a fixed precedence
 *   that never hides a success (abort-with-a-win → `partial`, not `cancelled`). Pure + deterministic — the
 *   live path classifies each lane's terminal and calls aggregateTurn; today every failure collapses to
 *   "failed", and distinguishing timeout/cancel/fail is the point.
 * @exports LaneState, LaneTerminal, TurnState, canTransition, assertTransition, aggregateTurn, classifyLaneError
 * @depends (none — pure model)
 */

/** A lane's lifecycle state: two in-flight (routing, working) + five terminal. `interrupted` (U2e-c #8) is
 *  a terminal with NO incoming live edge — it is synthesized ONLY on resume for a hard-killed lane (never
 *  reached by a live transition, so the live path can never construct it). */
export type LaneState =
  | "routing"
  | "working"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "interrupted";

/** The terminal subset of LaneState — the states a finished lane can rest in. `interrupted` is failure-grade
 *  (aggregateTurn seals it as a failure) but resume-only (no live producer). */
export type LaneTerminal = "completed" | "failed" | "timed_out" | "cancelled" | "interrupted";

/** The whole turn's outcome, aggregated from its lanes' terminals (see {@link aggregateTurn}). */
export type TurnState = "completed" | "partial" | "failed" | "timed_out" | "cancelled";

/**
 * THE lane-error classifier (hygiene wave H2: previously duplicated in headless-turn + a WEAKER twin in
 * headless-carrier that dropped the execa `timedOut` flag — the same drift class as the child-env
 * allowlists). Abort wins (cancelled); execa's timedOut flag OR the known cap phrasings (dispatch-pty's
 * "timed out:", the raw idle-cap "appears hung" / "no output for", turncap/deadline) → timed_out, so a
 * timeout is never mislabeled `failed`; everything else fails honestly.
 */
export function classifyLaneError(error: unknown, signal: AbortSignal): LaneTerminal {
  if (signal.aborted) {
    return "cancelled";
  }
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  const timedOut =
    typeof error === "object" &&
    error !== null &&
    (error as { timedOut?: unknown }).timedOut === true;
  if (
    timedOut ||
    /turncap|timed.?out|timeout|idle.?cap|deadline|appears hung|no output for/i.test(text)
  ) {
    return "timed_out";
  }
  return "failed";
}

// The legal forward transitions. Terminals are SINKS (no outgoing edge) — a finished lane cannot be
// resurrected, so a late/duplicate event can never flip a completed lane back to working.
const LEGAL: Readonly<Record<LaneState, readonly LaneState[]>> = {
  // `interrupted` is deliberately ABSENT as a target here — no live transition reaches it (routing/working
  // can only settle to a normally-observed terminal). It is a sink (no outgoing edge) that resume synthesizes.
  routing: ["working", "completed", "failed", "timed_out", "cancelled"],
  working: ["completed", "failed", "timed_out", "cancelled"],
  completed: [],
  failed: [],
  timed_out: [],
  cancelled: [],
  interrupted: [],
};

/** Whether a lane may move `from` → `to` (a terminal has no legal outgoing transition). */
export function canTransition(from: LaneState, to: LaneState): boolean {
  return LEGAL[from].includes(to);
}

/** Asserts a legal transition; throws naming the illegal move (the guard at the state-write boundary). */
export function assertTransition(from: LaneState, to: LaneState): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal lane transition: ${from} → ${to}`);
  }
}

/**
 * Aggregates the lanes' terminal states into the turn's outcome by a fixed precedence:
 *   1. all completed (or no lanes)     → completed
 *   2. >=1 completed AND >=1 not       → partial    (a success is NEVER hidden — a sibling's abort/fail/
 *                                                     timeout downgrades the turn to partial, not its cause)
 *   3. (0 completed) any cancelled     → cancelled  (operator stopped it; nothing finished)
 *   4. (0 completed) all timed_out     → timed_out
 *   5. otherwise (a failure present)   → failed      (a failure dominates a bare timeout when mixed)
 *
 * @param terminals - one terminal state per lane in the turn (order-independent)
 * @returns the single TurnState the cockpit shows for the turn
 */
export function aggregateTurn(terminals: readonly LaneTerminal[]): TurnState {
  if (terminals.length === 0 || terminals.every((t) => t === "completed")) {
    return "completed";
  }
  if (terminals.includes("completed")) {
    return "partial";
  }
  if (terminals.includes("cancelled")) {
    return "cancelled";
  }
  if (terminals.every((t) => t === "timed_out")) {
    return "timed_out";
  }
  return "failed";
}
