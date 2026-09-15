# SPEC-ADDENDUM — v1 Add-Backs

**Purpose:** Sections present in the v1 spec (`docs/SPEC-v1-source.md`, 2026-05-02, council-derived 1046 lines) that did NOT make it into v6 (`docs/SPEC.md`, 2026-05-03, DeepSeek-integrated). Preserved here so nothing is silently dropped.

**Read order:** Read `docs/SPEC.md` first. This addendum is supplementary, not authoritative — if conflict, **v6 wins**.

---

## A1. Cost Model (from v1 §16)

Uses existing CLI subscriptions — no additional API keys. Cost depends on subscription tier and usage-based pricing.

**Estimated tokens per pipeline stage (single feature, ~500 lines of code):**

| Stage                  | Dispatches              | Avg tokens / dispatch | Total tokens |
| ---------------------- | ----------------------- | --------------------- | ------------ |
| Intake                 | 1 (Claude)              | ~4k                   | ~4k          |
| Plan                   | 1 (Claude)              | ~8k                   | ~8k          |
| Build (single)         | 1 agent                 | ~20k                  | ~20k         |
| Build (tournament)     | 3 agents                | ~20k each             | ~60k         |
| Review                 | 2 reviewers             | ~12k each             | ~24k         |
| Fix Loop (1 iteration) | 1 builder + 2 reviewers | ~16k avg              | ~48k         |
| Audit                  | 1 (Claude)              | ~8k                   | ~8k          |

**Estimated dollar totals:**

- Single-agent build: ~60k tokens (~$0.50–2.00 depending on provider/tier)
- Tournament build: ~100k tokens (~$1.00–4.00)
- Full pipeline with 1 fix loop: ~150k tokens (~$2.00–6.00)

These are rough estimates. The IntakeWorkflow MUST present a cost estimate to the user before proceeding (per v6 invariant 11 — "Agents submit artifacts. Gates decide completion." User confirms cost = a gate).

Cost tracking is logged per dispatch in `dispatches` table (`tokens_in`, `tokens_out` columns from CLI output parsing where available). The cost circuit breaker (v6 Phase 6) consumes this data.

---

## A2. Anti-Requirements (from v1 §11)

Things we explicitly do NOT build. Listed here because v6 covers most via invariants but not as an explicit deny list.

1. **No multi-agent chat.** Agents do not converse with each other. They communicate through durable artifacts — diffs, findings, attestations.
2. **No GUI in MVP.** Temporal Web UI provides visibility. Custom dashboard is Phase 7 (per v6 §16).
3. **No cloud deployment in MVP.** Local-first. `temporal dev server` (or `docker compose up temporal`) for local dev.
4. **No vector embeddings in MVP.** Start with AST + FTS5 over SQLite. Add embeddings only if FTS + AST retrieval proves insufficient.
5. **No API keys required.** Uses existing CLI subscriptions. Cost is usage-based through existing subscriptions.
6. **No framework lock-in.** CLI adapters are thin wrappers. Adding a 4th model (e.g., DeepSeek) should require only a new adapter, not architectural changes.
7. **No agent-as-controller.** v6 invariant #1 — but worth restating. AI agents are workers. Deterministic code (Temporal + gates + Context Compiler) is the controller.
8. **No "vibes-based done."** v6 invariant #11 — agents never decide they're done. Gates do.

---

## A3. Phase 0 Spike — Failure Resolution (NOT fallbacks for Temporal)

v6 §16 lists Phase 0 spike targets but doesn't specify what to do if a spike FAILS.

> **CORRECTION 2026-05-03 (codex audit F-001):** the previous version of this section listed a "raw Node.js / JSON state machine" fallback for Temporal failure. That contradicted `docs/SPEC.md` line 63: **"There is NO fallback to a custom state machine."** Temporal is non-negotiable per v6. This table is rewritten to reflect that.

