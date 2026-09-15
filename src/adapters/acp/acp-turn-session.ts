/**
 * @file src/adapters/acp/acp-turn-session.ts
 * @purpose Drive ONE persistent ACP session for turns: spawn the agent's ACP server against the provider-owned
 *   credential store, handshake once, then run prompts that stream the reply + resolve on stopReason. The sdk
 *   + subprocess hide behind the `openConnection` seam (orchestration unit-testable, no real agent). Permissions
 *   auto-approve (matches headless bypassPermissions; Control-Tower approval is later). Chunks returned RAW —
 *   the cockpit render escapes them (INV-13); the child env never carries a provider API key (INV-7).
 * @exports AcpClientHandlers, AcpSessionUpdateTap, TurnSession, TurnResult, TurnSessionDeps, acpSessionMetadata, createAcpClient, openTurnSession, spawnServer, usageFromUpdate
 * @depends node:child_process, node:process, node:stream, @agentclientprotocol/sdk, ../../shared/turn-usage, ./acp-servers, ./acp-permission, ../../shared/hermetic
 * @size-justified: ONE ACP session lifecycle — spawn, handshake, prompt, usage decode, and the client
 *   handler factory those turns run through. Every seam is exported FROM here precisely so siblings
 *   cannot fork a divergent copy of the spawn, the client, or the usage decode.
 */
