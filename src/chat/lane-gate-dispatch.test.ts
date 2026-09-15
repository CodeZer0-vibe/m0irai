/**
 * @file src/chat/lane-gate-dispatch.test.ts
 * @purpose F1 (FIX-3) ACCEPTANCE proof at the dispatch seam (forced-fault injection, no CLI spawn). Proves
 *   the exact contract the field death (chat-1784553379589) violated: a send to a DEAD claude lane burns NO
 *   child — emits NO dispatch.started and NEVER calls the injected dispatch — while a ready lane dispatches
 *   normally (the RED contrast: without the death classification the send would proceed, the old zombie).
 *   For @all, codex+gemini dispatch while claude emits a first-class skipped-lane outcome. And a LIVE
 *   credit/auth dispatch failure marks the lane dead (durably) so the NEXT send is gated.
 * @exports (none — test file)
 * @depends node:fs/promises, node:os, node:path, vitest, ../evidence/db, ../shared/agent-grant, ./events,
 *   ./evidence-identity, ./evidence, ./headless-turn, ./lane-availability-store, ./types
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentInput } from "../adapters/types.js";
import { CHAT_GRANT } from "../shared/agent-grant.js";
import type { AgentResult } from "../shared/types.js";
import type { HeadlessDispatch } from "./dispatch-headless.js";
import { type ChatEvent, ChatEventBus, type ChatEventKind } from "./events.js";
import { chatRunId } from "./evidence-identity.js";
import { recordChatSession } from "./evidence.js";
import { runHeadlessTurn } from "./headless-turn.js";
import {
  getLaneAvailability,
  initLaneAvailabilityStore,
  noteLaneFailure,
  resetLaneAvailabilityStore,
} from "./lane-availability-store.js";
import type { AgentName, ChatSession } from "./types.js";

const CREDIT =
  "Internal error: You're out of usage credits. Run /usage-credits to keep using Fable 5 or /model to switch models.";
const KINDS: readonly ChatEventKind[] = [
  "dispatch.started",
  "agent.stdout",
  "dispatch.completed",
  "dispatch.failed",
  "agent.status",
];
const dirs: string[] = [];

afterEach(async () => {
  resetLaneAvailabilityStore();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

async function makeSession(): Promise<{ session: ChatSession; dbPath: string; blobRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "lane-gate-"));
  dirs.push(root);
  const runDir = path.join(root, "run");
  await mkdir(path.join(runDir, "prompts"), { recursive: true });
  await mkdir(path.join(runDir, "responses"), { recursive: true });
  const blobRoot = path.join(root, "blobs");
  await mkdir(blobRoot, { recursive: true });
  const dbPath = path.join(root, "evidence.db");
  const now = new Date().toISOString();
  const id = "chat-lane-gate-test" as const;
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
    messages: [],
  };
  return { session, dbPath, blobRoot };
}

function capture(bus: ChatEventBus): ChatEvent[] {
  const events: ChatEvent[] = [];
  for (const kind of KINDS) bus.on(kind, (event) => events.push(event));
  return events;
}

function recordingDispatch(): { dispatch: HeadlessDispatch; calls: AgentName[] } {
  const calls: AgentName[] = [];
  const dispatch: HeadlessDispatch = async (input: AgentInput, onChunk): Promise<AgentResult> => {
    calls.push(input.agent);
    onChunk?.(`ok:${input.agent}`);
    return { stdout: `ok:${input.agent}`, exitCode: 0 };
  };
  return { dispatch, calls };
}

const startedFor = (events: ChatEvent[], agent: AgentName) =>
  events.filter((e) => e.kind === "dispatch.started" && e.agent === agent);
const failedFor = (events: ChatEvent[], agent: AgentName) =>
  events.filter((e) => e.kind === "dispatch.failed" && e.agent === agent);

// Fills the runHeadlessTurn boilerplate (chat laneClass, chat grant, no carrier runtime → the non-carrier
// path with the injected dispatch) so each test states only what it varies: addresses, turn, dispatch.
function dispatchTurn(
  session: ChatSession,
  bus: ChatEventBus,
  cfg: { readonly dbPath: string; readonly blobRoot: string },
  addresses: readonly { agent: AgentName; prompt: string }[],
  turn: number,
  dispatch: HeadlessDispatch,
) {
  return runHeadlessTurn({
    session,
    addresses,
    bus,
    turn,
    laneClass: "chat",
    grant: CHAT_GRANT,
    config: cfg,
    signal: new AbortController().signal,
    dispatch,
  });
}

describe("F1 gate: a dead lane burns no dispatch (no dispatch.started, transport never called)", () => {
  it("GREEN: a send to an EXHAUSTED claude is blocked locally — dispatch NOT called, NO dispatch.started", async () => {
    const { session, dbPath, blobRoot } = await makeSession();
    initLaneAvailabilityStore(session.repoRoot);
    noteLaneFailure("claude", CREDIT, Date.now()); // claude died just now (fallback window still cooling)
    const bus = new ChatEventBus();
    const events = capture(bus);
    const { dispatch, calls } = recordingDispatch();

    const config = { dbPath, blobRoot };
    const outcomes = await dispatchTurn(
      session,
      bus,
      config,
      [{ agent: "claude", prompt: "whats the status" }],
      5,
      dispatch,
    );

    expect(calls).toEqual([]); // NO child dispatch burned
    expect(startedFor(events, "claude")).toHaveLength(0); // NO dispatch.started
    const failed = failedFor(events, "claude");
    expect(failed).toHaveLength(1); // a first-class visible skip
    expect(outcomes[0]?.exitCode).toBe(1);
    expect(outcomes[0]?.error).toContain("skipped"); // calm zer0 notice, not the raw child advice
    expect(outcomes[0]?.error).not.toContain("/usage-credits");
  });

  it("RED contrast (the old zombie): a READY claude DOES dispatch — the gate blocks ONLY a classified death", async () => {
    const { session, dbPath, blobRoot } = await makeSession();
    initLaneAvailabilityStore(session.repoRoot); // claude is ready (never classified dead)
    const bus = new ChatEventBus();
    const events = capture(bus);
    const { dispatch, calls } = recordingDispatch();

    await dispatchTurn(
      session,
      bus,
      { dbPath, blobRoot },
      [{ agent: "claude", prompt: "hi" }],
      1,
      dispatch,
    );

    expect(calls).toEqual(["claude"]); // WITHOUT the death classification, the send is dispatched (zombie path)
    expect(startedFor(events, "claude")).toHaveLength(1);
  });
});

describe("F1 @all parity: codex+gemini dispatch while a dead claude is skipped first-class", async () => {
  it("skips the dead lane and dispatches the live ones", async () => {
    const { session, dbPath, blobRoot } = await makeSession();
    initLaneAvailabilityStore(session.repoRoot);
    noteLaneFailure("claude", CREDIT, Date.now()); // died just now — fallback window still cooling
    const bus = new ChatEventBus();
    const events = capture(bus);
    const { dispatch, calls } = recordingDispatch();

    const addresses = [
      { agent: "claude" as const, prompt: "q" },
      { agent: "codex" as const, prompt: "q" },
      { agent: "gemini" as const, prompt: "q" },
    ];
    const outcomes = await dispatchTurn(session, bus, { dbPath, blobRoot }, addresses, 3, dispatch);

    expect(calls.sort()).toEqual(["codex", "gemini"]); // claude skipped; the other two dispatched
    expect(startedFor(events, "claude")).toHaveLength(0);
    expect(startedFor(events, "codex")).toHaveLength(1);
    expect(startedFor(events, "gemini")).toHaveLength(1);
    // claude's skip names the lanes that ARE available (first-class, not a silent gap).
    const claudeSkip = outcomes.find((o) => o.agent === "claude");
    expect(claudeSkip?.exitCode).toBe(1);
    expect(claudeSkip?.error).toContain("codex");
    expect(claudeSkip?.error).toContain("gemini");
  });
});

// W4-R2b RULING 3, CLAUSE 2 (operator, 2026-07-27): "if we send a message and doesnt go through we say
// offline and that it". THE OPERATOR-VISIBLE FAILURE: gemini is not installed, every message they send
// fails, and the bottom bar still reads `◇ gemini auto`. Driven at the DISPATCH SEAM, not the recorder,
// because the two halves of the promise only both hold here: the chip goes down AND the next message is
// still attempted (an availability-based fix would have passed the first half and failed the second).
//
// THE FIXTURE IS CAPTURED (READ-WHAT-IS clause 4), not imagined: `agyExePath()` throws this exact sentence
// when the Antigravity CLI is absent (src/adapters/pty/agy-pty-spawn.ts:23-25). Captured live by running
// that production resolver with LOCALAPPDATA pointed at a directory that does not exist. It reaches
// `outcome.error` unchanged on BOTH gemini paths — carrier (headless-carrier.ts:122-125 preserves
// error.message) and non-carrier (headless-turn.ts:218-220), which is the path exercised here.
const AGY_MISSING =
  'agy-pty-spawn: agy.exe not found at "C:\\Users\\op\\AppData\\Local\\agy\\bin\\agy.exe" (Antigravity CLI not installed)';

describe("RULING 3 clause 2: a failed send marks the chip down WITHOUT locking the lane", () => {
  it("send 1 fails on a missing agy -> auth:down; send 2 is still DISPATCHED (the anti-lockout half)", async () => {
    const { session, dbPath, blobRoot } = await makeSession();
    initLaneAvailabilityStore(session.repoRoot);
    const bus = new ChatEventBus();
    const events = capture(bus);
    const config = { dbPath, blobRoot };

    // SEND 1 — the real adapter shape: the dispatch throws before any child exists.
    const missingAgy: HeadlessDispatch = async () => {
      throw new Error(AGY_MISSING);
    };
    await dispatchTurn(session, bus, config, [{ agent: "gemini", prompt: "hi" }], 1, missingAgy);

    const down = events.filter(
      (e) => e.kind === "agent.status" && e.agent === "gemini" && e.auth === "down",
    );
    expect(down, `the bar was never told the send failed:\n${JSON.stringify(events)}`).toHaveLength(
      1,
    );
    // ...and the lane is NOT durably blocked, so nothing refuses the next message.
    expect(getLaneAvailability("gemini").state).toBe("ready");

    // SEND 2 — the falsifier that matters: the injected dispatch is ACTUALLY INVOKED.
    const { dispatch, calls } = recordingDispatch();
    await dispatchTurn(session, bus, config, [{ agent: "gemini", prompt: "again" }], 2, dispatch);
    expect(calls, "the operator was locked out of gemini by one failed send").toEqual(["gemini"]);
    expect(startedFor(events, "gemini")).toHaveLength(2);

    // ...and that success puts the chip back — offline describes the last send, not the agent.
    const auths = events.filter((e) => e.kind === "agent.status" && e.agent === "gemini");
    const last = auths.at(-1);
    expect(last?.kind === "agent.status" ? last.auth : undefined).toBe("ready");
  });

  it("a CLASSIFIED death is untouched — still the availability machine, still gated", async () => {
    const { session, dbPath, blobRoot } = await makeSession();
    initLaneAvailabilityStore(session.repoRoot);
    const bus = new ChatEventBus();
    const config = { dbPath, blobRoot };
    const dying: HeadlessDispatch = async () => {
      throw new Error(CREDIT);
    };
    await dispatchTurn(session, bus, config, [{ agent: "gemini", prompt: "hi" }], 1, dying);
    expect(getLaneAvailability("gemini").state).toBe("exhausted");
    const { dispatch, calls } = recordingDispatch();
    await dispatchTurn(session, bus, config, [{ agent: "gemini", prompt: "again" }], 2, dispatch);
    expect(calls, "a real death stopped refusing sends").toEqual([]);
  });
});

describe("F1 classification: a LIVE credit failure marks the lane dead so the next send is gated", () => {
  it("a dispatch that fails on the credit string transitions claude -> exhausted + emits its availability", async () => {
    const { session, dbPath, blobRoot } = await makeSession();
    initLaneAvailabilityStore(session.repoRoot);
    const bus = new ChatEventBus();
    const events = capture(bus);
    // First turn: the dispatch fails with the real credit string (mid-stream death).
    const dyingDispatch: HeadlessDispatch = async () => {
      throw new Error(CREDIT);
    };
    const config = { dbPath, blobRoot };
    await dispatchTurn(
      session,
      bus,
      config,
      [{ agent: "claude", prompt: "build it" }],
      25,
      dyingDispatch,
    );

    expect(getLaneAvailability("claude").state).toBe("exhausted");
    const availabilityStatus = events.filter(
      (e) => e.kind === "agent.status" && e.agent === "claude" && e.availability !== undefined,
    );
    expect(availabilityStatus.length).toBeGreaterThanOrEqual(1);

    // Second turn to the now-dead lane: gated locally, no new dispatch.
    const { dispatch, calls } = recordingDispatch();
    await dispatchTurn(
      session,
      bus,
      config,
      [{ agent: "claude", prompt: "status?" }],
      26,
      dispatch,
    );
    expect(calls).toEqual([]); // the zombie is gone — no dispatch burned into the dead lane
  });
});
