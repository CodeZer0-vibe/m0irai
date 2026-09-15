# ADR-008 — Diagnostic scripts MUST NOT import `src/evidence/db.ts`

**Status:** Accepted
**Date:** 2026-05-05
**Source:** codex hostile critique §"production risk: diagnostic scripts must not use src/evidence/db.ts because openDb applies schema and migrations"

## Context

`src/evidence/db.ts:openDb()` is the canonical DB-open entry point for production code. It applies pragmas, applies schema, applies migrations, asserts version. This is correct for production: every code path that opens the DB ensures it's at the expected version.

Diagnostic scripts have OPPOSITE requirements:

- MUST NOT migrate (they're read-only)
- MUST detect schema drift and report it (not silently fix it)
- MUST function on a DB whose version is older or newer than the script knows about
- MUST work even when the DB is in a broken state (corruption, lock, partial migration)

If `scripts/diagnose/*.mjs` calls `openDb()`, the diagnostic invocation itself MUTATES the DB it's supposed to be diagnosing. That's a correctness violation: the diagnostic changed the state.

## Decision

**Diagnostic scripts open SQLite directly with `new Database(path, { readonly: true })`.**

Specifically:

- `scripts/diagnose/_lib.mjs` exports `openDbReadonly(path)` that wraps `new Database(path, { readonly: true, fileMustExist: true })`
- Diagnostic scripts call `openDbReadonly`, NEVER import from `src/evidence/db.ts`
- Schema drift is detected by querying `_schema_version` and reporting; the script does NOT call `applyMigrations`
- DB unreadable / locked → diagnostic returns a structured `DiagnosticReport` with `dbReadable: false` and `recommendation: "RECOVERY_REQUIRED"`, exit code 0 (the diagnostic SUCCEEDED at finding a problem, even if the problem is severe)

## Consequences

**Positive:**

- Running diagnostics never mutates evidence — invariant preserved
- Diagnostic scripts work on locked DBs (read-only mode tolerates concurrent writers from a running zer0)
- Schema drift becomes a FINDING, not a hidden migration
- A v3-script running against a v2-DB still produces useful output (e.g., "this DB is on v2; run `zer0 doctor --migrate` to upgrade")

**Negative:**

- Diagnostic scripts duplicate some DB-open logic (pragmas, error mapping) — MITIGATED by `_lib.mjs` centralization
- Two open-paths to maintain — MITIGATED by `tests/integration/offline-diagnose.test.ts` exercising both via the same fixture DB

## Mechanically enforced

The packet-10 brief Section 3 hard constraint #2 + Section 14 acceptance gate test "diagnostic scripts open DB read-only — assert DB is byte-identical before and after script run". Both must pass.

`_lib.mjs:openDbReadonly` signature:

```js
export function openDbReadonly(path) {
  return new Database(path, { readonly: true, fileMustExist: true });
}
```

That's it. No pragmas (won't take effect on read-only), no migrations, no version assertions. Caller checks `_schema_version` table for drift detection.
