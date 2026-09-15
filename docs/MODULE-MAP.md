# MODULE MAP — Zer0 Agent CI

> ⚠ **SUPERSEDED — do not treat this file as canonical.** It documents `src/temporal`, a subsystem deleted
> in Phase 3.5 (36 mentions; the directory does not exist), and never once mentions `src/chat`, which is the
> live one. Verified 2026-08-21: `ls -d src/temporal` → No such file or directory; `grep -c src/chat` → 0.
>
> **Current maps:** `README.md` (layout, the two processes, the wire) and `rust/README.md` (crate map).
> **Current position:** `docs/STATE.md`. **Resume procedure:** `docs/HANDOFF-m0irai.md`.
>
> Retained, not deleted, because `.dependency-cruiser.cjs` and `knip.config.js` still cite its anti-monolith
> principles and `@public` export convention. Deleting it is a separate decision with tracked-surface and
> cut-closure consequences — it is not made here.

**Status:** SUPERSEDED (see the banner above). Historically it derived from `docs/SPEC.md` §16 (phase boundaries) + `docs/PLAN.md` §1 (file list lines 1804-1949). Every BUILD BRIEF MUST cite this map for its packet's owned files.

**Anti-monolith stance:** every file declares one purpose, exports a small public API surface, and lives at a precise layer. The dependency graph is a DAG (acyclic). Files >300L are reviewed for split. Files >500L FAIL the mechanical gate.

---

## ★★★ DEPENDENCY DAG (read top→bottom; arrows point UP toward stability) ★★★

```
                    [LEAST STABLE — composes everything]
   ┌─────────────────────────────────────────────────┐
   │ src/index.ts (CLI entry; ~30L; Phase 1 packet 5)│
   └────────────────────┬────────────────────────────┘
                        ↑
   ┌────────────────────┴────────────────────────────┐
   │ src/cli/{router,commands/*,output}.ts           │
   │ user-facing command surface                     │
   └────────────────────┬────────────────────────────┘
                        ↑
   ┌────────────────────┴────────────────────────────┐
   │ src/temporal/{server,client,worker}.ts          │
   │ ambient-context Temporal infra                  │
   └─────┬──────────────────────────────────┬────────┘
         ↑                                  ↑
   ┌─────┴──────────────┐         ┌─────────┴──────────────────┐
   │ src/temporal/      │         │ src/temporal/              │
   │ workflows/*.ts     │←─types──│ activities/*.ts            │
   │ (sandbox-bound)    │  only   │ (full Node ambient)        │
   │ DETERMINISTIC ONLY │         │ side effects ALLOWED here  │
   └────────────────────┘         └─────┬──────────────────────┘
                                        ↑
   ┌────────────────────────────────────┴────────────────────┐
   │ src/gates/*.ts   src/adapters/*.ts   src/security/*.ts  │
   │ feature layer                                            │
   └────────────────────────────────────┬────────────────────┘
                                        ↑
   ┌────────────────────────────────────┴────────────────────┐
   │ src/observability/*.ts (Packet 10)                      │
   │ inspect, state-writer, fingerprint, schema-bundle,      │
   │ agent-guide, stream, replay, with-meta                  │
   │ READS evidence, DOES NOT WRITE evidence                 │
   └────────────────────────────────────┬────────────────────┘
                                        ↑
   ┌────────────────────────────────────┴────────────────────┐
   │ src/evidence/{db,blobs,queries,schema.sql,types}        │
   │ persistence layer                                        │
   └────────────────────────────────────┬────────────────────┘
                                        ↑
   ┌────────────────────────────────────┴────────────────────┐
   │ src/shared/{types,config,logger,crypto,errors,          │
   │             error-codes,ids}.ts                          │
   │ FOUNDATION — pure types, narrow IO, no project deps     │
   └─────────────────────────────────────────────────────────┘
                    [MOST STABLE — no upstream deps]

   ┌─────────────────────────────────────────────────────────┐
   │ scripts/diagnose/*.mjs (Packet 10 — STANDALONE)         │
   │ NOT in src/ tree. Read SQLite + blobs DIRECTLY.         │
   │ NO imports from src/temporal, src/cli, src/evidence/db. │
   │ Functions when zer0 is COMPLETELY DOWN.                 │
   └─────────────────────────────────────────────────────────┘
```

**Hard rules (mechanically enforced via dependency-cruiser; see `.dependency-cruiser.cjs`):**

1. **No cycles.** ANY cycle = build FAILS.
2. **No upward deps.** Lower layers MUST NOT import from higher layers.
3. **`src/temporal/workflows/**` SANDBOX PURITY** — may import ONLY from:
   - `@temporalio/workflow`
   - `src/shared/types` (pure types, erased at runtime)
   - `src/temporal/activities/*-types` (interface declarations only)
   - other files inside `src/temporal/workflows/**`
   - **MUST NOT** import `src/shared/{config,logger,crypto,errors}` or any file with side effects.
4. **`src/shared/**` ZERO PROJECT DEPS** — may import ONLY from `node:*`, npm packages, or other `src/shared/*` files.
5. **`src/cli/**` IS THE ONLY LAYER ALLOWED TO READ ENV / ARGV.** Lower layers receive config via dependency injection.

---

## ★★★ FILE-BY-FILE MAP (canonical contract per packet) ★★★

Each row: file path, **single-sentence purpose**, exports (public API surface), depends on, line budget (target / hard ceiling), packet.

### `src/shared/` — foundation (Packet 01, DONE-VERIFIED)

EXACT public API surface (codex infra-review I-4 requires named symbols, no group labels):

| File | Single-sentence purpose | Public exports | Depends on | Lines tgt/max | Status |
|---|---|---|---|---|---|
| `types.ts` | All cross-cutting type definitions and Zod schemas with compile-time assertion that schema and interface match. | `RunId`, `TaskId`, `AgentName`, `PipelinePhase`, `ControlMode`, `PipelineStatus`, `ContextPack`, `ContextItem`, `BuildTask`, `BuildResult`, `FindingSeverity`, `RubricStatus`, `ReviewVerdict`, `Finding`, `RubricResult`, `RubricReviewOutput`, `AgentAdapter`, `AgentResult`, `AgentHealth`, `GateResult`, `StabilitySignal`, `EscalationAction`, `EscalationResponse`, `StabilityResult`, `CostReport`, `PipelineStatusSchema`, `BuildTaskSchema`, `FindingSchema`, `RubricReviewOutputSchema`, `GateResultSchema` | `zod` | 250 / 500 (justified) | ✅ |
| `config.ts` | Loads + validates `.zer0/config.yaml` synchronously for CLI startup; provides async variant for workflow contexts. | `Zer0Config`, `Zer0ConfigSchema`, `loadConfig`, `loadConfigAsync` | `node:fs`, `zod`, `./errors` | 250 / 500 | ✅ |
| `logger.ts` | Structured stderr logger with deterministic level filtering and circular-ref-safe meta serialization. | `Logger`, `LogContext`, `LogLevel`, `createLogger` | `node:process` | 150 / 300 | ✅ |
| `crypto.ts` | Pure SHA-256 hashing and content-addressed blob path computation. | `sha256`, `blobPath` | `node:crypto` | 60 / 200 | ✅ |
| `errors.ts` | Typed error class hierarchy with discriminated `code` for exhaustive handling. | `Zer0Error` (union), `ConfigError`, `GateError`, `DispatchError`, `ContextError`, `StabilityError`, `isZer0Error` | (none — pure) | 200 / 500 | ✅ |

### `src/temporal/` — orchestration infra (Packet 02, IN-FLIGHT)

