# Zer0 Agent CI ??? Canonical Production Specification

**Version:** 6.0 (Final ??? DeepSeek V4 research integrated)
**Date:** 2026-05-03
**Status:** Canonical ??? council-approved, research-integrated, ready for Phase 1 build
**Principle:** Full production quality from day 1. Temporal is non-negotiable. No JSON state machines. No toys.
**Research integrated:** DeepSeek V4 architecture lessons (6 documents, 3-model council unanimous)

---

## 1. INVARIANTS

1. **Deterministic code controls the pipeline.** AI agents are workers, never controllers.
2. **Builder ??? Reviewer.** Different model family. Fresh instance. No memory of prior review on retry.
3. **No phase runs without prerequisites.** Enforced by Temporal workflow transitions. No exceptions.
4. **Every agent call gets fresh context.** Non-interactive CLI mode. Context Compiler assembles per-call context deterministically.
5. **Temporal owns execution state.** No JSON file is authoritative for workflow progress. SQLite owns evidence. `.council/` artifacts are human-readable projections.
6. **Every claim cites a source.** Research ??? URLs. Build ??? spec sections. Review ??? file:line.
7. **Malformed output is retriable.** Max 3 attempts, then BLOCKED + escalate.
8. **All exports have explicit return type annotations.** `isolatedDeclarations: true`. Enables ts.transpileDeclaration().
9. **Secrets never enter prompts.** Denylist + entropy scanner enforced before every dispatch.
10. **P0 findings block unconditionally.** No automated override. Human approval with logged reason.
11. **Agents submit artifacts. Gates decide completion.** No agent decides it is "done."
12. **Prompt templates are production logic.** Must pass evals (Promptfoo) like code passes tests.
13. **Evidence is content-addressed blobs, not just hashes.** Every prompt, context pack, diff, stdout, and stderr is stored.
14. **Context is a memory hierarchy, not a flat dump.** Hot (lossless) + Warm (sparse selected) + Cold (compressed global) ??? simultaneously, not as fallbacks.
15. **Every enrichment is a hypothesis.** Measured by Promptfoo. Removed if it doesn't improve outcomes after 20+ dispatches.

---

## 2. SYSTEM OVERVIEW

> "A CI/CD pipeline where the developers happen to be AI models."

Four subsystems solve four different problems:

| Subsystem              | Solves                                   | Input                                              | Output                                         |
| ---------------------- | ---------------------------------------- | -------------------------------------------------- | ---------------------------------------------- |
| **Intent Compiler**    | "What did the user mean?"                | Vibe prompt, Q&A, constraints                      | Intent Brief, vocabulary map, quality rubric   |
| **Context Compiler**   | "What should this agent know?"           | Build packet, repo map, spec, diff                 | Task-specific Context Pack (content-addressed) |
| **Prompt Quality Lab** | "Did the prompts produce better output?" | Golden prompts, graders, red-team probes           | Scores, regressions, accepted versions         |
| **Stability Monitor**  | "Is this agent trajectory failing?"      | Retry signals, findings patterns, progress metrics | Early escalation before max retries exhaust    |

### Stack

| Component       | Choice                       | Why                                                             |
| --------------- | ---------------------------- | --------------------------------------------------------------- |
| Runtime         | Node.js 22 LTS               | Stable. CLIs are Node-based.                                    |
| Language        | TypeScript 5.5+ strict       | isolatedDeclarations enables .d.ts extraction                   |
| Workflow Engine | Temporal TypeScript SDK      | NON-NEGOTIABLE. Durable execution, crash recovery, human gates. |
| AI Subgraphs    | LangGraph JS (bounded)       | Tournament fan-out/fan-in + debate/arbiter. NOT the core.       |
| Evidence        | SQLite (better-sqlite3, WAL) | Append-only ledger. FTS5. Content-addressed blob references.    |
| Blob Store      | `.zer0/blobs/{sha256}`       | Actual prompts, context packs, diffs, stdout, stderr stored.    |
| Subprocess      | execa v9                     | Windows-first. shell:false. AbortSignal. stdin pipe.            |
| Prompt Evals    | Promptfoo                    | TypeScript-native, CLI-first, multi-provider, red-teaming       |
| Testing         | vitest                       | TypeScript-native                                               |
| Linting         | Biome                        | Replaces ESLint + Prettier. 450+ rules.                         |
| Runner          | tsx                          | Zero build config.                                              |
| CLI Parsing     | process.argv (no framework)  | Zero-dependency. ~100 lines of custom routing.                  |

### Temporal: Non-Negotiable

Temporal runs via Docker locally (`docker run temporalio/auto-setup`). If Windows Docker has issues, use WSL2 + Docker. There is NO fallback to a custom state machine.

---

## 3. PIPELINE

```
INIT ??? INTENT COMPILE ??? VISION Q&A ??? RESEARCH ??? SPEC ??? ARCHITECTURE ??? PLAN ??? BUILD ??? REVIEW ??? FIX LOOP ??? FINAL AUDIT ??? SHIP
```

### Phase 0: INIT

**Agent:** None
**Action:** Create `.zer0/` scaffold, initialize SQLite, start Temporal workflow, verify CLIs
**Gate:** Database initialized. Run ID assigned. All 3 CLIs healthy. Temporal reachable.

### Phase 0b: RECON (existing projects)

**Agent:** Claude
**Action:** Scan codebase. ts.transpileDeclaration() on .ts files. Detect stack, patterns.
**Gate:** Report covers: language, framework, database, auth, test setup

### Phase 1: INTENT COMPILE

**Agent:** Claude (translating, not building)
**Action:** Raw vibe prompt ??? Intent Brief (normalized goal, vocabulary map, rubric, assumptions, research questions, risk checklist, Q&A plan, enrichment sources)
**Output:** `.council/runs/{id}/intent/` (8 files)
**Gate:** IntentBrief validates against schema. Vocabulary non-empty. Research questions exist.

### Phase 2: VISION Q&A

**Agent:** Claude (interactive)
**Action:** 8-15 questions from Intent Compiler's Q&A plan
**Gate:** All questions answered or explicitly deferred.

### Phase 3: RESEARCH

**Agents:** All 3 in parallel (Temporal activities)

- **Gemini:** Market, competitors, latest APIs
- **Codex:** GitHub repos, open-source, technical feasibility
- **Claude:** Architecture patterns, system design, edge cases

**Gate:** At least 2 of 3 reports exist. Synthesis covers: stack, architecture, risks.
**Timeout:** 5 min per agent.

### Phase 4: SPEC

**Agent:** Claude
**Action:** Full product spec. Every requirement traces to source.
**Gate:** Data model, APIs, UI, error handling, security, scale. NO placeholders.
**Cross-review:** Codex reviews for completeness.

### Phase 5: ARCHITECTURE

**Agent:** Claude
**Action:** Stack, domain model, schema, boundaries, auth, jobs, scaling, security, tests, deployment.
**Gate:** All sections present. Decisions cite research.
**Cross-review:** Codex reviews for accuracy.

### Phase 6: PLAN

**Agent:** Claude
**Action:** Decompose into build packets + `contracts.ts`.

```yaml
BUILD-030:
  implements: "spec.section.3.2"
  creates: ["src/api/users.ts"]
  modifies: ["src/api/index.ts"]
  reads: ["src/auth/service.ts"]
  contracts: ["User", "AuthService"]
  owned_files: ["src/api/users.ts", "src/api/index.ts"]
  forbidden_files: ["src/auth/*"]
  acceptance:
    - "Returns 401 for invalid token"
    - "Rate limits to 100 req/min"
  depends_on: ["BUILD-014"]
  enrichment_sources: ["authentication.yaml"]
  requirement_links: ["REQ-012"]
  sandbox_level: 1
```

**Gate:** Every requirement ??? packet. No cycles. No ownership overlap. contracts.ts compiles.

### Phase 7: BUILD

**Agent:** Codex (default, configurable)
**Action:** For each packet in dependency order:

1. Context Compiler assembles Context Pack (three-tier: Hot+Warm+Cold)
2. Domain Pattern Library injects CANDIDATE requirements (filtered by spec decisions)
3. Security filter: denylist + entropy scan
4. Dispatch to builder (Temporal Activity, timeout + retry)
5. On retry: FRESH worktree (unique name: `wt-{runId}-{agent}-{timestamp}`)
6. Ownership check: diff only touches owned files
7. Mechanical clamps: tsc strict + Biome CI + vitest + max function length + max complexity
8. Slop detection: TODO/FIXME/placeholder/`as any`/console.log
9. If gate fails ??? errors to builder ??? retry (max 2)
10. If pass ??? ts.transpileDeclaration() ??? update Build Manifest
11. Update requirement coverage: file:line ??? requirement IDs
12. Log to SQLite + store artifacts as blobs
13. **Context Prefetching:** While current task runs, pre-compile context for next independent task

**Tournament:** For high-value packets, LangGraph fans out to 2-3 agents in isolated worktrees. Arbiter evaluates: tests, lint, diff size, acceptance coverage.

### Phase 8: REVIEW

**Agent:** Claude (MUST be cross-family from builder). Fresh instance.

**What reviewer receives (Structured Rubric):**

- Spec section + acceptance criteria
- contracts.ts
- The code
- Domain Pattern Library rubric (MET/NOT_MET/UNVERIFIABLE per item)
- **NEVER:** builder's prompt, builder's reasoning, other reviewers' findings

**Scope limitation:** May ONLY flag issues violating spec, type safety, coding standards, or security. May NOT request features or alternative approaches.

**Output schema (Zod-validated):**

```typescript
interface RubricReviewOutput {
  verdict: "PASS" | "FAIL" | "PASS_WITH_COMMENTS";
  rubricResults: Array<{
    id: string;
    status: "MET" | "NOT_MET" | "UNVERIFIABLE";
    evidence: string;
  }>;
  additionalFindings: Finding[];
  categoriesChecked: string[];
}
```

**Gate:** Zero P0. P1 ??? threshold (default 5). Max 3 fix rounds.
**Finding-Inflation Clamp:** >15 findings from one review ??? 25% confidence discount.

**Fix Loop ??? Blind Retry Protocol:**

1. **Blind AI Review:** Reviewer gets FRESH context (current code + spec + rubric). NO prior findings. NO knowledge this is iteration 2+. Fresh hostile review.
2. **Mechanical Fix Verifier:** Deterministic grep/diff check that prior P0 patterns cited at specific file:line are actually changed.

**Escalation:** Same finding 2+ times ??? architectural issue. >10 P1 ??? brief insufficient. Both ??? user.

### Phase 9: FINAL AUDIT

**Agent:** None (deterministic)
**Action:** Requirement coverage matrix: every requirement has file:line + test evidence.
**Gate:** 100% coverage. All tests pass. No open P0/P1.

### Phase 10: SHIP

**Action:** Ship report. Options: merge, PR, keep branch, discard.
**Gate:** Human approval required.

---

## 4. STATE MODEL (Three-Layer Truth)

| Layer                      | Purpose                                      | Authoritative For                    |
| -------------------------- | -------------------------------------------- | ------------------------------------ |
| **Temporal event history** | What ran, retried, failed, resumed, approved | Workflow progress, phase transitions |
| **SQLite evidence ledger** | Prompts, context hashes, findings, gates     | Audit trail, forensics, queries      |
| **`.council/` artifacts**  | Vision, spec, plan, decisions                | Human review surface                 |

**No pipeline.json.** Temporal IS the state. `zer0 status` queries Temporal.

**Blob Store:** `.zer0/blobs/{sha256-first-2}/{sha256}` ??? every prompt, context pack, diff, stdout, stderr.

---

## 5. LONG-HORIZON AGENT MEMORY MODEL

Context selection uses a simultaneous three-tier memory hierarchy. All tiers in EVERY context pack ??? NOT sequential fallbacks.

| Tier     | Analogue                  | Content                                                                                     | Rule                                                |
| -------- | ------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **Hot**  | DeepSeek Sliding Window   | Files being modified, current diff, failing output, acceptance criteria, human corrections  | NEVER summarize. NEVER omit.                        |
| **Warm** | DeepSeek CSA (top-K)      | .d.ts of top-K scored dependencies, related tests, prior findings, stack-trace-linked files | Selected by dual-signal scoring. Budget controls K. |
| **Cold** | DeepSeek HCA (attend-all) | ALL project file names + 1-line export summaries, architecture summary, spec summary        | ALWAYS included. ~5-10K tokens for 500 files.       |

**Design principle:** At sufficient compression, include-everything is cheaper than selective retrieval. Cold tier costs 3-7% of budget and provides whole-project awareness.

**Anti-pattern ??? Context Inflation:** Agent produced bad output ??? DON'T expand budget. DO replace lowest-scored items with the specific missing piece.

---

## 6. CONTEXT COMPILER

### Architecture: SELECTION ??? COMPRESSION ??? ASSEMBLY ??? COST

### Context Indexer: Dual-Signal Scoring

Files scored by `relevance ?? importance` (multiplicative, not additive). Neither signal alone is sufficient.

```typescript
function scoreFile(
  file: string,
  task: BuildTask,
  manifest: BuildManifest,
): number {
  const relevance =
    (task.modifies.includes(file) ? 150 : 0) +
    (task.reads.includes(file) ? 100 : 0) +
    importGraphHops(file, task.creates, manifest) * 25 +
    symbolOverlap(file, task.contracts) * 30 +
    (recentFailureInFile(file) ? 40 : 0) +
    (inStackTrace(file) ? 60 : 0);

  const importance =
    exportCount(file, manifest) * 0.5 +
    (isSharedContract(file) ? 2.0 : 1.0) +
    dependentCount(file, manifest) * 0.3;

  return Math.max(0, relevance) * importance;
}
```

**Phase 1:** `importance = 1.0` for all files. **Phase 2+:** Real scoring.

### Compression

**TypeScript:** `ts.transpileDeclaration()` ??? 1-5ms/file, 6-20x savings.
**Non-TypeScript:** `.sql` ??? schema, `.yaml/.json` ??? keys, `.css` ??? classes, `.md` ??? headers, Other ??? head/tail.

### Assembly: 6-Layer Prompt (attention-curve aware)

| Layer                       | Position | Attention | Content                                                           |
| --------------------------- | -------- | --------- | ----------------------------------------------------------------- |
| 1. Static prefix            | 0-15%    | HIGH      | Quality floor, anti-skeleton, output schema                       |
| 2. Project contract         | 15-30%   | HIGH      | contracts.ts, architecture decisions                              |
| 3. Task brief               | 30-40%   | MEDIUM    | Objective, acceptance, owned/forbidden, **next 2 task lookahead** |
| 4. Repo context (Cold+Warm) | 40-60%   | LOW       | ALL file names (Cold) + .d.ts of top-K deps (Warm)                |
| 5. Evidence pack (Hot)      | 60-90%   | MEDIUM    | Full source of edit targets, tests, findings                      |
| 6. Endcap                   | 90-100%  | HIGH      | Thoroughness demand + task repeat + blocked instruction           |

**Layer 3 Multi-Token Lookahead:**

```markdown
## FORWARD CONTEXT (interface design only ??? do NOT implement)

Next consumers of YOUR output:

- BUILD-006: Role-based access (will consume AuthService.getUserRoles())
- BUILD-007: Team invites (will consume AuthService.validateInviteToken())
```

**Layer 6 Endcap (Think Max equivalent):**

```markdown
## FINAL VERIFICATION (before you output ANYTHING)

1. Count acceptance criteria above. Address ALL ??? not "most."
2. For EACH, verify code handles SUCCESS and ERROR case.
3. If ANY function body < 5 lines for non-trivial operation ??? you're taking a shortcut. EXPAND.
4. If ANY error path returns generic message ??? you're being lazy. FIX.
5. Output WILL be mechanically verified against rubric. Shortcuts WILL be caught.
6. If context insufficient: output [BLOCKED: specific missing context]
```

**Cache alignment:** Layers 1-2 stable ??? 90% prompt caching cost reduction.
**Token budget:** `chars/4`. Priority truncation. Binary search fitting.

### Hostile Isolation

- Reviewers NEVER see builder's prompt or reasoning
- Fix-loop reviewers NEVER see prior findings (blind retry)
- Builders NEVER see competing implementations

### Context Prefetching

While agent executes task N, pre-compile context for task N+1 in background (if N+1 doesn't depend on N's output). Invalidate if N fails.

---

## 7. INTENT COMPILER

Solves: "What did the user mean, in senior engineering terms?"

Raw vibe ??? Intent Brief (schema-validated) ??? vocabulary map ??? Q&A plan ??? enrichment sources.

Evidence: aider A/B test ??? 2-line conventions file shifted code from tutorial-level to production. Prompt quality > model choice.

---

## 8. DOMAIN PATTERN LIBRARY

YAML files providing CANDIDATE requirements. Filtered by research/spec decisions ??? patterns are RUBRIC INPUTS, not mandatory expansion.

**Feature types:** authentication, authorization, api-endpoint, database-schema, file-upload, payments, real-time, search, background-jobs, notifications
**Cross-cutting:** input-validation, error-handling, logging, security-headers, caching
**Sources:** OWASP ASVS 5.0, prodlint (52 rules), Azure REST API Guidelines

---

## 9. QUALITY GATES (Policy-as-Code)

| Gate       | Trigger           | Blocks If                                                      |
| ---------- | ----------------- | -------------------------------------------------------------- |
| PlanGate   | After PLAN        | Requirement unassigned. Ownership overlap. contracts.ts fails. |
| BuildGate  | After each packet | Mechanical clamps fail. Ownership violated. Slop detected.     |
| ReviewGate | After REVIEW      | Any P0. P1 > threshold.                                        |
| FixGate    | After fix loop    | P0 after 3 iterations. Same P1 rejected 2+ times.              |
| AuditGate  | Before SHIP       | Requirement lacks file:line + test. Any P0/P1 open.            |
| HumanGate  | Per mode          | No human signal.                                               |

### Mechanical Clamps (BuildGate)

```typescript
const BUILD_CLAMPS = {
  maxFunctionLength: 50,
  maxFileLength: 500,
  maxParameters: 5,
  zeroAsAny: true,
  zeroConsoleLog: true, // production only
  maxCyclomaticComplexity: 15,
};
```

Waivers: documented, evidence-backed, repo-configurable. No auto-relaxation.

---

## 10. STABILITY MONITOR

Detects failing trajectories BEFORE max retries exhaust.

### Signals (any 2+ triggers escalation)

| Signal                           | Threshold     |
| -------------------------------- | ------------- |
| Same test fails twice            | 2 consecutive |
| Same P0/P1 category repeats      | 2 consecutive |
| Malformed output repeats         | 2 consecutive |
| Forbidden file modified          | 1 occurrence  |
| Context grows, acceptance stalls | 2 iterations  |
| Test count decreases             | Any decrease  |
| Slop recurs after fix            | 1 recurrence  |
| Review findings > 15             | 1 occurrence  |

### Responses (escalation order)

1. Stop retry loop
2. Recompile context with specific missing state
3. Split packet into smaller sub-tasks
4. Switch builder model family
5. Escalate to architecture review
6. Ask human for clarification

---

## 11. SECURITY

- **Secret denylist:** `.env`, `.env.*`, `secrets/*`, `credentials/*`, `*.pem`, `*.key`
- **Entropy scanner:** High-entropy detection before every dispatch
- **CLI constraints:** No --yolo, no dangerous flags
- **Safe invocation:** execa shell:false, args as arrays, stdin from temp file
- **Tool/Artifact Envelope:** Untrusted content wrapped in XML boundaries
- **Prompt injection guard:** Promptfoo red-team validates boundaries
- **Dependency policy:** npm audit + justification + human approval for auth/payment/crypto
- **Sandbox levels per packet:** L0 read-only / L1 process+worktree / L2 dep sandbox / L3 container

---

## 12. EVIDENCE LEDGER (SQLite)

WAL mode. FTS5. `busy_timeout(5000)`.

