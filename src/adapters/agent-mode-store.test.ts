/**
 * @file src/adapters/agent-mode-store.test.ts
 * @purpose Falsifiers for the per-agent chosen-native-mode singleton: independent per agent, set/get
 *   round-trips, undefined clears.
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./agent-mode-store
 */
import { afterEach, expect, it } from "vitest";
import { getAgentMode, setAgentMode } from "./agent-mode-store.js";

afterEach(() => {
  setAgentMode("claude", undefined);
  setAgentMode("codex", undefined);
  setAgentMode("gemini", undefined);
});

it("defaults to undefined for every agent", () => {
  expect(getAgentMode("claude")).toBeUndefined();
  expect(getAgentMode("codex")).toBeUndefined();
  expect(getAgentMode("gemini")).toBeUndefined();
});

it("sets + reads a mode per agent, independently", () => {
  setAgentMode("gemini", "accept-edits");
  setAgentMode("codex", "agent-full-access");
  expect(getAgentMode("gemini")).toBe("accept-edits");
  expect(getAgentMode("codex")).toBe("agent-full-access");
  expect(getAgentMode("claude")).toBeUndefined();
});

it("clears on undefined, leaving other agents untouched", () => {
  setAgentMode("gemini", "plan");
  setAgentMode("codex", "read-only");
  setAgentMode("gemini", undefined);
  expect(getAgentMode("gemini")).toBeUndefined();
  expect(getAgentMode("codex")).toBe("read-only");
});

it("clears on an empty string (never stores a blank flag value)", () => {
  setAgentMode("gemini", "plan");
  setAgentMode("gemini", "");
  expect(getAgentMode("gemini")).toBeUndefined();
});
