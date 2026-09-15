/**
 * @file src/chat/codex-rate-limits.test.ts
 * @purpose Contract for the post-turn ROLLOUT READ (Feature 2 PART B): which file, which line, how
 *   fresh, and the one agent.status it emits. The rate_limits -> AgentUsage decode is contracted
 *   separately in codex-usage-decode.test.ts.
 *
 *   W4-R2b: this suite used to carry two HAND-WRITTEN rate_limits constants — one of them
 *   (`primary: { used_percent: 37, resets_in_seconds: 18000 }`) a shape codex has never sent, with no
 *   `window_minutes` at all. Tests built on an imagined payload prove only that our imagination is
 *   self-consistent, so both are replaced by captures sliced byte-for-byte out of real rollout lines.
 *   The SPENT/IDLE pair below is discriminated by the vendor's own `used_percent`, which is what the
 *   reader tests were really asserting all along.
 * @exports (none)
 * @depends vitest, node:fs/promises, node:os, node:path, ./codex-rate-limits,
 *   ./codex-usage-captures.fixtures, ./events
 */
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emitCodexUsageFromRollout, readNewestRolloutRateLimits } from "./codex-rate-limits.js";
import { WEEKLY_ONLY_IDLE, WEEKLY_ONLY_SPENT } from "./codex-usage-captures.fixtures.js";
import { ChatEventBus } from "./events.js";

// A genuinely spent account: the weekly entitlement window at 100% used (2026-07-21 capture).
const EXHAUSTED_RATE_LIMITS = WEEKLY_ONLY_SPENT;
// The operator's real idle account: the same weekly window at 0% used (2026-07-16 capture).
const HEALTHY_RATE_LIMITS = WEEKLY_ONLY_IDLE;

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// One rollout JSONL line: a token_count event_msg carrying the given rate_limits window.
function tokenCountLine(rateLimits: unknown): string {
  return JSON.stringify({
    timestamp: "t",
    type: "event_msg",
    payload: { type: "token_count", info: null, rate_limits: rateLimits },
  });
}

// One rollout JSONL token_count line carrying a POPULATED `info` block (the real shape: total/last
// token usage + the model context window) ALONGSIDE rate_limits — both halves on the SAME line, so the
// context-left derivation must read `info` from the very line that produced rate_limits (single parse).
function tokenCountLineWithInfo(args: {
  rateLimits: unknown;
  lastTokens?: number | null | undefined;
  contextWindow?: number | null | undefined;
}): string {
  const lastUsage =
    args.lastTokens === undefined
      ? undefined
      : args.lastTokens === null
        ? null
        : { total_tokens: args.lastTokens, input_tokens: args.lastTokens, output_tokens: 0 };
  const info: Record<string, unknown> = {
    // total_token_usage is CUMULATIVE session billing (monotonic, can exceed the window → a 166% bug).
    // It is present on the real shape but MUST NOT feed the context calc — last_token_usage does.
    total_token_usage: { total_tokens: 999_999, input_tokens: 999_999, output_tokens: 0 },
  };
  if (lastUsage !== undefined) info.last_token_usage = lastUsage;
  if (args.contextWindow !== undefined) info.model_context_window = args.contextWindow;
  return JSON.stringify({
    timestamp: "t",
    type: "event_msg",
    payload: { type: "token_count", info, rate_limits: args.rateLimits },
  });
}

// One rollout JSONL line that is NOT a token_count (a `response_item`) — the kind of line codex flushes
// AFTER the final token_count. A truncated tail of THIS must NOT pend (it carries no usage window).
function responseItemLine(): string {
  return JSON.stringify({
    timestamp: "t",
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
  });
}

async function makeTmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

describe("codex-rate-limits: emitCodexUsageFromRollout (post-turn read → bus)", () => {
  it("emits agent.status codex limited from a captured SPENT weekly window", async () => {
    const bus = new ChatEventBus();
    const received: { exhausted: boolean; auth: string }[] = [];
    bus.on("agent.status", (e) =>
      received.push({ exhausted: e.usage?.exhausted === true, auth: e.auth ?? "" }),
    );

    await emitCodexUsageFromRollout(bus, {
      readNewestRateLimits: async () => EXHAUSTED_RATE_LIMITS,
    });

    expect(received).toEqual([{ exhausted: true, auth: "limited" }]);
  });

  it("reads rate_limits from a real rollout .jsonl on disk (the production reader, no injection)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-rollout-"));
    tmpDirs.push(dir);
    const rollout = join(dir, "rollout-2026-06-23T13-02-00-abc.jsonl");
    const lines = [
      JSON.stringify({ timestamp: "t", type: "session_meta", payload: {} }),
      JSON.stringify({
        timestamp: "t",
        type: "event_msg",
        payload: { type: "token_count", info: null, rate_limits: EXHAUSTED_RATE_LIMITS },
      }),
    ];
    await writeFile(rollout, `${lines.join("\n")}\n`, "utf8");

    const bus = new ChatEventBus();
    const received: { exhausted: boolean }[] = [];
    bus.on("agent.status", (e) => received.push({ exhausted: e.usage?.exhausted === true }));

    await emitCodexUsageFromRollout(bus, { sessionsDir: dir });

    expect(received).toEqual([{ exhausted: true }]);
  });
});

