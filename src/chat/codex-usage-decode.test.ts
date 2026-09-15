/**
 * @file src/chat/codex-usage-decode.test.ts
 * @purpose The falsifiable contract for the codex usage decode, driven ONLY by payloads sliced
 *   byte-for-byte out of real ~/.codex rollout lines (codex-usage-captures.fixtures.ts). Every case
 *   below names the operator-visible failure it catches; nothing here is composed from an imagined
 *   vendor shape, because the bug this suite exists to kill was caused by exactly that.
 * @exports (none)
 * @depends vitest, ./codex-usage-captures.fixtures, ./codex-usage-decode, ./statusline-payload
 */
import { describe, expect, it } from "vitest";
import {
  BOTH_WINDOWS,
  LEGACY_RELATIVE_RESETS,
  NO_WINDOW_MIDSESSION,
  UNRECOGNISED_WINDOW,
  WEEKLY_ONLY_97,
  WEEKLY_ONLY_IDLE,
  WEEKLY_ONLY_SPENT,
} from "./codex-usage-captures.fixtures.js";
import { decodeCodexUsage } from "./codex-usage-decode.js";
import { bindingResetAtMs } from "./statusline-payload.js";

describe("codex usage decode: windows are named by the duration the VENDOR states (D1)", () => {
  // OPERATOR-VISIBLE FAILURE: codex's chip reads "5h 0%" when codex reported no 5-hour window at all.
  // Every 5h reading this product has ever shown for a prolite codex was the WEEKLY number relabelled.
  it("today's 10080-minute window lands on the WEEKLY meter and invents no 5h reading", () => {
    const { usage } = decodeCodexUsage(WEEKLY_ONLY_IDLE);
    expect(usage.weeklyUsedPct).toBe(0);
    expect(usage.fiveHourUsedPct).toBeUndefined();
    expect(usage.fiveHourResetsAtMs).toBeUndefined();
  });

  // OPERATOR-VISIBLE FAILURE: a weekly running at 97% is INVISIBLE, because the decoder only looked for
  // a weekly in the `secondary` position, which this plan leaves null.
  it("a 97% weekly reported in the primary POSITION still reads as weekly", () => {
    const { usage } = decodeCodexUsage(WEEKLY_ONLY_97);
    expect(usage.weeklyUsedPct).toBe(97);
    expect(usage.fiveHourUsedPct).toBeUndefined();
  });

  // OPERATOR-VISIBLE FAILURE: on a plan that reports BOTH windows, mixing them up shows the 5h pressure
  // on the weekly gauge and vice versa. This is the shape where the old position mapping happened to be
  // right - it is here so the fix cannot regress the plan the product was originally built against.
  it("a 300-minute primary and a 10080-minute secondary each land on their OWN meter", () => {
    const { usage } = decodeCodexUsage(BOTH_WINDOWS);
    expect(usage.fiveHourUsedPct).toBe(27);
    expect(usage.weeklyUsedPct).toBe(100);
  });

  // OPERATOR-VISIBLE FAILURE: the 2025 payload states 299 and 10079 minutes for the SAME two windows.
  // An exact-equality classifier drops both meters and the operator sees an empty codex cell.
  it("tolerates the vendor's 299/10079-minute spelling of the same two windows", () => {
    const { usage, drift } = decodeCodexUsage(LEGACY_RELATIVE_RESETS);
    expect(usage.fiveHourUsedPct).toBe(0);
    expect(usage.weeklyUsedPct).toBe(0);
    expect(drift).toBeUndefined();
  });
});

describe("codex usage decode: ABSENT IS NOT ZERO (I1/I3)", () => {
  // OPERATOR-VISIBLE FAILURE: a 0-minute window is not a window. Rendering "5h 0%" off it states a fact
  // the vendor never sent.
  it("a window whose duration cannot be named produces NO meter and a plain-words divergence", () => {
    const { usage, drift } = decodeCodexUsage(UNRECOGNISED_WINDOW);
    expect(usage.fiveHourUsedPct).toBeUndefined();
    expect(usage.weeklyUsedPct).toBeUndefined();
    expect(drift).toBe("codex reported a 0-minute quota window this build cannot name");
  });

  // OPERATOR-VISIBLE FAILURE: a turn that reported no window is not a spent account.
  it("a payload reporting no window at all produces no meters and no label number", () => {
    const { usage } = decodeCodexUsage(NO_WINDOW_MIDSESSION);
    expect(usage.fiveHourUsedPct).toBeUndefined();
    expect(usage.weeklyUsedPct).toBeUndefined();
    expect(usage.label).toBe("OK");
  });
});

