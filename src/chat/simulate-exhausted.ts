/**
 * @file src/chat/simulate-exhausted.ts
 * @purpose ZER0_SIMULATE_EXHAUSTED — a VIEWING AID. The operator cannot inspect the terminal any way
 *   except by running it, and the red `out of usage` state is by definition only reachable when a real
 *   account is really spent. This seam publishes the availability a real vendor limit would publish, at
 *   room boot, for the agents named in the env var, so the state can be LOOKED AT on demand.
 * @exports SIMULATE_EXHAUSTED_ENV, SIMULATE_EXHAUSTED_TURN_ID, SimulatedStatusRecord, simulatedExhaustedAgents, publishSimulatedExhausted, retireSimulatedExhausted, bootSimulatedExhausted
 * @depends ./events, ./lane-availability, ./lane-availability-store, ./lane-gate, ./types
 *
 * IT FAKES THE CHIP STATE, NOT THE TRANSPORT — and that distinction is the whole safety of it. The lane
 * is untouched: nothing is written to the durable availability store, the gate is not consulted, and a
 * prompt sent to a "simulated exhausted" agent still opens a real bridge and either answers or fails on
 * its own merits. This publishes ONE status event and has no other effect. It is therefore not a
 * simulation of exhaustion, it is a simulation of the PAINT, which is the only thing the operator asked
 * to see. Do not grow it into the other thing: a seam that also blocked sends would be a second, hidden
 * copy of lane-gate's rules, and the two would drift.
 *
 * THE TERMINAL MUST NOT BE ABLE TO TELL. The event goes through `emitAvailabilityStatus` — the same
 * function the real classification calls — so the payload is byte-identical to a genuine death and
 * needs no Rust change, no protocol change, and no flag on the wire.
 *
 * AND IT DOES NOT OUTLIVE THE VARIABLE. The status is journaled like any other, so unsetting the switch
 * cannot un-publish it; the first boot afterwards RETRACTS it instead, republishing the lane's real
 * availability. See {@link retireSimulatedExhausted} for why the room stream cannot carry an
 * unjournaled event at all.
 */
import type { ChatEventBus } from "./events.js";
import { getLaneAvailability, initLaneAvailabilityStore } from "./lane-availability-store.js";
import { type LaneAvailability, reasonForClass } from "./lane-availability.js";
import { emitAvailabilityStatus } from "./lane-gate.js";
import type { AgentName } from "./types.js";

export const SIMULATE_EXHAUSTED_ENV = "ZER0_SIMULATE_EXHAUSTED";

/** The room's roster. Kept local, as `lane-gate.ts`'s ALL_LANES and `headless-prompt.ts`'s ALL_AGENTS
 *  are — there is no shared runtime constant in this tree, and inventing one is not this change. */
const KNOWN_AGENTS: readonly AgentName[] = ["claude", "codex", "gemini"];

/**
 * The agents named in the env var, in roster order, deduplicated — or NOTHING, which is the default and
 * the case that matters most.
 *
 * UNSET MEANS ZERO BEHAVIOUR CHANGE, and it is read fresh on every call rather than latched at import so
 * a test can toggle it (the same rule `hermeticEnabled` follows). An unrecognised name is IGNORED, never
 * thrown: this is a debugging switch typed by hand at a shell prompt, and taking the whole room down
 * because someone wrote `codx` would make a viewing aid into an outage.
 */
export function simulatedExhaustedAgents(): readonly AgentName[] {
  const raw = process.env[SIMULATE_EXHAUSTED_ENV];
  if (raw === undefined || raw.trim().length === 0) return [];
  const named = new Set(raw.split(",").map((part) => part.trim().toLowerCase()));
  return KNOWN_AGENTS.filter((agent) => named.has(agent));
}

/**
 * Publishes the simulated availability for every named agent and returns which ones it published, so a
 * caller can log or assert on it. A no-op when the var is unset.
 *
 * THE RECORD IS THE REAL SHAPE, field for field: `exhausted`, the zer0-worded reason (never a raw vendor
 * remediation), and NO reset instant — under the operator's 2026-08-24 ruling the painted state is the
 * bare word, and a simulated reset would be the one thing here that could differ visibly from a real
 * death. `updatedMs` is now, exactly as a real classification stamps it.
 */
export function publishSimulatedExhausted(bus: ChatEventBus, nowMs: number): readonly AgentName[] {
  const agents = simulatedExhaustedAgents();
  for (const agent of agents) {
    const availability: LaneAvailability = {
      state: "exhausted",
      cause: "exhausted",
      reason: reasonForClass("exhausted"),
      updatedMs: nowMs,
    };
    emitAvailabilityStatus(bus, agent, availability);
  }
  return agents;
}

