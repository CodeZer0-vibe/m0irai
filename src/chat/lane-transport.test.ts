/**
 * @file src/chat/lane-transport.test.ts
 * @purpose Contract the held ACP lane lifecycle, routing, model/mode mutation, and bounded cleanup.
 * @exports (test suite)
 * @depends vitest, ../adapters/acp/acp-lane-session, ./lane-transport
 * @size-justified: Cohesive transport lifecycle regression suite already split from decider coverage.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { LaneConnection } from "../adapters/acp/acp-lane-session.js";
import { closeDb, openLaneStateDb } from "../evidence/db.js";
import {
  carrierRuntime,
  closeAllLaneTransports,
  createCockpitLaneTransport,
  getOrCreateLaneTransport,
  initCarrierRuntime,
  resetCarrierRuntime,
  setLaneMode,
} from "./lane-transport.js";
import { persistNativeMode } from "./native-mode-store.js";
import { initialNativeModeState } from "./native-mode.js";
import { resetPermissionAskRegistry } from "./permission-ask.js";

// B1/B2 (MAX review fix round 1): every REAL create/resume in this file now goes through
// applyRestoredMode, reading repoRoot's (fake, non-existent in most tests) .zer0/native-mode.json —
// which degrades to initialNativeModeState() (native-mode-store.ts's own documented no-file-yet
// path), so claude's automatic apply always targets its catalog default. The "already held and
// alive, same session" fast path never re-applies (see start()'s own comment) — untouched below.
const DEFAULT_MODE_APPLIED = {
  outcome: "applied" as const,
  modeId: "default",
  origin: "confirmed" as const,
};

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
    treeKilled: number;
    resumes: string[];
    prompts: { sessionId: string; text: string }[];
    modeSets: { sessionId: string; modeId: string }[];
    modelSets: { sessionId: string; modelId: string }[];
    promptResult: string;
    promptError?: Error;
    resumeError?: Error;
    modeError?: Error;
    updatesToEmit: unknown[];
    waitForExitResult: boolean;
  };
}

function fakeConnection(sessionId = "s-created"): FakeConn {
  const state = fakeConnectionState();
  const conn: LaneConnection = {
    initialize: async () => ({}),
    newSession: async () => ({
      sessionId,
      models: {
        currentModelId: "sonnet",
        models: [
          { modelId: "sonnet", name: "Sonnet" },
          { modelId: "opus", name: "Opus" },
        ],
      },
    }),
    resumeSession: async (id) => {
      if (state.resumeError) throw state.resumeError;
      state.resumes.push(id);
      return {};
    },
    prompt: async (sid, text, emit) => {
      state.prompts.push({ sessionId: sid, text });
      for (const update of state.updatesToEmit) emit(update);
      if (state.promptError) throw state.promptError;
      return state.promptResult;
    },
    setMode: async (sid, modeId) => {
      state.modeSets.push({ sessionId: sid, modeId });
      if (state.modeError) throw state.modeError;
    },
    setModel: async (sid, modelId) => {
      state.modelSets.push({ sessionId: sid, modelId });
    },
    close: () => {
      state.killed += 1;
      state.alive = false;
    },
    waitForExit: async () => state.waitForExitResult,
    killTree: async () => {
      state.treeKilled += 1;
    },
    isAlive: () => state.alive,
    pid: () => 4242,
  };
  return { conn, state };
}

function fakeConnectionState(): FakeConn["state"] {
  return {
    alive: true,
    killed: 0,
    treeKilled: 0,
    resumes: [],
    prompts: [],
    modeSets: [],
    modelSets: [],
    promptResult: "end_turn",
    updatesToEmit: [],
    waitForExitResult: true,
  };
}

function tempDb(projectId = "p1"): { dbPath: string; root: string } {
  const root = mkdtempSync(path.join(tmpdir(), "lane-runtime-"));
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
  const updates: unknown[] = [];
  const transport = createCockpitLaneTransport({
    agent: "claude",
    cwd: "C:/repo",
    repoRoot: "C:/repo",
    onSessionUpdate: (u) => updates.push(u),
    openConnection: async () => {
      const next = conns[opened];
      if (next === undefined) throw new Error("no more fake connections");
      opened += 1;
      return next.conn;
    },
  });
  return { transport, updates, openedCount: () => opened };
}

it("start(undefined) creates once; a live held session answers the NEXT start with resumed and ZERO new connections", async () => {
  const a = fakeConnection("s-1");
  const h = harness([a]);
  const created = await h.transport.start(undefined);
  expect(created).toEqual({
    outcome: "created",
    sessionId: "s-1",
    modeApplied: DEFAULT_MODE_APPLIED,
  });
  // The FAST reuse path (already held and alive, same session) never re-applies — B1/B2's own
  // "nothing changed since this connection last opened" contract — so modeApplied is ABSENT here,
  // unlike the create/resume cases below.
  const again = await h.transport.start("s-1");
  expect(again).toEqual({ outcome: "resumed", sessionId: "s-1" });
  expect(h.openedCount()).toBe(1); // THE no-per-turn-respawn invariant
  expect(a.state.resumes).toEqual([]); // a live session needs no ACP resume call
  expect(a.state.modeSets).toEqual([{ sessionId: "s-1", modeId: "default" }]); // applied ONCE, at create
});

it("a DEAD held session is not reused: start(id) opens ONE fresh connection and resumes by id — the TRUE resume also applies", async () => {
  const a = fakeConnection("s-1");
  const b = fakeConnection("s-ignored");
  const h = harness([a, b]);
  await h.transport.start(undefined);
  a.state.alive = false; // bridge died (F-4/F-10)
  const resumed = await h.transport.start("s-1");
  expect(resumed).toEqual({
    outcome: "resumed",
    sessionId: "s-1",
    modeApplied: DEFAULT_MODE_APPLIED,
  });
  expect(h.openedCount()).toBe(2);
  expect(b.state.resumes).toEqual(["s-1"]);
  expect(b.state.modeSets).toEqual([{ sessionId: "s-1", modeId: "default" }]);
});

it("resume failure closes the fresh connection and reports resumeFailed with the reason", async () => {
  const a = fakeConnection();
  a.state.resumeError = new Error("session expired upstream");
  const h = harness([a]);
  const result = await h.transport.start("s-old");
  expect(result).toMatchObject({ outcome: "resumeFailed" });
  if (result.outcome === "resumeFailed") {
    expect(result.reason).toContain("session expired upstream");
  }
  expect(a.state.killed).toBe(1); // the failed connection is not leaked
});

it("send rides the HELD connection; raw updates reach the injected tap; end_turn → accepted", async () => {
  const a = fakeConnection("s-1");
  a.state.updatesToEmit = [{ sessionUpdate: "usage_update", pct: 55 }];
  const h = harness([a]);
  await h.transport.start(undefined);
  const sent = await h.transport.send("PROMPT BYTES", "s-1");
  expect(sent).toEqual({ outcome: "accepted" });
  expect(a.state.prompts).toEqual([{ sessionId: "s-1", text: "PROMPT BYTES" }]);
  expect(h.updates).toEqual([{ sessionUpdate: "usage_update", pct: 55 }]);
});

it("a non-end_turn stop and a thrown prompt both report failed/transport (no fabricated auth/quota claims)", async () => {
  const a = fakeConnection("s-1");
  a.state.promptResult = "refusal";
  const h = harness([a]);
  await h.transport.start(undefined);
  expect(await h.transport.send("x", "s-1")).toMatchObject({
    outcome: "failed",
    reason: "transport",
  });

  const b = fakeConnection("s-2");
  b.state.promptError = new Error("bridge pipe broke");
  const h2 = harness([b]);
  await h2.transport.start(undefined);
  const failed = await h2.transport.send("y", "s-2");
  expect(failed).toMatchObject({ outcome: "failed", reason: "transport" });
  if (failed.outcome === "failed") {
    expect(failed.message).toContain("bridge pipe broke");
  }
});

it("send without a live held session fails closed as transport (never a silent respawn)", async () => {
  const h = harness([]);
  const result = await h.transport.send("x", "s-none");
  expect(result).toMatchObject({ outcome: "failed", reason: "transport" });
});

// W4-1: CockpitLaneTransport.setMode — the LOCAL UI-STATE cycle's ONE reach into a live connection.
it("setMode with no held session reports noSession (the ordinary pre-first-turn state, not an error)", async () => {
  const h = harness([]);
  expect(await h.transport.setMode("plan")).toEqual({ outcome: "noSession" });
});

it("setMode with a live held session calls the connection with its OWN sessionId", async () => {
  const a = fakeConnection("s-1");
  const h = harness([a]);
  await h.transport.start(undefined); // the automatic apply-on-create already sets "default" once
  expect(await h.transport.setMode("plan")).toEqual({ outcome: "applied" });
  expect(a.state.modeSets).toEqual([
    { sessionId: "s-1", modeId: "default" },
    { sessionId: "s-1", modeId: "plan" },
  ]);
});

it("lists and applies only models advertised by the held native session", async () => {
  const a = fakeConnection("s-1");
  const h = harness([a]);
  await h.transport.start(undefined);
  expect(h.transport.models()).toEqual({
    currentModelId: "sonnet",
    models: [
      { modelId: "sonnet", name: "Sonnet" },
      { modelId: "opus", name: "Opus" },
    ],
  });
  await expect(h.transport.setModel("opus")).resolves.toEqual({ outcome: "applied" });
  expect(a.state.modelSets).toEqual([{ sessionId: "s-1", modelId: "opus" }]);
  expect(h.transport.models()?.currentModelId).toBe("opus");
  await expect(h.transport.setModel("invented")).resolves.toMatchObject({ outcome: "failed" });
  expect(a.state.modelSets).toHaveLength(1);
});

it("setMode reports failed/reason on a bridge rejection — never silently 'applied'", async () => {
  const a = fakeConnection("s-1");
  a.state.modeError = new Error("session/set_mode: unknown mode id");
  const h = harness([a]);
  await h.transport.start(undefined);
  const result = await h.transport.setMode("bogus");
  expect(result).toMatchObject({ outcome: "failed" });
  if (result.outcome === "failed") {
    expect(result.reason).toContain("unknown mode id");
  }
});

it("setMode against a DEAD held session reports noSession, not a stale-connection failure", async () => {
  const a = fakeConnection("s-1");
  const h = harness([a]);
  await h.transport.start(undefined);
  a.state.alive = false;
  expect(await h.transport.setMode("plan")).toEqual({ outcome: "noSession" });
});

it("retro BLOCK-6: replacing a LIVE hold closes the old child (fresh fallback path) and surfaces a stubborn orphan via the hook", async () => {
  const a = fakeConnection("s-old");
  const b = fakeConnection("s-new");
  const orphans: number[] = [];
  let opened = 0;
  const conns = [a, b];
  const transport = createCockpitLaneTransport({
    agent: "claude",
    cwd: "C:/repo",
    repoRoot: "C:/repo",
    onCloseOrphan: (pid) => orphans.push(pid),
    openConnection: async () => {
      const next = conns[opened];
      if (next === undefined) throw new Error("no more fake connections");
      opened += 1;
      return next.conn;
    },
  });
  await transport.start(undefined); // hold s-old, ALIVE
  a.state.waitForExitResult = false; // and it will refuse to die (stubborn tree)
  const keepAlive = a.conn.close.bind(a.conn);
  a.conn.close = () => {
    keepAlive();
    a.state.alive = true; // survives even the ladder
  };
  const fresh = await transport.start(undefined); // fallback replaces the LIVE hold
  expect(fresh).toEqual({
    outcome: "created",
    sessionId: "s-new",
    modeApplied: DEFAULT_MODE_APPLIED,
  });
  expect(a.state.killed).toBe(1); // the old live child was NOT silently abandoned
  expect(orphans).toEqual([4242]); // and its survival is surfaced, never swallowed (I-13)
});

it("close runs the ladder (clean exit → closed) and a later start(undefined) reopens a NEW connection", async () => {
  const a = fakeConnection("s-1");
  const b = fakeConnection("s-2");
  const h = harness([a, b]);
  await h.transport.start(undefined);
  expect(await h.transport.close?.()).toEqual({ outcome: "closed" });
  expect(a.state.killed).toBe(1);
  const reopened = await h.transport.start(undefined);
  expect(reopened).toEqual({
    outcome: "created",
    sessionId: "s-2",
    modeApplied: DEFAULT_MODE_APPLIED,
  });
  expect(h.openedCount()).toBe(2);
});

it("a stubborn child surfaces the orphan pid as data after the tree-kill escalation", async () => {
  const a = fakeConnection("s-1");
  const h = harness([a]);
  await h.transport.start(undefined);
  a.state.waitForExitResult = false; // never exits
  const kept = () => {
    a.state.alive = true; // survives even the tree-kill
  };
  a.conn.close = () => {
    a.state.killed += 1;
    kept();
  };
  const closed = await h.transport.close?.();
  expect(closed).toEqual({ outcome: "orphan", pid: 4242 });
  expect(a.state.treeKilled).toBe(1);
});

it("carrier runtime opens one lane DB and reuses one held transport per ACP agent", async () => {
  const { dbPath } = tempDb();
  const a = fakeConnection("s-1");
  let opens = 0;
  initCarrierRuntime({
    projectId: "p1",
    dbPath,
    repoRoot: "C:/repo",
    cwd: "C:/repo",
    openConnection: async (input) => {
      opens += 1;
      input.onText?.("hello");
      return a.conn;
    },
  });

  const first = getOrCreateLaneTransport("claude", { onText: () => undefined });
  const second = getOrCreateLaneTransport("claude", { onText: () => undefined });
  await first.start(undefined);

  expect(carrierRuntime()?.projectId).toBe("p1");
  expect(first).toBe(second);
  expect(opens).toBe(1);
});

// B1/B2 (MAX review fix round 1): the REAL mechanism, not just the fake-repoRoot "default" path
// above — a genuinely persisted non-default choice (native-mode-store.ts's own persistNativeMode,
// the SAME writer use-native-mode-handlers.ts's Shift+Tab cycle calls) is read back and applied to
// a freshly created session, closing the exact gap the MAX review named: "a mode restored across a
// kill+relaunch showed ACTIVE while no live session had ever received session/set_mode."
it("start(undefined) reads a REAL persisted non-default mode from disk and applies it automatically, before any Shift+Tab this process", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "lane-mode-restore-"));
  tempRoots.push(root);
  persistNativeMode(root, {
    ...initialNativeModeState(),
    claude: { modeId: "bypassPermissions", status: "active" },
  });
  const a = fakeConnection("s-1");
  const transport = createCockpitLaneTransport({
    agent: "claude",
    cwd: root,
    repoRoot: root,
    openConnection: async () => a.conn,
  });

  const created = await transport.start(undefined);

  expect(created).toEqual({
    outcome: "created",
    sessionId: "s-1",
    modeApplied: { outcome: "applied", modeId: "bypassPermissions", origin: "confirmed" },
  });
  expect(a.state.modeSets).toEqual([{ sessionId: "s-1", modeId: "bypassPermissions" }]);
});

// FAILURE CONTRACT (B1/B2): the automatic apply is best-effort — a bridge rejection during
// start()'s OWN setMode call must never block the session from opening (the operator still gets a
// working lane; only the mode confirmation is honest about having failed).
it("a setMode REJECTION during the automatic apply reports modeApplied:failed but still returns the session ready", async () => {
  const a = fakeConnection("s-1");
  a.state.modeError = new Error("session/set_mode: unknown mode id");
  const h = harness([a]);

  const created = await h.transport.start(undefined);

  expect(created).toEqual({
    outcome: "created",
    sessionId: "s-1",
    modeApplied: {
      outcome: "failed",
      modeId: "default",
      reason: expect.stringContaining("unknown mode id"),
    },
  });
  // The session is genuinely usable despite the mode-apply failure — never blocked.
  expect(await h.transport.send("x", "s-1")).toEqual({ outcome: "accepted" });
});

it("setLaneMode with no runtime initialized reports noSession (never throws into the keymap)", async () => {
  resetCarrierRuntime();
  expect(await setLaneMode("claude", "plan")).toEqual({ outcome: "noSession" });
});

it("setLaneMode with a runtime but no transport ever created for that agent reports noSession", async () => {
  const { dbPath } = tempDb();
  initCarrierRuntime({ projectId: "p1", dbPath, repoRoot: "C:/repo", cwd: "C:/repo" });
  // "codex" is never referenced via getOrCreateLaneTransport — no entry exists in the registry yet.
  expect(await setLaneMode("codex", "agent-full-access")).toEqual({ outcome: "noSession" });
});

it("setLaneMode reaches the EXACT held transport an earlier getOrCreateLaneTransport call created", async () => {
  const { dbPath } = tempDb();
  const a = fakeConnection("s-1");
  initCarrierRuntime({
    projectId: "p1",
    dbPath,
    repoRoot: "C:/repo",
    cwd: "C:/repo",
    openConnection: async () => a.conn,
  });
  await getOrCreateLaneTransport("claude").start(undefined); // automatic apply-on-create: "default" once

  expect(await setLaneMode("claude", "acceptEdits")).toEqual({ outcome: "applied" });
  expect(a.state.modeSets).toEqual([
    { sessionId: "s-1", modeId: "default" },
    { sessionId: "s-1", modeId: "acceptEdits" },
  ]);
});

it("closeAllLaneTransports closes every held lane and returns orphan pids for tracing", async () => {
  const { dbPath } = tempDb();
  const a = fakeConnection("s-1");
  a.state.waitForExitResult = false;
  a.conn.close = () => {
    a.state.killed += 1;
    a.state.alive = true;
  };
  initCarrierRuntime({
    projectId: "p1",
    dbPath,
    repoRoot: "C:/repo",
    cwd: "C:/repo",
    openConnection: async () => a.conn,
  });
  await getOrCreateLaneTransport("claude").start(undefined);

  await expect(closeAllLaneTransports()).resolves.toEqual([4242]);
  expect(a.state.treeKilled).toBe(1);
});

it("transport close absorbs ACP connection-closed shutdown rejection without unhandledRejection", async () => {
  const { dbPath } = tempDb();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const a = fakeConnection("s-1");
    initCarrierRuntime({
      projectId: "p1",
      dbPath,
      repoRoot: "C:/repo",
      cwd: "C:/repo",
      openConnection: async () => a.conn,
    });
    await getOrCreateLaneTransport("claude").start(undefined);
    await closeAllLaneTransports();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  expect(unhandled).toEqual([]);
});
