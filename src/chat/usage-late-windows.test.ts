/**
 * @file src/chat/usage-late-windows.test.ts
 * @purpose FL-099 day 3, the COMPOSED path: a claude `/usage` answer that loses the bridge's 3 s race
 *   is forwarded late, and the operator's 5h and weekly meters reach `agent.status` because of it.
 *   Split out of usage-race-receipt.test.ts along a real seam — that file pins what the PATCH BYTES
 *   say, this one pins what the wired-together path DOES — rather than letting either grow past the
 *   clamp.
 *
 *   Day 2 shipped the receiver (acp-lane-connection.ts's session-scoped standing listener) without a
 *   producer: the bridge had no `.then` on its `usageCall`, so a lost race discarded the real answer
 *   inside the bridge and the listener waited for a message that was never sent. The operator kept
 *   seeing `ctx 3%` alone. This exercises both halves at once, with only the child process and the
 *   wire faked.
 * @exports (none — test file)
 * @depends vitest, ../adapters/acp/acp-lane-connection, ../adapters/acp/acp-permission, ../adapters/acp/acp-turn-session, ./claude-usage-fold, ./events, ./usage-reporter
 */
import { beforeEach, expect, it } from "vitest";
import {
  type LaneChildLike,
  type LaneWireConnection,
  buildLaneConnection,
} from "../adapters/acp/acp-lane-connection.js";
import { type EmitSlot, deliverLaneUpdate } from "../adapters/acp/acp-lane-update-routing.js";
import { denyDecider } from "../adapters/acp/acp-permission.js";
import { createAcpClient } from "../adapters/acp/acp-turn-session.js";
import { resetClaudeWindowFold } from "./claude-usage-fold.js";
import { ChatEventBus } from "./events.js";
import { createUsageReporter } from "./usage-reporter.js";

// claude's window fold is PROCESS-scoped on purpose (claude-usage-fold.ts:15 — account windows outlive
// a turn), which makes it shared state between tests: without this reset a sibling case's 5h reading
// is already present before this one's late emit, and the guard below cannot tell late from early.
beforeEach(resetClaudeWindowFold);

/** The receipt the bridge sends INSIDE the turn when its 3 s race expires: real ctx numbers, and a
 *  marker saying the windows are not here. This is all the operator used to get. */
const TIMED_OUT_RECEIPT = {
  sessionUpdate: "usage_update",
  used: 40,
  size: 100,
  _meta: { "_claude/usageOutcome": "timed-out" },
} as const;

/** The answer that lost the race, forwarded AFTER the turn settled — the message day 2 built a
 *  receiver for and day 3 finally makes the bridge send. */
const LATE_WINDOWS = {
  sessionUpdate: "usage_update",
  used: 40,
  size: 100,
  _meta: { "_claude/usageWindows": { five_hour: { utilization: 71, resets_at: 1_800_000_000 } } },
} as const;

/** The reporter, the routing slot and the ACP client, wired the way `openAcpLaneConnection` wires
 *  them: the client's notification handler feeds the real `deliverLaneUpdate`, whose standing sink is
 *  a real `createUsageReporter` publishing on a real bus. */
function wiredLane(): {
  readonly statuses: unknown[];
  readonly slot: EmitSlot;
  readonly client: ReturnType<typeof createAcpClient>;
  readonly reporter: ReturnType<typeof createUsageReporter>;
} {
  const bus = new ChatEventBus();
  const statuses: unknown[] = [];
  bus.on("agent.status", (event) => statuses.push(event));
  const reporter = createUsageReporter({
    agent: "claude",
    bus,
    cwd: "C:/repo",
    startedMs: Date.now(),
    turn: 1,
  });
  const slot: EmitSlot = {
    current: undefined,
    standing: (update) => reporter.recordAcpSessionUpdate(update),
    liveSessionId: undefined,
  };
  const client = createAcpClient({
    decide: denyDecider,
    onSessionUpdate: (update, sessionId) => deliverLaneUpdate(slot, update, sessionId),
    onUpdate: () => undefined,
    onUsage: () => undefined,
  });
  return { statuses, slot, client, reporter };
}

