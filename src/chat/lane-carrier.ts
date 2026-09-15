/**
 * @file src/chat/lane-carrier.ts
 * @purpose MT7 lane carrier orchestration: prompt assembly, pre-send attempts, cursor acceptance, traces.
 * @exports AcquireLaneSessionInput, ActiveSessionResult, CarrierTransport, CarrierTurnInput, CarrierTurnResult, PromptInput, StartResult, TraceBus, acquireLaneSession, composeCarrierPrompt, resetLaneAcquireCache, runCarrierTurn
 * @depends ../evidence/db, ../memory/carrier-budget, ../memory/delta-composer, ../memory/digest-failsafe, ../memory/lane-state, ../memory/ledger, ../shared/debug-mode, ../shared/room-notice, ./events, ./lane-carrier-briefing, ./lane-carrier-cancel-send
 * @size-justified: ONE carrier turn's full lifecycle (session, prompt, send, cursor-accept) is a
 *   single atomic sequence a caller must be able to read top-to-bottom without jumping files.
 *
 * W3 (THE GREAT DELETION, 2026-07-17): the T7 targeted-redirect injection (acquire a pending
 * review_redirects row for {sessionId, agent}, splice its already-framed block between delta and
 * operator, settle delivered/refused per send outcome) is GONE — review-redirect-delivery.ts and the
 * review_redirects table it read/wrote are deleted along with the rest of the capture apparatus.
 * composeCarrierPrompt/runCarrierTurn compose and send the SAME setup/briefing/delta/operator prompt
 * unconditionally now; every OTHER step (cursor acceptance, the boundary wave's sessionBoundarySeq
 * threading + boundary.framed trace in composeCarrierDelta, the pid-verified lock functions) is
 * untouched.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../evidence/db.js";
import {
  deltaMaxBytes,
  deltaMaxMessages,
  partitionCarrierBudget,
} from "../memory/carrier-budget.js";
import { composeDelta } from "../memory/delta-composer.js";
import {
  type DigestLock,
  acquireDigestLock,
  releaseDigestLock,
} from "../memory/digest-failsafe.js";
import {
  advanceCursorOnAccept,
  getLaneCursor,
  listUnresolvedAttempts,
  recordPromptAttempt,
} from "../memory/lane-state.js";
import { type LedgerBodyReader, ledgerAfter } from "../memory/ledger.js";
import { debugEnabled } from "../shared/debug-mode.js";
import type { RoomNotice } from "../shared/room-notice.js";
import type { MemoryTracePhase, RoomNoticeEvent } from "./events.js";
import {
  type AcquireLaneSessionInput,
  type ActiveSessionResult,
  acquireLaneSession,
  resetLaneAcquireCache,
} from "./lane-acquire.js";
import { composeCarrierBriefing, publishNotices, safely } from "./lane-carrier-briefing.js";
import {
  reportPromptSentAfterCancel,
  throwIfCancelledBeforeSend,
} from "./lane-carrier-cancel-send.js";
import type { AgentName } from "./types.js";

// SESSION ACQUISITION lives in lane-acquire.ts (W4-R2c: this file crossed the 600-line hard gate).
// Re-exported here so every existing importer — eager-session-boot, the suites — is unchanged.
// THE CANCEL SEAM around the send lives in lane-carrier-cancel-send.ts (FL-150 round 2: this file
// crossed that same hard gate again). Answered by extraction along the seam, never by a raised limit.
export type { AcquireLaneSessionInput, ActiveSessionResult };
export { acquireLaneSession, resetLaneAcquireCache };

type FailureReason = "auth" | "quota" | "transport" | "agyCapture";
/** B1/B2 (MAX review fix round 1): the outcome of applying the pending/restored native mode to a
 *  freshly opened or resumed session, BEFORE it is handed back ready for its first prompt — the
 *  "ACTIVE only after that application path" contract. `applied` means the live setMode call
 *  succeeded against THIS session, not merely that an earlier cycle's call succeeded against some
 *  prior session.
 *  W4-R FIX-1b ROUND 2 (MAX review BLOCK): `origin` is REQUIRED on `applied` — "confirmed" is a
 *  genuine live setMode push (applyRestoredMode: create, or a resume with no advertised
 *  currentModeId), the class native-mode.ts's applyActive staleness guard exists to protect;
 *  "adopted" is a resume's own ground truth (adoptOrApplyResumedMode's adoption branch — no live
 *  call made, so "any mismatch is stale" is the wrong premise). See LaneModeApplyOutcome's own
 *  consumer (use-cockpit-bus.ts's applyEagerOutcome) for which action each origin routes to. */
