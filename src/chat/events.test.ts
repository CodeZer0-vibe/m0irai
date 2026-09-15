// @size-justified: the LOCKSTEP falsifying tests must stay co-located with every ChatEvent they guard
// (one survival test per event kind) — splitting them away from the schema they assert against would
// hide which event a survival regression belongs to. Under the 600-line hard gate.
/**
 * @file src/chat/events.test.ts
 * @purpose Tests the typed chat event bus dispatch/isolation and ChatEventSchema validation.
 * @exports (none)
 * @depends vitest, ./events
 */
import { expect, it, vi } from "vitest";
import {
  ChatEventBus,
  ChatEventSchema,
  type DispatchCompletedEvent,
  type UserMessageEvent,
} from "./events.js";

function userMessage(text: string, turn = 0): UserMessageEvent {
  return { kind: "user.message", turn, text, timestamp: "2026-05-28T00:00:00.000Z" };
}

it("bus delivers an emitted event to a subscribed handler", () => {
  const bus = new ChatEventBus();
  const received: UserMessageEvent[] = [];
  bus.on("user.message", (event) => received.push(event));

  bus.emit(userMessage("hello", 1));

  expect(received).toEqual([userMessage("hello", 1)]);
});

it("bus only delivers to handlers registered for the matching kind", () => {
  const bus = new ChatEventBus();
  const userHandler = vi.fn();
  const completedHandler = vi.fn();
  bus.on("user.message", userHandler);
  bus.on("dispatch.completed", completedHandler);

  bus.emit(userMessage("only-user"));

  expect(userHandler).toHaveBeenCalledTimes(1);
  expect(completedHandler).not.toHaveBeenCalled();
});

it("bus delivers a single event to every handler registered for that kind", () => {
  const bus = new ChatEventBus();
  const first = vi.fn();
  const second = vi.fn();
  bus.on("user.message", first);
  bus.on("user.message", second);

  bus.emit(userMessage("fanout"));

  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
});

it("bus stops delivering to a handler after off()", () => {
  const bus = new ChatEventBus();
  const handler = vi.fn();
  bus.on("user.message", handler);
  bus.off("user.message", handler);

  bus.emit(userMessage("after-off"));

  expect(handler).not.toHaveBeenCalled();
});

it("bus isolates a throwing handler so later handlers still run", () => {
  const bus = new ChatEventBus();
  const exploder = vi.fn(() => {
    throw new Error("boom");
  });
  const survivor = vi.fn();
  bus.on("user.message", exploder);
  bus.on("user.message", survivor);

  bus.emit(userMessage("isolation"));

  expect(exploder).toHaveBeenCalledTimes(1);
  expect(survivor).toHaveBeenCalledTimes(1);
});

it("bus is a no-op when emitting a kind with no subscribers", () => {
  const bus = new ChatEventBus();
  const completed: DispatchCompletedEvent = {
    kind: "dispatch.completed",
    turn: 2,
    agent: "codex",
    exitCode: 0,
    durationMs: 1200,
    outputPath: "responses/turn-0002-codex.md",
  };

  expect(() => bus.emit(completed)).not.toThrow();
});

it("bus validates the event through ChatEventSchema before dispatch", () => {
  const bus = new ChatEventBus();
  const handler = vi.fn();
  bus.on("user.message", handler);

  // Construct a structurally-valid UserMessageEvent whose runtime values violate the
  // schema (negative turn, empty timestamp). emit() runs ChatEventSchema.parse first,
  // so it must throw before any handler is invoked.
  const invalid: UserMessageEvent = {
    kind: "user.message",
    turn: -1,
    text: "bad",
    timestamp: "",
  };
  expect(() => bus.emit(invalid)).toThrow();
  expect(handler).not.toHaveBeenCalled();
});

it("schema accepts a well-formed dispatch.completed event", () => {
  const event = {
    kind: "dispatch.completed",
    turn: 3,
    agent: "claude",
    exitCode: 0,
    durationMs: 4200,
    outputPath: "responses/turn-0003-claude.md",
  };

  expect(ChatEventSchema.parse(event)).toEqual(event);
});

it("schema accepts a route.resolved event and normalizes its nested route", () => {
  const parsed = ChatEventSchema.parse({
    kind: "route.resolved",
    turn: 1,
    intent: "build",
    agents: ["codex"],
    route: {
      kind: "agent",
      agents: ["codex"],
      intent: "build",
      dispatchMode: "pipeline",
      codexSandbox: "workspace-write",
      geminiMode: "review",
    },
  });

  expect(parsed).toMatchObject({
    kind: "route.resolved",
    route: { kind: "agent", codexSandbox: "workspace-write" },
  });
});

