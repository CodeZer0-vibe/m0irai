/**
 * @file src/chat/codex-usage-consumers.test.ts
 * @exports (test suite — no runtime exports)
 * @depends node:fs, node:os, node:path, vitest, ./codex-usage-captures.fixtures, ./codex-usage-decode,
 *   ./events, ./lane-availability-store, ./statusline-payload, ./usage-reporter
 * @purpose EVERY DOWNSTREAM CONSUMER of the codex usage window, verified against the operator's REAL
 *   payload rather than assumed to follow. Correcting a decode without walking it through is how a lie
 *   moves rather than dies: each of these consumers reads `fiveHour*`/`weekly*`, so before this round
 *   they were all quietly being handed a weekly number in the 5-hour slot, or nothing at all.
 *
 *   One of them changed BEHAVIOUR without changing a line of its own code, which is exactly why it is
 *   pinned here: the recovery clock now learns codex's true reset instant (it previously got none, so an
 *   exhausted codex lane fell back to a guessed cooldown). (The loop budget consumer left with the loop,
 *   m0irai 3.4; the Ink display-policy consumer left with the TUI, 3.3.)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BOTH_WINDOWS,
  WEEKLY_ONLY_IDLE,
  WEEKLY_ONLY_SPENT,
} from "./codex-usage-captures.fixtures.js";
import { type CodexRateLimits, decodeCodexUsage } from "./codex-usage-decode.js";
import { ChatEventBus } from "./events.js";
import {
  getLaneAvailability,
  noteLaneFailure,
  resetLaneAvailabilityStore,
} from "./lane-availability-store.js";
import { FALLBACK_COOLDOWN_MS } from "./lane-availability.js";
import { bindingResetAtMs } from "./statusline-payload.js";
import { createUsageReporter } from "./usage-reporter.js";

/**
 * Each capture's OWN reset instant, read off the `resets_at` epoch second in the verbatim payload.
 *
 * DELTA ITEM 2 made the MOMENT of the death matter here. A window whose instant has already passed is
 * no longer published as that death's window — a past instant makes the lane probe-eligible on every
 * send, and the terminal retires the painted state on it — so a test that deposits a window and then
 * kills the lane has to kill it while that window is still ahead, which is the only sequence production
 * ever runs. These payloads were really captured on 2026-07-25 and 2026-07-09, each carrying a window
 * in its own future; it is the harness below that re-plays every fixture through one synthetic
 * 2026-07-27 rollout, and that synthetic date is what used to put both instants behind the clock.
 */
const WEEKLY_SPENT_RESET_MS = 1_785_073_363_000;
const BOTH_WINDOWS_BINDING_RESET_MS = 1_783_768_191_000;
const dirs: string[] = [];
const savedCodexHome = process.env.CODEX_HOME;

afterEach(() => {
  resetLaneAvailabilityStore();
  if (savedCodexHome === undefined) Reflect.deleteProperty(process.env, "CODEX_HOME");
  else process.env.CODEX_HOME = savedCodexHome;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function runCodexCapture(rateLimits: CodexRateLimits): Promise<void> {
  const home = mkdtempSync(path.join(tmpdir(), "codex-consumers-"));
  dirs.push(home);
  const sessionsDir = path.join(home, "sessions", "2026", "07", "27");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    path.join(sessionsDir, "rollout-2026-07-27T09-45-51-live-session.jsonl"),
    `${JSON.stringify({
      timestamp: "2026-07-27T09:45:51.385Z",
      type: "event_msg",
      payload: { type: "token_count", info: null, rate_limits: rateLimits },
    })}\n`,
    "utf8",
  );
  process.env.CODEX_HOME = home;
  const reporter = createUsageReporter({
    agent: "codex",
    bus: new ChatEventBus(),
    cwd: "C:/repo",
    laneSessionId: () => "live-session",
    startedMs: Date.parse("2026-07-27T09:00:00.000Z"),
    turn: 1,
  });
  await reporter.capturePostLane();
}

describe("consumer: the lane recovery clock (noteLaneResetWindow ← bindingResetAtMs)", () => {
  // The capture only DEPOSITS the instant (noteLaneResetWindow fills a side map); it becomes visible when
  // a dispatch later dies and noteLaneFailure keys recovery off it. So the honest observation point is a
  // death AFTER a capture — which is exactly the sequence the operator hits.
  //
  // OPERATOR-VISIBLE FAILURE: an exhausted codex lane re-probing on a guessed cooldown for days, because
  // the decode threw away the only instant that could tell recovery when capacity actually returns. Before
  // this round codex NEVER deposited an instant — the field did not survive the decode at all.
  it("keys a later codex death off the reset instant the captured payload carried", async () => {
    await runCodexCapture(WEEKLY_ONLY_SPENT);
    noteLaneFailure("codex", "rate limit exceeded", WEEKLY_SPENT_RESET_MS - 60_000);
    expect(getLaneAvailability("codex").resetsAtMs).toBe(WEEKLY_SPENT_RESET_MS);
  });

  it("deposits the BINDING window's instant when codex reports both", async () => {
    await runCodexCapture(BOTH_WINDOWS);
    noteLaneFailure("codex", "rate limit exceeded", BOTH_WINDOWS_BINDING_RESET_MS - 60_000);
    // The weekly (100% used) binds, not the 5h (27%) — recovery must wait out the longer window.
    expect(getLaneAvailability("codex").resetsAtMs).toBe(BOTH_WINDOWS_BINDING_RESET_MS);
  });

  it("DELTA 2: a deposited instant the death has already outlived is dropped, not published", async () => {
    // The other side of the freshness rule, at the real consumer. The captured window is genuine and
    // the deposit is genuine; it has simply rolled over by the time this lane dies. Publishing it would
    // hand the terminal an expiry already in the past — the red word retires the moment it paints —
    // and make `plausiblyReset` true immediately, so every send burns a dispatch at a spent account.
    await runCodexCapture(WEEKLY_ONLY_SPENT);
    const died = WEEKLY_SPENT_RESET_MS + 1;
    const spent = noteLaneFailure("codex", "rate limit exceeded", died);
    expect(
      spent.resetsAtMs,
      "a reset instant this death had already outlived was published as its window",
    ).toBeUndefined();
    expect(spent.probeAtMs).toBe(died + FALLBACK_COOLDOWN_MS);
  });

  it("bindingResetAtMs agrees with the meter for a weekly-only lane", () => {
    const { usage } = decodeCodexUsage(WEEKLY_ONLY_IDLE);
    expect(bindingResetAtMs(usage)).toBe(usage.weeklyResetsAtMs);
  });
});
