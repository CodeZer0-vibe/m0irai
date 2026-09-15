/**
 * @file src/evidence/migrations-v15.ts
 * @purpose SQL string constant for the LAZY v14→v15 memory-journal migration (MEMORY-FULL §5). Split
 * from migrations.ts (the sealed v13 pattern) to keep each file under the ceiling. Applied ONLY by
 * applyMemoryMigration via the memory-scoped openMemoryDb — NEVER by the global applyMigrations chain,
 * so a memory-off DB stays byte-for-byte at v14 (AC5). No imports — pure string literal.
 * @exports MIGRATION_V14_TO_V15
 * @depends (none)
 */

// Migration v14 -> v15: the journal source-of-record + digest watermark (§5). ATOMICITY: both tables +
// the version bump run inside applyMemoryMigration's single transaction, so a throw rolls back to {14}
// with zero journal tables. VERSION MODEL (deliberate deviation from the chain's DELETE-lower step): 15
// is ADDED while 14 is KEPT, so a memory-on DB is ALWAYS {14,15}. That set is stable under BOTH open
// paths — the global chain re-asserts 14 (INSERT OR IGNORE(14), a no-op here) and never removes 15, and
// this migration's INSERT OR IGNORE(15) is a no-op on reopen — so no oscillation and the global assert
// accepts a lazily-migrated DB by a fixed rule (base 14 present, 15 optional). journal_entries carries
// the §5 columns: category is J4's enum (validated by the MT4 classifier — storage column only here, no
// premature CHECK), author is the §5-pinned enum, superseded_by is the J5 supersession link (retire, not
// delete — enforced by the no-delete trigger; nothing is silently removed). digest_watermark models D3's
// EXACT watermark: one row per (project, session, digested message id) — set membership by PK, gap-
// tolerant + re-digest-proof. FKs to projects(project_id) keep the M3 project isolation. CRUD (inserts,
// supersession writes, watermark discipline) is MT2/MT3 — this migration is schema only.
export const MIGRATION_V14_TO_V15: string = `
CREATE TABLE IF NOT EXISTS journal_entries (
  entry_id      TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(project_id),
  category      TEXT NOT NULL,
  author        TEXT NOT NULL CHECK(author IN ('agent','operator','ledger')),
  agent         TEXT,
  body          TEXT NOT NULL,
  topic_key     TEXT,
  touched_files TEXT,
  domain_tags   TEXT,
  anchor        INTEGER NOT NULL DEFAULT 0,
  superseded_by TEXT REFERENCES journal_entries(entry_id),
  seq           INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE(project_id, seq)
);
CREATE TABLE IF NOT EXISTS digest_watermark (
  project_id  TEXT NOT NULL REFERENCES projects(project_id),
  session_id  TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (project_id, session_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_journal_entries_project ON journal_entries(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_journal_entries_category ON journal_entries(project_id, category);
CREATE INDEX IF NOT EXISTS idx_journal_entries_anchor ON journal_entries(project_id, anchor);
CREATE INDEX IF NOT EXISTS idx_journal_entries_topic ON journal_entries(project_id, topic_key);
CREATE INDEX IF NOT EXISTS idx_digest_watermark_session ON digest_watermark(project_id, session_id);
CREATE TRIGGER IF NOT EXISTS journal_entries_no_delete
BEFORE DELETE ON journal_entries
BEGIN
  SELECT RAISE(ABORT, 'journal_entries retire via superseded_by, never DELETE (J5)');
END;
INSERT OR IGNORE INTO _schema_version(version) VALUES (15);
`;
