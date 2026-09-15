# Zer0 Agent CI — Canonical Production Specification

**Version:** 6.0 (Final — DeepSeek V4 research integrated)
**Date:** 2026-05-03
**Status:** Canonical — council-approved, research-integrated, ready for Phase 1 build
**Principle:** Full production quality from day 1. Temporal is non-negotiable. No JSON state machines. No toys.
**Research integrated:** DeepSeek V4 architecture lessons (6 documents, 3-model council unanimous)

---

## 1. INVARIANTS

1. **Deterministic code controls the pipeline.** AI agents are workers, never controllers.
2. **Builder ≠ Reviewer.** Different model family. Fresh instance. No memory of prior review on retry.
3. **No phase runs without prerequisites.** Enforced by Temporal workflow transitions. No exceptions.
4. **Every agent call gets fresh context.** Non-interactive CLI mode. Context Compiler assembles per-call context deterministically.
5. **Temporal owns execution state.** No JSON file is authoritative for workflow progress. SQLite owns evidence. `.council/` artifacts are human-readable projections.
6. **Every claim cites a source.** Research → URLs. Build → spec sections. Review → file:line.
7. **Malformed output is retriable.** Max 3 attempts, then BLOCKED + escalate.
8. **All exports have explicit return type annotations.** `isolatedDeclarations: true`. Enables ts.transpileDeclaration().
9. **Secrets never enter prompts.** Denylist + entropy scanner enforced before every dispatch. Enforced at the canonical boundary via `assertPromptAllowed` (`dispatch-prefilter.ts`) in `dispatchAgentActivity` + `dispatchReviewActivity`, plus the legacy `dispatch.ts` and chat `prompt-builder.ts`. Spawned CLIs receive an allowlisted env only (`childEnv` + `extendEnv:false`), so no worker secret reaches a child process.
10. **P0 findings block unconditionally.** No automated override. Human approval with logged reason.
11. **Agents submit artifacts. Gates decide completion.** No agent decides it is "done."
12. **Prompt templates are production logic.** Must pass evals (Promptfoo) like code passes tests.
13. **Evidence is content-addressed blobs, not just hashes.** Every prompt, context pack, diff, stdout, and stderr is stored.
14. **Context is a memory hierarchy, not a flat dump.** Hot (lossless) + Warm (sparse selected) + Cold (compressed global) — simultaneously, not as fallbacks.
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
INIT → INTENT COMPILE → VISION Q&A → RESEARCH → SPEC → ARCHITECTURE → PLAN → BUILD → REVIEW → FIX LOOP → FINAL AUDIT → SHIP
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
**Action:** Raw vibe prompt → Intent Brief (normalized goal, vocabulary map, rubric, assumptions, research questions, risk checklist, Q&A plan, enrichment sources)
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

**Gate:** Every requirement → packet. No cycles. No ownership overlap. contracts.ts compiles.

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
9. If gate fails → errors to builder → retry (max 2)
10. If pass → ts.transpileDeclaration() → update Build Manifest
11. Update requirement coverage: file:line → requirement IDs
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

**Gate:** Zero P0. P1 ≤ threshold (default 5). Max 3 fix rounds.
**Finding-Inflation Clamp:** >15 findings from one review → 25% confidence discount.

**Fix Loop — Blind Retry Protocol:**

1. **Blind AI Review:** Reviewer gets FRESH context (current code + spec + rubric). NO prior findings. NO knowledge this is iteration 2+. Fresh hostile review.
2. **Mechanical Fix Verifier:** Deterministic grep/diff check that prior P0 patterns cited at specific file:line are actually changed.

**Escalation:** Same finding 2+ times → architectural issue. >10 P1 → brief insufficient. Both → user.

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

**Blob Store:** `.zer0/blobs/{sha256-first-2}/{sha256}` — every prompt, context pack, diff, stdout, stderr.

---

## 5. LONG-HORIZON AGENT MEMORY MODEL

Context selection uses a simultaneous three-tier memory hierarchy. All tiers in EVERY context pack — NOT sequential fallbacks.

