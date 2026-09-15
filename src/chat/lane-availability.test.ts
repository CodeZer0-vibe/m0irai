/**
 * @file src/chat/lane-availability.test.ts
 * @purpose F1 (FIX-3) pure-model contract: the lane-availability classifier + state machine. RED-before-
 *   GREEN: the classifier is fed the EXACT error strings the field trace (chat-1784553379589) recorded on
 *   the claude lane's dispatch.failed events, and every state transition of the durable machine is asserted.
 *   No I/O — this is the pure model (the durable store + the dispatch gate are wired + tested separately).
 * @exports (none — test file)
 * @depends vitest, ./lane-availability
 */
import { describe, expect, it } from "vitest";
import {
  FALLBACK_COOLDOWN_MS,
  type LaneAvailability,
  MAX_PROBE_WAIT_MS,
  classifyLaneFailure,
  initialAvailability,
  isLaneBlocked,
  onBlockedSend,
  onDispatchFailure,
  onDispatchSuccess,
  onRetry,
  onRetryFailed,
  plausiblyReset,
} from "./lane-availability.js";

// The VERBATIM strings the field trace carried on claude's dispatch.failed events (turns 25/26/48-51).
const CREDIT_STRING =
  "Internal error: You're out of usage credits. Run /usage-credits to keep using Fable 5 or /model to switch models.";
const AUTH_STRING = "Authentication required";

describe("F1 classifier: real field error strings -> death class + zer0 words", () => {
  it("classifies the out-of-credits string as exhausted", () => {
    const c = classifyLaneFailure(CREDIT_STRING);
    expect(c?.class).toBe("exhausted");
  });

  it("classifies 'Authentication required' as needs_auth", () => {
    const c = classifyLaneFailure(AUTH_STRING);
    expect(c?.class).toBe("needs_auth");
  });

  it("NEVER echoes the raw child-CLI remediation (no /usage-credits, no /model) — zer0 words only", () => {
    const c = classifyLaneFailure(CREDIT_STRING);
    expect(c?.reason).toBeTruthy();
    expect(c?.reason).not.toContain("/usage-credits");
    expect(c?.reason).not.toContain("/model");
    expect(c?.reason).not.toContain("Internal error");
  });

  it("leaves an ordinary transport/timeout failure UNCLASSIFIED (does not mark the lane dead)", () => {
    expect(classifyLaneFailure("stopReason=max_tokens")).toBeUndefined();
    expect(
      classifyLaneFailure("ACP lane step timed out after 60s: claude initialize"),
    ).toBeUndefined();
    expect(classifyLaneFailure("no live lane session held")).toBeUndefined();
  });

  it("matches the credit class on paraphrases (case-insensitive, 'usage credits')", () => {
    expect(classifyLaneFailure("You are out of Usage Credits.")?.class).toBe("exhausted");
    expect(classifyLaneFailure("rate limit exceeded")?.class).toBe("exhausted");
  });
});

describe("F1 state machine: ACTIVE -> EXHAUSTED/NEEDS_AUTH -> LOCAL_BLOCKED -> RETRYING -> READY", () => {
  const t0 = 1_000;

  it("starts ready (ACTIVE)", () => {
    expect(initialAvailability(t0).state).toBe("ready");
    expect(isLaneBlocked(initialAvailability(t0))).toBe(false);
  });

  it("ready + credit failure -> exhausted (carries cause + zer0 reason)", () => {
    const a = onDispatchFailure(initialAvailability(t0), CREDIT_STRING, t0 + 1);
    expect(a.state).toBe("exhausted");
    expect(a.cause).toBe("exhausted");
    expect(a.reason).toBeTruthy();
    expect(isLaneBlocked(a)).toBe(true);
  });

  it("ready + auth failure -> needs_auth", () => {
    const a = onDispatchFailure(initialAvailability(t0), AUTH_STRING, t0 + 1);
    expect(a.state).toBe("needs_auth");
    expect(a.cause).toBe("needs_auth");
    expect(isLaneBlocked(a)).toBe(true);
  });

  it("ready + unclassified failure -> stays ready (no false death)", () => {
    const a = onDispatchFailure(initialAvailability(t0), "stopReason=max_tokens", t0 + 1);
    expect(a.state).toBe("ready");
  });
});

