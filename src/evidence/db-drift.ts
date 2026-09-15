/**
 * @file src/evidence/db-drift.ts
 * @purpose Detects pre-v3 SQLite schemas (carried from early prototypes) and refuses to
 *          silently apply CREATE TABLE IF NOT EXISTS over them — that would leave the
 *          events table with stale columns and break runtime queries unpredictably.
 * @exports detectIncompatibleSchema, INCOMPATIBLE_SCHEMA_HINT
 * @depends better-sqlite3, ../shared/error-codes, ../shared/errors
 */
import type { Database } from "better-sqlite3";
import { Zer0ErrorCode } from "../shared/error-codes.js";
import { ConfigError } from "../shared/errors.js";

/**
 * Sentinel columns introduced at v3. Pre-v3 DBs lack these and would otherwise
 * survive CREATE TABLE IF NOT EXISTS untouched, leaving runtime queries broken.
 */
const V3_SENTINEL_COLUMNS: readonly { table: string; column: string }[] = [
  { table: "events", column: "sequence" },
  { table: "events", column: "kind" },
  { table: "events", column: "payload_json" },
];

interface SqliteMasterRow {
  name: string;
}

interface PragmaTableInfoRow {
  name: string;
}

/**
 * User-facing remediation guidance shown when an incompatible DB is detected.
 * Kept exported so the CLI can render the same message verbatim from `zer0 doctor`.
 */
export const INCOMPATIBLE_SCHEMA_HINT: string = [
  "Detected pre-v3 evidence database with incompatible column shape.",
  "This DB was created by an older zer0 prototype and cannot be migrated automatically",
  "(silent column-reshape migration would be data-loss prone).",
  "",
  "To recover:",
  "  1. Archive the old DB:    move .zer0/evidence.db .zer0/evidence.db.pre-v3.bak",
  "  2. Re-run any zer0 command — a fresh v3 DB will be created on demand.",
].join("\n");

/**
 * Detects an existing events table that was created BEFORE the v3 schema and
 * therefore lacks v3 sentinel columns. Throws a typed ConfigError with
 * actionable instructions; safe no-op on fresh DBs (no events table).
 *
 * Must run BEFORE applySchema(): once CREATE TABLE IF NOT EXISTS has executed,
 * the old shape is locked in and runtime queries will fail mysteriously.
 *
 * @param db - open better-sqlite3 handle, after pragmas applied
 * @throws ConfigError(EvidenceSchemaDrift) when a pre-v3 events table is present
 *
 * @example
 * applyPragmas(db);
 * detectIncompatibleSchema(db);   // throws if stale shape
 * applySchema(db);
 */
export function detectIncompatibleSchema(db: Database): void {
  const events = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'")
    .get() as SqliteMasterRow | undefined;
  if (events === undefined) {
    return;
  }
  const columns = db.prepare("PRAGMA table_info('events')").all() as PragmaTableInfoRow[];
  const present = new Set(columns.map((row) => row.name));
  const missing = V3_SENTINEL_COLUMNS.filter(
    (sentinel) => sentinel.table === "events" && !present.has(sentinel.column),
  );
  if (missing.length === 0) {
    return;
  }
  const missingList = missing.map((m) => `${m.table}.${m.column}`).join(", ");
  const message = `INCOMPATIBLE_SCHEMA: events table missing v3 columns [${missingList}]. ${INCOMPATIBLE_SCHEMA_HINT}`;
  throw new ConfigError(message, Zer0ErrorCode.EvidenceSchemaDrift);
}
