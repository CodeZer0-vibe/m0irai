# zer0-agent-ci — Founding-Invariant Drift Audit (drift)

## Headline

**Drift score: 5 HONORED / 9 DRIFTED / 1 BROKEN / 4 ASPIRATIONAL of 19 founding invariants.** The codebase is _structurally_ faithful — the deterministic-control spine (SPEC-1), Temporal-owns-state (SPEC-5), gates-decide-completion (SPEC-11), fresh-per-call context (SPEC-4), and isolatedDeclarations (SPEC-8) all hold on the canonical `buildPacketWorkflow` path. The single most important drift is the recurring **"right idea, wrong place" pattern**: at least five invariants (cross-family SPEC-2, prerequisite-ordering SPEC-3, citation SPEC-6, secrets-prefilter SPEC-9, evidence-blobs SPEC-13) are correctly _built_ but wired to the **CLI boundary or the legacy `pipeline.ts` workflow — not the canonical path that `zer0 build` actually runs**. The lone BROKEN invariant is SPEC-7: malformed reviewer output is classified non-retryable and crashes the workflow in **one attempt with no retry budget and no escalation — the exact inversion of "retriable, max 3, then BLOCKED + escalate."** Four invariants (Promptfoo evals, three-tier memory, enrichment-measurement, Gemini grounding) were never built and are honestly scope, not bugs.

## Scorecard