describe("F1 state machine: block -> retry -> recover", () => {
  const t0 = 1_000;

  it("exhausted + subsequent send -> local_blocked (preserves cause + reason)", () => {
    const dead = onDispatchFailure(initialAvailability(t0), CREDIT_STRING, t0 + 1);
    const blocked = onBlockedSend(dead, t0 + 2);
    expect(blocked.state).toBe("local_blocked");
    expect(blocked.cause).toBe("exhausted");
    expect(blocked.reason).toBe(dead.reason);
    expect(isLaneBlocked(blocked)).toBe(true);
  });

  it("local_blocked + another send -> stays local_blocked", () => {
    let a = onDispatchFailure(initialAvailability(t0), CREDIT_STRING, t0 + 1);
    a = onBlockedSend(a, t0 + 2);
    a = onBlockedSend(a, t0 + 3);
    expect(a.state).toBe("local_blocked");
  });

  it("blocked -> retrying on explicit operator retry, -> ready on real success", () => {
    let a = onDispatchFailure(initialAvailability(t0), CREDIT_STRING, t0 + 1);
    a = onBlockedSend(a, t0 + 2);
    a = onRetry(a, t0 + 3);
    expect(a.state).toBe("retrying");
    a = onDispatchSuccess(a, t0 + 4);
    expect(a.state).toBe("ready");
    expect(isLaneBlocked(a)).toBe(false);
    expect(a.cause).toBeUndefined();
  });

  it("retrying + failure again -> back to the death class", () => {
    let a = onDispatchFailure(initialAvailability(t0), AUTH_STRING, t0 + 1);
    a = onRetry(a, t0 + 2);
    expect(a.state).toBe("retrying");
    a = onDispatchFailure(a, AUTH_STRING, t0 + 3);
    expect(a.state).toBe("needs_auth");
  });

  it("a ready lane + successful dispatch stays ready (idempotent)", () => {
    const a = onDispatchSuccess(initialAvailability(t0), t0 + 1);
    expect(a.state).toBe("ready");
  });
});

describe("F1 recovery gating: reset-window plausibility (BLOCK 1 — production reachability)", () => {
  const t0 = 10_000;
  const buildExhausted = (resetsAtMs?: number): LaneAvailability =>
    onDispatchFailure(initialAvailability(t0), "out of usage credits", t0 + 1, resetsAtMs);

  it("a death recorded the PRODUCTION way (no resetsAtMs) auto-recovers after the fallback cooldown", () => {
    // The field bug: production only ever calls the 3-arg onDispatchFailure. Without the fallback this
    // blocked FOREVER; now a fallback reset window is stamped so recovery is reachable with no restart.
    const dead = buildExhausted(undefined);
    // ITEM B: the fallback lives in probeAtMs now. The painted resetsAtMs stays absent here, which
    // is asserted by its own falsifier in the B block at the bottom of this file.
    expect(dead.probeAtMs).toBe(t0 + 1 + FALLBACK_COOLDOWN_MS);
    expect(plausiblyReset(dead, t0 + 1 + FALLBACK_COOLDOWN_MS - 1)).toBe(false); // still cooling
    expect(plausiblyReset(dead, t0 + 1 + FALLBACK_COOLDOWN_MS + 1)).toBe(true); // recovered
  });

  it("a REAL reset window (rate-window data) WINS over the fallback", () => {
    const dead = buildExhausted(t0 + 100_000); // real window sooner than the 15-min fallback
    expect(dead.resetsAtMs).toBe(t0 + 100_000);
    expect(dead.probeAtMs).toBe(t0 + 100_000);
    expect(plausiblyReset(dead, t0 + 50_000)).toBe(false);
    expect(plausiblyReset(dead, t0 + 100_001)).toBe(true);
  });

  it("a ready lane is never 'plausibly reset' (nothing to reset)", () => {
    expect(plausiblyReset(initialAvailability(t0), t0 + 999_999)).toBe(false);
  });
});

