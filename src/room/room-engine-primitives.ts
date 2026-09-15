/**
 * @file src/room/room-engine-primitives.ts
 * @purpose Owns pure identity, payload, chunking, paging, cancel-hook and failure helpers used by the room scheduler.
 * @exports roomEventBytes, ROOM_TEXT_JSON_BUDGET, boundRoomEventText, assertRoomEventTextFits, safeRoomFailure, laneId, streamId, lanePayload, hopIdFor, splitUtf8Chunks, emitLaneChunks, LaneChunkCursor, seekAfterEventSeq, pageRoomResync, RoomResyncCost, readRoomResyncCost, resetRoomResyncCost, fireLaneCancel
 * @depends ../chat/types, ../shared/render-escape, ./room-engine-contract, ./room-journal
 */
import type { AgentName } from "../chat/types.js";
import { escapeUntrusted } from "../shared/render-escape.js";
import {
  MAX_RESYNC_PAGE_BYTES,
  MAX_RESYNC_PAGE_EVENTS,
  type RoomEvent,
  type RoomLane,
  type RoomResyncPage,
  roomLaneIdentity,
} from "./room-engine-contract.js";
import type { RecoveredRoomLane } from "./room-journal.js";

export function roomEventBytes(event: RoomEvent): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8") + 1;
}

// Keep enough serialized space for the protocol envelope, lane identity, and
// future bounded metadata. Measuring JSON.stringify(text), rather than JS
// length or raw UTF-8 alone, also accounts for control-character escaping.
export const ROOM_TEXT_JSON_BUDGET: number = 224 * 1024;
const ROOM_TEXT_TRUNCATION_MARKER = "\n\n[response truncated to fit the room journal]";

export function assertRoomEventTextFits(text: string): void {
  if (serializedTextBytes(text) > ROOM_TEXT_JSON_BUDGET) {
    throw new Error("room message is too large for the durable event journal");
  }
}

export function boundRoomEventText(text: string): string {
  if (serializedTextBytes(text) <= ROOM_TEXT_JSON_BUDGET) return text;
  const markerBytes = serializedTextBytes(ROOM_TEXT_TRUNCATION_MARKER) - 2;
  const contentBudget = ROOM_TEXT_JSON_BUDGET - markerBytes;
  const bounded: string[] = [];
  let serializedBytes = 2; // JSON string's opening and closing quotes.
  for (const character of text) {
    const characterBytes = serializedTextBytes(character) - 2;
    if (serializedBytes + characterBytes > contentBudget) break;
    bounded.push(character);
    serializedBytes += characterBytes;
  }
  return bounded.join("") + ROOM_TEXT_TRUNCATION_MARKER;
}

function serializedTextBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), "utf8");
}

export function safeRoomFailure(value: unknown): string {
  const escaped = escapeUntrusted(value, { maxLen: 1_024 });
  return escaped.length > 0 ? escaped : "room lane failed";
}

export function laneId(
  lane: Pick<RecoveredRoomLane, "agent" | "turnId" | "hopIndex" | "parentMessageId">,
): string {
  return roomLaneIdentity(lane).laneId;
}

export function streamId(
  lane: Pick<RecoveredRoomLane, "agent" | "turnId" | "hopIndex" | "parentMessageId">,
): string {
  return roomLaneIdentity(lane).streamId;
}

export function lanePayload(
  lane: RecoveredRoomLane,
  extra: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    agent: lane.agent,
    laneId: laneId(lane),
    text: lane.text,
    origin: lane.origin,
    hopIndex: lane.hopIndex,
    ...(lane.replyTo === undefined ? {} : { replyTo: lane.replyTo }),
    ...(lane.fromAgent === undefined ? {} : { fromAgent: lane.fromAgent }),
    ...(lane.parentMessageId === undefined ? {} : { parentMessageId: lane.parentMessageId }),
    ...(lane.hopId === undefined ? {} : { hopId: lane.hopId }),
    ...(lane.expectedMessageId === undefined ? {} : { expectedMessageId: lane.expectedMessageId }),
    ...extra,
  };
}

export function hopIdFor(
  lane: Pick<RoomLane, "turnId" | "agent" | "hopIndex">,
  parentMessageId: string,
  toAgent: AgentName,
): string {
  return `hop:${lane.turnId}:${parentMessageId}:${lane.agent}:${toAgent}:${String(lane.hopIndex + 1)}`;
}

