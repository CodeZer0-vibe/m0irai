// digest-entry: the detached child itself. Migrated from the deleted scripts entry with its assertions kept
// — byte-silent with no trace when ZER0_DEBUG is off, a memory.trace when it is on, a DURABLE classified
// record when the pass is fatal (8 / BLOCK-2) — plus the wrong-session falsifier: an entry pointed at a
// session that is not on disk records its own failure and leaves every other session's rows alone. The child
// tests fork a real process; this vitest worker carries no TypeScript loader, so they supply one.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { execa } from "execa";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type Db, closeDb, openMemoryDb } from "../evidence/db.js";
import { parseDigestArgs, runDigestEntry } from "./digest-entry.js";

const NOW = "2026-07-04T00:00:00.000Z";
const FAKE = JSON.stringify({
  decisions: [{ topic: "fake", body: "fake decision" }],
  summary: "fake",
});
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const ENTRY = fileURLToPath(new URL("digest-entry.ts", import.meta.url));
const TSX_LOADER = pathToFileURL(
  join(REPO, "node_modules", "tsx", "dist", "esm", "index.mjs"),
).href;
const TSCONFIG = join(REPO, "tsconfig.json");

let tempRoot: string | undefined;
const savedDebug = process.env.ZER0_DEBUG;
const savedFake = process.env.ZER0_DIGEST_FAKE;

beforeEach(() => {
  process.env.ZER0_DEBUG = "0";
  delete process.env.ZER0_DIGEST_FAKE;
});

