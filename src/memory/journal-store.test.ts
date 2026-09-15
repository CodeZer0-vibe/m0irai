// journal-store: append (J2 seq retry-on-UNIQUE across two cockpits), supersede (J5 link, anchor exemption
// A1/A2), project-scoped reads (M3 isolation), and debug-gated memory.trace (O1/O2). Real sqlite, two real
// handles for the collision. No mocks. Top-level it() (no describe wrapper) so no callback trips the clamp.
// @size-justified: one suite owns the J2/J5/M3/O2 seams AND the M4 query-plan pins that bind the exact SQL readByFiles runs.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { ChatEvent } from "../chat/events.js";
import { type Db, closeDb, openMemoryDb } from "../evidence/db.js";
import {
  type JournalAuthor,
  appendEntry,
  buildReadByFilesSql,
  readByFiles,
  readByProject,
  supersede,
} from "./journal-store.js";

const NOW = "2026-07-04T00:00:00.000Z";
let tempRoot: string | undefined;
const savedDebug = process.env.ZER0_DEBUG;

beforeEach(() => {
  process.env.ZER0_DEBUG = "0"; // B2a-1: debug is on-by-default now; this suite's OFF baseline is explicit
});

afterEach(() => {
  if (savedDebug === undefined) delete process.env.ZER0_DEBUG;
  else process.env.ZER0_DEBUG = savedDebug;
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

function freshDbPath(): string {
  tempRoot = mkdtempSync(join(tmpdir(), "zer0-journal-"));
  return join(tempRoot, "evidence.db");
}

// Agent-authored decision on given files, oldest-first seeding for the read tests.
function seedDecision(
  db: Db,
  projectId: string,
  agent: string,
  body: string,
  files: string[],
): string {
  return appendEntry(db, {
    projectId,
    category: "decision",
    author: "agent",
    agent,
    body,
    createdAt: NOW,
    touchedFiles: files,
  });
}

function seedProject(db: Db, projectId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO projects (project_id, canonical_root, git_common_dir, created_at) VALUES (?, ?, ?, ?)",
  ).run(projectId, `/repo/${projectId}`, `/repo/${projectId}/.git`, NOW);
}

it("two cockpits appending under a FORCED collision both land with distinct seqs (J2 retry)", () => {
  const dbPath = freshDbPath();
  const dbA = openMemoryDb(dbPath);
  const dbB = openMemoryDb(dbPath);
  try {
    seedProject(dbA, "p1");
    let armed = true;
    // A selects seq=1, then the hook makes B do a FULL append (B selects seq=1, INSERTs seq=1) BEFORE A's
    // INSERT — so A's INSERT genuinely fires the UNIQUE(project_id, seq) violation and A's retry loop runs.
    const idA = appendEntry(
      dbA,
      { projectId: "p1", category: "decision", author: "agent", body: "A", createdAt: NOW },
      {
        beforeInsert: () => {
          if (!armed) return;
          armed = false;
          appendEntry(dbB, {
            projectId: "p1",
            category: "decision",
            author: "agent",
            body: "B",
            createdAt: NOW,
          });
        },
      },
    );
    expect(armed).toBe(false); // the hook fired — the collision was actually forced
    const rows = readByProject(dbA, "p1", { includeSuperseded: true });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.seq).sort((a, b) => a - b)).toEqual([1, 2]);
    // A retried onto seq 2 (B took seq 1) — the retry loop executed, not a vacuous non-collision.
    expect(rows.find((r) => r.entryId === idA)?.seq).toBe(2);
  } finally {
    closeDb(dbA);
    closeDb(dbB);
  }
});

