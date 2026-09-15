Documenting: **Codex CLI**.

Verified against installed `codex-cli 0.142.2` on this Windows machine, local files under `C:\Users\mianc\.codex`, and official OpenAI docs.

## 1. Session/conversation persistence

Codex persists local sessions as JSONL rollout files under:

`C:\Users\mianc\.codex\sessions\YYYY\MM\DD\rollout-<timestamp>-<session_id>.jsonl`

Example observed:

`C:\Users\mianc\.codex\sessions\2026\06\29\rollout-2026-06-29T19-35-40-019f143c-8d3d-7aa2-a251-62bbdc2322ea.jsonl`

Observed JSONL event types in that transcript:

- `session_meta`
- `turn_context`
- `event_msg`
- `response_item`

Observed saved data includes:

- session id / thread id
- timestamp
- `cwd`
- originator/source, for example `codex_exec`
- CLI version, for example `0.142.2`
- model provider
- base instructions
- user/project instructions injected into the session
- user messages
- assistant messages
- commentary/status messages
- tool calls
- tool outputs
- reasoning response items with encrypted reasoning payloads and summaries when present

Also observed:

- `C:\Users\mianc\.codex\session_index.jsonl` contains session ids, thread names, and `updated_at` timestamps.
- `C:\Users\mianc\.codex\history.jsonl` contains prompt-history style entries with `session_id`, `ts`, and `text`.
- `C:\Users\mianc\.codex\logs_2.sqlite`, `state_5.sqlite`, `goals_1.sqlite`, and `memories_1.sqlite` exist, but SQLite schema inspection was not possible because `sqlite3` is unavailable in this environment.

Filesystem state is **not** saved as a snapshot. The transcript records actions and outputs. Actual files live in the working tree. If files changed last time, a future session learns that from the current filesystem/git state, the saved conversation, memory, or explicit instructions, not from a native filesystem snapshot.

Token usage: `/status` is documented as displaying token usage. I did not verify complete per-turn token accounting inside the rollout JSONL, so that is **unverified**.

