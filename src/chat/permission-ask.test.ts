/**
 * @file src/chat/permission-ask.test.ts
 * @purpose Falsifiers for W4-3's async ask bridge: a real operator response resolves the ORIGINAL
 *   ACP-side Promise with the correct PermissionDecision and emits pending-then-settled events; the 3
 *   FAIL-CLOSED paths (decider unavailable is acp-permission.test.ts's denyDecider — this file covers
 *   the other two: timeout, and an ask outliving its turn via invalidatePendingAsk) resolve with the
 *   precomputed denyDecision and emit a settled event with the right outcome; a stale/unknown askId is
 *   a harmless no-op. W4-B fix round 1 CONCERN 2: the deny path resolves {kind:"cancelled"} (never a
 *   fabricated optionId) when no reject-kind option was offered.
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./events, ./permission-ask
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatEventBus, type PermissionAskEvent } from "./events.js";
import {
  createOperatorPermissionDecider,
  invalidatePendingAsk,
  resetPermissionAskRegistry,
  resolveAsk,
  resolveAskOption,
} from "./permission-ask.js";

afterEach(() => {
  resetPermissionAskRegistry();
});

// Captures every permission.ask event a bus emits, in order — the "a visible record exists" half of
// the FAIL-CLOSED acceptance contract.
function captureAsks(bus: ChatEventBus): PermissionAskEvent[] {
  const events: PermissionAskEvent[] = [];
  bus.on("permission.ask", (e) => events.push(e));
  return events;
}

const OPTIONS = [
  { optionId: "allow-once", kind: "allow_once", name: "Allow" },
  { optionId: "reject-once", kind: "reject_once", name: "Reject" },
];

// No reject-kind option offered at all — the CONCERN 2 cancelled-envelope case.
const ALLOW_ONLY_OPTIONS = [{ optionId: "allow-once", kind: "allow_once", name: "Allow" }];

describe("createOperatorPermissionDecider: a live operator response", () => {
  it("approve resolves the ORIGINAL Promise with {kind:'selected', optionId} and emits pending then settled(approved)", async () => {
    const bus = new ChatEventBus();
    const events = captureAsks(bus);
    const decide = createOperatorPermissionDecider("claude", bus);

    const pending = decide({ options: OPTIONS, toolCall: { title: "run: rm -rf build/" } });
    // The Promise must NOT resolve on its own — only settleAsk (via resolveAsk here) resolves it.
    expect(events).toEqual([
      expect.objectContaining({
        kind: "permission.ask",
        agent: "claude",
        askId: expect.stringMatching(/^ask-/u),
        phase: "pending",
        toolTitle: "run: rm -rf build/",
      }),
    ]);

    const resolved = resolveAsk(events[0]?.askId ?? "", true);
    expect(resolved).toBe(true);
    await expect(pending).resolves.toEqual({ kind: "selected", optionId: "allow-once" });
    expect(events[1]).toEqual({
      kind: "permission.ask",
      agent: "claude",
      askId: events[0]?.askId,
      phase: "settled",
      outcome: "approved",
    });
  });
});

// Split from the describe block above to stay under the function-length clamp (gate-clamps.mjs, 50
// lines) — the deny-path resolution cases (an offered reject option, and CONCERN 2's cancelled fallback).
describe("createOperatorPermissionDecider: a live operator DENY response", () => {
  it("deny resolves with {kind:'selected', optionId} (an offered reject option) and emits settled(denied)", async () => {
    const bus = new ChatEventBus();
    const events = captureAsks(bus);
    const decide = createOperatorPermissionDecider("codex", bus);

    const pending = decide({ options: OPTIONS });
    resolveAsk(events[0]?.askId ?? "", false);
    await expect(pending).resolves.toEqual({ kind: "selected", optionId: "reject-once" });
    expect(events[1]?.outcome).toBe("denied");
  });

  // W4-B fix round 1 CONCERN 2: an allow-only options list has NO reject-kind option to select — the
  // operator's deny keypress must resolve the protocol's own {kind:"cancelled"} envelope, never a
  // fabricated optionId the bridge never offered.
  it("deny with an ALLOW-ONLY options list resolves {kind:'cancelled'} — never a fabricated id", async () => {
    const bus = new ChatEventBus();
    const events = captureAsks(bus);
    const decide = createOperatorPermissionDecider("claude", bus);

    const pending = decide({ options: ALLOW_ONLY_OPTIONS });
    resolveAsk(events[0]?.askId ?? "", false);
    await expect(pending).resolves.toEqual({ kind: "cancelled" });
  });
});

describe("createOperatorPermissionDecider: explicit deny of empty provider options", () => {
  it("settles the real ask as denied/cancelled without a fabricated option ID", async () => {
    const bus = new ChatEventBus();
    const events = captureAsks(bus);
    const pending = createOperatorPermissionDecider("gemini", bus)({ options: [] });
    const askId = events[0]?.askId ?? "";

    expect(resolveAsk(askId, false)).toBe(true);
    await expect(pending).resolves.toEqual({ kind: "cancelled" });
    expect(events[1]).toEqual({
      kind: "permission.ask",
      agent: "gemini",
      askId,
      phase: "settled",
      outcome: "denied",
    });
    expect(resolveAsk(askId, false)).toBe(false);
  });
});

// Split from the describe block above to stay under the function-length clamp (gate-clamps.mjs, 50 lines).
describe("createOperatorPermissionDecider: edge cases", () => {
  it("toolTitle defaults to a generic label when the request carries none", async () => {
    const bus = new ChatEventBus();
    const events = captureAsks(bus);
    createOperatorPermissionDecider("claude", bus)({ options: OPTIONS });
    expect(events[0]).toMatchObject({ toolTitle: "a tool call" });
  });

  it("a stale/unknown askId is a harmless no-op — returns false, no crash, no phantom event", () => {
    const bus = new ChatEventBus();
    const events = captureAsks(bus);
    expect(resolveAsk("never-existed", true)).toBe(false);
    expect(events).toEqual([]);
  });

  it("resolving the same askId twice: the second call is a no-op (already settled)", async () => {
    const bus = new ChatEventBus();
    const events = captureAsks(bus);
    const pending = createOperatorPermissionDecider("claude", bus)({ options: OPTIONS });
    const askId = events[0]?.askId ?? "";
    expect(resolveAsk(askId, true)).toBe(true);
    expect(resolveAsk(askId, false)).toBe(false); // already settled — cannot flip approved to denied
    await expect(pending).resolves.toEqual({ kind: "selected", optionId: "allow-once" }); // the FIRST settlement wins
    expect(events.filter((e) => e.phase === "settled")).toHaveLength(1);
  });
});

describe("resolveAskOption: exact provider IDs", () => {
  it("selects only the exact offered allow or reject ID and rejects unknown/stale IDs", async () => {
    const bus = new ChatEventBus();
    const events = captureAsks(bus);
    const pending = createOperatorPermissionDecider("claude", bus)({ options: OPTIONS });
    const askId = events[0]?.askId ?? "";
    expect(resolveAskOption(askId, "invented-allow")).toBe(false);
    expect(resolveAskOption(askId, "reject-once")).toBe(true);
    await expect(pending).resolves.toEqual({ kind: "selected", optionId: "reject-once" });
    expect(resolveAskOption(askId, "allow-once")).toBe(false);
  });

  it("serializes offered option IDs for protocol consumers and timeout selects the offered reject", async () => {
    const bus = new ChatEventBus();
    const events = captureAsks(bus);
    const pending = createOperatorPermissionDecider("codex", bus, 10)({ options: OPTIONS });
    expect(events[0]?.options).toEqual(OPTIONS);
    await expect(pending).resolves.toEqual({ kind: "selected", optionId: "reject-once" });
  });

  it("exposes at most nine bounded choices and never resolves a hidden provider option", async () => {
    const bus = new ChatEventBus();
    const events = captureAsks(bus);
    const options = Array.from({ length: 10 }, (_, index) => ({
      optionId: `option-${String(index)}`,
      kind: index === 9 ? "reject_once" : "allow_once",
      name: `Option ${String(index)}`,
    }));
    const pending = createOperatorPermissionDecider(
      "claude",
      bus,
    )({
      options: [{ optionId: "x".repeat(4097), kind: "reject_once" }, ...options],
    });
    const askId = events[0]?.askId ?? "";

    expect(events[0]?.options).toHaveLength(9);
    expect(events[0]?.options?.map((option) => option.optionId)).toEqual(
      options.slice(0, 9).map((option) => option.optionId),
    );
    expect(resolveAskOption(askId, "option-9")).toBe(false);
    expect(resolveAsk(askId, false)).toBe(true);
    await expect(pending).resolves.toEqual({ kind: "cancelled" });
  });
});

describe("createOperatorPermissionDecider: FAIL-CLOSED — timeout", () => {
  it("an unanswered ask resolves the precomputed denyDecision and emits settled(timeout) after timeoutMs", async () => {
    const bus = new ChatEventBus();
    const events = captureAsks(bus);
    const decide = createOperatorPermissionDecider("claude", bus, 10); // 10ms — real timer, bounded

    const pending = decide({ options: OPTIONS });
    await expect(pending).resolves.toEqual({ kind: "selected", optionId: "reject-once" });
    expect(events[1]).toEqual({
      kind: "permission.ask",
      agent: "claude",
      askId: events[0]?.askId,
      phase: "settled",
      outcome: "timeout",
    });
  });

  it("a response that arrives BEFORE the timeout wins — the registry guard makes a late timer fire a no-op", async () => {
    const bus = new ChatEventBus();
    const events = captureAsks(bus);
    const decide = createOperatorPermissionDecider("claude", bus, 50);
    const pending = decide({ options: OPTIONS });
    resolveAsk(events[0]?.askId ?? "", true);
    await expect(pending).resolves.toEqual({ kind: "selected", optionId: "allow-once" });
    await waitMs(70); // past the 50ms timeout window
    expect(events.filter((e) => e.phase === "settled")).toHaveLength(1);
    expect(events[1]?.outcome).toBe("approved"); // not overwritten by a late timeout
  });

  // RED-before-GREEN found this test WOULD pass even with clearTimeout deleted from settleAsk — the
  // registry-lookup guard above already makes a late-firing timer's settleAsk call a silent no-op, so
  // that test alone never proves the timer was actually CLEARED (vs. merely harmless once it fires).
  // clearTimeout still matters — a resolved-early ask that leaves its timer armed for the FULL
  // timeoutMs (5 minutes in production) leaks a live timer per ask until it eventually fires and
  // no-ops; in a long session with many quickly-resolved asks that is an unbounded pile-up. Fake
  // timers make the leak directly observable via the pending-timer count, independent of any
  it("an early settlement clears the timeout timer — no leaked timer left armed", () => {
    vi.useFakeTimers();
    try {
      const bus = new ChatEventBus();
      const events = captureAsks(bus);
      createOperatorPermissionDecider("claude", bus, 50_000)({ options: OPTIONS });
      expect(vi.getTimerCount()).toBe(1); // the armed timeout
      resolveAsk(events[0]?.askId ?? "", true);
      expect(vi.getTimerCount()).toBe(0); // cleared, not merely destined to no-op later
    } finally {
      vi.useRealTimers();
    }
  });
});

function waitMs(delayMs: number): Promise<void> {
  return new Promise(function resolveAfterDelay(resolve) {
    setTimeout(resolve, delayMs);
  });
}

describe("invalidatePendingAsk: FAIL-CLOSED — an ask outliving its turn", () => {
  it("force-denies the pending ask for the given agent and emits settled(invalidated)", async () => {
    const bus = new ChatEventBus();
    const events = captureAsks(bus);
    const pending = createOperatorPermissionDecider("codex", bus)({ options: OPTIONS });

    expect(invalidatePendingAsk("codex")).toBe(true);
    await expect(pending).resolves.toEqual({ kind: "selected", optionId: "reject-once" });
    expect(events[1]).toEqual({
      kind: "permission.ask",
      agent: "codex",
      askId: events[0]?.askId,
      phase: "settled",
      outcome: "invalidated",
    });
  });

  it("returns false and touches nothing when no ask is pending for that agent", () => {
    const bus = new ChatEventBus();
    const events = captureAsks(bus);
    expect(invalidatePendingAsk("claude")).toBe(false);
    expect(events).toEqual([]);
  });

  it("only invalidates the NAMED agent's ask — a different agent's pending ask is untouched", async () => {
    const bus = new ChatEventBus();
    const claudePending = createOperatorPermissionDecider("claude", bus)({ options: OPTIONS });
    createOperatorPermissionDecider("codex", bus)({ options: OPTIONS });

    expect(invalidatePendingAsk("codex")).toBe(true);
    expect(invalidatePendingAsk("claude")).toBe(true); // still there — proves it survived the codex call
    await expect(claudePending).resolves.toEqual({ kind: "selected", optionId: "reject-once" });
  });
});

describe("resetPermissionAskRegistry: test isolation", () => {
  it("a pending timer never fires after reset — no cross-test leakage", async () => {
    const bus = new ChatEventBus();
    const events = captureAsks(bus);
    createOperatorPermissionDecider("claude", bus, 10)({ options: OPTIONS });
    resetPermissionAskRegistry();
    await new Promise((r) => setTimeout(r, 30)); // past the 10ms window
    expect(events).toHaveLength(1); // only the original "pending" — no settled event ever fired
  });

  it("ask IDs remain unique after reset", () => {
    const bus = new ChatEventBus();
    const events = captureAsks(bus);
    createOperatorPermissionDecider("claude", bus)({ options: OPTIONS });
    resetPermissionAskRegistry();
    createOperatorPermissionDecider("claude", bus)({ options: OPTIONS });
    expect(events[1]?.askId).not.toBe(events[0]?.askId);
  });
});
