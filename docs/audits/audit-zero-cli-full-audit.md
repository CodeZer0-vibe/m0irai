# zer0-agent-ci — Full Audit (audit)

## Verdict

**SHIP-BLOCKED.**

Eight confirmed BLOCKs survive double-verification, and they cluster in two failure domains the system exists to guarantee. The data-loss/liveness cluster (TEMPORAL-1 non-idempotent commit orphaning, TEMPORAL-2 reject-then-cancel deadlock, TEMPORAL-3 length-sort masquerading as toposort, CONCURRENCY-1 lease TOCTOU) breaks the durable-execution and single-writer invariants the orchestrator is built on. The security cluster (DISPATCH-SEC-1 read-only reviewer escape, DISPATCH-SEC-2 / ERROR-FAILURE-2 missing prefilter on the canonical build path, DISPATCH-SEC-3 env-allowlist no-op) means SPEC invariant 9 ("denylist + entropy before EVERY dispatch") and Builder-not-Reviewer isolation are unenforced on the path `zer0 build` actually runs. The observability cluster (OBSERVABILITY-1/2/3) renders `zer0 inspect`/`cost`/`replay`/`status --watch` non-functional against real runs — diagnosability fails exactly when an operator needs it. The remaining 23 confirmed DECISIONs are mostly contained to the deferred legacy pipeline, defense-in-depth gaps, or doc drift, but the BLOCKs are not optional and several share the same root cause (canonical-path security wiring) so a single coordinated fix retires three of them. Two findings remain disputed with split verifier verdicts and need human adjudication on severity (CONCURRENCY-2, CONCURRENCY-3, TEST-QUALITY-1).

## Scorecard

| Dimension     | BLOCKs | DECISIONs | NITs  | Coverage note                                                               |
| ------------- | ------ | --------- | ----- | --------------------------------------------------------------------------- |
| TEMPORAL      | 3      | 1         | 0     | Read all workflows + activities; depcruise on lease.ts                      |
| DISPATCH-SEC  | 3      | 3         | 0     | Tested; empirical execa 9.6.1 env-leak repro                                |
| CONCURRENCY   | 1      | 1         | 0     | Static; real-git TOCTOU trace; 2 disputed (CONCURRENCY-2/3)                 |
| ERROR-FAILURE | 2      | 4         | 0     | Full error infra + all 21 activities traced; SDK failure-converter verified |
| ARCH          | 0      | 8         | 0     | Full 259-module read; knip 0 dead / dep-cruiser 0 errors                    |
| EVIDENCE-DB   | 0      | 0         | 0     | Tested; EVIDENCE-DB-1 refuted                                               |
| TEST-QUALITY  | 0      | 5         | 1     | CI config + integration suite; 1 disputed (TEST-QUALITY-1), 1 refuted       |
| SPEC-DRIFT    | 0      | 3         | 3     | All canonical docs cross-checked at file:line                               |
| CHAT-CLI      | 0      | 4         | 1     | All 21 commands + chat modules; 2 refuted (boot probe repro)                |
| OBSERVABILITY | 3      | 4         | 1     | Full producer/consumer trace of events/errors/dispatches                    |
| **Total**     | **8**  | **23**    | **7** | 3 disputed verdicts pending human call                                      |

## Confirmed BLOCKs

Grouped by blast radius: data-loss / determinism / liveness first, then security, then correctness / diagnosability.

### Cluster A — Data-loss, determinism, liveness (Temporal + concurrency)

#### TEMPORAL-1 — commitActivity not idempotent on retry

- **File:** `src/temporal/activities/commit.ts:73-93` (commit then markApplied; assertStagedChanges nonRetryable throw)
- **Claim:** A worker crash after `git commit` (line 73) but before `markApplied` (line 75) leaves the intent row `status="pending"` with the commit already in HEAD. On retry the idempotency guard (`readAppliedIntent`, only fires on `status="applied"`) returns null, execution falls through to `assertStagedChanges`, which throws `NO_FILES_TO_COMMIT` with `nonRetryable:true` (lines 87-91) because the staged change was already consumed by the prior commit.
- **Evidence:** Verified end-to-end against the Temporal SDK and reproduced with real git in `/tmp/zer0-commit-repro`: `git diff --cached --quiet -- changed.txt` exits 1 pre-commit (assert passes) and exits 0 post-commit (assert throws). Retry reuses the identical `intentKey` (`commit:${runId}:${phase}:${attempt}`, build-packet.ts:572) under `maximumAttempts:3` (build-packet.ts:79). `commitBeforeReview` (build-packet.ts:349) and `sealPacket` (:448) have no try/catch; the top-level catch (build-packet.ts:135-140) rethrows non-cancellation.
- **Impact:** Orphaned commit sits in git HEAD with intent stuck "pending"; the build hard-fails terminally and is unrecoverable without manual git surgery. Violates the activity's own stated contract (commit.ts:3 "Creates idempotent git commits").
- **Fix:** On a pending intent whose commit already landed (HEAD message/tree matches the intent), reconcile to "applied" instead of re-asserting staged changes. Add a falsifying test exercising the crash-before-markApplied window.

#### TEMPORAL-2 — `condition(!rejected)` deadlocks reject-then-cancel

- **File:** `src/temporal/workflows/build-packet.ts:308-310` (bare `await condition(() => !state.rejected)`, no timeout)
- **Claim:** The cancel handler (161-163) sets only `state.cancelled`, never clears `state.rejected`; `cancelSignal` is a custom `defineSignal` (line 80), not native Temporal cancellation, so it raises no `CancelledFailure` to break the parked condition. After a reject (rejected=true) parks the next iteration at line 309, a subsequent cancel sets cancelled=true but leaves rejected=true → predicate `!state.rejected` is false forever.
- **Evidence:** Contrast line 290 which DOES pass `escalationTimeoutMs`; line 309 passes none. Only `approveSignal`/`humanInterventionResolvedSignal` reset rejected. The `finally` lease release (line 142) never runs while parked. `pipeline.ts:268-271` uses the correct pattern (`|| state.cancelled`). No test covers reject-then-cancel (build-packet.test.ts:230-248 cancels early).
- **Impact:** A cancelled build wedges forever and holds the packet lease indefinitely; all future builds of that packet are blocked until escalation timeout or worker kill. Liveness violation — a cancel that cannot cancel.
- **Fix:** `await condition(() => !state.rejected || state.cancelled)`, mirroring pipeline.ts:268-271 and the existing line-319 cancel short-circuit.

