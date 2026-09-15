### Q1. Reference-Product Teardown

**ChatGPT Memory**
*   **Delighters:** Persistent personalization [Source](https://medium.com/), magical convenience and continuity [Source](https://substack.com/), cognitive load reduction [Source](https://reddit.com/).
*   **Complaints:** Context rot/bias where outdated info creeps in [Source](https://medium.com/), data loss/memory collapse [Source](https://openai.com/), privacy concerns/"thought aquarium" echo chamber [Source](https://zdnet.com/).

**Claude Code Auto-Memory**
*   **Delighters:** Compound efficiency through learning rules [Source](https://producttalk.org/), context persistence across sessions [Source](https://claude.com/), seamless workflows [Source](https://github.com/).
*   **Complaints:** "Goldfish" behavior ignoring stored rules [Source](https://medium.com/), context pollution/AI talking to itself [Source](https://reddit.com/), silent degradation [Source](https://medium.com/).

**Cursor Memory**
*   **Delighters:** AI-native workflow understanding whole codebases [UNVERIFIED], custom rules via extensions [UNVERIFIED].
*   **Complaints:** Context loss forgetting architecture [UNVERIFIED], performance bloat/RAM usage [UNVERIFIED], privacy cloud sharing concerns [UNVERIFIED].

**MemGPT / Letta**
*   **Delighters:** Persistent OS-like memory [UNVERIFIED], self-editing agentic framework [UNVERIFIED], white-box memory visualization [UNVERIFIED].
*   **Complaints:** Heavy setup complexity [UNVERIFIED], temporal blindness/staleness [UNVERIFIED].

### Q2. TRUST + CONTROL Surface
Users trust memory when they have inspectability and provenance. 
*   **MINIMUM MVP Trust Surface:**
    *   `/recall` MUST show the exact facts pulled and their origin.
    *   **Visibility:** Injected memories must be **VISIBLE** via a non-intrusive UI chip (e.g., "Recalled 3 facts"). Silent injection causes users to feel "gaslit" by hallucinations [Source](https://reddit.com/).
    *   **Correction:** Natural language correction (e.g., "forget that") must trigger explicit UI confirmation of deletion, backed by a manual edit/delete viewer.

### Q3. FORGETTING
Users want **supersession-based** and **usage-based** decay. Time-based decay fails because a 6-month-old architectural rule remains valid, while a 1-day-old bug fix context becomes obsolete.
*   **MVP Policy Recommendation:** **Supersession-based.** If a new fact directly contradicts an old fact, the old fact is aggressively overwritten or demoted.

### Q4. The 3-Agent Twist (Unique Pitfalls)
*   **Pitfall (Hallucination Cascades & Logic Deadlocks):** If Claude hallucinates an API endpoint, writes it to memory, and Codex reads it, Codex assumes it's ground truth. Disagreements between agents could be recorded as conflicting facts, freezing the system.
*   **Guard Recommendation (Provenance + Consensus Check):** Every memory must tag its author (`source: claude`). If two agents contradict each other in memory, the system triggers a "Conflict Detection" warning requiring operator resolution before persisting the fact.

### Q5. Most-Valuable Addition
**"Memory Pre-flight Check"** 
Before executing a complex query, the terminal shows a 1-line preview: *"Context loaded: [Database Schema, Auth Rules] (Press Tab to edit)"*. This gives the operator micro-control to instantly prune stale facts before they rot the prompt, addressing the #1 long-run complaint (context pollution) across all memory tools.