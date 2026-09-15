/**
 * @file src/shared/logger.ts
 * @purpose Structured stderr logger with deterministic level filtering and circular-ref-safe meta serialization.
 * @exports Logger, LogContext, LogLevel, DbLoggerConfig, createLogger, createDbLogger,
 *   loggerSinkFailureCount, resetLoggerSinkFailureCount
 * @depends node:crypto, node:process, ./debug-mode, ./error-codes, ./ids, ./screen-claim, ./tui-suppressed-log
 */
import { createHash } from "node:crypto";
import process from "node:process";
import { debugEnabled } from "./debug-mode.js";
import { getErrorMetadata, isZer0ErrorCode } from "./error-codes.js";
import { newErrorId, newEventId } from "./ids.js";
import { screenClaimed } from "./screen-claim.js";
import { appendTuiSuppressed } from "./tui-suppressed-log.js";

/**
 * Log level ordered low (debug) to high (error); used by both Logger and Zer0Config.logLevel.
 *
 * @public Consumed by `src/shared/config.ts` (Zer0Config.logLevel) and CLI/Activity callers.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const DEBUG_RANK: number = 10;
const INFO_RANK: number = 20;
const WARN_RANK: number = 30;
const ERROR_RANK: number = 40;
const DEFAULT_LEVEL: LogLevel = "info";
const DEBUG_ENV_VALUE: string = "debug";
const EMPTY_CONTEXT_PART: string = "-";

const LEVEL_RANKS: Record<LogLevel, number> = {
  debug: DEBUG_RANK,
  info: INFO_RANK,
  warn: WARN_RANK,
  error: ERROR_RANK,
};

/**
 * Structured context attached to one log event.
 */
export interface LogContext {
  phase?: string;
  task?: string;
  agent?: string;
  runId?: string;
}

/**
 * Minimal structured logger used by CLI and workflow code.
 */
export interface Logger {
  info(ctx: LogContext, msg: string, meta?: Record<string, unknown>): void;
  warn(ctx: LogContext, msg: string, meta?: Record<string, unknown>): void;
  error(ctx: LogContext, msg: string, meta?: Record<string, unknown>): void;
  debug(ctx: LogContext, msg: string, meta?: Record<string, unknown>): void;
}

export interface DbLoggerConfig {
  runId: string;
  db: DbWriteHandle;
  source: string;
  baseLogger?: Logger;
}

interface DbWriteHandle {
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
  };
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
}

interface SequenceRow {
  sequence: number;
}

/**
 * Creates a stderr logger with deterministic level filtering.
 *
 * @param opts - optional log level override; falls back to ZER0_LOG_LEVEL env var, then "info"
 * @returns logger writing formatted lines to process stderr
 *
 * @remarks
 * Reads `process.env.ZER0_LOG_LEVEL` once at logger creation. Safe for CLI startup and Temporal
 * Activity contexts. NOT safe inside workflow code (the workflow sandbox forbids `process.env`
 * reads). Workflows must accept a logger via dependency injection rather than calling
 * createLogger() themselves.
 */
export function createLogger(opts?: { level?: "debug" | "info" | "warn" | "error" }): Logger {
  const minimumLevel = resolveLevel(opts?.level);
  return {
    info: (ctx: LogContext, msg: string, meta?: Record<string, unknown>): void => {
      writeLog("info", minimumLevel, ctx, msg, meta);
    },
    warn: (ctx: LogContext, msg: string, meta?: Record<string, unknown>): void => {
      writeLog("warn", minimumLevel, ctx, msg, meta);
    },
    error: (ctx: LogContext, msg: string, meta?: Record<string, unknown>): void => {
      writeLog("error", minimumLevel, ctx, msg, meta);
    },
    debug: (ctx: LogContext, msg: string, meta?: Record<string, unknown>): void => {
      writeLog("debug", minimumLevel, ctx, msg, meta);
    },
  };
}

export function createDbLogger(config: DbLoggerConfig): Logger {
  const baseLogger = config.baseLogger ?? createLogger();
  return {
    info: (ctx: LogContext, msg: string, meta?: Record<string, unknown>): void => {
      emitDbLog({ baseLogger, config, ctx, level: "info", meta, msg });
    },
    warn: (ctx: LogContext, msg: string, meta?: Record<string, unknown>): void => {
      emitDbLog({ baseLogger, config, ctx, level: "warn", meta, msg });
    },
    error: (ctx: LogContext, msg: string, meta?: Record<string, unknown>): void => {
      emitDbLog({ baseLogger, config, ctx, level: "error", meta, msg });
    },
    debug: (ctx: LogContext, msg: string, meta?: Record<string, unknown>): void => {
      emitDbLog({ baseLogger, config, ctx, level: "debug", meta, msg });
    },
  };
}

function resolveLevel(level?: LogLevel): LogLevel {
  if (level !== undefined) {
    return level;
  }
  if (process.env.ZER0_LOG_LEVEL === DEBUG_ENV_VALUE) {
    return "debug";
  }
  // ZER0_DEBUG floors the level to "debug" (the master switch implies full audit logging), UNDER an explicit
  // opts.level / ZER0_LOG_LEVEL=debug (both handled above) so it never fights an explicit setting. B2a-1:
  // ZER0_DEBUG is ON BY DEFAULT (opt-out) — an UNSET env now floors to debug; only an explicit ZER0_DEBUG=0
  // (or another falsy sentinel) leaves the level at DEFAULT_LEVEL.
  if (debugEnabled()) {
    return "debug";
  }
  return DEFAULT_LEVEL;
}

