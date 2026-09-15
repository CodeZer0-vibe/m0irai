# The Loop vs the Field — validation research synthesis (2026-07-14)

Two independent rounds: codex (deep, source-grounded — read OUR loop at file:line and
compared against current Anthropic/OpenAI docs; loop-research-codex-out.md) and gemini
(broad web sweep; loop-research-gemini-out.md). Extends docs/research/2026-07-02-loop-
synthesis.md (which established: no multi-model loop exists publicly — the moat).

## Cross-check note (standing gemini-fabrication discipline)

EXCLUDED from this synthesis: gemini's claim that Claude Code documents `/loop`/`/goal`/
`/batch` commands (no such official docs; likely fabricated) and its "zer0 relies on a
continuous conversation" contradiction (factually wrong — protocol.ts:1-9 rebuilds every
iteration's prompt from durable state only, verified by codex; our loop already IS the
fresh-context-plus-files pattern the community converged on). Everything below survived
cross-checking or is labeled.

## What the field CONFIRMS about our loop (both rounds, independently)

1. The phase shape (negotiate → build → cross-family verify → worktree gates → apply,
   durable progress, outcome history) maps cleanly onto Anthropic's published doctrine
   (gather context → act → verify → repeat; evaluator-optimizer; ground-truth tool
   feedback; explicit stop conditions) — anthropic.com/engineering/building-effective-agents.
2. Fresh prompt from durable state, never transcript replay (protocol.ts:16-23's 24k cap;
   driver-phases.ts:46-78's minimal carry) = the anti-context-rot doctrine both Anthropic
   cost guidance and the community "Ralph loop" pattern prescribe.
3. Goal negotiation BEFORE quota burns + required maxIterations (1-50) + wallClockCapMs =
   the recommended countermeasure to the field's #1 named risk (runaway cost).
4. Worktree isolation + gates + verifier BOTH required for completion = guardrails doctrine.
5. Quota-typed pausing (Unknown/Stale are states, not guesses) = conservative and correct.

## What is genuinely NOVEL (nobody publishes this — we carry the risk alone)

- CROSS-FAMILY STOP AUTHORITY: an iteration completes only on a DIFFERENT model family's
  PASS + green gates (driver.ts:161-179). Both rounds searched; no frontier-lab public
  doc describes a multi-vendor family split as standard. Both independently judged it
  our strongest defense against verifier self-dealing ("AI checking its own work").
- The one-switch livelock rule (identical failure signature → switch builder family ONCE
  → pause) — the field does no-progress detection broadly; this exact rule is ours.

## The five pre-0.3 changes (codex's ranked list, adopted as the work queue)

1. VERIFIER-UNCERTAINTY PAUSE (M, high): today the verifier is pass/fail; the field
   treats "cannot establish adequacy — needs human judgment" as a first-class pause
   outcome distinct from fail. Add the third verdict + its plain-words stop report.
2. ANTI-GAMING DIFF POLICY (M, high): the builder can currently edit tests, gate config,
   package scripts, and CI files as part of its diff — the reward-hacking literature's
   exact exploit (Anthropic's own reward-hacking research). Classify "validation surface
   changed" in the verify phase → require explicit approval or stronger evidence.
3. MID-RUN STEERING at the next phase boundary (L, high): cockpit-loop-bridge.ts:31-34
   admits no live steer entry exists (pause-then-tell-me today). Claude Code and OpenAI
   both treat interruption/steering during runs as baseline UX. The spec (F-6) already
   wants this; it is the largest UX gap.
4. CUMULATIVE USAGE TELEMETRY (M, med-high): per-iteration tokens/capacity consumed,
   projected remaining before confirming an N-iteration run, context pressure on the
   card. F-4 prevents quota MISTAKES; this makes cost growth LEGIBLE.
5. FAILED-APPROACH LEDGER (S/M, medium): verifierFindings passed forward is only gate
   names (driver-phases.ts:73-75); persist a compact ledger of failed approaches +
   verifier critique so the next iteration stops rediscovering dead ends — without
   breaking the fresh-context discipline.

## Remaining gaming vectors (codex's table, banked for the anti-gaming task)

Builder edits tests (open — change #2) · gate config/scripts editable (open — #2) ·
verifier rubber-stamp (partially blocked by cross-family; #1 adds the uncertainty leg) ·
superficial-delta signature dodging (open — harden with #2's classification) ·
zero-delta claims (BLOCKED, driver-phases.ts:317-342) · same-family PASS (BLOCKED,
driver.ts:161-166) · ledger tampering (mostly blocked; not cryptographically sealed —
accepted risk at this scale).

## Disposition

The built loop's architecture is field-validated; nothing structural changes. The five
items above become the loop's post-T-FINAL work queue (folding into the 0.3 ladder after
the E2E legs run on quota). Sources: the two raw research outputs + the URLs they carry;
codex confidence YELLOW 86% (the "nobody does cross-family" claim is a public-source
absence, unprovable exhaustively).
