/**
 * @file src/chat/lane-cancel-classification.test.ts
 * @purpose THE CANCEL CONTRACT, at the dispatch seam (forced-fault injection, no CLI spawn). The operator
 *   pressed Ctrl+C and the room said `◀ claude — failed: carrier failed` + `claude auto offline`. These
 *   falsifiers pin the three halves of that: a cancelled ACP turn classifies `cancelled` (never `failed`),
 *   a cancel never marks the agent chip down, and — the anti-inversion control — a GENUINE transport
 *   failure still classifies `failed` AND still marks the chip down. Every assertion is on the
 *   CLASSIFICATION, never on "a terminal row appeared": a row appears today, with the wrong word in it.
 * @exports (none — test file)
 * @depends node:fs/promises, node:os, node:path, vitest, ../evidence/db, ../shared/agent-grant, ./events,
 *   ./evidence, ./evidence-identity, ./headless-turn, ./lane-availability-store, ./lane-gate, ./lane-transport, ./types
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { closeDb, openLaneStateDb } from "../evidence/db.js";
import { CHAT_GRANT } from "../shared/agent-grant.js";
import type { AgentResult } from "../shared/types.js";
import type { HeadlessDispatch } from "./dispatch-headless.js";
import { type ChatEvent, ChatEventBus } from "./events.js";
import { chatRunId } from "./evidence-identity.js";
import { recordChatSession } from "./evidence.js";
import { runHeadlessTurn } from "./headless-turn.js";
import {
  initLaneAvailabilityStore,
  resetLaneAvailabilityStore,
} from "./lane-availability-store.js";
import { recordLaneDispatchResult } from "./lane-gate.js";
import { initCarrierRuntime, resetCarrierRuntime } from "./lane-transport.js";
import type { ChatSession } from "./types.js";

const dirs: string[] = [];
const savedFlags = { memory: process.env.ZER0_MEMORY, resume: process.env.ZER0_NATIVE_RESUME };

afterEach(async () => {
  resetCarrierRuntime();
  resetLaneAvailabilityStore();
  restoreFlag("ZER0_MEMORY", savedFlags.memory);
  restoreFlag("ZER0_NATIVE_RESUME", savedFlags.resume);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

function restoreFlag(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

async function makeSession(): Promise<{ session: ChatSession; dbPath: string; blobRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "lane-cancel-"));
  dirs.push(root);
  const runDir = path.join(root, "run");
  await mkdir(path.join(runDir, "prompts"), { recursive: true });
  await mkdir(path.join(runDir, "responses"), { recursive: true });
  const blobRoot = path.join(root, "blobs");
  await mkdir(blobRoot, { recursive: true });
  const dbPath = path.join(root, "evidence.db");
  const now = new Date().toISOString();
  const id = "chat-lane-cancel" as const;
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

function insertProject(dbPath: string, session: ChatSession): void {
  const db = openLaneStateDb(dbPath);
  db.prepare(
    "INSERT OR IGNORE INTO projects(project_id, canonical_root, git_common_dir, created_at) VALUES (?,?,?,?)",
  ).run("p1", session.repoRoot, path.join(session.repoRoot, ".git"), session.createdAt);
  closeDb(db);
}

function capture(bus: ChatEventBus): ChatEvent[] {
  const events: ChatEvent[] = [];
  for (const kind of ["dispatch.started", "dispatch.failed", "agent.status"] as const) {
    bus.on(kind, (event) => events.push(event));
  }
  return events;
}

/** The `agent.status` events that would paint ` offline` on the chip (room_runtime.rs's agent_is_offline
 *  reads `auth == Down`). The whole point of the cancel contract is that this list stays EMPTY. */
function authDownFor(events: ChatEvent[], agent: string): ChatEvent[] {
  return events.filter((e) => e.kind === "agent.status" && e.agent === agent && e.auth === "down");
}

/**
 * A fake ACP carrier whose held prompt runs `onPrompt` and then decides the turn's fate. Reproduces the
 * REAL production shape of a room cancel on an ACP lane: the room engine aborts the lane controller and
 * room-host's onCancel drops the hold (room-engine.ts:485-487 → room-host.ts:110-112), which kills the
 * bridge child UNDER the in-flight prompt — so the prompt REJECTS. Nothing on this path ever throws an
 * AbortError, which is exactly why the carrier could not tell a cancel from a transport death.
 */
