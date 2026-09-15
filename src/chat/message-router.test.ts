/**
 * @file src/chat/message-router.test.ts
 * @purpose Tests input parsing into routes (agent prefix, slash, keyword) and slash-exit detection.
 * @exports (none)
 * @depends vitest, ./message-router
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { isSlashExit, parseInput } from "./message-router.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseInput — empty and default", () => {
  it("routes empty input to the default agent with empty text", () => {
    const parsed = parseInput("   ", "claude");

    expect(parsed.text).toBe("");
    expect(parsed.route).toEqual({
      kind: "agent",
      agents: ["claude"],
      intent: "general",
      dispatchMode: "text-only",
      codexSandbox: "read-only",
      geminiMode: "review",
    });
  });

  it("routes plain non-keyword text to the default agent verbatim", () => {
    const parsed = parseInput("what is the weather", "gemini");

    expect(parsed.text).toBe("what is the weather");
    expect(parsed.route.kind).toBe("agent");
    expect(parsed.route.agents).toEqual(["gemini"]);
    expect(parsed.route.intent).toBe("general");
    expect(parsed.route.dispatchMode).toBe("text-only");
  });
});

describe("parseInput — @agent prefix", () => {
  it("routes a single named agent and strips the prefix from text", () => {
    const parsed = parseInput("@claude explain this code", "codex");

    expect(parsed.text).toBe("explain this code");
    expect(parsed.route.kind).toBe("agent");
    expect(parsed.route.agents).toEqual(["claude"]);
  });

  it("matches the @agent prefix case-insensitively", () => {
    const parsed = parseInput("@CODEX review the diff", "claude");

    expect(parsed.route.agents).toEqual(["codex"]);
    expect(parsed.text).toBe("review the diff");
    expect(parsed.route.intent).toBe("review");
  });

  it("fans @all out to all three agents in council mode", () => {
    const parsed = parseInput("@all what do you think", "claude");

    expect(parsed.route.kind).toBe("all");
    expect(parsed.route.agents).toEqual(["claude", "codex", "gemini"]);
  });

  it("forces codex read-only sandbox for a non-codex agent even with build keyword", () => {
    const parsed = parseInput("@claude build the parser", "codex");

    expect(parsed.route.agents).toEqual(["claude"]);
    expect(parsed.route.codexSandbox).toBe("read-only");
    expect(parsed.route.intent).toBe("build");
    expect(parsed.route.dispatchMode).toBe("pipeline");
  });

  it("grants codex workspace-write sandbox when the text starts with build", () => {
    const parsed = parseInput("@codex build the parser", "claude");

    expect(parsed.route.agents).toEqual(["codex"]);
    expect(parsed.route.codexSandbox).toBe("workspace-write");
  });

  it("keeps codex read-only when intent is non-build write keyword", () => {
    const parsed = parseInput("@codex fix the bug", "claude");

    expect(parsed.route.intent).toBe("fix");
    expect(parsed.route.codexSandbox).toBe("read-only");
  });
});

describe("parseInput — slash commands", () => {
  it("routes /status as a slash command with no agents", () => {
    const parsed = parseInput("/status", "claude");

    expect(parsed.route.kind).toBe("slash");
    expect(parsed.route.agents).toEqual([]);
    expect(parsed.route.slashCommand).toBe("status");
    expect(parsed.route.dispatchMode).toBe("text-only");
  });

  it("strips the slash command token from the remaining text", () => {
    const parsed = parseInput("/help me understand", "claude");

    expect(parsed.route.slashCommand).toBe("help");
    expect(parsed.text).toBe("me understand");
  });

  it("routes /council to all agents with the council slash command set", () => {
    const parsed = parseInput("/council design the schema", "claude");

    expect(parsed.route.kind).toBe("all");
    expect(parsed.route.agents).toEqual(["claude", "codex", "gemini"]);
    expect(parsed.route.slashCommand).toBe("council");
    expect(parsed.route.intent).toBe("plan");
    expect(parsed.text).toBe("design the schema");
  });

  it("routes /debate to all agents without build escalation", () => {
    const parsed = parseInput("/debate build the database writer", "claude");

    expect(parsed.route.kind).toBe("slash");
    expect(parsed.route.agents).toEqual(["claude", "codex", "gemini"]);
    expect(parsed.route.slashCommand).toBe("debate");
    expect(parsed.route.dispatchMode).toBe("text-only");
    expect(parsed.route.codexSandbox).toBe("read-only");
    expect(parsed.text).toBe("build the database writer");
  });
});

describe("parseInput - keyword routing", () => {
  it("routes a write-intent keyword to the default agent on the pipeline", () => {
    const parsed = parseInput("build a login form", "claude");

    expect(parsed.route.agents).toEqual(["claude"]);
    expect(parsed.route.dispatchMode).toBe("pipeline");
    expect(parsed.route.intent).toBe("build");
    expect(parsed.route.codexSandbox).toBe("read-only");
  });

  it("routes a fix keyword to the default agent with read-only sandbox and fix intent", () => {
    const parsed = parseInput("fix the broken test", "claude");

    expect(parsed.route.agents).toEqual(["claude"]);
    expect(parsed.route.intent).toBe("fix");
    expect(parsed.route.codexSandbox).toBe("read-only");
  });

  it("routes a research keyword to the default agent in tools mode", () => {
    const parsed = parseInput("research the latest react version", "claude");

    expect(parsed.route.agents).toEqual(["claude"]);
    expect(parsed.route.dispatchMode).toBe("tools");
    expect(parsed.route.intent).toBe("research");
  });

  it("matches multi-word research keywords by prefix", () => {
    const parsed = parseInput("look up the docs", "claude");

    expect(parsed.route.agents).toEqual(["claude"]);
    expect(parsed.route.intent).toBe("research");
  });

  it("routes a create keyword to the default agent with create intent", () => {
    const parsed = parseInput("create a new module", "claude");

    expect(parsed.route.agents).toEqual(["claude"]);
    expect(parsed.route.intent).toBe("create");
  });
});

// S-B (FIX WAVE Round A, 2026-07-18): routeByKeyword now defers to detectIntent, the same function
// @agent-prefix routing has always used — "build" is a CONSTRUCTIVE keyword, matched unconditionally
// by containsWriteVerb's own negation-blind design (message-router-intent.ts). This was already true
// for "@claude please do not build anything" before S-B; the fix makes the plain route consistent.
describe("parseInput - keyword routing - S-B negation-blind constructive match", () => {
  it("a constructive keyword mid-sentence, even negated ('do not build'), still classifies build", () => {
    const parsed = parseInput("please do not build anything", "claude");

    expect(parsed.route.agents).toEqual(["claude"]);
    expect(parsed.route.intent).toBe("build");
    expect(parsed.route.dispatchMode).toBe("pipeline");
  });
});
describe("parseInput — classified handoff (INV-1, INV-2)", () => {
  it("populates classified for a plain write message", () => {
    const parsed = parseInput("build a login form", "claude");

    expect(parsed.classified).toBeDefined();
    expect(parsed.classified?.mode).toBe("build");
  });

  it("populates classified for a plain debate-style message", () => {
    const parsed = parseInput("should we use postgres or sqlite", "claude");

    expect(parsed.classified?.mode).toBe("debate");
  });

  it("populates classified for a plain factual question as single", () => {
    const parsed = parseInput("what is the capital of France", "claude");

    expect(parsed.classified?.mode).toBe("single");
  });

  it("does NOT classify an explicit @agent message (explicit routing wins)", () => {
    const parsed = parseInput("@codex build the parser", "claude");

    expect(parsed.classified).toBeUndefined();
  });

  it("does NOT classify an explicit /command message (explicit routing wins)", () => {
    const parsed = parseInput("/debate the parser design", "claude");

    expect(parsed.classified).toBeUndefined();
  });

  // U1 (FIX WAVE Round A, 2026-07-18): /build and /dispatch are DELETED from message-router's
  // recognized slash set — "/build the parser" is no longer explicit-command routing at all; it falls
  // through to routeByKeyword like any plain message, so it DOES get classified now (the inverse of the
  // "explicit routing wins" cases above, which is exactly the point: there is no more explicit form to win).
  it("U1: '/build the parser' is no longer an explicit slash command — it classifies like plain text", () => {
    const parsed = parseInput("/build the parser", "claude");

    expect(parsed.route.kind).not.toBe("slash");
    expect(parsed.classified).toBeDefined();
    expect(parsed.classified?.mode).toBe("build");
  });

  it("does NOT classify @all even with a build keyword", () => {
    const parsed = parseInput("@all build the parser", "claude");

    expect(parsed.classified).toBeUndefined();
  });
});

describe("isSlashExit", () => {
  it("returns true for the exact /exit command ignoring case and surrounding whitespace", () => {
    expect(isSlashExit("/exit")).toBe(true);
    expect(isSlashExit("  /EXIT  ")).toBe(true);
  });

  it("returns false for /exit with trailing arguments and for other input", () => {
    expect(isSlashExit("/exit now")).toBe(false);
    expect(isSlashExit("/status")).toBe(false);
    expect(isSlashExit("exit")).toBe(false);
  });
});

describe("parseInput - explicit address authority (R1)", () => {
  it("keeps a leading @all authoritative even when the body names individual agents", () => {
    const parsed = parseInput("@all ok now codex check claude and gemini check codex", "claude");

    expect(parsed.route.kind).toBe("all");
    expect(parsed.route.agents).toEqual(["claude", "codex", "gemini"]);
    expect(parsed.segments).toBeUndefined();
  });

  it("keeps a leading @agent authoritative when the body mentions another agent", () => {
    const parsed = parseInput("@codex ask claude about the regression", "claude");

    expect(parsed.route.kind).toBe("agent");
    expect(parsed.route.agents).toEqual(["codex"]);
    expect(parsed.segments).toBeUndefined();
  });

  it("preserves explicit segment flow when multiple leading @agent segments are addressed", () => {
    const parsed = parseInput("@codex fix X then @claude review", "gemini");

    expect(parsed.route.kind).toBe("agent");
    expect(parsed.route.agents).toEqual(["codex", "claude"]);
    expect(parsed.segments?.map((segment) => segment.agent)).toEqual(["codex", "claude"]);
  });

  it("keeps /council authoritative even when body names could form segments", () => {
    const parsed = parseInput("/council ok now codex check claude", "claude");

    expect(parsed.route.kind).toBe("all");
    expect(parsed.route.agents).toEqual(["claude", "codex", "gemini"]);
    expect(parsed.segments).toBeUndefined();
  });
});

describe("parseInput - explicit leading @all beats later @tags", () => {
  it("routes @all with later @agent tags to all three, not segments", () => {
    const parsed = parseInput("@all @codex check it and @claude review it", "gemini");

    expect(parsed.route.kind).toBe("all");
    expect(parsed.route.agents).toEqual(["claude", "codex", "gemini"]);
    expect(parsed.segments).toBeUndefined();
  });
});

describe("VESTIGE SWEEP S3 — destructive verbs route BUILD across every route shape", () => {
  it("plain keyword route: 'delete the files' → pipeline (the brief's own literal example)", () => {
    const parsed = parseInput("delete the files", "claude");

    expect(parsed.route.dispatchMode).toBe("pipeline");
    expect(parsed.route.intent).toBe("build");
    expect(parsed.route.agents).toEqual(["claude"]);
  });

  it("@agent prefix route: '@gemini delete the branch' → pipeline for gemini alone", () => {
    const parsed = parseInput("@gemini delete the branch", "claude");

    expect(parsed.route.kind).toBe("agent");
    expect(parsed.route.agents).toEqual(["gemini"]);
    expect(parsed.route.dispatchMode).toBe("pipeline");
    expect(parsed.route.intent).toBe("build");
  });

  it("@all route: '@all clean up the temp branches' → pipeline for the whole council", () => {
    const parsed = parseInput("@all clean up the temp branches", "claude");

    expect(parsed.route.kind).toBe("all");
    expect(parsed.route.agents).toEqual(["claude", "codex", "gemini"]);
    expect(parsed.route.dispatchMode).toBe("pipeline");
  });

  it("/council route: '/council remove the deprecated module' → pipeline for the whole council", () => {
    const parsed = parseInput("/council remove the deprecated module", "claude");

    expect(parsed.route.kind).toBe("all");
    expect(parsed.route.slashCommand).toBe("council");
    expect(parsed.route.dispatchMode).toBe("pipeline");
  });

  // S-B (FIX WAVE Round A, 2026-07-18 = sweep#2/contracts#1): the plain-keyword route ignored
  // detectIntent()/containsWriteVerb() and only matched a write keyword as the FIRST word — so this
  // exact case classified as pipeline/build in message-router-intent.test.ts's own falsifier but
  // stayed text-only in the real live route. This is the integration proof the fix must hold.
  it("plain keyword route: 'please delete the old branch' (MID-sentence, no explanatory lead) → pipeline/build", () => {
    const parsed = parseInput("please delete the old branch", "claude");

    expect(parsed.route.dispatchMode).toBe("pipeline");
    expect(parsed.route.intent).toBe("build");
    expect(parsed.route.agents).toEqual(["claude"]);
  });
});

describe("VESTIGE SWEEP S3 — explanatory destructive framing never reaches BUILD", () => {
  it("@agent prefix route: explanatory framing stays read-only, never pipeline (referee A-S3 CONCERN)", () => {
    const parsed = parseInput("@gemini explain how to delete a branch", "claude");

    expect(parsed.route.kind).toBe("agent");
    expect(parsed.route.agents).toEqual(["gemini"]);
    expect(parsed.route.intent).toBe("general");
    expect(parsed.route.dispatchMode).toBe("text-only");
  });

  it("plain keyword route: a bare question about a destructive verb stays read-only", () => {
    const parsed = parseInput("what happens if I drop this table", "claude");

    expect(parsed.route.dispatchMode).toBe("text-only");
    expect(parsed.route.intent).toBe("general");
  });
});
