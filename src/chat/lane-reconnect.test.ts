/**
 * @file src/chat/lane-reconnect.test.ts
 * @purpose BLOCK 3 (FIX-3b): the RECONNECT contract — a recovery attempt must never ride the connection
 *   that died, and a bridge session the adapter has permanently ended must never be handed back as a
 *   live hold. Asserts at the REAL transport seam (createCockpitLaneTransport's own `openConnection`
 *   injection point + the carrier registry), never on a hand-made transport double. Sibling file of
 *   lane-transport.test.ts, which is already size-justified at its own ceiling.
 * @exports (none — test file)
 * @depends node:fs, node:os, node:path, vitest, ../adapters/acp/acp-lane-session, ../evidence/db,
 *   ./events, ./lane-availability-store, ./lane-gate, ./lane-transport
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LaneConnection } from "../adapters/acp/acp-lane-session.js";
import { closeDb, openLaneStateDb } from "../evidence/db.js";
import { ChatEventBus } from "./events.js";
import {
  initLaneAvailabilityStore,
  noteLaneFailure,
  resetLaneAvailabilityStore,
} from "./lane-availability-store.js";
import { gateLaneOrBlock } from "./lane-gate.js";
import {
  createCockpitLaneTransport,
  dropLaneHold,
  getOrCreateLaneTransport,
  initCarrierRuntime,
  resetCarrierRuntime,
} from "./lane-transport.js";
import { resetPermissionAskRegistry } from "./permission-ask.js";

// The adapter's OWN permanent-death strings (@agentclientprotocol/claude-agent-acp 0.58.1):
// dist/acp-agent.js:108 (SESSION_ENDED_MESSAGE, thrown by prompt() forever once queryClosed is set at
// :579-581) and dist/acp-agent.js:1871 (the process-death sibling). Quoted verbatim so a future adapter
// bump that rewords them fails HERE, loudly, instead of silently re-opening the wedge.
const SESSION_ENDED = "The Claude Agent session has ended. Please start a new session.";
const PROCESS_EXITED = "The Claude Agent process exited unexpectedly. Please start a new session.";
const AUTH_DEATH = "Authentication required";
const FIFTEEN_MIN = 15 * 60_000;

const tempRoots: string[] = [];

afterEach(() => {
  resetCarrierRuntime();
  resetPermissionAskRegistry();
  resetLaneAvailabilityStore();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface FakeConn {
  conn: LaneConnection;
  state: { alive: boolean; killed: number; prompts: number; promptError?: Error };
}

function fakeConnection(sessionId: string): FakeConn {
  const state: FakeConn["state"] = { alive: true, killed: 0, prompts: 0 };
  const conn: LaneConnection = {
    initialize: async () => ({}),
    newSession: async () => ({ sessionId }),
    resumeSession: async () => ({}),
    prompt: async () => {
      state.prompts += 1;
      if (state.promptError) throw state.promptError;
      return "end_turn";
    },
    setMode: async () => undefined,
    close: () => {
      state.killed += 1;
      state.alive = false;
    },
    waitForExit: async () => true,
    killTree: async () => undefined,
    isAlive: () => state.alive,
    pid: () => 4242,
  };
  return { conn, state };
}

function tempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

/** A transport built through the PRODUCTION factory with only its documented connection seam injected. */
function harness(conns: FakeConn[]) {
  let opened = 0;
  const transport = createCockpitLaneTransport({
    agent: "claude",
    cwd: "C:/repo",
    repoRoot: "C:/repo",
    openConnection: async () => {
      const next = conns[opened];
      if (next === undefined) throw new Error("no more fake connections");
      opened += 1;
      return next.conn;
    },
  });
  return { transport, openedCount: () => opened };
}

/** The carrier registry wired to fake connections — the seam gateLaneOrBlock reaches through. */
function registry(conns: FakeConn[]) {
  const root = tempRoot("lane-reconnect-");
  const dbPath = path.join(root, "evidence.db");
  const db = openLaneStateDb(dbPath);
  db.prepare(
    "INSERT INTO projects(project_id, canonical_root, git_common_dir, created_at) VALUES (?,?,?,?)",
  ).run("p1", "C:/repo", "C:/repo/.git", "2026-07-10T00:00:00Z");
  closeDb(db);
  let opened = 0;
  initCarrierRuntime({
    projectId: "p1",
    dbPath,
    repoRoot: root,
    cwd: "C:/repo",
    openConnection: async () => {
      const next = conns[opened];
      if (next === undefined) throw new Error("no more fake connections");
      opened += 1;
      return next.conn;
    },
  });
  return { root, openedCount: () => opened };
}

describe("BLOCK 3: a permanently-ended bridge session is never handed back as a live hold", () => {
  it("a send that fails with the adapter's session-ended error DROPS the hold — the next start opens fresh", async () => {
    const a = fakeConnection("s-1");
    const b = fakeConnection("s-2");
    const h = harness([a, b]);
    await h.transport.start(undefined);
    a.state.promptError = new Error(SESSION_ENDED);
    const sent = await h.transport.send("hello", "s-1");
    expect(sent.outcome).toBe("failed");
    // THE WEDGE: the child is still alive (isAlive() is process-level, acp-lane-connection.ts:203) so
    // the old fast path at lane-transport.ts:180-183 would return `resumed` on the dead session forever.
    expect(a.state.alive).toBe(false); // dropped through the close ladder, not abandoned
    expect(a.state.killed).toBe(1);
    const next = await h.transport.start("s-1");
    expect(next.outcome).toBe("resumed");
    expect(h.openedCount()).toBe(2); // a REAL reconnect, not the held fast path
  });

  it("a send that fails with the adapter's process-exited error also drops the hold", async () => {
    const a = fakeConnection("s-1");
    const b = fakeConnection("s-2");
    const h = harness([a, b]);
    await h.transport.start(undefined);
    a.state.promptError = new Error(PROCESS_EXITED);
    await h.transport.send("hello", "s-1");
    await h.transport.start("s-1");
    expect(h.openedCount()).toBe(2);
  });
});

