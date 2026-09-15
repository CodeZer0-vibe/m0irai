/**
 * @file src/adapters/acp/acp-turn-session.test.ts
 * @purpose Falsifiers for the persistent ACP turn session via an injected connection (no real agent): a prompt
 *   streams chunks through onChunk and returns the full reply + stopReason; a second prompt starts a FRESH
 *   accumulator (no bleed); close() closes the connection; a sessionId-less newSession throws.
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./acp-permission, ./acp-turn-session
 */
import { expect, it } from "vitest";
import { type PermissionDecider, autoApproveDecider } from "./acp-permission.js";
import {
  type TurnSessionDeps,
  acpSessionMetadata,
  openTurnSession,
  usageFromUpdate,
} from "./acp-turn-session.js";

it("isolates Claude query settings without creating a second credential store", () => {
  expect(acpSessionMetadata("claude")).toEqual({
    _meta: { claudeCode: { options: { settingSources: [] } } },
  });
  expect(acpSessionMetadata("codex")).toEqual({});
});

function fakeDeps(opts: { readonly chunks: readonly string[]; readonly stopReason?: string }): {
  deps: TurnSessionDeps;
  closed: () => boolean;
} {
  let closed = false;
  const deps: TurnSessionDeps = {
    openConnection: async (_agent, _cwd, onUpdate) => ({
      initialize: async () => undefined,
      newSession: async () => ({ sessionId: "sess-1" }),
      prompt: async () => {
        for (const chunk of opts.chunks) {
          onUpdate(chunk);
        }
        return opts.stopReason ?? "end_turn";
      },
      setMode: async () => undefined,
      close: () => {
        closed = true;
      },
    }),
  };
  return { closed: () => closed, deps };
}

it("prompt streams chunks via onChunk + returns the full reply + stopReason", async () => {
  const { deps } = fakeDeps({ chunks: ["TUR", "N_OK"] });
  const session = await openTurnSession("claude", "C:/wt", deps);
  const seen: string[] = [];
  const result = await session.prompt("hi", (chunk) => seen.push(chunk));
  expect(result).toEqual({ reply: "TURN_OK", stopReason: "end_turn" });
  expect(seen).toEqual(["TUR", "N_OK"]);
});

it("passes the cwd (the lane worktree) through to the connection — NOT process.cwd", async () => {
  let seenCwd = "";
  const deps: TurnSessionDeps = {
    openConnection: async (_agent, cwd) => {
      seenCwd = cwd;
      return {
        initialize: async () => undefined,
        newSession: async () => ({ sessionId: "s" }),
        prompt: async () => "end_turn",
        setMode: async () => undefined,
        close: () => undefined,
      };
    },
  };
  await openTurnSession("claude", "C:/lane-worktree", deps);
  expect(seenCwd).toBe("C:/lane-worktree");
});

it("a second prompt on the same session starts a FRESH accumulator (no bleed)", async () => {
  const { deps } = fakeDeps({ chunks: ["A"] });
  const session = await openTurnSession("codex", "C:/wt", deps);
  await session.prompt("first");
  const second = await session.prompt("second");
  expect(second.reply).toBe("A"); // NOT "AA" — the prior turn's reply did not bleed in
});

it("close() closes the underlying connection", async () => {
  const { closed, deps } = fakeDeps({ chunks: [] });
  const session = await openTurnSession("claude", "C:/wt", deps);
  session.close();
  expect(closed()).toBe(true);
});

it("CLOSES the connection (no child leak) when newSession returns no sessionId", async () => {
  let closed = false;
  const deps: TurnSessionDeps = {
    openConnection: async () => ({
      initialize: async () => undefined,
      newSession: async () => ({}), // no sessionId → handshake throws
      prompt: async () => "end_turn",
      setMode: async () => undefined,
      close: () => {
        closed = true;
      },
    }),
  };
  await expect(openTurnSession("claude", "C:/wt", deps)).rejects.toThrow("no sessionId");
  expect(closed).toBe(true); // the leak fix — the spawned child is killed on handshake failure
});

