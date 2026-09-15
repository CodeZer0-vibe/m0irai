/**
 * @file src/chat/headless-carrier.ts
 * @purpose Carrier-backed headless lane executor for runHeadlessTurn: preserves dispatch.started,
 *   streamed stdout, finalizeLane evidence, and settle callback parity while swapping the send primitive.
 * @exports runCarrierHeadlessLane
 * @depends node:fs/promises, ../adapters/acp/acp-servers, ../adapters/pty/agy-version, ../evidence/blobs, ../evidence/db, ./agy-carrier, ./headless-prompt, ./lane-carrier, ./lane-carrier-cancel-send, ./lane-transport, ./session-store, ./tower-bridge-lane, ./turn-lifecycle, ./usage-reporter
 */
import { writeFile } from "node:fs/promises";
import { resolveAcpSpec } from "../adapters/acp/acp-servers.js";
import { normalizeAcpToolActivity } from "../adapters/acp/acp-tool-activity.js";
import { probeAgyVersion } from "../adapters/pty/agy-version.js";
import type { AgentInput } from "../adapters/types.js";
import { getBlobSync } from "../evidence/blobs.js";
import type { Db } from "../evidence/db.js";
import { createLogger } from "../shared/logger.js";
import { runAgyCarrierTurn } from "./agy-carrier.js";
import { responseFilePath } from "./controller-helpers.js";
import { composeHeadlessSetup, composeOperatorTask } from "./headless-prompt.js";
import type { HeadlessAddress, HeadlessTurnInput } from "./headless-turn.js";
import { assertTurnCancelAuthority } from "./lane-carrier-cancel-send.js";
import { type LaneModeApplyOutcome, runCarrierTurn } from "./lane-carrier.js";
import {
  carrierRuntime,
  getOrCreateLaneDetector,
  getOrCreateLaneTransport,
} from "./lane-transport.js";
import { writePromptFile } from "./session-store.js";
import { LaneObserver, type LaneOutcome, emitStarted, finalizeLane } from "./tower-bridge-lane.js";
import { classifyLaneError } from "./turn-lifecycle.js";
import type { AgentName } from "./types.js";
import { createUsageReporter } from "./usage-reporter.js";

const logger = createLogger();
const PHASE = "headless-carrier";
// H3: the agy version is PROBED live once per process (`agy --version`; ACP versions were already
// live per I-2/F-2). The constant is only the FLOOR when the probe fails (agy absent/broken) — the
// old always-floor behavior missed real upgrades (live-hit: floor 1.0.8 vs installed 1.1.1) and F-2
// invalidation never fired on them. An upgrade now mismatches the stored binding → catch-up rebase.
const AGY_PKG = "agy" as const;
const AGY_FLOOR_VERSION = "1.0.8";

type CarrierAgent = "claude" | "codex" | "gemini";
type CarrierAddress = HeadlessAddress & { readonly agent: CarrierAgent };

export async function runCarrierHeadlessLane(
  input: HeadlessTurnInput,
  address: CarrierAddress,
): Promise<LaneOutcome> {
  const { session, bus, turn } = input;
  const started = Date.now();
  const observer = new LaneObserver(address.agent);
  const sink = laneStreamSink(bus, observer, address.agent, turn);
  emitStarted(bus, address.agent, turn);
  const laneSession = {
    current: undefined as string | undefined,
    statuslineCwd: undefined as string | undefined,
  };
  const usage = createUsageReporter({
    bus,
    agent: address.agent,
    cwd: session.repoRoot,
    startedMs: started,
    turn,
    carrier: true,
    laneSessionId: () => laneSession.current,
    agyStatuslineCwd: () => laneSession.statuslineCwd,
    ...(input.usagePoll === undefined ? {} : { usagePoll: input.usagePoll }),
  });
  const result = await dispatchCarrierLane(input, address, sink, observer, usage);
  laneSession.current = result.sessionId;
  laneSession.statuslineCwd = result.statuslineCwd;
  markEmptyOutputFailed(observer);
  const outputPath = responseFilePath(session.runDir, turn, address.agent);
  const canonicalText =
    input.canonicalizeLaneText?.(address.agent, observer.outcome().text) ?? observer.outcome().text;
  await writeResponseFile(outputPath, canonicalText);
  const outcome = await finalizeLane({
    bus,
    observer,
    turn,
    prompt: result.prompt,
    outputPath,
    sessionId: session.id,
    repoRoot: session.repoRoot,
    config: input.config,
    durationMs: Date.now() - started,
    canonicalText,
    ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
    alreadyStreamed: sink.fired(),
  });
  await settleLane(input, address.agent, outcome);
  kickoffUsageCapture(input, usage);
  return outcome;
}