| Tier     | Analogue                  | Content                                                                                     | Rule                                                |
| -------- | ------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **Hot**  | DeepSeek Sliding Window   | Files being modified, current diff, failing output, acceptance criteria, human corrections  | NEVER summarize. NEVER omit.                        |
| **Warm** | DeepSeek CSA (top-K)      | .d.ts of top-K scored dependencies, related tests, prior findings, stack-trace-linked files | Selected by dual-signal scoring. Budget controls K. |
| **Cold** | DeepSeek HCA (attend-all) | ALL project file names + 1-line export summaries, architecture summary, spec summary        | ALWAYS included. ~5-10K tokens for 500 files.       |

**Design principle:** At sufficient compression, include-everything is cheaper than selective retrieval. Cold tier costs 3-7% of budget and provides whole-project awareness.

**Anti-pattern — Context Inflation:** Agent produced bad output → DON'T expand budget. DO replace lowest-scored items with the specific missing piece.

---

## 6. CONTEXT COMPILER

### Architecture: SELECTION → COMPRESSION → ASSEMBLY → COST

### Context Indexer: Dual-Signal Scoring

Files scored by `relevance × importance` (multiplicative, not additive). Neither signal alone is sufficient.

```typescript
function scoreFile(file: string, task: BuildTask, manifest: BuildManifest): number {
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

**TypeScript:** `ts.transpileDeclaration()` — 1-5ms/file, 6-20x savings.
**Non-TypeScript:** `.sql` → schema, `.yaml/.json` → keys, `.css` → classes, `.md` → headers, Other → head/tail.

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
## FORWARD CONTEXT (interface design only — do NOT implement)

Next consumers of YOUR output:

- BUILD-006: Role-based access (will consume AuthService.getUserRoles())
- BUILD-007: Team invites (will consume AuthService.validateInviteToken())
```

**Layer 6 Endcap (Think Max equivalent):**

```markdown
## FINAL VERIFICATION (before you output ANYTHING)

1. Count acceptance criteria above. Address ALL — not "most."
2. For EACH, verify code handles SUCCESS and ERROR case.
3. If ANY function body < 5 lines for non-trivial operation — you're taking a shortcut. EXPAND.
4. If ANY error path returns generic message — you're being lazy. FIX.
5. Output WILL be mechanically verified against rubric. Shortcuts WILL be caught.
6. If context insufficient: output [BLOCKED: specific missing context]
```

**Cache alignment:** Layers 1-2 stable → 90% prompt caching cost reduction.
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

Raw vibe → Intent Brief (schema-validated) → vocabulary map → Q&A plan → enrichment sources.

Evidence: aider A/B test — 2-line conventions file shifted code from tutorial-level to production. Prompt quality > model choice.

---

## 8. DOMAIN PATTERN LIBRARY

YAML files providing CANDIDATE requirements. Filtered by research/spec decisions — patterns are RUBRIC INPUTS, not mandatory expansion.

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

- Intent Compiler outputs (vibe → IntentBrief quality)
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
  dispatch(contextPack: ContextPack, worktreePath: string): Promise<AgentResult>;
  parseOutput(raw: string): ParsedOutput;
  healthCheck(): Promise<AgentHealth>;
}
```

All via execa v9, shell:false, stdin from temp file. Zod validation on output. Fenced JSON extraction. Max 3 retries on malformed output.

---

## 15. CLI

```bash
zer0 start "<vision>"
zer0 resume <run-id> <phase>
zer0 status <run-id>
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

Phase-1 implementation note: the root workflow ships with fixed packet IDs for the spine
round trip (`BUILD-temporal-round-trip` and rubric review coverage). Phase 2 introduces
user-driven packet compilation from intent and context compiler output.

### Phase 2: Context Compiler + Memory Model (1 week)

Three-tier context (Hot/Warm/Cold), dual-signal scoring, .d.ts compression, 6-layer assembly, token budgets, hostile isolation, context prefetching, endcap template.

### Phase 3: Intent + Product Pipeline (1 week)

Intent Compiler, Domain Pattern Library, vocabulary activation, Promptfoo evals, INTENT → Q&A → RESEARCH → SPEC → ARCHITECTURE → PLAN.

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
| 3   | P0 blocks unconditionally     | Integration test: inject P0 → halts   |
| 4   | Crash recovery                | Kill mid-build → resume works         |
| 5   | All 3 CLIs work               | Each dispatches and returns           |
| 6   | Context reproducible          | Blob hash → exact prompt              |
| 7   | Hostile isolation holds       | Zero builder content in reviewer      |
| 8   | Secrets never in prompts      | .env never in blobs                   |
| 9   | Structured rubric review      | MET/NOT_MET per requirement           |
| 10  | Stability monitor fires       | Repeated failures → early escalation  |
| 11  | Tournament works              | 3 compete, winner by evidence         |
| 12  | Second project works          | Same orchestrator, no code changes    |
| 13  | Enrichment measurable         | Promptfoo shows flag-vs-no-flag delta |

