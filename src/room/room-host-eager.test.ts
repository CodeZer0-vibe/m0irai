/**
 * @file src/room/room-host-eager.test.ts
 * @purpose End-to-end V2 eager ACP lifecycle: background open, mode join, first-turn reuse, cleanup.
 * @exports (test suite)
 * @depends node:fs/promises, node:os, node:path, execa, vitest, ../chat/*, ./room-host
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, expect, it } from "vitest";
import type { LaneConnection } from "../adapters/acp/acp-lane-session.js";
import { carrierRuntime } from "../chat/lane-transport.js";
import { loadSession } from "../chat/session-store.js";
import type { AgentName } from "../chat/types.js";
import type { RoomEvent } from "./room-engine.js";
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

// FL-175: three sequential waitFor segments plus model/mode round trips; real headroom above the
// vitest 30_000 ms global default that this file's failures (verify:staged tree 4087a2f) exceeded.
it("warms Claude and Codex without prompting, applies Shift+Tab live, and reuses the session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zer0-room-eager-real-"));
  roots.push(root);
  await execa("git", ["init", "-q"], { cwd: root, shell: false });
  const trace = eagerCarrier();
  const events: RoomEvent[] = [];
  const host = await AliveRoomHost.create({
    repoRoot: root,
    dbPath: path.join(root, ".zer0", "evidence.db"),
    blobRoot: path.join(root, ".zer0", "blobs"),
    openConnection: trace.openConnection,
    onEvent: (event) => {
      events.push(event);
    },
  });
  try {
    expect(carrierRuntime()?.laneScopeId).toBe(host.sessionId());
    const activated = host.activateRecovered();
    expect(trace.newSessions.filter(({ agent }) => agent === "claude")).toEqual([]);
    await activated;
    await waitFor(() => trace.newSessions.length === 2);
    expect(trace.newSessions.map(({ agent }) => agent).sort()).toEqual(["claude", "codex"]);
    expect(trace.prompts).toEqual([]);
    expect((await loadSession(host.sessionId() as `chat-${string}`, root)).messages).toEqual([]);

    await assertWarmModelAndMode(host, trace, events);

    await host.submit({ requestId: "first-message", text: "@claude hello" });
    await waitFor(() => events.some((event) => event.type === "turn.completed"));
    expect(trace.newSessions.filter(({ agent }) => agent === "claude")).toHaveLength(1);
    expect(trace.prompts).toEqual([
      expect.objectContaining({ agent: "claude", sessionId: "eager-claude-1" }),
    ]);
  } finally {
    await host.shutdown();
    expect(carrierRuntime()).toBeUndefined();
  }
  expect(trace.closed.sort()).toEqual(["claude", "codex"]);
}, 90_000);

async function assertWarmModelAndMode(
  host: AliveRoomHost,
  trace: ReturnType<typeof eagerCarrier>,
  events: readonly RoomEvent[],
): Promise<void> {
  await expect(host.listModels("claude")).resolves.toMatchObject({
    currentModelId: "sonnet",
    models: [
      { id: "sonnet", label: "Sonnet" },
      { id: "opus", label: "Opus" },
    ],
  });
  await host.selectModel("claude", "opus");
  expect(trace.modelSets).toEqual([
    { agent: "claude", sessionId: "eager-claude-1", modelId: "opus" },
  ]);

  // A cycle is two events, not one: room-mode emits `pending` synchronously and `active` only after the
  // awaited lane apply. Wait for the terminal state of THIS cycle (events after the warm-up's own mode
  // events), so a loaded machine cannot catch the assertion between the two — the run has to prove the
  // apply landed, not that a cycle started.
  const modesBefore = claudeModeStatuses(events).length;
  await host.cycleMode({ requestId: "mode-before-message", text: "@claude" });
  expect(trace.modeSets.at(-1)).toMatchObject({ agent: "claude" });
  await waitFor(() => {
    const cycle = claudeModeStatuses(events).slice(modesBefore);
    return cycle.includes("pending") && cycle.at(-1) === "active";
  });
  const cycle = claudeModeStatuses(events).slice(modesBefore);
  expect(cycle).not.toContain("failed");
  expect(cycle.at(-1)).toBe("active");
}

function claudeModeStatuses(events: readonly RoomEvent[]): readonly string[] {
  return events
    .filter((event) => event.type === "agent.mode" && event.payload.agent === "claude")
    .map((event) => String(event.payload.status));
}

// FL-175: three sequential real AliveRoomHost create/shutdown cycles, each with its own waitFor;
// see the file-header note above for the same real-headroom rationale.
it("opens fresh native sessions for a new room and resumes them only when that room is continued", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zer0-room-eager-session-policy-"));
  roots.push(root);
  await execa("git", ["init", "-q"], { cwd: root, shell: false });
  const trace = eagerCarrier();
  const hostOptions = {
    repoRoot: root,
    dbPath: path.join(root, ".zer0", "evidence.db"),
    blobRoot: path.join(root, ".zer0", "blobs"),
    openConnection: trace.openConnection,
  } as const;

  const first = await AliveRoomHost.create(hostOptions);
  await first.activateRecovered();
  await waitFor(() => trace.newSessions.length === 2);
  const firstSessionId = first.sessionId() as `chat-${string}`;
  const firstNativeIds = trace.newSessions.map(({ sessionId }) => sessionId).sort();
  await first.shutdown();

  const second = await AliveRoomHost.create(hostOptions);
  await second.activateRecovered();
  await waitFor(() => trace.newSessions.length === 4);
  const secondNativeIds = trace.newSessions
    .slice(2)
    .map(({ sessionId }) => sessionId)
    .sort();
  expect(secondNativeIds).not.toEqual(firstNativeIds);
  expect(trace.resumes).toEqual([]);
  await second.shutdown();

  const continued = await AliveRoomHost.create({
    ...hostOptions,
    continueSessionId: firstSessionId,
  });
  try {
    await continued.activateRecovered();
    await waitFor(() => trace.resumes.length === 2);
    expect(trace.newSessions).toHaveLength(4);
    expect(trace.resumes.map(({ sessionId }) => sessionId).sort()).toEqual(firstNativeIds);
    expect(trace.resumes.map(({ sessionId }) => sessionId).sort()).not.toEqual(secondNativeIds);
    expect(trace.prompts).toEqual([]);
  } finally {
    await continued.shutdown();
  }
}, 90_000);

it("an immediate submit stays responsive while its lane joins the in-flight warm-up", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zer0-room-eager-race-"));
  roots.push(root);
  await execa("git", ["init", "-q"], { cwd: root, shell: false });
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const trace = eagerCarrier({ claudeOpenGate: gate });
  const events: RoomEvent[] = [];
  const host = await AliveRoomHost.create({
    repoRoot: root,
    dbPath: path.join(root, ".zer0", "evidence.db"),
    blobRoot: path.join(root, ".zer0", "blobs"),
    openConnection: trace.openConnection,
    onEvent: (event) => {
      events.push(event);
    },
  });
  try {
    void host.activateRecovered();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const submitted = host.submit({ requestId: "racing-first-message", text: "@claude hello" });
    await submitted;
    expect(events.some((event) => event.type === "turn.completed")).toBe(false);
    expect(trace.newSessions.filter(({ agent }) => agent === "claude")).toEqual([]);

    release?.();
    await waitFor(() => events.some((event) => event.type === "turn.completed"));
    expect(trace.newSessions.filter(({ agent }) => agent === "claude")).toHaveLength(1);
    expect(trace.prompts).toEqual([
      expect.objectContaining({ agent: "claude", sessionId: "eager-claude-1" }),
    ]);
  } finally {
    await host.shutdown();
  }
}, 60_000);

it("shutdown during warm-up closes a bridge that appears late and leaves no held session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zer0-room-eager-shutdown-"));
  roots.push(root);
  await execa("git", ["init", "-q"], { cwd: root, shell: false });
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const trace = eagerCarrier({ claudeOpenGate: gate });
  const host = await AliveRoomHost.create({
    repoRoot: root,
    dbPath: path.join(root, ".zer0", "evidence.db"),
    blobRoot: path.join(root, ".zer0", "blobs"),
    openConnection: trace.openConnection,
  });
  void host.activateRecovered();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const shuttingDown = host.shutdown();
  release?.();
  await shuttingDown;
  await waitFor(() => trace.closed.includes("claude"));
  expect(carrierRuntime()).toBeUndefined();
  expect(trace.newSessions.filter(({ agent }) => agent === "claude")).toEqual([]);
  expect(trace.prompts.filter(({ agent }) => agent === "claude")).toEqual([]);
}, 60_000);

it("shutdown aborts bridge ownership and returns before a stuck session handshake answers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zer0-room-eager-stuck-shutdown-"));
  roots.push(root);
  await execa("git", ["init", "-q"], { cwd: root, shell: false });
  let release: (() => void) | undefined;
  let markStarted!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const trace = eagerCarrier({ claudeSessionGate: gate, onClaudeSessionStart: markStarted });
  const host = await AliveRoomHost.create({
    repoRoot: root,
    dbPath: path.join(root, ".zer0", "evidence.db"),
    blobRoot: path.join(root, ".zer0", "blobs"),
    openConnection: trace.openConnection,
    shutdownTimeoutMs: 500,
  });
  await host.activateRecovered();
  await started;

  await expect(host.shutdown()).resolves.toBeUndefined();
  expect(trace.signals.get("claude")?.aborted).toBe(true);
  expect(trace.closed).toContain("claude");
  expect(trace.newSessions.filter(({ agent }) => agent === "claude")).toEqual([]);

  release?.();
  await waitFor(() => trace.newSessions.some(({ agent }) => agent === "claude"));
  expect(carrierRuntime()).toBeUndefined();
}, 60_000);

function eagerCarrier(
  options: {
    readonly claudeOpenGate?: Promise<void>;
    readonly claudeSessionGate?: Promise<void>;
    readonly onClaudeSessionStart?: () => void;
  } = {},
) {
  const newSessions: Array<{ agent: AgentName; sessionId: string }> = [];
  const prompts: Array<{ agent: AgentName; sessionId: string }> = [];
  const modeSets: Array<{ agent: AgentName; sessionId: string; modeId: string }> = [];
  const modelSets: Array<{ agent: AgentName; sessionId: string; modelId: string }> = [];
  const resumes: Array<{ agent: AgentName; sessionId: string }> = [];
  const closed: AgentName[] = [];
  const signals = new Map<AgentName, AbortSignal>();
  const nextSessionNumber = new Map<AgentName, number>();
  return {
    newSessions,
    prompts,
    modeSets,
    modelSets,
    resumes,
    closed,
    signals,
    openConnection: async (input: {
      readonly agent: "claude" | "codex";
      readonly onText?: (chunk: string) => void;
      readonly signal?: AbortSignal;
    }): Promise<LaneConnection> => {
      if (input.agent === "claude") await options.claudeOpenGate;
      if (input.signal !== undefined) signals.set(input.agent, input.signal);
      return {
        initialize: async () => undefined,
        newSession: async () => {
          if (input.agent === "claude") {
            options.onClaudeSessionStart?.();
            await options.claudeSessionGate;
          }
          const sessionNumber = (nextSessionNumber.get(input.agent) ?? 0) + 1;
          nextSessionNumber.set(input.agent, sessionNumber);
          const sessionId = `eager-${input.agent}-${sessionNumber}`;
          newSessions.push({ agent: input.agent, sessionId });
          return {
            sessionId,
            models: {
              currentModelId: input.agent === "claude" ? "sonnet" : "gpt-5.6[high]",
              models:
                input.agent === "claude"
                  ? [
                      { modelId: "sonnet", name: "Sonnet" },
                      { modelId: "opus", name: "Opus" },
                    ]
                  : [{ modelId: "gpt-5.6[high]", name: "GPT-5.6 high" }],
            },
          };
        },
        resumeSession: async (sessionId) => {
          resumes.push({ agent: input.agent, sessionId });
          return {};
        },
        prompt: async (id) => {
          prompts.push({ agent: input.agent, sessionId: id });
          input.onText?.(`${input.agent} ready`);
          return "end_turn";
        },
        setMode: async (id, modeId) => {
          modeSets.push({ agent: input.agent, sessionId: id, modeId });
        },
        setModel: async (id, modelId) => {
          modelSets.push({ agent: input.agent, sessionId: id, modelId });
        },
        close: () => {
          closed.push(input.agent);
        },
        waitForExit: async () => true,
        killTree: async () => undefined,
        isAlive: () => true,
        pid: () => 1,
      };
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  await pollUntil(predicate, {
    timeoutMs: DEFAULT_POLL_TIMEOUT_MS,
    message: "eager room did not settle",
  });
}
