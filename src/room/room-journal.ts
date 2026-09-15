/**
 * @file src/room/room-journal.ts
 * @purpose Validate and project persisted room events for scheduler recovery.
 * @exports RecoveredRoomLane, RecoveredRoomPermission, RoomJournalProjection, projectRoomJournal, roomLaneIdentity
 * @depends ../chat/types, ./room-engine (type-only)
 */
import type { AgentName } from "../chat/types.js";
import type { RoomEvent } from "./room-engine.js";
import { validateRoomEvent } from "./room-protocol.js";

export interface RecoveredRoomLane {
  readonly agent: AgentName;
  readonly turnId: string;
  readonly text: string;
  readonly hopIndex: number;
  readonly origin: "operator" | "agent";
  readonly replyTo?: string;
  readonly fromAgent?: AgentName;
  readonly parentMessageId?: string;
  readonly hopId?: string;
  /** Output identity minted before this lane is durably admitted to the journal. */
  readonly expectedMessageId?: string;
  readonly streamId?: string;
  readonly nextStreamSeq?: string;
  readonly nextChunkIndex?: number;
}

export interface RecoveredRoomPermission {
  readonly askId: string;
  readonly agent: AgentName;
  readonly turnId: string;
}

export interface RoomJournalProjection {
  readonly lanes: ReadonlyMap<string, RecoveredRoomLane>;
  readonly terminal: ReadonlySet<string>;
  readonly pendingPermissions: ReadonlyMap<string, RecoveredRoomPermission>;
  readonly paused: boolean;
  readonly lastSequence: bigint;
}

export function roomLaneIdentity(
  lane: Pick<RecoveredRoomLane, "agent" | "turnId" | "hopIndex" | "parentMessageId">,
): {
  readonly laneId: string;
  readonly streamId: string;
} {
  const laneId =
    lane.parentMessageId === undefined
      ? `${lane.turnId}:${lane.agent}:${lane.hopIndex}`
      : `${lane.turnId}:${lane.parentMessageId}:${lane.agent}:${lane.hopIndex}`;
  return { laneId, streamId: `stream:${laneId}` };
}

export function projectRoomJournal(
  events: readonly RoomEvent[],
  sessionId: string,
): RoomJournalProjection {
  const state: JournalState = {
    lanes: new Map(),
    terminal: new Set(),
    pendingPermissions: new Map(),
    paused: false,
    lastSequence: 0n,
    eventIds: new Set(),
    permissionIds: new Set(),
    laneOutcomes: new Set(),
  };
  for (const event of events) projectEvent(state, event, sessionId);
  return state;
}

interface JournalState extends RoomJournalProjection {
  readonly lanes: Map<string, RecoveredRoomLane>;
  readonly terminal: Set<string>;
  readonly pendingPermissions: Map<string, RecoveredRoomPermission>;
  readonly eventIds: Set<string>;
  readonly permissionIds: Set<string>;
  readonly laneOutcomes: Set<string>;
  paused: boolean;
  lastSequence: bigint;
}

function projectEvent(state: JournalState, event: RoomEvent, sessionId: string): void {
  validateRoomEvent(event);
  validateJournalEvent(event, sessionId, state.lastSequence, state.eventIds);
  state.lastSequence = BigInt(event.eventSeq);
  state.eventIds.add(event.eventId);
  if (event.type === "room.paused") state.paused = true;
  if (event.type === "room.resumed") state.paused = false;
  if (event.type === "lane.queued") {
    const lane = laneFromEvent(event);
    const identity = roomLaneIdentity(lane);
    if (event.payload.laneId !== identity.laneId || state.lanes.has(identity.laneId))
      throw new Error("invalid or duplicate room lane recovery identity");
    state.lanes.set(identity.laneId, lane);
  }
  if (event.type === "lane.started") projectLaneStart(state, event);
  if (event.type === "lane.chunk") {
    projectChunkCursor(state, event);
  }
  if (event.type === "permission.requested") projectPermissionRequest(state, event);
  if (event.type === "permission.resolved") projectPermissionResolution(state, event);
  if (isTerminalEvent(event)) projectTerminalLane(state, event);
}

function projectLaneStart(state: JournalState, event: RoomEvent): void {
  const { laneId, streamId, agent } = event.payload;
  if (typeof laneId !== "string" || typeof streamId !== "string" || !isAgent(agent))
    throw new Error("invalid room lane start recovery identity");
  const lane = state.lanes.get(laneId);
  if (
    lane === undefined ||
    lane.agent !== agent ||
    lane.turnId !== event.turnId ||
    streamId !== roomLaneIdentity(lane).streamId ||
    lane.streamId !== undefined ||
    state.terminal.has(laneId)
  )
    throw new Error("invalid room lane start recovery identity");
  state.lanes.set(laneId, { ...lane, streamId });
}

function projectTerminalLane(state: JournalState, event: RoomEvent): void {
  const { laneId, agent, streamId } = event.payload;
  if (
    typeof laneId !== "string" ||
    !isAgent(agent) ||
    (streamId !== undefined && typeof streamId !== "string")
  )
    throw new Error("invalid room terminal recovery identity");
  const lane = state.lanes.get(laneId);
  if (
    lane === undefined ||
    lane.agent !== agent ||
    lane.turnId !== event.turnId ||
    (event.type === "message.committed"
      ? state.terminal.has(laneId)
      : state.laneOutcomes.has(laneId)) ||
    (streamId !== undefined && streamId !== roomLaneIdentity(lane).streamId)
  )
    throw new Error("invalid room terminal recovery identity");
  if (
    event.type === "lane.failed" &&
    lane.streamId === undefined &&
    event.payload.recovered !== true
  )
    throw new Error("queued room lane failure must be an explicit recovery terminal");
  state.terminal.add(laneId);
  if (event.type !== "message.committed") state.laneOutcomes.add(laneId);
}

