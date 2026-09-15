# ADR-018 - Inject prior-attempt git diff into next-attempt context

**Status:** Proposed
**Date:** 2026-05-10
**Source:** packet-12a Phase A
**Builder:** codex

## Context

Before this change, the workflow reverted failed review commits and removed their SHAs from `state.commits`. The next attempt received structured review failures, but it could not inspect the code that had just failed. That made the fix loop reason from reviewer text alone.

Packet-12a records the most recent reverted SHA in workflow state before popping the commit. `prepareContextActivity` receives that SHA and can render the reverted commit diff into the next prompt. Combined with persisted findings, the next attempt sees both the reviewer complaint and the attempted code.

## Decision

Add `state.lastRevertedSha?: string` to `WorkflowState`. `recordReviewFailure` sets it to the just-reverted commit SHA before `state.commits.pop()`. A phase pass clears it because only the most recent reverted attempt is relevant to the next retry.

`compileDiff` runs:

`git show --pretty=format: <sha>`

The command uses `shell: false`, `reject: false`, and a 60 second timeout. A missing SHA returns an empty section. A nonzero exit code or empty stdout logs a warning and also returns an empty section, so transient git object availability issues do not escalate the workflow.

Successful output renders under:

`## PRIOR ATTEMPT DIFF (commit <sha>, reverted before this attempt)`

The section is capped to 200 diff lines in `prepareContextActivity`, with a footer pointing to `git show <sha>` for the full diff.

## Alternatives considered

- Dump full diffs for every prior attempt. Rejected because the prompt cost grows with each fix loop and older attempts are less actionable than the latest revert.
- Show only the last reverted commit. Chosen because it gives the freshest code signal with a stable budget.
- Recover prior attempts from reflog entries. Rejected because reflog availability varies across cleanup, clone, and garbage collection behavior.
- Show only `git log --stat`. Rejected because filenames and line counts do not show the code that caused the review failure.

## Consequences

- Positive: the next builder attempt can compare the actual attempted code against persisted review findings.
- Positive: prompt growth is bounded by the 200-line diff cap.
- Negative: older reverted attempts are not shown.
- Open: cross-attempt diff comparison belongs to packet-12c.