/**
 * ASTRA-006 — THE COST OF A RESYNC IS THE PAGE, NOT THE ROOM'S HISTORY.
 *
 * The published prefix of a room journal is an append-only run that ASCENDS by `eventSeq`. Strict
 * ascent is all a seek requires; the two write paths enforce something stronger than that —
 * contiguity. `RoomEngine.emit` mints `eventSeq: String(nextEventCounter)` and advances the counter
 * only on an ADMITTED event (`room-engine.ts:549,565,577`), and a journal read back off disk is
 * refused unless every step is `previous + 1n` — `validateJournalEvent` throws "corrupt room journal
 * sequence" otherwise (`room-journal.ts:306`). THOSE TWO ARE THE GUARD on the order this seek assumes.
 * It is a durable invariant established where the journal is written, and nothing a page can re-derive
 * after the fact without the full scan this change exists to remove.
 *
 * So the cursor is found by BINARY SEARCH (`ceil(log2(n))` probes) instead of by walking the history
 * in front of it, which is what a terminal reconnecting to a long room used to pay 391 times over:
 * page 391 rescanned 100,000 events to find its 256. Measured on this tree (RS lane, 2026-09-07),
 * paging the whole 100,000-event cap took 2,223 ms before and 206 ms after; what remains is linear in
 * the events DELIVERED (one `JSON.stringify` each for the page's byte budget), not in the history.
 *
 * The instrument below is the pin, following RP's `lane_scans_on_this_thread` precedent: a wall-clock
 * budget in a test measures the box it runs on, so the invariant is asserted as a COUNT — events
 * visited, and distinct journal arrays seen (a caller that hands over a fresh `.slice` per page shows
 * up as one journal per page, which is the second half of this finding).
 */
