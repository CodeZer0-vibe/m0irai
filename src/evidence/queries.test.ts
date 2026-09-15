// @size-justified: covers full queries.ts CRUD surface (runs, tasks, contexts, findings, gates, dispatches); helpers tightly coupled to schema fixtures. Splitting forces a sibling _helpers.ts and risks drift between test files for one module.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError } from "../shared/errors.js";
import type { BuildResult, Finding } from "../shared/types.js";
import { type Db, closeDb, openDb } from "./db.js";
import { createQueries } from "./queries.js";

const TEMP_PREFIX: string = "zer0-evidence-queries-";
const RUN_ID = "run-queries" as const;
const TASK_ID = "BUILD-queries" as const;
const STARTED_AT: string = "2026-05-03T00:00:00.000Z";
const HEAD_COMMIT: string = "abc123";

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

describe("run queries", () => {
  it("inserts and updates a run", () => {
    const { db, queries } = openHarness();

    try {
      queries.insertRun({
        id: RUN_ID,
        vision: "ship evidence",
        startedAt: STARTED_AT,
      });
      queries.updateRunStatus({
        id: RUN_ID,
        status: "completed",
        completedAt: STARTED_AT,
      });

      expect(db.prepare("SELECT status, completed_at FROM runs WHERE id = ?").get(RUN_ID)).toEqual({
        status: "completed",
        completed_at: STARTED_AT,
      });
    } finally {
      closeDb(db);
    }
  });

  it("keeps unknown run updates as no-op row changes", () => {
    const { db, queries } = openHarness();

    try {
      queries.updateRunStatus({ id: "run-missing", status: "completed" });

      expect(db.prepare("SELECT COUNT(*) AS count FROM runs").get()).toEqual({
        count: 0,
      });
    } finally {
      closeDb(db);
    }
  });
});

describe("task queries", () => {
  it("inserts and updates a task with JSON fields", () => {
    const { db, queries } = openHarnessWithRun();
    const result: BuildResult = buildResult();

    try {
      queries.insertTask(taskArgs());
      queries.updateTaskStatus({
        id: TASK_ID,
        status: "completed",
        result,
        headCommit: HEAD_COMMIT,
      });

      const row = db
        .prepare("SELECT status, result, head_commit FROM tasks WHERE id = ?")
        .get(TASK_ID);
      expect(row).toEqual({
        status: "completed",
        result: JSON.stringify(result),
        head_commit: HEAD_COMMIT,
      });
    } finally {
      closeDb(db);
    }
  });

  it("rejects a task whose run does not exist", () => {
    const { db, queries } = openHarness();

    try {
      expect(() => queries.insertTask(taskArgs())).toThrow();
    } finally {
      closeDb(db);
    }
  });

  it("requires a head commit when completing a task", () => {
    const { db, queries } = openHarnessWithTask();

    try {
      expect(() => queries.updateTaskStatus({ id: TASK_ID, status: "completed" })).toThrow(
        ConfigError,
      );
    } finally {
      closeDb(db);
    }
  });
});

describe("context queries", () => {
  it("inserts and reads context runs and their ordered items", () => {
    const { db, queries } = openHarnessWithTask();

    try {
      insertContextFixture(queries);

      expect(queries.getContextRun(RUN_ID, TASK_ID)).toMatchObject({
        agent: "codex",
        id: 1,
        runId: RUN_ID,
        taskId: TASK_ID,
      });
      expect(queries.listContextItems(1)).toEqual([expectedContextItem()]);
    } finally {
      closeDb(db);
    }
  });

  it("returns undefined for a missing context run", () => {
    const { db, queries } = openHarnessWithTask();

    try {
      expect(queries.getContextRun(RUN_ID, TASK_ID)).toBeUndefined();
    } finally {
      closeDb(db);
    }
  });
});

describe("finding queries", () => {
  it("returns empty persisted findings for a run with no findings", () => {
    const { db, queries } = openHarnessWithTask();

    try {
      expect(queries.findFindingsByRunId(RUN_ID)).toEqual([]);
    } finally {
      closeDb(db);
    }
  });

  it("inserts a finding and returns it through FTS5 search", () => {
    const { db, queries } = openHarnessWithTask();
    const finding: Finding = {
      severity: "P1",
      path: "src/evidence/queries.ts",
      line: 42,
      finding: "missing retry evidence",
      category: "test",
    };

    try {
      queries.insertFinding({
        ...finding,
        taskId: TASK_ID,
        runId: RUN_ID,
        sourceAgent: "claude",
      });

      expect(queries.searchFindings("retry")).toEqual([
        { ...finding, category: "evidence-search" },
      ]);
    } finally {
      closeDb(db);
    }
  });
});

describe("persisted finding queries", () => {
  it("returns persisted findings with source agent", () => {
    const { db, queries } = openHarnessWithTask();

    try {
      insertFinding(queries, "P1", "src/evidence/queries.ts", 42, "missing retry evidence");
      expect(queries.findFindingsByRunId(RUN_ID)).toEqual([
        {
          finding: "missing retry evidence",
          line: 42,
          path: "src/evidence/queries.ts",
          severity: "P1",
          sourceAgent: "claude",
        },
      ]);
    } finally {
      closeDb(db);
    }
  });
});