---

## 18. AGENT DISCIPLINE GATES (universal — applies to EVERY project zer0 CLI is run on)

These gates encode root-cause fixes from real multi-agent build cycles. They are MANDATORY for every packet build and every phase exit. They ship with the zer0 CLI as enforced defaults; user projects opt in via `zer0 init` and CANNOT disable them silently.

**Self-application:** zer0-agent-ci itself uses these gates from packet-09 onward.
**General product:** any user project running `zer0 start "task"` inherits all gates by default.

### 18.0a L5 QUALITY STANDARD (locked 2026-05-05 by user directive)

Every BUILD BRIEF the zer0 system generates MUST include four sections that elevate "passes mechanical gates" (L4) to "world-class production code" (L5):

| Section                                      | Source-of-truth template                                         | Purpose                                                                                                                      |
| -------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Required Reading                             | `.council/templates/BUILD-BRIEF-TEMPLATE.md` §"REQUIRED READING" | Builder reads ADRs + MODULE-MAP + AGENTS.md BEFORE writing any code; outputs `[BLOCKED]` if any required artifact is missing |
| Build Order (phases with intermediate gates) | `.council/templates/BUILD-BRIEF-TEMPLATE.md` §"BUILD ORDER"      | Prevents broken intermediate states on multi-file packets; each phase has its own gate                                       |
| Pattern Mirrors (cite existing files)        | `.council/templates/BUILD-BRIEF-TEMPLATE.md` §"PATTERN MIRRORS"  | "Mirror src/evidence/blobs.ts atomic-write pattern" beats abstract guidance                                                  |
| Anti-Patterns from past mistakes             | `.council/templates/BUILD-BRIEF-TEMPLATE.md` §"ANTI-PATTERNS"    | Each past failure mode named explicitly with memory citation; prevents re-discovery                                          |

Every HOSTILE REVIEW (orchestrator-direct, codex `--sandbox read-only`, fresh-claude blind retry) on a major packet (>10 files OR architectural changes OR new subsystems) MUST use the 14-dimension rubric in `.council/templates/L5-HOSTILE-REVIEW-RUBRIC.md`. The 14 dimensions are: spec literal, ADR conformance, architecture / MODULE-MAP, type rigor, test rigor (no theater), determinism, idempotency depth, races / concurrency, resource exhaustion, observability, pattern-mirror, anti-pattern absence, failure-injection survival, documentation honesty.

**ADR requirement:** every major packet ships an ADR set at `docs/adrs/{packet-name}/ADR-{NNN}-{slug}.md`. ADRs use Context / Decision / Consequences format, are immutable once accepted, and are referenced from the BUILD BRIEF Required Reading section. Builder MUST read each ADR before touching the related subsystem.

**Phase-2 application:** when zer0 dispatches Phase-2 builders (Intent Compiler, Context Compiler, the 11 missing phase activities), the system's BUILD BRIEF emitter MUST instantiate the four L5 sections from this template. The Phase-2 brief generator (deferred to packet-11+) reads MODULE-MAP rows and ADR set for the Phase-2 packet and synthesizes the four sections automatically. No manual brief-writing for Phase-2.

**Mechanical enforcement:** `scripts/gate-clamps.mjs` (or successor) is extended to grep BUILD-BRIEF files (`.council/cross-model/*-build-brief.md`) for the four section headers (`SECTION 19 — REQUIRED READING`, `SECTION 20 — BUILD ORDER`, `SECTION 21 — PATTERN MIRRORS`, `SECTION 22 — ANTI-PATTERNS`). A brief missing any of these on a major packet = gate FAIL. Trivial fix-loops (1-3 files) MAY skip Build Order + Pattern Mirrors but MUST keep Required Reading + Anti-Patterns.

