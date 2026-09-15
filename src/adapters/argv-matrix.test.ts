/**
 * @file src/adapters/argv-matrix.test.ts
 * @purpose Byte-pins each adapter's buildCommand argv across absent-grant review, chat, research, and build.
 *   Agy review is sandboxed plan mode regardless of persisted UI state; explicit grants retain their
 *   established full-agent vectors. Runtime cwd isolation is proved in agy.test.ts.
 * @exports (test suite)
 * @depends vitest, ./claude, ./codex, ./agy, ./types
 */
import { afterEach, expect, it, vi } from "vitest";
import { BUILD_GRANT, CHAT_GRANT, RESEARCH_GRANT } from "../shared/agent-grant.js";
import type { AgentInput } from "./types.js";

/** The four dispatch states the adapters distinguish. `review` = the absent-grant/read-only path. */
type DispatchState = "review" | "chat" | "research" | "build";
const STATES: readonly DispatchState[] = ["review", "chat", "research", "build"];

// THE MIGRATION SEAM (X0): maps a state label onto the adapter-owned AgentGrant. B1-1a pinned current argv via
// the `chatMode` enum; B1-1b re-pointed this ONE helper at the `grant` seam with the SAME expected argv below,
// and B1-1c retired chatMode entirely — a byte-identical argv across those steps is the proof the lane-class
// retirement changed no behavior. `review` is the ABSENT grant (undefined).
const STATE_GRANT: Readonly<Record<DispatchState, AgentInput["grant"]>> = {
  review: undefined,
  chat: CHAT_GRANT,
  research: RESEARCH_GRANT,
  build: BUILD_GRANT,
};
function stateInput(base: AgentInput, state: DispatchState): AgentInput {
  const grant = STATE_GRANT[state];
  return grant === undefined ? base : { ...base, grant };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("./pty/agy-pty-spawn.js");
});

// ── claude ──────────────────────────────────────────────────────────────────────
const CLAUDE_REVIEW = [
  "-p",
  "--output-format",
  "json",
  "--effort",
  "high",
  "--setting-sources",
  "",
];
function claudeWork(effort: "high" | "max"): readonly string[] {
  return [
    "-p",
    "--no-session-persistence",
    "--output-format",
    "text",
    "--effort",
    effort,
    "--setting-sources",
    "",
    "--permission-mode",
    "bypassPermissions",
  ];
}
const CLAUDE_ARGV: Readonly<Record<DispatchState, readonly string[]>> = {
  review: CLAUDE_REVIEW,
  chat: claudeWork("high"),
  research: claudeWork("max"),
  build: claudeWork("high"),
};

it("claude buildCommand argv is byte-pinned across review/chat/research/build", async () => {
  const { dispatchClaude } = await import("./claude.js");
  const base: AgentInput = {
    agent: "claude",
    contextFile: "context.md",
    signal: new AbortController().signal,
    worktreePath: "C:/worktree",
  };
  for (const state of STATES) {
    const cmd = dispatchClaude.buildCommand(stateInput(base, state));
    expect(cmd.args, `claude ${state}`).toEqual(CLAUDE_ARGV[state]);
    expect(cmd.cmd).toBe("claude");
    expect(cmd.stdinFile).toBe("context.md");
  }
});

// ── codex ───────────────────────────────────────────────────────────────────────
const CODEX_ARGV: Readonly<Record<DispatchState, readonly string[]>> = {
  review: ["exec", "--sandbox", "read-only"],
  chat: ["exec", "--sandbox", "workspace-write"],
  research: ["exec", "--sandbox", "workspace-write", "-c", "web_search=live"],
  build: ["exec", "--sandbox", "workspace-write"],
};

it("codex buildCommand argv is byte-pinned across review/chat/research/build", async () => {
  const { dispatchCodex } = await import("./codex.js");
  const base: AgentInput = {
    agent: "codex",
    contextFile: "context.md",
    signal: new AbortController().signal,
    worktreePath: "C:/worktree",
  };
  for (const state of STATES) {
    const cmd = dispatchCodex.buildCommand(stateInput(base, state));
    expect(cmd.args, `codex ${state}`).toEqual(CODEX_ARGV[state]);
    expect(cmd.cmd).toBe("codex");
    expect(cmd.stdinFile).toBe("context.md");
  }
});

// ── agy (gemini) — the --add-dir SHAPE is the referee BLOCK 1 surface ─────────────
function agyReadInstruction(fileName: string): string {
  return `Read the file ${fileName} in your workspace. It contains your full context and task. Follow its instructions and respond completely. Output only your response.`;
}
// buildCommand represents the non-build isolated workspace as the context directory; the runtime creates a
// unique temp workspace. Absent grant forces sandboxed plan mode; explicit grants retain the full-agent bypass.
const AGY_REVIEW = [
  "--sandbox",
  "--mode",
  "plan",
  "--add-dir",
  "C:/ctx",
  "--print",
  agyReadInstruction("context.md"),
];
const AGY_NONBUILD = [
  "--dangerously-skip-permissions",
  "--add-dir",
  "C:/ctx",
  "--print",
  agyReadInstruction("context.md"),
];
const AGY_BUILD = [
  "--dangerously-skip-permissions",
  "--add-dir",
  "C:/worktree",
  "--print",
  agyReadInstruction("C:/ctx/context.md"),
];
const AGY_ARGV: Readonly<Record<DispatchState, readonly string[]>> = {
  review: AGY_REVIEW,
  chat: AGY_NONBUILD,
  research: AGY_NONBUILD,
  build: AGY_BUILD,
};

