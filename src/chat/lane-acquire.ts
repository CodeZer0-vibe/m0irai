/**
 * @file src/chat/lane-acquire.ts
 * @purpose THE ONE SESSION-ACQUISITION PATH for a carrier lane: look up the stored session, resume or
 *   create it, persist the result to lane-state, and single-flight the whole thing per {projectId,
 *   agent}. Split out of lane-carrier.ts (which crossed the 600-line hard gate when W4-R2c C4's
 *   interactive budget landed); that file keeps "run ONE turn over a lane", this keeps "get me a live
 *   session for this lane". Both the boot-time eager open and every real turn come through here, which
 *   is what makes "one open path" true at the CODE level rather than merely behaviourally.
 * @exports ActiveSessionResult, AcquireLaneSessionInput, LaneAcquireSupersededError, acquireLaneSession, resetLaneAcquireCache
 * @depends ../evidence/db, ../memory/lane-state, ../shared/debug-mode, ../shared/logger, ./events, ./lane-carrier, ./lane-hold, ./types
 */
import type { Db } from "../evidence/db.js";
import {
  bumpGeneration,
  getLaneSession,
  laneBindingMatches,
  touchResumed,
} from "../memory/lane-state.js";
import { debugEnabled } from "../shared/debug-mode.js";
import { createLogger } from "../shared/logger.js";
import type { MemoryTracePhase } from "./events.js";
import type {
  CarrierTransport,
  LaneModeApplyOutcome,
  StartResult,
  TraceBus,
} from "./lane-carrier.js";
import { HOLD_SUPERSEDED_REASON } from "./lane-hold.js";
import type { AgentName } from "./types.js";

const logger = createLogger();
const PHASE = "lane-acquire";

function emit(
  input: { readonly trace?: TraceBus; readonly turn: number },
  phase: MemoryTracePhase,
  detail: string,
): void {
  if (input.trace === undefined || !debugEnabled()) return;
  input.trace.emit({ kind: "memory.trace", phase, turn: input.turn, detail });
}

/** acquireLaneSession's resolved shape — exported (W4-R REFIT R1) so eager-session-boot.ts's boot-time
 *  caller can type its own outcome projection against the SAME acquisition result runCarrierTurn uses,
 *  without duplicating the shape or importing an internal type. */
export type ActiveSessionResult = {
  sessionId: string;
  generation: number;
  fresh: boolean;
  modeApplied?: LaneModeApplyOutcome;
  availableModeIds?: readonly string[];
};

/** The narrow slice of CarrierTurnInput that session ACQUISITION needs — never operatorMessage/setup/
 *  readBody/attemptId/crashAfterSend/sessionBoundarySeq (turn-specific concerns the caller below still
 *  owns). A CarrierTurnInput satisfies this structurally, so openActiveSession passes `input` through
 *  unchanged; eager-session-boot.ts's boot-time caller builds one directly with no turn to speak of. */
export interface AcquireLaneSessionInput {
  readonly agent: AgentName;
  readonly turn: number;
  readonly binding: {
    readonly adapterPkg: string;
    readonly adapterVersion: string;
    readonly cwd: string;
  };
  readonly db: Db;
  readonly projectId: string;
  /** Native provider state scope. V2 uses the outer chat session id; legacy callers use the default. */
  readonly laneScopeId?: string;
  readonly transport: CarrierTransport;
  readonly trace?: TraceBus;
  readonly now?: () => string;
  /**
   * FL-150 — THE TURN'S CANCEL AUTHORITY, AND IT IS REQUIRED.
   *
   * It used to be `signal?`, and the ACP room path simply never passed one, so `throwIfAborted` below
   * was dead code at all three of its call sites. The PTY lane DID pass `signal: input.signal`
   * (headless-carrier.ts's agy branch), which is the entire reason gemini was the one engine that could
   * not answer through the operator's Esc. An OPTIONAL field reads as "there is no cancel on this
   * path" — which is how it got skipped for four review rounds; REQUIRED is what makes every caller
   * name its lifecycle owner out loud (the same call FL-144 made for LaneGateContext).
   *
   * A caller with no turn behind it (the boot-time eager open) passes the RUNTIME's own signal — the
   * one that fires on shutdown — never a fresh never-aborting controller.
   */
  readonly signal: AbortSignal;
  /** A genuinely new Zer0 conversation must not inherit a prior native provider context window. */
  readonly forceFresh?: boolean;
}

