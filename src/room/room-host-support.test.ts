import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { RoomNoticeEvent } from "../chat/events.js";
import type { RoomNotice } from "../shared/room-notice.js";
import { createRoomBus, loadRoomJournal, parseRoomInput } from "./room-host-support.js";
import { RoomUsageFold } from "./room-usage-fold.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// I-3 (MN fix round 2, reviewer-confirmed): createRoomBus's own `room.notice` subscription is the
// ONLY thing joining the carrier's classified failure (published on the ChatEventBus as a
// `room.notice` event) to RoomEngine.notice — the call that owns the once-per-cause dedup and writes
// the durable row. Both sides of that join already had tests; the join itself did not. Reverting the
// `bus.on("room.notice", ...)` registration in createRoomBus (room-host-support.ts:159-168) fails
// both tests below; the code as it stands today passes them.
function busWithNotices(isShuttingDown: () => boolean): {
  readonly emit: (event: RoomNoticeEvent) => void;
  readonly seen: { readonly turnId: string; readonly notice: RoomNotice }[];
} {
  const seen: { turnId: string; notice: RoomNotice }[] = [];
  const bus = createRoomBus({
    turnId: "turn-1",
    isShuttingDown,
    notify: () => undefined,
    notice: (turnId, notice) => seen.push({ turnId, notice }),
    onMode: () => undefined,
    usageFold: new RoomUsageFold(),
  });
  return { emit: (event) => bus.emit(event), seen };
}

it("joins a classified room.notice on the bus to RoomEngine's own notice call, turnId and payload intact", () => {
  const { emit, seen } = busWithNotices(() => false);
  emit({
    kind: "room.notice",
    cause: "memory-compose-failed",
    turn: 3,
    agent: "claude",
    detail: "the briefing could not be composed",
  });
  expect(seen).toEqual([
    {
      turnId: "turn-1",
      notice: {
        cause: "memory-compose-failed",
        agent: "claude",
        detail: "the briefing could not be composed",
      },
    },
  ]);
});

it("omits an absent agent rather than forwarding an explicit undefined", () => {
  const { emit, seen } = busWithNotices(() => false);
  emit({ kind: "room.notice", cause: "memory-cursor-failed", turn: 1, detail: "no agent here" });
  expect(seen).toEqual([
    { turnId: "turn-1", notice: { cause: "memory-cursor-failed", detail: "no agent here" } },
  ]);
});

it("suppresses a notice raised while the room is shutting down, same as every other bus row", () => {
  const { emit, seen } = busWithNotices(() => true);
  emit({ kind: "room.notice", cause: "memory-cursor-failed", turn: 1, detail: "torn down anyway" });
  expect(seen).toEqual([]);
});

function roomEvent(sequence: string): Readonly<Record<string, unknown>> {
  return {
    protocol: "zer0.room",
    version: 1,
    sessionId: "chat-test",
    eventSeq: sequence,
    eventId: `event-${sequence}`,
    turnId: "turn-1",
    occurredAt: "2026-01-01T00:00:00Z",
    type: "backend.failed",
    payload: { message: `failure-${sequence}` },
  };
}

async function journalPath(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "zer0-room-journal-tail-"));
  roots.push(root);
  return path.join(root, "room-events.jsonl");
}

it("truncates an unframed final journal record before later appends", async () => {
  const target = await journalPath();
  const first = `${JSON.stringify(roomEvent("1"))}\n`;
  const unframed = JSON.stringify(roomEvent("2"));
  await writeFile(target, `${first}${unframed}`, "utf8");

  const loaded = await loadRoomJournal(target, 1024 * 1024, 10);
  expect(loaded.map((event) => event.eventSeq)).toEqual(["1"]);
  expect(await readFile(target, "utf8")).toBe(first);

  await appendFile(target, `${JSON.stringify(roomEvent("2"))}\n`, "utf8");
  const reopened = await loadRoomJournal(target, 1024 * 1024, 10);
  expect(reopened.map((event) => event.eventSeq)).toEqual(["1", "2"]);
});

it("drops a partial utf8 crash tail but rejects newline-framed corruption", async () => {
  const target = await journalPath();
  const first = `${JSON.stringify(roomEvent("1"))}\n`;
  const partialUtf8 = Buffer.from(
    JSON.stringify(roomEvent("2")).replace("failure-2", "failure-😀"),
  );
  await writeFile(target, Buffer.concat([Buffer.from(first), partialUtf8.subarray(0, -2)]));
  await expect(loadRoomJournal(target, 1024 * 1024, 10)).resolves.toHaveLength(1);

  await writeFile(target, `${first}{"bad":true\n`, "utf8");
  await expect(loadRoomJournal(target, 1024 * 1024, 10)).rejects.toThrow();
});

it("keeps bare room commands local and requires a real council topic", () => {
  expect(parseRoomInput("/council inspect the transport", "claude")).toMatchObject({
    route: { slashCommand: "council", agents: ["claude", "codex", "gemini"] },
    text: "inspect the transport",
  });
  expect(() => parseRoomInput("/council", "claude")).toThrow("requires a topic");
  for (const command of ["/clear", "/mode codex plan", "/exit now", "/debate topic"]) {
    expect(() => parseRoomInput(command, "claude")).toThrow("unsupported room command");
  }
});
