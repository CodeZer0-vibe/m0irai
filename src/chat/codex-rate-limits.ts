/**
 * @file src/chat/codex-rate-limits.ts
 * @exports CodexUsageDeps, RolloutReadOptions, CodexUsageRead, readNewestRolloutRateLimits,
 *   emitCodexUsageFromRollout
 * @depends node:fs/promises, node:os, node:path, ../shared/abortable-delay, ../shared/logger, ./codex-usage-decode, ./events,
 *   ./statusline-payload
 * @purpose Feature 2 PART B - codex subscription-usage capture. `rate_limits` lives ONLY in
 *   ~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl (a token_count event_msg), not the buffered
 *   `codex exec` stdout. A minimal POST-TURN read of the NEWEST rollout (by FILENAME timestamp)
 *   extracts the latest COMPLETE window and emits ONE `agent.status` for codex. No fabrication, no
 *   STALE window: a mid-flush trailing token_count line retries-then-emits-nothing rather than
 *   returning a known-older window. This file owns the READ (which file, which line, how fresh);
 *   the vendor payload contract and its mapping to AgentUsage live in ./codex-usage-decode.
 */
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { abortableDelay } from "../shared/abortable-delay.js";
import { createLogger } from "../shared/logger.js";
import {
  type CodexRateLimits,
  type CodexTokenInfo,
  decodeCodexUsage,
} from "./codex-usage-decode.js";
import type { ChatEventBus } from "./events.js";
import type { AgentStatusUsage } from "./statusline-payload.js";

const logger = createLogger();
const PHASE = "codex-rate-limits";
const ROLLOUT_PREFIX = "rollout-";
const ROLLOUT_SUFFIX = ".jsonl";
// Bound the recursive walk: ~/.codex/sessions nests <year>/<month>/<day>/rollout-*.jsonl (depth 3) +
// a flat dir in tests (depth 0). 4 levels covers both without descending an unbounded tree.
const MAX_WALK_DEPTH = 4;
// BLOCK 3 (flush race): when the newest rollout's trailing token_count line is mid-flush (truncated, not
// yet newline-terminated / does not parse), re-read the file a few times with a short delay until it
// completes, rather than returning a KNOWN-OLDER window (a stale HEALTHY bar when codex just hit
// exhausted). Bounded so the post-turn read can never hang: after these retries, emit NOTHING.
const DEFAULT_FLUSH_RETRIES = 5;
const DEFAULT_FLUSH_RETRY_DELAY_MS = 25;
// M3: the wait for a turn's own token_count to be WRITTEN, matched to readClaudeStatusUsageWhenFresh's
// 5 000 / 250 so the two post-turn reads cannot drift apart. Measured, not assumed — see
// RolloutReadOptions.timeoutMs for the 4 172-turn reading that selected them.
const DEFAULT_POLL_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

// The backward-scan outcome for one rollout read: a complete latest window, NOTHING parseable, or a
// PENDING trailing token_count line that is still flushing (truncated) - which must NEVER fall through
// to an older window (BLOCK 3). `pending` is the signal the caller retries on.
type ScanResult =
  | { readonly kind: "ready"; readonly value: CodexTokenCount }
  | { readonly kind: "pending" }
  | { readonly kind: "none" };

/** Bounded-retry tuning for the flush-race read (BLOCK 3); a unit test passes tiny values for speed. */
export interface RolloutReadOptions {
  readonly retryDelayMs?: number;
  readonly maxRetries?: number;
  readonly sessionId?: string;
  readonly freshAfterMs?: number;
  /** The POLL bound (M3), in force only when `freshAfterMs` is set — i.e. only when this read is
   *  waiting for a SPECIFIC turn's number rather than accepting the newest one on disk. Defaults are
   *  5 000 / 250, matching readClaudeStatusUsageWhenFresh, and they are a MEASURED default: across
   *  4 172 turns in this machine's own ~/.codex/sessions history, 4 154 had their token_count already
   *  written before task_complete and NOT ONE had a token_count written after it, so the observed
   *  turn-end-to-reading delay is 0 ms — far inside the 2 500 ms threshold that would have forced a
   *  longer wait. The remaining 18 turns wrote no token_count at all, which no timeout can fix. */
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly signal?: AbortSignal;
}

