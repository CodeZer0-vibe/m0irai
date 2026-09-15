/**
 * @file src/chat/headless-turn-boundary-trace.test.ts
 * @purpose THE BOUNDARY WAVE (B7 observability) falsifier for runHeadlessTurn's non-carrier lane: the
 *   contract requires boundary injection ("which lane, how many framed entries") traceable under
 *   ZER0_DEBUG=1. Kept separate from headless-turn.test.ts (already 583 lines, past this codebase's
 *   own architectural ceiling — mirrors headless-prompt-framing.test.ts's identical split precedent).
 *   Proves: a real runHeadlessTurn call whose prompt actually frames prior-session content emits a
 *   memory.trace {phase:"boundary.framed"} event with an accurate count under ZER0_DEBUG=1, emits
 *   NOTHING when debug is off (matches this codebase's existing conditional-emit convention — see
 *   lane-carrier.ts's own emit() gate), and emits NOTHING when priorSessionMessageCount is absent/0
 *   (the common case; never a false-positive trace).
 * @exports (none — test file)
 * @depends node:fs/promises, node:os, node:path, vitest, ../evidence/db, ./dispatch-headless,
 *   ./events, ./evidence, ./evidence-identity, ./headless-turn, ./types
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHAT_GRANT } from "../shared/agent-grant.js";
import type { AgentResult } from "../shared/types.js";
import type { HeadlessDispatch } from "./dispatch-headless.js";
import { type ChatEvent, ChatEventBus } from "./events.js";
import { chatRunId } from "./evidence-identity.js";
import { recordChatSession } from "./evidence.js";
import { runHeadlessTurn } from "./headless-turn.js";
import type { ChatMessage, ChatSession } from "./types.js";

const dirs: string[] = [];
const savedDebug = process.env.ZER0_DEBUG;

beforeEach(() => {
  process.env.ZER0_DEBUG = "1";
});

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  if (savedDebug === undefined) Reflect.deleteProperty(process.env, "ZER0_DEBUG");
  else process.env.ZER0_DEBUG = savedDebug;
});

function staleMsg(id: string, turn: number): ChatMessage {
  return {
    id,
    turn,
    role: "user",
    agent: "user",
    text: `stale message ${id}`,
    createdAt: "2026-07-16T00:00:00.000Z",
    status: "completed",
    tokenEstimate: 1,
  };
}

async function makeSession(
  messages: ChatMessage[] = [],
): Promise<{ session: ChatSession; dbPath: string; blobRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "headless-turn-boundary-"));
  dirs.push(root);
  const runDir = path.join(root, "run");
  await mkdir(path.join(runDir, "prompts"), { recursive: true });
  await mkdir(path.join(runDir, "responses"), { recursive: true });
  const blobRoot = path.join(root, "blobs");
  await mkdir(blobRoot, { recursive: true });
  const dbPath = path.join(root, "evidence.db");
  const now = new Date().toISOString();
  const id = "chat-headless-boundary-test" as const;
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
  const session: ChatSession = {
    id,
    repoRoot: root,
    runDir,
    createdAt: now,
    updatedAt: now,
    defaultAgent: "claude",
    lastAgent: null,
    summary: { text: "", throughTurn: 0 },
    messages,
  };
  return { session, dbPath, blobRoot };
}

function captureTrace(bus: ChatEventBus): ChatEvent[] {
  const events: ChatEvent[] = [];
  bus.on("memory.trace", (event) => events.push(event));
  return events;
}

const fakeDispatch: HeadlessDispatch = async (): Promise<AgentResult> => ({
  stdout: "ok",
  exitCode: 0,
});

// A REAL ChatEventBus whose public emit method is shadowed on the INSTANCE (not a synthetic object
// cast to the type) so it throws ONLY for the memory.trace kind, isolating the failure to the
// boundary trace emit specifically — every other event (dispatch.started, agent.stdout,
// dispatch.completed, ...) flows through the original emit normally, so the lane's OWN machinery is
// unaffected; only the trace emit itself is broken.
function makeTraceThrowingBus(): ChatEventBus {
  const bus = new ChatEventBus();
  const realEmit = bus.emit.bind(bus);
  bus.emit = (event: ChatEvent) => {
    if (event.kind === "memory.trace") {
      throw new Error("boundary trace emit boom");
    }
    realEmit(event);
  };
  return bus;
}

describe("runHeadlessTurn — THE BOUNDARY WAVE (B7): boundary.framed trace under ZER0_DEBUG=1", () => {
  it("FALSIFIER: a lane whose prompt actually frames prior-session content emits boundary.framed with the real per-lane count", async () => {
    const { session, dbPath, blobRoot } = await makeSession([staleMsg("u1", 1), staleMsg("u2", 1)]);
    const bus = new ChatEventBus();
    const trace = captureTrace(bus);

    await runHeadlessTurn({
      session,
      addresses: [{ agent: "claude", prompt: "continue" }],
      bus,
      turn: 2,
      laneClass: "dispatch",
      grant: CHAT_GRANT,
      config: { dbPath, blobRoot },
      signal: new AbortController().signal,
      dispatch: fakeDispatch,
      priorSessionMessageCount: 2,
    });

    const boundaryEvents = trace.filter(
      (e) => e.kind === "memory.trace" && e.phase === "boundary.framed",
    );
    expect(boundaryEvents).toHaveLength(1);
    const detail =
      boundaryEvents[0]?.kind === "memory.trace" ? boundaryEvents[0].detail : undefined;
    expect(detail).toContain("claude");
    expect(detail).toContain("2");
  });
});

describe("runHeadlessTurn — THE BOUNDARY WAVE (B7): the trace never false-positives", () => {
  it("priorSessionMessageCount absent/0 emits NOTHING — never a false-positive trace", async () => {
    const { session, dbPath, blobRoot } = await makeSession([staleMsg("u1", 1)]);
    const bus = new ChatEventBus();
    const trace = captureTrace(bus);

    await runHeadlessTurn({
      session,
      addresses: [{ agent: "claude", prompt: "hi" }],
      bus,
      turn: 2,
      laneClass: "dispatch",
      grant: CHAT_GRANT,
      config: { dbPath, blobRoot },
      signal: new AbortController().signal,
      dispatch: fakeDispatch,
    });

    expect(trace.filter((e) => e.kind === "memory.trace" && e.phase === "boundary.framed")).toEqual(
      [],
    );
  });

  it("ZER0_DEBUG off: framing still happens (correctness unaffected) but the trace emits nothing", async () => {
    process.env.ZER0_DEBUG = "0";
    const { session, dbPath, blobRoot } = await makeSession([staleMsg("u1", 1), staleMsg("u2", 1)]);
    const bus = new ChatEventBus();
    const trace = captureTrace(bus);

    await runHeadlessTurn({
      session,
      addresses: [{ agent: "claude", prompt: "continue" }],
      bus,
      turn: 2,
      laneClass: "dispatch",
      grant: CHAT_GRANT,
      config: { dbPath, blobRoot },
      signal: new AbortController().signal,
      dispatch: fakeDispatch,
      priorSessionMessageCount: 2,
    });

    expect(trace.filter((e) => e.kind === "memory.trace" && e.phase === "boundary.framed")).toEqual(
      [],
    );
  });
});

describe("runHeadlessTurn — BLOCK 4 (codex sol MAX review round 1): the trace emit is never a silent swallow", () => {
  it("FALSIFIER: a broken bus.emit for the boundary trace propagates as a genuine failure — never masked, consistent with every other bus.emit call in this file (emitStarted, agent.stdout)", async () => {
    const { session, dbPath, blobRoot } = await makeSession([staleMsg("u1", 1), staleMsg("u2", 1)]);
    const throwingBus = makeTraceThrowingBus();

    await expect(
      runHeadlessTurn({
        session,
        addresses: [{ agent: "claude", prompt: "continue" }],
        bus: throwingBus,
        turn: 2,
        laneClass: "dispatch",
        grant: CHAT_GRANT,
        config: { dbPath, blobRoot },
        signal: new AbortController().signal,
        dispatch: fakeDispatch,
        priorSessionMessageCount: 2,
      }),
    ).rejects.toThrow("boundary trace emit boom");
  });
});
