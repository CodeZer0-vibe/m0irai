/**
 * @file src/room/status-mode-language.ts
 * @purpose W4-R2a-2: THE ONE MODE LANGUAGE. Every engine's native mode id is rendered to the operator as a
 *   single shared word, so the bottom bar never shows three vendor vocabularies at once. The native ids stay
 *   the WIRE truth (setMode/argv unchanged, native-mode.ts still owns them) and remain visible only in
 *   detail/debug surfaces — this module is the DISPLAY boundary, nothing more.
 * @exports ModeWord, MODE_WORDS, modeWord
 * @depends ../chat/types
 *
 * THE OPERATOR'S RULE (re-locked 2026-07-25, verbatim): "for gemini codex and claude we should display the
 * same language for all 3 of them, short, what mode they are in, no different stuff, it's causing
 * [confusion], it should be a clear message not something confusing."
 *
 * ONE BEHAVIOR, ONE WORD — and its corollary. The same real behavior ALWAYS renders the same word across
 * engines, and one word NEVER covers two different behaviors. An engine that genuinely lacks a behavior
 * simply never shows that word: codex has no `edits`, gemini has no `careful`/`strict`/`smart`. Never
 * invent a substitute to fill a gap, and never widen a word to cover a mode it does not truthfully
 * describe. (An earlier draft mapped gemini `accept-edits` to `careful` while claude's IDENTICAL
 * `acceptEdits` mapped to `edits` — exactly the confusion the operator banned.)
 *
 * THE WORDS ARE DERIVED FROM EACH BRIDGE'S OWN DESCRIPTIONS, not invented:
 *   claude (node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js:3561-3585, :3545-3559)
 *     default          "Standard behavior, prompts for dangerous operations"          -> careful
 *     acceptEdits      "Auto-accept file edit operations"                             -> edits
 *     plan             "Planning mode, no actual tool execution"                      -> plan
 *     dontAsk          "Don't prompt for permissions, deny if not pre-approved"       -> strict
 *     bypassPermissions"Bypass all permission checks"                                 -> auto
 *     auto             "Use a model classifier to approve/deny permission prompts"    -> smart
 *       (live-advertised only, gated by supportsAutoMode — absent from the static catalog)
 *   codex (node_modules/@agentclientprotocol/codex-acp/README.md:55, native-mode.ts:57)
 *     read-only -> plan · agent -> careful · agent-full-access -> auto
 *   gemini (native-mode.ts:58; src/adapters/agy.ts:54-66, :432-445)
 *     plan -> plan · accept-edits -> edits · auto -> auto
 *       (`auto` = omitted --mode PLUS skip-permissions, i.e. genuine full autonomy — which is why it is
 *        `auto` and not a "decide automatically" word.)
 */
import type { AgentName } from "../chat/types.js";

/** The complete operator-facing vocabulary. Short by construction (<= 7 columns) so three cells fit a
 *  60-column terminal without any engine being squeezed out. */
export type ModeWord = "plan" | "careful" | "edits" | "auto" | "strict" | "smart";

/** The mapping table — this round's core artifact. Keyed by engine because the SAME word can come from
 *  different native ids (that is the point), never because the words themselves differ per engine. */
export const MODE_WORDS: Readonly<Record<AgentName, Readonly<Record<string, ModeWord>>>> = {
  claude: {
    plan: "plan",
    default: "careful",
    acceptEdits: "edits",
    bypassPermissions: "auto",
    dontAsk: "strict",
    auto: "smart",
  },
  codex: {
    "read-only": "plan",
    agent: "careful",
    "agent-full-access": "auto",
  },
  gemini: {
    plan: "plan",
    "accept-edits": "edits",
    auto: "auto",
  },
};

/**
 * The unified word for one engine's native mode id, or `undefined` when this table does not describe it.
 *
 * UNDEFINED IS DELIBERATE, and is NOT `modeToken`'s behaviour. `native-mode.ts`'s `modeToken` falls back to
 * `modeId.slice(0, 6)` — which leaks raw vendor jargon into the operator's eye while looking like a display
 * token, the exact failure R2a-2 exists to end. Here an unmapped id renders NOTHING instead: a word we
 * cannot honestly translate is worse than no word, because the operator cannot act on jargon anyway. The
 * totality test (status-mode-language.test.ts) drives the PRODUCTION catalogs — static MODE_CATALOG plus
 * live catalogs applied through the real `mode-catalog` reducer, including claude's gated `auto` — so this
 * branch is unreachable for every id the product can actually produce; it exists so a FUTURE bridge mode
 * degrades to silence rather than to jargon, and so the test can catch it.
 */
export function modeWord(engine: AgentName, modeId: string): ModeWord | undefined {
  if (modeId.length === 0) {
    return undefined;
  }
  return MODE_WORDS[engine][modeId];
}
