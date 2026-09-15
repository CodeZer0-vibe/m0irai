# DeepSeek V4 Applications — Cross-Document Senior Review

**Date:** 2026-05-03
**Reviewer:** zer0 (Claude Opus)
**Documents reviewed:** 4 independent analyses from 3 different models
**Method:** Each document read in full, ideas extracted, verified against source evidence, ranked by value, conflicts resolved

---

## 1. The 4 Documents Ranked

| Rank  | Document                                 | Source                                                      | Lines | Verdict                                                                                                                                                                            |
| ----- | ---------------------------------------- | ----------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | `2026-05-03-deepseek-v4-applications.md` | Multi-model council (Claude+Codex+Gemini voted per finding) | 838   | **BEST.** 14 extensions, each with council vote. Highest-value ideas (rubric review, blind retry, lookahead, negative capability ledger).                                          |
| **2** | `deep-dive-deepseek-v4-agent-lessons.md` | Codex solo                                                  | 435   | **MOST DISCIPLINED.** Best source verification. Transcript claim audit. Unique ideas (stability monitor, sandbox ladder, working state). Explicitly cautions against overreacting. |
| **3** | `deepseek-v4-applied-to-zer0.md`         | Claude solo (mine)                                          | 450   | **SOLID but narrower.** Strong engineering argument, honest about limits (rejected mHC analogy, deferred learned compression). Missed ideas others found.                          |
| **4** | `deepseek_v4_analysis.md`                | Gemini solo                                                 | 56    | **WEAKEST but has ONE unique idea.** Sycophantic language ("invincible", "bleeding edge"). Shallow. But Context Prefetching is genuinely novel and no other doc found it.          |

---

## 2. Honesty Check: What's Real vs What Might Be Hallucinated

| Claim                                                       | Source                                          | Status                                                                                                       |
| ----------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| DeepSeek V4 exists with CSA/HCA architecture                | All 4 docs, HuggingFace model card, source code | **VERIFIED**                                                                                                 |
| Three-tier attention (window + CSA + HCA)                   | Source code `model.py`, `config.json`           | **VERIFIED (highest trust)**                                                                                 |
| Lightning Indexer dual-signal scoring                       | Source code `model.py`                          | **VERIFIED (highest trust)**                                                                                 |
| 12.7% KV cache (vs ~10% claimed)                            | Calculated from config values                   | **VERIFIED**                                                                                                 |
| MRCR 1M: 83.5, SWE-bench: 80.6                              | Model card                                      | **CONFIRMED (self-reported)**                                                                                |
| Anticipatory routing during training                        | YouTube transcript only                         | **UNVERIFIED — not in source code**                                                                          |
| "DualPath: Accelerating Agent Inference" (arXiv:2602.21548) | Gemini doc only                                 | **SUSPECT — may be hallucinated. No other doc references it. arXiv ID format valid but content unverified.** |
| Putnam 2025: 120/120                                        | YouTube transcript, Codex marked UNVERIFIED     | **UNVERIFIED — not confirmed in model card by Codex's audit**                                                |
| "DeepSeek admits alchemy"                                   | Council doc, cites 36kr source                  | **PLAUSIBLE — source exists but quote not independently verified**                                           |
| SwiGLU clamping 6.7% overhead                               | YouTube transcript                              | **UNVERIFIED — not in source code per our extraction**                                                       |
| GRPO (Group Relative Policy Optimization)                   | Council doc, cites MarkTechPost summary         | **PLAUSIBLE — multiple secondary sources describe it**                                                       |
| Think Max vs Think High modes                               | Council doc, verified via DeepSeek API docs     | **VERIFIED — DeepSeek API docs confirm thinking modes**                                                      |

**Critical finding:** The Gemini doc references a "DualPath" paper that NO other document mentions. Given Gemini's known pattern of hallucinating academic references, treat the prefetching idea as a GOOD ENGINEERING IDEA that stands on its own merit, but do NOT cite the paper as authority.

---

## 3. Ideas Extracted from ALL 4 Documents — Ranked by Value

### Tier 1: ADOPT IMMEDIATELY (zero/minimal cost, high value)