| File | Single-sentence purpose | Public exports | Depends on | Lines tgt/max | Status |
|---|---|---|---|---|---|
| `server.ts` | Boots Temporal dev server (auto-setup container) and waits for namespace ready. | `startServer`, `stopServer`, `ServerHandle` | `@temporalio/*`, `execa`, `../shared/{config,logger,errors}` | 150 / 300 | 🔄 |
| `client.ts` | Wraps `@temporalio/client.Connection` + `WorkflowClient` for CLI-side workflow start/signal/query. | `getClient`, `signalWorkflow`, `queryWorkflow` | `@temporalio/client`, `../shared/{config,logger}` | 150 / 300 | 🔄 |
| `worker.ts` | Registers all activities + workflows on a single worker; handles graceful shutdown. | `startWorker`, `WorkerHandle` | `@temporalio/worker`, `./activities`, `./workflows`, `../shared/{config,logger}` | 150 / 300 | 🔄 |
| `signals.ts` | All signal, query, and update definitions used by workflow handlers and clients (single source of truth). | `approveSignal`, `rejectSignal`, `overrideSignal`, `modeChangeSignal`, `cancelSignal`, `statusQuery`, `findingsQuery`, `costQuery`, `contextQuery`, `answerUpdate` | `@temporalio/workflow` (defineSignal/Query/Update only) | 100 / 250 | 🔄 |
| `workflows/pipeline.ts` | The 14-phase orchestration workflow as a single deterministic function with all signal/query handlers wired before first await. | `pipelineWorkflow` | `@temporalio/workflow`, `../signals`, `../activities/*-types`, `../../shared/types` ONLY | 250 / 500 | 🔄 |
| `workflows/index.ts` | Workflow barrel re-export consumed by `worker.ts`. | re-exports of all workflows | `./pipeline` | 20 / 50 | 🔄 |
| `activities/dispatch.ts` | Real `dispatchAgent` activity that spawns CLI via execa, returns transcript + cost + duration. | `dispatchAgent`, `DispatchResult`, `DispatchInput` | `execa`, `../../shared/{config,logger,errors,crypto}` | 200 / 400 | 🔄 |
| `activities/index.ts` | Activity barrel that worker.ts registers in one call. | `createActivities()` returning `{ dispatchAgent, ... }` | `./dispatch` | 30 / 80 | 🔄 |
| `activities/project-context.ts` | Projects tracking current state into model-specific focused prompt payloads. | `FocusedPayload`, `projectContextForModel` | `node:crypto`, `zod`, tracking schemas, shared errors/types, manifest types | 170 / 250 | 🔄 |
| `activities/project-context.test.ts` | Verifies Claude, Codex, and Gemini projections plus budget behavior. | (vitest) | `./project-context`, manifest types | 103 / 250 | 🔄 |
| `activities/prepare-context.ts` | Assembles phase context, writes current.json, and returns the workflow context pack. | `PrepareContextInput`, `ContextPack`, `prepareContextActivity` | `node:crypto`, `node:fs/promises`, `node:path`, `zod`, tracking, shared errors/types, manifest | 173 / 250 | 🔄 |
| `activities/prepare-context.test.ts` | Covers context assembly, tracking writes, repeat markers, fingerprints, and budget failures. | (vitest) | tracking reader, manifest schema, `./prepare-context` | 125 / 250 | 🔄 |
| `activities/run-gates.ts` | Runs phase gates sequentially via shell-free execa and computes baseline deltas. | `Violation`, `GateExecution`, `GateReport`, `RunGatesInput`, `RunGatesDeps`, `GateRunOptions`, `GateRunResult`, `runGatesActivity`, `parseGateOutput` | `execa`, `zod` | 179 / 250 | 🔄 |
| `activities/run-gates.test.ts` | Verifies gate command argv, shell flags, pass/fail reports, parser, and delta behavior. | (vitest) | `./run-gates` | 80 / 250 | 🔄 |
| `activities/dispatch-review.ts` | Dispatches review using only committed diff, owned files, manifest path, and structured primary findings. | `ReviewFinding`, `ReviewReport`, `DispatchReviewInput`, `DispatchReviewDeps`, `dispatchReviewActivity`, `parseReviewOutput` | `execa`, `zod`, shared types | 219 / 250 | 🔄 |
| `activities/dispatch-review.test.ts` | Verifies reviewer prompt scope, W5 no builder-context invariant, secondary findings input, and parsing. | (vitest) | `./dispatch-review` | 107 / 250 | 🔄 |
| `activities/generate-fix-brief.ts` | Generates a 14-section focused Codex fix brief from structured attempt failures. | `FixBrief`, `GenerateFixBriefInput`, `generateFixBriefActivity` | `node:crypto`, `zod`, tracking schemas, manifest schema | 120 / 250 | 🔄 |
| `activities/generate-fix-brief.test.ts` | Covers section headers, length cap, repeat marker, denylist check, fingerprint, and gate commands. | (vitest) | manifest schema, `./generate-fix-brief` | 90 / 250 | 🔄 |
| `activities/revert-commit.ts` | Reverts a failed-review tip commit and records a phase_review_reverted event when evidence inputs exist. | `RevertCommitInput`, `RevertCommitDeps`, `revertCommitActivity` | `node:crypto`, `execa`, evidence DB/queries, shared types | 97 / 250 | 🔄 |
| `activities/revert-commit.test.ts` | Uses a temp git repo and real SQLite DB to verify revert behavior and event insertion. | (vitest) | `execa`, evidence DB/queries, `./revert-commit` | 103 / 250 | 🔄 |

### `src/temporal/manifest/` — manifest layer (Packet 11a, IN-FLIGHT)

| File | Single-sentence purpose | Public exports | Depends on | Lines tgt/max | Status |
|---|---|---|---|---|---|
| `manifest/schema.ts` | Defines the packet manifest Zod contract consumed before workflow dispatch. | `PacketId`, `PhaseName`, `AdrId`, `ContextBudgetSchema`, `PhaseSchema`, `ManifestSchema`, `ContextBudget`, `Phase`, `Manifest` | `zod` | 123 / 250 | 🔄 |
| `manifest/loader.ts` | Loads JSON-compatible manifest files from disk into validated manifest objects. | `loadManifest` | `node:fs/promises`, `./schema` | 19 / 250 | 🔄 |
| `manifest/semantic-validators.ts` | Validates semantic manifest constraints that Zod cannot express. | `ValidationIssue`, `validateUniquePhaseNames`, `validateNoDependencyCycles`, `validateNoOwnedFilesOverlap`, `validateAdrIdsResolvable`, `validateNoForbiddenGateNames`, `validateBuilderReviewerCrossFamily`, `validateContextBudgetReasonable`, `runAllValidators` | `./schema` | 209 / 250 | 🔄 |
| `manifest/index.ts` | Re-exports the manifest loader, schemas, validators, and public types. | `loadManifest`, `ContextBudgetSchema`, `PhaseSchema`, `ManifestSchema`, `validateUniquePhaseNames`, `validateNoDependencyCycles`, `validateNoOwnedFilesOverlap`, `validateAdrIdsResolvable`, `validateNoForbiddenGateNames`, `validateBuilderReviewerCrossFamily`, `validateContextBudgetReasonable`, `runAllValidators`, type exports | `./loader`, `./schema`, `./semantic-validators` | 20 / 80 | 🔄 |

### `src/evidence/` — persistence layer (Packet 03, NOT STARTED)