it("superseding links old->new and BOTH remain readable (J5)", () => {
  const db = openMemoryDb(freshDbPath());
  try {
    seedProject(db, "p1");
    const oldId = appendEntry(db, {
      projectId: "p1",
      category: "decision",
      author: "agent",
      body: "use polling",
      createdAt: NOW,
    });
    const newId = appendEntry(db, {
      projectId: "p1",
      category: "decision",
      author: "agent",
      body: "use websocket",
      createdAt: NOW,
    });
    expect(supersede(db, oldId, newId)).toEqual({ ok: true });
    const all = readByProject(db, "p1", { includeSuperseded: true });
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.entryId === oldId)?.supersededBy).toBe(newId);
    // Default read excludes superseded entries; the new one survives.
    expect(readByProject(db, "p1").map((r) => r.entryId)).toEqual([newId]);
  } finally {
    closeDb(db);
  }
});

it("an auto-supersede attempt on an ANCHOR is refused and leaves the anchor unchanged (A1/A2)", () => {
  const db = openMemoryDb(freshDbPath());
  try {
    seedProject(db, "p1");
    const anchorId = appendEntry(db, {
      projectId: "p1",
      category: "anchor",
      author: "operator",
      body: "file-based only",
      anchor: true,
      createdAt: NOW,
    });
    const decisionId = appendEntry(db, {
      projectId: "p1",
      category: "decision",
      author: "agent",
      body: "add a server",
      createdAt: NOW,
    });
    expect(supersede(db, anchorId, decisionId).ok).toBe(false); // auto path: allowAnchor defaults false
    const row = readByProject(db, "p1", { includeSuperseded: true }).find(
      (r) => r.entryId === anchorId,
    );
    expect(row?.supersededBy).toBeNull(); // the anchor survived the digest-style attempt
    // The explicit operator path CAN supersede it.
    expect(supersede(db, anchorId, decisionId, { allowAnchor: true })).toEqual({ ok: true });
  } finally {
    closeDb(db);
  }
});

it("reads return ONLY the requesting project's entries; an empty projectId fails closed (M3)", () => {
  const db = openMemoryDb(freshDbPath());
  try {
    seedProject(db, "pA");
    seedProject(db, "pB");
    appendEntry(db, {
      projectId: "pA",
      category: "decision",
      author: "agent",
      body: "a",
      createdAt: NOW,
    });
    appendEntry(db, {
      projectId: "pB",
      category: "decision",
      author: "agent",
      body: "b",
      createdAt: NOW,
    });
    expect(readByProject(db, "pA").map((r) => r.body)).toEqual(["a"]);
    expect(readByProject(db, "pB").map((r) => r.body)).toEqual(["b"]);
    expect(readByProject(db, "  ")).toEqual([]); // fail-closed on blank projectId
  } finally {
    closeDb(db);
  }
});

it("append traces ONE memory.trace (id+category+author) under ZER0_DEBUG; zero when off (O1/O2)", () => {
  const db = openMemoryDb(freshDbPath());
  try {
    seedProject(db, "p1");
    const events: ChatEvent[] = [];
    const bus = { emit: (e: ChatEvent) => events.push(e) };

    process.env.ZER0_DEBUG = "1";
    const id = appendEntry(
      db,
      { projectId: "p1", category: "decision", author: "operator", body: "x", createdAt: NOW },
      { trace: bus },
    );
    expect(events).toHaveLength(1);
    const ev = events[0] as ChatEvent & { phase?: string; detail?: string };
    expect(ev.kind).toBe("memory.trace");
    expect(ev.phase).toBe("journal");
    expect(ev.detail).toContain(id);
    expect(ev.detail).toContain("decision");
    expect(ev.detail).toContain("operator");

    process.env.ZER0_DEBUG = "0"; // B2a-1: explicit OFF (debug is on-by-default now) for the zero-trace leg
    events.length = 0;
    appendEntry(
      db,
      { projectId: "p1", category: "decision", author: "operator", body: "y", createdAt: NOW },
      { trace: bus },
    );
    expect(events).toHaveLength(0); // debug off = zero trace bytes
  } finally {
    closeDb(db);
  }
});

