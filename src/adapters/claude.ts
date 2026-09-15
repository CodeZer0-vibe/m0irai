/**
 * @file src/adapters/claude.ts
 * @purpose Spawns `claude -p` (review json | chat/research text | BUILD tool-enabled) via execa.
 * @exports dispatchClaude
 * @depends execa, zod, ./types, ../shared/child-env, ../shared/error-codes, ../shared/errors, ../shared/logger, ../shared/types, ../shared/hermetic
 * @size-justified Adapter house pattern: one self-contained file per CLI family bundling
 *   dispatch+buildCommand+parse+health+env (siblings codex.ts 330, gemini.ts 381). Splitting one
 *   adapter alone would diverge from its peers; the BUILD branch is the AC-8 T1 addition. ≤250
 *   does not retrofit a pre-existing ~376-line house-pattern file.
 */
import { ExecaError, execa } from "execa";
import { z } from "zod";
import type { AgentGrant } from "../shared/agent-grant.js";
import { childEnv } from "../shared/child-env.js";
import { Zer0ErrorCode } from "../shared/error-codes.js";
import { DispatchError, MalformedAgentOutputError } from "../shared/errors.js";
import { assertNotHermetic } from "../shared/hermetic.js";
import { type Logger, createLogger } from "../shared/logger.js";
import type { AgentHealth, AgentName, AgentResult } from "../shared/types.js";
import { getAgentModel } from "./agent-model-store.js";
import { AdapterCommand, AgentGrantSchema, type AgentInput } from "./types.js";

const AGENT_NAME: AgentName = "claude";
const CLI_COMMAND: string = "claude";
const PROMPT_FLAG: string = "-p";
const OUTPUT_FORMAT_FLAG: string = "--output-format";
const JSON_FORMAT: string = "json";
const TEXT_FORMAT: string = "text";
const NO_SESSION_FLAG: string = "--no-session-persistence";
const EFFORT_FLAG: string = "--effort";
const DEFAULT_EFFORT: string = "high";
const MAX_EFFORT: string = "max";
// Headless dispatch must NOT load interactive setting sources (user/project/local).
// The user-level `Stop` quality-gate hook in ~/.claude/settings.json blocks `claude -p`
// completion and forces an auditor-dispatch loop that never terminates → SIGTERM (exit 143).
// Empty value loads zero sources; OAuth/keychain subscription auth is independent of this
// flag, so subscription-first is preserved (verified: `has Authorization header: false`).
const SETTING_SOURCES_FLAG: string = "--setting-sources";
const NO_SETTING_SOURCES: string = "";
// FULL-AUTO model (operator decision, verified against `claude --help`). chat/research/build all run claude
// as its FULL native self: --permission-mode bypassPermissions = every tool (incl Bash), no approval prompt
// (the headless cockpit can't answer one). The AGENT decides what to do; git is the undo for file changes.
// This RELAXES INV-1 (no-shell-escape) per the operator's explicit "full tools, they won't go rogue" call —
// see .council/findings.md. INV-7 (subscription-first) preserved: childEnv strips API keys regardless.
const PERMISSION_MODE_FLAG: string = "--permission-mode";
const BYPASS_PERMISSIONS_MODE: string = "bypassPermissions";
// The operator's chosen model (native /model picker → agent-model-store) applied to EVERY claude turn. The ACP
// model id "default" means claude's OWN recommended default, so omit the flag; any other id is passed through
// to `--model` (the ids come from claude's own ACP adapter, e.g. "sonnet", "claude-opus-4-8[1m]").
const MODEL_FLAG: string = "--model";
const CLAUDE_DEFAULT_MODEL_ID: string = "default";
const VERSION_FLAG: string = "--version";
// 60 min STOPGAP cap so a complex 30-50 min task isn't killed mid-run; small tasks return fast. The real fix
// is the streaming idle-timeout (kill on silence, not total runtime) that the native sessions bring.
const DEFAULT_TIMEOUT_MS: number = 3_600_000;
const HEALTH_TIMEOUT_MS: number = 10_000;
const SUCCESS_EXIT_CODE: number = 0;
const FAILURE_EXIT_CODE: number = 1;
const STDERR_PREVIEW_LENGTH: number = 240;
const OUTPUT_PREVIEW_LENGTH: number = 2_000;
const ADAPTER_STDOUT_MAX_BYTES: number = 16_000_000;
const FENCED_JSON_PATTERN: RegExp = /```(?:json)?\s*([\s\S]*?)\s*```/u;

type ClaudeDispatch = {
  (input: AgentInput): Promise<AgentResult>;
  buildCommand(input: AgentInput): AdapterCommand;
  parseOutput(raw: string, requireStructured?: boolean): AgentResult;
  healthCheck(signal: AbortSignal): Promise<AgentHealth>;
};

