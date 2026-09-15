// digest-evidence is the thing that has to work exactly when everything else has already failed, so it is
// tested against a hand-built broken workspace: an unreadable DB, a catastrophe row, a failure log, a lease
// held by a pid that is gone. F9: a wait that times out and leaves no diagnosis is the defect these readers
// exist to prevent, so each reader is proven TOTAL (returns a line, never throws) and the wait is proven to
// stop on a durable failure record instead of burning its whole budget.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type Db, closeDb, openMemoryDb } from "../evidence/db.js";
import {
  awaitDigestEvidence,
  formatDigestEvidence,
  pidAlive,
  readDigestEvidence,
  readDigestRows,
} from "./digest-evidence.js";
import { appendEntry } from "./journal-store.js";

const NOW = "2026-08-18T00:00:00.000Z";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): { root: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "zer0-devidence-"));
  roots.push(root);
  return { root, dbPath: join(root, "evidence.db") };
}

function seedDb(root: string, dbPath: string): Db {
  const db = openMemoryDb(dbPath);
  db.prepare(
    "INSERT OR IGNORE INTO projects (project_id, canonical_root, git_common_dir, created_at) VALUES (?, ?, ?, ?)",
  ).run("p1", root, `${root}/.git`, NOW);
  return db;
}

/** A pid that certainly no longer exists: a real child, reaped before we ask. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid ?? 0;
  await new Promise((resolve) => child.on("exit", resolve));
  return pid;
}

it("readDigestRows is TOTAL: an absent DB reports why instead of throwing", () => {
  const { dbPath } = workspace();
  expect(readDigestRows(dbPath)).toEqual({
    decisions: 0,
    summaries: 0,
    scratch: [],
    watermarks: [],
    error: `db absent: ${dbPath}`,
  });
});

it("readDigestRows is TOTAL: a file that is not a database reports the open failure", () => {
  const { root, dbPath } = workspace();
  writeFileSync(dbPath, "not a sqlite database", "utf8");
  const rows = readDigestRows(dbPath);
  expect({ decisions: rows.decisions, hasError: rows.error !== undefined }).toEqual({
    decisions: 0,
    hasError: true,
  });
  expect(readDigestEvidence(root, dbPath).workspace).toBe(root);
});

it("readDigestRows counts what the digest actually wrote, per category", () => {
  const { root, dbPath } = workspace();
  const db = seedDb(root, dbPath);
  try {
    appendEntry(db, {
      projectId: "p1",
      category: "decision",
      author: "ledger",
      body: "decided",
      topicKey: "t",
      createdAt: NOW,
    });
    appendEntry(db, {
      projectId: "p1",
      category: "summary",
      author: "ledger",
      body: "left off",
      createdAt: NOW,
    });
    appendEntry(db, {
      projectId: "p1",
      category: "scratch",
      author: "ledger",
      body: "[digest-catastrophe] session=chat-x: boom",
      createdAt: NOW,
    });
    db.prepare(
      "INSERT INTO digest_watermark (project_id, session_id, message_id, created_at) VALUES (?,?,?,?)",
    ).run("p1", "chat-x", "m1", NOW);
  } finally {
    closeDb(db);
  }
  const rows = readDigestRows(dbPath);
  expect({
    decisions: rows.decisions,
    summaries: rows.summaries,
    scratch: rows.scratch,
    watermarks: rows.watermarks,
  }).toEqual({
    decisions: 1,
    summaries: 1,
    scratch: ["[digest-catastrophe] session=chat-x: boom"],
    watermarks: [{ session: "chat-x", n: 1 }],
  });
});

it("a RELATIVE dbPath is resolved against the workspace, not against this process", async () => {
  // The child runs with cwd=os.tmpdir() and resolves a relative dbPath against the repoRoot ARG, so a
  // watcher that resolved it against the test process would silently watch a different file and time out
  // with "db absent" while the digest was landing correctly. That is exactly what happened once.
  const { root } = workspace();
  mkdirSync(join(root, ".zer0"), { recursive: true });
  const db = seedDb(root, join(root, ".zer0", "evidence.db"));
  try {
    appendEntry(db, {
      projectId: "p1",
      category: "decision",
      author: "ledger",
      body: "landed in the workspace db",
      topicKey: "t",
      createdAt: NOW,
    });
  } finally {
    closeDb(db);
  }
  const relative = join(".zer0", "evidence.db");
  expect(readDigestEvidence(root, relative).rows).toMatchObject({ decisions: 1, error: undefined });
  const result = await awaitDigestEvidence({
    repoRoot: root,
    dbPath: relative,
    budgetMs: 2_000,
    expected: (rows) => rows.decisions > 0,
  });
  expect({ ok: result.ok, terminal: result.terminal }).toEqual({ ok: true, terminal: "expected" });
});

it("pidAlive tells a running process from a reaped one", async () => {
  expect(pidAlive(process.pid)).toBe(true);
  expect(pidAlive(await deadPid())).toBe(false);
});

it("the evidence names the failure log, the close log, and every lease with its holder's liveness", async () => {
  const { root, dbPath } = workspace();
  const gone = await deadPid();
  mkdirSync(join(root, ".zer0", "journal"), { recursive: true });
  mkdirSync(join(root, ".zer0", "leases"), { recursive: true });
  writeFileSync(
    join(root, ".zer0", "journal", "digest-failures.log"),
    `${NOW} session=chat-x [digest-catastrophe] disk full\n`,
    "utf8",
  );
  writeFileSync(
    join(root, ".zer0", "journal", "room-close.log"),
    `${NOW} session=chat-x reason=stdin-eof digest=requested drain=ok\n`,
    "utf8",
  );
  writeFileSync(
    join(root, ".zer0", "leases", "digest-chat-x.lock"),
    JSON.stringify({ pid: gone, expiresAt: Date.now() + 60_000 }),
    "utf8",
  );

  const evidence = readDigestEvidence(root, dbPath, [gone, process.pid]);
  expect(evidence.failureLog).toContain("[digest-catastrophe] disk full");
  expect(evidence.closeLog).toEqual([
    `${NOW} session=chat-x reason=stdin-eof digest=requested drain=ok`,
  ]);
  expect(evidence.leases).toEqual([
    { file: "digest-chat-x.lock", pid: gone, alive: false, raw: expect.any(String) },
  ]);
  expect(evidence.spawned).toEqual([
    { pid: gone, alive: false },
    { pid: process.pid, alive: true },
  ]);

  const report = formatDigestEvidence(evidence, ["+120ms decisions=0"], 45_000);
  expect(report).toContain(`WORKSPACE RETAINED FOR DIAGNOSIS: ${root}`);
  expect(report).toContain("disk full");
  expect(report).toContain("digest-chat-x.lock");
  expect(report).toContain("+120ms decisions=0");
  expect(report).toContain("45000ms budget");
});

it("the wait stops on a DURABLE FAILURE RECORD instead of burning its whole budget", async () => {
  const { root, dbPath } = workspace();
  const db = seedDb(root, dbPath);
  try {
    appendEntry(db, {
      projectId: "p1",
      category: "scratch",
      author: "ledger",
      body: "[digest-catastrophe] session=chat-x: digest entry is missing",
      createdAt: NOW,
    });
  } finally {
    closeDb(db);
  }
  const started = Date.now();
  const result = await awaitDigestEvidence({
    repoRoot: root,
    dbPath,
    budgetMs: 30_000,
    expected: (rows) => rows.decisions > 0,
  });
  expect({ ok: result.ok, terminal: result.terminal }).toEqual({
    ok: false,
    terminal: "failure-record",
  });
  expect(Date.now() - started).toBeLessThan(5_000); // it did not wait out the 30s budget
  expect(result.report).toContain("digest entry is missing");
  expect(result.report).toContain(root);
});

it("expected rows do NOT excuse a recorded catastrophe for the same session (codex #19)", async () => {
  const { root, dbPath } = workspace();
  const db = seedDb(root, dbPath);
  try {
    // Both are true at once, which is the whole point: a boot catch-up child can land its digest while the
    // close child dies. Answering "the rows are there, pass" is how the death stays invisible.
    appendEntry(db, {
      projectId: "p1",
      category: "decision",
      author: "ledger",
      body: "landed",
      topicKey: "t",
      createdAt: NOW,
    });
    appendEntry(db, {
      projectId: "p1",
      category: "scratch",
      author: "ledger",
      body: "[digest-catastrophe] session=chat-x: digest child exited 1 before recording anything",
      createdAt: NOW,
    });
  } finally {
    closeDb(db);
  }
  const scoped = await awaitDigestEvidence({
    repoRoot: root,
    dbPath,
    budgetMs: 30_000,
    sessionId: "chat-x",
    expected: (rows) => rows.decisions > 0,
  });
  expect({ ok: scoped.ok, terminal: scoped.terminal }).toEqual({
    ok: false,
    terminal: "failure-record",
  });
  expect(scoped.report).toContain("digest child exited 1 before recording anything");
  expect(scoped.report).toContain("durable failure(s) for this wait");

  // A catastrophe for a DIFFERENT session is not this wait's business.
  const other = await awaitDigestEvidence({
    repoRoot: root,
    dbPath,
    budgetMs: 30_000,
    sessionId: "chat-elsewhere",
    expected: (rows) => rows.decisions > 0,
  });
  expect({ ok: other.ok, terminal: other.terminal }).toEqual({ ok: true, terminal: "expected" });
});

it("a failure-log line for the session is terminal too, even with the expected rows present", async () => {
  const { root, dbPath } = workspace();
  const db = seedDb(root, dbPath);
  try {
    appendEntry(db, {
      projectId: "p1",
      category: "decision",
      author: "ledger",
      body: "landed",
      topicKey: "t",
      createdAt: NOW,
    });
  } finally {
    closeDb(db);
  }
  mkdirSync(join(root, ".zer0", "journal"), { recursive: true });
  writeFileSync(
    join(root, ".zer0", "journal", "digest-failures.log"),
    `${NOW} session=chat-y [digest-catastrophe] digest entry is missing\n`,
    "utf8",
  );
  const result = await awaitDigestEvidence({
    repoRoot: root,
    dbPath,
    budgetMs: 30_000,
    sessionId: "chat-y",
    expected: (rows) => rows.decisions > 0,
  });
  expect({ ok: result.ok, terminal: result.terminal }).toEqual({
    ok: false,
    terminal: "failure-record",
  });
  expect(result.report).toContain("digest entry is missing");
});

it("the wait returns as soon as the expected rows land, and reports nothing on success", async () => {
  const { root, dbPath } = workspace();
  const db = seedDb(root, dbPath);
  try {
    appendEntry(db, {
      projectId: "p1",
      category: "decision",
      author: "ledger",
      body: "landed",
      topicKey: "t",
      createdAt: NOW,
    });
  } finally {
    closeDb(db);
  }
  const result = await awaitDigestEvidence({
    repoRoot: root,
    dbPath,
    budgetMs: 30_000,
    expected: (rows) => rows.decisions > 0,
  });
  expect({ ok: result.ok, terminal: result.terminal, report: result.report }).toEqual({
    ok: true,
    terminal: "expected",
    report: "",
  });
});

it("a timeout with nothing on disk still names the workspace and says nothing ever changed", async () => {
  const { root, dbPath } = workspace();
  const result = await awaitDigestEvidence({
    repoRoot: root,
    dbPath,
    budgetMs: 300,
    expected: (rows) => rows.decisions > 0,
    spawnedPids: [await deadPid()],
  });
  expect({ ok: result.ok, terminal: result.terminal }).toEqual({ ok: false, terminal: "timeout" });
  expect(result.report).toContain(`WORKSPACE RETAINED FOR DIAGNOSIS: ${root}`);
  expect(result.report).toContain("db absent");
  expect(result.report).toContain("leases: none");
  expect(result.report).toContain('"alive":false');
});
