/**
 * @file src/chat/session-store-ambient-db.test.ts
 * @purpose W4-R3a C2 falsifier: persistSession must record its session evidence into the RUN'S OWN store,
 *   never into whatever a fresh ambient `loadConfig()` resolves from the process's current cwd.
 *   This is not a hygiene test. At base it is how 14,434 junk `chat_sessions` rows (109 per `npm test`)
 *   reached the operator's dogfood `.zer0/evidence.db`: a caller opens a correctly isolated db, and
 *   persistSessionEvidence then re-derives DEFAULT_DB_PATH (".zer0/evidence.db", config.ts:17) against the
 *   PROCESS cwd and writes somewhere else entirely. Same identity-by-ambient-spelling defect as the ledger
 *   leak — a store must be carried, not guessed.
 *   The decoy cwd stands in for "wherever the cwd-relative default would have pointed"; asserting the decoy
 *   db is never even CREATED is the both-directions proof (right store written, wrong store untouched).
 * @exports (test suite)
 * @depends node:fs, node:fs/promises, node:os, node:path, node:process, vitest, ../evidence/db,
 *   ./lane-transport, ./session-store
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, beforeEach, expect, it } from "vitest";
import { closeDb, openLaneStateDb } from "../evidence/db.js";
import { initCarrierRuntime, resetCarrierRuntime } from "./lane-transport.js";
import { createSession } from "./session-store.js";

const DB_PATH_ENV: string = "ZER0_DB_PATH";
const dirs: string[] = [];
const saved = {
  memory: process.env.ZER0_MEMORY,
  resume: process.env.ZER0_NATIVE_RESUME,
  dbPath: process.env[DB_PATH_ENV],
};
let savedCwd: string | undefined;

beforeEach(() => {
  process.env.ZER0_MEMORY = "1";
  process.env.ZER0_NATIVE_RESUME = "1";
  // The suite's own per-worker redirect (vitest.setup.ts) would MASK the defect by making the ambient
  // answer harmless. Clear it so this test measures the product, not the harness.
  Reflect.deleteProperty(process.env, DB_PATH_ENV);
  savedCwd = process.cwd();
});

afterEach(async () => {
  if (savedCwd !== undefined) process.chdir(savedCwd); // BEFORE rm — Windows holds an open cwd
  resetCarrierRuntime();
  restore("ZER0_MEMORY", saved.memory);
  restore("ZER0_NATIVE_RESUME", saved.resume);
  restore(DB_PATH_ENV, saved.dbPath);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

it("persistSession records into the CARRIER's db, and never into the cwd-relative ambient default", async () => {
  const repoRoot = await tempDir("session-store-ambient-repo-");
  const storeRoot = await tempDir("session-store-ambient-store-");
  const decoyCwd = await tempDir("session-store-ambient-decoy-");
  const carrierDbPath = path.join(storeRoot, "evidence.db");
  // Where a bare loadConfig() would land once cwd is the decoy — the exact shape of the leak: the WRONG
  // path is a cwd-relative default, not some fixed file.
  const decoyDbPath = path.join(decoyCwd, ".zer0", "evidence.db");

  initCarrierRuntime({
    projectId: "p-ambient",
    dbPath: carrierDbPath,
    repoRoot,
    cwd: repoRoot,
  });

  process.chdir(decoyCwd);
  const session = await createSession(repoRoot); // createSession persists, which records the evidence

  expect(existsSync(decoyDbPath)).toBe(false); // the ambient store is never even created
  const db = openLaneStateDb(carrierDbPath);
  try {
    const row = db
      .prepare("SELECT id, repo_root AS repoRoot FROM chat_sessions WHERE id = ?")
      .get(session.id) as { id: string; repoRoot: string } | undefined;
    expect(row?.id).toBe(session.id); // it landed in the run's OWN store
  } finally {
    closeDb(db);
  }
});

it("with NO carrier the ambient config stays the answer — the fix carries identity, it does not invent one", async () => {
  const repoRoot = await tempDir("session-store-noc-repo-");
  const ambientCwd = await tempDir("session-store-noc-cwd-");
  resetCarrierRuntime(); // no owner: loadConfig() is the honest resolution, exactly as before

  process.chdir(ambientCwd);
  const session = await createSession(repoRoot);

  // Unchanged legacy behaviour: the cwd-relative default resolves under the current cwd and is written.
  const ambientDbPath = path.join(ambientCwd, ".zer0", "evidence.db");
  expect(existsSync(ambientDbPath)).toBe(true);
  const db = openLaneStateDb(ambientDbPath);
  try {
    const row = db.prepare("SELECT id FROM chat_sessions WHERE id = ?").get(session.id) as
      | { id: string }
      | undefined;
    expect(row?.id).toBe(session.id);
  } finally {
    closeDb(db);
  }
});
