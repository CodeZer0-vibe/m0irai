# ADR-006 — Logger AUGMENTATION, not replacement

**Status:** Accepted
**Date:** 2026-05-05
**Source:** post-mortem of gemini's hallucinated build (2026-05-05) where gemini in YOLO mode replaced `createLogger` with a DB-only event emitter, breaking 7 existing tests.

## Context

Packet-10 needs structured event emission for every log line — every `logger.info(...)` call should produce an `events` table row that diagnostic agents can query. The temptation is to REPLACE `createLogger` with a DB-backed logger. The user's observed gemini run did exactly this, broke the build.

`src/shared/logger.ts` currently exports `createLogger(opts).{info|warn|error|debug}(ctx, msg, meta)`. Used by ~20 callers across CLI, activities, and shared modules. Has 7 passing tests asserting stderr text format with deterministic ISO timestamps.

Two options:

1. **Replace** — change the API so all callers go through DB-backed logger
2. **Augment** — keep existing `createLogger` and its API contract; ADD new factory `createDbLogger({ runId, db, baseLogger })` that wraps stderr logger AND emits events

## Decision

**Augment, not replace.**

- `createLogger(opts)` continues to work exactly as today
- `createDbLogger({ runId, db, source, baseLogger? })` is new
- `createDbLogger` returns a `Logger` (same interface) that for each call:
  1. Delegates to `baseLogger` (default: `createLogger()`) for stderr text output
  2. Inserts a row into `events` table with `kind="log"`, `source` per config, `payload_json={ level, message, ctx, meta }`
  3. If `level === "error"` AND `meta.code` is a `Zer0ErrorCode`, ALSO inserts a row into `errors` table
  4. Catches DB errors silently (logs to stderr ONLY) — logging must NEVER crash the system

- The 7 existing logger tests REMAIN UNCHANGED and PASS
- New test file `logger.test.ts` adds tests for `createDbLogger` covering: stderr text + DB insert, error-code propagation to errors table, DB-error swallowing

## Consequences

**Positive:**

- Zero migration risk — no caller updates required
- Activities and CLI commands that want event emission opt in by injecting `createDbLogger` instance
- Tests for existing behavior stay green
- Fresh code paths can require `createDbLogger`; legacy paths gradually migrate

**Negative:**

- Two factories to maintain — MITIGATED by `createDbLogger` being thin wrapper around `createLogger`
- Callers must explicitly pick the right factory — MITIGATED by `AGENTS.md` rule: production code requires `createDbLogger` when a `runId + db` are available; otherwise `createLogger` is fine for startup-pre-DB code

## Anti-pattern locked out

The packet-10 brief Section 3 hard constraint #4 explicitly bans replacing `createLogger`. The 7 existing tests must remain unmodified except for adding new tests (not modifying old ones).
