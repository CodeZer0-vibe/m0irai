import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Db, closeDb, openDb } from "./db.js";
import { prepareStatements } from "./queries-statements.js";

const TEMP_PREFIX: string = "zer0-queries-statements-";
const RUN_ID: string = "run-stmt";
const STARTED_AT: string = "2026-05-28T00:00:00.000Z";

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

function openTestDb(): Db {
  tempRoot = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  return openDb(join(tempRoot, "evidence.db"));
}

const BASE_STATEMENT_KEYS = [
  "insertRun",
  "updateRunStatus",
  "insertTask",
  "insertContextRun",
  "insertContextItem",
  "getContextRun",
  "listContextItems",
  "updateTaskStatus",
  "insertFinding",
  "selectFindingRowid",
  "insertFindingFts",
  "findFindingsByRunId",
  "searchFindings",
  "insertGateTransition",
  "insertDispatch",
  "findDispatchId",
  "insertChatSession",
  "insertChatMessage",
  "insertChatWorkingSet",
  "listChatWorkingSets",
  "insertActiveDebate",
  "getActiveDebate",
  "deleteActiveDebate",
] as const;

const OBSERVABILITY_STATEMENT_KEYS = [
  "nextEventSequence",
  "insertEvent",
  "getEventById",
  "insertError",
  "queryErrors",
  "queryErrorsByRun",
  "queryErrorsByCode",
  "queryErrorsByRunAndCode",
  "queryEventsByRun",
  "getLatestStateSnapshot",
] as const;

describe("prepareStatements composition", () => {
  it("returns a prepared statement for every base and observability key", () => {
    const db = openTestDb();
    try {
      const statements = prepareStatements(db);
      for (const key of [...BASE_STATEMENT_KEYS, ...OBSERVABILITY_STATEMENT_KEYS]) {
        expect(typeof statements[key].run).toBe("function");
      }
    } finally {
      closeDb(db);
    }
  });
});

describe("prepared statements execute against the real schema", () => {
  it("insertRun statement persists a row readable via SQL", () => {
    const db = openTestDb();
    try {
      const statements = prepareStatements(db);
      const result = statements.insertRun.run({
        id: RUN_ID,
        vision: "ship evidence",
        startedAt: STARTED_AT,
      });

      expect(result.changes).toBe(1);
      expect(db.prepare("SELECT id, started_at FROM runs WHERE id = ?").get(RUN_ID)).toEqual({
        id: RUN_ID,
        started_at: STARTED_AT,
      });
    } finally {
      closeDb(db);
    }
  });

  it("nextEventSequence statement returns 1 for an empty run", () => {
    const db = openTestDb();
    try {
      const statements = prepareStatements(db);
      expect(statements.nextEventSequence.get(RUN_ID)).toEqual({ sequence: 1 });
    } finally {
      closeDb(db);
    }
  });

  it("queryErrors statement returns an empty array on a fresh database", () => {
    const db = openTestDb();
    try {
      const statements = prepareStatements(db);
      expect(statements.queryErrors.all(10)).toEqual([]);
    } finally {
      closeDb(db);
    }
  });
});
