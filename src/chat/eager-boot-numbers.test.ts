/**
 * @file src/chat/eager-boot-numbers.test.ts
 * @exports (test suite — no runtime exports)
 * @depends node:fs, node:os, node:path, vitest, ./codex-usage-captures.fixtures, ./events,
 *   ./eager-session-boot, ./lane-transport
 * @purpose F2 — BOOT PUBLISHES NO METERS, for any agent. This file used to pin the opposite: the
 *   operator had said "the quota should appear like a common thing", and boot read codex's newest
 *   rollout so a number was on screen before they typed. The locked display policy reverses that. The
 *   boot screen is name and mode; numbers arrive after the first message.
 *
 *   THREE ABSENCE PATHS, because there were three ways a number could reach the boot bar and only one
 *   of them was obvious: (a) the rollout prefetch, (b) the ACP usage tap, which decoded whatever the
 *   bridge volunteered while getting ready, and (c) gemini, which never had a pre-turn source at all.
 *   Removing (a) alone would have left boot meters alive on the path nobody was looking at.
 *
 *   WHAT THIS COST, NAMED RATHER THAN BURIED: the spent-codex `auth:"limited"` boot signal goes with
 *   the numbers. It was account-level truth the rollout genuinely knew. Wave spec §14 Q10 asks the
 *   operator whether to keep it as an auth-only publish; it is UNRULED at the time of writing, and this
 *   file is built to branch (a), accept the loss. The swap to (b) is one publish site and one test.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../evidence/db.js";
import {
  BOTH_WINDOWS,
  WEEKLY_ONLY_97,
  WEEKLY_ONLY_SPENT,
} from "./codex-usage-captures.fixtures.js";
import type { CodexRateLimits } from "./codex-usage-decode.js";
import { startEagerSessionBoot } from "./eager-session-boot.js";
import { type AgentStatusUpdateEvent, ChatEventBus } from "./events.js";
import { initCarrierRuntime, resetCarrierRuntime } from "./lane-transport.js";

/** FL-150: StartEagerSessionBootInput.signal is REQUIRED - the boot path feeds acquireLaneSession, and
 *  a boot with no cancel authority is the shape the required field exists to forbid. Production passes
 *  the room's shutdown signal (room-eager-sessions.ts's `start(bus, signal)`); this suite never aborts
 *  it, and now has to say so. */
const NEVER_CANCELLED: AbortSignal = new AbortController().signal;

/**
 * A SPY, not a fake: the real getOrCreateLaneTransport still runs and still builds the real transport.
 * All this captures is the hooks argument boot passes it — which is the whole mechanism of path (b),
 * because that argument is where bootUsageTap used to be installed.
 *
 * Why at this seam and not end to end. A volunteered `usage_update` reaches the tap only through the
 * REAL bridge chain (openAcpLaneConnection wires onSessionUpdate into the live connection at
 * acp-lane-connection.ts:120). The injected `openConnection` seam every other test in this tree uses
 * receives {agent, cwd, onText, decide, signal} and has no channel to volunteer a session update at
 * all (lane-hold.ts:51-58), so an injected connection CANNOT reproduce path (b). Driving the captured
 * hook with a real update shape is the closest honest proof available without a claude ACP child.
 */
const transportCalls: { readonly agent: string; readonly hooks: unknown }[] = [];
vi.mock("./lane-transport.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lane-transport.js")>();
  return {
    ...actual,
    getOrCreateLaneTransport: (agent: "claude" | "codex", hooks?: unknown) => {
      transportCalls.push({ agent, hooks });
      return actual.getOrCreateLaneTransport(agent, hooks as never);
    },
  };
});

const FAKE_DB = {} as Db;
const dirs: string[] = [];
const savedCodexHome = process.env.CODEX_HOME;

afterEach(() => {
  transportCalls.splice(0);
  resetCarrierRuntime();
  if (savedCodexHome === undefined) Reflect.deleteProperty(process.env, "CODEX_HOME");
  else process.env.CODEX_HOME = savedCodexHome;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An EMPTY CODEX_HOME, so a test asserting "nothing is read" cannot accidentally read the developer's
 *  own rollouts and pass (or fail) for a reason that has nothing to do with the code. */
function isolatedCodexHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "eager-boot-numbers-"));
  dirs.push(home);
  process.env.CODEX_HOME = home;
  return home;
}

