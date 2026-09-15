// @size-justified: single source of truth for every ChatEvent TS shape — every LOCKSTEP comment in
// event-schemas.ts points back here, so splitting would break the one-file-to-verify convention the
// whole event bus relies on (the same rationale event-schemas.ts's own header states for itself).
/**
 * @file src/chat/events.ts
 * @purpose Typed chat event bus and persistence schemas for UI-decoupled dispatch updates.
 * @exports ChatEvent, ChatEventKind, ChatEventHandler, ChatEventBus, ChatEventSchema, RouteClassifiedEvent, RouteDecisionEvent, RoutePickEvent, RouteVerdict, BuildLaneStatus, BuildReviewAction, BuildCardEvent, BuildRunStartedEvent, BuildLaneCreatedEvent, BuildLaneDispatchedEvent, BuildLaneCapturedEvent, BuildLaneEscapedEvent, BuildLaneFailedEvent, BuildLaneEmptyEvent, BuildReviewedEvent, AgentStatusUpdateEvent, UsagePayloadEvent, TuiFeedEvent, MemoryTraceEvent, MemoryTracePhase, MEMORY_TRACE_PHASES, ModeSessionEvent, PermissionAskEvent, RoomNoticeEvent, UndoResultEvent
 * @depends ./event-schemas, ./types, ../shared/room-notice, ../shared/types
 */
import type { z } from "zod";
import type { RoomNoticeCause } from "../shared/room-notice.js";
import type { AgentName } from "../shared/types.js";
import { ChatEventSchema as ChatEventSchemaRaw, MEMORY_TRACE_PHASES } from "./event-schemas.js";
import type { ChatIntent, ChatMode, ChatRoute, ChatWorkingSetOutcome } from "./types.js";

export type DispatchStartedMode = "text" | "tools" | "pipeline";
export type CouncilAgentStatus = "done" | "failed";
// The operator review action a `build.reviewed` event records (T4): an `accept` that applied the
// lane onto main, an `accept` that surfaced a conflict (main untouched), an `accept`/`reject`/`ack`
// that was refused (wrong state / dirty-main drift), a clean `reject`, or a failed-lane `ack`.
export type BuildReviewAction = "accepted" | "conflict" | "rejected" | "acknowledged" | "refused";
// Lane status carried on a captured/card event — the INV-5 `lane_status` field (process exited 0
// with ≥1 in-worktree artifact ⇒ captured; else failed/empty/escaped; a gemini .md lane that failed
// the gate ⇒ policy-rejected). A subset of BuildLaneState (the non-terminal-review states excluded).
export type BuildLaneStatus = "captured" | "failed" | "empty" | "escaped" | "policy-rejected";
type AgentTurn = Readonly<{ agent: AgentName; turn: number }>;
type BuildLaneRef = Readonly<{ agent: AgentName; runId: string; turn: number }>;
type RoundTurn = Readonly<{ label: string; round: number; turn: number }>;
// biome-ignore format: compact event alias keeps this file under the brief line cap.
export type UserMessageEvent = Readonly<{
  kind: "user.message";
  text: string;
  timestamp: string;
  turn: number;
}>;
// biome-ignore format: compact event alias keeps this file under the brief line cap.
export type RouteResolvedEvent = Readonly<{
  agents: readonly AgentName[];
  intent: ChatIntent;
  kind: "route.resolved";
  route: ChatRoute;
  turn: number;
}>;
// biome-ignore format: compact event alias keeps this file under the brief line cap.
export type DispatchStartedEvent = AgentTurn &
  Readonly<{ kind: "dispatch.started"; mode: DispatchStartedMode }>;
// biome-ignore format: compact discriminated union preserves ChatEventBus.on narrowing.
export type AgentOutputEvent =
  | (AgentTurn & Readonly<{ chunk: string; kind: "agent.stdout" }>)
  | (AgentTurn & Readonly<{ chunk: string; kind: "agent.stderr" }>);
