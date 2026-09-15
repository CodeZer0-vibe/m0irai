/**
 * ASTRA-006 — what a paged resync COSTS, pinned as a count of work and never as a clock.
 *
 * The audit measured the defect in milliseconds (100,000 events, median 1.95 s for the paging alone),
 * and milliseconds are exactly the assertion this repo has been burned by: on a loaded box a budget
 * measures the box. So the invariant here is an operation count — RP's `lane_scans_on_this_thread`
 * precedent — and the wall-clock table lives in the benchmark at the bottom, which asserts nothing.
 *
 * Two counts, because the finding has two halves: the events a resync VISITS (it used to walk the
 * whole history in front of every page) and the distinct journal arrays it is handed (the caller used
 * to hand over a fresh `.slice` of the journal per page).
 */
import { expect, it } from "vitest";
import { MAX_RESYNC_PAGE_EVENTS, type RoomEvent } from "./room-engine-contract.js";
import {
  pageRoomResync,
  readRoomResyncCost,
  resetRoomResyncCost,
} from "./room-engine-primitives.js";
import { RoomEngine } from "./room-engine.js";

const HISTORY_EVENTS = 8_000;
// ceil(log2(100_000)) is 17, so this covers the seek at the journal's own 100,000-event cap with room
// to spare, and it is small enough that a lost seek (a walk of the history) cannot hide under it.
const SEEK_PROBE_BUDGET = 32;

function pausedEvent(seq: number): RoomEvent {
  return {
    protocol: "zer0.room",
    version: 1,
    sessionId: "chat-resync-cost",
    eventSeq: String(seq),
    eventId: `room-event-${String(seq)}`,
    turnId: `turn-${String(seq)}`,
    occurredAt: "2026-01-01T00:00:00.000Z",
    type: seq % 2 === 0 ? "room.resumed" : "room.paused",
    payload: {},
  };
}

function journalOf(count: number): RoomEvent[] {
  return Array.from({ length: count }, (_unused, index) => pausedEvent(index + 1));
}

/** A journal that reports every index read made through it — the instrument for the pure function. */
function countingView(events: readonly RoomEvent[]): {
  readonly view: readonly RoomEvent[];
  reads: () => number;
} {
  let reads = 0;
  const view = new Proxy(events as RoomEvent[], {
    get(target, property, receiver): unknown {
      if (typeof property === "string" && /^[0-9]+$/u.test(property)) reads += 1;
      return Reflect.get(target, property, receiver) as unknown;
    },
  }) as readonly RoomEvent[];
  return { view, reads: () => reads };
}

function pageThrough(
  next: (cursor: string) => { events: readonly RoomEvent[]; hasMore: boolean },
): {
  readonly delivered: number;
  readonly pages: number;
  readonly lastSeq: string;
} {
  let cursor = "0";
  let delivered = 0;
  let pages = 0;
  for (;;) {
    const page = next(cursor);
    delivered += page.events.length;
    pages += 1;
    const last = page.events.at(-1)?.eventSeq;
    if (last !== undefined) cursor = last;
    if (!page.hasMore) return { delivered, pages, lastSeq: cursor };
    if (pages > HISTORY_EVENTS) throw new Error("paging did not terminate");
  }
}

it("pages a long journal without reading the history in front of each page", () => {
  const events = journalOf(HISTORY_EVENTS);
  const counted = countingView(events);

  const run = pageThrough((cursor) => pageRoomResync(counted.view, HISTORY_EVENTS, cursor));

  // Delivering nothing is cheap too, so the count only means something next to the whole journal
  // arriving, in order, in pages of the size the protocol declares.
  expect(run.delivered).toBe(HISTORY_EVENTS);
  expect(run.lastSeq).toBe(String(HISTORY_EVENTS));
  expect(run.pages).toBe(Math.ceil(HISTORY_EVENTS / MAX_RESYNC_PAGE_EVENTS));
  // The positive control for the instrument itself: a Proxy wired to nothing reads zero and every
  // bound below would hold on a function that never looked at the journal at all.
  expect(counted.reads()).toBeGreaterThan(0);
  expect(counted.reads()).toBeLessThanOrEqual(
    run.pages * (MAX_RESYNC_PAGE_EVENTS + SEEK_PROBE_BUDGET),
  );
});