/** One parsed token_count line: rate_limits + the SAME line's info, so context-left is single-parse. */
interface CodexTokenCount {
  readonly rateLimits: CodexRateLimits;
  readonly info?: CodexTokenInfo;
  readonly observedAtMs?: number;
}

type TokenRead =
  | { readonly outcome: "arrived"; readonly tokenCount: CodexTokenCount }
  | { readonly outcome: "missing" | "stale" };

/** The post-turn read result. `drift` rides the ARRIVED case: the payload was read and decoded, but it
 *  carried a window this build cannot name, and that divergence must reach the operator rather than
 *  vanish into a default (VENDOR DRIFT IS LOUD). Absent on a clean decode. */
export type CodexUsageRead =
  | { readonly outcome: "arrived"; readonly usage: AgentStatusUsage; readonly drift?: string }
  | { readonly outcome: "missing" | "stale" };

/** Injectable seams: a unit test feeds rate_limits directly OR points sessionsDir at a temp rollout tree. */
export interface CodexUsageDeps {
  readonly sessionsDir?: string;
  readonly readNewestRateLimits?: () => Promise<CodexRateLimits | undefined>;
  readonly sessionId?: string;
  readonly freshAfterMs?: number;
  /** M3: the poll bound, forwarded verbatim to RolloutReadOptions. Declared here as well because this
   *  is the interface the reporter actually hands in — CodexUsageDeps is not RolloutReadOptions, and a
   *  field the deps do not declare is silently dropped on the way through readUsageWindow. */
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly signal?: AbortSignal;
  /** W4-R2f RA-3 (the BOOT prefetch, eager-session-boot.ts): decode the ACCOUNT-level quota windows
   *  ONLY, and make no readiness claim. The rollout available at boot belongs to a PREVIOUS
   *  conversation, so its `info` token counts are that conversation's context — reporting them as this
   *  session's ctx% would be a fabricated number, which is the one thing this file exists not to do.
   *  The 5h/weekly windows are account-scoped facts that carry their own reset instants, so they stay
   *  true across sessions and self-hide once passed (usage-bar.ts's isWindowFresh). */
  readonly quotaOnly?: boolean;
}

/**
 * Reads the newest codex rollout under `sessionsDir` (default ~/.codex/sessions) and returns the LAST
 * COMPLETE `token_count` event's rate_limits - the most recent window snapshot. Returns undefined when
 * there is no rollout, no token_count line, or the file can't be read (never throws: a missing window
 * must not fail the turn). The walk is depth-bounded and only inspects rollout-*.jsonl files.
 *
 * BLOCK 3 flush race: if the newest rollout's trailing token_count line is still flushing (truncated /
 * does not parse), this re-reads it up to `maxRetries` times (short `retryDelayMs` between) until it
 * completes - rather than returning a KNOWN-OLDER window. If still mid-flush after the bounded retries,
 * it returns undefined (emit NOTHING) so the bar never shows a stale HEALTHY window over a spent one.
 */
export async function readNewestRolloutRateLimits(
  sessionsDir: string,
  options: RolloutReadOptions = {},
): Promise<CodexRateLimits | undefined> {
  return (await readNewestRolloutTokenCount(sessionsDir, options))?.rateLimits;
}

/**
 * The single-parse core: returns the newest rollout's LAST COMPLETE token_count as BOTH its rate_limits
 * AND its `info` from the SAME parsed line - so context-left (info) and the usage window (rate_limits)
 * can never diverge across lines, and the existing flush-race/staleness retry (BLOCK 3 / BLOCK A) covers
 * both. {@link readNewestRolloutRateLimits} projects this to rate_limits for its unchanged contract.
 * Returns undefined under exactly the same conditions (no rollout, no token_count, still flushing).
 */
