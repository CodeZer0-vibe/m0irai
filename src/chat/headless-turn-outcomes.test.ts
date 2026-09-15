/**
 * @file src/chat/headless-turn-outcomes.test.ts
 * @purpose Falsifying contract for headless-turn-outcomes.ts: a completed lane's message carries its
 *   reply and finalizeLane's own minted id verbatim; a failed lane self-labels with a bounded,
 *   escaped reason and mints its OWN id when none was finalized; a completed outcome with no id is an
 *   invariant breach and throws rather than silently re-minting; and the merge only appends messages
 *   for outcomes that actually carried text.
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./headless-turn-outcomes, ./tower-bridge-lane, ./types
 *
 * MN round 2c (B-1): the round-2b split moved this real runtime logic out of headless-turn.ts with no
 * sibling test — three OTHER files already exercised it indirectly (headless-turn-errors.test.ts,
 * headless-turn-settle.test.ts, lane-message-identity.test.ts, all still passing, all left in place),
 * but none of them falsified the throw invariant below. These are ADDED, focused cases, not moved —
 * moving working tests out of files that also cover other concerns was the larger, riskier edit.
 */
import { describe, expect, it } from "vitest";
import {
  laneOutcomeMessage,
  mergeHeadlessOutcomes,
  safeLaneFailureReason,
} from "./headless-turn-outcomes.js";
import type { LaneOutcome } from "./tower-bridge-lane.js";
import type { ChatSession } from "./types.js";

function session(): ChatSession {
  return {
    id: "chat-outcomes-test",
    repoRoot: "/r",
    runDir: "/r/run",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    defaultAgent: "claude",
    lastAgent: null,
    summary: { text: "", throughTurn: 0 },
    messages: [],
  };
}

describe("laneOutcomeMessage: completed", () => {
  it("carries the reply text verbatim, the finalized id, and status completed", () => {
    const outcome: LaneOutcome = {
      agent: "claude",
      text: "the answer",
      exitCode: 0,
      state: "completed",
      messageId: "msg-finalized-1",
    };
    const message = laneOutcomeMessage(3, outcome);
    expect(message).toMatchObject({
      id: "msg-finalized-1",
      turn: 3,
      role: "agent",
      agent: "claude",
      text: "the answer",
      status: "completed",
    });
    expect(message.text.startsWith("⚠")).toBe(false);
  });

  it("FALSIFIER: a completed outcome with NO finalized id is an invariant breach and throws", () => {
    // The invariant this guards: every opened lane reaches finalizeLane, which mints the id BEFORE a
    // completed outcome can exist. A completed outcome that somehow arrives without one must not be
    // silently re-minted (that is the exact defect — W4-R3a — that put two ids on one reply).
    const outcome: LaneOutcome = {
      agent: "codex",
      text: "answer",
      exitCode: 0,
      state: "completed",
    };
    expect(() => laneOutcomeMessage(1, outcome)).toThrow(
      /completed outcome carries no finalized messageId/,
    );
  });
});

describe("laneOutcomeMessage: cancelled", () => {
  it("status is cancelled and the failure marker never applies, even with a nonzero exitCode", () => {
    const outcome: LaneOutcome = {
      agent: "gemini",
      text: "partial before the stop",
      exitCode: 1,
      state: "cancelled",
      messageId: "msg-cancel-1",
    };
    const message = laneOutcomeMessage(1, outcome);
    expect(message.status).toBe("cancelled");
    expect(message.text).toBe("partial before the stop");
    expect(message.text.startsWith("⚠")).toBe(false);
  });
});

describe("laneOutcomeMessage: failed", () => {
  it("self-labels with the failure marker + safeLaneFailureReason(error), and mints its OWN id when none was finalized", () => {
    const outcome: LaneOutcome = {
      agent: "codex",
      text: "half an answer",
      exitCode: 1,
      state: "failed",
      error: "max_tokens",
      // No messageId: a gate-blocked or never-settled lane legitimately never reached finalizeLane.
    };
    const message = laneOutcomeMessage(2, outcome);
    expect(message.status).toBe("failed");
    expect(message.text).toBe("⚠ dispatch failed: max_tokens");
    // The invariant this proves: a FAILED outcome does NOT throw for a missing id (only completed
    // does) — it mints a transcript-only one instead.
    expect(message.id.startsWith("msg-")).toBe(true);
    expect(message.id).toContain("-codex-");
  });

  it("prefers the finalized id over minting a new one when one IS present", () => {
    const outcome: LaneOutcome = {
      agent: "claude",
      text: "oops",
      exitCode: 1,
      state: "failed",
      error: "boom",
      messageId: "msg-already-finalized",
    };
    expect(laneOutcomeMessage(1, outcome).id).toBe("msg-already-finalized");
  });
});

describe("safeLaneFailureReason", () => {
  it("returns the fallback for undefined, null, and an empty string", () => {
    expect(safeLaneFailureReason(undefined)).toBe("lane failed");
    expect(safeLaneFailureReason(null)).toBe("lane failed");
    expect(safeLaneFailureReason("")).toBe("lane failed");
  });

  it("escapes control characters and bounds the length of hostile provider text", () => {
    const esc = String.fromCharCode(27); // ESC — kept out of the source as a literal byte
    const hostile = `boom${esc}[31m${"x".repeat(2_000)}`;
    const escaped = safeLaneFailureReason(hostile);
    // The raw ESC byte must not survive escaping — safe to print to a terminal.
    expect(escaped).not.toContain(esc);
    // maxLen 1_024, so the bounded output is well short of the original 2,000+ char input.
    expect(escaped.length).toBeLessThan(1_100);
    expect(escaped).toContain("boom");
  });

  it("passes an ordinary short reason through readably", () => {
    expect(safeLaneFailureReason("connection reset")).toBe("connection reset");
  });
});

describe("mergeHeadlessOutcomes", () => {
  it("appends one message per outcome that carried text, stamped with the given turn, in order", () => {
    const outcomes: LaneOutcome[] = [
      { agent: "claude", text: "first", exitCode: 0, state: "completed", messageId: "m-1" },
      { agent: "codex", text: "second", exitCode: 0, state: "completed", messageId: "m-2" },
    ];
    const next = mergeHeadlessOutcomes(session(), outcomes, 5);
    expect(
      next.messages.map((m) => ({ id: m.id, turn: m.turn, agent: m.agent, text: m.text })),
    ).toEqual([
      { id: "m-1", turn: 5, agent: "claude", text: "first" },
      { id: "m-2", turn: 5, agent: "codex", text: "second" },
    ]);
  });

  it("adds NO message for a text-less outcome (a completed lane with nothing to show)", () => {
    const outcomes: LaneOutcome[] = [
      { agent: "claude", text: "", exitCode: 0, state: "completed", messageId: "m-empty" },
      { agent: "codex", text: "kept", exitCode: 0, state: "completed", messageId: "m-kept" },
    ];
    const next = mergeHeadlessOutcomes(session(), outcomes, 1);
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]?.id).toBe("m-kept");
  });

  it("returns the ORIGINAL session unchanged when every outcome is text-less", () => {
    const base = session();
    const outcomes: LaneOutcome[] = [
      { agent: "claude", text: "", exitCode: 0, state: "completed", messageId: "m-empty" },
    ];
    const next = mergeHeadlessOutcomes(base, outcomes, 1);
    expect(next).toBe(base);
  });
});
