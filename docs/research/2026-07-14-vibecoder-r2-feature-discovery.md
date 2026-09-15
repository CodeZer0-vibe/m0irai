# ROUND 2 — Feature Discovery for the Vibe-First Interface (2026-07-14)

Under the locked positioning (vibe-coders first, developers second; zer0 = the interface
onto the three engines). Sources: gemini community mining w/ deep-follows (vibecoder-r2-
gemini-out.md; grounding-redirect links — corroborating evidence, not standalone proof) ·
codex interface teardown + gap list, docs live-checked 2026-07-14 (vibecoder-r2-codex-
out.md) · Fable deep-follows (multi-subscription stacking + manual cross-check evidence).

## 1. Demand validation (the community asks for what we built)

- #1 ranked recurring demand from beginners on the builders' own forums: "a built-in
  auto-review / testing agent" — verbatim: "why doesn't Lovable have an auto-review or
  testing agent... beneficial for beginners." THAT IS THE LOOP + CROSS-FAMILY REVIEW.
- #2: context/memory management ("as context approaches 100%, quality declines") — the
  shared-brain memory + fresh-context loop answer this.
- #3: switching between specialized agents (Cursor users asking for Claude-style
  subagents) — we have three agents natively.
- Cross-cutting: credit/cost OPACITY is a top frustration everywhere — nobody knows what
  anything costs mid-session. (Feeds the "build fuel" reframe + the loop cost meter.)
- The manual habit that IS our product, documented: users paste one AI's code into
  another AI to check it; "the combined approach catches more than either alone" (dev.to
  writeups); aggregators (MultipleChat) already SELL unified multi-AI access; stacking
  2 subscriptions <$40/mo is called normal (Zapier 2026).
- The barrier stays the "black window": non-devs adopting Claude Code self-describe as
  strategists delegating to a "smart intern" — but bounce on install/auth/error walls.

## 2. The vocabulary translation (codex §0 — adopt as the naming law for every surface)

session → project conversation · stderr → "what went wrong + what to try" · approval →
safety decision · quota → build fuel · undo → restore point · /commands → action menu ·
agent stdout → progress narration. (Extends the PRD's I-4 no-engineer-vocabulary
invariant with the positive vocabulary.)

## 3. Steal / avoid (from the engines' own docs, live-checked)

STEAL: Claude Code's permission explainer idea ("what it does, why, what could go
wrong") · plan mode as an axis · /resume-style discoverability (not the slash grammar) ·
Codex's suggested-first-tasks screen + git-checkpoint-before-task doctrine + auto-review
routing · gemini-cli's rewind/checkpointing + /stats-into-plain-fuel.
AVOID: install screens that are terminal literacy tests · auth handoffs that feel like
broken magic · "working directory" as a greeting · policy machinery exposed as UX
(allow/deny/settings.json) · dev-artifact leaks (/init → AGENTS.md) · "yolo"/danger
flags as tempting escape hatches · auth flows that branch into API keys and cloud
projects. OUR OWN INHERITED SINS (codex, at file:line): /loop confirm's grammar ·
`zer0 init` printing scaffold/config.yaml · session ids in the top bar · "agent/turn/
dispatch/stderr" vocabulary across surfaces.

## 4. What ports from the web builders (and what honestly cannot)

PORTS: one-click revert → restore cards over the existing undo backend · plain progress
narration → WorkingLine/LoopCard reworded · credit meters → "build fuel" · guided error
recovery → action-attached translated errors · template gallery → starter picker ·
the publish moment → a publish-readiness card first, provider flows later.
CANNOT PORT HONESTLY: instant visual preview inside a TUI — the honest equivalent is
zer0 OPENS the browser preview FOR the operator and narrates what the agents see; never
ASCII-fake it. Full DB rollback locally — code revert ≠ database state (Lovable itself
separates them); say so plainly.

## 5. The build path (codex's three waves + the PRD, proposed order)

WAVE 0 (already specced + reviewed): the review-permission PRD build — REVIEW/AUTO/PLAN
modes, AUTO semantics, universal checkpointing (H1), the active inbox (H2), the card/
screen copy. The trust foundation the other waves stand on.
WAVE 1 — FIRST-SESSION SURVIVAL: first-run wizard (Connect engines / Choose app / Choose
safety / Start first build) · login-health card per engine (ready/needs-login/quota-low

- exact next action; never force all three logins) · session auto-naming ("Booking app -
  login fix - Today 14:03", ids hidden) · the action menu as primary discovery (slash
  stays as power-user fallback). ACCEPTANCE: a clean machine with ONE authenticated
  engine → zer0 chat → pick a folder → restore-point setup confirmed → "what does this
  app do?" answered — zero slash commands typed.
  WAVE 2 — THE ERROR & PROGRESS TRUTH LAYER: one OperatorError translation boundary where
  adapter results become cockpit events (operator-error.ts; stderr becomes evidence-only,
  no UI prop named stderr) · ambient app-state strip ("Editing files… / Waiting for
  permission / Quota resets ~2h") · guided recovery actions (Log in / Retry / Restore /
  Ask agents to fix). ACCEPTANCE: injected auth-failure, quota-exhaustion, provider-5xx,
  build-failure, preview-white-screen fixtures ALL render plain summaries + one next
  action + evidence path; zero raw stderr on any operator surface.
  WAVE 3 — RESTORE·PREVIEW·PUBLISH: restore cards after every applied change · auto-open
  browser preview + preview verification (the live app verifier's first slice) · the
  publish-readiness card (detect build/env/host; Publish appears only when checks pass,
  else the missing prerequisite in plain words). ACCEPTANCE: a generated web-app change →
  preview opened + verified + restore offered; Publish gated on green checks.

Interface-track carryover (same track as the waves): S2/S3 receipts + the ghost-row
repro (session-plan items), alt-screen opt-in.

SCOPE NOTE (operator correction, 2026-07-14): THE LOOP IS A SEPARATE TRACK. This
document covers the vibe-coder INTERFACE only. The loop command's own research lineage
(docs/research/2026-07-02-loop-synthesis.md → 2026-07-14-loop-field-validation.md), its
five upgrades, and T-FINAL lane 2 live in the loop track — never merged into interface
wave planning. Two ladders, reported separately.
