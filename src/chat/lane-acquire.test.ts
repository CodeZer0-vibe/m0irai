/**
 * @file src/chat/lane-acquire.test.ts
 * @purpose W4-R2c C4 — A TURN NEVER WAITS LONGER FOR A RESUME THAN A FRESH OPEN COSTS. THE
 *   OPERATOR-VISIBLE FAILURE THESE CATCH: codex's first token arrived 75 seconds after they pressed
 *   enter, because a boot-time eager `resumeSession` hung to the full 60-second handshake step timeout
 *   (their trace: `resume.fallback reason=ACP lane step timed out after 60s: codex resumeSession` at
 *   +53.45s, first output at +74.92s) and the real turn queued behind it. claude's turn waited 14.2
 *   seconds on the same shape. Resume is an OPTIMIZATION; in that run it was a 60-second tax.
 * @exports (test suite — no runtime exports)
 * @depends node:fs, node:os, node:path, vitest, ../evidence/db, ../memory/lane-state, ./lane-acquire,
 *   ./lane-hold
 *
 * THE REAL SINGLE-FLIGHT CACHE, NOT A MOCK OF IT (RA-7, verbatim: "Mocking `acquireLaneSession` itself
 * proves nothing"). Every test drives the shipped `acquireLaneSession`, the shipped in-flight map, the
 * shipped `createCockpitLaneTransport` with its real hold and its real close ladder, and a real
 * lane-state DB. The ONLY injected seam is `openConnection` — the documented trust boundary where a
 * real bridge process would be — injected so a HANG is deterministic instead of timing-dependent.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, closeDb, openLaneStateDb } from "../evidence/db.js";
import { getLaneSession } from "../memory/lane-state.js";
import {
  LaneAcquireSupersededError,
  acquireLaneSession,
  resetLaneAcquireCache,
} from "./lane-acquire.js";
import { createCockpitLaneTransport } from "./lane-hold.js";

const BINDING = { adapterPkg: "acp", adapterVersion: "1.0.0", cwd: "/repo" };
const PROJECT = "proj-1785190840745";
/** Comfortably past INTERACTIVE_ACQUIRE_BUDGET_MS (8s) — the test drives a fake clock, so this costs
 *  no wall time and cannot flake on a slow machine. */
const PAST_BUDGET_MS = 9_000;

const dirs: string[] = [];
let db: Db;
let repoRoot: string;

