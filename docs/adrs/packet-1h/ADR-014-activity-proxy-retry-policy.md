# ADR-014 — Activity proxy retry policy on buildPacketWorkflow

**Status:** Proposed
**Date:** 2026-05-09
**Source:** packet-1h Phase B
**Builder:** codex (fills Decision / Alternatives / Consequences during Phase B build)

## Context

**Empirical incident — 2026-05-09.** `zer0 start "Add a /health endpoint..."` (run id `run-febbb606-fd42-4cc5-a726-91e87e672baa`) hung indefinitely at `phase build | progress 8/12 | BUILD-temporal-round-trip` with `0 dispatches | 0 tokens` for 25+ seconds. Worker log showed `dispatchAgent` activity throwing `DispatchError ZER0_CONTEXT_READ_FAILED` at `dispatch.ts:243` with `attempt: 9` and counting (`durationMs: 1` per attempt — fast ENOENT, infinite retry). The failure surfaced because the proxy declared no retry policy.

The same defect class affects `buildPacketWorkflow.proxyActivities` at `src/temporal/workflows/build-packet.ts:71`: it declares `proxyActivities<BuildPacketActivities>({ startToCloseTimeout: ACTIVITY_TIMEOUT })` — no retry policy. Temporal's default applies: infinite retries with exponential backoff. Combined with the Phase A error-wrapping work, terminal failures (`type ∈ NON_RETRYABLE_ERROR_TYPES`) must fail fast; transient failures (`yes`-retryable codes like `ZER0_TEMPORAL_UNREACHABLE`, `ZER0_DB_LOCKED`, `ZER0_AGENT_TIMEOUT`, `ZER0_AGENT_RATE_LIMITED`) must retry up to a bounded `maximumAttempts` then propagate.

`NON_RETRYABLE_ERROR_TYPES` is derived once from `ERROR_CODE_METADATA` (single source of truth) so adding/changing a code's retryability automatically updates the workflow proxy's policy.

The `dispatchAgentActivity` proxy's `timeoutMs` per phase (`Phase` schema) can be 1.8M ms (30 min). With `maximumAttempts: 3` the worst-case retry budget for one activity is ~90 min. Trade-off documented in the Decision.

Note: Temporal's `RetryPolicy.nonRetryableErrorTypes` is typed `string[]` (mutable). The exported constant is `readonly string[]`; the workflow site spreads `[...NON_RETRYABLE_ERROR_TYPES]` into the proxy options to satisfy the SDK type without mutating the source.

## Decision

Use one `buildPacketWorkflow` activity proxy retry policy derived from the shared error catalog:

```ts
retry: {
  initialInterval: "1 second",
  maximumInterval: "30 seconds",
  backoffCoefficient: 2,
  maximumAttempts: 3,
  nonRetryableErrorTypes: [...NON_RETRYABLE_ERROR_TYPES],
}
```

`maximumAttempts: 3` gives transient infrastructure failures two retries without recreating the prior infinite retry failure mode. The one-second initial interval keeps fast transient failures cheap, `backoffCoefficient: 2` avoids tight retry loops, and `maximumInterval: 30 seconds` bounds scheduler delay if a retryable activity fails immediately.

The retry stop list comes from `NON_RETRYABLE_ERROR_TYPES`, derived from `ERROR_CODE_METADATA` entries whose `retryability` is not `"yes"`. This keeps the workflow policy aligned with the stable catalog used by activity `ApplicationFailure.type` values.

The long-running activity trade-off is accepted explicitly. A phase activity can run for 30 minutes; with three attempts plus retry backoff, the worst-case wall-clock budget for one repeatedly failing activity is about 91 minutes. This is still bounded and observable, unlike Temporal's default unbounded retry behavior.

## Alternatives considered

1. Per-activity `proxyActivities` policies. This permits shorter retry budgets for fast activities and longer budgets for dispatch activity calls, but it fragments the build workflow activity surface and creates more places for catalog drift.

2. Single conservative policy with `maximumAttempts: 1`. This fails terminal and transient activity errors quickly, but it throws away safe recovery for retryable Temporal, SQLite lock, timeout, and rate-limit failures already represented in the catalog.

3. Single liberal policy with more than three attempts. This improves recovery odds for flaky infrastructure, but a 30-minute dispatch activity multiplied by a larger attempt count creates multi-hour workflow stalls before escalation.

4. Raw Temporal defaults. This keeps the current proxy declaration small, but it recreates the observed infinite retry incident and leaves terminal catalogued failures unable to stop workflow progress.

## Consequences

- Terminal catalogued failures fail fast when activities throw `ApplicationFailure` with a type in `NON_RETRYABLE_ERROR_TYPES`.
- Retryable catalogued failures retain bounded automatic recovery for transient service, database, timeout, and rate-limit conditions.
- Adding a new non-`"yes"` retryability code updates the workflow stop list through the shared catalog instead of another hand-maintained array.
- A single repeatedly failing 30-minute activity can consume about 91 minutes before surfacing its final failure.
- The workflow site must spread the readonly constant into a mutable SDK array shape, preserving the exported constant as frozen shared state.
