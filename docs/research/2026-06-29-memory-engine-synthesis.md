# zer0 Memory Engine — Research Synthesis (2026-06-29)

**Method.** Five independent streams, three models, no cross-contamination: **codex** + **gemini** (independent architecture designs), **claude ×3** (grounding = current code at file:line · prior-art = mem0/Letta/Zep/Anthropic/Cursor/Cline/Windsurf/Aider teardown · hard-problems = failure modes + user demand, sourced to arXiv/TACL/Anthropic/GitHub).
Raw reports: `docs/research/raw/2026-06-29-memory-*.md`. This doc is the decision-oriented synthesis that feeds the memory PRD.

---

## 0. The reality check (grounding — what zer0 has TODAY, file:line verified)

The current "shared brain" is real but **thin**, and one stale assumption is corrected:

- **Storage:** `better-sqlite3` → `.zer0/evidence.db` (CWD-relative), WAL + `busy_timeout` + FK, schema v12. SHA256 blob store at `.zer0/blobs/`. **sqlite-vec was NEVER built** (MEMORY.md claimed it; the code has no vector table). _(Stale-memory correction.)_
- **The ledger already exists in embryo:** `chat_messages`, `chat_working_sets` (the debate/shared-context table, with `peer_refs` cross-agent links + `context_blob_hash` snapshots), `active_debates` (per-session CAS mutex). This is an append-oriented evidence spine — and the DB is literally named **`evidence.db`**, which is exactly the architecture all five streams converged on.
- **What's missing / broken (the grounded risk list):**
  - **RISK-1 (BLOCK):** source-of-truth split — `loadSession` reads `transcript.json` from disk, not SQLite, despite a code comment claiming "SQLite holds the truth." Best-effort DB writes can silently diverge.
  - **RISK-2 (BLOCK — the operator's exact worry):** **no project isolation at the DB layer.** `chat_sessions.repo_root` is stored but **never used as a `WHERE` filter** anywhere. Isolation today is pure convention (one DB per CWD). Share a `.zer0/` (monorepo, symlink, wrong CWD) → project A contaminates project B's recall. **Currently unguarded in code.**
  - **RISK-3 (BLOCK):** **no summarizer.** `summary_text` is always `""`; `TRANSCRIPT_WINDOW=20` is a hard ceiling. Sessions past 20 turns **silently lose all earlier context.**
  - **RISK-4 (gap):** **chat turns have zero cross-run memory** — `compileMemory` is called with `relevantPaths:[]`, so it returns nothing; semantic recall doesn't exist for chat (FTS5 exists but is BUILD-pipeline-only).
  - **RISK-5 (operability):** `listSessions` is an O(N) filesystem scan (loads every `transcript.json` on launch) instead of a DB query — a `/resume` latency cliff at scale.

**Takeaway:** the converged target architecture is a **superset** of what exists. The spine (evidence DB + blobs + per-session lease) is there; the gaps (project-scope enforcement, consolidation/summarizer, semantic recall, ledger-as-canonical) map 1:1 onto the design below. This is an **extension, not a rewrite.**

---

## 1. CONVERGED architecture (where independent streams collided → high confidence)

All five describe the same shape. Name: **Project-Scoped Evidence Ledger with Curated, Provenance-Bearing Promotion**, on local SQLite.

1. **Spine = append-only evidence ledger; it is the canonical truth.** Every turn / agent output / tool result / decision is appended immutably. Summaries and indexes are **derived projections** over it (fixes RISK-1; answers the #1 user pain — losing the "why" on compaction — by never discarding the source). Agents **never overwrite each other** → kills concurrency races (codex, gemini, prior-art's mem0-ADD-only reversal, hard-problems' compaction-loss).

2. **Two-phase write: cheap append now, async consolidation later.**
   - _Phase A (hot path):_ append raw evidence synchronously, cheap, never blocks a turn (already best-effort today).
   - _Phase B (off critical path):_ a background **curator** consolidates the session log into durable, de-duplicated memory — run through an **idle zer0 agent** (subscription, NOT a metered API; honors the no-keys constraint). This is **Letta's "sleep-time compute"** pattern, and it sidesteps mem0's #1 production failure (sync writes blocking responses). Fixes RISK-3 + RISK-4.

3. **Promotion is evidence-gated** (this is the anti-poisoning core). Raw session memory is **never reused across sessions by default**; only _promoted_ claims are. Promote only: operator-pinned, code/test/command-evidenced, or cross-session-corroborated facts. Agent-only summaries enter `candidate`/`quarantined`. _"Only promote consolidated, provenance-bearing, non-contradicted facts, or promotion amplifies poisoning"_ (hard-problems). codex: _"the moat is trust routing, not vector search."_

4. **Memory as provenance-bearing claims, not prose.** Every durable item carries: scope, **source/provenance**, confidence, `state` (raw|candidate|active|superseded|expired|forgotten), and **bi-temporal validity** (Graphiti: `t_valid/t_invalid` + `t_created/t_expired`). On conflict: **invalidate, don't delete** — the principled cure for "temporal drift / confidently-wrong-after-change." Modeled as **ordinary SQLite columns/edge tables**, not a graph engine.

5. **Scope ladder: global → shared-group → project → session → turn → agent.** The **shared-group** tier is user-demanded (claude-code #39195 calls today's global-or-duplicate a _"false choice"_) — memory shared across a _chosen set_ of projects (e.g. all my work repos), not just global-or-single.

6. **Isolation: physical-first + mandatory pre-retrieval filter.** _"Filter before retrieval, never after"_ — the cardinal rule behind the _"up to 95% of benign queries triggered cross-tenant leakage"_ finding. Retrieval must start from a required **scope envelope**; the engine can't ask "find useful memory," only "find memory allowed for THIS project/session." Every row carries `project_id` + `agent_id` + `session_id` (prevents mem0's "scope leakage / who-said-what" failure).

7. **Retrieval: hybrid, structured-first, NO LLM on the read path.** Order: hard scope filter → structured/exact (path/symbol/error/**FTS5**) → **sqlite-vec** semantic LAST (never a naked vector hit) → rerank (scope strength · evidence quality · recency · validity · operator-pinned) → **fixed prompt budget**, highest-salience placed at **head/tail** (lost-in-the-middle). Every injected memory tagged with source/age/confidence. (Zep's sub-300ms no-LLM-at-read recipe + mem0 multi-signal.)

8. **Shared-agent brain = Letta "shared memory blocks."** One `project` block + per-agent role blocks, _"update once, visible everywhere,"_ `read_only` where an agent must not edit; all agents in a debate round read the **same memory snapshot**. (zer0's `chat_working_sets`/`peer_refs` already gestures at this.)

9. **Memory is UNTRUSTED input + forgetting is co-designed.** Render memory with provenance, **never as instruction** (prompt-injection defense); validate path-traversal on the file layer; quarantine cross-agent writes (3 semi-trusted CLIs writing one store). Forgetting: TTL/decay for branch/task facts, supersession, **tombstones not hard-delete**, idle-time pruning.

**Substrate verdict (unanimous):** keep **ONE local SQLite file** doing all three jobs — structured event ledger (spine) + sqlite-vec/FTS5 (semantic + keyword recall) + bi-temporal edge tables (relationships + invalidation). **Add sqlite-vec** (pin the version — it's alpha/brute-force KNN, but fine at personal scale of thousands-not-millions; keep an FTS5 fallback). **Reject** Postgres/pgvector, Neo4j/graph engines, and any cloud memory SaaS (forfeits the local-first moat). Adopt graph/temporal _models_, reject graph/Postgres _engines_.

---

## 2. The genuine DECISIONS

- **D1 — Physical per-project DBs (codex) vs single DB + enforced `project_id` filter (gemini).** codex: a `.zer0/memory.db` per repo + a global registry DB; _"isolation as the default physics of the system, not a hope encoded in `WHERE project_id = ?`."_ gemini: one DB, hard `WHERE project_id = ?`. **Recommendation: physical per-project** — strongest guarantee for the operator's "never cross projects," and a query bug can't leak across a DB-handle boundary. (Global prefs + a project registry live in a separate `%LOCALAPPDATA%/zer0/global.db`.) _Engineering call — leaning codex._
- **D2 — Auto memory vs visible/confirmable (PRODUCT — operator steers).** Cursor shipped _silent auto-generated_ memory and **pulled it** (v2.1.x); users distrusted opaque memory and went back to hand-written rules. **Recommendation:** consolidation _proposes_; memory is **inspectable + editable**, and high-stakes facts are **operator-confirmable** (pin/reject). Precision + visibility over volume.
- **D3 — v1 ambition / MVP cut (FUZZY — operator steers scope).** The full design is meaty. Proposed **MVP** = fix the 3 BLOCKs + add chat recall: (a) **enforce project scope** (physical per-project DB + pre-filter) → RISK-2; (b) **idle-agent summarizer/consolidation** → RISK-3/4; (c) **ledger canonical** (DB is truth, transcript derived) → RISK-1; (d) **chat semantic recall** (wire sqlite-vec + FTS5 into chat prompts). **Phase 2** = provenance-claim model + bi-temporal invalidation + shared-group tier + Letta-style shared blocks + confirmable-memory UX. Design the schema for the full thing; build the MVP first.

---

## 3. What to COPY (named, ranked) / What to AVOID

**COPY:** Anthropic "assume interruption" multi-session protocol (view-memory-before-acting, progress log, "complete only after verification") · Letta shared memory blocks (3-agent brain) · Letta sleep-time consolidation (idle agents) · Graphiti bi-temporal invalidate-don't-delete (as SQLite columns) · mem0 ADD + read-time conflict resolution + its failure-mode checklist · hybrid retrieval no-LLM-at-read · Windsurf workspace-scoping + Cline read-at-start · AGENTS.md SSOT + symlink (zer0 drives 3 CLIs with different filenames) · Aider graph-ranked relevance to a token budget · context-editing/compaction as the _forgetting_ half.

**AVOID:** heavyweight DB engines locally (Postgres/Neo4j/FalkorDB) · synchronous agentic UPDATE/DELETE on the user's turn · opaque auto-memory with no visibility (the Cursor failure) · destructive deletes/overwrite-in-place · a shared pool with no actor/project attribution · trusting agent self-edits blindly + ignoring path-traversal · pure prompt-file memory as the _only_ mechanism (doesn't scale) · betting on sqlite-vec's missing ANN · LLM-on-the-read-path · cloud memory SaaS.

---

## 4. Next steps

Fold §0–§3 into a **memory PRD** (code-zero-brainstorm → 9-section spec, invariants-first) → L-1 skeptic → write-plan → codex review → build (MVP cut first). The terminal-redesign track and this memory track are separate builds feeding the same product.

## Key sources

sqlite.org (FTS5, WAL, isolation); alexgarcia.xyz (sqlite-vec metadata/alpha); mem0 State-of-2026 + GitHub; Letta memory-blocks + sleep-time docs; Zep/Graphiti arXiv 2501.13956 + GitHub; Anthropic memory-tool + context-management docs; Cursor/Cline/Windsurf/Aider docs; claude-code issues #38536 (team memory), #39195 (shared-group tier); Breunig context-failure series; Liu "lost in the middle" (TACL 2024); AGENTS.md (Linux Foundation). Full URLs + quotes in the raw reports.
