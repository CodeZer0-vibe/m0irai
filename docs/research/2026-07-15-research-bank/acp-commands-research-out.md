### RESEARCH SYNTHESIS — Agent Client Protocol (ACP) & Native Slash Commands

Here are the cited answers based on the current Agent Client Protocol spec, available sources, and documentation, followed by the recommended synthesis for the C3a build.

#### 1. THE ACP SPEC
The ACP spec defines a mechanism for agents to advertise slash commands via `available_commands_update` sent within a `session/update` notification. Agents can dynamically add or remove commands during a session.
*   **Invocation:** Clients invoke an advertised command by sending it as part of a regular `session/prompt` request (usually just as text in the prompt).
*   **First-class RPCs:** `session/new` (initializes context, returns `sessionId`), `session/cancel` (aborts current operations mid-response), and an optional `session/set_mode`.
*   **Caveats:** The protocol is actively evolving, meaning certain lifecycle RPCs (like a proposed `session/close` or `session/list`) are still being standardized.
*   **Source:** [agentclientprotocol.com Spec](https://agentclientprotocol.com)

#### 2. claude-code-acp
The adapter (now rebranded as `@agentclientprotocol/claude-agent-acp`) **does** advertise `availableCommands`, including `/compact`.
*   **Detection:** It generally detects a command when the slash command is the first text block in the prompt sent via `session/prompt`.
*   **Parsing Logic:** *UNVERIFIED (exact file:line)* - While the source handles parsing tool results and command strings (e.g., via utilities like `parseTaskCreateOutput`), the exact regex site for bare-text prompt extraction couldn't be definitively pinned locally, though community issues point to regex parsing within `acp-agent.ts` that strips command metadata.
*   **Source:** [agentclientprotocol/claude-agent-acp repository](https://github.com/agentclientprotocol/claude-agent-acp)

#### 3. codex-acp
Yes, `@agentclientprotocol/codex-acp` (v1.1.2) advertises commands and officially supports `/compact`.
*   **Protocol Methods:** There is no explicit inbound `compact` RPC method
<truncated 1807 bytes>
ce the current turn completes.
*   **Rejection/Cancellation:** If the editor needs to immediately stop the agent to execute a command (like memory ops), it must formally issue a `session/cancel` RPC first. Injecting commands asynchronously into a live PTY stream can corrupt the agent's state or prompt buffers.

---

### DELIVER: Synthesis for C3a

Based on the evidence, **real invocation of native CLI slash commands is possible and should be the architectural direction for C3a**.

1.  **Command Discovery:**
    *   **Recommendation:** Deprecate the hardcoded `src/chat/agent-commands/builtin-catalog.ts`. Instead, rely entirely on the `available_commands_update` sent over `session/update` to populate the client's command UI dynamically per agent.
2.  **Invocation Mechanism:**
    *   **ACP Adapters (Claude/Codex):** Commands like `/compact` must bypass `zer0`'s prompt composition wrapper. If a user selects a command, `zer0` should send it as a bare string in a `session/prompt` request, letting the native adapter parse and execute it.
    *   **PTY Adapters (agy/gemini):** Abandon PTY keystroke injection for commands. Instead, dispatch memory ops and commands via the agent's non-interactive flag/IPC surface (e.g., passing `-p "/compact"` to a background or sibling process, or using a dedicated JSON-RPC equivalent if supported).
3.  **Mid-Turn Policy:**
    *   **Recommendation:** `zer0` must enforce strict queuing. If the user invokes a command while the agent is generating, `zer0` should hold the command until the `TurnComplete` event is fired. If the command is urgent (e.g., `/cancel` or `/compact` to save a runaway token context), `zer0` must issue a `session/cancel` RPC to halt generation cleanly before dispatching the new command.
4.  **What's Impossible-Today:**
    *   You cannot safely inject commands into a live PTY stdin buffer without risking state corruption.
    *   You cannot expect standard ACP models to process parallel `session/prompt` requests simultaneously on the same thread without queuing them.