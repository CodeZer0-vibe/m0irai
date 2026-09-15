/**
 * @file src/chat/tower-bridge-lane.test.ts
 * @purpose B5 (memory DoS) falsifying suite for LaneObserver: an agent that streams unbounded output
 *          must NOT grow `accumulated`/`outputChunks` without bound — the observer caps at ~256KB and
 *          appends a single truncation marker. Also confirms B1: each observed proposal carries its
 *          raw payload (the real action), not just the forge-able title. Plus the cross-family-audit
 *          BLOCKs B1 (teeEvents isolation: a throwing observe() never drops a supervisor event) and B2
 *          (finalizeLane surfaces a swallowed evidence-write failure). Pure in-memory + mocked evidence.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterEvent, NativeAgentAdapter } from "./adapter-contract.js";
import { ChatEventBus } from "./events.js";
import { LaneObserver, finalizeLane, teeAdapter } from "./tower-bridge-lane.js";

const surfaced = vi.hoisted(() => ({
  // `err` captures the FIRST arg persistLane forwards to surfaceEvidenceFailure (CONCERN 4: the ORIGINAL
  // fused-writer error, not a generic synthetic one). `order` is a shared timeline the bus listeners and the
  // surface mock both push to, so a test can assert stdout → surface → terminal ordering under a failure.
  calls: [] as Array<{ op: string; err: unknown }>,
  order: [] as string[],
}));
const evidence = vi.hoisted(() => ({
  dispatchResult: "disp-1" as string | undefined,
  messageResult: "msg-1" as string | undefined,
  error: undefined as unknown,
}));

vi.mock("./evidence-failure.js", () => ({
  surfaceEvidenceFailure: vi.fn(async (err: unknown, op: string) => {
    surfaced.calls.push({ op, err });
    surfaced.order.push("surface");
  }),
}));

// B2-b1: persistLane now calls the ONE fused writer; its result carries both ids (undefined when the whole
// atomic record rolled back / swallowed) plus the original error on rollback (CONCERN 4). dispatchResult/
// messageResult/error drive the undefined-id + error-forwarding legs below.
vi.mock("./evidence.js", () => ({
  recordLaneTurnEvidence: vi.fn(async () => ({
    dispatchId: evidence.dispatchResult,
    messageId: evidence.messageResult,
    ...(evidence.error !== undefined ? { error: evidence.error } : {}),
  })),
}));

const CAP = 262_144;

// The finalize call the surface/order/CONCERN-4 tests share — one lane whose single output chunk is already
// observed. The caller owns the bus (so the order test can attach listeners first) and drives the evidence
// result via the hoisted `evidence` slots. Factored out of six identical inline copies.
async function runFinalize(bus: ChatEventBus, observer: LaneObserver): Promise<void> {
  await finalizeLane({
    bus,
    observer,
    turn: 1,
    prompt: "p",
    outputPath: "/tmp/out.txt",
    sessionId: "chat-1",
    repoRoot: "/repo",
    config: { dbPath: "/tmp/db", blobRoot: "/tmp/blobs" },
    durationMs: 5,
  });
}

describe("LaneObserver B5: bounded accumulation under a flood", () => {
  it("caps accumulated + chunks no matter how many large chunks arrive", () => {
    const observer = new LaneObserver("codex");
    const chunk = "x".repeat(10_000);
    for (let i = 0; i < 10_000; i += 1) {
      observer.observe({ kind: "output", text: chunk });
    }
    const outcome = observer.outcome();
    // accumulated is bounded: ≤ cap + a short marker, NOT 100,000,000 chars.
    expect(outcome.text.length).toBeLessThanOrEqual(CAP + 64);
    expect(outcome.text).toContain("output truncated");
    // chunks no longer grow unbounded once truncated — far fewer than the 10,000 emitted.
    expect(observer.outputChunks().length).toBeLessThan(10_000);
  });

  it("does not truncate output that stays under the cap", () => {
    const observer = new LaneObserver("codex");
    observer.observe({ kind: "output", text: "hello " });
    observer.observe({ kind: "output", text: "world" });
    expect(observer.outcome().text).toBe("hello world");
    expect(observer.outcome().text).not.toContain("output truncated");
  });
});

describe("LaneObserver B1: proposals carry the raw payload", () => {
  it("records the payload (the real action), not just the title", () => {
    const observer = new LaneObserver("codex");
    observer.observe({
      kind: "proposal",
      proposal: {
        correlationId: "c1",
        kind: "command",
        title: "npm test",
        payload: { command: "rm -rf /etc" },
      },
    });
    const proposal = observer.proposals()[0];
    expect(proposal?.payload).toEqual({ command: "rm -rf /etc" });
    expect(proposal?.kind).toBe("command");
  });
});

// B1 (cross-family audit): teeEvents must isolate observer.observe() — a hostile adapter event whose
// getter throws inside observe() must STILL be yielded to the supervisor (else gating/finalization
// silently breaks). Drives the real teeAdapter; the supervisor side is a plain async-for consumer.
function streamOf(events: readonly AdapterEvent[]): NativeAgentAdapter {
  return {
    start: async () => undefined,
    events: () =>
      (async function* () {
        for (const e of events) yield e;
      })(),
    decide: async () => undefined,
    steer: async () => undefined,
    close: async () => undefined,
  };
}

describe("teeAdapter B1: a throwing observe() never drops a supervisor event", () => {
  it("yields the event to the supervisor even when observe() throws on a hostile getter", async () => {
    const observer = new LaneObserver("codex");
    // A hostile proposal event whose `proposal` getter throws when observe() reads it. Built via
    // defineProperty on a kind-tagged base so it is a real AdapterEvent shape (no double-cast forge).
    const hostile: AdapterEvent = Object.defineProperty(
      { kind: "proposal" } as AdapterEvent,
      "proposal",
      {
        enumerable: true,
        get(): never {
          throw new Error("hostile getter");
        },
      },
    );
    const benign: AdapterEvent = { kind: "turn_end" };
    const teed = teeAdapter(streamOf([hostile, benign]), observer);

    const received: string[] = [];
    for await (const event of teed.events()) {
      received.push(event.kind);
    }
    // The supervisor received BOTH events — the throwing observe did not drop the hostile one.
    expect(received).toEqual(["proposal", "turn_end"]);
    // The observe error was surfaced (captured), not swallowed silently.
    expect(observer.observeErrors().length).toBeGreaterThan(0);
  });
});

describe("finalizeLane B2: a swallowed evidence-write failure is surfaced (INV-8)", () => {
  afterEach(() => {
    surfaced.calls.length = 0;
    surfaced.order.length = 0;
    evidence.dispatchResult = "disp-1";
    evidence.messageResult = "msg-1";
    evidence.error = undefined;
  });

  it("surfaceEvidenceFailure fires when the fused writer returns no dispatch id (INV-8)", async () => {
    evidence.dispatchResult = undefined; // the atomic writer rolled back / swallowed → no dispatch id
    const { ChatEventBus } = await import("./events.js");
    const observer = new LaneObserver("codex");
    observer.observe({ kind: "output", text: "ok" });

    await runFinalize(new ChatEventBus(), observer);

    expect(surfaced.calls.some((c) => c.op.includes("recordLaneTurnEvidence"))).toBe(true);
  });

  it("does NOT surface a failure when the fused writer returns a dispatch id", async () => {
    evidence.dispatchResult = "disp-1";
    const { ChatEventBus } = await import("./events.js");
    const observer = new LaneObserver("codex");
    observer.observe({ kind: "output", text: "ok" });

    await runFinalize(new ChatEventBus(), observer);

    expect(surfaced.calls.some((c) => c.op.includes("recordLaneTurnEvidence"))).toBe(false);
  });
});

// B4 (cross-family audit): the fused writer SWALLOWS its own write error internally and resolves with no
// message id, so a bare `.catch()` never fires on the real failure path. Tower evidence is MANDATORY
// (INV-8) — a missing message id must be surfaced via surfaceEvidenceFailure, exactly like the dispatch id (B2).
describe("finalizeLane B4: a swallowed fused-writer message-row failure is surfaced (INV-8)", () => {
  afterEach(() => {
    surfaced.calls.length = 0;
    surfaced.order.length = 0;
    evidence.dispatchResult = "disp-1";
    evidence.messageResult = "msg-1";
    evidence.error = undefined;
  });

  it("surfaceEvidenceFailure fires when the fused writer returns no message id (INV-8)", async () => {
    evidence.messageResult = undefined; // the atomic writer rolled back / swallowed → no message id
    const { ChatEventBus } = await import("./events.js");
    const observer = new LaneObserver("codex");
    observer.observe({ kind: "output", text: "ok" });

    await runFinalize(new ChatEventBus(), observer);

    expect(surfaced.calls.some((c) => c.op.includes("recordLaneTurnEvidence"))).toBe(true);
  });

  it("does NOT surface a failure when the fused writer returns a message id", async () => {
    evidence.messageResult = "msg-1";
    const { ChatEventBus } = await import("./events.js");
    const observer = new LaneObserver("codex");
    observer.observe({ kind: "output", text: "ok" });

    await runFinalize(new ChatEventBus(), observer);

    expect(surfaced.calls.some((c) => c.op.includes("recordLaneTurnEvidence"))).toBe(false);
  });
});

// B2-b1 SEAL (review BLOCK 2): the P0 ordering guarantee holds EVEN under a swallowed evidence failure —
// finalizeLane emits agent.stdout, then persists+surfaces the (failed) evidence write, and only THEN emits
// the green terminal. A dispatch.completed is never signaled ahead of its evidence write, so the operator
// never sees a green terminal whose turn-record silently rolled back.
describe("finalizeLane bus order under an evidence failure (P0: surface before the green terminal)", () => {
  afterEach(() => {
    surfaced.calls.length = 0;
    surfaced.order.length = 0;
    evidence.dispatchResult = "disp-1";
    evidence.messageResult = "msg-1";
    evidence.error = undefined;
  });

  it("emits agent.stdout, surfaces the swallowed failure, THEN dispatch.completed — in that order", async () => {
    evidence.dispatchResult = undefined; // the fused writer rolled back / swallowed → no dispatch id
    const { ChatEventBus } = await import("./events.js");
    const bus = new ChatEventBus();
    // the surface mock pushes "surface" to surfaced.order; the bus listeners push into the SAME timeline.
    bus.on("agent.stdout", () => surfaced.order.push("stdout"));
    bus.on("dispatch.completed", () => surfaced.order.push("completed"));
    const observer = new LaneObserver("codex");
    observer.observe({ kind: "output", text: "ok" });

    await runFinalize(bus, observer);

    expect(surfaced.order).toEqual(["stdout", "surface", "completed"]);
  });
});

// B2-b1 SEAL (review CONCERN 4): when the fused writer swallows an FK rollback, persistLane must forward the
// ORIGINAL error to surfaceEvidenceFailure — a generic synthetic Error degrades the operator-facing reason to
// 'unknown' when it is really schema-drift. This asserts the forwarding by identity; the FK→schema-drift
// classification itself is proven in evidence-failure.test.ts.
describe("finalizeLane CONCERN 4: the ORIGINAL fused-writer error is forwarded to surfacing", () => {
  afterEach(() => {
    surfaced.calls.length = 0;
    surfaced.order.length = 0;
    evidence.dispatchResult = "disp-1";
    evidence.messageResult = "msg-1";
    evidence.error = undefined;
  });

  it("forwards the writer's original error to surfaceEvidenceFailure (not a generic synthetic one)", async () => {
    const fkError = Object.assign(new Error("FOREIGN KEY constraint failed"), {
      code: "SQLITE_CONSTRAINT_FOREIGNKEY",
    });
    evidence.dispatchResult = undefined; // rolled back → no ids
    evidence.messageResult = undefined;
    evidence.error = fkError; // the writer now carries the ORIGINAL error on its rollback result
    const { ChatEventBus } = await import("./events.js");
    const observer = new LaneObserver("codex");
    observer.observe({ kind: "output", text: "ok" });

    await runFinalize(new ChatEventBus(), observer);

    const call = surfaced.calls.find((c) => c.op.includes("recordLaneTurnEvidence"));
    expect(call?.err).toBe(fkError); // the ORIGINAL error, forwarded by identity — not a generic Error
  });
});

describe("LaneObserver per-lane timing (the REAL per-agent dispatch duration)", () => {
  it("activeMs is the live first→last observed-event window, NOT the turn total", () => {
    let now = 0;
    const observer = new LaneObserver("claude", () => now);
    now = 1000;
    observer.observe({ kind: "output", text: "a" });
    now = 4500;
    observer.observe({ kind: "output", text: "b" });
    expect(observer.activeMs()).toBe(3500); // 4500 − 1000 (this lane's own window)
  });

  it("activeMs is 0 when no event was observed", () => {
    expect(new LaneObserver("codex", () => 7).activeMs()).toBe(0);
  });

  it("hasWindow: false for <2 events, true for ≥2 (a window needs two endpoints, distinct from a 0ms value)", () => {
    const observer = new LaneObserver("claude", () => 0);
    expect(observer.hasWindow()).toBe(false);
    observer.observe({ kind: "output", text: "a" });
    expect(observer.hasWindow()).toBe(false); // 1 event = no window
    observer.observe({ kind: "output", text: "b" });
    expect(observer.hasWindow()).toBe(true); // 2 events = a window (even if same ms)
  });
});

async function completedDurationMs(
  observer: LaneObserver,
  inputDurationMs: number,
): Promise<number[]> {
  const bus = new ChatEventBus();
  const completed: number[] = [];
  bus.on("dispatch.completed", (event) => completed.push(event.durationMs));
  await finalizeLane({
    bus,
    observer,
    turn: 1,
    prompt: "p",
    outputPath: "/tmp/out.txt",
    sessionId: "chat-1",
    repoRoot: "/repo",
    config: { dbPath: "/tmp/db", blobRoot: "/tmp/blobs" },
    durationMs: inputDurationMs,
  });
  return completed;
}

describe("finalizeLane per-lane duration (window vs elapsed fallback)", () => {
  it("a streamed window (≥2 events) → the live per-lane activeMs, NOT the turn-level durationMs", async () => {
    let now = 0;
    const observer = new LaneObserver("claude", () => now);
    now = 100;
    observer.observe({ kind: "output", text: "hi" });
    now = 2100;
    observer.observe({ kind: "output", text: "done" });
    expect(await completedDurationMs(observer, 99_999)).toEqual([2000]); // window, NOT turn-level
  });

  it("a single-observe lane (headless/silent, <2 events) → the elapsed input.durationMs fallback", async () => {
    const observer = new LaneObserver("codex", () => 1234);
    observer.observe({ kind: "output", text: "the whole buffered result" });
    expect(observer.hasWindow()).toBe(false);
    expect(await completedDurationMs(observer, 4200)).toEqual([4200]); // fallback, NOT 0
  });

  it("a fast streamed lane (≥2 events in the SAME ms) → its real ~0ms window, NOT the turn total (falsy-0 trap)", async () => {
    const observer = new LaneObserver("gemini", () => 5000); // both events at one tick
    observer.observe({ kind: "output", text: "a" });
    observer.observe({ kind: "output", text: "b" });
    expect(observer.hasWindow()).toBe(true);
    expect(observer.activeMs()).toBe(0);
    expect(await completedDurationMs(observer, 99_999)).toEqual([0]); // real 0, NOT 99999
  });
});

it("uses a caller-preassigned output identity without changing legacy minting", async () => {
  const observer = new LaneObserver("codex");
  observer.observe({ kind: "output", text: "answer" });
  const outcome = await finalizeLane({
    bus: new ChatEventBus(),
    observer,
    turn: 1,
    prompt: "p",
    outputPath: "/tmp/out.txt",
    sessionId: "chat-1",
    repoRoot: "/repo",
    config: { dbPath: "/tmp/db", blobRoot: "/tmp/blobs" },
    durationMs: 1,
    messageId: "msg-room-durable",
  });
  expect(outcome.messageId).toBe("msg-room-durable");
});