function projectPermissionRequest(state: JournalState, event: RoomEvent): void {
  const { askId, agent } = event.payload;
  if (
    typeof askId !== "string" ||
    askId.length === 0 ||
    !isAgent(agent) ||
    state.permissionIds.has(askId)
  )
    throw new Error("invalid room permission recovery request");
  state.permissionIds.add(askId);
  state.pendingPermissions.set(askId, { askId, agent, turnId: event.turnId });
}

function projectPermissionResolution(state: JournalState, event: RoomEvent): void {
  const { askId, agent, outcome } = event.payload;
  if (typeof askId !== "string" || !isAgent(agent))
    throw new Error("invalid room permission recovery resolution");
  const pending = state.pendingPermissions.get(askId);
  if (
    pending === undefined ||
    pending.agent !== agent ||
    pending.turnId !== event.turnId ||
    (outcome !== "approved" &&
      outcome !== "denied" &&
      outcome !== "timeout" &&
      outcome !== "invalidated")
  )
    throw new Error("invalid room permission recovery resolution");
  state.pendingPermissions.delete(askId);
}

function projectChunkCursor(state: JournalState, event: RoomEvent): void {
  const { laneId, streamId, streamSeq, chunkIndex, agent } = event.payload;
  if (
    typeof laneId !== "string" ||
    typeof streamSeq !== "string" ||
    !/^(0|[1-9][0-9]*)$/u.test(streamSeq) ||
    typeof chunkIndex !== "number" ||
    !Number.isSafeInteger(chunkIndex) ||
    chunkIndex < 0
  )
    throw new Error("invalid room chunk recovery payload");
  const lane = state.lanes.get(laneId);
  if (lane === undefined) throw new Error("room chunk has no queued lane");
  if (
    !isAgent(agent) ||
    lane.agent !== agent ||
    lane.turnId !== event.turnId ||
    lane.streamId !== streamId ||
    streamId !== roomLaneIdentity(lane).streamId ||
    state.terminal.has(laneId)
  )
    throw new Error("room chunk recovery identity does not match started lane");
  if (streamSeq !== (lane.nextStreamSeq ?? "1") || chunkIndex !== (lane.nextChunkIndex ?? 0)) {
    throw new Error("room chunk recovery cursor is not monotonic");
  }
  state.lanes.set(laneId, {
    ...lane,
    nextStreamSeq: (BigInt(streamSeq) + 1n).toString(),
    nextChunkIndex: chunkIndex + 1,
  });
}

function laneFromEvent(event: RoomEvent): RecoveredRoomLane {
  if (!isLanePayload(event.payload)) {
    throw new Error("invalid room lane recovery payload");
  }
  const {
    agent,
    text,
    origin,
    hopIndex,
    replyTo,
    fromAgent,
    parentMessageId,
    hopId,
    expectedMessageId,
  } = event.payload;
  return {
    agent,
    text,
    turnId: event.turnId,
    origin,
    hopIndex,
    ...(replyTo === undefined ? {} : { replyTo }),
    ...(fromAgent === undefined ? {} : { fromAgent }),
    ...(parentMessageId === undefined ? {} : { parentMessageId }),
    ...(hopId === undefined ? {} : { hopId }),
    ...(expectedMessageId === undefined ? {} : { expectedMessageId }),
  };
}

function isTerminalEvent(event: RoomEvent): boolean {
  return (
    event.type === "lane.completed" ||
    event.type === "lane.failed" ||
    event.type === "lane.cancelled" ||
    event.type === "message.committed"
  );
}

interface RecoveredLanePayload {
  readonly agent: AgentName;
  readonly text: string;
  readonly origin: "operator" | "agent";
  readonly hopIndex: number;
  readonly replyTo?: string;
  readonly fromAgent?: AgentName;
  readonly parentMessageId?: string;
  readonly hopId?: string;
  readonly expectedMessageId?: string;
}

function isLanePayload(
  payload: Readonly<Record<string, unknown>>,
): payload is Readonly<Record<string, unknown>> & RecoveredLanePayload {
  const {
    agent,
    text,
    origin,
    hopIndex,
    replyTo,
    fromAgent,
    parentMessageId,
    hopId,
    expectedMessageId,
  } = payload;
  return (
    isAgent(agent) &&
    typeof text === "string" &&
    (origin === "operator" || origin === "agent") &&
    typeof hopIndex === "number" &&
    Number.isSafeInteger(hopIndex) &&
    (typeof replyTo === "string" || replyTo === undefined) &&
    (isAgent(fromAgent) || fromAgent === undefined) &&
    (typeof parentMessageId === "string" || parentMessageId === undefined) &&
    (typeof hopId === "string" || hopId === undefined) &&
    (typeof expectedMessageId === "string" || expectedMessageId === undefined)
  );
}

function isAgent(value: unknown): value is AgentName {
  return value === "claude" || value === "codex" || value === "gemini";
}

function validateJournalEvent(
  event: RoomEvent,
  sessionId: string,
  previous: bigint,
  eventIds: ReadonlySet<string>,
): void {
  if (event.protocol !== "zer0.room" || event.version !== 1 || event.sessionId !== sessionId)
    throw new Error("invalid room journal event");
  if (BigInt(event.eventSeq) !== previous + 1n || eventIds.has(event.eventId))
    throw new Error("corrupt room journal sequence");
}
