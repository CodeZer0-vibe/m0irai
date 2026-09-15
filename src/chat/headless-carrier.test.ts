/**
 * @file src/chat/headless-carrier.test.ts
 * @purpose MT7 I4c lifecycle parity test for the carrier-backed runHeadlessTurn branch (the ACP
 *   transport lane). W3 (THE GREAT DELETION, 2026-07-17): the agy-lane redirect-delivery coverage
 *   (T7 agy) is deleted along with the review_redirects apparatus it exercised (see headless-turn.ts's
 *   own header) — this file now covers the ACP lane only; the agy adapter mocks that existed solely
 *   to support that deleted test are removed with it.
 * @exports (none - test suite)
 * @depends node:fs, node:fs/promises, node:os, node:path, vitest, ../evidence/db, ./events,
 *   ./evidence, ./evidence-identity, ./headless-turn, ./lane-transport
 * @size-justified: one cohesive falsifier suite for the carrier-backed ACP dispatch branch — splitting
 *   would duplicate the makeSession/turnInput/insertProject fixtures across files for no isolation gain.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { closeDb, openLaneStateDb } from "../evidence/db.js";
import { getLaneCursor } from "../memory/lane-cursor.js";
import { getSeqForMessage, mintSeq } from "../memory/ledger.js";
import { CHAT_GRANT } from "../shared/agent-grant.js";
import type { AgentResult } from "../shared/types.js";
import type { HeadlessDispatch } from "./dispatch-headless.js";
import { type ChatEvent, ChatEventBus } from "./events.js";
import { chatRunId } from "./evidence-identity.js";
import { recordChatMessage, recordChatSession } from "./evidence.js";
import { runHeadlessTurn } from "./headless-turn.js";
import { initCarrierRuntime, resetCarrierRuntime } from "./lane-transport.js";
import type { ChatSession } from "./types.js";

const dirs: string[] = [];
const savedFlags = { memory: process.env.ZER0_MEMORY, resume: process.env.ZER0_NATIVE_RESUME };

afterEach(async () => {
  resetCarrierRuntime();
  restoreFlag("ZER0_MEMORY", savedFlags.memory);
  restoreFlag("ZER0_NATIVE_RESUME", savedFlags.resume);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function restoreFlag(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

async function makeSession(): Promise<{ session: ChatSession; dbPath: string; blobRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "headless-carrier-"));
  dirs.push(root);
  const runDir = path.join(root, "run");
  await mkdir(path.join(runDir, "prompts"), { recursive: true });
  await mkdir(path.join(runDir, "responses"), { recursive: true });
  const blobRoot = path.join(root, "blobs");
  await mkdir(blobRoot, { recursive: true });
  return buildSession(root, runDir, blobRoot, path.join(root, "evidence.db"));
}

async function buildSession(root: string, runDir: string, blobRoot: string, dbPath: string) {
  const now = new Date().toISOString();
  const id = "chat-headless-carrier" as const;
  await recordChatSession({
    dbPath,
    sessionId: id,
    runId: chatRunId(id),
    repoRoot: root,
    runDir,
    createdAt: now,
    updatedAt: now,
    defaultAgent: "claude",
    lastAgent: null,
    summaryText: "",
    summaryThroughTurn: 0,
  });
  const session = {
    id,
    repoRoot: root,
    runDir,
    createdAt: now,
    updatedAt: now,
    defaultAgent: "claude" as const,
    lastAgent: null,
    summary: { text: "", throughTurn: 0 },
    messages: [],
  };
  return { session, dbPath, blobRoot };
}

function captureBus(bus: ChatEventBus): ChatEvent[] {
  const events: ChatEvent[] = [];
  for (const kind of [
    "dispatch.started",
    "agent.stdout",
    "dispatch.completed",
    "dispatch.failed",
  ] as const) {
    bus.on(kind, (event) => events.push(event));
  }
  return events;
}

function insertProject(dbPath: string, session: ChatSession): void {
  const db = openLaneStateDb(dbPath);
  db.prepare(
    "INSERT OR IGNORE INTO projects(project_id, canonical_root, git_common_dir, created_at) VALUES (?,?,?,?)",
  ).run("p1", session.repoRoot, path.join(session.repoRoot, ".git"), session.createdAt);
  closeDb(db);
}

function initFakeCarrier(
  session: ChatSession,
  dbPath: string,
  onPrompt: () => void,
  onPromptText?: (text: string) => void,
  onEmit?: (emit: (update: unknown) => void) => void,
): void {
  initCarrierRuntime({
    projectId: "p1",
    dbPath,
    repoRoot: session.repoRoot,
    cwd: session.repoRoot,
    openConnection: async (input) => ({
      initialize: async () => ({}),
      newSession: async () => ({ sessionId: "s-carrier" }),
      resumeSession: async () => ({}),
      prompt: async (_sessionId, text, emit) => {
        onPrompt();
        onPromptText?.(text);
        onEmit?.(emit);
        input.onText?.("carrier reply");
        return "end_turn";
      },
      setMode: async () => undefined,
      close: () => undefined,
      waitForExit: async () => true,
      killTree: async () => undefined,
      isAlive: () => true,
      pid: () => 31337,
    }),
  });
}

it("routes claude through the held carrier transport with started/stdout/completed parity", async () => {
  process.env.ZER0_MEMORY = "1";
  process.env.ZER0_NATIVE_RESUME = "1";
  const { session, dbPath, blobRoot } = await makeSession();
  insertProject(dbPath, session);
  const bus = new ChatEventBus();
  const events = captureBus(bus);
  let prompts = 0;
  initFakeCarrier(session, dbPath, () => {
    prompts += 1;
  });
  const dispatch: HeadlessDispatch = async (): Promise<AgentResult> => {
    throw new Error("buffered dispatch must not run");
  };

  const outcomes = await runHeadlessTurn({
    session,
    addresses: [{ agent: "claude", prompt: "hello" }],
    bus,
    turn: 1,
    laneClass: "chat",
    grant: CHAT_GRANT,
    config: { dbPath, blobRoot },
    signal: new AbortController().signal,
    dispatch,
  });

  expect(prompts).toBe(1);
  expect(events.map((e) => e.kind)).toEqual([
    "dispatch.started",
    "agent.stdout",
    "dispatch.completed",
  ]);
  expect(outcomes[0]?.text).toBe("carrier reply");
  expect(outcomes[0]?.exitCode).toBe(0);
});

it("routes a grantless agent hop through the enforced read-only non-carrier path", async () => {
  process.env.ZER0_MEMORY = "1";
  process.env.ZER0_NATIVE_RESUME = "1";
  const { session, dbPath, blobRoot } = await makeSession();
  insertProject(dbPath, session);
  let carrierPrompts = 0;
  initFakeCarrier(session, dbPath, () => {
    carrierPrompts += 1;
  });
  const dispatchGrants: unknown[] = [];
  const dispatch: HeadlessDispatch = async (input): Promise<AgentResult> => {
    dispatchGrants.push(input.grant);
    return { stdout: "read-only hop reply", exitCode: 0 };
  };

  const outcomes = await runHeadlessTurn({
    session,
    addresses: [{ agent: "claude", prompt: "review this" }],
    bus: new ChatEventBus(),
    turn: 1,
    laneClass: "chat",
    config: { dbPath, blobRoot },
    signal: new AbortController().signal,
    dispatch,
  });

  expect(carrierPrompts).toBe(0);
  expect(dispatchGrants).toEqual([undefined]);
  expect(outcomes[0]?.text).toBe("read-only hop reply");
});

it("falsifier: raw ACP tool updates call the activity seam once per Claude and Codex lane", async () => {
  process.env.ZER0_MEMORY = "1";
  process.env.ZER0_NATIVE_RESUME = "1";
  const { session, dbPath, blobRoot } = await makeSession();
  insertProject(dbPath, session);
  const activity: Array<{ agent: string; update: string; toolCallId: string }> = [];
  initFakeCarrier(
    session,
    dbPath,
    () => undefined,
    undefined,
    (emit) => {
      emit({
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Read source",
        kind: "read",
        status: "in_progress",
      });
      emit({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "ignore" } });
      emit({ sessionUpdate: "usage_update", used: 2, size: 10 });
    },
  );
  const bus = new ChatEventBus();

  await runHeadlessTurn({
    ...turnInput(session, dbPath, blobRoot, bus, 1),
    addresses: [
      { agent: "claude", prompt: "hello" },
      { agent: "codex", prompt: "hello" },
    ],
    onLaneActivity: (agent, update) => {
      activity.push({ agent, update: update.update, toolCallId: update.toolCallId });
    },
  });

  expect(activity).toEqual([
    { agent: "claude", update: "tool_call", toolCallId: "tool-1" },
    { agent: "codex", update: "tool_call", toolCallId: "tool-1" },
  ]);
});

function turnInput(
  session: ChatSession,
  dbPath: string,
  blobRoot: string,
  bus: ChatEventBus,
  turn: number,
) {
  const dispatch: HeadlessDispatch = async (): Promise<AgentResult> => {
    throw new Error("buffered dispatch must not run");
  };
  return {
    session,
    addresses: [{ agent: "claude" as const, prompt: "hello" }],
    bus,
    turn,
    laneClass: "chat" as const,
    grant: CHAT_GRANT,
    config: { dbPath, blobRoot },
    signal: new AbortController().signal,
    dispatch,
  };
}

it("wave-seal B1: a persisted chat message MINTS its ledger seq atomically; a mint failure rolls the message back too", async () => {
  process.env.ZER0_MEMORY = "1";
  process.env.ZER0_NATIVE_RESUME = "1";
  const { session, dbPath, blobRoot } = await makeSession();
  insertProject(dbPath, session);
  initFakeCarrier(session, dbPath, () => undefined);
  const write = (messageId: string) =>
    recordChatMessage({
      dbPath,
      blobRoot,
      sessionId: session.id,
      messageId,
      turn: 1,
      role: "user",
      agent: "user",
      text: "hello ledger",
      createdAt: session.createdAt,
      status: "completed",
      tokenEstimate: 3,
    });
  expect(await write("msg-minted")).toBe("msg-minted");
  const db = openLaneStateDb(dbPath);
  expect(getSeqForMessage(db, "p1", "msg-minted")).toBe(1); // the artery mints (B1)
  closeDb(db);

  // Atomicity falsifier: a runtime whose project row does NOT exist makes the mint FK-fail — the
  // MESSAGE row must roll back with it (atomically both or neither), and the swallow returns undefined.
  resetCarrierRuntime();
  initCarrierRuntime({
    projectId: "p-ghost",
    dbPath,
    repoRoot: session.repoRoot,
    cwd: session.repoRoot,
  });
  expect(await write("msg-orphaned")).toBeUndefined();
  const check = openLaneStateDb(dbPath);
  const row = check
    .prepare("SELECT id FROM chat_messages WHERE id = ? LIMIT 1")
    .get("msg-orphaned");
  expect(row).toBeUndefined();
  closeDb(check);
});

it("wave-seal B2: a minted message OUTSIDE the in-memory session resolves durably into the prompt; an unresolvable seq fails the lane and preserves the cursor", async () => {
  process.env.ZER0_MEMORY = "1";
  process.env.ZER0_NATIVE_RESUME = "1";
  const { session, dbPath, blobRoot } = await makeSession();
  insertProject(dbPath, session);
  const prompts: string[] = [];
  initFakeCarrier(
    session,
    dbPath,
    () => undefined,
    (text) => prompts.push(text),
  );
  await recordChatMessage({
    dbPath,
    blobRoot,
    sessionId: session.id,
    messageId: "msg-from-other-cockpit",
    turn: 1,
    role: "agent",
    agent: "codex",
    text: "the durable body from another cockpit",
    createdAt: session.createdAt,
    status: "completed",
    tokenEstimate: 5,
  });
  const bus = new ChatEventBus();
  const outcomes = await runHeadlessTurn(turnInput(session, dbPath, blobRoot, bus, 2));
  expect(outcomes[0]?.exitCode).toBe(0);
  expect(prompts[0]).toContain("the durable body from another cockpit"); // resolved from blob, not session

  // Unresolvable seq: minted with NO chat_messages row → the lane FAILS and the cursor is preserved.
  const db = openLaneStateDb(dbPath);
  mintSeq(db, "p1", "msg-body-missing");
  const cursorBefore = getLaneCursor(db, "p1", "claude")?.lastSeq;
  closeDb(db);
  const bus2 = new ChatEventBus();
  const failed = await runHeadlessTurn(turnInput(session, dbPath, blobRoot, bus2, 3));
  expect(failed[0]?.exitCode).not.toBe(0);
  const after = openLaneStateDb(dbPath);
  expect(getLaneCursor(after, "p1", "claude")?.lastSeq).toBe(cursorBefore);
  closeDb(after);
});

it("wave-seal B3: a compaction-shaped update through the LIVE transport tap arms the durable carry", async () => {
  process.env.ZER0_MEMORY = "1";
  process.env.ZER0_NATIVE_RESUME = "1";
  const { session, dbPath, blobRoot } = await makeSession();
  insertProject(dbPath, session);
  let turnCount = 0;
  initFakeCarrier(
    session,
    dbPath,
    () => {
      turnCount += 1;
    },
    undefined,
    (emit) => {
      if (turnCount === 2) {
        emit({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "*Context compacted to fit the model's context window.*\n\n",
          },
        });
      }
    },
  );
  const bus = new ChatEventBus();
  await runHeadlessTurn(turnInput(session, dbPath, blobRoot, bus, 1)); // coldstart carry clears
  await runHeadlessTurn(turnInput(session, dbPath, blobRoot, bus, 2)); // compaction fires mid-turn
  const db = openLaneStateDb(dbPath);
  // Turn 2 carried no briefing (cleared on turn 1), so its accept does NOT clear the mid-turn arm.
  expect(getLaneCursor(db, "p1", "claude")?.needsBriefingCarry).toBe(true);
  closeDb(db);
});
