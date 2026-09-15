# Zer0 Agent CI — Operational Execution Plan

**Version:** 1.0
**Date:** 2026-05-03
**Purpose:** Day-1 engineering blueprint. Every mechanism, file, trigger, and sequence specified.
**Prerequisite:** SPEC-CANONICAL-v6.md (architecture). This document is HOW to build it.

---

## 1. PROJECT STRUCTURE

```
agents-zer0/
├── package.json                  # type: "module", tsx runner
├── tsconfig.json                 # strict, isolatedDeclarations: true, target ES2022
├── biome.json                    # lint + format config
├── vitest.config.ts
├── docker-compose.yml            # Temporal dev server
├── .env.example                  # Temporal address, blob root
├── src/
│   ├── index.ts                  # CLI entry: process.argv routing
│   ├── cli/
│   │   ├── router.ts             # Command dispatch (start, resume, status, etc.)
│   │   ├── commands/
│   │   │   ├── start.ts          # zer0 start "<vision>"
│   │   │   ├── resume.ts         # zer0 resume <run-id> <phase>
│   │   │   ├── status.ts         # zer0 status <run-id>
│   │   │   ├── log.ts            # zer0 log / zer0 findings
│   │   │   ├── cost.ts           # zer0 cost
│   │   │   ├── doctor.ts         # zer0 doctor (health check)
│   │   │   ├── mode.ts           # zer0 mode auto|semi|full
│   │   │   ├── context.ts        # zer0 context inspect BUILD-005
│   │   │   └── eval.ts           # zer0 eval run
│   │   └── output.ts             # Terminal formatting (yoctocolors, figures)
│   ├── temporal/
│   │   ├── server.ts             # Start/stop Temporal dev server programmatically
│   │   ├── client.ts             # Temporal Client singleton (signal, query, start)
│   │   ├── worker.ts             # Worker registration (connects activities)
│   │   ├── workflows/
│   │   │   ├── pipeline.ts       # Main 12-phase pipeline workflow
│   │   │   ├── build-task.ts     # Single build-task sub-workflow
│   │   │   ├── review-cycle.ts   # Review + fix loop sub-workflow
│   │   │   └── tournament.ts     # Tournament fan-out sub-workflow
│   │   ├── activities/
│   │   │   ├── dispatch.ts       # Core: dispatch agent CLI + capture output
│   │   │   ├── intent.ts         # Intent Compiler activity
│   │   │   ├── research.ts       # Research activity (per agent)
│   │   │   ├── spec.ts           # Spec generation activity
│   │   │   ├── architecture.ts   # Architecture generation activity
│   │   │   ├── plan.ts           # Plan generation activity
│   │   │   ├── build.ts          # Build packet activity
│   │   │   ├── review.ts         # Cross-family review activity
│   │   │   ├── fix.ts            # Fix loop activity
│   │   │   ├── audit.ts          # Final audit activity (deterministic)
│   │   │   ├── recon.ts          # Existing project scan activity
│   │   │   └── worktree.ts       # Git worktree create/destroy
│   │   └── signals.ts            # All signal/query/update definitions
│   ├── adapters/
│   │   ├── types.ts              # AgentAdapter interface + AgentResult type
│   │   ├── claude.ts             # Claude CLI adapter
│   │   ├── codex.ts              # Codex CLI adapter
│   │   ├── gemini.ts             # Gemini CLI adapter
│   │   └── registry.ts           # Agent name → adapter lookup
│   ├── context/
│   │   ├── compiler.ts           # Main: assemble 6-layer context pack
│   │   ├── indexer.ts            # Dual-signal file scoring
│   │   ├── compress.ts           # ts.transpileDeclaration + other compressions
│   │   ├── cold-tier.ts          # All-files 1-line summary (Cold)
│   │   ├── warm-tier.ts          # Top-K .d.ts selection (Warm)
│   │   ├── hot-tier.ts           # Full source of edit targets (Hot)
│   │   ├── assembly.ts           # 6-layer prompt construction
│   │   ├── budget.ts             # Token budget calculation + truncation
│   │   ├── prefetch.ts           # Background context compilation for next task
│   │   └── templates/
│   │       ├── static-prefix.md  # Layer 1: quality floor, anti-skeleton
│   │       ├── endcap.md         # Layer 6: thoroughness demand
│   │       ├── build-brief.md    # Build task template
│   │       ├── review-rubric.md  # Review rubric template
│   │       └── lookahead.md      # Next-task lookahead template
│   ├── intent/
│   │   ├── compiler.ts           # Vibe → IntentBrief translation
│   │   ├── vocabulary.ts         # Vocabulary map extraction
│   │   ├── qa-planner.ts         # Q&A plan generation
│   │   └── schema.ts             # IntentBrief Zod schema
│   ├── gates/
│   │   ├── engine.ts             # Gate evaluation engine (runs checks)
│   │   ├── plan-gate.ts          # PlanGate: ownership, coverage, contracts
│   │   ├── build-gate.ts         # BuildGate: mechanical clamps + slop
│   │   ├── review-gate.ts        # ReviewGate: P0/P1 threshold
│   │   ├── fix-gate.ts           # FixGate: repeated findings
│   │   ├── audit-gate.ts         # AuditGate: requirement coverage matrix
│   │   └── human-gate.ts         # HumanGate: approval signal wait
│   ├── stability/
│   │   ├── monitor.ts            # Signal detection + escalation
│   │   ├── signals.ts            # Signal definitions + thresholds
│   │   └── responses.ts          # Escalation actions (split, switch, ask)
│   ├── evidence/
│   │   ├── db.ts                 # SQLite init + migrations + queries
│   │   ├── schema.sql            # DDL (CREATE TABLE statements)
│   │   ├── queries.ts            # Prepared statement wrappers
│   │   ├── blobs.ts              # Blob store: write/read content-addressed
│   │   └── types.ts              # Row types matching SQL schema
│   ├── security/
│   │   ├── denylist.ts           # File pattern denylist check
│   │   ├── entropy.ts            # High-entropy string detection
│   │   └── filter.ts             # Combined pre-dispatch security filter
│   ├── patterns/
│   │   ├── loader.ts             # Load YAML domain patterns
│   │   ├── filter.ts             # Filter by spec decisions
│   │   └── yaml/                 # Domain pattern YAML files
│   │       ├── authentication.yaml
│   │       ├── api-endpoint.yaml
│   │       ├── database-schema.yaml
│   │       └── ...
│   ├── tournament/
│   │   ├── orchestrator.ts       # Fan-out to N agents
│   │   ├── arbiter.ts            # Evaluate competing implementations
│   │   └── worktree-pool.ts      # Manage isolated worktrees
│   ├── eval/
│   │   ├── runner.ts             # Promptfoo integration
│   │   ├── graders.ts            # Custom graders for intent/context/review
│   │   └── configs/              # Promptfoo YAML configs per eval type
│   └── shared/
│       ├── types.ts              # Global types (RunId, TaskId, etc.)
│       ├── config.ts             # .zer0/config.yaml loader
│       ├── logger.ts             # Structured logging
│       ├── crypto.ts             # SHA-256 hashing for content addressing
│       └── errors.ts             # Typed error classes
├── prompts/
│   ├── intent-compiler.md
│   ├── research-gemini.md
│   ├── research-codex.md
│   ├── research-claude.md
│   ├── spec-generator.md
│   ├── architecture-generator.md
│   ├── plan-generator.md
│   └── reviewer.md
└── tests/
    ├── unit/
    │   ├── context/
    │   ├── gates/
    │   ├── adapters/
    │   └── evidence/
    ├── integration/
    │   ├── pipeline-happy.test.ts
    │   ├── gate-blocks.test.ts
    │   ├── crash-recovery.test.ts
    │   └── hostile-isolation.test.ts
    └── fixtures/
```

---

## 2. TEMPORAL WORKFLOW ARCHITECTURE

### 2.1 Workflow Definitions

**Task Queue:** `zer0-pipeline`

**Main Workflow:** `pipelineWorkflow`

```typescript
// src/temporal/workflows/pipeline.ts
import {
  proxyActivities,
  defineSignal,
  defineQuery,
  defineUpdate,
  setHandler,
  condition,
  startChild,
  sleep,
} from "@temporalio/workflow";

// --- SIGNALS ---
export const approveSignal = defineSignal<[string]>("approve"); // payload: phase name
export const rejectSignal = defineSignal<[string, string]>("reject"); // phase, reason
export const overrideSignal = defineSignal<[string, string]>("override"); // gate, reason
export const modeChangeSignal =
  defineSignal<["auto" | "semi" | "full"]>("modeChange");
export const cancelSignal = defineSignal("cancel");

// --- QUERIES ---
export const statusQuery = defineQuery<PipelineStatus>("status");
export const findingsQuery = defineQuery<Finding[], [string?]>("findings");
export const costQuery = defineQuery<CostReport>("cost");
export const contextQuery = defineQuery<ContextInspection, [string]>(
  "contextInspect",
);

// --- UPDATES ---
export const answerUpdate = defineUpdate<void, [string, string]>("answer"); // questionId, answer
```

**Child Workflows:**

| Workflow Name         | Purpose                                               | Parent Signal                        |
| --------------------- | ----------------------------------------------------- | ------------------------------------ |
| `buildTaskWorkflow`   | Execute single build packet (dispatch + gate + retry) | Reports completion/failure to parent |
| `reviewCycleWorkflow` | Review + fix loop (max 3 iterations)                  | Reports PASS/FAIL                    |
| `tournamentWorkflow`  | Fan-out N agents, arbiter pick                        | Reports winner                       |

### 2.2 Activity Definitions

All activities live in `src/temporal/activities/` and are registered on a single worker.

