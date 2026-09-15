/**
 * @file src/chat/dispatch-acp.test.ts
 * @purpose Falsifiers for the ACP dispatch seam: claude/codex read the context file as the prompt + dispatch
 *   the ACP turn (result passed through); gemini throws (no adapter); acpTransportEnabled reflects ZER0_ACP.
 * @exports (test suite — no runtime exports)
 * @depends vitest, ../adapters/types, ./dispatch-acp
 */
import { afterEach, expect, it } from "vitest";
import { denyDecider } from "../adapters/acp/acp-permission.js";
import type { AgentInput } from "../adapters/types.js";
import { type AcpHeadlessDeps, acpTransportEnabled, dispatchAcpHeadless } from "./dispatch-acp.js";

function input(agent: AgentInput["agent"]): AgentInput {
  return {
    agent,
    contextFile: "ctx.md",
    signal: new AbortController().signal,
    worktreePath: "C:/wt",
  };
}

it("reads the context file as the prompt + dispatches the ACP turn (claude)", async () => {
  const calls: Array<{ agent: string; cwd: string; promptText: string }> = [];
  const deps: AcpHeadlessDeps = {
    dispatchAcpTurn: async (i) => {
      calls.push(i);
      return { exitCode: 0, stdout: "reply" };
    },
    readFile: async (path) => `PROMPT(${path})`,
  };
  const result = await dispatchAcpHeadless(input("claude"), undefined, deps);
  expect(result).toMatchObject({ exitCode: 0, stdout: "reply" });
  // the lane worktree (input.worktreePath) is threaded as cwd — NOT process.cwd (codex BLOCK). toMatchObject:
  // the call also carries `signal` (the abort/idle cancellation) which this assertion doesn't pin.
  expect(calls[0]).toMatchObject({ agent: "claude", cwd: "C:/wt", promptText: "PROMPT(ctx.md)" });
  expect(calls[0]).toMatchObject({ decide: denyDecider, requiredModeId: "plan" });
});

it("forces Codex read-only mode and deny permissions for a grantless turn", async () => {
  let captured: Parameters<AcpHeadlessDeps["dispatchAcpTurn"]>[0] | undefined;
  const deps: AcpHeadlessDeps = {
    dispatchAcpTurn: async (turn) => {
      captured = turn;
      return { exitCode: 0, stdout: "safe" };
    },
    readFile: async () => "prompt",
  };
  await dispatchAcpHeadless(input("codex"), undefined, deps);
  expect(captured).toMatchObject({ decide: denyDecider, requiredModeId: "read-only" });
});

it("when onChunk is given, streams the reply per-chunk to the sink (full reply still returned)", async () => {
  const deps: AcpHeadlessDeps = {
    dispatchAcpTurn: async (i) => {
      i.onChunk?.("Hel");
      i.onChunk?.("lo");
      return { exitCode: 0, stdout: "Hello" };
    },
    readFile: async () => "prompt",
  };
  const chunks: string[] = [];
  const result = await dispatchAcpHeadless(input("claude"), (c) => chunks.push(c), deps);
  expect(chunks).toEqual(["Hel", "lo"]); // streamed LIVE per chunk (runOneLane's sink → agent.stdout per chunk)
  expect(result.stdout).toBe("Hello"); // full reply still returned (for the buffered fallback + response file)
});

it("THROWS on a non-success ACP turn (exitCode != 0) so the lane fails, not silently completes", async () => {
  const deps: AcpHeadlessDeps = {
    dispatchAcpTurn: async () => ({ exitCode: 1, stdout: "partial" }), // a max_tokens-style non-end_turn stop
    readFile: async () => "prompt",
  };
  await expect(dispatchAcpHeadless(input("codex"), undefined, deps)).rejects.toThrow(
    "did not end cleanly",
  );
});

it("throws for gemini (no ACP adapter)", async () => {
  const deps: AcpHeadlessDeps = {
    dispatchAcpTurn: async () => ({ exitCode: 0, stdout: "" }),
    readFile: async () => "",
  };
  await expect(dispatchAcpHeadless(input("gemini"), undefined, deps)).rejects.toThrow(
    "claude/codex only",
  );
});

const prev = process.env.ZER0_ACP;
afterEach(() => {
  if (prev === undefined) {
    delete process.env.ZER0_ACP;
  } else {
    process.env.ZER0_ACP = prev;
  }
});

it("acpTransportEnabled is ON by default; ONLY ZER0_ACP=0 opts out", () => {
  delete process.env.ZER0_ACP;
  expect(acpTransportEnabled()).toBe(true); // default ON
  process.env.ZER0_ACP = "0";
  expect(acpTransportEnabled()).toBe(false); // explicit opt-out
  process.env.ZER0_ACP = "1";
  expect(acpTransportEnabled()).toBe(true);
  process.env.ZER0_ACP = "yes";
  expect(acpTransportEnabled()).toBe(true); // anything except "0" stays ON
});
