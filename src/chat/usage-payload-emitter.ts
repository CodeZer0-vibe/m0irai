/**
 * @file src/chat/usage-payload-emitter.ts
 * @purpose How a usage DIAGNOSTIC is published and deduped, separate from where usage is read.
 * @exports UsagePayloadOutcome, PayloadEmitter, usagePayloadEmitter, usageOutcomeMarker
 * @depends ./events, ./types
 *
 * Extracted out of usage-reporter.ts when M4's three new outcome values pushed that file past its
 * 500-line target. The ratchet only falls: growth is answered by extraction, never by a size
 * justification. This is a real seam rather than a convenient cut — the reporter's other half is
 * "which source do I read for this agent, and how long do I wait", and this half is "what does one
 * diagnostic look like on the wire, and what happens when the same one repeats". They share nothing
 * but the bus.
 */
import type { ChatEventBus } from "./events.js";
import type { AgentName } from "./types.js";

/** LOCKSTEP with events.ts's UsagePayloadEvent and event-schemas.ts's UsagePayloadSchema — and the
 *  lockstep matters more than it looks: event-schemas.ts states that a value absent from its enum is
 *  DROPPED by the non-strict bus parse rather than rejected, so a new outcome added in one place and
 *  not the others produces silence instead of an error.
 *
 *  Still a strict subset of the wire's: "deduped" is emitted literally by the flush below rather than
 *  through this type, and tidying that is not this slice's business. */
export type UsagePayloadOutcome =
  | "arrived"
  | "missing"
  | "stale"
  | "malformed"
  | "write-failed"
  | "timed-out"
  | "no-limits"
  | "failed";

export interface PayloadEmitter {
  readonly emit: (
    source: string,
    outcome: UsagePayloadOutcome,
    fields: readonly string[],
    sample?: unknown,
  ) => void;
  readonly flushDropped: () => void;
}

interface DroppedPayload {
  readonly source: string;
  readonly fields: readonly string[];
  readonly count: number;
  readonly sample?: unknown;
}

/** The lane identity every diagnostic carries. Narrower than the reporter's own input on purpose: this
 *  module has no business knowing about cwd, poll bounds or session ids, and taking the whole input
 *  would have made the two halves import each other. */
export interface UsagePayloadLane {
  readonly agent: AgentName;
  readonly bus: ChatEventBus;
  readonly turn: number;
}

/**
 * One turn's diagnostic channel. The FIRST occurrence of a (source, outcome, fields) signature is
 * published; every repeat is counted and reported once at flush as a `deduped` receipt with its count
 * and last sample — a tripwire that stays a tripwire instead of becoming a flood.
 */
export function usagePayloadEmitter(
  lane: UsagePayloadLane,
  aborted: () => boolean,
): PayloadEmitter {
  const emittedSignatures = new Set<string>();
  const dropped = new Map<string, DroppedPayload>();
  const emit = (
    source: string,
    outcome: UsagePayloadOutcome,
    fields: readonly string[],
    sample?: unknown,
  ): void => {
    if (aborted()) return;
    const signature = [source, outcome, ...[...fields].sort()].join("\u0000");
    if (emittedSignatures.has(signature)) {
      const prior = dropped.get(signature);
      dropped.set(signature, {
        source,
        fields,
        count: (prior?.count ?? 0) + 1,
        ...(sample === undefined ? {} : { sample: cloneSample(sample) }),
      });
      return;
    }
    emittedSignatures.add(signature);
    lane.bus.emit({
      kind: "usage.payload",
      agent: lane.agent,
      turn: lane.turn,
      source,
      outcome,
      fields,
      ...(sample === undefined ? {} : { sample: cloneSample(sample) }),
    });
  };
  const flushDropped = (): void => {
    for (const entry of dropped.values()) emitDroppedPayload(lane, entry);
    dropped.clear();
  };
  return { emit, flushDropped };
}

/**
 * FL-099. The receipt the patched claude bridge writes when /usage produced no windows, and WHY.
 * Its only channel to us is `client.sessionUpdate` (acp-agent.js), so the receipt rides as `_meta` on a
 * `usage_update` rather than as an outcome of its own — an earlier draft specified a `usage.payload`
 * emitted by the bridge, which that process cannot do.
 *
 * Returns undefined for anything that is not one of the three known values, including a `_meta` the
 * bridge never wrote: this reads UNTRUSTED vendor output, and an unrecognised marker is absent, not a
 * new outcome invented on its behalf.
 */
export function usageOutcomeMarker(update: unknown): UsagePayloadOutcome | undefined {
  if (update === null || typeof update !== "object") return undefined;
  const meta = (update as { readonly _meta?: unknown })._meta;
  if (meta === null || typeof meta !== "object") return undefined;
  const value = (meta as Record<string, unknown>)[USAGE_OUTCOME_META_KEY];
  return USAGE_RACE_OUTCOMES.find((outcome) => outcome === value);
}

const USAGE_OUTCOME_META_KEY = "_claude/usageOutcome";
const USAGE_RACE_OUTCOMES = ["timed-out", "no-limits", "failed"] as const;

function emitDroppedPayload(lane: UsagePayloadLane, entry: DroppedPayload): void {
  lane.bus.emit({
    kind: "usage.payload",
    agent: lane.agent,
    turn: lane.turn,
    source: entry.source,
    outcome: "deduped",
    fields: entry.fields,
    droppedCount: entry.count,
    ...(entry.sample === undefined ? {} : { sample: entry.sample }),
  });
}

function cloneSample(sample: unknown): unknown {
  try {
    return structuredClone(sample);
  } catch {
    return String(sample);
  }
}