// biome-ignore format: compact event alias keeps this file under the brief line cap.
export type DispatchCompletedEvent = AgentTurn &
  Readonly<{
    durationMs: number;
    exitCode: number;
    kind: "dispatch.completed";
    outputPath: string;
  }>;
// biome-ignore format: compact event alias keeps this file under the brief line cap.
// F-2: `state` is the honest terminal (failed | timed_out | cancelled) so the cockpit shows WHY a lane ended.
export type DispatchFailedEvent = AgentTurn &
  Readonly<{
    durationMs?: number | undefined;
    error: string;
    exitCode: number;
    kind: "dispatch.failed";
    scope: "lane" | "turn";
    state: "failed" | "timed_out" | "cancelled";
  }>;
/**
 * B1/B2/B3 (MAX review fix round 1): fires from lane-transport.ts's applyRestoredMode (via
 * lane-carrier.ts's CarrierTurnResult), the moment a claude/codex session GENUINELY opens or
 * resumes — never from openTurn (which fires from user.message, BEFORE transport.start() has even
 * run). `outcome`/`modeId`/`reason` mirror LaneModeApplyOutcome; `availableModeIds` (when the
 * bridge's newSession/resumeSession response advertised one) becomes the engine's LIVE cycle
 * catalog. gemini (agy) never emits this — its mode-active is dispatched synchronously and directly
 * by use-native-mode-handlers.ts, having no session-negotiation protocol to confirm against.
 */
// biome-ignore format: compact event alias keeps this file under the brief line cap.
export type ModeSessionEvent = AgentTurn &
  Readonly<{
    kind: "mode.session";
    outcome: "applied" | "failed";
    modeId: string;
    reason?: string | undefined;
    availableModeIds?: readonly string[] | undefined;
  }>;
/**
 * W4-3: an ACP permission ask reaching the operator. `phase:"pending"` announces a new ask (toolTitle
 * carries the SDK's ToolCallUpdate.title, degraded to a generic label at render if absent);
 * `phase:"settled"` reports how it resolved — approved/denied from a live keypress, timeout when no
 * response arrived in the decider's window, invalidated when the ask outlived the ACP prompt() call it
 * was born during. NOT AgentTurn-based: an ask's validity window is its OWN prompt() call, not a
 * turn-model turn number — permission-ask.ts's invalidatePendingAsk keys on `agent` alone.
 */
export type PermissionAskEvent = Readonly<{
  kind: "permission.ask";
  agent: AgentName;
  askId: string;
  phase: "pending" | "settled";
  toolTitle?: string | undefined;
  options?:
    | readonly Readonly<{
        readonly optionId: string;
        readonly kind?: string | undefined;
        readonly name?: string | undefined;
      }>[]
    | undefined;
  outcome?: "approved" | "denied" | "timeout" | "invalidated" | undefined;
  optionId?: string | undefined;
}>;
// biome-ignore format: compact event alias keeps this file under the brief line cap.
export type DiffReadyEvent = AgentTurn &
  Readonly<{ diffStat: string; filesChanged: readonly string[]; kind: "diff.ready" }>;
/**
 * TDECIDE wave-7: the bare "undo" composer trigger's VISIBLE result — mirrors review.capture.failed's
 * own precedent (a narrow new event kind mapped straight to the existing turn-model "notice" shape, no
 * new TurnAction variant needed). `text` is fully TOWER-composed (a closed AgentName + counts + minted
 * ids only — never agent-authored bytes), so it needs no INV-13 escaping of its own, same reasoning as
 * diff-review-load.ts's wholeFileMarker.
 */
