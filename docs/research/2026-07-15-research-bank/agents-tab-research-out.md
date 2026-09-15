**Decision**
Ship **8 built-in configs**, not a large gallery. The strongest default set is: Plan, Research, Build, Debug, Review, Security, UI/UX, Handoff. That covers the actual daily non-coder workflow without baking fixed role lanes into the system.

The tab should present them as **per-message expert modes**, not “agents with jobs.” Copy should say “load this for this message” and each config should start from the user’s task, current repo, and standing files.

**Local Findings**
Spec: [docs/specs/2026-07-14-template-palette.md](C:/Users/mianc/VibeCoding/zer0-agent-ci/docs/specs/2026-07-14-template-palette.md:29) says this is a per-round overlay, file-based, sharp defaults, v1 per-message only. [AGENTS.md](C:/Users/mianc/VibeCoding/zer0-agent-ci/AGENTS.md:13) already forbids fixed job identities, so defaults must not reintroduce “Claude plans, Codex builds” as product law.

v23 files read: `architect`, `builder`, `planner`, `researcher`, `expert`, `skeptic`, `completeness-auditor`, `code-reviewer`, `wiring-auditor`, `security-auditor`, `ui-ux-auditor`, `finding-triage`.

Best reusable patterns:
- [planner.md](C:/Users/mianc/.claude/agents/planner.md:3): excellent trigger conditions, hardest-constraint-first, code-grounded plan.
- [researcher.md](C:/Users/mianc/.claude/agents/researcher.md): excellent source hierarchy and “NOT FOUND beats guessing.”
- [code-reviewer.md](C:/Users/mianc/.claude/agents/code-reviewer.md:44): excellent quote-before-claiming, false-positive discipline, confidence labels.
- `completeness-auditor.md`, `wiring-auditor.md`, `security-auditor.md`, `ui-ux-auditor.md`: excellent because they target common AI failure modes with measurable proof.
- `builder.md`: strong discipline, but over-fitted to BUILD BRIEF, `.council`, JSON reports, and TDD pipeline mechanics. Extract the discipline, not the whole file.
- `skeptic.md` and `finding-triage.md`: useful internally, too pipeline-specific for default non-coder equipment.
- `architect.md`: good, but overlaps with Planner for v1; keep its blast-radius/data-flow concepts inside Plan.

UNVERIFIED: I could not find `ultimate-workflow-research-out.md`; targeted searches in repo, temp, `.council`, `.agents`, `.codex`, Downloads/Desktop/Documents returned no hit or timed out. I cross-checked against the current spec and standing file instead.

**Ecosystem Findings**
Official docs support the split: Anthropic subagents are specialized workers with their own context/tooling, not merely prompt snippets ([Anthropic docs](https://code.claude.com/docs/en/sub-agents)). Codex treats `AGENTS.md`, skills, memories, MCP, and subagents as complementary layers, with `AGENTS.md` kept small and durable ([Codex customization](https://learn.chatgpt.com/docs/customization/overview)). Codex subagent docs explicitly warn subagents spend more tokens and are best for read-heavy parallel work, with care around write-heavy flows ([Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)). Gemini and VS Code both support scoped reusable context/commands, which backs the “curated prompt equipment” model rather than persistent roles ([Gemini context](https://docs.cloud.google.com/gemini/docs/codeassist/use-agentic-chat-pair-programmer), [Gemini slash commands](https://cloud.google.com/blog/topics/developers-practitioners/gemini-cli-custom-slash-commands), [VS Code instructions](https://code.visualstudio.com/docs/agent-customization/custom-instructions)).

Public catalogs are useful for coverage, not defaults. VoltAgent has 154+ Claude subagents across many categories, and wshobson’s marketplace has 203 agents / 175 skills / 109 commands ([VoltAgent](https://github.com/VoltAgent/awesome-claude-code-subagents), [wshobson/agents](https://github.com/wshobson/agents)). That is discovery-scale, not first-run UX. Community signal points to narrow daily tools: code review, CSS/UX, docs, “second opinion,” and context isolation; complaints cluster around too many rules, token burn, and overusing subagents for small projects ([daily-use thread](https://www.reddit.com/r/ClaudeAI/comments/1o6nxh4/if_you_even_slightly_know_what_youre_doing/), [overuse complaint](https://www.reddit.com/r/ClaudeAI/comments/1uhbceu/i_finally_figured_out_when_to_not_let_claude_code/), [Cursor rules overload](https://www.reddit.com/r/cursor/comments/1r6bfdh/i_spent_way_too_long_figuring_out_cursor_rules/), [HN consolidation complaint](https://news.ycombinator.com/item?id=48289950)).

**Recommended Roster**
| Config | Vibe-coder pitch |
| --- | --- |
| Implementation Plan | “Makes the agent map the safest build path before touching code.” |
| Research Pre-Mortem | “Makes the agent verify docs, competitors, and risks before guessing.” |
| Focused Builder | “Makes the agent build exactly the request and prove it works.” |
| Root-Cause Debugger | “Makes the agent find the real cause instead of stacking patches.” |
| Ship-Ready Review | “Makes the agent ruthlessly hunt bugs before shipping.” |
| Security & Trust Audit | “Makes the agent look for real exploit paths and leaked secrets.” |
| UI/UX Product Audit | “Makes the agent judge the app like a real user would.” |
| Handoff Summary | “Makes the agent preserve what changed, what passed, and what is next.” |

**Content Standard**
Each config should be **350-700 words**, plain Markdown plus frontmatter: `title`, `summary`, `tags`, `agents` soft filter, `version`, `source`, `last_verified`.

Every config must contain:
- One-line non-coder promise.
- “Use when / skip when” firing conditions.
- Per-message boundary: does not mutate standing files, memory, or native agent state.
- Evidence contract: what must be read, checked, cited, or run before claiming success.
- Anti-patterns in BAD / DAMAGE / GOOD form.
- Output contract: exact sections expected.
- Stop/refuse conditions.
- `[your task here]` slot.

Do not include native Claude-only fields like `tools`, `model`, or `.council` report paths in built-ins. Those belong to native subagents or internal workflows, not zer0’s per-message overlay.

**Refuse From Ecosystem**
Refuse huge role catalogs as defaults, profession cosplay agents, novelty names, “10x” claims, hidden persistent behavior, tool/model promises zer0 cannot enforce, broad always-on rules, generic “best practices” prompts, framework specialists without project detection, and security reviewers that report theoretical risks without exploit chains.

**Operator Calls**
1. Should `Security & Trust Audit` be visible in the top row or tucked under an Audit tag?
2. Should `Focused Builder` be included at launch, or delayed until the standing-files redesign is sealed?
3. Should built-ins be editable copies only, or should read-only defaults remain visually separate forever?
4. Should advanced configs show developer wording by default, or hide it behind “details”?

Verification: read all 12 v23 files, current template-palette spec, current `AGENTS.md`, and current official/community web references. No code edits or file writes performed.