| id         | source                            | invariant (short)                                                            | verdict          | evidence file:line                                                                                                                                                                                                                                            | maps to audit finding                              |
| ---------- | --------------------------------- | ---------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| SPEC-1     | product SPEC.md v6                | Deterministic code controls; agents are workers                              | **HONORED**      | build-packet.ts:472-474, :205, :322, :336, :218, :476-480, :482-485, :285-300; dispatch-review.ts:104-124                                                                                                                                                     | none                                               |
| SPEC-4     | product SPEC.md v6                | Fresh per-call context, replay-safe                                          | **HONORED**      | build-packet.ts:79, :206, :210, :425; prepare-context.ts:103-126; prepare-context.test.ts:52-61                                                                                                                                                               | none                                               |
| SPEC-5     | product SPEC.md v6                | Temporal owns state; no authoritative JSON; SQLite owns evidence             | **HONORED**      | build-packet.ts:95-97, :177, :89-93; status.ts:97-102; client.ts:178-180; state-writer.test.ts:21,30                                                                                                                                                          | none                                               |
| SPEC-8     | product SPEC.md v6                | Explicit return types; isolatedDeclarations:true                             | **HONORED**      | tsconfig.json:28,36,40; package.json:24; run-gates.ts:112-117,171; build-packet.ts:327,336-339; empirical `tsc` exit 0 / TS9007 falsifier                                                                                                                     | none                                               |
| SPEC-11    | product SPEC.md v6                | Agents submit artifacts; gates decide completion                             | **HONORED**      | dispatch-agent-activity.ts:25-30; build-packet.ts:322-326, :327-332, :336-340, :218; run-gates.ts:131,171; :476-480                                                                                                                                           | none                                               |
| SPEC-2     | docs/SPEC.md:14                   | Builder ≠ Reviewer; different family; fresh; no retry memory                 | **DRIFTED**      | semantic-validators.ts:148-156,226-228,239; build.ts:80,58-59,120; load-manifest-activity.ts:28-47; loader.ts:16-21; preflight.ts:91; schema.ts:93-122,97-98                                                                                                  | none                                               |
| SPEC-3     | product SPEC.md v6                | No phase runs without prerequisites (Temporal transitions)                   | **DRIFTED**      | build-packet.ts:472-474,108; semantic-validators.ts:50-74,189-206; preflight.ts:91; build.ts:80,78; manifest/schema.ts:99                                                                                                                                     | none                                               |
| SPEC-6     | product SPEC.md v6                | Every claim cites a source (Review→file:line)                                | **DRIFTED**      | dispatch-review.ts:21-28,288,285-292,226; build-packet.ts:513,516; schema.sql:75-76; dispatch-review.ts:131-154; gate-l5-mandates.mjs G1-G7; src/README.md:84                                                                                                 | none                                               |
| SPEC-9     | product SPEC.md v6                | Secrets never enter prompts; denylist + entropy before every dispatch        | **DRIFTED**      | filter.ts:78,110,125; dispatch.ts:237; chat/prompt-builder.ts:72; dispatch-agent-activity.ts:7-23,167,131-142; dispatch-review.ts:119,201; prepare-context.ts:115                                                                                             | none                                               |
| SPEC-10    | product SPEC.md v6                | P0 blocks unconditionally; no auto-override; human approval w/ logged reason | **DRIFTED**      | build-packet.ts:476-480,218,418,265-283,285-300,290,87-88,173-176,433-434,115-133,446-453; approve.ts:164-169; resume.ts:13,73,102                                                                                                                            | none                                               |
| SPEC-13    | product SPEC.md v6                | Evidence is content-addressed blobs (prompt/context/diff/stdout/stderr)      | **DRIFTED**      | blobs.ts:45; evidence.ts:172,284; pipeline.ts:296,325,365; build.ts:120; build-packet.ts (no putBlob); dispatch-agent-activity.ts:167,144; dispatch-claims.ts:103-104,62-64; diff-compiler.ts:54,87-89; prepare-context.ts:106,110; schema.sql:55,103-114,165 | Zer0 two dispatch paths (canonical vs legacy)      |
| GENESIS-3  | three-chairs-spec/spec.md:61      | CLI unavailable degrades to Claude-only; no crash, no block, logged warning  | **DRIFTED**      | codex.ts:150-156; gemini.ts:217-227; claude.ts:177-183; doctor.ts:90-104; registry.ts:87-107,27; build-packet.ts:311-318,322,205,324,227-229,265-283,290-298,36; dispatch.sh check_cli ~:38                                                                   | none                                               |
| GENESIS-6  | three-chairs-spec/spec.md:64,:766 | Union rule for P0; dismiss only w/ mechanical counter-evidence               | **DRIFTED**      | build-packet.ts:392,476-480,395-404; loader.test.ts:123-124; schema.test.ts:67-77; dispatch-review.ts (no dismissal gate); council-synthesis.ts:48-71; pipeline.ts:300-327                                                                                    | none                                               |
| GENESIS-10 | three-chairs spec line 68         | Anti-sycophancy by default; every prompt hostile-framed; no "looks good"     | **DRIFTED**      | dispatch-review.ts:216,202-214,294-301,206,240; build-packet.ts:366,380,403,372; prepare-context.ts:230-244; project-context.ts (no hostile framing); generate-fix-brief.ts:79-83 (dead)                                                                      | none                                               |
| SPEC-7     | SPEC.md v6 / ROUND_TABLE.md:73    | Malformed output retriable, max 3, then BLOCKED + escalate                   | **BROKEN**       | dispatch-review.ts:190-198,120; error-codes.ts:303-309,356-360,177-183; application-failure.ts:19-27; build-packet.ts:79,360-393,217,135-140,205-226,265-283; application-failure.test.ts:23,27; dispatch-review.test.ts:118-119; error-codes.test.ts:40      | none                                               |
| SPEC-12    | docs/SPEC.md:24                   | Prompt templates are production logic; must pass Promptfoo evals             | **ASPIRATIONAL** | docs/SPEC.md:24; package.json:55,17,33; spike/05-promptfoo.ts:5-7,44-50,98; gate-l5-mandates.mjs (no eval); no promptfooconfig.\*; no src/templates/ or src/eval/; SPEC-ADDENDUM.md:78; PLAN.md:120-122                                                       | none                                               |
| SPEC-14    | docs/SPEC.md:26,:235-245          | Context is Hot+Warm+Cold memory hierarchy simultaneously                     | **ASPIRATIONAL** | prepare-context.ts:98-128,230-283,236-243,273-283; project-context.ts:59-112; dispatch.ts:279-297; shared/types.ts:106; PLAN.md:68-70,1860-1862,629-725; HANDOFF.md:191                                                                                       | 2026-05-27-claude-audit.md:272 (I-14) + K8 at :493 |
| SPEC-15    | docs/SPEC.md:27,:459-460          | Every enrichment is a hypothesis; removed if no gain after 20+ dispatches    | **ASPIRATIONAL** | spike/05-promptfoo.ts; src/README.md:40; schema.sql:110; types.ts:97; dispatch.ts:283; chat/prompt-builder.ts:90; db.test.ts:82, replay.test.ts:80, inspect.test.ts:82                                                                                        | none                                               |
| GENESIS-12 | genesis Three Chairs              | Google Search grounding via Gemini; external claims verified before prompt   | **ASPIRATIONAL** | build-packet.ts:98-134; prepare-context.ts:98-128,104,105,253-272,311-318; schema.ts:18-21,22-26; pipeline.ts:47,101,104,281,308; dispatch-service.ts:125; gemini.ts:164-171; GEMINI.md:62-84; ROUND_TABLE.md:107                                             | none                                               |

