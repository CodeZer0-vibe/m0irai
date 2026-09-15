/**
 * @file src/chat/lane-availability.ts
 * @purpose F1 (FIX-3): the PURE lane-availability model — the durable state machine turning a claude lane's
 *   dispatch REALITY into a visible, recoverable state (classifier + transitions). Pure + deterministic
 *   (mirrors turn-lifecycle.ts); the store + gate consume it. Field: chat-1784553379589 turns 25/26/48-52.
 * @exports LaneAvailabilityState, LaneFailureClass, LaneAvailability, FALLBACK_COOLDOWN_MS, classifyLaneFailure,
 *   initialAvailability, isLaneBlocked, isSessionEndedFailure, plausiblyReset, onDispatchFailure, onBlockedSend,
 *   onRetry, onRetryFailed, onDispatchSuccess, reasonForClass
 * @depends (none — pure model)
 */

/** The durable availability of one lane. `ready` is the brief's ACTIVE/READY (available); the rest block
 *  sends. `local_blocked` is EXHAUSTED/NEEDS_AUTH after the operator has been notified and sends are being
 *  refused locally; `retrying` is a re-attempt in flight (reset-window plausible OR explicit operator retry). */
export type LaneAvailabilityState =
  | "ready"
  | "exhausted"
  | "needs_auth"
  | "local_blocked"
  | "retrying";

/** The two death causes F1 classifies from the child-CLI error text. */
export type LaneFailureClass = "exhausted" | "needs_auth";

/** One lane's full availability record (persisted per project+agent; see lane-availability-store.ts). */
export interface LaneAvailability {
  readonly state: LaneAvailabilityState;
  /** The death cause, carried through local_blocked/retrying so recovery knows whether a needs_auth
   *  reconnect cycle is required (vs an exhausted lane that just waits for its window). Absent when ready. */
  readonly cause?: LaneFailureClass;
  /** zer0-worded reason for the chrome — NEVER the raw child-CLI remediation string. Absent when ready. */
  readonly reason?: string;
  /**
   * epoch ms the rate window resets, AS THE VENDOR REPORTED IT — the rate-window data zer0 already
   * decodes, and nothing else. Absent when the vendor said nothing.
   *
   * IT IS NEVER SHOWN TO THE OPERATOR. Under the operator's 2026-08-24 ruling ("keep it simple, just
   * show out of usage and that's it") no reset clock reaches any painted string: `health_phrase`
   * returns the bare word (`rust/.../app/room_runtime.rs`) and `blockedNotice` (lane-gate.ts) dropped
   * its `Resets around …` clause. This value crosses the wire for exactly one reason, and it is not
   * display: the terminal's `active_availability` reads a reset that has PASSED as "this health state
   * is over" and retires the red word on it.
   *
   * WHICH IS WHY NOTHING MAY SYNTHESIZE ONE. The fallback cooldown used to be written here, so a
   * text-only death carried `now + 15 min` — and fifteen minutes later the terminal quietly UNPAINTED
   * `out of usage` for an account the vendor had said was spent for days. The lane went on refusing
   * work while the room showed it healthy. (Before the ruling the same fabricated value was also
   * painted outright as `resets in 15m`; that half is now impossible by construction, and this half
   * is what the vendor-only rule still buys.) Absent, the state stays painted until the lane genuinely
   * recovers, which is the honest default.
   */
  readonly resetsAtMs?: number;
  /**
   * epoch ms at which a recovery probe becomes due — the vendor window when there is one, else the
   * conservative fallback cooldown. INTERNAL: read only by {@link plausiblyReset}, and never published
   * to the chrome, the room wire, or the operator's blocked-send notice.
   *
   * Split out of `resetsAtMs` by item B. The two values used to be one field serving two jobs that
   * disagree: "when may this lane try again" tolerates a guess, "when does the room stop believing
   * this lane is dead" does not. Absent only on a record persisted before this field existed — see
   * {@link plausiblyReset}.
   */
  readonly probeAtMs?: number;
  /** epoch ms of the last state change (durability + staleness). */
  readonly updatedMs: number;
}