function throwIfAborted(input: AcquireLaneSessionInput): void {
  if (input.signal.aborted) {
    throw new Error(
      `${input.agent}: session acquisition aborted — the turn was cancelled before any prompt was sent`,
    );
  }
}

/**
 * W4-R2c C4 — HOW LONG A REAL TURN WILL WAIT FOR SOMEONE ELSE'S IN-FLIGHT SESSION OPEN.
 *
 * The operator's run, measured: codex's boot-time eager `resumeSession` hung to the FULL 60-second
 * handshake step timeout (`acp-lane-connection.ts:26`), their turn queued behind it, and codex's first
 * token arrived 75 seconds after they pressed enter. claude's eager resume was still running too; that
 * turn waited 14.2 seconds for it. Resume is an OPTIMIZATION. In that run it was a 60-second tax.
 *
 * WHERE 8 SECONDS COMES FROM, and what I could not measure. The one fresh-open cost in their artifacts
 * is codex's: `resume.fallback` at +53.45s to `boundary.framed` at +65.17s, so a fresh open cost about
 * 11.7s COLD on that machine. The bridge's own documented handshake is "~2-3s"
 * (`acp-lane-connection.ts:25`), and a resume is that handshake plus one `resumeSession` call. 8s is
 * roughly three times the documented cost and comfortably under the measured fresh-open cost, so the
 * WORST case (abandoning a resume that would have landed a moment later) costs about one fresh open,
 * while the observed case saves 46 seconds on codex.
 *
 * HONEST GAP (C6): I could not measure a WARM fresh open. That needs a live ConPTY run against the real
 * vendor bridges, which is operator-gated. This constant is derived from the code's own documented
 * handshake plus their single COLD measurement — it is a bounded, evidence-backed choice, not a
 * warm-measured one, and it should be re-checked against the first warm live run.
 */
const INTERACTIVE_ACQUIRE_BUDGET_MS = 8_000;

/**
 * A foreground turn abandoned this acquisition. The attempt itself is still running — nothing can stop
 * a bridge mid-handshake — so this is how it reports back WITHOUT looking like a failure: the lane is
 * fine, a real turn simply took it over. eager-session-boot.ts catches this specifically rather than
 * painting the chip offline for a lane that is, at that moment, actively serving the operator.
 */
export class LaneAcquireSupersededError extends Error {
  constructor(agent: AgentName) {
    super(`${agent}: session acquisition superseded by a foreground turn`);
    this.name = "LaneAcquireSupersededError";
  }
}

/** The one-bit channel from a foreground turn to the background acquisition it just abandoned.
 *  Deliberately its OWN object rather than a field on the cache entry: the running acquisition holds a
 *  reference to this and nothing else, so it cannot accidentally read or mutate cache bookkeeping. */
interface AcquireToken {
  superseded: boolean;
}

/** The in-flight acquisition for one lane: the promise other callers join, and the token that tells
 *  it to stand down. */
interface InFlightAcquire {
  readonly promise: Promise<ActiveSessionResult>;
  readonly token: AcquireToken;
}

const inFlightAcquires = new Map<string, InFlightAcquire>();

function acquireCacheKey(projectId: string, laneScopeId: string, agent: AgentName): string {
  return `${projectId}::${laneScopeId}::${agent}`;
}

/** A REAL turn, as opposed to the boot-time eager open. `turn: 0` is the established boot sentinel
 *  (eager-session-boot.ts's own call site says so); every dispatched turn is >= 1. Only a foreground
 *  caller spends the interactive budget — the background path keeps its full patience, which is C4's
 *  own instruction: the 60s step timeout may stay for the BACKGROUND path. */
function isForegroundTurn(input: AcquireLaneSessionInput): boolean {
  return input.turn > 0;
}

/** A leg of the budget race that settles when the turn is cancelled, plus the disposer that takes its
 *  listener back off the signal. Resolves rather than rejects: a rejecting leg that loses the race
 *  would be an unhandled rejection with no turn left to attach it to, which is the same hazard the
 *  no-op catch below exists to avoid. */
