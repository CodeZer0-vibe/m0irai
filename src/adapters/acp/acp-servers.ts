/**
 * @file src/adapters/acp/acp-servers.ts
 * @purpose Per-agent ACP server specs — how to spawn each agent's ACP adapter as a JSON-RPC-stdio subprocess.
 *   claude → @agentclientprotocol/claude-agent-acp; codex → @agentclientprotocol/codex-acp. The bin entry is
 *   resolved from node_modules (cwd-independent). The child env is subscription-first (INV-7: forward only
 *   non-auth vars, never a provider API key) and scrubs CLAUDECODE/CLAUDE_CODE_ENTRYPOINT so the claude
 *   adapter never trips its "cannot launch inside another Claude Code session" guard.
 * @exports AcpAgent, AcpServerSpec, ResolvedAcpSpec, acpAdapterBinding, acpServerSpec, bindingFromManifest, resolveAcpSpec
 * @depends node:fs, node:module, node:path, zod, ../../shared/child-env
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { z } from "zod";
import { childEnv } from "../../shared/child-env.js";

const require_ = createRequire(import.meta.url);

/** The agents whose model lists come over ACP (gemini stays on `agy models`; it has no ACP). */
export type AcpAgent = "claude" | "codex";

export interface AcpServerSpec {
  readonly agent: AcpAgent;
  readonly entry: string;
  readonly env: Record<string, string>;
}

const ACP_PACKAGE: Record<AcpAgent, string> = {
  claude: "@agentclientprotocol/claude-agent-acp",
  codex: "@agentclientprotocol/codex-acp",
};

// Subscription-first (INV-7): the ACP servers receive the SHARED childEnv allowlist (shared/child-env.ts)
// — non-auth process vars only, provider API keys deliberately absent, CODEX_HOME passthrough included
// (first-run wave: a locally-duplicated list here silently dropped it — the allowlist-drift class the
// shared import + the L5 no-duplicate-allowlist gate now prevent). CLAUDECODE / CLAUDE_CODE_ENTRYPOINT
// are dropped by allowlist semantics, so claude-agent-acp never refuses with "cannot launch inside
// another Claude Code session".

const BinSchema = z
  .object({
    bin: z.union([z.string(), z.record(z.string())]).optional(),
    version: z.string().optional(),
  })
  .passthrough();

/**
 * The INSTALLED bridge package's name + version — the I-2 binding components. Read from the resolved
 * package.json at call time (never a hardcoded constant: a stale constant keeps matching after a real
 * bridge bump, defeating exactly the F-2 invalidation the binding exists for).
 */
export function acpAdapterBinding(agent: AcpAgent): {
  readonly adapterPkg: string;
  readonly adapterVersion: string;
} {
  const pkg = ACP_PACKAGE[agent];
  const pkgJsonPath = require_.resolve(`${pkg}/package.json`);
  return bindingFromManifest(pkg, JSON.parse(readFileSync(pkgJsonPath, "utf8")));
}

/**
 * Decodes the binding from a parsed package manifest, FAILING CLOSED on a missing/empty version (retro
 * BLOCK-7): persisting a sentinel like "unknown" would match every other broken install forever — the
 * exact I-2/F-2 invalidation hole the version component exists to close. A manifest without a version
 * is a broken install; refuse to bind to it.
 */
export function bindingFromManifest(
  pkg: string,
  manifest: unknown,
): { readonly adapterPkg: string; readonly adapterVersion: string } {
  const { version } = BinSchema.parse(manifest);
  if (version === undefined || version.length === 0) {
    throw new Error(`ACP adapter ${pkg} manifest has no usable version — refusing an I-2 binding`);
  }
  return { adapterPkg: pkg, adapterVersion: version };
}

/**
 * Builds the spawn spec for one agent's ACP server.
 *
 * @param agent - claude or codex
 * @returns the resolved bin entry + the subscription-first child env
 */
export function acpServerSpec(agent: AcpAgent): AcpServerSpec {
  return { agent, entry: resolveServerEntry(ACP_PACKAGE[agent]), env: childEnv() };
}

/** A spawn spec + the I-2 binding, resolved from ONE package.json read (see resolveAcpSpec). */
export interface ResolvedAcpSpec extends AcpServerSpec {
  readonly binding: { readonly adapterPkg: string; readonly adapterVersion: string };
}

/**
 * Resolves entry + env + binding from a SINGLE package.json read (retro DECISION: two independent
 * reads let the binding check and the spawn disagree when node_modules changes between them). The
 * residual race — a mid-turn `npm install` between a TURN's binding check and its spawn — is a
 * designed boundary: the NEXT turn's F-2 invalidation catches it one turn late, as a visible failure.
 */
export function resolveAcpSpec(agent: AcpAgent): ResolvedAcpSpec {
  const pkg = ACP_PACKAGE[agent];
  const pkgJsonPath = require_.resolve(`${pkg}/package.json`);
  const manifest = BinSchema.parse(JSON.parse(readFileSync(pkgJsonPath, "utf8")));
  const rel =
    typeof manifest.bin === "string"
      ? manifest.bin
      : manifest.bin !== undefined
        ? Object.values(manifest.bin)[0]
        : undefined;
  if (rel === undefined) {
    throw new Error(`ACP adapter ${pkg} has no bin entry`);
  }
  return {
    agent,
    entry: path.join(path.dirname(pkgJsonPath), rel),
    env: childEnv(),
    binding: bindingFromManifest(pkg, manifest),
  };
}

// Resolve the adapter's executable entry (its package.json "bin") from node_modules, cwd-independent.
function resolveServerEntry(pkg: string): string {
  const pkgJsonPath = require_.resolve(`${pkg}/package.json`);
  const { bin } = BinSchema.parse(JSON.parse(readFileSync(pkgJsonPath, "utf8")));
  const rel = typeof bin === "string" ? bin : bin !== undefined ? Object.values(bin)[0] : undefined;
  if (rel === undefined) {
    throw new Error(`ACP adapter ${pkg} has no bin entry`);
  }
  return path.join(path.dirname(pkgJsonPath), rel);
}
