# Turbocharging gemini-cli as a Team Member (2026-06-09, pre-Antigravity)

Installed under test: `@google/gemini-cli` **0.45.2** (npm global, `C:/Users/<user>/AppData/Roaming/npm/node_modules/@google/gemini-cli`). npm dist-tags at research time: latest `0.46.0`, preview `0.47.0-preview.0`, nightly `0.47.0-nightly.20260609`.
Local config schema is already the new nested v2 form (`~/.gemini/settings.json`: `context.fileName: ["GEMINI.md","AGENTS.md"]`, `general.defaultApprovalMode: "default"`, `model.name: "gemini-2.5-pro"`).

Truth hierarchy used: installed bundle source (`bundle/chunk-25BU7OMU.js`) > repo docs (raw.githubusercontent / github.com main) > official Google blog/Antigravity docs > community. Each claim marked VERIFIED / UNVERIFIED.

Sunset dates (VERIFIED, official blog): Antigravity CLI GA'd ~2026-05-19; Gemini CLI + Code Assist IDE **stop serving Google AI Pro/Ultra + free consumer requests on 2026-06-18**. Enterprise (paid license / API key) keeps access.
Source: https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/

---

## (1) GEMINI.md — discovery, precedence, content that steers

- **Custom filename(s)** via `context.fileName` (string OR array). VERIFIED installed: bundle grep `contextFileName`; our settings already set `["GEMINI.md","AGENTS.md"]`. Doc: https://geminicli.com/docs/reference/configuration/
- **Hierarchical load** = global `~/.gemini/<name>.md` + upward search from CWD to project root (`.git` boundary) + subdirectory files; concatenated, more-specific overrides/appends. `context.includeDirectories` adds extra workspace dirs (System→User→Workspace concatenated). VERIFIED (doc above + installed `IncludeDirectories`). Exact numeric ordering of every tier UNVERIFIED in prose (doc says "Project overrides user/system").
- **Refresh**: `/memory refresh` reloads; `/memory show` prints combined context; `/memory add` appends. VERIFIED (commands doc / settings doc). Import nested files with `@path/file.md` (`context.importFormat`). VERIFIED key name; deep import semantics UNVERIFIED beyond key existence.
- **Size guidance**: no official hard limit found. UNVERIFIED — treat as: front-load most-critical rules (anchoring), keep <~ a few hundred lines so it doesn't crowd context. Our current `~/.gemini/GEMINI.md` is 59 lines and already does role + severity scale + hallucination self-check + output-table format.
- **What measurably steers**: role/identity line, an explicit output schema (table format), a self-check checklist, and "per-dispatch prompt overrides these" escape hatch. (Observation from our own working GEMINI.md; effect is qualitative, not benchmarked → MEDIUM.)

## (2) Agent Skills — VERIFIED present in installed 0.45.2

Installed-code evidence (bundle): `.gemini/skills`, `SKILL.md`, `frontmatter`, `loadSkillsFromDir`, `skillManager.getAllSkills`, `activate_skill`, `/skills` command (`skillsCommand.ts`), `settings.skills`, `extension.skills`, and an admin gate `isSkillsSupportEnabled()` + `getSkillManager().isAdminEnabled()`.

- **Four discovery tiers, low→high precedence**: built-in < extension-bundled < user (`~/.gemini/skills/` or `~/.agents/skills/`) < workspace (`.gemini/skills/` or `.agents/skills/`). VERIFIED. Source: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/skills.md
- **Format**: folder per skill containing `SKILL.md`. YAML frontmatter **required fields = `name`** (lowercase/digits/hyphens, ≤64 chars, must match dir) **+ `description`** (single line; THIS is the trigger — list tasks + keywords). Delimiters `---` on own lines; any text before opening `---` = silently skipped. Optional sibling dirs `scripts/ references/ assets/` (whole folder granted on activation). VERIFIED. Sources: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/creating-skills.md , https://geminicli.com/docs/cli/creating-skills/
- **Trigger mechanism (progressive disclosure)**: at session start CLI injects only `name`+`description` of enabled skills into system prompt; model calls `activate_skill` when a task matches; on approval the full `SKILL.md` body + folder are added to history. VERIFIED (skills.md).
- **Commands**: `/skills list [all] [nodesc]`, `/skills link <path> [--scope user|workspace]`, `/skills enable|disable <name>`, `/skills reload|refresh`; terminal `gemini skills install/uninstall/list`. VERIFIED.
- **Team sharing**: "Workspace skills are shared with your team via version control" → commit `.gemini/skills/`. VERIFIED.
- **Gating caveat**: installed bundle shows skills can be admin-disabled (`isAdminEnabled() === false`). No experimental flag required by default, but enterprise/admin policy can suppress them. VERIFIED in bundle; not documented in public skills.md (UNVERIFIED in docs).
- "6 skills" footer: I did NOT find a literal "N skills" footer string in the bundle; the footer/UI renders via `renderSkillsList`/`skillSections`. The skills _feature_ is VERIFIED; the specific "6 skills" footer wording is UNVERIFIED (likely just count of discovered skills in your install).

## (3) Extensions + custom commands (TOML)

