/**
 * @file src/chat/resolve-mode-targets.test.ts
 * @purpose Falsifiers for W4-4's target resolver against its pinned case table: committed single @agent
 *   prefix -> that agent only; committed @all -> all; committed multi-address -> exactly the addressed
 *   set; no committed address (incl. a mid-typed partial) -> all engines.
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./resolve-mode-targets
 */
import { describe, expect, it } from "vitest";
import { ALL_ENGINE_TARGETS, resolveModeTargets } from "./resolve-mode-targets.js";

describe("resolveModeTargets: the W4-4 pinned case table", () => {
  it("a committed single @agent prefix targets that agent only", () => {
    expect(resolveModeTargets("@codex fix the bug")).toEqual(["codex"]);
    expect(resolveModeTargets("@claude")).toEqual(["claude"]);
    expect(resolveModeTargets("@gemini research this")).toEqual(["gemini"]);
  });

  it("a committed @all targets every engine", () => {
    expect(resolveModeTargets("@all check this")).toEqual(ALL_ENGINE_TARGETS);
    expect(resolveModeTargets("@all")).toEqual(ALL_ENGINE_TARGETS);
  });

  it("a committed multi-address targets exactly the addressed set, in first-appearance order", () => {
    expect(resolveModeTargets("@claude plan, @codex build")).toEqual(["claude", "codex"]);
    expect(resolveModeTargets("@codex fix it, @claude review, @gemini write docs")).toEqual([
      "codex",
      "claude",
      "gemini",
    ]);
  });

  it("no committed address (empty or plain prose) targets every engine", () => {
    expect(resolveModeTargets("")).toEqual(ALL_ENGINE_TARGETS);
    expect(resolveModeTargets("   ")).toEqual(ALL_ENGINE_TARGETS);
    expect(resolveModeTargets("hello team, what's the status")).toEqual(ALL_ENGINE_TARGETS);
  });

  it("a mid-typed partial that matches no full tag targets every engine (not a menu-prefix match)", () => {
    expect(resolveModeTargets("@c")).toEqual(ALL_ENGINE_TARGETS);
    expect(resolveModeTargets("@co")).toEqual(ALL_ENGINE_TARGETS);
    expect(resolveModeTargets("@g")).toEqual(ALL_ENGINE_TARGETS);
  });

  it("a leading single @-prefix that is ALSO joined by a second @-tag resolves as multi (multi wins)", () => {
    // Mirrors parseInput's own precedence for a message that starts with an @agent prefix but names a
    // second agent later — the operator addressed both, so both cycle, not just the leading one.
    expect(resolveModeTargets("@claude do X then @codex do Y")).toEqual(["claude", "codex"]);
  });

  it("a code-shaped token (obj.gemini, gemini-cli) is never mistaken for an address", () => {
    expect(resolveModeTargets("call obj.gemini() please")).toEqual(ALL_ENGINE_TARGETS);
    expect(resolveModeTargets("using gemini-cli today")).toEqual(ALL_ENGINE_TARGETS);
  });
});
