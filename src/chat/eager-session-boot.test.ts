/**
 * @file src/chat/eager-session-boot.test.ts
 * @purpose W4-R REFIT R1 falsifiers for startEagerSessionBoot. THE BRIEF'S OWN RED: "kill one engine's
 *   binary path in a test -> boot completes, other two reach ready, dead one reads unavailable with
 *   reason." Uses the REAL ChatEventBus (not a stub) as a regression guard: "connecting" must NEVER
 *   reach a bus emit (event-schemas.ts's AgentStatusUpdateSchema.auth enum is ready|limited|down only —
 *   a real bus would THROW on an invalid value, catching any accidental leak immediately).
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./events, ./eager-session-boot
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../evidence/db.js";
import { ChatEventBus } from "./events.js";

const FAKE_DB = {} as Db;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("./lane-transport.js");
  vi.doUnmock("./lane-acquire.js");
  vi.doUnmock("../adapters/acp/acp-servers.js");
});

function mockLaneTransport(lanesEnabled: boolean): void {
  vi.doMock("./lane-transport.js", () => ({
    carrierRuntime: () => (lanesEnabled ? { lanesEnabled: true } : undefined),
    getOrCreateLaneTransport: () => ({ start: vi.fn(), send: vi.fn() }),
  }));
}

type AcquireBehavior = (agent: "claude" | "codex") => Promise<{
  sessionId: string;
  generation: number;
  fresh: boolean;
  modeApplied?: { outcome: "applied" | "failed"; modeId: string; reason?: string };
  availableModeIds?: readonly string[];
}>;

// W4-R2c: acquireLaneSession moved to lane-acquire.ts when lane-carrier.ts crossed the 600-line hard
// gate. The mock follows the SOURCE module, never the re-export — eager-session-boot imports it from
// lane-acquire directly, so mocking lane-carrier would silently no-op (which is exactly what this suite
// caught the moment the split landed). LaneAcquireSupersededError is a VALUE the module under test
// `instanceof`-checks, so the mock must carry the real class, not a stand-in.
function mockLaneCarrier(behavior: AcquireBehavior): {
  readonly acquireLaneSession: ReturnType<typeof vi.fn>;
} {
  const acquireLaneSession = vi.fn((input: { agent: "claude" | "codex" }) => behavior(input.agent));
  vi.doMock("./lane-acquire.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./lane-acquire.js")>()),
    acquireLaneSession,
  }));
  return { acquireLaneSession };
}

function mockAcpServers(): void {
  vi.doMock("../adapters/acp/acp-servers.js", () => ({
    resolveAcpSpec: (agent: string) => ({
      binding: { adapterPkg: `pkg-${agent}`, adapterVersion: "1" },
    }),
  }));
}

/** FL-150: StartEagerSessionBootInput.signal is REQUIRED — the boot path feeds acquireLaneSession, and
 *  a boot that could not be aborted is exactly what the required field forbids. In production this is
 *  the room's own shutdown signal (room-eager-sessions.ts's `start(bus, signal)`); these tests never
 *  abort it, and now have to say so. */
const NEVER_CANCELLED: AbortSignal = new AbortController().signal;

function bootInput(bus: ChatEventBus) {
  return {
    db: FAKE_DB,
    projectId: "p1",
    repoRoot: "C:/repo",
    cwd: "C:/repo",
    bus,
    signal: NEVER_CANCELLED,
  };
}

describe("startEagerSessionBoot: THE BRIEF'S OWN RED — a healthy boot, all 3 reach ready", () => {
  it("claude, codex, AND gemini all resolve 'ready' on a healthy machine", async () => {
    mockLaneTransport(true);
    mockAcpServers();
    mockLaneCarrier(async (agent) => ({
      sessionId: `s-${agent}`,
      generation: 1,
      fresh: true,
      modeApplied: { outcome: "applied", modeId: "careful" },
    }));
    const { startEagerSessionBoot } = await import("./eager-session-boot.js");
    const bus = new ChatEventBus();

    const result = startEagerSessionBoot(bootInput(bus));
    await expect(result.claude).resolves.toMatchObject({
      outcome: "ready",
      modeApplied: { outcome: "applied", modeId: "careful" },
    });
    await expect(result.codex).resolves.toMatchObject({
      outcome: "ready",
      modeApplied: { outcome: "applied", modeId: "careful" },
    });
    await expect(result.gemini).resolves.toEqual({ outcome: "ready" });
  });
});

describe("startEagerSessionBoot: THE BRIEF'S OWN RED — one engine's binary path killed", () => {
  it("boot completes, the other two reach ready, the dead one reads unavailable WITH a reason", async () => {
    mockLaneTransport(true);
    mockAcpServers();
    mockLaneCarrier(async (agent) => {
      if (agent === "codex") throw new Error("spawn codex.exe ENOENT");
      return {
        sessionId: `s-${agent}`,
        generation: 1,
        fresh: true,
        modeApplied: { outcome: "applied", modeId: "careful" },
      };
    });
    const { startEagerSessionBoot } = await import("./eager-session-boot.js");
    const bus = new ChatEventBus();

    const result = startEagerSessionBoot(bootInput(bus));
    await expect(result.claude).resolves.toMatchObject({ outcome: "ready" });
    await expect(result.gemini).resolves.toMatchObject({ outcome: "ready" });
    await expect(result.codex).resolves.toEqual({
      outcome: "unavailable",
      reason: expect.stringContaining("ENOENT"),
    });
  });
});

