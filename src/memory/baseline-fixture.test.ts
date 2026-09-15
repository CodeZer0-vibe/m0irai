// AC5 byte-identity golden: the memory-OFF path (global openDb + the scripted turn) must reproduce the
// pinned pre-unit @0e4ded7 baseline DB bytes — proving the memory unit changes NOTHING when off. This is
// fresh-build parity (NOT reopen-idempotence: the existing v1->v14 chain re-churns _schema_version on every
// open, so no reopen is byte-stable). Lives in the memory layer because it imports baseline-fixture (evidence
// tests may not import memory). Also guards the fixture builder's determinism + idempotency. Real sqlite.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { closeDb, openDb } from "../evidence/db.js";
import { insertScriptedTurn } from "./baseline-fixture.js";

const PINNED_HASH_URL = new URL("./__fixtures__/baseline/evidence.db.sha256", import.meta.url);

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "zer0-baseline-"));
}

function pinnedBaselineHash(): string {
  return readFileSync(PINNED_HASH_URL, "utf8").trim().split(/\s+/)[0] as string;
}

// Mirrors the baseline capture method the fixtures were generated with (fresh v14 open + scripted turn +
// WAL-fold); the one-shot capture script left with the V1 scripts sweep (3.8) — the pinned fixtures ARE the record.
function buildAndHash(dir: string): string {
  const dbPath = join(dir, "evidence.db");
  const db = openDb(dbPath);
  insertScriptedTurn(db);
  db.pragma("wal_checkpoint(TRUNCATE)");
  closeDb(db);
  return createHash("sha256").update(readFileSync(dbPath)).digest("hex");
}

it("AC5: a fresh memory-OFF scripted turn reproduces the pinned baseline DB hash (fresh-build parity)", () => {
  const dir = freshDir();
  try {
    expect(buildAndHash(dir)).toBe(pinnedBaselineHash());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("the scripted-turn builder is deterministic across two independent fresh builds", () => {
  const a = freshDir();
  const b = freshDir();
  try {
    expect(buildAndHash(a)).toBe(buildAndHash(b));
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

it("insertScriptedTurn is idempotent: a re-run over the same DB keeps exactly one scripted turn", () => {
  const dir = freshDir();
  const db = openDb(join(dir, "evidence.db"));
  try {
    insertScriptedTurn(db);
    insertScriptedTurn(db);
    const messages = db.prepare("SELECT COUNT(*) AS c FROM chat_messages").get() as { c: number };
    const dispatches = db.prepare("SELECT COUNT(*) AS c FROM dispatches").get() as { c: number };
    expect(messages.c).toBe(3);
    expect(dispatches.c).toBe(2);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});