function cancelLeg(signal: AbortSignal): { promise: Promise<undefined>; dispose: () => void } {
  let fire: (() => void) | undefined;
  const promise = new Promise<undefined>((resolve) => {
    fire = () => resolve(undefined);
  });
  if (signal.aborted) fire?.();
  else signal.addEventListener("abort", fire as () => void, { once: true });
  return { promise, dispose: () => signal.removeEventListener("abort", fire as () => void) };
}

/**
 * Resolves to the acquisition when it lands inside `budgetMs`, or to undefined when the budget runs out
 * first. The abandoned promise is left with a no-op catch attached, never dropped bare — it may still
 * reject much later (a 60s handshake timeout), and an unhandled rejection would surface with no turn
 * left to attach it to.
 *
 * FL-150 ROUND 2 (review P2-B) — IT RACES THE CANCEL TOO, WHICH IT DID NOT.
 *
 * Measured by the reviewer on the shipped code: a turn cancelled while parked here waited the FULL
 * 8010 ms before it noticed, and then, on its way out, set `superseded` on a background acquire that
 * was perfectly healthy — killing the boot-time eager session the lane was warming, on behalf of a turn
 * that was already dead. Their control for the same tree: an ALREADY-aborted turn rejects at the door
 * in 1 ms and leaves that background acquire alone. The park had no reason to behave worse than the
 * door; it simply was not listening.
 *
 * No prompt ever escaped this window — the guards downstream held — so this is cost, not the operator's
 * defect: eight seconds of a lane that looks busy after Esc, and a warm session destroyed for nothing.
 *
 * THROWING IS WHAT LEAVES THE BACKGROUND ACQUIRE ALONE. The supersession and the cache eviction both
 * live in the caller AFTER this returns, so raising here skips them by construction rather than by a
 * flag the next edit could forget to check.
 */
async function withinBudget(
  promise: Promise<ActiveSessionResult>,
  budgetMs: number,
  input: AcquireLaneSessionInput,
): Promise<ActiveSessionResult | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), budgetMs);
  });
  const cancelled = cancelLeg(input.signal);
  try {
    const settled = await Promise.race([promise.catch(() => undefined), expiry, cancelled.promise]);
    // Asked rather than inferred: the cancel leg resolves the same `undefined` the expiry does, and a
    // turn that won its race in the very tick it was cancelled must still stop. One question, one
    // message — `throwIfAborted`'s, the same one every other guard on this path raises.
    throwIfAborted(input);
    return settled;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    cancelled.dispose();
  }
}

/**
 * W4-R REFIT R1: the ONE session-acquisition path — looks up the stored lane session, resumes or
 * creates via transport.start, and persists the result to lane-state (touchResumed/bumpGeneration).
 * Used by BOTH the per-turn openActiveSession below and eager-session-boot.ts's boot-time callers, so
 * "one open path" holds at the CODE level, not just behaviorally (architect review, W4-R REFIT R1: a
 * boot-time start() that bypassed this persistence would leave the eagerly-opened session unrecognized
 * by the FIRST real turn's own getLaneSession lookup, which would then open a SECOND session and
 * silently orphan the first).
 * SINGLE-FLIGHT per (projectId, laneScopeId, agent): a concurrent second caller (e.g. a fast first real turn racing
 * an in-flight eager boot-open) awaits the SAME in-flight acquisition instead of racing a parallel
 * transport.start — without this, both callers would read getLaneSession's "nothing stored yet" BEFORE
 * either persists, and each would open its own fresh session (an orphaned duplicate; the sequential
 * persist-then-read fix alone does not close this concurrent window). The cache entry lives ONLY while
 * an acquisition is in flight (cleared in `finally`) — a LATER, separate turn's call is never held back
 * by a long-settled promise; it re-invokes the acquire fresh, which itself resolves quickly via
 * transport.start's own already-held-and-alive fast path (lane-transport.ts).
 */