async function readNewestRolloutTokenCount(
  sessionsDir: string,
  options: RolloutReadOptions = {},
): Promise<CodexTokenCount | undefined> {
  const read = await readNewestRolloutTokenCountWithOutcome(sessionsDir, options);
  return read.outcome === "arrived" ? read.tokenCount : undefined;
}

/**
 * M3 — ONE deadline-bounded loop over TWO different waits, because they are two different events.
 *
 * A truncated trailing line completes in milliseconds, so `pending` keeps its tight 25 ms cadence and
 * its own attempt cap (the flush race, BLOCK 3). A reading that is absent or STALE is a different
 * animal: the turn's own token_count has not been written yet, which takes as long as it takes, so it
 * polls at 250 ms until the deadline. Before this, stale returned at attempt 0 with NO retry at all —
 * so a codex turn whose number had not landed yet emitted NOTHING, while claude's equivalent path
 * waited 5 s. That asymmetry is half of why codex's meter came and went between boots.
 *
 * WAITING ONLY HAPPENS WHEN THERE IS SOMETHING TO WAIT FOR. Without `freshAfterMs` every reading on
 * disk is acceptable by definition, so absent/stale return immediately and the boot prefetch stays as
 * fast as it was. The newest file is re-resolved on every attempt: a rollout that rotates mid-turn was
 * otherwise never seen again, because the path was chosen once before the loop.
 *
 * BOUNDED MEANS BOUNDED. After the deadline this returns its last honest outcome and the caller emits
 * nothing. A late number is not better than no number.
 */
async function readNewestRolloutTokenCountWithOutcome(
  sessionsDir: string,
  options: RolloutReadOptions = {},
): Promise<TokenRead> {
  const budget = pollBudget(options);
  let pendingAttempts = 0;
  let last: TokenRead = { outcome: "missing" };
  while (options.signal?.aborted !== true) {
    const scan = await scanNewestRollout(sessionsDir, options.sessionId);
    if (scan.kind === "ready" && isFreshTokenCount(scan.value, options.freshAfterMs)) {
      return { outcome: "arrived", tokenCount: scan.value };
    }
    last = scan.kind === "ready" ? { outcome: "stale" } : { outcome: "missing" };
    const waitMs = nextWaitMs(scan, budget, pendingAttempts);
    if (waitMs === undefined) return last;
    pendingAttempts += scan.kind === "pending" ? 1 : 0;
    await abortableDelay(waitMs, options.signal);
  }
  return last;
}

/**
 * How long to wait before the next attempt, or `undefined` to stop and report what was last seen.
 *
 * The TWO waits, and they are two different events. A truncated trailing line completes in
 * milliseconds, so a `pending` scan keeps its tight flush cadence and its own attempt cap. A reading
 * that is absent or STALE is a different animal — the turn's own token_count has not been written yet
 * — so it polls at the slower interval until the deadline.
 *
 * And waiting only happens when there is something to wait FOR: without a freshness bound every
 * reading on disk is acceptable by definition, so absent and stale stop immediately and the boot
 * prefetch stays as fast as it was.
 */
function nextWaitMs(
  scan: ScanResult,
  budget: PollBudget,
  pendingAttempts: number,
): number | undefined {
  const flushing = scan.kind === "pending" && pendingAttempts < budget.flushRetries;
  if (!flushing && !budget.waiting) return undefined;
  const waitMs = flushing ? budget.flushMs : budget.pollMs;
  return Date.now() + waitMs > budget.deadline ? undefined : waitMs;
}

interface PollBudget {
  readonly waiting: boolean;
  readonly deadline: number;
  readonly pollMs: number;
  readonly flushRetries: number;
  readonly flushMs: number;
}

