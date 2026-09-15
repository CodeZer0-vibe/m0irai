/**
 * @file src/adapters/claude.test.ts
 * @purpose Tests Claude CLI adapter subprocess behavior.
 * @exports (none)
 * @depends vitest, ./claude
 */
import { afterEach, expect, it, vi } from "vitest";
import { BUILD_GRANT, CHAT_GRANT, RESEARCH_GRANT } from "../shared/agent-grant.js";
import type { Logger } from "../shared/logger.js";
import type { AgentInput } from "./types.js";

afterEach(() => {
  process.env.ANTHROPIC_API_KEY = undefined;
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("execa");
});

it("dispatches claude with array args and shell disabled", async () => {
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  const execa = mockExecaSuccess('{"stdout":"claude done","verdict":"PASS"}');
  const { dispatchClaude } = await import("./claude.js");
  const signal = new AbortController().signal;

  const result = await dispatchClaude(input(signal));

  expect(result).toMatchObject({ exitCode: 0, stdout: "claude done" });
  expect(execa).toHaveBeenCalledWith(
    "claude",
    ["-p", "--output-format", "json", "--effort", "high", "--setting-sources", ""],
    expect.objectContaining({
      cancelSignal: signal,
      cwd: "C:/worktree",
      inputFile: "context.md",
      env: expect.not.objectContaining({ ANTHROPIC_API_KEY: expect.anything() }),
      extendEnv: false,
      maxBuffer: 16_000_000,
      shell: false,
      stderr: "pipe",
      stdin: "pipe",
      stdout: "pipe",
      timeout: 3_600_000,
    }),
  );
});

it("requires structured output when strict parsing is enabled", async () => {
  const { dispatchClaude } = await import("./claude.js");

  expect(() => dispatchClaude.parseOutput("plain stdout", true)).toThrow(
    "Claude CLI emitted non-JSON output",
  );
});

it("throws on malformed JSON only when strict parsing is required", async () => {
  const { dispatchClaude } = await import("./claude.js");

  expect(() => dispatchClaude.parseOutput("{ not valid json }", true)).toThrow(
    "Claude CLI emitted malformed JSON output",
  );
});

it("treats a non-JSON brace substring as plain-text stdout in chat mode (no throw)", async () => {
  const { dispatchClaude } = await import("./claude.js");

  const raw = "Claude says hello { this is commentary, not json } done";
  const result = dispatchClaude.parseOutput(raw);

  expect(result).toEqual({ exitCode: 0, stdout: raw });
});

it("parses fenced JSON output into shared agent result shape", async () => {
  const { dispatchClaude } = await import("./claude.js");

  const result = dispatchClaude.parseOutput('```json\n{"stdout":"ok","cost":1.25}\n```');

  expect(result).toEqual({
    exitCode: 0,
    stdout: "ok",
    structured: { cost: 1.25, stdout: "ok" },
  });
});

it("reports healthy claude version with caller cancellation signal", async () => {
  const execa = mockExecaSuccess("claude 2.0.0\n");
  const { dispatchClaude } = await import("./claude.js");
  const signal = new AbortController().signal;

  const health = await dispatchClaude.healthCheck(signal);

  expect(health).toEqual({ healthy: true, version: "claude 2.0.0" });
  expect(execa).toHaveBeenCalledWith(
    "claude",
    ["--version"],
    expect.objectContaining({
      cancelSignal: signal,
      maxBuffer: 16_000_000,
      shell: false,
      timeout: 10_000,
    }),
  );
});

it("wraps claude dispatch failures in DispatchError", async () => {
  mockExecaFailure(17, "claude failed");
  const { dispatchClaude } = await import("./claude.js");

  await expect(dispatchClaude(input(new AbortController().signal))).rejects.toMatchObject({
    agent: "claude",
    exitCode: 17,
    name: "DispatchError",
    stderr: "claude failed",
  });
});

it("builds chat command headless with setting sources disabled", async () => {
  const { dispatchClaude } = await import("./claude.js");

  const command = dispatchClaude.buildCommand({
    ...input(new AbortController().signal),
    grant: CHAT_GRANT,
  });

  // FULL-AUTO: chat runs claude as its full native self (bypassPermissions = all tools incl Bash, no prompt).
  // `--setting-sources ""` prevents the user-level Stop hook from blocking `claude -p`.
  expect(command.args).toEqual([
    "-p",
    "--no-session-persistence",
    "--output-format",
    "text",
    "--effort",
    "high",
    "--setting-sources",
    "",
    "--permission-mode",
    "bypassPermissions",
  ]);
  expect(command.cmd).toBe("claude");
  expect(command.stdinFile).toBe("context.md");
});

it("builds research command write-capable at max effort", async () => {
  const { dispatchClaude } = await import("./claude.js");

  const command = dispatchClaude.buildCommand({
    ...input(new AbortController().signal),
    grant: RESEARCH_GRANT,
  });

  // FULL-AUTO at MAX effort: research runs claude full native (bypassPermissions, all tools) — agent decides.
  expect(command.args).toEqual([
    "-p",
    "--no-session-persistence",
    "--output-format",
    "text",
    "--effort",
    "max",
    "--setting-sources",
    "",
    "--permission-mode",
    "bypassPermissions",
  ]);
});

it("builds full-auto BUILD command (bypassPermissions, all tools), setting sources disabled", async () => {
  const { dispatchClaude } = await import("./claude.js");

  const command = dispatchClaude.buildCommand({
    ...input(new AbortController().signal),
    grant: BUILD_GRANT,
  });

  // Flags verified against `claude --help`: --permission-mode bypassPermissions (FULL-AUTO: all tools incl
  // Bash, no prompt — the agent decides). --setting-sources "" suppresses the W13 Stop hook hang.
  expect(command.args).toEqual([
    "-p",
    "--no-session-persistence",
    "--output-format",
    "text",
    "--effort",
    "high",
    "--setting-sources",
    "",
    "--permission-mode",
    "bypassPermissions",
  ]);
  expect(command.cmd).toBe("claude");
  expect(command.stdinFile).toBe("context.md");
});

it("appends --model only when the store is set; omits it for the 'default' id", async () => {
  // Co-import so claude.js + the store share one instance (afterEach resetModules gives a fresh store).
  const store = await import("./agent-model-store.js");
  const { dispatchClaude } = await import("./claude.js");
  const sig = new AbortController().signal;
  const args = (): readonly string[] =>
    dispatchClaude.buildCommand({ ...input(sig), grant: CHAT_GRANT }).args;

  expect(args()).not.toContain("--model");
  store.setAgentModel("claude", "default"); // claude's own recommended default → no flag
  expect(args()).not.toContain("--model");

  store.setAgentModel("claude", "claude-opus-4-8[1m]");
  const a = args();
  expect(a[a.indexOf("--model") + 1]).toBe("claude-opus-4-8[1m]");
  store.setAgentModel("claude", undefined);
});

function input(signal: AbortSignal): AgentInput {
  return {
    agent: "claude",
    contextFile: "context.md",
    logger: testLogger(),
    signal,
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

function mockExecaFailure(exitCode: number, stderr: string): ReturnType<typeof vi.fn> {
  const execa = vi.fn<(...args: unknown[]) => Promise<never>>(() =>
    Promise.reject({ exitCode, stderr }),
  );
  vi.doMock("execa", () => ({ ExecaError: Error, execa }));
  return execa;
}