// A rollout the codex CLI could have written in a PREVIOUS conversation — which is the only kind that
// can exist at boot. `info` carries that conversation's token counts on purpose.
function writePriorRollout(home: string, rateLimits: CodexRateLimits): void {
  const sessionsDir = path.join(home, "sessions", "2026", "07", "31");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    path.join(sessionsDir, "rollout-2026-07-31T09-45-51-prior-session.jsonl"),
    `${JSON.stringify({
      timestamp: "2026-07-31T09:45:51.385Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { total_tokens: 120_000 }, model_context_window: 258_400 },
        rate_limits: rateLimits,
      },
    })}\n`,
    "utf8",
  );
}

/**
 * Boots and then WAITS for a window in which a number could have shown up. Every assertion in this file
 * is now an absence, so the wait is the fixed 500 ms one the old file used for its negative cases —
 * generous next to the rollout read it is waiting out, which finished in single-digit milliseconds even
 * under load. The old positive path polled up to 10 s for an ARRIVAL; keeping it would have made three
 * tests sit for their full deadline waiting for something that is never coming.
 */
async function bootAndCollect(): Promise<AgentStatusUpdateEvent[]> {
  const bus = new ChatEventBus();
  const statuses: AgentStatusUpdateEvent[] = [];
  bus.on("agent.status", (event) => statuses.push(event));
  const payloads: unknown[] = [];
  bus.on("usage.payload", (event) => payloads.push(event));
  const boot = startEagerSessionBoot({
    db: FAKE_DB,
    repoRoot: "C:/repo",
    cwd: "C:/repo",
    bus,
    signal: NEVER_CANCELLED,
  });
  await Promise.all([boot.claude, boot.codex, boot.gemini]);
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(payloads, "boot put diagnostic noise on the quiet screen").toEqual([]);
  return statuses;
}

const withUsage = (events: readonly AgentStatusUpdateEvent[]): AgentStatusUpdateEvent[] =>
  events.filter((event) => event.usage !== undefined);

const authsFor = (
  events: readonly AgentStatusUpdateEvent[],
  agent: string,
): (string | undefined)[] =>
  events.filter((event) => event.agent === agent).map((event) => event.auth);

describe("F2(a): the rollout prefetch is gone — a rollout on disk buys nothing at boot", () => {
  /**
   * DELIBERATE PIN CHANGE. The old assertion here was
   *   expect(usage?.fiveHourUsedPct, "codex's 5h window never reached the boot bar").toBeDefined();
   * and run against this code it fails with:
   *   AssertionError: codex's 5h window never reached the boot bar: expected undefined to be defined
   * That was RA-3's whole point — a number before the first message. The locked policy removes it, so
   * the assertion inverts: a rollout that IS on disk, carrying both windows, must buy nothing.
   */
  it("reads nothing from an existing rollout — no prefetch, no windows, no auth claim", async () => {
    const home = isolatedCodexHome();
    writePriorRollout(home, BOTH_WINDOWS);

    const statuses = await bootAndCollect();

    expect(withUsage(statuses), "the boot prefetch is still reading rollouts").toEqual([]);
    // The whole status, not just its usage: an auth verdict derived from a rollout window is the same
    // reading wearing a different field, and the boot screen may not carry it either.
    expect(authsFor(statuses, "codex")).toEqual(["ready"]);
  });

  /**
   * DELIBERATE PIN CHANGE, and this one PASSED against the new code for the wrong reason — which is why
   * it could not be left alone. The old assertion was
   *   expect(usage?.contextUsedPct, "a previous conversation's ctx% was shown as this one's").toBe(undefined);
   * reading `usage` off a `.find(...)` that now returns undefined, so `undefined?.contextUsedPct` is
   * undefined and it passes without observing anything at all. A test that goes green because its
   * subject vanished is not a pin, it is a green light with nothing behind it.
   */
  it("does not carry a prior conversation's context reading — because it publishes nothing", async () => {
    const home = isolatedCodexHome();
    writePriorRollout(home, BOTH_WINDOWS);

    const statuses = await bootAndCollect();

    // Asserted on the STATUS LIST rather than through an optional chain, so it cannot pass vacuously.
    expect(withUsage(statuses)).toEqual([]);
    expect(statuses.every((event) => event.usage?.contextUsedPct === undefined)).toBe(true);
  });
});

