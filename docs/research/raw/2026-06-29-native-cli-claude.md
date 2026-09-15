# Documenting: Claude Code CLI — native session memory, project tracking, cross-session continuity

Scope: how the **Claude Code CLI** natively persists sessions, loads memory, resumes context, compacts, and checkpoints — verified against (a) the authoritative docs at `code.claude.com` / `platform.claude.com` and (b) **direct ground-truth inspection of `~/.claude` on this machine** (Claude Code **v2.1.195**, read from `~/.claude/sessions/19072.json` `"version":"2.1.195"`). Ground-truth claims are tagged `[GT]`; doc claims carry a URL. Items the docs do not state are tagged `UNVERIFIED`.

Distinction that runs through this whole doc: the **Claude Code CLI** has its _own_ memory/session machinery (auto-memory, JSONL transcripts, checkpoints). The **Anthropic Messages API** has a _separate_ `memory_20250818` tool + server-side compaction + client-side context editing. They are NOT the same system. The cockpit drives the CLI, so §1–3, §5–6 are the load-bearing ones; §4 is the API layer documented for completeness because the team lead asked.

---

## 1. Session persistence

**Where.** Transcripts are JSONL, one file per session:
`~/.claude/projects/<project-slug>/<session-id>.jsonl`
where `<project-slug>` is "your working directory path with non-alphanumeric characters replaced by `-`" — source: <https://code.claude.com/docs/en/sessions>. `[GT]` On this machine: `~/.claude/projects/C--Users-<user>-VibeCoding-TeamWork/` holds session files named by UUID, e.g. `0220166f-228c-4a7d-b000-7b333ab1c482.jsonl` (130 MB — transcripts grow unbounded within a session) down to 119-byte stubs.

**Write cadence.** "Sessions are saved continuously to local transcript files as you work… As the session runs, it appends every message, tool call, and result to a transcript file on disk." — <https://code.claude.com/docs/en/sessions>. Append-only event log.

**What a line is.** "Each line is a JSON object for a message, tool use, or metadata entry." Critical caveat for anyone parsing them: **"The entry format is internal to Claude Code and changes between versions, so scripts that parse these files directly can break on any release. To build on session data, use `/export` or the script interfaces instead."** — <https://code.claude.com/docs/en/sessions>.

**`[GT]` Actual line schema** (parsed from a real transcript on this machine). Per-line `type` ∈:

