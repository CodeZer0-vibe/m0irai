# buildPacketWorkflow — End-to-End Temporal Architecture

**Status:** v2 council-ratified 2026-05-08. v1 design 2026-05-06 was REDESIGN per codex hostile review (3 SPEC §18 contradictions, 5 P0 protocol gaps). v2 closes all P0/P1 findings and promotes ephemeral-spawn-per-activity from PROPOSED to CANONICAL.

**Implementation:** packet-11 (split into 11a/11b/11c/11d sub-packets; codex realistic estimate 28-40 files, 3000-4500 lines, 2-4 fix-loops).

**Source directives (user, 2026-05-05/06/08):**

- "the system should be smart enough...don't depend on agents to remember stuff like to check, read this, load this, do it like this"
- "the temporal worker IS the discipline" — workflow enforces structure mechanically; agents are pure transformation functions
- "we can learn and optimize based on the issues or wins we find during our advancing" — self-improvement loop is built in
- "spawn fresh new agents every time, by having the tracking files for each agent that are maintained by phase task" — ephemeral spawn over long-lived sessions

This document is the canonical reference. When implementing packet-11, read this first, then `docs/adrs/_system/ADR-S-001-workflow-enforced-discipline.md`.

---

## 0. COUNCIL RATIFICATION LOG (v1 → v2)

| Source                                                                  | Verdict                     | Findings addressed in v2                    |
| ----------------------------------------------------------------------- | --------------------------- | ------------------------------------------- |
| Codex hostile review (`buildpacketworkflow-codex-review-result.md`)     | REDESIGN                    | 5 P0 + 9 P1 + 4 P2                          |
| Gemini synthesis review (`buildpacketworkflow-gemini-review-result.md`) | ALIGNS-WITH-INDUSTRY (9/10) | 5 priority refinements + 4 missing patterns |
| User directive                                                          | INCORPORATE-ALL             | every accepted finding has a §-anchor below |

**Codex P0 dispositions (all ACCEPTED — see §14 for line-level rationale):**

1. P0-1 duplicate-run protection → §4a workflow ID + repo lease
2. P0-2 review-before-commit violates SPEC §18 → §4 reordered: commit then review
3. P0-3 LLM dispatch idempotency incomplete → §4a stable claim key
4. P0-4 cancellation is a signal not a protocol → §4b cancellation protocol
5. P0-5 manifest semantic validation missing → §5a semantic validation pipeline

**Codex P1 dispositions (8 ACCEPTED, 1 DEFERRED — see §14):**

6. P1-6 SPEC requires two audit passes → §5b two-pass audit
7. P1-7 `runGatesActivity` too large → §5 per-gate sub-activities
8. P1-8 shell syntax in gate commands → §5 execa-only
9. P1-9 baseline failures trap unrelated phases → §7a baseline + delta-aware (DEFERRED to packet-13)
10. P1-10 DONE commit ordering leaves docs outside seal → §4 docs before seal
11. P1-11 fix-loop attribution underspecified → §4 structured `AttemptFailure[]`
12. P1-12 human escalation can deadlock → §7 proposal queue
13. P1-13 mandates can break existing code → §7a baseline + migration plan
14. P1-14 packet-11 estimate materially low → §9 split into 11a/11b/11c/11d

**Gemini priority dispositions:**

- G1 workflow versioning → §4c canonical
- G2 tracking-file schema → §5c canonical
- G3 activity memoization → §11d follow-up
- G4 OpenTelemetry → already in packet-10 scope (§5 references)
- G5 parameterized phases → DEFERRED (§14)

**Ephemeral-spawn-per-activity:** both reviewers ENDORSE-WITH-AMENDMENTS → promoted from §13 amendment to §13 canonical with codex's 5 required amendments incorporated.

---

## 1. THE PRINCIPLE

**Today (broken):** orchestrator hand-cranks every dispatch — writes brief, dispatches agent, runs gates, writes fix-loop brief if needed, dispatches reviewer, commits. Repeat per phase. Per packet. Forever. Agent is asked to "remember" 30+ rules from MD files.

**Right model:** the Temporal workflow IS the discipline. Agent receives a focused ≤300-line prompt with EVERYTHING it needs inlined. After agent finishes, workflow runs gates automatically, generates fix-loop brief from gate output if needed, dispatches reviewer ON THE COMMITTED DIFF, commits. Agent doesn't remember anything; workflow enforces structure.

**Codex/claude/gemini become pure functions:** `(focused_prompt, current_code_state, current_tracking_file) → file_diff + tracking_file_update`.

CI pipelines don't ask developers to "remember to run linters before pushing." They run linters on push. **Process > discipline.**

**Three constants enforced by the workflow (not by the agent):**

1. **Every LLM call sees a fresh context** (ephemeral spawn — §13)
2. **Every authoring boundary has a different-family hostile review on the COMMITTED diff** (Gate Topology — §5b)
3. **Every finding becomes a permanent gate** (self-improvement — §7)

---

## 2. CLI ENTRY POINT

```
zer0 build <packet-id> [--dry-run] [--mode auto|semi|full]
```

CLI behavior:

1. Reads `.council/packets/{packet-id}/manifest.yaml` (declares phase structure, owned files, ADRs, anti-patterns per phase). Validates with Zod + semantic checks (§5a).
2. Reads `.council/packets/{packet-id}/canonical-brief.md` (orchestrator-written, can be 1000+ lines — only the workflow reads this, never the agent).
3. Computes the **deterministic workflow ID** = `build:${repoFingerprint}:${packetId}` where `repoFingerprint = sha256(git rev-parse HEAD + manifest content + zer0-cli version)`.
4. **Rejects duplicate runs** — if a workflow with this ID is already RUNNING, exit with `EXIT_DUPLICATE_RUN` and print existing run URL. To restart, user must `zer0 cancel <runId>` first.
5. Acquires a **repo lease** before starting (file `.zer0/leases/{packetId}.lock` with PID + start time + workflow ID — released on workflow completion or cancellation).
6. Starts `buildPacketWorkflow` with `{ packetId, manifestPath, canonicalBriefPath, repoFingerprint, mode }` as input.
7. Attaches to workflow for status streaming (NDJSON via existing `zer0 stream`).

User can pause, change mode, approve patches, all via Temporal signals (§6).

---

## 3. THE MANIFEST FORMAT

```yaml
# .council/packets/packet-N/manifest.yaml
schemaVersion: 1 # for future migrations
packetId: "packet-N"
summary: "one-line packet description"
canonicalBriefPath: ".council/packets/packet-N/canonical-brief.md"
finalReviewer: "fresh-claude-l5"
maxFixLoopsPerPhase: 3
maxFixLoopsFinal: 2

# Token + line budget for context preparation
contextBudget:
  maxLines: 300 # hard cap for ContextPack.promptText
  maxTokens: 8000 # secondary limit
  mustNotOmit: # sections that bypass truncation
    - "owned_files"
    - "acceptance_gates"
    - "anti_patterns_named"

phases:
  - name: "schemas"
    summary: "IntentBrief Zod schemas + ULID-branded types"
    builder: "codex" # workspace-write sandbox
    reviewer: "claude" # cross-family from codex; orchestrator-direct
    secondaryReviewer: "claude-deep-audit" # two-pass audit (§5b)
    timeoutMs: 1800000 # 30 min
    heartbeatTimeoutMs: 60000 # 1 min
    ownedFiles: # exact paths; semantic validator rejects overlaps
      - "src/intent/schema.ts"
      - "src/intent/schema.test.ts"
    forbiddenFiles: # NEVER touched by this phase
      - "package.json"
      - "src/cli/dashboard/**"
    adrIds:
      - "ADR-014" # resolved via .council/adr-index.json
      - "ADR-015"
    moduleMapRows:
      - "src/intent/schema.ts"
    antiPatternIds: [1, 5] # test theater + stub pretending real
    requiredGates:
      - "typecheck"
      - "biome"
      - "gate-clamps"
      - "gate-l5"
      - "tests"
    skipGates: [] # exempt some gates if phase doesn't apply

  - name: "compiler"
    summary: "Vibe → IntentBrief translator"
    builder: "codex"
    reviewer: "claude"
    secondaryReviewer: "claude-deep-audit"
    dependsOn: ["schemas"] # DAG dependency; semantic validator detects cycles
    timeoutMs: 1800000
    heartbeatTimeoutMs: 60000
    # ... rest of phase config
```

The manifest becomes the SINGLE SOURCE OF TRUTH for the packet's build. Workflow reads it. Agents never see it whole — they see only their phase's focused prompt (≤300L per `contextBudget.maxLines`).

---

## 4. THE WORKFLOW (pseudocode v2)

