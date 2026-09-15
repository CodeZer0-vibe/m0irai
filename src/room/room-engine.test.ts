/**
 * @size-justified: Scheduler falsifiers share stateful fixtures and stay below the 600-line hard ceiling.
 */
import { expect, it } from "vitest";
import { MAX_RESYNC_PAGE_EVENTS, RoomEngine, type RoomEvent } from "./room-engine.js";

async function submit(
  engine: RoomEngine,
  input: {
    readonly turnId: string;
    readonly agents: readonly ("claude" | "codex" | "gemini")[];
    readonly text: string;
  },
): Promise<void> {
  engine.reserveTurn(input.turnId, input.agents.length);
  return engine.submit({ ...input, messageId: `operator-${input.turnId}`, ledgerSeq: "1" });
}

function queuedJournalLane(
  seq: number,
  agent: "claude" | "codex" | "gemini",
  turnId: string,
  origin: "operator" | "agent",
  extra: Record<string, unknown> = {},
): RoomEvent {
  return {
    protocol: "zer0.room",
    version: 1,
    sessionId: "chat-room-test",
    eventSeq: String(seq),
    eventId: `event-${seq}`,
    turnId,
    occurredAt: "2026-01-01T00:00:00.000Z",
    type: "lane.queued",
    payload: {
      agent,
      laneId: `${turnId}:${agent}:${origin === "agent" ? 1 : 0}`,
      text: `${agent}-${turnId}`,
      origin,
      hopIndex: origin === "agent" ? 1 : 0,
      ...extra,
    },
  };
}

function terminalJournalEvent(
  seq: number,
  type: "lane.completed" | "lane.cancelled" | "lane.failed",
  laneId: string,
  agent: "claude" | "codex" | "gemini",
  turnId: string,
): RoomEvent {
  return roomJournalEvent(seq, type, turnId, {
    laneId,
    agent,
    ...(type === "lane.failed" ? { recovered: true } : {}),
  });
}

function roomJournalEvent(
  seq: number,
  type: RoomEvent["type"],
  turnId: string,
  payload: Readonly<Record<string, unknown>>,
): RoomEvent {
  return {
    protocol: "zer0.room",
    version: 1,
    sessionId: "chat-room-test",
    eventSeq: String(seq),
    eventId: `event-${seq}`,
    turnId,
    occurredAt: "2026-01-01T00:00:00.000Z",
    type,
    payload,
  };
}

it("falsifier: failed lane events keep provider diagnostics inert and bounded", async () => {
  const hostile = `boom\u001b[31m\n\u202e${"x".repeat(2_000)}`;
  const engine = new RoomEngine({
    runLane: async () => ({ text: "", status: "failed", error: hostile }),
  });
  await submit(engine, { turnId: "turn-hostile", agents: ["gemini"], text: "test" });
  await engine.whenIdle();
  const failure = engine.events().find((event) => event.type === "lane.failed");
  const detail = String(failure?.payload.error);
  expect(detail).toContain("\\x1b[31m\\n\\u202e");
  expect(detail).not.toContain("\u001b");
  expect(detail).not.toContain("\u202e");
  expect(detail.length).toBeLessThan(1_200);
});

it("falsifier: one busy lane queues while idle @all siblings start independently", async () => {
  const started: string[] = [];
  let releaseClaude: (() => void) | undefined;
  let claudeRuns = 0;
  const engine = new RoomEngine({
    runLane: async (lane) => {
      started.push(lane.agent);
      if (lane.agent === "claude" && claudeRuns++ === 0)
        await new Promise<void>((resolve) => {
          releaseClaude = resolve;
        });
      return {
        text: `${lane.agent} reply`,
        status: "completed",
        messageId: `msg-${lane.agent}-${lane.turnId}`,
      };
    },
  });

  await submit(engine, { turnId: "turn-1", agents: ["claude"], text: "first" });
  await submit(engine, { turnId: "turn-2", agents: ["claude", "codex", "gemini"], text: "second" });
  await Promise.resolve();

  expect(started).toEqual(["claude", "codex", "gemini"]);
  expect(
    engine
      .events()
      .some((event) => event.type === "lane.queued" && event.payload.agent === "claude"),
  ).toBe(true);
  releaseClaude?.();
  await engine.whenIdle();
  expect(started).toEqual(["claude", "codex", "gemini", "claude"]);
});

