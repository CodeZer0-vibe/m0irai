/**
 * @file src/memory/lane-state.test.ts
 * @purpose T1 contract for the LaneStateStore (MT7 I-1/I-2/I-7/I-8/F-14) against REAL sqlite via
 *   openLaneStateDb — no mocks. Encodes: generation bump ATOMICALLY abandons prior-generation unresolved
 *   attempts (same transaction as the session write; mid-transaction state invisible to a second
 *   connection); the bump PRESERVES the old cursor (r2-NB1: a fresh generation never owns a cursor it
 *   hasn't seen) while durably arming the briefing carry; advance-on-accept resolves ONLY the attempt
 *   matching the active (generation, session_id) and REFUSES stale generations / session mismatches /
 *   missing attempts distinctly; the F-14 cursor-commit retry ladder is pinned at 3x 150/300/600ms with a
 *   distinct commitFailed outcome against a held write lock; resolved-attempt pruning NEVER touches
 *   unresolved rows (they are recovery evidence); the I-2 binding tuple matches per-field.
 * @exports (none — test file)
 * @depends vitest, better-sqlite3, node:fs, node:os, node:path, ./lane-state, ../evidence/db
 */
// @size-justified: one store contract, 16 behavioral cases (I-1/I-2/I-7/I-8/F-14) — splitting scatters the
// generation-lifecycle interleavings this file exists to prove together.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { type Db, closeDb, openLaneStateDb } from "../evidence/db.js";
import {
  CURSOR_COMMIT_RETRY,
  RESOLVED_ATTEMPTS_KEEP,
  advanceCursorOnAccept,
  bumpGeneration,
  getLaneCursor,
  getLaneSession,
  getPromptAttempt,
  laneBindingMatches,
  listUnresolvedAttempts,
  pruneResolvedAttempts,
  recordPromptAttempt,
  setBriefingCarry,
  touchResumed,
} from "./lane-state.js";

let tempRoot: string | undefined;
const handles: Db[] = [];

function tempDbPath(): string {
  tempRoot = mkdtempSync(path.join(tmpdir(), "lane-state-"));
  return path.join(tempRoot, "evidence.db");
}

function track(db: Db): Db {
  handles.push(db);
  return db;
}

afterEach(() => {
  for (const db of handles.splice(0)) {
    closeDb(db);
  }
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    tempRoot = undefined;
  }
});

const T0 = "2026-07-10T00:00:00Z";
const T1 = "2026-07-10T00:00:01Z";
const T2 = "2026-07-10T00:00:02Z";

function openSeeded(projectId = "p1"): { db: Db; dbPath: string } {
  const dbPath = tempDbPath();
  const db = track(openLaneStateDb(dbPath));
  db.prepare(
    "INSERT INTO projects(project_id, canonical_root, git_common_dir, created_at) VALUES (?,?,?,?)",
  ).run(projectId, "C:/tmp/p", "C:/tmp/p/.git", T0);
  return { db, dbPath };
}

function bumpInput(overrides: Partial<Parameters<typeof bumpGeneration>[1]> = {}) {
  return {
    projectId: "p1",
    agent: "claude",
    sessionId: "s1",
    cwd: "C:/tmp/p",
    adapterPkg: "claude-agent-acp",
    adapterVersion: "0.58.1",
    now: T0,
    ...overrides,
  };
}

function attemptInput(overrides: Partial<Parameters<typeof recordPromptAttempt>[1]> = {}) {
  return {
    attemptId: "a1",
    projectId: "p1",
    agent: "claude",
    generation: 1,
    sessionId: "s1",
    seqFrom: 1,
    seqTo: 3,
    sentAt: T0,
    ...overrides,
  };
}

function advanceInput(overrides: Partial<Parameters<typeof advanceCursorOnAccept>[1]> = {}) {
  return {
    projectId: "p1",
    agent: "claude",
    attemptId: "a1",
    generation: 1,
    sessionId: "s1",
    lastSeq: 3,
    clearBriefingCarry: false,
    now: T1,
    ...overrides,
  };
}