export function seekAfterEventSeq(
  published: readonly RoomEvent[],
  publishedCount: number,
  afterEventSeq: string,
): number {
  if (
    !Number.isSafeInteger(publishedCount) ||
    publishedCount < 0 ||
    publishedCount > published.length
  )
    throw new Error("published room journal count must lie inside its own journal");
  noteResyncJournal(published);
  const after = BigInt(afterEventSeq);
  let low = 0;
  let high = publishedCount;
  while (low < high) {
    const middle = low + ((high - low) >> 1);
    resyncEventsVisited += 1;
    if (BigInt(eventAt(published, middle).eventSeq) <= after) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * One bounded resync page out of the ALREADY-PUBLISHED prefix of a journal (the first
 * `publishedCount` entries — passed as a count so no caller has to copy the journal to hide its
 * unpublished tail): every event after `afterEventSeq`, cut at the page's event or byte budget, with
 * `hasMore` telling the caller to ask again. The first event over budget is still admitted when the
 * page is empty — a single event larger than the byte budget must not wedge the resync forever.
 *
 * Lifted out of RoomEngine.resyncPage (FL-146) because that file sat two lines under the 600-line hard
 * ceiling and a ratchet is answered by extraction. It reads nothing but its arguments, which is why it
 * belongs here rather than on the scheduler.
 */
export function pageRoomResync(
  published: readonly RoomEvent[],
  publishedCount: number,
  afterEventSeq: string,
): RoomResyncPage {
  const start = seekAfterEventSeq(published, publishedCount, afterEventSeq);
  const events: RoomEvent[] = [];
  let bytes = 0;
  let previousSeq = BigInt(afterEventSeq);
  for (let index = start; index < publishedCount; index += 1) {
    const event = eventAt(published, index);
    resyncEventsVisited += 1;
    const eventSeq = BigInt(event.eventSeq);
    // WHAT THIS CHECKS: the events this page DELIVERS ascend strictly, from the cursor onward, so a
    // page that IS returned can never replay or reorder inside itself. WHAT IT CANNOT CHECK: disorder
    // sitting BEFORE the index the seek landed on — the seek steps over it and this loop never sees
    // it. Measured on this tree (RS review r1, reproduced 2026-09-07): published [1,5,2,3,4,6] with
    // cursor "4" returns [6] and throws nothing, where the old full scan returned [5,6]. No seek can
    // see that without the walk this change removed, which is why the order is guarded at the two
    // write paths above and only its consequence is checked here, at one comparison per event.
    if (eventSeq <= previousSeq) throw new Error("published room journal is out of sequence order");
    previousSeq = eventSeq;
    const eventBytes = roomEventBytes(event);
    if (
      events.length >= MAX_RESYNC_PAGE_EVENTS ||
      (events.length > 0 && bytes + eventBytes > MAX_RESYNC_PAGE_BYTES)
    ) {
      return { events, hasMore: true };
    }
    events.push(event);
    bytes += eventBytes;
  }
  return { events, hasMore: false };
}

function eventAt(published: readonly RoomEvent[], index: number): RoomEvent {
  const event = published[index];
  if (event === undefined) throw new Error("published room journal prefix is missing an event");
  return event;
}

/** What one resync cost, in work rather than in wall-clock. Test instrument; see the note above. */
export interface RoomResyncCost {
  /** Events the seek probed plus events the page examined, since the last reset. */
  readonly eventsVisited: number;
  /** DISTINCT journal arrays handed to the seek since the last reset — one per copy a caller makes. */
  readonly journalsSeen: number;
}

let resyncEventsVisited = 0;
let resyncJournalsSeen = 0;
let resyncJournals = new WeakSet<object>();

function noteResyncJournal(published: readonly RoomEvent[]): void {
  if (resyncJournals.has(published)) return;
  resyncJournals.add(published);
  resyncJournalsSeen += 1;
}

export function readRoomResyncCost(): RoomResyncCost {
  return { eventsVisited: resyncEventsVisited, journalsSeen: resyncJournalsSeen };
}

export function resetRoomResyncCost(): void {
  resyncEventsVisited = 0;
  resyncJournalsSeen = 0;
  // WeakSet has no clear(), and keeping the old one would report zero journals for a caller that
  // hands over the same array again after a reset.
  resyncJournals = new WeakSet<object>();
}

/**
 * FL-146 — A CANCEL THAT THROWS MUST NOT BE SILENT, AND MUST NOT PARK THE PANIC BUTTON.
 *
 * The scheduler fires the host's cancel hook and deliberately does NOT await it: on an ACP lane that
 * hook drops a held bridge connection through a close ladder that can spend half a second per lane, and
 * three of those behind the operator's Esc is how a stop key stops feeling like one.
 *
 * What was never deliberate is losing the failure. The call site was `void hook(agent)` — an unhandled
 * rejection — so a cancel that THREW was indistinguishable from one that worked, which is half of why
 * four separate reviews each had to rediscover that this path was broken. `report` turns the failure
 * into an event the operator can see; `onReportFailure` catches the case where even reporting fails (a
 * journal with no capacity left), so nothing is swallowed at either level.
 */
export function fireLaneCancel(input: {
  readonly hook: ((agent: AgentName) => Promise<void> | void) | undefined;
  readonly agent: AgentName;
  readonly report: (message: string) => void;
  readonly onReportFailure: (cause: unknown) => void;
}): void {
  const { hook, agent, report, onReportFailure } = input;
  if (hook === undefined) return;
  // The async wrapper is what makes a SYNCHRONOUS throw inside the hook land in the same catch as a
  // rejection — the two are the same failure to the operator and must not need two code paths.
  void (async () => hook(agent))()
    .catch((cause: unknown) => {
      // `cause.message` first: safeRoomFailure escapes an Error OBJECT to "{}" (nothing on Error is
      // enumerable), which would report the failure and lose the only part of it worth reading.
      report(
        `room cancel of ${agent} failed: ${safeRoomFailure(cause instanceof Error ? cause.message : cause)}`,
      );
    })
    .catch(onReportFailure);
}

/**
 * The lane's streaming cursor: the two counters a chunk run advances, and the gate that stops it.
 * Mutated in place because they belong to the ACTIVE lane the scheduler holds, not to this call.
 */
export interface LaneChunkCursor {
  readonly acceptingChunks: boolean;
  chunkIndex: number;
  streamSeq: bigint;
}

/**
 * Splits `text` and emits one `lane.chunk` payload per piece, advancing the lane's stream cursor only
 * for the pieces the journal actually ADMITTED — a chunk refused by capacity must not consume a
 * sequence number, or the terminal sees a stream gap that never closes.
 *
 * Lifted out of RoomEngine.emitChunks for the same reason `pageRoomResync` above it was: that file
 * sat one line under the 600-line hard ceiling, and a ratchet is answered by extraction. It reads
 * nothing off the scheduler but the lane it is handed and the emit hook, which is why it fits here.
 *
 * @param lane - the active lane's identity and its mutable stream cursor
 * @param text - the raw provider text for this delivery
 * @param maxBytes - the per-chunk UTF-8 byte budget
 * @param emit - the journal hook; false means the chunk was refused and the cursor must not advance
 */
export function emitLaneChunks(
  lane: RecoveredRoomLane & LaneChunkCursor,
  text: string,
  maxBytes: number,
  emit: (payload: Readonly<Record<string, unknown>>) => boolean,
): void {
  if (!lane.acceptingChunks) return;
  for (const chunk of splitUtf8Chunks(text, maxBytes)) {
    const emitted = emit({
      agent: lane.agent,
      laneId: laneId(lane),
      streamId: streamId(lane),
      streamSeq: String(lane.streamSeq),
      chunkIndex: lane.chunkIndex,
      channel: "stdout",
      text: chunk,
    });
    if (!emitted) continue;
    lane.streamSeq += 1n;
    lane.chunkIndex += 1;
  }
}

export function splitUtf8Chunks(text: string, maxBytes: number): readonly string[] {
  if (text.length === 0) return [];
  const chunks: string[] = [];
  let current = "";
  for (const character of text) {
    const candidate = current + character;
    if (current.length > 0 && Buffer.byteLength(candidate, "utf8") > maxBytes) {
      chunks.push(current);
      current = character;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