it("M4: a CHECK violation throws IMMEDIATELY — the retry loop never runs (attempts === 1)", () => {
  const db = openMemoryDb(freshDbPath());
  try {
    seedProject(db, "p1");
    let attempts = 0;
    let thrown: unknown;
    try {
      appendEntry(
        db,
        {
          projectId: "p1",
          category: "decision",
          author: "bogus" as JournalAuthor, // hostile: violates author CHECK(author IN (...))
          body: "x",
          createdAt: NOW,
        },
        {
          beforeInsert: () => {
            attempts += 1;
          },
        },
      );
    } catch (err) {
      thrown = err;
    }
    expect(attempts).toBe(1); // RED today: any SQLITE_CONSTRAINT burns MAX_SEQ_RETRIES first
    expect((thrown as { code?: string }).code).toBe("SQLITE_CONSTRAINT_CHECK");
  } finally {
    closeDb(db);
  }
});

it("M4: a FOREIGN KEY violation throws IMMEDIATELY — no retry burn", () => {
  const db = openMemoryDb(freshDbPath());
  try {
    let attempts = 0;
    let thrown: unknown;
    try {
      // No projects row for "ghost": FK journal_entries.project_id -> projects fires immediately.
      appendEntry(
        db,
        { projectId: "ghost", category: "decision", author: "agent", body: "x", createdAt: NOW },
        {
          beforeInsert: () => {
            attempts += 1;
          },
        },
      );
    } catch (err) {
      thrown = err;
    }
    expect(attempts).toBe(1);
    expect((thrown as { code?: string }).code).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
  } finally {
    closeDb(db);
  }
});

it("M4: a NOT NULL violation throws IMMEDIATELY (hostile agent-NOT-NULL table)", () => {
  const db = openMemoryDb(freshDbPath());
  try {
    seedProject(db, "p1");
    // Hostile fixture: same 13-column shape but agent NOT NULL — INSERT_SQL binds @agent NULL,
    // which the real schema permits and this fixture refuses. The one honest way to reach
    // SQLITE_CONSTRAINT_NOTNULL through the public seam.
    db.exec(
      `DROP TABLE journal_entries;
       CREATE TABLE journal_entries (
         entry_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id),
         category TEXT NOT NULL, author TEXT NOT NULL, agent TEXT NOT NULL, body TEXT NOT NULL,
         topic_key TEXT, touched_files TEXT, domain_tags TEXT, anchor INTEGER NOT NULL DEFAULT 0,
         superseded_by TEXT, seq INTEGER NOT NULL, created_at TEXT NOT NULL,
         UNIQUE(project_id, seq));`,
    );
    let attempts = 0;
    let thrown: unknown;
    try {
      appendEntry(
        db,
        { projectId: "p1", category: "decision", author: "agent", body: "x", createdAt: NOW },
        {
          beforeInsert: () => {
            attempts += 1;
          },
        },
      );
    } catch (err) {
      thrown = err;
    }
    expect(attempts).toBe(1);
    expect((thrown as { code?: string }).code).toBe("SQLITE_CONSTRAINT_NOTNULL");
  } finally {
    closeDb(db);
  }
});

