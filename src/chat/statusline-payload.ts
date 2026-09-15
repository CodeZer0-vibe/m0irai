/**
 * @file src/chat/statusline-payload.ts
 * @purpose Read claude's UNTRUSTED statusLine payload file and normalize it to AgentStatusUsage.
 *   TRUST BOUNDARY (INV-13): the Zod schema reads ONLY the numeric fields we need — model.display_name,
 *   cwd, session_id etc. are stripped before any code sees them, so no raw payload string can reach a
 *   label (the output is numbers we format ourselves). Malformed/partial/missing file → undefined
 *   (never throws); the caller leaves the prior status-bar cell unchanged. All percentages are USED %.
 * @exports AgentStatusUsage, acpUsageToStatus, bindingResetAtMs, readClaudeStatusUsage, readClaudeStatusUsageWhenFresh
 * @depends node:fs/promises, zod, ../shared/abortable-delay, ../shared/turn-usage
 */
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { abortableDelay } from "../shared/abortable-delay.js";
import type { ClaudeRateWindow, ClaudeRateWindows } from "../shared/turn-usage.js";

/** The render-ready usage window a status producer (claude statusLine, codex rate_limits, agy statusLine)
 *  builds for the status bar — USED %s (how much is consumed) for the context window + the 5h and weekly
 *  quotas, each with its reset instant (for the staleness gate), plus a binding-window label. Numbers only
 *  (INV-13) — no raw payload string reaches a label. */
export type AgentStatusUsage = {
  readonly label: string;
  readonly exhausted: boolean;
  readonly resets?: string;
  readonly contextUsedPct?: number;
  readonly fiveHourUsedPct?: number;
  readonly fiveHourResetsAtMs?: number;
  readonly weeklyUsedPct?: number;
  readonly weeklyResetsAtMs?: number;
};

/**
 * FIX-3c BLOCK 5: the reset instant of the window that actually CONSTRAINS this lane — the one recovery
 * must wait for. Uses the SAME "binding = highest USED %" rule acpUsageLabel/usageFromWindows already use
 * for the label, so the meter and the recovery clock can never disagree (one rule, read here).
 * Why it matters: the field death (chat-1784553379589) was WEEKLY — weeklyUsedPct 97-98 while the 5h window
 * sat at 27-32 — so keying recovery off the 5h reset made an exhausted lane re-probe every 15 minutes for
 * DAYS. When only one utilization is known, the reset we DO have is the only honest answer; weekly is
 * preferred when instants exist but utilizations do not, because a weekly refusal is the longer wait and
 * under-waiting burns real dispatches while over-waiting only delays a probe (which
 * lane-availability.plausiblyReset caps independently, so this can never lock a lane out).
 * Neither instant present ⇒ undefined, and the caller keeps its conservative fallback cooldown.
 */
export function bindingResetAtMs(usage: AgentStatusUsage): number | undefined {
  const five = usage.fiveHourUsedPct;
  const weekly = usage.weeklyUsedPct;
  if (five !== undefined && weekly !== undefined) {
    const pick = weekly >= five ? usage.weeklyResetsAtMs : usage.fiveHourResetsAtMs;
    // The binding window may not carry a reset instant of its own; the sibling still beats nothing.
    return pick ?? usage.weeklyResetsAtMs ?? usage.fiveHourResetsAtMs;
  }
  return five === undefined
    ? (usage.weeklyResetsAtMs ?? usage.fiveHourResetsAtMs)
    : (usage.fiveHourResetsAtMs ?? usage.weeklyResetsAtMs);
}

/** A subscription rate-limit window in claude's payload (used_percentage + the reset epoch, in seconds). */
const WindowSchema = z
  .object({ used_percentage: z.number().optional(), resets_at: z.number().optional() })
  .optional();

/** The ONLY fields we extract — z.object strips everything else (model/cwd/session_id never seen). */
const PayloadSchema = z.object({
  context_window: z
    .object({
      used_percentage: z.number().nullable().optional(),
      remaining_percentage: z.number().nullable().optional(),
    })
    .optional(),
  rate_limits: z.object({ five_hour: WindowSchema, seven_day: WindowSchema }).optional(),
});

const clampPct = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

/**
 * Builds the status window from the ACP transport's raw turn usage: ctx% = used/size, plus — when the
 * session has captured rate_limit_event forwardings (U2d-b, `usage.rateLimits`) — the SAME 5h/weekly
 * meters the pty statusLine payload produced (USED %, reset ms, binding-window label), so claude renders
 * identically on either transport. A window with no reported utilization contributes its reset instant but
 * NEVER a fabricated % ; a 'rejected' window marks the usage exhausted with or without a number (rejected
 * MEANS rate-limited). Returns undefined when `size` ≤ 0 (no context window ⇒ nothing to show).
 */
