/**
 * @file src/chat/codex-usage-decode.ts
 * @exports CodexRateLimits, CodexQuotaWindow, CodexCredits, CodexTokenInfo, CodexUsageDecode,
 *   USAGE_DRIFT_FIELD, decodeCodexUsage
 * @depends ./statusline-payload
 * @purpose The PURE codex `rate_limits` -> AgentStatusUsage decode. Split out of codex-rate-limits.ts
 *   (which keeps the rollout filesystem read) because this half is the vendor CONTRACT and must be
 *   readable next to the captures that prove it: codex-usage-captures.fixtures.ts.
 *
 *   WHAT CHANGED AND WHY (W4-R2b, 2026-07-27). The previous decode mapped windows by POSITION
 *   (primary -> 5h, secondary -> weekly) and read exhaustion off the `credits` wallet. Both were
 *   written to an imagined shape. The captures say otherwise:
 *     - the SAME weekly window arrives as `secondary` on plan_type "plus" and as `primary` on
 *       "prolite", so position carries no meaning - `window_minutes` does. Every "5h NN%" this
 *       product ever showed for a prolite codex was the WEEKLY number wearing a 5h label.
 *     - `credits` is a separate pay-as-you-go wallet a subscriber never funds; it reads
 *       has_credits:false / balance:"0" permanently, including while the real window sits at 0% used.
 *       Reading it as "subscription spent" is what put a false warning on the operator's codex chip.
 *     - `primary:null` is a turn that reported no window, NOT a spent one (one such line sits between
 *       70 lines reading 27% in a single session file).
 *   So: classify by the duration the vendor STATES, derive exhaustion from the reported entitlement
 *   windows ALONE, keep the reset instants, and fabricate nothing for a window we cannot name.
 */
import type { AgentStatusUsage } from "./statusline-payload.js";

// The quota windows we can NAME, by the duration codex states in `window_minutes`. Real payloads carry
// 300/10080 (current) AND 299/10079 (the 2025 shape) for the SAME two windows, so an exact match would
// mis-read 682 captured lines as unrecognised. The tolerance is a band around each nominal duration -
// wide enough for that vendor jitter (observed: 0.3%), far too narrow to swallow a genuinely different
// window (a daily 1440 or a monthly 43200 falls outside and is reported as drift, which is the point).
const FIVE_HOUR_MINUTES = 300;
const WEEKLY_MINUTES = 10_080;
const DURATION_TOLERANCE = 0.1;

/** The marker `fields` entry that carries a decode divergence to the operator (VENDOR DRIFT IS LOUD).
 *  Read back by use-cockpit-bus.ts's diagnosticFromUsagePayload, which surfaces it in /status. */
export const USAGE_DRIFT_FIELD = "drift:";

/** One codex quota window as the vendor sends it. `resets_at` is an ABSOLUTE epoch in SECONDS (the
 *  current shape); `resets_in_seconds` is the RELATIVE remaining seconds (the 2025 shape). Both are
 *  real captures, so both are read - the relative form needs the observation instant to become absolute. */
export interface CodexQuotaWindow {
  readonly used_percent?: number;
  readonly window_minutes?: number;
  readonly resets_at?: number;
  readonly resets_in_seconds?: number;
}

/** The pay-as-you-go credit wallet. DECLARED because it arrives, DECODED for nothing: it is not the
 *  subscription entitlement and never decides exhaustion (see the file header). `unlimited` has never
 *  been captured as `true`, so no behaviour is written for that value - exhaustion is made structurally
 *  independent of this block instead, which codex-usage-decode.test.ts proves from two real captures
 *  whose credit blocks are byte-identical and whose verdicts are opposite. */
export interface CodexCredits {
  readonly has_credits?: boolean;
  readonly unlimited?: boolean;
  readonly balance?: string;
}

/** The codex per-turn usage window. `primary`/`secondary` are POSITIONS, not window kinds - which one
 *  holds the weekly depends on the plan, so neither name may be trusted to mean a duration. */
export interface CodexRateLimits {
  readonly credits?: CodexCredits | null;
  readonly primary?: CodexQuotaWindow | null;
  readonly secondary?: CodexQuotaWindow | null;
}