#### TEMPORAL-3 — resolvePhaseOrder length-sort, not topological sort

- **File:** `src/temporal/workflows/build-packet.ts:472-474` (`sort((l, r) => l.dependsOn.length - r.dependsOn.length)`)
- **Claim:** Phases are ordered by dependency _count_, not topological depth. Counterexample (admissible under schema.ts:46,61): Phase X `dependsOn ["A","B","C"]` (key 3), Phase Y `dependsOn ["X"]` (key 1) → length-sort emits Y before its prerequisite X.
- **Evidence:** This is the live execution order — consumed sequentially at build-packet.ts:108-109 with no other ordering guard, and `runPhase` passes `priorCommits` (line 210) so order is load-bearing on accumulated commits. A real Kahn toposort exists at semantic-validators.ts:189-206 (`drainDependencyQueue`) but its output is discarded — used only for cycle detection (line 64-65 compares `.length` to `names.size`). ARCHITECTURE-buildPacketWorkflow.md:15 states "No phase runs without prerequisites … No exceptions."
- **Impact:** Silent out-of-order execution corrupts dependent-phase builds with no error signal; violates SPEC invariant 3. Ships undetected because linear chains coincidentally sort correctly.
- **Fix:** Replace the length-sort with the existing deterministic `drainDependencyQueue` Kahn toposort; keep it replay-pure. (Note: cited reference path is `src/temporal/manifest/semantic-validators.ts`, not the workflows dir — the primary defect file:line is exact.)

#### CONCURRENCY-1 — Lease TOCTOU: unconditional rmSync before wx-create

- **File:** `src/cli/lease.ts:65-68` (line 65 `rmSync(path, {force:true})`, line 68 `writeAtomic` with `flag:"wx"`)
- **Claim:** On the stale-reclaim path, two racers A and B both observe the same stale lease (existing!==null, both pass isActive). A reclaims and publishes; B's unconditional `rmSync` then DELETES A's freshly-published lease, and B's `wx` create succeeds against the now-empty path. Both hold a `LeaseHandle` for one packet.
- **Evidence:** Verified against lease.ts:56-75 and the SDK; cold-start is safe (both see null, `wx` exclusive-create serializes — lease.test.ts:62-74 passes), but the stale-reclaim interleaving is genuinely reachable under a Temporal activity-retry storm plus operator re-run after a PID-dead stale lease, and is untested (the existing race test uses an empty tempRoot). No flock/advisory lock exists (grep confirmed). Root cause: the delete is unconditional rather than a compare-and-swap against the observed stale record.
- **Impact:** DUPLICATE_RUN invariant broken; two concurrent builds mutate one git working tree (input.repoRoot, build-packet.ts:104) → interleaved git add/commit, index corruption, lost work.
- **Fix:** `wx`-create first; CAS-delete only if the on-disk record still equals the observed stale record before deleting.

### Cluster B — Security (canonical-path trust boundary)

#### DISPATCH-SEC-1 — Read-only review-sandbox contract unenforced

- **File:** `src/temporal/activities/dispatch-review.ts:175-179` (`defaultDispatch` execa call with NO `env`)
- **Claim:** `dispatchReviewActivity` validates `sandbox: z.literal("read-only")` (schema line 100) but never forwards it. `defaultDispatch` calls `execa("bash", [...], {reject:false, shell:false, timeout})` with no env, so `dispatch.sh:68` falls to `CODEX_SANDBOX:-workspace-write` and a codex reviewer runs `codex exec --sandbox workspace-write` (line 72).
- **Evidence:** The `sandbox` field is dead after Zod validation (never read in the activity body 104-124). Worker registers the bare `activities` barrel (worker.ts:80, index.ts:22), so `deps` defaults to `{}` and `defaultDispatch` is the live path; the dispatchFn seam is test-only. Contrast dispatch-agent-activity.ts:136 which DOES set `env:{CODEX_SANDBOX: input.sandbox}`. `validateBuilderReviewerCrossFamily` (semantic-validators.ts:148) forces builder≠reviewer family, making claude-built/codex-reviewed the common case.
- **Impact:** A contractually read-only reviewer can mutate the worktree it audits — defeats Builder-not-Reviewer isolation and the commit-before-review guarantee; a reviewer could silently edit code to make its own verdict PASS, then `persistReviewFindings` writes the corrupted verdict to the evidence ledger.
- **Fix:** In `defaultDispatch`, pass `env` derived from `input.sandbox` (`CODEX_SANDBOX: "read-only"`, `GEMINI_MODE: "review"`) with `extendEnv:false`. Falsifying test asserting the review child env carries `CODEX_SANDBOX=read-only`.

#### DISPATCH-SEC-2 / ERROR-FAILURE-2 — Security prefilter absent on the canonical build/review dispatch