// biome-ignore format: compact event alias keeps this file under the brief line cap.
export type UndoResultEvent = Readonly<{ kind: "undo.result"; text: string; turn: number }>;
/**
 * T-L11 (I-7, the shared agent-lane scheduler): the VISIBLE queue notice for an interactive turn
 * addressed to an agent the loop currently holds — mirrors review.capture.failed/undo.result's own
 * "narrow event kind -> the existing turn-model 'notice' shape" precedent (turn-bus-map.ts), never
 * dispatch.failed's terminal one, because this turn is NOT abandoned: it dispatches normally once the
 * holder releases the agent. `text` is a tower-owned plain-words
 * constant (no agent bytes), styled after write-queue-gate.ts's own QUEUED_LANE_REASON convention.
 */
// biome-ignore format: compact event alias keeps this file under the brief line cap.
export type LaneQueuedEvent = AgentTurn & Readonly<{ kind: "lane.queued"; text: string }>;
// biome-ignore format: compact event alias keeps this file under the brief line cap.
export type CouncilStartedEvent = Readonly<{
  agents: readonly AgentName[];
  kind: "council.started";
  turn: number;
}>;
// biome-ignore format: compact event alias keeps this file under the brief line cap.
export type CouncilAgentDoneEvent = AgentTurn &
  Readonly<{ kind: "council.agent.done"; status: CouncilAgentStatus }>;
export type CouncilCompleteEvent = { readonly kind: "council.complete"; readonly turn: number };
export type DebateRoundStartEvent = RoundTurn & Readonly<{ kind: "debate.round-start" }>;
// biome-ignore format: compact event alias keeps this file under the brief line cap.
export type DebateAgentResultEvent = AgentTurn &
  Readonly<{
    kind: "debate.agent-result";
    outcome: ChatWorkingSetOutcome;
    round: number;
    summary?: string | undefined;
  }>;
export type DebateRoundCompleteEvent = RoundTurn & Readonly<{ kind: "debate.round-complete" }>;
// biome-ignore format: compact event alias keeps this file under the brief line cap.
export type SessionSavedEvent = Readonly<{
  kind: "session.saved";
  runDir: string;
  sessionId: string;
}>;
/**
 * The cockpit's SMART PICK (T10d): the human-readable mode line the smart turn runner emits BEFORE it
 * dispatches a line, so the operator sees WHICH mode the classifier chose — e.g. `[debate]`,
 * `[council]`, `[build] → @codex`, `[research] → @gemini`, `[ask] → @claude`. `text` is a
 * TOWER-OWNED CONSTANT assembled from the route (no agent bytes → ChromeText path, INV-13 holds); the
 * cockpit renders it as a SYSTEM transcript line (mapped to a `notice` action). LOCKSTEP with
 * RoutePickSchema — every field below MUST appear there or the bus drops it on parse.
 */
// biome-ignore format: compact event alias keeps this file under the brief line cap.
export type RoutePickEvent = Readonly<{ kind: "route.pick"; text: string; turn: number }>;
/**
 * INV-6: the smart-router pick (mode + human-readable reason) for a plain message, emitted
 * BEFORE any dispatch so the operator sees WHY a turn was routed (AC-5). The schema field and
 * this type are kept in lockstep — see RouteClassifiedSchema. VESTIGE SWEEP S8 (2026-07-17): the
 * former requiresConfirm field is DELETED (operator ruling (2) killed the y/n confirm-card
 * apparatus, S5) — see event-schemas.ts's RouteClassifiedSchema for the persisted-event compat note.
 */
// biome-ignore format: compact event alias keeps this file under the brief line cap.
export type RouteClassifiedEvent = Readonly<{
  kind: "route.classified";
  mode: ChatMode;
  reason: string;
  turn: number;
}>;
/**
 * The transparency verdict carried by a {@link RouteDecisionEvent}: the secure outcome chosen for a
 * write-capable turn. Declared HERE as a standalone union so events.ts stays dependency-free (the
 * event layer never imports a routing module). `reject-all` corresponds to the legacy guard's
 * `reject-all-build`; the emit site maps it.
 */