| #   | Idea                                     | Source        | Why It's Valuable                                                                                                                                                                                                   | Cost                            |
| --- | ---------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 1   | **Structured YAML Rubric Review**        | Council (§7)  | Transforms review from subjective prose to queryable MET/NOT_MET/UNVERIFIABLE per requirement. Feeds SQLite ledger. Enables: "which requirements are consistently NOT_MET across runs?" Makes AI review MEASURABLE. | Template change + output parser |
| 2   | **Multi-Token Lookahead in BUILD BRIEF** | Council (§12) | Show next 2 tasks in build brief → agent designs forward-compatible interfaces. Prevents: "this works but makes the NEXT task impossible."                                                                          | 3 lines in Layer 3 template     |
| 3   | **Strengthened Layer 6 Endcap**          | Council (§6)  | Explicit thoroughness demand at highest-attention position. DeepSeek's Think Max DOUBLED quality on Putnam (partial → perfect) with same weights, different instruction.                                            | Template text change            |
| 4   | **Simultaneous three-tier context**      | Claude (§3.1) | Every pack gets L0 + L1(top-K) + L3(all files) simultaneously, not as sequential fallback. Validated by DeepSeek using all three attention modes in every layer.                                                    | Context Compiler design         |
| 5   | **L3 "include everything" as mandatory** | Claude (§3.3) | All file names + exports in every pack. ~5-10K tokens for 500 files. DeepSeek's HCA attends to ALL 7,800 blocks at 128x because it's cheap enough. Same principle.                                                  | Context Compiler design         |

### Tier 2: ADOPT IN PHASE 2 (enforcement layer)

| #   | Idea                               | Source        | Why It's Valuable                                                                                                                                                                                                                                | Cost                                           |
| --- | ---------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| 6   | **Blind Retry Review Protocol**    | Council (§3)  | Fix-loop reviewer NEVER sees prior findings. Fresh hostile review every iteration. Prevents temporal sycophancy (anchoring on previous flagged issues, rubber-stamping "fixes"). Separate mechanical Fix Verifier checks prior P0s are resolved. | Exclude one section from fix-loop Context Pack |
| 7   | **Dual-signal scoring**            | Claude (§3.2) | Score = relevance(task-specific) × importance(global). Neither alone sufficient. Validated by DeepSeek Lightning Indexer + established in IR (TF-IDF is dual-signal).                                                                            | Scoring interface in Context Compiler          |
| 8   | **Aggressive Mechanical Clamping** | Council (§5)  | Max function length, max file length, max params, zero console.log. Hard constraints that FORBID quality explosion, like DeepSeek's SwiGLU clamping. 1-second grep checks prevent 5-minute review cycles.                                        | Add checks to BuildGate                        |
| 9   | **Finding-Inflation Clamp**        | Council (§5)  | >15 findings from one review = 25% confidence discount. Prevents models from flooding with noise to appear thorough.                                                                                                                             | Discount logic in ReviewGate                   |
| 10  | **Context Prefetching**            | Gemini (§1)   | While agent builds task N, pre-compile context for task N+1 in background. Zero idle time between tasks. Like DeepSeek's Storage-to-Prefill overlap.                                                                                             | Background context compilation                 |

### Tier 3: ADOPT IN PHASE 3+ (learning layer)

| #   | Idea                            | Source            | Why It's Valuable                                                                                                                                                                                                     | Cost                                          |
| --- | ------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 11  | **Stability Monitor**           | Codex (lesson 10) | Detect: repeated failures, same P0 recurring, growing context with no progress, forbidden edits, dependency churn. Trigger: stop retry, escalate, switch model, ask human. More valuable than increasing retry count. | Monitor logic + escalation rules              |
| 12  | **Enrichment Removal Protocol** | Council (§11)     | Every enrichment gets a flag in dispatch records. After 20+ dispatches, measure: does this enrichment actually improve acceptance rate? If not → flag for removal. Empirical, not theoretical.                        | enrichment_flags column + measurement queries |
| 13  | **Negative Capability Ledger**  | Council (§14)     | Track which agent consistently FAILS at what (Codex misses async error handling, Claude over-abstracts). Route AWAY from known weaknesses, not just toward historical winners.                                        | New SQLite table + routing exclusion          |
| 14  | **AgentWorkingState**           | Codex (lesson 5)  | Require structured public artifacts (hypothesis, decisions, files inspected, blockers) instead of hidden chain-of-thought. Auditable continuity without privacy/determinism risks.                                    | Structured output schema                      |
| 15  | **Constraint Curriculum**       | Council (§15)     | Strict constraints by default. Evidence-based relaxation only. Constraints are TIGHT because DeepSeek proved constrained systems produce better output (90% cache reduction → BETTER performance).                    | Configurable severity + waiver mechanism      |

### Tier 4: DEFER (Phase 5+ or future research)

