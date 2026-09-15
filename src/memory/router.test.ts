/**
 * @file src/memory/router.test.ts
 * @purpose MT6a router pull selection coverage over real sqlite journal rows, project scoping, recency caps,
 *   own-agent exclusion, file relevance, and debug-gated briefing traces.
 * @exports (none)
 * @depends node:fs, node:os, node:path, vitest, ../chat/events, ../evidence/db, ./journal-store, ./router
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { ChatEvent } from "../chat/events.js";
import { type Db, closeDb, openMemoryDb } from "../evidence/db.js";
import type { AgentName } from "../shared/types.js";
import {
  type JournalAppend,
  type JournalRow,
  appendEntry,
  readByFiles,
  readByProject,
  supersede,
} from "./journal-store.js";
import { selectBriefingPulls } from "./router.js";

const NOW = "2026-07-05T00:00:00.000Z";
const FILE = "src/memory/router.ts";
const savedDebug = process.env.ZER0_DEBUG;
let tempRoot: string | undefined;

beforeEach(() => {
  process.env.ZER0_DEBUG = "0"; // B2a-1: debug is on-by-default now; this suite's OFF baseline is explicit
});

afterEach(() => {
  if (savedDebug === undefined) delete process.env.ZER0_DEBUG;
  else process.env.ZER0_DEBUG = savedDebug;
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
    tempRoot = undefined;
  }
});

function freshDb(): Db {
  tempRoot = mkdtempSync(join(tmpdir(), "zer0-router-"));
  return openMemoryDb(join(tempRoot, "evidence.db"));
}

function seedProject(db: Db, projectId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO projects (project_id, canonical_root, git_common_dir, created_at) VALUES (?, ?, ?, ?)",
  ).run(projectId, `/repo/${projectId}`, `/repo/${projectId}/.git`, NOW);
}

function seed(db: Db, projectId: string, patch: Partial<JournalAppend>): JournalRow {
  return seedEntry(db, {
    projectId,
    category: "decision",
    author: "agent",
    agent: "claude",
    body: "body",
    createdAt: NOW,
    ...patch,
  });
}

function seedEntry(db: Db, entry: JournalAppend): JournalRow {
  const entryId = appendEntry(db, entry);
  const row = readByProject(db, entry.projectId, { includeSuperseded: true }).find(
    (candidate) => candidate.entryId === entryId,
  );
  if (row === undefined) throw new Error(`missing seeded row ${entryId}`);
  return row;
}

it("Style what claude built", () => {
  const db = freshDb();
  try {
    seedProject(db, "p1");
    const decision = seed(db, "p1", { body: "style claude work", touchedFiles: [FILE] });
    const scratch = seed(db, "p1", { category: "scratch", body: "scratch", touchedFiles: [FILE] });
    const summary = seed(db, "p1", { category: "summary", body: "summary without files" });
    const ledger = seedEntry(db, {
      projectId: "p1",
      category: "decision",
      author: "ledger",
      body: "ledger decision",
      createdAt: NOW,
      touchedFiles: [FILE],
    });
    const invalid = seed(db, "p1", { agent: "gpt", body: "invalid agent", touchedFiles: [FILE] });
    const pulls = selectBriefingPulls({
      db,
      projectId: "p1",
      forAgent: "gemini",
      requestFiles: [FILE],
    });
    // W3 (MT6a-completion): ledger-authored decisions are pullable as sourceAgent "ledger";
    // newest-first keeps the later-seeded ledger row ahead of claude's decision.
    expect(pulls).toEqual([
      { entry: ledger, sourceAgent: "ledger" },
      { entry: decision, sourceAgent: "claude" },
    ]);
    expect(pulls.map((p) => p.entry.entryId)).not.toContain(scratch.entryId);
    expect(pulls.map((p) => p.entry.entryId)).not.toContain(summary.entryId);
    expect(pulls.map((p) => p.entry.entryId)).not.toContain(invalid.entryId);
  } finally {
    closeDb(db);
  }
});

it("excludes decisions authored by the composing agent", () => {
  const db = freshDb();
  try {
    seedProject(db, "p1");
    const own = seed(db, "p1", { agent: "gemini", body: "own work", touchedFiles: [FILE] });
    const pulls = selectBriefingPulls({
      db,
      projectId: "p1",
      forAgent: "gemini",
      requestFiles: [FILE],
    });
    expect(pulls.map((p) => p.entry.entryId)).not.toContain(own.entryId);
    expect(pulls).toEqual([]);
  } finally {
    closeDb(db);
  }
});

it("a ledger row carrying an agent name pulls as LEDGER (never masquerades); operator rows never pull", () => {
  const db = freshDb();
  try {
    seedProject(db, "p1");
    const ledger = seed(db, "p1", {
      author: "ledger",
      agent: "claude",
      body: "ledger masquerade",
      touchedFiles: [FILE],
    });
    const operator = seed(db, "p1", {
      author: "operator",
      agent: "claude",
      body: "operator masquerade",
      touchedFiles: [FILE],
    });
    const pulls = selectBriefingPulls({
      db,
      projectId: "p1",
      forAgent: "gemini",
      requestFiles: [FILE],
    });
    // The masquerade invariant survives W3: authorship decides the source; the agent column on a
    // ledger row is IGNORED for attribution. Operator-authored rows remain non-pullable entirely.
    expect(pulls).toEqual([{ entry: { ...ledger, agent: "claude" }, sourceAgent: "ledger" }]);
    expect(pulls.map((p) => p.entry.entryId)).not.toContain(operator.entryId);
  } finally {
    closeDb(db);
  }
});

it("caps matching pulls and returns newest first", () => {
  const db = freshDb();
  try {
    seedProject(db, "p1");
    const rows = Array.from({ length: 5 }, (_, index) =>
      seed(db, "p1", { body: `decision ${index}`, touchedFiles: [FILE] }),
    );
    const pulls = selectBriefingPulls({
      db,
      projectId: "p1",
      forAgent: "gemini",
      requestFiles: [FILE],
      limit: 3,
    });
    expect(pulls.map((p) => p.entry.entryId)).toEqual(
      rows
        .slice(-3)
        .reverse()
        .map((row) => row.entryId),
    );
  } finally {
    closeDb(db);
  }
});

it("keeps project pulls isolated to the requested project", () => {
  const db = freshDb();
  try {
    seedProject(db, "pA");
    seedProject(db, "pB");
    const projectA = seed(db, "pA", { body: "A", touchedFiles: [FILE] });
    const projectB = seed(db, "pB", { body: "B", touchedFiles: [FILE] });
    const pulls = selectBriefingPulls({
      db,
      projectId: "pA",
      forAgent: "gemini",
      requestFiles: [FILE],
    });
    expect(pulls.map((p) => p.entry.entryId)).toEqual([projectA.entryId]);
    expect(pulls.map((p) => p.entry.entryId)).not.toContain(projectB.entryId);
  } finally {
    closeDb(db);
  }
});

it("returns empty for no file intersection and ignores decisions with no touched files", () => {
  const db = freshDb();
  try {
    seedProject(db, "p1");
    const noFiles = seed(db, "p1", { body: "no files" });
    seed(db, "p1", { body: "other file", touchedFiles: ["src/other.ts"] });
    const pulls = selectBriefingPulls({
      db,
      projectId: "p1",
      forAgent: "gemini",
      requestFiles: [FILE],
    });
    expect(noFiles.touchedFiles).toBeNull();
    expect(pulls).toEqual([]);
  } finally {
    closeDb(db);
  }
});

it("M4: a fact older than 5,000 newer active rows is still pulled for its exact file (horizon killer)", () => {
  const db = freshDb();
  try {
    seedProject(db, "p1");
    // The old fact lands FIRST (seq 1); 5,000 newer active rows then push it past readByProject's
    // RECENCY_HORIZON window. Fillers are scratch rows without touched_files: they occupy seq space only.
    const fact = seed(db, "p1", { body: "old decision about a.ts", touchedFiles: ["src/a.ts"] });
    const filler = db.prepare(
      "INSERT INTO journal_entries " +
        "(entry_id, project_id, category, author, body, anchor, superseded_by, seq, created_at) " +
        "VALUES (?, 'p1', 'scratch', 'ledger', 'filler', 0, NULL, ?, ?)",
    );
    const fillMany = db.transaction(() => {
      for (let seq = 2; seq <= 5_001; seq += 1) {
        filler.run(`filler${seq}`, seq, NOW);
      }
    });
    fillMany();
    const pulls = selectBriefingPulls({
      db,
      projectId: "p1",
      forAgent: "gemini",
      requestFiles: ["src/a.ts"],
    });
    expect(pulls.map((p) => p.entry.entryId)).toEqual([fact.entryId]);
  } finally {
    closeDb(db);
  }
});

it("emits one briefing trace when debug is on and zero events when off", () => {
  const db = freshDb();
  try {
    seedProject(db, "p1");
    seed(db, "p1", { body: "traceable", touchedFiles: [FILE] });
    const off: ChatEvent[] = [];
    selectBriefingPulls({
      db,
      projectId: "p1",
      forAgent: "gemini",
      requestFiles: [FILE],
      trace: { emit: (e) => off.push(e) },
    });
    expect(off).toEqual([]);
    process.env.ZER0_DEBUG = "1";
    const on: ChatEvent[] = [];
    selectBriefingPulls({
      db,
      projectId: "p1",
      forAgent: "gemini",
      requestFiles: [FILE],
      trace: { emit: (e) => on.push(e) },
    });
    expect(on).toHaveLength(1);
    expect(on[0]).toMatchObject({ kind: "memory.trace", phase: "briefing", turn: 0 });
    expect((on[0] as { detail?: string }).detail).toBe("router selected=1");
  } finally {
    closeDb(db);
  }
});

it("M4 r2 (F5): a superseded decision never reaches a briefing pull for its own file", () => {
  const db = freshDb();
  try {
    seedProject(db, "p1");
    const retired = seed(db, "p1", {
      body: "RETIRED: we will use library X",
      touchedFiles: ["src/a.ts"],
    });
    const current = seed(db, "p1", {
      agent: "codex",
      body: "we use library Y",
      touchedFiles: ["src/a.ts"],
    });
    expect(supersede(db, retired.entryId, current.entryId)).toEqual({ ok: true });
    // The public seam an agent's briefing is actually built from. Supersession is excluded once, in the
    // store query; this asserts the guarantee where it is CONSUMED, not where it is implemented.
    const pulls = selectBriefingPulls({
      db,
      projectId: "p1",
      forAgent: "gemini",
      requestFiles: ["src/a.ts"],
    });
    expect(pulls.map((p) => p.entry.body)).toEqual(["we use library Y"]);
    expect(pulls.map((p) => p.entry.entryId)).not.toContain(retired.entryId);
  } finally {
    closeDb(db);
  }
});

it("M4 r2 (F7): one hot file key is BOUNDED — 20,000 matches cap out, the 8 newest still pull", () => {
  const db = freshDb();
  try {
    seedProject(db, "p1");
    // 20,000 active decisions all touching one file: the shape a central module reaches in a long-lived
    // project. Raw INSERTs in one transaction — the v21 trigger does the projection either way.
    const insert = db.prepare(
      "INSERT INTO journal_entries " +
        "(entry_id, project_id, category, author, agent, body, touched_files, anchor, superseded_by, seq, created_at) " +
        "VALUES (?, 'p1', 'decision', 'agent', 'claude', ?, ?, 0, NULL, ?, ?)",
    );
    const touched = JSON.stringify(["src/hot.ts"]);
    db.transaction(() => {
      for (let seq = 1; seq <= 20_000; seq += 1) {
        insert.run(`hot${seq}`, `decision ${seq}`, touched, seq, NOW);
      }
    })();
    const rows = readByFiles(db, "p1", new Set(["src/hot.ts"]));
    // Unbounded, this returned all 20,000 JournalRow objects (28.9 MB of heap) to produce 8 pulls. The
    // literal is MAX_FILE_MATCH_ROWS: raising the cap has to break this test, not slip through.
    expect(rows).toHaveLength(5_000);
    // The cap cuts the OLDEST matches, never the newest — that is the whole reason it is safe.
    expect(rows[0]?.seq).toBe(20_000);
    expect(rows.at(-1)?.seq).toBe(15_001);
    const pulls = selectBriefingPulls({
      db,
      projectId: "p1",
      forAgent: "gemini",
      requestFiles: ["src/hot.ts"],
    });
    expect(pulls.map((p) => p.entry.seq)).toEqual(Array.from({ length: 8 }, (_, i) => 20_000 - i));
  } finally {
    closeDb(db);
  }
});

// ---------------------------------------------------------------------------------------------------
// M4 r2 (F8) — acceptance 4: old path vs new path, row for row.
// The OLD file-pull path is reconstructed here VERBATIM from `git show 30babe0:src/memory/router.ts`
// (:37-41 the pipeline, :53-67 isCandidate, :73-78 hasRequestedFile). It lives only in this test — the
// production copy was deleted with the scan, and the contract asked for a comparison, not a survivor.
// ---------------------------------------------------------------------------------------------------
const PARITY_A = "src/alpha.ts";
const PARITY_B = "src/beta.ts";
const PARITY_C = "src/gamma.ts";
const OLD_RECENCY_HORIZON = 5_000;
const OLD_PULL_CATEGORIES = new Set<string>(["decision", "summary"]);
const OLD_AGENT_NAMES = new Set<string>(["claude", "codex", "gemini"]);

function oldIsCandidate(row: JournalRow, forAgent: string): boolean {
  if (
    !OLD_PULL_CATEGORIES.has(row.category) ||
    row.touchedFiles === null ||
    row.touchedFiles.length === 0
  ) {
    return false;
  }
  if (row.author === "agent") {
    return row.agent !== null && OLD_AGENT_NAMES.has(row.agent) && row.agent !== forAgent;
  }
  return row.author === "ledger";
}

function oldHasRequestedFile(row: JournalRow, requestFiles: ReadonlySet<string>): boolean {
  if (row.touchedFiles === null || requestFiles.size === 0) {
    return false;
  }
  return row.touchedFiles.some((file) => requestFiles.has(file));
}

function oldPullIds(
  db: Db,
  forAgent: string,
  requestFiles: readonly string[],
  limit: number,
): string[] {
  const wanted = new Set(requestFiles);
  return readByProject(db, "p1", { limit: OLD_RECENCY_HORIZON })
    .filter((row) => oldIsCandidate(row, forAgent))
    .filter((row) => oldHasRequestedFile(row, wanted))
    .slice(0, limit)
    .map((row) => row.entryId);
}

// Every axis both paths decide on: categories, authors, valid and invalid agent names, a row with no
// files, rows on an unrequested file, one entry touching TWO requested keys (the dedupe case), and a
// superseded/superseder pair. Small enough to sit INSIDE the old 5,000-row horizon, so both paths can
// see all of it — the point of this test is semantics, not the horizon (that is the killer test above).
const PARITY_CORPUS: readonly Partial<JournalAppend>[] = [
  { body: "claude on alpha", touchedFiles: [PARITY_A] },
  { agent: "gemini", body: "gemini on alpha (own row for gemini)", touchedFiles: [PARITY_A] },
  { author: "ledger", body: "ledger on alpha", touchedFiles: [PARITY_A] },
  { author: "operator", body: "operator on alpha", touchedFiles: [PARITY_A] },
  {
    agent: "codex",
    category: "summary",
    body: "codex summary on alpha+beta",
    touchedFiles: [PARITY_A, PARITY_B],
  },
  { agent: "gpt", body: "invalid agent name on alpha", touchedFiles: [PARITY_A] },
  { category: "scratch", body: "scratch on alpha", touchedFiles: [PARITY_A] },
  { agent: "codex", body: "codex on gamma (never requested)", touchedFiles: [PARITY_C] },
  { body: "claude with no files at all" },
  { body: "claude on beta", touchedFiles: [PARITY_B] },
  { agent: "codex", body: "codex on alpha, later retired", touchedFiles: [PARITY_A] },
  { body: "claude on alpha, the replacement", touchedFiles: [PARITY_A] },
  {
    author: "ledger",
    category: "summary",
    body: "ledger summary on beta",
    touchedFiles: [PARITY_B],
  },
  {
    agent: "gemini",
    category: "summary",
    body: "gemini summary on beta",
    touchedFiles: [PARITY_B],
  },
  { agent: "codex", body: "codex on alpha 1", touchedFiles: [PARITY_A] },
  { agent: "codex", body: "codex on alpha 2", touchedFiles: [PARITY_A] },
  { agent: "codex", body: "codex on alpha 3", touchedFiles: [PARITY_A] },
  { agent: "codex", body: "codex on alpha 4", touchedFiles: [PARITY_A] },
  { agent: "codex", body: "codex on alpha 5", touchedFiles: [PARITY_A] },
];

// forAgent x requested keys x limit — the axes that change which rows survive. Both paths run every one.
const PARITY_CASES: readonly (readonly [AgentName, readonly string[], number])[] = [
  ["gemini", [PARITY_A], 50],
  ["gemini", [PARITY_A, PARITY_B], 50],
  ["gemini", [PARITY_A, PARITY_B], 8],
  ["claude", [PARITY_A], 50],
  ["codex", [PARITY_A, PARITY_B, PARITY_C], 50],
];

function seedParityCorpus(db: Db): JournalRow[] {
  seedProject(db, "p1");
  const rows = PARITY_CORPUS.map((patch) => seed(db, "p1", patch));
  const retired = rows[10];
  const replacement = rows[11];
  if (retired === undefined || replacement === undefined) throw new Error("parity corpus shrank");
  expect(supersede(db, retired.entryId, replacement.entryId)).toEqual({ ok: true });
  return rows;
}

it("M4 r2 (F8): the NEW file-pull path returns the OLD path's pulls, same rows, same order", () => {
  const db = freshDb();
  try {
    const rows = seedParityCorpus(db);
    for (const [forAgent, requestFiles, limit] of PARITY_CASES) {
      const fresh = selectBriefingPulls({ db, projectId: "p1", forAgent, requestFiles, limit }).map(
        (p) => p.entry.entryId,
      );
      const legacy = oldPullIds(db, forAgent, requestFiles, limit);
      expect(legacy.length).toBeGreaterThan(0); // the comparison is not vacuously equal-empty
      expect(fresh).toEqual(legacy);
    }
    // The dedupe case, stated on its own: an entry touching BOTH requested keys is pulled ONCE. The old
    // path could not double-count it (one row in, one row out); the projection returns one row per key.
    const multiKey = rows[4];
    if (multiKey === undefined) throw new Error("parity corpus shrank");
    const ids = selectBriefingPulls({
      db,
      projectId: "p1",
      forAgent: "gemini",
      requestFiles: [PARITY_A, PARITY_B],
      limit: 50,
    }).map((p) => p.entry.entryId);
    expect(ids.filter((id) => id === multiKey.entryId)).toEqual([multiKey.entryId]);
  } finally {
    closeDb(db);
  }
});
