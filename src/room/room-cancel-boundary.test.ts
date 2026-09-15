/**
 * @file src/room/room-cancel-boundary.test.ts
 * @purpose FL-133 — THE CANCEL CONTRACT AT THE ROOM SEAM, where the operator actually presses the key.
 *   Every cancellation defect of 2026-08-21 (FL-125, FL-125b, FL-134, FL-146) shipped through a full
 *   green verify, a merged-tree verify AND a hostile cross-family review, for one reason: nothing in the
 *   suite cancelled a turn at the ROOM boundary. `room-engine-cancel-scope.test.ts` reaches
 *   `engine.cancel` but stubs `runLane` to return `{status:"cancelled"}`, so it asserts `lane.cancelling`
 *   events and can never see a lane misclassify itself; `lane-cancel-classification.test.ts` runs the
 *   real lane but builds its own AbortController and never touches the room.
 *
 *   THE BOUNDARY THIS FILE CANCELS AT. Ctrl+C → `room_runtime.rs:663 request_cancel_all` →
 *   `RoomCancelAll` → `pager_room.rs:441-452 run_cancel_bridge` sends `zer0/room/control`
 *   {command: Cancel, scope: All} → `zer0-v2-host.ts:562 acknowledgeControl` → `host.control(...)`.
 *   `host.control` is the call that line makes, so this is the key's own path with one JSON parse
 *   (`parseControl`) above it — NOT a direct call to a chat-lane function.
 *
 *   THE TWO OBSERVABLES are the ones the operator photographed, read off the SAME room-event stream the
 *   pager renders from: the terminal row per agent, and `agent.status auth:"down"`, which is exactly
 *   what `room_runtime.rs`'s agent_is_offline paints ` offline` from.
 *
 *   WHAT KILLS THIS FILE — the mutation record, re-run from scratch on 2026-08-21 rather than inherited.
 *   Each production seam was disabled ONE AT A TIME on this base and the file re-run; the quoted rows are
 *   its own output, and every mutation was reverted (`git diff --stat` checked before each run, so a sed
 *   that silently missed its line could not be read as "that seam does not matter" — one did miss, once).
 *     - `headless-carrier.ts:430` markCarrierTerminal's `signal.aborted` -> false:
 *         claude "failed: carrier failed", codex "failed: carrier failed", gemini "cancelled"
 *         and auth-down {claude: 1, codex: 1, gemini: 0}. THAT IS THE OPERATOR'S PHOTOGRAPH, both
 *         halves of FL-125 at once, from a room-boundary cancel. The anti-inversion control stayed GREEN.
 *     - `lane-gate.ts:123` recordLaneDispatchResult's cancelled-skip removed:
 *         auth-down {claude: 1, codex: 1, gemini: 1} — all three chips ` offline`, FL-125b exactly, while
 *         the classification test stayed GREEN. The two tests pin INDEPENDENT halves; neither covers both.
 *     - `turn-lifecycle.ts:39` classifyLaneError's abort-wins removed:
 *         gemini "failed: agy dispatch aborted" and gemini auth-down 1 — the PTY seam, which the two ACP
 *         mutations above leave untouched. Three separate production seams, three separate kills.
 *     - `lane-gate.ts:182` handleEscapedLaneError's `signal.aborted` -> false: NOTHING CHANGED. See below.
 *
 *   ⚠ WHAT THIS FILE DOES NOT COVER, MEASURED RATHER THAN ASSUMED. FL-134's seam — a throw AFTER carrier
 *   dispatch, relabelled `failed` by `runOneLane`'s outer catch — is NOT reachable from the room boundary
 *   here. Proven by reverting it: with `handleEscapedLaneError`'s `signal.aborted` read replaced by
 *   `false` (`lane-gate.ts`), all four tests below stayed byte-identical. The reason is structural, not a
 *   gap in the harness: after `dispatchCarrierLane` returns, the only steps in that window that CAN throw
 *   are the persistence ones (`finalizeLane`, `settleLane`), and `writeResponseFile` swallows its own
 *   errors (`headless-carrier.ts:389-391`). Forcing a persistence throw destroys the durable row the
 *   transcript is built from, so the room reports `failed: ... was not durably committed` for its own
 *   reason — identically with and without the fix, which was measured too. FL-134 therefore stays covered
 *   ONLY at the chat-lane seam, by `lane-cancel-classification.test.ts:322-350`. Reaching it from the
 *   room would need a production injection seam that does not exist, and inventing one was out of scope.
 *   RE-MEASURED, and one further hypothesis of my own REFUTED: the natural guess is that once FL-146
 *   lands, a superseded open throws HOLD_SUPERSEDED_REASON (`lane-hold.ts:162`) and THAT escape finally
 *   walks through handleEscapedLaneError, covering FL-134 here for free. It does not. With
 *   fl146-cancel-race's real fix applied AND the `lane-gate.ts:182` mutation stacked on top of it, all
 *   four tests stayed GREEN. The gap is the same size after the fix as before it.
 * @exports (none — test file)
 * @depends vitest, ../chat/lane-availability-store, ../chat/lane-transport, ../chat/types,
 *   ./room-cancel-boundary.fixtures, ./room-engine
 */
