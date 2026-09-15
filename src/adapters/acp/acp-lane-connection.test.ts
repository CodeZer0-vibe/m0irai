/**
 * @file src/adapters/acp/acp-lane-connection.test.ts
 * @purpose Behavioral contract for the pure lane-connection wiring (buildLaneConnection over injected
 *   child + SDK-connection fakes): per-prompt emit slot swap (updates route ONLY to the in-flight turn's
 *   emit and never leak after it settles), stopReason passthrough, sessionId extraction + its missing-id
 *   failure, labeled step-timeout on a wedged handshake, and the close-ladder pieces (already-exited
 *   short-circuit, bounded exit wait, kill probe). The LIVE glue (openAcpLaneConnection) is proven by
 *   the native-resume e2e receipts — not re-mocked here. W4-3: resolveDecider's FAIL-CLOSED default
 *   (the referee's named trap). invalidatePendingAsk wiring lives ONE layer up (chat/lane-transport.ts's
 *   sendHeld, dep-check-verified: adapters/ must never import chat/) — tested there, not here.
 * @exports (none — test file)
 * @depends vitest, ./acp-lane-connection, ./acp-permission
 */
import { describe, expect, it } from "vitest";
import {
  type LaneChildLike,
  type LaneWireConnection,
  buildLaneConnection,
  resolveDecider,
} from "./acp-lane-connection.js";
import type { EmitSlot } from "./acp-lane-update-routing.js";
import { type PermissionDecider, autoApproveDecider, denyDecider } from "./acp-permission.js";

interface FakeChildState {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: number;
  exitListeners: (() => void)[];
}

function fakeChild(pid = 4242): { child: LaneChildLike; state: FakeChildState } {
  const state: FakeChildState = { exitCode: null, signalCode: null, killed: 0, exitListeners: [] };
  const child: LaneChildLike = {
    pid,
    get exitCode() {
      return state.exitCode;
    },
    get signalCode() {
      return state.signalCode;
    },
    kill: () => {
      state.killed += 1;
      return true;
    },
    once: (_event, listener) => {
      state.exitListeners.push(listener);
      return undefined;
    },
  };
  return { child, state };
}

function fakeConn(overrides: Partial<LaneWireConnection> = {}): LaneWireConnection {
  return {
    initialize: async () => ({}),
    newSession: async () => ({ sessionId: "s-new" }),
    resumeSession: async () => ({}),
    prompt: async () => ({ stopReason: "end_turn" }),
    setSessionMode: async () => ({}),
    setSessionConfigOption: async () => ({}),
    extMethod: async () => ({}),
    ...overrides,
  };
}

function slot(standing?: (update: unknown) => void): EmitSlot {
  return { current: undefined, standing, liveSessionId: undefined };
}

it("prompt routes raw updates ONLY to the in-flight turn's emit and clears the slot after settling", async () => {
  const { child } = fakeChild();
  const s = slot();
  let emitDuringPrompt: ((update: unknown) => void) | undefined;
  const conn = fakeConn({
    prompt: async () => {
      emitDuringPrompt = s.current;
      emitDuringPrompt?.({ sessionUpdate: "usage_update", pct: 42 });
      return { stopReason: "end_turn" };
    },
  });
  const lane = buildLaneConnection("claude", child, conn, "C:/tmp/p", s);
  const seen: unknown[] = [];
  const stop = await lane.prompt("s-new", "hello", (u) => seen.push(u));
  expect(stop).toBe("end_turn");
  expect(seen).toEqual([{ sessionUpdate: "usage_update", pct: 42 }]);
  // The TURN's emit is still cleared, and that half is unchanged: a later turn's updates must never
  // reach a settled turn's sink. What changed (FL-099 day 2) is that clearing it is no longer the same
  // as DROPPING the update — the session's standing listener is what a late one falls through to.
  expect(s.current).toBeUndefined();
});

it("the slot clears even when the prompt REJECTS (no cross-turn leak after a failed turn)", async () => {
  const { child } = fakeChild();
  const s = slot();
  const conn = fakeConn({
    prompt: async () => {
      throw new Error("adapter died mid-turn");
    },
  });
  const lane = buildLaneConnection("codex", child, conn, "C:/tmp/p", s);
  await expect(lane.prompt("s", "x", () => undefined)).rejects.toThrow("adapter died mid-turn");
  expect(s.current).toBeUndefined();
});

it("newSession extracts the sessionId and REFUSES a response without one", async () => {
  const { child } = fakeChild();
  const lane = buildLaneConnection("claude", child, fakeConn(), "C:/tmp/p", slot());
  expect(await lane.newSession()).toEqual({
    sessionId: "s-new",
    models: { models: [], currentModelId: undefined },
  });
  const bad = buildLaneConnection(
    "claude",
    child,
    fakeConn({ newSession: async () => ({}) }),
    "C:/tmp/p",
    slot(),
  );
  await expect(bad.newSession()).rejects.toThrow("no sessionId");
});

