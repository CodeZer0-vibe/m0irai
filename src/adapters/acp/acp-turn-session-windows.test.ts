/**
 * @file src/adapters/acp/acp-turn-session-windows.test.ts
 * @purpose Falsifiers for the claude rate-limit WINDOW capture riding usage_update _meta (U2d-b/U2d-c):
 *   both real sources verbatim (rate_limit_event + the u2d-c /usage plan windows), garbage rejected
 *   (0-100 contract, ISO-only resets_at), per-window field-merge (a status-only event must not blank a
 *   learned % on the SAME window; a ROLLED window never inherits the old %), junk _meta never costs the
 *   ctx%, and windows accumulate within a turn and across turns on one session. Split from
 *   acp-turn-session.test.ts (500-line ceiling).
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./acp-turn-session
 */
import { expect, it } from "vitest";
import { type TurnSessionDeps, openTurnSession, usageFromUpdate } from "./acp-turn-session.js";

it("usageFromUpdate captures the rate-limit window riding _meta (REAL captured event, U2d-b)", () => {
  // The EXACT notification the adapter emitted on a REAL turn (spike 2026-07-03, one live claude turn —
  // .council/spike-rate-limit-capture.json): rate_limit_event forwarded as usage_update with
  // _meta["_claude/rateLimit"] (dist/acp-agent.js:1791-1794). This "allowed" variant carries NO utilization —
  // the capture must NOT fabricate one.
  expect(
    usageFromUpdate({
      sessionUpdate: "usage_update",
      used: 42_585,
      size: 1_000_000,
      _meta: {
        "_claude/rateLimit": {
          status: "allowed",
          resetsAt: 1_783_080_600,
          rateLimitType: "five_hour",
          overageStatus: "rejected",
          overageDisabledReason: "out_of_credits",
          isUsingOverage: false,
        },
      },
    }),
  ).toEqual({
    used: 42_585,
    size: 1_000_000,
    rateLimits: { five_hour: { status: "allowed", resetsAt: 1_783_080_600 } },
  });
  // The warning variant DOES carry utilization (SDKRateLimitInfo contract — sdk.d.ts:4089-4100: status
  // 'allowed'|'allowed_warning'|'rejected', utilization?: number, per-window rateLimitType).
  expect(
    usageFromUpdate({
      sessionUpdate: "usage_update",
      used: 10,
      size: 100,
      _meta: {
        "_claude/rateLimit": {
          status: "allowed_warning",
          resetsAt: 1_783_100_000,
          rateLimitType: "seven_day",
          utilization: 82,
        },
      },
    }),
  ).toEqual({
    used: 10,
    size: 100,
    rateLimits: {
      seven_day: { status: "allowed_warning", resetsAt: 1_783_100_000, utilization: 82 },
    },
  });
});

// The EXACT _meta the u2d-c adapter patch forwards after each result (spike 2026-07-03, one live turn —
// .council/spike-usage-windows-capture.json): the structured data behind /usage. Unlike rate_limit_event,
// utilization is populated at ANY usage level — this is the full-parity source. Null windows and the
// experimental extra keys are skipped; resets_at is ISO 8601 → epoch SECONDS; no status field exists on
// this source (the window is knowledge, not a verdict).
const REAL_USAGE_WINDOWS_META = {
  "_claude/usageWindows": {
    five_hour: {
      utilization: 70,
      resets_at: "2026-07-03T12:09:59.694046+00:00",
      limit_dollars: null,
      used_dollars: null,
      remaining_dollars: null,
    },
    seven_day: {
      utilization: 55,
      resets_at: "2026-07-03T11:59:59.694064+00:00",
      limit_dollars: null,
      used_dollars: null,
      remaining_dollars: null,
    },
    seven_day_oauth_apps: null,
    seven_day_opus: null,
    seven_day_sonnet: null,
    tangelo: null,
    extra_usage: { is_enabled: false, utilization: 0 },
    limits: [{ kind: "session", percent: 70 }],
  },
};

