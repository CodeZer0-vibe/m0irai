/**
 * @file src/chat/lane-carrier.two-process.test.ts
 * @purpose T5 acceptance 10 with REAL second processes (not a same-process simulation): (1) the I-14 lane
 *   lock — a live spawned sleeper owns the lock through the real API, the parent's own-pid acquire reads
 *   "conflict" from the REAL pid-liveness probe, and killing the sleeper proves stale-reclaim; (2) F-16
 *   seq minting stays OPEN to a second cockpit — a genuinely separate node process (tsx child running the
 *   REAL mintSeq) mints into the same DB file the parent holds open, and the parent sees the row and
 *   mints the NEXT seq after it.
 * @exports (none — test file)
 * @depends vitest, node:child_process, node:fs, node:os, node:path, execa, ../evidence/db, ../memory/ledger, ./lane-carrier
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, expect, it } from "vitest";
import { type Db, closeDb, openLaneStateDb } from "../evidence/db.js";
import { getSeqForMessage, mintSeq } from "../memory/ledger.js";
import { acquireLaneCarrierLock, releaseLaneCarrierLock } from "./lane-carrier.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
let tempRoot: string | undefined;
const dbs: Db[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) closeDb(db);
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    tempRoot = undefined;
  }
});

function tempDir(): string {
  tempRoot = mkdtempSync(path.join(tmpdir(), "two-proc-"));
  return tempRoot;
}

it("I-14: a LIVE second process holds the lane lock -> conflict; its death -> stale reclaim", async () => {
  const root = tempDir();
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    const sleeperPid = sleeper.pid;
    if (sleeperPid === undefined) throw new Error("sleeper failed to spawn");
    const held = acquireLaneCarrierLock(root, "p1", Date.now(), sleeperPid);
    expect(held).not.toBe("conflict");
    expect(held).not.toBe("no-lock");

    // The parent (a REAL different pid) must read conflict from the live-pid probe.
    expect(acquireLaneCarrierLock(root, "p1", Date.now(), process.pid)).toBe("conflict");

    sleeper.kill();
    await new Promise<void>((resolve) => sleeper.once("exit", () => resolve()));
    const reclaimed = acquireLaneCarrierLock(root, "p1", Date.now(), process.pid);
    expect(reclaimed).not.toBe("conflict"); // dead holder = stale, reclaimable
    if (reclaimed !== "conflict" && reclaimed !== "no-lock") releaseLaneCarrierLock(reclaimed);
  } finally {
    if (sleeper.exitCode === null) sleeper.kill();
  }
});

it("F-16: a genuinely SEPARATE process mints a seq into the shared DB and the parent orders after it", async () => {
  const root = tempDir();
  const dbPath = path.join(root, "evidence.db");
  const db = openLaneStateDb(dbPath);
  dbs.push(db);
  db.prepare(
    "INSERT INTO projects(project_id, canonical_root, git_common_dir, created_at) VALUES (?,?,?,?)",
  ).run("p1", "C:/tmp/p", "C:/tmp/p/.git", "2026-07-10T00:00:00Z");

  const child = await execa(
    process.execPath,
    [
      path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(REPO_ROOT, "tests", "helpers", "mint-seq-child.mts"),
      dbPath,
      "m-child",
    ],
    { cwd: REPO_ROOT, reject: false, timeout: 60_000 },
  );
  expect(child.stdout).toContain("minted:1");
  expect(child.exitCode).toBe(0);

  expect(getSeqForMessage(db, "p1", "m-child")).toBe(1); // the parent SEES the second cockpit's row
  expect(mintSeq(db, "p1", "m-parent")).toBe(2); // and orders strictly after it
}, 90_000);
