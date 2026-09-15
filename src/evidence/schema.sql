PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS _schema_version (
  version INTEGER PRIMARY KEY
);

INSERT OR IGNORE INTO _schema_version(version) VALUES (5);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  vision TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'init',
  branch TEXT,
  base_commit TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS requirements (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  text TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  task_id TEXT,
  evidence_file TEXT,
  evidence_line INTEGER,
  evidence_test TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  objective TEXT NOT NULL,
  agent TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  owned_files TEXT NOT NULL,
  forbidden_files TEXT NOT NULL,
  acceptance TEXT NOT NULL,
  result TEXT,
  head_commit TEXT
);

CREATE TABLE IF NOT EXISTS context_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  agent TEXT NOT NULL,
  head_commit TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  token_budget INTEGER NOT NULL,
  blob_path TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS context_items (
  id TEXT PRIMARY KEY,
  context_run_id TEXT NOT NULL REFERENCES context_runs(id),
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  symbol TEXT,
  content_hash TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  score REAL NOT NULL,
  reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id),
  severity TEXT NOT NULL,
  path TEXT,
  line INTEGER,
  finding TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  source_agent TEXT NOT NULL,
  reviewer_context_hash TEXT
);

CREATE TABLE IF NOT EXISTS gate_transitions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  gate_name TEXT NOT NULL,
  passed INTEGER NOT NULL,
  evidence_json TEXT NOT NULL,
  human_override INTEGER DEFAULT 0,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dispatches (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  context_run_id TEXT,
  command_hash TEXT NOT NULL,
  exit_code INTEGER NOT NULL,
  stdout_blob TEXT NOT NULL,
  stderr_blob TEXT,
  diff_blob TEXT,
  duration_ms INTEGER NOT NULL,
  retries INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER,
  tokens_out INTEGER,
  enrichment_flags TEXT,
  argv_json TEXT,
  cwd TEXT,
  env_allowlist_version TEXT,
  context_blob_hash TEXT,
  model_version TEXT,
  repo_commit TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Existing deployments require a table rebuild migration before this FK appears on disk.
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS errors (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES runs(id),
  task_id TEXT,
  dispatch_id TEXT,
  gate_transition_id TEXT,
  code TEXT NOT NULL,
  category TEXT NOT NULL,
  retryability TEXT NOT NULL,
  message TEXT NOT NULL,
  cause_code TEXT,
  evidence_json TEXT NOT NULL,
  evidence_blob TEXT,
  fingerprint TEXT NOT NULL,
  trace_id TEXT,
  span_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  phase TEXT,
  task_id TEXT,
  error_id TEXT,
  trace_id TEXT,
  span_id TEXT,
  parent_span_id TEXT,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dispatch_claims (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  task_id TEXT NOT NULL,
  attempt_hash TEXT NOT NULL,
  model_version TEXT,
  adapter_version TEXT,
  cli_version TEXT,
  prompt_text BLOB,
  prompt_fingerprint TEXT,
  error TEXT,
  phase TEXT,
  attempt INTEGER,
  status TEXT NOT NULL DEFAULT 'claimed',
  result_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  UNIQUE(run_id, task_id, attempt_hash)
);

CREATE TABLE IF NOT EXISTS commit_intents (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  phase TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  intent_key TEXT NOT NULL,
  message TEXT NOT NULL,
  files_json TEXT NOT NULL,
  applied_sha TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  applied_at TEXT,
  UNIQUE(run_id, phase, attempt)
);

CREATE TABLE IF NOT EXISTS capacity_snapshots (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  account_id TEXT NOT NULL DEFAULT 'default',
  snapshot_at TEXT NOT NULL,
  context_used_tokens INTEGER,
  context_max_tokens INTEGER,
  weekly_quota_used_pct REAL,
  weekly_quota_resets_at TEXT,
  rate_limit_remaining INTEGER,
  rate_limit_resets_at TEXT,
  cost_usd REAL,
  pricing_version TEXT,
  source TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tournament_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  task_id TEXT NOT NULL,
  feature_type TEXT,
  winner_agent TEXT NOT NULL,
  agents_json TEXT NOT NULL,
  criteria_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_failure_patterns (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  failure_category TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  last_seen TEXT NOT NULL,
  example_finding_id TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS findings_fts USING fts5(
  finding,
  content=findings,
  content_rowid=rowid
);

CREATE INDEX IF NOT EXISTS idx_findings_severity ON findings(severity);
CREATE INDEX IF NOT EXISTS idx_findings_task ON findings(task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_run ON tasks(run_id);
CREATE INDEX IF NOT EXISTS idx_dispatches_task ON dispatches(task_id);
CREATE INDEX IF NOT EXISTS idx_context_items_run ON context_items(context_run_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gate_transitions_unique ON gate_transitions(run_id, gate_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatches_unique ON dispatches(task_id, agent, command_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_claims_unique ON dispatch_claims(run_id, task_id, attempt_hash);
CREATE INDEX IF NOT EXISTS idx_commit_intents_intent_key ON commit_intents(intent_key);
CREATE INDEX IF NOT EXISTS idx_capacity_agent_time ON capacity_snapshots(agent, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS idx_errors_code_created ON errors(code, created_at);
CREATE INDEX IF NOT EXISTS idx_errors_run_created ON errors(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_errors_fingerprint ON errors(fingerprint);
CREATE INDEX IF NOT EXISTS idx_events_run_sequence ON events(run_id, sequence);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_run_sequence_unique ON events(run_id, sequence);
CREATE INDEX IF NOT EXISTS idx_events_kind_created ON events(kind, created_at);

CREATE TRIGGER IF NOT EXISTS trg_events_no_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_events_no_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_errors_no_update
BEFORE UPDATE ON errors
BEGIN
  SELECT RAISE(ABORT, 'errors are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_errors_no_delete
BEFORE DELETE ON errors
BEGIN
  SELECT RAISE(ABORT, 'errors are append-only');
END;

-- Chat module persistence (added v8) — make SQLite authoritative for chat state.
-- transcript.json becomes a derived cache; SQLite holds the truth.

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
  round           INTEGER NOT NULL DEFAULT 0,
  role            TEXT NOT NULL CHECK (role IN ('user','agent','system','error')),
  agent           TEXT NOT NULL,
  text_blob_hash  TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('completed','failed','cancelled')),
  token_estimate  INTEGER NOT NULL,
  dispatch_id     TEXT REFERENCES dispatches(id),
  dispatched_agents TEXT
);

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

-- BUILD pillar persistence (added v10) — one run per confirmed team-build batch, one assignment
-- per lane, one artifact per assignment. The durable artifact is the captured patch blob (INV-6);
-- a detached-worktree commit SHA dangles after `worktree remove`, so we never rely on it.
-- session_id FK is ON DELETE RESTRICT: a build run pins its session (audit history must survive).
-- assignment/artifact FKs CASCADE: removing a run reaps its lanes and their artifacts.

CREATE TABLE IF NOT EXISTS chat_build_runs (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE RESTRICT,
  turn               INTEGER NOT NULL,
  base_sha           TEXT NOT NULL,
  dirty_fingerprint  TEXT NOT NULL,
  created_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_build_assignments (
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

CREATE TABLE IF NOT EXISTS chat_artifacts (
  id                 TEXT PRIMARY KEY,
  assignment_id      TEXT NOT NULL UNIQUE REFERENCES chat_build_assignments(id) ON DELETE CASCADE,
  patch_blob_hash    TEXT,
  changed_files_json TEXT NOT NULL,
  stdout_blob_hash   TEXT,
  stderr_blob_hash   TEXT,
  mergeable          INTEGER NOT NULL DEFAULT 0,
  on_task            TEXT NOT NULL DEFAULT 'unverified',
  gate_status        TEXT NOT NULL DEFAULT 'not_run' CHECK (gate_status IN (
                       'not_run','passed','failed','skipped')),
  export_path        TEXT,
  content_hash       TEXT,
  policy_violation   TEXT
);