it("first bump creates generation 1 with the binding tuple and a sentinel cursor with the carry armed", () => {
  const { db } = openSeeded();
  const result = bumpGeneration(db, bumpInput());
  expect(result).toEqual({ generation: 1, abandonedAttempts: 0 });
  const session = getLaneSession(db, "p1", "claude");
  expect(session).toEqual({
    projectId: "p1",
    agent: "claude",
    sessionId: "s1",
    generation: 1,
    cwd: "C:/tmp/p",
    adapterPkg: "claude-agent-acp",
    adapterVersion: "0.58.1",
    createdAt: T0,
    lastResumedAt: null,
  });
  // The sentinel cursor: generation 0 = "no accept yet" — the bump NEVER claims a cursor for the new
  // generation (r2-NB1); the carry is armed durably in the same transaction (I-7 catch-up briefing).
  expect(getLaneCursor(db, "p1", "claude")).toEqual({
    projectId: "p1",
    agent: "claude",
    generation: 0,
    lastSeq: 0,
    needsBriefingCarry: true,
    updatedAt: T0,
  });
});

it("isolates native sessions, attempts, and cursors between V2 room scopes", async () => {
  const { db } = openSeeded();
  for (const [scope, sessionId, attemptId, lastSeq] of [
    ["chat-a", "native-a", "attempt-a", 4],
    ["chat-b", "native-b", "attempt-b", 9],
  ] as const) {
    expect(bumpGeneration(db, bumpInput({ laneScopeId: scope, sessionId }))).toMatchObject({
      generation: 1,
    });
    recordPromptAttempt(
      db,
      attemptInput({ laneScopeId: scope, sessionId, attemptId, seqTo: lastSeq }),
    );
    await expect(
      advanceCursorOnAccept(
        db,
        advanceInput({ laneScopeId: scope, sessionId, attemptId, lastSeq }),
      ),
    ).resolves.toEqual({ outcome: "advanced" });
  }

  expect(getLaneSession(db, "p1", "claude", "chat-a")?.sessionId).toBe("native-a");
  expect(getLaneSession(db, "p1", "claude", "chat-b")?.sessionId).toBe("native-b");
  expect(getLaneCursor(db, "p1", "claude", "chat-a")?.lastSeq).toBe(4);
  expect(getLaneCursor(db, "p1", "claude", "chat-b")?.lastSeq).toBe(9);
  expect(getLaneSession(db, "p1", "claude")).toBeUndefined();
});

it("a bump supersedes the row (one row per PK), increments the generation, and abandons ONLY the prior unresolved attempts of that lane", () => {
  const { db } = openSeeded();
  bumpGeneration(db, bumpInput());
  recordPromptAttempt(db, attemptInput({ attemptId: "a-open" }));
  recordPromptAttempt(db, attemptInput({ attemptId: "a-done", seqFrom: 4, seqTo: 5, sentAt: T1 }));
  // resolve a-done as accepted first so the bump must leave it untouched
  db.prepare("UPDATE lane_prompt_attempts SET resolved='accepted' WHERE attempt_id='a-done'").run();
  // an unresolved attempt on ANOTHER lane must survive the bump untouched
  recordPromptAttempt(db, attemptInput({ attemptId: "a-codex", agent: "codex", sessionId: "sx" }));

  const result = bumpGeneration(
    db,
    bumpInput({ sessionId: "s2", adapterVersion: "0.59.0", now: T2 }),
  );
  expect(result).toEqual({ generation: 2, abandonedAttempts: 1 });
  const rows = db
    .prepare("SELECT COUNT(*) AS n FROM lane_sessions WHERE project_id='p1' AND agent='claude'")
    .get() as { n: number };
  expect(rows.n).toBe(1);
  expect(getLaneSession(db, "p1", "claude")?.sessionId).toBe("s2");
  expect(getPromptAttempt(db, "a-open")?.resolved).toBe("abandoned");
  expect(getPromptAttempt(db, "a-done")?.resolved).toBe("accepted");
  expect(getPromptAttempt(db, "a-codex")?.resolved).toBeNull();
});

