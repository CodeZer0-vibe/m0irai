/**
 * @file tests/integration/read-proofs.e2e.test.ts
 * @purpose MT7 T6 live six-cell read-proof harness over carrier-on/off seams plus dispatch isolation.
 * @exports (test suite - no runtime exports)
 * @depends node:fs, node:os, node:path, vitest, src ACP/agy carriers, memory ledger/journal, headless prompts
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, expect, it } from "vitest";
import { acpAdapterBinding } from "../../src/adapters/acp/acp-servers.js";
import { openTurnSession } from "../../src/adapters/acp/acp-turn-session.js";
import { dispatchAgy } from "../../src/adapters/agy.js";
import { runAgyCarrierTurn } from "../../src/chat/agy-carrier.js";
import {
  composeHeadlessSetup,
  composeOperatorTask,
  composePrompt,
} from "../../src/chat/headless-prompt.js";
import { runCarrierTurn } from "../../src/chat/lane-carrier.js";
import { createCockpitLaneTransport } from "../../src/chat/lane-transport.js";
import type { AgentName, ChatSession } from "../../src/chat/types.js";
import type { Db } from "../../src/evidence/db.js";
import { closeDb, openLaneStateDb } from "../../src/evidence/db.js";
import { appendEntry } from "../../src/memory/journal-store.js";
import { mintSeq } from "../../src/memory/ledger.js";
import { CHAT_GRANT } from "../../src/shared/agent-grant.js";

/** FL-150: CarrierTurnInput.signal is REQUIRED - a turn must name what can cancel it, because the ACP
 *  call site that could quietly omit it did, for the whole life of the defect. Nothing here cancels. */
