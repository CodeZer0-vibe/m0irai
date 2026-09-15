/**
 * @file src/chat/statusline-config.test.ts
 * @purpose Contract for the claude statusLine config: per-cwd paths are deterministic (so the launch
 *   that injects --settings and the post-turn reader never diverge), and the written --settings file's
 *   statusLine command references the emit script + the per-cwd payload path.
 * @depends vitest, node:fs, node:path, ./statusline-config
 */
import { readFileSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { claudeStatuslinePaths, writeClaudeStatuslineSettings } from "./statusline-config.js";

const written: string[] = [];
afterEach(() => {
  for (const file of written.splice(0)) {
    rmSync(file, { force: true });
  }
});

describe("claudeStatuslinePaths", () => {
  it("is deterministic per cwd and distinct across cwds", () => {
    const a1 = claudeStatuslinePaths("C:/repo/alpha");
    const a2 = claudeStatuslinePaths("C:/repo/alpha");
    const b = claudeStatuslinePaths("C:/repo/beta");
    expect(a1).toEqual(a2);
    expect(a1.payloadPath).not.toBe(b.payloadPath);
    expect(a1.settingsPath).not.toBe(a1.payloadPath);
  });
});

describe("writeClaudeStatuslineSettings", () => {
  it("writes a statusLine command referencing the emit script + the per-cwd payload path", () => {
    const cwd = `C:/repo/cfg-test-${process.pid}`;
    const paths = writeClaudeStatuslineSettings(cwd);
    written.push(paths.settingsPath);
    const settings = JSON.parse(readFileSync(paths.settingsPath, "utf8")) as {
      statusLine: { type: string; command: string };
    };
    expect(settings.statusLine.type).toBe("command");
    expect(settings.statusLine.command).toContain("statusline-emit.cjs");
    expect(settings.statusLine.command).toContain(paths.payloadPath);
  });
});