| Activity Name          | File                 | Timeout | Retry         | Heartbeat |
| ---------------------- | -------------------- | ------- | ------------- | --------- |
| `dispatchAgent`        | dispatch.ts          | 5 min   | 3x, backoff 2 | Every 30s |
| `compileIntent`        | intent.ts            | 3 min   | 2x            | No        |
| `runResearch`          | research.ts          | 5 min   | 2x, backoff 2 | Every 60s |
| `generateSpec`         | spec.ts              | 5 min   | 2x            | No        |
| `generateArchitecture` | architecture.ts      | 5 min   | 2x            | No        |
| `generatePlan`         | plan.ts              | 5 min   | 2x            | No        |
| `executeBuildPacket`   | build.ts             | 3 min   | 2x, backoff 2 | Every 30s |
| `executeReview`        | review.ts            | 3 min   | 2x            | No        |
| `executeFix`           | fix.ts               | 3 min   | 2x, backoff 2 | Every 30s |
| `runAudit`             | audit.ts             | 1 min   | 1x            | No        |
| `reconProject`         | recon.ts             | 2 min   | 1x            | No        |
| `createWorktree`       | worktree.ts          | 30s     | 1x            | No        |
| `destroyWorktree`      | worktree.ts          | 30s     | 1x            | No        |
| `compileContext`       | (inline in dispatch) | 10s     | 1x            | No        |
| `evaluateGate`         | (inline in gates)    | 5s      | 1x            | No        |
| `storeEvidence`        | (inline in evidence) | 5s      | 1x            | No        |

### 2.3 Signal Flow Diagram

```
User CLI                  Temporal Client              Pipeline Workflow
─────────                 ───────────────              ─────────────────
zer0 start "build X" ──► client.start(pipeline, {     ─► workflow begins
                           args: [vision, mode]           Phase 0: INIT
                         })                               Phase 1: INTENT
                                                          Phase 2: Q&A
                                                            ↓
                                                          [if mode != auto]
                                                          await condition(approved)
                                                            ↑
zer0 resume <run-id> <phase> ──► handle.signal(approve,      ──► approved = true
                           'intent')                      Phase 3: RESEARCH
                                                          ...continues...
                                                            ↓
zer0 status ────────────► handle.query(status)        ──► returns PipelineStatus
                         ◄─── { phase, progress, ... }

zer0 findings ──────────► handle.query(findings)      ──► returns Finding[]

zer0 mode full ─────────► handle.signal(modeChange,   ──► mode = 'full'
                           'full')
```

---

## 3. EXACT SEQUENCE: "zer0 start" TO CODE SHIPPED

### Step 1: CLI Entry (`src/index.ts`)

```typescript
// src/index.ts
import { route } from "./cli/router.js";
route(process.argv.slice(2));
```

### Step 2: Start Command (`src/cli/commands/start.ts`)

```
1. Parse required vision argument.
2. Phase-1 does not preflight doctor checks inside `start`; run `zer0 doctor` separately for:
   a. Temporal server reachable (gRPC ping)
   b. Claude CLI responds to --version
   c. Codex CLI responds to --version
   d. Gemini CLI responds to --version
   e. SQLite writable
   f. Git repo detected
3. Generate runId: `run-${timestamp}-${randomHex(4)}`
4. Initialize .zer0/ scaffold:
   .zer0/
   ├── config.yaml          # Run config (mode, thresholds)
   ├── evidence.db          # SQLite (created by schema.sql)
   ├── blobs/               # Content-addressed storage
   └── runs/{runId}/        # This run's artifacts
       ├── intent/
       ├── research/
       ├── spec/
       ├── architecture/
       ├── plan/
       ├── build/
       ├── review/
       └── audit/
5. Execute SQLite migrations (schema.sql)
6. Insert run record: INSERT INTO runs(id, vision, status, branch, base_commit, started_at)
7. Start Temporal workflow:
   client.workflow.start(pipelineWorkflow, {
     taskQueue: 'zer0-pipeline',
     workflowId: runId,
     args: [{ vision, mode, runId, repoRoot, baseCommit }],
   })
8. Print: "Pipeline started. Run: {runId}. Use `zer0 status` to watch."
```

### Step 3: Pipeline Workflow Executes

```
Phase 0: INIT
├── Activity: reconProject (if existing codebase detected)
│   └── Scans: package.json, tsconfig, framework detection
│   └── Output: .zer0/runs/{id}/recon.json
├── Gate: InitGate (db alive, CLIs healthy)
└── SQLite: INSERT gate_transitions(init → intent_compile, passed=true)

Phase 1: INTENT COMPILE
├── Activity: compileIntent
│   ├── Builds context: vision + recon (if exists)
│   ├── Dispatches Claude with prompts/intent-compiler.md
│   ├── Parses output: IntentBrief (Zod validated)
│   └── Stores: 8 files in .zer0/runs/{id}/intent/
│       ├── brief.json         (normalized goal)
│       ├── vocabulary.json    (domain terms)
│       ├── rubric.json        (quality criteria)
│       ├── assumptions.json   (listed for user validation)
│       ├── questions.json     (Q&A plan)
│       ├── research-plan.json (what to research)
│       ├── risks.json         (risk checklist)
│       └── enrichment.json    (source references)
├── Gate: IntentGate (schema valid, vocabulary non-empty)
└── Evidence: blob(prompt), blob(response), context_runs record

Phase 2: VISION Q&A
├── [If mode == 'auto': skip OR use defaults from assumptions]
├── [If mode == 'semi' or 'full']:
│   ├── Emit questions to CLI via query
│   ├── Wait: condition(() => allQuestionsAnswered)
│   ├── CLI: zer0 resume presents questions, user answers
│   ├── Signal: answerUpdate(questionId, answer) for each
│   └── Update: merge answers into intent brief
├── Gate: QAGate (all questions answered or deferred)
└── Evidence: answers stored in runs/{id}/intent/answers.json

Phase 3: RESEARCH (parallel)
├── Activities (Promise.all):
│   ├── runResearch('gemini', researchPlan)  → .zer0/runs/{id}/research/gemini.md
│   ├── runResearch('codex', researchPlan)   → .zer0/runs/{id}/research/codex.md
│   └── runResearch('claude', researchPlan)  → .zer0/runs/{id}/research/claude.md
├── Activity: synthesizeResearch(gemini, codex, claude)
│   └── Output: .zer0/runs/{id}/research/synthesis.md
├── Gate: ResearchGate (≥2 reports exist, synthesis covers stack+arch+risks)
├── [If mode == 'full']: await approval signal
└── Evidence: 3 dispatch records, synthesis blob

Phase 4: SPEC
├── Activity: generateSpec
│   ├── Context: intent brief + research synthesis + answers
│   ├── Dispatches Claude with prompts/spec-generator.md
│   ├── Output: .zer0/runs/{id}/spec/spec.md
│   └── Cross-review: dispatch Codex for completeness check
├── Gate: SpecGate (data model, APIs, UI, errors, security, scale sections exist)
├── [If mode != 'auto']: await approval signal
└── Evidence: prompt blob, response blob, review blob

Phase 5: ARCHITECTURE
├── Activity: generateArchitecture
│   ├── Context: spec + research + intent
│   ├── Output: .zer0/runs/{id}/architecture/architecture.md
│   └── Cross-review: dispatch Codex for accuracy
├── Gate: ArchGate (all sections present, decisions cite research)
├── [If mode != 'auto']: await approval signal
└── Evidence: stored

Phase 6: PLAN
├── Activity: generatePlan
│   ├── Context: spec + architecture
│   ├── Output:
│   │   ├── .zer0/runs/{id}/plan/tasks.yaml  (build packets)
│   │   ├── .zer0/runs/{id}/plan/contracts.ts (shared types)
│   │   └── .zer0/runs/{id}/plan/graph.json   (dependency DAG)
│   └── Validation: contracts.ts compiles via tsc
├── Gate: PlanGate
│   ├── Every requirement assigned to ≥1 packet
│   ├── No ownership overlap between packets
│   ├── No cycles in dependency graph
│   └── contracts.ts compiles clean
├── [If mode != 'auto']: await approval signal
└── Evidence: plan blob, coverage matrix

Phase 7: BUILD (sequential/parallel per dependencies)
├── For each task in topological order:
│   ├── [If independent of in-progress tasks: parallel allowed]
│   ├── Start child workflow: buildTaskWorkflow(task)
│   │   ├── 1. Context Compile:
│   │   │   ├── compileContext(task, manifest, spec)
│   │   │   ├── Hot: full source of task.modifies + task.creates
│   │   │   ├── Warm: .d.ts of top-K scored deps
│   │   │   ├── Cold: all file names + export summaries
│   │   │   ├── Assemble 6-layer prompt
│   │   │   ├── Security filter (denylist + entropy)
│   │   │   ├── Store: context_runs + context_items + blob
│   │   │   └── Output: ContextPack (content-addressed)
│   │   ├── 2. Dispatch:
│   │   │   ├── createWorktree(`wt-${runId}-${agent}-${timestamp}`)
│   │   │   ├── Write context to temp file (stdin source)
│   │   │   ├── dispatchAgent(adapter, contextPack, worktreePath)
│   │   │   ├── Heartbeat every 30s
│   │   │   ├── Parse output (Zod validate)
│   │   │   ├── If malformed: retry (max 3)
│   │   │   └── Output: AgentResult (files changed, stdout, stderr)
│   │   ├── 3. Build Gate:
│   │   │   ├── Ownership check: diff only touches task.owned_files
│   │   │   ├── Mechanical clamps: tsc strict, Biome, vitest
│   │   │   ├── Max function length (50), max file length (500)
│   │   │   ├── Slop detection: TODO/FIXME/placeholder/as any/console.log
│   │   │   ├── If FAIL: errors → retry (max 2)
│   │   │   └── If PASS: proceed
│   │   ├── 4. Post-Build:
│   │   │   ├── ts.transpileDeclaration() on new/changed files
│   │   │   ├── Update Build Manifest (.zer0/manifest.json)
│   │   │   ├── Update requirement coverage (file:line → requirement)
│   │   │   ├── Store evidence: dispatch record, blobs
│   │   │   └── destroyWorktree (merge to branch first)
│   │   └── 5. Stability Check:
│   │       ├── Monitor signals (see Section 7)
│   │       └── If triggered: escalation response
│   ├── [While current task runs: prefetch context for next independent task]
│   └── Continue to next task
├── Gate: AllBuildGate (all packets complete)
└── Evidence: full trace per task

Phase 8: REVIEW
├── Start child workflow: reviewCycleWorkflow(spec, buildResult)
│   ├── Iteration 1:
│   │   ├── Context: spec section + acceptance + contracts.ts + code + rubric
│   │   ├── NEVER: builder prompt, builder reasoning, prior findings
│   │   ├── Dispatch: Claude (cross-family from builder)
│   │   ├── Parse: RubricReviewOutput (Zod)
│   │   ├── Gate: ReviewGate
│   │   │   ├── Zero P0 → PASS
│   │   │   ├── P1 ≤ 5 → PASS_WITH_COMMENTS
│   │   │   └── Else → FAIL → enter fix loop
│   │   └── Finding-Inflation Clamp: >15 findings → 25% discount
│   ├── Fix Loop (if FAIL):
│   │   ├── Mechanical Fix Verifier: grep/diff that prior P0 file:line changed
│   │   ├── Dispatch builder with fix context (errors only)
│   │   ├── Re-run build gate
│   │   ├── Blind AI Review: FRESH reviewer, NO prior findings
│   │   ├── If same finding 2x → architectural escalation
│   │   └── Max 3 iterations
│   └── Output: ReviewResult (verdict, findings, rubric results)
├── Gate: ReviewGate (zero P0, P1 ≤ threshold after fix loop)
└── Evidence: all review dispatches + findings

Phase 9: FINAL AUDIT (deterministic)
├── Activity: runAudit
│   ├── For each requirement in requirements table:
│   │   ├── Check: evidence_file IS NOT NULL
│   │   ├── Check: evidence_line IS NOT NULL
│   │   ├── Check: evidence_test IS NOT NULL (test covers it)
│   │   └── Mark: COVERED or UNCOVERED
│   ├── Run: full test suite one final time
│   ├── Check: zero open P0/P1 findings
│   └── Output: coverage matrix + final test results
├── Gate: AuditGate (100% coverage, all tests pass, no open P0/P1)
└── Evidence: coverage report blob

Phase 10: SHIP
├── Generate ship report
├── [If mode != 'auto']: await approval signal
├── Options presented to user:
│   ├── merge    → git merge to base branch
│   ├── pr       → create pull request
│   ├── keep     → keep feature branch
│   └── discard  → delete branch
├── Execute user choice
├── Update run status: 'shipped' | 'kept' | 'discarded'
└── Print: final cost report, time elapsed, findings resolved
```

