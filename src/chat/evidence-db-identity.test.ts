/**
 * @file src/chat/evidence-db-identity.test.ts
 * @purpose W4-R3a RA-2: the ledger-leak falsifier. The carrier is opened with an ABSOLUTE db path and every
 *   visible-message writer then records through a RELATIVE spelling of THE SAME FILE — the exact shape the
 *   product produces, since chat-tui.ts boots the runtime from loadConfig()'s cwd-relative DEFAULT_DB_PATH
 *   while other resolution points absolutise (digest-runner.ts:97; the loop bridge did too before its cut).
 *   At base each writer's own `carrier.dbPath === input.dbPath` raw compare reads one file as two stores:
 *   the row lands, NO ledger seq is minted, and the reply is durable yet invisible to every other lane
 *   forever. The assertion is on `ledger_seq` DIRECTLY — the digest's own "absent from DB mirror" check
 *   (digest.ts:51) only tests row PRESENCE, so a suite that asserted the mirror would go green on the leak.
 *   Real sqlite, real carrier runtime, real writers, zero mocks; fixture mirrors evidence-ledger-gate.test.ts.
 * @exports (test suite)
 * @depends node:fs/promises, node:os, node:path, node:process, vitest, ../evidence/blobs, ../evidence/db,
 *   ../memory/ledger, ./evidence, ./evidence-identity, ./evidence-strict, ./lane-carrier, ./lane-transport
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, beforeEach, expect, it } from "vitest";
import { getBlobSync } from "../evidence/blobs.js";
import { type Db, closeDb, openLaneStateDb } from "../evidence/db.js";
import { getSeqForMessage } from "../memory/ledger.js";
import { chatRunId } from "./evidence-identity.js";
import { persistDebateTurn, recordChatMessage, recordChatSession } from "./evidence.js";
import { recordLaneTurnEvidence } from "./evidence.js";
import { composeCarrierPrompt } from "./lane-carrier.js";
import { initCarrierRuntime, resetCarrierRuntime } from "./lane-transport.js";

const PROJECT = "p-identity";
const SESSION_ID = "chat-identity";
const CREATED_AT = "2026-07-31T00:00:00.000Z";
const BINDING = { adapterPkg: "pkg", adapterVersion: "1", cwd: "C:/repo" };
// The digest's OWN mirror probe, verbatim (digest.ts:51) — so "no absent-from-mirror line" is asserted
// against the real query the trace emits from, not a paraphrase of it.
const MIRROR_SQL = "SELECT 1 AS present FROM chat_messages WHERE id = ?";

const dirs: string[] = [];
const savedFlags = { memory: process.env.ZER0_MEMORY, resume: process.env.ZER0_NATIVE_RESUME };
let savedCwd: string | undefined;

beforeEach(() => {
  process.env.ZER0_MEMORY = "1";
  process.env.ZER0_NATIVE_RESUME = "1";
  savedCwd = process.cwd();
});

afterEach(async () => {
  if (savedCwd !== undefined) process.chdir(savedCwd); // BEFORE the rm — Windows holds an open cwd
  resetCarrierRuntime();
  restoreFlag("ZER0_MEMORY", savedFlags.memory);
  restoreFlag("ZER0_NATIVE_RESUME", savedFlags.resume);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function restoreFlag(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

interface Env {
  /** What the CARRIER was opened with: absolute, as initCarrierRuntime received it. */
  readonly absoluteDbPath: string;
  /** What the WRITERS pass: a cwd-relative spelling of the very same file. */
  readonly relativeDbPath: string;
  readonly blobRoot: string;
  readonly repoRoot: string;
  readonly runDir: string;
}

/**
 * A real store whose carrier holds the ABSOLUTE spelling while cwd is the repo root, so `"evidence.db"`
 * names the identical file. Two spellings, one inode — which is precisely the case a string compare
 * gets wrong and an identity compare gets right.
 */
