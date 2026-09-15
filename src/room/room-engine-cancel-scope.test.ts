import { expect, it } from "vitest";
import type { AgentName } from "../chat/types.js";
import { RoomEngine } from "./room-engine.js";

/**
 * The Node half of slice B's finding-7 proof.
 *
 * The pager can prove it EMITS `scope: "all"` when a key is pressed; it cannot
 * prove what that scope does to a lane the host owns. This file proves the other
 * half, on the same two-turn room: `latest` resolves exactly one turn
 * (`latestNonterminalTurn` returns the last key of `pendingByTurn`), so the
 * older turn's lane survives it. That is why the key sends `all` and the typed
 * `/cancel latest` does not.
 *
 * Neither half is sufficient alone, and saying so is the point: this file passes
 * today, with no key ever pressed, so it is not slice B's falsifier — it is the
 * control that gives the pager's scope assertion a meaning.
 *
 * Its own home rather than an append to `room-engine.test.ts`, which stands at
 * 596 lines against a 600-line hard ceiling with no escape hatch. The limit does
 * not move to accommodate growth.
 */

const AGENTS = ["claude", "codex", "gemini"] as const;

/** A room with three lanes in flight across TWO turns, each blocked until released. */
function twoTurnsInFlight(
  options: {
    readonly onCancel?: (agent: AgentName) => void | Promise<void>;
  } = {},
) {
  const releases = new Map<AgentName, () => void>();
  const started = new Map<AgentName, Promise<void>>();
  const blocked = new Map<AgentName, Promise<void>>();
  const announced = new Map<AgentName, () => void>();
  for (const agent of AGENTS) {
    blocked.set(agent, new Promise<void>((resolve) => releases.set(agent, resolve)));
    started.set(agent, new Promise<void>((resolve) => announced.set(agent, resolve)));
  }
  const engine = new RoomEngine({
    runLane: async (lane) => {
      announced.get(lane.agent)?.();
      await blocked.get(lane.agent);
      return { text: "", status: "cancelled" as const };
    },
    ...(options.onCancel === undefined ? {} : { onCancel: options.onCancel }),
  });
  const ready = async () => {
    engine.reserveTurn("turn-1", 1);
    await engine.submit({
      turnId: "turn-1",
      agents: ["claude"],
      text: "the older question",
      messageId: "operator-turn-1",
      ledgerSeq: "1",
    });
    engine.reserveTurn("turn-2", 2);
    await engine.submit({
      turnId: "turn-2",
      agents: ["codex", "gemini"],
      text: "asked again while the first was slow",
      messageId: "operator-turn-2",
      ledgerSeq: "2",
    });
    await Promise.all([...started.values()]);
  };
  const releaseAll = () => {
    for (const release of releases.values()) release();
  };
  return { engine, ready, releaseAll };
}

/** Which turns had a lane told to cancel. */
function cancellingTurns(engine: RoomEngine): readonly string[] {
  return [
    ...new Set(
      engine
        .events()
        .filter((event) => event.type === "lane.cancelling")
        .map((event) => event.turnId),
    ),
  ].sort();
}

it("falsifier: scope `latest` abandons the older turn's lane, which is why a key sends `all`", async () => {
  const room = twoTurnsInFlight();
  await room.ready();

  await room.engine.cancel({ scope: "latest" });

  expect(cancellingTurns(room.engine)).toEqual(["turn-2"]);
  expect(cancellingTurns(room.engine)).not.toContain("turn-1");
  room.releaseAll();
});

it("falsifier: scope `all` reaches every non-terminal turn, so `agents stopped` is true", async () => {
  const room = twoTurnsInFlight();
  await room.ready();

  await room.engine.cancel({ scope: "all" });

  // Both turns, and every one of the three lanes. Asserted on the lane ids as
  // well as the turns: a version that cancelled one lane per turn would satisfy
  // the turn set and still leave two agents running.
  expect(cancellingTurns(room.engine)).toEqual(["turn-1", "turn-2"]);
  expect(
    room.engine
      .events()
      .filter((event) => event.type === "lane.cancelling")
      .map((event) => event.payload.agent)
      .sort(),
  ).toEqual(["claude", "codex", "gemini"]);
  room.releaseAll();
});

it("falsifier: one slow agent cannot hold up the other two — no leader, no queue, no barrier", async () => {
  // THE THREE-AGENTS LAW, asserted directly rather than inferred from three
  // eventual `cancelled` rows. `cancel` runs `for (const target of AGENTS)
  // this.cancelTarget(...)` and does NOT await `onCancel`, so a claude adapter
  // that hangs forever must not stop codex and gemini from being told to stop.
  //
  // What wrong implementation would still pass a weaker version of this? One
  // that awaited each `onCancel` in turn would deadlock here rather than
  // returning — which is precisely why the assertion is that `cancel` RESOLVES,
  // not merely that three callbacks eventually fired.
  const told: AgentName[] = [];
  const room = twoTurnsInFlight({
    onCancel: (agent) => {
      told.push(agent);
      // claude never finishes shutting down.
      return agent === "claude" ? new Promise<void>(() => {}) : undefined;
    },
  });
  await room.ready();

  await room.engine.cancel({ scope: "all" });

  expect([...told].sort()).toEqual(["claude", "codex", "gemini"]);
  room.releaseAll();
});
