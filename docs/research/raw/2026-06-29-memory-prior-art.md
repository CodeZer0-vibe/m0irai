---
scope: cross-cutting
lastValidated: 2026-06-29
---

# Memory systems for AI coding agents — prior-art teardown for zer0 chat

**Scope.** Inform the memory engine of _zer0 chat_: a **local-first Windows terminal cockpit** running 3 CLI agents (Claude / Codex / Gemini) as a team, already on **SQLite + sqlite-vec**, **multi-session** and **multi-project**. Bias: what transfers to a local, on-device, multi-agent, multi-project cockpit. NOT a cloud SaaS — local-first is the moat. Licensing is called out wherever it gates local embedding.

**Method.** Web research, June 2026. Every load-bearing claim carries a source URL + short quote. `INFERENCE` marks my reasoning beyond the sources. Two axes structure the whole space and recur below:

- **Retrieval memory (RAG / passive)** — embed-and-search at _read_ time. The store is dumb; intelligence is in the query. Examples: vector search, repo map.
- **Agentic memory (self-editing / active)** — the model curates memory via tool calls at _write_ time (ADD / UPDATE / DELETE, block edits). The store holds model judgment; intelligence is in the write.
- Orthogonal **substrate** axis: **vector** vs **knowledge-graph** vs **plain structured/event-sourced** rows. A system picks a point in (retrieval↔agentic) × (vector↔graph↔structured) space. zer0 is currently vector + (lightly) agentic.

---

## Per-system teardown

### 1. mem0 — extraction + hybrid vector/graph layer (Apache 2.0)

