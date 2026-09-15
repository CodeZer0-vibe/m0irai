/**
 * @file src/chat/pty-binding.ts
 * @purpose Session-BOUND, offset-tracked transcript reads for persistent pty sessions (W1-T4a; G1).
 *   resolveBinding re-runs PER TURN — follows ROTATION to a newer log (claude /clear, codex
 *   rollout) and a TRUNCATION guard resets the offset instead of pointing past EOF. readTurnDelta
 *   returns only since-offset content; completion is STRUCTURED-MARKER-ONLY. rootDir injectable (tests).
 * @exports SessionBinding, ResolveOpts, TurnDelta, resolveBinding, readTurnDelta
 * @depends node:fs, node:os, node:path, ../adapters/pty/exe-resolver
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PtyAgent } from "../adapters/pty/exe-resolver.js";
import { readPidStatus } from "./pty-transcripts.js";

/** One native session log pinned to a live pty session, with the consumed byte offset. */
export interface SessionBinding {
  readonly agent: PtyAgent;
  readonly cwd: string;
  readonly spawnMs: number;
  readonly rootDir: string;
  readonly pid: number | undefined;
  /** The pinned session log (null until the native CLI creates one). */
  readonly file: string | null;
  /** Bytes already consumed from `file`; new turns read past this point. */
  readonly offset: number;
}

/** Inputs for (re-)resolving a binding; `prev` carries the pinned file + offset forward. */
export interface ResolveOpts {
  readonly cwd: string;
  readonly spawnMs: number;
  /** Override the log root for tests (default: the user home directory). */
  readonly rootDir?: string | undefined;
  /** claude only: the pty child pid whose status file names the live sessionId. */
  readonly pid?: number | undefined;
}

/** A turn read: the clean reply appended since the offset + the completion marker state. */
export interface TurnDelta {
  readonly reply: string;
  readonly complete: boolean;
  readonly binding: SessionBinding;
}

/**
 * Resolves the CURRENT native session log for the agent — called at every submit and during
 * polling (G1: per-turn, never spawn-once). Keeps `prev`'s offset only when the pinned file is
 * unchanged; a NEWER file (rotation) rebinds at offset 0.
 */
export function resolveBinding(
  agent: PtyAgent,
  opts: ResolveOpts,
  prev?: SessionBinding,
): SessionBinding {
  const rootDir = opts.rootDir ?? homedir();
  const file = currentSessionFile(agent, opts, rootDir);
  const samePin = prev !== undefined && prev.file !== null && prev.file === file;
  return {
    agent,
    cwd: opts.cwd,
    spawnMs: opts.spawnMs,
    rootDir,
    pid: opts.pid,
    file,
    offset: samePin ? prev.offset : 0,
  };
}

/**
 * Reads the turn delta: content appended to the pinned log AFTER the binding's offset, with the
 * agent's structured completion marker. The truncation guard (file shrank below the offset)
 * resets to 0 and rescans — recovery, never a hang (G1/F2c).
 */
export function readTurnDelta(binding: SessionBinding): TurnDelta {
  if (binding.file === null || !existsSync(binding.file)) {
    return { reply: "", complete: false, binding };
  }
  // Offsets are UTF-16 string indices (NOT byte counts — a byte offset slices multibyte content
  // mid-record). The truncation guard compares string length, not statSync().size (also bytes).
  const text = readFileSync(binding.file, "utf8");
  const offset = text.length < binding.offset ? 0 : binding.offset;
  const { records, consumed } = walkRecords(text, offset);
  const parsed = parseDelta(binding.agent, records);
  return {
    reply: parsed.reply,
    complete: parsed.complete,
    binding: { ...binding, offset: consumed },
  };
}

/**
 * Walks complete JSONL records from `offset`, returning the parsed records + how far it consumed.
 * A record is complete iff it JSON-parses — WITH OR WITHOUT a trailing newline (a CLI may not
 * newline-terminate its final record; codex re-review P1 #1). A trailing segment that FAILS to
 * parse is a partial write, left unconsumed for the next poll (codex P0 #1 split-line); a
 * newline-terminated line that fails to parse is garbled — skipped. UTF-16 string indices throughout.
 */
