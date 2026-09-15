/**
 * @file src/chat/tower-bridge-lane.ts
 * @purpose The per-lane OBSERVER adapting ONE tower lane's streaming events to the OLD chat contract.
 *          teeAdapter wraps a NativeAgentAdapter so its events() is OBSERVED (output accumulated,
 *          proposal/error captured) as the supervisor consumes it — once, never stealing an event.
 *          emitStarted/finalizeLane mirror the dispatch-service bus shape (started → stdout×N →
 *          completed|failed) + persist the SAME evidence row finalizeDispatch does. No git on repoRoot.
 * @exports LaneObserver, ObservedProposal, LaneOutcome, FinalizeConfig, FinalizeInput, teeAdapter, emitStarted, finalizeLane
 * @depends ./adapter-contract, ./controller-helpers, ./evidence, ./evidence-failure, ./events, ./message-id, ./types
 */
import { createLogger } from "../shared/logger.js";
import type { AdapterEvent, NativeAgentAdapter } from "./adapter-contract.js";
import { toCommandDispatch } from "./controller-helpers.js";
import type { ChatEventBus } from "./events.js";
import { surfaceEvidenceFailure } from "./evidence-failure.js";
import { recordLaneTurnEvidence } from "./evidence.js";
import { mintMessageId } from "./message-id.js";
import type { LaneTerminal } from "./turn-lifecycle.js";
import type { AgentName } from "./types.js";

const logger = createLogger();
const PHASE = "tower-bridge-lane";
const FAILURE_EXIT_CODE = 1;
// B5 (memory DoS): cap the per-lane accumulated output. A hostile/runaway agent could stream unbounded
// stdout; once `accumulated` reaches this many chars, further output is dropped and a single marker is
// appended ONCE. 256 KiB keeps the full real transcript while bounding the worst case.
const MAX_ACCUMULATED_CHARS = 262_144;
const TRUNCATION_MARKER = "\n…[output truncated: lane exceeded 256KB]";

/** The accumulated terminal result for one lane — the shape callers consume in place of a ChatSession. */
export interface LaneOutcome {
  readonly agent: AgentName;
  readonly text: string;
  readonly exitCode: number;
  /** F-2: the honest terminal — completed / failed / timed_out / cancelled (exitCode stays binary). */
  readonly state: LaneTerminal;
  readonly error?: string;
  /**
   * W4-R3a: THE reply's identity, minted exactly ONCE by {@link finalizeLane} and carried from there to
   * BOTH consumers — the evidence row + its ledger seq, and the transcript message. Before this existed
   * the two sides minted independently (tower-bridge-lane's persistLane and headless-turn's
   * laneOutcomeMessage), so one reply held two ids: the seq was minted against the DB id while the
   * transcript — which the digest reads as authority (digest.ts:62) — carried the other, and every agent
   * reply reported `absent from DB mirror`. Present on every FINALIZED outcome. Absent only on a synthetic
   * outcome that never reached finalize (a gate-blocked lane, lane-gate.ts:89; a registrar-synthesized
   * never-settled failure, cockpit-turn-lanes.ts:88) — those are always FAILED, and a failed lane may take
   * a transcript-only id at the consumer. A COMPLETED outcome arriving here without one is an invariant
   * breach and throws (headless-turn.ts's transcriptMessageId).
   */
  readonly messageId?: string;
  /** Minted with {@link messageId} in the same breath so the transcript row and the evidence row carry ONE
   *  timestamp for one reply, rather than two clocks read microseconds apart. */
  readonly messageCreatedAt?: string;
}

/** A proposal the lane parked on, surfaced to the cockpit (T10b) for an out-of-band decide. */
export interface ObservedProposal {
  readonly correlationId: string;
  readonly kind: string;
  readonly title: string;
  // The RAW agent-native request payload (B1): the ACTUAL command/diff/tool-input the agent wants to
  // run. Carried so the approval UI shows the real action, not just the (forge-able) title label.
  readonly payload: unknown;
}