// FIX-3c BLOCK 1: the zombie's second shape. `retrying` is deliberately NOT a blocked state (it is the one
// send allowed through), so a recovery attempt that fails WITHOUT matching any death pattern used to leave
// the lane fully dispatchable — burning a child on every send, forever. The carrier collapses transport
// failures to generic text (headless-carrier.ts:353), so unclassified is the COMMON case, not an edge one.
describe("F1 state machine: a FAILED recovery attempt cannot restore normal dispatching", () => {
  const t0 = 50_000;
  const dead = onDispatchFailure(initialAvailability(t0), AUTH_STRING, t0 + 1);
  const retrying = onRetry(dead, t0 + FALLBACK_COOLDOWN_MS + 2);

  it("a retry that fails for ANY reason returns the lane to its prior blocked state", () => {
    const now = t0 + FALLBACK_COOLDOWN_MS + 3;
    const settled = onRetryFailed(retrying, now);
    expect(retrying.state).toBe("retrying");
    expect(isLaneBlocked(retrying)).toBe(false); // the hole this closes
    expect(settled.state).toBe("needs_auth"); // back to the cause it was recovering from
    expect(isLaneBlocked(settled)).toBe(true);
    expect(settled.cause).toBe("needs_auth");
    expect(settled.reason).toBe(dead.reason); // still the truthful, zer0-worded cause
  });

  it("stamps a FRESH cooldown so the next send cannot immediately re-probe (no retry storm)", () => {
    const now = t0 + FALLBACK_COOLDOWN_MS + 3;
    const settled = onRetryFailed(retrying, now);
    expect(plausiblyReset(settled, now)).toBe(false);
    expect(settled.probeAtMs).toBe(now + FALLBACK_COOLDOWN_MS); // ITEM B: internal, never painted
    expect(plausiblyReset(settled, now + FALLBACK_COOLDOWN_MS + 1)).toBe(true);
  });

  it("a KNOWN window further out wins over the fallback (never re-probe before the real reset)", () => {
    // DELTA ITEM 2 re-scoped this case: the window is a QUOTA fact, so the lane it survives on is a
    // QUOTA death. This used to be asserted against the `needs_auth` fixture above, which is precisely
    // the confusion the item removes — see the needs_auth case immediately below.
    const spent = onDispatchFailure(initialAvailability(t0), CREDIT_STRING, t0 + 1);
    const spentRetrying = onRetry(spent, t0 + FALLBACK_COOLDOWN_MS + 2);
    const now = t0 + FALLBACK_COOLDOWN_MS + 3;
    const far = now + 5 * FALLBACK_COOLDOWN_MS;
    expect(onRetryFailed(spentRetrying, now, far).resetsAtMs).toBe(far);
    // ...but a window already in the PAST must not be reused, or the lane re-probes every send.
    expect(onRetryFailed(spentRetrying, now, now - 1).probeAtMs).toBe(now + FALLBACK_COOLDOWN_MS);
  });

  it("leaves a lane that was NOT retrying untouched (a healthy lane's hiccup is not a death)", () => {
    const ready = initialAvailability(t0);
    expect(onRetryFailed(ready, t0 + 5)).toBe(ready);
    expect(onRetryFailed(dead, t0 + 5)).toBe(dead);
  });
});