function initFakeCarrier(
  session: ChatSession,
  dbPath: string,
  onPrompt: (emitText: (chunk: string) => void) => void,
): void {
  initCarrierRuntime({
    projectId: "p1",
    dbPath,
    repoRoot: session.repoRoot,
    cwd: session.repoRoot,
    openConnection: async (input) => ({
      initialize: async () => ({}),
      newSession: async () => ({ sessionId: "s-cancel" }),
      resumeSession: async () => ({}),
      prompt: async () => {
        onPrompt((chunk) => input.onText?.(chunk));
        return "end_turn";
      },
      setMode: async () => undefined,
      close: () => undefined,
      waitForExit: async () => true,
      killTree: async () => undefined,
      isAlive: () => true,
      pid: () => 31337,
    }),
  });
}

function carrierTurn(
  session: ChatSession,
  cfg: { readonly dbPath: string; readonly blobRoot: string },
  bus: ChatEventBus,
  signal: AbortSignal,
  turn: number,
  opts?: {
    readonly agent?: "claude" | "codex" | "gemini";
    readonly canonicalizeLaneText?: (agent: string, text: string) => string;
  },
) {
  const dispatch: HeadlessDispatch = async (): Promise<AgentResult> => {
    throw new Error("buffered dispatch must not run on the carrier path");
  };
  return runHeadlessTurn({
    session,
    addresses: [{ agent: opts?.agent ?? ("claude" as const), prompt: "hello" }],
    bus,
    turn,
    laneClass: "chat" as const,
    grant: CHAT_GRANT,
    config: cfg,
    signal,
    dispatch,
    ...(opts?.canonicalizeLaneText === undefined
      ? {}
      : { canonicalizeLaneText: opts.canonicalizeLaneText }),
  });
}

/**
 * RED #1 — the operator's exact sighting. Cancelling an in-flight ACP turn is reported as a FAILURE.
 *
 * WHAT WRONG IMPLEMENTATION WOULD STILL PASS THIS? Not "the lane produced a terminal row" — today's
 * broken tree produces one. Not "the lane did not complete" — a cancel and a death agree on that. The
 * assertion is on the CLASSIFICATION VALUE (`cancelled`) and on the ABSENCE of the literal death text
 * the operator read on screen. Only a carrier that actually distinguishes the two can pass.
 */
it("RED: a cancelled ACP turn classifies `cancelled` — not `failed: carrier failed`", async () => {
  process.env.ZER0_MEMORY = "1";
  process.env.ZER0_NATIVE_RESUME = "1";
  const { session, dbPath, blobRoot } = await makeSession();
  insertProject(dbPath, session);
  const controller = new AbortController();
  initFakeCarrier(session, dbPath, (emitText) => {
    emitText("partial answer before the operator hit Ctrl+C");
    // The room's cancel, in production order: abort the lane controller, THEN drop the hold — which
    // kills the child under the live prompt. The prompt rejection is the only thing the carrier sees.
    controller.abort();
    throw new Error("bridge connection closed");
  });
  const bus = new ChatEventBus();

  const outcomes = await carrierTurn(session, { dbPath, blobRoot }, bus, controller.signal, 1);

  expect(outcomes[0]?.state).toBe("cancelled");
  expect(outcomes[0]?.error ?? "").not.toContain("carrier failed");
});

/**
 * RED #2 — the footer lie. A deliberate cancel took the agent offline.
 *
 * WHAT WRONG IMPLEMENTATION WOULD STILL PASS THIS? One that never marks ANY lane down — which is why
 * the genuine-failure control below asserts the opposite for a real transport death. Together they pin
 * the distinction rather than either extreme. `auth: "down"` is the exact field room_runtime.rs's
 * agent_is_offline reads to paint the ` offline` suffix the operator photographed.
 */
it("RED: a cancel does not mark the agent chip down (no ` offline` in the footer)", async () => {
  process.env.ZER0_MEMORY = "1";
  process.env.ZER0_NATIVE_RESUME = "1";
  const { session, dbPath, blobRoot } = await makeSession();
  insertProject(dbPath, session);
  const controller = new AbortController();
  initFakeCarrier(session, dbPath, () => {
    controller.abort();
    throw new Error("bridge connection closed");
  });
  const bus = new ChatEventBus();
  const events = capture(bus);

  await carrierTurn(session, { dbPath, blobRoot }, bus, controller.signal, 1);

  expect(authDownFor(events, "claude")).toEqual([]);
});

/**
 * THE ANTI-INVERSION CONTROL. Losing the cancel/failure distinction the other way is the SAME defect
 * pointing backwards, and it would be invisible without this test: RED #1 and RED #2 both pass against
 * an implementation that calls everything a cancel. A real transport death — signal NOT aborted — must
 * still classify `failed` and must still mark the chip down.
 */