---

## 4. GATES: EXACT TRIGGER MECHANISM

### How Gates Fire Automatically

Gates do NOT "fire." They are EVALUATED synchronously within the workflow after each activity completes. The workflow code is the controller:

```typescript
// Inside pipeline workflow — example pattern
const specResult = await activities.generateSpec(contextPack);

// Gate evaluation happens HERE — deterministic, in-workflow
const gateResult = evaluateSpecGate(specResult);

if (!gateResult.passed) {
  // Store evidence
  await activities.storeEvidence({
    gate: "SpecGate",
    passed: false,
    evidence: gateResult.evidence,
    reason: gateResult.reason,
  });

  if (gateResult.retryable && retries < MAX_RETRIES) {
    // Retry the activity
    retries++;
    continue;
  }

  // Block — requires human intervention
  blocked = true;
  await condition(() => overrideReceived || rejected);
  // ... handle override or rejection
}

// Gate passed — continue to next phase
await activities.storeEvidence({
  gate: "SpecGate",
  passed: true,
  evidence: gateResult.evidence,
});
```

### Key Insight: "Build Done → Review" Transition

There is no event bus or callback system. The workflow IS the controller:

```typescript
// In buildTaskWorkflow
for (const attempt of range(1, MAX_BUILD_RETRIES + 1)) {
  const buildResult = await activities.executeBuildPacket(
    task,
    contextPack,
    worktreePath,
  );

  // Build gate is a function call, not an event
  const gateResult = evaluateBuildGate(buildResult, task);

  if (gateResult.passed) {
    // Automatically proceed to post-build
    await activities.updateManifest(buildResult);
    return buildResult;
  }

  // Failed — feed errors back for retry
  contextPack = recompileWithErrors(contextPack, gateResult.errors);
}

// Exhausted retries — escalate
throw new ApplicationFailure(
  "BuildGate failed after max retries",
  "BUILD_GATE_EXHAUSTED",
);
```

The parent workflow catches this and decides whether to enter review:

```typescript
// In pipelineWorkflow
const buildResults = [];
for (const task of topologicalOrder(plan.tasks)) {
  const result = await startChild(buildTaskWorkflow, { args: [task] });
  buildResults.push(result);
}

// ALL builds complete → automatically start review
const reviewResult = await startChild(reviewCycleWorkflow, {
  args: [spec, buildResults],
});
```

---

## 5. THREE-TIER CONTEXT ASSEMBLY (Step by Step)

### Input: A build task `BUILD-030`

```yaml
BUILD-030:
  implements: "spec.section.3.2"
  creates: ["src/api/users.ts"]
  modifies: ["src/api/index.ts"]
  reads: ["src/auth/service.ts"]
  contracts: ["User", "AuthService"]
  owned_files: ["src/api/users.ts", "src/api/index.ts"]
  acceptance:
    - "Returns 401 for invalid token"
    - "Rate limits to 100 req/min"
  depends_on: ["BUILD-014"]
  enrichment_sources: ["authentication.yaml"]
```

### Step 1: Score All Project Files (`src/context/indexer.ts`)

```typescript
// For each file in the project:
const scored: ScoredFile[] = projectFiles.map((file) => ({
  path: file,
  score: scoreFile(file, task, manifest),
}));

// scoreFile implementation:
function scoreFile(
  file: string,
  task: BuildTask,
  manifest: BuildManifest,
): number {
  // Relevance signals
  const relevance =
    (task.modifies.includes(file) ? 150 : 0) +
    (task.reads.includes(file) ? 100 : 0) +
    importGraphHops(file, task.creates, manifest) * 25 +
    symbolOverlap(file, task.contracts) * 30 +
    (recentFailureInFile(file) ? 40 : 0) +
    (inStackTrace(file) ? 60 : 0);

  // Importance signals
  const importance =
    exportCount(file, manifest) * 0.5 +
    (isSharedContract(file) ? 2.0 : 1.0) +
    dependentCount(file, manifest) * 0.3;

  return Math.max(0, relevance) * importance;
}
```

### Step 2: Partition into Tiers (`src/context/compiler.ts`)

```typescript
function partitionTiers(scored: ScoredFile[], task: BuildTask): TierPartition {
  return {
    // HOT: Files being edited + acceptance criteria + failing output
    hot: scored.filter(
      (f) => task.creates.includes(f.path) || task.modifies.includes(f.path),
    ),

    // WARM: Top-K by score (excluding hot), compressed to .d.ts
    warm: scored
      .filter((f) => !hot.includes(f) && f.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, K), // K determined by budget

    // COLD: ALL files (always included)
    cold: scored, // Every file gets a 1-line entry
  };
}
```

### Step 3: Compress Each Tier (`src/context/compress.ts`)

```typescript
// HOT: No compression — full source
async function compressHot(files: ScoredFile[]): Promise<string[]> {
  return Promise.all(files.map((f) => fs.readFile(f.path, "utf-8")));
}

// WARM: ts.transpileDeclaration (6-20x compression)
async function compressWarm(files: ScoredFile[]): Promise<string[]> {
  return Promise.all(
    files.map((f) => {
      const source = fs.readFileSync(f.path, "utf-8");
      const result = ts.transpileDeclaration(source, {
        compilerOptions: {
          isolatedDeclarations: true,
          target: ts.ScriptTarget.ESNext,
        },
        fileName: path.basename(f.path),
      });
      return result.outputText;
    }),
  );
}

// COLD: 1-line summary per file
function compressCold(files: ScoredFile[], manifest: BuildManifest): string {
  return files
    .map((f) => {
      const exports = manifest.exports[f.path] || [];
      return `${f.path}: ${exports.join(", ") || "(no exports)"}`;
    })
    .join("\n");
}
```

### Step 4: Assemble 6-Layer Prompt (`src/context/assembly.ts`)