```typescript
async function buildPacketWorkflow(
  input: BuildPacketInput,
): Promise<BuildPacketResult> {
  // STEP A: load + semantically validate manifest BEFORE any code is touched
  const manifest = await loadManifestActivity({
    manifestPath: input.manifestPath,
    repoFingerprint: input.repoFingerprint,
  });
  // loadManifestActivity throws nonRetryable on:
  //   - Zod parse failure
  //   - DAG cycle in phase dependsOn
  //   - duplicate phase names
  //   - ownedFiles overlap between phases
  //   - missing ADR files (resolved from adrIds via adr-index.json)
  //   - forbidden gate names

  const state: BuildState = {
    packetId: manifest.packetId,
    phase: "init",
    commits: [],
    findings: [],
    startedAt: workflowInfo().startTime,
    runId: workflowInfo().workflowId,
    repoFingerprint: input.repoFingerprint,
  };

  // STEP B: PREFLIGHT — verify environment is sane
  const preflight = await preflightActivity({
    manifest,
    expectedAdrs: manifest.phases.flatMap((p) => p.adrIds),
    expectedMapRows: manifest.phases.flatMap((p) => p.moduleMapRows),
  });
  if (!preflight.ready) {
    throw ApplicationFailure.create({
      nonRetryable: true,
      type: "PREFLIGHT_FAILED",
      details: [preflight.issues],
    });
  }
  // baseline gate snapshot is recorded but NOT enforcing per phase
  // (pre-existing failures unrelated to owned files would otherwise trap every phase)

  // STEP C: per-phase build loop (DAG-ordered)
  for (const phase of resolvePhaseOrder(manifest.phases)) {
    state.phase = phase.name;
    const failures: AttemptFailure[] = []; // structured history, not just last

    while (failures.length < manifest.maxFixLoopsPerPhase) {
      const attempt = failures.length;

      // STEP C.1: assemble focused context (ephemeral spawn input file — §13)
      const contextPack = await prepareContextActivity({
        canonicalBriefPath: manifest.canonicalBriefPath,
        phase,
        priorCommits: state.commits,
        unresolvedFailures: failures.filter((f) => !f.resolved),
        attempt,
      });

      // STEP C.2: dispatch agent (workspace-write sandbox)
      // claim key = sha256(workflowId + phase + attempt + contextPack.fingerprint)
      // → Temporal retry reuses same claim; idempotent
      const buildResult = await dispatchAgentActivity({
        agent: phase.builder,
        sandbox: "workspace-write",
        promptText: contextPack.promptText,
        claimKey: deriveClaimKey(
          state.runId,
          phase.name,
          attempt,
          contextPack.fingerprint,
        ),
        timeoutMs: phase.timeoutMs,
        heartbeatTimeoutMs: phase.heartbeatTimeoutMs,
      });

      // STEP C.3: run mechanical gates (per-gate sub-activities, P1-7 fix)
      const gateReport = await runGatesActivity({
        gates: phase.requiredGates,
        ownedFiles: phase.ownedFiles,
        baselineFailures: preflight.baseline,
      });

      if (!gateReport.allPassed) {
        failures.push({
          kind: "gate",
          attempt,
          report: gateReport,
          resolved: false,
          firstSeenAt: Date.now(),
        });
        continue;
      }

      // STEP C.4: COMMIT FIRST (P0-2 fix — packet-sealed-gate)
      // The committed diff is what the reviewer audits.
      // Reviewer NEVER sees builder's prompt or context pack.
      const phaseCommit = await commitActivity({
        message: `prep(${manifest.packetId}-${phase.name}): ${phase.summary}`,
        files: phase.ownedFiles,
        intentKey: deriveCommitIntentKey(state.runId, phase.name, attempt),
      });
      state.commits.push({ phase: phase.name, sha: phaseCommit.sha });

      // STEP C.5: TWO-PASS AUDIT (P1-6 fix — SPEC §18.6 compliance)
      const primaryReview = await dispatchReviewActivity({
        reviewer: phase.reviewer,
        sandbox: "read-only",
        rubric: "L5-HOSTILE-REVIEW-RUBRIC",
        commitSha: phaseCommit.sha, // reviewer fetches diff from sealed commit
        ownedFiles: phase.ownedFiles,
        ownershipManifestPath: input.manifestPath,
        // EXPLICITLY no contextPack, no builder prompt, no builder reasoning
      });

      const secondaryAudit = await dispatchReviewActivity({
        reviewer: phase.secondaryReviewer,
        sandbox: "read-only",
        rubric: "L5-MISSED-DIMENSIONS-AUDIT", // different prompt — looks for primary's blind spots
        commitSha: phaseCommit.sha,
        ownedFiles: phase.ownedFiles,
        primaryReviewFindings: primaryReview.findings, // ONLY findings, not reasoning
      });

      const blockingFindings = [
        ...primaryReview.findings.filter(
          (f) => f.severity === "P0" || f.severity === "P1",
        ),
        ...secondaryAudit.findings.filter(
          (f) => f.severity === "P0" || f.severity === "P1",
        ),
      ];

      if (blockingFindings.length > 0) {
        // Revert phase commit so re-attempt operates on clean tree
        await revertCommitActivity({ sha: phaseCommit.sha });
        state.commits.pop();
        failures.push({
          kind: "review",
          attempt,
          findings: blockingFindings,
          resolved: false,
          firstSeenAt: Date.now(),
        });
        continue;
      }

      // Phase passed — exit fix-loop
      break;
    }

    // After fix-loop: did any unresolved failure remain?
    if (
      failures.length === manifest.maxFixLoopsPerPhase &&
      failures[failures.length - 1].resolved === false
    ) {
      await escalateActivity({
        phase,
        attempts: failures.length,
        failures,
        runId: state.runId,
      });
      throw ApplicationFailure.create({
        nonRetryable: true,
        type: "FIX_LOOP_EXHAUSTED",
        details: [phase.name, failures.length],
      });
    }
  }

  // STEP D: full-packet final review (cross-family) — operates on COMMITTED diff
  const finalReview = await dispatchReviewActivity({
    reviewer: manifest.finalReviewer,
    sandbox: "read-only",
    rubric: "L5-HOSTILE-REVIEW-RUBRIC",
    commitRange: `${state.commits[0].sha}^..${state.commits[state.commits.length - 1].sha}`,
    ownedFiles: manifest.phases.flatMap((p) => p.ownedFiles),
    ownershipManifestPath: input.manifestPath,
  });

  if (finalReview.hasBlockingFindings) {
    // final fix-loop covers cross-phase issues — same protocol as per-phase
    // ... (omitted for brevity; identical pattern with maxFixLoopsFinal cap)
  }

  // STEP E: lessons + docs BEFORE seal (P1-10 fix)
  const lessons = await analyzePacketActivity({
    packetId: manifest.packetId,
    state,
    finalReview,
  });
  await postCommitDocumentationActivity({
    packetId: manifest.packetId,
    state,
    lessons,
  });
  // ↑ writes docs/HANDOFF.md, docs/lessons/{date}-{packetId}.md, etc.

  // STEP F: SEAL — final DONE commit includes lessons + handoff updates
  const sealCommit = await commitActivity({
    message: `DONE(${manifest.packetId}): ${manifest.summary}`,
    files: [
      "docs/HANDOFF.md",
      `docs/lessons/${todayISO()}-${manifest.packetId}.md`,
      ...lessons.touchedDocPaths,
    ],
    intentKey: deriveCommitIntentKey(state.runId, "seal", 0),
  });
  state.commits.push({ phase: "DONE", sha: sealCommit.sha });

  return {
    packetId: manifest.packetId,
    commits: state.commits,
    findings: state.findings,
    lessons,
  };
}
```

### Workflow ordering invariants (must hold)

| #   | Invariant                                                   | Enforced where                            |
| --- | ----------------------------------------------------------- | ----------------------------------------- |
| W1  | Manifest validated semantically BEFORE any code touched     | Step A — `loadManifestActivity`           |
| W2  | Duplicate workflow IDs rejected                             | CLI `start` — workflow ID collision check |
| W3  | Gates run BEFORE commit                                     | Step C.3 → C.4                            |
| W4  | Commit happens BEFORE review (packet-sealed-gate, SPEC §18) | Step C.4 → C.5                            |
| W5  | Reviewer NEVER receives builder context                     | Step C.5 — only `commitSha + ownedFiles`  |
| W6  | Two-pass audit per phase                                    | Step C.5 — primary + secondary            |
| W7  | Lessons + docs committed in DONE seal (not separate)        | Step E → F                                |
| W8  | Failed-review commit reverted before retry                  | Step C.5 fail branch                      |

---

## 4a. CONCURRENCY & IDEMPOTENCY PROTOCOL

### W1 Workflow ID + repo lease

```typescript
function deriveWorkflowId(packetId: string, repoFingerprint: string): string {
  return `build:${repoFingerprint}:${packetId}`;
}

function deriveRepoFingerprint(repoPath: string): string {
  const head = exec(`git -C ${repoPath} rev-parse HEAD`).stdout.trim();
  const manifest = readFileSync(
    `${repoPath}/.council/packets/${packetId}/manifest.yaml`,
  );
  const cliVersion = readFileSync(`${repoPath}/package.json`, "utf8").version;
  return sha256(`${head}|${manifest}|${cliVersion}`).slice(0, 16);
}
```

CLI start logic:

1. Compute workflow ID
2. Query Temporal: is workflow with this ID currently RUNNING?
3. If yes → exit with `EXIT_DUPLICATE_RUN`
4. Acquire repo lease (`.zer0/leases/{packetId}.lock`) — fail if exists and PID is alive
5. Start workflow
6. On workflow completion or cancel → release lease

### Claim keys for idempotent activity retry

Every activity that produces side-effects (LLM dispatch, commit, review) computes a **claim key** before running. If a row with the same claim key already exists in the evidence DB with a successful outcome, the activity returns that outcome instead of re-doing the work.

```typescript
function deriveClaimKey(
  runId: string,
  phase: string,
  attempt: number,
  contextHash: string,
): string {
  return sha256(`${runId}|${phase}|${attempt}|${contextHash}`).slice(0, 32);
}

function deriveCommitIntentKey(
  runId: string,
  phase: string,
  attempt: number,
): string {
  return sha256(`${runId}|commit|${phase}|${attempt}`).slice(0, 32);
}
```

**Schema additions** (packet-11a):

```sql
-- dispatch_claims: idempotency for LLM dispatches
CREATE TABLE IF NOT EXISTS dispatch_claims (
  claim_key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  agent TEXT NOT NULL,
  model_version TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  cli_version TEXT NOT NULL,
  prompt_text BLOB NOT NULL,
  prompt_fingerprint TEXT NOT NULL,
  result_json TEXT,                 -- NULL until success
  exit_code INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

-- commit_intents: idempotency for git commits
CREATE TABLE IF NOT EXISTS commit_intents (
  intent_key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  files_json TEXT NOT NULL,         -- ordered list
  message TEXT NOT NULL,
  parent_sha TEXT NOT NULL,         -- expected HEAD when commit was created
  result_sha TEXT,                  -- NULL until success
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
```

### Repo lease (`.zer0/leases/{packetId}.lock`)

```json
{
  "workflowId": "build:abc123:packet-11",
  "pid": 14523,
  "host": "DESKTOP-ABC",
  "startedAt": "2026-05-08T11:30:00Z",
  "leaseExpiresAt": "2026-05-08T13:30:00Z"
}
```

If lease file exists at start:

- If PID alive AND lease not expired → DUPLICATE_RUN
- If PID dead OR lease expired → reclaim (overwrite) and continue

### Owned-files overlap detection

`loadManifestActivity` builds an inverse index `Map<filePath, phaseName[]>` and rejects if any path appears in 2+ phases.

---

## 4b. CANCELLATION PROTOCOL

### Heartbeat + abort propagation

