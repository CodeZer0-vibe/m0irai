import { expect, it } from "vitest";
import type { RoomEvent } from "./room-engine.js";
import { projectRoomJournal, roomLaneIdentity } from "./room-journal.js";

function event(seq: number, type: RoomEvent["type"], payload: Record<string, unknown>): RoomEvent {
  return {
    protocol: "zer0.room",
    version: 1,
    sessionId: "chat-journal",
    eventSeq: String(seq),
    eventId: `event-${seq}`,
    turnId: "turn-1",
    occurredAt: "2026-01-01T00:00:00.000Z",
    type,
    payload:
      type === "lane.chunk"
        ? { agent: "codex", streamId: "stream", channel: "stdout", text: "x", ...payload }
        : payload,
  };
}

it("projects a parent-derived hop lane and advances its stream cursor", () => {
  const lane = {
    agent: "codex" as const,
    turnId: "turn-1",
    text: "review",
    origin: "agent" as const,
    hopIndex: 1,
    parentMessageId: "message-parent",
    fromAgent: "claude" as const,
    hopId: "hop:turn-1:message-parent:claude:codex:1",
  };
  const identity = roomLaneIdentity(lane);
  const projection = projectRoomJournal(
    [
      event(1, "lane.queued", { ...lane, laneId: identity.laneId }),
      event(2, "lane.started", {
        laneId: identity.laneId,
        streamId: identity.streamId,
        agent: lane.agent,
      }),
      event(3, "lane.chunk", {
        laneId: identity.laneId,
        streamId: identity.streamId,
        streamSeq: "1",
        chunkIndex: 0,
      }),
    ],
    "chat-journal",
  );
  expect(projection.lanes.get(identity.laneId)).toMatchObject({
    ...lane,
    nextStreamSeq: "2",
    nextChunkIndex: 1,
  });
});

it("fails closed on a corrupt sequence or chunk cursor", () => {
  expect(() => projectRoomJournal([event(2, "turn.completed", {})], "chat-journal")).toThrow(
    "corrupt room journal sequence",
  );
  expect(() =>
    projectRoomJournal(
      [event(1, "lane.chunk", { laneId: "missing", streamSeq: "1", chunkIndex: 0 })],
      "chat-journal",
    ),
  ).toThrow("room chunk has no queued lane");
});

it("treats a durable message commit as terminal when a crash precedes lane.completed", () => {
  const lane = {
    agent: "claude" as const,
    turnId: "turn-1",
    text: "answer",
    origin: "operator" as const,
    hopIndex: 0,
    expectedMessageId: "msg-preassigned",
  };
  const identity = roomLaneIdentity(lane);
  const projection = projectRoomJournal(
    [
      event(1, "lane.queued", { ...lane, laneId: identity.laneId }),
      event(2, "message.committed", {
        agent: lane.agent,
        laneId: identity.laneId,
        messageId: lane.expectedMessageId,
        ledgerSeq: "7",
      }),
    ],
    "chat-journal",
  );
  expect(projection.terminal).toContain(identity.laneId);
  expect(projection.lanes.get(identity.laneId)?.expectedMessageId).toBe("msg-preassigned");
});

it("fails closed on duplicate lane IDs and a chunk whose stream identity was never started", () => {
  const lane = {
    agent: "codex" as const,
    turnId: "turn-1",
    text: "review",
    origin: "operator" as const,
    hopIndex: 0,
  };
  const identity = roomLaneIdentity(lane);
  const queued = event(1, "lane.queued", { ...lane, laneId: identity.laneId });
  expect(() =>
    projectRoomJournal([queued, { ...queued, eventSeq: "2", eventId: "event-2" }], "chat-journal"),
  ).toThrow("duplicate room lane");
  expect(() =>
    projectRoomJournal(
      [
        queued,
        event(2, "lane.chunk", {
          laneId: identity.laneId,
          streamId: "stream:wrong",
          streamSeq: "1",
          chunkIndex: 0,
        }),
      ],
      "chat-journal",
    ),
  ).toThrow("identity does not match started lane");
});

it("tracks only unresolved permission asks so crash recovery can fail them closed", () => {
  const requested = event(1, "permission.requested", {
    agent: "codex",
    askId: "ask-pending",
    options: [{ optionId: "allow" }],
  });
  const pending = projectRoomJournal([requested], "chat-journal");
  expect(pending.pendingPermissions.get("ask-pending")).toEqual({
    askId: "ask-pending",
    agent: "codex",
    turnId: "turn-1",
  });

  const settled = projectRoomJournal(
    [
      requested,
      event(2, "permission.resolved", {
        agent: "codex",
        askId: "ask-pending",
        outcome: "invalidated",
      }),
    ],
    "chat-journal",
  );
  expect(settled.pendingPermissions.size).toBe(0);
  expect(() =>
    projectRoomJournal(
      [requested, { ...requested, eventSeq: "2", eventId: "event-2" }],
      "chat-journal",
    ),
  ).toThrow("permission recovery request");
});