- **Custom commands**: TOML files in global `~/.gemini/commands/` or project `.gemini/commands/` (project wins on conflict). Fields: `prompt` (required), `description` (optional one-line). Subdir path → namespaced name with `:` (e.g. `git/commit.toml` → `/git:commit`). Injection: `{{args}}` (user text after command), `!{...}` (shell exec; `{{args}}` inside is auto shell-escaped), `@{...}` (embed file/dir listing). VERIFIED. Source: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/custom-commands.md
- **Extensions** package commands + MCP servers + context + (now) bundled skills for distribution; install via `gemini extensions install`. VERIFIED feature exists (bundle `extension.skills`, blog). Team-relevant: ship a "zer0-research" extension bundling our researcher skill + a `/zr:verify` command + GEMINI.md fragment. MEDIUM (mechanism verified; exact extension manifest schema not re-quoted here → check docs/extension.md before authoring).

## (4) settings.json power features (VERIFIED key names from reference config)

- `context.fileName` (custom GEMINI.md names), `context.includeDirectories`, `context.importFormat`.
- `mcpServers.<NAME>`: `command`, `args`, `env`, `trust` (bypass tool-confirm), `includeTools` (allowlist), `timeout` (ms). VERIFIED.
- `general.defaultApprovalMode`: **`default` | `auto_edit` | `plan`**. VERIFIED. **`yolo` is NOT a settings value** — only via CLI `--yolo` / `--approval-mode=yolo` or Ctrl+Y. VERIFIED (settings doc + community).
- `general.checkpointing.enabled`: session checkpointing for recovery; `/restore` tag flow exists (bundle: `saveCheckpoint`/`loadCheckpoint`/`checkpointDir`). VERIFIED. YOLO+checkpointing auto-creates restore points before tool exec.
- `tools.core` (allowlist built-ins), `tools.exclude` (deny). VERIFIED — key for sandboxing an unattended teammate.
- **Unattended/teamwork**: `--yolo`/`--approval-mode=yolo` + `tools.core` allowlist + `mcpServers.*.trust` + `checkpointing.enabled` is the headless combo. NOTE (memory `reference_gemini_dispatch_pattern`): for synthesis/review NEVER use YOLO — gemini silently writes hallucinated files. Use `plan` mode for research/review dispatches. VERIFIED (config) + our prior operational finding.
  Source: https://geminicli.com/docs/reference/configuration/

## (5) Community — gemini-as-researcher tactics (multi-agent)

1. **Lean on built-in Google Search grounding** as the verification oracle; Google claims ~40% hallucination reduction vs ungrounded, recommends temperature 1.0 when grounding. Our GEMINI.md already mandates "USE IT to verify any claim." MEDIUM (vendor stat). Source: https://inventivehq.com/knowledge-base/gemini/how-to-use-google-search-grounding , https://blog.google/innovation-and-ai/technology/developers-tools/introducing-gemini-cli-open-source-ai-agent/
2. **`web_fetch` over blogs** — pull official doc URLs directly for primary-source quotes (our GEMINI.md encodes this). VERIFIED (tool exists; bundle + our config).
3. **Vision/multimodal review** via `@screenshot.png` to audit UI/design/layout — gemini's differentiated strength in a trio where claude/codex are text-only by default. VERIFIED syntax (our GEMINI.md + image-input is a core gemini capability). MEDIUM on "best practice" framing.
4. **Mandate source-URL-or-UNVERIFIED + a hallucination self-check** in GEMINI.md — counters the known gemini fabrication pattern (memory `reference_gemini_hallucination_pattern`: 6 false NOT_MET findings). HIGH (our own empirical finding).
5. **Read-only/`plan` approval for research dispatches** so the researcher can't write hallucinated files; reserve write modes for build agents. HIGH (our operational lock). Deep Research Agent's Plan→multi-search→iterate→output loop is a useful prompt scaffold. Source: https://ai.google.dev/gemini-api/docs/deep-research

## (6) Antigravity CLI — confirmed transfers (official only)

Official blog states Antigravity CLI **keeps**: **"Agent Skills, Hooks, Subagents, and Extensions (now as Antigravity plugins)."** VERIFIED. Source: https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/

- **GEMINI.md / AGENTS.md**: continues to be parsed; global at `~/.gemini/GEMINI.md`. VERIFIED via community migration coverage + matches blog intent; NOT explicitly enumerated in the blog feature list → treat global-path as MEDIUM-official.
- **Skills**: transfer (SKILL.md model retained). Global skills path reportedly moves to `~/.gemini/antigravity-cli/skills/`; workspace `.agents/skills/*.md` can surface as TUI commands. VERIFIED-transfers (blog); exact new path = community-sourced → MEDIUM.
- **Extensions → Plugins**: rebranded; carry tools/integrations/custom commands. VERIFIED (blog).
- **Hooks + Subagents**: VERIFIED transfer (blog) — these are NEW surfaces worth adopting now if present in 0.45.2+ (not exercised in this research).
- **settings.json, MCP, approval modes, custom-command TOML, checkpointing**: NOT named in the blog's carry-over list → **UNVERIFIED for Antigravity**. The Antigravity migration doc (https://antigravity.google/docs/gcli-migration) is JS-rendered and returned no static text to WebFetch — confirm in-product before betting on these.

### Net transfer guidance

Skills, GEMINI.md/AGENTS.md, extensions(→plugins) are the SAFE bets to invest in now. Custom-command TOML and settings.json keys are likely-but-UNVERIFIED for Antigravity — keep them, but expect a migration step.