**Why this is locked:** observed in packet-10 dispatch (2026-05-05) — codex correctly outputs `[BLOCKED: ...]` when brief contradicts ADRs (e.g., synthesis says feature X is deferred but brief acceptance includes X). This is the L5 quality bar working: codex refuses to silently resolve ambiguity. Without ADRs as required reading, codex would either stall or guess. The cost of writing 12 ADRs upfront (~1 hour) is paid back many times over in reduced fix-loop iterations.

**Reference for future packets:** `.council/cross-model/packet-10-build-brief.md` is the canonical L5 brief example (~880 lines, 22 sections). New packet briefs should mirror its structure, scaling section depth to packet complexity.

### 18.0b L5 UNIVERSAL MANDATES (locked 2026-05-06 from packet-10 review findings)

Every packet review uncovers gaps that ad-hoc gates didn't catch. The L5 self-improvement principle: convert each gap into a permanent universal gate enforced on every future build in every project. **Findings become gates, not patches.**

Source-of-truth: `scripts/gate-l5-mandates.mjs` (run via `npm run gate-l5`).

| Mandate                 | Gap that motivated it                                                                                                                                   | Mechanical check                                                                                           | Severity if FAIL |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------- |
| **G1 test-coverage**    | packet-10 review found 13 owned files lacking sibling tests (8 CLI commands + 5 observability modules); brief listed them but no mechanical enforcement | `find src/ -name "*.ts" -not -name "*.test.ts"` cross-checked against test siblings                        | P0               |
| **G2 execa-handling**   | packet-10 fresh-claude review found `replay.ts:74` execa without `reject:false` → unhandled rejection on subprocess crash                               | `grep -n "execa(" src/` then verify each call has `reject:false` OR enclosing `try{}` within 5 prior lines | P1               |
| **G3 zod-type-any**     | packet-10 fresh-claude review found 11 `: z.ZodTypeAny` annotations in observability schemas suppressing inference at every consumer                    | `grep -n ":\s*z\.ZodTypeAny\b" src/` returns zero matches                                                  | P2               |
| **G4 unbounded-select** | packet-10 fresh-claude review found `stream.ts` SELECT \* without LIMIT → memory risk at 10k+ events                                                    | `grep "SELECT \*" src/` then verify each query has `LIMIT` OR single-key `WHERE` (= ?)                     | P2               |

**Application surface:**

1. **zer0-agent-ci itself:** `npm run gates` includes `gate-encoding.mjs` after `gate-clamps.mjs`, then `gate-l5-mandates.mjs`. `npm run gate-l5` runs it standalone.
2. **User projects via `zer0 init`:** the gate script is copied to `scripts/gate-l5-mandates.mjs` in every initialized project. Cannot be silently disabled.
3. **AGENTS.md `<l5_mandates>` block:** automatically loaded by codex on every build dispatch. Builder reads the 4 mandates BEFORE writing code.
4. **BUILD-BRIEF-TEMPLATE acceptance row:** every brief's Section 13 acceptance gates table includes a row for `gate-l5`.
5. **L5-HOSTILE-REVIEW-RUBRIC dimensions 4, 5, 9, 11:** reference the corresponding mandates and instruct reviewers to run the gate.

**Adding new mandates over time:** when a future review surfaces a new failure mode that mandates 1-4 don't catch:

1. Confirm the failure mode is universal (not packet-specific). If specific to one packet's domain, address as a packet-specific finding, not a universal mandate.
2. Add a new gate function to `gate-l5-mandates.mjs` (e.g., `gateNewName(files)` mirroring G1-G4 structure).
3. Add a new row to this §18.0b table with motivating gap + mechanical check + severity.
4. Add a new clamp row to `<l5_mandates>` block in `AGENTS.md`.
5. Add a new dimensional check reference in `L5-HOSTILE-REVIEW-RUBRIC.md`.
6. Increment the mandate count in `BUILD-BRIEF-TEMPLATE.md`.
7. Document the lesson in a memory entry (`feedback_l5_mandate_GN_{slug}.md`).

**Why this is locked:** the alternative — patching each packet's specific findings — produces a system that repeats the SAME mistakes across packets. Codifying findings as universal gates is the difference between a system that's reactive (fixing what broke) and a system that's PROACTIVE (preventing recurrence in every future context).

**Empirical proof:** running `npm run gate-l5` on the packet-10 build BEFORE these mandates existed found 14 G1, 4 G2, 11 G3, 3 G4 violations. Running it on EVERY future build will catch these classes of failure at the moment they occur, not after a hostile review weeks later.

