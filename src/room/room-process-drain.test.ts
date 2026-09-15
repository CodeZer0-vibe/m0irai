/**
 * @file src/room/room-process-drain.test.ts
 * @purpose The room's shutdown drain covers BOTH process families and never lets one failure hide the other:
 *   transport orphans pass through, the PTY registry is disposed exactly once, a PTY-drain failure surfaces
 *   while orphans are still reported, and a transport failure never skips the PTY drain.
 * @exports (none)
 * @depends vitest, ../chat/lane-transport, ../chat/pty-session-registry, ./room-process-drain
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const closeAllLaneTransports = vi.fn<() => Promise<readonly number[]>>();
const disposeAllPtySessions = vi.fn<() => Promise<void>>();
vi.mock("../chat/lane-transport.js", () => ({ closeAllLaneTransports }));
vi.mock("../chat/pty-session-registry.js", () => ({ disposeAllPtySessions }));

const { drainProcessOwnedTransports } = await import("./room-process-drain.js");

beforeEach(() => {
  closeAllLaneTransports.mockReset();
  disposeAllPtySessions.mockReset();
});

describe("drainProcessOwnedTransports", () => {
  it("drains both families and reports transport orphans", async () => {
    closeAllLaneTransports.mockResolvedValue([4242]);
    disposeAllPtySessions.mockResolvedValue(undefined);
    const result = await drainProcessOwnedTransports();
    expect(result).toEqual({ orphans: [4242] });
    expect(closeAllLaneTransports).toHaveBeenCalledTimes(1);
    expect(disposeAllPtySessions).toHaveBeenCalledTimes(1);
  });

  it("a PTY-drain failure surfaces without hiding transport orphans", async () => {
    closeAllLaneTransports.mockResolvedValue([7]);
    disposeAllPtySessions.mockRejectedValue(new Error("pty boom"));
    const result = await drainProcessOwnedTransports();
    expect(result.orphans).toEqual([7]);
    expect(result.failure?.message).toBe("pty boom");
  });

  it("a transport failure never skips the PTY drain", async () => {
    closeAllLaneTransports.mockRejectedValue(new Error("transport boom"));
    disposeAllPtySessions.mockResolvedValue(undefined);
    const result = await drainProcessOwnedTransports();
    expect(result.orphans).toEqual([]);
    expect(result.failure?.message).toBe("transport boom");
    expect(disposeAllPtySessions).toHaveBeenCalledTimes(1);
  });
});
