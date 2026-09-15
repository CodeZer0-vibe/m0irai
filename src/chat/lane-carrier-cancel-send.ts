/**
 * @file src/chat/lane-carrier-cancel-send.ts
 * @purpose FL-150 — what a cancel means at the instant a carrier prompt would leave: refuse the send,
 *   and record it durably when one is accepted anyway.
 * @exports CancelSeamTurn, throwIfCancelledBeforeSend, reportPromptSentAfterCancel, assertTurnCancelAuthority
 * @depends ../evidence/db, ../memory/lane-state, ../shared/logger, ./types
 *
 * Extracted from lane-carrier.ts in FL-150 round 2, which pushed that file past the 600-line HARD
 * ceiling. The split is along a real seam rather than an arbitrary line count: lane-carrier.ts owns
 * "run ONE carrier turn", and this owns the decision the FL-146 reviewer identified as the broken
 * invariant — "the ACP carrier never consults the abort signal before sending" — which deserves to be
 * readable in one place.
 *
 * IT TAKES ONLY WHAT IT READS. `CancelSeamTurn` is a narrow structural slice that `CarrierTurnInput`
 * satisfies, deliberately rather than importing that type back: the dependency edge stays one-way, so
 * there is no cycle to reason about and nothing here can quietly start depending on the rest of a turn.
 */
import type { Db } from "../evidence/db.js";
import { markAttemptAbortedAfterAccept } from "../memory/lane-state.js";
import { createLogger } from "../shared/logger.js";
import type { AgentName } from "./types.js";

const logger = createLogger();
const PHASE = "lane-carrier";

/** The slice of a carrier turn the cancel seam reads: who, when, where it writes, and the one thing
 *  that decides everything here — whether the operator has already said stop. */
export interface CancelSeamTurn {
  readonly agent: AgentName;
  readonly turn: number;
  readonly db: Db;
  readonly signal: AbortSignal;
  readonly now?: () => string;
}

/**
 * FL-150 — THE ACP CARRIER ASKS THE ABORT SIGNAL BEFORE IT SENDS, WHICH IT NEVER DID.
 *
 * The invariant that broke in the operator's incident, in the reviewer's words: *"the ACP carrier never
 * consults the abort signal before sending."* Everything else — the supersession epoch, the dropped
 * hold, the closed connections — is machinery around a decision this function is the only one placed to
 * make: the prompt is about to leave, and the operator has already said stop.
 *
 * UPSTREAM, AND THE DEVIATION. grok reads its LOCAL `agent.session.state.is_cancelling()` alongside the
 * wire's stop reason (xai-grok-pager/src/app/dispatch/prompt.rs:1192-1196). Precisely: it is a
 * short-circuiting OR — `is_cancelling() || stop_reason == Cancelled` — so the local flag is read FIRST
 * and is SUFFICIENT, but it is not superior; the wire's `Cancelled` is an equally sufficient trigger.
 * (An earlier version of this comment called the local flag "the authority", which over-read the
 * evaluation order into a hierarchy — review P3-B.) Here only the local half exists, because the wire
 * half needs a channel that survives the cancel and this room's does not. What upstream does NOT need is
 * a guard at this point: it cancels IN BAND over a connection that stays alive (`acp::CancelNotification`,
 * xai-grok-pager/src/app/effects/mod.rs:1301-1303) and never opens a new one mid-turn. This room cancels
 * by destroying the connection, so a cancelled turn can and did go on to open a REPLACEMENT and send to
 * it. That extra move is ours, so the extra guard is ours too.
 *
 * WHY HERE AND NOT ONE LINE LOWER. There is no `await` between this call and `transport.send` —
 * `recordPromptAttempt` is a synchronous better-sqlite3 write (lane-attempts.ts:75) — so no abort can
 * land in the gap, and checking BEFORE the attempt row means a turn stopped here never leaves an
 * unresolved `lane_prompt_attempts` row for a prompt that was never sent (which the NEXT turn's
 * `classifyRecovery` would report as a maybe-duplicate that never happened).
 */
export function throwIfCancelledBeforeSend(input: CancelSeamTurn, sessionId: string): void {
  if (!input.signal.aborted) return;
  logger.warn({ phase: PHASE, agent: input.agent }, "cancel stopped this turn before its prompt", {
    sessionId,
    turn: input.turn,
  });
  throw new Error(
    `${input.agent}: cancelled before the prompt was sent — nothing reached the agent`,
  );
}