it("schema rejects an unknown event kind", () => {
  expect(() => ChatEventSchema.parse({ kind: "nope", turn: 0 })).toThrow();
});

it("schema rejects a negative turn number", () => {
  expect(() =>
    ChatEventSchema.parse({ kind: "user.message", turn: -1, text: "x", timestamp: "t" }),
  ).toThrow();
});

it("schema rejects an unknown agent name in a dispatch event", () => {
  expect(() =>
    ChatEventSchema.parse({
      kind: "dispatch.started",
      turn: 0,
      agent: "gpt-4",
      mode: "text",
    }),
  ).toThrow();
});

it("schema rejects a session.saved event with an empty sessionId", () => {
  expect(() =>
    ChatEventSchema.parse({ kind: "session.saved", sessionId: "", runDir: "/tmp/x" }),
  ).toThrow();
});

// AC-5 + INV-6 silent-failure trap: the reason/mode of a route.classified event MUST survive
// ChatEventSchema.parse (the schemas are not .strict(), so a TS-only field is dropped on the
// bus). This is the falsifying test that proves the schema field is wired, not just the type.
it("route.classified event reason + mode SURVIVE ChatEventSchema.parse (not silently dropped)", () => {
  const event = {
    kind: "route.classified" as const,
    mode: "build" as const,
    reason: "a build request that can modify the workspace",
    turn: 2,
  };

  const parsed = ChatEventSchema.parse(event);

  expect(parsed).toEqual(event);
  if (parsed.kind !== "route.classified") throw new Error("expected route.classified");
  expect(parsed.reason).toBe(event.reason);
  expect(parsed.mode).toBe("build");
});

it("route.classified event is delivered to a subscribed handler with its reason intact", () => {
  const bus = new ChatEventBus();
  const received: { reason: string; mode: string }[] = [];
  bus.on("route.classified", (e) => received.push({ reason: e.reason, mode: e.mode }));

  bus.emit({
    kind: "route.classified",
    mode: "research",
    reason: "an information-gathering request — running read-only research",
    turn: 0,
  });

  expect(received).toEqual([
    { reason: "an information-gathering request — running read-only research", mode: "research" },
  ]);
});

// S8: non-strict schema — an old persisted line still carrying requiresConfirm still parses.
it("legacy route.classified with requiresConfirm still parses (old-transcript compat)", () => {
  const p = { kind: "route.classified", mode: "all", reason: "r", requiresConfirm: true, turn: 0 };
  expect(ChatEventSchema.parse(p)).not.toHaveProperty("requiresConfirm");
});

// route.decision silent-drop trap (transparency): the verdict/reason/agents/laneCount of a
// route.decision event MUST survive ChatEventSchema.parse. The schemas are not .strict(), so a
// TS-only field present on the union but ABSENT from the zod schema is silently DROPPED on the bus —
// which would erase the very verdict + reason the operator's trace exists to show. This is the
// falsifying test that proves every payload field is wired in zod, not just declared on the type.
it("route.decision event verdict + reason + agents + laneCount SURVIVE ChatEventSchema.parse", () => {
  const event = {
    kind: "route.decision" as const,
    turn: 3,
    verdict: "isolated-build" as const,
    reason: "a codex/claude build — routing through the isolated worktree path",
    agents: ["codex", "claude"] as const,
    laneCount: 2,
  };

  const parsed = ChatEventSchema.parse(event);

  expect(parsed).toEqual(event);
  if (parsed.kind !== "route.decision") throw new Error("expected route.decision");
  expect(parsed.verdict).toBe("isolated-build");
  expect(parsed.reason).toBe(event.reason);
  expect(parsed.agents).toEqual(["codex", "claude"]);
  expect(parsed.laneCount).toBe(2);
});

it("route.decision reject event (no agents/laneCount) survives parse + delivers to a handler", () => {
  const bus = new ChatEventBus();
  const received: { verdict: string; reason: string }[] = [];
  bus.on("route.decision", (e) => received.push({ verdict: e.verdict, reason: e.reason }));

  bus.emit({
    kind: "route.decision",
    turn: 0,
    verdict: "reject-gemini",
    reason: "gemini build lanes are rejected in the MVP",
  });

  expect(received).toEqual([
    { verdict: "reject-gemini", reason: "gemini build lanes are rejected in the MVP" },
  ]);
});

