# THE INLINE REVIEW — research synthesis (2026-07-12)

The complete dossier: the operator's 5 screenshots (screens/) · gemini advocate v1 + v2 ·
user research pass 1 (voices + conventions) + pass 2 (data + official docs) · the codex
referee verdict (feasibility against the sealed codebase). This file is the one-page
convergence. NOTHING BUILDS from this until the operator reacts and says go.

## WHAT THE INTERNET'S DATA ACTUALLY SAYS (the three numbers that matter)

1. **People don't review agent code.** 61% of AI-written pull requests get no review at
   all; of the reviewed ones, 59% are reviewed only by another bot. (33,596-PR study, 2026)
2. **When asked, people rubber-stamp.** 93% of Claude Code permission prompts are approved
   unchanged — Anthropic's own telemetry. Asking more often produces LESS attention.
3. **Confidence is inverted.** People using AI wrote less-secure code while believing it
   was MORE secure (Stanford); felt 20% faster while measured 19% slower (METR). The #1
   frustration with AI code: "almost right, but not quite" (66%, Stack Overflow n=33k).

So the design goal is NOT "make approval easier" — approval is already too easy. The goal:
**make the five-second glance worth having, make ignoring it survivable (cheap undo), and
spend the user's attention only where the risk is real.**

## WHAT THE SUCCESSFUL PRODUCTS DO (official docs)

- Anthropic: keep the gate, auto-flow the low-stakes majority, ~20 always-blocked
  destructive actions. "One approval isn't a pattern."
- Replit (non-coders): the whole trust model is one-click ROLLBACK to checkpoints — not
  line review. Undo is the product.
- Lovable (non-coders): review at the OUTCOME layer ("what does it do now"), never diffs.
- Cursor/Copilot: the accept/reject gate is sacred (its removal reads as a bug); AI
  advises, the human decides; suggestions grouped into one commit.

## THE DESIGN THAT SURVIVED ALL THREE CRITICS

A review lands → a **premium card appears in the chat, above the input box** (the palette's
visual language). It says, in plain words: WHO changed WHAT (files/lines), what the change
DOES, and its RISK signals (destructive actions, packages, schema, untested surface —
principle 9: the card's job is vigilance, not reassurance). Small diffs can expand right
there, colored and escaped. One key each:

- **Enter/Space = keep** (it's already applied — keep is a real recorded decision)
- **u = undo** (one key, clean rollback — the Replit lesson)
- **c = send a note back** (the steer action — the data says this IS how humans review
  agents [26% of their comments are steering directives]; zer0's redirect round-trip
  already built = validated centerpiece)
- **f = full view** (the existing full screen, demoted to the escalation for big/complex
  reviews)

Answered card → collapses to a one-line receipt in the history ("✓ kept — claude, 2 files,
14 lines"). Unanswered cards → a count in the status bar ("reviews: 2") + /review recalls
them. Nothing pins to the viewport (the terminal can't do that honestly); nothing spams the
scrollback.

Codex's feasibility rulings folded: the card is a dynamic region above the composer
(Static can't collapse); the card carries its reviewId (fixing the @all race that exists
TODAY); one input-ownership model (no second key system); keep-on-ignore only as an
opt-in low-risk rule, never a silent default (a keep must be a real DB decision).

## WAVE SIZING (codex): ~9 tasks, 2 waves. Reuses the ENTIRE sealed engine

(capture/grouping/decisions/undo/redirect/escaping); retires only the presentation.

## THE FIVE QUESTIONS — NOW WITH COMPETITOR-GROUNDED RECOMMENDED ANSWERS

(full evidence: competitor-answers-pass3.md; the operator confirms or overrides each)

1. A review arrives while you're typing → **RECOMMENDED: it waits quietly in the counter;
   never interrupts; auto-keep for low-risk exists only as an explicit opt-in.** (STRONG —
   Aider/Copilot/Claude-Code converge; "queue, don't interrupt" is a top user request.)
2. Three agents finish at once → **RECOMMENDED: RISKIEST first** (newest as tiebreak,
   grouped by task). (MODERATE — no competitor does this; a deliberate zer0 original: spend
   the non-coder's attention where the risk is.)
3. "Undo" means → **RECOMMENDED: THIS group of changes** (the card's own change-set);
   "undo the whole turn" available as a secondary action in full view. Undo must be
   COMPLETE — including tool/terminal-driven file changes (Claude Code's own rewind misses
   those; bolt proves lossy undo destroys trust). (STRONG)
4. Huge generated files → **RECOMMENDED: summary first + collapsed diff you can expand +
   a one-key "ask the agent to split it."** (STRONG for summary+collapse — GitHub+Lovable;
   the split key is a zer0 original no competitor offers.)
5. Risky changes in full-auto → **RECOMMENDED: YES — a fixed, UN-REMOVABLE hard-stop set
   (package installs, deletes of pre-existing files, schema/DB changes, force-push,
   deploys) always requires the operator's key press; users may widen auto-approval,
   never narrow the stops.** (STRONG — Claude Code's non-overridable deny layer, Cursor's
   denylist→allowlist security reversal, and the Replit production-database incident all
   converge.)