async function makeEnv(): Promise<Env> {
  const root = await mkdtemp(path.join(tmpdir(), "evidence-db-identity-"));
  dirs.push(root);
  const blobRoot = path.join(root, "blobs");
  await mkdir(blobRoot, { recursive: true });
  const absoluteDbPath = path.join(root, "evidence.db");
  await recordChatSession({
    dbPath: absoluteDbPath,
    sessionId: SESSION_ID,
    runId: chatRunId(SESSION_ID),
    repoRoot: root,
    runDir: root,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    defaultAgent: "claude",
    lastAgent: null,
    summaryText: "",
    summaryThroughTurn: 0,
  });
  const db = openLaneStateDb(absoluteDbPath);
  db.prepare(
    "INSERT OR IGNORE INTO projects(project_id, canonical_root, git_common_dir, created_at) VALUES (?,?,?,?)",
  ).run(PROJECT, root, path.join(root, ".git"), CREATED_AT);
  closeDb(db);
  initCarrierRuntime({ projectId: PROJECT, dbPath: absoluteDbPath, repoRoot: root, cwd: root });
  process.chdir(root);
  return { absoluteDbPath, relativeDbPath: "evidence.db", blobRoot, repoRoot: root, runDir: root };
}

// The two spellings really are one file — asserted, not assumed, so a fixture that accidentally made two
// separate DBs could never masquerade as a passing identity test.
function expectOneFile(env: Env): void {
  expect(path.resolve(env.relativeDbPath)).toBe(path.resolve(env.absoluteDbPath));
}

function withDb<T>(env: Env, read: (db: Db) => T): T {
  const db = openLaneStateDb(env.absoluteDbPath);
  try {
    return read(db);
  } finally {
    closeDb(db);
  }
}

function bodyReader(db: Db, blobRoot: string) {
  return (messageId: string): { author: string; body: string } => {
    const row = db
      .prepare("SELECT role, agent, text_blob_hash AS hash FROM chat_messages WHERE id = ? LIMIT 1")
      .get(messageId) as { role: string; agent: string; hash: string } | undefined;
    if (row === undefined) throw new Error(`missing body for ${messageId}`);
    return {
      author: row.role === "user" ? "operator" : row.agent,
      body: getBlobSync({ rootDir: blobRoot }, row.hash).toString("utf8"),
    };
  };
}

// The three visible-message writers, each reachable with ANY spelling of the db, so a test states only
// the spelling under examination. Text is the payload a later delta must be able to deliver back.
function writeUser(
  env: Env,
  dbPath: string,
  id: string,
  text: string,
): Promise<string | undefined> {
  return recordChatMessage({
    dbPath,
    blobRoot: env.blobRoot,
    sessionId: SESSION_ID,
    messageId: id,
    turn: 1,
    role: "user",
    agent: "user",
    text,
    createdAt: CREATED_AT,
    status: "completed",
    tokenEstimate: 4,
  });
}

function writeLaneTurn(env: Env, dbPath: string, id: string, text: string) {
  return recordLaneTurnEvidence({
    dbPath,
    blobRoot: env.blobRoot,
    sessionId: SESSION_ID,
    turn: 1,
    agent: "codex",
    promptContent: "lane prompt",
    outputContent: text,
    stderrContent: "",
    durationMs: 42,
    exitCode: 0,
    repoRoot: env.repoRoot,
    messageId: id,
    messageCreatedAt: CREATED_AT,
    messageStatus: "completed",
  });
}

function writeDebateTurn(env: Env, dbPath: string, id: string, text: string) {
  return persistDebateTurn({
    dbPath,
    blobRoot: env.blobRoot,
    runDir: env.runDir,
    sessionId: SESSION_ID,
    turn: 1,
    round: 1,
    agent: "gemini",
    promptContent: "debate prompt",
    outputContent: text,
    stderrContent: "",
    durationMs: 77,
    exitCode: 0,
    messageId: id,
    messageCreatedAt: CREATED_AT,
    workingSetId: `ws-${id}`,
    workingSetCreatedAt: CREATED_AT,
    peerRefs: [],
    outcome: "ok",
    workingSetTokenEstimate: 3,
  });
}

// The row alone was NEVER the question — at base the row lands too. The seq is what the room needs, and
// it is asserted DIRECTLY: the digest's own mirror probe tests presence only and goes green on the leak.
function expectRowAndSeq(env: Env, id: string, seq: number): void {
  withDb(env, (db) => {
    expect(db.prepare(MIRROR_SQL).get(id)).toEqual({ present: 1 });
    expect(getSeqForMessage(db, PROJECT, id)).toBe(seq);
  });
}

