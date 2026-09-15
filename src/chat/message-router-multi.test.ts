/**
 * @file src/chat/message-router-multi.test.ts
 * @purpose Falsifying contract for parseMultiAddress (v2): detect which agents a message ADDRESSES and emit
 *          one segment per DISTINCT addressed agent, EACH carrying the FULL message (the team-aware agent
 *          does its own part). Addressed = @-tagged / clause-boundary / whitespace-run / and·then-joined to
 *          an already-accepted name. Casual mentions + code/path tokens are NOT — the trust-boundary guard.
 * @exports (test suite — no runtime exports)
 * @depends vitest, ../shared/agent-grant, ./message-router-multi
 */
import { describe, expect, it } from "vitest";
import { BUILD_GRANT, CHAT_GRANT, RESEARCH_GRANT } from "../shared/agent-grant.js";
import { parseMultiAddress } from "./message-router-multi.js";

describe("parseMultiAddress — detects addressed agents (each segment carries the full message)", () => {
  it("detects every @-tagged agent (the operator's '@claude @codex @gemini hello')", () => {
    const segments = parseMultiAddress("@claude @codex @gemini hello");
    expect(segments?.map((s) => s.agent)).toEqual(["claude", "codex", "gemini"]);
  });

  it("detects a bare whitespace-run of names ('hello codex claude gemini')", () => {
    const segments = parseMultiAddress("hello codex claude gemini");
    expect(segments?.map((s) => s.agent)).toEqual(["codex", "claude", "gemini"]);
  });

  it("detects names at clause boundaries in a delegation chain, in first-appearance order", () => {
    const segments = parseMultiAddress(
      "claude plan the api, codex audit it, gemini research the market",
    );
    expect(segments?.map((s) => s.agent)).toEqual(["claude", "codex", "gemini"]);
  });

  it("gives EACH addressed agent the FULL message as its prompt (it does its own part)", () => {
    const line = "claude plan the api, codex audit it";
    const segments = parseMultiAddress(line);
    expect(segments?.map((s) => s.prompt)).toEqual([line, line]);
  });

  it("dedupes a repeated name to ONE segment (distinct agents only)", () => {
    const segments = parseMultiAddress("claude plan it, then claude review it, codex build it");
    expect(segments?.map((s) => s.agent)).toEqual(["claude", "codex"]);
  });
});

describe("parseMultiAddress — and/then joins to an already-accepted name (the P1 fix)", () => {
  it("'claude and codex review X' addresses BOTH (claude is at the boundary, codex joins via 'and')", () => {
    expect(parseMultiAddress("claude and codex review X")?.map((s) => s.agent)).toEqual([
      "claude",
      "codex",
    ]);
  });

  it("'claude plan it then codex build it' addresses both via the 'then' connector", () => {
    expect(parseMultiAddress("claude plan it then codex build it")?.map((s) => s.agent)).toEqual([
      "claude",
      "codex",
    ]);
  });

  it("supports the @ prefix mixed with boundaries", () => {
    expect(parseMultiAddress("@claude plan it, @codex build it")?.map((s) => s.agent)).toEqual([
      "claude",
      "codex",
    ]);
  });
});

describe("parseMultiAddress — grant derives from the whole message's intent", () => {
  it("a build ask makes every segment build-mode", () => {
    const segments = parseMultiAddress("@claude @codex build the parser");
    expect(segments?.map((s) => s.grant)).toEqual([BUILD_GRANT, BUILD_GRANT]);
  });

  it("a research-led ask makes every segment research-mode", () => {
    const segments = parseMultiAddress("research the market, claude and gemini");
    expect(segments?.map((s) => s.grant)).toEqual([RESEARCH_GRANT, RESEARCH_GRANT]);
  });

  it("a plain conversational ask is read-only chat-mode", () => {
    const segments = parseMultiAddress("@claude @codex what do you think");
    expect(segments?.map((s) => s.grant)).toEqual([CHAT_GRANT, CHAT_GRANT]);
  });
});

describe("parseMultiAddress — write-capability requires an explicit @-tag (codex round-3/4 P0)", () => {
  it("grants build mode ONLY to the @-tagged agent (per-segment); bare names read-only", () => {
    const segments = parseMultiAddress("claude plan it, @codex implement it");
    expect(segments?.map((s) => s.agent)).toEqual(["claude", "codex"]);
    expect(segments?.map((s) => s.grant)).toEqual([CHAT_GRANT, BUILD_GRANT]);
  });

  it("grants build to every @-tagged agent, even mid-message", () => {
    const segments = parseMultiAddress("build the parser @claude @codex");
    expect(segments?.every((s) => s.grant === BUILD_GRANT)).toBe(true);
  });

  it("does NOT grant build for a BARE-name delegation with a write verb (must @ for write)", () => {
    const segments = parseMultiAddress("claude make a plan, codex write the audit");
    expect(segments?.map((s) => s.agent)).toEqual(["claude", "codex"]);
    expect(segments?.every((s) => s.grant === CHAT_GRANT)).toBe(true);
  });

  it("DOWNGRADES build→chat for pasted code, even when the first token is an agent name", () => {
    // codex round-4 repro: "claude = 1" leads with an agent name but is an assignment, not a command.
    expect(
      parseMultiAddress("claude = 1; codex = build(b)")?.every((s) => s.grant === CHAT_GRANT),
    ).toBe(true);
    expect(
      parseMultiAddress("let x=1; gemini write a; codex build b")?.every(
        (s) => s.grant === CHAT_GRANT,
      ),
    ).toBe(true);
  });

  it("DOWNGRADES build→chat for casual prose naming two models with a write verb", () => {
    const segments = parseMultiAddress("please write notes comparing claude gemini outputs");
    expect(segments?.every((s) => s.grant === CHAT_GRANT)).toBe(true);
  });

  it("does NOT treat a glued @ (email-like) as a write tag (codex round-5 P0)", () => {
    // "e@claude" is an email-ish token, not an @-address; the embedded @ must not authorize write.
    const segments = parseMultiAddress("e@claude codex build it");
    expect(segments?.some((s) => s.agent === "claude")).toBe(false);
    expect(segments?.every((s) => s.grant === CHAT_GRANT)).toBe(true);
  });
});

