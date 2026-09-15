/**
 * @file src/room/room-recovery.ts
 * @purpose Reconcile durable ledger conversation with transcript and room journal before rehydration.
 * @exports recoverRoomState, repairRoomState
 * @depends node:crypto, ../chat/message-id, ../chat/types, ../evidence/blobs, ../evidence/db, ./room-engine, ./room-journal
 * @size-justified: Cohesive recovery projection must validate and repair one durable state boundary.
 */
import { randomUUID } from "node:crypto";
import { mintMessageId } from "../chat/message-id.js";
import type { AgentName, ChatMessage, ChatSession } from "../chat/types.js";
import { getBlobSync } from "../evidence/blobs.js";
import type { Db } from "../evidence/db.js";
import type { RoomEvent } from "./room-engine.js";
import { projectRoomJournal, roomLaneIdentity } from "./room-journal.js";

export interface LedgerConversationMessage {
  readonly message: ChatMessage;
  readonly ledgerSeq: number;
}

export function recoverRoomState(input: {
  readonly db: Db;
  readonly projectId: string;
  readonly session: ChatSession;
  readonly blobRoot: string;
  readonly journal: readonly RoomEvent[];
}): {
  readonly session: ChatSession;
  readonly journal: readonly RoomEvent[];
  readonly appended: readonly RoomEvent[];
} {
  const rows = readConversationRows(input.db, input.projectId, input.session.id, input.blobRoot);
  return repairRoomState({ session: input.session, journal: input.journal, rows });
}

export function repairRoomState(input: {
  readonly session: ChatSession;
  readonly journal: readonly RoomEvent[];
  readonly rows: readonly LedgerConversationMessage[];
}): {
  readonly session: ChatSession;
  readonly journal: readonly RoomEvent[];
  readonly appended: readonly RoomEvent[];
} {
  projectRoomJournal(input.journal, input.session.id);
  validateRows(input.rows);
  const queued = queuedByExpectedId(input.journal);
  validateExistingEvents(input.journal, input.rows, queued);
  const withProvenance = input.rows.map((row) => ({
    ...row,
    message: restoreProvenance(row.message, queued),
  }));
  const appended = repairJournal(input.journal, withProvenance).map((event) => ({
    ...event,
    sessionId: input.session.id,
  }));
  return {
    session: mergeTranscript(input.session, withProvenance),
    journal: [...input.journal, ...appended],
    appended,
  };
}

interface ConversationRow {
  readonly id: string;
  readonly turn: number;
  readonly role: "user" | "agent";
  readonly agent: "user" | AgentName;
  readonly textBlobHash: string;
  readonly createdAt: string;
  readonly status: "completed" | "failed" | "cancelled";
  readonly tokenEstimate: number;
  readonly dispatchedAgents: string | null;
  readonly ledgerSeq: number;
}

function readConversationRows(
  db: Db,
  projectId: string,
  sessionId: string,
  blobRoot: string,
): readonly LedgerConversationMessage[] {
  const rows = db
    .prepare(
      "SELECT m.id, m.turn, m.role, m.agent, m.text_blob_hash AS textBlobHash, m.created_at AS createdAt, m.status, m.token_estimate AS tokenEstimate, m.dispatched_agents AS dispatchedAgents, l.seq AS ledgerSeq FROM chat_messages m JOIN ledger_seq l ON l.message_id = m.id AND l.project_id = ? WHERE m.session_id = ? ORDER BY l.seq",
    )
    .all(projectId, sessionId) as readonly ConversationRow[];
  return rows.map((row) => ({ ledgerSeq: row.ledgerSeq, message: rowMessage(row, blobRoot) }));
}

function rowMessage(row: ConversationRow, blobRoot: string): ChatMessage {
  if (!Number.isSafeInteger(row.ledgerSeq) || row.ledgerSeq < 1)
    throw new Error("invalid room recovery ledger sequence");
  if (row.role === "user" && (row.agent !== "user" || row.dispatchedAgents === null))
    throw new Error("invalid room recovery operator row");
  if (row.role === "agent" && !isAgent(row.agent))
    throw new Error("invalid room recovery agent row");
  return {
    id: row.id,
    turn: row.turn,
    role: row.role,
    agent: row.agent,
    text: getBlobSync({ rootDir: blobRoot }, row.textBlobHash).toString("utf8"),
    createdAt: row.createdAt,
    status: row.status,
    tokenEstimate: row.tokenEstimate,
    ...parseAgents(row.dispatchedAgents),
  };
}

