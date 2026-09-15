/**
 * @file src/chat/message-router.ts
 * @purpose Parse user input (@agent, /commands, keywords) into ChatRoute + extracted text.
 * @exports ParsedInput, parseInput, isSlashExit, AGENT_PREFIX_PATTERN
 * @depends ./types, ./classify-intent
 */
import { classify } from "./classify-intent.js";
import {
  RESEARCH_KEYWORDS,
  detectIntent,
  detectSandbox,
  dispatchModeForIntent,
  matchesKeyword,
} from "./message-router-intent.js";
import { type AddressSegment, parseMultiAddress } from "./message-router-multi.js";
import type { AgentName, ChatRoute, ClassifiedIntent } from "./types.js";

export interface ParsedInput {
  readonly route: ChatRoute;
  readonly text: string;
  /**
   * Smart-router classification — populated ONLY for plain messages routed through
   * `routeByKeyword` (INV-1: explicit `@agent`/`/command` routing is never reclassified).
   */
  readonly classified?: ClassifiedIntent;
  /**
   * Name-based multi-address segments — populated when a plain message NAMES one or more agents with a
   * task ("claude plan X, codex audit it"). The cockpit dispatches these in order (sequential hand-off).
   */
  readonly segments?: readonly AddressSegment[];
}

// EXPORTED (W4-4): resolve-mode-targets.ts reuses this EXACT pattern as the single source of truth for
// "what does a committed @-prefix look like" — a second, independently-maintained regex would drift.
export const AGENT_PREFIX_PATTERN: RegExp = /^@(claude|codex|gemini|all)\s*/i;
// U1 (FIX WAVE Round A, 2026-07-18): "build"/"dispatch" DELETED from the recognized set — they used to
// fall through routeSlashCommand's generic case below to `agents: []` (a dead no-op BLOCK-1 caught
// downstream in cockpit-turn-route.ts). Text starting with those words now parses as ordinary
// keyword-routed natural language instead (routeByKeyword), matching @agent addressing's existing
// "telling them to build IS build" behavior — no separate slash ceremony needed.
const SLASH_PATTERN: RegExp = /^\/(council|debate|exit|help|resume|status)\s*/i;
const ALL_AGENTS: readonly AgentName[] = ["claude", "codex", "gemini"];

export function parseInput(raw: string, defaultAgent: AgentName): ParsedInput {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { route: defaultRoute(defaultAgent), text: "" };
  }

  const slashMatch = trimmed.match(SLASH_PATTERN);
  if (slashMatch !== null) {
    return routeSlashCommand(slashMatch, trimmed);
  }

  const agentMatch = trimmed.match(AGENT_PREFIX_PATTERN);
  if (agentMatch !== null) {
    return routeExplicitPrefix(agentMatch, trimmed);
  }

  const segments = parseMultiAddress(trimmed);
  if (segments !== null && segments.length >= 2) {
    return routeMultiAddress(segments, trimmed);
  }

  return routeByKeyword(trimmed, defaultAgent);
}

function routeExplicitPrefix(match: RegExpMatchArray, trimmed: string): ParsedInput {
  if ((match[1] ?? "").toLowerCase() === "all") {
    return routeAgentPrefix(match, trimmed);
  }
  const segments = parseMultiAddress(trimmed);
  if (segments !== null && segments.length >= 2 && countExplicitAgentTags(trimmed) >= 2) {
    return routeMultiAddress(segments, trimmed);
  }
  return routeAgentPrefix(match, trimmed);
}

function countExplicitAgentTags(trimmed: string): number {
  return [...trimmed.matchAll(/(^|[\s,;.])@(claude|codex|gemini)\b/giu)].length;
}
/** A name-based multi-address turn: ordered per-agent task segments the cockpit dispatches sequentially. */
function routeMultiAddress(segments: readonly AddressSegment[], text: string): ParsedInput {
  return {
    route: {
      kind: "agent",
      agents: segments.map((segment) => segment.agent),
      intent: "general",
      dispatchMode: "text-only",
      codexSandbox: "read-only",
      geminiMode: "review",
    },
    text,
    segments,
  };
}

export function isSlashExit(raw: string): boolean {
  return raw.trim().toLowerCase() === "/exit";
}

