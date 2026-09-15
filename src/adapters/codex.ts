/**
 * @file src/adapters/codex.ts
 * @purpose Spawns `codex exec --sandbox workspace-write` via execa + parses stdout for verdict/cost.
 * @exports dispatchCodex
 * @depends execa, zod, ./types, ../shared/child-env, ../shared/error-codes, ../shared/errors, ../shared/logger, ../shared/types, ../shared/hermetic
 */
import { ExecaError, execa } from "execa";
import { z } from "zod";
import { childEnv } from "../shared/child-env.js";
import { Zer0ErrorCode } from "../shared/error-codes.js";
import { DispatchError, MalformedAgentOutputError } from "../shared/errors.js";
import { assertNotHermetic } from "../shared/hermetic.js";
import { type Logger, createLogger } from "../shared/logger.js";
import type { AgentHealth, AgentName, AgentResult } from "../shared/types.js";
import { getAgentModel } from "./agent-model-store.js";
import { AdapterCommand, AgentGrantSchema, type AgentInput } from "./types.js";

const AGENT_NAME: AgentName = "codex";
const CLI_COMMAND: string = "codex";
const EXEC_SUBCOMMAND: string = "exec";
const SANDBOX_FLAG: string = "--sandbox";
const WORKSPACE_WRITE_SANDBOX: string = "workspace-write";
const READ_ONLY_SANDBOX: string = "read-only";
// The operator's chosen model (native /model picker → agent-model-store) applied to EVERY codex turn via `-c`
// config overrides. The ACP model id bakes reasoning effort in as a suffix ("gpt-5.5[high]") → split into
// codex's `model` + `model_reasoning_effort` keys (the keys in ~/.codex/config.toml).
const CONFIG_FLAG: string = "-c";
const MODEL_EFFORT_PATTERN: RegExp = /^(.+?)\[(\w+)\]$/;
const VERSION_FLAG: string = "--version";
// 60 min STOPGAP cap (codex v0.135 xhigh is slow; complex tasks genuinely run 30-50 min). It is a ceiling,
// not a wait — small tasks return fast. NOTE: a flat wall cap is the wrong tool — the real fix (with the
// streaming/native sessions) is an IDLE timeout that kills only on prolonged SILENCE, so an arbitrarily long
// task that keeps streaming never dies and only a truly hung agent is reaped.
const DEFAULT_TIMEOUT_MS: number = 3_600_000;
const HEALTH_TIMEOUT_MS: number = 10_000;
const SUCCESS_EXIT_CODE: number = 0;
const FAILURE_EXIT_CODE: number = 1;
// Wide enough to carry the REAL error past codex's ~240-char startup banner (the old 240 cap showed only the
// banner — "reasoning summ…" — and hid every actual failure reason).
const STDERR_PREVIEW_LENGTH: number = 4_000;
const OUTPUT_PREVIEW_LENGTH: number = 2_000;
const ADAPTER_STDOUT_MAX_BYTES: number = 16_000_000;
const FENCED_JSON_PATTERN: RegExp = /```(?:json)?\s*([\s\S]*?)\s*```/u;

