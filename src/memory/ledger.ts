/**
 * @file src/memory/ledger.ts
 * @purpose MT7 transactional project message sequence minting and bounded ledger walks.
 * @exports mintSeq, mintSeqInTransaction, getSeqForMessage, ledgerAfter, currentLedgerSeq
 * @depends ../evidence/db, ./carrier-budget
 */
import type { Db } from "../evidence/db.js";
import type { EntryBudget } from "./carrier-budget.js";

const EXISTING_SEQ_SQL = "SELECT seq FROM ledger_seq WHERE project_id = ? AND message_id = ?";
const NEXT_SEQ_SQL =
  "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM ledger_seq WHERE project_id = ?";
const INSERT_SEQ_SQL = "INSERT INTO ledger_seq(project_id, seq, message_id) VALUES (?, ?, ?)";
const CURRENT_SEQ_SQL =
  "SELECT COALESCE(MAX(seq), 0) AS current FROM ledger_seq WHERE project_id = ?";
const LEDGER_STATS_SQL =
  "SELECT COUNT(*) AS total, MIN(seq) AS firstSeq, MAX(seq) AS lastSeq FROM ledger_seq WHERE project_id = ? AND seq > ?";
const LEDGER_TAIL_SQL =
  "SELECT seq, message_id AS messageId FROM ledger_seq WHERE project_id = ? AND seq > ? ORDER BY seq DESC LIMIT ?";
const SESSION_LEDGER_STATS_SQL =
  "SELECT COUNT(*) AS total, MIN(l.seq) AS firstSeq, MAX(l.seq) AS lastSeq FROM ledger_seq l INNER JOIN chat_messages m ON m.id = l.message_id WHERE l.project_id = ? AND m.session_id = ? AND l.seq > ?";
const SESSION_LEDGER_TAIL_SQL =
  "SELECT l.seq, l.message_id AS messageId FROM ledger_seq l INNER JOIN chat_messages m ON m.id = l.message_id WHERE l.project_id = ? AND m.session_id = ? AND l.seq > ? ORDER BY l.seq DESC LIMIT ?";
// Bound: one immediate attempt plus eight SQLITE_BUSY retries, matching journal-store's J2 retry budget.
// Worst-case stall arithmetic (retro NIT): 9 attempts x busy_timeout 5000ms + backoffs 2550ms = 47.55s
// theoretical ceiling under a permanently-held write lock; realistic contention is micro-collisions.
const BUSY_BACKOFF_MS: readonly number[] = [10, 20, 40, 80, 160, 320, 640, 1280];

interface ExistingSeqRow {
  readonly seq: number;
}

interface NextSeqRow {
  readonly next: number;
}

/**
 * Durably maps an existing ChatMessage id to the next project-global seq. Idempotent re-mints return the
 * existing seq from the same table row. Message bodies are never read or copied here; T2 owns ledger walks.
 */
export function mintSeq(db: Db, projectId: string, messageId: string): number {
  const mint = db.transaction((): number => mintSeqOnce(db, projectId, messageId));
  for (let attempt = 0; attempt <= BUSY_BACKOFF_MS.length; attempt += 1) {
    try {
      return mint.immediate();
    } catch (err) {
      if (!isBusyError(err) || attempt === BUSY_BACKOFF_MS.length) {
        throw err;
      }
      sleepSync(BUSY_BACKOFF_MS[attempt] ?? 0);
    }
  }
  throw new Error(`ledger seq mint exhausted busy retries for project ${projectId}`);
}

/**
 * Mints a seq for a caller ALREADY inside a db.transaction() on the SAME handle — E4 (B2-b1). The outer
 * transaction.immediate() already holds the file's write lock, so a nested mint can NEVER be SQLITE_BUSY;
 * wrapping it in {@link mintSeq}'s own retrying transaction would add a redundant savepoint AND expose the
 * ~47s busy-retry stall ceiling on the render process for a lock that is already held. This is the raw mint
 * (no transaction wrapper, no retry) — it participates in the CALLER's transaction, rolling back with it.
 * ONLY call from inside an open transaction on `db`; a standalone caller must use {@link mintSeq}.
 */
export function mintSeqInTransaction(db: Db, projectId: string, messageId: string): number {
  return mintSeqOnce(db, projectId, messageId);
}

/** Reads the durable seq for a message id, or undefined when that message was not minted in the project. */
export function getSeqForMessage(db: Db, projectId: string, messageId: string): number | undefined {
  const row = db.prepare(EXISTING_SEQ_SQL).get(projectId, messageId) as ExistingSeqRow | undefined;
  return row?.seq;
}

/**
 * THE BOUNDARY WAVE: the project's current ledger high-water-mark — the seq a caller threads as
 * `sessionBoundarySeq` into composeDelta/composeCarrierPrompt (delta-composer.ts) so an entry
 * already in the ledger AT THIS READ is later reclassified untrusted instead of unconditionally
 * trusted. 0 for a project with no ledger activity yet (a fresh project's first-ever session; also
 * the correct answer for an id that was never seeded — no row means no activity, not an error).
 */
export function currentLedgerSeq(db: Db, projectId: string): number {
  const row = db.prepare(CURRENT_SEQ_SQL).get(projectId) as { readonly current: number };
  return row.current;
}

function mintSeqOnce(db: Db, projectId: string, messageId: string): number {
  const existing = getSeqForMessage(db, projectId, messageId);
  if (existing !== undefined) {
    return existing;
  }
  const next = (db.prepare(NEXT_SEQ_SQL).get(projectId) as NextSeqRow).next;
  db.prepare(INSERT_SEQ_SQL).run(projectId, next, messageId);
  return next;
}

