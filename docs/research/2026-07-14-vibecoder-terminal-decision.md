# DECISION DOCUMENT — "The First Terminal for Vibe-Coders" (2026-07-14)

Three independent research rounds, synthesized: Fable (market data, web-sourced) ·
gemini (community deep-dive, live search; fabrication-checked) · codex (strategy +
feature-gap analysis against OUR repo, prices live-checked 2026-07-14). Raw outputs:
vibecoder-research-{gemini,codex}-out.md in the session jobs directory. The operator
decides; this document exists so the decision rests on evidence, not vibes.

## 0. THE FRAMING LOCK (operator, 2026-07-14 — overrides any competing framing below)

zer0 is NOT a web builder and NOT a Cursor competitor. It is an INTERFACE: Claude Code,
Codex CLI, and gemini-cli are the engines, and all three ship interfaces built for
coders — zer0 is the interface onto those SAME engines built for vibe-coders. The
comparison set is therefore the native CLI interfaces themselves, nobody else. Lovable/
Bolt data in §1-§2 describes WHO THE USERS ARE and where they come from — not what we
build or compete with. Consequences folded through this document:

- The "deploy gap" (§5) is NOT ours to build as a platform: the agents can already run
  deploy CLIs (vercel/netlify/wrangler); the interface's job is a guided plain-words
  flow over the agents doing it — interface, not infrastructure.
- The "hosted willingness-to-pay" bear (§6.2) dissolves differently: zer0 is free/
  Apache-2.0 (the 0.1 roadmap); the user already pays the agent subscriptions; the
  near-term goal is adoption of the INTERFACE, not revenue capture.
- The funnel intercept (§7 wedge 2) sharpens: when a Lovable-wall user is told "learn
  Claude Code" and bounces off its developer interface, zer0 is the interface they land
  on instead — same engine, different front door.

## 1. The market (sourced numbers)

- Lovable: $500M ARR, ~8M users, 146 staff, $6.6B valuation — and 80% OF ITS BUILDERS
  ARE NON-TECHNICAL; 100k new projects/day (thenextweb.com build-economy report;
  getpanto.ai stats roundup).
- Cursor: $1B ARR, ~1M DAU, 360k paid (SaaStr/Inc, early 2026). Bolt: $40M ARR in 6
  months. Replit: projecting $1B ARR (computer.org). Base44 → Wix for $80M.
