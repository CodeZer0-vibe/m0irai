/**
 * @file src/room/room-engine-contract.test.ts
 * @purpose Locks the stable room lane identity and bounded journal/resync contract.
 * @exports (test suite)
 * @depends vitest, ./room-engine-contract
 */
import { expect, it } from "vitest";
import {
  MAX_RESYNC_PAGE_BYTES,
  MAX_RESYNC_PAGE_EVENTS,
  MAX_ROOM_EVENT_BYTES,
  MAX_ROOM_JOURNAL_BYTES,
  MAX_ROOM_JOURNAL_EVENTS,
  roomLaneIdentity,
} from "./room-engine-contract.js";

it("uses one stable identity for an operator lane and a parent-scoped identity for a hop", () => {
  const operator = roomLaneIdentity({ agent: "codex", turnId: "turn-7", hopIndex: 0 });
  const hop = roomLaneIdentity({
    agent: "codex",
    turnId: "turn-7",
    hopIndex: 1,
    parentMessageId: "message-claude-1",
  });

  expect(operator).toEqual({
    laneId: "turn-7:codex:0",
    streamId: "stream:turn-7:codex:0",
  });
  expect(hop).toEqual({
    laneId: "turn-7:message-claude-1:codex:1",
    streamId: "stream:turn-7:message-claude-1:codex:1",
  });
});

it("keeps every retained protocol surface explicitly bounded", () => {
  expect(MAX_ROOM_EVENT_BYTES).toBe(256 * 1024);
  expect(MAX_ROOM_JOURNAL_EVENTS).toBe(100_000);
  expect(MAX_ROOM_JOURNAL_BYTES).toBe(64 * 1024 * 1024);
  expect(MAX_RESYNC_PAGE_EVENTS).toBe(256);
  expect(MAX_RESYNC_PAGE_BYTES).toBe(512 * 1024);
  expect(MAX_RESYNC_PAGE_BYTES).toBeGreaterThan(MAX_ROOM_EVENT_BYTES);
});
