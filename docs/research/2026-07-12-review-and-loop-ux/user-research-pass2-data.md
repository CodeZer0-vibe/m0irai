# RESEARCH PASS 2 — DATA + OFFICIAL DOCUMENTS (fills pass 1's quantitative gap)

Collected 2026-07-12 (uxresearch2 lane). Numbers carry source + date + sample size; trust
marked. Full source list at the bottom.

## WHAT THE NEW DATA CHANGES

Pass 1's core claim now has survey-grade backing plus a sharper finding: at scale people
don't review agent-authored changes AT ALL, and the moment they feel most confident is the
moment they're most wrong. Three load-bearing numbers:

- **61.38% of AI-generated PRs receive NO recorded review activity**; 58.77% of reviewed
  ones get agent-only review. (arXiv 2605.02273 — 33,596 AI PRs / 39,122 comments, 2026 ·
  HIGH)
- **93% of Claude Code permission prompts approved unchanged** — Anthropic's own telemetry;
  "approval fatigue." (anthropic.com/engineering/claude-code-auto-mode · HIGH)
- **AI-assisted developers wrote LESS-secure code while believing it was MORE secure.**
  (Stanford Perry et al., ACM CCS 2023, arXiv 2211.03622 · HIGH)

Design consequence: the review surface's job is NOT to make approval frictionless —
approval is already too frictionless. Its job is to RE-INJECT VIGILANCE: surface
risk/uncertainty, make the destructive subset expensive, make undo cheap so the default
"approve" is survivable.

## A — QUANTITATIVE

A1. arXiv 2605.02273 (2026; 33,596 AI PRs; classification validated 96.5% on 800 manual
samples · HIGH): 61.38% of AI PRs no review; 69.9% in shared repos no-or-agent-only; only
8.08% human-only review (vs 25.21% for human PRs — humans review AI code ~3× less). When
humans DO engage: **25.92% of comments are agent-STEERING commands** ("fix this, redo
that") vs 1.63% on human PRs — reviewing an agent is steering, not line-commenting.

A2. Stack Overflow 2025 (n=33,244 on the trust question · HIGH): ~33% trust vs ~46%
distrust AI accuracy (trust FELL year-over-year — "all-time low"); **66% cite "almost
right, but not quite" as the #1 frustration**; 45.2% say debugging AI code takes longer;
75.3% would ask a human "when I don't trust AI's answers." Experienced devs most skeptical.

A3. JetBrains 2025 (n=24,534 · HIGH): 85% use AI regularly; top concern = "inconsistent
quality of AI-generated code"; devs "prefer to stay in control," fears "center on losing
control." (The "46% distrust" figure floating around attributed to JetBrains is conflated
with Stack Overflow's — UNVERIFIED on JetBrains' page; excluded.)

A4. METR RCT (16 experienced OSS devs, 246 real tasks · direction HIGH, magnitude MED after
the 2026-02 revision): AI made them 19% SLOWER while they believed +20% FASTER — the
quantified perception gap.

A5. Anthropic auto-mode (VENDOR TELEMETRY · HIGH): the 93% stat + what they BUILT from it —
a two-stage classifier substitute-approver (fast filter erring toward blocking → CoT pass;
0.4% FPR / 17% FNR published) + **~20 always-blocked rules regardless of context**
(force-push, mass delete, exfiltration, disabling logging, persistence, cloned-code
execution, credential scanning, direct-to-main, prod deploys, curl|bash). The governing
frame, verbatim: **"The classifier has to decide whether the action is something the user
authorized, not just an action related to the user's goal."** And: "one approval isn't a
pattern."

A6. Why review matters (security): Stanford Perry (HIGH, primary): less-secure code +
higher confidence. Secondary-sourced but directionally consistent (each MED individually):
CMU 61% functional / 10.5% passes security review; Georgetown 86% failed XSS; Veracode 45%
insecure-option choice.

## B — OFFICIAL DESIGN DOCUMENTS

B1. Anthropic: don't remove the gate — replace the human at the gate for the low-stakes
majority, keep hard stops for a fixed destructive set. Auto-mode opt-in; "accept edits"
auto-approves FILE EDITS only, still gates shell/side-effects — friction scoped to blast
radius, not uniform.

B2. Cursor (docs · HIGH): live diff view + post-run "Review → Find Issues" + Bugbot on PR.
Official stance: "Your standards for what gets merged should be the same whether the code
was written by hand or by an agent." "The faster the agent works, the more important your
review process becomes." Forum evidence: removing accept/reject read as a BUG.

