/**
 * @file src/chat/message-id.test.ts
 * @purpose Proves chat message ids are provably unique even when minted in the same millisecond,
 *   so that two same-agent replies both survive the dedup-by-id per-agent merge in controller-council.
 * @exports (none)
 * @depends vitest, ./message-id, ./commands
 */
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.resetModules();
});

it("mints distinct ids for two calls in the same millisecond (clock frozen)", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  const { mintMessageId } = await import("./message-id.js");

  const first = mintMessageId("codex");
  const second = mintMessageId("codex");

  // Both share the frozen Date.now() portion; the contract is they are STILL distinct.
  expect(first).not.toBe(second);
  const uuidTail = /^msg-\d+-codex-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  expect(first).toMatch(uuidTail);
  expect(second).toMatch(uuidTail);
});

it("two user messages created in the same ms keep distinct ids — merge would not drop either", async () => {
  // RED against the old `msg-${Date.now()}-user`: with the clock frozen both ids collide and a
  // dedup-by-id merge (controller-council per-agent merge) silently drops one. Unique suffix keeps both.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  const { createUserMessage } = await import("./commands.js");

  const a = createUserMessage(0, "first");
  const b = createUserMessage(0, "second");

  expect(a.id).not.toBe(b.id);
  // the per-agent merge dedups via a Set of ids; distinct ids => both survive.
  const survivors = new Set([a.id, b.id]);
  expect(survivors.size).toBe(2);
});
