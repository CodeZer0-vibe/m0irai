# ADR-019 - Falsifying integration test for context compiler fix-loop convergence

**Status:** Proposed
**Date:** 2026-05-10
**Source:** packet-12a Phase D
**Builder:** codex

## Context

Per locked feedback `feedback_falsifying_test_mandatory_for_gates`, every analysis gate or invariant claim must ship with a falsifying test. Without one, the gate may pass vacuously. Phase A + Phase B make a load-bearing claim:

> When `dispatchReviewActivity` returns specific findings on attempt 1, the context pack passed to `dispatchAgentActivity` on attempt 2 contains those findings' file:line and message verbatim, plus the last reverted attempt diff.

This invariant cannot be unit-tested alone because the chain crosses three boundaries: `dispatchReviewActivity` persists findings, `buildPacketWorkflow.recordReviewFailure` saves `lastRevertedSha`, and `prepareContextActivity` compiles the next prompt. It requires an integration test that drives the real `buildPacketWorkflow` against a controlled Temporal activity environment.

## Decision

Use `TestWorkflowEnvironment.createTimeSkipping()` with a real `Worker.create({ activities, workflowsPath, taskQueue })` registration. The worker keeps production `prepareContextActivity`, `compileFindings`, `compileDiff`, `commitActivity`, and `revertCommitActivity` in the path. It injects controlled seams only at agent dispatch, review dispatch, and gates:

- `dispatchAgentActivity` still runs, but its subprocess function reads the generated prompt file, captures `promptText`, writes the phase owned files, and returns a successful dispatch result.
- `dispatchReviewActivity` still runs, but its reviewer function returns a P0 finding on the first repair review and PASS afterward, so the activity persists the finding to the isolated evidence database.
- `runGatesActivity` still runs, but its subprocess function returns a successful gate result to keep the test focused on fix-loop context assembly.
- Each test creates a temp git repo and SQLite database, sets `ZER0_DB_PATH` and `ZER0_TRACKING_ROOT`, and tears them down in `finally` plus `afterEach` restoration.

The falsifying assertions inspect the second repair prompt and require the `## PRIOR REVIEW FINDINGS` header, `src/x.ts:42`, `missing nullcheck`, the `## PRIOR ATTEMPT DIFF` header, and the SHA prefix of the reverted first repair commit. A negative-path test verifies that when the first repair review passes, no second repair prompt is captured.

## Alternatives considered

- Workflow replay against recorded history: rejected because replay validates deterministic workflow decisions, not the prompt text produced by activity execution.
- End-to-end run against real codex and claude dispatchers: rejected because CI would spend external agent quota and add slow, flaky network and CLI dependencies to a regression test.
- Unit tests for `context-compiler.ts` and `diff-compiler.ts` only: rejected because those tests cannot prove workflow state carries `lastRevertedSha` or that review findings persist before the next prompt is prepared.
- Controlled `TestWorkflowEnvironment` worker: chosen because it preserves the real workflow and production compiler activities while exposing prompt content for direct assertions.

## Consequences

- Positive: dropping persisted findings from `prepareContextActivity` breaks a gate-time test instead of silently degrading fix-loop prompts.
- Positive: dropping `lastRevertedSha` plumbing or breaking `compileDiff` removes the diff header or SHA substring and fails the test.
- Positive: the test complements lower-level dispatch-review persistence coverage by exercising the "review to DB to next-attempt prompt" chain.
- Negative: the fixture is sensitive to manifest and prompt format changes because it extracts phase, attempt, and commit SHA from generated prompt text.
- Negative: the test starts a Temporal test environment and git repo, so it is heavier than a unit test.
- Open: measuring whether average fix-loop attempts decrease requires real dispatch telemetry and is outside this falsifying gate test.