export type LaneModeApplyOutcome =
  | {
      readonly outcome: "applied";
      readonly modeId: string;
      readonly origin: "confirmed" | "adopted";
      /** W4-R2f RA-2: set ONLY when this adoption happened because the bridge REFUSED the operator's
       *  own persisted mode — carries the reason it gave. The lane genuinely IS on `modeId`, so this
       *  stays `applied` and the displayed mode is true; but the operator asked for something else and
       *  did not get it, and that must reach them rather than pass as an ordinary adoption. Absent on
       *  every other adoption. */
      readonly rejected?: string;
    }
  | { readonly outcome: "failed"; readonly modeId: string; readonly reason: string };
export type StartResult =
  | {
      readonly outcome: "created";
      readonly sessionId: string;
      // A brand-new session ALWAYS goes through the apply step — never optional here.
      readonly modeApplied: LaneModeApplyOutcome;
      readonly availableModeIds?: readonly string[];
    }
  | {
      readonly outcome: "resumed";
      readonly sessionId: string;
      // Optional: a TRUE resume (a stored session id reconnected via conn.resumeSession) always
      // applies and sets this; the "already held and alive, same session" FAST reuse across
      // consecutive turns within one process does NOT re-apply (nothing changed) and omits it —
      // the caller must not re-dispatch a mode-session event when this is absent.
      readonly modeApplied?: LaneModeApplyOutcome;
      readonly availableModeIds?: readonly string[];
    }
  | { readonly outcome: "resumeFailed"; readonly reason: string };
type SendResult =
  | { readonly outcome: "accepted" }
  | { readonly outcome: "failed"; readonly reason: FailureReason; readonly message: string };

export interface CarrierTransport {
  start(sessionId: string | undefined): Promise<StartResult>;
  send(prompt: string, sessionId: string): Promise<SendResult>;
  close?(): Promise<
    | { readonly outcome: "closed" }
    | { readonly outcome: "orphan"; readonly pid: number; readonly pids?: readonly number[] }
  >;
}

export interface TraceBus {
  emit(
    event:
      | {
          kind: "memory.trace";
          phase: MemoryTracePhase;
          turn: number;
          detail?: string;
        }
      | RoomNoticeEvent,
  ): void;
}

export interface CarrierTurnInput {
  readonly agent: AgentName;
  /** C2 (FIX WAVE Round A): the real per-turn number, threaded into every emitted memory.trace event
   *  below instead of a hard-coded 0 — required (not optional) so a future call site cannot silently
   *  regress to the same correlation bug by forgetting to pass it. */
  readonly turn: number;
  readonly binding: {
    readonly adapterPkg: string;
    readonly adapterVersion: string;
    readonly cwd: string;
  };
  readonly db: Db;
  readonly operatorMessage: string;
  readonly projectId: string;
  /** Native provider state scope; V2 supplies its outer chat session id. */
  readonly laneScopeId?: string;
  readonly readBody: LedgerBodyReader;
  readonly setup: string;
  readonly transport: CarrierTransport;
  /**
   * FL-150 — THE TURN'S CANCEL AUTHORITY. REQUIRED, for the reason AcquireLaneSessionInput.signal's own
   * header gives: an optional field is how the ACP path came to have no cancel at all while the PTY path
   * had one. This is the SAME signal the lane's dispatch already carries (headless-turn.ts's
   * `input.signal`), threaded so `runCarrierTurn` can consult it at the one instant that decides whether
   * a cancelled operator still gets an answer — immediately before `transport.send`.
   */
  readonly signal: AbortSignal;
  readonly trace?: TraceBus;
  readonly now?: () => string;
  readonly attemptId?: () => string;
  readonly crashAfterSend?: boolean;
  /** THE BOUNDARY WAVE: the ledger seq high-water-mark at THIS chat session's boot (distinct from
   *  the LANE's own native-agent session id `openActiveSession` resolves — a different concept).
   *  Threaded into composeDelta so an operator ledger entry minted before this boot is framed
   *  untrusted instead of unconditionally trusted (delta-composer.ts's own contract). Absent
   *  defaults to 0 (frames nothing) at the one call site below — dormant-seam convention. */
  readonly sessionBoundarySeq?: number;
}

