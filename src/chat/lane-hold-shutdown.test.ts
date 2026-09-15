/**
 * @file src/chat/lane-hold-shutdown.test.ts
 * @purpose Proves shutdown owns and closes a connection that finishes opening after the close begins.
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./lane-hold
 */
import { expect, it } from "vitest";
import { createCockpitLaneTransport } from "./lane-hold.js";

function lateConnection(closed: { value: boolean }) {
  let alive = true;
  return {
    initialize: async () => undefined,
    newSession: async () => ({ sessionId: "late-fresh" }),
    resumeSession: async (sessionId: string) => ({ sessionId }),
    prompt: async () => "end_turn",
    setMode: async () => undefined,
    close: () => {
      closed.value = true;
      alive = false;
    },
    waitForExit: async () => !alive,
    killTree: async () => {
      alive = false;
    },
    isAlive: () => alive,
    pid: () => 4242,
  };
}

function stubbornConnection(pid: number, sessionGate: Promise<void>) {
  return {
    initialize: async () => undefined,
    newSession: async () => {
      await sessionGate;
      return { sessionId: `stubborn-${String(pid)}` };
    },
    resumeSession: async (sessionId: string) => ({ sessionId }),
    prompt: async () => "end_turn",
    setMode: async () => undefined,
    close: () => undefined,
    waitForExit: async () => false,
    killTree: async () => undefined,
    isAlive: () => true,
    pid: () => pid,
  };
}

it("registers a production-shaped synchronous spawn before shutdown snapshots openings", async () => {
  let releaseSession: (() => void) | undefined;
  const sessionGate = new Promise<void>((resolve) => {
    releaseSession = resolve;
  });
  const transport = createCockpitLaneTransport({
    agent: "claude",
    cwd: "/repo",
    repoRoot: "/repo",
    openConnection: () => stubbornConnection(100, sessionGate) as never,
  });

  const opening = transport.start(undefined);
  const closing = transport.close();

  await expect(closing).resolves.toEqual({ outcome: "orphan", pid: 100 });
  releaseSession?.();
  await Promise.allSettled([opening]);
});

it("closes a late background connection without installing it", async () => {
  let releaseOpen: (() => void) | undefined;
  const openGate = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  const closed = { value: false };
  const transport = createCockpitLaneTransport({
    agent: "claude",
    cwd: "/repo",
    repoRoot: "/repo",
    openConnection: async () => {
      await openGate;
      return lateConnection(closed) as never;
    },
  });

  const opening = transport.start(undefined);
  const closing = transport.close();
  releaseOpen?.();
  await closing;
  await expect(opening).rejects.toThrow("superseded");
  expect(closed.value).toBe(true);
  await expect(transport.setMode("plan")).resolves.toEqual({ outcome: "noSession" });
});

it("reports every orphan when concurrent opens survive the shutdown ladder", async () => {
  let releaseSessions: (() => void) | undefined;
  const sessionGate = new Promise<void>((resolve) => {
    releaseSessions = resolve;
  });
  const pids = [101, 102];
  let opened = 0;
  const transport = createCockpitLaneTransport({
    agent: "codex",
    cwd: "/repo",
    repoRoot: "/repo",
    openConnection: async () => stubbornConnection(pids[opened++] as number, sessionGate) as never,
  });

  const starts = [transport.start(undefined), transport.start(undefined)];
  await waitFor(() => opened === 2);
  const closing = transport.close();
  releaseSessions?.();
  await expect(closing).resolves.toEqual({ outcome: "orphan", pid: 101, pids: [101, 102] });
  await Promise.allSettled(starts);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  while (!predicate()) await new Promise((resolve) => setTimeout(resolve, 0));
}
