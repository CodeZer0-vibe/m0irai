// Digest ATTRIBUTION (M3): a decision's validated speaker rides from the extraction onto
// journal_entries.agent (author stays "ledger"); a speaker that is not an AGENT SEAT present in the
// digested transcript (an invented name, or a non-seat label like "user"/"all"/"system") is NEVER
// written — the fact lands agent:null and the pass outcome counts it (oracle §3 "a row without
// attribution fails the write path"); the summary fact stays unattributed (a synthesis across
// speakers, not one agent's claim). M3 is DATA-ONLY: today NO production reader consumes the agent
// column for ledger-authored rows, so oracle §4 loud-on-corruption does NOT hold for these rows and
// is DEFERRED to the attribution reader (pinned honestly in the file's last test).
// Real fs transcript + real sqlite; the extractor CLI is a fake. Top-level it(), small callbacks.
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { ChatEvent } from "../chat/events.js";
import type { ChatMessage } from "../chat/types.js";
import { type Db, closeDb, openMemoryDb } from "../evidence/db.js";
import { composeBriefing } from "./briefing.js";
import { type DigestDispatch, buildExtractionPrompt } from "./digest-extractor.js";
import { type DigestDeps, runDigestPass } from "./digest.js";
import { appendEntry } from "./journal-store.js";

const NOW = "2026-08-22T00:00:00.000Z";
let tempRoot: string | undefined;
const savedDebug = process.env.ZER0_DEBUG;

beforeEach(() => {
  process.env.ZER0_DEBUG = "0"; // the OFF baseline, as in digest.test.ts; traces opt in per test
});

