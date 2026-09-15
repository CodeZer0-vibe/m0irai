# Terminal Experience & Design — Research Round 2 Synthesis (2026-06-29)

**Method.** Five independent research streams, three models, no cross-contamination (each formed its view blind to the others):

- **codex** — independent pass, sourced (Anthropic, Gemini CLI, Zed ACP, lazygit/k9s/btop, NN/g, WCAG, Julia Evans).
- **gemini (agy)** — independent pass.
- **claude ×3 (live web):** `users` (workflows/desires/quotes), `design` (TUI craft), `compete` (competitor + diff-TUI teardown).

Raw reports: `docs/research/raw/2026-06-29-{codex,gemini,users,design,compete}.md`. This doc is the distilled, decision-oriented synthesis that feeds the spec revision.

Confidence convention: **CONVERGED (n/5)** = how many independent streams landed on it. Cross-model convergence (codex+gemini agreeing blind) is the highest-confidence signal available.

---

## 1. CONVERGED — build it (high confidence)

These are not opinions; they are where independent streams collided.

1. **One chronological block-stream — NOT side-by-side panes, NOT tabs.** (5/5) Three columns in an 80–120 col Windows terminal collapse to ~30–40 cols each → code/diffs wrap to garbage = the "three cramped windows" failure. Tabs hide concurrency. The answer is a single interleaved timeline of typed blocks (Warp's "BlockList": each block is a self-contained typed unit that only needs to report its height). **This independently re-derives the "Anchored Gutter."**

2. **Attribution = colored left RAIL + named HEADER line, redundantly.** (codex, design explicit) The rail is a continuous vertical color bar spanning the block's full height — binds arbitrarily long text to one owner at zero per-line cost, survives word-wrap. The header (`sigil · name · phase · elapsed · files · quota`) is "the contract." Add a faint first-line sigil for copy-safety. Three redundant channels (color + words + glyph) → attribution survives colorblindness, transparent backgrounds, and monochrome copy-paste.

3. **Body text = ONE high-contrast neutral; color is ACCENT ONLY (rail/header/status), never prose.** (codex, design explicit) Over a transparent/unknown background you cannot guarantee contrast for colored text, so body stays in the terminal's own guaranteed foreground; any colored element that must carry meaning gets its own **opaque cell background** (filled rail cell, status pill) so contrast is controlled locally. This is our INV-7, sharpened — and it is the real fix for the "ghosting/unreadable" failure. Never color-alone (WCAG 1.4.1; ~1-in-8 men have red-green CVD); 60-30-10 discipline.

4. **Streams are secondary instrumentation; ARTIFACTS are primary.** (codex, gemini strong; design nuanced) codex: _"live agent streams are secondary instrumentation; completed deltas, blockers, risks, diffs are primary."_ gemini: _"you don't watch CI compile every line — you watch a spinner and read logs only when it fails."_ The headline of a finished turn is the **result** (answer / diff / outcome), with the raw stream/reasoning **folded underneath**. See §2 for how this reconciles with "feels alive."

5. **Review is the HERO surface, post-hoc, lazygit-keyboard.** (5/5) Post-hoc artifact review beats per-action gating — per-action tools (Cline, Roo) lose users to "YOLO mode" and shut down; Anthropic's own data shows 93% of permission prompts are approved (= rubber-stamp fatigue). Validates "all 3 on auto + review after." The review surface is currently _under-specified_ in our spec and must become the centerpiece. **Best-in-class composite to copy:** lazygit keymap (`j/k` move, `Enter` dive file→hunk→line, `Space` stage, `Tab` panel) + Zed AgentDiffPane (multi-buffer accept/reject per hunk) + **difftastic structural diff** (ignores formatting-only churn — critical because agents reformat aggressively) + Vibe-Kanban **approve-with-comment that redirects the agent mid-task** + Cline/Aider one-keystroke checkpoint rollback. No single tool ships this composite — it is assembled white space.

6. **Per-agent independence — a busy lane NEVER blocks the composer.** (5/5) Long task on one agent → it daemonizes to an ambient lane; you keep working the free agents. Pulses for attention when it needs you; hotkey to jump in. Lane lifecycle: `idle → queued → planning → waiting-approval → editing → testing → reviewing → complete → blocked`. **This is our INV-0, independently demanded by every stream.**

7. **Fold long output; fold ON COMPLETION (not mid-stream); NEVER silently truncate.** (design explicit, codex, gemini) 3 rungs: collapsed (summary + `▸ ±42 lines in reconcile.ts`) → peek (first N lines on focus) → expanded (full, delta-rendered). Folds keep rail + header (attribution survives folding). Silent truncation _is_ the queued-invisible / no-scroll bug — a fold must always advertise "+N lines."

8. **Usage/quota is first-class ambient telemetry (btop-style).** (codex, gemini, users) Always visible, never dominant until it matters. Add **estimated burn before dispatch** + live burn during. The community is duct-taping this together with ~8–16 third-party tools (caut, tokscale, Quotio, CodexBar) — Quotio's tagline is literally _"Stop juggling AI accounts."_ Demand validation, not speculation.

9. **Notifications: two-tier, session-tagged, suppressed-while-watching.** (codex, users 3 independent essays + 2 GitHub issues) "I need you now" (blocked / approval) = loud, pull-back; "lane done" = quiet, catch-on-glance. Every alert tagged by agent + repo + event. Stay **silent while the operator is actively reading that lane** ("notify only when I'm not already looking"). Maps cleanly to the operator's transparent-terminal habit.

10. **Role routing by default; agent-name as override.** (codex, gemini, users) Default verbs: `build / review / test / research / debate`. `@all` should ask intent (debate vs parallel vs review) rather than forcing manual choreography; `@free` → any idle/cheap lane. Task-class routing ("Claude plans, Codex implements, Gemini holds whole-repo context") is the documented real-world pattern.

11. **Cross-review — "nobody grades their own homework" — as a one-keystroke primitive.** (users #1, codex, compete) The single most-sworn-by workflow in the wild (build with A → B tears the diff apart cold). This is zer0's existing Gate Topology; the market independently arrived at the same rule. Make it one keystroke, not a manual dance.

12. **Preserve dissent / team-synthesis blocks.** (codex, design) When agents converge, emit a neutral synthesis block (owned by the team, not one agent). When they disagree, _show the disagreement_ — never flatten three opinions into false consensus. "One mission, three lanes, one verdict — with receipts."

---

## 2. The one real tension — and its resolution

**"Feels alive" (stream) vs "CI dashboard" (suppress).**

- gemini + codex: suppress raw token streams; show spinner + result.
- **users (primary-sourced, the counterweight):** "feels alive" streaming is a _genuine product requirement_ — a practitioner abandoned a batch tool specifically because it didn't stream ("text build up in realtime… to feel the agent is alive"); the psychology: _"we anthropomorphize agents only because response time is slow enough to wait"_ — streaming cadence keeps the operator engaged vs. walking away.

**Resolution (reconciles all 5 on two axes — TIME and FOCUS):**

- **TIME:** stream the live tail _while working_; on completion, auto-fold the process into a clean result-card. Alive during, clean after.
- **FOCUS:** the **focused/active lane streams** its live tail (alive); **background lanes show compact status** (calm, CI-like). You get aliveness where your attention is and calm everywhere else.
- **Default = bounded live tail** (last ~N lines) of the one active block per lane, rest folded. design's `<Static>`-commit model implements exactly this: committed blocks are write-once; only the live tail + roster + composer re-render.

**→ The genuine product choice left for the operator:** the _default verbosity_ — lean alive (stream visibly by default) or lean calm (spinner + result, expand for stream)? Recommendation: **alive-when-focused, calm-in-background.** One decision, not a fork in the architecture.

---

## 3. New requirements our current spec lacks (fold into the revision)

- **Review surface promoted to hero** — the §1.5 composite (lazygit + Zed per-hunk + difftastic + approve-with-comment-redirect + cheap-undo). Our spec treats `^R` as a viewport; it must be the centerpiece, and **redirect-capable** (free white space — only Vibe Kanban's sunsetting web UI does it).
- **`<Static>`-commit render model** — the ROOT-CAUSE fix for the corruption bug: redrawing the whole scrollback every frame is what corrupts ConPTY. Commit finished blocks to Ink `<Static>` (never repainted); only live tail + roster + composer are dynamic. This _is_ our skeptic's B2 (block-windowing) with a named mechanism.
- **Warp BlockList as the data model** — typed blocks (Claude turn / Codex turn / tool-call / diff / system notice) in one stream, each reporting its own height. Directly serves skeptic B1 (Turn SSOT) + B2.
- **Role routing layer** (`build/review/test/research/debate` + `@free` + `@all`-asks-intent).
- **Notification severity engine** (two-tier, session-tagged, suppress-while-watching).
- **Quota estimate before dispatch** (not just live usage).
- **Ambient roster strip** that speaks as a team: `3 agents · 2 streaming · 1 awaiting approval`, each with sigil + state + activity sparkline (btop Braille) + usage%. Brightness-gradient recency (active bright, idle dim — "teammates on the bench").
- **Cross-agent reply-threading** (`↳ re: claude`) so it reads as collaborators, not parallel monologues.

---

## 4. Competitive position — the moats are validated (and being chased)

- **Windows-native team-cockpit = uncontested.** Claude Code's _own_ "Agent Teams" — the first-party version of this concept — **cannot render in Windows Terminal** (split-pane unsupported; bug #23615: pane spawn _"breaks the user's layout and causes command corruption"_); needs WSL2+tmux. Conductor / Superset / Sculptor = Mac. Claude Squad = tmux. Crystal and Roo Code **shut down** early 2026. The only Windows-native rival is **Warp** — a heavyweight terminal _replacement_ with cloud-locked memory. zer0's wedge: _local_ shared brain, don't replace the terminal, 3 co-equal agents.
- **Local pooled cross-agent memory = near-virgin.** Only Warp pools, cloud-bound. Everyone else is isolation-first (Zed states it outright). Competitors structurally can't copy this without abandoning worktree orthodoxy. Anthropic's own feature request #38536 calls cross-agent context loss _"the single biggest efficiency bottleneck for teams adopting Claude Code seriously."_
- **Unified subscription-capacity meter across all 3 = nobody has it.** (Community builds ~8–16 separate tools for it.)
- **Urgency signal:** `cmux` is openly building "Claude teammates as native panes to escape tmux." The gap is real and being chased — ship the moats _visibly_.

---

## 5. Contrarian findings — design honestly against these

1. **METR RCT: experienced devs were 19% SLOWER with AI on repos they knew well — while believing they were ~20% faster.** The perception/reality gap is the danger. → The cockpit must surface **honest throughput** and protect **review depth**, not vanity agent-count.
2. **More agents past ~3–5 is a trap; the human reviewer is the ceiling.** "Context switching between more than 2 threads… is untenable if you want to really review code in depth." → Build for **3 agents deep + a great review surface**, not 10 shallow lanes.
3. **Users want MORE friction — if the AI imposes it.** Forced specs/acceptance-criteria are welcomed from an agent, resented as human ceremony. → The cockpit can "smuggle in" rigor (plan approval, spec templates, cross-review) that teams would otherwise reject.
4. **The safety mechanism is the unsafe part** (93% reflexive approval). → Fewer, smarter prompts (classifier-gated), not prompt-on-everything. Validates auto-default + dormant per-action seam.
5. **Gemini is the wobbliest leg** (forced agy migration seen as "a step backward"; not open-source; no ACP yet — #31). Its durable edge is the **1M-token context window**. → Lean on Gemini for whole-repo context / research, not as the reliability anchor or a co-equal builder by default.

---

## 6. How the design evolves (the "Anchored Gutter," refined)

The direction is _confirmed from five angles_. The refinements:

- The rail + header + neutral-body + fold + pinned-composer + ambient-usage skeleton stands.
- **The unit changes:** from "a streaming reply block" → "a **result-card** (answer/diff/outcome) with the live stream foldable underneath." Alive while working (focused lane), clean card when done.
- **Review becomes the hero,** not a side viewport — the §1.5 composite, redirect-capable.
- **The roster strip** becomes a first-class team-status region (sparklines, states, usage, recency-brightness).
- **Routing + notifications + cross-review + dissent-preservation** become named layers.
- **Render model:** Warp-BlockList data model + Ink `<Static>` commit = the buildable answer to skeptic B1/B2 and the corruption bug.

**Next:** fold §1–§6 into the spec revision (resolving the skeptic's 5 BLOCKs with these mechanisms) → re-run the L-1 skeptic to 0 BLOCK → write-plan → codex review → mega-build.

---

## Key sources (full URLs + verbatim quotes in the raw reports)

Anthropic auto-mode (93% / approval fatigue); METR RCT (19% slower); GitHub anthropics/claude-code #38536 (team memory), #23615 (Windows pane corruption), #36850 (approval BEL); Addy Osmani (orchestra model); Simon Willison (review bottleneck); Warp block-model + multi-harness; Zed agent-panel/ACP; lazygit, gitui, delta, difftastic, btop, k9s, Zellij, tmux #2540, neovim foldcolumn; NN/g (common region, progressive disclosure); Tufte data-ink; WCAG 1.4.1/1.4.3; dev.to/rapls + dev.to/elophanto (real combo workflows); HN 45110075 / 45489884 / 46368739.
