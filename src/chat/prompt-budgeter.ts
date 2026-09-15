/**
 * @file src/chat/prompt-budgeter.ts
 * @purpose Deterministic section budgeter for chat prompts.
 * @exports CHAT_TOKEN_BUDGET, CHAT_TARGET_TOKEN_BUDGET, CHAT_CHARS_PER_TOKEN, PromptSection, PromptSectionKey, budgetPromptSections, estimatePromptTokens
 * @depends ../memory/untrusted-framing, ../shared/error-codes, ../shared/errors
 */
import { frameSafeKeepFromStart } from "../memory/untrusted-framing.js";
import { Zer0ErrorCode } from "../shared/error-codes.js";
import { ContextError } from "../shared/errors.js";

export const CHAT_TOKEN_BUDGET: number = 60_000;
export const CHAT_TARGET_TOKEN_BUDGET: number = 56_000;
export const CHAT_CHARS_PER_TOKEN: number = 4;

const SECTION_SEPARATOR: string = "\n\n---\n\n";
const TRIM_ORDER: readonly PromptSectionKey[] = ["older-context", "memory", "transcript"];

export type PromptSectionKey =
  | "standing"
  | "request"
  | "peers"
  | "transcript"
  | "older-context"
  | "project-state"
  | "memory"
  | "instructions";

export interface PromptSection {
  readonly key: PromptSectionKey;
  readonly content: string;
}

export function estimatePromptTokens(text: string): number {
  return Math.ceil(text.length / CHAT_CHARS_PER_TOKEN);
}

export function budgetPromptSections(sections: readonly PromptSection[]): string {
  assertMustKeepFits(sections);
  let budgeted = [...sections];
  for (const key of TRIM_ORDER) {
    const assembled = joinSections(budgeted);
    const excessTokens = estimatePromptTokens(assembled) - CHAT_TARGET_TOKEN_BUDGET;
    if (excessTokens <= 0) return assembled;
    budgeted = trimSection(budgeted, key, excessTokens * CHAT_CHARS_PER_TOKEN);
  }
  const assembled = joinSections(budgeted);
  if (estimatePromptTokens(assembled) > CHAT_TOKEN_BUDGET) {
    throwBudgetError("assembled prompt", estimatePromptTokens(assembled), CHAT_TOKEN_BUDGET);
  }
  return assembled;
}

function assertMustKeepFits(sections: readonly PromptSection[]): void {
  const mustKeep = sections.filter((s) => s.key === "request" || s.key === "peers");
  const tokens = estimatePromptTokens(joinSections(mustKeep));
  if (tokens > CHAT_TOKEN_BUDGET) {
    throwBudgetError("current request plus peer outputs", tokens, CHAT_TOKEN_BUDGET);
  }
}

// BLOCK 2 fix (codex sol MAX review round 1): the pre-fix character-level slice could land INSIDE a
// section's own untrusted frame (transcript and memory sections both carry delimitUntrusted output —
// buildTranscript's prior-session lines, loadMemory's recalled findings/snapshot), dropping the
// frame's opening delimiter while keeping its content + closing delimiter. An unclosed frame then
// mislabels every section that follows it as still-untrusted. frameSafeKeepFromStart is applied to
// the FINAL slice point (after reserving 3 chars for the "..." suffix) — not just the naive pre-
// reservation value — since subtracting those 3 chars could otherwise re-open the same wound.
function trimSection(
  sections: readonly PromptSection[],
  key: PromptSectionKey,
  excessChars: number,
): PromptSection[] {
  const index = sections.findIndex((section) => section.key === key);
  if (index < 0) return [...sections];
  const section = sections[index] ?? { key, content: "" };
  const naiveKeep = Math.max(0, section.content.length - excessChars);
  if (naiveKeep === 0) return sections.filter((_, i) => i !== index);
  const sliceEnd = frameSafeKeepFromStart(section.content, Math.max(0, naiveKeep - 3));
  if (sliceEnd === 0) return sections.filter((_, i) => i !== index);
  return sections.map((item, i) =>
    i === index ? { ...item, content: `${item.content.slice(0, sliceEnd)}...` } : item,
  );
}

function joinSections(sections: readonly PromptSection[]): string {
  return sections.map((section) => section.content).join(SECTION_SEPARATOR);
}

function throwBudgetError(subject: string, tokens: number, budget: number): never {
  throw new ContextError(
    `Chat prompt aborted: ${subject} requires ${String(tokens)} estimated tokens, exceeding budget ${String(budget)}.`,
    Zer0ErrorCode.ContextOverBudget,
  );
}
