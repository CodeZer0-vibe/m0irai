/**
 * @file src/shared/config.ts
 * @purpose Loads + validates .zer0/config.yaml synchronously for CLI startup; provides async variant for workflow contexts.
 * @exports Zer0Config, Zer0ConfigSchema, loadConfig, loadConfigAsync
 * @depends node:fs, zod, ./error-codes, ./errors
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { Zer0ErrorCode } from "./error-codes.js";
import { ConfigError } from "./errors.js";

const DEFAULT_CONFIG_PATH: string = ".zer0/config.yaml";
const DEFAULT_TEMPORAL_ADDRESS: string = "localhost:7233";
const DEFAULT_TEMPORAL_NAMESPACE: string = "default";
const DEFAULT_TASK_QUEUE: string = "zer0-pipeline";
const DEFAULT_BLOB_ROOT: string = ".zer0/blobs";
const DEFAULT_DB_PATH: string = ".zer0/evidence.db";
const DEFAULT_WORKTREE_ROOT: string = ".agent-ci/worktrees";
const DEFAULT_TIMEOUT_MS: number = 300_000;
const DEFAULT_MAX_FIX_ITERATIONS: number = 3;
const DEFAULT_FINDING_INFLATION_THRESHOLD: number = 15;
const YAML_KEY_PATTERN: RegExp = /^([A-Za-z_][A-Za-z0-9_]*):(?:\s*(.*))?$/;
const INTEGER_PATTERN: RegExp = /^-?\d+$/;
const DOUBLE_QUOTE: string = '"';
const SINGLE_QUOTE: string = "'";
const COMMENT_PREFIX: string = "#";
const LIST_PREFIX: string = "- ";

interface YamlLine {
  key: string;
  rawValue: string;
  indent: number;
  index: number;
}

type DefaultableInput<T> = {
  [Key in keyof T]?: T[Key] | undefined;
};

type SchemaMatches<Schema extends z.ZodTypeAny, Interface> = z.infer<Schema> extends Interface
  ? Interface extends z.infer<Schema>
    ? true
    : ["interface has fields not in schema"]
  : ["schema produces fields not in interface"];

type AssertTrue<T extends true> = T;

/**
 * Project-level Zer0 runtime configuration.
 */
export interface Zer0Config {
  temporalAddress: string;
  temporalNamespace: string;
  taskQueue: string;
  blobRoot: string;
  dbPath: string;
  worktreeRoot: string;
  defaultTimeoutMs: number;
  maxFixIterations: number;
  findingInflationThreshold: number;
}

/**
 * Runtime schema for Zer0Config values loaded from disk.
 * Defaults are applied during parsing for omitted config keys.
 */
export const Zer0ConfigSchema: z.ZodType<Zer0Config, z.ZodTypeDef, DefaultableInput<Zer0Config>> = z
  .object({
    temporalAddress: z.string().min(1).default(DEFAULT_TEMPORAL_ADDRESS),
    temporalNamespace: z.string().min(1).default(DEFAULT_TEMPORAL_NAMESPACE),
    taskQueue: z.string().min(1).default(DEFAULT_TASK_QUEUE),
    blobRoot: z.string().min(1).default(DEFAULT_BLOB_ROOT),
    dbPath: z.string().min(1).default(DEFAULT_DB_PATH),
    worktreeRoot: z.string().min(1).default(DEFAULT_WORKTREE_ROOT),
    defaultTimeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS),
    maxFixIterations: z.number().int().nonnegative().default(DEFAULT_MAX_FIX_ITERATIONS),
    findingInflationThreshold: z
      .number()
      .int()
      .nonnegative()
      .default(DEFAULT_FINDING_INFLATION_THRESHOLD),
  })
  .strict();

/**
 * Compile-time assertion that {@link Zer0ConfigSchema}'s inferred output exactly matches the
 * {@link Zer0Config} interface. Producing a type error here means the schema and interface
 * have drifted; bring them back in sync rather than silencing the assertion.
 *
 * This type has no runtime cost; it is erased after type checking.
 */
