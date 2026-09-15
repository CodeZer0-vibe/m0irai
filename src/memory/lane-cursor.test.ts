/**
 * @file src/memory/lane-cursor.test.ts
 * @purpose Direct-surface tests for the lane_cursors module (the I-1 acceptance record): the generation-0
 *   sentinel (an arm never fabricates an accepted position), re-arm preservation of an accepted cursor,
 *   and commitAcceptedCursor's carry CASE in both directions plus its fresh-row INSERT branch. The
 *   transaction-level orchestration lives in lane-state.test.ts; this file proves the SQL primitives
 *   against REAL sqlite.
 * @exports (none — test file)
 * @depends vitest, node:fs, node:os, node:path, ./lane-cursor, ../evidence/db
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { type Db, closeDb, openLaneStateDb } from "../evidence/db.js";
import { commitAcceptedCursor, getLaneCursor, setBriefingCarry } from "./lane-cursor.js";

let tempRoot: string | undefined;
const handles: Db[] = [];

afterEach(() => {
  for (const db of handles.splice(0)) {
    closeDb(db);
  }
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    tempRoot = undefined;
  }
});

function openSeeded(): Db {
  tempRoot = mkdtempSync(path.join(tmpdir(), "lane-cursor-"));
  const db = openLaneStateDb(path.join(tempRoot, "evidence.db"));
  handles.push(db);
  db.prepare(
    "INSERT INTO projects(project_id, canonical_root, git_common_dir, created_at) VALUES (?,?,?,?)",
  ).run("p1", "C:/tmp/p", "C:/tmp/p/.git", "2026-07-10T00:00:00Z");
  return db;
}

function commit(db: Db, over: Partial<Parameters<typeof commitAcceptedCursor>[1]> = {}): void {
  commitAcceptedCursor(db, {
    projectId: "p1",
    agent: "claude",
    generation: 1,
    lastSeq: 5,
    clearBriefingCarry: false,
    now: "2026-07-10T00:00:01Z",
    ...over,
  });
}

it("getLaneCursor is undefined before any write; setBriefingCarry creates the generation-0 sentinel", () => {
  const db = openSeeded();
  expect(getLaneCursor(db, "p1", "claude")).toBeUndefined();
  setBriefingCarry(db, "p1", "claude", "2026-07-10T00:00:01Z");
  expect(getLaneCursor(db, "p1", "claude")).toEqual({
    projectId: "p1",
    agent: "claude",
    generation: 0,
    lastSeq: 0,
    needsBriefingCarry: true,
    updatedAt: "2026-07-10T00:00:01Z",
  });
});

it("re-arming an ACCEPTED cursor preserves its generation/lastSeq and only flips the carry + stamp", () => {
  const db = openSeeded();
  commit(db, { clearBriefingCarry: true });
  expect(getLaneCursor(db, "p1", "claude")).toMatchObject({
    generation: 1,
    lastSeq: 5,
    needsBriefingCarry: false,
  });
  setBriefingCarry(db, "p1", "claude", "2026-07-10T00:00:02Z");
  expect(getLaneCursor(db, "p1", "claude")).toEqual({
    projectId: "p1",
    agent: "claude",
    generation: 1,
    lastSeq: 5,
    needsBriefingCarry: true,
    updatedAt: "2026-07-10T00:00:02Z",
  });
});

it("commitAcceptedCursor clears the carry ONLY when told; an uncarried accept leaves the arm standing", () => {
  const db = openSeeded();
  setBriefingCarry(db, "p1", "claude", "2026-07-10T00:00:01Z");
  commit(db, { clearBriefingCarry: false, lastSeq: 3 });
  expect(getLaneCursor(db, "p1", "claude")).toMatchObject({
    generation: 1,
    lastSeq: 3,
    needsBriefingCarry: true, // the prompt did not carry the briefing — the arm survives the accept
  });
  commit(db, { clearBriefingCarry: true, lastSeq: 6, now: "2026-07-10T00:00:03Z" });
  expect(getLaneCursor(db, "p1", "claude")).toMatchObject({
    lastSeq: 6,
    needsBriefingCarry: false,
    updatedAt: "2026-07-10T00:00:03Z",
  });
});

it("the fresh-row INSERT branch writes carry 0 (nothing ever armed a brand-new cursor)", () => {
  const db = openSeeded();
  commit(db); // no sentinel exists — in-contract unreachable via the facade, still sound standalone
  expect(getLaneCursor(db, "p1", "claude")).toEqual({
    projectId: "p1",
    agent: "claude",
    generation: 1,
    lastSeq: 5,
    needsBriefingCarry: false,
    updatedAt: "2026-07-10T00:00:01Z",
  });
});