```sql
runs(id, vision, status, branch, base_commit, started_at, completed_at)
requirements(id, run_id, text, source, status, task_id, evidence_file, evidence_line, evidence_test)
tasks(id, run_id, objective, agent, status, owned_files, forbidden_files, acceptance, result, head_commit)
context_runs(id, task_id, agent, head_commit, prompt_hash, context_hash, token_count, token_budget, blob_path)
context_items(id, context_run_id, kind, path, symbol, content_hash, token_count, score, reason)
findings(id, task_id, run_id, severity, path, line, finding, status, source_agent, reviewer_context_hash)
gate_transitions(id, run_id, from_state, to_state, gate_name, passed, evidence_json, human_override, reason)
dispatches(id, task_id, agent, context_run_id, command_hash, exit_code, stdout_blob, stderr_blob, diff_blob, duration_ms, retries, tokens_in, tokens_out, enrichment_flags)
tournament_results(id, run_id, task_id, feature_type, winner_agent, agents_json, criteria_json, created_at)
agent_failure_patterns(id, agent, failure_category, occurrence_count, last_seen, example_finding_id)
```

---

## 13. PROMPT QUALITY LAB

**Tool:** Promptfoo (TypeScript-native, CLI-first, multi-provider)

**Evaluates:**

- Intent Compiler outputs (vibe ??? IntentBrief quality)
- Context Compiler selection (token efficiency)
- Build prompts (enriched vs raw)
- Review prompts (structured rubric vs prose)
- Red-team: prompt injection, boundary bypass

**Enrichment Removal Protocol:**
Every dispatch records `enrichment_flags`. After 20+ dispatches per flag, measure acceptance rate with vs without. Remove what doesn't improve.

**Golden Trajectory Dataset:**
Track full successful/failed runs, not just isolated prompts: template_version, enrichment_flags, agent, task_type, acceptance_pass_rate, P0_escape_rate, retry_count, human_intervention_count.

---

## 14. CLI ADAPTERS

```typescript
interface AgentAdapter {
  name: AgentName;
  dispatch(
    contextPack: ContextPack,
    worktreePath: string,
  ): Promise<AgentResult>;
  parseOutput(raw: string): ParsedOutput;
  healthCheck(): Promise<AgentHealth>;
}
```

All via execa v9, shell:false, stdin from temp file. Zod validation on output. Fenced JSON extraction. Max 3 retries on malformed output.

---

## 15. CLI

```bash
zer0 start / zer0 start --vision "..."
zer0 resume / --approve / --reject "reason" / --override "reason"
zer0 status / --watch
zer0 log / zer0 findings / --severity P0
zer0 cost / zer0 decisions / zer0 agents / zer0 doctor
zer0 mode auto|semi|full
zer0 context inspect BUILD-005
zer0 eval run
```

---

## 16. BUILD ORDER

### Phase 0: Spike (1-2 days)

Validate: Docker Temporal, execa + all CLIs, better-sqlite3, ts.transpileDeclaration, Promptfoo.

### Phase 1: Spine + Security + Rubric Review (1 week)

Temporal scaffold, SQLite + blobs, CLI adapters, gate engine, security filters, structured rubric review output parser, `zer0 start/resume/status/doctor`.

### Phase 2: Context Compiler + Memory Model (1 week)

Three-tier context (Hot/Warm/Cold), dual-signal scoring, .d.ts compression, 6-layer assembly, token budgets, hostile isolation, context prefetching, endcap template.

### Phase 3: Intent + Product Pipeline (1 week)

Intent Compiler, Domain Pattern Library, vocabulary activation, Promptfoo evals, INTENT ??? Q&A ??? RESEARCH ??? SPEC ??? ARCHITECTURE ??? PLAN.

### Phase 4: Build/Review/Fix + Stability (1 week)

Build packets, mechanical clamps, cross-family rubric review, blind retry protocol, fix loop, stability monitor, final audit, requirement coverage.

### Phase 5: Tournament (3-5 days)

LangGraph fan-out, worktree isolation, arbiter evaluation.

### Phase 6: Hardening + Learning (3-5 days)

Enrichment removal protocol, negative capability ledger, golden trajectory dataset, repo map (tree-sitter), cost circuit breaker.

### Phase 7: GUI + Validation

Vite + React control plane. Build a REAL app. Fix every issue.

---

## 17. SUCCESS CRITERIA

| #   | Criterion                     | Verification                          |
| --- | ----------------------------- | ------------------------------------- |
| 1   | Full pipeline on real project | Working, tested, reviewed code        |
| 2   | No gate skippable             | Unit test: blocked without evidence   |
| 3   | P0 blocks unconditionally     | Integration test: inject P0 ??? halts   |
| 4   | Crash recovery                | Kill mid-build ??? resume works         |
| 5   | All 3 CLIs work               | Each dispatches and returns           |
| 6   | Context reproducible          | Blob hash ??? exact prompt              |
| 7   | Hostile isolation holds       | Zero builder content in reviewer      |
| 8   | Secrets never in prompts      | .env never in blobs                   |
| 9   | Structured rubric review      | MET/NOT_MET per requirement           |
| 10  | Stability monitor fires       | Repeated failures ??? early escalation  |
| 11  | Tournament works              | 3 compete, winner by evidence         |
| 12  | Second project works          | Same orchestrator, no code changes    |
| 13  | Enrichment measurable         | Promptfoo shows flag-vs-no-flag delta |

---

## 18. CONFIDENCE

| Dimension                | Level      |
| ------------------------ | ---------- |
| Architecture             | GREEN 96%  |
| Temporal on Windows      | GREEN 90%  |
| Context Memory Model     | GREEN 95%  |
| Structured Rubric Review | GREEN 95%  |
| Intent Compiler          | GREEN 94%  |
| Stability Monitor        | GREEN 91%  |
| Domain Patterns          | GREEN 88%  |
| Timeline (7 phases)      | YELLOW 75% |


codex
I’ll use `implementation-planning` for the execution blueprint, with `cto-vibe-collaboration` as the framing lens because this is an outcome-first build plan that needs concrete engineering decisions, not a restatement of the spec.
exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-Content -Raw C:\\Users\\<user>\\.codex\\skills\\implementation-planning\\SKILL.md" in C:\Users\<user>\VibeCoding\TeamWork
exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-Content -Raw C:\\Users\\<user>\\.codex\\skills\\cto-vibe-collaboration\\SKILL.md" in C:\Users\<user>\VibeCoding\TeamWork
 succeeded in 468ms:
---
name: implementation-planning
description: "Turn vague, large, or outcome-only requests into decision-complete implementation plans before coding. Use when the user describes a feature at a high level, when multiple subsystems will change, when interfaces or data flow are still implicit, or when Codex should lock the success criteria, approach, edge cases, tests, and assumptions before execution."
---

# Implementation Planning

Convert an underspecified request into an implementation plan that another engineer or agent can execute without making product or architecture decisions.

## Workflow

1. Clarify the goal.
- State the user outcome, audience, success criteria, and constraints.
- Separate explicit requirements from assumptions.
2. Ground in the actual codebase.
- Read the current implementation, entry points, and relevant types.
- Confirm whether the request is additive, a refactor, or a behavior change.
3. Lock the implementation shape.
- Define the main approach, interfaces, data flow, dependencies, and integration points.
- Choose defaults where the codebase makes them obvious.
4. Cover failure modes.
- Identify edge cases, error handling, state coverage, migration or compatibility concerns, and rollout risks.
5. Define proof.
- Specify the tests, checks, and manual validation needed to confirm the work is done.
- Call out any assumptions that would need later confirmation.

## Plan Requirements

- Be decision complete.
- Prefer behavior-level changes over file inventories unless file names prevent ambiguity.
- Include public interface changes when relevant.
- Keep the plan concise but specific enough to implement directly.

## Guardrails

- Do not stop at a broad outline.
- Do not leave key interface or behavior choices for the implementer.
- Do not invent unnecessary complexity when a simpler path is defensible.

Cannot set property. Property setting is supported only on core types in this language mode.
At line:1 char:1
+ [Console]::OutputEncoding=[System.Text.Encoding]::UTF8;
+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : InvalidOperation: (:) [], RuntimeException
    + FullyQualifiedErrorId : PropertySetterNotSupportedInConstrainedLanguage
 

 succeeded in 467ms:
---
name: cto-vibe-collaboration
description: "Translate high-level, vibe-based product direction or incomplete requirements into a defensible implementation path. Use when the user speaks in outcomes, taste, speed, or instinct rather than full specs; when Codex should behave like a technical co-founder; or when scope, architecture, product quality, or implementation choices need direct pushback instead of passive compliance."
---

# CTO Vibe Collaboration

Turn vague product intent into concrete engineering moves without forcing the user to over-specify the solution.

## Operating Stance

- Behave like a technical co-founder, not a compliant typist.
- Optimize for user outcome, product feel, maintainability, and speed to a real result.
- Push back early on brittle scope, weak abstractions, unnecessary dependencies, fake MVPs, and visually bland output.
- Prefer the simplest solution that preserves quality and future flexibility.

## Workflow

1. Extract the real ask.
- Identify the user-visible outcome, hard constraints, and hidden assumptions.
- Distinguish what is explicit, inferred, and unknown.
2. Fill in missing structure.
- Propose the simplest defensible architecture, data flow, and build order.
- Default reasonable details from the codebase and product context instead of asking for exhaustive specs.
3. Challenge weak directions.
- Say why an idea is risky, wasteful, incomplete, or lower quality than it appears.
- Offer a better option with concrete tradeoffs.
4. Choose the mode.
- Small fix: implement directly.
- Bigger feature, architectural choice, or vague request: use `research-pre-mortem` or `implementation-planning` before building.
5. Keep the bar high.
- For UI, optimize for polish, clarity, and taste.
- For backend, optimize for correctness, integration, and boring reliability.

## Response Pattern

- State the intended outcome.
- State the chosen approach.
- State the main pushback or risk if one exists.
- Then execute.

## Guardrails

- Do not mirror the user's enthusiasm when the plan is weak.
- Do not invent certainty; label assumptions and constraints.
- Do not ask unnecessary questions when reasonable defaults exist.
- Do not behave like a yes-man.

Cannot set property. Property setting is supported only on core types in this language mode.
At line:1 char:1
+ [Console]::OutputEncoding=[System.Text.Encoding]::UTF8;
+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : InvalidOperation: (:) [], RuntimeException
    + FullyQualifiedErrorId : PropertySetterNotSupportedInConstrainedLanguage
 

codex
I’ve got the planning workflow loaded. I’m going to ground the blueprint in the repo shape just enough to avoid naming fantasy paths, then I’ll produce the operational build plan as the deliverable.
exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'rg --files' in C:\Users\<user>\VibeCoding\TeamWork
exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'Get-ChildItem -Force' in C:\Users\<user>\VibeCoding\TeamWork
 succeeded in 382ms:
package-lock.json
GEMINI.md
AGENTS.md
docs\domain-context.md
docs\specs\2026-05-02-agent-ci.md
docs\specs\2026-05-01-zk-mvp.md
docs\audits\2026-05-02-full-honest-audit.md
docs\plans\2026-05-01-zer0-knights.md
docs\plans\2026-05-01-three-chairs.md
Cannot set property. Property setting is supported only on core types in this language mode.
At line:1 char:1
+ [Console]::OutputEncoding=[System.Text.Encoding]::UTF8;
+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : InvalidOperation: (:) [], RuntimeException
    + FullyQualifiedErrorId : PropertySetterNotSupportedInConstrainedLanguage
 

 succeeded in 465ms:


    Directory: C:\Users\<user>\VibeCoding\TeamWork


Mode                 LastWriteTime         Length Name                                                                                                                                       
----                 -------------         ------ ----                                                                                                                                       
d-----          5/2/2026  10:01 PM                .claude                                                                                                                                    
d-----          5/2/2026   9:51 PM                .council                                                                                                                                   
d--h--         4/27/2026   7:22 PM                .git                                                                                                                                       
d-----          5/2/2026   7:59 AM                docs                                                                                                                                       
-a----          5/1/2026  10:23 PM             91 .geminiignore                                                                                                                              
-a----          5/1/2026  10:23 PM              8 .gitignore                                                                                                                                 
-a----          5/1/2026  10:23 PM            925 AGENTS.md                                                                                                                                  
-a----          5/1/2026  10:23 PM            896 GEMINI.md                                                                                                                                  
-a----          5/2/2026  12:16 AM             87 package-lock.json                                                                                                                          


Cannot set property. Property setting is supported only on core types in this language mode.
At line:1 char:1
+ [Console]::OutputEncoding=[System.Text.Encoding]::UTF8;
+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : InvalidOperation: (:) [], RuntimeException
    + FullyQualifiedErrorId : PropertySetterNotSupportedInConstrainedLanguage
 

codex
The repo is currently documentation-heavy, not an implementation scaffold: plans/specs exist under `docs/`, with no `src/` yet. I’m checking those docs now so the blueprint aligns with the existing Zer0 vocabulary instead of inventing a second system.
exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'Get-Content -Raw AGENTS.md' in C:\Users\<user>\VibeCoding\TeamWork
exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-Content -Raw docs\\specs\\2026-05-02-agent-ci.md" in C:\Users\<user>\VibeCoding\TeamWork
exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-Content -Raw docs\\plans\\2026-05-01-zer0-knights.md" in C:\Users\<user>\VibeCoding\TeamWork
exec
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-Content -Raw docs\\domain-context.md" in C:\Users\<user>\VibeCoding\TeamWork
 succeeded in 526ms:
# Project Context for Codex — TeamWork

## Stack

- Framework: [e.g., Next.js 16, FastAPI, Express]
- Database: [e.g., Neon Postgres, PlanetScale, Supabase]
- Cache: [e.g., Upstash Redis, none]
- Auth: [e.g., Clerk, NextAuth, custom]
- Hosting: [e.g., Vercel, AWS, Railway]

## Scale Target

- Current tier: [10K / 100K / 500K users]
- Architecture designed for: [target tier]
- p99 latency target: [e.g., 200ms]

## Domain

[1-2 sentence domain description. Reference docs/domain-context.md for full detail.]

## Architecture Decisions

[Key decisions from .council/decisions.md that affect all code:]

- [e.g., Multi-tenant via Postgres RLS with tenant_id on every table]
- [e.g., Background jobs via Vercel Queues, not synchronous processing]

## Code Style

[Will be populated after Task 1 completes with real code examples.]

## Override

Per-dispatch prompt instructions override these guidelines when they conflict.

Cannot set property. Property setting is supported only on core types in this language mode.
At line:1 char:1
+ [Console]::OutputEncoding=[System.Text.Encoding]::UTF8;
+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : InvalidOperation: (:) [], RuntimeException
    + FullyQualifiedErrorId : PropertySetterNotSupportedInConstrainedLanguage
 

 succeeded in 546ms:
# Agent CI — Production Specification

**Version:** 1.0
**Date:** 2026-05-02
**Authors:** zer0 (coordinator) + Architecture Council (Claude, Codex Knight, Gemini Knight)
**Status:** DRAFT — pending L-1 hostile review

---

## 1. Executive Summary

Agent CI is a production-grade infrastructure system that orchestrates multiple AI coding agents (Claude Code, Codex CLI, Gemini CLI) to build software collaboratively, with mechanical enforcement of quality gates, context management, and evidence-based completion tracking.

It is **not** a multi-agent chat tool. It is a **CI/CD pipeline where the developers happen to be AI models.** The same guarantees real CI gives human developers — build, test, review, gate, merge — applied to code agents that drift, hallucinate, skip reviews, and silently drop requirements.

**Core stack:** Temporal TypeScript (durable execution) + LangGraph JS (AI decision graphs) + SQLite (evidence ledger) + Context Compiler (prompt engineering pipeline) + CLI adapters (Claude, Codex, Gemini).

---

## 2. Problem Statement

### 2.1 What went wrong (empirical evidence)

The predecessor system (zer0-knights, 27 files) scored **1 out of 8 success criteria (12.5%)** on its own audit (`docs/audits/2026-05-02-full-honest-audit.md`). Root causes verified against actual files:

| Failure                                    | Evidence                                                                                                                                |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Enforcement layer silently dropped         | Priority 2 (stop hook + pre-commit gate) — the project's core purpose — was moved to "anti-targets" in the focused spec, never re-added |
| 6/10 build steps had no cross-model review | Gate Topology violations verified in audit Section 5                                                                                    |
| Review prompts were biased                 | Claude gave reviewers 6-10 specific "attack vectors" instead of neutral prompts (audit Section 4)                                       |
| 6 P0 bugs accepted as "risks"              | TOCTOU lock race, zombie processes, lock ownership, JSONL corruption, temp filename collision, readdir depth (audit Section 7)          |
| 510 lines of untested command code         | 6 commands with zero tests: research, fact-check, council, debug, dispatch, chat (audit Section 6)                                      |
| 10 files never reviewed                    | 6 commands + 4 chat system files built after L3 review was dispatched (audit Section 5)                                                 |

### 2.2 Core insight

> "The problem is not model intelligence — it is a lack of distributed systems discipline applied to AI orchestration. Agents fail because cognitive state and execution state are currently coupled."
> — Gemini Knight, Infrastructure Council Round

> "Agents never decide whether they are done. They can only submit artifacts. The workflow decides whether the artifacts satisfy gates."
> — Codex Knight, Infrastructure Council Round

### 2.3 What we're solving

Code agents drift. They hallucinate APIs, ignore conventions, produce inconsistent patterns, skip reviews, accept P0 bugs as "risks," and silently drop the hardest requirements. Agent CI provides the infrastructure layer that catches and corrects these failures mechanically — not through prompting agents to "be disciplined," but through state machine transitions that require evidence before advancing.

---

## 3. Architecture Decision Records

Each decision below traces through the council rounds that produced it. All council prompts and responses are preserved in `.council/cross-model/`.

### ADR-001: Product Framing — "Agent CI, not multi-agent chat"

**Decision:** Build a CI/CD pipeline for code agents, not a collaboration tool.

**Council evidence:**

- Constrained proposals (Round 1): all 3 models converged on "contract-first parallel build" — but this was later identified as prompt-biased convergence. The prompts contained 7 structured questions and predetermined failure modes that led to identical safe answers.
- Free proposals (Round 2): given zero constraints, both Codex and Gemini independently proposed competitive/tournament builds and "Agent OS / control plane" framing. Neither proposed this under constrained prompts.
  - Codex: _"The real product is not three terminals open at once. The real product is: AI engineering control plane over local CLI agents."_ (`codex-council-build-free.md:109-114`)
  - Gemini: _"Zer0-OS runs as a background daemon. It watches a centralized Event Ledger and routes tasks to the model best suited for the job."_ (`gemini-council-build-free.md:9`)
- Decision round (Round 3): both models rejected "MCP Server for Claude Code" (Option D) because it reintroduces coordinator bias.
  - Codex: _"Architecturally tempting, politically wrong. It makes Claude Code the host and likely reintroduces the coordinator bias that already failed."_ (`codex-council-decision.md:11`)
  - Gemini: _"Option D relies on Claude as the core router, repeating the exact architecture that allowed Claude to bias the previous project."_ (`gemini-council-decision.md:13`)

**Alternatives considered:** standalone CLI (Option A), LangGraph-only (Option B), A2A protocol (Option C), MCP server (Option D), manual-first (Option E).

### ADR-002: Orchestration — Temporal TypeScript as the spine

**Decision:** Temporal TypeScript SDK for durable workflow execution.

**Council evidence:**

- Infrastructure round (Round 4): both models independently proposed Temporal + LangGraph combination.
  - Codex: _"Temporal is the foundation because the thing you need is not 'agents talking.' You need a durable state machine that can say: this task cannot advance because the review attestation is missing."_ (`codex-council-infrastructure.md:15`)
  - Gemini: _"The solution to a discipline failure is mechanical enforcement. LangGraph provides a rigid, directed state machine that natively solves our exact failure modes."_ (`gemini-council-decision.md:7-8`)
