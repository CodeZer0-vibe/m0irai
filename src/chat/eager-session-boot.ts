/**
 * @file src/chat/eager-session-boot.ts
 * @purpose W4-R REFIT R1: opens claude/codex's persistent ACP lane sessions in the BACKGROUND at
 *   startup, through the same acquireLaneSession the first real turn uses. Boot publishes name and
 *   mode, and no numbers.
 * @exports EagerAgentOutcome, EagerBootResult, startEagerSessionBoot, codexLoginStateFrom
 * @depends ../adapters/acp/acp-servers, ../evidence/db, ./events, ./lane-acquire, ./lane-carrier,
 *   ./lane-availability, ./lane-transport
 *
 * BOOT PUBLISHES NO METERS, for any agent (operator's locked display policy). Two things used to put
 * numbers on the first screen and both are gone: prefetchCodexQuota, which read the newest rollout
 * before a turn existed, and bootUsageTap, which wired a turn-0 usage reporter into the ACP transport
 * so any usage_update the bridge volunteered during readiness reached agent.status. What boot reports
 * now is name and mode. Numbers arrive after the operator's first message, from the per-turn reporter
 * headless-carrier.ts already installs.
 *
 * gemini has no persistent session by vendor design, so its leg opens nothing and reports ready
 * immediately (operator ruling 2026-07-27: default is fine; only a real failed SEND earns "offline" —
 * see eagerProbeGemini's own note).
 */
import { resolveAcpSpec } from "../adapters/acp/acp-servers.js";
import type { Db } from "../evidence/db.js";
import type { ChatEventBus } from "./events.js";
import {
  type ActiveSessionResult,
  LaneAcquireSupersededError,
  acquireLaneSession,
} from "./lane-acquire.js";
import { type LaneFailureClass, classifyLaneFailure } from "./lane-availability.js";
import type { LaneModeApplyOutcome } from "./lane-carrier.js";
import { carrierRuntime, getOrCreateLaneTransport } from "./lane-transport.js";

type EagerAcpAgent = "claude" | "codex";

/** D-0/R1's honest first-class outcome — never conflated with "connecting" (that state is purely the
 *  Mount-seed default BEFORE either of these resolves; a settled EagerAgentOutcome always ends up as
 *  one of these two, never a third "still connecting" value). modeApplied carries the FULL applied/
 *  failed distinction (not just a bare modeId) so a consumer (use-cockpit-bus.ts's catchup hook) can
 *  dispatch mode-active vs mode-failed correctly — mirroring what useNativeModeBus already does from
 *  the (racy) bus path; a session that opened but whose mode-apply failed is still outcome:"ready"
 *  (the SESSION is usable) with modeApplied.outcome:"failed" (the SPECIFIC setMode call was not). */
export type EagerAgentOutcome =
  | {
      readonly outcome: "ready";
      readonly modeApplied?: LaneModeApplyOutcome;
      readonly availableModeIds?: readonly string[];
    }
  | {
      readonly outcome: "unavailable";
      readonly reason: string;
      /** Slice A: the DEATH CLASS behind the failure, when the error text carries one. A logged-out
       *  codex rejects the eager open with the SDK's own "Authentication required", which
       *  classifyLaneFailure already recognises — so the room learns codex is signed out at boot for
       *  the cost of an open it was doing anyway. Absent for an ordinary transport failure, which is
       *  NOT evidence about auth. */
      readonly cause?: LaneFailureClass;
    };

export interface EagerBootResult {
  readonly claude: Promise<EagerAgentOutcome>;
  readonly codex: Promise<EagerAgentOutcome>;
  readonly gemini: Promise<EagerAgentOutcome>;
}

export interface StartEagerSessionBootInput {
  readonly db: Db;
  /** Absent when carrier is off or the folder is unscoped (resolveSessionBoundary's own scope read,
   *  reused here rather than re-resolving) — claude/codex both skip the open in that case and report
   *  READY, the SAME outcome the lanesEnabled gate below produces for a windowed/conflict boot. Not
   *  "unavailable": nothing was attempted, so nothing failed. */
  readonly projectId?: string;
  /** Native provider state scope; V2 supplies its outer chat session id. */
  readonly laneScopeId?: string;
  readonly repoRoot: string;
  readonly cwd: string;
  readonly bus: ChatEventBus;
  /**
   * Room shutdown aborts persistence from any handshake that settles after its transport was closed.
   * FL-150: REQUIRED, following AcquireLaneSessionInput.signal down the chain it feeds. The one
   * production caller (room-eager-sessions.ts's `start(bus, signal)`) has always passed a real one; the
   * optionality only ever served tests, and "a test may omit the cancel" is precisely the shape that let
   * the ACP room path ship with no cancel at all.
   */
  readonly signal: AbortSignal;
  /** New V2 conversations open new native Claude/Codex sessions; resumed conversations retain them. */
  readonly forceFresh?: boolean;
}