function parseAgents(value: string | null): Pick<ChatMessage, "dispatchedAgents"> {
  if (value === null) return {};
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every(isAgent) ||
    new Set(parsed).size !== parsed.length
  )
    throw new Error("invalid room recovery route");
  return { dispatchedAgents: parsed };
}

function validateRows(rows: readonly LedgerConversationMessage[]): void {
  let previous = 0;
  const ids = new Set<string>();
  for (const row of rows) {
    if (
      !Number.isSafeInteger(row.ledgerSeq) ||
      row.ledgerSeq <= previous ||
      ids.has(row.message.id)
    )
      throw new Error("corrupt room recovery ledger order");
    previous = row.ledgerSeq;
    ids.add(row.message.id);
  }
}

function queuedByExpectedId(events: readonly RoomEvent[]): ReadonlyMap<string, RoomEvent> {
  const queued = new Map<string, RoomEvent>();
  for (const event of events)
    if (event.type === "lane.queued" && typeof event.payload.expectedMessageId === "string") {
      if (queued.has(event.payload.expectedMessageId))
        throw new Error("duplicate room recovery expected message id");
      queued.set(event.payload.expectedMessageId, event);
    }
  return queued;
}

function restoreProvenance(
  message: ChatMessage,
  queued: ReadonlyMap<string, RoomEvent>,
): ChatMessage {
  if (message.role !== "agent") return message;
  if (!isAgent(message.agent)) throw new Error("invalid room recovery agent message");
  const lane = queued.get(message.id);
  if (lane === undefined) throw new Error("room recovery agent row has no queued lane");
  if (lane.payload.agent !== message.agent || lane.turnId !== `turn-${message.turn}`)
    throw new Error("room recovery lane does not match durable agent row");
  const hop = lane.payload.origin === "agent";
  return {
    ...message,
    roomProvenance: {
      origin: hop ? "agent-hop" : "operator",
      ...(typeof lane.payload.replyTo === "string" ? { replyTo: lane.payload.replyTo } : {}),
      rootTurnId: lane.turnId,
      ...(hop
        ? {
            hopId: requiredString(lane.payload.hopId, "hop id"),
            fromAgent: requiredAgent(lane.payload.fromAgent),
            toAgent: message.agent,
          }
        : {}),
      hopIndex: requiredNumber(lane.payload.hopIndex, "hop index"),
      hopBudget: 1,
    },
  };
}

function mergeTranscript(
  session: ChatSession,
  rows: readonly LedgerConversationMessage[],
): ChatSession {
  const existing = new Map(session.messages.map((message) => [message.id, message]));
  const conversation = rows.map((row) => ({ ...existing.get(row.message.id), ...row.message }));
  const ledgerIds = new Set(rows.map((row) => row.message.id));
  const extras = session.messages.filter((message) => !ledgerIds.has(message.id));
  const messages = [...conversation, ...extras];
  return { ...session, messages, updatedAt: session.updatedAt };
}

function validateExistingEvents(
  events: readonly RoomEvent[],
  rows: readonly LedgerConversationMessage[],
  queued: ReadonlyMap<string, RoomEvent>,
): void {
  const byId = new Map(rows.map((row) => [row.message.id, row]));
  for (const event of events) {
    if (event.type === "turn.accepted") validateAccepted(event, rows);
    if (event.type === "route.resolved") validateRoute(event, rows);
    if (event.type === "lane.queued") validateQueued(event, byId, queued);
    if (event.type === "message.committed") validateCommit(event, byId, queued);
    if (isLaneTerminal(event.type)) validateTerminal(event, byId, queued);
  }
}

function validateRoute(event: RoomEvent, rows: readonly LedgerConversationMessage[]): void {
  const row = rows.find(
    (candidate) =>
      candidate.message.role === "user" && `turn-${candidate.message.turn}` === event.turnId,
  );
  if (row === undefined || !sameAgents(event.payload.agents, row.message.dispatchedAgents))
    throw new Error("room recovery route event mismatch");
}

