// FL-077 round 2 (review finding 4) — THE PRICE OF A ZERO-WRITE STEADY STATE, WRITTEN DOWN.
//
// Before FL-077 every open re-ran schema.sql, so anything deleted out from under a migrated
// database was silently recreated on the next open. That implicit self-repair is gone, because it
// WAS a write, and a write on the steady-state path is what made an open fail under a concurrent
// writer (FL-074). These tests pin the new behaviour as a DECISION rather than letting the next
// reader discover it as a regression:
//   - a dropped index/table on a database whose version rows still say "complete" is NOT recreated,
//     and the open still succeeds (the failure surfaces later, at query time);
//   - the repair still happens when the version rows say the tier is INCOMPLETE — the boundary is
//     `chainReadiness`, not "we stopped running schema.sql".
// Deliberately NOT fixed by adding a repair path here: see the WHAT THIS DELIBERATELY GIVES UP
// note above openWithMode in db.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { type Db, closeDb, openDb, openLaneStateDb } from "./db.js";

let root: string | undefined;

afterEach(() => {
  if (root !== undefined) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    root = undefined;
  }
});

function tempDbPath(): string {
  root = mkdtempSync(join(tmpdir(), "zer0-steady-state-repair-"));
  return join(root, "evidence.db");
}

function objectExists(db: Db, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE name = ? LIMIT 1")
    .get(name) as { present: number } | undefined;
  return row !== undefined;
}

// Removes two objects schema.sql owns, without touching _schema_version: the DB still LOOKS
// complete to chainReadiness, which is the whole point of the test.
function vandalise(dbPath: string): void {
  const sculptor = new Database(dbPath);
  sculptor.exec("DROP INDEX IF EXISTS idx_dispatches_unique");
  sculptor.exec("DROP TABLE IF EXISTS gate_transitions");
  sculptor.close();
}

it("FL-077: a steady-state open does NOT recreate a dropped index or table (self-repair is gone on purpose)", () => {
  const dbPath = tempDbPath();
  closeDb(openLaneStateDb(dbPath));
  vandalise(dbPath);

  const opened = openDb(dbPath); // must still OPEN: the version rows are intact
  try {
    expect(objectExists(opened, "idx_dispatches_unique")).toBe(false);
    expect(objectExists(opened, "gate_transitions")).toBe(false);
    // ...and the damage is only visible when something actually reads the table.
    expect(() => opened.prepare("SELECT 1 FROM gate_transitions LIMIT 1").get()).toThrow(
      /no such table/,
    );
  } finally {
    closeDb(opened);
  }
});

it("FL-077: the same damage IS repaired once the version rows say the global tier is incomplete", () => {
  const dbPath = tempDbPath();
  closeDb(openLaneStateDb(dbPath));
  vandalise(dbPath);

  // The positive control for the test above: rewinding the version set is what makes
  // chainReadiness report the global tier incomplete, and only then does applySchema run again.
  const sculptor = new Database(dbPath);
  sculptor.exec("DELETE FROM _schema_version");
  sculptor.exec("INSERT INTO _schema_version(version) VALUES (5)");
  sculptor.close();

  const opened = openDb(dbPath);
  try {
    expect(objectExists(opened, "idx_dispatches_unique")).toBe(true);
    expect(objectExists(opened, "gate_transitions")).toBe(true);
  } finally {
    closeDb(opened);
  }
});
