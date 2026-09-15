// @size-justified: single source of runtime truth for every ChatEvent kind's Zod schema — every
// LOCKSTEP comment in events.ts points back here, so splitting would break the one-file-to-verify
// convention the whole event bus relies on. Under the 600-line hard gate (409 lines).
/**
 * @file src/chat/event-schemas.ts
 * @purpose Zod runtime schemas for every ChatEvent variant + the ChatEventSchema discriminated
 *   union the bus parses on emit. Split from events.ts so the type layer + bus stay under the
 *   line cap; the union here is the single source of runtime truth for event field survival.
 * @exports ChatEventSchema, MemoryTracePhaseSchema, MEMORY_TRACE_PHASES
 * @depends zod, ../shared/room-notice, ./types
 */
import { z } from "zod";
import { MAX_ROOM_NOTICE_DETAIL_CODE_POINTS, ROOM_NOTICE_CAUSES } from "../shared/room-notice.js";
import type { ChatEvent } from "./events.js";
import type { AgentName, ChatIntent, ChatMode, ChatRoute } from "./types.js";
import { ChatWorkingSetOutcomeSchema } from "./types.js";

const CHAT_MODES: readonly [ChatMode, ...ChatMode[]] = [
  "single",
  "all",
  "debate",
  "research",
  "build",
];

type ChatRouteInput = Omit<ChatRoute, "slashCommand"> & {
  readonly slashCommand?: string | undefined;
};

const AgentNameSchema: z.ZodType<AgentName> = z.enum(["claude", "codex", "gemini"]);
const AgentsSchema: z.ZodType<readonly AgentName[]> = z.array(AgentNameSchema);
const ChatIntentSchema: z.ZodType<ChatIntent> = z.enum([
  "audit",
  "build",
  "create",
  "fix",
  "general",
  "opinion",
  "plan",
  "research",
  "review",
]);
const ChatRouteBaseSchema = z
  .object({
    agents: AgentsSchema,
    codexSandbox: z.enum(["read-only", "workspace-write"]),
    dispatchMode: z.enum(["text-only", "tools", "pipeline"]),
    geminiMode: z.literal("review"),
    intent: ChatIntentSchema,
    kind: z.enum(["agent", "all", "slash", "local"]),
    slashCommand: z.string().optional(),
  })
  .strict();
const ChatRouteSchema: z.ZodType<ChatRoute, z.ZodTypeDef, ChatRouteInput> =
  ChatRouteBaseSchema.transform(toChatRoute);
export const MEMORY_TRACE_PHASES: [
  "migrated",
  "journal",
  "briefing",
  "digest",
  "read-proof",
  "compaction",
  "conflict",
  "resume.attempted",
  "resume.ok",
  "resume.fallback",
  "compaction.detected",
  "compaction.inferred",
  "briefing.injected",
  "delta.injected",
  "delta.duplicate",
  "delta.maybeDuplicate",
  "delta.overflow",
  "cursor.commitFailed",
  "close.orphan",
  "lane.lockConflict",
  "boundary.framed",
] = [
  "migrated",
  "journal",
  "briefing",
  "digest",
  "read-proof",
  "compaction",
  "conflict",
  "resume.attempted",
  "resume.ok",
  "resume.fallback",
  "compaction.detected",
  "compaction.inferred",
  "briefing.injected",
  "delta.injected",
  "delta.duplicate",
  "delta.maybeDuplicate",
  "delta.overflow",
  "cursor.commitFailed",
  "close.orphan",
  "lane.lockConflict",
  // THE BOUNDARY WAVE (B7): emitted whenever a composed prompt actually reclassified >=1
  // prior-session entry as untrusted — carrier lanes (delta-composer.ts via lane-carrier.ts) and the
  // composePrompt recent-window (headless-turn.ts) both share this ONE phase.
  "boundary.framed",
] as const;
export const MemoryTracePhaseSchema: z.ZodEnum<typeof MEMORY_TRACE_PHASES> =
  z.enum(MEMORY_TRACE_PHASES);

const BaseTurnSchema = { agent: AgentNameSchema, turn: z.number().int().nonnegative() } as const;