function laneStreamSink(
  bus: HeadlessTurnInput["bus"],
  observer: LaneObserver,
  agent: AgentName,
  turn: number,
) {
  let fired = false;
  return {
    fired: () => fired,
    onChunk: (chunk: string) => {
      fired = true;
      observer.observe({ kind: "output", text: chunk });
      bus.emit({ agent, chunk, kind: "agent.stdout", turn });
    },
  };
}

async function dispatchCarrierLane(
  input: HeadlessTurnInput,
  address: CarrierAddress,
  sink: ReturnType<typeof laneStreamSink>,
  observer: LaneObserver,
  usage: ReturnType<typeof createUsageReporter>,
): Promise<{
  readonly prompt: string;
  readonly sessionId?: string;
  readonly statuslineCwd?: string;
}> {
  try {
    // `return await`, deliberately: a returned-unawaited promise REJECTS PAST this catch (live-hit:
    // the B2 unresolvable-seq throw escaped to the caller instead of failing the lane).
    if (address.agent === "gemini") {
      return await dispatchAgyCarrier(input, { ...address, agent: "gemini" }, observer);
    }
    return await dispatchAcpCarrier(
      input,
      { ...address, agent: address.agent },
      sink,
      observer,
      usage,
    );
  } catch (error) {
    observer.markTerminal(classifyLaneError(error, input.signal), errorMessage(error));
    return { prompt: composeOperatorTask(address.prompt) };
  }
}

// Wave-seal B3: the per-lane detector rides the RAW session-update tap — compaction events arm the
// durable carry (F-6), ctx% feeds the F-7 inference, accepted prompts drive the periodic floor. Split
// out of dispatchAcpCarrier so that function stays under the line-count clamp.
function buildAcpTransport(
  agent: "claude" | "codex",
  sink: ReturnType<typeof laneStreamSink>,
  usage: ReturnType<typeof createUsageReporter>,
  onLaneActivity: HeadlessTurnInput["onLaneActivity"],
): {
  readonly transport: ReturnType<typeof getOrCreateLaneTransport>;
  readonly detector: ReturnType<typeof getOrCreateLaneDetector>;
} {
  const detector = getOrCreateLaneDetector(agent);
  const transport = getOrCreateLaneTransport(agent, {
    onText: sink.onChunk,
    onSessionUpdate: (update) => {
      detector.onLaneUpdate(update);
      usage.recordAcpSessionUpdate(update);
      const parsed = usageFromUpdateForDetector(update);
      if (parsed !== undefined && parsed.size > 0) {
        detector.onCtxPercent((parsed.used / parsed.size) * 100);
      }
      const activity = normalizeAcpToolActivity(update);
      if (activity !== undefined) onLaneActivity?.(agent, activity);
    },
  });
  return { transport, detector };
}

async function dispatchAcpCarrier(
  input: HeadlessTurnInput,
  address: HeadlessAddress & { readonly agent: "claude" | "codex" },
  sink: ReturnType<typeof laneStreamSink>,
  observer: LaneObserver,
  usage: ReturnType<typeof createUsageReporter>,
): Promise<{
  readonly prompt: string;
  readonly sessionId?: string;
  readonly statuslineCwd?: string;
}> {
  const rt = requiredRuntime();
  const { transport, detector } = buildAcpTransport(
    address.agent,
    sink,
    usage,
    input.onLaneActivity,
  );
  const carrierTurn = {
    agent: address.agent,
    turn: input.turn,
    // ONE resolution per turn (retro TOCTOU decision): binding + entry from the same read; a mid-turn
    // npm install diverging the transport's spawn is caught one turn late by F-2 (designed boundary).
    binding: { ...resolveAcpSpec(address.agent).binding, cwd: rt.cwd },
    db: rt.db,
    operatorMessage: composeOperatorTask(address.prompt),
    projectId: rt.projectId,
    ...(rt.laneScopeId.length === 0 ? {} : { laneScopeId: rt.laneScopeId }),
    readBody: projectBodyReader(input, rt.db),
    setup: composeHeadlessSetup(address.agent),
    transport,
    // FL-150 — THE LINE THAT WAS MISSING, and the whole of the asymmetry. The agy branch below has
    // always passed this turn's signal (`laneInput`'s `signal: input.signal`), which is exactly why
    // gemini was the one engine that could not answer through the operator's Esc. Same signal, same
    // turn, both carriers now — see CarrierTurnInput.signal's own header for why it is not optional.
    signal: input.signal,
    trace: input.bus,
    // THE BOUNDARY WAVE: see lane-carrier.ts's own CarrierTurnInput.sessionBoundarySeq doc.
    sessionBoundarySeq: input.sessionBoundarySeq ?? 0,
  };
  assertTurnCancelAuthority(input, carrierTurn);
  const result = await runCarrierTurn(carrierTurn);
  settleAcpCarrierResult(input, address.agent, observer, detector, result);
  await writePromptFile(input.session, input.turn, address.agent, result.prompt ?? "");
  return { prompt: result.prompt ?? "", ...carrierSessionId(result) };
}

