# Zer0 Agent CI: The Ultimate Operational Plan

**Date:** 2026-05-03
**Target:** Engineering Execution Blueprint
**Reference:** Zer0 Agent CI Canonical Production Specification v6.0

This document is the **Execution Blueprint** for Zer0 Agent CI. It translates the v6.0 declarative specification into imperative software architecture. It defines exactly *how* the system is built, the mechanics of every automation, and the precise boundaries of every component.

---

## 1. EXACT Temporal Workflow Structure

Temporal owns the execution state. There are no custom JSON state machines.

### Workflows (src/workflows/)
* `MainCIWorkflow`: The root workflow orchestrating the 10-phase pipeline.
* `TaskBuildWorkflow`: A child workflow spawned for each build packet (Phase 7). Manages the Build -> Review -> Fix loop.
* `TournamentWorkflow`: An alternative child workflow for high-value packets running parallel agents.

### Activities (src/activities/)
* **Phase 1-6 (Planning):** `CompileIntentActivity`, `RunVisionQAActivity`, `RunResearchActivity`, `GenerateSpecActivity`, `GenerateArchitectureActivity`, `GeneratePlanActivity`.
* **Phase 7-9 (Execution):** `CompileContextActivity`, `ApplyDomainPatternsActivity`, `DispatchAgentActivity`, `EvaluateBuildGateActivity`, `TranspileDeclarationsActivity`, `RunRubricReviewActivity`, `EvaluateFixGateActivity`, `FinalAuditActivity`.
* **System Operations:** `WriteToSQLiteActivity`, `WriteBlobActivity`, `CheckStabilityMonitorActivity`.

### Signals (src/workflows/signals.ts)
* `approveShipSignal`: Human approval to merge/ship (Phase 10).
* `rejectShipSignal`: Human rejection of final payload.
* `answerVisionQASignal`: Human answers provided to Vision Q&A (Phase 2).
* `overrideGateSignal`: Human forcefully overrides a P0 block.

### Queries (src/workflows/queries.ts)
* `getWorkflowStatusQuery`: Returns current phase, active task, and block reasons.
* `getPendingQuestionsQuery`: Retrieves unanswered Vision Q&A questions.
* `getLedgerStatsQuery`: Returns count of P0s, test passes, and retries.

---

## 2. HOW Gates Fire Automatically

Gates are **not** AI models deciding to proceed. Gates are deterministic TypeScript functions executed within Temporal Activities.

**Mechanism:**
1. `TaskBuildWorkflow` schedules `DispatchAgentActivity` (the builder).
2. The builder completes, creating code in a specific worktree.
3. `TaskBuildWorkflow` immediately schedules `EvaluateBuildGateActivity`.

**EvaluateBuildGateActivity Code Logic (Simplified):**
```typescript
export async function EvaluateBuildGateActivity(worktreeId: string, packet: BuildPacket) {
  // 1. Ownership Check
  const diff = await execa('git', ['diff', '--name-only', 'HEAD'], { cwd: worktreeId });
  const modifiedFiles = diff.stdout.split('\n');
  const illegalFiles = modifiedFiles.filter(f => !packet.owned_files.includes(f));
  if (illegalFiles.length > 0) throw new Error(`GateFailed: Touched forbidden files: ${illegalFiles.join(', ')}`);

  // 2. Mechanical Clamps
  await execa('biome', ['check', '.'], { cwd: worktreeId }); // Throws on slop/lint errors
  await execa('vitest', ['run'], { cwd: worktreeId }); // Throws on test failure
  
  // 3. Complexity/Size checks
  // (Custom AST traversal using ts-morph or similar to enforce maxFunctionLength, etc.)
  
  return { status: 'PASS', metrics: { ... } };
}
```
If the activity throws, Temporal catches the error. The workflow logic catches the `GateFailed` error, increments the retry counter, logs to the Stability Monitor, and loops back to `DispatchAgentActivity` with the error appended to the prompt.

---

## 3. EXACT Sequence: `zer0 start` to Ship