```typescript
function assemble(
  tiers: CompressedTiers,
  task: BuildTask,
  spec: string,
): string {
  const layers = [
    // Layer 1: Static prefix (HIGH attention — beginning of prompt)
    loadTemplate("static-prefix.md"),

    // Layer 2: Project contract (HIGH attention)
    `## PROJECT CONTRACT\n\n${readFile("contracts.ts")}\n\n## ARCHITECTURE DECISIONS\n${archSummary}`,

    // Layer 3: Task brief (MEDIUM attention)
    formatTaskBrief(task) + formatLookahead(task, plan),

    // Layer 4: Repo context — Cold + Warm (LOW attention — middle of prompt)
    `## ALL PROJECT FILES\n${tiers.cold}\n\n## DEPENDENCY INTERFACES\n${tiers.warm.join("\n\n")}`,

    // Layer 5: Evidence pack — Hot (MEDIUM attention — toward end)
    `## FILES TO MODIFY\n${tiers.hot.map((f) => `### ${f.path}\n\`\`\`typescript\n${f.content}\n\`\`\``).join("\n\n")}`,

    // Layer 6: Endcap (HIGH attention — end of prompt)
    loadTemplate("endcap.md"),
  ];

  return fitToBudget(layers, tokenBudget);
}
```

### Step 5: Token Budget Fitting (`src/context/budget.ts`)

```typescript
function fitToBudget(layers: string[], budget: number): string {
  let total = layers.reduce((sum, l) => sum + estimateTokens(l), 0);

  if (total <= budget) return layers.join("\n\n---\n\n");

  // Priority truncation: Layer 4 (repo context) shrinks first
  // Binary search on K (number of warm files) until fits
  let lo = 0,
    hi = warmFiles.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const candidate = rebuildLayer4(mid);
    if (estimateTokens(candidate) + otherLayersSize <= budget) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  return rebuildWithK(lo);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4); // chars/4 estimation for v1
}
```

### Step 6: Content-Address and Store

```typescript
const contextPack: ContextPack = {
  assembled: finalPrompt,
  hash: sha256(finalPrompt),
  tokenCount: estimateTokens(finalPrompt),
  budget: tokenBudget,
  items: scoredItems.map((item) => ({
    kind: item.tier,
    path: item.path,
    contentHash: sha256(item.content),
    tokenCount: estimateTokens(item.content),
    score: item.score,
    reason: item.scoreBreakdown,
  })),
};

// Store blob
await blobs.write(contextPack.hash, contextPack.assembled);

// Store metadata
db.insertContextRun({
  id: uuid(),
  taskId: task.id,
  agent: task.agent,
  headCommit: git.head(),
  promptHash: contextPack.hash,
  contextHash: contextPack.hash,
  tokenCount: contextPack.tokenCount,
  tokenBudget: tokenBudget,
  blobPath: blobs.pathFor(contextPack.hash),
});
```

---

## 6. STRUCTURED RUBRIC REVIEW (End-to-End)

### Step 1: Reviewer Context Compilation

The reviewer receives a DIFFERENT context pack than the builder. It contains:

```typescript
function compileReviewContext(
  task: BuildTask,
  buildResult: BuildResult,
): ContextPack {
  return assemble([
    // What the code SHOULD do
    loadSpecSection(task.implements),
    task.acceptance.join("\n"),
    readFile("contracts.ts"),

    // What the code ACTUALLY does
    buildResult.changedFiles.map((f) => readFile(f.path)).join("\n\n"),

    // Domain rubric (generated from patterns)
    generateRubric(task, patterns),

    // NEVER included: builder's prompt, builder's reasoning, prior findings
  ]);
}
```

### Step 2: Rubric Generation (`src/patterns/filter.ts`)

```typescript
function generateRubric(
  task: BuildTask,
  allPatterns: DomainPattern[],
): RubricItem[] {
  // Filter patterns relevant to this task type
  const relevant = allPatterns.filter((p) =>
    task.enrichment_sources.some(
      (src) => p.category === src.replace(".yaml", ""),
    ),
  );

  // Generate rubric items
  return relevant
    .flatMap((pattern) =>
      pattern.requirements.map((req) => ({
        id: `${pattern.category}-${req.id}`,
        description: req.text,
        status: "PENDING" as const, // Reviewer fills this in
        evidence: "",
      })),
    )
    .concat(
      // Always include acceptance criteria as rubric items
      task.acceptance.map((criterion, i) => ({
        id: `acceptance-${i}`,
        description: criterion,
        status: "PENDING" as const,
        evidence: "",
      })),
    );
}
```

### Step 3: Review Dispatch

```typescript
// src/temporal/activities/review.ts
export async function executeReview(
  reviewContext: ContextPack,
  rubric: RubricItem[],
): Promise<RubricReviewOutput> {
  const adapter = registry.get("claude"); // Cross-family from builder (Codex)

  const result = await adapter.dispatch(reviewContext, worktreePath);

  // Parse structured output (Zod validated)
  const parsed = RubricReviewOutputSchema.parse(
    extractFencedJson(result.stdout),
  );

  // Finding-Inflation Clamp
  if (parsed.additionalFindings.length > 15) {
    parsed.additionalFindings.forEach((f) => {
      f.confidence = Math.max(0, (f.confidence || 1) - 0.25);
    });
  }

  return parsed;
}
```

### Step 4: Review Output Schema (Zod)

```typescript
// src/shared/types.ts
const RubricReviewOutputSchema = z.object({
  verdict: z.enum(["PASS", "FAIL", "PASS_WITH_COMMENTS"]),
  rubricResults: z.array(
    z.object({
      id: z.string(),
      status: z.enum(["MET", "NOT_MET", "UNVERIFIABLE"]),
      evidence: z.string().min(1),
    }),
  ),
  additionalFindings: z.array(
    z.object({
      severity: z.enum(["P0", "P1", "P2"]),
      path: z.string(),
      line: z.number().optional(),
      finding: z.string(),
      category: z.string(),
      confidence: z.number().min(0).max(1).optional(),
    }),
  ),
  categoriesChecked: z.array(z.string()),
});
```

### Step 5: Fix Loop (Blind Retry Protocol)

```typescript
// Inside reviewCycleWorkflow
for (let iteration = 1; iteration <= MAX_FIX_ITERATIONS; iteration++) {
  const reviewResult = await activities.executeReview(reviewContext, rubric);

  if (
    reviewResult.verdict === "PASS" ||
    reviewResult.verdict === "PASS_WITH_COMMENTS"
  ) {
    return reviewResult; // Done
  }

  // FAIL path
  const p0s = reviewResult.additionalFindings.filter(
    (f) => f.severity === "P0",
  );

  // 1. Mechanical Fix Verifier (deterministic)
  if (iteration > 1) {
    const mechanicalCheck = verifyPriorP0sFixed(priorP0s, currentDiff);
    if (!mechanicalCheck.allFixed) {
      // Same P0 not addressed — escalate
      throw new ApplicationFailure("P0 recurrence detected", "P0_RECURRENCE");
    }
  }

  // 2. Dispatch builder with fix context
  const fixContext = compileFixContext(task, p0s, reviewResult.rubricResults);
  const fixResult = await activities.executeFix(fixContext, worktreePath);

  // 3. Re-run build gate
  const gateResult = evaluateBuildGate(fixResult, task);
  if (!gateResult.passed) {
    continue; // Build gate failed — loop again
  }

  // 4. BLIND review — completely fresh, NO prior findings
  reviewContext = compileReviewContext(task, fixResult); // Fresh context
  priorP0s = p0s;
  // Loop continues with fresh review
}

// Exhausted fix iterations
throw new ApplicationFailure("Fix loop exhausted", "FIX_LOOP_EXHAUSTED");
```

---

## 7. STABILITY MONITOR

### Architecture

The stability monitor runs as a side-effect check AFTER each activity completion within `buildTaskWorkflow` and `reviewCycleWorkflow`.

```typescript
// src/stability/monitor.ts
export function checkStability(
  taskId: string,
  history: TaskHistory,
): StabilityResult {
  const signals: TriggeredSignal[] = [];

  // Check each signal against thresholds
  if (sameTestFailsTwice(history)) signals.push("SAME_TEST_FAILS");
  if (sameP0CategoryRepeats(history)) signals.push("SAME_P0_REPEATS");
  if (malformedOutputRepeats(history)) signals.push("MALFORMED_REPEATS");
  if (forbiddenFileModified(history)) signals.push("FORBIDDEN_FILE");
  if (contextGrowsAcceptanceStalls(history)) signals.push("CONTEXT_STALL");
  if (testCountDecreases(history)) signals.push("TEST_DECREASE");
  if (slopRecursAfterFix(history)) signals.push("SLOP_RECURRENCE");
  if (reviewFindingsOverLimit(history)) signals.push("FINDING_INFLATION");

  // Escalation trigger: ANY 2+ signals
  const shouldEscalate =
    signals.length >= 2 || signals.includes("FORBIDDEN_FILE"); // 1 occurrence sufficient

  return { signals, shouldEscalate, response: pickResponse(signals) };
}
```

### Response Selection

```typescript
// src/stability/responses.ts
export function pickResponse(signals: TriggeredSignal[]): EscalationResponse {
  // Ordered by severity — pick first applicable
  if (signals.includes("FORBIDDEN_FILE")) {
    return {
      action: "STOP",
      reason: "Ownership violation — agent modifying forbidden files",
    };
  }
  if (
    signals.includes("SAME_P0_REPEATS") &&
    signals.includes("CONTEXT_STALL")
  ) {
    return {
      action: "ESCALATE_ARCHITECTURE",
      reason: "Repeated P0 + stalling suggests architectural issue",
    };
  }
  if (signals.includes("MALFORMED_REPEATS")) {
    return {
      action: "SWITCH_MODEL",
      reason: "Model consistently producing unparseable output",
    };
  }
  if (signals.includes("CONTEXT_STALL")) {
    return {
      action: "RECOMPILE_CONTEXT",
      reason: "Context growing without progress — replace lowest-scored items",
    };
  }
  if (signals.includes("SAME_TEST_FAILS")) {
    return {
      action: "SPLIT_TASK",
      reason: "Same test failing — task may be too large",
    };
  }
  return {
    action: "ASK_HUMAN",
    reason: `Multiple stability signals: ${signals.join(", ")}`,
  };
}
```

### Integration in Workflow

```typescript
// Inside buildTaskWorkflow, after each attempt:
const stability = checkStability(task.id, getTaskHistory(task.id));

