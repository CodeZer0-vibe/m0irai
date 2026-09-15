/**
 * @file src/adapters/acp/acp-lane-update-routing.ts
 * @purpose WHICH SINK GETS ONE RAW SESSION UPDATE, and the routing state one live connection starts
 *   with. Split out of acp-lane-connection.ts, which owns a bridge child's LIFECYCLE — spawn, hold,
 *   prompt, close — and crossed its 500-line target when this contract grew. Two different questions,
 *   and this is the one that is pure: no child, no wire, no timers.
 * @exports EmitSlot, deliverLaneUpdate, laneEmitSlot
 * @depends ./acp-lane-connection
 *
 * FL-099 day 2/3. The operator's claude 5h and weekly meters never appeared, and the reason was split
 * across both halves of a conversation: the bridge DISCARDED a `/usage` answer that lost its own 3 s
 * race (fixed in the patch, day 3), and the client DROPPED one that arrived after the turn settled
 * (fixed here, day 2). Either alone changes nothing the operator can see.
 */
import type { OpenAcpLaneConnectionInput } from "./acp-lane-connection.js";

/**
 * The raw-update routing state for ONE bridge connection: the in-flight turn's sink, the session's own
 * standing sink, and which session the standing one still belongs to.
 *
 * FL-099 day 2 — WHY THERE ARE TWO SINKS. `current` is per-PROMPT and is cleared the moment the turn
 * settles, which is right: a later turn's updates must never reach a finished turn. But clearing it used
 * to mean the update was DROPPED, and the operator's missing 5h/weekly meters live in that gap. claude's
 * `/usage` answer is raced against a 3 s timer inside the vendored bridge and cannot simply be given
 * longer: that race is awaited in the bridge's own `case "result":` handler AHEAD of every path that
 * settles the turn (`dist/acp-agent.js:2451` vs `:2546`/`:2641`), so every extra millisecond of budget is
 * a millisecond the operator's lane keeps saying `working` after the answer has finished streaming. The
 * fix is not to wait longer, it is to stop throwing away the answer that arrives a moment late.
 */
export interface EmitSlot {
  /** The in-flight turn's sink. Cleared when the prompt settles — unchanged, and still load-bearing. */
  current: ((update: unknown) => void) | undefined;
  /** The SESSION's sink, installed once at open and living as long as the connection does. */
  standing: ((update: unknown) => void) | undefined;
  /** The session id the last prompt ran on; a late update for any other session is not ours. */
  liveSessionId: string | undefined;
  readonly signal?: AbortSignal;
}

/**
 * WHICH SINK GETS ONE RAW UPDATE. Exported and pure for the same reason {@link resolveDecider} is: the
 * live glue around it spawns a real child, and the decision itself is the part that can be wrong in a
 * way no e2e receipt would notice.
 *
 * THE IN-FLIGHT TURN ALWAYS WINS, and never shares. Delivering to both sinks would double every reading
 * a turn produces — two meter samples, two diagnostics — and look like working code in every screenshot.
 *
 * TWO ACCEPTED EDGE CASES on the late path, decided rather than overlooked.
 *
 * (1) If the operator has already started turn N+1 on the SAME session, `slot.current` is installed
 * again and a late answer for turn N lands on N+1's sink. The METERS still arrive — `agent.status`
 * carries no turn id because usage is account and session state — and only the `usage.payload`
 * DIAGNOSTIC is stamped with the neighbouring turn. Accepted: a diagnostic attributed one turn late is
 * a far smaller lie than the meters never appearing.
 *
 * ⚠ THAT SENTENCE WAS FALSE WHEN IT WAS FIRST WRITTEN HERE, and it is worth saying why rather than
 * quietly correcting it. It is only true because the BRIDGE now captures its usage numbers before
 * registering the late handler. Read live, `lastAssistantTotalUsage` is a runConsumer-scoped local the
 * next turn's activation nulls, so the forward arrived as `used: null` — and {@link usageFromUpdate}
 * rejects a `usage_update` with a non-numeric `used` and takes the `_meta` windows down with it, so
 * nothing was published at all. The fix failed hardest in exactly the case it exists for: the slower
 * the `/usage` call, the likelier the operator has already typed again.
 *
 * (2) If a sanctioned retry opened a NEW session, the guard below REFUSES the old session's late
 * answer and that turn's windows are lost. Accepted, and preferred to the alternative: folding one
 * session's reading into another's status is a WRONG number, where this is merely a missing one, and
 * the next turn's own call replaces it.
 *
 * A LATE UPDATE IS CHECKED AGAINST THE SESSION IT NAMES. One connection can outlive its session: a
 * sanctioned retry drops the hold and the next prompt runs a NEW session id over the same child, so a
 * `/usage` answer still in flight for the old one would otherwise be folded into the new session's
 * status — a real reading attributed to the wrong session. An update that names NO session is accepted:
 * the ACP notification always carries one, and refusing an unnamed update would silently drop a future
 * bridge's shape rather than surfacing it.
 */