1. **User Execution:** User runs `zer0 start --vision "Add Stripe checkout"`.
2. **CLI Initialization:** The CLI script parses the arguments. It generates a unique `run_id`.
3. **Database Setup:** CLI inserts a new row into the `runs` SQLite table. It creates `.zer0/blobs/`.
4. **Temporal Start:** CLI connects to the local Temporal server and starts `MainCIWorkflow(run_id, vision)`. The CLI process exits or tails the logs (`zer0 status --watch`).
5. **Phase 1 (Intent):** Workflow calls `CompileIntentActivity`. Claude generates IntentBrief. Workflow saves to blob store and updates SQLite.
6. **Phase 2 (Vision Q&A):** Workflow detects pending questions in IntentBrief. Workflow blocks, waiting on `answerVisionQASignal`. User runs `zer0 answer ...`. Signal received.
7. **Phase 3 (Research):** Workflow uses `Promise.all` to launch Gemini, Codex, and Claude `RunResearchActivity`s. Workflow waits for 2 of 3 to complete successfully.
8. **Phase 4-5 (Spec & Arch):** Sequential activities executed by Claude.
9. **Phase 6 (Plan):** `GeneratePlanActivity` creates the array of `BuildPacket`s and `contracts.ts`.
10. **Phase 7 (Build Loop):** Workflow iterates over `BuildPacket`s in dependency order. For each, it starts a `TaskBuildWorkflow`.
    * `TaskBuildWorkflow` creates a fresh git worktree.
    * Calls `CompileContextActivity`.
    * Calls `DispatchAgentActivity` (Codex).
    * Calls `EvaluateBuildGateActivity` (tests, linting).
    * If fail, retry up to 2 times. If pass, continue.
11. **Phase 8 (Review Loop):** `TaskBuildWorkflow` calls `RunRubricReviewActivity` (Claude).
    * Claude returns JSON findings.
    * Workflow evaluates `ReviewGate`. If P0 > 0, loops back to build with "blind retry" protocol.
    * If pass, `TaskBuildWorkflow` merges the worktree back to the main branch, writes `ts.transpileDeclaration()` to memory, and finishes.
12. **Phase 9 (Final Audit):** Main workflow runs `FinalAuditActivity` verifying requirement matrix against merged files.
13. **Phase 10 (Ship):** Workflow halts, awaiting `approveShipSignal`. User types `zer0 ship --approve`. Workflow completes successfully.

---

## 4. File Creation Ledger & Ownership

What gets created, in what order, and by whom:

1. **`.zer0/blobs/{sha256}`** (Created by `WriteBlobActivity` throughout the run). Every raw LLM input/output, diff, and CLI stdout is written here. Immutable.
2. **SQLite DB (`.zer0/evidence.db`)** (Created by CLI init, updated by `WriteToSQLiteActivity`).
3. **`.council/runs/{id}/intent/intent-brief.json`** (Created by Intent Compiler in Phase 1).
4. **`.council/runs/{id}/research/gemini-report.md`** (Created by Gemini in Phase 3).
5. **`.council/runs/{id}/spec.md`** (Created by Claude in Phase 4).
6. **`.council/runs/{id}/plan/contracts.ts`** (Created by Claude in Phase 6).
7. **`.council/runs/{id}/plan/packets/*.yaml`** (Created by Claude in Phase 6).
8. **`.zer0/worktrees/wt-{runId}-{taskId}/`** (Created by Temporal worker during Phase 7).
9. **`src/...` (The actual codebase)** (Modified exclusively by the Builder agent in the isolated worktree, then merged by the system upon gate pass).
10. **`.council/runs/{id}/review/findings-{taskId}.json`** (Created by Reviewer in Phase 8).

---

## 5. 3-Tier Context Assembly (Step-by-Step)

The `CompileContextActivity` executes the following algorithm to build the prompt for task $N$:

**Step 1: Assembly of Hot Tier (100% Inclusion)**
* Read `BuildPacket.yaml` for task $N$ (Objective, Acceptance Criteria).
* Pull currently failing test outputs from SQLite (if retry).
* Pull diff of currently owned files in the worktree.
* Pull human override comments (if any).

**Step 2: Assembly of Warm Tier (Scored & Truncated)**
* Parse `contracts.ts`. Extract exact signatures needed based on `BuildPacket.contracts`.
* Calculate Dual-Signal Score for all files in repo (`relevance * importance`).
* Sort files by score descending.
* For top-K files, run `ts.transpileDeclaration()`.
* Append to Warm Tier buffer until Warm Tier budget (e.g., 20k tokens) is exhausted.

**Step 3: Assembly of Cold Tier (Compressed Global)**
* Run `git ls-files`.
* Execute a fast AST pass (or regex) to grab `export` signatures across the entire repo.
* Create a dense 1-line-per-export index. (Takes ~5k tokens for a medium project).

