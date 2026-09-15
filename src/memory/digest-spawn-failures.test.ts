// The spawn seam FAILURE paths, split out of digest-runner.test.ts when that file reached its 500-line
// clamp: one subject, and the subject the whole A6/R1/codex-#9 line of work exists for — a digest that could
// not start must leave a DURABLE, CLASSIFIED record, never a silent nothing. A missing entry, an OS spawn
// error, a child that dies during bootstrap, and a child that exits cleanly (which must record NOTHING).
// Real fs + sqlite; the process seam is injected so the OS failures are reproducible instead of hoped for.
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type Db, closeDb, openMemoryDb } from "../evidence/db.js";
import {
  type DigestRequest,
  type DigestSpawnImpl,
  createDetachedSpawn,
  digestEntryPath,
} from "./digest-runner.js";

const NOW = "2026-07-04T00:00:00.000Z";

let tempRoot: string | undefined;
const savedDebug = process.env.ZER0_DEBUG;
const savedFake = process.env.ZER0_DIGEST_FAKE;

beforeEach(() => {
  process.env.ZER0_DEBUG = "0"; // debug is on-by-default; this suite asserts the OFF baseline explicitly
  delete process.env.ZER0_DIGEST_FAKE;
});

afterEach((ctx) => {
  restore("ZER0_DEBUG", savedDebug);
  restore("ZER0_DIGEST_FAKE", savedFake);
  if (tempRoot !== undefined) {
    if (ctx.task.result?.state === "fail") {
      // Retained on purpose: the DB and .zer0/journal/digest-failures.log ARE the diagnosis.
      process.stderr.write(`RETAINED digest workspace for diagnosis: ${tempRoot}
`);
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
  tempRoot = mkdtempSync(join(tmpdir(), "zer0-dfail-"));
  const dbPath = join(tempRoot, "evidence.db");
  const db = openMemoryDb(dbPath);
  db.prepare(
    "INSERT OR IGNORE INTO projects (project_id, canonical_root, git_common_dir, created_at) VALUES (?, ?, ?, ?)",
  ).run("p1", tempRoot, `${tempRoot}/.git`, NOW);
  return { db, repoRoot: tempRoot, dbPath };
}

function decisionCount(db: Db): number {
  return (
    db.prepare("SELECT COUNT(*) AS c FROM journal_entries WHERE category = 'decision'").get() as {
      c: number;
    }
  ).c;
}

it("a MISSING entry records a durable classified failure and forks NOTHING (A6 — C5)", () => {
  const { db, repoRoot, dbPath } = freshWorkspace();
  try {
    const absent = join(repoRoot, "not-built", "digest-entry.js");
    expect(existsSync(absent)).toBe(false);
    createDetachedSpawn(absent)({
      sessionId: "chat-missing-entry",
      repoRoot,
      dbPath,
      projectId: "p1",
    });
    const rows = db
      .prepare("SELECT body FROM journal_entries WHERE category = 'scratch'")
      .all() as {
      body: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toContain("[digest-catastrophe]");
    expect(rows[0]?.body).toContain("chat-missing-entry");
    expect(decisionCount(db)).toBe(0); // nothing was forked, so nothing was digested
  } finally {
    closeDb(db);
  }
});

/** A child that could not be spawned at all: a real EventEmitter, so an unheard `error` throws exactly the
 *  way Node throws it — asynchronously, with nothing on the close path left to catch it. */
class UnspawnableChild extends EventEmitter {
  public unref(): void {
    // detaching a process that never started is a no-op, as it is for the real ChildProcess
  }
}

function failingSpawn(message: string): DigestSpawnImpl {
  return () => {
    const child = new UnspawnableChild();
    setTimeout(() => child.emit("error", new Error(message)), 0);
    return child;
  };
}

/** A child that STARTS and then dies — the bootstrap failure stdio:"ignore" would otherwise swallow. */
function exitingSpawn(code: number | null, signal: NodeJS.Signals | null = null): DigestSpawnImpl {
  return () => {
    const child = new UnspawnableChild();
    setTimeout(() => child.emit("exit", code, signal), 0);
    return child;
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

function scratchBodies(db: Db): string[] {
  return (
    db.prepare("SELECT body FROM journal_entries WHERE category = 'scratch'").all() as {
      body: string;
    }[]
  ).map((row) => row.body);
}

it("a spawn that FAILS records a durable failure instead of killing the host asynchronously (R1)", async () => {
  const { db, repoRoot, dbPath } = freshWorkspace();
  try {
    const started = Date.now();
    expect(() =>
      createDetachedSpawn(
        digestEntryPath(),
        failingSpawn("spawn EAGAIN"),
      )({
        sessionId: "chat-spawn-failed",
        repoRoot,
        dbPath,
        projectId: "p1",
      }),
    ).not.toThrow();
    expect(Date.now() - started).toBeLessThan(1_000); // the close is never blocked on the spawn outcome
    await new Promise((resolve) => setTimeout(resolve, 100)); // the OS reports the failure asynchronously

    const bodies = scratchBodies(db);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("[digest-catastrophe]");
    expect(bodies[0]).toContain("chat-spawn-failed");
    expect(bodies[0]).toContain("spawn EAGAIN");
    expect(decisionCount(db)).toBe(0);
  } finally {
    closeDb(db);
  }
});

it("a child that starts and DIES before recording anything leaves a durable failure (codex #9)", async () => {
  const { db, repoRoot, dbPath } = freshWorkspace();
  try {
    const request: DigestRequest = {
      sessionId: "chat-boot-failed",
      repoRoot,
      dbPath,
      projectId: "p1",
    };
    createDetachedSpawn(digestEntryPath(), exitingSpawn(1))(request);
    await settle();
    const bodies = scratchBodies(db);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("chat-boot-failed");
    expect(bodies[0]).toContain("digest child exited 1 before recording anything");

    // A killed child is just as silent, and just as recorded.
    createDetachedSpawn(
      digestEntryPath(),
      exitingSpawn(null, "SIGKILL"),
    )({
      ...request,
      sessionId: "chat-killed",
    });
    await settle();
    expect(scratchBodies(db).find((body) => body.includes("chat-killed"))).toContain("SIGKILL");
  } finally {
    closeDb(db);
  }
});

it("a child that exits CLEANLY records nothing — the success path stays silent (codex #9)", async () => {
  const { db, repoRoot, dbPath } = freshWorkspace();
  try {
    createDetachedSpawn(
      digestEntryPath(),
      exitingSpawn(0),
    )({
      sessionId: "chat-clean-exit",
      repoRoot,
      dbPath,
      projectId: "p1",
    });
    await settle();
    expect(scratchBodies(db)).toEqual([]);
  } finally {
    closeDb(db);
  }
});
