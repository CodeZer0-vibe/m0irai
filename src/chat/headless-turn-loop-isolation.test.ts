/**
 * @file src/chat/headless-turn-loop-isolation.test.ts
 * @purpose W5-A THE ISOLATION CONTRACT (amendments 1/2/8) routing falsifier: proves that a loop
 *   lane's laneClass ("dispatch") routes to the ISOLATED non-carrier path bound to the LOOP worktree
 *   cwd, even with the carrier DEFAULT-ON — never the carrier path that binds carrierRuntime().cwd
 *   (the MAIN repo), reaches resolveDecider/denyDecider (acp-lane-connection.ts), or emits
 *   mode.session into the operator transcript. The paired "chat"-laneClass test characterizes the
 *   exact violation the loop must avoid: with the carrier engaged, "chat" binds the MAIN repo cwd and
 *   bypasses the isolated seam entirely. Mirrors headless-carrier.test.ts's fake-carrier harness.
 * @exports (none — test suite)
 * @depends node:fs/promises, node:os, node:path, vitest, ../evidence/db, ../shared/agent-grant,
 *   ../shared/types, ./dispatch-headless, ./events, ./evidence, ./evidence-identity, ./headless-turn,
 *   ./lane-transport, ./types
 * @size-justified: one cohesive isolation-routing falsifier pair sharing ONE fixture + fake-carrier
 *   helper — splitting the two laneClass legs would duplicate that setup for no isolation gain.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { BUILD_GRANT } from "../shared/agent-grant.js";
import type { AgentResult } from "../shared/types.js";
import type { HeadlessDispatch } from "./dispatch-headless.js";
import { ChatEventBus } from "./events.js";
import { chatRunId } from "./evidence-identity.js";
import { recordChatSession } from "./evidence.js";
import { runHeadlessTurn } from "./headless-turn.js";
import { initCarrierRuntime, resetCarrierRuntime } from "./lane-transport.js";
import type { ChatSession } from "./types.js";

const dirs: string[] = [];
const saved = { memory: process.env.ZER0_MEMORY, resume: process.env.ZER0_NATIVE_RESUME };

afterEach(async () => {
  resetCarrierRuntime();
  restore("ZER0_MEMORY", saved.memory);
  restore("ZER0_NATIVE_RESUME", saved.resume);
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

interface IsolationFixture {
  readonly mainRepoRoot: string;
  readonly loopWorktreeRoot: string;
  readonly session: ChatSession;
  readonly dbPath: string;
  readonly blobRoot: string;
}

// A MAIN repo (the carrier runtime's cwd) and a DISTINCT loop worktree (the loop session's repoRoot).
// The isolation violation is precisely a loop lane binding the carrier's MAIN cwd instead of its own
// worktree — so the two roots MUST differ for the assertions below to be load-bearing.
async function makeIsolationFixture(): Promise<IsolationFixture> {
  const mainRepoRoot = await mkdtemp(path.join(tmpdir(), "w5a-iso-main-"));
  const loopWorktreeRoot = await mkdtemp(path.join(tmpdir(), "w5a-iso-wt-"));
  dirs.push(mainRepoRoot, loopWorktreeRoot);
  const runDir = path.join(loopWorktreeRoot, "run");
  await mkdir(path.join(runDir, "prompts"), { recursive: true });
  await mkdir(path.join(runDir, "responses"), { recursive: true });
  const blobRoot = path.join(loopWorktreeRoot, "blobs");
  await mkdir(blobRoot, { recursive: true });
  const dbPath = path.join(mainRepoRoot, "evidence.db");
  const now = new Date().toISOString();
  const id = "chat-loop-iso" as const;
  await recordChatSession({
    dbPath,
    sessionId: id,
    runId: chatRunId(id),
    repoRoot: loopWorktreeRoot,
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
    repoRoot: loopWorktreeRoot,
    runDir,
    createdAt: now,
    updatedAt: now,
    defaultAgent: "claude",
    lastAgent: null,
    summary: { text: "", throughTurn: 0 },
    messages: [],
  };
  return { mainRepoRoot, loopWorktreeRoot, session, dbPath, blobRoot };
}

interface CarrierProbe {
  openedCwd: string | undefined;
  prompts: number;
}

// A fake carrier whose connection RECORDS the cwd it is opened with (the isolation-critical binding)
// and whether its prompt ran — bound to mainRepoRoot, exactly as the real runtime binds
// carrierRuntime().cwd. lanesEnabled defaults true, so usesCarrier()'s runtime gate is satisfied.
function initFakeCarrier(mainRepoRoot: string, dbPath: string, probe: CarrierProbe): void {
  initCarrierRuntime({
    projectId: "p1",
    dbPath,
    repoRoot: mainRepoRoot,
    cwd: mainRepoRoot,
    openConnection: async (input) => {
      probe.openedCwd = input.cwd;
      return {
        initialize: async () => ({}),
        newSession: async () => ({ sessionId: "s-carrier" }),
        resumeSession: async () => ({}),
        prompt: async (_sessionId, _text, emit) => {
          probe.prompts += 1;
          emit?.({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } });
          input.onText?.("carrier reply");
          return "end_turn";
        },
        setMode: async () => undefined,
        close: () => undefined,
        waitForExit: async () => true,
        killTree: async () => undefined,
        isAlive: () => true,
        pid: () => 31337,
      };
    },
  });
}

// PARITY (all-3 law): the isolation contract must hold for EVERY loop-spawned agent, not just claude --
// the loop-spawn test NAMES all three rather than inheriting parity from the adapter tests. laneClass
// "dispatch" bypasses usesCarrier() for claude/codex/gemini alike, so each dispatches through the
// non-carrier seam bound to the LOOP worktree, with the carrier never opened.
for (const agent of ["claude", "codex", "gemini"] as const) {
  it(`W5-A ISOLATION CONTRACT (items 1/2/7): a loop-spawned ${agent} lane (laneClass 'dispatch', carrier DEFAULT-ON) dispatches through the non-carrier seam bound to the LOOP worktree — the carrier (main-repo cwd, denyDecider/ask, mode.session) is never reached`, async () => {
    process.env.ZER0_MEMORY = "1"; // carrier default-on/engaged — the exact isolation-risk condition
    process.env.ZER0_NATIVE_RESUME = "1";
    const { mainRepoRoot, loopWorktreeRoot, session, dbPath, blobRoot } =
      await makeIsolationFixture();
    const probe: CarrierProbe = { openedCwd: undefined, prompts: 0 };
    initFakeCarrier(mainRepoRoot, dbPath, probe);
    let dispatchedCwd: string | undefined;
    const dispatch: HeadlessDispatch = async (input): Promise<AgentResult> => {
      dispatchedCwd = input.worktreePath;
      return { stdout: "isolated build reply", exitCode: 0 };
    };

    const outcomes = await runHeadlessTurn({
      session,
      addresses: [{ agent, prompt: "build it" }],
      bus: new ChatEventBus(),
      turn: 1,
      laneClass: "dispatch",
      grant: BUILD_GRANT,
      config: { dbPath, blobRoot },
      signal: new AbortController().signal,
      dispatch,
    });

    // The isolated seam ran, bound to the LOOP worktree — never the carrier's mainRepoRoot.
    expect(dispatchedCwd).toBe(loopWorktreeRoot);
    expect(dispatchedCwd).not.toBe(mainRepoRoot);
    // The carrier was never even OPENED — so resolveDecider/denyDecider (acp-lane-connection.ts) and the
    // mode.session emit (headless-carrier.ts) are unreachable by construction for a loop lane.
    expect(probe.openedCwd).toBeUndefined();
    expect(probe.prompts).toBe(0);
    expect(outcomes[0]?.exitCode).toBe(0);
  });
}

it("W5-A ISOLATION CONTRACT — the violation the loop must avoid: laneClass 'chat' + carrier DEFAULT-ON binds the carrier's MAIN-repo cwd and bypasses the isolated seam entirely", async () => {
  process.env.ZER0_MEMORY = "1";
  process.env.ZER0_NATIVE_RESUME = "1";
  const { mainRepoRoot, loopWorktreeRoot, session, dbPath, blobRoot } =
    await makeIsolationFixture();
  const probe: CarrierProbe = { openedCwd: undefined, prompts: 0 };
  initFakeCarrier(mainRepoRoot, dbPath, probe);
  let dispatchCalled = false;
  const dispatch: HeadlessDispatch = async (): Promise<AgentResult> => {
    dispatchCalled = true;
    return { stdout: "", exitCode: 0 };
  };

  await runHeadlessTurn({
    session,
    addresses: [{ agent: "claude", prompt: "build it" }],
    bus: new ChatEventBus(),
    turn: 1,
    laneClass: "chat",
    grant: BUILD_GRANT,
    config: { dbPath, blobRoot },
    signal: new AbortController().signal,
    dispatch,
  });

  // "chat" + carrier engaged binds the carrier's MAIN repo cwd (NOT the loop worktree) — the exact
  // isolation violation W5-A closes by moving loop lanes to "dispatch".
  expect(probe.openedCwd).toBe(mainRepoRoot);
  expect(probe.openedCwd).not.toBe(loopWorktreeRoot);
  // ...and the isolated non-carrier seam is bypassed entirely.
  expect(dispatchCalled).toBe(false);
});