/**
 * Kicks off all 3 engines' eager boot-time readiness checks in the BACKGROUND — this function itself
 * does no I/O and returns immediately; it only STARTS each agent's own I/O (never awaited here, by
 * design — the caller, chat-tui-mount.ts, must never block Mount construction on any of these). Each
 * leg emits agent.status (+ mode.session for claude/codex — the SAME wire events the per-turn path
 * already emits, turn:0 as the boot sentinel) on settling, for debug-trace/observability parity ONLY —
 * ChatEventBus.emit has zero buffering, so a subscriber that attaches after settlement would miss a
 * bus-only signal. The returned Promises are the mechanism UI correctness depends on: chat-tui-mount.ts
 * exposes them on Mount, and use-cockpit-bus.ts's eager-boot hook `.then()`s off them inside a
 * useEffect — a settled Promise replays to a late `.then()` by construction, unlike the bus.
 */
export function startEagerSessionBoot(input: StartEagerSessionBootInput): EagerBootResult {
  const result = {
    claude: eagerOpenAcpAgent(input, "claude"),
    codex: eagerOpenAcpAgent(input, "codex"),
    gemini: eagerProbeGemini(input),
  };
  return result;
}

/**
 * Mirrors headless-turn.ts's usesCarrier gate exactly (carrierRuntime()?.lanesEnabled === true): the
 * first REAL turn would ALSO be unable to use this lane machinery when carrier is off or lanesEnabled
 * is false (a windowed/conflict boot, I-14) — eager-open must never attempt what the per-turn path
 * itself could not, and must never throw either way. input.projectId undefined is the SAME "no scoped
 * carrier this boot" case, folded into one check.
 *
 * READY, NOT UNAVAILABLE (operator ruling 2026-07-27). That branch used to return "unavailable —
 * carrier lanes are not active this boot", which applyEagerOutcome paints as auth:"down" and the bar
 * words as "offline". That is a statement about ZER0'S OWN CONFIGURATION, not about the agent: nothing
 * was attempted, so nothing failed, and claude is very likely perfectly fine. Same over-claim as the
 * version probe one function down, one branch up. Default is fine; only a real failed attempt earns
 * "offline".
 */
async function eagerOpenAcpAgent(
  input: StartEagerSessionBootInput,
  agent: EagerAcpAgent,
): Promise<EagerAgentOutcome> {
  if (carrierRuntime()?.lanesEnabled !== true || input.projectId === undefined) {
    emitEagerReady(input.bus, agent, undefined);
    return { outcome: "ready" };
  }
  try {
    const transport = getOrCreateLaneTransport(agent);
    const binding = { ...resolveAcpSpec(agent).binding, cwd: input.cwd };
    const active = await acquireLaneSession({
      agent,
      turn: 0, // boot sentinel — no real turn has happened yet (mirrors sessionBoundarySeq's own "0 = dormant" convention)
      binding,
      db: input.db,
      projectId: input.projectId,
      ...(input.laneScopeId === undefined ? {} : { laneScopeId: input.laneScopeId }),
      transport,
      trace: input.bus,
      signal: input.signal,
      ...(input.forceFresh === true ? { forceFresh: true } : {}),
    });
    emitEagerReady(input.bus, agent, active);
    return readyOutcome(active);
  } catch (error) {
    // W4-R2c C4: SUPERSEDED IS NOT A FAILURE, and treating it as one would ship a fresh lie in place
    // of the one this wave just closed. A foreground turn stopped waiting for this boot-time open and
    // took the lane over — so at the exact moment this lands, that lane is ACTIVELY SERVING the
    // operator. Emitting auth:"down" here would paint `offline` on a chip whose agent is answering,
    // which is precisely the red-cross-on-a-working-lane defect FIX-4 and ruling 3 spent two rounds
    // killing. Nothing failed; ownership moved.
    if (error instanceof LaneAcquireSupersededError) {
      emitEagerReady(input.bus, agent, undefined);
      return { outcome: "ready" };
    }
    return reportEagerFailure(input.bus, agent, errorReason(error));
  }
}

/**
 * Slice A: a boot failure is CLASSIFIED before it is reported.
 *
 * A logged-out codex rejects the eager open with the SDK's own "Authentication required", and the room
 * used to paint that as OFFLINE — a true statement about the connection and a misleading one about the
 * account, since the fix is a sign-in and not a restart. `classifyLaneFailure` has owned this
 * vocabulary for months (lane-availability.ts:62-70); nothing called it from the boot path, and that
 * wiring gap was the whole defect.
 *
 * An UNCLASSIFIED failure keeps the old bare `auth:"down"`, deliberately: a transport error says
 * nothing about whether the account is signed in, and mapping every failure to needs_auth would tell an
 * operator with a broken socket to sign in again.
 */
function reportEagerFailure(
  bus: ChatEventBus,
  agent: EagerAcpAgent,
  reason: string,
): EagerAgentOutcome {
  const classified = classifyLaneFailure(reason);
  if (classified === undefined) {
    emitEagerDown(bus, agent);
    return { outcome: "unavailable", reason };
  }
  // The wire already carries this state — availability.state ∈ {…, needs_auth, …} is in the schema and
  // the reducer already decodes it. Publishing the class rather than a bare auth:"down" is what lets
  // the chip say something the operator can act on.
  emitEagerAvailability(bus, agent, classified.class);
  return { outcome: "unavailable", reason, cause: classified.class };
}