describe("codex usage decode: exhaustion comes from the ENTITLEMENT, never the wallet (D2)", () => {
  // OPERATOR-VISIBLE FAILURE: THE bug that started this round - a warning icon on codex while codex
  // answered in 7 milliseconds, because an unfunded pay-as-you-go wallet was read as a spent
  // subscription.
  it("the operator's real idle codex is NOT out of quota", () => {
    expect(decodeCodexUsage(WEEKLY_ONLY_IDLE).usage.exhausted).toBe(false);
  });

  // OPERATOR-VISIBLE FAILURE: the mirror risk - refusing to show exhaustion when it is real, which would
  // send the loop dispatching into a wall.
  it("a weekly window at 100% IS out of quota", () => {
    expect(decodeCodexUsage(WEEKLY_ONLY_SPENT).usage.exhausted).toBe(true);
  });

  // THE PAIR PROOF. These two captures carry BYTE-IDENTICAL credits blocks and decode to OPPOSITE
  // verdicts, so exhaustion provably cannot be a function of the wallet. This is the falsifiable form of
  // "honour credits.unlimited" that the captures can actually support: `unlimited:true` has never been
  // observed in 56k+ captured payloads, so no test here pretends to have seen one - instead the credits
  // block is proven to have NO influence at all, which subsumes it.
  it("two captures with identical credit blocks decode to opposite verdicts", () => {
    expect(WEEKLY_ONLY_IDLE.credits).toEqual(WEEKLY_ONLY_SPENT.credits);
    expect(WEEKLY_ONLY_IDLE.credits).toEqual({
      has_credits: false,
      unlimited: false,
      balance: "0",
    });
    expect(decodeCodexUsage(WEEKLY_ONLY_IDLE).usage.exhausted).toBe(false);
    expect(decodeCodexUsage(WEEKLY_ONLY_SPENT).usage.exhausted).toBe(true);
  });

  // OPERATOR-VISIBLE FAILURE: a false "limited" FLASH mid-conversation. This exact line sits between 70
  // lines reading 27% weekly in one real session file - the account did not empty and refill in a turn.
  it("a mid-session payload that reported no window is not exhaustion", () => {
    expect(decodeCodexUsage(NO_WINDOW_MIDSESSION).usage.exhausted).toBe(false);
  });

  // OPERATOR-VISIBLE FAILURE: the payload with NO credits block at all must not throw or default to
  // spent - it is simply a plan that does not carry a wallet.
  it("a payload with no credits block at all is not exhaustion", () => {
    expect(decodeCodexUsage(LEGACY_RELATIVE_RESETS).usage.exhausted).toBe(false);
  });
});

describe("codex usage decode: the label names the window it reports (D1b)", () => {
  // OPERATOR-VISIBLE FAILURE: a bare "97%" cannot be told apart from a 5-hour reading by anything
  // downstream. The label must say WHICH window it is quoting.
  it("a weekly-only lane is labelled as weekly, never as a bare percentage", () => {
    expect(decodeCodexUsage(WEEKLY_ONLY_97).usage.label).toBe("wk 97%");
  });

  it("the binding (most-used) window wins the label when both are reported", () => {
    expect(decodeCodexUsage(BOTH_WINDOWS).usage.label).toBe("wk 100%");
  });

  it("a 5h window that is the most-used one is labelled as 5h", () => {
    expect(decodeCodexUsage(LEGACY_RELATIVE_RESETS).usage.label).toBe("5h 0%");
  });
});

describe("codex usage decode: the vendor's reset instant survives (D3)", () => {
  // OPERATOR-VISIBLE FAILURE: FIX-3b's recovery was built to wait for the TRUE reset instant. Dropping
  // it made an exhausted codex lane fall back to a guessed cooldown and re-probe for days.
  it("weeklyResetsAtMs is the vendor's own epoch, in milliseconds", () => {
    expect(decodeCodexUsage(WEEKLY_ONLY_IDLE).usage.weeklyResetsAtMs).toBe(1_785_750_348_000);
  });

  it("each window carries its OWN reset instant when both are reported", () => {
    const { usage } = decodeCodexUsage(BOTH_WINDOWS);
    expect(usage.fiveHourResetsAtMs).toBe(1_783_639_273_000);
    expect(usage.weeklyResetsAtMs).toBe(1_783_768_191_000);
  });

  // OPERATOR-VISIBLE FAILURE: the 2025 shape states time REMAINING, not an instant. Read as an epoch it
  // would resolve to 1970 and the staleness gate would silently hide the meter forever.
  it("the relative resets_in_seconds becomes absolute against the observation instant", () => {
    const observedAtMs = Date.parse("2025-09-30T01:57:41.000Z");
    const { usage } = decodeCodexUsage(LEGACY_RELATIVE_RESETS, undefined, observedAtMs);
    expect(usage.fiveHourResetsAtMs).toBe(observedAtMs + 17_940 * 1000);
    expect(usage.weeklyResetsAtMs).toBe(observedAtMs + 604_740 * 1000);
  });

  it("drops the relative form rather than guessing when the observation instant is unknown", () => {
    const { usage } = decodeCodexUsage(LEGACY_RELATIVE_RESETS);
    expect(usage.fiveHourResetsAtMs).toBeUndefined();
    expect(usage.weeklyResetsAtMs).toBeUndefined();
  });

  // The recovery clock reads the SAME window the meter does - proven end to end rather than assumed.
  it("bindingResetAtMs resolves to the weekly instant for a weekly-only lane", () => {
    const { usage } = decodeCodexUsage(WEEKLY_ONLY_SPENT);
    expect(bindingResetAtMs(usage)).toBe(1_785_073_363_000);
  });

  it("bindingResetAtMs follows the most-used window when both are reported", () => {
    const { usage } = decodeCodexUsage(BOTH_WINDOWS);
    expect(bindingResetAtMs(usage)).toBe(1_783_768_191_000); // the weekly at 100%, not the 5h at 27%
  });
});

describe("codex usage decode: context occupancy is unchanged by the window fix", () => {
  it("derives context from last_token_usage against the model window", () => {
    const { usage } = decodeCodexUsage(WEEKLY_ONLY_IDLE, {
      last_token_usage: { total_tokens: 48_701 },
      model_context_window: 258_400,
    });
    expect(usage.contextUsedPct).toBe(19);
  });

  it("omits context when the model window is absent, leaving the quota fields intact", () => {
    const { usage } = decodeCodexUsage(WEEKLY_ONLY_97, { last_token_usage: { total_tokens: 10 } });
    expect(usage.contextUsedPct).toBeUndefined();
    expect(usage.weeklyUsedPct).toBe(97);
  });
});