it("Claude create and resume send hook-free session metadata while Codex leaves it absent", async () => {
  const { child } = fakeChild();
  const claudeRequests: unknown[] = [];
  const claude = buildLaneConnection(
    "claude",
    child,
    fakeConn({
      newSession: async (params) => {
        claudeRequests.push(params);
        return { sessionId: "claude-session" };
      },
      resumeSession: async (params) => {
        claudeRequests.push(params);
        return {};
      },
    }),
    "C:/worktree",
    slot(),
  );
  await claude.newSession();
  await claude.resumeSession("claude-session");
  expect(claudeRequests).toEqual([
    {
      cwd: "C:/worktree",
      mcpServers: [],
      _meta: { claudeCode: { options: { settingSources: [] } } },
    },
    {
      cwd: "C:/worktree",
      sessionId: "claude-session",
      _meta: { claudeCode: { options: { settingSources: [] } } },
    },
  ]);

  let codexRequest: unknown;
  const codex = buildLaneConnection(
    "codex",
    child,
    fakeConn({
      newSession: async (params) => {
        codexRequest = params;
        return { sessionId: "codex-session" };
      },
    }),
    "C:/worktree",
    slot(),
  );
  await codex.newSession();
  expect(codexRequest).toEqual({ cwd: "C:/worktree", mcpServers: [] });
});

// B3 (MAX review fix round 1): the bridge's optional `modes.availableModes` list, captured
// alongside the sessionId — the live catalog native-mode.ts's applyCatalog swaps in.
it("newSession extracts availableModeIds when the response advertises modes.availableModes", async () => {
  const { child } = fakeChild();
  const lane = buildLaneConnection(
    "claude",
    child,
    fakeConn({
      newSession: async () => ({
        sessionId: "s-new",
        modes: {
          currentModeId: "default",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "auto", name: "Auto" },
            { id: "not-a-mode" }, // missing id-shaped garbage is filtered, never fatal
            { id: "" }, // blank id dropped
          ],
        },
      }),
    }),
    "C:/tmp/p",
    slot(),
  );
  expect(await lane.newSession()).toEqual({
    sessionId: "s-new",
    models: { models: [], currentModelId: undefined },
    availableModeIds: ["default", "auto", "not-a-mode"],
    currentModeId: "default",
  });
});

it("newSession omits availableModeIds when the response carries no modes field (an older/non-advertising install)", async () => {
  const { child } = fakeChild();
  const lane = buildLaneConnection("claude", child, fakeConn(), "C:/tmp/p", slot());
  const result = await lane.newSession();
  expect(result).toEqual({
    sessionId: "s-new",
    models: { models: [], currentModelId: undefined },
  });
  expect(Object.hasOwn(result, "availableModeIds")).toBe(false);
});

it("resumeSession ALSO extracts availableModeIds — a resumed session's live catalog can differ from create's", async () => {
  const { child } = fakeChild();
  const lane = buildLaneConnection(
    "claude",
    child,
    fakeConn({
      resumeSession: async () => ({
        modes: { currentModeId: "plan", availableModes: [{ id: "plan", name: "Plan" }] },
      }),
    }),
    "C:/tmp/p",
    slot(),
  );
  expect(await lane.resumeSession("s-old")).toEqual({
    models: { models: [], currentModelId: undefined },
    availableModeIds: ["plan"],
    currentModeId: "plan",
  });
});

it("captures live Codex models and selects one through the native ACP extension", async () => {
  const { child } = fakeChild();
  const calls: unknown[] = [];
  const response = {
    sessionId: "s-models",
    models: {
      currentModelId: "gpt-5.6[high]",
      availableModels: [
        { modelId: "gpt-5.6[high]", name: "GPT-5.6 high" },
        { modelId: "gpt-5.6[medium]", name: "GPT-5.6 medium" },
      ],
    },
  };
  const codex = buildLaneConnection(
    "codex",
    child,
    fakeConn({
      newSession: async () => response,
      extMethod: async (method, params) => {
        calls.push({ method, params });
        return {};
      },
    }),
    "C:/tmp/p",
    slot(),
  );
  expect((await codex.newSession()).models).toEqual({
    currentModelId: "gpt-5.6[high]",
    models: [
      { modelId: "gpt-5.6[high]", name: "GPT-5.6 high" },
      { modelId: "gpt-5.6[medium]", name: "GPT-5.6 medium" },
    ],
  });
  await codex.setModel?.("s-models", "gpt-5.6[medium]");

  expect(calls).toEqual([
    {
      method: "session/set_model",
      params: { sessionId: "s-models", modelId: "gpt-5.6[medium]" },
    },
  ]);
});

it("selects a Claude model through its native ACP configuration option", async () => {
  const { child } = fakeChild();
  const calls: unknown[] = [];
  const claude = buildLaneConnection(
    "claude",
    child,
    fakeConn({
      setSessionConfigOption: async (params) => {
        calls.push(params);
        return {};
      },
    }),
    "C:/tmp/p",
    slot(),
  );
  await claude.setModel?.("s-claude", "sonnet");
  expect(calls).toEqual([{ sessionId: "s-claude", configId: "model", value: "sonnet" }]);
});

