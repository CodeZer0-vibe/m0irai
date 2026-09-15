# ADR-S-001 — Temporal workflow enforces build discipline (agents are pure functions)

**Status:** Accepted (v1: 2026-05-06; **v2 council-ratified: 2026-05-08**)
**Date:** 2026-05-06 (v1) / 2026-05-08 (v2)
**Scope:** SYSTEM-LEVEL (applies to all packets, all builders, all reviewers)
**Source directives:**

- 2026-05-05: "the system needs to be smart enough...don't depend on agents to remember stuff like check, read, load, do it like this"
- 2026-05-06: "the temporal worker IS the discipline" + "we can learn and optimize based on the issues or wins we find during our advancing"
- 2026-05-06: "spawn fresh new agents every time, by having the tracking files for each agent that are maintained by phase task" — ephemeral spawns over long-lived sessions
- 2026-05-08: User directive to address ALL council findings at full L5 quality (codex hostile REDESIGN verdict + gemini synthesis ALIGNS-WITH-INDUSTRY 9/10)

## v2 council ratification summary

Council reviews of v1 (codex hostile + gemini synthesis, dispatched 2026-05-08):

- Codex verdict: REDESIGN — found 3 SPEC §18 contradictions (review-before-commit, single-pass audit, reviewer-receives-builder-context) + 5 P0 protocol gaps (duplicate runs, idempotency, cancellation, manifest validation, escalation deadlock)
- Gemini verdict: ALIGNS-WITH-INDUSTRY (9/10) — endorsed core direction; flagged 5 missing patterns (workflow versioning, tracking-file schema, activity memoization, OpenTelemetry, parameterized phases)
- Both: ENDORSE-WITH-AMENDMENTS on ephemeral-spawn-per-activity → promoted from amendment to canonical

All 5 P0 + 8 of 9 P1 + 4 P2 + 5 gemini priorities incorporated into v2 (full disposition table at `docs/ARCHITECTURE-buildPacketWorkflow.md` §14).

## v2.1 vision-locked addendum (2026-05-08, post-bootstrap-fix)

After `zer0 up`/`zer0 start` reality test + L5 product-quality review, two architectural commitments locked:

1. **§15 L5 product-quality additions:** capacity tracking (subscription-default, API-mode-opt-in — user uses subscriptions, dollars are not the right currency), per-model context projection, auth lifecycle, multi-account/project scoping, OpenTelemetry pulled forward to packet-11c, hallucination quorum cross-check, approve-by-rubric, crash recovery, diff approval, performance budgets.

2. **§16 End-state TUI experience:** persistent terminal session with solo + team modes, slash-command grammar, free model swap (architectural consequence of ephemeral spawn), council patterns as first-class, capacity panel, time-travel branches, session save/share. NOT voice / Cursor-mode / GUI.

The whole architecture (§4-§14) is the HOW. §15 is the QUALITY BAR. §16 is the WHY. All locked.

## Context

Hand-cranked dispatch (today): orchestrator manually writes briefs, dispatches agents, runs gates, writes fix-loop briefs from gate output, dispatches reviewers, commits between phases. Every packet repeats this cycle. Every dispatch asks the agent to remember 30+ rules from MD reference files.

Two problems:

1. **Cognitive load on agents.** Briefs reach 1000+ lines; references total 7500+ lines per dispatch. Agents skim, miss things, skip sections.
2. **Discipline is asked-for, not enforced.** The brief says "remember to run gate-l5 before saying DONE". Agent may comply or may not. Same for "read these ADRs" or "verify owned-files boundary".

Real CI pipelines don't ASK developers to run linters before push. They run linters on push. Process > discipline.

Three options considered:

1. **Smaller MD files / split references** — agent's reading load shrinks but agent still has to KNOW to read them. Doesn't solve the discipline problem.
2. **Codex sub-agents inside builds** — agent spawns sub-agents to parallelize. Coordination chaos in sandbox; auth problems; race conditions on shared files; cost multiplies. Inconclusive empirical test (codex quota cap).
3. **Temporal workflow enforces discipline mechanically** — workflow does context preparation, gate enforcement, fix-loop generation, retry, commit. Agent receives focused ≤300-line prompt and is a pure transformation function. ✓ Selected.

## Decision

