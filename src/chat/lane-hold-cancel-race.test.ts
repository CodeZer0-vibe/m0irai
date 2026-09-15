/**
 * @file src/chat/lane-hold-cancel-race.test.ts
 * @purpose FL-146 — A CANCEL MUST STOP A LANE WHOSE CONNECTION IS STILL *OPENING*, NOT ONLY ONE WHOSE
 *   CONNECTION IS ALREADY HELD. THE OPERATOR-VISIBLE FAILURE THESE CATCH, in their own words:
 *   "sometimes it works and sometimes it doesn't", and "if I spam the esc I can cancel them all".
 *   Measured from their own evidence DB (D:/m0irai-playground/.zer0/evidence.db, tables
 *   `chat_messages` + `lane_prompt_attempts`): at 09:52:31.734 they submit, at 09:52:32.488 gemini is
 *   cancelled, and CLAUDE'S PROMPT IS SENT AT 09:52:38.392 — 5.9 s after the cancel, resolved
 *   `accepted` — and claude answers. On the trial a minute earlier it was codex that escaped, 2.9 s
 *   after the cancel. A different lane escapes each time, which is what makes it a race rather than a
 *   routing bug, and spamming the key wins because each press is another attempt at the same window.
 * @exports (test suite — no runtime exports)
 * @depends node:fs, node:os, node:path, vitest, ./lane-hold
 *
 * THE REAL TRANSPORT, NOT A MOCK OF IT. Every test drives the shipped `createCockpitLaneTransport`,
 * its real hold, its real supersession epoch and its real close ladder. `openConnection` is the ONE
 * injected seam — the documented trust boundary where a bridge process would be.
 *
 * HOW THE WINDOW IS CONSTRUCTED, and why it needs no timing at all: the injected opener returns its
 * connection SYNCHRONOUSLY, exactly as the production ACP opener does ("The production ACP opener
 * returns synchronously after spawn" — lane-hold.ts's own note on openFresh), so the connection is
 * registered as *opening* before `start()` has even returned to the caller. The handshake
 * (`initialize`) is then gated on a promise the test releases by hand. A cancel issued between those
 * two points is inside the window by construction — never by a sleep, a tick count, or a fake clock.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCockpitLaneTransport } from "./lane-hold.js";

const dirs: string[] = [];
let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "lane-hold-cancel-race-"));
  dirs.push(repoRoot);
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface ConnRecord {
  readonly name: string;
  /** Every prompt that actually reached this agent. THE assertion subject: after a cancel this must
   *  stay empty, because "no prompt from that turn may reach an agent" is the whole contract. */
  readonly prompts: string[];
  closed: boolean;
}

interface Deferred {
  readonly promise: Promise<void>;
  release(): void;
}

function deferred(): Deferred {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    release: () => release?.(),
  };
}

/** A connection whose HANDSHAKE — or, since FL-150, whose RESUME — is held open until the test releases
 *  it: the bridge that is still coming up when the operator presses the key, made deterministic. */
function gatedConnection(
  record: ConnRecord,
  handshakeGate: Promise<void> | undefined,
  resumeGate?: Promise<void> | undefined,
) {
  let alive = true;
  return {
    initialize: async () => {
      if (handshakeGate !== undefined) await handshakeGate;
      return undefined;
    },
    newSession: async () => ({ sessionId: `${record.name}-fresh` }),
    resumeSession: async (sessionId: string) => {
      if (resumeGate !== undefined) await resumeGate;
      return { sessionId };
    },
    prompt: async (_sessionId: string, text: string) => {
      record.prompts.push(text);
      return "end_turn";
    },
    setMode: async () => undefined,
    close: () => {
      record.closed = true;
      alive = false;
    },
    waitForExit: async () => !alive,
    killTree: async () => {
      alive = false;
    },
    isAlive: () => alive,
    pid: () => 4242,
  };
}

interface Harness {
  readonly transport: ReturnType<typeof createCockpitLaneTransport>;
  readonly conns: ConnRecord[];
}