it("control: a GENUINE transport failure still classifies `failed` and still marks the chip down", async () => {
  process.env.ZER0_MEMORY = "1";
  process.env.ZER0_NATIVE_RESUME = "1";
  const { session, dbPath, blobRoot } = await makeSession();
  insertProject(dbPath, session);
  const live = new AbortController(); // never aborted — nobody cancelled anything
  initFakeCarrier(session, dbPath, () => {
    throw new Error("bridge connection closed");
  });
  const bus = new ChatEventBus();
  const events = capture(bus);

  const outcomes = await carrierTurn(session, { dbPath, blobRoot }, bus, live.signal, 1);

  expect(outcomes[0]?.state).toBe("failed");
  expect(authDownFor(events, "claude")).toHaveLength(1);
});

/**
 * FL-134 — THE THIRD CANCEL SEAM. RED #1/#2 and the control above all drive a throw at DISPATCH itself
 * (dispatchCarrierLane's own catch, which already reads the signal via classifyLaneError). This one drives
 * a throw AFTER dispatch already succeeded — `canonicalizeLaneText` is a caller hook that runs between the
 * carrier's prompt finishing and response writing/finalizeLane, still inside runOneLane's outer try
 * (headless-carrier.ts:73-74). Nothing on that path ever threw before FL-125/FL-134, so this is the seam
 * codex's cross-family review found by reading and could not reproduce (its sandbox was read-only) — this
 * reproduces it at runtime. Before the fix: the outer catch (headless-turn.ts's runOneLane) built its
 * outcome with a hardcoded `state: "failed"`, never consulting the signal, and re-threw — so `carrierTurn`
 * REJECTED instead of resolving with a `cancelled` outcome.
 *
 * WHAT WRONG IMPLEMENTATION WOULD STILL PASS THIS? Not "the lane produced some terminal" — a failed escape
 * does that too, by rejecting. The assertion needs the promise to RESOLVE (not reject) with the classified
 * value `cancelled`.
 */
it("RED: a throw AFTER carrier dispatch succeeds, with the signal aborted, classifies `cancelled` — not `failed`", async () => {
  process.env.ZER0_MEMORY = "1";
  process.env.ZER0_NATIVE_RESUME = "1";
  const { session, dbPath, blobRoot } = await makeSession();
  insertProject(dbPath, session);
  const controller = new AbortController();
  initFakeCarrier(session, dbPath, (emitText) => {
    emitText("a reply the carrier finished normally");
  });
  const bus = new ChatEventBus();
  const events = capture(bus);

  const outcomes = await carrierTurn(session, { dbPath, blobRoot }, bus, controller.signal, 1, {
    canonicalizeLaneText: () => {
      // The operator's cancel lands in the SAME window as this throw — the two race, exactly as the
      // review described (room-engine aborts the controller, the bridge child dies underneath).
      controller.abort();
      throw new Error("canonicalize blew up");
    },
  });

  expect(outcomes[0]?.state).toBe("cancelled");
  expect(authDownFor(events, "claude")).toEqual([]);
});

/**
 * The anti-inversion control for the SAME seam: a genuine post-dispatch throw, signal never aborted, must
 * still fail the turn (rejecting, unchanged from FIX-3c BLOCK 1) and still mark the chip down — pinned
 * independently of headless-turn-boundary-trace.test.ts's FALSIFIER, which exercises a different throw
 * source (a throwing bus) at the same outer catch.
 */
it("control: the same post-dispatch throw, signal NOT aborted, still fails the turn and marks the chip down", async () => {
  process.env.ZER0_MEMORY = "1";
  process.env.ZER0_NATIVE_RESUME = "1";
  const { session, dbPath, blobRoot } = await makeSession();
  insertProject(dbPath, session);
  const live = new AbortController(); // never aborted — nobody cancelled anything
  initFakeCarrier(session, dbPath, (emitText) => {
    emitText("a reply the carrier finished normally");
  });
  const bus = new ChatEventBus();
  const events = capture(bus);

  await expect(
    carrierTurn(session, { dbPath, blobRoot }, bus, live.signal, 1, {
      canonicalizeLaneText: () => {
        throw new Error("canonicalize blew up for real");
      },
    }),
  ).rejects.toThrow("canonicalize blew up for real");

  expect(authDownFor(events, "claude")).toHaveLength(1);
});