const NEVER_CANCELLED: AbortSignal = new AbortController().signal;
const RUN_REAL_CLI = process.env.ZER0_REAL_CLI === "1";
const ALLOW_SKIP = process.env.ZER0_READPROOF_ALLOW_SKIP === "1";
// @size-justified: the six MT6b cells + the dispatch-negative are ONE acceptance matrix (plan T6: "no
// loop may skip one"); splitting scatters the per-cell seams this file exists to enumerate side by side.
const LIVE_TIMEOUT_MS = 300_000;
const NOW = "2026-07-10T00:00:00.000Z";
const CWD = process.cwd();
const RECEIPT_FILE = path.join(CWD, ".council", "receipts", "mt7-read-proofs.log");
const ARTIFACT_DIR = path.join(CWD, ".council", "receipts", "mt7-read-proofs");
const AGY_BINDING = { adapterPkg: "agy", adapterVersion: "1.0.8" } as const;
const ENV_KEYS = ["ZER0_MEMORY", "ZER0_NATIVE_RESUME", "ZER0_DB_PATH", "ZER0_DEBUG"] as const;
const DENY_FRAGMENTS = [
  "# Static memory briefing",
  "BEGIN UNTRUSTED RECALLED MEMORY",
  "origin=ledger",
  "journal:",
  "PROJECT LEDGER",
  "seq 1 author",
] as const;
type CarrierMode = "carrier-on" | "carrier-off";
type Proof = { readonly reply: string; readonly artifacts: readonly string[] };
type Bodies = Map<string, { readonly author: string; readonly body: string }>;
type EnvSnapshot = Readonly<Record<(typeof ENV_KEYS)[number], string | undefined>>;
interface Fixture {
  readonly cell: string;
  readonly db: Db;
  readonly dbPath: string;
  readonly bodies: Bodies;
  readonly projectId: string;
  readonly repoRoot: string;
  readonly runDir: string;
  readonly tempRoot: string;
  /** The DB's own unrelated temp root — never reachable by traversal from the agent cwd. */
  readonly storeRoot: string;
}
const absorbedTeardownRejections: string[] = [];
if (RUN_REAL_CLI) {
  process.on("unhandledRejection", (reason) => {
    if (reason instanceof Error && reason.message === "ACP connection closed") {
      absorbedTeardownRejections.push(reason.message);
      return;
    }
    throw reason;
  });
  afterAll(() => {
    recordReceipt(
      `MT7_READPROOF_TEARDOWN absorbed_acp_closed=${absorbedTeardownRejections.length}`,
    );
  });
}
it.skipIf(!RUN_REAL_CLI)(
  "read-proof 1: claude x carrier-on recalls ledger fact",
  () => readProofCell("claude-carrier-on", "claude", "carrier-on", acpCarrierOn),
  LIVE_TIMEOUT_MS,
);
it.skipIf(!RUN_REAL_CLI)(
  "read-proof 2: claude x carrier-off recalls briefing fact",
  () => readProofCell("claude-carrier-off", "claude", "carrier-off", acpCarrierOff),
  LIVE_TIMEOUT_MS,
);
it.skipIf(!RUN_REAL_CLI)(
  "read-proof 3: codex x carrier-on recalls ledger fact",
  () => readProofCell("codex-carrier-on", "codex", "carrier-on", acpCarrierOn),
  LIVE_TIMEOUT_MS,
);
it.skipIf(!RUN_REAL_CLI)(
  "read-proof 4: codex x carrier-off recalls briefing fact",
  () => readProofCell("codex-carrier-off", "codex", "carrier-off", acpCarrierOff),
  LIVE_TIMEOUT_MS,
);
it.skipIf(!RUN_REAL_CLI)(
  "read-proof 5: agy x carrier-on recalls delta fact with conversation continuity",
  () => readProofCell("agy-carrier-on", "gemini", "carrier-on", agyCarrierOn),
  LIVE_TIMEOUT_MS,
);
it.skipIf(!RUN_REAL_CLI)(
  "read-proof 6: agy x carrier-off recalls briefing fact",
  () => readProofCell("agy-carrier-off", "gemini", "carrier-off", agyCarrierOff),
  LIVE_TIMEOUT_MS,
);
it.skipIf(!RUN_REAL_CLI)(
  "dispatch negative: both carrier modes hide journal and delta facts from dispatch lanes",
  async () => {
    await negativeDispatchProof("carrier-on");
    await negativeDispatchProof("carrier-off");
  },
  LIVE_TIMEOUT_MS,
);
async function readProofCell(
  cell: string,
  lane: AgentName,
  mode: CarrierMode,
  run: (fx: Fixture, lane: AgentName, fact: string) => Promise<Proof>,
): Promise<void> {
  const saved = saveEnv();
  const fx = fixture(cell);
  const fact = factToken(cell);
  setEnv(mode, fx.dbPath);
  try {
    const proof = await run(fx, lane, fact);
    const passed = proof.reply.includes(fact);
    recordCell(lane, cell, fact, passed ? "PASS" : "FAIL", proof);
    expect(proof.reply).toContain(fact);
  } catch (error) {
    handleLiveSkip(error, lane, cell, fact);
  } finally {
    cleanup(fx, saved);
  }
}
async function acpCarrierOn(fx: Fixture, lane: AgentName, fact: string): Promise<Proof> {
  if (lane === "gemini") throw new Error("ACP carrier-on cannot run gemini");
  seedLedgerFact(fx, fact);
  let reply = "";
  const transport = createCockpitLaneTransport({
    agent: lane,
    cwd: fx.repoRoot,
    repoRoot: fx.repoRoot,
    onText: (chunk) => {
      reply += chunk;
    },
  });
  try {
    const result = await runCarrierTurn({
      agent: lane,
      turn: 1,
      binding: { ...acpAdapterBinding(lane), cwd: fx.repoRoot },
      db: fx.db,
      operatorMessage: composeOperatorTask(question()),
      projectId: fx.projectId,
      readBody: readBody(fx.bodies),
      setup: composeHeadlessSetup(lane),
      transport,
      signal: NEVER_CANCELLED,
      now: () => NOW,
    });
    if (result.outcome !== "accepted") throw new Error(`carrier ${lane} ${result.outcome}`);
    return { reply, artifacts: [artifact(cellPath(fx.cell, "carrier-on.md"), result.prompt)] };
  } finally {
    await transport.close();
  }
}
async function acpCarrierOff(fx: Fixture, lane: AgentName, fact: string): Promise<Proof> {
  if (lane === "gemini") throw new Error("ACP carrier-off cannot run gemini");
  seedBriefingFact(fx, fact, lane);
  const prompt = chatPrompt(fx, lane, "chat");
  const artifactPath = artifact(cellPath(fx.cell, "carrier-off.md"), prompt);
  const turn = await openTurnSession(lane, fx.repoRoot);
  try {
    const result = await turn.prompt(prompt);
    return { reply: result.reply, artifacts: [artifactPath] };
  } finally {
    turn.close();
  }
}
async function agyCarrierOn(fx: Fixture, lane: AgentName, fact: string): Promise<Proof> {
  if (lane !== "gemini") throw new Error("agy carrier-on requires gemini lane");
  await runAgyCarrier(fx, "agy-prime", "Reply READY.");
  seedLedgerFact(fx, fact);
  const result = await runAgyCarrier(fx, "agy-recall", question());
  return { reply: result.reply, artifacts: [result.artifact] };
}
async function agyCarrierOff(fx: Fixture, lane: AgentName, fact: string): Promise<Proof> {
  if (lane !== "gemini") throw new Error("agy carrier-off requires gemini lane");
  seedBriefingFact(fx, fact, lane);
  const prompt = chatPrompt(fx, lane, "chat");
  const promptPath = artifact(cellPath(fx.cell, "carrier-off.md"), prompt);
  const result = await dispatchAgy({
    agent: "gemini",
    grant: CHAT_GRANT,
    contextFile: promptPath,
    signal: new AbortController().signal,
    timeoutMs: LIVE_TIMEOUT_MS,
    worktreePath: fx.repoRoot,
  });
  return { reply: result.stdout, artifacts: [promptPath] };
}
async function negativeDispatchProof(mode: CarrierMode): Promise<void> {
  const saved = saveEnv();
  const fx = fixture(`dispatch-negative-${mode}`);
  const fact = factToken(`dispatch-negative-${mode}`);
  setEnv(mode, fx.dbPath);
  // No debug sidecars in the agent's cwd during the live-ask: an operator-ambient ZER0_DEBUG=1 (the
  // integration config has no setup pin) would write journal-bearing traces INSIDE the fixture repo,
  // handing the tool-wielding agent the very bytes the prompt correctly withheld.
  process.env.ZER0_DEBUG = "0";
  try {
    seedLedgerFact(fx, fact);
    seedBriefingFact(fx, fact, "claude");
    const prompt = chatPrompt(fx, "claude", "dispatch");
    expectPromptIsolated(prompt, fact);
    const promptPath = artifact(cellPath(fx.cell, "dispatch.md"), prompt);
    // The live-ask is falsifiable ONLY while the token exists NOWHERE readable: a full agent on the same
    // host excavated it twice (parent-dir sibling evidence.db, then the TEMP store's 972KB WAL). Close
    // and DELETE the store before asking — recall now proves prompt leakage and nothing else.
    closeDb(fx.db);
    rmSync(fx.storeRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
    const turn = await openTurnSession("claude", fx.repoRoot);
    try {
      const result = await turn.prompt(prompt);
      const passed = !result.reply.includes(fact);
      recordCell("claude", fx.cell, fact, passed ? "PASS" : "FAIL", {
        reply: result.reply,
        artifacts: [promptPath],
      });
      expect(result.reply).not.toContain(fact);
    } finally {
      turn.close();
    }
  } catch (error) {
    handleLiveSkip(error, "claude", fx.cell, fact);
  } finally {
    cleanup(fx, saved);
  }
}
async function runAgyCarrier(
  fx: Fixture,
  suffix: string,
  prompt: string,
): Promise<{ readonly reply: string; readonly artifact: string }> {
  let promptArtifact = "";
  const result = await runAgyCarrierTurn({
    agent: "gemini",
    turn: 1,
    binding: { ...AGY_BINDING, cwd: fx.repoRoot },
    db: fx.db,
    // FL-150: one turn, one cancel authority - runAgyCarrierTurn asserts these are the same object.
    signal: NEVER_CANCELLED,
    input: {
      agent: "gemini",
      grant: CHAT_GRANT,
      contextFile: path.join(fx.runDir, `${suffix}-seed.md`),
      signal: NEVER_CANCELLED,
      timeoutMs: LIVE_TIMEOUT_MS,
      worktreePath: fx.repoRoot,
    },
    operatorMessage: composeOperatorTask(prompt),
    projectId: fx.projectId,
    readBody: readBody(fx.bodies),
    setup: composeHeadlessSetup("gemini"),
    writePrompt: async (text) => {
      promptArtifact = artifact(cellPath(fx.cell, `${suffix}.md`), text);
      return promptArtifact;
    },
    now: () => NOW,
  });
  if (result.outcome !== "accepted") throw new Error(`agy carrier ${result.outcome}`);
  return { reply: result.reply, artifact: promptArtifact };
}
function fixture(cell: string): Fixture {
  // TWO UNRELATED temp roots (live-hit 2026-07-10): with the DB a SIBLING of the agent cwd, live claude
  // answered the dispatch-negative by enumerating `..` and reading evidence.db — the PROMPT was clean
  // (isolation held); the fixture leaked through the filesystem. Nothing in or near the agent's cwd may
  // reference the store root.
  const storeRoot = mkdtempSync(path.join(tmpdir(), "zer0-read-proof-store-"));
  const tempRoot = mkdtempSync(path.join(tmpdir(), "zer0-read-proof-"));
  const repoRoot = path.join(tempRoot, "repo");
  const runDir = path.join(repoRoot, ".council", "runs", cell);
  mkdirSync(runDir, { recursive: true });
  const dbPath = path.join(storeRoot, "evidence.db");
  const db = openLaneStateDb(dbPath);
  const projectId = `proj-${cell}`;
  db.prepare(
    "INSERT INTO projects(project_id, canonical_root, git_common_dir, created_at) VALUES (?,?,?,?)",
  ).run(projectId, repoRoot, path.join(repoRoot, ".git"), NOW);
  return { bodies: new Map(), cell, db, dbPath, projectId, repoRoot, runDir, storeRoot, tempRoot };
}
// Janitorial leftovers NEVER fail a proof: a just-killed bridge child can hold its cwd on Windows
// (live-hit: EBUSY rmdir .../repo failed the carrier-off negative AFTER its assertions all passed).
// Failed removals queue for one afterAll retry, then get receipted and tolerated (OS temp cleanup).
const cleanupLeftovers: string[] = [];

function cleanup(fx: Fixture, saved: EnvSnapshot): void {
  closeDb(fx.db); // idempotent — the negative's delete-store step may have closed it already
  restoreEnv(saved);
  tolerantRm(fx.tempRoot);
  tolerantRm(fx.storeRoot);
}

function tolerantRm(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
  } catch {
    cleanupLeftovers.push(root);
  }
}

