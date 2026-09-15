/**
 * @file src/evidence/migrations-v20.ts
 * @purpose SQL for the lazy v20 lane-scope migration. V2 room provider sessions, cursors, and prompt
 *   attempts become chat-session scoped while the project ledger and memory remain project scoped.
 * @exports MIGRATION_V16_TO_V20
 * @depends (none)
 */

/**
 * Versions 17-19 are retired review-tier history, so the next produced schema version is 20. Existing
 * project-global lane rows are copied into the empty legacy scope. They are deliberately not assigned to
 * any V2 chat: there is no durable evidence that can identify which historical room owned them, and a
 * wrong guess would reintroduce cross-room provider context.
 */
export const MIGRATION_V16_TO_V20: string = `
CREATE TABLE lane_sessions_v20 (
  project_id      TEXT NOT NULL REFERENCES projects(project_id),
  lane_scope_id   TEXT NOT NULL DEFAULT '',
  agent           TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  generation      INTEGER NOT NULL,
  cwd             TEXT NOT NULL,
  adapter_pkg     TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  last_resumed_at TEXT,
  PRIMARY KEY (project_id, lane_scope_id, agent)
);
INSERT INTO lane_sessions_v20
  (project_id, lane_scope_id, agent, session_id, generation, cwd, adapter_pkg, adapter_version,
   created_at, last_resumed_at)
SELECT project_id, '', agent, session_id, generation, cwd, adapter_pkg, adapter_version,
       created_at, last_resumed_at
FROM lane_sessions;

CREATE TABLE lane_cursors_v20 (
  project_id           TEXT NOT NULL REFERENCES projects(project_id),
  lane_scope_id        TEXT NOT NULL DEFAULT '',
  agent                TEXT NOT NULL,
  generation           INTEGER NOT NULL,
  last_seq             INTEGER NOT NULL DEFAULT 0,
  needs_briefing_carry INTEGER NOT NULL DEFAULT 0,
  updated_at           TEXT NOT NULL,
  PRIMARY KEY (project_id, lane_scope_id, agent)
);
INSERT INTO lane_cursors_v20
  (project_id, lane_scope_id, agent, generation, last_seq, needs_briefing_carry, updated_at)
SELECT project_id, '', agent, generation, last_seq, needs_briefing_carry, updated_at
FROM lane_cursors;

CREATE TABLE lane_prompt_attempts_v20 (
  attempt_id    TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(project_id),
  lane_scope_id TEXT NOT NULL DEFAULT '',
  agent         TEXT NOT NULL,
  generation    INTEGER NOT NULL,
  session_id    TEXT NOT NULL,
  seq_from      INTEGER NOT NULL,
  seq_to        INTEGER NOT NULL,
  sent_at       TEXT NOT NULL,
  resolved      TEXT CHECK(resolved IN ('accepted','abandoned'))
);
INSERT INTO lane_prompt_attempts_v20
  (attempt_id, project_id, lane_scope_id, agent, generation, session_id, seq_from, seq_to, sent_at,
   resolved)
SELECT attempt_id, project_id, '', agent, generation, session_id, seq_from, seq_to, sent_at, resolved
FROM lane_prompt_attempts;

DROP TABLE lane_prompt_attempts;
DROP TABLE lane_cursors;
DROP TABLE lane_sessions;
ALTER TABLE lane_sessions_v20 RENAME TO lane_sessions;
ALTER TABLE lane_cursors_v20 RENAME TO lane_cursors;
ALTER TABLE lane_prompt_attempts_v20 RENAME TO lane_prompt_attempts;

CREATE INDEX idx_lane_prompt_attempts_unresolved
  ON lane_prompt_attempts(project_id, lane_scope_id, agent, generation, session_id, sent_at DESC)
  WHERE resolved IS NULL;
CREATE INDEX idx_lane_prompt_attempts_resolved
  ON lane_prompt_attempts(project_id, lane_scope_id, agent, sent_at DESC)
  WHERE resolved IS NOT NULL;
INSERT OR IGNORE INTO _schema_version(version) VALUES (20);
`;
