/**
 * @file src/evidence/migrations-v16.ts
 * @purpose SQL string constant for the LAZY v15→v16 lane-state migration (MT7 §5). Applied ONLY by
 * applyLaneStateMigration via the carrier-scoped openLaneStateDb — NEVER by the global chain and never by
 * the memory-only open, so a carrier-off DB stays at {14} or {14,15} byte-for-byte (I-6: the composed
 * gate `memoryEnabled() && nativeResumeEnabled()` decides at the CALL SITE; parent AC5 holds). No imports.
 * @exports MIGRATION_V15_TO_V16
 * @depends (none)
 */

// Migration v15 -> v16: the MT7 carrier's durable lane state + the project message ledger. VERSION MODEL
// mirrors v15 (migrations-v15.ts): 16 is ADDED, {14,15} KEPT -> a carrier-on DB is the stable set
// {14,15,16}; INSERT OR IGNORE(16) no-ops on reopen. ATOMICITY: everything below + the version bump run
// inside applyLaneStateMigration's single transaction — a throw rolls back to {14,15} with zero lane
// tables. DESIGN SOURCES: spec 2026-07-09 §5 (tables/PKs), plan rev 1.3 DB-consult fold (WITHOUT ROWID
// ledger_seq, day-one partial indexes incl. the journal ACTIVE partials whose hot predicate is
// `superseded_by IS NULL` — journal-store reads filter on it every briefing).
//
// lane_sessions: ONE active native session per agent PER PROJECT (operator-locked scope). `session_id` is
//   the transport resume primitive (ACP sessionId / agy conversation id). `generation` increments on every
//   fresh-session fallback (I-7); replacement supersedes the row (no history — anti-target).
// lane_cursors: the acceptance record (I-1: the cursor commit IS "accepted"). `last_seq` points into the
//   ledger; only meaningful for its `generation`. `needs_briefing_carry` is the durable I-8 re-carry flag.
// lane_prompt_attempts: the pre-send intent ledger (I-1 provable idempotency). `resolved` NULL = in flight
//   (unresolved rows are NEVER pruned — they are recovery evidence); CHECK pins the closed outcome enum.
// ledger_seq: the project-global message order authority. WITHOUT ROWID (a covering PK lookup table);
//   PK(project_id, seq) + UNIQUE(project_id, message_id); message_id is the EXISTING durable ChatMessage
//   id — bodies stay in per-run transcripts (no duplication; no body column — anti-target). Seq minting is
//   DB-transactional and open to ANY cockpit (lane state alone is single-writer behind the MT4 lock).
export const MIGRATION_V15_TO_V16: string = `
CREATE TABLE IF NOT EXISTS lane_sessions (
  project_id      TEXT NOT NULL REFERENCES projects(project_id),
  agent           TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  generation      INTEGER NOT NULL,
  cwd             TEXT NOT NULL,
  adapter_pkg     TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  last_resumed_at TEXT,
  PRIMARY KEY (project_id, agent)
);
CREATE TABLE IF NOT EXISTS lane_cursors (
  project_id           TEXT NOT NULL REFERENCES projects(project_id),
  agent                TEXT NOT NULL,
  generation           INTEGER NOT NULL,
  last_seq             INTEGER NOT NULL DEFAULT 0,
  needs_briefing_carry INTEGER NOT NULL DEFAULT 0,
  updated_at           TEXT NOT NULL,
  PRIMARY KEY (project_id, agent)
);
CREATE TABLE IF NOT EXISTS lane_prompt_attempts (
  attempt_id  TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(project_id),
  agent       TEXT NOT NULL,
  generation  INTEGER NOT NULL,
  session_id  TEXT NOT NULL,
  seq_from    INTEGER NOT NULL,
  seq_to      INTEGER NOT NULL,
  sent_at     TEXT NOT NULL,
  resolved    TEXT CHECK(resolved IN ('accepted','abandoned'))
);
CREATE TABLE IF NOT EXISTS ledger_seq (
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  seq        INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  PRIMARY KEY (project_id, seq),
  UNIQUE (project_id, message_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_lane_prompt_attempts_unresolved
  ON lane_prompt_attempts(project_id, agent, generation, session_id, sent_at DESC)
  WHERE resolved IS NULL;
CREATE INDEX IF NOT EXISTS idx_lane_prompt_attempts_resolved
  ON lane_prompt_attempts(project_id, agent, sent_at DESC)
  WHERE resolved IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_journal_entries_active_seq
  ON journal_entries(project_id, seq DESC)
  WHERE superseded_by IS NULL;
CREATE INDEX IF NOT EXISTS idx_journal_entries_active_anchor_seq
  ON journal_entries(project_id, seq)
  WHERE superseded_by IS NULL AND anchor = 1;
CREATE INDEX IF NOT EXISTS idx_journal_entries_active_agent_seq
  ON journal_entries(project_id, agent, seq DESC)
  WHERE superseded_by IS NULL;
INSERT OR IGNORE INTO _schema_version(version) VALUES (16);
`;
