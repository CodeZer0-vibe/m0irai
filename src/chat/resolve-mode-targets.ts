/**
 * @file src/chat/resolve-mode-targets.ts
 * @purpose W4-4's Shift+Tab scope resolver: which engine(s) the composer's CURRENT text commits to.
 *   Reuses message-router.ts's AGENT_PREFIX_PATTERN + message-router-multi's parseMultiAddress —
 *   never a second parser. Skips message-router's countExplicitAgentTags disambiguation gate on
 *   purpose: this is a LOW-STAKES UI question (no write grant, no feed event), not message-router's
 *   HIGH-STAKES dispatch call — a rare divergence just costs one extra engine in the cycle.
 * @exports ALL_ENGINE_TARGETS, resolveModeTargets
 * @depends ./message-router, ./message-router-multi, ./types
 */
import { parseMultiAddress } from "./message-router-multi.js";
import { AGENT_PREFIX_PATTERN } from "./message-router.js";
import type { AgentName } from "./types.js";

/** Every native-mode-capable engine, roster order — the fallback scope when the composer commits to no
 *  single address (empty, plain prose, or a mid-typed partial like "@c" that matches no full tag). */
export const ALL_ENGINE_TARGETS: readonly AgentName[] = ["claude", "codex", "gemini"];

/**
 * Resolves which engine(s) the composer's CURRENT text addresses, for the Shift+Tab per-engine mode
 * cycle (W4-4's pinned case table):
 *   - a committed multi-address (≥2 distinct addressed agents, message-router-multi's own definition)
 *     targets exactly that set — checked FIRST so "@claude plan, @codex build" targets both, not just
 *     the leading @claude prefix;
 *   - else a committed single `@agent` prefix targets that agent only;
 *   - else a committed `@all` targets every engine;
 *   - else (no address, or a mid-typed partial that matches no full tag) targets every engine.
 * PURE — no I/O, no React. The keymap calls this directly; it never re-parses the composer text itself.
 */
export function resolveModeTargets(text: string): readonly AgentName[] {
  const trimmed = text.trim();
  const segments = parseMultiAddress(trimmed);
  if (segments !== null && segments.length >= 2) {
    return segments.map((segment) => segment.agent);
  }
  const prefixMatch = trimmed.match(AGENT_PREFIX_PATTERN);
  if (prefixMatch !== null) {
    const tag = (prefixMatch[1] ?? "").toLowerCase();
    return tag === "all" ? ALL_ENGINE_TARGETS : [tag as AgentName];
  }
  return ALL_ENGINE_TARGETS;
}
