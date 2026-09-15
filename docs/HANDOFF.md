# HANDOFF — Auto-Resume State (perpetual; orchestrator updates after every commit)

**Last updated:** 2026-05-10 pre-compact. HEAD `13556ba fix(packet-1h): correct schema.sql discipline + trim manifest to remaining C+D phases`. **Last sealed packet: `ae5d5ab DONE(packet-11d)`.**

**packet-1h-rails-hardening IN PROGRESS:**
- Phase A error-wrapping → SEALED `b4ef0af` (10 throw sites wrapped + activityErrorBoundary helper for ZodError → ApplicationFailure conversion)
- Phase B retry-catalog → SEALED `d176178` (NON_RETRYABLE_ERROR_TYPES export derived from ERROR_CODE_METADATA)
- Phase C workflow-wiring → PENDING (retry policy on proxyActivities + idempotent phase-events writes + v5→v6 schema migration + persistPhaseTransitionActivity)
- Phase D falsifying-integration → PENDING (2 integration tests proving retry + idempotency + canonical 7-kind sequence)

**Why packet-1h is mid-build:** Phase C escalated multiple times due to (a) codex schema-discipline bug — codex prematurely bumped `_schema_version=6` and added CREATE INDEX in `schema.sql` when both belong migration-only — and (b) overnight machine sleep poisoning the embedded Temporal test-server. Brief v6 corrects the schema discipline at commit `13556ba`. Manifest trimmed to C+D since A+B are in commit history (no need to re-run sealed work). Resume protocol locked at `project_packet_1h_status_2026_05_10.md`.

**Pre-packet-1h baseline:** REAL E2E PROVEN at `9274927 DONE(packet-99)` on 2026-05-09 — `zer0 build packet-99` ran codex builder + claude primary review + claude-deep-audit secondary + claude finalReviewer end-to-end against real Temporal + real git + real SQLite. Three architectural gaps closed in `10ac694`: FK violation (runs-bootstrap.ts), missing claude dispatcher in dispatch.sh (added dispatch_claude with subscription auth), JSON output contract in reviewPrompt. Hand-cranking ENDS for BUILD/REVIEW. Packet-12+ adds the upstream phases (RECON/INTENT/Q&A/RESEARCH/SPEC/ARCHITECTURE/PLAN). 487 unit + 8 integration + 5 runs-bootstrap tests pass at that point. All 8 gates green. See `project_real_e2e_proven_2026_05_09.md` + `project_pipeline_slice_vs_full_2026_05_09.md` for the full milestone.

**Resume protocol post-compact (packet-1h):**
1. `git status` clean? `tasklist | grep temporal-sdk` empty? `ls .zer0/leases/` empty? `ls .zer0/temporal.db*` absent?
2. If anything dirty → kill stale temporal-sdk-typescript-1.exe + delete `.zer0/temporal.db*` + delete `.zer0/leases/packet-1h.lock`.
3. `cd zer0-agent-ci && (npm run dev -- up > .zer0/.up-stdout.log 2> .zer0/.up-stderr.log &)` → wait for `worker ready`.
4. `(npm run dev -- build packet-1h > .zer0/.build-1h-stdout.log 2> .zer0/.build-1h-stderr.log &)`
5. Monitor `.zer0/.up-stderr.log` for activity completions, attempt counts, escalation file appearance, `wf-size` blob completions (codex outputs ~500-600KB).
6. Phase C expected wall-clock: ~30-45 min. Phase D: ~15-20 min.

**5 new memory entries locked this session** (all indexed in `MEMORY.md`):
- `feedback_schema_discipline_migration_only.md`
- `feedback_worker_restart_after_activity_changes.md`
- `feedback_temporal_test_server_sleep_corruption.md`
- `feedback_manifest_trim_for_resume_after_sealed_phases.md`
- `project_packet_1h_status_2026_05_10.md`

---

## ★★★ HARD RULES — LOCKED ★★★

### RULE 1: No phase transition without real end-to-end execution

**Tests passing + gates green ≠ working.** Locked at `feedback_phase_transition_real_e2e_required.md`.

User directive verbatim 2026-05-09 01:45: "before moving to another phase, EVERYTHING needs to work for real. No quick fix. No patches. Fully working as discussed." And 01:55: "FINISH WITH 11D THAN TEST JUST BEFORE MOVING TO 12."

**Concrete sequence for phase 11→12 transition (do not skip):**