afterEach(() => {
  if (savedDebug === undefined) delete process.env.ZER0_DEBUG;
  else process.env.ZER0_DEBUG = savedDebug;
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

function freshRepo(): { db: Db; repoRoot: string } {
  tempRoot = mkdtempSync(join(tmpdir(), "zer0-digest-attribution-"));
  const db = openMemoryDb(join(tempRoot, "evidence.db"));
  db.prepare(
    "INSERT OR IGNORE INTO projects (project_id, canonical_root, git_common_dir, created_at) VALUES (?, ?, ?, ?)",
  ).run("p1", tempRoot, `${tempRoot}/.git`, NOW);
  return { db, repoRoot: tempRoot };
}

function msg(
  id: string,
  agent: ChatMessage["agent"],
  text: string,
  role: ChatMessage["role"] = "agent",
): ChatMessage {
  return {
    id,
    turn: 1,
    role,
    agent,
    text,
    createdAt: NOW,
    status: "completed",
    tokenEstimate: 5,
  };
}

async function writeTranscript(
  repoRoot: string,
  sessionId: `chat-${string}`,
  messages: readonly ChatMessage[],
): Promise<void> {
  const runDir = join(repoRoot, ".council", "runs", sessionId);
  await mkdir(runDir, { recursive: true });
  const session = {
    id: sessionId,
    repoRoot,
    runDir,
    createdAt: NOW,
    updatedAt: NOW,
    defaultAgent: "claude",
    lastAgent: "claude",
    summary: { text: "", throughTurn: 0 },
    messages,
  };
  await writeFile(join(runDir, "transcript.json"), JSON.stringify(session), "utf8");
}

function baseDeps(db: Db, repoRoot: string, dispatch: DigestDispatch): DigestDeps {
  return { db, sessionId: "chat-1", repoRoot, projectId: "p1", dispatch, now: NOW };
}

// A well-formed extraction that attributes each decision to its real speaker (both spoke in the
// transcript below) — the shape the prompt now demands.
const ATTRIBUTED_DISPATCH: DigestDispatch = async () =>
  JSON.stringify({
    decisions: [
      { topic: "transport", body: "the room bus uses websocket", agent: "claude" },
      { topic: "wire-format", body: "room events stay newline-delimited json", agent: "codex" },
    ],
    summary: "transport and wire format settled",
  });

// An extraction naming EACH of the transcript labels in the non-agent-labels test below (two seats would
// be enough for the seat path; naming all four is what used to slip user/all/system past the gate).
const EACH_LABEL_DISPATCH: DigestDispatch = async () =>
  JSON.stringify({
    decisions: [
      { topic: "t-user", body: "operator asked for transport", agent: "user" },
      { topic: "t-all", body: "the room was addressed", agent: "all" },
      { topic: "t-system", body: "the session opened", agent: "system" },
      { topic: "transport", body: "the room bus uses websocket", agent: "claude" },
    ],
    summary: "transport settled",
  });

/** Whether some pass-trace event's detail carries `unattributed=<n>` (the digest summary line). */
function hasTracedUnattributed(events: readonly ChatEvent[], n: number): boolean {
  return events.some(
    (e) =>
      e.kind === "memory.trace" && (e as { detail?: string }).detail?.includes(`unattributed=${n}`),
  );
}

it("attribution lands on the rows: two speakers + an attributed extraction -> decision rows carry agent=claude/codex with author=ledger", async () => {
  const { db, repoRoot } = freshRepo();
  try {
    await writeTranscript(repoRoot, "chat-1", [
      msg("m1", "claude", "we chose websocket for the bus"),
      msg("m2", "codex", "room events stay newline-delimited json"),
    ]);
    const outcome = await runDigestPass(baseDeps(db, repoRoot, ATTRIBUTED_DISPATCH));
    expect(outcome.ok).toBe(true);
    const rows = db
      .prepare(
        "SELECT author, agent, category, body FROM journal_entries WHERE category = 'decision' ORDER BY seq",
      )
      .all();
    expect(rows).toEqual([
      {
        author: "ledger",
        agent: "claude",
        category: "decision",
        body: "the room bus uses websocket",
      },
      {
        author: "ledger",
        agent: "codex",
        category: "decision",
        body: "room events stay newline-delimited json",
      },
    ]);
  } finally {
    closeDb(db);
  }
});

it("an OUT-OF-SET speaker is never written: the fact lands agent=null, the outcome counts one unattributed, and the trace records it", async () => {
  const { db, repoRoot } = freshRepo();
  try {
    // gemini NEVER speaks this session — attributing to it is the invented-attribution failure.
    await writeTranscript(repoRoot, "chat-1", [msg("m1", "claude", "we chose websocket")]);
    const invented: DigestDispatch = async () =>
      JSON.stringify({
        decisions: [{ topic: "transport", body: "the room bus uses websocket", agent: "gemini" }],
        summary: "transport settled",
      });
    const events: ChatEvent[] = [];
    process.env.ZER0_DEBUG = "1";
    const outcome = await runDigestPass({
      ...baseDeps(db, repoRoot, invented),
      trace: { emit: (e) => events.push(e) },
    });
    expect(outcome).toEqual({ ok: true, digested: 1, unattributed: 1 });
    // The invalid name is NOT written — today's agent:null fallback, never guessed.
    const agents = db
      .prepare("SELECT DISTINCT agent FROM journal_entries WHERE category = 'decision'")
      .all();
    expect(agents).toEqual([{ agent: null }]);
    expect(
      (
        db.prepare("SELECT COUNT(*) AS c FROM journal_entries WHERE agent = 'gemini'").get() as {
          c: number;
        }
      ).c,
    ).toBe(0);
    expect(hasTracedUnattributed(events, 1)).toBe(true);
  } finally {
    closeDb(db);
  }
});

it("a MISSING agent is the deliberate fallback: the row still lands (author ledger, agent null) and is counted", async () => {
  const { db, repoRoot } = freshRepo();
  try {
    await writeTranscript(repoRoot, "chat-1", [msg("m1", "claude", "we chose websocket")]);
    const unlabelled: DigestDispatch = async () =>
      JSON.stringify({
        decisions: [{ topic: "transport", body: "the room bus uses websocket" }],
        summary: "transport settled",
      });
    const outcome = await runDigestPass(baseDeps(db, repoRoot, unlabelled));
    expect(outcome).toEqual({ ok: true, digested: 1, unattributed: 1 });
    expect(
      db.prepare("SELECT author, agent FROM journal_entries WHERE category = 'decision'").get(),
    ).toEqual({ author: "ledger", agent: null });
  } finally {
    closeDb(db);
  }
});

// A transcript label that is NOT an agent seat — "user" (the operator's messages), "all" (the ADDRESS of a
// fan-out, no speaker at all), "system" (a role) — is legal ChatAgent but is attribution to NOBODY. Only
// labels in the repo's AgentName set (AgentNameSchema) are agent seats; anything else takes today's
// agent:null + counted + traced fallback exactly like an invented name (r1 finding 2).
it("NON-AGENT labels (user/all/system) are never attributions: rows land agent=null, counted + traced; only the agent seat keeps its name", async () => {
  const { db, repoRoot } = freshRepo();
  try {
    const messages: readonly ChatMessage[] = [
      msg("m1", "user", "please pick the bus transport", "user"),
      msg("m2", "all", "fan-out request for the room", "user"),
      msg("m3", "system", "session opened", "system"),
      msg("m4", "claude", "we chose websocket"),
    ];
    await writeTranscript(repoRoot, "chat-1", messages);
    const events: ChatEvent[] = [];
    process.env.ZER0_DEBUG = "1";
    const outcome = await runDigestPass({
      ...baseDeps(db, repoRoot, EACH_LABEL_DISPATCH),
      trace: { emit: (e) => events.push(e) },
    });
    expect(outcome).toEqual({ ok: true, digested: 4, unattributed: 3 });
    const rows = db
      .prepare(
        "SELECT topic_key, author, agent FROM journal_entries WHERE category = 'decision' ORDER BY seq",
      )
      .all();
    expect(rows).toEqual([
      { topic_key: "t-user", author: "ledger", agent: null },
      { topic_key: "t-all", author: "ledger", agent: null },
      { topic_key: "t-system", author: "ledger", agent: null },
      { topic_key: "transport", author: "ledger", agent: "claude" },
    ]);
    expect(hasTracedUnattributed(events, 3)).toBe(true);
    // The prompt stops INVITING non-agent labels: it names ONLY the seat(s) present and forbids the rest.
    const prompt = buildExtractionPrompt(messages);
    expect(prompt).toContain("AGENT SPEAKERS (attribute ONLY to these): claude");
    expect(prompt).toContain('never attribute a decision to "user", "all" or "system"');
  } finally {
    closeDb(db);
  }
});

// CODEX r2 CONFIRMED cross-field forgery: ChatMessage carries role AND agent as INDEPENDENT fields
// (src/chat/types.ts:164-171 — role enum ["user","agent","system","error"]; agent enum CHAT_AGENTS includes
// all three seats), so a schema-valid USER-role message may legally name "claude". Seat discovery must read
// the ROLE (room-host.ts:498-499 writes every real lane reply as {role:"agent", agent:<seat>}) and THEN
// intersect with the seats; m.agent alone is forgeable by any tampered or legacy transcript row.
it("a USER-role message naming an agent seat establishes NO speaker: claims degrade to agent:null + counted (codex r2)", async () => {
  const { db, repoRoot } = freshRepo();
  try {
    // NO role:"agent" turn exists in this transcript: whatever its agent field says, no agent spoke.
    await writeTranscript(repoRoot, "chat-1", [
      msg("m1", "claude", "please pick the bus transport", "user"),
    ]);
    const events: ChatEvent[] = [];
    process.env.ZER0_DEBUG = "1";
    const outcome = await runDigestPass({
      ...baseDeps(db, repoRoot, ATTRIBUTED_DISPATCH),
      trace: { emit: (e) => events.push(e) },
    });
    // BOTH decisions of ATTRIBUTED_DISPATCH (the claude AND the codex claim) take the counted fallback.
    expect(outcome).toEqual({ ok: true, digested: 1, unattributed: 2 });
    // No decision is written WITH a speaker — claude provenance sourced from a user turn is forgery.
    const agents = db
      .prepare("SELECT DISTINCT agent FROM journal_entries WHERE category = 'decision'")
      .all();
    expect(agents).toEqual([{ agent: null }]);
    expect(
      (
        db.prepare("SELECT COUNT(*) AS c FROM journal_entries WHERE agent = 'claude'").get() as {
          c: number;
        }
      ).c,
    ).toBe(0);
    expect(hasTracedUnattributed(events, 2)).toBe(true);
  } finally {
    closeDb(db);
  }
});

// CODEX r2 whole-pass failure: an explicit JSON "agent": null used to fail the WHOLE extraction as
// malformed-output (watermark unmoved, session retried forever) instead of taking the promised
// per-decision fallback. null settles exactly like a MISSING agent: row agent=null, counted, traced.
it("an EXPLICIT agent:null settles like a MISSING agent: the pass SUCCEEDS, the row lands agent=null and is counted", async () => {
  const { db, repoRoot } = freshRepo();
  try {
    await writeTranscript(repoRoot, "chat-1", [msg("m1", "claude", "we chose websocket")]);
    const nullAgent: DigestDispatch = async () =>
      JSON.stringify({
        decisions: [
          { topic: "transport", body: "the room bus uses websocket", agent: "claude" },
          { topic: "wire-format", body: "room events stay newline-delimited json", agent: null },
        ],
        summary: "transport settled",
      });
    const outcome = await runDigestPass(baseDeps(db, repoRoot, nullAgent));
    // The pass succeeds — the null-agent decision costs ONE unattributed count, not every decision.
    expect(outcome).toEqual({ ok: true, digested: 1, unattributed: 1 });
    const rows = db
      .prepare(
        "SELECT topic_key, author, agent FROM journal_entries WHERE category = 'decision' ORDER BY seq",
      )
      .all();
    expect(rows).toEqual([
      { topic_key: "transport", author: "ledger", agent: "claude" },
      { topic_key: "wire-format", author: "ledger", agent: null },
    ]);
  } finally {
    closeDb(db);
  }
});

it("the summary fact stays UNATTRIBUTED even when every decision carries its speaker (a synthesis has one author: the ledger)", async () => {
  const { db, repoRoot } = freshRepo();
  try {
    await writeTranscript(repoRoot, "chat-1", [
      msg("m1", "claude", "we chose websocket for the bus"),
      msg("m2", "codex", "room events stay newline-delimited json"),
    ]);
    const outcome = await runDigestPass(baseDeps(db, repoRoot, ATTRIBUTED_DISPATCH));
    expect(outcome.ok).toBe(true);
    expect(
      db
        .prepare("SELECT author, agent, body FROM journal_entries WHERE category = 'summary'")
        .get(),
    ).toEqual({ author: "ledger", agent: null, body: "transport and wire format settled" });
  } finally {
    closeDb(db);
  }
});

// Briefing sensitivity, stated EXACTLY: the agent column matters at briefing ONLY for OWN-category
// agent-authored rows (briefing.ts:172 filters OWN categories by row.agent; the per-agent row below
// uses category reasoning, a placement ONLY the Own-journal bucket renders). These are NOT the rows
// M3 writes — the digest's decisions are CORE ("decision", briefing.ts:51-57) with author "ledger",
// and today NO production reader consumes journal_entries.agent for ledger-authored rows (briefing's
// Own bucket needs an OWN category; authorLabel at briefing.ts:427-432 and router.ts:63-89 read the
// column only when author === "agent"). M3 lands the DATA; the reader is a follow-up (the memory
// tools wave / per-agent recall). The file's LAST test pins that no-reader truth explicitly.
it("briefing is sensitive to the agent column for OWN-category agent-authored rows — NOT the rows M3 writes (loud on corruption there)", () => {
  const { db } = freshRepo();
  try {
    appendEntry(db, {
      projectId: "p1",
      category: "reasoning",
      author: "agent",
      agent: "claude",
      body: "claude lane-local note about the bus",
      createdAt: NOW,
    });
    appendEntry(db, {
      projectId: "p1",
      category: "decision",
      author: "ledger",
      agent: "claude",
      body: "the room bus uses websocket",
      topicKey: "transport",
      createdAt: NOW,
    });
    const render = (agent: "claude" | "codex"): string =>
      composeBriefing({ db, projectId: "p1", agent, now: NOW }).text;

    // WITH attribution: claude's Own journal carries the row; codex sees neither it nor the bucket.
    const claudeWith = render("claude");
    expect(claudeWith).toContain("## Own journal");
    expect(claudeWith).toContain("claude lane-local note about the bus");
    expect(render("codex")).not.toContain("claude lane-local note about the bus");
    // The digest-shaped decision renders SHARED in both cores regardless of its agent column.
    expect(claudeWith).toContain("the room bus uses websocket");
    expect(render("codex")).toContain("the room bus uses websocket");

    // Corrupt attribution -> the per-agent path fails LOUDLY-distinguishable: the bucket empties.
    db.prepare("UPDATE journal_entries SET agent = NULL").run();
    const claudeCorrupted = render("claude");
    expect(claudeCorrupted).not.toContain("claude lane-local note about the bus");
    expect(claudeCorrupted).not.toContain("## Own journal");
    expect(claudeCorrupted).toContain("the room bus uses websocket"); // shared rendering unchanged
  } finally {
    closeDb(db);
  }
});

// ACCEPTANCE 5 IS DEFERRED — this pin states the current truth in executable form. For a row M3 actually
// writes (category "decision", author "ledger") NO production reader consumes journal_entries.agent:
// briefing's Own bucket needs an OWN category (briefing.ts:172) and authorLabel/router read the column
// only when author === "agent" (briefing.ts:427-432, router.ts:63-89). Corrupting the column therefore
// changes the rendered briefing by ZERO bytes, asserted here so nobody mistakes the test above for
// coverage of M3's rows: when the attribution reader lands (memory tools wave / per-agent recall) THIS
// assertion flips red, and whoever lands it knows exactly where to look.
it("HONEST PIN (acceptance 5 DEFERRED): corrupting an M3-written decision row's agent column changes the briefing by ZERO bytes — write-only data today", () => {
  const { db } = freshRepo();
  try {
    appendEntry(db, {
      projectId: "p1",
      category: "decision",
      author: "ledger",
      agent: "claude",
      body: "the room bus uses websocket",
      topicKey: "transport",
      createdAt: NOW,
    });
    const render = (): string =>
      composeBriefing({ db, projectId: "p1", agent: "claude", now: NOW }).text;
    const before = render();
    expect(before).toContain("the room bus uses websocket"); // anchored: the attributed row renders
    db.prepare("UPDATE journal_entries SET agent = NULL WHERE category = 'decision'").run();
    expect(render()).toBe(before); // byte-identical: NO reader yet — the flip point when one lands
  } finally {
    closeDb(db);
  }
});