const AgentStderrSchema = z.object({
  ...BaseTurnSchema,
  chunk: z.string(),
  kind: z.literal("agent.stderr"),
});
const AgentStdoutSchema = z.object({
  ...BaseTurnSchema,
  chunk: z.string(),
  kind: z.literal("agent.stdout"),
});
const CouncilAgentDoneSchema = z.object({
  ...BaseTurnSchema,
  kind: z.literal("council.agent.done"),
  status: z.enum(["done", "failed"]),
});
const CouncilCompleteSchema = z.object({
  kind: z.literal("council.complete"),
  turn: z.number().int().nonnegative(),
});
const CouncilStartedSchema = z.object({
  agents: AgentsSchema,
  kind: z.literal("council.started"),
  turn: z.number().int().nonnegative(),
});
const DiffReadySchema = z.object({
  ...BaseTurnSchema,
  diffStat: z.string(),
  filesChanged: z.array(z.string()),
  kind: z.literal("diff.ready"),
});
// TDECIDE wave-7: LOCKSTEP with UndoResultEvent (events.ts) — text is fully tower-composed, no agent
// bytes, so a plain non-empty string suffices (no separate untrusted-content field to guard).
const UndoResultSchema = z.object({
  kind: z.literal("undo.result"),
  text: z.string().min(1),
  turn: z.number().int().nonnegative(),
});
const DispatchCompletedSchema = z.object({
  ...BaseTurnSchema,
  durationMs: z.number().int().nonnegative(),
  exitCode: z.number().int(),
  kind: z.literal("dispatch.completed"),
  outputPath: z.string(),
});
const DispatchFailedSchema = z.object({
  ...BaseTurnSchema,
  durationMs: z.number().int().nonnegative().optional(),
  error: z.string(),
  exitCode: z.number().int(),
  kind: z.literal("dispatch.failed"),
  scope: z.enum(["lane", "turn"]),
  state: z.enum(["failed", "timed_out", "cancelled"]),
});
const DispatchStartedSchema = z.object({
  ...BaseTurnSchema,
  kind: z.literal("dispatch.started"),
  mode: z.enum(["text", "tools", "pipeline"]),
});
// T-L11 (I-7). LOCKSTEP with LaneQueuedEvent (events.ts): emit() runs ChatEventSchema.parse and a kind
// absent from the union THROWS at emit. `text` is a tower-owned plain-words constant (no agent bytes),
// mirroring UndoResultSchema's own non-empty-string convention.
const LaneQueuedSchema = z.object({
  ...BaseTurnSchema,
  kind: z.literal("lane.queued"),
  text: z.string().min(1),
});
const DebateRoundBaseSchema = {
  label: z.string().min(1),
  round: z.number().int().positive(),
  turn: z.number().int().nonnegative(),
} as const;
const DebateRoundStartSchema = z.object({
  ...DebateRoundBaseSchema,
  kind: z.literal("debate.round-start"),
});
const DebateAgentResultSchema = z.object({
  agent: AgentNameSchema,
  kind: z.literal("debate.agent-result"),
  outcome: ChatWorkingSetOutcomeSchema,
  round: z.number().int().positive(),
  summary: z.string().min(1).optional(),
  turn: z.number().int().nonnegative(),
});
const DebateRoundCompleteSchema = z.object({
  ...DebateRoundBaseSchema,
  kind: z.literal("debate.round-complete"),
});
const RouteResolvedSchema = z.object({
  agents: AgentsSchema,
  intent: ChatIntentSchema,
  kind: z.literal("route.resolved"),
  route: ChatRouteSchema,
  turn: z.number().int().nonnegative(),
});
// LOCKSTEP with RouteClassifiedEvent (events.ts): emit() runs ChatEventSchema.parse, and z.object
// is not .strict(), so a field present on the TS type but ABSENT here is silently dropped at
// runtime. Every field of RouteClassifiedEvent MUST appear below or AC-5 (reason survives parse)
// fails. A falsifying test in events.test.ts asserts the reason field survives this parse.
// VESTIGE SWEEP S8 (2026-07-17): requiresConfirm REMOVED (the deleted confirm-card apparatus).
// Backward-compat: this z.object is NOT .strict() (default zod strip mode), so an OLD persisted
// route.classified line still carrying requiresConfirm still parses — the field is silently
// stripped, never rejected. events.test.ts asserts this old-transcript-replay compat directly.
const RouteClassifiedSchema = z.object({
  kind: z.literal("route.classified"),
  mode: z.enum(CHAT_MODES),
  reason: z.string().min(1),
  turn: z.number().int().nonnegative(),
});
// LOCKSTEP with RouteDecisionEvent (events.ts): emit() runs ChatEventSchema.parse and z.object is NOT
// .strict(), so a field present on the TS type but ABSENT here is silently dropped at runtime — which
// would erase the verdict/reason the trace exists to show. Every RouteDecisionEvent field appears here
// or the transparency event loses it. A falsifying test in events.test.ts asserts the fields survive.
const RouteDecisionSchema = z.object({
  agents: AgentsSchema.optional(),
  kind: z.literal("route.decision"),
  laneCount: z.number().int().nonnegative().optional(),
  reason: z.string().min(1),
  turn: z.number().int().nonnegative(),
  verdict: z.enum([
    "isolated-build",
    "reject-gemini",
    "reject-all",
    "passthrough",
    "gemini-research",
  ]),
});
const SessionSavedSchema = z.object({
  kind: z.literal("session.saved"),
  runDir: z.string().min(1),
  sessionId: z.string().min(1),
});
// LOCKSTEP with RoutePickEvent (events.ts): emit() runs ChatEventSchema.parse and a kind absent from
// the discriminated union below THROWS at emit. The cockpit's smart pick line is the only payload —
// `text` is the tower-owned mode string the operator sees as a SYSTEM transcript notice (AC-1..5).
const RoutePickSchema = z.object({
  kind: z.literal("route.pick"),
  text: z.string().min(1),
  turn: z.number().int().nonnegative(),
});

