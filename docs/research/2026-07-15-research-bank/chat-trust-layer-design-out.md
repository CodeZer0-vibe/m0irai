Read-only verdict: R1, R2, and R3 are supported by current code and ledger. R4’s queue diagnosis is mostly right, but the “write-lease” part is stale: current production serialization is `write_queue`; `write_lease` is schema/test/legacy and its own recovery header says it has no production caller.

**R1 - Explicit Address Precedence**
Design: route authority belongs in `src/chat/message-router.ts`, not the TUI label layer. Slash commands stay first. Then explicit leading address wins before body extraction:

- `@all ... codex ... claude ...` => council/all three, body names cannot narrow.
- `/council ... codex ...` => council/all three.
- `@codex fix X then @claude review` => explicit multi-segment flow preserved.
- `@codex ask claude about X` => codex only; bare body name is content.
- Bare `codex check claude, gemini check codex` => body extraction still allowed.
- Plural-audience classifier routes remain all-agent if they produce `route.kind === "all"`.

Blast radius: `src/chat/message-router.ts:51-64` currently parses multi-address before leading `@agent/@all`; `src/tui/cockpit-turn-route.ts:53-57` labels segments before council; `src/tui/cockpit-turn-exec.ts:500-525` dispatches segments before council. Tests affected: `src/chat/message-router.test.ts`, `src/chat/message-router-multi.test.ts`, `src/tui/cockpit-turn-route.test.ts`.

Ranked falsifiers: `@all ok now codex check claude...` dispatches 3 agents; `@codex build X then @claude review` still segments; `@codex ask claude` does not segment; `/council` cannot be narrowed; bare body-name routing still works.

**R2 - Stale Resume Boundary**
Recommendation: hybrid hard boundary + consent. One-sentence semantic for the operator: “Old unfinished work is shown as a resume card; agents may mention it, but they must not act on it until you press Resume.”

Current code supports the failure mechanism: `src/chat/session-resume.ts:54-82` treats outer chat resume as opt-in, but MT7 lanes are persistent through `src/chat/lane-carrier.ts:400-480`; carrier prompts inject ledger deltas via `src/chat/lane-carrier.ts:149-197`. So a fresh user chat can still hit an agent-native session that remembers prior unfinished work.

Mechanism: on first dispatch after a new zer0 session, detect carried pending work from prior lane generation. Inject a boundary brief into every native lane: prior-session instructions are context, not executable authority. Show one resume card. If accepted, create a current-session `resume_approved` event and dispatch the stale task under the normal capture layer. If rejected or ignored, mark prior pending work void for execution while preserving audit history.

Blast radius: `src/chat/lane-carrier.ts`, `src/memory/delta-composer.ts`, `src/memory/lane-state.ts`, `src/chat/review-boot.ts`, TUI boot/resume card surfaces, and tests around native resume/session boundaries.

Ranked falsifiers: new session `@all hi` with yesterday’s pending write causes no mutation; accepting Resume executes under today’s checkpoint; rejecting Resume prevents all stale execution; each agent receives the boundary brief; current-session “continue” still works.

**R3 - Universal Capture**
Design: move capture from “build-token gated” to “writable dispatch envelope.” `src/chat/headless-turn.ts:157-183` is the right universal hook because council, single, and segment paths eventually dispatch lanes there. Today `src/chat/headless-turn-checkpoint.ts:188-194` returns dormant without a token/build address, and `src/chat/headless-turn-review-settle.ts:374-384` only captures review deltas for build mode. That is the PRD H1 hole.

New rule: every REVIEW/AUTO lane gets a pre-turn checkpoint before native dispatch, regardless of chat/build classification. PLAN uses native read-only and should not rely on capture as its safety layer. Post-turn delta capture always runs when a checkpoint exists. Zero-delta creates no review card. Non-zero delta creates a per-agent review id. If checkpoint or post-capture persistence fails, fail closed with the PRD plain-language block notice and stop further writable dispatch until resolved.

Cost: I measured `git status --porcelain=v1 --untracked-files=all` 5 times: average about 54 ms in this repo. `src/chat/diff-capture.ts:158-207` captures the dirty/untracked set, so the expensive part is O(dirty set), not O(repo tree), after git status.

Blast radius: `src/chat/headless-turn.ts`, `src/chat/headless-turn-checkpoint.ts`, `src/chat/headless-turn-review-settle.ts`, `src/chat/diff-capture.ts:158-207`, `src/chat/diff-review-store.ts`, `src/chat/review-risk.ts`, plus any carrier/headless bypass path must be audited before build.

Ranked falsifiers: chat-mode file write creates review card; pure chat creates no card; checkpoint failure blocks before spawn; post-write capture failure blocks next writable turn; PLAN cannot mutate even if capture is disabled.

**R4 - Parallel Review Without Global Queue**
Design: retire global routine-write serialization. Build-confirm becomes a risk gate only, never a queue token. Routine file writes run in parallel and are captured independently per agent.

