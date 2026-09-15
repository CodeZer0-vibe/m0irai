/**
 * @file src/adapters/codex.test.ts
 * @purpose Tests Codex CLI adapter subprocess behavior.
 * @exports (none)
 * @depends vitest, ./codex
 */
import { afterEach, expect, it, vi } from "vitest";
import { BUILD_GRANT, CHAT_GRANT } from "../shared/agent-grant.js";
import type { Logger } from "../shared/logger.js";
import type { AgentInput } from "./types.js";

afterEach(() => {
  process.env.OPENAI_API_KEY = undefined;
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("execa");
});

it("dispatches codex with workspace-write sandbox in build mode", async () => {
  process.env.OPENAI_API_KEY = "test-openai-key";
  const execa = mockExecaSuccess('{"stdout":"codex done","verdict":"PASS","cost":2}');
  const { dispatchCodex } = await import("./codex.js");
  const signal = new AbortController().signal;

  const result = await dispatchCodex({ ...input(signal), grant: BUILD_GRANT });

  expect(result).toMatchObject({ exitCode: 0, stdout: "codex done" });
  expect(execa).toHaveBeenCalledWith(
    "codex",
    ["exec", "--sandbox", "workspace-write"],
    expect.objectContaining({
      cancelSignal: signal,
      cwd: "C:/worktree",
      inputFile: "context.md",
      env: expect.not.objectContaining({ OPENAI_API_KEY: expect.anything() }),
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

it("runs workspace-write for a chat mode (full tools); read-only only for the undefined review path", async () => {
  process.env.OPENAI_API_KEY = "test-openai-key";
  const execa = mockExecaSuccess('{"stdout":"codex done","verdict":"PASS"}');
  const { dispatchCodex } = await import("./codex.js");
  const signal = new AbortController().signal;

  await dispatchCodex({ ...input(signal), grant: CHAT_GRANT });
  expect(execa).toHaveBeenLastCalledWith(
    "codex",
    ["exec", "--sandbox", "workspace-write"],
    expect.objectContaining({ cwd: "C:/worktree", inputFile: "context.md" }),
  );

  await dispatchCodex(input(signal)); // no grant → the review/default path stays read-only
  expect(execa).toHaveBeenLastCalledWith(
    "codex",
    ["exec", "--sandbox", "read-only"],
    expect.objectContaining({ cwd: "C:/worktree", inputFile: "context.md" }),
  );
});

it("surfaces a timeout DISTINCTLY (not a generic exit-1 with only the banner)", async () => {
  mockExecaTimeout("OpenAI Codex v0.135.0\nreasoning effort: xhigh\nreasoning summary");
  const { dispatchCodex } = await import("./codex.js");

  // The diagnosed bug: codex xhigh ran past the limit; the old path reported a cryptic exit-1. Now it reads
  // as a timeout with the duration, so the operator knows to scope smaller / lower reasoning effort.
  await expect(dispatchCodex(input(new AbortController().signal))).rejects.toThrow(
    /TIMED OUT after 60 min/,
  );
});

it("carries the REAL error past codex's ~240-char startup banner (wide stderr preview)", async () => {
  const banner = "OpenAI Codex v0.135.0 reasoning effort: xhigh ".padEnd(260, ".");
  mockExecaFailure(1, `${banner}\nREAL_ERROR: model stream closed`);
  const { dispatchCodex } = await import("./codex.js");

  // The old 240-char preview truncated at the banner and hid every real failure reason. The wide preview
  // must now reach the actual error (~char 280).
  await expect(dispatchCodex(input(new AbortController().signal))).rejects.toThrow(
    /REAL_ERROR: model stream closed/,
  );
});

it("requires structured output when strict parsing is enabled", async () => {
  const { dispatchCodex } = await import("./codex.js");

  expect(() => dispatchCodex.parseOutput("plain stdout", true)).toThrow(
    "Codex CLI emitted non-JSON output",
  );
});

it("throws on malformed JSON only when strict parsing is required", async () => {
  const { dispatchCodex } = await import("./codex.js");

  expect(() => dispatchCodex.parseOutput("{ not valid json }", true)).toThrow(
    "Codex CLI emitted malformed JSON output",
  );
});

it("treats a non-JSON brace substring as plain-text stdout in chat mode (no throw)", async () => {
  const { dispatchCodex } = await import("./codex.js");

  // BUG 1 regression: codex exec text output often contains a `{...}` snippet that is NOT valid
  // JSON. Chat dispatch (requireStructured=false) must return it as plain text, not crash.
  const raw = "Codex says hello { this is commentary, not json } done";
  const result = dispatchCodex.parseOutput(raw);

  expect(result).toEqual({ exitCode: 0, stdout: raw });
});

it("parses fenced JSON output into verdict and cost metadata", async () => {
  const { dispatchCodex } = await import("./codex.js");

  const result = dispatchCodex.parseOutput(
    'analysis\n```json\n{"verdict":"PASS","cost":0.75}\n```',
  );

  expect(result).toEqual({
    exitCode: 0,
    stdout: 'analysis\n```json\n{"verdict":"PASS","cost":0.75}\n```',
    structured: { cost: 0.75, verdict: "PASS" },
  });
});

it("reports healthy codex version with caller cancellation signal", async () => {
  const execa = mockExecaSuccess("codex 0.128.0\n");
  const { dispatchCodex } = await import("./codex.js");
  const signal = new AbortController().signal;

  const health = await dispatchCodex.healthCheck(signal);

  expect(health).toEqual({ healthy: true, version: "codex 0.128.0" });
  expect(execa).toHaveBeenCalledWith(
    "codex",
    ["--version"],
    expect.objectContaining({
      cancelSignal: signal,
      maxBuffer: 16_000_000,
      shell: false,
      timeout: 10_000,
    }),
  );
});

it("returns unhealthy codex status without throwing on health failures", async () => {
  mockExecaFailure(1, "codex missing");
  const { dispatchCodex } = await import("./codex.js");

  const health = await dispatchCodex.healthCheck(new AbortController().signal);

  expect(health).toEqual({
    error: "Codex CLI health check failed: codex missing",
    healthy: false,
  });
});

it("appends -c model (+ reasoning_effort when the id carries an effort suffix)", async () => {
  // Co-import so codex.js + the store share one instance (afterEach resetModules gives a fresh store).
  const store = await import("./agent-model-store.js");
  const { dispatchCodex } = await import("./codex.js");
  const sig = new AbortController().signal;
  const args = (): readonly string[] =>
    dispatchCodex.buildCommand({ ...input(sig), grant: CHAT_GRANT }).args;

  expect(args()).not.toContain("model=gpt-5.5");
  store.setAgentModel("codex", "gpt-5.5[high]");
  const a = args();
  expect(a).toContain("model=gpt-5.5");
  expect(a).toContain("model_reasoning_effort=high");

  store.setAgentModel("codex", "o3"); // no effort suffix → just the model override
  const b = args();
  expect(b).toContain("model=o3");
  expect(b.some((arg) => arg.startsWith("model_reasoning_effort="))).toBe(false);
  store.setAgentModel("codex", undefined);
});

function input(signal: AbortSignal): AgentInput {
  return {
    agent: "codex",
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

function mockExecaTimeout(stderr: string): ReturnType<typeof vi.fn> {
  const execa = vi.fn<(...args: unknown[]) => Promise<never>>(() =>
    Promise.reject({ stderr, timedOut: true }),
  );
  vi.doMock("execa", () => ({ ExecaError: Error, execa }));
  return execa;
}
