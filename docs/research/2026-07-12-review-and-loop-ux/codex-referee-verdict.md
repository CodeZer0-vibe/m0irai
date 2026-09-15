# inline-review-referee-verdict.md

## 1. Referee Findings

| # | Verdict | Claim | Referee finding | Evidence |
| --- | --- | --- | --- | --- |
| 1 | VALID | Inline beats full-screen takeover | Valid direction, but only if it is a designed card, not raw diff text dumped into history. | Research: progressive card, not raw inline diff, `.council/.../user-research-sourced.md:9-18`, `101-118`. Current UI replaces composer while `screen === "diff-review"`: `src/tui/cockpit-screens.tsx:189-197`, `336-344`. |
| 2 | VALID | Current presentation leaks machinery | Valid. The oversized copy is product-hostile. | Advocate screenshot critique: `.council/.../gemini-advocate-v2-with-screenshots.md:13-15`. Current copy literally emits `force-agent-to-chunk redirect ready`: `src/tui/diff-review-model.ts:494-502`. |
| 3 | VALID | Binary/raw byte display is wrong for non-coders | Valid. Binary should be summarized, not rendered as bytes. | Screenshot critique: `.council/.../gemini-advocate-v2-with-screenshots.md:17-19`. Loader has a binary summary path only for zero-hunk whole-file view: `src/tui/diff-review-load.ts:220-239`, so diffable binary-ish output can still leak as line rows. |
| 4 | VALID | Tombstone receipts keep chat readable | Valid, but not by mutating prior transcript entries. Receipt must be appended after a dynamic card disappears. | `<Static>` is append-only and protected against non-prefix rewrites: `src/tui/cockpit-screens.tsx:271-289`, `331-344`. |
| 5 | OVERTURNED | Sticky pending counter pinned to viewport boundary | Overturned as stated. Normal-buffer/native scroll cannot pin something to the user’s terminal scroll viewport. Put review count in live composer/status chrome instead. | Normal-buffer/native scroll is explicit: `src/tui/cockpit-screens.tsx:3-7`, `292-295`. Status/composer is live region: `src/tui/cockpit-screens.tsx:219-243`; status bar already carries review mode: `src/tui/cockpit.tsx:497-504`. |
| 6 | OVERTURNED | `k` should mean Keep | Conflicts with terminal norms and current keymap. Keep should be Space/Enter or a labeled footer action; `k` is already up navigation. | Research says arrows and `j/k`: `.council/.../user-research-sourced.md:92-93`, `111-112`. Current keymap: `j` down, `k` up, Space approve, `r` reject: `src/tui/use-diff-review-keymap.ts:105-126`. |
| 7 | NEEDS-EVIDENCE | AI-generated abstract for oversized changes | The need for a plain-language abstract follows. “AI-generated” does not. Existing group label/why/risk/counts may be enough before adding model calls. | Research supports summary first: `.council/.../user-research-sourced.md:101-105`; current group metadata exists: `src/tui/diff-review-model.ts:76-89`, dashboard render `449-463`. |
| 8 | OVERTURNED | Silent keep-on-scroll-away for all ignored reviews | Not honest in full/manual review mode unless it performs a real DB decision. UI collapse alone would leave `review_deltas.status='open'`. Also contradicts “accept/reject gate is sacred” for risky changes. | Status enum: `src/evidence/migrations-v17.ts:71-83`; unresolved query: `src/chat/diff-review-read.ts:25-55`; approve resolves through real status machine: `src/chat/diff-apply.ts:61-85`; research: `.council/.../user-research-sourced.md:106-110`. |
| 9 | VALID | One card per coherent logical change | Valid, and already aligned with grouping machinery. | Research principle: `.council/.../user-research-sourced.md:113`. Current grouping/risk rows: `src/chat/diff-review-store.ts:102-129`, `src/tui/diff-review-model.ts:449-463`. |
| 10 | IMPORTANT | Current @all mechanics are race-prone | Three near-simultaneous reviews are not safely representable today. The screen holds one `reviewModel`, with no `reviewId`; the decision hook tracks latest `review.ready` separately. Out-of-order loads can display review A while decision keys target review B. | `ReviewTreeView` has no review id: `src/tui/diff-review-model.ts:100-103`. `useReviewDecisions` admits it tracks id separately: `src/tui/use-review-decisions.ts:18-23`, sets latest id at `263-268`. `useReviewOpenBus` async-loads and dispatches id-less `review-open`: `src/tui/use-cockpit-bus.ts:247-256`. |

## 2. Mechanical Feasibility Answers

**a. Inline card key handling**

A focused inline card is representable, but not as passive transcript markup. Current input ownership is mutually exclusive: composer is active only when no review/picker/confirm screen owns input, and diff review keymap is active only when `state.screen === "diff-review"` (`src/tui/cockpit.tsx:282-338`). Add a first-class focus/screen state such as `inline-review-active` or `activeReviewCardId`, with one keymap branch. Do not add a second independent input system.

**b. Sticky pending counter**

Viewport-pinned scrollback chrome is not implementable honestly in the normal buffer. Native terminal scroll owns the viewport. Use the live composer/status region for `reviews: N`, and `/review` for recall.

**c. Ephemeral cards and tombstones**

A Static card cannot later collapse. Real options:

1. Dynamic-region card above composer, then append a Static local receipt on decision.
2. Defer transcript append until answered, which hides the event and weakens accountability.
3. Append full card to Static and later append receipt, leaving the full card behind, which fails the cleanliness goal.

Best option: dynamic card + Static receipt.

**d. Inline diffs and INV-13**

Every agent/path/diff byte must pass through `AgentText` or `escapeUntrusted`. Current rows do this (`src/tui/diff-review-rows.tsx:51-87`) and `AgentText` escapes by contract (`src/tui/safe-text.tsx:33-45`). Width must stay bounded before render, as current `visibleRows` truncates dashboard and line text (`src/tui/diff-review-model.ts:459-463`, `537-545`). Do not reuse `ChromeText` for agent-derived summaries.

**e. Already-applied semantics**

“Already on disk” is true: approve is a DB decision only, while reject/rollback mutate files (`src/chat/diff-apply.ts:61-85`, `436-469`; `src/chat/diff-apply-rollback.ts:294-321`). But “ignored means kept” is only implementable if the app calls `approveHunks` and resolves the row. Otherwise `/review` will still show it as pending (`src/chat/review-resume.ts:77-95`). Silent keep should be a product mode or low-risk rule, not the default for all reviews.

**f. @all collision**

Current implementation is single-review-at-a-time and unsafe under async collisions. Inline redesign needs an id-bearing queue: multiple `review.ready` events enqueue cards/offers; exactly one active card owns keys; all decisions carry that card’s `reviewId`; status shows remaining count.

## 3. Reuse vs Retire

Reuse untouched:

- Capture/checkpoint/review persistence: `settleReviewCapture`, `insertReviewDelta`.
- Grouping, risk tags, counts, review tree loader.
- Decision engine: approve, reject, group reject, rollback, redirect/comment.
- Status machine: open/conflict/redirected/resolved/superseded.
- Undo machinery.
- INV-13 escaping via `AgentText` / `escapeUntrusted`.
- `/review` pending offer query and picker logic, after adapting it as the recall surface.

Retire or demote:

- Auto-opening `DiffReviewScreen` as the default surface.
- The current full-screen keymap as the primary review interaction.
- Oversized “force-agent-to-chunk redirect ready” copy.
- Static breadcrumb/header behavior that pollutes scrollback on navigation.
- `k` as any proposed Keep key.

Hidden expensive coupling:

- Review identity is not inside `ReviewModelState`; fixing @all correctly requires threading `reviewId` into active card/screen state.
- `<Static>` cannot be rewritten, so collapse/receipt is a render architecture change.
- Review modes `notify-only/off` already auto-approve at settle (`src/chat/headless-turn-review-settle.ts:309-313`), so inline manual semantics must not blur with passive auto-approve modes.

## 4. Surviving Design Skeleton

Lifecycle:

1. Review lands: capture persists review, emits `review.ready`, TUI enqueues an id-bearing review card.
2. Notice: one compact dynamic card appears above composer with agent, files, grouped intent, risk tags, and “already applied: Keep or Undo.”
3. Inspect: card shows summary first; small diffs can expand inline; large/binary/complex cases show summaries and `[f] full view`.
4. Decide: Space/Enter Keep, `u` Undo group/turn, `c` Comment/ask agent, `f` Full View, Esc returns focus without resolving.
5. Receipt: after real DB decision, remove dynamic card and append one transcript receipt.
6. Recall: status bar shows `reviews N`; `/review` opens the existing pending picker.
7. Risk friction: low-risk can optionally auto-keep on typing if operator approves that behavior; high-risk/destructive/schema/package changes require explicit decision or stay pending.
8. Full-screen boundary: only for `f`, conflicts, oversized inspection, or detailed rollback/repair work.

## 5. Wave Sizing

Rough size: **9 T-sized tasks**, probably two waves.

1. Add id-bearing review queue/card state and @all race tests.
2. Render dynamic inline review card above composer.
3. Add focused-card keymap integrated with existing mutual-exclusion model.
4. Add status-bar pending count and `/review` recall path.
5. Wire Keep/Undo/Comment decisions to existing engine with receipts.
6. Replace oversized/binary copy with plain summaries.
7. Add inline small-diff viewport with INV-13 and width tests.
8. Demote full-screen to `[f]` escalation and add arrow-key/footer hints.
9. Policy task for ignored-card behavior by risk tier/mode.

## 6. Operator Questions

1. When a review appears while you are typing, should typing keep it pending in a small counter, or auto-keep low-risk changes?
2. If three agents finish together, do you want to see the newest review first, or the riskiest review first?
3. Should Undo mean “undo this group” by default, or “undo the whole agent turn”?
4. For big generated files, do you want a one-line summary only, or a summary plus a button to ask the agent to split it?
5. Should risky changes like package installs, schema changes, and deletes require an explicit key press every time?

## 7. Verification

Read-only review only. I inspected the three dossier markdown files, all five screenshots, and the current TUI/review source. I did not write a verdict file because this dispatch explicitly says read-only/no file edits, and I did not run test gates because no code changed.

Confidence: **YELLOW 90%**. Strong on code mechanics and contradictions; slightly below GREEN because I did not run the app live or inspect every historical spec behind the shipped review waves.