export interface CarrierPrompt {
  readonly text: string;
  readonly attempt: {
    readonly seqFrom: number;
    readonly seqTo: number;
    readonly lastSeqOnAccept: number;
  };
  readonly carriedBriefing: boolean;
  readonly deliveredSeqs: readonly number[];
  readonly overflowPending: boolean;
  /** Every briefing-path failure this composition degraded around, classified by call site. Empty on
   *  the ordinary path. Returned as a VALUE rather than thrown, because the turn continues. */
  readonly notices: readonly RoomNotice[];
}

/** The briefing failures this turn degraded around, carried on EVERY outcome because a turn that
 *  went on to fail for an unrelated reason still had its memory taken away, and the room still owes
 *  the operator that row. Required rather than optional: a construction site that forgets it is a
 *  silence, and silence is the defect this field exists to close. */
type CarrierNotices = { readonly notices: readonly RoomNotice[] };

export type CarrierTurnResult =
  | ({
      readonly outcome: "accepted";
      readonly prompt: string;
      readonly sessionId: string;
      /** Whether the accepted prompt carried the briefing (feeds the detector's periodic counter). */
      readonly carriedBriefing: boolean;
      readonly modeApplied?: LaneModeApplyOutcome;
      readonly availableModeIds?: readonly string[];
    } & CarrierNotices)
  | ({
      readonly outcome: "failed";
      // F1 (FIX-3): reason carries "quota"/"auth" (classified in lane-transport's sendHeld) so the headless
      // lane can render an exhausted/needs-auth death from the coarse enum, no extra field needed.
      readonly reason: FailureReason;
      readonly sessionId: string;
      readonly prompt?: string;
      readonly modeApplied?: LaneModeApplyOutcome;
      readonly availableModeIds?: readonly string[];
    } & CarrierNotices)
  | ({
      readonly outcome: "commitFailed";
      readonly sessionId: string;
      readonly prompt: string;
      readonly modeApplied?: LaneModeApplyOutcome;
      readonly availableModeIds?: readonly string[];
    } & CarrierNotices);

/** FL-150: `signal` is omitted deliberately. Composing a prompt is pure — it reads the ledger and
 *  concatenates text — so there is nothing here a cancel could stop, and requiring a cancel authority
 *  from a caller that only wants prompt bytes would make the required field look like paperwork rather
 *  than the load-bearing thing it is on the SEND path. `runCarrierTurn` still requires it. */
export type PromptInput = Omit<CarrierTurnInput, "transport" | "signal"> & {
  readonly mode?: "delta" | "catchup";
};

function briefingReason(
  cursor: ReturnType<typeof getLaneCursor>,
  mode: PromptInput["mode"],
): "coldstart" | "fallback" | "recarry" {
  if (cursor === undefined || cursor.generation === 0) return "coldstart";
  return mode === "catchup" ? "fallback" : "recarry";
}

export function composeCarrierPrompt(input: PromptInput): CarrierPrompt {
  const raised: RoomNotice[] = [];
  try {
    return composeCarrierPromptSteps(input, raised);
  } catch (error) {
    // MN fix round 2 (I-1, reviewer-confirmed): a notice classified EARLIER in this composition (e.g.
    // an unreadable lane cursor) must not vanish just because a LATER, unrelated step of the SAME
    // composition throws — the exact shape of one corrupt evidence database failing both the cursor
    // read and the delta read. Before this fix, `publishNotices` ran exactly once, at the very end —
    // a throw anywhere before it skipped the publish entirely and the room never learned. This is the
    // ONLY publish reached on the throw path (the steps' own publish never runs when we land here),
    // so nothing double-fires on the ordinary, non-throwing path.
    publishNotices(input, raised);
    throw error;
  }
}

