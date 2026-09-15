/**
 * @file src/chat/dispatch-pty.test.ts
 * @purpose Falsifying contract for the W1-T4a dispatch seam (codex review P0 #2): a typed pty turn
 *          failure (cap/abort/crash/overflow) must be THROWN as a DispatchError so runOneLane records
 *          a lane error (dispatch.failed) — never returned as a success-shaped result that the lane
 *          renders as a reply. A clean turn returns {exitCode:0, stdout:reply}. The session registry +
 *          fs are mocked so no real CLI spawns.
 * @exports (test suite — no runtime exports)
 * @depends vitest, ../shared/errors, ./pty-session, ./dispatch-pty (dynamic import after mocks)
 */
import { afterEach, expect, it, vi } from "vitest";
import type { AgentInput } from "../adapters/types.js";
import { CHAT_GRANT } from "../shared/agent-grant.js";

const submit = vi.fn();

vi.mock("node:fs", () => ({ readFileSync: () => "the prompt" }));
vi.mock("./pty-session-registry.js", () => ({
  getOrSpawnPtySession: () => ({ submit }),
}));

afterEach(() => {
  submit.mockReset();
});

function input(): AgentInput {
  return {
    agent: "claude",
    contextFile: "ctx.md",
    worktreePath: "C:/repo",
    signal: new AbortController().signal,
    grant: CHAT_GRANT,
  };
}

it("a clean turn returns exitCode 0 + the reply", async () => {
  submit.mockResolvedValue({ reply: "the answer" });
  const { dispatchPty } = await import("./dispatch-pty.js");
  const result = await dispatchPty(input());
  expect(result).toEqual({ exitCode: 0, stdout: "the answer" });
});

it("a marker-less cap THROWS DispatchError (never a success-shaped result — codex P0 #2)", async () => {
  const { PtyTurnCapError } = await import("./pty-session.js");
  const { DispatchError } = await import("../shared/errors.js");
  submit.mockRejectedValue(new PtyTurnCapError("turn exceeded 180000ms"));
  const { dispatchPty } = await import("./dispatch-pty.js");
  // FALSIFYING: returning {exitCode:1, stdout:msg} would resolve here and render as a reply.
  await expect(dispatchPty(input())).rejects.toBeInstanceOf(DispatchError);
});

it("an aborted turn THROWS DispatchError", async () => {
  const { PtyAbortError } = await import("./pty-session.js");
  const { DispatchError } = await import("../shared/errors.js");
  submit.mockRejectedValue(new PtyAbortError("aborted in flight"));
  const { dispatchPty } = await import("./dispatch-pty.js");
  await expect(dispatchPty(input())).rejects.toBeInstanceOf(DispatchError);
});

it("an unexpected (non-typed) error propagates unchanged", async () => {
  submit.mockRejectedValue(new RangeError("programming error"));
  const { dispatchPty } = await import("./dispatch-pty.js");
  await expect(dispatchPty(input())).rejects.toBeInstanceOf(RangeError);
});
