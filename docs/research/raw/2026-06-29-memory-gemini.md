# Thesis: The Hierarchical Namespace & Write-Only Log Approach

The only way to guarantee memory isolation across concurrent sessions and projects while maintaining shared context for multiple agents is to strictly separate the **Write Path** (an append-only, immutable event log scoped to a specific session) from the **Read Path** (a periodically consolidated, hierarchical view of state). By enforcing that agents never overwrite each other's memory directly and that all persistent memory is heavily namespaced (User > Workspace/Project > Session), we prevent cross-project pollution. The "brain" is built not by agents updating a shared document, but by a background compaction process (running through one of the local LLM agents) that asynchronously summarizes session logs into project-level facts, eliminating the deadlock and hallucination risks of real-time shared memory. 

## 1. MEMORY LAYERS

Memory in zer0 chat must be stratified by its lifecycle and mutation semantics to balance relevance with data safety.

- **Session/Working Memory (Short-Term):** High-fidelity, turn-by-turn context for a specific task. This is an immutable, append-only log of agent actions, user prompts, and system events. Its lifetime is tied to the active chat session. Eviction happens by truncating the immediate context window and offloading older turns to the vector index or background summarization.
- **Project/Workspace Memory (Long-Term):** Consolidated facts, architectural decisions, and known bugs scoped strictly to a specific repository or project boundary. This layer is mutable but only updated via deliberate consolidation (not directly by every chat turn). It persists indefinitely or until explicitly deleted.
- **Global/User Preferences:** Cross-cutting user habits (e.g., "always use type hints", "prefer functional components"). This is a tiny, highly curated configuration layer loaded into every session regardless of project.
- **The "Graveyard" (Archived):** Sessions that are closed or marked irrelevant. They are excluded from
<truncated 4722 bytes>
s a database schema from Project A in Project B. 
  - *Mitigation:* The SQLite queries for context injection hardcode `WHERE project_id = ?`. It is mathematically impossible for the vector search to return Project A's facts while in Project B.
- **Failure: Concurrent Agent Overwrite.** Claude and Codex try to update the "brain" at the same time.
  - *Mitigation:* They don't write to the brain. They append to `SessionEvents`. SQLite handles concurrent appends natively. The background consolidation process is strictly single-threaded per project.

## Recommended architecture (the pick)

**The Immutable Session Log with Asynchronous Consolidation.** 
Do not attempt real-time, shared mutable state between heterogeneous agents. Build the engine like an Event Sourced system. All agent interactions are appended to a session-specific SQLite log. Retrieval is a multi-stage pipeline: FTS5/vector search against the current session log, falling back to a strictly partitioned (by `ProjectId`) `ProjectFacts` table. The `ProjectFacts` table is only ever updated by a background consolidation routine that runs *after* a session concludes successfully, using one of the available agents to synthesize the log into clean, de-duplicated memory. This guarantees absolute project isolation, prevents a chaotic active session from instantly poisoning long-term memory, and elegantly solves multi-agent concurrency.

## What everyone gets wrong

**Treating memory as a globally mutable key-value store.**
Most agent architectures treat long-term memory like a shared Redis cache where any agent can run an `UPSERT` at any moment during a chat. This inevitably leads to state corruption, race conditions between agents, and immediate poisoning where one bad hallucination permanently overwrites a good core architectural fact. By failing to separate the high-chaos working environment (the chat session) from the curated long-term knowledge base (the project facts), they guarantee that entropy will eventually destroy the usefulness of the memory system.