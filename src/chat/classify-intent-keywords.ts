/**
 * @file src/chat/classify-intent-keywords.ts
 * @exports WRITE_KEYWORDS, DESTRUCTIVE_KEYWORDS, FIX_KEYWORDS, CREATE_KEYWORDS, RESEARCH_KEYWORDS, DEBATE_PHRASES, DEBATE_WORDS, DEBATE_LEADERS, PLURAL_AUDIENCE, OPINION_PHRASES, RESEARCH_WRITE_PHRASES, RESEARCH_WRITE_TARGET
 * @depends (none)
 * @purpose The pure keyword / phrase / regex TABLES the intent classifier reads — write/research/debate/
 *          plural-audience/opinion signals + the research-write detectors. Extracted from
 *          classify-intent.ts so the classifier logic stays under the line cap and the lexicon is its
 *          own cohesive, reviewable unit. Data only — no functions, no I/O.
 *          VESTIGE SWEEP S3 (2026-07-17): this is now the SINGLE SOURCE OF TRUTH for the write lexicon —
 *          message-router-intent.ts re-exports WRITE_KEYWORDS/FIX_KEYWORDS/CREATE_KEYWORDS/RESEARCH_KEYWORDS
 *          from here instead of keeping its own drifted copy (the referee-proven mirror gap: the router's
 *          old local list lacked refactor/scaffold/generate/repair/debug entirely, so a first-word "repair"
 *          or "debug" message fell through to general/read-only instead of reaching the fix/create
 *          narrowing that already existed for it).
 */

/** First-word-anchored write keywords — the complete write lexicon (constructive + destructive). */
export const WRITE_KEYWORDS: readonly string[] = [
  "build",
  "implement",
  "fix",
  "edit",
  "change",
  "wire",
  "create",
  "add",
  "write",
  "refactor",
  "scaffold",
  "generate",
  "repair",
  "debug",
  "delete",
  "remove",
  "rm",
  "erase",
  "drop",
  "clean up",
];

/**
 * The destructive subset of WRITE_KEYWORDS (VESTIGE SWEEP S3). A dedicated export — not just membership in
 * WRITE_KEYWORDS — because message-router-intent.ts's containsWriteVerb (its anywhere-in-text match) treats
 * this subset differently: an explanatory/interrogative opening ("explain how to delete X", "how would I
 * remove Y") must NOT grant write-intent from a destructive verb alone, since BUILD mode hands the agent the
 * real worktree with no --sandbox (referee A-S3 CONCERN). Constructive verbs keep the unconditional
 * anywhere-match (unchanged, pre-existing, load-bearing for natural phrasing like "can you … and write X").
 */
export const DESTRUCTIVE_KEYWORDS: readonly string[] = [
  "delete",
  "remove",
  "rm",
  "erase",
  "drop",
  "clean up",
];

export const FIX_KEYWORDS: readonly string[] = ["fix", "repair", "debug"];
export const CREATE_KEYWORDS: readonly string[] = ["create", "scaffold", "generate"];

/** First-word-anchored read-only research keywords (mirror message-router RESEARCH_KEYWORDS). */
export const RESEARCH_KEYWORDS: readonly string[] = [
  "research",
  "verify",
  "look up",
  "latest",
  "current",
  "find",
  "compare",
  "investigate",
];

/** Debate signals: a decision between options. Matched anywhere (not first-word). */
export const DEBATE_PHRASES: readonly string[] = ["tradeoff", "trade-off", "trade off"];
export const DEBATE_WORDS: readonly string[] = ["vs", "versus", "decide", "either"];
export const DEBATE_LEADERS: readonly string[] = ["should we", "should i", "which is better"];

/** Plural-audience signals → ask everyone (read-only `all`). Matched anywhere. */
export const PLURAL_AUDIENCE: readonly string[] = [
  "you all",
  "you guys",
  "everyone",
  "everybody",
  "all of you",
  "you three",
];

/**
 * Opinion signals → poll the whole council (read-only `all`), even when phrased to a single agent. A
 * SINGULAR "what is your opinion on X" / "your thoughts on X" is still an opinion request and must reach
 * mode `all` (spec AC-1, §49 "opinions→all"). Matched anywhere so it survives a leading "@agent"-less
 * plain message.
 */
export const OPINION_PHRASES: readonly string[] = [
  "your opinion",
  "an opinion",
  "what do you think",
  "what's your take",
  "what is your take",
  "your take on",
  "thoughts on",
  "your thoughts",
];

/** Phrases that make a research request write-capable (persisting output to disk). */
export const RESEARCH_WRITE_PHRASES: readonly string[] = [
  "write the results",
  "write the findings",
  "save the results",
  "save the findings",
  "write it to a file",
  "save to a file",
  "write to a file",
  "save it to disk",
  "write to disk",
];

/**
 * A persist verb (create/write/save/output/generate) followed by a concrete file target — a path
 * containing `/` or a `name.ext` filename (e.g. "create docs/report.md"). Catches a research write-tail
 * that names an artifact, which `RESEARCH_WRITE_PHRASES` misses (it only covers generic "to a
 * file"/"to disk" tails). Pure regex — no I/O.
 */
export const RESEARCH_WRITE_TARGET: RegExp =
  /\b(?:create|write|save|output|generate)\b[\s\S]*?(?:[\w./-]*\/[\w./-]+|\b[\w-]+\.[a-z0-9]{1,5}\b)/i;
