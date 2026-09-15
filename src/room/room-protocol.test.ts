import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { RoomEvent } from "./room-engine.js";
import { projectRoomJournal } from "./room-journal.js";
import {
  decodeWireFrame,
  parseJsonRpcRequestFrame,
  validateJsonRpcServerFrame,
  validateRoomEvent,
} from "./room-protocol.js";

interface CorpusCase {
  readonly file: string;
  readonly id: string;
  readonly kind: "event" | "frame" | "notification" | "request" | "response" | "trace";
  readonly expect: Readonly<{ valid: boolean }>;
}
interface CorpusManifest {
  readonly cases: readonly CorpusCase[];
}

const corpusRoot = new URL("../../protocol/conformance/v1/", import.meta.url);
const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("manifest.json", corpusRoot)), "utf8"),
) as CorpusManifest;

function modeEvent() {
  return {
    protocol: "zer0.room" as const,
    version: 1 as const,
    sessionId: "chat-test",
    eventSeq: "1",
    eventId: "event-mode",
    turnId: "room-mode",
    occurredAt: "2026-01-01T00:00:00Z",
    type: "agent.mode" as const,
    payload: {
      agent: "codex",
      modeId: "agent",
      word: "careful",
      status: "active",
      availableModeIds: ["read-only", "agent", "agent-full-access"],
    },
  };
}

function corpusBytes(name: string): Buffer {
  return readFileSync(fileURLToPath(new URL(name, corpusRoot)));
}

function literalFrames(raw: Buffer): readonly Buffer[] {
  const frames: Buffer[] = [];
  for (let start = 0; start < raw.length; ) {
    const end = raw.indexOf(0x0a, start);
    if (end < 0) throw new Error("literal trace has an unterminated frame");
    frames.push(raw.subarray(start, end + 1));
    start = end + 1;
  }
  return frames;
}

function traceEvents(name: string, count: number): readonly RoomEvent[] {
  const frames = literalFrames(corpusBytes(`${name}.bin`));
  expect(frames).toHaveLength(count);
  return frames.map((frame) => {
    const event = decodeWireFrame(frame) as RoomEvent;
    validateRoomEvent(event);
    return event;
  });
}

function validates(case_: CorpusCase): boolean {
  try {
    const raw = corpusBytes(case_.file);
    switch (case_.kind) {
      case "frame":
        decodeWireFrame(raw);
        break;
      case "request":
        parseJsonRpcRequestFrame(raw);
        break;
      case "notification":
      case "response":
        validateJsonRpcServerFrame(decodeWireFrame(raw));
        break;
      case "event":
        validateRoomEvent(decodeWireFrame(raw) as RoomEvent);
        break;
      case "trace":
        throw new Error("trace cases have reducer-specific literal-byte consumers");
    }
    return true;
  } catch {
    return false;
  }
}

it("consumes every non-trace shared corpus byte fixture through the production validators", () => {
  const cases = manifest.cases.filter((case_) => case_.kind !== "trace");
  expect(cases).not.toHaveLength(0);
  for (const case_ of cases) expect(validates(case_), case_.id).toBe(case_.expect.valid);
});

it("validates lane.started identity and exact JSON-RPC error structure", () => {
  const started = {
    protocol: "zer0.room",
    version: 1,
    sessionId: "chat-test",
    eventSeq: "1",
    eventId: "event-1",
    turnId: "turn-1",
    occurredAt: "2026-01-01T00:00:00Z",
    type: "lane.started",
    payload: { laneId: "lane-1", agent: "codex" },
  };
  expect(() => validateRoomEvent(started)).toThrow("lane.started");
  expect(() => validateJsonRpcServerFrame({ jsonrpc: "2.0", id: "request-1", error: {} })).toThrow(
    "response",
  );
  expect(() =>
    validateRoomEvent({
      ...started,
      occurredAt: "2026-01-01",
      payload: { ...started.payload, streamId: "s" },
    }),
  ).toThrow("time");
  expect(() =>
    validateRoomEvent({
      ...started,
      occurredAt: "2026-02-30T00:00:00Z",
      payload: { ...started.payload, streamId: "s" },
    }),
  ).toThrow("time");
  expect(() =>
    validateRoomEvent({
      ...started,
      occurredAt: "2026-01-01T24:00:00Z",
      payload: { ...started.payload, streamId: "s" },
    }),
  ).toThrow("time");
  expect(() =>
    validateRoomEvent({ ...started, type: "lane.activity", payload: { update: "tool_call" } }),
  ).toThrow("activity");
  expect(() =>
    validateRoomEvent({ ...started, payload: { ...started.payload, streamId: "s", modelId: 1 } }),
  ).toThrow("lane.started");
});

it("falsifier: room mode and hop events reject unknown or malformed provider control data", () => {
  const event = modeEvent();
  expect(() => validateRoomEvent(event)).not.toThrow();
  expect(() =>
    validateRoomEvent({ ...event, payload: { ...event.payload, status: "pretend" } }),
  ).toThrow("agent.mode");
  expect(() =>
    validateRoomEvent({ ...event, payload: { ...event.payload, diagnostic: "not wire-safe" } }),
  ).toThrow("agent.mode");
  expect(() =>
    validateRoomEvent({ ...event, payload: { ...event.payload, modeId: "😀".repeat(32) } }),
  ).not.toThrow();
  expect(() =>
    validateRoomEvent({ ...event, payload: { ...event.payload, modeId: "😀".repeat(33) } }),
  ).toThrow("agent.mode");
  expect(() =>
    validateRoomEvent({ ...event, payload: { ...event.payload, modeId: "auto\u0007" } }),
  ).toThrow("agent.mode");
});