| `type`                     | carries                                                                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`                     | `message.{role,content}`, `cwd`, `gitBranch`, `timestamp`, `uuid`, `parentUuid`, `sessionId`, `version`, `promptId`, `promptSource`, `userType`, `isSidechain` |
| `assistant`                | `message.{role,content,id,model,usage,stop_reason,stop_details,diagnostics}` + same envelope fields + `requestId`                                              |
| `system`                   | meta events: `subtype`, `durationMs`, `messageCount`, `isMeta`                                                                                                 |
| `attachment`               | injected context (files, dirs, pasted blobs)                                                                                                                   |
| `file-history-snapshot`    | `messageId` + `snapshot` (links the message to the checkpoint store — see §5)                                                                                  |
| `mode` / `permission-mode` | session mode + permission-mode markers                                                                                                                         |
| `ai-title`                 | `aiTitle` — the auto-generated session summary shown in the picker                                                                                             |
| `last-prompt`              | `lastPrompt` + `leafUuid` (pointer to the current leaf of the tree)                                                                                            |

Three structural facts the cockpit can exploit:

- **It's a tree, not a list.** Every line has `uuid` + `parentUuid`. `[GT]` This parent-chain is the substrate that makes `/branch`, `--fork-session`, and `/rewind` possible — a fork is a new leaf off an existing node.
- **Token usage is captured per assistant turn** in `message.usage` (input/output/cache token counts). `[GT]`
- **Subagent turns are flagged** `isSidechain:true` and live in the same transcript; there are also UUID-named subdirs (e.g. `<session>/subagents/`) `[GT]`.

**Filesystem-state vs conversation.** The transcript is **conversation + tool I/O only**. Code state is persisted _separately_ as content snapshots (§5). The two are correlated by `file-history-snapshot` lines but are different stores.

**Other on-disk session artifacts** `[GT]`:

- `~/.claude/history.jsonl` — **global, cross-project** prompt log (10,929 lines spanning 42 distinct project paths on this machine). Each line: `{display, pastedContents, timestamp, project, sessionId}` — just the _typed prompt text_, not the transcript. This is the only natively cross-project index.
- `~/.claude/sessions/<PID>.json` — tiny **runtime liveness pointers** for _currently/recently live_ processes: `{pid, sessionId, cwd, startedAt, version, status:"idle", kind:"interactive", entrypoint:"cli", name}`. Ephemeral, keyed by OS PID, not a transcript.
- **No `sessions-index.json` exists on this machine** `[GT]` — some third-party blogs claim one; I did not find it in this project dir. Treat "sessions-index.json" as UNVERIFIED. The picker's metadata (summary, message count, branch, mtimes) is derivable from the `ai-title` line + file stat + envelope fields.

**Retention / relocation knobs** (<https://code.claude.com/docs/en/sessions>): `cleanupPeriodDays` (default **30 days**) in `settings.json`; `CLAUDE_CONFIG_DIR` env var moves the whole store off `~/.claude`; `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1` suppresses transcript writes; `--no-session-persistence` suppresses writes for a single `claude -p` run.

---

## 2. Resume — `--continue`, `--resume`, the picker, headless

| Entry point                               | Behavior (source: <https://code.claude.com/docs/en/sessions>) |
| ----------------------------------------- | ------------------------------------------------------------- |
| `claude --continue` (`-c`)                | "Resumes the most recent session in the current directory"    |
| `claude --resume` (`-r`), no arg          | Opens the interactive **session picker**                      |
| `claude --resume <name>` / `<session-id>` | Resumes directly; ambiguous name opens picker pre-filtered    |
| `claude --from-pr <number>`               | Resumes the session linked to that PR                         |
| `/resume` (in-session)                    | Switch conversations without leaving                          |
| `claude -n <name>` / `/rename`            | Name a session (also auto-named on plan accept)               |

**Scope gotcha (matters for a cockpit that spawns from temp dirs):** "Sessions are stored per project directory… session ID lookup is scoped to the current project directory and its git worktrees, so a session created elsewhere reports `No conversation found with session ID: <session-id>`." You must `cd` into the originating dir (or a worktree of the same repo) before resume resolves. Picker widening: `Ctrl+W` = all worktrees of the repo, `Ctrl+A` = every project on the machine, `Ctrl+B` = current git branch only.

**Headless resume (the cockpit's lever):**
`claude -p --resume <session-id> --output-format json "<follow-up>"` → returns structured JSON (result, session ID, usage, cost). Sources: <https://code.claude.com/docs/en/sessions>, <https://code.claude.com/docs/en/headless>. Note: "Sessions created with `claude -p` or the Agent SDK do not appear in the session picker, but you can still resume one by passing its session ID."

**Full context or summary? Is it lossy?** Resume replays the **full transcript file** — every appended message — so it is **lossless up to whatever the session itself already did to its own history**. The lossy step is _not_ resume; it is **compaction** (§4). Precisely: if a session was `/compact`ed, the transcript from that point forward contains the _summary_, so resuming a previously-compacted session inherits that summary. The docs don't phrase it as one sentence, so: **resume = lossless transcript replay; any loss is inherited from prior in-session compaction** — derived from the append-only persistence model + the compaction semantics in §4. The picker _preview_ shows only the `ai-title`/summary, but selecting actually loads the full JSONL.

**Branching/forking** (<https://code.claude.com/docs/en/sessions>): `/branch [name]` or `claude --continue --fork-session` copies the conversation into a new leaf, "leaving the original intact." Caveat: "Permissions you approved with 'allow for this session' do not carry over to the new branch." And the interleave hazard — "If you resume the same session in two terminals without forking, messages from both interleave into one transcript." A cockpit running parallel agents on one session MUST fork, or it corrupts the transcript.

---

## 3. CLAUDE.md + the `/memory` command

Source for all of §3: <https://code.claude.com/docs/en/memory>.

**Load order (broadest → most specific; all concatenated, not overridden):**

| Scope          | Path                                                                                                                                                     | Notes                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Managed policy | macOS `/Library/Application Support/ClaudeCode/CLAUDE.md` · Linux/WSL `/etc/claude-code/CLAUDE.md` · **Windows `C:\Program Files\ClaudeCode\CLAUDE.md`** | Cannot be excluded by user settings; or inline via `claudeMd` key in `managed-settings.json` |
| User           | `~/.claude/CLAUDE.md`                                                                                                                                    | All projects, just you `[GT]` present on this machine                                        |
| Project        | `./CLAUDE.md` or `./.claude/CLAUDE.md`                                                                                                                   | Team-shared via VCS                                                                          |
| Local          | `./CLAUDE.local.md`                                                                                                                                      | gitignored personal overrides                                                                |
| Project rules  | `./.claude/rules/*.md` (recursive)                                                                                                                       | Same priority as `./.claude/CLAUDE.md` when unscoped                                         |
| User rules     | `~/.claude/rules/*.md`                                                                                                                                   | Loaded before project rules                                                                  |

**Directory walk:** "Claude Code reads CLAUDE.md files by walking up the directory tree from your current working directory… All discovered files are concatenated into context… ordered from the filesystem root down to your working directory." Subdirectory CLAUDE.md files are **lazy** — "included when Claude reads files in those subdirectories," not at launch.

**Delivery mechanism (important nuance):** "CLAUDE.md content is delivered as a **user message after the system prompt, not as part of the system prompt itself**… there's no guarantee of strict compliance." → CLAUDE.md is _context, not enforcement_. "To block an action regardless of what Claude decides, use a PreToolUse hook instead." For system-prompt-level injection use `--append-system-prompt` (must be passed every invocation).

**`@path` imports:** `@path/to/import` syntax; "Both relative and absolute paths are allowed"; relative resolves to the _importing file's_ dir; **max recursion depth = 4 hops**; parsing skips code spans/fences (backtick a path to NOT import it). **Imports do NOT save context** — "imported files still load and enter the context window at launch." First-time external imports show a one-time approval dialog.

**Size:** "target under 200 lines per CLAUDE.md file. Longer files consume more context and reduce adherence." This is a **soft guideline, not enforced** — "CLAUDE.md files are loaded in full regardless of length."

**`/memory` command:** "lists all CLAUDE.md, CLAUDE.local.md, and rules files loaded in your current session, lets you toggle auto memory on or off, and provides a link to open the auto memory folder." It is the debugging tool to see _what actually loaded_. (Also: `InstructionsLoaded` hook logs which instruction files load and why.)

**Path-scoped rules:** `.claude/rules/*.md` with YAML `paths:` frontmatter (glob patterns) load **only when Claude reads a matching file**. Rules without `paths:` load unconditionally at launch.

**`--add-dir` + memory:** additional dirs do NOT load their CLAUDE.md by default; set `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` to load `CLAUDE.md`/`.claude/CLAUDE.md`/`.claude/rules/*.md`/`CLAUDE.local.md` from them.

**`claudeMdExcludes`** (settings, any layer): glob/path list to skip ancestor CLAUDE.md files in monorepos (managed-policy CLAUDE.md cannot be excluded). **AGENTS.md:** "Claude Code reads `CLAUDE.md`, not `AGENTS.md`" — bridge via `@AGENTS.md` import.

---

## 4. The API `memory_20250818` tool + ASSUME INTERRUPTION + compaction/context-editing

**This is the Anthropic _Messages API_ layer, not the CLI.** Distinguish it from §6 (CLI auto-memory). The cockpit would only touch this if it drives agents through the raw API/SDK rather than the `claude` binary. Source: <https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool>.

**The tool.** `tools: [{"type": "memory_20250818", "name": "memory"}]`. Correction to stale web snippets: **"The memory tool is generally available on the Messages API: no beta header is required."** (Some 2025 posts cite beta header `context-management-2025-06-27`; that is superseded for the memory tool's GA.) Available on **all Claude 4+ models**.

**Client-side.** "The memory tool operates client-side: Claude requests file operations, and your application executes them. You control where and how the data is stored." `/memories` is a path _prefix_ your handler maps onto real storage. **You implement persistence** — there is no Anthropic-hosted memory store.

**Commands your handler must implement:** `view`, `create`, `str_replace`, `insert`, `delete`, `rename` — all confined to `/memories`. SDK helpers exist (Python/TS `BetaLocalFilesystemMemoryTool` ships a ready filesystem backend; Java/C# abstract handlers).

**The "ASSUME INTERRUPTION" protocol** — injected automatically into the system prompt when the tool is present (verbatim):

> IMPORTANT: ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE.
> MEMORY PROTOCOL:
>
> 1. Use the `view` command of your `memory` tool to check for earlier progress.
> 2. … (work on the task) … record status / progress / thoughts in your memory.
>    ASSUME INTERRUPTION: Your context window might be reset at any moment, so you risk losing any progress that is not recorded in your memory directory.

**Multi-session software-dev pattern** (Anthropic's documented recipe, directly relevant to the cockpit): an **initializer session** writes a progress log + feature checklist + startup-script reference; **subsequent sessions** open by reading those files (restores state without re-exploring the codebase); **end-of-session update** rewrites the progress log. Key principle: "Work on one feature at a time. Mark a feature complete only after end-to-end verification confirms it works, not when the code is written."

**Security (your responsibility, since you execute the ops):** path-traversal protection is mandatory — "A malicious path such as `/memories/../../secrets.env` can reach files outside the `/memories` directory." Validate `/memories` prefix, canonicalize + verify containment, reject `../`/`..\\`/`%2e%2e%2f`. Plus: strip sensitive data before write (memory-poisoning surface), cap file size, expire stale files.

**Compaction vs context editing (two different mechanisms):**

- **Context editing** (`clear_tool_uses_20250919`, client-side): automatically clears _old tool results_ on token thresholds while _excluding_ memory ops. Source: <https://platform.claude.com/docs/en/build-with-claude/context-editing>.
- **Compaction** (server-side): "automatically summarizes the whole conversation on the server when the conversation approaches the context window limit." Source: memory-tool doc, "Using with compaction."
- Memory files **survive both** — that's the whole point of pairing them.

### CLI-side compaction (this is what the cockpit actually hits)

Source: <https://code.claude.com/docs/en/context-window>.

- `/compact [instructions]`: "Replaces the conversation with a structured summary." You see a "Conversation compacted" message; the summarization happens silently. **It is LOSSY by design** — the interactive context-window simulation models the summary at **~12% of the summarized tokens** (`tokens: Math.round(sumTokens * 0.12)`), condensing "All N conversation events… into one structured summary."
- **Auto-compact:** "Claude Code compacts automatically as you approach the limit, so a full context window doesn't end your session. The automatic pass works the same way as the `/compact` step." **The exact trigger percentage is not stated in the docs — UNVERIFIED** (qualitatively "as you approach the limit"; window MAX modeled at 200,000 tokens).
- `/clear`: "start fresh with an empty context. The previous conversation is saved and resumable." `/context`: shows current consumption.

**What survives compaction** (verbatim table, <https://code.claude.com/docs/en/context-window>):

| Mechanism                                 | After compaction                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| System prompt and output style            | Unchanged; not part of message history                                         |
| Project-root CLAUDE.md and unscoped rules | **Re-injected from disk**                                                      |
| Auto memory (MEMORY.md)                   | **Re-injected from disk**                                                      |
| Rules with `paths:` frontmatter           | **Lost** until a matching file is read again                                   |
| Nested CLAUDE.md in subdirectories        | **Lost** until a file in that subdir is read again                             |
| Invoked skill bodies                      | Re-injected, capped **5,000 tokens/skill, 25,000 total; oldest dropped first** |
| Hooks                                     | N/A; run as code, not context                                                  |

So: anything that matters across a compaction boundary must live in **project-root CLAUDE.md or auto-memory** — those two are the only conversation-carried instruction stores that auto-survive. Conversation-only instructions are summarized away.

---

## 5. "What changed" / project tracking — checkpointing

Source: <https://code.claude.com/docs/en/checkpointing>. This is Claude Code's **only** native "project state across sessions" mechanism beyond the transcript itself.

**What it is.** "Claude Code automatically tracks Claude's file edits as you work… checkpointing automatically captures the state of your code before each edit." `[GT]` On disk: `~/.claude/file-history/<session-id>/<content-hash>@v1`, `@v2`, `@v3`… — **content-addressed, versioned snapshots of file contents** (I read one: an SVG body stored verbatim). The `file-history-snapshot` transcript line (§1) ties a snapshot set to a message.

**Properties:** "Every user prompt creates a new checkpoint"; "Checkpoints persist across sessions, so you can access them in resumed conversations"; cleaned up with sessions after **30 days**.

**`/rewind`** (or `Esc Esc` on empty input) menu actions: Restore code+conversation / Restore conversation only / Restore code only / Summarize from here / Summarize up to here. "the original messages are preserved in the session transcript, so Claude can reference the details if needed." Rewind-past-`/clear` requires v2.1.191+ `[GT this machine is 2.1.195 ✓]`.

**The hard limits (this is the crux of the cockpit gap):**

- **"Checkpointing does not track files modified by bash commands."** `rm`/`mv`/`cp`, codegen, formatters, installs, build outputs — **invisible**. "Only direct file edits made through Claude's file editing tools are tracked."
- **"External changes not tracked."** "Manual changes you make to files outside of Claude Code and edits from other concurrent sessions are normally not captured, unless they happen to modify the same files as the current session."
- **"Not a replacement for version control… Think of checkpoints as 'local undo' and Git as 'permanent history'."**

**Therefore: Claude Code has NO native, machine-verified, durable "what changed since last session" truth.** It tracks _its own file-edit-tool writes only_, per session, for 30 days, and cannot see bash side-effects or other agents' writes. The only durable, side-effect-complete record of "what changed" is **Git** — which Claude Code does not maintain for you. Cross-session project awareness otherwise rests entirely on conversation history (transcript) + CLAUDE.md + auto-memory, i.e. context, not verified state.

---

## 6. Explicit / auto memory beyond CLAUDE.md

Source: <https://code.claude.com/docs/en/memory>. **Auto memory** is a real, on-by-default feature (requires v2.1.59+; this machine 2.1.195 `[GT]`).

- **Path:** `~/.claude/projects/<project>/memory/`, with `MEMORY.md` as the loaded index + arbitrary topic files. `<project>` is **derived from the git repo root**, so "all worktrees and subdirectories within the same repo share one auto memory directory." `[GT]` **Confirmed populated on this machine** at `~/.claude/projects/C--Users-<user>-VibeCoding-TeamWork/memory/` (holds the operator's `feedback_*.md`, `project_*.md` files). The operator's custom memory protocol is writing into Claude Code's _native_ auto-memory store.
- **Load rule:** "The first 200 lines of `MEMORY.md`, or the first 25KB, whichever comes first, are loaded at the start of every conversation." Topic files are **not** loaded at startup — read on demand. This 200-line/25KB cap applies **only to MEMORY.md** (CLAUDE.md loads in full).
- **Who writes it:** Claude, autonomously — "Claude doesn't save something every session. It decides what's worth remembering." When you say "remember X," it goes to auto-memory (say "add this to CLAUDE.md" to target CLAUDE.md instead).
- **Knobs:** `autoMemoryEnabled:false` or `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` to disable; `autoMemoryDirectory` (abs path or `~/`) to relocate (honored only after workspace-trust accept). **Machine-local; not shared across machines/cloud.** Subagents can keep their own auto-memory (`/en/sub-agents#enable-persistent-memory`).

`ai-title` transcript lines are an additional implicit "memory": auto-generated session summaries used as picker labels `[GT]`.

---

## 7. The GAP for a multi-agent cockpit

What Claude Code's native machinery does **not** solve for "zer0 chat" supervising Claude Code + Codex + Gemini:

1. **Zero cross-agent awareness.** Every store is Claude-Code-private and namespaced to Claude Code's own session/project model: transcripts under `~/.claude/projects/<slug>/`, auto-memory under `<slug>/memory/`, checkpoints under `~/.claude/file-history/<session>/`. **Nothing in Claude Code knows what Codex or Gemini did.** A Claude session resumed tomorrow sees only its own JSONL + its own auto-memory + (re-read) CLAUDE.md. There is no native shared event bus, no "team transcript."

2. **No durable machine-verified "what changed" truth.** §5: checkpointing is edit-tool-only, per-session, 30-day, bash-blind and other-agent-blind. The one source of side-effect-complete truth is **Git**, which Claude Code does not own. A cockpit that wants "here is exactly what the team changed since last session" must compute it itself (git diff / worktree snapshots / a write-ledger), because no agent's native memory provides it.

3. **Compaction is silently lossy and per-agent.** §4: `/compact` and auto-compact replace conversation with a ~12%-size summary; auto-compact fires on an undocumented threshold without operator control. Each agent compacts its own context independently — so three agents drift into three different lossy summaries with no shared anchor. Only project-root CLAUDE.md + auto-memory auto-survive a compaction; everything conversation-only evaporates.

4. **Transcript format is explicitly unstable.** "The entry format is internal to Claude Code and changes between versions, so scripts that parse these files directly can break on any release." A cockpit must NOT parse `~/.claude/projects/**/*.jsonl` as a contract — use `/export` or `claude -p --resume <id> --output-format json` / SDK streaming instead.

5. **Resume is cwd-scoped and PID-ephemeral.** Session-ID lookup only resolves from the originating project dir or its git worktrees; the only "live session" registry (`~/.claude/sessions/<PID>.json`) is keyed by OS PID and disappears with the process. Cross-project / cross-machine continuity is unsupported natively (auto-memory is machine-local; `history.jsonl` is the _only_ cross-project index and it stores prompt text only).

6. **CLAUDE.md is advisory, not enforced.** "delivered as a user message… no guarantee of strict compliance." Hard guarantees need PreToolUse hooks, not memory.

---

## What zer0 should BUILD ON (Claude Code native)

- **Auto-memory as the per-agent persistence substrate.** It already exists, is on by default, is git-repo-scoped (shared across worktrees), survives compaction (re-injected from disk), and is plain markdown the cockpit can read/write/curate directly: `~/.claude/projects/<slug>/memory/MEMORY.md` + topic files. The operator already uses it. Keep `MEMORY.md` ≤200 lines/25KB (the load cap) and push detail into topic files. **Do not reinvent per-agent memory.**
- **Project-root `CLAUDE.md` (+ `.claude/rules/*.md`) as the survives-everything instruction channel.** It and auto-memory are the _only_ two stores that auto-survive compaction. Put cross-session invariants there; use `@path` imports (depth ≤4) and unscoped rules for modularity.
- **Headless resume as the integration seam:** `claude -p --resume <session-id> --output-format json` for lossless structured turn injection; `--session-id`/`-n` naming; `--fork-session` to run parallel work without transcript interleave; `--from-pr` for PR-linked resume. Read `transcript_path` from hook/statusline payloads rather than guessing paths.
- **Native checkpointing for intra-Claude undo** (`/rewind`, `file-history/`), as _local undo_ — not as the source of truth.
- **`/export` and the script interfaces** for stable transcript access (never parse the raw JSONL as a contract).
- **The API memory-tool recipe (§4) as a design template** even if driving the CLI: initializer → progress-log/feature-checklist → end-of-session update, "one feature at a time, complete only after end-to-end verification." The ASSUME-INTERRUPTION discipline is exactly the resilience model a multi-agent cockpit needs.

## What zer0 must ADD (the gap)

- **A cockpit-owned, cross-agent shared ledger.** The single thing no native store provides: one append-only, event-sourced record of what _all three_ agents did, that any agent's next session can read. Claude's auto-memory is per-Claude; Codex/Gemini have their own; none are shared. This is the cockpit's core value and must be built (the project's existing "shared-brain" ledger is the right shape).
- **Machine-verified "what changed" truth, from Git — not from any agent's memory.** Compute the diff yourself (git status/diff, per-session worktree snapshots, or a tool-call write-ledger that also captures **bash side-effects**, which checkpointing structurally misses). No native mechanism gives side-effect-complete change truth.
- **A durable cross-session/cross-project index.** Native cross-project indexing is only `history.jsonl` (prompt text). The cockpit needs its own session registry + summaries keyed by project AND agent AND task, independent of OS PID and cwd-scoping.
- **A shared compaction anchor.** Since each agent compacts independently and lossily on an undocumented threshold, the cockpit should persist the load-bearing facts to the shared ledger / auto-memory _before_ any agent compacts, so the team has one durable summary instead of three divergent lossy ones.
- **Stable extraction, not transcript parsing.** Wrap `/export` + `-p --resume --output-format json` + SDK streaming; treat `~/.claude/projects/**/*.jsonl` as opaque and version-unstable.
- **Trust-boundary validation on any memory the cockpit writes for agents** (path-traversal, size caps, poisoning) — the same controls the API memory tool mandates, since the cockpit becomes the executor of cross-agent memory writes.

---

### Sources

- Memory / CLAUDE.md / auto-memory: <https://code.claude.com/docs/en/memory>
- Sessions / resume / transcripts: <https://code.claude.com/docs/en/sessions>
- Context window / compaction / "what survives": <https://code.claude.com/docs/en/context-window>
- Checkpointing / rewind: <https://code.claude.com/docs/en/checkpointing>
- API memory tool (`memory_20250818`) / ASSUME INTERRUPTION / multi-session pattern: <https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool>
- Context editing (`clear_tool_uses_20250919`): <https://platform.claude.com/docs/en/build-with-claude/context-editing>
- Headless mode: <https://code.claude.com/docs/en/headless>
- Ground truth `[GT]`: direct inspection of `~/.claude` on this machine (Claude Code v2.1.195) — `projects/<slug>/*.jsonl`, `projects/<slug>/memory/`, `file-history/<session>/<hash>@vN`, `sessions/<PID>.json`, `history.jsonl`.
