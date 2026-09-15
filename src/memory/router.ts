/**
 * @file src/memory/router.ts
 * @purpose Select cross-agent briefing pulls from project-scoped journal rows by file relevance, category,
 *   agent ownership, and recency, leaving prompt-budget eviction to composeBriefing.
 * @exports MAX_PULLS, SelectBriefingPullsOptions, selectBriefingPulls
 * @depends ../evidence/db, ../shared/debug-mode, ../shared/types, ./briefing, ./journal-store
 */
import type { Db } from "../evidence/db.js";
import { debugEnabled } from "../shared/debug-mode.js";
import type { AgentName } from "../shared/types.js";
import type { BriefingPull } from "./briefing.js";
import { type JournalRow, type MemoryTraceBus, readByFiles } from "./journal-store.js";

export const MAX_PULLS = 8;

export interface SelectBriefingPullsOptions {
  readonly db: Db;
  readonly projectId: string;
  readonly forAgent: AgentName;
  readonly requestFiles: readonly string[];
  readonly limit?: number;
  readonly trace?: MemoryTraceBus;
}

const PULL_CATEGORIES = new Set<string>(["decision", "summary"]);
const AGENT_NAMES = new Set<string>(["claude", "codex", "gemini"]);

/** Select newest file-relevant decisions/summaries authored by OTHER agents or the ledger (digest)
 * for one project (MT6a-completion W3: ledger-authored rows — agent null — are pullable; their
 * sourceAgent is the literal "ledger" and their bodies stay MT5d-framed downstream).
 * M4: the file pull reads the journal_entry_files projection (journal-store readByFiles), so recall covers
 * ALL active rows rather than a recency window — the old readByProject(5000)-then-intersect-in-JSON scan
 * made any fact whose exact key was known unreachable once 5,000 newer active rows existed. ROUND 2: that
 * read is index-driven and bounded at MAX_FILE_MATCH_ROWS newest projection matches per request, so a hot
 * file key no longer materialises every matching row to produce 8 pulls. Candidate filtering still runs
 * through isCandidate here; supersession stays excluded at the store query (superseded_by IS NULL). */
export function selectBriefingPulls(options: SelectBriefingPullsOptions): readonly BriefingPull[] {
  const requestFiles = new Set(options.requestFiles);
  const limit = normalizeLimit(options.limit ?? MAX_PULLS);
  // Empty requestFiles matched nothing on the scan path either (hasRequestedFile rejected every row),
  // and an empty IN () would be invalid SQL — so zero pulls without touching the DB.
  const rows =
    requestFiles.size === 0 ? [] : readByFiles(options.db, options.projectId, requestFiles);
  const pulls = rows
    .filter((row) => isCandidate(row, options.forAgent))
    .slice(0, limit)
    .map(toPull);
  emitTrace(options.trace, pulls.length);
  return pulls;
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return 0;
  }
  return Math.max(0, Math.trunc(limit));
}

function isCandidate(row: JournalRow, forAgent: AgentName): boolean {
  if (
    !PULL_CATEGORIES.has(row.category) ||
    row.touchedFiles === null ||
    row.touchedFiles.length === 0
  ) {
    return false;
  }
  // Agent-authored: another VALID agent's row (never the requester's own). Ledger-authored (the
  // digest's extractions, agent null): always a candidate — no owner to exclude (W3).
  if (row.author === "agent") {
    return isAgentName(row.agent) && row.agent !== forAgent;
  }
  return row.author === "ledger";
}

function isAgentName(agent: string | null): agent is AgentName {
  return agent !== null && AGENT_NAMES.has(agent);
}

// M4: hasRequestedFile was deleted with the scan path — the projection EXISTS clause now decides file
// relevance in SQL (same canonical keys, same exact equality; both edges share file-key.ts).

function toPull(row: JournalRow): BriefingPull {
  if (row.author === "agent" && !isAgentName(row.agent)) {
    throw new Error(`router candidate lost valid agent: ${row.entryId}`);
  }
  // sourceAgent derives from AUTHORSHIP, never the raw agent column: a ledger-authored row that
  // happens to carry an agent name must NEVER masquerade as that agent's pull (the MT6a-fix
  // invariant, re-proven by the falsifier this line broke on first write).
  return {
    entry: row,
    sourceAgent: row.author === "agent" && isAgentName(row.agent) ? row.agent : "ledger",
  };
}

function emitTrace(trace: MemoryTraceBus | undefined, selected: number): void {
  if (trace === undefined || !debugEnabled()) {
    return;
  }
  trace.emit({
    kind: "memory.trace",
    phase: "briefing",
    turn: 0,
    detail: `router selected=${selected}`,
  });
}