/** Connection N gets `gates[N]` on its handshake and `resumeGates[N]` on its resume, so exactly the
 *  opens the test names are held at exactly the step the test is about. */
function harness(
  gates: readonly (Promise<void> | undefined)[],
  resumeGates: readonly (Promise<void> | undefined)[] = [],
): Harness {
  const conns: ConnRecord[] = [];
  const transport = createCockpitLaneTransport({
    agent: "claude",
    cwd: "/repo",
    repoRoot,
    // Synchronous, as the production opener is — see the file header.
    openConnection: () => {
      const record: ConnRecord = { name: `c${String(conns.length)}`, prompts: [], closed: false };
      conns.push(record);
      const index = conns.length - 1;
      return gatedConnection(record, gates[index], resumeGates[index]) as never;
    },
  });
  return { transport, conns };
}

describe("FL-146: a cancel that lands while the connection is still opening", () => {
  it("sends no prompt to the agent the operator already stopped", async () => {
    const handshake = deferred();
    const h = harness([handshake.promise]);

    // The turn begins. The child is spawned and registered as opening; the handshake has not answered.
    const starting = h.transport.start(undefined);
    expect(h.conns, "the open must be in flight before the cancel").toHaveLength(1);

    // THE OPERATOR'S KEY, landing inside the window.
    const stopped = await h.transport.dropHold();

    // The bridge finally finishes coming up — 2.9 to 5.9 seconds late, as it was in their trace.
    handshake.release();
    const started = await starting;

    // The carrier's own shape is "send only if start() reported a session". Drive it BOTH ways — with
    // the id start reported when it reported one, and with the id the connection would have created
    // otherwise — so this assertion cannot pass merely because start() declined to hand one back.
    const reported = "sessionId" in started ? started.sessionId : "c0-fresh";
    await h.transport.send("the prompt the operator cancelled", reported);

    expect(
      h.conns[0]?.prompts,
      "a prompt reached an agent the operator had already cancelled — FL-146, the operator's original defect",
    ).toEqual([]);
    expect(
      stopped,
      "the cancel reported that it stopped nothing, which is what made a no-op cancel indistinguishable from a working one",
    ).toBe(true);
  });
});

describe("FL-146: the cancel stays a panic button", () => {
  it("does not park behind a connection that is still spawning", async () => {
    // This gate is NEVER released: the child is wedged coming up, which is the state a stop key has to
    // survive. A dropHold that awaited the in-flight open would hang here forever.
    const h = harness([deferred().promise]);
    const starting = h.transport.start(undefined);
    void starting;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const parked = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve("the cancel parked behind the open"), 250);
    });
    const outcome = await Promise.race([
      h.transport.dropHold().then(() => "the cancel returned"),
      parked,
    ]);
    if (timer !== undefined) clearTimeout(timer);

    expect(outcome).toBe("the cancel returned");
  });
});

describe("FL-146: a cancel drops the connection, never the lane", () => {
  it("leaves the lane reusable on the very next turn", async () => {
    const handshake = deferred();
    const h = harness([handshake.promise]);

    const starting = h.transport.start(undefined);
    expect(await h.transport.dropHold()).toBe(true);
    handshake.release();
    await starting;

    // The very next turn must open and answer normally. A cancel that permanently superseded the lane
    // would leave the operator with an agent that never speaks again until they restart the app.
    const next = await h.transport.start(undefined);
    expect(next, "the next turn could not open a session at all").toMatchObject({
      outcome: "created",
      sessionId: "c1-fresh",
    });
    const sent = await h.transport.send("the next turn", "c1-fresh");
    expect(sent.outcome).toBe("accepted");
    expect(h.conns[1]?.prompts).toEqual(["the next turn"]);
  });
});