function settleAcpCarrierResult(
  input: HeadlessTurnInput,
  agent: "claude" | "codex",
  observer: LaneObserver,
  detector: ReturnType<typeof getOrCreateLaneDetector>,
  result: Awaited<ReturnType<typeof runCarrierTurn>>,
): void {
  if (result.outcome === "accepted") {
    detector.onPromptAccepted({ carriedBriefing: result.carriedBriefing });
  } else {
    // F1: derive the death text from the classified reason (lane-transport's sendHeld set "quota"/"auth"),
    // so recordLaneDispatchResult one layer up marks the lane exhausted/needs-auth on the carrier (memory-ON)
    // path too. A plain failure keeps the generic carrier text — not a credit/auth death. Unless the turn
    // was CANCELLED, which outranks every failure reason: see markCarrierTerminal.
    markCarrierTerminal(observer, input.signal, carrierFailureText(result));
  }
  // B1/B2/B3 (MAX review fix round 1): result.modeApplied is present exactly when THIS call's
  // transport.start() ran a GENUINE create/resume (lane-transport.ts's applyRestoredMode) — absent
  // on the "already held and alive" fast-path reuse, where nothing changed and no event is needed.
  if (result.modeApplied !== undefined) {
    emitModeSession(input.bus, agent, input.turn, result.modeApplied, result.availableModeIds);
  }
}

function emitModeSession(
  bus: HeadlessTurnInput["bus"],
  agent: "claude" | "codex",
  turn: number,
  modeApplied: LaneModeApplyOutcome,
  availableModeIds: readonly string[] | undefined,
): void {
  bus.emit({
    kind: "mode.session",
    agent,
    turn,
    outcome: modeApplied.outcome,
    modeId: modeApplied.modeId,
    ...(modeApplied.outcome === "failed" ? { reason: modeApplied.reason } : {}),
    ...(availableModeIds !== undefined ? { availableModeIds } : {}),
  });
}

/** The agy turn, assembled. Split out of dispatchAgyCarrier so that function stays inside the
 *  function-line clamp — the same reason buildAcpTransport exists one branch over. */
async function buildAgyTurn(
  input: HeadlessTurnInput,
  address: HeadlessAddress & { readonly agent: "gemini" },
  rt: NonNullable<ReturnType<typeof carrierRuntime>>,
) {
  const agyVersion = (await probeAgyVersion()) ?? AGY_FLOOR_VERSION;
  return {
    agent: "gemini" as const,
    turn: input.turn,
    binding: { adapterPkg: AGY_PKG, adapterVersion: agyVersion, cwd: rt.cwd },
    db: rt.db,
    input: laneInput(input, address),
    operatorMessage: composeOperatorTask(address.prompt),
    projectId: rt.projectId,
    ...(rt.laneScopeId.length === 0 ? {} : { laneScopeId: rt.laneScopeId }),
    readBody: projectBodyReader(input, rt.db),
    setup: composeHeadlessSetup("gemini"),
    // FL-150: the SAME signal `laneInput` above already puts on the AgentInput. runAgyCarrierTurn
    // asserts the two are one object — one turn, one cancel authority, never two that can disagree.
    signal: input.signal,
    trace: input.bus,
    writePrompt: (prompt: string) => inputWritePrompt(input, address.agent, prompt),
    // THE BOUNDARY WAVE: see lane-carrier.ts's own CarrierTurnInput.sessionBoundarySeq doc.
    sessionBoundarySeq: input.sessionBoundarySeq ?? 0,
  };
}

