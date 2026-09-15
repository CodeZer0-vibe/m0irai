# Research: DeepSeek V4 Architecture Applications to Zer0 Agent CI

**Date:** 2026-05-03
**Status:** Council-reviewed, findings approved
**Paper:** "DeepSeek-V4: Towards Highly Efficient Million-Token Context Intelligence" (April 2026)
**Council vote:** 3-model council evaluated all 9 proposed extensions + surfaced 5 additional applications
**Spec target:** SPEC-CANONICAL.md v5.0+

---

## 1. Executive Summary

The DeepSeek V4 paper solves problems at the model-training level that have DIRECT analogues in multi-agent code orchestration. DeepSeek's core insight — that feedback loops, signal explosion, and shortcut-taking are ENGINEERING problems solvable by architectural constraints (not by "better prompting") — validates and extends 6 specific components of the Zer0 Agent CI spec.

This document captures each finding, argues WHY it applies, specifies HOW it should be implemented, and records the council's decision (ADOPT/DEFER/REJECT) with reasoning.

---

## 2. Source Material

### Primary Sources

| Source                                | URL                                                                                                                                                                      | What it contains                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| DeepSeek V4 Technical Report Summary  | https://framia.pro/page/en-US/news/deepseek-v4-paper                                                                                                                     | 8 key findings, benchmarks, post-training pipeline          |
| Training System Analysis (Fireworks)  | https://fireworks.ai/blog/what-deepseek-v4-says-about-training-platforms                                                                                                 | Infrastructure, trajectory logging, checkpoint patterns     |
| Architecture Deep Dive (MarkTechPost) | https://www.marktechpost.com/2026/04/24/deepseek-ai-releases-deepseek-v4-compressed-sparse-attention-and-heavily-compressed-attention-enable-one-million-token-contexts/ | CSA/HCA detail, post-training, GRPO, on-policy distillation |
| Easter Eggs & Admissions (36kr)       | https://eu.36kr.com/en/p/3782104958426114                                                                                                                                | "Alchemy" admission, Think Max weakness, internal feedback  |
| OpenLM Benchmarks                     | https://openlm.ai/deepseek-v4/                                                                                                                                           | SWE-bench 80.6%, reasoning modes, specialist training       |
| NIST CAISI Evaluation                 | https://www.nist.gov/news-events/news/2026/05/caisi-evaluation-deepseek-v4-pro                                                                                           | Independent safety evaluation                               |

### Key Paper Stats

- 1.6T parameters, 49B activated per token (MoE)
- 1M token context window
- Trained on 33T tokens
- 27% FLOPs of predecessor at 1M tokens
- 10% KV cache of predecessor at 1M tokens
- SWE-bench Verified: 80.6%
- Codeforces: 3206 rating (23rd globally among humans)
- Putnam 2025: 120/120 (perfect score)

---

## 3. Finding 1: Anticipatory Routing → Hostile Isolation + Blind Retry Review

### What DeepSeek Does

MoE (Mixture of Experts) routing creates a feedback loop: routing decisions reinforce outlier values in expert layers, causing training collapse. DeepSeek decouples by computing routing indices using HISTORICAL parameters (θ\_{t-Δt}), not current state. This breaks the cycle.

Technical detail: "Routing indices at step t are computed using historical parameters θ\_{t−Δt}, breaking the cycle in which routing decisions reinforce outlier values." The system monitors internal statistics and activates anticipatory routing ONLY when a spike is detected, with ~20% overhead while active.

### Why This Applies to Zer0

Sycophancy in multi-agent review IS the same feedback loop:

1. Agent A builds code with specific intent
2. Agent B reviews — if it sees Agent A's reasoning, it CONFIRMS (sycophancy)
3. Confirmation reinforces confidence in potentially flawed code
4. Quality collapses over iterations

Our existing hostile isolation (reviewer never sees builder reasoning) already breaks this loop at the SPATIAL level. But the FIX LOOP introduces a TEMPORAL feedback loop:

1. Reviewer finds P1 issues
2. Builder fixes
3. SAME reviewer (or one that sees prior findings) re-reviews
4. Reviewer anchors on what was previously flagged, rubber-stamps the "fix" without full re-evaluation

### How to Implement

**Blind Retry Review Protocol:**

The fix-loop reviewer receives:

- The CURRENT code (post-fix)
- The spec section + acceptance criteria
- The contracts.ts
- The Domain Pattern Library rubric
- NOTHING about what was previously flagged

