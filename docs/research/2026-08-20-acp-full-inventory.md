# ACP Full Inventory — what the pinned adapters give us
(Lead's materialization of the acp-capability-scan report, 2026-08-20; researcher has no Write tool. Full prose in the session transcript.)

Pinned: @agentclientprotocol/claude-agent-acp 0.63.0 (PATCHED — patches/@agentclientprotocol+claude-agent-acp+0.63.0.patch, 411 lines, applied by patch-package), codex-acp 1.1.7 (vanilla), sdk 1.3.0.

## TOP-5 "we're throwing away gold"
1. **Per-turn token breakdown** (input/output/cache-read/cache-write/thought) — PromptResponse.usage populated EVERY turn by BOTH adapters (claude sessionUsage acp-agent.js:4771-4782 @ all settle sites; codex buildPromptUsage index.js:29943-30041 + _meta.quota per-model :30054-30064) — DISCARDED at ONE line for both: acp-turn-session.ts:304-307 `.then((r) => String(r.stopReason))`.
2. **Diffs** {path,oldText,newText} — arrive intact (raw tap acp-turn-session.ts:375-386), dropped at acp-tool-activity.ts:16-29. Zero readers of oldText/newText in src/.
3. **Plan/TodoWrite checklists** — Plan{entries:[{content,priority,status}]}: claude maps TodoWrite→Plan (taskStateToPlanEntries; tools.js:410), codex native plan items (createCompletedPlanEvent index.js:23895-23899, emitted :24063). ZERO consumption of plan/plan_update/plan_removed anywhere in src/. The most legible "what is the agent doing" signal in the protocol, unused.
4. **Subagent/background-task lifecycle** — our own patch's `_claude/backgroundTasks` reaches acp-lane-connection.ts:118-123, consumed by ONE redacted debug line (:276-291, "cockpit surface deliberately not built"). Codex subAgentActivity rides generic tool_call w/ _meta.codex.subagent (index.js:23110-23153) — _meta dropped same as claude's parentToolUseId.
5. **Free wins, zero consumption**: session_info_update {title,updatedAt} (SDK auto-titles sessions → auto-named chat tabs); AvailableCommandsUpdate (the live agent's REAL slash-command list → palette that can't drift).
Runner-up: permission approvals show only .title (acp-permission.ts:26-29) — operator approves an Edit without seeing its diff. Same root as item 2.

## Part 2 — taxonomy (sdk 1.3.0)
SessionUpdate = 13 kinds (types.gen.d.ts:3449-3475): user_message_chunk · agent_message_chunk · agent_thought_chunk · tool_call · tool_call_update · plan · plan_update · plan_removed · available_commands_update · current_mode_update · config_option_update · session_info_update · usage_update. Two usage concepts: UsageUpdate (streamed {used,size,cost?} :3977-3999 — CONTEXT by spec, quota NOT in protocol, rides _meta only) and PromptResponse.usage (Usage totals :3050-3085). Content blocks :249-495.

## Part 3 — Claude adapter (0.63.0+patch) highlights
USED: reply chunks · tool metadata (normalizeAcpToolActivity) · usage_update pipeline (ctx/cost/rate windows via _claude/rateLimit + patch's _claude/usageWindows — richly engineered contrast case) · model picker (acp-models.ts) · permission requests (deciders) · stop reasons.
DISCARDED: agent_thought_chunk (isTextChunk matches message only) → thinking indicator/panel · Diff content → viewer · rawInput/rawOutput (zero reads) → exact-invocation detail · Plan/TodoWrite → live checklist · _meta.claudeCode.parentToolUseId → nested tool tree · session_info_update → auto-titles · AvailableCommandsUpdate → live palette · PromptResponse.usage → token economics.
GATED: subagent transcript needs capability _meta["subagent-transcript"] or forwardSubagentText (acp-agent.js:147-163, 3533-3556) — whether we declare it: UNVERIFIED (not found).
UNVERIFIED: terminal-type ToolCallContent ever emitted; live mid-session current_mode_update reconciliation (resume-time adoption confirmed, native-mode.ts); claude authMethods construction (auth outside ACP per comments).

## Part 4 — Codex adapter (1.1.7) highlights
USED: reply chunks · tool metadata · usage_update (ctx only — NO rate-limit windows on ACP; those come from rollout files per usage-reporter.ts:218-221) · model picker (Shape A acp-models.ts:43-56) · permissions · cancellation (:30038-30044).
DISCARDED: agent_thought_chunk · Diff content (createPatch/Add/Update/DeleteFileContent :23410-23492; add/delete = full content not real diff, comment :23430,:23485) · rawInput/rawOutput (incl. MCP raw) · plan items · subAgentActivity/collabAgentToolCall _meta (threadId/path/activity; collaboration sender/receivers :23078-23153) · session_info_update (:23639,:23741,:29313,:29451,:29475) · available_commands_update (:26934) · PromptResponse.usage + _meta.quota.
ABSENT AT PIN: full subagent transcript (no mechanism found — do not promise) · reasoning-effort/fast-mode surfacing UNVERIFIED.

## Part 5 — protocol surface neither adapter exercises (footnote)
Elicitation (experimental) · MCP-over-ACP connect (experimental) · NES/Next Edit Suggestions (editor-focused) · provider listing/switching (experimental; post-pin feature per changelog).

## Version footnote
Latest: claude-agent-acp 0.70.0 / codex-acp 1.6.1. Both added "report changed files to AIR" (2026-08-16; term undefined in titles) — DEDICATED LOOK REQUIRED before any bump. No subagent-work titles between pin and latest (absence-of-titles only).
