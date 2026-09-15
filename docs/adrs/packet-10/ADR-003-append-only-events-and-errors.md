# ADR-003 — Append-only `events` and `errors` tables

**Status:** Accepted
**Date:** 2026-05-05
**Source:** codex hostile critique gap-2 + claude synthesis §"append-only invariant"

## Context

Earlier `gate_transitions` table used `INSERT ... ON CONFLICT(run_id, gate_name) DO UPDATE` — every retry overwrites the latest row. Acceptable for "what's the current gate status?" but DESTROYS causal history. A diagnostic agent asking "what was the sequence of gate fires before the failure?" gets a single row per gate, not the timeline.

The `events` and `errors` tables are NEW in packet-10 specifically to capture causal history that latest-projection tables lose.

Two design options:

1. **Mixed UPSERT/INSERT** — events INSERT-only but errors UPSERT-on-fingerprint (dedup at write)
2. **Append-only on both** — every event and every error is a new row; dedup happens at read time via fingerprint grouping

## Decision

**Append-only on BOTH tables. Never UPDATE, never DELETE rows in `events` or `errors`.**

Enforcement:

- SQL design: indexes only, no `ON CONFLICT` clauses on these tables
- TypeScript design: `Queries` interface exposes `insertEvent()` and `insertError()` only — no `updateEvent()` or `deleteEvent()` methods exist
- Test enforcement: a test in `queries.test.ts` greps the source for `UPDATE events`, `DELETE FROM events`, `UPDATE errors`, `DELETE FROM errors` and asserts zero matches outside migration scripts
- Optional: SQLite `BEFORE UPDATE` and `BEFORE DELETE` triggers that RAISE(ABORT, 'append-only') — defense in depth

## Consequences

**Positive:**

- Full causal replay — every state change is recoverable
- Diagnostic agents see "what happened in order" not "what's the latest"
- Fingerprinting (ADR-011) gives grouped views WITHOUT writing-time dedup
- Simpler write path — no merge logic, no race conditions on update

**Negative:**

- Storage grows linearly with run count + error rate — MITIGATED by retention policy (defer to packet-12 or later: rotate runs older than 30 days to archive directory)
- `errors` table can grow large for repeating issues — MITIGATED by `idx_errors_fingerprint` for grouping queries; `trace-error.mjs` uses GROUP BY fingerprint
- "Latest error" queries become `ORDER BY created_at DESC LIMIT 1` instead of single-row read — negligible perf impact with indexes

## Migration impact

`gate_transitions` STAYS as latest-projection (ADR-implicit). The append-only invariant is for the NEW tables only. Existing tables retain their semantics to avoid breaking Phase-1 spine.