/**
 * Accumulates ONE lane's streamed events as the supervisor consumes them. `output` chunks are
 * concatenated into `text`; the FIRST `error` is captured (and makes the lane non-clean); each
 * `proposal` is recorded so the bridge can surface it (the Controller owns the real CAS queue; this is
 * the read model). Pure in-memory state — no I/O, no side effects beyond what finalizeLane emits.
 */
export class LaneObserver {
  private accumulated = "";
  private truncated = false;
  private errorMessage: string | undefined;
  private terminal: LaneTerminal | undefined;
  private readonly chunks: string[] = [];
  private readonly seenProposals: ObservedProposal[] = [];
  // B1: observe() errors captured by teeEvents (a hostile event whose getter throws). Surfaced, not
  // swallowed: the event is STILL yielded to the supervisor, but the failed observation is recorded.
  private readonly observeErrs: string[] = [];
  // Per-lane timing — the REAL per-agent dispatch duration: first observed event → last. Captured LIVE as
  // teeEvents streams each event, so concurrent council lanes each get their OWN window, NOT the turn total
  // (the turn-level durationMs that runTowerTurn computes is the same for every lane and must NOT be trusted
  // per-agent). Clock injected so the unit test is deterministic.
  private firstEventMs: number | undefined;
  private lastEventMs: number | undefined;
  // Count of observed events. A real first→last WINDOW needs ≥2 events; with <2 (a headless single-observe
  // lane, or a silent/failed-before-output lane) there is no window and the caller uses the elapsed fallback.
  // This distinguishes "measured 0ms" (≥2 same-ms events — a genuinely fast lane) from "no window" (absent).
  private eventCount = 0;

