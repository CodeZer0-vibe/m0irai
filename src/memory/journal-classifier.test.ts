// J4 mechanical promotion: the category classifier places each named category shared-vs-per-agent by the
// rule "if another lane could make a wrong implementation choice without the fact, it is shared". Pure,
// table-driven — no DB.
import { describe, expect, it } from "vitest";
import {
  CATEGORY_PLACEMENT,
  type JournalCategory,
  classifyPlacement,
} from "./journal-classifier.js";

// The full J4 table: shared (a wrong choice is possible without it) vs per-agent (lane-local).
const CASES: ReadonlyArray<readonly [JournalCategory, "shared" | "per-agent"]> = [
  ["decision", "shared"],
  ["contract", "shared"],
  ["schema-change", "shared"],
  ["api-change", "shared"],
  ["verification", "shared"],
  ["anchor", "shared"],
  ["reasoning", "per-agent"],
  ["scratch", "per-agent"],
  ["summary", "per-agent"],
];

describe("journal-classifier: J4 mechanical promotion", () => {
  for (const [category, placement] of CASES) {
    it(`classifies ${category} as ${placement}`, () => {
      expect(classifyPlacement(category)).toBe(placement);
    });
  }

  it("the placement table covers every category exactly once (exhaustive)", () => {
    const keys = Object.keys(CATEGORY_PLACEMENT).sort();
    expect(keys).toEqual(CASES.map(([c]) => c).sort());
  });

  it("an unknown category defaults to per-agent (never leaks cross-lane by accident)", () => {
    expect(classifyPlacement("totally-unknown" as JournalCategory)).toBe("per-agent");
  });
});
