/**
 * @file src/chat/native-mode.ts
 * @purpose W4's per-engine native-mode STATE MODEL — pure, no I/O. Owns each engine's mode CATALOG
 *   (vocabulary + cycle order from the bridge/CLI's own advertised list — never a zer0-invented
 *   normalization plane, the D2 lock) and the pure cycle transitions: beginCycle (Shift+Tab -> next
 *   mode, PENDING), applyActive (confirmed active), applyFailed (rejected/timed out -> revert + error).
 * @exports ModeStatus, EngineModeState, NativeModeState, MODE_CATALOG, initialNativeModeState,
 *   nextModeId, beginCycle, applyActive, applyAdopted, applyFailed, applyCatalog, effectiveCatalog,
 *   modeToken
 * @depends ./types
 */
import type { AgentName } from "./types.js";

/** PENDING = a cycle was requested and (for claude/codex) the live setMode ack is in flight or has
 *  landed but not yet confirmed active at the next prompt boundary; agy transitions straight through
 *  PENDING to ACTIVE in the same tick since its mode store write cannot reject or time out. */
export type ModeStatus = "active" | "pending";

/** One engine's live mode-display slice: its current native mode id, whether it is confirmed active or
 *  still pending confirmation, and the most recent cycle's failure message (if the LAST attempt was
 *  rejected/timed out — cleared the next time a cycle begins or lands). `catalog` (B3, MAX review fix
 *  round 1) is the LIVE bridge-advertised mode list once a session has captured one (applyCatalog) —
 *  undefined before any session has opened (or for agy, which has none), when effectiveCatalog falls
 *  back to MODE_CATALOG's static pre-session list. */
export interface EngineModeState {
  readonly modeId: string;
  readonly status: ModeStatus;
  readonly error?: string;
  readonly catalog?: readonly string[];
}

/** The full per-engine mode display: one slice per engine, roster order. */
export type NativeModeState = Readonly<Record<AgentName, EngineModeState>>;

// Each engine's OWN native mode vocabulary — the PRE-SESSION / agy FALLBACK catalog only (B3, MAX
// review fix round 1): once a claude/codex session actually opens, its newSession/resumeSession
// response's advertised `modes.availableModes` becomes the LIVE catalog (applyCatalog/
// effectiveCatalog) and this static list is no longer consulted for THAT session. claude:
// acp-agent.js:302-323 (default/acceptEdits/plan/dontAsk/bypassPermissions) — "auto" is deliberately
// absent here (gated on a live supportsAutoMode capability the bridge may or may not advertise) but
// cycles normally once a session's own live catalog includes it. codex: the bridge's three curated
// presets (index.js:25308-25340), NOT the wider raw approval_policy matrix. gemini (agy): the
// installed binary's own `--mode accept-edits|plan` values, PLUS the implicit unset stance rendered as
// "auto" (D-3, operator finding, 2026-07-18: `agy --help`, research doc docs/research/2026-07-17-w4-
// native-modes-research.md:94, and this file's OWN prior history all confirm agy's --help never names
// the unset state at all — "default" was zer0's own invented label, not agy's vocabulary, and
// confusable with "the setting you'd get without customizing" rather than the true meaning: full
// autonomy, the SAME concept Claude Code itself calls "auto mode" for the parallel bypassPermissions
// stance — the unconditional --dangerously-skip-permissions flag IS that stance here). agy has no
// session-negotiation protocol, so this stays its PERMANENT catalog, never overridden live. THE WIRE
// DEPENDENCY: agy.ts's resolveAgyModeArg compares against this EXACT literal to decide "omit --mode" —
// renaming this value without updating that comparison would silently start passing an invalid
// `--mode auto` to a binary that only accepts accept-edits/plan (verified via argv-matrix.test.ts's
// revert-and-rerun, this same commit).
export const MODE_CATALOG: Readonly<Record<AgentName, readonly string[]>> = {
  claude: ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"],
  codex: ["read-only", "agent", "agent-full-access"],
  gemini: ["auto", "accept-edits", "plan"],
};

/** Short, compact display tokens per engine+mode — the 60-column panel budget cannot spend a mode's full
 *  native name (e.g. "agent-full-access") in an already-tight agent cell. */
const MODE_TOKEN: Readonly<Record<AgentName, Readonly<Record<string, string>>>> = {
  claude: {
    default: "def",
    acceptEdits: "edit",
    plan: "plan",
    dontAsk: "noask",
    bypassPermissions: "bypass",
  },
  codex: { "read-only": "ro", agent: "agt", "agent-full-access": "full" },
  gemini: { auto: "auto", "accept-edits": "edit", plan: "plan" },
};

/** The engine's compact display token for `modeId` — the raw id itself (truncated to 6 chars) for a
 *  value outside the known catalog rather than a blank cell (never silently hide an unrecognized mode). */