describe("FL-146: the paths that already worked must keep working", () => {
  it("a cancel that lands AFTER the connection is held still stops the lane", async () => {
    const h = harness([]);
    const started = await h.transport.start(undefined);
    expect(started).toMatchObject({ outcome: "created", sessionId: "c0-fresh" });

    expect(await h.transport.dropHold()).toBe(true);

    const sent = await h.transport.send("the prompt the operator cancelled", "c0-fresh");
    expect(sent.outcome).toBe("failed");
    expect(h.conns[0]?.prompts).toEqual([]);
    expect(h.conns[0]?.closed, "the held connection must go through the close ladder").toBe(true);
  });

  it("an ordinary turn is untouched: it opens, sends, and keeps its hold", async () => {
    const h = harness([]);
    const started = await h.transport.start(undefined);
    expect(started).toMatchObject({ outcome: "created", sessionId: "c0-fresh" });

    const sent = await h.transport.send("hello", "c0-fresh");

    expect(sent.outcome).toBe("accepted");
    expect(h.conns[0]?.prompts).toEqual(["hello"]);
    expect(h.conns, "an ordinary turn must not cost an extra connection").toHaveLength(1);
  });

  it("reports false when a cancel genuinely had nothing to stop", async () => {
    const h = harness([]);
    expect(await h.transport.dropHold()).toBe(false);
    expect(h.conns, "a cancel on an unopened lane must not spawn anything").toHaveLength(0);
  });
});

/**
 * FL-150 (review P2-A) — THE RESUME BRANCH, WHICH FL-146 SHIPPED WITHOUT A SINGLE TEST.
 *
 * Every case above calls `start(undefined)`: a fresh create. `resumeSession` was defined on the fake
 * and never once exercised, and the resume branch is the one the operator's own measured escape rode —
 * a lane with a stored session id (the state after ANY earlier cancel, because a working cancel drops
 * the hold) cancelled while `resumeSession` was in flight. That is why P1-A shipped green.
 */
describe("FL-150: a cancel that lands while the lane is RESUMING a stored session", () => {
  it("supersedes the resume and lets no prompt reach the connection it was reviving", async () => {
    const resume = deferred();
    const h = harness([], [resume.promise]);

    // The turn takes the RESUME branch: the child is spawned and registered as opening, the handshake
    // is through, and `resumeSession` is the step still hanging when the key is pressed.
    //
    // `setImmediate`, NOT `Promise.resolve()` (review P3-A). One microtask only clears `initialize`;
    // the cancel then lands BEFORE `resumeSession` is entered, which is the open-in-flight window
    // FL-146 already covered — under a name claiming the resume one. The reviewer measured both
    // orderings on this exact harness: with `Promise.resolve()` the trace reads
    // initialize / dropHold / close / resumeSession:enter; with `setImmediate` it reads
    // initialize / resumeSession:enter / dropHold / close. Only the second is the window named above.
    const starting = h.transport.start("stored-session-1");
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.conns, "the resume must be in flight before the cancel").toHaveLength(1);

    const reached = await h.transport.dropHold();

    // The wedged bridge finally answers — the 2.9-to-5.9-second late arrival from their trace.
    resume.release();
    const started = await starting;

    expect(
      started,
      "a superseded resume must not report a session the transport does not hold",
    ).toMatchObject({ outcome: "resumeFailed" });
    // The carrier's own next move, driven with the id it was trying to revive.
    const sent = await h.transport.send("the prompt the operator cancelled", "stored-session-1");
    expect(sent.outcome).toBe("failed");
    expect(
      h.conns[0]?.prompts,
      "a prompt reached the agent through a cancelled RESUME — the operator's own measured shape",
    ).toEqual([]);
    expect(reached, "the cancel reached a connection and must say so").toBe(true);
  });

  it("leaves the lane able to resume normally when nothing cancelled it", async () => {
    // The positive control: without this, the assertion above could pass because the harness cannot
    // resume AT ALL rather than because the cancel stopped it.
    const h = harness([]);
    const started = await h.transport.start("stored-session-1");

    expect(started).toMatchObject({ outcome: "resumed", sessionId: "stored-session-1" });
    const sent = await h.transport.send("an ordinary resumed turn", "stored-session-1");
    expect(sent.outcome).toBe("accepted");
    expect(h.conns[0]?.prompts).toEqual(["an ordinary resumed turn"]);
  });
});
