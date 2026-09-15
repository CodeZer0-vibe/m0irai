# Turbocharging Claude Code (2026) as a Multi-Agent Team Member — Research

Date: 2026-06-09 · Researcher: zer0 (researcher mode)
Scope: the DELTA — surfaces we likely UNDER-use. We already exploit CLAUDE.md hierarchies, custom skills, `.claude/agents/*.md`, hooks, memory dirs.
Trust order applied: official docs (code.claude.com, version-matched) > anthropics/skills repo > community repos.
NOTE: docs moved `docs.anthropic.com/en/docs/claude-code/*` → `code.claude.com/docs/en/*` (301). All quotes below are from the live `code.claude.com` pages fetched 2026-06-09.

---

## THE LIVE QUESTION FIRST: what does `--setting-sources ""` exclude?

ANSWER (VERIFIED): `--setting-sources` controls **settings.json files only** (user/project/local `settings.json` + `settings.local.json`). It is NOT the loader for the CLAUDE.md memory hierarchy. CLAUDE.md/CLAUDE.local.md/`.claude/rules/` are loaded by a SEPARATE directory-walk mechanism. There is exactly ONE documented coupling: excluding `local` ALSO suppresses `CLAUDE.local.md`.

Evidence:

- CLI reference: `--setting-sources` = "Comma-separated list of setting sources to load (`user`, `project`, `local`)". Example `claude --setting-sources user,project`. — https://code.claude.com/docs/en/cli-reference [VERIFIED]
- Memory doc, the ONLY place setting-sources touches CLAUDE.md: "`CLAUDE.local.md` is skipped if you exclude `local` from `--setting-sources`." — https://code.claude.com/docs/en/memory#load-from-additional-directories [VERIFIED]
- Memory doc describes CLAUDE.md loading as an independent walk: "Claude Code reads CLAUDE.md files by walking up the directory tree from your current working directory" — no mention of setting-sources gating `./CLAUDE.md` or `.claude/CLAUDE.md`. — https://code.claude.com/docs/en/memory#how-claude-md-files-load [VERIFIED]
- The `settings` page itself contains NO `--setting-sources` text (it documents scopes/precedence only). Two independent fetches confirmed absence. — https://code.claude.com/docs/en/settings [VERIFIED — negative result]

So `--setting-sources ""` (empty / omitting all): suppresses user+project+local **settings.json**. Project/user CLAUDE.md and `.claude/rules/` STILL load (separate mechanism); `CLAUDE.local.md` is suppressed only because `local` was excluded. To nuke ALL customization including CLAUDE.md, the documented switch is `--safe-mode` (min-version 2.1.169) or `--bare`, NOT `--setting-sources`.
Caveat: the docs do not give an explicit "setting-sources does not gate ./CLAUDE.md" sentence; this is inferred from two doc sections describing the two loaders independently + the single stated `local` coupling. Confidence HIGH, not absolute.
CONFIDENCE: HIGH (2 primary doc sections + corroborating negative on settings page).

---

## (1) SKILLS — best practices to bake into a "zer0-teammate" skill

Source: https://code.claude.com/docs/en/skills + https://code.claude.com/docs/en/sub-agents + https://github.com/anthropics/skills (README is thin — see note).

Mechanics that govern reliable firing [all VERIFIED from skills doc]:

- "skill descriptions are loaded into context so Claude knows what's available, but full skill content only loads when invoked." (progressive disclosure).
- `description`: "What the skill does and when to use it. Claude uses this to decide when to apply the skill... **Put the key use case first**: the combined `description` and `when_to_use` text is **truncated at 1,536 characters** in the skill listing." Cap configurable via `maxSkillDescriptionChars`.
- `when_to_use` field (separate from description): "Additional context for when Claude should invoke the skill, such as **trigger phrases or example requests**. Appended to `description`... counts toward the 1,536-character cap."
- Supporting files: "Keep `SKILL.md` under 500 lines. Move detailed reference material to separate files." "Reference these files from your `SKILL.md` so Claude knows what they contain and when to load it."
- Firing reliability failure mode (doc-stated): "If a skill seems to stop influencing behavior after the first response... Strengthen the skill's `description` and instructions so the model keeps preferring it, or use **hooks to enforce behavior deterministically**. If the skill is large... **re-invoke it after compaction** to restore the full content."
- `disable-model-invocation: true` → not auto-loaded AND not preloadable into subagents; `user-invocable: false` → only Claude invokes (good for background knowledge).
- Tool control in-skill: `allowed-tools` (grants without prompt while active), `disallowed-tools` (removes from pool until next user message). `context: fork` + `agent:` runs skill in a subagent.

TOP 3 PATTERNS TO COPY into zer0-teammate skill:

1. **Directive-first, trigger-phrase-loaded `description` ≤1,536 chars, key use case in first sentence**, with explicit `when_to_use` trigger phrases. This is the single highest-leverage lever for firing under pressure — it's the only text in context until invocation.
2. **Progressive disclosure: ≤500-line SKILL.md + referenced supporting files** (rubrics, templates) that load on demand. Matches our existing code-zero-\* skills; extend to teammate-coordination playbooks.
3. **Pair the skill with a hook for the non-negotiable step.** Doc explicitly says skills are context (soft) and hooks are deterministic enforcement. Our "Always Dispatch Review" / gate rules belong in hooks, with the skill carrying the judgment.
   CONFIDENCE: HIGH (skills doc). anthropics/skills README adds little beyond `name`+`description` structure [VERIFIED it's thin] — the AUTHORITATIVE best-practice text lives in the skills doc, not the repo.

---

## (2) NATIVE TEAMS / agent-to-agent coordination — IT EXISTS (experimental)

Source: https://code.claude.com/docs/en/agent-teams [ALL VERIFIED]

- **Agent teams are a real, official, EXPERIMENTAL feature.** Enable: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (env or settings.json `env`). Requires **Claude Code v2.1.32+**.
- Architecture (verbatim): components are **Team lead** (the session that creates the team — fixed for its lifetime), **Teammates** (separate full Claude Code instances, own context window), **Task list** (shared, file-locked claiming), **Mailbox** ("Messaging system for communication between agents").
- This IS the `SendMessage`/`TeamCreate` surface: "Team coordination tools such as **`SendMessage`** and the task management tools are always available to a teammate even when `tools` restricts other tools." Teammates "**message each other directly**" — unlike subagents which "report results back to the main agent only."
- Teammates reuse subagent definitions: "you can reference a subagent type from any subagent scope... the definition's body is **appended** to the teammate's system prompt... rather than replacing it." So our `.claude/agents/*.md` (skeptic, code-reviewer, etc.) are reusable AS teammates.
- Quality gates via hooks: `TeammateIdle`, `TaskCreated`, `TaskCompleted` hooks — "Exit with code 2 to ... send feedback / prevent creation / prevent completion." This is a native gate-topology hook surface.
- Plan-approval flow: lead can require teammates to plan in read-only mode and approve/reject before implementation.
- Storage: `~/.claude/teams/{team}/config.json`, tasks `~/.claude/tasks/{team}/`; removed on cleanup/session end. "do not edit by hand."
- LIMITATIONS [VERIFIED]: **no nested teams** (teammates can't spawn teams), **one team per lead at a time**, lead is fixed, no `/resume` for in-process teammates, **split panes need tmux or iTerm2 — NOT supported in Windows Terminal, VS Code terminal, or Ghostty** (in-process mode works anywhere). Higher token cost (each teammate is a full instance).

WINDOWS RELEVANCE for us: in-process teammate mode (`teammateMode: "in-process"` or `--teammate-mode in-process`) "Works in any terminal." Split panes are the part that's tmux/macOS-bound — consistent with our prior landscape finding that the field is tmux-centric. We could ride native in-process teams instead of building bespoke mailbox/task-list plumbing for the lead-coordinates-research/review use case.
CONFIDENCE: HIGH (single dedicated primary doc, but feature is flagged EXPERIMENTAL with stated bugs — treat as preview, not stable contract).

## SUBAGENT features we likely under-use [VERIFIED, sub-agents doc]

- `skills` frontmatter field: "Skills to preload into the subagent's context **at startup. The full skill content is injected, not just the description.**" → bake our methodology skill into every dispatched agent's startup context, not relying on auto-trigger.
- `memory` frontmatter (`user`/`project`/`local`): gives a subagent a "persistent directory that survives across conversations" at e.g. `~/.claude/agent-memory/<name>/`; auto-loads first 200 lines/25KB of its `MEMORY.md`, auto-enables Read/Write/Edit. → our code-reviewer/skeptic agents could accumulate cross-session pattern memory. We are almost certainly NOT using this.
- `--agents` flag: define subagents inline as JSON (fields incl. `skills`, `memory`, `effort`, `background`, `isolation`) — useful for scripted/ephemeral dispatch without files.
- Explore/Plan built-ins "skip CLAUDE.md and git status" to stay cheap — relevant when a forked skill uses `agent: Explore`.

---

## (3) OUTPUT STYLES vs --append-system-prompt vs CLAUDE.md — the system-prompt surfaces

Source: https://code.claude.com/docs/en/output-styles + https://code.claude.com/docs/en/memory [ALL VERIFIED]

DECISIVE distinction (verbatim, output-styles doc comparison table):

- **Output styles**: "Modifies the system prompt" — applies every turn; saved to `.claude/settings.local.json` as `outputStyle`; read once at session start (takes effect after `/clear` or restart). Custom style "leaves out Claude Code's built-in software engineering instructions ... unless `keep-coding-instructions: true`." Built-ins: Default, **Proactive** (execute-first), Explanatory, Learning. Frontmatter: `name`, `description`, `keep-coding-instructions`, `force-for-plugin`.
- **CLAUDE.md**: "Adds a user message **after** the system prompt." (Confirmed twice — memory troubleshooting section: "CLAUDE.md content is delivered as a user message after the system prompt, not as part of the system prompt itself.") This is WHY CLAUDE.md adherence is softer than a system-prompt edit.
- **`--append-system-prompt`** / **`--append-system-prompt-file`**: "Appends to the system prompt without removing anything" — per-invocation. File variant exists [VERIFIED CLI ref]. `--system-prompt` / `--system-prompt-file` REPLACE entirely (mutually exclusive with each other; append can combine with either).
- `--exclude-dynamic-system-prompt-sections`: moves cwd/env/memory-paths/git-flag out of system prompt into first user message for prompt-cache reuse across machines (scripted multi-user).

IMPLICATION for our Team Pack: our zer0-identity cluster-activation text currently rides CLAUDE.md (a user message). For maximum activation in DISPATCHED agents, the same text delivered via `--append-system-prompt-file` (or a custom output style with `keep-coding-instructions: true`) sits at the SYSTEM-PROMPT level — stronger steering than the user-message channel. This matches our "Layer 1 is load-bearing" memory; output-styles/append are a stronger Layer-1 carrier than CLAUDE.md alone. [Inference, HIGH confidence on mechanism, UNVERIFIED on relative adherence magnitude — no A/B in docs.]
CONFIDENCE: HIGH (mechanism quoted from primary docs).

---

## (4) PLUGINS / MARKETPLACE — team-coordination relevance

Source: https://code.claude.com/docs/en/plugins [ALL VERIFIED]

- A plugin can bundle: `skills/`, `agents/`, `hooks/hooks.json`, `.mcp.json`, `.lsp.json`, **`monitors/monitors.json`** (background watchers that push stdout lines to Claude as notifications), `bin/` (PATH executables), and a plugin-root `settings.json`.
- Plugin `settings.json` supports only `agent` and `subagentStatusLine` keys today. `"agent": "<name>"` "activates one of the plugin's custom agents as the **main thread**, applying its system prompt, tool restrictions, and model" — i.e. a plugin can REDEFINE the default driver persona. Directly relevant to shipping a "zer0 driver" as an installable unit.
- Distribution: two Anthropic marketplaces — `claude-plugins-official` (curated, auto-registered) and `claude-community` (`/plugin marketplace add anthropics/claude-plugins-community`). Private team marketplaces via private repo. `claude plugin validate` before submit.
- Team-coordination angle: package our agents + hooks + methodology skills as ONE versioned plugin so all three native agents (and teammates) load identical config — replaces ad-hoc `.claude/` copying. `monitors/` is a NOVEL surface for us: native background log/status watch feeding the agent without polling.
  CONFIDENCE: HIGH (primary doc).

---

## (5) COMMUNITY MULTI-CLAUDE PATTERNS (last ~6 months) — concrete tactics

Secondary sources (LOW–MED trust; verify against your stack before adopting):

1. **Git-worktree fleet isolation** — one worktree + branch + PR per agent to eliminate same-file race/merge conflicts. Universal across orchestrators. Native equivalent now exists: `claude --teammate-mode` + docs' own [worktrees](https://code.claude.com/docs/en/worktrees) page. Sources: ComposioHQ/agent-orchestrator (https://github.com/ComposioHQ/agent-orchestrator), MindStudio worktrees playbook (https://www.mindstudio.ai/blog/parallel-agentic-development-git-worktrees). [MED — multiple independent corroboration]
2. **ccswarm** — Claude-Code-CLI orchestration w/ worktree isolation + specialized agents + template scaffolding. https://github.com/nwiizo/ccswarm [LOW — single repo, popularity unverified]
3. **Primary-agent-deconstructs-then-summons** (lead splits tasks → long-running autonomous subagents) — described as the shared pattern across "Agent Teams, Gas Town, Multiclaude." This is exactly what native agent-teams now formalizes. Source: Shipyard (https://shipyard.build/blog/claude-code-multi-agent/), AddyOsmani "Code Agent Orchestra" (https://addyosmani.com/blog/code-agent-orchestra/). [LOW-MED]
4. **2–5 parallel agents is the practical sweet spot; 10+ only with tmux automation + an orchestrator agent.** Matches native doc's own "Start with 3-5 teammates." Source: Shipyard. [MED — agrees with primary doc]
5. **Curated index** for tracking the field: andyrewlee/awesome-agent-orchestrators (https://github.com/andyrewlee/awesome-agent-orchestrators). [LOW — list, not a pattern]
   CONFIDENCE: MEDIUM where corroborated by the native agent-teams doc; LOW for single-repo claims. None verified against Windows.

---

## NET DELTA — what we are most likely under-using

1. Subagent `skills:` preload + `memory:` frontmatter (cross-session agent learning) — strongest under-used surface.
2. Native experimental agent-teams (mailbox/SendMessage/shared task list) for the research/review/debate use cases we hand-roll.
3. Output-style / `--append-system-prompt-file` as a stronger system-prompt-level carrier for cluster-activation vs CLAUDE.md's user-message channel.
4. Plugin packaging (+ `monitors/`) for one versioned, shareable Team Pack.
5. `when_to_use` trigger-phrase field + 1,536-char description discipline for firing reliability.
