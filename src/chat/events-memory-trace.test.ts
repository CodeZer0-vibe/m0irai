/**
 * @file src/chat/events-memory-trace.test.ts
 * @purpose Falsifiers for the memory.trace event kind (O1 memory observability) across all three
 *   registration layers: the ChatEvent union (type), the ChatEventSchema discriminated union (parse
 *   survival + bad-phase rejection), and the chat-trace ALL_EVENT_KINDS allowlist + NDJSON sink
 *   (end-to-end). Split from events.test.ts to keep that file under the line ceiling.
 * @exports (none)
 * @depends node:fs, node:os, node:path, vitest, ./chat-trace, ./events
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ALL_EVENT_KINDS, attachTraceSink } from "./chat-trace.js";
import { ChatEventBus, ChatEventSchema } from "./events.js";

let dir: string;
let tracePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memory-trace-"));
  tracePath = join(dir, "trace.ndjson");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

it("memory.trace phase + turn + detail SURVIVE ChatEventSchema.parse (non-strict lockstep)", () => {
  const event = {
    kind: "memory.trace" as const,
    phase: "migrated" as const,
    turn: 0,
    detail: "v15 applied to proj-1",
  };
  const parsed = ChatEventSchema.parse(event);
  expect(parsed).toEqual(event);
  if (parsed.kind !== "memory.trace") throw new Error("expected memory.trace");
  expect(parsed.phase).toBe("migrated");
  expect(parsed.detail).toBe("v15 applied to proj-1");
});

it("ChatEventSchema rejects a memory.trace with an unknown phase", () => {
  expect(() =>
    ChatEventSchema.parse({ kind: "memory.trace", phase: "nonsense", turn: 0 }),
  ).toThrow();
});

it("memory.trace is delivered to a subscribed handler with its phase intact", () => {
  const bus = new ChatEventBus();
  const seen: string[] = [];
  bus.on("memory.trace", (event) => seen.push(event.phase));
  bus.emit({ kind: "memory.trace", phase: "briefing", turn: 3 });
  expect(seen).toEqual(["briefing"]);
});

it("memory.trace is in the trace allowlist and writes one NDJSON line end-to-end", () => {
  expect(ALL_EVENT_KINDS).toContain("memory.trace");
  const bus = new ChatEventBus();
  attachTraceSink(bus, tracePath, () => "2026-07-04T00:00:00.000Z");
  bus.emit({ kind: "memory.trace", phase: "digest", turn: 5, detail: "3 sessions" });
  const lines = readFileSync(tracePath, "utf8").split("\n").filter(Boolean);
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0] as string)).toEqual({
    ts: "2026-07-04T00:00:00.000Z",
    kind: "memory.trace",
    phase: "digest",
    turn: 5,
    detail: "3 sessions",
  });
});
