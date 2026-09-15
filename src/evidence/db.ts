/**
 * @file src/evidence/db.ts
 * @purpose Opens better-sqlite3 with WAL + busy_timeout + applies schema migrations idempotently.
 * @exports openDb, openMemoryDb, openLaneStateDb, Db, closeDb
 * @depends better-sqlite3, node:fs, node:path, ../shared/error-codes, ../shared/errors, ../shared/logger, ./db-drift, ./migration-readiness, ./migration-tiers, ./migrations-v21
 *
 * W3 (THE GREAT DELETION, 2026-07-17) — DB TOMBSTONE-VS-TOLERANCE CONTRACT (referee CONCERN 1):
 * openReviewDb, applyReviewMigration, and the migrations-v17/v18/v19 producer files are DELETED —
 * once driver-boot.ts's and loop-boot.ts's own misuse (opening the full review/write-gate tier just
 * to reach the evidence ledger) was fixed to call openLaneStateDb/openMemoryDb instead, NOTHING in
 * `src/**` produces or reads the review_checkpoints/review_deltas/review_groups/review_files/
 * review_hunks/review_redirects/write_leases/write_queue tables anymore — keeping the producer
 * around would be exactly the "dormant seam" D1 bans, and it would keep UNCONDITIONALLY recreating
 * that whole schema tier on every call, the opposite of deletion.
 * TOLERANCE, not deletion, is the choice for the ACCEPT side: GLOBAL_VERSION_KEYS/
 * MEMORY_VERSION_KEYS/LANE_VERSION_KEYS below still include REVIEW_KEY/REVIEW_GROUP_KEY/
 * REVIEW_SUMMARY_KEY, unchanged. This is a pure DATA contract (a `_schema_version` row-set an opener
 * accepts without throwing), never a code path that reads or writes the physical tables — so an
 * existing dogfood DB that already carries those tables boots clean via openDb/openMemoryDb/
 * openLaneStateDb (F4's own falsifier), while the tables themselves sit inert on disk, never
 * recreated (no producer exists to recreate them) and never read (no query anywhere targets them —
 * see db-review-tier-tolerance.test.ts for the falsifiable proof). A DB that never had the review
 * tier is equally unaffected: none of the three surviving openers ever migrates a DB INTO that tier.
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { Zer0ErrorCode } from "../shared/error-codes.js";
import { ConfigError } from "../shared/errors.js";
import { createLogger } from "../shared/logger.js";
import { detectIncompatibleSchema } from "./db-drift.js";
import { type AcceptedVersionKeys, chainReadiness } from "./migration-readiness.js";
import { runGlobalTier, runLaneTier, runMemoryTier } from "./migration-tiers.js";
import type { FileProjectionStepResult } from "./migrations-v21.js";

// The global chain's target version is unchanged. Memory adds 15; lane state adds 16; scoped lane state
// adds 20. Versions 17-19 remain tolerated review-tier history and are never produced by current code.
// See migrations-v15.ts, migrations-v16.ts, and migrations-v20.ts. REVIEW_SCHEMA_VERSION/
// REVIEW_GROUP_SCHEMA_VERSION/REVIEW_SUMMARY_SCHEMA_VERSION (17/18/19) name the diff-HERO review +
// write-gate tier a pre-W3 DB may already carry; W3 (THE GREAT DELETION, 2026-07-17) deleted the
// producer (openReviewDb/applyReviewMigration/migrations-v17.ts/migrations-v18.ts/migrations-v19.ts
// — see this file's own header) but keeps these three version numbers as TOLERATED, never-produced
// history so an existing dogfood DB at that tier still boots clean (F4).
const EXPECTED_SCHEMA_VERSION: number = 14;
const MEMORY_SCHEMA_VERSION: number = 15;
const LANE_SCHEMA_VERSION: number = 16;
const REVIEW_SCHEMA_VERSION: number = 17;
const REVIEW_GROUP_SCHEMA_VERSION: number = 18;
const REVIEW_SUMMARY_SCHEMA_VERSION: number = 19;
const LANE_SCOPE_SCHEMA_VERSION: number = 20;
// M4: journal_entry_files rides the MEMORY chain as version 21 (journal_entries exists from v15 and
// appendEntry writes on every memory-on DB regardless of carrier state). See migrations-v21.ts.
const FILE_PROJECTION_SCHEMA_VERSION: number = 21;
const MEMORY_KEY = `${EXPECTED_SCHEMA_VERSION},${MEMORY_SCHEMA_VERSION}`;
const LANE_KEY = `${MEMORY_KEY},${LANE_SCHEMA_VERSION}`;
const REVIEW_KEY = `${LANE_KEY},${REVIEW_SCHEMA_VERSION}`;
const REVIEW_GROUP_KEY = `${REVIEW_KEY},${REVIEW_GROUP_SCHEMA_VERSION}`;
const REVIEW_SUMMARY_KEY = `${REVIEW_GROUP_KEY},${REVIEW_SUMMARY_SCHEMA_VERSION}`;
const LANE_SCOPE_KEY = `${LANE_KEY},${LANE_SCOPE_SCHEMA_VERSION}`;
const REVIEW_LANE_SCOPE_KEY = `${REVIEW_KEY},${LANE_SCOPE_SCHEMA_VERSION}`;
const REVIEW_GROUP_LANE_SCOPE_KEY = `${REVIEW_GROUP_KEY},${LANE_SCOPE_SCHEMA_VERSION}`;
const REVIEW_SUMMARY_LANE_SCOPE_KEY = `${REVIEW_SUMMARY_KEY},${LANE_SCOPE_SCHEMA_VERSION}`;
// The base sets a pre-M4 open could produce; the accepted lists below derive from these instead of
// hand-writing 13 `,21` strings.
const MEMORY_BASE_KEYS: readonly string[] = [
  MEMORY_KEY,
  LANE_KEY,
  REVIEW_KEY,
  REVIEW_GROUP_KEY,
  REVIEW_SUMMARY_KEY,
  LANE_SCOPE_KEY,
  REVIEW_LANE_SCOPE_KEY,
  REVIEW_GROUP_LANE_SCOPE_KEY,
  REVIEW_SUMMARY_LANE_SCOPE_KEY,
];
const LANE_BASE_KEYS: readonly string[] = [
  LANE_SCOPE_KEY,
  REVIEW_LANE_SCOPE_KEY,
  REVIEW_GROUP_LANE_SCOPE_KEY,
  REVIEW_SUMMARY_LANE_SCOPE_KEY,
];
function withVersion(keys: readonly string[], version: number): readonly string[] {
  return keys.map((key) => `${key},${version}`);
}
// The exact `_schema_version` row-sets each open mode accepts (versions joined ascending). EVERY mode
// accepts the sets a LATER lazy migration may have produced (a lane- or review-migrated DB opened by the
// global/memory/lane path must never read as drift — the openers never migrate anything away); each
// scoped open additionally REQUIRES its own version present, which its apply* guarantees. The REVIEW_KEY/
// REVIEW_GROUP_KEY/REVIEW_SUMMARY_KEY entries below are the W3 tolerance contract (this file's own
// header): no opener produces them anymore, but a real pre-W3 db already at one of those tiers must
// never read as drift.
// M4 contract: memoryComplete/laneComplete are TRUE only for the `,21` variants (the un-suffixed bases
// REMOVED from those two lists — otherwise an un-projected DB would read complete and v21 would never
// run), while GLOBAL keeps every pre-M4 set because openDb never runs the memory segment and a memory DB
// it meets must stay tolerated, not drift.
const GLOBAL_VERSION_KEYS: readonly string[] = [
  `${EXPECTED_SCHEMA_VERSION}`,
  ...MEMORY_BASE_KEYS,
  ...withVersion(MEMORY_BASE_KEYS, FILE_PROJECTION_SCHEMA_VERSION),
];
const MEMORY_VERSION_KEYS: readonly string[] = withVersion(
  MEMORY_BASE_KEYS,
  FILE_PROJECTION_SCHEMA_VERSION,
);
const LANE_VERSION_KEYS: readonly string[] = withVersion(
  LANE_BASE_KEYS,
  FILE_PROJECTION_SCHEMA_VERSION,
);
// FL-077: the tolerance contract the opener enforces — handed to chainReadiness so an open can
// prove the database is ALREADY fully migrated and skip every write in the steady state, and to
// the locked tier validations (migration-tiers.ts) whenever a tier actually runs.
const ACCEPTED_VERSION_KEYS: AcceptedVersionKeys = {
  global: GLOBAL_VERSION_KEYS,
  memory: MEMORY_VERSION_KEYS,
  lane: LANE_VERSION_KEYS,
};
/**
 * The `_schema_version` key a LANE open lands on when current code does every tier it owns — the
 * carrier's target, and the most expensive migration a first boot of a project runs.
 *
 * Exported READ-ONLY and for one purpose: the room host names it in the boot-progress stage the
 * terminal shows while that migration is running (`room-boot-stages.ts`). It is derived from the same
 * constants the accepted-key lists are, so it cannot drift from what an open actually produces; nothing
 * validates against it and nothing migrates toward it.
 */