it("CLOSES the connection when newSession REJECTS (auth/transport failure after spawn)", async () => {
  let closed = false;
  const deps: TurnSessionDeps = {
    openConnection: async () => ({
      initialize: async () => undefined,
      newSession: async () => {
        throw new Error("auth_required");
      },
      prompt: async () => "end_turn",
      setMode: async () => undefined,
      close: () => {
        closed = true;
      },
    }),
  };
  await expect(openTurnSession("claude", "C:/wt", deps)).rejects.toThrow("auth_required");
  expect(closed).toBe(true);
});

it("CLOSES the connection when the handshake HANGS past the timeout — no child leak (codex P0)", async () => {
  let closed = false;
  const deps: TurnSessionDeps = {
    openConnection: async () => ({
      initialize: async () => undefined,
      newSession: () => new Promise(() => {}), // hangs — never settles (a wedged child)
      prompt: async () => "end_turn",
      setMode: async () => undefined,
      close: () => {
        closed = true;
      },
    }),
  };
  // 4th arg = a short handshake timeout; the hung newSession trips it → conn.close() → the child is reaped.
  await expect(openTurnSession("claude", "C:/wt", deps, 20)).rejects.toThrow("timed out");
  expect(closed).toBe(true);
});

it("threads the permission decider to the connection — default auto-approve, or the injected one", async () => {
  let captured: PermissionDecider | undefined;
  const deps: TurnSessionDeps = {
    openConnection: async (_agent, _cwd, _onUpdate, _onUsage, decide) => {
      captured = decide;
      return {
        initialize: async () => undefined,
        newSession: async () => ({ sessionId: "s" }),
        prompt: async () => "end_turn",
        setMode: async () => undefined,
        close: () => undefined,
      };
    },
  };
  await openTurnSession("claude", "C:/wt", deps);
  expect(captured).toBe(autoApproveDecider); // the default reaches the connection

  const mine: PermissionDecider = async () => ({ kind: "selected", optionId: "x" });
  await openTurnSession("claude", "C:/wt", deps, undefined, mine);
  expect(captured).toBe(mine); // an injected decider is threaded through (the Phase 3 hook)
});

it("usageFromUpdate extracts the adapter's usage_update shape (used/size/cost), else undefined", () => {
  // The EXACT session update @agentclientprotocol/claude-agent-acp emits (acp-agent.js:1081-1096): a
  // result-time usage_update carries used + size + cost. Verified against node_modules, not guessed.
  expect(
    usageFromUpdate({
      sessionUpdate: "usage_update",
      used: 40_000,
      size: 200_000,
      cost: { amount: 0.12, currency: "USD" },
    }),
  ).toEqual({ used: 40_000, size: 200_000, cost: { amount: 0.12, currency: "USD" } });
  // The mid-stream usage_update (acp-agent.js:1282-1289) carries no cost — used/size alone is valid.
  expect(usageFromUpdate({ sessionUpdate: "usage_update", used: 100, size: 200 })).toEqual({
    used: 100,
    size: 200,
  });
  // A text chunk is NOT a usage update (the sibling sessionUpdate the same handler streams).
  expect(
    usageFromUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "hi" } }),
  ).toBeUndefined();
  // Malformed (non-numeric used/size, or absent) → undefined so no bogus ctx% is ever reported.
  expect(
    usageFromUpdate({ sessionUpdate: "usage_update", used: "40000", size: 200_000 }),
  ).toBeUndefined();
  expect(usageFromUpdate({ sessionUpdate: "usage_update", used: 40_000 })).toBeUndefined();
  expect(usageFromUpdate(undefined)).toBeUndefined();
});

it("prompt returns the LATEST usage emitted during the turn (a later usage_update supersedes)", async () => {
  const deps: TurnSessionDeps = {
    openConnection: async (_agent, _cwd, _onUpdate, onUsage) => ({
      initialize: async () => undefined,
      newSession: async () => ({ sessionId: "s" }),
      prompt: async () => {
        onUsage({ used: 10_000, size: 200_000 }); // an earlier mid-stream update
        onUsage({ used: 40_000, size: 200_000 }); // the final result-time update — WINS
        return "end_turn";
      },
      setMode: async () => undefined,
      close: () => undefined,
    }),
  };
  const session = await openTurnSession("claude", "C:/wt", deps);
  const result = await session.prompt("hi");
  expect(result.usage).toEqual({ used: 40_000, size: 200_000 });
});

