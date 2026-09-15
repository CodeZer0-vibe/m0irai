/**
 * @file src/shared/agent-grant.test.ts
 * @purpose Falsifying contract for the adapter-owned capability grant (X0). dispatchModeToGrant bridges the
 *   build-pillar DispatchMode onto an AgentGrant byte-for-byte; the named constants pin the three work-turn
 *   grants. This is the SSOT the adapter argv-matrix oracle (src/adapters/argv-matrix.test.ts) leans on.
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./agent-grant
 */
import { describe, expect, it } from "vitest";
import { BUILD_GRANT, CHAT_GRANT, RESEARCH_GRANT, dispatchModeToGrant } from "./agent-grant.js";

describe("dispatchModeToGrant — DispatchMode → AgentGrant bridge", () => {
  it("maps undefined to undefined (the read-only review turn: no grant)", () => {
    expect(dispatchModeToGrant(undefined)).toBeUndefined();
  });

  it("maps 'chat' to a plain write grant (no research, no worktree)", () => {
    expect(dispatchModeToGrant("chat")).toEqual({ research: false, worktree: false });
  });

  it("maps 'research' to a research grant (research true, no worktree)", () => {
    expect(dispatchModeToGrant("research")).toEqual({ research: true, worktree: false });
  });

  it("maps 'build' to a worktree grant (no research, worktree true)", () => {
    expect(dispatchModeToGrant("build")).toEqual({ research: false, worktree: true });
  });

  it("agrees with the named constants for every defined mode", () => {
    expect(dispatchModeToGrant("chat")).toEqual(CHAT_GRANT);
    expect(dispatchModeToGrant("research")).toEqual(RESEARCH_GRANT);
    expect(dispatchModeToGrant("build")).toEqual(BUILD_GRANT);
  });
});

describe("the named grant constants pin the three work-turn shapes", () => {
  it("CHAT_GRANT is the plain write turn (chat === build for claude/codex; the difference is worktree)", () => {
    expect(CHAT_GRANT).toEqual({ research: false, worktree: false });
  });

  it("RESEARCH_GRANT carries the research affordance only", () => {
    expect(RESEARCH_GRANT).toEqual({ research: true, worktree: false });
  });

  it("BUILD_GRANT carries the worktree affordance only", () => {
    expect(BUILD_GRANT).toEqual({ research: false, worktree: true });
  });
});
