import { expect, it, vi } from "vitest";
import { RoomEngine, type RoomEvent, roomLaneIdentity } from "./room-engine.js";

function event(
  eventSeq: number,
  type: RoomEvent["type"],
  payload: Readonly<Record<string, unknown>>,
): RoomEvent {
  return {
    protocol: "zer0.room",
    version: 1,
    sessionId: "chat-recovery",
    eventSeq: String(eventSeq),
    eventId: `event-${eventSeq}`,
    turnId: "turn-interrupted",
    occurredAt: "2026-01-01T00:00:00.000Z",
    type,
    payload,
  };
}

it("fails an interrupted running lane once instead of emitting a duplicate start", async () => {
  const runLane = vi.fn(async () => ({ text: "unexpected", status: "completed" as const }));
  const engine = new RoomEngine({ runLane });
  engine.bindSession("chat-recovery");
  const lane = {
    agent: "claude" as const,
    turnId: "turn-interrupted",
    text: "work",
    hopIndex: 0,
    origin: "operator" as const,
    parentMessageId: "operator-1",
    expectedMessageId: "agent-1",
  };
  const identity = roomLaneIdentity(lane);
  const projection = engine.rehydrate([
    event(1, "lane.queued", { ...lane, laneId: identity.laneId }),
    event(2, "lane.started", {
      agent: lane.agent,
      laneId: identity.laneId,
      streamId: identity.streamId,
    }),
  ]);

  await engine.invalidateRecoveredRunningLanes(projection.lanes.values(), projection.terminal);
  await engine.activateRecovered();

  expect(runLane).not.toHaveBeenCalled();
  expect(engine.events().filter((item) => item.type === "lane.started")).toHaveLength(1);
  expect(
    engine
      .events()
      .slice(2)
      .map((item) => item.type),
  ).toEqual(["lane.failed", "turn.completed"]);
  expect(engine.events()[2]?.payload).toMatchObject({
    agent: "claude",
    laneId: identity.laneId,
    streamId: identity.streamId,
    error: "room lane interrupted by host restart",
  });
});
