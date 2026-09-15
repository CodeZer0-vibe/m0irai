import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { BlobStore } from "../blobs.js";
import { putBlob } from "../blobs.js";
import { closeDb, openDb } from "../db.js";
import { createQueries } from "../queries.js";

const TEMP_PREFIX: string = "zer0-evidence-roundtrip-";
const RUN_ID = "run-roundtrip" as const;
const TASK_ID = "BUILD-roundtrip" as const;
const STARTED_AT: string = "2026-05-03T00:00:00.000Z";

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

it("round-trips ledger rows, blobs, dispatch evidence, and FTS findings", async () => {
  tempRoot = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const db = openDb(join(tempRoot, "evidence.db"));
  const queries = createQueries(db);
  const store: BlobStore = { rootDir: join(tempRoot, "blobs") };

  try {
    queries.insertRun({ id: RUN_ID, vision: "ship forensic ledger", startedAt: STARTED_AT });
    queries.insertTask({
      id: TASK_ID,
      runId: RUN_ID,
      objective: "persist evidence",
      agent: "codex",
      ownedFiles: ["src/evidence/schema.sql"],
      forbiddenFiles: ["src/shared/types.ts"],
      acceptance: ["roundtrip"],
    });
    const stdoutBlob = await putBlob(store, "dispatch stdout");
    queries.insertDispatch({
      taskId: TASK_ID,
      agent: "codex",
      commandHash: "c".repeat(64),
      exitCode: 0,
      stdoutBlob,
      durationMs: 55,
    });
    queries.insertFinding({
      severity: "P2",
      path: "src/evidence/schema.sql",
      finding: "roundtrip searchable finding",
      category: "integration",
      taskId: TASK_ID,
      runId: RUN_ID,
      sourceAgent: "claude",
    });

    expect(queries.searchFindings("searchable")).toEqual([
      {
        severity: "P2",
        path: "src/evidence/schema.sql",
        finding: "roundtrip searchable finding",
        category: "evidence-search",
      },
    ]);
  } finally {
    closeDb(db);
  }
});
