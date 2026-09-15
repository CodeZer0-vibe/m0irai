/**
 * @file knip.config.js
 * @purpose Dead-code + unused-export detection config — strict anti-monolith gate. (The "principle 8" it once
 *          cited lives in docs/MODULE-MAP.md, now SUPERSEDED; the rules below are the live contract.)
 * @see https://knip.dev/reference/configuration
 *
 * Future-use exports are marked with `@public` JSDoc tag in source — knip recognizes the tag
 * natively and excludes them from unused-export reporting. Adding `@public` IS the contract:
 * it declares the symbol part of the cross-packet public API surface. (MODULE-MAP.md, the original
 * definition site, is SUPERSEDED — the `@public` tag itself is now the contract.)
 */

/** @type {import('knip').KnipConfig} */
const config = {
  entry: [
    "scripts/extract-codex-captures.mjs!",
    // digest-entry: the DETACHED digest entry the room close path forks per session (spawnDetachedDigest /
    // bootCatchUp) — never imported, invoked as a child process, so knip cannot infer it. It ships: the
    // production build compiles it beside digest-runner, which resolves it as its own sibling.
    "src/memory/digest-entry.ts!",
    "src/**/*.test.{ts,tsx}!",
    "src/**/__tests__/*.test.{ts,tsx}!",
  ],
  project: ["src/**/*.{ts,tsx}!", "scripts/**/*.{ts,mjs}!"],
  // The two ACP server adapters are spawned as JSON-RPC-stdio subprocesses (acp-servers.ts resolves their bin
  // via require.resolve), never `import`ed — so knip can't see the usage. They ARE runtime deps: the /model
  // picker's LIVE model-list source for claude + codex. (The ACP client `@agentclientprotocol/sdk` IS imported.)
  ignoreDependencies: [
    "@agentclientprotocol/claude-agent-acp",
    "@agentclientprotocol/codex-acp",
    // codex-acp resolves this CLI package dynamically; the root pin + override keep the spawned
    // provider version deterministic even though there is no static TypeScript import for Knip to see.
    "@openai/codex",
    // tsx is resolved by FILE PATH, not import: src/room/room-host-process.ts:16 loads
    // node_modules/tsx/dist/esm/index.mjs as the --import loader for the test-support source host
    // (and hands TSX_TSCONFIG_PATH down). A string path is invisible to knip, but deleting the
    // devDependency breaks every test that spawns the real host from source.
    "tsx",
  ],
  ignoreExportsUsedInFile: true,
  rules: {
    files: "error",
    dependencies: "error",
    devDependencies: "warn",
    unlisted: "error",
    binaries: "error",
    unresolved: "error",
    exports: "error",
    types: "error",
    duplicates: "warn",
  },
  vitest: {
    config: ["vitest.config.ts", "vite.config.ts"],
  },
};

export default config;
