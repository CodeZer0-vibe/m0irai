/**
 * @file src/chat/headless-carrier-cancel.test.ts
 * @purpose FL-150 ROUND 2 (review P1-A) — PIN THE ONE LINE THAT CLOSES THE OPERATOR'S DEFECT ON THE
 *   claude/codex PATH. The reviewer's finding, measured: replace `signal: input.signal` at
 *   `headless-carrier.ts`'s ACP `runCarrierTurn` assembly with `new AbortController().signal` and
 *   **250 test files / 1961 tests all pass** — the whole of FL-150 cut, silently, with every gate
 *   green. The identical cut on the agy branch failed 2 tests, because `assertOneCancelAuthority`
 *   guarded it. That is the ACP-vs-PTY asymmetry this lane exists to remove, reproduced one layer up
 *   inside the lane's own fix. This file is the claude/codex half of that guard.
 * @exports (test suite — no runtime exports)
 * @depends node:fs/promises, node:os, node:path, vitest, ../evidence/db, ../shared/agent-grant,
 *   ./dispatch-headless, ./events, ./evidence, ./evidence-identity, ./headless-turn, ./lane-transport
 *
 * THE WHOLE SHIPPED LANE, not a unit of it: `runHeadlessTurn` -> `runCarrierHeadlessLane` ->
 * `dispatchAcpCarrier` -> `runCarrierTurn` -> the real acquire and the real held transport.
 * `openConnection` is the ONE injected seam, standing where a bridge child would be, and it counts
 * every prompt that reaches it. Testing `runCarrierTurn` directly would prove the carrier consults a
 * signal — it could not prove the lane hands it the RIGHT one, which is exactly what was unpinned.
 *
 * WHY THE ASSERTION IS "the fake bridge was never prompted". A cancelled turn must not reach an agent.
 * If the wiring passes any signal other than this turn's, the abort below is invisible to the carrier
 * and the prompt goes out — `prompts` becomes 1 and this fails. If the wiring is right, the carrier's
 * own guards stop it and `prompts` stays 0. The positive control underneath proves the fixture can
 * deliver a prompt at all, so a green here is the guard working rather than a harness that never
 * reaches the send.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { closeDb, openLaneStateDb } from "../evidence/db.js";
import { CHAT_GRANT } from "../shared/agent-grant.js";
import type { AgentResult } from "../shared/types.js";
import type { HeadlessDispatch } from "./dispatch-headless.js";
import { ChatEventBus } from "./events.js";
import { chatRunId } from "./evidence-identity.js";
import { recordChatSession } from "./evidence.js";
import { runHeadlessTurn } from "./headless-turn.js";
import { initCarrierRuntime, resetCarrierRuntime } from "./lane-transport.js";
import type { ChatSession } from "./types.js";

const dirs: string[] = [];
const savedFlags = { memory: process.env.ZER0_MEMORY, resume: process.env.ZER0_NATIVE_RESUME };

afterEach(async () => {
  resetCarrierRuntime();
  restoreFlag("ZER0_MEMORY", savedFlags.memory);
  restoreFlag("ZER0_NATIVE_RESUME", savedFlags.resume);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function restoreFlag(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

interface Fixture {
  readonly session: ChatSession;
  readonly dbPath: string;
  readonly blobRoot: string;
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "fl150-headless-cancel-"));
  dirs.push(root);
  const runDir = path.join(root, "run");
  await mkdir(path.join(runDir, "prompts"), { recursive: true });
  await mkdir(path.join(runDir, "responses"), { recursive: true });
  const blobRoot = path.join(root, "blobs");
  await mkdir(blobRoot, { recursive: true });
  const dbPath = path.join(root, "evidence.db");
  const now = new Date().toISOString();
  const id = "chat-fl150-cancel" as const;
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
  const db = openLaneStateDb(dbPath);
  db.prepare(
    "INSERT OR IGNORE INTO projects(project_id, canonical_root, git_common_dir, created_at) VALUES (?,?,?,?)",
  ).run("p1", root, path.join(root, ".git"), now);
  closeDb(db);
  return {
    session: {
      id,
      repoRoot: root,
      runDir,
      createdAt: now,
      updatedAt: now,
      defaultAgent: "claude" as const,
      lastAgent: null,
      summary: { text: "", throughTurn: 0 },
      messages: [],
    },
    dbPath,
    blobRoot,
  };
}

/** The real carrier registry and the real held transport; this fake stands where the bridge child is,
 *  and counts every prompt that actually reached an agent. */
