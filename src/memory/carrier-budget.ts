/**
 * @file src/memory/carrier-budget.ts
 * @purpose MT7 carrier budget constants and dynamic partitioning for ledger delta and catch-up payloads.
 * @exports MAX_PROMPT_CHARS, reserveSetup, reserveBriefing, dropPct, sustainPct, sustainTurns, periodicRecarryTurns, deltaMaxBytes, deltaMaxMessages, catchupMaxBytes, catchupMaxMessages, overflowHeadroom, CARRIER_BUDGET, partitionCarrierBudget
 * @depends (none)
 */
export const MAX_PROMPT_CHARS = 24_000;
export const reserveSetup = 1_500;
export const reserveBriefing = 8_500;
export const dropPct = 30;
export const sustainPct = 70;
export const sustainTurns = 2;
export const periodicRecarryTurns = 15;
export const deltaMaxBytes = 10_000;
export const deltaMaxMessages = 30;
export const catchupMaxBytes = 8_000;
export const catchupMaxMessages = 20;
export const overflowHeadroom = 2_000;

export interface CarrierBudgetConstants {
  readonly MAX_PROMPT_CHARS: 24_000;
  readonly reserveSetup: 1_500;
  readonly reserveBriefing: 8_500;
  readonly dropPct: 30;
  readonly sustainPct: 70;
  readonly sustainTurns: 2;
  readonly periodicRecarryTurns: 15;
  readonly deltaMaxBytes: 10_000;
  readonly deltaMaxMessages: 30;
  readonly catchupMaxBytes: 8_000;
  readonly catchupMaxMessages: 20;
  readonly overflowHeadroom: 2_000;
}

export const CARRIER_BUDGET: CarrierBudgetConstants = {
  MAX_PROMPT_CHARS: 24_000,
  reserveSetup: 1_500,
  reserveBriefing: 8_500,
  dropPct: 30,
  sustainPct: 70,
  sustainTurns: 2,
  periodicRecarryTurns: 15,
  deltaMaxBytes: 10_000,
  deltaMaxMessages: 30,
  catchupMaxBytes: 8_000,
  catchupMaxMessages: 20,
  overflowHeadroom: 2_000,
};
export type CarrierBudgetMode = "delta" | "catchup";
export type CarrierBudgetOutcome = "carrier-budget" | "existing-whole-prompt-truncation-applies";

export interface EntryBudget {
  readonly maxBytes: number;
  readonly maxMessages: number;
}

export interface PartitionCarrierBudgetInput {
  readonly operatorBytes: number;
  readonly briefingCarried: boolean;
  readonly mode: CarrierBudgetMode;
  readonly overflowPending: boolean;
}

export interface CarrierBudgetPartition {
  readonly outcome: CarrierBudgetOutcome;
  readonly operatorBytes: number;
  readonly briefingBytes: number;
  readonly rawEntryPoolBytes: number;
  readonly overflowPending: boolean;
  readonly overflowHeadroomReserved: number;
  readonly entryBytes: number;
  readonly entryMessages: number;
  readonly entryBudget: EntryBudget;
}

export function partitionCarrierBudget(input: PartitionCarrierBudgetInput): CarrierBudgetPartition {
  const operatorBytes = nonNegativeInteger(input.operatorBytes, "operatorBytes");
  const briefingBytes = input.briefingCarried ? reserveBriefing : 0;
  const rawEntryPoolBytes = Math.max(
    0,
    MAX_PROMPT_CHARS - operatorBytes - reserveSetup - briefingBytes,
  );
  if (operatorBytes > MAX_PROMPT_CHARS - reserveSetup) {
    return partition({
      input,
      operatorBytes,
      briefingBytes,
      rawEntryPoolBytes,
      entryBytes: 0,
      headroom: 0,
    });
  }
  const headroom = input.overflowPending ? Math.min(rawEntryPoolBytes, overflowHeadroom) : 0;
  const availableBytes = Math.max(0, rawEntryPoolBytes - headroom);
  const limits = limitsFor(input.mode);
  const entryBytes = Math.min(availableBytes, limits.maxBytes);
  return partition({
    input,
    operatorBytes,
    briefingBytes,
    rawEntryPoolBytes,
    entryBytes,
    headroom,
  });
}

function limitsFor(mode: CarrierBudgetMode): EntryBudget {
  if (mode === "catchup") {
    return { maxBytes: catchupMaxBytes, maxMessages: catchupMaxMessages };
  }
  return { maxBytes: deltaMaxBytes, maxMessages: deltaMaxMessages };
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite`);
  }
  return Math.max(0, Math.trunc(value));
}

function partition(args: {
  readonly input: PartitionCarrierBudgetInput;
  readonly operatorBytes: number;
  readonly briefingBytes: number;
  readonly rawEntryPoolBytes: number;
  readonly entryBytes: number;
  readonly headroom: number;
}): CarrierBudgetPartition {
  const entryBudget = limitsFor(args.input.mode);
  return {
    outcome:
      args.operatorBytes > MAX_PROMPT_CHARS - reserveSetup
        ? "existing-whole-prompt-truncation-applies"
        : "carrier-budget",
    operatorBytes: args.operatorBytes,
    briefingBytes: args.briefingBytes,
    rawEntryPoolBytes: args.rawEntryPoolBytes,
    overflowPending: args.input.overflowPending,
    overflowHeadroomReserved: args.headroom,
    entryBytes: args.entryBytes,
    entryMessages: entryBudget.maxMessages,
    entryBudget,
  };
}
