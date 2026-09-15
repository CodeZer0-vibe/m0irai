/**
 * @file src/chat/headless-turn.ts
 * @depends node:fs/promises, ../adapters/types, ../memory/memory-flags, ../shared/debug-mode, ../shared/logger, ../shared/room-notice, ./controller-helpers, ./dispatch-headless, ./events, ./headless-carrier, ./headless-prompt, ./headless-turn-outcomes, ./lane-carrier-briefing, ./lane-transport, ./session-store, ./usage-reporter, ./tower-bridge-lane, ./turn-lifecycle, ./types
 * @exports HeadlessAddress, LaneSettleCallback, HeadlessTurnInput, runHeadlessTurn, mergeHeadlessOutcomes, classifyLaneError
 * @size-justified Mature headless dispatch contract with lifecycle, usage capture, and merge helpers.
 * @purpose The cockpit's HEADLESS dispatch lane (the reliable default replacing the per-action tower lane).
 *   Per agent: compose the prompt (headless-prompt) → context file, emit dispatch.started, dispatch the
 *   buffered subscription adapter, map the result onto a LaneObserver, finalize via the SHARED finalizeLane
 *   (agent.stdout → completed|failed + evidence). Mode is per-address (build = write-capable in the repo
 *   cwd, git is the undo; chat/research read-only). PARALLEL by default; SEQUENTIAL threads each reply into
 *   the next agent's context (council / name-based chains).
 *   W3 (THE GREAT DELETION, 2026-07-17): every build-mode address dispatches UNCONDITIONALLY now — the
 *   write-queue gate (write-queue-gate.ts), the pre-turn checkpoint producer (headless-turn-checkpoint.ts),
 *   the review-capture settle barrier (headless-turn-review-settle.ts), and the redirect-injection overlay
 *   (headless-turn-redirect.ts, which only ever served review_redirects rows) are DELETED along with the
 *   write_queue/write_lease/review_deltas/review_redirects DB tables they read and wrote. "Three agents
 *   write different files in one @all turn → all three execute, no waiting" is now true unconditionally,
 *   not merely because slice-zero's routineWriteSerializationDisarmed() no-oped the gate — the gate itself
 *   is gone. Git is the change record (D4's receipt line, built one layer up at the cockpit turn-completion
 *   call site, reads it back); nothing in this file mutates or reads any review/queue table.
 */
import { writeFile } from "node:fs/promises";
import type { AcpToolActivity } from "../adapters/acp/acp-tool-activity.js";
import type { AgentInput } from "../adapters/types.js";
import { carrierEnabled } from "../memory/memory-flags.js";
import type { AgentGrant } from "../shared/agent-grant.js";
import { debugEnabled } from "../shared/debug-mode.js";
import { createLogger } from "../shared/logger.js";
import type { RoomNotice } from "../shared/room-notice.js";
import { responseFilePath } from "./controller-helpers.js";
import { type HeadlessDispatch, dispatchHeadless } from "./dispatch-headless.js";
import type { ChatEventBus } from "./events.js";
import { runCarrierHeadlessLane } from "./headless-carrier.js";
import { type LaneClass, composePrompt, countFramedInRecentWindow } from "./headless-prompt.js";
import {
  laneOutcomeMessage,
  mergeHeadlessOutcomes,
  safeLaneFailureReason,
} from "./headless-turn-outcomes.js";
// MN round 2b: reuses the carrier path's own publish primitive (headless-carrier.ts:208's
// `trace: input.bus` is the exact same "ChatEventBus satisfies TraceBus" precedent this relies on)
// rather than hand-rolling a second bus-emit helper for the one non-carrier call site that has a bus.
import { publishNotices } from "./lane-carrier-briefing.js";
import {
  type LaneGateContext,
  gateLaneOrBlock,
  handleEscapedLaneError,
  recordLaneDispatchResult,
} from "./lane-gate.js";
import { carrierRuntime } from "./lane-transport.js";
import { writePromptFile } from "./session-store.js";
import { LaneObserver, type LaneOutcome, emitStarted, finalizeLane } from "./tower-bridge-lane.js";
import { classifyLaneError } from "./turn-lifecycle.js";
import type { AgentName, ChatMessage, ChatSession } from "./types.js";
import { type UsageCaptureOverride, createUsageReporter } from "./usage-reporter.js";

