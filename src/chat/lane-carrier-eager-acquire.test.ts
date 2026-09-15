/**
 * @file src/chat/lane-carrier-eager-acquire.test.ts
 * @purpose W4-R REFIT R1 falsifiers for acquireLaneSession's single-flight guard — the CONCURRENT half
 *   of the "one open path" law (the sequential half, extraction + persist, is covered by every existing
 *   lane-carrier*.test.ts passing unchanged: openActiveSession now delegates to acquireLaneSession with
 *   byte-identical per-turn behavior). Two concurrent acquisitions for the SAME (projectId, agent) —
 *   e.g. a boot-time eager open racing a fast first real turn — must share ONE transport.start() call,
 *   never open a second, orphaned session.
 * @exports (test suite — no runtime exports)
 * @depends vitest, ../evidence/db, ./lane-carrier, ./lane-carrier.fixtures
 */
import { describe, expect, it } from "vitest";
import type { Db } from "../evidence/db.js";
import {
  BINDING,
  NEVER_CANCELLED,
  NOW,
  PROJECT,
  registerLaneCarrierHooks,
  seeded,
} from "./lane-carrier.fixtures.js";
import type { AcquireLaneSessionInput, CarrierTransport } from "./lane-carrier.js";
import { acquireLaneSession, resetLaneAcquireCache } from "./lane-carrier.js";

registerLaneCarrierHooks();

/** A controllable fake transport: start() does not settle until the test explicitly resolves/rejects
 *  it — the ONLY way to deterministically prove two calls raced concurrently rather than sequentially. */
