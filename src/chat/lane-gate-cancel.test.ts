/**
 * @file src/chat/lane-gate-cancel.test.ts
 * @purpose FL-144 — THE FOURTH CANCEL SEAM, at the PRE-DISPATCH gate. The three seams closed before this
 *   one all sit at or after dispatch (headless-carrier's markCarrierTerminal, lane-gate's
 *   recordLaneDispatchResult, lane-gate's handleEscapedLaneError). gateLaneOrBlock runs BEFORE all of
 *   them and outside runOneLane's try (headless-turn.ts's runOneLane), so a cancel that lands in the
 *   window between the room pumping a lane and the gate deciding never met the signal at all. These
 *   falsifiers assert the CLASSIFICATION VALUE and the DURABLE availability, never "a terminal appeared" —
 *   a terminal appears today, with `failed` in it. Each RED is paired with its anti-inversion control:
 *   the same setup with the signal NEVER aborted must keep the block/retry behaviour byte-for-byte.
 * @exports (none — test file)
 * @depends node:fs/promises, node:os, node:path, vitest, ../adapters/types, ../shared/agent-grant,
 *   ../shared/types, ./dispatch-headless, ./events, ./evidence, ./evidence-identity, ./headless-turn,
 *   ./lane-availability-store, ./types
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { AgentInput } from "../adapters/types.js";
import { CHAT_GRANT } from "../shared/agent-grant.js";
import type { AgentResult } from "../shared/types.js";
import type { HeadlessDispatch } from "./dispatch-headless.js";
import { type ChatEvent, ChatEventBus, type ChatEventKind } from "./events.js";
import { chatRunId } from "./evidence-identity.js";
import { recordChatSession } from "./evidence.js";
import { runHeadlessTurn } from "./headless-turn.js";
import {
  getLaneAvailability,
  initLaneAvailabilityStore,
  noteLaneFailure,
  resetLaneAvailabilityStore,
} from "./lane-availability-store.js";
import type { AgentName, ChatSession } from "./types.js";

// The real credit-death sentence (same fixture lane-gate-dispatch.test.ts uses) — the only way to reach
// the gate's blocked branch is a CLASSIFIED death in the durable store.
const CREDIT =
  "Internal error: You're out of usage credits. Run /usage-credits to keep using Fable 5 or /model to switch models.";
const KINDS: readonly ChatEventKind[] = [
  "dispatch.started",
  "dispatch.completed",
  "dispatch.failed",
  "agent.status",
];
const dirs: string[] = [];

afterEach(async () => {
  resetLaneAvailabilityStore();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

async function makeSession(): Promise<{ session: ChatSession; dbPath: string; blobRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "lane-gate-cancel-"));
  dirs.push(root);
  const runDir = path.join(root, "run");
  await mkdir(path.join(runDir, "prompts"), { recursive: true });
  await mkdir(path.join(runDir, "responses"), { recursive: true });
  const blobRoot = path.join(root, "blobs");
  await mkdir(blobRoot, { recursive: true });
  const dbPath = path.join(root, "evidence.db");
  const now = new Date().toISOString();
  const id = "chat-lane-gate-cancel" as const;
  await recordChatSession({
    dbPath,
    sessionId: id,
    runId: chatRunId(id),
    repoRoot: root,
    runDir,
    createdAt: now,
    updatedAt: now,
    defaultAgent: "claude",
    lastAgent: null,
    summaryText: "",
    summaryThroughTurn: 0,
  });
  const session: ChatSession = {
    id,
    repoRoot: root,
    runDir,
    createdAt: now,
    updatedAt: now,
    defaultAgent: "claude",
    lastAgent: null,
    summary: { text: "", throughTurn: 0 },
    messages: [],
  };
  return { session, dbPath, blobRoot };
}

function capture(bus: ChatEventBus): ChatEvent[] {
  const events: ChatEvent[] = [];
  for (const kind of KINDS) bus.on(kind, (event) => events.push(event));
  return events;
}

function recordingDispatch(): { dispatch: HeadlessDispatch; calls: AgentName[] } {
  const calls: AgentName[] = [];
  const dispatch: HeadlessDispatch = async (input: AgentInput, onChunk): Promise<AgentResult> => {
    calls.push(input.agent);
    onChunk?.(`ok:${input.agent}`);
    return { stdout: `ok:${input.agent}`, exitCode: 0 };
  };
  return { dispatch, calls };
}

const failedFor = (events: ChatEvent[], agent: AgentName) =>
  events.filter((e) => e.kind === "dispatch.failed" && e.agent === agent);
const startedFor = (events: ChatEvent[], agent: AgentName) =>
  events.filter((e) => e.kind === "dispatch.started" && e.agent === agent);
/** Every availability chip published for `agent` — the gate's own write to the chrome. A cancel must
 *  publish NONE of these: nothing was learned about the lane, in either direction. */