The reviewer conducts a FRESH hostile review, as if seeing the code for the first time.

**Separately**, a mechanical "Fix Verifier" (deterministic, not AI) checks:

- Previous P0/P1 findings → grep for the specific patterns cited → confirm they're gone
- This is a simple diff check, not a full review

```typescript
// In review.ts
interface FixLoopReviewConfig {
  blindReview: true; // Reviewer gets clean context
  priorFindingsExcluded: true; // Never included in Context Pack
  fixVerifier: {
    // Mechanical, not AI
    checkPriorP0Resolved: true;
    method: "grep-for-cited-patterns";
  };
}
```

### Council Decision

| Knight | Decision                                                             |
| ------ | -------------------------------------------------------------------- |
| Claude | ADOPT Phase 2 — cheap (just exclude one section from Context Pack)   |
| Codex  | ADOPT — two-track: blind reviewer + mechanical fix-verifier          |
| Gemini | ADOPT — prevents lazy optimization toward "verify this specific fix" |

**UNANIMOUS ADOPT.** Implementation: Phase 2 (enforcement layer). Add to SPEC-CANONICAL §3 Phase 8.

---

## 4. Finding 2: GRPO → Tournament as Group-Relative Selection + Learned Routing

### What DeepSeek Does

Group Relative Policy Optimization replaces a separate reward model with GROUP COMPARISON. Instead of training a reward model and then optimizing against it, GRPO:

1. Generates N outputs from the same prompt
2. Ranks them within the group
3. Optimizes the policy toward the higher-ranked outputs

No separate judge. The GROUP provides the signal.

### Why This Applies to Zer0

Tournament mode IS GRPO for code generation:

1. Dispatch 3 agents on the same task
2. Each produces a code implementation
3. Rank by: tests pass, lint clean, diff size, acceptance criteria coverage
4. Select winner — the GROUP comparison is the reward signal

The proposed extension: track tournament outcomes per agent per feature-type. Over time, route tasks to the historically strongest agent without running a full tournament every time. This is "policy optimization" — learning routing from group-relative outcomes.

### How to Implement

**Phase 1-4:** Run tournaments, store outcomes in SQLite. No automatic routing.

```sql
-- New table: tournament results
tournament_results(
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  feature_type TEXT,           -- 'authentication', 'api-endpoint', etc.
  winner_agent TEXT NOT NULL,
  agents_json TEXT NOT NULL,   -- all participants + scores
  selection_criteria_json TEXT, -- what metrics determined winner
  created_at TEXT NOT NULL
)
```

**Phase 5+:** After 20+ tournament results per feature-type, auto-route:

```typescript
function selectBuilder(
  featureType: string,
  availableAgents: AgentName[],
): AgentName {
  const results = db.query(
    `SELECT winner_agent, COUNT(*) as wins 
     FROM tournament_results 
     WHERE feature_type = ? 
     GROUP BY winner_agent 
     ORDER BY wins DESC`,
    [featureType],
  );
  if (results.total < 20) return "codex"; // default, not enough data
  return results[0].winner_agent; // historically strongest
}
```

**Safeguard (Diversity Floor):** No agent drops below 20% of dispatches regardless of win rate. Reason: if an agent never gets dispatched, its prompt templates never improve, creating a death spiral.

### Council Decision

| Knight | Decision                                                |
| ------ | ------------------------------------------------------- |
| Claude | ADOPT Phase 3 (auto-route after 20+ dispatches)         |
| Codex  | DEFER Phase 4-5 (sparse data early, feedback loop risk) |
| Gemini | DEFER Phase 5+                                          |

**DECISION: Track from Phase 1. Auto-route Phase 5.** The schema costs nothing to add early. Auto-routing waits for sufficient data.

---

## 5. Finding 3: SwiGLU Clamping → Aggressive Mechanical Gates

### What DeepSeek Does

Hard mathematical constraint: SwiGLU activation values clamped to [-10, 10]. Signal CANNOT blow up because the math FORBIDS it. Not a soft penalty. Not a hope. A HARD CLAMP that makes explosion structurally impossible.

Overhead: 6.7% of runtime. Worth it because it prevents catastrophic training run crashes.

### Why This Applies to Zer0

Code quality "explosion" (skeleton code, `as any` everywhere, 500-line functions) is the same failure mode — gradual degradation that compounds across tasks. Our existing gates (tsc, biome, slop detection) are CLAMPING. But we can be more aggressive.

