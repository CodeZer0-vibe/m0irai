/**
 * @file src/chat/turn-text-recorder.test.ts
 * @purpose The bounded per-generation text recorder, on its own. Split out of
 *   lane-send-outcome.test.ts when that file passed its line clamp: the recorder answers "what did
 *   THIS connection's turn deliver", which has no classification in it, and the classification tests
 *   next door have no connections in them.
 * @exports (none — test file)
 * @depends vitest, ./lane-send-outcome
 */
import { expect, it } from "vitest";
import { createTurnTextRecorder, laneFailureReason, sendStopOutcome } from "./lane-send-outcome.js";

/** The operator's own codex row at 15:20, verbatim. */
const VENDOR_LIMIT_TEXT =
  "You’ve hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again at Aug 27th, 2026 8:54 AM.";

/** A recorder with one generation's turn already open — the ordinary single-connection case every test
 *  below this line is about. The generation number is arbitrary; only identity matters. */
function liveRecorder(forward?: (chunk: string) => void) {
  const recorder = createTurnTextRecorder(forward);
  recorder.begin(1);
  return { recorder, sink: recorder.sinkFor(1) };
}

it("the recorder forwards every chunk unchanged and keeps the TAIL when a turn overruns the bound", () => {
  const forwarded: string[] = [];
  const { recorder, sink } = liveRecorder((chunk) => forwarded.push(chunk));
  // A long answer that ENDS with the limit notice — the shape the head-keeping version would miss.
  sink("x".repeat(4000));
  sink(VENDOR_LIMIT_TEXT);

  expect(forwarded, "the operator's row must see the same chunks it always did").toEqual([
    "x".repeat(4000),
    VENDOR_LIMIT_TEXT,
  ]);
  expect(recorder.delivered(1).length, "the kept tail must stay bounded").toBe(1000);
  expect(recorder.delivered(1)).toContain("usage limit");
  expect(sendStopOutcome("refusal", recorder.delivered(1)).outcome).toBe("failed");
});

it("begin() drops the previous turn's ending", () => {
  // One held connection serves every turn on a lane. Without the reset, the turn AFTER a limit notice
  // would inherit it and a recovered lane would keep reporting itself dead.
  const { recorder, sink } = liveRecorder();
  sink(VENDOR_LIMIT_TEXT);
  expect(laneFailureReason(recorder.delivered(1))).toBe("quota");

  recorder.begin(1);
  sink("all good now");
  expect(recorder.delivered(1)).toBe("all good now");
  expect(laneFailureReason(recorder.delivered(1))).toBe("transport");
});

it("a recorder with no forward target still records", () => {
  // The transport builds the recorder from `input.onText`, which the cockpit may not supply at all;
  // the classification must not quietly depend on a forward target being present.
  const { recorder, sink } = liveRecorder();
  sink(VENDOR_LIMIT_TEXT);
  expect(recorder.delivered(1)).toBe(VENDOR_LIMIT_TEXT);
});

it("E: a SETTLED generation's late chunk records nothing and forwards nothing", () => {
  // The unit half of item E (the transport-level falsifier is lane-hold-text-generation.test.ts).
  // Every connection captures its `onText` once at open and keeps the reference for its whole life,
  // so a closed connection's buffered chunk arrives through a callback that is still perfectly
  // callable. What stops it is that its OWN turn is over — not that someone else now holds the lane,
  // which is the distinction DELTA 4 corrected.
  const forwarded: string[] = [];
  const recorder = createTurnTextRecorder((chunk) => forwarded.push(chunk));
  const stale = recorder.sinkFor(7);
  const live = recorder.sinkFor(8);

  recorder.begin(7);
  recorder.end(7); // generation 7's turn has been classified and is over
  recorder.begin(8);
  stale(VENDOR_LIMIT_TEXT);
  live("all good now");

  expect(recorder.delivered(8), "a settled connection's text entered this turn's ending").toBe(
    "all good now",
  );
  expect(forwarded, "a settled connection's text reached the operator's row").toEqual([
    "all good now",
  ]);
});

it("DELTA 4: two generations record side by side, each turn reading only its own", () => {
  // The case the single ownership bit got wrong. Generation 7's prompt has not settled — ACP keeps its
  // `onText` installed until its own `finally` — while generation 8 has taken the lane and started its
  // own turn. Both are legitimately delivering, and neither may be read as the other.
  const forwarded: string[] = [];
  const recorder = createTurnTextRecorder((chunk) => forwarded.push(chunk));
  recorder.begin(7);
  recorder.begin(8);
  recorder.sinkFor(7)(VENDOR_LIMIT_TEXT);
  recorder.sinkFor(8)("all good now");

  expect(
    recorder.delivered(7),
    "a still-draining turn lost its own text to a newer connection's claim",
  ).toBe(VENDOR_LIMIT_TEXT);
  expect(recorder.delivered(8), "a draining turn's text leaked into the live turn").toBe(
    "all good now",
  );
  expect(forwarded, "a still-draining turn's text never reached the operator's row").toEqual([
    VENDOR_LIMIT_TEXT,
    "all good now",
  ]);
});

it("E: nothing records until a generation has actually had a turn BEGUN on it", () => {
  // A connection that is merely OPENING has an epoch and a live callback and has not been installed —
  // and it may never be, because a newer start() supersedes it. Recording by default would hand the
  // lane's ending to exactly that connection.
  const recorder = createTurnTextRecorder();
  recorder.sinkFor(1)(VENDOR_LIMIT_TEXT);
  expect(recorder.delivered(1)).toBe("");

  recorder.begin(1);
  recorder.sinkFor(1)(VENDOR_LIMIT_TEXT);
  expect(recorder.delivered(1)).toBe(VENDOR_LIMIT_TEXT);
});

it("DELTA 4: the per-generation buffers stay bounded", () => {
  // Per-generation buffers replace one string with a map, so the map needs a ceiling of its own. Each
  // buffer is already capped at the kept-tail length; this pins that the NUMBER of them is capped too,
  // oldest-first, so a long-lived chat mount cannot accumulate one per connection it ever opened.
  const recorder = createTurnTextRecorder();
  for (let generation = 1; generation <= 40; generation += 1) {
    recorder.begin(generation);
    recorder.sinkFor(generation)(VENDOR_LIMIT_TEXT);
  }
  expect(recorder.delivered(40), "the newest generation lost its own text").toBe(VENDOR_LIMIT_TEXT);
  expect(
    recorder.delivered(1),
    "a generation from 39 opens ago is still holding a buffer - the recorder grows for the life of the chat mount",
  ).toBe("");
});
