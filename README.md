# m0irai

**Three coding agents, Claude Code, Codex and Gemini, working in one terminal, on the same repo, at the same time.**

m0irai is a room. You open it inside a repo, and the three agents take a live turn in one shared conversation. Their replies land in a ledger. The next prompt to each of them carries what the others just said. When the session closes, what got decided is digested into memory the next session starts from. That's the whole loop, and everything in this repo exists to make it hold.

I built it because I was the thing moving context between three CLIs, and I wanted that job gone. In the room they can actually work together: one builds, another reviews it, and a third can go check a current API or a library while the other two keep going.

![m0irai, three agents in one terminal](docs/demo.gif)

**Watch the full demo:** [90-second walkthrough](https://github.com/CodeZer0-vibe/m0irai/releases/download/v0.1.0-preview/M0irai.mp4)

---

## What it does right now

- You talk to the room in plain messages. `@codex` or `@gemini` sends something to one agent. `/council <topic>` asks all three for an opinion at once.
- Claude Code and Codex join over the [Agent Client Protocol](https://agentclientprotocol.com). Gemini joins through Google's Antigravity CLI. All three run as the real CLIs you already have installed and signed into. m0irai never sees a key.
- Everything the agents say goes into one transcript and a SQLite ledger. If the room dies mid-session, the next start replays its journal and tells you, once, what it restored.
- When a session closes, a detached digest run turns what was decided into memory rows in the ledger, and the briefing each agent gets at the start of the next session carries them.
- Permission prompts come to you with the actual tool call named. If an agent sends something the room can't carry, it gets dropped with a logged reason, not silently.
- The three agents work at the same time, as equals. There's no leader and no queue. That part is on purpose, and I've turned down every change that would have added one.

## How it's built

Two processes talking over a pipe.

```
 you ──▶ m0irai.exe (Rust terminal) ══ JSON-RPC over stdio ══ zer0-v2-host (TypeScript)
                                                                   │
                        ┌──────────────────────────────────────────┼─────────────────────┐
                        ▼                                          ▼                     ▼
                 Claude Code (ACP)                          Codex (ACP)          Gemini (Antigravity)
                        │                                          │                     │
                        └──────────── room events ─────────────────┴─────────────────────┘
                                                │
                                   SQLite ledger + replayable journal
```

**The terminal is Rust.** It's a fork of the pager from xAI's open-source [grok-build](https://github.com/xai-org/grok-build) (Apache-2.0). I kept the terminal and the renderer, cut everything Grok-specific, and taught it to draw a three-seat room: a shared scrollback, a status line per agent, permission prompts, pickers for models and skills, slash commands. It only keeps a display cache. If you want to know the state of the room, you ask the host.

**The host is TypeScript on Node.** It starts each agent as a child process, bridges Claude Code and Codex over ACP and Gemini over a pseudo-terminal, merges the three streams into one ordered transcript, and talks to the terminal over newline-framed JSON-RPC on stdio: `session/new`, `session/load`, and a small `zer0/room/*` family for submit, control, model selection, permissions and shutdown.

**Between the two halves** sits a versioned event envelope with a JSON schema. The Rust side reduces the event stream into what you see. The TypeScript side validates every event before it's journaled. Both halves are tested against the same conformance corpus, so they can't drift apart without a test going red.

**The ledger** is SQLite with migrations, content-addressed blobs for what the agents said, and a journal that can be replayed. Secrets you register get redacted before anything hits disk.

## How I keep it honest

Most of the work in a tool like this isn't the agents. It's knowing what's actually true. So the repo is set up so that a claim doesn't count, a proof does.

- `npm run verify:staged` runs every check on the exact staged tree and writes a receipt. The push gate refuses a tree that doesn't have a green receipt.
- With `ZER0_HERMETIC=1`, every place that could spawn an agent refuses to, and a standalone oracle drives the room through its real wire. So the core gets tested without any provider account.
- A dozen custom gate scripts run next to typecheck, lint and the tests. File and function size limits with no override above the hard line. Every source file needs a sibling test. Every production file has to be reachable. Layering rules. Every agent spawn guarded by the hermetic seam. Patch drift. A frozen schema, so new tables go through migrations.
- `docs/FINDINGS.md` has 250+ recorded findings. When the same class of bug shows up twice, it becomes a gate, not a third patch.
- Code written by one model family gets cross-checked by another, with the reproduction commands and the exact output kept in the record. Nobody signs off on their own work, me included.
- A fix isn't in until its test has been shown failing on the old code first.

## Numbers

| | |
|---|---|
| TypeScript (host, tests, scripts) | ~108,000 lines |
| Unit tests | 317 files, ~2,360 cases, plus integration and live suites |
| Rust I wrote (terminal launcher + protocol crate) | ~18,000 lines, 133 tests |
| Rust inherited from the grok-build fork | ~630,000 lines |
| Custom gate scripts | 12 |
| Recorded findings | 250+ |
| Time from double-click to the room, packaged | ~5 s |

## Running it

Windows 10/11, x64, for now. You need the agents you already use, installed and signed in on your own account: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), the [Codex CLI](https://github.com/openai/codex), and Google's Antigravity CLI.

```sh
npm ci                                              # Node 22.17+ or 24.2+; applies the pinned patches
npm run build
node scripts/package-zer0-v2-sidecar.mjs dist-room  # stages the host next to where the exe goes
cd rust && cargo build --locked -p zer0-v2-bin --profile release-dist   # Rust 1.94, pinned
copy target\release-dist\m0irai.exe ..\dist-room\
```

Then open a terminal inside any git repo and run `dist-room\m0irai.exe`. `/help` lists every command. `/model @gemini` picks a model for a seat. Ctrl+C quits.

Checks: `npm test` for the unit suite, `npm run gates` for the whole Node proof, `npm run verify` to add the Rust half.

## Status

Being honest about it, since this describes more than a weekend of work:

- **Working:** everything under "What it does right now", plus the packaged launcher: one exe next to the host folder.
- **Next, in this order:** remove the last bundled agent copy so only your own installs ever run; a generic seat so any ACP agent can join, not just these three; memory between sessions and a terminal roster; `npm install -g m0irai` with a self-update; a first public release, Windows-only and unsigned, aimed at October 2026.
- **Not there yet:** agents debating each other. `/debate` tells you so.

`docs/` is the actual working record, state and decisions and audits and lessons, not marketing.

## License

My code (the host, the launcher, the protocol crate, the scripts) is MIT. The terminal inherits xAI's grok-build pager under Apache-2.0, with its notices intact. See `LICENSE` and `NOTICE`.
