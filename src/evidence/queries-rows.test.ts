import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Db, closeDb, openDb } from "./db.js";
import {
  findFindingsByRunId,
  getContextRun,
  listContextItems,
  queryErrors,
  searchFindings,
} from "./queries-rows.js";
import { type PreparedStatements, prepareStatements } from "./queries-statements.js";

const TEMP_PREFIX: string = "zer0-queries-rows-";
const RUN_ID = "run-rows" as const;
const TASK_ID = "BUILD-rows" as const;
const STARTED_AT: string = "2026-05-28T00:00:00.000Z";

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

interface Harness {
  db: Db;
  statements: PreparedStatements;
}

function openHarness(): Harness {
  tempRoot = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const db = openDb(join(tempRoot, "evidence.db"));
  return { db, statements: prepareStatements(db) };
}

function seedRunAndTask(statements: PreparedStatements): void {
  statements.insertRun.run({ id: RUN_ID, vision: "rows", startedAt: STARTED_AT });
  statements.insertTask.run({
    id: TASK_ID,
    runId: RUN_ID,
    objective: "build",
    agent: "codex",
    ownedFiles: JSON.stringify(["src/a.ts"]),
    forbiddenFiles: JSON.stringify([]),
    acceptance: JSON.stringify(["passes"]),
  });
}

function seedContext(statements: PreparedStatements): void {
  statements.insertContextRun.run({
    id: 1,
    taskId: TASK_ID,
    agent: "codex",
    headCommit: "abc",
    promptHash: "p".repeat(64),
    contextHash: "c".repeat(64),
    tokenCount: 12,
    tokenBudget: 16_000,
    blobPath: ".zer0/blobs/x",
  });
  statements.insertContextItem.run({
    id: 2,
    contextRunId: 1,
    kind: "hot",
    path: "src/a.ts",
    symbol: null,
    contentHash: "a".repeat(64),
    tokenCount: 12,
    score: 1,
    reason: "ownership",
  });
}

function seedFinding(statements: PreparedStatements): void {
  statements.insertFinding.run({
    id: "f1",
    taskId: TASK_ID,
    runId: RUN_ID,
    severity: "P0",
    path: "src/a.ts",
    line: 5,
    finding: "race condition",
    status: "open",
    sourceAgent: "claude",
    reviewerContextHash: null,
  });
  const row = statements.selectFindingRowid.get("f1") as { rowid: number };
  statements.insertFindingFts.run([row.rowid, "race condition"]);
}

describe("getContextRun projection", () => {
  it("projects a stored context run into camelCase with numeric id", () => {
    const { db, statements } = openHarness();
    try {
      seedRunAndTask(statements);
      seedContext(statements);
      expect(getContextRun(statements, RUN_ID, TASK_ID)).toMatchObject({
        id: 1,
        runId: RUN_ID,
        taskId: TASK_ID,
        agent: "codex",
        tokenBudget: 16_000,
      });
    } finally {
      closeDb(db);
    }
  });

  it("returns undefined when the context run is absent", () => {
    const { db, statements } = openHarness();
    try {
      seedRunAndTask(statements);
      expect(getContextRun(statements, RUN_ID, TASK_ID)).toBeUndefined();
    } finally {
      closeDb(db);
    }
  });
});

describe("listContextItems projection", () => {
  it("coerces ids to numbers and omits a null symbol", () => {
    const { db, statements } = openHarness();
    try {
      seedRunAndTask(statements);
      seedContext(statements);
      const items = listContextItems(statements, 1);
      expect(items).toHaveLength(1);
      expect(items[0]).toEqual({
        contentHash: "a".repeat(64),
        contextRunId: 1,
        id: 2,
        kind: "hot",
        path: "src/a.ts",
        reason: "ownership",
        score: 1,
        tokenCount: 12,
      });
      expect(items[0]).not.toHaveProperty("symbol");
    } finally {
      closeDb(db);
    }
  });
});

describe("finding read projections", () => {
  it("findFindingsByRunId returns persisted rows with sourceAgent", () => {
    const { db, statements } = openHarness();
    try {
      seedRunAndTask(statements);
      seedFinding(statements);
      expect(findFindingsByRunId(statements, RUN_ID)).toEqual([
        {
          severity: "P0",
          path: "src/a.ts",
          line: 5,
          finding: "race condition",
          sourceAgent: "claude",
        },
      ]);
    } finally {
      closeDb(db);
    }
  });

  it("searchFindings returns the FTS projection with the evidence-search sentinel category", () => {
    const { db, statements } = openHarness();
    try {
      seedRunAndTask(statements);
      seedFinding(statements);
      expect(searchFindings(statements, "race")).toEqual([
        {
          severity: "P0",
          path: "src/a.ts",
          line: 5,
          finding: "race condition",
          category: "evidence-search",
        },
      ]);
    } finally {
      closeDb(db);
    }
  });

  it("searchFindings short-circuits to an empty array for a blank query", () => {
    const { db, statements } = openHarness();
    try {
      expect(searchFindings(statements, "   ")).toEqual([]);
    } finally {
      closeDb(db);
    }
  });
});

describe("queryErrors dispatch", () => {
  it("returns an empty array when no errors are stored", () => {
    const { db, statements } = openHarness();
    try {
      expect(queryErrors(statements)).toEqual([]);
    } finally {
      closeDb(db);
    }
  });
});
