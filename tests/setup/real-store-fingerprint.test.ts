// W4-R3a C1/RA-4: falsifiers for the real-store guard's own detector. A guard that silently stops
// detecting is worse than no guard — it converts "we verified nothing was written" into a lie that
// nobody can see. These assert the two properties the guard depends on: it CHANGES on a write, and it
// is LOGICAL (a WAL checkpoint / page churn with no logical change must NOT move it, or the whole
// suite flakes RED on a store nothing touched).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { describeFingerprintDrift, fingerprintRealStore } from "./real-store-fingerprint.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function makeStore(): { readonly root: string; readonly dbPath: string } {
  const root = mkdtempSync(path.join(tmpdir(), "zer0-fingerprint-"));
  roots.push(root);
  mkdirSync(path.join(root, ".zer0", "blobs"), { recursive: true });
  mkdirSync(path.join(root, ".council", "runs"), { recursive: true });
  const dbPath = path.join(root, ".zer0", "evidence.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
  db.prepare("INSERT INTO t VALUES (?, ?)").run("a", "first");
  db.close();
  return { root, dbPath: ".zer0/evidence.db" };
}

it("an inserted row MOVES the db fingerprint, and deleting that row restores it EXACTLY (logical, not byte)", () => {
  const { root, dbPath } = makeStore();
  const before = fingerprintRealStore(root, dbPath);

  const db = new Database(path.join(root, dbPath));
  db.prepare("INSERT INTO t VALUES (?, ?)").run("escape", "a stray test write");
  db.close();
  const written = fingerprintRealStore(root, dbPath);
  expect(written.db).not.toBe(before.db);
  expect(describeFingerprintDrift(before, written)).toHaveLength(1);

  // The property a BYTE hash of the .db could never satisfy: SQLite will not hand back the freed page
  // in the same layout, yet the LOGICAL content is identical again — so the guard reports "untouched"
  // exactly when the store's contents are untouched, and does not flake on page churn.
  const undo = new Database(path.join(root, dbPath));
  undo.prepare("DELETE FROM t WHERE id = ?").run("escape");
  undo.close();
  expect(fingerprintRealStore(root, dbPath).db).toBe(before.db);
  expect(describeFingerprintDrift(before, fingerprintRealStore(root, dbPath))).toEqual([]);
});

it("a WAL checkpoint alone does NOT move the fingerprint (the flake the byte hash would have caused)", () => {
  const { root, dbPath } = makeStore();
  const write = new Database(path.join(root, dbPath));
  write.prepare("INSERT INTO t VALUES (?, ?)").run("b", "second");
  const before = fingerprintRealStore(root, dbPath);
  // Moves committed bytes out of the -wal and back into the main file — no logical change whatsoever.
  write.pragma("wal_checkpoint(TRUNCATE)");
  write.close();
  expect(fingerprintRealStore(root, dbPath).db).toBe(before.db);
});

it("a new blob file and a new .council/runs file each move their OWN surface, named separately", () => {
  const { root, dbPath } = makeStore();
  const before = fingerprintRealStore(root, dbPath);

  writeFileSync(path.join(root, ".zer0", "blobs", "deadbeef"), "stray blob");
  const blobDrift = describeFingerprintDrift(before, fingerprintRealStore(root, dbPath));
  expect(blobDrift).toHaveLength(1);
  expect(blobDrift[0]).toMatch(/^blobs: /);

  mkdirSync(path.join(root, ".council", "runs", "chat-stray"), { recursive: true });
  writeFileSync(path.join(root, ".council", "runs", "chat-stray", "transcript.json"), "{}");
  const both = describeFingerprintDrift(before, fingerprintRealStore(root, dbPath));
  expect(both).toHaveLength(2);
  expect(both[1]).toMatch(/^councilRuns: /);
});

it("a checkout with no store at all fingerprints as absent, never as unreadable or a throw", () => {
  const root = mkdtempSync(path.join(tmpdir(), "zer0-fingerprint-empty-"));
  roots.push(root);
  const fingerprint = fingerprintRealStore(root, ".zer0/evidence.db");
  expect(fingerprint).toEqual({ db: "absent", blobs: "absent", councilRuns: "absent" });
});