export const LANE_TARGET_VERSION_KEY: string = `${LANE_SCOPE_KEY},${FILE_PROJECTION_SCHEMA_VERSION}`;
const BUSY_TIMEOUT_MS: number = 5_000;
const WAL_MODE: string = "WAL";
const FOREIGN_KEYS_ON: string = "ON";
const FOREIGN_KEYS_ENABLED_VALUE: string = "1";
const JOURNAL_MODE_PRAGMA: string = "journal_mode = WAL";
const BUSY_TIMEOUT_PRAGMA: string = `busy_timeout = ${BUSY_TIMEOUT_MS}`;
const FOREIGN_KEYS_PRAGMA: string = "foreign_keys = ON";
const EMPTY_DB_PATH_MESSAGE: string = "dbPath must be a non-empty string";
const logger = createLogger();

/** Open better-sqlite3 database handle used by the evidence layer. */
export type Db = Database.Database;

/** Which schema contract an open enforces: the global v14 floor, the memory unit's lazy v15, or the
 *  carrier's lazy v16 lane tables plus v20 room scope. (The diff-HERO review + write-gate "review" mode was deleted in
 *  W3 — see this file's own header for the tombstone-vs-tolerance contract.) */
type OpenMode = "global" | "memory" | "lane";

interface DbPathConfig {
  dbPath: string;
}

