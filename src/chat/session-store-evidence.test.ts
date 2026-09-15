/**
 * @file src/chat/session-store-evidence.test.ts
 * @purpose Integration tests for session-store evidence writes that need real git scoping + SQLite.
 * @exports (none)
 * @depends vitest, node:fs/promises, node:os, node:path, execa, ../evidence/db, ../memory/project-scope, ./session-store
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, expect, it } from "vitest";
import { type Db, closeDb, openDb } from "../evidence/db.js";
import { resolveProjectId } from "../memory/project-scope.js";
import { persistSession } from "./session-store.js";
import type { ChatSession } from "./types.js";

const NOW: string = "2026-07-05T00:00:00.000Z";
const SESSION_ID: `chat-${string}` = "chat-project-scope";
const GIT_OPTS = { reject: false, shell: false } as const;

const tempDirs: string[] = [];
let previousDbPath: string | undefined;

afterEach(async () => {
  restoreDbEnv();
  await Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true })));
  tempDirs.length = 0;
});

it("tags persisted chat_sessions with the resolved project_id", async () => {
  const repoRoot = await makeRepo();
  const dbPath = await makeDbPath();
  process.env.ZER0_DB_PATH = dbPath;
  const scope = await scopedProject(repoRoot);
  seedProject(dbPath, scope);
  const session = await makeSession(repoRoot);

  await persistSession(session);

  expect(readSessionProjectId(dbPath, session.id)).toBe(scope.projectId);
});

interface ScopedProject {
  readonly projectId: string;
  readonly root: string;
  readonly commonDir: string;
  readonly remoteFingerprint: string;
}

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zer0-chat-session-repo-"));
  tempDirs.push(root);
  await execa("git", ["init"], { cwd: root, ...GIT_OPTS });
  await execa("git", ["config", "user.email", "test@zer0.test"], { cwd: root, ...GIT_OPTS });
  await execa("git", ["config", "user.name", "zer0 test"], { cwd: root, ...GIT_OPTS });
  await writeFile(join(root, "seed.txt"), "seed\n");
  await execa("git", ["add", "seed.txt"], { cwd: root, ...GIT_OPTS });
  await execa("git", ["commit", "-m", "initial"], { cwd: root, ...GIT_OPTS });
  return root;
}

async function makeDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zer0-chat-session-db-"));
  tempDirs.push(dir);
  previousDbPath = process.env.ZER0_DB_PATH;
  return join(dir, "evidence.db");
}

async function scopedProject(repoRoot: string): Promise<ScopedProject> {
  const scope = await resolveProjectId(repoRoot);
  if (scope.kind !== "scoped") {
    throw new Error(`expected scoped repo: ${scope.reason}`);
  }
  return scope;
}

function seedProject(dbPath: string, scope: ScopedProject): void {
  const db = openDb(dbPath);
  try {
    db.prepare(
      "INSERT INTO projects (project_id, canonical_root, git_common_dir, remote_fingerprint, aliases_json, quarantined, created_at) VALUES (?, ?, ?, ?, '[]', 0, ?)",
    ).run(scope.projectId, scope.root, scope.commonDir, scope.remoteFingerprint, NOW);
  } finally {
    closeDb(db);
  }
}

async function makeSession(repoRoot: string): Promise<ChatSession> {
  const runDir = join(repoRoot, ".council", "runs", SESSION_ID);
  await mkdir(runDir, { recursive: true });
  return {
    id: SESSION_ID,
    repoRoot,
    runDir,
    createdAt: NOW,
    updatedAt: NOW,
    defaultAgent: "claude",
    lastAgent: null,
    summary: { text: "", throughTurn: 0 },
    messages: [],
  };
}

function readSessionProjectId(dbPath: string, sessionId: string): string | null {
  const db: Db = openDb(dbPath);
  try {
    const row = db
      .prepare("SELECT project_id AS projectId FROM chat_sessions WHERE id = ?")
      .get(sessionId) as { readonly projectId: string | null };
    return row.projectId;
  } finally {
    closeDb(db);
  }
}

function restoreDbEnv(): void {
  if (previousDbPath === undefined) {
    delete process.env.ZER0_DB_PATH;
    return;
  }
  process.env.ZER0_DB_PATH = previousDbPath;
}
