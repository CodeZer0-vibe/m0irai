// FL-077 round 3 — THE DETERMINISTIC RACE PROOFS for atomic migration tiers.
//
// Codex r2 finding (db.ts): the per-step `.immediate()` transactions make every STEP atomic but
// not the CHAIN. Two stale openers interleaving commit transient hybrid `_schema_version` sets,
// and the unlocked post-chain read throws spurious SCHEMA_DRIFT against a healthy database that
// is simply still migrating. That defect was captured verbatim against the pre-fix tree with this
// same machinery: opener B frozen mid-chain holding a committed hybrid set, opener A reading
// `[4,5,14]` at its unlocked assertion and throwing ZER0_EVIDENCE_SCHEMA_DRIFT (quoted in the
// round-3 report; the temporary capture harness was deleted after quoting).
//
// These tests pin the FIX: REAL worker threads importing the REAL src/evidence/db.ts (native
// strip-types + a .js->.ts resolve hook written to tmpdir), parked deterministically at seams
// that exist in BOTH the old and the new code so the same harness bites the regression it
// guards against:
//   1. a stale opener released after another opener finished re-reads readiness UNDER the tier
//      lock, finds the work already done, performs ZERO write-class statements, and both opens
//      succeed at exactly [14];
//   2. while an opener sits mid-tier holding the writer lock, a plain reader connection sees
//      ONLY the entry state — intermediate sets are invisible because nothing commits until the
//      whole tier does;
//   3. two concurrent incomplete openers SERIALIZE: the second blocks inside BEGIN IMMEDIATE
//      until the first tier commits, then finds the work done and writes nothing.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { closeDb, openDb } from "./db.js";

// EVERY directory this file creates is tracked here and removed in afterEach (r3b finding 5):
// tempDir() used to reassign one module-level `root`, so with one call per test plus one per
// startRaceWorker, afterEach deleted only the LAST directory and leaked the rest — five per run,
// several holding a full migrated evidence.db.
const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "zer0-open-race-atomicity-"));
  roots.push(dir);
  return dir;
}

function readerVersions(dbPath: string): number[] {
  const reader = new Database(dbPath);
  try {
    return (
      reader.prepare("SELECT version FROM _schema_version ORDER BY version").all() as Array<{
        version: number;
      }>
    ).map((row) => row.version);
  } finally {
    reader.close();
  }
}

function readerTableExists(dbPath: string, table: string): boolean {
  const reader = new Database(dbPath);
  try {
    return (
      reader.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
      undefined
    );
  } finally {
    reader.close();
  }
}

// Build a fully-migrated database, then rewind ONLY the version rows to {2}: the exact shape the
// race choreography needs (final-schema file whose global tier still looks incomplete).
function seedRewoundToTwo(dbPath: string): void {
  closeDb(openDb(dbPath));
  const sculptor = new Database(dbPath);
  try {
    sculptor.exec("DELETE FROM _schema_version");
    sculptor.exec("INSERT INTO _schema_version(version) VALUES (2)");
  } finally {
    sculptor.close();
  }
}

// --- worker infrastructure -------------------------------------------------------------
// Resolve better-sqlite3 from THIS module's paths; an eval worker resolves from cwd instead,
// which is not guaranteed to be the repo root under every runner (see open-concurrency.test.ts).
const SQLITE3_MODULE = createRequire(import.meta.url).resolve("better-sqlite3");

// Written to tmpdir at runtime and registered INSIDE each worker: maps "./x.js" specifiers to
// sibling "./x.ts" files when the .js file does not exist, so the real TypeScript sources load
// natively under --experimental-strip-types/--experimental-transform-types.
const HOOK_SOURCE = `
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
export async function resolve(specifier, context, nextResolve) {
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    specifier.endsWith(".js") &&
    context.parentURL !== undefined
  ) {
    const literal = new URL(specifier, context.parentURL);
    const asTs = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (!existsSync(fileURLToPath(literal)) && existsSync(fileURLToPath(asTs))) {
      return nextResolve(asTs.href, context);
    }
  }
  return nextResolve(specifier, context);
}
`;

interface RaceRecord {
  k: "sql" | "tx-in" | "tx-out" | "vr" | "ok" | "err";
  t?: string;
  m?: string;
}

