# LOOP UX RESEARCH — how autonomous loops display & steer (2026-07-12, loopresearch lane)

VERDICT ON THE SPEC (v0.8 I-8/I-9): directionally RIGHT for a non-coder (plain-words
doing-line, iteration counter, per-iteration history, one stop report, no log firehose) —
with FIVE gaps, two BLOCK-grade:

1. [BLOCK] LIVE QUOTA ON THE CARD — OPERATOR CORRECTION FOLDED (2026-07-12: "for cost we
   use the subscription anyway"): zer0 is SUBSCRIPTION-FIRST by locked design — no dollars
   ever tick; the unit is CAPACITY (the 5h window + weekly allowance, used %, per agent).
   The research's anxiety evidence transfers one-to-one (Devin's "compute meter spinning"
   fear, "8 ACU debugging a typo"; OpenHands #8916 token hunger; Aider's per-turn readout =
   the proof a small always-visible line fixes it) — the subscription version is "will this
   overnight run eat my whole week's Claude?" The card shows the SAME capacity language the
   status bar already speaks ("5h: N% used", weekly when low), fed by the SEALED
   budget.snapshot module; the F-4 quota guard (pause BEFORE an unverifiable iteration when
   any needed lane reads Low/Unknown/Stale) already exists. Display-only work.
2. [BLOCK] FORWARD-PROGRESS vs STUCK signal — a heartbeat clock says time passed, not
   progress made; the marquee failures are INVISIBLE LOOPS (Devin: 47 plans in 6h before
   timeout; Ralph: broken-build mornings). Show the last concrete artifact (commit/test/
   file + timestamp) + a stall detector ("iteration 4 made no new change"). zer0's sealed
   failure-signature module already detects same-wall iterations (I-6).
3. Active NOTIFICATION on every stop (bell/OS toast) — the operator has walked away; all
   async competitors notify (Copilot states, Cursor Slack/mobile, Codex Slack/Linear).
4. A visible REAL plan/checklist — "N of M" is a budget counter, not a plan; show the
   falsifiable checklist (gates/goal sub-items done/remaining). NEVER an LLM-narrated
   intention plan — the narrated-plan path is Devin's 47-plan trap.
5. TWO intervention modes, not one cancel: steer-without-stopping (inject a note, applies
   at the next phase edge — the spec's F-6 already contracts this; make it a visible
   affordance) + hard stop. Claude Code's Esc-vs-type-Enter; Copilot's "adapts as soon as
   the current tool call completes."

DO-NOT-ADD (evidence-backed noise): the OpenHands event-stream altitude · streaming
per-tool-call diffs (Codex: "scheduled review checkpoints rather than continuous
monitoring") · a model-narrated reshuffling plan · raw reasoning/tokens · AUTO-MERGE-ON-
SILENCE (worktree/no-auto-merge stays; the stop report proposes, the operator disposes —
Jules may auto-approve a PLAN on silence; code must not merge itself).

DISPLAY PATTERNS (recurring): plan-with-checkmarks (Copilot PR checklist, Jules steps) ·
status chip (queued/working/WAITING-FOR-YOU/done — "needs you" is an explicit STATE, never
inferred from a spinner) · background-list + review-on-return (Codex/Cursor) · continuous
cost readout (Aider) · two-tier diff (Jules mini→full).

USER EVIDENCE: nobody truly walks away ("short, controlled bursts"); opacity kills adoption
("once users stop understanding what the agent is doing, they lose confidence… add manual
review steps that eliminate the productivity gain"); the good stop report = summary + diff

- ONE concrete next action tied to commits; volume lesson (HumanLayer): "one small refactor
  every morning is better than none and better than 50."

EIGHT PRINCIPLES: (1) plain words but CONCRETE ("fixing the failing login test", never
"working…"); (2) progress не time — last artifact + stall detector; (3) cost continuously
visible; (4) the per-iteration history IS the walk-away deliverable — invest there;
(5) notify on stop; (6) two ways in (steer / hard stop); (7) engage at checkpoints, no
firehose; (8) reversible autonomy by default (worktree, no auto-merge).

SPEC DELTA CANDIDATES (fold BEFORE T-L10 builds): I-8 card += budget line + last-artifact
line + stall state + the checklist; I-9 stop report += OS notification; F-6 steering
surfaced as a visible affordance; the STUCK state = an explicit card state (maps to I-6's
existing signature machinery). Confidence: HIGH on Copilot/Codex/Jules/OpenHands/Devin/
Ralph/Aider (primary or 2+ sources); MEDIUM on Cursor UI specifics + Jules
auto-approve-on-silence + CC Esc-phrasing (secondaries). Sources in the lane report
(ledgered).
