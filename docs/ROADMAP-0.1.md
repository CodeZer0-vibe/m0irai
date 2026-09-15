# zer0 chat — the road to 0.1 (locked 2026-07-04, operator + coordinator)

The ladder of record for the first public release. Every item here was decided in the
2026-07-04 session; the per-decision detail lives in `.council/findings.md` (§RELEASE DECISION,
§RELEASE LADDER AMENDED, §LADDER ADDITION, §FIRST-RUN+BROWNFIELD, §PARTIAL-TEAM, §BACKLOG UNIT).

## Positioning (the sentence everything serves)

**Three agents, one team, one memory — terminal-native on Windows.**

The competitive sweep (same day) confirmed: every neighbor (CliDeck, CodeAgentSwarm, JetBrains
Air, Claude Squad, VS Code agent sessions) runs agents in SEPARATE sessions with a dashboard on
top; the nearest neighbor (agentpipe) shares a room but the agents only talk (round-robin chat,
no tools, no brain, no conductor). The empty seat we own: the CONDUCTED WORKING team + the
SHARED BRAIN, terminal-native, Windows-first. The room is not the moat; the team and the brain are.

## Release decisions (final)

- **FREE, open-core.** Apache-2.0. GitHub Sponsors on from day one. Monetize LATER, on top of
  traction, via the layer above the free core: cross-machine brain sync, team features,
  remote/mobile, hosted loop runs. Revisit at a real signal (~1k stars / strangers requesting
  team features).
- **One complete wave per public release** (the NO-MVP standard applied to shipping): 0.1 as
  below → **0.2 = diff-review HERO** → **0.3 = the loop**. Each release = changelog + post;
  build speed becomes marketing.
- **The chat context model = native persistent sessions (operator decision, 2026-07-04).**
  Research (docs/research/2026-07-04-cli-context-architectures.md) confirmed all three official
  CLIs keep one continuous conversation, re-sent whole each turn (~99% prompt-cache hit observed
  on codex) and bounded by native auto-compaction. zer0 adopts the same: ONE persistent native
  session per agent per project (claude engine session / codex thread / agy conversation),
  DELTA-ONLY room injection (only what happened since that agent's last turn), the journal
  briefing re-carried after detected compactions, and bounded one-shots RETAINED for
  councils/debates/reviews (isolation is the feature there). MT7 upgrades from "flag,
  nice-to-have" to the target architecture: flag-first → dogfood-proven (meters watch quota) →
  default before 0.1. The 8-message window dies as a chat mechanism.
- **Memory is project-scoped in v1** (already built + fixture-proven: no cross-project leakage).
  Cross-project lessons = a v2 unit: EXPLICIT promotion only (`/anchor --global`-style), global
  entries visibly labeled, demotable. Never automatic.

## The 0.1 blockers, in order

1. **MEMORY-FULL through FINAL** + the operator stamp. In flight (worktree `zer0-memory`,
   plan rev 2.2): MT1-MT3 sealed; MT3b/MT3c closing codex findings + gate clamps; then MT4
   projections → MT5 briefing (codex + L3-sec mandatory) → MT6 router/read-proofs → MT7
   resume + compaction — UPGRADED to the target chat architecture (native persistent sessions +
   delta injection + compaction re-carry; needs its own spec/plan delta; operator-flagged) → FINAL e2e. Acceptance
   stays the operator's line: a fresh thread recalls the jobs conversation unprompted.
2. **The live-fix stamp.** The 2026-07-04 wave (input fold, history attribution, unknown-@,
   arrival-order feed) is sealed at codex SHIP IT ×2; the operator's live re-test checklist is
   open (topic file §LIVE-FIX).
3. **THE DOGFOOD GATE (operator-added, non-negotiable).** No release until zer0 survives REAL
   WORK: the operator works THROUGH zer0 on ≥2 real projects (one established + ideally one
   greenfield), ZER0_DEBUG=1 always; every bug gets the #a825 pipeline (trace → root cause →
   TDD fix wave → codex). **The memory week:** ≥7 consecutive days; PASS = fresh sessions know
   prior decisions unprompted · ZERO wrong/stale facts in briefings (the dangerous failure
   class) · anchors survive everything · cross-project isolation holds in real 2-project use ·
   site.md reads well as a human file. EXIT = a clean 7-day stretch, zero unresolved BLOCKs,
   zero false-memory incidents; an ugly day-6 find restarts the clock after its fix.
