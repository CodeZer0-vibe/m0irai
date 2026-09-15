/**
 * @file src/room/room-readiness-service.ts
 * @purpose The room's ONE owner of the boot readiness record — probe, hold, serve, and one sync read.
 * @exports RoomReadinessService, ReadinessSnapshotPayload, SubmissionTargets
 * @depends ../chat/agent-readiness, ../chat/agent-readiness-probe, ../chat/types
 *
 * ONE OWNER, ONE CACHE, ONE FILTER SITE. Nothing else caches readiness. A second copy is how the chip
 * and the router start disagreeing about the same agent — the chip saying "sign in" while `@all` still
 * dispatches, or worse, the reverse.
 *
 * THE WRITE IS A SINGLE ATOMIC REPLACEMENT. The service assigns one new frozen record; it never mutates
 * a field of a shared one. So a reader sees the whole old record or the whole new one, never a
 * half-updated one. ⚠ Node is single-threaded and this is NOT a lock — it is the absence of a
 * partially-written object, which is the only hazard that exists here.
 *
 * THE RACE, resolved by construction rather than by timing. The record is seeded with every agent
 * `unknown` before any probe starts; `unknown` is not `unusable`, so the routing filter removes
 * nothing; therefore a submit that beats the probe dispatches exactly the three agents it dispatches
 * today. There is no window in which the room refuses an agent it has not measured. That is asserted,
 * not argued — a race written in prose and never run is not established.
 */
import { probeRoomReadiness } from "../chat/agent-readiness-probe.js";
import type { ReadinessProbeDeps } from "../chat/agent-readiness-probe.js";
import type { AgentReadiness, RoomReadiness } from "../chat/agent-readiness.js";
import { UNKNOWN_READINESS, isUnusable } from "../chat/agent-readiness.js";
import type { AgentName } from "../chat/types.js";

/** The `zer0/room/agents` response body. Version-pinned because the Rust decoder pins it too, and a
 *  shape that changes without its version is the one a strict decoder rejects silently. */
export interface ReadinessSnapshotPayload {
  readonly version: 1;
  readonly agents: Readonly<Record<AgentName, AgentReadiness>>;
}

const ROOM_AGENTS: readonly AgentName[] = ["claude", "codex", "gemini"];

/** Either the agents this submission may open lanes for, or the plain-words reason it opens none. A
 *  refusal is a RESULT, not a thrown error: the operator asked for something reasonable and the room
 *  has an answer for them, and an exception at this seam reaches Rust as "host rejected the room
 *  command" with the detail sanitized away. */
export type SubmissionTargets =
  | { readonly kind: "dispatch"; readonly agents: readonly AgentName[] }
  | { readonly kind: "refused"; readonly reason: string };

export class RoomReadinessService {
  /** Replaced whole, never mutated. See the file header. */
  private record: RoomReadiness = UNKNOWN_READINESS;
  private probing: Promise<void> | undefined;

  /**
   * Starts the probes in the BACKGROUND and returns immediately. Nothing on the boot path may await
   * this: the room paints its first frame without waiting for any subprocess, and the record it starts
   * from is the one every agent is `unknown` in.
   *
   * Idempotent by the returned promise, not by a flag — two callers get the same run, and a caller that
   * arrives after it settled gets a settled promise rather than a second spawn.
   */
  public start(deps: ReadinessProbeDeps): Promise<void> {
    this.probing ??= probeRoomReadiness(deps)
      .then((probed) => {
        this.record = probed;
      })
      .catch(() => {
        // Fail-soft to the letter: a probe run that could not finish leaves every agent `unknown`,
        // which renders exactly as ready. A broken instrument is not evidence about an agent.
      });
    return this.probing;
  }

  /** The ONE synchronous read. `AliveRoomHost.submit` calls this and never awaits a probe. */
  public current(): RoomReadiness {
    return this.record;
  }

  /** The `zer0/room/agents` handler body. */
  public snapshot(): ReadinessSnapshotPayload {
    return { version: 1, agents: { ...this.record } };
  }

  /**
   * Narrows a routing target set to the agents that may be dispatched.
   *
   * ⚠ RULED (wave spec §14 Q8): `unusable` is removed; `unknown` and `needs_login` STAY. `unknown`
   * because we do not act on a probe we did not get. `needs_login` because that failure is real,
   * immediate, and carries its remedy in the row — the operator learns something, where a silent
   * removal teaches them nothing and a lane that cannot work costs one turn.
   *
   * ORDER IS PRESERVED. The room's `@all` has a stable order and a filter that reordered it would
   * reorder the transcript.
   */
  public dispatchable(targets: readonly AgentName[]): readonly AgentName[] {
    const record = this.record;
    return targets.filter((agent) => !isUnusable(record[agent]));
  }

  /** The remedy an explicit address to an unusable agent gets INSTEAD of a lane, or undefined when the
   *  agent can be dispatched. The operator asked for that agent by name; refusing it silently would be
   *  worse than the failure. */
  public refusalFor(agent: AgentName): string | undefined {
    const readiness = this.record[agent];
    return readiness.state === "unusable"
      ? `${agent} is unavailable — ${readiness.reason}. ${readiness.remedy}`
      : undefined;
  }

  /** Every agent the room currently believes cannot work, in roster order. Feeds the no-agents-left
   *  refusal, which has to name all of them rather than the first one it found. */
  public unusableAgents(): readonly AgentName[] {
    return ROOM_AGENTS.filter((agent) => isUnusable(this.record[agent]));
  }

  /**
   * The routing decision for one submission, and the ONE place `@all` narrows.
   *
   * An UNADDRESSED or `@all` message drops the agents that cannot work. Without this, an operator with
   * no Antigravity CLI collects a gemini failure row on every single turn — a worse first-run
   * experience than the missing agent itself.
   *
   * An EXPLICIT `@gemini` to an unusable agent is still honoured, and answered with the remedy rather
   * than a lane. They asked for that agent by name; removing it silently would be the room quietly
   * deciding it knew better.
   */
  public resolveTargets(
    kind: "all" | "agent" | string,
    requested: readonly AgentName[],
  ): SubmissionTargets {
    if (kind !== "all") {
      const refusal = requested.map((agent) => this.refusalFor(agent)).find(isPresent);
      return refusal === undefined
        ? { kind: "dispatch", agents: requested }
        : { kind: "refused", reason: refusal };
    }
    const agents = this.dispatchable(requested);
    if (agents.length > 0) return { kind: "dispatch", agents };
    // Nothing left. The room says what is wrong and how to fix each one, rather than opening an empty
    // turn the operator has to interpret.
    const remedies = this.unusableAgents().map((agent) => this.refusalFor(agent) ?? agent);
    return {
      kind: "refused",
      reason:
        remedies.length === 0
          ? "no agent is available for this message"
          : `no agent is available. ${remedies.join(" ")}`,
    };
  }

  /** Test seam and the recovered-room path: adopt a record without running a probe. Frozen on the way
   *  in so an injected record cannot be mutated behind the service's back. */
  public adopt(record: RoomReadiness): void {
    this.record = Object.freeze({
      claude: Object.freeze(record.claude),
      codex: Object.freeze(record.codex),
      gemini: Object.freeze(record.gemini),
    });
  }
}

function isPresent(value: string | undefined): value is string {
  return value !== undefined;
}
