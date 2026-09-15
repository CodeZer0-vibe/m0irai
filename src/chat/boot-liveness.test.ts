/**
 * @file src/chat/boot-liveness.test.ts
 * @exports (none — test file)
 * @depends vitest, node:child_process, node:fs, node:os, node:path, ../evidence/db, ./boot-liveness
 * @purpose THE LIVENESS PROMISE: resolveBootLiveness resolves a real project id and acquires the REAL
 *   pid-verified lock (lane-carrier.ts's acquireLaneCarrierLock, never mocked) regardless of
 *   ZER0_MEMORY — the operator-adjudicated gap wave-8 disclosed (isSessionLive answering "no signal
 *   -> live -> no-op" on every memory-off boot) closed. Relocated verbatim from
 *   review-boot-liveness.test.ts (W3, THE GREAT DELETION, 2026-07-17): review-boot.ts's own 4-stage
 *   write-queue/checkpoint/review-redirect recovery orchestration is deleted along with the rest of
 *   the capture apparatus; the liveness lock this file tests is the ONE part of that module that
 *   survived, relocated to boot-liveness.ts. Only the import path changed — every assertion below is
 *   byte-identical to the pre-W3 file.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { type Db, closeDb, openLaneStateDb } from "../evidence/db.js";
import { resolveBootLiveness, resolveBootProjectId } from "./boot-liveness.js";

const cleanupRoots: string[] = [];
const openDbs: Db[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepo(): { repoRoot: string; db: Db; dbPath: string } {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "rbootlive-repo-"));
  const dbDir = mkdtempSync(path.join(tmpdir(), "rbootlive-db-"));
  cleanupRoots.push(repoRoot, dbDir);
  git(repoRoot, "init", "-q");
  git(repoRoot, "config", "user.email", "t@t.t");
  git(repoRoot, "config", "user.name", "t");
  writeFileSync(path.join(repoRoot, "base.txt"), "base v1\n");
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-q", "-m", "init");
  const dbPath = path.join(dbDir, "evidence.db");
  const db = openLaneStateDb(dbPath);
  openDbs.push(db);
  return { repoRoot, db, dbPath };
}

afterEach(() => {
  for (const db of openDbs.splice(0)) if (db.open) closeDb(db);
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

it("F4: resolveBootProjectId resolves a real project id for a real git repo, WITHOUT any ZER0_MEMORY dependency — the function never reads that env var at all", async () => {
  const { repoRoot, db } = makeRepo();

  const projectId = await resolveBootProjectId(db, repoRoot);

  expect(projectId).toBeDefined();
  const row = db.prepare("SELECT project_id FROM projects WHERE project_id = ?").get(projectId) as
    | { project_id: string }
    | undefined;
  expect(row).toBeDefined();
});

it("F4 THE LIVENESS PROMISE: a fresh boot with no prior holder acquires the REAL pid-verified lock file on disk — isLive() reports false (dead/absent), recovery should engage", async () => {
  const { repoRoot, db } = makeRepo();

  const liveness = await resolveBootLiveness(db, repoRoot);

  expect(liveness.projectId).toBeDefined();
  expect(liveness.lock).toBeDefined();
  expect(liveness.conflict).toBe(false);
  // FALSIFYING: a real lock FILE exists on disk — this is lane-carrier.ts's own real
  // acquireDigestLock primitive, not a mock.
  expect(
    existsSync(path.join(repoRoot, ".zer0", "leases", `digest-lane-${liveness.projectId}.lock`)),
  ).toBe(true);
  expect(liveness.isLive(repoRoot)).toBe(false);
});

it("F4 THE LIVENESS PROMISE: a SECOND resolveBootLiveness call for the SAME repo (simulating a second live zer0 process) correctly conflicts — isLive() reports true", async () => {
  const { repoRoot, db } = makeRepo();
  const first = await resolveBootLiveness(db, repoRoot);
  expect(first.lock).toBeDefined();

  const second = await resolveBootLiveness(db, repoRoot);

  // FALSIFYING: the SAME lock file cannot be double-acquired — the second caller sees a genuine
  // conflict (a live holder), never a silent second lock.
  expect(second.conflict).toBe(true);
  expect(second.lock).toBeUndefined();
  expect(second.isLive(repoRoot)).toBe(true);
});

it("F4: an unresolvable project (non-git folder) stays fail-safe 'live' — never a fabricated lock, never a crash", async () => {
  const dbDir = mkdtempSync(path.join(tmpdir(), "rbootlive-nogit-db-"));
  const nonGitRoot = mkdtempSync(path.join(tmpdir(), "rbootlive-nogit-"));
  cleanupRoots.push(dbDir, nonGitRoot);
  const db = openLaneStateDb(path.join(dbDir, "evidence.db"));
  openDbs.push(db);

  const liveness = await resolveBootLiveness(db, nonGitRoot);

  expect(liveness.projectId).toBeUndefined();
  expect(liveness.lock).toBeUndefined();
  expect(liveness.isLive(nonGitRoot)).toBe(true);
});