import { afterEach, expect, it, vi } from "vitest";
import type { AgentName } from "../chat/types.js";
import {
  type GeminiSlot,
  type RoomCancelHarness,
  authDownEvents,
  createRoomCancelHarness,
  terminalFor,
} from "./room-cancel-boundary.fixtures.js";
import type { RoomEvent } from "./room-engine.js";

// gemini is a ConPTY spawn with no RoomHostOptions seam, so its process boundary is replaced here.
// The factory is hoisted above every import, which is why it reads the script out of a slot the
// harness fills rather than importing the fixtures module (that would close an import cycle through
// room-host -> adapters/registry -> adapters/agy).
const { geminiSlot } = vi.hoisted(() => ({ geminiSlot: {} as GeminiSlot }));
vi.mock("../adapters/agy.js", () => ({
  dispatchAgy: {
    withLaneState: (input: { readonly input: { readonly signal: AbortSignal } }) => {
      const script = geminiSlot.script;
      if (script === undefined) throw new Error("gemini lane script was never installed");
      return script.agyDispatch(input);
    },
  },
}));
// The live `agy --version` probe is a real spawn on the carrier path; pinned so no test waits 5s for it.
vi.mock("../adapters/pty/agy-version.js", () => ({ probeAgyVersion: async () => "1.0.8" }));

const AGENTS: readonly AgentName[] = ["claude", "codex", "gemini"];
/**
 * WALL-CLOCK BUDGETS, SET FROM MEASUREMENT, NOT FROM TASTE. Each test here boots a real room — engine,
 * evidence DB, git-init'd project root, three lanes — inside one of four parallel vitest forks.
 *
 * FL-175 round 4 reviewer finding: the 14-runs/17.5s-under-load figure this file used to cite was stale
 * — a fresh measurement came back at 46,983 ms against the old 60_000 ms TEST_TIMEOUT_MS, only 1.28x,
 * the thinnest margin in the target suite. Re-measured with a temporarily generous ceiling (never
 * fired): three isolated single-process runs on this box today, worst individual test each run 26,850 /
 * 23,743 / 27,194 ms — none reaching the reviewer's number, which is real evidence of a heavier load
 * this session did not reach rather than a stale figure. Sized against the LARGER of the two: 2x
 * 46,983 ms is 93,966 ms; TEST_TIMEOUT_MS is set to 100_000 ms (2.13x). SETTLE_DEADLINE_MS keeps its
 * original ~75% ratio of TEST_TIMEOUT_MS.
 *
 * ORDER MATTERS between these two. SETTLE stays BELOW the per-test timeout on purpose: the harness's own
 * diagnostic (which prints the actual per-agent rows) has to fire before vitest's generic timeout, or the
 * next reader gets "test timed out" and no idea which lane never came back.
 */
const SETTLE_DEADLINE_MS = 75_000;
const TEST_TIMEOUT_MS = 100_000;
const saved = { memory: process.env.ZER0_MEMORY, resume: process.env.ZER0_NATIVE_RESUME };
let harness: RoomCancelHarness | undefined;

