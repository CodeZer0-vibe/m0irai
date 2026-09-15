# The Final App — Complete Workflow (TARGET)

> **STATUS (2026-05-28): this is the TARGET, not current state.**
> LIVE today: chat dispatch (`@agent`/`@all`/`/council`/`/dispatch`/`/build`), mode-aware sandbox,
> `buildPacketWorkflow` (build one pre-written packet), cross-family review, council, SQLite memory,
> full gates. NOT BUILT: the two dials (intent-classifier), AUTO greenfield pipeline (the pre-build
> stages are stubs at `src/temporal/workflows/pipeline.ts:95-107`), quality dials (mvp/production),
> audit mode, risk-tier gating, ADR-seal enforcement. See the handoff
> `2026-05-28-session-3-ORCHESTRATION-LOCK.md` for the grounded gap + build order.

---

## The core idea: two independent dials

Every interaction is shaped by two settings the system picks automatically (overridable):

- **MODE** = what workflow runs (manual / auto / audit / research / brainstorm / council)
- **QUALITY** = how strict the gates are (mvp / production / L7)

You never set these. You talk; the system reads your prompt + project state and picks, shows the
pick, and you can correct it in one word.

```
You: "build me a quick habit tracker mvp"
System detects: mode=auto, quality=mvp
Shows: [auto · mvp] — say "production" or "manual" to change
```

## Entry point: it's all just chat

There is no orchestrator you talk to — the chat IS the dispatch surface. `@codex do X`,
`@gemini research Y`, `/council Z`, or just a sentence (routed). The intent-classifier runs on every
message: message → (keywords + project stage + history) → (mode, quality) → shows pick → proceed/override.

Detection examples: "quick/mvp/prototype/vibe"→mvp; "production/ship it/Google-level/L7"→L7;
touches sandbox/auth/persistence/migrations→auto-bump L7; "build me an app/take this end to end"→auto;
"what do you think/thoughts on"→brainstorm; "review/audit"→audit; "market/competitors"→research;
default→manual+production.

## Agent rules that apply in EVERY mode

1. **Lead-by-class** — product/scope/UX→claude; infra/adapters/persistence/sandboxing→codex;
   research/library/market→gemini; architecture (Tier 3)→all three propose.
2. **Writer-never-reviews-own-draft** — whoever designs is OFF its review panel.
3. **Cross-family review** — code reviewed by a different model family than built it.
4. **Risk tiers decide process:** Tier 0 mechanical (gates only); Tier 1 local (build + 1 cross-family
   review); Tier 2 integration (design-claim → brief-review → build → full gates → cross-family review);
   Tier 3 architecture (all 3 propose → you pick → packets).
5. **Ground-in-code-first** — the lead READS the files it will touch and cites file:line before any plan.
6. **Builder escalation** — mid-build, if the plan is wrong the builder STOPS and escalates with
   evidence; never silently follows a broken plan, never silently does its own thing.

## Why this design — the Claude/Codex problem we solved

This system exists because **a single orchestrator does not work.** Two failure modes, both observed and proven in our own history:

1. **Manipulated briefs (Claude-as-sole-orchestrator).** When Claude wrote near-complete pseudo-code briefs and Codex built them, Codex implemented Claude's design *faithfully* — and could not challenge it. Bugs survived precisely because the builder couldn't push back (the "E2 theater" bug existed only for this reason). This is ROUND_TABLE banned-behavior #10: over-specifying builder prompts. **Fix:** briefs state OBJECTIVE + ACCEPTANCE TEST, never pseudo-code; the builder has escalation rights and challenges with file:line evidence.
2. **Dumb builder (no model plays to its strengths).** A model told exactly what to type contributes none of its own training. **Fix:** lead-by-class — the model whose strengths fit the task leads it.

**Research is complementary specialization, NOT a competition.** Each model works the lane its training fits; the outputs are *synthesized* into one artifact (union, not a winner-take-all vote). Empirical basis — NEON SERPENT: no single model exceeded **73%** coverage; all three combined hit **100%** at $1.93. The lanes:

- **Gemini** — the only model with live Google-Search grounding and multimodal *vision*. Owns external/world research, fact-verification, competitor/market scan, visual review of designs & rendered UI. Creative/divergent.
- **Codex** — implementation precision, dependency/API rigor, low-level code. Owns infra/wiring; default builder.
- **Claude** — architecture, edge cases, systems reasoning, synthesis, coordination. Owns product/scope; stitches the others into one spec/plan.

**Two shapes of collaboration — keep them separate** (conflating them produced both the dead failover code and the gemini-banned build path):

