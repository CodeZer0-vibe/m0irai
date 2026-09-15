/**
 * @file src/room/room-usage-fold.test.ts
 * @purpose FL-094 at the seam that actually ships. Two codex producers reach the room bus by different
 *   routes — emitCodexUsageFromRollout emits agent.status directly (codex-rate-limits.ts:196-204) and
 *   the ACP path emits its own (usage-reporter.ts:96) — and a status carrying ANY usage object replaces
 *   the prior one WHOLESALE in the Rust reducer (reducer.rs:668, deliberate and pinned). So a ctx-only
 *   ACP update erased a weekly the rollout had just established. These pin the room-owned wire snapshot
 *   fold that makes every outgoing status carry every window the room still knows about.
 * @exports (test suite - no runtime exports)
 * @depends vitest, ../chat/codex-rate-limits, ../chat/events, ../chat/usage-reporter, ./room-host-support, ./room-usage-fold
 */
import { expect, it } from "vitest";
import { emitCodexUsageFromRollout } from "../chat/codex-rate-limits.js";
import type { CodexRateLimits } from "../chat/codex-usage-decode.js";
import type { ChatEventBus } from "../chat/events.js";
import { createUsageReporter } from "../chat/usage-reporter.js";
import { createRoomBus } from "./room-host-support.js";
import { RoomUsageFold } from "./room-usage-fold.js";

type WirePayload = Readonly<Record<string, unknown>>;
type WireUsage = {
  readonly exhausted?: boolean;
  readonly contextUsedPct?: number;
  readonly fiveHourUsedPct?: number;
  readonly fiveHourResetsAtMs?: number;
  readonly weeklyUsedPct?: number;
  readonly weeklyResetsAtMs?: number;
};

const HOUR_MS = 3_600_000;

it("FALSIFIER F1a: a ctx-only ACP update does not erase the weekly the rollout established", async () => {
  const { bus, snapshots } = roomBus();

  // Producer 1, the rollout path — the only source codex has for a weekly window.
  await emitCodexUsageFromRollout(bus, {
    readNewestRateLimits: async () => weeklyOnly(71),
  });
  // Producer 2, the ACP path — the shape the operator's own trace showed arriving mid-turn: context and
  // nothing else. Before the fold this reached the wire as a COMPLETE usage object with no weekly in it,
  // and reducer.rs:668 replaced the whole prior object with it.
  createUsageReporter({
    agent: "codex",
    bus,
    cwd: "C:/repo",
    startedMs: Date.now(),
    turn: 1,
  }).recordAcpSessionUpdate({ sessionUpdate: "usage_update", used: 9, size: 100 });

  expect(snapshots).toHaveLength(2);
  expect(usageOf(snapshots[0])).toMatchObject({ weeklyUsedPct: 71 });
  // THE DEFECT. The second wire snapshot is the one the reducer keeps.
  expect(usageOf(snapshots[1])).toMatchObject({ contextUsedPct: 9, weeklyUsedPct: 71 });
});

it("FALSIFIER F1a-b: the reverse order holds too — a rollout weekly does not erase the ACP context", async () => {
  const { bus, snapshots } = roomBus();

  createUsageReporter({
    agent: "codex",
    bus,
    cwd: "C:/repo",
    startedMs: Date.now(),
    turn: 1,
  }).recordAcpSessionUpdate({ sessionUpdate: "usage_update", used: 9, size: 100 });
  await emitCodexUsageFromRollout(bus, {
    readNewestRateLimits: async () => weeklyOnly(71),
    quotaOnly: true,
  });

  // quotaOnly DROPS the rollout's own token counts on purpose (a prior conversation's context is not
  // this session's), so without the fold this snapshot carries a weekly and no ctx at all.
  expect(usageOf(snapshots[1])).toMatchObject({ contextUsedPct: 9, weeklyUsedPct: 71 });
});