// DELTA ITEM 2's other half, in its own block rather than appended to the one above: that block was at
// the function-line clamp, and the ratchet is answered by a seam, never by an override. This is a
// different question anyway — the one above is about what a failed retry RESTORES, this is about what
// it may CARRY.
describe("DELTA 2: a failed retry carries a quota window only on a quota death", () => {
  const t0 = 50_000;
  const now = t0 + FALLBACK_COOLDOWN_MS + 3;
  const far = now + 5 * FALLBACK_COOLDOWN_MS;

  it("a failed needs_auth retry takes no quota window, however far out it is", () => {
    // The cause scope on the edge that REBUILDS the record field by field. A sign-in does not come back
    // when a rate window rolls over, and a reset instant on this record would make the terminal retire
    // the painted `needs sign-in` at that instant while every send still fails.
    const dead = onDispatchFailure(initialAvailability(t0), AUTH_STRING, t0 + 1);
    const settled = onRetryFailed(onRetry(dead, t0 + FALLBACK_COOLDOWN_MS + 2), now, far);
    expect(settled.cause).toBe("needs_auth");
    expect(
      settled.resetsAtMs,
      "a quota window rode onto a failed sign-in recovery - the room stops painting a lane that still cannot work",
    ).toBeUndefined();
    expect(settled.probeAtMs).toBe(now + FALLBACK_COOLDOWN_MS);
  });
});

// FIX-3c BLOCK 5: the binding window is now the TRUE reset instant (weekly can be DAYS out). That is the
// right thing to SHOW, but a durable block with no operator retry command must not become a lockout.
describe("F1 recovery gating: a far-future binding window still self-heals (no lockout)", () => {
  const t0 = 100_000;
  const week = 4 * 24 * 60 * 60_000;

  it("waits for the real reset when it is nearer than the liveness ceiling", () => {
    const dead = onDispatchFailure(initialAvailability(t0), CREDIT_STRING, t0, t0 + 60_000);
    expect(plausiblyReset(dead, t0 + 59_000)).toBe(false);
    expect(plausiblyReset(dead, t0 + 61_000)).toBe(true);
  });

  it("a WEEKLY reset days away does not lock the lane out — a probe is due after the ceiling", () => {
    const dead = onDispatchFailure(initialAvailability(t0), CREDIT_STRING, t0, t0 + week);
    expect(dead.resetsAtMs).toBe(t0 + week); // the operator is still SHOWN the true weekly reset
    expect(plausiblyReset(dead, t0 + MAX_PROBE_WAIT_MS - 1)).toBe(false);
    expect(plausiblyReset(dead, t0 + MAX_PROBE_WAIT_MS + 1)).toBe(true);
  });

  it("the ceiling is longer than any 5h window, so a 5h-based block always waits for its real reset", () => {
    expect(MAX_PROBE_WAIT_MS).toBeGreaterThan(5 * 60 * 60_000);
  });
});

/**
 * ITEM B — THE FABRICATED NUMBER.
 *
 * `onDispatchFailure` stamped `resetsAtMs = nowMs + FALLBACK_COOLDOWN_MS` on EVERY classified death,
 * including the ones where nothing about a rate window was ever reported. That value is published on
 * `agent.status.availability.resetsAtMs` (lane-gate.ts's `emitAvailabilityStatus`) and crosses to the
 * room (`room-host-support.ts`'s `roomAgentStatusPayload`).
 *
 * WHAT IT COSTS, AS THE TREE STANDS NOW. Under the operator's 2026-08-24 ruling nothing paints a reset
 * clock any more, so the fabricated value can no longer be READ OUT — but it is still the instant the
 * terminal EXPIRES the health state on (`active_availability`). A text-only codex death therefore
 * unpainted `out of usage` fifteen minutes later, while the account stayed spent for days and the lane
 * went on refusing work. Same lie, quieter: the room stops saying the true thing instead of saying a
 * false one.
 *
 * The split: `resetsAtMs` is VENDOR-SOURCED ONLY; `probeAtMs` is the internal recovery deadline and is
 * never published. Recovery reachability is unchanged — that is what the second assertion in each case
 * is for.
 */
