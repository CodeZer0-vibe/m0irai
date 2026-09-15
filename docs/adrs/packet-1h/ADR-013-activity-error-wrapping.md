# ADR-013 - Activity error wrapping via ApplicationFailure with Zer0ErrorCode types

**Status:** Proposed
**Date:** 2026-05-09
**Source:** packet-1h Phase A
**Builder:** codex

## Context

The 2026-05-09 empirical inspection of `zer0 start "<vibe>"` surfaced an architectural defect: `dispatchAgent` activity threw a `DispatchError` with an `ENOENT` cause; Temporal's worker logged `attempt: 9` and counting, with `durationMs: 1` per attempt. The workflow hung indefinitely on a terminal config failure.

Root cause: Temporal's `nonRetryableErrorTypes` retry-policy field matches against `ApplicationFailure.type`. Activities that throw raw `Error` subclasses (`DispatchError`, `ConfigError`, `ContextError`) cannot be matched by `type`, so the retry policy is bypassed.

Ten throw sites across nine activity files in `buildPacketWorkflow`'s call graph need wrapping. Each must produce an `ApplicationFailure` carrying:

- `type` - the literal `Zer0ErrorCode` string (`ZER0_*`)
- `nonRetryable` - derived from `ERROR_CODE_METADATA[code].retryability !== "yes"` (single source of truth)
- `message` - diagnostic text
- `cause`, `details` - preserved evidence

## Decision

Use a single shared `failureFor` helper in `src/shared/application-failure.ts` to construct Temporal `ApplicationFailure` instances from `Zer0ErrorCode` values. The helper reads retryability from `ERROR_CODE_METADATA`, so retry semantics stay catalog-driven instead of being copied across activity files.

Wrap Phase 1 activity exports with `activityErrorBoundary`. The boundary passes existing `ApplicationFailure` instances through unchanged, converts `z.ZodError` from activity input and boundary parsing to `ZER0_SCHEMA_VALIDATION_FAILED`, and lets unrelated raw errors propagate for the workflow retry policy to handle by class name when configured.

Replace the ten catalogued activity throw sites with `failureFor` or `rethrowAs`, preserving each site's assigned `Zer0ErrorCode` and diagnostic message.

## Alternatives considered

1. Raw Error plus workflow-side adapter. Rejected because activity retry classification happens before workflow code can inspect the failure, so terminal schema/config errors can still consume retry attempts incorrectly.
2. ApplicationFailure subclass per code. Rejected because Temporal matches `ApplicationFailure.type`, not JavaScript subclasses, and a class per code would duplicate catalog retryability.
3. Single `failureFor` helper derived from catalog. Accepted because it creates the type Temporal needs, keeps retryability in one source of truth, and keeps each activity site small enough for gate clamps.
4. Wrap only the ten explicit throw sites. Rejected because Zod `.parse()` failures are the larger retry-policy surface and must be converted at the activity export boundary.

## Consequences

- Phase 1 activities now emit stable `ZER0_*` failure types for known terminal activity errors.
- Zod validation failures become non-retryable `ApplicationFailure` instances with issue details preserved for evidence and reviewer diagnosis.
- Existing `ApplicationFailure` values from git and dispatch timeout paths continue to pass through without double wrapping.
- Activity tests must assert Temporal failure fields directly because thrown text alone no longer proves retry-policy behavior.
- Legacy pipeline evidence activities remain unwrapped except for the catalogued config failure conversion; full pipeline migration is Phase 2 scope.