// `gemini-research` is the additive verdict for a natural-language gemini research/design ask routed
// to the `.md`-gated lane (Task 3 emits it; the field is declared here so the trace can carry it).
export type RouteVerdict =
  | "isolated-build"
  | "reject-gemini"
  | "reject-all"
  | "passthrough"
  | "gemini-research";
/**
 * ROUTING transparency (operator mandate — "see what really happens behind zer0 chat"): one event per
 * write-capable routing DECISION, so every reject (`@gemini build`, `@all build`) and every isolated
 * build is visible in ZER0_CHAT_TRACE, not terminal-only. `reason` is the human string already shown
 * to the operator; `agents`/`laneCount` are populated for the isolated-build path (omitted on rejects).
 * The schema field set and this type are kept in lockstep — see RouteDecisionSchema (non-strict bus).
 */
// biome-ignore format: compact event alias keeps this file under the brief line cap.
export type RouteDecisionEvent = Readonly<{
  agents?: readonly AgentName[] | undefined;
  kind: "route.decision";
  laneCount?: number | undefined;
  reason: string;
  turn: number;
  verdict: RouteVerdict;
}>;
// BUILD-pillar observability (T3): one event per lane-lifecycle step so a real build is fully
// traceable in ZER0_CHAT_TRACE (the operator mandate — "the trace is how we see + debug builds").
// build.card carries the 3 separately-sourced reconciliation fields (INV-5): lane_status, mergeable,
// on_task (always `unverified` in MVP — no reviewer exists yet).
// biome-ignore format: compact event alias keeps this file under the brief line cap.
export type BuildRunStartedEvent = Readonly<{
  agents: readonly AgentName[];
  kind: "build.run.started";
  runId: string;
  turn: number;
}>;
// biome-ignore format: compact event alias keeps this file under the brief line cap.
export type BuildLaneCreatedEvent = BuildLaneRef &
  Readonly<{ kind: "build.lane.created"; worktreePath: string }>;
export type BuildLaneDispatchedEvent = BuildLaneRef & Readonly<{ kind: "build.lane.dispatched" }>;
// biome-ignore format: compact event alias keeps this file under the brief line cap.
export type BuildLaneCapturedEvent = BuildLaneRef &
  Readonly<{
    changedFiles: readonly string[];
    kind: "build.lane.captured";
    laneStatus: BuildLaneStatus;
  }>;
// biome-ignore format: compact event alias keeps this file under the brief line cap.
export type BuildLaneEscapedEvent = BuildLaneRef &
  Readonly<{ kind: "build.lane.escaped"; reason: string }>;
// biome-ignore format: compact event alias keeps this file under the brief line cap.
export type BuildLaneFailedEvent = BuildLaneRef &
  Readonly<{ exitCode: number; kind: "build.lane.failed" }>;
export type BuildLaneEmptyEvent = BuildLaneRef & Readonly<{ kind: "build.lane.empty" }>;
// biome-ignore format: compact event alias keeps this file under the brief line cap.
export type BuildCardEvent = BuildLaneRef &
  Readonly<{
    kind: "build.card";
    laneStatus: BuildLaneStatus;
    mergeable: boolean;
    onTask: "unverified";
    // gemini `.md` lane card payload (Tasks 4/5 populate; optional so existing code lanes omit them):
    // the exported `.zer0/` artifact PATH on a gate-PASS, the violating-entry string on policy-reject.
    artifactPath?: string | undefined;
    policyViolation?: string | undefined;
  }>;
// Operator-review outcome (T4): emitted by build-review when the operator accepts/rejects/acks a
// lane, so the trace records WHO decided WHAT. `detail` carries the conflict/refusal reason.
// biome-ignore format: compact event alias keeps this file under the brief line cap.
export type BuildReviewedEvent = BuildLaneRef &
  Readonly<{ action: BuildReviewAction; detail?: string | undefined; kind: "build.reviewed" }>;