// BUILD-pillar lane-lifecycle + card schemas. LOCKSTEP with the TS aliases in events.ts: z.object is
// NOT .strict(), so any field present on the TS type but ABSENT here is silently dropped by the bus.
// build.card MUST list lane_status/mergeable/on_task or the operator's card loses them (RG-1). A
// falsifying test in events.test.ts asserts those three fields survive ChatEventSchema.parse.
const BuildLaneStatusSchema = z.enum(["captured", "failed", "empty", "escaped", "policy-rejected"]);
const BuildLaneBaseSchema = {
  agent: AgentNameSchema,
  runId: z.string().min(1),
  turn: z.number().int().nonnegative(),
} as const;
const BuildRunStartedSchema = z.object({
  agents: AgentsSchema,
  kind: z.literal("build.run.started"),
  runId: z.string().min(1),
  turn: z.number().int().nonnegative(),
});
const BuildLaneCreatedSchema = z.object({
  ...BuildLaneBaseSchema,
  kind: z.literal("build.lane.created"),
  worktreePath: z.string().min(1),
});
const BuildLaneDispatchedSchema = z.object({
  ...BuildLaneBaseSchema,
  kind: z.literal("build.lane.dispatched"),
});
const BuildLaneCapturedSchema = z.object({
  ...BuildLaneBaseSchema,
  changedFiles: z.array(z.string()),
  kind: z.literal("build.lane.captured"),
  laneStatus: BuildLaneStatusSchema,
});
const BuildLaneEscapedSchema = z.object({
  ...BuildLaneBaseSchema,
  kind: z.literal("build.lane.escaped"),
  reason: z.string().min(1),
});
const BuildLaneFailedSchema = z.object({
  ...BuildLaneBaseSchema,
  exitCode: z.number().int(),
  kind: z.literal("build.lane.failed"),
});
const BuildLaneEmptySchema = z.object({
  ...BuildLaneBaseSchema,
  kind: z.literal("build.lane.empty"),
});
const BuildCardSchema = z.object({
  ...BuildLaneBaseSchema,
  // artifactPath (export PATH on a gate-PASS) + policyViolation (violating entry on policy-reject)
  // are OPTIONAL — LOCKSTEP with BuildCardEvent (events.ts); listed here or the bus drops them.
  artifactPath: z.string().min(1).optional(),
  kind: z.literal("build.card"),
  laneStatus: BuildLaneStatusSchema,
  mergeable: z.boolean(),
  onTask: z.literal("unverified"),
  policyViolation: z.string().min(1).optional(),
});
// LOCKSTEP with BuildReviewedEvent (events.ts). z.object is NOT .strict(), so `action`/`detail`
// MUST be listed here or the bus silently drops them — a falsifying test in events.test.ts asserts
// `action` survives ChatEventSchema.parse for a `build.reviewed` event.
const BuildReviewedSchema = z.object({
  ...BuildLaneBaseSchema,
  action: z.enum(["accepted", "conflict", "rejected", "acknowledged", "refused"]),
  detail: z.string().optional(),
  kind: z.literal("build.reviewed"),
});
const UserMessageSchema = z.object({
  kind: z.literal("user.message"),
  text: z.string(),
  timestamp: z.string().min(1),
  turn: z.number().int().nonnegative(),
});
// LOCKSTEP with AgentStatusUpdateEvent (events.ts): emit() runs ChatEventSchema.parse and z.object is
// NOT .strict(), so any field present on the TS type but ABSENT here is silently DROPPED on the bus —
// for the NESTED usage object that would erase the very USED-% windows the status bar renders. Every
// field (auth + the context/5h/weekly USED-% windows + their reset instants) appears below or the live
// update loses it. Falsifying tests in events.test.ts + event-schemas-usage.test.ts assert auth + the
// nested usage windows SURVIVE this parse. auth/usage/resets are optional (the bus emits each half from
// its own source; the cockpit reducer merges).
const AgentUsageSchema = z.object({
  label: z.string().min(1),
  exhausted: z.boolean(),
  resets: z.string().min(1).optional(),
  contextUsedPct: z.number().min(0).max(100).optional(),
  fiveHourUsedPct: z.number().min(0).max(100).optional(),
  fiveHourResetsAtMs: z.number().nonnegative().optional(),
  weeklyUsedPct: z.number().min(0).max(100).optional(),
  weeklyResetsAtMs: z.number().nonnegative().optional(),
});
// F1 (FIX-3) LOCKSTEP with AgentStatusUpdateEvent (events.ts): the dispatch-reality availability. Every
// field present on the TS type appears here or the non-strict bus parse silently DROPS it.
const LaneAvailabilitySchema = z.object({
  state: z.enum(["ready", "exhausted", "needs_auth", "local_blocked", "retrying"]),
  reason: z.string().min(1).optional(),
  resetsAtMs: z.number().nonnegative().optional(),
});
const AgentStatusUpdateSchema = z.object({
  kind: z.literal("agent.status"),
  agent: AgentNameSchema,
  auth: z.enum(["ready", "limited", "down"]).optional(),
  usage: AgentUsageSchema.optional(),
  availability: LaneAvailabilitySchema.optional(),
});
const UsagePayloadSchema = z.object({
  kind: z.literal("usage.payload"),
  agent: AgentNameSchema,
  turn: z.number().int().nonnegative(),
  source: z.string().min(1),
  // FL-099: the three ways claude's /usage race can end without windows. They are DISTINCT values on
  // purpose — "we gave up after 3s", "this account has no plan limits" and "the call threw" were
  // indistinguishable in every artifact before this, and an unlisted value is dropped by the parse
  // below rather than rejected, so adding the marker without adding it here produces silence.
  outcome: z.enum([
    "arrived",
    "missing",
    "stale",
    "malformed",
    "write-failed",
    "deduped",
    "timed-out",
    "no-limits",
    "failed",
  ]),
  fields: z.array(z.string()),
  droppedCount: z.number().int().positive().optional(),
  sample: z.unknown().optional(),
});
// LOCKSTEP with TuiFeedEvent (events.ts): the U2e-c feed-advance / violation / notice-suppressed trace.
// A kind absent from the discriminated union below THROWS at emit; every field appears here or the
// non-strict bus parse drops it. `keys` carries the appended item keys (advance) or []; `turn` is 0 on a
// violation. Emitted debug-gated (feed-trace.ts), so a normal run without ZER0_DEBUG never reaches here.
const TuiFeedSchema = z.object({
  kind: z.literal("tui.feed"),
  turn: z.number().int().nonnegative(),
  phase: z.enum(["advance", "violation", "notice-suppressed"]),
  keys: z.array(z.string()),
  detail: z.string().optional(),
});
// LOCKSTEP with MemoryTraceEvent (events.ts): the MEMORY-FULL observability event (O1). A kind absent from
// the discriminated union below THROWS at emit; every field appears here or the non-strict bus parse drops
// it. An unknown phase is rejected (z.enum), so a mistyped memory trace never enters the sink silently.
const MemoryTraceSchema = z.object({
  kind: z.literal("memory.trace"),
  phase: MemoryTracePhaseSchema,

  turn: z.number().int().nonnegative(),
  detail: z.string().optional(),
});
// LOCKSTEP with RoomNoticeEvent (events.ts). The cause is CLOSED here on purpose: this is the mint,
// and a host may only raise a condition it has a phrase for. The WIRE deliberately accepts an
// unrecognized cause so an older terminal can still draw a newer host's notice — see
// src/shared/room-notice.ts for why those two rules are not in conflict. `detail` is bounded to the
// same 200 code points the protocol validator enforces, so an oversized detail is refused HERE,
// before it reaches the room with nothing left to announce.
const RoomNoticeSchema = z.object({
  kind: z.literal("room.notice"),
  cause: z.enum(ROOM_NOTICE_CAUSES),
  turn: z.number().int().nonnegative(),
  agent: AgentNameSchema.optional(),
  detail: z
    .string()
    .min(1)
    .refine(
      (value) => [...value].length <= MAX_ROOM_NOTICE_DETAIL_CODE_POINTS,
      "room notice detail exceeds its code-point bound",
    ),
});
// LOCKSTEP with ModeSessionEvent (events.ts, MAX review fix round 1 B1/B2/B3): a kind absent from
// the discriminated union below THROWS at emit; every field appears here or the non-strict bus
// parse drops it.
const ModeSessionSchema = z.object({
  kind: z.literal("mode.session"),
  agent: AgentNameSchema,
  turn: z.number().int().nonnegative(),
  outcome: z.enum(["applied", "failed"]),
  modeId: z.string().min(1),
  reason: z.string().optional(),
  availableModeIds: z.array(z.string()).optional(),
});
// LOCKSTEP with PermissionAskEvent (events.ts, W4-3): no `turn` field — see that type's own comment.
// Provider IDs are opaque protocol tokens. They are never rendered; preserve their contents while
// bounding the same UTF-8 byte cost enforced by the Rust room consumer.
const PermissionIdSchema = utf8BoundedString(4096);
const PermissionAskSchema = z.object({
  kind: z.literal("permission.ask"),
  agent: AgentNameSchema,
  askId: PermissionIdSchema,
  phase: z.enum(["pending", "settled"]),
  toolTitle: utf8BoundedString(240).optional(),
  options: z
    .array(
      z.object({
        optionId: PermissionIdSchema,
        kind: utf8BoundedString(120).optional(),
        name: utf8BoundedString(120).optional(),
      }),
    )
    .max(9)
    .optional(),
  outcome: z.enum(["approved", "denied", "timeout", "invalidated"]).optional(),
  optionId: PermissionIdSchema.optional(),
});