### 18.0 Empirically-observed failure modes (ROOT CAUSES — fix the cause, not the symptom)

This section enumerates EVERY weakness observed in packets 02-08 of zer0-agent-ci's own development. Each becomes a generalized gate. The pattern is: identify root cause once → encode as universal gate → applies to ALL future projects.

| #   | Failure observed                                                                             | Root cause                                                | Universal gate (§ below)                                                      |
| --- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | Codex created 20 dashboard files outside packet-05 OWNED FILES                               | Permissive prompt + workspace-write sandbox               | §18.1 sandbox-by-role + §18.3 scope-gate                                      |
| 2   | Codex review with workspace-write RESTORED orchestrator-deleted files (30-min loop)          | Review uses build-mode sandbox                            | §18.1 (review = read-only) + §18.4 anti-restoration ledger                    |
| 3   | Codex shipped `node -e "echo dispatched"` SCAFFOLD pretending to be real CLI dispatch        | Brief didn't explicitly forbid placeholders               | §18.2 brief schema rule 9 (NO SCAFFOLD-PRETENDING-TO-WORK)                    |
| 4   | Workflow recorded SYNTHETIC `gate_transitions.passed=true` rows without running gate         | No "wiring trace" verification step                       | §18.6 audit-2 wiring-trace dimension                                          |
| 5   | Security prefilter coded but NEVER CALLED from dispatch                                      | No "is X actually used?" audit dimension                  | §18.6 audit-1 dimension D (wiring gaps)                                       |
| 6   | Rubric parser coded but NEVER CALLED from production                                         | Same as #5                                                | §18.6 audit-1 dimension D + §18.7 dead-code consumed-by-prod check            |
| 7   | Adapter env stripped ANTHROPIC_API_KEY/OPENAI_API_KEY/etc — real CLIs would fail             | No AUTH_ENV_VARS contract                                 | §18.10 adapter pattern (declare AUTH_ENV_VARS)                                |
| 8   | No `maxBuffer` on subprocess execa — 50MB+ output OOMs activity                              | Resource-limit dimension missed                           | §18.6 audit-2 dimension 5 (resource exhaustion)                               |
| 9   | Workflow accepted arbitrary `dbPath` like `../../etc/passwd`                                 | Path validation absent                                    | §18.6 audit-2 dimension 4 (input validation as security boundary)             |
| 10  | `persistRunCompleted` silently no-op'd when run row missing                                  | Update-without-checking-changes pattern                   | §18.11 persistence pattern (`Statement.run().changes` mandatory)              |
| 11  | `dispatches.task_id` no FK to `tasks(id)` — orphan rows possible                             | Schema-FK audit dimension missed                          | §18.6 audit-2 dimension 4 (data integrity)                                    |
| 12  | `runResume` reported workflow-not-found as network error (exit 5 instead of 4)               | Generic catch hides specific failure types                | §18.6 audit-2 dimension 6 (observability — error specificity)                 |
| 13  | `blockedAt` cast to `PipelinePhase` without runtime validation                               | Type-bypass at runtime boundary                           | §18.6 audit-1 dimension E (zod boundary)                                      |
| 14  | `doctor.ts` hardcoded `.zer0/evidence.db` instead of reading config                          | Config drift across commands                              | §18.6 audit-2 dimension 8 (doc drift includes config-vs-code drift)           |
| 15  | No `context_runs/context_items` query API for Phase-2 Context Compiler                       | Phase-N consumer needs not surfaced before Phase-N starts | §18.12 Phase-N+1 readiness gate (Phase-N exit must list Phase-N+1 needs)      |
| 16  | Generic codex audit MISSED determinism, races, observability, doc drift, chaos, spec literal | Single-rubric audit covers ~70%; needs 2 passes           | §18.6 two-pass audit (mandatory)                                              |
| 17  | `claude -p --effort high\|medium` HUNG 8-10 min, 0 bytes output, killed                      | Windows piped stdio + opus + complex prompt = hang        | §18.13 claude headless constraints (no `--effort`, inline data, hard timeout) |
| 18  | Tests passed because mocks aligned with mocks; underlying code broken                        | Test theater                                              | §18.6 audit-1 dimension F (test theater detection)                            |
| 19  | Workflow body called `Date.now()` directly (would cause replay drift)                        | Determinism not enforced by lint                          | §18.14 determinism enforcer (lint rule for `src/temporal/workflows/**`)       |
| 20  | Activity not idempotent — Temporal retry created duplicate rows                              | Idempotency test pattern missing                          | §18.15 idempotency test harness (mandatory test pattern for activities)       |
| 21  | After-the-fact audit found wiring gaps that should've been caught at brief-time              | Brief schema didn't include "is real wiring" check        | §18.2 brief schema (NO SCAFFOLD-PRETENDING-TO-WORK as rule 9)                 |
| 22  | docs/SPEC.md claimed feature X; code didn't implement X                                      | Spec drift                                                | §18.6 audit-2 dimension 1 (spec literal compliance line-by-line)              |
| 23  | First-pass review = fresh `claude -p` deprecated; orchestrator-direct works better           | Wrong reviewer for first-pass                             | §18.13 reviewer policy (orchestrator-direct first-pass)                       |
| 24  | Mock-based unit tests didn't catch that activity wasn't idempotent                           | Mocks hide retry semantics                                | §18.15 idempotency test must use REAL DB, not mocks                           |
| 25  | Foundation work shipped under DoD test that didn't actually exercise real CLI                | DoD test had a placeholder dispatch                       | §18.6 audit-2 dimension 7 (failure-injection scenarios catch this)            |
| 26  | gracefulShutdown could call worker.run() on external workers (race)                          | Lifecycle invariants undocumented                         | §18.16 lifecycle invariants (mandatory in @file headers for stateful modules) |
| 27  | Temporal server cleanup depended only on explicit calls (no signal handler)                  | SIGINT/SIGTERM not registered                             | §18.6 audit-2 dimension 7 (kill -9 / SIGINT scenarios)                        |
| 28  | Evidence activity errors not logged with run/task context                                    | Observability missing correlation IDs                     | §18.6 audit-2 dimension 6 (every log must carry runId+taskId)                 |

