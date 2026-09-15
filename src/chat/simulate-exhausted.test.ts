/**
 * @file src/chat/simulate-exhausted.test.ts
 * @purpose ZER0_SIMULATE_EXHAUSTED, the operator's viewing aid for the red `out of usage` state. Two
 *   things have to be true and they pull in opposite directions: with the var set the terminal must
 *   receive a status INDISTINGUISHABLE from a real vendor limit, and with it unset the room must behave
 *   exactly as it does today — no event, no field, nothing. The second is the one worth guarding: a
 *   debugging seam that leaks into an ordinary run is worse than no seam.
 * @exports (none — test file)
 * @depends node:fs, node:path, node:url, vitest, ./events, ./simulate-exhausted, ../room/room-host-support
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createRoomBus } from "../room/room-host-support.js";
import { RoomUsageFold } from "../room/room-usage-fold.js";
import { ChatEventBus } from "./events.js";
import { resetLaneAvailabilityStore } from "./lane-availability-store.js";
import {
  SIMULATE_EXHAUSTED_ENV,
  SIMULATE_EXHAUSTED_TURN_ID,
  type SimulatedStatusRecord,
  bootSimulatedExhausted,
  publishSimulatedExhausted,
  retireSimulatedExhausted,
  simulatedExhaustedAgents,
} from "./simulate-exhausted.js";

afterEach(() => {
  delete process.env[SIMULATE_EXHAUSTED_ENV];
  resetLaneAvailabilityStore();
});

/** Every `agent.status` payload the ROOM would emit — the exact objects the terminal reducer sees, not
 *  the bus event one layer earlier. Built through the production `createRoomBus`, so the assertions
 *  below are about what reaches the wire rather than about what this module handed to a bus. */
function roomStatuses(turnId = "room-boot"): {
  readonly bus: ChatEventBus;
  readonly published: Record<string, unknown>[];
  /** The journal rows those statuses become, in the shape the recovery scan reads them back in. */
  readonly journal: SimulatedStatusRecord[];
} {
  const published: Record<string, unknown>[] = [];
  const journal: SimulatedStatusRecord[] = [];
  const bus = createRoomBus({
    turnId,
    usageFold: new RoomUsageFold(),
    isShuttingDown: () => false,
    notify: (eventTurnId, type, payload) => {
      if (type !== "agent.status") return;
      published.push({ ...payload });
      journal.push({ turnId: eventTurnId, type, payload });
    },
    notice: () => undefined,
    onMode: () => undefined,
  });
  return { bus, published, journal };
}

/** The effective availability of `agent` after a stream of room `agent.status` payloads — the fold the
 *  Rust reducer performs (a status with no `availability` inherits the prior one, reducer.rs:668). This
 *  is what the operator's row is painted from, so it is what a "the fake is gone" claim must be about. */
function effectiveAvailability(
  published: readonly Record<string, unknown>[],
  agent: string,
): Record<string, unknown> | undefined {
  let current: Record<string, unknown> | undefined;
  for (const payload of published) {
    if (payload.agent !== agent || payload.availability === undefined) continue;
    current = payload.availability as Record<string, unknown>;
  }
  return current;
}

it("DEFAULT OFF: with the var unset, nothing is named and nothing is published", () => {
  // THE ASSERTION THAT MATTERS MOST. Every real run has this variable unset, so this is the behaviour
  // of the shipped product; the simulated path is the exception.
  const { bus, published } = roomStatuses();

  expect(simulatedExhaustedAgents()).toEqual([]);
  expect(publishSimulatedExhausted(bus, 1_000)).toEqual([]);
  expect(published, "an unset debugging switch put an event on the wire").toEqual([]);
});

it("DEFAULT OFF: an empty or whitespace-only value is the same as unset", () => {
  for (const raw of ["", "   ", ",", " , , "]) {
    process.env[SIMULATE_EXHAUSTED_ENV] = raw;
    const { bus, published } = roomStatuses();
    expect(publishSimulatedExhausted(bus, 1_000), `value ${JSON.stringify(raw)}`).toEqual([]);
    expect(published).toEqual([]);
  }
});

it("the published status is what the terminal would receive from a REAL vendor limit", () => {
  // The operator's whole request: SEE the state. `state: exhausted` is what `footer_health` turns into
  // `FooterHealth::OutOfUsage` and paints red with `out of usage` under it.
  process.env[SIMULATE_EXHAUSTED_ENV] = "codex";
  const { bus, published } = roomStatuses();

  expect(publishSimulatedExhausted(bus, 1_000)).toEqual(["codex"]);
  expect(published, "the simulated state never reached the room wire").toHaveLength(1);
  expect(published[0]).toEqual({
    agent: "codex",
    availability: { state: "exhausted" },
  });
  // NO RESET INSTANT, and this is the operator's 2026-08-24 ruling rather than an omission: the painted
  // state is the bare word. A simulated reset would also be the one field that could make the fake
  // differ visibly from the real thing — and, worse, it would EXPIRE, so the state under inspection
  // would vanish while the operator was looking at it.
  expect(published[0]).not.toHaveProperty("availability.resetsAtMs");
});