| Spike                                | Validates                                                                         | If FAIL → Resolution                                                                                                                                                                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Temporal on Windows                  | `temporal server start-dev` runs + workflow spawns CLI subprocess + survives kill | **NO custom fallback (per v6).** Resolution paths in priority order: (1) install Temporal CLI (`scoop install temporal` or download from temporal.io); (2) Docker Desktop + WSL2 + `docker compose up temporal`. **Phase 1 BLOCKED until Temporal works.** |
| Promptfoo (Phase 0 per v6 §16)       | `promptfoo eval` accepts a config + grader + runs without crash                   | Lower-fidelity manual grading via SQLite review-quality queries. Lose A/B test infrastructure for prompt versioning. Document override per v6 invariant 12.                                                                                                |
| LangGraph JS (Phase 5 only)          | `Send()` fan-out to 3 CLI subprocesses works on Windows                           | Per `docs/PLAN.md` §19 q2: skip LangGraph entirely. Use `Promise.all()` + Temporal child workflows for tournament. ~100 LOC custom — already the recommended path.                                                                                         |
| Tree-sitter native binding (Phase 6) | Compiles on Windows for TypeScript repo-map generation                            | Regex-based symbol extraction (`export function`, `export class`, `import { }` patterns). Lower-quality repo maps. Functional. Loses cross-language support.                                                                                               |
| `ts.transpileDeclaration()`          | Sub-100ms per file, >2x compression on real TS                                    | None — use raw file slicing or `symbol_signature` level. Loses 6-20x compression. Larger context packs.                                                                                                                                                    |
| better-sqlite3 prebuilt binaries     | Install on Windows without `node-gyp` / Python                                    | Fall back to `node-gyp` build (slower install but works). One-time install delay. No runtime impact.                                                                                                                                                       |

### Status: Prior session (different repo) vs this repo

| Spike                   | Prior PASS (Agents-Zer0)              | This repo (zer0-agent-ci)       |
| ----------------------- | ------------------------------------- | ------------------------------- |
| Temporal SDK loads      | ✅ PASS                               | ⏳ requires `npm install` + run |
| Temporal dev server     | ✅ PASS (needed CLI install)          | ⏳ unverified                   |
| Workflow + subprocess   | ⏳ unverified in prior session either | ⏳ unverified                   |
| Worker kill / resume    | ⏳ unverified in prior session either | ⏳ unverified                   |
| execa + 3 CLIs          | ✅ PASS                               | ⏳ requires `npm install` + run |
| better-sqlite3 + WAL    | ✅ PASS                               | ⏳ requires `npm install` + run |
| ts.transpileDeclaration | ✅ PASS (2.6x compression, 54ms)      | ⏳ requires `npm install` + run |
| Promptfoo               | ⏳ never validated in prior session   | ⏳ unverified                   |

**Phase 0 is NOT complete until every row above shows PASS in the "this repo" column with evidence in `.council/spike-evidence/`.** The prior PASS status is informational only — it proves the stack CAN work, not that it works HERE.

Re-runnable: `npm run spike:all` (after `npm install`).

---

## A4. Methodology Note (from v1 §18)

Lessons from how v1 was built — applicable to v6 build process:

1. **Constrained prompts produce convergent, safe answers.** When all 3 models got the same 7 structured questions, they produced near-identical "contract-first worktree dispatch" architectures. **Lesson:** for innovation, give models open prompts. For convergence on a known path, give them structure.

2. **Free prompts produce genuinely novel ideas.** A 10-line open prompt with zero structure produced the tournament/competitive build idea — which never appeared under constrained prompts.

3. **Research before design prevents reinventing the wheel.** Framework research (AutoGen, LangGraph, CrewAI, Temporal, A2A) corrected multiple false assumptions about what existing tools can do.

4. **Show the audit AS INPUT, not afterthought.** Showing the honest 12.5% failure audit to the council produced sharper, more defensive architectures than brainstorming from scratch.

5. **Models arguing for decisions beats models generating options.** "Pick one and argue why" produced more useful output than "what's your best idea?"

**Applied to Phase 1 build:** When dispatching knights for cross-model review, alternate between constrained prompts (when verifying spec compliance) and free prompts (when looking for missed issues).

---

## A5. ROUND_TABLE.md → Per-Model Generation (from v1 §8.5)

`ROUND_TABLE.md` is the canonical instruction file. The Context Compiler generates:

- `AGENTS.md` (Codex reads this)
- `CLAUDE.md` (project-level — not user-level `~/.claude/CLAUDE.md`)
- `GEMINI.md` (Gemini reads this)

**Why generated, not hand-maintained:** three divergent files rot. The TeamWork project showed this — the AGENTS.md and GEMINI.md there became stale `[e.g., Next.js]` placeholders that nobody updated.

**Generator algorithm (Phase 1 deliverable — `src/codegen/round-table.ts`):**

