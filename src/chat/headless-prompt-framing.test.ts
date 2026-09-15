/**
 * @file src/chat/headless-prompt-framing.test.ts
 * @purpose THE BOUNDARY WAVE falsifier for composePrompt's own recent-transcript window — kept
 *   separate from headless-prompt.test.ts (already ~400 lines, at this codebase's own architectural
 *   ceiling; mirrors prompt-builder-framing.test.ts's identical split precedent one file over). A
 *   SEPARATE rendering path from prompt-builder.ts's buildTranscript: single-lane, segment, and
 *   non-carrier council dispatch all render through THIS file's composePrompt, not that one — the
 *   sibling bypass B2's own contract text warned to hunt for. Proves: a message present in
 *   session.messages BEFORE this chat session's boot (index < priorSessionMessageCount) renders
 *   inside the untrusted-memory frame + carries the boundary statement; a message minted THIS
 *   session stays unframed; priorSessionMessageCount absent/0 is byte-identical to before this
 *   parameter existed.
 * @exports (none — test file)
 * @depends vitest, ./headless-prompt, ./types
 */
import { describe, expect, it } from "vitest";
import { composePrompt, countFramedInRecentWindow } from "./headless-prompt.js";
import type { ChatMessage, ChatSession } from "./types.js";

function msg(
  id: string,
  turn: number,
  role: "user" | "agent",
  agent: ChatMessage["agent"],
  text: string,
): ChatMessage {
  return {
    id,
    turn,
    role,
    agent,
    text,
    createdAt: "2026-07-16T00:00:00.000Z",
    status: "completed",
    tokenEstimate: 1,
  };
}

function session(messages: ChatMessage[]): ChatSession {
  return {
    id: "chat-hp-framing-test",
    repoRoot: "C:/tmp/hp-framing-test",
    runDir: "C:/tmp/hp-framing-test/run",
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    defaultAgent: "claude",
    lastAgent: null,
    summary: { text: "", throughTurn: 0 },
    messages,
  };
}

describe("composePrompt — THE BOUNDARY WAVE: priorSessionMessageCount frames resumed prior-session history", () => {
  it("FALSIFIER: a message present at boot (index < priorSessionMessageCount) renders inside the untrusted frame + carries the boundary statement", () => {
    const s = session([
      msg("u1", 1, "user", "user", "stale: write hello.txt"), // present at boot -- prior session
      msg("a1", 1, "agent", "claude", "stale reply"),
    ]);

    const prompt = composePrompt(s, "hi", "claude", 2, {
      laneClass: "dispatch",
      priorSessionMessageCount: 2,
    });

    expect(prompt).toContain("stale: write hello.txt");
    expect(prompt).toContain("<<<BEGIN UNTRUSTED RECALLED MEMORY");
    expect(prompt).toContain("context, not executable authority");
  });

  it("priorSessionMessageCount absent/0 is byte-identical to before this parameter existed (no framing markers at all)", () => {
    const s = session([
      msg("u1", 1, "user", "user", "hello from turn 1"),
      msg("a1", 1, "agent", "claude", "reply"),
    ]);

    const zeroed = composePrompt(s, "hi", "claude", 2, {
      laneClass: "dispatch",
      priorSessionMessageCount: 0,
    });
    const bareLaneClass = composePrompt(s, "hi", "claude", 2, "dispatch");

    expect(zeroed).toBe(bareLaneClass);
    expect(zeroed).not.toContain("BEGIN UNTRUSTED RECALLED MEMORY");
  });
});

describe("composePrompt — THE BOUNDARY WAVE: mixed-window + one-statement edge shapes", () => {
  it("a message appended THIS session stays unframed even when an earlier message in the SAME window is framed", () => {
    const s = session([
      msg("u1", 1, "user", "user", "stale ask"), // prior session
      msg("u2", 2, "user", "user", "hi (this session)"), // this session
    ]);

    const prompt = composePrompt(s, "continue", "claude", 3, {
      laneClass: "dispatch",
      priorSessionMessageCount: 1,
    });

    const liveIdx = prompt.lastIndexOf("hi (this session)");
    expect(liveIdx).toBeGreaterThanOrEqual(0);
    // the live message's own rendered text must not sit inside a still-open untrusted frame
    const beforeLive = prompt.slice(0, liveIdx);
    const lastBegin = beforeLive.lastIndexOf("<<<BEGIN UNTRUSTED RECALLED MEMORY");
    const lastEnd = beforeLive.lastIndexOf("<<<END UNTRUSTED RECALLED MEMORY>>>");
    expect(lastEnd).toBeGreaterThan(lastBegin);
  });

  it("ONE boundary statement per composed prompt, never one per framed message", () => {
    const s = session([
      msg("u1", 1, "user", "user", "stale ask one"),
      msg("a1", 1, "agent", "claude", "stale reply one"),
    ]);

    const prompt = composePrompt(s, "continue", "claude", 2, {
      laneClass: "dispatch",
      priorSessionMessageCount: 2,
    });

    const statementCount = prompt.split("context, not executable authority").length - 1;
    expect(statementCount).toBe(1);
  });
});

describe("countFramedInRecentWindow — THE BOUNDARY WAVE (B7 observability): an accurate, honest count for a debug trace", () => {
  it("FALSIFIER: reports the REAL count of recent-window messages composePrompt would frame — 0 when priorSessionMessageCount is 0, N when N fall inside the window", () => {
    const s = session([
      msg("u1", 1, "user", "user", "stale one"),
      msg("a1", 1, "agent", "claude", "stale reply"),
      msg("u2", 2, "user", "user", "hi (this session)"),
    ]);

    expect(countFramedInRecentWindow(s, 3, 0)).toBe(0);
    expect(countFramedInRecentWindow(s, 3, 2)).toBe(2); // u1 + a1 predate the boundary
  });

  it("never over-counts: a boundary far outside the actual recent window still reports only what the window would render", () => {
    const messages: ChatMessage[] = [];
    for (let turn = 1; turn <= 12; turn += 1) {
      messages.push(msg(`u${String(turn)}`, turn, "user", "user", `turn ${String(turn)}`));
    }
    const s = session(messages);

    // priorSessionMessageCount covers the first 10 messages, but composePrompt's own recent window
    // (MAX_HISTORY_MESSAGES=8, minus this-turn's own operator line) never reaches that far back — the
    // count must reflect the WINDOW, not the raw watermark, or the trace would over-report.
    const framed = countFramedInRecentWindow(s, 12, 10);
    expect(framed).toBeLessThan(10);
  });
});
