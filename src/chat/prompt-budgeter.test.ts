import { describe, expect, it } from "vitest";
import { delimitUntrusted } from "../memory/untrusted-framing.js";
import {
  CHAT_TOKEN_BUDGET,
  type PromptSection,
  budgetPromptSections,
  estimatePromptTokens,
} from "./prompt-budgeter.js";

// A frame is well-formed iff every BEGIN marker has a matching END marker — a mismatch proves
// trimSection's character-level slice separated one from the other (an orphaned marker).
function frameMarkersBalanced(text: string): boolean {
  const begins = (text.match(/<<<BEGIN UNTRUSTED RECALLED MEMORY/g) ?? []).length;
  const ends = (text.match(/<<<END UNTRUSTED RECALLED MEMORY>>>/g) ?? []).length;
  return begins === ends;
}

describe("budgetPromptSections", () => {
  it("keeps request and peers while trimming transcript content", () => {
    const sections: readonly PromptSection[] = [
      { key: "request", content: "# Current Request\n\nship it" },
      { key: "peers", content: "# Peers (this turn)\n\n## claude (ok)\n\n> peer text" },
      { key: "transcript", content: "transcript chunk ".repeat(20_000) },
    ];

    const prompt = budgetPromptSections(sections);

    expect(prompt).toContain("# Current Request");
    expect(prompt).toContain("# Peers (this turn)");
    expect(prompt).toContain("> peer text");
    expect(estimatePromptTokens(prompt)).toBeLessThanOrEqual(CHAT_TOKEN_BUDGET);
  });

  it("throws when must-keep sections exceed the hard budget", () => {
    const sections: readonly PromptSection[] = [
      { key: "request", content: "# Current Request\n\nsmall" },
      { key: "peers", content: "peer text ".repeat(30_000) },
    ];

    expect(() => budgetPromptSections(sections)).toThrow(
      /current request plus peer outputs.*exceeding budget 60000/,
    );
  });
});

// Split from the describe block above to stay under the per-function line gate — same file, same
// helpers; these falsify trimSection's frame-safety fix (BLOCK 2, codex sol MAX review round 1).
describe("budgetPromptSections — BLOCK 2: trimming a framed section is frame-safe, never an orphaned marker", () => {
  it("FALSIFIER: trimming a framed transcript section never leaves an orphaned frame marker", () => {
    const bigBody = "y".repeat(300_000); // forces trimSection to actually fire on this section
    const framed = delimitUntrusted(bigBody, "test-provenance");
    const sections: readonly PromptSection[] = [
      { key: "request", content: "# Current Request\n\nship it" },
      { key: "peers", content: "# Peers (this turn)\n\n## claude (ok)\n\n> peer text" },
      { key: "transcript", content: framed },
    ];

    const prompt = budgetPromptSections(sections);

    expect(frameMarkersBalanced(prompt)).toBe(true);
    expect(estimatePromptTokens(prompt)).toBeLessThanOrEqual(CHAT_TOKEN_BUDGET);
  });

  it("BLOCK 2 FALSIFIER: trimming a framed MEMORY section never leaves an orphaned frame marker (loadMemory's own delimitUntrusted output)", () => {
    const bigBody = "z".repeat(300_000);
    const framed = delimitUntrusted(bigBody, "project-ledger");
    const sections: readonly PromptSection[] = [
      { key: "request", content: "# Current Request\n\nship it" },
      { key: "peers", content: "" },
      { key: "memory", content: framed },
    ];

    const prompt = budgetPromptSections(sections);

    expect(frameMarkersBalanced(prompt)).toBe(true);
  });

  it("regression: a normal-size framed section is byte-identical to before this fix (no trim needed, nothing dropped)", () => {
    const framed = delimitUntrusted("stale: write hello.txt", "project-ledger");
    const sections: readonly PromptSection[] = [
      { key: "request", content: "# Current Request\n\nship it" },
      { key: "peers", content: "" },
      { key: "transcript", content: framed },
    ];

    const prompt = budgetPromptSections(sections);

    // FIX ROUND 2 NIT (codex sol MAX review round 2): EXACT string equality -- the label says
    // "byte-identical"; toContain + frameMarkersBalanced alone (the pre-round-2 version of this
    // test) could pass for a prompt that dropped or reordered sections around the framed content.
    // joinSections' own separator ("\n\n---\n\n") is reconstructed here, not imported, so this
    // assertion does not verify itself using budgetPromptSections' own internals.
    const SECTION_SEP = "\n\n---\n\n";
    const expected = ["# Current Request\n\nship it", "", framed].join(SECTION_SEP);
    expect(prompt).toBe(expected);
  });
});
