/**
 * @file src/room/room-usage-fold.ts
 * @purpose FL-094 — the room's PER-AGENT fold of the usage snapshot going out on agent.status, so a
 *   producer that knows half the picture cannot erase the other half.
 * @exports RoomUsageFold
 * @depends ../chat/events, ../chat/statusline-payload, ../chat/types, ../shared/rate-window-merge,
 *   ../shared/turn-usage
 *
 * WHY THIS EXISTS. Two producers publish codex usage by different routes — the rollout read emits
 * agent.status directly (codex-rate-limits.ts:196-204) and the ACP path emits its own
 * (usage-reporter.ts:96) — and each one only knows its own half. The Rust reducer replaces the prior
 * usage object WHOLESALE when a status carries any usage at all (reducer.rs:668, deliberate and
 * pinned), so the half that arrived last erased the other. Claude escaped this only because
 * foldClaudeWindows re-stamps its learned windows onto every ACP update (usage-reporter.ts:358);
 * codex had no equivalent and lost its weekly on every context-only turn.
 *
 * THE INVARIANT IS "a status that does not mention a window must not erase that window", and this
 * satisfies it by making every status mention every window the room still knows about. The reducer is
 * untouched by design — it is shared with the protocol conformance corpus — which means it stays a
 * one-line trap for any FUTURE producer that reaches the wire without crossing this seam.
 *
 * NOT the process-global shape of claude-usage-fold.ts: keyed by agent, owned by AliveRoomHost, born
 * and dying with the room. contextUsedPct is SESSION state and must not outlive its room; the 5h and
 * weekly windows are ACCOUNT state and expire against their own resets instead.
 */
import type { AgentStatusUpdateEvent } from "../chat/events.js";
import type { AgentStatusUsage } from "../chat/statusline-payload.js";
import type { AgentName } from "../chat/types.js";
import { mergeRateWindows } from "../shared/rate-window-merge.js";
import type { ClaudeRateWindow, ClaudeRateWindows } from "../shared/turn-usage.js";

/** The usage as it arrives on the bus: AgentStatusUsage with an explicit `| undefined` allowed on every
 *  optional, which is how events.ts:278-289 declares it. Accepting the wider shape is what lets this sit
 *  directly on the bus handler without a cast. */
type IncomingUsage = NonNullable<AgentStatusUpdateEvent["usage"]>;

/** The four quota fields, with the bus's own `| undefined` tolerance, so one predicate reads both an
 *  incoming event and a stored snapshot without a cast. */
type QuotaSurface = {
  readonly fiveHourUsedPct?: number | undefined;
  readonly fiveHourResetsAtMs?: number | undefined;
  readonly weeklyUsedPct?: number | undefined;
  readonly weeklyResetsAtMs?: number | undefined;
};

type MeterFields = {
  readonly fiveHourUsedPct?: number;
  readonly fiveHourResetsAtMs?: number;
  readonly weeklyUsedPct?: number;
  readonly weeklyResetsAtMs?: number;
};

export class RoomUsageFold {
  private readonly known = new Map<AgentName, AgentStatusUsage>();

  /**
   * Folds one outgoing snapshot onto what this room already knows for `agent` and returns the snapshot
   * that should reach the wire. Per field, the incoming reading wins when present; an absent field
   * inherits. A window whose own reset has passed is dropped rather than inherited — an expired 71% is
   * a statement about a period that has ended (F7b).
   */
  public fold(
    agent: AgentName,
    incoming: IncomingUsage,
    nowMs: number = Date.now(),
  ): AgentStatusUsage {
    const prior = this.known.get(agent);
    const merged = pruneExpired(
      prior === undefined ? adopt(incoming) : mergeSnapshots(prior, incoming),
      nowMs,
    );
    this.known.set(agent, merged);
    return merged;
  }