function isBusyError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const code = (err as Error & { code?: unknown }).code;
  return typeof code === "string" && (code.startsWith("SQLITE_BUSY") || code === "SQLITE_LOCKED");
}

function sleepSync(ms: number): void {
  const lock = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(lock, 0, 0, ms);
}

export interface LedgerEntry {
  readonly seq: number;
  readonly messageId: string;
  readonly author: string;
  readonly body: string;
}

export type LedgerBodyReader = (messageId: string) => {
  readonly author: string;
  readonly body: string;
};

export type LedgerOverflowInfo =
  | {
      readonly pending: false;
      readonly skippedCount: 0;
      readonly deliveredCount: number;
      readonly deliveredFromSeq?: number;
      readonly deliveredToSeq?: number;
    }
  | {
      readonly pending: true;
      readonly skippedCount: number;
      readonly skippedFromSeq: number;
      readonly skippedToSeq: number;
      readonly deliveredCount: number;
      readonly deliveredFromSeq?: number;
      readonly deliveredToSeq?: number;
    };

export interface LedgerAfterResult {
  readonly entries: readonly LedgerEntry[];
  readonly overflow: LedgerOverflowInfo;
}

interface LedgerStatsRow {
  readonly total: number;
  readonly firstSeq: number | null;
  readonly lastSeq: number | null;
}

interface LedgerSeqRow {
  readonly seq: number;
  readonly messageId: string;
}

export function ledgerAfter(
  db: Db,
  projectId: string,
  sinceSeq: number,
  budgets: EntryBudget & { readonly sessionId?: string },
  readBody: LedgerBodyReader,
): LedgerAfterResult {
  const cursor = nonNegativeLedgerInteger(sinceSeq);
  const maxMessages = nonNegativeLedgerInteger(budgets.maxMessages);
  const maxBytes = nonNegativeLedgerInteger(budgets.maxBytes);
  const stats = readLedgerStats(db, projectId, cursor, budgets.sessionId);
  const candidates = readTailCandidates(db, projectId, cursor, {
    maxMessages,
    readBody,
    ...(budgets.sessionId === undefined ? {} : { sessionId: budgets.sessionId }),
  });
  const entries = selectTailWithinBytes(candidates, maxBytes);
  return { entries, overflow: overflowFor(stats, entries) };
}

function readLedgerStats(
  db: Db,
  projectId: string,
  sinceSeq: number,
  sessionId: string | undefined,
): LedgerStatsRow {
  return sessionId === undefined
    ? (db.prepare(LEDGER_STATS_SQL).get(projectId, sinceSeq) as LedgerStatsRow)
    : (db.prepare(SESSION_LEDGER_STATS_SQL).get(projectId, sessionId, sinceSeq) as LedgerStatsRow);
}

function readTailCandidates(
  db: Db,
  projectId: string,
  sinceSeq: number,
  input: {
    readonly maxMessages: number;
    readonly readBody: LedgerBodyReader;
    readonly sessionId?: string;
  },
): LedgerEntry[] {
  if (input.maxMessages === 0) {
    return [];
  }
  const rows = (
    input.sessionId === undefined
      ? db.prepare(LEDGER_TAIL_SQL).all(projectId, sinceSeq, input.maxMessages)
      : db
          .prepare(SESSION_LEDGER_TAIL_SQL)
          .all(projectId, input.sessionId, sinceSeq, input.maxMessages)
  ) as LedgerSeqRow[];
  return rows
    .reverse()
    .map((row) => ({ seq: row.seq, messageId: row.messageId, ...input.readBody(row.messageId) }));
}

function selectTailWithinBytes(
  entries: readonly LedgerEntry[],
  maxBytes: number,
): readonly LedgerEntry[] {
  let usedBytes = 0;
  const delivered: LedgerEntry[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) {
      continue;
    }
    const nextBytes = usedBytes + Buffer.byteLength(entry.body, "utf8");
    if (nextBytes > maxBytes) {
      break;
    }
    usedBytes = nextBytes;
    delivered.unshift(entry);
  }
  return delivered;
}

function overflowFor(stats: LedgerStatsRow, entries: readonly LedgerEntry[]): LedgerOverflowInfo {
  const deliveredCount = entries.length;
  const skippedCount = stats.total - deliveredCount;
  const deliveredBounds = deliveredSeqBounds(entries);
  if (skippedCount <= 0) {
    return { pending: false, skippedCount: 0, deliveredCount, ...deliveredBounds };
  }
  return {
    pending: true,
    skippedCount,
    skippedFromSeq: stats.firstSeq ?? 0,
    skippedToSeq:
      deliveredBounds.deliveredFromSeq === undefined
        ? (stats.lastSeq ?? 0)
        : deliveredBounds.deliveredFromSeq - 1,
    deliveredCount,
    ...deliveredBounds,
  };
}

function deliveredSeqBounds(entries: readonly LedgerEntry[]): {
  readonly deliveredFromSeq?: number;
  readonly deliveredToSeq?: number;
} {
  if (entries.length === 0) {
    return {};
  }
  const first = entries[0];
  const last = entries[entries.length - 1];
  if (first === undefined || last === undefined) {
    return {};
  }
  return { deliveredFromSeq: first.seq, deliveredToSeq: last.seq };
}

function nonNegativeLedgerInteger(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError("ledger budget values must be finite");
  }
  return Math.max(0, Math.trunc(value));
}
