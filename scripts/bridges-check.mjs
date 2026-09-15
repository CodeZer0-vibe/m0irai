#!/usr/bin/env node
/**
 * @file scripts/bridges-check.mjs
 * @purpose Answers "are the ACP bridges and their bundled CLIs the registry's latest?" as a number, not
 *   a memory. Compares the four DIRECT bridge pins in package-lock.json against each package's registry
 *   `latest` dist-tag and exits non-zero when any differs. Deliberately NOT in `npm run gates`: the gates
 *   are hermetic by rule and this one needs the registry (see package.json `bridges:check`).
 * @exports BRIDGE_PACKAGES, pinnedVersions, latestFromRegistry, checkBridges, formatTable, formatJson
 * @depends node:child_process, node:fs/promises, node:path, node:url, node:util
 *
 * WHY EXACT STRING COMPARISON RATHER THAN SEMVER ARITHMETIC: these four are pinned EXACTLY in
 * package.json (no caret, on purpose — the bundled claude/codex CLIs ride inside them and the model
 * picker is built from what those CLIs answer). For an exact pin, "equals the `latest` dist-tag" is the
 * whole question, so there is no range to evaluate and nothing to reimplement. `semver` is not a declared
 * dependency here and this script is not worth adding one for.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
// The working directory, matching gate-patches.mjs / patch-lifecycle.mjs: the npm script always runs
// from the repo root, and a cwd-relative root is what lets the CLI itself be driven against a fixture
// tree rather than only its own checkout.
const defaultRoot = () => process.cwd();

/** The DIRECT bridge pins. `@anthropic-ai/claude-agent-sdk` is deliberately absent: it is transitive and
 *  pinned EXACTLY by claude-agent-acp, so its version is that adapter's choice, not ours to bump. */
export const BRIDGE_PACKAGES = Object.freeze([
  "@agentclientprotocol/claude-agent-acp",
  "@agentclientprotocol/codex-acp",
  "@agentclientprotocol/sdk",
  "@openai/codex",
]);

const REGISTRY_TIMEOUT_MS = 60_000;

/**
 * The installed version of each package, read from the lockfile (never the registry, never
 * node_modules): the lockfile is what a fresh `npm ci` will actually install.
 *
 * @param root - repository root holding package-lock.json
 * @param packages - package names to read
 * @returns a Map of package name to installed version
 */
export async function pinnedVersions(root = defaultRoot(), packages = BRIDGE_PACKAGES) {
  const lockPath = join(root, "package-lock.json");
  let lock;
  try {
    lock = JSON.parse(await readFile(lockPath, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `bridges-check cannot read the lockfile at ${lockPath}: ${reason}. Run \`npm install\` in ${root} first.`,
      { cause: error },
    );
  }
  if (typeof lock.packages !== "object" || lock.packages === null) {
    throw new Error(
      `bridges-check found no "packages" map in ${lockPath} — it is not an npm v2+ lockfile. Regenerate it with \`npm install\`.`,
    );
  }
  const pinned = new Map();
  for (const name of packages) {
    const entry = lock.packages[`node_modules/${name}`];
    if (entry === undefined || typeof entry.version !== "string" || entry.version.length === 0) {
      throw new Error(
        `bridges-check found no installed version for ${name} at node_modules/${name} in ${lockPath}. It is a direct dependency, so it must resolve at the top level — run \`npm install\` and re-run.`,
      );
    }
    pinned.set(name, entry.version);
  }
  return pinned;
}

/**
 * The registry's `latest` dist-tag for one package. This is the NETWORK SEAM the sibling test replaces.
 *
 * @param name - package name
 * @returns the version string carried by the `latest` dist-tag
 */
export async function latestFromRegistry(name) {
  // VALIDATE BEFORE SPAWNING. On Windows npm is a `.cmd` shim, so the call goes through cmd.exe as
  // ONE command string (the pattern proven in package-zer0-v2-sidecar.mjs:195, `shell: false` so Node
  // never applies its own interpolation). That string is the only place a package name is not passed
  // as a separate argv entry, so the name is checked against the npm naming rules FIRST — today every
  // caller passes a frozen constant, and this guard is what keeps that true if a future caller does not.
  if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) {
    throw new Error(
      `bridges-check refuses to query "${name}": it is not a valid npm package name. Fix the caller — BRIDGE_PACKAGES is the only supported source.`,
    );
  }
  const windows = process.platform === "win32";
  const command = windows ? (process.env.ComSpec ?? "cmd.exe") : "npm";
  const args = windows
    ? ["/d", "/s", "/c", `npm view ${name} dist-tags.latest --json`]
    : ["view", name, "dist-tags.latest", "--json"];
  let stdout;
  try {
    ({ stdout } = await execFileAsync(command, args, {
      shell: false,
      timeout: REGISTRY_TIMEOUT_MS,
      windowsHide: true,
    }));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `bridges-check could not reach the npm registry for ${name}: ${reason}. This check needs network access — it is not part of \`npm run gates\` for that reason.`,
      { cause: error },
    );
  }
  const parsed = JSON.parse(stdout);
  if (typeof parsed !== "string" || parsed.length === 0) {
    throw new Error(
      `bridges-check got no "latest" dist-tag for ${name} (registry answered ${stdout.trim()}). Check the package name.`,
    );
  }
  return parsed;
}