// Split out of composeCarrierPrompt (function-line clamp, same precedent as every other extracted
// step in this file) so the try/catch above stays a thin, readable guard around it.
function composeCarrierPromptSteps(input: PromptInput, raised: RoomNotice[]): CarrierPrompt {
  const now = input.now?.() ?? new Date().toISOString();
  // An unreadable cursor degrades to the SAME state as an absent row: carry the briefing, base the
  // delta at 0. That is deliberately the duplicate-delivery side of the trade — a lane that re-reads
  // context it already has is recoverable, a lane that silently skips context is not.
  const cursor = safely(
    input,
    raised,
    "memory-cursor-failed",
    () => getLaneCursor(input.db, input.projectId, input.agent, input.laneScopeId ?? ""),
    undefined,
  );
  const carry = cursor?.needsBriefingCarry ?? true;
  const briefing = composeCarrierBriefing(input, raised, carry, now);
  if (briefing !== undefined) {
    // The spec's briefing.injected reason enum (I-8/AC). coldstart = the lane has NEVER accepted
    // (no row, or the generation-0 SENTINEL the very first bump writes — runCarrierTurn bumps BEFORE
    // composing, so row-absence alone is unreachable here); fallback = a fresh generation's catch-up;
    // recarry = the armed flag on a live generation.
    emitBriefing(input, briefingReason(cursor, input.mode), briefing.byteCount, briefing.hash);
  }
  // CATCH-UP floor (retro BLOCK-1): a fresh generation's native process saw NOTHING — composing from
  // the dead session's cursor would deliver only seqs-after-cursor (possibly zero bytes of context).
  // Floor at 0: ledgerAfter's newest-wins packing then yields exactly the bounded ledger TAIL (I-7's
  // snapshot), with everything older carried by the overflow summary whose acceptance authorizes the
  // rebase. Duplicate delivery vs the OLD generation is by design — the new process is idempotent-new.
  const baseSeq = input.mode === "catchup" ? 0 : (cursor?.lastSeq ?? 0);
  // NOT wrapped by `safely`: `ledgerAfter` reads the ledger tables directly and can throw on a
  // corrupt/locked database exactly like `getLaneCursor` above. See composeCarrierPrompt's own catch
  // for why that is still safe for any notice already classified earlier in this composition.
  const delta = composeCarrierDelta(input, baseSeq, briefing !== undefined);
  publishNotices(input, raised);
  return promptResult({
    setup: input.setup,
    briefing: briefing?.text ?? "",
    delta: delta.block,
    operator: input.operatorMessage,
    composed: delta,
    baseSeq,
    notices: raised,
  });
}

function composeCarrierDelta(
  input: PromptInput,
  baseSeq: number,
  briefingCarried: boolean,
): ReturnType<typeof composeDelta> {
  const first = ledgerAfter(
    input.db,
    input.projectId,
    baseSeq,
    {
      maxBytes: deltaMaxBytes,
      maxMessages: deltaMaxMessages,
      ...(input.laneScopeId === undefined ? {} : { sessionId: input.laneScopeId }),
    },
    input.readBody,
  );
  const partition = partitionCarrierBudget({
    operatorBytes: Buffer.byteLength(input.operatorMessage, "utf8"),
    briefingCarried,
    mode: input.mode ?? "delta",
    overflowPending: first.overflow.pending,
  });
  const ledger = ledgerAfter(
    input.db,
    input.projectId,
    baseSeq,
    {
      ...partition.entryBudget,
      ...(input.laneScopeId === undefined ? {} : { sessionId: input.laneScopeId }),
    },
    input.readBody,
  );
  const delta =
    partition.outcome === "carrier-budget"
      ? composeDelta({
          ...ledger,
          budgetBytes: partition.entryBytes + partition.overflowHeadroomReserved,
          sessionBoundarySeq: input.sessionBoundarySeq ?? 0,
        })
      : emptyComposed(ledger);
  if (delta.overflow.pending)
    emit(input, "delta.overflow", `skippedSeqs=${delta.overflow.skippedCount}`);
  emit(input, "delta.injected", `bytes=${delta.bytes} seqs=${delta.deliveredSeqs.join(",")}`);
  // THE BOUNDARY WAVE (B7 observability): traceable ONLY when this delta actually reclassified >=1
  // prior-session entry — the common case (framedPriorSessionCount 0) emits nothing, matching every
  // other conditional emit in this function.
  if (delta.framedPriorSessionCount > 0)
    emit(input, "boundary.framed", `agent=${input.agent} count=${delta.framedPriorSessionCount}`);
  return delta;
}

function emitBriefing(input: PromptInput, reason: string, bytes: number, hash: string): void {
  emit(input, "briefing.injected", `reason=${reason} bytes=${bytes} hash=${hash}`);
}