it("M4: when the projection write cannot land, the journal row does not either (one atomic write)", () => {
  const db = openMemoryDb(freshDbPath());
  try {
    seedProject(db, "p1");
    // Hostile fixture: the projection sink is removed under the writer. The journal INSERT must
    // NOT survive without its projection rows.
    db.exec("DROP TABLE IF EXISTS journal_entry_files");
    let threw = false;
    try {
      appendEntry(db, {
        projectId: "p1",
        category: "decision",
        author: "ledger",
        body: "atomic pair",
        createdAt: NOW,
        touchedFiles: ["src/a.ts"],
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true); // RED today: no trigger yet, the bare journal row commits
    const count = db.prepare("SELECT COUNT(*) AS c FROM journal_entries").get() as { c: number };
    expect(count.c).toBe(0); // RED today: c === 1
  } finally {
    closeDb(db);
  }
});

it("M4 r4 (rewrites M4): supersede rewrites ONLY superseded_by — and the retired entry's projection rows go with it", () => {
  const db = openMemoryDb(freshDbPath());
  try {
    seedProject(db, "p1");
    const oldId = appendEntry(db, {
      projectId: "p1",
      category: "decision",
      author: "agent",
      agent: "claude",
      body: "old",
      createdAt: NOW,
      touchedFiles: ["src/a.ts"],
    });
    const newId = appendEntry(db, {
      projectId: "p1",
      category: "decision",
      author: "agent",
      agent: "codex",
      body: "new",
      createdAt: NOW,
      touchedFiles: ["src/a.ts"],
    });
    expect(supersede(db, oldId, newId)).toEqual({ ok: true });
    const projected = db
      .prepare("SELECT COUNT(*) AS c FROM journal_entry_files WHERE entry_id = ?")
      .get(oldId) as { c: number };
    // ROUND 4 (codex r1-B): retirement cleans the projection at the WRITE side (the v21 cleanup
    // trigger) — a retired history must stop existing there, or hot keys pay for it forever.
    expect(projected.c).toBe(0);
    const linked = db
      .prepare("SELECT COUNT(*) AS c FROM journal_entries WHERE entry_id = ? AND superseded_by = ?")
      .get(oldId, newId) as { c: number };
    expect(linked.c).toBe(1); // the J5 link itself is intact — retire, never delete
  } finally {
    closeDb(db);
  }
});

it("W1 (MT6a review): the STORE edge canonicalizes touchedFiles — backslash/./ spellings land router-matchable, deduped; all-invalid lands NULL", () => {
  const db = openMemoryDb(freshDbPath());
  try {
    seedProject(db, "p1");
    const id = appendEntry(db, {
      projectId: "p1",
      category: "decision",
      author: "ledger",
      body: "retry ladder stays at three attempts",
      createdAt: NOW,
      touchedFiles: [
        String.raw`src\memory\digest.ts`,
        "./src/memory/digest.ts",
        "src/memory/router.ts",
      ],
    });
    const rows = readByProject(db, "p1");
    const stored = rows.find((r) => r.entryId === id);
    // The kill-chain falsifier: the operator asks slash-form; exact-match intersection must hit.
    expect(stored?.touchedFiles).toEqual(["src/memory/digest.ts", "src/memory/router.ts"]);

    const allInvalid = appendEntry(db, {
      projectId: "p1",
      category: "decision",
      author: "ledger",
      body: "nothing repo-relative here",
      createdAt: NOW,
      touchedFiles: ["C:/abs/evil.ts", "../escape.ts"],
    });
    const invalidRow = readByProject(db, "p1").find((r) => r.entryId === allInvalid);
    expect(invalidRow?.touchedFiles).toBeNull();
  } finally {
    closeDb(db);
  }
});

it("M4 r2 (F1): the file-pull query DRIVES from idx_journal_entry_files_lookup — query-plan pin", () => {
  const db = openMemoryDb(freshDbPath());
  try {
    seedProject(db, "p1");
    appendEntry(db, {
      projectId: "p1",
      category: "decision",
      author: "agent",
      agent: "claude",
      body: "a",
      createdAt: NOW,
      touchedFiles: ["src/a.ts"],
    });
    expect(readByFiles(db, "p1", new Set(["src/a.ts"])).map((r) => r.body)).toEqual(["a"]);
    // The pin binds the SQL readByFiles ACTUALLY runs (same builder, one source), so a query-shape change
    // lands right here. The LIMIT's bound value does not affect the plan; 5000 is what readByFiles passes.
    const plan = (
      db.prepare(`EXPLAIN QUERY PLAN ${buildReadByFilesSql()}`).all("p1", "src/a.ts", 5_000) as {
        detail: string;
      }[]
    ).map((r) => r.detail);
    // Round 1 planned "SEARCH je USING INDEX sqlite_autoindex_journal_entries_2 (project_id=?)" FIRST and
    // never opened the lookup index this lane's migration creates — measured at 74.585 ms p50 for one key
    // at 100,000 spread rows when re-run in round 3 (runs quoted in m4-report ROUND 3).
    expect(plan[0]).toBe(
      "SEARCH f USING INDEX idx_journal_entry_files_lookup (project_id=? AND file_key=?)",
    );
    expect(plan[1]).toMatch(/^SEARCH je USING( COVERING)? INDEX \S+ \(entry_id=\?\)$/);
    // Exactly two steps for one key: no temp B-tree, so the index supplies seq DESC order directly and
    // the LIMIT stops the index walk early instead of sorting every match first.
    expect(plan).toHaveLength(2);
    expect(plan.some((step) => step.startsWith("SCAN"))).toBe(false);
  } finally {
    closeDb(db);
  }
});

it("M4 r4 (supersedes M4 r3 R2-F1): multi-key reads run THE pinned statement per key; the DISTINCT-entry budget holds at any key count", () => {
  const db = openMemoryDb(freshDbPath());
  try {
    seedProject(db, "p1");
    // Round 4 collapsed the multi-key shape: there is exactly ONE statement (the one the r2 F1 pin
    // plans — SEARCH idx_journal_entry_files_lookup, no temp B-tree, LIMIT stops the walk early),
    // executed once PER REQUESTED KEY and merged newest-first in JS under a DISTINCT-entry budget.
    // The plan guarantee therefore transfers to multi-key by IDENTITY with F1 — re-running a second
    // EXPLAIN here would pin a copy, not the seam. What still needs its own pin is what changed:
    // global order, cross-key dedupe, and the budget counting DEDUPLICATED candidates.
    const ins = db.prepare(
      "INSERT INTO journal_entries " +
        "(entry_id, project_id, category, author, agent, body, touched_files, anchor, superseded_by, seq, created_at) " +
        "VALUES (?, 'p1', 'decision', 'ledger', NULL, ?, ?, 0, NULL, 1, ?)",
    );
    ins.run("eligible", "the old eligible fact", JSON.stringify(["src/a.ts"]), NOW);
    // seqs 2-4 via the public seam: oldest-first, so newest-first output order is observable; seq 4
    // touches BOTH keys — the row that arrives once per key and must collapse to one.
    seedDecision(db, "p1", "claude", "second, on a only", ["src/a.ts"]);
    seedDecision(db, "p1", "codex", "third, on b only", ["src/b.ts"]);
    seedDecision(db, "p1", "gemini", "newest, on both keys", ["src/a.ts", "src/b.ts"]);
    expect(readByFiles(db, "p1", new Set(["src/a.ts", "src/b.ts"])).map((r) => r.seq)).toEqual([
      4, 3, 2, 1,
    ]);
    // Mini-starvation at k=2 (codex r1-A's mechanism at half scale): 2,501 newer decisions EACH touch
    // BOTH keys -> 5,002 raw projection rows oversubscribe the budget through pure duplication, and
    // the eligible OLDEST fact would be cut before dedupe if the limit counted raw rows.
    const BOTH = JSON.stringify(["src/a.ts", "src/b.ts"]);
    const dup = db.prepare(
      "INSERT INTO journal_entries " +
        "(entry_id, project_id, category, author, agent, body, touched_files, anchor, superseded_by, seq, created_at) " +
        "VALUES (?, 'p1', 'decision', 'agent', 'claude', ?, ?, 0, NULL, ?, ?)",
    );
    db.transaction(() => {
      for (let i = 0; i < 2_501; i += 1) {
        dup.run(`dup${i}`, `duplicated entry ${i}`, BOTH, i + 5, NOW);
      }
    })();
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM journal_entry_files").get() as { c: number }).c,
    ).toBe(5_007); // 2501*2 + 5 — genuinely over the 5,000 budget on RAW rows
    const ids = readByFiles(db, "p1", new Set(["src/a.ts", "src/b.ts"])).map((r) => r.entryId);
    expect(ids).toContain("eligible"); // duplication consumed zero budget slots
    expect(new Set(ids).size).toBe(ids.length);
  } finally {
    closeDb(db);
  }
});

it("M4 r4 (codex r1-A): 313 newer entries on ALL 16 keys cannot starve an older eligible fact", () => {
  const db = openMemoryDb(freshDbPath());
  try {
    seedProject(db, "p1");
    // Codex's exact starvation shape: the eligible fact is OLDEST (seq 1); 313 newer own-agent
    // decisions EACH touch all 16 requested keys, so they alone produce 313*16 = 5,008 raw projection
    // rows - over MAX_FILE_MATCH_ROWS. The budget counts DISTINCT entries, never raw per-key rows.
    const KEYS = Array.from({ length: 16 }, (_, i) => `src/f${i}.ts`);
    const ins = db.prepare(
      "INSERT INTO journal_entries " +
        "(entry_id, project_id, category, author, agent, body, touched_files, anchor, superseded_by, seq, created_at) " +
        "VALUES (?, 'p1', 'decision', ?, ?, ?, ?, 0, NULL, ?, ?)",
    );
    db.transaction(() => {
      ins.run(
        "eligible",
        "ledger",
        null,
        "the old eligible fact",
        JSON.stringify([KEYS[0]]),
        1,
        NOW,
      );
      const allKeys = JSON.stringify(KEYS);
      for (let i = 0; i < 313; i += 1) {
        ins.run(`new${i}`, "agent", "claude", `newer own-agent entry ${i}`, allKeys, i + 2, NOW);
      }
    })();
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM journal_entry_files").get() as { c: number }).c,
    ).toBe(5_009); // the corpus really oversubscribes the budget (313*16 + 1)
    const rows = readByFiles(db, "p1", new Set(KEYS));
    const ids = rows.map((r) => r.entryId);
    // The fact survives: duplication across keys must not consume the DISTINCT-entry budget.
    expect(ids).toContain("eligible");
    // Newest-first order is undisturbed and no entry appears twice.
    const seqs = rows.map((r) => r.seq);
    expect([...seqs].sort((a, b) => b - a)).toEqual(seqs);
    expect(new Set(ids).size).toBe(ids.length);
  } finally {
    closeDb(db);
  }
});

