/**
 * @file src/chat/headless-turn.test.ts
 * @purpose Falsifying contract for the headless turn engine: a real bus + temp sqlite + a FAKE dispatch seam
 *   (no CLI spawn) prove the dispatch sequence, DispatchError→failed, grant flow, council fan-out, evidence
 *   persistence, sequential threading, per-segment mode, agy continuity, usage capture, terminal classification.
 * @exports (test suite — no runtime exports)
 * @depends node:fs/promises, node:os, node:path, vitest, ../shared/errors, ../evidence/db, ./dispatch-headless, ./events, ./evidence, ./evidence-identity, ./headless-turn, ./types
 * @size-justified: cohesive single-module falsifier suite; splitting by concern fragments one contract.
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentInput } from "../adapters/types.js";
import { closeDb, openDb } from "../evidence/db.js";
import { type AgentGrant, BUILD_GRANT, CHAT_GRANT, RESEARCH_GRANT } from "../shared/agent-grant.js";
import { DispatchError } from "../shared/errors.js";
import type { AgentResult } from "../shared/types.js";
import type { HeadlessDispatch } from "./dispatch-headless.js";
import { type ChatEvent, ChatEventBus, type ChatEventKind } from "./events.js";
import { chatRunId } from "./evidence-identity.js";
import { recordChatSession } from "./evidence.js";
import { type HeadlessAddress, runHeadlessTurn } from "./headless-turn.js";
import type { ChatSession } from "./types.js";

const TERMINAL_KINDS: readonly ChatEventKind[] = [
  "dispatch.started",
  "agent.stdout",
  "dispatch.completed",
  "dispatch.failed",
];

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function makeSession(): Promise<{ session: ChatSession; dbPath: string; blobRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "headless-turn-"));
  dirs.push(root);
  const runDir = path.join(root, "run");
  await mkdir(path.join(runDir, "prompts"), { recursive: true });
  await mkdir(path.join(runDir, "responses"), { recursive: true });
  const blobRoot = path.join(root, "blobs");
  await mkdir(blobRoot, { recursive: true });
  const dbPath = path.join(root, "evidence.db");
  const now = new Date().toISOString();
  const id = "chat-headless-test" as const;
  // Create the chat_sessions parent row so recordChatMessage's FK (session_id → chat_sessions) is
  // satisfied and the evidence write exercises the REAL happy path (not a swallowed FK failure).
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

function captureBus(bus: ChatEventBus): ChatEvent[] {
  const events: ChatEvent[] = [];
  for (const kind of TERMINAL_KINDS) {
    bus.on(kind, (event) => events.push(event));
  }
  return events;
}

describe("runHeadlessTurn: a successful lane emits the dispatch sequence in order", () => {
  it("emits dispatch.started → agent.stdout → dispatch.completed, with the agent's text", async () => {
    const { session, dbPath, blobRoot } = await makeSession();
    const bus = new ChatEventBus();
    const events = captureBus(bus);
    const dispatch: HeadlessDispatch = async (): Promise<AgentResult> => ({
      stdout: "the answer",
      exitCode: 0,
    });

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

    expect(events.map((e) => e.kind)).toEqual([
      "dispatch.started",
      "agent.stdout",
      "dispatch.completed",
    ]);
    const stdout = events.find((e) => e.kind === "agent.stdout");
    expect(stdout?.kind === "agent.stdout" ? stdout.chunk : "").toBe("the answer");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.text).toBe("the answer");
    expect(outcomes[0]?.exitCode).toBe(0);
  });
});

describe("runHeadlessTurn: a STREAMING lane emits live per-chunk; finalizeLane does NOT re-emit (no double)", () => {
  it("emits one agent.stdout per streamed chunk, skipping the buffered re-emit", async () => {
    const { session, dbPath, blobRoot } = await makeSession();
    const bus = new ChatEventBus();
    const events = captureBus(bus);
    // A streaming dispatcher (the ACP path): streams each chunk via onChunk DURING the turn, returns `streamed`.
    const dispatch: HeadlessDispatch = async (_input, onChunk): Promise<AgentResult> => {
      onChunk?.("the ");
      onChunk?.("answer");
      return { stdout: "the answer", exitCode: 0 };
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

    const chunks = events
      .filter((e) => e.kind === "agent.stdout")
      .map((e) => (e.kind === "agent.stdout" ? e.chunk : ""));
    // FALSIFYING: the two LIVE chunks are emitted; the buffered "the answer" is NOT re-emitted as a 3rd chunk
    // (streamed:true → finalizeLane skips its outputChunks emit). A regression here yields ["the ","answer","the answer"].
    expect(chunks).toEqual(["the ", "answer"]);
    expect(events.map((e) => e.kind)).toEqual([
      "dispatch.started",
      "agent.stdout",
      "agent.stdout",
      "dispatch.completed",
    ]);
    // the full reply is accumulated by the sink (per chunk) for the response file + evidence
    expect(outcomes[0]?.text).toBe("the answer");
  });
});

describe("runHeadlessTurn: a mid-stream FAILURE keeps the partial streamed text (P1)", () => {
  it("persists the partial reply into the outcome when a streaming turn fails after some chunks", async () => {
    const { session, dbPath, blobRoot } = await makeSession();
    const bus = new ChatEventBus();
    const events = captureBus(bus);
    // Streams two chunks, THEN fails (non-end_turn → DispatchError). The sink observed each chunk BEFORE the
    // throw, so the partial must survive into the lane outcome (→ response file + evidence), not vanish.
    const dispatch: HeadlessDispatch = async (_input, onChunk): Promise<AgentResult> => {
      onChunk?.("par");
      onChunk?.("tial");
      throw new DispatchError("max_tokens", "claude", 1);
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

    // FALSIFYING: pre-fix (observe(result.stdout) skipped on throw) this was ""; now the sink-observed partial survives.
    expect(outcomes[0]?.text).toBe("partial");
    expect(outcomes[0]?.state).toBe("failed");
    const chunks = events
      .filter((e) => e.kind === "agent.stdout")
      .map((e) => (e.kind === "agent.stdout" ? e.chunk : ""));
    expect(chunks).toEqual(["par", "tial"]); // streamed live; finalizeLane did not re-emit
  });
});

describe("runHeadlessTurn: a DispatchError surfaces as dispatch.failed (never completed)", () => {
  it("emits dispatch.started → dispatch.failed and never emits dispatch.completed", async () => {
    const { session, dbPath, blobRoot } = await makeSession();
    const bus = new ChatEventBus();
    const events = captureBus(bus);
    const dispatch: HeadlessDispatch = async (): Promise<AgentResult> => {
      throw new DispatchError("claude refused", "claude", 7);
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

    expect(events.map((e) => e.kind)).toEqual(["dispatch.started", "dispatch.failed"]);
    const failed = events.find((e) => e.kind === "dispatch.failed");
    expect(failed?.kind === "dispatch.failed" ? failed.error : "").toContain("claude refused");
    expect(outcomes[0]?.exitCode).not.toBe(0);
  });
});

describe("runHeadlessTurn: the route's grant flows to the adapter (real coding-agent capability)", () => {
  it("dispatches a build turn WRITE-capable in the repo cwd — not clamped read-only", async () => {
    const { session, dbPath, blobRoot } = await makeSession();
    const captured: AgentInput[] = [];
    const dispatch: HeadlessDispatch = async (input): Promise<AgentResult> => {
      captured.push(input);
      return { stdout: "ok", exitCode: 0 };
    };

    await runHeadlessTurn({
      session,
      addresses: [{ agent: "claude", prompt: "build me a thing" }],
      bus: new ChatEventBus(),
      turn: 1,
      laneClass: "chat",
      grant: BUILD_GRANT,
      config: { dbPath, blobRoot },
      signal: new AbortController().signal,
      dispatch,
    });

    expect(captured).toHaveLength(1);
    // Real coding-agent behaviour: a build turn reaches the adapter WRITE-capable (NOT clamped to chat),
    // running in the operator's repo cwd (git is the undo). worktree:true is agy's --add-dir-root grant.
    expect(captured[0]?.grant).toEqual(BUILD_GRANT);
    expect(captured[0]?.worktreePath).toBe(session.repoRoot);
  });
});

describe("runHeadlessTurn: council fan-out runs one lane per address", () => {
  it("dispatches all three agents and returns one outcome each", async () => {
    const { session, dbPath, blobRoot } = await makeSession();
    const bus = new ChatEventBus();
    const completed: string[] = [];
    bus.on("dispatch.completed", (event) => completed.push(event.agent));
    const dispatch: HeadlessDispatch = async (input): Promise<AgentResult> => ({
      stdout: `${input.agent} says hi`,
      exitCode: 0,
    });

    const outcomes = await runHeadlessTurn({
      session,
      addresses: [
        { agent: "claude", prompt: "hi" },
        { agent: "codex", prompt: "hi" },
        { agent: "gemini", prompt: "hi" },
      ],
      bus,
      turn: 1,
      laneClass: "chat",
      grant: CHAT_GRANT,
      config: { dbPath, blobRoot },
      signal: new AbortController().signal,
      dispatch,
    });

    expect(outcomes).toHaveLength(3);
    expect(completed.sort()).toEqual(["claude", "codex", "gemini"]);
  });
});

describe("runHeadlessTurn: evidence is persisted under chatRunId(sessionId)", () => {
  it("writes one chat_messages row joined to the session's run id", async () => {
    const { session, dbPath, blobRoot } = await makeSession();
    const dispatch: HeadlessDispatch = async (): Promise<AgentResult> => ({
      stdout: "persisted answer",
      exitCode: 0,
    });

    await runHeadlessTurn({
      session,
      addresses: [{ agent: "claude", prompt: "hello" }],
      bus: new ChatEventBus(),
      turn: 1,
      laneClass: "chat",
      grant: CHAT_GRANT,
      config: { dbPath, blobRoot },
      signal: new AbortController().signal,
      dispatch,
    });

    const db = openDb(dbPath);
    try {
      const row = db
        .prepare(
          "SELECT cm.id AS id FROM chat_messages cm JOIN chat_sessions cs ON cs.id = cm.session_id WHERE cs.run_id = ? AND cm.role = 'agent'",
        )
        .get(chatRunId(session.id)) as { id: string } | undefined;
      expect(row?.id).toBeDefined();
    } finally {
      closeDb(db);
    }
  });
});

describe("runHeadlessTurn: sequential threads each reply into the next agent's prompt (the hand-off)", () => {
  it("the 2nd agent's prompt carries the 1st agent's reply; the 1st's does not", async () => {
    const { session, dbPath, blobRoot } = await makeSession();
    const seenPrompts: string[] = [];
    const dispatch: HeadlessDispatch = async (input): Promise<AgentResult> => {
      seenPrompts.push(await readFile(input.contextFile, "utf8"));
      return { stdout: `${input.agent} replied PLAN7`, exitCode: 0 };
    };

    await runHeadlessTurn({
      session,
      addresses: [
        { agent: "claude", prompt: "make a plan" },
        { agent: "codex", prompt: "audit the plan" },
      ],
      bus: new ChatEventBus(),
      turn: 1,
      laneClass: "chat",
      grant: CHAT_GRANT,
      config: { dbPath, blobRoot },
      signal: new AbortController().signal,
      sequential: true,
      dispatch,
    });

    expect(seenPrompts).toHaveLength(2);
    // FALSIFYING: claude runs first; codex's prompt MUST carry claude's reply (the hand-off), and claude's
    // own prompt must NOT (it hadn't replied when its prompt was built) — proving the threading is real.
    expect(seenPrompts[1]).toContain("claude replied PLAN7");
    expect(seenPrompts[0]).not.toContain("claude replied PLAN7");
  });
});

describe("runHeadlessTurn: each address dispatches with its OWN grant (per-segment capability)", () => {
  it("uses the address grant, not the turn-level grant", async () => {
    const { session, dbPath, blobRoot } = await makeSession();
    const grants: Array<AgentGrant | undefined> = [];
    const dispatch: HeadlessDispatch = async (input): Promise<AgentResult> => {
      grants.push(input.grant);
      return { stdout: "ok", exitCode: 0 };
    };

    await runHeadlessTurn({
      session,
      addresses: [
        { agent: "claude", prompt: "plan", grant: CHAT_GRANT },
        { agent: "codex", prompt: "build", grant: BUILD_GRANT },
      ],
      bus: new ChatEventBus(),
      turn: 1,
      laneClass: "chat",
      grant: RESEARCH_GRANT,
      config: { dbPath, blobRoot },
      signal: new AbortController().signal,
      sequential: true,
      dispatch,
    });

    expect(grants).toEqual([CHAT_GRANT, BUILD_GRANT]); // each segment's own grant, not the turn-level RESEARCH_GRANT
  });
});

// Runs one headless turn with a capturing fake dispatch (no CLI spawn) and returns the per-lane AgentInputs,
// so the agy-continuity test can assert which lane carried the agyConversationDir continuity signal.
async function captureLaneInputs(
  session: ChatSession,
  cfg: { dbPath: string; blobRoot: string },
  addresses: readonly HeadlessAddress[],
): Promise<AgentInput[]> {
  const captured: AgentInput[] = [];
  const dispatch: HeadlessDispatch = async (input): Promise<AgentResult> => {
    captured.push(input);
    return { stdout: "ok", exitCode: 0 };
  };
  await runHeadlessTurn({
    session,
    addresses,
    bus: new ChatEventBus(),
    turn: 1,
    laneClass: "chat",
    grant: CHAT_GRANT,
    config: cfg,
    signal: new AbortController().signal,
    dispatch,
  });
  return captured;
}

describe("runHeadlessTurn: agy continuity — the gemini lane carries the session dir, others don't", () => {
  it("sets agyConversationDir = session.runDir for the gemini lane only (strict-schema agents excluded)", async () => {
    const { session, dbPath, blobRoot } = await makeSession();
    const captured = await captureLaneInputs(session, { dbPath, blobRoot }, [
      { agent: "gemini", prompt: "hi" },
      { agent: "claude", prompt: "hi" },
    ]);

    // The agy adapter persists/resumes its conversation id under this dir (fresh-vs-resume is decided there
    // by the .agy-conversation file — covered in agy.test.ts), so the gemini lane carries the session dir.
    expect(captured.find((c) => c.agent === "gemini")?.agyConversationDir).toBe(session.runDir);
    const claude = captured.find((c) => c.agent === "claude");
    // claude/codex use a strict Zod input schema — the agy-only key must be absent.
    expect(claude !== undefined && "agyConversationDir" in claude).toBe(false);
  });
});

describe("runHeadlessTurn: post-turn usage capture stays silent without a fresh payload", () => {
  it("emits no agent.status for claude/gemini lanes when no fresh statusLine payload exists", async () => {
    const { session, dbPath, blobRoot } = await makeSession();
    const bus = new ChatEventBus();
    // The two halves, collected SEPARATELY. `agent.status` carries independent halves from independent
    // sources (events.ts:270-272): the usage half is this test's contract, and since W4-R2a-5 the dispatch
    // recorder also emits the AUTH half on every successful lane. Splitting the collectors keeps the
    // original assertion exact AND lets this test assert the new emit rather than merely tolerate it.
    const usageStatuses: string[] = [];
    const authStatuses: string[] = [];
    bus.on("agent.status", (e) => {
      if (e.usage !== undefined) usageStatuses.push(e.agent);
      if (e.auth !== undefined) authStatuses.push(`${e.agent}:${e.auth}`);
    });
    const dispatch: HeadlessDispatch = async (): Promise<AgentResult> => ({
      stdout: "ok",
      exitCode: 0,
    });

    await runHeadlessTurn({
      session,
      addresses: [
        { agent: "claude", prompt: "hi" },
        { agent: "gemini", prompt: "hi" },
      ],
      bus,
      turn: 1,
      laneClass: "chat",
      grant: CHAT_GRANT,
      config: { dbPath, blobRoot },
      signal: new AbortController().signal,
      dispatch,
    });

    // FALSIFYING: defaultCaptureUsage runs captureClaudeStatus + captureAgyStatus for these lanes (codex NIT:
    // the prior "codex-only" framing was stale — capture now covers all three). Each freshness-gates on this
    // turn's start, so with no payload written at/after it, NONE emits.
    expect(usageStatuses).toEqual([]);
    // W4-R2a-5: both lanes ANSWERED, so both are provably reachable — a stale boot probe must not keep
    // painting either one red. Missing usage is silence; a successful dispatch is not.
    // SET, NOT SEQUENCE (pre-existing flake fixed 2026-07-27): the two lanes dispatch CONCURRENTLY, so
    // which status lands first is undetermined — `toEqual` asserted an order production never promised
    // and failed ~1 run in 4 (reproduced at abb0c12, before this wave). The guarantee is unchanged: each
    // lane reports once and BOTH read ready, so neither is left painted red by a stale boot probe.
    expect([...authStatuses].sort()).toEqual(["claude:ready", "gemini:ready"]);
  });
});

describe("runHeadlessTurn: advisory usage capture never delays the lane (codex BLOCK-1)", () => {
  it("returns the lane outcome WITHOUT awaiting a hung post-lane capture", async () => {
    const { session, dbPath, blobRoot } = await makeSession();
    let captureStarted = false;
    let captureSettled = false;
    const captureUsage = async (): Promise<void> => {
      captureStarted = true;
      await new Promise<void>(() => {}); // never resolves — a hung rollout walk / payload read
      captureSettled = true;
    };
    const dispatch: HeadlessDispatch = async (): Promise<AgentResult> => ({
      stdout: "the answer",
      exitCode: 0,
    });

    const outcomes = await runHeadlessTurn({
      session,
      addresses: [{ agent: "claude", prompt: "hello" }],
      bus: new ChatEventBus(),
      turn: 1,
      laneClass: "chat",
      grant: CHAT_GRANT,
      config: { dbPath, blobRoot },
      signal: new AbortController().signal,
      dispatch,
      captureUsage,
    });

    // FALSIFYING: with the capture AWAITED on the lane path, the hung capture blocks runHeadlessTurn and this
    // test TIMES OUT. Fire-and-forget → the lane returns its outcome; the capture is kicked off but not awaited.
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.text).toBe("the answer");
    expect(captureStarted).toBe(true);
    expect(captureSettled).toBe(false);
  }, 3000);
});

const abortedSignal = (): AbortSignal => {
  const ac = new AbortController();
  ac.abort();
  return ac.signal;
};
const liveSignal = (): AbortSignal => new AbortController().signal;
describe("runHeadlessTurn: dispatch.failed carries the honest terminal state (F-2 wiring)", () => {
  const cases = [
    { label: "abort", signal: abortedSignal, error: new Error("boom"), expected: "cancelled" },
    {
      label: "timeout",
      signal: liveSignal,
      error: Object.assign(new Error("cap"), { timedOut: true }),
      expected: "timed_out",
    },
    {
      label: "crash",
      signal: liveSignal,
      error: new DispatchError("claude refused", "claude", 7),
      expected: "failed",
    },
  ] as const;

  for (const { label, signal, error, expected } of cases) {
    it(`a ${label} surfaces dispatch.failed.state = ${expected} (not a bare "failed")`, async () => {
      const { session, dbPath, blobRoot } = await makeSession();
      const bus = new ChatEventBus();
      const events = captureBus(bus);
      const dispatch: HeadlessDispatch = async (): Promise<AgentResult> => {
        throw error;
      };
      const outcomes = await runHeadlessTurn({
        session,
        addresses: [{ agent: "claude", prompt: "go" }],
        bus,
        turn: 1,
        laneClass: "chat",
        grant: CHAT_GRANT,
        config: { dbPath, blobRoot },
        signal: signal(),
        dispatch,
      });
      const failed = events.find((e) => e.kind === "dispatch.failed");
      expect(failed?.kind === "dispatch.failed" ? failed.state : "").toBe(expected);
      expect(outcomes[0]?.state).toBe(expected);
    });
  }
});