beforeEach(() => {
  // The real lane-state DB, on real disk: `:memory:` cannot take the WAL journal mode openLaneStateDb
  // requires, and swapping the store for a fake is exactly the shortcut RA-7 forbids — the point is
  // that a superseded acquire cannot WRITE, so the writes have to be real.
  repoRoot = mkdtempSync(join(tmpdir(), "lane-acquire-budget-"));
  dirs.push(repoRoot);
  db = openLaneStateDb(join(repoRoot, "lane-state.db"));
  // lane_state rows hang off a real projects row (the same seed every other carrier suite uses).
  db.prepare(
    "INSERT OR IGNORE INTO projects(project_id, canonical_root, git_common_dir, created_at) VALUES (?,?,?,?)",
  ).run(PROJECT, repoRoot, join(repoRoot, ".git"), "2026-07-27T22:20:00.000Z");
  resetLaneAcquireCache();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  resetLaneAcquireCache();
  closeDb(db);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface FakeConn {
  readonly name: string;
  killed: boolean;
  closeCalls: number;
  resumeCalls: number;
}

/** A connection whose `resumeSession` answers only when the test releases it — the wedged bridge, made
 *  deterministic. `initialize`/`newSession` stay instant, so a FRESH open is never the slow part. */
function fakeConnection(name: string, resumeGate: Promise<void> | undefined, record: FakeConn) {
  let alive = true;
  return {
    initialize: async () => undefined,
    newSession: async () => ({ sessionId: `${name}-fresh` }),
    resumeSession: async (sessionId: string) => {
      record.resumeCalls += 1;
      if (resumeGate !== undefined) await resumeGate;
      return { sessionId };
    },
    prompt: async () => "end_turn",
    setMode: async () => undefined,
    close: () => {
      record.closeCalls += 1;
      alive = false;
      record.killed = true;
    },
    waitForExit: async () => !alive,
    killTree: async () => {
      alive = false;
      record.killed = true;
    },
    isAlive: () => alive,
    pid: () => 4242,
  };
}

/** FL-150: AcquireLaneSessionInput.signal is REQUIRED, so every caller must state its cancel authority.
 *  Nothing in THIS suite cancels — it is about the single-flight cache and the supersession token — and
 *  saying that out loud is exactly what a required field buys. The cancel cases live in
 *  lane-acquire-cancel.test.ts. */
const NEVER_CANCELLED: AbortSignal = new AbortController().signal;

interface Harness {
  readonly transport: ReturnType<typeof createCockpitLaneTransport>;
  readonly conns: FakeConn[];
  readonly base: {
    readonly agent: "codex";
    readonly binding: typeof BINDING;
    readonly db: Db;
    readonly projectId: string;
    readonly transport: ReturnType<typeof createCockpitLaneTransport>;
    readonly signal: AbortSignal;
  };
}

/** The transport under test: connection N gets `gates[N]`, so exactly one open can be made to hang. */
function harness(gates: readonly (Promise<void> | undefined)[]): Harness {
  const conns: FakeConn[] = [];
  const transport = createCockpitLaneTransport({
    agent: "codex",
    cwd: "/repo",
    repoRoot,
    openConnection: async () => {
      const index = conns.length;
      const record: FakeConn = {
        name: `c${String(index)}`,
        killed: false,
        closeCalls: 0,
        resumeCalls: 0,
      };
      conns.push(record);
      const conn = fakeConnection(record.name, gates[index], record);
      return conn as never;
    },
  });
  return {
    transport,
    conns,
    base: {
      agent: "codex",
      binding: BINDING,
      db,
      projectId: PROJECT,
      transport,
      signal: NEVER_CANCELLED,
    },
  };
}

/** THE OPERATOR'S BOOT-TIME SHAPE, end to end, so the `it` below is assertions and nothing else.
 *  conn0 = the previous run's session. conn1 = the eager resume that WEDGES. conn2 = the turn's own
 *  fresh open. Returns everything the assertions need to read. */
async function supersessionScenario(): Promise<{
  readonly h: Harness;
  readonly turn: Awaited<ReturnType<typeof acquireLaneSession>>;
  readonly eagerOutcome: unknown;
}> {
  let releaseWedge: (() => void) | undefined;
  const wedge = new Promise<void>((resolve) => {
    releaseWedge = resolve;
  });
  const h = harness([undefined, wedge, undefined]);

  // A prior run left a stored session, which is what makes the next acquire take the RESUME branch —
  // the operator's own shape, not a synthetic one.
  const seeded = await acquireLaneSession({ ...h.base, turn: 0 });
  expect(seeded.fresh, "the seed must be a fresh create").toBe(true);
  expect(getLaneSession(db, PROJECT, "codex")?.sessionId).toBe("c0-fresh");

  // A FRESH PROCESS, faithfully: at boot, lane-state carries a stored session id from the last run and
  // the transport holds nothing. Without this the next acquire takes start()'s already-held fast path
  // and never reaches a resume at all — right in production, wrong as a fixture for the boot shape.
  await h.transport.dropHold();

  // THE BOOT-TIME EAGER OPEN, wedged exactly as codex's was.
  const eagerP = acquireLaneSession({ ...h.base, turn: 0 });
  const eagerSettled = eagerP.then(
    () => "resolved",
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(1);
  expect(h.conns, "the eager resume must have opened its connection").toHaveLength(2);

  // THE OPERATOR'S TURN, joining the same in-flight acquisition, then outliving the budget.
  const turnP = acquireLaneSession({ ...h.base, turn: 1 });
  await vi.advanceTimersByTimeAsync(PAST_BUDGET_MS);
  const turn = await turnP;

  // THE WEDGE FINALLY ANSWERS — the moment the unguarded code would corrupt the lane.
  releaseWedge?.();
  await vi.advanceTimersByTimeAsync(1);
  return { h, turn, eagerOutcome: await eagerSettled };
}

describe("C4: a foreground turn stops waiting for a wedged background resume", () => {
  it("the turn opens FRESH past the budget, and the stale eager resume can never take the lane back", async () => {
    const { h, turn, eagerOutcome } = await supersessionScenario();

    // 1. THE TURN GOT A LIVE SESSION, and it did NOT wait for the wedge.
    expect(turn.fresh, "the turn must have opened fresh, not inherited the wedged resume").toBe(
      true,
    );
    expect(turn.sessionId).toBe("c2-fresh");

    // 2. The abandoned acquire reports SUPERSESSION, not a failure — an "unavailable" here would paint
    //    `offline` on a lane that is at that instant answering the operator.
    expect(
      eagerOutcome,
      `the abandoned acquire must report supersession, got: ${String(eagerOutcome)}`,
    ).toBeInstanceOf(LaneAcquireSupersededError);

    // 3. It did not overwrite the foreground's durable lane state.
    expect(getLaneSession(db, PROJECT, "codex")?.sessionId).toBe("c2-fresh");

    // 4. It did not overwrite the HELD CONNECTION. Proven by behaviour, not inspection: the turn's own
    //    session still takes start()'s already-held fast path, which opens NOTHING. Had the stale
    //    resume installed its hold, this call would have to open a connection to serve that session.
    const connsBefore = h.conns.length;
    const reuse = await h.transport.start("c2-fresh");
    expect(reuse.outcome).toBe("resumed");
    expect(
      h.conns.length,
      "a stale hold replaced the turn's live connection — start() had to open a new one to serve the turn's own session",
    ).toBe(connsBefore);

    // 5. Its connection was CLOSED through the real ladder rather than abandoned...
    expect(h.conns[1]?.killed, "the superseded connection must be closed, never left running").toBe(
      true,
    );
    // 6. ...and no THIRD session was opened: the abandoned attempt stood down instead of falling
    //    through to its own fresh open, which would have orphaned a live bridge on the vendor side.
    expect(
      h.conns,
      "exactly three: the seed, the wedged resume, the turn's fresh open",
    ).toHaveLength(3);
  });
});

describe("C4: the optimization still works when it is actually fast", () => {
  it("a resume that lands INSIDE the budget is used as-is", async () => {
    const h = harness([undefined, undefined, undefined]);
    await acquireLaneSession({ ...h.base, turn: 0 });

    await h.transport.dropHold();

    const eagerP = acquireLaneSession({ ...h.base, turn: 0 });
    const turnP = acquireLaneSession({ ...h.base, turn: 1 });
    await vi.advanceTimersByTimeAsync(1);

    const [eager, turn] = await Promise.all([eagerP, turnP]);
    expect(turn, "the turn must JOIN the in-flight acquire, not race it").toEqual(eager);
    expect(turn.fresh, "a successful resume is not a fresh open").toBe(false);
    expect(turn.sessionId).toBe("c0-fresh");
    // Two connections only: the seed and the resume. No budget fired, so nothing was superseded.
    expect(h.conns).toHaveLength(2);
  });
});

describe("C4: the BACKGROUND path keeps its full patience", () => {
  it("a second boot-time caller waits for the in-flight open however long it takes", async () => {
    let releaseWedge: (() => void) | undefined;
    const wedge = new Promise<void>((resolve) => {
      releaseWedge = resolve;
    });
    const h = harness([undefined, wedge]);
    await acquireLaneSession({ ...h.base, turn: 0 });

    await h.transport.dropHold();

    const firstP = acquireLaneSession({ ...h.base, turn: 0 });
    const secondP = acquireLaneSession({ ...h.base, turn: 0 });
    // Far past the interactive budget — a background caller must NOT abandon anything.
    await vi.advanceTimersByTimeAsync(PAST_BUDGET_MS * 5);
    expect(h.conns, "a background caller must never open a second connection").toHaveLength(2);

    releaseWedge?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(await secondP).toEqual(await firstP);
  });
});

describe("new conversation isolation", () => {
  it("forceFresh replaces a durable provider session without attempting resume", async () => {
    const h = harness([undefined, undefined]);
    const prior = await acquireLaneSession({ ...h.base, turn: 0 });
    expect(prior.sessionId).toBe("c0-fresh");
    await h.transport.dropHold();

    const isolated = await acquireLaneSession({ ...h.base, turn: 0, forceFresh: true });

    expect(isolated).toMatchObject({ sessionId: "c1-fresh", fresh: true, generation: 2 });
    expect(h.conns[1]?.resumeCalls).toBe(0);
    expect(getLaneSession(db, PROJECT, "codex")?.sessionId).toBe("c1-fresh");
  });
});
