/**
 * @file src/chat/lane-transport-decider.test.ts
 * @purpose Split from lane-transport.test.ts for the 600-line hard ceiling (mirrors use-cockpit-bus-
 *   review-open.test.tsx's own split precedent, T-C7): W4-3's operator-decider threading through the
 *   lane transport — setCarrierDecider's factory -> runtimeTransportInput -> openConnection's
 *   input.decide (resetCarrierDecider clears it), and sendHeld's invalidatePendingAsk-on-settle wiring
 *   (a still-pending ask for the lane's agent is force-denied when its own prompt() call settles).
 * @exports (none — test file)
 * @depends vitest, ../adapters/acp/acp-lane-session, ../adapters/acp/acp-permission, ./events,
 *   ./lane-transport, ./permission-ask
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { LaneConnection } from "../adapters/acp/acp-lane-session.js";
import type { PermissionDecider } from "../adapters/acp/acp-permission.js";
import { closeDb, openLaneStateDb } from "../evidence/db.js";
import { ChatEventBus } from "./events.js";
import {
  createCockpitLaneTransport,
  getOrCreateLaneTransport,
  initCarrierRuntime,
  resetCarrierDecider,
  resetCarrierRuntime,
  setCarrierDecider,
} from "./lane-transport.js";
import { createOperatorPermissionDecider, resetPermissionAskRegistry } from "./permission-ask.js";

const tempRoots: string[] = [];

afterEach(() => {
  resetCarrierRuntime();
  resetPermissionAskRegistry();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface FakeConn {
  conn: LaneConnection;
  state: {
    alive: boolean;
    killed: number;
    promptResult: string;
    promptError?: Error;
  };
}

function fakeConnection(sessionId = "s-created"): FakeConn {
  const state: FakeConn["state"] = { alive: true, killed: 0, promptResult: "end_turn" };
  const conn: LaneConnection = {
    initialize: async () => ({}),
    newSession: async () => ({ sessionId }),
    resumeSession: async () => ({}),
    prompt: async () => {
      if (state.promptError) throw state.promptError;
      return state.promptResult;
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

function tempDb(projectId = "p1"): { dbPath: string; root: string } {
  const root = mkdtempSync(path.join(tmpdir(), "lane-decider-"));
  tempRoots.push(root);
  const dbPath = path.join(root, "evidence.db");
  const db = openLaneStateDb(dbPath);
  db.prepare(
    "INSERT INTO projects(project_id, canonical_root, git_common_dir, created_at) VALUES (?,?,?,?)",
  ).run(projectId, "C:/repo", "C:/repo/.git", "2026-07-10T00:00:00Z");
  closeDb(db);
  return { dbPath, root };
}

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
  return { transport };
}

// W4-3: sendHeld's `finally` calls invalidatePendingAsk(agent) after EVERY prompt() settle — success
// or failure — since a permission ask can only be raised WHILE a prompt() call is in flight, so that
// SAME call settling with an ask still open is, by construction, "the ask outlived its turn" (the
// FAIL-CLOSED case W4-3 names). Registers a REAL pending ask (not a bare bus event) ahead of send() —
// this is a WIRING test (sendHeld reaches invalidatePendingAsk with the right agent), not a re-test of
// invalidatePendingAsk's own settlement logic (permission-ask.test.ts already covers that exhaustively).
it("send() invalidates an ask still pending for this lane's agent — on BOTH the accept and failure paths", async () => {
  const bus = new ChatEventBus();
  const accepted = fakeConnection("s-1");
  const acceptedAsk = createOperatorPermissionDecider(
    "claude",
    bus,
  )({
    options: [{ optionId: "no", kind: "reject_once" }],
  });
  const h1 = harness([accepted]);
  await h1.transport.start(undefined);
  await h1.transport.send("x", "s-1");
  await expect(acceptedAsk).resolves.toEqual({ kind: "selected", optionId: "no" });

  const failing = fakeConnection("s-2");
  failing.state.promptError = new Error("bridge pipe broke");
  const failedAsk = createOperatorPermissionDecider(
    "claude",
    bus,
  )({
    options: [{ optionId: "no", kind: "reject_once" }],
  });
  const h2 = harness([failing]);
  await h2.transport.start(undefined);
  await h2.transport.send("y", "s-2");
  await expect(failedAsk).resolves.toEqual({ kind: "selected", optionId: "no" });
});

it("send() with no ask ever pending never touches the ask registry — invalidate is a silent no-op", async () => {
  const a = fakeConnection("s-1");
  const h = harness([a]);
  await h.transport.start(undefined);
  // No throw, no side effect to observe — this asserts only that send() completes normally with
  // nothing registered for permission-ask.ts to invalidate.
  await expect(h.transport.send("x", "s-1")).resolves.toEqual({ outcome: "accepted" });
});

// W4-3: the operator-facing decider factory threads through runtimeTransportInput's conditional
// spread (the SAME pattern openConnection already uses) into openConnection's own input — never
// hardcoded, never silently dropped. setCarrierDecider is independent of initCarrierRuntime (set at a
// LATER boot point once the event bus exists — see lane-transport.ts's own header comment above it).
it("setCarrierDecider's factory (called with the lane's agent) reaches openConnection's input.decide", async () => {
  const { dbPath } = tempDb();
  const a = fakeConnection("s-1");
  let capturedAgent: string | undefined;
  let capturedDecide: unknown;
  const fakeDecide: PermissionDecider = async () => ({ kind: "selected", optionId: "allow" });
  try {
    setCarrierDecider((agent) => {
      capturedAgent = agent;
      return fakeDecide;
    });
    initCarrierRuntime({
      projectId: "p1",
      dbPath,
      repoRoot: "C:/repo",
      cwd: "C:/repo",
      openConnection: async (input) => {
        capturedDecide = (input as { decide?: unknown }).decide;
        return a.conn;
      },
    });
    await getOrCreateLaneTransport("claude").start(undefined);
    expect(capturedAgent).toBe("claude");
    expect(capturedDecide).toBe(fakeDecide);
  } finally {
    resetCarrierDecider();
  }
});

it("resetCarrierDecider clears the factory — a later lane open threads no decide field at all", async () => {
  const { dbPath } = tempDb();
  const a = fakeConnection("s-1");
  let sawDecideKey: boolean | undefined;
  setCarrierDecider(() => async () => ({ kind: "selected", optionId: "allow" }));
  resetCarrierDecider();
  initCarrierRuntime({
    projectId: "p1",
    dbPath,
    repoRoot: "C:/repo",
    cwd: "C:/repo",
    openConnection: async (input) => {
      sawDecideKey = Object.hasOwn(input, "decide");
      return a.conn;
    },
  });
  await getOrCreateLaneTransport("claude").start(undefined);
  expect(sawDecideKey).toBe(false);
});

it("createCockpitLaneTransport's OWN input.decide (bypassing the runtime factory) also reaches openConnection", async () => {
  const a = fakeConnection("s-1");
  let capturedDecide: unknown;
  const fakeDecide: PermissionDecider = async () => ({ kind: "selected", optionId: "allow" });
  const transport = createCockpitLaneTransport({
    agent: "claude",
    cwd: "C:/repo",
    repoRoot: "C:/repo",
    decide: fakeDecide,
    openConnection: async (input) => {
      capturedDecide = (input as { decide?: unknown }).decide;
      return a.conn;
    },
  });
  await transport.start(undefined);
  expect(capturedDecide).toBe(fakeDecide);
});
