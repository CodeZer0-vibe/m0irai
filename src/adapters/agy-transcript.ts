/**
 * @file src/adapters/agy-transcript.ts
 * @purpose Recovers agy's CLEAN final answer from its OWN structured transcript instead of the flattened
 *   `-p` stdout (which interleaves "I will list/view/search…" narration + tool steps with the answer). agy
 *   writes ~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl per turn; the
 *   final answer is the LAST MODEL PLANNER_RESPONSE. Matched to our one-shot turn by the context-file ref
 *   in USER_INPUT + a spawn-time floor. Returns undefined when none matches → adapter falls back to stdout.
 * @exports readAgyCleanReply, readAgyConversationId
 * @depends node:fs, node:os, node:path
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_BRAIN_DIR = join(homedir(), ".gemini", "antigravity-cli", "brain");
// Tolerate small clock/flush skew between our spawn timestamp and the transcript's first write.
const MTIME_SKEW_MS = 10_000;

interface TranscriptStep {
  type?: string;
  source?: string;
  content?: string;
}

/**
 * Reads agy's clean final answer for the turn whose USER_INPUT contains `signature`, written at/after
 * `sinceMs`. The answer is the LAST MODEL PLANNER_RESPONSE — which excludes every "I will …" narration
 * step (those precede tool calls) and mid-turn status.
 *
 * @param signature - a substring unique to this turn's prompt (the context-file ref in readInstruction)
 * @param sinceMs - the dispatch timestamp; transcripts older than sinceMs - skew are ignored
 * @param brainDir - the agy brain root (injectable for tests; defaults to ~/.gemini/antigravity-cli/brain)
 * @returns the clean final answer, or undefined when no matching transcript exists
 */
export function readAgyCleanReply(
  signature: string,
  sinceMs: number,
  brainDir: string = DEFAULT_BRAIN_DIR,
): string | undefined {
  if (!existsSync(brainDir)) {
    return undefined;
  }
  const match = findTurnMatch(brainDir, signature, sinceMs);
  if (match === undefined) {
    return undefined;
  }
  const reply = lastModelAnswer(match.file);
  return reply !== undefined && reply.length > 0 ? reply : undefined;
}

/**
 * The agy CONVERSATION ID for the turn whose USER_INPUT contains `signature`, written at/after sinceMs - skew
 * — i.e. the `brain/<id>` directory agy created/used for this turn. Reused as `--conversation <id>` so a LATER
 * turn resumes THIS session's conversation; the id survives a changing per-turn workspace (verified), which
 * `--continue` (most-recent) did not. Returns undefined when no matching transcript exists (turn-1 capture
 * failed ⇒ the next turn starts fresh — graceful, never a hang).
 *
 * @param signature - a substring unique to this turn's prompt (the context-file ref in readInstruction)
 * @param sinceMs - the dispatch timestamp; transcripts older than sinceMs - skew are ignored
 * @param brainDir - the agy brain root (injectable for tests; defaults to ~/.gemini/antigravity-cli/brain)
 * @returns the conversation id, or undefined when no matching transcript exists
 */
export function readAgyConversationId(
  signature: string,
  sinceMs: number,
  brainDir: string = DEFAULT_BRAIN_DIR,
): string | undefined {
  if (!existsSync(brainDir)) {
    return undefined;
  }
  return findTurnMatch(brainDir, signature, sinceMs)?.id;
}

/** One matched turn: agy's conversation id (the brain/<id> dir name) + its transcript file path. */
interface TurnMatch {
  readonly id: string;
  readonly file: string;
}

/** Newest brain conversation (id + transcript.jsonl) whose USER_INPUT contains `signature`, touched at/after
 *  sinceMs - skew. The dir id IS agy's conversation id — the handle used to resume the turn. */
function findTurnMatch(
  brainDir: string,
  signature: string,
  sinceMs: number,
): TurnMatch | undefined {
  const floor = sinceMs - MTIME_SKEW_MS;
  let best: { id: string; file: string; mtimeMs: number } | undefined;
  for (const id of safeReaddir(brainDir)) {
    const file = join(brainDir, id, ".system_generated", "logs", "transcript.jsonl");
    const mtimeMs = safeMtime(file);
    if (mtimeMs === undefined || mtimeMs < floor) {
      continue;
    }
    if (firstLineMatches(file, signature) && (best === undefined || mtimeMs > best.mtimeMs)) {
      best = { id, file, mtimeMs };
    }
  }
  return best === undefined ? undefined : { id: best.id, file: best.file };
}

/** The content of the LAST MODEL PLANNER_RESPONSE step — agy's terminal answer for the turn. */
function lastModelAnswer(file: string): string | undefined {
  let answer: string | undefined;
  for (const line of safeReadLines(file)) {
    const step = parseStep(line);
    if (
      step?.type === "PLANNER_RESPONSE" &&
      step.source === "MODEL" &&
      typeof step.content === "string"
    ) {
      answer = step.content;
    }
  }
  return answer?.trim();
}

function parseStep(line: string): TranscriptStep | undefined {
  if (!line.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(line) as TranscriptStep;
  } catch {
    return undefined;
  }
}

function firstLineMatches(file: string, signature: string): boolean {
  // Collapse backslash runs to "/" on both sides: the transcript JSON-escapes Windows paths
  // ("C:\\Users\\…") while a build-mode signature is a raw path ("C:\Users\…"); chat basenames are
  // unaffected. Without this, build-mode turns never match their transcript and fall back to stdout.
  const head = (safeReadLines(file)[0] ?? "").replace(/\\+/g, "/");
  return head.includes(signature.replace(/\\+/g, "/"));
}

function safeReadLines(file: string): string[] {
  try {
    return readFileSync(file, "utf8").split("\n");
  } catch {
    return [];
  }
}

function safeMtime(file: string): number | undefined {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