- Both explicitly positioned Temporal as PRIMARY, LangGraph as SECONDARY.
  - Codex: _"LangGraph only for bounded AI decision subgraphs, such as fan-out review, debate, or arbiter workflows. Do not let LangGraph own the production ledger."_ (`codex-council-infrastructure.md:12`)

**Why Temporal over raw LangGraph:**

- Durable execution survives process crashes
- First-class activity timeouts and heartbeats (CLI processes that hang)
- Retry policies with exponential backoff (rate limits)
- Web UI for workflow visibility ("mission control")
- Signals/queries for human intervention mid-workflow
- Battle-tested at Netflix, Stripe (production-proven, not prototype-grade)

**Why not Temporal alone (without LangGraph):**

- Temporal doesn't understand LLM-specific patterns (prompt evaluation, model output comparison)
- LangGraph's `Send()` API maps naturally to tournament fan-out/fan-in
- LangGraph's typed state with reducers handles combining competing model outputs

### ADR-003: Evidence — SQLite append-only ledger

**Decision:** Local SQLite database as the system's source of truth for all evidence.

**Council evidence:**

- Codex (Infrastructure): _"The ledger must be append-only and externally verifiable. If an agent says 'done,' that is just a claim."_ (`codex-council-infrastructure.md:84-85`)
- Gemini (Free proposal): _"Instead of static JSONL files, use a lightweight, local SQLite event bus."_ (`gemini-council-build-free.md:22`)
- Codex (Context Compiler): provided complete 6-table schema (`codex-council-context.md:253-324`)

**What the ledger records (from Codex Infrastructure, lines 29-42):**

- Original user request
- Compiled requirements
- Explicit non-goals
- File ownership assignments
- Agent assignments
- Prompt sent to each agent (hash)
- stdout/stderr/artifacts
- Git diff per agent
- Test commands and outputs
- Findings table with P0/P1/P2
- Requirement coverage matrix
- Final attestation
- Gate transition evidence

### ADR-004: Context — Context Compiler with 6-layer prompts

**Decision:** Deterministic Context Compiler that produces auditable Context Packs.

**Council evidence:**

- Research (Gemini, Google Search): _"Maximum Effective Context Window for complex reasoning is often only 1k-5k tokens, even with 1M+ windows."_ (`gemini-context-research.md:10-11`)
- Research: _"Lost in the Middle — models heavily weight Primacy and Recency, leaving a massive blind spot in the middle 40-60%."_ (`gemini-context-research.md:23-25`)
- Research: _"15x token overhead for multi-agent systems due to broadcast-induced triply-multiplicative overhead."_ (`gemini-context-research.md:41`)
- Codex (Context Compiler): _"Design the Context Compiler as a deterministic build step, not a smart prompt template."_ (`codex-council-context.md:1`)
- Gemini (Context Compiler): _"The Context Compiler shouldn't be a simple template engine. It needs to be a context-shaping pipeline that treats prompt construction like memory management in an OS."_ (`gemini-council-context.md:4`)

**Key design principles (from research + both knights):**

1. Exploit Lost-in-the-Middle: critical instructions at TOP and BOTTOM, reference material in middle
2. Budget max 40% of context for dynamic reasoning (the "40% rule")
3. AST-based repository maps (Aider pattern) — signatures, not full files
4. Three inclusion levels: `full_file`, `file_slice`, `symbol_signature`
5. Context Packs are hash-addressed and logged — every dispatch is reproducible
6. Scoped MCP as on-demand context provider (agents request what they need)
7. Hostile isolation: reviewers never see builder reasoning, builders never see competing implementations

### ADR-005: Tournament as the killer feature

**Decision:** Competitive builds where multiple agents implement the same task, with mechanical evaluation.

**Council evidence:**

- Free proposals (Round 2): both models independently proposed this — zero prompting toward it.
  - Codex: _"`rt tournament` — runs multiple agents in parallel, produces competing patches, tests them, reviews them against each other, and either picks the winner or synthesizes a merged patch. That is much better than 'Claude asks Codex asks Gemini.' The agents should compete and verify, not politely amplify each other's mistakes."_ (`codex-council-build-free.md:166-174`)
  - Gemini: _"Mode 6 (Swarm Build): The OS can ask Codex to build the feature 3 different ways in 3 different worktrees simultaneously. Gemini analyzes all 3. Claude picks the winner."_ (`gemini-council-build-free.md:31-33`)
- Framework research confirmed: LangGraph has native Fan-Out/Fan-In via `Send()` API. AutoGen has adversarial "Debate" patterns. CrewAI has "Team of Rivals."

---

## 4. System Architecture

### 4.1 Layer diagram

```
User (Claude Code chat)
  │
  â–¼
┌─────────────────────────────────────────┐
│  TEMPORAL (The Spine)                   │
│  Durable execution, retries, timeouts,  │
│  crash recovery, human gates, visibility│
│                                         │
│  ┌─────────────────────────────────┐    │
│  │  LANGGRAPH JS (The Brain)       │    │
│  │  Fan-out/tournament, evaluation,│    │
│  │  debate, arbiter subgraphs      │    │
│  └─────────────────────────────────┘    │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │  CONTEXT COMPILER (The Lens)    │    │
│  │  AST repo map, scoring, packing,│    │
│  │  attention-curve layering       │    │
│  └─────────────────────────────────┘    │
│                                         │
│  ┌──────┐  ┌──────┐  ┌──────┐          │
│  │Claude│  │Codex │  │Gemini│  Adapters │
│  │ CLI  │  │ CLI  │  │ CLI  │          │
│  └──────┘  └──────┘  └──────┘          │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │  SQLITE LEDGER (The Memory)     │    │
│  │  Evidence, findings, context     │    │
│  │  runs, requirements, attestations│    │
│  └─────────────────────────────────┘    │
└─────────────────────────────────────────┘
```

### 4.2 Component responsibilities

| Component            | Owns                                                                                                      | Does NOT own                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **Temporal**         | Workflow lifecycle, activity retries/timeouts, crash recovery, human gates, state transitions, visibility | Prompt logic, model evaluation, context selection  |
| **LangGraph JS**     | Tournament fan-out/fan-in, cross-model evaluation, debate/arbiter subgraphs, prompt routing decisions     | Production ledger, gate enforcement, durable state |
| **Context Compiler** | Repo map generation, context scoring/selection, prompt assembly, Context Pack creation, token budgeting   | Task decomposition, agent assignment, evaluation   |
| **SQLite Ledger**    | Evidence storage, requirement traceability, findings accumulation, context run logging, gate audit trail  | Workflow orchestration, context selection          |
| **CLI Adapters**     | CLI invocation, stdout/stderr capture, timeout handling, output parsing, worktree management              | Decision-making, context selection, gate logic     |

### 4.3 Naming convention

Based on Codex Infrastructure proposal (`codex-council-infrastructure.md:84-93`) and Gemini Infrastructure proposal (`gemini-council-infrastructure.md:5-9`):

- Temporal = **The Spine** (durable execution backbone)
- LangGraph = **The Brain** (AI-specific decisions)
- SQLite Ledger = **The Memory** (evidence and history)
- Context Compiler = **The Lens** (what each agent sees)
- Policy Gates = **The Immune System** (enforcement)
- CLI Adapters = **The Hands** (untrusted workers)

---

## 5. Workflow Definitions

### 5.1 Master workflow (Temporal)

Source: Codex Infrastructure proposal, lines 25-27.

```
Intake → Plan → Build → Verify → Hostile Review → Fix Loop → Final Audit → Human Approval → Merge
```

Every transition is gated. No evidence, no transition.

Note: The original Codex proposal included "Spec Compile" and "Self Test" as separate stages. In this spec, Intake absorbs spec compilation (requirements extraction IS the spec compile step), and Verify absorbs self-testing (mechanical checks run immediately after build, not as a separate workflow). This reduces workflow count without losing any gate.

### 5.2 Workflow detail

**IntakeWorkflow**

- Input: user request (natural language)
- Actions: extract structured requirements, identify explicit non-goals, estimate file scope, estimate cost (see Section 16)
- Output: structured requirement checklist, explicit non-goals, file scope estimate, cost estimate
- Gate: requirement checklist exists, non-goals documented, user confirms cost estimate

**PlanWorkflow**

- Input: requirement checklist
- Output: task decomposition, file ownership map, agent assignments, acceptance criteria per task
- Gate: every requirement maps to at least one task, no file owned by multiple agents

**BuildWorkflow**

- Input: task brief + Context Pack per agent
- Modes:
  - **Single dispatch:** one agent builds one task
  - **Tournament:** 2-3 agents build the same task in isolated worktrees, arbiter evaluates
  - **Parallel split:** independent tasks dispatched to different agents simultaneously
- Per-agent activities:
  1. Create isolated git worktree
  2. Compile Context Pack via Context Compiler
  3. Dispatch CLI agent (Temporal Activity with timeout + retry)
  4. Capture stdout/stderr/artifacts
  5. Validate: diff only touches owned files
  6. Run mechanical checks: `tsc --noEmit`, `eslint`, `npm test`
- Worktree cleanup: after build completes (pass or fail), worktree is deleted. On process crash, Temporal activity timeout triggers cleanup. Max concurrent worktrees: 3 (one per agent in tournament). Worktrees live in `.agent-ci/worktrees/`.
- Gate: all mechanical checks pass, diff within ownership scope

**ReviewWorkflow (LangGraph subgraph)**

- Input: agent diff + context (NO builder reasoning — hostile isolation)
- Fan-out via `Send()`: dispatch 2 independent reviewers (different models)
- Each reviewer produces structured findings (P0/P1/P2 with file:line evidence)
- Reducer: merge findings, deduplicate, aggregate severity
- Gate: zero P0 findings. P1 findings logged but don't block unless count > threshold.

**FixLoopWorkflow**

- Input: verified findings from ReviewWorkflow
- Sends findings to original builder agent with fresh Context Pack
- Max iterations: 3 (configurable). After 3 failed attempts → escalate to human.
- Gate: P0 count reaches zero AND all acceptance criteria have evidence

**AuditWorkflow**

- Input: all artifacts from BuildWorkflow + ReviewWorkflow
- Checks: requirement coverage matrix (every requirement linked to file:line + test), no orphaned files, no regressions
- Gate: 100% requirement coverage with evidence

**CompletionWorkflow**

- Input: all passing gates
- Options: merge locally, create PR, keep branch, discard
- Human approval required for merge/PR
- Gate: human signal received

### 5.3 Tournament subgraph (LangGraph)

Source: Codex free proposal (`codex-council-build-free.md:160-173`), Gemini free proposal (`gemini-council-build-free.md:30-33`).

```
                    ┌─→ Claude worktree ─→ test ─┐
Task ─→ Fan-Out ─→ ├─→ Codex worktree  ─→ test ─┤─→ Arbiter ─→ Winner
                    └─→ Gemini worktree ─→ test ─┘
```

Arbiter evaluation criteria (from Codex free proposal, lines 96-104):

- Tests pass
- Lint passes
- Smaller diff (less complexity)
- Acceptance criteria coverage
- Review findings count
- Migration safety
- UI state coverage (if applicable)

---

## 6. Data Model

### 6.1 SQLite schema

Source: Codex Context Compiler proposal (`codex-council-context.md:253-324`), extended with Codex Infrastructure requirements (`codex-council-infrastructure.md:29-42`).

```sql
-- Workflow execution anchor
runs(
  id TEXT PRIMARY KEY,
  user_request TEXT NOT NULL,
  status TEXT DEFAULT 'intake',  -- 'intake' | 'planning' | 'building' | 'reviewing' | 'auditing' | 'completed' | 'failed'
  branch TEXT,
  base_commit TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

-- Requirements traceability
requirements(
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL,          -- 'user' | 'derived' | 'constraint'
  status TEXT DEFAULT 'open',    -- 'open' | 'assigned' | 'implemented' | 'verified'
  assigned_task TEXT,
  evidence_file TEXT,
  evidence_line INTEGER,
  evidence_test TEXT,
  created_at TEXT NOT NULL
);

-- Task tracking
tasks(
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  agent TEXT,                    -- 'claude' | 'codex' | 'gemini'
  role TEXT,                     -- 'builder' | 'reviewer' | 'researcher'
  status TEXT DEFAULT 'pending', -- 'pending' | 'dispatched' | 'completed' | 'failed' | 'blocked'
  owned_files_json TEXT,
  forbidden_files_json TEXT,
  acceptance_json TEXT,
  result TEXT,
  head_commit TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

-- Context compilation runs
context_runs(
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  role TEXT NOT NULL,
  head_commit TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  token_count INTEGER,
  token_budget INTEGER,
  manifest_path TEXT,
  created_at TEXT NOT NULL
);

-- Individual context items included in a run
context_items(
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,            -- 'full_file' | 'file_slice' | 'symbol_signature' | 'repo_map' | 'test_summary' | 'ledger_finding' | 'decision' | 'command_output'
  path TEXT,
  symbol TEXT,
  start_line INTEGER,
  end_line INTEGER,
  content_hash TEXT NOT NULL,
  token_count INTEGER,
  score REAL,
  reason TEXT,
  FOREIGN KEY (run_id) REFERENCES context_runs(id)
);

-- AST-derived repository symbol index
repo_symbols(
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL,            -- 'function' | 'class' | 'interface' | 'type' | 'export' | 'route' | 'test'
  signature TEXT,
  imports_json TEXT,
  exports_json TEXT,
  callers_json TEXT,
  callees_json TEXT,
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Review findings
findings(
  id TEXT PRIMARY KEY,
  task_id TEXT,
  run_id TEXT,
  severity TEXT NOT NULL,        -- 'P0' | 'P1' | 'P2'
  path TEXT,
  line INTEGER,
  finding TEXT NOT NULL,
  status TEXT DEFAULT 'open',    -- 'open' | 'fixed' | 'accepted' | 'disputed'
  source_agent TEXT NOT NULL,
  reviewer_context_hash TEXT,
  head_commit TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

-- Gate transition evidence
gate_transitions(
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  gate_name TEXT NOT NULL,
  passed INTEGER NOT NULL,       -- 0 or 1
  evidence_json TEXT NOT NULL,   -- { checks: [{name, passed, detail}] }
  blocked_reason TEXT,
  human_override INTEGER DEFAULT 0,
  human_override_reason TEXT,
  created_at TEXT NOT NULL
);

-- Agent dispatch history
dispatches(
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  context_run_id TEXT,
  command TEXT NOT NULL,
  exit_code INTEGER,
  stdout_hash TEXT,
  stderr_hash TEXT,
  diff_hash TEXT,
  duration_ms INTEGER,
  retries INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

-- MCP tool requests made by agents during dispatch
tool_requests(
  id TEXT PRIMARY KEY,
  dispatch_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  request_json TEXT NOT NULL,
  allowed INTEGER NOT NULL,
  response_hash TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (dispatch_id) REFERENCES dispatches(id)
);
```

-- Completed task history (episodic memory for Context Compiler)
task_history(
id TEXT PRIMARY KEY,
task_id TEXT NOT NULL,
objective TEXT NOT NULL,
files_json TEXT,
result TEXT, -- 'success' | 'failure' | 'partial'
summary TEXT,
head_commit TEXT,
created_at TEXT NOT NULL,
FOREIGN KEY (task_id) REFERENCES tasks(id)
);

```

Full-text search indexes on `repo_symbols`, `findings`, `requirements`, and `task_history`.

### 6.2 Context Pack structure

Source: Codex Context Compiler proposal (`codex-council-context.md:418-429`).

```

.agent-ci/context/runs/{runId}/{agent}/
prompt.md -- The assembled prompt
manifest.json -- What was included, excluded, and why
repo-map.json -- AST-derived symbol map
files/ -- Exact file contents included (hash-addressed)
evidence/ -- Findings, decisions, test outputs
mcp-scope.json -- Scoped MCP permissions for this dispatch

````

Every dispatch references the Context Pack hash in the evidence ledger. This enables post-mortem analysis: what did the agent know? What was omitted? Was context stale?

---

## 7. Context Compiler Specification

### 7.1 Inputs and outputs

Source: Codex Context Compiler proposal (`codex-council-context.md:18-82`).

**Input:**

```typescript
type ContextCompilerInput = {
  task: {
    id: string;
    kind: "build" | "review" | "debug" | "research" | "fix-ci" | "audit";
    objective: string;
    acceptanceCriteria: string[];
    explicitFiles?: string[];
    explicitSymbols?: string[];
    constraints: string[];
  };
  project: {
    repoRoot: string;
    headCommit: string;
    branch: string;
    diffBase?: string;
    changedFiles: string[];
  };
  agent: {
    name: "codex" | "claude" | "gemini";
    role: "builder" | "reviewer" | "fact-checker" | "planner";
    contextBudgetTokens: number;
    capabilities: string[];
    quirks: string[];
  };
  policy: {
    maxFiles: number;
    maxFullFiles: number;
    allowSourceWrites: boolean;
    forbiddenPaths: string[];
    secretPatterns: string[];
  };
};
````

**Output:**

```typescript
type ContextCompilerOutput = {
  prompt: string;
  contextManifest: {
    runId: string;
    agent: string;
    headCommit: string;
    includedItems: ContextItem[];
    omittedCandidates: OmittedItem[];
    tokenBudget: TokenBudget;
    hashes: Record<string, string>;
  };
  mcpScope: {
    allowedPaths: string[];
    allowedQueries: string[];
    deniedPaths: string[];
  };
  evidenceLedgerEntry: {
    taskId: string;
    agent: string;
    contextHash: string;
    manifestPath: string;
    promptHash: string;
  };
};
```

### 7.2 Prompt structure (6 layers)

Source: Codex Context Compiler (`codex-council-context.md:88-141`), Gemini Context Compiler attention-curve mapping (`gemini-council-context.md:15-34`).

Exploits Lost-in-the-Middle: critical instructions at start and end (highest attention), reference material in the middle (lowest attention).

| Layer               | Position | Attention        | Content                                                                                                                        |
| ------------------- | -------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1. Static prefix    | 0-15%    | HIGH             | Quality floor, Agent CI rules, output schema, severity definitions, isolation rules                                            |
| 2. Project contract | 15-30%   | HIGH             | ROUND_TABLE.md, architecture decisions, build/test commands, stack conventions                                                 |
| 3. Task brief       | 30-40%   | MEDIUM           | Objective, acceptance criteria, owned files, forbidden files, deliverable format                                               |
| 4. Repo map         | 40-60%   | LOW (blind spot) | AST signatures, imports/exports, call graph neighbors, test map                                                                |
| 5. Evidence pack    | 60-90%   | MEDIUM           | Full files for edit targets, slices for neighbors, findings, failed attempts                                                   |
| 6. Endcap           | 90-100%  | HIGH             | Repeat exact task, repeat output schema, repeat forbidden behaviors, manifest hash, "if context insufficient, request via MCP" |

### 7.3 Context scoring algorithm

Source: Codex Context Compiler (`codex-council-context.md:163-178`).

```typescript
score =
  explicitMention * 100 +
  changedInDiff * 80 +
  symbolMatch * 60 +
  callGraphDistance(d) + // d=0: 70, d=1: 50, d=2: 25, d>=3: 0
  testProximity * 50 +
  recentFailureHistory * 40 +
  architecturalRelevance * 35 +
  semanticSimilarity * 25 +
  ownershipRelevance * 20 -
  tokenCostPenalty -
  redundancyPenalty -
  staleEvidencePenalty;
