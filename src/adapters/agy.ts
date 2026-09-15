/**
 * @file src/adapters/agy.ts
 * @exports AgyLaneCaptureResult, AgyLaneStateInput, AgyLaneStateStore, dispatchAgy, withBestEffortAgyCleanup
 * @depends node:fs, node:os, node:path, zod, execa, ./agent-mode-store, ./agy-mode-probe, ./agy-output, ./agy-transcript, ./pty/agy-runner, ./pty/agy-pty-spawn, ./types, ../shared/logger, ../shared/types
 * @size-justified: Native dispatch and durable conversation continuity share one lifecycle and cleanup boundary.
 * @purpose Dispatches Gemini through one-shot agy. An absent AgentGrant is structurally read-only: it
 *   forces sandboxed plan mode, never bypasses permissions, and uses the isolated context workspace for
 *   both agy's add-dir and child cwd. Explicit grants retain their established full-agent argv and cwd;
 *   BUILD runs against the worktree root. Context is passed by absolute file reference, output is parsed,
 *   denial-shaped output fails explicitly, and a captured conversation id is resumed from session state.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ExecaError, execa } from "execa";
import { z } from "zod";
import type { Db } from "../evidence/db.js";
import { DispatchError } from "../shared/errors.js";
import { type Logger, createLogger } from "../shared/logger.js";
import type { AgentHealth, AgentName, AgentResult } from "../shared/types.js";
import { getAgentMode } from "./agent-mode-store.js";
import { getAgentModel } from "./agent-model-store.js";
import { cachedAgyModeSupport, probeAgyModeSupport } from "./agy-mode-probe.js";
import { isAgyPermissionDenial, parseAgyOutput, withExitCode } from "./agy-output.js";
import { readAgyCleanReply, readAgyConversationId } from "./agy-transcript.js";
import { agyChildEnv, agyExePath, spawnAgyPty } from "./pty/agy-pty-spawn.js";
import { runAgyOnce } from "./pty/agy-runner.js";
import { AdapterCommand, AgentGrantSchema, type AgentInput } from "./types.js";

const AGENT_NAME: AgentName = "gemini";
const ADD_DIR_FLAG = "--add-dir";
const PRINT_FLAG = "--print";
// Resume a SPECIFIC agy conversation by id (verified: the captured id resumes across the per-turn workspace
// dir that broke --continue's "most recent"). The id is captured on turn 1 + persisted per session below.
const CONVERSATION_FLAG = "--conversation";
// Applies the operator's chosen model (the native /model picker → agent-model-store) to EVERY gemini turn;
// verified: `--model "Gemini 3.5 Flash (Low)"` accepts the display name. Unset store → omitted → agy default.
const MODEL_FLAG = "--model";
// Persisted operator mode is meaningful only for explicit grants. Absent grants force plan mode
// in buildAgyArgs, regardless of stored UI state or the synchronous capability cache.
const MODE_FLAG = "--mode";
const SANDBOX_FLAG = "--sandbox";
// Only explicit grants may bypass agy's permission prompts. The absent-grant boundary never reaches
// this flag, so an agent hop or review turn cannot acquire full-agent authority from persisted mode state.
const SKIP_PERMISSIONS_FLAG = "--dangerously-skip-permissions";
// zer0-side bookkeeping file (in input.agyConversationDir, the session dir the cockpit passes) holding this
// session's agy conversation id. agy never sees this dir — it's how a later turn resumes the SAME conversation.
// Per-session-unique ⇒ two cockpits never cross (multi-instance isolation).
const CONVERSATION_FILE = ".agy-conversation";
const VERSION_FLAG = "--version";
// 60 min cap (matches the prior gemini adapter) so a long research/review/build turn is not killed mid-run.
const DEFAULT_TIMEOUT_MS = 3_600_000;
const HEALTH_TIMEOUT_MS = 10_000;
const ADAPTER_STDOUT_MAX_BYTES = 16_000_000;

export interface AgyLaneStateStore {
  getLaneSession(
    db: Db,
    projectId: string,
    agent: string,
    laneScopeId?: string,
  ): AgyLaneSessionRow | undefined;
  laneBindingMatches(row: AgyLaneSessionRow, binding: AgyBinding): boolean;
  bumpGeneration(db: Db, input: AgyBumpInput): unknown;
}

export interface AgyLaneStateInput {
  readonly adapterPkg: string;
  readonly adapterVersion: string;
  readonly cwd: string;
  readonly db: Db;
  readonly input: AgentInput;
  readonly now: () => string;
  readonly projectId: string;
  readonly laneScopeId?: string;
  readonly store: AgyLaneStateStore;
}

export type AgyLaneCaptureResult =
  | {
      readonly outcome: "persisted";
      readonly conversationId: string;
      readonly result: AgentResult;
      /** Exact process cwd reported by agy's statusLine payload for this turn. */
      readonly statuslineCwd?: string;
    }
  | {
      readonly outcome: "captureFailed";
      readonly reason: "missingConversationId" | "persistFailed";
      readonly result: AgentResult;
      readonly cause?: unknown;
      readonly statuslineCwd?: string;
    };

