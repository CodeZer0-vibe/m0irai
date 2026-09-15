/**
 * @file src/chat/lane-hold-text-generation.test.ts
 * @purpose ITEM E — the turn-text recorder is shared across connection GENERATIONS, and until this it
 *   had no guard at all. One recorder is created per transport (`createCockpitLaneTransport`) and lives
 *   for the whole chat mount; connections come and go underneath it — a cancel drops the hold, the
 *   self-heal drops a dead bridge session, a supersession refuses a stale open. Every one of those
 *   connections captured its `onText` ONCE at open (`acp-lane-connection.ts`'s
 *   `onUpdate: (chunk) => input.onText?.(chunk)`) and holds that reference for its whole life, so a
 *   chunk delivered through a CLOSED or superseded connection landed in the LIVE turn's recorder and
 *   could decide its classification. The review reproduced `reason: "quota"` that way.
 * @exports (none — test file)
 * @depends node:fs, node:os, node:path, vitest, ./lane-hold
 *
 * WHY IT NEEDED ITS OWN FILE. `lane-hold-turn-text.test.ts` drives ONE connection across two turns,
 * which is where the per-turn reset bug lives. This is the other axis: TWO connections across two
 * turns, which no existing fixture builds.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createCockpitLaneTransport } from "./lane-hold.js";

const dirs: string[] = [];
let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "lane-hold-text-gen-"));
  dirs.push(repoRoot);
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The operator's own codex row at 15:20, verbatim. */
const VENDOR_LIMIT_TEXT =
  "You’ve hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again at Aug 27th, 2026 8:54 AM.";
const INNOCENT_TEXT = "Done — I moved the retry helper into its own module.";

interface Harness {
  readonly transport: ReturnType<typeof createCockpitLaneTransport>;
  /** Every generation's `onText`, in open order. Index 0 is the FIRST connection's — still callable
   *  after that connection is closed, exactly as the real one is. */
  readonly sinks: ((chunk: string) => void)[];
  /** What the cockpit's own consumer saw, which is what fills the operator's row. */
  readonly forwarded: string[];
  /** How many times a SESSION was created or resumed on each connection, in open order. */
  readonly sessionsPerConnection: number[];
}

type ScriptedTurn = { text?: string; stopReason: string };

/**
 * A transport whose fake opener records each generation's `onText` and hands the scripted turn to the
 * caller. `prompt` is driven by `nextTurn` so a test can stream through a STALE sink mid-turn — which
 * is the whole scenario and cannot be expressed by a per-turn script table. `nextTurn` may return a
 * PROMISE, which is how the drain case below holds one connection's prompt open across another
 * connection's whole open-and-claim.
 */
function harness(nextTurn: () => ScriptedTurn | Promise<ScriptedTurn>): Harness {
  const sinks: ((chunk: string) => void)[] = [];
  const forwarded: string[] = [];
  const sessionsPerConnection: number[] = [];
  const transport = createCockpitLaneTransport({
    agent: "codex",
    cwd: "/repo",
    repoRoot,
    onText: (chunk) => forwarded.push(chunk),
    openConnection: async (input) => {
      const index = sinks.length;
      sinks.push((chunk) => input.onText?.(chunk));
      sessionsPerConnection.push(0);
      return {
        initialize: async () => undefined,
        newSession: async () => {
          sessionsPerConnection[index] = (sessionsPerConnection[index] ?? 0) + 1;
          return { sessionId: "s-held" };
        },
        resumeSession: async (sessionId: string) => {
          sessionsPerConnection[index] = (sessionsPerConnection[index] ?? 0) + 1;
          return { sessionId };
        },
        prompt: async () => {
          const step = await nextTurn();
          if (step.text !== undefined) input.onText?.(step.text);
          return step.stopReason;
        },
        setMode: async () => undefined,
        close: () => undefined,
        waitForExit: async () => true,
        killTree: async () => undefined,
        isAlive: () => true,
        pid: () => 4242,
      } as never;
    },
  });
  return { transport, sinks, forwarded, sessionsPerConnection };
}

