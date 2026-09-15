// W4-R3a C1 (audit F13): the suite's ONE live-codex digest call, split out of digest-extractor.test.ts
// into its own file and registered in vitest.live-files.ts. It spawns the REAL codex binary and budgets
// 250s — in the 4-fork 30s unit pool it both blows that budget and starves under temporal-compile
// contention (the documented load-flake class, vitest.config.live.ts's own header). Registering it here
// is also what EXCLUDES it from the unit pool, so it runs exactly once, serialized, in the live pool.
// It fails when codex is down or unauthenticated; that is the seam gate telling the truth, not flake.
import { expect, it } from "vitest";
import type { ChatMessage } from "../chat/types.js";
import { createCodexDispatch, extractDigest } from "./digest-extractor.js";

const LIVE_MESSAGES: readonly ChatMessage[] = [
  {
    id: "live-1",
    turn: 1,
    role: "agent",
    agent: "codex",
    text: "We decided to use SQLite because the memory ledger must be local, durable, and simple to inspect.",
    createdAt: "t",
    status: "completed",
    tokenEstimate: 18,
  },
  {
    id: "live-2",
    turn: 2,
    role: "user",
    agent: "user",
    text: "Keep that decision in the digest so future runs remember why SQLite won.",
    createdAt: "t",
    status: "completed",
    tokenEstimate: 14,
  },
];

it("extractDigest works through the live codex exec seam (MT3g)", async () => {
  const result = await extractDigest(LIVE_MESSAGES, createCodexDispatch());
  if (!result.ok) {
    throw new Error(`live codex extraction failed: ${result.classification}: ${result.detail}`);
  }
  expect(result.ok).toBe(true);
  expect(Array.isArray(result.extraction.decisions)).toBe(true);
  expect(typeof result.extraction.summary).toBe("string");
  for (const decision of result.extraction.decisions) {
    expect(typeof decision.topic).toBe("string");
    expect(decision.topic.length).toBeGreaterThan(0);
    expect(typeof decision.body).toBe("string");
    expect(decision.body.length).toBeGreaterThan(0);
  }
}, 250_000);
