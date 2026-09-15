/**
 * @file src/evidence/migrations-v13.ts
 * @purpose SQL string constant for evidence schema migration v12→v13 (memory / evidence-ledger
 * tables). Exported for use by migrations.ts; no imports required — pure string literal. Split
 * from migrations.ts to keep each file under the 500-line ceiling.
 * @exports MIGRATION_V12_TO_V13
 * @depends (none)
 */

// Migration v12 -> v13: the evidence-ledger tables (memory front). ATOMICITY CONTRACT — all 9
// tables live ONLY here (NOT schema.sql, which applySchema commits FIRST), so a throw rolls back
// to exactly {12} with zero memory tables. Immutability is enforced at the STORAGE layer:
// work_journal and verifications are blanket append-only (mirrors trg_events_no_update pattern);
// agent_reports is status-advance-only (mirrors tower_proposals_immutable: frozen evidence body,
// mutable status/failure_code/failure_detail); memory_tasks and decisions are no-delete (status
// advances in place via CHECK-guarded column). Version bump is last: INSERT OR IGNORE then DELETE
// old versions so assertSchemaVersion reads exactly {13}.
export const MIGRATION_V12_TO_V13: string = `
CREATE TABLE IF NOT EXISTS projects (
  project_id         TEXT PRIMARY KEY,
  canonical_root     TEXT NOT NULL,
  git_common_dir     TEXT NOT NULL,
  remote_fingerprint TEXT NOT NULL DEFAULT '',
  aliases_json       TEXT NOT NULL DEFAULT '[]',
  quarantined        INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_tasks (
  task_id     TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(project_id),
  objective   TEXT NOT NULL,
  acceptance  TEXT,
  owned_files TEXT,
  base_commit TEXT,
  status      TEXT NOT NULL DEFAULT 'planned'
              CHECK(status IN ('planned','active','verified','blocked','done')),
  seq         INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE(task_id, project_id)
);
CREATE TABLE IF NOT EXISTS agent_turns (
  turn_id     TEXT PRIMARY KEY,
  task_id     TEXT REFERENCES memory_tasks(task_id),
  project_id  TEXT NOT NULL REFERENCES projects(project_id),
  agent       TEXT NOT NULL,
  dispatch_id TEXT,
  ordinal     INTEGER,
  base_commit TEXT,
  head_commit TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE(turn_id, project_id),
  FOREIGN KEY(task_id, project_id) REFERENCES memory_tasks(task_id, project_id)
);
CREATE TABLE IF NOT EXISTS work_journal (
  event_id       TEXT PRIMARY KEY,
  turn_id        TEXT REFERENCES agent_turns(turn_id),
  project_id     TEXT NOT NULL REFERENCES projects(project_id),
  agent          TEXT,
  kind           TEXT NOT NULL,
  body           TEXT,
  redaction_meta TEXT,
  seq            INTEGER NOT NULL,
  created_at     TEXT NOT NULL,
  UNIQUE(project_id, seq),
  FOREIGN KEY(turn_id, project_id) REFERENCES agent_turns(turn_id, project_id)
);
CREATE TABLE IF NOT EXISTS agent_reports (
  report_id      TEXT PRIMARY KEY,
  turn_id        TEXT NOT NULL REFERENCES agent_turns(turn_id),
  project_id     TEXT NOT NULL REFERENCES projects(project_id),
  agent          TEXT NOT NULL,
  dispatch_id    TEXT NOT NULL,
  narrative_json TEXT,
  claimed_json   TEXT,
  raw_blob_hash  TEXT,
  status         TEXT NOT NULL DEFAULT 'draft'
                 CHECK(status IN ('draft','submitted','verified','mismatch','missing',
                                  'unavailable','error','rejected','accepted')),
  failure_code   TEXT,
  failure_detail TEXT,
  redaction_meta TEXT,
  seq            INTEGER NOT NULL,
  created_at     TEXT NOT NULL,
  UNIQUE(turn_id, agent, dispatch_id),
  UNIQUE(project_id, seq),
  UNIQUE(report_id, project_id),
  FOREIGN KEY(turn_id, project_id) REFERENCES agent_turns(turn_id, project_id)
);
CREATE TABLE IF NOT EXISTS verifications (
  verification_id  TEXT PRIMARY KEY,
  report_id        TEXT NOT NULL REFERENCES agent_reports(report_id),
  project_id       TEXT NOT NULL REFERENCES projects(project_id),
  observed_json    TEXT,
  deltas_json      TEXT,
  result           TEXT NOT NULL CHECK(result IN ('match','mismatch','unavailable','error')),
  verify_cmd       TEXT,
  verify_exit      INTEGER,
  verify_blob_hash TEXT,
  seq              INTEGER NOT NULL,
  created_at       TEXT NOT NULL,
  UNIQUE(project_id, seq),
  FOREIGN KEY(report_id, project_id) REFERENCES agent_reports(report_id, project_id)
);
CREATE TABLE IF NOT EXISTS decisions (
  decision_id    TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(project_id),
  title          TEXT NOT NULL,
  rationale      TEXT,
  evidence_refs  TEXT,
  status         TEXT NOT NULL DEFAULT 'proposed'
                 CHECK(status IN ('proposed','accepted','superseded','rejected')),
  redaction_meta TEXT,
  created_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_snapshots (
  snapshot_id     TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(project_id),
  turn_id         TEXT,
  body_blob_hash  TEXT,
  body            TEXT,
  snapshot_status TEXT NOT NULL CHECK(snapshot_status IN ('built','stale','failed')),
  redaction_meta  TEXT,
  created_at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS generated_artifacts (
  artifact_id    TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(project_id),
  path           TEXT NOT NULL,
  content_hash   TEXT,
  redaction_meta TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_quarantined ON projects(quarantined);
CREATE INDEX IF NOT EXISTS idx_memory_tasks_project ON memory_tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_turns_project ON agent_turns(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_work_journal_turn ON work_journal(turn_id);
CREATE INDEX IF NOT EXISTS idx_work_journal_project ON work_journal(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_reports_turn ON agent_reports(turn_id);
CREATE INDEX IF NOT EXISTS idx_agent_reports_project ON agent_reports(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_verifications_report ON verifications(report_id);
CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project_id, status);
CREATE TRIGGER IF NOT EXISTS work_journal_no_update
BEFORE UPDATE ON work_journal
BEGIN
  SELECT RAISE(ABORT, 'work_journal is append-only');
END;
CREATE TRIGGER IF NOT EXISTS work_journal_no_delete
BEFORE DELETE ON work_journal
BEGIN
  SELECT RAISE(ABORT, 'work_journal is append-only');
END;
CREATE TRIGGER IF NOT EXISTS verifications_no_update
BEFORE UPDATE ON verifications
BEGIN
  SELECT RAISE(ABORT, 'verifications is append-only');
END;
CREATE TRIGGER IF NOT EXISTS verifications_no_delete
BEFORE DELETE ON verifications
BEGIN
  SELECT RAISE(ABORT, 'verifications is append-only');
END;
CREATE TRIGGER IF NOT EXISTS agent_reports_no_delete
BEFORE DELETE ON agent_reports
BEGIN
  SELECT RAISE(ABORT, 'agent_reports is append-only');
END;
CREATE TRIGGER IF NOT EXISTS agent_reports_evidence_immutable
BEFORE UPDATE ON agent_reports
BEGIN
  SELECT CASE
    WHEN NEW.report_id IS NOT OLD.report_id OR NEW.turn_id IS NOT OLD.turn_id
      OR NEW.project_id IS NOT OLD.project_id OR NEW.agent IS NOT OLD.agent
      OR NEW.dispatch_id IS NOT OLD.dispatch_id OR NEW.narrative_json IS NOT OLD.narrative_json
      OR NEW.claimed_json IS NOT OLD.claimed_json OR NEW.raw_blob_hash IS NOT OLD.raw_blob_hash
      OR NEW.redaction_meta IS NOT OLD.redaction_meta OR NEW.seq IS NOT OLD.seq
      OR NEW.created_at IS NOT OLD.created_at
      THEN RAISE(ABORT, 'agent_reports row is immutable except status/failure')
  END;
END;
CREATE TRIGGER IF NOT EXISTS memory_tasks_no_delete
BEFORE DELETE ON memory_tasks
BEGIN
  SELECT RAISE(ABORT, 'memory_tasks rows are immutable');
END;
CREATE TRIGGER IF NOT EXISTS decisions_no_delete
BEFORE DELETE ON decisions
BEGIN
  SELECT RAISE(ABORT, 'decisions rows are immutable');
END;
CREATE VIRTUAL TABLE IF NOT EXISTS work_journal_fts USING fts5(body, content=work_journal, content_rowid=rowid);
CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(title, rationale, content=decisions, content_rowid=rowid);
CREATE TRIGGER IF NOT EXISTS work_journal_fts_insert AFTER INSERT ON work_journal BEGIN INSERT INTO work_journal_fts(rowid, body) VALUES (new.rowid, new.body); END;
CREATE TRIGGER IF NOT EXISTS decisions_fts_insert AFTER INSERT ON decisions BEGIN INSERT INTO decisions_fts(rowid, title, rationale) VALUES (new.rowid, new.title, new.rationale); END;
CREATE TRIGGER IF NOT EXISTS decisions_fts_update AFTER UPDATE OF title, rationale ON decisions BEGIN INSERT INTO decisions_fts(decisions_fts, rowid, title, rationale) VALUES('delete', old.rowid, old.title, old.rationale); INSERT INTO decisions_fts(rowid, title, rationale) VALUES (new.rowid, new.title, new.rationale); END;
INSERT OR IGNORE INTO _schema_version(version) VALUES (13);
DELETE FROM _schema_version WHERE version IN (1,2,3,4,5,6,7,8,9,10,11,12);
`;

// Applied AFTER addColumnIfMissing(chat_sessions, project_id/quarantined) in applyV12ToV13
// so that chat_sessions.project_id exists before the index is created.
export const CHAT_SESSIONS_PROJECT_INDEX: string =
  "CREATE INDEX IF NOT EXISTS idx_chat_sessions_project ON chat_sessions(project_id, quarantined);";