afterEach(async () => {
  const current = harness;
  harness = undefined;
  await current?.dispose();
  const { resetCarrierRuntime } = await import("../chat/lane-transport.js");
  const { resetLaneAvailabilityStore } = await import("../chat/lane-availability-store.js");
  resetCarrierRuntime();
  resetLaneAvailabilityStore();
  restore("ZER0_MEMORY", saved.memory);
  restore("ZER0_NATIVE_RESUME", saved.resume);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

/** A room with all three lanes genuinely parked mid-prompt, ready for the key. */
async function roomWithThreeLanesInFlight(): Promise<RoomCancelHarness> {
  process.env.ZER0_MEMORY = "1";
  process.env.ZER0_NATIVE_RESUME = "1";
  const room = await createRoomCancelHarness(geminiSlot);
  harness = room;
  await room.host.submit({ requestId: "submit-1", text: "@all what is the room's position?" });
  await room.inFlight();
  return room;
}

/** The exact call `zer0-v2-host.ts:562` makes when the cancel bridge's RPC arrives. */
async function pressCtrlC(room: RoomCancelHarness): Promise<void> {
  await room.host.control({ requestId: "ctrl-c", command: "cancel", scope: "all" });
}

async function waitForTerminals(room: RoomCancelHarness): Promise<void> {
  const deadline = Date.now() + SETTLE_DEADLINE_MS;
  while (AGENTS.some((agent) => terminalFor(room.events, agent) === undefined)) {
    if (Date.now() >= deadline) {
      throw new Error(`lanes never settled: ${JSON.stringify(rowsFor(room.events))}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The transcript, as the operator reads it: one word per agent. */
function rowsFor(events: readonly RoomEvent[]): Record<string, string> {
  const rows: Record<string, string> = {};
  for (const agent of AGENTS) {
    const terminal = terminalFor(events, agent);
    rows[agent] =
      terminal === undefined
        ? "no terminal row"
        : `${terminal.type.slice("lane.".length)}${detail(terminal)}`;
  }
  return rows;
}

function detail(event: RoomEvent): string {
  const error = event.payload.error;
  return typeof error === "string" && error.length > 0 ? `: ${error.slice(0, 80)}` : "";
}

/**
 * THE OPERATOR'S SIGHTING, at the seam they saw it. Ctrl+C produced `▲ gemini — cancelled` beside
 * `◀ claude — failed: carrier failed` and `● codex — failed: carrier failed`.
 *
 * WHAT WRONG IMPLEMENTATION WOULD STILL PASS THIS? Not "three terminal rows appeared" — the broken tree
 * produced three, with the wrong word in two of them. Not "no lane completed" — a cancel and a death
 * agree on that. The assertion is per-agent on the CLASSIFICATION, and it names claude and codex
 * explicitly because gemini was correct before any of this wave's fixes: its runner rejects on abort
 * (`agy-runner.ts:113-115`) and so lands in the one branch that already read the signal. A proof that
 * only checked "some lane says cancelled" would have passed on the night the defect shipped.
 */
it(
  "RED: a room-boundary cancel reads `cancelled` on all three lanes, including both ACP agents",
  async () => {
    const room = await roomWithThreeLanesInFlight();

    await pressCtrlC(room);
    await waitForTerminals(room);

    expect(rowsFor(room.events)).toEqual({
      claude: "cancelled",
      codex: "cancelled",
      gemini: "cancelled",
    });
  },
  TEST_TIMEOUT_MS,
);

/**
 * THE FOOTER LIE, at the same seam. The operator's chips read `claude auto offline`, `codex auto
 * offline`, `gemini auto offline` after a cancel they issued themselves.
 *
 * WHAT WRONG IMPLEMENTATION WOULD STILL PASS THIS? One that never marks any lane down — which is why
 * the anti-inversion control below asserts the opposite for a genuine transport death. The two together
 * pin the DISTINCTION rather than either extreme.
 */
it(
  "RED: a room-boundary cancel marks no agent chip down — no ` offline` in the footer",
  async () => {
    const room = await roomWithThreeLanesInFlight();

    await pressCtrlC(room);
    await waitForTerminals(room);

    expect(
      Object.fromEntries(AGENTS.map((agent) => [agent, authDownEvents(room.events, agent).length])),
    ).toEqual({ claude: 0, codex: 0, gemini: 0 });
  },
  TEST_TIMEOUT_MS,
);

/**
 * THE ANTI-INVERSION CONTROL, and it is not optional: both assertions above pass against a room that
 * calls EVERY terminal a cancel and never marks anything down. That inversion is the same defect
 * pointing backwards — an agent that really is unreachable would render as a clean stop and the
 * operator would keep typing into a dead lane.
 *
 * No cancel is issued here. The bridge simply dies under the in-flight prompt, which is the identical
 * rejection the cancel path produces — so the ONLY thing distinguishing this case from the two above is
 * the abort signal, which is exactly the discriminator the fix installed.
 */
it(
  "control: a genuine bridge death, with nobody cancelling, still reads `failed` and still marks the chip down",
  async () => {
    const room = await roomWithThreeLanesInFlight();

    room.claude.promptRelease.reject(new Error("bridge connection closed"));
    await waitFor(() => terminalFor(room.events, "claude") !== undefined);

    expect(terminalFor(room.events, "claude")?.type).toBe("lane.failed");
    expect(authDownEvents(room.events, "claude")).toHaveLength(1);
  },
  TEST_TIMEOUT_MS,
);

/**
 * FL-146 — THE RACE, AND THE MOST SERIOUS DEFECT ON THE BOARD. A cancel that lands while a connection
 * is still OPENING is a complete no-op: `dropHold` (`lane-hold.ts:134-138`) calls `replaceHold`, which
 * returns immediately when nothing is held (`:186-188`), and it never touches `state.opening` or bumps
 * `state.closedThrough` — the supersession counter only `closeHoldState` (`:208`, bumping at `:212`) moves. So the open
 * finishes, `installHold` accepts it, and THE CARRIER SENDS THE PROMPT TO AN AGENT THE OPERATOR ALREADY
 * STOPPED. Measured in the operator's own evidence DB: a prompt sent 3.4s AFTER the cancel.
 *
 * The race is made DETERMINISTIC rather than raced for: `parkOpen` holds `openConnection` inside the
 * window until the cancel has already been acknowledged, then releases it. This is the window in every
 * trial, not a version of it.
 *
 * WHAT WRONG IMPLEMENTATION WOULD STILL PASS THIS? Not one asserting the terminal row — a lane whose
 * prompt WAS delivered still ends `cancelled`, which is precisely why eleven trials of watching the
 * transcript never located this. The assertion is on `prompts`, the count of prompts that reached the
 * agent: the operator stopped it, so it must be ZERO.
 *
 * ⚠⚠ THIS TEST IS RED ON THIS BASE (dc2eba3), AND THAT IS THE POINT: FL-146 IS STILL OPEN HERE. It
 * reports `promptsSentAfterCancel: 1` — the prompt reaching a stopped agent, the operator's own defect,
 * reproduced deterministically instead of one time in three. MEASURED, not asserted: 5 consecutive runs
 * of this file on this base, all 5 red with the same value, while the other three stayed green.
 *
 * ⚠ MERGE ORDER, AND IT IS NOT OPTIONAL. The fix is already built, on branch `fl146-cancel-race`
 * @6df2b62 (`dropHoldState` / `supersedeOpens` in lane-hold.ts). This file was copied unchanged onto
 * that branch and run there: ALL FOUR GREEN, 3 trials of 3. So FL-133 merging BEFORE FL-146 leaves the
 * suite red for every lane behind it; merged after — or together — it is green and this test is FL-146's
 * acceptance evidence at the room seam. `lane-hold.ts` is deliberately NOT touched here: two lanes
 * editing one file is how a merge loses a fix. This file is that lane's acceptance test, not its patch.
 */
it(
  "RED: a cancel that lands while the connection is still OPENING must not let the prompt reach the agent",
  async () => {
    process.env.ZER0_MEMORY = "1";
    process.env.ZER0_NATIVE_RESUME = "1";
    const room = await createRoomCancelHarness(geminiSlot);
    harness = room;
    const parked = room.claude.parkOpen();
    await room.host.submit({ requestId: "submit-1", text: "@claude think about this one" });
    await room.claude.opening.promise;

    await pressCtrlC(room);
    parked.release();
    // Whichever happens first decides the verdict: the lane settles with the prompt never sent (correct),
    // or the prompt lands on the stopped agent (the defect). Waiting only for the terminal row would hang
    // here rather than assert, and a proof that reports a TIMEOUT tells the next reader nothing about why.
    await waitFor(
      () => room.claude.prompts > 0 || terminalFor(room.events, "claude") !== undefined,
    );

    expect(
      { promptsSentAfterCancel: room.claude.prompts, row: rowsFor(room.events).claude },
      "FL-146. A red here has exactly two readings and the next reader should not have to guess which: " +
        "either the FL-146 fix is NOT ON THIS TREE (it lives on branch fl146-cancel-race @6df2b62, where " +
        "this file is green 3 trials of 3 — merge that first), or it is on the tree and has regressed. " +
        "It is not a flake either way: promptsSentAfterCancel came back 1 on 5 of 5 trials of the " +
        "unfixed tree, and 0 on every trial of the fixed one.",
    ).toEqual({ promptsSentAfterCancel: 0, row: "cancelled" });
  },
  TEST_TIMEOUT_MS,
);

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + SETTLE_DEADLINE_MS;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("the room never settled the lane");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
