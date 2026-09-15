/**
 * @file src/chat/agy-carrier.test.ts
 * @purpose MT7 T5 I4c agy carrier-floor tests: agy records the prompt attempt only after a captured
 *   conversation id is durable, advances the cursor from that post-capture pair, and leaves replies visible
 *   without cursor movement when id capture fails.
 * @exports (none - test suite)
 * @depends node:fs, node:os, node:path, vitest, ../evidence/db, ../memory/lane-state, ../memory/ledger, ./agy-carrier
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { type Db, closeDb, openLaneStateDb } from "../evidence/db.js";
import { getLaneCursor, getLaneSession, getPromptAttempt } from "../memory/lane-state.js";
import { mintSeq } from "../memory/ledger.js";
import { type AgyCarrierDispatch, runAgyCarrierTurn } from "./agy-carrier.js";

/** FL-150: CarrierTurnInput.signal is REQUIRED, and AgyCarrierTurnInput inherits it. The agy lane has
 *  always carried the turn's signal on its AgentInput (agy-runner.ts opens with `opts.signal.aborted`);
 *  the top-level field is the SAME object, asserted as such by runAgyCarrierTurn. Nothing here aborts. */
const NEVER_CANCELLED: AbortSignal = new AbortController().signal;

const NOW = "2026-07-10T00:00:00.000Z";
const PROJECT = "p1";
const roots: string[] = [];
const dbs: Db[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) closeDb(db);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function seeded(): { db: Db; root: string; prompts: string[] } {
  const root = mkdtempSync(path.join(tmpdir(), "agy-carrier-"));
  roots.push(root);
  const db = openLaneStateDb(path.join(root, "evidence.db"));
  dbs.push(db);
  db.prepare(
    "INSERT INTO projects(project_id, canonical_root, git_common_dir, created_at) VALUES (?,?,?,?)",
  ).run(PROJECT, "C:/repo", "C:/repo/.git", NOW);
  mintSeq(db, PROJECT, "m1");
  return { db, root, prompts: [] };
}

async function runWith(db: Db, root: string, prompts: string[], dispatch: AgyCarrierDispatch) {
  return runAgyCarrierTurn({
    agent: "gemini",
    turn: 1,
    binding: { adapterPkg: "agy", adapterVersion: "1.0.8", cwd: "C:/repo" },
    db,
    projectId: PROJECT,
    readBody: () => ({ author: "operator", body: "remembered fact" }),
    setup: "SETUP",
    operatorMessage: "Operator: respond",
    now: () => NOW,
    attemptId: () => "a-agy",
    writePrompt: async (prompt) => {
      prompts.push(prompt);
      const file = path.join(root, `prompt-${prompts.length}.md`);
      writeFileSync(file, prompt, "utf8");
      return file;
    },
    // FL-150: the SAME object in both places. runAgyCarrierTurn asserts
    // `input.signal === input.input.signal` — one turn, one cancel authority.
    signal: NEVER_CANCELLED,
    input: {
      agent: "gemini",
      contextFile: path.join(root, "context-seed.md"),
      signal: NEVER_CANCELLED,
      worktreePath: "C:/repo",
    },
    dispatch,
  });
}

it("records the prompt attempt only after agy captured and persisted the conversation id", async () => {
  const { db, root, prompts } = seeded();
  const dispatch: AgyCarrierDispatch = async (input) => {
    input.store.bumpGeneration(input.db, {
      adapterPkg: input.adapterPkg,
      adapterVersion: input.adapterVersion,
      cwd: input.cwd,
      agent: "gemini",
      now: input.now(),
      projectId: input.projectId,
      sessionId: "agy-1",
    });
    return {
      outcome: "persisted",
      conversationId: "agy-1",
      result: { exitCode: 0, stdout: "agy reply" },
    };
  };

  const result = await runWith(db, root, prompts, dispatch);

  expect(result).toMatchObject({ outcome: "accepted", reply: "agy reply", sessionId: "agy-1" });
  expect(prompts[0]).toContain("Operator: respond");
  expect(getLaneSession(db, PROJECT, "gemini")?.sessionId).toBe("agy-1");
  expect(getPromptAttempt(db, "a-agy")).toMatchObject({
    generation: 1,
    sessionId: "agy-1",
    resolved: "accepted",
  });
  expect(getLaneCursor(db, PROJECT, "gemini")?.lastSeq).toBe(1);
});

async function seedAcceptedAgySession(db: Db, cwd: string): Promise<void> {
  const { bumpGeneration, recordPromptAttempt, advanceCursorOnAccept } = await import(
    "../memory/lane-state.js"
  );
  bumpGeneration(db, {
    projectId: PROJECT,
    agent: "gemini",
    sessionId: "agy-old",
    adapterPkg: "agy",
    adapterVersion: "1.0.8",
    cwd,
    now: NOW,
  });
  recordPromptAttempt(db, {
    attemptId: "a-seed",
    projectId: PROJECT,
    agent: "gemini",
    generation: 1,
    sessionId: "agy-old",
    seqFrom: 1,
    seqTo: 1,
    sentAt: NOW,
  });
  await advanceCursorOnAccept(db, {
    projectId: PROJECT,
    agent: "gemini",
    attemptId: "a-seed",
    generation: 1,
    sessionId: "agy-old",
    lastSeq: 1,
    clearBriefingCarry: true,
    now: NOW,
  });
}

