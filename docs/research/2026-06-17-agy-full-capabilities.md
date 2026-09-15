# Antigravity CLI (`agy`) — Full Capability Map (2026-06-17)

Purpose: understand agy completely so we drive it to the max. Mixes EMPIRICAL findings (our probes,
Windows, node-pty ConPTY) with DOC findings (cited). gemini-cli EOL 06-18 → agy is the successor.

## 1. Runtime invariants (EMPIRICAL — proven on this machine)

- **Needs a real console.** Consoleless (redirected stdio / pipe) → `agy models`/`-p` HANG with zero
  output. `--version`/`--help` work (flag handlers). FIX: spawn under a ConPTY (node-pty). PROVEN.
- **`-p`/`--print`** = one-shot, prompt as the ARG value (no stdin; ~32KB Windows arg cap). Clean stdout.
- **`--add-dir <ROOT>` works; a SUBDIR inside a repo HANGS.** `--add-dir <worktree root>` read the real
  repo fine ("~40 top-level entries"); `--add-dir <repo>/.council/.../prompts` (a subdir) hung 150s
  (agy walks up + indexes node_modules). RULE: add the project ROOT (it scopes/ignores correctly), or
  an isolated OS-temp dir — never a repo subdir.
- **`--sandbox` is NOT read-only.** Under `--sandbox -p`, FILE WRITES auto-proceed (wrote `out.txt`,
  and `zzz-agy-probe.txt` to the real worktree root) — but SHELL EXEC is blocked (terminal restricted →
  hang). So `--sandbox` = auto read+write, no exec.
- Interactive (`-i`/bare) first run shows a **"Do you trust the contents of this project? > Yes / No
  ↑/↓ enter"** frame — detectable + Enter-injectable (tower option B: ConPTY frame mediation). After
  trust, it executed write_file. agy has NO ACP (`--acp` rejected; GitHub issue #31 open).

## 2. Capability tiers (how to get full agent)

- **Tier A — read+write builder, NO exec (works NOW, no config, no yolo):**
  `agy --sandbox --add-dir <worktree-root> -p "<task>"` → reads + edits files in the worktree, scoped.
- **Tier B — full read+write+EXEC:** needs the permission policy opened (below). Then
  `agy --add-dir <worktree-root> -p "<task>"` runs commands too. (Headless auto-run of exec UNVERIFIED —
  the one open empirical test.)
- **Nuclear:** `--dangerously-skip-permissions` = auto-approve EVERYTHING (host-wide). Avoid — classifier
  blocks it + our standing "never-yolo-gemini" rule. The granular policy below is the right path.

## 3. Permission / autonomy model (DOC — the key to scoped-full without yolo)

- **Config:** `~/.gemini/antigravity-cli/settings.json` (global). Panel via `/config`, `/settings`,
  `/permissions`.
- **Tool Permission (overall knob):** default `request-review`; options `proceed-in-sandbox`,
  `always-proceed`, `strict`. → `proceed-in-sandbox`/`always-proceed` = auto-approve (the scoped-full path).
- **Terminal Execution Policy:** `Auto` (safety-classifier auto-runs safe cmds, pauses edits) / `Turbo`
  (deny-list only) / `Off` (allow-list only).
- **Artifact Review Policy** (file writes) + **MCP Tool Approval** are separate policies.
- **Granular allow/deny** (the codex-`workspace-write` parallel, done right):
  ```json
  {
    "permissions": {
      "allow": ["read_file(...)", "command(git)", "command(npm test)"],
      "deny": ["command(rm -rf)"]
    }
  }
  ```
- So: scoped full read/write/exec = `always-proceed`/`proceed-in-sandbox` + Terminal `Auto`/`Turbo` +
  a deny-list for destructive — NO `--dangerously-skip-permissions`.

## 4. Project-scoped customization (= our "team pack" lands natively)

- **`AGENTS.md` at the project root** → prepended to every prompt in that dir (agy reads it automatically).
  This IS where gemini's per-agent system prompt / team-pack belongs.
- Workspace **rules**: `<workspace>/.agent/rules/`; workspace **workflows**: `<workspace>/.agent/workflows/`.
- Global rules `~/.gemini/GEMINI.md`; global workflows `~/.gemini/antigravity/global_workflows/`.
- Permission settings.json appears GLOBAL (per-project override of _permissions_ not confirmed — open Q).

## 5. Orchestration / extras

- **Subagents:** agy auto-decomposes a goal into PARALLEL subagents with isolated context windows (built-in
  orchestration — usable to the max).
- **MCP:** `mcp_config.json` (servers), MCP Tool Approval policy.
- **Sessions:** `-c`/`--continue` (most recent), `--conversation <id>` (resume), `--model`, `--print-timeout`.
- **Slash:** `/goal` (autonomous), `/grill-me` (clarify), `/permissions`, `/config`, `/schedule` (cron).

## 6. Wiring implications for zer0 chat

- **Chat/review lane (sealed):** `agy --sandbox --add-dir <temp-context> -p` — read+respond. Keep.
- **Full builder lane (operator wants):** `agy --sandbox --add-dir <worktree-root> -p` for read+write now;
  for +exec, set settings.json (`proceed-in-sandbox` + Terminal `Auto` + deny destructive) and verify `-p`
  auto-runs exec. Per-lane safety vs the global settings.json is the open design point.
- **Team pack:** write gemini's system prompt as `AGENTS.md` in the worktree (native, auto-read) instead of
  injecting it into the `-p` arg.
- **Tower (per-action):** option B (ConPTY trust/permission-frame mediation) — agy has no ACP.

## 7. OPEN questions (the only things still presumed)

1. Does `-p` (headless) AUTO-run exec when settings.json = `always-proceed`/`Turbo` (no hang)? → empirical
   test (reversible settings.json edit).
2. Can _permissions_ be project-scoped (build-lane full vs chat-lane safe), or only global?
3. Exact `settings.json` key names/casing for Tool Permission + the policies (panel uses friendly names).

## Sources

- agy `--help` + our probes (P1 worktree-read, P2/P3 sandbox-write, P4 sandbox-exec-hang, tower trust-frame).
- dev.to/gde (YOLO + granular `permissions.allow/deny`), agentpedia (Terminal Exec Policy Auto/Turbo/Off),
  datacamp (subagents), codemeetai/aimeetcode (AGENTS.md, `.agent/rules|workflows`, `~/.gemini` paths),
  medium/google-cloud + codelabs (settings panel `/config`, Tool Permission options), GitHub issue #31 (no ACP).
