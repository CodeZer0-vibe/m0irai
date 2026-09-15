# m0irai

A terminal room where several AI coding agents work one repository together. Claude, Codex and Gemini each run on their own native CLI, in the same room, answering into one shared feed — you watch them and steer. It's the product form of [zer0](https://iancau.com), my operating system for AI coding agents.

**Stack:** Rust (terminal UI) · TypeScript (host) · Agent Client Protocol · Windows ConPTY · bring-your-own agents

> Work in progress, open source, public release in preparation. The Rust terminal is a fork of xAI's open-source grok-build (Apache-2.0) — see `LICENSE` and `NOTICE`.

---

## The idea

Most agent tools give you one assistant. m0irai gives you a room. Several agents, each with its own strengths and its own CLI, work the same codebase at once and report into one feed, so you can play them off each other — one builds, one reviews, one researches — instead of running them in separate windows and copy-pasting between them. Humans stay in command; the agents contribute.

## How it's built

- A **Rust terminal UI** (forked from xAI's grok-build) renders the shared room and each agent's stream.
- A **TypeScript host** launches and supervises the agents, bridging them through the **Agent Client Protocol** so any ACP-capable CLI can join.
- Runs agents as real processes over **Windows ConPTY**, so each one behaves exactly as it does in its own terminal.
- **Bring your own agents:** point it at the CLIs you already use.

## Status and what's next

- **Now:** the room, the host, and the multi-agent bridging work end to end.
- **Next:** a public release build and setup docs so anyone can drop in their own agents.