it("M4 r2 (F5): readByFiles DROPS a superseded entry for its own file; the replacement stays", () => {
  const db = openMemoryDb(freshDbPath());
  try {
    seedProject(db, "p1");
    const retiredId = appendEntry(db, {
      projectId: "p1",
      category: "decision",
      author: "agent",
      agent: "claude",
      body: "RETIRED: we will use library X",
      createdAt: NOW,
      touchedFiles: ["src/a.ts"],
    });
    const currentId = appendEntry(db, {
      projectId: "p1",
      category: "decision",
      author: "agent",
      agent: "codex",
      body: "we use library Y",
      createdAt: NOW,
      touchedFiles: ["src/a.ts"],
    });
    expect(supersede(db, retiredId, currentId)).toEqual({ ok: true });
    // ROUND 4 (codex r1-B): the retired entry's projection rows are REMOVED at the write side.
    const projected = db
      .prepare("SELECT COUNT(*) AS c FROM journal_entry_files WHERE entry_id = ?")
      .get(retiredId) as { c: number };
    expect(projected.c).toBe(0);
    // The read-side `je.superseded_by IS NULL` guard stays as the defense for LEGACY rows — a DB written
    // before round 4 carries them until its next open repairs (migrations-v21 purge). Simulate one: with
    // the row forced back, the read query is still what stands between a retired fact and a briefing
    // (deleting the guard left the suite green before round 2 pinned it).
    db.prepare(
      "INSERT INTO journal_entry_files (entry_id, project_id, file_key, seq) VALUES (?, 'p1', 'src/a.ts', ?)",
    ).run(retiredId, 1);
    const ids = readByFiles(db, "p1", new Set(["src/a.ts"])).map((r) => r.entryId);
    expect(ids).toEqual([currentId]);
    expect(ids).not.toContain(retiredId);
  } finally {
    closeDb(db);
  }
});
