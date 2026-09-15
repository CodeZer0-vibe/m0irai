/**
 * @file src/chat/lane-gate.ts
 * @purpose F1 (FIX-3): the ONE pre-dispatch gate + outcome-recorder both lane paths share (no weaker twin).
 *   gateLaneOrBlock runs BEFORE emitStarted/transport — a dead lane's send is refused locally (no
 *   dispatch.started, no child burned) as a first-class visible skip; recordLaneDispatchResult marks a
 *   credit/auth death durably after a real dispatch (a success clears it). Field death: chat-1784553379589.
 * @exports LaneGateContext, gateLaneOrBlock, recordLaneDispatchResult, handleEscapedLaneError, emitAvailabilityStatus
 * @depends ./events, ./lane-availability, ./lane-availability-store, ./lane-transport, ./tower-bridge-lane, ./types
 *
 * FL-144: this module is ALSO where a chat lane's terminal gets SYNTHESIZED without ever reaching
 * finalizeLane — a gate block, an escaped throw — so every function here that builds a LaneOutcome reads the
 * cancel signal off LaneGateContext.signal, which is a REQUIRED field precisely so that a future
 * synthesizer cannot be written without it in scope. See the interface's own note for why that matters.
 */
import type { ChatEventBus } from "./events.js";
import {
  availableLaneNames,
  evaluateSend,
  getLaneAvailability,
  initLaneAvailabilityStore,
  noteLaneBlockedSend,
  noteLaneFailure,
  noteLaneRetry,
  noteLaneRetryFailed,
  noteLaneSuccess,
} from "./lane-availability-store.js";
import { type LaneAvailability, classifyLaneFailure } from "./lane-availability.js";
import { dropLaneHold } from "./lane-transport.js";
import type { LaneOutcome } from "./tower-bridge-lane.js";
import type { AgentName } from "./types.js";

const ALL_LANES: readonly AgentName[] = ["claude", "codex", "gemini"];

/** What the gate needs from the turn: the bus to render on, the project root (durable-store binding), the
 *  turn number, THE TURN'S ABORT SIGNAL, and an injectable clock for tests.
 *  FIX-3c BLOCK 2: `explicitRetry` REMOVED — production only ever built `{bus, repoRoot, turn}`, so the
 *  field advertised an operator override no operator could reach. Recovery does not depend on it (see
 *  evaluateSend); W4-R2 reintroduces it together with the retry command that actually supplies it.
 *
 * FL-144 — WHY `signal` IS A REQUIRED FIELD HERE RATHER THAN AN ARGUMENT ON ONE FUNCTION. This module is
 * where a chat lane's terminal gets SYNTHESIZED without ever reaching finalizeLane — a gate block, an
 * escaped throw — and four separate reviews have each found one more synthesis point that decided "was this
 * cancelled?" without consulting the signal. Carrying it on the CONTEXT is the part of the fix that is not
 * about the fourth instance: a future outcome-synthesizing function in this file has the signal in scope by
 * construction, and every construction site is enumerated by the compiler instead of by the next reviewer.
 * Deliberately not optional — an omitted `signal?` reads as "no cancel here", which is precisely the silent
 * default that produced seams two through four. */
export interface LaneGateContext {
  readonly bus: ChatEventBus;
  readonly repoRoot: string;
  readonly turn: number;
  readonly signal: AbortSignal;
  readonly nowMs?: number;
}

/** The lane's own words for a turn stopped BEFORE it was dispatched. Deliberately NOT reused from
 *  headless-carrier's "stopped before it finished", which describes a turn that was already running; the
 *  two states are different and neither may be guessed from the other. Names no cause: an abort is raised
 *  by an operator cancel, a room pause and a shutdown quiesce alike (room-engine.ts's cancelTarget / pause /
 *  quiesce), and naming only the first would be a guess printed as a fact. */
const GATE_CANCELLED_TEXT = "stopped before it started";

