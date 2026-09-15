/**
 * @file src/chat/headless-turn-outcomes.ts
 * @purpose Turns a headless lane's terminal LaneOutcome into the in-memory ChatMessage the session
 *   carries forward — the self-labeling failure marker, the id-reuse invariant, and the merge that
 *   threads outcomes back into the session for the next turn's composePrompt to see.
 * @exports laneOutcomeMessage, safeLaneFailureReason, mergeHeadlessOutcomes
 * @depends ../shared/render-escape, ./message-id, ./prompt-budgeter, ./session-store, ./tower-bridge-lane, ./types
 *
 * MN round 2b: split out of headless-turn.ts, which crossed the 600-line hard clamp (no escape hatch
 * above it) once that file's non-carrier lane started publishing memory notices onto the bus. This
 * block — outcome-to-message conversion — has no coupling to the dispatch machinery above it in the
 * original file, so the split follows the seam the concern already draws, the same precedent
 * lane-carrier.ts already set (lane-acquire.ts, lane-carrier-cancel-send.ts, lane-carrier-briefing.ts).
 * `laneOutcomeMessage`, `safeLaneFailureReason` and `mergeHeadlessOutcomes` are re-exported from
 * headless-turn.ts unchanged, so every existing importer (`room-host.ts`, `room-host-outcome.ts`, and
 * this codebase's own tests) is unaffected — same re-export convention lane-carrier.ts uses for
 * acquireLaneSession/resetLaneAcquireCache.
 */
import { escapeUntrusted } from "../shared/render-escape.js";
import { mintMessageId } from "./message-id.js";
import { estimatePromptTokens } from "./prompt-budgeter.js";
import { appendMessage } from "./session-store.js";
import type { LaneOutcome } from "./tower-bridge-lane.js";
import type { ChatMessage, ChatSession } from "./types.js";

// U1: a failure-marker prefix so a FAILED lane's merged message SELF-LABELS as a failure even when the
// transcript renderer prints message.text STATUS-BLIND (it does not read message.status). A completed lane's
// message text is its reply verbatim; a failed lane's is the marker + the reason (its raw partial reply, if
// any, already streamed live during the turn and persists in the evidence row).
const LANE_FAILURE_MARKER = "⚠ dispatch failed: ";

/**
 * Builds the in-memory agent message for one lane outcome (U1). A completed lane carries its reply text; a
 * failed lane carries a self-labeling marker + reason, so a status-blind renderer shows it AS a failure
 * instead of printing a partial reply that looks successful.
 */
export function laneOutcomeMessage(turn: number, outcome: LaneOutcome): ChatMessage {
  const cancelled = outcome.state === "cancelled";
  const failed = !cancelled && outcome.exitCode !== 0;
  const text = failed
    ? `${LANE_FAILURE_MARKER}${safeLaneFailureReason(outcome.error)}`
    : outcome.text;
  return {
    id: transcriptMessageId(outcome, failed),
    turn,
    role: "agent",
    agent: outcome.agent,
    text,
    createdAt: outcome.messageCreatedAt ?? new Date().toISOString(),
    status: cancelled ? "cancelled" : failed ? "failed" : "completed",
    tokenEstimate: estimatePromptTokens(text),
  };
}

/** Canonical durable failure detail: actionable, inert, and bounded. */
export function safeLaneFailureReason(value: unknown): string {
  const escaped = escapeUntrusted(value ?? "lane failed", { maxLen: 1_024 });
  return escaped.length > 0 ? escaped : "lane failed";
}

/**
 * W4-R3a: the transcript takes the id finalizeLane already minted for this reply — it does NOT mint its own.
 * That second mint is what put two ids on one reply: the ledger seq was minted against the DB's id while the
 * transcript carried the other, so the digest (which reads the transcript as authority, digest.ts:62) looked
 * up an id `chat_messages` had never seen and reported every agent reply `absent from DB mirror`.
 *
 * A COMPLETED lane without a carried id is an invariant breach — every opened lane reaches finalizeLane
 * (headless-turn.ts's finalizeObservedLane, headless-carrier's runCarrierHeadlessLane, tower-bridge-turn's
 * finalizeOne) — so it throws rather than quietly re-minting and re-opening the split where nothing looks.
 * A FAILED outcome may legitimately never have been finalized: a gate-blocked lane (lane-gate.ts:89) and a
 * registrar-synthesized never-settled lane (cockpit-turn-lanes.ts:88) are both fabricated so an addressed
 * agent cannot vanish from the transcript. Those take a transcript-only id and stay failed — they have no
 * evidence row to agree with, and a failed row is never digested (digest.ts:64 filters on completed).
 */
function transcriptMessageId(outcome: LaneOutcome, failed: boolean): string {
  if (outcome.messageId !== undefined) {
    return outcome.messageId;
  }
  if (!failed) {
    throw new Error(
      `lane ${outcome.agent}: completed outcome carries no finalized messageId — finalizeLane must mint it`,
    );
  }
  return mintMessageId(outcome.agent);
}

/**
 * Threads the headless lane outcomes back into the session as agent messages, so the NEXT turn's (or the
 * next sequential agent's) composePrompt sees the prior replies (multi-turn + intra-turn continuity). A
 * text-less lane adds no message: a completed lane with no reply has nothing to show, and a failed lane
 * with no partial output is surfaced by its dispatch.failed event (not a blank transcript row). A failed
 * lane WITH output is merged via {@link laneOutcomeMessage} so its message self-labels as a failure.
 *
 * @param session - the session to extend (already carries this turn's operator message)
 * @param outcomes - the per-lane outcomes returned by runHeadlessTurn
 * @param turn - the turn number stamped on the appended agent messages
 * @returns the session with one agent message appended per outcome that carried text
 */
export function mergeHeadlessOutcomes(
  session: ChatSession,
  outcomes: readonly LaneOutcome[],
  turn: number,
): ChatSession {
  let next = session;
  for (const outcome of outcomes) {
    if (outcome.text.length === 0) {
      continue;
    }
    next = appendMessage(next, laneOutcomeMessage(turn, outcome));
  }
  return next;
}
