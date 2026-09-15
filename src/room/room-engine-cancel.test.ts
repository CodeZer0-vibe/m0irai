/**
 * @file src/room/room-engine-cancel.test.ts
 * @purpose FL-146 — a cancel hook that FAILS must reach the operator instead of vanishing into an
 *   unhandled rejection. THE OPERATOR-VISIBLE FAILURE THIS CATCHES: they press Esc, the lane shows
 *   `cancelling`, the hook that would actually stop the ACP bridge throws, and the room says nothing at
 *   all — the agent answers a moment later and the only trace of why is a rejection nobody handled.
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./room-engine
 *
 * The real RoomEngine, its real journal and its real cancel path. `runLane` and `onCancel` are the two
 * injected seams the scheduler is built around.
 */
import { expect, it } from "vitest";
import { RoomEngine } from "./room-engine.js";

async function submitOne(engine: RoomEngine, turnId: string): Promise<void> {
  engine.reserveTurn(turnId, 1);
  await engine.submit({
    turnId,
    agents: ["claude"],
    text: "the turn the operator is about to stop",
    messageId: `operator-${turnId}`,
    ledgerSeq: "1",
  });
}

/** A lane that runs until its own signal aborts — the shape every real cancel has to interrupt. */
function abortableEngine(onCancel: (agent: "claude" | "codex" | "gemini") => Promise<void> | void) {
  return new RoomEngine({
    onCancel,
    runLane: async (lane) => {
      await new Promise<void>((resolve) =>
        lane.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { text: "", status: "cancelled" };
    },
  });
}

it("surfaces a cancel hook that REJECTS as a backend failure the operator can see", async () => {
  const engine = abortableEngine(async () => {
    throw new Error("the bridge refused to let go");
  });
  await submitOne(engine, "turn-reject");

  await engine.cancel({ scope: "all" });
  await engine.whenIdle();

  const failure = engine.events().find((event) => event.type === "backend.failed");
  expect(failure, "a cancel that threw left no trace at all").toBeDefined();
  expect(String(failure?.payload.message)).toBe(
    "room cancel of claude failed: the bridge refused to let go",
  );
});

it("surfaces a cancel hook that throws SYNCHRONOUSLY through the same path", async () => {
  // A sync throw and a rejection are the same failure to the operator; they must not need the hook
  // author to have remembered which one they wrote.
  const engine = abortableEngine(() => {
    throw new Error("threw before it ever awaited");
  });
  await submitOne(engine, "turn-sync-throw");

  await engine.cancel({ scope: "all" });
  await engine.whenIdle();

  expect(
    String(engine.events().find((event) => event.type === "backend.failed")?.payload.message),
  ).toBe("room cancel of claude failed: threw before it ever awaited");
});

it("says nothing when the cancel hook succeeds, and still cancels the lane", async () => {
  const cancelled: string[] = [];
  const engine = abortableEngine((agent) => {
    cancelled.push(agent);
  });
  await submitOne(engine, "turn-clean");

  await engine.cancel({ scope: "all" });
  await engine.whenIdle();

  expect(cancelled).toEqual(["claude"]);
  expect(
    engine.events().filter((event) => event.type === "backend.failed"),
    "a working cancel must stay quiet — a report on every stop is noise, not a signal",
  ).toEqual([]);
  expect(engine.events().some((event) => event.type === "lane.cancelling")).toBe(true);
});
