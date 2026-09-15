/**
 * @file src/chat/flag-matrix-goldens.test.ts
 * @purpose T5 acceptance 5 / AC-3: COMMITTED byte goldens for the flag matrix. The three inert combos
 *   (all-off, memory-only, resume-only) must produce BYTE-IDENTICAL composePrompt output for BOTH
 *   laneClasses — pinned to committed fixture files so any future carrier-branch leakage into the
 *   flag-off path fails here byte-for-byte (all-off IS the pre-MT7 path). The positive combo pins the
 *   carrier prompt bytes (setup → briefing → delta → operator LAST) through runCarrierTurn with a
 *   deterministic harness. Regenerate deliberately with UPDATE_GOLDENS=1 (a diff in review is the point).
 * @exports (none — test file)
 * @depends vitest, node:fs, node:os, node:path, ../evidence/db, ../memory/lane-state, ../memory/ledger, ./headless-prompt, ./lane-carrier, ./session-store, ./types
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { type Db, closeDb, openLaneStateDb } from "../evidence/db.js";
import { mintSeq } from "../memory/ledger.js";
import { type LaneClass, composePrompt } from "./headless-prompt.js";
import { runCarrierTurn } from "./lane-carrier.js";
import type { ChatMessage, ChatSession } from "./types.js";

/** FL-150: CarrierTurnInput.signal is REQUIRED - a turn must name what can cancel it, because the ACP
 *  call site that could quietly omit it did, for the whole life of the defect. Nothing here cancels. */
const NEVER_CANCELLED: AbortSignal = new AbortController().signal;

const FIXTURES = path.resolve(import.meta.dirname, "__fixtures__");
const UPDATE = process.env.UPDATE_GOLDENS === "1";
const NOW = "2026-07-10T00:00:00.000Z";
const COMBOS = [
  { name: "all-off", memory: undefined, resume: undefined },
  { name: "memory-only", memory: "1", resume: undefined },
  { name: "resume-only", memory: undefined, resume: "1" },
] as const;

const saved = { memory: process.env.ZER0_MEMORY, resume: process.env.ZER0_NATIVE_RESUME };
let tempRoot: string | undefined;
const dbs: Db[] = [];

afterEach(() => {
  restore("ZER0_MEMORY", saved.memory);
  restore("ZER0_NATIVE_RESUME", saved.resume);
  for (const db of dbs.splice(0)) closeDb(db);
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    tempRoot = undefined;
  }
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

function setCombo(memory: string | undefined, resume: string | undefined): void {
  restore("ZER0_MEMORY", memory);
  restore("ZER0_NATIVE_RESUME", resume);
}

function message(id: string, turn: number, role: "user" | "agent", text: string): ChatMessage {
  return {
    id,
    turn,
    role,
    agent: role === "user" ? "user" : "claude",
    text,
    createdAt: NOW,
    status: "completed",
    tokenEstimate: Math.ceil(text.length / 4),
  };
}

function fixtureSession(): ChatSession {
  return {
    id: "chat-golden",
    repoRoot: "C:/repo",
    runDir: "C:/repo/.zer0/runs/chat-golden",
    createdAt: NOW,
    updatedAt: NOW,
    defaultAgent: "claude",
    lastAgent: null,
    summary: { text: "", throughTurn: 0 },
    messages: [
      message("g-m1", 1, "user", "hello team"),
      message("g-m2", 1, "agent", "claude reporting in"),
    ],
  };
}

function goldenPath(name: string): string {
  return path.join(FIXTURES, `${name}.golden.txt`);
}

function assertGolden(name: string, actual: string): void {
  const file = goldenPath(name);
  if (UPDATE) {
    writeFileSync(file, actual, "utf8");
    return;
  }
  expect(actual).toBe(readFileSync(file, "utf8"));
}

it("the three INERT flag combos produce byte-identical composePrompt output for both laneClasses (committed goldens)", () => {
  for (const laneClass of ["chat", "dispatch"] as LaneClass[]) {
    const outputs = COMBOS.map((combo) => {
      setCombo(combo.memory, combo.resume);
      return composePrompt(fixtureSession(), "Operator: status?", "claude", 2, laneClass);
    });
    for (const output of outputs.slice(1)) {
      expect(output).toBe(outputs[0]); // inert combos are indistinguishable from all-off
    }
    assertGolden(`flag-inert-${laneClass}`, outputs[0] ?? "");
  }
});

it("the POSITIVE combo pins the carrier prompt bytes: setup, briefing, delta, operator LAST", async () => {
  setCombo("1", "1");
  tempRoot = mkdtempSync(path.join(tmpdir(), "flag-golden-"));
  const db = openLaneStateDb(path.join(tempRoot, "evidence.db"));
  dbs.push(db);
  db.prepare(
    "INSERT INTO projects(project_id, canonical_root, git_common_dir, created_at) VALUES (?,?,?,?)",
  ).run("p1", "C:/repo", "C:/repo/.git", NOW);
  const bodies = new Map([
    ["g-m1", { author: "operator", body: "hello team" }],
    ["g-m2", { author: "claude", body: "claude reporting in" }],
  ]);
  for (const id of ["g-m1", "g-m2"]) mintSeq(db, "p1", id);

  const prompts: string[] = [];
  const result = await runCarrierTurn({
    agent: "claude",
    turn: 1,
    binding: { adapterPkg: "pkg", adapterVersion: "1", cwd: "C:/repo" },
    db,
    projectId: "p1",
    readBody: (id) => bodies.get(id) ?? { author: "operator", body: "missing" },
    setup: "GOLDEN SETUP",
    operatorMessage: "Operator: status?",
    signal: NEVER_CANCELLED,
    transport: {
      start: async () => ({
        outcome: "created",
        sessionId: "s-golden",
        modeApplied: { outcome: "applied", modeId: "default", origin: "confirmed" },
      }),
      send: async (prompt) => {
        prompts.push(prompt);
        return { outcome: "accepted" };
      },
    },
    now: () => NOW,
    attemptId: () => "a-golden",
  });
  expect(result.outcome).toBe("accepted");
  const prompt = prompts[0] ?? "";
  expect(prompt.endsWith("Operator: status?")).toBe(true); // operator rides LAST, uncut
  assertGolden("flag-positive-carrier", prompt);
});
