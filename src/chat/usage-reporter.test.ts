/**
 * @file src/chat/usage-reporter.test.ts
 * @purpose Unit coverage for the shared usage reporter: ACP updates emit status/payload, missing
 *   carrier usage emits a visible diagnostic, and (W4-R2f RA-4) the claude.statusline probe runs
 *   exactly when ACP has NOT already answered the quota question.
 * @exports (test suite - no runtime exports)
 * @depends node:fs, node:fs/promises, node:os, node:path, vitest, ./events, ./statusline-config, ./usage-reporter
 * @size-justified: ONE reporter's full source matrix — ACP updates, claude statusline, codex rollout,
 *   agy statusline, dedup receipts — each needing its own on-disk fixture. Splitting by source would
 *   clone the temp-dir/env-isolation harness into four files kept in lockstep by hand.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetClaudeWindowFold } from "./claude-usage-fold.js";
import { BOTH_WINDOWS, WEEKLY_ONLY_IDLE } from "./codex-usage-captures.fixtures.js";
import type { CodexRateLimits } from "./codex-usage-decode.js";
import { type AgentStatusUpdateEvent, ChatEventBus } from "./events.js";
import { claudeStatuslinePaths } from "./statusline-config.js";
import type { AgentName } from "./types.js";
import { createUsageReporter } from "./usage-reporter.js";

type UsagePayloadEvent = {
  readonly agent: AgentName;
  readonly droppedCount?: number;
  readonly fields: readonly string[];
  readonly kind: "usage.payload";
  readonly outcome: "arrived" | "missing" | "stale" | "malformed" | "write-failed" | "deduped";
  readonly sample?: unknown;
  readonly source: string;
  readonly turn: number;
};
type LooseBus = { on(kind: string, handler: (event: UsagePayloadEvent) => void): void };

const tmpDirs: string[] = [];
const savedCodexHome = process.env.CODEX_HOME;
const savedStatuslineDir = process.env.ZER0_STATUSLINE_DIR;

beforeEach(() => {
  resetClaudeWindowFold();
});

afterEach(async () => {
  restoreEnv("CODEX_HOME", savedCodexHome);
  restoreEnv("ZER0_STATUSLINE_DIR", savedStatuslineDir);
  for (const dir of tmpDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("normalizes an ACP usage_update into agent.status plus usage.payload arrived", () => {
  const bus = new ChatEventBus();
  const statuses = captureStatuses(bus);
  const payloads = capturePayloads(bus);
  const reporter = createUsageReporter({
    agent: "codex",
    bus,
    cwd: "C:/repo",
    startedMs: Date.now(),
    turn: 2,
  });

  reporter.recordAcpSessionUpdate({ sessionUpdate: "usage_update", used: 7, size: 10 });

  expect(statuses[0]).toMatchObject({ agent: "codex", usage: { contextUsedPct: 70 } });
  const normalized = payloads.find((event) => event.source === "acp.usage_update");
  expect(normalized).toMatchObject({ outcome: "arrived", source: "acp.usage_update" });
  expect(normalized?.fields).toContain("contextUsedPct");
});

it("RED: the tripwire keeps new field signatures and reports the count plus last sample it deduped", async () => {
  const bus = new ChatEventBus();
  const payloads = capturePayloads(bus);
  const reporter = createUsageReporter({
    agent: "claude",
    bus,
    cwd: "C:/repo",
    startedMs: Date.now(),
    turn: 12,
  });
  const repeated = { sessionUpdate: "usage_update", used: 7, size: 100 };
  const richer = {
    ...repeated,
    _meta: {
      "_claude/usageWindows": {
        five_hour: { utilization: 11, resets_at: "2026-07-15T23:00:00.000Z" },
      },
    },
  };

  reporter.recordAcpSessionUpdate(repeated);
  reporter.recordAcpSessionUpdate({ ...repeated, used: 8 });
  reporter.recordAcpSessionUpdate(richer);
  await reporter.capturePostLane(async () => undefined);

  const raw = payloads.filter((event) => event.source === "acp.usage_update.raw");
  expect(raw.map((event) => event.outcome)).toEqual(["arrived", "arrived", "deduped"]);
  expect(raw[1]?.fields).toContain("_meta._claude/usageWindows.five_hour.utilization");
  expect(raw[2]).toMatchObject({
    droppedCount: 1,
    outcome: "deduped",
    sample: { sessionUpdate: "usage_update", used: 8, size: 100 },
  });
});

it("FALSIFIER: raw claude usage_update window shape is durably traceable before normalization", () => {
  const bus = new ChatEventBus();
  const statuses = captureStatuses(bus);
  const payloads = capturePayloads(bus);
  const reporter = createUsageReporter({
    agent: "claude",
    bus,
    cwd: "C:/repo",
    startedMs: Date.now(),
    turn: 6,
  });

  reporter.recordAcpSessionUpdate(rawClaudeUsageUpdate());

  expect(statuses[0]).toMatchObject({
    agent: "claude",
    usage: { contextUsedPct: 4, fiveHourUsedPct: 13, weeklyUsedPct: 84 },
  });
  expect(payloads).toContainEqual({
    agent: "claude",
    fields: [
      "sessionUpdate",
      "used",
      "size",
      "_meta._claude/usageWindows.five_hour.utilization",
      "_meta._claude/usageWindows.five_hour.resets_at",
      "_meta._claude/usageWindows.seven_day.utilization",
      "_meta._claude/usageWindows.seven_day.resets_at",
    ],
    kind: "usage.payload",
    outcome: "arrived",
    sample: rawClaudeUsageUpdate(),
    source: "acp.usage_update.raw",
    turn: 6,
  });
});

it("FALSIFIER: raw claude usage_update rateLimit shape is durably traceable before normalization", () => {
  const bus = new ChatEventBus();
  const statuses = captureStatuses(bus);
  const payloads = capturePayloads(bus);
  const reporter = createUsageReporter({
    agent: "claude",
    bus,
    cwd: "C:/repo",
    startedMs: Date.now(),
    turn: 9,
  });

  reporter.recordAcpSessionUpdate(rawClaudeRateLimitUpdate());

  expect(statuses[0]).toMatchObject({
    agent: "claude",
    usage: {
      contextUsedPct: 4,
      weeklyResetsAtMs: 1_800_086_400_000,
      weeklyUsedPct: 84,
    },
  });
  expect(statuses[0]?.usage?.fiveHourUsedPct).toBeUndefined();
  expect(payloads).toContainEqual({
    agent: "claude",
    fields: [
      "sessionUpdate",
      "used",
      "size",
      "_meta._claude/rateLimit.status",
      "_meta._claude/rateLimit.resetsAt",
      "_meta._claude/rateLimit.rateLimitType",
      "_meta._claude/rateLimit.utilization",
      "_meta._claude/rateLimit.overageStatus",
      "_meta._claude/rateLimit.overageResetsAt",
      "_meta._claude/rateLimit.overageDisabledReason",
      "_meta._claude/rateLimit.isUsingOverage",
      "_meta._claude/rateLimit.overageInUse",
      "_meta._claude/rateLimit.surpassedThreshold",
    ],
    kind: "usage.payload",
    outcome: "arrived",
    sample: rawClaudeRateLimitUpdate(),
    source: "acp.usage_update.raw",
    turn: 9,
  });
});

it("FALSIFIER: carrier claude ACP ctx is followed by statusline 5h windows", async () => {
  const cwd = await tempDir("usage-claude-");
  await isolateStatuslineDir("usage-claude-statusline-");
  const startedMs = Date.now() - 10;
  writeClaudeStatuslinePayload(cwd, {
    context_window: { used_percentage: 11 },
    rate_limits: {
      five_hour: { used_percentage: 42, resets_at: 1_800_000_000 },
      seven_day: { used_percentage: 81, resets_at: 1_800_086_400 },
    },
  });
  const bus = new ChatEventBus();
  const statuses = captureStatuses(bus);
  const payloads = capturePayloads(bus);
  const reporter = createUsageReporter({
    agent: "claude",
    bus,
    carrier: true,
    cwd,
    startedMs,
    turn: 4,
  });

  reporter.recordAcpSessionUpdate({ sessionUpdate: "usage_update", used: 7, size: 100 });
  await reporter.capturePostLane();

  expect(statuses.at(-1)).toMatchObject({
    agent: "claude",
    usage: { contextUsedPct: 11, fiveHourUsedPct: 42, weeklyUsedPct: 81 },
  });
  expect(payloads.at(-1)).toMatchObject({
    agent: "claude",
    outcome: "arrived",
    source: "claude.statusline",
  });
  expect(payloads.at(-1)?.fields).toEqual([
    "label",
    "exhausted",
    "contextUsedPct",
    "fiveHourUsedPct",
    "fiveHourResetsAtMs",
    "weeklyUsedPct",
    "weeklyResetsAtMs",
  ]);
});

it("FALSIFIER: carrier codex emits a session-bound rollout leg with ctx + 5h + weekly fields", async () => {
  const codexHome = await tempDir("usage-codex-home-");
  process.env.CODEX_HOME = codexHome;
  seedCodexRollouts(codexHome);
  const bus = new ChatEventBus();
  const statuses = captureStatuses(bus);
  const payloads = capturePayloads(bus);
  const reporter = createUsageReporter({
    agent: "codex",
    bus,
    carrier: true,
    cwd: "C:/repo",
    laneSessionId: () => "active-session",
    startedMs: Date.parse("2026-07-15T08:59:00.000Z"),
    turn: 5,
  });

  reporter.recordAcpSessionUpdate({ sessionUpdate: "usage_update", used: 5, size: 100 });
  await reporter.capturePostLane();

  // The captured BOTH_WINDOWS payload: a 300-minute window at 27% and a 10080-minute one at 100%, each
  // on its own meter and each carrying the vendor's own reset instant through the reporter (W4-R2b D3 —
  // those two reset fields were being dropped before, which is what made recovery guess its cooldown).
  expect(statuses.at(-1)).toMatchObject({
    agent: "codex",
    usage: {
      contextUsedPct: 25,
      fiveHourUsedPct: 27,
      fiveHourResetsAtMs: 1_783_639_273_000,
      weeklyUsedPct: 100,
      weeklyResetsAtMs: 1_783_768_191_000,
    },
  });
  expect(payloads.at(-1)).toMatchObject({
    agent: "codex",
    outcome: "arrived",
    source: "codex.rollout",
  });
  expect(payloads.at(-1)?.fields).toEqual([
    "label",
    "exhausted",
    "contextUsedPct",
    "fiveHourUsedPct",
    "fiveHourResetsAtMs",
    "weeklyUsedPct",
    "weeklyResetsAtMs",
  ]);
});

it("FALSIFIER: stale codex rollout cannot overwrite a fresh ACP ctx update", async () => {
  const codexHome = await tempDir("usage-codex-stale-home-");
  process.env.CODEX_HOME = codexHome;
  seedCodexRollouts(codexHome);
  const bus = new ChatEventBus();
  const statuses = captureStatuses(bus);
  const payloads = capturePayloads(bus);
  const reporter = createUsageReporter({
    agent: "codex",
    bus,
    carrier: true,
    cwd: "C:/repo",
    laneSessionId: () => "active-session",
    startedMs: Date.now() + 60_000,
    turn: 7,
    // M3 CHANGED THIS TEST'S HARNESS, DELIBERATELY, AND NOT ITS ASSERTIONS. A stale reading used to
    // return at attempt 0 with no retry; it is now the EXPECTED state while a turn's own token_count is
    // still being written, so it polls to a deadline. With the production default this test sat for
    // 5 091 ms against a 5 000 ms vitest timeout — a pass that depends on which machine runs it. The
    // bound belongs to the test, exactly as the four claude/agy cases below already do it
    // (usagePoll: { intervalMs: 1, timeoutMs: 5 }). Raising the timeout instead would have hidden a
    // real wait behind a bigger number.
    usagePoll: { intervalMs: 1, timeoutMs: 5 },
  });

  reporter.recordAcpSessionUpdate({ sessionUpdate: "usage_update", used: 60, size: 100 });
  await reporter.capturePostLane();

  expect(statuses).toHaveLength(1);
  expect(statuses[0]).toMatchObject({ agent: "codex", usage: { contextUsedPct: 60 } });
  expect(payloads).toContainEqual({
    agent: "codex",
    fields: [],
    kind: "usage.payload",
    outcome: "stale",
    source: "codex.rollout",
    turn: 7,
  });
});

it("FALSIFIER: fresh statusline write failures classify usage payload as write-failed", async () => {
  const cwd = await tempDir("usage-claude-write-fail-");
  await isolateStatuslineDir("usage-claude-write-fail-statusline-");
  const startedMs = Date.now() - 10;
  const target = claudeStatuslinePaths(cwd).payloadPath;
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(
    path.join(path.dirname(target), "statusline-failures.ndjson"),
    `${JSON.stringify({ kind: "statusline.write-failed", path: target, ts: new Date().toISOString() })}\n`,
    "utf8",
  );
  const bus = new ChatEventBus();
  const payloads = capturePayloads(bus);
  const reporter = createUsageReporter({
    agent: "claude",
    bus,
    carrier: true,
    cwd,
    startedMs,
    turn: 8,
    usagePoll: { intervalMs: 1, timeoutMs: 5 },
  });

  await reporter.capturePostLane();

  expect(payloads).toEqual([
    {
      agent: "claude",
      fields: [],
      kind: "usage.payload",
      outcome: "write-failed",
      source: "claude.statusline",
      turn: 8,
    },
  ]);
});
it("traces missing for a carrier ACP lane with no usage_update", async () => {
  await isolateStatuslineDir("usage-claude-missing-statusline-");
  const bus = new ChatEventBus();
  const payloads = capturePayloads(bus);
  const reporter = createUsageReporter({
    agent: "claude",
    bus,
    carrier: true,
    cwd: "C:/repo",
    startedMs: Date.now(),
    turn: 3,
    usagePoll: { intervalMs: 1, timeoutMs: 5 },
  });

  await reporter.capturePostLane();

  expect(payloads).toEqual([
    {
      agent: "claude",
      fields: [],
      kind: "usage.payload",
      outcome: "missing",
      source: "claude.statusline",
      turn: 3,
    },
  ]);
});

// W4-R2f RA-4 FALSIFIER. THE OPERATOR-VISIBLE FAILURE: `/status` reporting a problem on a lane whose
// numbers arrived fine. In their 2026-07-31 trace the ACP stream delivered claude's whole window at
// 15:20:08.625, and 5.6 seconds later this probe reported `missing from claude.statusline`, which
// use-cockpit-bus.ts's diagnosticFromUsagePayload writes straight into that lane's /status line.
it("RA-4: no claude.statusline probe once ACP has delivered a QUOTA window", async () => {
  const cwd = await tempDir("usage-claude-quota-");
  await isolateStatuslineDir("usage-claude-quota-statusline-");
  const bus = new ChatEventBus();
  const payloads = capturePayloads(bus);
  const reporter = createUsageReporter({
    agent: "claude",
    bus,
    carrier: true,
    cwd,
    startedMs: Date.now(),
    turn: 4,
    usagePoll: { intervalMs: 1, timeoutMs: 5 },
  });

  reporter.recordAcpSessionUpdate(rawClaudeUsageUpdate()); // five_hour + seven_day, i.e. authoritative
  await reporter.capturePostLane();

  expect(
    payloads.filter((event) => event.source === "claude.statusline"),
    "a probe fired against a question ACP had already answered",
  ).toEqual([]);
});

// THE OTHER DIRECTION, and the one that keeps the gate honest. A context-only usage_update — the exact
// first payload claude's bridge sends (operator trace 15:20:07.394, fields [label, exhausted,
// contextUsedPct]) — leaves the 5h and weekly windows unanswered, so the fallback MUST still run.
// Without this pair the gate could quietly delete the operator's quota meters on any bridge that never
// sends the richer update. (The sibling test above, "carrier claude ACP ctx is followed by statusline
// 5h windows", proves the same boundary end-to-end through the real statusline read.)
it("RA-4: a CONTEXT-ONLY ACP update still probes — the quotas are not answered yet", async () => {
  await isolateStatuslineDir("usage-claude-ctxonly-statusline-");
  const bus = new ChatEventBus();
  const payloads = capturePayloads(bus);
  const reporter = createUsageReporter({
    agent: "claude",
    bus,
    carrier: true,
    cwd: "C:/repo",
    startedMs: Date.now(),
    turn: 5,
    usagePoll: { intervalMs: 1, timeoutMs: 5 },
  });

  reporter.recordAcpSessionUpdate({ sessionUpdate: "usage_update", used: 7, size: 100 });
  await reporter.capturePostLane();

  expect(payloads.filter((event) => event.source === "claude.statusline")).toMatchObject([
    { outcome: "missing", turn: 5 },
  ]);
});

function rawClaudeUsageUpdate(): unknown {
  return {
    sessionUpdate: "usage_update",
    used: 42_585,
    size: 1_000_000,
    _meta: {
      "_claude/usageWindows": {
        five_hour: { utilization: 13, resets_at: "2026-07-16T20:00:00.000Z" },
        seven_day: { utilization: 84, resets_at: "2026-07-22T20:00:00.000Z" },
      },
    },
  };
}

function rawClaudeRateLimitUpdate(): unknown {
  return {
    sessionUpdate: "usage_update",
    used: 42_585,
    size: 1_000_000,
    _meta: {
      "_claude/rateLimit": {
        status: "allowed_warning",
        resetsAt: 1_800_086_400,
        rateLimitType: "seven_day",
        utilization: 84,
        overageStatus: "allowed",
        overageResetsAt: 1_800_086_400,
        overageDisabledReason: "out_of_credits",
        isUsingOverage: false,
        overageInUse: false,
        surpassedThreshold: 80,
      },
    },
  };
}

function captureStatuses(bus: ChatEventBus): AgentStatusUpdateEvent[] {
  const events: AgentStatusUpdateEvent[] = [];
  bus.on("agent.status", (event) => events.push(event));
  return events;
}

function capturePayloads(bus: ChatEventBus): UsagePayloadEvent[] {
  const events: UsagePayloadEvent[] = [];
  (bus as LooseBus).on("usage.payload", (event) => events.push(event));
  return events;
}

// W4-R2b: both rollouts now carry CAPTURED payloads. The previous seeds were hand-built
// `{ primary: { used_percent: 35 }, secondary: { used_percent: 76 } }` pairs with no `window_minutes`
// at all — a shape codex has never emitted — so this FALSIFIER could not have caught the position-
// mapping bug it appears to cover. The active session gets the only capture that reports BOTH windows.
function seedCodexRollouts(codexHome: string): void {
  const sessionsDir = path.join(codexHome, "sessions", "2026", "07", "15");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    path.join(sessionsDir, "rollout-2026-07-15T10-00-00-other-session.jsonl"),
    `${tokenCountLine(WEEKLY_ONLY_IDLE)}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(sessionsDir, "rollout-2026-07-15T09-00-00-active-session.jsonl"),
    `${tokenCountLine(BOTH_WINDOWS)}\n`,
    "utf8",
  );
}
function writeClaudeStatuslinePayload(cwd: string, payload: unknown): void {
  const target = claudeStatuslinePaths(cwd).payloadPath;
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(payload), "utf8");
}

function tokenCountLine(rateLimits: CodexRateLimits): string {
  return JSON.stringify({
    timestamp: "2026-07-15T09:00:00.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { last_token_usage: { total_tokens: 25 }, model_context_window: 100 },
      rate_limits: rateLimits,
    },
  });
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

async function isolateStatuslineDir(prefix: string): Promise<void> {
  process.env.ZER0_STATUSLINE_DIR = await tempDir(prefix);
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}