1. ✅ **Seal packet-11c** — DONE at `4843913 DONE(packet-11c)`. fix-r1 closed 3 P0 + 4 P1; fix-r2 closed orchestrator-caught 4 missing activity registrations; G5 gate added to lock the bug class.
2. ✅ **Seal packet-11d** — DONE at `ae5d5ab DONE(packet-11d)`. v1→v7 pre-build review iterations (~30 min, $3.50) caught 13 contract drifts. Deep code-reviewer subagent on BUILD output → 1 P1 + 3 P2; closed 2 P2 + deferred 2 to packet-12. Retro fixes 1+2+3 to sealed 11c (schema strictness + runPhase cancel + state.findings clear). Codex retro review caught Fix 4 P0 (runFinalReviewLoop cancel path missed) — closed at `b0a9abc`.
3. ✅ **REAL E2E EXECUTED** at `9274927 DONE(packet-99)`. Three architectural gaps surfaced and closed in `10ac694`:
   - FK violation: `dispatch_claims.run_id REFERENCES runs(id)` — closed via `src/evidence/runs-bootstrap.ts ensureRunRow()` + 5 falsifying tests
   - No claude dispatcher: `dispatch.sh` only had codex|gemini — added `dispatch_claude()` with subscription auth (no `--bare`), `--no-session-persistence`, configurable `CLAUDE_EFFORT` (default `high`), `case` extended for `claude|fresh-claude|claude-deep-audit`
   - No JSON contract in review prompts: `reviewPrompt` now wraps `JSON_OUTPUT_CONTRACT` preamble + `JSON_OUTPUT_REMINDER` so claude returns ReviewReportSchema-shaped JSON
   What ran for real: lease acquire → preflight → prepareContext → dispatchAgent (real codex, wrote `tests/fixtures/smoke/answer.ts`) → runGates (typecheck PASS) → commitActivity (`3f315d4 prep(...)`) → 3× dispatchReviewActivity (claude primary + claude-deep-audit + claude final, all PASS) → analyzePacket (lessons doc) → postCommitDocumentation (HANDOFF append) → sealPacket (`9274927 DONE`) → releaseLease.
   What did NOT run: RECON / INTENT COMPILE / Q&A / RESEARCH / SPEC / ARCHITECTURE / PLAN (those phases are stubs in legacy `pipelineWorkflow`; activities don't exist yet). See `project_pipeline_slice_vs_full_2026_05_09.md` for the slice/pipeline distinction.
4. 🟢 **Packet-12 unblocked**: builds the missing 11 activities (Intent Compiler, Context Compiler upgrade, Q&A, gemini research, codex feasibility research, claude pattern research, synthesizer, spec writer, architecture, plan, manifest emit). Each dispatched THROUGH `buildPacketWorkflow` (no more hand-cranking). Per Vision v2.1 sequencing.

### RULE 2: Falsifying test mandatory before claiming a static gate works

Locked at `feedback_falsifying_test_mandatory_for_gates.md` after I added G5 and ran it (EXIT=0) without testing whether it actually catches anything. Codex review caught: G5 was vacuously passing on Windows (`path.join` produced `\` while files normalized to `/`); pipelineActivities alias was invisible; type-only exports counted as runtime. **Run G5 against a known-broken state; verify catch with specific file:line; restore.**

### RULE 3: L5 code quality preserved throughout

- Modular maps current (`docs/MODULE-MAP.md` row per file with one-sentence responsibility + line target/max)
- 250-line file ceiling; never add 50+ to a file already >250
- No quick fixes (every fix traces to root cause via `<root-cause-trace>`)
- No patches/stubs/placeholders/TODOs in production code
- No half-finished implementations
- No compatibility shims, no feature flags for hypothetical futures
- Cross-family review on every codex BUILD (claude code-reviewer subagent) AND every orchestrator infra commit (codex hostile)

---

## ★★★ READ THIS FIRST IF YOU ARE A FRESH SESSION OR POST-COMPACT ★★★

You are picking up zer0-agent-ci, a CI/CD pipeline where AI agents (claude/codex/gemini) build code through Temporal-orchestrated workflows. The end state (vision-locked, see §"Locked Vision" below) is a persistent multi-model TUI.

**Do these in order, do not skip:**

1. **Read this whole HANDOFF** — it's the post-compact survival doc.
2. **Read `MEMORY.md`** index in `~/.claude/projects/C--Users-<user>-VibeCoding-TeamWork/memory/`.
3. **Specifically open these memory entries** (they encode locked decisions):
   - `project_zer0_vision_locked_v2_1.md` — capacity > dollars, TUI grammar, packet sequencing
   - `project_buildpacketworkflow_v2_ratified.md` — architecture v2 changes
   - `project_zer0_north_star_vision.md` — the WHY
   - `feedback_workflow_enforces_discipline.md` — process > discipline
   - **`feedback_deep_code_review_not_grep.md` — locked 2026-05-08: code-reviewer subagent for packet reviews, NOT orchestrator grep+spot (caught rubber-stamping at 96/100 vs deep agent's 71/100)**
   - `reference_codex_review_finds_real_bugs.md` — codex hostile review of orchestrator changes (7/7 valid, zero false positives)
   - `feedback_no_gemini_in_packet_manifests.md` — schema-enforced rule
   - `feedback_orchestrator_reviews_codex.md` — locked: codex builds → orchestrator/subagent reviews
4. **Then run** `git log --oneline -10` to see commits this session.
5. **Then proceed to "NEXT ACTIONS" below.**

---

## ★★★ ACTIVE STATE (one-glance) ★★★

| Field                  | Value                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **HEAD**               | `9274927 DONE(packet-99)` — first real workflow-driven seal commit (smoke-target lifecycle proven end-to-end)                                                                  |
| **Last sealed packet** | `ae5d5ab DONE(packet-11d)` — CLI surface + integration suite                                                                                                                   |
| **Branch**             | `main`                                                                                                                                                                         |
| **Working tree**       | clean (this compact-prep commit will fold packet-99 lessons.md + memory + HANDOFF updates)                                                                                     |
| **8 structural gates** | green when run with `--no-file-parallelism` (pre-existing port-7233 collision, see deferred). typecheck + biome + gate-clamps + gate-l5 G1-G5 + dep-check + knip + unit + integration |
| **Tests**              | 487 unit + 8 integration + 5 runs-bootstrap = 500 pass / 2 skipped / 0 fail                                                                                                    |
| **Background tasks**   | none (zer0 up + zer0 build packet-99 both terminated cleanly)                                                                                                                  |
| **`zer0 doctor`**      | PASSES (Temporal 7233 + claude 2.1.133 + codex 0.129.0 + gemini 0.41.2 + DB)                                                                                                   |
| **`zer0 up`**          | WORKS — Temporal + worker, terminates cleanly on Ctrl-C                                                                                                                        |
| **`zer0 start`** (legacy)| Runs legacy `pipelineWorkflow` — STUB for upstream phases (RECON/INTENT/Q&A/RESEARCH/SPEC/ARCH/PLAN do `transitionToPhase + sleep + waitIfBlocked` only). build/review phases dispatch to real activities via fixed `BUILD_TASK_ID`. |
| **`zer0 build`**       | **PROVEN** — `zer0 build packet-99` completes end-to-end with 3-claude review path (commits `3f315d4 prep` + `9274927 DONE`)                                                  |
| **packet-11a**         | SEALED at `1fa9cc5`; 4 P2 retro closed at `e53a106` + `e68204a`                                                                                                                |
| **packet-11b**         | SEALED at `d171fd3`; compactor flake re-fix at `8cdc84d` (writeMany 500→200)                                                                                                   |
| **packet-11c**         | SEALED at `4843913` — fix-r1 (3 P0 + 4 P1) + fix-r2 (4 missing activities orchestrator-caught). 14 activities total in barrel. Workflow at 493/500 lines.                      |
| **packet-11d**         | SEALED at `ae5d5ab` — v1→v7 pre-build reviews + deep review fix-loop + codex retro review Fix 4 (`b0a9abc`). 4 integration tests + CLI surface complete.                       |
| **packet-99 (smoke)**  | DONE at `9274927`. First proof of `zer0 build` end-to-end with real codex + 3× real claude reviewers + real git + real Temporal.                                                |
| **G5 gate**            | LIVE at `ce6a612` — proxy-vs-barrel enumeration: every workflow `activity.<name>(` call must be in the barrel. Hardened 3 P0 + 1 P1 from codex review.                         |
| **claude dispatcher**  | LIVE at `~/.claude/tools/dispatch.sh` `dispatch_claude()` (commit `10ac694`). Subscription auth, NO `--bare`, `--no-session-persistence`, `CLAUDE_EFFORT` env (default `high`). Verified 21s standalone. |
| **runs-bootstrap**     | LIVE at `src/evidence/runs-bootstrap.ts ensureRunRow()` (commit `10ac694`). Closes FK violation between buildPacketWorkflow and legacy `runs` table. 5 falsifying tests.        |
| **filed for §15**      | jcode semantic-memory pattern → revisit at packet-14 TUI chat panel. See `reference_jcode_semantic_memory_pattern.md`.                                                         |

---

## ★★★ DEFERRED FOLLOW-UPS (packet-12 retro) ★★★

These were caught by reviews but explicitly deferred. **Open the matching .council/cross-model/*.md for full evidence.**

| ID                          | File                                              | Issue                                                                                                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **N1 (11c fix-r1 audit)**   | `src/temporal/workflows/build-packet.ts:447-450`  | `escalationTimeoutMs` accessed via `manifest as Manifest & { escalationTimeoutMs?: number }` cast. Manifest schema doesn't expose it. Default 24h works; override doesn't. Add `escalationTimeoutMs: z.number().int().min(1).max(86_400_000).optional()` to ManifestSchema.       |
| **N2 (11c fix-r1 audit)**   | `src/temporal/workflows/build-packet.test.ts:56-72` | `unresolvedFailures` propagation lacks dedicated test assertion. Add `expect(acts.prepareContextActivity.mock.calls[1][0].unresolvedFailures.length).toBeGreaterThan(0)` on retry test.                                                                                          |
| **P2-A (11c fix-r2 audit)** | `src/temporal/activities/dispatch-agent-activity.ts:164-171` | `gitFilesChanged` uses `git diff --name-only` which excludes untracked (newly created) files. Replace with `git status --porcelain` parser or `git ls-files --others --exclude-standard --modified`. Workflow doesn't currently consume `filesChanged`; impact = stored evidence under-reports. |
| **P2-B (11c fix-r2 audit)** | `src/temporal/activities/commit.ts:108-112`       | Replay returns stored `appliedSha` without verifying the commit still exists. If branch reset/rebased, workflow advances on dangling sha. Add `git cat-file -e <sha>^{commit}` check; treat absence as fresh-execution OR INTENT_DANGLING failure.                                |
| **G5 N2**                   | `scripts/gate-l5-mandates.mjs:204-209`            | Multi-line template literals not tracked across lines (template stripping is per-line). Current workflows don't span template literals across lines significantly; not blocking.                                                                                                  |
| **G5 N3**                   | `scripts/gate-l5-mandates.mjs:14-18,227`          | G5 doesn't catch bracket calls (`activity["name"](`), optional chaining (`activity?.name(`), or function references (`const fn = activity.name; fn()`). Current workflows use covered dot-call shape only; not a current sealed-state P0.                                          |
| **11d-deep P1**             | `tests/integration/build-packet-chaos.test.ts:65-93` | Chaos it-block 3 verifies `patched()` branch is taken (via `prep(...)` commit-message check at line 85) but does NOT simulate v1→v2 patch drift. Brief §3.C(c) asks for in-flight workflow on v1 patches while WORKFLOW_PATCHES is mutated to v2 — this requires versioned workflow code which isn't testable in single-process. Either accept current test (verifies active path) or split workflow build into v1/v2 fixtures. Not blocking. |
| **11d-deep P2**             | `tests/integration/build-packet-cancel.test.ts:44-55` | Cancel test bypasses `runCancel` CLI by calling `env.client.workflow.start` directly — defensible (deferred-promise pattern needs in-test handle access for `vi.waitFor` + `handle.signal`) but means CLI's `runCancel` has zero end-to-end coverage. Mocked-unit tests still cover it. Add a small assertion block at end of cancel integration test calling `runCancel(["<workflowId>"], ...)` against the now-terminal workflow. |
| **11c retro cross-family** ✅ done | n/a | Codex retro review on 3 sealed-11c fixes returned NEEDS-FIX with 1 P0 (final-review cancel path missed cancel check before analyze/postCommit/seal). Closed via Fix 4 at `build-packet.ts:105` — `if (state.cancelled) return resultOf(... "CANCELLED" ...)` after runFinalReviewLoop returns. |
| **unit-test 7233 collision**| `src/temporal/__tests__/round-trip.integration.test.ts` + `src/temporal/workflows/pipeline.test.ts` | Both bind Temporal default port 7233 in parallel under `npm test` default `fileParallelism: true`. Pre-existing intermittent flake exposed by stale-process cleanup churn this session. With `--no-file-parallelism`: all 487 unit tests pass. Fix in packet-12 retro: move these two tests to a serialized pool (mirror integration-suite pattern) OR migrate them to `createTimeSkipping()` dynamic-port. Currently work around by manual `npx vitest run --no-file-parallelism` if `npm test` flakes. |

---

## ★★★ NEXT ACTIONS (in order, do not skip) ★★★

### Action 1 — DONE — packet-11b sealed at `d171fd3`

Round-1 (89f08b5) closed 10 P0+P1 from deep audit. Round-2 (9ff7642) reverted required-deps over-correction per codex hostile review. Sealed at d171fd3 with 392 pass / 2 skip.

### Action 2 — DONE — packet-11a 4 P2 retroactive at `e53a106`

`fix(packet-11a-retro): close 4 P2 from deep audit (validators + tests + script safety)`. New `validateDependsOnResolvable` + ordering test for `findCompletedResult` + `DuplicateAdrIdError` in adr-index-build + spec doc whitelist line + vitest config now globs `scripts/**/*.{test,spec}.mjs`. 401 tests pass. All 7 gates green.

### Action 3 — DONE — codex hostile review of `e53a106` returned NEEDS-FIX

1 P2 (stderr flush race) + 1 P3 (doc ordering) closed at `e68204a`. Within-family code-reviewer subagent on `e53a106` returned PASS / 0 P0+P1+P2 / 3 P3 nits — confirmed `feedback_no_within_family_review.md` (within-family review duplicates orchestrator's own blind spots; cross-family is what catches things).

### Action 4 — DONE — packet-11c built, fix-looped twice, sealed at `4843913`

Final commit chain:
- `c6a3f5a prep(packet-11c-build)` — codex prep, 20 files +2057 lines
- `3973de6 fix(packet-11c-blockers)` — orchestrator unblock for codex's 2 surface P1s
- `b98982d fix(packet-11b-retro)` — compactor flake (writeMany 2000→500)
- `e829c2c prep(packet-11c-fix-r1)` — codex closed 3 P0 + 4 P1 + nits from deep audit
- `dd95533 prep(packet-11c-fix-r1): brief` (separate commit)
- `44dbdee DONE(packet-11c)` — INVALID seal (4 missing activities orchestrator caught while drafting 11d brief)
- `56f6345 prep(packet-11c-fix-r2): brief` — 4 missing Temporal activities
- `99f9d4d prep(packet-11c-fix-r2)` — codex created loadManifestActivity, preflightActivity, dispatchAgentActivity, commitActivity (8 new files)
- `4843913 DONE(packet-11c)` — REAL seal supersedes 44dbdee. fix-r2 deep audit returned PASS.
- `8cdc84d fix(packet-11b-retro)` — compactor flake re-fix (writeMany 500→200) under heavier load
- `21bf9a1 feat(gate-l5)` — G5 v1 (vacuous on Windows; codex caught)
- `9843f1e fix(gate-l5)` — G5 hardening close 3 P0 + 1 P2 from codex review (windows path, alias detection, type-only exports, comments/strings stripping)
- `ce6a612 fix(gate-l5)` — G5 N1 strip strings before line comments (false-negative fix from codex re-review)

### Action 5 — DONE — packet-11d brief through 7 pre-build reviews then SEAL

v1→v7 iterations caught 13 distinct contract drifts in 30 min for ~$3.50. v7 PASS GREEN 96% at `cae93b5`. Codex BUILD on `cae93b5` produced sealed `ae5d5ab DONE(packet-11d)` after deep code-reviewer subagent fix-loop (closed 2 P2; deferred 2 to packet-12 retro). Codex retro review on the 3 sealed-11c retro fixes caught Fix 4 P0 (cancel after `runFinalReviewLoop` missed); closed at `b0a9abc`.

### Action 6 — DONE — REAL E2E (the hard rule fired)

`zer0 build packet-99` ran end-to-end against real Temporal + real codex + real claude (×3 reviewers) + real git + real SQLite. Two real workflow-driven commits: `3f315d4 prep(packet-99-smoke-target)` + `9274927 DONE(packet-99)`. Three architectural gaps surfaced and closed in `10ac694 fix(workflow): real claude-dispatcher path + runs-bootstrap FK fix`:

1. **FK violation** between buildPacketWorkflow and `runs(id)` — `dispatch_claims.run_id REFERENCES runs(id)` was failing every dispatch claim. Closed via `src/evidence/runs-bootstrap.ts ensureRunRow()` (idempotent INSERT OR IGNORE INTO runs at activity boundary, called by `claimDispatch` and `recordCommitIntent`). 5 falsifying tests in `runs-bootstrap.test.ts`.
2. **Missing claude dispatcher** — `dispatch.sh` only had codex|gemini; `dispatch-review.ts:108` defaultDispatch threw on every claude review. Added `dispatch_claude()` to `~/.claude/tools/dispatch.sh` (subscription auth, NO `--bare`, `--no-session-persistence`, `CLAUDE_EFFORT` env default `high`, `CLAUDE_OUTPUT_FORMAT` env default `text`). Case statement now handles `claude|fresh-claude|claude-deep-audit`. Standalone test: 21s round-trip → exact JSON.
3. **No JSON output contract in review prompts** — claude returned prose, parseJson failed. Added `JSON_OUTPUT_CONTRACT` preamble + `JSON_OUTPUT_REMINDER` closing to `reviewPrompt`. Strict no-prose rule + exact ReviewReportSchema shape.

What ran (actual production paths exercised): `acquireLeaseActivity` → `preflightActivity` → `prepareContextActivity` → `dispatchAgentActivity` (real codex) → `runGatesActivity` → `commitActivity` (real `git add` + `git commit`) → `dispatchReviewActivity` ×3 (claude primary + claude-deep-audit + claude finalReviewer, all valid JSON PASS) → `analyzePacketActivity` (lessons doc) → `postCommitDocumentationActivity` (HANDOFF append) → `sealPacket` (DONE commit) → `releaseLeaseActivity`. **Build CLI exit 0 = `EXIT_SUCCESS`.**

What did NOT run (because the activities don't exist): RECON / INTENT COMPILE / VISION Q&A / RESEARCH / SPEC / ARCHITECTURE / PLAN. Those are stubs in legacy `pipelineWorkflow` and need real activities in packet-12+. See `project_pipeline_slice_vs_full_2026_05_09.md`.

### Action 7 — NEXT (post-compact) — packet-12 architecture council ratification

Per Vision v2.1 sequencing table, packet-12+ adds the "Phase-2 brain": Intent Compiler, Context Compiler upgrade, **11 missing activities**. Each is dispatched THROUGH `buildPacketWorkflow` (NO MORE HAND-CRANKING). User runs `zer0 start "<vibe>"` → workflow runs INTENT → Q&A → RESEARCH → SPEC → ARCH → PLAN → emits manifest+brief → dispatches buildPacketWorkflow as child → BUILD/REVIEW/SEAL.

**Concrete proposed packet-12 sub-packet split** (mirrors packet-11 strategy; 12a starts the chain):

| Sub | Scope | Files (est) |
| --- | --- | --- |
| **12a** | Context Compiler upgrade — 6-layer assembly, dual-signal scoring (importance ≠ 1.0 stub), `.d.ts` compression via `ts.transpileDeclaration`, hot/warm/cold tiers, token budget priority truncation | ~20 |
| **12b** | Long-Horizon Memory Model (SPEC §5) — content-addressed blobs, persistence layer, recall API | ~15 |
| **12c** | Intent Compiler — vibe → Intent Brief, vocabulary map, Q&A plan generation. Promptfoo evals integrated | ~20 |
| **12d** | Pipeline phase activities — `reconActivity`, `visionQaActivity`, `researchGeminiActivity`, `researchCodexActivity`, `researchClaudeActivity`, `synthesizeResearchActivity`, `specWriterActivity`, `architectureActivity`, `planActivity`, `manifestEmitActivity` | ~25 |
| **12e** | Stability Monitor + final audit + requirement coverage tracker (SPEC §17 success criteria) | ~10 |

**Sequencing**: 12a first (every other phase consumes its output). Architecture council ratification (claude + codex + gemini hostile review of the 12a contract surface) BEFORE drafting the brief. Same pattern that ratified buildPacketWorkflow v2 at `4f0f41d`.

Proposed packet-12a deliverable: `zer0 build packet-12a-context-compiler` runs through `buildPacketWorkflow` and produces working Context Compiler. **First time the system builds itself.**

### Action 8 — DEFERRED — packet-12 retro items (catalogued in DEFERRED FOLLOW-UPS table above)

11d-deep P1 chaos test (WORKFLOW_PATCHES vs mode signal); 11d-deep P2 cancel CLI gap; 11c retro N1 escalationTimeoutMs schema; 11c retro N2 unresolvedFailures test; P2-A gitFilesChanged untracked files; P2-B commit-replay dangling sha; G5 N2 multi-line templates; G5 N3 alternative call shapes; unit-test 7233 collision; evidence-DB-create on first activity write (today silent no-op when DB missing). Address during packet-12 build.

### Action 9 — DEFERRED — claude review prompt content quality

Current `reviewPrompt` includes `Rubric: ${input.rubric}` (just the name) but does NOT include the rubric CONTENT. Claude reviewers therefore work without the 14-dimension rubric content. For trivial diffs this is OK (claude can score "is 8 lines of code good?" without rubric). For real packets, the prompt needs to inline the rubric file content. Add `--add-dir` or read `.council/templates/L5-HOSTILE-REVIEW-RUBRIC.md` and embed in prompt. Track in packet-12 retro.

### Action 10 — Continue per architecture v2 §9 split

packet-12 (Phase-2 brain) → packet-13 (sessions + auth + multi-account) → packet-14 (TUI grammar + REPL skeleton + capacity panel) → packet-15 (council UI + debate + time-travel).

**Do not jump ahead to TUI before workflow is built. Vision is LOCKED, sequencing is LOCKED.**

---

## ★★★ LOCKED VISION (do NOT relitigate) ★★★

User directives this session — these are LOCKED, do not propose alternatives:

### V1 — Capacity, not dollars

> "I use subscriptions only, it would help me to show context or weekly usage that's important for me."

- Subscription mode is PRIMARY. API/dollar mode is OPT-IN secondary (`accountType: "api"`).
- Tracking unit: context window % + weekly quota %, NOT $ amounts.
- Implemented via `capacity_snapshots` table + per-adapter `parseCapacityFromOutput()`.
- TUI shows live capacity panel (preview in arch v2 §15.1.3).
- Source: `docs/ARCHITECTURE-buildPacketWorkflow.md` §15.1; `memory/project_zer0_vision_locked_v2_1.md`.

### V2 — End-state TUI (one persistent terminal, multi-model, free model swap)

> "we will have a general terminal, where I can delegate, or use all the 3 models, and have them build together but still able to use them individually... model and it picks up the stuff like nothing happened"

- Single persistent process (NOT separate `zer0 up` + `zer0 start`)
- Solo mode AND team mode (per-message model targeting via slash-commands)
- Free model swap mid-conversation (architectural consequence of ephemeral spawn)
- Council patterns first-class (debate / vote / pair-programming)
- Slash-command grammar locked (see arch v2 §16.5)
- NOT voice, NOT Cursor-mode, NOT GUI
- Source: `docs/ARCHITECTURE-buildPacketWorkflow.md` §16; `memory/project_zer0_vision_locked_v2_1.md`.

### V3 — Quality is real, not test-pass theater

> "we are not building a system that passes test but actually works"

- Run real CLI smoke after every seal (we caught 2 P0s + 1 SQL bug this way today).
- Don't pad tests to bump scores.
- Don't claim DONE if broader system has gaps — be honest about scope.
- Source: HONEST REALITY CHECK section below.

### V4 — Workflow enforces discipline

- Agents are pure functions of (focused_prompt, code_state).
- Workflow does the discipline (gates, reviews, fix-loops, commits).
- Hand-crank ends with packet-11d.
- Source: ADR-S-001; `memory/feedback_workflow_enforces_discipline.md`.

### V5 — System gets smarter each packet (self-improvement)

- Every review finding becomes a permanent gate-l5 mandate (proven: G1-G4 already locked).
- Mandates go through baseline + false-positive sample + conflict check.
- Source: arch v2 §7 + §7a.

---

## ★★★ COMMITS THIS SESSION (the actual narrative) ★★★

```
40b41c9 prep(arch-vision-locked-v2.1): capacity-tracking + TUI end-state locked
d9ee25f fix(p0): zer0 start works end-to-end + schema-drift detection
bf1c8a9 docs(handoff): honest reality check on packet-10 sealed state
8c36b09 DONE(packet-10): observability foundation sealed
748ad3f prep(packet-10-fix-loop-1): close all gate-l5 violations + L5 review findings
4f0f41d prep(arch-council-ratified): buildPacketWorkflow v2 + packet-10 fix-loop-1 brief
```

What each delivered:

| Commit    | What                                                                                                                                                                                                                                               |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `4f0f41d` | Architecture v1 → v2 council-ratified. Codex hostile (REDESIGN, 5 P0 + 9 P1) + gemini synthesis (9/10) review findings incorporated. Ephemeral-spawn promoted to canonical. Packet-11 split into 11a/11b/11c/11d.                                  |
| `748ad3f` | Codex packet-10 fix-loop closed all 32 gate-l5 violations + 14 new test files + bug fixes (replay reject:false, agent-guide schema-derived, router asymmetry, stream pagination). Orchestrator helpers (knip config, ajv removed, biome auto-fix). |
| `8c36b09` | Packet-10 SEALED at L5 score 89/100 (orchestrator-direct review; fresh-claude headless hung).                                                                                                                                                      |
| `bf1c8a9` | HANDOFF reality check after running `zer0 start` and finding it broken (no auto-Temporal). 2 pre-existing P0s documented.                                                                                                                          |
| `d9ee25f` | **P0 fixes**: `zer0 up` command + Temporal port-pinning + schema-drift detector + status SQL bug. **`zer0 start` actually works end-to-end now.**                                                                                                  |
| `40b41c9` | Architecture v2.1 vision-locked: §15 (10 L5 commitments incl. capacity tracking) + §16 (TUI end-state grammar). User's "I use subscriptions" reframe captured.                                                                                     |

---

## ★★★ HONEST REALITY CHECK (2026-05-08) ★★★

End-to-end smoke results (run on packet-10 sealed + P0 fixes applied, fresh `.zer0/`):

| Check                                   | Status               | Evidence                                                            |
| --------------------------------------- | -------------------- | ------------------------------------------------------------------- |
| Fresh DB → schema v3                    | ✓                    | doctor passes all 5 checks                                          |
| `zer0 doctor`                           | ✓                    | Temporal + 3 adapters + DB ok                                       |
| `zer0 status` (empty)                   | ✓                    | "no runs found"                                                     |
| `zer0 up`                               | ✓                    | boots Temporal at 127.0.0.1:7233 + worker registered                |
| `zer0 start` (test mode)                | ✓                    | created run-b034f07f, dispatched, status: phase=build progress=8/12 |
| `zer0 status <run-id>`                  | ✓                    | real Temporal query returns phase + cost + findings                 |
| `zer0 inspect <run-id> --json`          | ✓                    | canonical RunInspection JSON shape                                  |
| Schema-drift on stale DB                | ✓                    | refuses pre-v3 schema with archive instructions                     |
| `zer0 start` (REAL codex, no test mode) | **NOT YET VERIFIED** | requires codex quota; reset 18:36                                   |

**The dispatch loop is proven working in test mode. Real-codex validation pending Action 2 above.**

---

## ★★★ KEY FILES — READ ON RESUME ★★★

In order of importance:

| File                                                                      | Why                                                                         |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `docs/HANDOFF.md` (this file)                                             | Active state + next actions                                                 |
| `docs/ARCHITECTURE-buildPacketWorkflow.md`                                | Canonical workflow spec; §9 packet-11 split; §15 L5 quality; §16 TUI vision |
| `docs/adrs/_system/ADR-S-001-workflow-enforced-discipline.md` (v2.1)      | Architectural decision + ratification log                                   |
| `docs/SPEC.md`                                                            | Original system spec (older but still relevant)                             |
| `docs/MODULE-MAP.md`                                                      | File-by-file purpose ledger                                                 |
| `.council/cross-model/buildpacketworkflow-codex-review-result.md`         | Codex hostile critique that drove v2                                        |
| `.council/cross-model/buildpacketworkflow-gemini-review-result.md`        | Gemini synthesis review                                                     |
| `.council/cross-model/packet-10-fix-loop-1-brief.md`                      | Template for packet-11a brief                                               |
| `.council/cross-model/packet-10-fix-loop-1-fresh-claude-review-result.md` | L5 review pattern (orchestrator-direct fallback)                            |

Memory entries (auto-loaded but worth re-reading):

| Memory entry                                 | Purpose                                                            |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `project_zer0_vision_locked_v2_1.md`         | Capacity > dollars, TUI grammar, sequencing                        |
| `project_buildpacketworkflow_v2_ratified.md` | v1 → v2 changes                                                    |
| `project_zer0_north_star_vision.md`          | The WHY                                                            |
| `feedback_workflow_enforces_discipline.md`   | Process > discipline principle                                     |
| `feedback_orchestrator_reviews_codex.md`     | Locked review pattern                                              |
| `feedback_l5_quality_standard_locked.md`     | 4-section brief + 14-dim rubric                                    |
| `reference_council_review_pattern_proven.md` | When to dispatch council review                                    |
| `feedback_claude_p_headless_constraints.md`  | Why fresh-claude `claude -p` hung; fallback to orchestrator-direct |

---

## ★★★ ANTI-PATTERNS — DO NOT REPEAT ★★★

These were caught this session and would ABSOLUTELY recur if not warned against:

1. **Pad tests to fake L5 score.** Adding `it.skipIf` to hide pre-existing failures or writing more it-blocks just to bump count is exactly what the user warned against. Real bugs > test counts.

2. **Build TUI before workflow + brain.** User said "I don't want it now." TUI without working brain underneath = pretty face on broken system. Sequencing is locked.

3. **Track $ as primary cost.** User uses subscriptions. Capacity (context % + weekly quota %) is the right currency. API mode is opt-in secondary.

4. **Auto-dispatch agents during user-direction questions.** When user asks "did we say X?" they want CONFIRMATION, not action. Auto mode + good judgment.

5. **Long flowery responses when tactical answer needed.** User often wants "yes/no + here's why + here's what's next" — not 3-page essays.

6. **Claim DONE on broader scope than packet covered.** Packet-10 is observability foundation, not bootstrap. Be precise about scope.

7. **Use `searchFindings` (FTS) for run-id lookup.** UUID hyphens parse as FTS operators → "no such column" SQL error. Use `readPersistedFindings` (proper run_id = ? filter).

8. **`CREATE TABLE IF NOT EXISTS` for column reshape.** Doesn't reshape existing tables. Need PRAGMA-table_info drift detection (now done in `db-drift.ts`).

9. **Default Temporal port mismatch.** `TestWorkflowEnvironment.createLocal()` defaults to random port; pin to `config.temporalAddress` (now done in `server.ts`).

10. **Forget that the user's `npm run dev` is JUST the CLI.** Error messages must reference `zer0 up`, not the misleading `npm run dev`.

---

## ★★★ TASKS — current state ★★★

Live tasks (after compact, future-me should TaskList to confirm):

- #28 (completed) Fix P0: zer0 start dispatch end-to-end ✓
- #29 (completed) Fix P0: schema migration column-shape changes ✓

Pending tasks to add post-compact (NOT yet created — add when starting next session):

- Real-codex end-to-end smoke (Action 2 above)
- Packet-11a brief drafting
- Packet-11a codex dispatch
- Packet-11a verification + L5 review

---

## ★★★ PRE-STAGE WORK (during codex quota wait) ★★★

If you wake up and codex quota is still cooling:

1. Draft `.council/packets/packet-11a/manifest.yaml` per arch v2 §3.
2. Draft `.council/packets/packet-11a/canonical-brief.md` covering:
   - Manifest schema + 6 semantic validators (§5a)
   - dispatch_claims + commit_intents tables (§4a)
   - capacity_snapshots table (§15.1.1) — NEW from v2.1
   - ADR index builder script
   - File layout per §10
3. Draft 3-5 ADRs for packet-11a in `docs/adrs/packet-11a/`.

All of this is orchestrator-direct (no codex burn). When codex returns, the dispatch is one command away.

---

## ★★★ DISPATCH PATTERNS (proven, locked) ★★★

```bash
# Codex BUILD (workspace-write)
bash ~/.claude/tools/dispatch.sh codex \
  .council/cross-model/{packet-id}-brief.md \
  .council/cross-model/{packet-id}-result.md \
  10800 /c/Users/<user>/VibeCoding/zer0-agent-ci

# Codex REVIEW (read-only)
CODEX_SANDBOX=read-only bash ~/.claude/tools/dispatch.sh codex \
  {prompt}.md {result}.md 900 /c/Users/<user>/VibeCoding/zer0-agent-ci

# Gemini SYNTHESIS REVIEW (no -y, no file writes)
bash ~/.claude/tools/dispatch.sh gemini \
  {prompt}.md {result}.md 900

# Fresh-claude REVIEW (LOCKED: known to hang on Windows; orchestrator-direct fallback)
# DO NOT use claude -p first. Run orchestrator-direct review applying the 14-dim rubric.
```

---

## ★★★ COMPACT-RESILIENCE (for the next compact) ★★★

To survive future compacts:

1. **HANDOFF.md is the survival doc** — keep it current after every commit.
2. **Memory entries are cross-session** — write decisions there, not just in chat.
3. **MEMORY.md auto-loads on session start** — keep index ≤ 200 lines.
4. **Architecture v2 + ADR-S-001 are SOURCE OF TRUTH** — never relitigate without changing these files first.
5. **Background tasks survive process** — but the orchestrator's mental model doesn't. Re-check task status on resume.

If a compact hits mid-task:

- Tool detail is lost; user instructions preserved in summary.
- Read HANDOFF first.
- Run `git log --oneline -10` to see what shipped.
- Read MEMORY.md index.
- Verify gates green: `npm run typecheck && npx biome check . && node scripts/gate-clamps.mjs && npm run gate-l5`.
- Then proceed.

---

## END

This document is the single source of truth for resume state. Architecture v2.1 + ADR-S-001 v2.1 are the locked specs. Memory entries are the cross-session knowledge base. Commits are the proof.

Next session begins at "NEXT ACTIONS" §1.
## packet-99

Latest commit: 3f315d41858a655c6c8da06a534d8b50205e86f8
