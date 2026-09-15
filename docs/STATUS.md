# zer0 — STATUS BOARD

**The single place to find where the project is.** Statuses flip in the same commit as the work
they describe — if this file and reality disagree, that is a defect; fix the file.

**Updated:** 2026-08-01 (CLEAN BASE SEALED — S2/S6b/S6c merged, final suite 556 files / 4,634
tests green + all gates green on the merged tree; GREEN LIGHT issued, operator script:
`jobs/20b1cbc2/tmp/OPERATOR-TEST-CLEAN-BASE.md`; design panel of five verified documents parked
for the plan talk) · branch `wip/w5-loop` (position = whatever `git log -1` says — a
self-cited SHA here was wrong the moment it was committed; skeptic B5, rule adopted: no
self-referential SHAs) · mainline `203e495` (untouched since 2026-07-16; seals only on operator
stamp) · nothing pushed (GitHub URL pending, operator's). Last build commit: `decd341`; everything
above it is docs.

**READ ORDER FOR A COLD AGENT:**
1. This file — position + the board.
2. `docs/decisions/2026-07-28-the-room-is-alive.md` — THE NORTH STAR every wave is measured against.
3. `docs/decisions/2026-07-28-memory-model.md` — how continuity ACTUALLY works (the substrate
   S2-S5 are specified against; supersedes the 06-29 "stateless cold-start" account).
4. `.council/overnight-run4-state.md`, the dated entries at the tail — the run log
   (append-only; its old "CURRENT STATE — 2026-07-27" block is a SUPERSEDED historical snapshot).
5. `codex review/START-HERE.md` → `codex review/audit/01-findings.md` — the 2026-07-30 external
   codex audit (28 findings, coordinator spot-verified): the canonical defect register. Statuses
   live on THIS board; the audit informs gates but does not reorder the milestone.
6. `docs/ROADMAP-0.1.md` — positioning + the 0.1 release ladder (locked 2026-07-04).
   (`docs/PLAN.md` is the May day-1 blueprint — HISTORICAL, do not plan from it.)

## THE GOAL

**Three agents, one team, one memory — terminal-native on Windows.** zer0 chat is the Claude Code
terminal experience with a three-agent room: ALIVE, not turn-based — you watch the work happen,
messages appear when their author has something to say, teammates hand work to each other in the
open, everything visible in the feed. Ship 0.1 free (Apache-2.0) at big-lab quality.

## WHERE WE ARE (2026-07-30)

Two hardening waves are built and coordinator-sealed (W4-R2b, the truthful bar · W4-R2c, the
alive-feel floor). The operator is MID-S0: steps 1/2/4/5 passed via screenshots, steps 3/6/7/8
outstanding. S1's battery brief is written, codex-refereed, amendments folded — the builder
fires on the S0 verdict. The tracking skeptic audit closed 2026-07-29 (all 9 findings fixed).
2026-07-30: OpenAI shipped an official Codex plugin for Claude Code — boss-and-tool, NOT the
room; full source teardown in `docs/research/2026-07-30-codex-plugin-teardown.md`, its reusable
inputs wired into the S2/S3/S5 gates below and the operator menu. Same day: the operator's
commissioned codex audit landed (`codex review/`, 28 findings; coordinator spot-verified 6 claims,
all valid — its F10 independently CONFIRMS the S2 leak line evidence.ts:194). Absorbed into the
S2/S5/S8/S9/S10/S12/SD gates, new S13-S15 hardening slices behind the milestone, three operator
decisions on the menu. Reconciliation: `jobs/20b1cbc2/tmp/codex-audit-reconciliation.html`.
Audit severity is calibrated for SHIPPING (its RED = release-to-strangers); the demo milestone
is not blocked and its order is unchanged.

## THE MILESTONE: **THE WORKING ROOM** (operator refocus, 2026-07-28)

The operator's target, verbatim: "get the zer0 chat functional so I can use it and test it · the
memory working properly FOR SURE (transcript, continuous conversations) · the new live terminal
effect · them calling each other so they can roughly work together — so I can start testing and
make videos." **Everything up to and including S5 IS that milestone; S6-S12 sit behind it.**
Demo-scope defaults (operator may override): the AFK overnight loop (S9/S10) is OUT of the
milestone; call-each-other ships ONE-HOP first (ask → answer, visible), multi-round agent
back-and-forth is a later slice.

**DESIGN RULING (operator, 2026-07-31): MINIMUM, AT THE RIGHT TIME.** Operator, near-verbatim:
"Stop adding so much useless information — it's breaking the app. Just the minimum, what's
important, at the right time. Stop over-engineering." Applied: boot is QUIET (no lifecycle
narration — lanes warm silently; internals are never theater); data appears when known, without
ceremony; every existing and future info-surface must justify itself against this ruling; remove
before add. The pattern is proven: the receipt caused the 30s hang, meter-reservation complexity
ate the battery, double narration contradicts itself — information glut has been the bug source.

