/**
 * @file src/room/room-host-cancel-wiring.test.ts
 * @purpose FL-150 (review P2-B) — PIN THE WIRING ABOVE dropCancelledLaneHold, which nothing tested.
 *   The FL-146 reviewer's finding, verbatim: replace the `onCancel` body in room-host.ts with
 *   `async () => {}` and all four of its tests still pass. Those four bite on dropCancelledLaneHold
 *   ITSELF; the one line that reaches it from the room's own cancel was held up by nothing. A cancel
 *   that never reaches the lane transport is exactly the operator's original defect wearing a green
 *   suite, so the connection between the two is a thing a test has to hold.
 * @exports (test suite — no runtime exports)
 * @depends node:fs/promises, node:os, node:path, execa, vitest, ./room-engine, ./room-host
 *
 * A REAL AliveRoomHost, not a hand-built RoomEngine. Building an engine here and handing it the same
 * hook would prove the test can wire an engine — the thing under test is the wiring room-host.ts
 * SHIPS, so the host is booted through its own `create` and cancelled through its own `control`.
 *
 * WHY THE ASSERTION IS THE "no live bridge connection" LINE. This host runs with no carrier runtime, so
 * `dropLaneHold` finds nothing to drop and `dropCancelledLaneHold` reports — which is the branch that
 * produces an observable at all. Cut the wiring and that observable disappears, which is precisely the
 * failure mode being pinned.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, expect, it } from "vitest";
import type { RoomEvent, RoomLane, RoomLaneResult } from "./room-engine.js";
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

/** A lane that runs until the operator stops it — the state a cancel has to find something in. */
function cancellableLane(lane: RoomLane): Promise<RoomLaneResult> {
  return new Promise((resolve) => {
    const stop = (): void => resolve({ status: "cancelled", text: "" });
    if (lane.signal.aborted) stop();
    else lane.signal.addEventListener("abort", stop, { once: true });
  });
}

function cancelReports(events: readonly RoomEvent[]): readonly string[] {
  return events.flatMap((event) => {
    if (event.type !== "backend.failed") return [];
    const message = (event.payload as { readonly message?: unknown }).message;
    return typeof message === "string" ? [message] : [];
  });
}

// FL-175: same room-host wall-clock family as room-host-carrier.test.ts; real headroom above the
// vitest 30_000 ms global default.
it("the room's own cancel reaches the ACP lane transport, and says so when it finds nothing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zer0-cancel-wiring-"));
  roots.push(root);
  await execa("git", ["init", "-q"], { cwd: root, shell: false });
  const events: RoomEvent[] = [];
  const host = await AliveRoomHost.create({
    repoRoot: root,
    dbPath: path.join(root, ".zer0", "evidence.db"),
    blobRoot: path.join(root, ".zer0", "blobs"),
    onEvent: (event) => {
      events.push(event);
    },
    runLane: cancellableLane,
  });

  // FL-175 round 4 I2: see shutdownPreservingFailure's own header for why a bare shutdown() in this
  // finally would mask a real assertion failure below. Reproduced live: injected `shutdownTimeoutMs: 1`
  // plus a deliberately wrong expected string in the assertion below — the wrong-string error vanished
  // entirely, replaced by "room lanes did not terminate". `bodyError` (not just a pass/fail flag) lets
  // the finally report BOTH errors if both fail, rather than picking one and dropping the other.
  let bodyError: unknown;
  try {
    await host.submit({ requestId: "r-1", text: "@claude keep working until I stop you" });
    // The lane must be ACTIVE when the key lands: the scheduler only fires the cancel hook for a lane
    // it is currently running, so a cancel racing admission would prove nothing about the wiring.
    await waitFor(
      () => events.some((event) => event.type === "lane.started"),
      "the lane never started, so the cancel below would have had no active lane to reach",
    );

    await host.control({ requestId: "r-2", command: "cancel", scope: "all" });

    // The hook is deliberately NOT awaited by the engine (fireLaneCancel), and its report rides the
    // journal to the next flush — so the line arrives with the lane's own terminal, not before it.
    await waitFor(
      () => cancelReports(events).length > 0,
      "the room's cancel never reached dropCancelledLaneHold - room-host.ts's onCancel wiring is cut",
    );

    expect(
      cancelReports(events),
      "the room cancelled a lane and its transport never heard about it",
    ).toContain("cancel reached claude with no live bridge connection to stop");
  } catch (error) {
    bodyError = error;
    throw error;
  } finally {
    await shutdownPreservingFailure(() => host.shutdown(), bodyError, "room-host-cancel-wiring");
  }
}, 60_000);

/**
 * Polls a predicate to a short deadline. The room publishes events asynchronously (the journal is
 * flushed, not written inline), so there is no promise here to await instead.
 *
 * `onTimeout` is a PARAMETER (review P3-C): this helper serves two different waits, and a single baked-in
 * message meant a timeout on the FIRST one — the lane never starting — would blame the cancel wiring for
 * something upstream of it. A test that names the wrong cause costs more than one that just fails.
 */
async function waitFor(predicate: () => boolean, onTimeout: string): Promise<void> {
  await pollUntil(predicate, { timeoutMs: DEFAULT_POLL_TIMEOUT_MS, message: onTimeout });
}