// The death-cause matchers over the child-CLI error text. Credit/quota exhaustion and auth are the only
// two classes that mark a lane DEAD (an ordinary transport/timeout failure does NOT — it stays ready).
// Matched case-insensitively on the STABLE signal words, never the exact vendor sentence (which drifts).
//
// "usage limit" is the operator's 15:20 codex sighting: "You've hit your usage limit. Upgrade to Pro …
// or try again at Aug 27th, 2026 8:54 AM." Two stable words out of that sentence, not the sentence and
// not "hit your usage limit" — the same vocabulary upstream grok uses for its own paywall copy
// (D:/grok-ref/crates/codegen/xai-grok-shell/src/sampling/error.rs:38, and the pager's "You hit your
// free usage limit." at app/dispatch/billing.rs:275). It is deliberately NOT narrowed by a vendor
// prefix: this classifier is shared by every lane and the next CLI will word it differently again.
//
// THE FALSE-POSITIVE GUARD IS THE CALLER, not this pattern. An agent can say "usage limit" in an
// ordinary answer, and that turn ends `end_turn` — lane-send-outcome.ts only ever offers the delivered
// text to this classifier on a turn that ALREADY failed, so a healthy reply is never read for a death.
const EXHAUSTED_PATTERN =
  /out of (usage )?credits|usage credits|usage limit|rate limit|quota|insufficient/i;
const NEEDS_AUTH_PATTERN =
  /authentication required|not authenticated|auth(?:entication)? (?:failed|expired)|please (?:re-?)?login|sign ?in required/i;

/**
 * The CONSERVATIVE self-heal cooldown applied when a death carries NO known reset window. After it elapses,
 * plausiblyReset lets the next send through as ONE recovery attempt — so an operator who walks away recovers
 * WITHOUT a restart. Bounded: at most one re-probe per cooldown (the gate blocks in between), never per send.
 * The field bug this closes: production only ever recorded a 3-arg failure (no resetsAtMs), so absent this a
 * classified death blocked the lane FOREVER — a restart reloaded the same block. A REAL reset time (from the
 * rate-window data zer0 already decodes) always wins over this fallback. 15 min balances "re-probe too often
 * → burn dispatches" against "wait too long"; it is a single tunable knob.
 */
export const FALLBACK_COOLDOWN_MS: number = 15 * 60_000;

/**
 * Classify a dispatch failure's error text into a death class + a zer0-worded reason, or undefined for an
 * ordinary failure (transport/timeout/refusal) that must NOT mark the lane dead. Auth is checked FIRST so
 * a message carrying both signals is treated as the recoverable-by-reconnect case.
 */
export function classifyLaneFailure(
  errorText: string,
): { readonly class: LaneFailureClass; readonly reason: string } | undefined {
  if (NEEDS_AUTH_PATTERN.test(errorText)) {
    return { class: "needs_auth", reason: reasonForClass("needs_auth") };
  }
  if (EXHAUSTED_PATTERN.test(errorText)) {
    return { class: "exhausted", reason: reasonForClass("exhausted") };
  }
  return undefined;
}

/**
 * BLOCK 3 (FIX-3b): the bridge adapter's OWN permanent-death signals. Once
 * `@agentclientprotocol/claude-agent-acp` marks a session `queryClosed` (dist/acp-agent.js:1981-1988 —
 * reached from the consumer's stream-done path :886 and its error paths :1872/:1878), EVERY later
 * `prompt()` on that session id throws SESSION_ENDED_MESSAGE (dist/acp-agent.js:108, raised at :579-581)
 * and the session can NEVER serve another turn. The bridge CHILD survives that, so
 * `conn.isAlive()` (acp-lane-connection.ts:203 — a process-level fact) keeps reporting a usable hold and
 * lane-transport's already-held fast path re-serves the dead session until the app is restarted. This
 * predicate is the missing bridge between those two facts: it names the failures that PROVE the held
 * session is unusable, so the transport can drop the hold and reconnect.
 * Deliberately NARROW — an ordinary rejection/timeout must NOT trigger a respawn (per-turn respawn is the
 * carrier's explicit anti-target, lane-carrier.ts:336). Matched on the stable phrases of the adapter's two
 * strings ("… session has ended. Please start a new session." / "… process exited unexpectedly. Please
 * start a new session.") rather than either exact sentence, which drifts across adapter versions.
 */