The insight: clamping is CHEAP (grep-level checks, Biome rules) and prevents EXPENSIVE failures (AI review finding 30 issues, fix loops, scrapped code). The 6.7% overhead principle applies: spend 1 second on mechanical checks to save 5 minutes of AI review time.

### How to Implement

Add to the BuildGate (runs after every build task, BEFORE AI review):

```typescript
const CLAMPS = {
  maxFunctionLength: 50, // lines — configurable per repo
  maxCyclomaticComplexity: 15, // Biome rule
  maxFileLength: 500, // lines — suggests decomposition
  zeroConsoleLog: true, // production code only (not tests)
  zeroAsAny: true, // already in slop detection
  maxParameters: 5, // function params — suggests object arg
};
```

**Finding-Inflation Clamp (from Codex Knight):**

If a single review dispatch produces >15 findings, flag as "shotgunning" and apply 25% confidence discount during synthesis. This prevents a model from flooding with noise.

```typescript
if (review.findings.length > 15) {
  review.qualitySignal = "high_volume_discount";
  review.confidenceMultiplier = 0.75;
  log.warn(
    `Review produced ${review.findings.length} findings — applying volume discount`,
  );
}
```

### Council Decision

| Knight | Decision                                             |
| ------ | ---------------------------------------------------- |
| Claude | PARTIAL ADOPT — finding-inflation clamp specifically |
| Codex  | ADOPT — configurable thresholds with waivers         |
| Gemini | ADOPT — mechanical limits before expensive review    |

**DECISION: ADOPT.** Add configurable clamps to BuildGate. Add finding-inflation clamp to ReviewGate. Both are cheap mechanical checks.

---

## 6. Finding 4: Think Max Mode → Strengthened Layer 6 Endcap

### What DeepSeek Does

DeepSeek's "Think Max" mode requires a special system prompt: "You MUST be very thorough...no shortcuts permitted." This exists because models NATURALLY take shortcuts — the base model produces shallow output unless EXPLICITLY instructed at high-attention positions to be thorough.

The model has three modes: Non-think (fast), Think High (deliberate), Think Max (exhaustive). Same weights, different system prompts. The prompt determines depth.

### Why This Applies to Zer0

Our 6-layer Context Pack exploits the "Lost-in-the-Middle" effect: critical instructions at start (Layer 1 — primacy) and end (Layer 6 — recency) get the highest attention. Layer 6 (endcap) is the LAST thing the model reads before generating — it's the equivalent of Think Max's system prompt.

Currently, Layer 6 repeats the task and acceptance criteria. The extension: add an EXPLICIT thoroughness demand at this high-attention position.

### How to Implement

Add to the Context Compiler's Layer 6 template:

```markdown
## FINAL VERIFICATION (before you output ANYTHING)

1. Count the acceptance criteria above. You must address ALL of them.
2. For EACH criterion, verify your code handles it — including the error case.
3. If ANY function body is less than 5 lines for a non-trivial operation, you are taking a shortcut.
4. If ANY error path returns a generic message without context, you are being lazy.
5. If you are about to output code shorter than the task's complexity demands — STOP and expand.
6. Your output will be MECHANICALLY verified against the rubric. Shortcuts WILL be caught and rejected.

If context is insufficient to complete the task fully, output: [BLOCKED: specific missing context]
Do NOT produce partial or placeholder implementations under any circumstances.
```

**Why this works (from the paper):** DeepSeek's Think Max mode with explicit thoroughness instructions increased Putnam math scores from partial to PERFECT (120/120). The same model, same weights — just a different instruction at the high-attention position. The prompt determines whether the model uses its full capability or takes shortcuts.

### Council Decision

| Knight | Decision                                                          |
| ------ | ----------------------------------------------------------------- |
| Claude | ADOPT Phase 1 — zero infrastructure cost                          |
| Codex  | ADOPT — keep it short and forceful, long endcaps dilute attention |
| Gemini | ADOPT — zero-cost, high-yield prompt adjustment                   |

**UNANIMOUS ADOPT Phase 1.** Add to Context Compiler Layer 6 template. No code changes needed beyond template text.

---

## 7. Finding 5: Generative Reward Model → Structured YAML Rubric Review

### What DeepSeek Does

For tasks where correctness "cannot be reduced to tests or exact answers" (e.g., code quality, architecture elegance, readability), DeepSeek uses a Generative Reward Model — the actor itself evaluates using rubrics, producing rich structured feedback rather than scalar scores.