it("FALSIFIER F1a-c: the fold is KEYED — codex's weekly never appears on claude's wire snapshot", async () => {
  const { bus, snapshots } = roomBus();

  await emitCodexUsageFromRollout(bus, { readNewestRateLimits: async () => weeklyOnly(71) });
  createUsageReporter({
    agent: "claude",
    bus,
    cwd: "C:/repo",
    startedMs: Date.now(),
    turn: 1,
  }).recordAcpSessionUpdate({ sessionUpdate: "usage_update", used: 9, size: 100 });

  // A process-global fold (the shape claude-usage-fold.ts uses today) would hand codex's window to
  // claude here and paint a meter on an account that never reported one.
  expect(snapshots[1]).toMatchObject({ agent: "claude" });
  expect(usageOf(snapshots[1])).toEqual({ exhausted: false, contextUsedPct: 9 });
});

it("FALSIFIER F7b: an expired window is never PUBLISHED, not merely hidden at render", () => {
  const fold = new RoomUsageFold();
  const now = 1_800_000_000_000;

  fold.fold(
    "codex",
    { label: "71%", exhausted: false, weeklyUsedPct: 71, weeklyResetsAtMs: now - HOUR_MS },
    now,
  );
  const second = fold.fold("codex", { label: "ctx", exhausted: false, contextUsedPct: 9 }, now);

  // The reset has already passed, so the room no longer knows anything current about that window. It
  // must not be carried forward — an inherited 71% would outlive the window it describes.
  expect(second).toEqual({ label: "ctx", exhausted: false, contextUsedPct: 9 });
});

it("PIN: a status that carries no usage object at all passes through untouched", () => {
  const { bus, snapshots } = roomBus();

  bus.emit({ kind: "agent.status", agent: "codex", auth: "ready" });

  // reducer.rs:668 inherits the prior usage when a status carries none. Attaching one here would break
  // that path — and would resurrect the boot meters P1 removes, since eager boot emits auth-only.
  expect(snapshots[0]).toEqual({ agent: "codex", auth: "ready" });
});

it("FALSIFIER: a fresh fold knows nothing — no room inherits another room's numbers", () => {
  const first = new RoomUsageFold();
  const now = 1_800_000_000_000;
  first.fold(
    "codex",
    { label: "71%", exhausted: false, weeklyUsedPct: 71, weeklyResetsAtMs: now + HOUR_MS },
    now,
  );

  const second = new RoomUsageFold();
  expect(second.fold("codex", { label: "ctx", exhausted: false, contextUsedPct: 9 }, now)).toEqual({
    label: "ctx",
    exhausted: false,
    contextUsedPct: 9,
  });
});

it("FALSIFIER: a reset with no percentage is carried WITHOUT inventing one", () => {
  const fold = new RoomUsageFold();
  const now = 1_800_000_000_000;

  // OPERATOR-OBSERVED, 11:38 Aug 19: a window can arrive carrying its reset and no utilization at all.
  const first = fold.fold(
    "claude",
    { label: "ctx", exhausted: false, fiveHourResetsAtMs: now + HOUR_MS },
    now,
  );
  const second = fold.fold("claude", { label: "ctx", exhausted: false, contextUsedPct: 3 }, now);

  expect(first).toEqual({ label: "ctx", exhausted: false, fiveHourResetsAtMs: now + HOUR_MS });
  // A defaulted 0 here would be a fabricated reading, and the operator has twice confirmed a zero they
  // saw was REAL data — so a zero this code invented is indistinguishable from one an account reported.
  expect(second).toEqual({
    label: "ctx",
    exhausted: false,
    contextUsedPct: 3,
    fiveHourResetsAtMs: now + HOUR_MS,
  });
  expect(Object.keys(second)).not.toContain("fiveHourUsedPct");
});