  /**
   * Seeds the fold from a recovered room's journal so a resumed room does not silently regress to
   * whatever the next partial update happens to carry. Replay runs the SAME merge the live path runs, in
   * journal order, so a recovered room reaches the state an uninterrupted one would have held.
   * A fresh room has no journal and therefore starts knowing nothing — required behaviour rather than a
   * side effect: a previous session's context reading is a real number about the wrong thing (the rule
   * eager-boot-numbers.test.ts already states for the rollout).
   */
  public seed(
    events: readonly { readonly type: string; readonly payload?: unknown }[],
    nowMs: number = Date.now(),
  ): void {
    for (const event of events) {
      if (event.type !== "agent.status") continue;
      const seeded = seededSnapshot(event.payload);
      if (seeded !== undefined) this.fold(seeded.agent, seeded.usage, nowMs);
    }
  }
}

// ── the merge ────────────────────────────────────────────────────────────────────────────────────────

/** Narrows the bus shape to the stored one by rebuilding it, so no explicit `undefined` is ever stored
 *  or re-emitted: on this wire an absent key and a present-but-undefined key are different claims. */
function adopt(usage: IncomingUsage): AgentStatusUsage {
  const meters = metersOf(usage);
  return {
    label: usage.label,
    exhausted: usage.exhausted,
    ...optional("contextUsedPct", usage.contextUsedPct),
    ...meters,
  };
}

/**
 * Per-field merge of two normalized snapshots, delegating the WINDOW half to mergeRateWindows — the
 * primitive that already owns this rule (same-window tolerance, and the anti-ratchet that anchors an
 * inheriting merge to the EARLIER reset so inherited state cannot walk its own instant forward). A third
 * hand-written merge would be a third place for those two rules to drift.
 */
function mergeSnapshots(prior: AgentStatusUsage, incoming: IncomingUsage): AgentStatusUsage {
  const windows = mergeRateWindows(toWindows(prior), toWindows(incoming));
  const meters = fromWindows(windows, prior, incoming);
  // Session state, not account state: any newer reading replaces it, and an update with nothing to say
  // about context keeps the last thing the room was told. The room lifecycle is what clears it.
  const contextUsedPct = incoming.contextUsedPct ?? prior.contextUsedPct;
  return {
    ...labelFor(meters, exhaustedFor(prior, incoming, meters)),
    ...optional("contextUsedPct", contextUsedPct),
    ...meters,
  };
}

/**
 * A snapshot that says nothing about quota cannot CLEAR an exhaustion verdict — its `exhausted: false`
 * is the absence of a claim, not an observation (acpUsageToStatus returns exactly that for any ctx-only
 * update), and reading it as one is the same class of lie FL-094 is. A snapshot that DOES report a
 * window is believed, then re-OR'd against the merged meters so an inherited spent window still reads
 * as spent.
 *
 * KNOWN LIMIT, and the reason the raw claude fold stays where it is: AgentStatusUsage has no per-window
 * status, so "the 5h window was REJECTED but carries no percentage" cannot survive a later same-window
 * percentage here. rate-window-merge.ts:38-43 keeps that for claude one layer up, on the raw windows.
 */
function exhaustedFor(
  prior: AgentStatusUsage,
  incoming: IncomingUsage,
  meters: MeterFields,
): boolean {
  const base = mentionsQuota(incoming) ? incoming.exhausted : prior.exhausted;
  return base || livePercents(meters).some((pct) => pct >= 100);
}

function mentionsQuota(meters: QuotaSurface): boolean {
  return (
    meters.fiveHourUsedPct !== undefined ||
    meters.fiveHourResetsAtMs !== undefined ||
    meters.weeklyUsedPct !== undefined ||
    meters.weeklyResetsAtMs !== undefined
  );
}

function livePercents(meters: QuotaSurface): readonly number[] {
  return [meters.fiveHourUsedPct, meters.weeklyUsedPct].filter(isNumber);
}