export function acpUsageToStatus(usage: {
  readonly used: number;
  readonly size: number;
  readonly rateLimits?: ClaudeRateWindows;
}): AgentStatusUsage | undefined {
  if (!(usage.size > 0)) {
    return undefined;
  }
  const contextUsedPct = clampPct((usage.used / usage.size) * 100);
  if (usage.rateLimits === undefined) {
    return { label: "ctx", exhausted: false, contextUsedPct };
  }
  const meters = acpMeterFields(usage.rateLimits);
  return { ...acpUsageLabel(usage.rateLimits, meters), contextUsedPct, ...meters };
}

/** The 5h/weekly meter fields derived from the ACP-captured windows — same units as the pty extractors
 *  above (USED %, clamped; reset epoch in MS). Absent utilizations stay absent. */
function acpMeterFields(rl: ClaudeRateWindows): {
  fiveHourUsedPct?: number;
  fiveHourResetsAtMs?: number;
  weeklyUsedPct?: number;
  weeklyResetsAtMs?: number;
} {
  const five = rl.five_hour;
  const weekly = pickWeekly(rl);
  return {
    ...(typeof five?.utilization === "number"
      ? { fiveHourUsedPct: clampPct(five.utilization) }
      : {}),
    ...(typeof five?.resetsAt === "number" ? { fiveHourResetsAtMs: five.resetsAt * 1000 } : {}),
    ...(typeof weekly?.utilization === "number"
      ? { weeklyUsedPct: clampPct(weekly.utilization) }
      : {}),
    ...(typeof weekly?.resetsAt === "number" ? { weeklyResetsAtMs: weekly.resetsAt * 1000 } : {}),
  };
}

// The weekly meter's source window: the overall seven_day when captured, else the most-used MODEL weekly
// (opus/sonnet utilizations are the same USED-% unit) — "your most constrained weekly window", never a sum.
function pickWeekly(rl: ClaudeRateWindows): ClaudeRateWindow | undefined {
  if (rl.seven_day !== undefined) {
    return rl.seven_day;
  }
  const models = [rl.seven_day_opus, rl.seven_day_sonnet].filter(
    (w): w is ClaudeRateWindow => w !== undefined,
  );
  if (models.length === 0) {
    return undefined;
  }
  return models.reduce((a, b) => ((b.utilization ?? -1) > (a.utilization ?? -1) ? b : a));
}

// label/exhausted with the SAME semantics as usageFromWindows on the pty payload: label = the binding
// (highest-used) window %, exhausted at ≥100 — extended with the event's own verdict: ANY 'rejected'
// window ⇒ exhausted, even when no utilization number arrived (no fake "NN%" label is invented for it).
function acpUsageLabel(
  rl: ClaudeRateWindows,
  meters: { fiveHourUsedPct?: number; weeklyUsedPct?: number },
): { label: string; exhausted: boolean } {
  const rejected = [rl.five_hour, rl.seven_day, rl.seven_day_opus, rl.seven_day_sonnet].some(
    (w) => w?.status === "rejected",
  );
  const used = [meters.fiveHourUsedPct, meters.weeklyUsedPct].filter(
    (u): u is number => typeof u === "number",
  );
  if (used.length === 0) {
    return { label: "ctx", exhausted: rejected };
  }
  const pct = Math.max(...used);
  return { label: `${pct}%`, exhausted: rejected || pct >= 100 };
}

/** USED context %: used_percentage if present, else 100 − remaining_percentage, else undefined (boot). */
function contextUsed(cw: z.infer<typeof PayloadSchema>["context_window"]): number | undefined {
  if (typeof cw?.used_percentage === "number") return clampPct(cw.used_percentage);
  if (typeof cw?.remaining_percentage === "number") return clampPct(100 - cw.remaining_percentage);
  return undefined;
}

/** Usage label/exhausted from the binding (highest-used) rate window; undefined if neither present. */
function usageFromWindows(
  rl: z.infer<typeof PayloadSchema>["rate_limits"],
): { label: string; exhausted: boolean } | undefined {
  const used = [rl?.five_hour?.used_percentage, rl?.seven_day?.used_percentage].filter(
    (u): u is number => typeof u === "number",
  );
  if (used.length === 0) return undefined;
  const pct = Math.round(Math.max(...used));
  return { label: `${pct}%`, exhausted: pct >= 100 };
}

