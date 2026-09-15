import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import type { ChatPeerRef } from "../chat/types.js";
import type { RunId } from "../shared/types.js";
import { type Db, closeDb, openDb } from "./db.js";
import { createQueries } from "./queries.js";

const TEMP_PREFIX: string = "zer0-queries-debate-";
const DB_FILE: string = "evidence.db";
const RUN_ID: RunId = "run-query-debate";
const SESSION_ID: string = "chat-query-debate";
const CREATED_AT: string = "2026-06-03T00:00:00.000Z";

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

describe("debateQueries", () => {
  it("persists working set rows through sqlite", () => {
    const db = openDb(tempDbPath());
    try {
      const queries = createSeededQueries(db);
      const peerRefs = queryPeerRefs();
      queries.insertChatWorkingSet({
        agent: "codex",
        contextBlobHash: "blob-context",
        createdAt: CREATED_AT,
        id: "ws-query-debate",
        outcome: "ok",
        peerRefs,
        round: 1,
        sessionId: SESSION_ID,
        tokenEstimate: 7,
        turn: 1,
      });

      expect(queries.listChatWorkingSets({ sessionId: SESSION_ID, turn: 1, round: 1 })).toEqual([
        {
          agent: "codex",
          contextBlobHash: "blob-context",
          createdAt: CREATED_AT,
          id: "ws-query-debate",
          outcome: "ok",
          peerRefs,
          round: 1,
          sessionId: SESSION_ID,
          tokenEstimate: 7,
          turn: 1,
        },
      ]);
    } finally {
      closeDb(db);
    }
  });

  it("rejects invalid list args before sqlite reads", () => {
    const db = openDb(tempDbPath());
    try {
      const queries = createQueries(db);
      expect(() => queries.listChatWorkingSets({ sessionId: "", turn: 1, round: 1 })).toThrow(
        ZodError,
      );
    } finally {
      closeDb(db);
    }
  });
});

function tempDbPath(): string {
  tempRoot = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  return join(tempRoot, DB_FILE);
}

function createSeededQueries(db: Db): ReturnType<typeof createQueries> {
  const queries = createQueries(db);
  queries.insertRun({ id: RUN_ID, vision: "debate persistence", startedAt: CREATED_AT });
  queries.insertChatSession({
    createdAt: CREATED_AT,
    defaultAgent: "codex",
    id: SESSION_ID,
    lastAgent: null,
    repoRoot: "C:/repo",
    runDir: "C:/repo/.council",
    runId: RUN_ID,
    summaryText: "",
    summaryThroughTurn: 0,
    updatedAt: CREATED_AT,
  });
  return queries;
}

function queryPeerRefs(): readonly ChatPeerRef[] {
  return [
    {
      agent: "claude",
      status: "ok",
      dispatch_id: "dispatch-claude-r1",
      output_blob_hash: "blob-output",
    },
  ];
}