const SESSION_ENDED_PATTERN = /session has ended|process exited unexpectedly|start a new session/i;

/** Whether this failure text proves the held bridge session can never accept another prompt (see above). */
export function isSessionEndedFailure(errorText: string): boolean {
  return SESSION_ENDED_PATTERN.test(errorText);
}

/** The zer0 words for a death class — the ONLY reason text that ever reaches the chrome (the raw child-CLI
 *  remediation, e.g. "Run /usage-credits", is never surfaced verbatim). */
export function reasonForClass(cls: LaneFailureClass): string {
  return cls === "needs_auth"
    ? "this lane's sign-in expired — it needs to reconnect"
    : "this lane is out of usage for now";
}

/** The fresh, available state (the brief's ACTIVE). */
export function initialAvailability(nowMs: number): LaneAvailability {
  return { state: "ready", updatedMs: nowMs };
}

/** A state where a send MUST be blocked locally (no child dispatch burned): the two death states plus the
 *  post-notice local_blocked. `retrying` is NOT blocked — a retry is exactly the one send allowed through. */
export function isLaneBlocked(a: LaneAvailability): boolean {
  return a.state === "exhausted" || a.state === "needs_auth" || a.state === "local_blocked";
}

/**
 * FIX-3c BLOCK 5: the LIVENESS bound on a block. `resetsAtMs` is now the BINDING window's true instant
 * (statusline-payload's bindingResetAtMs), which for a weekly exhaustion is DAYS away — correct to SHOW the
 * operator, but dangerous to obey blindly: the block is durable, so a restart reloads it and a wrong weekly
 * reading would lock the lane out with no way back (there is no operator retry command until W4-R2). So a
 * probe is allowed at the binding reset OR after this ceiling, whichever comes first. 6h is deliberately
 * longer than any 5-hour window (a 5h-based block always waits for its real reset) and bounds a wrong
 * weekly reading to hours instead of days. Cost is ~4 probe dispatches/day at worst, against 96/day under
 * the old flat 15-minute fallback.
 */
export const MAX_PROBE_WAIT_MS: number = 6 * 60 * 60_000;

/**
 * Whether a probe is due: the probe deadline has passed, or the block has sat longer than the liveness
 * ceiling above. No deadline at all → never auto-plausible. A ready lane is never "reset".
 *
 * ITEM B: it reads {@link LaneAvailability.probeAtMs}, and falls back to `resetsAtMs` for ONE reason —
 * `.zer0/lane-availability.json` outlives this change, and an entry written by an earlier build carries
 * only the old merged field. Reading probeAtMs alone would make this false forever for those lanes, so
 * the fix for a fabricated number would have shipped a lockout. Not a general "either field" rule: on
 * every record this process writes, probeAtMs is set.
 */
export function plausiblyReset(a: LaneAvailability, nowMs: number): boolean {
  const due = a.probeAtMs ?? a.resetsAtMs;
  if (a.state === "ready" || due === undefined) {
    return false;
  }
  return nowMs >= Math.min(due, a.updatedMs + MAX_PROBE_WAIT_MS);
}

/**
 * A dispatch FAILED with `errorText`. Credit/auth → the matching death state (carrying the zer0 reason +
 * any known reset time); an unclassified failure leaves the lane unchanged (transport hiccups don't kill
 * it). Applies from ANY prior state, so a retry that fails re-enters the death class.
 */
