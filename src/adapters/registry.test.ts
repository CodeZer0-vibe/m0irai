/**
 * @file src/adapters/registry.test.ts
 * @purpose Tests adapter registry resolution.
 * @exports (none)
 * @depends vitest, ./registry
 */
import { afterEach, expect, it, vi } from "vitest";
import type { Logger } from "../shared/logger.js";
import type { AgentInput } from "./types.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("execa");
  vi.doUnmock("./agy.js");
});

it("threads build mode through the wrapper into a writable codex sandbox", async () => {
  const { AdapterRegistry, getAdapter } = await import("./registry.js");
  const registry = new AdapterRegistry();

  const adapter = registry.getAdapter("codex");
  const buildCommand = JSON.parse(adapter.buildCommand("context.md", "C:/worktree", "build"));
  const chatCommand = JSON.parse(adapter.buildCommand("context.md", "C:/worktree", "chat"));

  expect(getAdapter("codex").name).toBe("codex");
  expect(adapter.name).toBe("codex");
  expect(buildCommand).toEqual({
    args: ["exec", "--sandbox", "workspace-write"],
    cmd: "codex",
    stdinFile: "context.md",
  });
  // FULL-TOOLS: chat is write-capable too (the agent decides). Only the undefined/review path is read-only.
  expect(chatCommand.args).toEqual(["exec", "--sandbox", "workspace-write"]);
});

it("delegates parse output through the resolved adapter", async () => {
  const { getAdapter } = await import("./registry.js");

  const result = getAdapter("claude").parseOutput('{"stdout":"parsed","status":"ok"}');

  expect(result).toEqual({
    exitCode: 0,
    stdout: "parsed",
    structured: { status: "ok", stdout: "parsed" },
  });
});

it("runs signal-aware health checks through the registry", async () => {
  const execa = mockExecaSuccess("codex 0.128.0\n");
  const { AdapterRegistry } = await import("./registry.js");
  const signal = new AbortController().signal;

  const health = await new AdapterRegistry().healthCheck("codex", signal);

  expect(health).toEqual({ healthy: true, version: "codex 0.128.0" });
  expect(execa).toHaveBeenCalledWith(
    "codex",
    ["--version"],
    expect.objectContaining({
      cancelSignal: signal,
      shell: false,
      timeout: 10_000,
    }),
  );
});

it("fails over after transient dispatch errors (codex → gemini/agy)", async () => {
  const execa = mockTransientAlways(); // codex (execa) always transient-fails
  // gemini now runs on agy (node-pty), not execa — mock the adapter so failover lands deterministically.
  vi.doMock("./agy.js", () => ({
    dispatchAgy: Object.assign(() => Promise.resolve({ exitCode: 0, stdout: "agy fallback ok" }), {
      buildCommand: () => ({ args: [], cmd: "agy" }),
      healthCheck: () => Promise.resolve({ healthy: true }),
      parseOutput: (raw: string) => ({ exitCode: 0, stdout: raw }),
    }),
  }));
  const { AdapterRegistry } = await import("./registry.js");

  const result = await new AdapterRegistry().dispatchWithFailover(input(), ["codex", "gemini"]);

  expect(result).toMatchObject({ exitCode: 0, stdout: "agy fallback ok" });
  expect(execa.mock.calls[0]?.[0]).toBe("codex"); // codex attempted first (transient), then agy
});

it("claude registry dispatch is RETIRED: rejects loud, never spawns a -p child (W1-T0)", async () => {
  const execa = mockExecaSuccess("never reached");
  const { AdapterRegistry } = await import("./registry.js");

  await expect(new AdapterRegistry().dispatch({ ...input(), agent: "claude" })).rejects.toThrow(
    /RETIRED-2026-06-15/,
  );
  expect(execa).not.toHaveBeenCalled();
});

it("claude buildCommand is RETIRED: the legacy pipeline cannot mint a -p command (W1-T0)", async () => {
  const { getAdapter } = await import("./registry.js");

  expect(() => getAdapter("claude").buildCommand("context.md", "C:/worktree", "chat")).toThrow(
    /RETIRED-2026-06-15/,
  );
});

it("failover INTO claude fails loud instead of silently billing -p (W1-T0)", async () => {
  const execa = mockTransientAlways();
  const { AdapterRegistry } = await import("./registry.js");

  await expect(
    new AdapterRegistry().dispatchWithFailover(input(), ["codex", "claude"]),
  ).rejects.toThrow(/RETIRED-2026-06-15/);
  expect(execa).toHaveBeenCalledTimes(1);
  expect(execa.mock.calls[0]?.[0]).toBe("codex");
});

function input(): AgentInput {
  return {
    agent: "codex",
    contextFile: "context.md",
    logger: testLogger(),
    signal: new AbortController().signal,
    worktreePath: "C:/worktree",
  };
}

function testLogger(): Logger {
  return {
    debug: (): void => undefined,
    error: (): void => undefined,
    info: (): void => undefined,
    warn: (): void => undefined,
  };
}

function mockExecaSuccess(stdout: string): ReturnType<typeof vi.fn> {
  const execa = vi.fn<
    (...args: unknown[]) => Promise<{ exitCode: number; stderr: string; stdout: string }>
  >(() => Promise.resolve({ exitCode: 0, stderr: "", stdout }));
  vi.doMock("execa", () => ({ ExecaError: Error, execa }));
  return execa;
}

function mockTransientAlways(): ReturnType<typeof vi.fn> {
  const execa = vi.fn<(...args: unknown[]) => Promise<never>>(() =>
    Promise.reject({ exitCode: 124, stderr: "timeout" }),
  );
  vi.doMock("execa", () => ({ ExecaError: Error, execa }));
  return execa;
}