if (stability.shouldEscalate) {
  // Record the escalation
  await activities.storeEvidence({
    type: "stability_escalation",
    taskId: task.id,
    signals: stability.signals,
    response: stability.response,
  });

  switch (stability.response.action) {
    case "STOP":
      throw new ApplicationFailure(stability.response.reason, "STABILITY_STOP");
    case "SWITCH_MODEL":
      task.agent = nextModelFamily(task.agent);
      break;
    case "SPLIT_TASK":
      // Parent workflow handles sub-task creation
      throw new ApplicationFailure(
        stability.response.reason,
        "STABILITY_SPLIT",
      );
    case "RECOMPILE_CONTEXT":
      contextPack = recompileWithMissing(contextPack, stability.signals);
      break;
    case "ESCALATE_ARCHITECTURE":
    case "ASK_HUMAN":
      // Signal parent to pause for human
      throw new ApplicationFailure(
        stability.response.reason,
        "STABILITY_HUMAN",
      );
  }
}
```

---

## 8. TOURNAMENT MODE

### When Tournament Activates

Tournament mode is triggered for "high-value" packets (configured per-plan or by policy):

```typescript
// In pipelineWorkflow, during BUILD phase:
if (task.tournament) {
  const result = await startChild(tournamentWorkflow, {
    args: [task, spec, contextPack],
  });
  buildResults.push(result);
} else {
  const result = await startChild(buildTaskWorkflow, { args: [task] });
  buildResults.push(result);
}
```

### Tournament Workflow

```typescript
// src/temporal/workflows/tournament.ts
export async function tournamentWorkflow(
  task: BuildTask,
  spec: string,
  contextPack: ContextPack,
): Promise<BuildResult> {
  const agents: AgentName[] = task.tournament?.agents || [
    "claude",
    "codex",
    "gemini",
  ];

  // 1. Create isolated worktrees (one per agent)
  const worktrees = await Promise.all(
    agents.map((agent) =>
      activities.createWorktree(
        `wt-${workflowInfo().workflowId}-${agent}-${Date.now()}`,
      ),
    ),
  );

  // 2. Fan-out: dispatch all agents in parallel
  const results = await Promise.all(
    agents.map((agent, i) =>
      activities
        .executeBuildPacket({ ...task, agent }, contextPack, worktrees[i])
        .catch((err) => ({ agent, error: err, failed: true })),
    ),
  );

  // 3. Filter successful results
  const successful = results.filter((r) => !r.failed);

  if (successful.length === 0) {
    throw new ApplicationFailure(
      "All tournament agents failed",
      "TOURNAMENT_ALL_FAILED",
    );
  }

  if (successful.length === 1) {
    return successful[0]; // Only one survived
  }

  // 4. Arbiter evaluation
  const winner = await activities.evaluateTournament(successful, task);

  // 5. Cleanup losing worktrees
  await Promise.all(
    worktrees
      .filter((_, i) => agents[i] !== winner.agent)
      .map((wt) => activities.destroyWorktree(wt)),
  );

  // 6. Store tournament result
  await activities.storeEvidence({
    type: "tournament_result",
    taskId: task.id,
    winner: winner.agent,
    agents: results.map((r) => ({ agent: r.agent, passed: !r.failed })),
    criteria: winner.criteria,
  });

  return winner;
}
```

### Arbiter Evaluation (`src/tournament/arbiter.ts`)

```typescript
export function evaluateTournament(
  results: BuildResult[],
  task: BuildTask,
): TournamentWinner {
  const scored = results.map((result) => {
    let score = 0;

    // Tests passing (highest weight)
    score += result.testsPassed ? 40 : 0;

    // Lint clean
    score += result.lintClean ? 15 : 0;

    // Diff size (smaller is better — less unnecessary change)
    score += Math.max(0, 20 - result.diffLines / 10);

    // Acceptance coverage
    const coverageRatio = result.acceptanceMet / task.acceptance.length;
    score += coverageRatio * 25;

    return { ...result, score };
  });

  // Winner = highest score
  const winner = scored.sort((a, b) => b.score - a.score)[0];

  return {
    agent: winner.agent,
    score: winner.score,
    criteria: {
      testsPassed: winner.testsPassed,
      lintClean: winner.lintClean,
      diffLines: winner.diffLines,
      acceptanceCoverage: winner.acceptanceMet / task.acceptance.length,
    },
  };
}
```

---

## 9. TEMPORAL ACTIVITIES: execa WRAPPER

### Core Dispatch Activity (`src/temporal/activities/dispatch.ts`)

```typescript
import { execaCommand, type ExecaError } from "execa";
import {
  heartbeat,
  cancellationSignal,
  activityInfo,
} from "@temporalio/activity";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { sha256 } from "../shared/crypto.js";
import { blobs } from "../evidence/blobs.js";
import { db } from "../evidence/db.js";

export async function dispatchAgent(
  adapter: AgentAdapter,
  contextPack: ContextPack,
  worktreePath: string,
): Promise<AgentResult> {
  const { attempt } = activityInfo();
  const signal = cancellationSignal();

  // 1. Write context to temp file (never pass secrets via CLI args)
  const contextFile = join(worktreePath, `.zer0-context-${Date.now()}.md`);
  writeFileSync(contextFile, contextPack.assembled, "utf-8");

  // 2. Build command (adapter-specific)
  const command = adapter.buildCommand(contextFile, worktreePath);

  // 3. Execute with timeout + cancellation
  let result: ExecaResult;
  try {
    const heartbeatInterval = setInterval(() => {
      heartbeat({ attempt, worktree: worktreePath });
    }, 30_000);

    result = await execaCommand(command, {
      cwd: worktreePath,
      cancelSignal: signal,
      timeout: 300_000, // 5 min hard timeout
      shell: false,
      env: {
        ...process.env,
        // Strip dangerous env vars
        OPENAI_API_KEY: undefined,
        ANTHROPIC_API_KEY: undefined,
      },
    });

    clearInterval(heartbeatInterval);
  } catch (error) {
    const execaError = error as ExecaError;

    // Store failed attempt evidence
    await storeDispatchEvidence(contextPack, execaError, attempt);

    if (execaError.isCanceled) {
      throw new Error("Activity cancelled by Temporal");
    }
    if (execaError.timedOut) {
      throw new Error(`Agent timed out after 5 minutes (attempt ${attempt})`);
    }

    // Retriable error (will be retried by Temporal per RetryPolicy)
    throw new Error(
      `Agent exited with code ${execaError.exitCode}: ${execaError.stderr?.slice(0, 500)}`,
    );
  } finally {
    // 4. Cleanup temp file
    try {
      unlinkSync(contextFile);
    } catch {}
  }

  // 5. Parse output
  const parsed = adapter.parseOutput(result.stdout);

  // 6. Store evidence
  const stdoutHash = sha256(result.stdout);
  const stderrHash = sha256(result.stderr || "");
  await blobs.write(stdoutHash, result.stdout);
  if (result.stderr) await blobs.write(stderrHash, result.stderr);

  db.insertDispatch({
    id: crypto.randomUUID(),
    taskId: activityInfo().activityId,
    agent: adapter.name,
    contextRunId: contextPack.hash,
    commandHash: sha256(command),
    exitCode: result.exitCode,
    stdoutBlob: stdoutHash,
    stderrBlob: stderrHash,
    diffBlob: null, // Set after diff extraction
    durationMs: Date.now() - startTime,
    retries: attempt - 1,
    tokensIn: contextPack.tokenCount,
    tokensOut: estimateTokens(result.stdout),
    enrichmentFlags: contextPack.enrichmentFlags || [],
  });

  return parsed;
}
```

### Agent Adapters (`src/adapters/claude.ts` example)

````typescript
import type { AgentAdapter, AgentResult, ContextPack } from "./types.js";

export const claudeAdapter: AgentAdapter = {
  name: "claude",

  buildCommand(contextFile: string, worktreePath: string): string {
    // Claude Code CLI: read from stdin, print to stdout, JSON output
    return `claude -p --output-format json --max-turns 1 < "${contextFile}"`;
  },

  parseOutput(raw: string): AgentResult {
    // Extract fenced JSON from Claude's output
    const jsonMatch = raw.match(/```json\n([\s\S]*?)\n```/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[1]);
    }
    // Try raw JSON parse
    return JSON.parse(raw);
  },

  async healthCheck(): Promise<AgentHealth> {
    try {
      const { stdout } = await execaCommand("claude --version", {
        timeout: 10_000,
      });
      return { healthy: true, version: stdout.trim() };
    } catch {
      return {
        healthy: false,
        error: "Claude CLI not found or not responding",
      };
    }
  },
};
````

### Codex Adapter (`src/adapters/codex.ts`)

```typescript
export const codexAdapter: AgentAdapter = {
  name: "codex",

  buildCommand(contextFile: string, worktreePath: string): string {
    // Codex: exec mode with workspace-write sandbox
    return `codex exec --sandbox workspace-write --cwd "${worktreePath}" < "${contextFile}"`;
  },

  parseOutput(raw: string): AgentResult {
    // Codex outputs structured JSON when given proper prompts
    return extractFencedJson(raw);
  },

  async healthCheck(): Promise<AgentHealth> {
    try {
      const { stdout } = await execaCommand("codex --version", {
        timeout: 10_000,
      });
      return { healthy: true, version: stdout.trim() };
    } catch {
      return { healthy: false, error: "Codex CLI not found" };
    }
  },
};
```

### Gemini Adapter (`src/adapters/gemini.ts`)

```typescript
export const geminiAdapter: AgentAdapter = {
  name: "gemini",

  buildCommand(contextFile: string, worktreePath: string): string {
    // Gemini CLI: -y for headless, stdin via pipe
    return `gemini -y < "${contextFile}"`;
  },

  parseOutput(raw: string): AgentResult {
    return extractFencedJson(raw);
  },

  async healthCheck(): Promise<AgentHealth> {
    try {
      const { stdout } = await execaCommand("gemini --version", {
        timeout: 10_000,
      });
      return { healthy: true, version: stdout.trim() };
    } catch {
      return { healthy: false, error: "Gemini CLI not found" };
    }
  },
};
```

---

## 10. TEMPORAL WORKER SETUP

### Worker Registration (`src/temporal/worker.ts`)

```typescript
import { Worker, NativeConnection } from "@temporalio/worker";
import * as activities from "./activities/index.js";