// The send-outcome ladder: crash -> failed -> commit (commitFailed vs accepted). Split out of
// runCarrierTurn to keep it under the function-line ceiling (same precedent as classifyRecovery/
// failedTurn/emitBriefing already being their own small helpers).
// B1/B2 (MAX review fix round 1): mode application happens BEFORE send (inside transport.start,
// via openActiveSession) and is independent of whether the send itself succeeds — every
// CarrierTurnResult branch below carries the SAME mode-apply outcome, not just the happy path, so
// a mode that truly applied is never left stuck PENDING just because the SUBSEQUENT send failed.
type CarriedFields = Pick<CarrierTurnResult, "modeApplied" | "availableModeIds" | "notices">;

function modeResultFields(active: ActiveSessionResult, prompt: CarrierPrompt): CarriedFields {
  return {
    notices: prompt.notices,
    ...(active.modeApplied !== undefined ? { modeApplied: active.modeApplied } : {}),
    ...(active.availableModeIds !== undefined ? { availableModeIds: active.availableModeIds } : {}),
  };
}

async function settleCarrierSendOutcome(
  input: CarrierTurnInput,
  sent: SendResult,
  active: ActiveSessionResult,
  attemptId: string,
  prompt: CarrierPrompt,
): Promise<CarrierTurnResult> {
  const modeFields = modeResultFields(active, prompt);
  if (input.crashAfterSend === true) {
    return {
      outcome: "failed",
      reason: "transport",
      sessionId: active.sessionId,
      prompt: prompt.text,
      ...modeFields,
    };
  }
  if (sent.outcome === "failed") {
    return failedTurn(input, sent, active.sessionId, prompt.text, modeFields);
  }
  const advanced = await advanceCursorOnAccept(input.db, {
    projectId: input.projectId,
    ...(input.laneScopeId === undefined ? {} : { laneScopeId: input.laneScopeId }),
    agent: input.agent,
    attemptId,
    generation: active.generation,
    sessionId: active.sessionId,
    lastSeq: prompt.attempt.lastSeqOnAccept,
    clearBriefingCarry: prompt.carriedBriefing,
    now: input.now?.() ?? new Date().toISOString(),
  });
  if (advanced.outcome === "commitFailed") {
    // The send succeeded but our OWN durable bookkeeping didn't — genuinely uncertain.
    emit(input, "cursor.commitFailed", `attempts=${advanced.attempts}`);
    return {
      outcome: "commitFailed",
      sessionId: active.sessionId,
      prompt: prompt.text,
      ...modeFields,
    };
  }
  // The transport stays open; transport.close is the cockpit's shutdown seam.
  return {
    outcome: "accepted",
    prompt: prompt.text,
    sessionId: active.sessionId,
    carriedBriefing: prompt.carriedBriefing,
    ...modeFields,
  };
}

export async function runCarrierTurn(input: CarrierTurnInput): Promise<CarrierTurnResult> {
  const active = await openActiveSession(input);
  const prompt = composeCarrierPrompt({ ...input, mode: active.fresh ? "catchup" : "delta" });
  const attemptId = input.attemptId?.() ?? randomUUID();
  classifyRecovery(input, active.sessionId, active.generation);
  throwIfCancelledBeforeSend(input, active.sessionId);
  recordPromptAttempt(input.db, {
    attemptId,
    projectId: input.projectId,
    ...(input.laneScopeId === undefined ? {} : { laneScopeId: input.laneScopeId }),
    agent: input.agent,
    generation: active.generation,
    sessionId: active.sessionId,
    seqFrom: prompt.attempt.seqFrom,
    seqTo: prompt.attempt.seqTo,
    sentAt: input.now?.() ?? new Date().toISOString(),
  });
  const sent = await input.transport.send(prompt.text, active.sessionId);
  reportPromptSentAfterCancel(input, sent.outcome === "accepted", active.sessionId, attemptId);
  return settleCarrierSendOutcome(input, sent, active, attemptId, prompt);
}