// SAB layout per worker: 0 = state (1 parked / 2 done), 1 = release command, 2 = live count of
// entered .immediate() invocations, 3 = live count of RETURNED ones. The counters are how the
// parent observes a worker blocked INSIDE BEGIN IMMEDIATE without waiting for its exit.
const SLOT = { state: 0, release: 1, txIn: 2, txOut: 3 };

// The worker source is written as several SMALL textual functions on purpose: gate-clamps scans
// this file's raw text, and a single big async-IIFE wrapper inside the template reads as an
// oversized source function. The behaviour is identical to the one-wrapper shape.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { register } = require("node:module");
register(workerData.hookUrl);

function makePark(sab) {
  return function park() {
    Atomics.store(sab, ${SLOT.state}, 1);
    Atomics.notify(sab, ${SLOT.state});
    for (;;) {
      if (Atomics.load(sab, ${SLOT.release}) === 1) {
        Atomics.store(sab, ${SLOT.release}, 0);
        // Back to 0 ("running") so the parent can distinguish parked from in-flight before the
        // next park lands.
        Atomics.store(sab, ${SLOT.state}, 0);
        return;
      }
      Atomics.wait(sab, ${SLOT.release}, 0, 50);
    }
  };
}

function installSqlSeam(proto, role, records, park) {
  let versionReads = 0;
  const isVersionSelect = (sql) =>
    typeof sql === "string" &&
    sql.startsWith("SELECT version") &&
    sql.includes("FROM _schema_version");
  const recordSql = (sql) => {
    records.push({ k: "sql", t: sql });
    // The "validator" park point: the SECOND version-set read. In the fixed code that read
    // happens INSIDE the tier transaction with the writer lock held; in the old code it was
    // the unlocked post-chain assertion with no lock held at all. Statement-instance patching
    // does NOT work here (better-sqlite3 defines Statement methods non-writable), so the
    // interception lives on prepare/exec.
    if (!isVersionSelect(sql)) return;
    versionReads += 1;
    records.push({ k: "vr" });
    if (role === "validator" && versionReads === 2) park();
  };
  const origPrepare = proto.prepare;
  proto.prepare = function (sql) {
    if (typeof sql === "string") recordSql(sql);
    return origPrepare.call(this, sql);
  };
  // db.exec() is NATIVE and never routes through prepare(), so migration steps executed with
  // exec would be invisible to the recorder without this seam.
  const origExec = proto.exec;
  proto.exec = function (sql) {
    if (typeof sql === "string") recordSql(sql);
    return origExec.call(this, sql);
  };
}

function installTransactionSeam(proto, sab, role, records, park) {
  const origTransaction = proto.transaction;
  proto.transaction = function (fn) {
    const real = origTransaction.call(this, fn);
    const enter = (mode) => {
      Atomics.add(sab, ${SLOT.txIn}, 1);
      records.push({ k: "tx-in", m: mode });
    };
    const leave = (mode) => {
      Atomics.add(sab, ${SLOT.txOut}, 1);
      records.push({ k: "tx-out", m: mode });
    };
    const wrapped = (...args) => {
      enter("plain");
      if (role === "stale") park();
      const out = real.apply(this, args);
      leave("plain");
      return out;
    };
    for (const mode of ["deferred", "immediate", "exclusive"]) {
      if (typeof real[mode] !== "function") continue;
      wrapped[mode] = (...args) => {
        enter(mode);
        // Park BEFORE invoking BEGIN IMMEDIATE so no writer lock is held while parked.
        if (role === "stale") park();
        const out = real[mode].apply(real, args);
        leave(mode);
        return out;
      };
    }
    return wrapped;
  };
}

function finish(records, sab) {
  Atomics.store(sab, ${SLOT.state}, 2);
  Atomics.notify(sab, ${SLOT.state});
  parentPort.postMessage(records);
}

