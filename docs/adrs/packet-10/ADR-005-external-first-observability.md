# ADR-005 — External-FIRST observability (not external-fallback)

**Status:** Accepted
**Date:** 2026-05-05
**Source:** codex hostile critique opening verdict: "Claude's internal CLI surface is directionally useful, but packet-10 fails unless it is external-first."

## Context

The early synthesis treated external diagnostic surface (5 standalone scripts that work without zer0 running) as a FALLBACK for when the internal CLI is unavailable. This was wrong. Codex's critique is correct: in the existing codebase, `src/cli/commands/status.ts` already has a SQLite fallback that triggers when Temporal is down — which means it's a runtime that depends on a runtime, brittle by design.

Two opposing philosophies:

1. **Internal-first, external-fallback** — `zer0 inspect` queries Temporal first, falls back to SQLite if Temporal down, falls back further to state.json if SQLite locked. Each layer is duplicated.
2. **External-first, internal-enriches** — diagnostic logic lives in standalone scripts that read SQLite + blobs + state.json directly. Internal CLI commands are THIN WRAPPERS around the same external logic, plus optional live workflow data when Temporal is up.

## Decision

**External-FIRST. Internal CLI commands are projections of the external surface.**

Concretely:

- `src/observability/inspect.ts` is the canonical reader. It MUST work when Temporal is absent.
- `src/cli/commands/inspect.ts` calls `inspectRun()` from `src/observability/inspect.ts`, optionally enriches with live workflow query if connected, returns JSON.
- `scripts/diagnose/inspect-run.mjs` uses the SAME logic but reimplements it in plain Node `.mjs` because diagnostic scripts MUST NOT import compiled TS or any runtime.
- The duplicated logic between `inspect.ts` and `inspect-run.mjs` is acceptable AND TESTED for parity (`tests/integration/offline-diagnose.test.ts` runs both, asserts equal output for a fixture run).

## Consequences

**Positive:**

- When zer0 is broken, the diagnostic surface STILL WORKS — by design, not by accident
- `tests/integration/offline-diagnose.test.ts` runs all scripts WITHOUT Temporal — proves the property under CI
- A fresh `claude -p` session can diagnose without installing zer0; just runs the `.mjs` scripts directly with Node
- Internal CLI is simpler (just a projection) — less duplicated error handling

**Negative:**

- Two implementations of inspect logic (TS in `src/observability/inspect.ts`, JS in `scripts/diagnose/inspect-run.mjs`) — MITIGATED by parity test asserting identical output on fixtures
- If we change the inspection JSON schema, both implementations must update — MITIGATED by schema bundle (ADR-002): both validate output against `.zer0/SCHEMA.json/runInspection.v1`, drift caught by parity test

## Implementation invariant

When evaluating "should this go in `src/observability/` or `scripts/diagnose/`":

1. Does an external agent need it without zer0 running? → both (TS canonical, JS standalone)
2. Does it need live Temporal data only? → `src/cli/commands/` (internal-only, calls workflow query)
3. Is it a thin projection over `inspectRun()`? → `src/cli/commands/` only (don't bother with .mjs script unless external agent needs it)