describe("B: a synthesized cooldown is internal, and never becomes a number the operator is shown", () => {
  const t0 = 10_000;

  it("a TEXT-ONLY death carries no reset instant at all, and still self-heals", () => {
    const dead = onDispatchFailure(initialAvailability(t0), CREDIT_STRING, t0 + 1);

    expect(
      dead.resetsAtMs,
      "a death with no vendor rate-window data published a reset instant - the terminal expires the red word on it, so the room stops saying `out of usage` while the lane is still refusing work",
    ).toBeUndefined();
    // ...and the lane still comes back on its own, which is the whole reason the fallback exists.
    expect(dead.probeAtMs).toBe(t0 + 1 + FALLBACK_COOLDOWN_MS);
    expect(plausiblyReset(dead, t0 + 1 + FALLBACK_COOLDOWN_MS - 1)).toBe(false);
    expect(plausiblyReset(dead, t0 + 1 + FALLBACK_COOLDOWN_MS + 1)).toBe(true);
  });

  it("a VENDOR window still crosses — the fix removes a lie, not the truth", () => {
    // The positive control. Without this the whole item could be "passed" by deleting the field.
    const dead = onDispatchFailure(initialAvailability(t0), CREDIT_STRING, t0 + 1, t0 + 100_000);
    expect(dead.resetsAtMs).toBe(t0 + 100_000);
    expect(dead.probeAtMs).toBe(t0 + 100_000);
  });

  it("a FAILED RETRY re-arms the cooldown internally without inventing a reset to paint", () => {
    const dead = onDispatchFailure(initialAvailability(t0), CREDIT_STRING, t0 + 1);
    const now = t0 + FALLBACK_COOLDOWN_MS + 3;
    const settled = onRetryFailed(onRetry(dead, now - 1), now);

    expect(
      settled.resetsAtMs,
      "the failed-retry edge invented its own reset instant - the same fabricated promise, one state later",
    ).toBeUndefined();
    expect(plausiblyReset(settled, now)).toBe(false);
    expect(plausiblyReset(settled, now + FALLBACK_COOLDOWN_MS + 1)).toBe(true);
  });
});

/** ITEM B, the two controls that keep the change from being "delete the field": a real window still
 *  travels, and a lane persisted by an earlier build still recovers. */
describe("B: the vendor's own number, and the records written before the split existed", () => {
  const t0 = 10_000;

  it("a failed retry KEEPS a vendor window that is still in the future", () => {
    // The other half of the control: a real weekly window survives a failed recovery attempt, because
    // dropping it would replace a true number with nothing and cost the operator the one useful fact.
    const week = 4 * 24 * 60 * 60_000;
    const dead = onDispatchFailure(initialAvailability(t0), CREDIT_STRING, t0 + 1, t0 + week);
    const now = t0 + FALLBACK_COOLDOWN_MS + 3;
    expect(onRetryFailed(onRetry(dead, now - 1), now).resetsAtMs).toBe(t0 + week);
    // ...and a vendor window that has already PASSED is dropped rather than painted as history.
    const stale = onDispatchFailure(initialAvailability(t0), CREDIT_STRING, t0 + 1, t0 + 2);
    expect(onRetryFailed(onRetry(stale, now - 1), now).resetsAtMs).toBeUndefined();
  });

  it("a record persisted BEFORE probeAtMs existed still recovers off its stored reset", () => {
    // The durability edge. `.zer0/lane-availability.json` outlives this change, and an entry written by
    // the old build carries resetsAtMs and no probeAtMs. Reading only probeAtMs would make
    // plausiblyReset false forever for those lanes — a lockout introduced by the fix for a lie.
    const legacy: LaneAvailability = {
      state: "exhausted",
      cause: "exhausted",
      resetsAtMs: t0 + 60_000,
      updatedMs: t0,
    };
    expect(plausiblyReset(legacy, t0 + 59_000)).toBe(false);
    expect(plausiblyReset(legacy, t0 + 61_000)).toBe(true);
  });
});
