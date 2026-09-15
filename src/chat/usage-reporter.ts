/**
 * @file src/chat/usage-reporter.ts
 * @purpose Shared post-lane usage reporter for legacy headless lanes and carrier lanes. Emits status
 *   updates plus field-shape diagnostics, including a receipt for every repeated sample it dedupes.
 * @exports LaneUsageReporter, UsageReporterInput, UsageCaptureOverride, createUsageReporter
 * @depends ../adapters/acp/acp-turn-session, ../shared/turn-usage, ./agy-statusline-config, ./agy-statusline-payload, ./claude-usage-fold, ./codex-rate-limits, ./events, ./statusline-config, ./statusline-payload, ./types, ./usage-payload-emitter
 */
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { usageFromUpdate } from "../adapters/acp/acp-turn-session.js";
import type { TurnUsage } from "../shared/turn-usage.js";
import { agyStatuslinePaths } from "./agy-statusline-config.js";
import { readAgyStatusUsageWhenFreshForLane } from "./agy-statusline-payload.js";
import { foldClaudeWindows } from "./claude-usage-fold.js";
import { type CodexUsageRead, emitCodexUsageFromRollout } from "./codex-rate-limits.js";
import { USAGE_DRIFT_FIELD } from "./codex-usage-decode.js";
import type { ChatEventBus } from "./events.js";
import { noteLaneResetWindow } from "./lane-availability-store.js";
import { claudeStatuslinePaths } from "./statusline-config.js";
import {
  acpUsageToStatus,
  bindingResetAtMs,
  readClaudeStatusUsageWhenFresh,
} from "./statusline-payload.js";
import type { AgentStatusUsage } from "./statusline-payload.js";
import type { AgentName } from "./types.js";
import {
  type PayloadEmitter,
  type UsagePayloadOutcome,
  usageOutcomeMarker,
  usagePayloadEmitter,
} from "./usage-payload-emitter.js";

export type UsageCaptureOverride = (args: {
  readonly agent: AgentName;
  readonly bus: ChatEventBus;
  readonly cwd: string;
  readonly startedMs: number;
  readonly turn: number;
}) => Promise<void>;

export interface UsageReporterInput {
  readonly agent: AgentName;
  readonly bus: ChatEventBus;
  readonly cwd: string;
  readonly startedMs: number;
  readonly turn: number;
  readonly carrier?: boolean;
  readonly laneSessionId?: () => string | undefined;
  /** Exact agy child cwd for this turn; evaluated after dispatch when the run plan is known. */
  readonly agyStatuslineCwd?: () => string | undefined;
  readonly usagePoll?: {
    readonly timeoutMs?: number;
    readonly intervalMs?: number;
    readonly signal?: AbortSignal;
  };
}

export interface LaneUsageReporter {
  readonly capturePostLane: (override?: UsageCaptureOverride) => Promise<void>;
  readonly recordAcpResult: (usage: TurnUsage | undefined) => void;
  readonly recordAcpSessionUpdate: (update: unknown) => void;
}

/** Everything {@link recordAcpStatus} needs from the reporter that owns it. Bundled rather than passed
 *  as four more arguments because the clamp on parameters is five and this function has its own. */
interface AcpRecordContext {
  readonly input: UsageReporterInput;
  readonly emitPayload: PayloadEmitter["emit"];
  /** W4-R2f RA-4: has THIS lane's ACP bridge delivered a QUOTA window yet — the thing the statusline
   *  probe exists to supply? A context-only update does NOT count, and that distinction is the whole
   *  correctness of the gate (see capturePostLaneInner). Per-reporter, i.e. per turn: one turn's ACP
   *  silence must never be answered with a previous turn's arrival. A holder rather than a captured
   *  `let`, because this moved out of the closure that used to own it. */
  readonly quota: { arrived: boolean };
}

/**
 * Publish one ACP usage reading as `agent.status`, plus its diagnostic.
 *
 * EXTRACTED from `createUsageReporter`, which the F7 guard pushed to 56 lines against a 50-line clamp.
 * The clamp is a ratchet and only falls, so the answer is the seam that was already there: this is the
 * only part of the reporter that turns a `TurnUsage` into a published status, and it has no lifecycle
 * in it.
 */