/**
 * The `info` block of a token_count event. `last_token_usage.total_tokens` is the PER-TURN occupancy
 * (stays within the window); it is the numerator for context-left. `total_token_usage` is CUMULATIVE
 * session billing (monotonic, exceeds the window -> a 166%/negative bug) and MUST NOT feed the calc, so
 * it is deliberately NOT modelled here. `model_context_window` is the window size; 0/missing -> omit.
 */
export interface CodexTokenInfo {
  readonly last_token_usage?: { readonly total_tokens?: number } | null;
  readonly model_context_window?: number | null;
}

/** The decode result: the render-ready usage plus, when the payload carried something we could not
 *  name, a plain-words divergence for the operator. `drift` is ABSENT on a clean decode. */
export interface CodexUsageDecode {
  readonly usage: AgentStatusUsage;
  readonly drift?: string;
}

type WindowKind = "fiveHour" | "weekly";

/** One window we could name: its kind, its USED %, and its reset instant (ms) when the payload had one. */
interface NamedWindow {
  readonly kind: WindowKind;
  readonly usedPct: number;
  readonly resetsAtMs?: number;
}

/**
 * Decodes one captured `rate_limits` (plus the SAME token_count line's `info`, and the instant that line
 * was observed) into the render-ready usage.
 *
 * ABSENT IS NOT ZERO: a window codex did not report contributes NO field - never a 0 that reads as fact.
 * A window whose duration we cannot name contributes no field either, and raises `drift` instead.
 */
export function decodeCodexUsage(
  rateLimits: CodexRateLimits,
  info?: CodexTokenInfo,
  observedAtMs?: number,
): CodexUsageDecode {
  const { named, drift } = readWindows(rateLimits, observedAtMs);
  const ctx = contextUsedPct(info);
  const usage: AgentStatusUsage = {
    label: bindingLabel(named),
    exhausted: named.some((w) => w.usedPct >= 100),
    ...meterFields(named),
    ...(ctx !== undefined ? { contextUsedPct: ctx } : {}),
  };
  return drift === undefined ? { usage } : { usage, drift };
}

// Reads BOTH positions, naming each by its stated duration. Position order is irrelevant to the result:
// a window lands on its meter because of `window_minutes`, never because of where it sat in the payload.
function readWindows(
  rl: CodexRateLimits,
  observedAtMs: number | undefined,
): { named: NamedWindow[]; drift?: string } {
  const named: NamedWindow[] = [];
  const divergences: string[] = [];
  for (const window of [rl.primary, rl.secondary]) {
    if (window === null || window === undefined) {
      continue; // not reported this turn - absent, which is neither 0% nor spent.
    }
    const kind = classifyWindow(window.window_minutes);
    const usedPct = usedPercent(window.used_percent);
    if (kind === undefined) {
      divergences.push(describeUnnameable(window));
      continue;
    }
    if (usedPct === undefined) {
      // A named window with no readable utilization: its reset instant is still real, but no meter is
      // invented for it. Recorded so a vendor dropping used_percent cannot go unnoticed.
      divergences.push(`codex reported a ${labelOf(kind)} window with no usage percent`);
      continue;
    }
    if (named.some((w) => w.kind === kind)) {
      divergences.push(`codex reported two ${labelOf(kind)} windows in one payload`);
      continue; // first-reported wins; the duplicate is recorded, never silently overwritten.
    }
    named.push({ kind, usedPct, ...optionalResetsAtMs(window, observedAtMs) });
  }
  return divergences.length === 0 ? { named } : { named, drift: divergences.join("; ") };
}

// Names a window by the duration the VENDOR states. Unknown/absent/degenerate -> undefined (drift), so a
// plan change that introduces a new window kind surfaces as an event instead of a wrong meter.
function classifyWindow(minutes: number | undefined): WindowKind | undefined {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
    return undefined;
  }
  if (Math.abs(minutes - FIVE_HOUR_MINUTES) <= FIVE_HOUR_MINUTES * DURATION_TOLERANCE) {
    return "fiveHour";
  }
  if (Math.abs(minutes - WEEKLY_MINUTES) <= WEEKLY_MINUTES * DURATION_TOLERANCE) {
    return "weekly";
  }
  return undefined;
}

