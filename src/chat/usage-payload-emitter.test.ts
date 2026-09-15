/**
 * @file src/chat/usage-payload-emitter.test.ts
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./events, ./usage-payload-emitter
 * @purpose The usage DIAGNOSTIC channel — what one diagnostic looks like on the wire, and what happens
 *   when the same one repeats.
 *
 *   The dedupe half had no direct test before this file: it was exercised only through the reporter,
 *   which is where a tripwire that quietly stopped tripping would have been hardest to notice. The
 *   marker half is FL-099's Node side and reads UNTRUSTED vendor output.
 */
import { expect, it } from "vitest";
import { ChatEventBus, type UsagePayloadEvent } from "./events.js";
import { usageOutcomeMarker, usagePayloadEmitter } from "./usage-payload-emitter.js";

function capture(): {
  readonly events: readonly UsagePayloadEvent[];
  readonly emitter: ReturnType<typeof usagePayloadEmitter>;
} {
  const bus = new ChatEventBus();
  const events: UsagePayloadEvent[] = [];
  bus.on("usage.payload", (event) => events.push(event));
  return {
    events,
    emitter: usagePayloadEmitter({ agent: "claude", bus, turn: 3 }, () => false),
  };
}

it("publishes the first occurrence of a signature and counts the rest", () => {
  const { events, emitter } = capture();

  emitter.emit("claude.statusline", "missing", []);
  emitter.emit("claude.statusline", "missing", []);
  emitter.emit("claude.statusline", "missing", []);
  // Nothing is published for the repeats YET — a tripwire that fired three times would be the flood
  // this dedupe exists to prevent.
  expect(events).toHaveLength(1);

  emitter.flushDropped();
  expect(events).toHaveLength(2);
  expect(events[1]).toMatchObject({ outcome: "deduped", droppedCount: 2 });
});

it("FALSIFIER: the signature is per (source, outcome, fields), not per source", () => {
  const { events, emitter } = capture();

  emitter.emit("acp.usage_update", "arrived", ["contextUsedPct"]);
  emitter.emit("acp.usage_update", "arrived", ["contextUsedPct", "fiveHourUsedPct"]);
  emitter.emit("acp.usage_update", "malformed", ["contextUsedPct"]);

  // A NEW field set is new information — it is the whole point of the tripwire, which exists to notice
  // a vendor payload changing shape. Deduping on source alone would swallow exactly that.
  expect(events).toHaveLength(3);
});

it("PIN: field ORDER does not create a false new signature", () => {
  const { events, emitter } = capture();

  emitter.emit("acp.usage_update", "arrived", ["fiveHourUsedPct", "contextUsedPct"]);
  emitter.emit("acp.usage_update", "arrived", ["contextUsedPct", "fiveHourUsedPct"]);

  // The same fields in a different order are the same reading. Without the sort this reports a shape
  // change on every turn whose decode happened to walk its keys differently.
  expect(events).toHaveLength(1);
});

it("PIN: an aborted capture publishes nothing at all", () => {
  const bus = new ChatEventBus();
  const events: UsagePayloadEvent[] = [];
  bus.on("usage.payload", (event) => events.push(event));
  const emitter = usagePayloadEmitter({ agent: "codex", bus, turn: 1 }, () => true);

  emitter.emit("codex.rollout", "stale", []);
  emitter.flushDropped();

  // A room that is shutting down does not want a diagnostic about the read it just cancelled.
  expect(events).toEqual([]);
});

it("FALSIFIER: the /usage outcome marker is read only from the three known values", () => {
  // UNTRUSTED vendor output. event-schemas.ts DROPS an unlisted enum value silently rather than
  // rejecting it, so an unknown marker that reached the emit would produce a diagnostic that vanishes
  // instead of one that is wrong out loud.
  expect(usageOutcomeMarker({ _meta: { "_claude/usageOutcome": "timed-out" } })).toBe("timed-out");
  expect(usageOutcomeMarker({ _meta: { "_claude/usageOutcome": "no-limits" } })).toBe("no-limits");
  expect(usageOutcomeMarker({ _meta: { "_claude/usageOutcome": "failed" } })).toBe("failed");
  for (const hostile of [
    { _meta: { "_claude/usageOutcome": "arrived" } },
    { _meta: { "_claude/usageOutcome": "TIMED-OUT" } },
    { _meta: { "_claude/usageOutcome": ["timed-out"] } },
    { _meta: { other: "timed-out" } },
    { _meta: "timed-out" },
    { meta: { "_claude/usageOutcome": "timed-out" } },
    "timed-out",
    undefined,
  ]) {
    expect(usageOutcomeMarker(hostile), `${JSON.stringify(hostile)} decoded`).toBeUndefined();
  }
});

it("PIN: a sample that cannot be structured-cloned still travels, as its string form", () => {
  const { events, emitter } = capture();

  // A vendor payload can carry a function or a live handle. Losing the whole diagnostic because its
  // sample would not clone is the tripwire failing in exactly the case it was built for.
  emitter.emit("acp.usage_update.raw", "arrived", ["used"], { used: 1, hook: () => undefined });

  expect(events).toHaveLength(1);
  expect(typeof events[0]?.sample).toBe("string");
});