## BROKEN invariants

### SPEC-7 — Malformed output retriable (max 3) then BLOCKED + escalate

**Contract said** (SPEC.md v6 / ROUND_TABLE.md:73): malformed reviewer/agent output is RETRIABLE up to 3 attempts; only after exhausting retries does it become BLOCKED and escalate to a human.

**Code does the inverse, on the canonical `buildPacketWorkflow` path, on the FIRST occurrence.** Causality chain:

1. `parseReviewOutput` (dispatch-review.ts:190-198) throws `failureFor({ code: ReviewerOutputMalformed })` on non-JSON output (called inside the activity at dispatch-review.ts:120).
2. `ReviewerOutputMalformed` is classified retryability `"after_fix"` — **not** `"yes"` (error-codes.ts:303-309). `AgentMalformedOutput` shares this classification (error-codes.ts:177-183). _(Verified directly: both entries carry `"after_fix"` at error-codes.ts:180 and :306.)_
3. `failureFor` sets `nonRetryable: retryability !== "yes"` → `nonRetryable: true` (application-failure.ts:19-27; proven by application-failure.test.ts:23,27 and dispatch-review.test.ts:118-119).
4. `NON_RETRYABLE_ERROR_TYPES` is built from every code where `retryability !== "yes"` (error-codes.ts:356-360), so it **includes** `ReviewerOutputMalformed` (error-codes.test.ts:40). _(Verified directly at error-codes.ts:356-360.)_
5. The activity proxy sets `retry: { maximumAttempts: 3, nonRetryableErrorTypes: [...NON_RETRYABLE_ERROR_TYPES] }` (build-packet.ts:79). Because the type is in that list AND the failure carries `nonRetryable: true`, Temporal performs **zero** retries — one attempt only.
6. No recovery path catches it. `reviewPhase` (build-packet.ts:360-393) never wraps `dispatchReviewActivity` in try/catch; the throw propagates through `runPhase` (:217) to the top-level catch (:135-140), which only special-cases cancellation and otherwise re-throws (:140). The workflow **fails outright**.
7. The fix-loop (:205-226) iterates only on parsed blocking findings; a parse failure throws _past_ the loop, so malformed output never consumes a fix-loop attempt and never reaches `escalateExhausted` (:265-283).

**Maps to audit finding:** none (newly surfaced by this drift audit).

**Why it matters:** the spec's entire resilience promise for the most likely real-world failure — a model returning prose instead of JSON — is inverted. Instead of three bounded retries and a clean escalation to a human, the workflow dies on contact, leaving the packet in a failed state with no BLOCKED handoff. Root cause is the retryability classification at the trust boundary, **not** the workflow catch — patching only the catch would be a symptom-point fix (BAD #4). The verdict is BROKEN rather than DRIFTED because the canonical path actively does the _opposite_ of the invariant on first occurrence, not a weakened or misplaced version of it. Note the spec wording itself never reconciled the two mechanisms ("retriable, 3 attempts" maps to Temporal activity retry; "then BLOCKED + escalate" maps to the fix-loop/escalate path) for the malformed case.

## DRIFTED invariants

