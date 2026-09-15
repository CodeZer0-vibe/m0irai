**THESIS:** The memory engine should be a scoped evidence ledger, not a chatbot scrapbook. The hard architectural line is: raw session history is never shared by default; durable memory is only promoted through a scoped, provenance-bearing, revocable claim system; and project isolation is enforced physically by project-local SQLite databases, not merely by query filters. Everything else, including vectors, summaries, and agent-written “lessons,” is secondary to that boundary.

## 1. MEMORY LAYERS

**Working / turn memory**
Lives inside a single agent dispatch or debate round. It contains the current operator request, peer outputs for the current turn, prompt snapshot hash, active files, tool outputs, and short-lived coordination state. Lifetime: one turn, optionally extended through the current session. Eviction: aggressively trimmed by prompt budget; never promoted automatically.

**Session memory**
Lives inside one `chat_session_id`. It contains raw transcript events, agent outputs, decisions, failures, approvals, task state, and session-local notes. It can be used by later turns in the same session. It must not enter another session unless promoted. Lifetime: until session archive; queryable forever as evidence, but not auto-injected after inactivity unless resumed explicitly.

**Project knowledge**
Durable memory for one repo/project: architecture decisions, recurring failures, file ownership facts, commands that matter, known gotchas, accepted conventions, and previous successful fixes. This is the primary long-term layer. Lifetime: persistent until superseded, expired, or manually forgotten. Promotion requires evidence.

**Project working set**
Branch/path/task-specific slice of project memory. Example: “this migration failed on branch X because schema baseline drifted.” It is narrower than project knowledge and should decay faster. Lifetime: branch/task TTL or until file anchors go stale.

**Global/user prefs**
Only cross-project preferences: response style, preferred shell discipline, literal output rules, general agent routing preferences. No repo facts. Store in a separate global DB and inject only through an explicit `allowed_global_preferences` lane.

**Do not create a generic “long-term memory” bucket.** That bucket is where poisoning starts.

## 2. SCOPING & ISOLATION

The hierarchy should be:

`user_profile -> project -> workspace/branch -> session -> turn -> agent_dispatch`

The guarantee should be physical first, logical second:

- One project-local DB: `<project>/.zer0/memory.db`.
- One global registry DB: `%LOCALAPPDATA%/zer0/global.db`.
- No automatic `ATTACH` between project DBs.
- No cross-project query path in normal retrieval code.
- A project move requires explicit relink, not fuzzy path matching.

Every memory row carries a scope envelope:

- `project_id`: stable ULID created in `.zer0/project.json`.
- `project_fingerprint`: canonical root plus git remote/hash when available.
- `session_id`, nullable only for promoted project knowledge.
- `branch_ref`, `worktree_root`, `agent`, `turn_id`.
- `scope_level`: `global_pref | project | branch | session | turn | agent_private`.
- `visibility`: `private | shared_session | project_promotable | project_durable`.
- `state`: `raw | candidate | quarantined | active | superseded | expired | forgotten`.

The rule: retrieval starts from a required `ScopeEnvelope`. The engine cannot ask “find useful memory”; it must ask “find memory allowed for this exact project/session/task.” Session memory is invisible outside its session unless a promoted `memory_item` exists with `state=active` and `scope_level=project`.

## 3. RETRIEVAL

Use hybrid retrieval, but structured filters run first:

1. Hard filter: project DB, scope envelope, state, visibility, branch/path validity, max age.
2. Structured hits: exact file path, symbol, command, package script, test name, error fingerprint, task id.
3. FTS hits: SQLite FTS5 for lexical search. FTS5 supports `MATCH` queries and relevance ordering via rank/bm25-style ranking, so it is the right local primitive for exact error strings and file names. ([sqlite.org](https://www.sqlite.org/fts5.html))
4. Vector hits: sqlite-vec for semantic recall only after hard filtering. sqlite-vec supports KNN-style `vec0` virtual table queries, but its docs mark it pre-v1, so wrap it behind an adapter and keep FTS/structured retrieval as the correctness path. ([alexgarcia.xyz](https://alexgarcia.xyz/sqlite-vec/api-reference.html))
5. Rerank: combine scope strength, evidence quality, freshness, exactness, recency, and contradiction status.

Ranking should prefer:

- same session > same branch > same project > global preference
- exact path/error > semantic similarity
- code/test/command evidence > agent prose
- newer active revision > older unsuperseded revision
- operator-pinned memory > inferred memory

Wrong/stale context avoidance:

- Never inject a naked vector hit.
- Every injected memory includes source, age, scope, confidence, and supersession status.
- If a source file no longer exists or its anchor hash changed, downgrade or quarantine.
- If two active memories contradict, inject neither by default; surface a compact conflict note only when relevant.
- Apply a fixed memory budget per prompt, with must-keep current request and peer context ahead of memory.

sqlite-vec metadata and partition features are useful, but do not over-shard. Its docs warn partition keys can slow KNN when each partition has too few vectors; that matters for per-session partitions. Use metadata filters for `scope_level`, `state`, and `memory_type`; do not partition by every session. ([alexgarcia.xyz](https://alexgarcia.xyz/sqlite-vec/features/vec0.html))

## 4. WRITE / CONSOLIDATION PATH

Write path should be two-phase.

**Phase A: immutable capture**
Every turn writes raw events: prompt snapshot, agent output, tool evidence, command result, file references, approval decisions, and failure summaries. This is evidence, not memory. It is append-only and session-scoped.

**Phase B: promotion**
A memory curator runs at safe points: session end, task complete, explicit `/remember`, or idle background pass. Since the product cannot use metered API keys, this curator must be a normal zer0-dispatched agent job through Claude/Codex/Gemini, not a cloud memory service.

Promotion creates candidates, not durable facts. A candidate needs:

- a normalized claim
- scope proposal
- evidence refs
- confidence
- expiry policy
- contradiction check
- owner agent
- reason for promotion

Promotion rules:

- Operator-pinned memory can become durable immediately.
- Code/test/command evidence can promote if it has stable anchors.
- Agent-only summaries enter `candidate` or `quarantined`.
- Repeated corroboration across sessions can promote.
- Session-local opinions never promote without evidence.

Forgetting is structural:

- `superseded_by` links for replacements.
- `expires_at` for branch/task facts.
- `decay_score` for weak inferred memories.
- `forgotten` tombstone state instead of hard delete, unless the user requests secure deletion.

## 5. SHARED-AGENT MEMORY

The three agents should share a session working set, not write directly into durable project memory.

Model:

- Agents append observations to `raw_events`.
- Agents may propose `memory_candidates`.
- A single conductor/curator promotes candidates into `memory_items`.
- Durable memory writes are serialized through one local write queue.
- Each agent dispatch receives an immutable `context_snapshot_id`.

This prevents stomping. Claude can say “the test failed because X,” Codex can say “X is false; the fixture was stale,” and Gemini can add research. Those are competing claims until the curator resolves or links them.

Conflict model:

- `supports`, `contradicts`, `supersedes`, `duplicates` edges between claims.
- Evidence priority: operator > current code/test/command > persisted artifact > multi-agent agreement > single-agent summary.
- Never overwrite an old memory in place. Add a revision and mark prior active item superseded.

For `/debate` or multi-agent turns, all agents in the same round should read the same memory snapshot hash. Round 2 can include peer outputs, but the persistent memory view should not change mid-round.

## 6. DATA MODEL

Project DB sketch:

| Table | Purpose | Key fields |
| --- | --- | --- |
| `project_meta` | identity boundary | `project_id`, `root`, `fingerprint`, `created_at`, `schema_version` |
| `chat_sessions` | session boundary | `session_id`, `project_id`, `started_at`, `ended_at`, `state` |
| `turns` | operator turn ledger | `turn_id`, `session_id`, `ordinal`, `request_hash`, `created_at` |
| `agent_dispatches` | per-agent work | `dispatch_id`, `turn_id`, `agent`, `round`, `outcome`, `context_snapshot_id` |
| `context_snapshots` | replayable prompt memory | `snapshot_id`, `scope_envelope_json`, `memory_item_ids_json`, `blob_hash` |
| `raw_events` | append-only evidence | `event_id`, `session_id`, `turn_id`, `agent`, `kind`, `body`, `created_at` |
| `memory_items` | durable/candidate claims | `memory_id`, `scope_level`, `visibility`, `state`, `type`, `title`, `body`, `confidence`, `created_at`, `expires_at` |
| `memory_revisions` | immutable versions | `revision_id`, `memory_id`, `body`, `reason`, `writer`, `created_at` |
| `memory_sources` | provenance | `memory_id`, `source_kind`, `source_ref`, `source_hash`, `line_ref`, `trust_level` |
| `memory_edges` | conflict/dedupe graph | `from_memory_id`, `to_memory_id`, `edge_type`, `created_at` |
| `memory_candidates` | agent proposals | `candidate_id`, `session_id`, `agent`, `claim`, `evidence_json`, `status` |
| `retrieval_audit` | explainability | `query_id`, `scope_envelope_hash`, `selected_ids`, `rejected_ids`, `created_at` |

Indexes:

- `(scope_level, state, visibility, created_at)`
- `(session_id, turn_id)`
- `(type, confidence, created_at)`
- `(source_kind, source_ref)`
- FTS5 table over `title`, `body`, `source_ref`
- sqlite-vec `vec0` table keyed back to `memory_id`, with metadata for `state`, `scope_level`, `type`

SQLite WAL is a good fit for concurrent local sessions because readers and writers can proceed concurrently in WAL mode, with the normal single-writer caveat. ([sqlite.org](https://www.sqlite.org/wal.html)) SQLite also provides serializable transaction isolation between connections, which is the baseline needed for local multi-session safety. ([sqlite.org](https://www.sqlite.org/isolation.html))

## 7. ISOLATION GUARANTEES + FAILURE MODES

| Failure | Prevention |
| --- | --- |
| Project A memory appears in Project B | separate project DBs; no cross-project attach; retrieval requires project-local DB handle |
| Bad session poisons project | raw session logs never shared; only promoted active memories are reusable |
| Agent hallucination becomes fact | candidates require evidence and curator promotion |
| Stale branch fact appears on another branch | branch/worktree scope plus expiry and anchor validation |
| Vector search surfaces plausible garbage | hard filters before vector search; no naked vector injection |
| Concurrent sessions overwrite memory | append-only raw events; serialized promotion queue; immutable revisions |
| Prompt injection inside memory | memory rendered as untrusted context with provenance, never as instruction |
| DB lock corrupts flow | WAL, busy timeout, short write transactions, retry/backoff |
| DB corruption | project-local backups, integrity check, exportable JSONL evidence log |
| Wrong project detected | `.zer0/project.json` manifest; explicit relink on root/fingerprint mismatch |
| Global prefs leak repo facts | global DB schema only allows preference categories, not project facts |

## Recommended architecture (the pick)

Build a **Project-Scoped Evidence Ledger with Curated Memory Promotion**.

Concretely:

- Keep one `.zer0/memory.db` per project.
- Keep `%LOCALAPPDATA%/zer0/global.db` only for user preferences and project registry.
- Capture everything raw and session-scoped.
- Promote nothing automatically into durable project memory unless it is operator-pinned, evidence-backed, or corroborated.
- Use structured retrieval + FTS5 as the correctness layer.
- Use sqlite-vec as an optional semantic recall accelerator, never as the authority.
- Give every agent the same immutable context snapshot per dispatch.
- Let agents propose memory; let the conductor/curator promote memory.
- Make staleness, scope, source, confidence, and supersession first-class fields.
- Treat “forget” as a real lifecycle, not a UI filter.

This is buildable on local SQLite, aligns with subscription-agent constraints, and makes project isolation the default physics of the system instead of a hope encoded in `WHERE project_id = ?`.

## What everyone gets wrong

They confuse “remembering more” with “remembering better.” The trap is dumping every session summary into a vector index and calling it a brain. That creates fluent contamination: old plans, wrong guesses, abandoned branches, and agent hallucinations all become equally retrievable prose.

The real product moat is not vector search. It is trust routing: knowing which memory is allowed, current, evidenced, scoped, and worth spending context on. The best memory engine is mostly a boundary system with retrieval attached.