async function dispatchAgyCarrier(
  input: HeadlessTurnInput,
  address: HeadlessAddress & { readonly agent: "gemini" },
  observer: LaneObserver,
): Promise<{
  readonly prompt: string;
  readonly sessionId?: string;
  readonly statuslineCwd?: string;
}> {
  const rt = requiredRuntime();
  const detector = getOrCreateLaneDetector("gemini");
  const agyTurn = await buildAgyTurn(input, address, rt);
  // ROUND 2: the same assembly-site check the ACP branch now carries. runAgyCarrierTurn's own
  // assertOneCancelAuthority still guards the AgentInput half; this guards the turn half, so both
  // carriers are defended at the same point by the same rule rather than one of them by luck.
  assertTurnCancelAuthority(input, agyTurn);
  const result = await runAgyCarrierTurn(agyTurn);
  if (result.reply.length > 0) observer.observe({ kind: "output", text: result.reply });
  if (result.outcome === "accepted") {
    // agy's floor is signal-less: the periodic re-carry counter is its ONLY inference source (Q-3).
    detector.onPromptAccepted({ carriedBriefing: result.carriedBriefing });
  } else {
    // The SAME cancel rule as the ACP branch, deliberately not a weaker twin. agy's abort normally
    // REJECTS (agy-runner.ts:113-115) and is classified by dispatchCarrierLane's catch, so this branch is
    // reached on a cancel only when the capture failed by RETURN instead — the exact asymmetry that let
    // the ACP lane mislabel every cancel. One rule, both carriers.
    markCarrierTerminal(observer, input.signal, carrierFailure(result.outcome));
  }
  return {
    prompt: result.prompt,
    ...carrierSessionId(result),
    ...(result.statuslineCwd === undefined ? {} : { statuslineCwd: result.statuslineCwd }),
  };
}

function carrierSessionId(result: unknown): { readonly sessionId?: string } {
  if (typeof result !== "object" || result === null || !("sessionId" in result)) return {};
  return typeof result.sessionId === "string" ? { sessionId: result.sessionId } : {};
}

function laneInput(input: HeadlessTurnInput, address: HeadlessAddress): AgentInput {
  return {
    agent: address.agent,
    contextFile: "",
    worktreePath: input.session.repoRoot,
    signal: input.signal,
    ...((address.grant ?? input.grant) === undefined
      ? {}
      : { grant: address.grant ?? input.grant }),
    agyConversationDir: input.session.runDir,
  };
}

function requiredRuntime(): NonNullable<ReturnType<typeof carrierRuntime>> {
  const rt = carrierRuntime();
  if (rt === undefined) throw new Error("carrier runtime is not initialized");
  return rt;
}

// PROJECT-SCOPED body resolver (wave-seal B2): the in-memory session is the fast path; any other
// minted message (another chat run, the windowed second cockpit) resolves DURABLY from chat_messages +
// the blob store. A seq whose body cannot be resolved THROWS — dispatchCarrierLane's catch fails the
// lane and the cursor is PRESERVED, so the carrier never advances past context it did not deliver.
function projectBodyReader(input: HeadlessTurnInput, db: Db) {
  const messages = new Map(input.session.messages.map((m) => [m.id, m]));
  return (messageId: string): { readonly author: string; readonly body: string } => {
    const message = messages.get(messageId);
    if (message !== undefined) {
      return { author: authorOf(message.role, message.agent), body: message.text };
    }
    const row = db
      .prepare("SELECT role, agent, text_blob_hash AS hash FROM chat_messages WHERE id = ? LIMIT 1")
      .get(messageId) as { role: string; agent: string; hash: string } | undefined;
    if (row === undefined) {
      throw new Error(
        `ledger body missing for message ${messageId} — refusing to advance past undelivered context`,
      );
    }
    const body = getBlobSync({ rootDir: input.config.blobRoot }, row.hash).toString("utf8");
    return { author: authorOf(row.role, row.agent), body };
  };
}

function authorOf(role: string, agent: string): string {
  return role === "user" ? "operator" : agent;
}

async function inputWritePrompt(
  input: HeadlessTurnInput,
  agent: AgentName,
  prompt: string,
): Promise<string> {
  return writePromptFile(input.session, input.turn, agent, prompt);
}

// The carrier twin of headless-turn.ts's markEmptyOutputFailed, and it carries the SAME FL-144 hazard: it
// takes no signal, so a lane the operator stopped whose carrier returned accepted-but-empty is classified
// `failed`. markCarrierTerminal above only runs on a NON-accepted result, so it cannot cover this one.
function markEmptyOutputFailed(observer: LaneObserver): void {
  const pre = observer.outcome();
  if (pre.state === "completed" && pre.text.length === 0) {
    observer.markTerminal("failed", "ran but produced an empty result");
  }
}