function recordAcpStatus(
  ctx: AcpRecordContext,
  usage: TurnUsage | undefined,
  source: "acp.result" | "acp.usage_update",
  marker?: UsagePayloadOutcome,
): void {
  if (usage === undefined) return;
  // F7. THE GUARD EVERY OTHER PUBLISHER HERE ALREADY HAD. This one emits `agent.status` on the bus
  // DIRECTLY rather than through `emitStatus`, so it never inherited that function's abort check —
  // harmless while nothing could reach it after teardown, and no longer harmless now that a `/usage`
  // answer forwarded late by the bridge arrives on its own schedule. A room that has torn its usage
  // capture down (shutdown, or a cancelled turn) must not be handed a status afterwards.
  if (usageCaptureAborted(ctx.input)) return;
  const status = acpStatusForAgent(ctx.input.agent, usage);
  if (status === undefined) {
    ctx.emitPayload(source, "malformed", []);
    return;
  }
  if (status.fiveHourUsedPct !== undefined || status.weeklyUsedPct !== undefined) {
    ctx.quota.arrived = true;
  }
  ctx.input.bus.emit({ kind: "agent.status", agent: ctx.input.agent, usage: status });
  // The ctx numbers on a receipt update are real and still publish; only the DIAGNOSTIC outcome
  // changes, from "arrived" (which was a lie about the windows) to why they are not there.
  ctx.emitPayload(source, marker ?? "arrived", usageFields(status));
}

export function createUsageReporter(input: UsageReporterInput): LaneUsageReporter {
  const payloads = usagePayloadEmitter(input, () => usageCaptureAborted(input));
  const emitPayload = payloads.emit;
  const ctx: AcpRecordContext = { input, emitPayload, quota: { arrived: false } };
  return {
    capturePostLane: async (override) => {
      if (usageCaptureAborted(input)) return;
      try {
        await capturePostLane(input, emitPayload, override, ctx.quota.arrived);
      } finally {
        if (!usageCaptureAborted(input)) payloads.flushDropped();
      }
    },
    recordAcpResult: (usage) => recordAcpStatus(ctx, usage, "acp.result"),
    recordAcpSessionUpdate: (update) => {
      if (!isUsageUpdate(update)) return;
      const marker = usageOutcomeMarker(update);
      emitPayload(
        "acp.usage_update.raw",
        marker ?? "arrived",
        rawUsageUpdateFields(update),
        update,
      );
      recordAcpStatus(ctx, usageFromUpdate(update), "acp.usage_update", marker);
    },
  };
}

async function capturePostLane(
  input: UsageReporterInput,
  emitPayload: PayloadEmitter["emit"],
  override: UsageCaptureOverride | undefined,
  acpQuotaArrived: boolean,
): Promise<void> {
  if (usageCaptureAborted(input)) return;
  try {
    await capturePostLaneInner(input, emitPayload, override, acpQuotaArrived);
  } catch {
    if (usageCaptureAborted(input)) return;
    emitPayload(fallbackSource(input.agent), "malformed", []);
  }
}

function usageCaptureAborted(input: UsageReporterInput): boolean {
  return input.usagePoll?.signal?.aborted === true;
}

/**
 * W4-R2f RA-4 — DO NOT ASK A QUESTION THAT IS ALREADY ANSWERED.
 *
 * THE OPERATOR'S TRACE, 2026-07-31, one turn, in order:
 *   15:20:08.625  usage.payload claude acp.usage_update  arrived  [ctx, 5h, 5h-reset, wk, wk-reset]
 *   15:20:14.206  usage.payload claude claude.statusline missing  []
 * The ACP bridge had delivered claude's whole window five seconds earlier. This probe then polled the
 * statusline file for ~5s, found nothing (it never writes under ACP), and reported `missing` — which
 * use-cockpit-bus.ts's diagnosticFromUsagePayload turns into `/status` reading
 * "missing from claude.statusline" ON A LANE WHOSE NUMBERS ARRIVED FINE. A healthy lane described as
 * broken is the same class of lie this wave keeps closing, and it cost a five-second poll per turn to
 * produce it.
 *
 * NOT A DELETION, AND THE PREDICATE IS QUOTA-SPECIFIC FOR A MEASURED REASON. The first draft of this
 * gate skipped on ANY arrived ACP usage, and the falsifier directly below in usage-reporter.test.ts
 * ("carrier claude ACP ctx is followed by statusline 5h windows") caught it: claude's FIRST
 * usage_update carries only `used`/`size`, i.e. CONTEXT ALONE — visible in that same operator trace at
 * 15:20:07.394, fields [label, exhausted, contextUsedPct]. A bridge that only ever sends that shape
 * still needs the statusline for the 5h and weekly windows, and skipping on it would have deleted the
 * operator's quota meters. So the skip requires a QUOTA reading from ACP — exactly the windows this
 * probe would otherwise supply, and nothing less.
 *
 * The statusline read remains the PTY / older-bridge path's real source (statusline-payload.ts,
 * pty-session-registry.ts) and runs unchanged whenever ACP has not answered. Scoped to claude because
 * that is where two sources overlap at all: codex's rollout read and agy's statusline are the ONLY
 * sources for windows their ACP streams do not carry.
 */