function pollBudget(options: RolloutReadOptions): PollBudget {
  return {
    waiting: options.freshAfterMs !== undefined,
    deadline: Date.now() + (options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS),
    pollMs: options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    flushRetries: options.maxRetries ?? DEFAULT_FLUSH_RETRIES,
    flushMs: options.retryDelayMs ?? DEFAULT_FLUSH_RETRY_DELAY_MS,
  };
}

// Re-resolved on EVERY attempt (M3 item 2): the newest file was previously chosen once, before the
// loop, so a rollout that rotated mid-turn was never discovered and the read waited out its whole
// budget staring at a file codex had stopped writing to.
async function scanNewestRollout(
  sessionsDir: string,
  sessionId: string | undefined,
): Promise<ScanResult> {
  const newest = await newestRolloutFile(sessionsDir, MAX_WALK_DEPTH, sessionId);
  return newest === undefined ? { kind: "none" } : scanRollout(newest);
}

function isFreshTokenCount(tokenCount: CodexTokenCount, freshAfterMs: number | undefined): boolean {
  if (freshAfterMs === undefined) return true;
  return tokenCount.observedAtMs !== undefined && tokenCount.observedAtMs >= freshAfterMs;
}

// Reads + classifies one rollout file. NEVER throws (a missing/closed file -> none): a missing window must
// not fail the turn. Returns `pending` when the trailing token_count line is still flushing (BLOCK 3).
async function scanRollout(path: string): Promise<ScanResult> {
  try {
    const text = await readFile(path, "utf8");
    return classifyLatestRateLimits(text);
  } catch (error) {
    logger.warn({ phase: PHASE }, "rollout read failed; skipping usage", {
      path,
      reason: error instanceof Error ? error.message : String(error),
    });
    return { kind: "none" };
  }
}

/**
 * Feature 2 PART B entry: capture codex's current usage window POST-TURN and emit ONE `agent.status`
 * for codex. Sources rate_limits via the injected reader (tests) or the newest rollout under
 * sessionsDir (production). NO fabrication - when no window is found, nothing is emitted (the boot
 * probe's auth glyph stays). auth is derived from the window: exhausted -> "limited", else "ready".
 */
export async function emitCodexUsageFromRollout(
  bus: ChatEventBus,
  deps: CodexUsageDeps = {},
): Promise<CodexUsageRead> {
  const sessionsDir = deps.sessionsDir ?? codexSessionsDir();
  const read = await readUsageWindow(sessionsDir, deps);
  if (read.outcome !== "arrived") {
    return { outcome: read.outcome };
  }
  const tokenCount = read.tokenCount;
  // info flows from the SAME parsed line as rateLimits -> context-left and the usage window can't diverge.
  // observedAtMs comes from that same line's timestamp, so the 2025 RELATIVE reset encoding can be made
  // absolute against when it was actually written, never against "now" at read time.
  // quotaOnly DROPS info deliberately — see CodexUsageDeps.quotaOnly for why a prior conversation's
  // token counts must never become this session's ctx%.
  const quotaOnly = deps.quotaOnly === true;
  const { usage, drift } = decodeCodexUsage(
    tokenCount.rateLimits,
    quotaOnly ? undefined : tokenCount.info,
    tokenCount.observedAtMs,
  );
  if (drift !== undefined) {
    logger.warn({ phase: PHASE }, "codex usage window not recognised", { drift });
  }
  bus.emit({
    kind: "agent.status",
    agent: "codex",
    // A boot prefetch has opened nothing and proved nothing about reachability, so it claims nothing:
    // auth is OMITTED (agent-status-merge keeps whatever the real lane open reports) unless the window
    // is genuinely spent, which is account-level truth worth saying whoever is asking.
    ...(quotaOnly ? spentAuth(usage.exhausted) : { auth: usage.exhausted ? "limited" : "ready" }),
    usage,
  });
  return drift === undefined ? { outcome: "arrived", usage } : { outcome: "arrived", usage, drift };
}

