/**
 * @file src/room/room-readiness-service.test.ts
 * @exports (test suite — no runtime exports)
 * @depends vitest, ../chat/agent-readiness, ./room-readiness-service
 * @purpose The room's one owner of the readiness record, as a unit. The end-to-end routing behaviour is
 *   contracted against a real host in room-readiness-routing.test.ts; this file is about the decisions
 *   themselves, and about the two properties that only look like implementation detail.
 *
 *   THE RECORD IS REPLACED WHOLE, NEVER MUTATED. That is not tidiness — a reader must see the whole old
 *   record or the whole new one, and `submit` reads it synchronously from a different call stack than
 *   the probe that writes it.
 *
 *   AND THE PROBE IS NEVER AWAITED. A room that could be made to wait for a subprocess before its first
 *   turn is the latency this whole design exists to avoid.
 */
import { expect, it } from "vitest";
import type { RoomReadiness } from "../chat/agent-readiness.js";
import { RoomReadinessService } from "./room-readiness-service.js";

const GEMINI_MISSING: RoomReadiness = {
  claude: { state: "ready" },
  codex: { state: "needs_login", command: "codex login" },
  gemini: {
    state: "unusable",
    reason: "the Antigravity CLI is not installed",
    remedy: "install the Antigravity CLI",
  },
};

const ALL = ["claude", "codex", "gemini"] as const;

it("PIN: a fresh service knows nothing, and nothing is filtered", () => {
  const service = new RoomReadinessService();

  // The race, as a unit: a submit that beats the probe reads THIS record. `unknown` is not `unusable`,
  // so it dispatches exactly the three agents the room dispatches today. There is no window in which
  // the room refuses an agent it has not measured.
  expect(service.dispatchable(ALL)).toEqual(["claude", "codex", "gemini"]);
  expect(service.unusableAgents()).toEqual([]);
  expect(service.refusalFor("gemini")).toBeUndefined();
});

it("FALSIFIER: needs_login STAYS in @all and unusable does not", () => {
  const service = new RoomReadinessService();
  service.adopt(GEMINI_MISSING);

  // Not one rule with an exception — two different facts. A needs_login lane fails immediately and
  // carries its remedy into the failure row, which teaches the operator something. An unusable agent
  // produces a failure row per turn and teaches them nothing they did not already know.
  expect(service.dispatchable(ALL)).toEqual(["claude", "codex"]);
  expect(service.unusableAgents()).toEqual(["gemini"]);
});

it("PIN: the filter preserves ORDER", () => {
  const service = new RoomReadinessService();
  service.adopt({
    claude: {
      state: "unusable",
      reason: "not resolved",
      remedy: "npm ci in the m0irai install",
    },
    codex: { state: "ready" },
    gemini: { state: "ready" },
  });

  // `@all` has a stable order and the transcript is written in it. A filter that reordered would
  // reorder the room.
  expect(service.dispatchable(ALL)).toEqual(["codex", "gemini"]);
});

it("FALSIFIER: an explicit address is honoured or answered, never silently dropped", () => {
  const service = new RoomReadinessService();
  service.adopt(GEMINI_MISSING);

  expect(service.resolveTargets("agent", ["gemini"])).toEqual({
    kind: "refused",
    reason:
      "gemini is unavailable — the Antigravity CLI is not installed. install the Antigravity CLI",
  });
  // A needs_login agent addressed by name still gets its lane: the failure is then real, immediate and
  // carries its remedy.
  expect(service.resolveTargets("agent", ["codex"])).toEqual({
    kind: "dispatch",
    agents: ["codex"],
  });
});

it("FALSIFIER: with nothing left, the refusal names EVERY agent and its fix", () => {
  const service = new RoomReadinessService();
  service.adopt({
    claude: { state: "unusable", reason: "not resolved", remedy: "npm ci" },
    codex: { state: "unusable", reason: "not resolved", remedy: "npm ci" },
    gemini: { state: "unusable", reason: "not installed", remedy: "install the Antigravity CLI" },
  });

  const resolved = service.resolveTargets("all", ALL);
  expect(resolved.kind).toBe("refused");
  const reason = resolved.kind === "refused" ? resolved.reason : "";
  // An operator with three broken agents needs three fixes. A message naming one is a message they act
  // on once and come back from.
  for (const agent of ALL) expect(reason).toContain(agent);
});

it("FALSIFIER: the record is replaced whole and frozen, never mutated in place", () => {
  const service = new RoomReadinessService();
  const mutable: RoomReadiness = {
    claude: { state: "ready" },
    codex: { state: "ready" },
    gemini: { state: "ready" },
  };
  service.adopt(mutable);
  const held = service.current();

  expect(Object.isFrozen(held)).toBe(true);
  expect(Object.isFrozen(held.gemini)).toBe(true);
  // Adopting a record the caller still holds must not give them a live handle on the room's state.
  // Node is single-threaded so this is not a lock; it is the absence of a partially-written object,
  // which is the only hazard here.
  expect(() => {
    (held as { claude: unknown }).claude = { state: "unusable" };
  }).toThrow();
  expect(service.current().claude).toEqual({ state: "ready" });

  service.adopt(GEMINI_MISSING);
  expect(service.current()).not.toBe(held);
  expect(service.current().gemini).toMatchObject({ state: "unusable" });
});

it("FALSIFIER: start() returns immediately and a probe failure leaves everything unknown", async () => {
  const service = new RoomReadinessService();
  const started = Date.now();

  const running = service.start({
    sink: { debug: () => undefined },
    // A resolver that hangs is the shape that matters: if `start` awaited anything, this would sit
    // here and so would the room's first frame.
    resolveClaudeBinary: () => {
      throw new Error("no claude");
    },
    resolveCodexPackage: () => {
      throw new Error("no codex");
    },
    agyExists: () => {
      throw new Error("no filesystem");
    },
  });

  // The record is readable RIGHT NOW, before the probe settles, and it is the all-unknown one.
  expect(Date.now() - started).toBeLessThan(50);
  expect(service.current().claude).toEqual({ state: "unknown" });

  await running;
  // gemini's probe THREW, so it stays unknown — a broken instrument is not evidence about an agent.
  expect(service.current().gemini).toEqual({ state: "unknown" });
  // claude and codex did not throw; they answered, and the answer was a real unusable.
  expect(service.current().claude).toMatchObject({ state: "unusable" });
});

it("PIN: two callers of start() share one probe run", async () => {
  const service = new RoomReadinessService();
  let runs = 0;
  const deps = {
    sink: { debug: () => undefined },
    resolveClaudeBinary: () => {
      runs += 1;
      return "C:/claude.exe";
    },
    resolveCodexPackage: () => "C:/codex/package.json",
    runClaudeAuthStatus: async () => ({ stdout: '{"loggedIn":true}', exitCode: 0 }),
    agyExists: () => true,
  };

  await Promise.all([service.start(deps), service.start(deps)]);

  // Idempotent by the returned promise, not by a flag: a second caller gets the same run rather than a
  // second spawn of the operator's CLI.
  expect(runs).toBe(1);
  expect(service.current().claude).toEqual({ state: "ready" });
});
