/**
 * @file src/chat/evidence-identity.test.ts
 * @purpose Verifies round-aware chat evidence identity helpers.
 * @exports (none)
 * @depends vitest, ../shared/crypto, ./evidence-identity
 */
import { describe, expect, it } from "vitest";
import { sha256 } from "../shared/crypto.js";
import { chatCommandHash, chatTaskId } from "./evidence-identity.js";

const SESSION_ID: string = "chat-1700000000000";

describe("round-aware evidence identity helpers", () => {
  it("keep old identities when round is absent and add round when present", () => {
    expect(chatTaskId(SESSION_ID, 4, "codex")).toBe(`BUILD-${SESSION_ID}-4-codex`);
    expect(chatTaskId(SESSION_ID, 4, "codex", 2)).toBe(`BUILD-${SESSION_ID}-4-r2-codex`);
    expect(chatCommandHash("codex", 4)).toBe(sha256("chat-codex-4"));
    expect(chatCommandHash("codex", 4, 2)).toBe(sha256("chat-codex-4-r2"));
  });
});
