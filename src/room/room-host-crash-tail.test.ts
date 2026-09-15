import { appendFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, expect, it } from "vitest";
import { recordChatMessage } from "../chat/evidence.js";
import type { HeadlessTurnInput } from "../chat/headless-turn.js";
import type { LaneOutcome } from "../chat/tower-bridge-lane.js";
import { AliveRoomHost } from "./room-host.js";
import {
  DEFAULT_POLL_TIMEOUT_MS,
  cleanupTestRoot,
  pollUntil,
} from "./room-test-cleanup.fixtures.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => cleanupTestRoot(root)));
});

// FL-175 round 2 F3: the production quiesce deadline (room-host.ts:294,
// `this.options.shutdownTimeoutMs ?? 4_000`) is a SEPARATE budget from anything this lane's scope (test
// files only) can raise on the production side. Under load it can fire before the injected journal
// failure does, replacing the expected "partial journal append" rejection with "room lanes did not
// terminate" — the true cause of the 4087a2f failure this file's comment used to misdiagnose as a test-
// level timeout. Measured on this box across 4 runs (1 alone, 1 in the full target suite): 495-1787 ms.
// shutdownTimeoutMs is test-side data on RoomHostOptions (room-host-eager.test.ts already uses it), not
// a production change; 40_000 ms is >=20x the observed worst case.
const SHUTDOWN_TIMEOUT_MS = 40_000;
// Round-2 F2: reviewer measured this test's total wall time at 46_225 ms on a loaded box — 90_000 ms
// was only 1.95x, under the >=2x bar. 120_000 ms clears 2.6x.

async function createTornHost(
  root: string,
  dbPath: string,
  blobRoot: string,
  runs: { value: number },
): Promise<AliveRoomHost> {
  return AliveRoomHost.create({
    repoRoot: root,
    dbPath,
    blobRoot,
    shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
    appendJournal: async (journalPath, line) => {
      const event = JSON.parse(line) as { readonly type?: unknown };
      if (event.type === "message.committed") {
        await appendFile(journalPath, line.slice(0, -8), "utf8");
        throw new Error("injected crash after a partial journal append");
      }
      await appendFile(journalPath, line, "utf8");
    },
    runHeadlessTurn: committedTurn(dbPath, blobRoot, runs),
  });
}

it("truncates a crash-torn journal tail before DB recovery appends and survives a second restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zer0-room-crash-tail-"));
  roots.push(root);
  await execa("git", ["init"], { cwd: root, shell: false });
  const dbPath = path.join(root, ".zer0", "evidence.db");
  const blobRoot = path.join(root, ".zer0", "blobs");
  const runs = { value: 0 };
  const first = await createTornHost(root, dbPath, blobRoot, runs);
  await first.submit({ requestId: "crash-tail", text: "@claude answer" });
  await waitFor(() => runs.value === 1);
  await expect(first.shutdown()).rejects.toThrow("partial journal append");

  const sessionId = first.sessionId() as `chat-${string}`;
  let replayed = 0;
  const recovered = await AliveRoomHost.create({
    repoRoot: root,
    dbPath,
    blobRoot,
    continueSessionId: sessionId,
    shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
    runLane: async () => {
      replayed += 1;
      return { text: "must not rerun", status: "completed" };
    },
  });
  expect(
    recovered.eventsAfter("0").filter((event) => event.payload.recovered === true),
  ).toHaveLength(3);
  await recovered.activateRecovered();
  expect(replayed).toBe(0);
  await recovered.shutdown();

  const reopened = await AliveRoomHost.create({
    repoRoot: root,
    dbPath,
    blobRoot,
    continueSessionId: sessionId,
    shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
    runLane: async () => {
      throw new Error("durable terminal lane must not rerun on a second restart");
    },
  });
  expect(reopened.eventsAfter("0").some((event) => event.type === "turn.completed")).toBe(true);
  await reopened.activateRecovered();
  await reopened.shutdown();
}, 120_000);

function committedTurn(dbPath: string, blobRoot: string, runs: { value: number }) {
  return async (input: HeadlessTurnInput): Promise<readonly LaneOutcome[]> => {
    runs.value += 1;
    if (input.messageId === undefined) throw new Error("fixture requires durable message identity");
    const outcome: LaneOutcome = {
      agent: "claude",
      text: "durable answer",
      exitCode: 0,
      state: "completed",
      messageId: input.messageId,
      messageCreatedAt: "2026-01-01T00:00:00.000Z",
    };
    await recordChatMessage({
      dbPath,
      blobRoot,
      sessionId: input.session.id,
      messageId: input.messageId,
      turn: input.turn,
      role: "agent",
      agent: "claude",
      text: outcome.text,
      createdAt: outcome.messageCreatedAt ?? "2026-01-01T00:00:00.000Z",
      status: "completed",
      tokenEstimate: 1,
    });
    await input.onLaneSettled?.("claude", outcome);
    return [outcome];
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  await pollUntil(predicate, {
    timeoutMs: DEFAULT_POLL_TIMEOUT_MS,
    message: "room did not settle before timeout",
  });
}
