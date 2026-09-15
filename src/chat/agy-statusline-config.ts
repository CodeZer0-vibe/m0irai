/**
 * @file src/chat/agy-statusline-config.ts
 * @purpose Configure agy's (Antigravity CLI) statusLine to emit its usage payload — the agy analogue of
 *   statusline-config. UNLIKE claude (per-launch `--settings`), agy reads its statusLine from the GLOBAL
 *   `~/.gemini/antigravity-cli/settings.json`, so the cockpit MERGES the key in once, preserving every
 *   other key (trustedWorkspaces / general.defaultApprovalMode); a non-object settings file is REFUSED, never
 *   clobbered. agy splits the command WITHOUT a shell, so the path is UNQUOTED + ASSERTED whitespace-free (a
 *   space would silently break it). Reuses the generic statusline-emit.cjs; agy-statusline-payload parses it.
 * @exports AgyStatuslinePaths, agyStatuslinePaths, writeAgyStatuslineSettings, assertNoWhitespace
 * @depends node:fs, node:os, node:path, node:process, node:url
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** The generic emit script claude already uses (stdin -> atomic write to argv[2]); reused verbatim for agy. */
const EMIT_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "statusline-emit.cjs");

/** agy's GLOBAL settings file (account-wide; NOT per-cwd) — where its statusLine key lives. */
function defaultAgySettingsPath(): string {
  return join(homedir(), ".gemini", "antigravity-cli", "settings.json");
}

/** The cockpit-owned agy statusLine paths. agy's settings are GLOBAL, so a single shared payload path. */
export interface AgyStatuslinePaths {
  readonly settingsPath: string;
  readonly payloadPath: string;
  readonly emitScriptPath: string;
}

export interface AgyStatuslineWriteOptions {
  /** Test-only seam for a deterministic operator-edit race immediately before compare-and-swap. */
  readonly beforeCommit?: () => void;
}

interface SettingsSnapshot {
  readonly raw?: string;
  readonly value: Record<string, unknown>;
}

interface SettingsLock {
  readonly path: string;
  readonly raw: string;
}

const SETTINGS_LOCK_TTL_MS = 30_000;

/** Resolves the agy statusLine paths. `settingsPath` is injectable for tests (defaults to the global file). */
export function agyStatuslinePaths(
  settingsPath: string = defaultAgySettingsPath(),
): AgyStatuslinePaths {
  const base = statuslineBaseDir();
  return {
    settingsPath,
    payloadPath: join(base, "agy.json"),
    emitScriptPath: join(base, "statusline-emit.cjs"),
  };
}

function statuslineBaseDir(): string {
  const configured = process.env.ZER0_STATUSLINE_DIR;
  return configured !== undefined && configured.length > 0
    ? configured
    : join(tmpdir(), "zer0-statusline");
}

/**
 * MERGES a statusLine command into agy's settings.json, preserving every other key. Idempotent. THROWS rather
 * than do harm (the caller logs + leaves the cell blank): (B1) a whitespace path — agy splits its command with
 * no shell, so a space silently breaks the statusLine; (B2) an existing settings file that is not a JSON
 * object — overwriting it would clobber the operator's trustedWorkspaces/approvalMode. Writes atomically.
 */
export function writeAgyStatuslineSettings(
  settingsPath: string = defaultAgySettingsPath(),
  options: AgyStatuslineWriteOptions = {},
): AgyStatuslinePaths {
  const paths = agyStatuslinePaths(settingsPath);
  // B1 (codex): agy splits the command on spaces WITHOUT a shell, so a whitespace path mis-parses and the
  // statusLine silently never fires. Fail loudly instead of writing a broken command.
  assertNoWhitespace(paths.emitScriptPath, "agy statusLine staged emit-script path");
  assertNoWhitespace(paths.payloadPath, "agy statusLine payload path");
  const command = `node ${paths.emitScriptPath} ${paths.payloadPath}`;
  mkdirSync(dirname(paths.payloadPath), { recursive: true });
  mkdirSync(dirname(paths.settingsPath), { recursive: true });
  const lock = acquireSettingsLock(paths.settingsPath);
  try {
    const snapshot = readSettings(paths.settingsPath);
    if (
      snapshot.value.statusLine !== undefined &&
      !isOwnedStatusLine(snapshot.value.statusLine, command)
    ) {
      throw new Error(
        "agy already has a non-Zer0 statusLine; refusing to overwrite the operator's integration.",
      );
    }
    const merged = {
      ...snapshot.value,
      statusLine: { type: "command", command, enabled: true },
    };
    writeAtomic(paths.emitScriptPath, readFileSync(EMIT_SCRIPT, "utf8"));
    options.beforeCommit?.();
    assertSettingsUnchanged(paths.settingsPath, snapshot.raw);
    writeAtomic(paths.settingsPath, `${JSON.stringify(merged, null, 2)}\n`);
    return paths;
  } finally {
    releaseSettingsLock(lock);
  }
}

