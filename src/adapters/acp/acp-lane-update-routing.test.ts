/**
 * @file src/adapters/acp/acp-lane-update-routing.test.ts
 * @purpose FL-099 day 2 — WHICH SINK GETS ONE RAW SESSION UPDATE. Split out of
 *   acp-lane-connection.test.ts, which crossed the 500-line target when these landed; that file keeps
 *   the handshake timeouts, the close ladder and the fail-closed decider, and this one keeps the
 *   routing contract: the in-flight turn owns its updates and never shares them, a LATE update falls
 *   through to the session's standing listener instead of being dropped, an update naming a superseded
 *   session is refused, a closed connection has no listener left, and exactly one listener exists per
 *   connection however many turns it serves — plus the guard's SUPPLY LINE, that the bridge
 *   notification's own sessionId actually reaches the tap through createAcpClient. Without that last
 *   pair the refusal rule can be perfect and dead: every other test here hands the id over by hand, so
 *   they all stay green when the wire stops carrying it and an absent id is accepted by design.
 * @exports (none — test file)
 * @depends vitest, ./acp-lane-connection, ./acp-permission, ./acp-turn-session
 *
 * WHY THIS CONTRACT EXISTS AT ALL. The operator's claude 5h and weekly meters never appeared. The
 * bridge races its `/usage` call against a 3 s timer, and that bound cannot simply be raised: it is
 * awaited inside the bridge's own `case "result":` handler AHEAD of every path that settles the turn
 * (`node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js:2451` against `:2546` and
 * `:2641`), so every extra millisecond of budget is a millisecond the operator's lane keeps saying
 * `working` after the answer has finished streaming. The windows were not lost to giving up too early
 * — they were lost because when they DID arrive, a moment late, `slot.current` was already undefined
 * and nothing else was listening.
 */
import { expect, it } from "vitest";
import {
  type LaneChildLike,
  type LaneWireConnection,
  buildLaneConnection,
} from "./acp-lane-connection.js";
import { type EmitSlot, deliverLaneUpdate } from "./acp-lane-update-routing.js";
import { denyDecider } from "./acp-permission.js";
import { createAcpClient } from "./acp-turn-session.js";

interface FakeChildState {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: number;
  exitListeners: (() => void)[];
}

function fakeChild(pid = 4242): { child: LaneChildLike; state: FakeChildState } {
  const state: FakeChildState = { exitCode: null, signalCode: null, killed: 0, exitListeners: [] };
  const child: LaneChildLike = {
    pid,
    get exitCode() {
      return state.exitCode;
    },
    get signalCode() {
      return state.signalCode;
    },
    kill: () => {
      state.killed += 1;
      return true;
    },
    once: (_event, listener) => {
      state.exitListeners.push(listener);
      return undefined;
    },
  };
  return { child, state };
}

function fakeConn(overrides: Partial<LaneWireConnection> = {}): LaneWireConnection {
  return {
    initialize: async () => ({}),
    newSession: async () => ({ sessionId: "s-new" }),
    resumeSession: async () => ({}),
    prompt: async () => ({ stopReason: "end_turn" }),
    setSessionMode: async () => ({}),
    setSessionConfigOption: async () => ({}),
    extMethod: async () => ({}),
    ...overrides,
  };
}

function slot(standing?: (update: unknown) => void): EmitSlot {
  return { current: undefined, standing, liveSessionId: undefined };
}