export async function startWorker(): Promise<Worker> {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS || "localhost:7233",
  });

  const worker = await Worker.create({
    connection,
    namespace: "default",
    taskQueue: "zer0-pipeline",
    workflowsPath: new URL("./workflows/index.js", import.meta.url).pathname,
    activities,
    // Activity-level defaults (overridable per-activity in workflow)
    defaultActivityOptions: {
      startToCloseTimeout: "5 minutes",
      heartbeatTimeout: "2 minutes",
      retry: {
        maximumAttempts: 3,
        backoffCoefficient: 2,
        initialInterval: "1s",
        maximumInterval: "30s",
        nonRetryableErrorTypes: [
          "STABILITY_STOP",
          "BUILD_GATE_EXHAUSTED",
          "FIX_LOOP_EXHAUSTED",
          "TOURNAMENT_ALL_FAILED",
        ],
      },
    },
  });

  return worker;
}
```

### Temporal Server Management (`src/temporal/server.ts`)

```typescript
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

let serverHandle: TestWorkflowEnvironment | null = null;

export async function ensureTemporalServer(zer0Root: string): Promise<string> {
  // Check if external Temporal server is running
  try {
    const { Client, Connection } = await import("@temporalio/client");
    const conn = await Connection.connect({ address: "localhost:7233" });
    await conn.close();
    return "localhost:7233"; // External server available
  } catch {
    // No external server — start embedded dev server
  }

  const dbPath = join(zer0Root, "temporal.db");
  mkdirSync(zer0Root, { recursive: true });

  serverHandle = await TestWorkflowEnvironment.createLocal({
    server: {
      type: "dev-server",
      dbFilename: dbPath,
      ui: true,
      uiPort: 8233,
    },
  });

  return serverHandle.client.connection.options.address;
}

export async function stopTemporalServer(): Promise<void> {
  if (serverHandle) {
    await serverHandle.teardown();
    serverHandle = null;
  }
}
```

---

## 11. EVIDENCE SYSTEM

### SQLite Initialization (`src/evidence/schema.sql`)

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  vision TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'init',
  branch TEXT,
  base_commit TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS requirements (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  text TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  task_id TEXT,
  evidence_file TEXT,
  evidence_line INTEGER,
  evidence_test TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  objective TEXT NOT NULL,
  agent TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  owned_files TEXT NOT NULL, -- JSON array
  forbidden_files TEXT NOT NULL, -- JSON array
  acceptance TEXT NOT NULL, -- JSON array
  result TEXT, -- JSON blob
  head_commit TEXT
);

CREATE TABLE IF NOT EXISTS context_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  agent TEXT NOT NULL,
  head_commit TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  token_budget INTEGER NOT NULL,
  blob_path TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS context_items (
  id TEXT PRIMARY KEY,
  context_run_id TEXT NOT NULL REFERENCES context_runs(id),
  kind TEXT NOT NULL, -- 'hot' | 'warm' | 'cold'
  path TEXT NOT NULL,
  symbol TEXT,
  content_hash TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  score REAL NOT NULL,
  reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id),
  severity TEXT NOT NULL, -- 'P0' | 'P1' | 'P2'
  path TEXT,
  line INTEGER,
  finding TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  source_agent TEXT NOT NULL,
  reviewer_context_hash TEXT
);

CREATE TABLE IF NOT EXISTS gate_transitions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  gate_name TEXT NOT NULL,
  passed INTEGER NOT NULL, -- boolean
  evidence_json TEXT NOT NULL,
  human_override INTEGER DEFAULT 0,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dispatches (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  context_run_id TEXT,
  command_hash TEXT NOT NULL,
  exit_code INTEGER NOT NULL,
  stdout_blob TEXT NOT NULL,
  stderr_blob TEXT,
  diff_blob TEXT,
  duration_ms INTEGER NOT NULL,
  retries INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER,
  tokens_out INTEGER,
  enrichment_flags TEXT, -- JSON array
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tournament_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  task_id TEXT NOT NULL,
  feature_type TEXT,
  winner_agent TEXT NOT NULL,
  agents_json TEXT NOT NULL,
  criteria_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_failure_patterns (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  failure_category TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  last_seen TEXT NOT NULL,
  example_finding_id TEXT
);

-- FTS5 for full-text search on findings
CREATE VIRTUAL TABLE IF NOT EXISTS findings_fts USING fts5(
  finding, content=findings, content_rowid=rowid
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_findings_severity ON findings(severity);
CREATE INDEX IF NOT EXISTS idx_findings_task ON findings(task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_run ON tasks(run_id);
CREATE INDEX IF NOT EXISTS idx_dispatches_task ON dispatches(task_id);
CREATE INDEX IF NOT EXISTS idx_context_items_run ON context_items(context_run_id);
```

### Blob Store (`src/evidence/blobs.ts`)

```typescript
import { createHash } from "crypto";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const BLOB_ROOT = join(process.cwd(), ".zer0", "blobs");

export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

export function write(hash: string, content: string): string {
  const prefix = hash.slice(0, 2);
  const dir = join(BLOB_ROOT, prefix);
  const filePath = join(dir, hash);

  if (existsSync(filePath)) return filePath; // Dedup

  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

export function read(hash: string): string {
  const prefix = hash.slice(0, 2);
  return readFileSync(join(BLOB_ROOT, prefix, hash), "utf-8");
}

export function pathFor(hash: string): string {
  return join(BLOB_ROOT, hash.slice(0, 2), hash);
}

export function exists(hash: string): boolean {
  return existsSync(pathFor(hash));
}
```

---

## 12. SECURITY FILTER

### Pre-Dispatch Filter (`src/security/filter.ts`)

```typescript
import { checkDenylist } from "./denylist.js";
import { scanEntropy } from "./entropy.js";

export function securityFilter(contextPack: ContextPack): SecurityResult {
  const violations: SecurityViolation[] = [];

  // 1. Denylist check — no secret files in context
  for (const item of contextPack.items) {
    const denied = checkDenylist(item.path);
    if (denied) {
      violations.push({
        type: "DENYLIST",
        path: item.path,
        reason: denied.reason,
      });
    }
  }

  // 2. Entropy scan — no high-entropy strings (API keys, tokens)
  const entropyHits = scanEntropy(contextPack.assembled);
  for (const hit of entropyHits) {
    violations.push({
      type: "ENTROPY",
      path: "assembled_prompt",
      reason: `High-entropy string detected at offset ${hit.offset}: likely a secret`,
      value: hit.masked, // First 4 chars + "..."
    });
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}
```

### Denylist (`src/security/denylist.ts`)

```typescript
const DENY_PATTERNS = [
  { pattern: /\.env(\..+)?$/, reason: "Environment file may contain secrets" },
  { pattern: /secrets\//, reason: "Secrets directory" },
  { pattern: /credentials\//, reason: "Credentials directory" },
  { pattern: /\.(pem|key|p12|pfx)$/, reason: "Certificate/key file" },
  { pattern: /id_rsa/, reason: "SSH private key" },
  { pattern: /\.npmrc$/, reason: "May contain auth tokens" },
  { pattern: /\.pypirc$/, reason: "May contain auth tokens" },
];

export function checkDenylist(filePath: string): DenylistHit | null {
  for (const { pattern, reason } of DENY_PATTERNS) {
    if (pattern.test(filePath)) {
      return { pattern: pattern.source, reason };
    }
  }
  return null;
}
```

### Entropy Scanner (`src/security/entropy.ts`)

```typescript
export function scanEntropy(text: string, threshold = 4.5): EntropyHit[] {
  const hits: EntropyHit[] = [];

  // Find strings that look like secrets (long alphanumeric sequences)
  const secretPattern = /[A-Za-z0-9+/=_-]{32,}/g;
  let match: RegExpExecArray | null;

  while ((match = secretPattern.exec(text)) !== null) {
    const entropy = shannonEntropy(match[0]);
    if (entropy > threshold) {
      hits.push({
        offset: match.index,
        length: match[0].length,
        entropy,
        masked: match[0].slice(0, 4) + "...",
      });
    }
  }

  return hits;
}

function shannonEntropy(str: string): number {
  const freq: Record<string, number> = {};
  for (const char of str) freq[char] = (freq[char] || 0) + 1;
  const len = str.length;
  return -Object.values(freq).reduce((sum, count) => {
    const p = count / len;
    return sum + p * Math.log2(p);
  }, 0);
}
```

---

## 13. BUILD ORDER (Day-by-Day)

### Phase 0: Spike Validation (Day 1-2)

Already complete (spike/ directory). Validated:

- [x] Temporal SDK imports
- [x] execa + all CLIs (Claude, Codex, Gemini)
- [x] better-sqlite3 (WAL mode, queries)
- [x] ts.transpileDeclaration (6x compression)

Remaining spike work:

- [ ] Temporal dev server start (programmatic via TestWorkflowEnvironment)
- [ ] Temporal workflow + activity execution (hello-world round trip)
- [ ] Promptfoo basic eval run

### Phase 1: Spine (Days 3-9)

**Day 3-4: Project scaffold + Temporal connection**

```
1. tsconfig.json, biome.json, vitest.config.ts, package.json updates
2. src/shared/ (types, config, logger, crypto, errors)
3. src/temporal/server.ts (ensure/stop dev server)
4. src/temporal/client.ts (connect, start, signal, query)
5. src/temporal/worker.ts (register, run)
6. src/temporal/signals.ts (all signal/query/update definitions)
7. Minimal pipeline workflow (start → log "hello" → complete)
8. Test: start workflow, query status, signal approve
```