/**
 * The pre-dispatch gate. Returns a first-class SETTLED outcome — `cancelled` when the turn's signal is
 * already aborted (FL-144, below), else BLOCKED (with the notice + availability chip) when the lane is dead
 * and this send is not a sanctioned recovery; otherwise returns undefined (dispatch proceeds), recording a
 * retry intent when this send IS the recovery attempt. MUST be called BEFORE emitStarted and BEFORE any
 * transport call — a defined return means no dispatch.started fired and no child was spawned.
 * BLOCK 3 (FIX-3b): async because a SANCTIONED RETRY does real work before allowing the dispatch — it drops
 * the lane's held connection, so the recovery attempt cannot ride the session that died. Awaiting here (not
 * at some later call site) keeps this the ONE pre-dispatch gate: a future caller cannot forget the reconnect.
 *
 * FL-144, THE FOURTH CANCEL SEAM. This function runs OUTSIDE runOneLane's try (headless-turn.ts's
 * runOneLane), so handleEscapedLaneError — the fix that closed the third seam — is unreachable from here,
 * and everything below synthesized `state: "failed"` for a lane the operator had already stopped. The
 * window is real and not narrow: the room creates the lane's controller in pump() and only then awaits its
 * way down to this gate (room-engine.ts's pump -> run -> runLane), so a Ctrl+C, an Esc, a room pause or a
 * shutdown quiesce arriving in that stretch aborts a lane that has not reached a single line of dispatch.
 * The guard sits at the TOP rather than on the blocked branch on purpose — the finding names two roads in
 * ("a sanctioned-retry gate rejection takes the same road"), and a blocked-branch guard closes neither the
 * retry road nor the plain healthy-lane one, where the gate would otherwise allow the send and a child gets
 * spawned for a turn that was cancelled before it began. Same rule as the three seams already closed
 * (headless-carrier's markCarrierTerminal, {@link recordLaneDispatchResult}, {@link handleEscapedLaneError}):
 * the SIGNAL decides, never the shape or text of anything else. Nothing durable is written and no
 * availability chip is published, for the reason recordLaneDispatchResult's header spells out at length — a
 * cancel is evidence about the lane in NEITHER direction, and this one is stronger still: no send was ever
 * attempted, so there is not even a blocked send to record.
 */
export async function gateLaneOrBlock(
  ctx: LaneGateContext,
  agent: AgentName,
): Promise<LaneOutcome | undefined> {
  if (ctx.signal.aborted) {
    return cancelledBeforeDispatch(ctx, agent);
  }
  initLaneAvailabilityStore(ctx.repoRoot); // idempotent: first turn loads durable state, rest are no-ops
  const now = ctx.nowMs ?? Date.now();
  const decision = evaluateSend(agent, now);
  if (decision.allow) {
    if (decision.retrying) {
      // FIX-2 (codex MAX): this transitioned the lane to `retrying` DURABLY but emitted nothing, so the
      // chrome never learned a recovery attempt was in flight — the renderer's own `retrying` -> ambient
      // precedence (status-agent-cell.ts's cellHealth, FIX-3c BLOCK 6) was unreachable in production:
      // dead code behind a state no producer ever published. What the operator saw instead was a lane
      // frozen on its death colour for the whole attempt, then a jump straight to healthy. Now the
      // attempt is visible, and the death REASON rides along (emitAvailabilityStatus carries it), so
      // /status keeps its truth while the chip reads "working on it".
      emitAvailabilityStatus(ctx.bus, agent, noteLaneRetry(agent, now));
      await forceFreshConnection(agent);
    }
    return undefined;
  }
  const availability = noteLaneBlockedSend(agent, now);
  emitAvailabilityStatus(ctx.bus, agent, availability);
  const notice = blockedNotice(
    availability,
    availableLaneNames(ALL_LANES.filter((a) => a !== agent)),
  );
  // First-class visible skip: a lane-scoped dispatch.failed with NO preceding dispatch.started (nothing was
  // spawned) — the SAME shape controller-council uses for a refused lane, so per-agent tails release on it.
  ctx.bus.emit({
    kind: "dispatch.failed",
    turn: ctx.turn,
    agent,
    exitCode: 1,
    error: notice,
    scope: "lane",
    state: "failed",
  });
  return { agent, text: "", exitCode: 1, state: "failed", error: notice };
}

