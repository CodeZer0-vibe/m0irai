/**
 * @file src/room/room-engine-contract.ts
 * @purpose Defines the stable room scheduler seam shared by the host, recovery, transport, and tests.
 * @exports Room event/lane/options types, stable lane identity, and bounded journal/resync constants.
 * @depends ../chat/types, ./room-handoff, ./room-journal
 */
import type { AgentName } from "../chat/types.js";
import type { RoomHandoff } from "./room-handoff.js";
import { roomLaneIdentity as projectLaneIdentity } from "./room-journal.js";

export type RoomEventType =
  | "turn.accepted"
  | "route.resolved"
  | "lane.queued"
  | "lane.started"
  | "lane.activity"
  | "lane.chunk"
  | "lane.cancelling"
  | "lane.completed"
  | "lane.failed"
  | "lane.cancelled"
  | "agent.status"
  | "agent.mode"
  | "message.committed"
  | "turn.completed"
  | "room.paused"
  | "room.resumed"
  | "permission.requested"
  | "permission.resolved"
  | "hop.dispatched"
  | "hop.blocked"
  | "session.saved"
  | "backend.failed"
  | "room.notice";

export interface RoomEvent {
  readonly protocol: "zer0.room";
  readonly version: 1;
  readonly sessionId: string;
  readonly eventSeq: string;
  readonly eventId: string;
  readonly turnId: string;
  readonly occurredAt: string;
  readonly type: RoomEventType;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface RoomLane {
  readonly agent: AgentName;
  readonly turnId: string;
  readonly text: string;
  readonly signal: AbortSignal;
  readonly hopIndex: number;
  readonly origin: "operator" | "agent";
  readonly replyTo?: string;
  readonly fromAgent?: AgentName;
  readonly parentMessageId?: string;
  readonly hopId?: string;
  /** Durable target identity for the persisted carrier result. */
  readonly expectedMessageId?: string;
  readonly onChunk: (chunk: string) => void;
}

/** The stable protocol identity shared by every event emitted for one room lane. */
export function roomLaneIdentity(
  lane: Pick<RoomLane, "agent" | "turnId" | "hopIndex" | "parentMessageId">,
): { readonly laneId: string; readonly streamId: string } {
  return projectLaneIdentity(lane);
}

export interface RoomLaneResult {
  readonly text: string;
  readonly status: "completed" | "failed" | "cancelled";
  /** Bounded provider/admission reason surfaced only on failed lane terminals. */
  readonly error?: string;
  /** Set false when a carrier failed before the evidence ledger committed its outcome. */
  readonly committed?: boolean;
  readonly messageId?: string;
  readonly ledgerSeq?: string;
  /** Extracted by the room carrier boundary; never reparsed from visible prose here. */
  readonly handoff?: RoomHandoff;
}

export interface RoomEngineOptions {
  readonly sessionId?: string;
  readonly runLane: (lane: RoomLane) => Promise<RoomLaneResult>;
  readonly onEvent?: (event: RoomEvent) => Promise<void> | void;
  readonly onCancel?: (agent: AgentName) => Promise<void> | void;
}

export type RoomCancelScope = "latest" | "agent" | "all";

export const MAX_ROOM_EVENT_BYTES: number = 256 * 1024;
export const MAX_ROOM_JOURNAL_EVENTS: number = 100_000;
export const MAX_ROOM_JOURNAL_BYTES: number = 64 * 1024 * 1024;
export const MAX_RESYNC_PAGE_EVENTS: number = 256;
export const MAX_RESYNC_PAGE_BYTES: number = 512 * 1024;

export interface RoomResyncPage {
  readonly events: readonly RoomEvent[];
  readonly hasMore: boolean;
}
