/**
 * @file src/room/room-engine.ts
 * @purpose Schedule room lanes and emit their ordered protocol events.
 * @exports RoomEngine plus re-exported room engine contracts.
 * @depends ../chat/types, ../shared/room-notice, ./room-engine-contract, ./room-journal, ./room-notice-gate
 * @size-justified: Cohesive scheduler state machine keeps ordering invariants local.
 */
import { mintMessageId } from "../chat/message-id.js";
import type { AgentName } from "../chat/types.js";
import type { RoomNotice } from "../shared/room-notice.js";
import { RoomJournalCapacity } from "./room-engine-capacity.js";
import {
  MAX_RESYNC_PAGE_BYTES,
  MAX_RESYNC_PAGE_EVENTS,
  MAX_ROOM_EVENT_BYTES,
  MAX_ROOM_JOURNAL_BYTES,
  MAX_ROOM_JOURNAL_EVENTS,
  type RoomCancelScope,
  type RoomEngineOptions,
  type RoomEvent,
  type RoomEventType,
  type RoomLane,
  type RoomLaneResult,
  type RoomResyncPage,
  roomLaneIdentity,
} from "./room-engine-contract.js";
import {
  emitLaneChunks,
  fireLaneCancel,
  hopIdFor,
  laneId,
  lanePayload,
  pageRoomResync,
  roomEventBytes,
  safeRoomFailure,
  seekAfterEventSeq,
  streamId,
} from "./room-engine-primitives.js";
import { isAllowedRoomHandoff } from "./room-handoff.js";
import {
  type RecoveredRoomLane,
  type RecoveredRoomPermission,
  type RoomJournalProjection,
  projectRoomJournal,
} from "./room-journal.js";
import { RoomNoticeGate } from "./room-notice-gate.js";
import { validateRoomEvent } from "./room-protocol.js";

export {
  MAX_RESYNC_PAGE_BYTES,
  MAX_RESYNC_PAGE_EVENTS,
  MAX_ROOM_EVENT_BYTES,
  MAX_ROOM_JOURNAL_BYTES,
  MAX_ROOM_JOURNAL_EVENTS,
  roomLaneIdentity,
};
export type {
  RoomCancelScope,
  RoomEngineOptions,
  RoomEvent,
  RoomEventType,
  RoomLane,
  RoomLaneResult,
  RoomResyncPage,
};

type QueuedLane = RecoveredRoomLane;

interface ActiveLane extends QueuedLane {
  readonly controller: AbortController;
  acceptingChunks: boolean;
  chunkIndex: number;
  streamSeq: bigint;
}

const AGENTS: readonly AgentName[] = ["claude", "codex", "gemini"];
const MAX_CHUNK_BYTES = 32 * 1024;
const MAX_ROOM_HOPS = 1;

/**
 * The protocol-only room scheduler. It owns one FIFO per agent, one monotonic
 * event sequence, and hop-budget admission. Carrier work is injected behind a
 * narrow seam; release startup supplies only the real headless carrier runner.
 */
export class RoomEngine {
  private readonly queues = new Map<AgentName, QueuedLane[]>(AGENTS.map((agent) => [agent, []]));
  private readonly active = new Map<AgentName, ActiveLane>();
  private readonly journal: RoomEvent[] = [];
  private readonly eventIds = new Set<string>();
  private capacity = new RoomJournalCapacity();
  private publishedEvents = 0;
  private readonly pendingByTurn = new Map<string, number>();
  private paused = false;
  private quiescing = false;
  private sessionId: string;
  private eventCounter = 0n;
  private eventIdCounter = 0n;
  private eventWrites: Promise<void> = Promise.resolve();
  private eventFailure: unknown;
  private readonly notices = new RoomNoticeGate();

  public constructor(private readonly options: RoomEngineOptions) {
    this.sessionId = options.sessionId ?? "room-unbound";
  }

  /** Binds the protocol stream to the persisted session before first admission. */
  public bindSession(sessionId: string): void {
    if (!/^chat-/u.test(sessionId)) throw new Error("room requires a persisted chat session id");
    if (this.journal.length > 0)
      throw new Error("room session must be bound before journal rehydration");
    this.sessionId = sessionId;
  }

