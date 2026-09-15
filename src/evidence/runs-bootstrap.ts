/**
 * @file src/evidence/runs-bootstrap.ts
 * @purpose Idempotent parent-row bootstrap for the runs table so packet-build activities
 *          can satisfy the dispatch_claims/commit_intents foreign-key invariant without
 *          coupling to the legacy persistRunStarted activity.
 * @exports ensureRunRow
 * @depends zod, ./db, ../shared/error-codes, ../shared/errors
 */
import { z } from "zod";
import { Zer0ErrorCode } from "../shared/error-codes.js";
import { ConfigError } from "../shared/errors.js";
import type { Db } from "./db.js";

const RunIdSchema: z.ZodString = z.string().min(1);
const STUB_VISION: string = "buildPacketWorkflow";
// Provide explicit non-null values for status/branch/base_commit. Older evidence DBs declared
// these NOT NULL with no default; INSERT OR IGNORE silently swallows the NOT-NULL violation,
// leaving NO runs row, so every downstream run_id FK (chat_sessions, dispatch_claims, …) fails.
// The canonical schema has the same columns (status defaults to 'init', branch/base_commit
// nullable), so these explicit values are valid there too. Both shapes have all six columns.
const ENSURE_SQL: string =
  "INSERT OR IGNORE INTO runs (id, vision, status, branch, base_commit, started_at) VALUES (?, ?, 'init', '', '', datetime('now'))";
const VERIFY_SQL: string = "SELECT 1 AS present FROM runs WHERE id = ? LIMIT 1";

/**
 * Ensures a parent runs(id) row exists for the given runId. Idempotent: if the row
 * already exists (legacy pipelineWorkflow created it via persistRunStarted, or a
 * prior buildPacketWorkflow activity ran first), this is a no-op.
 *
 * Why this exists: dispatch_claims.run_id and commit_intents.run_id REFERENCE
 * runs(id) (schema.sql:158, 178). buildPacketWorkflow does not call any legacy
 * persist activity, so the parent row would never exist and the FK would fail
 * on the first dispatch claim. This helper is the activity-layer bootstrap.
 *
 * @param db - open evidence database handle
 * @param runId - workflow run id (also the runs.id primary key)
 */
export function ensureRunRow(db: Db, runId: string): void {
  const parsed = RunIdSchema.parse(runId);
  db.prepare(ENSURE_SQL).run(parsed, STUB_VISION);
  // INSERT OR IGNORE silently swallows a constraint failure (e.g. an old evidence DB whose runs table has
  // an extra NOT NULL column with no default), leaving NO parent row — every downstream run_id FK
  // (chat_sessions, dispatch_claims, …) then fails with an opaque "FOREIGN KEY constraint" deep in a later
  // write. Verify the row EXISTS and fail loud with a diagnosable schema-drift error instead, so the cause
  // (a drifted DB to recreate/migrate) is named at the source rather than surfacing cryptically downstream.
  const present = db.prepare(VERIFY_SQL).get(parsed);
  if (present === undefined) {
    throw new ConfigError(
      `SCHEMA_DRIFT: could not create runs row '${parsed}' — the evidence DB's runs table rejected the insert (likely an extra NOT NULL column without a default from an older schema). Recreate or migrate the evidence DB.`,
      Zer0ErrorCode.EvidenceSchemaDrift,
    );
  }
}