import { type ChildProcess, spawn } from "node:child_process";
import process from "node:process";
import { Readable, Writable } from "node:stream";
import { type Client, ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { assertNotHermetic } from "../../shared/hermetic.js";
import { mergeRateWindows } from "../../shared/rate-window-merge.js";
import type { ClaudeRateWindow, ClaudeRateWindows, TurnUsage } from "../../shared/turn-usage.js";
import {
  type PermissionDecider,
  type PermissionRequest,
  autoApproveDecider,
} from "./acp-permission.js";
import { type AcpAgent, type AcpServerSpec, acpServerSpec } from "./acp-servers.js";

const PROTOCOL_VERSION = 1;
// A real handshake is ~2-3s; this generous cap only catches a wedged child whose initialize/newSession never
// settles (so it is closed, not leaked). The operator's abort is handled at the prompt phase (acp-turn.ts).
const HANDSHAKE_TIMEOUT_MS = 60_000;

/**
 * Claude's ACP bridge forwards these options to the official Agent SDK query. An empty settingSources list is
 * the ACP equivalent of the working Ink CLI's `--setting-sources ""`: user/project/local hooks and settings do
 * not enter the query, while authentication remains owned by Claude's normal user credential store. Codex has
 * no corresponding metadata contract, so absence remains absence.
 */
export function acpSessionMetadata(agent: AcpAgent): {
  readonly _meta?: Record<string, unknown>;
} {
  return agent === "claude" ? { _meta: { claudeCode: { options: { settingSources: [] } } } } : {};
}

/** The outcome of one ACP prompt turn. `usage` is the LATEST context-window usage the adapter reported
 *  via a `usage_update` notification during the turn (absent if none was emitted — never a fabricated zero). */
export interface TurnResult {
  readonly reply: string;
  readonly stopReason: string;
  readonly usage?: TurnUsage;
}

/** A raw session-update consumer. `sessionId` is the notification's own, forwarded so a consumer that
 *  outlives one turn can tell whether a late update is still its session's (acp-lane-connection.ts's
 *  deliverLaneUpdate). OPTIONAL second parameter, so every existing one-argument tap still satisfies it. */
export type AcpSessionUpdateTap = (update: unknown, sessionId?: string) => void;

export interface AcpClientHandlers {
  readonly decide: PermissionDecider;
  readonly onSessionUpdate?: AcpSessionUpdateTap;
  readonly onUpdate: (chunk: string) => void;
  readonly onUsage: (usage: TurnUsage) => void;
  /** BLOCK 4 (F6): the bridge's `_claude/*` EXTENSION notifications — session state the ACP sessionUpdate
   *  union has no kind for. Today that is `_claude/backgroundTasks`: the live set of subagents/background
   *  shells the CLI still owns, which the claude adapter used to DROP entirely (PATCH(zer0 f6-tasksurface)
   *  now forwards it). Kept separate from onSessionUpdate on purpose — an ext notification carries no
   *  `sessionUpdate` discriminant, and feeding it to the compaction/usage taps that parse that field
   *  would be a shape lie. Absent handler = the extension is simply unused, never an error. */
  readonly onExtNotification?: (method: string, params: Record<string, unknown>) => void;
}

/** A live ACP session: run prompts (streaming chunks via onChunk), set its native mode, then close it.
 *  W4-1 FAILURE CONTRACT: setMode REJECTS on a bridge rejection or a response-absence timeout — never
 *  silently resolves for a mode the bridge did not actually accept; the caller (native-mode's state
 *  layer) reverts the selection + renders the error. */
export interface TurnSession {
  prompt(text: string, onChunk?: (chunk: string) => void): Promise<TurnResult>;
  setMode(modeId: string): Promise<void>;
  requireMode(modeId: string): Promise<void>;
  close(): void;
}

/** The narrow connection this session drives — the sdk lives only inside realDeps.openConnection. */
interface TurnConnection {
  initialize(): Promise<unknown>;
  newSession(): Promise<unknown>;
  prompt(sessionId: string, text: string): Promise<string>;
  setMode(sessionId: string, modeId: string): Promise<void>;
  close(): void;
}

/** The seam: open a connection wiring agent text-chunks to `onUpdate` and context-usage notifications to
 *  `onUsage`. Overridden in tests; real impl below. */
export interface TurnSessionDeps {
  openConnection(
    agent: AcpAgent,
    cwd: string,
    onUpdate: (chunk: string) => void,
    onUsage: (usage: TurnUsage) => void,
    decide: PermissionDecider,
  ): Promise<TurnConnection>;
}

/** The in-flight turn accumulator: the connection's onUpdate/onUsage land here; undefined between turns so a
 *  late chunk/usage after a turn completes is dropped. `| undefined` (not optional) for exactOptionalPropertyTypes. */
type TurnAccumulator = {
  reply: string;
  usage: TurnUsage | undefined;
  onChunk: ((chunk: string) => void) | undefined;
};

// U2d-b: rate-limit windows are SESSION knowledge, not turn knowledge — rate_limit_event forwardings
// arrive one window at a time and may not fire every turn, while the consumer's status merge is
// wholesale-replace (cockpit-model.ts:348). The returned fold accumulates every windows-carrying usage
// into a session map and stamps the accumulated map onto each usage it passes through, so a later
// windows-less update never drops the meters the session already learned (within or across turns).
function sessionWindowFold(): (usage: TurnUsage) => TurnUsage {
  let windows: ClaudeRateWindows | undefined;
  return (usage) => {
    if (usage.rateLimits !== undefined) {
      // FIELD-merge per window (codex u2dc B3): a status-only event window on the SAME window keeps the
      // learned % — whole-object replacement blanked the meter on every "allowed" event.
      windows = mergeRateWindows(windows, usage.rateLimits);
    }
    return windows === undefined ? usage : { ...usage, rateLimits: windows };
  };
}

/**
 * Opens a persistent ACP turn session for the agent (handshake done). Returns a session whose `prompt` streams
 * the reply chunks to the optional `onChunk` and resolves with the full reply + stopReason.
 *
 * @param agent - claude or codex
 * @param cwd - the working dir for the session (the lane worktree — NOT process.cwd, which is the wrong tree)
 * @param deps - the connection seam (defaults to the real spawn + sdk connection)
 * @param handshakeTimeoutMs - the session's round-trip patience: bounds the handshake (a child whose
 *   initialize/newSession never settles is reaped) AND setMode (W4-1's "bridge ignoring detected by
 *   response absence" — reuses this SAME knob rather than a 6th positional param, gate-clamps' 5-param
 *   ceiling; both are "how long to wait for this session's next round trip", a defensible one-knob share)
 * @param decide - the permission decider for this session's asks (defaults to auto-approve; Phase 3 injects the operator)
 */
export async function openTurnSession(
  agent: AcpAgent,
  cwd: string,
  deps: TurnSessionDeps = realDeps,
  handshakeTimeoutMs: number = HANDSHAKE_TIMEOUT_MS,
  decide: PermissionDecider = autoApproveDecider,
): Promise<TurnSession> {
  const box: CurrentTurnBox = { value: undefined };
  const foldWindows = sessionWindowFold();
  const conn = await deps.openConnection(
    agent,
    cwd,
    (chunk) => appendChunk(box, chunk),
    (usage) => foldTurnUsage(box, foldWindows, usage),
    decide,
  );
  const opened = await handshake(conn, handshakeTimeoutMs);
  return buildTurnSession(conn, opened.sessionId, opened.availableModeIds, handshakeTimeoutMs, box);
}

// The in-flight accumulator is written by the connection's onUpdate/onUsage callbacks (below) AND by
// the returned session's own prompt() — a plain `let` cannot cross that function boundary, so both
// sides share this one-field box instead (the same indirection EmitSlot uses in acp-lane-connection.ts).
interface CurrentTurnBox {
  value: TurnAccumulator | undefined;
}

function appendChunk(box: CurrentTurnBox, chunk: string): void {
  if (box.value !== undefined) {
    box.value.reply += chunk;
    box.value.onChunk?.(chunk);
  }
}

function foldTurnUsage(
  box: CurrentTurnBox,
  foldWindows: (usage: TurnUsage) => TurnUsage,
  usage: TurnUsage,
): void {
  // Fold FIRST (even between turns — window knowledge is never dropped), then accumulate per turn.
  const merged = foldWindows(usage);
  if (box.value !== undefined) {
    box.value.usage = accumulateUsage(box.value.usage, merged);
  }
}

/** The session object handed back to the caller: prompt (streams via onChunk, resolves with the full
 *  reply + stopReason), W4-1's setMode (FAILURE CONTRACT — rejects on a bridge-side rejection OR a
 *  response-absence timeout, never a silent no-op), and close. */
function buildTurnSession(
  conn: TurnConnection,
  sessionId: string,
  availableModeIds: readonly string[] | undefined,
  handshakeTimeoutMs: number,
  box: CurrentTurnBox,
): TurnSession {
  return {
    async prompt(text, onChunk) {
      const turn: TurnAccumulator = { onChunk, reply: "", usage: undefined };
      box.value = turn;
      try {
        const stopReason = await conn.prompt(sessionId, text);
        // read the LOCAL turn — box.value is reset in finally; usage OMITTED when none was reported
        return {
          reply: turn.reply,
          stopReason,
          ...(turn.usage !== undefined ? { usage: turn.usage } : {}),
        };
      } finally {
        box.value = undefined;
      }
    },
    setMode(modeId) {
      return withTimeout(conn.setMode(sessionId, modeId), handshakeTimeoutMs, "ACP setMode");
    },
    requireMode(modeId) {
      if (availableModeIds === undefined || !availableModeIds.includes(modeId)) {
        return Promise.reject(
          new Error(`ACP session did not advertise required safe mode ${modeId}`),
        );
      }
      return withTimeout(conn.setMode(sessionId, modeId), handshakeTimeoutMs, "ACP setMode");
    },
    close() {
      conn.close();
    },
  };
}

// Initialize + open the session. If EITHER step rejects, OR the handshake HANGS past timeoutMs (a wedged child
// whose initialize/newSession never settles), close the child — so a spawned connection never leaks (codex P0).
async function handshake(
  conn: TurnConnection,
  timeoutMs: number,
): Promise<{ readonly sessionId: string; readonly availableModeIds?: readonly string[] }> {
  const work = (async () => {
    await conn.initialize();
    const response = await conn.newSession();
    const availableModeIds = availableModeIdsOf(response);
    return {
      sessionId: sessionIdOf(response),
      ...(availableModeIds === undefined ? {} : { availableModeIds }),
    };
  })();
  work.catch(() => undefined); // on a timeout we close conn → `work` rejects late; keep it handled (no unhandled rejection)
  try {
    return await withTimeout(work, timeoutMs, "ACP handshake");
  } catch (error) {
    conn.close();
    throw error;
  }
}

function availableModeIdsOf(response: unknown): readonly string[] | undefined {
  if (typeof response !== "object" || response === null || !("modes" in response)) return undefined;
  const modes = (response as { modes: unknown }).modes;
  if (typeof modes !== "object" || modes === null || !("availableModes" in modes)) return undefined;
  const values = (modes as { availableModes: unknown }).availableModes;
  if (!Array.isArray(values)) return undefined;
  const ids = values
    .map((value) =>
      typeof value === "object" && value !== null && "id" in value
        ? (value as { id: unknown }).id
        : undefined,
    )
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  return ids.length === values.length ? ids : undefined;
}

// Rejects after ms if `work` has not settled (the timer is cleared once work settles) — the hung-
// handshake guard, reused for setMode's "bridge ignoring detected by response absence" bound (W4-1).
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${label} exceeded ${ms}ms`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function sessionIdOf(response: unknown): string {
  if (typeof response === "object" && response !== null && "sessionId" in response) {
    const id = (response as { sessionId: unknown }).sessionId;
    if (typeof id === "string" && id.length > 0) {
      return id;
    }
  }
  throw new Error("ACP newSession returned no sessionId");
}

const realDeps: TurnSessionDeps = {
  openConnection: async (agent, cwd, onUpdate, onUsage, decide) => {
    const child = spawnServer(agent, undefined, cwd);
    const conn = connect(child, onUpdate, onUsage, decide);
    return {
      initialize: () =>
        conn.initialize({ clientCapabilities: {}, protocolVersion: PROTOCOL_VERSION }),
      newSession: () => conn.newSession({ cwd, mcpServers: [], ...acpSessionMetadata(agent) }),
      prompt: (sessionId, text) =>
        conn
          .prompt({ prompt: [{ text, type: "text" }], sessionId })
          .then((r) => String(r.stopReason)),
      // W4-1: the real wire call, acp.d.ts:1112 — "can be called at any time during a session, whether
      // the Agent is idle or actively generating a turn." The response ({_meta?}) carries no ack/active
      // signal (SetSessionModeResponse's only field), so a resolved promise means ONLY "the bridge
      // accepted the call" — the caller's state layer treats it as PENDING, never immediately active.
      setMode: (sessionId, modeId) =>
        conn.setSessionMode({ modeId, sessionId }).then(() => undefined),
      close: () => {
        try {
          child.kill();
        } catch {
          /* already exited */
        }
      },
    };
  },
};

// Spawn the agent's ACP server against the provider-owned user credential store. Do not manufacture a
// per-project CLAUDE_CONFIG_DIR or copy OAuth files: Claude owns login and refresh-token rotation. Claude's
// hooks/settings are suppressed at the session request via acpSessionMetadata, independently of auth.
// EXPORTED as the ONE bridge spawn path: the live e2e and the T5 lane wiring must ride THIS spawn. Session
// callers must also use acpSessionMetadata; a hand-rolled sibling that omits it reloads filesystem hooks.
// Callers that
// also need the I-2 binding pass the pre-resolved spec (resolveAcpSpec — ONE package.json read for
// binding + entry, retro TOCTOU decision) so the spawned process matches the binding they recorded.
export function spawnServer(
  agent: AcpAgent,
  resolved?: AcpServerSpec,
  _cwd: string = process.cwd(),
): ChildProcess {
  const spec = resolved ?? acpServerSpec(agent);
  assertNotHermetic("acp-turn-session.spawnServer");
  return spawn(process.execPath, [spec.entry], {
    env: spec.env,
    stdio: ["pipe", "pipe", "ignore"],
  });
}

function connect(
  child: ChildProcess,
  onUpdate: (chunk: string) => void,
  onUsage: (usage: TurnUsage) => void,
  decide: PermissionDecider,
): ClientSideConnection {
  if (child.stdin === null || child.stdout === null) {
    throw new Error("ACP child process has no stdio pipes");
  }
  const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
  return new ClientSideConnection(() => createAcpClient({ decide, onUpdate, onUsage }), stream);
}

// Route permission asks to the injected decider (default = auto-approve), agent text-chunks to onUpdate,
// and context-usage notifications to onUsage (the two sessionUpdate kinds this session consumes).
export function createAcpClient(input: AcpClientHandlers): Client {
  return {
    // W4-B fix round 1 CONCERN 2: the decider's PermissionDecision maps 1:1 onto the SDK's own
    // RequestPermissionOutcome discriminated union (schema.json) — "selected" carries the offered
    // optionId; "cancelled" is the protocol's own not-approved shape, never a fabricated optionId.
    requestPermission: async (params) => {
      const decision = await input.decide(params as PermissionRequest);
      return {
        outcome:
          decision.kind === "cancelled"
            ? { outcome: "cancelled" as const }
            : { outcome: "selected" as const, optionId: decision.optionId },
      };
    },
    sessionUpdate: async (params) => {
      const { update, sessionId } = params as { update?: unknown; sessionId?: string };
      // The id was already here and was being dropped on the floor; forwarding it is what lets a
      // session-scoped consumer refuse an update belonging to a session it has since replaced.
      input.onSessionUpdate?.(update, sessionId);
      if (isTextChunk(update)) {
        input.onUpdate(update.content.text);
        return;
      }
      const usage = usageFromUpdate(update);
      if (usage !== undefined) {
        input.onUsage(usage);
      }
    },
    // BLOCK 4 (F6): the bridge forwards its live background-task set from INSIDE its consumer loop, where
    // a rejection reaches the loop's catch and tears the session's query stream down (failAllTurns +
    // closeQueryStream). So this is fail-soft on OUR side too: a consumer bug must never travel back
    // across the bridge and brick the session. Unfiltered by method — the handler decides what it cares
    // about; filtering here would silently hide a future extension.
    extNotification: async (method, params) => {
      try {
        input.onExtNotification?.(method, params);
      } catch {
        // a broken consumer degrades observability, never the turn
      }
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Narrows a session update to the streamed-text kind (`agent_message_chunk` with string content.text).
function isTextChunk(update: unknown): update is { content: { text: string } } {
  if (!isRecord(update) || update.sessionUpdate !== "agent_message_chunk") {
    return false;
  }
  const content = update.content;
  return isRecord(content) && typeof content.text === "string";
}

/**
 * Extracts a {@link TurnUsage} from the ACP `usage_update` session update the installed
 * @agentclientprotocol/claude-agent-acp adapter emits (acp-agent.js:1081-1096 result-time with `cost`,
 * :1282-1289 mid-stream without, :1514-1522 rate_limit_event forwarding with `_meta`) —
 * `{ sessionUpdate: "usage_update", used, size, cost?, _meta?: {"_claude/rateLimit": SDKRateLimitInfo} }`.
 * Numeric `used`/`size` are REQUIRED; a malformed or non-usage update yields undefined so no bogus ctx% is
 * ever reported. `cost` is carried when present-and-valid; the rate-limit window when `_meta` carries a
 * displayable one (U2d-b) — junk `_meta` never costs the ctx% capture.
 */
export function usageFromUpdate(update: unknown): TurnUsage | undefined {
  if (!isRecord(update) || update.sessionUpdate !== "usage_update") {
    return undefined;
  }
  const { used, size, cost } = update;
  if (typeof used !== "number" || typeof size !== "number") {
    return undefined;
  }
  const windows = windowsFromMeta(update._meta);
  return {
    used,
    size,
    ...(isValidCost(cost) ? { cost } : {}),
    ...(windows !== undefined ? { rateLimits: windows } : {}),
  };
}

// Merge both _meta window sources: the u2d-c /usage plan windows (utilization at any level) as the base,
// with the rate_limit_event window FIELD-merged onto its key — same-window fields UNION, so the event's
// verdict and the plan's % both survive (codex u2dc verify: replacement in either direction blanks truth).
function windowsFromMeta(meta: unknown): ClaudeRateWindows | undefined {
  const plan = usageWindowsFromMeta(meta);
  const event = rateWindowsFromMeta(meta);
  if (plan === undefined || event === undefined) {
    return plan ?? event;
  }
  return mergeRateWindows(plan, event);
}

// A usage_update cost is valid only when both fields are the adapter's expected primitives.
function isValidCost(cost: unknown): cost is { amount: number; currency: string } {
  return isRecord(cost) && typeof cost.amount === "number" && typeof cost.currency === "string";
}

// The displayable subscription windows (SDKRateLimitInfo.rateLimitType values minus 'overage', which is a
// credit-spend state, not a quota window).
const WINDOW_TYPES = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"] as const;
type WindowType = (typeof WINDOW_TYPES)[number];

// Narrows `_meta["_claude/rateLimit"]` (the adapter's rate_limit_event forwarding, dist/acp-agent.js:1791-1794)
// to ONE displayable window keyed by its rateLimitType. Absent/junk meta, an unknown window type, or an
// invalid status yield undefined — the caller's used/size capture is unaffected either way.
function rateWindowsFromMeta(meta: unknown): ClaudeRateWindows | undefined {
  if (!isRecord(meta)) {
    return undefined;
  }
  const info = meta["_claude/rateLimit"];
  if (!isRecord(info)) {
    return undefined;
  }
  const type = WINDOW_TYPES.find((t) => t === info.rateLimitType);
  const window = rateWindowOf(info);
  return type === undefined || window === undefined ? undefined : singleWindow(type, window);
}

// The documented utilization contract is "Percentage of the window used, 0-100" (nested sdk.d.ts) — a
// 999/-5/NaN/Infinity is garbage, and clamping garbage would launder it into a real-looking meter
// (codex u2dc B2). Outside the contract → the FIELD is dropped, the window's other fields still read.
function validUtilization(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

// The window fields we display: status is REQUIRED (the event's meaning); utilization/resetsAt carried
// only when the event reports them within contract — a missing percentage stays missing (never fabricated).
function rateWindowOf(info: Record<string, unknown>): ClaudeRateWindow | undefined {
  const { status, utilization, resetsAt } = info;
  if (status !== "allowed" && status !== "allowed_warning" && status !== "rejected") {
    return undefined;
  }
  return {
    status,
    ...(validUtilization(utilization) ? { utilization } : {}),
    ...(typeof resetsAt === "number" ? { resetsAt } : {}),
  };
}

// Narrows `_meta["_claude/usageWindows"]` (the u2d-c adapter patch forwarding the structured data behind
// /usage — utilization at ANY usage level) to the displayable windows. Per window: `utilization` must be a
// number (null → skipped field), `resets_at` is ISO 8601 → epoch SECONDS (unparseable → skipped field); a
// window yielding NEITHER field is dropped. Null windows and the experimental extra keys are ignored.
function usageWindowsFromMeta(meta: unknown): ClaudeRateWindows | undefined {
  if (!isRecord(meta)) {
    return undefined;
  }
  const windows = meta["_claude/usageWindows"];
  if (!isRecord(windows)) {
    return undefined;
  }
  let found: ClaudeRateWindows | undefined;
  for (const type of WINDOW_TYPES) {
    const window = planWindowOf(windows[type]);
    if (window !== undefined) {
      found = { ...found, ...singleWindow(type, window) };
    }
  }
  return found;
}

// The contract says resets_at is ISO 8601 — Date.parse's locale leniency ("July 3, 2026") is not a
// license to accept other shapes (codex u2dc nit). Precheck the ISO date-time prefix, then parse.
function isoToEpochSeconds(raw: unknown): number | undefined {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    return undefined;
  }
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

// One /usage plan window → the displayable fields it actually carries (no status on this source).
function planWindowOf(raw: unknown): ClaudeRateWindow | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const resetsAt = isoToEpochSeconds(raw.resets_at);
  const window: ClaudeRateWindow = {
    ...(validUtilization(raw.utilization) ? { utilization: raw.utilization } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
  return window.utilization === undefined && window.resetsAt === undefined ? undefined : window;
}

// LATEST used/size wins; the turn's COST is carried within the turn — the u2d-c patch emits a second,
// cost-less update right after the result's cost-bearing one, and latest-wins must not drop it (codex nit).
function accumulateUsage(prior: TurnUsage | undefined, merged: TurnUsage): TurnUsage {
  const cost = merged.cost ?? prior?.cost;
  return cost !== undefined ? { ...merged, cost } : merged;
}

// Exhaustive literal-key construction (no computed-key cast needed under exactOptionalPropertyTypes).
function singleWindow(type: WindowType, window: ClaudeRateWindow): ClaudeRateWindows {
  if (type === "five_hour") {
    return { five_hour: window };
  }
  if (type === "seven_day") {
    return { seven_day: window };
  }
  if (type === "seven_day_opus") {
    return { seven_day_opus: window };
  }
  return { seven_day_sonnet: window };
}
