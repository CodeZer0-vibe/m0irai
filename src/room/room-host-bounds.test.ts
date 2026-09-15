/**
 * @file src/room/room-host-bounds.test.ts
 * @purpose End-to-end room persistence falsifiers for byte-bounded operator and provider text.
 * @exports none
 * @depends node:fs/promises, node:os, node:path, execa, vitest, ../chat/headless-turn, ../chat/session-store, ../evidence/blobs, ../evidence/db, ./room-engine, ./room-host
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, expect, it } from "vitest";
import { runHeadlessTurn as runActualHeadlessTurn } from "../chat/headless-turn.js";
import { loadSession } from "../chat/session-store.js";
import { getBlobSync } from "../evidence/blobs.js";
import { closeDb, openDb } from "../evidence/db.js";
import { roomEventBytes } from "./room-engine-primitives.js";
import { MAX_ROOM_EVENT_BYTES, type RoomEvent } from "./room-engine.js";
import { AliveRoomHost } from "./room-host.js";
import {
  DEFAULT_POLL_TIMEOUT_MS,
  cleanupTestRoot,
  pollUntil,
  shutdownPreservingFailure,
} from "./room-test-cleanup.fixtures.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => cleanupTestRoot(root)));
});

// FL-175: real 250 KB payload through the real headless-turn dispatch, one waitFor, then a second real
// AliveRoomHost for recovery — same room-host wall-clock family as room-host-carrier.test.ts.
it("bounds provider output before durable persistence and reopens without recovery mismatch", async () => {
  const root = await tempGitRoot("zer0-room-provider-bounds-");
  const dbPath = path.join(root, ".zer0", "evidence.db");
  const blobRoot = path.join(root, ".zer0", "blobs");
  const raw = "a".repeat(250 * 1024);
  const events: RoomEvent[] = [];
  const priorMemory = process.env.ZER0_MEMORY;
  const priorNative = process.env.ZER0_NATIVE_RESUME;
  process.env.ZER0_MEMORY = "0";
  process.env.ZER0_NATIVE_RESUME = "0";
  let host: AliveRoomHost | undefined;
  try {
    host = await AliveRoomHost.create({
      repoRoot: root,
      dbPath,
      blobRoot,
      onEvent: (event) => {
        events.push(event);
      },
      runHeadlessTurn: (input) =>
        runActualHeadlessTurn({
          ...input,
          dispatch: async () => ({ stdout: raw, exitCode: 0 }),
        }),
    });
    await host.submit({ requestId: "provider-bounds", text: "@claude answer" });
    await waitFor(() => events.some((event) => event.type === "lane.completed"));
    const sessionId = host.sessionId() as `chat-${string}`;
    await host.shutdown();
    host = undefined;

    const committed = requiredCommit(events);
    const committedText = String(committed.payload.text);
    expect(roomEventBytes(committed)).toBeLessThanOrEqual(MAX_ROOM_EVENT_BYTES);
    expect(committedText.length).toBeLessThan(raw.length);
    expect(committedText).toContain("[response truncated to fit the room journal]");

    const session = await loadSession(sessionId, root);
    const message = session.messages.find(
      (candidate) => candidate.id === committed.payload.messageId,
    );
    expect(message).toMatchObject({ status: "completed", text: committedText });
    assertBlobMatchesCommit(dbPath, blobRoot, String(committed.payload.messageId), committedText);
    await expectRecoveryWithoutRerun(root, dbPath, blobRoot, sessionId, committedText);
  } finally {
    await host?.shutdown().catch(() => undefined);
    restoreEnv("ZER0_MEMORY", priorMemory);
    restoreEnv("ZER0_NATIVE_RESUME", priorNative);
  }
}, 60_000);

it("rejects oversized operator text before allocating a turn or durable message", async () => {
  const root = await tempGitRoot("zer0-room-operator-bounds-");
  const dbPath = path.join(root, ".zer0", "evidence.db");
  const blobRoot = path.join(root, ".zer0", "blobs");
  let runs = 0;
  const host = await AliveRoomHost.create({
    repoRoot: root,
    dbPath,
    blobRoot,
    runLane: async () => {
      runs += 1;
      return { status: "completed", text: "unexpected" };
    },
  });
  const sessionId = host.sessionId() as `chat-${string}`;
  // FL-175 round 4 I2: see shutdownPreservingFailure's own header for the masking hazard this closes.
  // `bodyError` (not just a pass/fail flag) lets the finally report BOTH errors if both fail.
  let bodyError: unknown;
  try {
    await expect(
      host.submit({ requestId: "operator-bounds", text: `@claude ${"a".repeat(230 * 1024)}` }),
    ).rejects.toThrow("room message is too large for the durable event journal");
    expect(runs).toBe(0);
    expect(host.eventsAfter("0")).toEqual([]);
    const db = openDb(dbPath);
    try {
      expect(
        (db.prepare("SELECT COUNT(*) AS count FROM chat_messages").get() as { count: number })
          .count,
      ).toBe(0);
    } finally {
      closeDb(db);
    }
  } catch (error) {
    bodyError = error;
    throw error;
  } finally {
    await shutdownPreservingFailure(
      () => host.shutdown(),
      bodyError,
      "room-host-bounds (operator text)",
    );
  }
  expect((await loadSession(sessionId, root)).messages).toEqual([]);
});

async function tempGitRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  await execa("git", ["init", "-q"], { cwd: root, shell: false });
  return root;
}

function requiredCommit(events: readonly RoomEvent[]): RoomEvent {
  const committed = events.find((event) => event.type === "message.committed");
  if (committed === undefined) throw new Error("fixture requires message.committed");
  return committed;
}

function assertBlobMatchesCommit(
  dbPath: string,
  blobRoot: string,
  messageId: string,
  committedText: string,
): void {
  const db = openDb(dbPath);
  try {
    const row = db
      .prepare("SELECT text_blob_hash AS hash, status FROM chat_messages WHERE id = ?")
      .get(messageId) as { hash: string; status: string } | undefined;
    expect(row?.status).toBe("completed");
    if (row === undefined) throw new Error("fixture requires durable chat message");
    expect(getBlobSync({ rootDir: blobRoot }, row.hash).toString("utf8")).toBe(committedText);
  } finally {
    closeDb(db);
  }
}

async function expectRecoveryWithoutRerun(
  root: string,
  dbPath: string,
  blobRoot: string,
  sessionId: `chat-${string}`,
  committedText: string,
): Promise<void> {
  let reruns = 0;
  const recovered = await AliveRoomHost.create({
    repoRoot: root,
    dbPath,
    blobRoot,
    continueSessionId: sessionId,
    runLane: async () => {
      reruns += 1;
      return { status: "completed", text: "must not rerun" };
    },
  });
  // FL-175 round 4 I2: same masking hazard as the operator-text test above.
  let bodyError: unknown;
  try {
    await recovered.activateRecovered();
    expect(reruns).toBe(0);
    expect(requiredCommit(recovered.eventsAfter("0")).payload.text).toBe(committedText);
  } catch (error) {
    bodyError = error;
    throw error;
  } finally {
    await shutdownPreservingFailure(
      () => recovered.shutdown(),
      bodyError,
      "room-host-bounds (recovery)",
    );
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  await pollUntil(predicate, {
    timeoutMs: DEFAULT_POLL_TIMEOUT_MS,
    message: "room event did not arrive before timeout",
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
