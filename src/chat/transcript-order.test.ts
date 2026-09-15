/**
 * @file src/chat/transcript-order.test.ts
 * @purpose Falsifier for the codex full-diff BLOCK at the leaf: canonicalTranscript is the ASK-ORDER view
 *   over arrival-ordered storage — after U1 per-lane writes, a slow turn-1 reply can persist AFTER turn-2's
 *   rows, and a raw slice would present the stale reply as the newest context. (The renderer that consumed
 *   this sort, prompt-builder's buildTranscript, left with the tower/debate cluster — m0irai 3.6.)
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./transcript-order, ./types
 */
import { describe, expect, it } from "vitest";
import { canonicalTranscript } from "./transcript-order.js";
import type { ChatMessage } from "./types.js";

const msg = (
  id: string,
  turn: number,
  role: "user" | "agent",
  agent: string,
  text: string,
): ChatMessage => ({
  id,
  turn,
  role,
  agent: agent as ChatMessage["agent"],
  text,
  createdAt: "2026-07-03T00:00:00.000Z",
  status: "completed",
  tokenEstimate: 1,
});

describe("canonicalTranscript — the leaf sort itself", () => {
  it("is a stable (turn asc, user-first) sort and never mutates its input", () => {
    const input: ChatMessage[] = [
      msg("a1", 2, "agent", "claude", "t2-reply"),
      msg("u1", 1, "user", "user", "t1-ask"),
      msg("a0", 1, "agent", "gemini", "t1-reply"),
    ];
    const snapshot = [...input];
    const out = canonicalTranscript(input);
    expect(out.map((m) => m.id)).toEqual(["u1", "a0", "a1"]);
    expect(input).toEqual(snapshot); // pure — input untouched
  });
});