```

Hard inclusions (always present regardless of score): task brief, repo instructions, directly edited files, relevant test files, build/test commands, open P0/P1 findings in the same area.

Hard exclusions (never included): `.env`, credentials, secrets, unrelated generated output, other agents' live work during isolated phases.

### 7.4 File inclusion levels

Source: Codex Context Compiler (`codex-council-context.md:200-220`).

| Level              | When used                                 | Token cost |
| ------------------ | ----------------------------------------- | ---------- |
| `full_file`        | Direct edit targets, small critical files | High       |
| `file_slice`       | Neighbor files, callers/callees           | Medium     |
| `symbol_signature` | Broad architecture awareness              | Low        |
| `repo_map`         | Navigational context                      | Very low   |

Rule: never summarize code the agent must modify. Give exact code for edit targets.

### 7.5 Token budgets

Source: Codex Context Compiler (`codex-council-context.md:360-382`).

| Task type         | Prompt budget                      |
| ----------------- | ---------------------------------- |
| Review            | 8k-16k tokens                      |
| Focused bug fix   | 10k-20k tokens                     |
| Feature build     | 16k-32k tokens                     |
| Architecture plan | 12k-24k tokens                     |
| Large refactor    | Split task — do not inflate prompt |

Within budget:

- Static prefix: 15-25%
- Task brief: 10-15%
- Repo map: 15-25%
- Exact files: 25-40%
- Evidence: 10-20%
- Endcap: 5%
- Reserved headroom: never fill the model window

**Rule:** If the compiler needs >30k tokens to explain a task, the task is too large for one cold dispatch. Split it.

### 7.6 Per-agent context differences

Source: Codex Context Compiler (`codex-council-context.md:384-410`).

| Agent/Role                | More of                                                     | Less of                      |
| ------------------------- | ----------------------------------------------------------- | ---------------------------- |
| Codex (builder)           | Exact code, tests, patch contracts                          | Historical summaries         |
| Claude (planner/reviewer) | Architecture decisions, product constraints, broad repo map | Full code unless reviewing   |
| Gemini (researcher)       | Docs, claims, external source checklist                     | Local implementation detail  |
| Any reviewer              | Diff, contracts, tests, affected files                      | Builder's chain of reasoning |
| Any builder               | Ownership boundaries, parallel worker awareness             | Competing implementations    |

### 7.7 Hostile isolation rules

Source: both Context Compiler proposals.

- Reviewers NEVER receive the builder's prompt or reasoning chain
- Reviewers NEVER see other reviewers' outputs
- Builders NEVER see competing implementations during tournament build phase
- The Redactor stage (Gemini proposal, `gemini-council-context.md:46-48`) strips agent "thought processes" and passes only verified state changes

### 7.8 MCP context provider

Source: Codex Context Compiler (`codex-council-context.md:336-354`).

Scoped per dispatch. Logged. Narrow methods:

```typescript
searchSymbols(query: string): SymbolResult[]
getFileSlice(path: string, startLine: number, endLine: number): FileSlice
getSymbolContext(symbol: string): SymbolDetail
getTestsForFile(path: string): TestInfo[]
getRecentFindings(pathOrSymbol: string): Finding[]
getDecision(topic: string): Decision
searchRepoMap(query: string): RepoMapResult[]
```

Each response includes source path, line range, content hash, head commit, and reason it was allowed. No arbitrary filesystem read — scoped capability per agent/run.

### 7.9 Token counting

Token counts use `tiktoken` with the `cl100k_base` encoding as the default tokenizer. This is an approximation — Claude, Codex, and Gemini use different tokenizers internally. Acceptable variance: ±15%. The token budget enforcer targets 85% of the stated budget to absorb this variance (e.g., a 16k budget targets 13.6k measured tokens).

For Phase 1 (hand-crafted packs), token counting is informational. For Phase 2+, the Context Compiler enforces budgets mechanically.

### 7.10 Prompt caching strategy

Source: Gemini context research (`gemini-context-research.md:42`): _"Context caching reduces cost by up to 90% for repeated static prefixes."_

Layer 1 (static prefix) and Layer 2 (project contract) are identical across all dispatches for a given commit. These layers should be structured as a **cacheable prefix** — same content, same order, same tokens every time. This enables provider-level prompt caching:

- **Anthropic:** automatic prompt caching for repeated prefixes (cache_control breakpoints)
- **OpenAI:** Codex CLI handles caching internally via session
- **Google:** Gemini context caching via API (may not apply in CLI mode)

Practical impact: in a tournament with 3 dispatches, the static prefix (~4k tokens) is processed once and cached for the other 2. Over a full pipeline (intake + plan + 3 builds + 2 reviews + fix loops), caching saves 60-80% of static prefix costs.

---

## 8. CLI Agent Adapters

### 8.1 Adapter interface

Each adapter wraps a CLI tool as a Temporal Activity.

```typescript
interface AgentAdapter {
  name: "claude" | "codex" | "gemini";
  dispatch(
    contextPack: ContextPack,
    worktreePath: string,
  ): Promise<AgentResult>;
  parseOutput(raw: string): ParsedFindings;
  healthCheck(): Promise<AgentHealth>;
}