const logger = createLogger();
const PHASE = "headless-turn";

/**
 * One headless address: WHICH agent runs WHICH prompt, optionally with its OWN grant. A name-based chain
 * segment sets its own grant (from its task's intent); single/council addresses leave it and inherit the
 * turn's grant.
 */
export interface HeadlessAddress {
  readonly agent: AgentName;
  readonly prompt: string;
  readonly grant?: AgentGrant;
}

/**
 * The lane-settle WRITE BARRIER (U1). Fired EXACTLY ONCE per opened lane, AWAITED after that lane's
 * finalizeLane completes and BEFORE the lane's outcome resolves into the aggregate — so a per-agent tail
 * can release the moment ITS lane settles, independent of sibling lanes. Returns the message a council
 * merge REUSES (id equality), or undefined. A later task supplies the real writing callback; here it is a
 * dormant seam (absent → legacy behavior). Unrelated to W3's deletion — this is a general lane-lifecycle
 * hook, never review/capture-specific.
 */
export type LaneSettleCallback = (
  agent: AgentName,
  outcome: LaneOutcome,
) => Promise<ChatMessage | undefined>;

/** Receives one provider-reported ACP tool-call update; absent keeps legacy headless dispatch unchanged. */
export type LaneActivityCallback = (agent: AgentName, activity: AcpToolActivity) => void;

/** Everything one headless turn needs to dispatch its lanes + mirror the bus + persist evidence. */
export interface HeadlessTurnInput {
  readonly session: ChatSession;
  readonly addresses: readonly HeadlessAddress[];
  readonly bus: ChatEventBus;
  readonly turn: number;
  readonly laneClass: LaneClass;
  readonly grant?: AgentGrant;
  readonly config: { readonly dbPath: string; readonly blobRoot: string };
  /** A durable room-lane result identity; omitted for legacy callers. */
  readonly messageId?: string;
  /** THE BOUNDARY WAVE: the ledger seq high-water-mark at this chat session's boot (live-derived at
   *  chat-tui-mount.ts, never persisted). Threaded to the carrier lanes' CarrierTurnInput.sessionBoundarySeq
   *  (lane-carrier.ts) so a prior-session operator entry is framed untrusted. Read directly off THIS
   *  object by headless-carrier.ts's dispatchAcpCarrier/dispatchAgyCarrier (runOneLane forwards the
   *  same input reference, never reconstructs it) — carrier lanes ONLY; irrelevant to the composePrompt
   *  path below. Absent = 0 (dormant seam). */
  readonly sessionBoundarySeq?: number;
  /** THE BOUNDARY WAVE: count of session.messages present at THIS chat session's boot (live-derived at
   *  chat-tui-mount.ts, never persisted). Forwarded to composePrompt's own option of the same name.
   *  Absent = 0 (dormant seam). */
  readonly priorSessionMessageCount?: number;
  readonly signal: AbortSignal;
  /**
   * Run the addresses ONE AT A TIME, threading each reply into the next agent's context (a delegated chain:
   * "claude plan, codex audit it" → codex reads claude's plan). Default false = parallel fan-out.
   */
  readonly sequential?: boolean;
  /** Dispatch seam — defaults to the real adapter registry; a unit test injects a fake (no CLI spawn). */
  readonly dispatch?: HeadlessDispatch;
  /**
   * Post-lane usage-capture seam (advisory). Defaults to the real codex+claude capture. FIRE-AND-FORGET
   * (never awaited) so a slow/hung status read can never delay the lane it follows (codex BLOCK-1); a unit
   * test injects a hung capture to prove the lane outcome still returns.
   */
  readonly captureUsage?: UsageCaptureOverride;
  readonly usagePoll?: {
    readonly timeoutMs?: number;
    readonly intervalMs?: number;
    readonly signal?: AbortSignal;
  };
  /**
   * Lane-settle write barrier (U1). See {@link LaneSettleCallback}: fired once per opened lane, AWAITED
   * after finalize (unlike the fire-and-forget captureUsage) so the lane does not resolve into the
   * aggregate until it settles; a throw/rejection is isolated so it never fails the lane. Absent =
   * legacy behavior.
   */
  readonly onLaneSettled?: LaneSettleCallback;
  /**
   * Canonicalize provider text before the first durable evidence write. Room uses this to remove its
   * final-line handoff control directive while retaining the directive as structured scheduler state.
   * The hook may change text only; identity, terminal state, and the caller-owned message ID remain owned
   * by finalizeLane.
   */
  readonly canonicalizeLaneText?: (agent: AgentName, text: string) => string;
  /** Live ACP tool activity seam. Gemini/agy has no raw ACP updates and never invokes it. */
  readonly onLaneActivity?: LaneActivityCallback;
}