type AgyDispatch = {
  (input: AgentInput): Promise<AgentResult>;
  buildCommand(input: AgentInput): AdapterCommand;
  parseOutput(raw: string, requireStructured?: boolean): AgentResult;
  healthCheck(signal: AbortSignal): Promise<AgentHealth>;
  withLaneState(input: AgyLaneStateInput): Promise<AgyLaneCaptureResult>;
};

interface AgyBinding {
  readonly adapterPkg: string;
  readonly adapterVersion: string;
  readonly cwd: string;
}

interface AgyLaneSessionRow extends AgyBinding {
  readonly projectId: string;
  readonly laneScopeId?: string;
  readonly agent: string;
  readonly sessionId: string;
}

interface AgyBumpInput extends AgyBinding {
  readonly projectId: string;
  readonly laneScopeId?: string;
  readonly agent: string;
  readonly sessionId: string;
  readonly now: string;
}

interface AgyTurnRunOptions {
  readonly persistConversationDir?: string;
  readonly priorConversationId?: string;
}

interface AgyTurnRunResult {
  readonly conversationId?: string;
  readonly result: AgentResult;
  readonly statuslineCwd: string;
}

/**
 * The on-disk plan for one agy run. `launchDir` is deliberately separate
 * from `addDir`: Agy resolves transcript paths against its process CWD on
 * Windows, so running it from an operator worktree on another drive can turn
 * `C:\\...` into a malformed relative path. The workspace authority remains
 * explicit in `--add-dir`; the child itself always starts from provider-home
 * scratch space.
 */
interface AgyRunPlan {
  addDir: string;
  contextRef: string;
  launchDir: string;
  cleanup: () => void;
}

const AgentInputSchema = z
  .object({
    agent: z.literal(AGENT_NAME),
    grant: AgentGrantSchema.optional(),
    contextFile: z.string().min(1),
    agyConversationDir: z.string().min(1).optional(),
    logger: z.custom<Logger>(isLogger).optional(),
    signal: z.custom<AbortSignal>(isAbortSignal),
    timeoutMs: z.number().int().positive().optional(),
    worktreePath: z.string().min(1),
  })
  .strict();

/**
 * Dispatches the gemini chair against the compiled context file via the Antigravity CLI.
 *
 * @param input - validated subprocess inputs, including the caller cancellation signal and capability grant
 * @returns parsed agent result with stdout and structured data when present
 * @throws DispatchError when agy caps, aborts, or exits non-zero
 */
export const dispatchAgy: AgyDispatch = Object.assign(runAgy, {
  buildCommand: buildAgyCommand,
  healthCheck: checkAgyHealth,
  parseOutput: parseAgyOutput,
  withLaneState: runAgyWithLaneState,
});

async function runAgy(input: AgentInput): Promise<AgentResult> {
  const parsed = parseInput(input);
  const run = await runAgyParsed(parsed, turnOptions(parsed));
  return run.result;
}

async function runAgyWithLaneState(input: AgyLaneStateInput): Promise<AgyLaneCaptureResult> {
  const parsed = parseInput(input.input);
  const prior = matchingConversationId(input);
  const run = await runAgyParsed(parsed, priorOptions(prior));
  const conversationId = prior ?? run.conversationId;
  if (conversationId === undefined) {
    return {
      outcome: "captureFailed",
      reason: "missingConversationId",
      result: run.result,
      statuslineCwd: run.statuslineCwd,
    };
  }
  if (prior !== undefined) {
    return {
      outcome: "persisted",
      conversationId,
      result: run.result,
      statuslineCwd: run.statuslineCwd,
    };
  }
  return persistCapturedId(input, conversationId, run.result, run.statuslineCwd);
}

