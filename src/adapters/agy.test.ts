/**
 * @file src/adapters/agy.test.ts
 * @size-justified: One adapter fixture covers argv authority, runtime workspace, output, continuity, and probe failure.
 * @purpose Falsifiers for agy's grant boundary and native dispatch: an absent grant forces sandboxed plan
 *   mode in an isolated workspace, explicit grants retain full-agent behavior, unsupported plan mode fails
 *   before spawning, and the remaining runner/output/conversation contracts stay intact.
 * @exports (test suite)
 * @depends vitest, ./types
 */
import { afterEach, expect, it, vi } from "vitest";
import { BUILD_GRANT, CHAT_GRANT, RESEARCH_GRANT } from "../shared/agent-grant.js";
import type { Logger } from "../shared/logger.js";
import type { AgentInput } from "./types.js";

// Same live-captured string as agy-output.test.ts's LIVE_DENIAL_TEXT (2026-07-17, S1 research probe
// against a fresh, ungranted agy install under --print). Duplicated locally — agy-output.test.ts does not
// export test fixtures across suites.
const LIVE_DENIAL_TEXT =
  'jetski: no output produced — a tool required the "write_file" permission that headless mode cannot ' +
  "prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. " +
  "write_file(<target>)). Alternatively, re-run with --dangerously-skip-permissions to auto-approve all tools.";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("./pty/agy-pty-spawn.js");
  vi.doUnmock("./pty/agy-runner.js");
  vi.doUnmock("./agy-mode-probe.js");
  vi.doUnmock("execa");
  vi.doUnmock("./agy-transcript.js");
});

function mockSpawnModule(): void {
  vi.doMock("./pty/agy-pty-spawn.js", () => ({
    agyChildEnv: () => ({}),
    agyExePath: () => "C:/fake/agy/bin/agy.exe",
    spawnAgyPty: vi.fn(),
  }));
}

function mockRunner(result: { stdout: string; exitCode: number }): ReturnType<typeof vi.fn> {
  const runAgyOnce = vi.fn(() => Promise.resolve(result));
  vi.doMock("./pty/agy-runner.js", () => ({ runAgyOnce }));
  return runAgyOnce;
}

function mockAgyModeSupport(supported: boolean): void {
  vi.doMock("./agy-mode-probe.js", () => ({
    cachedAgyModeSupport: () => supported,
    probeAgyModeSupport: async () => supported,
  }));
}

function input(signal: AbortSignal): AgentInput {
  return { agent: "gemini", contextFile: "C:/ctx/context.md", signal, worktreePath: "C:/worktree" };
}

it("falsifier: a Windows cleanup EPERM never replaces an otherwise parsed AGY result", async () => {
  mockSpawnModule();
  const { withBestEffortAgyCleanup } = await import("./agy.js");
  const warn = vi.fn();
  const logger: Logger = { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const parsed = { exitCode: 0, stdout: "provider reply" };
  const result = (() => {
    try {
      return parsed;
    } finally {
      withBestEffortAgyCleanup(() => {
        throw Object.assign(new Error("EPERM scratch"), { code: "EPERM" });
      }, logger);
    }
  })();
  expect(result).toEqual(parsed);
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({ phase: "cleanup" }),
    expect.stringContaining("cleanup failed"),
    expect.objectContaining({ reason: "EPERM scratch" }),
  );
});

it("buildCommand makes an absent grant sandboxed plan-only, never a full-agent lane", async () => {
  mockSpawnModule();
  const { dispatchAgy } = await import("./agy.js");

  const cmd = dispatchAgy.buildCommand(input(new AbortController().signal));

  expect(cmd.cmd).toBe("C:/fake/agy/bin/agy.exe");
  expect(cmd.args).toContain("--print");
  const addDirIdx = cmd.args.indexOf("--add-dir");
  expect(cmd.args[addDirIdx + 1]).toBe("C:/ctx"); // dir of the context file
  const printIdx = cmd.args.indexOf("--print");
  expect(cmd.args[printIdx + 1]).toContain("context.md"); // instruction names the file
  // The absent grant is an authority boundary, not a mode preference: persisted UI state cannot widen it.
  expect(cmd.args).toContain("--sandbox");
  expect(cmd.args).toContain("--mode");
  expect(cmd.args[cmd.args.indexOf("--mode") + 1]).toBe("plan");
  expect(cmd.args).not.toContain("--dangerously-skip-permissions");
  expect(cmd.args).not.toContain("--yolo");
});

