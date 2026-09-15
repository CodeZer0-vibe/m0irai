/**
 * @file src/chat/classify-intent.ts
 * @purpose Pure, deterministic, rule-based classifier mapping a plain message to a ChatMode
 *          (single/all/debate/research/build) with a human-readable reason. Reconciles with the
 *          existing ChatIntent taxonomy. No side effects, no I/O. VESTIGE SWEEP S8 (2026-07-17):
 *          the former write-confirm flag is DELETED — operator ruling (2) killed the y/n
 *          confirm-card apparatus (S5); dispatch is unconditional for write-capable classifications.
 * @exports classify, ClassifyContext
 * @depends ./types
 */
import {
  CREATE_KEYWORDS,
  DEBATE_LEADERS,
  DEBATE_PHRASES,
  DEBATE_WORDS,
  FIX_KEYWORDS,
  OPINION_PHRASES,
  PLURAL_AUDIENCE,
  RESEARCH_KEYWORDS,
  RESEARCH_WRITE_PHRASES,
  RESEARCH_WRITE_TARGET,
  WRITE_KEYWORDS,
} from "./classify-intent-keywords.js";
import type { ChatIntent, ChatMode, ClassifiedIntent } from "./types.js";

/**
 * Optional context for project-stage / quality signals (spec §8 forward pointers).
 * Present in the signature now so callers pass it without forcing a breaking change when
 * §8 lands; classification remains a pure function of (message, ctx).
 */
export interface ClassifyContext {
  /** Reserved for project-stage / quality-dial signals (spec §8). Unused in M2 rules. */
  readonly stage?: string;
}

/** Map the existing ChatIntent taxonomy onto a ChatMode (exhaustive; tsc-enforced). */
const INTENT_TO_MODE: Readonly<Record<ChatIntent, ChatMode>> = {
  build: "build",
  create: "build",
  fix: "build",
  research: "research",
  audit: "single",
  review: "single",
  plan: "single",
  opinion: "all",
  general: "single",
};

const WORD_PATTERN: RegExp = /[a-z0-9]+/i;

/**
 * Classify a plain message into a {@link ClassifiedIntent}.
 *
 * Precondition: `message` is the plain user text (the explicit `@agent`/`/command`
 * branches do NOT call this — INV-1).
 * Postcondition: returns the same value for the same (message, ctx) — pure + deterministic
 * (INV-5). Ambiguous / no-match → read-only `single` (or `all` for a plural audience);
 * NEVER `build` (AC-3).
 */
export function classify(message: string, _ctx?: ClassifyContext): ClassifiedIntent {
  const text = message.trim();
  if (text.length === 0) {
    return read("single", "empty or ambiguous input — defaulting to a single read-only reply");
  }

  const lower = text.toLowerCase();
  const first = firstWordOf(lower);

  // AC-1 opinions→all: an opinion request reaches the whole council even when it also
  // contains a debate word (e.g. "your opinion on rust vs go") — opinion wins over debate.
  if (isOpinion(lower)) {
    return read("all", "an opinion request — polling the whole council (read-only)");
  }

  if (isDebate(lower)) {
    return read("debate", "a decision between options — running a read-only debate");
  }

  if (matchesFirstWord(first, RESEARCH_KEYWORDS) || matchesPhraseStart(lower, RESEARCH_KEYWORDS)) {
    return classifyResearch(lower);
  }

  if (matchesFirstWord(first, WRITE_KEYWORDS)) {
    return classifyWrite(first);
  }

  if (hasPluralAudience(lower)) {
    return read("all", "addressed to the whole council — asking everyone (read-only)");
  }

  return read("single", "no write or council signal — answering as a single read-only reply");
}

function classifyResearch(lower: string): ClassifiedIntent {
  if (isResearchWrite(lower)) {
    return {
      mode: "research",
      reason: "research that persists output to disk — write-capable",
    };
  }
  return read("research", "an information-gathering request — running read-only research");
}

function classifyWrite(first: string): ClassifiedIntent {
  const intent = writeIntentFor(first);
  return {
    mode: INTENT_TO_MODE[intent],
    reason: `a ${intent} request that can modify the workspace`,
  };
}

function writeIntentFor(first: string): ChatIntent {
  if (FIX_KEYWORDS.includes(first)) return "fix";
  if (CREATE_KEYWORDS.includes(first)) return "create";
  return "build";
}

function isDebate(lower: string): boolean {
  if (DEBATE_PHRASES.some((p) => lower.includes(p))) return true;
  if (DEBATE_LEADERS.some((p) => lower.startsWith(p))) return true;
  const words = lower
    .split(/\s+/)
    .map(normalizeWord)
    .filter((w) => w.length > 0);
  return words.some((w) => DEBATE_WORDS.includes(w));
}

function hasPluralAudience(lower: string): boolean {
  return PLURAL_AUDIENCE.some((p) => lower.includes(p));
}

function isOpinion(lower: string): boolean {
  return OPINION_PHRASES.some((p) => lower.includes(p));
}

function isResearchWrite(lower: string): boolean {
  if (RESEARCH_WRITE_PHRASES.some((p) => lower.includes(p))) return true;
  return RESEARCH_WRITE_TARGET.test(lower);
}

function read(mode: Exclude<ChatMode, "build">, reason: string): ClassifiedIntent {
  return { mode, reason };
}

function matchesFirstWord(first: string, keywords: readonly string[]): boolean {
  return keywords.some((kw) => !kw.includes(" ") && kw === first);
}

function matchesPhraseStart(lower: string, keywords: readonly string[]): boolean {
  return keywords.some((kw) => kw.includes(" ") && lower.startsWith(kw));
}

function firstWordOf(lower: string): string {
  const head = lower.split(/\s/)[0] ?? "";
  return normalizeWord(head);
}

function normalizeWord(word: string): string {
  const match = word.match(WORD_PATTERN);
  return match !== null ? match[0] : "";
}
