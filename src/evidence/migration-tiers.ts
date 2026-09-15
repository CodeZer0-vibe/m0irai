/**
 * @file src/evidence/migration-tiers.ts
 * @purpose FL-077 round 3: runs each open mode's incomplete migration segment as ONE outer
 *          BEGIN IMMEDIATE transaction, so the CHAIN commits atomically instead of per step.
 * @exports runGlobalTier, runMemoryTier, runLaneTier
 * @depends node:fs, ../shared/error-codes, ../shared/errors, ./db, ./migration-readiness, ./migrations, ./migrations-v21
 *
 * DEFECT THIS FILE EXISTS FOR (codex r2 finding 1): the per-step `.immediate()` wrappers make every
 * STEP atomic but not the CHAIN. Two stale openers interleaving committed transient hybrid
 * `_schema_version` sets, and the old unlocked post-chain assertion read threw spurious
 * SCHEMA_DRIFT against a healthy database that was merely still migrating (captured verbatim
 * before the fix; see open-race-atomicity.test.ts).
 *
 * SHAPE (design memo §1): the caller takes ONE unlocked strict chainReadiness first — the steady
 * state stays zero-write. When a tier is incomplete, this module opens exactly ONE outer BEGIN
 * IMMEDIATE per tier, re-reads readiness UNDER the writer lock (another opener may have finished
 * the work between our unlocked read and the lock), runs the chain — whose per-step wrappers
 * degrade to savepoints inside the outer transaction — validates the version key INSIDE the lock,
 * and commits. Memory and lane stay separate top-level IMMEDIATE tiers, each re-checking and
 * validating inside its own transaction, so a lane-tier failure never discards a committed memory
 * tier. There is deliberately NO retry loop: the under-lock re-read makes staleness harmless,
 * because by the time this connection holds the writer lock, any interleaved writer's work is
 * already visible to the re-read.
 */
import { readFileSync } from "node:fs";
import { Zer0ErrorCode } from "../shared/error-codes.js";
import { ConfigError } from "../shared/errors.js";
import type { Db } from "./db.js";
import {
  type AcceptedVersionKeys,
  chainReadiness,
  validatedVersionKey,
} from "./migration-readiness.js";
import type { FileProjectionStepResult } from "./migrations-v21.js";
import {
  applyLaneStateMigration,
  applyMemoryMigration,
  applyMigrations,
  assignmentsRebuildNeeded,
  enterRebuildPosture,
  restoreRebuildPosture,
} from "./migrations.js";

const SCHEMA_URL: URL = new URL("./schema.sql", import.meta.url);

// What runMemoryTier reports when the tier ran no backfill and no repair — either the under-lock
// re-read found the memory tier already complete, or the v21 step was already in its steady state.
const NO_PROJECTION_WORK: FileProjectionStepResult = {
  backfilledRows: 0,
  skippedRows: 0,
  repairedObjects: [],
  displacedObjects: [],
};

// FL-077: BEGIN IMMEDIATE — schema.sql opens with pragmas (reads) and closes with an
// `INSERT OR IGNORE INTO _schema_version`, so a deferred transaction here would attempt exactly
// the read→write upgrade that SQLite fails WITHOUT invoking the busy handler.
function applySchemaInto(db: Db): void {
  const schemaText = readFileSync(SCHEMA_URL, "utf8");
  const migrate = db.transaction((sql: string): void => {
    db.exec(sql);
  });
  migrate.immediate(schemaText);
}

// The locked counterpart of the deleted unlocked assertSchemaVersion: same tolerance contract,
// same message shape, but evaluated while THIS connection holds the writer lock, so the set it
// reads cannot be mid-flight work from another opener.
function validateLockedVersionKey(db: Db, allowed: readonly string[]): void {
  const key = validatedVersionKey(db);
  if (!allowed.includes(key)) {
    const expected = allowed.join(" or ");
    const received = key.length > 0 ? key : "missing";
    throw new ConfigError(
      `SCHEMA_DRIFT: expected schema version ${expected}, received ${received}`,
      Zer0ErrorCode.EvidenceSchemaDrift,
    );
  }
}

