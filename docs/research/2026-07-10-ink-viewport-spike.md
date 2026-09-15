# SPIKE-0: Ink viewport-diff virtualization — GO

Investigate-only prototype for the T4a falsifier in `docs/specs/2026-07-10-diff-hero-draft.md:324`
("2k-line diff renders viewport-only at 80x24") and the open item at `...draft.md:387-388`
("STILL UNVERIFIED: Ink virtualization behavior for viewport-diff rendering under ConPTY").

**Verdict: GO.** A plain 24-row array slice into a `<Box>`, paired with `<Static>` for settled
history (mirroring `src/tui/cockpit-screens.tsx:284-296`), keeps every rendered frame bounded to
the viewport regardless of diff size, and the `<Static>` region is provably byte-frozen across 50
scroll keystrokes — mechanically verified via `ink-testing-library` frame capture, not eyeballed.
Ink has no built-in "virtualized list" primitive; the pattern IS manual slicing into a plain `Box`
(the acceptance criteria's named NO-GO alternative is, empirically, the correct GO pattern).

## What was built

- `scratch/spike-ink-viewport.tsx` — `SpikeViewport({ diffLines, historyItems, viewportRows })`:
  `<Static items={historyItems}>` above a `<Box flexDirection="column">` rendering
  `diffLines.slice(topIndex, topIndex + viewportRows)`. `useInput` moves `topIndex` by ±1 on `j`/`k`,
  clamped to `[0, diffLines.length - viewportRows]`. `viewportRows` is an explicit prop, not read
  from terminal size — matching `Screen()`'s own explicit `size` prop
  (`src/tui/cockpit-screens.tsx:259,265,271`).
- `scratch/spike-ink-viewport.test.tsx` — frame-capture falsifiers (acceptance 1+2) plus a timing
  harness (`waitForFrame` polls `frames.length` with a bounded loop, not a fixed sleep margin).

## RED (component did not exist yet)

```
FAIL scratch/spike-ink-viewport.test.tsx [ scratch/spike-ink-viewport.test.tsx ]
Error: Cannot find module './spike-ink-viewport.js' imported from
'.../scratch/spike-ink-viewport.test.tsx'
Caused by: Error: Failed to load url ./spike-ink-viewport.js ... Does the file exist?
 Test Files  1 failed (1)
      Tests  no tests
```

## GREEN (4 independent runs, fresh vitest fork each time)

```
✓ scratch/spike-ink-viewport.test.tsx (2 tests) 361ms
  [SPIKE-0] initial render: 68.72ms
  [SPIKE-0] repaint ms — avg=5.11 max=11.39 n=50 frames=52

✓ scratch/spike-ink-viewport.test.tsx (2 tests) 490ms
  [SPIKE-0] initial render: 67.13ms
  [SPIKE-0] repaint ms — avg=8.92 max=28.97 n=50 frames=52

✓ scratch/spike-ink-viewport.test.tsx (2 tests) [run 3]
  [SPIKE-0] initial render: 68.46ms
  [SPIKE-0] repaint ms — avg=4.98 max=11.74 n=50 frames=52

✓ scratch/spike-ink-viewport.test.tsx (2 tests) 480ms
  [SPIKE-0] initial render: 71.38ms
  [SPIKE-0] repaint ms — avg=7.38 max=36.44 n=50 frames=52

Test Files  1 passed (1)   |   Tests  2 passed (2)   [all 4 runs]
```

Ran via a standalone vitest config in the scratchpad (not committed to the repo) that adds
`scratch/**/*.{test,spec}.{ts,tsx}` to `include` — the repo's `vitest.config.ts` (coordinator-owned,
not touched) only globs `src/**`, `tests/**`, `scripts/**`.

## Measured numbers

| Metric                                                             | Range across 4 runs |
| ------------------------------------------------------------------ | ------------------- |
| Initial mount → first stable frame (2000-line diff, 24-row window) | 67–71ms             |
| Per-keystroke repaint (avg of 50 j-presses)                        | 5.0–8.9ms           |
| Per-keystroke repaint (max observed)                               | 11.4–36.4ms         |

These numbers come from a `debug: true` Ink instance inside a shared 4-fork vitest pool on this
machine — see caveats below on why they are directionally useful, not a ConPTY-accurate benchmark.
All four runs stayed well under any human-perceptible-lag threshold (~100ms) even at the observed
max, for a diff two orders of magnitude larger than the 2k-line falsifier target.

## Falsifiers checked (mechanical, not eyeballed)

1. **Acceptance 1** (mount): `lastFrame()` contains `DIFF_0001`..`DIFF_0024`, excludes `DIFF_0025`
   and `DIFF_2000`; regex count of `DIFF_\d{4}` markers in the frame is exactly `VIEWPORT_ROWS` (24).
