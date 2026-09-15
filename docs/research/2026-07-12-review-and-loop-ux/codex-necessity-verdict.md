# Independent Verdict: Diff Review

## Plain-Words Summary

Yes, zer0 needs a review moment, but not because the operator should read code diffs. The needed product is a **control card**: “what changed, why it matters, risk, keep, undo, send it back.” The raw diff is secondary and should be hidden unless requested.

The current full-screen review is the wrong default. It asks a non-coder to behave like a code reviewer, leaks internal machinery, and breaks the cockpit flow. The redesigned inline-card direction is basically right, but only if the card is about **control, reversibility, and steering**, not prettier diff lines.

My verdict: **needed-but-different**.

## Steelman Against

The strongest argument against diff review is real: non-coders cannot reliably judge code quality from line changes. The research says 61.38% of AI PRs get no recorded review, and 93% of Claude Code permission prompts are approved unchanged. That is review theater, not safety.

Aider and Replit prove a shippable trust model can be **apply first, then undo**. Replit explicitly bets on checkpoints and rollback for non-coders, while Lovable moves review to the outcome layer: “what does it do now,” not “what lines changed.”

So if “diff review” means “make the operator read patches,” kill it. That surface will be ignored, and worse, it will train reflexive approval. The existing full-screen UI already shows why: hidden navigation, no useful operator language, raw binary noise, and internal “force-agent-to-chunk” copy at [diff-review-model.ts](C:/Users/mianc/VibeCoding/zer0-agent-ci/src/tui/diff-review-model.ts:499).

## Steelman For

The strongest argument for keeping a review moment is also real: zer0 is a **control tower**, not a background code generator. The operator’s job is not to parse code, but to approve, undo, redirect, and stop dangerous work.

The data does not say “remove control.” Cursor/Windsurf users revolt when accept/reject disappears. Human review comments on AI PRs are disproportionately steering commands, and zer0 already has the steering loop: `enqueueRedirect`, delivery, recovery, resend/cancel, and repair state at [review-redirect.ts](C:/Users/mianc/VibeCoding/zer0-agent-ci/src/chat/review-redirect.ts:152) and [review-redirect-delivery.ts](C:/Users/mianc/VibeCoding/zer0-agent-ci/src/chat/review-redirect-delivery.ts:202).

The code also has real apply/undo machinery. Keep is a DB decision over bytes already on disk at [diff-apply.ts](C:/Users/mianc/VibeCoding/zer0-agent-ci/src/chat/diff-apply.ts:62). Reject/rollback are hash-guarded and conflict-aware at [diff-apply-rollback.ts](C:/Users/mianc/VibeCoding/zer0-agent-ci/src/chat/diff-apply-rollback.ts:457). Pending unresolved reviews are queryable at [diff-review-read.ts](C:/Users/mianc/VibeCoding/zer0-agent-ci/src/chat/diff-review-read.ts:25). That is valuable machinery.

## Verdict On Need

**Needed-but-different.**

| Component | Verdict | Why |
| --- | --- | --- |
| Raw diff lines | Optional escalation | Useful for technical inspection, not the main non-coder decision surface. |
| Plain receipts | Needed | They create accountability without blocking flow. |
| One-key undo | Essential | This is the trust engine for apply-then-keep/undo. |
| Steer/comment button | Essential | This is how humans actually review agents: “fix this / redo that.” |
| Risk signals | Essential | The card must counter false confidence, not reassure. |
| Hard risk stops | Essential but not fully present | Current risk tags exist, but approve-disabled only covers unattributed combined writes at [diff-review-scale.ts](C:/Users/mianc/VibeCoding/zer0-agent-ci/src/tui/diff-review-scale.ts:88). Package/schema/delete/deploy stops still need real policy. |
| Full-screen view | Keep as fallback | Use for large/complex inspection, not default. |
| Outcome testing | Needed adjacent layer | For a non-coder, “run it and see” is often more honest than diff reading. |

## Will It Work In Zer0?

Probability the redesigned inline surface gets used by this operator: **60-70% if it is a compact control card**. Probability the operator reads actual diff lines regularly: **under 20%**. Probability the current full-screen review becomes ignored after novelty: **high, around 80%**.

It can work because zer0 already has the hard parts: capture/checkpointing, persisted review rows, grouped/ranked review trees, undo, pending review recall, and redirect/repair. The main code risk is not the engine; it is identity and focus. Today `ReviewModelState` does not carry `reviewId`, and the decision hook separately tracks the latest `review.ready`, which is race-prone in multi-agent completion at [use-review-decisions.ts](C:/Users/mianc/VibeCoding/zer0-agent-ci/src/tui/use-review-decisions.ts:18). The inline card must be id-bearing.

## Failure Modes

It becomes dead weight if:

- The card leads with code diff instead of operator meaning.
- It interrupts typing or floods chat when three agents finish.
- “Keep” is implied visually but not recorded through the real DB decision path.
- Risk is decorative, with no hard stops for dangerous classes.
- `/review` recall and pending count are weak, so ignored cards disappear from memory.
- Undo is partial or unclear about whether it means this group, this turn, or everything.
- The steer button only records a comment but does not reliably create a repair round-trip.
- The UI keeps leaking internals like `force-agent-to-chunk`.
- It lacks visible key hints and repeats the current full-screen navigation trap.

## Minimum Design That Avoids Waste

Build the smallest serious version:

- One dynamic card above the composer: agent, files touched, plain outcome, risk tags.
- Buttons/keys: `Enter/Space` keep, `u` undo this change-set, `c` send note back, `f` full view.
- The card owns a `reviewId`; every decision uses that exact id.
- After action, card disappears and appends a one-line receipt.
- Pending count lives in the composer/status area; `/review` recalls unresolved reviews.
- Raw diff is collapsed by default; binary/huge/generated files get summaries.
- High-risk classes require explicit action even in auto/notify flows.
- Outcome testing is surfaced separately: “run/check this” belongs near the review loop.

## Difference From Synthesis

I mostly agree with the synthesis’ inline-card direction. My correction is sharper: **do not call the product value “diff review.”** The value is **operator control after applied work**. Diff lines are only one evidence source.

Also, the synthesis treats hard stops as part of the recommended design, but the current code I read does not yet show the full hard-stop policy implemented. That must not be hand-waved.

## Verification

Read-only only. I inspected the research folder, diff capture/apply/rollback/undo/redirect code, review modes, pending review recall, current full-screen TUI, keymaps, and package scripts. No files changed. I did not run tests or gates because this was a read-only product/code judgment and no code changed.

Confidence: **YELLOW 88%**. Strong on product direction and code feasibility. Below GREEN because I did not run the TUI live and did not inspect every prior task behind the sealed nine-task redesign.

