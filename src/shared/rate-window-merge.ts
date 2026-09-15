/**
 * @file src/shared/rate-window-merge.ts
 * @purpose Per-window FIELD merge for claude's rate-limit windows (codex u2dc B3). The two _meta sources
 *   are asymmetric — the /usage plan windows carry utilization at any level, rate_limit_event often only a
 *   status verdict — so replacing whole window objects blanks a learned % every time a status-only event
 *   lands. Incoming fields win; a missing incoming utilization is inherited from the prior ONLY when both
 *   describe the SAME window (reset instants within 60s — the two sources round the same reset ~1s apart
 *   in live captures). A rolled window (different reset instant) never inherits the old %.
 * @exports mergeRateWindows
 * @depends ./turn-usage
 */
import type { ClaudeRateWindow, ClaudeRateWindows } from "./turn-usage.js";

const SAME_WINDOW_TOLERANCE_S = 60;

/** Folds `incoming` onto `prior` per window key, field-merging same-window updates (see file purpose). */
export function mergeRateWindows(
  prior: ClaudeRateWindows | undefined,
  incoming: ClaudeRateWindows,
): ClaudeRateWindows {
  return {
    ...prior,
    ...(incoming.five_hour !== undefined
      ? { five_hour: mergeWindow(prior?.five_hour, incoming.five_hour) }
      : {}),
    ...(incoming.seven_day !== undefined
      ? { seven_day: mergeWindow(prior?.seven_day, incoming.seven_day) }
      : {}),
    ...(incoming.seven_day_opus !== undefined
      ? { seven_day_opus: mergeWindow(prior?.seven_day_opus, incoming.seven_day_opus) }
      : {}),
    ...(incoming.seven_day_sonnet !== undefined
      ? { seven_day_sonnet: mergeWindow(prior?.seven_day_sonnet, incoming.seven_day_sonnet) }
      : {}),
  };
}

// SYMMETRIC field merge (codex u2dc verify): per field, incoming wins when present; an absent field is
// inherited from the prior ONLY when both describe the same window. The two sources are asymmetric —
// /usage plan windows carry utilization but never a status verdict, rate_limit_event carries the verdict
// but often no % — so replacement in EITHER direction blanks truth (a rejected verdict must survive a
// later plan %, and a learned % must survive a status-only event). A rolled window inherits nothing:
// the new period starts unjudged and unmeasured.
function mergeWindow(
  prior: ClaudeRateWindow | undefined,
  incoming: ClaudeRateWindow,
): ClaudeRateWindow {
  if (prior === undefined || !sameWindow(prior, incoming)) {
    return incoming;
  }
  const status = pick(incoming.status, prior.status);
  const utilization = pick(incoming.utilization, prior.utilization);
  // ANTI-RATCHET (codex u2dc verify 3): an INHERITING merge anchors to the EARLIER instant, so inherited
  // state dies with its ORIGINAL window — otherwise near-boundary updates walk the instant forward and an
  // inherited verdict ratchets past its window indefinitely (each pairwise tolerance re-anchoring on the
  // newer instant). A merge that inherits nothing takes the incoming instant verbatim (fresher truth).
  const inherited =
    (incoming.status === undefined && prior.status !== undefined) ||
    (incoming.utilization === undefined && prior.utilization !== undefined);
  const resetsAt = inherited
    ? minDefined(incoming.resetsAt, prior.resetsAt)
    : pick(incoming.resetsAt, prior.resetsAt);
  return {
    ...(status !== undefined ? { status } : {}),
    ...(utilization !== undefined ? { utilization } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) {
    return b;
  }
  return b === undefined ? a : Math.min(a, b);
}

// Same window when either side lacks an instant to compare (no basis to call it rolled) or the instants
// agree within tolerance (the two sources round the SAME reset ~1s apart in live captures).
function sameWindow(prior: ClaudeRateWindow, incoming: ClaudeRateWindow): boolean {
  return (
    prior.resetsAt === undefined ||
    incoming.resetsAt === undefined ||
    Math.abs(incoming.resetsAt - prior.resetsAt) <= SAME_WINDOW_TOLERANCE_S
  );
}

function pick<T>(incoming: T | undefined, prior: T | undefined): T | undefined {
  return incoming !== undefined ? incoming : prior;
}
