# THE LOOP — build-orchestration protocol v1 (locked 2026-07-11)

Operator mandate: the cycle that built 0.2 waves 1-4, rewritten as a protocol so it is recreatable
on demand and seeds the 0.3 loop feature. Every rule below was earned in this run — the citation
notes name the failure that taught it.

**The four-beat cycle (operator-locked): Fable 5 plans/briefs → CODEX reviews the plan BEFORE any
build (L-1 spec ladder + L0.5 plan ladder to 0 BLOCK) → Sonnet 5 builds → CODEX reviews the build
(per-wave audit rounds to SHIP IT).** Codex gates BOTH sides of every build. Wave briefs derive
from the codex-cleared plan and inherit its clearance; a brief that materially deviates from the
plan goes back through codex pre-build.

## 1. Roles (cross-family by construction)

| Seat        | Model              | Owns                                                                      |
| ----------- | ------------------ | ------------------------------------------------------------------------- |
| Coordinator | Fable 5 (max)      | Spec, plan, briefs, adjudications, verification, routing, commits, ledger |
| Builders    | Sonnet 5 subagents | Owned files only; tests-first; evidence; reports                          |
| Auditor     | codex gpt-5.6 sol  | Hostile per-wave review from the AUDIT RUBRIC the builders never see      |

Same-family review is advisory only; the primary gate is ALWAYS cross-family (claude-reviewing-
claude shares blind spots — proven across the whole project). The coordinator NEVER rubber-stamps
its own artifacts: spec → sol L-1 ladder; plan → sol L0.5 ladder; wave → sol audit rounds to
0 BLOCK. Builders never run git; the coordinator owns every commit.

## 2. The two seams that make it un-gameable

1. **BUILD BRIEF / AUDIT RUBRIC split.** Builders receive the brief ONLY — spec excerpts verbatim,
   files, behavioral acceptance, falsifiers-to-write, scope bans. Grep targets and anti-patterns
   stay coordinator-side. A builder graded on behavior it cannot see has no shortcut but the real
   thing. Leak = plan BLOCK.
2. **Disjoint file ownership per wave.** Parallel builders share ONE tree but zero files. Shared-
   file tasks get their own wave (T2b ran ALONE because headless-turn.ts had a later co-tenant).
   Cross-contamination is still an explicit audit angle every wave, not an assumption.

## 3. Dispatch protocol (builder-facing)

- Brief carries: verbatim spec excerpt, owned files (CREATE/MODIFY, line budgets), behavioral
  acceptance criteria, named falsifiers, scope bans with forward pointers, and the obligations
  block: real deps (no DB/git mocks — real repos, real sqlite), RED→GREEN with QUOTED command
  output, gates re-run, honest UNVERIFIED over fabricated confidence.
- Every brief ends: "deliver the report via SendMessage to main; idling without one = failed
  dispatch." (Plain-text finals go NOWHERE — root-caused 07-04; this line killed the silent-idle
  class.)
- **Premise-refusal license**: a builder that disproves the brief's premise with file:line or
  empirical evidence and STOPS is doing senior work — T0 refused an eager-schema instruction,
  T1 disproved an impossible test premise; sol ratified both. The license is symmetric: the
  coordinator's briefs are falsifiable too.
- Silent builder → ONE mechanical reminder, never a respawn-on-silence. An idle ping arriving
  right after your own send is a message CROSSING, not silence — do nothing. Dead builder
  (reminder unanswered, no files moving) → fresh builder, same brief.
- Effort economics: builder model = Sonnet 5 default; review dispatches at the codex config
  default (ultra as of 07-10 — its first round found a FIFO bug two xhigh rounds missed);
  mechanical/digest dispatches pin DOWN (`-c model_reasoning_effort="low"` — ultra's ~19k-token
  thinking floor makes unpinned trivia expensive). Review/research dispatches: timeout 0, full
  audit framings, never compressed attack lists (operator standing order).

## 4. Review protocol (per-WAVE cadence — locked by operator 07-10)

- Cheap gates run EVERY wave, coordinator-hand: tsc --noEmit, gate-clamps, biome, depcruise,
  knip, full vitest. The coordinator verifies the tree ITSELF before spending auditor budget —
  builder reports are claims, not evidence (wave 4: the only gate failure was found this way).
