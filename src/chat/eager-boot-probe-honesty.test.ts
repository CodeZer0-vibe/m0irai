/**
 * @file src/chat/eager-boot-probe-honesty.test.ts
 * @exports (test suite — no runtime exports)
 * @depends node:fs, node:os, node:path, vitest, ./eager-session-boot, ./events, ./lane-transport
 * @purpose OPERATOR RULING (2026-07-27): "how about we just say it's online, and if we send a message
 *   and it doesn't go through we say offline, and that's it."
 *
 *   The defect: a `--version` probe that TIMED OUT emitted `auth: "down"`, which the bar words as
 *   "offline" — so the operator saw `◇ gemini offline` and then gemini answered them normally. agy is
 *   documented as slow to start (their trace: 16.6s to first answer, which is normal for it), so the
 *   probe timing out says something true about OUR INSTRUMENT and nothing about the agent. This is the
 *   read-what-is law in words instead of numbers: we knew the probe failed; we did NOT know the agent
 *   was unreachable, and we rendered the stronger claim.
 *
 *   THE MODEL NOW: default is fine. "offline" requires EVIDENCE — a real attempt that did not go
 *   through. A probe verdict never reaches the bar.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startEagerSessionBoot } from "./eager-session-boot.js";
import { ChatEventBus } from "./events.js";
import { initCarrierRuntime, resetCarrierRuntime } from "./lane-transport.js";

/** FL-150: StartEagerSessionBootInput.signal is REQUIRED - the boot path feeds acquireLaneSession, and
 *  a boot with no cancel authority is the shape the required field exists to forbid. Production passes
 *  the room's shutdown signal (room-eager-sessions.ts's `start(bus, signal)`); this suite never aborts
 *  it, and now has to say so. */
const NEVER_CANCELLED: AbortSignal = new AbortController().signal;

// MOCKED AT THE TRUST BOUNDARY (the child process), because the whole point is to drive the case where
// the version probe FAILS — the operator's own case, which cannot be produced on a machine where agy is
// installed and answers. Real path: agent-auth-probe.test.ts covers the classification against the real
// spawn contract. Without this the gemini assertions below pass vacuously on any healthy dev machine.
const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));
vi.mock("execa", () => ({ execa: execaMock }));

const REAL_FORCE_READY = process.env.ZER0_TUI_FORCE_READY;

beforeEach(() => {
  execaMock.mockReset();
  // A hard spawn failure — the shape that classified as `down` and put "offline" on the operator's bar.
  execaMock.mockRejectedValue(new Error("spawn gemini ENOENT"));
  process.env.ZER0_TUI_FORCE_READY = undefined;
});

type StatusEvent = { readonly agent: string; readonly auth?: string };
type LooseBus = { on(kind: string, handler: (event: StatusEvent) => void): void };

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  process.env.ZER0_TUI_FORCE_READY = REAL_FORCE_READY === undefined ? undefined : REAL_FORCE_READY;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "eager-boot-honesty-"));
  dirs.push(dir);
  return dir;
}

/** Runs the REAL boot with no carrier available — the production shape when lanes are off, and the only
 *  one reachable without spawning real agent CLIs. Returns each lane's settled outcome plus every
 *  agent.status the boot put on the bus. */
async function bootOutcomes(): Promise<{
  readonly outcomes: Record<string, string>;
  readonly statuses: readonly StatusEvent[];
}> {
  const bus = new ChatEventBus();
  const statuses: StatusEvent[] = [];
  (bus as LooseBus).on("agent.status", (e) => statuses.push(e));
  const root = tempRoot();
  const boot = startEagerSessionBoot({
    db: undefined as never, // never reached: the carrier gate returns before any db use
    repoRoot: root,
    cwd: root,
    bus,
    signal: NEVER_CANCELLED,
  });
  const settled = await Promise.all([boot.claude, boot.codex, boot.gemini]);
  return {
    outcomes: {
      claude: settled[0].outcome,
      codex: settled[1].outcome,
      gemini: settled[2].outcome,
    },
    statuses,
  };
}

describe("eager boot never claims an agent is unreachable without evidence", () => {
  // THE OPERATOR'S OWN FRAME: `◇ gemini offline` on a gemini that then answered them normally. gemini
  // opens NO session at boot (per-turn process, by vendor design), so there is nothing to be down about
  // — the only honest boot state for it is "fine".
  it("gemini boots ready, whatever a version probe would have said", async () => {
    const { outcomes } = await bootOutcomes();
    expect(outcomes.gemini).toBe("ready");
  });

  it("no lane is announced DOWN at boot", async () => {
    const { statuses } = await bootOutcomes();
    expect(statuses.filter((s) => s.auth === "down")).toEqual([]);
  });

  // OPERATOR-VISIBLE FAILURE: "claude unavailable — carrier lanes are not active this boot" painting
  // claude offline. That is a statement about ZER0'S OWN CONFIGURATION, not about claude — the same
  // class of over-claim as the probe, one branch up. Nothing was attempted, so nothing failed.
  it("a boot with no carrier lanes leaves claude and codex reading fine, not offline", async () => {
    const { outcomes } = await bootOutcomes();
    expect(outcomes.claude).toBe("ready");
    expect(outcomes.codex).toBe("ready");
  });

  // The whole point of the ruling: boot emits nothing that reads as a problem.
  it("boot announces only ready, for all three lanes", async () => {
    const { statuses } = await bootOutcomes();
    expect(statuses.map((s) => `${s.agent}:${String(s.auth)}`).sort()).toEqual([
      "claude:ready",
      "codex:ready",
      "gemini:ready",
    ]);
  });
});

describe("...but REAL evidence still reads offline (no over-correction)", () => {
  // THE MIRROR RISK. Removing the probe's claim must not make the bar incapable of ever saying offline —
  // then a genuinely dead lane would look fine forever, which is the opposite lie. A real session-open
  // FAILURE is a real attempt that did not go through, so it stays evidence: eager-session-boot.ts's
  // catch still emits down with the real reason. Asserted through the SAME production function, with the
  // carrier gate satisfied so the open is genuinely attempted (and fails on the injected db).
  it("a real session-open failure for claude/codex still surfaces as unavailable", async () => {
    const bus = new ChatEventBus();
    const statuses: StatusEvent[] = [];
    (bus as LooseBus).on("agent.status", (e) => statuses.push(e));
    const root = tempRoot();
    // projectId present + carrier lanes ON is what makes eagerOpenAcpAgent actually TRY the open. The
    // connection then rejects — the shape of a genuine session-open failure, which IS a real attempt
    // that did not go through and therefore still earns "offline".
    initCarrierRuntime({
      projectId: "proj-1",
      dbPath: join(root, "lane.db"),
      repoRoot: root,
      cwd: root,
      openConnection: async () => {
        throw new Error("claude bridge refused the connection");
      },
    } as never);
    try {
      const boot = startEagerSessionBoot({
        db: undefined as never,
        projectId: "proj-1",
        repoRoot: root,
        cwd: root,
        bus,
        signal: NEVER_CANCELLED,
      });
      const claude = await boot.claude;
      expect(claude.outcome).toBe("unavailable");
      expect(statuses.some((s) => s.agent === "claude" && s.auth === "down")).toBe(true);
    } finally {
      resetCarrierRuntime();
    }
  });
});