// Same rule acpUsageLabel uses on the raw windows (statusline-payload.ts:137-152): the binding window is
// the highest-used one. Recomputed from the MERGED meters so the label can never describe a set of
// numbers other than the one travelling with it. `label` is not on the wire (roomAgentStatusPayload
// never writes it) — it is kept coherent so the object stays internally true, not for a consumer.
function labelFor(
  meters: MeterFields,
  exhausted: boolean,
): { readonly label: string; readonly exhausted: boolean } {
  const used = livePercents(meters);
  return { label: used.length === 0 ? "ctx" : `${Math.max(...used)}%`, exhausted };
}

// ── expiry ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Drops each window whose own reset instant has passed. Expiry AT the instant, matching
 * claude-usage-fold.ts's liveWindow: by then the account window has reset and the number describes a
 * period that is over. A window with NO reset has no basis to expire and is kept until superseded — the
 * same rule pruneExpired states, and the reason F3d's "a missing reset counts fresh" holds.
 *
 * When nothing expired this returns the snapshot untouched, which is load-bearing: a snapshot whose
 * exhaustion came from a verdict carrying neither percentage nor reset keeps it, because there is
 * nothing here that could re-derive it.
 */
function pruneExpired(usage: AgentStatusUsage, nowMs: number): AgentStatusUsage {
  const five = expired(usage.fiveHourResetsAtMs, nowMs);
  const weekly = expired(usage.weeklyResetsAtMs, nowMs);
  if (!five && !weekly) return usage;
  const meters: MeterFields = {
    ...(five ? {} : optional("fiveHourUsedPct", usage.fiveHourUsedPct)),
    ...(five ? {} : optional("fiveHourResetsAtMs", usage.fiveHourResetsAtMs)),
    ...(weekly ? {} : optional("weeklyUsedPct", usage.weeklyUsedPct)),
    ...(weekly ? {} : optional("weeklyResetsAtMs", usage.weeklyResetsAtMs)),
  };
  return {
    ...labelFor(meters, usage.exhausted && stillSupported(meters)),
    ...optional("contextUsedPct", usage.contextUsedPct),
    ...meters,
  };
}

/**
 * Can an exhaustion verdict still be true once a window has expired out from under it? Only if a
 * SURVIVING window could carry it: one that is genuinely spent, or one that reports a reset with no
 * percentage — the unquantified-verdict shape this normalized snapshot cannot tell apart from an
 * ordinary window. Otherwise the verdict died with its window, and keeping it matters beyond cosmetics:
 * reducer.rs:669-673 promotes auth Ready→Limited off `exhausted`, so a stale true words a working agent
 * as limited.
 */
function stillSupported(meters: MeterFields): boolean {
  const spent = livePercents(meters).some((pct) => pct >= 100);
  const unquantified =
    (meters.fiveHourResetsAtMs !== undefined && meters.fiveHourUsedPct === undefined) ||
    (meters.weeklyResetsAtMs !== undefined && meters.weeklyUsedPct === undefined);
  return spent || unquantified;
}

function expired(resetsAtMs: number | undefined, nowMs: number): boolean {
  return resetsAtMs !== undefined && resetsAtMs <= nowMs;
}

// ── projection to and from the window primitive ──────────────────────────────────────────────────────

// mergeRateWindows compares reset instants in SECONDS against a 60-second same-window tolerance, so the
// projection must speak seconds — handing it milliseconds would shrink that tolerance to 60ms and read
// two reports of the same window as a roll. The exact millisecond value is restored afterwards.
function toWindows(usage: IncomingUsage): ClaudeRateWindows {
  const five = window(usage.fiveHourUsedPct, usage.fiveHourResetsAtMs);
  const weekly = window(usage.weeklyUsedPct, usage.weeklyResetsAtMs);
  return {
    ...(five === undefined ? {} : { five_hour: five }),
    ...(weekly === undefined ? {} : { seven_day: weekly }),
  };
}