/**
 * FL-150 — AND IF ONE EVER DOES GET OUT, THE LOG SAYS SO (invariant 9: self-diagnosing).
 *
 * The guard above cannot cover an abort that lands WHILE `conn.prompt()` is on the wire. That prompt is
 * genuinely delivered, so the cursor still has to advance — refusing to record it would re-deliver the
 * same delta on the next turn — but it is precisely the operator's complaint ("I pressed Esc and it
 * answered anyway") and it must never again be reconstructable only from a database days later. This is
 * grok's own `was_cancelling`-on-a-successful-result check (prompt.rs:1192-1196); the DEVIATION is that
 * upstream routes such a turn to a cancelled event, while here the turn's terminal state is decided by
 * headless-carrier's `markCarrierTerminal` and the room's cancel path, so this reports rather than
 * reclassifies. Do not silence it: a quiet one of these is the whole defect coming back.
 *
 * IT NAMES NO CULPRIT, deliberately, and for the same reason CARRIER_CANCELLED_TEXT does not
 * (headless-carrier.ts): this one signal is raised by an operator cancel, a room pause AND a shutdown
 * quiesce alike (room-engine.ts). "The operator was answered through their Esc" is the case that
 * matters, but it is not the only case that reaches here, and printing the likeliest cause as though it
 * were the observed one is the kind of confident guess that makes a log worse than no log.
 *
 * THE STRUCTURAL ANSWER, RECORDED AND NOT BUILT HERE (review P2-C). This function exists because
 * destroying a connection cannot stop a prompt already on the wire. An IN-BAND cancel can, and the
 * protocol already defines it: `Agent.cancel(params: schema.CancelNotification): Promise<void>`
 * (`node_modules/@agentclientprotocol/sdk/dist/acp.d.ts:1221`), whose doc points at the spec's
 * Cancellation section and requires the agent to answer the original `session/prompt` with
 * `StopReason::Cancelled`. It is one call away on the object this room ALREADY holds:
 * `ClientSideConnection implements Agent` (`acp.d.ts:1000`) and `acp-lane-connection.ts:13` constructs
 * exactly that connection — the same one it drives at `:168` (`conn.newSession`) and `:247`
 * (`conn.prompt`). Upstream does it (`xai-grok-pager/src/app/effects/mod.rs:1301-1303`). m0irai never
 * does: `grep -rniE "cancelNotification|session/cancel|\.cancel\(" src/adapters/ --include=*.ts` minus
 * tests returns ZERO hits, and the two greps above are the positive control that proves the empty
 * result is a real absence rather than a bad search.
 *
 * Wiring it is a SEPARATE LANE, deliberately: an in-band cancel changes what a stopped turn RETURNS
 * (`sendHeld` maps a non-`end_turn` stop reason to `failed`, so a cancelled prompt would stop being
 * `accepted` at all), which is a behaviour change across the room's terminal handling and FL-126's
 * "intent to stop earns the text back" ruling. It does not belong in a fix round. What belongs here is
 * that the next person to read this function knows the window it reports is closable, and how.
 *
 * ROUND 2 (review P2-A) — IT IS WRITTEN DOWN, NOT ONLY LOGGED. The reviewer followed the WARN to its
 * sink and found nothing at the end: no production caller claims the screen, so the file sink is never
 * taken, and in the packaged app the host's stderr goes to a 64 KB ring in the Rust launcher that
 * nothing reads. A line that dies with the process is the same unreadable-afterwards condition this
 * observable exists to end, so the fact now lands on the attempt's own durable row (`aborted_at`).
 * The WARN stays: a live operator watching a terminal is a reader too.
 *
 * THE DB WRITE IS FAIL-SOFT AND THE LOG IS NOT INSIDE THE TRY. A diagnostic that can fail a turn is a
 * worse defect than the one it reports, so a write that throws (a read-only or vanished DB) is caught
 * and downgraded — and because the WARN has already been emitted by then, the failure surfaces rather
 * than vanishing, which is the only thing that makes swallowing it legitimate here.
 */
export function reportPromptSentAfterCancel(
  input: CancelSeamTurn,
  accepted: boolean,
  sessionId: string,
  attemptId: string,
): void {
  if (!input.signal.aborted || !accepted) return;
  logger.warn(
    { phase: PHASE, agent: input.agent },
    "a prompt was accepted AFTER this turn was aborted - the stop did not reach the agent in time",
    { sessionId, turn: input.turn, attemptId },
  );
  try {
    markAttemptAbortedAfterAccept(input.db, {
      attemptId,
      abortedAt: input.now?.() ?? new Date().toISOString(),
    });
  } catch (cause) {
    logger.warn({ phase: PHASE, agent: input.agent }, "could not record the accepted-after-abort", {
      attemptId,
      reason: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

/**
 * FL-150 ROUND 2 (review P1-A) — ONE TURN, ONE CANCEL AUTHORITY, ON THE ACP BRANCH TOO.
 *
 * The reviewer's finding, and it is a fair one: replace `signal: input.signal` at headless-carrier's
 * ACP assembly with a fresh never-aborting controller and 250 test files / 1961 tests still pass, while
 * the SAME cut on the agy branch fails two, because `agy-carrier.ts`'s `assertOneCancelAuthority` guards
 * it. That reproduced the exact ACP-vs-PTY asymmetry this lane exists to remove, one layer up inside the
 * lane's own fix.
 *
 * WHY THIS IS NOT A VACUOUS `x === x`. It does not compare a value to itself: it compares the ASSEMBLED
 * carrier turn's signal against the turn's own. Change either side alone and it fires. A required TYPE
 * stops omission; only a runtime identity check stops a wrong-but-valid `AbortSignal` — a refactor, a
 * merge, or a helper that builds its own controller — which compiles perfectly and silently restores
 * the operator's original defect.
 *
 * A THROW IS THE RIGHT FAILURE. `dispatchCarrierLane`'s catch classifies it through `classifyLaneError`
 * with the turn's real signal, so a build that got this wrong fails its lanes loudly instead of
 * answering an operator who has already pressed Esc.
 *
 * Structural parameters, not `HeadlessTurnInput`: this module must not import the layer above it, and
 * the only field either side needs is the signal.
 */
export function assertTurnCancelAuthority(
  turn: { readonly signal: AbortSignal },
  assembled: { readonly signal: AbortSignal },
): void {
  if (assembled.signal === turn.signal) return;
  throw new Error(
    "carrier turn was assembled with a signal that is not the turn's own - a cancel would never reach this agent",
  );
}