/**
 * Runs ONE headless turn over `addresses` and returns one LaneOutcome per lane. Each lane emits
 * dispatch.started → agent.stdout (once, buffered) → dispatch.completed|failed and persists the SAME
 * dispatch + message rows the tower path writes, in the repo cwd with its grant (present = write-capable
 * work turn; absent = read-only review). PARALLEL by default; sequential threads each reply to the next agent.
 * W3: every address dispatches — there is no gate, no checkpoint, no queue. A build-mode "@all write
 * different files" turn runs all addressed agents concurrently; git is the sole record of what changed.
 *
 * @param input - the turn's session, addresses, bus, mode, config, sequential flag, and (optional) dispatch
 * @returns the per-lane outcomes (single-agent callers ignore them; council/chains merge them)
 */
export async function runHeadlessTurn(input: HeadlessTurnInput): Promise<readonly LaneOutcome[]> {
  const dispatch = input.dispatch ?? dispatchHeadless;
  return input.sequential === true
    ? runSequential(input, dispatch)
    : Promise.all(input.addresses.map((address) => runOneLane(input, address, dispatch)));
}

/**
 * Runs the addresses ONE AT A TIME, threading each reply into the next agent's shared context (a delegated
 * chain — "claude plan, codex audit it" — so codex reads claude's plan, not a stale file). Each lane
 * persists + emits exactly as in parallel; only ordering + per-agent context differ. Empty lane threads nothing.
 */
async function runSequential(
  input: HeadlessTurnInput,
  dispatch: HeadlessDispatch,
): Promise<readonly LaneOutcome[]> {
  let session = input.session;
  const outcomes: LaneOutcome[] = [];
  for (const address of input.addresses) {
    const outcome = await runOneLane({ ...input, session }, address, dispatch);
    outcomes.push(outcome);
    session = mergeHeadlessOutcomes(session, [outcome], input.turn);
  }
  return outcomes;
}

// Builds one lane's adapter input. agyConversationDir (the session's run dir) turns on agy conversation
// continuity — set for the GEMINI lane ONLY: agy persists/resumes its conversation id there (per-session ⇒
// no cross-session bleed), while claude/codex are persistent pty sessions that continue on their own AND use
// a strict input schema, so the agy-only key must not reach them.
function laneDispatchInput(
  address: HeadlessAddress,
  contextFile: string,
  grant: AgentGrant | undefined,
  session: ChatSession,
  signal: AbortSignal,
): AgentInput {
  return {
    agent: address.agent,
    contextFile,
    worktreePath: session.repoRoot,
    signal,
    ...(grant === undefined ? {} : { grant }),
    ...(address.agent === "gemini" ? { agyConversationDir: session.runDir } : {}),
  };
}