it("schema rejects a route.decision event with an empty reason", () => {
  expect(() =>
    ChatEventSchema.parse({ kind: "route.decision", turn: 0, verdict: "reject-all", reason: "" }),
  ).toThrow();
});

// Task 2 closed-union: the route.decision verdict union gains `gemini-research` (Task 3 emits it;
// here we prove the TYPE + zod schema accept it so the trace can carry it). A falsifying counter-
// part below asserts an unknown verdict is still rejected (the enum stays closed).
it("route.decision event with verdict gemini-research SURVIVES ChatEventSchema.parse", () => {
  const event = {
    kind: "route.decision" as const,
    turn: 2,
    verdict: "gemini-research" as const,
    reason: "a natural-language gemini research/design ask — routing to the .md-gated lane",
  };

  const parsed = ChatEventSchema.parse(event);

  expect(parsed).toEqual(event);
  if (parsed.kind !== "route.decision") throw new Error("expected route.decision");
  expect(parsed.verdict).toBe("gemini-research");
});

it("schema rejects an unknown route.decision verdict (the enum stays closed)", () => {
  expect(() =>
    ChatEventSchema.parse({
      kind: "route.decision",
      turn: 0,
      verdict: "gemini-build",
      reason: "not a real verdict",
    }),
  ).toThrow();
});

// Task 2 closed-union: the build.lane.captured / build.card laneStatus union gains `policy-rejected`
// (a non-acceptable terminal). It must survive ChatEventSchema.parse on BOTH lane events that carry a
// laneStatus, or the trace/card would silently drop the state the operator needs to see.
it("build.lane.captured with laneStatus policy-rejected survives ChatEventSchema.parse", () => {
  const event = {
    kind: "build.lane.captured" as const,
    turn: 0,
    runId: "brun-1",
    agent: "gemini" as const,
    laneStatus: "policy-rejected" as const,
    changedFiles: ["docs/research/x.md"],
  };
  expect(ChatEventSchema.parse(event)).toEqual(event);
});

// Task 2 card payload extension: BuildCardEvent gains optional artifactPath + policyViolation. They
// must survive ChatEventSchema.parse (the schemas are NOT .strict(), so a TS-only field is silently
// dropped on the bus). This proves both new optional fields are wired in zod, not just on the type.
it("build.card artifactPath + policyViolation + laneStatus policy-rejected SURVIVE parse", () => {
  const passEvent = {
    kind: "build.card" as const,
    turn: 5,
    runId: "brun-1",
    agent: "gemini" as const,
    laneStatus: "captured" as const,
    mergeable: false,
    onTask: "unverified" as const,
    artifactPath: ".zer0/runs/r/research/l.md",
  };
  const passParsed = ChatEventSchema.parse(passEvent);
  expect(passParsed).toEqual(passEvent);
  if (passParsed.kind !== "build.card") throw new Error("expected build.card");
  expect(passParsed.artifactPath).toBe(".zer0/runs/r/research/l.md");

  const failEvent = {
    kind: "build.card" as const,
    turn: 6,
    runId: "brun-1",
    agent: "gemini" as const,
    laneStatus: "policy-rejected" as const,
    mergeable: false,
    onTask: "unverified" as const,
    policyViolation: "added a .ts entry — only one docs/research/*.md is allowed",
  };
  const failParsed = ChatEventSchema.parse(failEvent);
  expect(failParsed).toEqual(failEvent);
  if (failParsed.kind !== "build.card") throw new Error("expected build.card");
  expect(failParsed.laneStatus).toBe("policy-rejected");
  expect(failParsed.policyViolation).toBe(
    "added a .ts entry — only one docs/research/*.md is allowed",
  );
});

// A bare build.card (no artifactPath / no policyViolation) must still parse — the new fields are
// OPTIONAL, so the existing code/THINK lanes that never set them are unaffected (non-regression).
it("build.card without the new optional fields still survives parse (non-regression)", () => {
  const event = {
    kind: "build.card" as const,
    turn: 1,
    runId: "brun-1",
    agent: "codex" as const,
    laneStatus: "captured" as const,
    mergeable: true,
    onTask: "unverified" as const,
  };
  expect(ChatEventSchema.parse(event)).toEqual(event);
});

it("schema rejects a route.classified event with an empty reason", () => {
  expect(() =>
    ChatEventSchema.parse({
      kind: "route.classified",
      mode: "build",
      reason: "",
      turn: 0,
    }),
  ).toThrow();
});

