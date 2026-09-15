/**
 * @file src/shared/rate-window-merge.test.ts
 * @purpose Falsifiers for the per-window field merge (codex u2dc B3): incoming fields win; a status-only
 *   incoming inherits the prior % ONLY on the same window (reset instants within 60s); a rolled window
 *   (different instant) never inherits; untouched window keys survive; incomparable instants inherit
 *   (no basis to call it rolled).
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./rate-window-merge
 */
import { expect, it } from "vitest";
import { mergeRateWindows } from "./rate-window-merge.js";

it("a status-only incoming inherits the prior % on the SAME window (instants 1s apart, live shape)", () => {
  expect(
    mergeRateWindows(
      { five_hour: { utilization: 70, resetsAt: 1_783_080_599 } },
      { five_hour: { status: "allowed", resetsAt: 1_783_080_600 } },
    ),
  ).toEqual({
    // An inheriting merge ANCHORS to the earlier instant (never extends a lifetime — the anti-ratchet).
    five_hour: { status: "allowed", utilization: 70, resetsAt: 1_783_080_599 },
  });
});

it("a ROLLED window never inherits the old % (a new period's usage is unknown, not 70%)", () => {
  expect(
    mergeRateWindows(
      { five_hour: { utilization: 70, resetsAt: 1_783_080_599 } },
      { five_hour: { status: "allowed", resetsAt: 1_783_098_600 } },
    ),
  ).toEqual({ five_hour: { status: "allowed", resetsAt: 1_783_098_600 } });
});

it("an incoming WITH utilization simply wins (fresher truth)", () => {
  expect(
    mergeRateWindows(
      { five_hour: { utilization: 70, resetsAt: 1_783_080_599 } },
      { five_hour: { utilization: 71, resetsAt: 1_783_080_599 } },
    ),
  ).toEqual({ five_hour: { utilization: 71, resetsAt: 1_783_080_599 } });
});

it("untouched window keys survive the merge; incomparable instants inherit (no basis to call it rolled)", () => {
  expect(
    mergeRateWindows(
      {
        five_hour: { utilization: 70 }, // no instant on the prior
        seven_day: { utilization: 55, resetsAt: 1_783_079_999 },
      },
      { five_hour: { status: "allowed_warning", resetsAt: 1_783_080_600 } },
    ),
  ).toEqual({
    five_hour: { status: "allowed_warning", utilization: 70, resetsAt: 1_783_080_600 },
    seven_day: { utilization: 55, resetsAt: 1_783_079_999 },
  });
});

it("no prior → incoming verbatim", () => {
  expect(mergeRateWindows(undefined, { seven_day: { utilization: 12 } })).toEqual({
    seven_day: { utilization: 12 },
  });
});

it("the MIRROR direction: a plan window (utilization, no status) must not erase a same-window verdict (codex u2dc verify)", () => {
  // rate_limit_event says rejected; a /usage plan update for the SAME window follows (instants 1s apart).
  // Wholesale replacement made claude look usable while rate-limited — the verdict must survive the merge.
  expect(
    mergeRateWindows(
      { five_hour: { status: "rejected", resetsAt: 1_783_080_600 } },
      { five_hour: { utilization: 100, resetsAt: 1_783_080_599 } },
    ),
  ).toEqual({
    five_hour: { status: "rejected", utilization: 100, resetsAt: 1_783_080_599 },
  });
});

it("a ROLLED window clears the old verdict too — a new period starts unjudged", () => {
  expect(
    mergeRateWindows(
      { five_hour: { status: "rejected", resetsAt: 1_783_080_600 } },
      { five_hour: { utilization: 3, resetsAt: 1_783_098_600 } },
    ),
  ).toEqual({ five_hour: { utilization: 3, resetsAt: 1_783_098_600 } });
});

it("inheritance NEVER extends a lifetime — the ratchet is dead (codex u2dc verify 3)", () => {
  // Near-boundary updates walking the instant forward must not carry an inherited verdict with them:
  // step 1 inherits the verdict but keeps the EARLIER instant (the verdict's own window)...
  const step1 = mergeRateWindows(
    { five_hour: { status: "rejected", resetsAt: 1_000 } },
    { five_hour: { utilization: 90, resetsAt: 1_059 } },
  );
  expect(step1).toEqual({
    five_hour: { status: "rejected", utilization: 90, resetsAt: 1_000 },
  });
  // ...so step 2 (another +59s walk) compares against the ANCHORED instant, reads as a rolled window,
  // and the verdict dies with its own window instead of ratcheting forever.
  expect(mergeRateWindows(step1, { five_hour: { utilization: 5, resetsAt: 1_118 } })).toEqual({
    five_hour: { utilization: 5, resetsAt: 1_118 },
  });
});

it("full-then-partial alternation is BOUNDED: only fresh state moves forward, inherited state stays anchored", () => {
  // codex verify-4 nit pinned directly: a FULL update (both fields) may move the instant forward — that
  // state is its own, fresh truth. A following PARTIAL update inherits from it but anchors at that full
  // update's instant; nothing INHERITED ever rides a later instant than the update that asserted it.
  const afterFull = mergeRateWindows(
    { five_hour: { status: "rejected", resetsAt: 1_000 } },
    { five_hour: { status: "allowed_warning", utilization: 88, resetsAt: 1_050 } }, // full: verdict+%.
  );
  expect(afterFull).toEqual({
    five_hour: { status: "allowed_warning", utilization: 88, resetsAt: 1_050 }, // fresh truth, verbatim
  });
  const afterPartial = mergeRateWindows(afterFull, {
    five_hour: { utilization: 90, resetsAt: 1_100 },
  });
  expect(afterPartial).toEqual({
    // Inherits the warning verdict → anchored at 1_050 (the instant that ASSERTED the verdict).
    five_hour: { status: "allowed_warning", utilization: 90, resetsAt: 1_050 },
  });
  // The next partial walk (+59 from ITS instant, but >60 from the anchor) reads as rolled — nothing
  // inherited survives past the asserting update's window.
  expect(
    mergeRateWindows(afterPartial, { five_hour: { utilization: 2, resetsAt: 1_159 } }),
  ).toEqual({
    five_hour: { utilization: 2, resetsAt: 1_159 },
  });
});

it("a fresher verdict on the same window replaces the old one (allowed lifts a stale warning)", () => {
  expect(
    mergeRateWindows(
      { five_hour: { status: "allowed_warning", utilization: 82, resetsAt: 1_783_080_600 } },
      { five_hour: { status: "allowed", resetsAt: 1_783_080_600 } },
    ),
  ).toEqual({
    five_hour: { status: "allowed", utilization: 82, resetsAt: 1_783_080_600 },
  });
});