it("FL-099 day 3: the operator's 5h meter arrives from a LATE bridge emit, end to end", async () => {
  // THE WHOLE PATH, scripted exactly as the fixed bridge now behaves on a lost race: the turn's
  // `/usage` call misses the 3 s bound, the bridge sends `usageOutcome: "timed-out"` INSIDE the turn
  // and settles, and the real answer lands afterwards and is FORWARDED as an out-of-turn
  // `usage_update`. Every hop is the production one — `createAcpClient`'s notification handler, the
  // real `deliverLaneUpdate` routing rule, `buildLaneConnection`'s per-turn sink lifecycle, and a real
  // `createUsageReporter` publishing on a real bus. Only the child process and the wire are fakes.
  //
  // This is the test the round-2 lane could not have written: the receiver existed, the producer did
  // not, so the second half of this script never happened in production and the operator kept seeing
  // `ctx 3%` alone.
  const { statuses, slot, client, reporter } = wiredLane();
  let lateEmit: Promise<unknown> = Promise.resolve();
  const conn = laneWireStub(async () => {
    // In-turn: the receipt for the race we lost. `slot.current` is installed, so this is the turn's.
    await client.sessionUpdate({ sessionId: "s-live", update: TIMED_OUT_RECEIPT });
    // Scheduled, NOT awaited — the bridge's `.then` does not block settlement either.
    lateEmit = new Promise((resolve) => {
      setTimeout(
        () => resolve(client.sessionUpdate({ sessionId: "s-live", update: LATE_WINDOWS })),
        500,
      );
    });
    return { stopReason: "end_turn" };
  });

  const lane = buildLaneConnection("claude", laneChildStub(), conn, "C:/repo", slot);
  await lane.prompt("s-live", "hello", (update) => reporter.recordAcpSessionUpdate(update));

  // The turn is over and the per-turn sink is gone — the state that used to throw the answer away.
  expect(slot.current, "the per-turn sink outlived its turn").toBeUndefined();
  const beforeLate = statuses.length;
  expect(
    statuses.some((status) => hasFiveHour(status)),
    "the 5h window arrived before the late emit; this script no longer tests a LATE answer",
  ).toBe(false);

  await lateEmit;

  expect(
    statuses.length,
    "the late usage_update published nothing - the operator's 5h meter never appears",
  ).toBeGreaterThan(beforeLate);
  expect(statuses.at(-1)).toMatchObject({ usage: { fiveHourUsedPct: 71 } });
});

function hasFiveHour(status: unknown): boolean {
  return (status as { usage?: { fiveHourUsedPct?: number } }).usage?.fiveHourUsedPct !== undefined;
}

/** A child that is never really spawned: `buildLaneConnection` only ever kills it or waits on exit. */
function laneChildStub(): LaneChildLike {
  return {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    kill: () => true,
    once: () => undefined,
  };
}

/** The SDK wire, with only `prompt` scripted; every other method is the shape the lane needs to exist. */
function laneWireStub(prompt: LaneWireConnection["prompt"]): LaneWireConnection {
  return {
    initialize: async () => ({}),
    newSession: async () => ({ sessionId: "s-live" }),
    resumeSession: async () => ({}),
    prompt,
    setSessionMode: async () => ({}),
    setSessionConfigOption: async () => ({}),
    extMethod: async () => ({}),
  };
}

it("F7: a late usage_update after usage capture was aborted publishes no agent.status", () => {
  // CHECKED BEFORE CHANGING ANYTHING, because the review's wording and the tree disagreed. The finding
  // reads "a late usage_update publishes agent.status with no usageCaptureAborted check"; reading
  // usage-reporter.ts, `recordAcp` does indeed have no guard of its own, but every status it publishes
  // goes through `emitStatus`, which opens with the same `input.usagePoll?.signal?.aborted` test that
  // `usageCaptureAborted` is. So the status path is already closed and the concern is real only for the
  // usage.payload DIAGNOSTIC, which the payload emitter drops on its own predicate.
  //
  // This pin exists because the guard is now load-bearing in a way it was not before: until the late
  // path shipped, nothing could reach `emitStatus` after the room had aborted capture at all. It runs
  // GREEN today; that is the finding, and this is what stops it from silently becoming false.
  const bus = new ChatEventBus();
  const statuses: unknown[] = [];
  bus.on("agent.status", (event) => statuses.push(event));
  const aborted = new AbortController();
  aborted.abort();
  const reporter = createUsageReporter({
    agent: "claude",
    bus,
    cwd: "C:/repo",
    startedMs: Date.now(),
    turn: 1,
    usagePoll: { signal: aborted.signal },
  });
  const slot: EmitSlot = {
    current: undefined,
    standing: (update) => reporter.recordAcpSessionUpdate(update),
    liveSessionId: "s-live",
  };

  deliverLaneUpdate(
    slot,
    {
      sessionUpdate: "usage_update",
      used: 40,
      size: 100,
      _meta: {
        "_claude/usageWindows": { five_hour: { utilization: 71, resets_at: 1_800_000_000 } },
      },
    },
    "s-live",
  );

  expect(
    statuses,
    "a room that has already torn its usage capture down still had a status pushed at it",
  ).toEqual([]);
});
