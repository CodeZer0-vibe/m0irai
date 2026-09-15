/**
 * @file src/memory/journal-store.ts
 * @purpose Append/read/supersede over the v15 journal_entries source of record. J2: per-project seq
 *   allocated then INSERTed with retry-on-UNIQUE (one autocommit INSERT per attempt; M4 narrowed the
 *   retryable set to UNIQUE/PRIMARYKEY); the v21 AFTER INSERT trigger lands projection rows atomically.
 *   J5: supersession links old->new (anchors resist). readByFiles runs the pinned per-key statement once
 *   per requested key and k-way merges newest-first, bounded at MAX_FILE_MATCH_ROWS DISTINCT entries;
 *   reads are project-scoped fail-closed (M3).
 * @exports MemoryTraceBus, JournalAuthor, JournalAppend, JournalRow, AppendOptions, ReadOptions, SupersedeOptions, SupersedeResult, appendEntry, readByProject, readByFiles, buildReadByFilesSql, supersede
 * @depends ulid, ../chat/events, ../evidence/db, ../shared/debug-mode, ./file-key, ./journal-classifier
 */
import { ulid } from "ulid";
import type { ChatEvent, MemoryTracePhase } from "../chat/events.js";
import type { Db } from "../evidence/db.js";
import { debugEnabled } from "../shared/debug-mode.js";
import { canonicalFileSet } from "./file-key.js";
import type { JournalCategory } from "./journal-classifier.js";

/** The minimal event-bus surface tracing needs (the live ChatEventBus satisfies it; a test injects a fake). */
export interface MemoryTraceBus {
  emit(event: ChatEvent): void;
}

/** The author origins §5 pins for the trust boundary (T1). */
export type JournalAuthor = "agent" | "operator" | "ledger";

/** One logical journal write. createdAt is caller-supplied so tests are deterministic. */
export interface JournalAppend {
  readonly projectId: string;
  readonly category: JournalCategory;
  readonly author: JournalAuthor;
  readonly body: string;
  readonly createdAt: string;
  readonly agent?: string;
  readonly topicKey?: string;
  readonly touchedFiles?: readonly string[];
  readonly domainTags?: readonly string[];
  readonly anchor?: boolean;
}

/** A journal row read back, DB shapes decoded (anchor -> boolean, JSON tag columns parsed). */
export interface JournalRow {
  readonly entryId: string;
  readonly projectId: string;
  readonly category: string;
  readonly author: string;
  readonly agent: string | null;
  readonly body: string;
  readonly topicKey: string | null;
  readonly touchedFiles: readonly string[] | null;
  readonly domainTags: readonly string[] | null;
  readonly anchor: boolean;
  readonly supersededBy: string | null;
  readonly seq: number;
  readonly createdAt: string;
}

export interface AppendOptions {
  readonly trace?: MemoryTraceBus;
  /** Test-only seam fired AFTER the seq is selected and BEFORE the INSERT, to force a cross-cockpit collision. */
  readonly beforeInsert?: () => void;
}

export interface ReadOptions {
  readonly limit?: number;
  readonly includeSuperseded?: boolean;
}

export interface SupersedeOptions {
  readonly trace?: MemoryTraceBus;
  /** Auto (digest) supersession leaves this false and is REFUSED for anchors; the explicit operator remove sets it. */
  readonly allowAnchor?: boolean;
}

export type SupersedeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

const MAX_SEQ_RETRIES = 8;
const DEFAULT_READ_LIMIT = 500;
const MAX_READ_LIMIT = 5_000;
const SEQ_SQL =
  "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM journal_entries WHERE project_id = ?";
const INSERT_SQL =
  "INSERT INTO journal_entries " +
  "(entry_id, project_id, category, author, agent, body, topic_key, touched_files, domain_tags, anchor, superseded_by, seq, created_at) " +
  "VALUES (@entryId, @projectId, @category, @author, @agent, @body, @topicKey, @touchedFiles, @domainTags, @anchor, NULL, @seq, @createdAt)";

interface SeqRow {
  next: number;
}