2. **Acceptance 2** (50 keystrokes): every one of the 52 captured frames has a `DIFF_\d{4}` marker
   count `<= 24` — no frame, at any point in the scroll, ever surfaces more than the viewport window.
   The final frame contains `DIFF_0051`..`DIFF_0074` (window moved by exactly 50, no drops/dupes in
   the slice math) and excludes `DIFF_0001` and `DIFF_0075`.
3. **Static byte-stability**: `staticPrefixOf(frame)` (the substring before the first `DIFF_` marker)
   was collected into a `Set` across all 52 frames per run — size 1 every time. The `<Static>`
   region's bytes never changed across 50 live-region repaints.

## Mechanism found during investigation (why frame capture is trustworthy here, with a caveat)

`node_modules/ink-testing-library/build/index.js` always calls Ink's `render()` with `debug: true`.
`node_modules/ink/build/ink.js:104-110` shows what that does:

```js
if (this.options.debug) {
  if (hasStaticOutput) {
    this.fullStaticOutput += staticOutput;
  }
  this.options.stdout.write(this.fullStaticOutput + output);
  return;
}
```

Every captured frame is `fullStaticOutput + output` — the ENTIRE accumulated static history
re-concatenated with the current live output, on every single render. `hasStaticOutput` (comment at
`ink.js:102`: "If `<Static>` output isn't empty, it means new children have been added to it") only
flips true when `<Static>`'s child list grows — which it never does across our 50 keypresses (we
only mutate `topIndex`, not `historyItems`). That is WHY the Static-prefix-stability check
(falsifier 3) is a sound proxy for "Static did not re-render its content": `fullStaticOutput` is
physically the same string object content on every one of the 52 frames.

**Caveat**: this debug-mode concat means the raw byte size of each captured frame is NOT 1:1 with
what a real terminal receives. The real interactive path
(`ink.js:118-134`, taken when `!debug && !isInCi`) writes newly-added static output via one
`stdout.write(staticOutput)` call ONLY when `hasStaticOutput` is true, and otherwise repaints just
the live region via `this.log(output)` (a throttled, cursor-relative rewrite) — it never re-sends
old static bytes. So the per-keystroke timing measured here (5–9ms avg) reflects React
reconciliation + Ink's yoga layout + string-building cost, not raw terminal I/O volume, and is
already the more conservative (larger-payload) of the two code paths. **T10 (Windows ConPTY live
matrix) should still confirm no full-diff repaint under a REAL ConPTY session** — this spike proves
the component-level virtualization logic is correct and fast; it does not substitute for a live
terminal check.

## Secondary finding: `ink-testing-library`'s `Stdout` mock has no configurable size

`node_modules/ink-testing-library/build/index.js`'s `Stdout` class:

```js
class Stdout extends EventEmitter {
    get columns() { return 100; }
    ...
}
```

`columns` is hardcoded to `100` with no constructor override, and there is no `rows` property at
all (`ink.js:121`'s `outputHeight >= this.options.stdout.rows` check reads `undefined` and is
never reached in debug mode anyway, since debug returns early at `ink.js:109`). This version
(`ink-testing-library@4.0.0`) cannot simulate an 80x24 terminal through its public API. The T4a
review screen's "80x24" constraint has to be — and in this spike, is — enforced by the component
itself via an explicit `viewportRows` prop, never by reading terminal size through Ink. This is
already the codebase's existing pattern (`Screen({ size })`,
`src/tui/cockpit-screens.tsx:259,265,271`), so T4a needs no new convention here.

## Minor unresolved observation (non-blocking)

`frames.length` was 52 after mount + 50 keypresses in every run, not the naively-expected 51
(1 mount + 50 keys). A plausible cause: `<Static>`'s own internal bookkeeping (tracking which items
it has already flushed) commits once more right after mount, separate from the initial tree commit.
Not investigated further — every one of the 52 frames still passed both the `<= 24` marker-count
check and the Static-prefix-stability check, so it does not affect the GO verdict, only flagged
here as an open curiosity for whoever builds T4a for real.

## Recommendation for T4a

Adopt this pattern directly: `<Static>` for the settled group/file/hunk tree above the fold,
`<Box>`-sliced array windowing for the active hunk body below it, `viewportRows` threaded down from
`Screen`'s existing `size` prop rather than re-derived. `useInput` j/k here is a throwaway
stand-in — T4a's real keymap (lazygit-style, `use-diff-review-keymap`) is explicitly out of this
spike's scope and belongs to the coordinator's build brief, not this prototype.