  public constructor(
    public readonly agent: AgentName,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Records an observe() error captured by teeEvents (the event was still yielded onward). */
  public recordObserveError(message: string): void {
    this.observeErrs.push(message);
  }

  /** The observe() errors captured (B1) — non-empty iff a hostile event's getter threw in observe(). */
  public observeErrors(): readonly string[] {
    return this.observeErrs;
  }

  /** Records one observed event. Appends output (capped, B5), captures the first error, records each proposal. */
  public observe(event: AdapterEvent): void {
    const at = this.now();
    this.firstEventMs ??= at;
    this.lastEventMs = at;
    this.eventCount += 1;
    if (event.kind === "output") {
      this.appendOutput(event.text);
    } else if (event.kind === "error" && this.errorMessage === undefined) {
      this.errorMessage = event.message;
    } else if (event.kind === "proposal") {
      this.seenProposals.push({
        correlationId: event.proposal.correlationId,
        kind: event.proposal.kind,
        title: event.proposal.title,
        payload: event.proposal.payload,
      });
    }
  }

  // Appends one output chunk under the B5 cap. Once `accumulated` reaches MAX_ACCUMULATED_CHARS, the
  // remaining headroom is filled, the truncation marker is appended ONCE, and all further output is
  // dropped — so both `accumulated` and `chunks` are bounded no matter how much the agent streams.
  private appendOutput(text: string): void {
    if (this.truncated) return;
    const headroom = MAX_ACCUMULATED_CHARS - this.accumulated.length;
    if (text.length <= headroom) {
      this.accumulated += text;
      this.chunks.push(text);
      return;
    }
    const kept = text.slice(0, headroom);
    this.accumulated += kept + TRUNCATION_MARKER;
    if (kept.length > 0) this.chunks.push(kept);
    this.chunks.push(TRUNCATION_MARKER);
    this.truncated = true;
  }

  /** Proposals this lane parked on, in arrival order — the bridge's surfaced read model. */
  public proposals(): readonly ObservedProposal[] {
    return this.seenProposals;
  }

  /** The per-chunk output texts (in arrival order) — used to mirror agent.stdout×N on the bus. */
  public outputChunks(): readonly string[] {
    return this.chunks;
  }

  /**
   * Records the classified terminal for this lane (F-2): the headless caller maps the caught dispatch
   * error to cancelled / timed_out / failed; the tower path leaves it unset and the binary error/clean
   * read below applies. Also captures the message so a failed lane carries a reason.
   */
  public markTerminal(state: LaneTerminal, message: string): void {
    this.terminal = state;
    if (this.errorMessage === undefined && state !== "completed") {
      this.errorMessage = message;
    }
  }

  /** The terminal outcome: the classified state if set, else clean → completed / error observed → failed. */
  public outcome(): LaneOutcome {
    const state: LaneTerminal =
      this.terminal ?? (this.errorMessage !== undefined ? "failed" : "completed");
    if (state === "completed") {
      return { agent: this.agent, text: this.accumulated, exitCode: 0, state };
    }
    return {
      agent: this.agent,
      text: this.accumulated,
      exitCode: FAILURE_EXIT_CODE,
      error: this.errorMessage ?? state,
      state,
    };
  }

  /**
   * The lane's REAL per-agent dispatch duration in ms: first observed event → last. Events stream LIVE via
   * teeEvents, so two concurrent council lanes report their OWN windows (a slower agent → a larger activeMs),
   * unlike the turn-level durationMs. 0 when no event was observed (e.g. a lane that failed before any output).
   */
  public activeMs(): number {
    if (this.firstEventMs === undefined || this.lastEventMs === undefined) {
      return 0;
    }
    return Math.max(0, this.lastEventMs - this.firstEventMs);
  }

  /**
   * True once ≥2 events were observed — a real first→last window exists, so activeMs() is meaningful EVEN when
   * it is 0 (two events in the same millisecond = a genuinely fast lane, not an absent measurement). With <2
   * events (a headless single-observe lane, or a silent/failed-before-output lane) there is no window and the
   * caller must use the elapsed fallback instead of a misleading 0. Gating on COUNT, not on the 0 value, is
   * what keeps a fast streaming lane from being mistaken for a non-streaming one (the falsy-0 trap).
   */
  public hasWindow(): boolean {
    return this.eventCount >= 2;
  }
}

/**
 * Wraps `inner` so its events() stream is TEE'd into `observer` as the supervisor pulls it. Each event
 * is forwarded to `observer.observe` THEN yielded onward EXACTLY ONCE — the decorator is a thin
 * async-generator over the underlying iterable, so the single-consumer EventQueue contract is
 * preserved (the supervisor still drives gating/finalization off the same events). decide/start/steer/
 * close pass straight through.
 */
export function teeAdapter(inner: NativeAgentAdapter, observer: LaneObserver): NativeAgentAdapter {
  return {
    start: (opts) => inner.start(opts),
    events: () => teeEvents(inner.events(), observer),
    decide: (correlationId, decision) => inner.decide(correlationId, decision),
    steer: (text) => inner.steer(text),
    close: () => inner.close(),
  };
}

async function* teeEvents(
  source: AsyncIterable<AdapterEvent>,
  observer: LaneObserver,
): AsyncIterable<AdapterEvent> {
  for await (const event of source) {
    // B1: a hostile event (a throwing getter) must NEVER drop a supervisor event. Isolate observe() so
    // an observe failure is captured + surfaced, but the event is ALWAYS yielded onward (the supervisor
    // drives gating/finalization off this stream — a swallowed-before-yield event would silently break it).
    try {
      observer.observe(event);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      observer.recordObserveError(message);
      logger.warn({ phase: PHASE }, "lane observe() failed; event still forwarded", {
        agent: observer.agent,
        reason: message,
      });
    }
    yield event;
  }
}

/** Emits the OLD dispatch.started event for `agent` BEFORE the lane runs (consumers expect it first). */
export function emitStarted(bus: ChatEventBus, agent: AgentName, turn: number): void {
  bus.emit({ kind: "dispatch.started", turn, agent, mode: "text" });
}

/** Config a finalize needs to persist evidence (the SAME dbPath/blobRoot the chat session uses). */
export interface FinalizeConfig {
  readonly dbPath: string;
  readonly blobRoot: string;
}

/** Everything finalizeLane needs to mirror the bus + persist one lane to the evidence DB. */
export interface FinalizeInput {
  readonly bus: ChatEventBus;
  readonly observer: LaneObserver;
  readonly turn: number;
  readonly prompt: string;
  readonly outputPath: string;
  readonly sessionId: string;
  readonly repoRoot: string;
  readonly config: FinalizeConfig;
  readonly durationMs: number;
  /** Canonical visible text selected before this first durable persistence boundary. */
  readonly canonicalText?: string;
  /** A durable caller-owned output identity; absent preserves legacy minting. */
  readonly messageId?: string;
  // True when the lane already emitted its output LIVE (per-chunk agent.stdout during the turn — the ACP path).
  // finalizeLane then SKIPS the buffered agent.stdout re-emit (it would duplicate the streamed reply), but still
  // persists evidence + emits the terminal marker. Absent/false → the buffered path emits the accumulated chunk.
  readonly alreadyStreamed?: boolean;
}

/**
 * Finalizes ONE lane: emits agent.stdout×N then dispatch.completed (clean) or dispatch.failed (error),
 * mirroring dispatch-service, and persists the agent message + dispatch row in the SAME shape
 * finalizeDispatch produces (recordChatMessage + recordChatDispatch). Returns the lane outcome.
 */
export async function finalizeLane(input: FinalizeInput): Promise<LaneOutcome> {
  // W4-R3a: the ONE mint for this reply. Everything downstream — the evidence row, its ledger seq, and the
  // transcript message — takes its identity from here, so the room can join what an agent said to what the
  // ledger recorded. persistLane below consumes it; laneOutcomeMessage consumes it off the returned outcome.
  const observed = input.observer.outcome();
  const outcome: LaneOutcome = {
    ...observed,
    ...(input.canonicalText === undefined ? {} : { text: input.canonicalText }),
    messageId: input.messageId ?? mintMessageId(observed.agent),
    messageCreatedAt: new Date().toISOString(),
  };
  // The lane's REAL duration: its live per-lane window (the tower streaming path — first→last observed event)
  // when the observer saw a WINDOW (≥2 events), ELSE the elapsed input.durationMs. Gating on hasWindow (event
  // COUNT), NOT on `activeMs() || …`, is load-bearing: a fast streaming lane whose 2 events land in the same
  // millisecond has activeMs 0 but a REAL window → it reports ~0, not the turn total (the falsy-0 trap). The
  // fallback covers a headless lane (observes the buffered result ONCE → input.durationMs is its real per-agent
  // elapsed) and a silent lane (never streamed → turn elapsed, better than a misleading 0). ONE value feeds
  // both the bus event AND the evidence row, so the same dispatch never carries two different durations.
  const laneMs = input.observer.hasWindow() ? input.observer.activeMs() : input.durationMs;
  // Skip when the lane already streamed each chunk LIVE during the turn (ACP path) — re-emitting the accumulated
  // chunks here would duplicate the reply. The buffered path (alreadyStreamed falsy) emits its one chunk as before.
  if (!input.alreadyStreamed) {
    const chunks =
      input.canonicalText === undefined ? input.observer.outputChunks() : [input.canonicalText];
    for (const chunk of chunks) {
      if (chunk.length > 0) {
        input.bus.emit({ kind: "agent.stdout", turn: input.turn, agent: outcome.agent, chunk });
      }
    }
  }
  // P0 (codex review): persist evidence BEFORE signaling completion, so a green dispatch.completed is
  // never emitted ahead of its (best-effort, surfaced) evidence write. The answer already streamed via
  // agent.stdout above, so the operator sees no delay — only the terminal marker waits on the ledger write.
  await persistLane(input, outcome, laneMs);
  emitTerminal(input, outcome, laneMs);
  return outcome;
}

function emitTerminal(input: FinalizeInput, outcome: LaneOutcome, durationMs: number): void {
  const state = outcome.state;
  if (state === "completed") {
    input.bus.emit({
      kind: "dispatch.completed",
      turn: input.turn,
      agent: outcome.agent,
      exitCode: 0,
      // PER-LANE duration (live window, or elapsed fallback for a lane that did not stream) — NOT the turn-level
      // value stamped onto every lane. This is what `zer0 perf` reads for per-agent timing.
      durationMs,
      outputPath: input.outputPath,
    });
    return;
  }
  // U2e-c #8: a LIVE lane never resolves `interrupted` — that terminal is synthesized ONLY on resume for a
  // hard-killed lane (session-to-turns.ts), never here. Narrow it OUT so dispatch.failed's event schema
  // (which EXCLUDES interrupted by design — events.ts:63) stays honest; a live interrupted would be a bug, so
  // map it defensively to "failed" rather than widen the wire schema.
  const failed: "failed" | "timed_out" | "cancelled" = state === "interrupted" ? "failed" : state;
  input.bus.emit({
    kind: "dispatch.failed",
    turn: input.turn,
    agent: outcome.agent,
    exitCode: outcome.exitCode,
    // The lane's duration UP TO the failure (e.g. a 30s timeout) — so a failed lane is visible as the
    // bottleneck it is in `zer0 perf`, not a misleading 0. Same per-lane value as the completed path.
    durationMs,
    error: outcome.error ?? "lane failed",
    scope: "lane",
    state: failed,
  });
}

// persistLane only ever runs on an outcome finalizeLane just built, so the id is always there. Reading it
// through a guard rather than a `?? mint()` is deliberate: a fallback mint would silently restore the exact
// two-id split this change exists to kill, and it would do so on the DB side, where nothing would notice.
function requireFinalizedMessageId(outcome: LaneOutcome): string {
  if (outcome.messageId === undefined) {
    throw new Error(
      `lane ${outcome.agent}: persistLane reached without a finalized messageId — finalizeLane must mint it`,
    );
  }
  return outcome.messageId;
}

async function persistLane(
  input: FinalizeInput,
  outcome: LaneOutcome,
  durationMs: number,
): Promise<void> {
  const dispatch = toCommandDispatch(outcome.agent, input.prompt, input.outputPath, {
    agent: outcome.agent,
    mode: "text-only",
    exitCode: outcome.exitCode,
    durationMs,
    output: outcome.text,
    ...(outcome.error !== undefined ? { rawStderr: outcome.error } : {}),
  });
  // B2-b1: ONE fused writer records the dispatch + agent message + ledger seq in ONE transaction on ONE
  // handle (the carrier's per-session handle under an @all turn — zero extra opens), all-or-nothing, so a
  // swallows its own failure and returns {} — an absent id means the whole record rolled back, surfaced
  // here (never silently dropped), exactly as the old requireEvidenceId(dispatch/message) pair did per row.
  const evidence = await recordLaneTurnEvidence({
    dbPath: input.config.dbPath,
    blobRoot: input.config.blobRoot,
    sessionId: input.sessionId,
    turn: input.turn,
    agent: outcome.agent,
    promptContent: input.prompt,
    outputContent: dispatch.outputContent,
    stderrContent: dispatch.stderrContent,
    durationMs,
    exitCode: outcome.exitCode,
    repoRoot: input.repoRoot,
    // W4-R3a: the id finalizeLane minted for THIS reply — never a second mint. The transcript message
    // takes the same one off the returned outcome, so chat_messages.id, ledger_seq.message_id and the
    // transcript's ChatMessage.id are one value and the digest's mirror lookup can actually find the row.
    messageId: requireFinalizedMessageId(outcome),
    messageCreatedAt: outcome.messageCreatedAt ?? new Date().toISOString(),
    messageStatus:
      outcome.state === "cancelled" ? "cancelled" : outcome.exitCode === 0 ? "completed" : "failed",
  });
  if (evidence.dispatchId === undefined || evidence.messageId === undefined) {
    // CONCERN 4: forward the writer's ORIGINAL error so surfaceEvidenceFailure reads the real cause (an FK
    // breach → schema-drift). Fall back to a synthetic error only when the writer carried none (e.g. an id
    // absent without a thrown cause), preserving the prior message for that path.
    await surfaceEvidenceFailure(
      evidence.error ??
        new Error(
          "recordLaneTurnEvidence wrote no turn-record — evidence rolled back or swallowed",
        ),
      "recordLaneTurnEvidence(tower-bridge)",
    );
  }
}