it("a turn that emits NO usage_update returns no usage (older adapter / a non-usage turn)", async () => {
  const { deps } = fakeDeps({ chunks: ["hi"] });
  const session = await openTurnSession("claude", "C:/wt", deps);
  const result = await session.prompt("hi");
  expect(result.usage).toBeUndefined(); // omitted, never a fabricated zero
});

// W4-1: TurnSession.setMode — the fake-bridge fixture acceptance. (a) is proven by the captured-args
// assertion; the FAILURE CONTRACT (rejection / response-absence timeout) is (b)/(c)'s falsifiers.
it("(a) setMode calls the connection with the EXACT session id and mode id", async () => {
  let captured: { sessionId: string; modeId: string } | undefined;
  const deps: TurnSessionDeps = {
    openConnection: async () => ({
      initialize: async () => undefined,
      newSession: async () => ({ sessionId: "sess-mode" }),
      prompt: async () => "end_turn",
      setMode: async (sessionId, modeId) => {
        captured = { sessionId, modeId };
      },
      close: () => undefined,
    }),
  };
  const session = await openTurnSession("claude", "C:/wt", deps);
  await session.setMode("plan");
  expect(captured).toEqual({ sessionId: "sess-mode", modeId: "plan" });
});

it("requireMode accepts only a mode advertised by this exact ACP session", async () => {
  const modeSets: string[] = [];
  const deps: TurnSessionDeps = {
    openConnection: async () => ({
      initialize: async () => undefined,
      newSession: async () => ({
        sessionId: "sess-safe",
        modes: {
          currentModeId: "agent",
          availableModes: [
            { id: "read-only", name: "Read only" },
            { id: "agent", name: "Agent" },
          ],
        },
      }),
      prompt: async () => "end_turn",
      setMode: async (_sessionId, modeId) => {
        modeSets.push(modeId);
      },
      close: () => undefined,
    }),
  };
  const session = await openTurnSession("codex", "C:/wt", deps);
  await session.requireMode?.("read-only");
  expect(modeSets).toEqual(["read-only"]);
  await expect(session.requireMode?.("agent-full-access")).rejects.toThrow(
    "did not advertise required safe mode",
  );
});

it("requireMode fails closed when the ACP session omits its mode catalog", async () => {
  let modeSet = false;
  const deps: TurnSessionDeps = {
    openConnection: async () => ({
      initialize: async () => undefined,
      newSession: async () => ({ sessionId: "sess-no-modes" }),
      prompt: async () => "end_turn",
      setMode: async () => {
        modeSet = true;
      },
      close: () => undefined,
    }),
  };
  const session = await openTurnSession("claude", "C:/wt", deps);
  await expect(session.requireMode?.("plan")).rejects.toThrow(
    "did not advertise required safe mode",
  );
  expect(modeSet).toBe(false);
});

it("(c) a bridge REJECTION propagates as a rejected promise — the caller reverts + renders the error", async () => {
  const deps: TurnSessionDeps = {
    openConnection: async () => ({
      initialize: async () => undefined,
      newSession: async () => ({ sessionId: "s" }),
      prompt: async () => "end_turn",
      setMode: async () => {
        throw new Error("session/set_mode: unknown mode id");
      },
      close: () => undefined,
    }),
  };
  const session = await openTurnSession("claude", "C:/wt", deps);
  await expect(session.setMode("bogus-mode")).rejects.toThrow("unknown mode id");
});

it("a bridge that IGNORES setMode (never responds) times out rather than hanging forever", async () => {
  const deps: TurnSessionDeps = {
    openConnection: async () => ({
      initialize: async () => undefined,
      newSession: async () => ({ sessionId: "s" }),
      prompt: async () => "end_turn",
      setMode: () => new Promise(() => {}), // never settles — the bridge silently ignored the call
      close: () => undefined,
    }),
  };
  // 4th arg = a short round-trip timeout (mirrors the handshake-hang test above) so this falsifier
  // proves the REAL timeout path without a 60s-real-time wait.
  const session = await openTurnSession("claude", "C:/wt", deps, 20);
  await expect(session.setMode("plan")).rejects.toThrow("timed out");
});
