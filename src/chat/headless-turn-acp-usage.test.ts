/**
 * @file src/chat/headless-turn-acp-usage.test.ts
 * @purpose Falsifying contract for U2d — claude's usage under ACP. A claude lane whose ACP result carries
 *   turn usage (used/size) emits ONE agent.status with ctx% derived; a lane without usage stays silent, and
 *   a codex lane's usage is NOT emitted from this path (codex keeps its rollout SSOT). The file-poll capture
 *   seam is stubbed so each assertion isolates the ACP-result emit. Split from headless-turn.test.ts (600-line
 *   hard clamp).
 * @exports (test suite — no runtime exports)
 * @depends node:fs/promises, node:os, node:path, vitest, ../shared/turn-usage, ./dispatch-headless, ./events, ./evidence, ./evidence-identity, ./headless-turn, ./types
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHAT_GRANT } from "../shared/agent-grant.js";
import type { AgentResultWithUsage } from "../shared/turn-usage.js";
import { resetClaudeWindowFold } from "./claude-usage-fold.js";
import type { HeadlessDispatch } from "./dispatch-headless.js";
import { type AgentStatusUpdateEvent, ChatEventBus } from "./events.js";
import { chatRunId } from "./evidence-identity.js";
import { recordChatSession } from "./evidence.js";
import { runHeadlessTurn } from "./headless-turn.js";
import type { ChatSession } from "./types.js";

const dirs: string[] = [];

// The USAGE half only. `agent.status` carries independent halves from independent sources (events.ts:270-
// 272), and since W4-R2a-5 the dispatch recorder ALSO emits the AUTH half on every successful lane — a lane
// that answered is reachable, whatever a stale boot probe said. This file's contract is the usage half, so
// its collectors listen to the usage half. Narrowing the LISTENER, never an assertion: every usage event
// these tests could ever have seen still arrives. The auth half's own falsifiers are lane-gate.test.ts and
// the end-to-end status-bar-recovery.test.tsx.
function usageOnly(event: AgentStatusUpdateEvent, collect: () => void): void {
  if (event.usage !== undefined) collect();
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

// The chat-layer window fold is process-scoped BY DESIGN (it exists to outlive per-turn ACP sessions) —
// reset it per test so every describe in this file is order-independent.
beforeEach(() => {
  resetClaudeWindowFold();
});

// Minimal real-sqlite session harness: temp run dirs + the chat_sessions parent row so finalizeLane's
// evidence write hits the REAL happy path (a swallowed FK failure would hide a regression).
async function makeSession(): Promise<{ session: ChatSession; dbPath: string; blobRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "headless-acp-usage-"));
  dirs.push(root);
  const runDir = path.join(root, "run");
  await mkdir(path.join(runDir, "prompts"), { recursive: true });
  await mkdir(path.join(runDir, "responses"), { recursive: true });
  const blobRoot = path.join(root, "blobs");
  await mkdir(blobRoot, { recursive: true });
  const dbPath = path.join(root, "evidence.db");
  const now = new Date().toISOString();
  const id = "chat-acp-usage-test" as const;
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

describe("runHeadlessTurn: claude usage under ACP lights the status bar from the result", () => {
  it("emits agent.status for a claude lane with ctx% derived from the ACP result usage (used/size)", async () => {
    const { session, dbPath, blobRoot } = await makeSession();
    const bus = new ChatEventBus();
    const statuses: AgentStatusUpdateEvent[] = [];
    bus.on("agent.status", (e) => usageOnly(e, () => statuses.push(e)));
    // The ACP transport reports the turn's context usage ON the result; the file-poll capture seam is stubbed
    // (captureUsage) so this asserts the ACP-result emit IN ISOLATION.
    const dispatch: HeadlessDispatch = async (): Promise<AgentResultWithUsage> => ({
      stdout: "hi",
      exitCode: 0,
      usage: { used: 40_000, size: 200_000 },
    });

    await runHeadlessTurn({
      session,
      addresses: [{ agent: "claude", prompt: "hi" }],
      bus,
      turn: 1,
      laneClass: "chat",
      grant: CHAT_GRANT,
      config: { dbPath, blobRoot },
      signal: new AbortController().signal,
      dispatch,
      captureUsage: async () => {},
    });

    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.agent).toBe("claude");
    expect(statuses[0]?.usage?.contextUsedPct).toBe(20); // 40_000 / 200_000 = 20%
    expect(statuses[0]?.usage?.label).toBe("ctx");
    // No rate-limit windows on this result and none learned this process → absent (never faked). Windows
    // DO flow over ACP when the adapter forwards rate_limit_event (U2d-b) — covered by the B1 describe below.
    expect(statuses[0]?.usage?.fiveHourUsedPct).toBeUndefined();
    expect(statuses[0]?.usage?.weeklyUsedPct).toBeUndefined();
  });
});

describe("runHeadlessTurn: the ACP-result usage emit is claude-only and silent without usage", () => {
  it("emits NO agent.status for a claude lane whose result carries no usage (pty / older adapter)", async () => {
    const { session, dbPath, blobRoot } = await makeSession();
    const bus = new ChatEventBus();
    const statuses: string[] = [];
    bus.on("agent.status", (e) => usageOnly(e, () => statuses.push(e.agent)));
    const dispatch: HeadlessDispatch = async (): Promise<AgentResultWithUsage> => ({
      stdout: "ok",
      exitCode: 0,
    });

    await runHeadlessTurn({
      session,
      addresses: [{ agent: "claude", prompt: "hi" }],
      bus,
      turn: 1,
      laneClass: "chat",
      grant: CHAT_GRANT,
      config: { dbPath, blobRoot },
      signal: new AbortController().signal,
      dispatch,
      captureUsage: async () => {},
    });

    expect(statuses).toEqual([]); // no usage on the result → nothing emitted from the ACP path
  });
});

// PRODUCTION SHAPE (codex B1): dispatchAcpTurn opens and CLOSES a session per turn (acp-turn.ts:121), so
// the in-session window fold restarts every turn — turn 2's usage arrives ctx-only even though the
// account's weekly window is still live. The chat layer must carry the learned windows across turns.
const B1_TURN_RESULTS: readonly AgentResultWithUsage[] = [
  {
    stdout: "one",
    exitCode: 0,
    usage: {
      used: 100,
      size: 1000,
      rateLimits: {
        seven_day: { status: "allowed_warning", utilization: 82, resetsAt: 2_000_000_000 },
      },
    },
  },
  { stdout: "two", exitCode: 0, usage: { used: 200, size: 1000 } },
];

// One result per call, in order — a spent script fails loudly instead of silently repeating.
function scriptedDispatch(results: readonly AgentResultWithUsage[]): HeadlessDispatch {
  let call = 0;
  return async (): Promise<AgentResultWithUsage> => {
    const result = results[call];
    call += 1;
    return result ?? { stdout: "script spent", exitCode: 1 };
  };
}

describe("runHeadlessTurn: claude's learned windows survive per-turn sessions (codex wave-review B1)", () => {
  it("a ctx-only turn 2 still emits the weekly meter learned in turn 1 (fresh ACP session each turn)", async () => {
    const { session, dbPath, blobRoot } = await makeSession();
    const bus = new ChatEventBus();
    const statuses: AgentStatusUpdateEvent[] = [];
    bus.on("agent.status", (e) => usageOnly(e, () => statuses.push(e)));
    const base = {
      session,
      bus,
      laneClass: "chat" as const,
      grant: CHAT_GRANT,
      config: { dbPath, blobRoot },
      signal: new AbortController().signal,
      dispatch: scriptedDispatch(B1_TURN_RESULTS),
      captureUsage: async () => {},
    };
    const claude = [{ agent: "claude" as const, prompt: "hi" }];

    await runHeadlessTurn({ ...base, addresses: claude, turn: 1 });
    await runHeadlessTurn({ ...base, addresses: claude, turn: 2 });

    expect(statuses).toHaveLength(2);
    // Turn 1 carried the windows → the weekly meter lights.
    expect(statuses[0]?.usage?.weeklyUsedPct).toBe(82);
    // Turn 2's fresh ctx% wins — but the learned weekly meter MUST NOT blank (the model merge is
    // wholesale-replace, cockpit-model.ts:348: a ctx-only emit would erase it from the bar).
    expect(statuses[1]?.usage?.contextUsedPct).toBe(20);
    expect(statuses[1]?.usage?.weeklyUsedPct).toBe(82);
    expect(statuses[1]?.usage?.weeklyResetsAtMs).toBe(2_000_000_000_000);
    expect(statuses[1]?.usage?.label).toBe("82%");
  });
});

describe("runHeadlessTurn: codex ACP result usage emits ctx% before rollout fallback", () => {
  it("emits context usage for a codex lane WITH usage", async () => {
    const { session, dbPath, blobRoot } = await makeSession();
    const bus = new ChatEventBus();
    const statuses: string[] = [];
    bus.on("agent.status", (e) => usageOnly(e, () => statuses.push(e.agent)));
    const dispatch: HeadlessDispatch = async (): Promise<AgentResultWithUsage> => ({
      stdout: "ok",
      exitCode: 0,
      usage: { used: 50_000, size: 200_000 },
    });

    await runHeadlessTurn({
      session,
      addresses: [{ agent: "codex", prompt: "hi" }],
      bus,
      turn: 1,
      laneClass: "chat",
      grant: CHAT_GRANT,
      config: { dbPath, blobRoot },
      signal: new AbortController().signal,
      dispatch,
      captureUsage: async () => {},
    });

    expect(statuses).toEqual(["codex"]);
  });
});
