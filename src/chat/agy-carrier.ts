/**
 * @file src/chat/agy-carrier.ts
 * @exports AgyCarrierDispatch, AgyCarrierTurnInput, AgyCarrierTurnResult, runAgyCarrierTurn
 * @depends ../adapters/agy, ../adapters/types, ../memory/lane-state, ./lane-carrier
 * @purpose MT7 agy carrier-floor turn variant. A LIVE matching conversation records its prompt attempt
 *   PRE-send like the ACP lanes (retro BLOCK-3); only a cold start or a changed conversation id records
 *   post-capture — on those paths the resume primitive materializes after the send (the documented agy
 *   floor). A mismatched stored binding invalidates BEFORE composing (catch-up tail + fallback trace,
 *   retro BLOCK-2); a capture failure still returns the reply but never advances the cursor.
 *   W3 (THE GREAT DELETION, 2026-07-17): the T7 targeted-redirect acquire/settle this file used to
 *   mirror from lane-carrier.ts is GONE — review-redirect-delivery.ts and the review_redirects table
 *   it read/wrote are deleted along with the rest of the capture apparatus. composeCarrierPrompt is
 *   called directly now, with no redirect splice; every OTHER step (pre/post-capture attempt
 *   recording, cursor acceptance, the binding-mismatch/catch-up fallback) is untouched.
 */
import { type AgyLaneCaptureResult, type AgyLaneStateInput, dispatchAgy } from "../adapters/agy.js";
import type { AgentInput } from "../adapters/types.js";
import {
  advanceCursorOnAccept,
  bumpGeneration,
  getLaneSession,
  laneBindingMatches,
  recordPromptAttempt,
} from "../memory/lane-state.js";
import { type CarrierTurnInput, type TraceBus, composeCarrierPrompt } from "./lane-carrier.js";

export type AgyCarrierDispatch = (input: AgyLaneStateInput) => Promise<AgyLaneCaptureResult>;

export interface AgyCarrierTurnInput
  extends Omit<CarrierTurnInput, "transport" | "agent" | "attemptId"> {
  readonly agent: "gemini";
  readonly input: AgentInput;
  readonly writePrompt: (prompt: string) => Promise<string>;
  readonly dispatch?: AgyCarrierDispatch;
  readonly attemptId?: () => string;
}

export type AgyCarrierTurnResult = (
  | {
      readonly outcome: "accepted";
      readonly prompt: string;
      readonly reply: string;
      readonly sessionId: string;
      /** Whether the accepted prompt carried the briefing (feeds the detector's periodic counter). */
      readonly carriedBriefing: boolean;
    }
  | {
      readonly outcome: "captureFailed";
      readonly prompt: string;
      readonly reply: string;
      readonly reason: string;
    }
  | {
      readonly outcome: "failed";
      readonly prompt: string;
      readonly reply: string;
      readonly sessionId: string;
    }
  | { readonly outcome: "commitFailed"; readonly prompt: string; readonly reply: string }
) & { readonly statuslineCwd?: string };

/**
 * FL-150 PRECONDITION — ONE TURN, ONE CANCEL AUTHORITY.
 *
 * This lane carries the turn's AbortSignal in two places: the inherited `CarrierTurnInput.signal`
 * (required since FL-150, so no caller can quietly opt out of cancellation) and the `AgentInput` the
 * agy runner reads (`agy-runner.ts` opens with `if (opts.signal.aborted)`). Two references to the SAME
 * object is fine and expected. Two DIFFERENT signals would mean a cancel that stops one half of this
 * turn and not the other — the exact class of bug FL-150 exists to close, and one that would show up
 * as "gemini answered through my Esc" months later. Checked rather than trusted, because the caller
 * assembles both halves and nothing else can catch a mismatch.
 *
 * Its own function so `runAgyCarrierTurn` stays inside the complexity clamp — the check is a guard on
 * the way in, not a branch in the turn's logic.
 */