function validateAccepted(event: RoomEvent, rows: readonly LedgerConversationMessage[]): void {
  const row = rows.find(
    (candidate) =>
      candidate.message.role === "user" && `turn-${candidate.message.turn}` === event.turnId,
  );
  if (
    row === undefined ||
    event.payload.messageId !== row.message.id ||
    event.payload.ledgerSeq !== String(row.ledgerSeq) ||
    event.payload.text !== row.message.text ||
    !sameAgents(event.payload.agents, row.message.dispatchedAgents)
  )
    throw new Error("room recovery accepted event mismatch");
}

function validateQueued(
  event: RoomEvent,
  rows: ReadonlyMap<string, LedgerConversationMessage>,
  queued: ReadonlyMap<string, RoomEvent>,
): void {
  const expected = event.payload.expectedMessageId;
  if (typeof expected !== "string") return;
  const row = rows.get(expected);
  if (row === undefined || row.message.role !== "agent") return;
  if (
    queued.get(expected) !== event ||
    event.payload.agent !== row.message.agent ||
    event.turnId !== `turn-${row.message.turn}`
  )
    throw new Error("room recovery queued event mismatch");
}

function validateCommit(
  event: RoomEvent,
  rows: ReadonlyMap<string, LedgerConversationMessage>,
  queued: ReadonlyMap<string, RoomEvent>,
): void {
  const id = event.payload.messageId;
  const row = typeof id === "string" ? rows.get(id) : undefined;
  if (
    row === undefined ||
    row.message.role !== "agent" ||
    event.payload.ledgerSeq !== String(row.ledgerSeq) ||
    event.payload.text !== row.message.text ||
    queued.get(row.message.id)?.payload.laneId !== event.payload.laneId ||
    event.payload.agent !== row.message.agent ||
    event.payload.origin !== queued.get(row.message.id)?.payload.origin ||
    event.payload.hopIndex !== queued.get(row.message.id)?.payload.hopIndex
  )
    throw new Error("room recovery committed event mismatch");
}

function validateTerminal(
  event: RoomEvent,
  rows: ReadonlyMap<string, LedgerConversationMessage>,
  queued: ReadonlyMap<string, RoomEvent>,
): void {
  const laneId = event.payload.laneId;
  if (typeof laneId !== "string") throw new Error("room recovery terminal has no lane id");
  const lane = [...queued.values()].find((candidate) => candidate.payload.laneId === laneId);
  if (
    lane === undefined ||
    event.payload.agent !== lane.payload.agent ||
    event.turnId !== lane.turnId
  )
    throw new Error("room recovery terminal lane mismatch");
  if (event.type === "lane.completed" && event.payload.streamId !== `stream:${laneId}`)
    throw new Error("room recovery completed stream mismatch");
  const row =
    typeof lane.payload.expectedMessageId === "string"
      ? rows.get(lane.payload.expectedMessageId)
      : undefined;
  if (row === undefined) return;
  if (
    (event.type === "lane.completed" && row.message.status !== "completed") ||
    (event.type === "lane.failed" && row.message.status !== "failed") ||
    (event.type === "lane.cancelled" && row.message.status !== "cancelled")
  )
    throw new Error("room recovery terminal status mismatch");
}

function isLaneTerminal(type: RoomEvent["type"]): boolean {
  return type === "lane.completed" || type === "lane.failed" || type === "lane.cancelled";
}

function sameAgents(value: unknown, expected: readonly AgentName[] | undefined): boolean {
  return (
    Array.isArray(value) &&
    expected !== undefined &&
    value.length === expected.length &&
    value.every((agent, index) => agent === expected[index])
  );
}

function repairJournal(
  events: readonly RoomEvent[],
  rows: readonly LedgerConversationMessage[],
): readonly RoomEvent[] {
  const knownMessages = new Set(
    events
      .filter((event) => event.type === "message.committed")
      .map((event) => event.payload.messageId),
  );
  const accepted = new Set(
    events.filter((event) => event.type === "turn.accepted").map((event) => event.turnId),
  );
  const queued = queuedByExpectedId(events);
  const terminal = terminalLaneIds(events);
  const appended: RoomEvent[] = [];
  let sequence = events.length === 0 ? 0n : BigInt(events.at(-1)?.eventSeq ?? "0");
  for (const row of rows)
    sequence = repairRow({
      row,
      events,
      appended,
      accepted,
      queued,
      terminal,
      knownMessages,
      sequence,
    });
  return appendTurnCompletions(events, appended, sequence);
}

