/**
 * @file src/chat/controller-helpers.ts
 * @purpose Pure dispatch-result helpers for the chat cockpit (streaming print, command-dispatch
 *   mapping, response/stderr file paths, sandbox suffix). Kept standalone to stay under the line cap.
 * @exports printStreamingResult, toCommandDispatch, responseFilePath, stderrFilePath, sandboxSuffix
 * @depends node:path, ./types, ./ui
 */
import path from "node:path";
import type { AgentName, ChatRoute, CommandDispatchResult, DispatchResult } from "./types.js";
import { printAgentChunk, printAgentDone, printAgentError, printAgentFailed } from "./ui.js";

const TURN_PAD_WIDTH: number = 4;

export function printStreamingResult(
  agent: AgentName,
  result: DispatchResult,
  streaming: boolean,
): void {
  if (streaming && result.output.length > 0) {
    printAgentChunk(agent, result.output);
    if (!result.output.endsWith("\n")) printAgentChunk(agent, "\n");
  }
  if (!streaming) return;
  if (result.exitCode === 0) {
    printAgentDone(agent, result.durationMs);
  } else {
    printAgentFailed(agent, result.exitCode);
    const preview = result.output.slice(0, 500).trim();
    if (preview.length > 0) printAgentError(agent, `${preview}\n`);
  }
}

export function toCommandDispatch(
  agent: AgentName,
  promptContent: string,
  outputPath: string,
  result: DispatchResult,
): CommandDispatchResult {
  return {
    agent,
    runResult: { agent, durationMs: result.durationMs, exitCode: result.exitCode, outputPath },
    promptContent,
    outputContent: result.output,
    stderrContent: result.exitCode === 0 ? "" : (result.rawStderr ?? result.output),
    ...(result.diffStat !== undefined ? { diffStat: result.diffStat } : {}),
    ...(result.filesChanged !== undefined ? { filesChanged: result.filesChanged } : {}),
  };
}

export function responseFilePath(
  runDir: string,
  turn: number,
  agent: AgentName,
  round?: number,
): string {
  return path.join(runDir, "responses", turnFileName(turn, agent, "md", round));
}

export function stderrFilePath(
  runDir: string,
  turn: number,
  agent: AgentName,
  round?: number,
): string {
  return path.join(runDir, "stderr", turnFileName(turn, agent, "log", round));
}

function turnFileName(turn: number, agent: AgentName, ext: string, round?: number): string {
  const pad = String(turn).padStart(TURN_PAD_WIDTH, "0");
  if (round !== undefined) return `turn-${pad}-r${String(round)}-${agent}.${ext}`;
  return `turn-${pad}-${agent}.${ext}`;
}

export function sandboxSuffix(route: ChatRoute, agent: AgentName): string | undefined {
  if (agent === "codex" && route.codexSandbox === "workspace-write") return "workspace-write";
  return undefined;
}