  public async submit(input: {
    readonly turnId: string;
    readonly agents: readonly AgentName[];
    readonly text: string;
    readonly messageId: string;
    readonly ledgerSeq: string;
  }): Promise<void> {
    if (this.quiescing) throw new Error("room is shutting down");
    if (!this.capacity.hasTurn(input.turnId))
      throw new Error("room turn capacity must be reserved before durable submission");
    try {
      this.emit(input.turnId, "turn.accepted", {
        agents: input.agents,
        text: input.text,
        messageId: input.messageId,
        ledgerSeq: input.ledgerSeq,
      });
      this.emit(input.turnId, "route.resolved", { agents: input.agents });
      for (const agent of input.agents)
        this.enqueue(
          {
            agent,
            turnId: input.turnId,
            text: input.text,
            hopIndex: 0,
            origin: "operator",
            parentMessageId: input.messageId,
          },
          false,
        );
      await this.flushEvents();
    } catch (error) {
      this.capacity.releaseTurn(input.turnId);
      this.stopAdmission();
      throw error;
    }
    for (const agent of input.agents) this.pump(agent);
  }

  /** Must succeed before the host writes the operator message or increments durable room state. */
  public reserveTurn(turnId: string, agentCount: number): void {
    this.capacity.reserveTurn(turnId, agentCount);
  }

  public releaseTurnReservation(turnId: string): void {
    this.capacity.releaseTurn(turnId);
  }

  public async pause(): Promise<void> {
    if (this.paused) return;
    this.paused = true;
    this.emit("room-control", "room.paused", {});
    for (const lane of this.active.values()) {
      this.emit(lane.turnId, "lane.cancelling", { agent: lane.agent, laneId: laneId(lane) });
      lane.controller.abort();
      this.fireCancel(lane.turnId, lane.agent);
    }
    await this.flushEvents();
  }

  public async resume(): Promise<void> {
    if (!this.paused) return;
    this.paused = false;
    this.emit("room-control", "room.resumed", {});
    await this.flushEvents();
    for (const agent of AGENTS) this.pump(agent);
    // Keep the response pending until a pumped lane.started is append-visible.
    await this.flushEvents();
  }

  public async cancel(input: {
    readonly scope: RoomCancelScope;
    readonly agent?: AgentName;
  }): Promise<void> {
    if (input.scope === "agent" && input.agent === undefined)
      throw new Error("agent cancellation requires an agent");
    const turnId = input.scope === "latest" ? this.latestNonterminalTurn() : undefined;
    for (const target of AGENTS) this.cancelTarget(target, input, turnId);
    await this.flushEvents();
  }

  public events(): readonly RoomEvent[] {
    return this.journal;
  }

  public rehydrate(events: readonly RoomEvent[]): RoomJournalProjection {
    if (this.journal.length > 0)
      throw new Error("room journal can only be rehydrated before admission");
    const capacity = new RoomJournalCapacity();
    capacity.rehydrate(events);
    const projection = projectRoomJournal(events, this.sessionId);
    this.journal.push(...events);
    for (const event of events) this.eventIds.add(event.eventId);
    this.capacity = capacity;
    this.publishedEvents = events.length;
    this.paused = projection.paused;
    this.notices.rehydrate(events);
    this.eventCounter = projection.lastSequence;
    this.eventIdCounter = projection.lastSequence;
    this.restoreLanes(projection.lanes, projection.terminal);
    for (const turnId of this.pendingByTurn.keys()) this.capacity.reserveRecoveredTurn(turnId);
    return projection;
  }

  public async invalidateRecoveredPermissions(
    permissions: Iterable<RecoveredRoomPermission>,
  ): Promise<void> {
    for (const permission of permissions)
      this.emit(permission.turnId, "permission.resolved", {
        askId: permission.askId,
        agent: permission.agent,
        outcome: "invalidated",
      });
    await this.flushEvents();
  }

