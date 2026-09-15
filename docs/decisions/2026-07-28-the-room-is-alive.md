# THE ROOM IS ALIVE — North Star correction (operator, 2026-07-28)

**Status: AUTHORITATIVE.** This supersedes any reading of zer0 chat as a turn-based machine. Every
future wave is measured against THIS document, not against the turn machine's own habits.

## The operator's model, in their words

> "Do you know how the real terminal experience works? Like how the Claude Code agent in terminal
> works — everything is live. I talk, you answer. If I tell you, search this, I can see 'working'.
> If you send a message randomly, it appears. It's NOT turn-based. It's ALIVE. This is also how the
> zer0 chat should work — the agents need to be able to send messages, not just the end ones."

> "We should integrate the ability for them to call each other — not like MCP, but like a skill or
> something, so they know how to use it. Codex calls Gemini to research — I should be able to see
> those messages. It shouldn't be something in the backend in the dark."

**The reference experience is Claude Code itself: zer0 chat = that experience, with a three-agent
room.** The operator watches the work happen, messages appear whenever their author has something
to say (including long after the prompt that caused them), and teammates hand work to each other in
the open.

## The three pillars

**P1 — LIVE WORK.** While an agent works, the feed shows what it is doing — tool-call lines
(`claude ▸ reading src/auth.ts`, `codex ▸ running tests`), streamed text, a live one-liner per
agent in the bar (the `ActiveAgent.phase` slot exists and is never fed). claude/codex emit this
activity over the ACP bridges TODAY; zer0 receives it and discards it. gemini's CLI emits no
per-step activity — render honestly (`working · 40s elapsed`), never fake it (all-3 parity: absent
channels render honestly).

**P2 — MESSAGES WHEN THEY HAPPEN, not one-per-turn.** Today an agent gets exactly ONE message per
dispatch — its final reply. "I'm spawning research on this" is the END of its turn; whatever it
started reports into the void. The mechanism that fixes this is the same one Claude Code's own
harness uses: zer0 tracks the long/background work an agent starts, and RE-PROMPTS that agent when
the work completes — its report lands in the feed as a new message, minutes or hours later. An
operator message sent mid-work queues visibly ("queued — goes out when the turn ends"), never
silently.

**P3 — TEAMMATES CALL EACH OTHER, IN THE OPEN.** Taught as a SKILL, not built as infrastructure:
the team-setup prompt zer0 already injects teaches the affordance ("to hand work to a teammate, end
your message with `@gemini: <the ask>`"), and the SAME parser that routes the operator's messages
(`parseMultiAddress`) runs over agent replies to dispatch the hop. Every hop renders in the feed as
an ordinary message — codex asking, gemini answering.

**THE HARD RULE: if it happens, it is in the feed.** No backend-in-the-dark actions, ever.

## Guard rails (binding on the design, small on purpose)

- **Hop budget** — agent-initiated volleys count against a per-task cap; hitting it stops and asks.
- **No permission escalation by conversation** — an agent-initiated hop runs at the grant the
  OPERATOR's rules allow; agents request, only operator rules grant. (Write-capable work keeps
  today's explicit-@ trust boundary.)
- **Kill switch** — the existing /pause · /cancel machinery applies to agent-initiated activity.
- **No fixed roles** — "claude architects, codex reviews" is an OPERATOR rule per project, never a
  product role (all-3 parity law, 2026-07-19).

## Prerequisites, named honestly

1. **The ledger write path must be un-forkable first.** The 2026-07-28 trace showed all three
   replies absent from the DB mirror (suspected relative-vs-absolute dbPath equality miss in
   `recordChatMessage`/`recordLaneTurnEvidence`'s `viaLedger` check). A self-driving room rides
   entirely on "every message reaches the shared ledger" — this fix graduates from cleanup to
   foundation.
2. **Capture real activity payloads before rendering** (READ-WHAT-IS): verify WHICH ACP update
   kinds our held bridge versions actually deliver for claude and codex; fixtures from captured
   frames only.
3. The queue ahead: the operator's 2-minute test of W4-R2b/R2c · the battery-trim round (HUD
   reachable at a 180-column terminal). Then this becomes the main line.

## What this reframes

- The "live room" orchestration pitch (2026-07-28, coordinator) is ABSORBED into P3's simpler
  skill-taught shape — no new orchestration layer.
- W5's loop waves (B2 plan-file mode, C convergence) remain, reframed as the AFK mode of the same
  alive room; the live mode (this document) comes first.
- The turn machine's serialization stays as the DISPATCH substrate — what changes is that turns can
  be STARTED by events (background-work completion) and by agents (P3), not only by the operator.