Current serializer: `src/tui/build-confirm-gate.ts:113-129` mints the token; `src/chat/write-queue-gate.ts:228-263` queues confirmed write agents; `src/chat/headless-turn.ts:174-182` excludes queued agents from dispatch; `src/chat/write-queue.ts:280-358` enforces one active plus FIFO release. `src/chat/write-lease.ts` should not be treated as the live lock.

Replacement: keep per-lane checkpoints/review deltas, add or derive per-review path claims: repo, turn, agent, path/oldPath/newPath, pre hash, post hash, baseline head, review id. When a new review settles, compare its touched paths against unresolved reviews and overlapping active capture windows. Same path or rename endpoint overlap marks both reviews as conflict/overlap. AUTO must not auto-accept overlaps. Undo applies only if the current file still matches that review’s expected post-image; otherwise it refuses and routes to combined/manual review. No “baseline wins.”

Same-file concurrent edits: shared worktree plus post-hoc overlap detection is the smallest viable fix. Per-agent worktrees are cleaner but a much larger migration. If two agents touch different files, their reviews/undos compose independently. If they touch the same file, no silent scramble: conflict card, no auto-accept, no blind undo.

Queue machinery outcome:

| Invariant | Status |
| --- | --- |
| One active writer per repo | Retired; caused the deadlock class |
| FIFO queue release | Retired for routine writes |
| Repair-linked acquire | Preserved, but should move to `repair_attempts`/redirect state, not global queue |
| Restart orphan classification | Preserved as legacy cleanup only |
| Zero-delta releases queue head | Retired; zero-delta means no review |
| Per-agent lane tail ordering | Preserved in `src/chat/lane-scheduler.ts:33-56` |
| Review/undo integrity | Replaced by per-review expected-image checks plus path-overlap conflict |

Blast radius: `src/chat/write-queue-gate.ts`, `src/chat/write-queue.ts`, `src/chat/write-gate-recovery.ts`, `src/chat/headless-turn.ts`, `src/chat/headless-turn-review-settle.ts`, `src/chat/diff-capture.ts`, `src/tui/build-confirm-gate.ts`, v17 queue/lease migrations, review redirect/repair tests.

Ranked falsifiers: three routine writers dispatch concurrently; three independent reviews are created; same-file writes are conflict-marked; AUTO does not accept overlaps; undo refuses if another review changed the expected image; risky deletes/installs/migrations still require confirmation.

**Prior Art**
Claude Code documents `/clear` for fresh context and saved resumable sessions, but I found no explicit stale-side-effect boundary: https://code.claude.com/docs/en/sessions

Codex CLI documents `codex resume`, `--last`, and `codex exec resume` with optional follow-up prompts, but no stale mutation warning in the official command docs I found: https://learn.chatgpt.com/docs/developer-commands

Gemini CLI session management saves prompts, responses, and tool calls and supports `/resume` / `gemini --resume`; again, no explicit stale-side-effect guard found: https://developers.googleblog.com/pick-up-exactly-where-you-left-off-with-session-management-in-gemini-cli/ and https://google-gemini.github.io/gemini-cli/docs/cli/commands.html

Closest useful prior art is LangGraph human-in-the-loop: interrupted work persists durably, but actions resume only after explicit human approval: https://docs.langchain.com/oss/python/langgraph/interrupts and https://docs.langchain.com/oss/python/langchain/frontend/human-in-the-loop

So: CLI agents optimize for continuity; multi-agent project mutation needs the LangGraph-style approval boundary.

**Sequencing**
Do not ship all four as one opaque wave. Ship R1 first because it is parser-local and easy to live-test. Then ship R2 boundary because it changes operator trust semantics without needing the queue rewrite. Ship R3 and R4 together: universal capture built on the old token/queue model would either miss chat writes again or amplify the deadlock class. The trust-layer wave should include universal checkpoints, no routine queueing, per-agent review ids, and same-file overlap detection.

**Contradictions / Unverified**
WRONG/stale: “write-lease activated by build-confirm token” is contradicted by current code comments and grep evidence; `write_queue` is live, `write_lease` is not a production caller.

SUPPORTED: body mentions can outrank explicit `@all` because multi-address parsing happens before leading prefix routing.

SUPPORTED: chat-mode writes can bypass review because checkpointing is token/build-gated.

UNVERIFIED: the exact live trace string `delta.injected bytes=948 seqs=12,13,14,15,16` was ledger-cited, not independently found in run logs during this read-only pass.

CONTRADICTS internally: PRD I-7 says PLAN is native read-only, but the later “NEXT ROUND” scope still mentions PLAN v1 snapshot+restore. Treat the I-7 locked behavior as authoritative.

Confidence: YELLOW, about 88%. The core design is repo-backed, but implementation should first audit carrier/headless bypasses and ACP-specific dispatch before editing. No tests were run; this was read-only design plus source/research verification.

