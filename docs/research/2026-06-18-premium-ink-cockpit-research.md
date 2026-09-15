# Premium Ink Cockpit — research + custom design (2026-06-18)

**Question (operator):** how is Claude Code's Ink terminal UI made, what options does Ink give, how far
behind is our experience, and — based on that — a custom design for OUR specific setup (a 3-agent cockpit).
**Method:** Context7 (Ink docs, sourced) + web (Claude Code leaked-source teardowns, gemini-cli, the
multi-agent-TUI landscape) + a cross-family research lens from **gemini** (`.council/runs/premium-cockpit-research/gemini-out.md`)

- first-hand knowledge of our `src/tui` cockpit. Claude Code is closed — its internals below are from
  multiple leaked-source analyses (well-corroborated, not official); marked accordingly.

---

## TL;DR — the honest verdict

- **We are AHEAD on the hard part and BEHIND on polish.** No reference product _conducts_ three agents on
  one shared project with per-action approval + shared memory. The multi-agent TUIs that exist (Conduit,
  agent-deck, agentpipe) are **session managers / tabbed REPLs** — N independent agents, not one conducted
  cockpit. The orchestration (routing → waves → council → synthesis → tower approval) is the novel, hard,
  defensible thing, and it's ours.
- **Premise correction (honest):** we are _not_ "the first terminal with 3 agents" — running several agents
  in a terminal is done (tabs). We may be the first to **conduct** three agents as one team on a shared
  brain with per-action approval. That's a stronger, truer claim.
- **The polish gap is real but mostly closable on stock Ink** — per-agent identity, focus management,
  flicker-free streaming, density, a conducted-result view, disagreement surfacing, resize. Claude Code
  forked Ink's renderer for 60fps single-agent token streaming; **we likely do NOT need to fork yet** (our
  lanes are buffered, not a 60fps firehose — §6).

---

## 1. Ink — what the framework actually gives us (sourced: Context7 `/vadimdemedes/ink`)

| Lever                                          | What it does                                                                                                                                                                                                 | Use for                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `<Box>` + Yoga flexbox                         | flexDirection row/column, borders, padding, width % — the layout engine                                                                                                                                      | the pane grid                                                          |
| `<Static items>`                               | renders items ONCE, above the live UI, then drops them from the React tree                                                                                                                                   | completed-turn transcript / append-only history (kills re-render cost) |
| `render(…, { incrementalRendering: true })`    | **only changed lines are redrawn — reduces flicker on frequently-updating UIs** (default false)                                                                                                              | the make-or-break flag for live streaming                              |
| `useFocus` / `useFocusManager`                 | focus state per region; `isFocused` → highlight border                                                                                                                                                       | focus a lane (Ctrl+1/2/3)                                              |
| `useStdout` → `stdout.columns/rows` + `resize` | terminal dimensions + resize events                                                                                                                                                                          | width-aware reflow                                                     |
| `measureElement`                               | measure a rendered node                                                                                                                                                                                      | windowed/virtualized logs                                              |
| Ecosystem                                      | `ink-spinner` (animated), `ink-ui` (text-input/select/spinner/progress), `ink-table`, `ink-gradient`, `ink-big-text`, `fullscreen-ink` (responsive full-screen + alt-buffer), `terminal-image`/`ink-picture` | reuse, don't rebuild                                                   |

**Ink's real limits:** no native scrollback buffer (you manage history via `<Static>` or a windowed log);
stock reconciler re-renders the tree on state change (hence `incrementalRendering` + `<Static>` + memo);
unicode/emoji width + ConPTY quirks on Windows (we already solved glyph fallback in F-3).

## 2. The bar — how the best TUIs are built