export function onDispatchFailure(
  prev: LaneAvailability,
  errorText: string,
  nowMs: number,
  resetsAtMs?: number,
): LaneAvailability {
  const classified = classifyLaneFailure(errorText);
  if (classified === undefined) {
    return prev;
  }
  // ITEM B: TWO FIELDS, because the two questions disagree. `resetsAtMs` is set ONLY when the vendor
  // actually reported a window, because it is what the terminal EXPIRES the painted health state on —
  // a synthesized one would unpaint `out of usage` on a lane that is still refusing work. `probeAtMs`
  // is when this lane may try again and always exists, so recovery stays reachable with no restart
  // (see FALLBACK_COOLDOWN_MS). Neither is ever shown: no reset clock is painted anywhere.
  // DELTA ITEM 2: and the window is filtered before either field sees it — see usableResetWindow.
  const window = usableResetWindow(classified.class, resetsAtMs, nowMs);
  return {
    state: classified.class,
    cause: classified.class,
    reason: classified.reason,
    ...(window === undefined ? {} : { resetsAtMs: window }),
    probeAtMs: window ?? nowMs + FALLBACK_COOLDOWN_MS,
    updatedMs: nowMs,
  };
}

/**
 * DELTA ITEM 2 — THE TWO SCOPES A RESET INSTANT HAS TO PASS, and it had neither.
 *
 * The store remembers the last window the usage stream reported (`knownResetWindow`), forever, and used
 * to offer it to every classified death. That is wrong twice over:
 *
 * CAUSE. A rate window says when a QUOTA comes back. It says nothing about an expired sign-in, which
 * returns when the operator reconnects and not before. Attaching one to a `needs_auth` death gave that
 * death an expiry it does not have — and on the terminal side `active_availability` reads a passed
 * instant as "this health state is over", so the lane would quietly stop painting `needs sign-in` while
 * still refusing every send.
 *
 * FRESHNESS. A window whose instant is already behind us is not a window, it is a memory of one. Left
 * attached it becomes `probeAtMs` in the past, `plausiblyReset` is true immediately, and the very next
 * send — and every send after it — is allowed through as "the recovery probe". That is one real
 * dispatch per message at a lane the vendor has just refused, which is exactly the burn the fallback
 * cooldown exists to bound.
 *
 * Neither check belongs in the store: the store does not know the death class, and this is the one
 * function where the class and the instant are both in hand.
 */
function usableResetWindow(
  cls: LaneFailureClass,
  resetsAtMs: number | undefined,
  nowMs: number,
): number | undefined {
  if (cls !== "exhausted" || resetsAtMs === undefined) return undefined;
  return resetsAtMs > nowMs ? resetsAtMs : undefined;
}

/**
 * A send arrived at an already-dead lane and was BLOCKED locally (no child burned). The first such send
 * moves EXHAUSTED/NEEDS_AUTH → LOCAL_BLOCKED (the operator has now been told); further blocked sends stay
 * LOCAL_BLOCKED. A ready/retrying lane is not a blocked send — returned unchanged (defensive).
 */
export function onBlockedSend(prev: LaneAvailability, nowMs: number): LaneAvailability {
  if (!isLaneBlocked(prev)) {
    return prev;
  }
  return { ...prev, state: "local_blocked", updatedMs: nowMs };
}

/** An attempt to recover (reset-window plausible OR explicit operator retry): the death state → RETRYING,
 *  preserving the cause so the caller knows whether to force a fresh connection (needs_auth reconnect). A
 *  ready lane has nothing to retry (unchanged). */
export function onRetry(prev: LaneAvailability, nowMs: number): LaneAvailability {
  if (prev.state === "ready") {
    return prev;
  }
  return { ...prev, state: "retrying", updatedMs: nowMs };
}

