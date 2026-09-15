/**
 * @file src/chat/headless-carrier-usage.test.ts
 * @purpose Carrier-path usage falsifiers: ACP usage_update and agy statusline payloads must update
 *   agent.status and emit usage.payload observability instead of silently disappearing.
 * @exports (test suite - no runtime exports)
 * @depends node:fs, node:fs/promises, node:os, node:path, vitest, ../adapters/agy, ../evidence/db, ./agy-statusline-config, ./events, ./evidence, ./evidence-identity, ./headless-turn, ./lane-transport
 */
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AgyLaneStateInput } from "../adapters/agy.js";
import { closeDb, openLaneStateDb } from "../evidence/db.js";
import { CHAT_GRANT } from "../shared/agent-grant.js";
import type { AgentResult } from "../shared/types.js";
import { agyStatuslinePaths } from "./agy-statusline-config.js";
import type { HeadlessDispatch } from "./dispatch-headless.js";
import { type ChatEvent, ChatEventBus } from "./events.js";
import { chatRunId } from "./evidence-identity.js";
import { recordChatSession } from "./evidence.js";
import { runHeadlessTurn } from "./headless-turn.js";
import { initCarrierRuntime, resetCarrierRuntime } from "./lane-transport.js";
import type { AgentName, ChatSession } from "./types.js";

const { fakeAgyWithLaneState } = vi.hoisted(() => ({ fakeAgyWithLaneState: vi.fn() }));
vi.mock("../adapters/agy.js", () => ({ dispatchAgy: { withLaneState: fakeAgyWithLaneState } }));
vi.mock("../adapters/pty/agy-version.js", () => ({ probeAgyVersion: async () => "1.0.8" }));

type UsagePayloadEvent = {
  readonly agent: AgentName;
  readonly droppedCount?: number;
  readonly fields: readonly string[];
  readonly kind: "usage.payload";
  readonly outcome: "arrived" | "missing" | "stale" | "malformed" | "write-failed" | "deduped";
  readonly sample?: unknown;
  readonly source: string;
  readonly turn: number;
};
type LooseBus = { on(kind: string, handler: (event: UsagePayloadEvent) => void): void };

const dirs: string[] = [];
const savedFlags = {
  memory: process.env.ZER0_MEMORY,
  resume: process.env.ZER0_NATIVE_RESUME,
  statuslineDir: process.env.ZER0_STATUSLINE_DIR,
};

