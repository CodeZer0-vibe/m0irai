/**
 * @file src/adapters/acp/acp-servers.test.ts
 * @purpose Falsifiers for the ACP server specs: each agent resolves to its installed adapter bin, the
 *   child env is subscription-first (INV-7), and the I-2 binding source resolves the REAL installed
 *   version — failing CLOSED on a missing/empty manifest version (retro BLOCK-7: a persisted "unknown"
 *   is forever-matchable and defeats the F-2 invalidation the binding exists for).
 * @exports (test suite — no runtime exports)
 * @depends vitest, node:fs, node:module, ./acp-servers
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { acpAdapterBinding, acpServerSpec, bindingFromManifest } from "./acp-servers.js";

const require_ = createRequire(import.meta.url);

it("resolves the claude adapter bin + a subscription-first env (no API key, no CLAUDECODE)", () => {
  const spec = acpServerSpec("claude");
  expect(spec.agent).toBe("claude");
  expect(spec.entry).toMatch(/claude-agent-acp[\\/].*\.js$/);
  expect(spec.env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(spec.env.OPENAI_API_KEY).toBeUndefined();
  expect(spec.env.CLAUDECODE).toBeUndefined();
});

it("resolves the codex adapter bin", () => {
  const spec = acpServerSpec("codex");
  expect(spec.agent).toBe("codex");
  expect(spec.entry).toMatch(/codex-acp[\\/].*\.js$/);
  const codexAcpRequire = createRequire(
    require_.resolve("@agentclientprotocol/codex-acp/package.json"),
  );
  const codexPackage = JSON.parse(
    readFileSync(codexAcpRequire.resolve("@openai/codex/package.json"), "utf8"),
  ) as { version?: string };
  expect(codexPackage.version).toBe("0.153.4");
});

it("forwards PATH so the spawned adapter can find its sibling CLI", () => {
  const spec = acpServerSpec("codex");
  // At least one of PATH/Path is forwarded (the adapter shells out to its CLI).
  expect(spec.env.PATH ?? spec.env.Path).toBeDefined();
});

it("acpAdapterBinding resolves the REAL installed bridge versions (non-empty, matches disk)", () => {
  for (const [agent, pkg] of [
    ["claude", "@agentclientprotocol/claude-agent-acp"],
    ["codex", "@agentclientprotocol/codex-acp"],
  ] as const) {
    const onDisk = JSON.parse(readFileSync(require_.resolve(`${pkg}/package.json`), "utf8")) as {
      version?: string;
    };
    const binding = acpAdapterBinding(agent);
    expect(binding.adapterPkg).toBe(pkg);
    expect(binding.adapterVersion).toBe(onDisk.version);
    expect((binding.adapterVersion ?? "").length).toBeGreaterThan(0);
  }
});

it("bindingFromManifest FAILS CLOSED on a missing/empty version — never a matchable 'unknown' (retro BLOCK-7)", () => {
  expect(() => bindingFromManifest("some-pkg", {})).toThrow(/version/i);
  expect(() => bindingFromManifest("some-pkg", { version: "" })).toThrow(/version/i);
  expect(bindingFromManifest("some-pkg", { version: "2.3.4" })).toEqual({
    adapterPkg: "some-pkg",
    adapterVersion: "2.3.4",
  });
});

// First-run wave (sol review BLOCK): the ACP server env previously came from a LOCALLY-duplicated
// allowlist that dropped the CODEX_HOME passthrough — live codex ACP cells escaped test-home isolation
// and wrote trust entries into the operator's real ~/.codex. The spec env must ride the SHARED
// allowlist: CODEX_HOME present exactly when the parent set it (G8 pins the structural half).
it("acpServerSpec env passes CODEX_HOME through when set and omits it when unset", () => {
  const prior = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = "C:/tmp/isolated-home";
    expect(acpServerSpec("codex").env.CODEX_HOME).toBe("C:/tmp/isolated-home");
    delete process.env.CODEX_HOME;
    expect(acpServerSpec("codex").env.CODEX_HOME).toBeUndefined();
  } finally {
    if (prior === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = prior;
    }
  }
});
