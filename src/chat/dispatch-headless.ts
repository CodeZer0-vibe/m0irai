/**
 * @file src/chat/dispatch-headless.ts
 * @purpose The HEADLESS dispatch seam: map a parsed ChatRoute to the adapter GRANT (X0), then dispatch
 *   ONE agent through the PROVEN subscription-only adapter registry (the same buffered claude/codex/
 *   gemini dispatchers Temporal uses; childEnv, no API keys). Returns the buffered AgentResult; throws
 *   DispatchError on non-zero exit. The intent→grant map is the gem (pipeline/build→BUILD_GRANT,
 *   research→RESEARCH_GRANT, else CHAT_GRANT). No bus/evidence/tower — those are the caller's
 *   (headless-turn) concern.
 * @exports HeadlessDispatch, grantForRoute, dispatchHeadless
 * @depends ../adapters/registry, ../adapters/types, ../shared/agent-grant, ../shared/turn-usage, ./dispatch-acp, ./dispatch-pty, ./types
 */
import { AdapterRegistry } from "../adapters/registry.js";
import type { AgentInput } from "../adapters/types.js";
import { type AgentGrant, BUILD_GRANT, CHAT_GRANT, RESEARCH_GRANT } from "../shared/agent-grant.js";
import type { AgentResultWithUsage } from "../shared/turn-usage.js";
import { acpTransportEnabled, dispatchAcpHeadless } from "./dispatch-acp.js";
import { dispatchPty } from "./dispatch-pty.js";
import type { ChatRoute } from "./types.js";

/**
 * The injectable dispatch seam — production binds the real adapter registry; tests inject a fake. `onChunk` is
 * the optional LIVE-stream sink: a streaming dispatcher (ACP) calls it per reply-chunk during the turn; the
 * buffered pty/registry dispatchers ignore it (their reply arrives once, via the returned AgentResult).
 */
export type HeadlessDispatch = (
  input: AgentInput,
  onChunk?: (chunk: string) => void,
) => Promise<AgentResultWithUsage>;

/**
 * Maps a parsed chat route to the adapter GRANT (X0 — replaces the retired chatMode lane class). A write-
 * capable `pipeline` route OR a build-family intent (build/create/fix) is BUILD_GRANT; an explicit research
 * intent is RESEARCH_GRANT; every other plain ask is CHAT_GRANT. This is the SINGLE source of intent→grant
 * for the headless lane — it intentionally mirrors cockpit-turn-route.modeWord ("ask" there == chat here),
 * so the pick label and the dispatched grant can never silently disagree. Always present (headless lanes are
 * write-capable work turns; the read-only review path is the absent-grant default, used by other callers).
 *
 * @param route - the parsed chat route (its `dispatchMode` is the chat-local pipeline/tools/text-only enum)
 * @returns the adapter grant driving the CLI's write capability + research affordances
 */
export function grantForRoute(route: ChatRoute): AgentGrant {
  if (route.dispatchMode === "pipeline") {
    return BUILD_GRANT;
  }
  if (route.intent === "build" || route.intent === "create" || route.intent === "fix") {
    return BUILD_GRANT;
  }
  if (route.intent === "research") {
    return RESEARCH_GRANT;
  }
  return CHAT_GRANT;
}

const sharedRegistry = new AdapterRegistry();

/**
 * The production headless dispatch. claude + codex ride the interactive pty as full PERSISTENT live
 * sessions (subscription-billed; each agent's native in-session commands work across turns). claude is
 * unconditional — `claude -p` bills to the API credit pool from 2026-06-15 while the interactive session
 * stays on the flat subscription (W1-T0; the registry claude dispatcher is RETIRED and fails loud). codex
 * now DEFAULTS to the persistent pty too (verified live 2026-06-25: a real codex turn completes via its
 * task_complete marker in ~15s); ZER0_CODEX_NO_PTY=1 forces the one-shot registry exec as a fallback if a
 * session ever wedges. gemini ALWAYS routes through the registry — the agy (Antigravity) adapter drives
 * its OWN one-shot ConPTY (gemini-cli retired 2026-06-18; a persistent agy pty-session is the next step).
 * The registry path spawns the subscription-authed CLI with no provider API keys (INV-4). Throws
 * DispatchError on a non-zero exit — the caller (headless-turn) maps that onto dispatch.failed.
 *
 * @param input - the validated adapter input (agent, contextFile, worktreePath cwd, signal, grant)
 * @returns the buffered agent result (stdout + exitCode)
 */
export const dispatchHeadless: HeadlessDispatch = (input, onChunk) => {
  // Absent grant is the explicit read-only contract. Persistent PTY/carrier
  // sessions may inherit an operator-selected bypass mode, so Gemini uses its
  // isolated plan adapter while Claude/Codex use a fresh ACP session that must
  // advertise and enter the provider's safe mode before prompting.
  if (input.grant === undefined) {
    return input.agent === "gemini"
      ? sharedRegistry.dispatch(input)
      : dispatchAcpHeadless(input, onChunk);
  }
  // ACP transport (DEFAULT ON; ZER0_ACP=0 opts out): claude/codex turns run over ACP so the operator's NATIVE
  // skills/commands fire + stream live (the pty path runs a hook-stripped CLI; ACP loads them via the clean
  // config). gemini has no ACP adapter (Google #31) → stays on the registry. onChunk streams the reply live (ACP
  // only); the pty/registry branches below (the ZER0_ACP=0 escape) ignore it (buffered) — a no-op there anyway.
  if (acpTransportEnabled() && input.agent !== "gemini") return dispatchAcpHeadless(input, onChunk);
  // claude ALWAYS rides the interactive pty — `claude -p` is API-credit billed from 2026-06-15.
  if (input.agent === "claude") return dispatchPty(input);
  // codex DEFAULTS to the persistent pty (a full live session like claude — verified live); the
  // ZER0_CODEX_NO_PTY=1 escape forces the one-shot registry exec if a session wedges. gemini ALWAYS uses
  // the registry — the agy (Antigravity) adapter drives its OWN one-shot ConPTY (gemini-cli retired).
  if (input.agent === "codex" && process.env.ZER0_CODEX_NO_PTY !== "1") return dispatchPty(input);
  return sharedRegistry.dispatch(input);
};
