/**
 * @file src/room/room-readiness-routing.test.ts
 * @exports (test suite — no runtime exports)
 * @depends node:fs/promises, node:os, node:path, execa, vitest, ../chat/agent-readiness, ./room-host
 * @purpose Slice A §A.9 and site 13 — what `@all` means when an agent cannot work.
 *
 *   Today an unaddressed message is rewritten to `@all` and `@all` means the three literal agents, so
 *   with the Antigravity CLI uninstalled EVERY message opens a gemini lane that must fail and the
 *   operator collects a failure row per turn. That is a worse first-run experience than the missing
 *   agent itself.
 *
 *   ⚠ THE RACE IS ASSERTED HERE, NOT ARGUED. The claim is that a submit arriving before the boot probe
 *   dispatches exactly what it dispatches today, because the record starts every agent `unknown` and
 *   `unknown` is not `unusable`. A race written in prose and never run is not established, and that is
 *   the specific class of claim this programme keeps having to retract.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, expect, it } from "vitest";
import type { RoomReadiness } from "../chat/agent-readiness.js";
import { AliveRoomHost, type RoomHostOptions } from "./room-host.js";
import { cleanupTestRoot } from "./room-test-cleanup.fixtures.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => cleanupTestRoot(root)));
});

// FL-175 round 2 F3: same production quiesce deadline (room-host.ts:294, `shutdownTimeoutMs ?? 4_000`)
// that misdiagnosed a failure in room-host-crash-tail.test.ts — this file's 5 `.shutdown()` calls go
// through the same real AliveRoomHost and were found exposed during that fix's required sweep.
// Round-3 F3-b correction: the round-2 fix left these 5 tests on the implicit 30_000 ms global test
// budget, BELOW the 40_000 ms injected deadline — so the injected deadline could never fire; a slow
// quiesce became a generic vitest timeout instead. Reviewer measured 7.9-20 s under pool load. Every
// test below now carries an explicit 90_000 ms outer budget: above SHUTDOWN_TIMEOUT_MS so the injected
// deadline stays reachable, and >=2x the 20 s worst measurement (4.5x).
const SHUTDOWN_TIMEOUT_MS = 40_000;

const READY_BOOT: NonNullable<RoomHostOptions["startEagerSessionBoot"]> = () => ({
  claude: Promise.resolve({ outcome: "ready" }),
  codex: Promise.resolve({ outcome: "ready" }),
  gemini: Promise.resolve({ outcome: "ready" }),
});

const GEMINI_MISSING: RoomReadiness = {
  claude: { state: "ready" },
  codex: { state: "needs_login", command: "codex login" },
  gemini: {
    state: "unusable",
    reason: "the Antigravity CLI is not installed",
    remedy: "install the Antigravity CLI",
  },
};

async function createHost(): Promise<AliveRoomHost> {
  const root = await mkdtemp(path.join(tmpdir(), "readiness-routing-"));
  roots.push(root);
  await execa("git", ["init", "-q"], { cwd: root, shell: false });
  return AliveRoomHost.create({
    repoRoot: root,
    dbPath: path.join(root, ".zer0", "evidence.db"),
    blobRoot: path.join(root, ".zer0", "blobs"),
    startEagerSessionBoot: READY_BOOT,
    runLane: async () => ({ status: "completed", text: "done" }),
    shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
  });
}

it("FALSIFIER: an unusable agent is not dispatched by @all", async () => {
  const host = await createHost();
  try {
    host.agentReadiness().adopt(GEMINI_MISSING);

    const submitted = await host.submit({ requestId: "r1", text: "look at this" });

    // gemini is gone; codex STAYS. That pairing is the ruling, not an accident of the filter: a
    // needs_login lane fails immediately and carries its remedy, which teaches the operator something,
    // while a silent removal teaches them nothing.
    expect(submitted.targets).toEqual(["claude", "codex"]);
  } finally {
    await host.shutdown();
  }
}, 90_000);

it("FALSIFIER: an explicit address to an unusable agent returns the remedy, not a lane", async () => {
  const host = await createHost();
  try {
    host.agentReadiness().adopt(GEMINI_MISSING);

    // They asked for that agent BY NAME. Removing it silently would be the room deciding it knew
    // better; the honest answer names the reason and the fix.
    await expect(host.submit({ requestId: "r2", text: "@gemini look at this" })).rejects.toThrow(
      "install the Antigravity CLI",
    );
  } finally {
    await host.shutdown();
  }
}, 90_000);

it("FALSIFIER: with no agent left, the submit is refused rather than opening an empty turn", async () => {
  const host = await createHost();
  try {
    host.agentReadiness().adopt({
      claude: { state: "unusable", reason: "not resolved", remedy: "npm ci" },
      codex: { state: "unusable", reason: "not resolved", remedy: "npm ci" },
      gemini: { state: "unusable", reason: "not installed", remedy: "install the Antigravity CLI" },
    });

    const refused = await host
      .submit({ requestId: "r3", text: "anyone there" })
      .then(() => undefined)
      .catch((error: unknown) => (error as Error).message);

    // Every one of them, not the first one found: an operator with three broken agents needs three
    // fixes, and a message naming one is a message they will act on once and come back from.
    expect(refused).toContain("claude");
    expect(refused).toContain("codex");
    expect(refused).toContain("gemini");
    expect(refused).toContain("install the Antigravity CLI");
  } finally {
    await host.shutdown();
  }
}, 90_000);

it("FALSIFIER site 13: a submit that beats the probe dispatches all three", async () => {
  const host = await createHost();
  try {
    // The probe has NOT resolved. The record is the one the service is constructed with: every agent
    // `unknown`. This is the first half of the site and the half that matters — it turns "the record
    // starts unknown, so a submit that beats the probe filters nothing" from reasoning into an
    // assertion.
    const first = await host.submit({ requestId: "r4", text: "before the probe lands" });
    expect(first.targets).toEqual(["claude", "codex", "gemini"]);

    // Now the probe lands with gemini unusable, and the NEXT turn opens two lanes.
    host.agentReadiness().adopt(GEMINI_MISSING);
    const second = await host.submit({ requestId: "r5", text: "after the probe lands" });
    expect(second.targets).toEqual(["claude", "codex"]);
  } finally {
    await host.shutdown();
  }
}, 90_000);

it("PIN: the readiness RPC serves the same record the router reads", async () => {
  const host = await createHost();
  try {
    host.agentReadiness().adopt(GEMINI_MISSING);

    // ONE owner, ONE cache. A second copy is how the chip and the router start disagreeing about the
    // same agent — the chip saying "sign in" while `@all` still dispatches, or the reverse.
    const snapshot = host.agentReadiness().snapshot();
    expect(snapshot.version).toBe(1);
    expect(snapshot.agents.gemini).toMatchObject({ state: "unusable" });
    expect(snapshot.agents.codex).toMatchObject({ state: "needs_login", command: "codex login" });

    const submitted = await host.submit({ requestId: "r6", text: "same record" });
    expect(submitted.targets).toEqual(["claude", "codex"]);
  } finally {
    await host.shutdown();
  }
}, 90_000);