describe("codex-rate-limits: emitCodexUsageFromRollout (no fabrication)", () => {
  it("does NOT emit when no rollout / no rate_limits is found (no fabrication)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-rollout-empty-"));
    tmpDirs.push(dir);
    const bus = new ChatEventBus();
    let count = 0;
    bus.on("agent.status", () => {
      count += 1;
    });

    await emitCodexUsageFromRollout(bus, { sessionsDir: dir });

    expect(count).toBe(0);
  });

  it("reports stale when a carried session id maps to no rollout but another rollout exists", async () => {
    const dir = await makeTmpDir("codex-rollout-stale-session-");
    await writeFile(
      join(dir, "rollout-2026-06-23T20-00-00-other-session.jsonl"),
      `${tokenCountLine(HEALTHY_RATE_LIMITS)}\n`,
      "utf8",
    );
    const bus = new ChatEventBus();
    let count = 0;
    bus.on("agent.status", () => {
      count += 1;
    });

    const read = await emitCodexUsageFromRollout(bus, {
      sessionId: "active-session",
      sessionsDir: dir,
    });

    expect(read.outcome).toBe("stale");
    expect(count).toBe(0);
  });
});

describe("codex-rate-limits: latest token_count wins (multiple windows in one rollout)", () => {
  it("returns the LAST complete token_count rate_limits, not an earlier window", async () => {
    const dir = await makeTmpDir("codex-rollout-multi-");
    const rollout = join(dir, "rollout-2026-06-23T13-02-00-multi.jsonl");
    // An older HEALTHY window written first, then the SPENT window codex hit at turn end. The reader
    // must return the LAST one (exhausted) — the most recent snapshot — not the earlier healthy one.
    const lines = [tokenCountLine(HEALTHY_RATE_LIMITS), tokenCountLine(EXHAUSTED_RATE_LIMITS)];
    await writeFile(rollout, `${lines.join("\n")}\n`, "utf8");

    const rateLimits = await readNewestRolloutRateLimits(dir);

    // The two captures are told apart by the vendor's OWN utilization: 100% (spent) vs 0% (idle).
    expect(rateLimits?.primary?.used_percent).toBe(100);
  });
});

describe("codex-rate-limits: DECISION 1 — newest rollout chosen by FILENAME session timestamp, not mtime", () => {
  it("picks the rollout whose filename timestamp is newest EVEN when an older file has a newer mtime", async () => {
    const dir = await makeTmpDir("codex-rollout-mtime-");
    // The OLDER session (earlier filename timestamp) carries a HEALTHY window; the NEWER session (later
    // filename timestamp) carries the SPENT window the operator must see. We then touch the OLD file so
    // its mtime is the NEWEST on disk — an mtime-based reader would wrongly return the stale healthy one.
    const oldFile = join(dir, "rollout-2026-06-23T08-00-00-aaa.jsonl");
    const newFile = join(dir, "rollout-2026-06-23T20-00-00-bbb.jsonl");
    await writeFile(oldFile, `${tokenCountLine(HEALTHY_RATE_LIMITS)}\n`, "utf8");
    await writeFile(newFile, `${tokenCountLine(EXHAUSTED_RATE_LIMITS)}\n`, "utf8");
    const future = new Date(Date.now() + 60_000);
    await utimes(oldFile, future, future); // OLD session file now has the NEWEST mtime

    const rateLimits = await readNewestRolloutRateLimits(dir);

    // FALSIFYING: the filename-timestamp winner (the spent window) is returned despite the stale file's
    // newer mtime. An mtime-based selection would return the healthy window's 0% here.
    expect(rateLimits?.primary?.used_percent).toBe(100);
  });

  it("picks the carried session's rollout, not the globally newest unrelated session", async () => {
    const dir = await makeTmpDir("codex-rollout-session-bound-");
    const otherFile = join(dir, "rollout-2026-06-23T20-00-00-other-session.jsonl");
    const activeFile = join(dir, "rollout-2026-06-23T08-00-00-active-session.jsonl");
    await writeFile(otherFile, `${tokenCountLine(EXHAUSTED_RATE_LIMITS)}\n`, "utf8");
    await writeFile(activeFile, `${tokenCountLine(HEALTHY_RATE_LIMITS)}\n`, "utf8");

    const rateLimits = await readNewestRolloutRateLimits(dir, { sessionId: "active-session" });

    expect(rateLimits?.primary?.used_percent).toBe(0); // the ACTIVE session's window, not the other's
  });
});