/**
 * Opens an evidence SQLite database and applies the canonical schema.
 *
 * @param config - database path string or config object carrying dbPath
 * @param signal - optional cancellation signal checked before disk and schema work
 * @returns open better-sqlite3 database handle with WAL, busy timeout, and FKs enabled
 * @throws ConfigError when the database path is invalid or schema version drifts
 * @example
 * const db = openDb({ dbPath: ".zer0/evidence.db" });
 */
export function openDb(config: string | DbPathConfig, signal?: AbortSignal): Db {
  return openWithMode(config, "global", signal);
}

/**
 * Opens the evidence DB for the MEMORY-FULL feature: runs the global chain to v14 AND the LAZY v15 memory
 * migration (applyMemoryMigration), landing at {14,15,21} — 21 is M4's file-projection step, riding the
 * SAME memory tier (see migrations-v21.ts). The gate that distinguishes memory-on from
 * memory-off lives HERE (the caller decides which opener to use per the ZER0_MEMORY flag), never in the
 * global open — so a memory-off session's DB is never migrated (AC5). Idempotent: reopening stays
 * {14,15,21}.
 *
 * @param config - database path string or config object carrying dbPath
 * @param signal - optional cancellation signal checked before disk and schema work
 * @returns open database handle migrated to the v15 memory schema plus the v21 file projection
 * @throws ConfigError when the database path is invalid or schema version drifts from an accepted set
 *   (since M4 EVERY accepted set carries version 21: {14,15,21}, {14,15,16,21}, {14,15,16,17,21},
 *   {14,15,16,17,18,21}, {14,15,16,17,18,19,21}, {14,15,16,20,21} and its {...,17}/{...,18}/
 *   {...,19} review-tier variants — a pre-M4 DB without 21 is MIGRATED to it here, never read as
 *   drift; the {...,17}/{...,18}/{...,19} tiers are W3 tolerance-only, see this file's own header)
 * @example
 * const db = openMemoryDb({ dbPath: ".zer0/evidence.db" });
 */
export function openMemoryDb(config: string | DbPathConfig, signal?: AbortSignal): Db {
  return openWithMode(config, "memory", signal);
}

