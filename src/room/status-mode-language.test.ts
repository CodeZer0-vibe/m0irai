/**
 * @file src/room/status-mode-language.test.ts
 * @purpose R2a-2 vocabulary contract: every shipped mode id maps to one unified word (TOTALITY over MODE_CATALOG),
 *   the same behaviour renders the same word across engines, the mapping is injective per engine, words fit a
 *   narrow cell. (The reducer-applied live-catalog block left with the Ink cockpit reducer, m0irai 3.3.)
 * @exports (none)
 * @depends vitest, ../chat/native-mode, ../chat/types, ./status-mode-language
 */
import { describe, expect, it } from "vitest";
import { MODE_CATALOG } from "../chat/native-mode.js";
import type { AgentName } from "../chat/types.js";
import { MODE_WORDS, modeWord } from "./status-mode-language.js";

const ENGINES: readonly AgentName[] = ["claude", "codex", "gemini"];

// The full operator-facing vocabulary, derived from the shipped table itself (not retyped) — a word the
// mapper returns must be one of these.
const VOCABULARY: ReadonlySet<string> = new Set(
  ENGINES.flatMap((engine) => Object.values(MODE_WORDS[engine])),
);
// The JARGON the operator must never read in the bar: every native id that is not ALSO a legitimate
// unified word. (`plan` and `auto` are both — claude's `plan` id and the `plan` word are the same string
// by design, which is the mapping working, not leaking.) Sourced from the shipped catalogs, not typed out.
const JARGON_IDS: readonly string[] = ENGINES.flatMap((engine) =>
  [...MODE_CATALOG[engine]].filter((id) => !VOCABULARY.has(id)),
);

describe("R2a-2 TOTALITY: every shipped mode id maps to a unified word", () => {
  for (const engine of ENGINES) {
    it(`${engine}: every MODE_CATALOG id has a word`, () => {
      const catalog = MODE_CATALOG[engine];
      expect(catalog.length).toBeGreaterThan(0);
      for (const id of catalog) {
        const word = modeWord(engine, id);
        expect(word, `${engine}/${id} has no unified word`).toBeDefined();
        // ...and the word is always FROM the shared vocabulary — never vendor jargon, and never a slice
        // of the raw id (native-mode's modeToken falls back to `modeId.slice(0, 6)`, which leaks jargon
        // while looking like a display token; that is the exact failure this mapper replaces).
        expect(VOCABULARY.has(word as string), `${engine}/${id} -> ${String(word)}`).toBe(true);
        expect(JARGON_IDS).not.toContain(word);
      }
    });
  }
});

describe("R2a-2 ONE-BEHAVIOR-ONE-WORD: the operator's ban on 'different stuff'", () => {
  it("the SAME real behavior renders the SAME word across engines", () => {
    // full autonomy
    expect(modeWord("claude", "bypassPermissions")).toBe("auto");
    expect(modeWord("codex", "agent-full-access")).toBe("auto");
    expect(modeWord("gemini", "auto")).toBe("auto");
    // planning only, nothing executes
    expect(modeWord("claude", "plan")).toBe("plan");
    expect(modeWord("codex", "read-only")).toBe("plan");
    expect(modeWord("gemini", "plan")).toBe("plan");
    // asks before acting
    expect(modeWord("claude", "default")).toBe("careful");
    expect(modeWord("codex", "agent")).toBe("careful");
    // auto-accepts file edits
    expect(modeWord("claude", "acceptEdits")).toBe("edits");
    expect(modeWord("gemini", "accept-edits")).toBe("edits");
  });

  it("the pre-referee confusion is GONE: gemini accept-edits is `edits`, not `careful`", () => {
    // The banned shape: claude's acceptEdits and gemini's accept-edits are the SAME behavior and were
    // about to render as two different words.
    expect(modeWord("gemini", "accept-edits")).toBe(modeWord("claude", "acceptEdits"));
    expect(modeWord("gemini", "accept-edits")).not.toBe("careful");
  });

  it("one word NEVER covers two different behaviors (the mapping is injective per engine)", () => {
    for (const engine of ENGINES) {
      const words = [...MODE_CATALOG[engine]].map((id) => modeWord(engine, id));
      expect(new Set(words).size, `${engine} reuses a word for two behaviors`).toBe(words.length);
    }
  });

  it("an engine that LACKS a behavior simply never shows that word (no invented substitutes)", () => {
    // codex has no accept-edits-only stance; gemini has no ask-first / deny-by-default / classifier one.
    const codexWords = Object.values(MODE_WORDS.codex);
    expect(codexWords).not.toContain("edits");
    const geminiWords = Object.values(MODE_WORDS.gemini);
    expect(geminiWords).not.toContain("careful");
    expect(geminiWords).not.toContain("strict");
    expect(geminiWords).not.toContain("smart");
  });

  it("every word in the vocabulary is short enough for a narrow cell (<= 7 cols)", () => {
    for (const engine of ENGINES) {
      for (const word of Object.values(MODE_WORDS[engine])) {
        expect(word.length, `${word} is too wide for the 60-col budget`).toBeLessThanOrEqual(7);
      }
    }
  });
});
