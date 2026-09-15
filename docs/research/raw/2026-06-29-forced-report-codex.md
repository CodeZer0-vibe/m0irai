**Verdict:** The refinement is directionally right, but only if you demote native sessions to “developer working memory” and promote the forced SQL report plus observed evidence to the only state that can advance a task. Native sessions solve momentum and continuity; they do not solve truth. The biggest improvement I would add is a **pre-compaction decision journal**: agents must emit decision/evidence deltas during work, not only at the end, because a post-hoc report cannot recover rationale that native compaction already compressed away.

## 1. Reconciliation

Yes, the model resolves the earlier tension better than the fully stateless design, with one caveat.

Use native sessions for:
- local reasoning continuity
- tool familiarity
- ongoing codebase context
- reduced repeated briefing
- long-running implementation flow

Use SQL evidence for:
- canonical project state
- done/not-done
- cross-agent handoff
- replayable facts
- audit and review

That matches how the vendor tools are evolving. Claude’s SDK docs describe sessions as persisted conversation history containing prompts, tool calls, tool results, and responses, but explicitly say sessions do **not** persist filesystem state. ([code.claude.com](https://code.claude.com/docs/en/agent-sdk/sessions?utm_source=openai)) Claude compaction is also explicitly a summarization mechanism for older context, not a lossless event log. ([platform.claude.com](https://platform.claude.com/docs/en/build-with-claude/compaction?utm_source=openai)) Codex similarly has official resume flows for interactive and non-interactive work. ([developers.openai.com](https://developers.openai.com/codex/cli/reference?utm_source=openai)) ([developers.openai.com](https://developers.openai.com/codex/noninteractive?utm_source=openai)) Gemini CLI session management now auto-saves prompts, responses, tool executions, token usage, and reasoning summaries, project-specifically. ([developers.googleblog.com](https://developers.googleblog.com/pick-up-exactly-where-you-left-off-with-session-management-in-gemini-cli/?utm_source=openai))

The flaw: “native compaction + final forced report” is still vulnerable to lost why. If the agent delays reporting until after compaction, the report can become reconstructed narrative. Fix that with an append-only **work journal** written before risky transitions: before compaction, before large edits, after each decision, before session close, and before “done.”

## 2. Forced Report Schema

Split fields into machine-verifiable and narrative. Never let narrative satisfy a gate by itself.

Machine-verifiable:
- `report_id`, `task_id`, `run_id`, `agent`, `native_session_id`, `adapter`, `cwd`, `worktree_id`
- `base_git_sha`, `head_git_sha`, `dirty_before_hash`, `dirty_after_hash`
- `owned_files_declared`, `files_touched_observed`, `files_added/deleted/renamed`
- `diff_blob_id`, `diff_sha256`, `patch_applies_cleanly`
- `commands_run`: exact argv, cwd, env allowlist hash, exit code, duration, stdout/stderr blob IDs
- `tests_run`: command, result, parsed pass/fail counts where available
- `permissions_requested`: tool/action, decision, timestamp
- `commit_sha`, if committed
- `review_report_ids`, `finding_ids`, disposition status
- `done_state`: `draft | submitted | verified | mismatch | rejected | accepted | committed`

Narrative:
- task intent
- rationale
- alternatives considered
- risk assessment
- what was not verified
- expected user-visible behavior
- follow-up recommendations

Enforcement:
- Agent cannot mark a lane done without submitting a valid JSON report.
- SQL schema has required fields, enum constraints, foreign keys to blobs/events/commands.
- A reconciler computes observed evidence from git, filesystem, command logs, and test output.
- Any mismatch moves the report to `mismatch`, blocks done, and records exact deltas: “reported touched 3 files, observed 5,” “reported tests passed, command exit 1,” “reported no forbidden files, observed forbidden file diff.”

Anti-hallucination rule: every machine field is either verified, mismatched, or unavailable. No “agent said so” path.

## 3. Prior Art To Copy

Copy PR templates for forcing structured human-visible change summaries; GitHub’s docs frame templates as a way to make contributors describe proposed changes consistently. ([docs.github.com](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/creating-a-pull-request-template-for-your-repository?utm_source=openai))

Copy Conventional Commits for compact intent taxonomy: `feat`, `fix`, `refactor`, `test`, `docs`, plus scope and breaking-change signaling. The key lesson is not commit style; it is machine-readable intent. ([conventionalcommits.org](https://www.conventionalcommits.org/en/v1.0.0/?utm_source=openai))

Copy ADR/MADR for architectural decisions: status, context, decision, consequences, alternatives. MADR exists specifically to record significant decisions in a structured form. ([adr.github.io](https://adr.github.io/madr/?utm_source=openai))

Copy Definition of Done as a quality gate, not a vibe. Scrum.org defines DoD as the formal state an increment must meet to satisfy product quality measures. ([scrum.org](https://www.scrum.org/resources/what-definition-done?utm_source=openai))

Copy standups only lightly: “done / next / blocked” is useful for progress, but it is weak evidence. Copy changelogs only for the user-facing summary after verification, never as the canonical report.

## 4. Trigger Granularity

Do not force a full report after every conversational turn. That will become theater.

Demand a report for:
- any filesystem mutation
- any build/review/research artifact
- any architectural decision
- any task that consumes a build lane
- before native compaction
- before session close
- before merge/accept/commit
- when handing off to another agent

For tiny read-only questions, store only a lightweight turn event. For multi-hour builds, use rolling journal entries plus one final report. The final report should summarize and link evidence, not be the first time evidence appears.

## 5. Failure Modes

Agents gaming the template: require observed evidence reconciliation and cross-agent review. A report with perfect prose but missing diff/test evidence fails.

Rubber-stamp reviews: reviewer must not see builder rationale by default. Give reviewer diff, acceptance criteria, observed report, and gate results. Let it find independent issues.

Compaction drops why before report: require pre-compaction journal entry and block `/compact` or native auto-compact where hooks allow. Where hooks do not exist, trigger a journal checkpoint when context usage crosses a threshold.

Cross-agent divergence: SQL needs explicit decision records with status: `proposed | accepted | superseded | rejected`. Agents can propose truth; zer0 commits truth.

Latency/quota cost: tier reports. Tiny report for small file edits, full report for build/review/architecture. Store blobs by hash to avoid re-summarizing giant diffs.

Report theater: every report section must either be verified, narrative, or explicitly unverifiable. Empty boilerplate should fail lint.

## 6. Persistent Native Sessions Over ACP

Feasible, but adapter variance is the trap.

ACP officially has `session/new`, optional `session/load`, `session/prompt`, streaming `session/update`, and `session/cancel` in the normal flow. ([agentclientprotocol.com](https://agentclientprotocol.com/protocol/v1/overview?utm_source=openai)) The spec says clients must check `loadSession` support before calling `session/load`. ([agentclientprotocol.com](https://agentclientprotocol.com/protocol/v1/session-setup?utm_source=openai)) ACP updates also say `session/resume` stabilized in April 2026, which matters for reconnecting without replaying history. ([agentclientprotocol.com](https://agentclientprotocol.com/updates?utm_source=openai))

Local repo reality: current `dispatch-acp.ts` says ACP is default for claude/codex, gemini is not ACP, and “Session reuse is next” in the file header/comments. [dispatch-acp.ts](C:/Users/mianc/VibeCoding/zer0-agent-ci/src/chat/dispatch-acp.ts:3) So this is not just flipping a flag.

Build it as `NativeSessionHandle`:
- `agent`
- `transport`: `acp | pty | exec`
- `provider_session_id`
- `process_id` if alive
- `cwd`
- `worktree`
- `config_hash`
- `adapter_version`
- `last_seen_at`
- `capabilities`
- `resume_strategy`: `live_process | acp_resume | cli_resume | transcript_replay | fresh_with_sql_context`

If exact native resume fails, fall back to a fresh session injected with the verified SQL state. Do not pretend that fallback has native reasoning continuity.

## Recommended Report Schema + Flow

Minimum buildable flow:

1. Task opens: create SQL `tasks` row with objective, acceptance criteria, owner, owned files, base git SHA.
2. Agent starts/resumes native session: create `agent_sessions` row with capability probe and native session ID if available.
3. During work: append `work_journal` events for decisions, commands, file edits, permission requests, compaction checkpoints.
4. Agent submits `agent_reports` JSON.
5. Reconciler creates `verification_report`: compares report to git diff, file list, command logs, test logs, permissions, commit state.
6. If mismatch: block done and return exact mismatch list to the agent.
7. If verified: allow cross-agent review.
8. Reviewer report is also structured and verified against file:line evidence.
9. zer0 commits truth: accepted decisions/tasks update canonical `PROGRESS`, `DECISIONS`, and `TASKS`.
10. Only then can the lane be `done`.

Recommended fields:
- identity
- task intent
- native session metadata
- base/head git state
- files declared and observed
- diff/blob references
- decisions made
- commands/tests run
- permission events
- risks and unverified items
- review status
- done claim
- verifier result

## Biggest Risk

The biggest risk is confusing **continuity** with **correctness**. Native sessions will make agents feel smarter and more coherent, but they also make stale assumptions, sycophancy, and hidden compaction loss harder to see. The SQL ledger must stay adversarial: native memory can help agents work, but only observed evidence can move project state.

Confidence: **YELLOW, ~85%**. Strong confidence in the architecture direction and gating model; lower confidence on exact per-adapter native resume behavior until current claude/codex/agy binaries are probed live in this repo.

