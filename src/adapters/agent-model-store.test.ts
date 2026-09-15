/**
 * @file src/adapters/agent-model-store.test.ts
 * @purpose Falsifiers for the per-agent chosen-model singleton: independent per agent, set/get round-trips,
 *   blank/whitespace clears, undefined clears.
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./agent-model-store
 */
import { afterEach, expect, it } from "vitest";
import { getAgentModel, setAgentModel } from "./agent-model-store.js";

afterEach(() => {
  setAgentModel("claude", undefined);
  setAgentModel("codex", undefined);
  setAgentModel("gemini", undefined);
});

it("defaults to undefined for every agent", () => {
  expect(getAgentModel("claude")).toBeUndefined();
  expect(getAgentModel("codex")).toBeUndefined();
  expect(getAgentModel("gemini")).toBeUndefined();
});

it("sets + reads a model per agent, independently", () => {
  setAgentModel("claude", "sonnet");
  setAgentModel("codex", "gpt-5.5[high]");
  expect(getAgentModel("claude")).toBe("sonnet");
  expect(getAgentModel("codex")).toBe("gpt-5.5[high]");
  expect(getAgentModel("gemini")).toBeUndefined();
});

it("clears on undefined or blank, leaving other agents untouched", () => {
  setAgentModel("claude", "haiku");
  setAgentModel("codex", "gpt-5.4[low]");
  setAgentModel("claude", undefined);
  expect(getAgentModel("claude")).toBeUndefined();
  expect(getAgentModel("codex")).toBe("gpt-5.4[low]");
  setAgentModel("codex", "   ");
  expect(getAgentModel("codex")).toBeUndefined();
});

it("trims surrounding whitespace", () => {
  setAgentModel("gemini", "  Gemini 3.5 Flash (Low)  ");
  expect(getAgentModel("gemini")).toBe("Gemini 3.5 Flash (Low)");
});