function run(mod) {
  const Database = require(workerData.sqlite3Module);
  const proto = Database.prototype;
  const records = [];
  const park = makePark(workerData.sab);
  installSqlSeam(proto, workerData.role, records, park);
  installTransactionSeam(proto, workerData.sab, workerData.role, records, park);
  try {
    mod.openDb(workerData.dbPath).close();
    records.push({ k: "ok" });
  } catch (err) {
    records.push({
      k: "err",
      t: (err && err.message) + " (code=" + String(err && err.code) + ")",
    });
  }
  finish(records, workerData.sab);
}

import(workerData.srcUrl).then(run).catch((err) => {
  parentPort([{ k: "err", t: "FATAL " + String(err) }]);
});
`;

interface RaceWorker {
  sab: Int32Array;
  done: Promise<RaceRecord[]>;
}

function startRaceWorker(role: "stale" | "completer" | "validator", dbPath: string): RaceWorker {
  const dir = tempDir();
  // workerData crosses a structured clone: pass file:// STRINGS, not URL objects.
  const hookPath = join(dir, `fl077-hook-${role}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(hookPath, HOOK_SOURCE);
  const hookUrl = pathToFileURL(hookPath).href;
  const srcUrl = pathToFileURL(join(process.cwd(), "src", "evidence", "db.ts")).href;
  const sab = new Int32Array(new SharedArrayBuffer(16 * 4));
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { role, dbPath, sab, hookUrl, srcUrl, sqlite3Module: SQLITE3_MODULE },
    execArgv: ["--experimental-strip-types", "--experimental-transform-types"],
  });
  // The worker posts exactly one message and exits by itself afterwards, so its file handle is
  // provably closed before afterEach rmSync runs (Windows refuses to delete behind a handle).
  const done = new Promise<RaceRecord[]>((resolve, reject) => {
    worker.on("message", (records: RaceRecord[]) => worker.on("exit", () => resolve(records)));
    worker.on("error", reject);
  });
  return { sab, done };
}