### 18.1 Sandbox-by-role (LOCKED dispatch policy)

The dispatch wrapper script enforces sandbox based on dispatch role; prompts CANNOT override:

| Role          | Sandbox           | Use case                                 |
| ------------- | ----------------- | ---------------------------------------- |
| `build`       | `workspace-write` | Codex creates/modifies owned files       |
| `review`      | `read-only`       | Codex audits without modifying           |
| `audit-deep`  | `read-only`       | Multi-rubric phase-exit audit            |
| `fix-loop`    | `workspace-write` | Codex applies fixes from review findings |
| `blind-retry` | `read-only`       | Fresh-claude verification on dispute     |

Why: workspace-write during review let codex restore deleted files in packet-05. Read-only is fail-safe.

### 18.2 BUILD BRIEF schema (rejected if non-conforming)

Every BUILD BRIEF must include these sections in order:

1. ROLE — agent + sandbox + family + ONE goal
2. ★★★ HARD CONSTRAINTS ★★★ — numbered DO-NOT-TOUCH list with rationale
3. OWNED FILES — exact path list (no globs unless explicit)
4. FIXES / TASKS — per-finding format: file:line + current bug + fix + test + owned files
5. ARCHITECTURE — code-shaped pseudocode for cross-file wiring
6. ACCEPTANCE — 6-row mechanical gate table
7. VERIFICATION SEQUENCE — grep-based scope check + gate run + integration test pass
8. OUTPUT — exact result file path + structured changelog format
9. BANNED PHRASES — sycophancy filter

Pipeline rejects briefs missing any required section. Template at `.council/templates/BUILD-BRIEF-TEMPLATE.md`.

### 18.3 Owned-files scope-gate (post-build enforcement)

After every codex build, gate runs:

```bash
git status --porcelain | grep -vE "^.. (<owned-files-regex>)$"
```

If output is non-empty → REJECT. Out-of-scope file edits block commit.

### 18.4 Anti-restoration ledger

When orchestrator deletes a file, append to `.zer0/deleted-this-session.txt`. Pre-commit hook checks: any file on the ledger that exists on disk → REJECT. Prevents the packet-05 restoration loop.

### 18.5 Packet-sealed-gate

Review and fix-loop dispatches require a clean working tree. If `git status --porcelain` is non-empty when a review/audit is dispatched → REJECT. Forces commit-then-review sequence; never review working-tree state.

### 18.6 Two-pass phase-exit audit (THE KEY GATE)

