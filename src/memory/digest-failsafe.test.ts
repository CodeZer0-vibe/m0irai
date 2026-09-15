// digest-failsafe: the fail-OPEN single-flight (acquire / skip-when-live / reclaim-when-stale / release) and
// the durable catastrophe recorder (best-effort DB scratch row → last-resort .zer0/journal log). Real fs +
// real sqlite. Top-level it() (no describe wrapper) to keep every callback under the 50-line clamp.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type Db, closeDb, openMemoryDb } from "../evidence/db.js";
import {
  type DigestRunCtx,
  acquireDigestLock,
  recordDigestCatastrophe,
  releaseDigestLock,
} from "./digest-failsafe.js";

const NOW_MS = 1_800_000_000_000;
const NOW_ISO = "2026-07-04T00:00:00.000Z";
const DEAD_PID = 2_147_483_646; // no such process → process.kill(pid,0) throws ESRCH → treated as gone
let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

function freshRoot(): string {
  tempRoot = mkdtempSync(join(tmpdir(), "zer0-failsafe-"));
  return tempRoot;
}

function lockFile(root: string): string {
  return join(root, ".zer0", "leases", "digest-chat-1.lock");
}

function seedLock(root: string, pid: number, expiresAt: number): void {
  mkdirSync(join(root, ".zer0", "leases"), { recursive: true });
  writeFileSync(lockFile(root), JSON.stringify({ pid, expiresAt }), "utf8");
}

it("acquireDigestLock on a free session returns a held lock and writes the lock file", () => {
  const root = freshRoot();
  const lock = acquireDigestLock(root, "chat-1", NOW_MS, 1234);
  expect(lock === "in-flight" || lock === "no-lock").toBe(false);
  expect(existsSync(lockFile(root))).toBe(true);
});

it("acquireDigestLock returns 'in-flight' when a LIVE sibling (alive pid, unexpired) holds it (BLOCK-1)", () => {
  const root = freshRoot();
  seedLock(root, process.pid, NOW_MS + 60_000); // our own pid is alive; expiry in the future
  expect(acquireDigestLock(root, "chat-1", NOW_MS, 999)).toBe("in-flight");
});

it("acquireDigestLock reclaims a lock whose holder pid is GONE (stale) and acquires", () => {
  const root = freshRoot();
  seedLock(root, DEAD_PID, NOW_MS + 60_000); // future expiry but a dead pid → stale
  const lock = acquireDigestLock(root, "chat-1", NOW_MS, 4321);
  expect(lock === "in-flight" || lock === "no-lock").toBe(false);
});

it("acquireDigestLock reclaims an EXPIRED lock even when the pid is alive", () => {
  const root = freshRoot();
  seedLock(root, process.pid, NOW_MS - 1); // alive pid but already expired → stale
  const lock = acquireDigestLock(root, "chat-1", NOW_MS, 4321);
  expect(lock === "in-flight" || lock === "no-lock").toBe(false);
});

it("acquireDigestLock fails OPEN ('no-lock') on a garbage lock file (never silently skips a digest)", () => {
  const root = freshRoot();
  mkdirSync(join(root, ".zer0", "leases"), { recursive: true });
  writeFileSync(lockFile(root), "}{ not json", "utf8");
  expect(acquireDigestLock(root, "chat-1", NOW_MS, 7)).toBe("no-lock");
});

it("releaseDigestLock removes our own lock but never a foreign pid's lock", () => {
  const root = freshRoot();
  const lock = acquireDigestLock(root, "chat-1", NOW_MS, 555);
  if (lock === "in-flight" || lock === "no-lock") throw new Error("expected a held lock");
  releaseDigestLock(lock);
  expect(existsSync(lockFile(root))).toBe(false);
  seedLock(root, process.pid, NOW_MS + 60_000); // a foreign (different pid) live lock
  releaseDigestLock({ path: lockFile(root), pid: 555 });
  expect(existsSync(lockFile(root))).toBe(true);
});

function seedProject(db: Db, root: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO projects (project_id, canonical_root, git_common_dir, created_at) VALUES (?, ?, ?, ?)",
  ).run("p1", root, `${root}/.git`, NOW_ISO);
}

it("recordDigestCatastrophe writes a classified scratch row when the DB is healthy (BLOCK-2 best-effort)", () => {
  const root = freshRoot();
  const dbPath = join(root, "evidence.db");
  const db = openMemoryDb(dbPath);
  seedProject(db, root);
  closeDb(db); // recordDigestCatastrophe opens its OWN fresh handle
  const ctx: DigestRunCtx = { sessionId: "chat-1", repoRoot: root, dbPath, projectId: "p1" };
  recordDigestCatastrophe(ctx, NOW_ISO, new Error("loadSession ENOENT"));
  const reopened = openMemoryDb(dbPath);
  try {
    const row = reopened
      .prepare("SELECT body FROM journal_entries WHERE category = 'scratch'")
      .get() as { body: string } | undefined;
    expect(row?.body).toContain("[digest-catastrophe]");
    expect(row?.body).toContain("loadSession ENOENT");
  } finally {
    closeDb(reopened);
  }
});

it("recordDigestCatastrophe last-resorts to .zer0/journal/digest-failures.log when the DB is poisoned (BLOCK-2)", () => {
  const root = freshRoot();
  const dbPath = join(root, "evidence.db");
  writeFileSync(dbPath, "not a sqlite database", "utf8"); // openMemoryDb will throw → fallback log
  const ctx: DigestRunCtx = { sessionId: "chat-1", repoRoot: root, dbPath, projectId: "p1" };
  recordDigestCatastrophe(ctx, NOW_ISO, new Error("SQLITE_NOTADB"));
  const log = join(root, ".zer0", "journal", "digest-failures.log");
  expect(existsSync(log)).toBe(true);
  const text = readFileSync(log, "utf8");
  expect(text).toContain("session=chat-1");
  expect(text).toContain("[digest-catastrophe]");
});
