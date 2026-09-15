/**
 * @file src/chat/dispatch-headless.test.ts
 * @purpose Falsifying contract for the headless dispatch seam's intent→grant mapping (the gem, X0). A
 *          build-family route MUST map to BUILD_GRANT (worktree-write); a research route to RESEARCH_GRANT;
 *          every other plain ask to CHAT_GRANT. The falsifying assertion: a build intent must NEVER map to
 *          CHAT_GRANT (that would silently strip the worktree grant), and a plain ask must NEVER map to
 *          BUILD_GRANT (that would silently grant worktree writes to a plain turn).
 * @exports (test suite — no runtime exports)
 * @depends vitest, ../shared/agent-grant, ./dispatch-headless, ./types
 */
import { describe, expect, it } from "vitest";
import { BUILD_GRANT, CHAT_GRANT, RESEARCH_GRANT } from "../shared/agent-grant.js";
import { grantForRoute } from "./dispatch-headless.js";
import type { ChatIntent, ChatRoute, DispatchMode } from "./types.js";

function route(partial: Partial<ChatRoute>): ChatRoute {
  return {
    kind: "agent",
    agents: ["claude"],
    intent: "general",
    dispatchMode: "text-only",
    codexSandbox: "read-only",
    geminiMode: "review",
    ...partial,
  };
}

describe("grantForRoute: a pipeline route is build (write-capable)", () => {
  it("maps a pipeline dispatchMode to build regardless of intent", () => {
    expect(grantForRoute(route({ dispatchMode: "pipeline", intent: "general" }))).toBe(BUILD_GRANT);
  });
});

describe("grantForRoute: build-family intents are build", () => {
  const buildIntents: readonly ChatIntent[] = ["build", "create", "fix"];
  for (const intent of buildIntents) {
    it(`maps intent "${intent}" to build`, () => {
      expect(grantForRoute(route({ intent }))).toBe(BUILD_GRANT);
    });
  }
});

describe("grantForRoute: research intent is research", () => {
  it("maps a research intent to research", () => {
    expect(grantForRoute(route({ intent: "research", dispatchMode: "tools" }))).toBe(
      RESEARCH_GRANT,
    );
  });
});

describe("grantForRoute: every other ask is read-only chat", () => {
  const askIntents: readonly ChatIntent[] = ["general", "opinion", "audit"];
  for (const intent of askIntents) {
    it(`maps intent "${intent}" to chat`, () => {
      expect(grantForRoute(route({ intent }))).toBe(CHAT_GRANT);
    });
  }
});

describe("grantForRoute: the falsifying boundary (read/write grant must not leak)", () => {
  it("a build intent NEVER maps to chat (write grant must not be silently stripped)", () => {
    expect(grantForRoute(route({ intent: "build" }))).not.toBe(CHAT_GRANT);
  });

  it("a plain ask NEVER maps to build (a read-only turn must not be silently granted writes)", () => {
    const plain: DispatchMode = "text-only";
    expect(grantForRoute(route({ intent: "general", dispatchMode: plain }))).not.toBe(BUILD_GRANT);
  });
});
