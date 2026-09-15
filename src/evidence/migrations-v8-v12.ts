/**
 * @file src/evidence/migrations-v8-v12.ts
 * @purpose SQL string constants for evidence schema migrations v8 through v12. Exported for use
 * by migrations.ts; no imports required — these are pure string literals. Split out of
 * migrations.ts to keep each file under the 400-line new-file ceiling.
 * @exports MIGRATION_V7_TO_V8, MIGRATION_V8_TO_V9, MIGRATION_V9_TO_V10,
 *   ASSIGNMENTS_NEEDS_REBUILD_PROBE, MIGRATION_V10_TO_V11_REBUILD_ASSIGNMENTS,
 *   MIGRATION_V10_TO_V11_FINALIZE, MIGRATION_V11_TO_V12
 * @depends (none)
 */
export const MIGRATION_V7_TO_V8: string = `
CREATE TABLE IF NOT EXISTS chat_sessions (
  id                    TEXT PRIMARY KEY,
  run_id                TEXT NOT NULL REFERENCES runs(id),
  repo_root             TEXT NOT NULL,
  run_dir               TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  default_agent         TEXT NOT NULL CHECK (default_agent IN ('claude','codex','gemini')),
  last_agent            TEXT          CHECK (last_agent IN ('claude','codex','gemini')),
  summary_text          TEXT NOT NULL DEFAULT '',
  summary_through_turn  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES chat_sessions(id),
  turn            INTEGER NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('user','agent','system','error')),
  agent           TEXT NOT NULL,
  text_blob_hash  TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('completed','failed','cancelled')),
  token_estimate  INTEGER NOT NULL,
  dispatch_id     TEXT REFERENCES dispatches(id)
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session_turn
  ON chat_messages(session_id, turn);
INSERT OR IGNORE INTO _schema_version(version) VALUES (8);
DELETE FROM _schema_version WHERE version IN (1, 2, 3, 4, 5, 6, 7);
`;
export const MIGRATION_V8_TO_V9: string = `
CREATE TABLE IF NOT EXISTS chat_working_sets (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL REFERENCES chat_sessions(id),
  turn               INTEGER NOT NULL,
  round              INTEGER NOT NULL,
  agent              TEXT NOT NULL,
  context_blob_hash  TEXT NOT NULL,
  peer_refs          TEXT NOT NULL,
  outcome            TEXT NOT NULL CHECK(outcome IN ('ok','fail','empty','timeout','cancelled','incomplete')),
  token_estimate     INTEGER,
  created_at         TEXT NOT NULL,
  UNIQUE(session_id, turn, round, agent)
);
CREATE TABLE IF NOT EXISTS active_debates (
  session_id  TEXT PRIMARY KEY,
  turn        INTEGER NOT NULL,
  started_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_working_sets_session_turn_round
  ON chat_working_sets(session_id, turn, round);
INSERT OR IGNORE INTO _schema_version(version) VALUES (9);
DELETE FROM _schema_version WHERE version IN (1, 2, 3, 4, 5, 6, 7, 8);
`;
// Migration v9 -> v10: BUILD pillar tables (chat_build_runs / chat_build_assignments /
// chat_artifacts). The table/column DEFINITIONS live in schema.sql (schema discipline); this
// migration owns ONLY the version bump + the FK indexes (the assignment->run and artifact->
// assignment lookups + the per-session run scan). All CREATE INDEX IF NOT EXISTS are idempotent
// on a fresh DB and on an upgraded DB; applySchema runs first so the tables exist before indexing.
export const MIGRATION_V9_TO_V10: string = `
CREATE INDEX IF NOT EXISTS idx_chat_build_runs_session ON chat_build_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_build_assignments_run ON chat_build_assignments(run_id);
CREATE INDEX IF NOT EXISTS idx_chat_artifacts_assignment ON chat_artifacts(assignment_id);
INSERT OR IGNORE INTO _schema_version(version) VALUES (10);
DELETE FROM _schema_version WHERE version IN (1, 2, 3, 4, 5, 6, 7, 8, 9);
`;
// Migration v10 -> v11: the gemini research/design lane. Two table-DEFINITION changes that
// schema.sql cannot retro-apply to an EXISTING table (CREATE TABLE IF NOT EXISTS is a no-op on an
// existing table; SQLite has no ALTER TABLE ADD CHECK) → chat_build_assignments is REBUILT (12-step
// PRAGMA-guarded copy) so an old DB gains the `policy-rejected` state + `('code','md')` capability
// CHECK without data loss. The 3 nullable chat_artifacts columns (export_path/content_hash/
// policy_violation) are purely additive → ALTER TABLE ADD COLUMN (addColumnIfMissing). The version
// bump + the FK index re-creation live HERE (schema-discipline); the CHECK literals live in
// schema.sql so a fresh DB is born correct and a live worker hot-reads the canonical column shape.
// Rebuild iff the assignments table exists but is MISSING EITHER v11 CHECK domain (DECISION-3): the
// `policy-rejected` state literal OR the `('code','md')` capability literal. Keying on only ONE would
// bless a malformed hybrid (one CHECK present, the other absent) and bump to 11 with a missing domain.
// Requiring BOTH present to SKIP means any partial table is rebuilt to the canonical shape.
export const ASSIGNMENTS_NEEDS_REBUILD_PROBE: string = `
SELECT 1 FROM sqlite_master
 WHERE type = 'table' AND name = 'chat_build_assignments'
   AND (sql NOT LIKE '%policy-rejected%' OR sql NOT LIKE '%''code'',''md''%')`;
