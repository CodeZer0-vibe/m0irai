import { describe, expect, it } from "vitest";
import { CHAT_SESSIONS_PROJECT_INDEX, MIGRATION_V12_TO_V13 } from "./migrations-v13.js";

const LEDGER_TABLES = [
  "projects",
  "memory_tasks",
  "agent_turns",
  "work_journal",
  "agent_reports",
  "verifications",
  "decisions",
  "memory_snapshots",
  "generated_artifacts",
] as const;

describe("MIGRATION_V12_TO_V13 — tables, isolation, immutability", () => {
  it("declares all nine project-scoped ledger tables", () => {
    for (const table of LEDGER_TABLES) {
      expect(MIGRATION_V12_TO_V13).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  it("enforces cross-project isolation via composite foreign keys", () => {
    expect(MIGRATION_V12_TO_V13).toContain(
      "FOREIGN KEY(task_id, project_id) REFERENCES memory_tasks(task_id, project_id)",
    );
    expect(MIGRATION_V12_TO_V13).toContain(
      "FOREIGN KEY(turn_id, project_id) REFERENCES agent_turns(turn_id, project_id)",
    );
    expect(MIGRATION_V12_TO_V13).toContain(
      "FOREIGN KEY(report_id, project_id) REFERENCES agent_reports(report_id, project_id)",
    );
  });

  it("enforces append-only and status-advance immutability triggers", () => {
    expect(MIGRATION_V12_TO_V13).toContain("work_journal_no_update");
    expect(MIGRATION_V12_TO_V13).toContain("work_journal_no_delete");
    expect(MIGRATION_V12_TO_V13).toContain("verifications_no_delete");
    expect(MIGRATION_V12_TO_V13).toContain("agent_reports_evidence_immutable");
    expect(MIGRATION_V12_TO_V13).toContain("agent_reports_no_delete");
  });

  it("declares idempotency and per-project sequence uniqueness", () => {
    expect(MIGRATION_V12_TO_V13).toContain("UNIQUE(turn_id, agent, dispatch_id)");
    expect(MIGRATION_V12_TO_V13).toContain("UNIQUE(project_id, seq)");
  });
});

describe("MIGRATION_V12_TO_V13 — search, versioning, indexes", () => {
  it("declares FTS5 search tables and their sync triggers", () => {
    expect(MIGRATION_V12_TO_V13).toContain("work_journal_fts USING fts5");
    expect(MIGRATION_V12_TO_V13).toContain("decisions_fts USING fts5");
    expect(MIGRATION_V12_TO_V13).toContain("work_journal_fts_insert");
    expect(MIGRATION_V12_TO_V13).toContain("decisions_fts_update");
  });

  it("bumps schema version to 13 and clears prior versions", () => {
    expect(MIGRATION_V12_TO_V13).toContain(
      "INSERT OR IGNORE INTO _schema_version(version) VALUES (13)",
    );
    expect(MIGRATION_V12_TO_V13).toContain(
      "DELETE FROM _schema_version WHERE version IN (1,2,3,4,5,6,7,8,9,10,11,12)",
    );
  });

  it("indexes chat_sessions by project and quarantine", () => {
    expect(CHAT_SESSIONS_PROJECT_INDEX).toContain("idx_chat_sessions_project");
    expect(CHAT_SESSIONS_PROJECT_INDEX).toContain("chat_sessions(project_id, quarantined)");
  });
});
