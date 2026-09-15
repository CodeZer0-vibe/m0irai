/**
 * @file src/memory/ledger.test.ts
 * @purpose MT7 T1-C tests for transactional project message seq minting.
 * @exports (none - test file)
 * @depends vitest, node:fs, node:os, node:path, ../evidence/db, ./ledger
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { type Db, closeDb, openLaneStateDb } from "../evidence/db.js";
import { currentLedgerSeq, getSeqForMessage, ledgerAfter, mintSeq } from "./ledger.js";

const NOW = "2026-07-10T00:00:00Z";
let tempRoot: string | undefined;
const handles: Db[] = [];

function tempDbPath(): string {
  tempRoot = mkdtempSync(path.join(tmpdir(), "ledger-seq-"));
  return path.join(tempRoot, "evidence.db");
}

function track(db: Db): Db {
  handles.push(db);
  return db;
}

afterEach(() => {
  for (const db of handles.splice(0)) {
    closeDb(db);
  }
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    tempRoot = undefined;
  }
});

function seedProject(db: Db, projectId: string): void {
  db.prepare(
    "INSERT INTO projects(project_id, canonical_root, git_common_dir, created_at) VALUES (?,?,?,?)",
  ).run(projectId, `C:/tmp/${projectId}`, `C:/tmp/${projectId}/.git`, NOW);
}

function seedSessionMessage(db: Db, projectId: string, sessionId: string, messageId: string): void {
  db.prepare("INSERT OR IGNORE INTO runs (id, vision, started_at) VALUES (?, 'test', ?)").run(
    sessionId,
    NOW,
  );
  db.prepare(
    `INSERT OR IGNORE INTO chat_sessions
      (id, run_id, repo_root, run_dir, created_at, updated_at, default_agent, project_id)
     VALUES (?, ?, ?, ?, ?, ?, 'claude', ?)`,
  ).run(
    sessionId,
    sessionId,
    `C:/tmp/${projectId}`,
    `C:/tmp/${projectId}/${sessionId}`,
    NOW,
    NOW,
    projectId,
  );
  db.prepare(
    `INSERT INTO chat_messages
      (id, session_id, turn, role, agent, text_blob_hash, created_at, status, token_estimate)
     VALUES (?, ?, 1, 'user', 'user', ?, ?, 'completed', 1)`,
  ).run(messageId, sessionId, `blob-${messageId}`, NOW);
  mintSeq(db, projectId, messageId);
}

function ledgerRows(db: Db, projectId: string): Array<{ seq: number; message_id: string }> {
  return db
    .prepare("SELECT seq, message_id FROM ledger_seq WHERE project_id = ? ORDER BY seq")
    .all(projectId) as Array<{ seq: number; message_id: string }>;
}

function rowCount(db: Db, projectId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM ledger_seq WHERE project_id = ?")
    .get(projectId) as {
    n: number;
  };
  return row.n;
}

it("mints unique strictly increasing seqs through two real DB connections for one project", () => {
  const dbPath = tempDbPath();
  const dbA = track(openLaneStateDb(dbPath));
  const dbB = track(openLaneStateDb(dbPath));
  seedProject(dbA, "p1");

  const minted = [
    mintSeq(dbA, "p1", "m-a1"),
    mintSeq(dbB, "p1", "m-b1"),
    mintSeq(dbA, "p1", "m-a2"),
    mintSeq(dbB, "p1", "m-b2"),
  ];

  expect(minted).toEqual([1, 2, 3, 4]);
  expect(ledgerRows(dbA, "p1")).toEqual([
    { seq: 1, message_id: "m-a1" },
    { seq: 2, message_id: "m-b1" },
    { seq: 3, message_id: "m-a2" },
    { seq: 4, message_id: "m-b2" },
  ]);
  expect(new Set(minted).size).toBe(4);
  expect(getSeqForMessage(dbB, "p1", "m-a2")).toBe(3);
});

it("reminting an existing message returns its seq and leaves row count unchanged", () => {
  const db = track(openLaneStateDb(tempDbPath()));
  seedProject(db, "p1");

  expect(mintSeq(db, "p1", "m1")).toBe(1);
  expect(mintSeq(db, "p1", "m2")).toBe(2);
  const before = rowCount(db, "p1");
  expect(mintSeq(db, "p1", "m1")).toBe(1);

  expect(rowCount(db, "p1")).toBe(before);
  expect(ledgerRows(db, "p1")).toEqual([
    { seq: 1, message_id: "m1" },
    { seq: 2, message_id: "m2" },
  ]);
});

it("seqs are scoped per project", () => {
  const db = track(openLaneStateDb(tempDbPath()));
  seedProject(db, "pA");
  seedProject(db, "pB");

  expect(mintSeq(db, "pA", "a1")).toBe(1);
  expect(mintSeq(db, "pB", "b1")).toBe(1);
  expect(mintSeq(db, "pA", "a2")).toBe(2);
  expect(mintSeq(db, "pB", "b2")).toBe(2);

  expect(getSeqForMessage(db, "pA", "a2")).toBe(2);
  expect(getSeqForMessage(db, "pB", "a2")).toBeUndefined();
});

it("unknown project id fails closed through the FK and leaves no ledger row", () => {
  const db = track(openLaneStateDb(tempDbPath()));

  expect(() => mintSeq(db, "missing", "m1")).toThrow();
  expect(rowCount(db, "missing")).toBe(0);
  expect(getSeqForMessage(db, "missing", "m1")).toBeUndefined();
});

it("a held write lock walks the busy ladder, SURFACES SQLITE_BUSY, leaves no partial state, and mints cleanly after release", () => {
  const dbPath = tempDbPath();
  const db = track(openLaneStateDb(dbPath));
  seedProject(db, "p1");
  db.pragma("busy_timeout = 5"); // keep each attempt's inner sqlite wait short — the LADDER is under test
  const holder = track(new Database(dbPath));
  holder.exec("BEGIN IMMEDIATE"); // a real held write lock from a second connection

  let caught: unknown;
  try {
    mintSeq(db, "p1", "m1");
  } catch (err) {
    caught = err;
  }
  expect((caught as Error & { code?: string }).code).toMatch(/^SQLITE_BUSY/); // surfaced, never swallowed
  holder.exec("ROLLBACK");

  expect(rowCount(db, "p1")).toBe(0); // the failed walk left nothing behind
  expect(mintSeq(db, "p1", "m1")).toBe(1); // recovery: the same message mints cleanly post-release
});

it("ledgerAfter returns seq order when an older chat run is extended after a newer run", () => {
  const db = track(openLaneStateDb(tempDbPath()));
  seedProject(db, "p1");
  const bodies = new Map([
    ["old-run-operator", { author: "operator", body: "old run starts" }],
    ["new-run-claude", { author: "claude", body: "newer run reply" }],
    ["new-run-codex", { author: "codex", body: "codex joins newer run" }],
    ["old-run-extended", { author: "operator", body: "older run extended later" }],
  ]);

  expect(mintSeq(db, "p1", "old-run-operator")).toBe(1);
  expect(mintSeq(db, "p1", "new-run-claude")).toBe(2);
  expect(mintSeq(db, "p1", "new-run-codex")).toBe(3);
  expect(mintSeq(db, "p1", "old-run-extended")).toBe(4);

  const result = ledgerAfter(db, "p1", 0, { maxBytes: 1_000, maxMessages: 10 }, readBody(bodies));
  expect(result.entries).toEqual([
    { seq: 1, messageId: "old-run-operator", author: "operator", body: "old run starts" },
    { seq: 2, messageId: "new-run-claude", author: "claude", body: "newer run reply" },
    { seq: 3, messageId: "new-run-codex", author: "codex", body: "codex joins newer run" },
    { seq: 4, messageId: "old-run-extended", author: "operator", body: "older run extended later" },
  ]);
  expect(result.overflow.pending).toBe(false);
});

it("ledgerAfter isolates concurrent room transcripts while preserving each room's global seq order", () => {
  const db = track(openLaneStateDb(tempDbPath()));
  seedProject(db, "p1");
  const bodies = new Map([
    ["old-1", { author: "operator", body: "old room task" }],
    ["new-1", { author: "operator", body: "new room hi" }],
    ["old-2", { author: "claude", body: "old room reply" }],
    ["new-2", { author: "gemini", body: "new room reply" }],
  ]);
  seedSessionMessage(db, "p1", "chat-old", "old-1");
  seedSessionMessage(db, "p1", "chat-new", "new-1");
  seedSessionMessage(db, "p1", "chat-old", "old-2");
  seedSessionMessage(db, "p1", "chat-new", "new-2");

  const result = ledgerAfter(
    db,
    "p1",
    0,
    { maxBytes: 1_000, maxMessages: 10, sessionId: "chat-new" },
    readBody(bodies),
  );
  expect(result.entries).toEqual([
    { seq: 2, messageId: "new-1", author: "operator", body: "new room hi" },
    { seq: 4, messageId: "new-2", author: "gemini", body: "new room reply" },
  ]);
  expect(result.overflow.pending).toBe(false);
});

it("ledgerAfter skips oldest entries and delivers the in-budget tail with overflow metadata", () => {
  const db = track(openLaneStateDb(tempDbPath()));
  seedProject(db, "p1");
  const bodies = new Map([
    ["m1", { author: "operator", body: "111" }],
    ["m2", { author: "claude", body: "222" }],
    ["m3", { author: "codex", body: "333" }],
    ["m4", { author: "operator", body: "4444" }],
  ]);
  for (const id of ["m1", "m2", "m3", "m4"]) {
    mintSeq(db, "p1", id);
  }

  const result = ledgerAfter(db, "p1", 0, { maxBytes: 7, maxMessages: 3 }, readBody(bodies));
  expect(result.entries.map((entry) => entry.messageId)).toEqual(["m3", "m4"]);
  expect(result.overflow).toEqual({
    pending: true,
    skippedCount: 2,
    skippedFromSeq: 1,
    skippedToSeq: 2,
    deliveredCount: 2,
    deliveredFromSeq: 3,
    deliveredToSeq: 4,
  });
});

it("THE BOUNDARY WAVE FALSIFIER: currentLedgerSeq reads 0 for an empty/unknown project and the true max after mints, scoped per project", () => {
  const db = track(openLaneStateDb(tempDbPath()));
  seedProject(db, "p1");
  seedProject(db, "p2");

  expect(currentLedgerSeq(db, "p1")).toBe(0); // no entries yet
  expect(currentLedgerSeq(db, "missing-project")).toBe(0); // never seeded, never throws

  mintSeq(db, "p1", "m1");
  mintSeq(db, "p1", "m2");
  mintSeq(db, "p2", "only-one");

  expect(currentLedgerSeq(db, "p1")).toBe(2);
  expect(currentLedgerSeq(db, "p2")).toBe(1); // scoped — p1's mints never leak into p2's watermark
});

function readBody(bodies: Map<string, { readonly author: string; readonly body: string }>) {
  return (messageId: string): { readonly author: string; readonly body: string } => {
    const body = bodies.get(messageId);
    if (body === undefined) {
      throw new Error(`missing body for ${messageId}`);
    }
    return body;
  };
}