**Day 5-6: SQLite + Blobs + CLI adapters**

```
1. src/evidence/schema.sql + db.ts + queries.ts + blobs.ts
2. src/adapters/types.ts + claude.ts + codex.ts + gemini.ts + registry.ts
3. src/security/denylist.ts + entropy.ts + filter.ts
4. Test: insert run, insert dispatch, store blob, read blob
5. Test: each adapter healthCheck passes
6. Test: security filter blocks .env content
```

**Day 7-8: Gate engine + CLI**

```
1. src/gates/engine.ts (generic gate evaluation)
2. src/gates/build-gate.ts (mechanical clamps: tsc, biome, vitest)
3. src/cli/router.ts + commands/start.ts + commands/status.ts + commands/doctor.ts
4. src/cli/output.ts (terminal formatting)
5. Test: zer0 doctor reports all CLIs healthy
6. Test: zer0 start creates .zer0/ scaffold and starts workflow
7. Test: zer0 status queries workflow and prints phase
```

**Day 9: Integration smoke test**

```
1. Wire: start → INIT activity → gate → complete
2. Test: full round trip (CLI → Temporal → activity → evidence → CLI query)
3. Test: crash recovery (stop worker during run, restart worker, workflow completes)
```

### Phase 2: Context Compiler (Days 10-16)

**Day 10-11: Indexer + Compression**

```
1. src/context/indexer.ts (dual-signal scoring)
2. src/context/compress.ts (transpileDeclaration + other compressions)
3. Test: score a mock project's files for a mock task
4. Test: compression ratio matches spike results (6-20x)
```

**Day 12-13: Tier assembly**

```
1. src/context/cold-tier.ts (all-files summary)
2. src/context/warm-tier.ts (top-K selection)
3. src/context/hot-tier.ts (full source)
4. src/context/assembly.ts (6-layer construction)
5. src/context/budget.ts (binary search fitting)
6. Test: assemble context for mock task, verify layers correct
7. Test: budget truncation preserves layer priority
```

**Day 14-15: Templates + Prefetching + Hostile Isolation**

```
1. src/context/templates/ (static-prefix.md, endcap.md, build-brief.md, review-rubric.md)
2. src/context/prefetch.ts (background compilation)
3. src/context/compiler.ts (main orchestrator: calls indexer → compress → assemble → store)
4. Test: reviewer context NEVER contains builder prompt
5. Test: prefetch invalidates on prior task failure
```

**Day 16: Integration**

```
1. Wire context compiler into dispatch activity
2. Test: full BUILD activity with real context compilation
3. Test: context is content-addressed (same input → same hash)
```

### Phase 3: Intent + Product Pipeline (Days 17-23)

**Day 17-18: Intent Compiler**

```
1. src/intent/schema.ts (IntentBrief Zod schema)
2. src/intent/compiler.ts (vibe → IntentBrief)
3. src/intent/vocabulary.ts (domain term extraction)
4. src/intent/qa-planner.ts (question generation)
5. prompts/intent-compiler.md
6. Test: mock vibe → valid IntentBrief output
```

**Day 19-20: Research + Spec + Architecture activities**

```
1. src/temporal/activities/research.ts
2. src/temporal/activities/spec.ts
3. src/temporal/activities/architecture.ts
4. prompts/research-*.md, spec-generator.md, architecture-generator.md
5. Test: each activity dispatches correct CLI with correct context
```

**Day 21-22: Plan activity + Domain Patterns**

```
1. src/temporal/activities/plan.ts
2. src/patterns/loader.ts + filter.ts + yaml/
3. prompts/plan-generator.md
4. src/gates/plan-gate.ts (ownership, coverage, contracts compile)
5. Test: plan gate blocks on ownership overlap
6. Test: contracts.ts compiles
```

**Day 23: Full pipeline flow (INIT → PLAN)**

```
1. Wire all phases together in pipeline workflow
2. Test: full flow from zer0 start through PLAN completion
3. Test: mode semi/full pauses at correct gates
```

### Phase 4: Build/Review/Fix + Stability (Days 24-30)

**Day 24-25: Build task workflow**

```
1. src/temporal/workflows/build-task.ts
2. src/temporal/activities/build.ts
3. src/temporal/activities/worktree.ts
4. Ownership check implementation
5. Slop detection
6. Test: build gate blocks on `as any`
7. Test: worktree isolation (changes don't affect main)
```

**Day 26-27: Review + Fix loop**

```
1. src/temporal/workflows/review-cycle.ts
2. src/temporal/activities/review.ts + fix.ts
3. prompts/reviewer.md
4. src/gates/review-gate.ts + fix-gate.ts
5. Blind retry protocol (fresh context each iteration)
6. Mechanical fix verifier (grep/diff for prior P0s)
7. Test: P0 blocks unconditionally
8. Test: blind review gets NO prior findings
```

**Day 28-29: Stability Monitor**

```
1. src/stability/monitor.ts + signals.ts + responses.ts
2. Integration into buildTaskWorkflow and reviewCycleWorkflow
3. Test: 2 same-test failures → escalation fires
4. Test: forbidden file modification → immediate stop
```

**Day 30: Final Audit + Ship**

```
1. src/temporal/activities/audit.ts
2. src/gates/audit-gate.ts
3. Ship phase (zer0 resume <run-id> <phase> at SHIP)
4. Test: requirement without file:line blocks AuditGate
5. Test: full pipeline happy path (all 10 phases)
```

### Phase 5: Tournament (Days 31-34)

```
1. src/temporal/workflows/tournament.ts
2. src/tournament/orchestrator.ts + arbiter.ts + worktree-pool.ts
3. Test: 3 agents compete, best wins by score
4. Test: failed agents don't block tournament
5. Test: worktree cleanup after tournament
```

### Phase 6: Hardening + Evals (Days 35-39)

```
1. src/eval/runner.ts + graders.ts + configs/
2. Promptfoo eval configs for intent/context/review
3. Enrichment removal protocol (track flags, measure after 20 dispatches)
4. agent_failure_patterns table population
5. Cost circuit breaker (zer0 cost + budget limits)
6. Test: enrichment flag tracking works
7. Test: cost exceeding budget halts pipeline
```

---

## 14. CONFIGURATION

### `.zer0/config.yaml` (per-project)

```yaml
mode: semi # auto | semi | full

agents:
  builder: codex # Default builder agent
  reviewer: claude # Default reviewer (must be cross-family)
  research:
    - gemini
    - codex
    - claude

timeouts:
  research: 300000 # 5 min
  spec: 300000 # 5 min
  build: 180000 # 3 min
  review: 180000 # 3 min

retries:
  malformed_output: 3
  build_gate_fail: 2
  fix_loop: 3

thresholds:
  max_p1_findings: 5
  finding_inflation: 15
  stability_signals_escalate: 2

gates:
  plan:
    require_contracts_compile: true
    require_coverage_100: true
  build:
    max_function_length: 50
    max_file_length: 500
    max_parameters: 5
    zero_as_any: true
    zero_console_log: true
    max_cyclomatic_complexity: 15
  review:
    zero_p0: true
    max_p1: 5

token_budgets:
  build: 100000 # ~100K tokens per build context
  review: 80000 # ~80K tokens per review context
  research: 50000 # ~50K tokens per research context

tournament:
  enabled: false # Enable per-task in plan
  agents: ["claude", "codex", "gemini"]

temporal:
  address: localhost:7233
  namespace: default
  task_queue: zer0-pipeline
```

---

## 15. KEY TYPE DEFINITIONS (`src/shared/types.ts`)

```typescript
// Identifiers
export type RunId = `run-${string}`;
export type TaskId = `BUILD-${string}`;
export type AgentName = "claude" | "codex" | "gemini";

// Pipeline state
export type PipelinePhase =
  | "init"
  | "recon"
  | "intent"
  | "qa"
  | "research"
  | "spec"
  | "architecture"
  | "plan"
  | "build"
  | "review"
  | "audit"
  | "ship"
  | "completed"
  | "failed"
  | "blocked";

export type ControlMode = "auto" | "semi" | "full";

export interface PipelineStatus {
  runId: RunId;
  phase: PipelinePhase;
  mode: ControlMode;
  progress: {
    tasksCompleted: number;
    tasksTotal: number;
    currentTask: TaskId | null;
  };
  blockedAt: string | null;
  startedAt: string;
  elapsedMs: number;
}

// Context
export interface ContextPack {
  assembled: string;
  hash: string;
  tokenCount: number;
  budget: number;
  items: ContextItem[];
  enrichmentFlags: string[];
}

export interface ContextItem {
  kind: "hot" | "warm" | "cold";
  path: string;
  symbol?: string;
  contentHash: string;
  tokenCount: number;
  score: number;
  reason: string;
}

// Build
export interface BuildTask {
  id: TaskId;
  implements: string;
  creates: string[];
  modifies: string[];
  reads: string[];
  contracts: string[];
  owned_files: string[];
  forbidden_files: string[];
  acceptance: string[];
  depends_on: TaskId[];
  enrichment_sources: string[];
  requirement_links: string[];
  sandbox_level: 0 | 1 | 2 | 3;
  agent: AgentName;
  tournament?: { agents: AgentName[] };
}

export interface BuildResult {
  agent: AgentName;
  files: { path: string; action: "created" | "modified" }[];
  testsPassed: boolean;
  lintClean: boolean;
  diffLines: number;
  acceptanceMet: number;
  stdout: string;
  stderr: string;
}

// Review
export type FindingSeverity = "P0" | "P1" | "P2";
export type RubricStatus = "MET" | "NOT_MET" | "UNVERIFIABLE";
export type ReviewVerdict = "PASS" | "FAIL" | "PASS_WITH_COMMENTS";

export interface Finding {
  severity: FindingSeverity;
  path: string;
  line?: number;
  finding: string;
  category: string;
  confidence?: number;
}

export interface RubricResult {
  id: string;
  status: RubricStatus;
  evidence: string;
}

export interface RubricReviewOutput {
  verdict: ReviewVerdict;
  rubricResults: RubricResult[];
  additionalFindings: Finding[];
  categoriesChecked: string[];
}

// Adapters
export interface AgentAdapter {
  name: AgentName;
  buildCommand(contextFile: string, worktreePath: string): string;
  parseOutput(raw: string): AgentResult;
  healthCheck(): Promise<AgentHealth>;
}

export interface AgentResult {
  files?: { path: string; content: string }[];
  stdout: string;
  exitCode: number;
  structured?: Record<string, unknown>;
}

export interface AgentHealth {
  healthy: boolean;
  version?: string;
  error?: string;
}

// Gates
export interface GateResult {
  gate: string;
  passed: boolean;
  evidence: Record<string, unknown>;
  reason?: string;
  retryable?: boolean;
  errors?: string[];
}

// Stability
export type StabilitySignal =
  | "SAME_TEST_FAILS"
  | "SAME_P0_REPEATS"
  | "MALFORMED_REPEATS"
  | "FORBIDDEN_FILE"
  | "CONTEXT_STALL"
  | "TEST_DECREASE"
  | "SLOP_RECURRENCE"
  | "FINDING_INFLATION";

export type EscalationAction =
  | "STOP"
  | "RECOMPILE_CONTEXT"
  | "SPLIT_TASK"
  | "SWITCH_MODEL"
  | "ESCALATE_ARCHITECTURE"
  | "ASK_HUMAN";

export interface EscalationResponse {
  action: EscalationAction;
  reason: string;
}

export interface StabilityResult {
  signals: StabilitySignal[];
  shouldEscalate: boolean;
  response: EscalationResponse;
}

// Evidence
export interface CostReport {
  totalTokensIn: number;
  totalTokensOut: number;
  totalDispatches: number;
  totalDurationMs: number;
  perAgent: Record<
    AgentName,
    { tokensIn: number; tokensOut: number; dispatches: number }
  >;
}
```

