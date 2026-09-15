# The Loop — research synthesis + zer0 integration design · 2026-07-02

Three-lane team research (claude web-primary-sources / gemini community-sweep / codex repo-grounded integration). Raw lanes: session scratchpad `research/loop-*.md`.

## 1. What "the loop" is

The **Ralph Wiggum loop** (Geoffrey Huntley, July 2025): a bash loop feeding the SAME prompt to a coding agent until done — the agent sees its own prior work in files + git each round. Anthropic shipped it as an official plugin (Stop-hook re-feed, `--completion-promise` exact-match, `--max-iterations`), then as Claude Code 2.1+ built-ins: **`/goal`** (work until a VERIFIABLE condition; a separate fast model checks done-ness each round), **`/loop`** (interval/self-paced re-run), **`/batch`** (5-30 parallel worktree agents). "Loop engineering" (Osmani, June 2026) is the discipline name. Cited results: 6 repos overnight at a YC hackathon; a $50k contract for ~$297 compute.
Sources: awesomeclaude.ai/ralph-wiggum · github.com/anthropics/claude-code/blob/main/plugins/ralph-wiggum/README.md · aihero.dev/tips-for-ai-coding-with-ralph-wiggum · sabrina.dev/p/loop-engineering-claude-code-goal-routines · theregister.com/2026/01/27/ralph_wiggum_claude_loops.

## 2. The convergent best-practice recipe (all three lanes agree)

1. **Task list with per-item pass flags** (prd.json / markdown PRD); _the agent picks the task, not the human_.
2. **Fresh context per iteration + durable state in files/git** ("forced forgetting" beats context rot; state = progress file + git, never the chat transcript).
3. **Deterministic gates INSIDE the loop** — tests/lint/typecheck block iteration exit (kills "premature victory").
4. **A DIFFERENT agent checks the work** — "no grading its own homework" (loop-engineering doctrine; single-vendor today).
5. **Caps always**: max iterations (5-50), wall clock, cost/budget guard.
6. **HITL first, AFK after the prompt proves itself**; sandbox (Docker/worktrees) mandatory for AFK.
7. Small steps; progress file so each round skips re-exploration; escape hatch ("after N iterations, document blockers and stop").

## 3. The confirmed gap (the zer0 moat)

- Every guide/product is SINGLE-model. `/batch` parallelizes clones of one model. No product loops claude + codex + gemini as one team (gemini lane: explicit absence finding; claude lane: guides say "no multi-model orchestration discussed").
- Community's top wish (gemini lane, marked partially UNVERIFIED): _rotate models when stuck; cross-CLI coordination_.
- The community's own #1 doctrine (different-agent verification) is STRUCTURALLY what a cross-family loop does natively.
- Positioning: **"the only loop where the iteration is built by one frontier model and verified by a different frontier family, with git-verified memory across iterations — on subscriptions, not API bills."** Directly kills: premature-victory (cross-family verifier, no echo chamber), context rot (evidence ledger + progress file, not chat context), token-burn anxiety (subscription + quota-aware pacing).

## 4. zer0 integration design (codex repo-grounded, file-cited; full table in the raw lane)

**Reusable today:** goal-loop.ts = protocol evidence only (worktree→research/debate/build/review→diff→trace; script-shaped, roles hardcoded). Temporal build-packet workflow = the best orchestration PATTERN (signals/status-query/lease/phase-attempts/gates/cross-review). headless-turn + dispatch-headless = the dispatch seam (subscription CLIs; per-lane `onLaneSettled` barrier — built in unit-1 T1). worktree-service = AFK safety (detached worktrees, patch capture, clean-main apply refusal, conflict rollback). Evidence DB = audit ledger. CRITICAL grounding: composePrompt is bounded (8 msgs / 24k chars — headless-prompt.ts:13-16) → the transcript CANNOT be loop memory; a progress file must be.

**New subsystem `src/loop/`** (small modules, repo line-gates respected): types · progress-store (atomic JSON under `.council/runs/<session>/loops/<id>/progress.json`) · protocol (prompts from goal+progress+verifier findings) · driver (iteration state machine; pause/steer/cancel; crash-resume at iteration boundary) · verifier (different-family verdict parser) · budget (consumes the existing `agent.status` usage windows). Plus `loop.*` bus events + a compact TUI loop-card + an extracted shared agent-lane scheduler (the unit-1 `agentTails`/`sessionTail` logic generalized so loop lanes and interactive turns arbitrate the SAME agents).

**v1 protocol (minimal proof of the differentiator):** builder/verifier CROSS-FAMILY split per iteration — claude builds → codex verifies (or reverse); gemini serves research/unblock boundaries, not code-stop checks (matches docs/design/2026-06-21-goal-loop-team-protocol.md: gemini strongest at research/UX, riskier on code facts). Same failure-hash twice → switch builder once → then PAUSE for the operator. NOT full role rotation in v1.

**Stop conditions:** PRIMARY = different-family verifier structured PASS + repo gates green. Completion promise counts only after primary. Safety = maxIterations + wall-clock + **quota guard** (pause when a 5h window is low/unknown — statusline capture can emit nothing on stale data, so unknown ⇒ pause, never assume).

**Safety:** loop builds ONLY in managed worktrees; main tree changes only via the existing clean-main apply. Livelock guard = failure-hash + builder-switch + HITL. Session-write contention = everything through the serialized writer via `onLaneSettled`.

**Cockpit:** compact live loop card (iteration N, phase, per-agent state, budget) + completed-iteration summaries flush to Static history; `/loop` `/pause` `/cancel` controls (slash catalog has none today); the loop occupies only ITS lanes — **unit-1 per-agent independence is the structural prerequisite** that keeps the free agent chattable while the loop runs.

## 5. Sequencing recommendation

Loop v1 = its own spec+plan+build unit AFTER the current unit list's core: unit 1 (independence — prerequisite) → unit 2 (cleanup) → unit 3 (status-bottom + claude-usage — feeds the loop's budget guard) → **LOOP v1** → rails/synthesis-card/diff-review interleave after (diff review then reviews loop iterations too). Table stakes checklist for launch (community-set): iteration caps, quota-aware pacing, live progress card, pause/steer, checkpoint resume, worktree isolation — all covered in §4.