const availabilityFor = (events: ChatEvent[], agent: AgentName) =>
  events.filter(
    (e) => e.kind === "agent.status" && e.agent === agent && e.availability !== undefined,
  );
const terminalState = (events: ChatEvent[], agent: AgentName): string | undefined => {
  const event = failedFor(events, agent)[0];
  return event?.kind === "dispatch.failed" ? event.state : undefined;
};

// No carrier runtime is initialised anywhere in this file, so usesCarrier() is false and every turn takes
// the non-carrier path with the injected dispatch — the gate is identical on both paths (it is the ONE
// pre-dispatch gate), and this keeps the reproduction free of a faked ACP bridge.
function dispatchTurn(
  session: ChatSession,
  bus: ChatEventBus,
  cfg: { readonly dbPath: string; readonly blobRoot: string },
  agent: AgentName,
  turn: number,
  dispatch: HeadlessDispatch,
  signal: AbortSignal,
) {
  return runHeadlessTurn({
    session,
    addresses: [{ agent, prompt: "whats the status" }],
    bus,
    turn,
    laneClass: "chat",
    grant: CHAT_GRANT,
    config: cfg,
    signal,
    dispatch,
  });
}

/** An already-aborted signal: the room aborted this lane's controller in the window between pump() creating
 *  it (room-engine.ts's pump) and runOneLane reaching the gate. Ctrl+C, Esc, room pause and shutdown
 *  quiesce all land here (room-engine.ts's cancelTarget / pause / quiesce all call controller.abort()). */
function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

// ===========================================================================================
// SECTION 1 — a cancel that lands before the pre-dispatch gate, on a lane the gate would BLOCK.
// ===========================================================================================

/**
 * RED #1 — codex's probe, reproduced at runtime rather than read off the source. Its report:
 * `"signalAborted": true`, availability `"exhausted"`, returned outcome `"state": "failed"`, plus a
 * `dispatch.failed` terminal, and dispatch never invoked.
 *
 * WHAT WRONG IMPLEMENTATION WOULD STILL PASS THIS? Not "a terminal row appeared" — the broken tree emits
 * one. Not "dispatch was skipped" — the gate skips it either way, which is why `calls` is an invariant
 * here and not the falsifier. The falsifiers are the CLASSIFICATION (`cancelled`, on both the returned
 * outcome and the emitted terminal) and the DURABLE store staying `exhausted` instead of being walked to
 * `local_blocked` by a send the operator had already stopped.
 */
it("RED: a blocked lane whose signal is already aborted classifies `cancelled` — not `failed`", async () => {
  const { session, dbPath, blobRoot } = await makeSession();
  initLaneAvailabilityStore(session.repoRoot);
  noteLaneFailure("claude", CREDIT, Date.now()); // claude died just now — the gate will refuse this send
  const bus = new ChatEventBus();
  const events = capture(bus);
  const { dispatch, calls } = recordingDispatch();

  const outcomes = await dispatchTurn(
    session,
    bus,
    { dbPath, blobRoot },
    "claude",
    5,
    dispatch,
    abortedSignal(),
  );

  expect(outcomes[0]?.state).toBe("cancelled");
  expect(terminalState(events, "claude")).toBe("cancelled");
  expect(outcomes[0]?.error ?? "").not.toContain("skipped"); // not a block notice — a stop
  expect(calls).toEqual([]); // still no child burned
  expect(startedFor(events, "claude")).toHaveLength(0);
  // Nothing was learned about the lane, so nothing is written: no chip, no durable transition.
  expect(availabilityFor(events, "claude")).toEqual([]);
  expect(getLaneAvailability("claude").state).toBe("exhausted");
});