it("a usage_update that lands AFTER the prompt settles still reaches the session's listener", async () => {
  // THE OPERATOR'S MISSING METERS, at the one line that threw them away. claude's `/usage` call is
  // raced against 3 s INSIDE the vendored bridge, and that bound cannot simply be raised: it is awaited
  // in the bridge's own `case "result":` handler ahead of every path that settles the turn
  // (dist/acp-agent.js:2451 vs :2546 and :2641), so every extra millisecond is a millisecond the
  // operator's lane keeps saying `working` after the answer has finished streaming. The windows are not
  // lost because we gave up too early — they are lost because when they DO arrive, a moment later,
  // `slot.current` is already undefined and nothing else is listening. This is that nothing.
  const late: unknown[] = [];
  const { child } = fakeChild();
  const s = slot((update) => late.push(update));
  const lane = buildLaneConnection("claude", child, fakeConn(), "C:/tmp/p", s);

  await lane.prompt("s-live", "hello", () => undefined);
  // The bridge answers /usage half a second after the turn is over — the whole point of the receipt.
  deliverLaneUpdate(s, { sessionUpdate: "usage_update", used: 40, size: 100 }, "s-live");

  expect(
    late,
    "a late usage_update was dropped; the operator's 5h and weekly meters never arrive",
  ).toEqual([{ sessionUpdate: "usage_update", used: 40, size: 100 }]);
});

it("an in-flight turn still owns the updates — the standing listener never doubles them", async () => {
  // The falsifier for delivering to BOTH. Two sinks fed by one update is a duplicated meter reading and
  // a duplicated diagnostic, and it would look like working code in every screenshot.
  const late: unknown[] = [];
  const { child } = fakeChild();
  const s = slot((update) => late.push(update));
  const conn = fakeConn({
    prompt: async () => {
      deliverLaneUpdate(s, { sessionUpdate: "usage_update", used: 1, size: 2 }, "s-live");
      return { stopReason: "end_turn" };
    },
  });
  const lane = buildLaneConnection("claude", child, conn, "C:/tmp/p", s);

  const seen: unknown[] = [];
  await lane.prompt("s-live", "hello", (update) => seen.push(update));

  expect(seen).toHaveLength(1);
  expect(late, "the standing listener also took the in-flight turn's update").toEqual([]);
});

it("a late update from a SUPERSEDED session is ignored — no cross-session bleed", async () => {
  // One connection can outlive its session: a sanctioned retry drops the hold and the next prompt runs
  // on a NEW session id over the same child. A `/usage` answer still in flight for the OLD session would
  // otherwise be folded into the new one's status — a real reading, attributed to the wrong session.
  const late: unknown[] = [];
  const { child } = fakeChild();
  const s = slot((update) => late.push(update));
  const lane = buildLaneConnection("claude", child, fakeConn(), "C:/tmp/p", s);

  await lane.prompt("s-old", "hello", () => undefined);
  await lane.prompt("s-new", "again", () => undefined);
  deliverLaneUpdate(s, { sessionUpdate: "usage_update", used: 9, size: 10 }, "s-old");

  expect(late, "an update for a superseded session was folded into the live one").toEqual([]);

  // The positive control: the SAME shape for the live session does arrive, so the assertion above is
  // the session check working rather than the standing listener being deaf.
  deliverLaneUpdate(s, { sessionUpdate: "usage_update", used: 9, size: 10 }, "s-new");
  expect(late).toHaveLength(1);
});

it("a closed connection has no standing listener left — nothing fires after close", async () => {
  // Closing is how a dropped hold ends. The child dies, so in production nothing should arrive anyway;
  // clearing the listener makes that true BY CONSTRUCTION rather than by trusting a kill to win a race.
  const late: unknown[] = [];
  const { child } = fakeChild();
  const s = slot((update) => late.push(update));
  const lane = buildLaneConnection("claude", child, fakeConn(), "C:/tmp/p", s);

  await lane.prompt("s-live", "hello", () => undefined);
  lane.close();
  deliverLaneUpdate(s, { sessionUpdate: "usage_update", used: 1, size: 2 }, "s-live");

  expect(late, "a closed connection still delivered an update").toEqual([]);
  expect(s.standing, "the listener outlived the connection that owned it").toBeUndefined();
});

