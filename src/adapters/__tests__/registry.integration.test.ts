/**
 * @file src/adapters/__tests__/registry.integration.test.ts
 * @purpose Tests end-to-end adapter registry wiring.
 * @exports (none)
 * @depends vitest, ../registry
 */
import { afterEach, expect, it, vi } from "vitest";
import { BUILD_GRANT } from "../../shared/agent-grant.js";
import type { Logger } from "../../shared/logger.js";
import type { AgentInput } from "../types.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("execa");
});

it("wires registry resolution through a real adapter dispatch surface", async () => {
  const execa = mockExecaSuccess('{"stdout":"wire ok","verdict":"PASS"}');
  const { AdapterRegistry } = await import("../registry.js");
  const registry = new AdapterRegistry();

  const adapter = registry.getAdapter("codex");
  const result = await registry.dispatch({ ...input(), grant: BUILD_GRANT });

  expect(adapter.name).toBe("codex");
  expect(result).toEqual({
    exitCode: 0,
    stdout: "wire ok",
    structured: { stdout: "wire ok", verdict: "PASS" },
  });
  expect(execa).toHaveBeenCalledWith(
    "codex",
    ["exec", "--sandbox", "workspace-write"],
    expect.objectContaining({ inputFile: "context.md", shell: false }),
  );
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
