/**
 * @file src/evidence/migration-readiness.ts
 * @purpose FL-077 round 3: the STRICT read-only readiness probe behind every opener — reads
 *   `_schema_version` with SQLite typeof() so a non-integer storage class (a TEXT "14,15"
 *   impersonating the accepted memory set, an integral REAL, NULL, BLOB) throws
 *   EvidenceSchemaDrift BEFORE any migration write, then reports per-tier completeness.
 * @exports AcceptedVersionKeys, ChainReadiness, chainReadiness, columnExists,
 *   ColumnDefinition, LANE_PROMPT_ATTEMPT_ABORTED_COLUMN
 * @depends better-sqlite3, ../shared/error-codes, ../shared/errors, ./migrations-v21
 */
import type { Database } from "better-sqlite3";
import { Zer0ErrorCode } from "../shared/error-codes.js";
import { ConfigError } from "../shared/errors.js";
import { fileProjectionObjectsPresent } from "./migrations-v21.js";

/** An opened better-sqlite3 database handle (structural twin of db.ts's `Db`). */
export type OpenedDatabase = Database;

export interface ColumnDefinition {
  table: string;
  name: string;
  definition: string;
}

// FL-077 acceptance 3: fl150 added aborted_at INSIDE applyLaneStateMigration with NO version
// bump, so an accepted version set alone proves nothing about a lane DB. Lives here (not in
// migrations.ts) because BOTH sides need it: chainReadiness probes the physical column, and
// applyLaneStateMigration adds it — one constant, two consumers, no drift between them.
export const LANE_PROMPT_ATTEMPT_ABORTED_COLUMN: ColumnDefinition = {
  table: "lane_prompt_attempts",
  name: "aborted_at",
  definition: "aborted_at TEXT",
};

export interface AcceptedVersionKeys {
  readonly global: readonly string[];
  readonly memory: readonly string[];
  readonly lane: readonly string[];
}

export interface ChainReadiness {
  /** The global chain (applySchema + applyMigrations) has nothing left to do. */
  readonly globalComplete: boolean;
  /** applyMemoryMigration has nothing left to do ({15} and {21} present AND v21's physical footprint —
   *  table, index, both triggers — verified in sqlite_master, each one present under the right TYPE
   *  with the right BODY, so a missing, a wrong-typed and a rewritten object all read as incomplete
   *  (M4 round 4 codex r1-C, then reviews R4-F1 and R5-F4). */
  readonly memoryComplete: boolean;
  /** applyLaneStateMigration has nothing left to do: {16} and {20} present AND fl150's
   *  un-version-bumped lane_prompt_attempts.aborted_at column physically exists. */
  readonly laneComplete: boolean;
}

const NOT_READY: ChainReadiness = {
  globalComplete: false,
  memoryComplete: false,
  laneComplete: false,
};

const VERSION_TABLE_SELECT: string =
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_schema_version'";

interface RawVersionRow {
  /** The raw value; only rows whose storage class survived validation are ever used as numbers. */
  version: unknown;
  /** SQLite typeof(): 'integer' | 'text' | 'real' | 'blob' | 'null'. */
  storage_class: string;
}

function formatSneakyValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value instanceof Uint8Array) return `blob(${value.length} bytes)`;
  if (value === null) return "NULL";
  return String(value);
}

/**
 * Reads every `_schema_version` row WITH its storage class and refuses anything but a real
 * integer. This is THE trust boundary for the version key: the old reader cast-and-joined raw
 * values, so one TEXT row "14,15" impersonated the accepted {14,15} set and every opener skipped
 * both migration chains on a database with no tables. No coercion: text/real/blob/null throw.
 */
function readValidatedVersionRows(db: OpenedDatabase): number[] {
  const rows = db
    .prepare(
      "SELECT version, typeof(version) AS storage_class FROM _schema_version ORDER BY version",
    )
    .all() as RawVersionRow[];
  const versions: number[] = [];
  for (const row of rows) {
    // better-sqlite3 hands INTEGER columns back as JS numbers; the typeof guard both narrows and
    // rejects any driver-level surprise before the safety check runs.
    if (
      row.storage_class !== "integer" ||
      typeof row.version !== "number" ||
      !Number.isSafeInteger(row.version)
    ) {
      const detail = `${row.storage_class} ${formatSneakyValue(row.version)}`;
      throw new ConfigError(
        `SCHEMA_DRIFT: _schema_version.version must be stored as an integer, received ${detail}`,
        Zer0ErrorCode.EvidenceSchemaDrift,
      );
    }
    versions.push(row.version);
  }
  return versions;
}

/** The ascending comma-joined version key over VALIDATED integer rows only. */
export function validatedVersionKey(db: OpenedDatabase): string {
  return readValidatedVersionRows(db).join(",");
}

export function columnExists(db: OpenedDatabase, table: string, name: string): boolean {
  const rows = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === name);
}

/**
 * FL-077 — the steady-state read that lets an open SKIP every write when the database on disk is
 * already fully migrated for a tier. The accepted-key lists come from the caller (db.ts owns the
 * tolerance contract); this module owns the physical reads. All reads, no writes: the whole point
 * is that a steady-state open must succeed while another connection holds the writer lock.
 * Round 3: called again UNDER each tier's BEGIN IMMEDIATE (migration-tiers.ts) so the re-read is
 * serialized against concurrent writers.
 */
export function chainReadiness(
  db: OpenedDatabase,
  acceptedKeys: AcceptedVersionKeys,
): ChainReadiness {
  const tableRow = db.prepare(VERSION_TABLE_SELECT).get() as { name: string } | undefined;
  if (tableRow === undefined) {
    return NOT_READY;
  }
  const key = validatedVersionKey(db);
  return {
    globalComplete: acceptedKeys.global.includes(key),
    // M4 ROUND 4 (codex r1-C): an accepted version set alone proves nothing about v21's physical
    // footprint — a sculpted {14,15,21} DB with the after-insert trigger dropped read
    // memoryComplete:true forever while appends projected nothing and recall silently missed them.
    // The conjunct mirrors the lane tier's aborted_at check below: a false probe just re-runs the
    // idempotent applyMemoryMigration under the tier's BEGIN IMMEDIATE, whose v21 body re-creates
    // missing objects and re-backfills (repair-in-tier). It stays a pure READ, so this module's
    // steady-state zero-write contract is intact.
    memoryComplete: acceptedKeys.memory.includes(key) && fileProjectionObjectsPresent(db),
    // fl150's un-version-bumped step: read the column back; a false probe just re-runs the
    // idempotent addColumnIfMissing under the tier's BEGIN IMMEDIATE.
    laneComplete:
      acceptedKeys.lane.includes(key) &&
      columnExists(
        db,
        LANE_PROMPT_ATTEMPT_ABORTED_COLUMN.table,
        LANE_PROMPT_ATTEMPT_ABORTED_COLUMN.name,
      ),
  };
}