it("falsifier: room hops reject unknown or malformed provider control data", () => {
  const event = modeEvent();
  const hop = {
    ...event,
    eventId: "event-hop",
    type: "hop.dispatched" as const,
    payload: {
      fromAgent: "claude",
      toAgent: "codex",
      parentMessageId: "msg-parent",
      hopIndex: 1,
      maxHop: 1,
      hopId: "hop-1",
      text: "review this",
    },
  };
  expect(() => validateRoomEvent(hop)).not.toThrow();
  expect(() => validateRoomEvent({ ...hop, payload: { ...hop.payload, hopBudget: 1 } })).toThrow(
    "hop",
  );
  expect(() =>
    validateRoomEvent({ ...hop, payload: { ...hop.payload, toAgent: "claude" } }),
  ).toThrow("hop");
});

it("falsifier: permission wire preserves opaque IDs while bounding IDs and visible choices", () => {
  const event = {
    protocol: "zer0.room" as const,
    version: 1 as const,
    sessionId: "chat-test",
    eventSeq: "1",
    eventId: "event-permission",
    turnId: "turn-1",
    occurredAt: "2026-01-01T00:00:00Z",
    type: "permission.requested" as const,
    payload: {
      agent: "claude",
      askId: "ask-1",
      toolTitle: "write file",
      options: [{ optionId: "allow", kind: "allow", name: "Allow" }],
    },
  };
  expect(() => validateRoomEvent(event)).not.toThrow();
  expect(() =>
    validateRoomEvent({ ...event, payload: { ...event.payload, askId: "  opaque\t\u001b[31m" } }),
  ).not.toThrow();
  expect(() =>
    validateRoomEvent({
      ...event,
      payload: {
        ...event.payload,
        options: Array.from({ length: 10 }, (_, index) => ({ optionId: `option-${index}` })),
      },
    }),
  ).toThrow("permission.requested");
  expect(() =>
    validateRoomEvent({ ...event, payload: { ...event.payload, askId: "x".repeat(4097) } }),
  ).toThrow("permission.requested");
});

it("parses raw corpus trace identities while the durable journal rejects repeats and gaps", () => {
  const [base, identical] = traceEvents("trace-identical-duplicate", 2) as [RoomEvent, RoomEvent];
  const [, conflict] = traceEvents("trace-conflicting-duplicate", 2) as [RoomEvent, RoomEvent];
  const [gapBase, gap, middle, repeatedGap] = traceEvents("trace-gap-resync-repeat", 4) as [
    RoomEvent,
    RoomEvent,
    RoomEvent,
    RoomEvent,
  ];
  expect(gapBase).toEqual(base);
  expect(repeatedGap).toEqual(gap);
  expect(() => projectRoomJournal([base, identical], base.sessionId)).toThrow();
  expect(() => projectRoomJournal([base, conflict], base.sessionId)).toThrow();
  expect(() => projectRoomJournal([base, gap], base.sessionId)).toThrow("sequence");
  expect(projectRoomJournal([base, middle, gap], base.sessionId).lastSequence).toBe(3n);
});

// Lane MN. A positive control on the notice fixtures: the corpus test above answers only
// valid/invalid, so an unreadable file would read as a legitimate rejection. These assert the exact
// reason each shape is refused, and that the two deliberately-valid shapes really do pass.
it("validates the room.notice corpus for the reasons the notice contract states", () => {
  const parse = (id: string): RoomEvent =>
    decodeWireFrame(readFileSync(fileURLToPath(new URL(`${id}.bin`, corpusRoot)))) as RoomEvent;

  expect(parse("notice-valid").payload).toEqual({
    cause: "memory-compose-failed",
    agent: "claude",
    detail: "SQLITE_CORRUPT: briefing composition failed",
  });
  expect(() => validateRoomEvent(parse("notice-valid"))).not.toThrow();
  // An unrecognized cause is ACCEPTED on the wire so an older terminal can still draw a newer
  // host's notice. Rejecting it would turn forward compatibility into a lost row.
  expect(parse("notice-unknown-cause").payload.cause).toBe("some-future-condition");
  expect(() => validateRoomEvent(parse("notice-unknown-cause"))).not.toThrow();

  expect(() => validateRoomEvent(parse("notice-missing-detail"))).toThrow(
    "invalid room.notice payload",
  );
  expect(() => validateRoomEvent(parse("notice-detail-over"))).toThrow(
    "invalid room.notice payload",
  );
  // 200 ASTRAL characters: 800 UTF-8 bytes and 400 UTF-16 units, but exactly 200 code points, which
  // is the unit the schema, this validator and the Rust validator all count in.
  const max = parse("notice-detail-max");
  expect([...String(max.payload.detail)]).toHaveLength(200);
  expect(() => validateRoomEvent(max)).not.toThrow();
});

it("refuses a room.notice the host could never have minted", () => {
  const notice = (payload: Readonly<Record<string, unknown>>) => ({
    protocol: "zer0.room" as const,
    version: 1 as const,
    sessionId: "chat-test",
    eventSeq: "1",
    eventId: "event-notice",
    turnId: "turn-1",
    occurredAt: "2026-09-02T00:00:00Z",
    type: "room.notice" as const,
    payload,
  });
  for (const payload of [
    { detail: "no cause" },
    { cause: "", detail: "empty cause" },
    { cause: "x".repeat(65), detail: "cause over 64 bytes" },
    { cause: "c", agent: "mistral", detail: "unknown agent" },
    { cause: "c", detail: "" },
    { cause: "c", detail: "d", extra: true },
    { cause: "c[31m", detail: "control bytes in the cause" },
    { cause: "c", detail: "control‮bytes in the detail" },
  ]) {
    expect(() => validateRoomEvent(notice(payload)), JSON.stringify(payload)).toThrow(
      "invalid room.notice payload",
    );
  }
});