Every phase exit requires BOTH audit passes:

**Audit 1 — Generic deep audit** (codex with rubric A-H):

- Wiring, types, tests, scope, end-to-end paths
- Catches ~70% of issues
- Cost: ~$0.10-0.20

**Audit 2 — Missed-dimensions audit** (codex with explicit dimension rubric):

1. Spec literal compliance (line-by-line)
2. Determinism (workflow constraint)
3. Idempotency + compensation (activity retry)
4. Race conditions / concurrency
5. Resource exhaustion
6. Observability — debuggable in prod?
7. Failure injection scenarios
8. Documentation drift

Both must return PASS verdicts before phase exit. Either FAIL → fix-loop required.

Empirical proof from Phase-1: Audit 1 caught 13 wiring gaps (3 P0). Audit 2 caught the dimensions Audit 1 missed. Without Audit 2, Phase-2 would have built on top of `node -e` scaffold dispatches and synthetic gate transitions = 10+ debug sessions.

### 18.7 Determinism enforcer (workflow lint rule)

For every file under `src/temporal/workflows/`, lint rule flags:

- `Date.now()`, `Math.random()`, `crypto.randomUUID()` (use `workflow.workflowInfo().runStartTime` etc.)
- `process.env.*` access
- `fs.*` calls
- Network calls outside `proxyActivities`
- `console.log` (use `workflow.log`)

Build fails on any flag. Determinism is not optional for Temporal workflows.

### 18.8 Idempotency test harness

Every persistence activity test must include the assertion:

```typescript
it("is idempotent on retry", async () => {
  await activity(input);
  await activity(input); // second call
  // assert: same observable outcome (one row, no duplicates, etc.)
});
```

Pipeline rejects activity files lacking this test pattern.

### 18.9 Headless `claude -p` constraints (locked)

For any internal `claude -p` dispatch the pipeline issues:

- NO `--effort` flag (causes hangs on Windows piped stdio with opus + complex prompts)
- `--output-format text` for markdown rubrics; `json` only with `--json-schema`
- Prompts inline all data; no "read these N files" instructions
- Hard timeout via outer process management

Reserved use cases: blind-retry verification only. First-pass review = orchestrator-direct (in-session claude with full spec context). Cross-family review = codex hostile audit (read-only sandbox).

### 18.10 Failure injection harness (Phase-2+)

Each phase-exit ships chaos tests in `tests/chaos/`:

- `kill -9` worker mid-dispatch
- SIGINT during start
- Disk full during blob persistence
- DB locked (concurrent worker)
- Temporal server killed mid-activity
- Subprocess hang / OOM-kill
- Network partition

Test asserts graceful degradation; no state corruption.

### 18.11 Why these gates matter (the cost of skipping)

Empirically observed in this project:

| Gate skipped              | Cost incurred                                             |
| ------------------------- | --------------------------------------------------------- |
| Sandbox-by-role           | 30 min restoration loop in packet-05                      |
| Owned-files scope-gate    | 20 dashboard files outside scope (packet-05 cleanup cost) |
| Audit 2 missed-dimensions | Phase-1 nearly shipped on `node -e` scaffold              |
| Build brief schema        | Codex builds scaffolds when unclear                       |
| Determinism enforcer      | Workflow non-determinism = replay failures = data loss    |

Total prevented cost: ~10 future debugging sessions per phase. These gates pay for themselves in the first phase exit.

### 18.12 Adapter env + buffer pattern (UNIVERSAL — every CLI adapter, every project)

When a packet adds files under `src/adapters/**` (or any module that spawns external CLI subprocesses):

**AUTH env contract (mandatory):** declare `AUTH_ENV_VARS: readonly string[]` constant naming every env var the CLI binary needs. Inherit those from `process.env` while keeping the rest stripped. Failing to do this means real CLIs (claude/codex/gemini) cannot authenticate — observed in packet-04 where adapters DROPPED the very keys they needed.

```typescript
const AUTH_ENV_VARS: readonly string[] = ["OPENAI_API_KEY", "OPENAI_BASE_URL"];
const env = pickEnv(process.env, AUTH_ENV_VARS, BASE_ENV);
```

**Buffer cap (mandatory):** every `execa` call sets `maxBuffer: ADAPTER_STDOUT_MAX_BYTES` (default 16_000_000 = 16MB). Beyond that, throw `DispatchError` with code `STDOUT_BUFFER_EXCEEDED`. Without this, a runaway CLI dump OOMs the activity worker.