/**
 * Appends one journal entry with a retried per-project seq (J2). Each attempt: select the next seq (an
 * autocommit read of the latest committed state), then a single-statement INSERT. If another cockpit took
 * that seq between the read and the INSERT, SQLite raises SQLITE_CONSTRAINT_UNIQUE and the loop retries with
 * the now-higher seq — both writers land, no entry is lost. Emits a debug-gated memory.trace on success.
 *
 * @param db - an open memory-scoped evidence DB (v15; WAL + busy_timeout)
 * @param entry - the entry to append (createdAt caller-supplied for determinism)
 * @param opts - optional injected trace bus + the test-only beforeInsert collision seam
 * @returns the new entry_id (ulid)
 * @throws the underlying SqliteError if a non-UNIQUE failure occurs, or after the retry budget is exhausted
 */
export function appendEntry(db: Db, entry: JournalAppend, opts?: AppendOptions): string {
  const entryId = ulid();
  const seqStmt = db.prepare(SEQ_SQL);
  const insertStmt = db.prepare(INSERT_SQL);
  // MT6a-review W1: the STORE edge canonicalizes touchedFiles (backslash→slash, ./ stripped, dupes
  // dropped, non-file shapes discarded, empty→NULL) so EVERY producer — digest, agents, future
  // callers — lands router-matchable keys. The read edge (extractRequestFiles) shares file-key.ts.
  const touched = entry.touchedFiles ? canonicalFileSet(entry.touchedFiles) : undefined;
  const params = {
    entryId,
    projectId: entry.projectId,
    category: entry.category,
    author: entry.author,
    agent: entry.agent ?? null,
    body: entry.body,
    topicKey: entry.topicKey ?? null,
    touchedFiles: touched ? JSON.stringify(touched) : null,
    domainTags: entry.domainTags ? JSON.stringify(entry.domainTags) : null,
    anchor: entry.anchor ? 1 : 0,
    createdAt: entry.createdAt,
  };
  for (let attempt = 0; attempt <= MAX_SEQ_RETRIES; attempt += 1) {
    const seq = (seqStmt.get(entry.projectId) as SeqRow).next;
    opts?.beforeInsert?.();
    try {
      insertStmt.run({ ...params, seq });
      emitTrace(opts?.trace, "journal", `${entryId} ${entry.category} ${entry.author}`);
      return entryId;
    } catch (err) {
      if (isUniqueViolation(err) && attempt < MAX_SEQ_RETRIES) {
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    `journal append exhausted ${MAX_SEQ_RETRIES} seq retries for project ${entry.projectId}`,
  );
}

// M4 ROUND 2 (review F1); numbers re-measured in round 3, multi-key re-decided in round 4 — every run
// quoted in m4-report ROUNDs 3/4. Round 1 shipped a journal-first shape (correlated EXISTS), so SQLite
// drove from journal_entries and probed the projection by entry_id (its PK autoindex):
// idx_journal_entry_files_lookup was never opened, and that shape measures 74.585 ms p50 for one key at
// 100,000 spread rows. Driving from journal_entry_files makes the lookup index the FIRST plan step
// (SEARCH f USING INDEX idx_journal_entry_files_lookup (project_id=? AND file_key=?)): the same one-key
// read measures 0.108 ms p50 through the real seam on that corpus — where the JSON-scan path this replaced
// still runs 17.373 ms p50 AND misses the target fact entirely (rows=0: it is older than the scan's
// 5,000-row window).
// M4 ROUND 4 (codex cross-family review r1-A, BLOCKING): rounds 2+3 wrapped per-key arms into ONE compound
// (UNION ALL + outer ORDER BY seq DESC LIMIT) and deduped AFTER the limit in JS. An entry touching several
// REQUESTED keys arrives once per key, so raw rows oversubscribed the budget and the outer cut landed on
// RAW rows: 313 newer entries each touching all 16 supported request files produced 313*16 = 5,008 raw
// rows and hid an older eligible fact entirely — reproduced at tip through the real seam as
// STARVATION {sqlRowsAfterDedupe:313, sqlContainsEligible:false} (2026-08-25 fresh build, this tree).
// Fix decided by MEASUREMENT, not assumption (probe kit E:/m0irai-ox/review/m4-tmp-r4/probe-shapes.mjs;
// every run below re-measured TODAY on that machine against the saved round-3 corpora + the starvation
// corpus): the budget now counts DEDUPLICATED candidates. Each requested key runs THIS statement alone —
// the exact round-2-pinned single-key plan — and the results merge newest-first in JS, dropping duplicate
// copies BEFORE any cut (S3 below). p50 ms, shape | k=1/k=2/k=4:
//   hot 100k rows : S0 tip UNION 14.207/17.362/18.677 | S1 SQL GROUP BY 23.718/23.086/22.945 | S3 22.579/18.944/18.497
//   hot 200k rows : S0 16.502/18.175/20.282           | S1 21.920/21.526/21.812          | S3 18.312/19.453/23.557
//   spread 100k   : S0 0.128/0.394/0.825              | S1 0.126/0.258/0.509             | S3 0.144/0.310/0.750
//   starve n=314, k=16: S0 27.698 ms len=313 eligible LOST | S1 11.217 len=314 RECALLED | S3 18.453 len=314 RECALLED
// S3 is the only measured shape that recalls the starved fact while staying within noise of the shipped
// UNION form on hot keys; identical rows in identical order everywhere the old shape was not already
// starving (eqS0=true on every hot/spread cell). The SQL-side alternative (outer GROUP BY entry_id before
// the limit) is correct on starve but pays a temp B-tree over the whole union on EVERY read — consistently
// ~20% worse than even the defect it would replace on hot corpora — and keeps the compound machinery.
// per-arm-only dedupe was rejected by reasoning (cross-key copies still consume budget); a fixed overscan
// factor was rejected because starvation survives it, just deeper (313 duplicating entries defeat any
// constant multiple of 5,000). One statement for every key count also dissolves round-3's recorded
// residual (R3-F2: the multi-key arm bound had a mutation path no test saw): there is now exactly ONE bind
// site for the bound, and the F7 output test pins its value.
// The plans are PINNED in journal-store.test.ts (F1 plans this statement; the r4 pin chains multi-key to
// it by identity and pins the DISTINCT-entry budget behaviorally), so a future shape regression fails a
// test instead of quietly costing recall or ~100 ms per prompt.
// ORDER BY f.seq DESC, not je.seq: the projection copies seq at INSERT and neither seq nor touched_files is
// ever UPDATEd afterwards (only superseded_by is — see supersede below), so f.seq equals je.seq for every
// row, while ordering on the projection side is the part the index can serve without a sort.
// Supersession is excluded HERE (je.superseded_by IS NULL) — the single source of truth for reads;
// supersede never touches projection rows itself. (Codex r1-B showed this leaves every superseded match
// to be joined-and-rejected before LIMIT can see an active row; the write-side fix — retired entries stop
// having projection rows AT ALL via the v21 cleanup trigger — lands in migrations-v21.ts this round, and
// THIS filter stays as the legacy defense for rows written before it.)
const READ_COLUMNS_SQL: string =
  "je.entry_id, je.project_id, je.category, je.author, je.agent, je.body, je.topic_key, " +
  "je.touched_files, je.domain_tags, je.anchor, je.superseded_by, je.seq, je.created_at ";
// THE statement: run once per requested file key (binds: projectId, fileKey, limit). Single source for
// readByFiles and the query-plan pins.
const READ_BY_FILES_SQL: string = `SELECT ${READ_COLUMNS_SQL}FROM journal_entry_files f JOIN journal_entries je ON je.entry_id = f.entry_id WHERE f.project_id = ? AND f.file_key = ? AND je.superseded_by IS NULL ORDER BY f.seq DESC LIMIT ?`;

// M4 ROUND 2 (review F7) — the bound. Unbounded, one hot file key materialised EVERY matching active row:
// measured 20,000 JournalRow objects and 28.9 MB of heap to produce the 8 pulls MAX_PULLS asks for.
// M4 ROUND 4: the cap counts DEDUPLICATED ENTRIES newest-first (an entry touching N requested keys costs
// ONE slot, not N), so the cut can only ever drop entries OLDER than the ones it keeps. It equals
// MAX_READ_LIMIT deliberately: the path this read replaced capped its candidate pool at 5,000 rows for the
// WHOLE project, so 5,000 distinct entries per requested file set is strictly more recall than before, and
// it leaves the router's rejection rules (own-agent, operator-authored, non decision/summary) plenty of
// slack against a MAX_PULLS of 8. Losing a real candidate needs 5,000 DISTINCT newer candidates on the
// very files the prompt named; codex's starvation needed only 313 entries duplicating across 16 keys.
const MAX_FILE_MATCH_ROWS = 5_000;

/** One pending per-key stream: the head peek plus the iterator the next pull comes from. */
interface ReadArm {
  iterator: Iterator<unknown>;
  head: IteratorResult<unknown>;
}

function armDone(arm: ReadArm): boolean {
  return arm.head.done === true;
}

// better-sqlite3 iterators yield unknown; every access decodes through here.
function armRow(arm: ReadArm): Record<string, unknown> {
  return arm.head.value as Record<string, unknown>;
}

// Pulls the next row from one arm, finalizing nothing — done() flips once the stream drains.
function advance(arm: ReadArm): void {
  arm.head = arm.iterator.next();
}

/**
 * M4: reads a project's ACTIVE entries whose projection carries any of fileKeys, newest seq first, over ALL
 * rows rather than a recency window — bounded by MAX_FILE_MATCH_ROWS newest DEDUPLICATED matches (round 4:
 * duplication across keys consumes one budget slot, not one per key). Fail-closed on a blank projectId (M3)
 * and on an empty file set (the router treats empty requestFiles as zero pulls anyway, matching the old
 * path where hasRequestedFile rejected every row). Rows decode through the same toJournalRow mapping as
 * readByProject.
 */
export function readByFiles(
  db: Db,
  projectId: string,
  fileKeys: ReadonlySet<string>,
): readonly JournalRow[] {
  if (projectId.trim().length === 0 || fileKeys.size === 0) {
    return [];
  }
  // One prepared statement PER KEY: better-sqlite3 refuses two concurrent iterations of one Statement,
  // and the streams interleave lazily so a full budget usually arrives before later arms drain.
  const arms = [...fileKeys].map((key) => {
    const iterator = db.prepare(READ_BY_FILES_SQL).iterate(projectId, key, MAX_FILE_MATCH_ROWS);
    return { iterator, head: iterator.next() };
  });
  try {
    return mergeNewestFirst(arms);
  } finally {
    // Early exit (budget reached) leaves live cursors; finalize them so a subsequent closeDb cannot
    // meet a busy connection (measured: better-sqlite3 iterators support .return()).
    for (const arm of arms) {
      if (!armDone(arm)) {
        arm.iterator.return?.(undefined);
      }
    }
  }
}

// The live arm whose head carries the NEWEST seq (undefined once every stream drained).
function newestArm(arms: readonly ReadArm[]): ReadArm | undefined {
  let best: ReadArm | undefined;
  for (const arm of arms) {
    if (armDone(arm)) continue;
    if (best === undefined || (armRow(arm).seq as number) > (armRow(best).seq as number)) {
      best = arm;
    }
  }
  return best;
}

// Consumes every arm whose head is ANOTHER copy of this same entry (the entry arrived once per key it
// touches), so copies never resurface on later iterations.
function skipEntryCopies(arms: readonly ReadArm[], entryId: string): void {
  for (const arm of arms) {
    if (!armDone(arm) && (armRow(arm).entry_id as string) === entryId) {
      advance(arm);
    }
  }
}

// K-way merge of the per-key seq DESC streams under the DISTINCT-entry budget. Ties cannot occur between
// DISTINCT entries (UNIQUE(project_id, seq), migrations-v15.ts:39); the only equal-seq heads are the
// copies of ONE entry arriving from several keys, and all of them advance together — the entry lands once,
// newest-first position preserved. Collapsing here rather than with a SQL GROUP BY is the measured choice
// of round 4 (table quoted above and in m4-report ROUND 4): grouping inside SQL pays a temp B-tree over
// the whole union before the limit, while this pass touches each merged row once and stops at the budget.
function mergeNewestFirst(arms: readonly ReadArm[]): readonly JournalRow[] {
  const seen = new Set<string>();
  const out: JournalRow[] = [];
  for (;;) {
    const best = newestArm(arms);
    if (best === undefined) {
      return out;
    }
    const entryId = armRow(best).entry_id as string;
    if (!seen.has(entryId)) {
      seen.add(entryId);
      out.push(toJournalRow(armRow(best)));
      if (out.length >= MAX_FILE_MATCH_ROWS) {
        return out;
      }
    }
    skipEntryCopies(arms, entryId);
  }
}

/**
 * The exact SQL readByFiles executes PER REQUESTED KEY (binds: projectId, fileKey, limit). Exported so the
 * QUERY PLAN can be pinned against the real statement text (journal-store.test.ts) instead of a copy of
 * it: round 1's defect was a query shape whose plan nobody had looked at. Since round 4 this is the ONLY
 * statement the read uses for ANY key count, so the F1 plan pin covers single- and multi-key alike.
 * Callers other than readByFiles and those pins have no reason to build this.
 */
export function buildReadByFilesSql(): string {
  return READ_BY_FILES_SQL;
}

/**
 * Reads a project's journal entries, newest seq first, fail-closed on a blank projectId (M3 — the
 * scoped-query discipline). Excludes superseded entries unless includeSuperseded is set.
 */
export function readByProject(
  db: Db,
  projectId: string,
  opts?: ReadOptions,
): readonly JournalRow[] {
  if (projectId.trim().length === 0) {
    return [];
  }
  const limit = Math.min(
    Math.max(1, Math.trunc(opts?.limit ?? DEFAULT_READ_LIMIT) || 1),
    MAX_READ_LIMIT,
  );
  const where = opts?.includeSuperseded === true ? "" : " AND superseded_by IS NULL";
  const rows = db
    .prepare(`SELECT * FROM journal_entries WHERE project_id = ?${where} ORDER BY seq DESC LIMIT ?`)
    .all(projectId, limit) as Record<string, unknown>[];
  return rows.map(toJournalRow);
}

/**
 * Links an entry to its replacement (J5 — visible supersession, never a silent delete). REFUSES to
 * auto-supersede an anchor (A1/A2): the refusal is returned AND recorded (a debug-gated conflict trace),
 * never silent. The explicit operator path passes allowAnchor to retire an anchor.
 */
export function supersede(
  db: Db,
  entryId: string,
  replacementId: string,
  opts?: SupersedeOptions,
): SupersedeResult {
  const row = db.prepare("SELECT anchor FROM journal_entries WHERE entry_id = ?").get(entryId) as
    | { anchor: number }
    | undefined;
  if (row === undefined) {
    return { ok: false, reason: `no journal entry ${entryId}` };
  }
  if (row.anchor === 1 && opts?.allowAnchor !== true) {
    emitTrace(opts?.trace, "conflict", `refused auto-supersede of anchor ${entryId}`);
    return {
      ok: false,
      reason: "anchor entries resist auto-supersession — remove them explicitly",
    };
  }
  db.prepare("UPDATE journal_entries SET superseded_by = ? WHERE entry_id = ?").run(
    replacementId,
    entryId,
  );
  emitTrace(opts?.trace, "journal", `superseded ${entryId} -> ${replacementId}`);
  return { ok: true };
}

// Emits a memory.trace ONLY when a bus is injected AND ZER0_DEBUG is on (O2: debug off = zero trace bytes).
// turn is 0 — journal writes are open/lifecycle events, not turn-scoped (feed-trace's turn-0 precedent).
function emitTrace(
  trace: MemoryTraceBus | undefined,
  phase: MemoryTracePhase,
  detail: string,
): void {
  if (trace === undefined || !debugEnabled()) {
    return;
  }
  trace.emit({ kind: "memory.trace", phase, turn: 0, detail });
}

function toJournalRow(row: Record<string, unknown>): JournalRow {
  return {
    entryId: row.entry_id as string,
    projectId: row.project_id as string,
    category: row.category as string,
    author: row.author as string,
    agent: (row.agent as string | null) ?? null,
    body: row.body as string,
    topicKey: (row.topic_key as string | null) ?? null,
    touchedFiles: parseTags(row.touched_files),
    domainTags: parseTags(row.domain_tags),
    anchor: row.anchor === 1,
    supersededBy: (row.superseded_by as string | null) ?? null,
    seq: row.seq as number,
    createdAt: row.created_at as string,
  };
}

function parseTags(value: unknown): readonly string[] | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? (parsed as string[]) : null;
}

// M4: ONLY the seq/entry_id collisions the J2 retry loop exists for are retryable — the extended
// codes SQLITE_CONSTRAINT_UNIQUE (2067) and SQLITE_CONSTRAINT_PRIMARYKEY (1555), names verified
// against https://www.sqlite.org/rescode.html and against live better-sqlite3 errors. The old
// startsWith("SQLITE_CONSTRAINT") matched EVERY constraint, so a CHECK/FK/NOT NULL violation burned
// all MAX_SEQ_RETRIES futile attempts before throwing. Any other failure now throws on attempt 1.
const RETRYABLE_SQLITE_CODES: ReadonlySet<string> = new Set([
  "SQLITE_CONSTRAINT_UNIQUE",
  "SQLITE_CONSTRAINT_PRIMARYKEY",
]);

function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Error) || !("code" in err)) {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && RETRYABLE_SQLITE_CODES.has(code);
}
