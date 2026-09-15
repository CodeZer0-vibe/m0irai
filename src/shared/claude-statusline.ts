/**
 * @file src/shared/claude-statusline.ts
 * @purpose SINGLE SOURCE for Claude's native-CLI statusLine: deterministic per-cwd payload/settings paths and
 *   the settings fragment (command -> emit script + per-cwd payload). The PTY path is the owning transport:
 *   it writes a `--settings` file (src/chat/statusline-config re-exports the writer). ACP reports usage directly;
 *   authentication remains in Claude's provider-owned store, with no mirrored config or credential file.
 *   Lives in shared because a feature-layer adapter may not import chat.
 * @exports ClaudeStatuslinePaths, ClaudeStatuslineSetting, claudeStatuslinePaths, claudeStatuslineSetting, writeClaudeStatuslineSettings
 * @depends node:crypto, node:fs, node:os, node:path, node:url
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// The emit script claude runs (stdin -> atomic write to argv[2]). It is co-located under src/chat with the two
// statusLine modules that invoke it (statusline-config for claude, agy-statusline-config for agy), so it stays
// there and is referenced here by a PATH STRING, never a module import — there is no shared->chat dependency edge
// (shared-foundation-isolation governs imports; this is only a runtime path to a sibling script).
const EMIT_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "chat",
  "statusline-emit.cjs",
);

/** The two cockpit-owned, per-cwd paths for the claude statusLine integration. */
export interface ClaudeStatuslinePaths {
  /** The `--settings` JSON the pty path injects at claude launch. */
  readonly settingsPath: string;
  /** Where statusline-emit.cjs writes the captured payload; the post-turn reader reads the same path. */
  readonly payloadPath: string;
}

/** The statusLine settings fragment the native Claude PTY reads from its injected `--settings` file. */
export interface ClaudeStatuslineSetting {
  readonly statusLine: { readonly type: "command"; readonly command: string };
}

/** Deterministic from `cwd` (same cwd -> same paths), so the launch and the reader never diverge. */
export function claudeStatuslinePaths(cwd: string): ClaudeStatuslinePaths {
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  const dir = statuslineBaseDir();
  return {
    settingsPath: join(dir, `claude-${hash}.settings.json`),
    payloadPath: join(dir, `claude-${hash}.json`),
  };
}

/** Builds the statusLine fragment whose command pipes claude's status payload to the per-cwd path. claude
 *  shell-parses the command, so the quoted absolute paths are correct. THE single construction — reused by the
 *  pty `--settings` writer and the ACP clean-config so a second, drifting shape is never hand-rolled. */
export function claudeStatuslineSetting(cwd: string): ClaudeStatuslineSetting {
  const { payloadPath } = claudeStatuslinePaths(cwd);
  const command = `node "${EMIT_SCRIPT}" "${payloadPath}"`;
  return { statusLine: { type: "command", command } };
}

function statuslineBaseDir(): string {
  const configured = process.env.ZER0_STATUSLINE_DIR;
  return configured !== undefined && configured.length > 0
    ? configured
    : join(tmpdir(), "zer0-statusline");
}

/** Writes the pty path's `--settings` file (statusLine -> emit script + per-cwd payload) and returns the paths. */
export function writeClaudeStatuslineSettings(cwd: string): ClaudeStatuslinePaths {
  const paths = claudeStatuslinePaths(cwd);
  mkdirSync(dirname(paths.settingsPath), { recursive: true });
  writeFileSync(paths.settingsPath, JSON.stringify(claudeStatuslineSetting(cwd), null, 2), "utf8");
  return paths;
}
