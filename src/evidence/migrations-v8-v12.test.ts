import { describe, expect, it } from "vitest";
import {
  ASSIGNMENTS_NEEDS_REBUILD_PROBE,
  MIGRATION_V7_TO_V8,
  MIGRATION_V8_TO_V9,
  MIGRATION_V9_TO_V10,
  MIGRATION_V10_TO_V11_FINALIZE,
  MIGRATION_V10_TO_V11_REBUILD_ASSIGNMENTS,
  MIGRATION_V11_TO_V12,
} from "./migrations-v8-v12.js";

describe("evidence migrations v8–v12 — DDL contract", () => {
  it("v7→v8 creates the chat persistence tables", () => {
    expect(MIGRATION_V7_TO_V8).toContain("CREATE TABLE IF NOT EXISTS chat_sessions");
    expect(MIGRATION_V7_TO_V8).toContain("CREATE TABLE IF NOT EXISTS chat_messages");
    expect(MIGRATION_V7_TO_V8).toContain("VALUES (8)");
  });

  it("v8→v9 creates the working-sets and active-debates tables", () => {
    expect(MIGRATION_V8_TO_V9).toContain("chat_working_sets");
    expect(MIGRATION_V8_TO_V9).toContain("active_debates");
    expect(MIGRATION_V8_TO_V9).toContain("VALUES (9)");
  });

  it("v9→v10 indexes the build-pillar tables", () => {
    expect(MIGRATION_V9_TO_V10).toContain("chat_build_runs");
    expect(MIGRATION_V9_TO_V10).toContain("VALUES (10)");
  });

  it("v10→v11 rebuilds assignments with the policy-rejected + capability domains", () => {
    expect(MIGRATION_V10_TO_V11_REBUILD_ASSIGNMENTS).toContain("chat_build_assignments");
    expect(MIGRATION_V10_TO_V11_REBUILD_ASSIGNMENTS).toContain("policy-rejected");
    expect(ASSIGNMENTS_NEEDS_REBUILD_PROBE).toContain("sqlite_master");
    expect(MIGRATION_V10_TO_V11_FINALIZE).toContain("VALUES (11)");
  });

  it("v11→v12 creates the tower tables with append-only decisions", () => {
    expect(MIGRATION_V11_TO_V12).toContain("CREATE TABLE IF NOT EXISTS tower_proposals");
    expect(MIGRATION_V11_TO_V12).toContain("CREATE TABLE IF NOT EXISTS tower_decisions");
    expect(MIGRATION_V11_TO_V12).toContain("tower_decisions_no_update");
    expect(MIGRATION_V11_TO_V12).toContain("tower_decisions_no_delete");
    expect(MIGRATION_V11_TO_V12).toContain("VALUES (12)");
  });
});
