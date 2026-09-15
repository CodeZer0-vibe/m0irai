/**
 * @file src/chat/memory-trace-phases.test.ts
 * @purpose MT7 T1-D lockstep tests for memory.trace phase literals.
 * @exports (none - test file)
 * @depends vitest, ./events, ./event-schemas
 */
import { expect, it } from "vitest";
import { MemoryTracePhaseSchema } from "./event-schemas.js";
import { ChatEventSchema, MEMORY_TRACE_PHASES } from "./events.js";

const EXPECTED_PHASES = [
  "migrated",
  "journal",
  "briefing",
  "digest",
  "read-proof",
  "compaction",
  "conflict",
  "resume.attempted",
  "resume.ok",
  "resume.fallback",
  "compaction.detected",
  "compaction.inferred",
  "briefing.injected",
  "delta.injected",
  "delta.duplicate",
  "delta.maybeDuplicate",
  "delta.overflow",
  "cursor.commitFailed",
  "close.orphan",
  "lane.lockConflict",
  // THE BOUNDARY WAVE (B7): emitted whenever a composed prompt actually reclassified >=1
  // prior-session entry as untrusted (event-schemas.ts's own MEMORY_TRACE_PHASES comment).
  "boundary.framed",
] as const;

function sorted(values: readonly string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

it("keeps the MemoryTracePhase runtime list in lockstep with the MT7 spec literals", () => {
  expect(sorted(MEMORY_TRACE_PHASES)).toEqual(sorted(EXPECTED_PHASES));
});

it("keeps the MemoryTracePhase runtime list and Zod enum in lockstep", () => {
  expect(sorted(MemoryTracePhaseSchema.options)).toEqual(sorted(MEMORY_TRACE_PHASES));
});

it("validates every MemoryTracePhase through ChatEventSchema", () => {
  for (const phase of MEMORY_TRACE_PHASES) {
    expect(ChatEventSchema.safeParse({ kind: "memory.trace", phase, turn: 0 }).success).toBe(true);
  }
});