Technical detail: "For hard-to-verify tasks, a generative reward model replaces scalar scoring. The actor learns evaluative behavior alongside generation through rubric-guided trajectory evaluation."

### Why This Applies to Zer0

Our hostile review IS a generative reward model. The reviewer (Claude) evaluates code that COMPILES and PASSES TESTS but might still be architecturally wrong, missing edge cases, or poorly structured. Mechanical gates can't catch this — you need AI judgment.

The problem: unbounded review ("find what's wrong") produces inconsistent, incomparable outputs across models. One model writes 7 paragraphs. Another writes 2 bullet points. Synthesis becomes subjective.

The solution: STRUCTURED RUBRIC. The reviewer receives a checklist and grades each item explicitly. This makes AI review MEASURABLE, COMPARABLE, and AUDITABLE.

### How to Implement

The review prompt receives the YAML checklist (from Domain Pattern Library + task acceptance criteria) as a mandatory grading rubric:

```markdown
## REVIEW RUBRIC (grade EVERY item — do not skip any)

For each requirement below, output EXACTLY one of:

- MET — with file:line evidence
- NOT_MET — explain what's missing or wrong
- UNVERIFIABLE — explain what would be needed to verify

### From acceptance criteria:

- [ ] Returns 401 for invalid token: \_\_\_
- [ ] Returns 404 for unknown user ID: \_\_\_
- [ ] Rate limits to 100 req/min per user: \_\_\_

### From authentication.yaml (filtered by scale=production):

- [ ] AUTH-001: JWT with RS256 signing (not HS256): \_\_\_
- [ ] AUTH-002: Refresh token rotation: \_\_\_
- [ ] AUTH-005: Rate limit login attempts (5/IP/15min): \_\_\_

### Cross-cutting (from input-validation.yaml):

- [ ] INPUT-001: All user input validated with schema: \_\_\_
- [ ] INPUT-003: Error messages don't leak internals: \_\_\_
```

**Output format (JSON, Zod-validated):**

```typescript
interface RubricReviewOutput {
  verdict: "PASS" | "FAIL" | "PASS_WITH_COMMENTS";
  rubricResults: Array<{
    id: string; // "AUTH-001", "acceptance-3"
    status: "MET" | "NOT_MET" | "UNVERIFIABLE";
    evidence: string; // file:line or explanation
  }>;
  additionalFindings: Finding[]; // beyond rubric
  categoriesChecked: string[];
}
```

**Why this is the HIGHEST-VALUE extension:** It transforms review from subjective prose into a queryable, comparable data structure. The SQLite ledger can answer: "Which requirements are consistently NOT_MET across runs?" "Which agent finds more issues per rubric item?" "Is AUTH-002 ever verified as MET?"

### Council Decision

| Knight | Decision                                                            |
| ------ | ------------------------------------------------------------------- |
| Claude | ADOPT Phase 1 — highest-value extension, makes review measurable    |
| Codex  | ADOPT — MET/NOT-MET/UNVERIFIED feeds ledger directly                |
| Gemini | ADOPT — grounds review mechanically, prevents hallucinated findings |

**UNANIMOUS ADOPT Phase 1.** Add to Context Compiler review template + adapt review parsing to expect structured rubric output.

---

## 8. Finding 6: Intelligence from Compression → Trust Tight Budgets

### What DeepSeek Does

Reducing KV cache to 10% of predecessor IMPROVED model performance at 1M tokens. The constraint forced the model to be MORE selective about what to remember. Less data, better decisions.

Theoretical basis: "Lost in the Middle" research shows models heavily weight primacy and recency, with a massive blind spot in the middle 40-60%. Filling the middle with marginally-relevant context DEGRADES performance because it pushes critical information into the blind spot.

### Why This Applies to Zer0

When an agent produces bad output, the natural instinct is: "give it MORE context next time." This is WRONG. More context pushes critical information into the blind spot, dilutes attention, and increases the chance of the agent latching onto irrelevant details.

The correct response: improve SELECTION quality, not quantity.

### How to Implement

This is a PRINCIPLE, not a feature. Documented as an explicit anti-pattern:

**Anti-Pattern: Context Inflation**

```
WRONG: Agent produced bad output → expand context budget → include more files
RIGHT: Agent produced bad output → analyze WHAT was missing → replace irrelevant context with the specific missing piece
```

**Implementation in Context Compiler failure handling:**

