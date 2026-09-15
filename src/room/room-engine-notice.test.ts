import { expect, it } from "vitest";
import { RoomEngine, type RoomEvent } from "./room-engine.js";

function engine(): RoomEngine {
  return new RoomEngine({
    runLane: async () => ({ text: "", status: "completed" }),
  });
}

function notices(room: RoomEngine): readonly RoomEvent[] {
  return room.events().filter((event) => event.type === "room.notice");
}

function journalNotice(seq: number, cause: string): RoomEvent {
  return {
    protocol: "zer0.room",
    version: 1,
    sessionId: "room-unbound",
    eventSeq: String(seq),
    eventId: `event-${seq}`,
    turnId: "turn-1",
    occurredAt: "2026-09-02T00:00:00.000Z",
    type: "room.notice",
    payload: { cause, agent: "claude", detail: "recorded before the reload" },
  };
}

it("announces a cause once and never again in the same session", () => {
  const room = engine();
  room.notice("turn-1", { cause: "memory-compose-failed", agent: "claude", detail: "first" });
  room.notice("turn-1", { cause: "memory-compose-failed", agent: "codex", detail: "second" });
  room.notice("turn-2", { cause: "memory-compose-failed", agent: "gemini", detail: "third" });

  expect(notices(room)).toHaveLength(1);
  expect(notices(room)[0]?.payload).toEqual({
    cause: "memory-compose-failed",
    agent: "claude",
    detail: "first",
  });
});

it("announces a DIFFERENT cause, because it is different news", () => {
  const room = engine();
  room.notice("turn-1", { cause: "memory-compose-failed", detail: "compose" });
  room.notice("turn-1", { cause: "memory-cursor-failed", detail: "cursor" });
  room.notice("turn-1", { cause: "memory-compose-failed", detail: "compose again" });

  expect(notices(room).map((event) => event.payload.cause)).toEqual([
    "memory-compose-failed",
    "memory-cursor-failed",
  ]);
});

it("does not re-announce after a reload of the same session", () => {
  const room = engine();
  room.rehydrate([journalNotice(1, "memory-db-open-failed")]);
  room.notice("turn-1", { cause: "memory-db-open-failed", detail: "same cause after reload" });
  expect(notices(room)).toHaveLength(1);
  expect(notices(room)[0]?.eventSeq).toBe("1");

  // A cause the loaded session never announced is still new.
  room.notice("turn-1", { cause: "memory-cursor-failed", detail: "new after reload" });
  expect(notices(room).map((event) => event.payload.cause)).toEqual([
    "memory-db-open-failed",
    "memory-cursor-failed",
  ]);
});

it("omits an absent agent rather than putting undefined on the wire", () => {
  const room = engine();
  room.notice("turn-1", { cause: "memory-request-files-failed", detail: "no agent" });
  expect(notices(room)[0]?.payload).toEqual({
    cause: "memory-request-files-failed",
    detail: "no agent",
  });
});

it("refuses to emit a notice the wire would reject, rather than corrupting the journal", () => {
  const room = engine();
  expect(() =>
    room.notice("turn-1", { cause: "memory-compose-failed", detail: "x".repeat(201) }),
  ).toThrow("invalid room.notice payload");
  expect(notices(room)).toHaveLength(0);
});
