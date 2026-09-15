/**
 * @file src/chat/lane-message-identity.test.ts
 * @purpose W4-R3a: the falsifier for the leak the operator actually hit on 2026-07-31. An agent reply used
 *   to be minted TWICE — once by persistLane for the evidence row + its ledger seq (tower-bridge-lane.ts),
 *   once by laneOutcomeMessage for the transcript (headless-turn.ts) — and nothing joined the two. The
 *   digest reads the transcript as authority (digest.ts:62) and looks each id up in chat_messages
 *   (digest.ts:51), so every agent reply reported `absent from DB mirror` while its seq sat in the ledger
 *   under an id no one else knew. Room memory existed and was unjoinable.
 *   Asserts ONE identity across all four places it must agree, for all three agents, then runs the REAL
 *   digest pass over the persisted transcript and requires zero absent-from-mirror lines.
 *   Referee-pinned wiring: real temp sqlite + a FAKE dispatch (no vendor call); the carrier runtime is
 *   initialized with `lanesEnabled:false` so `usesCarrier` stays false (headless-turn.ts:364-375) and the
 *   injected dispatch runs, while `persistenceOwnerFor` still mints because it is deliberately NOT gated
 *   on lanesEnabled (lane-transport.ts) — the windowed-cockpit invariant, reused here as a test seam.
 * @exports (test suite)
 * @depends node:fs/promises, node:os, node:path, vitest, ../evidence/db, ../memory/digest,
 *   ../memory/ledger, ./dispatch-headless, ./events, ./evidence, ./evidence-identity, ./headless-turn,
 *   ./lane-transport, ./session-store, ./types
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type Db, closeDb, openLaneStateDb } from "../evidence/db.js";
import { runDigestPass } from "../memory/digest.js";
import { getSeqForMessage } from "../memory/ledger.js";
import { CHAT_GRANT } from "../shared/agent-grant.js";
import type { AgentResult } from "../shared/types.js";
import type { HeadlessDispatch } from "./dispatch-headless.js";
import { type ChatEvent, ChatEventBus } from "./events.js";
import { chatRunId } from "./evidence-identity.js";
import { recordChatSession } from "./evidence.js";
import { laneOutcomeMessage, runHeadlessTurn } from "./headless-turn.js";
import { initCarrierRuntime, resetCarrierRuntime } from "./lane-transport.js";
import { appendMessage, persistSession } from "./session-store.js";
import type { AgentName, ChatSession } from "./types.js";

const AGENTS: readonly AgentName[] = ["claude", "codex", "gemini"];
const PROJECT = "p-identity-unity";
const SESSION_ID = "chat-identity-unity" as const;
const ABSENT_MARKER = "absent from DB mirror";
const DIGEST_JSON = JSON.stringify({
  decisions: [{ topic: "transport", body: "the room agreed on sqlite" }],
  summary: "one turn, three replies",
});

const dirs: string[] = [];
const saved = {
  memory: process.env.ZER0_MEMORY,
  resume: process.env.ZER0_NATIVE_RESUME,
  debug: process.env.ZER0_DEBUG,
};

beforeEach(() => {
  process.env.ZER0_MEMORY = "1";
  process.env.ZER0_NATIVE_RESUME = "1";
  // LOAD-BEARING: digest.ts's split-truth probe is debug-gated (traceSplitTruth returns early when
  // debugEnabled() is false). With debug off it emits NOTHING and "zero absent-from-mirror" would pass
  // on a completely broken build — a vacuous green. The control test below proves the probe is live.
  process.env.ZER0_DEBUG = "1";
});

afterEach(async () => {
  resetCarrierRuntime();
  restore("ZER0_MEMORY", saved.memory);
  restore("ZER0_NATIVE_RESUME", saved.resume);
  restore("ZER0_DEBUG", saved.debug);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

interface Env {
  readonly session: ChatSession;
  readonly dbPath: string;
  readonly blobRoot: string;
  readonly repoRoot: string;
}

/** A real repo + store whose runDir is where loadSession will look — the digest re-reads it from disk. */
async function makeEnv(): Promise<Env> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "lane-identity-"));
  dirs.push(repoRoot);
  const runDir = path.join(repoRoot, ".council", "runs", SESSION_ID);
  await mkdir(path.join(runDir, "prompts"), { recursive: true });
  await mkdir(path.join(runDir, "responses"), { recursive: true });
  const blobRoot = path.join(repoRoot, "blobs");
  await mkdir(blobRoot, { recursive: true });
  const dbPath = path.join(repoRoot, "evidence.db");
  const now = new Date().toISOString();
  await recordChatSession({
    dbPath,
    sessionId: SESSION_ID,
    runId: chatRunId(SESSION_ID),
    repoRoot,
    runDir,
    createdAt: now,
    updatedAt: now,
    defaultAgent: "claude",
    lastAgent: null,
    summaryText: "",
    summaryThroughTurn: 0,
  });
  const db = openLaneStateDb(dbPath);
  db.prepare(
    "INSERT OR IGNORE INTO projects(project_id, canonical_root, git_common_dir, created_at) VALUES (?,?,?,?)",
  ).run(PROJECT, repoRoot, path.join(repoRoot, ".git"), now);
  closeDb(db);
  // lanesEnabled:false — the windowed-cockpit shape: no carrier turns (so the fake dispatch runs), but
  // the persistence owner still mints ledger seqs.
  initCarrierRuntime({
    projectId: PROJECT,
    dbPath,
    repoRoot,
    cwd: repoRoot,
    lanesEnabled: false,
  });
  const session: ChatSession = {
    id: SESSION_ID,
    repoRoot,
    runDir,
    createdAt: now,
    updatedAt: now,
    defaultAgent: "claude",
    lastAgent: null,
    summary: { text: "", throughTurn: 0 },
    messages: [],
  };
  return { session, dbPath, blobRoot, repoRoot };
}