it("usageFromUpdate captures the /usage PLAN windows riding _meta (REAL patched-adapter event, U2d-c)", () => {
  expect(
    usageFromUpdate({
      sessionUpdate: "usage_update",
      used: 42_585,
      size: 1_000_000,
      _meta: REAL_USAGE_WINDOWS_META,
    }),
  ).toEqual({
    used: 42_585,
    size: 1_000_000,
    rateLimits: {
      five_hour: { utilization: 70, resetsAt: 1_783_080_599 },
      seven_day: { utilization: 55, resetsAt: 1_783_079_999 },
    },
  });
  // A null utilization or unparseable resets_at yields what CAN be read — never a fabricated number.
  expect(
    usageFromUpdate({
      sessionUpdate: "usage_update",
      used: 1,
      size: 10,
      _meta: {
        "_claude/usageWindows": {
          five_hour: { utilization: null, resets_at: "not-a-date" },
          seven_day: { utilization: 12, resets_at: null },
        },
      },
    }),
  ).toEqual({ used: 1, size: 10, rateLimits: { seven_day: { utilization: 12 } } });
});

it("garbage utilization is REJECTED, not laundered into a meter (codex u2dc B2) — contract is 0-100", () => {
  // sdk.d.ts documents utilization as "Percentage of the window used, 0-100" — a 999/-5/NaN/Infinity is
  // NOT the documented shape and must drop the FIELD (resetsAt still reads), never clamp into a
  // real-looking meter. Applies to BOTH _meta sources.
  for (const bad of [999, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(
      usageFromUpdate({
        sessionUpdate: "usage_update",
        used: 1,
        size: 10,
        _meta: {
          "_claude/usageWindows": {
            five_hour: { utilization: bad, resets_at: "2026-07-03T12:09:59+00:00" },
          },
        },
      }),
    ).toEqual({ used: 1, size: 10, rateLimits: { five_hour: { resetsAt: 1_783_080_599 } } });
    expect(
      usageFromUpdate({
        sessionUpdate: "usage_update",
        used: 1,
        size: 10,
        _meta: {
          "_claude/rateLimit": { status: "allowed", rateLimitType: "five_hour", utilization: bad },
        },
      }),
    ).toEqual({ used: 1, size: 10, rateLimits: { five_hour: { status: "allowed" } } });
  }
});

it("a non-ISO resets_at is rejected (the contract says ISO 8601 — Date.parse leniency is not a license)", () => {
  expect(
    usageFromUpdate({
      sessionUpdate: "usage_update",
      used: 1,
      size: 10,
      _meta: {
        "_claude/usageWindows": { five_hour: { utilization: 10, resets_at: "July 3, 2026" } },
      },
    }),
  ).toEqual({ used: 1, size: 10, rateLimits: { five_hour: { utilization: 10 } } });
});

it("a status-only event window MERGES onto the same plan window — the learned % survives (codex u2dc B3)", async () => {
  // The adapter emits the plan windows (utilization at any level) at result time and rate_limit_event
  // windows (status verdict, often utilization-less) mid-turn. Replacing the whole window object would
  // blank the 70% meter every time an "allowed" event arrives. Same-window detection: reset instants
  // within 60s (the two sources round the SAME reset differently — 1s apart in the live captures).
  const deps: TurnSessionDeps = {
    openConnection: async (_agent, _cwd, _onUpdate, onUsage) => ({
      initialize: async () => undefined,
      newSession: async () => ({ sessionId: "s" }),
      prompt: async () => {
        onUsage({
          used: 100,
          size: 1000,
          rateLimits: { five_hour: { utilization: 70, resetsAt: 1_783_080_599 } },
        });
        onUsage({
          used: 150,
          size: 1000,
          rateLimits: { five_hour: { status: "allowed", resetsAt: 1_783_080_600 } },
        });
        return "end_turn";
      },
      setMode: async () => undefined,
      close: () => undefined,
    }),
  };
  const session = await openTurnSession("claude", "C:/wt", deps);
  const result = await session.prompt("hi");
  expect(result.usage).toEqual({
    used: 150,
    size: 1000,
    rateLimits: {
      // Anchored to the EARLIER instant — an inheriting merge never extends a window's lifetime.
      five_hour: { status: "allowed", utilization: 70, resetsAt: 1_783_080_599 },
    },
  });
});

it("a ROLLED window does NOT inherit the old % — different reset instant means a new window", async () => {
  const deps: TurnSessionDeps = {
    openConnection: async (_agent, _cwd, _onUpdate, onUsage) => ({
      initialize: async () => undefined,
      newSession: async () => ({ sessionId: "s" }),
      prompt: async () => {
        onUsage({
          used: 100,
          size: 1000,
          rateLimits: { five_hour: { utilization: 70, resetsAt: 1_783_080_599 } },
        });
        onUsage({
          used: 150,
          size: 1000,
          rateLimits: { five_hour: { status: "allowed", resetsAt: 1_783_098_600 } }, // 5h later — a NEW window
        });
        return "end_turn";
      },
      setMode: async () => undefined,
      close: () => undefined,
    }),
  };
  const session = await openTurnSession("claude", "C:/wt", deps);
  const result = await session.prompt("hi");
  expect(result.usage).toEqual({
    used: 150,
    size: 1000,
    rateLimits: { five_hour: { status: "allowed", resetsAt: 1_783_098_600 } }, // old 70% did NOT leak in
  });
});

it("when BOTH _meta sources ride one update, the same-window fields UNION — verdict AND % both survive", () => {
  expect(
    usageFromUpdate({
      sessionUpdate: "usage_update",
      used: 1,
      size: 10,
      _meta: {
        "_claude/usageWindows": {
          five_hour: { utilization: 70, resets_at: "2026-07-03T12:09:59.694046+00:00" },
          seven_day: { utilization: 55, resets_at: "2026-07-03T11:59:59.694064+00:00" },
        },
        "_claude/rateLimit": {
          status: "rejected",
          resetsAt: 1_783_080_600,
          rateLimitType: "five_hour",
        },
      },
    }),
  ).toEqual({
    used: 1,
    size: 10,
    rateLimits: {
      // Same window (instants 1s apart): the event's verdict + the plan's % — neither source blanks the
      // other; the inheriting union anchors to the EARLIER instant (anti-ratchet).
      five_hour: { status: "rejected", utilization: 70, resetsAt: 1_783_080_599 },
      seven_day: { utilization: 55, resetsAt: 1_783_079_999 },
    },
  });
});

it("a turn's cost does NOT bleed into the next turn (the carry is turn-scoped — codex verify-3 nit)", async () => {
  let turn = 0;
  const deps: TurnSessionDeps = {
    openConnection: async (_agent, _cwd, _onUpdate, onUsage) => ({
      initialize: async () => undefined,
      newSession: async () => ({ sessionId: "s" }),
      prompt: async () => {
        turn += 1;
        if (turn === 1) {
          onUsage({ used: 100, size: 1000, cost: { amount: 0.4, currency: "USD" } });
        } else {
          onUsage({ used: 200, size: 1000 }); // turn 2 reports no cost — turn 1's must not leak in
        }
        return "end_turn";
      },
      setMode: async () => undefined,
      close: () => undefined,
    }),
  };
  const session = await openTurnSession("claude", "C:/wt", deps);
  await session.prompt("first");
  const second = await session.prompt("second");
  expect(second.usage).toEqual({ used: 200, size: 1000 });
});

it("a result's cost survives the patch's SECOND (cost-less) usage_update — same-turn carry (codex nit)", async () => {
  const deps: TurnSessionDeps = {
    openConnection: async (_agent, _cwd, _onUpdate, onUsage) => ({
      initialize: async () => undefined,
      newSession: async () => ({ sessionId: "s" }),
      prompt: async () => {
        onUsage({ used: 100, size: 1000, cost: { amount: 0.4, currency: "USD" } }); // result: cost emit
        onUsage({
          used: 100,
          size: 1000,
          rateLimits: { five_hour: { utilization: 70, resetsAt: 1_783_080_599 } },
        }); // the patch's plan-window emit carries NO cost — the turn's cost must not vanish
        return "end_turn";
      },
      setMode: async () => undefined,
      close: () => undefined,
    }),
  };
  const session = await openTurnSession("claude", "C:/wt", deps);
  const result = await session.prompt("hi");
  expect(result.usage).toEqual({
    used: 100,
    size: 1000,
    cost: { amount: 0.4, currency: "USD" },
    rateLimits: { five_hour: { utilization: 70, resetsAt: 1_783_080_599 } },
  });
});

it("junk or non-window _meta never costs the ctx% — usage survives WITHOUT rateLimits", () => {
  // Unknown/absent rateLimitType (incl. 'overage' — a credit-spend state, not a display window),
  // or a non-record payload: the used/size capture is unaffected.
  for (const meta of [
    { "_claude/rateLimit": { status: "allowed", rateLimitType: "overage" } },
    {
      "_claude/rateLimit": {
        status: "allowed_warning",
        rateLimitType: "seven_day_overage_included",
        utilization: 1,
      },
    },
    { "_claude/rateLimit": { status: "allowed" } }, // no window type
    { "_claude/rateLimit": "corrupt" },
    { "_claude/rateLimit": { status: 7, rateLimitType: "five_hour" } }, // non-string status
    "not-a-record",
  ]) {
    expect(
      usageFromUpdate({ sessionUpdate: "usage_update", used: 5, size: 10, _meta: meta }),
    ).toEqual({ used: 5, size: 10 });
  }
});

it("windows ACCUMULATE across a turn's notifications — a later plain usage_update never drops them", async () => {
  const deps: TurnSessionDeps = {
    openConnection: async (_agent, _cwd, _onUpdate, onUsage) => ({
      initialize: async () => undefined,
      newSession: async () => ({ sessionId: "s" }),
      prompt: async () => {
        onUsage({
          used: 100,
          size: 1000,
          rateLimits: { five_hour: { status: "allowed", resetsAt: 1_783_080_600 } },
        });
        onUsage({
          used: 150,
          size: 1000,
          rateLimits: { seven_day: { status: "allowed_warning", utilization: 82 } },
        });
        onUsage({ used: 200, size: 1000 }); // the result-time update — carries no _meta
        return "end_turn";
      },
      setMode: async () => undefined,
      close: () => undefined,
    }),
  };
  const session = await openTurnSession("claude", "C:/wt", deps);
  const result = await session.prompt("hi");
  // Latest used/size wins; BOTH windows survive (the model-side merge is wholesale-replace, so a
  // windows-less final usage would clobber the meters the turn just learned — cockpit-model.ts:348).
  expect(result.usage).toEqual({
    used: 200,
    size: 1000,
    rateLimits: {
      five_hour: { status: "allowed", resetsAt: 1_783_080_600 },
      seven_day: { status: "allowed_warning", utilization: 82 },
    },
  });
});

it("windows persist ACROSS turns on the same session (rate_limit_event may not fire every turn)", async () => {
  let turn = 0;
  const deps: TurnSessionDeps = {
    openConnection: async (_agent, _cwd, _onUpdate, onUsage) => ({
      initialize: async () => undefined,
      newSession: async () => ({ sessionId: "s" }),
      prompt: async () => {
        turn += 1;
        if (turn === 1) {
          onUsage({
            used: 100,
            size: 1000,
            rateLimits: { five_hour: { status: "allowed", utilization: 12 } },
          });
        } else {
          onUsage({ used: 300, size: 1000 }); // turn 2: ctx only — no rate_limit_event this turn
        }
        return "end_turn";
      },
      setMode: async () => undefined,
      close: () => undefined,
    }),
  };
  const session = await openTurnSession("claude", "C:/wt", deps);
  await session.prompt("first");
  const second = await session.prompt("second");
  expect(second.usage).toEqual({
    used: 300,
    size: 1000,
    rateLimits: { five_hour: { status: "allowed", utilization: 12 } },
  });
});
