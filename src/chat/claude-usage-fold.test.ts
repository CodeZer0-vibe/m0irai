/**
 * @file src/chat/claude-usage-fold.test.ts
 * @purpose Falsifying contract for the process-scoped claude window fold (codex B1): windows accumulate
 *   across folds, a windows-less usage carries the last-known map, fresher windows supersede per window
 *   (others untouched), a window-less process passes usage through untouched, and reset clears.
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./claude-usage-fold
 */
import { beforeEach, expect, it } from "vitest";
import { foldClaudeWindows, resetClaudeWindowFold } from "./claude-usage-fold.js";

beforeEach(() => {
  resetClaudeWindowFold();
});

it("passes usage through untouched while no windows have ever been learned", () => {
  expect(foldClaudeWindows({ used: 1, size: 10 })).toEqual({ used: 1, size: 10 });
});

it("a windows-less usage carries the last-known map (the per-turn-session blank, codex B1)", () => {
  foldClaudeWindows({
    used: 1,
    size: 10,
    rateLimits: { seven_day: { status: "allowed_warning", utilization: 82 } },
  });
  expect(foldClaudeWindows({ used: 2, size: 10 })).toEqual({
    used: 2,
    size: 10,
    rateLimits: { seven_day: { status: "allowed_warning", utilization: 82 } },
  });
});

it("fresher windows supersede PER WINDOW — the other learned windows stay", () => {
  foldClaudeWindows({
    used: 1,
    size: 10,
    rateLimits: { five_hour: { status: "allowed", utilization: 10 } },
  });
  foldClaudeWindows({
    used: 2,
    size: 10,
    rateLimits: { seven_day: { status: "allowed", utilization: 40 } },
  });
  expect(
    foldClaudeWindows({
      used: 3,
      size: 10,
      rateLimits: { five_hour: { status: "allowed_warning", utilization: 55 } },
    }),
  ).toEqual({
    used: 3,
    size: 10,
    rateLimits: {
      five_hour: { status: "allowed_warning", utilization: 55 },
      seven_day: { status: "allowed", utilization: 40 },
    },
  });
});

it("reset clears the fold (test isolation — production keeps the process scope)", () => {
  foldClaudeWindows({
    used: 1,
    size: 10,
    rateLimits: { five_hour: { status: "rejected" } },
  });
  resetClaudeWindowFold();
  expect(foldClaudeWindows({ used: 2, size: 10 })).toEqual({ used: 2, size: 10 });
});

it("an EXPIRED window is dropped, not stamped — a passed rejection must not keep claude red (codex B2)", () => {
  // codex verify-round BLOCK: claude hits a 5h rejection with resetsAt=T; T passes (the account window
  // reset — claude is usable again); the next ctx-only turn must NOT carry the stale rejected window,
  // or acpUsageToStatus keeps exhausted:true and the bar stays limited until a fresh event arrives.
  foldClaudeWindows(
    { used: 1, size: 10, rateLimits: { five_hour: { status: "rejected", resetsAt: 1_000 } } },
    500_000, // learned while live (resetsAt 1_000s = 1_000_000ms)
  );
  expect(foldClaudeWindows({ used: 2, size: 10 }, 1_000_000)).toEqual({ used: 2, size: 10 }); // at T: expired
});

it("expiry is PER WINDOW — an expired five_hour drops while a live seven_day survives", () => {
  foldClaudeWindows(
    {
      used: 1,
      size: 10,
      rateLimits: {
        five_hour: { status: "rejected", resetsAt: 1_000 },
        seven_day: { status: "allowed", utilization: 40, resetsAt: 9_000 },
      },
    },
    500_000,
  );
  expect(foldClaudeWindows({ used: 2, size: 10 }, 2_000_000)).toEqual({
    used: 2,
    size: 10,
    rateLimits: { seven_day: { status: "allowed", utilization: 40, resetsAt: 9_000 } },
  });
});

it("a window WITHOUT resetsAt is kept until superseded (no basis to expire it — never invented)", () => {
  foldClaudeWindows(
    {
      used: 1,
      size: 10,
      rateLimits: { seven_day: { status: "allowed_warning", utilization: 82 } },
    },
    500_000,
  );
  expect(foldClaudeWindows({ used: 2, size: 10 }, 999_999_999)).toEqual({
    used: 2,
    size: 10,
    rateLimits: { seven_day: { status: "allowed_warning", utilization: 82 } },
  });
});
