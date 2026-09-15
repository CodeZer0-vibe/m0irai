/**
 * @file src/chat/agent-commands/disk-sources.test.ts
 * @purpose Falsifiers for the HARDENED disk scanner: reads claude `.md` / gemini `.toml` custom commands +
 *          skills (`<dir>/SKILL.md`) with descriptions, all `trusted:false`; fail-soft on missing folders; and
 *          — security-load-bearing — SKIPS an unsafe-named file (the composer-injection guard) and a subdir
 *          with no SKILL.md. Driven against real temp dirs (injected home/cwd).
 * @exports (test suite — no runtime exports)
 * @depends node:fs, node:os, node:path, vitest, ./disk-sources
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadDiskCommands } from "./disk-sources.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpHome(): string {
  const d = mkdtempSync(join(tmpdir(), "disk-src-"));
  dirs.push(d);
  return d;
}
function write(home: string, rel: string, content = "x"): void {
  const p = join(home, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, "utf8");
}

it("reads claude .md custom commands with frontmatter descriptions (custom, untrusted)", () => {
  const home = tmpHome();
  write(home, ".claude/commands/review.md", "---\ndescription: Review the diff\n---\nbody");
  const review = loadDiskCommands("claude", { home, cwd: home }).find((c) => c.name === "review");
  expect(review?.kind).toBe("custom");
  expect(review?.trusted).toBe(false);
  expect(review?.description).toBe("Review the diff");
});

it("reads gemini .toml commands with the description field", () => {
  const home = tmpHome();
  write(home, ".gemini/commands/deploy.toml", 'description = "Ship it"\nprompt = "do"');
  expect(
    loadDiskCommands("gemini", { home, cwd: home }).find((c) => c.name === "deploy")?.description,
  ).toBe("Ship it");
});

it("reads skills (subdir + SKILL.md) as kind skill", () => {
  const home = tmpHome();
  write(home, ".claude/skills/refactor/SKILL.md", "---\ndescription: Refactor safely\n---");
  const sk = loadDiskCommands("claude", { home, cwd: home }).find((c) => c.name === "refactor");
  expect(sk?.kind).toBe("skill");
  expect(sk?.description).toBe("Refactor safely");
});

it("missing folders → [] for all agents (fail-soft, never throws)", () => {
  const home = tmpHome();
  expect(loadDiskCommands("claude", { home, cwd: home })).toEqual([]);
  expect(loadDiskCommands("codex", { home, cwd: home })).toEqual([]);
  expect(loadDiskCommands("gemini", { home, cwd: home })).toEqual([]);
});

it("SKIPS an unsafe-named command file (the injection guard) but keeps a safe sibling", () => {
  const home = tmpHome();
  write(home, ".claude/commands/bad name.md"); // space → unsafe → skipped
  write(home, ".claude/commands/good.md");
  const names = loadDiskCommands("claude", { home, cwd: home }).map((c) => c.name);
  expect(names).toContain("good");
  expect(names).not.toContain("bad name"); // FALSIFYING: an unfiltered name reaching the catalog
});

it("a subdir WITHOUT a SKILL.md is not a skill", () => {
  const home = tmpHome();
  mkdirSync(join(home, ".claude/skills/empty"), { recursive: true });
  expect(loadDiskCommands("claude", { home, cwd: home })).toEqual([]);
});

it("BOUNDS a flood directory — far more than MAX_ENTRIES files yields a capped result (codex P1 BLOCK)", () => {
  const home = tmpHome();
  const cwd = tmpHome(); // a SEPARATE (empty) project dir — the cap is per-directory
  for (let i = 0; i < 260; i += 1) {
    write(home, `.claude/commands/c${String(i)}.md`); // 260 safe-named files (> the 200 cap)
  }
  const custom = loadDiskCommands("claude", { home, cwd }).filter((c) => c.kind === "custom");
  // FALSIFYING an unbounded scan: the one flooded dir is capped, never the full 260.
  expect(custom.length).toBeLessThanOrEqual(200);
  expect(custom.length).toBeLessThan(260);
});

it("a missing description yields '' (no crash, never surfaces raw file content)", () => {
  const home = tmpHome();
  write(home, ".claude/commands/nodesc.md", "just a body, no frontmatter");
  expect(
    loadDiskCommands("claude", { home, cwd: home }).find((c) => c.name === "nodesc")?.description,
  ).toBe("");
});
