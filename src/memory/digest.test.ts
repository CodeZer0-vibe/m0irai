// digest pass: D3 watermark-set gap tolerance, split-truth (transcript authority + traced divergence), D4
// classified failure with watermark unmoved + retry, and the J3 verified-only map. Real fs transcript + real
// sqlite; the extractor CLI is a fake returning real output shapes the REAL zod parse validates. Top-level
// it() (no describe wrapper) to keep every callback under the 50-line clamp.
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { ChatEvent } from "../chat/events.js";
import type { ChatMessage } from "../chat/types.js";
import { type Db, closeDb, openMemoryDb } from "../evidence/db.js";
import type { DigestDispatch } from "./digest-extractor.js";
import { type DigestDeps, generateMapSection, runDigestPass } from "./digest.js";
import { readByProject } from "./journal-store.js";

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

function freshRepo(): { db: Db; repoRoot: string } {
  tempRoot = mkdtempSync(join(tmpdir(), "zer0-digest-"));
  const db = openMemoryDb(join(tempRoot, "evidence.db"));
  db.prepare(
    "INSERT OR IGNORE INTO projects (project_id, canonical_root, git_common_dir, created_at) VALUES (?, ?, ?, ?)",
  ).run("p1", tempRoot, `${tempRoot}/.git`, NOW);
  return { db, repoRoot: tempRoot };
}