/**
 * THE MISSING CODEX CASE. The classifier this seam shares (classifyLaneError's cousin here — a plain
 * signal.aborted check, same rule as markCarrierTerminal) is agent-agnostic, but until now every carrier
 * test in this file drove `claude` and gemini appeared only at the direct recordLaneDispatchResult seam
 * (`rg -n codex` returned nothing in this file). Same reproduction as the RED case above, driven through
 * codex's own carrier address.
 */
it("RED: the same post-dispatch cancel classifies `cancelled` for codex too", async () => {
  process.env.ZER0_MEMORY = "1";
  process.env.ZER0_NATIVE_RESUME = "1";
  const { session, dbPath, blobRoot } = await makeSession();
  insertProject(dbPath, session);
  const controller = new AbortController();
  initFakeCarrier(session, dbPath, (emitText) => {
    emitText("a reply the carrier finished normally");
  });
  const bus = new ChatEventBus();
  const events = capture(bus);

  const outcomes = await carrierTurn(session, { dbPath, blobRoot }, bus, controller.signal, 1, {
    agent: "codex",
    canonicalizeLaneText: () => {
      controller.abort();
      throw new Error("canonicalize blew up");
    },
  });

  expect(outcomes[0]?.state).toBe("cancelled");
  expect(authDownFor(events, "codex")).toEqual([]);
});

/**
 * THE GEMINI HALF, at its own seam. gemini already classifies a cancel correctly — agy-runner.ts:113-115
 * rejects with a DispatchError on abort, the throw reaches dispatchCarrierLane's catch
 * (headless-carrier.ts:137) and classifyLaneError reads the signal — which is why the operator read
 * `▲ gemini — cancelled` and not `failed`. It STILL went ` offline`, because the chip is marked one layer
 * up, in recordLaneDispatchResult, which reads only exitCode and the error TEXT and never the state. So a
 * correctly-classified cancel is painted unreachable anyway. Driven directly rather than through a faked
 * agy PTY: this is the exact function and the exact outcome shape gemini's cancel arrives with.
 *
 * WHAT WRONG IMPLEMENTATION WOULD STILL PASS THIS? One that never marks anything down — refuted by the
 * genuine-failure control above, which drives the SAME function and requires the chip to go down.
 */
it("RED: recordLaneDispatchResult leaves the chip up for a cancelled outcome", async () => {
  const { session } = await makeSession();
  const bus = new ChatEventBus();
  const events = capture(bus);
  initLaneAvailabilityStore(session.repoRoot);

  const ctx = {
    bus,
    repoRoot: session.repoRoot,
    turn: 1,
    // FL-144: the gate context carries the turn's signal now. This case drives the recorder DIRECTLY with an
    // already-`cancelled` outcome — the classification arrived from gemini's own runner (agy-runner.ts
    // rejects on abort), so the recorder must honour the state it is handed without re-deriving it here.
    signal: new AbortController().signal,
  };
  recordLaneDispatchResult(ctx, "gemini", {
    agent: "gemini",
    text: "the partial reply gemini streamed before the operator hit Ctrl+C",
    exitCode: 1,
    state: "cancelled",
    error: "agy dispatch aborted", // the DispatchError text agy-runner.ts:113-115 produces
  });

  expect(authDownFor(events, "gemini")).toEqual([]);
});

/**
 * Contract item 4: the lane stays usable. In the operator's own session claude answered normally on the
 * very next message, and no fix may regress that — a cancel that quietly blocked the lane would trade a
 * visible lie for an invisible one.
 */
it("a lane cancelled on turn 1 dispatches and completes normally on turn 2", async () => {
  process.env.ZER0_MEMORY = "1";
  process.env.ZER0_NATIVE_RESUME = "1";
  const { session, dbPath, blobRoot } = await makeSession();
  insertProject(dbPath, session);
  const controller = new AbortController();
  let turns = 0;
  initFakeCarrier(session, dbPath, (emitText) => {
    turns += 1;
    if (turns === 1) {
      controller.abort();
      throw new Error("bridge connection closed");
    }
    emitText("the next answer");
  });
  const cfg = { dbPath, blobRoot };

  await carrierTurn(session, cfg, new ChatEventBus(), controller.signal, 1);
  const bus = new ChatEventBus();
  const events = capture(bus);
  const next = await carrierTurn(session, cfg, bus, new AbortController().signal, 2);

  expect(turns).toBe(2); // the second send was NOT gated away
  expect(next[0]?.state).toBe("completed");
  expect(next[0]?.text).toBe("the next answer");
  expect(authDownFor(events, "claude")).toEqual([]);
});
