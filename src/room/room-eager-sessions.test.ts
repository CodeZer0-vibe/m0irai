/**
 * @file src/room/room-eager-sessions.test.ts
 * @purpose Proves a transient warm-up failure cannot poison a later recovered live session.
 * @exports (test suite — no runtime exports)
 * @depends node:fs, node:os, node:path, vitest, ../chat/events, ../chat/lane-transport, ./room-eager-sessions
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ChatEventBus } from "../chat/events.js";
import {
  closeAllLaneTransports,
  getOrCreateLaneTransport,
  initCarrierRuntime,
  resetCarrierRuntime,
} from "../chat/lane-transport.js";
import { RoomEagerSessions } from "./room-eager-sessions.js";

it("uses a recovered live session after the background warm-up failed transiently", async () => {
  const root = mkdtempSync(join(tmpdir(), "room-eager-recovery-"));
  const modeSets: string[] = [];
  initCarrierRuntime({
    projectId: "project-eager-recovery",
    dbPath: join(root, "evidence.db"),
    repoRoot: root,
    cwd: root,
    openConnection: async () => liveConnection(modeSets) as never,
  });
  try {
    const eager = new RoomEagerSessions(() => ({
      claude: Promise.resolve({ outcome: "unavailable", reason: "transient eager failure" }),
      codex: Promise.resolve({ outcome: "ready" }),
      gemini: Promise.resolve({ outcome: "ready" }),
    }));
    eager.start(new ChatEventBus(), new AbortController().signal);
    await getOrCreateLaneTransport("claude").start(undefined);
    modeSets.length = 0;

    await expect(eager.setMode("claude", "plan")).resolves.toEqual({ outcome: "applied" });
    expect(modeSets).toEqual(["plan"]);
  } finally {
    await closeAllLaneTransports();
    resetCarrierRuntime();
    rmSync(root, { recursive: true, force: true });
  }
});

function liveConnection(modeSets: string[]) {
  let alive = true;
  return {
    initialize: async () => undefined,
    newSession: async () => ({ sessionId: "recovered-claude-session" }),
    resumeSession: async () => ({}),
    prompt: async () => "end_turn",
    setMode: async (_sessionId: string, modeId: string) => {
      modeSets.push(modeId);
    },
    close: () => {
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
