import { expect, it } from "vitest";
import {
  MAX_RESYNC_PAGE_BYTES,
  MAX_RESYNC_PAGE_EVENTS,
  type RoomEvent,
} from "./room-engine-contract.js";
import {
  ROOM_TEXT_JSON_BUDGET,
  assertRoomEventTextFits,
  boundRoomEventText,
  fireLaneCancel,
  pageRoomResync,
} from "./room-engine-primitives.js";

const TRUNCATION_MARKER = "[response truncated to fit the room journal]";

it.each([
  ["ASCII", "a".repeat(300 * 1024)],
  ["multi-byte Unicode", "😀".repeat(100 * 1024)],
  ["JSON-escaped controls", "\u0000".repeat(100 * 1024)],
])("bounds oversized %s text by serialized UTF-8 bytes without splitting Unicode", (_name, raw) => {
  expect(() => assertRoomEventTextFits(raw)).toThrow(
    "room message is too large for the durable event journal",
  );

  const bounded = boundRoomEventText(raw);

  expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBeLessThanOrEqual(
    ROOM_TEXT_JSON_BUDGET,
  );
  expect(bounded).toContain(TRUNCATION_MARKER);
  expect(hasUnpairedSurrogate(bounded)).toBe(false);
});

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function pagedEvent(seq: number, text = "x"): RoomEvent {
  return {
    protocol: "zer0.room",
    version: 1,
    sessionId: "chat-test",
    eventSeq: String(seq),
    eventId: `event-${String(seq)}`,
    turnId: "turn-1",
    occurredAt: "2026-01-01T00:00:00.000Z",
    type: "lane.chunk",
    payload: { text },
  };
}

it("pages a resync from after the requested sequence and reports when more is waiting", () => {
  const published = Array.from({ length: MAX_RESYNC_PAGE_EVENTS + 5 }, (_unused, index) =>
    pagedEvent(index + 1),
  );

  const first = pageRoomResync(published, published.length, "0");
  expect(first.events).toHaveLength(MAX_RESYNC_PAGE_EVENTS);
  expect(first.events[0]?.eventSeq).toBe("1");
  expect(first.hasMore).toBe(true);

  const rest = pageRoomResync(published, published.length, String(MAX_RESYNC_PAGE_EVENTS));
  expect(rest.events).toHaveLength(5);
  expect(rest.events[0]?.eventSeq).toBe(String(MAX_RESYNC_PAGE_EVENTS + 1));
  expect(rest.hasMore).toBe(false);
  expect(pageRoomResync(published, published.length, String(MAX_RESYNC_PAGE_EVENTS + 5))).toEqual({
    events: [],
    hasMore: false,
  });
});

it("pages only the published prefix and never the events behind it", () => {
  // The engine hands over its WHOLE journal plus the count that is durable so far, so this bound is
  // what keeps an unpublished tail off the wire: it used to be enforced by the caller's own copy.
  const published = Array.from({ length: 6 }, (_unused, index) => pagedEvent(index + 1));

  const page = pageRoomResync(published, 4, "0");

  expect(page.events.map((event) => event.eventSeq)).toEqual(["1", "2", "3", "4"]);
  expect(page.hasMore).toBe(false);
  expect(() => pageRoomResync(published, 7, "0")).toThrow(
    "published room journal count must lie inside its own journal",
  );
});

it("refuses a published prefix that is not in sequence order rather than paging it", () => {
  // A seek is only correct on ordered input, so disorder is a refusal, not a silently wrong page.
  const disordered = [pagedEvent(1), pagedEvent(3), pagedEvent(2)];

  expect(() => pageRoomResync(disordered, disordered.length, "0")).toThrow(
    "published room journal is out of sequence order",
  );
});

it("admits a single over-budget event rather than wedging the resync on it forever", () => {
  // An event larger than the whole byte budget can only be delivered by being the page — refusing it
  // would leave the terminal permanently one event behind with no way to advance.
  const huge = pagedEvent(1, "y".repeat(MAX_RESYNC_PAGE_BYTES + 1));

  const oversized = [huge, pagedEvent(2)];

  const page = pageRoomResync(oversized, oversized.length, "0");

  expect(page.events).toHaveLength(1);
  expect(page.hasMore).toBe(true);
});

it("fireLaneCancel reports a rejection and a synchronous throw through the same path", async () => {
  const reported: string[] = [];
  const reportFailures: unknown[] = [];

  fireLaneCancel({
    hook: async () => {
      throw new Error("rejected");
    },
    agent: "claude",
    report: (message) => reported.push(message),
    onReportFailure: (cause) => reportFailures.push(cause),
  });
  fireLaneCancel({
    hook: () => {
      throw new Error("threw");
    },
    agent: "codex",
    report: (message) => reported.push(message),
    onReportFailure: (cause) => reportFailures.push(cause),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(reported.sort()).toEqual([
    "room cancel of claude failed: rejected",
    "room cancel of codex failed: threw",
  ]);
  expect(reportFailures).toEqual([]);
});

it("fireLaneCancel routes a failure to REPORT the failure onward instead of losing it", async () => {
  const reportFailures: unknown[] = [];

  fireLaneCancel({
    hook: async () => {
      throw new Error("the bridge refused");
    },
    agent: "claude",
    report: () => {
      throw new Error("journal has no capacity left");
    },
    onReportFailure: (cause) => reportFailures.push(cause),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect((reportFailures[0] as Error).message).toBe("journal has no capacity left");
});

it("fireLaneCancel is silent for a hook that succeeds, and a no-op when there is no hook", async () => {
  const reported: string[] = [];
  const seen: string[] = [];

  fireLaneCancel({
    hook: (agent) => {
      seen.push(agent);
    },
    agent: "gemini",
    report: (message) => reported.push(message),
    onReportFailure: () => reported.push("report-failure"),
  });
  fireLaneCancel({
    hook: undefined,
    agent: "gemini",
    report: (message) => reported.push(message),
    onReportFailure: () => reported.push("report-failure"),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(seen).toEqual(["gemini"]);
  expect(reported).toEqual([]);
});
