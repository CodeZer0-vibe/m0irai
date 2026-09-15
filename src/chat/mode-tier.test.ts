/**
 * @file src/chat/mode-tier.test.ts
 * @purpose Falsifiers for D-4's tier derivation: tierOf matches each of the 3 anchor combinations
 *   exactly, reports "mixed" for anything else (including a single-agent tune breaking uniformity),
 *   ignores status entirely (modeId alone decides), nextTier cycles careful -> plan -> auto -> wraps,
 *   and seedUnifiedTier (tier-boot fix round 1) derives the boot-time lastUnifiedTier seed correctly.
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./mode-tier, ./native-mode
 */
import { describe, expect, it } from "vitest";
import { TIER_ANCHORS, TIER_ORDER, nextTier, seedUnifiedTier, tierOf } from "./mode-tier.js";
import { type NativeModeState, beginCycle, initialNativeModeState } from "./native-mode.js";

function stateAt(claude: string, codex: string, gemini: string): NativeModeState {
  return {
    claude: { modeId: claude, status: "active" },
    codex: { modeId: codex, status: "active" },
    gemini: { modeId: gemini, status: "active" },
  };
}

describe("mode-tier: TIER_ANCHORS — the operator-locked table (D-4)", () => {
  it("pins the exact per-engine native mode id for each of the 3 tiers", () => {
    expect(TIER_ANCHORS).toEqual({
      auto: { claude: "bypassPermissions", codex: "agent-full-access", gemini: "auto" },
      careful: { claude: "default", codex: "agent", gemini: "accept-edits" },
      plan: { claude: "plan", codex: "read-only", gemini: "plan" },
    });
  });
});

describe("mode-tier: tierOf — exact anchor match per tier", () => {
  it("matches 'auto' only when all 3 engines sit on auto's anchors", () => {
    expect(tierOf(stateAt("bypassPermissions", "agent-full-access", "auto"))).toBe("auto");
  });

  it("matches 'careful' only when all 3 engines sit on careful's anchors", () => {
    expect(tierOf(stateAt("default", "agent", "accept-edits"))).toBe("careful");
  });

  it("matches 'plan' only when all 3 engines sit on plan's anchors", () => {
    expect(tierOf(stateAt("plan", "read-only", "plan"))).toBe("plan");
  });
});

describe("mode-tier: tierOf — 'mixed' for anything that isn't an exact 3-way anchor match", () => {
  it("the boot state (each engine's own catalog[0]) is 'mixed' — no tier's anchors match it", () => {
    expect(tierOf(initialNativeModeState())).toBe("mixed");
  });

  it("a single-agent tune (2 of 3 engines still on a prior tier's anchors) reads 'mixed'", () => {
    // careful's anchors, but codex alone tuned off to something else.
    expect(tierOf(stateAt("default", "agent-full-access", "accept-edits"))).toBe("mixed");
  });

  it("two engines on one tier's anchors and the third on a DIFFERENT tier's anchor is still 'mixed'", () => {
    expect(tierOf(stateAt("plan", "read-only", "auto"))).toBe("mixed");
  });

  it("an engine on a non-anchor mode entirely (e.g. claude's own 'acceptEdits') is 'mixed'", () => {
    expect(tierOf(stateAt("acceptEdits", "agent", "accept-edits"))).toBe("mixed");
  });
});

describe("mode-tier: tierOf is STATUS-AGNOSTIC — only modeId decides, matching or not", () => {
  it("a PENDING engine whose modeId already matches an anchor still counts toward that tier", () => {
    const pending = beginCycle(stateAt("default", "agent", "accept-edits"), "gemini");
    // gemini cycles accept-edits -> plan (its own catalog's next entry) — no longer careful's anchor.
    expect(pending.gemini).toEqual({ modeId: "plan", status: "pending" });
    expect(tierOf(pending)).toBe("mixed");
  });

  it("all 3 engines PENDING but already sitting on a matching anchor combination still resolves that tier", () => {
    const allPending: NativeModeState = {
      claude: { modeId: "plan", status: "pending" },
      codex: { modeId: "read-only", status: "pending" },
      gemini: { modeId: "plan", status: "pending" },
    };
    expect(tierOf(allPending)).toBe("plan");
  });
});

describe("mode-tier: nextTier — the fixed cycle order, wrapping", () => {
  it("cycles careful -> plan -> auto -> careful (sourced from claude's own live catalog order)", () => {
    expect(TIER_ORDER).toEqual(["careful", "plan", "auto"]);
    expect(nextTier("careful")).toBe("plan");
    expect(nextTier("plan")).toBe("auto");
    expect(nextTier("auto")).toBe("careful");
  });
});

describe("mode-tier: seedUnifiedTier — the boot-time lastUnifiedTier seed (tier-boot fix round 1)", () => {
  it("a boot state ALREADY unified on a tier seeds that EXACT tier — 'plan'", () => {
    expect(seedUnifiedTier(stateAt("plan", "read-only", "plan"))).toBe("plan");
  });

  it("a boot state ALREADY unified on 'auto' seeds 'auto', not the mixed-fallback baseline", () => {
    expect(seedUnifiedTier(stateAt("bypassPermissions", "agent-full-access", "auto"))).toBe("auto");
  });

  it("a boot state ALREADY unified on 'careful' seeds 'careful'", () => {
    expect(seedUnifiedTier(stateAt("default", "agent", "accept-edits"))).toBe("careful");
  });

  it("a genuinely mixed boot (the catalog-default state every fresh install has today) falls back to 'auto'", () => {
    expect(tierOf(initialNativeModeState())).toBe("mixed"); // the premise this fallback exists for
    expect(seedUnifiedTier(initialNativeModeState())).toBe("auto");
  });

  it("the mixed-boot fallback ('auto') is chosen so the FIRST press lands on 'careful', never 'plan' or 'auto' itself", () => {
    const seeded = seedUnifiedTier(initialNativeModeState());
    expect(nextTier(seeded)).toBe("careful");
  });
});
