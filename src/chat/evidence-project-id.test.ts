/**
 * @file src/chat/evidence-project-id.test.ts
 * @purpose Tests project_id persistence and non-wiping session upserts for chat evidence rows.
 * @exports (none)
 * @depends vitest, node:fs, node:os, node:path, ../evidence/db, ./evidence
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { closeDb, openDb } from "../evidence/db.js";
import { recordChatSession } from "./evidence.js";

const TEMP_PREFIX: string = "zer0-chat-evidence-project-";
const SESSION_ID: string = "chat-project-retention";
const RUN_ID: string = `run-${SESSION_ID}`;
const PROJECT_ID: string = "proj-chat-session";
const NOW: string = "2026-07-05T00:00:00.000Z";

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

it("retains an existing chat_sessions.project_id when a later upsert omits it", async () => {
  const dbPath = tempDbPath();
  const firstSession = { ...sessionInput(dbPath), projectId: PROJECT_ID };

  await recordChatSession(firstSession);
  await recordChatSession({
    ...sessionInput(dbPath),
    updatedAt: "2026-07-05T00:00:01.000Z",
    summaryText: "later summary",
    summaryThroughTurn: 2,
  });

  expect(readSession(dbPath)).toEqual({
    project_id: PROJECT_ID,
    summary_text: "later summary",
    summary_through_turn: 2,
  });
});

function tempDbPath(): string {
  tempRoot = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  return join(tempRoot, "evidence.db");
}

function sessionInput(dbPath: string): Parameters<typeof recordChatSession>[0] {
  return {
    dbPath,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    repoRoot: "/repo",
    runDir: "/repo/.council/runs/chat-project-retention",
    createdAt: NOW,
    updatedAt: NOW,
    defaultAgent: "claude",
    lastAgent: null,
    summaryText: "",
    summaryThroughTurn: 0,
  };
}

function readSession(dbPath: string): Record<string, string | number | null> {
  const db = openDb(dbPath);
  try {
    return db
      .prepare(
        "SELECT project_id, summary_text, summary_through_turn FROM chat_sessions WHERE id = ?",
      )
      .get(SESSION_ID) as Record<string, string | number | null>;
  } finally {
    closeDb(db);
  }
}