// Only a SPENT window earns a claim from the boot prefetch — "limited" is about the account, which the
// rollout genuinely knows. "ready" would be a claim about the lane, which it does not.
function spentAuth(exhausted: boolean): { readonly auth?: "limited" } {
  return exhausted ? { auth: "limited" } : {};
}

// Resolves the usage window via the injected rate_limits seam (tests; rate_limits only -> no `info`, so
// contextRemainingPct is omitted) or the production token_count reader (carries `info` for context-left).
async function readUsageWindow(sessionsDir: string, deps: CodexUsageDeps): Promise<TokenRead> {
  if (deps.readNewestRateLimits !== undefined) {
    const rateLimits = await deps.readNewestRateLimits();
    return rateLimits === undefined
      ? { outcome: "missing" }
      : { outcome: "arrived", tokenCount: { rateLimits } };
  }
  const read = await readNewestRolloutTokenCountWithOutcome(sessionsDir, {
    ...(deps.sessionId === undefined ? {} : { sessionId: deps.sessionId }),
    ...(deps.freshAfterMs === undefined ? {} : { freshAfterMs: deps.freshAfterMs }),
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
    ...(deps.intervalMs === undefined ? {} : { intervalMs: deps.intervalMs }),
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });
  if (read.outcome !== "missing") return read;
  return { outcome: (await isStaleSessionRollout(sessionsDir, deps)) ? "stale" : "missing" };
}

async function isStaleSessionRollout(sessionsDir: string, deps: CodexUsageDeps): Promise<boolean> {
  if (deps.sessionId === undefined || deps.readNewestRateLimits !== undefined) return false;
  const matching = await newestRolloutFile(sessionsDir, MAX_WALK_DEPTH, deps.sessionId);
  if (matching !== undefined) return false;
  return (await newestRolloutFile(sessionsDir, MAX_WALK_DEPTH)) !== undefined;
}

// The raw marker that identifies a token_count line WITHOUT parsing it - codex writes compact JSON
// (no spaces), so the emitted form is exactly `"type":"token_count"`. A partial (truncated) line that
// already carries this marker is a mid-flush token_count write; one that does not is a non-usage line.
const TOKEN_COUNT_MARKER = /"type"\s*:\s*"token_count"/;

// Classifies the LAST token_count event's rate_limits from a rollout's JSONL text, scanning bottom-up
// (the most-recent window is the one to show). BLOCK 3 + BLOCK A: an unparseable trailing line yields
// `pending` (so the caller retries instead of falling through to a KNOWN-OLDER window) ONLY when that
// line is itself a partial TOKEN_COUNT - a mid-flush usage write whose newer window must not be skipped.
// An unparseable (or complete) NON-token_count trailing line carries no usage window, so it is harmless:
// SKIP it and let the latest COMPLETE token_count behind it win - pending on it would swallow a healthy
// window (BLOCK A: a partial `response_item` flushed after the final token_count must not pend).
function classifyLatestRateLimits(text: string): ScanResult {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (line === undefined || line.length === 0) {
      continue;
    }
    const parsed = parseLine(line);
    if (parsed === undefined) {
      // Mid-flush write. Pend ONLY if it is a partial token_count (a newer usage window still flushing);
      // any other partial line is non-usage - skip it and keep scanning older for the latest complete one.
      if (TOKEN_COUNT_MARKER.test(line)) {
        return { kind: "pending" };
      }
      continue;
    }
    const tokenCount = tokenCountFromParsed(parsed);
    if (tokenCount !== undefined) {
      return { kind: "ready", value: tokenCount };
    }
  }
  return { kind: "none" };
}

// Parses one rollout JSONL line; undefined when the line is not valid JSON (a partial / truncated flush).
function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