/**
 * FIX-3c BLOCK 1: the sanctioned recovery attempt FAILED — for any reason, classified or not. `retrying` is
 * deliberately NOT a blocked state (it is the one send allowed through), so without this edge an
 * unclassified failure during a retry left the lane fully dispatchable forever: the zombie in a new shape,
 * burning a child on every send. Unclassified is the COMMON case, not an edge one — the carrier collapses
 * transport failures to generic text (headless-carrier.ts's carrierFailureText).
 * The lane returns to the state it was recovering FROM (its cause, keeping the truthful zer0 reason) and
 * gets a FRESH cooldown so the next send cannot immediately re-probe. A known real window is honoured only
 * while it is still in the FUTURE — a window already in the past would make plausiblyReset true again
 * instantly and turn recovery into a retry storm. Applies ONLY to a retrying lane; anything else is
 * returned unchanged (a healthy lane's hiccup is not a death).
 *
 * ITEM B: the fresh cooldown goes to `probeAtMs`, never to the painted `resetsAtMs` — this edge used to
 * be the SECOND place a fabricated instant entered the chrome, and it reached it one state later than
 * onDispatchFailure so the wrong number arrived after the operator had already been told a different
 * one. Built field-by-field rather than spread over `prev`, because a spread cannot UNSET a stale
 * vendor window and exactOptionalPropertyTypes forbids writing `resetsAtMs: undefined` over it.
 */
export function onRetryFailed(
  prev: LaneAvailability,
  nowMs: number,
  knownResetsAtMs?: number,
): LaneAvailability {
  if (prev.state !== "retrying") {
    return prev;
  }
  const vendorReset = survivingVendorReset(prev, nowMs, knownResetsAtMs);
  return {
    state: prev.cause ?? "local_blocked",
    ...(prev.cause === undefined ? {} : { cause: prev.cause }),
    ...(vendorReset === undefined ? {} : { resetsAtMs: vendorReset }),
    probeAtMs: vendorReset ?? nowMs + FALLBACK_COOLDOWN_MS,
    reason: prev.reason ?? "this lane's last recovery attempt did not go through",
    updatedMs: nowMs,
  };
}

/**
 * ITEM B: the reset instant a failed retry may still CARRY — a vendor value or nothing, never a guess.
 *
 * A newly reported window wins, but only when it is further out than the fresh cooldown: a nearer one
 * would let the very next send re-probe and turn recovery into a storm, which is the trade the old code
 * made by clamping to the floor. The lane's EXISTING window survives when it has not passed yet, so a
 * true weekly reset is not thrown away because one recovery attempt failed. A window already in the
 * PAST is dropped rather than kept, and that one matters most: on the terminal side
 * `active_availability` reads a passed reset as "this health state is over", so keeping a stale
 * instant would unpaint the red word on a lane this function has just re-confirmed as blocked.
 */
function survivingVendorReset(
  prev: LaneAvailability,
  nowMs: number,
  knownResetsAtMs?: number,
): number | undefined {
  // DELTA ITEM 2: the same cause scope onDispatchFailure applies, applied here too because this edge
  // rebuilds the record from scratch and would otherwise be the one remaining door a quota window could
  // walk through onto a sign-in death. A record persisted by an older build can still carry one, so the
  // stored value is filtered on the way out as well as on the way in.
  if (prev.cause !== "exhausted") return undefined;
  if (knownResetsAtMs !== undefined && knownResetsAtMs > nowMs + FALLBACK_COOLDOWN_MS) {
    return knownResetsAtMs;
  }
  return prev.resetsAtMs !== undefined && prev.resetsAtMs > nowMs ? prev.resetsAtMs : undefined;
}

/** A REAL successful dispatch/open: the lane is genuinely alive again → READY, clearing the cause/reason/
 *  reset. This is the ONLY edge into ready from a death/retrying state (a model claim never sets it). */
export function onDispatchSuccess(_prev: LaneAvailability, nowMs: number): LaneAvailability {
  return { state: "ready", updatedMs: nowMs };
}
