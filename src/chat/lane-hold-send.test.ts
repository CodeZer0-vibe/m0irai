/**
 * @file src/chat/lane-hold-send.test.ts
 * @purpose ONE held send, at the seam it was extracted to. Two things are load-bearing here and neither
 *   is visible from the transport tests that drive this through `createCockpitLaneTransport`: that a
 *   turn classifies from ITS OWN generation's text however the hold has moved underneath it, and that
 *   the turn stops recording the moment it settles.
 * @exports (none — test file)
 * @depends vitest, ./lane-hold-send, ./lane-send-outcome
 */
import { expect, it } from "vitest";
import { type Held, sendOnHold } from "./lane-hold-send.js";
import { createTurnTextRecorder } from "./lane-send-outcome.js";

/** The operator's own codex row at 15:20, verbatim. */
const VENDOR_LIMIT_TEXT =
  "You’ve hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again at Aug 27th, 2026 8:54 AM.";

/** A held connection whose `prompt` runs `duringTurn` before settling, so a test can deliver text (its
 *  own or another generation's) at the exact moment the real bridge would. */
function heldConnection(input: {
  readonly epoch: number;
  readonly stopReason?: string;
  readonly rejectWith?: unknown;
  readonly duringTurn?: () => void;
  readonly alive?: boolean;
}): Held {
  return {
    epoch: input.epoch,
    sessionId: "s-held",
    conn: {
      isAlive: () => input.alive ?? true,
      prompt: async () => {
        input.duringTurn?.();
        if (input.rejectWith !== undefined) throw input.rejectWith;
        return input.stopReason ?? "refusal";
      },
    } as never,
  };
}

it("a send with no live hold fails as transport without touching the recorder", async () => {
  const text = createTurnTextRecorder();
  const result = await sendOnHold({
    held: undefined,
    text,
    agent: "codex",
    dropHold: async () => undefined,
    prompt: "hello",
    sessionId: "s-held",
  });

  expect(result).toEqual({
    outcome: "failed",
    reason: "transport",
    message: "no live lane session held - the carrier decides resume-or-fresh, never send",
  });
  expect(text.delivered(1), "a send that never ran opened a turn buffer anyway").toBe("");
});

it("DELTA 4: the turn classifies from its OWN generation, not from whoever holds the lane", async () => {
  // The extracted half of the delta finding. Generation 3's prompt is in flight; a newer connection
  // (generation 9) opens and begins its own turn underneath it; THEN generation 3's own limit sentence
  // — already on its wire — arrives. It is generation 3's turn that must classify on it.
  const forwarded: string[] = [];
  const text = createTurnTextRecorder((chunk) => forwarded.push(chunk));
  const held = heldConnection({
    epoch: 3,
    duringTurn: () => {
      text.begin(9); // a newer connection takes the lane and starts its own turn
      text.sinkFor(3)(VENDOR_LIMIT_TEXT); // ...and the older one's own text lands after that
    },
  });

  const result = await sendOnHold({
    held,
    text,
    agent: "codex",
    dropHold: async () => undefined,
    prompt: "am I still allowed",
    sessionId: "s-held",
  });

  expect(
    result.outcome === "failed" ? result.reason : undefined,
    "the draining turn's own limit sentence was read as someone else's, or discarded",
  ).toBe("quota");
  expect(forwarded, "the draining turn's own text never reached the operator's row").toEqual([
    VENDOR_LIMIT_TEXT,
  ]);
  expect(text.delivered(9), "the live turn inherited the draining turn's text").toBe("");
});

it("a settled turn stops recording, so its late chunk cannot decide the next one", async () => {
  const forwarded: string[] = [];
  const text = createTurnTextRecorder((chunk) => forwarded.push(chunk));
  await sendOnHold({
    held: heldConnection({ epoch: 3, stopReason: "end_turn" }),
    text,
    agent: "codex",
    dropHold: async () => undefined,
    prompt: "hello",
    sessionId: "s-held",
  });

  // The child is still dying with a chunk on the wire. Its turn is over; this belongs to nothing.
  text.sinkFor(3)(VENDOR_LIMIT_TEXT);
  expect(text.delivered(3), "a settled turn kept recording after its own classification").toBe("");
  expect(forwarded, "a settled turn's late chunk was painted into the operator's row").toEqual([]);
});

it("the rejection path reads the same generation's text as the stop-reason path", async () => {
  // Both endings a send has must read one buffer. A rejection that reached for a different generation
  // would lose exactly the codex limit death, which rejects with an opaque `Internal error` and has the
  // vendor's sentence only in the streamed text.
  const text = createTurnTextRecorder();
  const result = await sendOnHold({
    held: heldConnection({
      epoch: 5,
      rejectWith: new Error("Internal error"),
      duringTurn: () => text.sinkFor(5)(VENDOR_LIMIT_TEXT),
    }),
    text,
    agent: "codex",
    dropHold: async () => undefined,
    prompt: "hello",
    sessionId: "s-held",
  });

  expect(result.outcome === "failed" ? result.reason : undefined).toBe("quota");
  expect(result.outcome === "failed" ? result.message : undefined).toBe("Internal error");
});

it("BLOCK 3: a session-ended failure drops the hold, and an ordinary one never does", async () => {
  const dropped: string[] = [];
  const ended = await sendOnHold({
    held: heldConnection({
      epoch: 1,
      rejectWith: new Error("This session has ended. Please start a new session."),
    }),
    text: createTurnTextRecorder(),
    agent: "codex",
    dropHold: async () => {
      dropped.push("ended");
    },
    prompt: "hello",
    sessionId: "s-held",
  });
  expect(ended.outcome).toBe("failed");
  expect(dropped, "a provably dead bridge session stayed held and will be re-served").toEqual([
    "ended",
  ]);

  await sendOnHold({
    held: heldConnection({ epoch: 1, rejectWith: new Error("socket hang up") }),
    text: createTurnTextRecorder(),
    agent: "codex",
    dropHold: async () => {
      dropped.push("ordinary");
    },
    prompt: "hello",
    sessionId: "s-held",
  });
  expect(
    dropped,
    "an ordinary rejection respawned the bridge - per-turn respawn is the anti-target",
  ).toEqual(["ended"]);
});
