import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type Zer0Config, loadConfig, loadConfigAsync } from "./config.js";
import { ConfigError } from "./errors.js";

const TEMP_PREFIX: string = "zer0-config-";
const DB_PATH_ENV: string = "ZER0_DB_PATH";
const DEFAULT_CONFIG: Zer0Config = {
  temporalAddress: "localhost:7233",
  temporalNamespace: "default",
  taskQueue: "zer0-pipeline",
  blobRoot: ".zer0/blobs",
  dbPath: ".zer0/evidence.db",
  worktreeRoot: ".agent-ci/worktrees",
  defaultTimeoutMs: 300_000,
  maxFixIterations: 3,
  findingInflationThreshold: 15,
};

let tempRoot: string | undefined;
const savedDbPathEnv = process.env[DB_PATH_ENV];

// Every assertion below is about what loadConfig derives FROM THE FILE, so the env override must be
// out of the way — and stated, not assumed. It was assumed before W4-R3a C1, which made these tests
// fail the moment the suite began setting a per-worker ZER0_DB_PATH (and they would equally have
// failed for any operator whose own shell exported it). The override's OWN behaviour is falsified
// explicitly at the bottom of this file instead.
beforeEach(() => {
  Reflect.deleteProperty(process.env, DB_PATH_ENV);
});

afterEach(async () => {
  if (savedDbPathEnv === undefined) Reflect.deleteProperty(process.env, DB_PATH_ENV);
  else process.env[DB_PATH_ENV] = savedDbPathEnv;
  if (tempRoot !== undefined) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

it("returns defaults when config file does not exist", () => {
  const configPath = join(tmpdir(), "zer0-config-missing.yaml");

  expect(loadConfig(configPath)).toEqual(DEFAULT_CONFIG);
});

it("parses YAML scalar overrides and fills omitted defaults", async () => {
  const configPath = await writeConfig([
    "temporal:",
    "  address: temporal:7233",
    "  namespace: production",
    "  task_queue: zer0-prod",
    "retries:",
    "  fix_loop: 2",
    "thresholds:",
    "  finding_inflation: 9",
    "blobRoot: .zer0/custom-blobs",
  ]);

  expect(loadConfig(configPath)).toEqual({
    ...DEFAULT_CONFIG,
    temporalAddress: "temporal:7233",
    temporalNamespace: "production",
    taskQueue: "zer0-prod",
    blobRoot: ".zer0/custom-blobs",
    maxFixIterations: 2,
    findingInflationThreshold: 9,
  });
});

it("throws ConfigError with context when YAML has invalid syntax", async () => {
  const configPath = await writeConfig(["temporal", "  address: localhost:7233"]);

  expect(() => loadConfig(configPath)).toThrow(ConfigError);
  expect(() => loadConfig(configPath)).toThrow(`Failed to parse config at "${configPath}" line 1`);
});

it("throws ConfigError when parsed YAML violates the config schema", async () => {
  const configPath = await writeConfig(["temporal:", "  address: false"]);

  expect(() => loadConfig(configPath)).toThrow(ConfigError);
  expect(() => loadConfig(configPath)).toThrow(`Failed to validate config at "${configPath}"`);
});

it("throws ConfigError when the abort signal is already aborted", () => {
  const controller = new AbortController();
  controller.abort();

  expect(() => loadConfig("config.yaml", controller.signal)).toThrow(ConfigError);
  expect(() => loadConfig("config.yaml", controller.signal)).toThrow("operation was aborted");
});

it("wraps file-unreadable errors as ConfigError", () => {
  const dirPath = mkdtempSync(join(tmpdir(), "zer0-config-unreadable-"));

  try {
    let caught: unknown;
    try {
      loadConfig(dirPath);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect(caught).toHaveProperty(
      "message",
      expect.stringContaining(`Failed to read config at "${dirPath}"`),
    );
    expect(caught).toHaveProperty("cause");
  } finally {
    rmSync(dirPath, { recursive: true, force: true });
  }
});

it("loadConfigAsync returns defaults when file missing", async () => {
  const config = await loadConfigAsync(join(tmpdir(), `nonexistent-${Date.now()}.yaml`));

  expect(config.temporalAddress).toBe(DEFAULT_CONFIG.temporalAddress);
});

it("loadConfigAsync wraps unreadable errors as ConfigError", async () => {
  const dirPath = mkdtempSync(join(tmpdir(), "zer0-config-async-unreadable-"));

  try {
    await expect(loadConfigAsync(dirPath)).rejects.toBeInstanceOf(ConfigError);
  } finally {
    rmSync(dirPath, { recursive: true, force: true });
  }
});

// W4-R3a C1: the ZER0_DB_PATH redirect (applyEnvOverrides, config.ts:167) is the seam the WHOLE suite's
// store isolation now rests on — vitest.setup.ts points it at a per-worker temp dir so no test can reach
// the operator's real evidence DB through a bare loadConfig(). Nothing falsified it before; a silent
// regression there would re-open the leak that put 14,434 junk rows in the dogfood DB, and the only
// signal would be the real-store guard tripping with no explanation. Both directions, and the precedence.
it("ZER0_DB_PATH overrides dbPath from ANY source — file, defaults — and its absence restores them", async () => {
  const configPath = await writeConfig(["blobRoot: .zer0/from-file", "dbPath: .zer0/from-file.db"]);

  expect(loadConfig(configPath).dbPath).toBe(".zer0/from-file.db");
  expect(loadConfig(join(tmpdir(), "zer0-config-absent.yaml")).dbPath).toBe(".zer0/evidence.db");

  const redirect = join(tmpdir(), "zer0-config-redirect", "evidence.db");
  process.env[DB_PATH_ENV] = redirect;
  // Beats the file's own explicit dbPath, not merely the default — isolation must hold in a checkout
  // whose config.yaml names a db, which is exactly where a "defaults only" override would silently fail.
  expect(loadConfig(configPath).dbPath).toBe(redirect);
  expect(loadConfig(join(tmpdir(), "zer0-config-absent.yaml")).dbPath).toBe(redirect);
  // Every OTHER field still comes from the file — the override is scoped to dbPath alone.
  expect(loadConfig(configPath).blobRoot).toBe(".zer0/from-file");
  expect((await loadConfigAsync(configPath)).dbPath).toBe(redirect);

  // An EMPTY value is not a redirect (config.ts:169 length check) — it must fall through to the file.
  process.env[DB_PATH_ENV] = "";
  expect(loadConfig(configPath).dbPath).toBe(".zer0/from-file.db");
});

async function writeConfig(lines: string[]): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  const configPath = join(tempRoot, "config.yaml");
  await writeFile(configPath, `${lines.join("\n")}\n`, "utf8");
  return configPath;
}
