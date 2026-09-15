/**
 * @file src/chat/lane-gate.test.ts
 * @purpose F1 (FIX-3) unit contract for lane-gate.ts directly (the integration proof through runHeadlessTurn
 *   lives in lane-gate-dispatch.test.ts). Asserts gateLaneOrBlock's block/allow decision + its bus effects
 *   (a blocked lane emits dispatch.failed + agent.status availability, NEVER dispatch.started) and
 *   recordLaneDispatchResult's classify-on-death / clear-on-success, with a fake bus and a temp store dir.
 * @exports (none — test file)
 * @depends node:fs, node:os, node:path, vitest, ./events, ./lane-availability-store, ./lane-gate
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ChatEvent, ChatEventBus, type ChatEventKind } from "./events.js";
import {
  getLaneAvailability,
  initLaneAvailabilityStore,
  noteLaneFailure,
  noteLaneResetWindow,
  resetLaneAvailabilityStore,
} from "./lane-availability-store.js";
import { gateLaneOrBlock, recordLaneDispatchResult } from "./lane-gate.js";

const CREDIT =
  "Internal error: You're out of usage credits. Run /usage-credits to keep using Fable 5.";
const KINDS: readonly ChatEventKind[] = ["dispatch.started", "dispatch.failed", "agent.status"];
const dirs: string[] = [];

function freshCtx() {
  const dir = mkdtempSync(join(tmpdir(), "lane-gate-unit-"));
  dirs.push(dir);
  initLaneAvailabilityStore(dir);
  const bus = new ChatEventBus();
  const events: ChatEvent[] = [];
  for (const kind of KINDS) bus.on(kind, (e) => events.push(e));
  // FL-144: the gate context now carries the turn's abort signal (required, not optional). A never-aborted
  // controller is the LIVE case every assertion in this file is about — the cancelled case has its own
  // contract file, lane-gate-cancel.test.ts, and these tests are its anti-inversion neighbours.
  return {
    ctx: { bus, repoRoot: dir, turn: 7, nowMs: 1000, signal: new AbortController().signal },
    events,
  };
}

afterEach(() => {
  resetLaneAvailabilityStore();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("F1 lane-gate: gateLaneOrBlock", () => {
  it("a ready lane returns undefined (allow) and emits NOTHING (dispatch proceeds untouched)", async () => {
    const { ctx, events } = freshCtx();
    expect(await gateLaneOrBlock(ctx, "claude")).toBeUndefined();
    expect(events).toEqual([]);
  });

  it("a dead lane returns a blocked outcome + emits dispatch.failed & agent.status, NEVER dispatch.started", async () => {
    const { ctx, events } = freshCtx();
    noteLaneFailure("claude", CREDIT, 500);
    const blocked = await gateLaneOrBlock(ctx, "claude");
    expect(blocked?.exitCode).toBe(1);
    expect(blocked?.error).toContain("skipped");
    expect(events.some((e) => e.kind === "dispatch.started")).toBe(false);
    expect(events.some((e) => e.kind === "dispatch.failed")).toBe(true);
    const status = events.find((e) => e.kind === "agent.status");
    expect(status?.kind === "agent.status" ? status.availability?.state : undefined).toBe(
      "local_blocked",
    );
  });
});

describe("F1 lane-gate: recordLaneDispatchResult", () => {
  it("a credit failure marks the lane exhausted (durable) + emits its availability chip", () => {
    const { ctx, events } = freshCtx();
    recordLaneDispatchResult(ctx, "claude", {
      agent: "claude",
      text: "",
      exitCode: 1,
      state: "failed",
      error: CREDIT,
    });
    expect(getLaneAvailability("claude").state).toBe("exhausted");
    expect(events.some((e) => e.kind === "agent.status")).toBe(true);
  });

  it("an ordinary failure does NOT mark the lane dead (a transport hiccup is not exhaustion)", () => {
    const { ctx } = freshCtx();
    recordLaneDispatchResult(ctx, "claude", {
      agent: "claude",
      text: "",
      exitCode: 1,
      state: "failed",
      error: "stopReason=max_tokens",
    });
    expect(getLaneAvailability("claude").state).toBe("ready");
  });

  it("a success on a previously-dead lane clears it back to ready", () => {
    const { ctx } = freshCtx();
    noteLaneFailure("claude", CREDIT, 500);
    recordLaneDispatchResult(ctx, "claude", {
      agent: "claude",
      text: "ok",
      exitCode: 0,
      state: "completed",
    });
    expect(getLaneAvailability("claude").state).toBe("ready");
  });
});

// FIX-3c BLOCK 1: production-shaped. The carrier reports transport failures as GENERIC text
// (headless-carrier.ts's carrierFailureText -> "carrier failed"), which matches no death pattern — so an
// unclassified failed recovery used to leave the lane fully dispatchable forever.
describe("F1 lane-gate: a failed RECOVERY cannot restore normal dispatching", () => {
  const CARRIER_GENERIC = "carrier failed"; // exactly what headless-carrier emits for a transport failure

  it("an UNCLASSIFIED failure during a sanctioned retry re-blocks the lane (with a fresh cooldown)", async () => {
    const { ctx } = freshCtx();
    noteLaneFailure("claude", CREDIT, 500);
    // The window has plausibly reset -> the gate sanctions ONE recovery attempt.
    const retryCtx = { ...ctx, nowMs: 500 + 20 * 60_000 };
    expect(await gateLaneOrBlock(retryCtx, "claude")).toBeUndefined();
    expect(getLaneAvailability("claude").state).toBe("retrying");
    // ...and that attempt fails with text no classifier matches.
    recordLaneDispatchResult(retryCtx, "claude", {
      agent: "claude",
      text: "",
      exitCode: 1,
      state: "failed",
      error: CARRIER_GENERIC,
    });
    expect(getLaneAvailability("claude").state).toBe("exhausted"); // NOT left dispatchable
    // The very next send is blocked locally again — no burned child, no retry storm.
    expect(
      await gateLaneOrBlock({ ...retryCtx, nowMs: retryCtx.nowMs + 1 }, "claude"),
    ).toBeDefined();
  });
});

// The other half of the same rule: unclassified is decisive ONLY during a sanctioned retry. A healthy
// lane's transport hiccup must never fake exhaustion, and a retry that WORKS must still clear the lane.
describe("F1 lane-gate: an unclassified failure is decisive only DURING a retry", () => {
  const CARRIER_GENERIC = "carrier failed";

  it("an unclassified failure on a HEALTHY lane still does NOT mark it dead (no false exhaustion)", () => {
    const { ctx } = freshCtx();
    recordLaneDispatchResult(ctx, "claude", {
      agent: "claude",
      text: "",
      exitCode: 1,
      state: "failed",
      error: CARRIER_GENERIC,
    });
    expect(getLaneAvailability("claude").state).toBe("ready");
  });

  it("a retry that SUCCEEDS still clears the lane to ready", async () => {
    const { ctx } = freshCtx();
    noteLaneFailure("claude", CREDIT, 500);
    const retryCtx = { ...ctx, nowMs: 500 + 20 * 60_000 };
    await gateLaneOrBlock(retryCtx, "claude");
    recordLaneDispatchResult(retryCtx, "claude", {
      agent: "claude",
      text: "ok",
      exitCode: 0,
      state: "completed",
    });
    expect(getLaneAvailability("claude").state).toBe("ready");
  });
});

// W4-R2a-5 (defect 1, the operator's THIRD sighting of this class). The false `✗ gemini` renders from
// `auth`, which the boot probe sets to "down" (eager-session-boot.ts:106-115 ->
// use-cockpit-bus.ts:254-259). A lane has TWO health channels — probe `auth` and dispatch `availability`
// — and this recorder only ever updated one, so a lane whose probe failed kept painting red FOREVER,
// even in the same frame where it answered the operator.
describe("W4-R2a-5: a successful dispatch clears stale probe health, not just availability", () => {
  it("emits auth:ready on success — the evidence that a probe-down lane is reachable after all", () => {
    const { ctx, events } = freshCtx();
    recordLaneDispatchResult(ctx, "gemini", {
      agent: "gemini",
      text: "Hi! Gemini here, ready for the task.",
      exitCode: 0,
      state: "completed",
    });
    const auths = events.filter((e) => e.kind === "agent.status" && e.agent === "gemini");
    expect(auths.length, "no agent.status emitted at all").toBeGreaterThan(0);
    expect(
      auths.some((e) => e.kind === "agent.status" && e.auth === "ready"),
      "success never cleared the stale probe auth",
    ).toBe(true);
  });

  it("a FAILED dispatch never claims the lane is reachable", () => {
    const { ctx, events } = freshCtx();
    recordLaneDispatchResult(ctx, "gemini", {
      agent: "gemini",
      text: "",
      exitCode: 1,
      state: "failed",
      error: "carrier failed",
    });
    expect(events.some((e) => e.kind === "agent.status" && e.auth === "ready")).toBe(false);
  });

  it("a lane recovering from a REAL death clears both halves in one go", () => {
    const { ctx, events } = freshCtx();
    noteLaneFailure("claude", CREDIT, 500);
    recordLaneDispatchResult(ctx, "claude", {
      agent: "claude",
      text: "ok",
      exitCode: 0,
      state: "completed",
    });
    expect(getLaneAvailability("claude").state).toBe("ready");
    expect(events.some((e) => e.kind === "agent.status" && e.auth === "ready")).toBe(true);
  });
});

// FIX-2 (codex MAX BLOCK 3). The report claimed the auth-ready emit "structurally" preserved FIX-3b/3c
// precedence. That was OVERSTATED, and codex was right to call it: recordLaneDispatchResult on its own
// happily clears ANY non-ready durable state on success (:99-101). What actually protects the invariant
// is one layer up — the GATE. So the invariant is stated here as it really holds, and driven through the
// REAL pair (gateLaneOrBlock then recordLaneDispatchResult), never the recorder alone:
//
//   A hard state (exhausted / needs_auth / local_blocked) can NEVER reach the recorder. The only route
//   from a hard state to a dispatch runs through gateLaneOrBlock, which either refuses the send outright
//   or sanctions ONE retry — and a sanctioned retry transitions the lane to `retrying` BEFORE the
//   dispatch. So "a success cleared a hard state" is not a state the product can produce.
//
// THE OPERATOR-VISIBLE FAILURE this catches: an exhausted lane silently coming back to life and burning
// a child on every send because some future caller recorded a success against it.
const RESET_AT = 10_000;

describe("FIX-2: a hard availability state can never reach the recorder — the GATE is the guard", () => {
  it("a hard lane whose window has NOT reset is refused — no dispatch, and the death survives", async () => {
    const { ctx, events } = freshCtx();
    noteLaneFailure("claude", CREDIT, 500, RESET_AT);
    const blocked = await gateLaneOrBlock({ ...ctx, nowMs: 1000 }, "claude");
    expect(blocked?.exitCode, "the gate let a dead lane dispatch").toBe(1);
    // The recorder is never reached on this path, so it cannot clear anything.
    expect(getLaneAvailability("claude").state).toBe("local_blocked");
    expect(events.some((e) => e.kind === "dispatch.started")).toBe(false);
  });

  it("a SANCTIONED retry is already `retrying` by the time the recorder sees it — never still hard", async () => {
    const { ctx } = freshCtx();
    noteLaneFailure("claude", CREDIT, 500, RESET_AT);
    expect(getLaneAvailability("claude").state).toBe("exhausted");
    const allowed = await gateLaneOrBlock({ ...ctx, nowMs: RESET_AT + 1 }, "claude");
    expect(
      allowed,
      "the gate refused a plausibly-reset lane its one recovery attempt",
    ).toBeUndefined();
    // THE INVARIANT: the hard state is gone BEFORE any dispatch happens.
    expect(getLaneAvailability("claude").state).toBe("retrying");
  });

  it("and only THEN can a success clear it — which is recovery working, not precedence broken", async () => {
    const { ctx } = freshCtx();
    noteLaneFailure("claude", CREDIT, 500, RESET_AT);
    await gateLaneOrBlock({ ...ctx, nowMs: RESET_AT + 1 }, "claude");
    recordLaneDispatchResult(ctx, "claude", {
      agent: "claude",
      text: "ok",
      exitCode: 0,
      state: "completed",
    });
    expect(getLaneAvailability("claude").state).toBe("ready");
  });
});

// W4-R2b RULING 3, CLAUSE 2 (operator, 2026-07-27): "how about we just say its online, and if we send a
// message and doesnt go through we say offline and that it". Clause 1 (boot claims nothing) shipped at
// cc4de41 — it REMOVED gemini's `--version` probe, which was the only thing that ever marked a missing
// gemini. So until this block, a gemini that is NOT INSTALLED read `◇ gemini auto` forever while every
// single send failed: the same class of lie the probe removal fixed, pointing the other way.
//
// THE OPERATOR-VISIBLE FAILURE THESE CATCH: the operator types a message, nothing comes back, and the
// bottom bar still says gemini is fine.
//
// THE FIXTURE IS CAPTURED, NOT IMAGINED (READ-WHAT-IS clause 4). `agyExePath()` throws this exact
// sentence when the Antigravity CLI is absent (src/adapters/pty/agy-pty-spawn.ts:23-25); it is reached on
// EVERY gemini send — carrier path via agy.ts:291/:295 -> agy-carrier.ts:88 -> the catch at
// headless-carrier.ts:122-125 (which PRESERVES error.message), non-carrier path via headless-turn.ts:218-
// 220 — and lands in `outcome.error` (tower-bridge-lane.ts:159-165). Captured live by running the real
// resolver with LOCALAPPDATA pointed at a directory that does not exist:
//   agy-pty-spawn: agy.exe not found at "C:\nonexistent-agy-root\agy\bin\agy.exe" (Antigravity CLI not installed)
const AGY_MISSING =
  'agy-pty-spawn: agy.exe not found at "C:\\Users\\op\\AppData\\Local\\agy\\bin\\agy.exe" (Antigravity CLI not installed)';
// The OTHER two live shapes, same source (referee verdict, file:line): a spawn that throws after the path
// resolves (agy-runner.ts:74-80) and the structured carrier outcome (headless-carrier.ts:346-348).
const AGY_SHAPES: readonly string[] = [
  AGY_MISSING,
  "agy spawn failed: EPERM: operation not permitted",
  "carrier failed",
];

describe("RULING 3 clause 2: a send that does not go through reads offline", () => {
  for (const text of AGY_SHAPES) {
    it(`an UNCLASSIFIED failure marks the chip down — "${text.slice(0, 28)}…"`, () => {
      const { ctx, events } = freshCtx();
      recordLaneDispatchResult(ctx, "gemini", {
        agent: "gemini",
        text: "",
        exitCode: 1,
        state: "failed",
        error: text,
      });
      const down = events.filter(
        (e) => e.kind === "agent.status" && e.agent === "gemini" && e.auth === "down",
      );
      expect(down.length, `no auth:down emitted for:\n  ${text}`).toBe(1);
    });
  }
});

describe("RULING 3 clause 2: ...and the operator is never locked out by it", () => {
  // THE ANTI-LOCKOUT FALSIFIER (FIX-3c's invariant, and the reason this uses `auth` and not the
  // availability state machine): the chip tells the truth AND the operator's next message still goes out.
  it("the SAME failure leaves the lane unblocked — the next send is allowed through", async () => {
    const { ctx } = freshCtx();
    recordLaneDispatchResult(ctx, "gemini", {
      agent: "gemini",
      text: "",
      exitCode: 1,
      state: "failed",
      error: AGY_MISSING,
    });
    expect(getLaneAvailability("gemini").state, "a transport failure faked a death").toBe("ready");
    expect(
      await gateLaneOrBlock({ ...ctx, nowMs: ctx.nowMs + 1 }, "gemini"),
      "the operator was locked out of the lane by a display-only failure",
    ).toBeUndefined();
  });

  it("and the next SUCCESS puts the chip back — offline is a fact about the last send, not a verdict", () => {
    const { ctx, events } = freshCtx();
    recordLaneDispatchResult(ctx, "gemini", {
      agent: "gemini",
      text: "",
      exitCode: 1,
      state: "failed",
      error: AGY_MISSING,
    });
    recordLaneDispatchResult(ctx, "gemini", {
      agent: "gemini",
      text: "Hi! Gemini here.",
      exitCode: 0,
      state: "completed",
    });
    const auths = events.filter((e) => e.kind === "agent.status" && e.agent === "gemini");
    const last = auths.at(-1);
    expect(last?.kind === "agent.status" ? last.auth : undefined).toBe("ready");
  });
});

// AM-4's masking risk, answered STRUCTURALLY rather than documented away: `auth:"down"` outranks
// `availability:"retrying"` in cellHealth (status-agent-cell.tsx:103 before :109), so setting auth down on
// the retry branch would paint a recovery attempt as unreachable. The retry branch is left to the
// availability machine alone — it already returns the lane to its hard death state, which outranks auth
// anyway, so nothing is lost and nothing is masked.
describe("RULING 3 clause 2: the chip stays out of the recovery machine's way", () => {
  it("a failed SANCTIONED RETRY is still the availability machine's business, not the chip's", async () => {
    const { ctx, events } = freshCtx();
    noteLaneFailure("claude", CREDIT, 500);
    const retryCtx = { ...ctx, nowMs: 500 + 20 * 60_000 };
    await gateLaneOrBlock(retryCtx, "claude");
    const before = events.length;
    recordLaneDispatchResult(retryCtx, "claude", {
      agent: "claude",
      text: "",
      exitCode: 1,
      state: "failed",
      error: "carrier failed",
    });
    expect(getLaneAvailability("claude").state).toBe("exhausted"); // FIX-3c, unchanged
    expect(
      events.slice(before).some((e) => e.kind === "agent.status" && e.auth === "down"),
      "the retry branch emitted auth:down and can now mask a retrying lane",
    ).toBe(false);
  });
});

// FIX-2's other half (codex MAX note): `retrying` -> ambient precedence exists in the renderer
// (status-agent-cell.ts's cellHealth) but NO producer ever published `retrying` — the gate transitioned
// the lane durably and emitted nothing, so that branch was dead code in production.
// THE OPERATOR-VISIBLE FAILURE: a lane frozen on its death colour for the whole recovery attempt, then
// jumping straight to healthy — no sign anything was being tried on their behalf.
describe("FIX-2: a recovery attempt is VISIBLE while it is in flight", () => {
  it("the gate emits `retrying`, and the death reason rides along so /status keeps its truth", async () => {
    const { ctx, events } = freshCtx();
    noteLaneFailure("claude", CREDIT, 500, RESET_AT);
    await gateLaneOrBlock({ ...ctx, nowMs: RESET_AT + 1 }, "claude");
    const retrying = events.filter(
      (e) => e.kind === "agent.status" && e.availability?.state === "retrying",
    );
    expect(retrying.length, "the recovery attempt was invisible to the operator").toBe(1);
    const first = retrying[0];
    expect(
      first?.kind === "agent.status" ? first.availability?.reason : undefined,
      "/status lost the death reason during the retry",
    ).toBeDefined();
  });

  it("a HEALTHY lane's ordinary send emits nothing at all (no retry noise on the happy path)", async () => {
    const { ctx, events } = freshCtx();
    expect(await gateLaneOrBlock(ctx, "claude")).toBeUndefined();
    expect(events).toEqual([]);
  });
});

/**
 * ITEM B AT THE PUBLISH DOOR. The pure model's falsifiers live in lane-availability.test.ts; this is the
 * one that matters to the operator, because `emitAvailabilityStatus` is where an internal number would
 * cross onto `agent.status` — from there `room-host-support.ts`'s `roomAgentStatusPayload` copies it
 * unchanged to the room wire, and the terminal RETIRES the painted health state the moment that instant
 * passes (`active_availability`). Nothing paints a clock any more, so this is the whole of what a
 * fabricated instant would still cost: the red word vanishing on a timer nobody reported.
 */