function bumpingDispatch(sessionId: string): AgyCarrierDispatch {
  return async (input) => {
    input.store.bumpGeneration(input.db, {
      adapterPkg: input.adapterPkg,
      adapterVersion: input.adapterVersion,
      cwd: input.cwd,
      agent: "gemini",
      now: input.now(),
      projectId: input.projectId,
      sessionId,
    });
    return {
      outcome: "persisted",
      conversationId: sessionId,
      result: { exitCode: 0, stdout: "agy reply" },
    };
  };
}

it("retro BLOCK-2: a mismatched stored binding composes CATCH-UP (pre-cursor tail included) and traces resume.fallback", async () => {
  const { db, root, prompts } = seeded();
  mintSeq(db, PROJECT, "m2");
  const bodies = new Map([
    ["m1", { author: "operator", body: "early context the fresh conversation never saw" }],
    ["m2", { author: "claude", body: "newer message" }],
  ]);
  await seedAcceptedAgySession(db, "C:/ELSEWHERE"); // stored cwd MISMATCHES the turn binding below
  const traces: string[] = [];
  const turns: number[] = [];
  const result = await runAgyCarrierTurn({
    agent: "gemini",
    turn: 9,
    binding: { adapterPkg: "agy", adapterVersion: "1.0.8", cwd: "C:/repo" },
    db,
    projectId: PROJECT,
    readBody: (id) => bodies.get(id) ?? { author: "operator", body: "missing" },
    setup: "SETUP",
    operatorMessage: "Operator: respond",
    now: () => NOW,
    attemptId: () => "a-agy2",
    trace: {
      emit: (event) => {
        if (event.kind !== "memory.trace") return;
        traces.push(`${event.phase}:${event.detail ?? ""}`);
        turns.push(event.turn);
      },
    },
    writePrompt: async (prompt) => {
      prompts.push(prompt);
      const file = path.join(root, "prompt-mismatch.md");
      writeFileSync(file, prompt, "utf8");
      return file;
    },
    signal: NEVER_CANCELLED,
    input: {
      agent: "gemini",
      contextFile: path.join(root, "context-seed.md"),
      signal: NEVER_CANCELLED,
      worktreePath: "C:/repo",
    },
    dispatch: bumpingDispatch("agy-new"),
  });
  expect(result.outcome).toBe("accepted");
  expect(traces.some((t) => t.startsWith("resume.fallback:reason=binding_mismatch"))).toBe(true);
  // The fresh conversation never saw seq 1 — catch-up must include the pre-cursor tail.
  expect(prompts[0]).toContain("early context the fresh conversation never saw");
  // C2 (FIX WAVE Round A): the trace threads the REAL turn (9), never a hard-coded 0.
  expect(turns).toEqual([9]);
});

it("retro BLOCK-3: with an existing MATCHING session the attempt is recorded PRE-send (I-1)", async () => {
  const { db, root, prompts } = seeded();
  const { bumpGeneration, getPromptAttempt: readAttempt } = await import("../memory/lane-state.js");
  bumpGeneration(db, {
    projectId: PROJECT,
    agent: "gemini",
    sessionId: "agy-1",
    adapterPkg: "agy",
    adapterVersion: "1.0.8",
    cwd: "C:/repo",
    now: NOW,
  });
  let attemptAtDispatch: unknown = "unread";
  const dispatch: AgyCarrierDispatch = async (input) => {
    attemptAtDispatch = readAttempt(input.db as Db, "a-agy")?.resolved;
    return {
      outcome: "persisted",
      conversationId: "agy-1",
      result: { exitCode: 0, stdout: "agy reply" },
    };
  };
  const result = await runWith(db, root, prompts, dispatch);
  expect(result.outcome).toBe("accepted");
  expect(attemptAtDispatch).toBeNull(); // the row EXISTED (unresolved) while the send was in flight
  expect(getPromptAttempt(db, "a-agy")?.resolved).toBe("accepted");
});

it("captureFailed returns the reply but does not record an attempt or advance the cursor", async () => {
  const { db, root, prompts } = seeded();
  const traces: string[] = [];
  const turns: number[] = [];
  const result = await runAgyCarrierTurn({
    agent: "gemini",
    turn: 4,
    binding: { adapterPkg: "agy", adapterVersion: "1.0.8", cwd: "C:/repo" },
    db,
    projectId: PROJECT,
    readBody: () => ({ author: "operator", body: "remembered fact" }),
    setup: "SETUP",
    operatorMessage: "Operator: respond",
    now: () => NOW,
    attemptId: () => "a-agy",
    trace: {
      emit: (event) => {
        if (event.kind !== "memory.trace") return;
        traces.push(`${event.phase}:${event.detail ?? ""}`);
        turns.push(event.turn);
      },
    },
    writePrompt: async (prompt) => {
      prompts.push(prompt);
      const file = path.join(root, "prompt-failed.md");
      writeFileSync(file, prompt, "utf8");
      return file;
    },
    signal: NEVER_CANCELLED,
    input: {
      agent: "gemini",
      contextFile: path.join(root, "context-seed.md"),
      signal: NEVER_CANCELLED,
      worktreePath: "C:/repo",
    },
    dispatch: async () => ({
      outcome: "captureFailed",
      reason: "missingConversationId",
      result: { exitCode: 0, stdout: "agy reply" },
    }),
  });

  expect(result).toMatchObject({ outcome: "captureFailed", reply: "agy reply" });
  expect(getPromptAttempt(db, "a-agy")).toBeUndefined();
  expect(getLaneCursor(db, PROJECT, "gemini")?.lastSeq ?? 0).toBe(0);
  expect(traces.some((t) => t.includes("agy_id_capture"))).toBe(true);
  // C2 (FIX WAVE Round A): captureFailed's own emit call threads the REAL turn (4), not a hard-coded 0.
  expect(turns).toEqual([4]);
});
