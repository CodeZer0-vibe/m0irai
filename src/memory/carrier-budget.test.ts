/**
 * @file src/memory/carrier-budget.test.ts
 * @purpose MT7 T2 tests for the dynamic carrier budget partition and pinned constants.
 * @exports (none - test file)
 * @depends vitest, ./carrier-budget
 */
import { expect, it } from "vitest";
import {
  CARRIER_BUDGET,
  MAX_PROMPT_CHARS,
  catchupMaxBytes,
  catchupMaxMessages,
  deltaMaxBytes,
  deltaMaxMessages,
  dropPct,
  overflowHeadroom,
  partitionCarrierBudget,
  periodicRecarryTurns,
  reserveBriefing,
  reserveSetup,
  sustainPct,
  sustainTurns,
} from "./carrier-budget.js";

const CLAMPED_OPERATOR_LENGTHS = [0, 1, 10_000, 14_000];
const SEED = 0x5eed_2026;

function composedBytes(parts: {
  readonly operatorBytes: number;
  readonly briefingBytes: number;
  readonly deltaBytes: number;
  readonly overflowBytes: number;
}): number {
  return (
    parts.operatorBytes +
    reserveSetup +
    parts.briefingBytes +
    parts.deltaBytes +
    parts.overflowBytes
  );
}

function nextSeed(seed: number): number {
  return (seed * 1_664_525 + 1_013_904_223) >>> 0;
}

it("exports the pinned MT7 carrier budget constants", () => {
  expect(MAX_PROMPT_CHARS).toBe(24_000);
  expect(reserveSetup).toBe(1_500);
  expect(reserveBriefing).toBe(8_500);
  expect(dropPct).toBe(30);
  expect(sustainPct).toBe(70);
  expect(sustainTurns).toBe(2);
  expect(periodicRecarryTurns).toBe(15);
  expect(deltaMaxBytes).toBe(10_000);
  expect(deltaMaxMessages).toBe(30);
  expect(catchupMaxBytes).toBe(8_000);
  expect(catchupMaxMessages).toBe(20);
  expect(overflowHeadroom).toBe(2_000);
  expect(CARRIER_BUDGET).toEqual({
    MAX_PROMPT_CHARS,
    reserveSetup,
    reserveBriefing,
    dropPct,
    sustainPct,
    sustainTurns,
    periodicRecarryTurns,
    deltaMaxBytes,
    deltaMaxMessages,
    catchupMaxBytes,
    catchupMaxMessages,
    overflowHeadroom,
  });
});

it("keeps every clamped delta and catch-up pool composition within MAX_PROMPT_CHARS", () => {
  for (const operatorBytes of CLAMPED_OPERATOR_LENGTHS) {
    for (const briefingCarried of [false, true]) {
      for (const mode of ["delta", "catchup"] as const) {
        for (const overflowPending of [false, true]) {
          const partition = partitionCarrierBudget({
            operatorBytes,
            briefingCarried,
            mode,
            overflowPending,
          });
          const briefingBytes = briefingCarried ? reserveBriefing : 0;
          const overflowBytes = partition.overflowHeadroomReserved;
          expect(partition.outcome).toBe("carrier-budget");
          expect(
            composedBytes({
              operatorBytes,
              briefingBytes,
              deltaBytes: partition.entryBytes,
              overflowBytes,
            }),
          ).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
        }
      }
    }
  }
});

it("preserves an unbounded nondegenerate operator and carried briefing while flooring delta to zero", () => {
  const operatorBytes = MAX_PROMPT_CHARS - reserveSetup - reserveBriefing + 1;
  const partition = partitionCarrierBudget({
    operatorBytes,
    briefingCarried: true,
    mode: "delta",
    overflowPending: true,
  });

  expect(partition.outcome).toBe("carrier-budget");
  expect(partition.operatorBytes).toBe(operatorBytes);
  expect(partition.briefingBytes).toBe(reserveBriefing);
  expect(partition.entryBytes).toBe(0);
  expect(partition.overflowPending).toBe(true);
});

it("reports the degenerate whole-prompt truncation outcome distinctly", () => {
  const operatorBytes = MAX_PROMPT_CHARS - reserveSetup + 1;
  const partition = partitionCarrierBudget({
    operatorBytes,
    briefingCarried: false,
    mode: "delta",
    overflowPending: true,
  });

  expect(partition.outcome).toBe("existing-whole-prompt-truncation-applies");
  expect(partition.operatorBytes).toBe(operatorBytes);
  expect(partition.entryBytes).toBe(0);
  expect(partition.overflowPending).toBe(true);
});

it("holds the partition properties across a fixed-seed generated table", () => {
  let seed = SEED;
  for (let i = 0; i < 96; i += 1) {
    seed = nextSeed(seed);
    const operatorBytes = seed % (MAX_PROMPT_CHARS - reserveSetup - reserveBriefing + 1);
    seed = nextSeed(seed);
    const briefingCarried = (seed & 1) === 1;
    seed = nextSeed(seed);
    const overflowPending = (seed & 2) === 2;
    const partition = partitionCarrierBudget({
      operatorBytes,
      briefingCarried,
      mode: "delta",
      overflowPending,
    });
    const briefingBytes = briefingCarried ? reserveBriefing : 0;
    expect(partition.entryMessages).toBeLessThanOrEqual(deltaMaxMessages);
    expect(partition.entryBytes).toBeLessThanOrEqual(deltaMaxBytes);
    expect(
      composedBytes({
        operatorBytes,
        briefingBytes,
        deltaBytes: partition.entryBytes,
        overflowBytes: partition.overflowHeadroomReserved,
      }),
    ).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
  }
});
