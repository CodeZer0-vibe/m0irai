# SESSION STATE — everything discussed + locked, 2026-07-14

The authoritative snapshot of this session's decisions. Supersedes scattered notes.
Sealed commits this session: stabilization @f6e1bdb · dogfood round @8d934bd · T-FINAL
lane 1 @15aa64a (all on the 0.3/dogfood line, HEAD @f6e1bdb + uncommitted docs/plans).

## 1. POSITIONING — LOCKED: vibe-coders first, developers second

- zer0 = the INTERFACE onto Claude Code / Codex CLI / gemini-cli, built for people who
  direct AI but can't read code. NOT a web builder, NOT a Cursor competitor, NOT an
  editor. The engines' own interfaces are dev-first; ours is the vibe-first front door.
- Public line: "You already pay for Claude, Codex, and Gemini. Their interfaces were
  built for coders. zer0 is the one built for you — three AIs on one project, checking
  each other's work, with one-key undo."
- Evidence base: docs/research/2026-07-14-vibecoder-terminal-decision.md +
  2026-07-14-vibecoder-r2-feature-discovery.md (3-source research; Lovable $500M ARR /
  80% non-technical; the "fix-and-break" churn; the leaked-keys disaster file; the
  graduation wall). 30-day launch scorecard = the decision doc §9.
- Deploy = guided flows over the agents' OWN CLIs (interface, not infrastructure).
- Every surface tie-breaks toward the non-coder; dev affordances one keypress deeper.

## 2. NEW 0.1 REQUIREMENTS (from the positioning)

- INSTALLER: agent-installable — `npm install -g github:<repo>` (or npm registry) then
  `zer0 chat`; the README's first line is the paste-able prompt any coding agent runs to
  install (handles Node/PATH). Needs the GitHub repo created (operator's action — never
  pushed without operator). Small-effort once the repo exists.
- ERROR TRANSLATION: one boundary layer so NO raw stderr/stack trace ever reaches the
  operator surface; every failure = plain summary + one action + "details saved".

## 3. REVIEW & PERMISSION SYSTEM — PRD (docs/specs/2026-07-14-review-permission-prd.md)

- Shift+Tab cycles REVIEW / AUTO / PLAN (retire user-facing OFF).
  REVIEW = every change is a card. AUTO = changes apply, no cards, still recorded+undoable,
  EXCEPT hard-stops (packages/schema/deletes/secrets) still interrupt once. PLAN = talk
  only, no writes.
- Invariant: EVERY write by any agent, any mode, is captured+undoable; unreviewable write
  blocks the next dispatch (closes the plain-chat-write hole).
- Card = agent's own words first, decision state second, never counts/paths/hunks.
- Morning inbox: newest N per recent sessions, older archived (closes the boot pile).

## 4. "zer0's agents" PALETTE — naming LOCKED (docs/specs/2026-07-14-template-palette.md)