- **File:** `src/temporal/activities/dispatch-agent-activity.ts:77-146` (no prefilter call anywhere in file); also `dispatch-review.ts:201-214`
- **Claim:** SPEC invariant 9 requires denylist + entropy scan before EVERY dispatch. The canonical `dispatchAgentActivity` writes `input.promptText` straight to a temp file and execs `dispatch.sh` with no scan; `dispatchReviewActivity` ships the raw committed git diff. Only the legacy `dispatch.ts:237` and chat `prompt-builder.ts:72` call prefilter.
- **Evidence:** Two independent verifiers confirmed; grep shows prefilter imported only in dispatch.ts:16, prompt-builder.ts:10, and tests — NOT dispatch-agent-activity.ts. `build-packet.ts:311-318` feeds `contextPack.promptText` (assembled from brief + ADRs + prior commits + findings + git diff + memory by prepareContextActivity, prepare-context.ts:246-278, all unscanned) directly into the activity. The legacy prefilter-bearing `dispatchAgent` is reachable only from the legacy `pipelineWorkflow` (pipeline.ts:274,301), not `buildPacketWorkflow`. SPEC.md:21/418, ROUND_TABLE.md:25,75 state the invariant unconditionally; SPEC.md:635 already logs "Security prefilter coded but NEVER CALLED from dispatch" as a prior failure class.
- **Impact:** Secrets in any assembled context section reach remote third-party models (codex/gemini) verbatim on every build attempt and every review — the exact exfiltration the invariant exists to prevent, on the highest-traffic path.
- **Fix:** Run `prefilter(contextPack(promptText, ...))` at the top of `dispatchAgentActivity` (and on the review prompt) before subprocess spawn; throw `SecurityPrefilterBlocked` (non-retryable, after_human) mirroring dispatch.ts:230-255. Falsifying test injecting a key-shaped string. (DISPATCH-SEC-2 and ERROR-FAILURE-2 are the same defect surfaced by two dimensions; fix once.)

#### DISPATCH-SEC-3 — Child-env allowlist is a no-op (missing `extendEnv:false`)

- **File:** `src/adapters/claude.ts:96-107, 334-343` (also codex.ts:92-103, gemini.ts:109-120, dispatch-agent-activity.ts:136)
- **Claim:** execa 9.6.1 only restricts the child to the `env` object when `extendEnv:false`; the default is true. No call site sets it, so `whitelistedEnv()` only ADDS keys and cannot remove any — every parent env var still reaches the child.
- **Evidence:** Verified against execa runtime source `options.js:83` (`extendEnv ? {...process.env, ...envOption} : envOption`) and `:47` (default true). Repo-wide grep for `extendEnv` in src/ returns NO matches. Empirically reproduced: parent-only `SECRET_LEAK_CANARY` reaches the child with the exact option shape (`LEAKED:true`); `extendEnv:false` closes it (`LEAKED:false`). `whitelistedEnv()` builds a deliberate minimal allowlist (CHILD_ENV_KEYS + AUTH_ENV_VARS) — unambiguously a security control by intent.
- **Impact:** Defeats the env trust boundary; any worker-environment secret (AWS keys, GH tokens, DB URLs) is exposed to claude/codex/gemini CLIs and their remote backends. The code reads as a security control but enforces nothing.
- **Fix:** Add `extendEnv:false` to every adapter `run` + `healthCheck` execa call and to dispatch-agent-activity.ts:136. Falsifying test: set `SECRET_LEAK_CANARY` in the parent, spawn an adapter against a script echoing env, assert the canary is absent.

### Cluster C — Diagnosability (observability commands non-functional)

#### OBSERVABILITY-1 — Disjoint event-kind vocabularies crash `zer0 inspect`/`cost` on every real run

- **File:** `src/observability/schemas/event.ts:9-31`; `src/observability/inspect.ts:42,159`; `src/evidence/phase-events.ts:12-36`
- **Claim:** Production `buildPacketWorkflow` writes `events.kind` from PHASE_EVENT_KINDS (`packet.started`, `phase.started`, …, dot-delimited); the inspector validates against EVENT_KINDS (`phase-enter`, `state-snapshot`, …, hyphen-delimited). The two sets share zero members, so `EventSchema.parse({kind: row.kind})` throws `ZodError`.
- **Evidence:** Both verifiers traced it against the SDK. `build-packet.ts:102` writes `packet.started` unconditionally on every run; `schema.sql:145` is `kind TEXT NOT NULL` with no CHECK; `queryEventsByRun` (queries-statements.ts:173-175) is `SELECT *` with no kind filter; `inspect.ts:41` maps ALL rows through `toEvent` → `EventSchema.parse` with no try/catch. `cost.ts:19` calls `inspectRun` and `router.ts:229` calls `runCost` with no outer guard → uncaught crash. Existing test (inspect.test.ts:86) inserts only `state-snapshot`, passing vacuously.
- **Impact:** After any real build, `zer0 cost` crashes and `zer0 inspect` fails to reconstruct the run — diagnosability dead exactly when most needed.
- **Fix:** Unify the event-kind vocabulary into one source of truth (widen EVENT_KINDS or map phase-event kinds at write time). Falsifying test inserting a real `packet.started` row and asserting `inspectRun` succeeds.

#### OBSERVABILITY-2 — `zer0 replay` non-functional: no path populates `dispatches.argv_json`/`cwd`

- **File:** `src/observability/replay.ts:51-53`; dispatch-agent-activity.ts:237-254; evidence.ts:175-182; chat/evidence.ts:103-115
- **Claim:** `buildReplayPlan` throws `DispatchError("dispatch row lacks replay-complete argv or cwd")` whenever `argv_json` or `cwd` is null, but no producer ever writes those columns.
- **Evidence:** Canonical `dispatchAgentActivity` writes only `dispatch_claims` (never a `dispatches` row); legacy `persistDispatchEvidence` and `chat/evidence.ts` omit `argvJson`/`cwd`; `queries-params.ts:142-143` defaults both to null; the only non-null setter is the test fixture `replay.test.ts:80`. No UPDATE backfills them (grep confirmed). `zer0 replay` is a shipped, router-wired command (cli/commands/replay.ts:17, router.ts).
- **Impact:** The frozen-dispatch replay capability is dead end-to-end for every real dispatch — a shipped CLI command that can never succeed against real data.
- **Fix:** Have `dispatchAgentActivity` (or `persistDispatchEvidence`) write a `dispatches` row with `argv_json`, `cwd`, `model_version`, `repo_commit`; until then, gate or remove the replay command.

#### OBSERVABILITY-3 — `zer0 status --watch` always fails: `state.json` snapshot has no production writer

