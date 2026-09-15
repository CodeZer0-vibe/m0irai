/**
 * @file src/chat/dispatch-acp.ts
 * @purpose The ACP-transport dispatch seam (DEFAULT ON; ZER0_ACP=0 opts out): run a claude/codex turn over ACP so
 *   the operator's native skills/commands FIRE (the pty path runs a hook-stripped CLI). Reads the compiled context
 *   file as the prompt (the transcript carries → a fresh-per-turn ACP session keeps continuity). When a sink is
 *   given, streams the reply LIVE per-chunk through it. gemini is never ACP (no adapter). Session reuse is next.
 * @exports acpTransportEnabled, dispatchAcpHeadless
 * @depends node:fs/promises, ../adapters/acp/acp-turn, ../adapters/types, ../shared/errors, ../shared/turn-usage
 */
import { readFile as fsReadFile } from "node:fs/promises";
import { denyDecider } from "../adapters/acp/acp-permission.js";
import {
  type AcpTurnInput,
  dispatchAcpTurn as realDispatchAcpTurn,
} from "../adapters/acp/acp-turn.js";
import type { AgentInput } from "../adapters/types.js";
import { DispatchError } from "../shared/errors.js";
import type { AgentResultWithUsage } from "../shared/turn-usage.js";

const UTF8 = "utf8";
const SUCCESS = 0;
const STDERR_PREVIEW = 240;

/** The injectable I/O seams — production binds fs + the real ACP turn; a unit test injects fakes (no spawn). */
export interface AcpHeadlessDeps {
  readonly readFile: (path: string, encoding: "utf8") => Promise<string>;
  readonly dispatchAcpTurn: (input: AcpTurnInput) => Promise<AgentResultWithUsage>;
}

const realDeps: AcpHeadlessDeps = {
  dispatchAcpTurn: realDispatchAcpTurn,
  readFile: fsReadFile,
};

/**
 * True when claude/codex turns run over ACP (native skills + live streaming). DEFAULT ON — the escape hatch
 * `ZER0_ACP=0` opts back out to the proven pty/registry path if ACP ever misbehaves.
 */
export function acpTransportEnabled(): boolean {
  return process.env.ZER0_ACP !== "0";
}

/**
 * Dispatches ONE claude/codex turn over ACP. Reads the compiled context file as the prompt text (carrying the
 * multi-turn transcript), runs the turn, returns the buffered result. Throws for gemini (no ACP adapter yet).
 *
 * @param input - the adapter input (agent claude/codex, contextFile = the compiled prompt)
 * @param onChunk - optional LIVE-stream sink; when given, the reply is streamed to it per-chunk during the turn
 * @param deps - the fs + ACP-turn seams (defaults to the real ones)
 * @returns the AgentResult (reply → stdout, end_turn → exitCode 0)
 */
export async function dispatchAcpHeadless(
  input: AgentInput,
  onChunk?: (chunk: string) => void,
  deps: AcpHeadlessDeps = realDeps,
): Promise<AgentResultWithUsage> {
  if (input.agent === "gemini") {
    throw new Error("ACP transport supports claude/codex only (gemini has no ACP adapter)");
  }
  const promptText = await deps.readFile(input.contextFile, UTF8);
  const result = await deps.dispatchAcpTurn({
    agent: input.agent,
    cwd: input.worktreePath,
    promptText,
    signal: input.signal,
    ...(input.grant === undefined
      ? {
          decide: denyDecider,
          requiredModeId: input.agent === "claude" ? "plan" : "read-only",
        }
      : {}),
    ...(onChunk ? { onChunk } : {}),
  });
  // Contract parity with the registry/pty adapters: a non-success turn (stopReason != end_turn → exitCode != 0)
  // THROWS, so headless-turn maps it to dispatch.failed instead of a silently-"completed" lane (codex BLOCK).
  if (result.exitCode !== SUCCESS) {
    throw new DispatchError(
      `ACP turn for ${input.agent} did not end cleanly (exit ${String(result.exitCode)})`,
      input.agent,
      result.exitCode,
      result.stdout.slice(0, STDERR_PREVIEW),
    );
  }
  // The reply already streamed to onChunk (if given) during the turn; result.stdout still carries the full text
  // for the buffered fallback + the response file. runOneLane keys "already streamed" off whether the sink fired.
  return result;
}
