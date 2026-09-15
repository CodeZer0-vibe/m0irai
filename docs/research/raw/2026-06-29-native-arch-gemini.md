Overall, the 3-layer architecture—leveraging native memory, a file-based shared layer, and deterministic verification—is a highly pragmatic and resilient design for a local-first multi-agent system. However, my single biggest disagreement is the assumption that keeping ONE long-lived native session per agent is strictly beneficial. Native LLM sessions inevitably suffer from context rot, attention dilution, and escalating latency. Instead of forcing long-lived sessions for the entire chat, the system should adopt an "Assume Interruption" model where native sessions are treated as ephemeral workspaces scoped to a single task, while the file-based shared layer acts as the true permanent memory.

## 1. ACP native sessions

The **Agent Client Protocol (ACP)** is a JSON-RPC standard that allows a client (like an editor or terminal) to host an agent (like Claude Code) while standardizing tool execution and UI [Source: https://agentclientprotocol.com/]. While an ACP connection can be long-lived, the underlying agent is still bound by the LLM's stateless API and context window limits (e.g., 200k tokens for Claude).
*   **Semantics & Caps:** Claude Code maintains its own conversation array. As the session grows, it handles context limits natively (typically via truncation or summarization), but this silent compaction inevitably leads to forgotten constraints.
*   **Cost & Performance:** Even with prompt caching, long sessions degrade. Attention dilution (the "lost in the middle" phenomenon) causes the agent to ignore subtle instructions as the context fills up.
*   **Feasibility:** One long-lived session for the *whole chat* is an anti-pattern. It is feasible technically, but it will suffer from context rot and drift over time. Sessions should be ephemeral and scoped per-feature.

## 2. gemini/agy

The Google Antigravity CLI (`agy`) natively supports conversation resume via `--continue`, `/resume`, or `/conversation <id>` [Source: file:///C:/Users/<user>/.gemini/antigravity-cli/builtin/skills/antigravity_guide/reference
<truncated 3299 bytes>
codex attempt to update the shared file concurrently, overwriting each other's progress. *Prevention:* zer0 acts as a mutex lock or the sole writer of the shared state.
*   **Context Rot:** An agent's long-lived session becomes so bloated it ignores new instructions. *Prevention:* Bound the lifespan of native sessions. Kill and restart them when shifting to a new major task.
*   **Deadlock / Echo Chambers:** Agent A breaks a test; Agent B tries to fix it and breaks Agent A's code in an infinite loop. *Prevention:* zer0 must implement a strict retry limit and escalate to the human operator when agents thrash.

## Recommended architecture (your pick)

**The Ephemeral Agents + Immutable Ledger Model.**
Do not keep one continuous session per agent forever. 
1. **The Ledger (zer0):** zer0 maintains the single source of truth in git-versioned, human-readable markdown files (`STATE.md`, `PLAN.md`). 
2. **Ephemeral Sessions:** When a task is dispatched, zer0 spawns a fresh ACP/agy session and injects the Ledger into the prompt. The agent uses its native memory *only for the duration of that specific task*.
3. **Deterministic Commit:** Once the agent claims the task is done, zer0 deterministically verifies the outcome (tests pass, diffs exist). If verified, zer0 updates the Ledger, commits to git, and the agent session is terminated (or archived). This guarantees zero context rot and perfect cross-agent synchronization.

## Biggest risk / what everyone gets wrong

**Treating large context windows as infinite memory.** 
Everyone building agentic systems assumes that because a model accepts 200k to 2M tokens, they can just leave the session open forever. This is a fatal flaw. As the context fills, agents suffer from severe attention dilution—they forget core constraints, degrade in instruction-following capability, and become expensive and slow to query. Rehydrating a fresh, clean session from a dense, curated summary (the file-based memory) consistently outperforms trying to maintain an ancient, sprawling native session.