// A live-stream sink for one lane: each reply-chunk is BOTH observed (so the full — or partial, if the turn later
// fails — text survives into the response file + evidence) AND emitted as agent.stdout so the cockpit renders it
// live. A streaming dispatcher (ACP) calls it per chunk; the buffered pty/registry path never does. `fired` tells
// finalizeLane to SKIP its buffered re-emit (which would otherwise duplicate the already-streamed chunks).
function laneStreamSink(
  bus: ChatEventBus,
  observer: LaneObserver,
  agent: AgentName,
  turn: number,
): { onChunk: (chunk: string) => void; fired: () => boolean } {
  let fired = false;
  return {
    fired: () => fired,
    onChunk: (chunk) => {
      fired = true;
      observer.observe({ kind: "output", text: chunk });
      bus.emit({ agent, chunk, kind: "agent.stdout", turn });
    },
  };
}

// Runs ONE lane's adapter dispatch: streams via the sink, observes the buffered reply when the sink did not
// already stream it (ACP streams live; pty/registry buffer), and maps a DispatchError onto the observer's
// terminal. Returns the ACP transport's turn usage (used/size) when the result carried it — undefined on the
// pty/registry path or on a failure (a failed turn reports no usage).
async function runDispatch(
  laneInput: AgentInput,
  dispatch: HeadlessDispatch,
  observer: LaneObserver,
  sink: ReturnType<typeof laneStreamSink>,
  signal: AbortSignal,
): Promise<import("../shared/turn-usage.js").TurnUsage | undefined> {
  try {
    const result = await dispatch(laneInput, sink.onChunk);
    if (!sink.fired()) observer.observe({ kind: "output", text: result.stdout });
    return result.usage;
  } catch (error) {
    observer.markTerminal(classifyLaneError(error, signal), dispatchErrorMessage(error));
    return undefined;
  }
}

/**
 * Drives ONE lane end-to-end: compose the context file, emit started, dispatch the adapter (streaming via the
 * sink, or buffered) with the address's grant (or the turn's), map the result onto a LaneObserver (output on
 * success, error on a DispatchError), then finalize through the shared finalizeLane so bus + evidence match.
 * W3: no gate, no checkpoint, no redirect overlay — composePrompt is called directly.
 */
async function runOneLane(
  input: HeadlessTurnInput,
  address: HeadlessAddress,
  dispatch: HeadlessDispatch,
): Promise<LaneOutcome> {
  // F1: the pre-dispatch gate runs BEFORE emitStarted/transport for BOTH paths. A dead lane's send is
  // refused locally here (no dispatch.started, no child spawned) with a first-class visible skip; a live
  // (or sanctioned-retry) lane falls through to dispatch, and its outcome is recorded into the durable
  // availability (a credit/auth death marks it dead; a success clears it).
  // BLOCK 3: awaited — a sanctioned retry drops the lane's held (possibly wedged) connection inside the
  // gate, so the recovery dispatch below is carried by a connection opened AFTER the sanction.
  // FL-144: the gate ALSO returns a first-class `cancelled` outcome when the turn's signal is already
  // aborted, so the early return below is no longer a synonym for "blocked". The two exits that SYNTHESIZE
  // an outcome here — the gate's and handleEscapedLaneError's — now read that signal off one shared
  // LaneGateContext. ⚠ The middle exit does NOT: it returns whatever finalizeLane classified, and
  // recordLaneDispatchResult only READS that state. See markEmptyOutputFailed for the hole that leaves.
  const gate = laneGateContext(input);
  const settled = await gateLaneOrBlock(gate, address.agent);
  if (settled !== undefined) {
    return settled;
  }
  try {
    const outcome = usesCarrier(input, address)
      ? await runCarrierHeadlessLane(input, address)
      : await runNonCarrierLane(input, address, dispatch);
    recordLaneDispatchResult(gate, address.agent, outcome);
    return outcome;
  } catch (error) {
    return handleEscapedLaneError(gate, address.agent, error);
  }
}

function laneGateContext(input: HeadlessTurnInput): LaneGateContext {
  return {
    bus: input.bus,
    repoRoot: input.session.repoRoot,
    turn: input.turn,
    signal: input.signal,
  };
}