```typescript
function handleBuildFailure(task: Task, failure: BuildFailure): ContextPack {
  // DO NOT: increase token budget
  // DO: replace irrelevant items with failure-specific context

  const newPack = compileContext(task, {
    // Same budget
    tokenBudget: task.contextBudget, // UNCHANGED

    // Replace lowest-scored items with failure context
    priorityOverrides: [
      { kind: "error_output", content: failure.stderr, score: 100 },
      { kind: "relevant_test", content: failure.failingTest, score: 95 },
    ],

    // Exclude items that were in the previous pack but clearly irrelevant
    excludeHashes: failure.previousPack.lowestScoredItems(3).map((i) => i.hash),
  });

  return newPack;
}
```

**Metric to track:** `context_efficiency = acceptance_rate / avg_token_count`. Higher is better. If efficiency drops as token counts rise, budgets are too generous.

### Council Decision

**UNANIMOUS ADOPT as architectural principle.** Add to Context Compiler design documentation. No code needed — it's a decision guideline for the token budgeting system.

---

## 9. Finding 7: Specialist-First Distillation → Builder Receives Distilled Spec Only

### What DeepSeek Does

Train 10+ domain specialists independently (math, code, agent tasks, instruction following). Then merge via on-policy distillation: the student trains on its OWN rollouts while teachers provide target distributions. The student never sees the teachers' internal reasoning — only their output distributions.

### Why This Applies to Zer0

Our 3 agents ARE specialists:

- **Claude:** Architecture, spec, review (structural reasoning)
- **Codex:** Code generation, test running (implementation)
- **Gemini:** Research, current docs, market analysis (information retrieval)

The PLAN phase IS distillation — it takes specialist outputs (research from all 3) and produces a unified plan. The BUILD phase is the student executing on its own — receiving the distilled plan, NOT the raw architect reasoning.

### How to Implement

Already implemented in SPEC-CANONICAL. This finding VALIDATES the existing design.

**What to verify during implementation:**

- BUILD BRIEF never includes raw research outputs (only synthesized requirements)
- BUILD BRIEF never includes architectural discussion (only the DECISION)
- BUILD BRIEF never includes other models' review findings from earlier phases
- Builder sees: WHAT to build + acceptance criteria + contracts.ts + .d.ts of dependencies

**Anti-pattern to guard against:**

```
WRONG: "Claude's architecture discussion concluded that we should use repository pattern
because [3 paragraphs of reasoning]..."

RIGHT: "Implement UserRepository using the repository pattern.
Interface: see contracts.ts:UserRepository."
```

### Council Decision

**UNANIMOUS VALIDATED.** Already in spec. No changes needed. Document as explicitly protected pattern.

---

## 10. Finding 8: Token-Granular Write-Ahead Logs → Future MCP Trajectory Capture

### What DeepSeek Does

Their sandbox execution environment (DSec) maintains "ordered trajectory logs of commands and results." Execution is "preemptible" with durable logging. Every tool call is an atomic logged event that survives process interruption.

### Why This Applies to Zer0

Currently, all agent dispatches are single-shot (non-interactive, `-p` mode). The agent gets a prompt, produces output, exits. Trajectory = one event.

In the future (MCP-enabled dispatches), agents will make MULTIPLE tool calls during a single dispatch. Each tool call is a separate event that should be logged for:

- Post-mortem: "the agent called readFile 7 times but never read contracts.ts"
- Replay: recreate what the agent did step-by-step
- Cost: track per-tool-call token consumption

### How to Implement (Phase 5+)

```typescript
interface TrajectoryEvent {
  dispatchId: string;
  sequenceNumber: number;
  timestamp: string;
  kind: "tool_call" | "tool_result" | "thinking" | "output";
  toolName?: string;
  inputHash: string; // → blob store
  outputHash: string; // → blob store
  durationMs: number;
  tokenCount?: number;
}

// SQLite table (Phase 5+)
// trajectory_events(id, dispatch_id, seq, timestamp, kind, tool_name, input_blob, output_blob, duration_ms, tokens)
```

### Council Decision

| Knight | Decision                                                  |
| ------ | --------------------------------------------------------- |
| Claude | DEFER Phase 4 (only valuable with GUI visualization)      |
| Codex  | DEFER Phase 5 (not needed unless MCP dispatch is central) |
| Gemini | DEFER (post-MVP)                                          |

**UNANIMOUS DEFER to Phase 5.** Add schema definition to spec now for forward-compatibility, but don't implement until MCP dispatches are enabled.

---

## 11. Finding 9: The "Alchemy" Admission → Empirical Prompt Validation

### What DeepSeek Does