B3. GitHub Copilot code review (docs · HIGH): posts Comment reviews, NEVER
Approve/Request-changes — "do not count toward required approvals"; AI advises, human
decides. One-click suggested changes, groupable into one commit.

B4. Replit (docs · HIGH): checkpoints = save-points at each agent milestone; ROLLBACK =
one-click restore, bidirectional; assistant diffs auto-close on apply. A mass-market
non-coder platform staking trust entirely on cheap visible undo, not pre-approval review.

B5. Lovable (vendor · HIGH): non-coders review at the OUTCOME layer — Visual Edits on the
live preview, never diffs; "Chat Mode" = a deliberate no-mutation plan/inspect mode. The
non-coder's review question is "what does it DO now," not "which lines changed."

## C — VOICES (fresh)

HN "Vibe Coding Is a Security Disaster": "Don't merge code you don't understand"; reviewer
agents miss "double negative auth checks or race conditions" because "code looks
intentional and clean" — clean diffs suppress scrutiny. Zenn (JP dev): approval "gradually
becomes tedious, leading to reflexively hitting Enter without really looking." Standing
from pass 1: aider "training me to ignore"; Cursor/Windsurf "unusable" without the gate;
Karpathy accept-all-for-throwaways; Willison accountability. HONEST GAP: raw r/ClaudeAI
thread quotes unobtainable via the index — the 93% telemetry outweighs any forum quote.

## D — PRINCIPLES RE-GRADED (+2 NEW)

1. Inline card over fullscreen — VENDOR+MULTIPLE-ANECDOTE (unchanged).
2. Presentation decides whether review happens — part-SURVEY-GRADE now (61%/59% quantify
   avoidance; the aider voice supplies the mechanism).
3. Plain-words summary first, diff on demand — MULTIPLE-ANECDOTE+VENDOR, strengthened
   (Lovable/Replit outcome-layer; SO 66% "almost right" → the summary must flag WHERE it's
   likely wrong).
4. The gate is sacred + granular — MULTIPLE-ANECDOTE strong (two revolts; Copilot grouping).
5. Cheap visible undo = the trust engine — VENDOR strong (Replit bet the product on it).
6. Friction scaled to risk — best-documented: Anthropic's production implementation +
   published error rates + the ~20 always-blocked set + clig.dev.
7. Terminal norms (arrows AND j/k, hints, ?, <100ms) — convention (clig.dev, lazygit).
8. One card per coherent change — the 93% shows N interruptions train reflexive approval.
9. **NEW (SURVEY-GRADE): counteract the confidence gap.** Users are most confident when
   most wrong (Stanford; METR; SO 66%). A clean diff REINFORCES false confidence. The card
   must actively surface risk signals — blast radius, untested surface, destructive
   actions — not present a reassuring "all good." Friction belongs where confidence is
   unearned.
10. **NEW (SURVEY-GRADE): steer > line-comment.** 25.92% of human comments on AI PRs are
    steering directives (vs 1.63% on human PRs). The action set is accept / undo /
    STEER-AND-RETRY — "reject with a reason" IS the non-coder's edit. (zer0's redirect
    round-trip is exactly this, already built and sealed — the data validates it as the
    centerpiece action.)

## CONFLICTS / UNCERTAINTIES

JetBrains trust figures conflated with SO (excluded) · METR magnitude MED post-revision,
direction HIGH · A6 secondary percentages MED individually, pattern HIGH · no raw r/ClaudeAI
quotes (index limitation, compensated by telemetry).

Sources: arxiv.org/html/2605.02273v1 · survey.stackoverflow.co/2025/ai ·
blog.jetbrains.com/research/2025/10/state-of-developer-ecosystem-2025 ·
metr.org/blog/2025-07-10 (+arXiv 2507.09089, rev 2026-02-24) ·
anthropic.com/engineering/claude-code-auto-mode · code.claude.com/docs/en/permission-modes ·
cursor.com/docs/agent/review · cursor.com/blog/agent-best-practices ·
docs.github.com/copilot code-review · docs.replit.com checkpoints-and-rollbacks ·
lovable.dev/blog/introducing-visual-edits · arxiv.org/pdf/2211.03622 ·
news.ycombinator.com/item?id=47479724 · ox.security/blog/vibe-coding-security (secondary).