function msg(id: string, status: ChatMessage["status"]): ChatMessage {
  return {
    id,
    turn: 1,
    role: "agent",
    agent: "claude",
    text: `text ${id}`,
    createdAt: NOW,
    status,
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

// M3: the transcript this suite digests speaks claude only, so the extractor names claude — an IN-SET
// speaker — and the outcomes below keep their exact {ok, digested} shape (no unattributed count).
const goodDispatch: DigestDispatch = async () =>
  JSON.stringify({
    decisions: [{ topic: "transport", body: "use websocket", agent: "claude" }],
    summary: "wired the bus",
  });
const missingTopicDispatch: DigestDispatch = async () =>
  JSON.stringify({ decisions: [{ body: "no topic slug" }], summary: "s" });

function watermark(db: Db): string[] {
  return (
    db.prepare("SELECT message_id FROM digest_watermark ORDER BY message_id").all() as {
      message_id: string;
    }[]
  ).map((r) => r.message_id);
}

function baseDeps(db: Db, repoRoot: string, dispatch: DigestDispatch): DigestDeps {
  return { db, sessionId: "chat-1", repoRoot, projectId: "p1", dispatch, now: NOW };
}

it("gap fixture: completed m1,m3 (failed m2) then late m4 → exactly m1,m3,m4 each once across 2 passes", async () => {
  const { db, repoRoot } = freshRepo();
  try {
    await writeTranscript(repoRoot, "chat-1", [
      msg("m1", "completed"),
      msg("m2", "failed"),
      msg("m3", "completed"),
    ]);
    const first = await runDigestPass(baseDeps(db, repoRoot, goodDispatch));
    expect(first).toEqual({ ok: true, digested: 2 });
    expect(watermark(db)).toEqual(["m1", "m3"]); // m2 failed → never processed

    await writeTranscript(repoRoot, "chat-1", [
      msg("m1", "completed"),
      msg("m2", "failed"),
      msg("m3", "completed"),
      msg("m4", "completed"),
    ]);
    const second = await runDigestPass(baseDeps(db, repoRoot, goodDispatch));
    expect(second).toEqual({ ok: true, digested: 1 }); // only the new m4
    expect(watermark(db)).toEqual(["m1", "m3", "m4"]);
  } finally {
    closeDb(db);
  }
});

it("split-truth: a completed message absent from the DB mirror is digested AND the divergence is traced", async () => {
  const { db, repoRoot } = freshRepo();
  try {
    await writeTranscript(repoRoot, "chat-1", [msg("ghost", "completed")]); // never inserted into chat_messages
    const events: ChatEvent[] = [];
    process.env.ZER0_DEBUG = "1";
    const outcome = await runDigestPass({
      ...baseDeps(db, repoRoot, goodDispatch),
      trace: { emit: (e) => events.push(e) },
    });
    expect(outcome).toEqual({ ok: true, digested: 1 }); // transcript is the authority
    expect(watermark(db)).toEqual(["ghost"]);
    const divergence = events.filter(
      (e) =>
        e.kind === "memory.trace" &&
        (e as { detail?: string }).detail?.includes("absent from DB mirror"),
    );
    expect(divergence).toHaveLength(1);
    expect((divergence[0] as { detail: string }).detail).toContain("ghost");
  } finally {
    closeDb(db);
  }
});

it("D4: a missing-topic extraction records a classified failure, leaves the watermark unmoved, and retries", async () => {
  const { db, repoRoot } = freshRepo();
  try {
    await writeTranscript(repoRoot, "chat-1", [msg("m1", "completed")]);
    const failed = await runDigestPass(baseDeps(db, repoRoot, missingTopicDispatch));
    expect(failed.ok).toBe(false);
    if (failed.ok) throw new Error("expected failure");
    expect(failed.classification).toBe("malformed-output");
    expect(watermark(db)).toEqual([]); // watermark UNMOVED → the message is still pending
    const failure = db
      .prepare("SELECT body FROM journal_entries WHERE category = 'scratch'")
      .get() as { body: string } | undefined;
    expect(failure?.body).toContain("[digest-failed]");

    // Retry with a good extractor → the same message is processed (the watermark advances now).
    const retried = await runDigestPass(baseDeps(db, repoRoot, goodDispatch));
    expect(retried).toEqual({ ok: true, digested: 1 });
    expect(watermark(db)).toEqual(["m1"]);
  } finally {
    closeDb(db);
  }
});

// Seeds three reconciled reports (verified / mismatch / claims-only 'submitted'). agent_reports.turn_id FKs
// agent_turns(turn_id, project_id); the turns are seeded with task_id NULL to skip the memory_tasks FK.
function seedReports(db: Db): void {
  const seedTurn = db.prepare(
    "INSERT INTO agent_turns (turn_id, project_id, agent, created_at) VALUES (?, ?, ?, ?)",
  );
  const insert = db.prepare(
    "INSERT INTO agent_reports (report_id, turn_id, project_id, agent, dispatch_id, claimed_json, raw_blob_hash, status, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const claimed = (files: string[], summary: string) =>
    JSON.stringify({ files_touched: files, summary });
  const rows: [string, string, string, string][] = [
    ["claude", claimed(["a.ts"], "did A"), "verified", "r1"],
    ["codex", claimed(["b.ts"], "claimed B"), "mismatch", "r2"],
    ["gemini", claimed(["c.ts"], "just claimed"), "submitted", "r3"],
  ];
  rows.forEach(([agent, cj, status, id], i) => {
    const turn = `t${i + 1}`;
    seedTurn.run(turn, "p1", agent, NOW);
    insert.run(id, turn, "p1", agent, `d${i + 1}`, cj, `h${i + 1}`, status, i + 1, NOW);
  });
}

it("J3 map: verified rows become facts, a mismatch surfaces as unverified, a claims-only row is excluded", () => {
  const { db } = freshRepo();
  try {
    seedReports(db);
    const map = generateMapSection(db, "p1");
    expect(map).toHaveLength(2); // the 'submitted' claims-only row is excluded
    expect(map.find((m) => m.agent === "claude")).toEqual({
      agent: "claude",
      files: ["a.ts"],
      summary: "did A",
      verified: true,
    });
    expect(map.find((m) => m.agent === "codex")).toEqual({
      agent: "codex",
      files: ["b.ts"],
      summary: "claimed B",
      verified: false,
    });
    expect(map.find((m) => m.agent === "gemini")).toBeUndefined();
  } finally {
    closeDb(db);
  }
});

it("TOCTOU: two racing passes that both pre-read an empty watermark commit the facts EXACTLY once (MT3d)", async () => {
  const { db, repoRoot } = freshRepo();
  try {
    await writeTranscript(repoRoot, "chat-1", [msg("m1", "completed")]);
    // Pass B reads the empty watermark + extracts, then (onBeforeWrite) lets pass A run to completion and
    // commit m1's facts + watermark. B then writes: under the in-tx re-read it must see m1 already digested and
    // write nothing — the journal holds m1's decision ONCE, not twice (fail-open makes redundancy harmless).
    let aDigested = -1;
    const bDeps: DigestDeps = {
      ...baseDeps(db, repoRoot, goodDispatch),
      onBeforeWrite: async () => {
        const a = await runDigestPass(baseDeps(db, repoRoot, goodDispatch));
        aDigested = a.ok ? a.digested : -1;
      },
    };
    const b = await runDigestPass(bDeps);

    const decisionCount = (
      db.prepare("SELECT COUNT(*) AS c FROM journal_entries WHERE category = 'decision'").get() as {
        c: number;
      }
    ).c;
    expect(decisionCount).toBe(1); // exactly-once facts — the TOCTOU must not double-append
    expect(watermark(db)).toEqual(["m1"]); // watermark holds m1 once
    expect(aDigested).toBe(1); // A (first committer) processed m1
    expect(b.ok).toBe(true);
    if (!b.ok) throw new Error("expected ok");
    expect(b.digested).toBe(0); // B re-read truth inside its tx and skipped
  } finally {
    closeDb(db);
  }
});

it("W1 (MT6a-completion): the summary fact carries the deduped union of decision files", async () => {
  const { db, repoRoot } = freshRepo();
  try {
    await writeTranscript(repoRoot, "chat-1", [msg("m1", "completed")]);
    const filesDispatch: DigestDispatch = async () =>
      JSON.stringify({
        decisions: [
          { topic: "alpha", body: "d1", files: ["src/a.ts", "src/b.ts"], agent: "claude" },
          { topic: "beta", body: "d2", files: ["src/b.ts", "src/c.ts"], agent: "claude" },
        ],
        summary: "session touched a, b and c",
      });
    const outcome = await runDigestPass(baseDeps(db, repoRoot, filesDispatch));
    expect(outcome).toEqual({ ok: true, digested: 1 });
    const summary = readByProject(db, "p1").find((r) => r.category === "summary");
    // The router's file-intersection can now pull this summary cross-session (the filed follow-up).
    expect(summary?.touchedFiles).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  } finally {
    closeDb(db);
  }
});