function repairRow(input: {
  row: LedgerConversationMessage;
  events: readonly RoomEvent[];
  appended: RoomEvent[];
  accepted: ReadonlySet<string>;
  queued: ReadonlyMap<string, RoomEvent>;
  terminal: ReadonlySet<string>;
  knownMessages: ReadonlySet<unknown>;
  sequence: bigint;
}): bigint {
  if (input.row.message.role === "user") return repairOperatorRow(input);
  return repairAgentRow(input);
}

function repairOperatorRow(input: {
  row: LedgerConversationMessage;
  events: readonly RoomEvent[];
  appended: RoomEvent[];
  accepted: ReadonlySet<string>;
  sequence: bigint;
}): bigint {
  const turnId = `turn-${input.row.message.turn}`;
  const existing = input.events.filter((event) => event.turnId === turnId);
  const agents = input.row.message.dispatchedAgents ?? [];
  let sequence = input.sequence;
  if (!input.accepted.has(turnId)) input.appended.push(operatorAccepted(input.row, ++sequence));
  if (!existing.some((event) => event.type === "route.resolved"))
    input.appended.push(event(turnId, "route.resolved", { agents }, ++sequence));
  const queued = new Set(
    existing.filter((event) => event.type === "lane.queued").map((event) => event.payload.agent),
  );
  for (const agent of agents)
    if (!queued.has(agent))
      input.appended.push(
        operatorQueued(
          input.row,
          agent,
          ++sequence,
          isPaused(input.events),
          busyAgents(input.events),
        ),
      );
  return sequence;
}

function operatorAccepted(row: LedgerConversationMessage, sequence: bigint): RoomEvent {
  const message = row.message;
  return event(
    `turn-${message.turn}`,
    "turn.accepted",
    {
      agents: message.dispatchedAgents ?? [],
      text: message.text,
      messageId: message.id,
      ledgerSeq: String(row.ledgerSeq),
    },
    sequence,
  );
}

function operatorQueued(
  row: LedgerConversationMessage,
  agent: AgentName,
  sequence: bigint,
  paused: boolean,
  busy: ReadonlySet<AgentName>,
): RoomEvent {
  const message = row.message;
  const turnId = `turn-${message.turn}`;
  const lane = {
    agent,
    turnId,
    text: message.text,
    hopIndex: 0,
    origin: "operator" as const,
    parentMessageId: message.id,
    expectedMessageId: mintMessageId(agent),
  };
  return event(
    turnId,
    "lane.queued",
    { ...lane, ...roomLaneIdentity(lane), paused, busy: busy.has(agent) },
    sequence,
  );
}

function repairAgentRow(input: {
  row: LedgerConversationMessage;
  appended: RoomEvent[];
  queued: ReadonlyMap<string, RoomEvent>;
  terminal: ReadonlySet<string>;
  knownMessages: ReadonlySet<unknown>;
  sequence: bigint;
}): bigint {
  const lane = input.queued.get(input.row.message.id);
  if (lane === undefined) return input.sequence;
  let sequence = input.sequence;
  const laneId = String(lane.payload.laneId);
  if (input.row.message.status === "completed" && !input.knownMessages.has(input.row.message.id))
    input.appended.push(recoveredCommit(lane, input.row, ++sequence));
  if (!input.terminal.has(laneId))
    input.appended.push(
      input.row.message.status === "completed"
        ? recoveredTerminal(lane, ++sequence)
        : recoveredFailureTerminal(lane, input.row.message.status, ++sequence),
    );
  return sequence;
}

function isPaused(events: readonly RoomEvent[]): boolean {
  return events.reduce(
    (paused, event) =>
      event.type === "room.paused" ? true : event.type === "room.resumed" ? false : paused,
    false,
  );
}

