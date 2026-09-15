/**
 * @file src/chat/lane-acquire-cancel.test.ts
 * @purpose FL-150 — A CANCELLED TURN MUST NOT ACQUIRE A SESSION AND SEND TO IT. The operator's own
 *   defect, in their words: they press Esc on three agents and sometimes one ACP agent answers anyway,
 *   and which one varies. FL-146 closed the window where a cancel lands during a fresh CREATE. This
 *   file covers the one it left open, which is the one their evidence DB says their incident actually
 *   rode: a cancel landing while a stored session is being RESUMED is reported as an ordinary resume
 *   miss, and the acquire falls through to `transport.start(undefined)` — a NEW open, taking a NEW
 *   epoch, therefore above the `closedThrough` the cancel just wrote. It succeeds, the hold installs,
 *   and the carrier sends. Measured, from D:/m0irai-playground/.zer0/evidence.db: the session that
 *   carried the escaping prompt was created 5.900 s after the cancel, at generation 2, with the prompt
 *   4 ms behind it.
 * @exports (test suite — no runtime exports)
 * @depends node:fs, node:os, node:path, vitest, ../evidence/db, ../memory/lane-state, ./lane-acquire,
 *   ./lane-hold
 *
 * THE REAL ACQUIRE AND THE REAL TRANSPORT, NOT MOCKS OF THEM. Every case drives the shipped
 * `acquireLaneSession` — its single-flight cache, its supersession token, its `throwIfAborted` — and the
 * shipped `createCockpitLaneTransport` with its real hold, real epoch and real close ladder.
 * `openConnection` is the ONE injected seam: the documented trust boundary where a bridge process would
 * be. Mocking the acquire would prove nothing about the acquire.
 *
 * THE CANCEL IS ISSUED EXACTLY AS THE ROOM ISSUES IT, and in the room's order: `room-engine.ts`'s
 * `cancelTarget` calls `active.controller.abort()` and THEN fires the hook that reaches
 * `dropCancelledLaneHold` -> `dropLaneHold` -> `transport.dropHold()`. Every case below does those two
 * things, in that order, with nothing else standing in for them.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, closeDb, openLaneStateDb } from "../evidence/db.js";
import { getLaneSession } from "../memory/lane-state.js";
import { acquireLaneSession, resetLaneAcquireCache } from "./lane-acquire.js";
import { createCockpitLaneTransport } from "./lane-hold.js";

const BINDING = { adapterPkg: "acp", adapterVersion: "1.0.0", cwd: "/repo" };
const PROJECT = "proj-fl150";

const dirs: string[] = [];
let db: Db;
let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "fl150-acquire-cancel-"));
  dirs.push(repoRoot);
  db = openLaneStateDb(join(repoRoot, "lane-state.db"));
  db.prepare(
    "INSERT OR IGNORE INTO projects(project_id, canonical_root, git_common_dir, created_at) VALUES (?,?,?,?)",
  ).run(PROJECT, repoRoot, join(repoRoot, ".git"), "2026-08-21T00:00:00.000Z");
  resetLaneAcquireCache();
});

afterEach(() => {
  resetLaneAcquireCache();
  closeDb(db);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface ConnRecord {
  readonly name: string;
  /** Every prompt that actually reached this agent. THE assertion subject. */
  readonly prompts: string[];
  closes: number;
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
  return { promise, release: () => release?.() };
}

/** A bridge whose RESUME can be held open until the test releases it — the wedged handshake the
 *  operator's cancel lands inside, made deterministic without a sleep or a fake clock. */
