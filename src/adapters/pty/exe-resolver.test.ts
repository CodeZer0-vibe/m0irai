/**
 * @file src/adapters/pty/exe-resolver.test.ts
 * @purpose Contract tests for resolveAgentLaunch (plan T1). assertNode22 tests live in node-guard.test.ts.
 * @depends vitest, node:fs, node:os, node:path
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAgentLaunch } from "./exe-resolver.js";

const REAL_APPDATA = process.env.APPDATA;
const REAL_PATH = process.env.PATH;
const roots: string[] = [];
afterEach(() => {
  process.env.APPDATA = REAL_APPDATA;
  process.env.PATH = REAL_PATH;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("resolveAgentLaunch", () => {
  it("RED: resolves Claude beside the active npm shim even when APPDATA points elsewhere", () => {
    const shimDir = fakeGlobalPackage("@anthropic-ai/claude-code", "bin/claude.exe");
    process.env.PATH = [shimDir, REAL_PATH].filter(Boolean).join(delimiter);
    process.env.APPDATA = join(shimDir, "missing-appdata");

    const spec = resolveAgentLaunch("claude");
    expect(spec.cmd).toBe(
      join(shimDir, "node_modules", "@anthropic-ai/claude-code", "bin/claude.exe"),
    );
    expect(existsSync(spec.cmd)).toBe(true);
    expect(spec.args).toEqual([]);
  });

  it("RED: resolves Codex beside the active npm shim without relying on a machine-global install", () => {
    const shimDir = fakeGlobalPackage("@openai/codex", "bin/codex.js");
    process.env.PATH = shimDir;
    process.env.APPDATA = join(shimDir, "missing-appdata");

    const spec = resolveAgentLaunch("codex");
    expect(spec.cmd).toBe(process.execPath);
    expect(spec.args[0]).toBe(join(shimDir, "node_modules", "@openai/codex", "bin/codex.js"));
    expect(existsSync(spec.args[0] ?? "")).toBe(true);
  });

  it("throws naming the attempted path when the launcher is absent (falsifying)", () => {
    const root = makeRoot("exe-resolver-missing-");
    process.env.PATH = root;
    process.env.APPDATA = root;
    expect(() => resolveAgentLaunch("claude")).toThrow(/claude\.exe/);
  });
});

function fakeGlobalPackage(packageName: string, relativeFile: string): string {
  const shimDir = makeRoot("exe-resolver-shim-");
  const file = join(shimDir, "node_modules", ...packageName.split("/"), ...relativeFile.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "fixture", "utf8");
  return shimDir;
}

function makeRoot(prefix: string): string {
  const root = join(tmpdir(), `${prefix}${String(Date.now())}-${String(roots.length)}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}
