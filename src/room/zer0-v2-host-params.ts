/**
 * @file src/room/zer0-v2-host-params.ts
 * @purpose The protocol boundary's pure input validation: every `params` object the room host accepts is
 *   proved well-formed here before any room state is touched, and `initializeResult` is the one capability
 *   advertisement. Split out of zer0-v2-host.ts, which owns lifecycle and writer serialization and had
 *   reached its line clamp — these functions share nothing with that state, take only their arguments, and
 *   are the surface a hostile client reaches first, so they are worth reading on their own.
 * @exports ROOM_VERSION, initializeResult, validateInitialize, validateSessionCreateParams, validateSessionLoadParams, requireRoomCwd, parseControl, parseModeCycle, parseModelAgent, requireSessionId
 * @depends node:fs/promises, node:path, ../chat/types, ./room-host, ./zer0-v2-rpc
 */
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { AgentName } from "../chat/types.js";
import type { RoomControl, RoomModeCycle } from "./room-host.js";
import { hasExactKeys, invalidParams, isRecord } from "./zer0-v2-rpc.js";

/** The one protocol version this host speaks, advertised by initializeResult and pinned by the marker file. */
export const ROOM_VERSION = 1;

export function initializeResult(): Readonly<Record<string, unknown>> {
  return {
    protocolVersion: ROOM_VERSION,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: {},
      mcpCapabilities: {},
      sessionCapabilities: { list: {} },
    },
    authMethods: [],
    agentInfo: { name: "zer0-v2-host", title: "Zer0 V2 Host", version: "0.1.0" },
    _meta: { "zer0.room": { version: ROOM_VERSION } },
  };
}

export function validateInitialize(params: Record<string, unknown>): void {
  if (params.protocolVersion !== ROOM_VERSION || !isRecord(params.clientCapabilities))
    throw invalidParams("initialize requires protocolVersion 1 and clientCapabilities object");
  if (params.clientInfo !== undefined && !isRecord(params.clientInfo))
    throw invalidParams("clientInfo must be an object");
}

export async function validateSessionCreateParams(
  params: Record<string, unknown>,
  repoRoot: string,
): Promise<void> {
  await requireRoomCwd(params.cwd, repoRoot);
  if (!Array.isArray(params.mcpServers) || params.mcpServers.length !== 0)
    throw invalidParams("mcpServers must be an empty array");
}

export async function validateSessionLoadParams(
  params: Record<string, unknown>,
  repoRoot: string,
): Promise<void> {
  await validateSessionCreateParams(params, repoRoot);
  if (typeof params.sessionId !== "string" || !/^chat-/u.test(params.sessionId))
    throw invalidParams("sessionId must be a chat session id");
}

export async function requireRoomCwd(value: unknown, repoRoot: string): Promise<void> {
  if (typeof value !== "string" || !path.isAbsolute(value))
    throw invalidParams("cwd must be absolute");
  let canonical: string;
  try {
    canonical = await realpath(value);
  } catch {
    throw invalidParams("cwd must name an existing directory");
  }
  if (canonical !== repoRoot) throw invalidParams("cwd must match the host project root");
}

export function parseControl(params: Record<string, unknown>, requestId: string): RoomControl {
  const command = params.command;
  if (command !== "pause" && command !== "resume" && command !== "cancel")
    throw invalidParams("unsupported room control command");
  const scope = params.scope;
  if (scope !== undefined && scope !== "latest" && scope !== "agent" && scope !== "all")
    throw invalidParams("unsupported room control scope");
  const agent = parseControlAgent(params.agent);
  if (scope === "agent" && agent === undefined) throw invalidParams("agent scope requires agent");
  if (command !== "cancel" && (scope !== undefined || agent !== undefined))
    throw invalidParams("scope and agent are valid only for cancellation");
  return {
    requestId,
    command,
    ...(scope === undefined ? {} : { scope }),
    ...(agent === undefined ? {} : { agent }),
  };
}

export function parseModeCycle(params: Record<string, unknown>, requestId: string): RoomModeCycle {
  if (
    !hasExactKeys(params, ["sessionId", "text"]) ||
    typeof params.sessionId !== "string" ||
    params.sessionId.length === 0 ||
    typeof params.text !== "string"
  )
    throw invalidParams("mode_cycle requires exactly sessionId and text");
  return { requestId, text: params.text };
}

export function parseModelAgent(
  params: Record<string, unknown>,
  keys: readonly string[],
): AgentName {
  if (!hasExactKeys(params, keys)) throw invalidParams("model request has unexpected fields");
  const agent = params.agent;
  if (agent !== "claude" && agent !== "codex" && agent !== "gemini") {
    throw invalidParams("model request requires claude, codex, or gemini");
  }
  return agent;
}

function parseControlAgent(value: unknown): AgentName | undefined {
  if (value === undefined) return undefined;
  if (value === "claude" || value === "codex" || value === "gemini") return value;
  throw invalidParams("unsupported room control agent");
}

export function requireSessionId(params: Record<string, unknown>): string {
  if (typeof params.sessionId !== "string" || params.sessionId.length === 0)
    throw invalidParams("sessionId is required");
  return params.sessionId;
}
