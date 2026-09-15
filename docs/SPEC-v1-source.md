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
  ▼
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
