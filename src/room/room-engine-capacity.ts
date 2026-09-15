/**
 * @file src/room/room-engine-capacity.ts
 * @purpose Reserve durable journal closure capacity before room state is persisted.
 * @exports RoomJournalCapacity, applyCapacityCheckedRecovery, assertRoomJournalCapacity
 * @depends ./room-engine-contract, ./room-engine-primitives
 */
import {
  MAX_ROOM_EVENT_BYTES,
  MAX_ROOM_JOURNAL_BYTES,
  MAX_ROOM_JOURNAL_EVENTS,
  type RoomEvent,
  type RoomEventType,
} from "./room-engine-contract.js";
import { roomEventBytes } from "./room-engine-primitives.js";

interface TurnReservation {
  events: number;
  bytes: number;
}

const TURN_RESERVE_EVENTS = 64;
const TURN_RESERVE_BYTES = 4 * 1024 * 1024;
const RESERVED_EVENT_TYPES = new Set<RoomEventType>([
  "turn.accepted",
  "route.resolved",
  "lane.queued",
  "lane.started",
  "lane.cancelling",
  "message.committed",
  "lane.completed",
  "lane.failed",
  "lane.cancelled",
  "hop.dispatched",
  "hop.blocked",
  "turn.completed",
]);
const ADVISORY_EVENT_TYPES = new Set<RoomEventType>([
  "lane.activity",
  "lane.chunk",
  "agent.status",
  "agent.mode",
]);

export class RoomJournalCapacity {
  private events = 0;
  private bytes = 0;
  private reservedEvents = 0;
  private reservedBytes = 0;
  private readonly turns = new Map<string, TurnReservation>();

  public rehydrate(events: readonly RoomEvent[]): void {
    assertRoomJournalCapacity(events);
    this.events = events.length;
    this.bytes = events.reduce((total, event) => total + roomEventBytes(event), 0);
  }

  public reserveTurn(turnId: string, agentCount: number): void {
    if (this.turns.has(turnId)) throw new Error(`room turn ${turnId} is already reserved`);
    if (!Number.isSafeInteger(agentCount) || agentCount < 1 || agentCount > 3)
      throw new Error("room turn requires between one and three agents");
    const admissionEvents = 2 + agentCount;
    const admissionBytes = admissionEvents * MAX_ROOM_EVENT_BYTES;
    const events = admissionEvents + TURN_RESERVE_EVENTS;
    const bytes = admissionBytes + TURN_RESERVE_BYTES;
    this.assertHeadroom(events, bytes);
    this.turns.set(turnId, { events, bytes });
    this.reservedEvents += events;
    this.reservedBytes += bytes;
  }

  public reserveRecoveredTurn(turnId: string): void {
    if (this.turns.has(turnId)) return;
    this.assertHeadroom(TURN_RESERVE_EVENTS, TURN_RESERVE_BYTES);
    this.turns.set(turnId, { events: TURN_RESERVE_EVENTS, bytes: TURN_RESERVE_BYTES });
    this.reservedEvents += TURN_RESERVE_EVENTS;
    this.reservedBytes += TURN_RESERVE_BYTES;
  }

  public hasTurn(turnId: string): boolean {
    return this.turns.has(turnId);
  }

  public releaseTurn(turnId: string): void {
    const reservation = this.turns.get(turnId);
    if (reservation === undefined) return;
    this.reservedEvents -= reservation.events;
    this.reservedBytes -= reservation.bytes;
    this.turns.delete(turnId);
  }

  /** Returns false only for advisory telemetry that must yield to durable terminal recovery. */
  public admit(turnId: string, type: RoomEventType, eventBytes: number): boolean {
    const reservation = this.turns.get(turnId);
    if (reservation !== undefined && RESERVED_EVENT_TYPES.has(type)) {
      if (reservation.events < 1 || reservation.bytes < eventBytes) {
        throw new Error(`room turn ${turnId} exhausted its durable terminal reservation`);
      }
      this.assertPhysicalHeadroom(1, eventBytes);
      reservation.events -= 1;
      reservation.bytes -= eventBytes;
      this.reservedEvents -= 1;
      this.reservedBytes -= eventBytes;
      this.events += 1;
      this.bytes += eventBytes;
      return true;
    }

    if (!this.hasHeadroom(1, eventBytes)) {
      if (ADVISORY_EVENT_TYPES.has(type)) return false;
      throw new Error("room journal capacity is reserved for durable lane completion");
    }
    this.events += 1;
    this.bytes += eventBytes;
    return true;
  }

  private assertHeadroom(events: number, bytes: number): void {
    if (!this.hasHeadroom(events, bytes)) {
      throw new Error("room journal has no capacity for another durable turn");
    }
  }

  private hasHeadroom(events: number, bytes: number): boolean {
    return (
      this.events + this.reservedEvents + events <= MAX_ROOM_JOURNAL_EVENTS &&
      this.bytes + this.reservedBytes + bytes <= MAX_ROOM_JOURNAL_BYTES
    );
  }

  private assertPhysicalHeadroom(events: number, bytes: number): void {
    if (
      this.events + events > MAX_ROOM_JOURNAL_EVENTS ||
      this.bytes + bytes > MAX_ROOM_JOURNAL_BYTES
    ) {
      throw new Error("room journal exceeds its hard durable capacity");
    }
  }
}

export function assertRoomJournalCapacity(
  events: readonly RoomEvent[],
  limits: Readonly<{ maxEvents?: number; maxBytes?: number }> = {},
): void {
  const maxEvents = limits.maxEvents ?? MAX_ROOM_JOURNAL_EVENTS;
  const maxBytes = limits.maxBytes ?? MAX_ROOM_JOURNAL_BYTES;
  if (events.length > maxEvents) throw new Error(`room journal exceeds ${maxEvents} events`);
  const bytes = events.reduce((total, event) => total + roomEventBytes(event), 0);
  if (bytes > maxBytes) throw new Error(`room journal exceeds ${maxBytes} bytes`);
}

export async function applyCapacityCheckedRecovery(
  input: Readonly<{
    journal: readonly RoomEvent[];
    appended: readonly RoomEvent[];
    persistSession?: () => Promise<void>;
    appendEvent: (event: RoomEvent) => Promise<void>;
    limits?: Readonly<{ maxEvents?: number; maxBytes?: number }>;
  }>,
): Promise<void> {
  assertRoomJournalCapacity(input.journal, input.limits);
  await input.persistSession?.();
  for (const event of input.appended) await input.appendEvent(event);
}
