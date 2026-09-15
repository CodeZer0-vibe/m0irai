---
scope: product
lastValidated: 2026-06-29
---

# Hard problems of agent memory at scale + what coding-tool users want

Research brief for zer0 chat's memory engine (local-first, 3-agent, multi-session, multi-project terminal cockpit).
Date: 2026-06-29. Method: independent web research (WebSearch + WebFetch). Every factual claim carries a source quote + URL. Synthesis/extrapolation is marked **INFERENCE**.

A note on source tiers: **Primary** = peer-reviewed papers (arXiv/TACL), first-party engineering writing (Anthropic, GitHub), and the actual GitHub issues. **Vendor** = memory-product blogs (mem0, Zep, Letta, Rafter) — authoritative for their own architecture, treat their benchmark numbers as advocacy. **Secondary** = third-party blogs aggregating the above.

---

## Failure modes → mitigations

| #   | Failure mode                                                           | What goes wrong (evidence)                                                                                                                                                                                                                                                                                                                                                                                                        | Mitigations (evidence)                                                                                                                                                                                                                                                                                                    |
| --- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | **Context poisoning**                                                  | A hallucination/error enters context and is then "repeatedly referenced"; the agent becomes "fixated on achieving impossible or irrelevant goals" (Breunig, Gemini 2.5 Pokémon agent).                                                                                                                                                                                                                                            | Quarantine/validate before persist; **just-in-time citation verification** — store memories with code-location citations and re-check them against the live branch before use; store a corrected version when the code contradicts the memory (GitHub Copilot). Provenance + rollback of bad learning (developersdigest). |
| F2  | **Context distraction / context rot**                                  | Past a token threshold the model "over-focuses on the context, neglecting what it learned during training"; repeats past actions instead of forming novel strategy. Onset ~100k tokens (Gemini agent); Databricks saw correctness fall ~32k for Llama 3.1 405b (Breunig). Anthropic: "as the number of tokens in the context window increases, the model's ability to accurately recall information from that context decreases." | Treat context as "a finite resource with diminishing marginal returns"; "find the smallest set of high-signal tokens"; **compaction** (summarize + reinitialize window); **structured note-taking** to memory outside the window; just-in-time retrieval via lightweight identifiers (Anthropic).                         |
| F3  | **Context confusion**                                                  | "Superfluous content in the context is used by the model to generate a low-quality response." Tool overload: "every model performs worse when provided with more than one tool"; a quantized Llama 3.1 8b failed with all 46 tools but succeeded with 19 (Breunig, Berkeley Function-Calling Leaderboard).                                                                                                                        | Retrieve/expose only relevant tools+memories per task; cap injected instruction count — ">50 distinct instructions is a strong warning sign" (aicodex). Salience-ranked retrieval over dump-everything.                                                                                                                   |
| F4  | **Context clash**                                                      | Contradictory info accrued across turns derails reasoning; sharded/contradictory prompts caused "an average drop of 39%", o3 fell "from 98.1 to 64.1"; models "make assumptions in early turns and ... overly rely" on them (Breunig).                                                                                                                                                                                            | Contradiction-aware writes: detect conflict, let latest truth win — mem0 DELETE on contradiction; Zep **bi-temporal** edge validity invalidates (not deletes) superseded facts for temporal reasoning.                                                                                                                    |
| F5  | **Lost in the middle**                                                 | U-shaped recall: performance highest when relevant info is at the very start or end, "significantly degrades when models must access ... the middle"; >30% drop start/end → middle (Liu et al., TACL 2024). Attributed to attention + positional encoding (RoPE decay).                                                                                                                                                           | Rank + place high-salience memory at the head/tail of the assembled context; keep retrieved set small (fewer items → less middle to lose). Newer long-context models partially mitigate for simple factoid recall, not for reasoning.                                                                                     |
| F6  | **Stale / contradictory memory; retrieval surfaces the WRONG context** | The production bar is to "remember the right thing, forget stale things, show where memory came from, and roll back bad learning without poisoning future sessions" — retrieval accuracy alone is insufficient (developersdigest).                                                                                                                                                                                                | mem0 four-op consolidation: **ADD / UPDATE / DELETE / NOOP**, new facts compared to existing by vector similarity, "the latest truth wins"; Zep temporal KG with bi-temporal validity; Copilot just-in-time citation re-validation.                                                                                       |
| F7  | **Cross-project / cross-tenant leakage**                               | Shared embedding space → "user A searching for 'confidential project' might get user B's confidential documents"; a vendor reports "up to 95% of benign RAG queries triggered cross-tenant leakage in a four-tenant corpus due to organic entity connections, not adversarial attacks" (Rafter — vendor). Cardinal rule: "filter before retrieval, never after."                                                                  | Mandatory metadata/namespace filter on every query (tenant_id / project_id) applied **pre-retrieval**; fully-isolated stores for high-sensitivity tenants (cost tradeoff); Copilot scopes memory to a single repo by write/read permission.                                                                               |
| F8  | **Unbounded growth / memory that should have decayed**                 | "Memory footprint grows linearly with conversation length"; incremental memory "may become messy and disorganized over time" (mem0; Letta).                                                                                                                                                                                                                                                                                       | TTL + LRU eviction + periodic pruning (mem0); **sleep-time compute** — idle-time consolidation, rewriting messy blocks, summarizing into stable notes (Letta); tiered memory: core (in-window) / recall / archival (Letta, MemGPT-derived).                                                                               |
| F9  | **Instruction-file drift (CLAUDE.md / AGENTS.md)**                     | "When you update one instruction file and forget the other two, the agent ... reads the stale file, and bugs follow"; concrete case: a DB-migration note updated in CLAUDE.md but not the Cursor file → teammate's agent used the old pattern (dev.to/mudassirworks).                                                                                                                                                             | Single source of truth — one AGENTS.md, others `@`-include or symlink to it; keep instruction count bounded (F3).                                                                                                                                                                                                         |
| F10 | **Compaction data loss**                                               | "Compaction isn't sufficient ... doesn't always pass perfectly clear instructions to the next agent" (Anthropic). Field reports: "roughly 20-30% of original detail is retained"; summaries keep "what happened", lose "why"; a 3-hour session lost the JWT-vs-session decision, token lifetimes, cookie config and "resumed with a completely different approach" (golev; BSWEN).                                                | Durable out-of-band state: progress file + git log handoff — "Read the git logs and progress files to get up to speed"; "End the session by writing a git commit and progress update" (Anthropic long-running-agents). Event-sourced ledger over lossy summary.                                                           |

