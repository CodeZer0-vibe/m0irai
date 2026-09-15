# USER-ADVOCATE CRITIQUE: The Inline Review Redesign

Here is the critique of the proposed inline-first synthesis from the perspective of the operator's chair. 

### 1. The Interrupt & Scroll-Away Threat
* **User Need:** Continuous, uninterrupted dialogue with agents (especially in `@all` scenarios), while maintaining review accountability.
* **Failure Prevented:** The chat flow being destroyed by a wall of diff cards from multiple agents finishing simultaneously, and the operator losing track of pending reviews because they scrolled off-screen during a fast-moving chat.
* **Concrete Recommendation:** Inline cards must be ephemeral states, not permanent chat history blocks. If the operator continues typing, unreviewed changes safely default to "Keep" (as they are already on disk). Unresolved reviews should collapse into a sticky "Pending Reviews: N" indicator at the boundary of the viewport if they scroll out of view, allowing the operator to recall them. When answered (keep/undo), the card should instantly collapse into a single-line tombstone in the chat history (e.g., `✓ Kept 14 lines in src/theme.ts`).

### 2. The Oversized Case Reality
* **User Need:** High-level, semantic understanding of massive changes without reading the machinery of the application or scrolling endlessly.
* **Failure Prevented:** Operator fatigue and blind approvals. The current `Oversized diff (2000 lines) — collapsed; force-agent-to-chunk redirect ready: "..."` text exposes internal tool mechanics rather than helping the user understand the change.
* **Concrete Recommendation:** Do not show tool machinery text. Instead, present an AI-generated abstract of the massive change (e.g., "Generated 2,000 lines of API client boilerplate"). Offer the "chunk" command as a simple one-key action (`[c] Ask agent to chunk`) rather than spelling out the literal redirect prompt string in the UI.

### 3. Communicating "Already Applied" Semantics
* **User Need:** Immediate clarity on the safety and state of their files without having to read a lega
<truncated 3006 bytes>
                                    │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
```

**The Multi-Group / Oversized Case**
```text
╭──────────────────────────────────────────────────────────────────────────────────────────────────╮
│ ✓ CHANGES APPLIED  codex  (3 groups, 12 files, 2,045 lines)                                      │
│                                                                                                  │
│   1. API Client Generation (10 files, 2,030 lines)                                               │
│      Generated boilerplate endpoints from OpenAPI spec.                                          │
│                                                                                                  │
│   2. package.json updates (1 file, 12 lines)                                                     │
│                                                                                                  │
│   3. minor linting fixes (1 file, 3 lines)                                                       │
│                                                                                                  │
│ [k] Keep (default)   [u] Undo   [c] Comment (Ask to chunk)   [f] Full View                       │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
```