- Sol audit at every dependency boundary (= every wave seal), 0-BLOCK bar, rounds until
  `WAVE N SHIP IT`. Brief pattern: scope (uncommitted tree), per-task claims, NUMBERED attack
  angles (the r1 BLOCKs of wave 4 came from pre-written angles — write the attacks you fear),
  coordinator disclosures, verdict format. Later rounds append ROUND N addenda scoped to the fix
  diffs. Verification artifacts must live INSIDE the audited tree or be pasted inline — a path
  outside the repo is invisible to a repo-scoped reviewer (r1 NIT).
- Findings schema: BLOCK (fix before seal — never optional) / DECISION (operator or coordinator
  adjudicates, recorded) / NIT (fold or consciously decline). No false menus: BLOCKs are not
  presented next to "skip" as peers.
- **Named-DECISION discipline**: every coordinator judgment call (kept shim, accepted degradation,
  deferred canonicalization) is DISCLOSED IN THE AUDIT BRIEF for ratification — the auditor can
  overturn the coordinator. Hidden judgment calls are how wrong calls survive.
- E2E runtime task is the plan's LAST task, non-deferrable. Unit-green ≠ live-working
  (2371 green tests once hid a broken TUI). Operator smoke gates anything lane-scoped, with the
  operator-grain coverage gate: enumerate REAL entry points (@all council FIRST — it slipped
  three times historically), state covered/gap per point at file:line.

## 5. Standing review invariants (accumulated, all live in wave audits)

- **No-silent-swallow**: a catch that prevents failure propagation must CLASSIFY + DURABLY RECORD
  - SURFACE what it swallows; fail-soft composes into fail-silent (wave-4 BLOCK A; the T2
    SQLITE_CONSTRAINT* catch-all that ate an FK violation).
- **Producer-timing before consumer**: read emit sites before testing consumers; fabricated event
  timestamps = mock theater.
- **Constants over literals in predicates**: the FIFO drift (hasActiveQueueEntry hardcoding
  'active' while the live-set constant grew) is the canonical class — derive every predicate from
  the SAME constant its siblings use.
- **Seam findings verify NOW, pre-commit**: the tree-type seam check (audit angle, wave 4) caught
  the rename new-side gap while both sides were uncommitted — the cheapest moment it will ever be.
- **Record honesty**: consumed BUILD BRIEF text is never rewritten after the fact; rubric
  amendments are dated and marked (wave-4 --find-renames amendment). The ledger
  (.council/findings.md) carries every delivery, verdict, adjudication, and routing — it IS the
  resume surface after compaction.

## 6. Failure-mode runbook

| Failure                        | Response                                                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Builder silent                 | ONE mechanical reminder → dead = fresh builder, same brief                                                                                                  |
| Idle ping right after my send  | Crossing artifact — no action                                                                                                                               |
| Codex quota exhausted          | PAUSE reviews (never skip, never self-review as substitute); safe-pause ledger entry                                                                        |
| Compact mid-wave               | Charter memory line + topic ladder + findings ledger = full resume; re-verify tree with git status before trusting any recalled claim                       |
| Builder premise-refusal        | Verify the evidence; if it holds, ratify + route to sol; if not, re-brief                                                                                   |
| Gate failure in delivered tree | Coordinator fixes ONLY trivial mechanical class (header wrap, comment drift) and DISCLOSES in the audit brief; anything behavioral routes back to the owner |
| Auditor finding on my files    | Same bar as builders — fix, disclose, re-audit                                                                                                              |

## 7. Seal + commit conventions

Per-task commits in dependency order, coordinator-authored, after SHIP IT only. Message format:
`feat(review): <task essence> (0.2 Wave N)` / `docs(0.2): wave-N ledger`. The wave's ledger entry
seals it: `══ WAVE N SEALED (rK verdict): @sha1 + @sha2 ══`. Never commit through an open BLOCK;
never batch two waves in one seal.

## 8. Why this loop (the moat, for 0.3)

Three families, one team: the builder cannot see the grading, the grader shares no blind spots
with the builder, and the coordinator's own judgment is auditable. Wave 1-4 evidence: ~110+ valid
findings, zero false positives, every BLOCK a real defect that tests+types+gates all missed. The
0.3 product loop (src/loop/) implements THIS protocol as code: driver = coordinator obligations,
verifier = §4-5, progress-store = the ledger, budget = §3 economics, stop = SHIP IT + gates.
Operator direction 07-10: ship it as configurable workflow/team presets so users can run their
own seat assignments over the same seams.