it("applies the operator's chosen model via --model only when the store is set", async () => {
  mockSpawnModule();
  // Co-import so agy.js + the store share one module instance (vi.resetModules gives this test a fresh store).
  const store = await import("./agent-model-store.js");
  const { dispatchAgy } = await import("./agy.js");

  expect(dispatchAgy.buildCommand(input(new AbortController().signal)).args).not.toContain(
    "--model",
  );

  store.setAgentModel("gemini", "Gemini 3.5 Flash (Low)");
  const cmd = dispatchAgy.buildCommand(input(new AbortController().signal));
  const i = cmd.args.indexOf("--model");
  expect(i).toBeGreaterThanOrEqual(0);
  expect(cmd.args[i + 1]).toBe("Gemini 3.5 Flash (Low)"); // the exact display name from `agy models`
  store.setAgentModel("gemini", undefined);
});

it("resumes via --conversation <id> when the session dir holds a captured conversation id", async () => {
  mockSpawnModule();
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "agy-conv-test-"));
  writeFileSync(join(dir, ".agy-conversation"), "uuid-abc-123");
  const { dispatchAgy } = await import("./agy.js");

  const cmd = dispatchAgy.buildCommand({
    agent: "gemini",
    contextFile: "C:/ctx/context.md",
    agyConversationDir: dir,
    signal: new AbortController().signal,
    worktreePath: "C:/worktree",
  });

  const i = cmd.args.indexOf("--conversation");
  expect(i).toBeGreaterThanOrEqual(0);
  expect(cmd.args[i + 1]).toBe("uuid-abc-123"); // pins the captured id, NOT --continue's "most recent"
});

it("starts FRESH (no --conversation) on the first agy turn or when continuity is off", async () => {
  mockSpawnModule();
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const emptyDir = mkdtempSync(join(tmpdir(), "agy-conv-empty-")); // session dir, no .agy-conversation yet
  const { dispatchAgy } = await import("./agy.js");

  const firstTurn = dispatchAgy.buildCommand({
    agent: "gemini",
    contextFile: "C:/ctx/context.md",
    agyConversationDir: emptyDir,
    signal: new AbortController().signal,
    worktreePath: "C:/worktree",
  });
  expect(firstTurn.args).not.toContain("--conversation");
  // No dir at all (continuity off) → also fresh, and NEVER agy's "most recent" --continue.
  const noDir = dispatchAgy.buildCommand(input(new AbortController().signal));
  expect(noDir.args).not.toContain("--conversation");
  expect(noDir.args).not.toContain("--continue");
});

it("dispatch wires the ConPTY runner and returns the parsed reply", async () => {
  mockSpawnModule();
  mockAgyModeSupport(true);
  const runner = mockRunner({ exitCode: 0, stdout: "63\n" });
  // runAgy copies the context into an isolated temp workspace, so the file must exist on disk.
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { dirname, join } = await import("node:path");
  const ctx = join(mkdtempSync(join(tmpdir(), "agy-test-")), "context.md");
  const worktree = mkdtempSync(join(tmpdir(), "agy-worktree-"));
  writeFileSync(ctx, "ctx");
  const { dispatchAgy } = await import("./agy.js");

  const result = await dispatchAgy({
    agent: "gemini",
    contextFile: ctx,
    signal: new AbortController().signal,
    worktreePath: worktree,
  });

  expect(result).toMatchObject({ exitCode: 0, stdout: "63" });
  const call = runner.mock.calls[0]?.[0] as { cmd: string; args: string[]; cwd: string };
  expect(call.cmd).toBe("C:/fake/agy/bin/agy.exe");
  expect(call.args).toContain("--sandbox");
  expect(call.args).toContain("--mode");
  expect(call.args[call.args.indexOf("--mode") + 1]).toBe("plan");
  expect(call.args).not.toContain("--dangerously-skip-permissions");
  expect(call.cwd).toBe(call.args[call.args.indexOf("--add-dir") + 1]);
  expect(call.cwd).not.toBe(worktree);
  expect(dirname(call.cwd)).toBe(join(worktree, ".zer0", "agy"));
});

