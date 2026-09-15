/**
 * @file src/room/room-host-outcome.test.ts
 * @purpose Proves room lane terminals use exactly one durable message and ledger outcome.
 * @exports (test suite)
 * @depends vitest, ../chat/types, ./room-engine, ./room-host-outcome
 */
import { expect, it, vi } from "vitest";
import type { ChatMessage } from "../chat/types.js";
import type { RoomLane } from "./room-engine.js";
import {
  type RoomLaneOutcome,
  buildSettledRoomLaneResult,
  resolveSettledRoomMessage,
} from "./room-host-outcome.js";

const lane: RoomLane = {
  agent: "claude",
  turnId: "turn-1",
  text: "inspect",
  signal: new AbortController().signal,
  hopIndex: 0,
  origin: "operator",
  onChunk: vi.fn(),
};
const completedOutcome: RoomLaneOutcome = {
  agent: "claude",
  text: "done",
  exitCode: 0,
  state: "completed",
  messageId: "message-1",
  messageCreatedAt: "2026-08-13T00:00:00.000Z",
};
const completedMessage: ChatMessage = {
  id: "message-1",
  turn: 1,
  role: "agent",
  agent: "claude",
  text: "done",
  createdAt: "2026-08-13T00:00:00.000Z",
  status: "completed",
  tokenEstimate: 1,
};

it("returns the settled canonical message without a second persistence write", async () => {
  const persistFailure = vi.fn(async () => completedMessage);
  await expect(
    resolveSettledRoomMessage({
      outcome: completedOutcome,
      lane,
      settledMessage: completedMessage,
      persistFailure,
    }),
  ).resolves.toBe(completedMessage);
  expect(persistFailure).not.toHaveBeenCalled();
});

it("rejects a successful lane with no durable outcome and persists pre-finalize failures", async () => {
  await expect(
    resolveSettledRoomMessage({
      outcome: completedOutcome,
      lane,
      persistFailure: async () => completedMessage,
    }),
  ).rejects.toThrow("finished without its canonical persisted outcome");

  const failedMessage = { ...completedMessage, status: "failed" as const, text: "bridge down" };
  const persistFailure = vi.fn(async () => failedMessage);
  const failedOutcome = {
    ...completedOutcome,
    text: "bridge down",
    exitCode: 1,
    state: "failed" as const,
    error: "bridge down",
  };
  await expect(
    resolveSettledRoomMessage({ outcome: failedOutcome, lane, persistFailure }),
  ).resolves.toBe(failedMessage);
  expect(persistFailure).toHaveBeenCalledOnce();
});

it("requires a ledger commit for completed messages and projects safe terminal details", () => {
  expect(() =>
    buildSettledRoomLaneResult({ outcome: completedOutcome, lane, message: completedMessage }),
  ).toThrow("completed without a durable ledger commit");

  expect(
    buildSettledRoomLaneResult({
      outcome: { ...completedOutcome, state: "cancelled", error: "\u001b[31mstopped" },
      lane,
      message: { ...completedMessage, status: "cancelled" },
      handoff: { target: "codex", text: "review" },
    }),
  ).toMatchObject({
    status: "cancelled",
    messageId: "message-1",
    committed: false,
    handoff: { target: "codex", text: "review" },
    error: expect.not.stringContaining("\u001b"),
  });
});
