/**
 * @file src/chat/lane-hold.test.ts
 * @purpose W4-R2c C4 — THE SUPERSESSION GUARD, proven at its OWN seam rather than only through the
 *   carrier above it. THE OPERATOR-VISIBLE FAILURE THIS CATCHES: a boot-time resume that a foreground
 *   turn stopped waiting for finally answers, closes the fresh connection that turn is mid-way through
 *   using, and installs a dead session over the top — a lane that goes silent seconds after it started
 *   answering, for no reason the operator could ever see.
 * @exports (test suite — no runtime exports)
 * @depends node:fs, node:os, node:path, vitest, ./lane-hold
 *
 * The REAL transport factory, its REAL hold, and its REAL close ladder. `openConnection` is the one
 * injected seam — the documented trust boundary where a bridge process would be — so an open can be
 * made to hang deterministically instead of by timing.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCockpitLaneTransport } from "./lane-hold.js";

const dirs: string[] = [];
let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "lane-hold-"));
  dirs.push(repoRoot);
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface ConnRecord {
  readonly name: string;
  closed: boolean;
  killTreeCalls: number;
}

function fakeConnection(name: string, gate: Promise<void> | undefined, record: ConnRecord) {
  let alive = true;
  return {
    initialize: async () => undefined,
    newSession: async () => ({ sessionId: `${name}-fresh` }),
    resumeSession: async (sessionId: string) => {
      if (gate !== undefined) await gate;
      return { sessionId };
    },
    prompt: async () => "end_turn",
    setMode: async () => undefined,
    close: () => {
      record.closed = true;
      alive = false;
    },
    waitForExit: async () => !alive,
    killTree: async () => {
      record.killTreeCalls += 1;
      alive = false;
    },
    isAlive: () => alive,
    pid: () => 4242,
  };
}

function harness(gates: readonly (Promise<void> | undefined)[]) {
  const conns: ConnRecord[] = [];
  const orphans: number[] = [];
  const transport = createCockpitLaneTransport({
    agent: "codex",
    cwd: "/repo",
    repoRoot,
    onCloseOrphan: (pid) => orphans.push(pid),
    openConnection: async () => {
      const index = conns.length;
      const record: ConnRecord = { name: `c${String(index)}`, closed: false, killTreeCalls: 0 };
      conns.push(record);
      return fakeConnection(record.name, gates[index], record) as never;
    },
  });
  return { transport, conns, orphans };
}

describe("C4: the newest start() owns the hold", () => {
  it("a slow resume that finishes AFTER a newer open never installs itself", async () => {
    let release: (() => void) | undefined;
    const wedge = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness([wedge, undefined]);

    // The abandoned attempt: a resume of a stored id that hangs.
    const stalled = h.transport.start("session-from-the-last-run");
    // The foreground's own open, started while that one is still in flight.
    const fresh = await h.transport.start(undefined);
    expect(fresh).toMatchObject({ outcome: "created", sessionId: "c1-fresh" });

    release?.();
    const stale = await stalled;

    // The older ticket reports honestly instead of claiming a session nothing holds.
    expect(stale.outcome, `the stale resume claimed success: ${JSON.stringify(stale)}`).toBe(
      "resumeFailed",
    );
    // The foreground's connection is untouched: its own session still takes the already-held fast path,
    // which opens NOTHING. A stale hold would force a real reconnect here.
    const before = h.conns.length;
    await expect(h.transport.start("c1-fresh")).resolves.toEqual({
      outcome: "resumed",
      sessionId: "c1-fresh",
    });
    expect(h.conns.length, "the fresh hold was replaced by the stale one").toBe(before);
    // ...and the refused connection was CLOSED, never abandoned.
    expect(h.conns[0]?.closed, "a refused connection must go through the close ladder").toBe(true);
  });
});

describe("C4: the guard costs the ordinary path nothing", () => {
  it("an ordinary sequential open still installs", async () => {
    const h = harness([undefined, undefined]);

    const first = await h.transport.start(undefined);
    expect(first).toMatchObject({ outcome: "created", sessionId: "c0-fresh" });

    // A LATER start() for a different session replaces the hold, as it always did.
    const second = await h.transport.start("other-session");
    expect(second).toMatchObject({ outcome: "resumed", sessionId: "other-session" });
    expect(h.conns[0]?.closed, "the replaced connection is closed by the ladder").toBe(true);
  });
});

describe("C4: a refused connection is never abandoned", () => {
  it("a survivor of the close ladder is reported as an orphan, never silently dropped", async () => {
    let release: (() => void) | undefined;
    const wedge = new Promise<void>((resolve) => {
      release = resolve;
    });
    const conns: ConnRecord[] = [];
    const orphans: number[] = [];
    const transport = createCockpitLaneTransport({
      agent: "codex",
      cwd: "/repo",
      repoRoot,
      onCloseOrphan: (pid) => orphans.push(pid),
      openConnection: async () => {
        const index = conns.length;
        const record: ConnRecord = { name: `c${String(index)}`, closed: false, killTreeCalls: 0 };
        conns.push(record);
        const conn = fakeConnection(record.name, index === 0 ? wedge : undefined, record);
        // The stubborn child: it ignores close AND killTree, exactly what onCloseOrphan exists for.
        return { ...conn, close: () => undefined, killTree: async () => undefined } as never;
      },
    });

    const stalled = transport.start("session-from-the-last-run");
    await transport.start(undefined);
    release?.();
    await stalled;

    expect(orphans, "a survivor of the close ladder must surface as an orphan pid").toEqual([4242]);
  });
});
