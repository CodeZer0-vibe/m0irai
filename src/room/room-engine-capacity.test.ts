/**
 * @file src/room/room-engine-capacity.test.ts
 * @purpose Proves room turn reservations and recovery preflight protect durable journal closure.
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./room-engine-capacity, ./room-engine-contract
 */
import { expect, it, vi } from "vitest";
import {
  RoomJournalCapacity,
  applyCapacityCheckedRecovery,
  assertRoomJournalCapacity,
} from "./room-engine-capacity.js";
import type { RoomEvent } from "./room-engine-contract.js";
import { RoomEngine } from "./room-engine.js";
import { projectRoomJournal } from "./room-journal.js";

it("rejects reservation overcommit before any event is admitted and releases unused capacity", () => {
  const capacity = new RoomJournalCapacity();
  for (let turn = 1; turn <= 12; turn += 1) capacity.reserveTurn(`turn-${turn}`, 3);
  expect(() => capacity.reserveTurn("turn-13", 3)).toThrow("no capacity");
  capacity.releaseTurn("turn-1");
  expect(() => capacity.reserveTurn("turn-13", 3)).not.toThrow();
});

it("does not persist or append any recovery prefix when the repaired plan is over capacity", async () => {
  const first = event(1, "first");
  const second = event(2, "second");
  const persistSession = vi.fn(async () => undefined);
  const appendEvent = vi.fn(async () => undefined);
  await expect(
    applyCapacityCheckedRecovery({
      journal: [first, second],
      appended: [second],
      persistSession,
      appendEvent,
      limits: { maxEvents: 1 },
    }),
  ).rejects.toThrow("1 events");
  expect(persistSession).not.toHaveBeenCalled();
  expect(appendEvent).not.toHaveBeenCalled();
});

it("preflights a repaired journal before callers mutate the transcript or append recovery events", () => {
  const first = event(1, "first");
  const second = event(2, "second");
  const exactBytes = Buffer.byteLength(`${JSON.stringify(first)}\n`, "utf8");
  expect(() =>
    assertRoomJournalCapacity([first], { maxEvents: 1, maxBytes: exactBytes }),
  ).not.toThrow();
  expect(() => assertRoomJournalCapacity([first, second], { maxEvents: 1 })).toThrow("1 events");
  expect(() => assertRoomJournalCapacity([first, second], { maxBytes: exactBytes })).toThrow(
    `${exactBytes} bytes`,
  );
});

it("does not advance the durable chunk cursor when advisory capacity drops a chunk", async () => {
  const engine = new RoomEngine({
    runLane: async (lane) => {
      lane.onChunk("first");
      lane.onChunk("second");
      return { text: "done", status: "completed", messageId: "msg-1" };
    },
  });
  const capacity = Reflect.get(engine, "capacity") as RoomJournalCapacity;
  const admit = capacity.admit.bind(capacity);
  let rejectFirstChunk = true;
  vi.spyOn(capacity, "admit").mockImplementation((turnId, type, bytes) => {
    if (type === "lane.chunk" && rejectFirstChunk) {
      rejectFirstChunk = false;
      return false;
    }
    return admit(turnId, type, bytes);
  });

  engine.bindSession("chat-room-test");
  engine.reserveTurn("turn-1", 1);
  await engine.submit({
    turnId: "turn-1",
    agents: ["claude"],
    text: "stream",
    messageId: "operator-1",
    ledgerSeq: "1",
  });
  await engine.whenIdle();

  const chunks = engine.events().filter((entry) => entry.type === "lane.chunk");
  expect(chunks.map((entry) => entry.payload.streamSeq)).toEqual(["1"]);
  expect(chunks.map((entry) => entry.payload.chunkIndex)).toEqual([0]);
  expect(() => projectRoomJournal(engine.events(), "chat-room-test")).not.toThrow();
});

it("ignores provider chunks that arrive after the lane has settled", async () => {
  let lateChunk: ((text: string) => void) | undefined;
  const engine = new RoomEngine({
    runLane: async (lane) => {
      lateChunk = lane.onChunk;
      return { text: "done", status: "completed", messageId: "msg-1" };
    },
  });
  engine.bindSession("chat-room-test");
  engine.reserveTurn("turn-1", 1);
  await engine.submit({
    turnId: "turn-1",
    agents: ["claude"],
    text: "stream",
    messageId: "operator-1",
    ledgerSeq: "1",
  });
  await engine.whenIdle();
  lateChunk?.("too late");

  expect(engine.events().filter((entry) => entry.type === "lane.chunk")).toEqual([]);
  expect(() => projectRoomJournal(engine.events(), "chat-room-test")).not.toThrow();
});

function event(sequence: number, message: string): RoomEvent {
  return {
    protocol: "zer0.room",
    version: 1,
    sessionId: "chat-capacity-test",
    eventSeq: String(sequence),
    eventId: `event-${sequence}`,
    turnId: "turn-1",
    occurredAt: "2026-01-01T00:00:00.000Z",
    type: "backend.failed",
    payload: { message },
  };
}
