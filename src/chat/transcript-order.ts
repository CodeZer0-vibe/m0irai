/**
 * @file src/chat/transcript-order.ts
 * @purpose The ask-order view over the arrival-ordered transcript (a LEAF module — imports only types, so
 *   every consumer layer can use it without cycles; prompt-builder → session-store → evidence →
 *   prompt-builder was a real no-circular violation). U1 per-agent independence persists replies in
 *   completion order, so a slow turn-1 reply can land AFTER turn-2's rows; this STABLE sort by (turn asc,
 *   operator-prompt-before-replies within a turn) restores ask order. V8's sort is stable, so replies with
 *   equal keys keep their arrival order. Pure — returns a new array, never mutates.
 * @exports canonicalTranscript
 * @depends ./types
 */
import type { ChatMessage } from "./types.js";

export function canonicalTranscript(messages: readonly ChatMessage[]): readonly ChatMessage[] {
  return [...messages].sort(
    (a, b) => a.turn - b.turn || transcriptRoleRank(a) - transcriptRoleRank(b),
  );
}

// Within one turn the operator's prompt (user) sorts before the agent replies; agents keep their arrival order.
function transcriptRoleRank(message: ChatMessage): number {
  return message.role === "user" ? 0 : 1;
}
