/**
 * @file src/memory/compaction-detect.ts
 * @purpose MT7 T4 per-lane compaction detector: turn-driven event, ctx%, and periodic re-carry arming.
 * @exports CompactionDetector, CompactionDetectorInput, createCompactionDetector
 * @depends ../evidence/db, ../shared/debug-mode, ./carrier-budget, ./journal-store, ./lane-cursor
 */
import type { Db } from "../evidence/db.js";
import { debugEnabled } from "../shared/debug-mode.js";
import { dropPct, periodicRecarryTurns, sustainPct, sustainTurns } from "./carrier-budget.js";
import type { MemoryTraceBus } from "./journal-store.js";
import { setBriefingCarry } from "./lane-cursor.js";

type CompactionKind = "detected" | "inferred";
type PromptAcceptedInput = { readonly carriedBriefing: boolean };

export interface CompactionDetectorInput {
  readonly agent: string;
  readonly db: Db;
  readonly now?: () => string;
  readonly projectId: string;
  readonly laneScopeId?: string;
  readonly trace?: MemoryTraceBus;
}

export interface CompactionDetector {
  onCtxPercent(pct: number): void;
  onLaneUpdate(update: unknown): void;
  onPromptAccepted(input: PromptAcceptedInput): void;
}

export function createCompactionDetector(input: CompactionDetectorInput): CompactionDetector {
  let highStreak = 0;
  let acceptedSinceCarry = 0;
  let previousPct: number | undefined;
  const now = input.now ?? nowIso;
  const arm = (kind: CompactionKind, reason: string): void => {
    setBriefingCarry(input.db, input.projectId, input.agent, now(), input.laneScopeId ?? "");
    emitTrace(input.trace, kind, `agent=${input.agent} reason=${reason}`);
  };
  return {
    onCtxPercent(pct) {
      if (!validPct(pct)) return;
      if (previousPct !== undefined && highStreak >= sustainTurns && previousPct - pct >= dropPct) {
        arm("inferred", `ctx_drop ${previousPct}->${pct}`);
      }
      highStreak = pct >= sustainPct ? highStreak + 1 : 0;
      previousPct = pct;
    },
    onLaneUpdate(update) {
      if (isCompactedUpdate(update)) arm("detected", "codex_thread_compacted");
    },
    onPromptAccepted(accepted) {
      if (accepted.carriedBriefing) {
        acceptedSinceCarry = 0;
        return;
      }
      acceptedSinceCarry += 1;
      if (acceptedSinceCarry >= periodicRecarryTurns) {
        arm("inferred", `periodic accepted=${acceptedSinceCarry}`);
        acceptedSinceCarry = 0;
      }
    },
  };
}

function isCompactedUpdate(update: unknown): boolean {
  if (!isRecord(update)) return false;
  if (update.method === "thread/compacted") return true;
  if (update.sessionUpdate !== "agent_message_chunk") return false;
  const content = update.content;
  if (!isRecord(content) || content.type !== "text" || typeof content.text !== "string") {
    return false;
  }
  return isCompactionText(content.text);
}

function isCompactionText(text: string): boolean {
  return (
    text === "*Context compacted to fit the model's context window.*\n\n" ||
    text === "Context compacted."
  );
}

function emitTrace(trace: MemoryTraceBus | undefined, kind: CompactionKind, detail: string): void {
  if (trace === undefined || !debugEnabled()) return;
  const phase = kind === "detected" ? "compaction.detected" : "compaction.inferred";
  trace.emit({ kind: "memory.trace", phase, turn: 0, detail });
}

function validPct(pct: number): boolean {
  return Number.isFinite(pct) && pct >= 0 && pct <= 100;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nowIso(): string {
  return new Date().toISOString();
}
