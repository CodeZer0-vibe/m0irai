# Per-Product Findings on Expert Modes

### Vibe-Coder Products
*   **Lovable**: Utilizes distinct modes including Default Mode, Chat Mode (for planning/debugging without generating code), Visual Editor, Code Mode, and Agent Mode. The UX "fast path" is a "Select & Edit" feature allowing users to click UI elements to target them visually. [Source](https://azumo.com/) | [Source](https://lovable.dev/)
*   **Bolt.new**: Uses a split-view interface with Plan Mode (discussion/brainstorming) and Build Mode (code generation). Their fast-path equivalent is the "Inspector Tool" that lets users click directly on the live preview to apply changes. [Source](https://bolt.new/) | [Source](https://nocode.mba/)
*   **v0.dev**: Avoids traditional CLI slash commands in favor of natural language. Exposes Design Mode (visual click-to-edit) and Code View. [Source](https://v0.app/) | [Source](https://medium.com/)
*   **Replit Agent**: Features a Plan Mode for scaffolding task lists without writing code. Execution is managed via an Agent dropdown selecting between Lite, Economy, and Power modes based on required reasoning depth. [Source](https://replit.com/)

### AI Code Review / Audit Products
*   **CodeRabbit**: Features CLI modes such as Plain Mode, Agent Mode (`--agent` which outputs JSON for other AI agents to consume), and Light Mode. Invoked mid-conversation in PRs via `@coderabbitai` (e.g., `@coderabbitai autofix`). [Source](https://coderabbit.ai/)
*   **Cursor Bugbot**: An automated PR reviewer that bridges the gap to the IDE by providing a "Fix in Cursor" button directly in GitHub comments. Project rules are customized via a `.cursor/BUGBOT.md` file. [Source](https://cursor.com/) | [Source](https://trunk.io/)
*   **Snyk (DeepCode AI)**: Operates as an inline "scan as you type" copilot. It provides "Snyk Agent Fix" for one-click inline patches and visualizes data flow from source to sink. *[UNVERIFIED: Direct source URL missing from search synthesis]*
*   **Semgrep Assistant**: Focuses on transparency by showing the underlying 
<truncated 2015 bytes>
ke `/`, non-coders prefer auto-suggest chips or visual buttons. Use slash commands only for utility actions (e.g., `/clear`, `/usage`).

### (c) Content-Depth Bar Per Config Class
*   **Plan / Research:** The bar here is strict isolation. It must generate step-by-step task lists and architecture plans *without* executing any code changes (matching Bolt and Replit's Plan modes).
*   **Review / Security:** Must exceed shallow linting. The bar is data-flow analysis (explaining the "why" from source to sink like Snyk) and providing structured JSON or step-by-step remediation (like Semgrep or CodeRabbit Agent mode).
*   **Debug:** Must bridge the gap between the error and the IDE. The bar is tracing the root cause across the stack and offering actionable fixes, rather than just explaining the error message.

### (d) Trust-UX Patterns to Adopt
*   **"Fix in Editor" Buttons:** Do not just output markdown code blocks. Adopt Cursor Bugbot's pattern of providing a one-click button to apply the suggested fix directly into the user's workspace.
*   **Visual Evidence:** Non-coders need to see the "why". Generate visual diagrams (like CodeRabbit) or step-by-step data flow maps to explain security or logic flaws.
*   **Plain English Severity:** Use clear impact-based language (e.g., "Users cannot log in") rather than technical jargon (e.g., "Null reference exception"). 

### (e) Refuse-List (What NOT to copy)
*   **Do NOT require markdown configuration files for non-coders:** Expecting a non-coder to write a `.cursor/BUGBOT.md` or `.chatmode.md` file is an anti-pattern. Wrap custom instructions in a friendly GUI form.
*   **Do NOT auto-apply destructive changes:** Never let an agent commit or overwrite code without an explicit diff approval view (standard in JetBrains and Cursor).
*   **Do NOT spam with trivial lints:** Avoid "false-positive fatigue" (a major complaint with early automated reviewers). If an issue isn't critical (P0/P1), it should be hidden under a collapsible "Nit" section or omitted entirely to maintain trust.