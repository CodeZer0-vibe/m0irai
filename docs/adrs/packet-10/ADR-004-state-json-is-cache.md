# ADR-004 — `state.json` is a CACHE, SQLite is TRUTH

**Status:** Accepted
**Date:** 2026-05-05
**Source:** codex hostile critique §"production risk: state.json must be a read-only projection, not a second workflow state machine"

## Context

`.zer0/runs/{runId}/state.json` is a 50-field JSON snapshot per run, intended for crash-readable diagnosis when an external agent can't query SQLite. Two design temptations to resist:

1. **Make state.json the canonical state and SQLite a derived index** — would mean activities update state.json directly, SQLite is rebuilt from state.json on demand. Simpler in some ways, but creates a parallel state machine that can drift.
2. **Make state.json a cache projection of SQLite** — SQLite is canonical; state.json is regenerated from SQLite on phase transitions. Crash-readable, but never authoritative.

## Decision

**SQLite is canonical. state.json is a cache projection.**

Specifically:

- Activities and CLI commands write to SQLite first (workflow + queries.ts), THEN regenerate state.json from the just-written DB rows.
- Diagnostic scripts MAY read state.json for fast latest-status without touching DB; if state.json is stale (tested via `integrity-check.mjs`), they fall through to DB query.
- If state.json is missing entirely, `inspect-run.mjs` rebuilds it from DB rows on demand.
- state.json is REGENERATED, never PATCHED — every write replaces the whole file (atomic temp+rename per ADR-implicit-atomicity).

## Consequences

**Positive:**

- Single source of truth — no "which one is right?" debate during diagnosis
- state.json corruption or deletion is recoverable: rebuild from SQLite
- External agents have a 5ms read path (`fs.readFileSync('state.json')`) for the 80% case ("what's the current phase?") without opening SQLite
- Concurrent writers don't fight over state.json — last writer's snapshot wins (monotonic sequence rejects out-of-order writes per state-writer.ts)

**Negative:**

- state.json can be slightly stale between writes — MITIGATED by `integrity.snapshotConsistentWithDb` field in state.json itself, which integrity-check.mjs validates
- Two writers on the same DB transaction — MITIGATED: workflow only writes state.json after DB transaction commits; ordering guaranteed by Temporal activity sequencing
- The diagnostic agent might read a state.json from before the latest DB write — NOT a bug, just a freshness window <100ms in practice

## Implementation invariant

`StateWriter.update(patch)`:

1. Reads current state.json (if exists)
2. Validates `incoming.sequence > current.sequence` else throws `ConcurrentWriteError`
3. Writes to `state.json.tmp.{pid}.{sequence}`
4. `fs.renameSync(tmp, real)` — atomic on POSIX, atomic-on-same-filesystem on Windows NTFS
5. Never `fs.writeFileSync(path, ...)` directly — that's a partial-write risk

The `integrity.snapshotConsistentWithDb` boolean is computed at write time by comparing snapshot fields to a fresh DB query; if false, the writer LOGS but still writes (the snapshot says "I might be stale, verify against DB").