// MN round 2b (I-2's declared seam, closed): composes the prompt AND publishes whatever
// memory-briefing failures it classified onto the room bus — the ONLY room-reachable call site for
// the non-carrier lane. Mirrors lane-carrier.ts's own publishNotices call inside
// composeCarrierPrompt; headless-carrier.ts:208's `trace: input.bus` is the same "ChatEventBus
// satisfies TraceBus" precedent this relies on. `binding.cwd` is unused by publishNotices itself but
// required by its NoticeOrigin type; session.repoRoot is the correct value regardless (matches every
// other notice-origin construction in this codebase). Split out of runNonCarrierLane for the
// function-line clamp.
function composeNonCarrierPrompt(input: HeadlessTurnInput, address: HeadlessAddress): string {
  const { session, bus, turn } = input;
  const notices: RoomNotice[] = [];
  const prompt = composePrompt(session, address.prompt, address.agent, turn, {
    laneClass: input.laneClass,
    dbPath: input.config.dbPath,
    priorSessionMessageCount: input.priorSessionMessageCount ?? 0,
    notices,
  });
  publishNotices(
    { agent: address.agent, binding: { cwd: session.repoRoot }, turn, trace: bus },
    notices,
  );
  return prompt;
}

// The non-carrier headless dispatch body (composePrompt → adapter dispatch → finalize). Split out of
// runOneLane so the F1 gate/record wrap both lane paths uniformly (the carrier path is runCarrierHeadlessLane).
async function runNonCarrierLane(
  input: HeadlessTurnInput,
  address: HeadlessAddress,
  dispatch: HeadlessDispatch,
): Promise<LaneOutcome> {
  const { session, bus, turn } = input;
  const grant = address.grant ?? input.grant;
  const prompt = composeNonCarrierPrompt(input, address);
  emitBoundaryFramedTrace(bus, address.agent, session, turn, input.priorSessionMessageCount ?? 0);
  const contextFile = await writePromptFile(session, turn, address.agent, prompt);
  emitStarted(bus, address.agent, turn);
  const started = Date.now();
  const observer = new LaneObserver(address.agent);
  const sink = laneStreamSink(bus, observer, address.agent, turn);
  const laneInput = laneDispatchInput(address, contextFile, grant, session, input.signal);
  // The ACP result carries the turn's context usage (used/size); captured for the claude-only emit AFTER
  // finalize. A dispatch throw leaves it undefined → a failed turn reports no usage. Absent on the pty path.
  const acpUsage = await runDispatch(laneInput, dispatch, observer, sink, input.signal);
  // U1: reclassify a ran-but-empty CLEAN lane as failed BEFORE finalize (one terminal event, never a
  // completed a later layer re-emits as failure). See markEmptyOutputFailed — the scheduler gating holds.
  markEmptyOutputFailed(observer);
  const durationMs = Date.now() - started;
  const outcome = await finalizeObservedLane({
    input,
    address,
    observer,
    prompt,
    durationMs,
    sink,
  });
  // U1 write barrier: fire the lane-settle callback ONCE, AFTER finalize, and AWAIT it (see settleLane) —
  // the lane's outcome must not resolve into the aggregate until this per-lane write lands (per-agent tails
  // release on THEIR lane's settle, not the turn's). Isolated so it never fails the lane; unlike the
  // advisory usage capture that follows, it IS awaited.
  await settleLane(input.onLaneSettled, address.agent, outcome);
  reportLaneUsage(input, address.agent, started, acpUsage);
  return outcome;
}

type FinalizeObservedLaneArgs = Readonly<{
  input: HeadlessTurnInput;
  address: HeadlessAddress;
  observer: LaneObserver;
  prompt: string;
  durationMs: number;
  sink: ReturnType<typeof laneStreamSink>;
}>;

