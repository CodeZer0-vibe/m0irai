# Three-Agent Capability Parity — claude · codex · agy (2026-06-17)

Goal: equal, evidence-based understanding of all three coding agents (not just our adapter wiring).
Sources: each CLI's `--help`, the operator's REAL config files, authoritative docs, + the live
full-team smoke (all three PASS). The three CLIs independently converged on the SAME agent model.

## The unified model (all three share it)

1. **Trust list** — a dir must be "trusted" before the agent acts freely in it.
2. **Tiered permission/approval** — read-only → scoped-write(+commands) → full/unconfined.
3. **Granular allow/deny rules** — per-tool / per-command allowlist + denylist.
4. **Context file** — a plain-text project prompt auto-prepended.
5. **Headless exec** — a non-interactive one-shot mode.
6. **Sandbox** — OS-level confinement, separate from the permission decision.

## claude (Claude Code) — VERIFIED (--help + ~/.claude/settings.json + code.claude.com docs)

- **Permission modes** (`--permission-mode`): `default` (reads auto, edits/cmds prompt) · `acceptEdits`
  (edits + safe fs cmds auto) · `plan` (read-only, propose) · `auto` (classifier-gated full, preview) ·
  `dontAsk` (only allow-rules + read-only — CI) · **`bypassPermissions`** (everything, no checks).
- **Granular rules** (`settings.json.permissions`): `allow`/`ask`/`deny` with `Bash(git *)`, `Edit`,
  `Read(./src/**)`, `WebFetch(domain:…)`; precedence **deny > ask > allow > mode**. `additionalDirectories`.
- **Operator's real config:** big `allow` list (Bash npm/git/node/tsc/vitest/docker/…, Read/Write/Edit),
  `deny` (.env, secrets/\*_, _.pem, id_rsa), model `claude-opus-4-8[1m]`, many hooks. = a curated full agent.
- **Trust/scope:** working dir + `--add-dir` + `additionalDirectories`. **Context:** CLAUDE.md (user
  `~/.claude/CLAUDE.md` + project tree + `.claude/rules/**`), auto-discovered + concatenated.
- **Headless:** `claude -p` (subscription-first; API key only if `ANTHROPIC_API_KEY` set). `--bare` forces
  API key. `--setting-sources ""` isolates from project hooks/rules. **Sandbox:** separate `sandbox{}` block.
- **OUR product posture:** persistent **node-pty** session, `--permission-mode bypassPermissions
--setting-sources ""`, cwd=worktree → **full read/write/exec, no prompts, unconfined.** (NOT `-p` — that
  meters API from 06-15.)

## codex (OpenAI Codex CLI) — VERIFIED (--help + ~/.codex/config.toml + developers.openai.com docs)

- **Sandbox modes** (`--sandbox`): `read-only` (default) · **`workspace-write`** (read + edit-in-workspace +
  routine local commands inside the boundary) · `danger-full-access` (no sandbox).
- **Approval policy** (`approval_policy`): `untrusted` / `on-request` (default — work in sandbox, ask to
  exceed) / `on-failure` / `never`. Full autonomy = `danger-full-access` + `never`.
- **Trust:** `config.toml` `[projects.'<path>'] trust_level = "trusted"` (operator's config has MANY trusted
  temp dirs from prior adapter/tower runs — same trust-list idea as agy/claude).
- **Granular:** `sandbox_workspace_write.writable_roots`, `-c key=value` overrides. **Context:** AGENTS.md.
- **Headless:** `codex exec` (prompt as arg OR stdin; subcommands `resume`/`review`). Also `mcp-server`,
  `app-server`. **OUR product posture:** `codex exec --sandbox workspace-write` (build/chat/research) /
  `read-only` (review); research adds `-c web_search=live`; cwd=worktree, stdin=contextFile → **sandboxed
  full read/write + scoped exec, chatMode-gated.** (ZER0_PTY path uses `--dangerously-bypass-approvals-and-sandbox`.)

## agy (Antigravity CLI) — VERIFIED (probes + ~/.gemini config + docs) — see 2026-06-17-agy-full-capabilities.md

- **Approval** (`~/.gemini/settings.json` `general.defaultApprovalMode`): `default`/`auto_edit`/`yolo`;
  Tool Permission request-review/proceed-in-sandbox/always-proceed/strict; Terminal Auto/Turbo/Off; granular allow/deny.
- **Trust:** `~/.gemini/antigravity-cli/settings.json` `trustedWorkspaces`. **Context:** `context.fileName:["GEMINI.md","AGENTS.md"]`.
- **Headless:** `agy -p` (needs ConPTY; arg-only). `--add-dir <ROOT>` (subdir hangs). `--sandbox`=write-no-exec.
- **Proven:** `auto_edit` + trusted worktree → `agy --add-dir <worktree> -p` auto-writes + auto-execs (no yolo).
- **OUR target posture:** build → `--add-dir <worktree> -p` + auto_edit (full r/w/x); chat/research → `--sandbox`.

## Parity table (headless team lane)

|                | claude                         | codex                       | agy (target)                             |
| -------------- | ------------------------------ | --------------------------- | ---------------------------------------- |
| Mechanism      | node-pty session               | `codex exec` (execa)        | ConPTY one-shot                          |
| Full mode      | `bypassPermissions`            | `--sandbox workspace-write` | `auto_edit` + `--add-dir worktree`       |
| Confinement    | none (unconfined)              | sandboxed (workspace)       | --sandbox(write-only) or none(auto_edit) |
| chatMode-gated | no (always full)               | YES (read-only ↔ write)     | YES (mirror codex)                       |
| Trust list     | additionalDirectories/settings | config.toml trust_level     | trustedWorkspaces                        |
| Context file   | CLAUDE.md                      | AGENTS.md                   | AGENTS.md / GEMINI.md                    |
| cwd            | worktree                       | worktree                    | worktree                                 |
| Auth           | subscription (no `-p`)         | subscription                | subscription (keyring)                   |
| Provider keys  | none (whitelist env)           | none                        | none                                     |

## Empirical proof (not just docs)

- **Full-team smoke GREEN 2026-06-17:** claude+codex+agy-gemini solo, @all council (3 concurrent),
  shared-memory (agy read claude's codeword), multi-address — all PASS. → all three run live in the team.
- agy capability live-probed (read/write/exec). claude/codex capability = documented + daily product use + smoke.

## Implication for the gemini→agy full-agent build

gemini→agy should mirror **codex's chatMode-gating** (build=full, review/chat=read) using **agy's
`auto_edit`** as the full enabler — landing between codex (sandboxed) and claude (unconfined). All three
then share one mental model: trust the worktree, tiered permission by chatMode, context file (CLAUDE.md /
AGENTS.md), subscription auth, no provider keys.

## Sources

- claude: `claude --help`, `~/.claude/settings.json`, code.claude.com/docs (permission-modes, permissions,
  memory, settings, authentication) via claude-code-guide.
- codex: `codex --help` / `codex exec --help`, `~/.codex/config.toml`, developers.openai.com/codex
  (sandboxing, permissions, config-reference, agent-approvals-security).
- agy: 2026-06-17-agy-full-capabilities.md (probes + ~/.gemini + docs).