- Native `/agents` STAYS AS-IS (lists the agent's own subagent roster). Untouched.
- NEW tab in `@agent /` palette: "zer0's agents" (`Commands · Skills · zer0's agents`) —
  our curated expert configs + the user's own. Possessive disambiguates the collision
  (supersedes the Roles/Playbooks rename). More on-brand, more vibe-first.
- Behavior: per-turn stage-into-composer (default) + explicit PERSISTENT per-agent loadout
  (the "preloaded" model), session-scoped, ALWAYS VISIBLE in chrome (`@codex: reviewer`)
  with one-key clear. Never mutates standing files/memory — prompt-composition layer only.
- ~7 sharp built-in defaults from the v23 skeletons; NOT a marketplace. agent-aware
  frontmatter soft-filters. INTERACTIVE COMMANDS = Approach B (operator "b"): fetch each
  agent's command surface + render in zer0's OWN unified UI (the palette + model-pickers
  already prove it), NOT native-picker handoff.

## 5. PROMPT-QUALITY REDESIGN (docs/plans/2026-07-14-prompt-quality-redesign.md)

- Two artifact classes: standing session files ≤200 lines; per-dispatch loop templates
  rich/procedural (100-300 dense lines, like the production prompts measured — Claude Code
  8,724 words etc).
- NO role lanes anywhere (the persona literature + every production artifact + operator
  law). KEEP: ONE-line capability anchor, register/format control, per-agent FAILURE-MODE
  guards, cross-family behavioral divergence. Hostility framing ONLY for cross-family
  reviewer (not builder self-review).
- Architecture: one shared core IMPORTED by CLAUDE.md/AGENTS.md/GEMINI.md (codex's
  AGENTS.md-as-source + imports — supersedes the generate-and-checksum approach) + tiny
  per-agent appendix. User customization = the "zer0's agents"/personas library + a locked
  safety block appended last (validator rejects overrides).
- v23 house templates = the strongest MATERIAL found anywhere (BAD/DAMAGE/GOOD triads,
  forced sentence stems, incentive framing, YELLOW-default calibration) — the loop
  templates build ON that skeleton. Wording gated by behavioral evals (promptfoo), not
  taste.
- Verifier gets a rich findings schema (result pass/fail/uncertain + confidence +
  findings[file:line,evidence] + notVerified + requiredFix), fail-closed to uncertain.

## 6. THE LOOP (Track B — separate from the interface track)

- Field-validated (docs/research/2026-07-14-loop-field-validation.md): architecture
  CONFIRMED vs Anthropic doctrine; cross-family verify is NOVEL (ours alone).
- 5 upgrades (docs/plans/2026-07-14-loop-upgrades.md, build-ready): U1 verifier-uncertainty
  pause · U2 anti-gaming diff policy · U3 mid-run steering (crash-safe ledger + loop-card
  key) · U4 cumulative fuel telemetry · U5 failed-approach ledger. Plus U6
  availability-aware pairing (2-agent combos: builder/verifier swap; 1 agent = honest
  refuse) · U7 loop templates = the redesign's per-dispatch templates.
- REORDER (codex's open-round finding): 3 loop-INTEGRITY P0s outrank the upgrades AND the
  prompt redesign — (P0-1) verifier not mechanically read-only: reviewed/gated tree can
  differ from applied patch; (P0-2) carrier/native-resume can bind a loop agent to the
  MAIN repo cwd not the worktree; (P0-3) `/loop` hardcodes zer0's gates (not portable +
  builder can edit its own reward tests). NEW ORDER: loop-integrity round (candidate =
  content-addressed hash; reviewer fresh+discarded; cwd asserted; gates repo-configurable)
  → loop-upgrades → prompt redesign.
- T-FINAL lane 2 (5 real-CLI E2E legs + N-1) stays QUOTA-GATED on operator go (needs
  Claude quota); tests/e2e/loop/** uncommitted until run.

## 7. TERMINAL — reverse-engineered (Claude Code binary + gemini-cli source)

- Shift+Tab: Claude Code uses WIN32-INPUT-MODE (CSI ? 9001 h) on Windows — works in
  Cursor/WT/ConPTY. Our kitty-only fix was the wrong protocol for Windows (kitty works in
  Windows Terminal, DEAD in Cursor — operator confirmed live). REAL FIX: win32-input-mode
  - parse its key encoding; kitty/modifyOtherKeys only as mac/linux path; typed-command
    fallback everywhere.
- Alt-screen: Claude Code uses ?1049h (alt-screen buffer) — validates the "scar" reopen
  as the answer to the scrollback/full-screen ask. Build it properly, opt-in, live-proven.

## 8. PROCESS LOCKS (memory-backed)

- CODEX = the builder (quota lock, [[codex-builder-quota-lock]]); topology = Fable plans →
  codex reviews plan → codex builds → Fable reviews build. NO Claude subagents.
- Research briefs give FREEDOM (mission + materials + "your conclusions"), never the
  coordinator's verdicts/laws-to-confirm; Fable's view enters at synthesis
  ([[user-interest-critique]] addendum). Hostile REVIEW briefs are the exception.
- gemini gets screenshots on any UI question (multimodal). NO git stash ever. Serial
  sweeps, unmasked exit codes. Never push to GitHub.

## 9. SEQUENCING (the whole board)

PRIMARY NOW: operator dogfooding + stabilization (the debug flight-recorder round —
docs/plans/2026-07-14-debug-flight-recorder.md, codex authored the brief, awaiting Fable
review) so real testing has max evidence capture.
THEN Track B: loop-integrity P0s → loop-upgrades. Track A (interface): the terminal round
(win32-input-mode + alt-screen), then the prompt/agents redesign (incl. the zer0's agents
palette), then the vibe-first waves (installer, error translation, restore/preview/publish).
Desktop-app spike (own window, same engine) = a parked 0.2 bet.

## LATE UPDATES (2026-07-14 evening) — supersede §7 terminal + refine §3 permission

### MASTER PLAN: BUILT + CODEX-REVIEWED ✓
docs/plans/2026-07-14-MASTER-execution-plan.md written, codex reviewed it (5 orchestration
fixes folded as REVISION 1 = the operative sequence). Confirmed: the plan-to-fix-everything
exists and is codex-vetted. Operative order: MILESTONE A (terminal input + debug recorder,
parallel) → B0 loop-integrity PLAN (Fable writes, codex reviews — the START-NEXT) → B loop
(integrity build → upgrades U1-U7) → C trust surface (review/permission PRD · standing-files
prompt redesign · "zer0's agents" palette) → D onboarding (error-translation FIRST, then
first-run/installer/restore-preview-publish/alt-screen). Three guards: B2 owns the verifier
schema; C1 ships loop-write-path regression tests; error-translation leads D.

### TERMINAL — Shift+Tab root cause CORRECTED (supersedes §7's win32 claim)
NOT structural, NOT native-addon: it's the NODE VERSION. Node 20 (old libuv) collapses
Shift+Tab to 0x09; Node ^22.17+/24 preserves it (VT raw-input). Claude Code's OWN changelog
confirms ("Enabled shift+tab on Node versions that support terminal VT mode"). PROVEN LIVE:
on Node 24 + kitty, Shift+Tab = CSI 9;2u (our existing transform already handles it).
FIX (build in flight bv2ln61pc): require Node >=22.17 + enable KITTY on Windows + DROP
win32-input-mode (it ENGAGES on Node 24 and leaks per-key garbage into the composer — the
operator hit this live; kitty only re-encodes modified keys, leaving normal typing clean).
VERIFY on build completion: win32-input-mode DISABLED (no ?9001h), kitty enabled, typing
clean, Shift+Tab cycles. OPERATOR runs Node 24 henceforth (Node 20 workaround = typing works,
no Shift+Tab). Then the operator live-seals by pressing Shift+Tab in zer0 chat on Node 24.

### PERMISSION MODEL — refined (PRD I-7/I-8, operator-reconciled)
The bypass flags (claude bypassPermissions / codex --dangerously-bypass / ACP auto-approve)
are INTENTIONAL — zer0's model is agents-run-free + review-cards + undo, NOT per-action
prompts (the friction zer0 rejects). A codex pass mis-flagged this as a P0 bug; operator
ruled it by-design. THE MODE SETS REAL AGENT PERMISSIONS where it matters: REVIEW/AUTO stay
free-run (bypass) differing only in zer0's review layer; PLAN flips agents into their NATIVE
read-only (claude plan / codex read-only sandbox / gemini sandbox), fail-closed — real
enforcement for the irreversible class (deploy/secrets/remote-db) that rollback can't undo.
Cards are NOT redundant: they review OUTCOMES in plain words (native prompts = per-action
mechanism friction, rejected). PTY sessions bake perms at launch → PLAN relaunches/partitions
the session (or flips the ACP runtime PermissionDecider @8fe664d). Folds into Milestone C1.

## RESUME POINTER (post-compact 2026-07-14) — READ THIS FIRST

IN-FLIGHT codex build (dispatch id bpc14rked → ~/.claude/jobs/3d560b97/tmp/
kitty-decoder-eisdir-fix-out.md): TWO bugs from live testing —
  BUG A: complete kitty DECODER (Ctrl+C leaks as "[99;5u" text because enabling kitty
    @befe6c8 re-encodes ALL modified keys but our transform only did Shift+Tab). Ref =
    gemini-cli KeypressContext.tsx (scratchpad clone). Fix = decode full kitty CSI-u key
    set → legacy bytes (Ctrl+C→0x03 etc).
  BUG B: EISDIR — captureUntrackedEntry (diff-capture-files.ts:109) readFileSync's an
    untracked DIRECTORY (TeamWork .council dirs) → fix = --untracked-files=all or lstat
    dir-skip.
ON RESUME: collect that build → Fable review (verify Ctrl+C→0x03 + EISDIR dir-skip) →
full sweep → SEAL → operator live-tests Ctrl+C + @all in TeamWork on Node 24.

STATE: Shift+Tab LIVE-SEALED @befe6c8 (Node>=22.17 + kitty-first; operator confirmed).
zer0 REQUIRES Node 24. Everything decided this session is in THIS doc (§0-§9 + LATE
UPDATES). After the two bug-fixes seal, NEXT REAL BUILD = B0 the loop-integrity plan
(per the MASTER plan REVISION 1). Sealed today: @f6e1bdb · @8d934bd · @15aa64a · @20490c2
(superseded) · @befe6c8. Master plan codex-reviewed. zer0's agents spec = docs/specs/
2026-07-14-template-palette.md.

## L9 SNAPSHOT ROBUSTNESS (operator directive, supersedes the bpc14rked BUG-B band-aid)
The "couldn't prepare a safe snapshot" class = ONE root flaw (a single bad path aborts the
WHOLE snapshot). BUILD THE L9 CLASS FIX (findings 2026-07-14 "L9 DIRECTIVE"): fail-soft
per-path (classify+skip+record, never abort) · undo-safety honesty (skipped-then-changed →
flagged, not lost) · --untracked-files=all (kills the dir sub-class at source) · respect
.gitignore · observability. bpc14rked's "skip dirs" is a STOPGAP to unblock TeamWork; at its
review, ELEVATE BUG B to this L9 design (own planned round if needed) before sealing. The
kitty decoder (BUG A) is unaffected.

## BACKLOG SNAPSHOT (2026-07-15, operator-requested stock-take — everything still open)

DONE since the plan: terminal input (keyboard firewall @2873ece, live receipt) · snapshot L9
(@edd2efb) · loop-e2e landed (@cf80d4d) · trust-layer design refereed + ratified.
IN FLIGHT: wave 1 = Lane P1 no-roles + R1 @all-authority. QUEUED: wave 2 = R2 resume card ·
wave 3 = R3 universal capture + R4 parallel unlock + dead-code sterilization (write_lease legacy,
retired probe remnants, dead queue paths).

STILL OPEN, in recommended order after wave 3:
1. B0 LOOP-INTEGRITY P0s (was "next real build" before the live findings preempted): verifier
   reviews the APPLIED tree not a stale one · wrong-cwd binding · portable gates + reward-test
   editing ban. Then B loop upgrades (5 field-validated + U6 partial-team pairing + U7 templates,
   Lane P2 verdict schema merges here).
2. REVIEW-PERMISSION PRD remainder (waves 2-3 deliver I-1/I-2 + de-serialization; still unbuilt:
   REVIEW/AUTO/PLAN chip rename + cycle · PLAN = real native read-only (I-7, supersedes §6's
   stale snapshot+restore line) · AUTO clean-auto-accept semantics · morning inbox (H2) · card/
   screen copy §3-§4).
3. ZER0'S AGENTS palette (spec locked 2026-07-14-template-palette.md; ~7 curated defaults +
   user's own; operator still owes the two micro-calls: per-turn-only vs +persistent loadout —
   recommendation stays BOTH).
4. D ONBOARDING (vibe-first 0.1 requirements): agent-installable installer (BLOCKED on operator
   creating the GitHub repo) · error-translation layer (no raw stack trace ever reaches the
   operator) · setup wizard incl. "who's your main?" (un-addressed default; the no-roles wave
   ships the config seam) · restore/preview/publish guided flows.
5. BANKED TERMINAL UNLOCKS (de-risked by the reverse-eng): alt-screen (?1049h — the "pops over
   the terminal like claude/codex" feel + scrollback preserve) · keyboard-shortcuts pass ·
   fetch+render of the engines' interactive built-in commands (palette Approach B).
6. DEBUG FLIGHT-RECORDER: operator's "ZER0_DEBUG=1 = maximum data" directive — round was in
   flight pre-compaction; VERIFY what landed vs what's missing before calling it done.
7. 0.2 DIFF-HERO RECONCILIATION: R4 supersedes part of the old §6 locks (write-lease/pending-
   review-blocks serialization → overlap-conflict model); difftastic vendoring + approve=keep
   stand; reconcile the 0.2 spec to the R4 design before any further 0.2 build.
8. SMALL OPENS: synthesis default · ACP per-cwd edge · notifications · starter prompts · update
   notice · memory week dogfood gate (recall clean ≥7 days) still accruing.
OPERATOR-OWED: GitHub repo URL (unlocks installer + push) · palette micro-calls ×2.
