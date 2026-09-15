// M4 REBASE ITEM 7 (review r4 finding R4-F2) — the multi-key query-plan pins, restored.
//
// THE DEFECT. Round 3 asserted, for keyCount 2 AND 4, one `SEARCH f USING INDEX
// idx_journal_entry_files_lookup` step per key, no bare SCAN, and no USE TEMP B-TREE FOR GROUP BY.
// Round 4 collapsed the multi-key path to "one statement per key, merged in JS" and deleted all of it,
// arguing the plan guarantee transfers from the keyCount-1 pin BY IDENTITY. That argument is sound
// TODAY and it is not the point: the reviewer BUILT the regression it stopped catching. Mutation
// MUT-SHAPE re-introduced the compound the round-4 decision table had measured and rejected (per-key
// arms in a UNION ALL, then GROUP BY entry_id ORDER BY seq DESC LIMIT) — behaviourally correct, dedupe
// still before the limit, so every behavioural pin was satisfied — and the whole suite went
// 459/459 GREEN. Under round 3's test that same mutation failed on USE TEMP B-TREE FOR GROUP BY.
// Measured cost of what nothing caught (reviewer's within-run k=3/k=1 p50 ratio, which cancels machine
// load): tip 1.62 / 1.71 / 1.31 versus MUT-SHAPE 2.58 / 2.34 / 1.81 — the rejected shape degrades ~1.4x
// faster with key count, and key count is the axis the router actually moves (every extracted file is
// requested at once).
//
// WHAT THESE PINS BIND, and why they are not a copy of the keyCount-1 pin. They do not re-plan a module
// constant; they intercept `db.prepare` and read back the statements `readByFiles` ACTUALLY COMPILED for
// a 1-, 2- and 4-key request. So the identity argument stops being an argument: it is asserted. A future
// multi-key path that stops running the pinned statement is caught at the seam, whatever its plan.
//
// ROUND 2 (review R5-F3) — WHY THIS IS TWO TESTS PER KEY COUNT AND NOT ONE. As a single test, identity
// was asserted first, so under MUT-SHAPE the run stopped there and the temp-B-tree assertion — the one
// the paragraph above quotes as the round-3 kill — never executed. The claim was true of round 3's test
// and NOT of this file. Split, both halves fire independently on the same mutation: identity reports
// WHICH statements were compiled, and the plan half EXPLAINs whatever was compiled and reports the temp
// B-tree. `planOf` derives its binds from the statement's own marker count for exactly that reason; a
// hardcoded arity would have made the plan half throw inside EXPLAIN instead of asserting.
//
// This lives in its own file, not in journal-store.test.ts, because that suite is at 595 lines against a
// 600-line HARD clamp: growth is answered by extraction, never by raising the limit.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type Db, closeDb, openMemoryDb } from "../evidence/db.js";
import { appendEntry, buildReadByFilesSql, readByFiles } from "./journal-store.js";

const NOW = "2026-07-04T00:00:00.000Z";
// The bound readByFiles passes. A LIMIT's bound VALUE never changes a plan; this is the real one so the
// EXPLAIN is of the statement as it actually runs.
const PULL_LIMIT = 5_000;
const DRIVING_STEP =
  "SEARCH f USING INDEX idx_journal_entry_files_lookup (project_id=? AND file_key=?)";
const JOIN_STEP = /^SEARCH je USING( COVERING)? INDEX \S+ \(entry_id=\?\)$/;

let tempRoot: string | undefined;
const savedDebug = process.env.ZER0_DEBUG;

beforeEach(() => {
  process.env.ZER0_DEBUG = "0";
});

afterEach(() => {
  if (savedDebug === undefined) delete process.env.ZER0_DEBUG;
  else process.env.ZER0_DEBUG = savedDebug;
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    tempRoot = undefined;
  }
});

function freshDbPath(): string {
  tempRoot = mkdtempSync(join(tmpdir(), "zer0-journal-plan-"));
  return join(tempRoot, "evidence.db");
}

function seedProject(db: Db, projectId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO projects (project_id, canonical_root, git_common_dir, created_at) VALUES (?, ?, ?, ?)",
  ).run(projectId, `/repo/${projectId}`, `/repo/${projectId}/.git`, NOW);
}

function seedDecision(db: Db, agent: string, body: string, files: string[]): void {
  appendEntry(db, {
    projectId: "p1",
    category: "decision",
    author: "agent",
    agent,
    body,
    createdAt: NOW,
    touchedFiles: files,
  });
}

/**
 * Every SQL string `run` compiles on this handle, in compile order. The interception is an OWN property
 * shadowing the prototype method for the duration of the call, deleted afterwards so the handle is left
 * exactly as it was found.
 */
function captureCompiledSql(db: Db, run: () => void): string[] {
  const original = db.prepare.bind(db);
  const compiled: string[] = [];
  Reflect.set(db, "prepare", (sql: string) => {
    compiled.push(sql);
    return original(sql);
  });
  try {
    run();
  } finally {
    Reflect.deleteProperty(db, "prepare");
  }
  return compiled;
}