it("falsifier: pause cancels active lanes, retains queued work, and replay is contiguous", async () => {
  const controllers: AbortSignal[] = [];
  let runs = 0;
  const engine = new RoomEngine({
    runLane: async (lane) => {
      controllers.push(lane.signal);
      if (runs++ > 0)
        return {
          text: "queued reply",
          status: "completed",
          messageId: `msg-${lane.agent}-${lane.turnId}`,
        };
      await new Promise<void>((resolve) =>
        lane.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { text: "", status: "cancelled", messageId: `msg-${lane.agent}-${lane.turnId}` };
    },
  });

  await submit(engine, { turnId: "turn-1", agents: ["claude"], text: "active" });
  await submit(engine, { turnId: "turn-2", agents: ["claude"], text: "queued" });
  await engine.pause();

  expect(controllers[0]?.aborted).toBe(true);
  expect(engine.events().some((event) => event.type === "room.paused")).toBe(true);
  expect(engine.resync("0").map((event) => event.eventSeq)).toEqual(
    engine.events().map((event) => event.eventSeq),
  );
  await engine.resume();
  await engine.whenIdle();
  expect(engine.events().some((event) => event.type === "room.resumed")).toBe(true);
});

it("falsifier: a second agent hop is visible but cannot dispatch", async () => {
  const engine = new RoomEngine({
    runLane: async (lane) => ({
      text: lane.hopIndex === 0 ? "First review is complete." : "Second review is complete.",
      status: "completed",
      messageId: `msg-${lane.agent}-${lane.turnId}-${lane.hopIndex}`,
      ledgerSeq: String(lane.hopIndex + 1),
      handoff:
        lane.hopIndex === 0
          ? { target: "codex", text: "review this" }
          : { target: "gemini", text: "review again" },
    }),
  });

  await submit(engine, { turnId: "turn-1", agents: ["claude"], text: "start" });
  await engine.whenIdle();

  expect(engine.events().filter((event) => event.type === "hop.dispatched")).toHaveLength(1);
  expect(engine.events().filter((event) => event.type === "hop.blocked")).toHaveLength(1);
  expect(engine.events().find((event) => event.type === "hop.dispatched")?.payload.text).toBe(
    "review this",
  );
  expect(engine.events().find((event) => event.type === "hop.blocked")?.payload.text).toBe(
    "review again",
  );
  expect(engine.events().find((event) => event.type === "hop.dispatched")?.payload.maxHop).toBe(1);
});

it("falsifier: only a structured final handoff can enqueue one read-only child", async () => {
  const seen: Array<{ agent: string; origin: string; text: string }> = [];
  const engine = new RoomEngine({
    runLane: async (lane) => {
      seen.push({ agent: lane.agent, origin: lane.origin, text: lane.text });
      return {
        text: lane.hopIndex === 0 ? "Useful prose without a control line." : "child answer",
        status: "completed",
        messageId: `msg-${lane.agent}-${lane.hopIndex}`,
        ledgerSeq: String(lane.hopIndex + 1),
        ...(lane.hopIndex === 0
          ? { handoff: { target: "codex" as const, text: "review the diff" } }
          : {}),
      };
    },
  });
  await submit(engine, { turnId: "turn-1", agents: ["claude"], text: "start" });
  await engine.whenIdle();
  expect(seen).toEqual([
    { agent: "claude", origin: "operator", text: "start" },
    { agent: "codex", origin: "agent", text: "review the diff" },
  ]);
  expect(engine.events().find((event) => event.type === "message.committed")?.payload.text).toBe(
    "Useful prose without a control line.",
  );
});

it("falsifier: a self handoff is not emitted or enqueued even if a broken carrier supplies one", async () => {
  const seen: string[] = [];
  const engine = new RoomEngine({
    runLane: async (lane) => {
      seen.push(lane.agent);
      return {
        text: "answer",
        status: "completed",
        messageId: `msg-${lane.agent}`,
        ledgerSeq: "1",
        handoff: { target: "claude", text: "loop" },
      };
    },
  });
  await submit(engine, { turnId: "turn-1", agents: ["claude"], text: "start" });
  await engine.whenIdle();
  expect(seen).toEqual(["claude"]);
  expect(engine.events().filter((event) => event.type.startsWith("hop."))).toHaveLength(0);
});

it("falsifier: uncommitted carrier outcomes do not mint a room message or a hop", async () => {
  const engine = new RoomEngine({
    runLane: async () => ({
      text: "@codex: do not dispatch",
      status: "failed",
      committed: false,
    }),
  });

  await submit(engine, { turnId: "turn-1", agents: ["claude"], text: "start" });
  await engine.whenIdle();

  expect(engine.events().some((event) => event.type === "message.committed")).toBe(false);
  expect(engine.events().some((event) => event.type === "hop.dispatched")).toBe(false);
});

it("falsifier: an ignored abort that returns completed remains completed and committed", async () => {
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  const engine = new RoomEngine({
    runLane: async () => {
      await done;
      return { text: "done", status: "completed", messageId: "message-done", ledgerSeq: "2" };
    },
  });
  await submit(engine, { turnId: "turn-1", agents: ["claude"], text: "start" });
  await engine.cancel({ scope: "agent", agent: "claude" });
  release();
  await engine.whenIdle();
  expect(engine.events().some((event) => event.type === "lane.completed")).toBe(true);
  expect(engine.events().some((event) => event.type === "message.committed")).toBe(true);
});

it("falsifier: agent cancellation removes every queued lane for that agent, not only the head", async () => {
  let release!: () => void;
  const active = new Promise<void>((resolve) => {
    release = resolve;
  });
  const engine = new RoomEngine({
    runLane: async (lane) => {
      if (lane.turnId === "turn-1") {
        await active;
        return { text: "", status: "cancelled" };
      }
      throw new Error("cancelled queued work must never run");
    },
  });
  await submit(engine, { turnId: "turn-1", agents: ["claude"], text: "active" });
  await submit(engine, { turnId: "turn-2", agents: ["claude"], text: "first queued" });
  await submit(engine, { turnId: "turn-3", agents: ["claude"], text: "second queued" });

  await engine.cancel({ scope: "agent", agent: "claude" });
  release();
  await engine.whenIdle();

  expect(
    engine
      .events()
      .filter((event) => event.type === "lane.cancelled" && event.payload.queued === true),
  ).toHaveLength(2);
});

it("falsifier: quiesce rejects admission, cancels active work, and preserves queued lanes", async () => {
  let runs = 0;
  const engine = new RoomEngine({
    runLane: async (lane) => {
      runs += 1;
      await new Promise<void>((resolve) =>
        lane.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { text: "", status: "cancelled" };
    },
  });
  await submit(engine, { turnId: "turn-1", agents: ["claude"], text: "active" });
  await submit(engine, { turnId: "turn-2", agents: ["claude"], text: "queued" });
  await engine.quiesce();
  expect(runs).toBe(1);
  expect(
    engine
      .events()
      .filter((event) => event.type === "lane.cancelled" && event.payload.queued === true),
  ).toHaveLength(0);
  await expect(
    submit(engine, { turnId: "turn-3", agents: ["claude"], text: "rejected" }),
  ).rejects.toThrow("shutting down");
});

it("falsifier: queue admission mints one durable output identity for the carrier", async () => {
  let expectedMessageId: string | undefined;
  const engine = new RoomEngine({
    runLane: async (lane) => {
      expectedMessageId = lane.expectedMessageId;
      if (lane.expectedMessageId === undefined)
        throw new Error("room lane has no durable output id");
      return {
        text: "done",
        status: "completed",
        messageId: lane.expectedMessageId,
        ledgerSeq: "2",
      };
    },
  });
  await submit(engine, { turnId: "turn-1", agents: ["claude"], text: "start" });
  await engine.whenIdle();
  const queued = engine.events().find((event) => event.type === "lane.queued");
  const committed = engine.events().find((event) => event.type === "message.committed");
  expect(expectedMessageId).toMatch(/^msg-/u);
  expect(queued?.payload.expectedMessageId).toBe(expectedMessageId);
  expect(committed?.payload.messageId).toBe(expectedMessageId);
});

it("falsifier: protocol events bind to a persisted session and preserve decimal sequence precision", async () => {
  const engine = new RoomEngine({
    runLane: async () => ({ text: "done", status: "completed", messageId: "msg-1" }),
  });
  engine.bindSession("chat-room-test");
  engine.rehydrate([
    {
      protocol: "zer0.room",
      version: 1,
      sessionId: "chat-room-test",
      eventSeq: "1",
      eventId: "room-event-2",
      turnId: "turn-previous",
      occurredAt: "2026-01-01T00:00:00.000Z",
      type: "turn.completed",
      payload: {},
    },
  ]);

  await submit(engine, { turnId: "turn-1", agents: ["claude"], text: "start" });

  const accepted = engine.events().find((event) => event.type === "turn.accepted");
  expect(accepted?.sessionId).toBe("chat-room-test");
  expect(accepted?.eventSeq).toBe("2");
  expect(accepted?.eventId).toBe("room-event-3");
});

it("falsifier: every streamed chunk has protocol ordering fields and stays within the 32 KiB frame limit", async () => {
  const engine = new RoomEngine({
    runLane: async (lane) => {
      lane.onChunk(`${"a".repeat(32 * 1024)}${"😀".repeat(8)}`);
      return { text: "done", status: "completed", messageId: "msg-1" };
    },
  });

  await submit(engine, { turnId: "turn-1", agents: ["claude"], text: "stream" });
  await engine.whenIdle();

  const chunks = engine.events().filter((event) => event.type === "lane.chunk");
  expect(chunks).toHaveLength(2);
  expect(chunks.map((event) => event.payload.streamSeq)).toEqual(["1", "2"]);
  expect(chunks.map((event) => event.payload.chunkIndex)).toEqual([0, 1]);
  expect(chunks.every((event) => event.payload.channel === "stdout")).toBe(true);
  expect(
    chunks.every((event) => Buffer.byteLength(event.payload.text as string, "utf8") <= 32 * 1024),
  ).toBe(true);
});

it("falsifier: corrupt journal identity or sequence fails closed before any lane is recovered", () => {
  const engine = new RoomEngine({ runLane: async () => ({ text: "", status: "completed" }) });
  engine.bindSession("chat-room-test");
  expect(() =>
    engine.rehydrate([
      {
        protocol: "zer0.room",
        version: 1,
        sessionId: "other-session",
        eventSeq: "2",
        eventId: "duplicate",
        turnId: "turn-1",
        occurredAt: "2026-01-01T00:00:00.000Z",
        type: "turn.completed",
        payload: {},
      },
    ]),
  ).toThrow(/invalid room journal event/u);
});

it("falsifier: protocol, version, and duplicate event IDs fail closed before recovery", () => {
  for (const change of [
    { protocol: "wrong.room" },
    { version: 2 },
    { eventId: "duplicate", secondEventId: "duplicate" },
  ]) {
    const started: string[] = [];
    const engine = new RoomEngine({
      runLane: async (lane) => {
        started.push(lane.agent);
        return { text: "", status: "completed" };
      },
    });
    engine.bindSession("chat-room-test");
    const first = {
      protocol: change.protocol ?? "zer0.room",
      version: change.version ?? 1,
      sessionId: "chat-room-test",
      eventSeq: "1",
      eventId: change.eventId ?? "event-1",
      turnId: "turn-1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      type: "turn.completed" as const,
      payload: {},
    };
    const journal =
      change.secondEventId === undefined
        ? [first]
        : [first, { ...first, eventSeq: "2", eventId: change.secondEventId }];
    expect(() => engine.rehydrate(journal as never)).toThrow();
    expect(started).toEqual([]);
  }
});

it("falsifier: recovered provider permission promises are durably invalidated before readiness", async () => {
  const published: RoomEvent[] = [];
  const engine = new RoomEngine({
    runLane: async () => ({ text: "", status: "completed" }),
    onEvent: async (event) => {
      published.push(event);
    },
  });
  engine.bindSession("chat-room-test");
  const projection = engine.rehydrate([
    roomJournalEvent(1, "permission.requested", "turn-1", {
      agent: "claude",
      askId: "ask-crashed",
      options: [{ optionId: "allow-once" }],
    }),
  ]);

  await engine.invalidateRecoveredPermissions(projection.pendingPermissions.values());

  expect(published).toEqual([
    expect.objectContaining({
      eventSeq: "2",
      type: "permission.resolved",
      payload: { agent: "claude", askId: "ask-crashed", outcome: "invalidated" },
    }),
  ]);
  expect(engine.resync("0").at(-1)).toMatchObject({
    eventSeq: "2",
    type: "permission.resolved",
  });
});

it("falsifier: an acceptance journal failure rejects submit and remains observable when idle", async () => {
  const engine = new RoomEngine({
    onEvent: async () => {
      throw new Error("disk full");
    },
    runLane: async () => ({ text: "done", status: "completed", messageId: "msg-1" }),
  });
  await expect(
    submit(engine, { turnId: "turn-1", agents: ["claude"], text: "start" }),
  ).rejects.toThrow("disk full");
  await expect(engine.whenIdle()).rejects.toThrow("disk full");
});

it("falsifier: journal callbacks stay in decimal event order despite delayed completion", async () => {
  const seen: string[] = [];
  let release!: () => void;
  const first = new Promise<void>((resolve) => {
    release = resolve;
  });
  const engine = new RoomEngine({
    onEvent: async (event) => {
      if (event.eventSeq === "1") await first;
      seen.push(event.eventSeq);
    },
    runLane: async () => ({ text: "done", status: "completed", messageId: "msg-1" }),
  });
  const submitted = submit(engine, { turnId: "turn-1", agents: ["claude"], text: "start" });
  await Promise.resolve();
  expect(seen).toEqual([]);
  release();
  await submitted;
  await engine.whenIdle();
  expect(seen).toEqual(seen.map((_, index) => String(index + 1)));
});

it("falsifier: resync exposes only the durable publication frontier", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const engine = new RoomEngine({
    onEvent: async () => gate,
    runLane: async () => ({ text: "", status: "completed" }),
  });
  engine.notify("turn-1", "backend.failed", { message: "delayed append" });
  expect(engine.resyncPage("0")).toEqual({ events: [], hasMore: false });
  release();
  await engine.whenIdle();
  expect(engine.resyncPage("0")).toMatchObject({
    events: [{ eventSeq: "1", type: "backend.failed" }],
    hasMore: false,
  });
});

it("falsifier: resync pages stay below the event-count contract", () => {
  const engine = new RoomEngine({
    runLane: async () => ({ text: "", status: "completed" }),
  });
  for (let index = 0; index <= MAX_RESYNC_PAGE_EVENTS; index += 1) {
    engine.notify(`turn-${index}`, "backend.failed", { message: `failure-${index}` });
  }
  const first = engine.resyncPage("0");
  expect(first.events).toHaveLength(MAX_RESYNC_PAGE_EVENTS);
  expect(first.hasMore).toBe(true);
  const second = engine.resyncPage(first.events.at(-1)?.eventSeq ?? "0");
  expect(second.events).toHaveLength(1);
  expect(second.hasMore).toBe(false);
});

it("falsifier: recovery restores only nonterminal FIFO lanes and preserves paused hop provenance", async () => {
  const started: Array<{ agent: string; origin: string; replyTo?: string; fromAgent?: string }> =
    [];
  const engine = new RoomEngine({
    runLane: async (lane) => {
      started.push(lane);
      return { text: "done", status: "completed", messageId: `new-${lane.agent}` };
    },
  });
  engine.bindSession("chat-room-test");
  const journal = [
    queuedJournalLane(1, "claude", "turn-completed", "operator"),
    terminalJournalEvent(
      2,
      "lane.completed",
      "turn-completed:claude:0",
      "claude",
      "turn-completed",
    ),
    queuedJournalLane(3, "codex", "turn-cancelled", "operator"),
    terminalJournalEvent(4, "lane.cancelled", "turn-cancelled:codex:0", "codex", "turn-cancelled"),
    queuedJournalLane(5, "gemini", "turn-failed", "operator"),
    terminalJournalEvent(6, "lane.failed", "turn-failed:gemini:0", "gemini", "turn-failed"),
    queuedJournalLane(7, "claude", "turn-queued", "operator"),
    queuedJournalLane(8, "claude", "turn-active", "operator"),
    roomJournalEvent(9, "room.resumed", "room", {}),
    queuedJournalLane(10, "codex", "turn-hop", "agent", {
      replyTo: "canonical-parent",
      fromAgent: "claude",
    }),
    roomJournalEvent(11, "room.paused", "room", {}),
  ];
  engine.rehydrate(journal);
  expect(started).toEqual([]);
  await engine.resume();
  await engine.whenIdle();
  expect(started.map((item) => item.agent)).toEqual(["claude", "codex", "claude"]);
  expect(started[1]).toMatchObject({
    origin: "agent",
    replyTo: "canonical-parent",
    fromAgent: "claude",
  });
  expect(engine.events().at(-1)?.eventSeq).toBe("21");
  expect(new Set(engine.events().map((event) => event.eventId)).size).toBe(engine.events().length);
});
