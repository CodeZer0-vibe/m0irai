/**
 * @file src/chat/agent-commands/types.ts
 * @purpose Shared types + the SAFE-NAME grammar for the @agent command palette (UNIT 4). A command's `name`
 *   is the slash token WITHOUT the leading "/"; it is ONLY ever admitted if it matches SAFE_NAME, so the value
 *   inserted into the (trusted) composer can never carry a control/escape byte (codex P1 #1 — a malicious
 *   project `.claude/commands/<esc>.md` must not reach the input buffer). `trusted` drives the render boundary:
 *   built-ins are tower constants (ChromeText); disk-sourced commands are untrusted (AgentText/escapeUntrusted,
 *   INV-13, codex P1 #2). No I/O, no logic beyond the name predicate — a leaf.
 * @exports AgentCommandKind, AgentCommand, isSafeCommandName
 * @depends (none)
 */

/** Where a command came from — drives both the render tag and the trust boundary. */
export type AgentCommandKind = "builtin" | "custom" | "skill";

/** One palette entry. `name` has NO leading "/" and is guaranteed to match {@link isSafeCommandName}. */
export interface AgentCommand {
  readonly name: string;
  readonly description: string; // one-line summary; "" when the source gives none
  readonly kind: AgentCommandKind;
  readonly trusted: boolean; // builtin → true (ChromeText); disk → false (AgentText — INV-13)
}

// The ONLY shape a command name may take to be eligible for the palette + composer insertion: starts
// alphanumeric, then lowercase-alnum plus the namespacing/separator set (`:` for git:commit / prompts:draftpr,
// `_` `-` `.`), bounded length. Anything outside this (ESC bytes, spaces, slashes, unicode tricks) is REJECTED
// at the source so it never reaches the trusted input buffer. Names are lowercased by the source before test.
const SAFE_NAME = /^[a-z0-9][a-z0-9:._-]{0,48}$/;

/** True iff `name` is a safe slash-command token (no leading slash). The sole admission gate for disk names. */
export function isSafeCommandName(name: string): boolean {
  return SAFE_NAME.test(name);
}