/**
 * Compares every pin against the registry.
 *
 * @param options - root, package list, and the registry seam
 * @returns rows plus the count of stale pins
 */
export async function checkBridges({
  root = defaultRoot(),
  packages = BRIDGE_PACKAGES,
  fetchLatest = latestFromRegistry,
} = {}) {
  const pinned = await pinnedVersions(root, packages);
  const rows = [];
  for (const name of packages) {
    const installed = pinned.get(name);
    const latest = await fetchLatest(name);
    rows.push({ name, installed, latest, stale: installed !== latest });
  }
  return { rows, stale: rows.filter((row) => row.stale).length };
}

/** One aligned table; the stale column is the number the operator reads. */
export function formatTable({ rows, stale }) {
  const width = (pick) => Math.max(...rows.map((row) => pick(row).length));
  const nameWidth = Math.max(
    width((row) => row.name),
    "package".length,
  );
  const installedWidth = Math.max(
    width((row) => row.installed),
    "installed".length,
  );
  const latestWidth = Math.max(
    width((row) => row.latest),
    "latest".length,
  );
  const lines = [
    `${"package".padEnd(nameWidth)}  ${"installed".padEnd(installedWidth)}  ${"latest".padEnd(latestWidth)}  state`,
    `${"-".repeat(nameWidth)}  ${"-".repeat(installedWidth)}  ${"-".repeat(latestWidth)}  -----`,
  ];
  for (const row of rows) {
    lines.push(
      `${row.name.padEnd(nameWidth)}  ${row.installed.padEnd(installedWidth)}  ${row.latest.padEnd(latestWidth)}  ${row.stale ? "STALE" : "current"}`,
    );
  }
  lines.push(
    stale === 0
      ? "\nbridges-check: 0 stale — every ACP bridge pin is the registry's latest."
      : `\nbridges-check: ${String(stale)} STALE — bump the pins in package.json, re-port the patches, and re-run \`npm ci\`.`,
  );
  return lines.join("\n");
}

/** The same result for machines (the release lane reads this). */
export function formatJson(result) {
  return JSON.stringify(result, null, 2);
}

async function main() {
  const wantJson = process.argv.includes("--json");
  const result = await checkBridges();
  process.stdout.write(`${wantJson ? formatJson(result) : formatTable(result)}\n`);
  if (result.stale > 0) process.exitCode = 1;
}

const invokedPath =
  process.argv[1] === undefined ? "" : pathToFileURL(resolve(process.argv[1])).href;
if (import.meta.url === invokedPath || fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