### Key evidence (exact quotes + numbers, so claims are falsifiable)

**F1–F5 — the four context-failure modes (Drew Breunig, primary aggregation):**

- Poisoning: "When a hallucination or other error makes it into the context, where it is repeatedly referenced." Gemini Pokémon: context "'poisoned' with misinformation about the game state, which can often take a very long time to undo."
- Distraction: "When a context grows so long that the model over-focuses on the context, neglecting what it learned during training." "As the context grew significantly beyond 100k tokens, the agent showed a tendency toward favoring repeating actions." Databricks: "model correctness began to fall around 32k" (Llama 3.1 405b).
- Confusion: "When superfluous content in the context is used by the model to generate a low-quality response." Berkeley FCL: "every model performs worse when provided with more than one tool." Llama 3.1 8b: failed with "all 46 tools", succeeded with "19 tools."
- Clash: "When you accrue new information and tools in your context that conflicts with other information." "an average drop of 39%"; o3 "from 98.1 to 64.1."
- Source: <https://www.dbreunig.com/2025/06/22/how-contexts-fail-and-how-to-fix-them.html>

**Lost in the middle (Liu et al., TACL 2024, primary):** "performance is highest when relevant information occurs at the very beginning (primacy bias) or end of its input context (recency bias) ... significantly degrades when models must access and use information in the middle." Degradation can exceed 30%. Source: <https://arxiv.org/abs/2307.03172>