| File | Single-sentence purpose | Public exports | Depends on | Lines tgt/max |
|---|---|---|---|---|
| `schema.sql` | Authoritative DDL for runs / tasks / findings / events / blobs tables (FTS5-indexed where searched). | (SQL file) | (none) | 200 / 400 |
| `db.ts` | Opens better-sqlite3 with WAL + busy_timeout + applies schema migrations idempotently. | `openDb`, `Db`, `closeDb` | `better-sqlite3`, `node:fs`, `../shared/{config,logger,errors}` | 150 / 300 |
| `queries.ts` | All prepared statements (insertRun, updateTaskStatus, insertFinding, insertDispatch, etc.) with typed args/returns. | `Queries`, `createQueries` | `./db`, `../shared/errors`, `../shared/types` | 300 / 500 |
| `types.ts` | Typed row and argument contracts shared by evidence prepared statements and observability projections. | `InsertRunArgs`, `UpdateRunStatusArgs`, `InsertTaskArgs`, `UpdateTaskStatusArgs`, `InsertFindingArgs`, `InsertGateTransitionArgs`, `InsertDispatchArgs`, `InsertEventArgs`, `InsertErrorArgs`, `QueryErrorsArgs`, `ErrorRow`, `EventRow`, `FindingRow`, `ContextRunRow`, `ContextItemRow`, `RowIdRow`, `NextSequenceRow` | `../shared/error-codes`, `../shared/types` | 189 / 500 |
| `blobs.ts` | Content-addressed blob store: `putBlob(buffer)→sha256`, `getBlob(sha256)→buffer`, atomic write via tmp+rename. | `putBlob`, `getBlob`, `blobExists`, `BlobStore` | `node:crypto`, `node:fs`, `node:path`, `../shared/crypto`, `../shared/errors`, `../shared/logger` | 200 / 400 |

| `dispatch-claims.ts` | Records and reads dispatch idempotency claim rows. | `DispatchClaim`, `DispatchClaimKey`, `DispatchClaimResult`, `claimDispatch`, `findExistingClaim`, `findCompletedResult`, `markClaimCompleted` | `zod`, `./db`, `../shared/crypto` | 103 / 250 |
| `commit-intents.ts` | Records commit intent rows and marks applied commits. | `CommitIntent`, `CommitIntentKey`, `CommitIntentInput`, `recordCommitIntent`, `findCommitIntent`, `markCommitApplied` | `zod`, `ulid`, `./db` | 122 / 250 |
| `capacity-snapshots.ts` | Records and queries per-agent capacity snapshots. | `CapacitySnapshot`, `CapacitySnapshotInput`, `CapacityWindowQuery`, `recordCapacitySnapshot`, `latestCapacityForAgent`, `recentCapacityWindow` | `zod`, `ulid`, `./db` | 157 / 250 |

### `src/adapters/` — CLI wrappers (Packet 04, NOT STARTED)

| File | Single-sentence purpose | Public exports | Depends on | Lines tgt/max |
|---|---|---|---|---|
| `types.ts` | Adapter-shaped types: `AgentInput`, `AgentResult`, `AdapterError`. | type exports | `../shared/types` | 100 / 200 |
| `claude.ts` | Spawns `claude -p --output-format json` via execa with AbortSignal + token-bucket rate limit. | `dispatchClaude` | `execa`, `./types`, `../shared/{config,logger,errors}` | 200 / 400 |
| `codex.ts` | Spawns `codex exec --sandbox workspace-write` via execa + parses stdout for verdict/cost. | `dispatchCodex` | `execa`, `./types`, `../shared/{config,logger,errors}` | 200 / 400 |
| `gemini.ts` | Spawns `gemini -y` via execa (PowerShell on Windows due to `@lydell/node-pty` conpty bug). | `dispatchGemini` | `execa`, `./types`, `../shared/{config,logger,errors}` | 200 / 400 |
| `registry.ts` | Adapter registry keyed by agent name; failover chain on transient errors. | `getAdapter`, `AdapterRegistry` | `./{claude,codex,gemini}`, `../shared/types` | 100 / 250 |

### `src/security/` — pre-dispatch filter (Packet 04, NOT STARTED)

| File | Single-sentence purpose | Public exports | Depends on | Lines tgt/max |
|---|---|---|---|---|
| `denylist.ts` | Loaded denylist of secret-shaped strings + binary patterns; constant-time comparison. | `Denylist`, `loadDenylist`, `matches` | `node:fs`, `../shared/{config,errors}` | 150 / 300 |
| `entropy.ts` | Shannon entropy scanner for payloads; flags strings >threshold as candidate secrets. | `entropyOf`, `flagHighEntropy`, `EntropyFinding` | (pure math) | 100 / 200 |
| `filter.ts` | Composes denylist + entropy into single `prefilter(payload)` returning typed `Allowed` or `Blocked`. | `prefilter`, `FilterResult`, `FilterError` | `./{denylist,entropy}`, `../shared/{logger,errors}` | 100 / 250 |

### `src/gates/` — quality enforcement (Packet 05, NOT STARTED)

| File | Single-sentence purpose | Public exports | Depends on | Lines tgt/max |
|---|---|---|---|---|
| `engine.ts` | Generic `runGate(name, fn)` returning typed `GatePass` or `GateFail` with structured findings. | `runGate`, `GateResult` | `../shared/types`, `../shared/{logger,errors}` | 150 / 300 |
| `build-gate.ts` | Composes typecheck + biome + vitest + gate-clamps + gate-encoding + dep-cruiser + knip into one mechanical sweep. | `runBuildGate`, `BuildGateResult` | `execa`, `./engine`, `../shared/{config,logger}` | 200 / 400 |

### `src/cli/` — user surface (Packet 05, NOT STARTED)

| File | Single-sentence purpose | Public exports | Depends on | Lines tgt/max |
|---|---|---|---|---|
| `router.ts` | Dispatches `process.argv` to commands using raw parsing (no commander.js per `feedback_no_commander.md`). | `route`, `printUsage` | `./commands/*`, `../shared/logger` | 150 / 300 |
| `commands/start.ts` | `zer0 start <task-text>` — connects client, starts pipelineWorkflow, streams events. | `runStart` | `../../temporal/client`, `../../shared/types`, `./output` | 200 / 400 |
| `commands/status.ts` | `zer0 status [run-id]` — queries running workflow or reads from SQLite. | `runStatus` | `../../temporal/client`, `../../evidence/queries`, `./output` | 150 / 300 |
| `commands/doctor.ts` | `zer0 doctor` — checks server reachable, all CLIs installed, config valid. | `runDoctor` | `../../temporal/server`, `../../adapters/*`, `./output` | 200 / 400 |
| `output.ts` | Terminal formatting (colors via yoctocolors, glyphs via figures); pure presentation. | `printPhase`, `printFinding`, `printVerdict` | `yoctocolors`, `figures` | 150 / 300 |
| `index.ts` | Wires `process.argv` → `route()`. ~30 lines max. | `main` | `./router` | 30 / 50 |

### `src/observability/` — see-through diagnostic fabric (Packet 10, IN-FLIGHT)

Reads from `src/evidence` (one direction). NEVER writes evidence (read-only projection layer). Compiles state into `RunInspection`, `RunState`, `LastRunSummary`, `FailureContext` JSON contracts that internal CLI commands AND external diagnostic scripts both consume.

