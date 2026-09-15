/**
 * @file src/chat/message-router-intent.test.ts
 * @purpose Pins the intent-from-text helpers extracted from message-router.ts: first-word-anchored
 *   keyword matching, the ChatIntent / DispatchMode / sandbox mappings. These are pure functions the
 *   router composes; a drift here silently miswires routing — these assertions are the mechanical guard.
 * @exports (none)
 * @depends vitest, ./message-router-intent
 */
import { describe, expect, it } from "vitest";
import { WRITE_KEYWORDS } from "./classify-intent-keywords.js";
import {
  DESTRUCTIVE_KEYWORDS,
  WRITE_INTENT_KEYWORDS,
  containsWriteVerb,
  detectIntent,
  detectSandbox,
  detectWriteIntent,
  dispatchModeForIntent,
  firstWordOf,
  matchesKeyword,
} from "./message-router-intent.js";

describe("firstWordOf — the keyword anchor", () => {
  it("returns the first alphanumeric word, lower-cased (callers pass trimmed text)", () => {
    expect(firstWordOf("Build the parser")).toBe("build");
    expect(firstWordOf("research X")).toBe("research");
  });
  it("strips trailing punctuation on the first word", () => {
    expect(firstWordOf("research, the market")).toBe("research");
  });
  it("returns empty for whitespace/punctuation-only input", () => {
    expect(firstWordOf("   ")).toBe("");
  });
});

describe("matchesKeyword — single word anchors on first word; multi-word on prefix", () => {
  it("matches a single keyword only as the FIRST word", () => {
    expect(matchesKeyword("build a form", ["build"])).toBe(true);
    expect(matchesKeyword("please do not build", ["build"])).toBe(false);
  });
  it("matches a multi-word keyword by prefix", () => {
    expect(matchesKeyword("look up the docs", ["look up"])).toBe(true);
  });
});

describe("detectIntent — maps a plain message to a ChatIntent", () => {
  it("a leading write verb → build/fix/create", () => {
    expect(detectIntent("build the API")).toBe("build");
    expect(detectIntent("fix the bug")).toBe("fix");
    expect(detectIntent("create a module")).toBe("create");
  });
  it("a research keyword → research; review/audit/plan first words map accordingly", () => {
    expect(detectIntent("research the market")).toBe("research");
    expect(detectIntent("review the diff")).toBe("review");
    expect(detectIntent("audit the auth")).toBe("audit");
    expect(detectIntent("plan the schema")).toBe("plan");
  });
  it("no signal → general", () => {
    expect(detectIntent("the thing we discussed")).toBe("general");
  });
  it("a write verb MID-sentence is a write task (the operator's natural phrasing)", () => {
    // The failing case: "can you research the internet and write a smoke test md file" began with "can",
    // so the first-word anchor missed it → read-only → the agents could not write. A write verb anywhere
    // now classifies it as a write task so the agents act on it.
    expect(detectIntent("can you research the internet and write a smoke test md file")).toBe(
      "build",
    );
    expect(detectIntent("please add a hello.txt with the text yes")).toBe("build");
    // a pure question with no write verb stays general (no false write grant for "what does X do?").
    expect(detectIntent("what does the parser do here")).toBe("general");
  });
});

describe("detectWriteIntent / dispatchModeForIntent / detectSandbox", () => {
  it("narrows a write message to fix/create/build", () => {
    expect(detectWriteIntent("fix it")).toBe("fix");
    expect(detectWriteIntent("scaffold it")).toBe("create");
    expect(detectWriteIntent("build it")).toBe("build");
  });
  it("maps intent → dispatch mode", () => {
    expect(dispatchModeForIntent("build")).toBe("pipeline");
    expect(dispatchModeForIntent("research")).toBe("tools");
    expect(dispatchModeForIntent("general")).toBe("text-only");
  });
  it("grants workspace-write only when the text leads with build", () => {
    expect(detectSandbox("build the worker")).toBe("workspace-write");
    expect(detectSandbox("fix the worker")).toBe("read-only");
  });
});

