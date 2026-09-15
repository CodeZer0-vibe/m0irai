/**
 * @file src/memory/baseline-fixture.ts
 * @purpose The DETERMINISTIC pre-unit (@0e4ded7) MEMORY-FULL baseline the unit pins its AC5 goldens
 *   against: fixed ids/timestamps and no reliance on any `datetime('now')` default, so the scripted
 *   turn writes byte-identical DB pages every run. Also exposes the fixture session/prompt the
 *   baseline tests compose against. Pure: raw SQL inserts + string composition, no I/O of its own.
 * @exports BASELINE_SESSION, BASELINE_PROMPT, BASELINE_TURN, BASELINE_LANES, insertScriptedTurn
 * @depends ../evidence/db, ../chat/types
 */
import type { AgentName, ChatSession } from "../chat/types.js";
import type { Db } from "../evidence/db.js";

// One frozen instant for EVERY created_at/started_at the scripted turn writes. Relying on a
// `datetime('now')` column default (dispatches.created_at has one) would embed the wall clock in the DB
// pages and destroy byte-determinism, so the builder sets created_at EXPLICITLY on every row.
const FIXED_TS = "2026-07-04T00:00:00.000Z";
const PROJECT_ID = "proj-baseline";
const RUN_ID = "run-baseline";
const SESSION_ID = "chat-baseline" as const;
const TASK_ID = "task-baseline";
const REPO_ROOT = "/baseline/repo";
const RUN_DIR = "/baseline/repo/.council/runs/chat-baseline";

/** The lanes (per-agent classes) the memory-off composePrompt bytes are captured for. */
export const BASELINE_LANES: readonly AgentName[] = ["claude", "codex", "gemini"];

/** The current operator message of the scripted turn (turn 2 — a prior turn already sits in history). */
export const BASELINE_PROMPT = "@all summarise where we are and pick the next file to touch";

/** The turn number the scripted operator message belongs to. */
export const BASELINE_TURN = 2;

/**
 * The fixture chat session the baseline composePrompt bytes derive from: a completed turn-1 exchange
 * (operator + one claude reply) plus this turn's operator line, so the composed prompt exercises the
 * real dialogue-window path (not just the turn-1 short-circuit). Frozen ids/timestamps keep the
 * composed bytes stable for the AC5 golden.
 */
export const BASELINE_SESSION: ChatSession = {
  id: SESSION_ID,
  repoRoot: REPO_ROOT,
  runDir: RUN_DIR,
  createdAt: FIXED_TS,
  updatedAt: FIXED_TS,
  defaultAgent: "claude",
  lastAgent: "claude",
  summary: { text: "", throughTurn: 0 },
  messages: [
    {
      id: "msg-1-user",
      turn: 1,
      role: "user",
      agent: "user",
      text: "@claude scaffold the evidence schema module",
      createdAt: FIXED_TS,
      status: "completed",
      tokenEstimate: 12,
    },
    {
      id: "msg-1-claude",
      turn: 1,
      role: "agent",
      agent: "claude",
      text: "Added src/evidence/db.ts with the v14 open path and migration chain.",
      createdAt: FIXED_TS,
      status: "completed",
      tokenEstimate: 18,
    },
    {
      id: "msg-2-user",
      turn: BASELINE_TURN,
      role: "user",
      agent: "user",
      text: BASELINE_PROMPT,
      createdAt: FIXED_TS,
      status: "completed",
      tokenEstimate: 14,
    },
  ],
};

interface DispatchCapture {
  readonly id: string;
  readonly agent: AgentName;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly envAllowlistVersion: string;
}

// Two lane dispatches for the scripted turn — the argv/cwd/env-allowlist captures a later task asserts
// stay byte-identical when memory is off. Frozen so the row bytes (and the DB hash) never drift.
const DISPATCHES: readonly DispatchCapture[] = [
  {
    id: "dispatch-claude",
    agent: "claude",
    argv: ["claude", "--setting-sources", "", "--permission-mode", "acceptEdits"],
    cwd: REPO_ROOT,
    envAllowlistVersion: "v1",
  },
  {
    id: "dispatch-codex",
    agent: "codex",
    argv: ["codex", "exec", "--sandbox", "read-only"],
    cwd: REPO_ROOT,
    envAllowlistVersion: "v1",
  },
];

function insertCore(db: Db): void {
  db.prepare(
    "INSERT OR IGNORE INTO projects (project_id, canonical_root, git_common_dir, created_at) VALUES (?, ?, ?, ?)",
  ).run(PROJECT_ID, REPO_ROOT, `${REPO_ROOT}/.git`, FIXED_TS);
  db.prepare("INSERT OR IGNORE INTO runs (id, vision, status, started_at) VALUES (?, ?, ?, ?)").run(
    RUN_ID,
    "baseline capture",
    "init",
    FIXED_TS,
  );
  db.prepare(
    "INSERT OR IGNORE INTO chat_sessions (id, run_id, repo_root, run_dir, created_at, updated_at, default_agent, last_agent, summary_text, summary_through_turn, project_id, quarantined) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    SESSION_ID,
    RUN_ID,
    REPO_ROOT,
    RUN_DIR,
    FIXED_TS,
    FIXED_TS,
    "claude",
    "claude",
    "",
    0,
    PROJECT_ID,
    0,
  );
}

function insertMessages(db: Db): void {
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO chat_messages (id, session_id, turn, round, role, agent, text_blob_hash, created_at, status, token_estimate, dispatch_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const m of BASELINE_SESSION.messages) {
    stmt.run(
      m.id,
      SESSION_ID,
      m.turn,
      0,
      m.role,
      m.agent,
      `hash-${m.id}`,
      m.createdAt,
      m.status,
      m.tokenEstimate,
      null,
    );
  }
}

function insertTaskAndDispatches(db: Db): void {
  db.prepare(
    "INSERT OR IGNORE INTO tasks (id, run_id, objective, agent, status, owned_files, forbidden_files, acceptance) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    TASK_ID,
    RUN_ID,
    "scaffold evidence schema",
    "claude",
    "pending",
    "[]",
    "[]",
    "tables exist",
  );
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO dispatches (id, task_id, agent, command_hash, exit_code, stdout_blob, duration_ms, argv_json, cwd, env_allowlist_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const d of DISPATCHES) {
    stmt.run(
      d.id,
      TASK_ID,
      d.agent,
      `cmd-${d.id}`,
      0,
      `stdout-${d.id}`,
      1000,
      JSON.stringify(d.argv),
      d.cwd,
      d.envAllowlistVersion,
      FIXED_TS,
    );
  }
}

/**
 * Inserts the full scripted turn into an open evidence DB with FIXED values (one project, run, chat
 * session, the three transcript messages of {@link BASELINE_SESSION}, one task, two lane dispatches),
 * as ONE transaction. Every created_at is explicit — no `datetime('now')` default is touched — so the
 * DB pages are byte-identical across runs. Idempotent via INSERT OR IGNORE.
 *
 * @param db - an open evidence DB already migrated to v14 (or v15) by openDb/openMemoryDb
 */
export function insertScriptedTurn(db: Db): void {
  const tx = db.transaction((): void => {
    insertCore(db);
    insertMessages(db);
    insertTaskAndDispatches(db);
  });
  tx();
}