DeepSeek explicitly admits: "Although a comprehensive theoretical understanding of [Anticipatory Routing and SwiGLU Clamping's] underlying mechanisms remains an open question for now, we are sharing them openly to foster further exploration by the community."

They ship what WORKS and measure it, rather than waiting for theoretical justification.

### Why This Applies to Zer0

We're adding multiple enrichment mechanisms (vocabulary activation, YAML patterns, structured rubrics, endcap strengthening) based on THEORETICAL reasoning from this paper. But we don't KNOW they improve output until we MEASURE.

The risk: enrichment that sounds smart but adds noise, wastes tokens, or confuses agents.

### How to Implement

**Enrichment Removal Protocol:**

Every enrichment mechanism gets an `enrichment_flag` in the dispatch record:

```sql
-- Add to dispatches table
enrichment_flags TEXT  -- JSON array: ["yaml-rubric", "vocabulary-activation", "endcap-v2"]
```

After 20+ dispatches with a given flag, compute:

```sql
SELECT
  enrichment_flag,
  AVG(CASE WHEN result = 'accepted' THEN 1.0 ELSE 0.0 END) as acceptance_rate,
  COUNT(*) as sample_size
FROM dispatches
WHERE enrichment_flags LIKE '%' || ? || '%'
GROUP BY enrichment_flag
HAVING COUNT(*) >= 20
```

If acceptance rate WITH a flag is NOT higher than WITHOUT → flag for removal review. The human decides, but the DATA drives the decision.

**Promptfoo integration:** Every prompt template change gets an eval ID. Changes that don't measurably improve golden-dataset scores are reverted.

### Council Decision

**UNANIMOUS ADOPT.** Implement as part of Promptfoo integration (Phase 3). The principle applies from day 1: treat every "paper-inspired" idea as a HYPOTHESIS, not architecture truth.

---

## 12. NEW APPLICATION: Multi-Token Lookahead in BUILD BRIEF

### Origin

DeepSeek's multi-token prediction trains the model to PLAN AHEAD, not just predict the next token. This improves code generation because the model considers what comes AFTER the current line.

### Application to Zer0

The BUILD BRIEF currently tells the agent: "Build task X. Here are your files, constraints, acceptance criteria." But it doesn't tell the agent what comes NEXT. This causes:

- Code that works but is structured in a way that makes the NEXT task harder
- Interfaces that are correct but don't anticipate the next consumer
- Database schemas that work now but require migration for task X+1

### How to Implement

Add to Context Compiler Layer 3 (Task Brief):

```markdown
## TASK CONTEXT

**Current task:** BUILD-005 — Implement user authentication service
**Next tasks (for forward-planning ONLY — do NOT implement these):**

- BUILD-006: Add role-based access control (will use AuthService.getUserRoles())
- BUILD-007: Add team invitation system (will use AuthService.validateInviteToken())

Design your interfaces to accommodate these future consumers without implementing their logic.
```

**Implementation:**

```typescript
function getTaskLookahead(currentTask: Task, plan: BuildPlan): string {
  const nextTasks = plan.tasks
    .filter((t) => t.depends_on.includes(currentTask.id))
    .slice(0, 2);

  if (nextTasks.length === 0) return "";

  return nextTasks
    .map(
      (t) => `- ${t.id}: ${t.objective} (will use ${t.contracts.join(", ")})`,
    )
    .join("\n");
}
```

### Council Decision

