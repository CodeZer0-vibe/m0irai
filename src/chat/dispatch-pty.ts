/**
 * @file src/chat/dispatch-pty.ts
 * @purpose Dispatch claude/codex as PERSISTENT interactive node-pty sessions (subscription,
 *   no -p) via the registry — implements HeadlessDispatch unchanged. Reply + completion come from
 *   the session-bound, offset-tracked reader (turn-2 never re-serves turn-1; marker-only completion);
 *   a typed turn failure maps to a non-zero AgentResult, never an empty success or scrollback dump.
 * @exports dispatchPty
 * @depends node:fs, ../adapters/pty/exe-resolver, ../adapters/types, ../shared/types, ./pty-session, ./pty-session-registry
 */
import { readFileSync } from "node:fs";
import type { PtyAgent } from "../adapters/pty/exe-resolver.js";
import type { AgentInput } from "../adapters/types.js";
import { DispatchError } from "../shared/errors.js";
import type { AgentResult } from "../shared/types.js";
import { getOrSpawnPtySession } from "./pty-session-registry.js";
import {
  PtyAbortError,
  PtyChildExitError,
  PtyQueueFullError,
  PtyTurnCapError,
} from "./pty-session.js";

const PTY_FAILURE_EXIT_CODE = 1;

/**
 * Dispatch one turn to the agent's persistent pty session and return its clean reply. Conforms to
 * HeadlessDispatch (the cockpit renders the result unchanged). A typed turn failure (cap/abort/
 * crash/overflow) is THROWN as a DispatchError — runOneLane records that as a lane error
 * (dispatch.failed), so a marker-less cap can never be rendered as a successful reply (codex P0 #2;
 * returning {exitCode:1} did NOT work — runOneLane reads stdout, ignores exitCode).
 */
export async function dispatchPty(input: AgentInput): Promise<AgentResult> {
  const agent = input.agent as PtyAgent;
  const prompt = readFileSync(input.contextFile, "utf8");
  const session = getOrSpawnPtySession(agent, input.worktreePath);
  try {
    const { reply } = await session.submit(prompt, input.signal);
    return { exitCode: 0, stdout: reply };
  } catch (error) {
    // F-2: DispatchError flattens the typed pty error to a message only, so the idle-cap timeout would
    // otherwise reach classifyLaneError unrecognised and be mislabeled `failed`. Mark it at the source
    // (here we KNOW it is a timeout) with a "timed out:" prefix the classifier keys on.
    if (error instanceof PtyTurnCapError) {
      throw new DispatchError(`timed out: ${error.message}`, agent, PTY_FAILURE_EXIT_CODE);
    }
    if (
      error instanceof PtyAbortError ||
      error instanceof PtyChildExitError ||
      error instanceof PtyQueueFullError
    ) {
      throw new DispatchError(error.message, agent, PTY_FAILURE_EXIT_CODE);
    }
    throw error;
  }
}
