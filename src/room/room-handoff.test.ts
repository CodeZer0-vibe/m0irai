import { expect, it } from "vitest";
import { MAX_ROOM_HANDOFF_TEXT_BYTES, extractRoomHandoff } from "./room-handoff.js";

it("falsifier: normal prose followed by a final handoff dispatches only the final line", () => {
  expect(
    extractRoomHandoff("claude", "I checked the implementation.\n\n@codex: review the diff"),
  ).toEqual({
    text: "I checked the implementation.",
    handoff: { target: "codex", text: "review the diff" },
  });
});

it("rejects self, empty, oversized, and unsafe final directives without dispatching", () => {
  for (const value of [
    "@claude: do it again",
    "@codex:   ",
    `@codex: ${"x".repeat(MAX_ROOM_HANDOFF_TEXT_BYTES + 1)}`,
    "@codex: unsafe\u001b request",
  ]) {
    expect(extractRoomHandoff("claude", value)).toEqual({ text: value });
  }
});
