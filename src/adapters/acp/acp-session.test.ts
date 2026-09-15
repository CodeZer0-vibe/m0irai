/**
 * @file src/adapters/acp/acp-session.test.ts
 * @purpose Falsifiers for the ACP handshake orchestration via injected seams (no real subprocess): it runs
 *   initialize THEN newSession, returns the newSession response, and ALWAYS kills the child — even when a
 *   handshake step rejects.
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./acp-servers, ./acp-session
 */
import { expect, it, vi } from "vitest";
import type { AcpServerSpec } from "./acp-servers.js";
import { type AcpSessionDeps, openAcpNewSession } from "./acp-session.js";

const SPEC: AcpServerSpec = { agent: "codex", entry: "x", env: {} };

function fakeDeps(overrides: {
  readonly newSession?: () => Promise<unknown>;
  readonly initialize?: () => Promise<unknown>;
}): { deps: AcpSessionDeps; kill: ReturnType<typeof vi.fn>; order: string[] } {
  const kill = vi.fn();
  const order: string[] = [];
  const initialize =
    overrides.initialize ??
    (async () => {
      order.push("initialize");
      return { protocolVersion: 1 };
    });
  const newSession =
    overrides.newSession ??
    (async () => {
      order.push("newSession");
      return { models: { availableModels: [] } };
    });
  return {
    deps: {
      connect: () => ({ initialize, newSession }),
      spawnServer: () => ({ kill, stdin: null, stdout: null }),
    },
    kill,
    order,
  };
}

it("runs initialize THEN newSession, returns the session, kills the child", async () => {
  const { deps, kill, order } = fakeDeps({}); // both default seams record their call order
  const result = await openAcpNewSession(SPEC, deps);
  expect(order).toEqual(["initialize", "newSession"]); // initialize strictly before newSession
  expect(result).toEqual({ models: { availableModels: [] } });
  expect(kill).toHaveBeenCalledTimes(1);
});

it("still kills the child when newSession rejects", async () => {
  const { deps, kill } = fakeDeps({
    newSession: async () => {
      throw new Error("auth_required");
    },
  });
  await expect(openAcpNewSession(SPEC, deps)).rejects.toThrow("auth_required");
  expect(kill).toHaveBeenCalledTimes(1);
});
