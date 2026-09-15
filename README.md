# m0irai

**Three coding agents, Claude Code, Codex and Gemini, working in one terminal, on the same repo, at the same time.**

I kept using Claude, Codex and Gemini one at a time. I'd get an answer from one, paste it into the next, re-explain what I'd already said, then carry the result back again. I was the thing moving context between them. m0irai is me trying to delete that job.

It's one room. You say something once, and all three agents hear it and see the same work. So instead of three tabs I have to reconcile in my head, they can actually work together: one builds, another reviews it, and when they disagree they can argue it out or go research it before anyone commits to the wrong thing.

![m0irai, three agents in one terminal](docs/demo.gif)

**Watch the full demo:** [walkthrough](https://github.com/CodeZer0-vibe/m0irai/releases/download/v0.1.0-preview/M0irai.mp4)

---

## The idea

The point isn't running three models to look clever. It's that once they share the same terminal and the same context, you can give them real roles:

- Claude Code builds, Codex reviews it, or the other way round. Whoever wrote something doesn't get to sign off on their own work.
- When two of them disagree on how to do something, they can debate it instead of one quietly overwriting the other.
- One can go research a current API or a library while the others keep working, and bring the answer back into the same room.

You talk to the room in plain messages, or point at an agent with `@codex` / `@gemini`, or call all of them with `/council`. There's no orchestrator to configure.

## The first thing I built with it

A small neon snake game. On its own, no single agent quite finished it: each one got part of the way and missed something one of the others caught. The three of them together did finish it. That was the moment the shared-room idea stopped being a nice thought and became the reason I kept going, because you keep the part that only one of the three would have gotten.

## How it's built

- A **Rust terminal** renders the shared room. It's a fork of xAI's open-source [grok-build](https://github.com/xai-org/grok-build) (Apache-2.0). I kept the terminal and the renderer and cut everything grok-specific. See `LICENSE` and `NOTICE`.
- A **TypeScript host** runs the agents as real processes and bridges them over the **Agent Client Protocol**, so any ACP-capable CLI can join.
- A **SQLite evidence ledger** records what happened. Every state change is written down, so you can read back what each agent did and why.
- **Mechanical gates** (build, typecheck, lint, tests, plus a set of custom checks) have to pass before work counts as done. An agent saying "done" isn't enough.

**Stack:** Rust (terminal), TypeScript (host), Agent Client Protocol, SQLite, Node 22.17+.

## Running it

Right now it's two halves, the Node host and the Rust terminal.

```sh
npm install     # host dependencies (Node 22.17+)
npm run build   # build the TypeScript host
npm test        # run the test suite
```

The terminal is built on the Rust side with `cargo build`, and it launches the host as a child process. The one thing I'm still finishing for the public release is a single packaged launcher, one command to open the room. Until that lands, this is more "read the code and watch the demo" than one-click run.

## Status

Being honest about it, since this describes more than a weekend of work:

- **Working:** the room, message dispatch (`@agent` / `/council`), bridging the agents over ACP, cross-agent review, the SQLite ledger, and the gates.
- **In progress:** the Rust terminal extraction (`docs/STATE.md` is the real record of what's actually been proved), and the one-command launcher.
- **Next:** the full pipeline from intent to research to spec to plan to build, and the public release.

Open source, work in progress. The `docs/` folder is the actual working record, specs and plans and state, not marketing.
