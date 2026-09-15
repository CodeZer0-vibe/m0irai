import { expect, it } from "vitest";
import { normalizeAcpToolActivity } from "./acp-tool-activity.js";

it("falsifier: only provider-reported ACP tool calls preserve structural activity fields", () => {
  expect(
    normalizeAcpToolActivity({
      sessionUpdate: "tool_call",
      toolCallId: "tool-read-1",
      title: "Read src/room/room-host.ts",
      kind: "read",
      status: "in_progress",
      content: [{ type: "content", text: "must not escape" }],
      rawInput: { path: "must not escape" },
    }),
  ).toEqual({
    update: "tool_call",
    toolCallId: "tool-read-1",
    title: "Read src/room/room-host.ts",
    kind: "read",
    status: "in_progress",
  });
  expect(
    normalizeAcpToolActivity({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-read-1",
      title: "",
      kind: null,
      status: "completed",
      content: [],
    }),
  ).toEqual({ update: "tool_call_update", toolCallId: "tool-read-1", status: "completed" });
});

it("falsifier: ACP thought, text, usage, plan, unknown, and malformed updates never become activity", () => {
  for (const update of [
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "secret" } },
    { sessionUpdate: "usage_update", used: 2, size: 10 },
    { sessionUpdate: "plan", entries: [{ content: "invented work" }] },
    { sessionUpdate: "extension/update", toolCallId: "tool-1" },
    { sessionUpdate: "tool_call", toolCallId: "" },
    { sessionUpdate: "tool_call_update", title: "missing id" },
    null,
    "tool_call",
  ]) {
    expect(normalizeAcpToolActivity(update)).toBeUndefined();
  }
});
