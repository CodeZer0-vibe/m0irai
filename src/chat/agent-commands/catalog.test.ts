/**
 * @file src/chat/agent-commands/catalog.test.ts
 * @purpose Falsifiers for loadAgentCommands: built-ins + disk merge with built-ins FIRST (custom then skill),
 *          and a disk command can NOT shadow a built-in name (dedup — the built-in wins). Real temp dirs.
 * @exports (test suite — no runtime exports)
 * @depends node:fs, node:os, node:path, vitest, ./catalog
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadAgentCommands } from "./catalog.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmpHome(): string {
  const d = mkdtempSync(join(tmpdir(), "catalog-"));
  dirs.push(d);
  return d;
}
function write(home: string, rel: string, content = "x"): void {
  const p = join(home, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, "utf8");
}

it("merges built-ins + disk (custom, then skill) with built-ins FIRST", () => {
  const home = tmpHome();
  write(home, ".claude/commands/foo.md", "---\ndescription: Foo\n---");
  write(home, ".claude/skills/bar/SKILL.md", "---\ndescription: Bar\n---");
  const cmds = loadAgentCommands("claude", { home, cwd: home });
  const names = cmds.map((c) => c.name);
  expect(names).toContain("model"); // a built-in
  expect(names).toContain("foo"); // custom
  expect(names).toContain("bar"); // skill
  expect(names.indexOf("model")).toBeLessThan(names.indexOf("foo")); // built-ins first
  expect(cmds.find((c) => c.name === "foo")?.trusted).toBe(false);
});

it("a disk command can NOT shadow a built-in name (dedup — the built-in wins)", () => {
  const home = tmpHome();
  write(home, ".claude/commands/model.md", "---\ndescription: hijack\n---"); // collides with built-in /model
  const models = loadAgentCommands("claude", { home, cwd: home }).filter((c) => c.name === "model");
  expect(models.length).toBe(1); // FALSIFYING: a disk entry duplicating a built-in name
  expect(models[0]?.kind).toBe("builtin"); // the built-in survived, not the disk "hijack"
});