function busyAgents(events: readonly RoomEvent[]): ReadonlySet<AgentName> {
  const queued = new Map<string, AgentName>();
  const terminal = new Set<string>();
  for (const event of events) {
    if (
      event.type === "lane.queued" &&
      isAgent(event.payload.agent) &&
      typeof event.payload.laneId === "string"
    )
      queued.set(event.payload.laneId, event.payload.agent);
    if (
      (event.type === "lane.completed" ||
        event.type === "lane.failed" ||
        event.type === "lane.cancelled") &&
      typeof event.payload.laneId === "string"
    )
      terminal.add(event.payload.laneId);
  }
  return new Set([...queued].filter(([laneId]) => !terminal.has(laneId)).map(([, agent]) => agent));
}

function appendTurnCompletions(
  events: readonly RoomEvent[],
  appended: readonly RoomEvent[],
  sequence: bigint,
): readonly RoomEvent[] {
  const all = [...events, ...appended];
  const lanes = new Map<string, Set<string>>();
  const terminal = new Set<string>();
  const completed = new Set<string>();
  for (const event of all) {
    if (event.type === "lane.queued" && typeof event.payload.laneId === "string")
      (
        lanes.get(event.turnId) ??
        (lanes.set(event.turnId, new Set()).get(event.turnId) as Set<string>)
      ).add(event.payload.laneId);
    if (
      (event.type === "lane.completed" ||
        event.type === "lane.failed" ||
        event.type === "lane.cancelled") &&
      typeof event.payload.laneId === "string"
    )
      terminal.add(event.payload.laneId);
    if (event.type === "turn.completed") completed.add(event.turnId);
  }
  const result = [...appended];
  let next = sequence;
  for (const [turnId, ids] of lanes)
    if (!completed.has(turnId) && ids.size > 0 && [...ids].every((id) => terminal.has(id)))
      result.push(event(turnId, "turn.completed", { recovered: true }, ++next));
  return result;
}

function terminalLaneIds(events: readonly RoomEvent[]): ReadonlySet<string> {
  const result = new Set<string>();
  for (const event of events)
    if (isLaneTerminal(event.type) && typeof event.payload.laneId === "string")
      result.add(event.payload.laneId);
  return result;
}

function recoveredCommit(
  queued: RoomEvent,
  row: LedgerConversationMessage,
  sequence: bigint,
): RoomEvent {
  return event(
    queued.turnId,
    "message.committed",
    {
      agent: queued.payload.agent,
      laneId: queued.payload.laneId,
      messageId: row.message.id,
      ledgerSeq: String(row.ledgerSeq),
      text: row.message.text,
      origin: queued.payload.origin,
      hopIndex: queued.payload.hopIndex,
      recovered: true,
    },
    sequence,
  );
}
function recoveredTerminal(queued: RoomEvent, sequence: bigint): RoomEvent {
  return event(
    queued.turnId,
    "lane.completed",
    {
      agent: queued.payload.agent,
      laneId: queued.payload.laneId,
      streamId: `stream:${String(queued.payload.laneId)}`,
      recovered: true,
    },
    sequence,
  );
}
function recoveredFailureTerminal(
  queued: RoomEvent,
  status: "failed" | "cancelled",
  sequence: bigint,
): RoomEvent {
  return event(
    queued.turnId,
    status === "failed" ? "lane.failed" : "lane.cancelled",
    { agent: queued.payload.agent, laneId: queued.payload.laneId, recovered: true },
    sequence,
  );
}
function event(
  turnId: string,
  type: RoomEvent["type"],
  payload: Record<string, unknown>,
  sequence: bigint,
): RoomEvent {
  return {
    protocol: "zer0.room",
    version: 1,
    sessionId: "",
    eventSeq: sequence.toString(),
    eventId: `room-recovered-${randomUUID()}`,
    turnId,
    occurredAt: new Date().toISOString(),
    type,
    payload,
  };
}
function isAgent(value: unknown): value is AgentName {
  return value === "claude" || value === "codex" || value === "gemini";
}
function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`invalid room recovery ${name}`);
  return value;
}
function requiredAgent(value: unknown): AgentName {
  if (!isAgent(value)) throw new Error("invalid room recovery hop agent");
  return value;
}
function requiredNumber(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`invalid room recovery ${name}`);
  return value as number;
}