function assertOneCancelAuthority(input: AgyCarrierTurnInput): void {
  if (input.signal === input.input.signal) return;
  throw new Error(
    "agy carrier turn was given two different abort signals - the turn's signal and the agy input's signal must be the same object",
  );
}

export async function runAgyCarrierTurn(input: AgyCarrierTurnInput): Promise<AgyCarrierTurnResult> {
  assertOneCancelAuthority(input);
  const now = input.now?.() ?? new Date().toISOString();
  const stored = getLaneSession(input.db, input.projectId, input.agent, input.laneScopeId ?? "");
  const bindingOk = stored !== undefined && laneBindingMatches(stored, input.binding);
  if (stored !== undefined && !bindingOk) {
    // I-2/F-3 (retro BLOCK-2): the stored conversation is invalid BEFORE composing anything.
    emit(input.trace, input.turn, "resume.fallback", "reason=binding_mismatch");
  }
  // A fresh/replaced agy conversation saw NOTHING — compose the catch-up TAIL, never the old cursor's
  // "everything after" (retro BLOCK-2, the same amnesia class as the ACP lanes).
  const prompt = composeCarrierPrompt({ ...input, mode: bindingOk ? "delta" : "catchup" });
  const attemptId = input.attemptId?.() ?? crypto.randomUUID();
  if (bindingOk && stored !== undefined) {
    // I-1 (retro BLOCK-3): the (generation, sessionId) pair is KNOWN pre-send for a live agy
    // conversation — record the durable intent BEFORE dispatch, exactly like the ACP lanes.
    recordPromptAttempt(input.db, {
      attemptId,
      projectId: input.projectId,
      ...(input.laneScopeId === undefined ? {} : { laneScopeId: input.laneScopeId }),
      agent: input.agent,
      generation: stored.generation,
      sessionId: stored.sessionId,
      seqFrom: prompt.attempt.seqFrom,
      seqTo: prompt.attempt.seqTo,
      sentAt: now,
    });
  }
  const contextFile = await input.writePrompt(prompt.text);
  const captured = await (input.dispatch ?? dispatchAgy.withLaneState)(
    agyStateInput(input, contextFile),
  );
  if (captured.outcome === "captureFailed") {
    return captureFailed(input.trace, input.turn, prompt.text, captured);
  }
  const session = getLaneSession(input.db, input.projectId, input.agent, input.laneScopeId ?? "");
  if (session === undefined) throw new Error("agy capture persisted no lane session row");
  return settleAgyTurn(input, prompt, captured, { attemptId, bindingOk, now, session, stored });
}

// Post-capture settle: a SAME-pair turn resolves the pre-send attempt; a cold start or a changed
// conversation id (the bump abandoned any pre-send attempt) records the post-capture pair — the
// documented agy floor: on those paths the resume primitive materializes only after the send.
async function settleAgyTurn(
  input: AgyCarrierTurnInput,
  prompt: ReturnType<typeof composeCarrierPrompt>,
  captured: Extract<AgyLaneCaptureResult, { outcome: "persisted" }>,
  ctx: {
    attemptId: string;
    bindingOk: boolean;
    now: string;
    session: NonNullable<ReturnType<typeof getLaneSession>>;
    stored: ReturnType<typeof getLaneSession>;
  },
): Promise<AgyCarrierTurnResult> {
  const samePair =
    ctx.bindingOk &&
    ctx.stored !== undefined &&
    ctx.session.generation === ctx.stored.generation &&
    ctx.session.sessionId === ctx.stored.sessionId;
  const settleAttemptId = samePair
    ? ctx.attemptId
    : ctx.bindingOk
      ? crypto.randomUUID()
      : ctx.attemptId;
  if (!samePair) {
    recordPromptAttempt(input.db, {
      attemptId: settleAttemptId,
      projectId: input.projectId,
      ...(input.laneScopeId === undefined ? {} : { laneScopeId: input.laneScopeId }),
      agent: input.agent,
      generation: ctx.session.generation,
      sessionId: ctx.session.sessionId,
      seqFrom: prompt.attempt.seqFrom,
      seqTo: prompt.attempt.seqTo,
      sentAt: ctx.now,
    });
  }
  if (captured.result.exitCode !== 0) {
    // Known, non-crash refusal (the transport ran and reported failure) — retryable.
    return failed(
      prompt.text,
      captured.result.stdout,
      ctx.session.sessionId,
      captured.statuslineCwd,
    );
  }
  return acceptAgyTurn(input, prompt, captured.result.stdout, {
    attemptId: settleAttemptId,
    session: ctx.session,
    ...(captured.statuslineCwd === undefined ? {} : { statuslineCwd: captured.statuslineCwd }),
  });
}

