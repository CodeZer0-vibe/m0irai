/**
 * @file src/shared/agent-grant.ts
 * @purpose The adapter-owned capability grant (X0 lane-class retirement): replaces the chat/research/build
 *   `chatMode` "lane class" with concrete adapter affordances. Absent = read-only review; present = write.
 *   dispatchModeToGrant bridges the build-pillar's DispatchMode (Temporal) onto the same grant.
 * @exports AgentGrant, dispatchModeToGrant
 * @depends (none — import-free to keep the shared base acyclic)
 */

/**
 * The per-turn capability an adapter needs. Present ⇒ a write-capable work turn; absent ⇒ read-only review.
 * `chat` and `build` differ ONLY in `worktree` (agy's --add-dir shape); `research` adds the research
 * affordances. The three adapters each read the subset they act on: claude/codex read presence + `research`;
 * agy reads `worktree`.
 */
export interface AgentGrant {
  /** research affordances — claude: MAX reasoning effort; codex: live web search. */
  readonly research: boolean;
  /** the agent operates directly on the worktree — agy --add-dir the worktree ROOT (vs a context copy).
   *  Set ONLY for an @-addressed build turn; the write-capability boundary itself lives upstream. */
  readonly worktree: boolean;
}

/** A plain write-capable work turn (no research affordances, context-copy workspace). Former mode "chat". */
export const CHAT_GRANT: AgentGrant = { research: false, worktree: false };
/** A research work turn (claude max effort, codex live web search). Former mode "research". */
export const RESEARCH_GRANT: AgentGrant = { research: true, worktree: false };
/** A build work turn (agy --add-dir the worktree root). Former mode "build". */
export const BUILD_GRANT: AgentGrant = { research: false, worktree: true };

/**
 * Bridges the build-pillar's DispatchMode ("build" | "chat" | "research" | undefined) onto an AgentGrant.
 * undefined ⇒ undefined (read-only review). The literal union (not an imported type) keeps this module
 * import-free so the shared base stays acyclic.
 */
export function dispatchModeToGrant(
  mode: "build" | "chat" | "research" | undefined,
): AgentGrant | undefined {
  if (mode === undefined) {
    return undefined;
  }
  return { research: mode === "research", worktree: mode === "build" };
}