Every long-running activity must:

1. Emit Temporal heartbeats every `phase.heartbeatTimeoutMs / 3` (default 20s)
2. Receive `Context.cancellationSignal` from Temporal SDK
3. Thread `AbortSignal` into all subprocess calls (`execa({ signal })`)
4. On abort, run cleanup compensation in a `try/finally`

```typescript
export async function dispatchAgentActivity(
  input: DispatchInput,
): Promise<DispatchResult> {
  const ctx = Context.current();
  const heartbeat = setInterval(() => ctx.heartbeat(), 20_000);
  try {
    return await execa(input.agent, input.args, {
      signal: ctx.cancellationSignal,
      timeout: input.timeoutMs,
      maxBuffer: 50 * 1024 * 1024, // 50 MB cap
      stdio: ["pipe", "pipe", "pipe"],
      reject: false,
    });
  } finally {
    clearInterval(heartbeat);
  }
}
```

### Activity-specific cleanup contracts

| Activity                 | On cancellation must                                        |
| ------------------------ | ----------------------------------------------------------- |
| `dispatchAgentActivity`  | SIGTERM child + 5s grace + SIGKILL; remove temp prompt file |
| `commitActivity`         | Release `.git/index.lock` if held; restore staged tree      |
| `runGatesActivity`       | SIGTERM each gate subprocess; capture partial output        |
| `dispatchReviewActivity` | SIGTERM review subprocess; remove temp prompt file          |
| `prepareContextActivity` | None (pure function)                                        |
| `loadManifestActivity`   | None (read-only)                                            |

### Workflow-level cancellation

- `zer0 cancel <runId>` → Temporal `RequestCancelWorkflowExecution`
- Workflow catches `CancelledFailure` in outer try/catch
- Releases repo lease
- Writes `events` row `kind: "workflow_cancelled"`
- Phase commits already in tree are NOT reverted (user can `git reset` if desired)

### Force-kill recovery

If worker process is force-killed mid-activity:

- Temporal will retry the activity on a different worker (per retry policy)
- The claim-key idempotency check returns existing result if dispatch succeeded
- The commit-intent idempotency check verifies parent SHA matches before retrying

---

## 4c. WORKFLOW VERSIONING (gemini G1)

When `buildPacketWorkflow` logic changes between releases, in-flight executions must continue with their original logic. Use Temporal's `patched()` API:

```typescript
import { patched } from "@temporalio/workflow";

if (patched("v2-two-pass-audit-per-phase")) {
  // v2+ logic — two-pass audit
} else {
  // pre-v2 fallback — single review
}
```

**Versioning policy:**

- Each major v2 → v3 transition gets a named patch
- Patches are listed in `src/temporal/workflows/patches.ts`
- After all v(n-1) workflows complete, `deprecatePatch("v(n-1)-name")` is called in the next release
- Workflow tests assert behavior on both branches of every active patch

---

## 5. THE ACTIVITIES (concrete contracts v2)

### `loadManifestActivity({ manifestPath, repoFingerprint }) → Manifest`

Pipeline:

1. Read YAML, parse with `js-yaml`
2. Validate with `ManifestSchema` (Zod) — typed shape check
3. Run **semantic validators** (§5a) in order, halt on first failure:
   - `validateUniquePhaseNames(manifest)`
   - `validateNoDependencyCycles(manifest)`
   - `validateNoOwnedFilesOverlap(manifest)`
   - `validateAdrIdsResolvable(manifest)` — checks `.council/adr-index.json`
   - `validateNoForbiddenGateNames(manifest)`
   - `validateBuilderReviewerCrossFamily(manifest)` — claude≠claude reviewing each other's same-family work
4. Verify `repoFingerprint` matches re-computed fingerprint (if not, manifest changed since CLI start — fail safely)
5. Return `Manifest` with all derived indexes (phaseByName, dependentsOf, ownedFilesIndex)

Throws `ApplicationFailure` (`nonRetryable: true`) on any validation failure.

### `preflightActivity({ manifest, expectedAdrs, expectedMapRows }) → PreflightResult`