function deferredTransport(): {
  readonly transport: CarrierTransport & { readonly startCalls: number };
  readonly resolve: (result: Awaited<ReturnType<CarrierTransport["start"]>>) => void;
  readonly reject: (error: Error) => void;
} {
  let startCalls = 0;
  let settle: ((result: Awaited<ReturnType<CarrierTransport["start"]>>) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  const transport: CarrierTransport & { startCalls: number } = {
    startCalls: 0,
    start: async () => {
      startCalls += 1;
      transport.startCalls = startCalls;
      return new Promise((res, rej) => {
        settle = res;
        fail = rej;
      });
    },
    send: async () => ({ outcome: "accepted" as const }),
  };
  return {
    transport,
    resolve: (result) => settle?.(result),
    reject: (error) => fail?.(error),
  };
}

function acquireInput(
  db: Db,
  tx: CarrierTransport,
  agent: "claude" | "codex" = "claude",
): AcquireLaneSessionInput {
  return {
    agent,
    binding: BINDING,
    db,
    projectId: PROJECT,
    transport: tx,
    turn: 0,
    // FL-150: required, so even the boot-time shape has to name its cancel authority. Nothing in this
    // suite cancels — the cancel cases live in lane-acquire-cancel.test.ts.
    signal: NEVER_CANCELLED,
    now: () => NOW,
  };
}

describe("acquireLaneSession: single-flight per (projectId, agent) — the CONCURRENT half of one-open-path", () => {
  it("two concurrent acquires for the SAME agent share ONE transport.start() call and resolve to the SAME session", async () => {
    const { db } = seeded();
    const { transport, resolve } = deferredTransport();
    const input = acquireInput(db, transport);

    const first = acquireLaneSession(input);
    const second = acquireLaneSession(input); // fired BEFORE the first's start() has settled
    expect(transport.startCalls).toBe(1); // FALSIFYING: the second call did NOT trigger its own start()

    resolve({
      outcome: "created",
      sessionId: "s-shared",
      modeApplied: { outcome: "applied", modeId: "default", origin: "confirmed" },
    });
    const [a, b] = await Promise.all([first, second]);

    expect(a.sessionId).toBe("s-shared");
    expect(b.sessionId).toBe("s-shared");
    expect(transport.startCalls).toBe(1); // still exactly one spawn, never a second/orphaned session
  });
});

describe("acquireLaneSession: the cache is scoped correctly — per-agent, and only WHILE in flight", () => {
  it("a SECOND, later (non-concurrent) acquire re-invokes start() fresh — the cache never sticks", async () => {
    const { db } = seeded();
    const { transport, resolve } = deferredTransport();
    const input = acquireInput(db, transport);

    const first = acquireLaneSession(input);
    resolve({
      outcome: "created",
      sessionId: "s-1",
      modeApplied: { outcome: "applied", modeId: "default", origin: "confirmed" },
    });
    await first;
    expect(transport.startCalls).toBe(1);

    // A later, independent call (mirrors turn 2's own per-turn re-acquire) is NOT blocked by the
    // settled first promise — it invokes start() again (which, against a REAL transport, would hit
    // lane-transport.ts's own already-held-and-alive fast path; this fake simply proves the call happens).
    const second = acquireLaneSession(input);
    resolve({ outcome: "resumed", sessionId: "s-1" });
    await second;
    expect(transport.startCalls).toBe(2);
  });

  it("concurrent acquires for DIFFERENT agents never share a slot — each gets its own start() call", async () => {
    const { db } = seeded();
    const claudeTx = deferredTransport();
    const codexTx = deferredTransport();

    const claude = acquireLaneSession(acquireInput(db, claudeTx.transport, "claude"));
    const codex = acquireLaneSession(acquireInput(db, codexTx.transport, "codex"));
    expect(claudeTx.transport.startCalls).toBe(1);
    expect(codexTx.transport.startCalls).toBe(1);

    claudeTx.resolve({
      outcome: "created",
      sessionId: "s-claude",
      modeApplied: { outcome: "applied", modeId: "default", origin: "confirmed" },
    });
    codexTx.resolve({
      outcome: "created",
      sessionId: "s-codex",
      modeApplied: { outcome: "applied", modeId: "default", origin: "confirmed" },
    });
    const [a, b] = await Promise.all([claude, codex]);
    expect(a.sessionId).toBe("s-claude");
    expect(b.sessionId).toBe("s-codex");
  });
});

describe("acquireLaneSession: single-flight failure/reset handling — one bad attempt must not poison future ones", () => {
  it("a REJECTED in-flight acquire propagates to every concurrent joiner, and does not stick — a later retry can still succeed", async () => {
    const { db } = seeded();
    const { transport, reject, resolve } = deferredTransport();
    const input = acquireInput(db, transport);

    const first = acquireLaneSession(input);
    const second = acquireLaneSession(input);
    reject(new Error("bridge crash"));

    await expect(first).rejects.toThrow("bridge crash");
    await expect(second).rejects.toThrow("bridge crash"); // the SAME failure, not a silently different one

    // The cache entry cleared on rejection (finally) — a later call is a genuinely fresh attempt, not
    // stuck forever behind the earlier failure (the FAILURE CONTRACT: one bad attempt must not poison
    // every future one).
    const retry = acquireLaneSession(input);
    resolve({
      outcome: "created",
      sessionId: "s-retry",
      modeApplied: { outcome: "applied", modeId: "default", origin: "confirmed" },
    });
    await expect(retry).resolves.toMatchObject({ sessionId: "s-retry" });
  });

  it("resetLaneAcquireCache clears an in-flight entry so a leaked promise from one test never bleeds into the next", async () => {
    const { db } = seeded();
    const { transport } = deferredTransport(); // never resolved/rejected — deliberately left hanging
    const input = acquireInput(db, transport);

    void acquireLaneSession(input); // fire-and-forget: simulates a prior test's leaked in-flight call
    resetLaneAcquireCache();

    const { transport: fresh, resolve } = deferredTransport();
    const freshCall = acquireLaneSession(acquireInput(db, fresh));
    expect(fresh.startCalls).toBe(1); // FALSIFYING: NOT joined onto the cleared, still-hanging prior promise
    resolve({
      outcome: "created",
      sessionId: "s-fresh",
      modeApplied: { outcome: "applied", modeId: "default", origin: "confirmed" },
    });
    await expect(freshCall).resolves.toMatchObject({ sessionId: "s-fresh" });
  });
});