**Anthropic — context as finite resource / context rot (primary):**

- "Context engineering refers to the set of strategies for curating and maintaining the optimal set of tokens (information) during LLM inference."
- "Context, therefore, must be treated as a finite resource with diminishing marginal returns."
- "context rot: as the number of tokens in the context window increases, the model's ability to accurately recall information from that context decreases."
- "LLMs have an 'attention budget'."
- "Find the smallest set of high-signal tokens that maximize the likelihood of your desired outcome."
- "Compaction is the practice of taking a conversation nearing the context window limit, summarizing its contents, and reinitiating a new context window with the summary."
- "Structured note-taking, or agentic memory, is a technique where the agent regularly writes notes persisted to memory outside of the context window."
- Source: <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>

**Anthropic — long-running agents / handoff (primary):** "each new session begins with no memory of what came before"; initializer writes "an `init.sh` script, a claude-progress.txt file"; ongoing sessions "Read the git logs and progress files to get up to speed"; "compaction ... doesn't always pass perfectly clear instructions to the next agent"; "End the session by writing a git commit and progress update." Source: <https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents>

**mem0 — consolidation ops + decay (vendor; arXiv primary for headline numbers):**

- Ops: "ADD (inserting genuinely new information), UPDATE ..., DELETE (removing memories contradicted by new information), and NOOP." "the latest truth wins." Decay: "LRU policies ... or memory decay", "TTL for stale facts." Source: <https://memo.d.foundation/breakdown/mem0>, <https://docs.mem0.ai/core-concepts/memory-operations/add>
- arXiv abstract (primary): "Mem0 achieves 26% relative improvements in the LLM-as-a-Judge metric over OpenAI"; "Mem0 attains a 91% lower p95 latency and saves more than 90% token cost" vs full-context. Source: <https://arxiv.org/abs/2504.19413>
- mem0 marketing reports a newer token-efficient variant at "92.5 on LoCoMo" and "66.9% versus 52.9%" LLM-as-Judge vs OpenAI — treat as vendor claim. Source: <https://mem0.ai/research>

**Zep — temporal KG (vendor blog + arXiv):** "Zep demonstrates superior performance (94.8% vs 93.4%)" on DMR vs MemGPT; LongMemEval "improvements up to 18.5% in accuracy while also reducing response latency by 90%"; three tiers — "episodic nodes (raw messages), semantic entities and facts (... bi-temporal edge validity), and community summaries"; "P95 latency of 300ms." Source: <https://arxiv.org/abs/2501.13956>, <https://blog.getzep.com/state-of-the-art-agent-memory/>

**Letta — tiers, sleep-time, forgetting (vendor):** "Core Memory — a small block that lives in the context window (like RAM), Recall Memory ... (like a disk cache), and Archival Memory ... (like cold storage)"; sleep-time "uses ... downtime to reorganize information"; "Forgetting to remember requires actively not calling the tools." Source: <https://www.letta.com/blog/memory-blocks/>, <https://www.letta.com/blog/sleep-time-compute/>

**Multi-tenant leakage (vendor + secondary):** "Without metadata filters, search returns most similar vectors from any tenant"; "filter before retrieval, never after, as data from other tenants must never enter memory, even temporarily"; Rafter's "up to 95% of benign RAG queries triggered cross-tenant leakage in a four-tenant corpus." Sources: <https://rafter.so/blog/multi-tenant-ai-agent-isolation>, <https://blaxel.ai/blog/multi-tenant-isolation-ai-agents>

**GitHub Copilot agentic memory (primary):** repo-scoped — "Memories for a given repository can only be created in response to actions taken within that repository by contributors with write permissions, and can only be used in tasks on that same repository ... with read permissions"; "just-in-time verification" validating citations "before using it"; on contradiction "the agent is encouraged to store a corrected version"; result "7% increase in pull request merge rates." Source: <https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/>