export async function acquireLaneSession(
  input: AcquireLaneSessionInput,
): Promise<ActiveSessionResult> {
  throwIfAborted(input);
  const key = acquireCacheKey(input.projectId, input.laneScopeId ?? "", input.agent);
  const existing = inFlightAcquires.get(key);
  if (existing !== undefined) {
    if (!isForegroundTurn(input)) return existing.promise;
    // A cancel landing during this park raises from inside, so the supersession below is never reached
    // and the background acquire this turn merely joined survives it (review P2-B).
    const joined = await withinBudget(existing.promise, INTERACTIVE_ACQUIRE_BUDGET_MS, input);
    if (joined !== undefined) return joined;
    // THE BUDGET EXPIRED. Stand the in-flight attempt down and open FRESH for this turn.
    //
    // CONTINUITY, PAID DELIBERATELY: abandoning the resume gives up this lane's prior-session context
    // for this turn — the agent starts from the catch-up path instead of remembering. That is the
    // right trade for a CHAT turn, where the operator is watching a dead screen, and the wrong one for
    // a background open, which is why only a foreground turn ever reaches this branch. The existing
    // resume.fallback trace carries the loss into the artifacts so it is never invisible.
    existing.token.superseded = true;
    inFlightAcquires.delete(key);
    emit(
      input,
      "resume.fallback",
      `reason=interactive_budget_${String(INTERACTIVE_ACQUIRE_BUDGET_MS)}ms_expired`,
    );
    return startAcquire(key, input, true);
  }
  return startAcquire(key, input, input.forceFresh === true);
}

/** Registers a fresh single-flight entry and runs the acquisition under its own supersession token.
 *  `forceFresh` skips the stored-session resume entirely — set only by the budget branch above,
 *  because re-attempting the SAME resume against the SAME wedged bridge is exactly the 60-second wait
 *  the budget just escaped. */
function startAcquire(
  key: string,
  input: AcquireLaneSessionInput,
  forceFresh: boolean,
): Promise<ActiveSessionResult> {
  const token: AcquireToken = { superseded: false };
  const promise = acquireLaneSessionUncached(input, token, forceFresh).finally(() => {
    // Only clear the entry if it is still OURS — a superseded attempt settling late must never evict
    // the foreground acquisition that replaced it.
    if (inFlightAcquires.get(key)?.token === token) inFlightAcquires.delete(key);
  });
  inFlightAcquires.set(key, { promise, token });
  return promise;
}

/** Test-only: clears the single-flight cache so a leaked in-flight promise from one test (e.g. a
 *  deliberately-hung mock transport) can never bleed into a later test's own acquisition. */
export function resetLaneAcquireCache(): void {
  inFlightAcquires.clear();
}

/** The RESUME branch: reconnect the stored session id, or report why we are falling through to a
 *  fresh open. Extracted so acquireLaneSessionUncached stays inside the complexity clamp — the two
 *  halves (reuse what exists / create what does not) are separable by nature. */
async function tryResumeStored(
  input: AcquireLaneSessionInput,
  token: AcquireToken,
  stored: NonNullable<ReturnType<typeof getLaneSession>>,
): Promise<ActiveSessionResult | undefined> {
  emit(input, "resume.attempted", `session=${stored.sessionId}`);
  const opened = await input.transport.start(stored.sessionId);
  throwIfAborted(input);
  // W4-R2c C4: a foreground turn gave up on us while that call was in flight. Touching lane-state now
  // would persist a session the turn is no longer using, and falling through to a fresh open would be
  // a THIRD session on a lane that already has two. Stand down instead — the transport's own epoch
  // guard has already closed (or orphan-reported) whatever connection this attempt produced.
  if (token.superseded) throw new LaneAcquireSupersededError(input.agent);
  if (opened.outcome === "resumed") {
    touchResumed(
      input.db,
      input.projectId,
      input.agent,
      input.now?.() ?? new Date().toISOString(),
      input.laneScopeId ?? "",
    );
    emit(input, "resume.ok", `session=${stored.sessionId}`);
    return activeSessionResult(stored.sessionId, stored.generation, false, opened);
  }
  const reason = opened.outcome === "resumeFailed" ? opened.reason : "unexpected_create";
  emit(input, "resume.fallback", `reason=${reason}`);
  // FL-150: the `emit` above is DEBUG-GATED (`debugEnabled()`), so on an ordinary run the moment a
  // lane silently stops being the session the operator has been talking to left no trace at all. That
  // silence is what made the operator's incident unreadable after the fact — the escaping prompt rode
  // this exact branch and the artifacts could not say why the resume missed. One durable line, at the
  // one place a stored session is abandoned.
  //
  // ROUND 2 (review P3-D): WARN is for a resume that FAILED — expired, unknown id, a binding that no
  // longer matches. A supersession is not a failure: it is what `lane-gate.ts`'s forceFreshConnection
  // ASKS FOR when it sanctions a reconnect, and the reviewer watched this line fire on exactly that in
  // their own gate run. An alarm that goes off during a designed action trains its reader to skip it,
  // and the next real one goes unread. Same fact, honest volume. This selects a LEVEL and nothing else
  // — no decision changes on either branch, which is what keeps HOLD_SUPERSEDED_REASON out of control
  // flow, as its own header requires.
  const write = reason === HOLD_SUPERSEDED_REASON ? logger.info : logger.warn;
  write(
    { phase: PHASE, agent: input.agent },
    reason === HOLD_SUPERSEDED_REASON
      ? "lane resume superseded; opening a fresh session as asked"
      : "lane resume failed; opening a fresh session",
    { storedSessionId: stored.sessionId, reason, turn: input.turn },
  );
  return undefined;
}