export const MIGRATION_V10_TO_V11_REBUILD_ASSIGNMENTS: string = `
ALTER TABLE chat_build_assignments RENAME TO _chat_build_assignments_v10;
CREATE TABLE chat_build_assignments (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES chat_build_runs(id) ON DELETE CASCADE,
  agent          TEXT NOT NULL,
  task           TEXT NOT NULL,
  capability     TEXT NOT NULL CHECK (capability IN ('code','md')),
  worktree_path  TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN (
                   'pending','running','captured','accepted','rejected',
                   'failed','failed_acknowledged','empty','escaped','policy-rejected')),
  created_at     TEXT NOT NULL,
  UNIQUE(run_id, agent)
);
INSERT INTO chat_build_assignments (id, run_id, agent, task, capability, worktree_path, state, created_at)
  SELECT id, run_id, agent, task, capability, worktree_path, state, created_at
  FROM _chat_build_assignments_v10;
DROP TABLE _chat_build_assignments_v10;
CREATE INDEX IF NOT EXISTS idx_chat_build_assignments_run ON chat_build_assignments(run_id);
`;
export const MIGRATION_V10_TO_V11_FINALIZE: string = `
INSERT OR IGNORE INTO _schema_version(version) VALUES (11);
DELETE FROM _schema_version WHERE version IN (1, 2, 3, 4, 5, 6, 7, 8, 9, 10);
`;
// Migration v11 -> v12: the "control tower" tables. ATOMICITY CONTRACT — the 7 tower_* tables live ONLY
// here (NOT schema.sql, which applySchema commits FIRST), so a throw rolls back to exactly {11} with zero
// tower tables. INV-14/INV-5 immutability is enforced at the STORAGE layer (not app code): tower_proposals
// is write-once (only the CAS pending->allow|deny updates it); tower_decisions is append-only + one-per-
// proposal (UNIQUE(proposal_id) + no-update/no-delete triggers). FK CASCADE reaps subtree; RESTRICT pins
// audit rows. Version bump is last so the row count stays one and assertSchemaVersion reads {12}.
export const MIGRATION_V11_TO_V12: string = `
CREATE TABLE IF NOT EXISTS tower_sessions (
  id               TEXT PRIMARY KEY,
  started_at       TEXT NOT NULL,
  operator         TEXT NOT NULL,
  chat_session_id  TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS tower_agent_lanes (
  id             TEXT PRIMARY KEY,
  agent          TEXT NOT NULL CHECK (agent IN ('claude','codex','gemini')),
  session_id     TEXT NOT NULL REFERENCES tower_sessions(id) ON DELETE CASCADE,
  worktree_path  TEXT NOT NULL,
  branch         TEXT NOT NULL,
  base_sha       TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN (
                   'spawning','working','awaiting_approval','done','failed','unsafe','rate_limited'))
);
CREATE TABLE IF NOT EXISTS tower_turns (
  id              TEXT PRIMARY KEY,
  lane_id         TEXT NOT NULL REFERENCES tower_agent_lanes(id) ON DELETE CASCADE,
  status          TEXT NOT NULL,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  stop_reason     TEXT,
  usage_tokens    INTEGER,
  usage_cost_usd  REAL
);
CREATE TABLE IF NOT EXISTS tower_proposals (
  id                     TEXT PRIMARY KEY,
  lane_id                TEXT NOT NULL REFERENCES tower_agent_lanes(id) ON DELETE CASCADE,
  turn_id                TEXT NOT NULL REFERENCES tower_turns(id) ON DELETE CASCADE,
  native_correlation_id  TEXT NOT NULL,
  kind                   TEXT NOT NULL CHECK (kind IN (
                           'command','edit','read','move','delete','fetch','other')),
  raw_payload            TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  decision               TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending','allow','deny')),
  decided_at             TEXT
);
CREATE TABLE IF NOT EXISTS tower_decisions (
  id             TEXT PRIMARY KEY,
  proposal_id    TEXT NOT NULL REFERENCES tower_proposals(id) ON DELETE RESTRICT,
  verdict        TEXT NOT NULL CHECK (verdict IN ('allow','deny_continue','deny_interrupt')),
  modified_input TEXT,
  reason         TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE(proposal_id)
);
CREATE TABLE IF NOT EXISTS tower_worktrees (
  path      TEXT PRIMARY KEY,
  branch    TEXT NOT NULL,
  base_sha  TEXT NOT NULL,
  lane_id   TEXT NOT NULL REFERENCES tower_agent_lanes(id) ON DELETE CASCADE,
  state     TEXT NOT NULL CHECK (state IN ('active','accepted','rejected','orphaned'))
);
CREATE TABLE IF NOT EXISTS tower_decision_sends (
  decision_id  TEXT PRIMARY KEY REFERENCES tower_decisions(id) ON DELETE CASCADE,
  send_state   TEXT NOT NULL CHECK (send_state IN ('send_started','sent','native_ack','send_failed')),
  attempt_at   TEXT NOT NULL,
  ack_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_tower_proposals_pending
  ON tower_proposals(lane_id) WHERE decision = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS idx_tower_proposals_correlation
  ON tower_proposals(lane_id, native_correlation_id);
CREATE TRIGGER IF NOT EXISTS tower_proposals_immutable
BEFORE UPDATE ON tower_proposals
BEGIN
  SELECT CASE
    WHEN OLD.decision <> 'pending'
      THEN RAISE(ABORT, 'tower_proposals: decided proposal is immutable (INV-14)')
    WHEN NEW.id IS NOT OLD.id OR NEW.lane_id IS NOT OLD.lane_id OR NEW.turn_id IS NOT OLD.turn_id
      OR NEW.native_correlation_id IS NOT OLD.native_correlation_id OR NEW.kind IS NOT OLD.kind
      OR NEW.raw_payload IS NOT OLD.raw_payload OR NEW.created_at IS NOT OLD.created_at
      THEN RAISE(ABORT, 'tower_proposals: only decision+decided_at may change, row is immutable (INV-14)')
    WHEN NEW.decision NOT IN ('allow', 'deny')
      THEN RAISE(ABORT, 'tower_proposals: decision may only move pending->allow|deny (INV-14)')
  END;
END;
CREATE TRIGGER IF NOT EXISTS tower_decisions_no_update
BEFORE UPDATE ON tower_decisions
BEGIN
  SELECT RAISE(ABORT, 'tower_decisions is append-only (INV-14)');
END;
CREATE TRIGGER IF NOT EXISTS tower_decisions_no_delete
BEFORE DELETE ON tower_decisions
BEGIN
  SELECT RAISE(ABORT, 'tower_decisions is append-only (INV-14)');
END;
INSERT OR IGNORE INTO _schema_version(version) VALUES (12);
DELETE FROM _schema_version WHERE version IN (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11);
`;