it("the engine serves those pages off its own journal, never off a copy per page", () => {
  const engine = new RoomEngine({
    sessionId: "chat-resync-cost",
    runLane: async () => ({ text: "", status: "completed" as const }),
  });
  engine.rehydrate(journalOf(HISTORY_EVENTS));

  resetRoomResyncCost();
  const run = pageThrough((cursor) => engine.resyncPage(cursor));
  const cost = readRoomResyncCost();

  expect(run.delivered).toBe(HISTORY_EVENTS);
  expect(run.pages).toBe(Math.ceil(HISTORY_EVENTS / MAX_RESYNC_PAGE_EVENTS));
  expect(cost.eventsVisited).toBeGreaterThan(0);
  expect(cost.eventsVisited).toBeLessThanOrEqual(
    run.pages * (MAX_RESYNC_PAGE_EVENTS + SEEK_PROBE_BUDGET),
  );
  // ONE journal for the whole resync. A caller that slices the published prefix per page shows up
  // here as one journal per page, which is the half of ASTRA-006 the visit count cannot see.
  expect(cost.journalsSeen).toBe(1);
});

it("counts a fresh journal per call, so a caller that copies per page cannot read as one", () => {
  // The positive control for the journal counter: two arrays are two journals, and the same array
  // twice is one. Without this, `journalsSeen === 1` above could be a counter stuck at one.
  const events = journalOf(4);
  const copy = [...events];

  resetRoomResyncCost();
  pageRoomResync(events, events.length, "0");
  pageRoomResync(events, events.length, "2");
  expect(readRoomResyncCost().journalsSeen).toBe(1);

  pageRoomResync(copy, copy.length, "0");
  expect(readRoomResyncCost().journalsSeen).toBe(2);
});

it("the unpaged resync seeks to the cursor and returns the same tail it always did", () => {
  const engine = new RoomEngine({
    sessionId: "chat-resync-cost",
    runLane: async () => ({ text: "", status: "completed" as const }),
  });
  engine.rehydrate(journalOf(HISTORY_EVENTS));

  resetRoomResyncCost();
  const tail = engine.resync(String(HISTORY_EVENTS - 3));
  const cost = readRoomResyncCost();

  expect(tail.map((event) => event.eventSeq)).toEqual(["7998", "7999", "8000"]);
  expect(engine.resync("0")).toHaveLength(HISTORY_EVENTS);
  expect(engine.resync(String(HISTORY_EVENTS))).toEqual([]);
  expect(cost.eventsVisited).toBeLessThanOrEqual(SEEK_PROBE_BUDGET);
});

/**
 * The numbers a human compares, and it ASSERTS NOTHING — it prints. Run it with:
 * `RS_RESYNC_BENCH=1 npx vitest run src/room/room-engine-resync-cost.test.ts -t benchmark`
 */
const BENCH = process.env.RS_RESYNC_BENCH === "1";

it.runIf(BENCH)("benchmark: prints the paging cost table, asserts nothing", () => {
  console.log("events\tpages\tdelivered\tms\tvisited\tjournals");
  for (const size of [2_000, 8_000, 32_000, 100_000]) {
    const engine = new RoomEngine({
      sessionId: "chat-resync-cost",
      runLane: async () => ({ text: "", status: "completed" as const }),
    });
    engine.rehydrate(journalOf(size));
    resetRoomResyncCost();
    const started = process.hrtime.bigint();
    const run = pageThrough((cursor) => engine.resyncPage(cursor));
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    const cost = readRoomResyncCost();
    console.log(
      `${String(size)}\t${String(run.pages)}\t${String(run.delivered)}\t${elapsedMs.toFixed(2)}\t${String(cost.eventsVisited)}\t${String(cost.journalsSeen)}`,
    );
  }
});