it("garbage names are ignored, never thrown, and never widen the roster", () => {
  // A switch typed by hand at a shell prompt. Taking the room down over a typo would turn a viewing aid
  // into an outage, so an unknown name is simply not an agent.
  process.env[SIMULATE_EXHAUSTED_ENV] = "codx, CODEX ,,gemini,rm -rf /,claude-3,gemini";

  // Recognised names only, in roster order, deduplicated — case and whitespace tolerated because the
  // operator is typing this, not a program.
  expect(simulatedExhaustedAgents()).toEqual(["codex", "gemini"]);

  const { bus, published } = roomStatuses();
  expect(publishSimulatedExhausted(bus, 1_000)).toEqual(["codex", "gemini"]);
  expect(published.map((event) => event.agent)).toEqual(["codex", "gemini"]);
});

it("every agent can be simulated, including all three at once", () => {
  process.env[SIMULATE_EXHAUSTED_ENV] = "claude,codex,gemini";
  const { bus, published } = roomStatuses();

  publishSimulatedExhausted(bus, 1_000);
  expect(published.map((event) => event.agent)).toEqual(["claude", "codex", "gemini"]);
  for (const event of published) {
    expect(event.availability).toEqual({ state: "exhausted" });
  }
});

it("the reason reaching the bus is the zer0 wording, never a raw vendor remediation", () => {
  // The room payload deliberately carries only `state` (the wire schema is
  // `additionalProperties: false` over state + resetsAtMs), so the reason is asserted one layer back,
  // on the bus event — which is where `/status` and the chat surfaces read it.
  process.env[SIMULATE_EXHAUSTED_ENV] = "codex";
  const bus = new ChatEventBus();
  const events: unknown[] = [];
  bus.on("agent.status", (event) => events.push(event));

  publishSimulatedExhausted(bus, 4_242);

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    kind: "agent.status",
    agent: "codex",
    availability: { state: "exhausted", reason: "this lane is out of usage for now" },
  });
});

/**
 * DELTA ITEM 1 — THE FAKE MUST NOT OUTLIVE THE VARIABLE.
 *
 * The review's reproduction: publish with `ZER0_SIMULATE_EXHAUSTED=codex`, delete the variable, reload.
 * The status is an ordinary journaled `agent.status`, recovery replays the journal, and a later real
 * dispatch emits only `auth:"ready"` — which the reducer merges WITHOUT touching availability. So the
 * red word stayed on a lane nothing was simulating any more, and the operator had no way to tell a
 * leftover fake from a real vendor limit.
 *
 * THE ROOM EVENT STREAM CANNOT CARRY AN UNJOURNALED EVENT, which is why this is a retraction rather
 * than a transient publish. `RoomReducer::apply` requires each event's sequence to be exactly the
 * previous one plus one (`rust/crates/zer0-room-protocol/src/reducer.rs:234-238`), sequence zero is
 * reserved for the readiness frame (`rust/crates/zer0-v2-bin/src/transport.rs:123-124`), and a resync
 * that fails to close a hole is fatal (`transport.rs:249-251`). An event delivered to the client but
 * kept out of `room-events.jsonl` therefore leaves a permanent gap in that file, and the next load of
 * that session kills the terminal. The seam retracts instead: the boot after an unset republishes the
 * lane's REAL availability, so the reduced state — the thing the row is painted from — has no fake in it.
 */
it("DELTA 1: the boot after the variable is unset retires the fake it published", () => {
  process.env[SIMULATE_EXHAUSTED_ENV] = "codex";
  const first = roomStatuses(SIMULATE_EXHAUSTED_TURN_ID);
  expect(publishSimulatedExhausted(first.bus, 1_000)).toEqual(["codex"]);
  expect(effectiveAvailability(first.published, "codex")).toEqual({ state: "exhausted" });

  // The operator stops simulating and restarts. Recovery replays the journal the run above wrote, so
  // the second run's stream starts with that same exhausted status.
  delete process.env[SIMULATE_EXHAUSTED_ENV];
  const second = roomStatuses();
  const replayed = [...first.published];
  retireSimulatedExhausted({
    bus: second.bus,
    journal: first.journal,
    repoRoot: path.join(process.cwd(), "does-not-exist-so-the-store-is-empty"),
  });
  expect(publishSimulatedExhausted(second.bus, 2_000)).toEqual([]);

  expect(
    effectiveAvailability([...replayed, ...second.published], "codex"),
    "the simulated exhaustion survived the variable being unset - the operator cannot tell it from a real vendor limit",
  ).toEqual({ state: "ready" });
});