// Returns a parsed line's rate_limits AND `info` together when it is a complete token_count event;
// undefined otherwise. ONE parse of ONE line -> context-left (info) and the usage window (rate_limits)
// share a source, so the existing flush-race/staleness retry covers both (no second backward scan).
function tokenCountFromParsed(parsed: unknown): CodexTokenCount | undefined {
  const payload = isRecord(parsed) ? parsed.payload : undefined;
  if (!isRecord(payload) || payload.type !== "token_count") {
    return undefined;
  }
  if (!isRecord(payload.rate_limits)) {
    return undefined;
  }
  const rateLimits = payload.rate_limits as CodexRateLimits;
  const observedAtMs = observedAtMsFromParsed(parsed);
  const base = observedAtMs === undefined ? { rateLimits } : { rateLimits, observedAtMs };
  // `info` is OPTIONAL: real lines carry `info:null` early and a populated block once usage is known -
  // include it only when it is a record (OMIT, not set-undefined, per exactOptionalPropertyTypes) so
  // context-left derives from this same line when present.
  return isRecord(payload.info) ? { ...base, info: payload.info as CodexTokenInfo } : base;
}

// One rollout candidate: its path + the lexically-sortable SESSION-timestamp key from its FILENAME.
type RolloutCandidate = { readonly path: string; readonly key: string };

// Finds the newest rollout-*.jsonl under `dir` by its FILENAME session timestamp (DECISION 1), recursing
// into subdirectories up to `depth` (covers the nested <y>/<m>/<d> production layout AND a flat test
// dir). The filename `rollout-<ISO>-<id>.jsonl` carries the session start time; mtime is NOT used because
// an older session's file can be re-touched (later mtime) yet hold a STALE window. Returns undefined on
// any read failure (a missing/closed sessions dir must never throw into the post-turn path).
async function newestRolloutFile(
  dir: string,
  depth: number,
  sessionId?: string,
): Promise<string | undefined> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  let best: RolloutCandidate | undefined;
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && depth > 0) {
      best = newer(best, await newestRolloutForDir(full, depth - 1, sessionId));
    } else if (entry.isFile() && isRolloutCandidate(entry.name, sessionId)) {
      best = newer(best, { path: full, key: rolloutSortKey(entry.name) });
    }
  }
  return best?.path;
}

async function newestRolloutForDir(
  dir: string,
  depth: number,
  sessionId?: string,
): Promise<RolloutCandidate | undefined> {
  const path = await newestRolloutFile(dir, depth, sessionId);
  // The recursive call already returned the directory's WINNER by filename; re-derive its sort key from
  // its own basename so cross-directory comparison stays filename-timestamp based (never mtime).
  return path === undefined ? undefined : { path, key: rolloutSortKey(basename(path)) };
}

// The lexically-sortable key for a rollout filename: the `<ISO>-<id>` body after `rollout-` and before
// `.jsonl`. The ISO timestamp is fixed-width + zero-padded, so plain string order = chronological order.
function observedAtMsFromParsed(parsed: unknown): number | undefined {
  if (!isRecord(parsed) || typeof parsed.timestamp !== "string") return undefined;
  const ms = Date.parse(parsed.timestamp);
  return Number.isNaN(ms) ? undefined : ms;
}

function rolloutSortKey(name: string): string {
  return name.slice(ROLLOUT_PREFIX.length, name.length - ROLLOUT_SUFFIX.length);
}

function newer(
  a: RolloutCandidate | undefined,
  b: RolloutCandidate | undefined,
): RolloutCandidate | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return b.key > a.key ? b : a;
}

function isRolloutName(name: string): boolean {
  return name.startsWith(ROLLOUT_PREFIX) && name.endsWith(ROLLOUT_SUFFIX);
}

function isRolloutCandidate(name: string, sessionId: string | undefined): boolean {
  if (!isRolloutName(name)) return false;
  return sessionId === undefined || rolloutSessionId(name) === sessionId;
}

function rolloutSessionId(name: string): string | undefined {
  return /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/.exec(name)?.[1];
}

function codexSessionsDir(): string {
  const configured = process.env.CODEX_HOME;
  return configured !== undefined && configured.length > 0
    ? join(configured, "sessions")
    : join(homedir(), ".codex", "sessions");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