- Anthropic's OWN non-engineering teams (legal/marketing/design/finance) use Claude
  Code; a marketer with zero CLI history shipped a working Figma plugin in week one
  (mindstudio.ai writeups of Anthropic's internal patterns).
- The population has a name, a founding moment (Karpathy, 2025-02-02), dedicated
  subreddits, a creator/tutorial economy, and multi-subscription spending habits
  ($20-100/mo across 2-3 tools is normal).

## 2. The pain (community evidence, gemini + Fable, cross-checked)

- THE DEFINING EXPERIENCE has a community name: the "fix and break" cycle — fix the
  filter, the table breaks; fix the table, login breaks. It is why non-coders churn.
- THE DISASTER FILE: 11% of 20k scanned indie apps leak Supabase keys (HN 46662304);
  ~70% of Lovable apps ship with RLS off; Moltbook leaked 1.5M credentials from ONE
  missing setting; Lovable itself: 3 breaches in 13 months, one exposing every user's
  source + credentials; Replit's agent wiped a production DB against instructions.
- THE GRADUATION WALL: when Lovable/Bolt users outgrow the builder, the documented
  "next step" is Cursor — "an AI editor for people who already code." The funnel's
  next rung is missing for 80% of the population.
- The top-10 ranked pains (gemini's community sweep): auth failures · terminal/git
  terror · database migrations breaking apps · dependency hell · spaghetti-debt they
  cannot read · the honeymoon crash · cost opacity · "I didn't know what to describe."

## 3. The verdict on "would they use a terminal?" (all three, independently)

CONVERGED: **yes — but only if it does not look or act like a terminal.** Gemini: they
reject a raw shell but "embrace an 'Agentic Command Center' if it hides the syntax."
Codex: "a guided cockpit, not a shell — the product loses before the agents speak if
the first screen is npm/Node/git/stack-traces." The against-evidence is equally firm:
abstraction leaks (raw node errors, paths) cause rage-quits; local-agent train wrecks
have made them wary; terminals trigger imposter syndrome. THE PRODUCT WE ALREADY BUILT
— the cockpit, cards, plain-words PRD, undo, three-agent verification — IS the shape
all three rounds describe. What's missing is packaging, not architecture.

## 4. The quadrant (codex's map, prices live-checked)

Developer-first × terminal: crowded (Claude Code, Codex CLI, gemini-cli, aider, Warp,
Amp, opencode). Vibe-coder-first × web: crowded and rich (Lovable, Bolt, v0, Replit,
Base44). **Vibe-coder-first × terminal: NO CATEGORY OWNER.** Both readings taken
seriously: empty-because-unpackaged (the honest bridge when apps become real) vs
empty-because-structurally-bad (terminals repel the audience). The tiebreaker is §3's
converged answer plus Anthropic's internal non-engineer adoption as existence proof.

## 5. The feature-gap table (codex, against OUR repo at file:line)

STRONG TODAY: undo machinery · quota/capacity foundation · security base (secret
filter, hard-stop risk model, fail-closed unknown) · multi-agent trust story ·
review-cards-not-diffs · subscription-first zero-API-keys · Windows-native.
PARTIAL: plain-language surfaces (the PRD fixes the cockpit; README/CLI/raw errors
still leak dev-speak) · error translation · git abstraction (worktrees hidden; the
language isn't "snapshots/restore points" yet) · "is it working" verification (gates

- cross-family exist; no live preview/browser-smoke receipts for non-devs).
  MISSING (the big three): (1) DEPLOY — "my app is live at a URL" is the currency of
  this audience; the MVP explicitly excludes it; minimal honest answer = guided
  Vercel/Netlify/Cloudflare flows + env-var wizard + rollback. (2) ONBOARDING — npm i
  -g + Node + git + per-agent auth is fatal for true non-devs; needs an installer/wizard.
  (3) LIVE APP VERIFIER — the agent opens the preview, tests login/core flow, screenshots,
  and says what passed in plain words.

## 6. The bear case (kept whole — the operator asked for the bad)

1. Terminals repel the audience (survival: install like a normal app; cockpit never
   behaves like a shell). 2. Willingness-to-pay concentrates in hosted products
   (survival: deploy flows, or become the repair/upgrade layer after the builders).
2. Support burden of non-devs explodes (survival: refuse unsafe tasks; opinionated
   narrow stacks). 4. Liability of empowering non-devs (survival: be famous for saying
   NO before dangerous ships). 5. Web builders add pro-mode faster than we add easy-mode
   (Lovable already has GitHub sync; survival: the trust layer must beat "open in VS
   Code"). 6. "Vibe-coder" as identity may fade (survival: bet on the durable behavior —
   intent-first builders who cannot verify code — not the slang).

## 7. The wedge ranking (codex; gemini's evidence supports 1-3)

1. "Three AIs changed it, checked it, and you can undo it with one key." (the viral line)
2. "Paste your broken Lovable/Bolt/Replit app; zer0 fixes it and proves it works."
   (the graduation-funnel intercept — meets them at the moment of pain)
3. The live app verifier ("I tested login and checkout — both work; here's the picture").
4. Cost autopilot across the three subscriptions. 5. Windows-native cockpit.

## 8. THE RECOMMENDATION (codex's verdict; Fable concurs; operator decides)

**Dual-audience now; the vibe-coder story as the 0.1 wedge; full pivot only after
onboarding + error translation are real (deploy = guided flows over the agents' own
CLIs, per §0).** Public line candidate, rewritten under the §0 framing lock:

> "You already pay for Claude, Codex, and Gemini. Their interfaces were built for
> coders. zer0 is the one built for you — three AIs on one project, checking each
> other's work, with one-key undo."

Do NOT pretend terminals are beginner-friendly; make the honest claim: when AI-built
apps become real enough to break, leak, cost money, or need deployment, zer0 is the
interface that makes the dangerous parts understandable.

Riskiest assumptions: (1) plain language is enough to neutralize terminal stigma;
(2) hosted builders don't close the trust gap first; (3) three-agent trust is legible
enough to beat single-agent simplicity.

## 9. 30-day falsifiable metrics after 0.1 (pass/fail, no vibes)

- 20 non-dev users install → auth → first safe change WITHOUT founder hand-holding
  (fail: >40% die before the first agent run).
- ≥30% of new users arrive with Lovable/Bolt/Replit repos or problems (fail: users are
  devs comparing us to Claude Code).
- Review/undo used in most successful sessions; users explain "what changed" in their
  own words (fail: they ask for raw code or churn on no hosted URL).
- Guided deploy gets 10+ apps live, zero severe incidents.
- Users describe it as "AIs checking each other" (fail: "complicated terminal with
  three bots").

## 10. Roadmap impact IF adopted (folds into the 0.1 ladder, replaces nothing sealed)

NEW 0.1 requirements: packaged installer/setup wizard (kills the npm wall) · error
translation layer (no raw stack trace ever reaches the operator) · the review-permission
PRD ships as designed (it IS the vibe-coder trust surface). NEW 0.2 candidates: guided
deploy flows + env wizard · the live app verifier · "fix my Lovable app" onboarding
flow (repo import + health check + plain-words report). UNCHANGED: the loop (0.3), the
five loop upgrades, T-FINAL, memory, the sealed engine. The positioning line changes
README/site copy, not architecture.

---

# THE VERDICT (operator, 2026-07-14): VIBE-CODERS FIRST, DEVELOPERS SECOND. ADOPTED.

Stronger than §8's dual-audience recommendation — the operator chose the full ordering.
Binding consequences:
- Positioning line adopted (§8's rewrite under the §0 framing lock).
- 0.1 gains two REQUIREMENTS: the packaged installer/setup wizard (the npm wall is
  fatal to the first audience) and the error-translation layer (no raw stack trace or
  tool error ever reaches the operator surface).
- The review-permission PRD (docs/specs/2026-07-14-review-permission-prd.md) IS the
  vibe-first trust surface — proceeds as designed. Derived under this positioning:
  chip names REVIEW/AUTO/PLAN (plain single words) with gemini's promise-sentences as
  help copy; AUTO's hard-stop boundary STAYS (a vibe-first product that lets a
  non-coder silently ship the Moltbook class violates the positioning itself — §2's
  disaster file is the evidence).
- Every future surface decision tie-breaks toward the non-coder; developer affordances
  (raw diffs, traces) live one keypress deeper, never default.
- The 30-day metrics (§9) become the 0.1 launch scorecard.