describe("startEagerSessionBoot: the lanesEnabled gate — mirrors headless-turn.ts's usesCarrier exactly", () => {
  // OUTCOME RE-POINTED, GUARANTEE UNCHANGED (operator ruling 2026-07-27: "we just say it's online, and
  // if we send a message and it doesn't go through we say offline"). The valuable half of these two —
  // the open is NOT attempted when the per-turn path could not use it either — is asserted exactly as
  // before. What changed is the CLAIM: "unavailable — carrier lanes are not active this boot" is a fact
  // about ZER0'S OWN CONFIGURATION, and applyEagerOutcome painted it auth:"down", which the bar words as
  // "offline". Nothing was attempted here, so nothing failed and claude is very likely fine.
  it("lanesEnabled !== true: claude/codex resolve READY without ever attempting acquireLaneSession", async () => {
    mockLaneTransport(false); // carrier off, or a windowed/conflict boot
    mockAcpServers();
    const { acquireLaneSession } = mockLaneCarrier(async (agent) => ({
      sessionId: `s-${agent}`,
      generation: 1,
      fresh: true,
    }));
    const { startEagerSessionBoot } = await import("./eager-session-boot.js");
    const bus = new ChatEventBus();

    const result = startEagerSessionBoot(bootInput(bus));
    await expect(result.claude).resolves.toEqual({ outcome: "ready" });
    await expect(result.codex).resolves.toMatchObject({ outcome: "ready" });
    expect(acquireLaneSession).not.toHaveBeenCalled(); // the per-turn path ALSO would not use this mechanism here
    await expect(result.gemini).resolves.toEqual({ outcome: "ready" }); // gemini is unaffected — no lane dependency
  });

  it("an undefined projectId (unscoped folder) is the SAME 'no scoped carrier' case — claude/codex skip the open, all three read fine", async () => {
    mockLaneTransport(true); // lanesEnabled true, but no scoped project this boot
    mockAcpServers();
    const { acquireLaneSession } = mockLaneCarrier(async (agent) => ({
      sessionId: `s-${agent}`,
      generation: 1,
      fresh: true,
    }));
    const { startEagerSessionBoot } = await import("./eager-session-boot.js");
    const bus = new ChatEventBus();

    // exactOptionalPropertyTypes: OMIT projectId entirely (not `projectId: undefined`) — mirrors the
    // real call site (chat-tui-mount.ts's own conditional spread when resolveMountExtras found no scope).
    const { projectId: _unused, ...noProjectId } = bootInput(bus);
    const result = startEagerSessionBoot(noProjectId);
    await expect(result.claude).resolves.toMatchObject({ outcome: "ready" });
    expect(acquireLaneSession).not.toHaveBeenCalled();
    await expect(result.gemini).resolves.toEqual({ outcome: "ready" });
  });
});

// DESIGNED BEHAVIOUR (operator ruling 2026-07-27): gemini opens NOTHING at boot, so there is no honest
// boot state for it other than "fine". The former `--version` auth probe — a TUI-era module, removed with
// the TUI (m0irai 3.3) — is not consulted: the boot module imports no probe at all, so nothing can delay
// boot on an agy spawn (the agy operating truths forbid blocking anything operator-visible on one). The
// evidence that CAN make gemini offline is a real send that did not go through — covered in
// eager-boot-probe-honesty.test.ts alongside the no-over-correction case.
describe("startEagerSessionBoot: gemini's leg opens nothing, so it reports fine", () => {
  it("resolves gemini ready without consulting any auth probe", async () => {
    mockLaneTransport(true);
    mockAcpServers();
    mockLaneCarrier(async (agent) => ({ sessionId: `s-${agent}`, generation: 1, fresh: true }));
    const { startEagerSessionBoot } = await import("./eager-session-boot.js");
    const bus = new ChatEventBus();

    const result = startEagerSessionBoot(bootInput(bus));
    await expect(result.gemini).resolves.toEqual({ outcome: "ready" });
  });
});

describe("startEagerSessionBoot: non-blocking by construction", () => {
  it("returns immediately without waiting for ANY leg to settle — never awaits its own promises internally", async () => {
    mockLaneTransport(true);
    mockAcpServers();
    let releaseClaude: (() => void) | undefined;
    mockLaneCarrier(
      (agent) =>
        new Promise((resolve) => {
          if (agent === "claude") {
            releaseClaude = () =>
              resolve({
                sessionId: "s-claude",
                generation: 1,
                fresh: true,
                modeApplied: { outcome: "applied", modeId: "careful" },
              });
            return; // never resolves until the test explicitly releases it
          }
          resolve({
            sessionId: `s-${agent}`,
            generation: 1,
            fresh: true,
            modeApplied: { outcome: "applied", modeId: "careful" },
          });
        }),
    );
    const { startEagerSessionBoot } = await import("./eager-session-boot.js");
    const bus = new ChatEventBus();

    const result = startEagerSessionBoot(bootInput(bus)); // FALSIFYING: this call itself must return synchronously
    expect(result).toBeDefined();
    expect(typeof result.claude.then).toBe("function"); // still a pending promise, not yet settled

    releaseClaude?.();
    await expect(result.claude).resolves.toMatchObject({ outcome: "ready" });
  });
});

