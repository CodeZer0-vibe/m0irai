/**
 * @file src/adapters/agent-mode-store.ts
 * @purpose The operator's CHOSEN native mode PER AGENT — process-scoped singleton Shift+Tab SETS,
 *   each adapter READS. Mirrors agent-model-store.ts: adapters may import only
 *   adapters/evidence/shared (no-upward-deps-adapters), so agy.ts's argv-build-time read cannot
 *   reach native-mode.ts's richer state. `undefined` = the agent's own default (no --mode flag).
 *   claude/codex's live mode travels over ACP instead — this store is agy-specific.
 * @exports getAgentMode, setAgentMode
 * @depends ../shared/types
 */
import type { AgentName } from "../shared/types.js";

const chosen = new Map<AgentName, string>();

/** The chosen native mode id for an agent, or undefined when none is set (the agent's own default). */
export function getAgentMode(agent: AgentName): string | undefined {
  return chosen.get(agent);
}

/** Set (or clear, with undefined) an agent's chosen native mode. */
export function setAgentMode(agent: AgentName, modeId: string | undefined): void {
  if (modeId !== undefined && modeId.length > 0) {
    chosen.set(agent, modeId);
  } else {
    chosen.delete(agent);
  }
}
