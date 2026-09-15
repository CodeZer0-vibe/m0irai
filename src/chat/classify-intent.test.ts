/**
 * @file src/chat/classify-intent.test.ts
 * @purpose Tests the pure, deterministic intent classifier: mode mapping,
 *          ambiguous→read-only safety (AC-3), determinism (AC-6), and AC-1 table coverage.
 * @exports (none)
 * @depends vitest, ./classify-intent, ./types
 */
import { describe, expect, it } from "vitest";
import { classify } from "./classify-intent.js";
import type { ChatMode } from "./types.js";

describe("classify — AC-1 table-driven mode classification", () => {
  const cases: ReadonlyArray<{ message: string; mode: ChatMode }> = [
    { message: "what do you all think of GraphQL", mode: "all" },
    { message: "what does everyone think about rust", mode: "all" },
    { message: "should we use postgres or sqlite", mode: "debate" },
    { message: "sqlite vs postgres for this workload", mode: "debate" },
    { message: "decide between redis and memcached", mode: "debate" },
    { message: "what is the tradeoff of monorepo here", mode: "debate" },
    { message: "research the competitors in this space", mode: "research" },
    { message: "research the market for ai code tools", mode: "research" },
    { message: "what is your opinion on rust vs go?", mode: "all" },
    { message: "build a login form", mode: "build" },
    { message: "implement the auth middleware", mode: "build" },
    { message: "add a login form to the app", mode: "build" },
    { message: "what is the capital of France", mode: "single" },
  ];

  it.each(cases)("classifies %j to the expected mode", ({ message, mode }) => {
    expect(classify(message).mode).toBe(mode);
  });
});

describe("classify — AC-3 ambiguous input is read-only, never build", () => {
  const ambiguous: readonly string[] = [
    "hmm",
    "ok",
    "the thing we talked about",
    "not sure about that",
    "tell me more",
    "",
    "   ",
  ];

  it.each(ambiguous)("never returns build for ambiguous input %j", (message) => {
    const result = classify(message);

    expect(result.mode).not.toBe("build");
  });

  it("defaults a narrow factual question to single (read-only)", () => {
    const result = classify("the thing we talked about");

    expect(result.mode).toBe("single");
  });

  it("does not escalate a write keyword that appears mid-sentence to build", () => {
    const result = classify("please do not build anything yet");

    expect(result.mode).not.toBe("build");
  });
});

describe("classify — plural audience maps to all (read-only)", () => {
  it("routes a plural 'everyone' question to all", () => {
    const result = classify("everyone, what is your opinion");

    expect(result.mode).toBe("all");
  });

  it("keeps a singular factual question as single, not all", () => {
    const result = classify("what does the spec say about retries");

    expect(result.mode).toBe("single");
  });

  it("routes a SINGULAR opinion request to all (AC-1 opinions→all)", () => {
    const result = classify("what is your opinion on rust vs go?");

    expect(result.mode).toBe("all");
  });

  it("routes 'your thoughts on X' to all even without a plural audience", () => {
    const result = classify("your thoughts on adopting effect-ts here");

    expect(result.mode).toBe("all");
  });
});

describe("classify — AC-6 determinism", () => {
  const messages: readonly string[] = [
    "build a login form",
    "should we use postgres or sqlite",
    "research the competitors",
    "what do you all think",
    "what is the capital of France",
    "please do not build anything yet",
  ];

  it.each(messages)("returns an identical ClassifiedIntent for %j on repeat calls", (message) => {
    const first = classify(message);
    const second = classify(message);

    expect(second).toEqual(first);
  });

  it("does not depend on call order across different messages", () => {
    const buildFirst = classify("build a login form");
    classify("research the market");
    const buildAgain = classify("build a login form");

    expect(buildAgain).toEqual(buildFirst);
  });
});

describe("classify — reason is populated and non-empty (INV-6)", () => {
  it("attaches a non-empty reason to every classification", () => {
    for (const message of ["build a thing", "sqlite vs postgres", "what do you all think", "hi"]) {
      expect(classify(message).reason.length).toBeGreaterThan(0);
    }
  });
});