describe("persisted finding ordering", () => {
  it("orders persisted findings by severity then newest row", () => {
    const { db, queries } = openHarnessWithTask();

    try {
      insertFinding(queries, "P2", "src/a.ts", 1, "old p2");
      insertFinding(queries, "P1", "src/a.ts", 2, "old p1");
      insertFinding(queries, "P0", "src/a.ts", 3, "old p0");
      insertFinding(queries, "P1", "src/a.ts", 4, "new p1");
      insertFinding(queries, "P0", "src/a.ts", 5, "new p0");
      expect(queries.findFindingsByRunId(RUN_ID).map((finding) => finding.finding)).toEqual([
        "new p0",
        "old p0",
        "new p1",
        "old p1",
        "old p2",
      ]);
    } finally {
      closeDb(db);
    }
  });

  it("scopes persisted findings to the requested run", () => {
    const { db, queries } = openHarnessWithTask();

    try {
      insertFinding(queries, "P1", "src/a.ts", 1, "run one");
      queries.insertRun({ id: "run-other", startedAt: STARTED_AT, vision: "other" });
      db.prepare(
        "INSERT INTO findings (id, task_id, run_id, severity, path, line, finding, status, source_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("other", TASK_ID, "run-other", "P0", "src/b.ts", 2, "run two", "open", "codex");
      expect(queries.findFindingsByRunId(RUN_ID).map((finding) => finding.finding)).toEqual([
        "run one",
      ]);
    } finally {
      closeDb(db);
    }
  });
});

describe("persisted finding null fields", () => {
  it("returns null path and line persisted findings", () => {
    const { db, queries } = openHarnessWithTask();

    try {
      db.prepare(
        "INSERT INTO findings (id, task_id, run_id, severity, path, line, finding, status, source_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("nulls", TASK_ID, RUN_ID, "P0", null, null, "packet issue", "open", "gemini");
      expect(queries.findFindingsByRunId(RUN_ID)).toEqual([
        {
          finding: "packet issue",
          line: null,
          path: null,
          severity: "P0",
          sourceAgent: "gemini",
        },
      ]);
    } finally {
      closeDb(db);
    }
  });
});

describe("finding query edge cases", () => {
  it("returns an empty list for an empty search query", () => {
    const { db, queries } = openHarnessWithTask();

    try {
      expect(queries.searchFindings(" ")).toEqual([]);
    } finally {
      closeDb(db);
    }
  });
});

describe("finding search limits", () => {
  it("limits finding search results", () => {
    const { db, queries } = openHarnessWithTask();

    try {
      for (let index = 0; index < 5; index += 1) {
        queries.insertFinding({
          severity: "P1",
          path: "src/evidence/queries.ts",
          line: index + 1,
          finding: `retry evidence ${index}`,
          category: "test",
          taskId: TASK_ID,
          runId: RUN_ID,
          sourceAgent: "claude",
        });
      }

      expect(queries.searchFindings("retry", 2)).toHaveLength(2);
    } finally {
      closeDb(db);
    }
  });
});

describe("gate transition queries", () => {
  it("records gate transition evidence", () => {
    const { db, queries } = openHarnessWithRun();

    try {
      queries.insertGateTransition({
        runId: RUN_ID,
        fromState: "build",
        toState: "review",
        gateName: "typecheck",
        passed: true,
        evidence: { command: "npm run typecheck" },
      });

      expect(db.prepare("SELECT passed, evidence_json FROM gate_transitions").get()).toEqual({
        passed: 1,
        evidence_json: JSON.stringify({ command: "npm run typecheck" }),
      });
    } finally {
      closeDb(db);
    }
  });

  it("upserts gate transitions: retry with flipped result updates same row, latest wins", () => {
    const { db, queries } = openHarnessWithRun();

    try {
      runUpsertGateTransitionScenario(queries);
      expectSingleGateTransitionRow(db, "typecheck");
      expectGateTransitionLatestValuesWin(db, "typecheck");
    } finally {
      closeDb(db);
    }
  });
});

describe("dispatch queries — record", () => {
  it("records dispatch blobs and token counts", () => {
    const { db, queries } = openHarnessWithTask();
    try {
      queries.insertDispatch(insertDispatchArgs({ tokensIn: 10, tokensOut: 5 }));
      expect(selectFirstDispatch(db)).toEqual({
        agent: "codex",
        duration_ms: 125,
        tokens_in: 10,
        tokens_out: 5,
      });
    } finally {
      closeDb(db);
    }
  });
});

describe("dispatch queries — duplicates", () => {
  it("ignores duplicate dispatches with the same task, agent, and command hash", () => {
    const { db, queries } = openHarnessWithTask();
    const args = insertDispatchArgs();
    try {
      expect(queries.insertDispatch(args)).toBe(true);
      expect(queries.insertDispatch(args)).toBe(false);
      expect(db.prepare("SELECT COUNT(*) AS count FROM dispatches").get()).toEqual({ count: 1 });
    } finally {
      closeDb(db);
    }
  });
});

function insertDispatchArgs(
  overrides: Partial<{ tokensIn: number; tokensOut: number }> = {},
): Parameters<ReturnType<typeof createQueries>["insertDispatch"]>[0] {
  return {
    taskId: TASK_ID,
    agent: "codex",
    commandHash: "a".repeat(64),
    exitCode: 0,
    stdoutBlob: "b".repeat(64),
    durationMs: 125,
    ...overrides,
  };
}

function insertFinding(
  queries: ReturnType<typeof createQueries>,
  severity: Finding["severity"],
  path: string,
  line: number,
  finding: string,
): void {
  queries.insertFinding({
    category: "test",
    finding,
    line,
    path,
    runId: RUN_ID,
    severity,
    sourceAgent: "claude",
    taskId: TASK_ID,
  });
}

function selectFirstDispatch(db: Db): unknown {
  return db.prepare("SELECT agent, duration_ms, tokens_in, tokens_out FROM dispatches").get();
}

function openHarness(): { db: Db; queries: ReturnType<typeof createQueries> } {
  tempRoot = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const db = openDb(join(tempRoot, "evidence.db"));
  return { db, queries: createQueries(db) };
}

function openHarnessWithRun(): {
  db: Db;
  queries: ReturnType<typeof createQueries>;
} {
  const harness = openHarness();
  harness.queries.insertRun({
    id: RUN_ID,
    vision: "ship evidence",
    startedAt: STARTED_AT,
  });
  return harness;
}

function openHarnessWithTask(): {
  db: Db;
  queries: ReturnType<typeof createQueries>;
} {
  const harness = openHarnessWithRun();
  harness.queries.insertTask(taskArgs());
  return harness;
}

function insertContextFixture(queries: ReturnType<typeof createQueries>): void {
  queries.insertContextRun({
    agent: "codex",
    blobPath: ".zer0/blobs/context",
    contextHash: "c".repeat(64),
    headCommit: HEAD_COMMIT,
    id: 1,
    promptHash: "p".repeat(64),
    runId: RUN_ID,
    taskId: TASK_ID,
    tokenBudget: 16_000,
    tokenCount: 12,
  });
  queries.insertContextItem(expectedContextItem());
}

function expectedContextItem(): Parameters<
  ReturnType<typeof createQueries>["insertContextItem"]
>[0] {
  return {
    contentHash: "a".repeat(64),
    contextRunId: 1,
    id: 2,
    kind: "hot",
    path: "src/evidence/queries.ts",
    reason: "direct task ownership",
    score: 1,
    tokenCount: 12,
  };
}

function taskArgs(): Parameters<ReturnType<typeof createQueries>["insertTask"]>[0] {
  return {
    id: TASK_ID,
    runId: RUN_ID,
    objective: "build persistence",
    agent: "codex",
    ownedFiles: ["src/evidence/queries.ts"],
    forbiddenFiles: ["src/shared/types.ts"],
    acceptance: ["stores evidence"],
  };
}

function buildResult(): BuildResult {
  return {
    agent: "codex",
    files: [{ path: "src/evidence/queries.ts", action: "created" }],
    testsPassed: true,
    lintClean: true,
    diffLines: 10,
    acceptanceMet: 1,
    stdout: "",
    stderr: "",
  };
}

function runUpsertGateTransitionScenario(queries: ReturnType<typeof createQueries>): void {
  const failArgs = {
    runId: RUN_ID,
    fromState: "build",
    toState: "blocked",
    gateName: "typecheck",
    passed: false,
    evidence: { error: "5 typecheck errors" },
  };
  const passArgs = {
    ...failArgs,
    toState: "review",
    passed: true,
    evidence: { ok: true },
  };
  expect(queries.insertGateTransition(failArgs)).toBe(true);
  expect(queries.insertGateTransition(passArgs)).toBe(true);
}

function expectSingleGateTransitionRow(db: Db, gateName: string): void {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS count FROM gate_transitions WHERE run_id = @runId AND gate_name = @gateName",
    )
    .get({ runId: RUN_ID, gateName });
  expect(row).toEqual({ count: 1 });
}

interface GateTransitionRow {
  passed: number;
  to_state: string;
  evidence_json: string;
}

function expectGateTransitionLatestValuesWin(db: Db, gateName: string): void {
  const row = db
    .prepare(
      "SELECT passed, to_state, evidence_json FROM gate_transitions WHERE run_id = @runId AND gate_name = @gateName",
    )
    .get({ runId: RUN_ID, gateName }) as GateTransitionRow;
  expect(row.passed).toBe(1);
  expect(row.to_state).toBe("review");
  expect(JSON.parse(row.evidence_json)).toEqual({ ok: true });
}
