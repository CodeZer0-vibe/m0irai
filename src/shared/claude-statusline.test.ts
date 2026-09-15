/**
 * @file src/shared/claude-statusline.test.ts
 * @purpose Falsifiers for the shared claude statusLine SSOT: per-cwd paths are deterministic + distinct, and the
 *   statusLine FRAGMENT (reused by BOTH the pty `--settings` writer and the ACP clean-config) points its command
 *   at the emit script + the SAME per-cwd payload the post-turn reader polls — so the two transports can never
 *   write a shape that drifts from what the reader reads.
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./claude-statusline
 */
import { describe, expect, it } from "vitest";
import {
  claudeStatuslinePaths,
  claudeStatuslineSetting,
  writeClaudeStatuslineSettings,
} from "./claude-statusline.js";

describe("claudeStatuslinePaths", () => {
  it("is deterministic per cwd and distinct across cwds", () => {
    const a1 = claudeStatuslinePaths("C:/repo/alpha");
    const a2 = claudeStatuslinePaths("C:/repo/alpha");
    const b = claudeStatuslinePaths("C:/repo/beta");
    expect(a1).toEqual(a2); // same cwd -> same paths (writer + reader never diverge)
    expect(a1.payloadPath).not.toBe(b.payloadPath); // different cwd -> different payload
    expect(a1.settingsPath).not.toBe(a1.payloadPath); // settings + payload are distinct files
  });
});

describe("claudeStatuslineSetting — the SSOT statusLine fragment", () => {
  it("points the command at the emit script + the per-cwd payload the reader polls", () => {
    const cwd = "C:/repo/gamma";
    const { statusLine } = claudeStatuslineSetting(cwd);
    expect(statusLine.type).toBe("command");
    expect(statusLine.command).toContain("statusline-emit.cjs");
    expect(statusLine.command).toContain(claudeStatuslinePaths(cwd).payloadPath);
  });

  it("is the SAME shape the pty `--settings` writer emits (single source of truth)", () => {
    const cwd = "C:/repo/delta";
    // The pty writer must serialize exactly the fragment claudeStatuslineSetting builds — a drift here would
    // mean the pty and ACP transports point claude at different payloads.
    const paths = writeClaudeStatuslineSettings(cwd);
    expect(paths).toEqual(claudeStatuslinePaths(cwd));
  });
});
