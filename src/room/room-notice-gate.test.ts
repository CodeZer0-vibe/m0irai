import { expect, it } from "vitest";
import type { RoomNoticeCause } from "../shared/room-notice.js";
import type { RoomEvent } from "./room-engine-contract.js";
import { RoomNoticeGate } from "./room-notice-gate.js";

function raise(gate: RoomNoticeGate, cause: RoomNoticeCause, detail = "detail") {
  return gate.admit({ cause, detail });
}

function noticeEvent(seq: number, payload: Readonly<Record<string, unknown>>): RoomEvent {
  return {
    protocol: "zer0.room",
    version: 1,
    sessionId: "chat-gate",
    eventSeq: String(seq),
    eventId: `gate-${seq}`,
    turnId: "turn-1",
    occurredAt: "2026-09-02T00:00:00.000Z",
    type: "room.notice",
    payload,
  };
}

it("admits the first occurrence of a cause and refuses every later one", () => {
  const gate = new RoomNoticeGate();
  expect(raise(gate, "memory-compose-failed", "first")).toEqual({
    cause: "memory-compose-failed",
    detail: "first",
  });
  expect(raise(gate, "memory-compose-failed", "second")).toBeUndefined();
  expect(raise(gate, "memory-compose-failed", "third")).toBeUndefined();
});

it("counts the occurrences it refuses, so the repeats are not simply lost", () => {
  const gate = new RoomNoticeGate();
  for (let index = 0; index < 5; index += 1) raise(gate, "memory-cursor-failed");
  expect(gate.occurrencesOf("memory-cursor-failed")).toBe(5);
  expect(gate.occurrencesOf("memory-compose-failed")).toBe(0);
});

it("gates each cause independently, because they are different news", () => {
  const gate = new RoomNoticeGate();
  expect(raise(gate, "memory-db-open-failed")).toBeDefined();
  expect(raise(gate, "memory-compose-failed")).toBeDefined();
  expect(raise(gate, "memory-db-open-failed")).toBeUndefined();
  expect(raise(gate, "agy-conversation-lost")).toBeDefined();
});

it("omits an absent agent instead of putting an explicit undefined on the wire", () => {
  const gate = new RoomNoticeGate();
  const withAgent = gate.admit({ cause: "memory-db-open-failed", agent: "codex", detail: "d" });
  expect(withAgent).toEqual({ cause: "memory-db-open-failed", agent: "codex", detail: "d" });
  const without = gate.admit({ cause: "memory-cursor-failed", detail: "d" });
  expect(Object.keys(without ?? {})).toEqual(["cause", "detail"]);
});

it("rebuilds from the journal so a reload does not re-announce what was already shown", () => {
  const gate = new RoomNoticeGate();
  gate.rehydrate([
    noticeEvent(4, { cause: "memory-compose-failed", agent: "claude", detail: "boom" }),
    noticeEvent(9, { cause: "agy-conversation-lost", detail: "lost" }),
  ]);
  expect(raise(gate, "memory-compose-failed")).toBeUndefined();
  expect(raise(gate, "agy-conversation-lost")).toBeUndefined();
  // A cause the loaded session never showed is still new after the reload.
  expect(raise(gate, "memory-cursor-failed")).toBeDefined();
});

it("ignores journal rows that are not notices, and notices with no usable cause", () => {
  const gate = new RoomNoticeGate();
  gate.rehydrate([
    { ...noticeEvent(1, { message: "backend down" }), type: "backend.failed" },
    noticeEvent(2, { detail: "cause missing" }),
    noticeEvent(3, { cause: "", detail: "cause empty" }),
    noticeEvent(4, { cause: 7, detail: "cause not a string" }),
  ]);
  expect(gate.occurrencesOf("")).toBe(0);
  expect(gate.occurrencesOf("backend down")).toBe(0);
  expect(raise(gate, "memory-compose-failed")).toBeDefined();
});