Sources: official [Codex CLI slash commands](https://developers.openai.com/codex/cli/slash-commands#built-in-slash-commands), [Codex CLI reference](https://developers.openai.com/codex/cli/reference), [config reference](https://developers.openai.com/codex/config-reference#configtoml).

## 2. Resume

Interactive resume:

- `codex resume [SESSION_ID] [PROMPT]`
- picker by default
- `--last` continues the most recent recorded session
- `--all` disables cwd filtering
- `--include-non-interactive` includes exec sessions in picker and `--last` selection

Non-interactive/headless resume:

- `codex exec resume [SESSION_ID] [PROMPT]`
- `--last` resumes the newest recorded session
- `--all` searches sessions outside the current cwd
- supports `--json`, `--output-last-message`, `--output-schema`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, and image attachments

Fresh exec sessions can opt out of persistence:

- `codex exec --ephemeral ...`

Related commands:

- `codex fork [SESSION_ID] [PROMPT]`
- `codex archive <SESSION>`
- `codex delete <SESSION>`
- `/resume` inside the TUI
- `/fork`, `/archive`, `/delete` inside the TUI

Resume fidelity: Codex resumes a saved conversation, but the exact reconstruction algorithm is not fully documented in the public snippets I verified. Long sessions are necessarily bounded by context window and may include compaction summaries. So: short sessions likely resume with detailed prior context; long or compacted sessions can be lossy. Treat “full prior context” as **unverified** unless tested for the specific version/session.

## 3. Project instructions / memory file

Codex’s durable instruction file is `AGENTS.md`.

Documented behavior:

- `AGENTS.md` loads into context automatically.
- Global personal defaults can live at `~/.codex/AGENTS.md`.
- Repo-level `AGENTS.md` applies to the repository.
- More specific `AGENTS.md` files in subdirectories can override/narrow guidance; closer files win.
- `/init` scaffolds an `AGENTS.md` in the current directory.

Observed on this machine:

- global: `C:\Users\mianc\.codex\AGENTS.md`
- repo: `C:\Users\mianc\VibeCoding\zer0-agent-ci\AGENTS.md`

Config layering:

- user config: `~/.codex/config.toml`, observed as `C:\Users\mianc\.codex\config.toml`
- project config: `.codex/config.toml`, observed as `C:\Users\mianc\VibeCoding\zer0-agent-ci\.codex\config.toml`
- project config loads only when the project is trusted
- profiles live as `$CODEX_HOME/<profile>.config.toml` and are selected with `--profile`

Relevant config keys documented:

- `project_doc_max_bytes`
- `project_doc_fallback_filenames`
- `project_root_markers`
- `model_instructions_file`
- `developer_instructions`

Size caps: `project_doc_max_bytes` exists, but I did not verify the default value. Mark default as **unverified**.

Imports/includes: I found no documented automatic include/import syntax for `AGENTS.md`. Docs recommend keeping `AGENTS.md` concise and referencing task-specific markdown files, but references are not the same as automatic inclusion. Treat includes as **unverified/not documented**.

Enforcement: `AGENTS.md` is instruction context, not a mechanical policy engine. Mechanical enforcement comes from sandbox, approvals, rules, hooks, permissions, and managed config.

Sources: [Best practices: AGENTS.md](https://developers.openai.com/codex/learn/best-practices#make-guidance-reusable-with-agentsmd), [config reference](https://developers.openai.com/codex/config-reference#configtoml).

## 4. “What changed” / project tracking

Native Codex does have current-worktree inspection:

- `/diff` shows Git diff including untracked files.
- `codex review` can review the working tree.
- Codex can inspect files and run git commands when permitted.

But across sessions, Codex does **not** appear to maintain a durable, authoritative “files I changed last time” ledger as a first-class project-tracking mechanism.

A fresh session can know “what changed” from:

- current filesystem state
- git status/diff/log
- resumed conversation transcript
- generated memories
- explicit handoff files such as `STATE.md`, `tasks/handoff.md`, or repo docs if the project uses them

It cannot natively know, with machine-verified certainty, “Codex changed these exact files last time” unless that is reconstructed from transcript/tool logs or git.

Goals add thread-scoped durable state, but they are not global memory and not project-level instructions. Official docs describe goals as persisted thread state with objective/lifecycle/budget/progress, tied to the thread where files, commands, diffs, logs, and reasoning were accumulated. That helps continue a task, not replace a verified project-change database.

Source: [Using Goals in Codex](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex#how-goals-are-designed-in-codex).

## 5. Context management / compaction

Manual compaction:

- `/compact` summarizes the visible conversation to free tokens.

Automatic compaction:

- `model_auto_compact_token_limit` configures the token threshold for automatic history compaction.
- If unset, model defaults apply.

Compaction controls:

- `compact_prompt`
- `experimental_compact_prompt_file`
- hook events include `PreCompact` and `PostCompact`

Compaction is lossy for active model context because it replaces older detail with a summary. The rollout JSONL may still contain raw historical events, but the model’s working context after compaction is not a lossless replay of everything.

Source: [slash commands: `/compact`](https://developers.openai.com/codex/cli/slash-commands#built-in-slash-commands), [config reference](https://developers.openai.com/codex/config-reference#configtoml).

## 6. Explicit memory features

Codex has a dedicated Memories feature beyond `AGENTS.md`.

Documented controls:

- `/memories` configures memory use and generation in the TUI.
- `features.memories` enables Memories. Docs say this feature is off by default.
- `memories.use_memories`: when false, skips injecting existing memories into future sessions.
- `memories.generate_memories`: when false, new threads are not stored as memory-generation inputs.
- other knobs include extraction/consolidation model, rollout age, idle hours, max rollouts per startup, and external-context exclusion.

Observed on this machine:

- `C:\Users\mianc\.codex\memories_1.sqlite`
- `C:\Users\mianc\.codex\memories\MEMORY.md`
- `C:\Users\mianc\.codex\memories\memory_summary.md`
- `C:\Users\mianc\.codex\memories\raw_memories.md`
- rollout summary files under `C:\Users\mianc\.codex\memories\rollout_summaries\...`
- ad hoc extension notes under `C:\Users\mianc\.codex\memories\extensions\ad_hoc\notes\...`

In this repo’s project config, `features.memories = true`.

Important boundary: local markdown memory layout is verified on this machine, but I would not treat the exact folder/file schema as a stable public API unless OpenAI documents it. The public contract is Memories as locally stored reusable context with config controls.

Source: [config reference](https://developers.openai.com/codex/config-reference#configtoml), [glossary](https://developers.openai.com/codex/glossary).

## 7. The gap for a multi-agent cockpit

Native Codex gives zer0 useful primitives:

- durable transcripts
- resumable sessions
- non-interactive `exec resume`
- project/global instructions
- project config
- memories
- goals
- `/diff` and review
- hooks and lifecycle events
- MCP/plugins/connectors

But native Codex does **not** solve the cockpit-level state problem by itself.

Missing for zer0:

- no cross-agent shared truth about what Claude/Gemini/Codex each did
- no native durable file-change ledger across all agents
- no guaranteed machine-verified “last modified files” summary independent of conversation
- no native merge of other agents’ memories into Codex memory
- no native conflict detector for “agent A changed file X after agent B inspected it”
- no authoritative task contract shared across CLIs unless zer0 writes one
- no guaranteed lossless resume of long sessions because compaction/context limits exist
- no stable public API confirmed here for reading Codex memory DB internals

## What zer0 should BUILD ON (native - reuse it)

Use Codex native mechanisms instead of re-feeding tiny transcripts:

- Start Codex in the real repo cwd with `-C <repo>`.
- Use `AGENTS.md` for durable repo/team instructions.
- Use `.codex/config.toml` for trusted project defaults.
- Use `codex exec resume --last` or `codex exec resume <SESSION_ID>` for headless continuity.
- Use top-level `codex resume` for interactive continuity.
- Preserve Codex session ids from rollout filenames/session metadata.
- Let Codex Memories inject user/project lessons where enabled.
- Use Goals for long-running thread-scoped objectives.
- Use `/diff`, `git status`, and `codex review` for current worktree inspection.
- Use hooks if zer0 needs lifecycle capture at prompt/tool/compact/session boundaries.

## What zer0 must ADD (the native gap)

zer0 should add an external, machine-verified project state layer:

- per-turn manifest: agent, session id, cwd, prompt id, start/end commit, changed files, created/deleted files, commands run, tests run
- git-based checkpointing before and after each agent turn
- shared handoff file or DB keyed by project and task
- cross-agent change ownership and conflict detection
- explicit “what changed last time” summaries generated from git diff plus filesystem facts, not model memory
- durable task contract independent of any one CLI’s lossy context
- session-id registry mapping Codex/Claude/Gemini native sessions to zer0 task ids
- policy that a fresh session must inspect current git/filesystem state before trusting resumed memory

Bottom line: build on Codex’s transcripts, resume, AGENTS.md, project config, memories, and goals. Do not rely on them as the single source of truth for project state. For zer0, the authoritative continuity layer should be git/filesystem verified, with native CLI memory used as helpful context rather than the ledger.

