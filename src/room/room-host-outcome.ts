/**
 * @file src/room/room-host-outcome.ts
 * @purpose Resolve a settled provider lane to its one canonical durable chat message.
 * @exports RoomLaneOutcome, resolveSettledRoomMessage, buildSettledRoomLaneResult
 * @depends ../chat/headless-turn, ../chat/types, ./room-engine, ./room-handoff
 */
import { type runHeadlessTurn, safeLaneFailureReason } from "../chat/headless-turn.js";
import type { ChatMessage } from "../chat/types.js";
import type { RoomLane, RoomLaneResult } from "./room-engine.js";
import type { RoomHandoff } from "./room-handoff.js";

export type RoomLaneOutcome = Parameters<
  NonNullable<Parameters<typeof runHeadlessTurn>[0]["onLaneSettled"]>
>[1];

interface SettledRoomMessageInput {
  readonly outcome: RoomLaneOutcome;
  readonly lane: RoomLane;
  readonly settledMessage?: ChatMessage;
  readonly persistFailure: () => Promise<ChatMessage>;
}

export async function resolveSettledRoomMessage(
  input: SettledRoomMessageInput,
): Promise<ChatMessage> {
  if (input.settledMessage !== undefined) return input.settledMessage;
  if (input.outcome.state === "completed" || input.outcome.exitCode === 0) {
    throw new Error(
      `room lane ${input.lane.agent} finished without its canonical persisted outcome`,
    );
  }
  // Availability gates fail before the adapter/finalize callback. Persist that failed outcome under
  // the output identity minted at queue admission so the room keeps its actionable provider reason.
  return input.persistFailure();
}

interface SettledRoomLaneResultInput {
  readonly outcome: RoomLaneOutcome;
  readonly lane: RoomLane;
  readonly message: ChatMessage;
  readonly ledgerSeq?: string;
  readonly handoff?: RoomHandoff;
}

export function buildSettledRoomLaneResult(input: SettledRoomLaneResultInput): RoomLaneResult {
  if (input.message.status === "completed" && input.ledgerSeq === undefined) {
    throw new Error(`room lane ${input.lane.agent} completed without a durable ledger commit`);
  }
  return {
    text: input.message.text,
    status: input.outcome.state === "cancelled" ? "cancelled" : input.message.status,
    messageId: input.message.id,
    committed: input.ledgerSeq !== undefined,
    ...(input.ledgerSeq === undefined ? {} : { ledgerSeq: input.ledgerSeq }),
    ...(input.outcome.error === undefined
      ? {}
      : { error: safeLaneFailureReason(input.outcome.error) }),
    ...(input.handoff === undefined ? {} : { handoff: input.handoff }),
  };
}