| File | Single-sentence purpose | Public exports | Depends on | Lines tgt/max |
|---|---|---|---|---|
| `schemas/run-state.ts` | Zod schema for `.zer0/runs/{id}/state.json` (50-field crash-readable projection). | `RunStateSchema`, `RunState`, `RunStateLifecycle`, `RunStateWriterKind` | `zod`, `../../shared/ids` | 200 / 400 |
| `schemas/run-inspection.ts` | Zod schema for canonical `RunInspection` (joined view of run + tasks + dispatches + gates + findings + errors). | `RunInspectionSchema`, `RunInspection` | `zod`, `./run-state`, `./error-event`, `./event` | 250 / 500 |
| `schemas/event.ts` | Zod schema for `events` table rows + closed `EventKind` enum. | `EventSchema`, `Event`, `EventKind`, `EVENT_KINDS` | `zod`, `../../shared/ids` | 150 / 300 |
| `schemas/error-event.ts` | Zod schema for `errors` table rows. | `ErrorEventSchema`, `ErrorEvent` | `zod`, `../../shared/error-codes`, `../../shared/ids` | 100 / 250 |
| `schemas/diagnostic-report.ts` | Zod schema for integrity-check.mjs output. | `DiagnosticReportSchema`, `DiagnosticReport` | `zod` | 100 / 200 |
| `schemas/last-run-summary.ts` | Zod schema for last-run.mjs output. | `LastRunSummarySchema`, `LastRunSummary` | `zod`, `../../shared/ids` | 80 / 200 |
| `schemas/failure-context.ts` | Zod schema for failure-context.mjs sidecar JSON. | `FailureContextSchema`, `FailureContext` | `zod`, `./error-event`, `./event` | 100 / 250 |
| `schemas/index.ts` | Barrel export of all schemas. | re-exports of all `./schemas/*` | `./schemas/*` | 30 / 80 |
| `with-meta.ts` | `withMeta(payload, schemaName, version)` wraps any payload with `$schema` + `schemaVersion` per L5 metadata invariant. | `withMeta`, `WithMeta` | (pure types) | 50 / 150 |
| `state-writer.ts` | Atomic temp+rename writer for state.json with monotonic-sequence concurrency control. | `StateWriter`, `StateWriterConfig`, `ConcurrentWriteError` | `node:fs/promises`, `node:path`, `./schemas`, `../shared/{ids,errors,error-codes}` | 200 / 400 |
| `inspect.ts` | Builds canonical `RunInspection` from DB + blobs + state.json (the projection both internal CLI and external scripts use). | `inspectRun`, `InspectRunOptions` | `./schemas`, `../evidence/{queries,blobs}`, `../shared/logger` | 250 / 500 |
| `fingerprint.ts` | Datadog/Sentry-style error fingerprint: `hash(code + normalized_message + top_stack_frame)` for dedup. | `fingerprint`, `normalizeMessage`, `extractTopFrame` | `node:crypto` | 100 / 200 |
| `schema-bundle.ts` | Generates `.zer0/SCHEMA.json` JSON Schema bundle from Zod schemas at build time (minimal Zod→JSON Schema converter, ~200L). | `generateSchemaBundle`, `zodToJsonSchema` | `./schemas`, `zod` | 300 / 500 |
| `agent-guide.ts` | Generates `.zer0/AGENT-GUIDE.md` (12 sections) on every run start; SQLite map rendered from current schema, not hardcoded. | `generateAgentGuide`, `AGENT_GUIDE_SECTIONS` | `node:fs`, `../evidence/db` (READ ONLY), `../shared/logger` | 250 / 500 |
| `stream.ts` | NDJSON tail of `events` table for `zer0 stream <run-id>` consumers. | `streamEvents`, `StreamOptions` | `../evidence/queries`, `./schemas`, `../shared/logger` | 150 / 300 |
| `replay.ts` | Reconstructs and re-spawns a frozen dispatch using stored `argv_json + cwd + env_allowlist_version + context_blob_hash + model_version + repo_commit`. | `replayDispatch`, `ReplayOptions` | `execa`, `../evidence/{queries,blobs}`, `../shared/{logger,errors}` | 200 / 400 |
| `index.ts` | Barrel for the public observability API. | re-exports of `inspect`, `streamEvents`, `replayDispatch`, `generateAgentGuide`, `generateSchemaBundle`, schemas | `./*` | 30 / 80 |

### Observability / Tracking — ephemeral-spawn tracking files (Packet 11b, IN-FLIGHT)

| File | Single-sentence purpose | Public exports | Depends on | Lines tgt/max |
|---|---|---|---|---|
| `tracking/schemas/current-state.ts` | Defines the current.json Zod contract and 200-line budget check. | `AttemptFailure`, `AdrSummary`, `CurrentState`, `AttemptFailureSchema`, `AdrSummarySchema`, `CurrentStateSchema` | `zod` | 82 / 250 |
| `tracking/schemas/current-state.test.ts` | Covers current-state parse, round-trip, invalid fields, and budget rejection. | (vitest) | `./current-state` | 43 / 250 |
| `tracking/schemas/result.ts` | Defines the result.json Zod contract for spawn completion output. | `ResultStatus`, `Result`, `ResultSchema` | `zod` | 31 / 250 |
| `tracking/schemas/result.test.ts` | Covers DONE/BLOCKED/FAILED statuses and invalid result payloads. | (vitest) | `./result` | 38 / 250 |
| `tracking/schemas/decision-record.ts` | Defines claims.json decision records and history.ndjson event line schemas. | `DecisionRecord`, `TrackingEvent`, `DecisionRecordSchema`, `EventSchema` | `zod` | 47 / 250 |
| `tracking/schemas/decision-record.test.ts` | Covers decision and event schemas plus invalid inputs. | (vitest) | `./decision-record` | 57 / 250 |
| `tracking/paths.ts` | Builds canonical tracking file paths under `.zer0/runs/{runId}/agents/{phase}/{attempt}`. | `TRACKING_ROOT_ENV`, `runDir`, `agentDir`, `currentStatePath`, `historyPath`, `resultPath`, `claimsPath` | `node:path` | 60 / 250 |
| `tracking/paths.test.ts` | Verifies path shapes and traversal rejection. | (vitest) | `./paths` | 28 / 250 |
| `tracking/writer.ts` | Validates and writes current, result, event, and decision tracking files. | `writeCurrentState`, `appendEvent`, `writeResult`, `recordDecision` | `node:fs`, `node:fs/promises`, `node:path`, shared errors, tracking schemas/paths | 126 / 250 |
| `tracking/writer.test.ts` | Uses tmpdirs to verify writer validation, append behavior, atomic rename, and conflict rejection. | (vitest) | tracking paths/writer | 131 / 250 |
| `tracking/reader.ts` | Reads and Zod-parses current, history, result, and claims tracking files. | `readCurrentState`, `readHistory`, `readResult`, `readClaims` | `node:fs`, `node:fs/promises`, shared errors, tracking schemas/paths | 61 / 250 |
| `tracking/reader.test.ts` | Uses tmpdirs to verify parsed reads and missing-file errors. | (vitest) | tracking reader/writer/paths | 100 / 250 |
| `tracking/compactor.ts` | Archives full history and rewrites compacted history with a content-hash invariant. | `CompactHistoryDeps`, `CompactHistoryResult`, `compactHistory` | `node:crypto`, `node:fs`, `node:fs/promises`, `node:path`, shared errors, tracking paths | 124 / 250 |
| `tracking/compactor.test.ts` | Verifies 2000-line compaction, archive existence, trim count, and archive hash invariant. | (vitest) | tracking compactor/writer/paths | 77 / 250 |
| `tracking/index.ts` | Barrel export for the tracking-file protocol. | re-exports paths, writer, reader, compactor, schemas, and protocol types | `./paths`, `./writer`, `./reader`, `./compactor`, `./schemas/*` | 28 / 80 |