/**
 * Opens the evidence DB for the carrier: the global chain + lazy v15 memory (which since M4 also lands
 * version 21), v16 lane state, and v20 lane-scope migrations, landing at {14,15,16,20,21}. Every call
 * site sits behind the COMPOSED gate
 * `carrierEnabled()` (memory AND resume — I-6), so neither flag alone ever migrates anything; this opener
 * itself stays flag-free like its siblings. The returned HANDLE additionally carries the hot-path pragma
 * profile from the 2026-07-09 DB consult (synchronous=NORMAL, temp_store=MEMORY, cache_size=-20000) —
 * per-connection settings that never affect other handles on the same file.
 *
 * @param config - database path string or config object carrying dbPath
 * @param signal - optional cancellation signal checked before disk and schema work
 * @returns open database handle migrated to the v20 scoped lane-state schema plus the v21 file projection
 * @throws ConfigError when the database path is invalid or schema version drifts from an accepted set
 *   (since M4 EVERY accepted set carries version 21: {14,15,16,20,21}, {14,15,16,17,20,21},
 *   {14,15,16,17,18,20,21}, or {14,15,16,17,18,19,20,21} — a pre-M4 DB without 21 is MIGRATED to it
 *   by the memory tier before the lane tier runs, never read as drift; the {...,17}/{...,18}/
 *   {...,19} tiers are W3 tolerance-only, see this file's own header)
 * @example
 * const db = openLaneStateDb({ dbPath: ".zer0/evidence.db" });
 */
export function openLaneStateDb(config: string | DbPathConfig, signal?: AbortSignal): Db {
  return openWithMode(config, "lane", signal);
}