it("DELTA 1: a REAL death recorded after the fake is never retired", () => {
  // The retraction is scoped to the LAST availability an agent carries. A real classification that
  // landed after the simulated one owns the state, and republishing `ready` over it would unpaint a
  // lane that genuinely cannot work — the exact failure the reset-instant rule exists to prevent.
  process.env[SIMULATE_EXHAUSTED_ENV] = "codex";
  const first = roomStatuses(SIMULATE_EXHAUSTED_TURN_ID);
  publishSimulatedExhausted(first.bus, 1_000);
  first.journal.push({
    turnId: "turn-1",
    type: "agent.status",
    payload: { agent: "codex", availability: { state: "exhausted" } },
  });

  delete process.env[SIMULATE_EXHAUSTED_ENV];
  const second = roomStatuses();
  expect(
    retireSimulatedExhausted({
      bus: second.bus,
      journal: first.journal,
      repoRoot: path.join(process.cwd(), "does-not-exist-so-the-store-is-empty"),
    }),
    "a real vendor limit was retired because a simulation had painted the same lane earlier",
  ).toEqual([]);
  expect(second.published).toEqual([]);
});

it("DELTA 1: an agent still named by the variable is republished, never retired", () => {
  process.env[SIMULATE_EXHAUSTED_ENV] = "codex";
  const first = roomStatuses(SIMULATE_EXHAUSTED_TURN_ID);
  publishSimulatedExhausted(first.bus, 1_000);

  const second = roomStatuses();
  expect(
    retireSimulatedExhausted({
      bus: second.bus,
      journal: first.journal,
      repoRoot: path.join(process.cwd(), "does-not-exist-so-the-store-is-empty"),
    }),
    "the seam retired a lane the operator is still asking it to simulate",
  ).toEqual([]);
});

it("DELTA 1: a journal with no simulated status publishes nothing at all", () => {
  // UNSET MEANS ZERO BEHAVIOUR CHANGE still holds, and this is where it could have been lost: the
  // retraction runs on EVERY boot, so a room that never simulated anything must come out of it silent.
  const { bus, published } = roomStatuses();
  expect(
    retireSimulatedExhausted({
      bus,
      journal: [
        {
          turnId: "turn-1",
          type: "agent.status",
          payload: { agent: "codex", availability: { state: "exhausted" } },
        },
        { turnId: "room-boot", type: "agent.status", payload: { agent: "claude", auth: "ready" } },
      ],
      repoRoot: path.join(process.cwd(), "does-not-exist-so-the-store-is-empty"),
    }),
  ).toEqual([]);
  expect(published, "an ordinary boot put a retraction on the wire").toEqual([]);
});

it("the seam is WIRED: the host's boot path actually calls it", () => {
  // THE GUARD THAT IS PERFECT AND DEAD. This module can be flawless and never run, and no test above
  // would notice — every one of them calls it directly. The room publishes this at boot from
  // `activateRecovered`, on the same `room-boot` bus the eager sessions use, so the state is on screen
  // before the operator types anything.
  //
  // Read out of the source rather than by booting a host: the alternative is the spawned-process
  // fixture in src/room, which is where this lane measured real flakiness (5-second deadlines around a
  // real spawn). A structural pin cannot prove the call RUNS, only that it is written — which is
  // exactly the failure mode being guarded, and it costs no wall clock.
  const hostSource = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "room", "room-host.ts"),
    "utf8",
  );

  expect(
    hostSource,
    "room-host.ts stopped importing the simulation seam - the switch would be silently inert",
  ).toContain("simulate-exhausted.js");
  // Both halves come through ONE entry point, so one pin covers them: the host is a few lines from
  // its hard size ceiling and the ordering rule (retire, then publish) lives in the seam rather than
  // at the call site. An unwired retraction would be worse than none — the fake would look retired in
  // this file's tests and stay painted in the running room.
  expect(
    hostSource,
    "nothing in the host calls bootSimulatedExhausted - the operator sets the var and sees nothing, and a fake published once would never be retired",
  ).toMatch(/bootSimulatedExhausted\(/);
});

it("DELTA 1: the boot seam retires BEFORE it publishes", () => {
  // The ordering is load-bearing and invisible at the call site. Publishing first would mark this
  // run's fake with the simulate turn id and then immediately read it as the STALE one, retiring the
  // state the operator just asked to look at.
  process.env[SIMULATE_EXHAUSTED_ENV] = "codex";
  const calls: string[] = [];
  const journal: SimulatedStatusRecord[] = [
    {
      turnId: SIMULATE_EXHAUSTED_TURN_ID,
      type: "agent.status",
      payload: { agent: "gemini", availability: { state: "exhausted" } },
    },
  ];
  bootSimulatedExhausted(
    (turnId) => {
      calls.push(turnId);
      return new ChatEventBus();
    },
    journal,
    path.join(process.cwd(), "does-not-exist-so-the-store-is-empty"),
  );

  expect(
    calls,
    "the boot seam published before it retired, or stopped doing one of the two",
  ).toEqual(["room-boot", SIMULATE_EXHAUSTED_TURN_ID]);
});