it("one connection installs exactly ONE standing listener, however many turns it serves", async () => {
  // The leak check. The listener is installed once at open and lives on the connection, not the turn;
  // if a future edit ever re-registered it per prompt, a five-turn session would deliver every late
  // update five times. Counted through delivery, because a count of registrations could be right while
  // the delivery is wrong.
  let deliveries = 0;
  const { child } = fakeChild();
  const s = slot(() => {
    deliveries += 1;
  });
  const lane = buildLaneConnection("claude", child, fakeConn(), "C:/tmp/p", s);

  for (const turn of ["one", "two", "three", "four", "five"]) {
    await lane.prompt("s-live", turn, () => undefined);
  }
  deliverLaneUpdate(s, { sessionUpdate: "usage_update", used: 1, size: 2 }, "s-live");

  expect(deliveries, "the standing listener was registered more than once").toBe(1);
});

it("the bridge's notification carries its sessionId THROUGH createAcpClient to the tap", async () => {
  // THE GUARD'S SUPPLY LINE, and it had none. Every test above hands `deliverLaneUpdate` a session id
  // by hand, so all of them keep passing if the id stops arriving from the wire — and then the
  // cross-session refusal degrades silently to "accept everything", because an absent id is treated as
  // "not ours to judge". Measured, not assumed: dropping the second argument in
  // `acp-turn-session.ts`'s `sessionUpdate` handler leaves 1054 tests in src/adapters and src/chat
  // green. This is the one that goes red.
  // `sessionId: string | undefined` rather than an optional key: under exactOptionalPropertyTypes an
  // absent key and a present-but-undefined one are different types, and it is precisely the UNDEFINED
  // case this test has to be able to record and then fail on.
  const seen: { update: unknown; sessionId: string | undefined }[] = [];
  const client = createAcpClient({
    decide: denyDecider,
    onSessionUpdate: (update, sessionId) => seen.push({ update, sessionId }),
    onUpdate: () => undefined,
    onUsage: () => undefined,
  });

  await client.sessionUpdate({
    sessionId: "s-live",
    update: { sessionUpdate: "usage_update", used: 40, size: 100 },
  });

  expect(seen).toHaveLength(1);
  expect(
    seen[0]?.sessionId,
    "the notification's own sessionId never reached the tap; the cross-session guard has nothing to judge",
  ).toBe("s-live");
});

it("a superseded session is refused END TO END, from the bridge notification to the sink", async () => {
  // The two halves composed the way `openAcpLaneConnection` composes them
  // (`onSessionUpdate: (update, sessionId) => deliverLaneUpdate(slot, update, sessionId)`), because
  // either half can be right while the pair is broken. The wiring is replicated rather than exercised
  // through `openAcpLaneConnection` itself for the same reason `resolveDecider` is tested apart from
  // it: that function spawns a real child process, and the decision is the part that can be wrong in a
  // way no e2e receipt would notice.
  const late: unknown[] = [];
  const s = slot((update) => late.push(update));
  s.liveSessionId = "s-new"; // what a prompt on the new session sets
  const client = createAcpClient({
    decide: denyDecider,
    onSessionUpdate: (update, sessionId) => deliverLaneUpdate(s, update, sessionId),
    onUpdate: () => undefined,
    onUsage: () => undefined,
  });

  await client.sessionUpdate({
    sessionId: "s-old",
    update: { sessionUpdate: "usage_update", used: 9, size: 10 },
  });
  expect(late, "the old session's windows were folded into the live session's status").toEqual([]);

  // The positive control, so the assertion above is the guard working and not the wiring being deaf.
  await client.sessionUpdate({
    sessionId: "s-new",
    update: { sessionUpdate: "usage_update", used: 9, size: 10 },
  });
  expect(late).toHaveLength(1);
});

