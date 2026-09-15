/**
 * @file src/adapters/agent-model-store.ts
 * @purpose The operator's CHOSEN model PER AGENT — a process-scoped singleton the native /model picker SETS
 *   and each agent adapter READS (to pass its model flag on every turn). One `zer0 chat` process runs one
 *   cockpit, so process-scoped = session-scoped here. `undefined` for an agent = that agent's own default (no
 *   flag added). The stored value is the id the picker chose: gemini = an `agy models` display name; claude =
 *   an ACP model id (e.g. "sonnet", "claude-opus-4-8[1m]"); codex = an ACP model id with reasoning effort
 *   baked in (e.g. "gpt-5.5[high]"). Single source of truth for all three lanes.
 * @exports getAgentModel, setAgentModel
 * @depends ../shared/types
 */
import type { AgentName } from "../shared/types.js";

const chosen = new Map<AgentName, string>();

/** The chosen model id for an agent, or undefined when none is set (the agent uses its own default). */
export function getAgentModel(agent: AgentName): string | undefined {
  return chosen.get(agent);
}

/** Set (or clear, with undefined / blank) an agent's chosen model; blanks normalize to cleared. */
export function setAgentModel(agent: AgentName, model: string | undefined): void {
  const trimmed = model?.trim();
  if (trimmed !== undefined && trimmed.length > 0) {
    chosen.set(agent, trimmed);
  } else {
    chosen.delete(agent);
  }
}