### `src/cli/commands/` — Packet-10 additions (8 new commands)

| File | Single-sentence purpose | Public exports | Depends on | Lines tgt/max |
|---|---|---|---|---|
| `commands/inspect.ts` | `zer0 inspect <run-id> --json` — prints canonical `RunInspection` JSON wrapped via `withMeta`. | `runInspect` | `../../observability/inspect`, `../../observability/with-meta`, `./output` | 100 / 250 |
| `commands/findings.ts` | `zer0 findings <run-id> [--severity P0,P1] --json` — projection of `RunInspection.findings`. | `runFindings` | `../../observability/inspect`, `./output` | 100 / 250 |
| `commands/cost.ts` | `zer0 cost <run-id> --json` — projection of `RunInspection.costSummary`. | `runCost` | `../../observability/inspect`, `./output` | 80 / 200 |
| `commands/trace.ts` | `zer0 trace <error-code> [--limit N] --json` — historical `errors` rows by code + fingerprint group. | `runTrace` | `../../evidence/queries`, `../../observability/with-meta`, `./output` | 100 / 250 |
| `commands/diagnose.ts` | `zer0 diagnose [<run-id>] --json` — wraps `failure-context.mjs` + `integrity-check.mjs` for in-CLI use (offline-safe). | `runDiagnose` | `../../observability/inspect`, `../../shared/logger` | 150 / 300 |
| `commands/status-watch.ts` | `zer0 status <run-id> --watch --json` — polls workflow query + tails state.json. | `runStatusWatch` | `../../temporal/client`, `../../observability/inspect`, `./output` | 150 / 300 |
| `commands/stream.ts` | `zer0 stream <run-id>` — NDJSON event stream via `streamEvents`. | `runStream` | `../../observability/stream`, `./output` | 80 / 200 |
| `commands/replay.ts` | `zer0 replay <dispatch-id>` — invokes `replayDispatch` and prints captured output. | `runReplay` | `../../observability/replay`, `./output` | 100 / 250 |
| `commands/approve.ts` | `zer0 approve <run-id> [--reject]` — sends zero-arg packet workflow approve/reject signals. | `runApprove` | `../../shared/config`, `../../temporal/client`, `../../temporal/workflows`, `./output` | 70 / 200 |
| `commands/build.ts` | `zer0 build <packet-id> [--dry-run]` — validates packet manifest, computes repo fingerprint, starts buildPacketWorkflow, and maps result exits. | `runBuild` | `node:fs`, `node:fs/promises`, `node:path`, `execa`, `zod`, shared config/crypto, temporal client/manifest/workflows, `./output` | 169 / 250 |
| `commands/cancel.ts` | `zer0 cancel <run-id>` — signals packet workflow cancel and waits for a CANCELLED terminal result. | `runCancel` | `@temporalio/common`, `../../shared/config`, `../../temporal/client`, `../../temporal/workflows`, `./output` | 72 / 200 |
| `commands/mandates.ts` | `zer0 mandates list|accept|reject` — lists pending mandate markdown and moves accepted/rejected files with audit comments. | `runMandates` | `node:fs`, `node:fs/promises`, `node:path`, `./output` | 130 / 250 |

### Packet 11c additions

| File | Single-sentence purpose | Public exports | Depends on | Lines tgt/max |
|---|---|---|---|---|
| `src/temporal/workflows/build-packet.ts` | Orchestrates packet manifest preflight, phase build attempts, gates, commits, two-pass review, final fix-loop, workflow-level escalation wait, docs, and seal. | `BuildPacketInput`, `BuildPacketResult`, `BuildPacketStatus`, `buildPacketWorkflow`, packet signals/query | `@temporalio/common`, `@temporalio/workflow`, `../activities`, `../manifest` | 493 / 500 |
| `src/temporal/workflows/build-packet.test.ts` | Covers packet workflow invariants W1-W8, final fix-loop, human escalation signal resolution, cancellation, mode signal, and patch-path behavior. | (vitest) | `@temporalio/testing`, `@temporalio/worker`, `./build-packet` | 450 / 500 |
| `src/temporal/workflows/patches.ts` | Lists active Temporal patch IDs and descriptions for build-packet workflow versioning. | `WORKFLOW_PATCHES`, `WORKFLOW_PATCH_DESCRIPTIONS`, `deprecatePatch`, `WorkflowPatchName` | (none) | 23 / 80 |
| `src/temporal/workflows/patches.test.ts` | Verifies patch registry population, uniqueness, description strength, and deprecation helper. | (vitest) | `./patches` | 24 / 80 |
| `src/cli/lease.ts` | Manages packet repo leases in `.zer0/leases` with live-PID duplicate-run protection and exclusive create race prevention. | `LeaseRecord`, `LeaseHandle`, `LeaseOptions`, `acquireLease`, `releaseLease`, `inspectLease`, `forceReleaseLease` | `node:fs`, `node:fs/promises`, `node:os`, `node:path`, `zod` | 163 / 250 |
| `src/cli/lease.test.ts` | Covers fresh acquire, stale reclaim, expired reclaim, duplicate refusal, concurrent acquire race prevention, release, force release, and inspect. | (vitest) | `node:fs/promises`, `node:os`, `node:path`, `./lease` | 126 / 250 |
| `src/temporal/activities/lease.ts` | Delegates Temporal lease activities to packet repo lease helpers. | `LeaseActivityHandle`, `LeaseActivityRecord`, `acquireLeaseActivity`, `releaseLeaseActivity` | `zod` | 84 / 250 |
| `src/temporal/activities/lease.test.ts` | Verifies lease activity acquire and release delegation against a real temp lease file. | (vitest) | `node:fs/promises`, `node:os`, `node:path`, `./lease` | 18 / 250 |
| `src/temporal/activities/load-manifest-activity.ts` | Loads packet manifests through the manifest layer and rejects stale repo fingerprints. | `LoadManifestActivityInput`, `LoadManifestActivityDeps`, `loadManifestActivity` | `node:fs/promises`, `execa`, `zod`, `@temporalio/common`, shared crypto, manifest | 77 / 250 |
| `src/temporal/activities/load-manifest-activity.test.ts` | Verifies manifest loading, missing files, schema rejection, and fingerprint mismatch handling. | (vitest) | temp filesystem, `@temporalio/common`, `./load-manifest-activity` | 86 / 250 |
| `src/temporal/activities/preflight.ts` | Checks ADR and module-map references before packet build dispatch. | `PreflightActivityInput`, `PreflightActivityDeps`, `PreflightResult`, `preflightActivity` | `node:fs`, `node:fs/promises`, `@temporalio/common`, `zod`, manifest validators | 105 / 250 |
| `src/temporal/activities/preflight.test.ts` | Verifies successful preflight plus missing ADR, missing map row, and combined failure reporting. | (vitest) | `@temporalio/common`, manifest types, `./preflight` | 115 / 250 |
| `src/temporal/activities/dispatch-agent-activity.ts` | Dispatches packet build prompts through the canonical agent wrapper with claim replay. | `DispatchAgentActivityInput`, `DispatchAgentActivityDeps`, `DispatchResult`, `dispatchAgentActivity` | `node:fs`, `node:fs/promises`, `node:os`, `node:path`, Temporal activity/common, `execa`, `zod`, evidence claims | 283 / 500 |
| `src/temporal/activities/dispatch-agent-activity.test.ts` | Verifies agent dispatch, claim replay, timeout aborts, and non-zero agent results. | (vitest) | temp filesystem, Temporal activity/common, evidence DB/claims, `./dispatch-agent-activity` | 143 / 250 |
| `src/temporal/activities/commit.ts` | Creates idempotent git commits for packet phase and seal intents. | `CommitActivityInput`, `CommitActivityDeps`, `CommitResult`, `commitActivity` | `node:fs`, Temporal common, `execa`, `zod`, evidence commit intents/DB | 171 / 250 |
| `src/temporal/activities/commit.test.ts` | Verifies real git commit creation, replay, no-change rejection, and git failure handling. | (vitest) | temp filesystem, `execa`, evidence DB, `./commit` | 100 / 250 |
| `src/temporal/activities/escalate.ts` | Writes packet escalation markdown and tracking events; workflow code owns human wait and timeout. | `EscalateInput`, `EscalationFailure`, `escalateActivity` | `node:fs/promises`, `node:path`, `zod`, tracking, manifest | 84 / 250 |
| `src/temporal/activities/escalate.test.ts` | Verifies escalation file output, tracking event row, and immediate return without activity-level timeout. | (vitest) | tracking paths, manifest schema, `./escalate` | 65 / 250 |