  public async invalidateRecoveredRunningLanes(
    lanes: Iterable<RecoveredRoomLane>,
    terminal: ReadonlySet<string>,
  ): Promise<void> {
    for (const lane of lanes) {
      const recoveredLaneId = laneId(lane);
      if (lane.streamId === undefined || terminal.has(recoveredLaneId)) continue;
      this.emit(lane.turnId, "lane.failed", {
        agent: lane.agent,
        laneId: recoveredLaneId,
        streamId: lane.streamId,
        error: "room lane interrupted by host restart",
      });
      this.settleTurn(lane.turnId);
    }
    await this.flushEvents();
  }

  /** Starts recovered queues only after the transport has answered load and published readiness. */
  public async activateRecovered(): Promise<void> {
    if (this.paused) return;
    for (const agent of AGENTS) this.pump(agent);
    await this.flushEvents();
  }

  private restoreLanes(
    lanes: ReadonlyMap<string, QueuedLane>,
    terminal: ReadonlySet<string>,
  ): void {
    for (const lane of lanes.values()) {
      if (terminal.has(laneId(lane))) continue;
      this.pendingByTurn.set(lane.turnId, (this.pendingByTurn.get(lane.turnId) ?? 0) + 1);
      if (lane.streamId !== undefined) continue;
      this.queues.get(lane.agent)?.push(lane);
    }
  }

  public notify(
    turnId: string,
    type: RoomEventType,
    payload: Readonly<Record<string, unknown>>,
  ): void {
    this.emit(turnId, type, payload);
  }

  /**
   * Announces one non-fatal condition — once per cause for the life of this session, counting the
   * repeats it declines to draw. A second row for something the operator has already been told
   * about is noise, and noise is what makes the FIRST row get ignored.
   */
  public notice(turnId: string, notice: RoomNotice): void {
    const payload = this.notices.admit(notice);
    if (payload !== undefined) this.emit(turnId, "room.notice", payload);
  }

  public resync(afterEventSeq: string): readonly RoomEvent[] {
    const start = seekAfterEventSeq(this.journal, this.publishedEvents, afterEventSeq);
    return this.journal.slice(start, this.publishedEvents);
  }

  public resyncPage(afterEventSeq: string): RoomResyncPage {
    return pageRoomResync(this.journal, this.publishedEvents, afterEventSeq);
  }

  public async whenIdle(): Promise<void> {
    await this.flushEvents();
    while (this.active.size > 0 || [...this.queues.values()].some((queue) => queue.length > 0)) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await this.flushEvents();
  }

  /** Stops admission and active work without mutating durable queued lanes. */
  public async quiesce(): Promise<void> {
    this.quiescing = true;
    for (const lane of this.active.values()) {
      this.emit(lane.turnId, "lane.cancelling", { agent: lane.agent, laneId: laneId(lane) });
      lane.controller.abort();
      this.fireCancel(lane.turnId, lane.agent);
    }
    await this.flushEvents();
    while (this.active.size > 0) await new Promise((resolve) => setTimeout(resolve, 0));
    await this.flushEvents();
  }

  private enqueue(lane: QueuedLane, activate = true): void {
    const queued =
      lane.expectedMessageId === undefined
        ? { ...lane, expectedMessageId: mintMessageId(lane.agent) }
        : lane;
    this.pendingByTurn.set(queued.turnId, (this.pendingByTurn.get(queued.turnId) ?? 0) + 1);
    const queue = this.queues.get(queued.agent);
    if (queue === undefined) throw new Error(`unsupported room agent: ${queued.agent}`);
    const busy = this.paused || this.active.has(queued.agent) || queue.length > 0;
    queue.push(queued);
    this.emit(queued.turnId, "lane.queued", lanePayload(queued, { paused: this.paused, busy }));
    if (activate) this.pump(queued.agent);
  }

  private pump(agent: AgentName): void {
    if (this.quiescing || this.paused || this.active.has(agent)) return;
    const lane = this.queues.get(agent)?.shift();
    if (lane === undefined) return;
    const active: ActiveLane = {
      ...lane,
      controller: new AbortController(),
      acceptingChunks: true,
      chunkIndex: lane.nextChunkIndex ?? 0,
      streamSeq: BigInt(lane.nextStreamSeq ?? "1"),
    };
    this.active.set(agent, active);
    this.emit(lane.turnId, "lane.started", lanePayload(lane, { streamId: streamId(lane) }));
    void this.run(active).catch((error: unknown) => {
      this.eventFailure ??= error;
    });
  }