// FL-077 — the open path is split at a read-only steady-state check:
//   1. Read schema/version state (chainReadiness — no writes; strict storage-class validation of
//      every _schema_version row happens HERE, before any write this process could make).
//   2. Steady state: return WITHOUT executing any write statement, so an open succeeds instantly
//      even while another connection holds the writer lock.
//   3. Otherwise run exactly the incomplete tiers (migration-tiers.ts): each is ONE outer BEGIN
//      IMMEDIATE that re-reads readiness UNDER the writer lock, runs its chain (whose per-step
//      wrappers degrade to savepoints inside the outer transaction), validates the version key
//      INSIDE the lock, and commits — so intermediate states are invisible to other connections
//      and a stale opener converges with zero writes instead of racing (FL-077 round 3, codex r2
//      finding 1; the old unlocked post-chain assertion is DELETED — it was the spurious-drift
//      defect). Contention waits on the busy handler inside BEGIN IMMEDIATE instead of failing a
//      deferred read→write upgrade (FL-074's measured 3 ms throw).
//
// WHAT THIS DELIBERATELY GIVES UP (FL-077 round 2, review finding 4): before this split, every
// open re-ran schema.sql, so a table or index deleted out from under a migrated database was
// silently recreated on the next open. It is not anymore — `chainReadiness` reports the tier
// complete, the tier bodies are skipped, the locked version-key validation still passes (the
// version rows are intact), and the damage surfaces later as `no such table` / a missing index at
// query time. db-steady-state-no-repair.test.ts pins that, and it pins it as a `chainReadiness`
// boundary rather than as "we stopped running schema.sql" — which is what makes the next paragraph
// a refinement of this decision instead of a contradiction of it.
//
// WHAT DOES STILL REPAIR, AND WHY THAT IS NOT A REGRESSION (M4 rebase round 2, review R5-F1). The
// blanket claim that used to stand here — "that implicit self-repair is NOT coming back", bounded by
// "schema.sql being frozen" — is FALSE as written, and it was false the moment M4 merged. Exactly
// four objects repair, all four owned by the v21 migration and none of them in schema.sql, so the
// old bound never covered them: journal_entry_files, idx_journal_entry_files_lookup,
// journal_entry_files_after_insert and journal_entry_files_supersede_cleanup.
//   WHEN: only a memory-mode or lane-mode open, and only when `chainReadiness` finds one of those
//   four drifted in any of the three ways migrations-v21.ts distinguishes — MISSING from
//   sqlite_master, present under the name but the WRONG TYPE, or carrying a BODY other than the one
//   that module defines (migration-readiness.ts's `fileProjectionObjectsPresent` conjunct). A
//   healthy database still
//   takes the zero-write path; the steady-state contract above is intact, and the byte-identical
//   reopen pin in migrations-v21.test.ts holds it there.
//   WHY IT IS SAFE, established by measurement rather than by argument (review r5, PROBE A and
//   PROBE B): the repair runs inside runMemoryTier's single BEGIN IMMEDIATE, it re-derives every
//   projection row from journal_entries, and it is all-or-nothing — a 50-row adversarial fixture
//   came out row-identical, and a forced rollback restored the drifted table WITH its rows rather
//   than leaving a version-21 row over an empty projection.
//   WHY IT EARNS THE WRITE, where schema.sql's tables did not: a missing schema.sql table fails
//   loudly at query time as `no such table`. A missing v21 TRIGGER fails SILENTLY — appends stop
//   projecting and recall misses facts that are still in the journal, with no error anywhere
//   (codex r1-C, reproduced again through a same-name body in review R4-F1). Silence is what buys
//   the exception.
//   AND IT IS NOT SILENT TO THE OPERATOR: every repair is logged by object name and reason once the
//   tier has committed — see logFileProjectionRepair below (review R5-F6).
function openWithMode(config: string | DbPathConfig, mode: OpenMode, signal?: AbortSignal): Db {
  signal?.throwIfAborted();
  const dbPath = resolveDbPath(config);
  ensureParentDirectory(dbPath);
  const db = new Database(dbPath);
  try {
    applyPragmas(db);
    signal?.throwIfAborted();
    detectIncompatibleSchema(db);
    const readiness = chainReadiness(db, ACCEPTED_VERSION_KEYS);
    if (!readiness.globalComplete) {
      runGlobalTier(db, ACCEPTED_VERSION_KEYS);
    }
    if ((mode === "memory" || mode === "lane") && !readiness.memoryComplete) {
      logFileProjectionBackfill(db, runMemoryTier(db, ACCEPTED_VERSION_KEYS));
    }
    if (mode === "lane") {
      if (!readiness.laneComplete) {
        runLaneTier(db, ACCEPTED_VERSION_KEYS);
      }
      applyLanePragmas(db);
    }
    logger.debug({ phase: "evidence" }, "database opened", { dbPath, mode });
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

// M4 rebase item 2 (M5 review r3b FINDING 4). The v21 backfill's counts used to be logged inside
// applyMemoryMigration, whose `.immediate()` degrades to a SAVEPOINT under runMemoryTier's outer
// BEGIN IMMEDIATE — the reviewer's probe caught the line claiming "backfill committed; rows=7" with
// `db.inTransaction === true`, after which the tier's locked validation threw and rolled the file
// back to {14} with no journal_entries table at all. The counts now arrive here, AFTER
// runMemoryTier returned, i.e. after its COMMIT. The `db.inTransaction` branch keeps that claim
// derived from an observable rather than from the call graph: if this ever runs nested (an opener
// invoked inside someone else's transaction), the counts are still reported but NOT as committed.
function logFileProjectionBackfill(db: Db, projection: FileProjectionStepResult): void {
  logProjectionObjects(
    db,
    projection.repairedObjects,
    "journal_entry_files objects were drifted and have been rebuilt from the v21 migration",
    "journal_entry_files objects rebuilt inside an OPEN transaction; this repair is NOT committed yet",
  );
  logProjectionObjects(
    db,
    projection.displacedObjects,
    "objects already occupying journal_entry_files names were DROPPED so the v21 migration could create its own",
    "objects already occupying journal_entry_files names were DROPPED inside an OPEN transaction; NOT committed yet",
  );
  if (projection.backfilledRows === 0 && projection.skippedRows === 0) {
    return;
  }
  const counts = {
    backfilledRows: projection.backfilledRows,
    skippedRows: projection.skippedRows,
  };
  if (db.inTransaction) {
    logger.warn(
      { phase: "evidence" },
      "journal_entry_files backfill counted inside an OPEN transaction; these rows are NOT committed yet",
      counts,
    );
    return;
  }
  // One-shot: a skipped row is skipped for good (migrations-v21.ts header says why), so the count
  // is named here rather than left as a bare number.
  logger.debug(
    { phase: "evidence" },
    "journal_entry_files backfill committed; skipped rows are not re-examined by later opens",
    counts,
  );
}

// M4 rebase round 2 (review R5-F6), extended in round 3 (review R6-F3). Two different structural
// writes reach here and each gets its own sentence, because they are different news:
//   REPAIRED — a v21 object was missing, replaced, or the wrong kind of object on a database that
//   already carried version 21. The headline case writes NO rows (a dropped TRIGGER over an intact
//   TABLE, where the backfill's INSERT OR IGNORE finds everything already present), so before R5-F6
//   the operator's database had four schema objects rebuilt under a writer lock with nothing but
//   "database opened" in the log.
//   DISPLACED — something was already standing under a v21 name on a database that had never reached
//   version 21, and was DROPPED to make room. That is the destructive one, and R6-F3 caught it still
//   silent because the first-migration branch suppressed the repair line for it.
// The object names and the reason are what make either line useful. Same debug level and the same
// after-COMMIT discipline as the backfill line: `db.inTransaction` means nothing is on disk yet, so
// the message says so instead of claiming a write that a rollback could still take back.
function logProjectionObjects(
  db: Db,
  objects: readonly string[],
  committedMessage: string,
  pendingMessage: string,
): void {
  if (objects.length === 0) {
    return;
  }
  const detail = { objects: [...objects] };
  if (db.inTransaction) {
    logger.warn({ phase: "evidence" }, pendingMessage, detail);
    return;
  }
  logger.debug({ phase: "evidence" }, committedMessage, detail);
}

/**
 * Closes an open evidence database handle.
 *
 * @param db - open database handle returned by openDb
 * @returns void after the handle is closed or already closed
 * @throws ConfigError when better-sqlite3 rejects close
 * @example
 * const db = openDb(".zer0/evidence.db");
 * closeDb(db);
 */
export function closeDb(db: Db): void {
  if (!db.open) {
    return;
  }
  try {
    db.close();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const message = `Failed to close evidence database: ${reason}`;
    throw new ConfigError(message, Zer0ErrorCode.ConfigInvalid, { cause: err });
  }
}

function resolveDbPath(config: string | DbPathConfig): string {
  const dbPath = typeof config === "string" ? config : config.dbPath;
  if (dbPath.trim().length === 0) {
    throw new ConfigError(EMPTY_DB_PATH_MESSAGE, Zer0ErrorCode.ConfigInvalid);
  }
  return dbPath;
}

function ensureParentDirectory(dbPath: string): void {
  const parent = dirname(dbPath);
  if (parent.length === 0) {
    return;
  }
  try {
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
      return;
    }
    if (!statSync(parent).isDirectory()) {
      const message = `Database parent path "${parent}" exists but is not a directory`;
      throw new ConfigError(message, Zer0ErrorCode.ConfigInvalid);
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      throw err;
    }
    const reason = err instanceof Error ? err.message : String(err);
    const message = `Failed to create database parent directory "${parent}": ${reason}`;
    throw new ConfigError(message, Zer0ErrorCode.ConfigInvalid, { cause: err });
  }
}

function applyPragmas(db: Db): void {
  const journalMode = String(db.pragma(JOURNAL_MODE_PRAGMA, { simple: true }));
  if (journalMode.toUpperCase() !== WAL_MODE) {
    const message = `Failed to set SQLite journal_mode=${WAL_MODE}`;
    throw new ConfigError(message, Zer0ErrorCode.ConfigInvalid);
  }
  db.pragma(BUSY_TIMEOUT_PRAGMA);
  db.pragma(FOREIGN_KEYS_PRAGMA);
  const foreignKeys = String(db.pragma("foreign_keys", { simple: true }));
  if (foreignKeys !== FOREIGN_KEYS_ENABLED_VALUE) {
    const message = `Failed to set SQLite foreign_keys=${FOREIGN_KEYS_ON}`;
    throw new ConfigError(message, Zer0ErrorCode.ConfigInvalid);
  }
}

// The lane HANDLE's hot-path profile (2026-07-09 DB consult): per-connection pragmas only — they change
// nothing for other handles on the same file. synchronous=NORMAL is the WAL-safe latency setting for the
// turn-critical cursor/attempt commits; temp_store=MEMORY avoids temp-file churn on ORDER BY work;
// cache_size=-20000 (~20MB) keeps briefing-scale reads off the disk. Each is read back — a pragma that
// silently failed to apply would void the profile the carrier's latency arithmetic assumes.
function applyLanePragmas(db: Db): void {
  db.pragma("synchronous = NORMAL");
  db.pragma("temp_store = MEMORY");
  db.pragma("cache_size = -20000");
  const applied = {
    synchronous: Number(db.pragma("synchronous", { simple: true })),
    tempStore: Number(db.pragma("temp_store", { simple: true })),
    cacheSize: Number(db.pragma("cache_size", { simple: true })),
  };
  if (applied.synchronous !== 1 || applied.tempStore !== 2 || applied.cacheSize !== -20000) {
    const message = `Failed to apply lane-handle pragmas (synchronous=${applied.synchronous}, temp_store=${applied.tempStore}, cache_size=${applied.cacheSize})`;
    throw new ConfigError(message, Zer0ErrorCode.ConfigInvalid);
  }
}