### SPEC-2 — Builder ≠ Reviewer; different family; fresh; no retry memory

**Contract said** (docs/SPEC.md:14): builder and reviewer must differ, be of different model families, run as fresh instances, and carry no memory of prior review on retry — enforced on the canonical workflow trust boundary.

**Code does:** the cross-family check (`validateBuilderReviewerCrossFamily`, semantic-validators.ts:148-156) is correct but runs **only at the CLI pre-start boundary** (build.ts:80, before `client.workflow.start` at build.ts:120), never on the workflow path. `loadManifestActivity` (load-manifest-activity.ts:28-47) calls only `ManifestSchema.parse` (loader.ts:16-21) — no semantic validators. `preflightActivity` runs only `validateAdrIdsResolvable` (preflight.ts:91). The schema declares builder/reviewer as independent enums with no cross-field refinement (schema.ts:97-98), so `builder:"claude"` + `reviewer:"claude"` parses cleanly. **The "fresh instance / no memory on retry" sub-clause IS honored** (prepareContextActivity rebuilds per attempt; reviewer is a fresh CLI process per attempt).

**Maps to audit finding:** none.

**Why it matters:** any non-CLI workflow start (direct `client.workflow.start`, replay, a future API/chat entrypoint) bypasses the cross-family guarantee entirely. The dominant clause of the invariant is enforced in the wrong process. Fix: run the validator inside `loadManifestActivity`/`preflightActivity` and throw a non-retryable `CROSS_FAMILY_VIOLATION`; add a Zod `superRefine` so the manifest fails closed at parse time.

### SPEC-3 — No phase runs without prerequisites (Temporal transitions)

**Contract said:** no phase runs without its prerequisites, enforced by Temporal workflow transitions, no exceptions.

**Code does:** `resolvePhaseOrder` (build-packet.ts:472-474, _verified directly_) sorts by `dependsOn.length` — a **count**, never dependency **identity** — and is consumed sequentially at :108. A real Kahn toposort exists (semantic-validators.ts:50-74, 189-206) but is wired only to cycle _validation_; its sorted array is discarded. The workflow trust-boundary gate (`preflightActivity`, preflight.ts:91) checks only ADR IDs, never `dependsOn`. The real dependency check is a CLI pre-flight (build.ts:80) in a different process.

**Maps to audit finding:** none.

**Why it matters:** the length-sort matches topological order **only for monotonic linear chains** (the 11a→11b→11c→11d manifests currently shipped). Any diamond or non-monotonic DAG silently reorders a phase ahead of its prerequisite. Not BROKEN because the CLI gate plus linear manifests mean no prerequisite is _currently_ violated in production — the drift is latent and triggers on the first non-linear manifest. Fix: have `resolvePhaseOrder` consume the existing toposort and move dependency/cycle validation into `preflightActivity`.

### SPEC-6 — Every claim cites a source (Review → file:line)

**Contract said:** every claim cites a source; Review findings carry file:line.

**Code does:** the citation field is plumbed end-to-end (requested in the reviewer prompt at dispatch-review.ts:226, validated as a field, persisted, rendered into the fix-brief) but **no layer rejects an uncited claim**. `ReviewFindingSchema` accepts `file: z.string()` (allows `''`) and optional `line` (dispatch-review.ts:285-292). The workflow coerces empty file to the literal `"packet"` (build-packet.ts:513, _verified directly_). DB columns are nullable (schema.sql:75-76). No L5 gate (G1-G7) checks for citations. The Build→spec-sections arm is README self-check prose only (src/README.md:84); Research→URLs has no code locus on the canonical path.

**Maps to audit finding:** none.

**Why it matters:** the invariant is honored only when the reviewer model voluntarily complies — the trust boundary does not enforce it. Falsifiable: a P0 finding with `file:''` and no line passes `ReviewReportSchema.parse` and blocks the phase with the file coerced to `"packet"` — no source, no rejection. Fix: tighten the schema to require non-empty file (and line for code-located dimensions) and fail the parse on uncited P0/P1 findings instead of silently coercing.