**Architecture (original 2025 paper).** Two-phase pipeline. _Extraction:_ an LLM reads a rolling summary of long-term history + the last _M_ turns and emits "candidate facts." _Update:_ each candidate is vector-compared to existing memories, then an LLM decides **ADD / UPDATE / DELETE / NOOP** per fact to keep the store consistent and non-redundant. "An LLM determines whether to ADD, UPDATE, DELETE, or NOOP (no change) for each fact, ensuring consistency and avoiding redundancy" ([mem0 search synthesis](https://memo.d.foundation/breakdown/mem0)). The graph variant **Mem0g** is "a directed labeled graph, where nodes represent entities ... and edges represent relationships as triplets (source, relation, destination)."

**Architecture (April 2026 rewrite — note the reversal).** mem0 _dropped_ the per-fact UPDATE/DELETE LLM step in favor of **single-pass ADD-only extraction** ("one LLM call, no UPDATE/DELETE"), **multi-signal retrieval** ("semantic, BM25 keyword, and entity matching"), and explicit **temporal reasoning** ("time-aware retrieval that ranks the right dated instance") ([mem0 GitHub](https://github.com/mem0ai/mem0); [State of AI Agent Memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026)). They also moved **off external graph stores to built-in entity linking** — "eliminating queryable graph traversal but reducing deployment overhead." `INFERENCE`: the write-path simplification is the signal — agentic UPDATE/DELETE on every fact was too slow/brittle in production; they pushed conflict resolution to _read_ time (rank the right dated instance) instead of _write_ time (mutate the store). That is a direct lesson for zer0's write path.

**Benchmarks (2026 algorithm).** LoCoMo 92.5, LongMemEval 94.4, BEAM-1M 64.1, all at **~6.7–7.0K tokens/query** vs "**~26,000 for full-context**" — i.e. ~73% token reduction at higher accuracy, p95 latency ~1s ([State of 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026)). Writes are async: "**async_mode=True by default**" to stop memory writes blocking responses.

**Production failure modes mem0 names** (the most useful part for zer0): response latency (writes blocking replies), **retrieval ordering** (vector similarity returns wrong-ranked candidates), **scope leakage** ("losing track of who said what" in multi-agent), **temporal drift** ("a highly-retrieved memory about a user's employer is accurate until they change jobs, at which point it becomes confidently wrong"), cross-session ambiguity (treating user evolution as replacement), identity resolution ([State of 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026)). **Scope leakage is the multi-agent landmine for zer0** — three agents writing one store with no actor attribution.

**Local-first fit.** Apache 2.0; runs as a Python/Node **library** or self-hosted Docker server; LLM + embeddings swappable to **Ollama**; 20 vector backends incl. **pgvector, FAISS, Chroma, Redis, Qdrant** ([GitHub](https://github.com/mem0ai/mem0); [self-host guide](https://mem0.ai/blog/self-host-mem0-docker)). **OpenMemory MCP** runs mem0 as a _local_ MCP server for Cursor / Claude Desktop "without needing a cloud deployment." Gaps for zer0: **no native sqlite-vec backend** in the list (FAISS/Chroma are the local options); the extraction pipeline assumes a chat-message shape, not a 3-agent cockpit transcript.

### 2. Letta (MemGPT) — self-editing memory blocks + tiered virtual context (Apache 2.0)

**Lineage.** MemGPT (Berkeley, 2023): frame the LLM "as a process running on a memory-constrained operating system." Context window = RAM; external stores = disk. Rebranded **Letta** as it became a full agent runtime ([Letta walkthrough](https://sureprompts.com/blog/letta-memgpt-walkthrough)).

**Memory blocks (the load-bearing primitive).** "Structured sections of the agent's context window that persist across all interactions. They are always visible — no retrieval needed." Each block = **{label, description, value, limit}**; the agent self-edits via `core_memory_append` / `core_memory_replace`; blocks are prepended to the prompt in **XML** ([Letta docs — memory blocks](https://docs.letta.com/guides/agents/memory-blocks)). The **description** field is "the main information used by the agent to determine how to read and write to that block" — i.e. each block teaches the model its own write policy. Blocks can be **`read_only: true`** (preserve access, forbid edits).

**Three tiers.** **Core** (in-context blocks, RAM) / **Recall** (searchable conversation history, disk cache) / **Archival** (long-term, queried via `archival_memory_search`, cold storage) ([search synthesis](https://blog.stackademic.com/letta-platform-for-stateful-llm-agents-a83b58a1c926)). Base tools: `core_memory_append/replace`, `conversation_search`, `archival_memory_insert/search`.

**Shared blocks across agents (directly relevant to a 3-agent cockpit).** "Multiple agents can access the same block; update once, visible everywhere" ([Letta docs](https://docs.letta.com/guides/agents/memory-blocks)). This is the cleanest published primitive for zer0's "shared brain": one `project` block, three agents, single source of truth, no merge.

**Sleep-time compute (background consolidation).** Dual-agent: a **primary** handles live turns; a **sleep agent** "activates during downtime to analyze past conversations ... and reorganize memory," generating "**learned context**" that updates the primary's memory blocks **asynchronously** ([Letta — Sleep-time Compute](https://www.letta.com/blog/sleep-time-compute/); [docs](https://docs.letta.com/guides/agents/architectures/sleeptime/)). Shipped in **Letta 0.7.0**. `INFERENCE`: this maps almost 1:1 onto zer0's idle CLI agents — consolidate the cockpit transcript into durable memory while an agent is otherwise idle, off the user's critical path.

**Honest caveat from the sources.** "Memory quality depends entirely on the model's judgment" ([Mem0 vs Letta](https://vectorize.io/articles/mem0-vs-letta)). Self-editing is only as good as the editor.

**Local-first fit.** Apache 2.0, model-agnostic, Docker + `Letta Code` CLI "run agents locally" ([Letta GitHub](https://github.com/letta-ai/letta)). **But the persistence substrate is PostgreSQL** (`init.sql`, `alembic` migrations) — heavier than zer0's SQLite. Adopt the _concepts_ (blocks, shared blocks, sleep-time), not the runtime.

### 3. Zep / Graphiti — temporal knowledge-graph memory (Graphiti core: Apache 2.0)

**Split.** **Zep** = commercial hosted memory service. **Graphiti** = the open-source temporal-KG engine underneath ([Graphiti GitHub](https://github.com/getzep/graphiti)). For local-first, only Graphiti is in play.

**Bi-temporal model (the differentiator).** Every edge carries validity intervals. Four timestamps: **t_valid / t_invalid** (when the fact _held true_ in the world) and **t_created / t_expired** (when it was _ingested / invalidated_ in the system) ([Zep paper, arXiv 2501.13956](https://arxiv.org/abs/2501.13956); [Neo4j — Graphiti](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/)). On conflict, Graphiti **invalidates, does not delete**: "intelligently uses the temporal metadata to update or invalidate, but not discard, outdated information." This is the principled cure for mem0's **temporal-drift** failure — the "changed jobs" problem becomes an edge invalidation with full history retained and point-in-time queryable.

**Retrieval (fast, no LLM at read time).** "Semantic, keyword, and graph search," achieving "**sub-300ms retrieval latency** ... avoiding LLM calls during retrieval" ([Zep paper](https://blog.getzep.com/content/files/2025/01/ZEP__USING_KNOWLEDGE_GRAPHS_TO_POWER_LLM_AGENT_MEMORY_2025011700.pdf)). Benchmark: **DMR 94.8% vs MemGPT 93.4%**.

**The cost that matters for local-first.** _Ingestion_ (writes) requires LLM calls for entity/edge extraction and needs **Structured Output** support — "using other services may result in incorrect output schemas and ingestion failures" ([Graphiti GitHub](https://github.com/getzep/graphiti)). So writes are expensive and model-fussy: the opposite latency profile from zer0's three local CLIs. **Graphiti is also Python-only** (`graphiti-core` on PyPI) — a process boundary for a Node/TS cockpit.

**Local substrate.** Apache 2.0. Backends: Neo4j (default 5.26+), FalkorDB, **FalkorDB Lite** ("embedded ... runs as a subprocess with file-based storage, no server, no Docker, no configuration — just a file path", Python 3.12+), Kuzu (**deprecated, removed soon**), Neptune ([Graphiti GitHub](https://github.com/getzep/graphiti); [FalkorDB Lite issue #1240](https://github.com/getzep/graphiti/issues/1240)). FalkorDB Lite is the only genuinely embeddable graph option, and it still needs an LLM for writes. **Take the bi-temporal _data model_, not the engine.**

### 4. Anthropic memory tool + context management (proprietary feature; the _pattern_ is free)

**Memory tool.** GA on the Messages API (no beta header), all Claude 4+ models, tool type `memory_20250818`. **File-based, client-side**: Claude only _requests_ operations — **view / create / str_replace / insert / delete / rename** — and "your application executes each request against storage you control" under a **`/memories`** prefix ([Memory tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)). It is deliberately _not_ a vector DB: "a transparent, file-based approach instead of complex vector databases ... simple Markdown files" ([Leonie Monigatti](https://www.leoniemonigatti.com/blog/claude-memory-tool.html)).

**Auto-injected protocol (worth copying verbatim as a behavior).** When the tool is present, the API injects: _"IMPORTANT: ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE ... ASSUME INTERRUPTION: Your context window might be reset at any moment, so you risk losing any progress that is not recorded in your memory directory"_ ([Memory tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)). The whole design is **just-in-time retrieval**: "an agent records what it learns in memory files and reads them back on demand," keeping active context focused.

**Multi-session software-dev pattern (this is zer0's exact use case).** Initializer session writes a **progress log + feature checklist + startup-script reference** _before_ work; every later session opens by reading them ("restores the project state without re-exploring the code base"); each session ends by updating the progress log. **"Work on one feature at a time. Mark a feature complete only after end-to-end verification confirms it works, not when the code is written"** ([Memory tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)).

**Context editing + compaction (the eviction half).** _Context editing_ "automatically clears old tool results when conversation context grows beyond a configured threshold." _Compaction_ "summarizes the whole conversation on the server when the conversation approaches the context window limit" ([Managing context](https://anthropic.com/news/context-management); [Memory tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)). The intended combo: **compaction shrinks live context; memory preserves what must survive summarization.** Memory and forgetting are co-designed.

**Security (because the handler is yours).** Explicit **path-traversal** warning — `/memories/../../secrets.env` — mitigations: validate `/memories` prefix, canonicalize and re-check containment, reject `../` / `..\\` / URL-encoded `%2e%2e%2f`; plus size caps, expiration of stale files, and stripping sensitive data before write ([Memory tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)). zer0 runs on Windows with three semi-trusted agents writing memory — **this threat model is directly load-bearing**, including memory-poisoning (one agent writing bad facts another reads).

### 5. Shipping coding tools — how they _actually_ do memory

**Cursor "Memories."** A background **"sidecar model" observes the chat and suggests memories**, which the developer approves/rejects; stored per-project, they "become auto-generated rules" ([Cursor docs — Memories](https://docs.cursor.com/context/memories); [Lullabot](https://www.lullabot.com/articles/supercharge-your-ai-coding-cursor-rules-and-memory-banks)). **Critical negative signal:** multiple sources report Memories were **removed in Cursor v2.1.x (late 2025)** — "users advised to export existing memories and convert them into Rules" ([search synthesis](https://blog.promptlayer.com/cursor-changelog-whats-coming-next-in-2026/); forum-grade, treat as `UNVERIFIED` on exact version but the direction is corroborated). `INFERENCE`: auto-extracted, opaque, low-precision memories created enough noise/distrust that an explicit human-authored _Rules_ file won. **The lesson is precision + visibility over volume.**

**Cline "Memory Bank."** Pure **prompt-engineering methodology, no DB, no embeddings** — six Markdown files in the repo (`projectbrief.md` → `productContext.md` / `systemPatterns.md` / `techContext.md` → `activeContext.md` / `progress.md`), loaded in dependency order. Premised on hard amnesia: **"my memory resets completely between sessions"** → **"I MUST read ALL memory bank files at the start of EVERY task — this is not optional"** ([Cline docs — Memory Bank](https://docs.cline.bot/best-practices/memory-bank)). Updates are **human-triggered** ("update memory bank"). Cheap, transparent, git-versioned, fully local; weakness: no semantic recall, scales poorly past a handful of files, manual hygiene.

**Windsurf "Cascade Memories."** Dual system: **auto-generated** memories (Cascade decides what's worth keeping) **+ manual** ("create a memory of …") **+ Rules** (`.windsurfrules`). Auto memories are **stored locally** in `~/.codeium/windsurf/memories/`, **workspace-scoped, not committed, free** (no credits), retrieved "when it believes they're relevant" ([Windsurf docs — Memories](https://docs.windsurf.com/windsurf/cascade/memories)). The workspace-scoping is exactly zer0's **per-project** boundary; "preferences for one project don't bleed into another."

**Aider — context engineering, not memory.** Aider's **repo map** is a concise, **PageRank-style graph-ranked** view of the git repo's key symbols + signatures, trimmed to a token budget (`--map-tokens`, default 1k) ([Aider — Repository map](https://aider.chat/docs/repomap.html)). Persistent cross-session memory is **explicitly absent**: "Aider's native functionality does not include persistent memory across sessions — each new session starts fresh"; durable instructions live only in a **conventions file** ([Aider FAQ](https://aider.chat/docs/faq.html)). The transferable idea is **graph-ranked relevance over a structural graph to fit a token budget** — directly applicable to ranking which memories to inject.

### 6. AGENTS.md / CLAUDE.md — file-as-memory convention + drift

**Standard.** AGENTS.md: open Markdown format, emerged 2025 (Sourcegraph, OpenAI, Google, Cursor, Factory), **donated to the Agentic AI Foundation under the Linux Foundation, Dec 2025**; **60,000+ projects** by late 2025 ([Tessl](https://tessl.io/blog/the-rise-of-agents-md-an-open-standard-and-single-source-of-truth-for-ai-coding-agents/); [agentsmd.io](https://agentsmd.io/agent-md-vs-agents-md)). It is _static, human-authored, repo-committed_ memory — the durable-instructions layer, distinct from accumulated runtime memory.

**Drift problem + fix.** Per-tool files (`CLAUDE.md`, `GEMINI.md`, `.cursorrules`) "duplicate ... and drift out of sync." Fix: **one file on disk, two filenames — write `AGENTS.md`, symlink `CLAUDE.md` → it, "zero drift"** ([amattn](https://amattn.com/p/using_agentsmd_or_claudemd_to_counteract_agent_drift.html); [Solmaz](https://solmaz.io/log/2025/09/08/claude-md-agents-md-migration-guide/)). Claude Code reportedly **still doesn't natively read AGENTS.md** (third-party claim ~April 2026; treat as `UNVERIFIED`), which is why the symlink trick exists. **Direct relevance:** zer0 drives three CLIs that each look for a _different_ instruction filename — the symlink/SSOT pattern is how zer0 avoids maintaining three copies of project memory.

---

## Storage substrate: vector vs graph vs structured (for local-first)

**The honest framing:** these are not competitors — a production local memory engine layers all three over **one SQLite file**. SQLite gives structured rows + FTS5 keyword search; sqlite-vec adds vectors; a couple of edge tables add graph traversal. zer0 already owns the substrate that can host all three.

### Vector (sqlite-vec / pgvector / FAISS)

- **sqlite-vec** (zer0's current choice). Single `.db` file, zero daemon, in-process, ~30MB default profile, pairs with **FTS5** for hybrid keyword+vector ([dev.to](https://dev.to/aairom/embedded-intelligence-how-sqlite-vec-delivers-fast-local-vector-search-for-ai-3dpb); [llbbl](https://llbbl.blog/2026/04/26/pgvector-vs-sqlitevec-you-probably.html)). **Maturity caveats (must design around):** still **alpha (v0.1.x)**; the `vec0` virtual table is **brute-force KNN only** — "won't be fast until ANN indexes are supported"; metadata filtering only arrived Nov 2024 ([Alex Garcia — metadata release](https://alexgarcia.xyz/blog/2024/sqlite-vec-metadata-release/index.html); [sqlite-vec issue #26](https://github.com/asg017/sqlite-vec/issues/26)). `INFERENCE`: brute-force is _fine_ for a personal cockpit — memory counts are thousands, not millions; linear scan over a few thousand rows is sub-millisecond. The alpha status is the real risk (schema churn, prebuilt-binary availability on Windows/Node) — pin the version and keep an FTS5 fallback path.
- **pgvector.** Better memory management (Postgres buffer cache, background workers), built for "multi-user, server-based scenarios with heavy concurrent access" ([llbbl](https://llbbl.blog/2026/04/26/pgvector-vs-sqlitevec-you-probably.html)). For an on-device single-user cockpit this is **operational weight with no payoff** — a daemon, a port, a migration story. The cited hybrid ("shared/company brain in pgvector, local recall in sqlite-vec") only matters if zer0 grows a cloud tier; today it does not. **Keep pgvector out of the local path.**
- **In-process tradeoff to respect:** "a large vector index competes directly with your application's memory" ([llbbl](https://llbbl.blog/2026/04/26/pgvector-vs-sqlitevec-you-probably.html)) — bounded for a personal store, but cap it.

### Knowledge-graph (Neo4j / FalkorDB Lite / Kuzu)

- **Strength:** multi-hop relational queries and **temporal invalidation** (Graphiti's bi-temporal edges) that flat vectors cannot express — the principled fix for temporal drift.
- **Local cost:** the only embeddable option is **FalkorDB Lite** (file-based, no server) and it's **Python 3.12+**; Kuzu is **deprecated**; Neo4j is a JVM server ([Graphiti GitHub](https://github.com/getzep/graphiti)). For a Windows Node/TS cockpit, a full graph engine is a **second runtime and a process boundary**. `INFERENCE`: the relationship/temporal value is real, but you don't need a graph _engine_ to get it — model entities and bi-temporal edges as **ordinary SQLite tables** (`entities`, `edges(src, rel, dst, t_valid, t_invalid, t_created, t_expired)`) and traverse with recursive CTEs. You capture Graphiti's _data model_ without adopting Graphiti's _infrastructure_.

### Plain structured / event-sourced (SQLite rows)

- **Strength:** deterministic, auditable, **no LLM or embedding cost on the hot path**, trivially correct multi-session/multi-project scoping via columns (`project_id`, `agent_id`, `session_id`), and an append-only **event ledger** gives free history + replay. This is the right _spine_: an immutable log of observations, with derived/curated memory as a projection over it.
- **Weakness:** no semantic recall by itself — exact/FTS match only. That's why it's the spine, not the whole.

### Retrieval vs agentic self-editing (cross-cutting)

- **RAG/retrieval** (embed everything, search at read time): cheap writes, no model judgment stored, but suffers **retrieval ordering** and **temporal drift** (stale facts resurface confidently). mem0's 2026 pivot toward _read-time_ temporal ranking is a retrieval-side mitigation.
- **Agentic self-editing** (model ADD/UPDATE/DELETEs or edits blocks): higher-quality, deduplicated, intentional memory — but "quality depends entirely on the model's judgment," writes are slow/LLM-bound, and mem0 itself **retreated from per-fact UPDATE/DELETE to ADD-only** under production pressure ([State of 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026)).
- **`INFERENCE` — the synthesis for zer0:** **append-only writes (cheap, safe, on critical path) + asynchronous agentic consolidation (Letta sleep-time, off critical path) + hybrid read-time retrieval (vector + FTS + recency/temporal rank).** Never mutate/delete on the user's turn; never trust a single agent's live judgment to destroy memory.

**Substrate verdict:** **keep the single SQLite file and make it do all three jobs** — structured event ledger (spine) + sqlite-vec/FTS5 (semantic + keyword recall) + entity/bi-temporal edge tables (relationships + invalidation). One file, zero daemons, fully local, multi-project by column. Adopt graph/temporal _models_, reject graph/Postgres _engines_.

---

## What to COPY (ranked)

1. **Anthropic's "ASSUME INTERRUPTION" multi-session protocol + file-as-memory transparency.** View-memory-before-acting, progress-log + feature-checklist, end-of-session update, "mark complete only after end-to-end verification." It is battle-tested for exactly zer0's multi-session coding use case, it is free (a pattern, not a product), and transparent Markdown beats an opaque vector blob for a tool whose users are developers. ([Memory tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool))

2. **Letta shared memory blocks for the 3-agent shared brain.** "Update once, visible everywhere" is the cleanest published answer to "how do Claude, Codex, and Gemini share one memory without merge conflicts." Model it as labeled, size-capped blocks (one `project` block, one `persona`/role block per agent, a shared `decisions` block) with `read_only` where an agent must not edit. Concept only — skip the Postgres runtime. ([Letta docs](https://docs.letta.com/guides/agents/memory-blocks))

3. **Letta sleep-time / asynchronous consolidation.** zer0's agents idle between turns; spend that idle compute consolidating the transcript into durable memory **off the user's critical path**. This is the production-safe way to get agentic self-editing without paying its latency on every turn — and it sidesteps mem0's #1 failure (writes blocking responses). ([Sleep-time Compute](https://www.letta.com/blog/sleep-time-compute/))

4. **Graphiti's bi-temporal data model — as SQLite columns, not as a graph engine.** Store `t_valid/t_invalid` + `t_created/t_expired` on facts/edges; on conflict **invalidate, don't delete**. This is the only principled cure for **temporal drift** ("changed jobs → confidently wrong") and it gives point-in-time queries and full audit. Capture the model; reject Neo4j/FalkorDB. ([Zep paper](https://arxiv.org/abs/2501.13956))

5. **mem0's named production failure modes as a design checklist** — latency, retrieval ordering, **scope leakage / actor attribution** (critical: 3 agents, one store → every fact must carry `agent_id` + `project_id`), temporal drift, cross-session ambiguity. Plus its hard-won write-path lesson: **prefer cheap ADD + read-time conflict resolution over expensive per-fact UPDATE/DELETE.** ([State of 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026))

6. **Hybrid retrieval (vector + keyword + temporal/recency rank), no LLM at read time** — Zep's sub-300ms recipe and mem0's multi-signal retrieval converge here. zer0 already has sqlite-vec; add FTS5 keyword + a recency/validity rank and fuse scores. Keeps reads fast and local. ([Zep paper](https://blog.getzep.com/content/files/2025/01/ZEP__USING_KNOWLEDGE_GRAPHS_TO_POWER_LLM_AGENT_MEMORY_2025011700.pdf))

7. **Windsurf's workspace-scoping + Cline's hard "read memory at task start."** Per-project isolation so memory doesn't bleed across zer0's projects (zer0 already supports it — enforce it as a column predicate on every read), and a mandatory read-on-start so agents actually use memory instead of re-deriving. ([Windsurf docs](https://docs.windsurf.com/windsurf/cascade/memories); [Cline docs](https://docs.cline.bot/best-practices/memory-bank))

8. **AGENTS.md SSOT + symlink to avoid per-CLI drift.** zer0 drives three CLIs that each read a different instruction filename; one canonical file (symlinked) for the _static_ project-memory layer prevents maintaining three drifting copies. ([amattn](https://amattn.com/p/using_agentsmd_or_claudemd_to_counteract_agent_drift.html))

9. **Aider's graph-ranked relevance to fit a token budget.** When choosing which memories to inject, rank by a PageRank-style score over the entity/edge graph (not raw cosine), trimmed to a fixed token budget — directly portable to memory selection. ([Aider — repo map](https://aider.chat/docs/repomap.html))

10. **Anthropic context editing + compaction as the _forgetting_ half.** Memory is only half a system; design eviction with it — summarize/evict stale context while persisting what must survive. Co-design remember + forget. ([Managing context](https://anthropic.com/news/context-management))

---

## What to AVOID

1. **A heavyweight DB engine in the local path (Postgres/pgvector, Neo4j, FalkorDB server).** Each is a daemon, a port, a migration story, and (Graphiti) a second language runtime — pure operational weight for a single-user on-device cockpit whose moat is local-first. zer0's single SQLite file already subsumes their _models_. ([llbbl](https://llbbl.blog/2026/04/26/pgvector-vs-sqlitevec-you-probably.html); [Graphiti GitHub](https://github.com/getzep/graphiti))

2. **Synchronous agentic UPDATE/DELETE on the user's turn.** mem0's #1 production failure was writes blocking responses (fixed with `async_mode=True`), and they **abandoned per-fact UPDATE/DELETE** entirely. Don't put LLM-judged mutation/deletion on the hot path — append synchronously, consolidate asynchronously. ([State of 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026))

3. **Opaque auto-extracted memory with no human visibility/approval — the Cursor "Memories" failure.** Memories were reportedly **pulled in v2.1.x** and users pushed back to explicit Rules. Low-precision auto-memory breeds distrust and silent context pollution. Keep memory **inspectable, editable, and ideally human-confirmable** for high-stakes facts. (`UNVERIFIED` on exact version; direction corroborated — [promptlayer](https://blog.promptlayer.com/cursor-changelog-whats-coming-next-in-2026/))

4. **Destructive deletes / overwrite-in-place.** Graphiti's discipline — "**update or invalidate, but not discard**" — exists because deletion loses history and re-creates drift. Use append-only + temporal invalidation; never hard-delete a fact a future agent might need to reconcile. ([Neo4j — Graphiti](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/))

5. **One shared memory pool with no actor/project attribution.** mem0 names **scope leakage** ("losing track of who said what") as a core multi-agent failure. With three agents and many projects, **every memory row must carry `agent_id`, `project_id`, `session_id`** or the shared brain becomes an un-attributable mush. ([State of 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026))

6. **Trusting agent self-edits blindly (memory poisoning) + ignoring path-traversal in the file layer.** "Quality depends entirely on the model's judgment" — one agent can write a wrong fact two others then trust. Anthropic's handler-security warnings (path traversal `/memories/../../secrets.env`, size caps, sensitive-data stripping, expiration) are **mandatory** for a Windows cockpit where three semi-trusted CLIs write memory. Validate, sandbox, and quarantine cross-agent writes. ([Mem0 vs Letta](https://vectorize.io/articles/mem0-vs-letta); [Memory tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool))

7. **Pure prompt-engineering memory at scale (Cline Memory Bank as the _only_ mechanism).** Loading all memory files at the start of every task is transparent but doesn't scale — it burns context linearly and has no semantic recall. Great as the **static/project layer**; insufficient as the **accumulating runtime layer**. Use it alongside sqlite-vec recall, not instead of it. ([Cline docs](https://docs.cline.bot/best-practices/memory-bank))

8. **Betting the engine on sqlite-vec's missing pieces.** It's **alpha, brute-force KNN, no ANN index yet**. Fine at personal scale, but **pin the version**, keep an **FTS5/keyword fallback**, and don't architect for million-vector ANN performance it can't yet deliver on Windows/Node. ([sqlite-vec issue #26](https://github.com/asg017/sqlite-vec/issues/26); [Alex Garcia](https://alexgarcia.xyz/blog/2024/sqlite-vec-metadata-release/index.html))

9. **LLM-on-the-read-path retrieval.** Zep deliberately avoids LLM calls during retrieval to hit sub-300ms; mem0 ADD-only keeps reads cheap. A local cockpit cannot afford an extraction/judgment LLM round-trip on every recall — keep retrieval to embeddings + keyword + rank. ([Zep paper](https://blog.getzep.com/content/files/2025/01/ZEP__USING_KNOWLEDGE_GRAPHS_TO_POWER_LLM_AGENT_MEMORY_2025011700.pdf))

10. **Cloud-coupled memory SaaS (Zep hosted, mem0 Platform, managed graph).** Any design that routes the user's project memory through a vendor cloud forfeits zer0's local-first moat, the offline guarantee, and data residency. Where a cloud product has an OSS core (Graphiti, mem0 OSS, OpenMemory), take the **library/model**; never the hosted service. ([Graphiti GitHub](https://github.com/getzep/graphiti); [mem0 self-host](https://mem0.ai/blog/self-host-mem0-docker))

---

## Sources

- mem0 — [GitHub](https://github.com/mem0ai/mem0) · [State of AI Agent Memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026) · [self-host guide](https://mem0.ai/blog/self-host-mem0-docker) · [Mem0g/architecture breakdown](https://memo.d.foundation/breakdown/mem0) · [Mem0 vs Letta](https://vectorize.io/articles/mem0-vs-letta)
- Letta / MemGPT — [memory blocks docs](https://docs.letta.com/guides/agents/memory-blocks) · [sleep-time agents docs](https://docs.letta.com/guides/agents/architectures/sleeptime/) · [Sleep-time Compute blog](https://www.letta.com/blog/sleep-time-compute/) · [GitHub](https://github.com/letta-ai/letta) · [walkthrough](https://sureprompts.com/blog/letta-memgpt-walkthrough)
- Zep / Graphiti — [Zep paper (arXiv 2501.13956)](https://arxiv.org/abs/2501.13956) · [Zep paper PDF](https://blog.getzep.com/content/files/2025/01/ZEP__USING_KNOWLEDGE_GRAPHS_TO_POWER_LLM_AGENT_MEMORY_2025011700.pdf) · [Graphiti GitHub](https://github.com/getzep/graphiti) · [FalkorDB Lite issue #1240](https://github.com/getzep/graphiti/issues/1240) · [Neo4j — Graphiti](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/)
- Anthropic — [Memory tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) · [Managing context / context editing](https://anthropic.com/news/context-management) · [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) · [Leonie Monigatti — memory tool](https://www.leoniemonigatti.com/blog/claude-memory-tool.html)
- Coding tools — [Cursor Memories docs](https://docs.cursor.com/context/memories) · [Lullabot — Cursor rules + memory bank](https://www.lullabot.com/articles/supercharge-your-ai-coding-cursor-rules-and-memory-banks) · [Cline Memory Bank docs](https://docs.cline.bot/best-practices/memory-bank) · [Windsurf Cascade Memories docs](https://docs.windsurf.com/windsurf/cascade/memories) · [Aider repo map](https://aider.chat/docs/repomap.html) · [Aider FAQ](https://aider.chat/docs/faq.html)
- AGENTS.md / CLAUDE.md — [Tessl — rise of AGENTS.md](https://tessl.io/blog/the-rise-of-agents-md-an-open-standard-and-single-source-of-truth-for-ai-coding-agents/) · [amattn — counteract agent drift](https://amattn.com/p/using_agentsmd_or_claudemd_to_counteract_agent_drift.html) · [Solmaz — migration guide](https://solmaz.io/log/2025/09/08/claude-md-agents-md-migration-guide/) · [agentsmd.io](https://agentsmd.io/agent-md-vs-agents-md)
- Substrate — [llbbl — pgvector vs sqlite-vec](https://llbbl.blog/2026/04/26/pgvector-vs-sqlitevec-you-probably.html) · [Alex Garcia — sqlite-vec metadata](https://alexgarcia.xyz/blog/2024/sqlite-vec-metadata-release/index.html) · [sqlite-vec issue #26 (metadata filtering)](https://github.com/asg017/sqlite-vec/issues/26) · [dev.to — sqlite-vec local vector search](https://dev.to/aairom/embedded-intelligence-how-sqlite-vec-delivers-fast-local-vector-search-for-ai-3dpb)

_Note on confidence:_ benchmark numbers are vendor-reported (mem0, Zep self-publish their wins — treat cross-system comparisons as directional, not neutral). Cursor "Memories removed in v2.1.x" and "Claude Code doesn't read AGENTS.md" are third-party/forum claims marked `UNVERIFIED`. Architecture, license, and backend facts are confirmed against primary docs/repos and quoted inline.
