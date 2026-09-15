/**
 * @file src/room/room-recovery-matrix.test.ts
 * @purpose Compact falsifiers for recovery validation and idempotent repair.
 * @size-justified: Matrix fixtures cover independent crash cuts without duplicating host lifecycle tests.
 */
import { expect, it } from "vitest";
import type { ChatSession } from "../chat/types.js";
import type { RoomEvent } from "./room-engine.js";
import { repairRoomState } from "./room-recovery.js";

it.each([
  ["accepted", (events: RoomEvent[]) => replace(events, 0, { text: "bad" })],
  ["route", (events: RoomEvent[]) => replace(events, 1, { agents: ["codex"] })],
  [
    "queue",
    (events: RoomEvent[]) =>
      replace(
        replace(replace(events, 2, { agent: "codex", laneId: "turn-1:user-1:codex:0" }), 3, {
          agent: "codex",
          laneId: "turn-1:user-1:codex:0",
        }),
        4,
        {
          agent: "codex",
          laneId: "turn-1:user-1:codex:0",
          streamId: "stream:turn-1:user-1:codex:0",
        },
      ),
  ],
  ["commit", (events: RoomEvent[]) => replace(events, 3, { ledgerSeq: "99" })],
  ["terminal", (events: RoomEvent[]) => replace(events, 4, { streamId: undefined })],
])("fails closed on a mismatched %s event", (_name, mutate) => {
  const input = complete();
  expect(() => repairRoomState({ ...input, journal: mutate(input.journal) })).toThrow(
    /room recovery/u,
  );
});

it("repairs a commit-only cut once and preserves ledger order plus arbitrary extras", () => {
  const input = complete();
  const cut = {
    ...input,
    journal: input.journal.slice(0, 4),
    session: { ...input.session, messages: [agentRow(input).message, extra()] },
  };
  const repaired = repairRoomState(cut);
  expect(repaired.appended.map((event) => event.type)).toContain("lane.completed");
  expect(repaired.session.messages.map((message) => message.id)).toEqual([
    "user-1",
    "agent-1",
    "extra",
  ]);
  expect(
    repairRoomState({ ...cut, session: repaired.session, journal: repaired.journal }).appended,
  ).toEqual([]);
});

it("rejects duplicate expected identities", () => {
  const input = complete();
  const original = queueEvent(input);
  const duplicate = {
    ...original,
    eventSeq: "6",
    eventId: "event-6",
    payload: {
      ...original.payload,
      agent: "codex",
      laneId: "turn-1:user-1:codex:0",
    },
  };
  expect(() => repairRoomState({ ...input, journal: [...input.journal, duplicate] })).toThrow(
    "duplicate room recovery expected message id",
  );
});

it.each([
  ["failed", "lane.failed"],
  ["cancelled", "lane.cancelled"],
] as const)("repairs a %s outcome with only its truthful terminal", (status, terminal) => {
  const input = complete();
  const agent = agentRow(input);
  const rows = input.rows.map((row) =>
    row === agent ? { ...row, message: { ...row.message, status } } : row,
  );
  const repaired = repairRoomState({ ...input, journal: input.journal.slice(0, 3), rows });
  expect(repaired.appended.map((event) => event.type)).toEqual([terminal, "turn.completed"]);
  expect(repaired.appended.some((event) => event.type === "message.committed")).toBe(false);
});

it("restores full agent-hop provenance and carries it into the recovered commit", () => {
  const queued = event(1, "lane.queued", {
    agent: "codex",
    laneId: "turn-1:parent:codex:1",
    text: "review",
    origin: "agent",
    hopIndex: 1,
    replyTo: "parent",
    parentMessageId: "parent",
    hopId: "hop:turn-1:parent:claude:codex:1",
    fromAgent: "claude",
    expectedMessageId: "hop-result",
  });
  const input = {
    session: session(),
    journal: [queued],
    rows: [
      {
        ledgerSeq: 1,
        message: {
          ...row("hop-result", "agent", "claude", "done", 1).message,
          agent: "codex" as const,
          turn: 1,
        },
      },
    ],
  };
  const repaired = repairRoomState(input);
  expect(repaired.session.messages[0]?.roomProvenance).toEqual({
    origin: "agent-hop",
    replyTo: "parent",
    rootTurnId: "turn-1",
    hopId: "hop:turn-1:parent:claude:codex:1",
    fromAgent: "claude",
    toAgent: "codex",
    hopIndex: 1,
    hopBudget: 1,
  });
  expect(
    repaired.appended.find((event) => event.type === "message.committed")?.payload,
  ).toMatchObject({ origin: "agent", hopIndex: 1, messageId: "hop-result" });
});