- **Shape A — division of labor:** the models answer **different** sub-questions, so outputs are **concatenated, never compared** — Gemini "what's true in the world," Codex "can it be built," Claude "architecture + the merge." Most research is this.
- **Shape B — cross-check:** the **same** question goes to ≥2 models and **disagreement is the signal** to investigate — review (builder ≠ reviewer, cross-family) and the union rule (any P0 = investigate; dismiss only with mechanical counter-evidence).
- **Decision rule:** same sub-question + a costly false-negative → cross-check; different sub-questions → divide and concatenate. Divergence in Shape B is a flag for Claude to resolve or escalate, **never a vote**.

**The winner emerges from debate, not authority.** For Tier-3 architecture all three propose independently → *you* synthesize the winner → it does not matter which model authored it. When two reviewers disagree, **you** break the tie — never an agent.

### Gemini's hard boundary (authority, not capability)

Gemini **writes `.md` only** — research, audit reports, design proposals, ADR drafts. It has **no write authority over any executable artifact** (code, tests, config, migrations, scripts): a hallucinated test is worse than none. Its findings are **proposals to verify, never verdicts**; it is never the single reviewer that gates a commit; it never runs with `-y`/YOLO (it silently writes hallucinated files). This is not "Gemini can't code" — it is **blast-radius containment**: Gemini's output is capped at documents a human or another agent reads before anything irreversible happens. **Enforced by a `gemini-writes-md-only` gate at the dispatch boundary, not by folklore.** Use Gemini where it is unmatched: the only live fact-oracle, the only agent that can *see*.

## Delegation & safe concurrency (who can touch what, when)

The rule — _"if Codex is writing files X, Claude can't also build X, but Claude can review X while Codex builds"_ — is a **read/write lock over file-sets**, built on the existing lease + worktree layer:

- **Write-lock (builders): exclusive per file-set.** A build claims a write-lock on its `phase.ownedFiles` (the manifest already declares these). Two builders whose owned-file sets overlap cannot run at once — the second queues or is rejected. No two writers ever share a file.
- **Read (reviewers / researchers / auditors): non-exclusive, overlap freely.** A reviewer grades a _committed snapshot_ (commit-before-review already exists), so a review runs _while_ a build proceeds on the same files — it reads a frozen commit, not the live tree. Reads never take a write-lock.
- **Worktree isolation: one git tree per concurrent builder.** Today the lease is per-packet with **no worktree** (audit CONCURRENCY-4) and the build mutates `input.repoRoot` directly (`build-packet.ts:104`) — so two builds would corrupt one tree. The model requires each concurrent builder in its own git worktree: the lease arbitrates the _file-set_, the worktree isolates the _bytes_; merge-back is gated.
- **Gemini never holds a write-lock** — it writes `.md` only, so it is always a "reader" in this model and can run alongside anything.
- **The lease is the cross-process arbiter — and it is currently broken** (audit CONCURRENCY-1: TOCTOU lets two builders both claim one packet → two builds, one tree). **This whole delegation model cannot be trusted until CONCURRENCY-1 + CONCURRENCY-4 are fixed** (remediation Wave 3) — they _are_ this feature's foundation, not separate bugs.
- **Custom scenarios resolve by the same primitive:** any task that would write files overlapping an in-flight build is queued behind it; any read-only task (review / research / audit) runs immediately.

_Full mechanism — MRSW lock modes, the singleton `LockManagerWorkflow` (Temporal owns the lock table), git-worktree isolation per writer, and the hard coupling "W/R safety is a lie until DISPATCH-SEC-1 lands" — is developed in `vision-developed-vision.md` Facet 3._

## Mode-by-mode

- **MANUAL (default):** you drive. `@codex fix the null check`. One dispatch. Gates per quality.
- **AUTO — greenfield (flagship):** Stage 1 Q&A (gemini → docs/intent.md) → Stage 2 market research
  (gemini → docs/research/) → Stage 3 spec (claude → docs/SPEC.md) → Stage 4 SPEC GATE (codex+gemini,
  claude out) → Stage 5 plan+manifest (codex → docs/PLAN.md) → Stage 6 PLAN-vs-SPEC GATE (claude+gemini,
  codex out) → Stage 7 BUILD (Temporal buildPacketWorkflow per phase: context→dispatch→gates→
  cross-family review→escalate→fix-loop→commit) → Stage 8 ship+handoff. Checkpoint at each stage.
- **AUTO — existing feature:** same, skips Stage 1-2; starts at spec-delta.
- **AUDIT:** 3 agents scan IN PARALLEL (codex→infra/runtime, gemini→spec-drift/security,
  claude→architecture) → .council/audits/{agent}.md → synthesis (dedup, rank, conflict-flag) →
  you pick findings → fix packet → AUTO build.