// EXPLAIN whatever was compiled, WHATEVER ITS ARITY. Round 2 (review R5-F3): binding a hardcoded
// three made the plan assertions unreachable under any mutation that changes the statement, because
// EXPLAIN itself would have thrown on the bind count — so the plan half could only ever run against
// the shape it already trusted. Binds are derived instead: 2N+1 markers is N (projectId, fileKey)
// pairs plus the limit, which is the pinned statement at N=1 and a per-key-arms compound at N>1. The
// values never change a plan; only their count has to be right.
function planOf(db: Db, sql: string): string[] {
  const markers = sql.split("?").length - 1;
  expect(markers % 2, `cannot bind ${markers} markers as (projectId, fileKey) pairs + LIMIT`).toBe(
    1,
  );
  const binds: unknown[] = [];
  for (let pair = 0; pair < (markers - 1) / 2; pair += 1) {
    binds.push("p1", KEYS[pair % KEYS.length]);
  }
  binds.push(PULL_LIMIT);
  return (
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds) as {
      detail: string;
    }[]
  ).map((row) => row.detail);
}

// Four files so the request can be sliced to 1, 2 and 4 keys against one seeded corpus. The entries
// overlap deliberately: the newest touches all four, so cross-key duplication is real at every key count
// and a compound that dedupes with GROUP BY would have something to group.
function seedCorpus(db: Db): void {
  seedProject(db, "p1");
  seedDecision(db, "claude", "oldest, on a", ["src/a.ts"]);
  seedDecision(db, "codex", "second, on b", ["src/b.ts"]);
  seedDecision(db, "gemini", "third, on c and d", ["src/c.ts", "src/d.ts"]);
  seedDecision(db, "claude", "newest, on all four", [
    "src/a.ts",
    "src/b.ts",
    "src/c.ts",
    "src/d.ts",
  ]);
}

const KEYS = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"] as const;

// What readByFiles compiled for a request of this many keys, with the rows it returned as a positive
// control that the read actually ran over the overlapping corpus.
function compiledFor(db: Db, keyCount: number): string[] {
  seedCorpus(db);
  let rows: ReturnType<typeof readByFiles> = [];
  const compiled = captureCompiledSql(db, () => {
    rows = readByFiles(db, "p1", new Set(KEYS.slice(0, keyCount)));
  });
  expect(rows.length).toBeGreaterThan(0);
  expect(new Set(rows.map((row) => row.entryId)).size).toBe(rows.length);
  return compiled;
}

// TWO tests per key count, not one, because of review R5-F3: as a single test the plan assertions
// were UNREACHABLE under the mutation this file was written against — identity failed first and the
// run stopped there. They are not dead in general (a mutation that keeps one-statement-per-key but
// changes the SQL reaches them), but a pin whose most-quoted assertion cannot fire under its own
// headline mutation is not carrying the weight its comment claims. Split, each one fails on its own
// evidence: identity on WHICH statements were compiled, plan on what the compiled statement DOES.
it.each([1, 2, 4] as const)(
  "M4 rebase (R4-F2): a %i-key read compiles ONE pinned statement per key",
  (keyCount) => {
    const db = openMemoryDb(freshDbPath());
    try {
      const compiled = compiledFor(db, keyCount);
      // IDENTITY, asserted instead of argued: N compilations, all of them THE pinned statement.
      expect(compiled).toHaveLength(keyCount);
      expect(new Set(compiled).size).toBe(1);
      expect(compiled[0]).toBe(buildReadByFilesSql());
    } finally {
      closeDb(db);
    }
  },
);

it.each([1, 2, 4] as const)(
  "M4 rebase (R4-F2): the statement a %i-key read compiles drives the lookup index, with no SCAN and no temp B-tree",
  (keyCount) => {
    const db = openMemoryDb(freshDbPath());
    try {
      const compiled = compiledFor(db, keyCount);
      // Deliberately EXPLAINs what was compiled rather than the module constant, and takes no view on
      // whether that is the pinned statement — the sibling test above owns identity. A rejected shape
      // therefore reaches these assertions and fails on its PLAN, which is the diagnosis a reader wants.
      const plan = planOf(db, compiled[0] as string);
      // BANNED SHAPES FIRST, deliberately (review R5-F3). These are the two the round-4 decision table
      // measured and rejected, and they are the DIAGNOSIS a reader wants when this test goes red. Put
      // after the exact-shape assertions they would never be reported: MUT-SHAPE fails `plan[0]` with
      // "CO-ROUTINE (subquery-2)" and the run stops there, even though its plan does carry the temp
      // B-tree at every key count. Order is the whole difference between a message that names the
      // defect and one that names a symptom.
      expect(plan.filter((step) => step.includes("USE TEMP B-TREE"))).toEqual([]);
      expect(plan.filter((step) => step.startsWith("SCAN"))).toEqual([]);
      // Then the exact shape: drive the lookup index, join by entry_id, nothing else. Two steps means
      // the index supplies seq DESC order directly, so LIMIT stops the walk early instead of sorting
      // every match first.
      expect(plan[0]).toBe(DRIVING_STEP);
      expect(plan[1]).toMatch(JOIN_STEP);
      expect(plan).toHaveLength(2);
    } finally {
      closeDb(db);
    }
  },
);