const fakeDispatch: HeadlessDispatch = async (input): Promise<AgentResult> => ({
  stdout: `reply from ${input.agent}`,
  exitCode: 0,
});

/** Runs the three-agent fan-out and persists the merged transcript exactly as the cockpit does. */
async function runTurnAndPersist(env: Env): Promise<{
  readonly outcomes: Awaited<ReturnType<typeof runHeadlessTurn>>;
  readonly session: ChatSession;
}> {
  const outcomes = await runHeadlessTurn({
    session: env.session,
    addresses: AGENTS.map((agent) => ({ agent, prompt: "hello room" })),
    bus: new ChatEventBus(),
    turn: 1,
    laneClass: "chat",
    config: { dbPath: env.dbPath, blobRoot: env.blobRoot },
    signal: new AbortController().signal,
    grant: CHAT_GRANT,
    dispatch: fakeDispatch,
  });
  let session = env.session;
  for (const outcome of outcomes) {
    session = appendMessage(session, laneOutcomeMessage(1, outcome));
  }
  await persistSession(session);
  return { outcomes, session };
}

function withDb<T>(env: Env, read: (db: Db) => T): T {
  const db = openLaneStateDb(env.dbPath);
  try {
    return read(db);
  } finally {
    closeDb(db);
  }
}

/** The REAL digest pass over the persisted transcript; returns every trace detail it emitted. */
async function digestDetails(env: Env, session: ChatSession): Promise<string[]> {
  const details: string[] = [];
  const trace = {
    emit: (event: ChatEvent): void => {
      // `detail` is optional on the wire (events.ts:327); a trace event without one carries nothing
      // this test can assert on, so it is skipped rather than pushed as an empty string.
      if (event.kind === "memory.trace" && event.detail !== undefined) details.push(event.detail);
    },
  };
  const outcome = await withDbAsync(env, async (db) =>
    runDigestPass({
      db,
      sessionId: session.id as `chat-${string}`,
      repoRoot: env.repoRoot,
      projectId: PROJECT,
      dispatch: async () => DIGEST_JSON,
      now: new Date().toISOString(),
      trace,
    }),
  );
  expect(outcome.ok).toBe(true);
  return details;
}

async function withDbAsync<T>(env: Env, read: (db: Db) => Promise<T>): Promise<T> {
  const db = openLaneStateDb(env.dbPath);
  try {
    return await read(db);
  } finally {
    closeDb(db);
  }
}

it("one reply, ONE id: transcript == outcome == chat_messages == ledger_seq, for all three agents", async () => {
  const env = await makeEnv();
  const { outcomes, session } = await runTurnAndPersist(env);

  expect(outcomes).toHaveLength(AGENTS.length);
  for (const agent of AGENTS) {
    const outcome = outcomes.find((o) => o.agent === agent);
    const transcript = session.messages.find((m) => m.agent === agent);
    expect(outcome?.messageId).toBeDefined();
    const id = outcome?.messageId as string;

    // 1. the transcript row the digest reads as authority
    expect(transcript?.id).toBe(id);
    withDb(env, (db) => {
      // 2. the evidence row the digest's mirror probe looks up
      const row = db.prepare("SELECT id, agent FROM chat_messages WHERE id = ?").get(id) as
        | { id: string; agent: string }
        | undefined;
      expect(row?.id).toBe(id);
      expect(row?.agent).toBe(agent);
      // 3. the ledger seq the OTHER lanes read the room through
      expect(getSeqForMessage(db, PROJECT, id)).toBeGreaterThan(0);
    });
  }
});

it("the digest reports ZERO absent-from-mirror for the turn (the operator's exact 2026-07-31 symptom)", async () => {
  const env = await makeEnv();
  const { session } = await runTurnAndPersist(env);

  const details = await digestDetails(env, session);

  expect(details.filter((d) => d.includes(ABSENT_MARKER))).toEqual([]);
  // Not a vacuous pass: the pass really did process this turn's three replies.
  expect(details.some((d) => d.startsWith("digested 3 "))).toBe(true);
});

it("CONTROL: the absent-from-mirror probe is LIVE — a transcript id the DB never saw still reports it", async () => {
  const env = await makeEnv();
  const { session } = await runTurnAndPersist(env);
  await digestDetails(env, session); // watermark the real replies so only the fabricated one is pending

  // Exactly the shape the old double-mint produced: a transcript message whose id has no evidence row.
  // If this did NOT report, the assertion in the test above would be meaningless.
  const orphaned = appendMessage(session, {
    id: "msg-never-persisted-to-the-db",
    turn: 2,
    role: "agent",
    agent: "claude",
    text: "a reply the DB never saw",
    createdAt: new Date().toISOString(),
    status: "completed",
    tokenEstimate: 6,
  });
  await persistSession(orphaned);

  const details = await digestDetails(env, orphaned);

  expect(details).toContain(`msg-never-persisted-to-the-db ${ABSENT_MARKER}`);
});