describe("VESTIGE SWEEP S3 — SSOT collapse: WRITE_INTENT_KEYWORDS is classify-intent's WRITE_KEYWORDS", () => {
  it("is the exact same array the classifier lexicon exports (one definition site)", () => {
    expect(WRITE_INTENT_KEYWORDS).toBe(WRITE_KEYWORDS);
  });
  it("closes the referee-proven mirror gap: refactor/scaffold/generate/repair/debug now reach detectIntent", () => {
    // Before the collapse, message-router's local table lacked these five entirely — a first-word
    // "repair"/"debug"/"scaffold"/"generate" message fell through to general (read-only) even though
    // detectWriteIntent's own FIX_KEYWORDS/CREATE_KEYWORDS narrowing already knew how to classify them.
    expect(detectIntent("repair the login bug")).toBe("fix");
    expect(detectIntent("debug the login flow")).toBe("fix");
    expect(detectIntent("scaffold the new module")).toBe("create");
    expect(detectIntent("generate the client stub")).toBe("create");
    expect(detectIntent("refactor the auth module")).toBe("build");
  });
  it("closes the same mirror gap for RESEARCH_KEYWORDS: 'investigate' now reaches research", () => {
    expect(detectIntent("investigate the outage")).toBe("research");
  });
});

describe("VESTIGE SWEEP S3 — destructive verbs classify as write-intent (imperative)", () => {
  it("a leading destructive verb → build (matchesKeyword, first-word-anchored)", () => {
    for (const verb of DESTRUCTIVE_KEYWORDS) {
      expect(detectIntent(`${verb} the old branch`)).toBe("build");
    }
  });
  it("'delete the files' routes build (the brief's own literal acceptance example)", () => {
    expect(detectIntent("delete the files")).toBe("build");
    expect(dispatchModeForIntent(detectIntent("delete the files"))).toBe("pipeline");
  });
  it("a destructive verb MID-sentence with no explanatory lead is still a write task (containsWriteVerb)", () => {
    expect(containsWriteVerb("please delete the old branch")).toBe(true);
    expect(containsWriteVerb("once you're done, remove the temp files")).toBe(true);
    expect(detectIntent("please delete the old branch")).toBe("build");
  });
});

describe("VESTIGE SWEEP S3 — explanatory framing does NOT grant write-intent from a destructive verb", () => {
  it("'explain how to delete X' stays general, never build (referee A-S3 CONCERN)", () => {
    expect(containsWriteVerb("explain how to delete a branch")).toBe(false);
    expect(detectIntent("explain how to delete a branch")).toBe("general");
    expect(dispatchModeForIntent(detectIntent("explain how to delete a branch"))).toBe("text-only");
  });
  it("other interrogative leads (how/what/why/is/can) also suppress the destructive-anywhere match", () => {
    expect(containsWriteVerb("how do I remove a git remote")).toBe(false);
    expect(containsWriteVerb("what happens if I drop this table")).toBe(false);
    expect(containsWriteVerb("why would you erase that log")).toBe(false);
    expect(containsWriteVerb("is it safe to clean up the cache")).toBe(false);
    expect(containsWriteVerb("can you delete the temp branch")).toBe(false); // polite-imperative
    // ambiguity — deliberately erred toward the safe read-only fallback (see containsWriteVerb's doc comment).
  });
  it("a short filler before the explanatory lead does not defeat the guard (first-3-words window)", () => {
    expect(containsWriteVerb("well, how do I delete a branch")).toBe(false);
  });
  it("constructive verbs are UNCHANGED — still unconditional anywhere-match, no explanatory guard", () => {
    expect(containsWriteVerb("explain how to build a login form")).toBe(true); // pre-existing behavior
    expect(containsWriteVerb("can you write a smoke test")).toBe(true); // pre-existing behavior
  });
});