### Packet 11d integration tests

| File | Single-sentence purpose | Public exports | Depends on | Lines tgt/max |
|---|---|---|---|---|
| `tests/integration/build-packet-happy.test.ts` | Runs the packet build CLI against real Temporal, real git commits, and file-backed SQLite with injected dispatch boundaries. | (vitest) | Temporal testing/worker, `execa`, evidence DB, packet activities, manifest/workflow, CLI build command | 238 / 500 |
| `tests/integration/build-packet-fix-loop.test.ts` | Proves blocking review retry creates a fresh per-attempt commit intent and seals after the final pass. | (vitest) | Temporal testing/worker, `execa`, evidence DB, packet activities, manifest, CLI build command | 275 / 500 |
| `tests/integration/build-packet-cancel.test.ts` | Cancels during phase two and verifies phase-one commit preservation plus lease release. | (vitest) | Temporal testing/worker, `execa`, evidence DB, packet activities, manifest/workflow signals | 244 / 500 |
| `tests/integration/build-packet-chaos.test.ts` | Covers Temporal activity retry, SQLite busy-timeout configuration, and active patched branch behavior mid-flight. | (vitest) | Temporal testing/worker, `execa`, evidence DB, packet activities, workflow signals/query | 302 / 500 |
| `tests/fixtures/manifests/happy.yaml` | Three-phase JSON manifest fixture (schemas/compiler/cli) for build-packet-happy integration test. | (data) | (none) | 32 / 200 |
| `tests/fixtures/manifests/fix-loop.yaml` | Two-phase JSON manifest fixture with `maxFixLoopsPerPhase: 2` for build-packet-fix-loop integration test. | (data) | (none) | 32 / 200 |
| `tests/fixtures/manifests/cancel.yaml` | Two-phase JSON manifest fixture with phase-2 timeout suitable for cancel scenarios. | (data) | (none) | 32 / 200 |
| `tests/fixtures/manifests/version-drift.yaml` | Single-phase JSON manifest fixture for build-packet-chaos integration test. | (data) | (none) | 24 / 200 |
| `vitest.config.integration.ts` | Vitest config for integration suite with `fileParallelism: false` so cross-file `process.env.ZER0_TRACKING_ROOT` mutations cannot race. | `default` (vitest config) | `vitest/config` | 14 / 100 |
| `src/temporal/activities/analyze-packet.ts` | Classifies packet findings and writes packet lessons markdown. | `LessonClassification`, `Lessons`, `AnalyzePacketInput`, `analyzePacketActivity` | `node:fs/promises`, `node:path`, `zod`, `./dispatch-review` types | 108 / 250 |
| `src/temporal/activities/analyze-packet.test.ts` | Covers finding classifications, recurring detection, and lessons file output. | (vitest) | `./analyze-packet`, `./dispatch-review` types | 55 / 250 |
| `src/temporal/activities/post-commit-documentation.ts` | Appends handoff and lesson docs with atomic writes before the seal commit. | `DocPaths`, `PostCommitDocumentationInput`, `postCommitDocumentationActivity` | `node:fs`, `node:fs/promises`, `node:path`, `zod`, `./analyze-packet` types | 110 / 250 |
| `src/temporal/activities/post-commit-documentation.test.ts` | Verifies handoff marker append, dated lessons output, atomic write cleanup, idempotence, and memory updates. | (vitest) | `node:fs`, `node:fs/promises`, `./post-commit-documentation` | 76 / 250 |
| `src/observability/otel/exporter.ts` | SCAFFOLDED-FOR-PACKET-13 file exporter contract for OTLP-shaped dated NDJSON spans; no activity caller wires it yet. | `OtelConfig`, `SpanRecord`, `OtelExporter`, `createOtlpExporter` | `node:fs/promises`, `node:path`, `zod` | 93 / 250 |
| `src/observability/otel/exporter.test.ts` | Verifies span shape, NDJSON format, date rollover, disabled config, and error span persistence. | (vitest) | `node:fs/promises`, `node:os`, `node:path`, `./exporter` | 77 / 250 |

### Packet 1h additions — rails hardening (added 2026-05-09)