async function settleLane(
  input: HeadlessTurnInput,
  agent: AgentName,
  outcome: LaneOutcome,
): Promise<void> {
  if (input.onLaneSettled === undefined) return;
  try {
    await input.onLaneSettled(agent, outcome);
  } catch (error) {
    logger.warn({ phase: PHASE }, "lane-settle callback failed; lane unaffected", {
      agent,
      reason: errorMessage(error),
    });
  }
}

function kickoffUsageCapture(
  input: HeadlessTurnInput,
  usage: ReturnType<typeof createUsageReporter>,
): void {
  usage.capturePostLane(input.captureUsage).catch(() => undefined);
}

async function writeResponseFile(outputPath: string, text: string): Promise<void> {
  await writeFile(outputPath, text, "utf8").catch(() => undefined);
}

function carrierFailure(outcome: string): string {
  return outcome === "commitFailed" ? "carrier cursor commit failed" : `carrier ${outcome}`;
}

// The terminal text for a cancelled carrier turn. Never rendered in the room row — the view drops the
// detail for a cancelled lane (room_scrollback.rs:704-707) — so this is what the EVIDENCE row and the
// lane's dispatch.failed carry. Deliberately says nothing about who stopped it: the same abort signal is
// raised by an operator cancel, a room pause and a shutdown quiesce (room-engine.ts:161-163, :309-311,
// :485-487), and naming only the first would be a guess printed as a fact.
const CARRIER_CANCELLED_TEXT = "stopped before it finished";

/**
 * THE CANCEL EDGE — the one thing the carrier could not see. A cancel is not a failure, and on the ACP
 * lane NOTHING in the result says so. The room aborts the lane's controller and then DROPS THE HOLD
 * (room-engine.ts:485-487 → room-host.ts:110-112), which kills the bridge child underneath the in-flight
 * prompt; sendHeld catches that rejection and RETURNS `{outcome:"failed", reason:"transport"}`
 * (lane-hold.ts:554-561). So the turn ends by RETURN, never by throw — and the returning path never
 * reached classifyLaneError, the one place that reads the signal. That is the whole defect: claude and
 * codex printed `failed: carrier failed` on a deliberate stop, while gemini, whose runner REJECTS on
 * abort (agy-runner.ts:113-115) and so lands in dispatchCarrierLane's catch, already printed `cancelled`.
 *
 * The signal is the authority in both, and it is the one upstream trusts first: grok reads its LOCAL
 * `agent.session.state.is_cancelling()` — the flag set when the cancel is issued — before it reads the
 * wire's stop reason (xai-grok-pager/src/app/dispatch/prompt.rs:1191-1195), and routes a cancelled turn
 * to a cancelled event rather than TurnFailed (:1345-1366). DEVIATION, stated: upstream ALSO has the wire
 * half, because it cancels in-band with an `acp::CancelNotification` over a connection that stays alive
 * (effects/mod.rs:1303-1305). This room cancels by killing the connection, so there is no stop reason to
 * read — the channel that would carry it is the thing that was destroyed. The local signal decides alone.
 *
 * NOT a cancel: a turn whose signal never fired. That failure keeps its classified reason and still marks
 * the lane down, which is the distinction this whole fix exists to preserve.
 */
function markCarrierTerminal(
  observer: LaneObserver,
  signal: AbortSignal,
  failureText: string,
): void {
  if (signal.aborted) {
    observer.markTerminal("cancelled", CARRIER_CANCELLED_TEXT);
    return;
  }
  observer.markTerminal("failed", failureText);
}

// F1 (FIX-3): the death text for a failed carrier turn. A classified credit/auth reason (lane-transport's
// sendHeld) renders the child-CLI death so recordLaneDispatchResult marks the lane exhausted/needs-auth;
// anything else keeps the generic carrier text (a transport hiccup is not a death).
function carrierFailureText(result: Awaited<ReturnType<typeof runCarrierTurn>>): string {
  if (result.outcome === "failed") {
    if (result.reason === "quota") return "out of usage credits";
    if (result.reason === "auth") return "authentication required";
  }
  return carrierFailure(result.outcome);
}

function usageFromUpdateForDetector(
  update: unknown,
): import("../shared/turn-usage.js").TurnUsage | undefined {
  if (typeof update !== "object" || update === null || !("sessionUpdate" in update))
    return undefined;
  if (update.sessionUpdate !== "usage_update") return undefined;
  const used = "used" in update ? update.used : undefined;
  const size = "size" in update ? update.size : undefined;
  return typeof used === "number" && typeof size === "number" ? { used, size } : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
