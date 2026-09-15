/**
 * @file src/chat/agent-commands/builtin-catalog.ts
 * @purpose The STATIC built-in slash-command set per agent — tower-owned constants (trusted: true → rendered
 *   via ChromeText). These are NOT live-enumerable from the CLIs (built-ins are compiled in), so this is a
 *   MAINTAINED list. DRIFT POLICY (codex P2 #6): sourced 2026-06-26 — claude from its CLI, codex from codex.exe
 *   string-extraction + official docs, gemini(agy) from agy.exe + Antigravity docs. Re-verify against each CLI
 *   when bumping; descriptions are best-effort one-liners for discovery, not verbatim help text. A leaf (no I/O).
 * @exports BUILTIN_COMMANDS
 * @depends ../types, ./types
 */
import type { AgentName } from "../types.js";
import type { AgentCommand } from "./types.js";

/** Compact constructor for a built-in entry (trusted tower constant). */
function b(name: string, description: string): AgentCommand {
  return { name, description, kind: "builtin", trusted: true };
}

const CLAUDE: readonly AgentCommand[] = [
  b("help", "List commands and how the cockpit works"),
  b("model", "Switch the active Claude model"),
  b("compact", "Summarize + compact the conversation"),
  b("clear", "Clear the conversation"),
  b("resume", "Resume a past conversation"),
  b("init", "Scaffold a CLAUDE.md for this project"),
  b("skills", "Browse + run skills"),
  b("agents", "Manage subagents"),
  b("mcp", "Manage MCP servers"),
  b("status", "Show session + account status"),
  b("cost", "Show token cost this session"),
  b("context", "Show what fills the context window"),
  b("memory", "Edit memory (CLAUDE.md) files"),
  b("review", "Review a pull request"),
  b("config", "Open settings"),
];

const CODEX: readonly AgentCommand[] = [
  b("init", "Create an AGENTS.md for this project"),
  b("compact", "Summarize the conversation to free context"),
  b("model", "Choose the model + reasoning effort"),
  b("review", "Review your current changes"),
  b("diff", "Show the git diff (including untracked)"),
  b("new", "Start a new chat"),
  b("status", "Show the session configuration"),
  b("mcp", "List configured MCP tools"),
  b("prompts", "Run a saved custom prompt"),
  b("resume", "Resume a previous session"),
  b("clear", "Clear the conversation"),
  b("copy", "Copy the last message"),
  b("logout", "Log out of Codex"),
  b("help", "List commands"),
];

const GEMINI: readonly AgentCommand[] = [
  b("help", "List commands"),
  b("model", "Switch the Gemini model"),
  b("clear", "Clear the conversation"),
  b("mcp", "Manage MCP servers"),
  b("compact", "Summarize the conversation"),
  b("context", "Show the context window"),
  b("tools", "List available tools"),
  b("memory", "Manage memory (GEMINI.md)"),
  b("settings", "Open settings"),
  b("agents", "Manage agents"),
  b("skills", "Browse skills"),
  b("new", "Start a new chat"),
  b("status", "Show the session status"),
  b("usage", "Show usage + quota"),
  b("diff", "Show the git diff"),
];

/** The built-in set per agent (display order = catalog order). */
export const BUILTIN_COMMANDS: Readonly<Record<AgentName, readonly AgentCommand[]>> = {
  claude: CLAUDE,
  codex: CODEX,
  gemini: GEMINI,
};
