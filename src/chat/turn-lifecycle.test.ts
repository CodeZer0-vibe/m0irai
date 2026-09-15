/**
 * @file src/chat/turn-lifecycle.test.ts
 * @purpose RED-first falsifiers for the turn-lifecycle model (F-2). Pins the per-lane transition guard
 *          (illegal moves throw; terminals are sinks) and the turn AGGREGATE precedence — the load-bearing
 *          contract the Phase-B review flagged as underspecified: every partition of lane terminals must
 *          map to exactly one TurnState, including all-timed_out, mixed failure, and abort-with-a-success
 *          (which must report `partial`, never a bare `cancelled` that hides the win).
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./turn-lifecycle
 */
import { describe, expect, it } from "vitest";
import { aggregateTurn, assertTransition, canTransition } from "./turn-lifecycle.js";

describe("turn-lifecycle — lane transition guard", () => {
  it("permits the forward path and forbids resurrecting a terminal", () => {
    expect(canTransition("routing", "working")).toBe(true);
    expect(canTransition("working", "completed")).toBe(true);
    expect(canTransition("working", "timed_out")).toBe(true);
    expect(canTransition("completed", "working")).toBe(false); // a terminal is a sink
    expect(canTransition("failed", "completed")).toBe(false);
  });

  it("assertTransition throws on an illegal move, naming it", () => {
    expect(() => assertTransition("completed", "working")).toThrow(/completed/);
    expect(() => assertTransition("working", "completed")).not.toThrow();
  });

  it("no LIVE transition can reach `interrupted` — it is synthesized only on resume (U2e-c #8 RESUME-ONLY pin)", () => {
    // The live lifecycle never enters `interrupted`; session-to-turns.ts synthesizes it on rebuild. Pinning
    // the absence of an incoming edge is what keeps the widened LaneTerminal honest against a live producer.
    expect(canTransition("routing", "interrupted")).toBe(false);
    expect(canTransition("working", "interrupted")).toBe(false);
    expect(canTransition("interrupted", "working")).toBe(false); // and it is a sink (no outgoing edge)
  });
});

describe("turn-lifecycle — aggregate precedence (every partition mapped)", () => {
  it("all completed → completed", () => {
    expect(aggregateTurn(["completed", "completed", "completed"])).toBe("completed");
  });

  it("at least one completed + at least one not → partial (the win is never hidden)", () => {
    expect(aggregateTurn(["completed", "failed", "completed"])).toBe("partial");
    // the operator's edge case: abort a turn where one lane already succeeded → partial, NOT cancelled
    expect(aggregateTurn(["completed", "cancelled"])).toBe("partial");
    expect(aggregateTurn(["completed", "timed_out"])).toBe("partial");
  });

  it("zero completed, any cancelled → cancelled", () => {
    expect(aggregateTurn(["cancelled", "cancelled"])).toBe("cancelled");
    expect(aggregateTurn(["cancelled", "failed"])).toBe("cancelled");
  });

  it("zero completed, no cancel, all timed_out → timed_out", () => {
    expect(aggregateTurn(["timed_out", "timed_out"])).toBe("timed_out");
  });

  it("zero completed, no cancel, mixed failure → failed (failure dominates timeout)", () => {
    expect(aggregateTurn(["failed", "failed"])).toBe("failed");
    expect(aggregateTurn(["timed_out", "failed"])).toBe("failed");
  });

  it("an empty turn aggregates to completed (vacuously — no lane failed)", () => {
    expect(aggregateTurn([])).toBe("completed");
  });

  it("an interrupted lane SEALS the turn as failure-grade (INV-EF7); a completed sibling → partial", () => {
    expect(aggregateTurn(["interrupted"])).toBe("failed"); // a terminal (seals) + failure-grade
    expect(aggregateTurn(["completed", "interrupted"])).toBe("partial"); // a success is never hidden
    expect(aggregateTurn(["interrupted", "timed_out"])).toBe("failed"); // dominates a bare timeout
  });
});
