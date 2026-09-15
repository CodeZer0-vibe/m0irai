# ADR-007 — 5 standalone diagnostic `.mjs` scripts (not a single `zer0 diagnose`)

**Status:** Accepted
**Date:** 2026-05-05
**Source:** codex hostile critique §"Top 5 diagnostic scripts" + claude synthesis §"Surface A"

## Context

External agents need to diagnose without zer0 running. The naive approach is one big `zer0 diagnose [--what=...]` command that does everything. But this defeats the external-first invariant (ADR-005): if zer0 is broken, the `zer0` CLI binary itself may not run.

Three options:

1. **Single `zer0 diagnose [run-id] [--option=...]`** — one command, multiple subcommands; requires zer0 to be installed and runnable
2. **Single bash entry-point script `bin/zer0-diagnose.sh`** — wrapper that needs jq + sqlite3 + bash compatibility
3. **5 focused `.mjs` scripts** — `last-run.mjs`, `inspect-run.mjs`, `failure-context.mjs`, `trace-error.mjs`, `integrity-check.mjs`. Each runs with plain `node scripts/diagnose/*.mjs`. No build step, no compiled TS, no runtime deps beyond `better-sqlite3`.

## Decision

**5 standalone `.mjs` scripts in `scripts/diagnose/` plus a shared `_lib.mjs`.**

Specifically:

- `scripts/diagnose/last-run.mjs` — find latest run from DB + state.json files
- `scripts/diagnose/inspect-run.mjs` — full RunInspection JSON
- `scripts/diagnose/failure-context.mjs` — agent-ready repair brief (THE killer feature)
- `scripts/diagnose/trace-error.mjs` — historical search by error code
- `scripts/diagnose/integrity-check.mjs` — DB + blob + snapshot health
- `scripts/diagnose/_lib.mjs` — shared helpers (`openDbReadonly`, `resolveBlob`, `readStateSnapshot`, `validateAgainstSchema`)

Each script:

- Plain ES module (`.mjs`), runs with `node scripts/diagnose/<name>.mjs --root <repo> [--json]`
- Imports ONLY: `node:*` builtins, `better-sqlite3` (npm), `./_lib.mjs` (relative)
- NO imports from `src/` (per ADR-008 + brief hard constraint #2)
- Outputs human-readable markdown by default; `--json` flag emits validatable JSON

## Consequences

**Positive:**

- Each script has ONE responsibility — easier to debug when one fails
- A fresh `claude -p` session can `node scripts/diagnose/failure-context.mjs --run-id X` and get a repair brief without installing zer0 or running TS
- Plain `.mjs` means no build step, no compile errors, no version mismatches
- Scripts are TINY (each <250L) — agents can read the source to understand what they do
- Adding a 6th diagnostic script later doesn't bloat existing ones

**Negative:**

- Some shared logic between TS (`src/observability/inspect.ts`) and JS (`scripts/diagnose/inspect-run.mjs`) — accepted per ADR-005
- 5 separate entry points instead of 1 — MITIGATED by `.zer0/AGENT-GUIDE.md` listing all 5 with one-line purposes; agents read the guide first
- No CLI argument library used — MITIGATED by simple `process.argv` parsing (per `feedback_no_commander.md` memory: project prefers raw argv)

## The "failure-context.mjs" is the killer feature

When something breaks, the typical agent debugging flow is:

1. Read SQLite manually with sqlite3 CLI ← painful
2. Cross-reference blob hashes to file paths ← tedious
3. Reconstruct the failure timeline from gate_transitions ← error-prone
4. Write a fix proposal ← finally

`failure-context.mjs` does steps 1-3 automatically and outputs a markdown brief PLUS sidecar JSON. The agent just reads `failure-context.md`, proposes a fix.

Output structure of `failure-context.md`:

```markdown
# Failure Context Brief — run 01HX...

## What broke (failing command + error code + suggested action from catalog)

## Where (file:line citations from latest stderr blob)

## Why (causal chain — ordered events from events table)

## Suggested next files to inspect (derived from dispatches.argv_json + repo_commit diff)

## How to reproduce (zer0 replay <dispatch-id> command + frozen context location)

## Known prior occurrences (errors.fingerprint matches)
```

This is what makes the system "see-through to code agents" — the abstract goal becomes a concrete file the agent can read.
