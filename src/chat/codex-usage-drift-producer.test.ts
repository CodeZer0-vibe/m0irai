/**
 * @file src/chat/codex-usage-drift-producer.test.ts
 * @exports (test suite — no runtime exports)
 * @depends node:fs, node:os, node:path, vitest, ./codex-usage-captures.fixtures, ./codex-usage-decode,
 *   ./events, ./usage-reporter
 * @purpose The PRODUCER half of "vendor drift must be loud": a real rollout carrying the 2026-06-03
 *   capture (`window_minutes: 0`) must put the divergence on the usage.payload event, because that event
 *   is the only channel a renderer has for it. (The Ink consumer half — lifting it back off and rendering it
 *   in /status — left with the TUI, m0irai 3.3; the producer contract here stands on its own.)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { UNRECOGNISED_WINDOW, WEEKLY_ONLY_IDLE } from "./codex-usage-captures.fixtures.js";
import { type CodexRateLimits, USAGE_DRIFT_FIELD } from "./codex-usage-decode.js";
import { ChatEventBus } from "./events.js";
import { createUsageReporter } from "./usage-reporter.js";

type PayloadEvent = { readonly fields: readonly string[]; readonly outcome: string };
type LooseBus = { on(kind: string, handler: (event: PayloadEvent) => void): void };

const dirs: string[] = [];
const savedCodexHome = process.env.CODEX_HOME;
afterEach(() => {
  if (savedCodexHome === undefined) Reflect.deleteProperty(process.env, "CODEX_HOME");
  else process.env.CODEX_HOME = savedCodexHome;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function capturePayload(rateLimits: CodexRateLimits): Promise<PayloadEvent | undefined> {
  const home = mkdtempSync(path.join(tmpdir(), "codex-drift-producer-"));
  dirs.push(home);
  const sessionsDir = path.join(home, "sessions", "2026", "07", "27");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    path.join(sessionsDir, "rollout-2026-07-27T09-45-51-live-session.jsonl"),
    `${JSON.stringify({
      timestamp: "2026-07-27T09:45:51.385Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { total_tokens: 48_701 }, model_context_window: 258_400 },
        rate_limits: rateLimits,
      },
    })}\n`,
    "utf8",
  );
  process.env.CODEX_HOME = home;
  const bus = new ChatEventBus();
  const events: PayloadEvent[] = [];
  (bus as LooseBus).on("usage.payload", (e) => events.push(e));
  const reporter = createUsageReporter({
    agent: "codex",
    bus,
    cwd: "C:/repo",
    laneSessionId: () => "live-session",
    startedMs: Date.parse("2026-07-27T09:00:00.000Z"),
    turn: 1,
  });
  await reporter.capturePostLane();
  return events.at(-1);
}

// OPERATOR-VISIBLE FAILURE: codex's plan starts reporting a window shape this build cannot name, the
// quota meter quietly disappears, and nothing anywhere says why — for weeks.
it("carries the divergence out on the usage.payload event", async () => {
  const payload = await capturePayload(UNRECOGNISED_WINDOW);
  expect(payload?.fields).toContain(
    `${USAGE_DRIFT_FIELD}codex reported a 0-minute quota window this build cannot name`,
  );
});

// The outcome stays "arrived" on purpose: the context reading DID decode, and calling the whole payload
// malformed would throw away a fact the operator can use.
it("still reports the payload as arrived, with the fields that did decode", async () => {
  const payload = await capturePayload(UNRECOGNISED_WINDOW);
  expect(payload?.outcome).toBe("arrived");
  expect(payload?.fields).toContain("contextUsedPct");
});

// OPERATOR-VISIBLE FAILURE: a permanent warning bracket in /status on a perfectly healthy codex.
it("emits NO divergence for the operator's real, nameable payload", async () => {
  const payload = await capturePayload(WEEKLY_ONLY_IDLE);
  expect(payload?.fields.some((f) => f.startsWith(USAGE_DRIFT_FIELD))).toBe(false);
  expect(payload?.fields).toContain("weeklyUsedPct");
});