- **File:** `src/cli/commands/status-watch.ts:17-23`; `src/observability/state-writer.ts:36-95`; `src/cli/router.ts:248-252`
- **Claim:** `runStatusWatch` reads `.zer0/runs/<id>/state.json` and returns exit 3 if absent; the only writer is `StateWriter.writeAtomic`, which is instantiated only in its own test.
- **Evidence:** Both verifiers confirmed. Grep `new StateWriter` → only state-writer.test.ts:21,30; grep `StateWriter|writeAtomic|state.json` across src/temporal → zero matches; every `state.json` write in src is a test file. Non-watch `status.ts:89-124` uses Temporal+SQLite, never state.json. `inspect.ts:65-71` is a second orphaned reader. The CLI uses `process.exitCode` not `process.exit`, so the path is wired and reachable.
- **Impact:** `zer0 status --watch` always returns exit 3 on a real build; the 162-line crash-readable RunState artifact is never materialized at runtime.
- **Fix:** Persist `state.json` per phase transition via a workflow activity, OR repoint `runStatusWatch` at the Temporal/SQLite projection `status.ts` uses and retire the orphaned StateWriter/RunState subsystem.

## Confirmed DECISIONs

Operator/architect choices and tracked debt. All double-verified as accurate; severity correctly below BLOCK because each is contained to the deferred legacy path, is defense-in-depth, or is doc/UX drift rather than a live correctness/safety break on the canonical path.

### Security & dispatch hardening

- **DISPATCH-SEC-4** — `council` CLI spreads full `process.env` into the bash child and skips prefilter (`council.ts:153-164`). Blast radius bounded by `CODEX_SANDBOX=read-only` + first-party CLIs. Fix: reuse the `whitelistedEnv` allowlist pattern; optionally prefilter the council prompt.
- **DISPATCH-SEC-5** — Entropy/denylist prefilter misses most real secret formats (`entropy.ts:12` excludes dot/colon tokens, requires 32+ chars; `denylist.ts:28-64` matches file paths only, value rules gated behind an optional external file). Fragments JWTs/connection strings; bypasses AWS access key IDs (20 chars). Fix: dot/colon-aware tokenizer + format regexes + format-aware minimum length.
- **DISPATCH-SEC-6** — Legacy `dispatchAgent` throws raw `DispatchError` bypassing `nonRetryableErrorTypes` (`dispatch.ts:89-126`). Non-retryable codes get retried 3×. Bounded to the legacy pipeline. Fix: wrap in `activityErrorBoundary` or use `failureFor` with a code.

### Temporal / governance

- **TEMPORAL-4** — `lease.ts` dynamic-imports `src/cli` (`await import("../../cli/lease.js")`, lease.ts:11,73-74), evading the dep-cruiser `no-upward-deps-temporal-activities` gate (.dependency-cruiser.cjs:108-115). Governance gap, not a runtime crash. Fix: relocate lease; static import.

### Error-handling / failure-mode contracts

- **ERROR-FAILURE-1** — 13 of 21 activities lack `activityErrorBoundary`; their `z.ZodError` input-validation throws cross the boundary as a type-less failure (verified against SDK `errorToFailureInner`), miss `NON_RETRYABLE_ERROR_TYPES`, and get retried 3× instead of failing fast as `SchemaValidationFailed`. Bounded (deterministic → eventually fails) but wastes ~30s and produces opaque failures degrading `zer0 findings`. Fix: wrap each unwrapped export; consider a gate asserting every `activities/index.ts` export is wrapped.
- **ERROR-FAILURE-4** — Failed builder dispatch discards captured `build.stderr`/`stdout`, pushing a hardcoded `"builder dispatch failed"` (build-packet.ts:322-326). The next fix-loop attempt sees no error text. The F2 review-path fix solved this for findings but not for builder-process failures. Fix: thread truncated `build.stderr` into `AttemptFailure.message`.
- **ERROR-FAILURE-6** — `escalateActivity` is unwrapped and does mkdir+writeFile+appendEvent with no error isolation (`escalate.ts:49-61`); a failed marker write or `appendEvent` (EventTooLarge / ZodError) throws raw at the most critical recovery point, short-circuiting `waitForHumanResolution` (build-packet.ts:273-282). The escalation path has the weakest error handling — backwards. Fix: wrap in `activityErrorBoundary`; make marker write and event append individually resilient; proceed to `waitForHumanResolution` even if the marker write failed.

### Architecture / single-source-of-truth