  private async run(lane: ActiveLane): Promise<void> {
    try {
      const result = await this.options.runLane({
        ...lane,
        signal: lane.controller.signal,
        onChunk: (chunk) =>
          emitLaneChunks(lane, chunk, MAX_CHUNK_BYTES, (payload) =>
            this.emit(lane.turnId, "lane.chunk", payload),
          ),
      });
      lane.acceptingChunks = false;
      await this.handleLaneResult(lane, result);
    } catch (error) {
      lane.acceptingChunks = false;
      this.emitFailedLane(lane, error);
    } finally {
      lane.acceptingChunks = false;
      this.active.delete(lane.agent);
      this.settleTurn(lane.turnId);
      await this.flushEvents();
      this.pump(lane.agent);
    }
  }

  private async handleLaneResult(lane: ActiveLane, result: RoomLaneResult): Promise<void> {
    const terminal =
      result.status === "cancelled"
        ? "lane.cancelled"
        : result.status === "completed"
          ? "lane.completed"
          : "lane.failed";
    if (
      terminal === "lane.completed" &&
      result.committed !== false &&
      result.messageId !== undefined &&
      result.ledgerSeq !== undefined
    ) {
      this.emit(lane.turnId, "message.committed", {
        agent: lane.agent,
        laneId: laneId(lane),
        messageId: result.messageId,
        ledgerSeq: result.ledgerSeq,
        text: result.text,
        origin: lane.origin,
        ...(lane.replyTo === undefined ? {} : { replyTo: lane.replyTo }),
        hopIndex: lane.hopIndex,
      });
      await this.flushEvents();
      await this.maybeDispatchHop(lane, result);
    }
    this.emit(lane.turnId, terminal, {
      agent: lane.agent,
      laneId: laneId(lane),
      streamId: streamId(lane),
      ...(terminal === "lane.failed" && result.error !== undefined
        ? { error: safeRoomFailure(result.error) }
        : {}),
    });
  }

  private emitFailedLane(lane: ActiveLane, error: unknown): void {
    this.emit(lane.turnId, "lane.failed", {
      agent: lane.agent,
      laneId: laneId(lane),
      streamId: streamId(lane),
      error: safeRoomFailure(error instanceof Error ? error.message : String(error)),
    });
  }

  private async maybeDispatchHop(lane: ActiveLane, result: RoomLaneResult): Promise<void> {
    if (
      result.status !== "completed" ||
      result.committed === false ||
      result.messageId === undefined
    )
      return;
    const handoff = result.handoff;
    if (handoff === undefined || !isAllowedRoomHandoff(lane.agent, handoff)) return;
    const { target, text } = handoff;
    if (lane.hopIndex >= MAX_ROOM_HOPS) {
      this.emit(lane.turnId, "hop.blocked", {
        fromAgent: lane.agent,
        toAgent: target,
        parentMessageId: result.messageId,
        hopIndex: lane.hopIndex + 1,
        maxHop: MAX_ROOM_HOPS,
        hopId: hopIdFor(lane, result.messageId, target),
        text,
      });
      await this.flushEvents();
      return;
    }
    this.emit(lane.turnId, "hop.dispatched", {
      fromAgent: lane.agent,
      toAgent: target,
      parentMessageId: result.messageId,
      hopIndex: 1,
      maxHop: MAX_ROOM_HOPS,
      hopId: hopIdFor(lane, result.messageId, target),
      text,
    });
    this.enqueue(
      {
        agent: target,
        turnId: lane.turnId,
        text,
        hopIndex: lane.hopIndex + 1,
        origin: "agent",
        replyTo: result.messageId,
        fromAgent: lane.agent,
        parentMessageId: result.messageId,
        hopId: hopIdFor(lane, result.messageId, target),
      },
      false,
    );
    await this.flushEvents();
    this.pump(target);
  }

  private settleTurn(turnId: string): void {
    const remaining = (this.pendingByTurn.get(turnId) ?? 1) - 1;
    if (remaining > 0) {
      this.pendingByTurn.set(turnId, remaining);
      return;
    }
    this.pendingByTurn.delete(turnId);
    this.emit(turnId, "turn.completed", {});
    this.capacity.releaseTurn(turnId);
  }

