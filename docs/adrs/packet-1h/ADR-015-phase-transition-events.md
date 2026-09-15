# ADR-015 — Phase transition persistence via append-only events with idempotency

**Status:** Proposed
**Date:** 2026-05-09
**Source:** packet-1h Phase C
**Builder:** codex (fills Decision / Alternatives / Consequences during Phase C build)

## Context

**Empirical incident — 2026-05-09.** During the post-`packet-99` proof, `zer0 start "Add a /health endpoint..."` (run id `run-febbb606-fd42-4cc5-a726-91e87e672baa`) hung at the build phase. The orchestrator inspected the evidence DB and found: `runs.id = run-febbb606..., vision = "Add a /health...", status = "init"`. Despite the workflow having traversed 8 stub phases and entered build, the DB recorded ZERO phase progression. `dispatches` was empty. `gate_transitions` was empty. The only signal was the in-memory `phase` query handler — which goes away when the workflow process dies. A failed run leaves no audit trail.

`buildPacketWorkflow` updates in-memory `state.phase` at every phase boundary (`build-packet.ts:175` `state.phase = phase.name`; `build-packet.ts:178` `state.attempt = failures.length`; `build-packet.ts:101/105/120` cancellation paths; `build-packet.ts:116` seal site) but writes nothing to the evidence DB until workflow exit. The `runs.status` column (`schema.sql:11-19`) transitions only at workflow start/end via `persistRunStarted`/`persistRunCompleted` (`init` → `completed`/`failed`). Without per-phase persistence, debugging which phase failed in production requires Temporal Web UI access — not always available, and gone after the workflow run is garbage-collected.

The existing `events` table (`schema.sql:141-154`) is append-only (enforced by `trg_events_no_update` and `trg_events_no_delete`) and has columns `kind`, `phase`, `payload_json` plus `idx_events_run_sequence_unique` on `(run_id, sequence)`. It is the natural home for phase-transition events.

Eleven canonical event kinds cover every phase boundary in `buildPacketWorkflow`:
`packet.started`, `preflight.passed`, `phase.started`, `phase.attempt.started`, `phase.attempt.failed`, `phase.passed`, `phase.exhausted`, `phase.escalated`, `packet.review.passed`, `packet.sealed`, `packet.cancelled`.

**Idempotency under retry.** With Phase C's retry policy (`maximumAttempts: 3`), a `persistPhaseTransitionActivity` that throws after a successful INSERT will retry and produce a duplicate logical event row. The `(run_id, sequence)` UNIQUE constraint prevents duplicate sequence numbers but not duplicate logical events. A schema migration adds an `idempotency_key` TEXT column to `events` plus a partial UNIQUE index `idx_events_idempotency` on `(run_id, idempotency_key) WHERE idempotency_key IS NOT NULL`. The activity computes `idempotency_key = ${kind}:${phase ?? "_packet"}:${attempt ?? 0}` (packet-level events without a phase use the literal `_packet` slot; events without an attempt use `0`) and uses `INSERT ... ON CONFLICT(run_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`. This is the single in-scope schema change for packet-1h.

## Decision

Persist `buildPacketWorkflow` boundaries as append-only rows in the existing `events` table, using a closed TypeScript/Zod event kind enum:
`packet.started`, `preflight.passed`, `phase.started`, `phase.attempt.started`, `phase.attempt.failed`, `phase.passed`, `phase.exhausted`, `phase.escalated`, `packet.review.passed`, `packet.sealed`, and `packet.cancelled`.

Schema version advances to 6. The SQL bootstrap only adds the nullable `events.idempotency_key TEXT` column to fresh databases; the v5 to v6 migration adds the same column to legacy databases, creates `idx_events_idempotency` as a partial unique index on `(run_id, idempotency_key) WHERE idempotency_key IS NOT NULL`, inserts version 6, and removes legacy version rows.

The workflow-facing activity computes `idempotency_key = ${kind}:${phase ?? "_packet"}:${attempt ?? 0}` and inserts with `ON CONFLICT(run_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`. Each event carries a non-optional JSON payload object, using `{}` when the boundary has no extra data. `buildPacketWorkflow` records packet start, preflight pass, phase start, attempt start, review failure, phase pass, exhausted/escalated, final review pass, seal, and cancellation boundaries through `persistPhaseTransitionActivity`.

## Alternatives considered

1. Add a new `phase_transitions` table. This would make phase-specific queries obvious, but it duplicates the append-only event infrastructure, adds another migration surface, and splits workflow audit data from the existing event stream.
2. Reuse `events` with a single `kind = "phase_transition"` and a free-form payload discriminator. This keeps one table, but it pushes the event contract into unindexed JSON and makes invalid or misspelled transition kinds easy to store.
3. Reuse `events` with a closed kind enum plus `idempotency_key`. This keeps the existing append-only model, gives TypeScript and Zod a narrow contract, and lets SQLite deduplicate activity retries independently of workflow replay behavior.
4. Rely on Temporal history only. This avoids a schema change, but operational debugging would still require Temporal access and would not leave durable evidence in the local ledger after retention.

## Consequences

Positive: every Phase 1 run now leaves a durable, ordered audit trail in the evidence DB, and activity retry duplicates collapse at the database layer. Fresh v6 databases and upgraded v5 databases converge on the same version, column, and partial index.

Negative: the idempotency formula intentionally deduplicates repeated logical boundaries per `(run_id, kind, phase, attempt)`, so a future workflow that needs multiple events with the same tuple must add a new kind or amend the key formula. The events table still has no storage-level `CHECK` constraint for the kind enum; TypeScript and Zod are the source of truth for this phase.

Open question: future OTel/task linkage can populate the nullable `task_id`, `trace_id`, `span_id`, and `parent_span_id` columns, but that linkage is outside packet-1h Phase C.