describe("codex-rate-limits: BLOCK 3 — a partial trailing token_count line must NOT emit a stale window", () => {
  it("returns undefined (emits nothing) when the trailing token_count line is incomplete (no newline / truncated)", async () => {
    const dir = await makeTmpDir("codex-rollout-partial-");
    const rollout = join(dir, "rollout-2026-06-23T13-02-00-partial.jsonl");
    // The race: an OLDER complete HEALTHY token_count, then codex's FINAL EXHAUSTED token_count is
    // mid-flush — its line is truncated with NO trailing newline. A backward scan that skips the broken
    // trailing line and returns the older HEALTHY window shows a STALE healthy bar exactly when codex
    // just hit exhausted. The reader must NOT emit the known-older window: it returns undefined instead.
    const healthy = tokenCountLine(HEALTHY_RATE_LIMITS);
    const partial = tokenCountLine(EXHAUSTED_RATE_LIMITS).slice(0, -25); // truncated mid-object, no "\n"
    await writeFile(rollout, `${healthy}\n${partial}`, "utf8");

    const rateLimits = await readNewestRolloutRateLimits(dir, { retryDelayMs: 1, maxRetries: 2 });

    // FALSIFYING: never the older healthy window while the newest line is still flushing.
    expect(rateLimits).toBeUndefined();
  });

  it("emits the EXHAUSTED window once the trailing token_count line completes (newline-terminated)", async () => {
    const dir = await makeTmpDir("codex-rollout-complete-");
    const rollout = join(dir, "rollout-2026-06-23T13-02-00-complete.jsonl");
    const healthy = tokenCountLine(HEALTHY_RATE_LIMITS);
    const exhausted = tokenCountLine(EXHAUSTED_RATE_LIMITS);
    // Now the final exhausted line is fully written + newline-terminated (the flush completed).
    await writeFile(rollout, `${healthy}\n${exhausted}\n`, "utf8");

    const bus = new ChatEventBus();
    const received: { exhausted: boolean; auth: string }[] = [];
    bus.on("agent.status", (e) =>
      received.push({ exhausted: e.usage?.exhausted === true, auth: e.auth ?? "" }),
    );

    await emitCodexUsageFromRollout(bus, { sessionsDir: dir });

    expect(received).toEqual([{ exhausted: true, auth: "limited" }]);
  });
});

// BLOCK A (round-2 over-correction): the BLOCK 3 fix pended on ANY unparsable trailing line, which
// SWALLOWED a valid latest window when the trailing partial line was a NON-token_count (a mid-flush
// `response_item` flushed after the final token_count). Pend ONLY for a partial token_count.
describe("codex-rate-limits: BLOCK A — a partial trailing NON-token_count line must NOT swallow the window", () => {
  it("emits the latest COMPLETE token_count when a partial NON-token_count line trails it (not undefined)", async () => {
    const dir = await makeTmpDir("codex-rollout-trailing-nonusage-");
    const rollout = join(dir, "rollout-2026-06-23T13-02-00-trail.jsonl");
    const exhausted = tokenCountLine(EXHAUSTED_RATE_LIMITS);
    const partialNonUsage = responseItemLine().slice(0, -18); // truncated mid-object, NOT a token_count
    await writeFile(rollout, `${exhausted}\n${partialNonUsage}`, "utf8");

    const rateLimits = await readNewestRolloutRateLimits(dir, { retryDelayMs: 1, maxRetries: 2 });

    // FALSIFYING: the COMPLETE window survives a trailing partial non-usage line.
    expect(rateLimits?.primary?.used_percent).toBe(100);
  });

  // BLOCK A must STILL satisfy BLOCK 3: a partial trailing TOKEN_COUNT over an older COMPLETE token_count
  // pends (and after retries returns undefined) — it must NEVER fall through to the stale older window.
  it("still pends (returns undefined) when the trailing PARTIAL line IS a token_count over an older window", async () => {
    const dir = await makeTmpDir("codex-rollout-trailing-partial-tc-");
    const rollout = join(dir, "rollout-2026-06-23T13-02-00-ptc.jsonl");
    const olderHealthy = tokenCountLine(HEALTHY_RATE_LIMITS);
    const partialTokenCount = tokenCountLine(EXHAUSTED_RATE_LIMITS).slice(0, -25); // truncated token_count
    await writeFile(rollout, `${olderHealthy}\n${partialTokenCount}`, "utf8");

    const rateLimits = await readNewestRolloutRateLimits(dir, { retryDelayMs: 1, maxRetries: 2 });

    // FALSIFYING: never the stale older window while the newest TOKEN_COUNT line is still flushing.
    expect(rateLimits).toBeUndefined();
  });
});