// RG-1 falsifying test: the BUILD-pillar observability events must survive ChatEventSchema.parse.
// The schemas are not .strict(), so a TS-only field present on the union but ABSENT from the zod
// schema is silently DROPPED on the bus — for build.card that would erase lane_status/mergeable/
// on_task, the very fields the operator's card renders. This proves the fields are wired in zod.
it("build.card event lane_status + mergeable + on_task SURVIVE ChatEventSchema.parse", () => {
  const event = {
    kind: "build.card" as const,
    turn: 5,
    runId: "brun-1",
    agent: "codex" as const,
    laneStatus: "captured" as const,
    mergeable: true,
    onTask: "unverified" as const,
  };

  const parsed = ChatEventSchema.parse(event);

  expect(parsed).toEqual(event);
  if (parsed.kind !== "build.card") throw new Error("expected build.card");
  expect(parsed.laneStatus).toBe("captured");
  expect(parsed.mergeable).toBe(true);
  expect(parsed.onTask).toBe("unverified");
});

it("build.card is delivered to a subscribed handler with its reconciliation fields intact", () => {
  const bus = new ChatEventBus();
  const received: { laneStatus: string; mergeable: boolean; onTask: string }[] = [];
  bus.on("build.card", (e) =>
    received.push({ laneStatus: e.laneStatus, mergeable: e.mergeable, onTask: e.onTask }),
  );

  bus.emit({
    kind: "build.card",
    turn: 1,
    runId: "brun-1",
    agent: "claude",
    laneStatus: "empty",
    mergeable: false,
    onTask: "unverified",
  });

  expect(received).toEqual([{ laneStatus: "empty", mergeable: false, onTask: "unverified" }]);
});

it.each([
  {
    kind: "build.run.started" as const,
    turn: 0,
    runId: "brun-1",
    agents: ["codex", "claude"] as const,
  },
  {
    kind: "build.lane.created" as const,
    turn: 0,
    runId: "brun-1",
    agent: "codex" as const,
    worktreePath: "/wt/codex",
  },
  { kind: "build.lane.dispatched" as const, turn: 0, runId: "brun-1", agent: "codex" as const },
  {
    kind: "build.lane.captured" as const,
    turn: 0,
    runId: "brun-1",
    agent: "codex" as const,
    laneStatus: "captured" as const,
    changedFiles: ["src/x.ts"],
  },
  {
    kind: "build.lane.escaped" as const,
    turn: 0,
    runId: "brun-1",
    agent: "claude" as const,
    reason: "changed-file escapes the worktree: /etc/passwd",
  },
  {
    kind: "build.lane.failed" as const,
    turn: 0,
    runId: "brun-1",
    agent: "codex" as const,
    exitCode: 1,
  },
  { kind: "build.lane.empty" as const, turn: 0, runId: "brun-1", agent: "claude" as const },
])("lane-lifecycle event $kind survives ChatEventSchema.parse", (event) => {
  expect(ChatEventSchema.parse(event)).toEqual(event);
});

// Feature 2 (LIVE per-agent usage) silent-drop trap: the agent.status event carries a NESTED `usage`
// object (label/exhausted/resets) + an optional `auth`. The schemas are NOT .strict(), so any nested
// field present on the TS type but ABSENT from the zod schema is silently DROPPED on the bus — which
// would erase the very usage window the status bar exists to show. This is the falsifying test proving
// every field (including the nested ones) is wired in zod, not just declared on the type.
it("agent.status event auth + nested usage (label/exhausted/resets) SURVIVE ChatEventSchema.parse", () => {
  const event = {
    kind: "agent.status" as const,
    agent: "codex" as const,
    auth: "limited" as const,
    usage: { label: "FULL", exhausted: true, resets: "~2h" },
  };

  const parsed = ChatEventSchema.parse(event);

  expect(parsed).toEqual(event);
  if (parsed.kind !== "agent.status") throw new Error("expected agent.status");
  expect(parsed.auth).toBe("limited");
  expect(parsed.usage?.label).toBe("FULL");
  expect(parsed.usage?.exhausted).toBe(true);
  expect(parsed.usage?.resets).toBe("~2h");
});

// agent.status with usage but no `resets` (codex primary/secondary absent — the empirical 0-balance
// case) must still survive parse: resets is OPTIONAL, so a window with no reset hint is unaffected.
it("agent.status with usage and no resets survives parse (resets optional)", () => {
  const event = {
    kind: "agent.status" as const,
    agent: "codex" as const,
    auth: "ready" as const,
    usage: { label: "OK", exhausted: false },
  };
  const parsed = ChatEventSchema.parse(event);
  expect(parsed).toEqual(event);
  if (parsed.kind !== "agent.status") throw new Error("expected agent.status");
  expect(parsed.usage?.resets).toBeUndefined();
});

