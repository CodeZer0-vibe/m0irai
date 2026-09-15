/**
 * @file src/chat/claude-usage-fold.ts
 * @purpose PROCESS-scoped fold of claude's learned rate-limit windows (codex wave-review B1). The ACP
 *   dispatch closes its session per turn (acp-turn.ts), restarting the in-session fold, while the model's
 *   usage merge is wholesale-replace (cockpit-model.ts:348) — so a ctx-only turn would blank learned
 *   5h/weekly meters. Windows are ACCOUNT state: the chat layer carries the last-known map across turns
 *   and stamps it onto every usage pre-render; fresher windows supersede per window; staleness is bounded
 *   by each window's resetsAt (rendered by the bar). Reset is test-only isolation.
 * @exports foldClaudeWindows, resetClaudeWindowFold
 * @depends ../shared/turn-usage
 */
import { mergeRateWindows } from "../shared/rate-window-merge.js";
import type { ClaudeRateWindow, ClaudeRateWindows, TurnUsage } from "../shared/turn-usage.js";

let known: ClaudeRateWindows | undefined;

/** Folds the usage's windows into the process-scoped map (per-window FIELD merge — a status-only event
 *  window on the SAME window keeps the learned %, codex u2dc B3), drops any window whose resetsAt has
 *  passed (codex B2 — a spent window must not outlive its own reset and keep the bar red), then returns
 *  the usage carrying the FULL live map — every downstream emit is clobber-safe. */
export function foldClaudeWindows(usage: TurnUsage, nowMs: number = Date.now()): TurnUsage {
  if (usage.rateLimits !== undefined) {
    known = mergeRateWindows(known, usage.rateLimits);
  }
  known = known === undefined ? undefined : pruneExpired(known, nowMs);
  return known === undefined ? usage : { ...usage, rateLimits: known };
}

/** Clears the fold — TEST-ONLY isolation; production wants the process scope. */
export function resetClaudeWindowFold(): void {
  known = undefined;
}

// A window is live until its resetsAt instant (seconds; expiry AT the instant — the account window has
// reset by then). A window without resetsAt has no basis to expire and is kept until superseded.
function liveWindow(w: ClaudeRateWindow | undefined, nowMs: number): ClaudeRateWindow | undefined {
  if (w === undefined) {
    return undefined;
  }
  return w.resetsAt !== undefined && w.resetsAt * 1000 <= nowMs ? undefined : w;
}

// Rebuilds the map from its live windows only; undefined once every window has expired (then usages pass
// through bare — "we know nothing current", never "claude is limited").
function pruneExpired(map: ClaudeRateWindows, nowMs: number): ClaudeRateWindows | undefined {
  const five = liveWindow(map.five_hour, nowMs);
  const seven = liveWindow(map.seven_day, nowMs);
  const opus = liveWindow(map.seven_day_opus, nowMs);
  const sonnet = liveWindow(map.seven_day_sonnet, nowMs);
  if (five === undefined && seven === undefined && opus === undefined && sonnet === undefined) {
    return undefined;
  }
  return {
    ...(five !== undefined ? { five_hour: five } : {}),
    ...(seven !== undefined ? { seven_day: seven } : {}),
    ...(opus !== undefined ? { seven_day_opus: opus } : {}),
    ...(sonnet !== undefined ? { seven_day_sonnet: sonnet } : {}),
  };
}
