/**
 * @file src/chat/agent-commands/catalog.ts
 * @purpose Merge an agent's built-in set with its disk-sourced custom commands + skills into ONE ordered,
 *   de-duped list: built-ins first (trusted), then custom, then skills. A name already taken by a built-in is
 *   NOT shadowed by a disk entry, and a name seen once across the disk sources is not repeated (handles the
 *   cross-agent `.agents/skills` dir appearing under multiple roots — codex P1 #4 dedup). This is the ONLY
 *   module that performs the disk read for a catalog; callers cache the returned snapshot (codex P1 #3).
 * @exports loadAgentCommands
 * @depends ../types, ./builtin-catalog, ./disk-sources, ./types
 */
import type { AgentName } from "../types.js";
import { BUILTIN_COMMANDS } from "./builtin-catalog.js";
import { type DiskOpts, loadDiskCommands } from "./disk-sources.js";
import type { AgentCommand } from "./types.js";

/**
 * The full catalog for `agent`: built-ins + disk (custom, then skills), de-duped by name (built-in wins a
 * collision; first disk occurrence wins among disk sources). `opts` injects the fs roots for tests.
 */
export function loadAgentCommands(agent: AgentName, opts?: DiskOpts): AgentCommand[] {
  const builtins = BUILTIN_COMMANDS[agent];
  const seen = new Set<string>(builtins.map((c) => c.name));
  const merged: AgentCommand[] = [...builtins];
  for (const command of loadDiskCommands(agent, opts)) {
    if (!seen.has(command.name)) {
      seen.add(command.name);
      merged.push(command);
    }
  }
  return merged;
}