async function capturePostLaneInner(
  input: UsageReporterInput,
  emitPayload: PayloadEmitter["emit"],
  override: UsageCaptureOverride | undefined,
  acpQuotaArrived: boolean,
): Promise<void> {
  if (override !== undefined) {
    await captureOverride(input, emitPayload, override);
    return;
  }
  if (input.agent === "claude") {
    if (acpQuotaArrived) return;
    await captureClaudeStatus(input, emitPayload);
  } else if (input.agent === "codex") await captureCodexStatus(input, emitPayload);
  else await captureAgyStatus(input, emitPayload);
}

async function captureOverride(
  input: UsageReporterInput,
  emitPayload: PayloadEmitter["emit"],
  override: UsageCaptureOverride,
): Promise<void> {
  try {
    await override(input);
    emitPayload("capture.override", "missing", []);
  } catch {
    emitPayload("capture.override", "malformed", []);
  }
}

async function captureClaudeStatus(
  input: UsageReporterInput,
  emitPayload: PayloadEmitter["emit"],
): Promise<void> {
  try {
    const payloadPath = claudeStatuslinePaths(input.cwd).payloadPath;
    const usage = await readClaudeStatusUsageWhenFresh(
      payloadPath,
      input.startedMs,
      input.usagePoll,
    );
    if (usage === undefined) {
      emitPayload(
        "claude.statusline",
        (await statuslineWriteFailureIsFresh(payloadPath, input.startedMs))
          ? "write-failed"
          : "missing",
        [],
      );
    } else emitStatus(input, emitPayload, "claude.statusline", usage);
  } catch {
    emitPayload("claude.statusline", "malformed", []);
  }
}

async function captureCodexStatus(
  input: UsageReporterInput,
  emitPayload: PayloadEmitter["emit"],
): Promise<void> {
  try {
    const read = await emitCodexUsageFromRollout(input.bus, optionalCodexSession(input));
    if (read.outcome === "arrived") {
      noteResetWindow(input.agent, read.usage);
    }
    emitPayload("codex.rollout", read.outcome, codexFields(read));
  } catch {
    emitPayload("codex.rollout", "malformed", []);
  }
}

// W4-R2b (VENDOR DRIFT MUST BE LOUD): the decoded field names, plus — when codex reported a quota window
// whose duration this build cannot name — the divergence itself. The outcome stays "arrived" because the
// usage genuinely did arrive; only one window could not be named, and calling the whole payload malformed
// would discard the context reading that decoded fine. The marker is lifted back off `fields` by
// use-cockpit-bus.ts's diagnosticFromUsagePayload, so a plan change surfaces in /status instead of
// silently costing the operator a meter. (Chosen over extending the closed UsagePayloadOutcome union:
// no consumer needs to BRANCH on drift, only to show it, and the union is mirrored in three files.)
function codexFields(read: CodexUsageRead): readonly string[] {
  if (read.outcome !== "arrived") {
    return [];
  }
  const fields = usageFields(read.usage);
  return read.drift === undefined ? fields : [...fields, `${USAGE_DRIFT_FIELD}${read.drift}`];
}

async function captureAgyStatus(
  input: UsageReporterInput,
  emitPayload: PayloadEmitter["emit"],
): Promise<void> {
  const read = await readAgyStatusUsageWhenFreshForLane(
    agyStatuslinePaths().payloadPath,
    input.startedMs,
    {
      cwd: input.agyStatuslineCwd?.() ?? input.cwd,
      ...optionalSessionId(input.laneSessionId?.()),
    },
    input.usagePoll,
  );
  if (read.outcome === "arrived") emitStatus(input, emitPayload, "agy.statusline", read.usage);
  else emitPayload("agy.statusline", read.outcome, []);
}

function emitStatus(
  input: UsageReporterInput,
  emitPayload: PayloadEmitter["emit"],
  source: string,
  usage: AgentStatusUsage,
): void {
  if (input.usagePoll?.signal?.aborted === true) return;
  input.bus.emit({ kind: "agent.status", agent: input.agent, usage });
  noteResetWindow(input.agent, usage);
  emitPayload(source, "arrived", usageFields(usage));
}