- **RESEARCH:** gemini-led web grounding; claude+codex sanity-check against codebase.
- **BRAINSTORM / COUNCIL:** no build; 3 independent positions → you see divergence → you decide.

## Worked example — "add a sandbox flag to the codex adapter"

intent → manual BUT "sandbox" auto-bumps Tier 2 / L7 → codex (infra lead) READS
codex.ts + dispatch-service.ts (grounds in code) → writes a **Design Claim Card** (runtimeInvariant /
executionSpine [file:line per step] / knownWrongFixes) → claude+gemini review the Card (codex out) →
APPROVED → codex builds + writes a falsifying test asserting actual argv → full gates + cross-family
review → ADR written, committed. _(This is the workflow that would have caught the read-only bug.)_

## Memory + state (both automatic)

- **Chat memory** — every turn → SQLite (chat_sessions + chat_messages), resumable.
- **Project state** — `docs/project-state.md` auto-regenerated each turn (branch, mode, last 5 ADRs,
  last 5 commits, active spec section, gate status, packet in flight). Every dispatch reads BOTH —
  no agent works blind. lessons-reader injects past mistakes into every dispatch context.

## Tracking files (enforced, not remembered)

| File                    | Written by     | When                    |
| ----------------------- | -------------- | ----------------------- |
| docs/intent.md          | gemini         | Q&A                     |
| docs/research/\*.md     | gemini         | research                |
| docs/SPEC.md            | claude         | spec                    |
| docs/PLAN.md + manifest | codex          | plan                    |
| docs/adrs/\*\*          | deciding agent | every Tier 2+ decision  |
| docs/MODULE-MAP.md      | builder        | every structural change |
| docs/lessons/\*.md      | system         | post-build              |
| .council/findings.md    | reviewers      | every review            |
| evidence DB (SQLite)    | every activity | every state change      |

A Tier 2+ change **cannot seal without its ADR** — the system blocks you.

## What you see vs what runs

You see: a chat, occasional checkpoints ("spec ready — proceed?"), occasional escalations ("plan says
X but code shows Y — your call"). Underneath: intent classification, mode routing, risk-tier gating,
Temporal durable workflow, cross-family review, escalation, evidence ledger, lessons injection, ADR
enforcement — invisible until it needs you. The dial is yours: mvp strips ceremony to near-nothing;
L7 runs the full gauntlet. Same chat, same agents, different rigor — chosen by what you say.

## Foundation: what must be true first (2026-05-28)

This target runs on the `buildPacketWorkflow` + dispatch + evidence + Temporal foundation. A full audit (2026-05-28, `docs/audits/audit-zero-cli-full-audit.md`) found that foundation **SHIP-BLOCKED** — 11 confirmed BLOCKs (secrets leak to the models, the read-only reviewer can write, phase order is a length-sort not a toposort, a cancel deadlocks, the observability commands are non-functional) — and **drifting from its own invariants** (5 honored / 9 drifted / 1 broken / 4 aspirational; `docs/audits/drift-invariant-drift.md`). Dominant pattern: "right idea, wrong place" — controls wired to the CLI pre-flight or the legacy `pipeline.ts`, not the canonical `buildPacketWorkflow` that actually runs.

Build order:

1. **Harden the foundation** — `docs/plans/plan-zer0-remediation.md` (6 waves: security → git-integrity → lease/concurrency → determinism → observability → real-E2E lift). Includes the `gemini-writes-md-only` gate.
2. **Greenfield pipeline (the crown jewel)** — the AUTO stages above are stubs (`pipeline.ts:95-107`); build the pre-build activities (intent → research → spec → plan, with the writer-out review gates).
3. **Collaboration + delegation** — chat→pipeline bridge + 3-agent shared awareness + file-ownership locking (writer-exclusive, reviewer-overlap), built on the now-fixed lease/worktree.
4. **The cockpit** — ink TUI → React task cards (depends on the observability fixes).

**Temporal is kept** — the target is single-user but durable/permanent; embedded single-worker, not a cluster. Determinism discipline is enforced by gates, not vigilance. The full agent-collaboration constitution is locked in memory `[[project_agent_role_constitution_locked_2026_05_28]]`; the corrected research model in `[[project_temporal_kept_single_user_durable_2026_05_28]]`.

**Engineering companion:** the full facet-by-facet developed design — current state in code, concrete mechanisms, hard parts, foundation dependencies, and 24 consolidated open decisions — lives in `docs/architecture/vision-developed-vision.md`. Read it before building any facet; this north star is the *what/why*, the companion is the *how*.