### SPEC-9 — Secrets never enter prompts (denylist + entropy before every dispatch)

**Contract said:** secrets never enter prompts; denylist + entropy scanner enforced before **every** dispatch.

**Code does:** `prefilter` (filter.ts:78) is correct but has exactly **two production callers** — dispatch.ts:237 (legacy `dispatchAgent`, invoked only by `pipeline.ts`) and chat/prompt-builder.ts:72 (chat). _(Verified directly: a non-test grep for `prefilter(` returns precisely these two sites.)_ The canonical build dispatch (`dispatchAgentActivity`) and all three review dispatches (`dispatchReviewActivity`) have **zero** prefilter calls; upstream `prepareContextActivity` is also unscanned.

**Maps to audit finding:** none.

**Why it matters:** on the path that actually runs `zer0 build`, neither the denylist nor the entropy scanner runs before any dispatch. Concrete leak vector: `prepareContextActivity` compiles project files and brief sections into `promptText`; any committed secret reaching the brief is shipped to `dispatch.sh` → the external agent CLI with no gate. Not BROKEN (the workflow does not actively leak — it simply never checks). Fix: hoist `prefilter` into `dispatch-agent-activity.ts` and `dispatch-review.ts` (or into `prepare-context.ts` before `promptText` leaves the trust boundary); add a falsifying test injecting a high-entropy token.

### SPEC-10 — P0 blocks unconditionally; no auto-override; human approval with logged reason

**Contract said:** P0 findings block unconditionally; no automated override; human approval with a **logged reason**.

**Code does:** Clause 1 ("P0 blocks") is HONORED — `blockingFindings` gates both loops (build-packet.ts:218, :418). Clause 2 ("no automated override") is safe — the timeout branch throws `FIX_LOOP_EXHAUSTED` rather than sealing. **Clause 3 ("logged reason") is NOT implemented**: the unblock signal `humanInterventionResolvedSignal` is a no-arg signal (build-packet.ts:87-88) whose handler just sets `state.humanResolved = true` (:173-176) — no reason argument, no persisted approval record, no `recordPhaseEvent`. After resolution, `runFinalReviewLoop` returns the **same review object that still has `hasBlockingFindings === true`** (:433-434, _verified directly at :433_) and the caller seals unconditionally with no P0 re-check (:115-133, :446-453).

**Maps to audit finding:** none.

**Why it matters:** a human can release a live-P0 packet to DONE with **zero audit trail of why**. BLOCK-worthy gap: persist a `HumanApprovalRecord{runId, phase, findingIds, reason, approver, ts}` before honoring `humanResolved`, change the signal to carry a required reason payload, and re-assert P0 absence (or mark the packet OVERRIDDEN, not DONE) before `sealPacket`. Separately, P1 sharing the exact P0 code path (:476-480) is a weakening worth a DECISION — SPEC-10 names P0 specifically as the unconditional class.

### SPEC-13 — Evidence is content-addressed blobs

**Contract said:** evidence is content-addressed blobs, not just hashes; every prompt, context pack, diff, stdout, stderr stored.

**Code does:** the blob store (`putBlob`, blobs.ts:45) is correctly built but its only non-test caller (`persistDispatchEvidence`, evidence.ts:172) is wired **only into the legacy `pipeline.ts`** (:296,325,365). The canonical `buildPacketWorkflow` (what `zer0 build` starts, build.ts:120) contains **zero** `putBlob`/`persistDispatchEvidence`/`blobRoot` references. On the canonical path: (1) prompt → tmp file then deleted (dispatch-agent-activity.ts:167,144); (2) stdout+stderr → inline JSON in `dispatch_claims.result_json` (dispatch-claims.ts:103-104); (3) diff → never stored, regenerated via `git show` (diff-compiler.ts:54,87-89); (4) context pack → sha256 fingerprint only (prepare-context.ts:106). Even legacy `persistDispatchEvidence` blobs only stdout and hardcodes stderr to `""` (evidence.ts:284).

**Maps to audit finding:** Zer0 two dispatch paths (canonical `buildPacketWorkflow` vs legacy `pipeline`).