function agyStateInput(input: AgyCarrierTurnInput, contextFile: string): AgyLaneStateInput {
  return {
    adapterPkg: input.binding.adapterPkg,
    adapterVersion: input.binding.adapterVersion,
    cwd: input.binding.cwd,
    db: input.db,
    input: { ...input.input, contextFile },
    now: () => input.now?.() ?? new Date().toISOString(),
    projectId: input.projectId,
    ...(input.laneScopeId === undefined ? {} : { laneScopeId: input.laneScopeId }),
    store: { bumpGeneration, getLaneSession, laneBindingMatches },
  };
}

function captureFailed(
  trace: TraceBus | undefined,
  turn: number,
  prompt: string,
  captured: Extract<AgyLaneCaptureResult, { outcome: "captureFailed" }>,
): AgyCarrierTurnResult {
  emit(trace, turn, "resume.fallback", "reason=agy_id_capture");
  return {
    outcome: "captureFailed",
    prompt,
    reply: captured.result.stdout,
    reason: captured.reason,
    ...(captured.statuslineCwd === undefined ? {} : { statuslineCwd: captured.statuslineCwd }),
  };
}

async function acceptAgyTurn(
  input: AgyCarrierTurnInput,
  prompt: ReturnType<typeof composeCarrierPrompt>,
  reply: string,
  ctx: {
    attemptId: string;
    session: NonNullable<ReturnType<typeof getLaneSession>>;
    statuslineCwd?: string;
  },
): Promise<AgyCarrierTurnResult> {
  const advanced = await advanceCursorOnAccept(input.db, {
    projectId: input.projectId,
    ...(input.laneScopeId === undefined ? {} : { laneScopeId: input.laneScopeId }),
    agent: input.agent,
    attemptId: ctx.attemptId,
    generation: ctx.session.generation,
    sessionId: ctx.session.sessionId,
    lastSeq: prompt.attempt.lastSeqOnAccept,
    clearBriefingCarry: prompt.carriedBriefing,
    now: input.now?.() ?? new Date().toISOString(),
  });
  if (advanced.outcome === "commitFailed") {
    emit(input.trace, input.turn, "cursor.commitFailed", `attempts=${advanced.attempts}`);
    // Send genuinely accepted, durable commit failed — genuinely uncertain.
    return {
      outcome: "commitFailed",
      prompt: prompt.text,
      reply,
      ...(ctx.statuslineCwd === undefined ? {} : { statuslineCwd: ctx.statuslineCwd }),
    };
  }
  return {
    outcome: "accepted",
    prompt: prompt.text,
    reply,
    sessionId: ctx.session.sessionId,
    carriedBriefing: prompt.carriedBriefing,
    ...(ctx.statuslineCwd === undefined ? {} : { statuslineCwd: ctx.statuslineCwd }),
  };
}

function failed(
  prompt: string,
  reply: string,
  sessionId: string,
  statuslineCwd?: string,
): AgyCarrierTurnResult {
  return {
    outcome: "failed",
    prompt,
    reply,
    sessionId,
    ...(statuslineCwd === undefined ? {} : { statuslineCwd }),
  };
}

function emit(
  trace: TraceBus | undefined,
  turn: number,
  phase: "resume.fallback" | "cursor.commitFailed",
  detail: string,
) {
  trace?.emit({ kind: "memory.trace", phase, turn, detail });
}
