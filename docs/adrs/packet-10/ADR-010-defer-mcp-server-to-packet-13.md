# ADR-010 — Defer MCP server to packet-13 (council UX)

**Status:** Accepted
**Date:** 2026-05-05
**Source:** codex critique §"MCP server: include or defer? — DEFER" + gemini research §"MCP: shipping an MCP server is the most robust long-term solution... For packet-10, AGENT-GUIDE.md is a sufficient starting point"

## Context

Model Context Protocol (MCP) is the natural primitive for cross-CLI agent collaboration: any `claude`/`codex`/`gemini` session can `claude mcp add zer0` and call tools, read resources, subscribe to streams via JSON-RPC. The user's stated future vision (council REPL with `!ask <agent>`, `!broadcast`, `!vote`) maps directly onto MCP.

But MCP comes with cost:

- Adds another long-running process (the MCP server)
- Requires every external agent to register the server
- Creates a new failure surface (the MCP server itself can be down)
- Expands security/auth surface (MCP exposes evidence blobs that may contain secrets)

Packet-10's hard invariant (ADR-005): the diagnostic surface MUST work when zer0 is broken. An MCP server that's part of "zer0 infrastructure" doesn't satisfy this — if zer0 is down, the MCP server is also down.

## Decision

**Packet-10 does NOT ship MCP. Defer to packet-13.**

What packet-10 ships instead:

- `.zer0/AGENT-GUIDE.md` (auto-generated) tells external agents how to read evidence
- `.zer0/SCHEMA.json` (JSON Schema bundle) so external agents validate without zer0 install
- 5 standalone diagnostic scripts that read filesystem directly

What packet-13 will ship (deferred):

- `src/mcp/server.ts` — MCP server exposing evidence as `read_resource` and diagnostic scripts as `tool_call`
- Council REPL `zer0 chat <run-id>` — uses MCP to multiplex claude+codex+gemini sessions
- `council_messages` table for persisted multi-agent conversation history

## Consequences

**Positive:**

- Packet-10 ships a recovery surface that survives zer0 being broken
- File-based discovery (AGENT-GUIDE.md + SCHEMA.json) requires zero infrastructure
- Packet-13 builds on a solid foundation: MCP server simply wraps the schema bundle and diagnostic scripts that already exist
- The `Sentinel/Diagnoser/Healer/Verifier` automation (ADR-009 packet-12) doesn't need MCP — it's pure Temporal

**Negative:**

- The user's "talk to the team of agents" UX is 2 packets away — accepted given quality > speed directive
- External agents in packet-10 are READ-ONLY (they can diagnose but can't trigger fixes via protocol) — this is correct: human approval gate per ADR-009 means external agents propose, humans approve, zer0 applies

## Reservations made now

To minimize packet-13 friction:

- Reserve `src/mcp/` directory (empty in packet-10, populated in packet-13)
- Make sure `inspect.ts` and diagnostic scripts produce output already shaped for MCP `read_resource` consumption (JSON with `$schema` + `schemaVersion` is exactly what MCP wants)
- Document in the brief that any new diagnostic emits MCP-compatible JSON contracts so packet-13's MCP server can wrap them without redesign

## Why "MCP-compatible" matters even when MCP isn't shipped yet

MCP `Resource` semantics: each resource has a stable URI, a JSON content type, optional schema reference. Our outputs already match: `state.json` has stable path `.zer0/runs/{id}/state.json`, JSON content, `$schema` reference. When packet-13 ships, the MCP server's `list_resources` is just a directory walk plus schema lookup — minimal new code.
