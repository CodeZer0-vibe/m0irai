# How the official CLIs manage conversation context — and zer0's target architecture

Research locked 2026-07-04 (operator-directed). Sources: the gemini-cli open source (local
reference clone), the claude-agent-acp bridge source (shipped in node_modules), the codex-acp
bridge source + a live codex rollout file (codex's own self-research dispatch), plus documented
behavior. A gemini web-citation sweep was attempted twice and stalled both times on agy's
"timeout waiting for response" — closed WITHOUT it: the sweep was corroborative; every
load-bearing claim below stands on primary sources or live empirics. Every
claim below carries its source; UNVERIFIED is marked.

## Part 1 — what the natives actually do

The model APIs are stateless. All three CLIs therefore keep ONE continuous conversation
client-side and RE-SEND it every turn, made affordable by prompt caching and bounded by
compaction:

|                 | per-turn payload                                                                                                                                                                                                   | growth control                                                                                                                                                                                                                | resume                                                                                                                                                                | cost shape                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Gemini CLI**  | full curated history every request (`geminiChat.ts:511`)                                                                                                                                                           | auto-compress at **50%** of the window: older ~70% summarized, last **30% kept verbatim**, split only on a clean user-message boundary, 50k-token budget for preserved tool outputs (`chatCompressionService.ts:41,47,52,60`) | checkpoint/chat files reload into the history array                                                                                                                   | full re-send; Gemini context caching where available                                                                                                      |
| **Claude Code** | one persistent engine session; each prompt enqueues onto a single long-lived stream (`claude-agent-acp/dist/acp-agent.js:493+`); the engine re-sends conversation per API call                                     | auto-compact near the window limit + manual `/compact` (documented behavior)                                                                                                                                                  | sessions = JSONL on disk; `resumeSession`/`loadSession` reattach the engine + replay history for display (`acp-agent.js:452-466`)                                     | stable prefix rides Anthropic prompt caching                                                                                                              |
| **Codex CLI**   | app-server **threads**: `thread/start`, `thread/resume`, `thread/read`, `thread/compact/start` (`codex-acp/dist/index.js:27994`); raw Responses-API fields (store/previous_response_id) UNVERIFIED — native binary | auto-compact + `/compact`; threshold override `model_auto_compact_token_limit` (default UNVERIFIED); compaction surfaces as a `thread/compacted` event → "Context compacted" marker (`index.js:22431`)                        | rollout JSONL (`~/.codex/sessions/rollout-*.jsonl`): session meta, events, tool outputs, token usage, **encrypted reasoning items**; `thread/resume` + history stream | **EMPIRICAL (live rollout)**: input 124,096 tokens, cached 123,264 (~99% cache hit), window 258,400 — "large effective context with cached-prefix credit" |

Load-bearing conclusions:

1. **Full re-send is the universal pattern.** Nobody sends deltas to the model; caching makes
   the unchanged prefix cheap (~99% observed on codex), compaction keeps it bounded.
2. **Compaction is lossy and observable.** Each CLI summarizes its own past on its own
   schedule; codex even emits an event for it. Post-compaction, details exist only in the
   summary — the documented "compaction amnesia" class.
3. **Resume is transcript replay, not server magic.** Sessions live on the user's disk; resume
   reloads them into context.
4. Codex's own integration advice (self-research): treat compaction as a state transition —
   detect it, then inject a cockpit-owned briefing on the next turn; never assume "resume"
   means the raw transcript is in the model's context.

## Part 2 — zer0's target chat architecture (the operator's "do the same" decision)

The 8-message/24k one-shot window was a stopgap: beyond it, agents were blind ("they have no
idea what's happening" — the operator's exact fear, confirmed). The target model:

**Per-agent persistent native sessions + delta injection + the journal brain.**

1. **One persistent native session per agent per project.** Claude: the engine session via the
   ACP resume plumbing. Codex: an app-server thread. Gemini/agy: the captured conversation id.
   Each agent's own machinery then provides what it was built for: continuous context, prompt
   caching, native auto-compaction, on-disk persistence.
2. **The room reaches each agent as a DELTA.** An agent's native session already contains
   everything it has seen; per turn zer0 injects only what the room produced since that agent
   last spoke — operator messages + teammates' labeled replies (with the F2 addressing
   attribution). No 8-message window, no full-history re-send from our side: the natives
   handle their own history; we hand them only the new pages.
3. **The journal covers what native sessions cannot.**
   - **Compaction re-carry**: on a detected compaction (codex `thread/compacted`; claude/gemini
     equivalents or heuristics), the next turn prepends the briefing — anchors, decisions, the
     work map — so load-bearing facts survive the CLI's lossy summary.
   - **Cross-session**: new day, crash, `/clear` — native resume reattaches where possible;
     where a session is gone, the briefing cold-starts the lane.
   - **Cross-agent**: the shared brain remains the only place all three agents' knowledge
     meets.
4. **Bounded one-shots are RETAINED deliberately** for councils, debates, and hostile reviews —
   codex's own verdict: "bounded windows beat native sessions for adversarial isolation and
   cost ceilings." Isolation there is a feature, not a limitation.
5. **Quota honesty**: persistent contexts consume more subscription capacity than 24k one-shots
   (cached tokens are discounted, not free, against 5h/weekly caps). The usage meters are the
   instrument; capacity-aware routing stays an opt-in assist.

## Rollout

- MT7 (memory plan rev 2.2) upgrades from "resume behind a flag" to the TARGET chat
  architecture; its build wave gets a spec/plan delta covering: delta-injection composition,
  per-CLI compaction detection, briefing re-carry, and the default-flip acceptance.
- Ship flag-first (`ZER0_NATIVE_RESUME`), prove it through the operator's dogfood weeks with
  the meters watching quota impact, flip the default before 0.1.
- The review/dispatch lanes keep the bounded composer unchanged.