describe("F2(b): the ACP usage tap is gone — boot installs no update hook", () => {
  it("opens claude and codex transports with NO onSessionUpdate hook", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "eager-boot-tap-"));
    dirs.push(root);
    isolatedCodexHome();
    const bus = new ChatEventBus();
    const statuses: AgentStatusUpdateEvent[] = [];
    bus.on("agent.status", (event) => statuses.push(event));
    // projectId present + carrier lanes on is what makes eagerOpenAcpAgent actually reach
    // getOrCreateLaneTransport. The connection then rejects, which is fine: the transport is created
    // BEFORE the session is acquired, so the hooks argument is already captured by then.
    initCarrierRuntime({
      projectId: "proj-1",
      dbPath: path.join(root, "lane.db"),
      repoRoot: root,
      cwd: root,
      openConnection: async () => {
        throw new Error("bridge refused the connection");
      },
    } as never);
    const boot = startEagerSessionBoot({
      db: FAKE_DB,
      projectId: "proj-1",
      repoRoot: root,
      cwd: root,
      bus,
      signal: NEVER_CANCELLED,
    });
    await Promise.all([boot.claude, boot.codex, boot.gemini]);

    expect(transportCalls.map((call) => call.agent).sort()).toEqual(["claude", "codex"]);
    for (const call of transportCalls) {
      const hook = (call.hooks as { onSessionUpdate?: unknown } | undefined)?.onSessionUpdate;
      // If a hook IS installed, driving it with the exact shape claude's bridge volunteers must still
      // publish nothing. Asserting only "hooks is undefined" would go green against a hook that exists
      // and happens to be harmless today — this asserts the consequence as well as the shape.
      if (typeof hook === "function") {
        (hook as (update: unknown) => void)({
          sessionUpdate: "usage_update",
          used: 40,
          size: 100,
        });
      }
      expect(hook, `${call.agent} still installs a boot usage tap`).toBeUndefined();
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(withUsage(statuses), "a volunteered ACP update reached the boot bar").toEqual([]);
  });
});

describe("F2: what boot no longer claims, and what it never could", () => {
  /**
   * DELIBERATE PIN CHANGE — AND THE ONE THE OPERATOR IS OWED A DECISION ON. The old assertion was
   *   expect(spent[0]?.auth).toBe("limited");
   * and run against this code it fails with:
   *   AssertionError: expected undefined to be 'limited'
   * That signal was real: a genuinely spent weekly window is account-level truth the rollout knows
   * without opening anything, and codex-rate-limits.ts:208-210 deliberately allowed the prefetch to say
   * exactly that one thing. "BOOT = NO METERS" takes it away along with the numbers. Wave spec §14 Q10
   * is where the operator decides whether to keep it as an auth-only publish; UNRULED at the time of
   * writing, so branch (a) — accept the loss — is what is built and what is pinned here.
   */
  it("no longer reports a genuinely spent codex window at boot (Q10 branch (a), unruled)", async () => {
    const spentHome = isolatedCodexHome();
    writePriorRollout(spentHome, WEEKLY_ONLY_SPENT);

    const spent = await bootAndCollect();

    expect(authsFor(spent, "codex")).toEqual(["ready"]);
    expect(withUsage(spent)).toEqual([]);
  });

  // The other half of the same claim, and the half that makes it bite: a spent account and a healthy
  // one must be INDISTINGUISHABLE at boot now. Asserting only the spent case would pass against an
  // implementation that still reported a window and happened to word it "ready".
  it("and a healthy codex account is indistinguishable from the spent one at boot", async () => {
    const healthyHome = isolatedCodexHome();
    writePriorRollout(healthyHome, WEEKLY_ONLY_97);

    const healthy = await bootAndCollect();

    expect(authsFor(healthy, "codex")).toEqual(["ready"]);
    expect(withUsage(healthy)).toEqual([]);
  });
});

describe("F2: the two controls, which were already true and must stay true", () => {
  // SURVIVES UNCHANGED from the pre-policy file, and is the one assertion here that always meant the
  // same thing: absence must be quiet. It was true when boot read rollouts and it is true now.
  it("a fresh install with no rollout at all shows nothing, quietly", async () => {
    isolatedCodexHome();

    const statuses = await bootAndCollect();

    expect(
      statuses.filter((event) => event.usage !== undefined),
      "something was invented for a lane with no source",
    ).toEqual([]);
  });

  // F2(c). gemini/agy has NO source that does not require a turn (agy-statusline-payload.ts), so its
  // boot silence needs no removal — it is the state the other two have now been brought down to. Kept
  // because it is the control: if this one ever goes red, something started manufacturing numbers.
  it("gemini reports no usage at boot", async () => {
    isolatedCodexHome();

    const statuses = await bootAndCollect();

    expect(statuses.filter((e) => e.agent === "gemini" && e.usage !== undefined)).toEqual([]);
  });
});