it("E: a chunk from a SUPERSEDED connection cannot decide the live turn's ending", async () => {
  // THE SCENARIO, in the order it happens in production. Turn 1 runs on connection A and hits the
  // vendor's usage limit. The operator cancels (dropHold) and sends again, which opens connection B —
  // and A's child is still dying with a chunk already on the wire. That chunk arrives through A's
  // `onText`, which is still a live callback, WHILE B's turn is in flight.
  //
  // Before the generation guard, that chunk went straight into the one shared recorder and turn 2 —
  // an ordinary turn on a healthy connection — classified as `quota`. The lane went exhausted, and
  // nothing on screen could explain it: the sentence belonged to a connection that no longer existed.
  let turn = 0;
  // A mutable holder rather than a reassigned binding: the fixture closure below is built
  // before the second connection exists, and has to reach the stale sink once it does.
  const stale: { fire?: () => void } = {};
  const h = harness(() => {
    turn += 1;
    if (turn === 1) return { text: VENDOR_LIMIT_TEXT, stopReason: "refusal" };
    // Turn 2, mid-flight: the dead connection's buffered chunk lands first, then the live one answers.
    stale.fire?.();
    return { text: INNOCENT_TEXT, stopReason: "refusal" };
  });

  await h.transport.start(undefined);
  const first = await h.transport.send("are you there", "s-held");
  expect(first.outcome === "failed" ? first.reason : undefined).toBe("quota");

  await h.transport.dropHold();
  await h.transport.start(undefined);
  expect(h.sinks.length, "the second start must have opened a SECOND connection").toBe(2);
  const staleSink = h.sinks[0];
  stale.fire = () => staleSink?.(VENDOR_LIMIT_TEXT);

  const second = await h.transport.send("try again", "s-held");
  expect(
    second.outcome === "failed" ? second.reason : undefined,
    "a chunk delivered through a connection that was already dropped classified the LIVE turn - the lane goes exhausted on a sentence belonging to a connection that no longer exists",
  ).toBe("transport");
  // ...and it did not reach the operator's row either. The row and the classifier read one string by
  // construction (see TurnTextRecorder), so a guard that protected only the classifier would print the
  // dead connection's sentence a SECOND time, underneath the live turn's answer. Counted rather than
  // asserted absent: turn 1 delivered that same sentence legitimately, and it belongs in the row.
  expect(
    h.forwarded.filter((chunk) => chunk === VENDOR_LIMIT_TEXT).length,
    "a superseded connection's text was painted into the live turn's row",
  ).toBe(1);

  await h.transport.close();
});

it("E: the LIVE connection's own text still classifies after a reconnect", async () => {
  // The positive control, and the reason the guard is identity rather than a one-shot latch: the same
  // reconnect sequence, with the limit arriving on the NEW connection. A guard that simply stopped
  // recording after the first drop would pass the test above and silently break this one.
  let turn = 0;
  const h = harness(() => {
    turn += 1;
    return turn === 1
      ? { text: INNOCENT_TEXT, stopReason: "refusal" }
      : { text: VENDOR_LIMIT_TEXT, stopReason: "refusal" };
  });

  await h.transport.start(undefined);
  expect((await h.transport.send("hello", "s-held")).outcome).toBe("failed");
  await h.transport.dropHold();
  await h.transport.start(undefined);

  const second = await h.transport.send("hello again", "s-held");
  expect(
    second.outcome === "failed" ? second.reason : undefined,
    "the generation guard swallowed the LIVE connection's own limit sentence",
  ).toBe("quota");
  expect(h.forwarded).toContain(VENDOR_LIMIT_TEXT);

  await h.transport.close();
});