async function runAgyParsed(
  parsed: AgentInput,
  options: AgyTurnRunOptions,
): Promise<AgyTurnRunResult> {
  const plan = planAgyRun(parsed);
  const spawnMs = Date.now();
  try {
    const result = await executeAgy(parsed, plan, options.priorConversationId);
    const reply = readAgyCleanReply(plan.contextRef, spawnMs) ?? result.stdout;
    // VESTIGE SWEEP S2 (2026-07-17): agy's headless permission denial exits the PROCESS at 0 (live-verified
    // against a fresh, ungranted install) — classifyExit (agy-runner.ts) only rejects on a non-zero exit, so
    // a denial-shaped reply would otherwise reach the caller looking exactly like a successful turn
    // (F1-adjacent). Content is the only signal here; check it BEFORE the reply is treated as a real result.
    if (isAgyPermissionDenial(reply)) {
      const preview = reply.trim().slice(0, 400);
      (parsed.logger ?? createLogger()).warn(
        { agent: AGENT_NAME, phase: "dispatch" },
        "agy denied a required permission (headless mode cannot prompt)",
        { preview, worktreePath: parsed.worktreePath },
      );
      throw new DispatchError(
        `agy denied a required permission — output: ${preview}`,
        AGENT_NAME,
        1,
      );
    }
    const conversationId = captureConversationId(
      options.persistConversationDir,
      options.priorConversationId,
      plan.contextRef,
      spawnMs,
    );
    const parsedResult = withExitCode(parseAgyOutput(reply), result.exitCode);
    return conversationId === undefined
      ? { result: parsedResult, statuslineCwd: plan.launchDir }
      : { conversationId, result: parsedResult, statuslineCwd: plan.launchDir };
  } finally {
    withBestEffortAgyCleanup(plan.cleanup, parsed.logger ?? createLogger());
  }
}

/** A Windows EPERM during scratch cleanup is diagnostic-only and must never replace a model result. */
export function withBestEffortAgyCleanup(cleanup: () => void, logger: Logger): void {
  try {
    cleanup();
  } catch (error) {
    logger.warn(
      { agent: AGENT_NAME, phase: "cleanup" },
      "agy scratch cleanup failed after lane settlement",
      { reason: error instanceof Error ? error.message : String(error) },
    );
  }
}

function turnOptions(parsed: AgentInput): AgyTurnRunOptions {
  const prior = readStoredConversationId(parsed.agyConversationDir);
  return {
    ...(parsed.agyConversationDir !== undefined
      ? { persistConversationDir: parsed.agyConversationDir }
      : {}),
    ...(prior !== undefined ? { priorConversationId: prior } : {}),
  };
}

function priorOptions(prior: string | undefined): AgyTurnRunOptions {
  return prior === undefined ? {} : { priorConversationId: prior };
}

function matchingConversationId(input: AgyLaneStateInput): string | undefined {
  const row = input.store.getLaneSession(input.db, input.projectId, AGENT_NAME, input.laneScopeId);
  if (row === undefined) {
    return undefined;
  }
  return input.store.laneBindingMatches(row, bindingOf(input)) ? row.sessionId : undefined;
}

function bindingOf(input: AgyLaneStateInput): AgyBinding {
  return { adapterPkg: input.adapterPkg, adapterVersion: input.adapterVersion, cwd: input.cwd };
}

function persistCapturedId(
  input: AgyLaneStateInput,
  conversationId: string,
  result: AgentResult,
  statuslineCwd: string,
): AgyLaneCaptureResult {
  try {
    input.store.bumpGeneration(input.db, {
      ...bindingOf(input),
      agent: AGENT_NAME,
      now: input.now(),
      projectId: input.projectId,
      ...(input.laneScopeId === undefined ? {} : { laneScopeId: input.laneScopeId }),
      sessionId: conversationId,
    });
    return { outcome: "persisted", conversationId, result, statuslineCwd };
  } catch (cause) {
    return { outcome: "captureFailed", reason: "persistFailed", result, cause, statuslineCwd };
  }
}