afterAll(() => {
  for (const root of cleanupLeftovers.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch {
      recordReceipt(`MT7_CLEANUP leftover=${root}`);
    }
  }
});
function seedLedgerFact(fx: Fixture, fact: string): void {
  const messageId = `${fx.cell}-ledger-fact`;
  fx.bodies.set(messageId, { author: "operator", body: `Read-proof fact token: ${fact}` });
  mintSeq(fx.db, fx.projectId, messageId);
}
function seedBriefingFact(fx: Fixture, fact: string, lane: AgentName): void {
  appendEntry(fx.db, {
    projectId: fx.projectId,
    category: "decision",
    author: "operator",
    agent: lane,
    body: `Read-proof briefing fact token: ${fact}`,
    createdAt: NOW,
    topicKey: fx.cell,
  });
}
function chatPrompt(fx: Fixture, lane: AgentName, laneClass: "chat" | "dispatch"): string {
  return composePrompt(session(fx), question(), lane, 1, laneClass);
}
function session(fx: Fixture): ChatSession {
  const id = `chat-${fx.cell}` as `chat-${string}`;
  return {
    id,
    repoRoot: fx.repoRoot,
    runDir: fx.runDir,
    createdAt: NOW,
    updatedAt: NOW,
    defaultAgent: "claude",
    lastAgent: null,
    summary: { text: "", throughTurn: 0 },
    messages: [],
  };
}
function expectPromptIsolated(prompt: string, fact: string): void {
  expect(prompt).not.toContain(fact);
  for (const fragment of DENY_FRAGMENTS) {
    expect(prompt).not.toContain(fragment);
  }
}
function readBody(bodies: Bodies) {
  return (messageId: string): { readonly author: string; readonly body: string } =>
    bodies.get(messageId) ?? { author: "operator", body: "" };
}
function question(): string {
  return "What is the exact read-proof fact token? Reply with only the token.";
}
function factToken(cell: string): string {
  return `MT7_READPROOF_${cell.replace(/[^a-z0-9]/gi, "_")}_${Date.now()}`;
}
function artifact(relativePath: string, text: string): string {
  const fullPath = path.join(ARTIFACT_DIR, relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, text, "utf8");
  return fullPath;
}
function cellPath(cell: string, file: string): string {
  return path.join(cell, file);
}
function saveEnv(): EnvSnapshot {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as EnvSnapshot;
}
function setEnv(mode: CarrierMode, dbPath: string): void {
  process.env.ZER0_MEMORY = "1";
  process.env.ZER0_NATIVE_RESUME = mode === "carrier-on" ? "1" : "off";
  process.env.ZER0_DB_PATH = dbPath;
  process.env.ZER0_DEBUG = "1";
}
function restoreEnv(saved: EnvSnapshot): void {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
}
function handleLiveSkip(
  error: unknown,
  lane: AgentName,
  cell: string,
  fact: string,
): never | undefined {
  const reason = clean(error instanceof Error ? error.message : String(error));
  if (!isSkippableLiveError(error)) {
    recordReceipt(
      `MT7_READPROOF lane=${lane} cell=${cell} factEcho=${fact} verdict=FAIL reason=${reason}`,
    );
    throw error;
  }
  recordReceipt(
    `MT7_READPROOF lane=${lane} cell=${cell} factEcho=${fact} verdict=SKIPPED reason=${reason}`,
  );
  if (ALLOW_SKIP) return;
  throw new Error(
    `READPROOF_SKIPPED_NOT_ALLOWED cell=${cell} lane=${lane} reason=${reason} set ZER0_READPROOF_ALLOW_SKIP=1 to permit missing CLI/auth skips`,
  );
}
function isSkippableLiveError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /auth|login|subscription|quota|rate.?limit|ENOENT|spawn|ACP.*closed|handshake|Antigravity|agy/i.test(
    text,
  );
}
function recordCell(
  lane: AgentName,
  cell: string,
  fact: string,
  verdict: "PASS" | "FAIL",
  proof: Proof,
): void {
  recordReceipt(
    `MT7_READPROOF lane=${lane} cell=${cell} factEcho=${fact} verdict=${verdict} debugArtifacts=${proof.artifacts.join(",")} reply=${clean(proof.reply)}`,
  );
}
function recordReceipt(line: string): void {
  console.log(line);
  mkdirSync(path.dirname(RECEIPT_FILE), { recursive: true });
  appendFileSync(RECEIPT_FILE, `${new Date().toISOString()} ${line}\n`, "utf8");
}
function clean(value: string): string {
  return value.replace(/[\r\n]+/g, " ").slice(0, 220);
}