it("agy buildCommand argv + --add-dir shape is byte-pinned across review/chat/research/build", async () => {
  vi.doMock("./pty/agy-pty-spawn.js", () => ({
    agyChildEnv: () => ({}),
    agyExePath: () => "C:/fake/agy/bin/agy.exe",
    spawnAgyPty: vi.fn(),
  }));
  const { dispatchAgy } = await import("./agy.js");
  const base: AgentInput = {
    agent: "gemini",
    contextFile: "C:/ctx/context.md",
    signal: new AbortController().signal,
    worktreePath: "C:/worktree",
  };
  for (const state of STATES) {
    const cmd = dispatchAgy.buildCommand(stateInput(base, state));
    expect(cmd.args, `agy ${state}`).toEqual(AGY_ARGV[state]);
    expect(cmd.cmd).toBe("C:/fake/agy/bin/agy.exe");
    expect(cmd.args).not.toContain("--yolo");
  }
});

// ── agy --mode (MAX review fix round 1, BLOCK 4) ──────────────────────────────────
// THE ORACLE for --mode's argv shape — moved here from agy.test.ts, which forked a parallel copy
// instead of extending this file (the exact finding: "the binding argv oracle EXTENDED, never
// forked is false"). Mocks agy-mode-probe.js's cachedAgyModeSupport DIRECTLY (mirrors this file's
// own vi.doMock("./pty/agy-pty-spawn.js") pattern above) rather than running the real async probe —
// that pipeline (execa -> supportsModeFlag -> cache) is its own integration concern, covered by the
// ONE probe-specific test agy.test.ts kept (STARTUP CAPABILITY PROBE).
function mockAgyModeSupport(supported: boolean | undefined): void {
  vi.doMock("./agy-mode-probe.js", () => ({
    cachedAgyModeSupport: () => supported,
    probeAgyModeSupport: async () => supported === true,
    supportsModeFlag: () => supported === true,
  }));
}

async function agyModeBuild(grant: AgentInput["grant"]): Promise<{
  readonly setAgentMode: (agent: "gemini", modeId: string | undefined) => void;
  readonly buildArgs: () => readonly string[];
}> {
  vi.doMock("./pty/agy-pty-spawn.js", () => ({
    agyChildEnv: () => ({}),
    agyExePath: () => "C:/fake/agy/bin/agy.exe",
    spawnAgyPty: vi.fn(),
  }));
  const { setAgentMode } = await import("./agent-mode-store.js");
  const { dispatchAgy } = await import("./agy.js");
  const base: AgentInput = {
    agent: "gemini",
    contextFile: "C:/ctx/context.md",
    signal: new AbortController().signal,
    worktreePath: "C:/worktree",
  };
  return {
    setAgentMode,
    buildArgs: () => dispatchAgy.buildCommand(grant === undefined ? base : { ...base, grant }).args,
  };
}

it("agy buildCommand: --mode appears ONLY when the probe confirms support AND a non-default mode is chosen", async () => {
  mockAgyModeSupport(true);
  const { setAgentMode, buildArgs } = await agyModeBuild(CHAT_GRANT);

  setAgentMode("gemini", "accept-edits");
  const accept = buildArgs();
  expect(accept[accept.indexOf("--mode") + 1]).toBe("accept-edits");

  setAgentMode("gemini", "plan");
  const plan = buildArgs();
  expect(plan[plan.indexOf("--mode") + 1]).toBe("plan");
});

it("agy buildCommand: 'auto' or no chosen mode omits --mode even when the probe confirms support", async () => {
  mockAgyModeSupport(true);
  const { setAgentMode, buildArgs } = await agyModeBuild(CHAT_GRANT);

  setAgentMode("gemini", "auto");
  expect(buildArgs()).not.toContain("--mode");

  setAgentMode("gemini", undefined);
  expect(buildArgs()).not.toContain("--mode");
});

it("agy buildCommand: an UNSUPPORTED probe omits --mode regardless of the chosen mode (never passed to a binary that would reject it)", async () => {
  mockAgyModeSupport(false);
  const { setAgentMode, buildArgs } = await agyModeBuild(CHAT_GRANT);
  setAgentMode("gemini", "plan");
  expect(buildArgs()).not.toContain("--mode");
});

it("agy buildCommand: an UNPROBED cache (undefined — 'not yet known') omits --mode, the same safe default as confirmed-unsupported", async () => {
  mockAgyModeSupport(undefined);
  const { setAgentMode, buildArgs } = await agyModeBuild(CHAT_GRANT);
  setAgentMode("gemini", "plan");
  expect(buildArgs()).not.toContain("--mode");
});

it("agy buildCommand: --mode composes with --dangerously-skip-permissions without interfering — skip-permissions still leads", async () => {
  mockAgyModeSupport(true);
  const { setAgentMode, buildArgs } = await agyModeBuild(CHAT_GRANT);
  setAgentMode("gemini", "accept-edits");
  const args = buildArgs();
  expect(args[0]).toBe("--dangerously-skip-permissions");
  expect(args.indexOf("--mode")).toBeLessThan(args.indexOf("--print"));
});

it("agy buildCommand: absent grant forces sandboxed plan despite a persisted accept-edits mode", async () => {
  mockAgyModeSupport(false);
  const { setAgentMode, buildArgs } = await agyModeBuild(undefined);
  setAgentMode("gemini", "accept-edits");
  expect(buildArgs()).toEqual(AGY_REVIEW);
});