it("falsifier: explicit grants retain workspace authority but launch agy from isolated scratch", async () => {
  mockSpawnModule();
  mockAgyModeSupport(true);
  const runner = mockRunner({ exitCode: 0, stdout: "ok\n" });
  const { dispatchAgy } = await import("./agy.js");
  for (const grant of [CHAT_GRANT, RESEARCH_GRANT]) {
    await dispatchAgy({ ...(await realContextInput(new AbortController().signal)), grant });
  }
  for (const [call] of runner.mock.calls as [{ args: string[]; cwd: string }][]) {
    expect(call.args).toContain("--dangerously-skip-permissions");
    expect(call.args).not.toContain("--sandbox");
    expect(call.cwd).not.toBe("C:/worktree");
    // Chat/research retain their existing isolated authority: both their
    // workspace and launch CWD are scratch, never the operator worktree.
    expect(call.args[call.args.indexOf("--add-dir") + 1]).toBe(call.cwd);
  }
});

it("VESTIGE SWEEP S2: a denial-shaped reply fails the leg instead of returning success", async () => {
  mockSpawnModule();
  mockAgyModeSupport(true);
  // agy's own process exits 0 for this case (live-verified) — the runner mock mirrors that exactly, so the
  // ONLY signal available to the dispatcher is the reply's content, not the process exit code.
  mockRunner({ exitCode: 0, stdout: LIVE_DENIAL_TEXT });
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const ctx = join(mkdtempSync(join(tmpdir(), "agy-test-")), "context.md");
  writeFileSync(ctx, "ctx");
  const { dispatchAgy } = await import("./agy.js");
  const { DispatchError } = await import("../shared/errors.js");

  const call = dispatchAgy({
    agent: "gemini",
    contextFile: ctx,
    signal: new AbortController().signal,
    worktreePath: "C:/worktree",
  });

  await expect(call).rejects.toThrow(DispatchError);
  await expect(call).rejects.toThrow(/auto-denied/);
});

it("a normal reply that never mentions agy's denial boilerplate still succeeds", async () => {
  mockSpawnModule();
  mockAgyModeSupport(true);
  mockRunner({ exitCode: 0, stdout: "I updated src/index.ts to fix the off-by-one bug." });
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const ctx = join(mkdtempSync(join(tmpdir(), "agy-test-")), "context.md");
  writeFileSync(ctx, "ctx");
  const { dispatchAgy } = await import("./agy.js");

  const result = await dispatchAgy({
    agent: "gemini",
    contextFile: ctx,
    signal: new AbortController().signal,
    worktreePath: "C:/worktree",
  });

  expect(result).toMatchObject({
    exitCode: 0,
    stdout: "I updated src/index.ts to fix the off-by-one bug.",
  });
});

it("strips ANSI escapes from the reply", async () => {
  mockSpawnModule();
  const { dispatchAgy } = await import("./agy.js");
  const esc = String.fromCharCode(27);

  const result = dispatchAgy.parseOutput(`${esc}[32m63${esc}[0m\n`);

  expect(result).toEqual({ exitCode: 0, stdout: "63" });
});

it("parses fenced JSON into the shared structured shape", async () => {
  mockSpawnModule();
  const { dispatchAgy } = await import("./agy.js");

  const result = dispatchAgy.parseOutput('```json\n{"stdout":"ok","rating":"GREEN"}\n```');

  expect(result).toEqual({
    exitCode: 0,
    stdout: "ok",
    structured: { rating: "GREEN", stdout: "ok" },
  });
});