// A usage-only update (auth absent) and an auth-only update (usage absent) must BOTH parse — the
// reducer MERGES, so the bus must let each half through (the cockpit keeps the prior other half).
it("agent.status auth-only and usage-only updates both survive parse (each field optional)", () => {
  const authOnly = {
    kind: "agent.status" as const,
    agent: "claude" as const,
    auth: "down" as const,
  };
  expect(ChatEventSchema.parse(authOnly)).toEqual(authOnly);
  const usageOnly = {
    kind: "agent.status" as const,
    agent: "codex" as const,
    usage: { label: "63%", exhausted: false, resets: "~5h" },
  };
  expect(ChatEventSchema.parse(usageOnly)).toEqual(usageOnly);
});

it("agent.status event is delivered to a subscribed handler with usage intact", () => {
  const bus = new ChatEventBus();
  const received: { agent: string; exhausted: boolean; label: string }[] = [];
  bus.on("agent.status", (e) =>
    received.push({
      agent: e.agent,
      exhausted: e.usage?.exhausted === true,
      label: e.usage?.label ?? "",
    }),
  );

  bus.emit({
    kind: "agent.status",
    agent: "codex",
    auth: "limited",
    usage: { label: "FULL", exhausted: true, resets: "~2h" },
  });

  expect(received).toEqual([{ agent: "codex", exhausted: true, label: "FULL" }]);
});

it("schema rejects an agent.status event with an unknown agent name", () => {
  expect(() =>
    ChatEventSchema.parse({ kind: "agent.status", agent: "bard", auth: "ready" }),
  ).toThrow();
});

// Context-left foundation silent-drop trap: the agent.status usage object gains an optional
// `contextUsedPct` (the per-agent USED context-window %, 0..100). The schemas are NOT
// .strict(), so a field present on the TS type but ABSENT from AgentUsageSchema is silently DROPPED
// on the bus — which would erase the very % the status bar exists to show. This is the falsifying
// test proving the field is wired in zod, not just declared on the type (the lockstep proof).
it("agent.status usage.contextUsedPct (97) SURVIVES a ChatEventBus emit to a subscriber", () => {
  const bus = new ChatEventBus();
  const received: { contextUsedPct: number | undefined }[] = [];
  bus.on("agent.status", (e) => received.push({ contextUsedPct: e.usage?.contextUsedPct }));

  bus.emit({
    kind: "agent.status",
    agent: "codex",
    auth: "ready",
    usage: { label: "97%", exhausted: false, resets: "~5h", contextUsedPct: 97 },
  });

  expect(received).toEqual([{ contextUsedPct: 97 }]);
});

// Out-of-[0,100] contextUsedPct must make emit() throw — emit runs ChatEventSchema.parse first,
// and the range guard (.min(0).max(100)) rejects 150 before any handler runs (no double-render of a
// nonsense %). This is the rejecting half of the lockstep contract.
it("agent.status usage.contextUsedPct out of [0,100] (150) makes emit throw", () => {
  const bus = new ChatEventBus();
  const handler = vi.fn();
  bus.on("agent.status", handler);

  expect(() =>
    bus.emit({
      kind: "agent.status",
      agent: "codex",
      // 150 is a valid `number` at the type level (the field is `number?`), so there is no compile
      // error to suppress — the [0,100] bound is a RUNTIME guard (z.number().min(0).max(100)) and
      // this asserts the bus parse rejects it before any handler runs.
      usage: { label: "150%", exhausted: false, contextUsedPct: 150 },
    }),
  ).toThrow();
  expect(handler).not.toHaveBeenCalled();
});

// usage WITHOUT contextUsedPct must still validate and the field stays absent — it is OPTIONAL,
// so the existing label/exhausted/resets-only producers are unaffected (non-regression).
it("agent.status usage without contextUsedPct still validates and the field is absent", () => {
  const event = {
    kind: "agent.status" as const,
    agent: "codex" as const,
    auth: "ready" as const,
    usage: { label: "OK", exhausted: false },
  };
  const parsed = ChatEventSchema.parse(event);
  expect(parsed).toEqual(event);
  if (parsed.kind !== "agent.status") throw new Error("expected agent.status");
  expect(parsed.usage?.contextUsedPct).toBeUndefined();
});