async function finalizeObservedLane(args: FinalizeObservedLaneArgs): Promise<LaneOutcome> {
  const { input, address, observer, prompt, durationMs, sink } = args;
  const outputPath = responseFilePath(input.session.runDir, input.turn, address.agent);
  const canonicalText =
    input.canonicalizeLaneText?.(address.agent, observer.outcome().text) ?? observer.outcome().text;
  await writeResponseFile(outputPath, canonicalText);
  return finalizeLane({
    bus: input.bus,
    observer,
    turn: input.turn,
    prompt,
    outputPath,
    sessionId: input.session.id,
    repoRoot: input.session.repoRoot,
    config: input.config,
    durationMs,
    canonicalText,
    ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
    alreadyStreamed: sink.fired(),
  });
}

function reportLaneUsage(
  input: HeadlessTurnInput,
  agent: AgentName,
  startedMs: number,
  acpUsage: import("../shared/turn-usage.js").TurnUsage | undefined,
): void {
  const usage = createUsageReporter({
    bus: input.bus,
    agent,
    cwd: input.session.repoRoot,
    startedMs,
    turn: input.turn,
    ...(input.usagePoll === undefined ? {} : { usagePoll: input.usagePoll }),
  });
  usage.recordAcpResult(acpUsage);
  kickoffUsageCapture(input, usage);
}

type CarrierAgent = "claude" | "codex" | "gemini";

function usesCarrier(
  input: HeadlessTurnInput,
  address: HeadlessAddress,
): address is HeadlessAddress & { agent: CarrierAgent } {
  return (
    input.laneClass === "chat" &&
    // A held carrier may be running a persisted full-access provider mode.
    // Grantless agent hops must use the non-carrier path, where every adapter
    // has an explicit read-only configuration instead of inheriting that mode.
    (address.grant ?? input.grant) !== undefined &&
    carrierEnabled() &&
    // lanesEnabled, not mere presence: the WINDOWED second cockpit holds a mint-only runtime (F-16)
    // and must never run carrier turns against the holder's lane state (I-14).
    carrierRuntime()?.lanesEnabled === true &&
    isCarrierAgent(address.agent)
  );
}

function isCarrierAgent(agent: AgentName): agent is CarrierAgent {
  return agent === "claude" || agent === "codex" || agent === "gemini";
}

// U2d: claude's ctx% under ACP. The ACP transport reports the turn's context usage ON the result (used/size,
// U2d-b: + any rate-limit windows the session captured); the pty path writes a statusLine file the post-lane
// poll (captureClaudeStatus) reads instead. claude-only — codex/gemini keep their richer sources (rollout
// rate-limits / agy statusLine), which this window must not clobber. foldClaudeWindows carries learned
// 5h/weekly meters ACROSS turns (codex B1: the ACP session — and its in-session fold — is per-turn, while
// the model merge is wholesale-replace), so a ctx-only turn never blanks them. A pure in-memory bus emit
// (no I/O); a missing/zero-size usage simply emits nothing.
// Kicks off the advisory usage capture DETACHED (codex BLOCK-1): the lane must NOT await it — a slow rollout
// walk / payload read would hold Promise.all on this lane (parallel) or delay the next agent (sequential).
// Each half is error-isolated inside its own capture (logger.warn); the trailing .catch guards an injected
function kickoffUsageCapture(
  input: HeadlessTurnInput,
  usage: ReturnType<typeof createUsageReporter>,
): void {
  usage.capturePostLane(input.captureUsage).catch(() => undefined);
}