interface AgentResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  diffHash: string;
  filesChanged: string[];
  duration: number;
}
```

### 8.2 Codex adapter

```
cat {contextPack.prompt} | codex exec --sandbox workspace-write -C {worktreePath} -o {outputPath} -
```

- Timeout: configurable, default 5 minutes
- Retry: up to 2 attempts on non-zero exit
- Requires git repo in worktree
- Reads `AGENTS.md` from worktree root (generated from `ROUND_TABLE.md`)

### 8.3 Gemini adapter

```
cat {contextPack.prompt} | gemini -y > {outputPath} 2>{stderrPath}
```

- Timeout: configurable, default 5 minutes
- Retry: up to 2 attempts, with env var sanitization (`GOOGLE_API_KEY`, `GEMINI_API_KEY` stripped — lesson from zer0-knights audit Section 8)
- Reads `GEMINI.md` from worktree root (generated from `ROUND_TABLE.md`)
- No `-p` flag with stdin (conflict — lesson from zer0-knights)

### 8.4 Claude adapter

```
claude -p --output-format json < {contextPack.prompt} > {outputPath} 2>{stderrPath}
```

- `-p` (print mode): non-interactive, single-turn, outputs to stdout and exits
- `--output-format json`: structured output with `result` field
- Stdin: pipe the Context Pack prompt via `<` redirect
- Timeout: configurable, default 10 minutes (longer for complex tasks)
- Retry: up to 2 attempts on non-zero exit
- Can use MCP natively (scoped MCP server available during dispatch)
- Reads `CLAUDE.md` from worktree root (generated from `ROUND_TABLE.md`)
- Note: unlike Codex/Gemini, Claude Code has persistent context within interactive sessions. In `-p` mode it is stateless per invocation, same as the others.

### 8.5 ROUND_TABLE.md → per-model instruction files

Source: Codex free proposal (`codex-council-build-free.md:136-147`).

One canonical instruction file (`ROUND_TABLE.md`) in the project root. The Context Compiler generates:

- `AGENTS.md` (Codex reads this)
- `CLAUDE.md` (Claude reads this — project-level, not user-level)
- `GEMINI.md` (Gemini reads this)

Do not hand-maintain three divergent files. They rot.

---

## 9. Gate Definitions (Policy-as-Code)

Source: Codex Infrastructure proposal (`codex-council-infrastructure.md:3`): _"Policy-as-code gate engine for enforcement: no state transition unless mechanical checks pass."_

### 9.1 Gate types

| Gate           | Trigger               | Checks                                                          | Block condition                                 |
| -------------- | --------------------- | --------------------------------------------------------------- | ----------------------------------------------- |
| **PlanGate**   | After PlanWorkflow    | Every requirement maps to a task, no file multi-ownership       | Any requirement unassigned                      |
| **BuildGate**  | After BuildWorkflow   | Diff within owned files, mechanical checks (tsc/lint/test) pass | Any check fails                                 |
| **ReviewGate** | After ReviewWorkflow  | Reviewers independent, findings parsed                          | Any P0 finding exists                           |
| **FixGate**    | After FixLoopWorkflow | P0 count = 0, iteration < max                                   | P0 remains after max iterations                 |
| **AuditGate**  | After AuditWorkflow   | Requirement coverage = 100%, no regressions                     | Any requirement lacks file:line + test evidence |
| **HumanGate**  | Before merge/PR       | Human signal received                                           | No signal                                       |

### 9.2 P0 override policy

Source: Codex Infrastructure pre-mortem (`codex-council-infrastructure.md:99`): _"P0 blocks workflow, no override except explicit human approval."_

- P0 findings BLOCK the workflow unconditionally
- Override requires explicit human approval via Temporal signal
- Override reason is logged to `gate_transitions` table with `human_override = 1`
- No automated P0 acceptance — the audit showed "accepted as risk" is how enforcement dies

---

## 10. Invariants

Non-negotiable properties that must always hold. Violation of any invariant is a system bug, not a policy decision.

1. **No evidence, no transition.** Every gate transition requires evidence in the SQLite ledger. (Source: Codex Infrastructure, line 92)
2. **Agents never decide they are done.** They submit artifacts. The workflow decides if artifacts satisfy gates. (Source: Codex Infrastructure, line 44)
3. **Hostile isolation.** Reviewers never see builder reasoning. Builders never see competing implementations. (Source: all council rounds)
4. **Append-only ledger.** Evidence is never deleted or modified. (Source: Codex Infrastructure, line 84)
5. **Context Pack reproducibility.** Every dispatch has a hash-addressed Context Pack that can reconstruct what the agent saw. (Source: Codex Context Compiler, lines 418-439)
6. **Enforcement ships first.** Gates are Task 1 in any build phase, not "Phase 2." (Source: zer0-knights audit — enforcement was the purpose of the project and was dropped)
7. **ROUND_TABLE.md is the single source of truth.** Per-model instruction files are generated, not hand-maintained. (Source: Codex free proposal, lines 136-147)

---

## 11. Anti-Requirements

Things we explicitly do NOT build.

1. **No multi-agent chat.** Agents do not converse with each other. They communicate through durable artifacts — diffs, findings, attestations. (Source: Codex free proposal, line 37: _"Do not make them free-chat with each other. That becomes noisy and non-deterministic."_)
2. **No GUI in MVP.** Temporal Web UI provides visibility. Custom dashboard is Phase 2.
3. **No cloud deployment in MVP.** Local-first. `temporal dev server` for local development.
4. **No vector embeddings in MVP.** Start with AST + FTS (full-text search) over SQLite. Add embeddings only if FTS + AST retrieval proves insufficient. (Source: Codex Context Compiler, line 326)
5. **No API keys required.** Uses existing CLI subscriptions. Cost is usage-based through existing subscriptions (see Section 16).
6. **No framework lock-in.** CLI adapters are thin wrappers. Adding a 4th model (e.g., DeepSeek) should require only a new adapter, not architectural changes.

---

## 12. Success Criteria

Measurable, falsifiable. A Senior Engineer can verify each one.

| #   | Criterion                                                                                                                       | Measurement                                                                                | Phase |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----- |
| 1   | A predefined test task ("add /health endpoint returning {status:ok}") completes the full pipeline with zero manual intervention | Endpoint responds correctly after automated merge                                          | 1     |
| 2   | No gate can be skipped programmatically                                                                                         | Unit test: attempt to advance workflow without evidence → blocked                          | 1     |
| 3   | P0 findings block the workflow until human override or fix                                                                      | Integration test: inject P0 finding → verify workflow halts                                | 1     |
| 4   | Tournament mode produces 3 competing implementations and selects a winner                                                       | Run tournament on a real task, verify 3 worktrees, 3 diffs, arbiter selection              | 3     |
| 5   | Context Pack is reproducible from manifest                                                                                      | Given a manifest.json, reconstruct the exact prompt that was sent                          | 2     |
| 6   | Hostile isolation holds — reviewer cannot access builder reasoning                                                              | Verify reviewer Context Pack contains diff + files but zero builder prompt content         | 2     |
| 7   | Temporal recovers from mid-workflow crash                                                                                       | Kill process during build activity, restart, verify workflow resumes                       | 1     |
| 8   | Context Compiler stays within token budget                                                                                      | Measure prompt tokens (tiktoken cl100k_base), verify < 85% of budget for 95% of dispatches | 2     |
| 9   | Requirement coverage reaches 100% before merge                                                                                  | Audit: every requirement in the checklist has file:line + test evidence                    | 4     |
| 10  | All 3 CLI agents dispatch and return results on a real build task                                                               | Each agent builds a module, output compiles and tests pass                                 | 1     |

---

## 13. Risk Register

Source: pre-mortem analysis from Codex Infrastructure (`codex-council-infrastructure.md:96-103`), Gemini Infrastructure (`gemini-council-infrastructure.md:34-39`), and Codex Context Compiler (`codex-council-context.md:442-449`).

| #   | Risk                                               | Severity | Source                     | Mitigation                                                                                                                                             |
| --- | -------------------------------------------------- | -------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Agents bypass review (again)                       | P0       | Audit Section 5            | Temporal state transition requires review attestation in ledger                                                                                        |
| 2   | P0 accepted as "risk" (again)                      | P0       | Audit Section 7            | P0 blocks workflow, no automated override                                                                                                              |
| 3   | Requirements silently dropped (again)              | P0       | Audit Section 2            | Requirement coverage matrix checked at AuditGate                                                                                                       |
| 4   | Reviewers get biased prompts (again)               | P1       | Audit Section 4            | Hostile isolation enforced by Context Compiler — reviewers get diff + rubric only, no builder reasoning                                                |
| 5   | LangGraph becomes decorative infrastructure        | P1       | Codex Decision Round       | Enforcement must be in state transitions, not prompts. _"If 'P0 must block merge' is just text in a prompt, the system fails again."_                  |
| 6   | Impedance mismatch: CLI processes in state machine | P1       | Gemini Decision Round      | Temporal Activities with explicit timeouts/heartbeats handle CLI-specific failure modes                                                                |
| 7   | Can't stream CLI output to user                    | P1       | Gemini Decision Round      | Phase 2. Batch results first. If streaming proves critical, evaluate fallback to MCP server approach.                                                  |
| 8   | Context Compiler omits critical dependency         | P1       | Codex Context Compiler     | MCP fallback for on-demand context, test-map inclusion, caller/callee expansion                                                                        |
| 9   | Prompt too large, quality drops                    | P1       | Codex Context Compiler     | Hard token budgets, task splitting, repo maps over full files                                                                                          |
| 10  | Stale context after concurrent worktree changes    | P0       | Codex Context Compiler     | Hash every context item, verify hashes before applying patches                                                                                         |
| 11  | LangGraph JS can't handle Windows CLI processes    | P1       | Codex Decision Round       | Validate in spike before committing                                                                                                                    |
| 12  | Temporal dev server friction on Windows            | P1       | Architecture discussion    | Validate in spike before committing                                                                                                                    |
| 13  | 15x token overhead at scale                        | P2       | Gemini Context Research    | Prompt caching, context isolation, 40% rule                                                                                                            |
| 14  | Stylistic fragmentation ("Frankenstein codebase")  | P1       | Both constrained proposals | ROUND_TABLE.md enforces naming/patterns. Arbiter evaluation includes style consistency. Accepted risk: 3 models will never write identical-style code. |

---

## 13.1 Error Handling Strategy

Errors fall into two categories:

**Infrastructure errors** (handled by Temporal):

- CLI process timeout → Temporal activity timeout triggers, retry with backoff
- CLI process crash (non-zero exit) → retry up to 2x, then fail the activity
- SQLite write lock contention → `busy_timeout` pragma (5000ms), then fail with clear error
- Worktree creation fails (branch exists) → generate unique branch name with timestamp suffix
- Temporal server crash → workflows resume automatically from last checkpoint on restart

**Agent errors** (handled by workflow logic):

- Agent produces no output → treat as build failure, enter FixLoop or escalate
- Agent modifies forbidden files → diff validation rejects, re-dispatch with stricter prompt
- Agent output unparseable → log raw output to dispatch artifacts, treat as failure
- All tournament entries fail → escalate to human with the best-performing entry's error details
- Reviewer produces zero findings → accept as clean (not an error — code might actually be good)

---

## 14. Build Order

Source: Codex's "What To Build First" (`codex-council-infrastructure.md:48-69`), Codex Context Compiler build order (`codex-council-context.md:451-462`).

### Phase 0: Spike (validate before committing)

Before writing production code, validate the three technical risks identified by the council:

1. **Temporal on Windows:** install `temporal dev server`, create a minimal workflow that spawns a CLI process, verify it works on Windows 11
2. **LangGraph JS + CLI:** create a LangGraph graph with a node that calls `codex exec`, verify fan-out/fan-in with `Send()`
3. **AST repo map:** use Tree-sitter to parse a real TypeScript project, generate a symbol map, verify token count is manageable

Pass/fail for each spike. Fallbacks if a spike fails:

- **Temporal fails on Windows:** fall back to raw Node.js orchestration with `setTimeout`-based retry, JSON file state persistence, and `readline` for human gates. Loses crash recovery and Web UI but the workflow logic stays the same.
- **LangGraph JS fails with CLI processes:** fall back to `Promise.all()` for fan-out, manual reducer function for fan-in. Loses checkpointing and graph visualization but tournament logic is trivial without the framework.
- **Tree-sitter fails (native compilation on Windows):** fall back to regex-based symbol extraction from TypeScript source (`export function`, `export class`, `import { }` patterns). Lower quality repo maps but functional.

### Phase 1: Foundation (The Spine + The Memory)

1. SQLite schema creation + migration tooling
2. Temporal workflow scaffold: IntakeWorkflow → BuildWorkflow → ReviewWorkflow → CompletionWorkflow
3. Gate engine: policy-as-code checks, gate_transitions logging
4. CLI adapters: Codex, Gemini, Claude (thin wrappers with timeout + retry)
5. ROUND_TABLE.md → AGENTS.md / GEMINI.md / CLAUDE.md generator

**Note:** Phase 1 uses hand-crafted Context Packs (plain markdown prompts), not the Context Compiler. The adapter interface accepts a ContextPack regardless of how it was produced. The Context Compiler (Phase 2) replaces hand-crafted packs with generated ones.

**Definition of done:** a hardcoded task can be dispatched to one agent, reviewed by another, gated, and merged — with full evidence trail in SQLite.

### Phase 2: The Lens (Context Compiler)

1. AST repo map generator (Tree-sitter)
2. SQLite-backed symbol index
3. Context scoring algorithm
4. Context Pack writer (manifest + files + evidence)
5. 6-layer prompt renderer (attention-curve aware)
6. Token budget enforcer
7. Scoped MCP context provider

**Definition of done:** Context Compiler produces auditable Context Packs for build and review tasks, stays within token budget, and hostile isolation holds.

### Phase 3: The Brain (Tournament + Evaluation)

1. LangGraph tournament subgraph (fan-out to N agents, fan-in with evaluation)
2. Arbiter node (mechanical comparison: test results, diff size, findings count)
3. FixLoop subgraph (findings → rebuild → re-review, max iterations)
4. Debate subgraph: when two reviewers produce conflicting findings on the same code (one says P0, the other says clean), the disagreement protocol activates. Both findings + the disputed code are sent to a third model as arbiter. The arbiter sees both arguments but not which model produced which. It rules: confirm P0, downgrade to P1, or dismiss. Max 1 debate round per disputed finding. If the arbiter is uncertain, the finding stands at its highest severity. (Source: Gemini free proposal, `gemini-council-build-free.md:36-39`)

**Definition of done:** tournament mode dispatches 3 agents on the same task, arbiter selects winner, full evidence in ledger.

### Phase 4: Production Hardening

1. Temporal Web UI configuration for workflow visibility
2. Requirement coverage matrix verification at AuditGate
3. Human approval flow via Temporal signals
4. Error recovery: retry policies, dead letter queues, escalation
5. Cost tracking per dispatch

**Definition of done:** end-to-end flow from user request to merged code, all 10 success criteria pass, Senior Engineer inspection passed.

---

## 15. Technology Stack

| Component     | Technology              | Version                   | Justification                              |
| ------------- | ----------------------- | ------------------------- | ------------------------------------------ |
| Runtime       | Node.js                 | 20+ LTS                   | User preference, TypeScript ecosystem      |
| Language      | TypeScript              | 5.x                       | Type safety for Context Compiler, adapters |
| Orchestration | Temporal TypeScript SDK | Latest                    | ADR-002                                    |
| AI decisions  | @langchain/langgraph    | Latest                    | ADR-002                                    |
| Database      | SQLite (better-sqlite3) | Latest                    | Local-first, no server, FTS5 support       |
| AST parsing   | tree-sitter             | Latest                    | Repo map generation, symbol extraction     |
| Testing       | vitest                  | Latest                    | Fast, TypeScript-native                    |
| CLI agents    | codex, gemini, claude   | User's installed versions | Zero additional cost                       |

---

## 16. Cost Estimation

Uses existing CLI subscriptions — no additional API keys. Cost depends on subscription tier and usage-based pricing of each provider.

**Estimated tokens per pipeline stage (single feature, ~500 lines of code):**

| Stage                  | Dispatches              | Avg tokens per dispatch | Total tokens |
| ---------------------- | ----------------------- | ----------------------- | ------------ |
| Intake                 | 1 (Claude)              | ~4k                     | ~4k          |
| Plan                   | 1 (Claude)              | ~8k                     | ~8k          |
| Build (single)         | 1 agent                 | ~20k                    | ~20k         |
| Build (tournament)     | 3 agents                | ~20k each               | ~60k         |
| Review                 | 2 reviewers             | ~12k each               | ~24k         |
| Fix Loop (1 iteration) | 1 builder + 2 reviewers | ~16k avg                | ~48k         |
| Audit                  | 1 (Claude)              | ~8k                     | ~8k          |

**Estimated totals:**

- Single-agent build: ~60k tokens (~$0.50-2.00 depending on provider/tier)
- Tournament build: ~100k tokens (~$1.00-4.00)
- Full pipeline with 1 fix loop: ~150k tokens (~$2.00-6.00)

These are rough estimates. Actual cost depends on model, context caching hit rate, and task complexity. The IntakeWorkflow presents a cost estimate to the user before proceeding — user confirms or adjusts scope.

Cost tracking is logged per dispatch in the `dispatches` table (token counts from CLI output parsing where available).

---

## 17. Appendix: Council Transcript Index

All council prompts and responses are preserved in `.council/cross-model/`. This spec references them by filename and line number throughout.

| Round                | Prompt                             | Codex Response                    | Gemini Response                    |
| -------------------- | ---------------------------------- | --------------------------------- | ---------------------------------- |
| 1 (Constrained)      | `prompt-council-build-codex.md`    | `codex-council-build.md`          | `gemini-council-build.md`          |
| 2 (Free)             | `prompt-council-build-free.md`     | `codex-council-build-free.md`     | `gemini-council-build-free.md`     |
| 3 (Decision)         | `prompt-council-decision.md`       | `codex-council-decision.md`       | `gemini-council-decision.md`       |
| 4 (Infrastructure)   | `prompt-council-infrastructure.md` | `codex-council-infrastructure.md` | `gemini-council-infrastructure.md` |
| 5 (Context Research) | `prompt-context-research.md`       | —                                 | `gemini-context-research.md`       |
| 6 (Context Compiler) | `prompt-council-context.md`        | `codex-council-context.md`        | `gemini-council-context.md`        |
| Framework Research   | `prompt-orchestration-research.md` | —                                 | `gemini-orchestration-research.md` |

---

## 18. Methodology Note

This spec was built through iterative multi-model council rounds, not single-author design. Key methodology findings from the process itself:

1. **Constrained prompts produce convergent, safe answers.** When given 7 structured questions and predetermined failure modes, all 3 models produced identical "contract-first worktree dispatch" architectures. This was identified as prompt bias.

2. **Free prompts produce genuinely novel ideas.** When given a 10-line open prompt with zero structure, both external models independently proposed tournament/competitive builds — a concept that never appeared under constrained prompts.

3. **Research before design prevents reinventing the wheel.** The framework research (AutoGen, LangGraph, CrewAI, Temporal, A2A) corrected multiple false assumptions about what existing tools can and cannot do.

4. **The audit as input, not afterthought.** Showing the honest audit (12.5% success rate) to the council produced sharper, more defensive architectures than brainstorming from scratch.

5. **Models arguing for decisions beats models generating options.** The decision round ("pick one, argue why") produced more useful output than the free brainstorm round ("what's your best idea?").

Cannot set property. Property setting is supported only on core types in this language mode.
At line:1 char:1
+ [Console]::OutputEncoding=[System.Text.Encoding]::UTF8;
+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : InvalidOperation: (:) [], RuntimeException
    + FullyQualifiedErrorId : PropertySetterNotSupportedInConstrainedLanguage
 

 succeeded in 542ms:
# Plan: zer0-knights CLI

## Goal

> `npm install -g zer0-knights` works. `zk init` creates `.zk/`. `zk doctor` validates environment. `zk review` dispatches Codex (GPT-5.5, `--sandbox read-only`) and Gemini (`-y -p`) concurrently with 3s stagger, captures output, parses P0/P1/P2 findings, writes attestation to `review-ledger.jsonl` with `file_hashes` and `head_commit`, exits 1 on P0. All 13 commands respond. Works on Windows without bash.

## Tech Stack

- Node.js >= 20, ESM (`"type": "module"`)
- No framework — raw `process.argv` routing
- `@clack/prompts` ^1.3, `chalk` ^5, `ora` ^8, `figlet` ^1
- `child_process.spawn` with `shell: true` for model dispatch
- JSONL for append-only logs, JSON for state
- `node:test` built-in test runner (zero deps)

## File Map

| File                         | Task | Purpose                                                |
| ---------------------------- | ---- | ------------------------------------------------------ |
| `package.json`               | T1   | Package config, bin aliases, ESM                       |
| `bin/cli.js`                 | T1   | Entry point, hashbang, argv routing                    |
| `src/core/state.js`          | T1   | Read/write .zk/state.json (atomic temp+rename)         |
| `src/core/ledger.js`         | T1   | Read/append review-ledger.jsonl and dispatch-log.jsonl |
| `src/core/lock.js`           | T1   | PID-based lock file                                    |
| `src/core/git.js`            | T1   | git diff, hash-object, ls-files, rev-parse wrappers    |
| `src/core/dispatch.js`       | T2   | Spawn codex/gemini, retry, timeout, abort              |
| `src/core/parser.js`         | T2   | Parse model output for P0/P1/P2 table rows             |
| `src/ui/banner.js`           | T3   | ASCII art via figlet + chalk                           |
| `src/ui/menu.js`             | T3   | @clack/prompts select() interactive menu               |
| `src/ui/spinner.js`          | T3   | ora spinner wrapper                                    |
| `src/ui/format.js`           | T3   | chalk formatting helpers                               |
| `src/templates/*.md`         | T4   | 7 bundled prompt templates                             |
| `src/core/templates.js`      | T4   | loadTemplate() utility using import.meta.url           |
| `src/core/args.js`           | T1   | Minimal arg parser (positional, --flags, --key val)    |
| `src/commands/init.js`       | T5   | Create .zk/, write initial state                       |
| `src/commands/doctor.js`     | T5   | Check CLIs, report versions                            |
| `src/commands/status.js`     | T5   | Show knights + project state                           |
| `src/commands/review.js`     | T6   | Core review pipeline                                   |
| `src/commands/audit.js`      | T7   | Git diff vs last review commit                         |
| `src/commands/dispatch.js`   | T7   | Raw dispatch to specific model                         |
| `src/commands/logs.js`       | T7   | Show dispatch-log.jsonl history                        |
| `src/commands/research.js`   | T8   | Research swarm                                         |
| `src/commands/fact-check.js` | T8   | Verify claims via Gemini                               |
| `src/commands/council.js`    | T8   | Architecture council                                   |
| `src/commands/debug.js`      | T8   | Root cause analysis                                    |
| `src/commands/start.js`      | T9   | Load session, suggest next                             |
| `src/commands/handoff.js`    | T9   | Save state, write summary                              |

## Coverage Matrix

| Spec Item                                                    | Task                 |
| ------------------------------------------------------------ | -------------------- |
| I1: dispatch writes to dispatch-log.jsonl                    | T2, T6               |
| I2: review writes attestation with file_hashes + head_commit | T6                   |
| I3: models never see each other's output                     | T2, T4, T6           |
| I4: exit non-zero on P0                                      | T2 (parser), T6      |
| I5: no source modification (--sandbox read-only)             | T2                   |
| I6: all state in .zk/                                        | T1, T5               |
| I7: graceful degradation, partial reviews                    | T6                   |
| I8: shell: true, args as array                               | T2                   |
| I9: 50-file cap                                              | T6                   |
| F: codex/gemini not on PATH                                  | T5 (doctor)          |
| F: model timeout                                             | T2                   |
| F: empty output                                              | T2                   |
| F: rate limit                                                | T2                   |
| F: no .zk/                                                   | T5                   |
| F: no git repo                                               | T5 (init)            |
| F: both fail                                                 | T6                   |
| F: state.json corrupt                                        | T1 (state.js)        |
| F: first review baseline                                     | T6, T1 (git.js)      |
| F: >50 files                                                 | T6                   |
| F: missing P0/P1/P2 markers                                  | T2 (parser)          |
| F: concurrent runs                                           | T1 (lock.js)         |
| A1-A2: install + init                                        | T1, T5               |
| A3: doctor                                                   | T5                   |
| A4: status                                                   | T5                   |
| A5-A10: review                                               | T6                   |
| A11: interactive menu                                        | T3                   |
| A12: Windows                                                 | T10                  |
| A13: all 13 commands                                         | T5-T9                |
| A14-A16: dispatch/audit/logs                                 | T7                   |
| A17: --sandbox read-only -m gpt-5.5                          | T2                   |
| Anti-targets: no dedup, no TUI, no cost tracking             | T10 (verify absence) |

---

## Tasks

### Task 1: Scaffold + Core Infrastructure

<!-- ============ BUILD BRIEF ============ -->

**Spec excerpt:**

> Repo: `~/VibeCoding/zer0-knights/` (standalone, separate from TeamWork).
> `"type": "module"`, `"engines": { "node": ">=20" }`, bin aliases `zer0-knights` and `zk` pointing to `./bin/cli.js`.
> All zer0-knights-owned project state lives in `.zk/` — no global state, no dotfiles outside project (I6).
> `.zk/state.json` — project heartbeat. Atomic writes via write-to-temp + rename.
> `.zk/review-ledger.jsonl` — append-only review attestations.
> `.zk/dispatch-log.jsonl` — append-only dispatch attempts.
> `.zk/lock` — PID-based lock file (created during review, deleted after).
> Concurrent `zk review` runs: `.zk/lock` exists → Error: "Another review is running. PID: [N]" exit 1.
> state.json corrupted → Derive `last_review` from latest `review-ledger.jsonl` entry. Re-create from ledger data.

**Files:**

- CREATE: `~/VibeCoding/zer0-knights/package.json`
- CREATE: `~/VibeCoding/zer0-knights/bin/cli.js`
- CREATE: `~/VibeCoding/zer0-knights/src/core/state.js`
- CREATE: `~/VibeCoding/zer0-knights/src/core/ledger.js`
- CREATE: `~/VibeCoding/zer0-knights/src/core/lock.js`
- CREATE: `~/VibeCoding/zer0-knights/src/core/git.js`

**Acceptance criteria:**

1. `git init` + `npm init` in `~/VibeCoding/zer0-knights/`, package.json matches spec (ESM, bin aliases, engines, deps).
2. `bin/cli.js` has `#!/usr/bin/env node`, reads `process.argv[2]`, routes to command modules via dynamic import, shows help on unknown command.
3. `state.js`: `readState(zkDir)` returns parsed JSON or null. `writeState(zkDir, data)` writes to temp file then `fs.rename` (atomic). On parse error, derives state from ledger.
4. `ledger.js`: `appendEntry(file, obj)` appends JSON line + `\n`. `readEntries(file)` returns array of parsed objects. `getLatestEntry(file)` returns last line parsed.
5. `lock.js`: `acquireLock(zkDir)` writes PID to `.zk/lock`, throws if lock exists and PID is alive. `releaseLock(zkDir)` deletes lock. Stale lock (dead PID) → auto-cleanup.
6. `git.js`: `hashObject(filePath)` returns SHA-1 string (null for deleted files). `lsFiles()` returns array of tracked files. `diffNameOnly(sinceCommit)` returns changed files. `diffNameStatus(sinceCommit)` returns `[{file, status}]` (M/A/D/R). `revParseHead()` returns HEAD SHA. All use `spawnSync` with `shell: true`.
7. `args.js`: `parseArgs(argv)` returns `{ command, positionals, flags }`. Handles `--force` (boolean), `--files` (string), `--` (stop parsing). Unknown flags → error message + exit 1.

**Tests to write FIRST:**

- `tests/core/state.test.js`
  - readState returns null for missing file
  - readState returns parsed JSON for valid file
  - writeState creates file atomically (temp + rename)
  - writeState on corrupt file recovers from ledger
- `tests/core/ledger.test.js`
  - appendEntry creates file if missing
  - appendEntry appends valid JSONL line
  - readEntries returns parsed array
  - getLatestEntry returns last entry
- `tests/core/lock.test.js`
  - acquireLock creates lock with PID
  - acquireLock throws if lock exists with live PID
  - acquireLock cleans stale lock (dead PID)
  - releaseLock deletes lock file
- `tests/core/git.test.js`
  - hashObject returns SHA-1 for known file
  - lsFiles returns tracked files
  - diffNameOnly returns changed files since commit
  - revParseHead returns HEAD SHA

**Scope discipline:**

- No UI output (T3)
- No dispatch logic (T2)
- No commands (T5+)

<!-- ============ END BUILD BRIEF ============ -->

<!-- ============ AUDIT RUBRIC ============ -->

**L1 grep:**

- `"type": "module"` → must exist in `package.json`
- `#!/usr/bin/env node` → must exist in `bin/cli.js`
- `fs.rename` or `rename` → must exist in `state.js` (atomic write)
- `process.argv` → must exist in `bin/cli.js`
- `shell: true` → must exist in `git.js`
- `commander` → must NOT exist in `package.json` or any `src/` file

**L2 behavioral:**

- Verify I6: no files created outside `.zk/` during any operation
- Verify lock prevents concurrent access
- Verify state recovery from corrupt JSON

**Anti-targets:**

- No `import.*commander` anywhere
- No `import.*yargs` anywhere

**Done:** tests green + L1 pass + L2 pass.

<!-- ============ END AUDIT RUBRIC ============ -->

---

### Task 2: Dispatch Engine + Parser

<!-- ============ BUILD BRIEF ============ -->

**Spec excerpt:**

> Codex invocation: `spawn('codex', ['exec', '--sandbox', 'read-only', '-m', 'gpt-5.5', '-'], { stdio: ['pipe', 'pipe', 'pipe'], shell: true })`. Prompt piped via stdin. Output captured from stdout. `--sandbox read-only` enforces I5.
>
> Gemini invocation: `spawn('gemini', ['-y', '-p', promptSlice], { stdio: ['pipe', 'pipe', 'pipe'], shell: true })`. `-y` auto-approves. `-p` ensures headless mode. Full prompt on stdin.
>
> Timeout: `AbortController` with 300s default. On abort: spawn emits error with `code: 'ABORT_ERR'`.
>
> Stagger: Codex at T+0, Gemini at T+3s. Both awaited via `Promise.allSettled`.
>
> Retry: on rate limit (stderr matches `/quota|rate.limit|429|RESOURCE_EXHAUSTED/i`), backoff 5s, 15s, 30s (3 attempts max). On empty output: auto-retry once (5s).
>
> Every dispatch writes an entry to `.zk/dispatch-log.jsonl` — serialized AFTER spawn completes, never during (I1).
>
> Parser regex: `/^\|\s*\d+\s*\|\s*(P[012])\s*\|/gm`. If 0 matches: warn "Could not parse findings", save raw output, count as 0 findings.

**Files:**

- CREATE: `src/core/dispatch.js`
- CREATE: `src/core/parser.js`

**Acceptance criteria:**

1. `dispatchModel(model, promptContent, options)` spawns the correct CLI with the correct args per spec. Returns `{ stdout, stderr, exitCode, signal, duration, attempts }`.
2. Codex spawned with `['exec', '--sandbox', 'read-only', '-m', 'gpt-5.5', '-']`. Gemini spawned with `['-y', '-p', promptSlice]`. Both with `shell: true`.
3. Timeout after 300s (configurable) via AbortController. On timeout, child is killed, result has `status: 'timeout'`.
4. On rate limit stderr pattern, retries with 5s, 15s, 30s backoff. Max 3 attempts.
5. On empty stdout, retries once with 5s backoff.
6. `parseFindings(output)` returns `{ p0: N, p1: N, p2: N, total: N, rows: [...] }`. Each row has `{ severity, fileLine, finding, fix }`.
7. When regex finds 0 matches, returns `{ p0: 0, p1: 0, p2: 0, total: 0, rows: [], unparseable: true }`.
8. File paths NEVER interpolated into command strings — always passed as array elements.

**Tests to write FIRST:**

- `tests/core/dispatch.test.js`
  - dispatchModel('codex', ...) spawns with correct args
  - dispatchModel('gemini', ...) spawns with correct args
  - timeout kills child after configured duration
  - rate limit stderr triggers retry with backoff
  - empty output triggers single retry
  - successful dispatch returns stdout + metadata
  - both models use shell: true
- `tests/core/parser.test.js`
  - parseFindings extracts P0/P1/P2 from table format
  - parseFindings counts severities correctly
  - parseFindings returns unparseable:true when no table rows
  - parseFindings handles mixed severity in one output
  - parseFindings ignores non-table lines

**Scope discipline:**

- No UI (T3) — dispatch returns data, doesn't print
- No ledger writes (T6 handles write sequencing)
- No review pipeline logic (T6)

<!-- ============ END BUILD BRIEF ============ -->

<!-- ============ AUDIT RUBRIC ============ -->

**L1 grep:**

- `--sandbox.*read-only` → must exist in `dispatch.js`
- `gpt-5.5` → must exist in `dispatch.js`
- `AbortController` → must exist in `dispatch.js`
- `shell: true` → must exist in `dispatch.js`
- `/P[012]/` or equivalent → must exist in `parser.js`

**L2 behavioral:**

- Verify I5: Codex ALWAYS gets `--sandbox read-only`
- Verify I8: file paths as array args, never string interpolation
- Verify retry logic with simulated 429 stderr

**L3-sec:**

- Threat: prompt content with shell metacharacters → verify args are array elements, not interpolated

**Done:** tests green + L1 pass + L2 pass + L3-sec pass.

<!-- ============ END AUDIT RUBRIC ============ -->

---

### Task 3: UI Layer

<!-- ============ BUILD BRIEF ============ -->

**Spec excerpt:**

> `bin/cli.js` entry point with `process.argv` routing. No-args → interactive menu via `@clack/prompts select()`.
> ASCII art via figlet + chalk. Ora spinner wrapper.
>
> Journey 5: `zk` no-args shows: "Zer0's Round Table" banner, then select menu with options: Run a Review, Check Status, Environment Doctor, Dispatch (raw), Logs, Exit.

**Files:**

- CREATE: `src/ui/banner.js`
- CREATE: `src/ui/menu.js`
- CREATE: `src/ui/spinner.js`
- CREATE: `src/ui/format.js`

**Acceptance criteria:**

1. `showBanner()` prints figlet-rendered "Zer0's Round Table" text to stdout via chalk.
2. `showMenu()` displays `@clack/prompts` `select()` with options mapping to command names. Returns the selected command string.
3. `createSpinner(text)` returns an ora spinner. `spinner.update(text)` changes label. `spinner.succeed(text)` / `spinner.fail(text)` for completion.
4. `format.js` exports: `success(text)`, `warn(text)`, `error(text)`, `info(text)` — colored via chalk.
5. When stdin is not a TTY (piped/CI), `showMenu()` prints help text instead of interactive prompt.

**Tests to write FIRST:**

- `tests/ui/banner.test.js`
  - showBanner outputs figlet text (check stdout contains expected pattern)
- `tests/ui/format.test.js`
  - success/warn/error/info return chalk-formatted strings
- `tests/ui/menu.test.js`
  - showMenu returns valid command string (mock @clack/prompts)

**Scope discipline:**

- No command logic — menu returns a string, cli.js dispatches
- No dispatch calls

<!-- ============ END BUILD BRIEF ============ -->

<!-- ============ AUDIT RUBRIC ============ -->

**L1 grep:**

- `import.*figlet` → must exist in `banner.js`
- `import.*chalk` → must exist in `banner.js` or `format.js`
- `select` → must exist in `menu.js` (from @clack/prompts)
- `import.*ora` → must exist in `spinner.js`

**L2 behavioral:**

- Verify A11: no-args shows interactive menu
- Verify non-TTY fallback prints help

**Done:** tests green + L1 pass.

<!-- ============ END AUDIT RUBRIC ============ -->

---

### Task 4: Prompt Templates

<!-- ============ BUILD BRIEF ============ -->

**Spec excerpt:**

> Both models receive this output format instruction in their review prompts:
>
> ```
> ## Required Output Format
> Report findings in this EXACT table format. One row per finding.
> Use ONLY these severity levels: P0 (critical), P1 (important), P2 (nit).
> | # | Severity | File:Line | Finding | Suggested Fix |
> |---|----------|-----------|---------|---------------|
> After the table, write a one-paragraph summary.
> Do NOT use other severity labels (Critical, High, Medium, etc.).
> Do NOT reference other reviewers or other models.
> Do NOT modify any source files.
> ```
>
> Templates bundled in `src/templates/` — standalone, no v23 dependency (Q3 resolved).

**Files:**

- CREATE: `src/templates/quality-floor.md`
- CREATE: `src/templates/review-prompt-codex.md`
- CREATE: `src/templates/review-prompt-gemini.md`
- CREATE: `src/templates/research-prompt.md`
- CREATE: `src/templates/fact-check-prompt.md`
- CREATE: `src/templates/council-prompt.md`
- CREATE: `src/templates/debug-prompt.md`
- CREATE: `src/core/templates.js`

**Acceptance criteria:**

1. `review-prompt-codex.md` includes: hostile review framing, quality floor (severity definitions), output format contract (P0/P1/P2 table), instruction to cite file:line, instruction to NOT modify source, instruction to NOT reference other reviewers.
2. `review-prompt-gemini.md` includes same contract, adapted for Gemini (instruction to use Google Search for factual claims).
3. Both templates have a `{{FILES}}` placeholder that `review.js` replaces with the actual file list + content.
4. `quality-floor.md` defines P0/P1/P2 severity, hostile review stance, evidence requirements.
5. `fact-check-prompt.md` instructs Gemini to use Google Search to verify each claim, output verdict table.
6. `research-prompt.md`, `council-prompt.md`, `debug-prompt.md` have the same output structure but different objectives.
7. A `loadTemplate(name)` utility in a new `src/core/templates.js` reads template files relative to package root using `import.meta.url`.

**Tests to write FIRST:**

- `tests/core/templates.test.js`
  - loadTemplate('review-prompt-codex') returns string content
  - loadTemplate('nonexistent') throws with clear error
  - all 7 templates exist and are non-empty
  - review templates contain the output format contract text

**Scope discipline:**

- Templates are static markdown files — no code logic inside them
- Template LOADING is in `src/core/templates.js`, not in command files

<!-- ============ END BUILD BRIEF ============ -->

<!-- ============ AUDIT RUBRIC ============ -->

**L1 grep:**

- `P0.*critical` → must exist in both review templates
- `Do NOT modify` → must exist in both review templates
- `Do NOT reference other` → must exist in both review templates
- `{{FILES}}` → must exist in both review templates

**L2 behavioral:**

- Verify I3: review templates instruct model not to reference other reviewers
- Verify I5: review templates instruct model not to modify source

**Done:** tests green + L1 pass + L2 pass.

<!-- ============ END AUDIT RUBRIC ============ -->

---

### Task 5: Core Commands (init, doctor, status)

<!-- ============ BUILD BRIEF ============ -->

**Spec excerpt:**

> Journey 1 — `zk init`: Creates .zk/, state.json, review-ledger.jsonl, dispatch-log.jsonl, quality-floor.md. Errors if not a git repo.
>
> Journey 2 — `zk doctor`: Checks Node.js >= 20, git, codex (reports version + "GPT-5.5 via -m flag"), gemini (reports version + model), .zk/ initialized. Red status + install instructions if CLI missing.
>
> Journey 3 — `zk status`: Shows knight table (Codex GPT-5.5 | Gemini 3.1 Pro), project name, reviews count, last review, unreviewed file count (git diff since last review commit).
>
> No `.zk/` directory → any command except init/doctor → Error: "Not initialized. Run: zk init" exit 1.
> No git repo → `zk init` → Error: "Must be in a git repository" exit 1.

**Files:**

- CREATE: `src/commands/init.js`
- CREATE: `src/commands/doctor.js`
- CREATE: `src/commands/status.js`

**Acceptance criteria:**

1. `zk init` in a git repo: creates `.zk/` with `state.json` (project name from dir, initialized timestamp, empty knights), empty `review-ledger.jsonl`, empty `dispatch-log.jsonl`, `quality-floor.md` copied from templates. Exits 0.
2. `zk init` outside git: prints error, exits 1.
3. `zk init` when `.zk/` already exists: idempotent — creates missing files, never truncates existing ledgers.
4. `zk doctor`: probes `node --version`, `git --version`, `codex --version`, `gemini --version` via `spawnSync`. Reports version or NOT FOUND. Exits 0 if all present, exits 1 if any missing.
5. `zk status`: reads state.json, reads latest ledger entry for last review info, runs `git diff --name-only` against `last_review_commit` for unreviewed count. Prints formatted table.
6. All three commands show the banner via `showBanner()`.

**Tests to write FIRST:**

- `tests/commands/init.test.js`
  - creates .zk/ with all expected files in a git repo
  - errors outside git repo
  - idempotent — doesn't truncate existing ledgers
- `tests/commands/doctor.test.js`
  - reports versions for all available CLIs
  - reports NOT FOUND for missing CLI
  - exits 0 when all present, 1 when missing
- `tests/commands/status.test.js`
  - shows correct knight table after init
  - shows unreviewed count after file changes

**Scope discipline:**

- No dispatch logic — doctor only checks CLI presence, doesn't dispatch
- No review pipeline

<!-- ============ END BUILD BRIEF ============ -->

<!-- ============ AUDIT RUBRIC ============ -->

**L1 grep:**

- `git rev-parse` or `isGitRepo` → must exist in `init.js`
- `spawnSync.*--version` → must exist in `doctor.js`
- `readState` → must exist in `status.js`

**L2 behavioral:**

- Verify F: "no git repo" → init errors
- Verify F: "no .zk/" → status errors
- Verify A2: init creates correct files
- Verify A3: doctor detects CLIs

**Done:** tests green + L1 pass + L2 pass.

<!-- ============ END AUDIT RUBRIC ============ -->

---

### Task 6: Review Command (Core Pipeline)

<!-- ============ BUILD BRIEF ============ -->

**Spec excerpt:**

> `zk review` dispatches both models concurrently with 3s stagger (Codex at T+0, Gemini at T+3s) via `Promise.allSettled`.
>
> File selection: all files changed since `head_commit` in last ledger entry via `git diff --name-only`. First review (empty ledger) → all tracked files via `git ls-files`. Max 50 files — above 50, warn and require `--force` or `--files` filter (I9).
>
> Hostile isolation: outputs written to OS temp dir first, moved to `.zk/reviews/{timestamp}-{runid}/` AFTER both complete. `.zk/` excluded from review context (I3).
>
> Write serialization: (1) both spawns finish, (2) move temp outputs, (3) write dispatch-log entries, (4) write review-ledger entry, (5) update state.json atomic, (6) delete lock.
>
> Graceful degradation: if one model fails, other's review still saves. Partial reviews get ledger entries with `failed_reviewers` field (I7).
>
> Exit code: 1 if any P0 found, 0 otherwise (I4).
>
> Synthesis: CONCATENATION + simple P0/P1/P2 count. No automated dedup (anti-target).
>
> Lock file: acquire before dispatch, release after all writes. Concurrent run → error.

**Files:**

- CREATE: `src/commands/review.js`

**Acceptance criteria:**

1. Acquires lock. On existing lock with live PID → exit 1.
2. Determines file list: `git diff --name-only` since last review commit, or `git ls-files` for first review.
3. Rejects if >50 files unless `--force` passed.
4. Reads file content and prompt template, replaces `{{FILES}}` placeholder.
5. Dispatches Codex at T+0, waits 3s, dispatches Gemini, awaits both via `Promise.allSettled`.
6. On both success: moves outputs from temp to `.zk/reviews/`, writes dispatch-log, writes ledger with file_hashes + head_commit, updates state.json, releases lock.
7. On one failure: saves successful review, writes partial ledger entry with `failed_reviewers: ["codex"]`, prints warning.
8. On both failure: prints error, exits 1, no ledger entry, releases lock.
9. Parses findings from each output, prints concatenated reviews + summary count.
10. Exits 1 if total P0 > 0, exits 0 otherwise.

**Tests to write FIRST:**

- `tests/commands/review.test.js`
  - acquires lock before dispatch
  - first review uses git ls-files
  - subsequent review uses git diff since last commit
  - rejects >50 files without --force
  - accepts >50 files with --force
  - dispatches codex then gemini with 3s stagger
  - writes correct ledger entry after success
  - handles one model failure gracefully
  - handles both models failing
  - exits 1 on P0, exits 0 otherwise
  - releases lock on success and failure

**Scope discipline:**

- No automated dedup synthesis (anti-target)
- No GitHub PR integration
- No pre-commit hook wiring

<!-- ============ END BUILD BRIEF ============ -->

<!-- ============ AUDIT RUBRIC ============ -->

**L1 grep:**

- `acquireLock` → must exist in `review.js`
- `releaseLock` → must exist in `review.js` (in finally block)
- `Promise.allSettled` → must exist in `review.js`
- `file_hashes` → must exist in `review.js`
- `head_commit` → must exist in `review.js`
- `failed_reviewers` → must exist in `review.js`
- `--force` → must exist in `review.js`

**L2 behavioral:**

- Verify I1: dispatch-log written after both complete
- Verify I2: ledger has file_hashes + head_commit
- Verify I3: outputs go to temp first, moved after both complete
- Verify I4: exit 1 on P0
- Verify I7: partial review saves on one failure
- Verify I9: 50-file cap enforced
- Verify F: first review uses all tracked files
- Verify write serialization order: dispatch-log → ledger → state → unlock

**Done:** tests green + L1 pass + L2 pass.

<!-- ============ END AUDIT RUBRIC ============ -->

---

### Task 7: Secondary Commands (audit, dispatch, logs)

<!-- ============ BUILD BRIEF ============ -->

**Spec excerpt:**

> Journey 7 — `zk audit`: Shows files changed since last review commit via `git diff --name-only`. Lists each with status (M/A/D).
>
> Journey 6 — `zk dispatch codex "prompt" --files src/auth.ts`: Raw dispatch to specific model. Saves output to `.zk/reviews/dispatch-{timestamp}/`.
>
> Journey 8 — `zk logs`: Shows recent dispatches from dispatch-log.jsonl formatted as table (date, command, models, duration, findings).

**Files:**

- CREATE: `src/commands/audit.js`
- CREATE: `src/commands/dispatch.js`
- CREATE: `src/commands/logs.js`

**Acceptance criteria:**

1. `zk audit`: reads last review commit from ledger, runs git diff, lists changed files with M/A/D/R status. If no prior review, shows "No reviews yet. Run: zk review".
2. `zk dispatch <model> "<prompt>"`: dispatches to specified model with given prompt, saves output, writes dispatch-log entry. Accepts `--files` flag to scope context.
3. `zk logs`: reads dispatch-log.jsonl, formats last 20 entries as table (timestamp, command, model, duration, findings count, P0 count).

**Tests to write FIRST:**

- `tests/commands/audit.test.js`
  - shows changed files since last review
  - handles no prior review
- `tests/commands/dispatch.test.js`
  - dispatches to codex with prompt
  - dispatches to gemini with prompt
  - saves output to correct directory
- `tests/commands/logs.test.js`
  - formats dispatch history as table
  - handles empty log

**Scope discipline:**

- No review pipeline logic — dispatch is raw, no attestation

<!-- ============ END BUILD BRIEF ============ -->

<!-- ============ AUDIT RUBRIC ============ -->

**L1 grep:**

- `diffNameOnly` or `git diff` → must exist in `audit.js`
- `dispatchModel` → must exist in `commands/dispatch.js`
- `readEntries` → must exist in `logs.js`

**Done:** tests green + L1 pass.

<!-- ============ END AUDIT RUBRIC ============ -->

---

### Task 8: Advanced Commands (research, fact-check, council, debug)

<!-- ============ BUILD BRIEF ============ -->

**Spec excerpt:**

> Journey 9 — `zk research "topic"`: Dispatches both models with research prompt. Codex focuses on GitHub repos/tech stacks. Gemini focuses on Google Search/docs. Saves to `.zk/research/`.
>
> Journey 10 — `zk fact-check file.md`: Reads file, extracts text, dispatches Gemini with fact-check prompt. Saves to `.zk/fact-checks/`.
>
> Journey 11 — `zk council "question"`: Dispatches both models independently with council prompt. Presents proposals anonymously (Proposal A, Proposal B). Saves to `.zk/council/`.
>
> Journey 12 — `zk debug` (pipe mode): Reads stdin when piped (`npm test 2>&1 | zk debug`). Dispatches both models with error context + debug prompt. Saves to `.zk/debug/`.

**Files:**

- CREATE: `src/commands/research.js`
- CREATE: `src/commands/fact-check.js`
- CREATE: `src/commands/council.js`
- CREATE: `src/commands/debug.js`

**Acceptance criteria:**

1. `zk research "topic"`: loads research-prompt template, inserts topic, dispatches codex + gemini concurrently with 3s stagger, saves outputs to `.zk/research/{date}-{slug}/`.
2. `zk fact-check file.md`: reads file content, loads fact-check template (Gemini-only), dispatches gemini, saves to `.zk/fact-checks/`.
3. `zk council "question"`: loads council template, dispatches both, saves proposals anonymously (shuffled order) to `.zk/council/{date}-{slug}/`.
4. `zk debug`: reads stdin (piped), loads debug template, dispatches both with error context, saves to `.zk/debug/{timestamp}/`.
5. All four write dispatch-log entries.

**Tests to write FIRST:**

- `tests/commands/research.test.js`
  - dispatches both models with research prompt
  - saves outputs to correct directory
- `tests/commands/fact-check.test.js`
  - dispatches gemini with fact-check prompt
  - reads input file content
  - saves verification results
- `tests/commands/council.test.js`
  - dispatches both models independently
  - presents proposals anonymously (no model names in output)
- `tests/commands/debug.test.js`
  - reads stdin when piped
  - dispatches with error context

**Scope discipline:**

- No dedup synthesis
- No automated claim extraction for fact-check (user provides the file, Gemini extracts)

<!-- ============ END BUILD BRIEF ============ -->

<!-- ============ AUDIT RUBRIC ============ -->

**L1 grep:**

- `loadTemplate('research-prompt')` → must exist in `research.js`
- `loadTemplate('council-prompt')` → must exist in `council.js`
- `loadTemplate('debug-prompt')` → must exist in `debug.js`
- `process.stdin` → must exist in `debug.js`

**L2 behavioral:**

- Verify I3 for council: proposals presented without model names

**Done:** tests green + L1 pass + L2 pass.

<!-- ============ END AUDIT RUBRIC ============ -->

---

### Task 9: Session Commands (start, handoff)

<!-- ============ BUILD BRIEF ============ -->

**Spec excerpt:**

> Journey 13 — `zk start`: Reads state.json, reads latest review summary, shows last review info + pending findings + changed files since. Suggests next action.
>
> `zk handoff`: Updates state.json with current progress. Writes `.zk/summaries/session-{date}.md` with: what was done, open findings, next actions.

**Files:**

- CREATE: `src/commands/start.js`
- CREATE: `src/commands/handoff.js`

**Acceptance criteria:**

1. `zk start`: reads state.json + latest ledger entry, prints summary (last review time, P0 count, files changed since), suggests "zk review" if files changed.
2. `zk handoff`: writes `.zk/summaries/session-{date}.md` with state snapshot, updates state.json.

**Tests to write FIRST:**

- `tests/commands/start.test.js`
  - shows last review info
  - suggests review when files changed
- `tests/commands/handoff.test.js`
  - writes session summary file
  - updates state.json

**Scope discipline:**

- No cross-session state beyond what's in .zk/

<!-- ============ END BUILD BRIEF ============ -->

<!-- ============ AUDIT RUBRIC ============ -->

**L1 grep:**

- `readState` → must exist in `start.js`
- `writeState` → must exist in `handoff.js`
- `summaries/session-` → must exist in `handoff.js`

**Done:** tests green + L1 pass.

<!-- ============ END AUDIT RUBRIC ============ -->

---

### Task 10 (FINAL): E2E Runtime Verification

**Goal:** Prove the built system runs end-to-end with real Codex and Gemini CLIs.

**Steps (all must exit 0):**

1. `cd ~/VibeCoding/zer0-knights && npm install` — install deps.
2. `npm link` — make `zk` available globally.
3. Create test project: `mkdir /tmp/zk-test && cd /tmp/zk-test && git init && echo "const x = eval(input)" > bad.js && git add . && git commit -m "init"`.
4. `zk init` → verify `.zk/` created with 4 files.
5. `zk doctor` → verify codex + gemini detected, exits 0.
6. `zk status` → verify knights shown, "No reviews yet".
7. `zk review` → verify dispatches both models, captures output, writes ledger with file_hashes + head_commit, exits 1 (bad.js should trigger P0 for eval).
8. `zk status` → verify review count = 1, last review shown.
9. `zk audit` → verify "No files changed since last review".
10. `echo "more bad" >> bad.js && zk audit` → verify 1 file changed.
11. `zk logs` → verify dispatch history shows the review.
12. `zk dispatch codex "What does bad.js do?"` → verify raw dispatch works.
13. `zk` (no args) → verify interactive menu appears (or help if non-TTY).
14. All 13 commands respond to `zk <cmd>` without crashing.
15. Verify: no files created outside `.zk/` and project root.
16. Clean up: `rm -rf /tmp/zk-test`.

**Done:** every step exits 0 and produces expected output. Otherwise the entire plan is RED.

---

## Build Sequence

Tasks can be partially parallelized:

```
T1 (scaffold + core) ──────────────┐
                                    ├── T5 (init/doctor/status)
T2 (dispatch + parser) ────────────┤
                                    ├── T6 (review) ─── T7 (audit/dispatch/logs)
T3 (UI) ───────────────────────────┤                    T8 (research/council/debug)
                                    │                    T9 (start/handoff)
T4 (templates) ────────────────────┘
                                                         T10 (E2E) ← LAST
```

T1-T4 are independent (different files). T5+ depends on T1-T4. T6 depends on T2+T4. T10 is always last.

Cannot set property. Property setting is supported only on core types in this language mode.
At line:1 char:1
+ [Console]::OutputEncoding=[System.Text.Encoding]::UTF8;
+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : InvalidOperation: (:) [], RuntimeException
    + FullyQualifiedErrorId : PropertySetterNotSupportedInConstrainedLanguage
 

 succeeded in 537ms:
# Domain Context: zer0-knights CLI

**Domain:** Developer CLI tooling, multi-model AI orchestration, code review automation
**Reference products:** gh (GitHub CLI), codex (OpenAI CLI), gemini (Google CLI)
**Architecture pattern:** commander-less Node.js CLI with process.argv routing, child_process.spawn for model dispatch
**Failure modes:** CLI not on PATH, model rate limits (429), empty output, timeout, Windows .cmd wrapper issues, JSONL corruption from concurrent writes
**Key vocabulary:** dispatch, spawn, hostile review, quality floor, review ledger, attestation, findings, P0/P1/P2 severity
**Competitors:** MCO (295 stars, Python, generic orchestrator), diffray (13 stars, TS), Open Code Review (152 stars, TS)
**Differentiator:** hostile isolation (models don't see each other), structured evidence (file:line), mechanical enforcement (review ledger), uses existing CLI subscriptions

Cannot set property. Property setting is supported only on core types in this language mode.
At line:1 char:1
+ [Console]::OutputEncoding=[System.Text.Encoding]::UTF8;
+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : InvalidOperation: (:) [], RuntimeException
    + FullyQualifiedErrorId : PropertySetterNotSupportedInConstrainedLanguage
 

codex
Below is the operational build blueprint. This is the day-1 engineering plan, not another spec.

**Core Position**
Zer0 Agent CI is implemented as deterministic Temporal workflows plus side-effecting activities. Agents never advance state. They only produce artifacts. Gates are TypeScript functions that read evidence from SQLite/blobs/worktrees and return `PASS | FAIL | BLOCKED`.

The first production build must ship the spine before cleverness: Temporal, SQLite ledger, blob store, CLI adapters, gate engine, structured review, and `zer0 start/status/resume/doctor`. Context Compiler, Intent Compiler, tournament mode, and Promptfoo hardening layer on top of that spine.

**1. Temporal Structure**
Primary task queue:

```ts
const TASK_QUEUE = "zer0-agent-ci-v1";
```

Workflows:

```ts
Zer0RunWorkflow
InitWorkflow
ReconWorkflow
IntentCompileWorkflow
VisionQAWorkflow
ResearchWorkflow
SpecWorkflow
ArchitectureWorkflow
PlanWorkflow
BuildRunWorkflow
BuildPacketWorkflow
ReviewPacketWorkflow
FixLoopWorkflow
FinalAuditWorkflow
ShipWorkflow
TournamentPacketWorkflow
PromptEvalWorkflow
```

Core workflow ownership:

| Workflow | Owns | Never Does |
| --- | --- | --- |
| `Zer0RunWorkflow` | Full run lifecycle and phase transitions | CLI subprocess calls |
| `BuildRunWorkflow` | Dependency ordering, packet scheduling, prefetch | Build implementation |
| `BuildPacketWorkflow` | One build packet from context to BuildGate | Review |
| `ReviewPacketWorkflow` | Fresh hostile review and ReviewGate | Fixing |
| `FixLoopWorkflow` | Builder retry + blind re-review | Human override |
| `TournamentPacketWorkflow` | Parallel worktrees, arbiter, winner promotion | Main workflow state |
| `FinalAuditWorkflow` | Requirement coverage and ship readiness | Agent dispatch |
| `ShipWorkflow` | Human approval and final action | Automated merge without signal |

Activities:

```ts
validateEnvironmentActivity
initializeZer0DirectoryActivity
initializeSqliteActivity
initializeBlobStoreActivity
createRunRecordActivity
healthCheckAgentCliActivity
verifyTemporalReachableActivity

scanRepositoryActivity
extractTypeDeclarationsActivity
generateRepoMapActivity
detectStackActivity
writeReconArtifactsActivity

compileIntentActivity
validateIntentBriefActivity
writeIntentArtifactsActivity

dispatchResearchAgentActivity
synthesizeResearchActivity
validateResearchGateActivity

compileSpecActivity
crossReviewSpecActivity
validateSpecGateActivity

compileArchitectureActivity
crossReviewArchitectureActivity
validateArchitectureGateActivity

decomposePlanActivity
writeContractsActivity
validatePlanGateActivity

resolveNextBuildPacketsActivity
createWorktreeActivity
compileContextPackActivity
prefetchContextPackActivity
scanPromptForSecretsActivity
dispatchBuilderActivity
captureWorktreeDiffActivity
validateOwnershipActivity
runMechanicalClampsActivity
detectSlopActivity
transpileDeclarationsActivity
updateBuildManifestActivity
updateRequirementCoverageActivity
validateBuildGateActivity
cleanupWorktreeActivity

compileReviewContextActivity
dispatchReviewerActivity
parseRubricReviewActivity
validateReviewGateActivity
verifyPriorFindingChangedActivity
recordFindingsActivity

evaluateStabilitySignalsActivity
recompileContextForFailureActivity
splitPacketActivity
switchBuilderFamilyActivity
escalateArchitectureReviewActivity

runFinalAuditActivity
validateAuditGateActivity
writeShipReportActivity
createPullRequestActivity
mergePullRequestActivity
```

Signals:

```ts
answerVisionQuestionSignal
deferVisionQuestionSignal
approveHumanGateSignal
rejectHumanGateSignal
overrideGateSignal
pauseRunSignal
resumeRunSignal
cancelRunSignal
setRunModeSignal
approveDependencySignal
approvePacketSplitSignal
approveShipSignal
rejectShipSignal
```

Queries:

```ts
getRunStatusQuery
getCurrentPhaseQuery
getPendingHumanActionQuery
getGateStateQuery
getFindingsQuery
getRequirementCoverageQuery
getContextPackQuery
getCostQuery
getTimelineQuery
getAgentHealthQuery
getTournamentResultsQuery
```

**2. Automatic Gate Firing**
There is no “agent says build done” trigger. Build completion is detected only when `dispatchBuilderActivity` exits and the deterministic workflow runs the evidence chain.

Exact sequence inside `BuildPacketWorkflow`:

```ts
const context = await compileContextPackActivity(packet);
await scanPromptForSecretsActivity(context);

const result = await dispatchBuilderActivity({
  packetId,
  contextHash: context.hash,
  worktreePath,
  agent: packet.builderAgent,
});

const diff = await captureWorktreeDiffActivity(worktreePath);

await validateOwnershipActivity({ packet, diff });
await runMechanicalClampsActivity({ packet, worktreePath });
await detectSlopActivity({ diff });
await transpileDeclarationsActivity({ changedFiles: diff.files });
await updateBuildManifestActivity({ packet, diff });
await updateRequirementCoverageActivity({ packet, diff });

const gate = await validateBuildGateActivity({ packet, diff, result });

if (gate.passed) {
  return {
    status: "BUILD_PASSED",
    packetId,
    diffBlob: diff.blobHash,
    headCommit: diff.headCommit,
  };
}

return {
  status: "BUILD_FAILED",
  packetId,
  gate,
};
```

Then `BuildRunWorkflow` automatically starts review:

```ts
const buildResult = await executeChild(BuildPacketWorkflow, { args: [packet] });

if (buildResult.status === "BUILD_PASSED") {
  const reviewResult = await executeChild(ReviewPacketWorkflow, {
    args: [{
      packetId: buildResult.packetId,
      diffBlob: buildResult.diffBlob,
      headCommit: buildResult.headCommit,
    }],
  });

  if (reviewResult.verdict === "PASS") {
    markPacketComplete(packet.id);
  } else {
    await executeChild(FixLoopWorkflow, {
      args: [packet, reviewResult],
    });
  }
}
```

That is the automatic review spawn. The trigger is not stdout text. It is `BuildGate passed === true`.

**3. `zer0 start` To Shipped**
1. User runs:

```bash
zer0 start --vision "Build the app..."
```

2. CLI calls Temporal client:

```ts
client.workflow.start(Zer0RunWorkflow, {
  workflowId: `zer0-${runId}`,
  taskQueue: "zer0-agent-ci-v1",
  args: [{ vision, cwd, mode }],
});
```

3. `Zer0RunWorkflow` runs `InitWorkflow`.

4. `InitWorkflow` creates `.zer0/`, SQLite DB, blob folders, run row, and checks `codex`, `claude`, `gemini`, `git`, `node`, `temporal`.

5. Existing repo path runs `ReconWorkflow`.

6. `IntentCompileWorkflow` dispatches Claude with raw vision and writes intent artifacts.

7. `VisionQAWorkflow` blocks on unanswered questions unless mode is `auto` and defaults are allowed.

8. `ResearchWorkflow` dispatches Gemini, Codex, Claude in parallel. Gate passes with 2 of 3 reports plus synthesis.

9. `SpecWorkflow` creates full spec. Codex cross-reviews it.

10. `ArchitectureWorkflow` creates architecture doc. Codex cross-reviews it.

11. `PlanWorkflow` creates build packets and `contracts.ts`. `PlanGate` checks requirement assignment, ownership overlap, dependency cycles, and contract compilation.

12. `BuildRunWorkflow` topologically sorts packets.

13. For each ready packet:
    - creates worktree
    - compiles context pack
    - scans secrets
    - dispatches builder
    - captures diff
    - runs BuildGate
    - automatically launches `ReviewPacketWorkflow`

14. `ReviewPacketWorkflow` compiles hostile review context and dispatches cross-family reviewer.

15. `ReviewGate` decides:
    - `PASS`: packet complete
    - `PASS_WITH_COMMENTS`: packet complete, P2/P1 below threshold logged
    - `FAIL`: enter `FixLoopWorkflow`

16. `FixLoopWorkflow` sends current code and accepted findings to builder, then runs a fresh blind review. Max 3 rounds.

17. `FinalAuditWorkflow` verifies 100% requirement coverage, all tests, no open P0/P1.

18. `ShipWorkflow` writes ship report and blocks on `approveShipSignal`.

19. User runs:

```bash
zer0 resume --approve
```

20. `ShipWorkflow` creates PR or merges based on mode/config.

**4. Files Created**
Implementation files, created in this order:

```txt
package.json
tsconfig.json
vitest.config.ts
biome.json
src/cli/main.ts
src/cli/router.ts
src/cli/commands/start.ts
src/cli/commands/resume.ts
src/cli/commands/status.ts
src/cli/commands/doctor.ts

src/workflows/zer0-run.workflow.ts
src/workflows/init.workflow.ts
src/workflows/build-run.workflow.ts
src/workflows/build-packet.workflow.ts
src/workflows/review-packet.workflow.ts
src/workflows/fix-loop.workflow.ts
src/workflows/final-audit.workflow.ts
src/workflows/ship.workflow.ts
src/workflows/tournament-packet.workflow.ts

src/activities/init.activities.ts
src/activities/repo.activities.ts
src/activities/context.activities.ts
src/activities/agent.activities.ts
src/activities/gate.activities.ts
src/activities/review.activities.ts
src/activities/stability.activities.ts
src/activities/ship.activities.ts

src/db/schema.sql
src/db/client.ts
src/db/migrations.ts
src/db/ledger.ts

src/blob/blob-store.ts
src/blob/hash.ts

src/agents/adapter.ts
src/agents/codex-adapter.ts
src/agents/claude-adapter.ts
src/agents/gemini-adapter.ts

src/context/types.ts
src/context/indexer.ts
src/context/compress.ts
src/context/assemble.ts
src/context/security.ts
src/context/prefetch.ts

src/gates/types.ts
src/gates/plan-gate.ts
src/gates/build-gate.ts
src/gates/review-gate.ts
src/gates/fix-gate.ts
src/gates/audit-gate.ts
src/gates/human-gate.ts

src/review/rubric-schema.ts
src/review/parser.ts
src/review/finding-dedupe.ts

src/stability/monitor.ts
src/stability/signals.ts
src/stability/responses.ts

src/tournament/langgraph.ts
src/tournament/arbiter.ts
src/tournament/promote-winner.ts

src/templates/static-prefix.md
src/templates/build-endcap.md
src/templates/review-rubric.md
src/templates/intent-compiler.md
src/templates/research/*.md
src/patterns/*.yaml
```

Runtime files, created by `InitWorkflow`:

```txt
.zer0/
.zer0/zer0.sqlite
.zer0/blobs/
.zer0/blobs/{sha-prefix}/{sha}
.zer0/worktrees/
.zer0/tmp/
.zer0/logs/

.council/
.council/runs/{runId}/
.council/runs/{runId}/intent/
.council/runs/{runId}/research/
.council/runs/{runId}/spec/
.council/runs/{runId}/architecture/
.council/runs/{runId}/plan/
.council/runs/{runId}/build/
.council/runs/{runId}/review/
.council/runs/{runId}/audit/
.council/runs/{runId}/ship-report.md
```

Per build packet runtime artifacts:

```txt
.zer0/worktrees/wt-{runId}-{packetId}-{agent}-{timestamp}/
.council/runs/{runId}/build/{packetId}/context-manifest.json
.council/runs/{runId}/build/{packetId}/build-result.json
.council/runs/{runId}/build/{packetId}/build-gate.json
.council/runs/{runId}/review/{packetId}/review-result.json
.council/runs/{runId}/review/{packetId}/review-gate.json
```

The human-readable `.council/` files are projections. SQLite and blobs remain authoritative for evidence.

**5. Context Pack Assembly**
For `BUILD-030`, the Context Compiler does this:

1. Load packet:

```yaml
id: BUILD-030
creates: ["src/api/users.ts"]
modifies: ["src/api/index.ts"]
reads: ["src/auth/service.ts"]
contracts: ["User", "AuthService"]
owned_files: ["src/api/users.ts", "src/api/index.ts"]
forbidden_files: ["src/auth/*"]
acceptance:
  - "Returns 401 for invalid token"
  - "Rate limits to 100 req/min"
```

2. Load current manifest:
    - import graph
    - export summaries
    - known tests
    - requirement map
    - prior findings
    - file hashes

3. Build Hot tier, lossless:
    - full `src/api/index.ts`
    - full create-target placeholder for `src/api/users.ts`
    - full acceptance criteria
    - current failing output, if retry
    - prior accepted findings for fix context
    - current diff, if fix loop
    - human corrections

4. Score Warm candidates:

```ts
score = relevance * importance;
```

Warm examples:
    - `src/auth/service.ts` full or `.d.ts`
    - related auth tests
    - API route registration types
    - validation helpers
    - middleware contracts
    - prior findings in touched files

5. Build Cold tier:
    - every repo file path
    - one-line export summaries
    - architecture summary
    - spec summary
    - requirement list compressed to IDs and short text

6. Compress:
    - TypeScript to declarations with `ts.transpileDeclaration()`
    - SQL to table/schema summaries
    - JSON/YAML to keys and selected values
    - Markdown to headings and linked sections
    - CSS to class names and variables

7. Assemble six layers:
    - static quality floor
    - project contract and `contracts.ts`
    - task brief plus next two consumers
    - Cold + Warm repo context
    - Hot full source/evidence
    - endcap verification instructions

8. Token fit:
    - estimate `chars / 4`
    - never truncate Hot
    - reduce Warm K first
    - compress Cold further second
    - if still too large, return `[BLOCKED: packet too large, split required]`

9. Security:
    - denylist paths removed before read
    - entropy scan every context item
    - prompt injection boundaries wrap untrusted files

10. Persist:
    - full context pack blob
    - prompt blob
    - context manifest
    - `context_runs` row
    - `context_items` rows

**6. Structured Rubric Review**
Input to reviewer:

```txt
- Spec section
- Acceptance criteria
- contracts.ts
- Current code/diff
- Relevant tests
- Domain Pattern Library rubric items
- Coding standards
```

Reviewer does not receive:
    - builder prompt
    - builder reasoning
    - previous reviewer output
    - tournament competitors
    - previous fix-loop review findings

Reviewer output must be JSON extracted from fenced block:

```ts
interface RubricReviewOutput {
  verdict: "PASS" | "FAIL" | "PASS_WITH_COMMENTS";
  rubricResults: Array<{
    id: string;
    status: "MET" | "NOT_MET" | "UNVERIFIABLE";
    evidence: string;
  }>;
  additionalFindings: Array<{
    severity: "P0" | "P1" | "P2";
    path: string;
    line: number;
    finding: string;
    evidence: string;
    category: string;
  }>;
  categoriesChecked: string[];
}
```

Review flow:

1. `compileReviewContextActivity` creates fresh hostile context.

2. `dispatchReviewerActivity` calls Claude if builder was Codex/Gemini; calls Codex or Gemini if builder was Claude.

3. `parseRubricReviewActivity`:
    - extracts fenced JSON
    - validates Zod schema
    - verifies each file path exists
    - verifies line numbers are in bounds
    - stores malformed raw output as blob

4. Malformed output:
    - retry reviewer up to 3 times
    - fresh context each time
    - after 3 failures, task `BLOCKED`

5. `validateReviewGateActivity`:
    - any P0 blocks
    - P1 count greater than threshold blocks
    - `UNVERIFIABLE` on required acceptance criterion blocks
    - more than 15 findings applies confidence discount and triggers stability signal

6. Findings are stored in SQLite with `reviewer_context_hash`.

7. If failed, `FixLoopWorkflow` starts.

**7. Stability Monitor**
The Stability Monitor runs after every failed BuildGate, failed ReviewGate, malformed output, and fix iteration.

Signals recorded:

```ts
sameTestFailsTwice
sameFindingCategoryRepeats
malformedOutputRepeats
forbiddenFileModified
contextGrowsAcceptanceStalls
testCountDecreases
slopRecursAfterFix
reviewFindingInflation
```

Detection state is in SQLite:

```sql
agent_failure_patterns
findings
dispatches
gate_transitions
```

Response algorithm:

```ts
const signals = await evaluateStabilitySignalsActivity(packetId);

if (signals.count < 2 && !signals.includes("forbiddenFileModified")) {
  continueRetry();
}

await stopRetryLoop();

if (signals.includes("contextMissing")) {
  await recompileContextForFailureActivity(packetId);
}

if (signals.includes("acceptanceStalls")) {
  await splitPacketActivity(packetId);
  await waitForSignal(approvePacketSplitSignal);
}

if (signals.includes("sameFindingCategoryRepeats")) {
  await switchBuilderFamilyActivity(packetId);
}

if (signals.includes("architecturalRisk")) {
  await escalateArchitectureReviewActivity(packetId);
}

await waitForSignal(approveHumanGateSignal);
```

Forbidden file modification escalates immediately after one occurrence. Test count decrease escalates immediately. Same test failure or same P0/P1 category requires two consecutive occurrences.

**8. Tournament Mode**
Tournament mode is selected per packet:

```ts
packet.tournament = true;
packet.agents = ["codex", "claude", "gemini"];
```

`TournamentPacketWorkflow`:

1. Creates one isolated worktree per agent:

```txt
wt-{runId}-{packetId}-codex-{timestamp}
wt-{runId}-{packetId}-claude-{timestamp}
wt-{runId}-{packetId}-gemini-{timestamp}
```

2. Compiles separate build contexts. Builders do not see each other.

3. Runs LangGraph fan-out:
    - node: `prepareContestants`
    - node: `dispatchContestant`
    - node: `runContestantChecks`
    - reducer: `collectContestantResults`
    - node: `arbiterEvaluate`
    - node: `promoteWinner`

4. Each contestant runs:
    - dispatch
    - diff capture
    - ownership validation
    - mechanical clamps
    - slop detection
    - requirement acceptance probe

5. Arbiter receives only:
    - anonymized diff summaries
    - test results
    - lint/type results
    - acceptance coverage
    - diff size
    - file touch count
    - reviewer findings, if review-on-contest is enabled

6. Winner criteria:

```ts
score =
  acceptanceCoverage * 40
  + testPassScore * 25
  + typecheckScore * 15
  + lintScore * 10
  + minimalDiffScore * 5
  + styleConsistencyScore * 5
  - p0Penalty
  - p1Penalty;
```

7. If no contestant passes mechanical checks, tournament fails and Stability Monitor escalates.

8. Winner is promoted by applying the winning diff to the main run branch/worktree.

9. Normal `ReviewPacketWorkflow` runs after promotion. Tournament victory does not skip review.

**Build Order**
Phase 0 spike:
    - Temporal worker + one activity
    - SQLite WAL + blob write
    - execa dispatch to one CLI
    - `ts.transpileDeclaration()` proof
    - Promptfoo smoke test

Phase 1:
    - CLI shell
    - Temporal workflows
    - SQLite/blob ledger
    - agent adapters
    - gate engine
    - structured review parser
    - `zer0 start/status/resume/doctor`

Phase 2:
    - Context Compiler Hot/Warm/Cold
    - repo map
    - compression
    - six-layer prompt assembly
    - secret scanner
    - context prefetch

Phase 3:
    - Intent, Q&A, research, spec, architecture, plan

Phase 4:
    - Build/review/fix loop
    - Stability Monitor
    - final audit

Phase 5:
    - Tournament mode

The hard line: build no GUI and no learning system until the full Temporal-backed build-review-fix-audit path works on a real repo.
tokens used
43,755
Below is the operational build blueprint. This is the day-1 engineering plan, not another spec.

**Core Position**
Zer0 Agent CI is implemented as deterministic Temporal workflows plus side-effecting activities. Agents never advance state. They only produce artifacts. Gates are TypeScript functions that read evidence from SQLite/blobs/worktrees and return `PASS | FAIL | BLOCKED`.

The first production build must ship the spine before cleverness: Temporal, SQLite ledger, blob store, CLI adapters, gate engine, structured review, and `zer0 start/status/resume/doctor`. Context Compiler, Intent Compiler, tournament mode, and Promptfoo hardening layer on top of that spine.

**1. Temporal Structure**
Primary task queue:

```ts
const TASK_QUEUE = "zer0-agent-ci-v1";
```

Workflows:

```ts
Zer0RunWorkflow
InitWorkflow
ReconWorkflow
IntentCompileWorkflow
VisionQAWorkflow
ResearchWorkflow
SpecWorkflow
ArchitectureWorkflow
PlanWorkflow
BuildRunWorkflow
BuildPacketWorkflow
ReviewPacketWorkflow
FixLoopWorkflow
FinalAuditWorkflow
ShipWorkflow
TournamentPacketWorkflow
PromptEvalWorkflow
```

Core workflow ownership:

| Workflow | Owns | Never Does |
| --- | --- | --- |
| `Zer0RunWorkflow` | Full run lifecycle and phase transitions | CLI subprocess calls |
| `BuildRunWorkflow` | Dependency ordering, packet scheduling, prefetch | Build implementation |
| `BuildPacketWorkflow` | One build packet from context to BuildGate | Review |
| `ReviewPacketWorkflow` | Fresh hostile review and ReviewGate | Fixing |
| `FixLoopWorkflow` | Builder retry + blind re-review | Human override |
| `TournamentPacketWorkflow` | Parallel worktrees, arbiter, winner promotion | Main workflow state |
| `FinalAuditWorkflow` | Requirement coverage and ship readiness | Agent dispatch |
| `ShipWorkflow` | Human approval and final action | Automated merge without signal |

Activities:

```ts
validateEnvironmentActivity
initializeZer0DirectoryActivity
initializeSqliteActivity
initializeBlobStoreActivity
createRunRecordActivity
healthCheckAgentCliActivity
verifyTemporalReachableActivity

scanRepositoryActivity
extractTypeDeclarationsActivity
generateRepoMapActivity
detectStackActivity
writeReconArtifactsActivity

compileIntentActivity
validateIntentBriefActivity
writeIntentArtifactsActivity

dispatchResearchAgentActivity
synthesizeResearchActivity
validateResearchGateActivity

compileSpecActivity
crossReviewSpecActivity
validateSpecGateActivity

compileArchitectureActivity
crossReviewArchitectureActivity
validateArchitectureGateActivity

decomposePlanActivity
writeContractsActivity
validatePlanGateActivity

resolveNextBuildPacketsActivity
createWorktreeActivity
compileContextPackActivity
prefetchContextPackActivity
scanPromptForSecretsActivity
dispatchBuilderActivity
captureWorktreeDiffActivity
validateOwnershipActivity
runMechanicalClampsActivity
detectSlopActivity
transpileDeclarationsActivity
updateBuildManifestActivity
updateRequirementCoverageActivity
validateBuildGateActivity
cleanupWorktreeActivity

compileReviewContextActivity
dispatchReviewerActivity
parseRubricReviewActivity
validateReviewGateActivity
verifyPriorFindingChangedActivity
recordFindingsActivity

evaluateStabilitySignalsActivity
recompileContextForFailureActivity
splitPacketActivity
switchBuilderFamilyActivity
escalateArchitectureReviewActivity

runFinalAuditActivity
validateAuditGateActivity
writeShipReportActivity
createPullRequestActivity
mergePullRequestActivity
```

Signals:

```ts
answerVisionQuestionSignal
deferVisionQuestionSignal
approveHumanGateSignal
rejectHumanGateSignal
overrideGateSignal
pauseRunSignal
resumeRunSignal
cancelRunSignal
setRunModeSignal
approveDependencySignal
approvePacketSplitSignal
approveShipSignal
rejectShipSignal
```

Queries:

```ts
getRunStatusQuery
getCurrentPhaseQuery
getPendingHumanActionQuery
getGateStateQuery
getFindingsQuery
getRequirementCoverageQuery
getContextPackQuery
getCostQuery
getTimelineQuery
getAgentHealthQuery
getTournamentResultsQuery
```

**2. Automatic Gate Firing**
There is no “agent says build done” trigger. Build completion is detected only when `dispatchBuilderActivity` exits and the deterministic workflow runs the evidence chain.

Exact sequence inside `BuildPacketWorkflow`:

```ts
const context = await compileContextPackActivity(packet);
await scanPromptForSecretsActivity(context);

const result = await dispatchBuilderActivity({
  packetId,
  contextHash: context.hash,
  worktreePath,
  agent: packet.builderAgent,
});

const diff = await captureWorktreeDiffActivity(worktreePath);

await validateOwnershipActivity({ packet, diff });
await runMechanicalClampsActivity({ packet, worktreePath });
await detectSlopActivity({ diff });
await transpileDeclarationsActivity({ changedFiles: diff.files });
await updateBuildManifestActivity({ packet, diff });
await updateRequirementCoverageActivity({ packet, diff });

const gate = await validateBuildGateActivity({ packet, diff, result });

if (gate.passed) {
  return {
    status: "BUILD_PASSED",
    packetId,
    diffBlob: diff.blobHash,
    headCommit: diff.headCommit,
  };
}

return {
  status: "BUILD_FAILED",
  packetId,
  gate,
};
```

Then `BuildRunWorkflow` automatically starts review:

```ts
const buildResult = await executeChild(BuildPacketWorkflow, { args: [packet] });

if (buildResult.status === "BUILD_PASSED") {
  const reviewResult = await executeChild(ReviewPacketWorkflow, {
    args: [{
      packetId: buildResult.packetId,
      diffBlob: buildResult.diffBlob,
      headCommit: buildResult.headCommit,
    }],
  });

  if (reviewResult.verdict === "PASS") {
    markPacketComplete(packet.id);
  } else {
    await executeChild(FixLoopWorkflow, {
      args: [packet, reviewResult],
    });
  }
}
```

That is the automatic review spawn. The trigger is not stdout text. It is `BuildGate passed === true`.

**3. `zer0 start` To Shipped**
1. User runs:

```bash
zer0 start --vision "Build the app..."
```

2. CLI calls Temporal client:

```ts
client.workflow.start(Zer0RunWorkflow, {
  workflowId: `zer0-${runId}`,
  taskQueue: "zer0-agent-ci-v1",
  args: [{ vision, cwd, mode }],
});
```

3. `Zer0RunWorkflow` runs `InitWorkflow`.

4. `InitWorkflow` creates `.zer0/`, SQLite DB, blob folders, run row, and checks `codex`, `claude`, `gemini`, `git`, `node`, `temporal`.

5. Existing repo path runs `ReconWorkflow`.

6. `IntentCompileWorkflow` dispatches Claude with raw vision and writes intent artifacts.

7. `VisionQAWorkflow` blocks on unanswered questions unless mode is `auto` and defaults are allowed.

8. `ResearchWorkflow` dispatches Gemini, Codex, Claude in parallel. Gate passes with 2 of 3 reports plus synthesis.

9. `SpecWorkflow` creates full spec. Codex cross-reviews it.

10. `ArchitectureWorkflow` creates architecture doc. Codex cross-reviews it.

11. `PlanWorkflow` creates build packets and `contracts.ts`. `PlanGate` checks requirement assignment, ownership overlap, dependency cycles, and contract compilation.

12. `BuildRunWorkflow` topologically sorts packets.

13. For each ready packet:
    - creates worktree
    - compiles context pack
    - scans secrets
    - dispatches builder
    - captures diff
    - runs BuildGate
    - automatically launches `ReviewPacketWorkflow`

14. `ReviewPacketWorkflow` compiles hostile review context and dispatches cross-family reviewer.

15. `ReviewGate` decides:
    - `PASS`: packet complete
    - `PASS_WITH_COMMENTS`: packet complete, P2/P1 below threshold logged
    - `FAIL`: enter `FixLoopWorkflow`

16. `FixLoopWorkflow` sends current code and accepted findings to builder, then runs a fresh blind review. Max 3 rounds.

17. `FinalAuditWorkflow` verifies 100% requirement coverage, all tests, no open P0/P1.

18. `ShipWorkflow` writes ship report and blocks on `approveShipSignal`.

19. User runs:

```bash
zer0 resume --approve
```

20. `ShipWorkflow` creates PR or merges based on mode/config.

**4. Files Created**
Implementation files, created in this order:

```txt
package.json
tsconfig.json
vitest.config.ts
biome.json
src/cli/main.ts
src/cli/router.ts
src/cli/commands/start.ts
src/cli/commands/resume.ts
src/cli/commands/status.ts
src/cli/commands/doctor.ts

src/workflows/zer0-run.workflow.ts
src/workflows/init.workflow.ts
src/workflows/build-run.workflow.ts
src/workflows/build-packet.workflow.ts
src/workflows/review-packet.workflow.ts
src/workflows/fix-loop.workflow.ts
src/workflows/final-audit.workflow.ts
src/workflows/ship.workflow.ts
src/workflows/tournament-packet.workflow.ts

src/activities/init.activities.ts
src/activities/repo.activities.ts
src/activities/context.activities.ts
src/activities/agent.activities.ts
src/activities/gate.activities.ts
src/activities/review.activities.ts
src/activities/stability.activities.ts
src/activities/ship.activities.ts

src/db/schema.sql
src/db/client.ts
src/db/migrations.ts
src/db/ledger.ts

src/blob/blob-store.ts
src/blob/hash.ts

src/agents/adapter.ts
src/agents/codex-adapter.ts
src/agents/claude-adapter.ts
src/agents/gemini-adapter.ts

src/context/types.ts
src/context/indexer.ts
src/context/compress.ts
src/context/assemble.ts
src/context/security.ts
src/context/prefetch.ts

src/gates/types.ts
src/gates/plan-gate.ts
src/gates/build-gate.ts
src/gates/review-gate.ts
src/gates/fix-gate.ts
src/gates/audit-gate.ts
src/gates/human-gate.ts

src/review/rubric-schema.ts
src/review/parser.ts
src/review/finding-dedupe.ts

src/stability/monitor.ts
src/stability/signals.ts
src/stability/responses.ts

src/tournament/langgraph.ts
src/tournament/arbiter.ts
src/tournament/promote-winner.ts

src/templates/static-prefix.md
src/templates/build-endcap.md
src/templates/review-rubric.md
src/templates/intent-compiler.md
src/templates/research/*.md
src/patterns/*.yaml
```

Runtime files, created by `InitWorkflow`:

```txt
.zer0/
.zer0/zer0.sqlite
.zer0/blobs/
.zer0/blobs/{sha-prefix}/{sha}
.zer0/worktrees/
.zer0/tmp/
.zer0/logs/

.council/
.council/runs/{runId}/
.council/runs/{runId}/intent/
.council/runs/{runId}/research/
.council/runs/{runId}/spec/
.council/runs/{runId}/architecture/
.council/runs/{runId}/plan/
.council/runs/{runId}/build/
.council/runs/{runId}/review/
.council/runs/{runId}/audit/
.council/runs/{runId}/ship-report.md
```

Per build packet runtime artifacts:

```txt
.zer0/worktrees/wt-{runId}-{packetId}-{agent}-{timestamp}/
.council/runs/{runId}/build/{packetId}/context-manifest.json
.council/runs/{runId}/build/{packetId}/build-result.json
.council/runs/{runId}/build/{packetId}/build-gate.json
.council/runs/{runId}/review/{packetId}/review-result.json
.council/runs/{runId}/review/{packetId}/review-gate.json
```

The human-readable `.council/` files are projections. SQLite and blobs remain authoritative for evidence.

**5. Context Pack Assembly**
For `BUILD-030`, the Context Compiler does this:

1. Load packet:

```yaml
id: BUILD-030
creates: ["src/api/users.ts"]
modifies: ["src/api/index.ts"]
reads: ["src/auth/service.ts"]
contracts: ["User", "AuthService"]
owned_files: ["src/api/users.ts", "src/api/index.ts"]
forbidden_files: ["src/auth/*"]
acceptance:
  - "Returns 401 for invalid token"
  - "Rate limits to 100 req/min"
```

2. Load current manifest:
    - import graph
    - export summaries
    - known tests
    - requirement map
    - prior findings
    - file hashes

3. Build Hot tier, lossless:
    - full `src/api/index.ts`
    - full create-target placeholder for `src/api/users.ts`
    - full acceptance criteria
    - current failing output, if retry
    - prior accepted findings for fix context
    - current diff, if fix loop
    - human corrections

4. Score Warm candidates:

```ts
score = relevance * importance;
```

Warm examples:
    - `src/auth/service.ts` full or `.d.ts`
    - related auth tests
    - API route registration types
    - validation helpers
    - middleware contracts
    - prior findings in touched files

5. Build Cold tier:
    - every repo file path
    - one-line export summaries
    - architecture summary
    - spec summary
    - requirement list compressed to IDs and short text

6. Compress:
    - TypeScript to declarations with `ts.transpileDeclaration()`
    - SQL to table/schema summaries
    - JSON/YAML to keys and selected values
    - Markdown to headings and linked sections
    - CSS to class names and variables

7. Assemble six layers:
    - static quality floor
    - project contract and `contracts.ts`
    - task brief plus next two consumers
    - Cold + Warm repo context
    - Hot full source/evidence
    - endcap verification instructions

8. Token fit:
    - estimate `chars / 4`
    - never truncate Hot
    - reduce Warm K first
    - compress Cold further second
    - if still too large, return `[BLOCKED: packet too large, split required]`

9. Security:
    - denylist paths removed before read
    - entropy scan every context item
    - prompt injection boundaries wrap untrusted files

10. Persist:
    - full context pack blob
    - prompt blob
    - context manifest
    - `context_runs` row
    - `context_items` rows

**6. Structured Rubric Review**
Input to reviewer:

```txt
- Spec section
- Acceptance criteria
- contracts.ts
- Current code/diff
- Relevant tests
- Domain Pattern Library rubric items
- Coding standards
```

Reviewer does not receive:
    - builder prompt
    - builder reasoning
    - previous reviewer output
    - tournament competitors
    - previous fix-loop review findings

Reviewer output must be JSON extracted from fenced block:

```ts
interface RubricReviewOutput {
  verdict: "PASS" | "FAIL" | "PASS_WITH_COMMENTS";
  rubricResults: Array<{
    id: string;
    status: "MET" | "NOT_MET" | "UNVERIFIABLE";
    evidence: string;
  }>;
  additionalFindings: Array<{
    severity: "P0" | "P1" | "P2";
    path: string;
    line: number;
    finding: string;
    evidence: string;
    category: string;
  }>;
  categoriesChecked: string[];
}
```

Review flow:

1. `compileReviewContextActivity` creates fresh hostile context.

2. `dispatchReviewerActivity` calls Claude if builder was Codex/Gemini; calls Codex or Gemini if builder was Claude.

3. `parseRubricReviewActivity`:
    - extracts fenced JSON
    - validates Zod schema
    - verifies each file path exists
    - verifies line numbers are in bounds
    - stores malformed raw output as blob

4. Malformed output:
    - retry reviewer up to 3 times
    - fresh context each time
    - after 3 failures, task `BLOCKED`

5. `validateReviewGateActivity`:
    - any P0 blocks
    - P1 count greater than threshold blocks
    - `UNVERIFIABLE` on required acceptance criterion blocks
    - more than 15 findings applies confidence discount and triggers stability signal

6. Findings are stored in SQLite with `reviewer_context_hash`.

7. If failed, `FixLoopWorkflow` starts.

**7. Stability Monitor**
The Stability Monitor runs after every failed BuildGate, failed ReviewGate, malformed output, and fix iteration.

Signals recorded:

```ts
sameTestFailsTwice
sameFindingCategoryRepeats
malformedOutputRepeats
forbiddenFileModified
contextGrowsAcceptanceStalls
testCountDecreases
slopRecursAfterFix
reviewFindingInflation
```

Detection state is in SQLite:

```sql
agent_failure_patterns
findings
dispatches
gate_transitions
```

Response algorithm:

```ts
const signals = await evaluateStabilitySignalsActivity(packetId);

if (signals.count < 2 && !signals.includes("forbiddenFileModified")) {
  continueRetry();
}

await stopRetryLoop();

if (signals.includes("contextMissing")) {
  await recompileContextForFailureActivity(packetId);
}

if (signals.includes("acceptanceStalls")) {
  await splitPacketActivity(packetId);
  await waitForSignal(approvePacketSplitSignal);
}

if (signals.includes("sameFindingCategoryRepeats")) {
  await switchBuilderFamilyActivity(packetId);
}

if (signals.includes("architecturalRisk")) {
  await escalateArchitectureReviewActivity(packetId);
}

await waitForSignal(approveHumanGateSignal);
```

Forbidden file modification escalates immediately after one occurrence. Test count decrease escalates immediately. Same test failure or same P0/P1 category requires two consecutive occurrences.

**8. Tournament Mode**
Tournament mode is selected per packet:

```ts
packet.tournament = true;
packet.agents = ["codex", "claude", "gemini"];
```

`TournamentPacketWorkflow`:

1. Creates one isolated worktree per agent:

```txt
wt-{runId}-{packetId}-codex-{timestamp}
wt-{runId}-{packetId}-claude-{timestamp}
wt-{runId}-{packetId}-gemini-{timestamp}
```

2. Compiles separate build contexts. Builders do not see each other.

3. Runs LangGraph fan-out:
    - node: `prepareContestants`
    - node: `dispatchContestant`
    - node: `runContestantChecks`
    - reducer: `collectContestantResults`
    - node: `arbiterEvaluate`
    - node: `promoteWinner`

4. Each contestant runs:
    - dispatch
    - diff capture
    - ownership validation
    - mechanical clamps
    - slop detection
    - requirement acceptance probe

5. Arbiter receives only:
    - anonymized diff summaries
    - test results
    - lint/type results
    - acceptance coverage
    - diff size
    - file touch count
    - reviewer findings, if review-on-contest is enabled

6. Winner criteria:

```ts
score =
  acceptanceCoverage * 40
  + testPassScore * 25
  + typecheckScore * 15
  + lintScore * 10
  + minimalDiffScore * 5
  + styleConsistencyScore * 5
  - p0Penalty
  - p1Penalty;
```

7. If no contestant passes mechanical checks, tournament fails and Stability Monitor escalates.

8. Winner is promoted by applying the winning diff to the main run branch/worktree.

9. Normal `ReviewPacketWorkflow` runs after promotion. Tournament victory does not skip review.

**Build Order**
Phase 0 spike:
    - Temporal worker + one activity
    - SQLite WAL + blob write
    - execa dispatch to one CLI
    - `ts.transpileDeclaration()` proof
    - Promptfoo smoke test

Phase 1:
    - CLI shell
    - Temporal workflows
    - SQLite/blob ledger
    - agent adapters
    - gate engine
    - structured review parser
    - `zer0 start/status/resume/doctor`

Phase 2:
    - Context Compiler Hot/Warm/Cold
    - repo map
    - compression
    - six-layer prompt assembly
    - secret scanner
    - context prefetch

Phase 3:
    - Intent, Q&A, research, spec, architecture, plan

Phase 4:
    - Build/review/fix loop
    - Stability Monitor
    - final audit

Phase 5:
    - Tournament mode

The hard line: build no GUI and no learning system until the full Temporal-backed build-review-fix-audit path works on a real repo.