describe("B: no synthesized reset instant crosses onto agent.status", () => {
  const availabilityOf = (events: readonly ChatEvent[]) =>
    events
      .filter((e) => e.kind === "agent.status")
      .map((e) => (e.kind === "agent.status" ? e.availability : undefined))
      .filter((a) => a !== undefined);

  it("a death with NO vendor window publishes a state and no reset at all", () => {
    const { ctx, events } = freshCtx();
    recordLaneDispatchResult(ctx, "claude", {
      agent: "claude",
      text: "",
      exitCode: 1,
      state: "failed",
      error: CREDIT,
    });

    const published = availabilityOf(events);
    expect(published.length, "no availability was published at all").toBeGreaterThan(0);
    for (const a of published) {
      expect(a?.state).toBe("exhausted");
      expect(
        a?.resetsAtMs,
        "the fallback cooldown crossed onto the wire - the terminal expires the health state on it, so `out of usage` disappears 15 minutes into a multi-day exhaustion",
      ).toBeUndefined();
    }
  });

  it("a death WITH a vendor window still publishes it (the fix removes a lie, not the truth)", () => {
    const { ctx, events } = freshCtx();
    noteLaneResetWindow("claude", RESET_AT);
    recordLaneDispatchResult(ctx, "claude", {
      agent: "claude",
      text: "",
      exitCode: 1,
      state: "failed",
      error: CREDIT,
    });

    expect(availabilityOf(events).some((a) => a?.resetsAtMs === RESET_AT)).toBe(true);
  });
});

it("B/ruling: the blocked-send notice names the cause and never a clock", async () => {
  // OPERATOR RULING, 2026-08-24: "keep it simple, just show out of usage and that's it." The terminal's
  // health phrase was cut to the bare word; this is the OTHER string the operator reads about the same
  // fact, and it used to append ` Resets around 10:04:00 AM.` whenever an instant was known. Nothing
  // pinned that clause, which is why it survived the first pass at this ruling.
  //
  // A VENDOR window is set deliberately — the input that used to produce the clock. It must change
  // nothing the operator sees, while still bounding the recovery probe internally.
  const { ctx } = freshCtx();
  noteLaneResetWindow("claude", RESET_AT);
  noteLaneFailure("claude", CREDIT, 500);

  const blocked = await gateLaneOrBlock(ctx, "claude");

  expect(blocked?.error, "the skip stopped naming its cause").toContain(
    "this lane is out of usage for now",
  );
  expect(
    blocked?.error,
    "the blocked-send notice still promises a reset time - the footer says `out of usage` and the feed one row below contradicts it with a clock",
  ).not.toMatch(/resets/i);
  // The instant is not gone, only unshown: it still bounds the probe.
  expect(getLaneAvailability("claude").resetsAtMs).toBe(RESET_AT);
});
