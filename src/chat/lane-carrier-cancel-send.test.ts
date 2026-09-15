/**
 * @file src/chat/lane-carrier-cancel-send.test.ts
 * @purpose FL-150 — THE ACP CARRIER CONSULTS THE ABORT SIGNAL BEFORE IT SENDS, and says so out loud if
 *   a prompt ever gets out anyway. The invariant that broke in the operator's incident, in the FL-146
 *   reviewer's words: *"the ACP carrier never consults the abort signal before sending."* Everything
 *   else in the cancel path — the supersession epoch, the dropped hold, the closed connections — is
 *   machinery around a decision only `runCarrierTurn` is placed to make: the prompt is about to leave,
 *   and the operator has already said stop.
 * @exports (test suite — no runtime exports)
 * @depends node:process, vitest, ../memory/lane-state, ./lane-carrier, ./lane-carrier.fixtures
 *
 * THE REAL runCarrierTurn, THE REAL SQLITE LANE STATE. The transport is the one injected seam (there is
 * no bridge process in a unit test), and every assertion below is about what the SHIPPED carrier did
 * with it: which prompts reached the transport, what landed in `lane_prompt_attempts`, and what the
 * process wrote to stderr.
 *
 * HOW EACH CANCEL IS TIMED, WITHOUT A CLOCK. The room aborts a lane's controller at an instant this
 * suite has to reproduce exactly, and two different instants matter:
 *   - AFTER the session is acquired, BEFORE the prompt is sent. The injected `now` clock is called once
 *     inside the acquire's own last step (`bumpGeneration`) and not again until after the send guard,
 *     so aborting on its first call lands precisely in that window. It is a real seam the carrier
 *     already owns, not a hook added for the test.
 *   - DURING the send itself, which the fake transport does from inside its own `send`. That is the one
 *     window no guard can close — the prompt is already on the wire — and the thing under test there is
 *     whether the room says so afterwards.
 */
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../evidence/db.js";
import { getLaneCursor, listAbortedAttempts } from "../memory/lane-state.js";
import {
  BINDING,
  NOW,
  PROJECT,
  add,
  readBody,
  registerLaneCarrierHooks,
  seeded,
} from "./lane-carrier.fixtures.js";
import { type CarrierTransport, runCarrierTurn } from "./lane-carrier.js";

registerLaneCarrierHooks();

const stderrChunks: string[] = [];

beforeEach(() => {
  stderrChunks.length = 0;
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown): boolean => {
    stderrChunks.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function attemptRows(db: Db): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM lane_prompt_attempts").get() as { n: number };
  return row.n;
}

function loggedLines(): string {
  return stderrChunks.join("");
}

/** A transport that records what reached it, and can abort the turn from INSIDE its own send — the one
 *  instant a guard cannot cover, because by then the prompt is already gone. */
function recordingTransport(
  onSend?: () => void,
): CarrierTransport & { readonly prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    start: async () => ({
      outcome: "created" as const,
      sessionId: "s-cancel",
      modeApplied: { outcome: "applied" as const, modeId: "default", origin: "confirmed" as const },
    }),
    send: async (prompt: string) => {
      onSend?.();
      prompts.push(prompt);
      return { outcome: "accepted" as const };
    },
  };
}

/** THE OPERATOR PRESSES ESC after the session is acquired and before the prompt is sent. See the file
 *  header for why the injected clock's FIRST call is exactly that instant. */
function abortOnce(controller: AbortController): () => string {
  let calls = 0;
  return () => {
    calls += 1;
    if (calls === 1) controller.abort();
    return NOW;
  };
}

/** One carrier turn, with the abort landing wherever the caller's hooks put it. */
async function turnWith(input: {
  readonly db: Db;
  readonly bodies: Map<string, { author: string; body: string }>;
  readonly transport: CarrierTransport;
  readonly signal: AbortSignal;
  readonly now?: () => string;
}) {
  return runCarrierTurn({
    agent: "claude",
    turn: 1,
    binding: BINDING,
    db: input.db,
    projectId: PROJECT,
    readBody: readBody(input.bodies),
    setup: "SETUP",
    operatorMessage: "Operator: are you there?",
    transport: input.transport,
    signal: input.signal,
    now: input.now ?? (() => NOW),
    attemptId: () => "attempt-1",
  });
}

describe("FL-150: a cancelled turn's prompt never reaches the ACP transport", () => {
  it("refuses to send once the operator has stopped the turn, and records no attempt for it", async () => {
    const { db, bodies } = seeded();
    add(db, bodies, "m1", "operator", "hello team");
    const controller = new AbortController();
    const tx = recordingTransport();

    await expect(
      turnWith({
        db,
        bodies,
        transport: tx,
        signal: controller.signal,
        now: abortOnce(controller),
      }),
    ).rejects.toThrow(/cancelled before the prompt was sent/);

    expect(tx.prompts, "a prompt reached the transport after the operator cancelled").toEqual([]);
    expect(
      attemptRows(db),
      "a cancelled turn wrote a pre-send attempt row, which the NEXT turn would read back as a maybe-duplicate that never happened",
    ).toBe(0);
    expect(
      loggedLines(),
      "the stop left no durable trace for anyone reading the log afterwards",
    ).toContain("cancel stopped this turn before its prompt");
  });
});