it("FALSIFIER: a ROLLED window starts unmeasured — the old percentage is not inherited", () => {
  const fold = new RoomUsageFold();
  const now = 1_800_000_000_000;

  fold.fold(
    "codex",
    { label: "71%", exhausted: false, weeklyUsedPct: 71, weeklyResetsAtMs: now + HOUR_MS },
    now,
  );
  // A different reset instant, far outside mergeRateWindows' 60-second tolerance: a NEW weekly period.
  const rolled = fold.fold(
    "codex",
    { label: "ctx", exhausted: false, weeklyResetsAtMs: now + 200 * HOUR_MS },
    now,
  );

  expect(rolled).toEqual({
    label: "ctx",
    exhausted: false,
    weeklyResetsAtMs: now + 200 * HOUR_MS,
  });
});

it("FALSIFIER: the SAME window reported a second later keeps its learned percentage", () => {
  const fold = new RoomUsageFold();
  const now = 1_800_000_000_000;

  fold.fold(
    "codex",
    { label: "71%", exhausted: false, weeklyUsedPct: 71, weeklyResetsAtMs: now + HOUR_MS },
    now,
  );
  // The two sources round the same reset about a second apart in live captures (rate-window-merge.ts:7).
  const again = fold.fold(
    "codex",
    { label: "ctx", exhausted: false, weeklyResetsAtMs: now + HOUR_MS + 1_000 },
    now,
  );

  expect(again).toMatchObject({ weeklyUsedPct: 71 });
});

it("FALSIFIER: a ctx-only update cannot CLEAR an exhaustion verdict, and expiry can", () => {
  const fold = new RoomUsageFold();
  const now = 1_800_000_000_000;

  fold.fold(
    "codex",
    { label: "100%", exhausted: true, weeklyUsedPct: 100, weeklyResetsAtMs: now + HOUR_MS },
    now,
  );
  // exhausted:false on a ctx-only update is the ABSENCE of a claim — acpUsageToStatus returns it
  // unconditionally for any update with no rate windows — so believing it would clear a real verdict.
  expect(
    fold.fold("codex", { label: "ctx", exhausted: false, contextUsedPct: 9 }, now),
  ).toMatchObject({ exhausted: true, weeklyUsedPct: 100 });

  // Once the window's own reset has passed, the verdict dies with it. This is not cosmetic:
  // reducer.rs:669-673 promotes auth Ready to Limited off exhausted, so a stale true words a working
  // agent as limited.
  expect(
    fold.fold("codex", { label: "ctx", exhausted: false, contextUsedPct: 9 }, now + 2 * HOUR_MS),
  ).toEqual({ label: "ctx", exhausted: false, contextUsedPct: 9 });
});

it("FALSIFIER: an UNQUANTIFIED verdict survives a ctx-only update", () => {
  const fold = new RoomUsageFold();
  const now = 1_800_000_000_000;

  // The shape acpUsageLabel produces from a window whose status is "rejected" with no utilization
  // (statusline-payload.ts:137-149): exhausted with no number to re-derive it from. Written as its own
  // case because the 100%-weekly version above is rescued by the >=100 re-OR and therefore CANNOT see
  // whether the incoming exhausted:false was believed — it passed under exactly that mutation.
  fold.fold("claude", { label: "ctx", exhausted: true, fiveHourResetsAtMs: now + HOUR_MS }, now);

  expect(fold.fold("claude", { label: "ctx", exhausted: false, contextUsedPct: 3 }, now)).toEqual({
    label: "ctx",
    exhausted: true,
    contextUsedPct: 3,
    fiveHourResetsAtMs: now + HOUR_MS,
  });
});

it("FALSIFIER: a fresh window that DOES report itself is believed over the inherited verdict", () => {
  const fold = new RoomUsageFold();
  const now = 1_800_000_000_000;

  fold.fold(
    "codex",
    { label: "100%", exhausted: true, weeklyUsedPct: 100, weeklyResetsAtMs: now + HOUR_MS },
    now,
  );
  // Same window, now reporting 40%: the account recovered capacity and said so. Inheriting "exhausted"
  // past a reading that contradicts it would be the mirror defect — a sticky red on a healthy lane.
  expect(
    fold.fold(
      "codex",
      { label: "40%", exhausted: false, weeklyUsedPct: 40, weeklyResetsAtMs: now + HOUR_MS },
      now,
    ),
  ).toMatchObject({ exhausted: false, weeklyUsedPct: 40 });
});