| File | Single-sentence purpose | Public exports | Depends on | Lines tgt/max |
|---|---|---|---|---|
| `src/shared/application-failure.ts` | Wraps activity errors as Temporal `ApplicationFailure` with catalog-derived `nonRetryable` so the workflow's `nonRetryableErrorTypes` matches by `type` field. | `FailureContext`, `failureFor`, `rethrowAs` | `@temporalio/common`, `./error-codes` | 80 / 200 |
| `src/shared/application-failure.test.ts` | Verifies `failureFor` reads `ERROR_CODE_METADATA.retryability` correctly and `rethrowAs` coerces non-Error causes. | (vitest) | `@temporalio/common`, `./application-failure`, `./error-codes` | 100 / 250 |
| `src/shared/error-codes.ts` | Stable Zer0 error code enum + retryability metadata catalog; exports `NON_RETRYABLE_ERROR_TYPES` derived from the catalog (Phase 1h adds the export). | `Zer0ErrorCode`, `ErrorCategory`, `ErrorRetryability`, `ErrorCodeMetadata`, `ERROR_CODE_METADATA`, `NON_RETRYABLE_ERROR_TYPES`, `getErrorMetadata`, `isZer0ErrorCode` | (none — pure) | 360 / 500 |
| `src/shared/error-codes.test.ts` | Verifies enum stability, metadata coverage, and `NON_RETRYABLE_ERROR_TYPES` derivation from `ERROR_CODE_METADATA`. | (vitest) | `./error-codes` | 120 / 250 |
| `src/evidence/phase-events.ts` | Records phase-transition events to the append-only `events` table with `(run_id, idempotency_key)` ON CONFLICT DO NOTHING semantics. | `PhaseEventKind`, `PhaseEventPayload`, `RecordPhaseEventInput`, `PhaseEvent`, `recordPhaseEvent`, `readPhaseEvents` | `./db`, `./runs-bootstrap`, `../shared/ids` | 150 / 300 |
| `src/evidence/phase-events.test.ts` | Verifies single-write round-trip, monotonic sequence per run, payload JSON round-trip, append-only triggers, and idempotent retry semantics. | (vitest) | `node:fs/promises`, `node:os`, `node:path`, `./phase-events`, `./db` | 180 / 350 |
| `src/temporal/activities/persist-phase-transition.ts` | Workflow-callable activity that persists a phase event row via `recordPhaseEvent` with Zod input validation and ApplicationFailure wrapping. | `PersistPhaseTransitionInput`, `PersistPhaseTransitionDeps`, `persistPhaseTransitionActivity` | `@temporalio/common`, `zod`, `../../evidence/phase-events`, `../../evidence/db`, `../../shared/application-failure`, `../../shared/error-codes` | 110 / 250 |
| `src/temporal/activities/persist-phase-transition.test.ts` | Verifies Zod input validation, dispatch to `recordPhaseEvent`, and ApplicationFailure wrapping on invalid kinds. | (vitest) | `@temporalio/common`, `./persist-phase-transition` | 100 / 250 |
| `tests/integration/build-packet-retry-policy.test.ts` | Proves nonRetryable activity errors fail fast (<2s, 1 attempt) and retryable codes retry up to `maximumAttempts` against real `buildPacketWorkflow` retry policy via Temporal time-skip. | (vitest) | Temporal testing/worker, `execa`, evidence DB, packet activities, application-failure helper | 220 / 500 |
| `tests/integration/build-packet-phase-events.test.ts` | Proves canonical 7-kind happy event sequence + idempotent retry semantics on `persistPhaseTransitionActivity` against real workflow + SQLite. | (vitest) | Temporal testing/worker, `execa`, evidence DB, packet activities, phase-events helpers | 240 / 500 |
| `src/temporal/activities/context-compiler.ts` | Reads persisted findings from evidence.findings(runId) and renders the PRIOR REVIEW FINDINGS section that prepareContextActivity injects into the next codex prompt (packet-12a Phase A). | `PersistedFinding`, `CompileFindingsInput`, `CompiledFindings`, `compileFindings` | `../../evidence/db`, `../../evidence/queries`, `../../shared/types` | 140 / 250 |
| `src/temporal/activities/context-compiler.test.ts` | Verifies severity-desc + rowid-desc ordering, P0-always + path-relevance hybrid filter, maxFindings cap, per-finding char cap, section-line cap with `[N more truncated]` footer, ZER0_DB_PATH isolation. | (vitest) | tmp DB helpers, `./context-compiler`, `../../evidence/db`, `../../evidence/queries` | 180 / 350 |
| `src/temporal/activities/diff-compiler.ts` | Runs `git show <lastRevertedSha>` via injectable gitFn, truncates to maxLines, falls back to empty diffSection on transient git failure (packet-12a Phase A). | `CompiledDiff`, `CompileDiffInput`, `compileDiff` | `node:os`, `node:path`, `execa` | 120 / 250 |
| `src/temporal/activities/diff-compiler.test.ts` | Verifies undefined sha → empty section, success path renders header + truncated diff, transient git error falls back silently, line-cap with footer. | (vitest) | injected gitFn mock, `./diff-compiler` | 130 / 250 |
| `tests/integration/context-compiler-fix-loop.test.ts` | Workflow-replay test asserting attempt 2 promptText contains attempt 1 findings' file:line + dimension + message verbatim and contains last-reverted-commit diff substring (packet-12a Phase D falsifying). | (vitest) | Temporal testing/worker, `execa`, evidence DB, ZER0_DB_PATH redirect, packet activities | 240 / 500 |

### `scripts/diagnose/` — external standalone scripts (Packet 10, IN-FLIGHT)

**NOT in `src/` tree. NOT compiled with TS. Plain Node `.mjs` files. NO imports from `src/temporal`, `src/cli`, `src/evidence/db.ts`, or any compiled-TS project artifact.**

| File | Single-sentence purpose | Reads | Writes | Lines tgt/max |
|---|---|---|---|---|
| `diagnose/_lib.mjs` | Shared utilities: `openDbReadonly(path)`, `resolveBlob(blobRoot, hash)`, `readStateSnapshot(runDir)`, `validateAgainstSchema(payload, schemaName)`. | `.zer0/evidence.db`, `.zer0/blobs/`, `.zer0/runs/*/state.json`, `.zer0/SCHEMA.json` | (none — pure helpers) | 200 / 400 |
| `diagnose/last-run.mjs` | Find latest run without runtime; outputs `LastRunSummary` JSON when `--json`. | `.zer0/evidence.db` (RO), `.zer0/runs/*/state.json` | stdout only | 100 / 250 |
| `diagnose/inspect-run.mjs` | Build full `RunInspection` from disk; mirrors `src/observability/inspect.ts` output but standalone. | `.zer0/evidence.db` (RO), `.zer0/blobs/`, `.zer0/runs/*/state.json` | stdout only | 250 / 500 |
| `diagnose/failure-context.mjs` | Emit agent-ready repair brief (`failure-context.md` markdown + `failure-context.json` sidecar). | `.zer0/evidence.db` (RO), `.zer0/blobs/`, `.zer0/runs/*/state.json` | `.zer0/runs/{id}/failure-context.{md,json}` (only output, NEVER mutate evidence) | 250 / 500 |
| `diagnose/trace-error.mjs` | Find prior occurrences of a stable error code (`ZER0_*`) across all runs. | `.zer0/evidence.db` (RO) | stdout only | 100 / 250 |
| `diagnose/integrity-check.mjs` | DB readability + schema drift + missing blobs + stale snapshots + WAL anomalies. | `.zer0/evidence.db` (RO), `.zer0/blobs/`, `.zer0/runs/*/state.json` | stdout only | 200 / 400 |
| `adr-index-build.mjs` | Builds `.council/adr-index.json` from ADR markdown identifiers. | `build` | `node:fs/promises`, `node:path`, `node:url` | 77 / 250 |

### `src/room/` — V2 room runtime

| File | Single-sentence purpose | Public exports | Depends on | Lines tgt/max | Status |
|---|---|---|---|---|---|
| `room-host-outcome.ts` | Resolve a settled provider lane to its canonical message and protocol result. | lane outcome type, message/result builders | headless turn, chat types, room engine/handoff | 60 / 100 | ✅ |
| `room-eager-sessions.ts` | Coordinate V2 background ACP warm-up behind a shared readiness barrier. | `RoomEagerSessions` | `../chat/eager-session-boot`, `../chat/events`, `../chat/lane-transport`, `../memory/memory-flags` | 63 / 250 | ✅ |
| `room-engine-capacity.ts` | Reserve journal closure before durable submission and preflight recovery before any repair write. | `RoomJournalCapacity`, capacity/recovery helpers | room engine contract/primitives | 163 / 250 | ✅ |

| `room-engine-contract.ts` | Define the stable room scheduler seam shared by host, recovery, transport, and tests. | room event/lane/options types, lane identity, journal/resync limits | `../chat/types`, `./room-handoff`, `./room-journal` | 101 / 250 | ✅ |
| `room-engine-primitives.ts` | Own pure identity, payload, chunking, and failure helpers for the room scheduler. | room event sizing/text bounds/failure/identity/chunk helpers | chat types, render escaping, room engine contract/journal | 106 / 250 | ✅ |
| `room-handoff.ts` | Extract the one allowed final-line read-only room handoff before persistence. | handoff contracts, extraction, validation, text bound | `../chat/types` | 74 / 250 | ✅ |
| `room-host-contract.ts` | Define public configuration and command contracts for `AliveRoomHost`. | `RoomHostOptions`, `RoomSubmit`, `RoomControl`, `RoomModeCycle` | headless turn, carrier, eager boot, room engine contract | 49 / 250 | ✅ |
| `room-host-support.ts` | Own room-host bootstrap plus projection, routing, timeout, and journal helpers. | room session/bootstrap, bus/projection/routing/deadline/journal helpers | Node fs, chat session/carrier/events/router/types, render escaping, room contracts | 230 / 250 | ✅ |
| `room-mode.ts` | Own real per-agent native-mode cycling and truthful room mode events. | `RoomModeController`, `RoomModeEventPayload` | native mode stores/catalogs, carrier mode, target resolver, room protocol | 259 / 400 | ✅ |
| `room-models.ts` | Own live model discovery/application, transient warm-up recovery, and room-scoped Gemini selection persistence. | `RoomModelCatalog`, `RoomModelController`, `RoomModelRow` | Node fs, ACP lane model API, AGY model discovery/store, eager readiness | 173 / 250 | ✅ |
| `zer0-v2-request-scheduler.ts` | Preserve mutation order while allowing bounded picker discovery to run without blocking room commands. | `RoomRequestScheduler`, request-domain helpers, NDJSON stdin consumer | `./zer0-v2-rpc` | 118 / 250 | ✅ |
| `zer0-v2-rpc.ts` | Own bounded JSON-RPC replay, serialized output, parsing, request fingerprinting, and tagged protocol errors. | replay/writer/parser/fingerprint/error helpers | Node crypto, `./room-protocol` | 230 / 250 | ✅ |