it("requires structured output only when strict", async () => {
  mockSpawnModule();
  const { dispatchAgy } = await import("./agy.js");

  expect(() => dispatchAgy.parseOutput("plain answer", true)).toThrow("non-JSON");
  expect(dispatchAgy.parseOutput("plain answer")).toEqual({ exitCode: 0, stdout: "plain answer" });
});

it("treats a non-JSON brace substring as prose in non-strict mode", async () => {
  mockSpawnModule();
  const { dispatchAgy } = await import("./agy.js");
  const raw = "Here { not: valid }";

  expect(dispatchAgy.parseOutput(raw)).toEqual({ exitCode: 0, stdout: raw });
});

it("reports agy version via --version", async () => {
  mockSpawnModule();
  const execa = vi.fn(() => Promise.resolve({ exitCode: 0, stderr: "", stdout: "1.0.8\n" }));
  vi.doMock("execa", () => ({ ExecaError: Error, execa }));
  const { dispatchAgy } = await import("./agy.js");

  const health = await dispatchAgy.healthCheck(new AbortController().signal);

  expect(health).toEqual({ healthy: true, version: "1.0.8" });
});

it("build mode reads the worktree ROOT with NO --sandbox and DOES carry the permission bypass", async () => {
  mockSpawnModule();
  const { dispatchAgy } = await import("./agy.js");

  const cmd = dispatchAgy.buildCommand({
    agent: "gemini",
    grant: BUILD_GRANT,
    contextFile: "C:/worktree/.council/brief.md",
    signal: new AbortController().signal,
    worktreePath: "C:/worktree",
  });

  // BUILD = full agent in the worktree ROOT. --add-dir must be the ROOT (a repo subdir hangs); no
  // temp copy. This addDir shape is build-specific (hang-avoidance, see planAgyRun's doc) — the
  // permission shape below is NOT build-specific anymore (see the cross-lane test further down).
  const addDirIdx = cmd.args.indexOf("--add-dir");
  expect(cmd.args[addDirIdx + 1]).toBe("C:/worktree");
  expect(cmd.args).toContain("--print");
  const printIdx = cmd.args.indexOf("--print");
  expect(cmd.args[printIdx + 1]).toContain("brief.md"); // instruction names the brief
  // The explicit build grant is the only path here that needs the unsandboxed worktree root.
  expect(cmd.args).not.toContain("--sandbox");
  // SAFETY FALSIFIER (VESTIGE SWEEP S1, operator ruling 2026-07-17): write/exec does not depend on the
  // operator's fragile, silently-resettable ~/.gemini/settings.json defaultApprovalMode (the proven
  // root cause of the 2026-07-17 live denial) — this flag is process-scoped and reset-proof.
  expect(cmd.args).toContain("--dangerously-skip-permissions");
  // S-C (FIX WAVE Round A, 2026-07-18 = sweep#3): the flag must precede --print, never follow it. The
  // live probe that would prove agy's own parser still accepts a flag AFTER --print's prompt-text value
  // is blocked this session (S1's own report) — putting the flag FIRST (before any value-consuming
  // flag) needs no such proof: every conventional CLI parser accepts a leading flag correctly.
  expect(cmd.args.indexOf("--dangerously-skip-permissions")).toBeLessThan(
    cmd.args.indexOf("--print"),
  );
});