**Why it matters:** the spec's literal claim ("every prompt, context pack, diff, stdout, stderr stored as content-addressed blobs") is met for **none** of the five evidence types on the canonical path, and **1 of 5** (stdout) on the legacy path. Columns `dispatches.{stdout_blob, stderr_blob, diff_blob, context_blob_hash, prompt_hash}` exist (schema.sql:103-114) but are unpopulated on the running path. Fix: add `putBlob` calls inside the canonical dispatch activity and store the hashes in the existing columns.

### GENESIS-3 — CLI unavailable degrades to Claude-only (no crash, no block, logged warning)

**Contract said** (three-chairs-spec/spec.md:61): an unavailable CLI must degrade to Claude-only — no crash, no block, logged warning.

**Code does:** the **no-crash half is HONORED** at the adapter boundary (every `healthCheck` catches and returns `{healthy:false}` — codex.ts:150-156, gemini.ts:217-227, claude.ts:177-183; doctor.ts:90-104 surfaces without throwing). The **no-block / Claude-only half is NOT enforced on the canonical path**: the only failover mechanism (`AdapterRegistry.dispatchWithFailover`, registry.ts:87-107) is **dead code** — its only caller is registry.test.ts:70. The canonical workflow calls `dispatchAgentActivity({ agent: phase.builder })` → `dispatch.sh check_cli` exits 1 on a missing CLI → `build.exitCode !== 0` (build-packet.ts:322) → **retries the same unavailable agent** up to `maxFixLoopsPerPhase` → `escalateExhausted` → `waitForHumanResolution` **blocks up to 24h** (DEFAULT_ESCALATION_TIMEOUT_MS, build-packet.ts:36,290).

**Maps to audit finding:** none.

**Why it matters:** an unavailable codex/gemini builder retries-then-blocks-on-human rather than degrading to Claude — the no-block half is effectively broken on the path that runs (the no-crash half surviving is why this is DRIFTED, not BROKEN). The fallback exists only as unwired registry code. Also absent: the session-start TRIO/DUO/SOLO availability report (spec.md:944-946). Fix: detect unavailable builder/reviewer pre-dispatch (or on ENOENT), reassign to claude with a logged warning.

### GENESIS-6 — Union rule for P0; dismiss only with mechanical counter-evidence

**Contract said** (three-chairs-spec/spec.md:64,:766): ANY model finding a P0 = investigate; the coordinator may dismiss only with mechanical counter-evidence.

**Code does:** per-phase union is present but weakened: `reviewPhase` concatenates both reviewers' blocking findings with no dismissal step (build-packet.ts:392), so any reviewer's P0 blocks. But: (1) both reviewers are **same-family** (claude + claude-deep-audit; schema.test.ts:67-77 explicitly rejects gemini as reviewer) — the heterogeneous "ANY model" set collapsed to one family; (2) `blockingFindings` folds P0 and P1 together by severity (build-packet.ts:476-480) — no distinct P0 union-investigate semantics; (3) the "dismiss only with mechanical counter-evidence" half is **entirely absent** (no file-existence/sed falsification gate in the review flow); (4) the **final sealing gate is single-reviewer** (`runFinalReview`, build-packet.ts:395-404) — zero union where it matters most.

**Maps to audit finding:** none.

**Why it matters:** the decisive packet-sealing gate has no union at all, and the coordinator's hallucination-detection table (spec:766+) is uncodified — findings are dropped or kept by severity, never investigated then falsified. Fix: make final review a multi-reviewer (ideally cross-family) union and add a mechanical-counter-evidence dismissal activity.

### GENESIS-10 — Anti-sycophancy by default; every prompt hostile-framed; no "looks good"

**Contract said** (Three Chairs line 68): every prompt (builder AND reviewer) uses hostile framing; no "looks good" reviews.

