# Turbocharge Codex CLI as a Team Member (v0.138, 2026-06-09)

**Installed:** `codex-cli 0.138.0` (verified `codex --version`). All claims marked VERIFIED (primary
source: local install at `~/.codex/**` OR official docs) or UNVERIFIED.

Truth hierarchy used: local `~/.codex` install artifacts (highest) > developers.openai.com docs >
agents.md spec > community repos.

---

## 1. AGENTS.md — discovery, precedence, sizing

- **Global file exists and is read.** Local install has `~/.codex/AGENTS.md` (107 lines). VERIFIED
  (`~/.codex/AGENTS.md`). Our existing global already runs the "technical co-founder" stance + 5
  named global skills.
- **Discovery + merge order** (developers.openai.com/codex/guides/agents-md): global `~/.codex`
  (`AGENTS.override.md` then `AGENTS.md`) → project Git-root downward to CWD, each dir
  (`AGENTS.override.md` → `AGENTS.md` → fallbacks). "Codex concatenates files from the root down,
  joining them with blank lines. Files closer to your current directory override earlier guidance
  because they appear later in the combined prompt." VERIFIED (docs).
- **One file per directory** (override OR regular, never both); empty files skipped; chain rebuilt
  every run (no cache). VERIFIED (docs).
- **Size cap:** `project_doc_max_bytes` default **32 KiB**; once reached Codex stops adding files.
  VERIFIED (docs). agents.md site itself gives NO size limit ("just standard Markdown… the agent
  parses the text you provide"). VERIFIED (agents.md).
- **`AGENTS.override.md`** beats `AGENTS.md` in the same dir — useful for a per-machine team override
  that survives repo edits. VERIFIED (docs).
- **What measurably steers Codex (community):** embed an explicit review checklist + build/test
  commands + code-style + "do not reassure / state what was NOT verified" in AGENTS.md; this is the
  battle-tested pattern in `shanraisshan/codex-cli-best-practice`. MEDIUM (single community repo via
  awesome-codex-cli). Our global AGENTS.md already encodes the strongest variant of this.
- **Source quote (spec):** "Agents automatically read the nearest file in the directory tree, so the
  closest one takes precedence." VERIFIED (agents.md). 60+ agents support AGENTS.md.

URLs: https://agents.md · https://developers.openai.com/codex/guides/agents-md

## 2. Skills system (`/skills`, v0.138)

- **Format:** `SKILL.md` with YAML frontmatter, required fields **`name`** + **`description`**.
  VERIFIED (local: `~/.codex/skills/root-cause-debugging/SKILL.md` + docs). Description is the
  trigger surface — "front-load the key use case and trigger words." VERIFIED (docs).
- **Skill dir layout:** `SKILL.md` (required) + optional `scripts/`, `references/`, `assets/`,
  `agents/openai.yaml`. VERIFIED (local: `hatch-pet` skill has all four; `root-cause-debugging` has
  `agents/openai.yaml`).
- **`agents/openai.yaml`** = UI/invocation metadata ONLY: `interface.display_name`,
  `short_description`, `default_prompt`; also (docs) icons/colors, allow/prevent auto-invocation,
  tool dependencies. VERIFIED (local file contents + docs). NOT the subagent definition (see §3).
- **Locations (increasing scope, docs):** `$CWD/.agents/skills` → `$REPO_ROOT/.agents/skills` →
  `$HOME/.agents/skills` → `/etc/codex/skills`. VERIFIED (docs).
  - **DRIFT NOTE:** local install resolves skills at `~/.codex/skills/` (7 installed), NOT
    `~/.agents/skills`. So both `~/.codex/skills` (install reality) and `~/.agents/skills` (docs) are
    in play. UNVERIFIED which wins on precedence collision — test before relying.
- **Trigger:** explicit via `/skills`, `$skillname`, or mention; implicit via `description` match.
  VERIFIED (docs). Progressive disclosure: only name+description+path loaded up front (~2% of context
  cap), full `SKILL.md` loaded on use. VERIFIED (docs).
- **Examples worth copying (local, all real on disk):** `root-cause-debugging` (reproduce→one
  hypothesis→smallest decisive check→fix root cause→verify; escalate after 2 failed same-style
  fixes), `blind-spot-review` (final anti-fake-completeness sweep), `research-pre-mortem`,
  `implementation-planning`, `cto-vibe-collaboration`, `session-compounding`. VERIFIED (local).
  These mirror our zer0 pipeline 1:1 — reuse the frontmatter `description` discipline.

URL: https://developers.openai.com/codex/skills

## 3. Subagents — standalone TOML (NOT openai.yaml)

- **Definition:** standalone TOML files under **`~/.codex/agents/`** (personal) or `.codex/agents/`
  (project). Required fields: `name`, `description`, `developer_instructions`. Each file = ONE custom
  agent; can override `model`, `sandbox_mode`, `mcp_servers`. VERIFIED (docs/subagents).
- **Global caps:** `[agents] max_threads` default **6**, `max_depth` default **1**. VERIFIED (docs).
- **Delegation:** Codex spawns a subagent ONLY when explicitly asked ("Spawn one agent per point,
  wait for all, summarize each"). No silent auto-spawn. VERIFIED (docs).
- **TEAM RELEVANCE:** a `codex-reviewer` subagent TOML with `sandbox_mode = "read-only"` +
  `developer_instructions` = our hostile-skeptic rubric is the native way to pin a read-only
  reviewer. This is distinct from `codex exec` review dispatch (which we already use via dispatch.sh).

URL: https://developers.openai.com/codex/subagents

## 4. config.toml power features (team-relevant)

All keys VERIFIED at developers.openai.com/codex/config-reference unless noted.

- **`model`** (string, local = `"gpt-5.5"`), **`model_reasoning_effort`** ∈
  `minimal|low|medium|high|xhigh` (local = `"xhigh"`), **`model_reasoning_summary`** ∈
  `auto|concise|detailed|none`. VERIFIED (docs + local config.toml).
- **Profiles:** select via `--profile NAME`; profile files at `$CODEX_HOME/NAME.config.toml`.
  VERIFIED (docs). → distinct profiles for builder (workspace-write) vs reviewer (read-only).
- **Web search:** `[tools] web_search = "disabled"|"cached"|"live"` OR object form
  `{ context_size = "low|medium|high", allowed_domains = [...], location = {...} }`. VERIFIED (docs).
- **MCP servers:** `[mcp_servers.<id>]` with `command`, `args[]`, `env{}`, `url` (HTTP),
  `startup_timeout_sec`, `tool_timeout_sec`, `enabled`. VERIFIED (docs).
- **Sandbox:** `sandbox_mode` ∈ `read-only|workspace-write|danger-full-access`. VERIFIED (docs +
  local has `[windows] sandbox = "unelevated"`).
- **Approval:** `approval_policy` ∈ `untrusted|on-request|never` (+ granular object with
  `sandbox_approval`, `rules`, `mcp_elicitations`, `request_permissions`, `skill_approval`). VERIFIED
  (docs). NOTE: docs extract did not echo `on-failure` — treat that enum value as UNVERIFIED for
  0.138.
- **Notify hook:** `notify = [array<string>]` — command invoked with a JSON payload on events.
  VERIFIED (docs). → wire a Windows notifier for long codex runs.
- **Shell env policy:** `[shell_environment_policy] inherit = "all"|"core"|"none"` + `set{}`.
  VERIFIED (docs). Aligns with our childEnv SSOT / no-provider-keys invariant.
- **Per-project trust:** `[projects.'<path>'] trust_level = "trusted"`. VERIFIED (local config.toml).
- **Structured review output:** `codex exec --output-schema <file>` → JSON; local
  `~/.codex/review-schema.json` defines `findings[]{severity:P0|P1|P2, file, line, finding,
evidence}, summary, confidence:GREEN|YELLOW|RED`. VERIFIED (local file). The schema comment states
  default reviews use markdown tables per AGENTS.md; schema is for machine parsing only.

URL: https://developers.openai.com/codex/config-reference

## 5. Memories feature

- **Enable:** `[features] memories = true` (default `false`, maturity "Stable"); or
  `--enable memories`. VERIFIED (docs).
- **Two independent switches:** `memories.generate_memories` (write new) +
  `memories.use_memories` (inject existing into future sessions). VERIFIED (docs).
- **Other keys:** `memories.disable_on_external_context` (skip threads that used MCP/web/tool-search;
  legacy alias `no_memories_if_mcp_or_web_search`), `memories.min_rate_limit_remaining_percent`,
  `memories.extract_model`, `memories.consolidation_model`. VERIFIED (docs).
- **Idle threshold:** default **6 hours** before a thread is consolidated; clamped **1–48h**.
  VERIFIED (web, MEDIUM — secondary corroboration; exact key name UNVERIFIED).
- **Storage:** `~/.codex/memories/` (honors `CODEX_HOME`). Consolidated output =
  **`MEMORY.md`** ("summaries, durable entries, recent inputs, supporting evidence"). VERIFIED
  (docs + local: `~/.codex/memories/MEMORY.md`, `memory_summary.md`, `raw_memories.md`,
  `rollout_summaries/` all present on disk).
- **Persistence model:** consolidation runs in background at next startup over recent rollouts;
  local-only generated state (fresh machine = no memory until regenerated). VERIFIED (docs + web).
- **Local evidence it works:** our `~/.codex/memories/memory_summary.md` already captured a real
  user-profile + 9 explicit preferences (read-only audits, "check the real code", shell-only literal
  workflows). VERIFIED (local). RISK: memory is auto-generated from rollouts — it can encode noise
  (e.g. the long "allow.txt/deny.txt" task group). For a deterministic Team Pack, prefer
  AGENTS.md/skills (authored) over memories (emergent); gate memories with
  `disable_on_external_context = true` so research/MCP runs don't pollute it.

URLs: https://developers.openai.com/codex/memories ·
https://github.com/openai/codex/discussions/12567 ·
https://codex.danielvaughan.com/2026/05/01/codex-cli-memories-persistent-context-session-memory-ecosystem/

## 6. Community tactics (codex-as-reviewer / multi-agent) — MEDIUM unless noted

Source list: https://github.com/RoggeOhta/awesome-codex-cli (150+ tools, curated).

1. **Read-only reviewer profile + subagent.** Define a reviewer `~/.codex/agents/*.toml` with
   `sandbox_mode = "read-only"` and rubric in `developer_instructions`; pair with a `--profile
code-reviewer` (`$CODEX_HOME/code-reviewer.config.toml`). Native version of our dispatch.sh
   read-only review. MEDIUM.
2. **Specialist review fan-out** (`VoltAgent/awesome-codex-subagents`, 136+ agents): separate
   `review_security` / `review_perf` / `review_style` subagents, each with focused AGENTS.md context,
   run in parallel. Maps onto our 2-pass / multi-dimension audit. MEDIUM.
3. **CI dispatch via `openai/codex-action`** (`codex exec` in GitHub Actions, non-interactive,
   sandbox-enforced, auto-comments findings on PRs). Closest official primitive for headless review;
   pairs with `--output-schema review-schema.json`. MEDIUM (official action + community guide).
4. **AGENTS.md review-checklist template** (`shanraisshan/codex-cli-best-practice`): embed
   OWASP/coverage/style checklist + sandbox/approval recommendations directly in AGENTS.md scoped to
   a review skill. MEDIUM.
5. **Cross-model peer review:** Codex reviews Claude's output and vice-versa to catch model-specific
   blind spots — explicitly cited as an active 2026 pattern; matches our locked cross-family rule.
   MEDIUM (community blog, no primary spec).

## Conflicts / Uncertainties

- Skills location: docs say `~/.agents/skills`; install uses `~/.codex/skills`. Precedence on
  collision UNVERIFIED — test.
- `approval_policy` value `on-failure` and `on-request`: docs extract listed
  `untrusted|on-request|never`; `on-failure` UNVERIFIED for 0.138.
- Memories idle-threshold exact key name UNVERIFIED (value 6h/1–48h corroborated secondarily).
- GitHub blob/raw config.md URLs returned rendered shells, not raw text; config keys taken from
  developers.openai.com/codex/config-reference instead (still primary).