describe("VESTIGE SWEEP S3 — destructive verbs through the multi-address path", () => {
  it("an imperative destructive order grants build to every @-tagged agent", () => {
    const segments = parseMultiAddress("@claude @codex delete the old branches");
    expect(segments?.map((s) => s.agent)).toEqual(["claude", "codex"]);
    expect(segments?.every((s) => s.grant === BUILD_GRANT)).toBe(true);
  });

  it("explanatory framing about a destructive verb stays read-only for every segment (referee A-S3)", () => {
    const segments = parseMultiAddress("@claude @codex explain how to delete a branch");
    expect(segments?.map((s) => s.agent)).toEqual(["claude", "codex"]);
    expect(segments?.every((s) => s.grant === CHAT_GRANT)).toBe(true);
  });
});

describe("parseMultiAddress — dependency detection (dependsOn → parallel-vs-sequential waves)", () => {
  const dep = (line: string, a: string) =>
    parseMultiAddress(line)?.find((s) => s.agent === a)?.dependsOn;

  it("independent fresh tasks depend on nothing (they run in parallel)", () => {
    expect(dep("claude summarize the news, gemini research crypto", "claude")).toEqual([]);
    expect(dep("claude summarize the news, gemini research crypto", "gemini")).toEqual([]);
  });

  it("naming a teammate creates a dependency; an unrelated fresh task stays independent", () => {
    const line = "claude write a plan, codex review claude's plan, gemini research the market";
    expect(dep(line, "claude")).toEqual([]);
    expect(dep(line, "codex")).toEqual(["claude"]); // "review claude's plan" names claude
    expect(dep(line, "gemini")).toEqual([]); // fresh research — parallel with claude
  });

  it("a pronoun back-reference ('audit it') depends on the prior teammate", () => {
    expect(dep("claude make a plan, codex audit it, gemini research X", "codex")).toEqual([
      "claude",
    ]);
    expect(dep("claude make a plan, codex audit it, gemini research X", "gemini")).toEqual([]);
  });

  it("an explicit 'based on' sequence depends even without naming (typo-resilient)", () => {
    expect(dep("claude draft it, codex write an audit based on the plan", "codex")).toEqual([
      "claude",
    ]);
  });

  it("'then' sequences the next agent after the prior (codex waves P0)", () => {
    // The "then" lives in the GAP before codex, not in its clause — sequencing must still be detected.
    expect(dep("claude plan then codex build it", "codex")).toEqual(["claude"]);
  });

  it("non-'then' gap sequencing also depends ('once/when … done, codex …')", () => {
    expect(dep("claude plan, once claude is done, codex build it", "codex")).toEqual(["claude"]);
    expect(dep("claude draft, when claude is done, codex review", "codex")).toEqual(["claude"]);
  });

  it("'and' is a conjunction, NOT a dependency (both act independently)", () => {
    expect(dep("claude and codex brainstorm names", "codex")).toEqual([]);
  });
});

describe("parseMultiAddress — false-positive guard (casual + code/path mentions are NOT addresses)", () => {
  it("does NOT treat 'and' between two NON-addressed names as a join ('tell claude and gemini apart')", () => {
    expect(parseMultiAddress("tell claude and gemini apart")).toBeNull();
  });

  it("does NOT fire on a casual mid-clause mention", () => {
    expect(parseMultiAddress("what does claude think about this?")).toBeNull();
    expect(parseMultiAddress("ask claude what it thinks")).toBeNull();
  });

  it("does NOT fire on a code/path token (the build-from-pasted-code attack)", () => {
    expect(parseMultiAddress("gemini.write('src/x.ts')")).toBeNull();
    expect(parseMultiAddress("the bug is in src/gemini/adapter.ts")).toBeNull();
    expect(parseMultiAddress("run gemini-cli --help")).toBeNull();
  });

  it("does NOT fire on pasted property/optional-chaining code (codex P0 repro)", () => {
    // "obj." is a glued property access, not a clause boundary; "?." is optional chaining — neither is an
    // address. Both names are dropped, so this never becomes a write-capable multi-dispatch.
    expect(
      parseMultiAddress('const x = obj.gemini?.write("src/x.ts");\nobj.codex?.exec();'),
    ).toBeNull();
    expect(parseMultiAddress("config.codex.sandbox = 'read-only'")).toBeNull();
    expect(parseMultiAddress("gemini?.write('x')")).toBeNull();
  });

  it("does NOT fire on pasted MULTI-LINE code (newline is not a boundary — codex re-review P0)", () => {
    // Names leading lines inside a template/code paste would reopen the write-dispatch hole if newline were a
    // clause boundary. It is not: both names are dropped (no boundary/run/connector), so no multi-dispatch.
    expect(
      parseMultiAddress("const prompt = `\ngemini write src/x.ts\ncodex build src/y.ts\n`;"),
    ).toBeNull();
  });

  it("returns null when no agent name appears at all", () => {
    expect(parseMultiAddress("the build is broken and tests fail")).toBeNull();
    expect(parseMultiAddress("make a plan for the parser")).toBeNull();
    expect(parseMultiAddress("")).toBeNull();
  });
});
