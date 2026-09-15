# ADR-002 — JSON Schema bundle in `.zer0/SCHEMA.json` (NOT MCP server in packet-10)

**Status:** Accepted
**Date:** 2026-05-05
**Source:** codex hostile critique (`.council/cross-model/packet-10-codex-result.md` §"Schema discovery" + §"MCP server: include or defer")

## Context

External code agents (fresh `claude -p`, `codex exec` from terminal) need to validate the JSON contracts emitted by zer0 (state.json, RunInspection, FailureContext, DiagnosticReport, etc). Two delivery mechanisms considered:

1. **Zod schemas exported from `src/observability/schemas/*.ts`** — agents `import` the Zod and call `.parse()`
2. **JSON Schema bundle at `.zer0/SCHEMA.json`** — agents read the file with any JSON Schema validator (`ajv`)
3. **MCP server (`src/mcp/server.ts`) exposing schemas as MCP resources** — agents connect via JSON-RPC

Critical invariant: when zer0 itself is broken (Temporal won't start, DB locked, worker crashed), an external agent must STILL be able to validate evidence. Option 1 requires the zer0 repo to be installed and runnable. Option 3 requires zer0's MCP server to be running.

## Decision

**`.zer0/SCHEMA.json` JSON Schema bundle is the canonical external-discoverable contract.**

Source of truth: Zod schemas in `src/observability/schemas/*.ts`. Build-time conversion via minimal in-repo Zod→JSON Schema converter (`src/observability/schema-bundle.ts`, ~200L) covering the subset of Zod features we use: `object`, `string`, `number`, `boolean`, `enum`, `array`, `optional`, `union`, `literal`, `discriminatedUnion`.

MCP server **deferred to packet-13** alongside council REPL.

## Consequences

**Positive:**

- External agents need only `ajv` (or any JSON Schema validator) — no zer0 install required
- Single file `.zer0/SCHEMA.json` is self-contained: index of all schemas keyed by `name@version`
- Survives zer0 being broken (file is plain JSON on disk)
- Agents can validate ANY emitted artifact (diagnostic output, state.json, replay record) by checking its `$schema` field against the bundle

**Negative:**

- Need to maintain a Zod→JSON Schema converter — chose minimal in-repo (~200L) over `zod-to-json-schema` package because adding a dep solely for schema export is over-budget; the subset we need is small
- Dual representation (Zod + JSON Schema) means drift risk; MITIGATED by `schema-bundle.test.ts` round-tripping every schema and asserting parity
- `zod-to-json-schema` is widely-used and battle-tested; reinventing risks subtle JSON Schema spec violations

## Why MCP deferred

MCP is the right long-term primitive for the council UX (agents talking to running zer0). But:

1. MCP requires a running server — adds another process that can fail
2. MCP requires every external agent to register the server (`claude mcp add zer0`) — friction
3. Packet-10 must work when zer0 is COMPLETELY DOWN — file-based discovery wins
4. Schema bundle is the substrate MCP would expose anyway — building it now means packet-13 just wraps it

Plan: packet-13 ships an MCP server whose `list_resources` lists every schema in the bundle and whose `read_resource` returns the schema text. The bundle stays canonical; MCP becomes one of multiple delivery surfaces.