/**
 * Compile-time guard: forces TypeScript to evaluate `AssertTrue<SchemaMatches<>>` so a
 * Zod schema / Zer0Config interface drift fails typecheck at this declaration. The const
 * is `void`-referenced because it has no runtime semantics. Unexported per knip rule
 * (codex infra-review I-1).
 */
const _ZER0_CONFIG_SCHEMA_GUARD: AssertTrue<SchemaMatches<typeof Zer0ConfigSchema, Zer0Config>> =
  true;
void _ZER0_CONFIG_SCHEMA_GUARD;

/**
 * Loads and validates project configuration from YAML.
 *
 * @param path - config file path, defaulting to .zer0/config.yaml
 * @param signal - optional cancellation signal checked around disk reads
 * @returns validated config with defaults filled for omitted keys
 * @throws ConfigError when the config file is unreadable or malformed
 *
 * @remarks
 * Sync by design for CLI startup paths (single read at process boot, no event loop to block).
 * For workflow contexts where sync I/O is forbidden by the Temporal sandbox, use
 * {@link loadConfigAsync}.
 */
export function loadConfig(path?: string, signal?: AbortSignal): Zer0Config {
  const configPath = path ?? DEFAULT_CONFIG_PATH;
  throwIfAborted(signal, configPath);
  if (!existsSync(configPath)) {
    return applyEnvOverrides(parseConfig({}, configPath));
  }
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const message = `Failed to read config at "${configPath}": ${reason}`;
    throw new ConfigError(message, Zer0ErrorCode.ConfigInvalid, errorCause(err));
  }
  throwIfAborted(signal, configPath);
  return applyEnvOverrides(parseConfig(parseConfigYaml(raw, configPath), configPath));
}

/**
 * Async variant of {@link loadConfig} for use inside Temporal workflows or any context where
 * sync file I/O is forbidden.
 *
 * @param path - config file path, defaulting to .zer0/config.yaml
 * @param signal - optional cancellation signal
 * @returns validated config with defaults filled for omitted keys
 * @throws ConfigError when the config file is unreadable or malformed
 */
export async function loadConfigAsync(path?: string, signal?: AbortSignal): Promise<Zer0Config> {
  const { readFile, access } = await import("node:fs/promises");
  const configPath = path ?? DEFAULT_CONFIG_PATH;
  throwIfAborted(signal, configPath);
  try {
    await access(configPath);
  } catch {
    return applyEnvOverrides(parseConfig({}, configPath));
  }
  throwIfAborted(signal, configPath);
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const message = `Failed to read config at "${configPath}": ${reason}`;
    throw new ConfigError(message, Zer0ErrorCode.ConfigInvalid, errorCause(err));
  }
  throwIfAborted(signal, configPath);
  return applyEnvOverrides(parseConfig(parseConfigYaml(raw, configPath), configPath));
}

// Test-isolation hook: tests calling real activities set ZER0_DB_PATH to redirect the
// activity's evidence DB target to an isolated tmp path, preventing cross-process pollution
// of the production .zer0/evidence.db (G3 — packet-1h post-mortem).
function applyEnvOverrides(config: Zer0Config): Zer0Config {
  const dbPathOverride = process.env.ZER0_DB_PATH;
  if (dbPathOverride !== undefined && dbPathOverride.length > 0) {
    return { ...config, dbPath: dbPathOverride };
  }
  return config;
}

function parseConfig(raw: Record<string, unknown>, configPath: string): Zer0Config {
  try {
    return Zer0ConfigSchema.parse(raw);
  } catch (error) {
    if (isZodError(error)) {
      const message =
        `Failed to validate config at "${configPath}": expected Zer0Config fields, ` +
        `received ${error.message}`;
      throw new ConfigError(message, Zer0ErrorCode.ConfigInvalid, {
        cause: error,
      });
    }
    throw error;
  }
}