function walkRecords(text: string, offset: number): { records: unknown[]; consumed: number } {
  const records: unknown[] = [];
  let consumed = offset;
  while (consumed < text.length) {
    const nl = text.indexOf("\n", consumed);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(consumed, lineEnd).trim();
    if (line.length > 0) {
      try {
        records.push(JSON.parse(line));
      } catch {
        if (nl === -1) break; // partial final line — wait for the flush; do not consume
      }
    }
    if (nl === -1) {
      consumed = text.length;
      break;
    }
    consumed = nl + 1;
  }
  return { records, consumed };
}

function parseDelta(
  agent: PtyAgent,
  records: readonly unknown[],
): { reply: string; complete: boolean } {
  if (agent === "codex") return parseCodexDelta(records);
  return parseClaudeDelta(records);
}

/** codex rollout JSONL: agent_message carries text; task_complete is the ONLY terminal marker. */
function parseCodexDelta(records: readonly unknown[]): { reply: string; complete: boolean } {
  let last = "";
  let final = "";
  let complete = false;
  for (const rec of records) {
    const p = (
      rec as { payload?: { type?: string; message?: unknown; last_agent_message?: unknown } }
    ).payload;
    if (p === undefined) continue;
    if (p.type === "agent_message" && typeof p.message === "string") last = p.message;
    if (p.type === "task_complete") {
      complete = true;
      if (typeof p.last_agent_message === "string") final = p.last_agent_message;
    }
  }
  return { reply: (final || last).trim(), complete };
}

/** claude transcript JSONL: assistant text blocks; any new assistant text marks the delta complete
 *  (the SESSION layer additionally gates on the busy→idle status file before reading). */
function parseClaudeDelta(records: readonly unknown[]): { reply: string; complete: boolean } {
  const parts: string[] = [];
  for (const rec of records) {
    const o = rec as { type?: string; message?: { content?: unknown } };
    if (o.type === "assistant") parts.push(claudeAssistantText(o.message?.content));
  }
  const reply = parts.join("").trim();
  return { reply, complete: reply.length > 0 };
}

/** Extracts the text from one claude assistant message's `content` (string or text-block array). */
function claudeAssistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if ((block as { type?: string }).type !== "text") continue;
    const t = (block as { text?: unknown }).text;
    if (typeof t === "string") out.push(t);
  }
  return out.join("");
}

/** The CURRENT session log path per agent (newest matching file with mtime ≥ spawn − slack). */
function currentSessionFile(agent: PtyAgent, opts: ResolveOpts, rootDir: string): string | null {
  if (agent === "claude") {
    const sessionId = opts.pid === undefined ? undefined : readPidStatus(opts.pid)?.sessionId;
    if (sessionId === undefined) return null;
    const enc = opts.cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const file = join(rootDir, ".claude", "projects", enc, `${sessionId}.jsonl`);
    return existsSync(file) ? file : null;
  }
  // codex — the only other PtyAgent (gemini runs through the agy lane, not a PTY session).
  const dirs = codexDayDirs(rootDir, new Date(opts.spawnMs));
  for (const dir of dirs) {
    const hit = newestSince(dir, "rollout-", opts.spawnMs - 2_000);
    if (hit !== null) return hit;
  }
  return null;
}

function newestSince(dir: string, prefix: string, sinceMs: number): string | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  let best: { path: string; mtime: number } | null = null;
  for (const n of names) {
    if (!n.startsWith(prefix) || !n.endsWith(".jsonl")) continue;
    const p = join(dir, n);
    try {
      const st = statSync(p);
      if (!st.isFile() || st.mtimeMs < sinceMs) continue;
      if (best === null || st.mtimeMs > best.mtime) best = { path: p, mtime: st.mtimeMs };
    } catch {
      /* raced away */
    }
  }
  return best?.path ?? null;
}

function codexDayDirs(rootDir: string, spawn: Date): string[] {
  const base = join(rootDir, ".codex", "sessions");
  const dir = (d: Date): string =>
    join(
      base,
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    );
  return [
    dir(new Date(spawn.getTime() + 86_400_000)),
    dir(spawn),
    dir(new Date(spawn.getTime() - 86_400_000)),
  ];
}