async function waitForState(w: RaceWorker, value: number, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (Atomics.load(w.sab, SLOT.state) === value) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function releaseOnce(w: RaceWorker): Promise<void> {
  Atomics.store(w.sab, SLOT.release, 1);
  Atomics.notify(w.sab, SLOT.release);
  await new Promise((r) => setTimeout(r, 25));
}

async function releaseUntilDone(w: RaceWorker): Promise<void> {
  for (let i = 0; i < 60 && Atomics.load(w.sab, SLOT.state) !== 2; i++) {
    await releaseOnce(w);
  }
  await waitForState(w, 2, "worker to finish its open");
}

// True when the worker sat RUNNING (not parked) inside an unfinished transaction invocation
// continuously across ~50 ms of sampling — a sustained block inside BEGIN IMMEDIATE. Per-step
// invocations complete in microseconds-to-milliseconds and parked states are excluded by the
// state check, so neither can sustain the condition.
async function observedSustainedLockBlock(w: RaceWorker): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  let strikes = 0;
  for (;;) {
    const state = Atomics.load(w.sab, SLOT.state);
    if ((state === 1 && strikes === 0) || state === 2) return false;
    if (state === 0 && Atomics.load(w.sab, SLOT.txIn) > Atomics.load(w.sab, SLOT.txOut)) {
      strikes += 1;
      if (strikes >= 5) return true;
    } else {
      strikes = 0;
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
}

function openOk(records: RaceRecord[]): boolean {
  return records.some((r) => r.k === "ok");
}

function openError(records: RaceRecord[]): string | undefined {
  return records.find((r) => r.k === "err")?.t;
}

// A write-class statement is anything whose FIRST token is not a read, a pragma, or transaction
// control. better-sqlite3's internal BEGIN/COMMIT/SAVEPOINT statements come through the same
// patched prepare seam, so they are visible and excluded explicitly.
const NON_WRITE_PREFIXES = /^(SELECT|PRAGMA|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/i;

function writeClassCount(records: RaceRecord[]): number {
  return records.filter(
    (r) => r.k === "sql" && r.t !== undefined && !NON_WRITE_PREFIXES.test(r.t.trim()),
  ).length;
}

// --- the proofs ------------------------------------------------------------------------

it("FL-077 r3 acceptance 2: a stale opener released after a completed rival re-reads UNDER the tier lock, writes NOTHING, and both opens land [14]", async () => {
  const dir = tempDir();
  const dbPath = join(dir, "evidence.db");
  seedRewoundToTwo(dbPath);

  const b = startRaceWorker("stale", dbPath);
  await waitForState(b, 1, "B parked before its first transaction invocation");

  // A runs to FULL completion while B is frozen before any writer lock.
  const a = startRaceWorker("completer", dbPath);
  const aRecords = await a.done;
  expect(openOk(aRecords)).toBe(true);
  expect(openError(aRecords)).toBeUndefined();

  // NOW release B: it must re-read readiness under the tier lock, find {14} already done, and
  // skip every write-class statement.
  await releaseUntilDone(b);
  const bRecords = await b.done;
  expect(openOk(bRecords)).toBe(true);
  expect(openError(bRecords)).toBeUndefined();
  expect(writeClassCount(bRecords)).toBe(0);

  expect(readerVersions(dbPath)).toEqual([14]);
  // Positive control: the converged database really is the full final schema, so the zero-writes
  // claim above is about a healthy migrated file rather than an empty one.
  expect(readerTableExists(dbPath, "gate_transitions")).toBe(true);
  expect(readerTableExists(dbPath, "chat_messages")).toBe(true);
});

it("FL-077 r3: while an opener sits mid-tier holding the writer lock, a plain reader sees ONLY the entry state", async () => {
  const dir = tempDir();
  const dbPath = join(dir, "evidence.db");
  seedRewoundToTwo(dbPath);

  const b = startRaceWorker("stale", dbPath);
  await waitForState(b, 1, "B parked at its first transaction");
  // Step B three invocations deep, then hold at the fourth: in the fixed code that is the outer
  // tier plus two savepoint steps all inside ONE uncommitted transaction; in the old code it is
  // three independently COMMITTED steps.
  await releaseOnce(b);
  await waitForState(b, 1, "B parked at step two");
  await releaseOnce(b);
  await waitForState(b, 1, "B parked at step three");
  await releaseOnce(b);
  await waitForState(b, 1, "B parked mid-flight");

  // THE ASSERTION: nothing B did so far may be visible to another connection. The old per-step
  // commit shape fails here with the committed intermediate set (e.g. [3,5]); the tier shape
  // shows exactly the entry state.
  expect(readerVersions(dbPath)).toEqual([2]);

  await releaseUntilDone(b);
  const bRecords = await b.done;
  expect(openError(bRecords)).toBeUndefined();
  expect(readerVersions(dbPath)).toEqual([14]);
});

it("FL-077 r3: concurrent incomplete openers SERIALIZE — the second blocks inside BEGIN IMMEDIATE, then writes nothing", async () => {
  const dir = tempDir();
  const dbPath = join(dir, "evidence.db");
  seedRewoundToTwo(dbPath);

  // B runs first and freezes before its first transaction invocation (holding no writer lock),
  // so the database still reads {2} when A boots.
  const b = startRaceWorker("stale", dbPath);
  await waitForState(b, 1, "B parked before its first transaction invocation");

  // A parks at its SECOND version-set read: inside the tier with the writer lock held in the
  // fixed code (its under-lock re-read/validation), the unlocked post-chain assertion in the old
  // code — which by then sits AFTER A's chain already committed [14].
  const a = startRaceWorker("validator", dbPath);
  await waitForState(a, 1, "A parked at its locked validation point");

  await releaseOnce(b); // B now attempts BEGIN IMMEDIATE...

  // ...and must still be blocked inside it while A holds the lock. In the old shape A holds
  // nothing (its assertion read is unlocked) and B sails straight through: this is the red.
  expect(await observedSustainedLockBlock(b)).toBe(true);

  // Release A: its tier commits [14]. B then acquires the lock, re-reads, finds the work done,
  // and closes having performed zero write-class statements.
  await releaseOnce(a);
  const aRecords = await a.done;
  expect(openOk(aRecords)).toBe(true);
  expect(openError(aRecords)).toBeUndefined();

  await releaseUntilDone(b);
  const bRecords = await b.done;
  expect(openError(bRecords)).toBeUndefined();
  expect(writeClassCount(bRecords)).toBe(0);
  expect(readerVersions(dbPath)).toEqual([14]);
});
