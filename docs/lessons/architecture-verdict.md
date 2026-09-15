# Final Architecture Verdict — Senior Engineering Review

**Date:** 2026-05-03
**Reviewer:** zer0 (Claude Opus)
**Method:** Critical analysis of 3 competing architecture documents
**Principle:** Quality is the target. The best argument wins. No loyalty to my own work.

---

## The 3 Documents

| Doc   | Source                                  | Lines | Core Choice                                                                                       |
| ----- | --------------------------------------- | ----- | ------------------------------------------------------------------------------------------------- |
| **A** | SENIOR_ARCHITECTURE_DECISION.md         | 1,107 | Temporal + SQLite + Intent Compiler + Prompt Quality Lab + Context Compiler + LangGraph (bounded) |
| **B** | Gemini architecture_synthesis_report.md | 68    | Agent CI + Temporal + LangGraph + GUI                                                             |
| **C** | spec-final.md (ours)                    | ~950  | Custom pipeline + execa + SQLite + Context Engine + Prompt Enrichment + Policy gates              |

---

## Verdict: Document A Wins

**SENIOR_ARCHITECTURE_DECISION.md is the best architecture document.** Not close. Here's why, argued dimension by dimension.

---

### 1. Comprehensiveness

| Dimension                           | A                                                   | B                        | C                            |
| ----------------------------------- | --------------------------------------------------- | ------------------------ | ---------------------------- |
| Architecture decisions with reasons | 7 ADRs + rejection reasons                          | 7 ADRs (shallow)         | Implicit in tech stack table |
| Risk/gap analysis                   | **16 explicit gaps** a senior reviewer would attack | Zero                     | 10-item risk register        |
| Decision history (how we got here)  | Full council trail                                  | None                     | Research report references   |
| Remaining unknowns acknowledged     | Yes (sections 16.1-16.15)                           | No ("perfectly aligned") | Partially                    |
| Build order with done criteria      | 6 phases with spike                                 | 1 paragraph              | 5 phases with done criteria  |
| Critical corrections                | **12 explicit "do not" rules**                      | None                     | Implicit                     |

**Why A wins:** Document A is the only one that tells you what can go WRONG. Section 16 identifies 16 gaps (prompt injection, secrets, version drift, rate limits, licensing, supply chain, database migration, UI verification, test quality, merge strategy, autonomy modes, artifact retention, recon, quality metrics, operational packaging). No other document even attempts this. A senior engineer reviewing Document B would immediately ask "what about prompt injection?" and get no answer.

---

### 2. The Intent Compiler vs Prompt Enrichment Engine

| Feature                     | A (Intent Compiler)                                       | C (Prompt Enrichment)          |
| --------------------------- | --------------------------------------------------------- | ------------------------------ |
| Vibe → senior translation   | Yes, with IntentBrief schema                              | Yes, with YAML checklists      |
| Vocabulary map              | Yes (explicit subsystem)                                  | Yes (vocabulary field in YAML) |
| Quality rubric per artifact | **Yes (10 categories, becomes gate input)**               | No                             |
| Assumption map              | **Yes (explicit uncertainty tracking)**                   | No                             |
| Anti-patterns per domain    | \*\*Yes (explicit)                                        | Partially (prodlint rules)     |
| Evaluation infrastructure   | **Promptfoo + golden datasets + red-teaming**             | None                           |
| Prompt versioning           | **Yes (templates are production logic, must pass evals)** | No                             |
| DSPy for optimization       | Planned (after golden dataset exists)                     | No                             |

**Why A wins:** Both solve the same problem (translate vibe language into senior engineering requirements). But A treats prompt quality as a TESTABLE SYSTEM with evaluation infrastructure (Promptfoo), golden datasets, red-team probes, and version control. C treats it as static YAML files. The difference: A knows when its enrichment is working and can detect when it regresses. C can't.

The critical insight from A: **"Do not rely on 'better prompting' as an undocumented skill. Prompt templates, rubrics, examples, and evaluator results must be versioned artifacts."** This is engineering discipline applied to prompt engineering. C doesn't have this.

**What C adds that A lacks:** The specific OWASP ASVS mapping (300+ requirements by feature type), prodlint (52 empirically-derived rules), and scale-tier filtering (MVP/production/enterprise). These are the CONTENT that feeds A's Intent Compiler. A has the better architecture; C has better source data. They should be combined.

---

### 3. The Temporal Question (the biggest disagreement)

**A says:** Temporal is the spine. Non-negotiable.
**C says:** Temporal is overkill. 237MB, external server, saves ~150 LOC.

**Let me steelman both sides honestly:**