- **ARCH-1** — Two parallel workflow stacks; the shared client API (`client.ts`) hardcodes legacy `pipelineWorkflow` handles and the `run-` ID prefix, so `zer0 status`/`status-watch`/`resume` cannot observe or resume a `build-<fp>-<packet>` run (status.ts:135-141 rejects the ID; resume.ts:102 sends the wrong-arity legacy `approveSignal`). cancel/approve/findings/cost work for builds; status/resume don't. Fix: generalize client helpers to be workflow-agnostic, or scope status/resume to legacy and add buildPacket-native equivalents; document which commands observe which workflow.
- **ARCH-2** — Legacy `dispatch.ts` inlines four `dispatch_claims` SQL statements byte-for-byte identical to `src/evidence/dispatch-claims.ts` helpers (dispatch.ts:332/336/357/374). Two `attemptHash` semantics already coexist for one table. Fix: delegate to the shared helpers or retire the legacy path. One owner per table.
- **ARCH-3** — Legacy `dispatchAgent` is the only proxied activity throwing a raw `Zer0Error` subclass without `activityErrorBoundary` (dispatch.ts:248,269); serializes as `type="DispatchError"`, misses `nonRetryableErrorTypes`, retried 3×. Verified against SDK `ensureApplicationFailure` (`type=constructor.name`, `nonRetryable:false`). Bounded to legacy `pipelineWorkflow`. Fix: wrap in boundary or convert throws to `ApplicationFailure.create` with the code as type.
- **ARCH-4** — `runAllValidators` (cross-family / cycle / overlap, SPEC invariant 2) runs only at the CLI `build.ts:80`; the in-workflow `loadManifestActivity` re-parses schema but never re-validates. A direct `client.start` (proven by the test suite's own direct-start) bypasses cross-family enforcement. `preflightActivity` already re-runs `validateAdrIdsResolvable` in-workflow, so the pattern exists. Fix: invoke `runAllValidators` inside `loadManifestActivity`, throw a non-retryable failure on issues.
- **ARCH-5** — `resolvePhaseOrder` count-sort (same code as TEMPORAL-3) couples ordering correctness to the CLI-only cycle validator; latent for future multi-phase manifests. Fix: same as TEMPORAL-3 — Kahn toposort via `drainDependencyQueue`; pair with ARCH-4 so the cycle check is workflow-enforced.
- **ARCH-6** — `DispatchMode` defined twice with disjoint value sets (`shared/types.ts:203` build/chat/research vs `chat/types.ts:14` text-only/tools/pipeline); `DispatchResult` defined three+ times. Disjoint literals mean TS catches most cross-imports, but the collision is a real review/auto-import hazard. Fix: rename chat-layer to `ChatDispatchMode`/`ChatDispatchResult`.
- **ARCH-7** — Finding entity modeled twice (`Finding` {path,finding,category} vs `ReviewFinding` {file,message,dimension,suggestedFix}), reconciled by an inline 3-line remap at dispatch-review.ts:141. Persistence drops `suggestedFix` AND `category` (no columns); `searchFindings` hardcodes `category:"evidence-search"` and documents the loss. Violates single-source-of-truth-per-entity. Fix: converge on one entity (ReviewFinding superset) with a tested mapper, or add the missing columns.
- **ARCH-8** — ~440 LOC of observability surface (otel/exporter 93, state-writer 95, agent-guide 151, schema-bundle 101) is tested but has zero production callers (10.3% of obs LOC). Pre-1.0 over-build carrying gate/typecheck cost without runtime behavior. (Note: one verifier corrected the finding's knip-laundering mechanism — they survive via the `*.test.ts!` knip entry, not the barrel — but the scale, severity, and remediation hold.) Fix: wire now, mark `@public` + tracking comment, or delete-and-resurrect at packet-13.

### Test quality

- **TEST-QUALITY-3** — `gate-clamps.mjs` and `gate-l5-mandates.mjs` have no falsifying tests; a vacuous-PASS regression goes undetected. Prior G5 vacuous-PASS precedent in project memory. Fix: add `*.test.mjs` with temp fixtures asserting a known violation is caught at file:line plus a clean PASS (mirror `adr-index-build.test.mjs`).
- **TEST-QUALITY-4** — Real-CLI smoke exercises only legacy `dispatchAgent`; canonical `dispatchAgentActivity` real-subprocess wiring (output-file read, `CODEX_SANDBOX` threading, dispatch.sh argv contract) has zero real-CLI coverage. Fix: add a `ZER0_REAL_CLI`-gated smoke importing `dispatchAgentActivity` against the real codex CLI.
- **TEST-QUALITY-5** — G1 enforces sibling-test file _existence_, not imports/assertions (gate-l5-mandates.mjs:86-87 `existsSync` only); a trivial `expect(true)` sibling satisfies it. Fix: assert the sibling imports the module-under-test and has ≥1 `expect`/`expectTypeOf`.
- **TEST-QUALITY-6** — CI runs on `ubuntu-latest` only (gates.yml:16) for a Windows-primary product; win32 branches (worker workflowsPath normalization, down.ts process-kill, path handling) never execute in the gate. (`npm test` also excludes `tests/integration/**`.) Fix: add a `windows-latest` matrix leg.
- **TEST-QUALITY-7** — Malformed-reviewer-output retry-then-escalate untested at the workflow level (only the pure-function throw at dispatch-review.test.ts:111-123). Worse, the `nonRetryable:true` flag contradicts SPEC invariant 7 ("malformed is retriable, max 3 then escalate") — and a spec sibling (I-A3) asserts the opposite, so the spec corpus disagrees with itself. A malformed reviewer output currently crashes the packet in ONE attempt. Fix: add a build-packet test forcing malformed JSON to exhaustion AND reconcile the flag with the spec.

### Spec / doc drift

- **SPEC-DRIFT-1** — `ROUND_TABLE.md`/`CLAUDE.md`/`AGENTS.md` headers assert a GENERATED-DO-NOT-HAND-EDIT contract for a generator that does not exist (arch doc §3.7 "Generator script: NONE. Hand-sync only."). A maintainer who follows the header edits ROUND_TABLE.md and assumes regeneration → the three files silently rot. Fix: replace headers with "Hand-maintained — keep identity + invariants in sync; per-agent divergence expected."
- **SPEC-DRIFT-2** — `README.md` status block is ~10 packets stale (claims mid-Phase-1; repo has sealed packet-1h/12a/12b + shipped chat), documents a non-existent entry point (`tsx src/index.ts`; actual `src/cli/index.ts`), and references non-existent `src/context/`, `src/intent/`. Fix: rewrite Status, fix the dev command, drop dead path references.
- **SPEC-DRIFT-5** — SPEC invariant 9 ("denylist + entropy before EVERY dispatch") is contradicted by the canonical `dispatchAgentActivity` running no prefilter (same root cause as DISPATCH-SEC-2 / ERROR-FAILURE-2, surfaced via the doc-vs-code lens). Fix: run prefilter on the canonical path, OR amend invariant 9 to scope the guarantee to the actually-scanned input source. (Security auditor owns the BLOCK call; the doc-reconciliation is the DECISION.)

### Chat / CLI contracts

- **CHAT-CLI-3** — `/resume` matches `SLASH_PATTERN` but has no handler → prints "Unknown command: /resume" and is absent from `/help`. Resume-from-session is only reachable via `zer0 chat --resume`, never in-REPL. Fix: remove `resume` from the regex, OR implement a real handler + add to `printSlashHelp`.
- **CHAT-CLI-4** — `cost`/`findings`/`trace`/`replay`/`stream` lack try/catch (unlike inspect/status/doctor), collapsing any throw to a generic `zer0 failed` exit 1 and discarding documented exit codes 3/4/5. `trace --limit=abc` → NaN → empirically reproduced `SqliteError: datatype mismatch`. Fix: mirror inspect.ts try/catch + exit-code mapping; validate `--limit`.
- **CHAT-CLI-5** — `inspect`/`cost`/`findings` return empty-but-valid output for a nonexistent run-id (no `runs`-row existence probe), indistinguishable from a real empty run, exit 0. Fix: `SELECT 1 FROM runs WHERE id=? LIMIT 1` probe; throw `RunNotFound` or set `runFound:false`.
- **CHAT-CLI-6** — `zer0 status --watch` reads one snapshot and exits — no polling loop despite the `--watch` name (status-watch.ts:11-24). (Compounds with OBSERVABILITY-3: the snapshot it reads is never written.) Fix: implement a watch loop, OR rename to `--snapshot`/`--once`.

### Observability

- **OBSERVABILITY-4** — `zer0 cost` reports all-zero tokens for canonical builds: cost sums the `dispatches` table the canonical path never writes; the legacy path zeroes duration and nulls tokens; only chat estimates tokens. Fix: decide the cost source of truth — write real tokens/duration into `dispatches` from `dispatchAgentActivity`, or repoint `readCostSummary` at `capacity_snapshots` and delete the dead query.
- **OBSERVABILITY-5** — `inspect` integrity block is hardcoded `{dbReadable:true, missingBlobCount:0, warnings:[]}` (inspect.ts:54) — fabricated diagnostic signal; a run with missing blobs is reported healthy. The fallback `integrity-check.mjs` also stubs `blobIntegrity`. Fix: compute integrity (stat blob files, count misses, populate warnings) or remove the field.
- **OBSERVABILITY-6** — `trace_id`/`span_id`/`parent_span_id` columns + schema fields exist but every insert defaults them null — no span correlation in any persisted row (OTel exporter is SCAFFOLDED-FOR-PACKET-13 with zero callers). Fix: mark packet-13-reserved, or populate `trace_id` with the Temporal `workflowId` now for cheap correlation.
- **OBSERVABILITY-7** — `createDbLogger` (the only logger that persists log/error rows) has zero production callers; all production sites use stderr-only `createLogger`. `zer0 trace` queries an `errors` table no production path populates. Fix: route activities/CLI through `createDbLogger` so errors are queryable, or delete the dead DB-logging surface.

## Disputed findings (need human adjudication)

These three drew split verdicts — one verifier confirmed, one refuted on overstated severity / fabricated impact. The factual code observations hold in all three; the dispute is purely severity (BLOCK vs DECISION). Human call required.

- **CONCURRENCY-2 — no cancellationSignal reaches execa in `dispatch-agent-activity.ts`** (BLOCK vs DECISION).
  - _Both agree:_ the activity wires only the timeout AbortController to execa; `context.cancellationSignal` is unused, unlike sibling `dispatch.ts:172/194` and `gate.ts:54`. Real inconsistency.
  - _Dispute:_ Verifier A (BLOCK) cites `schema.ts:100` allowing `timeoutMs` up to 2h, so an orphaned writable agent CLI could mutate the worktree for up to 2h after cancel. Verifier B (DECISION) calls the "2h" fabricated — the packet manifest sets `timeoutMs=900000` (15 min) and the activity proxy `startToCloseTimeout` is 30 min, so worst-case orphan is bounded at 15–30 min; B also argues the "leaks bash subtree" mechanism is unsupported and the cooperative cancel is by-design.
  - _Adjudication needed:_ is the real-world `timeoutMs` operator-configurable up to 2h (→ BLOCK) or capped at the 15-min manifest value (→ DECISION)? Either way, wiring `cancellationSignal` + tree-kill is the agreed fix.

- **CONCURRENCY-3 — shutdown timer leak in `worker.ts:69-73`** (BLOCK vs DECISION).
  - _Both agree:_ the `Promise.race` timeout is never cleared or `unref`'d (worker.ts:107-113), and clean Ctrl-C hangs ~10s (empirically reproduced by both — the un-unref'd timer keeps the event loop alive since the CLI exits via `process.exitCode`, not `process.exit`).
  - _Dispute:_ the "later rejects unhandled" half. Verifier A reproduced on Node v20.19.5 that `Promise.race` marks the loser's rejection handled (no `unhandledRejection`), so the impact is purely a 10s hang → DECISION. Verifier B argues the loser leg rejects unhandled with no global handler → BLOCK on the primary operator-facing `zer0 up` shutdown.
  - _Adjudication needed:_ confirm whether `Promise.race` swallows the loser rejection on the pinned Node version. The 10s hang is real and the fix (`clearTimeout` + `unref` in finally, swallow the timeout rejection) is agreed.

- **TEST-QUALITY-1 — CI never runs the buildPacketWorkflow integration suite** (BLOCK vs DECISION).
  - _Both agree:_ `gates.yml:47-48` runs only `npm test` (default config), which excludes `tests/integration/**`; no `test:integration` step exists, so the `build-packet-{happy,chaos,fix-loop,cancel,…}` integration tests never run in CI.
  - _Dispute:_ Verifier A (refute → DECISION) notes `src/temporal/workflows/build-packet.test.ts` is a 16-case workflow suite on a real `TestWorkflowEnvironment` that DOES run in CI and would catch orchestration regressions (activities mocked at the trust boundary), so "zero integration coverage" is false. Verifier B (BLOCK) notes `tests/README.md:31-32` lists `crash-recovery.test.ts` as a mandatory phase-1 gating test that lives in the CI-excluded path, and the real-activity-wiring suite genuinely never runs.
  - _Adjudication needed:_ does the in-CI workflow suite (mocked activities) provide sufficient regression protection (→ DECISION), or is the un-run real-wiring suite load-bearing enough to BLOCK? The fix (add `npm run test:integration` to gates.yml; `createTimeSkipping` runs headless on Linux) is agreed.

## Refuted findings (auditor false positives, killed on verification)

Listed briefly for transparency.

- **EVIDENCE-DB-1** (claimed `findingId` omits path/line → gate undercounts blockers, BLOCK). _Refuted:_ the SQL dedup is real, but the pass/fail gate operates on the in-memory `ReviewReport.findings` array (build-packet.ts:418/476-480), persisted AFTER the gate decision — the DB dedup cannot pass a packet with unaddressed P0s. The cited invariant (11) and `Finding.line` "required" claims are also wrong. Residual evidence-completeness gap is a NIT.
- **ERROR-FAILURE-5** (claimed canonical path misses execa `maxBuffer` overflow vs legacy that classifies it, DECISION). _Refuted:_ the legacy `isMaxBufferError` path is only reachable from a `catch`, and the legacy execa also uses `reject:false`, so it ALSO does not throw/classify on overflow — no asymmetry, no regression. Canonical path reads the output FILE not stdout, shrinking blast radius. A NIT at most.
- **TEST-QUALITY-2** (claimed prefilter tested only on legacy; canonical AND chat lack control+test, BLOCK). _Refuted:_ the chat path DOES run prefilter (prompt-builder.ts:72) and HAS a falsifying test (prompt-builder.test.ts:213); the auditor grepped the wrong module (`dispatch-service.ts`). Only the canonical path is genuinely uncovered → DECISION, narrower than claimed (covered by DISPATCH-SEC-2).
- **CHAT-CLI-1** (claimed chat boot stalls 8s and falsely reports "gemini not found" on Windows, BLOCK). _Refuted:_ reproduced 5× on the cited machine — gemini resolved `available:true` v0.43.0 every time under the 8000ms budget; zero false negatives. The proposed PowerShell-wrapped fix was measured SLOWER (timed out 2/3). A slow-probe NIT, not a deterministic correctness BLOCK.
- **CHAT-CLI-2** (claimed `council` missing from `ALL_COMMANDS`, undiscoverable + skips validation, DECISION). _Refuted:_ `ALL_COMMANDS` DOES contain `COUNCIL_COMMAND` (router.ts:64); the node-check evidence and root-cause mechanism are factually wrong. Real residual is council absent from SPECS/COMMAND_USAGE/USAGE_TEXT only — a NIT.

## NITs

- **TEST-QUALITY-8** — chaos test asserts only `calls>1`; `version-drift.yaml` injects no actual schema drift (only the transient-crash retry is real chaos). Rename fixture or add real fault-injection + exactly-once `dispatch_claims` row-count assertion. _(unverified)_
- **SPEC-DRIFT-3** — `MODULE-MAP.md:105` calls `pipeline.ts` "14-phase"; code is 12-phase (`PIPELINE_PHASES` has 12 entries). Also reconcile arch §3.2 "11 activities are stubs" → 10 non-build/review phases. _(unverified)_
- **SPEC-DRIFT-4** — `SPEC-ADDENDUM.md:138-145` (A6) claims a `dispatches.transcript_path` column + blob/transcript sync invariant that does not exist in `schema.sql`. Mark DEFERRED or correct to the content-addressed `*_blob` model. _(unverified)_
- **SPEC-DRIFT-6** — arch doc §3.3 says "Temporal activities (18 of them)"; barrel registers 22, and mislabels internal compilers (context/diff/memory-compiler) as activities. Update header to 22; move compilers to an "internal helpers (not registered)" sub-list. _(unverified)_
- **CHAT-CLI-7** — `zer0 mandates list` with no pending mandates prints a bare header row, no empty-state message (contrast `chat --list` "No saved sessions"). Print "no pending mandates" when `rows.length===0`. _(unverified)_
- **OBSERVABILITY-8** — `getLatestStateSnapshot` queries `kind=state-snapshot` (no production producer) and has no caller — dead evidence API always returning undefined. Remove it and its prepared statement. _(unverified)_
- Residuals demoted from refuted findings: EVIDENCE-DB-1 (add path+line to `findingId` for clean evidence), ERROR-FAILURE-5 (inspect `result.isMaxBuffer` in the file-missing fallback), CHAT-CLI-2 (add council to SPECS/COMMAND_USAGE/USAGE_TEXT).

## Coverage & blind spots

What was examined: full src tree (259 modules, ~19,762 prod LOC); all workflows + 21 activities + worker retry wiring; full error infrastructure traced against the Temporal SDK failure-converter; all 21 CLI commands + chat modules; full producer/consumer trace of events/errors/dispatches tables; all canonical spec/doc sources cross-checked at file:line. Empirical reproductions performed: real-git commit TOCTOU (TEMPORAL-1), execa 9.6.1 env leak (DISPATCH-SEC-3), `trace --limit` NaN SqliteError (CHAT-CLI-4), boot gemini probe (CHAT-CLI-1, refuted), shutdown timer hang (CONCURRENCY-3). `knip` reports 0 dead exports; dependency-cruiser 0 errors / no circular deps — the codebase is mechanically clean, and these findings are about contract fragmentation and unwired surface, not lint-detectable rot.

NOT examined / blind spots:

- **No runtime/E2E behavioral execution** of the full `zer0 build` against a live Temporal + real codex/claude — all BLOCKs are static + targeted-reproduction; an end-to-end run could surface interaction defects between TEMPORAL-1/2/3 and the lease path.
- `memory-compiler.ts` internals and the full legacy `pipeline.ts` shell beyond dispatch round-trips were not exhaustively read.
- Live `better-sqlite3` native locking under concurrency (CONCURRENCY-4 hazard) not load-tested.
- The 7 NITs and TEST-QUALITY-8/SPEC-DRIFT-3/4/6 are `unverified` (no second-pass verifier).
- **These findings were produced by Claude subagents.** Same-family review carries correlated blind spots. Recommend a **Codex hostile + Gemini synthesis council pass on the 8 confirmed BLOCKs and the 3 disputed findings** before remediation — in particular the SDK-behavior claims (TEMPORAL-1 retry semantics, OBSERVABILITY-1 ZodError propagation, CONCURRENCY-3 Promise.race rejection handling) where cross-family verification would harden the severity calls.

## Recommended remediation order

1. **Security cluster, single coordinated fix (DISPATCH-SEC-2/ERROR-FAILURE-2/SPEC-DRIFT-5 + DISPATCH-SEC-1 + DISPATCH-SEC-3).** Add prefilter to `dispatchAgentActivity` + review prompt; forward `input.sandbox` as `CODEX_SANDBOX=read-only` in `defaultDispatch`; add `extendEnv:false` to all adapter + dispatch execa calls. One PR closes three BLOCKs and a doc DECISION; falsifying tests for each (key-shaped string blocked, reviewer env carries read-only, secret canary absent). Highest blast radius (secret exfiltration + write-capable reviewer on the canonical path), lowest interdependency.
2. **TEMPORAL-1 — commit idempotency.** Reconcile a pending intent whose commit already landed to "applied". Data-loss / unrecoverable-build; gate the fix with the crash-window test.
3. **CONCURRENCY-1 — lease CAS.** wx-first, CAS-delete only on matching stale record. Git-tree corruption blast radius.
4. **TEMPORAL-2 — cancel deadlock** (`|| state.cancelled`) and **TEMPORAL-3/ARCH-5 — real toposort** (`drainDependencyQueue`). Both are small, localized, and unblock liveness + determinism; pair ARCH-4 (workflow-side `runAllValidators`) with the toposort fix.
5. **Observability cluster (OBSERVABILITY-1/2/3).** Unify event-kind vocabulary first (OBSERVABILITY-1 crashes every run); then decide producer wiring vs command retirement for replay/state.json. Restores diagnosability needed to validate fixes 1–4 at runtime.
6. **Adjudicate the 3 disputed findings** (CONCURRENCY-2, CONCURRENCY-3, TEST-QUALITY-1) — confirm the SDK/timeout behaviors via a Codex/Gemini council pass, then fix at the agreed (DECISION-grade) shape.
7. **DECISIONs** in dependency order: ERROR-FAILURE-1/6 boundary wrapping (add the "every activity wrapped" gate, TEST-QUALITY-3/5 hardening), then ARCH consolidation (1/2/3/7), then doc drift (SPEC-DRIFT-1/2, README), then chat/CLI error-contract uniformity (CHAT-CLI-3/4/5/6) and remaining observability (4/5/6/7).
8. **Run the full real E2E** `zer0 build` against live Temporal + real agents after fixes 1–5 to catch cross-defect interactions before lifting SHIP-BLOCKED. Add the `windows-latest` CI leg (TEST-QUALITY-6) and the integration-suite CI step (TEST-QUALITY-1 fix) so these defects cannot regress.

## Wave-6 adjudication of disputed findings (2026-05-30)

Resolved by reading the cited code + one empirical Node check. These three were the audit's only split-verdict items; the facts held in all three — only severity was in dispute.

### CONCURRENCY-2 → DECISION (fix tracked)

`src/temporal/manifest/schema.ts:100` is `timeoutMs: z.number().int().min(60_000).max(7_200_000)` — the 2h ceiling Verifier A cited is REAL, not fabricated. `dispatchAgentActivity` wires only the timeout `AbortController` to execa (`timeoutController`, dispatch-agent-activity.ts:96/205-212); `context.cancellationSignal` is unused, so on workflow cancel the agent subprocess keeps running until its own `timeoutMs`. Temporal abandons the activity at `startToCloseTimeout` (30 min) but never kills the subprocess.

**Verdict: DECISION.** The blast radius (an orphaned writable agent mutating `input.repoRoot` after a cancel) is real but bounded — real packet manifests set `timeoutMs=1_800_000` (30 min), the target is single-operator-durable, cancel is cooperative-by-design, and commit-intents + revert bound git-state damage. Not data-loss-by-default. **Fix (tracked):** wire `context.cancellationSignal` into the execa signal + tree-kill the agent process tree on cancel. **Re-classify to BLOCK if** operators routinely set `timeoutMs` near the 2h max for workspace-write builds.

### CONCURRENCY-3 → DECISION (empirically confirmed)

`src/temporal/worker.ts:107-113` `shutdownTimeout` creates a `setTimeout` that is never `clearTimeout`'d or `unref`'d, and is the loser in `Promise.race` (worker.ts:72). The ~10s clean-shutdown hang is REAL (the un-unref'd timer keeps the event loop alive; the CLI exits via `process.exitCode`, not `process.exit`). The disputed "loser rejects unhandled" half is REFUTED empirically on the pinned **Node v20.19.5**: `Promise.race` attaches a handler to every input promise, so the loser's late rejection is consumed — `unhandledRejection` did NOT fire (reproduced 2026-05-30 with the worker's exact race shape: `unhandledRejection_after_loser_rejected: false`).

**Verdict: DECISION** — a shutdown-latency annoyance, not a crash. **Fix (tracked):** `clearTimeout` + `unref()` the shutdown timer in a `finally`, and swallow the timeout rejection.

### TEST-QUALITY-1 → RESOLVED (commit `90de180`)

The dispute (the in-CI mocked workflow suite suffices vs. the un-run real-activity-wiring + `crash-recovery.test.ts` suite is load-bearing) is moot: `90de180` added `npm run test:integration` to CI (Linux leg), so the real-wiring + crash-recovery suite now runs in the gate. Both verifiers agreed on this fix; it is applied.

## Lift status (Wave 6, 2026-05-30)

NOT YET LIFTED. Per-BLOCK sealing commits exist for all 8 confirmed BLOCKs (DISPATCH-SEC-1/2/3 `65d72f9`; TEMPORAL-1 `0dd1587`; CONCURRENCY-1 `32a787d`; TEMPORAL-2/3 `76647b9`; OBSERVABILITY-1/3 `319fa04`; OBSERVABILITY-2 `a6fb055`, codex-verified). CI hardening landed (`90de180`). **Remaining before flipping SHIP-BLOCKED → LIFTED** (blocked on a clean Temporal host): the real `zer0 build` E2E vs live Temporal + real agents (remediation step 8) + the 2 heaviest integration tests (`crash-recovery`, `phase-1-dod`) green; then record per-BLOCK closure evidence + the E2E result here.