### Cross-cutting V2 safety and build additions

| File | Single-sentence purpose | Public exports | Depends on | Lines tgt/max | Status |
|---|---|---|---|---|---|
| `src/memory/memory-safety.ts` | Keep transcript reply controls and prompt-injection text out of reusable project memory. | `isSafeSharedMemoryBody` | (none) | 27 / 100 | ✅ |
| `src/evidence/migrations-v20.ts` | Move native lane sessions, cursors, and attempts into explicit room scopes without guessing ownership of legacy rows. | `MIGRATION_V16_TO_V20` | (none) | 83 / 150 | ✅ |
| `src/shared/usage-display-policy.ts` | Choose truthful live usage meters without fabricating unavailable provider data. | `MeterSource`, `MeterSpec`, `visibleMeters` | (none) | 44 / 100 | ✅ |
| `scripts/clean-dist.mjs` | Remove generated TypeScript output before every production build. | (script) | Node fs/path/url | 11 / 100 | ✅ |
| `scripts/copy-evidence-schema.mjs` | Copy non-TypeScript runtime assets required by the compiled room host. | `copyEvidenceSchema`, `copyProductionRuntimeAssets` | Node fs/path/url | 61 / 150 | ✅ |
| `tsconfig.production.json` | Compile only the production V2 host closure without test declarations or source maps. | (configuration) | `tsconfig.json` | 19 / 100 | ✅ |

### `.zer0/` generated artifacts

| Artifact | Purpose | Regeneration |
|---|---|---|
| `.zer0/evidence.db` | SQLite evidence database for runs, tasks, dispatches, gates, findings, errors, and events. | `zer0 start ...` |
| `.zer0/blobs/<aa>/<sha256>` | Content-addressed blob store for captured stdout, stderr, diffs, context, and repair artifacts. | Produced by evidence-writing activities during `zer0 start ...` |
| `.zer0/runs/<runId>/state.json` | Atomic crash-readable run state snapshot. | Produced by `StateWriter` during run state updates |
| `.zer0/SCHEMA.json` | JSON Schema bundle for generated observability artifacts. | `npx tsx -e "import { generateSchemaBundle } from './src/observability/schema-bundle.ts'; console.log(JSON.stringify(generateSchemaBundle(), null, 2))"` |

---

## ★★★ ANTI-MONOLITH PRINCIPLES (L5+ Google senior engineer bar) ★★★

These are not aesthetic — they are LOAD-BEARING for the system's testability, replaceability, and review economics.

### 1. Single Responsibility Principle (file-level)
Every file's purpose fits in **one sentence with no "and"**. If you write "this file does X **and** Y" — split it. The "purpose" cell in the table above is the contract; if a file's actual code drifts from its declared purpose, the file is wrong, the contract is wrong, or both — never silently accept the drift.

### 2. Acyclic Dependency Principle
Cycles destroy testability. The DAG above is the contract. `dependency-cruiser` enforces it mechanically (`npm run dep-check`). A cycle = automatic build FAIL with `error: cycle detected: A → B → A`.

### 3. Stable Dependencies Principle
Depend in the direction of stability. `src/shared/types.ts` has zero project deps and is depended on by everything — that's correct. `src/cli/commands/start.ts` depends on five layers below it and is depended on by nothing — that's correct. NEVER reverse this.

### 4. Reuse-Release Equivalence
Every export is a contract. New functionality goes through ONE OF: (a) extend an existing exported function, (b) add a new export to an existing file IF it shares the file's single-sentence purpose, (c) create a new file with its own row in this map. NEVER (d) add a private helper that "we'll extract later" — extract now.

### 5. Common Closure Principle
Files that change together belong together. If `dispatch.ts` and `dispatch-types.ts` always change in the same commit, they should be the same file. Conversely, if `claude.ts` and `codex.ts` change for entirely different reasons, they MUST stay split.

### 6. Public API Minimization
Every exported symbol increases the documentation surface and the test surface and the review surface forever. **Default to non-exported.** Only export what callers prove they need by importing it. The "Public exports" column is the **whole** public surface — no other exports allowed without first updating the map.

### 7. Sandbox Boundaries Are Sacred
`src/temporal/workflows/**` is a V8 sandbox. Importing a file with side effects from a workflow is silent corruption — it works in tests, breaks on replay. The dep-cruiser `workflow-sandbox-purity` rule blocks this at build time. **Adding a workflow file requires zero new imports outside the allowlist.** If you need state, put it behind an activity.

### 8. Tooling Before Code
Mechanical enforcement runs before any human review:
- `npm run typecheck` — strict + isolatedDeclarations + exactOptional + noUncheckedIndexedAccess
- `npx biome check .` — formatter + linter (cognitive complexity ≤ 15)
- `node scripts/gate-clamps.mjs` — file ≤500L, function ≤50L, params ≤5, no slop tokens
- `node scripts/gate-encoding.mjs` - source/docs mojibake detection for double-encoded UTF-8
- `npm run dep-check` — dependency-cruiser DAG enforcement (cycles, upward deps, sandbox purity)
- `npm run dead-code` — knip detects unused exports + unimported files
- `npm test` — vitest

A green run on all six is the price of admission to any review. ANY red = builder fixes before requesting review.

---

## ★★★ HOW TO USE THIS MAP ★★★

**Builder:** before writing the first line of a new file, locate it in this map. If your file isn't here, STOP — update the map FIRST, then write the file. Single-sentence purpose is the test: if you can't write one without "and", the file is wrong.

**Reviewer:** for every file in the diff, verify it matches its row: purpose declared in the file-header comment matches the map; only listed exports are exported; only listed dependencies are imported; line count within budget. Drift = finding.

**Orchestrator (claude):** every BUILD BRIEF MUST cite the relevant rows of this map verbatim. Every AUDIT RUBRIC MUST contain a "module map conformance" rubric item.

**Spec change:** if a packet legitimately needs a file not in this map, the change happens in THIS document FIRST, then propagates to the BUILD BRIEF, then is implemented. Never the other way around.

---

## VERSIONING

This map is updated when:
- A packet adds a new file or removes a file (mandatory)
- An export is added to or removed from the public API (mandatory)
- A line budget is intentionally raised (with one-line justification appended)

It is NOT updated for:
- Internal refactoring that preserves the public API
- Test additions (tests live colocated, not on this map — every `*.ts` has implicit `*.test.ts` or `*.spec.ts`)
- Comments / TSDoc improvements

**Last updated:** 2026-05-03 — initial canonical map post-packet-01.