it("bump is ATOMIC: a failure between the abandon and the session write rolls BOTH back, and the abandon is invisible to a second connection mid-transaction", () => {
  const { db, dbPath } = openSeeded();
  bumpGeneration(db, bumpInput());
  recordPromptAttempt(db, attemptInput({ attemptId: "a-open" }));
  const peer = track(new Database(dbPath));
  let midTransactionResolved: unknown = "unread";
  expect(() =>
    bumpGeneration(db, bumpInput({ sessionId: "s2", now: T2 }), {
      beforeSessionWrite: () => {
        // WAL isolation: the uncommitted abandon must be invisible outside the transaction (I-1's
        // "no intermediate state is observable").
        midTransactionResolved = (
          peer
            .prepare("SELECT resolved FROM lane_prompt_attempts WHERE attempt_id='a-open'")
            .get() as {
            resolved: string | null;
          }
        ).resolved;
        throw new Error("forced mid-transaction failure");
      },
    }),
  ).toThrow("forced mid-transaction failure");
  expect(midTransactionResolved).toBeNull();
  expect(getPromptAttempt(db, "a-open")?.resolved).toBeNull(); // rolled back with the session write
  expect(getLaneSession(db, "p1", "claude")?.generation).toBe(1);
  expect(getLaneSession(db, "p1", "claude")?.sessionId).toBe("s1");
});

it("a bump PRESERVES the accepted cursor position (generation + lastSeq) and only arms the carry", async () => {
  const { db } = openSeeded();
  bumpGeneration(db, bumpInput());
  recordPromptAttempt(db, attemptInput({ seqFrom: 1, seqTo: 7 }));
  const advanced = await advanceCursorOnAccept(
    db,
    advanceInput({ lastSeq: 7, clearBriefingCarry: true }),
  );
  expect(advanced).toEqual({ outcome: "advanced" });
  bumpGeneration(db, bumpInput({ sessionId: "s2", now: T2 }));
  // The cursor still describes what generation 1 ACCEPTED — generation 2 rebases only via its own
  // accepted catch-up (I-7). Losing lastSeq here would silently drop the catch-up window.
  expect(getLaneCursor(db, "p1", "claude")).toEqual({
    projectId: "p1",
    agent: "claude",
    generation: 1,
    lastSeq: 7,
    needsBriefingCarry: true,
    updatedAt: T2,
  });
});

it("advance-on-accept commits the cursor for the active pair, resolves the attempt accepted, and clears the carry only when told", async () => {
  const { db } = openSeeded();
  bumpGeneration(db, bumpInput());
  recordPromptAttempt(db, attemptInput());
  const kept = await advanceCursorOnAccept(db, advanceInput({ clearBriefingCarry: false }));
  expect(kept).toEqual({ outcome: "advanced" });
  expect(getLaneCursor(db, "p1", "claude")).toMatchObject({
    generation: 1,
    lastSeq: 3,
    needsBriefingCarry: true, // armed by the bump; this prompt did not carry the briefing
    updatedAt: T1,
  });
  expect(getPromptAttempt(db, "a1")?.resolved).toBe("accepted");

  recordPromptAttempt(db, attemptInput({ attemptId: "a2", seqFrom: 4, seqTo: 6, sentAt: T1 }));
  const cleared = await advanceCursorOnAccept(
    db,
    advanceInput({ attemptId: "a2", lastSeq: 6, clearBriefingCarry: true, now: T2 }),
  );
  expect(cleared).toEqual({ outcome: "advanced" });
  expect(getLaneCursor(db, "p1", "claude")).toMatchObject({
    lastSeq: 6,
    needsBriefingCarry: false,
  });
});

it("REFUSES a stale-generation advance and never flips an abandoned attempt to accepted", async () => {
  const { db } = openSeeded();
  bumpGeneration(db, bumpInput());
  recordPromptAttempt(db, attemptInput({ attemptId: "a-old" }));
  bumpGeneration(db, bumpInput({ sessionId: "s2", now: T1 })); // abandons a-old, active generation 2
  const result = await advanceCursorOnAccept(db, advanceInput({ attemptId: "a-old" }));
  expect(result).toEqual({
    outcome: "refused",
    reason: "staleGeneration",
    activeGeneration: 2,
  });
  expect(getPromptAttempt(db, "a-old")?.resolved).toBe("abandoned");
  expect(getLaneCursor(db, "p1", "claude")?.lastSeq).toBe(0);
});

