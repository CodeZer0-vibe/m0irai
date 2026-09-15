/**
 * @file src/room/room-host-carrier.test.ts
 * @purpose Minimal real RoomHost carrier seam proof with durable native lane state.
 * @exports none
 * @depends node:fs/promises, node:os, node:path, execa, vitest, ../adapters/acp/acp-lane-session, ../evidence/db, ./room-host
 * @size-justified: Cohesive end-to-end carrier restart fixture binds transport traces to durable SQL projections.
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, expect, it } from "vitest";
import type { LaneConnection } from "../adapters/acp/acp-lane-session.js";
import type { HeadlessDispatch } from "../chat/dispatch-headless.js";
import { runHeadlessTurn as runActualHeadlessTurn } from "../chat/headless-turn.js";
import { carrierRuntime } from "../chat/lane-transport.js";
import type { AgentName } from "../chat/types.js";
import { closeDb, openDb } from "../evidence/db.js";
import type { RoomEvent } from "./room-engine.js";
import type { RoomHostOptions } from "./room-host.js";
import { AliveRoomHost } from "./room-host.js";
import {
  DEFAULT_POLL_TIMEOUT_MS,
  cleanupTestRoot,
  pollUntil,
} from "./room-test-cleanup.fixtures.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => cleanupTestRoot(root)));
});

// FL-175 round 4 I3: 180_000 ms was 1.945x a number that was never actually a measurement — the
// round-3 red fired AT its then-90_000 ms budget (92,519 ms), so the true requirement was only known to
// be "at least 92,519", never what it really is. Re-measured properly this round: a temporarily
// generous 600_000 ms ceiling (never fired), four consecutive single-process runs on this box today,
// none capped: 47,944 ms, 31,235 ms, 31,165 ms (inside the full src/room + digest-runner selection),
// 41,927 ms. Worst genuine observation: 47,944 ms. 120_000 ms is >=2x that (2.5x), and it also clears
// the round-3 reviewer's 92,519 ms lower bound with real room (1.3x) rather than barely exceeding it —
// this test has already had its budget raised three times in this lane, so the margin here is set
// above both this session's worst and the last session's floor, not just the bare 2x minimum. Honesty
// note: 92,519 was itself a lower bound on a heavier-loaded box than any this session reached, so a
// future run heavier than today's still cannot be ruled out; if this fires again, re-measure rather
// than doubling blind.
it("recovers terminal native lanes without rerun and resumes Codex with its durable session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zer0-room-carrier-"));
  roots.push(root);
  await execa("git", ["init", "-q"], { cwd: root, shell: false });
  const priorMemory = process.env.ZER0_MEMORY;
  const priorNative = process.env.ZER0_NATIVE_RESUME;
  process.env.ZER0_MEMORY = "1";
  process.env.ZER0_NATIVE_RESUME = "1";
  const dbPath = path.join(root, ".zer0", "evidence.db");
  const blobRoot = path.join(root, ".zer0", "blobs");
  const marker = "CARRIER-CLAUDE-MARKER";
  const carrier = scriptedCarrier({
    // The production headless prompt reserves the last non-empty line for the handoff directive.
    // Keeping ordinary prose first proves the room boundary strips control syntax without losing it.
    claude: [`${marker}\n@codex: inspect the carried Claude result`],
    codex: ["codex seeded", "codex later"],
  });
  let host1: AliveRoomHost | undefined;
  let host2: AliveRoomHost | undefined;
  try {
    host1 = await createCarrierHost({ root, dbPath, blobRoot, carrier });
    const firstRoom = host1;
    await completeInitialCarrierTurn({ room: firstRoom, carrier, marker, dbPath });
    await seedNativeCodexTurn({ room: firstRoom, carrier, dbPath });
    const initial = snapshotCarrierState({ room: firstRoom, carrier, dbPath });
    await host1.shutdown();
    host1 = undefined;
    expect(carrierRuntime()).toBeUndefined();
    const liveEvents: RoomEvent[] = [];
    host2 = await createCarrierHost({
      root,
      dbPath,
      blobRoot,
      carrier,
      continueSessionId: firstRoom.sessionId() as `chat-${string}`,
      onEvent: (event) => liveEvents.push(event),
    });
    assertDormantRecovery({ room: host2, carrier, dbPath, initial, liveEvents });
    await assertActivatedDormantRecovery({ room: host2, carrier, dbPath, initial, liveEvents });
    await assertResumedCodexTurn({ room: host2, carrier, dbPath, initial });
  } finally {
    await host2?.shutdown().catch(() => undefined);
    await host1?.shutdown().catch(() => undefined);
    expect(carrierRuntime()).toBeUndefined();
    restoreEnv("ZER0_MEMORY", priorMemory);
    restoreEnv("ZER0_NATIVE_RESUME", priorNative);
  }
}, 120_000);

function createCarrierHost(input: {
  readonly root: string;
  readonly dbPath: string;
  readonly blobRoot: string;
  readonly carrier: ScriptedCarrier;
  readonly continueSessionId?: `chat-${string}`;
  readonly onEvent?: (event: RoomEvent) => void;
}): Promise<AliveRoomHost> {
  return AliveRoomHost.create({
    repoRoot: input.root,
    dbPath: input.dbPath,
    blobRoot: input.blobRoot,
    openConnection: input.carrier.openConnection,
    runHeadlessTurn: (turn) =>
      runActualHeadlessTurn(
        turn.grant === undefined ? { ...turn, dispatch: input.carrier.grantlessDispatch } : turn,
      ),
    // This recovery fixture owns carrier resumption explicitly below. Eager startup has its own
    // room-level falsifier and is disabled here so dormant recovery remains the behavior under test.
    startEagerSessionBoot: () => ({
      claude: Promise.resolve({ outcome: "ready" }),
      codex: Promise.resolve({ outcome: "ready" }),
      gemini: Promise.resolve({ outcome: "ready" }),
    }),
    ...(input.continueSessionId === undefined
      ? {}
      : { continueSessionId: input.continueSessionId }),
    ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
  });
}

async function completeInitialCarrierTurn(input: {
  readonly room: AliveRoomHost;
  readonly carrier: ScriptedCarrier;
  readonly marker: string;
  readonly dbPath: string;
}): Promise<void> {
  const submitted = await input.room.submit({ requestId: "carrier", text: "@claude hello" });
  await waitFor(() => input.room.eventsAfter("0").some((event) => event.type === "turn.completed"));
  assertCompletedHop({ ...input, submitted });
}

function assertCompletedHop(input: {
  readonly room: AliveRoomHost;
  readonly carrier: ScriptedCarrier;
  readonly marker: string;
  readonly submitted: { readonly messageId: string; readonly targets: readonly AgentName[] };
  readonly dbPath: string;
}): void {
  const { room, carrier, marker, submitted, dbPath } = input;
  const events = room.eventsAfter("0");
  expect(carrier.newSessions).toEqual([{ agent: "claude", sessionId: "native-claude-1" }]);
  expect(carrier.prompts).toHaveLength(1);
  expect(carrier.prompts[0]).toMatchObject({ agent: "claude", sessionId: "native-claude-1" });
  expect(carrier.grantlessPrompts).toHaveLength(1);
  const codexPrompt = carrier.grantlessPrompts[0] ?? "";
  expect(codexPrompt).toContain(`claude: ${marker}`);
  expect(codexPrompt).toContain("Operator: inspect the carried Claude result");
  expect(codexPrompt.split(marker)).toHaveLength(2);
  expect(events.filter((event) => event.type === "hop.dispatched")).toEqual([
    expect.objectContaining({
      payload: expect.objectContaining({ fromAgent: "claude", toAgent: "codex", hopIndex: 1 }),
    }),
  ]);
  const committed = assertCommittedQueuedIdentity(events);
  expect(submitted.targets).toEqual(["claude"]);
  assertPersistedCarrierState({
    dbPath,
    sessionId: room.sessionId(),
    submittedMessageId: submitted.messageId,
    committed,
  });
}

function assertCommittedQueuedIdentity(
  events: ReturnType<AliveRoomHost["eventsAfter"]>,
): Record<"claude" | "codex", string> {
  const commitIds = {} as Record<"claude" | "codex", string>;
  for (const agent of ["claude", "codex"] as const) {
    const queued = events.find(
      (event) => event.type === "lane.queued" && event.payload.agent === agent,
    );
    const committedEvent = events.find(
      (event) => event.type === "message.committed" && event.payload.agent === agent,
    );
    const messageId = committedEvent?.payload.messageId;
    expect(messageId).toBe(queued?.payload.expectedMessageId);
    if (typeof messageId !== "string") throw new Error(`missing ${agent} committed message ID`);
    commitIds[agent] = messageId;
  }
  return commitIds;
}

function assertPersistedCarrierState(input: {
  readonly dbPath: string;
  readonly sessionId: string;
  readonly submittedMessageId: string;
  readonly committed: Record<"claude" | "codex", string>;
}): void {
  const db = openDb(input.dbPath);
  try {
    const projectId = projectIdForSession(db, input.sessionId);
    assertLedgerProjection(db, projectId, input);
    assertInitialCarrierProjection(db, projectId);
  } finally {
    closeDb(db);
  }
}

function projectIdForSession(db: ReturnType<typeof openDb>, sessionId: string): string {
  const row = db
    .prepare("SELECT project_id AS projectId FROM chat_sessions WHERE id = ?")
    .get(sessionId) as { projectId: string | null } | undefined;
  if (row?.projectId === undefined || row.projectId === null)
    throw new Error(`room session ${sessionId} has no project scope`);
  return row.projectId;
}

function assertLedgerProjection(
  db: ReturnType<typeof openDb>,
  projectId: string,
  input: Parameters<typeof assertPersistedCarrierState>[0],
): void {
  const rows = db
    .prepare(
      `SELECT ledger.seq AS seq, ledger.message_id AS messageId, messages.status AS status
       FROM ledger_seq AS ledger
       JOIN chat_messages AS messages ON messages.id = ledger.message_id
       WHERE ledger.project_id = ? AND messages.session_id = ?
       ORDER BY ledger.seq ASC`,
    )
    .all(projectId, input.sessionId) as Array<{ seq: number; messageId: string; status: string }>;
  expect(rows).toEqual([
    { seq: 1, messageId: input.submittedMessageId, status: "completed" },
    { seq: 2, messageId: input.committed.claude, status: "completed" },
    { seq: 3, messageId: input.committed.codex, status: "completed" },
  ]);
}

function assertInitialCarrierProjection(db: ReturnType<typeof openDb>, projectId: string): void {
  expect(
    db
      .prepare(
        "SELECT agent, session_id AS sessionId, generation FROM lane_sessions WHERE project_id = ? ORDER BY agent ASC",
      )
      .all(projectId),
  ).toEqual([{ agent: "claude", sessionId: "native-claude-1", generation: 1 }]);
  expect(
    db
      .prepare(
        `SELECT agent, generation, last_seq AS lastSeq FROM lane_cursors
         WHERE project_id = ? ORDER BY agent ASC`,
      )
      .all(projectId),
  ).toEqual([{ agent: "claude", generation: 1, lastSeq: 1 }]);
  expect(scopedCount(db, "lane_prompt_attempts", "project_id", projectId)).toBe(1);
}

async function seedNativeCodexTurn(input: {
  readonly room: AliveRoomHost;
  readonly carrier: ScriptedCarrier;
  readonly dbPath: string;
}): Promise<void> {
  const priorCompleted = completedTurns(input.room);
  const priorConnections = input.carrier.connections.length;
  await input.room.submit({ requestId: "carrier-seed", text: "@codex seed" });
  await waitFor(() => completedTurns(input.room) === priorCompleted + 1);
  expect(input.carrier.connections.slice(priorConnections)).toEqual([
    expect.objectContaining({
      agent: "codex",
      newSessions: ["native-codex-1"],
      resumes: [],
    }),
  ]);
  const db = openDb(input.dbPath);
  try {
    const projectId = projectIdForSession(db, input.room.sessionId());
    expect(scopedCount(db, "lane_prompt_attempts", "project_id", projectId)).toBe(2);
    expect(
      db
        .prepare(
          "SELECT last_seq AS lastSeq FROM lane_cursors WHERE project_id = ? AND agent = 'codex'",
        )
        .get(projectId),
    ).toEqual({ lastSeq: 4 });
  } finally {
    closeDb(db);
  }
}

interface CarrierStateSnapshot {
  readonly laneSessions: readonly {
    readonly agent: string;
    readonly sessionId: string;
    readonly generation: number;
  }[];
  readonly replay: readonly RoomEvent[];
  readonly connectionCount: number;
  readonly promptCount: number;
  readonly messageCount: number;
  readonly attemptCount: number;
}

function snapshotCarrierState(input: {
  readonly room: AliveRoomHost;
  readonly carrier: ScriptedCarrier;
  readonly dbPath: string;
}): CarrierStateSnapshot {
  const db = openDb(input.dbPath);
  try {
    const projectId = projectIdForSession(db, input.room.sessionId());
    return {
      laneSessions: db
        .prepare(
          "SELECT agent, session_id AS sessionId, generation FROM lane_sessions WHERE project_id = ? ORDER BY agent ASC",
        )
        .all(projectId) as CarrierStateSnapshot["laneSessions"],
      replay: input.room.eventsAfter("0"),
      connectionCount: input.carrier.connections.length,
      promptCount: input.carrier.prompts.length,
      messageCount: scopedCount(db, "chat_messages", "session_id", input.room.sessionId()),
      attemptCount: scopedCount(db, "lane_prompt_attempts", "project_id", projectId),
    };
  } finally {
    closeDb(db);
  }
}

function scopedCount(
  db: ReturnType<typeof openDb>,
  table: "chat_messages" | "lane_prompt_attempts",
  scope: "session_id" | "project_id",
  value: string,
): number {
  return (
    db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${scope} = ?`).get(value) as {
      count: number;
    }
  ).count;
}

function assertDormantRecovery(input: {
  readonly room: AliveRoomHost;
  readonly carrier: ScriptedCarrier;
  readonly dbPath: string;
  readonly initial: CarrierStateSnapshot;
  readonly liveEvents: readonly RoomEvent[];
  readonly expectedAppendedTypes?: readonly RoomEvent["type"][];
}): void {
  const current = snapshotCarrierState(input);
  expect({ ...current, replay: input.initial.replay }).toEqual(input.initial);
  expect(current.connectionCount).toBe(input.initial.connectionCount);
  expect(current.promptCount).toBe(input.initial.promptCount);
  expect(current.messageCount).toBe(input.initial.messageCount);
  expect(current.attemptCount).toBe(input.initial.attemptCount);
  const expectedTypes = input.expectedAppendedTypes ?? [];
  expect(current.replay.slice(input.initial.replay.length).map((event) => event.type)).toEqual(
    expectedTypes,
  );
  expect(input.liveEvents.map((event) => event.type)).toEqual(expectedTypes);
  expect(JSON.stringify(current.replay)).not.toContain("native-");
}

async function assertActivatedDormantRecovery(input: {
  readonly room: AliveRoomHost;
  readonly carrier: ScriptedCarrier;
  readonly dbPath: string;
  readonly initial: CarrierStateSnapshot;
  readonly liveEvents: readonly RoomEvent[];
}): Promise<void> {
  await input.room.activateRecovered();
  assertDormantRecovery({ ...input, expectedAppendedTypes: ["agent.mode"] });
}

async function assertResumedCodexTurn(input: {
  readonly room: AliveRoomHost;
  readonly carrier: ScriptedCarrier;
  readonly dbPath: string;
  readonly initial: CarrierStateSnapshot;
}): Promise<void> {
  const priorConnectionCount = input.carrier.connections.length;
  const priorCompleted = completedTurns(input.room);
  await input.room.submit({ requestId: "carrier-resume", text: "@codex later" });
  await waitFor(() => completedTurns(input.room) === priorCompleted + 1);
  const connections = input.carrier.connections.slice(priorConnectionCount);
  expect(connections).toHaveLength(1);
  expect(connections[0]).toMatchObject({
    agent: "codex",
    newSessions: [],
    resumes: ["native-codex-1"],
    prompts: [expect.objectContaining({ sessionId: "native-codex-1" })],
  });
  assertResumedCarrierState(input);
  expect(JSON.stringify(input.room.eventsAfter("0"))).not.toContain("native-");
}

function completedTurns(room: AliveRoomHost): number {
  return room.eventsAfter("0").filter((event) => event.type === "turn.completed").length;
}

function assertResumedCarrierState(input: {
  readonly room: AliveRoomHost;
  readonly dbPath: string;
  readonly initial: CarrierStateSnapshot;
}): void {
  const db = openDb(input.dbPath);
  try {
    const projectId = projectIdForSession(db, input.room.sessionId());
    assertResumedLaneSession(db, projectId, input.initial.laneSessions);
    expect(scopedCount(db, "lane_prompt_attempts", "project_id", projectId)).toBe(3);
    expect(
      db
        .prepare(
          `SELECT generation, last_seq AS lastSeq FROM lane_cursors
           WHERE project_id = ? AND agent = 'codex'`,
        )
        .get(projectId),
    ).toEqual({ generation: 1, lastSeq: 6 });
    expect(
      db
        .prepare(
          `SELECT generation, session_id AS sessionId, seq_from AS seqFrom, seq_to AS seqTo, resolved
           FROM lane_prompt_attempts
           WHERE project_id = ? AND agent = 'codex' AND seq_from = 5 AND seq_to = 6`,
        )
        .all(projectId),
    ).toEqual([
      { generation: 1, sessionId: "native-codex-1", seqFrom: 5, seqTo: 6, resolved: "accepted" },
    ]);
  } finally {
    closeDb(db);
  }
}

function assertResumedLaneSession(
  db: ReturnType<typeof openDb>,
  projectId: string,
  initial: CarrierStateSnapshot["laneSessions"],
): void {
  const current = db
    .prepare(
      "SELECT agent, session_id AS sessionId, generation FROM lane_sessions WHERE project_id = ? ORDER BY agent ASC",
    )
    .all(projectId);
  expect(current).toEqual(initial);
  expect(
    db
      .prepare(
        "SELECT last_resumed_at AS lastResumedAt FROM lane_sessions WHERE project_id = ? AND agent = 'codex'",
      )
      .get(projectId),
  ).toMatchObject({ lastResumedAt: expect.any(String) });
}

interface ScriptedCarrier {
  readonly newSessions: Array<{ readonly agent: AgentName; readonly sessionId: string }>;
  readonly resumes: string[];
  readonly prompts: Array<{
    readonly agent: AgentName;
    readonly sessionId: string;
    readonly text: string;
  }>;
  readonly modeSets: Array<{ readonly sessionId: string; readonly modeId: string }>;
  readonly closed: AgentName[];
  readonly connections: ScriptedConnection[];
  readonly grantlessPrompts: string[];
  readonly grantlessDispatch: HeadlessDispatch;
  readonly openConnection: NonNullable<RoomHostOptions["openConnection"]>;
}

interface ScriptedConnection {
  readonly agent: AgentName;
  readonly newSessions: string[];
  readonly resumes: string[];
  readonly prompts: Array<{ readonly sessionId: string; readonly text: string }>;
}

function scriptedCarrier(replies: Partial<Record<AgentName, string[]>>): ScriptedCarrier {
  const newSessions: ScriptedCarrier["newSessions"] = [];
  const resumes: string[] = [];
  const prompts: ScriptedCarrier["prompts"] = [];
  const modeSets: ScriptedCarrier["modeSets"] = [];
  const closed: AgentName[] = [];
  const connections: ScriptedConnection[] = [];
  const grantlessPrompts: string[] = [];
  return {
    newSessions,
    resumes,
    prompts,
    modeSets,
    closed,
    connections,
    grantlessPrompts,
    grantlessDispatch: async (input) => {
      expect(input.agent).toBe("codex");
      expect(input.grant).toBeUndefined();
      grantlessPrompts.push(await readFile(input.contextFile, "utf8"));
      return { stdout: "codex inspected", exitCode: 0 };
    },
    openConnection: async (input) => {
      const trace: ScriptedConnection = {
        agent: input.agent,
        newSessions: [],
        resumes: [],
        prompts: [],
      };
      connections.push(trace);
      return connection({
        agent: input.agent,
        replies,
        newSessions,
        resumes,
        prompts,
        modeSets,
        closed,
        onText: input.onText,
        trace,
      });
    },
  };
}

function connection(input: {
  readonly agent: AgentName;
  readonly replies: Partial<Record<AgentName, string[]>>;
  readonly newSessions: ScriptedCarrier["newSessions"];
  readonly resumes: string[];
  readonly prompts: ScriptedCarrier["prompts"];
  readonly modeSets: ScriptedCarrier["modeSets"];
  readonly closed: AgentName[];
  readonly onText: ((chunk: string) => void) | undefined;
  readonly trace: ScriptedConnection;
}): LaneConnection {
  const { agent, replies, newSessions, resumes, prompts, modeSets, closed, onText, trace } = input;
  const sessionId = `native-${agent}-1`;
  return {
    initialize: async () => ({}),
    newSession: async () => {
      newSessions.push({ agent, sessionId });
      trace.newSessions.push(sessionId);
      return { sessionId };
    },
    resumeSession: async (id) => {
      resumes.push(id);
      trace.resumes.push(id);
      return {};
    },
    prompt: async (id, text) => {
      prompts.push({ agent, sessionId: id, text });
      trace.prompts.push({ sessionId: id, text });
      onText?.(replies[agent]?.shift() ?? "native reply");
      return "end_turn";
    },
    setMode: async (id, modeId) => {
      modeSets.push({ sessionId: id, modeId });
    },
    close: () => {
      closed.push(agent);
    },
    waitForExit: async () => true,
    killTree: async () => undefined,
    isAlive: () => true,
    pid: () => 1,
  };
}

// FL-175 round-2 F8 correction: this file's own 5_000 ms default measured failing — 13.5 s and 16.7 s
// per the dispatch brief's alone reruns, 26.3 s per the kept 4087a2f receipt (see
// room-test-cleanup.fixtures.ts's header for why none of these isolate the poll segment's own cost).
// Real work in this test (real AliveRoomHost, real headless turn, real evidence DB), not the polling
// itself, was the slow part; the outer test budget below (90_000 ms) is the real backstop.
async function waitFor(predicate: () => boolean): Promise<void> {
  await pollUntil(predicate, {
    timeoutMs: DEFAULT_POLL_TIMEOUT_MS,
    message: "room did not complete",
  });
}
function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