const AgentInputSchema = z
  .object({
    agent: z.literal(AGENT_NAME),
    grant: AgentGrantSchema.optional(),
    contextFile: z.string().min(1),
    logger: z.custom<Logger>(isLogger).optional(),
    signal: z.custom<AbortSignal>(isAbortSignal),
    timeoutMs: z.number().int().positive().optional(),
    worktreePath: z.string().min(1),
  })
  .strict();

const StructuredOutputSchema: z.ZodType<Record<string, unknown>> = z.record(z.unknown());
const AgentResultBaseSchema = z
  .object({
    exitCode: z.number().int(),
    files: z.array(z.object({ content: z.string(), path: z.string() }).strict()).optional(),
    stdout: z.string(),
    structured: z.record(z.unknown()).optional(),
  })
  .strict();

/**
 * Dispatches Claude Code against the compiled context file.
 *
 * @param input - validated subprocess inputs, including the caller cancellation signal
 * @returns parsed agent result with stdout and structured data when present
 * @throws DispatchError when Claude exits unsuccessfully or emits malformed structured output
 */
export const dispatchClaude: ClaudeDispatch = Object.assign(runClaude, {
  buildCommand: buildClaudeCommand,
  healthCheck: checkClaudeHealth,
  parseOutput: parseClaudeOutput,
});

async function runClaude(input: AgentInput): Promise<AgentResult> {
  const parsedInput = parseInput(input);
  const command = buildClaudeCommand(parsedInput);
  const logger = parsedInput.logger ?? createLogger();
  logger.info({ agent: AGENT_NAME, phase: "dispatch" }, "agent dispatched", {
    args: command.args,
    cmd: command.cmd,
    cwd: parsedInput.worktreePath,
  });
  try {
    assertNotHermetic("adapters/claude.run");
    const result = await execa(command.cmd, command.args, {
      cancelSignal: parsedInput.signal,
      cwd: parsedInput.worktreePath,
      env: childEnv(),
      extendEnv: false,
      maxBuffer: ADAPTER_STDOUT_MAX_BYTES,
      shell: false,
      stderr: "pipe",
      stdin: "pipe",
      stdout: "pipe",
      timeout: parsedInput.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(command.stdinFile !== undefined ? { inputFile: command.stdinFile } : {}),
    });
    return withExitCode(parseClaudeOutput(result.stdout), result.exitCode ?? SUCCESS_EXIT_CODE);
  } catch (error) {
    throw toDispatchError(error);
  }
}

function buildClaudeCommand(input: AgentInput): AdapterCommand {
  const parsedInput = parseInput(input);
  return AdapterCommand.parse({
    args: [...claudeArgsFor(parsedInput.grant), ...claudeModelArgs()],
    cmd: CLI_COMMAND,
    stdinFile: parsedInput.contextFile,
  });
}

// The --model args for the operator's chosen claude model; [] when unset or the agent's own default.
function claudeModelArgs(): string[] {
  const model = getAgentModel("claude");
  return model === undefined || model === CLAUDE_DEFAULT_MODEL_ID ? [] : [MODEL_FLAG, model];
}

// Per-grant argv. A PRESENT grant (write-capable work turn) runs FULL-AUTO (bypassPermissions = every tool
// incl Bash, no prompt): the AGENT decides what to do — the operator's "full tools, agents decide" model (git
// is the undo), not a keyword guess. A `research` grant keeps MAX effort. An ABSENT grant (read-only review)
// → json at high effort. All work turns pass `--setting-sources ""` to suppress the W13 Stop-hook hang.
function claudeArgsFor(grant: AgentGrant | undefined): string[] {
  const headless = [PROMPT_FLAG, NO_SESSION_FLAG, OUTPUT_FORMAT_FLAG, TEXT_FORMAT, EFFORT_FLAG];
  if (grant !== undefined) {
    return [
      ...headless,
      grant.research ? MAX_EFFORT : DEFAULT_EFFORT,
      SETTING_SOURCES_FLAG,
      NO_SETTING_SOURCES,
      PERMISSION_MODE_FLAG,
      BYPASS_PERMISSIONS_MODE,
    ];
  }
  return [
    PROMPT_FLAG,
    OUTPUT_FORMAT_FLAG,
    JSON_FORMAT,
    EFFORT_FLAG,
    DEFAULT_EFFORT,
    SETTING_SOURCES_FLAG,
    NO_SETTING_SOURCES,
  ];
}

function parseClaudeOutput(raw: string, requireStructured = false): AgentResult {
  const structured = parseStructuredOutput(raw, requireStructured);
  return toAgentResult(
    AgentResultBaseSchema.parse({
      exitCode: SUCCESS_EXIT_CODE,
      stdout: selectStdout(raw, structured),
      ...(structured !== undefined ? { structured } : {}),
    }),
  );
}