it("REFUSES a session-id mismatch at the active generation (I-1: the pair must match)", async () => {
  const { db } = openSeeded();
  bumpGeneration(db, bumpInput());
  recordPromptAttempt(db, attemptInput({ attemptId: "a-zombie", sessionId: "s-zombie" }));
  const result = await advanceCursorOnAccept(
    db,
    advanceInput({ attemptId: "a-zombie", sessionId: "s-zombie" }),
  );
  expect(result).toEqual({ outcome: "refused", reason: "sessionMismatch", activeGeneration: 1 });
  expect(getPromptAttempt(db, "a-zombie")?.resolved).toBeNull();
});

it("REFUSES an unknown or already-resolved attempt (no double accept), and a lane with no session at all", async () => {
  const { db } = openSeeded();
  bumpGeneration(db, bumpInput());
  const unknown = await advanceCursorOnAccept(db, advanceInput({ attemptId: "a-ghost" }));
  expect(unknown).toEqual({ outcome: "refused", reason: "attemptMissing", activeGeneration: 1 });

  recordPromptAttempt(db, attemptInput());
  expect(await advanceCursorOnAccept(db, advanceInput())).toEqual({ outcome: "advanced" });
  const again = await advanceCursorOnAccept(db, advanceInput({ lastSeq: 9, now: T2 }));
  expect(again).toEqual({ outcome: "refused", reason: "attemptMissing", activeGeneration: 1 });
  expect(getLaneCursor(db, "p1", "claude")?.lastSeq).toBe(3); // the refusal wrote nothing

  const noSession = await advanceCursorOnAccept(db, advanceInput({ agent: "codex" }));
  expect(noSession).toEqual({ outcome: "refused", reason: "noActiveSession" });
});

it("F-14: a held write lock yields commitFailed after exactly 1+3 attempts with the pinned 150/300/600ms ladder, and the state is untouched; releasing the lock lets the SAME attempt advance", async () => {
  const { db, dbPath } = openSeeded();
  bumpGeneration(db, bumpInput());
  recordPromptAttempt(db, attemptInput());
  db.pragma("busy_timeout = 25"); // keep each attempt's inner sqlite wait short — the LADDER is under test
  const holder = track(new Database(dbPath));
  holder.exec("BEGIN IMMEDIATE"); // a real held write lock from a second connection
  const sleeps: number[] = [];
  const result = await advanceCursorOnAccept(db, advanceInput(), {
    delayFn: async (ms) => {
      sleeps.push(ms);
    },
  });
  expect(result).toMatchObject({ outcome: "commitFailed", attempts: 4 });
  expect(sleeps).toEqual([150, 300, 600]);
  holder.exec("ROLLBACK");
  expect(getPromptAttempt(db, "a1")?.resolved).toBeNull(); // stays unresolved — recovery evidence (F-14)
  expect(getLaneCursor(db, "p1", "claude")?.lastSeq).toBe(0);
  const retried = await advanceCursorOnAccept(db, advanceInput(), {
    delayFn: async () => {},
  });
  expect(retried).toEqual({ outcome: "advanced" });
});

it("pins the spec's retry policy constants (F-14) and the resolved-attempts cap", () => {
  expect(CURSOR_COMMIT_RETRY).toEqual({ retries: 3, backoffMs: [150, 300, 600] });
  expect(RESOLVED_ATTEMPTS_KEEP).toBe(200);
});

it("listUnresolvedAttempts scopes to the CURRENT (generation, sessionId) pair only (I-1 recovery read)", () => {
  const { db } = openSeeded();
  bumpGeneration(db, bumpInput());
  recordPromptAttempt(db, attemptInput({ attemptId: "g1-open" }));
  bumpGeneration(db, bumpInput({ sessionId: "s2", now: T1 }));
  recordPromptAttempt(
    db,
    attemptInput({ attemptId: "g2-open", generation: 2, sessionId: "s2", sentAt: T1 }),
  );
  recordPromptAttempt(
    db,
    attemptInput({ attemptId: "g2-done", generation: 2, sessionId: "s2", sentAt: T2 }),
  );
  db.prepare(
    "UPDATE lane_prompt_attempts SET resolved='accepted' WHERE attempt_id='g2-done'",
  ).run();
  const rows = listUnresolvedAttempts(db, {
    projectId: "p1",
    agent: "claude",
    generation: 2,
    sessionId: "s2",
  });
  expect(rows.map((r) => r.attemptId)).toEqual(["g2-open"]);
  expect(rows[0]).toMatchObject({
    generation: 2,
    sessionId: "s2",
    seqFrom: 1,
    seqTo: 3,
    resolved: null,
  });
});

