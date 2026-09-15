/**
 * @file src/memory/memory-flags.ts
 * @purpose The ONE resolution seam for the MEMORY-FULL master switches — ZER0_MEMORY (the whole unit,
 *   incl. the v15 DB migration, is inert when off — AC5) and ZER0_NATIVE_RESUME (S1; DEFAULT ON since the 2026-07-10 operator smoke, sentinel-disableable) —
 *   reusing the debug-unifier's normalized truthiness convention, plus the briefing budget config
 *   object with R2's enforced minimum (anchor pool + floors + pulls cap). Pure: env read + validation.
 * @exports memoryEnabled, nativeResumeEnabled, carrierEnabled, MemoryBriefingBudget, DEFAULT_MEMORY_BRIEFING_BUDGET, MEMORY_BRIEFING_MINIMUM_TOTAL, resolveMemoryBriefingBudget
 * @depends node:process, ../shared/error-codes, ../shared/errors
 */
import process from "node:process";
import { Zer0ErrorCode } from "../shared/error-codes.js";
import { ConfigError } from "../shared/errors.js";

// The values that read as OFF after normalization — the SAME sentinels as src/shared/debug-mode.ts, so a
// falsy-LOOKING value ("False", " 0 ", "No", "OFF") can never surprise-DISABLE the switch. Compared against
// a trimmed + lowercased env value; anything else (after normalizing) is ON.
const OFF_SENTINELS: ReadonlySet<string> = new Set(["", "0", "false", "no", "off"]);

// B2a-1 (2026-07-18, operator ruling): BOTH master switches are OPT-OUT — UNSET reads ON. An explicit
// falsy sentinel (=0/off/no/false, case/whitespace-insensitive) is the only way to disable. ONE helper
// both memoryEnabled + nativeResumeEnabled share (nativeResumeEnabled already had this exact shape since
// the 2026-07-10 smoke; memoryEnabled flipped to it here — the semantics are now identical).
function envOptOutEnabled(name: string): boolean {
  const raw = process.env[name];
  if (raw === undefined) {
    return true;
  }
  return !OFF_SENTINELS.has(raw.trim().toLowerCase());
}

/**
 * Whether ZER0_MEMORY is enabled — the master switch. B2a-1: DEFAULT ON (opt-out) — a fresh boot opens the
 * memory-scoped DB (running the v15/v16 migration) and wires the carrier. Only an EXPLICIT falsy sentinel
 * (ZER0_MEMORY=0/off/no/false) makes the ENTIRE memory unit inert (the migration never runs, no journal
 * path executes, the DB and every prompt stay byte-identical to the pre-unit tree — the sealed AC5 path,
 * now reached by explicit opt-out instead of by default). Normalized trim+lowercase before matching.
 */
export function memoryEnabled(): boolean {
  return envOptOutEnabled("ZER0_MEMORY");
}

/**
 * Whether ZER0_NATIVE_RESUME is enabled. DEFAULT ON since 2026-07-10 — the operator's live ConPTY
 * smoke (the S1 gate) passed on all three lanes incl. cross-agent cross-session ledger recall; an
 * explicit falsy sentinel (ZER0_NATIVE_RESUME=0/off/no/false) still disables it. The COMPOSED
 * carrier gate composes this with ZER0_MEMORY (carrierEnabled below) — with both now default-ON, a
 * fresh boot engages the carrier unless the operator opts either switch out.
 */
export function nativeResumeEnabled(): boolean {
  return envOptOutEnabled("ZER0_NATIVE_RESUME");
}

/**
 * The MT7 carrier gate (I-6): native persistent sessions engage ONLY when BOTH switches are on. The
 * composition is load-bearing — `ZER0_NATIVE_RESUME=1` with `ZER0_MEMORY` off is fully inert (no v16
 * migration, no carrier paths, byte-identical prompts), preserving the sealed AC5 master-switch contract
 * (the L-1 r1-B1 hole: a resume-only flag must never mutate a memory-off DB).
 */
export function carrierEnabled(): boolean {
  return memoryEnabled() && nativeResumeEnabled();
}

/**
 * The briefing token budget (R2), config-overridable. `total` is the ceiling; the rest are the ordered
 * allocation constants (anchors -> core -> map -> own-journal -> router pulls). Floors are minimums, not
 * maximums — a `total` above the minimum lets categories expand in allocation order.
 */
export interface MemoryBriefingBudget {
  readonly total: number;
  readonly anchorPool: number;
  readonly coreFloor: number;
  readonly mapFloor: number;
  readonly ownJournalFloor: number;
  readonly pullsCap: number;
}

/** R2's closed arithmetic: 300 + 400*3 + 400 = 1,900 <= 2,000. The ONE config object the tests read. */
export const DEFAULT_MEMORY_BRIEFING_BUDGET: MemoryBriefingBudget = {
  total: 2000,
  anchorPool: 300,
  coreFloor: 400,
  mapFloor: 400,
  ownJournalFloor: 400,
  pullsCap: 400,
};

/** The hard minimum a configured `total` may take: anchor pool + the three floors + the pulls cap (1,900
 * with defaults). Below this the ordered allocation cannot fit its own floors, so a smaller total is a
 * misconfiguration — rejected at load (R2 override semantics). */
export const MEMORY_BRIEFING_MINIMUM_TOTAL: number = minimumTotal(DEFAULT_MEMORY_BRIEFING_BUDGET);

function minimumTotal(budget: MemoryBriefingBudget): number {
  return (
    budget.anchorPool +
    budget.coreFloor +
    budget.mapFloor +
    budget.ownJournalFloor +
    budget.pullsCap
  );
}

/**
 * Resolves the briefing budget: merges any overrides onto {@link DEFAULT_MEMORY_BRIEFING_BUDGET} and
 * REJECTS at load (throws) when the resulting `total` is below the minimum (anchor pool + floors + pulls
 * cap), with a message naming that minimum — the operator hears at config time, never mid-composition.
 * The default config resolves cleanly (2,000 >= 1,900).
 *
 * @param overrides - partial budget overrides (e.g. a larger total); omit for the default
 * @returns the validated budget
 * @throws ConfigError(ConfigInvalid) when the resolved total is below the enforced minimum
 */
export function resolveMemoryBriefingBudget(
  overrides?: Partial<MemoryBriefingBudget>,
): MemoryBriefingBudget {
  const budget: MemoryBriefingBudget = { ...DEFAULT_MEMORY_BRIEFING_BUDGET, ...overrides };
  const minimum = minimumTotal(budget);
  if (budget.total < minimum) {
    throw new ConfigError(
      `ZER0 memory briefing budget total ${budget.total} is below the minimum ${minimum} (anchor pool ${budget.anchorPool} + floors ${budget.coreFloor}+${budget.mapFloor}+${budget.ownJournalFloor} + pulls cap ${budget.pullsCap}); raise the total to at least ${minimum}`,
      Zer0ErrorCode.ConfigInvalid,
    );
  }
  return budget;
}
