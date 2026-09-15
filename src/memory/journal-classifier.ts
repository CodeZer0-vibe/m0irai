/**
 * @file src/memory/journal-classifier.ts
 * @purpose J4 mechanical promotion — the code classifier that places a journal category shared-vs-per-agent
 *   by the rule "if another lane could make a wrong implementation choice without the fact, it is shared".
 *   Decisions, contracts, schema/API changes, verification outcomes, and operator anchors are SHARED (a
 *   teammate could pick wrong without them); lane-local reasoning, scratch, and per-agent session summaries
 *   stay PER-AGENT. Pure: a compile-checked table + a total function, no I/O.
 * @exports JournalCategory, JournalPlacement, CATEGORY_PLACEMENT, classifyPlacement
 * @depends (none)
 */

/** The named journal categories (§5 "J4's enum"). The DB column is free TEXT; this is the code vocabulary. */
export type JournalCategory =
  | "decision"
  | "contract"
  | "schema-change"
  | "api-change"
  | "verification"
  | "anchor"
  | "reasoning"
  | "scratch"
  | "summary";

/** Where an entry travels: SHARED (always in the core, cross-lane) or PER-AGENT (lane-local, router-pulled). */
export type JournalPlacement = "shared" | "per-agent";

/**
 * The J4 table — the single source of truth for placement. SHARED categories are the ones whose ABSENCE
 * could make another lane choose wrong; PER-AGENT categories are lane-local reasoning that never needs to
 * cross a lane by default. Exhaustive over {@link JournalCategory} (a compile error if a category is added
 * without a placement).
 */
export const CATEGORY_PLACEMENT: Readonly<Record<JournalCategory, JournalPlacement>> = {
  decision: "shared",
  contract: "shared",
  "schema-change": "shared",
  "api-change": "shared",
  verification: "shared",
  anchor: "shared",
  reasoning: "per-agent",
  scratch: "per-agent",
  summary: "per-agent",
};

/**
 * Places one category. A known category returns its table placement; an UNKNOWN category (a value outside
 * the union that reached us at runtime) defaults to PER-AGENT — the conservative choice, so an unrecognized
 * fact never leaks cross-lane by accident (over-sharing is the more damaging failure than under-sharing).
 *
 * @param category - the entry's category
 * @returns "shared" or "per-agent"
 */
export function classifyPlacement(category: JournalCategory): JournalPlacement {
  const placement: JournalPlacement | undefined = (
    CATEGORY_PLACEMENT as Record<string, JournalPlacement>
  )[category];
  return placement ?? "per-agent";
}