- Verify git working tree clean (`git status --porcelain` empty)
- Verify all referenced ADR files exist on disk
- Verify all MODULE-MAP rows exist for owned files
- Run `gate-clamps + gate-l5 + typecheck + tests` baseline (informational — capture, don't enforce)
- Return `{ ready: bool, baseline: BaselineSnapshot, issues: string[] }`

`BaselineSnapshot` shape:

```typescript
{
  gateClamps: { exitCode: number; violationCount: number };
  gateL5: { exitCode: number; violations: Violation[] };
  typecheck: { exitCode: number; errorCount: number };
  tests: { passed: number; failed: number; skipped: number };
  capturedAt: number;
}
```

Per-phase `runGatesActivity` references this baseline to subtract pre-existing violations from new ones (delta-aware mode flagged in P1-9, deferred).

### `prepareContextActivity({ canonicalBriefPath, phase, priorCommits, unresolvedFailures, attempt }) → ContextPack`

THE KEY ACTIVITY. Builds the ≤300-line focused prompt the agent actually receives.

**Inputs:**

- Canonical brief path (the long doc — workflow reads this, agent doesn't)
- Phase config (ownedFiles, adrIds, moduleMapRows, antiPatternIds)
- Prior commits (so the prompt can reference what's already committed)
- **Unresolved failures** (structured `AttemptFailure[]` — only failures that haven't been fixed in prior attempts; resolved-then-recurred failures get a "REPEATING" marker)
- Attempt number

**Process:**

1. Read canonical brief
2. Extract phase-relevant sections (Section 4 owned files for THIS phase, Section 13 acceptance gates relevant to this phase, etc.)
3. Read each ADR in `phase.adrIds` and inline the **Decision + Consequences** sections
4. Read MODULE-MAP rows for `phase.moduleMapRows` and inline as a small table
5. Read AGENTS.md and extract ONLY the clamps relevant to file types in `phase.ownedFiles`
6. Inline the named anti-patterns from `phase.antiPatternIds`
7. Inline the per-phase Section 23 self-check items (auto-templated from `phase.requiredGates` + `phase.ownedFiles`)
8. If `unresolvedFailures.length > 0`, prepend a "PRIOR ATTEMPT FAILURES" section:
   - For each failure: file:line citation, gate output OR review finding, expected fix
   - Repeating failures (same finding across 2+ attempts) get bold `[REPEATING — must address now]` marker
9. Append the brief's Section 16 OUTPUT FORMAT spec
10. **Token + line budget enforcement**:
    - Hard cap from `manifest.contextBudget.maxLines` (default 300)
    - `mustNotOmit` sections are tagged and never truncated (§3 manifest)
    - Truncation order on overflow: ADR Context → MODULE-MAP comments → AGENTS clamps → ADR Decision/Consequences (last)
    - If still over after truncation, throw `CONTEXT_BUDGET_EXCEEDED` (forces orchestrator to split phase)

**Output:**

```typescript
{
  promptText: string;                // ≤ contextBudget.maxLines
  fingerprint: string;               // sha256(canonicalBrief + phase.name + attempt + unresolvedFailures.length)
  inlinedReferences: {
    adrIds: string[];
    moduleMapRows: string[];
    antiPatternIds: number[];
  };
  truncatedSections: string[];      // empty if all fit
}
```

### `dispatchAgentActivity({ agent, sandbox, promptText, claimKey, timeoutMs, heartbeatTimeoutMs }) → DispatchResult`

Idempotency:

1. Look up `claimKey` in `dispatch_claims` table.
2. If found AND `result_json` non-null AND `exit_code === 0` → return cached result.
3. If found AND in-flight (no `completed_at`) → wait via heartbeat poll (max 60s), then re-check.
4. Otherwise insert claim row, run subprocess, persist result.

Subprocess execution:

- Spawn fresh process (ephemeral spawn — §13)
- Sandbox per `sandbox` param: `workspace-write` for build, `read-only` for review
- `execa(agent, args, { input: promptText, signal: ctx.cancellationSignal, timeout: timeoutMs, maxBuffer: 50_000_000 })`
- Heartbeat every `heartbeatTimeoutMs / 3`
- On exit: compute diff via `git diff --stat HEAD~..HEAD`, capture stdout/stderr, persist result_json + exit_code in `dispatch_claims`

Returns `{ exitCode, stdout, stderr, diff, durationMs, modelVersion, adapterVersion, cliVersion, dispatchId }`.

### `runGatesActivity({ gates, ownedFiles, baselineFailures }) → GateReport`

**Per-gate sub-activity pattern (P1-7 fix):** each gate is an independent activity call with its own timeout, heartbeat, and `maxBuffer` cap. Gates run sequentially per phase (parallelism causes test-DB contention). Total time = sum of individual timeouts.

Gates and their commands (all via execa, never shell — P1-8 fix):

| Gate          | Command (args array)                     | Timeout | maxBuffer |
| ------------- | ---------------------------------------- | ------- | --------- |
| `typecheck`   | `npm`, `[run, typecheck]`                | 120s    | 10MB      |
| `biome`       | `npx`, `[biome, check, .]`               | 60s     | 10MB      |
| `gate-clamps` | `node`, `[scripts/gate-clamps.mjs]`      | 60s     | 10MB      |
| `gate-l5`     | `node`, `[scripts/gate-l5-mandates.mjs]` | 60s     | 10MB      |
| `dep-check`   | `npm`, `[run, dep-check]`                | 120s    | 10MB      |
| `dead-code`   | `npm`, `[run, dead-code]`                | 60s     | 10MB      |
| `tests`       | `npx`, `[vitest, run, --reporter=json]`  | 600s    | 50MB      |

Each result captured as structured output:

```typescript
{
  gate: string;
  passed: boolean;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  violations: Violation[];          // parsed from gate output
  baselineDelta: Violation[];       // new violations beyond baseline
}
```

`allPassed` = every `gate.passed === true` (or `baselineDelta.length === 0` if delta-aware mode enabled in v3).

### `dispatchReviewActivity({ reviewer, sandbox, rubric, commitSha | commitRange, ownedFiles, ownershipManifestPath, primaryReviewFindings? }) → ReviewReport`

**SPEC §18 compliance (P0-2 fix):** reviewer receives ONLY:

- The committed diff (extracted from `commitSha` or `commitRange` via `git show` / `git log -p`)
- The list of owned files (so reviewer knows scope)
- The manifest path (so reviewer can read ADRs / SPEC sections referenced by the rubric)

Reviewer NEVER receives:

- Builder's prompt
- Builder's reasoning / scratch
- Context pack content
- Anything from `prepareContextActivity` output

For two-pass audit (§5b), the secondary auditor DOES receive `primaryReviewFindings.findings` (only the structured findings, not the primary's reasoning) so it can focus on missed dimensions.

Dispatches via canonical dispatcher (orchestrator-direct claude, fresh-claude, or codex read-only depending on cross-family rule). Subprocess sandbox per `sandbox` param.

Parses review output into structured findings:

```typescript
{
  verdict: "PASS" | "NEEDS-FIX" | "REJECT";
  hasBlockingFindings: boolean;       // any P0 or P1
  findings: Finding[];                // {severity, dimension, file, line, message, suggestedFix}
  dimensionalScores: Record<string, "PASS" | "PARTIAL" | "FAIL">;
  l5Score: number;                    // 0-100
  reviewerFingerprint: string;        // model + adapter + rubric versions
}
```

### `commitActivity({ message, files, intentKey }) → CommitResult`

Idempotency via `commit_intents` table:

1. Look up `intentKey` in `commit_intents`.
2. If found AND `result_sha` non-null → verify SHA still exists in repo (`git cat-file -e`); if yes return; if no (force-pushed?) re-commit.
3. Otherwise:
   - Capture `parent_sha = git rev-parse HEAD`
   - Insert claim row
   - Stage `files` (`git add --` for each path; never `git add .`)
   - Verify staged set equals expected (`git diff --cached --name-only`)
   - `git commit -m "${message}"`
   - Capture new SHA via `git rev-parse HEAD`
   - Update claim with `result_sha` + `completed_at`
4. Return `{ sha, filesChanged, timestamp, parentSha }`.

If staging fails (e.g., file doesn't exist), throw `STAGE_FAILED` non-retryable.

### `revertCommitActivity({ sha }) → void`

For failed-review rollback (W8 invariant):

1. Verify `sha === git rev-parse HEAD` (refuse to revert non-tip commit)
2. `git reset --soft HEAD^` (preserves working tree changes)
3. `git restore --staged .` + `git restore .` (cleans tree to parent state)
4. Insert `events` row `kind: "phase_review_reverted"` with `commit_sha`

### `escalateActivity({ phase, attempts, failures, runId }) → void`

- Writes `.council/packets/{packetId}/ESCALATION-{phase}.md` with full context (failures structured, file:line citations, gate outputs)
- Inserts `events` row with `kind: "escalation"`
- Emits Temporal signal `humanInterventionRequired`
- Workflow waits for human via `approveSignal` for max `manifest.escalationTimeoutMs` (default 24h); if no response, fails non-retryably with `ESCALATION_TIMEOUT`
- Does NOT block the proposal queue (§7) — that runs to completion regardless

### `analyzePacketActivity({ packetId, state, finalReview }) → Lessons`

Aggregates all findings across phases + final review. For each finding, classifies:

| Origin                                  | Classification             | Action                           |
| --------------------------------------- | -------------------------- | -------------------------------- |
| Gate output (gate-l5, gate-clamps)      | already-handled            | log only                         |
| Review-only finding (no gate caught it) | proposed-mandate-candidate | go through §7a baseline pipeline |
| Reviewer flagged but couldn't auto-fix  | architectural              | flag for human design decision   |
| Repeated across 2+ phases               | recurring                  | priority candidate for new gate  |

Outputs `.council/packets/{packetId}/lessons.md` (user reviews, accepts/rejects via §7 queue).

### `postCommitDocumentationActivity({ packetId, state, lessons }) → DocPaths`

Returns the list of doc paths it touched so the SEAL commit (Step F) includes them:

- Updates `docs/HANDOFF.md` with new commit SHA + summary
- Appends to `docs/lessons/{date}-{packetId}.md`
- Updates `docs/MEMORY.md` index if memory entries created
- Returns `{ touchedDocPaths: string[] }`

---

## 5a. SEMANTIC MANIFEST VALIDATION

`loadManifestActivity` runs these in order after Zod parse:

### `validateUniquePhaseNames(manifest)`

Set of `phase.name`. Duplicate → `DUPLICATE_PHASE_NAME` non-retryable.

### `validateNoDependencyCycles(manifest)`

Topological sort via Kahn's algorithm. If sort cannot complete (cycle) → `DEPENDENCY_CYCLE` with cycle path in error details.

### `validateDependsOnResolvable(manifest)`

For each phase, every entry of `dependsOn` must be the `name` of another phase in the manifest. Unknown dep → `UNKNOWN_DEPENDENCY` with offending dep + phase + known phase names. Defends against silent typo-induced DAG breakage where the dependency is dropped from the graph and phases run out of intended order without signal.

### `validateNoOwnedFilesOverlap(manifest)`

Build inverse index. Any path appearing in 2+ phases → `OWNED_FILES_OVERLAP` with file + conflicting phases.

Exception: Glob patterns (`**/*.ts`) require explicit `allowOverlap: true` per phase pair (rare, e.g., barrel updates).

### `validateAdrIdsResolvable(manifest)`

For each `adrId`:

1. Look up in `.council/adr-index.json` (built by adr-index-build script)
2. Verify resolved path exists on disk
3. If not found → `ADR_NOT_RESOLVABLE` with adrId + searched paths

### `validateNoForbiddenGateNames(manifest)`

Whitelist of gate names: `typecheck, biome, gate-clamps, gate-l5, dep-check, dead-code, tests, gate-perf, gate-quorum`. (`gate-perf` is the §15.10 performance-budget gate; `gate-quorum` is the §15.6 hallucination cross-check gate.) Any other → `UNKNOWN_GATE` with offending name + whitelist.

### `validateBuilderReviewerCrossFamily(manifest)`

For each phase: builder family ≠ reviewer family AND builder family ≠ secondaryReviewer family. Family map: `{claude, codex, gemini, fresh-claude (=claude)}`. Same-family cross-review → `CROSS_FAMILY_VIOLATION`.

### `validateContextBudgetReasonable(manifest)`

`maxLines` between 100-500. `maxTokens` between 2000-16000. Mismatched → `BAD_CONTEXT_BUDGET`.

---

## 5b. TWO-PASS AUDIT (per SPEC §18.6)

Each phase exit (after gates pass) requires TWO independent reviews:

### Primary review

- Reviewer: `phase.reviewer` (e.g., `claude`)
- Rubric: `L5-HOSTILE-REVIEW-RUBRIC` (14 dimensions)
- Input: committed diff + owned files + manifest path
- Output: structured findings + verdict

### Secondary missed-dimensions audit

- Reviewer: `phase.secondaryReviewer` (e.g., `claude-deep-audit` — same model, DIFFERENT prompt)
- Rubric: `L5-MISSED-DIMENSIONS-AUDIT` (covers 12 specific failure classes the primary often misses: determinism, idempotency depth, races, resource leaks, observability, spec-literal compliance, chaos coverage, doc drift, etc. — per `feedback_audit_dimensions_codex_misses.md`)
- Input: committed diff + owned files + **primary review's findings array** (so it doesn't duplicate; focuses on what's missing)
- Output: additional structured findings + verdict

**Either review yielding ANY P0 or P1 → fix-loop triggered.** No "primary said pass, secondary said fail, override" — both are gates.

This is non-negotiable per SPEC §18.6:

> "Phase-exit audit is two passes. Primary deep audit. Secondary missed-dimensions audit. Either P0 or P1 fails the phase."

---

## 5c. TRACKING FILE PROTOCOL (gemini G2 — for ephemeral spawn §13)

Storage location: `.zer0/runs/{runId}/agents/{phase}/{attempt}/`.

### Files per spawn

| File             | Purpose                                                                 | Schema                         | Size budget             |
| ---------------- | ----------------------------------------------------------------------- | ------------------------------ | ----------------------- |
| `current.json`   | Current state — what THIS spawn needs to read                           | `CurrentStateSchema` (Zod)     | ≤200 lines              |
| `history.ndjson` | Append-only event log of all decisions/findings/handoffs in this run    | `EventSchema[]` (one per line) | unbounded (compactable) |
| `result.json`    | This spawn's output — diff path, structured findings, completion status | `ResultSchema`                 | ≤500 lines              |
| `claims.json`    | Idempotency claims this spawn made (decisions it owns)                  | `DecisionRecord[]`             | ≤100 lines              |

### Schema sketches (final shapes in packet-11b)

```typescript
// CurrentStateSchema
const CurrentStateSchema = z.object({
  runId: z.string().min(1),
  phase: z.string().min(1),
  attempt: z.number().int().nonnegative(),
  ownedFiles: z.array(z.string()).min(1),
  forbiddenFiles: z.array(z.string()),
  adrSummaries: z.array(
    z.object({
      adrId: z.string(),
      decision: z.string(), // 1-3 sentences
      consequences: z.array(z.string()).max(5),
    }),
  ),
  unresolvedFailures: z.array(AttemptFailureSchema).max(10),
  contextFingerprint: z.string().length(64),
});

// ResultSchema
const ResultSchema = z.object({
  status: z.enum(["DONE", "BLOCKED", "FAILED"]),
  diffPath: z.string().optional(),
  filesTouched: z.array(z.string()),
  reasoning: z.string().max(2000),
  blockReason: z.string().optional(),
  exitCode: z.number().int(),
  durationMs: z.number().int(),
});

// DecisionRecord (cross-spawn coherence — codex P0 amendment 3)
const DecisionRecordSchema = z.object({
  decisionId: z.string().uuid(),
  scope: z.array(z.string()), // file paths affected
  consumers: z.array(z.string()), // future spawn names that depend on this
  invalidationRules: z.array(z.string()).max(5),
  decidedAt: z.number().int(),
  decidedBy: z.string(), // spawn fingerprint
  decision: z.string().max(1000),
});
```

### Compaction (codex P0 amendment 2)

When `history.ndjson` exceeds 1MB:

1. `compactTrackingFileActivity` reads all events
2. Aggregates by phase: latest decision per scope, dropped intermediate logs
3. Writes archive to `.zer0/runs/{runId}/agents/{phase}/{attempt}/history-archive-{timestamp}.ndjson`
4. Truncates `history.ndjson` to last 100 lines + summary header
5. Asserts content hash before/after to verify nothing essential lost

### Locking

Tracking files are written ONLY by Temporal activities (single-writer per phase/attempt). Reads are unlocked. The workflow's deterministic phase ordering prevents concurrent writes to the same path.

### Cross-spawn coherence (codex P0 amendment 3)

Any spawn that makes a design decision MUST write a `DecisionRecord` to `claims.json`. Subsequent spawns reading `current.json` see a `decisionIndex` field listing recent decisions in scope. The workflow's `prepareContextActivity` filters decisions to those affecting the current phase's owned files.

---

## 6. SIGNALS + QUERIES

While workflow runs, the user can:

- `zer0 status <runId>` → workflow.query → returns current phase, attempt count, elapsed time, commits so far, recent findings
- `zer0 stream <runId>` → NDJSON tail of events table for that run
- `zer0 approve <runId> <fixId>` → workflow.signal → unblocks paused fix-loop awaiting human approval (semi/full mode)
- `zer0 reject <runId> <fixId>` → workflow.signal → forces fix-loop to retry instead of accepting
- `zer0 mode <runId> {auto|semi|full}` → workflow.signal → changes human-in-the-loop level mid-run
- `zer0 cancel <runId>` → workflow.signal → graceful shutdown, persists state, releases lease, exits
- `zer0 lease release <packetId>` → CLI-direct (not workflow signal) — manual lease cleanup if workflow died unexpectedly

---

## 7. SELF-IMPROVEMENT LOOP (with proposal queue — P1-12 fix)

After each packet's `analyzePacketActivity`, proposed mandates do NOT block workflow completion. They go into a queue:

### Queue mechanics

`.council/proposed-mandates/` directory:

```
.council/proposed-mandates/
├── pending/
│   ├── 2026-05-08-packet-10-G5-ulid-not-uuid.md
│   ├── 2026-05-08-packet-10-G6-execa-no-shell.md
├── accepted/
│   └── 2026-05-06-packet-10-G1-test-coverage.md
├── rejected/
│   └── 2026-05-06-packet-09-X1-rejected-too-broad.md
```

Each proposed mandate file:

```markdown
# Proposed mandate: {id} {slug}

## Originating packet

{packetId}

## Originating finding

File: {file}:{line}
Severity: {P0|P1|P2}
Description: {what was wrong}

## Mechanical check (the actual gate code)

\`\`\`javascript
// To be added to scripts/gate-l5-mandates.mjs
function checkUlidNotUuid(files) {
// ... grep / AST query that catches this finding
}
\`\`\`

## Baseline impact (§7a result)

- Files violating new mandate today: {count}
- Files in user repos (sampled): {count}
- False-positive sample: {3 examples that LOOK like violations but aren't}

## Conflict check

- Does any existing G\* mandate contradict? {yes/no + which}

## Proposed status

PENDING (awaiting user accept/reject via `zer0 mandates review`)
```

### CLI command

```
zer0 mandates review                    # opens TUI to walk through pending proposals
zer0 mandates accept G5                 # accepts; gate added to gate-l5-mandates.mjs; file moved to accepted/
zer0 mandates reject G5 --reason "..."  # rejects; file moved to rejected/ with reason
zer0 mandates list                      # shows pending count + summary
```

### Invariant: queue does not block packet sealing

The packet workflow seals as DONE regardless of queue state. Mandates are reviewed asynchronously by the user. This prevents human escalation deadlock (P1-12).

---

## 7a. MANDATE BASELINE + ROLLOUT (P1-13 fix)

Every proposed mandate goes through this pipeline before becoming a real gate:

### Step 1: Baseline run

```typescript
async function baselineMandate(
  mandateCheckFn: GateCheckFn,
): Promise<BaselineResult> {
  const allFiles = await glob("src/**/*.{ts,mjs}");
  const violations = await mandateCheckFn(allFiles);
  return {
    fileCount: allFiles.length,
    violationCount: violations.length,
    sampleViolations: violations.slice(0, 10),
  };
}
```

If baseline shows >5 violations on existing code, the mandate cannot be accepted as-is. Options:

- (a) Refine the check (tighter pattern match)
- (b) Mark existing violations as grandfathered (`.council/grandfathered-violations.json`) — gate ignores them, only catches new ones
- (c) Require remediation before acceptance (orchestrator fixes existing violations in next packet)

### Step 2: False-positive sample

User must provide 3 examples of code that LOOKS like violations but isn't. Run check function on these — must return zero. Prevents over-eager mandates.

### Step 3: Conflict check

Static analysis: does new mandate's regex / AST query overlap with any existing mandate? If yes, document interaction (which fires first, are they redundant, do they contradict).

### Step 4: Sunset clause (optional)

If mandate is incident-specific (one packet's lesson), include `expiresAt` field. After date, mandate is auto-deprecated unless user re-affirms.

---

## 8. WHAT THIS DOES NOT FIX (honest)

1. **Workflow code itself can have bugs.** Bad workflow = bad builds. We iterate on the workflow itself like any other code, with the same gates.
2. **Cross-family review still needed.** Mechanical gates can't catch semantic gaps (architecture, judgment, "this design is wrong"). Two-pass audit (§5b) ensures cross-family.
3. **New failure modes will surface.** That's the point of the self-improvement loop (§7).
4. **Agent hallucinations within a phase.** Caught by review activity; not eliminated.
5. **Cost overhead.** Workflow has per-activity Temporal latency. Each phase has a context payload. With ephemeral spawns + prompt caching: realistic +20-40% token cost vs baseline single-dispatch (codex review's estimate; v1's +10-20% claim was unverified). Wall-clock +30-50% vs single dispatch. Worth it for the quality + reliability.
6. **Sycophancy still exists in agent outputs.** Banned-phrases gate catches it; doesn't eliminate it.
7. **Workflow versioning still requires care.** `patched()` lets in-flight workflows survive code changes, but new patches need testing on both branches (§4c).
8. **Cancellation cleanup is best-effort.** If worker is killed -9 mid-cancel, lease may not release. Manual `zer0 lease release <packetId>` recovery exists.

---

## 9. IMPLEMENTATION PATH (v2)

### Packet-10 (current, fix-loop pending)

- Hand-cranked dispatch model
- Demonstrates G1-G4 mandates work (32 violations caught in build)
- Fix-loop scoped at §10 packet-10-fix-loop-1-brief

### Packet-11 — SPLIT into 4 sub-packets (codex P1-14 fix)

Original v1 estimate: 10-15 files, 1500 lines, 1-2 fix-loops.
v2 codex realistic estimate: **28-40 files, 3000-4500 lines, 2-4 fix-loops**.

Split rationale: each sub-packet is a self-contained boundary that can be reviewed and sealed independently. If sub-packet 11a passes review but 11b needs another fix-loop, 11a stays sealed.

#### packet-11a — Manifest + Preflight + Idempotency Foundation

- `src/temporal/manifest/` — schema.ts, schema.test.ts, loader.ts, loader.test.ts, semantic-validators.ts (5 validators × 2 test files), index.ts
- `src/evidence/dispatch-claims.ts` (new SQLite table + CRUD), `commit-intents.ts`
- Schema migration to v4 (adds dispatch_claims + commit_intents)
- `.council/adr-index.json` builder script
- Estimated: 12-15 files, 1100-1400 lines

#### packet-11b — Activities (Prepare + Run-Gates + Review + Tracking-Files)

- `src/temporal/activities/prepare-context.ts` + tests
- `src/temporal/activities/run-gates.ts` (per-gate sub-activity dispatcher) + tests
- `src/temporal/activities/dispatch-review.ts` + tests
- `src/temporal/activities/generate-fix-brief.ts` + tests
- `src/temporal/activities/revert-commit.ts` + tests
- `src/observability/tracking/` — schemas (CurrentState, Result, DecisionRecord), writer, reader, compactor + tests
- Estimated: 14-18 files, 1400-1800 lines

#### packet-11c — Workflow Orchestration + Lease + Cancellation

- `src/temporal/workflows/build-packet.ts` (the main workflow)
- `src/temporal/workflows/build-packet.test.ts` (replay + cancel + signal tests)
- `src/temporal/workflows/patches.ts` (versioning §4c)
- `src/temporal/workflows/patches.test.ts`
- `src/cli/lease.ts` + tests (repo lease management)
- `src/temporal/activities/escalate.ts` + tests
- `src/temporal/activities/analyze-packet.ts` + tests
- `src/temporal/activities/post-commit-documentation.ts` + tests
- Estimated: 8-10 files, 800-1200 lines

#### packet-11d — CLI + Signals + Chaos Tests

- `src/cli/commands/build.ts` (`zer0 build <packet-id>`) + tests
- `src/cli/commands/cancel.ts` + tests (signal dispatch)
- `src/cli/commands/approve.ts` + tests
- `src/cli/commands/mandates.ts` (review/accept/reject TUI) + tests
- `tests/integration/build-packet-chaos.test.ts` — worker-crash, DB-lock, network-partition, force-kill, version-drift scenarios
- Estimated: 6-8 files, 500-700 lines

### Packet-12+

- Phase-2 brain pieces (Intent Compiler, Context Compiler, 11 missing activities)
- Each is dispatched THROUGH `buildPacketWorkflow`
- No more hand-cranking. Each new packet is `zer0 build packet-N`.
- Self-improvement loop active from packet-12 onward
- Lessons accumulate, gates grow, system gets smarter

### Packet-13 (proposed)

- Activity memoization (gemini G3) — `runGatesActivity` and `prepareContextActivity` cached by input hash
- OpenTelemetry distributed tracing (gemini G4) — already partially in packet-10 scope
- Delta-aware gates (P1-9) — pre-existing failures don't trap unrelated phases

### Packet-15+ (deferred)

- Council UX (chat REPL, multi-agent debate) per ADR-010 deferral
- MCP server per ADR-002 deferral
- Parameterized phases (gemini G5)

---

## 10. FILE LAYOUT FOR PACKET-11 (v2 — split across 11a/11b/11c/11d)

```
src/temporal/
├── workflows/
│   ├── pipeline.ts                              # existing legacy (kept for compat, deprecated)
│   ├── build-packet.ts                          # 11c — buildPacketWorkflow
│   ├── build-packet.test.ts                     # 11c — replay + cancel + signal tests
│   ├── patches.ts                               # 11c — workflow versioning (§4c)
│   ├── patches.test.ts                          # 11c
│   └── index.ts                                 # barrel
├── activities/
│   ├── dispatch.ts                              # existing — dispatchAgentActivity (extended for claim keys)
│   ├── dispatch.test.ts                         # existing (extended)
│   ├── evidence.ts                              # existing
│   ├── gate.ts                                  # existing — replaced by run-gates.ts in 11b
│   ├── prepare-context.ts                       # 11b NEW
│   ├── prepare-context.test.ts                  # 11b
│   ├── run-gates.ts                             # 11b NEW (per-gate sub-activity dispatcher)
│   ├── run-gates.test.ts                        # 11b
│   ├── dispatch-review.ts                       # 11b NEW
│   ├── dispatch-review.test.ts                  # 11b
│   ├── generate-fix-brief.ts                    # 11b NEW
│   ├── generate-fix-brief.test.ts               # 11b
│   ├── revert-commit.ts                         # 11b NEW
│   ├── revert-commit.test.ts                    # 11b
│   ├── escalate.ts                              # 11c NEW
│   ├── escalate.test.ts                         # 11c
│   ├── analyze-packet.ts                        # 11c NEW
│   ├── analyze-packet.test.ts                   # 11c
│   ├── post-commit-documentation.ts             # 11c NEW
│   ├── post-commit-documentation.test.ts        # 11c
│   └── index.ts                                 # barrel (extended)
└── manifest/
    ├── schema.ts                                # 11a NEW — ManifestSchema (Zod) + types
    ├── schema.test.ts                           # 11a
    ├── loader.ts                                # 11a NEW — loadManifestActivity
    ├── loader.test.ts                           # 11a
    ├── semantic-validators.ts                   # 11a NEW — 6 validators (§5a)
    ├── semantic-validators.test.ts              # 11a
    └── index.ts                                 # barrel

src/observability/tracking/                       # 11b NEW — tracking file protocol (§5c)
├── schemas/
│   ├── current-state.ts
│   ├── current-state.test.ts
│   ├── result.ts
│   ├── result.test.ts
│   ├── decision-record.ts
│   └── decision-record.test.ts
├── writer.ts
├── writer.test.ts
├── reader.ts
├── reader.test.ts
├── compactor.ts
├── compactor.test.ts
└── index.ts

src/evidence/
├── dispatch-claims.ts                           # 11a NEW (CRUD for dispatch_claims table)
├── dispatch-claims.test.ts                      # 11a
├── commit-intents.ts                            # 11a NEW (CRUD for commit_intents table)
├── commit-intents.test.ts                       # 11a
└── schema.sql                                   # MIGRATED to v4 in 11a

src/cli/
├── lease.ts                                     # 11c NEW (repo lease management)
├── lease.test.ts                                # 11c
└── commands/
    ├── build.ts                                 # 11d NEW — `zer0 build <packet-id>`
    ├── build.test.ts                            # 11d
    ├── cancel.ts                                # 11d NEW
    ├── cancel.test.ts                           # 11d
    ├── approve.ts                               # 11d NEW
    ├── approve.test.ts                          # 11d
    ├── mandates.ts                              # 11d NEW (review/accept/reject TUI)
    └── mandates.test.ts                         # 11d

scripts/
└── adr-index-build.mjs                          # 11a NEW — generates .council/adr-index.json

tests/integration/
├── build-packet-happy.test.ts                   # 11d NEW
├── build-packet-fix-loop.test.ts                # 11d NEW
├── build-packet-chaos.test.ts                   # 11d NEW (worker crash, DB lock, network)
└── build-packet-cancel.test.ts                  # 11d NEW

.council/packets/
└── packet-11a/                                  # the FIRST manifest, hand-written
    ├── manifest.yaml
    ├── canonical-brief.md
    └── phase-X-result.md (one per phase)
```

**Total file count by sub-packet:**

| Sub-packet | New TS/MJS files | New test files | New SQL/YAML/MD | Total  |
| ---------- | ---------------- | -------------- | --------------- | ------ |
| 11a        | 7                | 7              | 3               | **17** |
| 11b        | 11               | 11             | 0               | **22** |
| 11c        | 8                | 8              | 0               | **16** |
| 11d        | 5                | 9              | 1               | **15** |
| **Sum**    | **31**           | **35**         | **4**           | **70** |

(Codex's 28-40 file estimate was per-sub-packet bottom-bound. Cumulative is higher because tests are 1:1 with implementations per L5 mandate G1.)

---

## 11. THE QUESTION FOR FUTURE-CLAUDE READING THIS

If you're picking this up after compact OR in a future session, the question is:

**Is buildPacketWorkflow already implemented?**

- Check: `test -f src/temporal/workflows/build-packet.ts && test -f src/cli/commands/build.ts`
- If YES → skip to packet-12+; use `zer0 build` for next packets
- If NO → packet-11a is the next build. Hand-crank it ONE last time using current dispatch.sh + manual gates. Reference this document + `.council/templates/BUILD-BRIEF-TEMPLATE.md` to write the canonical brief.

**Source-of-truth files:**

- This document (`docs/ARCHITECTURE-buildPacketWorkflow.md`)
- `docs/adrs/_system/ADR-S-001-workflow-enforced-discipline.md` (the architectural decision)
- `memory/feedback_workflow_enforces_discipline.md` (the principle for future sessions)
- `docs/HANDOFF.md` (current state, post-compact resume)
- `.council/cross-model/buildpacketworkflow-codex-review-result.md` (the hostile review that drove v2)
- `.council/cross-model/buildpacketworkflow-gemini-review-result.md` (the synthesis review)

---

## 12. DECISION LOG

| Date       | Decision                                               | Rationale                                                                                                                 |
| ---------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| 2026-05-06 | Hand-crank ends with packet-11                         | Self-application: zer0 builds zer0 with zer0. After packet-11d, workflow handles all dispatches.                          |
| 2026-05-06 | Manifest YAML over JSON                                | Comments allowed, more readable for the canonical packet declaration.                                                     |
| 2026-05-06 | Phase fix-loop max = 3                                 | Matches existing pattern (packet-08 went through 4 fix-loops; 3 + escalation seems right balance).                        |
| 2026-05-06 | Final reviewer = fresh-claude-l5                       | Independent eyes, no orchestrator memory bias, applies full 14-dim rubric.                                                |
| 2026-05-06 | Self-improvement loop in `analyzePacketActivity`       | User accepts/rejects proposed mandates; queued (P1-12) so it never blocks packet sealing.                                 |
| 2026-05-06 | Codex sub-agent spawning DEFERRED until empirical test | Capability test was inconclusive (quota cap). Phase-split at orchestrator layer is the chosen architecture regardless.    |
| 2026-05-08 | v2 council ratification: 5 P0 + 8 P1 + 5 G accepted    | Codex hostile + gemini synthesis review of v1. SPEC §18 alignment + idempotency + cancellation closed.                    |
| 2026-05-08 | Ephemeral-spawn promoted from amendment to canonical   | Both reviewers ENDORSE-WITH-AMENDMENTS. Codex's 5 amendments incorporated as §13 amendments + §5c tracking-file protocol. |
| 2026-05-08 | Packet-11 split into 4 sub-packets (11a/11b/11c/11d)   | Codex realistic estimate is 28-40 files vs v1's 10-15. Self-contained boundaries reduce blast radius of fix-loops.        |
| 2026-05-08 | Two-pass audit per phase exit (primary + missed-dim)   | SPEC §18.6 explicit. Single-pass review violates spec.                                                                    |
| 2026-05-08 | Commit BEFORE review (packet-sealed-gate)              | SPEC §18 packet-sealed-gate + reviewer isolation. v1 had reviewer reading builder context — violates SPEC §173-180.       |
| 2026-05-08 | Workflow versioning via `patched()`                    | Live updates without breaking in-flight runs (gemini G1).                                                                 |

---

## 13. CANONICAL PROTOCOL — EPHEMERAL-SPAWN-PER-ACTIVITY

**Status:** CANONICAL 2026-05-08 (was PROPOSED in v1 §13). Both reviewers ENDORSE-WITH-AMENDMENTS. All 5 codex amendments and gemini's tracking-file protocol incorporated.

### The model

Every LLM-using activity uses **ephemeral spawn per call**. Each spawn:

1. Loads ONLY a focused tracking file as input (`current.json`, ≤200 lines per §5c)
2. Performs ONE task with claim-key idempotency
3. Writes output to `result.json` + appends event to `history.ndjson` + records decisions in `claims.json`
4. Exits — no persistent agent context across calls

The orchestrator is **Temporal workflow code** (deterministic, no LLM, no context window to corrupt). All "tribal knowledge" lives in tracking files + Temporal workflow state. No long-lived LLM session.

### Why canonical

Long-lived LLM sessions accumulate failure modes:

- Context window fills with old reasoning that biases new decisions
- Sycophancy compounds over conversations
- Stale task context bleeds into new tasks
- "I already considered X" memory blocks revisiting from fresh angle
- Compaction loses information unpredictably
- Failure modes are hidden in chat state — not replayable

Ephemeral spawn eliminates ALL of these by construction. Each LLM call starts blank, focused on its specific task input file. Failures become file-mediated and replayable.

### Industry validation (gemini synthesis cited)

| Pattern                   | System                                       | Lesson adopted                                                                    |
| ------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------- |
| Actor model               | Erlang/OTP, Akka                             | "Let it crash" — supervisor (Temporal) handles retry; actors (spawns) stay simple |
| Stateless compute         | AWS Lambda + S3, Cloud Functions + Firestore | Versioned schema for state passed between functions (§5c)                         |
| Multi-agent orchestration | AutoGen Tasks, CrewAI                        | Task isolation per spawn                                                          |
| Constitutional AI         | Anthropic                                    | Multi-round debate with file-mediated handoff                                     |

### Council patterns enabled

- **Debate workflow** (3 rounds default; codex amendment 4 caps at 3 with escalation rule for P0/P1 disagreement): round 1 independent takes → round 2 responses → round 3 synthesis. Each round = parallel ephemeral spawns reading shared `current.json` + `claims.json`.
- **Vote workflow:** spawn N voters, each reads proposal, writes vote to `result.json`, workflow tallies.
- **Pair-programming workflow:** architect spawn (writes spec to `claims.json` decisions) → implementer spawn (reads spec, writes code) → reviewer spawn (reads both, writes review).

### Codex's 5 required amendments (incorporated)

1. **Tracking-file protocol formal** (§5c) — Zod schemas for `current.json`, `history.ndjson`, `result.json`, `claims.json`. Storage at `.zer0/runs/{runId}/agents/{phase}/{attempt}/`.

2. **Current-state vs archive separation** (§5c) — `current.json` has hard ≤200-line budget + typed fields. `history.ndjson` is append-only, compacted by `compactTrackingFileActivity` when >1MB. Compaction asserts before/after content hashes.

3. **Cross-spawn coherence** (§5c) — `DecisionRecord` written to `claims.json` for any design decision. `prepareContextActivity` filters relevant decisions into next spawn's `current.json`.

4. **Debate cap = 3 rounds** with escalation — unresolved P0/P1 disagreement after 3 rounds triggers human escalation (§7 queue).

5. **Sustained-context exception** — bounded `sessionGroup` activity for multi-file refactors needing consistent style:
   - Same focused `current.json` file
   - Same worktree lease
   - Fixed max duration (e.g., 30 min)
   - Mandatory `result.json` handoff at end
   - Used SPARINGLY — most tasks should be ephemeral

### Cost reality check

Cold-start tax with prompt caching (Claude 5-min TTL, OpenAI 10-min):

- v1 estimated +10-20% (unverified)
- Codex review estimated **+20-40%** (more believable; verified against published benchmark data)
- Net: pay ~30% more tokens for: (a) zero context corruption; (b) fully replayable failures; (c) parallelism opportunities

### What stays unchanged

- Manifest YAML format (§3)
- 9 activity contracts (§5) in NAME and INPUT/OUTPUT
- Self-improvement loop (§7)
- Mechanical gates
- Cross-family review

### What changes

- `dispatchAgentActivity` reads `current.json` + writes `result.json` (no inline prompt mutation)
- Tracking file format is formal (§5c)
- New activity `compactTrackingFileActivity` (history → archive)
- Council patterns become Temporal child workflows that compose ephemeral spawns

---

## 14. COUNCIL FINDINGS DISPOSITION

Every finding from `buildpacketworkflow-codex-review-result.md` and `buildpacketworkflow-gemini-review-result.md` is logged here with a disposition.

### Codex P0 findings

| #    | Title                                   | Disposition | Where addressed                                                                   |
| ---- | --------------------------------------- | ----------- | --------------------------------------------------------------------------------- |
| P0-1 | Duplicate runs corrupt worktree         | ACCEPTED    | §2 CLI workflow ID + §4a lease + duplicate-run check                              |
| P0-2 | Review-before-commit violates SPEC      | ACCEPTED    | §4 Step C.4 (commit) before C.5 (review); §5b reviewer never sees builder context |
| P0-3 | LLM dispatch idempotency incomplete     | ACCEPTED    | §4a claim keys + dispatch_claims table                                            |
| P0-4 | Cancellation is a signal not a protocol | ACCEPTED    | §4b heartbeat + abort + cleanup contracts                                         |
| P0-5 | Manifest semantic validation missing    | ACCEPTED    | §5a — 6 semantic validators                                                       |

### Codex P1 findings

| #     | Title                                         | Disposition | Where addressed                                                                                                                        |
| ----- | --------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| P1-6  | One review pass vs SPEC two-pass              | ACCEPTED    | §5b primary + secondary missed-dimensions audit                                                                                        |
| P1-7  | runGatesActivity too large                    | ACCEPTED    | §5 per-gate sub-activity dispatcher with own timeouts/maxBuffer                                                                        |
| P1-8  | Shell syntax in gate commands                 | ACCEPTED    | §5 gate table — execa with args arrays                                                                                                 |
| P1-9  | Baseline failures trap unrelated phases       | DEFERRED    | Packet-13 (delta-aware gates). Mitigation: §5 baseline captured but not enforced; v2 mandates user accepts violations or grandfathers. |
| P1-10 | DONE commit ordering leaves docs outside seal | ACCEPTED    | §4 Step E (lessons + docs) BEFORE Step F (seal)                                                                                        |
| P1-11 | Fix-loop attribution underspecified           | ACCEPTED    | §4 `AttemptFailure[]` structured + repeat marker; §5 `prepareContextActivity` filters unresolved-only                                  |
| P1-12 | Human escalation deadlock                     | ACCEPTED    | §7 proposal queue does not block packet sealing; `zer0 mandates review` async                                                          |
| P1-13 | Mandates can break existing code              | ACCEPTED    | §7a baseline + grandfathered + false-positive sample pipeline                                                                          |
| P1-14 | Packet-11 estimate too low                    | ACCEPTED    | §9 split into 11a/11b/11c/11d; new estimate 28-40 files cumulative ~70                                                                 |

### Codex P2 findings

| #    | Title                                       | Disposition | Where addressed                                                                                              |
| ---- | ------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------ |
| P2-1 | adrIds path vs ID ambiguity                 | ACCEPTED    | §3 manifest uses IDs resolved via `.council/adr-index.json`; §5a validates resolution                        |
| P2-2 | Model/tool fingerprinting                   | ACCEPTED    | §5 `dispatchAgentActivity` returns `{modelVersion, adapterVersion, cliVersion}`; §4a dispatch_claims columns |
| P2-3 | 300-line cap can delete binding constraints | ACCEPTED    | §5 `prepareContextActivity` step 10 + §3 manifest `mustNotOmit` sections                                     |
| P2-4 | state.findings never appended               | ACCEPTED    | §4 Step C accumulates failures; §5 review/gate output flows back into state                                  |

### Gemini priorities

| #   | Title                             | Disposition | Where addressed                                                                         |
| --- | --------------------------------- | ----------- | --------------------------------------------------------------------------------------- |
| G1  | Workflow versioning               | ACCEPTED    | §4c `patched()` API                                                                     |
| G2  | Tracking-file Zod schema          | ACCEPTED    | §5c canonical                                                                           |
| G3  | Activity memoization              | DEFERRED    | §9 packet-13                                                                            |
| G4  | OpenTelemetry distributed tracing | PARTIAL     | Already in packet-10 scope (telemetry events + correlation IDs); deferred OTel exporter |
| G5  | Parameterized phases              | DEFERRED    | §9 packet-15+                                                                           |

### Codex ephemeral-spawn 5 amendments

All ACCEPTED — see §13.

### Things NOT changed (intentional)

- **3 fix-loops max per phase:** matches existing pattern; user can override per-packet via manifest.
- **Sequential phase execution within DAG order:** parallelism deferred; some phases share test DB / git index.
- **Single SQLite file for evidence:** acceptable at current scale; sharding is post-packet-15 problem.
- **Manifest in YAML, not Pkl/Cue/etc:** YAML's downsides (whitespace) outweighed by readability + ecosystem.

---

## 15. L5 PRODUCT-QUALITY ADDITIONS (locked 2026-05-08)

These cross-cutting concerns are first-class architectural commitments — not features added later, but properties the system has from packet-11 onward. Every packet must respect them.

### 15.1 Capacity tracking (subscription-default, API-mode-opt-in)

**The user's primary mode is SUBSCRIPTIONS** (Claude Pro/Max via Claude Code, ChatGPT Plus/Pro via codex CLI, Gemini Pro via gemini-cli). Dollars are not the right currency. Useful currencies are:

- **Context window utilization:** how much of the model's context window the current/next dispatch will consume (claude=1M, codex=~200k, gemini=2M)
- **Weekly/period quota:** how close the user is to their plan limit (codex shows "ERROR: usage limit, try again at 2:28 AM"; we parse this)
- **Rate-limit countdown:** when does the next reset happen
- **Multi-account context:** user may have work + personal accounts; we track per `account_id`

API-mode (dollars) is the **secondary** mode, gated by `accountType: "api"` in config. Dollar pricing tables ship versioned (`pricing_version` column) because per-token rates change.

### 15.1.1 New schema (packet-11a)

```sql
CREATE TABLE IF NOT EXISTS capacity_snapshots (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,                         -- claude | codex | gemini
  account_id TEXT NOT NULL DEFAULT 'default',  -- multi-account discriminator
  snapshot_at TEXT NOT NULL,                   -- ISO8601

  -- Subscription-mode (primary)
  context_used_tokens INTEGER,
  context_max_tokens INTEGER,
  weekly_quota_used_pct REAL,                  -- 0-1
  weekly_quota_resets_at TEXT,                 -- ISO8601 if known
  rate_limit_remaining INTEGER,
  rate_limit_resets_at TEXT,

  -- API-mode (secondary, opt-in)
  cost_usd REAL,                               -- 0 in subscription mode
  pricing_version TEXT,

  source TEXT NOT NULL                         -- 'header' | 'stderr_parse' | 'manual' | 'estimated'
);

CREATE INDEX IF NOT EXISTS idx_capacity_agent_time ON capacity_snapshots(agent, snapshot_at DESC);
```

### 15.1.2 Adapter contract extension

Each adapter must implement:

```typescript
parseCapacityFromOutput(stdout: string, stderr: string): AdapterCapacity | null;
```

Per-model parsing:

- **Codex:** detect `ERROR: You've hit your usage limit. ... try again at HH:MM`. Parse to `weeklyQuotaResetsAt`. Set `weeklyQuotaUsedPct = 1.0`.
- **Claude:** when API mode (Anthropic SDK), read `anthropic-ratelimit-tokens-remaining` / `anthropic-ratelimit-tokens-reset` headers. When subscription mode (Claude Code stdio), parse local message-count tracking against plan tier (env `ZER0_CLAUDE_PLAN=pro|max|max5x|max20x`).
- **Gemini:** parse response `usageMetadata.totalTokenCount`; quota check via free-tier vs Pro env hint.

When parsing fails, source = `'estimated'` (use `tokens_in + tokens_out` heuristic).

### 15.1.3 TUI capacity panel (packet-15)

Glance display, not numeric noise:

```
┌─ models ─────────────────────────────────────────────────────┐
│ claude   ████░░░░░░ 41% ctx · ███░░░ 32% wk · ✓ ready        │
│ codex    █░░░░░░░░░ 12% ctx · █████░ 89% wk · ⚠ resets 18:36 │
│ gemini   ██████░░░░ 63% ctx · ─────  free  · ✓ ready         │
└───────────────────────────────────────────────────────────────┘
```

### 15.1.4 Capacity-aware routing

When the workflow's `prepareContextActivity` or the TUI's slash-command router dispatches, capacity-aware checks apply:

- If `weeklyQuotaUsedPct > 0.95` for the requested model, fail-fast or fall back per `manifest.fallbackPolicy`.
- Show the user the projected impact: "this build will use ~30% of codex's weekly quota."
- API mode adds: "estimated cost: $2-5".

### 15.2 Per-model context projection (gemini-validated)

Different models have different context windows AND different prompt-style preferences. The same `current.json` cannot be sent verbatim to all three.

New activity:

```typescript
projectContextForModel(currentJson: CurrentState, target: AgentName): FocusedPayload
```

- **Claude:** XML-tagged structure (`<task>`, `<owned_files>`, `<adr>`, `<unresolved_failures>`)
- **Codex:** fenced code blocks + numbered list HARD CONSTRAINTS sections (proven pattern from `feedback_codex_brief_template_proven.md`)
- **Gemini:** structured markdown headers + explicit research framing
- **All:** truncated to fit target's context window, prioritizing `mustNotOmit` sections (§3 manifest)

This activity is referenced from `prepareContextActivity` (§5) — every dispatch goes through it.

### 15.3 Auth lifecycle in adapter contract

Adapters must implement:

```typescript
interface AdapterContract {
  // ... existing ...
  detectAuthExpiry(stderr: string): AuthExpiryStatus; // 'valid' | 'expired' | 'rate_limited' | 'unknown'
  refreshAuth(): Promise<void>; // best-effort; no-op for stdio CLIs
}
```

When `dispatchAgentActivity` detects expired auth, it:

1. Calls `refreshAuth()` (which may shell out to e.g. `claude auth login`)
2. If still failing, surfaces a `ConfigError` with clear remediation: "Run `zer0 auth claude` to refresh credentials."

### 15.4 Multi-account / project scoping

`sessions` and `runs` tables get `project_path TEXT NOT NULL` and `account_id TEXT NOT NULL DEFAULT 'default'` columns from packet-11a. The TUI exposes:

- `/cd <path>` — switches active project; reloads `.zer0/`
- `/account list` / `/account use <name>` — switch credential profile
- Cross-project search via session_events index (later)

### 15.5 OpenTelemetry exporter (pulled forward from packet-13 → packet-11c)

Earlier deferred (gemini G4). Pulling forward because retrofitting tracing into 30+ activities later is far more painful than adding it during the build.

- All workflow activities emit OTLP spans with parent-span propagation
- Span attributes: `zer0.run_id`, `zer0.phase`, `zer0.agent`, `zer0.attempt`, `zer0.gate`
- Default exporter: file (`.zer0/traces/{date}.ndjson`)
- Optional: Jaeger / Tempo / Honeycomb via env config

### 15.6 Hallucination cross-check (the differentiator)

Single-model tools cannot do this by definition. Multi-model is our unique advantage.

New optional gate (`gate-quorum`, off by default):

- For factual claims emitted by a builder, `quorumActivity` dispatches the SAME claim to the other 2 model families and asks for ENDORSE / DISAGREE / UNKNOWN with brief reasoning.
- Result attached to the dispatch: `quorumScore: 0..3` (how many endorsed).
- TUI badge: 3/3 green, 2/3 yellow, ≤1/3 red.
- User can `/raw` to skip cross-check on trusted dispatches.

This is opt-in because it triples the cost of fact-emission. Default ON for SPEC sections, ADR consequences, security-relevant claims; default OFF for code generation.

### 15.7 Approve-by-rubric (TUI surface for §5b two-pass audit)

The 14-dimension rubric isn't just a review artifact — it's user-facing. When the workflow's `dispatchReviewActivity` returns:

```
[claude] reviewed src/auth.ts — 14-dim score:
  ✓ spec-literal      ✓ types       ✓ tests
  ✓ idempotency       ✓ races       ⚠ chaos (no DB-lock test)
  ... (8 more)

1 PARTIAL. Approve anyway? [y/N/fix]
```

User responds:

- `y` → workflow continues
- `N` → workflow aborts the phase
- `fix` → fix-loop dispatches with the partial dimensions as the brief

### 15.8 Crash recovery / reattach

`zer0 sessions list` shows active workflows (via Temporal query). User picks one to reattach. TUI restores conversation state from `.zer0/sessions/{sessionId}/`.

On TUI launch with active runs detected: "Found 2 active runs. Reattach? [Y/n]"

### 15.9 Approve-the-diff before commit

In `commitActivity` (§5), before staging, emit a diff event. TUI displays:

```
[diff preview] +47 -12 across 3 files
  src/auth.ts:    +30 -8
  src/auth.test.ts: +15 -2
  docs/AUTH.md:    +2 -2

approve [Y/n/edit/reject]:
```

`edit` → opens $EDITOR on the diff for selective approval. `reject` → workflow goes to fix-loop with user's reason.

### 15.10 Performance budgets (CI-enforced)

Latencies that cannot regress beyond:

| Operation                     | Soft cap | Hard cap (CI fails) |
| ----------------------------- | -------- | ------------------- |
| `zer0 status` cold start      | 500ms    | 2s                  |
| `zer0 doctor` full check      | 5s       | 15s                 |
| TUI keypress latency          | 50ms     | 200ms               |
| Tracking-file write (atomic)  | 50ms     | 500ms               |
| Context projection per spawn  | 200ms    | 1s                  |
| Gate `gate-l5` over 130 files | 200ms    | 1s                  |

New file: `tests/performance/budgets.test.ts` runs each timed operation and asserts cap. Gate name: `gate-perf`. Added to `requiredGates` in manifests for relevant phases.

---

## 16. END-STATE TUI EXPERIENCE (locked 2026-05-08)

This is what `zer0` looks like when the system is complete. Every architectural decision serves this end state.

### 16.1 Single persistent terminal

```
$ zer0
zer0 v0.x — multi-model build assistant

> _
```

One process. One conversation. Three model adapters. Owned daemon lifecycle.

### 16.2 Solo mode AND team mode

```
> /gemini what's the latest pattern for distributed locks?
[gemini] researching... [3 sources fetched]
[gemini] (response)

> /codex apply that pattern to src/lock.ts
[codex] (working...)

> /claude review the change
[claude] (14-dim score with findings)
```

Per-message model targeting. No "switch context" friction.

### 16.3 Free model swap (the architectural win)

```
> /switch claude
default model: claude (was codex)

> /continue
[claude] reading current.json + recent decisions...
[claude] (picks up exactly where codex left off)
```

This works because state lives in `current.json` + `claims.json` (§5c), NOT in any model's session. **Ephemeral spawn is the architecture; transparent model swap is the consequence.**

### 16.4 Council patterns as first-class

```
> /debate should we use SQL or NoSQL for sessions?
[round 1: independent positions]
  [claude] argues SQL: ACID, query flexibility, ...
  [codex]  argues SQL: tooling maturity, type safety, ...
  [gemini] argues NoSQL: scale, schema flexibility, ...

[round 2: responses to each other]
  [claude → gemini's scale point] benchmarks suggest...
  ...

[round 3: synthesis]
  [synthesis] All agree on SQL for THIS scale (<1M rows). NoSQL only if you grow past 100M.
```

Pre-spec'd workflow (§13). 3-round cap. Escalation if disagreement persists.

### 16.5 Slash-command grammar (canonical)

```
/build <task>             — full workflow (auto-routes models)
/codex <prompt>           — direct dispatch (solo mode)
/claude <prompt>          — direct dispatch
/gemini <prompt>          — direct dispatch
/research <topic>         — gemini + web-search workflow
/review <commit-or-file>  — claude reviews
/debate <question>        — 3-round council
/switch <model>           — change default for unprefixed input
/status                   — active runs panel
/inspect <run-id>         — full evidence dump
/approve <fix-id>         — workflow signal
/raw                      — toggle quorum cross-check off
/save <name>              — checkpoint session
/load <name>              — resume saved session
/branch from <msg-id>     — fork conversation (time-travel)
/cd <project-path>        — switch active project
/account use <name>       — switch credential profile
/cost                     — show capacity panel (subscription-default)
/macro <name>             — invoke user-defined macro
/help                     — slash-command reference
```

### 16.6 Live capacity panel

Subscription-default (no dollars):

```
┌─ models ─────────────────────────────────────────────────────┐
│ claude   ████░░░░░░ 41% ctx · ███░░░ 32% wk · ✓ ready        │
│ codex    █░░░░░░░░░ 12% ctx · █████░ 89% wk · ⚠ resets 18:36 │
│ gemini   ██████░░░░ 63% ctx · ─────  free  · ✓ ready         │
└───────────────────────────────────────────────────────────────┘
```

### 16.7 What the user gets (vs Claude Code with extra steps)

- Free model swap mid-conversation
- Cross-family hostile review on every authoring boundary
- Council patterns (debate / vote / pair-programming)
- Hallucination cross-check via 3-model quorum
- Time-travel branches
- Session save/share for async pair-programming
- Self-improvement: every finding becomes permanent gate
- Workflow-enforced discipline (process > discipline)

### 16.8 What is NOT done in TUI scope

- Voice input (deferred indefinitely)
- Code completion / Cursor mode (different product)
- Plugin marketplace (deferred to v2.x)
- Web/desktop GUI (terminal-only is the bet)

---

## END

This document is the canonical reference for the workflow architecture. v2 is council-ratified. §15 + §16 vision-locked 2026-05-08.

When implementing packet-11 (a/b/c/d), this is the doc to follow. After packet-11d ships, every future packet flows through `zer0 build <packet-id>`.

Hand-crank dispatch ends with packet-11d. From packet-12 onward, the system runs itself.

The end-state UX (§16) is the WHY. The architecture (§4-§14) is the HOW. The L5 additions (§15) are the QUALITY BAR. All locked.