| #   | Idea                                    | Source           | Why Defer                                                                              |
| --- | --------------------------------------- | ---------------- | -------------------------------------------------------------------------------------- |
| 16  | GRPO learned routing                    | Council (§4)     | Need 20+ tournament results per feature type. No data before Phase 5.                  |
| 17  | Trajectory logging                      | Council (§10)    | Only valuable with MCP-enabled dispatches. Phase 5+.                                   |
| 18  | Sandbox ladder                          | Codex (lesson 7) | Process + worktree is sufficient for v1. Container/VM for high-risk later.             |
| 19  | Temperature routing                     | Council (§13)    | Only 1 of 3 CLIs exposes temperature flag. Prompt-level instruction is the workaround. |
| 20  | Tool/Artifact envelope (XML boundaries) | Codex (lesson 6) | Good security hardening but not blocking quality. Phase 4+ security pass.              |

### REJECTED

| Idea                                   | Source | Why Rejected                                                                                           |
| -------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------ |
| mHC analogy for pipeline state         | Claude | Stretch. mHC solves gradient explosion. We don't have gradient explosion.                              |
| DualPath paper as authoritative source | Gemini | Likely hallucinated. Prefetching idea is good on its own merit without the paper.                      |
| "Invincible" / "bleeding edge" framing | Gemini | Sycophantic language. Not engineering analysis.                                                        |
| Learned compression (AI summarization) | Claude | Too expensive per-file per-task. Mechanical ts.transpileDeclaration is faster, cheaper, deterministic. |

---

## 4. What No Document Found (Gaps Across All 4)

| Gap                                                          | Why It Matters                                                                                                                                                                                         | Status                                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| **Empirical test of enrichment effectiveness**               | All 4 docs ASSUME vocabulary activation + rubric injection improve output. None tests it. The aider A/B test is the closest evidence but it's for 2-line conventions, not 42 injected requirements.    | Need to test: raw prompt vs enriched prompt on same task, compare output quality. |
| **Cost model per pipeline run**                              | Agent CI estimated $2-6. Council doc didn't model cost. No doc accounts for Intent Compiler + 3 research agents + spec + architecture + plan + 20 build tasks + 20 reviews + fix loops.                | Could be $50-100 for a real app. User needs to know.                              |
| **Compression-quality tradeoff DATA**                        | All docs cite DeepSeek's 83.5 MRCR as evidence for aggressive compression. But that's an AGGREGATE number, not per-tier. We don't know if L2 (export list) loses 2% or 20%.                            | PDF extraction needed, or run our own test.                                       |
| **How agents actually respond to 40+ injected requirements** | Council and Claude docs inject OWASP ASVS + prodlint requirements. But do agents produce code that addresses requirement #37 when it's buried in a list of 42? Lost-in-the-Middle says they might not. | Need to test: do agents implement ALL requirements or just the first/last few?    |
| **The interaction between prefetching and crash recovery**   | Gemini proposes prefetching context for task N+1 while N runs. But if N fails and needs retry, the prefetched context for N+1 is now invalid (Build Manifest changed).                                 | Need invalidation logic for prefetched context.                                   |

---

## 5. What Codex Got Right That Others Missed

Codex's document (Document 3) deserves special recognition because it's the MOST DISCIPLINED:

1. **Starts with skepticism.** "The video is useful, but not as authority." Every other doc treated the transcript as ground truth.

2. **Transcript claim audit.** Table verifying each claim against primary sources. Found: "Beats Opus on average" is OVERBROAD. "Perfect Putnam" is UNVERIFIED. "Team is 40x smaller" is UNVERIFIED. No other doc did this.

3. **Rejects "deepest weights" language.** Explicitly says: "Not engineering language. Use measurable context-quality and gate-quality claims." This is the correct response to marketing-speak.

4. **"Do not add DeepSeek as a fourth worker."** Clear boundary: extract PRINCIPLES, don't change the worker model. No other doc drew this line as explicitly.

5. **Pre-mortem table.** Lists failure modes of ACTING on this research (overreacting to DeepSeek, using 1M context as excuse for lazy selection, storing hidden reasoning, scope explosion from sandbox work). This is senior behavior — anticipating how research findings get misapplied.

6. **Hot/Warm/Cold taxonomy.** Cleaner framing than L0/L1/L2/L3:
   - **Hot:** exact current task files, current diff, failing test output, acceptance criteria — NEVER compressed
   - **Warm:** .d.ts contracts, symbol graph, recent findings, selected snippets — moderately compressed
   - **Cold:** run summaries, architecture decisions, research synthesis, older manifests — heavily compressed

