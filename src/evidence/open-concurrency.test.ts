// FL-077 — the opener contention proofs, against REAL better-sqlite3 file locks (no mocks).
//
// The defect: every open re-ran schema.sql + the whole migration chain inside DEFERRED
// transactions, so opening an already-migrated database still attempted a write (schema.sql's
// `INSERT OR IGNORE INTO _schema_version`) after its opening statements had already taken a READ
// lock, and SQLite fails that read→write upgrade with SQLITE_BUSY WITHOUT invoking the busy
// handler — waiting there could deadlock two connections against each other, so it returns at
// once (FL-074 measured a 3 ms throw under busy_timeout=5000). These tests pin the fixed contract:
//   1. steady state is read-only — an open succeeds fast while another connection holds BEGIN
//      IMMEDIATE;
//   2. a DB that DOES need migration takes the writer lock FIRST (BEGIN IMMEDIATE) and waits out
//      a concurrent writer honestly instead of throwing;
//   3. an un-bumped additive step (fl150's lane_prompt_attempts.aborted_at) is still applied even
//      though the version SET already looks final — version membership alone is not proof;
//   4. a forced global-chain rerun (schema.sql + the whole chain, whose first statements are
//      read-only no-op DDL on an already-built file) waits out a concurrent lock holder instead
//      of throwing — the shape that actually bites the BEGIN IMMEDIATE conversion, proven against
//      both a WRITING and a non-writing holder.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { type Db, closeDb, openDb, openLaneStateDb, openMemoryDb } from "./db.js";

let root: string | undefined;

afterEach(() => {
  if (root !== undefined) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    root = undefined;
  }
});

function tempDbPath(): string {
  root = mkdtempSync(join(tmpdir(), "zer0-open-concurrency-"));
  return join(root, "evidence.db");
}

function versionSet(db: Db): number[] {
  return (
    db.prepare("SELECT version FROM _schema_version ORDER BY version").all() as Array<{
      version: number;
    }>
  ).map((row) => row.version);
}

