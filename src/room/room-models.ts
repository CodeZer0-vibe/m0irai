/**
 * @file src/room/room-models.ts
 * @purpose Own the V2 room's live provider model catalog and selection boundary.
 * @exports RoomModelCatalog, RoomModelController, RoomModelRow
 * @depends node:fs/promises, node:path, ../adapters/agent-model-store, ../adapters/agy-models, ../adapters/pty/agy-models-run, ../chat/lane-transport, ../chat/types, ../shared/atomic-write, ./room-eager-sessions
 */
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { getAgentModel, setAgentModel } from "../adapters/agent-model-store.js";
import { parseAgyModels } from "../adapters/agy-models.js";
import { runAgyModels } from "../adapters/pty/agy-models-run.js";
import { laneModels, setLaneModel } from "../chat/lane-transport.js";
import type { AgentName } from "../chat/types.js";
import { writeFileAtomic } from "../shared/atomic-write.js";
import type { RoomEagerSessions } from "./room-eager-sessions.js";

export interface RoomModelRow {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface RoomModelCatalog {
  readonly version: 1;
  readonly agent: AgentName;
  readonly models: readonly RoomModelRow[];
  readonly currentModelId?: string;
}

interface RoomModelDeps {
  readonly eager: Pick<RoomEagerSessions, "wait">;
  readonly acpModels?: typeof laneModels;
  readonly setAcpModel?: typeof setLaneModel;
  readonly runGeminiModels?: () => Promise<string>;
  readonly runDir?: string;
}

const MODEL_SELECTION_FILE = "room-model-selections.json";
const MAX_MODEL_ID_BYTES = 4_096;

export class RoomModelController {
  private readonly catalogs = new Map<AgentName, RoomModelCatalog>();
  private persistedGeminiModel: string | undefined;

  public constructor(private readonly deps: RoomModelDeps) {}

  public async restore(): Promise<void> {
    setAgentModel("gemini", undefined);
    const candidate = await readGeminiSelection(this.deps.runDir);
    if (candidate === undefined) return;
    const advertised = await this.readGeminiModels().catch((): readonly string[] => []);
    if (advertised.length === 0) return;
    if (!advertised.includes(candidate)) {
      await clearGeminiSelection(this.deps.runDir);
      return;
    }
    this.persistedGeminiModel = candidate;
    setAgentModel("gemini", candidate);
  }

  public async list(agent: AgentName): Promise<RoomModelCatalog> {
    const catalog = agent === "gemini" ? await this.listGemini() : await this.listAcp(agent);
    this.catalogs.set(agent, catalog);
    return catalog;
  }

  public async select(agent: AgentName, modelId: string): Promise<RoomModelCatalog> {
    const catalog = this.catalogs.get(agent);
    if (catalog === undefined) throw new Error(`open the ${agent} model picker before selecting`);
    if (!catalog.models.some((model) => model.id === modelId)) {
      throw new Error(`${agent} did not advertise model ${modelId}`);
    }
    if (agent === "gemini") {
      await writeGeminiSelection(this.deps.runDir, modelId);
      this.persistedGeminiModel = modelId;
      setAgentModel(agent, modelId);
    } else {
      const outcome = await (this.deps.setAcpModel ?? setLaneModel)(agent, modelId);
      if (outcome.outcome !== "applied") {
        throw new Error(
          outcome.outcome === "failed" ? outcome.reason : `${agent} has no live model session`,
        );
      }
    }
    const selected = { ...catalog, currentModelId: modelId };
    this.catalogs.set(agent, selected);
    return selected;
  }

  private async listAcp(agent: "claude" | "codex"): Promise<RoomModelCatalog> {
    const warmup = await this.deps.eager.wait(agent);
    const live = (this.deps.acpModels ?? laneModels)(agent);
    if (live === undefined) {
      throw new Error(
        warmup.outcome === "unavailable" ? warmup.reason : `${agent} has no live model session`,
      );
    }
    return {
      version: 1,
      agent,
      models: live.models.map((model) => ({
        id: model.modelId,
        label: model.name,
        ...(model.description === undefined ? {} : { description: model.description }),
      })),
      ...(live.currentModelId === undefined ? {} : { currentModelId: live.currentModelId }),
    };
  }

  private async listGemini(): Promise<RoomModelCatalog> {
    const models = (await this.readGeminiModels()).map((model) => ({ id: model, label: model }));
    let currentModelId = this.persistedGeminiModel ?? getAgentModel("gemini");
    if (
      currentModelId !== undefined &&
      models.length > 0 &&
      !models.some((model) => model.id === currentModelId)
    ) {
      this.persistedGeminiModel = undefined;
      currentModelId = undefined;
      setAgentModel("gemini", undefined);
      await clearGeminiSelection(this.deps.runDir);
    }
    return {
      version: 1,
      agent: "gemini",
      models,
      ...(currentModelId !== undefined && models.some((model) => model.id === currentModelId)
        ? { currentModelId }
        : {}),
    };
  }

  private async readGeminiModels(): Promise<readonly string[]> {
    return parseAgyModels(await (this.deps.runGeminiModels ?? runAgyModels)());
  }
}

async function readGeminiSelection(runDir: string | undefined): Promise<string | undefined> {
  if (runDir === undefined) return getAgentModel("gemini");
  try {
    const parsed = JSON.parse(
      await readFile(path.join(runDir, MODEL_SELECTION_FILE), "utf8"),
    ) as unknown;
    if (!isSelectionFile(parsed)) return undefined;
    return parsed.gemini;
  } catch (error) {
    if (isMissingFile(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function writeGeminiSelection(runDir: string | undefined, modelId: string): Promise<void> {
  if (runDir === undefined) return;
  if (!isSafeModelId(modelId)) throw new Error("Gemini returned an invalid model identifier");
  await writeFileAtomic(
    path.join(runDir, MODEL_SELECTION_FILE),
    JSON.stringify({ version: 1, gemini: modelId }),
  );
}

async function clearGeminiSelection(runDir: string | undefined): Promise<void> {
  if (runDir === undefined) return;
  await rm(path.join(runDir, MODEL_SELECTION_FILE), { force: true });
}

function isSelectionFile(value: unknown): value is Readonly<{ version: 1; gemini: string }> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((key) => key === "version" || key === "gemini") &&
    record.version === 1 &&
    isSafeModelId(record.gemini)
  );
}

function isSafeModelId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_MODEL_ID_BYTES &&
    !hasUnsafeControl(value)
  );
}

function hasUnsafeControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