## THE BOARD

| ID  | Slice                                                                 | Status                 | DONE means (the gate)                                                                                             |
| --- | --------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| S0  | Operator 8-step live test of W4-R2b+R2c                               | **PASSED (operator "we good", 2026-07-31)** | Steps 1/2/4/5 by screenshot; step 3 PROVEN by trace (warm replies 2.6s/5.9s/11.5s; warm re-acquire 43-54ms vs the 8000ms budget); 6/7 operator-passed with findings routed (ghost→S6, vocab→S3b, boot→S6b); 8 not triggered (no lane failed). Trace: TeamWork/.zer0/debug/chat-1785511159817-* |
| S1  | Battery trim — the wide HUD reachable at the operator's real window   | **SEALED (coordinator, 2026-07-31) — AWAITING OPERATOR LOOK** | Built @c3e2525 (+blessed follow-up @739e390); MAX review SEAL, all 7 axes; thresholds 185→170 unicode / 193→178 ASCII terminal (ASCII margin 2 cols, fenced by the permanent 180-col golden); coordinator-independent: acceptance suites 111/111 + FULL SUITE 545 files / 4573 tests exit 0 — first fully green run on this branch; frames verified at 178/180/182/184/200 both glyph sets incl. offline words. Operator script: jobs/20b1cbc2/tmp/OPERATOR-TEST-W4-R2d.md — GATE (met): battery/moon visible at a 180-col terminal + the permanent golden pinning "HUD reachable at 180" so it cannot creep again |
| S2  | MEMORY FOR SURE — un-forkable write path + live-proven continuity     | **SEALED (2026-08-01)** — 03a8e72+3ef036c+b3186df: one mint point (throw-not-fallback), canonical identity at ONE decision place, test isolation + WAL-safe guard, junk cleanup receipted (14,298 rows, backup kept); LIVE PROOF: all three agents recalled OSPREY-4417 from the shared ledger with the codeword absent from the prompt, zero absent-from-mirror; MAX SEAL | One recording path, mutation-proven; the leak scenario replayed green; mirror zero-absent; AND a live pass on the operator's machine: restart → resume → agent B recalls agent A. Fix-shape input: canonicalize paths before any identity compare (research/2026-07-30-codex-plugin-teardown.md §S2). AUDIT ABSORBED (F10 confirms the suspect line; Waves 0+2): test-isolation commit FIRST (no test may touch a real `.zer0` DB — the audit's own runs contaminated the repo dogfood DB; preserved, cleaned this round), one run-scoped persistence owner (no ambient loadConfig in persistence), atomic transcript writes. LEAK OBSERVED LIVE (operator trace 07-31): suppressed.log shows `database opened {dbPath:".zer0/evidence.db"}` — RELATIVE — at each session save, while all three turn replies went "absent from DB mirror", shared=0; also gemini `resume.fallback reason=binding_mismatch` + `delta.overflow skippedSeqs=88` (was 60, growing) — both S2-scope |
| S3  | ALIVE P1 — live work rendered (tool lines + the bar's phase slot)     | QUEUED                 | S3a: real ACP activity payloads CAPTURED (evidence round — ALSO capture `codex app-server` item events, the richer official channel; teardown §S3). S3b: operator watches `claude ▸ reading x.ts` live; gemini shows honest elapsed; ONE VOCABULARY (operator finding 07-31, screenshot Code_duGVuQekKW.png): the feed's liveness line and the bar cells said `claude sending` and `claude opening` at the same instant — after S3b, one source of truth narrates a lane; the two surfaces may differ in detail but never in state |
| S4  | ALIVE P2 — messages when they happen                                  | QUEUED                 | S4a: mid-work operator messages queue VISIBLY + long turns show elapsed. S4b: a background-work "finished" report lands as a NEW feed message minutes later |
| S5  | ALIVE P3 — teammates call each other (taught skill, one-hop first)    | QUEUED                 | Codex hands research to gemini unprompted, in the feed, hop-budgeted, at operator-granted permissions. Brief cribs the teaching layer (teardown §S5: proactive hand-off · routing metadata out of hop text · honest relay, never a substitute answer). PREREQUISITE (audit F2/F3): a typed read-only capability for non-addressed lanes — ask/debate/synthesis must not carry write grants |
| SD  | DEMO PASS — scripted demo scenario + full live run-through            | QUEUED (last in milestone) | The operator's video scenario runs clean end-to-end on their machine; ghost-box replay falsifier checked in a REAL terminal; audit F26 states fixed (/resume loading state; model-picker error ≠ empty catalog); reply-header full-width band pixel artifacts resolved (size to content or drop the band — design call, "minimum" ruling applies). MOVED TO S6b (07-31): boot stance line, ctx%-late, mixed boot modes — all three are the quiet-boot round now |
| S6  | The ghost round — duplicated/overlapping prompt box                   | **RESIZE-STORM CLASS SEALED @221c4d7 · MINIMIZE CASE UNEXPLAINED — operator's manual pass DECIDES** — Ink patched (physical-row erase); S6c proved the "second mechanism" was instrument artifact, so NO test-supported theory explains the operator's 07-29 minimize/3-box sighting; the harness sees ConPTY while VS Code reflows again in xterm.js above it. If the operator's minimize→restore check still ghosts: fresh hunt in xterm.js territory |
| S6c | Ghost overflow follow-up — reflowed frame taller than viewport        | **CLOSED (2026-08-01): NO DEFECT EXISTED** — the "overflow ghost" was the test instrument's own error (screen model resized only on optional ConPTY geometry reports); instrument corrected + hardened (repaint-assumption fence w/ ECH discovery, normal-buffer guard, storm un-trimmed, launch-gate unflaked); merged @042177f; clearTerminal desync re-deferred with reason | REPRO FOUND (operator, 07-29): minimize→restore the window = 3 stacked composer boxes (resize event storm; Ink erase-count misses after reflow — verify, don't assume). EVIDENCE BROADENED (operator, 07-31, screenshot Code_rUWt052Vdl.png): TWO stacked composers in a normal maximized VS Code session — stale box above (prompt only), live box below (prompt + bar) — so the trigger class is ANY resize storm (VS Code panel-divider drags included), not only minimize→restore. Gate: replay asserts exactly ONE composer/agents-row/footer AND the minimize→restore recipe leaves ONE box in a real terminal |
| S6b | QUIET BOOT — the "minimum, at the right time" ruling applied to boot  | **SEALED (2026-08-01)** — 309a095 merged @9d4f406: boot-idle narration gone, stance line silent, operator's persisted mode WINS (push-then-display), `connecting` per ruling, quota prefetch through real sources; MAX SEAL, all four concerns accepted (noteResetWindow gap = named follow-up) | Type `zer0 chat`: NO lifecycle words — lanes keep warming silently in the background (they already warm; the bar stops narrating it); quota/ctx pre-fetched at boot and appear quietly as they become known — no absent-then-pop; the boot stance line shows nothing ("waiting for claude" dies); boot modes consistent across all three (07-29 mixed-modes finding folds here — operator had to set auto by hand, 07-31); a first message on a healthy lane goes out with zero "opening" ceremony. Compatible with C1: quiet BEFORE the operator acts, alive the instant they do. TRACE EVIDENCE (07-31): cold resumes took 17.5s (claude) / 41.6s (codex) — the silence must cover a ~40s warmup, and prefetch fires as each lane readies; claude's mode restore applied `default` over the operator's chosen `auto` (mode.session outcome=applied modeId=default) — the restore bug is IN scope; the always-missing `claude.statusline` probe is a minimum-law removal candidate |
| S7  | Part 2 remnant — continuity announced · turn-0 notices · fresh-folder | QUEUED                 | Fresh vs resumed SAID; boot notices visible; memory-off + git-init offer told in plain words                       |
| S8  | Tests-that-lie round — green-theater audit                            | QUEUED                 | The 4 known theater tests + dead cockpit guard + 12 skipped real-CLI tests each fixed or honestly retired + audit F13/F14: live codex seam OUT of the default suite, expired-fixture and shared-state failures fixed, CI = local required gates by policy, loop-E2E de-theatered |
| S9  | W5-B2 — plan-file loop mode                                           | QUEUED                 | Per its sealed spec (docs/specs 2026-07-11 loop v1) + audit F8/F9: capture includes untracked/renamed/binary files; fresh-loop budget bootstrap (seed or explicit-unknown policy) |
| S10 | W5-C — convergence (the AFK mode of the alive room)                   | QUEUED                 | Loop converges/stops honestly; morning report tells the truth + audit F4: no `reset --hard` against the operator checkout — a concurrent edit injected between check and failed apply survives byte-exact |
| S11 | W6 — design pack (brainless lookbook gaps, per-CLI icons, animations) | QUEUED                 | Operator-stamped visual pass                                                                                       |
| S12 | 0.1 release — GitHub push, installer wizard, error translation        | BLOCKED on operator URL | Public repo live per ROADMAP-0.1 ladder + audit F11/F23: compiled allowlisted package, runtime deps complete (tsx is currently a dev dep — the advertised bin cannot run), tarball smoke-tested `--omit=dev`, no internal files in the packlist |
| S13 | Authority & secrets hardening (audit Wave 1)                          | QUEUED (post-milestone) | Typed capability carried end-to-end, fail closed on adapter mismatch; ONE mandatory redaction gate before every native send and durable raw write (F1); secret-file denial at tool layer; /debate fenced or repaired (F5); approvals select the exact offered option, never fabricate allow (F21); Temporal surface fenced or REMOVED per the D1 ruling — deferred out of 0.1, removal authorized (F6/F7/F16/F17) |
| S14 | Lifecycle & recovery hardening (audit Wave 5)                         | QUEUED (post-milestone) | Cancel + total/idle budgets through every carrier/adapter (F18); orphan reporting wired, SIGTERM teardown proven (F19); replay honest about what it reproduces (F22); retention/GC + blob integrity re-hash (F28) |
| S15 | Behavioral eval + docs regen + fresh audit (audit Wave 6)             | QUEUED (post-milestone) | Baseline/candidate eval gate with held-out fixtures (F25); stale READMEs/module/test maps regenerated or checked (F24); every escaped P0/P1 becomes a regression fixture; re-audit against final source |