type CodexDispatch = {
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
 * Dispatches Codex against the compiled context file.
 *
 * @param input - validated subprocess inputs, including the caller cancellation signal
 * @returns parsed agent result with stdout and structured data when present
 * @throws DispatchError when Codex exits unsuccessfully or emits malformed structured output
 */
export const dispatchCodex: CodexDispatch = Object.assign(runCodex, {
  buildCommand: buildCodexCommand,
  healthCheck: checkCodexHealth,
  parseOutput: parseCodexOutput,
});

async function runCodex(input: AgentInput): Promise<AgentResult> {
  const parsedInput = parseInput(input);
  const command = buildCodexCommand(parsedInput);
  const logger = parsedInput.logger ?? createLogger();
  logger.info({ agent: AGENT_NAME, phase: "dispatch" }, "agent dispatched", {
    args: command.args,
    cmd: command.cmd,
    cwd: parsedInput.worktreePath,
  });
  try {
    assertNotHermetic("adapters/codex.run");
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
    return withExitCode(parseCodexOutput(result.stdout), result.exitCode ?? SUCCESS_EXIT_CODE);
  } catch (error) {
    throw toDispatchError(error);
  }
}

function buildCodexCommand(input: AgentInput): AdapterCommand {
  const parsedInput = parseInput(input);
  const grant = parsedInput.grant;
  // FULL-TOOLS: any write-capable grant runs workspace-write — codex decides whether to write (the operator's
  // "agents decide" model; git is the undo). Only the ABSENT-grant review path stays read-only.
  const sandbox = grant === undefined ? READ_ONLY_SANDBOX : WORKSPACE_WRITE_SANDBOX;
  const args = [EXEC_SUBCOMMAND, SANDBOX_FLAG, sandbox];
  if (grant?.research === true) {
    args.push("-c", "web_search=live");
  }
  args.push(...codexModelArgs());
  return AdapterCommand.parse({
    args,
    cmd: CLI_COMMAND,
    stdinFile: parsedInput.contextFile,
  });
}

// The -c overrides for the operator's chosen codex model; [] when unset. Splits the effort suffix
// ("gpt-5.5[high]" → model gpt-5.5 + model_reasoning_effort high) into the two config keys codex reads.
function codexModelArgs(): string[] {
  const model = getAgentModel("codex");
  if (model === undefined) {
    return [];
  }
  const match = MODEL_EFFORT_PATTERN.exec(model);
  if (match === null) {
    return [CONFIG_FLAG, `model=${model}`];
  }
  return [CONFIG_FLAG, `model=${match[1]}`, CONFIG_FLAG, `model_reasoning_effort=${match[2]}`];
}

function parseCodexOutput(raw: string, requireStructured = false): AgentResult {
  const structured = parseStructuredOutput(raw, requireStructured);
  return toAgentResult(
    AgentResultBaseSchema.parse({
      exitCode: SUCCESS_EXIT_CODE,
      stdout: selectStdout(raw, structured),
      ...(structured !== undefined ? { structured } : {}),
    }),
  );
}

async function checkCodexHealth(signal: AbortSignal): Promise<AgentHealth> {
  try {
    assertNotHermetic("adapters/codex.health");
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
      error: `Codex CLI health check failed: ${stderr}`,
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
      throw malformedOutput("Codex CLI emitted non-JSON output", raw);
    }
    return undefined;
  }
  try {
    return StructuredOutputSchema.parse(JSON.parse(jsonText));
  } catch (error) {
    // Chat mode (requireStructured=false): a JSON-looking `{...}` substring that fails to parse
    // is ordinary prose — codex exec text output frequently embeds such snippets. Treat it as
    // plain text (selectStdout returns raw). Only build/review (requireStructured=true) must throw.
    if (requireStructured) {
      throw malformedOutput("Codex CLI emitted malformed JSON output", raw, error);
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
      `Codex CLI stdout exceeded ${ADAPTER_STDOUT_MAX_BYTES} bytes preview="${preview(previewText)}"`,
      AGENT_NAME,
      FAILURE_EXIT_CODE,
      previewText,
      { cause: error, code: Zer0ErrorCode.AgentStdoutBufferExceeded },
    );
  }
  if (isTimeout(error)) {
    const timedOutStderr = extractStderr(error);
    return new DispatchError(
      `Codex CLI TIMED OUT after ${DEFAULT_TIMEOUT_MS / 60_000} min — the task ran past the limit (codex v0.135 "xhigh" reasoning is slow on big open-ended tasks; scope it smaller, or ask me to lower codex's reasoning effort). stderr="${preview(timedOutStderr)}"`,
      AGENT_NAME,
      FAILURE_EXIT_CODE,
      timedOutStderr,
      { cause: error },
    );
  }
  const exitCode = extractExitCode(error);
  const stderr = extractStderr(error);
  return new DispatchError(
    `Codex CLI dispatch failed with exitCode=${exitCode} stderr="${preview(stderr)}"`,
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

// True when execa aborted the child for exceeding the timeout — surfaced distinctly so a timeout reads as a
// timeout (not a generic exit-1 with only codex's startup banner, which is what hid the real failure).
function isTimeout(error: unknown): boolean {
  if (error instanceof ExecaError) {
    return error.timedOut === true;
  }
  return isErrorRecord(error) && error.timedOut === true;
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
  timedOut?: unknown;
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

// Subscription-first allowlist consolidated to shared/child-env.ts (CODEX_HOME passthrough included —
// the locally-duplicated copy silently dropped it; first-run wave).
