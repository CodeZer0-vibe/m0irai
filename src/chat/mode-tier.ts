/**
 * @file src/chat/mode-tier.ts
 * @purpose D-4's stance-tier abstraction: derives ONE of 3 named tiers (or "mixed") from the 3 engines'
 *   raw native mode ids via a FIXED, operator-locked anchor table — DERIVED, never stored (native-
 *   mode.ts's own NativeModeState stays the single source of truth; CockpitState's lastUnifiedTier is a
 *   passively-tracked MEMORY of the last time tierOf() was not "mixed", not a second copy of intent).
 * @exports StanceTier, StanceDisplay, TIER_ANCHORS, TIER_ORDER, tierOf, nextTier, seedUnifiedTier
 * @depends ./native-mode, ./types
 *
 * Cycle order (careful -> plan -> auto, wrapping) is SOURCED, not invented: claude is the feature's
 * explicit reference model (mirrors Claude Code's own stance banner), and its own live-advertised mode
 * list — node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js:3299-3323,
 * buildAvailableModes — always visits "default" (careful) before "plan" before "bypassPermissions"
 * (auto) LAST, regardless of whether the gated native "auto" entry (id:"auto", a DIFFERENT mode —
 * excluded from TIER_ANCHORS entirely, see below) is present. codex's own catalog (native-mode.ts's
 * MODE_CATALOG.codex: read-only/agent/agent-full-access) agrees auto is last. gemini's catalog is the
 * sole exception (auto FIRST) because D-3 established agy has no distinct unconfigured "careful" stance
 * at all — "auto" IS its implicit starting point, not a deliberately-escalated-to one — so it is not
 * used to break the tie; claude's ordering wins as the named reference model.
 */
import type { NativeModeState } from "./native-mode.js";
import type { AgentName } from "./types.js";

/** The 3 operator-locked stance tiers (D-4). Distinct from claude's OWN native "auto" mode id (gated on
 *  a live supportsAutoMode capability) — that is a real, separate, cyclable catalog entry once a
 *  session advertises it, deliberately EXCLUDED from TIER_ANCHORS below; the "auto" TIER's claude-side
 *  anchor is "bypassPermissions", the same full-autonomy concept under a different native id. */
export type StanceTier = "auto" | "careful" | "plan";

/** The stance line's full display range: a clean tier match, or "mixed" (the 3 engines disagree — e.g.
 *  a single `@engine` tune, or a whole-team jump still settling with a rejected leg). */
export type StanceDisplay = StanceTier | "mixed";

/** The fixed anchor table (operator-locked, D-4 "I like, lock it in and go"): each tier's REAL per-engine
 *  native mode id, underneath the abstraction. */
export const TIER_ANCHORS: Readonly<Record<StanceTier, Readonly<Record<AgentName, string>>>> = {
  auto: { claude: "bypassPermissions", codex: "agent-full-access", gemini: "auto" },
  careful: { claude: "default", codex: "agent", gemini: "accept-edits" },
  plan: { claude: "plan", codex: "read-only", gemini: "plan" },
};

/** The whole-team jump's cycle order — see file header for the sourcing. */
export const TIER_ORDER: readonly StanceTier[] = ["careful", "plan", "auto"];

/** The tier whose anchors EXACTLY match all 3 engines' CURRENT modeId — "mixed" if none match (the team
 *  has been tuned independently, e.g. a single-agent `@engine` tune breaking uniformity). Status-
 *  AGNOSTIC by design: a PENDING engine's modeId is already the target value the instant its cycle
 *  begins (native-mode.ts's beginCycle sets modeId synchronously, before any live ack) — tierOf reads
 *  the INTENDED tier immediately rather than waiting on confirmation. The whole-team jump's own
 *  separate "applying…" state (CockpitState.pendingTier) is what distinguishes in-flight from
 *  confirmed; tierOf itself never encodes that distinction. */
export function tierOf(state: NativeModeState): StanceDisplay {
  for (const tier of TIER_ORDER) {
    const anchor = TIER_ANCHORS[tier];
    if (
      state.claude.modeId === anchor.claude &&
      state.codex.modeId === anchor.codex &&
      state.gemini.modeId === anchor.gemini
    ) {
      return tier;
    }
  }
  return "mixed";
}

/** The tier after `tier` in the fixed cycle order, wrapping. The whole-team jump always advances
 *  relative to CockpitState.lastUnifiedTier (never relative to tierOf(state) directly), so a currently-
 *  "mixed" team still jumps deterministically — this is the ONE place "what's next" is computed. */
export function nextTier(tier: StanceTier): StanceTier {
  const index = TIER_ORDER.indexOf(tier);
  const next = index === -1 ? TIER_ORDER[0] : TIER_ORDER[(index + 1) % TIER_ORDER.length];
  return next ?? "careful";
}

/** Tier-boot fix round 1 CONCERN (final W4 confirming pass finding #1): the boot-time seed for
 *  CockpitState.lastUnifiedTier — tierOf(nativeMode) when the persisted/booted state is ALREADY
 *  unified, so the operator's very FIRST plain Shift+Tab advances from their REAL current tier, not a
 *  stale constant (cockpit.tsx's seedCockpitState previously seeded nativeMode from props but never
 *  re-derived lastUnifiedTier from it — the stance line's own display was honest, since tierOf reads
 *  live, but the first jump silently advanced from the wrong starting point). Falls back to the
 *  "auto" baseline for a genuinely mixed boot (every fresh install today: no engine's own catalog[0]
 *  aligns with another's, so tierOf(initialNativeModeState()) is ALWAYS "mixed") — chosen so the very
 *  FIRST press from an unconfigured boot lands the team on nextTier("auto") === "careful", the useful
 *  middle ground (the team can act, just asks first) rather than "plan" (nothing executes at all) or
 *  auto itself (full bypass — the one destination this fallback exists specifically to never reach on
 *  a single untouched keypress; seeding "careful" directly, by contrast, would land the FIRST press on
 *  "plan" via TIER_ORDER's own wrap — one tier short of the useful middle ground this baseline reaches
 *  instead). */
export function seedUnifiedTier(nativeMode: NativeModeState): StanceTier {
  const tier = tierOf(nativeMode);
  return tier === "mixed" ? "auto" : tier;
}