---

## What users want from memory (ranked by evidence)

Ranked strongest-evidence-first (primary first-party issues/posts > aggregated developer sentiment > vendor framing).

1. **Memory that survives compaction without losing the "why."** Strongest negative signal. Field reports of "20-30% of original detail" retained; summaries keep "what happened" and lose "why and subtle details"; a concrete 3-hour session lost the JWT-vs-session decision and "resumed with a completely different approach." Developers "treat compaction as an adversary to be managed" and build external "dev docs" systems to recover state. Evidence: golev <https://golev.com/post/claude-saves-tokens-forgets-everything/>; BSWEN <https://docs.bswen.com/blog/2026-02-09-claude-context-loss-compaction/>; resume-when-over-limit bug <https://github.com/anthropics/claude-code/issues/14472>.

2. **A middle memory tier: shared across a subset of projects (not global, not single-project).** Explicit, well-specified feature request. "There is no way to share memory across a subset of related projects. This creates a false choice: either pollute global memory ... or duplicate entries across multiple project directories." Wants a named/namespaced shared scope; examples: shared infra config, team conventions, "Jira project key is SDW", monorepo tool conventions. Evidence: claude-code #39195 <https://github.com/anthropics/claude-code/issues/39195>; also #36561 (global/shared across projects).

3. **Team memory pool + one-action promotion + context that flows on handoff.** Detailed issue from an EM running 14 engineers. "Claude Code's memory system is individual-only ... none of that context transfers at the agent level" — called "the single biggest efficiency bottleneck for teams." Wants: shared pool scoped to team/project/service; **memory promotion** as "one action, not a writing exercise"; context attached to ticket/PR/handoff that "the receiving engineer's Claude picks it up automatically"; role-aware access (EM planning-level vs IC implementation-level); onboarding from "team's accumulated months of context" instead of "blank Claude." Evidence: claude-code #38536 <https://github.com/anthropics/claude-code/issues/38536>. Ecosystem confirms demand: claude-session-memory plugin (auto-capture → promote to knowledge cards → share via git) <https://github.com/teamspwk/claude-session-memory>; claude-mem <https://github.com/thedotmack/claude-mem>.

4. **Agents that learn from corrections and don't repeat them.** "Facts, preferences, and corrections [should] survive across sessions, with agents learning from failures to remember what didn't work so they don't repeat mistakes"; "stop asking questions that have already been answered and stop making mistakes that have already been corrected." Re-explaining "the same architecture, bugs, preferences, and workflow rules every session" is the named pain. Evidence: developersdigest <https://www.developersdigest.tech/blog/agent-memory-benchmarks-not-enough>; mem0 <https://mem0.ai/blog/ai-coding-agents-that-actually-remember-your-codebase>; AddyOsmani self-improving agents <https://addyosmani.com/blog/self-improving-agents/>.

5. **One instruction source of truth, no drift across tools.** "Stop maintaining CLAUDE.md and GEMINI.md separately"; drift causes agents to act on stale conventions. Want one AGENTS.md that all agents read (include/symlink the rest); keep it small (">50 distinct instructions is a strong warning sign"). Evidence: dev.to/mudassirworks <https://dev.to/mudassirworks/one-agentsmd-for-every-coding-agent-stop-maintaining-claudemd-and-geminimd-separately-34g4>; aicodex <https://www.aicodex.to/articles/claude-md-maintenance>.

6. **"What changed since I left" / clean session resume.** First-party pattern: start a session by reading progress notes + git logs, run a smoke test "to catch any undocumented bugs," end by writing a commit + progress update. This is the sanctioned answer to cross-session continuity. Evidence: Anthropic long-running-agents <https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents>.

