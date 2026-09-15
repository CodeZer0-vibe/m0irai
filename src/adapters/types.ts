/**
 * @file src/adapters/types.ts
 * @purpose Adapter-shaped types: AgentInput, AdapterError, AdapterCommand.
 * @exports AgentInput, AdapterError, AdapterCommand
 * @depends zod, ../shared/types, ../shared/errors, ../shared/logger
 */
import { z } from "zod";
import type { AgentGrant } from "../shared/agent-grant.js";
import type { DispatchError } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";
import type { AgentName } from "../shared/types.js";

interface AdapterCommandRaw {
  args: string[];
  cmd: string;
  stdinFile?: string | undefined;
}

/**
 * Input required to dispatch one agent CLI against a compiled context file.
 */
export interface AgentInput {
  agent: AgentName;
  contextFile: string;
  worktreePath: string;
  signal: AbortSignal;
  timeoutMs?: number;
  logger?: Logger;
  /** The per-turn capability grant (X0 — replaces the retired chat/research/build lane class). Absent ⇒
   *  read-only review turn (claude json / codex read-only sandbox); present ⇒ write-capable work turn. */
  grant?: AgentGrant;
  /**
   * Per-session state dir that turns on agy (gemini) conversation continuity. Consumed ONLY by the agy
   * adapter: agy is a one-shot CLI, so it persists the conversation id it minted under
   * `<dir>/.agy-conversation` and resumes it via `--conversation <id>` on later turns (the captured id
   * survives the per-turn workspace; agy's "most recent" `--continue` did not). Per-session-unique ⇒ no
   * cross-session / multi-instance bleed. claude/codex are persistent pty sessions that continue on their
   * own (and use a strict schema), so the cockpit sets this for the gemini lane only.
   */
  agyConversationDir?: string;
}

/** Runtime schema for the per-turn capability grant — shared by the three adapters' input schemas. */
export const AgentGrantSchema: z.ZodType<AgentGrant> = z
  .object({ research: z.boolean(), worktree: z.boolean() })
  .strict();

/**
 * Typed adapter error raised by CLI dispatch failures.
 */
export type AdapterError = DispatchError;

/**
 * Shell-free subprocess command shape passed to execa.
 */
export interface AdapterCommand {
  cmd: string;
  args: readonly string[];
  stdinFile?: string;
}

/**
 * Runtime schema for shell-free subprocess command objects.
 */
export const AdapterCommand: z.ZodType<AdapterCommand, z.ZodTypeDef, unknown> = z
  .object({
    args: z.array(z.string()),
    cmd: z.string().min(1),
    stdinFile: z.string().min(1).optional(),
  })
  .strict()
  .transform(toAdapterCommand);

function toAdapterCommand(value: AdapterCommandRaw): AdapterCommand {
  return {
    args: value.args,
    cmd: value.cmd,
    ...(value.stdinFile !== undefined ? { stdinFile: value.stdinFile } : {}),
  };
}