/**
 * FL-144: the terminal for a lane the operator stopped BEFORE the gate decided anything. Shaped exactly like
 * the blocked skip above — a lane-scoped `dispatch.failed` with NO preceding `dispatch.started`, because
 * nothing was spawned — so every consumer that already releases on a refused lane (per-agent tails, the room
 * reducer) releases on this one too. The only difference is the word in `state`, and that word is the whole
 * defect: `dispatch.failed` carries `cancelled` as a first-class state (event-schemas.ts's terminal enum),
 * which is what finalizeLane already emits for a cancelled lane that DID dispatch (tower-bridge-lane.ts's
 * emitTerminal), so a stopped lane reads the same whichever side of the gate the cancel landed on.
 *
 * WRITES NOTHING DURABLE, and that is the load-bearing half. noteLaneBlockedSend would walk an exhausted
 * lane to `local_blocked` — the state whose meaning is "the operator has now been told this lane is dead" —
 * on the strength of a send that was never attempted; and emitAvailabilityStatus would paint the chip for a
 * verdict this turn did not earn. Same rule, same reason as recordLaneDispatchResult's `cancelled` early
 * return: a cancel is not evidence about the lane in EITHER direction.
 */
function cancelledBeforeDispatch(ctx: LaneGateContext, agent: AgentName): LaneOutcome {
  ctx.bus.emit({
    kind: "dispatch.failed",
    turn: ctx.turn,
    agent,
    exitCode: 1,
    error: GATE_CANCELLED_TEXT,
    scope: "lane",
    state: "cancelled",
  });
  return { agent, text: "", exitCode: 1, state: "cancelled", error: GATE_CANCELLED_TEXT };
}

/**
 * Records a REAL dispatch's outcome into the durable availability (call ONLY after an actual dispatch, never
 * for a gate-blocked lane). A credit/auth failure marks the lane dead + emits its availability chip; any
 * other failure leaves it alone (a transport hiccup is not exhaustion); a success on a previously-dead lane
 * clears it back to ready + emits the recovered chip.
 *
 * A CANCELLED OUTCOME IS NOT A VERDICT ON THE LANE AT ALL, and reading it as one is the operator's second
 * sighting: they pressed Ctrl+C and the footer answered `claude auto offline`, `codex auto offline`,
 * `gemini auto offline`. The branches below key off `exitCode` and the error TEXT, and a cancelled lane
 * carries exitCode 1 (tower-bridge-lane.ts:175-181 — every non-completed terminal does), so a cancel fell
 * through the unclassified branch into emitLaneUnreachable. It is the same lie eager-session-boot.ts:146
 * already names for the boot probe: `auth:"down"` on a chip whose agent is answering. The agent is not
 * offline — we told it to stop and it stopped. Nothing was learned about reachability, so nothing is
 * recorded, in EITHER direction: a cancel is not evidence of health either, so it does not clear a lane
 * that was already dead. This is why it is checked HERE and not by matching the carrier's failure text —
 * a cancel must be readable off the classification, never by parsing prose.
 *
 * A lane cancelled DURING a sanctioned retry stays `retrying`, deliberately. `retrying` is not blocked
 * (lane-availability.ts:111-113 omits it), so the lane stays dispatchable — the operator's very next
 * message goes out — and it does not re-arm forceFreshConnection, because gateLaneOrBlock only sets
 * `decision.retrying` for a lane that IS blocked. The next REAL dispatch resolves it: success → ready,
 * unclassified failure → the retry-failed branch below. Rolling it back to dead here would punish the
 * operator for stopping a turn, on the evidence the cancel is precisely what stopped us from gathering.
 */