7. **Trustworthy memory: provenance, contradiction-handling, rollback.** Users won't trust memory that can silently poison future work. The asked-for guarantees: "remember the right thing, forget stale things, show where memory came from, and roll back bad learning." GitHub shipped exactly this shape (citations + just-in-time re-validation + corrected-version-on-contradiction) and measured a statistically significant 7% PR-merge-rate lift — evidence the demand is real and the mitigation pays off. Evidence: developersdigest <https://www.developersdigest.tech/blog/agent-memory-benchmarks-not-enough>; GitHub Copilot <https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/>.

---

## Implications for a multi-project, multi-session local cockpit

**INFERENCE** throughout this section — synthesis of the evidence above applied to zer0 chat (local-first, 3 agents, multi-session, multi-project). Each implication names the failure mode (F#) or demand (D#) it answers.

1. **Three-tier memory scope is the data model, not an afterthought** [answers D2, D3, F7]. The demanded shape is exactly: `global` → `namespace/shared-subset` → `project` → `session`. The "false choice" between global-pollution and per-project-duplication (#39195) is a missing tier, and shared embedding spaces leak across tenants when the namespace isn't a hard pre-retrieval filter (Rafter). Make project/namespace a **mandatory filter applied before retrieval** on every query, not a post-filter. A local-first cockpit has an isolation advantage: one operator, files on disk — leakage risk is cross-_project_ not cross-_customer_, so namespacing can be directory/SQLite-attribute scoping rather than full store isolation.

2. **Persist an event-sourced ledger; treat compaction summaries as lossy derivatives, never the source of truth** [answers F10, D1, D6]. The #1 user pain is compaction discarding the "why." The first-party fix is durable out-of-band artifacts (progress file + git log) that the next session reads. The cockpit already has a shared-brain ledger — keep raw episodic events as canonical and derive summaries on top, so a bad summary is always re-derivable. "What changed since I left" = a diff over the ledger since last session timestamp, not a re-summarization.

3. **Salience-rank and budget what you inject; place the highest-salience memory at head/tail** [answers F2, F3, F5]. Never dump the memory store into context. Retrieve a small high-signal set (mem0 averages <7k tokens/call), and exploit primacy/recency — put the load-bearing facts at the start/end of the assembled context to dodge lost-in-the-middle. Cap injected instruction/tool counts (>50 instructions, >1 tool both measurably degrade). This makes per-agent independence cheaper: each of the 3 agents gets a small task-scoped slice, not the whole brain.

4. **Writes are consolidation, not appends** [answers F4, F6, F8]. On every memory write, run mem0-style ADD/UPDATE/DELETE/NOOP against existing entries so contradictions resolve to latest-truth instead of accumulating clash. Add TTL/decay + idle-time consolidation (Letta sleep-time) so the store doesn't grow unbounded — the cockpit's idle periods between operator turns are the natural window to compact, dedup, and rewrite messy entries. This directly defends against F8 unbounded growth, which a long-lived local cockpit will hit faster than a chat product.

5. **Every memory carries provenance + a verification hook; verify before trust** [answers F1, F7, D7]. Store each fact with its source (file:line, commit, session id) and re-validate against the live repo before injecting — GitHub's just-in-time citation check is the proven antidote to poisoning, and it measurably lifted PR-merge rate. For a coding cockpit this is cheap: the citation is usually a path:line the agent can re-read. On contradiction with current code, write a corrected version rather than trusting the stale memory. This also gives the operator (who cannot code — per project memory) a plain-language "why does the agent believe this, and is it still true" trail.

6. **One instruction source of truth, fanned out per agent — don't maintain 3 drifting files** [answers D5, F9]. With claude/codex/agy in one cockpit, the CLAUDE.md/AGENTS.md/GEMINI.md drift problem is structurally present. Author once, project the per-agent view from a single canonical store (the cockpit already does role-file projection). Keep each agent's injected instruction set small.

7. **Promotion is a first-class one-action verb, scoped by tier** [answers D3]. The team-memory ask reduces, for a single-operator local cockpit, to: promote a session-level discovery up to project, or project up to a shared namespace, in one action — not a writing exercise. The hard part the evidence flags is _what's safe to promote_: only consolidated, provenance-bearing, non-contradicted facts should rise a tier, or promotion becomes a poisoning amplifier (F1 across scopes).

**Net:** the cockpit's hardest memory problems are (a) compaction loss → solve with an event-sourced ledger + derived summaries; (b) cross-project bleed → solve with a mandatory pre-retrieval namespace filter and an explicit shared tier; (c) staleness/poisoning → solve with provenance + just-in-time re-verification + consolidating writes. These three are the load-bearing ones; tiered scope, salience budgeting, decay, and one-action promotion are the supporting machinery.

---

## Sources

Primary:

- Liu et al., "Lost in the Middle" (TACL 2024) — <https://arxiv.org/abs/2307.03172>
- Anthropic, "Effective context engineering for AI agents" — <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
- Anthropic, "Effective harnesses for long-running agents" — <https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents>
- Mem0 paper (ECAI 2025) — <https://arxiv.org/abs/2504.19413>
- Zep: A Temporal Knowledge Graph Architecture for Agent Memory — <https://arxiv.org/abs/2501.13956>
- GitHub, "Building an agentic memory system for GitHub Copilot" — <https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/>
- claude-code #38536 (shared team memory) — <https://github.com/anthropics/claude-code/issues/38536>
- claude-code #39195 (shared-across-subset / middle tier) — <https://github.com/anthropics/claude-code/issues/39195>
- claude-code #36561 (global/shared across projects) — <https://github.com/anthropics/claude-code/issues/36561>
- claude-code #14472 (cannot resume when context exceeds limit) — <https://github.com/anthropics/claude-code/issues/14472>

Vendor (authoritative for own architecture; benchmark numbers = advocacy):

- Drew Breunig, "How Long Contexts Fail" — <https://www.dbreunig.com/2025/06/22/how-contexts-fail-and-how-to-fix-them.html>
- Drew Breunig, "How to Fix Your Context" — <https://www.dbreunig.com/2025/06/26/how-to-fix-your-context.html>
- mem0 research — <https://mem0.ai/research>; ops breakdown — <https://memo.d.foundation/breakdown/mem0>; docs — <https://docs.mem0.ai/core-concepts/memory-operations/add>; coding-agent memory — <https://mem0.ai/blog/ai-coding-agents-that-actually-remember-your-codebase>
- Zep state-of-the-art blog — <https://blog.getzep.com/state-of-the-art-agent-memory/>
- Letta memory blocks — <https://www.letta.com/blog/memory-blocks/>; sleep-time compute — <https://www.letta.com/blog/sleep-time-compute/>
- Rafter, multi-tenant isolation — <https://rafter.so/blog/multi-tenant-ai-agent-isolation>
- Blaxel, multi-tenant isolation — <https://blaxel.ai/blog/multi-tenant-isolation-ai-agents>

Secondary (developer sentiment / aggregation):

- developersdigest, "Agent Memory Benchmarks Are Not Enough" — <https://www.developersdigest.tech/blog/agent-memory-benchmarks-not-enough>
- AddyOsmani, "Self-Improving Coding Agents" — <https://addyosmani.com/blog/self-improving-agents/>
- golev, "Claude Saves Tokens, Forgets Everything" — <https://golev.com/post/claude-saves-tokens-forgets-everything/>
- BSWEN, "Why Claude Loses Context After Compaction" — <https://docs.bswen.com/blog/2026-02-09-claude-context-loss-compaction/>
- dev.to/mudassirworks, "One AGENTS.md for every coding agent" — <https://dev.to/mudassirworks/one-agentsmd-for-every-coding-agent-stop-maintaining-claudemd-and-geminimd-separately-34g4>
- aicodex, "Why your CLAUDE.md stops working" — <https://www.aicodex.to/articles/claude-md-maintenance>
- claude-session-memory plugin — <https://github.com/teamspwk/claude-session-memory>
- claude-mem — <https://github.com/thedotmack/claude-mem>