**FOR Temporal (A's position):**

- It IS the industry standard for durable execution (Netflix, Stripe, Uber)
- It DOES handle crash recovery, retries, timeouts, human gates, audit history natively
- Building these yourself IS reinventing the wheel — and wheels have edge cases
- The user said "quality doesn't matter how" and "NO COMPROMISE"
- Our own research confirmed Temporal is "technically capable of everything we need"
- The 237MB argument is developer convenience, not quality
- `temporal dev server` runs locally with SQLite, no Docker needed
- Temporal's workflow history IS the audit trail — for free
- Temporal Web UI gives workflow visibility with zero custom code

**AGAINST Temporal (C's position):**

- 237MB of dependencies for a CLI tool
- External server process must be running before the CLI works
- Webpack bundling required (workflow code runs in sandboxed V8 — no fs, no Date.now(), no child_process)
- Our pipeline is 8 sequential steps — not a distributed system
- Custom code is ~250 lines with full retry, timeout, resume
- Windows behavior is UNTESTED
- Learning curve for the Temporal TS SDK
- Every tutorial/example in our stack would need to explain the Temporal model

**My honest assessment:**

My rejection of Temporal was based on developer convenience (simpler, faster, fewer deps), not quality. If the criterion is QUALITY and the user explicitly said "no compromise on choosing something fast that requires redo" — Temporal is the higher-quality choice for workflow durability. A custom 250-line state machine WILL have bugs in edge cases that Temporal has already solved across millions of production workflows.

**BUT:** Temporal on Windows is unvalidated. If the Phase 0 spike fails, the entire architecture collapses. This is why A's spike phase is critical.

**Verdict on Temporal:** A is right. Temporal is the quality choice. BUT the Phase 0 spike is the gating decision. If it fails on Windows, fall back to C's custom approach.

---

### 4. The LangGraph Question

**A says:** Bounded subgraph only (tournament/debate/arbiter). NOT the core.
**B says:** Non-negotiable for fan-out.
**C says:** Rejected entirely. Promise.all is 3 lines.

**Honest assessment:** For simple fan-out (3 agents build in parallel), Promise.all suffices. For structured debate (two reviewers disagree, arbiter mediates with turn-taking and evidence comparison), LangGraph's graph model provides real value. A's position (bounded subgraph, not core) is the correct middle ground.

**Verdict:** A is right. LangGraph as optional bounded subgraph for tournament/debate. Not the core.

---

### 5. Document B (Gemini synthesis) — Critical Problems

Document B is the weakest by a significant margin. A senior reviewer would flag these immediately:

| Problem                   | Evidence                                                                                                                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sycophantic language**  | "flawless production code," "perfectly aligned," "ultimate, compromise-free," "the system selects the best"                                                                                              |
| **No risk analysis**      | Zero gaps identified. Zero failure modes. Zero unknowns acknowledged.                                                                                                                                    |
| **Technically imprecise** | "mathematically blacklists .env files" — file filtering isn't math. "Forces the Codex neural network to activate its deepest software engineering weights" — that's not how vocabulary activation works. |
| **Unjustified GUI**       | Proposes Next.js + WebSocket GUI with zero justification for why GUI is needed before the pipeline works                                                                                                 |
| **Shallow**               | 68 lines vs 1,107 (A) and 950 (C). Barely scratches the surface.                                                                                                                                         |
| **No build order**        | "I am ready to close the planning phase and begin project execution" — with no phased delivery, no spike, no done criteria                                                                               |
| **No self-criticism**     | Claims 96% confidence without acknowledging that Temporal on Windows is untested                                                                                                                         |

**Verdict:** Document B should be DROPPED. It adds nothing that A doesn't cover better. The GUI proposal is premature (build the pipeline before the dashboard). The language is the exact sycophancy the user identified as the core problem.

---

### 6. What Each Document Uniquely Contributes

| Contribution                                                  | Source | Why It's Valuable                                         |
| ------------------------------------------------------------- | ------ | --------------------------------------------------------- |
| Intent Compiler with IntentBrief schema                       | A      | Structured vibe→senior translation with typed output      |
| Prompt Quality Lab (Promptfoo)                                | A      | MEASURABLE prompt evaluation, not intuition               |
| 16 gap areas (prompt injection, secrets, version drift, etc.) | A      | Self-aware about remaining risks                          |
| 12 critical corrections ("do not" rules)                      | A      | Prevents specific documented failures                     |
| Three-layer truth model (Temporal + SQLite + .council)        | A      | Each layer serves a different purpose                     |
| ts.transpileDeclaration() research                            | C      | 6-20x token compression, verified from TS compiler source |
| Domain Pattern Library (OWASP ASVS, prodlint)                 | C      | Machine-readable checklists per feature type              |
| Scale-tier filtering (MVP/production/enterprise)              | C      | Calibrates requirements to project size                   |
| Feature-type YAML schema with vocabulary                      | C      | Concrete implementation of vocabulary activation          |
| execa v9 Windows verification                                 | C      | Proven to work on Windows (tested in session)             |
| 6-layer attention-curve prompt assembly                       | C      | Exploits Lost-in-the-Middle (from Agent CI)               |
| Project structure (~30 files)                                 | C      | Concrete implementation plan                              |

---

## 7. The Final Recommendation

### Adopt Document A as the canonical architecture WITH these modifications:

**Keep from A:**

1. Temporal as the spine (pending Phase 0 spike on Windows)
2. SQLite append-only evidence ledger
3. Intent Compiler with IntentBrief schema
4. Prompt Quality Lab with Promptfoo
5. LangGraph as bounded subgraph for tournament/debate
6. Three-layer truth model
7. 12 critical corrections
8. 16 gap areas as tracked risks
9. Phase 0 spike before committing
10. Policy-as-code gates with P0 blocking

**Merge from C:**

1. ts.transpileDeclaration() as the compression mechanism (A mentions .d.ts but doesn't have the specific implementation)
2. Domain Pattern Library with OWASP ASVS + prodlint mappings (feeds A's Intent Compiler with content)
3. Feature-type YAML schema with vocabulary activation + scale tiers
4. execa v9 for subprocess management (A agrees on execa)
5. 6-layer attention-curve prompt assembly
6. contracts.ts + Build Manifest with .dts field
7. Slop detection gate (grep for TODO/FIXME/placeholder/as any)
8. Concrete project structure

**Drop from B:**

- Everything. B is subsumed by A and adds only sycophantic language and an unjustified GUI.

**The fallback:**
If Phase 0 spike shows Temporal doesn't work on Windows → fall back to C's custom pipeline with A's Intent Compiler + Prompt Quality Lab + 16 gap areas integrated. The architecture stays the same; only the execution engine changes.

---

## 8. Why This Combination Is Better Than Any Single Document

**Better than A alone:** A doesn't have ts.transpileDeclaration(), Domain Pattern Library (OWASP ASVS mappings), scale-tier filtering, feature-type YAMLs, or the concrete 30-file project structure.

**Better than B alone:** B is shallow, sycophantic, and adds an unjustified GUI. Everything useful in B exists in A at 10x the depth.

**Better than C alone:** C lacks the Intent Compiler's structured schema, the Prompt Quality Lab (evaluation infrastructure), the 16 gap areas, the three-layer truth model, and the engineering discipline of "prompt templates are production logic that must pass evals."

**Better than all three combined without judgment:** Combining blindly would include B's GUI (premature), A+C's conflicting Temporal decisions (confusing), and duplicated coverage. The value is in the SELECTION: A's architecture + C's concrete innovations + B dropped entirely.

---

## 9. Honest Confidence Assessment

| Dimension                 | Confidence | Reasoning                                                                                                                                    |
| ------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture direction    | GREEN 95%  | A's architecture is the strongest available. Temporal + SQLite + Intent Compiler + Context Compiler addresses every documented failure mode. |
| Temporal on Windows       | YELLOW 70% | Untested. Phase 0 spike is the gating decision. Fallback plan exists (C's custom pipeline).                                                  |
| Intent Compiler value     | GREEN 93%  | Directly addresses the user's core skill-gap problem. Backed by aider conventions A/B test evidence and vendor best practices.               |
| Prompt Quality Lab        | GREEN 90%  | Promptfoo is TypeScript-native, CLI-first, multi-provider. Direct fit.                                                                       |
| Implementation timeline   | YELLOW 75% | Temporal + LangGraph + SQLite + Intent Compiler + Context Compiler is significant scope. 3-4 weeks realistic, not 1-2.                       |
| ts.transpileDeclaration() | GREEN 98%  | Verified from TypeScript 5.5 compiler source code. Known to work.                                                                            |
| Domain Pattern Library    | GREEN 88%  | OWASP ASVS and prodlint are real, machine-readable sources. Scale-tier calibration needs iteration.                                          |

---

## 10. Next Steps

1. **Phase 0 spike** — Test Temporal on Windows 11 with all 3 CLIs
2. **If spike passes** → Write the merged spec (A's architecture + C's innovations)
3. **If spike fails** → Write the fallback spec (C's pipeline + A's Intent Compiler + Prompt Quality Lab)
4. **Either way** → Plan → Build → The fitness app validates it