**Step 4: Final Prompt Construction (6-Layer Assembly)**
Concatenate in this strict order:
1. Static prefix (System prompt, safety boundaries).
2. Project contract (`contracts.ts`, Architecture decisions).
3. Task Brief (Objective, Lookahead).
4. Cold Tier (The 1-line global index).
5. Warm Tier (The `.d.ts` of high-relevance dependencies).
6. Hot Tier (Current code, diffs, test outputs).
7. Endcap (Max-think demand, "DO NOT SHORTCUT").

Hash the resulting string. Write to `.zer0/blobs/`. Insert hash into SQLite `context_runs` table.

---

## 6. Structured Rubric Review (End-to-End)

**Trigger:** `EvaluateBuildGateActivity` passes mechanical clamps.
**Agent:** Claude (Fresh instance, no prior context).

1. **Input Generation:** System gathers code diff, `contracts.ts`, and Spec Section. System queries Domain Pattern Library for matched patterns (e.g., "authentication.yaml").
2. **Reviewer Prompt:** The Reviewer is instructed to output ONLY JSON matching the `RubricReviewOutput` Zod schema. It is explicitly forbidden from suggesting feature changes.
3. **Execution:** Reviewer is dispatched.
4. **Parsing:** Output is run through Zod. If malformed, retry Reviewer (max 3).
5. **Gate Decision:**
   * System parses Zod-validated JSON.
   * If `rubricResults` contains any `NOT_MET` that corresponds to a P0 domain requirement -> **FAIL**.
   * If `additionalFindings` contains `P0` -> **FAIL**.
   * If count of `P1` > threshold (5) -> **FAIL**.
   * If `PASS_WITH_COMMENTS` -> Log comments to SQLite, but **PASS** gate.

**Blind Retry Protocol (If FAILED):**
The `FixLoopWorkflow` starts. It calls the Builder agent, providing the Reviewer's findings in the Hot Tier. Once Builder finishes, a *new* Reviewer is spawned. **Crucially, the new Reviewer is NOT given the previous Reviewer's findings.** It must independently rediscover any flaws using only the rubric and the current code.

---

## 7. Stability Monitor (Detection & Response)

Runs asynchronously as an observer activity or inside the main workflow loop logic before every agent dispatch.

**Detection:**
1. Queries SQLite: `SELECT * FROM dispatches WHERE task_id = X ORDER BY created_at DESC`.
2. Evaluates signals:
   * Did vitest output the exact same stack trace hash twice in a row? -> `ConsecutiveTestFailure`
   * Are Reviewer P0 findings triggering on the same file:line in iteration $N$ and $N+1$? -> `ConsecutiveP0`
   * Is the input token count increasing while test pass count is stagnant? -> `ContextStall`

**Response (Escalation Trigger):**
If a threshold is crossed, the workflow does NOT just retry.
1. **Interrupt:** Halts `TaskBuildWorkflow` retry loop.
2. **Action 1 (Context Recompile):** Adds the `STABILITY_WARNING` flag to Context Compiler, forcing it to include failing test source files in Warm Tier regardless of score.
3. **Action 2 (Human Escalate):** If Action 1 fails, raises Temporal `ActivityTaskFailed` with `EscalationRequired` flag, bubbling up to `MainCIWorkflow`, which pauses and emits a notification for the human operator.

---

## 8. Tournament Mode Orchestration

For complex, high-risk packets (marked `sandbox_level: > 1` or explicitly tagged), `MainCIWorkflow` branches into `TournamentWorkflow` instead of `TaskBuildWorkflow`.

1. **Fan-Out:** `TournamentWorkflow` uses `Promise.all` to launch 3 independent `TaskBuildWorkflow` instances.
   * Instance A: Codex
   * Instance B: Claude
   * Instance C: DeepSeek (or other configured)
2. **Isolation:** Each instance gets its own git worktree (`wt-{runId}-{taskId}-codex`, etc.).
3. **Execution:** All three agents run the standard Build -> Mechanical Gate loop in parallel.
4. **Fan-In / Arbiter:** Once mechanical gates pass (or timeout/exhaust retries):
   * `TournamentWorkflow` gathers metrics for all passing instances from SQLite: Vitest pass %, Biome warning count, Diff size (LoC), cyclomatic complexity.
   * **Deterministic Selection:** The system selects the winner strictly via a scoring formula (e.g., 100% tests passed AND lowest diff size AND 0 lint warnings).
   * **Optional Arbiter Agent:** If there is a tie on mechanical metrics, an Arbiter Agent (Claude) is fed the diffs of both and the Acceptance Criteria, and outputs a JSON decision on which diff is architecturally cleaner.
5. **Merge:** The winning worktree is merged to the primary branch. The losers are discarded (but their artifacts remain in SQLite for the Golden Trajectory Dataset).