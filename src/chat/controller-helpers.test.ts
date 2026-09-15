/**
 * @file src/chat/controller-helpers.test.ts
 * @purpose Tests pure controller helpers (path builders, dispatch mapping, sandbox suffix) and streaming print orchestration.
 * @exports (none)
 * @depends vitest, node:path, ./controller-helpers, ./types
 */
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatRoute, DispatchResult } from "./types.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("./ui.js");
});

function dispatchResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    agent: "codex",
    mode: "pipeline",
    exitCode: 0,
    durationMs: 1234,
    output: "hello world",
    ...overrides,
  };
}

function route(overrides: Partial<ChatRoute> = {}): ChatRoute {
  return {
    kind: "agent",
    agents: ["codex"],
    intent: "build",
    dispatchMode: "pipeline",
    codexSandbox: "read-only",
    geminiMode: "review",
    ...overrides,
  };
}

describe("responseFilePath", () => {
  it("builds a zero-padded response markdown path under the run directory", async () => {
    const { responseFilePath } = await import("./controller-helpers.js");

    expect(responseFilePath("/runs/chat-1", 3, "claude")).toBe(
      path.join("/runs/chat-1", "responses", "turn-0003-claude.md"),
    );
  });

  it("does not truncate turn numbers wider than the pad width", async () => {
    const { responseFilePath } = await import("./controller-helpers.js");

    expect(responseFilePath("/runs/chat-1", 12345, "codex")).toBe(
      path.join("/runs/chat-1", "responses", "turn-12345-codex.md"),
    );
  });

  it("includes round in the response path when provided", async () => {
    const { responseFilePath } = await import("./controller-helpers.js");

    expect(responseFilePath("/runs/chat-1", 3, "claude", 2)).toBe(
      path.join("/runs/chat-1", "responses", "turn-0003-r2-claude.md"),
    );
  });
});

describe("stderrFilePath", () => {
  it("builds a zero-padded stderr log path under the run directory", async () => {
    const { stderrFilePath } = await import("./controller-helpers.js");

    expect(stderrFilePath("/runs/chat-1", 7, "gemini")).toBe(
      path.join("/runs/chat-1", "stderr", "turn-0007-gemini.log"),
    );
  });

  it("includes round in the stderr path when provided", async () => {
    const { stderrFilePath } = await import("./controller-helpers.js");

    expect(stderrFilePath("/runs/chat-1", 7, "gemini", 1)).toBe(
      path.join("/runs/chat-1", "stderr", "turn-0007-r1-gemini.log"),
    );
  });
});

describe("sandboxSuffix", () => {
  it("returns workspace-write for codex with a workspace-write route", async () => {
    const { sandboxSuffix } = await import("./controller-helpers.js");

    expect(sandboxSuffix(route({ codexSandbox: "workspace-write" }), "codex")).toBe(
      "workspace-write",
    );
  });

  it("returns undefined for codex with a read-only route", async () => {
    const { sandboxSuffix } = await import("./controller-helpers.js");

    expect(sandboxSuffix(route({ codexSandbox: "read-only" }), "codex")).toBeUndefined();
  });

  it("returns undefined for a non-codex agent regardless of sandbox", async () => {
    const { sandboxSuffix } = await import("./controller-helpers.js");

    expect(sandboxSuffix(route({ codexSandbox: "workspace-write" }), "claude")).toBeUndefined();
  });
});

describe("toCommandDispatch", () => {
  it("maps a successful dispatch result with empty stderr content", async () => {
    const { toCommandDispatch } = await import("./controller-helpers.js");
    const result = dispatchResult({ exitCode: 0, output: "agent output" });

    const mapped = toCommandDispatch("codex", "the prompt", "/runs/out.md", result);

    expect(mapped).toEqual({
      agent: "codex",
      runResult: { agent: "codex", durationMs: 1234, exitCode: 0, outputPath: "/runs/out.md" },
      promptContent: "the prompt",
      outputContent: "agent output",
      stderrContent: "",
    });
  });

  it("treats output as stderr content when the exit code is non-zero", async () => {
    const { toCommandDispatch } = await import("./controller-helpers.js");
    const result = dispatchResult({ exitCode: 2, output: "boom failure trace" });

    const mapped = toCommandDispatch("codex", "p", "/runs/out.md", result);

    expect(mapped.stderrContent).toBe("boom failure trace");
    expect(mapped.outputContent).toBe("boom failure trace");
    expect(mapped.runResult.exitCode).toBe(2);
  });

  it("includes diffStat and filesChanged only when present on the result", async () => {
    const { toCommandDispatch } = await import("./controller-helpers.js");

    const withExtras = toCommandDispatch(
      "codex",
      "p",
      "/o.md",
      dispatchResult({ diffStat: "1 file changed", filesChanged: ["a.ts"] }),
    );
    const withoutExtras = toCommandDispatch("codex", "p", "/o.md", dispatchResult());

    expect(withExtras.diffStat).toBe("1 file changed");
    expect(withExtras.filesChanged).toEqual(["a.ts"]);
    expect("diffStat" in withoutExtras).toBe(false);
    expect("filesChanged" in withoutExtras).toBe(false);
  });
});

interface UiSpyHarness {
  printStreamingResult: typeof import("./controller-helpers.js").printStreamingResult;
  chunk: ReturnType<typeof vi.fn>;
  done: ReturnType<typeof vi.fn>;
  failed: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}

/** Mocks ./ui.js with spies and re-imports controller-helpers to assert print orchestration. */
async function loadWithUiSpies(): Promise<UiSpyHarness> {
  const chunk = vi.fn();
  const done = vi.fn();
  const failed = vi.fn();
  const error = vi.fn();
  vi.doMock("./ui.js", () => ({
    printAgentChunk: chunk,
    printAgentDone: done,
    printAgentFailed: failed,
    printAgentError: error,
  }));
  const mod = await import("./controller-helpers.js");
  return { printStreamingResult: mod.printStreamingResult, chunk, done, failed, error };
}

describe("printStreamingResult", () => {
  it("streams the output chunk, appends a newline, and prints done on success", async () => {
    const { printStreamingResult, chunk, done, failed } = await loadWithUiSpies();

    printStreamingResult("codex", dispatchResult({ output: "result line", exitCode: 0 }), true);

    expect(chunk).toHaveBeenNthCalledWith(1, "codex", "result line");
    expect(chunk).toHaveBeenNthCalledWith(2, "codex", "\n");
    expect(done).toHaveBeenCalledWith("codex", 1234);
    expect(failed).not.toHaveBeenCalled();
  });

  it("does not append an extra newline when output already ends with one", async () => {
    const { printStreamingResult, chunk } = await loadWithUiSpies();

    printStreamingResult("codex", dispatchResult({ output: "ends with newline\n" }), true);

    expect(chunk).toHaveBeenCalledTimes(1);
    expect(chunk).toHaveBeenCalledWith("codex", "ends with newline\n");
  });

  it("prints failure and a trimmed error preview on a non-zero exit", async () => {
    const { printStreamingResult, failed, error } = await loadWithUiSpies();

    printStreamingResult("codex", dispatchResult({ output: "stack trace", exitCode: 1 }), true);

    expect(failed).toHaveBeenCalledWith("codex", 1);
    expect(error).toHaveBeenCalledWith("codex", "stack trace\n");
  });

  it("emits nothing when streaming is disabled", async () => {
    const { printStreamingResult, chunk, done, failed } = await loadWithUiSpies();

    printStreamingResult("codex", dispatchResult({ output: "hidden", exitCode: 0 }), false);

    expect(chunk).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });
});