/**
 * THE ANTI-INVERSION CONTROL for RED #1. Calling every gate block a cancel is the same defect pointing
 * backwards and would be invisible without this: a genuine block on a lane nobody cancelled must still
 * classify `failed`, still carry the calm `skipped — …` notice, still publish the availability chip, and
 * still walk the durable state to `local_blocked` (the operator has now been told).
 */
it("control: the same blocked lane with the signal NEVER aborted still classifies `failed`", async () => {
  const { session, dbPath, blobRoot } = await makeSession();
  initLaneAvailabilityStore(session.repoRoot);
  noteLaneFailure("claude", CREDIT, Date.now());
  const bus = new ChatEventBus();
  const events = capture(bus);
  const { dispatch, calls } = recordingDispatch();

  const outcomes = await dispatchTurn(
    session,
    bus,
    { dbPath, blobRoot },
    "claude",
    5,
    dispatch,
    new AbortController().signal,
  );

  expect(outcomes[0]?.state).toBe("failed");
  expect(terminalState(events, "claude")).toBe("failed");
  expect(outcomes[0]?.error).toContain("skipped");
  expect(calls).toEqual([]);
  expect(availabilityFor(events, "claude")).toHaveLength(1);
  expect(getLaneAvailability("claude").state).toBe("local_blocked");
});

// ===========================================================================================
// SECTION 2 — the sanctioned-retry road into the same gate, which the finding names explicitly.
// ===========================================================================================

/**
 * RED #2 — the second road into the gate, named in the finding: "a sanctioned-retry gate rejection takes
 * the same road". A lane whose reset window has passed is ALLOWED through as one recovery probe
 * (evaluateSend's `retrying` branch), and the gate does real work for it before returning: it publishes a
 * `retrying` chip and drops the lane's held bridge connection (forceFreshConnection). On an already-
 * cancelled lane every bit of that is wasted and lying — the chrome is told a recovery attempt is in
 * flight for a turn that will never dispatch, and the durable state is moved to `retrying`, where a
 * later unclassified failure resolves it.
 *
 * WHAT WRONG IMPLEMENTATION WOULD STILL PASS THIS? One that only guarded the BLOCKED branch: this lane is
 * not blocked, it is allowed, so a blocked-branch-only guard returns undefined here and dispatches.
 */
it("RED: a sanctioned retry whose signal is already aborted classifies `cancelled` and stays put", async () => {
  const { session, dbPath, blobRoot } = await makeSession();
  initLaneAvailabilityStore(session.repoRoot);
  const now = Date.now();
  // Died a minute ago with a reset window that has ALREADY passed → plausiblyReset is true, so this send
  // is the sanctioned recovery probe rather than a block.
  noteLaneFailure("claude", CREDIT, now - 60_000, now - 30_000);
  const bus = new ChatEventBus();
  const events = capture(bus);
  const { dispatch, calls } = recordingDispatch();

  const outcomes = await dispatchTurn(
    session,
    bus,
    { dbPath, blobRoot },
    "claude",
    6,
    dispatch,
    abortedSignal(),
  );

  expect(outcomes[0]?.state).toBe("cancelled");
  expect(calls).toEqual([]); // the recovery probe was NOT burned on a cancelled turn
  expect(availabilityFor(events, "claude")).toEqual([]); // no "working on it" chip for a stopped turn
  expect(getLaneAvailability("claude").state).toBe("exhausted"); // not walked to `retrying`
});

/** THE ANTI-INVERSION CONTROL for RED #2: an uncancelled sanctioned retry must still be allowed through,
 *  still publish its `retrying` chip, and still actually dispatch. */
