# Cross-Agent Context Architecture — Locked Design (2026-06-29)

**Method.** Three independent streams stress-testing a proposed 3-layer design: **codex** + **gemini** (independent second opinions, web-sourced) + **native-continuity** (claude grounding of zer0's actual code, file:line). Raw: `docs/research/raw/2026-06-29-native-{arch-codex,arch-gemini,continuity}.md`. This refines the shared-agent layer of `2026-06-29-memory-engine-synthesis.md` — same evidence-ledger spine.

---

## 1. Grounded reality — what zer0 does TODAY (file:line verified)

- **Default (ACP on): claude + codex are stateless cold-starts.** Each turn spawns a fresh child, sends ONE prompt, and **kills it** (`acp-turn.ts:113`). No session pool/reuse. Continuity = an **8-message** transcript window injected into the prompt (`headless-prompt.ts`, `MAX_HISTORY_MESSAGES=8`) — _not_ 20 (the 20-window `buildPrompt` is debate/CLI-only). So claude/codex are **amnesiac beyond 8 messages**, with no native tool/memory state.
- **gemini uses native memory:** `--conversation <id>` resumes agy's brain from turn 2 (id stored at `.council/runs/<id>/.agy-conversation`). The 8-msg injection is then redundant re-feed.
- **No progress files:** `HANDOFF-CHAT.md` / `writeHandoff` is **dead code** (test-only). zer0 writes transcript/prompt/response files + a SQLite evidence DB, but **no curated PROGRESS/DECISIONS/TASK**.
- **Evidence captured per turn:** dispatch rows (prompt/output/stderr hashes, duration, exit, tokens, **HEAD commit SHA**) — but **NO git diff or test results captured.** Half the foundation for evidence-backed truth exists.

→ Confirms the operator's worry, worse than framed: the cliff is **8**, and on the default path we use **none** of claude/codex's native memory.

## 2. The convergent verdict + the correction (codex's masterstroke)

All three agree the 3-layer shape is right, **but native sessions must NOT be the source of truth.** The fix is a **trust boundary** — three roles, never conflated:

| Role                                       | Medium                                                       | Authority                                                               |
| ------------------------------------------ | ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| **Reasoning continuity**                   | native agent session (ACP / agy `--conversation`)            | private, lossy, **rot-prone — NOT authoritative**; task-scoped, rotated |
| **Shared interface** (human + agent reads) | Markdown `PROGRESS.md` / `DECISIONS.md` / `TASK.md`          | **generated from truth**, not authored by agents                        |
| **Canonical truth**                        | append-only **SQLite evidence ledger** (`.zer0/evidence.db`) | single-writer; **zer0 commits**; project-local                          |

**The invariant (codex):** _"Agents may propose truth; zer0 commits truth."_
**The trap everyone hits (codex):** _"confusing 'the agent remembers' with 'the system knows.'"_ Native memory is private/lossy; a Markdown file is corruptible text; only the evidence ledger is authoritative. The moat is **knowing what is verified, current, scoped, and safe to inject** — not longer memory.

## 3. Native sessions — persistent or stateless? RESOLVED

- ACP **does** support persistent sessions (`session/new|prompt|load|resume`; resume skips replay) → "one session per agent" is feasible (real adapters `@agentclientprotocol/claude-agent-acp`, `codex-acp`).
- But **eternal session = context rot** (gemini: attention dilution, "lost in the middle"; _"treating a large context window as infinite memory is the fatal flaw"_). And **stateless-every-turn = today's bug** (grounding).
- **Answer (codex middle path):** keep a native session **for the span of an active task**, **rotate at boundaries** (task switch/completion, context degradation, instruction-file change, adapter upgrade, resume failure), and **never treat it as the record.** Rehydrate a fresh session from a **compact verified snapshot**, not a full transcript replay.
- **Gotchas to engineer:** probe adapter `initialize` capabilities at runtime (variance is real; codex-acp edge reports → smoke-test per adapter); **planted-token resume smoke test**; reattach cwd/MCP roots/permissions/config on resume; **agy semantics are drift-prone** (Gemini→Antigravity transition) → store agy ids in zer0's registry + verify on startup. zer0's own `docs/architecture/2026-06-28-acp-turn-transport.md` already documents the Stop-hooks-hang hazard (clean `CLAUDE_CONFIG_DIR`).

## 4. What zer0 injects every turn (the curated snapshot — replaces the 8-msg scrap)

_"Inject the minimum current operational truth, not the whole conversation"_ (codex):

- **Every turn:** current TASK block, file ownership, open questions, **latest VERIFIED facts**, changed-files summary.
- **After resume / compaction warning:** checkpoint summary + evidence refs (explicit re-grounding).
- **Before review:** exact diff/test evidence — _not_ chat history.
- **Cross-agent work:** peer outputs + shared snapshot hash — _not_ each peer's full transcript.

## 5. Anti-hallucination — HARDENED

- Agents **append claims / memory candidates**; they **never write canonical progress directly.**
- zer0 records **machine-observed facts:** git diff, command output, exit codes, file hashes, test/typecheck results, commit IDs, timestamps.
- A **single conductor** promotes facts → canonical task state. Shared Markdown is **regenerated from canonical state** or updated only via **section-locked patches**.
- **"Done" requires evidence, not prose.** Contradictions are **represented, not overwritten.**
- **Evidence priority order:** (1) operator instruction (2) current filesystem / git diff / command result (3) test/typecheck result (4) persisted ledger artifact (5) cross-agent agreement (6) single-agent claim.
- **Status model:** `planned → changed → verified → blocked` (verification-gated).

## 6. Failure modes → prevention (condensed from codex)

Stale plan in session → rotate at task boundary + inject verified snapshot · adapter resume variance → capability probe + planted-token smoke test · agent corrupts file → propose-not-write + conductor commits · "done" divergence → verification-gated status · cross-project contamination → project-local `.zer0` DB + stable project id · prompt injection via memory → render as untrusted context w/ provenance, never instruction · long session slow/confused → context-budget telemetry + forced checkpoint + fresh session · app crash loses ACP child → persist native session ids + snapshot ids each turn · stale tests → evidence expires when relevant files change · 3-agent write race → single-writer queue + append-only + immutable per-round snapshot.

## 7. The locked architecture — "Session Native + Evidence Canonical"

1. **Native sessions** (claude/codex ACP, gemini `--conversation`) reused within the active task; rotated at boundaries; rehydrated from a verified snapshot.
2. **zer0 session registry:** maps zer0-session → agent → native-session/conversation id; records adapter version, cwd, MCP roots, config hash, instruction hash, last resume check.
3. **`.zer0/evidence.db` = canonical:** append-only events (prompts, outputs, file changes, command results, approvals, reviews, verification); single-writer queue; WAL + busy-timeout; project-local.
4. **Generated shared files:** PROGRESS (task · changed files · verified status · next), DECISIONS (accepted decisions + rationale + evidence refs), TASK (goal · owned files · constraints · open questions).
5. **Immutable per-turn snapshot** given identically to every agent in a round (no mid-round mutation).
6. **Propose-don't-write:** agents emit `memory_candidates`; promote only when operator-pinned, command/test/file-evidenced, or corroborated.

## 8. This UNIFIES with the memory-engine synthesis

The evidence ledger here is the **same spine** as the long-term memory engine. The live shared brain (this doc) and durable cross-session/project memory (`2026-06-29-memory-engine-synthesis.md`) are **one architecture**: append-only evidence ledger → curated projections → propose/promote with provenance → project-scoped isolation. Build once, serve both.

## 9. MVP (revised, decisive — the high-value/low-risk cut)

The biggest win is NOT persistent ACP sessions (fiddly: capability variance, resume smoke tests, config reattach). It is **replacing the 8-message scrap with a curated, evidence-backed snapshot** — which fixes the cliff immediately, is rot-free, and works with the _existing stateless_ agents:

- **(a) Enrich evidence capture:** per turn, record git diff + test/command results (today only commit SHA + blobs).
- **(b) The curated per-turn snapshot:** TASK + changed-files + verified-facts + open-questions, generated from the ledger, injected to every agent (replaces the 8-msg window).
- **(c) Generated PROGRESS/DECISIONS/TASK files** (zer0 writes from the ledger; agents propose via candidates).
- **(d) Verification-gated "done."**
- **Phase 2:** persistent task-scoped native sessions (ACP `session/resume` + registry + smoke tests); shared-group tier; provenance/bi-temporal claims; confirmable-memory UX.

## 10. Decisions now resolved by the convergence

- **D2 (auto vs confirmable) → ANSWERED:** "agents propose, zer0 commits, operator pins" _is_ the confirmable model. Build that.
- **Native-session question → RESOLVED:** task-scoped, rotated, never the truth.
- **Remaining = D3 MVP scope** → recommend the §9 cut (snapshot + evidence + generated files first; persistent sessions second).

**Next:** fold §1–§10 into the memory/shared-brain **PRD** (code-zero-brainstorm → invariants-first 9-section) → L-1 skeptic → write-plan → codex review → build the §9 MVP.