**Code does:** the **reviewer half is enforced** — `JSON_OUTPUT_CONTRACT` ("You are a hostile code reviewer…") is unconditionally first in `reviewPrompt` (dispatch-review.ts:216,202-214), and free-text "looks good" is structurally impossible (schema admits only verdict enum + structured findings, :294-301). But two drifts: (1) the hostile content is only the **label** plus output mechanics — the substantive adversarial instruction lives in the rubric, which is passed as a **bare name** (`rubric: "L5-HOSTILE-REVIEW-RUBRIC"`, build-packet.ts:372) and interpolated as just `Rubric: ${input.rubric}` (dispatch-review.ts:206); the rubric body is never expanded into the prompt. (2) the **builder half is absent** — `prepareContextActivity` emits only PHASE CONTEXT / PRIOR COMMITS / SOURCE BRIEF (prepare-context.ts:230-244) with no rejection framing; the one builder anti-sycophancy hook (`generate-fix-brief.ts:79-83` BANNED PHRASES) is **dead code** (never proxied by the workflow).

**Maps to audit finding:** none.

**Why it matters:** the invariant says "every prompt," but the builder prompt carries zero hostile framing on the canonical path, and the reviewer carries only the label, not the "assume the author is wrong / looks-good-is-not-acceptable" substance. Fix: expand the rubric body into `reviewPrompt`, inject builder rejection-framing into `prepareContextActivity`/`project-context` output, and wire `generateFixBriefActivity` if the fix-loop is meant to use it.

## ASPIRATIONAL invariants

These were promised in the spec but never built. They are **scope, not bugs** — call them out honestly and queue them, but do not treat them as regressions.

### SPEC-12 — Prompt templates must pass Promptfoo evals

The only Promptfoo code is a Phase-0 "framework loads" smoke spike against an echo provider (spike/05-promptfoo.ts:5-7,44-50) — it evaluates no real template and is wired into no gate. The canonical `gates` chain (package.json:33) has no eval step; no `promptfooconfig.*` exists; no `src/templates/` or `src/eval/` dir. The project's own docs concede this (SPEC-ADDENDUM.md:78 "never validated… unverified"; PLAN.md:120-122 plans an unbuilt runner). Prompt templates ship completely ungated by evals; the Promptfoo dependency is unused scaffolding.

### SPEC-14 — Context is a Hot + Warm + Cold memory hierarchy (simultaneously)

The canonical path assembles `promptText` as a **flat concatenation** (prepare-context.ts:230-283); there is no Hot/Warm/Cold partition, no `.d.ts` compression, no dual-signal scoring. `dispatch.ts:279-297` wraps the single `promptText` in exactly **one** `{kind:"hot", score:1}` item; "warm"/"cold" are emitted only in test fixtures. The planned `src/context/{hot,warm,cold}-tier.ts` files do not exist. Warm and Cold were never built; Hot is a degenerate single-item wrapper.
**Maps to:** 2026-05-27-claude-audit.md:272 (I-14 "STUBBED") + finding K8 at :493 (P0, queued as packet-14). This is a known, tracked gap.

### SPEC-15 — Every enrichment is a hypothesis; removed after 20+ dispatches with no gain

No measurement loop exists. `enrichment_flags` (schema.sql:110) is dead storage — every `INSERT INTO dispatches` omits the column. `ContextPack.enrichmentFlags` is hardcoded `[]` at every construction site (dispatch.ts:283, chat/prompt-builder.ts:90). A grep for `acceptance_rate|removeEnrichment|"20…dispatch"` returns nothing. The schema column and DTO field are placeholders; the 20-dispatch removal protocol has zero implementation.

### GENESIS-12 — Google Search grounding via Gemini; external claims verified before prompt

No claim-extraction → Gemini-grounded-verification → gate-before-prompt mechanism exists on any path. The canonical workflow has no research/grounding phase (`prepareContextActivity` assembles from **local** artifacts only). Gemini is structurally banned from the build path (`BuilderSchema = z.enum(["claude","codex"])`, schema.ts:18-21). Legacy `pipeline.ts` lists "research" in `PIPELINE_PHASES` but the body only dispatches on `build`/`review` — research/spec/architecture/plan are no-op transitions. The grounding directive lives only in prose (GEMINI.md:62-84, ROUND_TABLE.md:107). Consistent with project memory (RECON/INTENT/Q&A/RESEARCH/SPEC/ARCH/PLAN are stubs). Honoring this requires net-new activity work.

