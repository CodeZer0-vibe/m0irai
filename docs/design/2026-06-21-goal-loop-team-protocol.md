# Goal-loop team protocol (2026-06-21) — operator-designed

The control-tower realization of the Gate Topology: hand the team ONE goal; they collaborate toward the
final MVP under a minimal protocol; zer0 loops until acceptance passes. Empirical-first — run the baseline,
observe, optimize. NOT the Temporal buildPacketWorkflow (that's the headless pipeline); this is native
agents (dispatchHeadless) collaborating.

## Team composition (operator-locked)

- **claude + codex = the code spine.** Both build; both **cross-review each other's code — every line,
  after building, ALWAYS, even with a perfect plan** (a great plan lowers defect rate; it never proves
  absence — review is unconditional). claude leans architecture/planning, codex leans technical depth.
- **gemini = research / UX / creative / multimodal.** 2026-standards research, UX/UI direction, creative
  direction, visual + audio. Bookends the work (research/design up front → UX-conformance review at the
  end). Deliberately OFF the code-build path (its fabrication risk bites hardest there; peers are
  stronger). Its taste is trusted; its factual claims are verified.
- **Flat — no boss.** The best answer wins, decided on evidence. zer0 is the neutral selector (it does not
  author; it promotes the highest-scored candidate per the peers' cross-reviews).

## Team-context (the "minimum" — injected into every agent, every phase)

```
You are one of THREE peer agents — claude, codex, gemini — working toward ONE goal together.
No one is the boss. It doesn't matter who builds; what matters is the BEST, highest-quality answer
reaches the final MVP. Every gate is cross-reviewed: the spec, the plan, and the code after it's written.
Trust but verify gemini — it can fabricate, so its factual CLAIMS get checked against sources/the code.
Strengths (lean on them, not lanes that cage you): claude → architecture & planning ·
codex → technical depth & review · gemini → research, UX/creativity & visual+audio.
Always converge, together, on the best answer.
```

## Pipeline

`gemini: research + UX brief` → `claude+codex: spec → cross-review → converge` → `build (claude or codex)`
→ **mandatory full-code review (every line; the non-builder + gemini for UX-conformance)** → `fixes` →
`acceptance check` → pass, or loop (round cap).

- Thinking phases (spec) run in PARALLEL (each proposes its best — full capability, not turn-taking), then
  cross-review + zer0 promotes the best/merge. Build = one agent (collision-free; "doesn't matter who").
- **Termination = acceptance, not a vibe:** the repo gates (tsc + biome + clamps + tests + file-header) +
  the feature checklist + UX-conformance. This is how "2026 standards" becomes falsifiable.

## Observe → remember (the optimize engine)

Every run emits a **GoalTrace** (per phase: who did what, what was promoted, where it thrashed, rounds to
converge, cost). Recurring observations are distilled into memory — that is the baseline→optimize loop:
the traces compound into the optimized protocol (turn structure, when to parallel-propose vs 1+review,
the selector heuristic, the lean strength of each role). Standing instruction, not a one-off.

## Baseline experiment

- Minimal protocol above, no extra tuning. A throwaway git worktree (repo stays clean, every step = a diff).
- **Test goal must exercise all three lanes** (incl. gemini's UX/visual) — e.g., a small UI MVP (a polished
  single-page "focus timer": countdown + start/pause/reset, 2026 design). gemini: design direction;
  claude/codex: build + mutual review; acceptance: it runs + gates + UX-conformance.
- Output: the MVP + the GoalTrace → report the raw dynamics + the optimization backlog the thrash reveals.

## Optimization backlog (post-baseline — fill from the traces)

TBD from the first run. Candidate axes: parallel-propose vs one-build-others-review per phase; the selector
(peer-score vs debate-to-consensus); how much peer context each agent sees; the round cap; whether gemini's
visual/audio uses real asset-gen (its multimodal / MCP) vs design-direction-only.