/** A rate window's USED % + reset epoch (ms): the shared extractor for both the 5h and weekly windows. */
function windowUsed(w: z.infer<typeof WindowSchema>): { usedPct?: number; resetsAtMs?: number } {
  return {
    ...(typeof w?.used_percentage === "number" ? { usedPct: clampPct(w.used_percentage) } : {}),
    ...(typeof w?.resets_at === "number" ? { resetsAtMs: w.resets_at * 1000 } : {}),
  };
}

/** The DISTINCT 5-hour window for the gauge: USED % + the reset epoch in MS (for the live countdown). */
function fiveHourFields(w: z.infer<typeof WindowSchema>): {
  fiveHourUsedPct?: number;
  fiveHourResetsAtMs?: number;
} {
  const u = windowUsed(w);
  return {
    ...(u.usedPct !== undefined ? { fiveHourUsedPct: u.usedPct } : {}),
    ...(u.resetsAtMs !== undefined ? { fiveHourResetsAtMs: u.resetsAtMs } : {}),
  };
}

/** The weekly (7-day) window for the weekly-on-low gauge: USED % + the reset epoch in MS. */
function weeklyFields(w: z.infer<typeof WindowSchema>): {
  weeklyUsedPct?: number;
  weeklyResetsAtMs?: number;
} {
  const u = windowUsed(w);
  return {
    ...(u.usedPct !== undefined ? { weeklyUsedPct: u.usedPct } : {}),
    ...(u.resetsAtMs !== undefined ? { weeklyResetsAtMs: u.resetsAtMs } : {}),
  };
}

/** Parse-at-edge: read + Zod-parse the payload file, normalize to AgentStatusUsage, or undefined. */
export async function readClaudeStatusUsage(
  payloadPath: string,
  minMtimeMs?: number,
): Promise<AgentStatusUsage | undefined> {
  let parsed: z.infer<typeof PayloadSchema>;
  try {
    // Freshness gate (codex BLOCK-2): the payload path is stable per-cwd, so a stale prior-turn payload
    // would be re-emitted as fresh when this turn's statusLine write is late/skipped/failed. Only a payload
    // written AT/AFTER the lane start (minMtimeMs) counts as this turn's; an older one → undefined (skip).
    if (minMtimeMs !== undefined && (await stat(payloadPath)).mtimeMs < minMtimeMs) {
      return undefined;
    }
    parsed = PayloadSchema.parse(JSON.parse(await readFile(payloadPath, "utf8")));
  } catch {
    return undefined; // missing file, malformed/partial JSON, or schema mismatch
  }
  const ctx = contextUsed(parsed.context_window);
  const usage = usageFromWindows(parsed.rate_limits);
  if (usage !== undefined) {
    return {
      ...usage,
      ...(ctx !== undefined ? { contextUsedPct: ctx } : {}),
      ...fiveHourFields(parsed.rate_limits?.five_hour),
      ...weeklyFields(parsed.rate_limits?.seven_day),
    };
  }
  if (ctx !== undefined) {
    return { label: "ctx", exhausted: false, contextUsedPct: ctx }; // context-only (no rate window)
  }
  return undefined; // boot render — nothing populated yet
}

/**
 * Polls {@link readClaudeStatusUsage} until a payload at/after `minMtimeMs` lands, then returns it. claude's
 * statusLine writes the payload ASYNCHRONOUSLY a beat after the turn finishes, so a single immediate read
 * loses that race — it sees the PRIOR turn's payload, which the freshness gate (correctly) rejects, and the
 * status bar never updates ("nothing shows"). Polling waits the write out. Returns undefined if nothing fresh
 * lands within `timeoutMs` — the no-stale-as-fresh guarantee (codex B2) is preserved. The caller invokes this
 * FIRE-AND-FORGET, so the poll never delays the lane it follows.
 */
export async function readClaudeStatusUsageWhenFresh(
  payloadPath: string,
  minMtimeMs: number,
  opts: {
    readonly timeoutMs?: number;
    readonly intervalMs?: number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<AgentStatusUsage | undefined> {
  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  const intervalMs = opts.intervalMs ?? 250;
  for (;;) {
    if (opts.signal?.aborted === true) return undefined;
    const usage = await readClaudeStatusUsage(payloadPath, minMtimeMs);
    if (usage !== undefined) {
      return usage;
    }
    if (Date.now() >= deadline) {
      return undefined;
    }
    await abortableDelay(intervalMs, opts.signal);
  }
}