// TAKEN DECISION (retro review, operator-ratified L9 call): pid-liveness can false-conflict for up to
// the 300s lock TTL when Windows recycles a dead holder's pid — a bounded, self-healing, FAIL-CLOSED
// availability wait (windowed mode), never a takeover or data risk. The cure (process start-time
// probes via WMI in the boot path) costs more risk than the disease.
export function acquireLaneCarrierLock(
  repoRoot: string,
  projectId: string,
  now: number,
  pid: number = process.pid,
): DigestLock | "conflict" | "no-lock" {
  const lock = acquireDigestLock(repoRoot, `lane-${projectId}`, now, pid);
  return lock === "in-flight" ? "conflict" : lock;
}

export function releaseLaneCarrierLock(lock: DigestLock): void {
  releaseDigestLock(lock);
}

async function openActiveSession(input: CarrierTurnInput): Promise<ActiveSessionResult> {
  return acquireLaneSession(input);
}

// B1/B2 (MAX review fix round 1): folds a "created"/"resumed" StartResult's modeApplied/

function promptResult(input: {
  readonly setup: string;
  readonly briefing: string;
  readonly delta: string;
  readonly operator: string;
  readonly composed: ReturnType<typeof composeDelta>;
  readonly baseSeq: number;
  readonly notices: readonly RoomNotice[];
}): CarrierPrompt {
  const lastDelivered = input.composed.deliveredSeqs.at(-1) ?? input.baseSeq;
  // THE UNIFIED OVERFLOW RULE (I-7): a cursor may rebase past UNDELIVERED seqs only when the accepted
  // prompt actually CARRIED the overflow summary block. composeDelta always renders it when pending
  // (bytes > 0); the degenerate giant-operator path composes an EMPTY block (bytes 0) — its acceptance
  // authorizes nothing beyond the delivered seqs, so the overflow stays PENDING for the next turn.
  const summaryCarried = input.composed.overflow.pending && input.composed.bytes > 0;
  const lastSeqOnAccept = summaryCarried
    ? Math.max(lastDelivered, input.composed.overflow.skippedToSeq)
    : lastDelivered;
  const seqFrom = summaryCarried
    ? input.composed.overflow.skippedFromSeq
    : (input.composed.deliveredSeqs[0] ?? input.baseSeq);
  return {
    text: [input.setup, input.briefing, input.delta, input.operator]
      .filter((part) => part.length > 0)
      .join("\n\n"),
    attempt: { seqFrom, seqTo: lastSeqOnAccept, lastSeqOnAccept },
    carriedBriefing: input.briefing.length > 0,
    deliveredSeqs: input.composed.deliveredSeqs,
    overflowPending: input.composed.overflow.pending,
    notices: input.notices,
  };
}

function emptyComposed(ledger: ReturnType<typeof ledgerAfter>): ReturnType<typeof composeDelta> {
  return {
    block: "",
    bytes: 0,
    deliveredSeqs: [],
    overflow: ledger.overflow,
    framedPriorSessionCount: 0,
  };
}

function classifyRecovery(input: CarrierTurnInput, sessionId: string, generation: number): void {
  const unresolved = listUnresolvedAttempts(input.db, {
    projectId: input.projectId,
    ...(input.laneScopeId === undefined ? {} : { laneScopeId: input.laneScopeId }),
    agent: input.agent,
    generation,
    sessionId,
  });
  if (unresolved.length > 0) {
    // ALWAYS maybeDuplicate: whether the native side completed the crashed send is UNKNOWABLE from the
    // durable state we keep (no send-resolved marker on the attempt row). Claiming `delta.duplicate`
    // from a seq-range match would fabricate confidence; the range merely proves the delta recomputed
    // identically. `delta.duplicate` stays reserved for a future durable native-completion signal.
    emit(input, "delta.maybeDuplicate", `attempts=${unresolved.length}`);
  }
}

function failedTurn(
  input: CarrierTurnInput,
  sent: Extract<SendResult, { outcome: "failed" }>,
  sessionId: string,
  prompt: string,
  modeFields: CarriedFields,
): CarrierTurnResult {
  if (sent.reason === "agyCapture") emit(input, "resume.fallback", "reason=agy_id_capture");
  return { outcome: "failed", reason: sent.reason, sessionId, prompt, ...modeFields };
}

function emit(
  input: { readonly trace?: TraceBus; readonly turn: number },
  phase: MemoryTracePhase,
  detail: string,
): void {
  if (input.trace === undefined || !debugEnabled()) return;
  input.trace.emit({ kind: "memory.trace", phase, turn: input.turn, detail });
}
