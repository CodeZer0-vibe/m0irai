# Vibecoder Needs Research — Multi-Agent Terminal Experience (2026-06-28)

Six independent research passes (claude/web ×3, codex, gemini ×2, + 3 deep researcher agents on Reddit, HN/blogs, competitors). Synthesis below. **Confidence:** HN/blogs + competitor landscape = primary-ish (HN threads, named-practitioner blogs, GitHub). Reddit was **access-blocked** → secondary aggregations (well-triangulated; the 93%-approval figure is Anthropic's own data). codex/gemini knowledge passes converged with the web data.

## The 6 convergent truths (every source agreed — high confidence)

1. **Usage limits / cost is the #1 pain — AND the reason multi-agent exists.** "One complex prompt burns 50–70% of your 5-hour limit" (388 upvotes). "$20 Codex ≈ $200 Claude Max in throughput." Microsoft cancelled Claude Code over $500–2,000/mo/engineer. **Devs add a 2nd/3rd agent primarily to route around caps/cost**, not for fun.
2. **The bottleneck is REVIEW/verification, not generation.** Addy Osmani: "The bottleneck is no longer generation. It's verification." Practical agent count = **3–8**, limited by _human review bandwidth_, not tech.
3. **No shared memory across agents** — re-explaining, copy-paste between tools, "fragmented context." Worktree tools deliberately _isolate_ and lose shared state. No terminal cockpit pools it.
4. **Can't track what each agent did** — parallel runs are "hard to track"; agents "step on each other" (duplicate fixes, lost designs, merge conflicts).
5. **Per-action approval = FATIGUE.** Anthropic's own data: **users approve 93% of permission prompts** → fatigue → people reach for `--dangerously-skip-permissions` ("yolo"). The want is **artifact-first review**, not gating each action.
6. **Cross-model build→review is the highest-confidence winning pattern.** "Claude plans, Codex implements, Claude reviews" (19 documented variations). "Never validate your own code in the same context window." Directly validates zer0's cross-family review topology.

## THE KEY REFRAME (shapes the whole product)

**Per-action approval is a trap** (93% approve → fatigue → yolo). The winning review UX is **ARTIFACT-FIRST**: agents run on **auto**; the human reviews the **diff + tests + "what changed"** _after_. This (a) **validates the operator's "leave all 3 on auto" decision**, and (b) **reframes the review build** from "approve each action" (Phase 3 per-action gate) to "review the output" (diff/artifact review). Build the review of _results_, not the gating of _actions_.

## zer0's position — 3 of 4 white-space gaps already WON

The competitive field (Claude Squad, Conductor, Crystal/Nimbalyst, Vibe Kanban, Superset) converged on ONE recipe: _N agents in isolated worktrees, managed like a fleet/kanban, review diffs_ — **parallelism**. That's table stakes. zer0's axis is **integration depth** ("one AI of three", shared brain), landing in the unfilled white space:

| White-space gap (no tool nails)               | zer0                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| Shared cross-agent memory                     | ✅ shared brain                                                            |
| Unified usage/cost across agents              | ✅ usage status bar (context%/5h/weekly)                                   |
| Cross-platform / **Windows**-native           | ✅ ConPTY/Ink — rivals are **macOS-only** (Conductor = Apple-Silicon only) |
| **Review/merge bottleneck** (the #1 unsolved) | ❌ **the gap to build**                                                    |

Also already shipped + validated by the research: `@all` broadcast/multicast, cross-family build→review, session resume, worktree isolation, ACP-native (skills firing + live streaming — deeper than competitors who just launch the CLI in a pane; Claude Squad has **no diff viewer**).

## Prioritized UI/UX roadmap (build order)

1. **DIFF / ARTIFACT REVIEW [highest]** — the universal #1 unsolved pain. Per task/agent: the diff, tests run, "what changed", a lazygit-style keyboard review. Keep agents on auto; review the _output_. This is where Conductor (GUI) beats everyone and the terminal tools (Claude Squad) have nothing.
2. **Surface the moat** — make the shared brain + unified usage **visible/obvious**. They're the differentiation; don't bury them.
3. **Cross-provider failover / cost-aware routing** — Claude caps mid-task → auto-route to Codex/Gemini. The usage data already exists in zer0.
4. **Per-agent "what did it do" log + at-a-glance status** (green=working / yellow=waiting / red=needs-you) — the tracking pain.
5. **Attention-only notifications** (approval-needed / test-failed / done / blocked).

## Other recurring desires (lower priority / already-have)

Broadcast/multicast prompts (`@backend @frontend update X`) — zer0 has `@all`. Session persistence + "what changed since I left." Context that survives compaction. Typed inter-agent handoff. Worktree auto-cleanup. Notifications/hooks. AGENTS.md as the de-facto cross-tool config standard.

## Per-agent reputation (for routing/labels)

- **Claude** — frontend/UI/DX, plan mode, subagents/hooks, complex multi-file refactor; cleaner output (rated cleaner 67% vs Codex 25%); but burns limits 3–4× faster.
- **Codex** — backend/refactor/large-codebase, cheap ($15 vs $155 refactor), best PR reviewer; but "destructive with file ops" horror stories.
- **Gemini/agy** — the weak third chair; "gets tired", "gets stuck cycling"; draw = generous quota as an overflow lane, not lead quality.
