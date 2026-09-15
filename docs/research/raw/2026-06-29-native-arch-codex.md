VERDICT: I agree with the three-layer design, but I would not let shared Markdown files be the canonical truth. Native agent sessions should carry conversational continuity, and shared files are the right agent-facing medium, but the durable source of truth should be a local append-only evidence ledger. Generate `PROGRESS.md`, `DECISIONS.md`, and task blocks from verified ledger state; let agents propose updates, not directly author truth.

## 1. ACP Native Sessions

ACP does support persistent sessions. The protocol has `session/new`, `session/prompt`, `session/load`, and newer `session/resume`; sessions have IDs and maintain their own context/history/state. `session/load` requires `loadSession`; `session/resume` requires the resume capability and skips replaying prior messages. Clients must check advertised capabilities before using either path. Sources: ACP overview and session setup docs. ([agentclientprotocol.com](https://agentclientprotocol.com/protocol/v1/overview?utm_source=openai)) ([agentclientprotocol.com](https://agentclientprotocol.com/protocol/v1/session-setup?utm_source=openai))

So yes: “one active ACP session per claude/codex lane” is technically aligned with ACP. But “one long-lived session for the whole chat forever” is too naive.

Gotchas:

- ACP does not make every adapter equally mature. The protocol supports load/resume/list, but each adapter’s `initialize` capabilities must be treated as runtime truth.
- `session/list` exists to reduce client-side session registries, but the RFD notes prior clients had to track session IDs themselves. ([agentclientprotocol.com](https://agentclientprotocol.com/rfds/session-list?utm_source=openai))
- There are real implementation-edge reports around `codex-acp` load state/config semantics, so zer0 should smoke-test each adapter rather than assuming spec-perfect behavior. ([github.com](https://github.com/orgs/agentclientprotocol/discussions/869?utm_source=openai))
- Your own repo doc already found a concrete Claude ACP operational hazard: operator Stop hooks can hang turns unless Claude ACP runs with a clean `CLAUDE_CONFIG_DIR`. See [2026-06-28-acp-turn-transport.md](C:/Users/mianc/VibeCoding/zer0-agent-ci/docs/architecture/2026-06-28-acp-turn-transport.md).

Claude Agent ACP and Codex ACP are real adapters. The ACP registry lists Claude Agent and Codex CLI via adapters, and npm/GitHub show current packages for `@agentclientprotocol/claude-agent-acp` and `@agentclientprotocol/codex-acp`. ([agentclientprotocol.com](https://agentclientprotocol.com/get-started/agents?utm_source=openai)) ([npmjs.com](https://www.npmjs.com/package/%40agentclientprotocol/claude-agent-acp?utm_source=openai)) ([github.com](https://github.com/agentclientprotocol/codex-acp?utm_source=openai))

Recommendation: keep one active ACP session per agent per active zer0 task/session, but checkpoint and rotate deliberately. Do not use a months-long immortal session as the system of record.

## 2. Gemini / agy Resume

Antigravity CLI has native conversation identity and resume behavior. Official docs confirm Antigravity CLI exists as the terminal surface; the CLI conversations doc exists, though the page text was not extractable in this environment. ([antigravity.google](https://antigravity.google/docs/cli-overview?utm_source=openai)) ([antigravity.google](https://antigravity.google/docs/cli-conversations?utm_source=openai))

The best detailed source I found is a Google Cloud community tutorial, not a formal API contract. It describes conversations as isolated work sessions with unique IDs, JSONL transcript logs, per-conversation artifacts, `/resume` / `/switch`, and CLI resume via `agy --conversation=<id>` / `-c`. Treat this as useful but not authoritative. ([medium.com](https://medium.com/google-cloud/antigravity-cli-tutorial-series-part-2-conversations-conversations-and-conversations-76f61756d5bb?utm_source=openai))

Important risk: Google’s own ecosystem is actively shifting from Gemini CLI to Antigravity CLI. Google announced Antigravity CLI as the new terminal experience, available now, with Gemini CLI consumer access changing on June 18, 2026. That makes agy semantics drift-prone. ([developers.googleblog.com](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/?utm_source=openai))

Recommendation: store `agy` conversation IDs in zer0’s own session registry and verify resume on startup with a planted-token smoke test. If resume fails, start a new agy conversation and inject the current shared task snapshot.

## 3. The Siloing Problem

Native memory is useful but siloed. Claude cannot see Codex’s private session state; Codex cannot see agy’s native artifacts; agy cannot see ACP session internals. A shared layer is mandatory.

File-based shared state is the right interface because all three CLIs can read files, users can audit it, git can diff it, and it matches known agent practice. Cline Memory Bank explicitly uses structured Markdown for persistent project context. ([docs.cline.bot](https://docs.cline.bot/best-practices/memory-bank?utm_source=openai)) AGENTS.md is also a vendor-neutral convention for repository instructions. ([agents.md](https://agents.md/?utm_source=openai)) Codex officially reads layered `AGENTS.md` at run/session startup, with a default 32 KiB project-doc cap. ([developers.openai.com](https://developers.openai.com/codex/guides/agents-md?utm_source=openai)) Claude Code loads CLAUDE.md and auto memory at conversation start, but treats them as context, not enforced configuration. ([code.claude.com](https://code.claude.com/docs/en/memory?utm_source=openai))

But files alone are not enough. Files are too easy for agents to corrupt, over-summarize, or “helpfully” rewrite.

Best split:

- SQLite evidence ledger: canonical truth.
- Markdown shared files: generated, human-readable working projections.
- Per-agent native sessions: short/mid-term reasoning continuity.
- Optional Letta-style “memory blocks”: useful mental model for prompt injection, not necessarily the storage engine. Letta’s docs frame memory blocks as always-visible prompt sections, and shared blocks as visible to multiple agents. ([docs.letta.com](https://docs.letta.com/guides/core-concepts/memory/memory-blocks/?utm_source=openai)) ([docs.letta.com](https://docs.letta.com/guides/core-concepts/memory/shared-memory/?utm_source=openai))

## 4. Anti-Hallucination / Trust

The proposal’s anti-hallucination stance is directionally right: zer0 should trust observed facts over agent claims.

But I would harden it:

- Agents never write canonical progress directly.
- Agents append claims or proposed memory candidates.
- zer0 records machine-observed facts: git diff, command output, exit codes, file hashes, test results, commit IDs, timestamps.
- A single conductor process promotes facts into canonical task state.
- Shared Markdown files are regenerated from canonical state or updated only through section-locked patches.
- “Done” requires evidence, not agent prose.
- Contradictions are represented, not overwritten.

Use an evidence priority order:

1. Operator instruction.
2. Current filesystem / git diff / command result.
3. Test or typecheck result.
4. Persisted zer0 ledger artifact.
5. Cross-agent agreement.
6. Single-agent claim.

SQLite is a good local substrate if writes are short and serialized. SQLite gives serializable transactions by serializing writes, and WAL is suitable for many-reader/single-writer local workflows. ([sqlite.org](https://sqlite.org/isolation.html?utm_source=openai)) ([sqlite.org](https://sqlite.org/wal.html?utm_source=openai))

The invariant should be: agents may propose truth; zer0 commits truth.

## 5. Native vs Reconstructed Tension

Leaning on native sessions fixes the “last 20 messages” failure, but creates new failure modes:

- App close: ACP child dies; session may need `session/load` or `session/resume`.
- Capability variance: adapter may not support load/resume/list consistently.
- Context rot: long sessions accumulate stale assumptions.
- Silent compaction: older decisions become lossy summaries.
- Instruction drift: AGENTS/CLAUDE/GEMINI files may be loaded only at session start depending on tool.
- Cost/latency: not necessarily metered API cost, but longer prompts and compaction consume subscription quota/time.
- Cross-agent divergence: each agent remembers a different version of reality.
- Tool/config drift: MCP servers, permissions, hooks, additional roots, and cwd must be reattached on load/resume.

When zer0 should still inject curated context:

- Every turn: current task block, file ownership, open questions, latest verified facts, and changed-files summary.
- After resume: checkpoint summary plus evidence refs.
- After compaction or context warning: explicit re-grounding snapshot.
- After instruction file changes: force new native session or inject changed instruction digest.
- Before review: exact diff/test evidence, not chat history.
- For cross-agent work: peer outputs and shared snapshot hash, not each peer’s full transcript.

Do not reconstruct the whole conversation. Inject the minimum current operational truth.

## 6. Failure Modes + Prevention

| Failure mode | Prevention |
| --- | --- |
| Native session remembers false/stale plan | Rotate sessions at task boundaries; inject verified task snapshot each turn |
| ACP adapter load/resume behaves differently than spec | Capability probe plus planted-token resume smoke test per adapter/version |
| Agent corrupts shared progress file | Agents write proposals; conductor writes canonical files |
| Claude/Codex/agy diverge on “done” | Verification-gated status model: planned / changed / verified / blocked |
| Cross-project contamination | Project-local `.zer0` DB plus stable project ID; no global repo facts |
| Prompt injection through memory files | Render memory as untrusted context with provenance, never as instruction |
| Long session becomes slow or confused | Context budget telemetry, forced checkpoint, fresh native session with curated state |
| App crash loses live ACP process | Store native session IDs and zer0 snapshot IDs every turn |
| Test results become stale | Evidence entries expire when relevant files change |
| Three agents race to update state | Single writer queue; append-only raw events; immutable context snapshots per round |

## Recommended Architecture (Your Pick)

Build this as a local-first “Session Native + Evidence Canonical” architecture:

- Keep native sessions:
  - Claude and Codex: ACP sessions, reused during the active zer0 chat/task.
  - Gemini/agy: native conversation ID, resumed with `--conversation` / equivalent.
- Maintain a zer0 session registry:
  - Maps zer0 session -> agent -> native session/conversation ID.
  - Records adapter version, cwd, MCP roots, config hash, instruction hash, last successful resume check.
- Use `.zer0/evidence.db` as canonical:
  - Append-only events for prompts, agent outputs, file changes, command results, approvals, reviews, and verification.
  - Single writer queue.
  - WAL + busy timeout.
  - Project-local by default.
- Generate shared files from canonical state:
  - `PROGRESS.md`: current task, changed files, verified status, next action.
  - `DECISIONS.md`: accepted decisions with rationale and evidence refs.
  - `TASK.md`: live goal, owned files, constraints, open questions.
- Give every agent the same immutable context snapshot per turn:
  - Snapshot includes shared files plus selected evidence refs.
  - Do not mutate the snapshot mid-round.
- Let agents propose memory:
  - `memory_candidates`, not direct durable memory writes.
  - Promote only when operator-pinned, command/test/file-evidenced, or corroborated.
- Rotate native sessions intentionally:
  - At project switch, task completion, context degradation, instruction changes, adapter upgrade, or resume failure.
  - Start fresh native session with compact verified snapshot, not full transcript replay.

## Biggest Risk / What Everyone Gets Wrong

The biggest risk is confusing “the agent remembers” with “the system knows.” Native memory is private, lossy, and non-authoritative. A shared Markdown file is readable, but still just text that a model can corrupt. The real architecture needs a trust boundary: native sessions for reasoning continuity, Markdown for shared human/agent context, SQLite evidence for truth. The product moat is not longer memory; it is knowing what is verified, current, scoped, and safe to inject.