/**
 * gemini's boot leg — and it opens NOTHING, by vendor design (per-turn process, no persistent session).
 *
 * OPERATOR RULING (2026-07-27): "how about we just say it's online, and if we send a message and it
 * doesn't go through we say offline, and that's it." This used to `await probeAgentAuth("gemini")` and
 * emit auth:"down" when that `--version` probe failed OR TIMED OUT, which the bar words as "offline".
 * The operator watched `◇ gemini offline` and then gemini answered them normally — agy is documented as
 * slow to start (their trace: 16.6s to first answer, which is normal for it), so a probe timeout is a
 * true statement about OUR INSTRUMENT and says nothing about the agent. We knew the probe failed; we
 * rendered the much stronger claim that the agent was unreachable.
 *
 * So there is no probe here at all now. There is nothing being opened for gemini, so there is no honest
 * boot state other than "fine": it shows its normal appearance immediately, and the FIRST REAL SEND is
 * what decides otherwise — a failed dispatch marks it offline with the real reason (lane-gate.ts), and
 * W4-R2a's recovery clears that on the next success. Also removes an ~6-8s awaited spawn from boot,
 * which the agy operating truths say must never gate anything operator-visible.
 *
 * THE ACCEPTED TRADE-OFF (operator's, stated): a genuinely missing or unauthenticated gemini now reads
 * as fine until the operator's first message fails. That is deliberate — the failure then arrives fast
 * and in plain words, and `/doctor` + `zer0 init` remain the surfaces for "is my setup right?".
 */
function eagerProbeGemini(input: StartEagerSessionBootInput): Promise<EagerAgentOutcome> {
  emitEagerReady(input.bus, "gemini", undefined);
  return Promise.resolve({ outcome: "ready" });
}

function readyOutcome(active: ActiveSessionResult): EagerAgentOutcome {
  return {
    outcome: "ready",
    ...(active.modeApplied !== undefined ? { modeApplied: active.modeApplied } : {}),
    ...(active.availableModeIds !== undefined ? { availableModeIds: active.availableModeIds } : {}),
  };
}

// D-0-style discipline (agy-mode-probe.ts's own precedent): auth is the ONLY value on the wire —
// event-schemas.ts's AgentStatusUpdateSchema.auth enum is ready|limited|down, never "connecting"; a
// reason string has NO field on this schema either (Zod strips an unknown key silently rather than
// throwing, but the reason would simply vanish) — the PRIMARY delivery of "unavailable — reason" is
// the returned Promise itself (use-cockpit-bus.ts's hook dispatches DIRECTLY to the reducer, which
// DOES support a diagnostic reason, bypassing the wire schema entirely). This emit is belt-and-
// suspenders for the debug trace sink only.
function emitEagerReady(
  bus: ChatEventBus,
  agent: "claude" | "codex" | "gemini",
  active: ActiveSessionResult | undefined,
): void {
  bus.emit({ kind: "agent.status", agent, auth: "ready" });
  if (agent === "gemini" || active?.modeApplied === undefined) return;
  bus.emit({
    kind: "mode.session",
    agent,
    turn: 0,
    outcome: active.modeApplied.outcome,
    modeId: active.modeApplied.modeId,
    ...(active.modeApplied.outcome === "failed" ? { reason: active.modeApplied.reason } : {}),
    ...(active.availableModeIds !== undefined ? { availableModeIds: active.availableModeIds } : {}),
  });
}

function emitEagerDown(bus: ChatEventBus, agent: "claude" | "codex" | "gemini"): void {
  bus.emit({ kind: "agent.status", agent, auth: "down" });
}

/** Publishes a CLASSIFIED boot failure on the availability channel the wire already carries, instead of
 *  the blunt auth:"down". `auth` rides along so a spent or signed-out lane is still not treated as
 *  reachable — the two fields answer different questions and the reducer merges them independently. */
function emitEagerAvailability(
  bus: ChatEventBus,
  agent: "claude" | "codex" | "gemini",
  state: LaneFailureClass,
): void {
  bus.emit({
    kind: "agent.status",
    agent,
    auth: state === "exhausted" ? "limited" : "down",
    availability: { state },
  });
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Slice A: reads codex's login state OUT of the eager open's own outcome, so the readiness probe spawns
 * nothing for codex. "no" only for a real `needs_auth` classification; every other failure is
 * "unknown", because a transport error says nothing about whether the account is signed in and
 * "unknown" renders exactly as ready.
 */
export function codexLoginStateFrom(outcome: EagerAgentOutcome): "yes" | "no" | "unknown" {
  if (outcome.outcome === "ready") return "unknown";
  return outcome.cause === "needs_auth" ? "no" : "unknown";
}