4. **THE FIRST-RUN + BROWNFIELD WAVE** (builds in PARALLEL with the dogfood — it does not
   perturb daily use). Established repos are the MAJORITY adoption path. Scope:
   - **Doctor preflight**: per-agent detection — installed? logged in? version? — with exact
     install/login commands; LISTS detected MCP servers / skills / commands per agent
     (visibility, not import — the native CLIs already load their own).
   - **Trust-workspace prompt**; consent-gated doorway writes (managed blocks in THEIR
     CLAUDE.md/AGENTS.md/GEMINI.md — explicit yes, cleanly removable); auto-gitignore `.zer0/`.
   - **No-git grace**: boot currently hard-fails without a resolvable HEAD — offer `git init`
     or a reduced gitless mode.
   - **Collision detection**: existing hooks/statuslines/MCP servers load into our lanes (the
     class that once looped our own headless runs) — detect + warn, flag known transport
     conflicts.
   - **Zero shipped role opinions (operator principle)**: remove ALL keyword leans (build→codex,
     research→gemini) and the hardcoded claude default — the user's addressing IS the routing; the
     wizard asks "who's your main agent?" ONCE (their answer = the un-addressed default, changeable);
     preference config (defaultBuilder/defaultReviewer) and capacity-aware routing (route to quota
     headroom) ship as OPT-IN toggles, off by default. Our internal codex-review discipline is a
     workshop rule, never shipped product behavior.
   - **Partial-team mode — from ONE subscription up** (deep cuts): rosters DERIVE from the
     available set (ALL_AGENTS / DEBATE_AGENTS / the teamSetup "one of three" literal all
     hardcode 3 today); @all = the present set; the preamble degrades (2-agent team / sole
     agent); intent routes fall back to available agents, never a dead lane; headcount-gated
     features (debate, cross-review, synthesis) fail HELPFULLY ("add a second agent to
     unlock"); meters/journal files only for present agents. Framing: the adoption funnel —
     zer0-with-1-agent must be that agent's best cockpit; every unlock notice sells the next
     chair.
   - **The setup wizard**: default = the user's existing agent setup (zero surprise); option =
     DEDICATED zer0 agent profiles (config-dir isolation from project hooks; prior art = the
     clean ACP CLAUDE_CONFIG_DIR; known catch: logins live in config dirs → credential
     carry-over or one extra login).
   - **Automated project discovery (the headline)**: after trust, one consent-gated, READ-ONLY,
     budgeted pass (README / structure / git history / existing agent files) SEEDS the journal
     work-map, every entry provenance=discovery, visible and deletable — a warm brain in the
     first minute of a two-year-old repo. Subsumes "handoffs/tracking".
   - **The question-card primitive**: keyboard-first options + ALWAYS a write-in/"chat about
     it" escape + a confirm beat (designed against the operator's own 3-misclick experience
     with Claude Code's picker). Built HERE because the wizard steps ARE structured questions;
     reused later by the full question system.
   - Wave spec runs the standing user-interest critique (gemini = user advocate, codex = logic
     referee) BEFORE L-1 — onboarding is peak grain-mismatch territory.
5. **Release hygiene**: Apache-2.0 LICENSE; README with a terminal GIF, a 3-command quickstart,
   and "runs on YOUR subscriptions — no API keys" as the hero line; package fields
   (repository/bin/version 0.1.0); a sweep guaranteeing local artifacts (.zer0/, .council/,
   debug folders) can never ship or be committed.
6. **Small opens to close**: synthesis default; the ACP per-cwd edge; the three one-line
   follow-ups already logged (persist-pin, dispatch.sh salvage verdict, chrome-overflow at
   ≤20 rows).

## Launch-adds (a day each, slotted during the dogfood)

- Finish-notifications (an agent completed while you're in another window).
- Empty-screen starter prompts (3 suggestions — kills the blank-cockpit moment).
- Update-available notice line.
- Scrollback wayfinding (operator, 2026-07-09): clickable own-message anchors + "N new message (ctrl+End)"
  pill + jump-to-live key — needs its research spike first (viewport awareness vs the normal-buffer
  renderer; check gemini-cli/Claude Code prior art); detail in findings §BACKLOG (2026-07-09).

## Post-0.1, each as its own public release

- **0.2 — diff-review HERO** (the full review experience; launch-week content).
- **0.3 — the loop** (the multi-model build-verify loop; the moat's second act — the
  competitive sweep confirms no analogue exists anywhere).
- **The question system, full**: agents pause a lane on operator-only decisions and raise the
  question card mid-turn (product decisions only — the decision-boundary taste rule baked in;
  claude via native ACP question requests, codex/gemini via a teamSetup question-block
  protocol; one card, three sources).
- **Memory v2 — global promotion**: the explicit cross-project lesson tier.
- Remote/mobile, plugins, themes: the polish checklist the dashboard competitors already
  proved demand for.

## Standing facts worth re-stating (verified this session)

- Transports: claude + codex over ACP by default (`dispatch-acp.ts:39`; `ZER0_ACP=0` = the pty
  escape); gemini/agy on pty until it ships ACP.
- Auth: zer0 handles NO logins by design — each CLI's own on-disk account, zero API keys
  passed (the subscription-first boundary); boot probes `--version` fail-closed into the
  status-bar auth glyphs. The doctor turns this from silent glyphs into guidance.
- Today's state: chat-tested only ("we only chatted") — the dogfood gate exists precisely
  because unit-green ≠ live-working, and one hour of live chatting found three real bugs.

## AMENDMENT — 2026-07-14/15 (the vibe-first pivot + the trust-layer pull-forward)

Appended, never rewriting the locked ladder above. Operative sequencing lives in
docs/plans/2026-07-15-wave-plan-to-product.md; the working doc for codex-direct building is
docs/plans/2026-07-15-HANDOFF-build-with-codex.md (REVISION 1 binding).

1. POSITIONING LOCKED (operator, 07-14): VIBE-CODERS FIRST, developers second — zer0 is the
   vibe-first INTERFACE onto the three dev-first CLI engines. Public line: "You already pay for
   Claude, Codex, and Gemini. Their interfaces were built for coders. zer0 is the one built for
   you." 0.1 GAINS TWO REQUIREMENTS: the agent-installable installer + the error-translation
   layer (no raw stack trace ever reaches the operator).
2. THE TRUST LAYER PULLS FORWARD INTO PRE-0.1 (live dogfood forced it): the resume-card session
   boundary (W2) · universal write capture in every chat mode (W3, closes PRD hole H1) · the
   PARALLEL unlock (W3: the global write queue retired — build-confirm becomes a risk gate
   only; per-agent review ids; same-file overlap = conflict cards) · the REVIEW/AUTO/PLAN mode
   surface with REAL agent permissions + the morning inbox (W4). CONSEQUENCE FOR 0.2: the
   diff-review HERO release becomes the polish + depth pass on this foundation (its old
   one-writer/write-lease §6 locks are SUPERSEDED by the parallel model; difftastic vendoring +
   approve=keep stand).
3. THE LOOP SPLITS INTO TWO MILESTONES: the integrity substrate + dogfood-needed upgrades build
   PRE-0.1 (wave W5: content-addressed candidate, cwd assert, portable gates, verdict schema,
   partial-team pairing, rich templates); 0.3 remains the loop's PUBLIC RELEASE as laddered
   above.
4. NEW STANDING LAWS (operator, 07-15, bind all waves): POWER ON REQUEST (team orchestration
   fires only when asked; partial-team first-class; the capture/undo safety net always-on) ·
   the DEBUG TRANSPARENCY CHARTER (boundaries verbatim, no censoring diagnostics, per-session
   self-state header) · runtime SELF-INTEGRITY (patch receipts verified at boot; plain-words
   degraded-feature notices; auto-refit on clean drift, never silent self-upgrades).
5. ADDED TO THE PRODUCT WAVES (W7a/b, from the 07-14/15 rounds): the "zer0's agents" tab
   (per-message expert modes, tags/sub-tabs, inline fast-lane + suggestion chips) · the
   first-run keep-your-files-vs-zer0-defaults choice (interactive, never silent) · automatic
   team-turn procedures (council etiquette / handoff / review contracts injected by turn type —
   never user-loaded) · native command parity (C3a: adapter-advertised commands, verified
   feasible against the installed adapters).

## AMENDMENT 2026-07-16 — the great simplification (operator-locked, one live-test day)

One day of real dogfooding rewrote the trust layer's shape. Standing rule that produced it:
DISCUSS → LOCK → BRIEF → REFEREE → BUILD; nothing builds from a half-discussed idea. Every
lock below is ledgered in .council/findings.md (2026-07-16) with the full reasoning.

1. W2 RESHAPED TWICE, THEN DESCOPED TO ITS CORE. The resume-card consent machine (entity,
   card, /unfinished, decay — five hostile-review rounds, built and working) was SCRAPPED on
   first operator contact: a boot card demanding decisions is an Enter-trap, and a fresh
   plain-language instruction is a better consent mechanism than any card. What ships instead
   is THE BOUNDARY WAVE (in flight on wip/boundary-wave): prior-session instructions reach
   agents as untrusted CONTEXT, never as orders — plus the junk-review exclusion and the
   honest review banner. Resume after a crash = /resume (the existing session picker) + telling
   the team "continue" in plain words. The scrapped build is archived (jobs tmp w2-archive/);
   its review-hardened fragments seeded the boundary wave.
2. W3 IS NOW "THE GREAT DELETION" (supersedes this file's 07-15 point 2 and the R3/R4 build
   design). Three-way convergence (operator instinct · coordinator · codex referee C1+C2 @78%):
   zer0 stops building a second change-record next to git. DELETE the write queue + lease +
   confirm-token + capture/checkpoint machinery (~3,100 lines; the source of every live failure
   this week). KEEP git as THE record (zer0 already forces git init + first commit at launch).
   ADD: a plain unqueued y/n confirm for destructive actions · a one-line receipt after
   writable turns derived from git ("claude changed 3 files") · /review as a plain git readout
   + cross-agent review. Undo = agent-guided, honestly approximate; the exact capture substrate
   may EARN its way back post-dogfood if demand shows. CONSEQUENCE FOR 0.2: the diff-review
   HERO becomes cross-agent review + plainly-presented git diffs + receipts — less magical
   rollback, more understandable truth. Brief: jobs tmp w3-deletion-brief.md (refereed
   AMEND-AND-PROCEED 84%; fold pending: receipts are TURN-level — git cannot attribute
   per-agent under parallel writes).
3. W4's MODE SURFACE = NATIVE MAPPING (supersedes the review/permission PRD's zer0-side
   enforcement): Shift+Tab cycles each agent's own native modes — plan/read-only · ask/approve-
   edits (the agent's native question surfaced as a plain y/n) · auto — "or what each one
   supports," mapped honestly per engine. The one build: native permission-request pass-through
   over the transports. Per-engine mode verification REQUIRED before the brief. Still open for
   W4's design round: the boot greeting (facts-vs-narrative), the team task list, the review
   surface in the git world.
4. THE 07-15 STANDING LAW "capture/undo safety net always-on" is AMENDED accordingly: the
   always-on seatbelt is now (a) the session boundary, (b) git-as-record with receipts, (c) the
   destructive confirm. Power stays on-request; nothing else changed in the laws.
5. PROCESS LOCKS from the day (bind all future waves): builders CHECKPOINT-COMMIT per round on
   wip/<wave> branches (a context-death + a deliberate revert both proved the need) · Fable is
   mechanically BANNED as a subagent model (guard hook, live-proven) · referee dispatches are
   always referee-framed · the wave plan of record for W3+ is the ledger + briefs until the
   wave-plan doc is rewritten at the W3 seal.
