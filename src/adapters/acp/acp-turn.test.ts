/**
 * @file src/adapters/acp/acp-turn.test.ts
 * @purpose Falsifiers for the ACP turn dispatch via an injected session: end_turn → exitCode 0 + reply→stdout;
 *   a non-end_turn stop → exitCode 1; onChunk is forwarded; the session is ALWAYS closed (even on a throw).
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./acp-turn, ./acp-turn-session
 */
import { expect, it } from "vitest";
import type { PermissionDecider } from "./acp-permission.js";
import type { TurnSession } from "./acp-turn-session.js";
import { dispatchAcpTurn } from "./acp-turn.js";

function fakeSession(result: { reply: string; stopReason: string }): {
  session: TurnSession;
  closed: () => boolean;
} {
  let closed = false;
  return {
    closed: () => closed,
    session: {
      prompt: async (_text, onChunk) => {
        onChunk?.("x");
        return result;
      },
      setMode: async () => undefined,
      requireMode: async () => undefined,
      close: () => {
        closed = true;
      },
    },
  };
}

it("end_turn → exitCode 0, reply → stdout, and the session is closed", async () => {
  const { closed, session } = fakeSession({ reply: "hello", stopReason: "end_turn" });
  const seen: string[] = [];
  const r = await dispatchAcpTurn(
    { agent: "claude", cwd: "C:/wt", onChunk: (c) => seen.push(c), promptText: "hi" },
    async () => session,
  );
  expect(r).toMatchObject({ exitCode: 0, stdout: "hello" });
  expect(seen).toEqual(["x"]); // onChunk forwarded
  expect(closed()).toBe(true);
});

it("applies the required mode before the first prompt and forwards the decider", async () => {
  const order: string[] = [];
  const decide: PermissionDecider = async () => ({ kind: "cancelled" as const });
  const session: TurnSession = {
    requireMode: async (modeId) => {
      order.push(`mode:${modeId}`);
    },
    setMode: async (modeId) => {
      order.push(`plain-mode:${modeId}`);
    },
    prompt: async () => {
      order.push("prompt");
      return { reply: "safe", stopReason: "end_turn" };
    },
    close: () => undefined,
  };
  let openedWith: PermissionDecider | undefined;
  await dispatchAcpTurn(
    {
      agent: "codex",
      cwd: "C:/wt",
      promptText: "inspect",
      decide,
      requiredModeId: "read-only",
    },
    async (_agent, _cwd, permissionDecider) => {
      openedWith = permissionDecider;
      return session;
    },
  );
  expect(openedWith).toBe(decide);
  expect(order).toEqual(["mode:read-only", "prompt"]);
});

it("fails closed and closes before prompting when required mode application rejects", async () => {
  let prompted = false;
  let closed = false;
  const session: TurnSession = {
    requireMode: async () => {
      throw new Error("unknown mode id");
    },
    setMode: async () => {
      throw new Error("plain setMode must not own safe-mode admission");
    },
    prompt: async () => {
      prompted = true;
      return { reply: "unsafe", stopReason: "end_turn" };
    },
    close: () => {
      closed = true;
    },
  };
  await expect(
    dispatchAcpTurn(
      { agent: "claude", cwd: "C:/wt", promptText: "inspect", requiredModeId: "plan" },
      async () => session,
    ),
  ).rejects.toThrow("unknown mode id");
  expect(prompted).toBe(false);
  expect(closed).toBe(true);
});

it("threads the turn's ACP context usage into the AgentResult (used/size → result.usage)", async () => {
  const session: TurnSession = {
    prompt: async () => ({
      reply: "hi",
      stopReason: "end_turn",
      usage: { used: 40_000, size: 200_000 },
    }),
    setMode: async () => undefined,
    requireMode: async () => undefined,
    close: () => undefined,
  };
  const r = await dispatchAcpTurn(
    { agent: "claude", cwd: "C:/wt", promptText: "hi" },
    async () => session,
  );
  expect(r.usage).toEqual({ used: 40_000, size: 200_000 }); // carried out so the chat layer can emit ctx%
});

it("a non-end_turn stop → exitCode 1", async () => {
  const { session } = fakeSession({ reply: "partial", stopReason: "max_tokens" });
  const r = await dispatchAcpTurn(
    { agent: "codex", cwd: "C:/wt", promptText: "hi" },
    async () => session,
  );
  expect(r.exitCode).toBe(1);
});

it("closes the session even when the prompt throws", async () => {
  let closed = false;
  const session: TurnSession = {
    prompt: async () => {
      throw new Error("boom");
    },
    setMode: async () => undefined,
    requireMode: async () => undefined,
    close: () => {
      closed = true;
    },
  };
  await expect(
    dispatchAcpTurn({ agent: "claude", cwd: "C:/wt", promptText: "hi" }, async () => session),
  ).rejects.toThrow("boom");
  expect(closed).toBe(true);
});

it("rejects a HUNG turn via the idle cap (no streamed activity) + closes the child", async () => {
  let closed = false;
  const session: TurnSession = {
    prompt: () => new Promise(() => {}), // hangs — never streams, never resolves
    setMode: async () => undefined,
    requireMode: async () => undefined,
    close: () => {
      closed = true;
    },
  };
  await expect(
    dispatchAcpTurn(
      { agent: "claude", cwd: "C:/wt", idleMs: 20, promptText: "hi" },
      async () => session,
    ),
  ).rejects.toThrow("timed out");
  expect(closed).toBe(true); // the hung child is killed — the lane fails, never wedges
});

it("rejects an IN-FLIGHT turn when the abort signal fires (operator stop) + closes the child", async () => {
  let closed = false;
  const ac = new AbortController();
  const session: TurnSession = {
    prompt: () => new Promise(() => {}), // hangs until aborted
    setMode: async () => undefined,
    requireMode: async () => undefined,
    close: () => {
      closed = true;
    },
  };
  const pending = dispatchAcpTurn(
    { agent: "claude", cwd: "C:/wt", idleMs: 10_000, promptText: "hi", signal: ac.signal },
    async () => session,
  );
  await new Promise((resolve) => setTimeout(resolve, 10)); // let the handshake resolve + the prompt start
  ac.abort();
  await expect(pending).rejects.toThrow("aborted");
  expect(closed).toBe(true);
});

it("streamed activity RE-ARMS the idle cap — a progressing turn is NOT cut", async () => {
  const session: TurnSession = {
    prompt: async (_text, onChunk) => {
      for (let i = 0; i < 5; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        onChunk?.("x"); // a chunk every 10ms keeps the 30ms idle cap from firing
      }
      return { reply: "xxxxx", stopReason: "end_turn" };
    },
    setMode: async () => undefined,
    requireMode: async () => undefined,
    close: () => undefined,
  };
  const r = await dispatchAcpTurn(
    { agent: "claude", cwd: "C:/wt", idleMs: 30, promptText: "hi" },
    async () => session,
  );
  expect(r).toEqual({ exitCode: 0, stdout: "xxxxx" }); // completed — progress kept it alive under the cap
});
