# ACP vendor matrix — which agent CLIs can occupy an m0irai chair (researched 2026-08-19, sourced)

Filed by the lead from the acp-vendor-scan researcher's report; fold into docs/research/ at the next merge.

## Headlines
1. **Grok Build (xAI) speaks ACP natively and officially**: `grok agent stdio` — "Run as an ACP agent over stdin/stdout" (docs.x.ai/build/cli/reference; also github.com/xai-org/grok-build README:13-17). Distinct from its MCP-client feature. The CLI whose UI we forked can itself be a chair through the general ACP slot.
2. **Gemini CLI consumer access is ALREADY sunset** (June 18, 2026 — before today): free/Pro/Ultra logins stopped; paid API keys / enterprise licenses only (developers.googleblog transition post; repo itself alive, v0.56.0 shipped 2026-08-19, --acp mode intact). Validates the agy/Antigravity chair decision.
3. **DeepSeek ships no official CLI** (entire 55-repo org enumerated: models/research/infra only). Top community CLI: DeepSeek-TUI (Hmbown, 40,829 stars, Rust, -p headless, MCP client+server, NO ACP, API-key auth). Not a cheap chair.

## Native-ACP CLIs (one generic adapter unlocks all)
Grok Build (xAI; OAuth auth.x.ai or XAI_API_KEY) · Qwen Code (Alibaba; ACP Bridge doc; ModelStudio or BYOK incl. DeepSeek models) · Kimi CLI (Moonshot; `kimi acp`; AUTH_REQUIRED -32000 when logged out) · OpenCode (anomalyco, 199k stars; BYOK or OpenCode Zen) · GitHub Copilot CLI (public preview 2026-01-28; Copilot subscription) · Cursor CLI (`agent acp`; cursor_login method or CURSOR_API_KEY) · Goose (Block; labeled Experimental) · Gemini CLI (`gemini --acp`; paid-key-only for individuals now).

## Adapter-ACP (what we run today)
Claude Code via claude-agent-acp v0.70.0 · Codex via codex-acp v1.6.0 (both Zed-org adapters, the ACP registry's own entries).

## No ACP
Antigravity (our custom agy adapter — built) · Amp (headless -x only; the registry's "Amp" entry is a THIRD-PARTY wrapper, tao12345666333/amp-acp 85 stars — community, not Sourcegraph) · Aider (zero ACP mentions in README; BYOK scripting mode).

## Auth-probe note for plug-and-play login detection
Auth models split: subscription/OAuth login (claude, codex, copilot, grok, kimi, cursor-login) vs API key env (XAI_API_KEY, CURSOR_API_KEY, deepseek keys, BYOK) — per-vendor "ready / not logged in" probes differ; Kimi's ACP even signals AUTH_REQUIRED in-protocol.

## Researcher's honesty notes (kept verbatim in spirit)
UNVERIFIED this round: exact headless flags for Kimi/OpenCode/Copilot; Qwen wording sourced to rendered docs not raw md; amp-acp's relationship to Sourcegraph unknown. Absences proven by full-page greps of both ACP lists (39-entry Agents page + Registry), not keyword luck.