**Claude Code (Ink/React + Yoga, then forked — leaked-source teardowns):** started on Ink, then
reimplemented the critical render path — a **custom React reconciler**, a **pure-TS Yoga port (~2,700
lines)**, a full ANSI/CSI/DEC/OSC parser, **typed-array cell buffer** (not object-per-cell), **double-
buffered, cell-level diffing**, and **off-screen subtree freezing** (a scrolled-away message's React
subtree is frozen so its spinner/elapsed timer can't trigger a full repaint) → **~60fps while streaming
tokens on a 200-col terminal.** Component set: REPL, Select, MultiSelect, PromptInput, Spinner, ProgressBar.
_(Corroborated across dev.to + claude-code-from-source + medium teardowns; not official.)_ The "thinking"
loop is an **async-generator engine that yields state** (`thinking` → `streaming` → `awaiting_tool_approval`)
and the UI is a dumb renderer of that state — a pattern we already mirror (our event bus).

**gemini-cli (open, Ink):** `packages/cli/src/ui/` — an `AppContainer` provider tree bootstrapping config +
a streaming engine, a `Composer` as the input/status layout engine, `UIState`/`UIActions` context state
machine. Known wart: renders to **90% terminal width** as an Ink-flex workaround (a cautionary tale on Ink
layout). **codex CLI** (open) + **opencode** (open, rich TUI) are the other reusable references.

**Non-Ink masters (lazygit / k9s / btop) — the principles that make a TUI feel premium:**

1. **Async I/O, never block the render thread** (spinner + result event, never a sync stall).
2. **Reactive, event-driven** (k9s watches; don't poll — _we currently poll pending() every 120ms; revisit_).
3. **Stable, pane-based layout** — panes don't move; content reflows inside them (spatial memory).
4. **High information density** — every cell earns its place; no chat-bubble sprawl.
5. **First-class keyboard focus** — instant pane switch, the focused pane clearly bordered.

## 3. The multi-agent landscape — and why we're not in it

`Conduit` (≤10 concurrent sessions, tabs), `agent-deck` (one TUI to manage claude/gemini/codex/opencode
sessions), `agentpipe` (multi-panel: agent list + status + conversation + cost + config), `DeepSeek-TUI`
(sub-agent orchestration). **All are session managers / orchestration shells — independent agents in tabs
or rooms.** None is a single conducted cockpit where the three argue on one shared brain, hand off in
dependency waves, and gate every write through one approval queue. **That conducted model is our moat.**

## 4. Our cockpit today — the honest gap (`src/tui`)

We HAVE the skeleton: `cockpit.tsx` (StatusBar + Screen selector + LiveView = Transcript / LanePanes /
ApprovalQueue / InputLine), a pure reducer SSOT (`cockpit-model.ts`), an event bus, per-lane bordered
panes, the per-action approval queue (the tower — multi-agent, which Claude Code does NOT have), F-2 honest
failure states, F-3 glyph fallback. **What's missing vs the bar:**

| Gap                 | Today                                                                                            | Bar                                                |
| ------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Per-agent identity  | all lanes magenta + yellow/green border                                                          | distinct color + icon per agent                    |
| Focus               | none (no pane focus/steer)                                                                       | `useFocus` + Ctrl+1/2/3 instant switch             |
| Streaming           | **buffered** — adapters return whole replies (claude-pty streams internally but the seam awaits) | live, flicker-free token stream                    |
| Render perf         | stock Ink, full-redraw, 120ms poll                                                               | `incrementalRendering` + `<Static>` + windowed log |
| Density / attention | three equal panes → wall of text                                                                 | focus+context, one primary action                  |
| Conducted result    | answers dumped into the transcript                                                               | a clean "composer" for the synthesized artifact    |
| Disagreement        | not surfaced                                                                                     | conflicts highlighted (P0 meta-event)              |
| Resize              | none                                                                                             | width-aware reflow (`useStdout`)                   |
| Spinner             | single static frame                                                                              | animated (`ink-spinner`)                           |

## 5. The custom design — a conducted 3-agent cockpit (cross-family synthesis)

**Where claude (me) and gemini converge** (high confidence — two independent lenses agree): per-agent
**identity** (color + icon); **focus management** (Ctrl+1/2/3 to spotlight a lane); **attention-first
layout** (don't render three firehoses equally); a **conducted-result view** separate from the agents'
scratch; **surface disagreement** as a first-class event; streaming via **`<Static>` + `incrementalRendering`
now → a custom windowed/virtualized log later**; reuse `ink-spinner`/`ink-ui`, build the cockpit shell +
the log component.

**Gemini's strong proposal:** a **Focus + Context** layout — the active agent at ~75% height, the other two
as minimized "context" panes (last ~10 lines + status), `Ctrl+R` swaps in the conducted-result view,
`Ctrl+D` a side-by-side diff/compare of two agents, a global approval queue in the status bar, and a
**`VirtualizedLog`** as the key custom component (the "how to do 60fps in Ink").

**Where I refine gemini's take:**

- **Layout — prefer master-detail over fixed focus+context.** Our shipped model is owned lanes; the
  premium move is **collapsed per-agent cards by default** (accent + `owns: <task>` + status chip + 1-line
  gist) that **expand to a focused detail** — this scales to a conducted turn (you watch the summary, drill
  in on demand) better than permanently spending 50% of the screen on two "context" panes. (This is the I2
  master-detail from the premium plan.)
- **Don't fork the renderer yet, and don't add worker-threads yet.** gemini calls worker-threads mandatory;
  but **node-pty is already async I/O — the main thread doesn't block on agent output**, it reacts to `data`
  events. Workers buy nothing until we're CPU-bound (huge-stream parsing). Defer. (§6.)
- **Reactive over polling:** replace the 120ms `pending()` poll with a bridge event — matches the k9s
  principle and removes a constant re-render source.

## 6. Streaming + performance — do we need to fork Ink like Claude Code? (the key call)

**No — not yet.** Claude Code forked Ink because it streams ONE agent's tokens at 60fps and a stock
full-redraw flickers at that rate. **Our load profile is different:** codex (`exec`) and agy (`-p`) are
**one-shot/buffered**; only claude (pty) streams, and our headless seam currently buffers even that. So our
render frequency is low (lane-completion + chunks), not a 60fps firehose. The premium feel is reachable on
**stock Ink** with: `incrementalRendering: true`, `<Static>` for completed turns, a **bounded windowed log**
per lane (render only the visible tail), and memoized lane components. **We fork the renderer (or adopt a
custom buffer) ONLY when we add true live token streaming across all three lanes** — and even then, a
windowed log may suffice. This is a deliberate "don't pay for 60fps we don't need" call.

## 7. Roadmap

**MVP (decision-light, stock Ink, days):** per-agent identity (color+icon, via the F-3 glyph set) ·
animated `ink-spinner` · `incrementalRendering: true` + memoize lanes (kill flicker) · `useFocus` +
Ctrl+1/2/3 lane focus · width-aware reflow (`useStdout`) · move completed turns into `<Static>`.
**V2 (the premium jump):** the master-detail collapsed-card lanes · a `WindowedLog` component (scrollback +
silky streaming without a renderer fork) · the conducted-result/composer view · disagreement highlighting ·
reactive `pending()` (drop the poll).
**Forks (need an operator call):** true live token streaming across lanes (then reassess the renderer) ·
the LLM-written digest (who synthesizes).

## Sources

- Ink docs/API — Context7 `/vadimdemedes/ink` (Static, incrementalRendering, useFocus, useStdout); ink-ui, fullscreen-ink, ink-table libraries.
- Claude Code TUI teardowns — dev.to "I studied Claude Code's leaked source…"; claude-code-from-source.com ch13 (Terminal UI); kotrotsos.medium "Claude Code Internals Pt 11"; DeepWiki farion1231/claude-code UI layer. (Leaked-source — corroborated, not official.)
- gemini-cli — DeepWiki google-gemini/gemini-cli (architecture, interactive mode); GitHub issue #4671 (90%-width).
- Multi-agent TUIs — getconduit.sh; github.com/asheshgoplani/agent-deck; github.com/kevinelliott/agentpipe; remio.ai DeepSeek-TUI.
- Cross-family lens — gemini research/design brief: `.council/runs/premium-cockpit-research/gemini-out.md`.
- Our cockpit — `src/tui/*` (this session's component map).
