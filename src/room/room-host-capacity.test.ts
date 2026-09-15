/**
 * @file src/room/room-host-capacity.test.ts
 * @purpose Proves journal exhaustion is rejected before operator persistence or lane admission.
 * @exports (test suite — no runtime exports)
 * @depends node:fs/promises, node:os, node:path, execa, vitest, ../chat/session-store, ./room-host
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { expect, it } from "vitest";
import { loadSession } from "../chat/session-store.js";
import type { RoomEvent, RoomLane } from "./room-engine.js";
import { AliveRoomHost } from "./room-host.js";
import { cleanupTestRoot } from "./room-test-cleanup.fixtures.js";

// FL-175: 12 sequential real submit() calls with no polling deadline of its own — the wall-clock risk
// here is purely the outer test budget, which this test measured RED against the vitest 30_000 ms
// global default under load (verify:staged tree 4087a2f). Round-2 F2: a fresh measurement put it at
// 46_637 ms, making the 90_000 ms raise only 1.93x. Round-3 F2: a heavier measurement put it at
// 63_360 ms, making even 120_000 ms only 1.89x. 150_000 ms clears 2.37x of the round-3 number.
it("rejects a turn with no journal reservation before writing its operator message", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "room-capacity-host-"));
  await execa("git", ["init"], { cwd: root, shell: false });
  const events: RoomEvent[] = [];
  const host = await AliveRoomHost.create({
    repoRoot: root,
    dbPath: path.join(root, ".zer0", "evidence.db"),
    blobRoot: path.join(root, ".zer0", "blobs"),
    onEvent: (event) => {
      events.push(event);
    },
    runLane: pendingLane,
  });
  try {
    for (let turn = 1; turn <= 12; turn += 1) {
      await expect(
        host.submit({ requestId: `accepted-${turn}`, text: `@all queued work ${turn}` }),
      ).resolves.toMatchObject({ turnId: `turn-${turn}` });
    }
    await expect(
      host.submit({ requestId: "rejected-13", text: "@all must not persist" }),
    ).rejects.toThrow("no capacity for another durable turn");

    const session = await loadSession(host.sessionId() as `chat-${string}`, root);
    expect(session.messages.filter((message) => message.role === "user")).toHaveLength(12);
    expect(events.filter((event) => event.type === "turn.accepted")).toHaveLength(12);
    expect(events.some((event) => event.turnId === "turn-13")).toBe(false);
  } finally {
    await host.shutdown().catch(() => undefined);
    await cleanupTestRoot(root);
  }
}, 150_000);

function pendingLane(lane: RoomLane): Promise<{ readonly status: "cancelled"; readonly text: "" }> {
  return new Promise((resolve) => {
    const cancel = () => resolve({ status: "cancelled", text: "" });
    if (lane.signal.aborted) cancel();
    else lane.signal.addEventListener("abort", cancel, { once: true });
  });
}