export function modeToken(engine: AgentName, modeId: string): string {
  return MODE_TOKEN[engine][modeId] ?? modeId.slice(0, 6);
}

/** The boot/default state: every engine on its catalog's FIRST (least-privileged) entry, already active
 *  (nothing pending before any cycle has been requested or any persisted choice has loaded). */
export function initialNativeModeState(): NativeModeState {
  return {
    claude: { modeId: firstOf("claude"), status: "active" },
    codex: { modeId: firstOf("codex"), status: "active" },
    gemini: { modeId: firstOf("gemini"), status: "active" },
  };
}

function firstOf(engine: AgentName): string {
  return MODE_CATALOG[engine][0] ?? "default";
}

/** B3 (MAX review fix round 1): the catalog a cycle should actually wrap through — the LIVE
 *  bridge-advertised list once a session has captured one (applyCatalog), else MODE_CATALOG's static
 *  pre-session/agy fallback. The ONE place that "which list wins" decision is made — every cycle/
 *  display call site reads through this rather than re-deriving the fallback rule itself. */
export function effectiveCatalog(engine: AgentName, slice: EngineModeState): readonly string[] {
  return slice.catalog ?? MODE_CATALOG[engine];
}

/** The engine's next native mode after `currentModeId` within `catalog` (defaults to MODE_CATALOG's
 *  static fallback — most callers pass effectiveCatalog's result explicitly), wrapping — an
 *  unrecognized current id (e.g. a persisted choice from a since-changed catalog) restarts the cycle at
 *  the catalog's first entry rather than throwing, so a stale value degrades safely instead of blocking
 *  the keybinding forever. */
export function nextModeId(
  engine: AgentName,
  currentModeId: string,
  catalog: readonly string[] = MODE_CATALOG[engine],
): string {
  const index = catalog.indexOf(currentModeId);
  const nextIndex = index === -1 ? 0 : (index + 1) % catalog.length;
  return catalog[nextIndex] ?? catalog[0] ?? "default";
}

/** Operator pressed Shift+Tab and this engine was in the resolved target set: advance to its next native
 *  mode (within its EFFECTIVE catalog — B3), PENDING (a live setMode call — or agy's synchronous store
 *  write — is about to be attempted). */
export function beginCycle(state: NativeModeState, engine: AgentName): NativeModeState {
  const slice = state[engine];
  const catalog = effectiveCatalog(engine, slice);
  return {
    ...state,
    [engine]: { ...slice, modeId: nextModeId(engine, slice.modeId, catalog), status: "pending" },
  };
}

/** The pending mode is now confirmed applied: for claude/codex, the next prompt boundary after a
 *  successful setMode ack; for agy, immediately (its mode store write cannot reject or time out). Clears
 *  any error left by an earlier failed attempt — a fresh success is not still "the last one failed".
 *  Preserves `catalog` (spreads the prior slice first) — confirming a mode active must never wipe the
 *  live catalog a session already advertised.
 *  W4-R FIX-1 B3: `modeId` is the id the caller's confirmation is FOR — the live session's own genuine
 *  ack, never recomputed here. STALENESS CHECK: if it does not match the slice's CURRENT modeId, a
 *  newer cycle has been requested since this confirmation was kicked off (an operator Shift+Tab racing
 *  a slow boot-open ack, or two rapid cycles racing each other) — this confirmation is for a target the
 *  operator has already moved away from. Returns the slice UNCHANGED: never applies the stale id
 *  (would silently overwrite the newer pending target with an old one), never reverts either (the
 *  newer cycle's OWN confirmation is still genuinely in flight and may yet succeed) — simply ignored,
 *  the slice keeps waiting for the confirmation that actually matches what it is pending on. */
export function applyActive(
  state: NativeModeState,
  engine: AgentName,
  modeId: string,
): NativeModeState {
  const slice = state[engine];
  if (slice.modeId !== modeId) {
    return state;
  }
  const { catalog } = slice;
  return {
    ...state,
    [engine]: { modeId, status: "active", ...(catalog !== undefined ? { catalog } : {}) },
  };
}

