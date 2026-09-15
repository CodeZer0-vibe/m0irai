/**
 * @file src/chat/headless-turn-errors.test.ts
 * @purpose Falsifies durable failure sanitization and honest headless lane terminal classification.
 * @exports (test suite - no runtime exports)
 * @depends vitest, ./headless-turn
 */
import { describe, expect, it } from "vitest";
import { classifyLaneError, laneOutcomeMessage } from "./headless-turn.js";

const abortedSignal = (): AbortSignal => {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
};

const liveSignal = (): AbortSignal => new AbortController().signal;

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

it("falsifier: durable failed messages escape controls and bound provider diagnostics", () => {
  const message = laneOutcomeMessage(1, {
    agent: "gemini",
    text: "",
    exitCode: 1,
    state: "failed",
    error: `boom\u001b[31m\n\u202e${"x".repeat(2_000)}`,
    messageId: "failure-message",
  });
  expect(message.text).toContain("\\x1b[31m\\n\\u202e");
  expect(message.text).not.toContain("\u001b");
  expect(message.text).not.toContain("\u202e");
  expect(message.text.length).toBeLessThan(1_200);
});

describe("classifyLaneError: a dispatch failure carries its honest terminal", () => {
  it("classifies an aborted signal as cancelled even when the error resembles a crash", () => {
    expect(classifyLaneError(new Error("write EPIPE"), abortedSignal())).toBe("cancelled");
  });

  it("classifies typed, wrapped, and raw timeout signals as timed_out", () => {
    expect(classifyLaneError(Object.assign(new Error("x"), { timedOut: true }), liveSignal())).toBe(
      "timed_out",
    );
    expect(
      classifyLaneError(
        new Error("timed out: no output for 900000ms - agent appears hung"),
        liveSignal(),
      ),
    ).toBe("timed_out");
    expect(
      classifyLaneError(new Error("no output for 900000ms - agent appears hung"), liveSignal()),
    ).toBe("timed_out");
    expect(classifyLaneError(namedError("PtyTurnCapError", "no output"), liveSignal())).toBe(
      "timed_out",
    );
  });

  it("classifies every other failure as failed", () => {
    expect(classifyLaneError(new Error("adapter exited 1"), liveSignal())).toBe("failed");
    expect(classifyLaneError("string blew up", liveSignal())).toBe("failed");
  });
});