// The divergence text for a window we cannot name - built from NUMBERS we parsed ourselves (INV-13); no
// vendor string is ever interpolated into an operator-visible line.
function describeUnnameable(window: CodexQuotaWindow): string {
  const minutes = window.window_minutes;
  return typeof minutes === "number" && Number.isFinite(minutes)
    ? `codex reported a ${String(Math.round(minutes))}-minute quota window this build cannot name`
    : "codex reported a quota window with no stated duration";
}

// USED % (0..100) of one window, or undefined when absent/non-finite - clamped defensively.
function usedPercent(pct: number | undefined): number | undefined {
  if (typeof pct !== "number" || !Number.isFinite(pct)) {
    return undefined;
  }
  return Math.min(100, Math.max(0, Math.round(pct)));
}

// The window's reset instant in MS. Prefers the absolute `resets_at` (epoch SECONDS, the current shape);
// falls back to the 2025 relative `resets_in_seconds` measured from when the line was observed. Without
// an observation instant the relative form cannot be made absolute, so it is dropped rather than guessed.
function optionalResetsAtMs(
  window: CodexQuotaWindow,
  observedAtMs: number | undefined,
): { readonly resetsAtMs?: number } {
  const at = window.resets_at;
  if (typeof at === "number" && Number.isFinite(at) && at > 0) {
    return { resetsAtMs: Math.round(at * 1000) };
  }
  const remaining = window.resets_in_seconds;
  if (observedAtMs !== undefined && typeof remaining === "number" && Number.isFinite(remaining)) {
    return { resetsAtMs: Math.round(observedAtMs + remaining * 1000) };
  }
  return {};
}

// The meter fields, each written ONLY for a window that was actually reported and named.
function meterFields(named: readonly NamedWindow[]): {
  fiveHourUsedPct?: number;
  fiveHourResetsAtMs?: number;
  weeklyUsedPct?: number;
  weeklyResetsAtMs?: number;
} {
  const five = named.find((w) => w.kind === "fiveHour");
  const weekly = named.find((w) => w.kind === "weekly");
  return {
    ...(five !== undefined ? { fiveHourUsedPct: five.usedPct } : {}),
    ...(five?.resetsAtMs !== undefined ? { fiveHourResetsAtMs: five.resetsAtMs } : {}),
    ...(weekly !== undefined ? { weeklyUsedPct: weekly.usedPct } : {}),
    ...(weekly?.resetsAtMs !== undefined ? { weeklyResetsAtMs: weekly.resetsAtMs } : {}),
  };
}

// The binding-window label: the most-used named window, NAMED. The previous label was a bare "NN%" taken
// from whichever position came first, so a weekly-only lane read as an unqualified number that the rest
// of the product treated as a 5h reading. "OK" when no window was named - never a fabricated percentage.
function bindingLabel(named: readonly NamedWindow[]): string {
  const binding = named.reduce<NamedWindow | undefined>(
    (a, b) => (a === undefined || b.usedPct > a.usedPct ? b : a),
    undefined,
  );
  return binding === undefined ? "OK" : `${labelOf(binding.kind)} ${String(binding.usedPct)}%`;
}

function labelOf(kind: WindowKind): string {
  return kind === "fiveHour" ? "5h" : "wk";
}

/**
 * The PER-TURN context-USED percent from the token_count `info`:
 *   clamp(round((last_token_usage.total_tokens / model_context_window) * 100), 0, 100).
 * Uses last_token_usage (per-turn occupancy, stays within the window), NEVER total_token_usage
 * (cumulative session billing -> can exceed the window -> a 166% bug). Returns undefined when the window
 * is missing/0 OR last_token_usage is absent - the field is then OMITTED from the usage.
 */
function contextUsedPct(info: CodexTokenInfo | undefined): number | undefined {
  const window = info?.model_context_window;
  const last = info?.last_token_usage?.total_tokens;
  if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) {
    return undefined;
  }
  if (typeof last !== "number" || !Number.isFinite(last)) {
    return undefined;
  }
  return Math.min(100, Math.max(0, Math.round((last / window) * 100)));
}