| Knight | Decision                                   |
| ------ | ------------------------------------------ |
| Claude | ADOPT Phase 1 — zero cost, prevents rework |
| Codex  | Not evaluated (wasn't in original 9)       |
| Gemini | Not evaluated                              |

**ADOPT Phase 1.** Zero infrastructure cost. Add 2-3 lines to Context Pack Layer 3 template.

---

## 13. NEW APPLICATION: Temperature Routing by Phase

### Origin

DeepSeek V4 supports three reasoning modes (Non-think, Think High, Think Max) — same model weights, different depth. The MODE determines output quality.

### Application to Zer0

Different pipeline phases need different reasoning depths. Research benefits from CREATIVE exploration (higher temperature). Build needs DETERMINISTIC precision (lower temperature). Review needs ANALYTICAL rigor (zero temperature).

### How to Implement

Add to CLI adapter configuration:

```typescript
const PHASE_TEMPERATURE: Record<PipelinePhasee, number> = {
  INTENT_COMPILE: 0.7, // creative translation
  VISION_QA: 0.5, // conversational but focused
  RESEARCH: 0.8, // broad exploration, novel connections
  SPEC: 0.3, // structured, precise
  ARCHITECTURE: 0.3, // analytical
  PLAN: 0.2, // deterministic decomposition
  BUILD: 0.2, // precise code generation
  REVIEW: 0.0, // maximum analytical rigor, zero creativity
  FIX: 0.2, // precise corrections
};
```

**Note:** Not all CLI adapters expose temperature. Claude `-p` mode uses default. Codex `exec` uses model defaults. Gemini supports `--temperature`. Where not configurable via CLI, include temperature instruction in the prompt: "Respond with maximum precision. Do not speculate."

### Council Decision

| Knight | Decision                            |
| ------ | ----------------------------------- |
| Claude | Not in original evaluation          |
| Codex  | Not in original evaluation          |
| Gemini | ADOPT Phase 1 — route temp by phase |

**ADOPT Phase 1** where CLI flags support it. For CLIs that don't expose temperature, use prompt-level instructions ("Be precise" vs "Explore broadly").

---

## 14. NEW APPLICATION: Negative Capability Ledger

### Origin (Codex Knight's original proposal)

DeepSeek tracks not just what works (win rate) but what FAILS (loss spikes, instability signals). Their spike detector triggers anticipatory routing ONLY when failure is detected. The system knows its own weaknesses.

### Application to Zer0

Track not just which model WINS tournaments, but which model consistently FAILS at specific things:

- Codex: tends to miss async error handling
- Claude: tends to over-abstract (too many classes)
- Gemini: tends to produce code that compiles but has shallow test coverage

Routing should AVOID known weaknesses, not just reward historical winners. This prevents the GRPO feedback loop where one model gets all the work and others atrophy.

### How to Implement

```sql
-- New table: agent failure patterns
agent_failure_patterns(
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  failure_category TEXT NOT NULL,  -- 'missing_error_handling', 'shallow_tests', 'over_abstraction'
  occurrence_count INTEGER DEFAULT 1,
  last_seen TEXT NOT NULL,
  example_finding_id TEXT,         -- reference to a finding that exemplifies this
  UNIQUE(agent, failure_category)
)
```

Populated by: parsing review findings for RECURRING patterns per agent. If Codex gets "missing error handling" flagged 5+ times → record as known weakness.

Used by: routing decisions exclude agents from tasks matching their known weaknesses:

```typescript
function filterByWeakness(
  agents: AgentName[],
  taskFeatures: string[],
): AgentName[] {
  return agents.filter((agent) => {
    const weaknesses = db.query(
      `SELECT failure_category FROM agent_failure_patterns 
       WHERE agent = ? AND occurrence_count >= 5`,
      [agent],
    );
    // Don't assign if task touches this agent's weakness
    return !taskFeatures.some((f) => weaknesses.includes(f));
  });
}
```

### Council Decision

| Knight | Decision                                                               |
| ------ | ---------------------------------------------------------------------- |
| Codex  | ADOPT Phase 3 (authored this idea)                                     |
| Others | Not directly evaluated but implicitly supported by diversity arguments |

**ADOPT Phase 3.** Requires enough review data to detect patterns (~30+ dispatches per agent).

---

## 15. NEW APPLICATION: Constraint Curriculum

### Origin (Codex Knight's original proposal)

DeepSeek uses curriculum training: start with 4K context, gradually expand to 1M. Don't overwhelm the system with maximum complexity from day 1.

### Application to Zer0

Start agents with STRICT constraints (anti-skeleton, max length, zero `as any`, mandatory error handling for EVERY call). Over time, selectively RELAX constraints only when evidence shows a specific constraint blocks valid solutions.

Example: "max function length 50 lines" might block a legitimate complex parser. When evidence (multiple findings of "constraint blocked valid code") accumulates, allow waiver for specific patterns.

### How to Implement

```typescript
interface ConstraintConfig {
  name: string;
  defaultSeverity: "hard_fail" | "soft_warn";
  waiverConditions: string[]; // documented conditions where relaxation is acceptable
  escalationPath: "auto_relax_after_3_waivers" | "never_auto_relax";
}

const CONSTRAINTS: ConstraintConfig[] = [
  {
    name: "max_function_length_50",
    defaultSeverity: "hard_fail",
    waiverConditions: ["parser functions", "state machine reducers"],
    escalationPath: "never_auto_relax", // always require explicit waiver
  },
  {
    name: "zero_console_log",
    defaultSeverity: "hard_fail",
    waiverConditions: ["CLI output functions"],
    escalationPath: "never_auto_relax",
  },
];
```

**Principle:** Constraints are TIGHT by default. Evidence required to loosen. Never loosen automatically. This matches DeepSeek's finding that CONSTRAINED systems produce BETTER output.

### Council Decision

**ADOPT as principle.** Implement configurable constraint severity in the gate engine (Phase 1). Waiver mechanism in Phase 3.

---

## 16. Summary: What Gets Added to SPEC-CANONICAL

### Phase 1 (zero/minimal cost — add immediately)

| #   | Extension                     | Implementation                                |
| --- | ----------------------------- | --------------------------------------------- |
| 4   | Strengthened Layer 6 Endcap   | Update Context Compiler template text         |
| 5   | Structured YAML Rubric Review | Update review prompt template + output parser |
| 12  | Multi-Token Lookahead         | Add next-2-tasks to Layer 3 template          |
| 13  | Temperature Routing           | Add phase→temperature map to adapter config   |
| 6   | Compression Principle         | Document anti-pattern in Context Compiler     |

### Phase 2 (enforcement layer)

| #   | Extension               | Implementation                                    |
| --- | ----------------------- | ------------------------------------------------- |
| 1   | Blind Retry Review      | Exclude prior findings from fix-loop Context Pack |
| 3   | Aggressive Clamping     | Add mechanical checks to BuildGate                |
| 3b  | Finding-Inflation Clamp | Add volume discount to ReviewGate                 |

### Phase 3 (learning layer)

| #   | Extension                   | Implementation                                           |
| --- | --------------------------- | -------------------------------------------------------- |
| 9   | Enrichment Removal Protocol | Add enrichment_flags to dispatches + measurement queries |
| 14  | Negative Capability Ledger  | New SQLite table + routing exclusion logic               |
| 15  | Constraint Curriculum       | Configurable severity + waiver mechanism                 |

### Phase 5 (tournament + advanced)

| #   | Extension              | Implementation                                              |
| --- | ---------------------- | ----------------------------------------------------------- |
| 2   | Learned Routing (GRPO) | tournament_results table + auto-routing after 20 dispatches |
| 8   | Trajectory Logging     | trajectory_events table for MCP-enabled dispatches          |

---

## 17. Theoretical Validation

The DeepSeek V4 paper validates the following EXISTING Zer0 design decisions:

| Zer0 Component                 | DeepSeek Equivalent         | Paper Evidence                                                                |
| ------------------------------ | --------------------------- | ----------------------------------------------------------------------------- |
| Hostile Isolation              | Anticipatory Routing        | Breaks feedback loops that cause quality collapse                             |
| Tournament Mode                | GRPO                        | Group-relative selection without separate reward model                        |
| Slop Detection + Gates         | SwiGLU Clamping             | Hard constraints that FORBID quality explosion                                |
| Anti-skeleton endcap           | Think Max mode              | Models take shortcuts unless explicitly prevented at high-attention positions |
| Domain Pattern Library rubrics | Generative Reward Model     | Rubric-guided evaluation for hard-to-verify tasks                             |
| Token budgeting                | KV cache compression        | Tight budgets force better selection, not worse output                        |
| Agent role separation          | Specialist-first training   | Independent specialists → distilled into unified plan                         |
| Blob store                     | Write-ahead trajectory logs | Durable, replayable evidence of every action                                  |
| Promptfoo evals                | "Alchemy" empiricism        | Ship what works, measure, remove what doesn't help                            |

The architecture is not just "well-designed" — it independently converges with frontier ML research on how to handle the exact problems (feedback loops, quality collapse, shortcut-taking, context degradation) that multi-agent code systems face.

---

## 18. Open Questions for Future Research

1. **Can we apply CSA-style sparse attention to context selection?** The Lightning Indexer scores compressed blocks and selects top-k. Our Context Compiler scores files and selects top-k. Could we use the same scoring algorithm?

2. **Is there a "loss spike" equivalent in agent output quality?** If we track per-dispatch quality scores, do they show sudden drops (analogous to loss spikes)? Could we detect and compensate automatically?

3. **Can on-policy distillation work across runs?** If we accumulate "winning code patterns" from past tournament results, can future agents learn from them? (This is the DSPy optimization question.)

4. **Does the 40% rule (max context for dynamic reasoning) apply to code agents?** DeepSeek's research says effective context is 1-5K tokens even in 1M windows. Our budgets assume 40%. Should we test tighter?
