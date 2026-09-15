// M4 REBASE ROUND 2 (review R5-F2) — the runtime write transactions take the writer lock FIRST.
//
// THE DEFECT, and it is behavioural, not stylistic. `createInsertEventTransaction` built a
// transaction whose body READS (`nextEventSequence`) and then WRITES (`insertEvent`), and
// `observabilityQueries` invoked it without `.immediate`. A DEFERRED transaction that reads before
// it writes attempts a read→write upgrade, and SQLite fails that with SQLITE_BUSY *without invoking
// the busy handler* — two connections both waiting there could deadlock, so it returns at once.
// busy_timeout is 5000 ms on these handles and buys nothing. That is the exact shape FL-077 exists
// to remove from the opener path; it was still live on the runtime write path because queries.ts was
// never in the structural pin's scope, and round 1's `TRANSACTION_RETURNED` exemption would have
// kept it invisible under a test titled "every transaction in src/evidence is invoked as .immediate".
//
// This file pins the OUTCOME rather than the source text, because the source text is already pinned
// by transaction-immediate-pin.test.ts, which scans every non-test source in this directory. Under a
// genuinely held writer lock the write must WAIT and then succeed, never fail fast.
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it } from "vitest";
import { type Db, closeDb, openDb } from "./db.js";
import { createQueries } from "./queries.js";

const RUN_ID = "run-immediate";
const TASK_ID = "BUILD-immediate";
const STARTED_AT = "2026-09-02T00:00:00.000Z";
const HOLD_MS = 250;

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    tempRoot = undefined;
  }
});

function seedDb(): { db: Db; dbPath: string } {
  tempRoot = mkdtempSync(join(tmpdir(), "zer0-queries-immediate-"));
  const dbPath = join(tempRoot, "evidence.db");
  const db = openDb(dbPath);
  db.prepare(
    "INSERT INTO runs (id, vision, status, started_at) VALUES (?, 'prove the write waits', 'init', ?)",
  ).run(RUN_ID, STARTED_AT);
  db.prepare(
    "INSERT INTO tasks (id, run_id, objective, agent, owned_files, forbidden_files, acceptance) " +
      "VALUES (?, ?, 'prove the write waits', 'claude', '[]', '[]', '[]')",
  ).run(TASK_ID, RUN_ID);
  return { db, dbPath };
}

// A second THREAD holding BEGIN IMMEDIATE for holdMs, then committing. A thread, not a fork, because
// the parent stays blocked inside a synchronous better-sqlite3 call while the holder's timer fires.
function spawnLockHolder(dbPath: string): { locked: Promise<void>; released: Promise<void> } {
  const sqlite3Module = createRequire(import.meta.url).resolve("better-sqlite3");
  const worker = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const Database = require(workerData.sqlite3Module);
    const db = new Database(workerData.dbPath);
    db.pragma("busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    parentPort.postMessage("locked");
    setTimeout(() => {
      db.exec("COMMIT");
      db.close();
      parentPort.postMessage("released");
    }, workerData.holdMs);
  `,
    { eval: true, workerData: { dbPath, holdMs: HOLD_MS, sqlite3Module } },
  );
  const once = (type: string): Promise<void> =>
    new Promise((resolve, reject) => {
      worker.on("message", (message: string) => {
        if (message === type) resolve();
      });
      worker.on("error", reject);
    });
  return { locked: once("locked"), released: once("released") };
}

it("insertEvent WAITS out a concurrent writer instead of failing the deferred read-write upgrade", async () => {
  const { db, dbPath } = seedDb();
  try {
    const queries = createQueries(db);
    const holder = spawnLockHolder(dbPath);
    await holder.locked; // the writer lock is provably held before we attempt the write

    const started = performance.now();
    let threw: unknown;
    try {
      queries.insertEvent({
        id: "evt-1",
        runId: RUN_ID,
        kind: "state-snapshot",
        payloadJson: '{"ok":true}',
      });
    } catch (err) {
      threw = err;
    }
    const elapsedMs = performance.now() - started;
    await holder.released;

    if (threw !== undefined) {
      const code = String((threw as { code?: string }).code);
      throw new Error(
        `insertEvent threw after ${elapsedMs.toFixed(1)} ms under a held writer lock: ${
          threw instanceof Error ? threw.message : String(threw)
        } (code=${code}) — a deferred read→write upgrade fails WITHOUT the busy handler`,
      );
    }
    // It waited for the real writer rather than failing fast, and stayed inside busy_timeout.
    console.info(`insertEvent under a held writer lock: ${elapsedMs.toFixed(1)} ms`);
    expect(elapsedMs).toBeGreaterThanOrEqual(HOLD_MS * 0.6);
    expect(elapsedMs).toBeLessThan(5_000);

    // Positive control: the row is really on disk with a real sequence, so the wait bought a write.
    const stored = db.prepare("SELECT id, sequence FROM events WHERE id = ?").get("evt-1") as
      | { id: string; sequence: number }
      | undefined;
    expect(stored?.id).toBe("evt-1");
    expect(typeof stored?.sequence).toBe("number");
  } finally {
    closeDb(db);
  }
});

// The sibling factory, and it is a NO-REGRESSION pin rather than a falsifier — said plainly because
// the difference matters. insertFinding's body WRITES first, so a deferred transaction takes the
// writer lock on its opening statement and waits correctly all by itself. It passed this test before
// the fix and passes it after. That is exactly the trap FL-077's own header describes for
// MIGRATION_V3_TO_V4: behaviour identical TODAY, wrong the moment someone adds a read above the
// write. The structural pin next door is what actually guards this one; this pin only proves the
// restructure did not break the write path it touched.
it("insertFinding still waits and still writes both the row and its FTS entry", async () => {
  const { db, dbPath } = seedDb();
  try {
    const queries = createQueries(db);
    const holder = spawnLockHolder(dbPath);
    await holder.locked;

    const started = performance.now();
    let threw: unknown;
    try {
      queries.insertFinding({
        taskId: TASK_ID,
        runId: RUN_ID,
        sourceAgent: "claude",
        severity: "P1",
        path: "src/evidence/queries.ts",
        line: 42,
        finding: "the write waited for the lock",
        category: "test",
      });
    } catch (err) {
      threw = err;
    }
    const elapsedMs = performance.now() - started;
    await holder.released;

    expect(threw).toBeUndefined();
    console.info(`insertFinding under a held writer lock: ${elapsedMs.toFixed(1)} ms`);
    expect(elapsedMs).toBeGreaterThanOrEqual(HOLD_MS * 0.6);
    expect(elapsedMs).toBeLessThan(5_000);
    const stored = db.prepare("SELECT COUNT(*) AS c FROM findings").get() as { c: number };
    expect(stored.c).toBe(1);
    // The second write of the same transaction: the FTS row the factory adds after the insert. It is
    // only reachable through the full-text search, so this asserts BOTH writes committed together.
    expect(queries.searchFindings("waited").map((row) => row.finding)).toEqual([
      "the write waited for the lock",
    ]);
  } finally {
    closeDb(db);
  }
});
