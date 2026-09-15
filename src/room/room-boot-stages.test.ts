import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { ChatMessage, ChatSession } from "../chat/types.js";
import { LANE_TARGET_VERSION_KEY, closeDb, openDb } from "../evidence/db.js";
import { openLaneStateDb } from "../evidence/db.js";
import type { BootProgressStage } from "./room-boot-progress.js";
import { bootProgressSteps, evidenceMigrationDetail, highestTurn } from "./room-boot-stages.js";

it("reports the five stages in boot order and carries the detail through", async () => {
  const seen: [BootProgressStage, string | undefined][] = [];
  const steps = bootProgressSteps(async (stage, detail) => {
    seen.push([stage, detail]);
  });
  await steps.evidence();
  await steps.liveness();
  await steps.migrate("14 -> 21");
  await steps.session();
  await steps.journal();
  expect(seen).toStrictEqual([
    ["evidence", undefined],
    ["liveness", undefined],
    ["migrate", "14 -> 21"],
    ["session", undefined],
    ["journal", undefined],
  ]);
});

it("is inert without a reporter, which is every boot that has no terminal attached", async () => {
  const steps = bootProgressSteps(undefined);
  await expect(steps.evidence()).resolves.toBeUndefined();
  await expect(steps.migrate("ignored")).resolves.toBeUndefined();
  await expect(steps.journal()).resolves.toBeUndefined();
});

it("names the real migration a first open is about to run, and says nothing when there is none", () => {
  const root = mkdtempSync(path.join(tmpdir(), "boot-stage-detail-"));
  mkdirSync(path.join(root, ".zer0"), { recursive: true });
  const dbPath = path.join(root, ".zer0", "evidence.db");
  try {
    const fresh = openDb(dbPath);
    try {
      // The global tier has run; the carrier's lane tier has not. That is exactly the state a stalled
      // operator is waiting inside, and the detail has to describe the work still ahead of them.
      expect(evidenceMigrationDetail(fresh)).toBe(`14 → ${LANE_TARGET_VERSION_KEY}`);
    } finally {
      closeDb(fresh);
    }

    const migrated = openLaneStateDb(dbPath);
    try {
      expect(evidenceMigrationDetail(migrated)).toBeUndefined();
    } finally {
      closeDb(migrated);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("never throws out of the detail helper: a label is an aid, not a boot dependency", () => {
  const root = mkdtempSync(path.join(tmpdir(), "boot-stage-broken-"));
  const dbPath = path.join(root, "evidence.db");
  try {
    const db = openDb(dbPath);
    try {
      db.exec("DROP TABLE _schema_version");
      expect(evidenceMigrationDetail(db)).toBeUndefined();
    } finally {
      closeDb(db);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("reads the highest recovered turn, and 0 from an empty session", () => {
  expect(highestTurn(session([]))).toBe(0);
  expect(highestTurn(session([2, 7, 5]))).toBe(7);
});

function session(turns: readonly number[]): ChatSession {
  const messages: ChatMessage[] = turns.map((turn, index) => ({
    id: `message-${String(index)}`,
    turn,
    role: "user",
    agent: "user",
    text: "x",
    createdAt: "2026-09-06T00:00:00Z",
    status: "completed",
    tokenEstimate: 1,
  }));
  return {
    id: "chat-boot-stages",
    repoRoot: "D:/project",
    runDir: "D:/project/.zer0/runs/chat-boot-stages",
    createdAt: "2026-09-06T00:00:00Z",
    updatedAt: "2026-09-06T00:00:00Z",
    defaultAgent: "claude",
    lastAgent: null,
    summary: { text: "", throughTurn: 0 },
    messages,
  };
}
