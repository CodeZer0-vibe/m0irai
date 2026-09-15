/**
 * @file src/chat/classify-intent-keywords.test.ts
 * @purpose Pins the classifier lexicon tables extracted from classify-intent.ts: the membership +
 *   regex contracts the classifier depends on. A drift here (a removed verb, a broken write-target
 *   regex) silently miswires intent classification — these assertions are the mechanical guard.
 * @exports (none)
 * @depends vitest, ./classify-intent-keywords
 */
import { describe, expect, it } from "vitest";
import {
  CREATE_KEYWORDS,
  DESTRUCTIVE_KEYWORDS,
  FIX_KEYWORDS,
  RESEARCH_KEYWORDS,
  RESEARCH_WRITE_PHRASES,
  RESEARCH_WRITE_TARGET,
  WRITE_KEYWORDS,
} from "./classify-intent-keywords.js";

describe("classify-intent keyword tables — membership contracts", () => {
  it("WRITE_KEYWORDS contains the core write verbs the router mirrors", () => {
    for (const verb of ["build", "implement", "fix", "edit", "change", "create", "refactor"]) {
      expect(WRITE_KEYWORDS).toContain(verb);
    }
  });
  it("FIX_KEYWORDS and CREATE_KEYWORDS are disjoint narrowings of WRITE_KEYWORDS", () => {
    for (const k of FIX_KEYWORDS) expect(WRITE_KEYWORDS).toContain(k);
    for (const k of CREATE_KEYWORDS) expect(WRITE_KEYWORDS).toContain(k);
    expect(FIX_KEYWORDS.some((k) => CREATE_KEYWORDS.includes(k))).toBe(false);
  });
  it("RESEARCH_KEYWORDS contains research + the multi-word 'look up'", () => {
    expect(RESEARCH_KEYWORDS).toContain("research");
    expect(RESEARCH_KEYWORDS).toContain("look up");
  });
});

describe("VESTIGE SWEEP S3 — DESTRUCTIVE_KEYWORDS is a disjoint subset of WRITE_KEYWORDS", () => {
  it("contains the operator-approved destructive verbs", () => {
    for (const verb of ["delete", "remove", "rm", "erase", "drop", "clean up"]) {
      expect(DESTRUCTIVE_KEYWORDS).toContain(verb);
    }
  });
  it("every destructive keyword is also a member of WRITE_KEYWORDS (the union)", () => {
    for (const k of DESTRUCTIVE_KEYWORDS) expect(WRITE_KEYWORDS).toContain(k);
  });
  it("is disjoint from FIX_KEYWORDS and CREATE_KEYWORDS (its own narrowing)", () => {
    expect(DESTRUCTIVE_KEYWORDS.some((k) => FIX_KEYWORDS.includes(k))).toBe(false);
    expect(DESTRUCTIVE_KEYWORDS.some((k) => CREATE_KEYWORDS.includes(k))).toBe(false);
  });
});

describe("RESEARCH_WRITE_TARGET regex — matches a persist verb + concrete file target", () => {
  it("matches a persist verb followed by a path", () => {
    expect(RESEARCH_WRITE_TARGET.test("research competitors and create docs/report.md")).toBe(true);
  });
  it("matches a persist verb followed by a name.ext filename", () => {
    expect(RESEARCH_WRITE_TARGET.test("write report.md")).toBe(true);
  });
  it("does NOT match a bare research ask with no persist target", () => {
    expect(RESEARCH_WRITE_TARGET.test("research the competitors in this space")).toBe(false);
  });
});

describe("RESEARCH_WRITE_PHRASES — explicit persist-to-disk tails", () => {
  it("includes the generic 'write to a file' / 'save to disk' tails", () => {
    expect(RESEARCH_WRITE_PHRASES).toContain("write to a file");
    expect(RESEARCH_WRITE_PHRASES).toContain("write to disk");
  });
});