it("control: the same sanctioned retry with the signal NEVER aborted still dispatches", async () => {
  const { session, dbPath, blobRoot } = await makeSession();
  initLaneAvailabilityStore(session.repoRoot);
  const now = Date.now();
  noteLaneFailure("claude", CREDIT, now - 60_000, now - 30_000);
  const bus = new ChatEventBus();
  const events = capture(bus);
  const { dispatch, calls } = recordingDispatch();

  await dispatchTurn(
    session,
    bus,
    { dbPath, blobRoot },
    "claude",
    6,
    dispatch,
    new AbortController().signal,
  );

  expect(calls).toEqual(["claude"]);
  expect(startedFor(events, "claude")).toHaveLength(1);
  const chips = availabilityFor(events, "claude");
  expect(chips.length).toBeGreaterThanOrEqual(1);
});

// ===========================================================================================
// SECTION 3 — a HEALTHY lane cancelled before the gate: the case that proves no child is burned.
// ===========================================================================================

/**
 * RED #3 — the widest case, and the reason the guard belongs at the TOP of the gate rather than on its
 * blocked branch. Nothing is wrong with this lane; the operator simply stopped the turn while the room
 * was still setting the lane up. Today the gate allows it, `dispatch.started` fires, and a child is spawned
 * for a turn that was already cancelled — the classification is then repaired downstream by
 * markCarrierTerminal/handleEscapedLaneError, but only AFTER the work was done.
 *
 * WHAT WRONG IMPLEMENTATION WOULD STILL PASS THIS? Not one that classifies late: `calls` proves the
 * adapter was never reached, which no downstream classifier can achieve.
 */
it("RED: a ready lane with an already-aborted signal never reaches the adapter", async () => {
  const { session, dbPath, blobRoot } = await makeSession();
  initLaneAvailabilityStore(session.repoRoot); // claude is ready — never classified dead
  const bus = new ChatEventBus();
  const events = capture(bus);
  const { dispatch, calls } = recordingDispatch();

  const outcomes = await dispatchTurn(
    session,
    bus,
    { dbPath, blobRoot },
    "claude",
    1,
    dispatch,
    abortedSignal(),
  );

  expect(outcomes[0]?.state).toBe("cancelled");
  expect(calls).toEqual([]);
  expect(startedFor(events, "claude")).toHaveLength(0);
  expect(getLaneAvailability("claude").state).toBe("ready"); // a cancel is not evidence of health either
});

/** THE ANTI-INVERSION CONTROL for RED #3, and the one that refutes "make everything a cancel": an
 *  uncancelled ready lane must still dispatch and still complete. */
it("control: a ready lane with the signal NEVER aborted still dispatches and completes", async () => {
  const { session, dbPath, blobRoot } = await makeSession();
  initLaneAvailabilityStore(session.repoRoot);
  const bus = new ChatEventBus();
  const events = capture(bus);
  const { dispatch, calls } = recordingDispatch();

  const outcomes = await dispatchTurn(
    session,
    bus,
    { dbPath, blobRoot },
    "claude",
    1,
    dispatch,
    new AbortController().signal,
  );

  expect(outcomes[0]?.state).toBe("completed");
  expect(calls).toEqual(["claude"]);
  expect(startedFor(events, "claude")).toHaveLength(1);
});

/** All three lanes, one cancel: the seam is agent-agnostic and must not be pinned on claude alone (the
 *  gap FL-134's review found in the sibling contract file — every case there drove `claude`). */
it("RED: the same pre-gate cancel classifies `cancelled` for codex and gemini too", async () => {
  const { session, dbPath, blobRoot } = await makeSession();
  initLaneAvailabilityStore(session.repoRoot);
  const bus = new ChatEventBus();
  const { dispatch, calls } = recordingDispatch();
  const signal = abortedSignal();

  const codex = await dispatchTurn(
    session,
    bus,
    { dbPath, blobRoot },
    "codex",
    1,
    dispatch,
    signal,
  );
  const gemini = await dispatchTurn(
    session,
    bus,
    { dbPath, blobRoot },
    "gemini",
    2,
    dispatch,
    signal,
  );

  expect(codex[0]?.state).toBe("cancelled");
  expect(gemini[0]?.state).toBe("cancelled");
  expect(calls).toEqual([]);
});
