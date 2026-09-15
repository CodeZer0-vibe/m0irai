import { describe, expect, it, vi } from "vitest";
import { ChatEventBus } from "./events.js";

// Quota-window lockstep (codex BLOCK class): the agent.status usage object carries fiveHourUsedPct +
// fiveHourResetsAtMs + weeklyUsedPct + weeklyResetsAtMs. ChatEventSchema's AgentUsageSchema is NOT
// .strict(), so a TS-only field absent from the schema is silently DROPPED on emit() — the 5h/weekly cells
// + countdown would never render. (events.test.ts is at its size cap, so the quota-window lockstep lives
// here; the contextUsedPct lockstep stays in events.test.ts.)
describe("agent.status usage — 5h + weekly quota fields survive the bus parse (lockstep)", () => {
  it("fiveHourUsedPct + fiveHourResetsAtMs + weeklyUsedPct + weeklyResetsAtMs reach a subscriber unchanged", () => {
    const bus = new ChatEventBus();
    const seen: {
      five: number | undefined;
      fiveResetsAt: number | undefined;
      week: number | undefined;
      weekResetsAt: number | undefined;
    }[] = [];
    bus.on("agent.status", (e) =>
      seen.push({
        five: e.usage?.fiveHourUsedPct,
        fiveResetsAt: e.usage?.fiveHourResetsAtMs,
        week: e.usage?.weeklyUsedPct,
        weekResetsAt: e.usage?.weeklyResetsAtMs,
      }),
    );
    bus.emit({
      kind: "agent.status",
      agent: "claude",
      auth: "ready",
      usage: {
        label: "53%",
        exhausted: false,
        fiveHourUsedPct: 32,
        fiveHourResetsAtMs: 1_782_298_800_000,
        weeklyUsedPct: 78,
        weeklyResetsAtMs: 1_782_475_200_000,
      },
    });
    expect(seen).toEqual([
      { five: 32, fiveResetsAt: 1_782_298_800_000, week: 78, weekResetsAt: 1_782_475_200_000 },
    ]);
  });
});

describe("agent.status usage — out-of-range quota fields make emit throw (range guards)", () => {
  it("a fiveHourUsedPct out of [0,100] makes emit throw (range guard)", () => {
    const bus = new ChatEventBus();
    const handler = vi.fn();
    bus.on("agent.status", handler);
    expect(() =>
      bus.emit({
        kind: "agent.status",
        agent: "claude",
        usage: { label: "x", exhausted: false, fiveHourUsedPct: 150 },
      }),
    ).toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it("a weeklyUsedPct out of [0,100] makes emit throw (range guard)", () => {
    const bus = new ChatEventBus();
    const handler = vi.fn();
    bus.on("agent.status", handler);
    expect(() =>
      bus.emit({
        kind: "agent.status",
        agent: "claude",
        usage: { label: "x", exhausted: false, weeklyUsedPct: 150 },
      }),
    ).toThrow();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("usage.payload outcome lockstep", () => {
  it("write-failed survives the bus parse for statusline/config diagnostics", () => {
    const bus = new ChatEventBus();
    const seen: string[] = [];
    bus.on("usage.payload", (event) => seen.push(event.outcome));

    bus.emit({
      agent: "claude",
      fields: ["reason"],
      kind: "usage.payload",
      outcome: "write-failed",
      source: "claude.statusline",
      turn: 1,
    });

    expect(seen).toEqual(["write-failed"]);
  });
});