it("FALSIFIER: a recovered room is seeded from its journal, not from the next partial update", () => {
  const fold = new RoomUsageFold();
  const now = 1_800_000_000_000;

  fold.seed(
    [
      { type: "message.appended", payload: { text: "irrelevant" } },
      {
        type: "agent.status",
        payload: {
          agent: "codex",
          usage: { exhausted: false, weeklyUsedPct: 71, weeklyResetsAtMs: now + HOUR_MS },
        },
      },
      { type: "agent.status", payload: { agent: "codex", auth: "ready" } },
    ],
    now,
  );

  expect(
    fold.fold("codex", { label: "ctx", exhausted: false, contextUsedPct: 9 }, now),
  ).toMatchObject({ contextUsedPct: 9, weeklyUsedPct: 71 });
});

it("FALSIFIER: a malformed journal line costs that reading and nothing else", () => {
  const fold = new RoomUsageFold();
  const now = 1_800_000_000_000;

  fold.seed(
    [
      { type: "agent.status", payload: { agent: "codex", usage: { weeklyUsedPct: "71%" } } },
      { type: "agent.status", payload: { agent: "nobody", usage: { weeklyUsedPct: 55 } } },
      { type: "agent.status", payload: null },
      {
        type: "agent.status",
        payload: {
          agent: "codex",
          usage: { exhausted: false, weeklyUsedPct: 71, weeklyResetsAtMs: now + HOUR_MS },
        },
      },
    ],
    now,
  );

  expect(
    fold.fold("codex", { label: "ctx", exhausted: false, contextUsedPct: 9 }, now),
  ).toMatchObject({ contextUsedPct: 9, weeklyUsedPct: 71 });
});

it("PIN: an inherited reset keeps its exact millisecond value, not a truncated second", () => {
  const fold = new RoomUsageFold();
  const now = 1_800_000_000_000;
  const oddMs = now + HOUR_MS + 678;

  fold.fold(
    "codex",
    { label: "71%", exhausted: false, weeklyUsedPct: 71, weeklyResetsAtMs: oddMs },
    now,
  );
  const inherited = fold.fold("codex", { label: "ctx", exhausted: false, contextUsedPct: 9 }, now);

  // mergeRateWindows has to be handed SECONDS for its 60s same-window tolerance to mean anything, so a
  // naive round-trip would hand the wire a reset silently moved by up to a second.
  expect(inherited).toMatchObject({ weeklyResetsAtMs: oddMs });
});

function roomBus(): { readonly bus: ChatEventBus; readonly snapshots: readonly WirePayload[] } {
  const snapshots: WirePayload[] = [];
  const bus = createRoomBus({
    turnId: "turn-1",
    isShuttingDown: () => false,
    notify: (_turnId, _type, payload) => snapshots.push(payload),
    notice: () => undefined,
    onMode: () => undefined,
    usageFold: new RoomUsageFold(),
  });
  return { bus, snapshots };
}

function usageOf(payload: WirePayload | undefined): WireUsage | undefined {
  return payload?.usage as WireUsage | undefined;
}

/** codex's real weekly shape: window_minutes states the duration, `secondary` position carries it on a
 *  plus plan, and there is no 5h window at all — OpenAI removed it (codex-usage-decode.ts header). */
function weeklyOnly(usedPercent: number): CodexRateLimits {
  return {
    secondary: {
      used_percent: usedPercent,
      window_minutes: 10_080,
      resets_at: Math.floor((Date.now() + 48 * HOUR_MS) / 1000),
    },
  };
}