export function recordLaneDispatchResult(
  ctx: LaneGateContext,
  agent: AgentName,
  outcome: LaneOutcome,
): void {
  initLaneAvailabilityStore(ctx.repoRoot);
  const now = ctx.nowMs ?? Date.now();
  if (outcome.state === "cancelled") return; // see the header: a cancel records nothing, either way
  if (outcome.exitCode === 0) {
    if (getLaneAvailability(agent).state !== "ready") {
      emitAvailabilityStatus(ctx.bus, agent, noteLaneSuccess(agent, now));
    }
    // W4-R2a-5 (defect 1 — the operator's THIRD sighting): a lane has TWO health channels, and this
    // recorder used to update only one. `auth` comes from the BOOT PROBE (eager-session-boot.ts's gemini
    // version probe -> use-cockpit-bus.ts's applyEagerOutcome dispatching auth:"down"), while
    // `availability` comes from dispatch reality. A probe that failed at boot therefore kept painting the
    // lane red FOREVER — in the operator's own frame, `✗ gemini` rendered in the SAME frame where gemini
    // answered them. A REAL successful dispatch is the strongest evidence of reachability there is and it
    // is strictly NEWER than the probe, so it clears the stale probe verdict here.
    // PRECEDENCE (referee amendment 1) IS PRESERVED, structurally: this only ever says `auth: "ready"`,
    // and the renderer checks hard availability FIRST (status-agent-cell.ts's cellHealth), so an
    // `exhausted` / `needs_auth` / `local_blocked` lane still paints down no matter what auth says.
    // A genuinely spent window also survives — agent-status-merge coerces ready -> limited when
    // usage.exhausted (the "ready but spent" contradiction it already guards).
    ctx.bus.emit({ kind: "agent.status", agent, auth: "ready" });
    return;
  }
  if (classifyLaneFailure(outcome.error ?? "") !== undefined) {
    emitAvailabilityStatus(ctx.bus, agent, noteLaneFailure(agent, outcome.error ?? "", now));
    return;
  }
  // FIX-3c BLOCK 1: an UNCLASSIFIED failure is not a death for a HEALTHY lane (a transport hiccup must not
  // fake exhaustion) — but during a SANCTIONED RETRY it is decisive: the one send we let through did not
  // work. `retrying` is not a blocked state, so leaving it here would restore normal dispatching and burn a
  // child on every subsequent send — the zombie in a new shape. And unclassified is the COMMON case here:
  // the carrier collapses transport failures to generic text (headless-carrier.ts's carrierFailureText).
  // NOT ON THE RETRY BRANCH, deliberately: `auth:"down"` OUTRANKS `availability:"retrying"` in cellHealth
  // (status-agent-cell.ts:103 before :109), so marking the chip here would paint a recovery attempt as
  // unreachable. This branch already returns the lane to its hard death state, which outranks auth anyway.
  if (getLaneAvailability(agent).state === "retrying") {
    emitAvailabilityStatus(ctx.bus, agent, noteLaneRetryFailed(agent, now));
    return;
  }
  emitLaneUnreachable(ctx.bus, agent);
}

/**
 * FL-134, the third cancel seam. FIX-3c BLOCK 1 (headless-turn.ts's runOneLane): a dispatch that ESCAPES
 * with a throw is still a failed attempt for a HEALTHY lane — but the escape can also happen AFTER a
 * carrier already finished dispatching (response writing and finalizeLane are still inside runOneLane's
 * try), and if the operator cancelled around that same moment the escape IS the cancel, walking out through
 * code the observer never reached to classify. Same rule as the two seams that already read the signal
 * (headless-carrier.ts's markCarrierTerminal, {@link recordLaneDispatchResult} above): the SIGNAL decides,
 * never the shape or text of the error. A cancelled escape is recorded (skipped by
 * recordLaneDispatchResult, same as every other cancel) and RETURNED as a normal outcome — a deliberate
 * stop is not a bug and must not reject the turn. A genuine failure (signal never fired) keeps the
 * ORIGINAL behavior: record it, then re-throw, so an in-flight sanctioned retry left in `retrying` still
 * surfaces loudly (pinned by headless-turn-boundary-trace.test.ts's FALSIFIER — a genuine escape must
 * still reject the turn).
 *
 * FL-144: the `signal` PARAMETER is gone; the signal is read off {@link LaneGateContext}. It was a second
 * source of truth for the one fact this module exists to decide — the caller could hand the context one
 * turn's signal and this function another, and nothing would have said so. There is now exactly one signal
 * per gate context and every synthesizer in this file reads it from there.
 */
export function handleEscapedLaneError(
  ctx: LaneGateContext,
  agent: AgentName,
  error: unknown,
): LaneOutcome {
  const cancelled = ctx.signal.aborted;
  const outcome: LaneOutcome = {
    agent,
    text: "",
    exitCode: 1,
    state: cancelled ? "cancelled" : "failed",
    error: error instanceof Error ? error.message : String(error),
  };
  recordLaneDispatchResult(ctx, agent, outcome);
  if (cancelled) {
    return outcome;
  }
  throw error;
}