it("F6: the standing listener takes USAGE updates only, never a settled turn's activity", async () => {
  // WHAT THE STANDING PATH WIDENED, and it widened further than it needed to. In production the tap
  // is headless-carrier.ts's, and it does four things with every update it is handed:
  // `detector.onLaneUpdate`, `usage.recordAcpSessionUpdate`, `detector.onCtxPercent`, and
  // `onLaneActivity` -> room-host.ts's `engine.notify(lane.turnId, "lane.activity", ...)`. Three of
  // those four are PER-TURN. Before the standing listener existed, every post-settle update was
  // dropped, so none of them could ever fire for a finished turn; afterwards, all of them could.
  //
  // The listener exists for exactly ONE message: the `/usage` answer that lost the bridge's race and
  // is forwarded late. Restricting it to that message is the smallest widening that still delivers the
  // meters, and it costs nothing real — the bridge's only other out-of-turn emitter,
  // `case "rate_limit_event"` (dist/acp-agent.js, grep the label — :3121 at this commit and it moves
  // every time our own patch grows above it), also rides on `sessionUpdate:
  // "usage_update"`, so both messages a settled session can legitimately produce still arrive.
  const late: unknown[] = [];
  const { child } = fakeChild();
  const s = slot((update) => late.push(update));
  const lane = buildLaneConnection("claude", child, fakeConn(), "C:/tmp/p", s);
  await lane.prompt("s-live", "hello", () => undefined);

  for (const stray of [
    { sessionUpdate: "agent_message_chunk", content: { text: "a late thought" } },
    { sessionUpdate: "tool_call", toolCallId: "t-1", status: "in_progress" },
    { sessionUpdate: "plan", entries: [] },
  ]) {
    deliverLaneUpdate(s, stray, "s-live");
  }
  expect(
    late,
    "a settled turn was handed new activity; every consumer downstream of this tap is per-turn",
  ).toEqual([]);

  // The two messages that ARE the reason this listener exists still arrive.
  deliverLaneUpdate(s, { sessionUpdate: "usage_update", used: 40, size: 100 }, "s-live");
  deliverLaneUpdate(
    s,
    {
      sessionUpdate: "usage_update",
      used: 40,
      size: 100,
      _meta: { "_claude/rateLimit": { status: "allowed_warning" } },
    },
    "s-live",
  );
  expect(late, "the late /usage answer and the rate-limit event must both still land").toHaveLength(
    2,
  );
});

it("#9: after close(), the IN-FLIGHT turn still drains its own updates, and nothing else does", () => {
  // THE REVIEW'S #9, EXAMINED AND PINNED. `close()` clears `slot.standing` and kills the child but
  // leaves `slot.current` installed until `prompt()` settles, and unlike the standing path this
  // function does NO session comparison on `current`. Read as "a closed connection still accepts
  // updates with no guard", that is alarming.
  //
  // It is draining, not leakage, and the reason is one hop up: on this transport a connection serves
  // exactly ONE session for its whole life. Every route to a session goes through `openFresh` first
  // (`lane-hold.ts`'s `createFreshSession` and `resumeHeld` both call it before
  // `newSession`/`resumeSession`), and the only path that skips it reuses the session it already has.
  // So while `slot.current` is installed there is exactly one session on that connection, and the
  // updates arriving are that turn's own — the turn is still awaiting `prompt()` and is entitled to
  // them. lane-hold-text-generation.test.ts pins the one-session-per-connection property itself; this
  // pins the routing consequence.
  //
  // What close() DOES have to stop is the out-of-turn path, and it does: `standing` is severed, so the
  // moment the prompt settles this connection delivers nothing at all, ever again.
  const inFlight: unknown[] = [];
  const standing: unknown[] = [];
  const slot: EmitSlot = {
    current: (update) => inFlight.push(update),
    standing: undefined, // what close() left behind
    liveSessionId: "s-live",
  };

  deliverLaneUpdate(slot, { sessionUpdate: "usage_update", used: 40, size: 100 }, "s-live");
  expect(
    inFlight,
    "the turn still awaiting prompt() stopped receiving its own updates when the connection closed",
  ).toHaveLength(1);

  // The prompt settles: `current` is cleared in its `finally`, and with `standing` already severed
  // there is no sink left at all.
  slot.current = undefined;
  deliverLaneUpdate(slot, { sessionUpdate: "usage_update", used: 41, size: 100 }, "s-live");
  expect(inFlight, "an update landed after the turn settled").toHaveLength(1);
  expect(standing, "a closed connection delivered to a standing listener it no longer has").toEqual(
    [],
  );
});