async function acquireLaneSessionUncached(
  input: AcquireLaneSessionInput,
  token: AcquireToken,
  forceFresh: boolean,
): Promise<ActiveSessionResult> {
  const stored = forceFresh
    ? undefined
    : getLaneSession(input.db, input.projectId, input.agent, input.laneScopeId ?? "");
  if (stored !== undefined) {
    if (laneBindingMatches(stored, input.binding)) {
      const resumed = await tryResumeStored(input, token, stored);
      if (resumed !== undefined) return resumed;
    } else {
      // I-2: any binding component mismatch invalidates the id BEFORE any resume attempt (F-2/F-3).
      emit(input, "resume.fallback", "reason=binding_mismatch");
    }
  }
  // FL-150 — THE FALLBACK CREATE IS A SECOND CHANCE TO SEND, SO IT ASKS THE SIGNAL AGAIN FIRST.
  //
  // This is the line the operator's own measured escape came through. A cancel that lands while a
  // RESUME is in flight makes `dropHold` bump the supersession epoch; the resume then reports
  // `resumeFailed` and `tryResumeStored` returns undefined, and control arrives HERE — at a `start()`
  // that takes a BRAND NEW epoch, is therefore above the `closedThrough` the cancel just wrote, and
  // succeeds. Their DB shows the session it produced created 5.900 s after the cancel with the prompt
  // 4 ms behind it. Checking BEFORE the call is what stops a cancelled turn from spawning a whole
  // bridge child; the check after it covers an abort that lands while the spawn is in flight.
  throwIfAborted(input);
  const created = await input.transport.start(undefined);
  throwIfAborted(input);
  if (token.superseded) throw new LaneAcquireSupersededError(input.agent);
  if (created.outcome !== "created") {
    throw new Error(
      `fresh session failed: ${created.outcome === "resumeFailed" ? created.reason : "unexpected_resume"}`,
    );
  }
  const bumped = bumpGeneration(input.db, {
    ...input.binding,
    agent: input.agent,
    projectId: input.projectId,
    ...(input.laneScopeId === undefined ? {} : { laneScopeId: input.laneScopeId }),
    sessionId: created.sessionId,
    now: input.now?.() ?? new Date().toISOString(),
  });
  return activeSessionResult(created.sessionId, bumped.generation, true, created);
}
// availableModeIds onto the shared ActiveSessionResult shape — a small helper so both
// openActiveSession branches stay readable rather than repeating the optional-field spread twice.
function activeSessionResult(
  sessionId: string,
  generation: number,
  fresh: boolean,
  started: Extract<StartResult, { outcome: "created" | "resumed" }>,
): ActiveSessionResult {
  return {
    sessionId,
    generation,
    fresh,
    ...(started.modeApplied !== undefined ? { modeApplied: started.modeApplied } : {}),
    ...(started.availableModeIds !== undefined
      ? { availableModeIds: started.availableModeIds }
      : {}),
  };
}