/**
 * BLOCK 1 (F1): feed the lane-availability store the real reset window this usage carries, so a LATER
 * credit/auth death recovers on the TRUE window instead of only the conservative fallback cooldown.
 * FIX-3c BLOCK 5: the window that matters is the BINDING one, not always the 5h one. The field death was
 * weekly-based (weeklyUsedPct 97-98 while the 5h window sat at 27-32), so recording the 5h reset told
 * recovery to expect capacity back in hours when it was really days away — and the lane re-probed every
 * 15 minutes in between. bindingResetAtMs reads the same highest-used rule the meter label uses.
 *
 * W4-R2b: split out of emitStatus because CODEX NEVER REACHED IT. codex's capture emits its own
 * agent.status from inside emitCodexUsageFromRollout and returns, so it skipped emitStatus entirely and
 * with it this deposit — a codex lane could only ever recover on the guessed 15-minute cooldown. The
 * decode fix alone would not have shown that: codex had no reset instant to deposit either way.
 */
function noteResetWindow(agent: AgentName, usage: AgentStatusUsage): void {
  const reset = bindingResetAtMs(usage);
  if (reset !== undefined) {
    noteLaneResetWindow(agent, reset);
  }
}

function acpStatusForAgent(agent: AgentName, usage: TurnUsage): AgentStatusUsage | undefined {
  if (agent === "claude") return acpUsageToStatus(foldClaudeWindows(usage));
  if (agent === "codex") return acpUsageToStatus(usage);
  return undefined;
}

function fallbackSource(agent: AgentName): string {
  if (agent === "claude") return "claude.statusline";
  if (agent === "codex") return "codex.rollout";
  return "agy.statusline";
}

function optionalSessionId(sessionId: string | undefined): { readonly sessionId?: string } {
  return sessionId === undefined ? {} : { sessionId };
}

/** M3: the codex rollout read gets the SAME poll bound and the SAME abort signal the claude and agy
 *  reads already carry (`input.usagePoll` at the two capture sites above). Until this, RolloutReadOptions
 *  had no slot for a signal, so a room shutting down mid-read had no way to say so and codex's read
 *  could not wait for a turn's number even when it was one interval away. */
function optionalCodexSession(input: UsageReporterInput): {
  readonly freshAfterMs: number;
  readonly sessionId?: string;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly signal?: AbortSignal;
} {
  return {
    freshAfterMs: input.startedMs,
    ...optionalSessionId(input.laneSessionId?.()),
    ...(input.usagePoll ?? {}),
  };
}

function usageFields(usage: AgentStatusUsage): readonly string[] {
  return [
    "label",
    "exhausted",
    ...optionalField("resets", usage.resets),
    ...optionalField("contextUsedPct", usage.contextUsedPct),
    ...optionalField("fiveHourUsedPct", usage.fiveHourUsedPct),
    ...optionalField("fiveHourResetsAtMs", usage.fiveHourResetsAtMs),
    ...optionalField("weeklyUsedPct", usage.weeklyUsedPct),
    ...optionalField("weeklyResetsAtMs", usage.weeklyResetsAtMs),
  ];
}

function optionalField(name: string, value: unknown): readonly string[] {
  return value === undefined ? [] : [name];
}

async function statuslineWriteFailureIsFresh(
  payloadPath: string,
  startedMs: number,
): Promise<boolean> {
  const debugPath = join(dirname(payloadPath), "statusline-failures.ndjson");
  try {
    if ((await stat(debugPath)).mtimeMs < startedMs) return false;
    const lines = (await readFile(debugPath, "utf8")).split("\n");
    return lines.some((line) => {
      if (line.trim().length === 0) return false;
      try {
        const parsed = JSON.parse(line) as { path?: unknown; ts?: unknown };
        return parsed.path === payloadPath && freshTs(parsed.ts, startedMs);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function freshTs(ts: unknown, startedMs: number): boolean {
  if (typeof ts !== "string") return true;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) || ms >= startedMs;
}

function rawUsageUpdateFields(update: unknown): readonly string[] {
  if (!isRecord(update)) return [];
  const fields = [
    ...presentField(update, "sessionUpdate"),
    ...presentField(update, "used"),
    ...presentField(update, "size"),
    ...presentField(update, "cost"),
  ];
  const meta = isRecord(update._meta) ? update._meta : undefined;
  return [...fields, ...rawNestedFields(meta, "_meta")];
}

function rawNestedFields(value: unknown, path: string): readonly string[] {
  if (!isRecord(value)) return [];
  const fields: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (isRecord(child)) fields.push(...rawNestedFields(child, childPath));
    else fields.push(childPath);
  }
  return fields;
}

function presentField(
  record: Record<string, unknown> | undefined,
  name: string,
  key: string = name,
): readonly string[] {
  return record !== undefined && key in record ? [name] : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUsageUpdate(update: unknown): boolean {
  return (
    typeof update === "object" &&
    update !== null &&
    "sessionUpdate" in update &&
    update.sessionUpdate === "usage_update"
  );
}