it("falsifier: build-mode dispatch keeps the worktree add-dir and launches from project runtime scratch", async () => {
  mockSpawnModule();
  mockAgyModeSupport(true);
  const runner = mockRunner({ exitCode: 0, stdout: "BUILT\n" });
  const { dispatchAgy } = await import("./agy.js");

  // Build keeps the explicit worktree add-dir. The launch CWD is separate provider-home scratch,
  // so the context path need not be copied into it.
  const result = await dispatchAgy({
    agent: "gemini",
    grant: BUILD_GRANT,
    contextFile: "C:/worktree/.council/brief.md",
    signal: new AbortController().signal,
    worktreePath: "C:/worktree",
  });

  expect(result).toMatchObject({ exitCode: 0, stdout: "BUILT" });
  const call = runner.mock.calls[0]?.[0] as { args: string[]; cwd: string };
  expect(call.cwd).not.toBe("C:/worktree");
  const { dirname } = await import("node:path");
  expect(dirname(call.cwd)).toBe("C:\\worktree\\.zer0\\agy");
  expect(call.args).not.toContain("--sandbox");
  expect(call.args).toContain("--dangerously-skip-permissions");
  const addDirIdx = call.args.indexOf("--add-dir");
  expect(call.args[addDirIdx + 1]).toBe("C:/worktree"); // the root itself, no temp copy
});

it("SAFETY: only an explicit grant receives the full-agent permission bypass", async () => {
  mockSpawnModule();
  const { dispatchAgy } = await import("./agy.js");
  const base = {
    agent: "gemini" as const,
    contextFile: "C:/wt/ctx.md",
    signal: new AbortController().signal,
    worktreePath: "C:/wt",
  };
  // Byte-exact argv lives in argv-matrix.test.ts. This local smoke only guards the authority split
  // and the permanent --yolo absence while exercising the adapter's public buildCommand surface.
  for (const grant of [undefined, CHAT_GRANT, RESEARCH_GRANT, BUILD_GRANT] as const) {
    const cmd = dispatchAgy.buildCommand(grant === undefined ? base : { ...base, grant });
    if (grant === undefined) {
      expect(cmd.args).toContain("--sandbox");
      expect(cmd.args).toContain("--mode");
      expect(cmd.args).not.toContain("--dangerously-skip-permissions");
    } else {
      expect(cmd.args).not.toContain("--sandbox");
      expect(cmd.args).toContain("--dangerously-skip-permissions");
    }
    expect(cmd.args).not.toContain("--yolo");
  }
});

it("carrier-on writes a freshly captured agy conversation id to lane_sessions", async () => {
  mockSpawnModule();
  mockAgyModeSupport(true);
  mockRunner({ exitCode: 0, stdout: "lane reply\n" });
  vi.doMock("./agy-transcript.js", () => ({
    readAgyCleanReply: () => undefined,
    readAgyConversationId: () => "agy-conv-1",
  }));
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { closeDb, openLaneStateDb } = await import("../evidence/db.js");
  const root = mkdtempSync(join(tmpdir(), "agy-lane-state-"));
  const db = openLaneStateDb(join(root, "evidence.db"));
  db.prepare(
    "INSERT INTO projects(project_id, canonical_root, git_common_dir, created_at) VALUES (?,?,?,?)",
  ).run("p1", "C:/worktree", "C:/worktree/.git", "2026-07-10T00:00:00Z");
  const ctx = join(root, "context.md");
  writeFileSync(ctx, "ctx");
  const { dispatchAgy } = await import("./agy.js");
  const writes: Array<{ sessionId: string }> = [];
  const laneStore = {
    bumpGeneration: (_db: unknown, value: { sessionId: string }) => writes.push(value),
    getLaneSession: () => undefined,
    laneBindingMatches: () => true,
  };

  const result = await dispatchAgy.withLaneState({
    adapterPkg: "agy",
    adapterVersion: "1.0.8",
    cwd: "C:/worktree",
    db,
    input: {
      agent: "gemini",
      contextFile: ctx,
      signal: new AbortController().signal,
      worktreePath: "C:/worktree",
    },
    now: () => "2026-07-10T00:00:01Z",
    projectId: "p1",
    store: laneStore,
  });

  expect(result).toMatchObject({ outcome: "persisted", conversationId: "agy-conv-1" });
  expect(writes).toMatchObject([{ sessionId: "agy-conv-1" }]);
  closeDb(db);
});