it("pruneResolvedAttempts keeps the newest N resolved rows and NEVER deletes unresolved rows", () => {
  const { db } = openSeeded();
  bumpGeneration(db, bumpInput());
  for (let i = 0; i < 12; i += 1) {
    const resolved = i < 9 ? (i % 2 === 0 ? "accepted" : "abandoned") : null;
    recordPromptAttempt(
      db,
      attemptInput({
        attemptId: `a-${String(i).padStart(2, "0")}`,
        sentAt: `2026-07-10T00:00:${String(10 + i)}Z`,
      }),
    );
    if (resolved !== null) {
      db.prepare("UPDATE lane_prompt_attempts SET resolved=? WHERE attempt_id=?").run(
        resolved,
        `a-${String(i).padStart(2, "0")}`,
      );
    }
  }
  const pruned = pruneResolvedAttempts(db, "p1", "claude", 4);
  expect(pruned).toBe(5); // 9 resolved − the newest 4
  const survivors = db
    .prepare(
      "SELECT attempt_id FROM lane_prompt_attempts WHERE project_id='p1' AND agent='claude' ORDER BY attempt_id",
    )
    .all() as Array<{ attempt_id: string }>;
  expect(survivors.map((r) => r.attempt_id)).toEqual([
    "a-05",
    "a-06",
    "a-07",
    "a-08", // the 4 newest resolved (by sent_at)
    "a-09",
    "a-10",
    "a-11", // ALL unresolved rows survive — recovery evidence
  ]);
});

it("laneBindingMatches: true on the full tuple, false on ANY single-field mismatch (I-2)", () => {
  const { db } = openSeeded();
  bumpGeneration(db, bumpInput());
  const session = getLaneSession(db, "p1", "claude");
  if (session === undefined) {
    throw new Error("session row missing");
  }
  const binding = { cwd: "C:/tmp/p", adapterPkg: "claude-agent-acp", adapterVersion: "0.58.1" };
  expect(laneBindingMatches(session, binding)).toBe(true);
  expect(laneBindingMatches(session, { ...binding, cwd: "C:/tmp/OTHER" })).toBe(false);
  expect(laneBindingMatches(session, { ...binding, adapterPkg: "codex-acp" })).toBe(false);
  expect(laneBindingMatches(session, { ...binding, adapterVersion: "0.59.0" })).toBe(false);
});

it("touchResumed stamps last_resumed_at without touching the binding or generation", () => {
  const { db } = openSeeded();
  bumpGeneration(db, bumpInput());
  touchResumed(db, "p1", "claude", T2);
  expect(getLaneSession(db, "p1", "claude")).toMatchObject({
    generation: 1,
    sessionId: "s1",
    lastResumedAt: T2,
  });
});

it("setBriefingCarry re-arms an accepted cursor WITHOUT touching its generation/lastSeq (I-8 re-arm)", async () => {
  const { db } = openSeeded();
  bumpGeneration(db, bumpInput());
  recordPromptAttempt(db, attemptInput({ seqFrom: 1, seqTo: 5 }));
  await advanceCursorOnAccept(db, advanceInput({ lastSeq: 5, clearBriefingCarry: true }));
  expect(getLaneCursor(db, "p1", "claude")?.needsBriefingCarry).toBe(false);
  setBriefingCarry(db, "p1", "claude", T2);
  expect(getLaneCursor(db, "p1", "claude")).toEqual({
    projectId: "p1",
    agent: "claude",
    generation: 1,
    lastSeq: 5,
    needsBriefingCarry: true,
    updatedAt: T2,
  });
});
