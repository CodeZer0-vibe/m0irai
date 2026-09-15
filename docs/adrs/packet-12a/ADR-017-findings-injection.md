# ADR-017 - Inject persisted review findings into next-attempt context

**Status:** Proposed
**Date:** 2026-05-10
**Source:** packet-12a Phase A
**Builder:** codex

## Context

Empirical incident: packet-1h Phase D, 2026-05-10. Codex shipped working integration tests, but the reviewer blocked the commit on an ADR gap. The blocking signal collapsed to `"review blocked phase"` by the time it reached `prepareContextActivity` for attempt 2, with no file, line, severity, or concrete message. Three follow-up attempts spent roughly 90 minutes solving the wrong problem.

Audit findings F1 and F2 shipped the prerequisites. `dispatchReviewActivity` persists every `ReviewFinding` into `evidence.findings(run_id, task_id, severity, path, line, finding, ...)`, and `recordReviewFailure` pushes one structured `AttemptFailure` per blocking finding into the current fix loop.

Phase A adds the cross-attempt piece: `prepareContextActivity` reads persisted findings by `runId` and renders them into the next builder prompt as a `## PRIOR REVIEW FINDINGS` section. The current findings table does not persist suggested fixes or dimensions, so this ADR keeps the rendering limited to columns that already exist.

## Decision

Render persisted findings as numbered prompt lines under:

`## PRIOR REVIEW FINDINGS (persisted from earlier reviews this run)`

Each row uses `[severity] path:line - message`. Rows with no path render as `packet`; rows with no line omit the line suffix. Messages are capped at 200 characters and two source lines, with overflow marked by `...`.

`findFindingsByRunId(runId)` reads only persisted columns from `evidence.findings`: `severity`, `path`, `line`, `finding`, and `source_agent`. It sorts severity in P0, P1, P2 order and newest row first within each severity.

`compileFindings` uses a hybrid relevance rule: every P0 is included, while P1 and P2 findings are included only when `path` is in `phase.ownedFiles + phase.moduleMapRows`. `prepareContextActivity` requests at most 20 findings and appends the section after the existing canonical brief assembly, then runs the existing context line budget check again.

## Alternatives considered

- Dump all findings without filtering. Rejected because long packet runs can accumulate enough rows to bury the current phase brief.
- Filter only by severity. Rejected because a P1 in the owned module can be more actionable than an unrelated warning in another subsystem.
- Filter only by relevant path. Rejected because cross-file P0s are still blocking context for the run, even when the current phase owns a narrower file set.
- Use the hybrid rule. Chosen because it keeps P0s visible across phase boundaries while preserving token budget for path-local P1/P2 details.

## Consequences

- Positive: the next builder attempt sees concrete persisted review targets instead of only a generic review-blocked message. The audit estimate for review-blocked phases is roughly 50% fewer fix-loop attempts.
- Negative: prompt text can grow by roughly 50 to 100 lines on noisy runs. The `maxFindings: 20`, per-message cap, and section cap bound the growth.
- Open: cross-packet finding inclusion belongs to packet-12b Memory Model.
- Open: dimension and suggested-fix persistence belongs to packet-12c schema work.