  /** FL-146: every cancel of an ACTIVE lane goes through here — see fireLaneCancel for why the hook is
   *  still not awaited and why its failure is no longer allowed to vanish. */
  private fireCancel(turnId: string, agent: AgentName): void {
    fireLaneCancel({
      hook: this.options.onCancel,
      agent,
      report: (message) => {
        this.emit(turnId, "backend.failed", { message });
      },
      // A journal with no capacity left is the one way reporting can itself fail; it surfaces at the
      // next flushEvents rather than becoming an unhandled rejection, exactly as a lane run's does.
      onReportFailure: (cause) => {
        this.eventFailure ??= cause;
      },
    });
  }

  private cancelTarget(
    target: AgentName,
    input: { readonly scope: RoomCancelScope; readonly agent?: AgentName },
    turnId: string | undefined,
  ): void {
    if (input.scope === "agent" && input.agent !== target) return;
    const active = this.active.get(target);
    if (active !== undefined && (turnId === undefined || active.turnId === turnId)) {
      this.emit(active.turnId, "lane.cancelling", { agent: target, laneId: laneId(active) });
      active.controller.abort();
      this.fireCancel(active.turnId, target);
    }
    const queue = this.queues.get(target) ?? [];
    if (input.scope === "agent") {
      for (const lane of queue) this.cancelQueuedLane(target, lane);
      this.queues.set(target, []);
      return;
    }
    const retained: QueuedLane[] = [];
    for (const lane of queue) {
      if (turnId !== undefined && lane.turnId !== turnId) {
        retained.push(lane);
        continue;
      }
      this.cancelQueuedLane(target, lane);
    }
    this.queues.set(target, retained);
  }

  private cancelQueuedLane(target: AgentName, lane: QueuedLane): void {
    this.emit(lane.turnId, "lane.cancelled", {
      agent: target,
      laneId: laneId(lane),
      streamId: streamId(lane),
      queued: true,
    });
    this.settleTurn(lane.turnId);
  }

  private latestNonterminalTurn(): string | undefined {
    let latest: string | undefined;
    for (const turnId of this.pendingByTurn.keys()) latest = turnId;
    return latest;
  }

  private stopAdmission(): void {
    for (const agent of AGENTS) {
      this.queues.set(agent, []);
      const active = this.active.get(agent);
      if (active !== undefined) active.controller.abort();
    }
    this.pendingByTurn.clear();
  }

  private emit(
    turnId: string,
    type: RoomEventType,
    payload: Readonly<Record<string, unknown>>,
  ): boolean {
    const nextEventCounter = this.eventCounter + 1n;
    let nextEventIdCounter = this.eventIdCounter;
    let nextEventId: string;
    do {
      nextEventIdCounter += 1n;
      nextEventId = `room-event-${nextEventIdCounter}`;
    } while (this.eventIds.has(nextEventId));
    const event: RoomEvent = {
      protocol: "zer0.room",
      version: 1,
      sessionId: this.sessionId,
      eventSeq: String(nextEventCounter),
      eventId: nextEventId,
      turnId,
      occurredAt: new Date().toISOString(),
      type,
      payload,
    };
    validateRoomEvent(event);
    const eventBytes = roomEventBytes(event);
    if (eventBytes > MAX_ROOM_EVENT_BYTES)
      throw new Error(`room event exceeds ${MAX_ROOM_EVENT_BYTES} bytes`);
    if (!this.capacity.admit(turnId, type, eventBytes)) return false;
    this.eventCounter = nextEventCounter;
    this.eventIdCounter = nextEventIdCounter;
    this.eventIds.add(event.eventId);
    this.journal.push(event);
    const publishedLength = this.journal.length;
    if (this.options.onEvent === undefined) {
      this.publishedEvents = publishedLength;
      return true;
    }
    this.eventWrites = this.eventWrites.then(async () => {
      await this.options.onEvent?.(event);
      this.publishedEvents = publishedLength;
    });
    void this.eventWrites.catch(() => undefined);
    return true;
  }

  private async flushEvents(): Promise<void> {
    await this.eventWrites;
    if (this.eventFailure !== undefined) throw this.eventFailure;
  }
}
