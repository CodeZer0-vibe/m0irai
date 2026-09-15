/**
 * @file src/chat/lane-carrier.fixtures.ts
 * @purpose Shared MT7 lane-carrier test fixtures (real SQLite temp dirs + fake CarrierTransport) —
 *   split out once lane-carrier.test.ts crossed gate-clamps' 600-line hard ceiling. Each split file
 *   calls registerLaneCarrierHooks() ONCE at its own top level; module state is per-test-file
 *   isolated by vitest's default isolation, never shared across split files.
 * @exports NOW, PROJECT, BINDING, NEVER_CANCELLED, root, registerLaneCarrierHooks, seeded, add,
 *   readBody, traceSink, transport, run, textOutsideUntrustedFrames
 * @depends node:fs, node:os, node:path, vitest, ../evidence/db, ../memory/ledger, ./lane-carrier
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { type Db, closeDb, openLaneStateDb } from "../evidence/db.js";
import { mintSeq } from "../memory/ledger.js";
import { type CarrierTransport, type CarrierTurnResult, runCarrierTurn } from "./lane-carrier.js";
import type { AgentName } from "./types.js";

const BEGIN_MARKER = "<<<BEGIN UNTRUSTED RECALLED MEMORY";
const END_MARKER = "<<<END UNTRUSTED RECALLED MEMORY>>>";

/** FL-150: CarrierTurnInput.signal is REQUIRED — a turn must name what can cancel it, because the one
 *  call site that could quietly omit it (headless-carrier's ACP branch) did, for the whole life of the
 *  defect. The ordinary fixtures below run turns that are never cancelled and say so; a suite that IS
 *  about cancellation passes its own controller's signal through `run`'s `extra`. */
export const NEVER_CANCELLED: AbortSignal = new AbortController().signal;

/**
 * The prompt text a provider reads as INSTRUCTIONS — everything outside the untrusted frames. K1 admits
 * derived memory into carrier prompts again, so "is it framed" replaces "is it absent" as the assertion
 * that matters: a recalled body appearing in THIS text would be memory the model may act on.
 *
 * @param prompt - the composed carrier prompt
 * @returns the prompt with every untrusted frame (markers and contents) removed
 */
export function textOutsideUntrustedFrames(prompt: string): string {
  let cursor = 0;
  let trusted = "";
  while (cursor < prompt.length) {
    const begin = prompt.indexOf(BEGIN_MARKER, cursor);
    if (begin < 0) return `${trusted}${prompt.slice(cursor)}`;
    trusted += prompt.slice(cursor, begin);
    const end = prompt.indexOf(END_MARKER, begin);
    if (end < 0) throw new Error("unclosed untrusted memory frame");
    cursor = end + END_MARKER.length;
  }
  return trusted;
}

export const NOW = "2026-07-10T00:00:00.000Z";
export const PROJECT = "p1";
export const BINDING = { adapterPkg: "pkg", adapterVersion: "1", cwd: "C:/repo" };

// A live ESM binding — T5 acceptance 10's lock test reads the CURRENT value after seeded() runs.
export let root: string | undefined;
const dbs: Db[] = [];
const saved = {
  debug: process.env.ZER0_DEBUG,
  memory: process.env.ZER0_MEMORY,
  resume: process.env.ZER0_NATIVE_RESUME,
};

/** Registers the shared env-flag + temp-dir/db cleanup hooks. Call ONCE at each split file's top level. */
export function registerLaneCarrierHooks(): void {
  beforeEach(() => {
    process.env.ZER0_DEBUG = "1";
    process.env.ZER0_MEMORY = "1";
    process.env.ZER0_NATIVE_RESUME = "1";
  });
  afterEach(() => {
    for (const db of dbs.splice(0)) closeDb(db);
    if (root !== undefined)
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    root = undefined;
    restoreEnv();
  });
}

function restoreEnv(): void {
  for (const [k, v] of Object.entries(saved)) {
    const key = `ZER0_${k.toUpperCase()}`;
    if (v === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = v;
  }
}

export function seeded(): { db: Db; bodies: Map<string, { author: string; body: string }> } {
  root = mkdtempSync(path.join(tmpdir(), "lane-carrier-"));
  const db = openLaneStateDb(path.join(root, "evidence.db"));
  dbs.push(db);
  db.prepare(
    "INSERT INTO projects(project_id, canonical_root, git_common_dir, created_at) VALUES (?,?,?,?)",
  ).run(PROJECT, "C:/repo", "C:/repo/.git", NOW);
  return { db, bodies: new Map() };
}

export function add(
  db: Db,
  bodies: Map<string, { author: string; body: string }>,
  id: string,
  author: string,
  body: string,
): void {
  bodies.set(id, { author, body });
  mintSeq(db, PROJECT, id);
}

export function readBody(bodies: Map<string, { author: string; body: string }>) {
  return (id: string): { author: string; body: string } =>
    bodies.get(id) ?? { author: "operator", body: "missing" };
}

export function traceSink(): {
  trace: { emit: (event: { phase: string; detail?: string }) => void };
  phases: string[];
} {
  const phases: string[] = [];
  return {
    trace: { emit: (event) => phases.push(`${event.phase}:${event.detail ?? ""}`) },
    phases,
  };
}

// The default fake StartResult carries a "created" modeApplied (B1/B2, MAX review fix round 1) —
// StartResult now requires it on "created" — so every caller not testing mode application itself
// still gets a well-formed result without repeating the field at every call site.
export function transport(
  starts: Awaited<ReturnType<CarrierTransport["start"]>>[],
  send: Awaited<ReturnType<CarrierTransport["send"]>> = { outcome: "accepted" },
): CarrierTransport & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    start: async () =>
      starts.shift() ?? {
        outcome: "created",
        sessionId: "s-new",
        modeApplied: { outcome: "applied", modeId: "default", origin: "confirmed" },
      },
    send: async (prompt) => {
      prompts.push(prompt);
      return send;
    },
  };
}

export async function run(
  db: Db,
  bodies: Map<string, { author: string; body: string }>,
  agent: AgentName,
  tx: CarrierTransport,
  extra = {},
): Promise<CarrierTurnResult> {
  return runCarrierTurn({
    agent,
    turn: 1,
    binding: BINDING,
    db,
    projectId: PROJECT,
    readBody: readBody(bodies),
    setup: "SETUP",
    operatorMessage: "Operator: now",
    transport: tx,
    signal: NEVER_CANCELLED,
    now: () => NOW,
    attemptId: () => `a-${agent}`,
    ...extra,
  });
}
