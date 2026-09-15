/**
 * @file src/chat/evidence-identity.ts
 * @purpose Round-aware chat evidence identity helpers.
 * @exports chatRunId, chatTaskId, chatCommandHash
 * @depends ../shared/crypto, ../shared/types, ./types
 */
import { sha256 } from "../shared/crypto.js";
import type { RunId, TaskId } from "../shared/types.js";
import type { AgentName } from "./types.js";

export function chatRunId(sessionId: string): RunId {
  return `run-${sessionId}` as RunId;
}

export function chatTaskId(
  sessionId: string,
  turn: number,
  agent: AgentName,
  round?: number,
): TaskId {
  if (round !== undefined) {
    return `BUILD-${sessionId}-${String(turn)}-r${String(round)}-${agent}` as TaskId;
  }
  return `BUILD-${sessionId}-${String(turn)}-${agent}` as TaskId;
}

export function chatCommandHash(agent: AgentName, turn: number, round?: number): string {
  const identity =
    round === undefined
      ? `chat-${agent}-${String(turn)}`
      : `chat-${agent}-${String(turn)}-r${String(round)}`;
  return sha256(identity);
}
