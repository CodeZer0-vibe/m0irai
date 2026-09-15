/**
 * @file src/evidence/migrations.ts
 * @purpose Evidence DB migration entry points, including lazy memory and scoped lane-state migrations.
 * @exports applyMigrations, applyMemoryMigration, applyLaneStateMigration, assignmentsRebuildNeeded, enterRebuildPosture, restoreRebuildPosture
 * @depends ../shared/error-codes, ../shared/errors, ./db, ./migration-readiness, ./migrations-v8-v12, ./migrations-v13, ./migrations-v15, ./migrations-v16, ./migrations-v20, ./migrations-v21
 */
import { Zer0ErrorCode } from "../shared/error-codes.js";
import { ConfigError } from "../shared/errors.js";
import type { Db } from "./db.js";
import {
  type ColumnDefinition,
  LANE_PROMPT_ATTEMPT_ABORTED_COLUMN,
  columnExists,
} from "./migration-readiness.js";
import {
  ASSIGNMENTS_NEEDS_REBUILD_PROBE,
  MIGRATION_V7_TO_V8,
  MIGRATION_V8_TO_V9,
  MIGRATION_V9_TO_V10,
  MIGRATION_V10_TO_V11_FINALIZE,
  MIGRATION_V10_TO_V11_REBUILD_ASSIGNMENTS,
  MIGRATION_V11_TO_V12,
} from "./migrations-v8-v12.js";
import { CHAT_SESSIONS_PROJECT_INDEX, MIGRATION_V12_TO_V13 } from "./migrations-v13.js";
import { MIGRATION_V14_TO_V15 } from "./migrations-v15.js";
import { MIGRATION_V15_TO_V16 } from "./migrations-v16.js";
import { MIGRATION_V16_TO_V20 } from "./migrations-v20.js";
import { type FileProjectionStepResult, applyFileProjectionStep } from "./migrations-v21.js";