---

## 16. CRITICAL IMPLEMENTATION NOTES

### Temporal Workflow Determinism

Workflow code runs in a sandboxed V8 context. The following are FORBIDDEN in workflow files:

- `Date.now()` → use `workflow.now()`
- `Math.random()` → use `workflow.uuid4()`
- `fs.readFile()` → must happen in activities
- `fetch()` → must happen in activities
- `console.log()` → use `workflow.log`
- Any network I/O → must happen in activities

ALL side effects (CLI calls, file reads, DB writes) MUST be in activities.

### Workflow/Activity Split Rule

| Operation                    | Where    | Why                       |
| ---------------------------- | -------- | ------------------------- |
| State transitions            | Workflow | Deterministic, replayable |
| Condition waits              | Workflow | Durable, survives crashes |
| Signal handling              | Workflow | Must be deterministic     |
| CLI dispatch                 | Activity | Side effect               |
| File system read/write       | Activity | Side effect               |
| SQLite queries               | Activity | Side effect               |
| Context compilation          | Activity | Reads filesystem          |
| Gate evaluation (mechanical) | Activity | Runs tsc, biome, vitest   |
| Gate evaluation (policy)     | Workflow | Pure logic, no I/O        |

### Windows-Specific Concerns

1. **Git worktrees:** Use `git worktree add` / `git worktree remove`. Works on Windows.
2. **File paths:** Always use `path.join()`, never string concatenation with `/`.
3. **Shell: false in execa:** Commands are arrays, not strings. Windows doesn't have `/bin/sh`.
4. **Temporal CLI binary:** Pre-built for `x86_64-pc-windows-msvc` (29MB). Auto-downloaded.
5. **Better-sqlite3:** Native addon. Uses prebuild-install. Works on Windows x64.
6. **Long paths:** Enable LongPathsEnabled in registry or use `\\?\` prefix if needed.

### Error Handling Strategy

```typescript
// Non-retryable errors (Temporal will NOT retry)
class OwnershipViolation extends Error {
  name = "OwnershipViolation";
}
class StabilityStop extends Error {
  name = "STABILITY_STOP";
}
class BuildGateExhausted extends Error {
  name = "BUILD_GATE_EXHAUSTED";
}
class FixLoopExhausted extends Error {
  name = "FIX_LOOP_EXHAUSTED";
}

// Retryable errors (Temporal WILL retry per RetryPolicy)
class MalformedOutput extends Error {
  name = "MalformedOutput";
}
class AgentTimeout extends Error {
  name = "AgentTimeout";
}
class RateLimited extends Error {
  name = "RateLimited";
}
```

Register non-retryable types in worker config:

```typescript
nonRetryableErrorTypes: [
  "OwnershipViolation",
  "STABILITY_STOP",
  "BUILD_GATE_EXHAUSTED",
  "FIX_LOOP_EXHAUSTED",
  "TOURNAMENT_ALL_FAILED",
];
```

---

## 17. TESTING STRATEGY

### Unit Tests (vitest)

| Module              | Key Tests                                           |
| ------------------- | --------------------------------------------------- |
| `context/indexer`   | Scoring math: modifies=150, reads=100, hops=25 each |
| `context/compress`  | transpileDeclaration produces valid .d.ts           |
| `context/budget`    | Binary search fitting respects priority             |
| `security/entropy`  | Detects API keys, ignores normal base64             |
| `security/denylist` | Blocks .env, .pem, secrets/                         |
| `gates/build-gate`  | Blocks on `as any`, TODO, long functions            |
| `gates/review-gate` | Blocks on P0, passes on P2-only                     |
| `stability/monitor` | 2 signals → escalation, 1 forbidden → stop          |
| `evidence/blobs`    | Content-addressed dedup works                       |

### Integration Tests (vitest + Temporal test environment)

| Test                     | Validates                                  |
| ------------------------ | ------------------------------------------ |
| `pipeline-happy`         | Full 10-phase pipeline completes           |
| `gate-blocks`            | Each gate type blocks correctly            |
| `crash-recovery`         | Stop worker during run, restart completes  |
| `hostile-isolation`      | Reviewer never sees builder prompt         |
| `tournament-3way`        | 3 agents compete, winner selected          |
| `stability-escalation`   | Repeated failure → early stop              |
| `fix-loop-blind`         | Iteration 2 reviewer has NO prior findings |
| `p0-unconditional-block` | P0 finding halts pipeline                  |

### Running Tests

```bash
# Unit tests (fast, no Temporal needed)
npx vitest run tests/unit/

# Integration tests (starts Temporal test environment automatically)
npx vitest run tests/integration/

# Single test
npx vitest run tests/integration/pipeline-happy.test.ts
```

---

## 18. STARTUP SEQUENCE (zer0 doctor)

```
$ zer0 doctor

Zer0 Agent CI — System Health Check
────────────────────────────────────

Temporal Server    ✓ Connected (localhost:7233, dev-server mode)
SQLite             ✓ WAL mode, 8 tables, 0 active runs
Claude CLI         ✓ v4.6.0
Codex CLI          ✓ v0.138.0
Gemini CLI         ✓ v2.4.1
Git                ✓ repo detected, branch: feature/xyz
Node.js            ✓ v22.14.0
TypeScript         ✓ v5.7.3
Disk Space         ✓ 42 GB free

All systems healthy. Ready to build.
```

---

## 19. OPEN QUESTIONS FOR DAY 1

These are the ONLY questions remaining before coding starts:

1. **Temporal dev server vs Docker:** The testing SDK can auto-start a dev server. Should we use that (simpler) or require `docker-compose up` (more production-like)? Recommendation: Use `TestWorkflowEnvironment.createLocal()` for development, Docker for CI.

2. **LangGraph for tournament:** The spec says "LangGraph JS (bounded)" for tournament. Is this worth the dependency (~50MB) for fan-out that `Promise.all` + Temporal child workflows already handle? Recommendation: Skip LangGraph, use Temporal child workflows. Add LangGraph in Phase 6 only if debate/arbiter needs it.

3. **Promptfoo integration timing:** Should evals run as part of CI (every commit) or as a separate `zer0 eval run` command? Recommendation: Both. CLI command for manual runs, CI for regression detection.

4. **Tree-sitter for repo map:** Phase 6 mentions tree-sitter. When exactly? Recommendation: Phase 2 initially uses ts.transpileDeclaration for TS files. Tree-sitter added in Phase 6 for non-TS file analysis (Python, Go, etc.).

---

## 20. DEPENDENCY MANIFEST

```json
{
  "dependencies": {
    "@temporalio/client": "^1.17.0",
    "@temporalio/worker": "^1.17.0",
    "@temporalio/workflow": "^1.17.0",
    "@temporalio/activity": "^1.17.0",
    "@temporalio/testing": "^1.17.0",
    "better-sqlite3": "^11.0.0",
    "execa": "^9.0.0",
    "typescript": "^5.7.0",
    "zod": "^3.23.0",
    "yoctocolors": "^2.0.0",
    "figures": "^6.0.0"
  },
  "devDependencies": {
    "vitest": "^3.0.0",
    "@biomejs/biome": "^1.9.0",
    "tsx": "^4.19.0",
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^22.0.0",
    "promptfoo": "^0.100.0"
  }
}
```

Total: ~12 production deps, ~6 dev deps. Temporal is the heaviest (~158MB native binaries).

---

## END OF PLAN

This document is sufficient to begin coding on Day 1 (Phase 1: Spine). Every file path, type signature, workflow name, signal name, and integration point is specified. When in doubt, the SPEC-CANONICAL-v6.md is the authority on WHAT; this document is the authority on HOW.