// The anti-respawn fence: these two passed BEFORE the fix and must keep passing after it — the drop is
// triggered ONLY by a proven-dead session, never by an ordinary failure or a healthy turn.
describe("BLOCK 3: the hold survives everything that does NOT prove the session is dead", () => {
  it("an ORDINARY send failure keeps the hold — a transport hiccup is not a respawn trigger", async () => {
    const a = fakeConnection("s-1");
    const h = harness([a]);
    await h.transport.start(undefined);
    a.state.promptError = new Error("bridge rejected the prompt");
    const sent = await h.transport.send("hello", "s-1");
    expect(sent.outcome).toBe("failed");
    expect(a.state.killed).toBe(0);
    const next = await h.transport.start("s-1");
    expect(next).toEqual({ outcome: "resumed", sessionId: "s-1" }); // the fast path, untouched
    expect(h.openedCount()).toBe(1); // THE no-per-turn-respawn invariant still holds
  });

  it("a SUCCESSFUL send keeps the hold (the healthy-lane regression)", async () => {
    const a = fakeConnection("s-1");
    const h = harness([a]);
    await h.transport.start(undefined);
    expect(await h.transport.send("hello", "s-1")).toEqual({ outcome: "accepted" });
    expect(await h.transport.start("s-1")).toEqual({ outcome: "resumed", sessionId: "s-1" });
    expect(h.openedCount()).toBe(1);
    expect(a.state.killed).toBe(0);
  });
});

describe("BLOCK 3: dropLaneHold (the registry seam)", () => {
  it("closes the held child through the existing ladder and forces the next start to reconnect", async () => {
    const a = fakeConnection("s-1");
    const b = fakeConnection("s-2");
    const reg = registry([a, b]);
    const transport = getOrCreateLaneTransport("claude");
    await transport.start(undefined);
    expect(await dropLaneHold("claude")).toBe(true);
    expect(a.state.killed).toBe(1);
    await transport.start("s-1");
    expect(reg.openedCount()).toBe(2);
  });

  it("is a no-op (never creates a transport) when the lane has none — and when no runtime exists", async () => {
    expect(await dropLaneHold("claude")).toBe(false); // no runtime at all
    registry([fakeConnection("s-1")]);
    expect(await dropLaneHold("claude")).toBe(false); // runtime, but this lane was never opened
  });
});

/** One gate context for this file's cases, all of which are LIVE turns. FL-144 made
 *  LaneGateContext.signal required so no outcome can be synthesized in lane-gate.ts without the cancel
 *  signal in scope; a never-aborted controller is what a turn nobody stopped actually carries. The
 *  already-aborted counterpart has its own contract file, lane-gate-cancel.test.ts. */
function liveGateCtx(repoRoot: string, nowMs: number) {
  return {
    bus: new ChatEventBus(),
    repoRoot,
    turn: 9,
    nowMs,
    signal: new AbortController().signal,
  };
}

describe("BLOCK 3: the gate forces a fresh connection on a sanctioned retry", () => {
  it("a needs_auth lane whose window reset retries on a NEW connection, not the wedged hold", async () => {
    const a = fakeConnection("s-1");
    const b = fakeConnection("s-2");
    const reg = registry([a, b]);
    initLaneAvailabilityStore(reg.root);
    const transport = getOrCreateLaneTransport("claude");
    await transport.start(undefined);
    noteLaneFailure("claude", AUTH_DEATH, 1000);
    const ctx = liveGateCtx(reg.root, 1000 + FIFTEEN_MIN + 1);
    expect(await gateLaneOrBlock(ctx, "claude")).toBeUndefined(); // allowed as the recovery attempt
    expect(a.state.killed).toBe(1); // the wedged hold was closed BEFORE dispatch
    await transport.start("s-1");
    expect(reg.openedCount()).toBe(2);
  });

  it("a HEALTHY lane's gate pass leaves the hold intact (no reconnect, no respawn)", async () => {
    const a = fakeConnection("s-1");
    const reg = registry([a]);
    initLaneAvailabilityStore(reg.root);
    const transport = getOrCreateLaneTransport("claude");
    await transport.start(undefined);
    const ctx = liveGateCtx(reg.root, 5000);
    expect(await gateLaneOrBlock(ctx, "claude")).toBeUndefined();
    expect(a.state.killed).toBe(0);
    expect(await transport.start("s-1")).toEqual({ outcome: "resumed", sessionId: "s-1" });
    expect(reg.openedCount()).toBe(1);
  });

  it("a BLOCKED lane (no sanctioned retry) does not touch the hold either", async () => {
    const a = fakeConnection("s-1");
    const reg = registry([a]);
    initLaneAvailabilityStore(reg.root);
    const transport = getOrCreateLaneTransport("claude");
    await transport.start(undefined);
    noteLaneFailure("claude", AUTH_DEATH, 1000);
    const ctx = liveGateCtx(reg.root, 2000);
    expect(await gateLaneOrBlock(ctx, "claude")).toBeDefined(); // blocked locally
    expect(a.state.killed).toBe(0);
    expect(reg.openedCount()).toBe(1);
  });
});