it("waitForExit short-circuits true for an already-exited child and times out false for a live one", async () => {
  const dead = fakeChild();
  dead.state.exitCode = 0;
  const deadLane = buildLaneConnection("claude", dead.child, fakeConn(), "C:/tmp/p", slot());
  expect(await deadLane.waitForExit(5)).toBe(true);

  const alive = fakeChild();
  const aliveLane = buildLaneConnection("claude", alive.child, fakeConn(), "C:/tmp/p", slot());
  expect(await aliveLane.waitForExit(20)).toBe(false); // bounded — never hangs

  const exiting = fakeChild();
  const exitingLane = buildLaneConnection("claude", exiting.child, fakeConn(), "C:/tmp/p", slot());
  const wait = exitingLane.waitForExit(5_000);
  for (const fire of exiting.state.exitListeners) {
    fire();
  }
  expect(await wait).toBe(true);
});

it("close kills the child once; isAlive and pid reflect the child state", async () => {
  const { child, state } = fakeChild(777);
  const lane = buildLaneConnection("codex", child, fakeConn(), "C:/tmp/p", slot());
  expect(lane.isAlive()).toBe(true);
  expect(lane.pid()).toBe(777);
  lane.close();
  expect(state.killed).toBe(1);
  state.exitCode = 1;
  expect(lane.isAlive()).toBe(false);
});

it("room abort kills the bridge and rejects a stuck handshake without waiting for its timeout", async () => {
  const controller = new AbortController();
  const { child, state } = fakeChild(778);
  const conn = fakeConn({
    initialize: () => new Promise<never>(() => undefined),
  });
  const lane = buildLaneConnection("claude", child, conn, "C:/tmp/p", {
    ...slot(),
    signal: controller.signal,
  });

  const initializing = lane.initialize();
  controller.abort();

  await expect(initializing).rejects.toThrow("ACP lane step aborted: claude initialize");
  expect(state.killed).toBe(1);
});

// W4-1: setMode calls the wire connection's setSessionMode with the EXACT sessionId + modeId, and
// propagates a bridge rejection — the step-timeout (a bridge that never responds) is proven at the
// acp-turn-session.ts layer already (same withTimeout/withStepTimeout shape); this layer's own
// falsifier is the wiring itself, not a second timeout race.
it("setMode calls setSessionMode with the exact sessionId + modeId", async () => {
  const { child } = fakeChild();
  let captured: { sessionId: string; modeId: string } | undefined;
  const conn = fakeConn({
    setSessionMode: async (params) => {
      captured = params;
      return {};
    },
  });
  const lane = buildLaneConnection("claude", child, conn, "C:/tmp/p", slot());
  await lane.setMode("s-mode", "plan");
  expect(captured).toEqual({ sessionId: "s-mode", modeId: "plan" });
});

it("setMode propagates a bridge REJECTION (e.g. an invalid mode id)", async () => {
  const { child } = fakeChild();
  const conn = fakeConn({
    setSessionMode: async () => {
      throw new Error("session/set_mode: unknown mode id");
    },
  });
  const lane = buildLaneConnection("claude", child, conn, "C:/tmp/p", slot());
  await expect(lane.setMode("s", "bogus")).rejects.toThrow("unknown mode id");
});

// W4-3 (MAX review precedent's exact trap, closed): resolveDecider is the ONE place
// openAcpLaneConnection decides which decider createAcpClient receives — this proves an ask-capable
// interactive lane CANNOT reach autoApproveDecider by omission. Exercises resolveDecider directly
// (no spawn needed), unlike buildLaneConnection's own fakes above, which never touch this decision at
// all (createAcpClient is already constructed by the time buildLaneConnection runs) — exactly the gap
// the referee named: a green buildLaneConnection suite proves nothing about which decider was used.
describe("resolveDecider (W4-3): the referee's named trap, closed", () => {
  it("returns the injected operator decider when one is wired in", () => {
    // A bare fake stands in for the real createOperatorPermissionDecider (chat/permission-ask.ts) —
    // this test only proves IDENTITY passthrough (resolveDecider returns exactly what was injected),
    // which needs no real decider; importing one would violate no-upward-deps-adapters (dep-check:
    // adapters/ must never import chat/, enforced on test files too).
    const operatorDecide: PermissionDecider = async () => ({
      kind: "selected",
      optionId: "allow-once",
    });
    expect(resolveDecider({ agent: "claude", cwd: "C:/tmp/p", decide: operatorDecide })).toBe(
      operatorDecide,
    );
  });

  it("FAILS CLOSED (denyDecider) when no decider was wired in — NEVER autoApproveDecider", () => {
    const resolved = resolveDecider({ agent: "claude", cwd: "C:/tmp/p" });
    expect(resolved).toBe(denyDecider);
    expect(resolved).not.toBe(autoApproveDecider);
  });
});