/** The one raw-update shape the session's standing listener accepts — see {@link deliverLaneUpdate}. */
function isUsageUpdate(update: unknown): boolean {
  return (
    typeof update === "object" &&
    update !== null &&
    "sessionUpdate" in update &&
    (update as { readonly sessionUpdate?: unknown }).sessionUpdate === "usage_update"
  );
}

export function deliverLaneUpdate(slot: EmitSlot, update: unknown, sessionId?: string): void {
  if (slot.current !== undefined) {
    slot.current(update);
    return;
  }
  if (slot.standing === undefined) return;
  // USAGE UPDATES ONLY, outside a turn. The standing listener exists for one message — the `/usage`
  // answer the bridge forwards after losing its own 3 s race — and the production tap it feeds
  // (`headless-carrier.ts`) also drives a PER-TURN detector and `onLaneActivity`, which becomes
  // `engine.notify(lane.turnId, "lane.activity", …)` for a turn that has already settled. Widening
  // the drop-everything rule to deliver-everything would have handed a finished turn new activity;
  // this widens it by exactly the one message that needed to get through. The bridge's only other
  // out-of-turn emitter, `case "rate_limit_event"`, rides on the same `usage_update` type
  // (`dist/acp-agent.js`, `case "rate_limit_event":` — :3121 as of this commit, and it MOVES: our own
  // patch inserts above it, so grep the label rather than trusting the number. A round-3 reviewer and
  // I cited two different line numbers for it, both right when read and both stale by the time they
  // were quoted), so nothing legitimate is lost.
  if (!isUsageUpdate(update)) return;
  if (
    sessionId !== undefined &&
    slot.liveSessionId !== undefined &&
    sessionId !== slot.liveSessionId
  ) {
    return;
  }
  slot.standing(update);
}

/**
 * The routing state one live connection starts with — EXPORTED AND PURE for the same reason
 * {@link resolveDecider} and {@link deliverLaneUpdate} are: {@link openAcpLaneConnection} spawns a real
 * child process, so the one line inside it that decides whether the session's standing listener exists
 * at all cannot be reached by a test that does not spawn one.
 *
 * A2. That line is a SUPPLY-CHAIN LINK, and it was unpinned in exactly the way `fe3c939` was written to
 * fix one hop downstream: severing `standing` here leaves `slot.standing` undefined in production while
 * every routing test stays green, because they all build their `EmitSlot` by hand. A guard that is
 * perfect and dead — the same sentence, one hop up.
 */
export function laneEmitSlot(input: OpenAcpLaneConnectionInput): EmitSlot {
  return {
    current: undefined,
    // Installed ONCE, for the life of the connection — not per prompt. A per-prompt registration would
    // deliver every late update once per turn the session has served.
    standing: input.onSessionUpdate,
    liveSessionId: undefined,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}