function window(
  usedPct: number | undefined,
  resetsAtMs: number | undefined,
): ClaudeRateWindow | undefined {
  if (usedPct === undefined && resetsAtMs === undefined) return undefined;
  return {
    ...optional("utilization", usedPct),
    ...optional("resetsAt", resetsAtMs === undefined ? undefined : Math.round(resetsAtMs / 1000)),
  };
}

function fromWindows(
  windows: ClaudeRateWindows,
  prior: AgentStatusUsage,
  incoming: IncomingUsage,
): MeterFields {
  return {
    ...optional("fiveHourUsedPct", windows.five_hour?.utilization),
    ...optional(
      "fiveHourResetsAtMs",
      restoreMs(windows.five_hour, incoming.fiveHourResetsAtMs, prior.fiveHourResetsAtMs),
    ),
    ...optional("weeklyUsedPct", windows.seven_day?.utilization),
    ...optional(
      "weeklyResetsAtMs",
      restoreMs(windows.seven_day, incoming.weeklyResetsAtMs, prior.weeklyResetsAtMs),
    ),
  };
}

/**
 * mergeWindow never COMPUTES a reset — it picks one of the two it was handed, or the earlier of them —
 * so the merged second-granular value always corresponds to one of the two original millisecond values.
 * Restoring by match keeps the wire number exact instead of truncating every reset to a whole second.
 */
function restoreMs(
  merged: ClaudeRateWindow | undefined,
  incomingMs: number | undefined,
  priorMs: number | undefined,
): number | undefined {
  const seconds = merged?.resetsAt;
  if (seconds === undefined) return undefined;
  if (incomingMs !== undefined && Math.round(incomingMs / 1000) === seconds) return incomingMs;
  if (priorMs !== undefined && Math.round(priorMs / 1000) === seconds) return priorMs;
  return seconds * 1000;
}

function metersOf(usage: IncomingUsage): MeterFields {
  return {
    ...optional("fiveHourUsedPct", usage.fiveHourUsedPct),
    ...optional("fiveHourResetsAtMs", usage.fiveHourResetsAtMs),
    ...optional("weeklyUsedPct", usage.weeklyUsedPct),
    ...optional("weeklyResetsAtMs", usage.weeklyResetsAtMs),
  };
}

// ── the recovered-journal seam ───────────────────────────────────────────────────────────────────────

const AGENTS: readonly AgentName[] = ["claude", "codex", "gemini"];

/**
 * Reads one journal agent.status payload back into a snapshot. The journal is UNTRUSTED on-disk data, so
 * every field is checked rather than asserted and anything unreadable is skipped: a malformed line costs
 * the fold that one reading, never the room's recovery. `label` is not on the wire
 * (room-host-support.ts's roomAgentStatusPayload never writes it), so it is recomputed from what is.
 */
function seededSnapshot(
  payload: unknown,
): { readonly agent: AgentName; readonly usage: AgentStatusUsage } | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const agent = AGENTS.find((name) => name === record.agent);
  const usage = record.usage;
  if (agent === undefined || usage === null || typeof usage !== "object") return undefined;
  const fields = usage as Record<string, unknown>;
  const meters: MeterFields = {
    ...optional("fiveHourUsedPct", finite(fields.fiveHourUsedPct)),
    ...optional("fiveHourResetsAtMs", finite(fields.fiveHourResetsAtMs)),
    ...optional("weeklyUsedPct", finite(fields.weeklyUsedPct)),
    ...optional("weeklyResetsAtMs", finite(fields.weeklyResetsAtMs)),
  };
  return {
    agent,
    usage: {
      ...labelFor(meters, fields.exhausted === true),
      ...optional("contextUsedPct", finite(fields.contextUsedPct)),
      ...meters,
    },
  };
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optional<K extends string>(
  name: K,
  value: number | undefined,
): Partial<Record<K, number>> {
  return value === undefined ? {} : ({ [name]: value } as Record<K, number>);
}

function isNumber(value: number | undefined): value is number {
  return value !== undefined;
}