async function executeAgy(
  parsed: AgentInput,
  plan: AgyRunPlan,
  priorConversationId: string | undefined,
): Promise<{ readonly exitCode: number; readonly stdout: string }> {
  const logger = parsed.logger ?? createLogger();
  const modeSupported = await probeAgyModeSupport();
  if (parsed.grant === undefined && !modeSupported) {
    throw new DispatchError(
      "agy lacks required --mode support for an ungranted read-only lane",
      AGENT_NAME,
      1,
    );
  }
  const args = buildAgyArgs(parsed.grant, plan.addDir, plan.contextRef, priorConversationId);
  const cwd = plan.launchDir;
  logger.info({ agent: AGENT_NAME, phase: "dispatch" }, "agent dispatched", {
    args,
    cmd: agyExePath(),
    cwd,
    mode: parsed.grant === undefined ? "review" : parsed.grant.worktree ? "build" : "chat",
  });
  return runAgyOnce({
    args,
    cmd: agyExePath(),
    cwd,
    signal: parsed.signal,
    spawn: spawnAgyPty,
    timeoutMs: parsed.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
}

/** Reads the agy conversation id this session captured earlier — undefined on the first turn or when
 *  continuity is off (no dir). The dir is the cockpit's per-session state dir, NOT agy's --add-dir. */
function readStoredConversationId(dir: string | undefined): string | undefined {
  if (dir === undefined) {
    return undefined;
  }
  try {
    const id = readFileSync(join(dir, CONVERSATION_FILE), "utf8").trim();
    return id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * On the FIRST agy turn of a session (no prior id) captures the conversation agy just minted (the brain/<id>
 * matching this turn) + persists it, so later turns resume THIS session via --conversation. Best-effort: a
 * missed capture just starts the next turn fresh (never a hang). No-op when continuity is off (no dir) or the
 * id is already known (later turns reuse it; agy appends to the same brain/<id>).
 */
function captureConversationId(
  dir: string | undefined,
  priorId: string | undefined,
  signature: string,
  spawnMs: number,
): string | undefined {
  if (priorId !== undefined) {
    return undefined;
  }
  const captured = readAgyConversationId(signature, spawnMs);
  if (captured === undefined || dir === undefined) {
    return captured;
  }
  try {
    writeFileSync(join(dir, CONVERSATION_FILE), captured, "utf8");
    return captured;
  } catch {
    return undefined;
  }
}

/**
 * Plans one isolated launch workspace. BUILD keeps its explicit worktree authority in `--add-dir`, while
 * every child starts in provider-home scratch. Every other lane also receives a fresh context copy there,
 * so both `--add-dir` and process visibility remain outside the operator worktree.
 *
 * @param parsed - the validated adapter input
 * @returns the add-dir target, brief reference, and cleanup thunk
 */
function planAgyRun(parsed: AgentInput): AgyRunPlan {
  const launchDir = createAgyLaunchDir(parsed.worktreePath);
  if (parsed.grant?.worktree === true) {
    return {
      addDir: parsed.worktreePath,
      contextRef: parsed.contextFile,
      launchDir,
      cleanup: () => rmSync(launchDir, { recursive: true, force: true }),
    };
  }
  const ctxDir = launchDir;
  const ctxPath = join(ctxDir, basename(parsed.contextFile));
  copyFileSync(parsed.contextFile, ctxPath);
  return {
    addDir: ctxDir,
    contextRef: ctxPath,
    launchDir: ctxDir,
    cleanup: () => rmSync(ctxDir, { recursive: true, force: true }),
  };
}

/**
 * Keep transient Gemini state under Zer0's existing project-runtime directory.
 * Real Windows launches proved that both the operator profile and `%TEMP%` can
 * allow directory creation while still rejecting ConPTY startup with EPERM.
 * The project `.zer0` root is already required and writable for the room DB, so
 * it is the only launch root whose effective runtime permissions are proven.
 * Temp and provider-home roots remain bounded fallbacks.
 */
function createAgyLaunchDir(worktreePath: string): string {
  const roots = [join(worktreePath, ".zer0", "agy"), tmpdir(), join(homedir(), ".zer0", "agy")];
  let failure: unknown;
  for (const root of roots) {
    try {
      mkdirSync(root, { recursive: true });
      return mkdtempSync(join(root, "run-"));
    } catch (error) {
      failure = error;
    }
  }
  throw failure instanceof Error ? failure : new Error("could not create isolated agy workspace");
}

// agy reads the compiled context as a FILE (its --print is arg-only with a ~32KB cap, no stdin). The ref
// is the ABSOLUTE path in BOTH lanes: a bare basename made Gemini 3.1 Pro resolve it against the cwd
// (the worktree) instead of the --add-dir workspace → "file not found" → a worktree list-loop that hangs
// (3.5 Flash resolved the basename against --add-dir, so it didn't). Wording stays a direct "read the
// file <abs>" — NOT "named exactly … workspace directory", which itself induced a workspace LIST (F5).
function readInstruction(fileName: string): string {
  return `Read the file ${fileName} in your workspace. It contains your full context and task. Follow its instructions and respond completely. Output only your response.`;
}

// SSOT for agy's argv. Grant presence, not a persisted mode, selects authority: absent forces
// --sandbox and --mode plan; explicit grants preserve their full-agent bypass and supported selected mode.
function buildAgyArgs(
  grant: AgentInput["grant"],
  addDir: string,
  contextRef: string,
  conversationId: string | undefined,
): string[] {
  // Resume THIS session's agy conversation by its captured id — survives the per-turn workspace (verified;
  // --continue's "most recent" timed out when the dir changed). Absent on the first turn → fresh (its id is
  // then captured + persisted). Never inherits another session's conversation (the id is per-session).
  const resume = conversationId === undefined ? [] : [CONVERSATION_FLAG, conversationId];
  // The operator's chosen model (native /model picker) applies to every gemini turn; unset → agy's default.
  const chosenModel = getAgentModel("gemini");
  const modelArgs = chosenModel === undefined ? [] : [MODEL_FLAG, chosenModel];
  const modeValue =
    grant === undefined
      ? "plan"
      : resolveAgyModeArg(getAgentMode(AGENT_NAME), cachedAgyModeSupport());
  const modeArgs = modeValue === undefined ? [] : [MODE_FLAG, modeValue];
  const tail = [
    ...modelArgs,
    ...modeArgs,
    ...resume,
    ADD_DIR_FLAG,
    addDir,
    PRINT_FLAG,
    readInstruction(contextRef),
  ];
  // S-C (FIX WAVE Round A, 2026-07-18 = sweep#3): SKIP_PERMISSIONS_FLAG leads the vector, before
  // --print's prompt-text value — never appended after it. The live probe that would prove agy's own
  // parser still accepts a flag AFTER --print's value is blocked this session (S1's own report); a
  // leading flag needs no such proof, since every conventional CLI parser accepts it correctly.
  return grant === undefined ? [SANDBOX_FLAG, ...tail] : [SKIP_PERMISSIONS_FLAG, ...tail];
}

// Resolves an explicit grant's persisted mode only when the known capability supports it. The absent
// grant branch does not call this helper: its required plan mode is enforced separately and fail-closed.
function resolveAgyModeArg(
  modeId: string | undefined,
  supported: boolean | undefined,
): string | undefined {
  if (supported !== true || modeId === undefined || modeId === "auto") {
    return undefined;
  }
  return modeId;
}

function buildAgyCommand(input: AgentInput): AdapterCommand {
  const parsed = parseInput(input);
  const isBuild = parsed.grant?.worktree === true;
  const addDir = isBuild ? parsed.worktreePath : dirname(parsed.contextFile);
  const contextRef = isBuild ? parsed.contextFile : basename(parsed.contextFile);
  return AdapterCommand.parse({
    args: buildAgyArgs(
      parsed.grant,
      addDir,
      contextRef,
      readStoredConversationId(parsed.agyConversationDir),
    ),
    cmd: agyExePath(),
  });
}

async function checkAgyHealth(signal: AbortSignal): Promise<AgentHealth> {
  try {
    const result = await execa(agyExePath(), [VERSION_FLAG], {
      cancelSignal: signal,
      cwd: process.cwd(),
      env: agyChildEnv(),
      extendEnv: false,
      maxBuffer: ADAPTER_STDOUT_MAX_BYTES,
      shell: false,
      stderr: "pipe",
      stdin: "ignore",
      stdout: "pipe",
      timeout: HEALTH_TIMEOUT_MS,
    });
    return { healthy: true, version: result.stdout.trim() };
  } catch (error) {
    return {
      error: `Antigravity CLI health check failed: ${extractMessage(error)}`,
      healthy: false,
    };
  }
}

function parseInput(input: AgentInput): AgentInput {
  const parsed = AgentInputSchema.parse(input);
  return {
    agent: parsed.agent,
    contextFile: parsed.contextFile,
    signal: parsed.signal,
    worktreePath: parsed.worktreePath,
    ...(parsed.grant !== undefined ? { grant: parsed.grant } : {}),
    ...(parsed.agyConversationDir !== undefined
      ? { agyConversationDir: parsed.agyConversationDir }
      : {}),
    ...(parsed.logger !== undefined ? { logger: parsed.logger } : {}),
    ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
  };
}

function extractMessage(error: unknown): string {
  if (error instanceof ExecaError) {
    return error.stderr ?? error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === "object" && value !== null && "aborted" in value;
}

function isLogger(value: unknown): value is Logger {
  return (
    typeof value === "object" &&
    value !== null &&
    "info" in value &&
    "warn" in value &&
    "error" in value &&
    "debug" in value
  );
}