// THE BOUNDARY WAVE (B7 observability): the non-carrier lane's own trace — the carrier path emits its
// SAME "boundary.framed" phase independently from lane-carrier.ts's composeCarrierDelta (delta-composer.ts's
// framedPriorSessionCount). Gated on debugEnabled() (mirrors lane-carrier.ts's own emit() convention) and
// on the ACTUAL rendered count (countFramedInRecentWindow, never a raw watermark check) so a boundary far
// outside this turn's recent window never produces a false-positive trace. BLOCK 4 fix (codex sol MAX
// review round 1): NO try/catch here — a well-formed emit (a registered MemoryTracePhase, real fields)
// never throws from schema validation, and ChatEventBus.emit already isolates a THROWING HANDLER
// internally (events.ts's own per-handler try/catch), so the only way this call can throw is a genuine
// bug in this function's own event shape — which must surface loudly (a test failure), never be masked.
// Matches every other bus.emit call in this file (emitStarted is called bare, with no wrapping try/catch).
// PRESERVED byte-identical across W3 — the boundary wave's protections are outside the deletion inventory.
function emitBoundaryFramedTrace(
  bus: ChatEventBus,
  agent: AgentName,
  session: ChatSession,
  turn: number,
  priorSessionMessageCount: number,
): void {
  if (priorSessionMessageCount <= 0 || !debugEnabled()) {
    return;
  }
  const framedCount = countFramedInRecentWindow(session, turn, priorSessionMessageCount);
  if (framedCount === 0) {
    return;
  }
  bus.emit({
    kind: "memory.trace",
    phase: "boundary.framed",
    turn,
    detail: `agent=${agent} count=${String(framedCount)}`,
  });
}

// U1: reclassify a ran-but-empty CLEAN lane as failed. A lane that already failed (its terminal was set in
// the catch — failed/timed_out/cancelled) or produced any text is left untouched; ONLY a clean, text-less
// lane becomes a failure with an honest reason. Idempotent read of observer.outcome() (a pure snapshot).
// ⚠ FL-144 PROBE-CONFIRMED A FIFTH CANCEL SEAM HERE and left it (out of that brief's scope): no signal is
// read, so a STOPPED lane whose adapter returned clean+empty rather than throwing classifies `failed` —
// and recordLaneDispatchResult then paints the chip `auth:"down"`, the operator's original complaint.
function markEmptyOutputFailed(observer: LaneObserver): void {
  const pre = observer.outcome();
  if (pre.state === "completed" && pre.text.length === 0) {
    observer.markTerminal("failed", "ran but produced an empty result");
  }
}

// U1 write barrier: await the lane-settle callback (if wired) exactly once, isolating a throw/rejection so
// it NEVER fails the lane (mirrors the advisory-capture isolation, but this one IS awaited — the aggregate
// must not resolve until the per-lane write lands). The returned message flows to a council merge via the
// caller-supplied callback's own closure; here we only hold the barrier.
async function settleLane(
  onLaneSettled: LaneSettleCallback | undefined,
  agent: AgentName,
  outcome: LaneOutcome,
): Promise<void> {
  if (onLaneSettled === undefined) {
    return;
  }
  try {
    await onLaneSettled(agent, outcome);
  } catch (error) {
    logger.warn({ phase: PHASE }, "lane-settle callback failed; lane unaffected", {
      agent,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

// MN round 2b: outcome→message conversion (LANE_FAILURE_MARKER, laneOutcomeMessage,
// safeLaneFailureReason, transcriptMessageId, mergeHeadlessOutcomes) moved to
// headless-turn-outcomes.ts (this file's own 600-line hard clamp had 3 lines of headroom before this
// round's fix; extraction, not a raised limit). Re-exported (mergeHeadlessOutcomes is also used
// internally, above) so every existing importer (room-host.ts, room-host-outcome.ts, this file's own
// siblings' tests) is unaffected.
export { laneOutcomeMessage, safeLaneFailureReason, mergeHeadlessOutcomes };

function dispatchErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// H2: the classifier's single home is turn-lifecycle.ts (it owns LaneTerminal; full contract doc
// there); re-exported here for the existing consumer/test import path.
export { classifyLaneError } from "./turn-lifecycle.js";

// Best-effort: the durable output lives in the evidence blob; the responses-dir file is an operator-facing
// convenience the outputPath points at. A failed write must never fail the lane (the answer already shipped
// to the bus + evidence), so it is logged and swallowed.
async function writeResponseFile(outputPath: string, text: string): Promise<void> {
  try {
    await writeFile(outputPath, text, "utf8");
  } catch (error) {
    logger.warn({ phase: PHASE }, "response file write failed, continuing", {
      outputPath,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