```typescript
function generatePerModelInstructions(roundTable: string): {
  agentsMd: string; // Codex variant
  claudeMd: string; // Claude variant
  geminiMd: string; // Gemini variant
} {
  // 1. Parse ROUND_TABLE.md into sections
  // 2. For each agent, select sections relevant to its role:
  //    - Codex (builder): stack, mechanical clamps, ownership, output format, banned patterns
  //    - Claude (orchestrator): role definition, invariants, banned behaviors, evidence discipline
  //    - Gemini (researcher/reviewer): research grounding, review schema, banned behaviors
  // 3. Add the "GENERATED — do not hand-edit" header
  // 4. Write to AGENTS.md / CLAUDE.md / GEMINI.md at project root
}
```

For Phase 1 the three files are hand-written (this commit). After `src/codegen/round-table.ts` ships, regenerate them and verify content equivalence (regression test).

---

## A6. Council Transcript Index (from v1 §17 — adapted)

v1 referenced `.council/cross-model/` as the council transcript archive. v6 uses `.zer0/blobs/` for prompts and outputs but doesn't preserve the human-readable council transcripts.

**Decision:** keep BOTH:

- `.zer0/blobs/{sha256}` for content-addressed evidence (machine truth)
- `.council/cross-model/{round}-{model}.md` for human-readable transcripts (operator review)

The two stay in sync via the `dispatches` table — every entry has a `blob_path` AND a `transcript_path`.

---

## A7. Definition of Done — Per Phase (from v1 §14, expanded)

v6 §16 has phase descriptions but lighter on per-phase DoD. Tightening:

| Phase                                | DoD (must be demonstrated, not claimed)                                                                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase 0 Spike                        | All 5 spike scripts return exit 0 with PASS evidence in `.council/spike-evidence/`                                                                                                                                 |
| Phase 1 Spine + Security + Rubric    | Hardcoded "/health endpoint returns {status:ok}" task: dispatched → built → reviewed (P0=0) → gated → merged → SQLite has full evidence trail. Zero manual steps after `npm run dev`.                              |
| Phase 2 Context Compiler + Memory    | Same /health task as Phase 1 but with Context Compiler producing the prompt. Manifest reproduces the exact prompt from blob hash. Hostile isolation verified: reviewer pack contains ZERO bytes from builder pack. |
| Phase 3 Intent + Pipeline            | A vibe prompt ("add user auth") → Intent Brief → Q&A → Research → Spec → Architecture → Plan, all artifacts in `.council/runs/{id}/`.                                                                              |
| Phase 4 Build/Review/Fix + Stability | Inject a P0 deliberately → workflow halts at FixGate → Stability Monitor escalates after 2 consecutive same-P0 failures.                                                                                           |
| Phase 5 Tournament                   | 3 agents build same task in 3 worktrees, arbiter selects winner via deterministic scoring, evidence in `tournament_results`.                                                                                       |
| Phase 6 Hardening + Learning         | Promptfoo eval shows enrichment flag X has acceptance delta — measurable, not hypothetical.                                                                                                                        |
| Phase 7 GUI + Validation             | Dogfood: Zer0 Agent CI builds a real second app end-to-end with no code changes to the orchestrator.                                                                                                               |

---

## A8. Error Handling Strategy — Infra vs Agent (from v1 §13.1)

v6 mentions errors via Stability Monitor. v1 had a clearer split:

**Infrastructure errors** (Temporal handles):

- CLI process timeout → Activity timeout → retry with backoff
- CLI process crash (non-zero exit) → retry up to 2x, then fail Activity
- SQLite write lock contention → `busy_timeout(5000)` → fail with clear error
- Worktree creation fails (branch exists) → unique branch name with timestamp suffix
- Temporal server crash → workflows resume automatically from last checkpoint

**Agent errors** (workflow logic handles):

- Agent produces no output → treat as build failure, enter FixLoop or escalate
- Agent modifies forbidden files → diff validation rejects, re-dispatch with stricter prompt
- Agent output unparseable → log raw to dispatch artifacts, treat as failure
- All tournament entries fail → escalate to human with best-performing entry's error details
- Reviewer produces zero findings → ACCEPT as clean (not an error — code might actually be good)

The reviewer-zero-findings case is critical: don't let the system require "at least one finding" or it will manufacture them. Trust the rubric.