/**
 * DELTA ITEM 4 — THE OTHER HALF OF THE SAME AXIS, AND THE ONE THE OWNERSHIP BIT GOT WRONG.
 *
 * A single live-generation bit answers "whose text counts?" with "whoever holds the lane right now",
 * and that is the wrong question. ACP keeps an in-flight prompt's `onText` installed until the call's
 * own `finally` (`acp-lane-connection.ts`'s `buildLaneProcessMethods`), so a connection whose turn has
 * not settled is still LEGALLY delivering — that draining property is exactly what makes the close
 * window safe (the #9 case below). Claiming a newer connection nevertheless muted the older one on the
 * spot: its text was neither forwarded to the operator's row nor offered to the classifier, so the one
 * sentence that says "this account is spent" was thrown away at the moment it arrived.
 *
 * The distinction is not ownership, it is whether that generation's TURN IS STILL OPEN. A settled
 * turn's late chunk is stale (the case above); an unsettled turn's chunk is its own, whoever else has
 * since claimed the lane.
 */
it("DELTA 4: a superseded but still-draining turn settles on its OWN text", async () => {
  // A's prompt is in flight. B opens and claims the lane underneath it. THEN A's vendor limit sentence
  // — already on its wire when B claimed — arrives, and A's own prompt settles on it.
  let release: ((step: ScriptedTurn) => void) | undefined;
  let turn = 0;
  const h = harness(() => {
    turn += 1;
    if (turn > 1) return { text: INNOCENT_TEXT, stopReason: "end_turn" };
    return new Promise<ScriptedTurn>((resolve) => {
      release = resolve;
    });
  });

  await h.transport.start(undefined);
  const draining = h.transport.send("am I still allowed", "s-held");
  await Promise.resolve(); // let the prompt reach its await before anything supersedes it

  await h.transport.start(undefined); // connection B opens and takes the hold
  expect(h.sinks.length, "the second start must have opened a SECOND connection").toBe(2);

  release?.({ text: VENDOR_LIMIT_TEXT, stopReason: "refusal" });
  const settled = await draining;

  expect(
    settled.outcome === "failed" ? settled.reason : undefined,
    "a still-draining turn's own limit sentence was discarded because a newer connection had claimed the lane - codex hits its usage limit and the room paints a generic transport failure",
  ).toBe("quota");
  expect(
    h.forwarded,
    "the draining turn's own text never reached the operator's row either",
  ).toContain(VENDOR_LIMIT_TEXT);

  await h.transport.close();
});

it("E/#9: ONE connection ever serves ONE session, which is what makes the close window legal", async () => {
  // THE REVIEW'S #9, EXAMINED AND PINNED AS SAFE — with the property it actually depends on.
  //
  // `close()` clears `slot.standing` and kills the child, but leaves `slot.current` installed until
  // `prompt()` settles (`acp-lane-connection.ts`'s `buildLaneProcessMethods`), and unlike the standing
  // path `deliverLaneUpdate` does no session comparison on `current`. That looks like a hole, and it
  // would be one if a connection could serve more than one session: a late update for session X would
  // land on the in-flight turn of session Y.
  //
  // It cannot, on this transport. EVERY route to a session goes through `openFresh` first —
  // `createFreshSession` and `resumeHeld` both call it before `newSession`/`resumeSession`, and the
  // only path that skips it is `startOrReuseHold`'s fast path, which reuses the session it already
  // has. So while `slot.current` is installed, the only session that exists on that connection is the
  // one the in-flight prompt named, and delivering its updates to its own turn is draining, not
  // leakage. (An acp-lane-update-routing.test.ts case pins the routing side of the same fact.)
  //
  // This is the property, not the conclusion: if a later change ever opens a second session on a live
  // connection, this fails and #9 becomes a real hole that needs a real guard.
  let turn = 0;
  const h = harness(() => {
    turn += 1;
    return { text: INNOCENT_TEXT, stopReason: "end_turn" };
  });

  await h.transport.start(undefined);
  await h.transport.send("one", "s-held");
  await h.transport.start("s-held"); // the fast path: same session, same connection, no reopen
  await h.transport.send("two", "s-held");
  await h.transport.dropHold();
  await h.transport.start("s-held"); // a genuine resume: a NEW connection, one session on it
  await h.transport.send("three", "s-held");

  expect(turn, "the fixture did not actually run three turns").toBe(3);
  expect(
    h.sessionsPerConnection,
    "a connection served more than one session - `slot.current` has no session comparison, so a late update for the old session would land on the new session's turn",
  ).toEqual([1, 1]);

  await h.transport.close();
});