function columnNames(db: Db, table: string): string[] {
  return (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

interface LockHolderResult {
  readonly locked: Promise<void>;
  readonly released: Promise<void>;
}

// A second THREAD holding BEGIN IMMEDIATE on the file for `holdMs`, then committing. Threads (not
// forks) because the parent must stay blocked inside a synchronous better-sqlite3 open while the
// holder's timer fires — a real OS thread keeps running under a blocked main thread.
function spawnLockHolder(dbPath: string, holdMs: number): LockHolderResult {
  // Resolve better-sqlite3 from THIS module's paths; an eval worker resolves from cwd instead,
  // which is not guaranteed to be the repo root under every runner.
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
    {
      eval: true,
      workerData: { dbPath, holdMs, sqlite3Module },
    },
  );
  const once = (type: string): Promise<void> =>
    new Promise((resolve, reject) => {
      worker.on("message", (message: string) => {
        if (message === type) resolve();
      });
      worker.on("error", reject);
    });
  // No terminate(): the worker exits by itself after "released", so its file handle is provably
  // closed before afterEach rmSync runs (Windows refuses to delete behind a live handle).
  return {
    locked: once("locked"),
    released: once("released"),
  };
}

it("FL-077 acceptance 1: fully-migrated opens succeed in well under 1s while a writer holds BEGIN IMMEDIATE", () => {
  const dbPath = tempDbPath();
  closeDb(openLaneStateDb(dbPath)); // build + migrate + close → steady state on disk

  const holder = new Database(dbPath);
  holder.pragma("busy_timeout = 5000");
  holder.exec("BEGIN IMMEDIATE"); // uncommitted writer lock held for the whole test
  try {
    for (const opener of [openDb, openMemoryDb, openLaneStateDb]) {
      const started = performance.now();
      const db = opener(dbPath); // must NOT throw and must NOT wait the busy timeout out
      try {
        const elapsedMs = performance.now() - started;
        console.info(`${opener.name} under a held writer lock: ${elapsedMs.toFixed(1)} ms`);
        expect(elapsedMs).toBeLessThan(1_000);
      } finally {
        closeDb(db); // closed even when the timing assertion fails (codex r3 finding 3)
      }
    }
    // And the opens wrote nothing: one more handle sees the untouched version set + column.
    const check = openLaneStateDb(dbPath);
    try {
      expect(versionSet(check)).toEqual([14, 15, 16, 20, 21]); // M4: every produced set carries 21
      expect(columnNames(check, "lane_prompt_attempts")).toContain("aborted_at");
    } finally {
      closeDb(check);
    }
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
  }
});

it("FL-077 acceptance 2: openMemoryDb on a {14} DB waits out a concurrent writer and lands {14,15,21}", async () => {
  const dbPath = tempDbPath();
  closeDb(openDb(dbPath)); // global chain only: the DB sits at {14}
  const probe = openDb(dbPath);
  try {
    expect(versionSet(probe)).toEqual([14]);
  } finally {
    closeDb(probe);
  }

  const holder = spawnLockHolder(dbPath, 200);
  const { landedVersions, threw, elapsedMs } = await openUnderHolder(openMemoryDb, dbPath, holder);

  if (threw !== undefined) {
    throw new Error(
      `openMemoryDb threw after ${elapsedMs.toFixed(1)} ms while a writer held the lock: ${thrownDetail(threw)}`,
    );
  }
  // It waited for the real writer instead of failing fast...
  expect(elapsedMs).toBeGreaterThanOrEqual(150);
  expect(elapsedMs).toBeLessThan(5_000);
  // ...and then completed the lazy memory migration. M4: the SAME memory tier also lands v21's
  // file projection, so the produced set is {14,15,21}, never {14,15}.
  expect(landedVersions).toEqual([14, 15, 21]);
});

// FL-077 acceptance 3: fl150 added aborted_at via addColumnIfMissing INSIDE applyLaneStateMigration
// with NO version bump, so an accepted version set does NOT prove a lane DB fully migrated. A DB at
// {14,15,16,20} lacking the column must still gain it on open.
it("FL-077 acceptance 3: a lane DB at the final version set but missing aborted_at gains the column on open", () => {
  const dbPath = tempDbPath();
  closeDb(openLaneStateDb(dbPath)); // full tier incl. aborted_at

  const sculptor = new Database(dbPath);
  sculptor.exec("ALTER TABLE lane_prompt_attempts DROP COLUMN aborted_at"); // simulate pre-fl150 rows
  sculptor.close();

  const reopened = openLaneStateDb(dbPath);
  try {
    expect(versionSet(reopened)).toEqual([14, 15, 16, 20, 21]); // M4: every produced set carries 21
    expect(columnNames(reopened, "lane_prompt_attempts")).toContain("aborted_at");
  } finally {
    closeDb(reopened);
  }
});

// FL-077 round 2 (review finding 1): acceptance 2 could not tell BEGIN IMMEDIATE from BEGIN
// DEFERRED, and the two round-1 reviews disagreed about why. Measured directly (four cases, one
// holder on BEGIN IMMEDIATE, one opener on BEGIN DEFERRED, busy_timeout=5000 on both):
//   read-then-write, holder never wrote  ->   0.2 ms SQLITE_BUSY   (busy handler NOT invoked)
//   read-then-write, holder DID write    ->   0.1 ms SQLITE_BUSY   (busy handler NOT invoked)
//   write-first,     holder never wrote  -> 5534.8 ms SQLITE_BUSY  (waited the full timeout)
//   write-first,     holder DID write    -> 5621.0 ms SQLITE_BUSY  (waited the full timeout)
// So the discriminator is the transaction's FIRST STATEMENT, not whether the holder wrote: a
// DEFERRED transaction that reads first can never be made to wait (SQLite refuses to block on a
// read->write upgrade because two connections doing that would deadlock), while one that writes
// first takes the write lock up front and honours busy_timeout — which is exactly what BEGIN
// IMMEDIATE does for every statement order. Acceptance 2 exercises applyMemoryMigration, whose
// first statement is a write, so it waits either way. The two tests below force a rerun of
// schema.sql + the global chain instead: on an already-built file those open with no-op
// `CREATE ... IF NOT EXISTS` reads and only later write, so deferred fails in ~20 ms and
// immediate waits out the holder. Both holder shapes are pinned because the round-1 reviews
// blamed the holder's write, and the measurement above says that is not the cause.
function spawnWritingLockHolder(dbPath: string, holdMs: number): LockHolderResult {
  const sqlite3Module = createRequire(import.meta.url).resolve("better-sqlite3");
  const worker = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const Database = require(workerData.sqlite3Module);
    const db = new Database(workerData.dbPath);
    db.pragma("busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    // A real change committed while the opener is inside the chain — the round-1 reviews thought
    // this was what armed the trap. The sibling non-writing test shows it is not; it is kept
    // because it is the harsher shape (the opener's snapshot is stale AND the lock is held).
    db.exec(
      "INSERT INTO runs (id, vision, status, started_at) VALUES ('fl077-chain-holder', 'prove the write arms the trap', 'init', '2026-08-22T00:00:00.000Z')",
    );
    parentPort.postMessage("locked");
    setTimeout(() => {
      db.exec("COMMIT");
      db.close();
      parentPort.postMessage("released");
    }, workerData.holdMs);
  `,
    {
      eval: true,
      workerData: { dbPath, holdMs, sqlite3Module },
    },
  );
  const once = (type: string): Promise<void> =>
    new Promise((resolve, reject) => {
      worker.on("message", (message: string) => {
        if (message === type) resolve();
      });
      worker.on("error", reject);
    });
  return {
    locked: once("locked"),
    released: once("released"),
  };
}

// Rewind _schema_version to {5} so chainReadiness reports the global tier incomplete and BOTH
// applySchema and applyMigrations must re-run on an already-migrated file. Every step is
// idempotent (IF EXISTS / IF NOT EXISTS / INSERT OR IGNORE / addColumnIfMissing), so the rerun
// lands back at exactly {14}.
function forceGlobalChainRerun(dbPath: string): void {
  const sculptor = new Database(dbPath);
  sculptor.exec("DELETE FROM _schema_version");
  sculptor.exec("INSERT INTO _schema_version(version) VALUES (5)");
  sculptor.close();
}

interface OpenUnderHolderResult {
  // The version set captured BEFORE closeDb, so a caller-side assertion failure can never leak
  // the handle into afterEach rmSync (codex r3 finding 3 — Windows refuses to delete behind it).
  readonly landedVersions: number[] | undefined;
  readonly threw: unknown;
  readonly elapsedMs: number;
}

// Runs one opener against a path whose writer lock is held by `holder`'s worker, and closes the
// opened handle before returning under every outcome. The clock starts BEFORE waiting for the
// lock confirmation on purpose: a main-thread stall between that confirmation and a later
// timestamp would shrink the measured window below the real hold and flake the >= floor (seen
// once under 3-file parallelism in round 3); capturing first only ever WIDENS the window, so
// the floor stays an honest lower bound on the wait.
async function openUnderHolder(
  opener: (path: string) => Db,
  dbPath: string,
  holder: LockHolderResult,
): Promise<OpenUnderHolderResult> {
  const started = performance.now();
  await holder.locked; // writer lock provably held before we attempt the open

  let opened: Db | undefined;
  let threw: unknown;
  try {
    opened = opener(dbPath);
  } catch (err) {
    threw = err;
  }
  const elapsedMs = performance.now() - started;

  let landedVersions: number[] | undefined;
  if (opened !== undefined) {
    try {
      landedVersions = versionSet(opened);
    } finally {
      closeDb(opened);
    }
  }
  await holder.released; // provably closed before afterEach rmSync (Windows handle rules)
  return { landedVersions, threw, elapsedMs };
}

function thrownDetail(threw: unknown): string {
  return threw instanceof Error
    ? `${threw.message} (code=${String((threw as { code?: string }).code)})`
    : String(threw);
}

it("FL-077 round 2: a forced global-chain rerun under a WRITING lock holder waits out the writer and lands {14}", async () => {
  const dbPath = tempDbPath();
  closeDb(openLaneStateDb(dbPath)); // build the fully-migrated tier...
  forceGlobalChainRerun(dbPath); // ...then force applySchema + applyMigrations to run again

  const holder = spawnWritingLockHolder(dbPath, 400);

  const { landedVersions, threw, elapsedMs } = await openUnderHolder(openDb, dbPath, holder);
  console.info(`chain rerun under a WRITING holder: ${elapsedMs.toFixed(1)} ms`);
  if (threw !== undefined) {
    throw new Error(
      `the migration chain threw after ${elapsedMs.toFixed(1)} ms against a committed writer: ${thrownDetail(threw)}`,
    );
  }
  expect(elapsedMs).toBeGreaterThanOrEqual(250); // waited out the real writer instead of failing fast
  expect(elapsedMs).toBeLessThan(5_000);
  expect(landedVersions).toEqual([14]);
});

// The holder-shape half of the reconciliation. Round 1's two reviews blamed the holder's COMMIT
// for arming the trap; this test removes the commit and keeps everything else, and it still bites
// (measured: 20.3 ms SQLITE_BUSY all-deferred, 451.5 ms wait-and-succeed at HEAD). That is the
// falsifier for "the holder must write" — what the opener needs is the write lock taken by its
// own first statement, which is what BEGIN IMMEDIATE gives it.
it("FL-077 round 2: the same forced rerun waits out a NON-writing lock holder too", async () => {
  const dbPath = tempDbPath();
  closeDb(openLaneStateDb(dbPath));
  forceGlobalChainRerun(dbPath);

  const holder = spawnLockHolder(dbPath, 400);

  const { landedVersions, threw, elapsedMs } = await openUnderHolder(openDb, dbPath, holder);
  console.info(`chain rerun under a NON-writing holder: ${elapsedMs.toFixed(1)} ms`);
  if (threw !== undefined) {
    throw new Error(
      `the migration chain threw after ${elapsedMs.toFixed(1)} ms: ${thrownDetail(threw)}`,
    );
  }
  expect(elapsedMs).toBeGreaterThanOrEqual(250); // waited out the real holder instead of failing fast
  expect(elapsedMs).toBeLessThan(5_000);
  expect(landedVersions).toEqual([14]);
});

it("a steady-state reopen leaves an already-migrated file byte-identical", () => {
  const dbPath = tempDbPath();
  const builder = openLaneStateDb(dbPath);
  builder
    .prepare("INSERT INTO runs (id, vision, status, started_at) VALUES (?, ?, 'init', ?)")
    .run("run-fl077", "prove byte stability", "2026-08-22T00:00:00.000Z");
  builder.pragma("wal_checkpoint(TRUNCATE)");
  closeDb(builder);
  const before = createHash("sha256").update(readFileSync(dbPath)).digest("hex");

  const reopened = openLaneStateDb(dbPath);
  try {
    reopened.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    closeDb(reopened);
  }
  const after = createHash("sha256").update(readFileSync(dbPath)).digest("hex");
  expect(after).toBe(before);
});