**Temporal `buildPacketWorkflow` is the canonical build entry point. Agents become pure transformation functions. Every LLM call is an ephemeral spawn (no long-lived sessions).**

Specifically (v2 ordering — order changes from v1 are flagged with [v2-CHANGE]):

1. CLI command `zer0 build <packet-id>` computes deterministic workflow ID `build:{repoFingerprint}:{packetId}` and rejects duplicate runs [v2-CHANGE: P0-1 fix].
2. CLI acquires repo lease at `.zer0/leases/{packetId}.lock` before starting.
3. Workflow's `loadManifestActivity` runs Zod parse + 6 semantic validators (cycles, overlaps, ADR resolution, cross-family, gate names) [v2-CHANGE: P0-5 fix].
4. Workflow's `prepareContextActivity` assembles a phase-focused prompt (≤300 lines via `manifest.contextBudget`) inlining ONLY the brief sections, ADR rows, MODULE-MAP rows, and AGENTS.md clamps relevant to the phase. `mustNotOmit` sections never truncated [v2-CHANGE: P2-3 fix].
5. Prompt is written to `.zer0/runs/{runId}/agents/{phase}/{attempt}/current.json` (Zod-schema'd tracking file [v2-NEW: gemini G2 + codex amendment 1]).
6. Workflow's `dispatchAgentActivity` ephemerally spawns the agent with the tracking file + claim-key idempotency [v2-CHANGE: P0-3 fix + canonical ephemeral spawn].
7. Workflow's `runGatesActivity` dispatches each gate as a sub-activity with own timeout/heartbeat/maxBuffer [v2-CHANGE: P1-7 fix]. Gates use execa with arg arrays (no shell syntax) [v2-CHANGE: P1-8 fix].
8. If gates fail, `generateFixBriefActivity` produces a focused fix-loop brief from structured `AttemptFailure[]` (with REPEATING markers) [v2-CHANGE: P1-11 fix]. Agent retries with claim-key reuse on Temporal retry.
9. If gates pass, `commitActivity` commits FIRST [v2-CHANGE: P0-2 fix — packet-sealed-gate per SPEC §18].
10. THEN `dispatchReviewActivity` runs **two-pass audit** [v2-CHANGE: P1-6 fix per SPEC §18.6]:
    - Primary review (cross-family) on the committed diff
    - Secondary missed-dimensions audit (different prompt, different rubric)
    - Reviewer NEVER sees builder's prompt or context pack [v2-CHANGE: SPEC §173-180 compliance]
11. If either review finds P0/P1 blockers, `revertCommitActivity` rolls back and fix-loop. Else next phase.
12. After all phases, full-packet final review by `fresh-claude-l5` on the committed range.
13. `analyzePacketActivity` produces lessons.
14. `postCommitDocumentationActivity` updates HANDOFF + lessons docs [v2-CHANGE: P1-10 fix — docs BEFORE seal commit].
15. SEAL commit `DONE(packet-N)` includes the doc updates.
16. Proposed mandates go to `.council/proposed-mandates/pending/` queue [v2-CHANGE: P1-12 fix — async, never blocks seal]. Each goes through baseline + false-positive sample + conflict check before user accepts [v2-CHANGE: P1-13 fix].
17. Cancellation protocol: heartbeat + abort propagation + cleanup contracts per activity [v2-NEW: P0-4 fix].
18. Workflow versioning via `patched()` for in-flight migrations [v2-NEW: gemini G1].

Full architecture: `docs/ARCHITECTURE-buildPacketWorkflow.md` (v2, §0-§14).

## Consequences

**Positive:**

- Agent is a pure function: `(focused_prompt, code_state) → diff`. No memory required.
- Discipline mechanically enforced: gates always run, reviews always dispatch, fix-loops auto-generate.
- Cognitive load on agent reduces from 7500+ lines to ≤300 lines per dispatch — focused attention.
- Phase fix-loops have small blast radius (4-12 files vs 40).
- Self-improvement: every packet teaches the system; accepted lessons become permanent gates.
- Self-application: zer0 builds zer0 with zer0. Each new packet flows through the workflow.
- Observable: Temporal gives full execution history. Diagnostic scripts query workflow state.
- Pausable: human-in-the-loop modes work via signals (auto/semi/full).

**Negative:**

- Workflow code itself can have bugs. Bad workflow = bad builds. Mitigated by treating the workflow as just another module under all the same gates.
- Cost overhead: per-activity Temporal latency, per-phase context payload. Realistic estimate (codex review v2): tokens +20-40% (was unverified +10-20% in v1), wall-clock +30-50% vs single dispatch. Worth it for quality.
- Cross-family review still required — workflow runs gates (mechanical floor), review catches semantic gaps (judgment ceiling).
- Initial implementation cost: packet-11 builds the workflow itself, hand-cranked one last time. **v2 estimate: split into 11a/11b/11c/11d sub-packets, ~70 cumulative files, 28-40 files per sub-packet.** Codex review caught that v1's 10-15 file estimate was materially low.
- Cold-start tax for ephemeral spawns: each LLM call pays context-loading cost. Mitigated by prompt caching (Anthropic 5-min, OpenAI 10-min TTLs).
- Workflow versioning requires care: `patched()` lets in-flight workflows survive code changes, but new patches need testing on both branches.

**Neutral:**

- Sycophancy still exists in agent outputs — banned-phrases gate catches it; doesn't eliminate it.
- New failure modes will surface — that's the self-improvement loop's job.

## Implementation path (v2)

- **packet-10** (current, fix-loop pending): hand-cranked, demonstrates new gates G1-G4 work.
- **packet-11a** (next): manifest schema + semantic validators + idempotency tables (dispatch_claims, commit_intents) + ADR index builder. ~17 files, 1100-1400 lines.
- **packet-11b**: prepare-context, run-gates (per-gate sub-activities), dispatch-review, generate-fix-brief, revert-commit + tracking-file protocol (CurrentState, Result, DecisionRecord, compactor). ~22 files, 1400-1800 lines.
- **packet-11c**: buildPacketWorkflow itself + workflow versioning (patches.ts) + lease + escalate + analyze-packet + post-commit-docs activities. ~16 files, 800-1200 lines.
- **packet-11d**: CLI commands (build, cancel, approve, mandates) + chaos integration tests. ~15 files, 500-700 lines.
- **packet-12+**: Phase-2 brain pieces dispatched THROUGH `zer0 build`. No more hand-cranking.
- **packet-13** (deferred from v2): activity memoization (gemini G3), OpenTelemetry exporter (gemini G4), delta-aware gates (P1-9).
- **packet-15+** (deferred): Council UX (chat REPL), MCP server, parameterized phases (gemini G5).

## Why deferred to packet-11 (not packet-10's fix-loop)

Packet-10 fix-loop is small (7 findings, single dispatch). Adding workflow infrastructure to packet-10 mid-flight would balloon scope and risk the in-flight fix-loop. Better to close packet-10 cleanly with current pattern, then build packet-11 = the workflow itself with full focus.

## Why hand-crank ends with packet-11 specifically

Self-application requires the workflow to exist. Packet-11 IS the workflow's first build. We hand-crank that one final time. From packet-12 onward, every packet goes through `zer0 build`.

## Anti-pattern locked out

DO NOT add more rules to AGENTS.md/SPEC.md/templates that say "agent should remember to do X". Every such rule is a bug. The right response is: add an activity to the workflow that DOES X automatically. Documentation is for humans (orchestrator, future builders); workflow is for enforcement.

## Source-of-truth files

- `docs/ARCHITECTURE-buildPacketWorkflow.md` (v2) — full design specification with §14 finding disposition
- `memory/feedback_workflow_enforces_discipline.md` — principle for future sessions
- `docs/HANDOFF.md` — current implementation status
- `.council/cross-model/buildpacketworkflow-codex-review-result.md` — v1 hostile review (REDESIGN)
- `.council/cross-model/buildpacketworkflow-gemini-review-result.md` — v1 synthesis review (9/10)
- This ADR

## Reviewable in

When reading this ADR for the first time:

1. Read `docs/ARCHITECTURE-buildPacketWorkflow.md` first (the full design).
2. Then this ADR (justifies the design).
3. Then check `docs/HANDOFF.md` for current implementation status.
4. If buildPacketWorkflow already exists → use `zer0 build` for next packets.
5. If buildPacketWorkflow doesn't exist → packet-11 is the next build, hand-crank it.