describe("startEagerSessionBoot: bus emissions are belt-and-suspenders — valid wire values ONLY, never 'connecting'", () => {
  it("a ready claude/codex emits BOTH agent.status(auth:ready) and mode.session(outcome:applied) on the REAL bus", async () => {
    mockLaneTransport(true);
    mockAcpServers();
    mockLaneCarrier(async (agent) => ({
      sessionId: `s-${agent}`,
      generation: 1,
      fresh: true,
      modeApplied: { outcome: "applied", modeId: "careful" },
      availableModeIds: ["careful", "plan", "auto"],
    }));
    const { startEagerSessionBoot } = await import("./eager-session-boot.js");
    const bus = new ChatEventBus();
    const statusEvents: unknown[] = [];
    const modeEvents: unknown[] = [];
    bus.on("agent.status", (e) => statusEvents.push(e));
    bus.on("mode.session", (e) => modeEvents.push(e));

    const result = startEagerSessionBoot(bootInput(bus));
    await Promise.all([result.claude, result.codex, result.gemini]);

    expect(statusEvents).toContainEqual({ kind: "agent.status", agent: "claude", auth: "ready" });
    expect(modeEvents).toContainEqual(
      expect.objectContaining({
        kind: "mode.session",
        agent: "claude",
        outcome: "applied",
        modeId: "careful",
      }),
    );
  });
});

describe("startEagerSessionBoot: a failure emits ONLY the valid wire shape — the reason never leaks onto the bus", () => {
  it("a failed codex open emits agent.status(auth:down) with NO reason field — the reason lives ONLY in the returned Promise", async () => {
    mockLaneTransport(true);
    mockAcpServers();
    mockLaneCarrier(async (agent) => {
      if (agent === "codex") throw new Error("bridge crash");
      return {
        sessionId: `s-${agent}`,
        generation: 1,
        fresh: true,
        modeApplied: { outcome: "applied", modeId: "careful" },
      };
    });
    const { startEagerSessionBoot } = await import("./eager-session-boot.js");
    const bus = new ChatEventBus();
    const statusEvents: unknown[] = [];
    bus.on("agent.status", (e) => statusEvents.push(e));

    const result = startEagerSessionBoot(bootInput(bus));
    await Promise.allSettled([result.claude, result.codex, result.gemini]);

    // Real ChatEventBus.emit() runs Zod validation on EVERY emit (events.ts:511) -- if the code ever
    // tried to smuggle a "reason"/diagnostic field or an invalid auth value through this channel, the
    // schema's non-strict object() would silently strip an unknown key (not throw), so this assertion
    // is the ONLY way to catch a reason leaking here: the emitted shape must be EXACTLY these 3 keys.
    expect(statusEvents).toContainEqual({ kind: "agent.status", agent: "codex", auth: "down" });
    const codexEvent = statusEvents.find(
      (e): e is { agent: string } =>
        typeof e === "object" &&
        e !== null &&
        "agent" in e &&
        (e as { agent: string }).agent === "codex",
    );
    expect(Object.keys(codexEvent ?? {}).sort()).toEqual(["agent", "auth", "kind"]);
  });
});

describe("W4-R2c C4: a boot open the operator's turn took over is NOT a failure", () => {
  it("a superseded acquire reports READY and never emits auth:down for a lane that is answering", async () => {
    mockLaneTransport(true);
    mockAcpServers();
    const { LaneAcquireSupersededError } = await import("./lane-acquire.js");
    mockLaneCarrier(async (agent) => {
      if (agent === "codex") throw new LaneAcquireSupersededError("codex");
      return { sessionId: `s-${agent}`, generation: 1, fresh: true };
    });
    const { startEagerSessionBoot } = await import("./eager-session-boot.js");
    const bus = new ChatEventBus();
    const statuses: { agent: string; auth: string }[] = [];
    bus.on("agent.status", (event) => {
      if (event.auth !== undefined) statuses.push({ agent: event.agent, auth: event.auth });
    });

    const result = startEagerSessionBoot(bootInput(bus));

    // THE WHOLE POINT: the foreground turn that superseded this open is, at this exact moment, using
    // that lane. Reporting "unavailable" would paint `offline` on an agent mid-answer — the same
    // red-cross-on-a-working-lane defect FIX-4 and ruling 3 spent two rounds killing.
    await expect(result.codex).resolves.toEqual({ outcome: "ready" });
    await Promise.all([result.claude, result.gemini]);
    expect(
      statuses.filter((entry) => entry.auth === "down"),
      `a superseded boot open must emit no down status, got: ${JSON.stringify(statuses)}`,
    ).toEqual([]);
  });
});