it("USER message recorded through a relative spelling of the carrier's own db still mints its ledger seq", async () => {
  const env = await makeEnv();
  expectOneFile(env);

  const written = await writeUser(
    env,
    env.relativeDbPath,
    "msg-user-rel",
    "USER-TEXT-VIA-RELATIVE",
  );

  expect(written).toBe("msg-user-rel");
  expectRowAndSeq(env, "msg-user-rel", 1);
});

it("LANE TURN recorded through a relative spelling mints its seq in the same transaction as the row", async () => {
  const env = await makeEnv();
  expectOneFile(env);

  const evidence = await writeLaneTurn(
    env,
    env.relativeDbPath,
    "msg-lane-rel",
    "LANE-TEXT-VIA-RELATIVE",
  );

  expect(evidence.messageId).toBe("msg-lane-rel");
  expectRowAndSeq(env, "msg-lane-rel", 1);
});

it("DEBATE TURN recorded through a relative spelling mints its seq (the third fork of the same rule)", async () => {
  const env = await makeEnv();
  expectOneFile(env);

  const result = await writeDebateTurn(
    env,
    env.relativeDbPath,
    "msg-debate-rel",
    "DEBATE-TEXT-VIA-RELATIVE",
  );

  expect(result.dispatchId).toBeDefined();
  expectRowAndSeq(env, "msg-debate-rel", 1);
});

it("all three writers under mixed spellings share ONE seq stream a later lane delta actually delivers", async () => {
  const env = await makeEnv();
  expectOneFile(env);

  await writeUser(env, env.relativeDbPath, "mix-user", "MIX-USER-TEXT");
  await writeLaneTurn(env, `./${env.relativeDbPath}`, "mix-lane", "MIX-LANE-TEXT"); // a THIRD spelling
  await writeDebateTurn(env, env.absoluteDbPath, "mix-debate", "MIX-DEBATE-TEXT"); // and the absolute

  // ONE stream, gapless, in write order — three writers, three spellings, one room ledger.
  expectRowAndSeq(env, "mix-user", 1);
  expectRowAndSeq(env, "mix-lane", 2);
  expectRowAndSeq(env, "mix-debate", 3);
  withDb(env, (db) => {
    // The seqs are not merely present — a real sibling lane's delta DELIVERS them, which is the whole
    // point of minting: another agent's next prompt carries what this turn said.
    const delivered = composeCarrierPrompt({
      agent: "codex",
      turn: 2,
      binding: BINDING,
      db,
      projectId: PROJECT,
      readBody: bodyReader(db, env.blobRoot),
      setup: "S",
      operatorMessage: "O",
    });
    expect(delivered.deliveredSeqs).toEqual([1, 2, 3]);
    expect(delivered.text).toContain("MIX-USER-TEXT");
    expect(delivered.text).toContain("MIX-LANE-TEXT");
    expect(delivered.text).toContain("MIX-DEBATE-TEXT");
  });
});

it("a genuinely DIFFERENT db is still not the owner — the fix widens identity, never the match", async () => {
  const env = await makeEnv();
  const otherRoot = await mkdtemp(path.join(tmpdir(), "evidence-db-identity-other-"));
  dirs.push(otherRoot);
  const otherDbPath = path.join(otherRoot, "evidence.db");
  await recordChatSession({
    dbPath: otherDbPath,
    sessionId: SESSION_ID,
    runId: chatRunId(SESSION_ID),
    repoRoot: otherRoot,
    runDir: otherRoot,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    defaultAgent: "claude",
    lastAgent: null,
    summaryText: "",
    summaryThroughTurn: 0,
  });

  // A different FILE, not a different spelling — must stay non-carrier.
  await writeUser(env, otherDbPath, "msg-other-db", "OTHER-DB-TEXT");

  // The row lands in the other db, and NOTHING is minted into this project's ledger — a foreign store
  // must never be adopted by the carrier just because canonicalisation made matching more generous.
  const other = openLaneStateDb(otherDbPath);
  try {
    expect(other.prepare(MIRROR_SQL).get("msg-other-db")).toEqual({ present: 1 });
  } finally {
    closeDb(other);
  }
  withDb(env, (db) => {
    expect(db.prepare(MIRROR_SQL).get("msg-other-db")).toBeUndefined();
    expect(getSeqForMessage(db, PROJECT, "msg-other-db")).toBeUndefined();
  });
});