/**
 * Feature 2 (LIVE per-agent usage): one event per agent status CHANGE — the auth glyph and/or the
 * subscription usage WINDOW — so the cockpit's top status bar goes LIVE (today it is a static boot-probe
 * prop). All three agents are flat subscriptions whose included-usage window fills and RESETS, so the
 * signal is the window status, not a per-use balance. `auth`/`usage` are BOTH optional: the bus emits
 * each half from its own source (codex usage from its per-turn rate_limits; auth from the --version
 * probe), and the cockpit reducer MERGES — a usage-only update keeps the prior auth, and vice-versa.
 *
 * PRIMITIVES ONLY (layer direction: tui→chat, never reverse): the nested usage shape is declared inline
 * here (label/exhausted/resets), structurally identical to the tui AgentUsage the status bar renders —
 * events.ts MUST NOT import from src/tui. `label`/`resets` are pre-formatted at the capture site (codex
 * numbers → labels), so they are tower-trusted strings. LOCKSTEP with AgentStatusUpdateSchema — every
 * field (including the nested usage fields) MUST appear there or the non-strict bus parse drops it.
 */
// biome-ignore format: compact event alias keeps this file under the brief line cap.
export type AgentStatusUpdateEvent = Readonly<{
  kind: "agent.status";
  agent: AgentName;
  auth?: "ready" | "limited" | "down" | undefined;
  usage?:
    | {
        readonly label: string;
        readonly exhausted: boolean;
        readonly resets?: string | undefined;
        readonly contextUsedPct?: number | undefined;
        readonly fiveHourUsedPct?: number | undefined;
        readonly fiveHourResetsAtMs?: number | undefined;
        readonly weeklyUsedPct?: number | undefined;
        readonly weeklyResetsAtMs?: number | undefined;
      }
    | undefined;
  // F1 (FIX-3): the lane's DISPATCH-REALITY availability — derived from real dispatch outcomes, NOT the
  // usage probe (which said "98% fine" while dispatches died). `state` is the durable lane-availability
  // machine's state; `reason` is zer0 words (never the raw child-CLI remediation); `resetsAtMs` the
  // window's plausible reset when known. Optional + LOCKSTEP with AgentStatusUpdateSchema.
  availability?:
    | {
        readonly state: "ready" | "exhausted" | "needs_auth" | "local_blocked" | "retrying";
        readonly reason?: string | undefined;
        readonly resetsAtMs?: number | undefined;
      }
    | undefined;
}>;
// biome-ignore format: compact event alias keeps this file under the brief line cap.
export type UsagePayloadEvent = Readonly<{
  kind: "usage.payload";
  agent: AgentName;
  turn: number;
  source: string;
  outcome: "arrived" | "missing" | "stale" | "malformed" | "write-failed" | "deduped" | "timed-out" | "no-limits" | "failed";
  fields: readonly string[];
  droppedCount?: number | undefined;
  sample?: unknown;
}>;
// U2e-c INV-EF8/EF9 observability: one event per <Static> feed advance — phase "advance" names the appended
// item keys (INV-EF8); "violation" records a prefix break (impossible in prod — the corrupted-input guard);
// "notice-suppressed" records a sealed-turn notice (INV-EF9). Emitted debug-gated at feed-trace.ts. `turn` is
// the last-affected turn number (0 for a violation). LOCKSTEP with TuiFeedSchema (event-schemas.ts).
// biome-ignore format: compact event alias keeps this file under the brief line cap.
export type TuiFeedEvent = Readonly<{
  kind: "tui.feed";
  turn: number;
  phase: "advance" | "violation" | "notice-suppressed";
  keys: readonly string[];
  detail?: string | undefined;
}>;
// MEMORY-FULL observability (O1): the ONE memory event kind, phase-discriminated (mirrors tui.feed). Under
// ZER0_DEBUG the memory turn-path (later tasks) emits one per attributable memory moment — the v15 lazy
// migration (MT1), then per-turn briefing/digest/read-proof/compaction/conflict. `turn` attributes it to a
// turn (0 for open-time events like the migration); `detail` carries the specifics (session id, hash+bytes,
// why). LOCKSTEP with MemoryTraceSchema (event-schemas.ts) — every field appears there or the bus drops it.
export { MEMORY_TRACE_PHASES };
export type MemoryTracePhase = (typeof MEMORY_TRACE_PHASES)[number];
export type MemoryTraceEvent = Readonly<{
  kind: "memory.trace";
  phase: MemoryTracePhase;
  turn: number;
  detail?: string | undefined;
}>;
/**
 * ONE non-fatal condition the room should announce, raised where it is CLASSIFIED (the carrier knows
 * which call site broke) and consumed by the room host, which owns the dedup and the wire.
 *
 * It rides the bus rather than a return value on purpose. A briefing failure happens while the prompt
 * is being composed, and threading it back out through the result unions would lose it on every path
 * where the turn later fails for an unrelated reason. The classification is ALSO returned on
 * CarrierTurnResult for the caller that wants it; the bus is how it reaches the room.
 */
