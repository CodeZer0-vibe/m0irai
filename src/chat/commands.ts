/**
 * @file src/chat/commands.ts
 * @purpose Message factory for the cockpit turn pipeline. After the T10d-2 cutover (REPL + slash
 *   command chain removed) the only surviving export is the user-message factory the cockpit's
 *   persist step (cockpit-turn-persist.ts) calls before each dispatch.
 * @exports createUserMessage
 * @depends ./message-id, ./prompt-budgeter, ./types
 */
import type { AgentName } from "../shared/types.js";
import { mintMessageId } from "./message-id.js";
import { estimatePromptTokens } from "./prompt-budgeter.js";
import type { ChatMessage } from "./types.js";

/** `dispatchedAgents` (U2e-c #8): the agents this user turn fanned out to (ChatRoute.agents), carried so a
 *  hard-killed lane resumes as `interrupted`. Omitted when absent, so old two-arg callers are unchanged. */
export function createUserMessage(
  turn: number,
  text: string,
  dispatchedAgents?: readonly AgentName[],
): ChatMessage {
  return {
    id: mintMessageId("user"),
    turn,
    role: "user",
    agent: "user",
    text,
    createdAt: new Date().toISOString(),
    status: "completed",
    tokenEstimate: estimatePromptTokens(text),
    dispatchRef: undefined,
    ...(dispatchedAgents !== undefined ? { dispatchedAgents } : {}),
  };
}