## HONORED invariants

Genuine credit — these hold on the canonical `buildPacketWorkflow` path, enforced at the right trust boundary.

- **SPEC-1 (deterministic control):** every branch — phase ordering, fix-loop bound, build/gate/phase pass, escalation — is driven by deterministic config and subprocess exit codes, never by an agent deciding what runs next; the agent boundary (`dispatchReviewActivity`) is a pure worker emitting a zod-validated report. _One internal inconsistency worth a YELLOW hardening item, not a downgrade:_ the final-review loop trusts the agent-emitted `hasBlockingFindings` boolean directly (build-packet.ts:418,431, _verified_) whereas the per-phase path re-derives via `blockingFindings()`. Recommend re-deriving in `runFinalReviewLoop` for symmetry.
- **SPEC-4 (fresh per-call context):** `prepareContextActivity` rebuilds state + prompt + fingerprint from scratch every attempt (builder loop :210, final loop :425); all non-determinism is confined to the Activity boundary, so replay is deterministic. (DECISION-worthy caveat: the fingerprint hashes only brief + phase + attempt + failure-count, not the live compiled bytes — a traceability weakness if ever used as a cache key, not a freshness/replay violation.)
- **SPEC-5 (Temporal owns state):** state lives in replay-deterministic in-memory state; progress is read via the `statusQuery` Temporal query; the workflow file contains no fs/JSON access. SQLite is evidence-only; `StateWriter`/`state.json` is an unwired display projection (dead path) — a YAGNI follow-up, not a SPEC-5 violation.
- **SPEC-8 (isolatedDeclarations):** `isolatedDeclarations:true` + `declaration:true` are live (tsconfig.json:28,36); the `typecheck` gate runs in the canonical path and fails the phase on non-zero `tsc` exit. Empirically verified: clean tree exits 0; an injected export without a return type produced TS9007. Soft spot: `typecheck` is a per-manifest gate entry, not a workflow-level mandatory floor — recommend a validator mandating it for any phase owning `*.ts`.
- **SPEC-11 (gates decide completion):** the builder's `DispatchResult` has no done/self-declare field (dispatch-agent-activity.ts:25-30); completion is jointly gated by mechanical gate exit codes (run-gates.ts:131,171) and an independent reviewer's P0/P1 findings; DONE is reachable only after the final loop exits with no blocking findings. (The prompt's named `build-gate.ts` is the legacy CLI gate; the canonical gate is `runGatesActivity` — invariant holds either way.)

## Interpretation

The codebase is faithful to its **founding control architecture** but has drifted on its **founding enforcement placement**. The five HONORED invariants are not incidental — they are the load-bearing spine (deterministic control, Temporal state, gate-decided completion, fresh context, type safety), and they hold precisely because they were built _into_ the canonical `buildPacketWorkflow` trust boundary. The nine DRIFTED invariants share one root pattern that the project memory already named ("Zer0 two dispatch paths"): correct mechanisms wired to the **CLI pre-flight or the legacy `pipeline.ts`** instead of the path `zer0 build` actually runs — cross-family, prerequisite-ordering, citations, secrets-prefilter, and evidence-blobs are all "right idea, wrong place." Of the drifts, **SPEC-13 is already covered** by the remediation plan (it maps to the documented two-dispatch-paths finding), and **SPEC-14 is tracked** (packet-14, K8); the rest — SPEC-2, SPEC-3, SPEC-6, SPEC-7, SPEC-9, SPEC-10, GENESIS-3/6/10 — are **newly surfaced here** and not yet on a remediation track. The single founding principle most at risk of being **silently abandoned** is **SPEC-9 ("secrets never enter prompts")**: it is fully built, has passing tests, and _looks_ enforced — but those tests cover only the legacy path, so the green checkmark masks a canonical-path bypass that ships unscanned `promptText` to external CLIs. SPEC-7 (BROKEN) is the most urgent, but SPEC-9 is the most insidious — a security invariant that is one mis-read test away from being assumed safe.
