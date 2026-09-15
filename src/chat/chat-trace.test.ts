/**
 * @file src/chat/chat-trace.test.ts
 * @purpose Tests the NDJSON trace sink: every emitted ChatEvent appends one JSON line carrying
 *   the injected clock's ts, the turn, the kind, and the event payload.
 * @exports (none)
 * @depends node:fs, node:os, node:path, vitest, ./chat-trace, ./events
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachTraceSink } from "./chat-trace.js";
import { type ChatEvent, ChatEventBus } from "./events.js";

let dir: string;
let tracePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chat-trace-"));
  tracePath = join(dir, "trace.ndjson");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function lines(): string[] {
  return readFileSync(tracePath, "utf8").split("\n").filter(Boolean);
}

const FIXED_TS = "2026-06-03T00:00:00.000Z";

const PICK: ChatEvent = {
  kind: "route.classified",
  mode: "build",
  reason: "write kw",
  turn: 0,
};

const RESOLVED: ChatEvent = {
  kind: "route.resolved",
  turn: 0,
  route: {
    kind: "agent",
    agents: ["claude"],
    intent: "general",
    dispatchMode: "text-only",
    codexSandbox: "read-only",
    geminiMode: "review",
  },
  intent: "general",
  agents: ["claude"],
};

describe("attachTraceSink", () => {
  it("writes one NDJSON line per event with the injected clock ts, turn, kind, and payload", () => {
    const bus = new ChatEventBus();
    attachTraceSink(bus, tracePath, () => FIXED_TS);

    bus.emit(PICK);
    bus.emit({ kind: "user.message", turn: 0, text: "build it", timestamp: "x" });

    const out = lines();
    expect(out).toHaveLength(2);
    expect(JSON.parse(out[0] ?? "")).toMatchObject({ ts: FIXED_TS, ...PICK });
    expect(JSON.parse(out[1] ?? "")).toMatchObject({
      ts: FIXED_TS,
      kind: "user.message",
      text: "build it",
    });
  });

  it("captures the complete process trace across route, council, debate, and dispatch kinds", () => {
    const bus = new ChatEventBus();
    let n = 0;
    attachTraceSink(bus, tracePath, () => `t${String(n++)}`);

    bus.emit(RESOLVED);
    bus.emit({ kind: "council.started", turn: 0, agents: ["claude", "codex", "gemini"] });
    bus.emit({ kind: "debate.round-start", label: "Round 1", round: 1, turn: 0 });
    bus.emit({ kind: "dispatch.started", turn: 0, agent: "claude", mode: "text" });

    const kinds = lines().map((l) => JSON.parse(l).kind);
    expect(kinds).toEqual([
      "route.resolved",
      "council.started",
      "debate.round-start",
      "dispatch.started",
    ]);
    expect(lines().every((l) => typeof JSON.parse(l).ts === "string")).toBe(true);
  });

  it("appends across separate emits (one file, growing)", () => {
    const bus = new ChatEventBus();
    attachTraceSink(bus, tracePath, () => "ts");

    bus.emit({ kind: "session.saved", sessionId: "chat-1", runDir: "/tmp/r" });
    expect(lines()).toHaveLength(1);
    bus.emit({ kind: "session.saved", sessionId: "chat-1", runDir: "/tmp/r" });
    expect(lines()).toHaveLength(2);
  });
});

describe("attachTraceSink BUILD-pillar observability", () => {
  it("traces every BUILD lane-lifecycle event with its payload (observability mandate)", () => {
    const bus = new ChatEventBus();
    attachTraceSink(bus, tracePath, () => FIXED_TS);
    const lane = { turn: 0, runId: "brun-1", agent: "codex" as const };

    bus.emit({ kind: "build.run.started", turn: 0, runId: "brun-1", agents: ["codex", "claude"] });
    bus.emit({ kind: "build.lane.created", ...lane, worktreePath: "/wt/codex" });
    bus.emit({ kind: "build.lane.dispatched", ...lane });
    bus.emit({ kind: "build.lane.captured", ...lane, laneStatus: "captured", changedFiles: ["x"] });
    bus.emit({
      kind: "build.card",
      ...lane,
      laneStatus: "captured",
      mergeable: true,
      onTask: "unverified",
    });

    const out = lines().map((l) => JSON.parse(l));
    expect(out.map((e) => e.kind)).toEqual([
      "build.run.started",
      "build.lane.created",
      "build.lane.dispatched",
      "build.lane.captured",
      "build.card",
    ]);
    // The card's reconciliation fields are present in the trace (not dropped on the bus).
    expect(out[4]).toMatchObject({ laneStatus: "captured", mergeable: true, onTask: "unverified" });
  });
});

// BLOCK 1: ChatEventBus.emit swallows handler throws (events.ts), so a per-event write failure
// would silently drop trace lines. The sink must FAIL LOUD at attach time instead.
describe("attachTraceSink fail-loud", () => {
  it("throws at attach time (before subscribing) when the destination cannot be written", () => {
    const bus = new ChatEventBus();
    // A path whose PARENT is an existing FILE (not a dir) cannot be mkdir'd → unwritable.
    const fileAsParent = join(dir, "afile");
    rmSync(tracePath, { force: true });
    writeFileSync(fileAsParent, "x");
    const unwritable = join(fileAsParent, "trace.ndjson");

    expect(() => attachTraceSink(bus, unwritable, () => "ts")).toThrow(/ZER0_CHAT_TRACE/);
    // Failing loud means NOT subscribing: a subsequent emit must not be observed by a half-attached
    // handler (no file was ever created at the bad path).
    expect(existsSync(unwritable)).toBe(false);
  });

  it("creates a nested non-existent directory at attach time and writes into it", () => {
    const bus = new ChatEventBus();
    const nested = join(dir, "deep", "nested", "trace.ndjson");
    expect(existsSync(join(dir, "deep"))).toBe(false);

    attachTraceSink(bus, nested, () => "ts");
    bus.emit({ kind: "session.saved", sessionId: "chat-1", runDir: "/tmp/r" });

    expect(existsSync(nested)).toBe(true);
    expect(readFileSync(nested, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
  });
});

it("traces usage.payload diagnostics with source/outcome/fields intact", () => {
  const bus = new ChatEventBus();
  attachTraceSink(bus, tracePath, () => FIXED_TS);

  bus.emit({
    kind: "usage.payload",
    agent: "gemini",
    turn: 7,
    source: "agy.statusline",
    outcome: "stale",
    fields: [],
  });

  expect(JSON.parse(lines()[0] ?? "")).toMatchObject({
    kind: "usage.payload",
    agent: "gemini",
    turn: 7,
    source: "agy.statusline",
    outcome: "stale",
    fields: [],
  });
});
