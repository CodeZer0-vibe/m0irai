/**
 * @file src/memory/lane-attempts.test.ts
 * @purpose Direct-surface tests for the lane_prompt_attempts module (the I-1 intent ledger): row decode,
 *   pair-guarded accept resolution (each mismatch dimension refused independently), prior-generation
 *   abandon scoping, recovery-read ordering, and the prune floor (keep 0 still spares unresolved rows).
 *   Interleaved lifecycle scenarios live in lane-state.test.ts (the facade); this file proves each
 *   primitive in isolation against REAL sqlite.
 * @exports (none — test file)
 * @depends vitest, node:fs, node:os, node:path, ./lane-attempts, ../evidence/db
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { type Db, closeDb, openLaneStateDb } from "../evidence/db.js";
import {
  abandonPriorGenerationAttempts,
  getPromptAttempt,
  listUnresolvedAttempts,
  pruneResolvedAttempts,
  recordPromptAttempt,
  resolveAttemptAccepted,
} from "./lane-attempts.js";

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
  tempRoot = mkdtempSync(path.join(tmpdir(), "lane-attempts-"));
  const db = openLaneStateDb(path.join(tempRoot, "evidence.db"));
  handles.push(db);
  db.prepare(
    "INSERT INTO projects(project_id, canonical_root, git_common_dir, created_at) VALUES (?,?,?,?)",
  ).run("p1", "C:/tmp/p", "C:/tmp/p/.git", "2026-07-10T00:00:00Z");
  return db;
}

function attempt(id: string, over: Partial<Parameters<typeof recordPromptAttempt>[1]> = {}) {
  return {
    attemptId: id,
    projectId: "p1",
    agent: "claude",
    generation: 1,
    sessionId: "s1",
    seqFrom: 1,
    seqTo: 3,
    sentAt: "2026-07-10T00:00:01Z",
    ...over,
  };
}

it("record + get round-trips the decoded row with resolved null (in flight)", () => {
  const db = openSeeded();
  recordPromptAttempt(db, attempt("a1"));
  expect(getPromptAttempt(db, "a1")).toEqual({
    attemptId: "a1",
    projectId: "p1",
    agent: "claude",
    generation: 1,
    sessionId: "s1",
    seqFrom: 1,
    seqTo: 3,
    sentAt: "2026-07-10T00:00:01Z",
    resolved: null,
    // FL-150: an ordinary attempt was never delivered through a cancel, and says so. This assertion is
    // exact (toEqual, not toMatchObject) on purpose — it is what caught the new column arriving.
    abortedAt: null,
  });
  expect(getPromptAttempt(db, "missing")).toBeUndefined();
});

it("resolveAttemptAccepted flips ONLY the matching unresolved pair — each mismatch dimension refuses", () => {
  const db = openSeeded();
  recordPromptAttempt(db, attempt("a1"));
  expect(resolveAttemptAccepted(db, wrong({ generation: 2 }))).toBe(false);
  expect(resolveAttemptAccepted(db, wrong({ sessionId: "s2" }))).toBe(false);
  expect(resolveAttemptAccepted(db, wrong({ attemptId: "ghost" }))).toBe(false);
  expect(getPromptAttempt(db, "a1")?.resolved).toBeNull(); // refusals wrote nothing
  expect(resolveAttemptAccepted(db, wrong({}))).toBe(true);
  expect(getPromptAttempt(db, "a1")?.resolved).toBe("accepted");
  expect(resolveAttemptAccepted(db, wrong({}))).toBe(false); // already resolved — never a double accept

  function wrong(over: Partial<Parameters<typeof resolveAttemptAccepted>[1]>) {
    return {
      attemptId: "a1",
      projectId: "p1",
      agent: "claude",
      generation: 1,
      sessionId: "s1",
      ...over,
    };
  }
});

it("abandonPriorGenerationAttempts abandons unresolved gen<N of THAT lane only and reports the count", () => {
  const db = openSeeded();
  recordPromptAttempt(db, attempt("g1-open"));
  recordPromptAttempt(db, attempt("g1-done", { sentAt: "2026-07-10T00:00:02Z" }));
  resolveAttemptAccepted(db, {
    attemptId: "g1-done",
    projectId: "p1",
    agent: "claude",
    generation: 1,
    sessionId: "s1",
  });
  recordPromptAttempt(db, attempt("codex-open", { agent: "codex", sessionId: "sx" }));
  expect(abandonPriorGenerationAttempts(db, "p1", "claude", 2)).toBe(1);
  expect(getPromptAttempt(db, "g1-open")?.resolved).toBe("abandoned");
  expect(getPromptAttempt(db, "g1-done")?.resolved).toBe("accepted");
  expect(getPromptAttempt(db, "codex-open")?.resolved).toBeNull();
});

it("listUnresolvedAttempts returns newest-first by sent_at", () => {
  const db = openSeeded();
  recordPromptAttempt(db, attempt("old", { sentAt: "2026-07-10T00:00:01Z" }));
  recordPromptAttempt(db, attempt("new", { seqFrom: 4, seqTo: 5, sentAt: "2026-07-10T00:00:09Z" }));
  const ids = listUnresolvedAttempts(db, {
    projectId: "p1",
    agent: "claude",
    generation: 1,
    sessionId: "s1",
  }).map((r) => r.attemptId);
  expect(ids).toEqual(["new", "old"]);
});

it("prune with keepNewest 0 deletes every RESOLVED row and still spares every unresolved row", () => {
  const db = openSeeded();
  recordPromptAttempt(db, attempt("open"));
  recordPromptAttempt(db, attempt("done", { sentAt: "2026-07-10T00:00:02Z" }));
  resolveAttemptAccepted(db, {
    attemptId: "done",
    projectId: "p1",
    agent: "claude",
    generation: 1,
    sessionId: "s1",
  });
  expect(pruneResolvedAttempts(db, "p1", "claude", 0)).toBe(1);
  expect(getPromptAttempt(db, "done")).toBeUndefined();
  expect(getPromptAttempt(db, "open")?.resolved).toBeNull();
});
