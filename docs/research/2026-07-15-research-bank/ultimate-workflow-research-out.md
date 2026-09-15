Here is the structured research report on high-performing agent-file/workflow setups based on current ecosystem practices:

### 1. Per-Source Findings

**Source: `obra/superpowers` (Jesse Vincent's Framework)**
*   **URL:** [github.com/obra/superpowers](https://github.com/obra/superpowers)
*   **Content & Mechanisms:** Acts as a "process layer" that prevents "vibe coding." Enforces a strict 7-step workflow: Brainstorming (asking clarifying questions), Git Worktrees (isolated branches), Writing Plans (breaking tasks into 2-5 min chunks), Subagent-Driven Dev (spawning fresh agents per task), strict TDD (RED-GREEN-REFACTOR), two-stage Code Review (spec compliance then code quality), and Clean Completion.
*   **Working-Together:** Utilizes "Composable Skills" inside a `.claude/skills/` directory. The agent is trained to trigger specific instruction sets based on the task, keeping the main context lean.

**Source: `awesome-claude-code` & `CLAUDE.md` Community Standards**
*   **URL:** [github.com/hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code)
*   **Content & Anti-Patterns:** The community has converged on strict length limits for `CLAUDE.md` (under 150–200 lines). Bloated files cause the LLM to lose focus. Practitioners apply the "Removal Test": if deleting a line doesn't cause the model to make mistakes, cut it.
*   **Anti-Patterns:** Removing generic "write clean code" personas, standard language docs, and dynamic context (e.g., daily logs). Instructions must be project-specific hard constraints.

**Source: `AGENTS.md` Standard & Multi-Agent Orchestration**
*   **URL:** [agents.md specification proposals](https://github.com/builderio/agents.md)
*   **Working-Together:** `AGENTS.md` is emerging as the cross-tool standard (Claude, Cursor, Copilot) to ensure all agents share the same "rules of the road."
*   **Content:** High-performing setups use it as a "map, not a tutorial"—pointing to specific `docs/` files rather than embedding large text blocks. Includes explicit exact-s
<truncated 2260 bytes>
 the context window; they belong in a volatile memory layer).
2. **Generic Personas / Boilerplate:** No "You are an expert 10x Google developer..." or "Write clean, modular code." The community considers this useless token bloat.
3. **Embedded Heavy Documentation:** No full API references or massive tutorials. The file must stay under 200 lines.
4. **Redundant Linter Rules:** Do not write prose rules for things the existing codebase linters already automatically enforce.
5. **Duplicated Tool Definitions:** Do not manually document CLI tools or agent framework tools if the framework already automatically injects tool schemas into the system prompt.

#### Recommended Working-Together Layer Design:
*   **Hub-and-Spoke Architecture:** Use Claude (best at reasoning) as the Architect/Orchestrator to break tasks into 2-5 minute chunks. Dispatch Codex/Gemini as Subagents/Workers to execute isolated file changes.
*   **Two-Stage Review Gates:** Before a Subagent merges its work, a Validator agent must run a two-pass check: (1) Does it meet the specific plan requirements? (2) Does it pass the strict testing/quality constraints?
*   **Shared Standard (`AGENTS.md`):** Use a single global `AGENTS.md` file at the project root as the source of truth, avoiding fragmented `CLAUDE.md` or `GEMINI.md` files that could drift out of sync.

#### The "Keep-Your-Own vs Adopt-Defaults" Choice:
*   **Finding (UNVERIFIED):** I could not verify any existing agent CLI that offers a graceful, automated "first-run merge wizard" for existing instruction files. The current community standard is simply manual symlinking (e.g., `ln -s AGENTS.md CLAUDE.md`) or completely overwriting.
*   **Recommendation / Open Question:** zer0 should offer a namespaced merge. If a user brings their own `CLAUDE.md`, zer0 should wrap it in a `# User Rules` block, while appending a protected `# zer0 Orchestration Defaults` block that enforces the multi-agent handoff protocols. *Decision needed: Do we silently merge, or force the user to interactively accept the diff?*