This taxonomy should REPLACE our L0/L1/L2/L3 naming in the spec. It's more intuitive and maps directly to DeepSeek's sliding window / CSA / HCA.

---

## 6. What the Council Doc Got Right That Others Missed

The Council doc (Document 4) has the most innovative ideas because it's the only one that ran a MULTI-MODEL VOTE on each finding:

1. **Structured YAML Rubric Review (§7)** — The single highest-value extension across all 4 documents. MET/NOT_MET/UNVERIFIABLE per requirement turns AI review into a queryable dataset. No other doc proposed this.

2. **Blind Retry Review (§3)** — The fix-loop reviewer never sees prior findings. Prevents temporal sycophancy. The TWO-TRACK approach (fresh blind review + mechanical fix verifier) is elegant. No other doc proposed this.

3. **Multi-Token Lookahead (§12)** — Show next 2 dependent tasks in the build brief. Costs 2-3 lines in the template. Prevents agents from designing interfaces that are correct NOW but incompatible with the NEXT task. No other doc proposed this.

4. **Enrichment Removal Protocol (§11)** — The only doc that asks: "what if our fancy additions DON'T actually help?" Every enrichment gets a measurable flag. After enough data, measure. Remove what doesn't improve results. This is the "alchemy admission" applied to our own system.

5. **Finding-Inflation Clamp (§5)** — >15 findings from one review = confidence discount. Prevents a model from appearing thorough by shotgunning low-quality findings. Simple, mechanical, catches a real failure mode.

---

## 7. The Honest Senior Assessment

### What I got wrong in my analysis (Document 3):

- Too focused on the 3 ADOPTs from my own document and missed the higher-value ideas from the Council and Codex docs
- The mHC analogy was a stretch and I should have caught it earlier
- I didn't propose rubric review, blind retry, lookahead, stability monitor, or prefetching — all of which are more impactful than my "dual-signal scoring" proposal

### What every document got wrong:

- **All 4 assume DeepSeek's techniques apply to file-level orchestration without empirical validation.** The analogies are sound but they're ANALOGIES. Until we measure "does rubric review produce fewer escapes than prose review?" and "does vocabulary activation produce more correct code than raw prompts?" — they're hypotheses.
- **None produced a cost model.** We're about to build a system that makes 50-100+ API calls per pipeline run across 3 premium CLI subscriptions, and nobody estimated the dollar cost.

### The corrective principle (from Codex):

> "The best senior conclusion: agent quality is mostly a context, memory, tool, sandbox, and verification problem. Model strength matters, but system design decides whether that strength survives a real build."

That's the right frame. DeepSeek confirms it. The system design IS the product. Now build it.

---

## 8. Final Ranked Changes to SPEC-CANONICAL

**Integrate these in order of value. Each is independently valuable — don't gate later items on earlier ones.**

| Priority | Change                                                   | Source          | Phase |
| -------- | -------------------------------------------------------- | --------------- | ----- |
| 1        | Structured YAML Rubric Review (MET/NOT_MET/UNVERIFIABLE) | Council §7      | 1     |
| 2        | Multi-Token Lookahead (next 2 tasks in build brief)      | Council §12     | 1     |
| 3        | Strengthened Layer 6 Endcap (Think Max equivalent)       | Council §6      | 1     |
| 4        | Hot/Warm/Cold context taxonomy (replace L0-L3 naming)    | Codex lesson 1  | 1     |
| 5        | Simultaneous three-tier (all tiers in every pack)        | Claude §3.1     | 1     |
| 6        | Blind Retry Review + mechanical Fix Verifier             | Council §3      | 2     |
| 7        | Dual-signal scoring interface (relevance × importance)   | Claude §3.2     | 2     |
| 8        | Context Prefetching (compile N+1 while N runs)           | Gemini §1       | 2     |
| 9        | Aggressive Mechanical Clamping                           | Council §5      | 2     |
| 10       | Stability Monitor                                        | Codex lesson 10 | 3     |
| 11       | Enrichment Removal Protocol                              | Council §11     | 3     |
| 12       | Negative Capability Ledger                               | Council §14     | 3     |
| 13       | AgentWorkingState artifacts                              | Codex lesson 5  | 3     |

Do NOT add all 13 to the spec at once. Integrate 1-5 (Phase 1, zero cost). Build. Test. Then integrate 6-9 (Phase 2). Then 10-13 (Phase 3). Each addition is a HYPOTHESIS until measured.