function connection(record: ConnRecord, resumeGate: Promise<void> | undefined) {
  let alive = true;
  return {
    initialize: async () => undefined,
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
      record.closes += 1;
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
  readonly base: {
    readonly agent: "codex";
    readonly binding: typeof BINDING;
    readonly db: Db;
    readonly projectId: string;
    readonly transport: ReturnType<typeof createCockpitLaneTransport>;
  };
}

/** Connection N's resume is gated by `resumeGates[N]`; the production opener is synchronous, and so is
 *  this one, so a connection is registered as opening before `start()` returns to its caller. */
function harness(resumeGates: readonly (Promise<void> | undefined)[]): Harness {
  const conns: ConnRecord[] = [];
  const transport = createCockpitLaneTransport({
    agent: "codex",
    cwd: "/repo",
    repoRoot,
    openConnection: () => {
      const record: ConnRecord = { name: `c${String(conns.length)}`, prompts: [], closes: 0 };
      conns.push(record);
      return connection(record, resumeGates[conns.length - 1]) as never;
    },
  });
  return {
    transport,
    conns,
    base: { agent: "codex", binding: BINDING, db, projectId: PROJECT, transport },
  };
}

/** THE STATE A REAL CANCEL LEAVES BEHIND, built from the real code paths rather than asserted into the
 *  DB by hand: one completed turn stores a session id, and dropping the hold is what any earlier
 *  working cancel already did. That pair — a stored id with no held connection — is what makes the NEXT
 *  acquire take the resume branch, which is the branch the operator's incident rode. */
async function seedStoredSession(h: Harness): Promise<void> {
  const seeded = await acquireLaneSession({
    ...h.base,
    turn: 0,
    signal: new AbortController().signal,
  });
  expect(seeded.sessionId, "the seed must be a real fresh create").toBe("c0-fresh");
  expect(getLaneSession(db, PROJECT, "codex")?.sessionId).toBe("c0-fresh");
  await h.transport.dropHold();
}

function promptsDelivered(h: Harness): readonly string[] {
  return h.conns.flatMap((record) => record.prompts);
}

/**
 * THE CANCEL IS ISSUED IN cancelTarget'S OWN ORDER — `controller.abort()` first, then the hook that
 * reaches `transport.dropHold()` — because that order is what makes the resume report a supersession
 * while the turn's own signal is already down.
 */
describe("FL-150: a cancel landing during a RESUME never becomes a fresh create that sends", () => {
  it("stops the acquire instead of opening a replacement session for a turn the operator stopped", async () => {
    const resume = deferred();
    const h = harness([undefined, resume.promise]);
    await seedStoredSession(h);
    const controller = new AbortController();

    // THE OPERATOR'S TURN. It takes the resume branch, and c1's resumeSession is wedged.
    const turn = acquireLaneSession({ ...h.base, turn: 1, signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.conns, "the resume must be in flight before the cancel").toHaveLength(2);

    controller.abort();
    const reached = await h.transport.dropHold();

    // The wedged bridge finally answers, 5.9 seconds late, exactly as it did in their trace.
    resume.release();
    await expect(turn).rejects.toThrow(/session acquisition aborted/);

    expect(
      h.conns,
      "the cancelled turn opened a THIRD connection — the fallback create that carried the escaping prompt",
    ).toHaveLength(2);
    expect(promptsDelivered(h), "a prompt reached an agent after the operator cancelled").toEqual(
      [],
    );
    expect(reached, "the cancel reached a connection and must say so").toBe(true);
  });
});

/**
 * THE POSITIVE CONTROL, and it is the whole reason the case above is readable: it proves this harness
 * can still produce the escaping shape, so a green above is the guard working rather than the fixture
 * quietly failing to reach the branch at all. The supersession here is lane-gate.ts's
 * `forceFreshConnection` — the SANCTIONED reconnect, whose entire purpose is that the next `start()`
 * opens a real connection. The discriminator between it and a cancel is the abort signal and nothing
 * else, which is exactly why the signal had to become required rather than inferred from a reason code.
 */
describe("FL-150: a supersession with no cancel behind it still gets its fresh session", () => {
  it("falls through to a fresh create and sends, as the reconnect seam intends", async () => {
    const resume = deferred();
    const h = harness([undefined, resume.promise]);
    await seedStoredSession(h);

    const turn = acquireLaneSession({
      ...h.base,
      turn: 1,
      signal: new AbortController().signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    await h.transport.dropHold();
    resume.release();
    const active = await turn;

    expect(active, "a sanctioned reconnect must still get a session").toMatchObject({
      sessionId: "c2-fresh",
      fresh: true,
    });
    const sent = await h.transport.send("an uncancelled turn", active.sessionId);
    expect(sent.outcome).toBe("accepted");
    expect(promptsDelivered(h)).toEqual(["an uncancelled turn"]);
  });
});

/**
 * THE WINDOW, AND WHY IT IS A REAL ONE RATHER THAN A CONSTRUCTED INSTANT. Every other path into the
 * fallback create runs synchronously from a guard that already asked the signal, so an abort cannot
 * land between them. This one can: a foreground turn that finds a BACKGROUND acquire already in flight
 * parks on `withinBudget` (the interactive resume budget, lane-acquire.ts), and when that background
 * attempt gives up, control resumes on the far side of a genuine `await` — with nothing between it and
 * `transport.start(undefined)` but this guard.
 *
 * The operator has already lived in this window: it is the same 8-second budget their measured run
 * spent waiting for codex's wedged boot-time resume. Here the background attempt FAILS rather than
 * running long, which makes `withinBudget` resolve at once and the window deterministic — no fake
 * clock, no sleep.
 *
 * WHAT THIS ASSERTS is the connection count, deliberately, NOT the rejection. Without the guard the
 * turn still rejects — the check AFTER `start(undefined)` catches it — but it rejects having already
 * spawned a bridge process for a turn the operator stopped. The child is the defect.
 */
describe("FL-150: the fallback create asks the signal again BEFORE it spawns", () => {
  it("does not spawn a bridge child for a turn cancelled while it waited on someone else's open", async () => {
    const h = harness([]);
    const controller = new AbortController();
    let failBackground: ((cause: Error) => void) | undefined;
    const backgroundOpen = new Promise<never>((_resolve, reject) => {
      failBackground = reject;
    });

    let startCalls = 0;
    const transport = {
      // The FIRST start is the boot-time eager open, hung until the test fails it. Every later one is
      // the real transport, so a fallback create shows up as a real connection in h.conns.
      start: async (sessionId: string | undefined) => {
        startCalls += 1;
        if (startCalls === 1) return backgroundOpen;
        return h.transport.start(sessionId);
      },
      send: (prompt: string, sessionId: string) => h.transport.send(prompt, sessionId),
    };

    // turn 0 is the boot sentinel: the BACKGROUND acquire, which registers in the single-flight cache.
    const background = acquireLaneSession({
      ...h.base,
      transport,
      turn: 0,
      signal: new AbortController().signal,
    });
    background.catch(() => undefined); // it is meant to fail; nothing here is waiting on it
    expect(startCalls, "the background open must be in flight before the turn joins it").toBe(1);

    // THE OPERATOR'S TURN joins that in-flight acquire and parks on the interactive budget, then they
    // press Esc while it is still waiting on someone else's open.
    const turn = acquireLaneSession({ ...h.base, transport, turn: 1, signal: controller.signal });
    controller.abort();
    failBackground?.(new Error("the bridge never came up"));

    await expect(turn).rejects.toThrow(/session acquisition aborted/);

    expect(
      h.conns,
      "a cancelled turn spawned a bridge child for a fallback create it was never going to send to",
    ).toHaveLength(0);
    expect(promptsDelivered(h)).toEqual([]);
  });
});

/**
 * THE DOOR. A turn cancelled before the acquire even starts must not open anything at all — the
 * cheapest of the three guards and the one that covers a cancel landing while the turn is still queued.
 */
describe("FL-150: an already-cancelled turn never touches the transport at all", () => {
  it("refuses at the door rather than opening a session it will throw away", async () => {
    const h = harness([]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      acquireLaneSession({ ...h.base, turn: 1, signal: controller.signal }),
    ).rejects.toThrow(/session acquisition aborted/);

    expect(h.conns, "a cancelled turn spawned a bridge child").toHaveLength(0);
  });
});

/**
 * FL-150 ROUND 2 (review P2-B) — THE 8-SECOND PARK NOW HEARS THE CANCEL.
 *
 * A turn that finds a background acquire already in flight waits on the interactive resume budget. The
 * shipped code raced that wait against a timer and nothing else, so a cancel landing inside it was
 * invisible for the full budget — the reviewer measured **8010 ms** — and then, on the way out, the
 * dead turn set `superseded` on a background acquire that was perfectly healthy, destroying the
 * boot-time eager session the lane was warming. Their control on the same tree: an already-cancelled
 * turn rejects at the door in **1 ms** and leaves that background acquire alone. The park had no reason
 * to behave worse than the door.
 *
 * BOTH HALVES ARE ASSERTED. Speed alone would go green if the park still killed the background acquire
 * on its way out; survival alone would go green if it took eight seconds to get there.
 */
describe("FL-150: a cancel landing while parked on the acquire budget", () => {
  it("rejects at once and leaves the background acquire it was only waiting on alive", async () => {
    const h = harness([]);
    const controller = new AbortController();
    let releaseBackground: (() => void) | undefined;
    const backgroundOpen = new Promise<void>((resolve) => {
      releaseBackground = resolve;
    });

    let startCalls = 0;
    const transport = {
      // The boot-time eager open, wedged mid-handshake — the state the operator's own measured run was
      // in when codex's resume hung for the full 60 s step timeout.
      start: async (sessionId: string | undefined) => {
        startCalls += 1;
        if (startCalls === 1) await backgroundOpen;
        return h.transport.start(sessionId);
      },
      send: (prompt: string, sessionId: string) => h.transport.send(prompt, sessionId),
    };

    const background = acquireLaneSession({
      ...h.base,
      transport,
      turn: 0,
      signal: new AbortController().signal,
    });
    expect(startCalls, "the background open must be in flight before the turn parks on it").toBe(1);

    // THE OPERATOR'S TURN joins it and parks; then they press Esc, well inside the 8-second budget.
    const started = Date.now();
    const turn = acquireLaneSession({ ...h.base, transport, turn: 1, signal: controller.signal });
    controller.abort();
    await expect(turn).rejects.toThrow(/session acquisition aborted/);
    const elapsedMs = Date.now() - started;

    expect(
      elapsedMs,
      "the lane stayed visibly busy after Esc, waiting out a budget it had no reason to wait out",
    ).toBeLessThan(1_000);

    // The background acquire was never this turn's to kill: it was merely what the turn was waiting on.
    releaseBackground?.();
    await expect(
      background,
      "a dead turn destroyed the healthy eager session the lane was warming",
    ).resolves.toMatchObject({ sessionId: "c0-fresh" });
  });
});