function isOwnedStatusLine(value: unknown, expectedCommand: string): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== "command" || candidate.enabled !== true) return false;
  if (candidate.command === expectedCommand) return true;
  if (typeof candidate.command !== "string") return false;
  // Migrate older Zer0 installs that pointed at the source emitter, but never
  // take ownership of an unrelated operator command.
  return /^node\s+\S*statusline-emit\.cjs\s+\S*zer0-statusline[\\/]agy\.json$/iu.test(
    candidate.command,
  );
}

/** B1: agy's no-shell command split means a whitespace path silently breaks; refuse to write one. */
export function assertNoWhitespace(value: string, label: string): void {
  if (/\s/.test(value)) {
    throw new Error(
      `${label} contains whitespace ("${value}"); agy splits its statusLine command without a shell, so agy usage capture is disabled until this path is whitespace-free.`,
    );
  }
}

/** Atomic write (temp + rename) so a crash mid-write never leaves the operator's global settings truncated. */
function writeAtomic(target: string, content: string): void {
  const tmp = `${target}.zer0-${String(process.pid)}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, target);
}

/**
 * Reads agy's existing settings for the merge. B2 (codex): NEVER clobber the operator's global config — a
 * MISSING file → {} (safe to write fresh); an EXISTING file that does not parse to a JSON OBJECT (malformed /
 * array / scalar) → THROW, so writeAgyStatuslineSettings refuses to overwrite trustedWorkspaces/etc with a
 * bare {statusLine}. The caller (ensureAgyStatusline in cockpit-boot) logs the reason + leaves the cell blank.
 */
function readSettings(settingsPath: string): SettingsSnapshot {
  let raw: string;
  try {
    raw = readFileSync(settingsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { value: {} };
    throw error;
  }
  const parsed: unknown = JSON.parse(raw); // malformed EXISTING file → throws → caller must not overwrite it
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `agy settings at ${settingsPath} is not a JSON object; refusing to overwrite it.`,
    );
  }
  return { raw, value: parsed as Record<string, unknown> };
}

function assertSettingsUnchanged(settingsPath: string, expected: string | undefined): void {
  let current: string | undefined;
  try {
    current = readFileSync(settingsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (current !== expected) {
    throw new Error("agy settings changed during Zer0 configuration; refusing a stale overwrite.");
  }
}

function acquireSettingsLock(settingsPath: string): SettingsLock {
  const path = `${settingsPath}.zer0.lock`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = JSON.stringify({
      token: randomUUID(),
      pid: process.pid,
      expiresAt: Date.now() + SETTINGS_LOCK_TTL_MS,
    });
    try {
      writeFileSync(path, raw, { encoding: "utf8", flag: "wx" });
      return { path, raw };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt === 0 && reclaimExpiredSettingsLock(path)) continue;
      throw new Error(
        "agy settings are being configured by another Zer0 process; try again shortly.",
      );
    }
  }
  throw new Error("agy settings lock could not be acquired");
}

function reclaimExpiredSettingsLock(path: string): boolean {
  try {
    const observed = readFileSync(path, "utf8");
    const parsed = JSON.parse(observed) as { readonly expiresAt?: unknown };
    if (typeof parsed.expiresAt !== "number" || parsed.expiresAt > Date.now()) return false;
    if (readFileSync(path, "utf8") !== observed) return false;
    rmSync(path);
    return true;
  } catch {
    return false;
  }
}

function releaseSettingsLock(lock: SettingsLock): void {
  try {
    if (readFileSync(lock.path, "utf8") === lock.raw) rmSync(lock.path);
  } catch {
    // A vanished/replaced lock is not ours to remove, and must not mask the settings result.
  }
}