// These children are AWAITED (execa), so their exit code and their byte-empty streams are already the
// evidence — but F9 still applies to the workspace: a failed assertion here must leave the DB, the failure
// log and the leases on disk to be read, not delete them on the way out.
afterEach((ctx) => {
  restore("ZER0_DEBUG", savedDebug);
  restore("ZER0_DIGEST_FAKE", savedFake);
  if (tempRoot !== undefined) {
    if (ctx.task.result?.state === "fail") {
      process.stderr.write(`RETAINED digest workspace for diagnosis: ${tempRoot}\n`);
    } else {
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
    }
    tempRoot = undefined;
  }
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function freshWorkspace(): { db: Db; repoRoot: string; dbPath: string } {
  tempRoot = mkdtempSync(join(tmpdir(), "zer0-dentry-"));
  const dbPath = join(tempRoot, "evidence.db");
  const db = openMemoryDb(dbPath);
  db.prepare(
    "INSERT OR IGNORE INTO projects (project_id, canonical_root, git_common_dir, created_at) VALUES (?, ?, ?, ?)",
  ).run("p1", tempRoot, `${tempRoot}/.git`, NOW);
  return { db, repoRoot: tempRoot, dbPath };
}

async function writeSession(repoRoot: string, sessionId: `chat-${string}`): Promise<void> {
  const runDir = join(repoRoot, ".council", "runs", sessionId);
  await mkdir(runDir, { recursive: true });
  const session = {
    id: sessionId,
    repoRoot,
    runDir,
    createdAt: NOW,
    updatedAt: NOW,
    defaultAgent: "claude",
    lastAgent: "claude",
    summary: { text: "", throughTurn: 0 },
    messages: [
      {
        id: `${sessionId}-m1`,
        turn: 1,
        role: "agent",
        agent: "claude",
        text: "did work",
        createdAt: NOW,
        status: "completed",
        tokenEstimate: 4,
      },
    ],
  };
  await writeFile(join(runDir, "transcript.json"), JSON.stringify(session), "utf8");
}

function countRows(db: Db, sql: string, ...params: readonly string[]): number {
  return (db.prepare(sql).get(...params) as { c: number }).c;
}

function decisionCount(db: Db): number {
  return countRows(db, "SELECT COUNT(*) AS c FROM journal_entries WHERE category = 'decision'");
}

function scratchBodies(db: Db): string[] {
  return (
    db.prepare("SELECT body FROM journal_entries WHERE category = 'scratch'").all() as {
      body: string;
    }[]
  ).map((row) => row.body);
}

function watermarkCount(db: Db, sessionId: string): number {
  return countRows(
    db,
    "SELECT COUNT(*) AS c FROM digest_watermark WHERE session_id = ?",
    sessionId,
  );
}

it("the detached digest emits ZERO stdout/stderr and writes NO trace when ZER0_DEBUG is off (8)", async () => {
  const { db, repoRoot, dbPath } = freshWorkspace();
  try {
    await writeSession(repoRoot, "chat-1");
    const result = await execa(
      process.execPath,
      ["--import", TSX_LOADER, ENTRY, "chat-1", repoRoot, dbPath, "p1"],
      {
        cwd: repoRoot,
        env: { ZER0_DIGEST_FAKE: FAKE, NODE_NO_WARNINGS: "1", TSX_TSCONFIG_PATH: TSCONFIG },
        reject: false,
      },
    );
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(existsSync(join(repoRoot, ".zer0", "debug"))).toBe(false); // no trace folder at all
    expect(decisionCount(db)).toBe(1); // it still did the work, silently
  } finally {
    closeDb(db);
  }
}, 60_000);

it("the detached digest writes a memory.trace into the session debug folder when ZER0_DEBUG is on (8)", async () => {
  const { db, repoRoot, dbPath } = freshWorkspace();
  try {
    await writeSession(repoRoot, "chat-1");
    await execa(
      process.execPath,
      ["--import", TSX_LOADER, ENTRY, "chat-1", repoRoot, dbPath, "p1"],
      {
        cwd: repoRoot,
        env: {
          ZER0_DEBUG: "1",
          ZER0_DIGEST_FAKE: FAKE,
          NODE_NO_WARNINGS: "1",
          TSX_TSCONFIG_PATH: TSCONFIG,
        },
        reject: false,
      },
    );
    const traceFile = join(repoRoot, ".zer0", "debug", "chat-1", "trace.ndjson");
    expect(existsSync(traceFile)).toBe(true);
  } finally {
    closeDb(db);
  }
}, 60_000);

it("a fatal digest (poisoned DB) exits byte-silent BUT leaves a durable failure record (BLOCK-2)", async () => {
  tempRoot = mkdtempSync(join(tmpdir(), "zer0-cata-"));
  const repoRoot = tempRoot;
  const dbPath = join(repoRoot, "evidence.db");
  await writeSession(repoRoot, "chat-1");
  writeFileSync(dbPath, "not a sqlite database", "utf8"); // openMemoryDb throws in the child → catastrophe
  const result = await execa(
    process.execPath,
    ["--import", TSX_LOADER, ENTRY, "chat-1", repoRoot, dbPath, "p1"],
    { cwd: repoRoot, env: { NODE_NO_WARNINGS: "1", TSX_TSCONFIG_PATH: TSCONFIG }, reject: false },
  );
  expect(result.stdout).toBe(""); // O2 preserved even on the catastrophe path
  expect(result.stderr).toBe("");
  const log = join(repoRoot, ".zer0", "journal", "digest-failures.log");
  expect(existsSync(log)).toBe(true);
  const text = readFileSync(log, "utf8");
  expect(text).toContain("chat-1");
  expect(text).toContain("[digest-catastrophe]");
}, 30_000);

it("an entry pointed at a session that is NOT on disk records its own failure and touches no other rows", async () => {
  const { db, repoRoot, dbPath } = freshWorkspace();
  try {
    process.env.ZER0_DIGEST_FAKE = FAKE;
    await writeSession(repoRoot, "chat-real");
    await runDigestEntry(["chat-real", repoRoot, dbPath, "p1"]);
    const before = {
      decisions: decisionCount(db),
      watermark: watermarkCount(db, "chat-real"),
      scratch: scratchBodies(db).length,
    };
    expect(before).toEqual({ decisions: 1, watermark: 1, scratch: 0 });

    await runDigestEntry(["chat-ghost", repoRoot, dbPath, "p1"]);

    const bodies = scratchBodies(db);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("[digest-catastrophe]");
    expect(bodies[0]).toContain("chat-ghost");
    expect({
      decisions: decisionCount(db),
      watermark: watermarkCount(db, "chat-real"),
      ghostWatermark: watermarkCount(db, "chat-ghost"),
    }).toEqual({ decisions: 1, watermark: 1, ghostWatermark: 0 });
  } finally {
    closeDb(db);
  }
}, 30_000);

it("a second pass over an already-digested session writes nothing new (replay stable)", async () => {
  const { db, repoRoot, dbPath } = freshWorkspace();
  try {
    process.env.ZER0_DIGEST_FAKE = FAKE;
    await writeSession(repoRoot, "chat-replay");
    await runDigestEntry(["chat-replay", repoRoot, dbPath, "p1"]);
    const first = {
      decisions: decisionCount(db),
      watermark: watermarkCount(db, "chat-replay"),
      scratch: scratchBodies(db).length,
    };
    await runDigestEntry(["chat-replay", repoRoot, dbPath, "p1"]);
    expect({
      decisions: decisionCount(db),
      watermark: watermarkCount(db, "chat-replay"),
      scratch: scratchBodies(db).length,
    }).toEqual(first);
    expect(first).toEqual({ decisions: 1, watermark: 1, scratch: 0 });
  } finally {
    closeDb(db);
  }
}, 30_000);

it("an extraction that yields nothing advances only the watermark and writes no fact (C7 proof 5 shape)", async () => {
  const { db, repoRoot, dbPath } = freshWorkspace();
  try {
    process.env.ZER0_DIGEST_FAKE = JSON.stringify({ decisions: [], summary: "" });
    await writeSession(repoRoot, "chat-empty");
    await runDigestEntry(["chat-empty", repoRoot, dbPath, "p1"]);
    expect({
      journal: countRows(db, "SELECT COUNT(*) AS c FROM journal_entries"),
      watermark: watermarkCount(db, "chat-empty"),
    }).toEqual({ journal: 0, watermark: 1 });
  } finally {
    closeDb(db);
  }
}, 30_000);

it("a malformed invocation has no durable target, so it is rejected before anything is opened", () => {
  expect(parseDigestArgs(["chat-1", "/repo", "/db"])).toBeUndefined();
  expect(parseDigestArgs(["not-a-session", "/repo", "/db", "p1"])).toBeUndefined();
  expect(parseDigestArgs([])).toBeUndefined();
  expect(parseDigestArgs(["chat-1", "/repo", "/db", "p1"])).toEqual({
    sessionId: "chat-1",
    repoRoot: "/repo",
    dbPath: "/db",
    projectId: "p1",
  });
});

// ---- FL-074: the digest child meets a CONCURRENT write lock ------------------------------------------
// Oracle proof 5 (2026-08-19) caught a REDUNDANT same-session child — the second close trigger's, spawned
// 1.7s after the first had already landed the session's facts + watermark — hit `database is locked` while
// another host legitimately held the DB, and record a [digest-catastrophe] scratch row for a session whose
// memory was ALREADY durable. Real child processes, a real second connection holding a real write lock,
// real SQLite: the collision is produced, never simulated.
const HOLD_PAST_OLD_CEILING_MS = 4_000;

function holdWriteLock(dbPath: string): Database.Database {
  const holder = new Database(dbPath);
  holder.exec("BEGIN IMMEDIATE"); // a real held write lock from a second connection (ledger.test.ts shape)
  holder.exec("CREATE TABLE IF NOT EXISTS _fl074_holder (x)"); // ...carrying a real write
  return holder;
}

function releaseWriteLock(holder: Database.Database | undefined): undefined {
  if (holder === undefined) return undefined;
  holder.exec("ROLLBACK");
  holder.close();
  return undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The other durable sink. recordDigestCatastrophe prefers a scratch row and falls back to this log when the
// DB is itself the busy resource - so a test that only counted rows would call a logged catastrophe clean.
function failureLogLines(repoRoot: string): string[] {
  const log = join(repoRoot, ".zer0", "journal", "digest-failures.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.includes("[digest-catastrophe]"));
}

// The child's own single-flight lease is the only observable that says "the child is now contending".
// Anchoring the hold to IT rather than to this process's clock keeps the timing independent of how long
// the forked runtime took to boot (seconds, under the tsx loader).
async function awaitLease(repoRoot: string, sessionId: string, budgetMs: number): Promise<boolean> {
  const file = join(repoRoot, ".zer0", "leases", `digest-${sessionId}.lock`);
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return true;
    await sleep(25);
  }
  return false;
}

function forkEntry(
  sessionId: string,
  repoRoot: string,
  dbPath: string,
): Promise<{ stdout: string; stderr: string }> {
  return execa(
    process.execPath,
    ["--import", TSX_LOADER, ENTRY, sessionId, repoRoot, dbPath, "p1"],
    {
      cwd: repoRoot,
      env: { ZER0_DIGEST_FAKE: FAKE, NODE_NO_WARNINGS: "1", TSX_TSCONFIG_PATH: TSCONFIG },
      reject: false,
    },
  );
}

it("a REDUNDANT already-settled child writes NOTHING while another process holds the write lock (FL-074)", async () => {
  const { db, repoRoot, dbPath } = freshWorkspace();
  let holder: Database.Database | undefined;
  try {
    process.env.ZER0_DIGEST_FAKE = FAKE;
    await writeSession(repoRoot, "chat-busy");
    await runDigestEntry(["chat-busy", repoRoot, dbPath, "p1"]); // the FIRST close's child lands the facts
    const settled = { decisions: decisionCount(db), watermark: watermarkCount(db, "chat-busy") };
    expect(settled).toEqual({ decisions: 1, watermark: 1 });

    holder = holdWriteLock(dbPath); // another host legitimately holds the DB, exactly as in proof 5
    const result = await forkEntry("chat-busy", repoRoot, dbPath); // the SECOND close's redundant child

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(scratchBodies(db)).toEqual([]); // a collision must NEVER manufacture a catastrophe...
    expect(failureLogLines(repoRoot)).toEqual([]); // ...in EITHER durable sink
    expect({ decisions: decisionCount(db), watermark: watermarkCount(db, "chat-busy") }).toEqual(
      settled,
    );
  } finally {
    holder = releaseWriteLock(holder);
    closeDb(db);
  }
}, 90_000);

it("a child with REAL work waits out a lock held past the old ceiling instead of a catastrophe (FL-074)", async () => {
  const { db, repoRoot, dbPath } = freshWorkspace();
  let holder: Database.Database | undefined;
  try {
    await writeSession(repoRoot, "chat-wait");
    holder = holdWriteLock(dbPath);
    const child = forkEntry("chat-wait", repoRoot, dbPath);
    expect(await awaitLease(repoRoot, "chat-wait", 60_000)).toBe(true);
    await sleep(HOLD_PAST_OLD_CEILING_MS); // past the old 10x60ms ladder, inside the honest budget
    holder = releaseWriteLock(holder);
    const result = await child;

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(scratchBodies(db)).toEqual([]);
    expect(failureLogLines(repoRoot)).toEqual([]);
    expect({ decisions: decisionCount(db), watermark: watermarkCount(db, "chat-wait") }).toEqual({
      decisions: 1,
      watermark: 1,
    });
  } finally {
    holder = releaseWriteLock(holder);
    closeDb(db);
  }
}, 120_000);

it("a GENUINELY exhausted busy budget records ONE catastrophe naming how long it waited (FL-074)", async () => {
  const { db, repoRoot, dbPath } = freshWorkspace();
  let holder: Database.Database | undefined;
  try {
    process.env.ZER0_DIGEST_FAKE = FAKE;
    await writeSession(repoRoot, "chat-exhaust");
    holder = holdWriteLock(dbPath); // never released — the budget genuinely runs out
    await runDigestEntry(["chat-exhaust", repoRoot, dbPath, "p1"], { busyBudgetMs: 400 });
    holder = releaseWriteLock(holder);

    // The DB is the thing that is busy, so the durable record is the last-resort log, not a scratch row.
    const lines = failureLogLines(repoRoot);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/busy-exhausted-after-\d+ms/);
    expect(lines[0]).toContain("chat-exhaust");
    expect({
      journal: countRows(db, "SELECT COUNT(*) AS c FROM journal_entries"),
      watermark: watermarkCount(db, "chat-exhaust"),
    }).toEqual({ journal: 0, watermark: 0 });
  } finally {
    holder = releaseWriteLock(holder);
    closeDb(db);
  }
}, 60_000);
