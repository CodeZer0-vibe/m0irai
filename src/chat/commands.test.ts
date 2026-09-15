/**
 * @file src/chat/commands.test.ts
 * @purpose Tests the createUserMessage factory — the only surviving export after the T10d-2 cutover
 *   removed the slash-command chain.
 * @exports (none)
 * @depends vitest, ./commands
 */
import { expect, it } from "vitest";

it("createUserMessage builds a completed user message with a token estimate", async () => {
  const { createUserMessage } = await import("./commands.js");

  const msg = createUserMessage(3, "hello world");

  expect(msg.turn).toBe(3);
  expect(msg.role).toBe("user");
  expect(msg.agent).toBe("user");
  expect(msg.text).toBe("hello world");
  expect(msg.status).toBe("completed");
  expect(msg.tokenEstimate).toBe(Math.ceil("hello world".length / 4));
  // Provably-unique id: epoch + role suffix + full UUIDv4 (collision-negligible within a single ms).
  expect(msg.id).toMatch(
    /^msg-\d+-user-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  expect(typeof msg.createdAt).toBe("string");
});

it("createUserMessage carries the dispatched fan-out set when provided (INV-EF7)", async () => {
  const { createUserMessage } = await import("./commands.js");
  const msg = createUserMessage(1, "@all go", ["claude", "codex", "gemini"]);
  expect(msg.dispatchedAgents).toEqual(["claude", "codex", "gemini"]);
});

it("createUserMessage omits dispatchedAgents when not provided (old two-arg callers unchanged)", async () => {
  const { createUserMessage } = await import("./commands.js");
  expect(createUserMessage(1, "hi").dispatchedAgents).toBeUndefined();
});
