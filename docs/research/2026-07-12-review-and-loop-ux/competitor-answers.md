# RESEARCH PASS 3 — competitor answers to the five design questions (2026-07-12)

Full per-product evidence collected by uxresearch2; summary table + recommendations below.
zer0's model weighted: changes ALREADY APPLIED (keep-or-undo), non-coder operator — the
apply-then-undo precedents (Aider/Replit) weigh heaviest.

TWO WHITESPACE FINDINGS: (a) NO shipping product orders parallel results by risk;
(b) NO product offers "ask the agent to split a huge change." Both are zer0 originals that
follow from Principle 9 (spend attention where risk is).

| Q | zer0 recommended default | Follows | Diverges from | Grade |
|---|---|---|---|---|
| Q1 arrival | Quiet counter, never interrupt; keep-on-ignore OPT-IN only | Aider auto-commit, Copilot async, CC acceptEdits | CC Manual prompt-per-action | STRONG |
| Q2 order | RISKIEST-first (newest tiebreak), grouped by task | none — original | Cursor/Copilot chronological | MODERATE (a reasoned bet) |
| Q3 undo | u = THIS change-set; whole-turn = secondary; rollback COMPLETE (incl. tool/bash edits — CC's own gap) | Replit checkpoints, Aider /undo | bolt (coarse+lossy = trust-destroying), CC (misses bash) | STRONG |
| Q4 big diff | Summary-FIRST + collapsed/expandable diff + one-key "ask to split" | GitHub collapse, Lovable outcome-layer | split = original | STRONG / MODERATE |
| Q5 friction | FIXED, UN-REMOVABLE hard-stop set (installs, deletes of pre-existing files, schema/DB, force-push, deploys) even in full-auto; users may WIDEN auto-approval (allowlist), never narrow the stops | CC non-overridable deny + rm-rf circuit breaker; Cursor's denylist→allowlist reversal; the Replit prod-DB incident | Windsurf/Cursor removable denylists | STRONG |

KEY EVIDENCE ANCHORS: code.claude.com/docs/en/permission-modes (deny rules apply in EVERY
mode incl. bypass; protected paths; the auto-mode classifier's ~30 blocked categories +
conversation-stated boundaries) · code.claude.com/docs/en/checkpointing (per-prompt
3-axis /rewind; bash changes NOT tracked — the gap zer0 closes) · aider.chat/docs/git.html
(auto-commit + /undo = the apply-then-undo trust model) · backslash.security (the Denylist
Delusion — allowlist over denylist) · incidentdatabase.ai/cite/1152 + fortune.com 2025-07-23
(Replit deleted a prod DB despite instructions → dev/prod separation + plan mode + one-click
restore; irreversible ops need a stop OUTSIDE the agent's reasoning loop) ·
github.blog (Copilot coding agent = async draft-PR, never interrupts) ·
thoughtbot.com/blog/github-diff-supression + community#65214 (Load-diff collapse; 3,000-line
API ceiling; linguist-generated) · stackblitz/bolt.new#7814 (undo-reverts-too-much = the
counter-example) · CC issues #50246/#61718 (queue-don't-interrupt demanded; implementation
buggy — cite the intent, not the implementation).

CAVEATS: CC message-queue buggy (design validated, implementation not) · Cursor allowlist
UI location UNVERIFIED post-v1.3 · Windsurf specifics vendor-social (MED).
