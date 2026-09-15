/**
 * @file src/evidence/runs-bootstrap.test.ts
 * @purpose Falsifying tests for ensureRunRow — proves it closes the FK gap that lets buildPacketWorkflow
 *          claim dispatches, AND that its schema-drift guard fails LOUDLY (EvidenceSchemaDrift) on an old
 *          runs table whose extra NOT NULL column INSERT OR IGNORE would otherwise silently swallow,
 *          instead of leaving a missing parent that surfaces later as an opaque FOREIGN KEY error.
 * @exports (test suite — no runtime exports)
 * @depends node:fs, node:os, node:path, better-sqlite3, vitest, ../shared/error-codes, ./commit-intents, ./db, ./dispatch-claims, ./runs-bootstrap
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { Zer0ErrorCode } from "../shared/error-codes.js";
import { type Db, closeDb, openDb } from "./db.js";
import { ensureRunRow } from "./runs-bootstrap.js";

function tmpDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "zer0-runs-bootstrap-")), "evidence.db");
}

// A current-schema runs table (status defaulted, branch/base_commit nullable) — the bootstrap insert fits.
const RUNS_CURRENT =
  "CREATE TABLE runs (id TEXT PRIMARY KEY, vision TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'init', branch TEXT, base_commit TEXT, started_at TEXT NOT NULL)";
// An OLDER evidence DB: runs has an extra required column the bootstrap INSERT does not provide.
const RUNS_DRIFTED =
  "CREATE TABLE runs (id TEXT PRIMARY KEY, vision TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'init', branch TEXT, base_commit TEXT, started_at TEXT NOT NULL, current_phase TEXT NOT NULL)";

function rawDb(ddl: string): Db {
  const db = new Database(":memory:");
  db.exec(ddl);
  return db;
}

describe("ensureRunRow", () => {
  it("inserts a runs row when none exists for the runId", () => {
    const db = openDb(tmpDbPath());
    try {
      const runId = "run-bootstrap-fresh";
      ensureRunRow(db, runId);
      const row = db.prepare("SELECT id, vision FROM runs WHERE id = ?").get(runId) as
        | { readonly id: string; readonly vision: string }
        | undefined;
      expect(row?.id).toBe(runId);
      expect(row?.vision).toBe("buildPacketWorkflow");
    } finally {
      closeDb(db);
    }
  });

  it("is idempotent when the runs row already exists", () => {
    const db = openDb(tmpDbPath());
    try {
      const runId = "run-bootstrap-idempotent";
      db.prepare("INSERT INTO runs (id, vision, started_at) VALUES (?, ?, datetime('now'))").run(
        runId,
        "pre-existing-vision",
      );
      ensureRunRow(db, runId);
      const row = db.prepare("SELECT vision FROM runs WHERE id = ?").get(runId) as
        | { readonly vision: string }
        | undefined;
      expect(row?.vision).toBe("pre-existing-vision");
    } finally {
      closeDb(db);
    }
  });

  it("rejects empty runId", () => {
    const db = openDb(tmpDbPath());
    try {
      expect(() => ensureRunRow(db, "")).toThrow();
    } finally {
      closeDb(db);
    }
  });
});

describe("ensureRunRow — schema drift is surfaced LOUDLY, never a silent missing parent", () => {
  it("throws when an extra NOT NULL column makes the bootstrap insert impossible", () => {
    const db = rawDb(RUNS_DRIFTED);
    try {
      // Falsifying: without the guard, INSERT OR IGNORE swallows the NOT-NULL violation and returns
      // normally, leaving NO row — proven by asserting the row is genuinely absent after the throw.
      expect(() => ensureRunRow(db, "run-y")).toThrow(/SCHEMA_DRIFT/);
      expect(db.prepare("SELECT id FROM runs WHERE id = ?").get("run-y")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("does NOT throw on a current-schema runs table (the guard only fires on real drift)", () => {
    const db = rawDb(RUNS_CURRENT);
    try {
      expect(() => ensureRunRow(db, "run-ok")).not.toThrow();
      expect(db.prepare("SELECT id FROM runs WHERE id = ?").get("run-ok")).toBeDefined();
    } finally {
      db.close();
    }
  });

  it("tags the throw with EvidenceSchemaDrift (nonRetryable at the activity boundary)", () => {
    const db = rawDb(RUNS_DRIFTED);
    let code: string | undefined;
    try {
      ensureRunRow(db, "run-z");
    } catch (error) {
      code = (error as { readonly code?: string }).code;
    } finally {
      db.close();
    }
    expect(code).toBe(Zer0ErrorCode.EvidenceSchemaDrift);
  });
});
