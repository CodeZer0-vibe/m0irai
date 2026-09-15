/**
 * @file src/chat/codex-rollout-poll.test.ts
 * @purpose M3 / F8. The post-turn rollout read used to give up on a STALE reading at attempt 0 with no
 *   retry at all, while claude's equivalent path waited five seconds — so a codex turn whose own
 *   token_count had not been written yet emitted nothing, and the meter was there on one boot and gone
 *   on the next. These pin the bounded, abortable poll: it waits for a reading that is coming, it stops
 *   at its deadline rather than emitting a late number, it re-finds a rollout that rotated under it,
 *   and it does not wait at all when there is nothing to wait for.
 * @exports (none)
 * @depends vitest, node:fs/promises, node:os, node:path, ./codex-rate-limits, ./codex-usage-captures.fixtures
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readNewestRolloutRateLimits } from "./codex-rate-limits.js";
import { WEEKLY_ONLY_IDLE } from "./codex-usage-captures.fixtures.js";

const tmpDirs: string[] = [];
const deferred: Promise<void>[] = [];
afterEach(async () => {
  // Settle every scheduled write BEFORE removing its directory. Without this, a poll that gives up
  // early (which is exactly what the pre-fix code does, and what these tests are run against to prove
  // they are RED) leaves a timer to fire into a deleted temp dir and reports an unhandled ENOENT.
  await Promise.allSettled(deferred.splice(0));
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Schedules a rollout write for `delayMs` from now and registers it for teardown. */
function writeLater(dir: string, name: string, observedAtMs: number, delayMs: number): void {
  deferred.push(
    new Promise<void>((resolve) => {
      setTimeout(() => {
        writeRollout(dir, name, observedAtMs)
          .catch(() => undefined)
          .finally(resolve);
      }, delayMs);
    }),
  );
}

it("FALSIFIER F8-a: a reading that lands DURING the poll window is picked up", async () => {
  const dir = await tempDir("codex-poll-arrives-");
  const turnStart = Date.now();
  // The turn's own token_count has not been written yet: all that is on disk belongs to a previous turn,
  // so isFreshTokenCount rejects it. Before M3 this returned {outcome:"stale"} at attempt 0 and the
  // reporter emitted nothing at all.
  await writeRollout(dir, "rollout-2026-08-20T10-00-00-a.jsonl", turnStart - 60_000);
  writeLater(dir, "rollout-2026-08-20T10-00-00-a.jsonl", turnStart + 5, 40);

  const rateLimits = await readNewestRolloutRateLimits(dir, {
    freshAfterMs: turnStart,
    intervalMs: 10,
    timeoutMs: 2_000,
  });

  expect(rateLimits?.primary?.used_percent).toBe(0);
});

it("FALSIFIER F8-b: a reading that never becomes current emits NOTHING by the deadline", async () => {
  const dir = await tempDir("codex-poll-never-");
  const turnStart = Date.now();
  await writeRollout(dir, "rollout-2026-08-20T10-00-00-b.jsonl", turnStart - 60_000);

  const startedAt = Date.now();
  const rateLimits = await readNewestRolloutRateLimits(dir, {
    freshAfterMs: turnStart,
    intervalMs: 10,
    timeoutMs: 120,
  });
  const elapsed = Date.now() - startedAt;

  // A late number is not better than no number: after the deadline the reader returns nothing rather
  // than handing back the previous turn's window wearing this turn's timestamp.
  expect(rateLimits).toBeUndefined();
  // It also actually WAITED. Asserting only `undefined` would pass against the old code, which gave up
  // instantly — that is the whole behaviour under test. The bound is generous in the other direction so
  // a loaded machine cannot fail it: 120 ms of polling cannot finish in under 60.
  expect(elapsed).toBeGreaterThanOrEqual(60);
});

it("PIN F8-c: an aborted poll returns promptly instead of sleeping out its deadline", async () => {
  const dir = await tempDir("codex-poll-abort-");
  const turnStart = Date.now();
  await writeRollout(dir, "rollout-2026-08-20T10-00-00-c.jsonl", turnStart - 60_000);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);

  const startedAt = Date.now();
  const rateLimits = await readNewestRolloutRateLimits(dir, {
    freshAfterMs: turnStart,
    intervalMs: 25,
    signal: controller.signal,
    timeoutMs: 30_000,
  });
  const elapsed = Date.now() - startedAt;

  expect(rateLimits).toBeUndefined();
  // TAGGED [PIN], NOT [FALSIFIER], and the distinction was earned rather than assumed: run against the
  // pre-M3 read this assertion PASSES, because that code gave up instantly and so came in under any
  // bound. It cannot see its subject on the old tree. Its mutation obligation is to drop the signal
  // from the delay and prove the poll then sleeps out its 30 s budget.
  expect(elapsed).toBeLessThan(5_000);
});

it("FALSIFIER F8-d: a rollout that ROTATES mid-poll is re-discovered", async () => {
  const dir = await tempDir("codex-poll-rotate-");
  const turnStart = Date.now();
  await writeRollout(dir, "rollout-2026-08-20T10-00-00-old.jsonl", turnStart - 60_000);
  // codex starts a NEW rollout file mid-turn and writes this turn's number there. The old file never
  // becomes fresh, so a reader that resolved its path once before the loop waits out its whole budget
  // staring at a file that has stopped changing.
  writeLater(dir, "rollout-2026-08-20T11-00-00-new.jsonl", turnStart + 5, 40);

  const rateLimits = await readNewestRolloutRateLimits(dir, {
    freshAfterMs: turnStart,
    intervalMs: 10,
    timeoutMs: 2_000,
  });

  expect(rateLimits?.primary?.used_percent).toBe(0);
});

it("PIN: with no freshness bound there is nothing to wait for, and nothing waits", async () => {
  const dir = await tempDir("codex-poll-unbounded-");

  const startedAt = Date.now();
  // The boot prefetch reads quota-only with NO freshAfterMs: every reading on disk is acceptable by
  // definition. An empty directory must therefore return immediately rather than polling for 5 s —
  // "no rollout" is the ordinary state of a fresh install, not a write that is about to land.
  const rateLimits = await readNewestRolloutRateLimits(dir, {});
  const elapsed = Date.now() - startedAt;

  expect(rateLimits).toBeUndefined();
  expect(elapsed).toBeLessThan(1_000);
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** One rollout carrying a single complete token_count line, stamped at `observedAtMs` — the timestamp
 *  isFreshTokenCount reads to decide whether the reading belongs to this turn. */
async function writeRollout(dir: string, name: string, observedAtMs: number): Promise<void> {
  const line = JSON.stringify({
    timestamp: new Date(observedAtMs).toISOString(),
    type: "event_msg",
    payload: { type: "token_count", info: null, rate_limits: WEEKLY_ONLY_IDLE },
  });
  await writeFile(join(dir, name), `${line}\n`, "utf8");
}
