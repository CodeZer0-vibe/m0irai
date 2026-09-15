/**
 * @file src/chat/message-router-intent.ts
 * @exports WRITE_INTENT_KEYWORDS, DESTRUCTIVE_KEYWORDS, RESEARCH_KEYWORDS, detectIntent, detectWriteIntent, dispatchModeForIntent, detectSandbox, matchesKeyword, firstWordOf, containsWriteVerb
 * @depends ./types, ./classify-intent-keywords
 * @purpose Pure intent-from-text helpers for the message router: first-word-anchored keyword matching
 *          that maps a plain message to a ChatIntent / DispatchMode / sandbox. Extracted from
 *          message-router.ts so the top-level parse dispatcher stays under the line cap and the "intent
 *          classification" concern is its own cohesive unit. No side effects, no I/O.
 *          VESTIGE SWEEP S3 (2026-07-17): the keyword TABLES are no longer defined here — they are
 *          re-exported from classify-intent-keywords.ts, the single source of truth (referee-proven: this
 *          file's old local copy silently drifted from classify-intent's, missing refactor/scaffold/
 *          generate/repair/debug entirely). WRITE_INTENT_KEYWORDS is an alias of that module's
 *          WRITE_KEYWORDS — same array, kept under this file's established export name so existing call
 *          sites need no rename.
 */
import {
  CREATE_KEYWORDS,
  DESTRUCTIVE_KEYWORDS,
  FIX_KEYWORDS,
  RESEARCH_KEYWORDS,
  WRITE_KEYWORDS as WRITE_INTENT_KEYWORDS,
} from "./classify-intent-keywords.js";
import type { ChatIntent, DispatchMode } from "./types.js";

export { DESTRUCTIVE_KEYWORDS, RESEARCH_KEYWORDS, WRITE_INTENT_KEYWORDS };

const FIRST_WORD_PATTERN: RegExp = /[a-z0-9]+/i;
const EXPLICIT_BUILD_KEYWORDS: readonly string[] = ["build"];

/** The ChatIntent implied by a plain (non-@/non-slash) message — write/research/review/audit/plan/general. */
export function detectIntent(text: string): ChatIntent {
  if (matchesKeyword(text, WRITE_INTENT_KEYWORDS) || containsWriteVerb(text)) {
    return detectWriteIntent(text);
  }
  if (matchesKeyword(text, RESEARCH_KEYWORDS)) return "research";
  const first = firstWordOf(text);
  if (first === "review" || first === "check") return "review";
  if (first === "audit") return "audit";
  if (first === "plan" || first === "design") return "plan";
  return "general";
}

/** Narrows a write-keyword message to fix/create/build by its leading verb. */
export function detectWriteIntent(text: string): ChatIntent {
  if (matchesKeyword(text, FIX_KEYWORDS)) return "fix";
  if (matchesKeyword(text, CREATE_KEYWORDS)) return "create";
  return "build";
}

/** The DispatchMode for a ChatIntent: build/fix/create → pipeline; research/review/audit → tools; else text-only. */
export function dispatchModeForIntent(intent: ChatIntent): DispatchMode {
  if (intent === "build" || intent === "fix" || intent === "create") {
    return "pipeline";
  }
  if (intent === "research" || intent === "review" || intent === "audit") {
    return "tools";
  }
  return "text-only";
}

/** Codex sandbox: workspace-write only when the text leads with `build`, else read-only. */
export function detectSandbox(text: string): "read-only" | "workspace-write" {
  return matchesKeyword(text, EXPLICIT_BUILD_KEYWORDS) ? "workspace-write" : "read-only";
}

// A leading interrogative/explanatory word means the message is ASKING ABOUT an action, not ordering one —
// checked against the first 3 words so a short filler ("well, how do I…") doesn't defeat it. Only gates the
// DESTRUCTIVE subset (see containsWriteVerb); constructive verbs keep their unconditional anywhere-match.
const EXPLANATORY_LEADS: readonly string[] = [
  "how",
  "what",
  "why",
  "explain",
  "describe",
  "when",
  "is",
  "are",
  "can",
  "could",
  "should",
  "would",
  "do",
  "does",
  "tell",
];

const CONSTRUCTIVE_KEYWORDS: readonly string[] = WRITE_INTENT_KEYWORDS.filter(
  (kw) => !DESTRUCTIVE_KEYWORDS.includes(kw),
);

/**
 * True iff a write verb (build/create/edit/write/add/…) appears as a whole word ANYWHERE in the message —
 * so a natural phrasing ("can you write a file", "please add a test") is recognized as a write task, not
 * only when the verb leads. This grants the agent its write capability; the agent still decides whether to
 * actually edit based on the task's context (real coding-agent behaviour). Constructive verbs are
 * UNCONDITIONAL here — unchanged since before VESTIGE SWEEP S3, load-bearing for that natural phrasing.
 *
 * VESTIGE SWEEP S3 (2026-07-17): a DESTRUCTIVE verb (delete/remove/rm/erase/drop/clean up) gets an EXTRA
 * guard the constructive verbs do not. "@gemini explain how to delete a branch" must stay explanatory, not
 * become a real deletion order — BUILD mode hands the agent the real worktree with no --sandbox (referee
 * A-S3 CONCERN), so a false positive here has a materially higher blast radius than a constructive one. A
 * message opening with an explanatory/interrogative lead does not grant write-intent from a destructive
 * verb alone; an imperative destructive verb (no such lead) still does. This is a first-3-words heuristic,
 * not NLU — "can you delete the temp branch" (a polite imperative) is deliberately treated as explanatory
 * too, erring toward the safe fallback (read-only) on ambiguity, matching this router's existing
 * error-toward-safe philosophy elsewhere (message-router-multi.ts's dependency detector, same rationale).
 */
export function containsWriteVerb(text: string): boolean {
  const lower = text.toLowerCase();
  if (CONSTRUCTIVE_KEYWORDS.some((kw) => new RegExp(`\\b${kw}\\b`).test(lower))) {
    return true;
  }
  const destructiveHit = DESTRUCTIVE_KEYWORDS.some((kw) => new RegExp(`\\b${kw}\\b`).test(lower));
  return destructiveHit && !isExplanatoryLead(lower);
}

function isExplanatoryLead(lower: string): boolean {
  const leadWords = lower
    .split(/\s+/)
    .slice(0, 3)
    .map((w) => w.replace(/[^a-z0-9]/gi, ""));
  return leadWords.some((w) => EXPLANATORY_LEADS.includes(w));
}

/** True iff `text` matches a keyword: a multi-word keyword by prefix, a single word by FIRST word. */
export function matchesKeyword(text: string, keywords: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) =>
    kw.includes(" ") ? lower.startsWith(kw) : firstWordOf(text) === kw,
  );
}

/** The first alphanumeric word of `text`, lower-cased (the anchor for keyword matching). */
export function firstWordOf(text: string): string {
  const lower = text.toLowerCase();
  const word = lower.split(/\s/)[0] ?? "";
  const match = word.match(FIRST_WORD_PATTERN);
  return match !== null ? match[0] : "";
}
