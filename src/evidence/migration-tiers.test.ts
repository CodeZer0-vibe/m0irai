// FL-077 round 3 — unit pins for the atomic migration tiers. The race-level proofs live in
// open-race-atomicity.test.ts; these cover each tier function directly on an in-memory database:
// completion to the exact accepted sets, idempotent re-runs through the savepoint path, and the
// whole-tier rollback when the locked validation rejects the converged set.
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { ConfigError } from "../shared/errors.js";
import type { Db } from "./db.js";
import { LANE_PROMPT_ATTEMPT_ABORTED_COLUMN, columnExists } from "./migration-readiness.js";
import { runGlobalTier, runLaneTier, runMemoryTier } from "./migration-tiers.js";

// The slice of the opener tolerance contract these tiers are exercised against (mirrors
// db.ts's ACCEPTED_VERSION_KEYS entries relevant to fresh-database progression). M4: the memory
// tier also lands version 21, and db.ts accepts ONLY `,21` sets for memory and lane — an
// un-suffixed set there would let an un-projected database read complete and v21 would never run.
const KEYS = {
  global: ["14", "14,15", "14,15,16", "14,15,16,20", "14,15,21", "14,15,16,21", "14,15,16,20,21"],
  memory: ["14,15,21", "14,15,16,21", "14,15,16,20,21"],
  lane: ["14,15,16,20,21"],
};

let db: Db | undefined;

afterEach(() => {
  if (db !== undefined) {
    db.close();
    db = undefined;
  }
});

function freshDb(): Db {
  db = new Database(":memory:");
  return db;
}

function versions(database: Db): number[] {
  return (
    database.prepare("SELECT version FROM _schema_version ORDER BY version").all() as Array<{
      version: number;
    }>
  ).map((row) => row.version);
}

function tableExists(database: Db, table: string): boolean {
  return (
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
    undefined
  );
}

it("runGlobalTier takes a fresh database to exactly {14} with the final-schema tables present", () => {
  const database = freshDb();
  expect(tableExists(database, "_schema_version")).toBe(false);
  runGlobalTier(database, KEYS);
  expect(versions(database)).toEqual([14]);
  // Positive control: the tier really built the final schema, not just the version rows.
  expect(tableExists(database, "gate_transitions")).toBe(true);
  expect(tableExists(database, "chat_messages")).toBe(true);
});

it("runMemoryTier then runLaneTier land {14,15,21} and {14,15,16,20,21}, each as its own committed tier", () => {
  const database = freshDb();
  runGlobalTier(database, KEYS);
  runMemoryTier(database, KEYS);
  expect(versions(database)).toEqual([14, 15, 21]);
  runLaneTier(database, KEYS);
  expect(versions(database)).toEqual([14, 15, 16, 20, 21]);
  expect(
    columnExists(
      database,
      LANE_PROMPT_ATTEMPT_ABORTED_COLUMN.table,
      LANE_PROMPT_ATTEMPT_ABORTED_COLUMN.name,
    ),
  ).toBe(true);
});

it("re-running every tier on an already-complete database changes nothing (savepoint path)", () => {
  const database = freshDb();
  runGlobalTier(database, KEYS);
  runMemoryTier(database, KEYS);
  runLaneTier(database, KEYS);
  runGlobalTier(database, KEYS);
  runMemoryTier(database, KEYS);
  runLaneTier(database, KEYS);
  expect(versions(database)).toEqual([14, 15, 16, 20, 21]);
});

// THE ATOMICITY PIN at unit level: the strict reader under the lock rejects the converged hybrid
// set, and the throw rolls back the WHOLE tier — schema tables created earlier in the same
// transaction vanish again instead of committing behind a rejected version set.
it("a locked validation failure rolls the entire global tier back to the entry state", () => {
  const database = freshDb();
  // Sculpt a natural-shaped _schema_version holding the unaccepted integer 99.
  database.exec("CREATE TABLE _schema_version (version INTEGER PRIMARY KEY)");
  database.exec("INSERT INTO _schema_version(version) VALUES (99)");

  let threw: unknown;
  try {
    runGlobalTier(database, KEYS);
  } catch (err) {
    threw = err;
  }
  expect(threw).toBeInstanceOf(ConfigError);
  expect((threw as ConfigError).message).toMatch(/SCHEMA_DRIFT/);
  // The tier ran to its end (the chain had inserted 14 alongside the sculpted 99) and the locked
  // validation caught the hybrid before anything could commit.
  expect((threw as ConfigError).message).toContain("received 14,99");
  expect(versions(database)).toEqual([99]);
  expect(tableExists(database, "chat_messages")).toBe(false);
});