/**
 * THE POSITIVE CONTROL. Without it the case above could pass because this fixture never reaches the
 * send at all — which would make the guard look effective while proving nothing about it.
 */
describe("FL-150: an uncancelled turn is untouched", () => {
  it("sends and records its attempt exactly as before", async () => {
    const { db, bodies } = seeded();
    add(db, bodies, "m1", "operator", "hello team");
    const tx = recordingTransport();

    const result = await turnWith({
      db,
      bodies,
      transport: tx,
      signal: new AbortController().signal,
    });

    expect(result.outcome).toBe("accepted");
    expect(tx.prompts).toHaveLength(1);
    expect(tx.prompts[0]).toContain("Operator: are you there?");
    expect(attemptRows(db)).toBe(1);
  });
});

describe("FL-150: a prompt that escapes anyway is reported, never silenced", () => {
  it("says out loud that the operator was answered through their own stop", async () => {
    /**
     * THE WINDOW NO GUARD CAN CLOSE: the abort lands while the prompt is already on the wire. Upstream
     * grok checks the same thing at the same place — its LOCAL `is_cancelling()` is read even on a
     * SUCCESSFUL prompt result (xai-grok-pager/src/app/dispatch/prompt.rs:1192-1196). The DEVIATION,
     * stated: upstream routes such a turn to a cancelled event, while here the terminal state belongs
     * to headless-carrier's markCarrierTerminal and the room's own cancel path, so this reports rather
     * than reclassifies — and the cursor still advances, because the prompt genuinely WAS delivered and
     * refusing to record it would re-deliver the same delta on the next turn.
     */
    const { db, bodies } = seeded();
    add(db, bodies, "m1", "operator", "hello team");
    const controller = new AbortController();
    const tx = recordingTransport(() => controller.abort());

    const result = await turnWith({ db, bodies, transport: tx, signal: controller.signal });

    expect(result.outcome, "the delivered prompt must still be booked as delivered").toBe(
      "accepted",
    );
    expect(tx.prompts, "the prompt was genuinely on the wire — that is the premise").toHaveLength(
      1,
    );
    expect(
      getLaneCursor(db, PROJECT, "claude", "")?.lastSeq,
      "a delivered prompt that does not advance the cursor is re-delivered next turn",
    ).toBeGreaterThan(0);
    expect(
      loggedLines(),
      "a prompt went out after a cancel and the log said nothing — the operator's original complaint, unreadable after the fact",
    ).toContain("a prompt was accepted AFTER this turn was aborted");
  });
});

/**
 * ROUND 2 (review P2-A). The WARN reaches no durable sink in the shipped app: no production caller
 * claims the screen, so the file sink is never taken, and in the packaged app the host's stderr goes
 * into a 64 KB ring in the Rust launcher that nothing reads. A line that dies with the process leaves
 * the next occurrence exactly as undiagnosable as the operator's first one. The fact belongs on the
 * attempt's own row, beside the `sent_at` that already proves when it went out.
 */
describe("FL-150: the escape is written down, not only logged", () => {
  it("lands on a row a reader can open afterwards", async () => {
    const { db, bodies } = seeded();
    add(db, bodies, "m1", "operator", "hello team");
    const controller = new AbortController();
    const tx = recordingTransport(() => controller.abort());

    await turnWith({ db, bodies, transport: tx, signal: controller.signal });

    const escaped = listAbortedAttempts(db, PROJECT);
    expect(
      escaped,
      "nothing durable recorded that the operator was answered through their own stop",
    ).toHaveLength(1);
    expect(escaped[0]?.attemptId).toBe("attempt-1");
    expect(escaped[0]?.abortedAt).toBe(NOW);
    expect(
      escaped[0]?.resolved,
      "the prompt WAS accepted and the row must keep saying so — aborted_at records the extra fact, it does not overwrite this one",
    ).toBe("accepted");
  });

  it("leaves aborted_at NULL on every ordinary attempt", async () => {
    const { db, bodies } = seeded();
    add(db, bodies, "m1", "operator", "hello team");
    const tx = recordingTransport();

    await turnWith({ db, bodies, transport: tx, signal: new AbortController().signal });

    expect(
      listAbortedAttempts(db, PROJECT),
      "an ordinary turn was recorded as an escape — a column that flags healthy runs tells a reader nothing",
    ).toEqual([]);
  });

  it("stays quiet on an ordinary turn nobody cancelled", async () => {
    const { db, bodies } = seeded();
    add(db, bodies, "m1", "operator", "hello team");
    const tx = recordingTransport();

    await turnWith({ db, bodies, transport: tx, signal: new AbortController().signal });

    expect(
      loggedLines(),
      "an ordinary turn cried cancel — an alarm that fires on healthy runs is one nobody reads",
    ).not.toContain("AFTER this turn was aborted");
  });
});
