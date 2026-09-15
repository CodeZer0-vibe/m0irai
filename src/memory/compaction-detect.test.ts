/**
 * @file src/memory/compaction-detect.test.ts
 * @purpose MT7 T4 falsifiers for per-lane compaction detection, ctx%-drop inference, periodic re-carry,
 *   detector-never-clears, and debug-gated memory.trace pulses against real sqlite.
 * @exports (none - test suite)
 * @depends vitest, node:fs, node:os, node:path, ../evidence/db, ../chat/events, ./compaction-detect, ./lane-state
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ChatEventBus, type MemoryTraceEvent } from "../chat/events.js";
import { type Db, closeDb, openLaneStateDb } from "../evidence/db.js";
import { periodicRecarryTurns } from "./carrier-budget.js";
import { createCompactionDetector } from "./compaction-detect.js";
import {
  advanceCursorOnAccept,
  bumpGeneration,
  getLaneCursor,
  recordPromptAttempt,
} from "./lane-state.js";

const T0 = "2026-07-10T00:00:00Z";
const T1 = "2026-07-10T00:00:01Z";
const T2 = "2026-07-10T00:00:02Z";
const T3 = "2026-07-10T00:00:03Z";
const REAL_DEBUG = process.env.ZER0_DEBUG;
let tempRoot: string | undefined;
const handles: Db[] = [];

const COMPACTED_UPDATE = {
  content: { text: "*Context compacted to fit the model's context window.*\n\n", type: "text" },
  sessionUpdate: "agent_message_chunk",
};

const BOUNDARY_CASES = [
  { name: "same fall without sustain prefix -> NO trigger", readings: [70, 40], armed: false },
  {
    name: "29-point fall after sustain prefix -> NO trigger",
    readings: [70, 70, 41],
    armed: false,
  },
  { name: "30-point fall after sustain prefix -> trigger", readings: [70, 70, 40], armed: true },
  {
    name: "69% sustain prefix then 30-point fall -> NO trigger",
    readings: [69, 69, 39],
    armed: false,
  },
  { name: "70% sustain prefix then 30-point fall -> trigger", readings: [70, 70, 40], armed: true },
] as const;

beforeEach(() => {
  process.env.ZER0_DEBUG = "1";
});

afterEach(() => {
  for (const db of handles.splice(0)) closeDb(db);
  if (tempRoot !== undefined) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
  if (REAL_DEBUG === undefined) process.env.ZER0_DEBUG = "0";
  else process.env.ZER0_DEBUG = REAL_DEBUG;
});

function openSeeded(): Db {
  tempRoot = mkdtempSync(path.join(tmpdir(), "compaction-detect-"));
  const db = openLaneStateDb(path.join(tempRoot, "evidence.db"));
  handles.push(db);
  db.prepare(
    "INSERT INTO projects(project_id, canonical_root, git_common_dir, created_at) VALUES (?,?,?,?)",
  ).run("p1", "C:/tmp/p", "C:/tmp/p/.git", T0);
  return db;
}

function detector(db: Db, events: MemoryTraceEvent[] = []) {
  const bus = new ChatEventBus();
  bus.on("memory.trace", (event) => events.push(event));
  return createCompactionDetector({
    agent: "codex",
    db,
    now: () => T3,
    projectId: "p1",
    trace: bus,
  });
}

function cursorCount(db: Db): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS count FROM lane_cursors WHERE project_id = ? AND agent = ? LIMIT 1",
    )
    .get("p1", "codex") as { count: number };
  return row.count;
}

it("codex compaction event arms one durable flag and emits a detected memory trace", () => {
  const db = openSeeded();
  const events: MemoryTraceEvent[] = [];
  const d = detector(db, events);
  d.onLaneUpdate(COMPACTED_UPDATE);
  d.onLaneUpdate(COMPACTED_UPDATE);
  expect(getLaneCursor(db, "p1", "codex")?.needsBriefingCarry).toBe(true);
  expect(cursorCount(db)).toBe(1);
  expect(events.map((event) => event.phase)).toEqual([
    "compaction.detected",
    "compaction.detected",
  ]);
});

it.each(BOUNDARY_CASES)("ctx% boundary: $name", ({ readings, armed }) => {
  const db = openSeeded();
  const d = detector(db);
  for (const pct of readings) d.onCtxPercent(pct);
  expect(getLaneCursor(db, "p1", "codex")?.needsBriefingCarry ?? false).toBe(armed);
});

it("periodic accepted-prompt recarry arms exactly on turn 15 with no signal source", () => {
  const db = openSeeded();
  const events: MemoryTraceEvent[] = [];
  const d = detector(db, events);
  for (let turn = 1; turn < periodicRecarryTurns; turn += 1) {
    d.onPromptAccepted({ carriedBriefing: false });
  }
  expect(getLaneCursor(db, "p1", "codex")).toBeUndefined();
  d.onPromptAccepted({ carriedBriefing: false });
  expect(getLaneCursor(db, "p1", "codex")?.needsBriefingCarry).toBe(true);
  expect(events.at(-1)).toMatchObject({
    detail: expect.stringContaining("periodic"),
    phase: "compaction.inferred",
  });
});

it("carried briefing resets the periodic counter before the fifteenth uncarried accept", () => {
  const db = openSeeded();
  const d = detector(db);
  for (let turn = 1; turn < periodicRecarryTurns; turn += 1) {
    d.onPromptAccepted({ carriedBriefing: false });
  }
  d.onPromptAccepted({ carriedBriefing: true });
  d.onPromptAccepted({ carriedBriefing: false });
  expect(getLaneCursor(db, "p1", "codex")).toBeUndefined();
});

async function clearViaAcceptedCarry(db: Db): Promise<void> {
  bumpGeneration(db, {
    adapterPkg: "codex-acp",
    adapterVersion: "1.1.2",
    agent: "codex",
    cwd: "C:/tmp/p",
    now: T0,
    projectId: "p1",
    sessionId: "s1",
  });
  recordPromptAttempt(db, {
    agent: "codex",
    attemptId: "a1",
    generation: 1,
    projectId: "p1",
    sentAt: T1,
    seqFrom: 1,
    seqTo: 1,
    sessionId: "s1",
  });
  await advanceCursorOnAccept(db, {
    agent: "codex",
    attemptId: "a1",
    clearBriefingCarry: true,
    generation: 1,
    lastSeq: 1,
    now: T2,
    projectId: "p1",
    sessionId: "s1",
  });
}

it("the detector never clears; external accepted-carry clears and the next signal re-arms", async () => {
  const db = openSeeded();
  const d = detector(db);
  d.onLaneUpdate(COMPACTED_UPDATE);
  expect(getLaneCursor(db, "p1", "codex")?.needsBriefingCarry).toBe(true);
  await clearViaAcceptedCarry(db);
  expect(getLaneCursor(db, "p1", "codex")?.needsBriefingCarry).toBe(false);
  d.onCtxPercent(70);
  d.onCtxPercent(70);
  d.onCtxPercent(40);
  expect(getLaneCursor(db, "p1", "codex")).toMatchObject({
    needsBriefingCarry: true,
    updatedAt: T3,
  });
});