**Order of execution: S0 → S1 → S6 (ghost) → S6b (quiet boot) → S2 → S3 → S4 → S5, then S7-S8 interleaved as findings demand, then S9-S15 (S13-S15 = audit hardening, pre-release), then S12 ships.**
Every slice runs the standing pipeline: brief → codex referee → builder (Sonnet 5 / Opus 5 hard tier)
→ codex MAX review of the diff → coordinator gates + SCREEN pass → operator live test. No slice
seals on suite-green alone.

## OPEN OPERATOR DECISIONS (theirs, standing)

GitHub URL (blocks S12) · codex-cyan icon sign-off · run the real-agent test lane? (costs
subscription) · the F6 upstream report to Anthropic (background-task visibility evidence) ·
future feature: hand a room conversation to another vendor? (official Codex session import
exists — teardown §menu; not in this milestone).

**From the 2026-07-30 audit** (recommendations in the reconciliation page):
**D1 RULED (operator, 2026-07-30):** the legacy Temporal `start`/`build` surface is **DEFERRED
OUT of 0.1** — operator: "useless honestly"; fence it, **full removal authorized** as an option
when S13 fires. The focus is the room — agents calling each other, real-time chat, teamwork —
"that's going to be insane to display on the internet."
**Still open:** **D2** mark the npm package private now, compile properly at S12 (recommended;
the one-line change lands with the first post-S0 commit, never under a running test)? ·
**D3** /debate fence timing — inside S13 (recommended) or immediately after S1?
Until fenced: do not type `/debate`.

## KNOWN DEBT (recorded, not blocking)

Digest DB-mirror leak (= S2's core) · one unreproduced 547/548 flake · C4 raises catch-up
likelihood on wedged lanes (accepted trade) · recordChatMessage per-message openDb · delta.overflow
skippedSeqs · agy version-probe on dispatch path · dead `probeAgentStatuses` export (S8) ·
dep-check/knip pre-existing reds (identical at base) · stray `.zer0-test/` dir (operator's, untouched).
**The full defect register is now the audit:** `codex review/audit/01-findings.md` (28 findings,
each mapped to a slice above; this board governs status and order).
