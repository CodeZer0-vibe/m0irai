import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { Zer0ErrorCode } from "../shared/error-codes.js";
import { ConfigError } from "../shared/errors.js";
import { INCOMPATIBLE_SCHEMA_HINT, detectIncompatibleSchema } from "./db-drift.js";

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

it("returns silently on a fresh DB with no events table", () => {
  const db = openTempDb();
  try {
    expect(() => detectIncompatibleSchema(db)).not.toThrow();
  } finally {
    db.close();
  }
});

it("returns silently on a v3 events table that has all sentinel columns", () => {
  const db = openTempDb();
  try {
    db.exec(
      "CREATE TABLE events (id TEXT PRIMARY KEY, run_id TEXT, sequence INTEGER, kind TEXT, payload_json TEXT)",
    );
    expect(() => detectIncompatibleSchema(db)).not.toThrow();
  } finally {
    db.close();
  }
});

it("throws ConfigError(EvidenceSchemaDrift) when events table lacks v3 columns", () => {
  const db = openTempDb();
  try {
    db.exec(
      "CREATE TABLE events (event_id TEXT PRIMARY KEY, run_id TEXT, timestamp TEXT, source TEXT)",
    );
    expect(() => detectIncompatibleSchema(db)).toThrow(ConfigError);
    try {
      detectIncompatibleSchema(db);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const error = err as ConfigError;
      expect(error.code).toBe(Zer0ErrorCode.EvidenceSchemaDrift);
      expect(error.message).toContain("INCOMPATIBLE_SCHEMA");
      expect(error.message).toContain("events.sequence");
      expect(error.message).toContain("events.kind");
      expect(error.message).toContain("events.payload_json");
    }
  } finally {
    db.close();
  }
});

it("renders the user-facing remediation hint with archive instructions", () => {
  expect(INCOMPATIBLE_SCHEMA_HINT).toContain("Detected pre-v3 evidence database");
  expect(INCOMPATIBLE_SCHEMA_HINT).toContain("evidence.db.pre-v3.bak");
  expect(INCOMPATIBLE_SCHEMA_HINT).toContain("Re-run any zer0 command");
});

function openTempDb(): Database.Database {
  tempRoot = mkdtempSync(join(tmpdir(), "zer0-drift-"));
  return new Database(join(tempRoot, "test.db"));
}
