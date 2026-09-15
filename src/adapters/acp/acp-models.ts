/**
 * @file src/adapters/acp/acp-models.ts
 * @purpose Turn an ACP `newSession` response into a clean model list for the native /model picker (claude +
 *   codex have NO headless model-LIST command). extractAcpModels is PURE (both live shapes — codex
 *   `models.availableModels`, claude `configOptions`); fetchAcpModels wraps the handshake FAIL-SOFT ([] on
 *   error). Read FRESH each open — a model the CLI gains later appears. VERIFIED live 2026-06-27.
 * @exports AcpModel, AcpModelList, extractAcpModels, fetchAcpModels
 * @depends ./acp-servers, ./acp-session
 */
import type { AcpServerSpec } from "./acp-servers.js";
import { type AcpSession, openAcpNewSession } from "./acp-session.js";

const MAX_MODELS = 128; // hard cap so a runaway/garbage response can't grow the picker unbounded

/** One selectable model: `name` is shown to the operator, `modelId` is the value applied to the CLI. */
export interface AcpModel {
  readonly modelId: string;
  readonly name: string;
  readonly description?: string | undefined;
}

/** The agent's advertised model set + the one currently active (both may be absent → empty/undefined). */
export interface AcpModelList {
  readonly models: readonly AcpModel[];
  readonly currentModelId: string | undefined;
}

const EMPTY: AcpModelList = { models: [], currentModelId: undefined };

/**
 * Extracts the model list from a `newSession` response. NEVER throws — an unexpected shape yields []. The
 * live shape nests the list under `models.availableModels` (claude + codex); top-level `availableModels` is
 * tolerated as a fallback for spec-conformant agents.
 *
 * @param sess - the ACP newSession response (untrusted shape)
 * @returns the cleaned model list + the current model id
 */
export function extractAcpModels(sess: unknown): AcpModelList {
  const root = asRecord(sess);
  if (root === undefined) {
    return EMPTY;
  }
  // Shape A (codex-acp): sess.models.availableModels + currentModelId. Shape B (claude-agent-acp ≥0.49): a
  // spec-conformant `configOptions` select with id/category "model". Try A first, fall back to B.
  const fromModels = fromModelsNode(asRecord(root.models));
  return fromModels.models.length > 0 ? fromModels : fromModelSelect(root.configOptions);
}

// Shape A — codex-acp: { models: { availableModels: [{modelId,name,description}], currentModelId } }.
function fromModelsNode(node: Record<string, unknown> | undefined): AcpModelList {
  if (node === undefined || !Array.isArray(node.availableModels)) {
    return EMPTY;
  }
  const models = cleanModels(node.availableModels);
  return { models, currentModelId: pickCurrentId(node.currentModelId, models) };
}

// Shape B — claude-agent-acp: configOptions[ id|category === "model" ].{ options:[{value,name,description}],
// currentValue }. The option `value` is the model id applied to the CLI.
function fromModelSelect(configOptions: unknown): AcpModelList {
  if (!Array.isArray(configOptions)) {
    return EMPTY;
  }
  const modelOpt = configOptions
    .map(asRecord)
    .find((o): o is Record<string, unknown> => o !== undefined && isModelSelect(o));
  if (modelOpt === undefined || !Array.isArray(modelOpt.options)) {
    return EMPTY;
  }
  const models = cleanModels(modelOpt.options.map(toModelRecord));
  return { models, currentModelId: pickCurrentId(modelOpt.currentValue, models) };
}

function isModelSelect(opt: Record<string, unknown>): boolean {
  return opt.id === "model" || opt.category === "model";
}

// A configOption option {value,name,description} → the {modelId,name,description} cleanModels expects.
function toModelRecord(opt: unknown): Record<string, unknown> {
  const record = asRecord(opt);
  return { description: record?.description, modelId: record?.value, name: record?.name };
}

/**
 * Fetches the live model list via a real ACP handshake (the `open` seam — overridden in tests). FAIL-SOFT:
 * any error (spawn failure, timeout, auth, malformed) resolves to an empty list so the picker degrades to its
 * empty state instead of throwing into the cockpit.
 *
 * @param spec - which agent's ACP server to spawn + with what env
 * @param open - the session opener (defaults to the real spawn+handshake; a fake in tests)
 * @returns the parsed model list ([] on any failure)
 */
export async function fetchAcpModels(
  spec: AcpServerSpec,
  open: (spec: AcpServerSpec) => Promise<AcpSession> = openAcpNewSession,
): Promise<AcpModelList> {
  try {
    return extractAcpModels(await open(spec));
  } catch {
    return EMPTY;
  }
}

function cleanModels(rawList: readonly unknown[]): readonly AcpModel[] {
  const out: AcpModel[] = [];
  const seen = new Set<string>();
  for (const entry of rawList) {
    const record = asRecord(entry);
    const modelId = typeof record?.modelId === "string" ? record.modelId.trim() : "";
    const name = typeof record?.name === "string" ? record.name.trim() : "";
    if (modelId.length === 0 || name.length === 0 || seen.has(modelId)) {
      continue;
    }
    seen.add(modelId);
    const description = typeof record?.description === "string" ? record.description : undefined;
    out.push({ modelId, name, ...(description !== undefined ? { description } : {}) });
    if (out.length >= MAX_MODELS) {
      break;
    }
  }
  return out;
}

// The current id only counts if it actually names one of the listed models — else the picker has no anchor.
function pickCurrentId(raw: unknown, models: readonly AcpModel[]): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  return models.some((m) => m.modelId === raw) ? raw : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
