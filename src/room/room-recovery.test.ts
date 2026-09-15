import { expect, it } from "vitest";
import type { ChatSession } from "../chat/types.js";
import type { RoomEvent } from "./room-engine.js";
import { repairRoomState } from "./room-recovery.js";

it("recovers a committed queued lane without placing earlier ledger rows after later transcript rows", () => {
  const session = recoverySession();
  const accepted = event(1, "turn.accepted", {
    agents: ["claude"],
    text: "work",
    messageId: "user-1",
    ledgerSeq: "1",
  });
  const lane = event(1, "lane.queued", {
    agent: "claude",
    laneId: "turn-1:user-1:claude:0",
    text: "work",
    origin: "operator",
    hopIndex: 0,
    parentMessageId: "user-1",
    expectedMessageId: "agent-1",
  });
  const result = repairRoomState({
    session,
    journal: [accepted, { ...lane, eventSeq: "2", eventId: "event-2" }],
    rows: [
      {
        ledgerSeq: 1,
        message: message({
          id: "user-1",
          role: "user",
          agent: "user",
          text: "work",
          dispatchedAgents: ["claude"],
        }),
      },
      {
        ledgerSeq: 2,
        message: message({ id: "agent-1", role: "agent", agent: "claude", text: "done" }),
      },
    ],
  });
  expect(result.session.messages.map((message) => message.id)).toEqual(["user-1", "agent-1"]);
  expect(result.appended.map((event) => event.type)).toEqual([
    "route.resolved",
    "message.committed",
    "lane.completed",
    "turn.completed",
  ]);
  expectSecondRecoveryIsNoop(result);
});

function expectSecondRecoveryIsNoop(result: ReturnType<typeof repairRoomState>): void {
  const second = repairRoomState({
    session: result.session,
    journal: result.journal,
    rows: recoveryRows(),
  });
  expect(second.appended).toEqual([]);
  expect(second.journal).toEqual(result.journal);
  expect(second.session).toEqual(result.session);
}

function recoveryRows() {
  return [
    {
      ledgerSeq: 1,
      message: message({
        id: "user-1",
        role: "user",
        agent: "user",
        text: "work",
        dispatchedAgents: ["claude"],
      }),
    },
    {
      ledgerSeq: 2,
      message: message({ id: "agent-1", role: "agent", agent: "claude", text: "done" }),
    },
  ];
}

function recoverySession(): ChatSession {
  return {
    id: "chat-recovery",
    repoRoot: "/repo",
    runDir: "/repo/run",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    defaultAgent: "claude",
    lastAgent: null,
    summary: { text: "", throughTurn: 0 },
    messages: [message({ id: "agent-1", role: "agent", agent: "claude", text: "done" })],
  };
}

function message(input: {
  id: string;
  role: "user" | "agent";
  agent: "user" | "claude";
  text: string;
  dispatchedAgents?: readonly "claude"[];
}) {
  const { id, role, agent, text, dispatchedAgents } = input;
  return {
    id,
    turn: 1,
    role,
    agent,
    text,
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "completed" as const,
    tokenEstimate: 1,
    ...(dispatchedAgents === undefined ? {} : { dispatchedAgents }),
  };
}
function event(seq: number, type: RoomEvent["type"], payload: Record<string, unknown>): RoomEvent {
  return {
    protocol: "zer0.room",
    version: 1,
    sessionId: "chat-recovery",
    eventSeq: String(seq),
    eventId: `event-${seq}`,
    turnId: "turn-1",
    occurredAt: "2026-01-01T00:00:00.000Z",
    type,
    payload,
  };
}
