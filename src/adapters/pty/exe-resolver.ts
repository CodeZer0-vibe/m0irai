/**
 * @file src/adapters/pty/exe-resolver.ts
 * @purpose Resolve the real launchable binary + base args for each agent CLI behind its npm shim,
 *   so node-pty can spawn it directly (it cannot launch the npm `.cmd` shim — CreateProcess error 2).
 * @exports resolveAgentLaunch, AgentLaunchSpec, PtyAgent
 * @depends node:fs, node:path
 */
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export type PtyAgent = "claude" | "codex";

export interface AgentLaunchSpec {
  /** A real binary node-pty can spawn (never an npm `.cmd`/`.ps1` shim). */
  readonly cmd: string;
  /** Base args invoking the CLI (the bundle `.js` for node-launched agents); session flags are added by the caller. */
  readonly args: readonly string[];
}

function requirePackageFile(agent: string, segments: readonly string[]): string {
  const candidates = npmModulesDirs().map((root) => join(root, ...segments));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found !== undefined) return found;
  throw new Error(
    `exe-resolver: ${agent} launcher not found at ${candidates.map((path) => `"${path}"`).join(" or ")}.`,
  );
}

function npmModulesDirs(): readonly string[] {
  const pathRoots = (process.env.PATH ?? "")
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/gu, ""))
    .filter(Boolean)
    .map((entry) => join(entry, "node_modules"));
  const appData = process.env.APPDATA;
  const fallback =
    appData === undefined || appData === "" ? [] : [join(appData, "npm", "node_modules")];
  return [...new Set([...pathRoots, ...fallback])];
}

/**
 * How to spawn `agent` as a persistent interactive CLI. claude ships a native `.exe`; codex is a Node
 * bundle spawned via the current node executable + its `.js`. gemini is intentionally NOT a PtyAgent —
 * the gemini chair runs through the agy/Antigravity lane (@google/gemini-cli was retired, Google -32000).
 */
export function resolveAgentLaunch(agent: PtyAgent): AgentLaunchSpec {
  switch (agent) {
    case "claude":
      return {
        cmd: requirePackageFile(agent, ["@anthropic-ai", "claude-code", "bin", "claude.exe"]),
        args: [],
      };
    case "codex":
      return {
        cmd: process.execPath,
        args: [requirePackageFile(agent, ["@openai", "codex", "bin", "codex.js"])],
      };
    default: {
      const unreachable: never = agent;
      throw new Error(`exe-resolver: unsupported agent "${String(unreachable)}".`);
    }
  }
}
