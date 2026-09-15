/**
 * @file src/chat/lane-hold-send.ts
 * @purpose ONE prompt on a held ACP lane connection: what is held, what the send delivers, what its
 *   ending means, and the one self-heal edge a failure may trigger. The lifecycle around it — open,
 *   supersede, replace, close — stays in lane-hold.ts.
 * @exports Held, HeldSendInput, HeldSendResult, sendOnHold
 * @depends ../adapters/acp/acp-lane-session, ../adapters/acp/acp-models, ../adapters/acp/acp-servers, ./lane-availability, ./lane-send-outcome, ./permission-ask
 *
 * WHY THIS IS ITS OWN FILE. `lane-hold.ts` is at its size ceiling and the ratchet only falls, so the
 * delta round's per-generation buffers had to come out of an extraction rather than a raised limit.
 * This is the seam the extraction follows: everything here is about ONE prompt on a connection that is
 * ALREADY held, and none of it decides which connection that is. `Held` moved with it because it is
 * the value that describes exactly that — the connection, its session, and the generation it was
 * opened under.
 */
import type { LaneConnection } from "../adapters/acp/acp-lane-session.js";
import type { AcpModelList } from "../adapters/acp/acp-models.js";
import type { AcpAgent } from "../adapters/acp/acp-servers.js";
import { isSessionEndedFailure } from "./lane-availability.js";
import {
  type SendFailureReason,
  type TurnTextRecorder,
  sendRejectedOutcome,
  sendStopOutcome,
} from "./lane-send-outcome.js";
import { invalidatePendingAsk } from "./permission-ask.js";

/** What one held send settles to — structurally the carrier's own SendResult, which is what the
 *  transport's `send` is contracted to return. */
export type HeldSendResult =
  | { readonly outcome: "accepted" }
  | { readonly outcome: "failed"; readonly reason: SendFailureReason; readonly message: string };

/** The connection a lane is currently holding, the session open on it, and the models it advertised. */
export interface Held {
  readonly conn: LaneConnection;
  readonly sessionId: string;
  /** DELTA ITEM 4: the supersession epoch this connection was OPENED under, carried on the hold so a
   *  send can name its own generation's text after a newer connection has taken the lane. Without it
   *  the only available answer was "whoever holds the lane now", which is a different question. */
  readonly epoch: number;
  models?: AcpModelList;
}

export interface HeldSendInput {
  readonly held: Held | undefined;
  readonly text: TurnTextRecorder;
  readonly agent: AcpAgent;
  readonly onSessionUpdate?: (update: unknown) => void;
  /** Release the hold through the caller's own close ladder — the BLOCK 3 self-heal below. */
  readonly dropHold: () => Promise<void>;
  readonly prompt: string;
  readonly sessionId: string;
}

/**
 * BLOCK 3 (FIX-3b): {@link sendHeld} plus the SELF-HEAL edge. When a send fails with a signal proving
 * the held bridge session can never accept another prompt (isSessionEndedFailure — see its own header
 * for the queryClosed wedge and why isAlive() cannot see it), the hold is released through the SAME
 * ladder a replace uses, so the next start() opens a real connection instead of re-serving a dead
 * session until an app restart. An ORDINARY rejection never drops it — per-turn respawn is the
 * carrier's anti-target.
 */
export async function sendOnHold(input: HeldSendInput): Promise<HeldSendResult> {
  const result = await sendHeld(input);
  if (result.outcome === "failed" && isSessionEndedFailure(result.message)) {
    await input.dropHold();
  }
  return result;
}

// W4-3: invalidatePendingAsk runs in the `finally` — after held.conn.prompt() settles, success or
// failure — since a permission ask can ONLY be raised by the bridge WHILE a prompt() call is in
// flight (it is how the bridge asks mid-turn), so THIS call settling with an ask still open is, by
// construction, "the ask outlived its turn" (the FAIL-CLOSED case W4-3 names). Lives here (chat/),
// not acp-lane-connection.ts (adapters/) — that module must never import chat/, per
// no-upward-deps-adapters (dep-check-verified: it flagged this exact violation when the call briefly
// lived one layer down).
async function sendHeld(input: HeldSendInput): Promise<HeldSendResult> {
  const held = input.held;
  if (held === undefined || !held.conn.isAlive()) {
    return {
      outcome: "failed" as const,
      reason: "transport" as const,
      message: "no live lane session held - the carrier decides resume-or-fresh, never send",
    };
  }
  try {
    // DELTA ITEM 4: begin/delivered/end all name THIS connection's generation. `held` is read before
    // the await, so a newer connection claiming the lane mid-prompt cannot redirect this turn's
    // classification onto someone else's text — nor this text onto someone else's turn.
    input.text.begin(held.epoch);
    const tap = input.onSessionUpdate;
    const stopReason = await held.conn.prompt(input.sessionId, input.prompt, (update) =>
      tap?.(update),
    );
    // The ending the lane could not read (the operator's codex row at 15:20): the bridge delivered its
    // usage-limit sentence as assistant TEXT and closed with a non-`end_turn` stop reason, so nothing
    // rejected and the diagnostic alone says nothing about usage. lane-send-outcome.ts holds the rest.
    return sendStopOutcome(stopReason, input.text.delivered(held.epoch));
  } catch (cause) {
    // F1 (FIX-3): a prompt rejection is where the child-CLI credit/auth death surfaces. Classified into
    // the reason enum ("quota"/"auth") so the carrier lane can render an exhausted/needs-auth state (the
    // memory-ON default path); an ordinary rejection stays "transport".
    // ITEM A: the WHOLE cause, not just its message. The real codex limit death rejects with the
    // opaque `Internal error` and NAMES ITSELF on the error's structured `data` — see the four-rung
    // ladder in sendRejectedOutcome. The delivered text is the last rung of it.
    return sendRejectedOutcome(cause, input.text.delivered(held.epoch));
  } finally {
    // The turn is over, so this generation stops recording — a chunk arriving after this point belongs
    // to a turn that has already been classified, and both forwarding it (a sentence painted twice into
    // the operator's row) and keeping it (a settled turn's ending read as the next one's) are wrong.
    // `finally` runs AFTER the returned expression is evaluated, so both readers above still see it.
    input.text.end(held.epoch);
    invalidatePendingAsk(input.agent);
  }
}
