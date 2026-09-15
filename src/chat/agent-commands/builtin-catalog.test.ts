/**
 * @file src/chat/agent-commands/builtin-catalog.test.ts
 * @purpose Pins the per-agent built-in sets: every entry is safe-named, described, kind "builtin", trusted; and
 *          the signature commands verified from each CLI binary are present (so a careless edit can't drop them).
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./builtin-catalog, ./types
 */
import { expect, it } from "vitest";
import { BUILTIN_COMMANDS } from "./builtin-catalog.js";
import { isSafeCommandName } from "./types.js";

const AGENTS = ["claude", "codex", "gemini"] as const;

it("every agent has a non-empty built-in set: safe names, described, kind builtin, trusted", () => {
  for (const agent of AGENTS) {
    const cmds = BUILTIN_COMMANDS[agent];
    expect(cmds.length).toBeGreaterThan(0);
    for (const c of cmds) {
      expect(isSafeCommandName(c.name)).toBe(true);
      expect(c.description.length).toBeGreaterThan(0);
      expect(c.kind).toBe("builtin");
      expect(c.trusted).toBe(true);
    }
  }
});

it("the binary-verified signature commands are present", () => {
  const names = (a: (typeof AGENTS)[number]): string[] => BUILTIN_COMMANDS[a].map((c) => c.name);
  expect(names("codex")).toEqual(expect.arrayContaining(["init", "diff", "compact"]));
  expect(names("gemini")).toEqual(expect.arrayContaining(["mcp", "tools", "model"]));
  expect(names("claude")).toEqual(expect.arrayContaining(["model", "compact"]));
});