function isZodError(error: unknown): error is Error {
  return error instanceof Error && error.name === "ZodError";
}

function errorCause(error: unknown): ErrorOptions | undefined {
  return error instanceof Error ? { cause: error } : undefined;
}

function parseConfigYaml(raw: string, configPath: string): Record<string, unknown> {
  const parsed: Record<string, unknown> = {};
  let section: string | undefined;
  for (const [index, sourceLine] of raw.split(/\r?\n/).entries()) {
    const line = sourceLine.trimEnd();
    const trimmed = line.trimStart();
    if (
      trimmed.length === 0 ||
      trimmed.startsWith(COMMENT_PREFIX) ||
      trimmed.startsWith(LIST_PREFIX)
    ) {
      continue;
    }
    const match = YAML_KEY_PATTERN.exec(trimmed);
    if (match === null) {
      throw yamlError(configPath, index, sourceLine, "expected a YAML key followed by ':'");
    }
    section = applyYamlEntry(
      parsed,
      section,
      {
        key: match[1] ?? "",
        rawValue: match[2] ?? "",
        indent: line.length - trimmed.length,
        index,
      },
      configPath,
    );
  }
  return parsed;
}

function applyYamlEntry(
  parsed: Record<string, unknown>,
  section: string | undefined,
  line: YamlLine,
  configPath: string,
): string | undefined {
  if (line.rawValue.length === 0) {
    return line.indent === 0 ? line.key : section;
  }
  const configKey = resolveConfigKey(line.indent === 0 ? line.key : `${section ?? ""}.${line.key}`);
  if (configKey !== undefined) {
    parsed[configKey] = parseScalar(line.rawValue);
  }
  if (line.indent > 0 && section === undefined) {
    throw yamlError(
      configPath,
      line.index,
      line.key,
      "expected nested key under a top-level section",
    );
  }
  return line.indent === 0 ? undefined : section;
}

function resolveConfigKey(path: string): keyof Zer0Config | undefined {
  const direct: Record<string, keyof Zer0Config> = {
    temporalAddress: "temporalAddress",
    temporalNamespace: "temporalNamespace",
    taskQueue: "taskQueue",
    blobRoot: "blobRoot",
    dbPath: "dbPath",
    worktreeRoot: "worktreeRoot",
    defaultTimeoutMs: "defaultTimeoutMs",
    maxFixIterations: "maxFixIterations",
    findingInflationThreshold: "findingInflationThreshold",
    "temporal.address": "temporalAddress",
    "temporal.namespace": "temporalNamespace",
    "temporal.task_queue": "taskQueue",
    "retries.fix_loop": "maxFixIterations",
    "thresholds.finding_inflation": "findingInflationThreshold",
  };
  return direct[path];
}

function parseScalar(rawValue: string): string | number | boolean {
  const value = rawValue.trim();
  if (isQuoted(value, DOUBLE_QUOTE) || isQuoted(value, SINGLE_QUOTE)) {
    return value.slice(DOUBLE_QUOTE.length, -DOUBLE_QUOTE.length);
  }
  if (INTEGER_PATTERN.test(value)) {
    return Number(value);
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return value;
}

function isQuoted(value: string, quote: string): boolean {
  return value.startsWith(quote) && value.endsWith(quote);
}

function yamlError(
  configPath: string,
  index: number,
  line: string,
  expectation: string,
): ConfigError {
  return new ConfigError(
    `Failed to parse config at "${configPath}" line ${index + 1}: ` +
      `${expectation}; received "${line}"`,
    Zer0ErrorCode.ConfigInvalid,
  );
}

function throwIfAborted(signal: AbortSignal | undefined, configPath: string): void {
  if (signal?.aborted === true) {
    const message = `Failed to load config at "${configPath}": operation was aborted before config was available`;
    throw new ConfigError(message, Zer0ErrorCode.ConfigInvalid);
  }
}
