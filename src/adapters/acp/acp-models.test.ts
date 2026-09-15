/**
 * @file src/adapters/acp/acp-models.test.ts
 * @purpose Falsifiers for the ACP model extractor against BOTH live shapes — codex-acp
 *   (sess.models.availableModels) and claude-agent-acp (configOptions model select) — plus junk tolerance,
 *   de-dupe/required-field rules, and fetchAcpModels' fail-soft contract.
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./acp-models
 */
import { expect, it } from "vitest";
import { extractAcpModels, fetchAcpModels } from "./acp-models.js";
import type { AcpServerSpec } from "./acp-servers.js";

// codex-acp: sess.models.availableModels + currentModelId
const CODEX_SESS = {
  models: {
    availableModels: [
      { description: "Frontier model", modelId: "gpt-5.5[high]", name: "GPT-5.5 (high)" },
      { modelId: "gpt-5.4[low]", name: "GPT-5.4 (low)" },
    ],
    currentModelId: "gpt-5.5[high]",
  },
  sessionId: "x",
};

// claude-agent-acp: configOptions[ id:"model" ] select; the mode select must be ignored.
const CLAUDE_SESS = {
  configOptions: [
    {
      category: "mode",
      currentValue: "default",
      id: "mode",
      options: [{ name: "Default", value: "default" }],
    },
    {
      category: "model",
      currentValue: "default",
      id: "model",
      options: [
        { description: "Opus 4.8 · 1M", name: "Default (recommended)", value: "default" },
        { name: "Sonnet", value: "sonnet" },
      ],
    },
  ],
  sessionId: "y",
};

it("extracts the codex shape (sess.models.availableModels + currentModelId)", () => {
  const r = extractAcpModels(CODEX_SESS);
  expect(r.models.map((m) => m.modelId)).toEqual(["gpt-5.5[high]", "gpt-5.4[low]"]);
  expect(r.models[0]).toMatchObject({ description: "Frontier model", name: "GPT-5.5 (high)" });
  expect(r.currentModelId).toBe("gpt-5.5[high]");
});

it("extracts the claude shape (configOptions model select; ignores the mode select)", () => {
  const r = extractAcpModels(CLAUDE_SESS);
  expect(r.models.map((m) => m.modelId)).toEqual(["default", "sonnet"]);
  expect(r.models[0]).toMatchObject({
    description: "Opus 4.8 · 1M",
    name: "Default (recommended)",
  });
  expect(r.currentModelId).toBe("default");
});

it("returns empty for junk / missing / non-model shapes", () => {
  expect(extractAcpModels(null).models).toEqual([]);
  expect(extractAcpModels({}).models).toEqual([]);
  expect(extractAcpModels({ configOptions: [{ id: "mode", options: [] }] }).models).toEqual([]);
  expect(extractAcpModels({ models: { availableModels: "nope" } }).models).toEqual([]);
});

it("drops entries missing modelId or name, de-dupes by modelId", () => {
  const sess = {
    models: {
      availableModels: [
        { modelId: "a", name: "A" },
        { modelId: "", name: "blank-id" },
        { modelId: "b" },
        { modelId: "a", name: "dup" },
      ],
    },
  };
  expect(extractAcpModels(sess).models.map((m) => m.modelId)).toEqual(["a"]);
});

it("currentModelId is dropped when it names no listed model (no false anchor)", () => {
  const sess = {
    models: { availableModels: [{ modelId: "a", name: "A" }], currentModelId: "ghost" },
  };
  expect(extractAcpModels(sess).currentModelId).toBeUndefined();
});

it("fetchAcpModels parses an injected open + fails soft to empty on throw", async () => {
  const spec: AcpServerSpec = { agent: "codex", entry: "x", env: {} };
  await expect(fetchAcpModels(spec, async () => CODEX_SESS)).resolves.toMatchObject({
    currentModelId: "gpt-5.5[high]",
  });
  await expect(
    fetchAcpModels(spec, async () => {
      throw new Error("spawn fail");
    }),
  ).resolves.toEqual({ currentModelId: undefined, models: [] });
});