/**
 * W4-R2b RULING 3, CLAUSE 2 (operator, 2026-07-27): "how about we just say its online, and if we send a
 * message and doesnt go through we say offline and that it".
 *
 * Clause 1 shipped by REMOVING gemini's boot `--version` probe — which was the only thing that ever marked
 * a missing/unauthenticated gemini — so until this existed, a gemini that is not installed read
 * `◇ gemini auto` forever while every send failed with `agy-pty-spawn: agy.exe not found at "…"`
 * (agy-pty-spawn.ts:23-25, preserved into `outcome.error` through headless-carrier.ts:122 on the carrier
 * path and headless-turn.ts:219 on the non-carrier one). That text matches neither death pattern
 * (lane-availability.ts:42-44), so the caller's classified branch never ran and the chip stayed silent:
 * the same class of lie the probe removal closed, pointing the other way.
 *
 * WHY THE `auth` CHANNEL AND NOT AVAILABILITY — the crux. Availability's blocked states REFUSE future
 * sends (isLaneBlocked, lane-availability.ts:111-113), so recording a transport hiccup there would LOCK
 * THE OPERATOR OUT of a lane over one bad send, which is the opposite of FIX-3c's invariant. `auth` is a
 * DISPLAY channel — no dispatch gate reads it (evaluateSend reads availability only) — and its documented
 * meaning is exactly the claim being made here: "we could not reach this lane" (status-agent-cell.ts:87).
 * So the chip tells the truth and the operator's very next message still goes out.
 *
 * NO REASON RIDES ALONG. The `agent.status` wire schema carries auth/usage/availability and nothing else
 * (event-schemas.ts:426-432 — a reason string has no field, and Zod would drop it silently), and INV-13
 * keeps raw child-CLI text off the chrome regardless. The failure's own words are already delivered where
 * they belong: the lane's `dispatch.failed` carries them into the feed (tower-bridge-lane.ts:319).
 */
function emitLaneUnreachable(bus: ChatEventBus, agent: AgentName): void {
  bus.emit({ kind: "agent.status", agent, auth: "down" });
}

/** Emits ONE agent.status carrying the lane's dispatch-reality availability (the chrome's exhausted/needs-
 *  auth chip). Separate from the usage-probe auth/usage halves — the cockpit reducer merges. */
export function emitAvailabilityStatus(
  bus: ChatEventBus,
  agent: AgentName,
  a: LaneAvailability,
): void {
  bus.emit({
    kind: "agent.status",
    agent,
    availability: {
      state: a.state,
      ...(a.reason !== undefined ? { reason: a.reason } : {}),
      ...(a.resetsAtMs !== undefined ? { resetsAtMs: a.resetsAtMs } : {}),
    },
  });
}

/**
 * BLOCK 3 (FIX-3b) — THE RECONNECT EDGE. A recovery attempt must never ride the connection that died.
 * The field wedge (chat-1784553379589 turns 25/26: credits → auth, revived only by an app restart) has a
 * provable in-process twin on the CARRIER path: the adapter marks a session `queryClosed`
 * (@agentclientprotocol/claude-agent-acp dist/acp-agent.js:1981-1988) and then rejects every later prompt
 * forever (:579-581), while the bridge CHILD stays alive — so `conn.isAlive()`
 * (acp-lane-connection.ts:203) keeps satisfying lane-transport's already-held fast path (:180-183) and the
 * retry lands right back in the dead session. Dropping the hold here closes it through the existing ladder
 * (orphans surfaced) so the very next `start()` opens a real connection: a genuine resume on a FRESH child,
 * with the carrier's own resume-failed ladder (lane-carrier.ts:472-495) still behind it if even that fails.
 * ACP lanes only — gemini's agy carrier holds no cross-turn bridge connection; the non-carrier path spawns
 * a child per turn and has no hold, so dropLaneHold is a documented no-op there.
 */
async function forceFreshConnection(agent: AgentName): Promise<void> {
  if (agent !== "claude" && agent !== "codex") return;
  await dropLaneHold(agent);
}

/**
 * The calm, zer0-worded notice for a blocked send: the death reason (never the raw child advice) and which
 * lanes ARE available right now (all-3 parity — the skip is never a silent gap).
 *
 * NO RESET CLOCK. This used to append ` Resets around 10:04:00 AM.` whenever a reset instant was known.
 * OPERATOR RULING, 2026-08-24: "keep it simple, just show out of usage and that's it." The terminal's
 * health phrase was cut to the bare word under that ruling, and this is the OTHER string the operator
 * reads about the same fact — leaving the clock here would have the footer saying `out of usage` while
 * the feed, one row below, still promised a time. The instant is not gone, it is just not shown: it
 * still retires the health state on the terminal side and still bounds the recovery probe here.
 */
function blockedNotice(a: LaneAvailability, available: readonly AgentName[]): string {
  const base = a.reason ?? "this lane is unavailable right now";
  const avail =
    available.length > 0
      ? ` Available now: ${available.join(", ")}.`
      : " No other lanes are available right now.";
  return `skipped — ${base}.${avail}`;
}
