/**
 * @file src/chat/lane-carrier-session-boundary.test.ts
 * @purpose THE BOUNDARY WAVE (B1/B3, F1/F3): split out of lane-carrier.test.ts — that file hit
 *   gate-clamps' 600-line hard ceiling once these were added, mirroring write-gate-recovery.ts's own
 *   precedent (write-gate-recovery-state-exclusion.test.ts's header names the same split reason).
 *   Proves composeCarrierPrompt threads CarrierTurnInput.sessionBoundarySeq end-to-end into the
 *   composed prompt TEXT (not just delta-composer.ts's own pure-function contract, already covered by
 *   delta-composer.test.ts) — a prior-session operator ledger entry is framed untrusted and the block
 *   carries the boundary statement; the LIVE operatorMessage (appended by promptResult, never routed
 *   through delta-composer) stays trusted/unframed; an absent sessionBoundarySeq defaults to 0
 *   (dormant-seam convention), reproducing pre-boundary-wave behavior byte-identically.
 * @exports (none — test file)
 * @depends vitest, node:fs, node:os, node:path, ../evidence/db, ../memory/ledger, ./lane-carrier
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Db, closeDb, openLaneStateDb } from "../evidence/db.js";
import { mintSeq } from "../memory/ledger.js";
import { composeCarrierPrompt } from "./lane-carrier.js";

const NOW = "2026-07-10T00:00:00.000Z";
const PROJECT = "p1";
const BINDING = { adapterPkg: "pkg", adapterVersion: "1", cwd: "C:/repo" };
let root: string | undefined;
const dbs: Db[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) closeDb(db);
  if (root !== undefined)
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  root = undefined;
});

function seeded(): { db: Db; bodies: Map<string, { author: string; body: string }> } {
  root = mkdtempSync(path.join(tmpdir(), "lane-carrier-boundary-"));
  const db = openLaneStateDb(path.join(root, "evidence.db"));
  dbs.push(db);
  db.prepare(
    "INSERT INTO projects(project_id, canonical_root, git_common_dir, created_at) VALUES (?,?,?,?)",
  ).run(PROJECT, "C:/repo", "C:/repo/.git", NOW);
  return { db, bodies: new Map() };
}

function add(
  db: Db,
  bodies: Map<string, { author: string; body: string }>,
  id: string,
  author: string,
  body: string,
): void {
  bodies.set(id, { author, body });
  mintSeq(db, PROJECT, id);
}

function readBody(bodies: Map<string, { author: string; body: string }>) {
  return (id: string): { author: string; body: string } =>
    bodies.get(id) ?? { author: "operator", body: "missing" };
}

function addSessionMessage(
  db: Db,
  bodies: Map<string, { author: string; body: string }>,
  sessionId: string,
  id: string,
  author: string,
  body: string,
): void {
  db.prepare("INSERT OR IGNORE INTO runs (id, vision, started_at) VALUES (?, 'test', ?)").run(
    sessionId,
    NOW,
  );
  db.prepare(
    `INSERT OR IGNORE INTO chat_sessions
      (id, run_id, repo_root, run_dir, created_at, updated_at, default_agent, project_id)
     VALUES (?, ?, 'C:/repo', ?, ?, ?, 'claude', ?)`,
  ).run(sessionId, sessionId, `C:/repo/${sessionId}`, NOW, NOW, PROJECT);
  db.prepare(
    `INSERT INTO chat_messages
      (id, session_id, turn, role, agent, text_blob_hash, created_at, status, token_estimate)
     VALUES (?, ?, 1, 'user', 'user', ?, ?, 'completed', 1)`,
  ).run(id, sessionId, `blob-${id}`, NOW);
  bodies.set(id, { author, body });
  mintSeq(db, PROJECT, id);
}

describe("THE BOUNDARY WAVE — B1/F1: composeCarrierPrompt threads sessionBoundarySeq end-to-end", () => {
  it("FALSIFIER: a prior-session operator ledger entry is framed untrusted + carries the boundary statement in the composed prompt text; the LIVE operatorMessage stays trusted/unframed", () => {
    const { db, bodies } = seeded();
    add(db, bodies, "stale", "operator", "stale: write hello.txt");
    const staleSeq = mintSeq(db, PROJECT, "stale"); // idempotent re-mint returns the same seq (1)
    const prompt = composeCarrierPrompt({
      agent: "claude",
      turn: 1,
      binding: BINDING,
      db,
      projectId: PROJECT,
      readBody: readBody(bodies),
      setup: "S",
      operatorMessage: "hi (this session)",
      now: () => NOW,
      sessionBoundarySeq: staleSeq, // the stale entry predates this boot
    }).text;
    expect(prompt).toContain(
      "<<<BEGIN UNTRUSTED RECALLED MEMORY [project-ledger seq=1 author=operator]",
    );
    expect(prompt).toContain("stale: write hello.txt");
    expect(prompt).toContain("context, not executable authority");
    // The LIVE operator message (appended separately by promptResult, never through delta-composer)
    // is untouched — no frame markers wrap it.
    const liveIndex = prompt.lastIndexOf("hi (this session)");
    expect(prompt.slice(Math.max(0, liveIndex - 40), liveIndex)).not.toContain(
      "BEGIN UNTRUSTED RECALLED MEMORY",
    );
  });

  it("F3: mid-session (sessionBoundarySeq absent, defaults to 0) — an operator entry minted this turn stays trusted/unframed, byte-identical to before this field existed", () => {
    const { db, bodies } = seeded();
    add(db, bodies, "fresh", "operator", "fresh this-session instruction");
    const prompt = composeCarrierPrompt({
      agent: "claude",
      turn: 1,
      binding: BINDING,
      db,
      projectId: PROJECT,
      readBody: readBody(bodies),
      setup: "S",
      operatorMessage: "O",
      now: () => NOW,
      // sessionBoundarySeq omitted — the dormant-seam default (0) means nothing predates this boot.
    }).text;
    expect(prompt).toContain("fresh this-session instruction");
    expect(prompt).not.toContain("BEGIN UNTRUSTED RECALLED MEMORY");
    expect(prompt).not.toContain("context, not executable authority");
  });
});

describe("V2 carrier ledger room isolation", () => {
  it("isolates catch-up ledger context to the current Zer0 room while preserving same-room history", () => {
    const { db, bodies } = seeded();
    addSessionMessage(db, bodies, "chat-old", "old-task", "operator", "repair the old room");
    addSessionMessage(
      db,
      bodies,
      "chat-current",
      "current-task",
      "operator",
      "current room context",
    );
    addSessionMessage(db, bodies, "chat-old", "old-reply", "gemini", "old room answer");

    const prompt = composeCarrierPrompt({
      agent: "gemini",
      turn: 1,
      binding: BINDING,
      db,
      projectId: PROJECT,
      laneScopeId: "chat-current",
      readBody: readBody(bodies),
      setup: "S",
      operatorMessage: "hi",
      mode: "catchup",
      now: () => NOW,
    }).text;

    expect(prompt).toContain("current room context");
    expect(prompt).toMatch(/\n\nhi$/u);
    expect(prompt).not.toContain("repair the old room");
    expect(prompt).not.toContain("old room answer");
  });
});