// Sol wave-8 DECISION 3: the ONE last-resort diagnostic left once a sink write has already failed
// and swallowed its own error — a plain in-memory increment, which cannot itself throw under any
// realistic JS engine behavior, so adding it introduces zero new risk to the fail-soft guarantee
// below. Module-scoped (not per-Logger-instance): every createLogger()/createDbLogger() call funnels
// through this SAME writeLog, so the counter aggregates every swallowed sink failure process-wide.
let sinkFailureCount = 0;

/** How many log lines have been silently dropped because the sink itself failed to write (EPIPE on a
 *  closed stderr, a permission error on the suppressed-log file, etc). Diagnostics-only signal —
 *  never consulted by any decision path; reading it can never affect program behavior. */
export function loggerSinkFailureCount(): number {
  return sinkFailureCount;
}

/** Test seam: resets the counter so one test's swallowed failures don't leak into the next. */
export function resetLoggerSinkFailureCount(): void {
  sinkFailureCount = 0;
}

function writeLog(
  level: LogLevel,
  minimumLevel: LogLevel,
  ctx: LogContext,
  msg: string,
  meta?: Record<string, unknown>,
): void {
  if (LEVEL_RANKS[level] < LEVEL_RANKS[minimumLevel]) {
    return;
  }
  if (msg.length === 0) {
    // A genuine CALLER contract violation (not an environmental sink failure) — stays loud and
    // OUTSIDE the fail-soft wrapper below, on purpose: "logging can never affect outcomes" is about
    // protecting callers from the ENVIRONMENT, never about hiding a programming error from the
    // developer who just called the logger wrong.
    throw new RangeError("Logger message must be non-empty for process stderr output");
  }
  // Formally fail-soft (sol wave-8 DECISION 3): the ENTIRE body below — formatting AND both sink
  // branches (stderr write, appendTuiSuppressed) — is one guarded region. Every debug/info/warn/error
  // call site across the codebase, including ones sitting inside a db.transaction() callback, depends
  // on this never throwing; a sink that cannot log has no safer channel left and must never take its
  // caller down with it (the design note this function's header promises in place of a second-order
  // "log the log failure" attempt, which would just reopen the same throw risk one level up).
  try {
    const line = `${formatLogLine(level, ctx, msg, meta)}\n`;
    if (screenClaimed()) {
      // a full-screen TUI owns the terminal — a raw stderr log corrupts its frame. Tee to the sink so the
      // diagnostic survives rather than dropping silently (which hid real failures for weeks).
      appendTuiSuppressed(line);
      return;
    }
    process.stderr.write(line);
  } catch {
    sinkFailureCount += 1;
  }
}

function formatLogLine(
  level: LogLevel,
  ctx: LogContext,
  msg: string,
  meta?: Record<string, unknown>,
): string {
  const timestamp = new Date().toISOString();
  const context = `${part(ctx.runId)}/${part(ctx.phase)}/${part(ctx.task)}/${part(ctx.agent)}`;
  const metadata = safeStringifyMeta(meta);
  return `[${timestamp}] [${level.toUpperCase()}] [${context}] ${msg} ${metadata}`;
}

/**
 * Stringifies log metadata, falling back to a typed sentinel when the value
 * contains circular references or other JSON.stringify-incompatible content.
 *
 * @param meta - log metadata object, possibly containing cycles
 * @returns JSON string of meta, or a sentinel object describing why serialization failed
 * @pure
 */
function safeStringifyMeta(meta: Record<string, unknown> | undefined): string {
  try {
    return JSON.stringify(meta ?? {});
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ _meta_serialization_error: reason });
  }
}

function part(value: string | undefined): string {
  return value ?? EMPTY_CONTEXT_PART;
}

function emitDbLog(event: DbLogEvent): void {
  const { baseLogger, config, ctx, level, meta, msg } = event;
  baseLogger[level](ctx, msg, meta);
  try {
    const payload = { level, message: msg, ctx, meta: meta ?? {}, source: config.source };
    insertLogEvent(config, payload);
    if (level === "error" && isZer0ErrorCode(meta?.code)) {
      insertError(config, msg, meta.code, meta);
    }
  } catch (error) {
    baseLogger.warn(ctx, "database log write failed", { reason: errorMessage(error) });
  }
}

interface DbLogEvent {
  level: LogLevel;
  config: DbLoggerConfig;
  baseLogger: Logger;
  ctx: LogContext;
  msg: string;
  meta: Record<string, unknown> | undefined;
}

function insertLogEvent(config: DbLoggerConfig, payload: Record<string, unknown>): void {
  const next = config.db
    .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM events WHERE run_id = ?")
    .get(config.runId) as SequenceRow;
  config.db
    .prepare("INSERT INTO events (id, run_id, sequence, kind, payload_json) VALUES (?, ?, ?, ?, ?)")
    .run(newEventId(), config.runId, next.sequence, "log", JSON.stringify(payload));
}

function insertError(
  config: DbLoggerConfig,
  message: string,
  code: NonNullable<Record<string, unknown>["code"]>,
  meta: Record<string, unknown>,
): void {
  const codeValue = isZer0ErrorCode(code) ? code : undefined;
  if (codeValue === undefined) {
    return;
  }
  const metadata = getErrorMetadata(codeValue);
  config.db
    .prepare(
      "INSERT INTO errors (id, run_id, code, category, retryability, message, evidence_json, fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      newErrorId(),
      config.runId,
      codeValue,
      metadata.category,
      metadata.retryability,
      message,
      JSON.stringify(meta),
      stableFingerprint(codeValue, message),
    );
}

function stableFingerprint(code: string, message: string): string {
  return createHash("sha256").update(`${code}\u001f${message}`).digest("hex").slice(0, 16);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