// FL-077 round 4 (review r3b finding 2): while the rebuild posture is held, EVERY statement of
// this tier — schema.sql, v1..v14, not just the rebuild step — executes with FK enforcement OFF,
// and WHICH REGIME A DATABASE GETS IS STATE-DEPENDENT: a legacy-shaped chat_build_assignments
// table flips enforcement off for the entire tier, while a fresh or v11-shaped database keeps it
// ON throughout and never enters the posture. That asymmetry hides a trap for future chain steps:
// a global step that inserts into an FK-child table will be written and tested on fresh databases
// (enforcement ON, nothing to catch because nothing runs unenforced there) and can only misbehave
// on the legacy upgrade path, where enforcement is silently OFF. The pre-commit check below is
// what closes that gap for every statement of the widened window, present and future:
// PRAGMA foreign_key_check reports constraint violations REGARDLESS of the foreign_keys setting
// (measured on this build: a dangling child row under foreign_keys=OFF reports
// {table,rowid,parent,fkid}, inside an open transaction too), so running it as the tier's LAST
// statement — after every write, BEFORE the outer COMMIT — makes any surviving violation abort
// the whole tier. The narrower in-savepoint check inside applyV10ToV11 stays: it fails THAT step
// six statements earlier, but alone it leaves v11->v12, v12->v13 and v13->v14 unchecked.
function assertNoForeignKeyViolations(db: Db): void {
  const violations = db.pragma("foreign_key_check") as unknown[];
  if (violations.length === 0) {
    return;
  }
  throw new ConfigError(
    `FOREIGN_KEY_CHECK: ${violations.length} foreign-key violation(s) survived the rebuild-pending global tier (ran with foreign_keys=OFF): ${JSON.stringify(violations.slice(0, 5))}`,
    Zer0ErrorCode.EvidenceSchemaDrift,
  );
}

/**
 * Runs the global chain (schema.sql + v1..v14) as one atomic tier when the unlocked readiness
 * found it incomplete. The v10->v11 rebuild needs `foreign_keys=OFF` + `legacy_alter_table=ON`,
 * and PRAGMAs are no-ops inside an open transaction, so the rebuild posture is probed and
 * established BEFORE BEGIN IMMEDIATE and restored (with readback verification) after
 * COMMIT/ROLLBACK — establishing it inside the transaction would silently leave FKs enabled
 * during the RENAME-based rebuild. When the posture was entered, a `foreign_key_check` also runs
 * as the tier's LAST statement before COMMIT (see {@link assertNoForeignKeyViolations}): the
 * whole chain ran under enforcement OFF, so the row-level safety net belongs at the boundary, not
 * only inside the rebuild step. If the posture fails to restore, that ConfigError supersedes
 * whatever the tier threw: a connection left with FK enforcement off is the more dangerous state.
 *
 * @param db - open database handle (pragmas already applied by the opener)
 * @param acceptedKeys - the tolerance contract each locked validation enforces
 */
export function runGlobalTier(db: Db, acceptedKeys: AcceptedVersionKeys): void {
  const rebuildPending = assignmentsRebuildNeeded(db);
  if (rebuildPending) {
    enterRebuildPosture(db);
  }
  try {
    const tier = db.transaction((): void => {
      // Serialized re-read UNDER the writer lock: another opener may have committed this whole
      // tier between the unlocked readiness read and our BEGIN IMMEDIATE. Skipping here is what
      // lets a stale opener converge with ZERO writes instead of re-running done work.
      if (!chainReadiness(db, acceptedKeys).globalComplete) {
        applySchemaInto(db);
        applyMigrations(db);
      }
      validateLockedVersionKey(db, acceptedKeys.global);
      if (rebuildPending) {
        assertNoForeignKeyViolations(db);
      }
    });
    tier.immediate();
  } finally {
    if (rebuildPending) {
      restoreRebuildPosture(db);
    }
  }
}

/**
 * Runs the lazy v14 -> v15 memory migration — and M4's v21 file projection, which rides the same
 * segment — as its own atomic tier (separate from the global tier so a later tier's failure retains
 * an earlier COMMITTED one).
 *
 * The v21 step's backfilled/skipped counts are RETURNED rather than logged, and this function does
 * not log them either (M5 review r3b FINDING 4): inside `tier`, `db.inTransaction` is true and
 * applyMemoryMigration's own `.immediate()` is only a savepoint, so any "committed" claim made
 * before `tier.immediate()` returns can still be rolled back by the locked validation two lines
 * below. The caller (db.ts's openWithMode) logs them once this call has returned, i.e. after the
 * real COMMIT.
 *
 * @param db - open database handle whose global tier is already complete
 * @param acceptedKeys - the tolerance contract the locked validation enforces
 * @returns the v21 backfill counts THIS tier committed; zeroes when it did no projection work
 */
export function runMemoryTier(db: Db, acceptedKeys: AcceptedVersionKeys): FileProjectionStepResult {
  let projection: FileProjectionStepResult = NO_PROJECTION_WORK;
  const tier = db.transaction((): void => {
    if (!chainReadiness(db, acceptedKeys).memoryComplete) {
      projection = applyMemoryMigration(db);
    }
    validateLockedVersionKey(db, acceptedKeys.memory);
  });
  tier.immediate();
  return projection;
}

/**
 * Runs the lazy v15 -> v16 + v16 -> v20 lane-state migrations as their own atomic tier.
 *
 * @param db - open database handle whose global/memory tiers are already complete
 * @param acceptedKeys - the tolerance contract the locked validation enforces
 */
export function runLaneTier(db: Db, acceptedKeys: AcceptedVersionKeys): void {
  const tier = db.transaction((): void => {
    if (!chainReadiness(db, acceptedKeys).laneComplete) {
      applyLaneStateMigration(db);
    }
    validateLockedVersionKey(db, acceptedKeys.lane);
  });
  tier.immediate();
}
