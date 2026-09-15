# ADR-001 — ULID for all generated IDs

**Status:** Accepted
**Date:** 2026-05-05
**Source:** gemini synthesis (`.council/cross-model/packet-10-gemini-result.md` §"Top 5 forward-compat decisions" #1)

## Context

Run IDs, task IDs, dispatch IDs, finding IDs, error IDs, event IDs, council message IDs all need unique generation. Earlier prototype used `run-{YYYYMMDD}-{base32hex(8)}`. Three options weighed:

1. **UUID v4** — random, 36 chars, no time order, requires separate timestamp index for chronological queries
2. **`run-{date}-{hex}`** — readable but verbose, custom format requires custom parsing
3. **ULID** — 26-char Crockford base32, lexicographically sortable, time-ordered (millisecond precision in first 48 bits), 80 bits of randomness

## Decision

**ULID via `ulid` npm package (~1KB).** All generated IDs use `newId()` from `src/shared/ids.ts`.

Branded type aliases per entity: `RunId`, `TaskId`, `DispatchId`, `EventId`, `ErrorId`, `FindingId`. All are `string & { readonly __brand: ... }` to prevent passing one ID type where another is expected.

## Consequences

**Positive:**

- `ORDER BY id` gives chronological order without separate timestamp index
- 26 chars vs UUID's 36 — narrower DB columns, smaller indexes
- Crockford base32 is human-distinguishable (no 0/O, 1/I/L confusion)
- 80 bits of randomness means collision probability is negligible at our scale

**Negative:**

- New dependency (`ulid ^3.0.2`) — counts against codex constraint #6 in build brief; documented exception
- IDs are no longer human-readable (UUID also wasn't, so no regression)
- Tests must use deterministic ULIDs (use `monotonicFactory` with frozen seed) to avoid flaky output ordering

## Implementation note

`src/shared/ids.ts` exposes:

```ts
export function newId(): string; // wraps ulid()
export function newRunId(): RunId; // branded
export function newTaskId(): TaskId; // branded
export function newEventId(): EventId; // branded
export function newErrorId(): ErrorId; // branded
export function newDispatchId(): DispatchId; // branded
export const ULID_REGEX: RegExp; // for Zod validation
```

Tests use `seedMonotonicUlid(epochMs)` helper for deterministic fixtures.
