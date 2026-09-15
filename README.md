# m0irai

**One terminal where Claude Code, Codex and Gemini work the same repository at the same time.**

You say a thing once. All three agents hear it, see the same files and the same running transcript, and reply in parallel. One builds, another reviews, and a third can go check a current API while the first two keep working. Nothing is pasted between tabs, and nothing is re-explained.

![m0irai, three agents in one terminal](docs/demo.gif)

**Watch it run:** [90-second walkthrough](https://github.com/CodeZer0-vibe/m0irai/releases/download/v0.1.0-preview/M0irai.mp4)

---

## Why I built it

I was using Claude, Codex and Gemini one at a time: get an answer from one, paste it into the next, re-explain what I had already said, carry the result back. I was the process moving context between three tools. m0irai deletes that job by giving the three agents one room.

The first thing the room finished was a small neon snake game that no single agent finished alone. Each one got part of the way and missed something another one caught. Together they shipped it. That was the moment the shared room stopped being a nice idea and became the reason to keep going: you keep the part that only one of the three would have gotten.

## What it does today

- **Three seats, one room.** Claude Code and Codex join over the [Agent Client Protocol](https://agentclientprotocol.com); Gemini joins through Google's Antigravity CLI. Each runs as the real process you already have installed and signed into. No API keys are stored or forwarded.
- **Talk to all of them, or one.** A plain message goes where the room's routing rules say it should. `@codex` or `@gemini` addresses one agent. `/council <topic>` asks everyone for an opinion at once.
- **Concurrent, not turn-taking.** The three agents work simultaneously and as equals. There is no leader, no queue an agent waits in, and no orchestrator to configure. That is the whole product.
- **One transcript, one evidence ledger.** Every room event is written to a SQLite ledger and a journal. On start the room replays its journal, so an interrupted session comes back with its state and says so, once, only when something was actually restored.
- **Roles that hold.** A build goes to one agent and its review to a different one. A permission an agent asks for is shown to you with the real tool call named, and a request the room cannot carry is dropped with a logged reason rather than silently.
- **Honest boot and shutdown.** The terminal finds a usable Node on your machine, opens the room in about five seconds, and on quit waits for the host to acknowledge the close, reaps its process tree within a measured bound, and tells you plainly if the host would not go.

## How it works

```
 you ──▶ m0irai.exe (Rust terminal) ══ JSON-RPC over stdio ══ zer0-v2-host (TypeScript)
                                                                   │
                        ┌──────────────────────────────────────────┼─────────────────────┐
                        ▼                                          ▼                     ▼
                 Claude Code (ACP)                          Codex (ACP)          Gemini (Antigravity)
                        │                                          │                     │
                        └──────────── room events ─────────────────┴─────────────────────┘
                                                │
                                   SQLite evidence ledger + journal
```

- **The terminal** is Rust. It is a fork of the pager from xAI's open-source [grok-build](https://github.com/xai-org/grok-build), stripped of everything Grok-specific and taught to render a three-seat room: a shared scrollback, per-seat status, permission prompts, pickers for models and skills, and slash commands. It keeps only a display cache. The host owns the truth.
- **The host** is TypeScript on Node. It spawns each agent as a child process, bridges Claude Code and Codex over ACP and Gemini over a pseudo-terminal, merges their streams into one ordered transcript, and speaks a newline-framed JSON-RPC wire to the terminal: `session/new`, `session/load`, and a small `zer0/room/*` family for submit, control, catalog, model selection, permissions and shutdown.
- **The protocol** between the two halves is a versioned event envelope with a JSON schema. The Rust side reduces the event stream deterministically into the view; the TypeScript side validates every event before it is journaled. A shared conformance corpus is run by both halves, so the terminal and the host cannot drift apart without a test going red.
- **The ledger** is SQLite through migrations, with content-addressed blobs for what the agents said and a journal that can be replayed. Secrets you register are redacted before anything is written.

## How I built it

The hard part of a multi-agent tool is not the agents. It is knowing what is true. So the repository is built around proof rather than claims:

- **Every commit is proven on its exact staged tree.** `npm run verify:staged` runs the whole gate chain and writes an external receipt. The ship gate refuses a push unless a green receipt exists for the tree being pushed.
- **A hermetic oracle proves the room without touching a real CLI.** Under `ZER0_HERMETIC=1` every agent-process seam refuses to spawn, and the standalone oracle drives the room through its real wire, so the core is tested in CI without any provider account.
- **A dozen custom gates** run beside typecheck, lint and tests: file and function size clamps with no escape hatch above the hard limit, a mandate that every source file has a sibling test, reachability of every production file, layering rules enforced by dependency-cruiser, a check that every agent spawn is guarded by the hermetic seam, patch drift detection, and a frozen schema that forces new tables through migrations.
- **Findings become gates.** More than 250 recorded findings live in `docs/FINDINGS.md`. When a defect class shows up twice, the fix is a permanent check, not a third patch.
- **Cross-family review.** Nothing written by one model family is signed off by the same family. Claude-built code is cross-checked by Codex, with reproduction commands and exact output in the record.
- **Red before green.** A fix is not accepted until the test that guards it has been shown failing on the old code.

## By the numbers

| | |
|---|---|
| TypeScript host, tests and scripts | ~108,000 lines |
| Unit tests | 317 files, ~2,360 cases, plus integration and live suites |
| Rust written for m0irai (terminal launcher + protocol crate) | ~18,000 lines, 133 tests |
| Rust inherited from the grok-build fork | ~630,000 lines |
| Custom gate scripts | 12 |
| Recorded findings | 250+ |
| Boot to the room, packaged, on a laptop | ~5 s |

## Running it

Windows 10/11, x64. You need the agents you already use, installed and signed in on your own account: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), the [Codex CLI](https://github.com/openai/codex), and Google's Antigravity CLI. m0irai never asks for a key.

Build the host and the terminal:

```sh
npm ci                                              # Node 22.17+ or 24.2+; applies the pinned patches
npm run build
node scripts/package-zer0-v2-sidecar.mjs dist-room  # stages the host beside where the exe will go
cd rust && cargo build --locked -p zer0-v2-bin --profile release-dist   # Rust 1.94, pinned
copy target\release-dist\m0irai.exe ..\dist-room\
```

Then open a terminal inside any git repository and run `dist-room\m0irai.exe`. Type `/help` in the room for every command, `/model @gemini` to pick a model for a seat, and Ctrl+C to quit.

To run the checks: `npm test` for the unit suite, `npm run gates` for the whole Node proof, `npm run verify` to add the Rust half.

## Status

What is here works and is proven by the checks above. What is not here yet, in order:

1. **Bring-your-own agents, all the way.** The Claude and Codex bridges ship inside the package; the agents themselves are yours. The last bundled copy is being removed so nothing but your own installs is ever run.
2. **A generic seat.** Any ACP-speaking agent, not only these three, takes a seat with its own settings.
3. **Memory between sessions**, and a terminal roster that shows each seat's state at a glance.
4. **`npm install -g m0irai`** with a self-update, an unsigned Windows build first, and a public release aimed at October 2026.

Agent-to-agent debate is planned; today `/debate` tells you it is not available yet.

`docs/` is the working record: state, decisions, audits and lessons, kept because the process is the product.

## License

m0irai's own code (the host, the launcher, the protocol crate, the scripts) is MIT. The terminal inherits xAI's grok-build pager under Apache-2.0 with its notices intact. See `LICENSE` and `NOTICE`.