export type RoomNoticeEvent = Readonly<{
  kind: "room.notice";
  cause: RoomNoticeCause;
  turn: number;
  agent?: AgentName | undefined;
  detail: string;
}>;
export type ChatEvent =
  | AgentOutputEvent
  | RoomNoticeEvent
  | AgentStatusUpdateEvent
  | TuiFeedEvent
  | UsagePayloadEvent
  | MemoryTraceEvent
  | BuildCardEvent
  | BuildReviewedEvent
  | BuildLaneCapturedEvent
  | BuildLaneCreatedEvent
  | BuildLaneDispatchedEvent
  | BuildLaneEmptyEvent
  | BuildLaneEscapedEvent
  | BuildLaneFailedEvent
  | BuildRunStartedEvent
  | CouncilAgentDoneEvent
  | CouncilCompleteEvent
  | CouncilStartedEvent
  | DebateAgentResultEvent
  | DebateRoundCompleteEvent
  | DebateRoundStartEvent
  | DiffReadyEvent
  | DispatchCompletedEvent
  | DispatchFailedEvent
  | DispatchStartedEvent
  | LaneQueuedEvent
  | ModeSessionEvent
  | PermissionAskEvent
  | RouteClassifiedEvent
  | RouteDecisionEvent
  | RoutePickEvent
  | RouteResolvedEvent
  | SessionSavedEvent
  | UndoResultEvent
  | UserMessageEvent;
export type ChatEventKind = ChatEvent["kind"];
export type ChatEventHandler<K extends ChatEventKind> = (
  event: Extract<ChatEvent, { readonly kind: K }>,
) => void;

// The Zod runtime schemas live in ./event-schemas.ts (split to keep this file under the line
// cap). It is already typed to the TS ChatEvent union, so this is a plain re-export and the
// public ChatEventSchema export contract is unchanged.
export const ChatEventSchema: z.ZodType<ChatEvent, z.ZodTypeDef, unknown> = ChatEventSchemaRaw;

export class ChatEventBus {
  private readonly handlers: Map<ChatEventKind, Set<(event: ChatEvent) => void>> = new Map();

  public emit(event: ChatEvent): void {
    const parsed = ChatEventSchema.parse(event);
    const handlers = this.handlers.get(parsed.kind);
    if (handlers === undefined) return;
    for (const handler of handlers) {
      try {
        handler(parsed);
      } catch {
        // Handler isolation: one throwing handler must not abort others
      }
    }
  }

  public on<K extends ChatEventKind>(kind: K, handler: ChatEventHandler<K>): void {
    const handlers = this.handlers.get(kind) ?? new Set<(event: ChatEvent) => void>();
    handlers.add(handler as (event: ChatEvent) => void);
    this.handlers.set(kind, handlers);
  }

  public off<K extends ChatEventKind>(kind: K, handler: ChatEventHandler<K>): void {
    this.handlers.get(kind)?.delete(handler as (event: ChatEvent) => void);
  }
}