async function checkClaudeHealth(signal: AbortSignal): Promise<AgentHealth> {
  try {
    assertNotHermetic("adapters/claude.health");
    const result = await execa(CLI_COMMAND, [VERSION_FLAG], {
      cancelSignal: signal,
      cwd: process.cwd(),
      env: childEnv(),
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
    const stderr = extractStderr(error);
    return {
      error: `Claude CLI health check failed: ${stderr}`,
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
    ...(parsed.logger !== undefined ? { logger: parsed.logger } : {}),
    ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
  };
}

function parseStructuredOutput(
  raw: string,
  requireStructured: boolean,
): Record<string, unknown> | undefined {
  const jsonText = extractJsonText(raw);
  if (jsonText === undefined) {
    if (requireStructured) {
      throw malformedOutput("Claude CLI emitted non-JSON output", raw);
    }
    return undefined;
  }
  try {
    return StructuredOutputSchema.parse(JSON.parse(jsonText));
  } catch (error) {
    // Chat mode (requireStructured=false): a JSON-looking `{...}` substring that fails to parse
    // is ordinary prose, not a contract violation. Treat it as plain text (selectStdout returns
    // raw). Only build/review (requireStructured=true) must throw on malformed JSON.
    if (requireStructured) {
      throw malformedOutput("Claude CLI emitted malformed JSON output", raw, error);
    }
    return undefined;
  }
}

function extractJsonText(raw: string): string | undefined {
  const fenced = FENCED_JSON_PATTERN.exec(raw);
  if (fenced?.[1] !== undefined) {
    return fenced[1].trim();
  }
  const trimmed = raw.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}") ? trimmed : undefined;
}

function selectStdout(raw: string, structured: Record<string, unknown> | undefined): string {
  return typeof structured?.stdout === "string" ? structured.stdout : raw;
}

function withExitCode(result: AgentResult, exitCode: number): AgentResult {
  return { ...result, exitCode };
}

function toAgentResult(value: z.infer<typeof AgentResultBaseSchema>): AgentResult {
  return {
    exitCode: value.exitCode,
    stdout: value.stdout,
    ...(value.files !== undefined ? { files: value.files } : {}),
    ...(value.structured !== undefined ? { structured: value.structured } : {}),
  };
}

function toDispatchError(error: unknown): DispatchError {
  if (error instanceof DispatchError) {
    return error;
  }
  if (isMaxBufferError(error)) {
    const previewText = outputPreview(error);
    return new DispatchError(
      `Claude CLI stdout exceeded ${ADAPTER_STDOUT_MAX_BYTES} bytes preview="${preview(previewText)}"`,
      AGENT_NAME,
      FAILURE_EXIT_CODE,
      previewText,
      { cause: error, code: Zer0ErrorCode.AgentStdoutBufferExceeded },
    );
  }
  const exitCode = extractExitCode(error);
  const stderr = extractStderr(error);
  return new DispatchError(
    `Claude CLI dispatch failed with exitCode=${exitCode} stderr="${preview(stderr)}"`,
    AGENT_NAME,
    exitCode,
    stderr,
    { cause: error },
  );
}

function malformedOutput(message: string, raw: string, cause?: unknown): MalformedAgentOutputError {
  return new MalformedAgentOutputError(message, AGENT_NAME, raw.slice(0, OUTPUT_PREVIEW_LENGTH), {
    cause,
  });
}

function extractExitCode(error: unknown): number {
  if (error instanceof ExecaError) {
    return error.exitCode ?? FAILURE_EXIT_CODE;
  }
  return isErrorRecord(error) && typeof error.exitCode === "number"
    ? error.exitCode
    : FAILURE_EXIT_CODE;
}

function extractStderr(error: unknown): string {
  if (error instanceof ExecaError) {
    return error.stderr ?? "";
  }
  if (isErrorRecord(error) && typeof error.stderr === "string") {
    return error.stderr;
  }
  return error instanceof Error ? error.message : String(error);
}

function preview(value: string): string {
  return value.slice(0, STDERR_PREVIEW_LENGTH);
}

function isMaxBufferError(error: unknown): boolean {
  return isErrorRecord(error) && error.isMaxBuffer === true;
}

function outputPreview(error: unknown): string {
  if (!isErrorRecord(error)) {
    return "";
  }
  const stdout = typeof error.stdout === "string" ? error.stdout : "";
  const stderr = typeof error.stderr === "string" ? error.stderr : "";
  return (stdout.length > 0 ? stdout : stderr).slice(0, OUTPUT_PREVIEW_LENGTH);
}

function isErrorRecord(error: unknown): error is {
  exitCode?: unknown;
  isMaxBuffer?: unknown;
  stderr?: unknown;
  stdout?: unknown;
} {
  return typeof error === "object" && error !== null;
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

// Subscription-first allowlist consolidated to shared/child-env.ts (first-run wave).