// The captured usage shape — mirrors the bus's nested usage (resets/USED-% windows are
// string|number|undefined under exactOptionalPropertyTypes, matching AgentStatusUpdateEvent).
type CapturedUsage = {
  label: string;
  exhausted: boolean;
  resets?: string | undefined;
  contextUsedPct?: number | undefined;
  fiveHourUsedPct?: number | undefined;
};

// Emits one agent.status from a REAL rollout .jsonl and returns the captured usage (single source of
// truth: the production reader parses the file, so info + rate_limits come from the SAME token_count line).
async function emitAndCaptureUsage(line: string): Promise<CapturedUsage> {
  const dir = await mkdtemp(join(tmpdir(), "codex-rollout-ctx-"));
  tmpDirs.push(dir);
  const rollout = join(dir, "rollout-2026-06-23T14-00-00-ctx.jsonl");
  await writeFile(rollout, `${line}\n`, "utf8");
  const bus = new ChatEventBus();
  const received: CapturedUsage[] = [];
  bus.on("agent.status", (e) => {
    if (e.usage !== undefined) received.push({ ...e.usage });
  });
  await emitCodexUsageFromRollout(bus, { sessionsDir: dir });
  expect(received).toHaveLength(1);
  return received[0] as CapturedUsage;
}

// Thin wrapper: emit the usage for a HEALTHY window whose info carries the given last/window, so each
// case is one line. HEALTHY_RATE_LIMITS keeps label/exhausted/resets fixed across cases (regression base).
function usageForContext(
  lastTokens: number | undefined,
  contextWindow: number | undefined,
): Promise<CapturedUsage> {
  return emitAndCaptureUsage(
    tokenCountLineWithInfo({ rateLimits: HEALTHY_RATE_LIMITS, lastTokens, contextWindow }),
  );
}

// Feature 2 context-left: the emitted usage carries contextUsedPct derived from the SAME token_count
// line as rate_limits — clamp(round((last_token_usage.total_tokens / window) * 100), 0, 100).
// last_token_usage (per-turn occupancy) is used, NOT total_token_usage (cumulative billing → 166% bug).
describe("codex-rate-limits: contextUsedPct (per-turn occupancy from the SAME token_count line)", () => {
  it("(a) healthy: last=76856, window=258400 → 30 used — round((76856/258400)*100)", async () => {
    expect((await usageForContext(76_856, 258_400)).contextUsedPct).toBe(30);
  });

  it("(b) regression: label/exhausted/resets byte-identical to the no-info HEALTHY window", async () => {
    // Additive only: a populated info block changes ONLY contextUsedPct — the other fields come
    // from rate_limits alone (codex-usage-decode.test.ts contracts that mapping).
    const withInfo = await usageForContext(76_856, 258_400);
    expect(withInfo.label).toBe("wk 0%"); // the IDLE capture's weekly window, named
    expect(withInfo.exhausted).toBe(false);
    expect(withInfo.resets).toBeUndefined();
  });

  it("(c) window 0 → contextUsedPct undefined, usage still emitted (label intact)", async () => {
    const usage = await usageForContext(76_856, 0);
    expect(usage.contextUsedPct).toBeUndefined();
    expect(usage.label).toBe("wk 0%");
  });

  it("(c) window missing → contextUsedPct undefined, usage still emitted", async () => {
    const usage = await usageForContext(76_856, undefined);
    expect(usage.contextUsedPct).toBeUndefined();
    expect(usage.label).toBe("wk 0%");
  });

  it("(c) last_token_usage absent → contextUsedPct undefined, usage still emitted", async () => {
    const usage = await usageForContext(undefined, 258_400);
    expect(usage.contextUsedPct).toBeUndefined();
    expect(usage.label).toBe("wk 0%");
  });

  it("(d) last (300000) > window (258400) → clamped to 100 (over-full)", async () => {
    expect((await usageForContext(300_000, 258_400)).contextUsedPct).toBe(100);
  });
});