/**
 * The turn id every simulated status is published under, and the ONLY thing that distinguishes a fake
 * from a real death once it is in the journal. `turnId` is a free-form string on the wire (the schema
 * requires only a non-empty one) and this room already publishes under `room-boot`, `room-mode`,
 * `room-cancel` and `room`, so this rides an established convention rather than adding a field the
 * terminal would have to learn. The Rust reducer's `agent.status` transition never reads it.
 */
export const SIMULATE_EXHAUSTED_TURN_ID = "room-simulate";

/** One recovered journal row, as narrow as the scan below needs it. Deliberately structural rather than
 *  `RoomEvent`: `src/chat` must not import `src/room`, and every RoomEvent already satisfies this. */
export interface SimulatedStatusRecord {
  readonly turnId: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * THE RETRACTION, and why it is a retraction rather than a transient publish.
 *
 * The fake is a real journaled event, so unsetting the variable used to leave it painted forever: the
 * journal replays on every load, and a later successful dispatch emits only `auth:"ready"`, which the
 * reducer merges without touching availability. The operator then could not tell a leftover fake from a
 * real vendor limit — the one confusion a viewing aid must never cause.
 *
 * IT CANNOT BE FIXED BY NOT JOURNALING IT. The room stream is strictly sequential by contract:
 * `RoomReducer::apply` demands each event's sequence be exactly the previous plus one
 * (`rust/crates/zer0-room-protocol/src/reducer.rs:234-238`), sequence zero is reserved for the readiness
 * frame and anything else carrying it is fatal (`rust/crates/zer0-v2-bin/src/transport.rs:123-124`), and
 * a resync that does not close a hole is fatal too (`transport.rs:249-251`). An event delivered to the
 * client but withheld from `room-events.jsonl` therefore burns a sequence number the file never gets,
 * and the next load of that session kills the terminal on the gap. So the seam corrects itself forward
 * instead: the first boot after an unset republishes the lane's REAL availability over the fake.
 *
 * SCOPED TO THE LAST WORD ON THE LANE. Only an agent whose most recent availability status came from
 * this seam is retired. A real classification recorded after the fake owns the state and is left alone —
 * republishing `ready` over a genuinely spent account is the same defect in the other direction.
 */
export function retireSimulatedExhausted(input: {
  readonly bus: ChatEventBus;
  readonly journal: readonly SimulatedStatusRecord[];
  readonly repoRoot: string;
}): readonly AgentName[] {
  const stillSimulated = new Set(simulatedExhaustedAgents());
  const stale = KNOWN_AGENTS.filter(
    (agent) =>
      !stillSimulated.has(agent) &&
      lastAvailabilityTurnId(input.journal, agent) === SIMULATE_EXHAUSTED_TURN_ID,
  );
  if (stale.length === 0) return [];
  // The DURABLE truth for this lane, not a hardcoded `ready`: the simulation never touched the store, so
  // this is whatever the lane really is — normally ready, and a genuine death if one was recorded.
  // Idempotent, exactly as lane-gate.ts calls it on every turn.
  initLaneAvailabilityStore(input.repoRoot);
  for (const agent of stale) emitAvailabilityStatus(input.bus, agent, getLaneAvailability(agent));
  return stale;
}

/**
 * BOTH HALVES, IN THE ORDER THEY HAVE TO RUN — the whole of what the room's boot does with this seam.
 *
 * The retraction goes FIRST and on the ORDINARY boot turn: it reads the journal this boot recovered
 * and republishes the real availability of any lane a previous run simulated and this one does not, so
 * the fake cannot outlive the variable. The publish goes second and on {@link SIMULATE_EXHAUSTED_TURN_ID},
 * which is the only mark that tells the NEXT boot which statuses were fakes. Publishing first would let
 * this run's fake be read as the stale one and retired on the spot.
 *
 * Lives here rather than in the room host for the reason the ratchet insists on: the host is a few
 * lines from its hard size ceiling, and growth is answered by moving the knowledge to the module that
 * owns it. The host now supplies only what it alone has — its bus factory, its journal, its root.
 */
export function bootSimulatedExhausted(
  createBus: (turnId: string) => ChatEventBus,
  journal: readonly SimulatedStatusRecord[],
  repoRoot: string,
): void {
  retireSimulatedExhausted({ bus: createBus("room-boot"), journal, repoRoot });
  publishSimulatedExhausted(createBus(SIMULATE_EXHAUSTED_TURN_ID), Date.now());
}

/** The turn id of the LAST `agent.status` in `journal` that carried an availability for `agent`, or
 *  undefined when the agent never had one. Statuses carrying only auth or usage are skipped: the reducer
 *  inherits availability across those, so they are not the last word on it. */
function lastAvailabilityTurnId(
  journal: readonly SimulatedStatusRecord[],
  agent: AgentName,
): string | undefined {
  let turnId: string | undefined;
  for (const record of journal) {
    if (record.type !== "agent.status" || record.payload.agent !== agent) continue;
    if (record.payload.availability === undefined) continue;
    turnId = record.turnId;
  }
  return turnId;
}