function initCountingCarrier(fx: Fixture, prompts: string[], duringAcquire?: () => void): void {
  initCarrierRuntime({
    projectId: "p1",
    dbPath: fx.dbPath,
    repoRoot: fx.session.repoRoot,
    cwd: fx.session.repoRoot,
    openConnection: async (input) => ({
      initialize: async () => ({}),
      newSession: async () => {
        // The one place a test can stand INSIDE the in-flight handshake. Optional, so the two cases
        // that do not need it are unchanged.
        duringAcquire?.();
        return { sessionId: "s-carrier" };
      },
      resumeSession: async () => ({}),
      prompt: async (_sessionId: string, text: string) => {
        prompts.push(text);
        input.onText?.("carrier reply");
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

async function runOneAcpTurn(fx: Fixture, signal: AbortSignal) {
  const dispatch: HeadlessDispatch = async (): Promise<AgentResult> => {
    throw new Error("the buffered non-carrier dispatch must not run on this path");
  };
  return runHeadlessTurn({
    session: fx.session,
    addresses: [{ agent: "claude", prompt: "answer me" }],
    bus: new ChatEventBus(),
    turn: 1,
    laneClass: "chat",
    grant: CHAT_GRANT,
    config: { dbPath: fx.dbPath, blobRoot: fx.blobRoot },
    signal,
    dispatch,
  });
}

it("a cancelled claude lane never prompts the bridge — the ACP branch's cancel wiring, pinned", async () => {
  process.env.ZER0_MEMORY = "1";
  process.env.ZER0_NATIVE_RESUME = "1";
  const fx = await makeFixture();
  const prompts: string[] = [];
  initCountingCarrier(fx, prompts);
  const controller = new AbortController();
  // THE OPERATOR PRESSED ESC BEFORE THIS LANE GOT ITS TURN — the state any lane behind a cancelled
  // turn is dispatched in, and the state a queued lane is admitted in after a room-wide cancel.
  controller.abort();

  const outcomes = await runOneAcpTurn(fx, controller.signal);

  expect(
    prompts,
    "a prompt reached claude through a cancelled turn — the carrier was handed a signal that is not the lane's",
  ).toEqual([]);
  expect(outcomes[0]?.state, "a stopped lane must read as cancelled, never as a failure").toBe(
    "cancelled",
  );
  // WHICH DOOR SHUT, pinned — because "no prompt" alone goes green whichever guard fired, and a test
  // that cannot name the guard cannot tell that the wiring broke. On THIS tree the door is FL-144's
  // pre-dispatch gate (`lane-gate.ts`'s `cancelledBeforeDispatch`, text `stopped before it started`),
  // which classifies an already-aborted turn BEFORE the carrier is ever reached. That is correct and
  // it is deliberately pinned: a change that routed this case past the gate would be a real behaviour
  // change on the seam FL-144 exists to hold. It leaves the CARRIER's own acquire door unpinned here,
  // so the case below — abort landing after the gate has already passed — pins that one instead.
  expect(
    outcomes[0]?.error,
    "a turn aborted before dispatch must be stopped by the pre-dispatch gate, not further down",
  ).toContain("stopped before it started");
});

it("a claude lane cancelled DURING acquisition is refused at the carrier's own door", async () => {
  // THE CASE THE PIN ABOVE USED TO MEAN, and the window FL-144's gate cannot cover: the operator's Esc
  // lands AFTER `gateLaneOrBlock` has already let this lane through and while the bridge is still
  // handshaking. The gate has had its one look and passed; from here only the signal the ACP assembly
  // handed the carrier can stop the prompt. `lane-acquire.ts`'s `throwIfAborted` after
  // `transport.start` is the door that shuts, and its wording ("session acquisition aborted") is what
  // distinguishes it from `assertTurnCancelAuthority`'s wiring throw and from the gate's text above —
  // which is why the reason is asserted and not merely the count.
  process.env.ZER0_MEMORY = "1";
  process.env.ZER0_NATIVE_RESUME = "1";
  const fx = await makeFixture();
  const prompts: string[] = [];
  const controller = new AbortController();
  // The abort fires from INSIDE the session handshake — the transport call is in flight, exactly where
  // a real Esc lands during a cold bridge open — so the gate is already behind us when it happens.
  initCountingCarrier(fx, prompts, () => controller.abort());

  const outcomes = await runOneAcpTurn(fx, controller.signal);

  expect(
    prompts,
    "a prompt reached claude after the turn was cancelled mid-acquire — the carrier was handed a signal that is not the lane's",
  ).toEqual([]);
  expect(outcomes[0]?.state, "a stopped lane must read as cancelled, never as a failure").toBe(
    "cancelled",
  );
  expect(
    outcomes[0]?.error,
    "the lane stopped for some reason other than the carrier reading its own cancel",
  ).toContain("session acquisition aborted");
});

it("the same lane, uncancelled, does prompt the bridge", async () => {
  // The positive control. Without it the case above could pass because this fixture never reaches the
  // carrier at all — a green that proves the harness is broken rather than the guard is working.
  process.env.ZER0_MEMORY = "1";
  process.env.ZER0_NATIVE_RESUME = "1";
  const fx = await makeFixture();
  const prompts: string[] = [];
  initCountingCarrier(fx, prompts);

  const outcomes = await runOneAcpTurn(fx, new AbortController().signal);

  expect(prompts, "the fixture must be able to deliver a prompt at all").toHaveLength(1);
  expect(prompts[0]).toContain("answer me");
  expect(outcomes[0]?.text).toBe("carrier reply");
  expect(outcomes[0]?.exitCode).toBe(0);
});