function utf8BoundedString(maxBytes: number) {
  return z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value, "utf8") <= maxBytes, {
      message: `must be at most ${String(maxBytes)} UTF-8 bytes`,
    });
}

export const ChatEventSchema: z.ZodType<ChatEvent, z.ZodTypeDef, unknown> = z.discriminatedUnion(
  "kind",
  [
    AgentStatusUpdateSchema,
    AgentStderrSchema,
    AgentStdoutSchema,
    BuildCardSchema,
    BuildReviewedSchema,
    BuildLaneCapturedSchema,
    BuildLaneCreatedSchema,
    BuildLaneDispatchedSchema,
    BuildLaneEmptySchema,
    BuildLaneEscapedSchema,
    BuildLaneFailedSchema,
    BuildRunStartedSchema,
    CouncilAgentDoneSchema,
    CouncilCompleteSchema,
    CouncilStartedSchema,
    DebateAgentResultSchema,
    DebateRoundCompleteSchema,
    DebateRoundStartSchema,
    DiffReadySchema,
    DispatchCompletedSchema,
    DispatchFailedSchema,
    DispatchStartedSchema,
    LaneQueuedSchema,
    ModeSessionSchema,
    PermissionAskSchema,
    RouteClassifiedSchema,
    RouteDecisionSchema,
    RoutePickSchema,
    RouteResolvedSchema,
    SessionSavedSchema,
    RoomNoticeSchema,
    TuiFeedSchema,
    UsagePayloadSchema,
    MemoryTraceSchema,
    UndoResultSchema,
    UserMessageSchema,
  ],
);

function toChatRoute(value: ChatRouteInput): ChatRoute {
  const route: ChatRoute = {
    agents: value.agents,
    codexSandbox: value.codexSandbox,
    dispatchMode: value.dispatchMode,
    geminiMode: value.geminiMode,
    intent: value.intent,
    kind: value.kind,
  };
  return value.slashCommand === undefined ? route : { ...route, slashCommand: value.slashCommand };
}