function routeAgentPrefix(match: RegExpMatchArray, trimmed: string): ParsedInput {
  const agentStr = (match[1] ?? "").toLowerCase();
  const text = trimmed.slice(match[0].length).trim();
  const intent = detectIntent(text);

  if (agentStr === "all") {
    return {
      route: {
        kind: "all",
        agents: ALL_AGENTS,
        intent,
        dispatchMode: dispatchModeForIntent(intent),
        codexSandbox: detectSandbox(text),
        geminiMode: "review",
      },
      text,
    };
  }

  const agent = agentStr as AgentName;
  return {
    route: {
      kind: "agent",
      agents: [agent],
      intent,
      dispatchMode: dispatchModeForIntent(intent),
      codexSandbox: agent === "codex" ? detectSandbox(text) : "read-only",
      geminiMode: "review",
    },
    text,
  };
}

function routeSlashCommand(match: RegExpMatchArray, trimmed: string): ParsedInput {
  const command = (match[1] ?? "").toLowerCase();
  const text = trimmed.slice(match[0].length).trim();

  if (command === "council") {
    const intent = detectIntent(text);
    return {
      route: {
        kind: "all",
        agents: ALL_AGENTS,
        intent,
        dispatchMode: dispatchModeForIntent(intent),
        codexSandbox: detectSandbox(text),
        geminiMode: "review",
        slashCommand: "council",
      },
      text,
    };
  }

  if (command === "debate") {
    return {
      route: {
        kind: "slash",
        agents: ALL_AGENTS,
        intent: "opinion",
        dispatchMode: "text-only",
        codexSandbox: "read-only",
        geminiMode: "review",
        slashCommand: "debate",
      },
      text,
    };
  }

  return {
    route: {
      kind: "slash",
      agents: [],
      intent: "general",
      dispatchMode: "text-only",
      codexSandbox: "read-only",
      geminiMode: "review",
      slashCommand: command,
    },
    text,
  };
}

// S-B (FIX WAVE Round A, 2026-07-18 = sweep#2/contracts#1): this is the ONE plain-message route that
// did NOT use detectIntent() — routeAgentPrefix (line ~100) and /council (line ~135) already did, so
// a mid-sentence destructive/write imperative ("please delete the old branch") classified as
// pipeline/build via the explicit @agent or /council routes but stayed text-only here, the most common
// path. detectIntent() already folds in containsWriteVerb's mid-sentence + explanatory-lead guard
// (message-router-intent.ts); routeByKeyword now defers to it instead of re-deriving a narrower,
// first-word-only subset. The RESEARCH_KEYWORDS branch is untouched — its own gating and researchRoute
// output are unaffected by this fix (dispatchModeForIntent("research") already agreed with it).
function routeByKeyword(trimmed: string, defaultAgent: AgentName): ParsedInput {
  // INV-2: classify the plain message before routing; INV-1 keeps explicit @/routing untouched.
  const classified = classify(trimmed);
  const intent = detectIntent(trimmed);

  if (dispatchModeForIntent(intent) === "pipeline") {
    return {
      route: {
        kind: "agent",
        agents: [defaultAgent],
        intent,
        dispatchMode: "pipeline",
        codexSandbox: defaultAgent === "codex" ? detectSandbox(trimmed) : "read-only",
        geminiMode: "review",
      },
      text: trimmed,
      classified,
    };
  }

  if (matchesKeyword(trimmed, RESEARCH_KEYWORDS)) {
    return researchRoute(trimmed, classified, defaultAgent);
  }

  return { route: defaultRoute(defaultAgent), text: trimmed, classified };
}

/** A read-only research route on the current default agent; no model preference is implied. */
function researchRoute(
  trimmed: string,
  classified: ClassifiedIntent,
  defaultAgent: AgentName,
): ParsedInput {
  return {
    route: {
      kind: "agent",
      agents: [defaultAgent],
      intent: "research",
      dispatchMode: "tools",
      codexSandbox: "read-only",
      geminiMode: "review",
    },
    text: trimmed,
    classified,
  };
}

function defaultRoute(agent: AgentName): ChatRoute {
  return {
    kind: "agent",
    agents: [agent],
    intent: "general",
    dispatchMode: "text-only",
    codexSandbox: "read-only",
    geminiMode: "review",
  };
}