**No placeholder dispatch (rule 9 of §18.2):** the activity that calls the adapter MUST invoke the real adapter through `getAdapter(name)` + `adapter.buildCommand(...)`. A `node -e "..."` placeholder is a packet-level REJECT. If a test stub is needed, gate it behind an explicit env var like `ZER0_DISPATCH_TEST_MODE=1` so the placeholder path is opt-in, not the default.

### 18.13 Persistence pattern (UNIVERSAL — every DB write across every project)

For every SQLite (or equivalent) write activity:

- Use prepared statements with bound parameters; never string concatenation.
- For UPDATE statements, check `Statement.run().changes`. If 0 rows updated when a row was expected, throw `ApplicationFailure.create({ nonRetryable: true, type: "MISSING_TARGET_ROW" })`. Silent no-op on missing target = REJECT (caused packet-06 audit P1).
- Foreign-key constraints declared at schema time AND enforced via `PRAGMA foreign_keys = ON` in DB open.
- For idempotent inserts, use `INSERT OR IGNORE` paired with a unique index on the dedup key; document the dedup contract in TSDoc `@idempotent` tag.
- For multi-step writes (e.g., blob + DB row), document the compensation path in TSDoc `@compensation` tag — what to do if step 2 fails after step 1 succeeded. Orphan blobs without compensation = REJECT.

### 18.14 Phase-N+1 readiness gate (UNIVERSAL)

Every phase's exit gate includes a "next-phase consumer needs surfaced" check. Before Phase N can be declared DONE, the brief for Phase N+1 must list explicitly:

- Which Phase-N exports it depends on
- Which Phase-N data shapes it reads (DB tables, blob layouts, types)
- Which Phase-N invariants it relies on

If Phase N+1's brief lists a need Phase N didn't ship, Phase N is NOT DONE — fix-loop applies. Caught in Phase-1 audit: Phase-2 (Context Compiler) needs `context_runs/context_items` query API, but Phase-1 didn't ship it.

### 18.15 Lifecycle invariants in `@file` headers

Every module that owns lifecycle state (a Temporal server handle, a DB connection, a worker promise, a subprocess group) MUST document its invariants in the `@file` header:

```typescript
/**
 * @file src/temporal/server.ts
 * @purpose Manages embedded Temporal dev server lifecycle for the local zer0 CLI.
 * @invariants
 *   - Module-level handle is single-instance per process
 *   - ensureTemporalServer is idempotent (safe to call multiple times)
 *   - stopTemporalServer is idempotent and signal-safe (registers SIGINT/SIGTERM cleanup)
 *   - External callers MUST go through ensureTemporalServer; never construct Server directly
 */
```

The `@invariants` block is grep-checked by `gate-clamps.mjs` on stateful files (lifecycle-bearing modules listed in `.council/lifecycle-files.txt`). Missing or stale invariant block = REJECT.

### 18.16 Universal application across user projects (NOT just self-application)

Every gate in §18 is bundled into the zer0 CLI as a default. When a user runs `zer0 init <project-path>`, the CLI installs:

- `.zer0/dispatch-policy.json` with sandbox-by-role mapping (§18.1)
- `.zer0/templates/BUILD-BRIEF-TEMPLATE.md` (§18.2 brief schema)
- Pre-commit hook that runs scope-gate (§18.3) + anti-restoration check (§18.4) + packet-sealed-gate (§18.5)
- `.zer0/audit-rubrics/` with the two-pass rubric (§18.6)
- `dependency-cruiser` rules for determinism enforcer (§18.7)
- Vitest fixture for idempotency test pattern (§18.8)
- `.zer0/headless-constraints.md` (§18.9 claude headless rules)
- `tests/chaos/` scaffold (§18.10 failure injection harness)
- `.zer0/lifecycle-files.txt` registry (§18.15)

Users CAN extend or override individual gates by editing `.zer0/dispatch-policy.json`, but cannot disable the gate enforcement system itself without explicit `--unsafe-no-discipline` flag (which prints a banner warning at every command).

The principle: zer0 CLI is the SAFE default. The gates protect users from the failure modes we burned 6+ packets discovering. Every user project inherits the lessons without relearning them.

---

## 19. CONFIDENCE

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
