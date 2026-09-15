/** @file src/room/room-models.test.ts @purpose Verifies live model discovery and provider-applied selection. */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { getAgentModel, setAgentModel } from "../adapters/agent-model-store.js";
import { RoomModelController } from "./room-models.js";

afterEach(() => setAgentModel("gemini", undefined));

it("waits for the live ACP session, lists its models, and applies only an advertised selection", async () => {
  const wait = vi.fn(async () => ({ outcome: "ready" as const }));
  const setAcpModel = vi.fn(async () => ({ outcome: "applied" as const }));
  const controller = new RoomModelController({
    eager: { wait },
    acpModels: () => ({
      currentModelId: "sonnet",
      models: [
        { modelId: "sonnet", name: "Sonnet" },
        { modelId: "opus", name: "Opus", description: "Most capable" },
      ],
    }),
    setAcpModel,
  });

  await expect(controller.list("claude")).resolves.toEqual({
    version: 1,
    agent: "claude",
    currentModelId: "sonnet",
    models: [
      { id: "sonnet", label: "Sonnet" },
      { id: "opus", label: "Opus", description: "Most capable" },
    ],
  });
  await expect(controller.select("claude", "opus")).resolves.toMatchObject({
    currentModelId: "opus",
  });
  expect(setAcpModel).toHaveBeenCalledWith("claude", "opus");
  await expect(controller.select("claude", "invented")).rejects.toThrow("did not advertise");
  expect(setAcpModel).toHaveBeenCalledTimes(1);
});

it("uses Gemini's real model output and makes the selected model affect the next adapter turn", async () => {
  const controller = new RoomModelController({
    eager: { wait: async () => ({ outcome: "ready" }) },
    runGeminiModels: async () =>
      "Fetching available models...\rGemini 3.1 Pro (High)\nGemini 3.1 Flash (Low)\n",
  });
  await expect(controller.list("gemini")).resolves.toMatchObject({
    models: [
      { id: "Gemini 3.1 Pro (High)", label: "Gemini 3.1 Pro (High)" },
      { id: "Gemini 3.1 Flash (Low)", label: "Gemini 3.1 Flash (Low)" },
    ],
  });
  await controller.select("gemini", "Gemini 3.1 Flash (Low)");
  expect(getAgentModel("gemini")).toBe("Gemini 3.1 Flash (Low)");
});

it("keeps discovery failures distinct from a valid empty catalog", async () => {
  const unavailable = new RoomModelController({
    eager: { wait: async () => ({ outcome: "unavailable", reason: "auth expired" }) },
  });
  await expect(unavailable.list("codex")).rejects.toThrow("auth expired");

  const empty = new RoomModelController({
    eager: { wait: async () => ({ outcome: "ready" }) },
    acpModels: () => ({ models: [], currentModelId: undefined }),
  });
  await expect(empty.list("codex")).resolves.toMatchObject({ models: [] });
});

it("uses a recovered live ACP catalog after eager warm-up failed", async () => {
  const controller = new RoomModelController({
    eager: { wait: async () => ({ outcome: "unavailable", reason: "transient boot failure" }) },
    acpModels: () => ({
      currentModelId: "gpt-5.6-codex",
      models: [{ modelId: "gpt-5.6-codex", name: "GPT-5.6 Codex" }],
    }),
  });

  await expect(controller.list("codex")).resolves.toMatchObject({
    currentModelId: "gpt-5.6-codex",
  });
});

it("restores Gemini selection only from the continued room", async () => {
  const firstRoom = mkdtempSync(join(tmpdir(), "room-model-first-"));
  const secondRoom = mkdtempSync(join(tmpdir(), "room-model-second-"));
  const runGeminiModels = async () => "Gemini 3.1 Pro (High)\nGemini 3.1 Flash (Low)\n";
  try {
    const firstHost = new RoomModelController({
      eager: { wait: async () => ({ outcome: "ready" }) },
      runGeminiModels,
      runDir: firstRoom,
    });
    await firstHost.restore();
    await firstHost.list("gemini");
    await firstHost.select("gemini", "Gemini 3.1 Flash (Low)");

    setAgentModel("gemini", undefined);
    const continuedHost = new RoomModelController({
      eager: { wait: async () => ({ outcome: "ready" }) },
      runGeminiModels,
      runDir: firstRoom,
    });
    await continuedHost.restore();
    await expect(continuedHost.list("gemini")).resolves.toMatchObject({
      currentModelId: "Gemini 3.1 Flash (Low)",
    });
    expect(getAgentModel("gemini")).toBe("Gemini 3.1 Flash (Low)");

    const freshHost = new RoomModelController({
      eager: { wait: async () => ({ outcome: "ready" }) },
      runGeminiModels,
      runDir: secondRoom,
    });
    await freshHost.restore();
    await expect(freshHost.list("gemini")).resolves.not.toHaveProperty("currentModelId");
    expect(getAgentModel("gemini")).toBeUndefined();
  } finally {
    rmSync(firstRoom, { recursive: true, force: true });
    rmSync(secondRoom, { recursive: true, force: true });
  }
});

it("rejects and removes a persisted terminal-title model before it reaches Gemini argv state", async () => {
  const room = mkdtempSync(join(tmpdir(), "room-model-stale-"));
  const selectionPath = join(room, "room-model-selections.json");
  writeFileSync(
    selectionPath,
    JSON.stringify({
      version: 1,
      gemini: "]0;C:\\Users\\operator\\agy.exe gemini-3.7-flash-high Gemini 3.7 Flash (High)",
    }),
  );
  try {
    const controller = new RoomModelController({
      eager: { wait: async () => ({ outcome: "ready" }) },
      runGeminiModels: async () => "Gemini 3.7 Flash (High)\n",
      runDir: room,
    });
    await controller.restore();
    expect(getAgentModel("gemini")).toBeUndefined();
    expect(existsSync(selectionPath)).toBe(false);
  } finally {
    rmSync(room, { recursive: true, force: true });
  }
});

it("does not activate a persisted Gemini model when live validation is unavailable", async () => {
  const room = mkdtempSync(join(tmpdir(), "room-model-unverified-"));
  const selectionPath = join(room, "room-model-selections.json");
  writeFileSync(selectionPath, JSON.stringify({ version: 1, gemini: "Gemini 3.7 Flash (High)" }));
  try {
    const controller = new RoomModelController({
      eager: { wait: async () => ({ outcome: "ready" }) },
      runGeminiModels: async () => "",
      runDir: room,
    });
    await controller.restore();
    expect(getAgentModel("gemini")).toBeUndefined();
    expect(existsSync(selectionPath)).toBe(true);
  } finally {
    rmSync(room, { recursive: true, force: true });
  }
});
