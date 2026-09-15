# ADR-011 — Datadog/Sentry-style error fingerprinting

**Status:** Accepted
**Date:** 2026-05-05
**Source:** gemini synthesis §"Datadog/Sentry: their approach of grouping thousands of errors into a single 'Issue' via a fingerprint (hash of stack trace + message) is key"

## Context

Append-only `errors` table (ADR-003) means a flaky agent that hits the same `ZER0_AGENT_DISPATCH_FAILED` error 100 times across 50 runs creates 100 rows. Useful for full causal history; useless for "what's actually broken?" Without grouping, a Diagnoser agent reading 100 rows treats them as 100 distinct problems.

Production observability platforms (Datadog, Sentry, Honeycomb) solve this by **fingerprinting**: hashing the error's invariant features (code + normalized message + top stack frame) into a stable identifier. All occurrences with the same fingerprint are the "same issue".

## Decision

**Every `errors` row carries a `fingerprint` column. Diagnostic queries GROUP BY fingerprint.**

Fingerprint computation in `src/observability/fingerprint.ts`:

```ts
export function fingerprint(args: {
  code: Zer0ErrorCode;
  message: string;
  stack?: string;
}): string {
  const normalizedMessage = normalizeMessage(args.message); // strip ULIDs, paths, timestamps, hex hashes
  const topFrame = args.stack ? extractTopFrame(args.stack) : "";
  const input = `${args.code}${normalizedMessage}${topFrame}`;
  return sha256(input).slice(0, 16); // 16 hex chars = 64 bits, plenty for grouping
}
```

`normalizeMessage(s)`:

- Replace ULID matches with `<ULID>`
- Replace absolute paths with `<PATH>`
- Replace ISO timestamps with `<TS>`
- Replace SHA-256 hex with `<SHA>`
- Replace decimal numbers with `<N>`
- Trim/collapse whitespace

`extractTopFrame(stack)`:

- Take first line that contains `(` and `:` (a stack frame, not a header)
- Strip absolute paths from it (replace with `<PATH>`)
- Strip line numbers (replace `:N:N` with `:<L>:<C>`)

Index: `CREATE INDEX idx_errors_fingerprint ON errors(fingerprint)`.

## Consequences

**Positive:**

- `trace-error.mjs --code <code>` outputs grouped view: "this error has 3 distinct fingerprints, occurring 20/15/3 times"
- Diagnoser agent (packet-12) checks fingerprint against KNOWN issues before dispatching new diagnosis — saves tokens on repeats
- Repeat-offender detection: `agent_failure_patterns` table can use fingerprint as the dedup key
- Failure-context.mjs surfaces "this is the 4th occurrence; here are the 3 prior runs that hit it"

**Negative:**

- Normalization rules can over-collapse (different errors hash to same fingerprint) or under-collapse (same error hashes differently due to ULID-in-message) — MITIGATED by `fingerprint.test.ts` covering: same code+message → same fingerprint, same code with ULID-replaced → same fingerprint, different stack frame → different fingerprint
- Stack frame extraction is heuristic — TS source maps aren't always present in node-runtime errors. ACCEPTED: missing stack falls through to `code + normalizedMessage` only

## Test invariants

`fingerprint.test.ts` MUST cover:

1. Identical inputs → identical fingerprint (deterministic)
2. ULID-only difference in message → identical fingerprint (normalization works)
3. Path-only difference in message → identical fingerprint
4. Different error code → different fingerprint
5. Different top stack frame → different fingerprint
6. Missing stack → still produces stable fingerprint from code+message
7. Empty/null message → throws (defensive: never produce fingerprint of nothing)