afterEach(async () => {
  resetCarrierRuntime();
  restoreFlag("ZER0_MEMORY", savedFlags.memory);
  restoreFlag("ZER0_NATIVE_RESUME", savedFlags.resume);
  fakeAgyWithLaneState.mockReset();
  await rm(agyStatuslinePaths().payloadPath, { force: true });
  restoreFlag("ZER0_STATUSLINE_DIR", savedFlags.statuslineDir);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("FALSIFIER: ACP carrier usage_update updates codex agent.status and traces arrived", async () => {
  const { session, dbPath, blobRoot } = await makeSession();
  initFakeCarrier(session, dbPath, (emit) =>
    emit({ sessionUpdate: "usage_update", used: 25, size: 100 }),
  );
  const bus = new ChatEventBus();
  const statuses = captureStatuses(bus);
  const payloads = capturePayloads(bus);

  await runHeadlessTurn(turnInput({ session, dbPath, blobRoot, bus, agent: "codex", turn: 1 }));
  await waitFor(() => payloads.length > 0);

  expect(statuses[0]).toMatchObject({ agent: "codex", usage: { contextUsedPct: 25 } });
  const normalized = payloads.find((event) => event.source === "acp.usage_update");
  expect(normalized).toMatchObject({
    agent: "codex",
    kind: "usage.payload",
    outcome: "arrived",
    source: "acp.usage_update",
    turn: 1,
  });
  expect(normalized?.fields).toContain("contextUsedPct");
});

it("RED: the real captured Claude turn reaches the carrier and produces ctx plus 5h plus weekly", async () => {
  const { session, dbPath, blobRoot } = await makeSession();
  const updates = await capturedClaudeUpdates();
  initFakeCarrier(session, dbPath, (emit) => {
    for (const update of updates) emit(update);
  });
  const bus = new ChatEventBus();
  const statuses = captureStatuses(bus);

  await runHeadlessTurn(turnInput({ session, dbPath, blobRoot, bus, agent: "claude", turn: 5 }));

  const final = statuses
    .filter((event) => event.kind === "agent.status" && event.agent === "claude")
    .at(-1);
  expect(final).toMatchObject({
    usage: { contextUsedPct: 4, fiveHourUsedPct: 70, weeklyUsedPct: 55 },
  });
});

it("FALSIFIER: fresh agy carrier payload updates gemini agent.status and traces arrived", async () => {
  const { session, dbPath, blobRoot } = await makeSession();
  initFakeCarrier(session, dbPath);
  const statuslineCwd = path.join(session.repoRoot, ".zer0", "agy", "run-test");
  fakeAgyPayload(statuslineCwd, { remaining: 0.4 });
  const bus = new ChatEventBus();
  const statuses = captureStatuses(bus);
  const payloads = capturePayloads(bus);

  await runHeadlessTurn(turnInput({ session, dbPath, blobRoot, bus, agent: "gemini", turn: 2 }));
  await waitFor(() => payloads.length > 0);

  expect(statuses[0]).toMatchObject({ agent: "gemini", usage: { label: "60%" } });
  expect(payloads[0]).toMatchObject({
    agent: "gemini",
    outcome: "arrived",
    source: "agy.statusline",
  });
});

it("falsifier: Gemini never receives ACP raw-update activity, even when the fake ACP transport emits one", async () => {
  const { session, dbPath, blobRoot } = await makeSession();
  initFakeCarrier(session, dbPath, (emit) =>
    emit({ sessionUpdate: "tool_call", toolCallId: "must-not-reach-gemini" }),
  );
  fakeAgyPayload(path.join(session.repoRoot, ".zer0", "agy", "run-test"), { remaining: 0.4 });
  const activity: unknown[] = [];

  await runHeadlessTurn({
    ...turnInput({ session, dbPath, blobRoot, bus: new ChatEventBus(), agent: "gemini", turn: 4 }),
    onLaneActivity: (_agent, update) => activity.push(update),
  });

  expect(activity).toEqual([]);
});

it("FALSIFIER: mismatched-cwd agy payload is rejected as stale and never updates status", async () => {
  const { session, dbPath, blobRoot } = await makeSession();
  initFakeCarrier(session, dbPath);
  fakeAgyPayload(
    "C:/elsewhere",
    { remaining: 0.2 },
    path.join(session.repoRoot, ".zer0", "agy", "run-test"),
  );
  const bus = new ChatEventBus();
  const statuses = captureStatuses(bus);
  const payloads = capturePayloads(bus);

  await runHeadlessTurn(turnInput({ session, dbPath, blobRoot, bus, agent: "gemini", turn: 3 }));
  await waitFor(() => payloads.length > 0);

  expect(statuses).toEqual([]);
  expect(payloads[0]).toMatchObject({
    agent: "gemini",
    outcome: "stale",
    source: "agy.statusline",
  });
});

it("FALSIFIER: no carrier usage source traces missing instead of silently doing nothing", async () => {
  const { session, dbPath, blobRoot } = await makeSession();
  initFakeCarrier(session, dbPath);
  const bus = new ChatEventBus();
  const payloads = capturePayloads(bus);

  await runHeadlessTurn(turnInput({ session, dbPath, blobRoot, bus, agent: "claude", turn: 4 }));
  await waitFor(() => payloads.length > 0);

  expect(payloads[0]).toMatchObject({ agent: "claude", outcome: "missing", turn: 4 });
});

// The USAGE half only. `agent.status` carries independent halves from independent sources (events.ts:270-
// 272), and since W4-R2a-5 the dispatch recorder ALSO emits the AUTH half on every successful lane — a lane
// that answered is reachable, whatever a stale boot probe said. This suite's contract is the usage half, so
// it listens to the usage half; the auth half has its own falsifiers (lane-gate.test.ts + the end-to-end
// status-bar-recovery.test.tsx). Narrowing the LISTENER, never an assertion — every usage event this suite
// could ever have seen still arrives here.
function captureStatuses(bus: ChatEventBus): ChatEvent[] {
  const events: ChatEvent[] = [];
  bus.on("agent.status", (event) => {
    if (event.usage !== undefined) events.push(event);
  });
  return events;
}

function capturePayloads(bus: ChatEventBus): UsagePayloadEvent[] {
  const events: UsagePayloadEvent[] = [];
  (bus as LooseBus).on("usage.payload", (event) => events.push(event));
  return events;
}

function fakeAgyPayload(
  cwd: string,
  quota: { readonly remaining: number },
  statuslineCwd: string = cwd,
): void {
  fakeAgyWithLaneState.mockImplementation(async (input: AgyLaneStateInput) => {
    writeAgyPayload(cwd, quota.remaining);
    input.store.bumpGeneration(input.db, {
      adapterPkg: input.adapterPkg,
      adapterVersion: input.adapterVersion,
      cwd: input.cwd,
      agent: "gemini",
      now: input.now(),
      projectId: input.projectId,
      sessionId: "agy-usage-test",
    });
    return {
      outcome: "persisted",
      conversationId: "agy-usage-test",
      result: { exitCode: 0, stdout: "ok" },
      statuslineCwd,
    };
  });
}

function writeAgyPayload(cwd: string, remaining: number): void {
  mkdirSync(path.dirname(agyStatuslinePaths().payloadPath), { recursive: true });
  const payload = {
    cwd,
    context_window: { used_percentage: 12 },
    quota: { "gemini-5h": { remaining_fraction: remaining } },
    session_id: "agy-usage-test",
  };
  const target = agyStatuslinePaths().payloadPath;
  writeFileSync(target, JSON.stringify(payload), "utf8");
  const fresh = new Date(Date.now() + 1000);
  utimesSync(target, fresh, fresh);
}

function initFakeCarrier(
  session: ChatSession,
  dbPath: string,
  onEmit?: (emit: (update: unknown) => void) => void,
): void {
  process.env.ZER0_MEMORY = "1";
  process.env.ZER0_NATIVE_RESUME = "1";
  insertProject(dbPath, session);
  initCarrierRuntime({
    projectId: "p1",
    dbPath,
    repoRoot: session.repoRoot,
    cwd: session.repoRoot,
    openConnection: async (input) => ({
      initialize: async () => ({}),
      newSession: async () => ({ sessionId: "s-carrier" }),
      resumeSession: async () => ({}),
      prompt: async (_sessionId, _text, emit) => {
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

async function makeSession(): Promise<{ session: ChatSession; dbPath: string; blobRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "headless-carrier-usage-"));
  dirs.push(root);
  process.env.ZER0_STATUSLINE_DIR = path.join(root, "statusline");
  const runDir = path.join(root, "run");
  await mkdir(path.join(runDir, "prompts"), { recursive: true });
  await mkdir(path.join(runDir, "responses"), { recursive: true });
  const blobRoot = path.join(root, "blobs");
  await mkdir(blobRoot, { recursive: true });
  const dbPath = path.join(root, "evidence.db");
  const now = new Date().toISOString();
  await recordChatSession({
    dbPath,
    sessionId: "chat-carrier-usage",
    runId: chatRunId("chat-carrier-usage"),
    repoRoot: root,
    runDir,
    createdAt: now,
    updatedAt: now,
    defaultAgent: "claude",
    lastAgent: null,
    summaryText: "",
    summaryThroughTurn: 0,
  });
  return { session: chatSession(root, runDir, now), dbPath, blobRoot };
}

function chatSession(root: string, runDir: string, now: string): ChatSession {
  return {
    id: "chat-carrier-usage",
    repoRoot: root,
    runDir,
    createdAt: now,
    updatedAt: now,
    defaultAgent: "claude",
    lastAgent: null,
    summary: { text: "", throughTurn: 0 },
    messages: [],
  };
}

type TurnInputArgs = Readonly<{
  session: ChatSession;
  dbPath: string;
  blobRoot: string;
  bus: ChatEventBus;
  agent: AgentName;
  turn: number;
}>;

function turnInput(args: TurnInputArgs) {
  const { session, dbPath, blobRoot, bus, agent, turn } = args;
  const dispatch: HeadlessDispatch = async (): Promise<AgentResult> => {
    throw new Error("buffered dispatch must not run");
  };
  return {
    session,
    addresses: [{ agent, prompt: "hello" }],
    bus,
    turn,
    laneClass: "chat" as const,
    grant: CHAT_GRANT,
    config: { dbPath, blobRoot },
    signal: new AbortController().signal,
    dispatch,
    usagePoll: { intervalMs: 1, timeoutMs: 5 },
  };
}

function insertProject(dbPath: string, session: ChatSession): void {
  const db = openLaneStateDb(dbPath);
  try {
    db.prepare(
      "INSERT OR IGNORE INTO projects(project_id, canonical_root, git_common_dir, created_at) VALUES (?,?,?,?)",
    ).run("p1", session.repoRoot, path.join(session.repoRoot, ".git"), session.createdAt);
  } finally {
    closeDb(db);
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 300;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function capturedClaudeUpdates(): Promise<unknown[]> {
  const fixture = path.resolve(
    import.meta.dirname,
    "..",
    "..",
    "tests",
    "fixtures",
    "probe-claude-acp-updates.jsonl",
  );
  const lines = (await readFile(fixture, "utf8")).split(/\r?\n/).filter(Boolean);
  return lines.map((line) => (JSON.parse(line) as { readonly update: unknown }).update);
}

function restoreFlag(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}