it("waits for every lane before completing a recovered turn exactly once", () => {
  const input = complete();
  const secondQueue = event(6, "lane.queued", {
    agent: "codex",
    laneId: "turn-1:user-1:codex:0",
    text: "work",
    origin: "operator",
    hopIndex: 0,
    parentMessageId: "user-1",
    expectedMessageId: "agent-2",
  });
  const partial = repairRoomState({ ...input, journal: [...input.journal, secondQueue] });
  expect(partial.appended.some((event) => event.type === "turn.completed")).toBe(false);
  const rows = [
    ...input.rows,
    {
      ledgerSeq: 3,
      message: { ...row("agent-2", "agent", "claude", "done", 3).message, agent: "codex" as const },
    },
  ];
  const completeTurn = repairRoomState({
    ...input,
    journal: [...input.journal, secondQueue],
    rows,
  });
  expect(completeTurn.appended.filter((event) => event.type === "turn.completed")).toHaveLength(1);
  expect(
    repairRoomState({
      ...input,
      session: completeTurn.session,
      journal: completeTurn.journal,
      rows,
    }).appended,
  ).toEqual([]);
});

function complete() {
  const accepted = event(1, "turn.accepted", {
    agents: ["claude"],
    text: "work",
    messageId: "user-1",
    ledgerSeq: "1",
  });
  const route = event(2, "route.resolved", { agents: ["claude"] });
  const queued = event(3, "lane.queued", {
    agent: "claude",
    laneId: "turn-1:user-1:claude:0",
    text: "work",
    origin: "operator",
    hopIndex: 0,
    parentMessageId: "user-1",
    expectedMessageId: "agent-1",
  });
  const commit = event(4, "message.committed", {
    agent: "claude",
    laneId: "turn-1:user-1:claude:0",
    messageId: "agent-1",
    ledgerSeq: "2",
    text: "done",
    origin: "operator",
    hopIndex: 0,
  });
  const terminal = event(5, "lane.completed", {
    agent: "claude",
    laneId: "turn-1:user-1:claude:0",
    streamId: "stream:turn-1:user-1:claude:0",
  });
  return {
    session: session(),
    journal: [accepted, route, queued, commit, terminal],
    rows: [row("user-1", "user", "user", "work", 1), row("agent-1", "agent", "claude", "done", 2)],
  };
}

function agentRow(input: ReturnType<typeof complete>) {
  const row = input.rows.find((candidate) => candidate.message.role === "agent");
  if (row === undefined) throw new Error("matrix fixture has no agent row");
  return row;
}

function queueEvent(input: ReturnType<typeof complete>): RoomEvent {
  const event = input.journal.find((candidate) => candidate.type === "lane.queued");
  if (event === undefined) throw new Error("matrix fixture has no queue event");
  return event;
}

function replace(
  events: RoomEvent[],
  index: number,
  payload: Record<string, unknown>,
): RoomEvent[] {
  return events.map((event, current) =>
    current === index ? { ...event, payload: { ...event.payload, ...payload } } : event,
  );
}
function row(
  id: string,
  role: "user" | "agent",
  agent: "user" | "claude",
  text: string,
  ledgerSeq: number,
) {
  return {
    ledgerSeq,
    message: {
      id,
      turn: 1,
      role,
      agent,
      text,
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "completed" as const,
      tokenEstimate: 1,
      ...(role === "user" ? { dispatchedAgents: ["claude"] as const } : {}),
    },
  };
}
function event(seq: number, type: RoomEvent["type"], payload: Record<string, unknown>): RoomEvent {
  return {
    protocol: "zer0.room",
    version: 1,
    sessionId: "chat-matrix",
    eventSeq: String(seq),
    eventId: `event-${seq}`,
    turnId: "turn-1",
    occurredAt: "2026-01-01T00:00:00.000Z",
    type,
    payload,
  };
}
function session(): ChatSession {
  return {
    id: "chat-matrix",
    repoRoot: "/repo",
    runDir: "/repo/run",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    defaultAgent: "claude",
    lastAgent: null,
    summary: { text: "", throughTurn: 0 },
    messages: [],
  };
}
function extra() {
  return {
    id: "extra",
    turn: 1,
    role: "system" as const,
    agent: "system" as const,
    text: "extra",
    createdAt: "2026-01-01T00:00:01.000Z",
    status: "completed" as const,
    tokenEstimate: 0,
  };
}