it("carrier-on reports captureFailed without throwing when agy emits no conversation id", async () => {
  mockSpawnModule();
  mockAgyModeSupport(true);
  mockRunner({ exitCode: 0, stdout: "lane reply\n" });
  vi.doMock("./agy-transcript.js", () => ({
    readAgyCleanReply: () => undefined,
    readAgyConversationId: () => undefined,
  }));
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { closeDb, openLaneStateDb } = await import("../evidence/db.js");
  const root = mkdtempSync(join(tmpdir(), "agy-lane-fail-"));
  const db = openLaneStateDb(join(root, "evidence.db"));
  db.prepare(
    "INSERT INTO projects(project_id, canonical_root, git_common_dir, created_at) VALUES (?,?,?,?)",
  ).run("p1", "C:/worktree", "C:/worktree/.git", "2026-07-10T00:00:00Z");
  const ctx = join(root, "context.md");
  writeFileSync(ctx, "ctx");
  const { dispatchAgy } = await import("./agy.js");
  const writes: Array<{ sessionId: string }> = [];
  const laneStore = {
    bumpGeneration: (_db: unknown, value: { sessionId: string }) => writes.push(value),
    getLaneSession: () => undefined,
    laneBindingMatches: () => true,
  };

  const result = await dispatchAgy.withLaneState({
    adapterPkg: "agy",
    adapterVersion: "1.0.8",
    cwd: "C:/worktree",
    db,
    input: {
      agent: "gemini",
      contextFile: ctx,
      signal: new AbortController().signal,
      worktreePath: "C:/worktree",
    },
    now: () => "2026-07-10T00:00:01Z",
    projectId: "p1",
    store: laneStore,
  });

  expect(result).toMatchObject({ outcome: "captureFailed", reason: "missingConversationId" });
  expect(result.result).toMatchObject({ exitCode: 0, stdout: "lane reply" });
  expect(writes).toEqual([]);
  closeDb(db);
});

// Real dispatch must await the capability probe. The absent grant requires --mode plan, so an
// unsupported install is an explicit failure before runAgyOnce is invoked.
function mockExecaSupportsMode(supported: boolean): void {
  const helpText = supported
    ? "Usage: agy [options]\n  --mode <accept-edits|plan>\n"
    : "Usage: agy [options]\n";
  vi.doMock("execa", () => ({
    ExecaError: Error,
    execa: vi.fn(() => Promise.resolve({ exitCode: 0, stderr: "", stdout: helpText })),
  }));
}

// runAgy (unlike buildCommand) COPIES the context file into a temp workspace (planAgyRun), so it must
// exist on disk — mirrors "dispatch wires the ConPTY runner and returns the parsed reply" above.
async function realContextInput(signal: AbortSignal): Promise<AgentInput> {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const ctx = join(mkdtempSync(join(tmpdir(), "agy-mode-test-")), "context.md");
  writeFileSync(ctx, "ctx");
  return { agent: "gemini", contextFile: ctx, signal, worktreePath: "C:/worktree" };
}

// B4 (MAX review fix round 1): the --mode ARGV SHAPE cases (accept-edits/plan/default-omits/composes-
// with-skip-permissions) moved to argv-matrix.test.ts — the byte-parity ORACLE is the one place that
// contract may live; a parallel copy here was a FORK, not an extension (the exact finding). This file
// keeps ONLY the ONE case argv-matrix.test.ts's synchronous buildCommand style cannot cover: the REAL
// async probe pipeline (execa → supportsModeFlag → cache) actually gating the flag end-to-end.
it("an ungranted lane fails closed before spawn when agy lacks required --mode support", async () => {
  mockSpawnModule();
  mockExecaSupportsMode(false); // this exact install's --help does not advertise --mode
  const runner = mockRunner({ exitCode: 0, stdout: "ok\n" });
  const { setAgentMode } = await import("./agent-mode-store.js");
  const { dispatchAgy } = await import("./agy.js");
  setAgentMode("gemini", "plan"); // the operator DID cycle to plan — the probe still wins

  await expect(dispatchAgy(await realContextInput(new AbortController().signal))).rejects.toThrow(
    "lacks required --mode support",
  );

  expect(runner).not.toHaveBeenCalled();
});