// Migration v1 -> v2: idx_gate_transitions_unique changed shape from
// (run_id, gate_name, passed) to (run_id, gate_name) so the upsert in
// queries.ts insertGateTransition matches a unique constraint. Old DBs
// keep the old index because CREATE INDEX IF NOT EXISTS is idempotent;
// we explicitly DROP+CREATE to migrate.
// applySchema always runs first and INSERT OR IGNOREs version=2. On a v1
// upgrade that leaves both rows (1 and 2) in _schema_version; we DELETE
// the legacy v1 row here. The DROP+CREATE pair migrates the unique index
// shape; both are idempotent on a fresh DB and on an upgraded DB.
const MIGRATION_V1_TO_V2: string = `
DELETE FROM _schema_version WHERE version = 1;
DROP INDEX IF EXISTS idx_gate_transitions_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_gate_transitions_unique ON gate_transitions(run_id, gate_name);
`;
const MIGRATION_V2_TO_V3: string = `
INSERT OR IGNORE INTO _schema_version(version) VALUES (3);
DELETE FROM _schema_version WHERE version IN (1, 2);
DROP INDEX IF EXISTS idx_dispatches_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatches_unique ON dispatches(task_id, agent, command_hash);
`;
const MIGRATION_V3_TO_V4: string = `
INSERT OR IGNORE INTO _schema_version(version) VALUES (4);
DELETE FROM _schema_version WHERE version IN (1, 2, 3);
`;
const MIGRATION_V4_TO_V5: string = `
INSERT OR IGNORE INTO _schema_version(version) VALUES (5);
DELETE FROM _schema_version WHERE version IN (1, 2, 3, 4);
`;
const MIGRATION_V5_TO_V6: string = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idempotency ON events(run_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
INSERT OR IGNORE INTO _schema_version(version) VALUES (6);
DELETE FROM _schema_version WHERE version IN (1, 2, 3, 4, 5);
`;
const MIGRATION_V6_TO_V7: string = `
CREATE INDEX IF NOT EXISTS idx_findings_path ON findings(path) WHERE path IS NOT NULL;
INSERT OR IGNORE INTO _schema_version(version) VALUES (7);
DELETE FROM _schema_version WHERE version IN (1, 2, 3, 4, 5, 6);
`;
const ARTIFACT_V11_COLUMNS: readonly ColumnDefinition[] = [
  { table: "chat_artifacts", name: "export_path", definition: "export_path TEXT" },
  { table: "chat_artifacts", name: "content_hash", definition: "content_hash TEXT" },
  { table: "chat_artifacts", name: "policy_violation", definition: "policy_violation TEXT" },
];
const CHAT_MESSAGE_ROUND_COLUMN: ColumnDefinition = {
  table: "chat_messages",
  name: "round",
  definition: "round INTEGER NOT NULL DEFAULT 0",
};
// U2e-c #8 (INV-EF7): a nullable dispatched_agents TEXT(JSON) column carrying a user turn's fan-out set —
// the audit-trail cover for the open→tail-flush kill window. Additive + idempotent (addColumnIfMissing).
const CHAT_MESSAGE_DISPATCHED_AGENTS_COLUMN: ColumnDefinition = {
  table: "chat_messages",
  name: "dispatched_agents",
  definition: "dispatched_agents TEXT",
};
const MIGRATION_V13_TO_V14: string = `
INSERT OR IGNORE INTO _schema_version(version) VALUES (14);
DELETE FROM _schema_version WHERE version IN (1,2,3,4,5,6,7,8,9,10,11,12,13);
`;
const DISPATCH_REPLAY_COLUMNS: readonly ColumnDefinition[] = [
  { table: "dispatches", name: "argv_json", definition: "argv_json TEXT" },
  { table: "dispatches", name: "cwd", definition: "cwd TEXT" },
  {
    table: "dispatches",
    name: "env_allowlist_version",
    definition: "env_allowlist_version TEXT",
  },
  {
    table: "dispatches",
    name: "context_blob_hash",
    definition: "context_blob_hash TEXT",
  },
  {
    table: "dispatches",
    name: "model_version",
    definition: "model_version TEXT",
  },
  { table: "dispatches", name: "repo_commit", definition: "repo_commit TEXT" },
];
const DISPATCH_CLAIM_COLUMNS: readonly ColumnDefinition[] = [
  { table: "dispatch_claims", name: "model_version", definition: "model_version TEXT" },
  { table: "dispatch_claims", name: "adapter_version", definition: "adapter_version TEXT" },
  { table: "dispatch_claims", name: "cli_version", definition: "cli_version TEXT" },
  { table: "dispatch_claims", name: "prompt_text", definition: "prompt_text BLOB" },
  { table: "dispatch_claims", name: "prompt_fingerprint", definition: "prompt_fingerprint TEXT" },
  { table: "dispatch_claims", name: "error", definition: "error TEXT" },
  { table: "dispatch_claims", name: "phase", definition: "phase TEXT" },
  { table: "dispatch_claims", name: "attempt", definition: "attempt INTEGER" },
];

const CHAT_SESSIONS_PROJECT_ID_COLUMN: ColumnDefinition = {
  table: "chat_sessions",
  name: "project_id",
  definition: "project_id TEXT",
};
const CHAT_SESSIONS_QUARANTINED_COLUMN: ColumnDefinition = {
  table: "chat_sessions",
  name: "quarantined",
  definition: "quarantined INTEGER NOT NULL DEFAULT 0",
};
const QUARANTINE_SESSIONS_SQL: string =
  "UPDATE chat_sessions SET quarantined = 1 WHERE repo_root IS NULL OR trim(repo_root) = ''";

// FL-077: every step below runs as BEGIN IMMEDIATE — the writer lock is taken BEFORE any read,
// so contention with a concurrent writer surfaces as an honest busy-handler wait instead of the
// SQLITE_BUSY-without-busy-handler failure of a deferred transaction's read→write upgrade
// (FL-074 measured a 3 ms throw under busy_timeout=5000). Steps stay individually idempotent, so
// a writer that interleaves between two steps is absorbed on the next open.
// This claim is UNIVERSAL and mechanically enforced: transaction-immediate-pin.test.ts reads EVERY
// non-test source in src/evidence — the file set is derived from the directory, not typed, so a new
// migration file is in scope the moment it exists — and fails if any db.transaction() wrapper is
// invoked without .immediate, or is created without being named in the file that creates it. Round 2
// found MIGRATION_V3_TO_V4 still deferred while this comment already claimed otherwise — it happened
// to be harmless because that step's first statement is an INSERT (which takes the write lock up
// front), which is exactly the kind of accident the pin exists to stop relying on.
export function applyMigrations(db: Db): void {
  const migrate = db.transaction((sql: string): void => {
    db.exec(sql);
  });
  migrate.immediate(MIGRATION_V1_TO_V2);
  applyV2ToV3(db);
  migrate.immediate(MIGRATION_V3_TO_V4);
  applyV4ToV5(db);
  applyV5ToV6(db);
  applyV6ToV7(db);
  applyV7ToV8(db);
  applyV8ToV9(db);
  applyV9ToV10(db);
  applyV10ToV11(db);
  applyV11ToV12(db);
  applyV12ToV13(db);
  applyV13ToV14(db);
}

// Applies v13 -> v14 (U2e-c #8): the additive chat_messages.dispatched_agents column + the version bump as
// ONE atomic transaction. addColumnIfMissing no-ops on a fresh DB (schema.sql already has the column); on an
// EXISTING v13 DB it ALTERs the column in — without this chain step, only fresh installs would ever have it.
function applyV13ToV14(db: Db): void {
  const migrate = db.transaction((): void => {
    addColumnIfMissing(db, CHAT_MESSAGE_DISPATCHED_AGENTS_COLUMN);
    db.exec(MIGRATION_V13_TO_V14);
  });
  migrate.immediate();
}

/**
 * Applies the LAZY v14 -> v15 memory-journal migration (MEMORY-FULL §5) as ONE atomic transaction: a throw
 * rolls back to {14} with zero journal tables. DELIBERATELY EXCLUDED from {@link applyMigrations} (the
 * global chain) — it runs ONLY from the memory-scoped openMemoryDb, so a memory-off DB never migrates past
 * v14 (AC5). Idempotent: CREATE TABLE/INDEX/TRIGGER IF NOT EXISTS + INSERT OR IGNORE(15) no-op on reopen.
 * Keeps 14 in _schema_version (never deletes it) so a memory-on DB is the stable set {14,15,...} under both
 * open paths — see migrations-v15.ts for the version-model rationale.
 * M4: the SAME transaction also carries the v21 file-projection step (journal_entry_files + its one-shot
 * backfill), behind its own version-21 + physical-footprint probe — journal_entries exists from v15 and
 * appendEntry runs on every memory-on DB, so the projection must exist wherever the journal does.
 *
 * THE COUNTS ARE RETURNED, NEVER LOGGED HERE (M5 review r3b FINDING 4). Under the tier opener this
 * function's `.immediate()` degrades to a SAVEPOINT inside runMemoryTier's outer BEGIN IMMEDIATE, so on
 * return NOTHING is on disk yet: the reviewer's probe recorded the old in-function "backfill committed"
 * debug line firing with `db.inTransaction === true`, after which the tier's locked version validation
 * threw and rolled the database back to {14} with no `journal_entries` table at all — a durable claim of
 * a commit that never happened. The counts now travel out to whoever owns the OUTER transaction
 * (migration-tiers.ts -> db.ts), which logs only after the real COMMIT.
 *
 * @param db - an open evidence DB the global chain has already walked to v14
 * @returns the v21 step's row counts AND the objects it rebuilt, for the caller to log AFTER its commit
 */
export function applyMemoryMigration(db: Db): FileProjectionStepResult {
  let projection: FileProjectionStepResult = {
    backfilledRows: 0,
    skippedRows: 0,
    repairedObjects: [],
    displacedObjects: [],
  };
  const migrate = db.transaction((): void => {
    db.exec(MIGRATION_V14_TO_V15);
    projection = applyFileProjectionStep(db);
  });
  migrate.immediate();
  return projection;
}

/**
 * Applies the lazy v15 -> v16 lane-state schema and v16 -> v20 room-scope rebuild in one atomic
 * transaction. A throw rolls back to the prior schema with no partially rebuilt lane tables.
 * DELIBERATELY EXCLUDED from {@link applyMigrations} AND from
 * {@link applyMemoryMigration} — it runs ONLY from the carrier-scoped openLaneStateDb, whose call sites
 * sit behind the COMPOSED gate `carrierEnabled()` (memory AND resume), so neither flag alone ever mutates
 * the DB (I-6; parent AC5 preserved). Idempotent: version 20 skips the room-scope rebuild on reopen.
 *
 * @param db - an open evidence DB already carrying the memory schema ({14,15})
 */
export function applyLaneStateMigration(db: Db): void {
  const migrate = db.transaction((): void => {
    db.exec(MIGRATION_V15_TO_V16);
    const scoped = db.prepare("SELECT 1 FROM _schema_version WHERE version = 20 LIMIT 1").get();
    if (scoped === undefined) db.exec(MIGRATION_V16_TO_V20);
    addColumnIfMissing(db, LANE_PROMPT_ATTEMPT_ABORTED_COLUMN);
  });
  migrate.immediate();
}

function applyV2ToV3(db: Db): void {
  const migrate = db.transaction((): void => {
    db.exec(MIGRATION_V2_TO_V3);
    for (const column of DISPATCH_REPLAY_COLUMNS) {
      addColumnIfMissing(db, column);
    }
  });
  migrate.immediate();
}

function applyV4ToV5(db: Db): void {
  const migrate = db.transaction((): void => {
    for (const column of DISPATCH_CLAIM_COLUMNS) {
      addColumnIfMissing(db, column);
    }
    db.exec(MIGRATION_V4_TO_V5);
  });
  migrate.immediate();
}

// U2e (v5 -> v6): events.idempotency_key + its partial index. FL-077 gating note: the ALTER and
// MIGRATION_V5_TO_V6's INSERT OR IGNORE(6) commit as ONE transaction in applyV5ToV6, so version-set
// membership IS proof this column exists — chainReadiness needs no physical probe here (unlike
// fl150's aborted_at, whose step bumps NO version at all).
const EVENTS_IDEMPOTENCY_KEY_COLUMN: ColumnDefinition = {
  table: "events",
  name: "idempotency_key",
  definition: "idempotency_key TEXT",
};

function applyV5ToV6(db: Db): void {
  const migrate = db.transaction((): void => {
    addColumnIfMissing(db, EVENTS_IDEMPOTENCY_KEY_COLUMN);
    db.exec(MIGRATION_V5_TO_V6);
  });
  migrate.immediate();
}

function applyV6ToV7(db: Db): void {
  const migrate = db.transaction((): void => {
    db.exec(MIGRATION_V6_TO_V7);
  });
  migrate.immediate();
}

function applyV7ToV8(db: Db): void {
  const migrate = db.transaction((): void => {
    db.exec(MIGRATION_V7_TO_V8);
  });
  migrate.immediate();
}

function applyV8ToV9(db: Db): void {
  const migrate = db.transaction((): void => {
    addColumnIfMissing(db, CHAT_MESSAGE_ROUND_COLUMN);
    db.exec(MIGRATION_V8_TO_V9);
  });
  migrate.immediate();
}

function applyV9ToV10(db: Db): void {
  const migrate = db.transaction((): void => {
    db.exec(MIGRATION_V9_TO_V10);
  });
  migrate.immediate();
}

/**
 * Applies v10 -> v11 (gemini research/design lane) as ONE ATOMIC transaction (BLOCK-1): the
 * chat_build_assignments rebuild + the chat_artifacts column adds + the FK check + the version bump
 * all commit together or all roll back, so a crash/failure between steps can never strand a v11-shaped
 * table at version 10. The assignments rebuild runs ONLY when an OLD-or-HYBRID-shape table is present
 * (DECISION-3: the probe requires BOTH v11 CHECK domains to skip), re-probed UNDER the write lock;
 * a fresh v11 DB skips it. PRAGMAs (`foreign_keys` OFF + `legacy_alter_table` ON for the safe-rebuild
 * RENAME) are no-ops inside any open transaction, so they belong to the OUTERMOST transaction's owner:
 * under the round-3 atomic tier that is runGlobalTier (before BEGIN IMMEDIATE, restored+verified after);
 * standalone callers get the posture from this step's own `ownsPosture` branch. The additive artifact
 * columns + the version bump are idempotent on a fresh and an upgraded DB.
 */
// DECISION-3's shape probe, used inside applyV10ToV11's own transaction AND (exported, FL-077 r3)
// by migration-tiers.ts BEFORE the outer tier transaction opens. Reads sqlite_master with the
// table name in the WHERE, so an absent table (fresh database) reads as "nothing to rebuild"
// rather than throwing. FL-077 gating note: chainReadiness deliberately does NOT run it — the
// rebuild decision is settled atomically by the same commit that inserts version 11, so an
// accepted version set already proves the outcome; re-probing sqlite_master text with LIKE on
// every open could only force needless writer-lock reruns on healthy databases.
export function assignmentsRebuildNeeded(db: Db): boolean {
  return db.prepare(ASSIGNMENTS_NEEDS_REBUILD_PROBE).get() !== undefined;
}

// The documented safe-rebuild posture for the v11 RENAME-based rebuild: legacy_alter_table = ON so
// the `ALTER TABLE ... RENAME` does NOT rewrite the FK in the child chat_artifacts to follow the
// rename (it must keep referencing `chat_build_assignments` by NAME, which the freshly-created
// table satisfies — else the child FK would point at the temp table we DROP, leaving a dangling
// reference), and foreign_keys OFF as the safe-rebuild default. Both pragmas are NO-OPS inside an
// open transaction, so they belong to whoever owns the OUTERMOST transaction: runGlobalTier calls
// these around its BEGIN IMMEDIATE; applyV10ToV11 only when it has no outer transaction.
export function enterRebuildPosture(db: Db): void {
  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
}

// Restores the production posture after a rebuild and VERIFIES the readback: a pragma that
// silently failed to restore would leave every later statement on this connection running with FK
// enforcement disabled — exactly the failure this restore exists to prevent.
export function restoreRebuildPosture(db: Db): void {
  db.pragma("legacy_alter_table = OFF");
  db.pragma("foreign_keys = ON");
  const foreignKeys = String(db.pragma("foreign_keys", { simple: true }));
  const legacyAlterTable = String(db.pragma("legacy_alter_table", { simple: true }));
  if (foreignKeys !== "1" || legacyAlterTable !== "0") {
    throw new ConfigError(
      `Failed to restore SQLite posture after v11 rebuild (foreign_keys=${foreignKeys}, legacy_alter_table=${legacyAlterTable})`,
      Zer0ErrorCode.ConfigInvalid,
    );
  }
}

function applyV10ToV11(db: Db): void {
  // PRAGMAs are per-connection and no-ops inside any open transaction, so under the round-3
  // atomic tier (runGlobalTier holds one BEGIN IMMEDIATE across the whole chain) the posture is
  // established and restored AROUND the tier; this step owns it only when it runs WITHOUT an
  // outer transaction (direct callers outside the opener path).
  const ownsPosture = !db.inTransaction;
  const needsRebuild = assignmentsRebuildNeeded(db);
  if (ownsPosture && needsRebuild) {
    enterRebuildPosture(db);
  }
  try {
    const migrate = db.transaction((): void => {
      // Re-probe UNDER the write lock: between the unlocked probe above and BEGIN, another
      // process may have committed the rebuild already.
      if (assignmentsRebuildNeeded(db)) {
        db.exec(MIGRATION_V10_TO_V11_REBUILD_ASSIGNMENTS);
        const violations = db.pragma("foreign_key_check") as unknown[];
        if (violations.length > 0) {
          throw new ConfigError(
            "v11 assignments rebuild left a dangling foreign key",
            Zer0ErrorCode.EvidenceSchemaDrift,
          );
        }
      }
      for (const column of ARTIFACT_V11_COLUMNS) {
        addColumnIfMissing(db, column);
      }
      db.exec(MIGRATION_V10_TO_V11_FINALIZE);
    });
    migrate.immediate();
  } finally {
    if (ownsPosture && needsRebuild) {
      restoreRebuildPosture(db);
    }
  }
}

/** Applies v11 -> v12 as ONE atomic transaction (see MIGRATION_V11_TO_V12 for the atomicity + INV-14
 * rationale); a throw rolls the whole transaction back to {11}. */
function applyV11ToV12(db: Db): void {
  const migrate = db.transaction((): void => {
    db.exec(MIGRATION_V11_TO_V12);
  });
  migrate.immediate();
}

/** Applies v12 -> v13 (evidence-ledger / memory front) as ONE atomic transaction; a throw rolls
 * back to {12} with zero memory tables. The 9 new tables + triggers + indexes are in
 * MIGRATION_V12_TO_V13. The two chat_sessions column additions and the quarantine UPDATE run
 * inside the same transaction so they commit or roll back together.
 * idx_chat_sessions_project is created AFTER addColumnIfMissing so project_id exists. */
function applyV12ToV13(db: Db): void {
  const migrate = db.transaction((): void => {
    db.exec(MIGRATION_V12_TO_V13);
    addColumnIfMissing(db, CHAT_SESSIONS_PROJECT_ID_COLUMN);
    addColumnIfMissing(db, CHAT_SESSIONS_QUARANTINED_COLUMN);
    db.exec(QUARANTINE_SESSIONS_SQL);
    db.exec(CHAT_SESSIONS_PROJECT_INDEX);
  });
  migrate.immediate();
}

function addColumnIfMissing(db: Db, column: ColumnDefinition): void {
  if (columnExists(db, column.table, column.name)) {
    return;
  }
  db.exec(`ALTER TABLE ${column.table} ADD COLUMN ${column.definition}`);
}
