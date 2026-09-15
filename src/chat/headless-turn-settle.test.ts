/**
 * @file src/chat/headless-turn-settle.test.ts
 * @purpose Falsifying contract for the U1 lane-settle WRITE BARRIER: onLaneSettled fires EXACTLY ONCE per
 *   opened lane, AWAITED after that lane's finalize and BEFORE its outcome resolves into the aggregate, so a
 *   per-agent tail releases on ITS lane's completion (not the turn's); a throw/rejection is isolated; a
 *   clean-but-empty lane is reclassified FAILED before finalize (one terminal event); a failed lane's merged
 *   message self-labels. Real bus + temp sqlite + a FAKE dispatch seam (no CLI spawn) drive the REAL runOneLane.
 * @exports (test suite — no runtime exports)
 * @depends node:fs/promises, node:os, node:path, vitest, ../shared/errors, ../shared/types, ./dispatch-headless, ./events, ./evidence, ./evidence-identity, ./headless-turn, ./tower-bridge-lane, ./types
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CHAT_GRANT } from "../shared/agent-grant.js";
import { DispatchError } from "../shared/errors.js";
import type { AgentResult } from "../shared/types.js";
import type { HeadlessDispatch } from "./dispatch-headless.js";
import { type ChatEvent, ChatEventBus, type ChatEventKind } from "./events.js";
import { chatRunId } from "./evidence-identity.js";
import { recordChatSession } from "./evidence.js";
import { mergeHeadlessOutcomes, runHeadlessTurn } from "./headless-turn.js";
import type { LaneOutcome } from "./tower-bridge-lane.js";
import type { AgentName, ChatMessage, ChatSession } from "./types.js";

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

// A real temp sqlite + run dirs + the parent chat_sessions row, so finalizeLane exercises the REAL evidence
// write path (not a swallowed FK failure) — same fixture shape as headless-turn.test.ts.
async function makeSession(): Promise<{ session: ChatSession; dbPath: string; blobRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "headless-settle-"));
  dirs.push(root);
  const runDir = path.join(root, "run");
  await mkdir(path.join(runDir, "prompts"), { recursive: true });
  await mkdir(path.join(runDir, "responses"), { recursive: true });
  const blobRoot = path.join(root, "blobs");
  await mkdir(blobRoot, { recursive: true });
  const dbPath = path.join(root, "evidence.db");
  const now = new Date().toISOString();
  const id = "chat-settle-test" as const;
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Dispatch whose NON-claude lanes BLOCK on `gate`: sibling settle is impossible until the test
// releases it — a happens-before by construction, not by wall-clock margin. A prior version
// scripted 0/50/100ms timer delays; under a starved fork pool the 50ms margin lost to settle-I/O
// variance (codex settled first) even though per-lane independence makes that reordering legal.
function gatedDispatch(gate: Promise<void>): HeadlessDispatch {
  return async (input): Promise<AgentResult> => {
    if (input.agent !== "claude") await gate;
    return { stdout: `${input.agent} done`, exitCode: 0 };
  };
}

describe("runHeadlessTurn: onLaneSettled fires per lane, before the aggregate resolves (U1)", () => {
  it("the FIRST lane to finish settles while the slower two lanes are still unresolved", async () => {
    const { session, dbPath, blobRoot } = await makeSession();
    const settleOrder: AgentName[] = [];
    let orderAtClaudeSettle: AgentName[] | undefined;
    const claudeSettle = deferred();
    const siblingGate = deferred();
    // Recorded state is asserted OUTSIDE the callback: an in-callback throw would be swallowed by the
    // lane's isolation, so an assertion there could never fail the test.
    const onLaneSettled = async (agent: AgentName): Promise<ChatMessage | undefined> => {
      settleOrder.push(agent);
      if (agent === "claude") {
        orderAtClaudeSettle = [...settleOrder];
        claudeSettle.resolve();
      }
      return undefined;
    };

    const turn = runHeadlessTurn({
      session,
      addresses: [
        { agent: "claude", prompt: "hi" },
        { agent: "codex", prompt: "hi" },
        { agent: "gemini", prompt: "hi" },
      ],
      bus: new ChatEventBus(),
      turn: 1,
      laneClass: "chat",
      grant: CHAT_GRANT,
      config: { dbPath, blobRoot },
      signal: new AbortController().signal,
      dispatch: gatedDispatch(siblingGate.promise),
      onLaneSettled,
    });

    // FALSIFYING: a per-TURN barrier could not settle claude while its siblings are still gated —
    // this await would hang to the test timeout. Per-lane independence resolves it.
    await claudeSettle.promise;
    siblingGate.resolve();
    const outcomes = await turn;

    expect(outcomes).toHaveLength(3);
    // Claude settled ALONE while both siblings were provably unresolved (gated at dispatch).
    expect(orderAtClaudeSettle).toEqual(["claude"]);
    expect(settleOrder[0]).toBe("claude");
    expect([...settleOrder].sort()).toEqual(["claude", "codex", "gemini"]);
  });
});

describe("runHeadlessTurn: onLaneSettled receives the FAILED outcome for a failing lane (U1)", () => {
  it("fires with state 'failed' for the failing lane; the sibling lane is unaffected", async () => {
    const { session, dbPath, blobRoot } = await makeSession();
    const settled: Array<{ agent: AgentName; state: string; exitCode: number }> = [];
    const onLaneSettled = async (
      agent: AgentName,
      outcome: LaneOutcome,
    ): Promise<ChatMessage | undefined> => {
      settled.push({ agent, state: outcome.state, exitCode: outcome.exitCode });
      return undefined;
    };
    const dispatch: HeadlessDispatch = async (input): Promise<AgentResult> => {
      if (input.agent === "codex") throw new DispatchError("codex refused", "codex", 7);
      return { stdout: `${input.agent} ok`, exitCode: 0 };
    };

    await runHeadlessTurn({
      session,
      addresses: [
        { agent: "claude", prompt: "hi" },
        { agent: "codex", prompt: "hi" },
      ],
      bus: new ChatEventBus(),
      turn: 1,
      laneClass: "chat",
      grant: CHAT_GRANT,
      config: { dbPath, blobRoot },
      signal: new AbortController().signal,
      dispatch,
      onLaneSettled,
    });

    expect(settled.find((s) => s.agent === "codex")?.state).toBe("failed");
    expect(settled.find((s) => s.agent === "codex")?.exitCode).not.toBe(0);
    expect(settled.find((s) => s.agent === "claude")?.state).toBe("completed");
  });
});

describe("runHeadlessTurn: a REJECTING onLaneSettled never fails the lane (U1, isolated barrier)", () => {
  it("returns the lane outcome normally even though the settle callback threw", async () => {
    const { session, dbPath, blobRoot } = await makeSession();
    const onLaneSettled = async (): Promise<ChatMessage | undefined> => {
      throw new Error("settle write blew up");
    };
    const dispatch: HeadlessDispatch = async (): Promise<AgentResult> => ({
      stdout: "the answer",
      exitCode: 0,
    });

    const outcomes = await runHeadlessTurn({
      session,
      addresses: [{ agent: "claude", prompt: "hi" }],
      bus: new ChatEventBus(),
      turn: 1,
      laneClass: "chat",
      grant: CHAT_GRANT,
      config: { dbPath, blobRoot },
      signal: new AbortController().signal,
      dispatch,
      onLaneSettled,
    });

    // FALSIFYING: an un-isolated await would reject runHeadlessTurn; the lane must resolve with its outcome.
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.text).toBe("the answer");
    expect(outcomes[0]?.exitCode).toBe(0);
  });
});

describe("runHeadlessTurn: a HELD-OPEN onLaneSettled holds the aggregate (U1, write barrier)", () => {
  it("does not resolve the turn until the settle promise settles", async () => {
    const { session, dbPath, blobRoot } = await makeSession();
    let entered = false;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onLaneSettled = async (): Promise<ChatMessage | undefined> => {
      entered = true;
      await gate; // held open — the barrier must hold the aggregate HERE
      return undefined;
    };
    const dispatch: HeadlessDispatch = async (): Promise<AgentResult> => ({
      stdout: "answer",
      exitCode: 0,
    });

    let resolved = false;
    const pending = runHeadlessTurn({
      session,
      addresses: [{ agent: "claude", prompt: "hi" }],
      bus: new ChatEventBus(),
      turn: 1,
      laneClass: "chat",
      grant: CHAT_GRANT,
      config: { dbPath, blobRoot },
      signal: new AbortController().signal,
      dispatch,
      onLaneSettled,
    }).then((outcomes) => {
      resolved = true;
      return outcomes;
    });

    // Wait until the barrier is REACHED (finalize done, callback entered): it must now be blocking.
    while (!entered) await sleep(5);
    // FALSIFYING: without the AWAITED barrier the turn would already have resolved here.
    expect(resolved).toBe(false);
    release();
    const outcomes = await pending;
    expect(resolved).toBe(true);
    expect(outcomes[0]?.text).toBe("answer");
  }, 5000);
});

describe("runHeadlessTurn: a clean but EMPTY lane is reclassified FAILED — one terminal event (U1)", () => {
  it("emits exactly one dispatch.failed (empty-result reason) and zero dispatch.completed", async () => {
    const { session, dbPath, blobRoot } = await makeSession();
    const bus = new ChatEventBus();
    const events = captureBus(bus);
    // Ran cleanly (exit 0) but produced NOTHING — the empty→failed reclassification (before finalize).
    const dispatch: HeadlessDispatch = async (): Promise<AgentResult> => ({
      stdout: "",
      exitCode: 0,
    });

    const outcomes = await runHeadlessTurn({
      session,
      addresses: [{ agent: "claude", prompt: "hi" }],
      bus,
      turn: 1,
      laneClass: "chat",
      grant: CHAT_GRANT,
      config: { dbPath, blobRoot },
      signal: new AbortController().signal,
      dispatch,
    });

    const kinds = events.map((e) => e.kind);
    expect(kinds.filter((k) => k === "dispatch.completed")).toHaveLength(0);
    expect(kinds.filter((k) => k === "dispatch.failed")).toHaveLength(1);
    const failed = events.find((e) => e.kind === "dispatch.failed");
    expect(failed?.kind === "dispatch.failed" ? failed.error : "").toContain("empty");
    expect(outcomes[0]?.state).toBe("failed");
    expect(outcomes[0]?.exitCode).not.toBe(0);
  });
});

describe("runHeadlessTurn: with NO onLaneSettled the seam is inert (U1, legacy unchanged)", () => {
  it("a successful lane emits started → stdout → completed and returns its text, as before", async () => {
    const { session, dbPath, blobRoot } = await makeSession();
    const bus = new ChatEventBus();
    const events = captureBus(bus);
    const dispatch: HeadlessDispatch = async (): Promise<AgentResult> => ({
      stdout: "unchanged",
      exitCode: 0,
    });

    const outcomes = await runHeadlessTurn({
      session,
      addresses: [{ agent: "claude", prompt: "hi" }],
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
    expect(outcomes[0]?.text).toBe("unchanged");
    expect(outcomes[0]?.state).toBe("completed");
  });
});

describe("mergeHeadlessOutcomes: a FAILED lane's message SELF-LABELS as a failure (U1, status-blind)", () => {
  it("prefixes a failure marker + reason so a status-blind transcript renderer shows it as failed", async () => {
    const { session } = await makeSession();
    const failed: LaneOutcome = {
      agent: "codex",
      text: "half an answer",
      exitCode: 1,
      state: "failed",
      error: "max_tokens",
    };

    const next = mergeHeadlessOutcomes(session, [failed], 1);

    const message = next.messages.at(-1);
    expect(message?.status).toBe("failed");
    // FALSIFYING: pre-fix the message text was the raw "half an answer" — indistinguishable from a
    // successful reply to a renderer that prints text status-blind. It must now self-label as a failure.
    expect(message?.text.startsWith("⚠")).toBe(true);
    expect(message?.text).toContain("max_tokens");
  });
});