/**
 * W4-R FIX-1b ROUND 2 (MAX review BLOCK): applies a RESUME's adopted ground-truth modeId — the sibling
 * to applyActive with DELIBERATELY DIFFERENT semantics, never the same guard. applyActive's "any
 * mismatch is stale, drop it" is correct for a genuine live setMode push's own confirmation (protects
 * a slow ack from silently overriding a NEWER pending target the operator has already moved to) — but
 * adoption never made a live call at all; the resumed session's own currentModeId already IS the mode,
 * so treating a mismatch against zer0's boot-seeded persisted value as "staleness" would reject the
 * exact correction adoption exists to deliver (the operator-verified lie this fix closes: panel showed
 * bypassPermissions while the agent's own reply said plan was active).
 * THE ONLY THING THAT CAN LEGITIMATELY OUTRANK ADOPTION: a local pending cycle already in flight — the
 * operator's OWN already-committed Shift+Tab toward some other mode Z, requested before this adoption
 * arrived. That pending intent wins; the adoption is silently dropped (never applied, never reverted —
 * Z's own live setMode call against the now-resumed session will confirm or fail through the normal
 * mode-active/mode-failed path, the same as every other genuine cycle). Absent a pending cycle, adopts
 * unconditionally — clears any stale error (the returned slice carries none), preserves `catalog`
 * (spreads the prior slice's, mirroring applyActive's own contract).
 * W4-R2f RA-2: `error` is the bridge's REFUSAL of the operator's own persisted mode, on the one
 * adoption that happens because their choice was rejected (lane-hold.ts's adoptOrApplyResumedMode).
 * The adopted id is the honest display; the error is why it is not the one they picked. Omitted
 * elsewhere, which keeps the "a fresh adoption is not still the last failure" clear above intact.
 */
export function applyAdopted(
  state: NativeModeState,
  engine: AgentName,
  modeId: string,
  error?: string,
): NativeModeState {
  const slice = state[engine];
  if (slice.status === "pending") {
    return state;
  }
  const { catalog } = slice;
  return {
    ...state,
    [engine]: {
      modeId,
      status: "active",
      ...(error !== undefined ? { error } : {}),
      ...(catalog !== undefined ? { catalog } : {}),
    },
  };
}

/** FAILURE CONTRACT: a live setMode rejection or timeout reverts the selection to `revertToModeId` (the
 *  id active before this cycle began) and attaches a visible error — never a silent no-op, never left
 *  PENDING forever ("pending-failed, never silent" per the W4-1 acceptance contract). Preserves
 *  `catalog` — a rejected mode change says nothing about whether the session's advertised list changed. */
export function applyFailed(
  state: NativeModeState,
  engine: AgentName,
  revertToModeId: string,
  error: string,
): NativeModeState {
  const { catalog } = state[engine];
  return {
    ...state,
    [engine]: {
      modeId: revertToModeId,
      status: "active",
      error,
      ...(catalog !== undefined ? { catalog } : {}),
    },
  };
}

/** C6 (MAX review fix round 1 CONCERN): attaches a VISIBLE warning when persisting the mode choice
 *  to disk fails (native-mode-store.ts's persistNativeMode returning {outcome:"failed"}) — distinct
 *  from applyFailed's FAILURE CONTRACT: the live mode DID apply successfully here (modeId/status are
 *  UNTOUCHED), only the next-boot durability is at risk, so reverting the displayed mode would be
 *  dishonest in the other direction. Never silently dropped (the memory-honesty law). */
export function attachPersistWarning(
  state: NativeModeState,
  engine: AgentName,
  error: string,
): NativeModeState {
  return { ...state, [engine]: { ...state[engine], error } };
}

/** B3 (MAX review fix round 1): records the LIVE catalog a session actually advertised (ACP's
 *  newSession/resumeSession `modes.availableModes`) — from this point forward, beginCycle's wrap order
 *  follows the bridge's real list (which may include a gated entry the static MODE_CATALOG fallback
 *  deliberately excludes, e.g. claude's "auto") instead of the static fallback. Touches ONLY `catalog` —
 *  a pure swap, safe to call whenever a session opens or resumes regardless of any cycle in flight. */
export function applyCatalog(
  state: NativeModeState,
  engine: AgentName,
  catalog: readonly string[],
): NativeModeState {
  return { ...state, [engine]: { ...state[engine], catalog } };
}

// REMOVED (MAX review fix round 1, B1) — settlePendingModes used to confirm a PENDING mode active
// on the turn-model's openTurn event ("the next prompt boundary"). That reasoning was WRONG: openTurn
// fires from the raw user.message bus event the instant the operator hits Enter, BEFORE
// transport.start() (and therefore lane-transport.ts's applyRestoredMode) has even run — so the
// "confirmation" was structurally premature, not just occasionally wrong. The real confirmation is
// now the mode.session bus event (events.ts), fired by applyRestoredMode the moment a session
// GENUINELY opens or resumes, consumed by use-cockpit-bus.ts's useNativeModeBus. Do not reintroduce
// an openTurn-based confirmation — it is the exact bug this fix round closed.

// REMOVED (W4-R REFIT, R4) — formatNativeModeBootLine used to join a top-scrolling "[modes]
// claude=... codex=... gemini=..." self-state line into every boot's carrierNotice. R2 moves the
// stance text into the ALWAYS-VISIBLE bottom chrome row (status-bar.tsx), which is now the single
// mode surface — a second, redundant, scroll-away copy at the top added noise without adding
// information. The gemini probe-failure/unsupported notice and R1's per-engine unavailable notice
// still ride the SAME carrierNotice channel (chat-tui-mount.ts) — only this routine self-state dump
// is gone.
