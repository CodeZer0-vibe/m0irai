// memory-flags: the master ZER0_MEMORY / ZER0_NATIVE_RESUME switches (debug-mode truthiness convention)
// and the briefing budget with the enforced minimum (anchor pool + floors + pulls cap). Real env
// mutation, restored per case; no mocks.
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError } from "../shared/errors.js";
import {
  DEFAULT_MEMORY_BRIEFING_BUDGET,
  MEMORY_BRIEFING_MINIMUM_TOTAL,
  carrierEnabled,
  memoryEnabled,
  nativeResumeEnabled,
  resolveMemoryBriefingBudget,
} from "./memory-flags.js";

const MEMORY_ENV = "ZER0_MEMORY";
const RESUME_ENV = "ZER0_NATIVE_RESUME";

afterEach(() => {
  delete process.env[MEMORY_ENV];
  delete process.env[RESUME_ENV];
});

// The SAME falsy sentinels as the debug switch (src/shared/debug-mode.ts), case/whitespace-insensitive.
const OFF_CASES = ["", "0", "false", "no", "off", "FALSE", " 0 ", "No", " OFF "];
const ON_CASES = ["1", "true", "on", "yes", "enabled", " on "];

describe("memory-flags: master switch truthiness", () => {
  it("ZER0_MEMORY unset reads ON (B2a-1: flipped on-by-default, opt-OUT)", () => {
    delete process.env[MEMORY_ENV];
    expect(memoryEnabled()).toBe(true);
  });

  for (const value of OFF_CASES) {
    it(`ZER0_MEMORY=${JSON.stringify(value)} reads OFF`, () => {
      process.env[MEMORY_ENV] = value;
      expect(memoryEnabled()).toBe(false);
    });
  }

  for (const value of ON_CASES) {
    it(`ZER0_MEMORY=${JSON.stringify(value)} reads ON`, () => {
      process.env[MEMORY_ENV] = value;
      expect(memoryEnabled()).toBe(true);
    });
  }

  it("ZER0_NATIVE_RESUME defaults ON (post-smoke 2026-07-10); falsy sentinels still disable", () => {
    delete process.env[RESUME_ENV];
    expect(nativeResumeEnabled()).toBe(true); // the operator smoke gate passed — default flipped
    process.env[RESUME_ENV] = "OFF";
    expect(nativeResumeEnabled()).toBe(false);
    process.env[RESUME_ENV] = " 0 ";
    expect(nativeResumeEnabled()).toBe(false);
    process.env[RESUME_ENV] = "on";
    expect(nativeResumeEnabled()).toBe(true);
  });
});

// MT7 I-6: the carrier gate COMPOSES the master switch — resume-on with memory-off is INERT (spec B1:
// ZER0_MEMORY=off must never migrate or engage anything, regardless of the resume flag).
describe("memory-flags: carrierEnabled composed gate (MT7 I-6)", () => {
  it("off (explicit =0) × off → false", () => {
    process.env[MEMORY_ENV] = "0"; // B2a-1: memory is on-by-default; the both-off leg needs the sentinel
    process.env[RESUME_ENV] = "0";
    expect(carrierEnabled()).toBe(false);
  });

  it("both unset (fresh boot) → true (B2a-1: default-ON memory × default-ON resume engages the carrier)", () => {
    delete process.env[MEMORY_ENV];
    delete process.env[RESUME_ENV];
    expect(carrierEnabled()).toBe(true);
  });

  it("memory ON × resume EXPLICITLY off → false (the operator can always opt out of the carrier)", () => {
    process.env[MEMORY_ENV] = "1";
    process.env[RESUME_ENV] = "0"; // resume defaults ON post-smoke — the off leg needs the sentinel
    expect(carrierEnabled()).toBe(false);
  });

  it("memory ON × resume unset → true (resume defaults ON post-smoke 2026-07-10)", () => {
    process.env[MEMORY_ENV] = "1";
    delete process.env[RESUME_ENV];
    expect(carrierEnabled()).toBe(true);
  });

  it("memory EXPLICITLY off × resume ON → false (the AC5 hole the skeptic closed: never engage without the master)", () => {
    process.env[MEMORY_ENV] = "0"; // B2a-1: opt-out is now the only way to reach the memory-off master gate
    process.env[RESUME_ENV] = "1";
    expect(carrierEnabled()).toBe(false);
  });

  it("memory ON × resume ON → true (the only engaging combination)", () => {
    process.env[MEMORY_ENV] = "1";
    process.env[RESUME_ENV] = "1";
    expect(carrierEnabled()).toBe(true);
  });
});

describe("memory-flags: briefing budget minimum", () => {
  it("the default budget matches R2's closed arithmetic (300 + 400*3 + 400 = 1900 <= 2000)", () => {
    expect(DEFAULT_MEMORY_BRIEFING_BUDGET.total).toBe(2000);
    expect(DEFAULT_MEMORY_BRIEFING_BUDGET.anchorPool).toBe(300);
    expect(DEFAULT_MEMORY_BRIEFING_BUDGET.coreFloor).toBe(400);
    expect(DEFAULT_MEMORY_BRIEFING_BUDGET.mapFloor).toBe(400);
    expect(DEFAULT_MEMORY_BRIEFING_BUDGET.ownJournalFloor).toBe(400);
    expect(DEFAULT_MEMORY_BRIEFING_BUDGET.pullsCap).toBe(400);
    expect(MEMORY_BRIEFING_MINIMUM_TOTAL).toBe(1900);
  });

  it("the default config resolves without error", () => {
    expect(() => resolveMemoryBriefingBudget()).not.toThrow();
    expect(resolveMemoryBriefingBudget().total).toBe(2000);
  });

  it("a total at the minimum (1900) is accepted (floors are minimums, not maximums)", () => {
    expect(resolveMemoryBriefingBudget({ total: 1900 }).total).toBe(1900);
  });

  it("a total below the minimum is rejected at load with a message naming 1900", () => {
    let caught: unknown;
    try {
      resolveMemoryBriefingBudget({ total: 1899 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as Error).message).toContain("1900");
  });
});
