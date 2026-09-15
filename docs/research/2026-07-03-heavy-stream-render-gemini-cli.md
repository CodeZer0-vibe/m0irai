# Heavy-stream render feel — how gemini-cli handles it (source-verified 2026-07-03)

Operator report: "the terminal still feels off a little when a lot of text gets spawned." Reference
requested: the open-source gemini-cli. Findings below are from a same-day shallow clone of
google-gemini/gemini-cli (main), file:line quoted.

## The three mechanisms (verified in their source)

1. **The live region must NEVER render taller than the terminal — and they measure violations.**
   `packages/cli/src/ui/hooks/useFlickerDetector.ts:28-42`: after every render, `measureElement(rootUiRef)`;
   `if (measurement.height > terminalHeight)` → `recordFlickerFrame(config)` + `appEvents.emit(AppEvent.Flicker)`.
   The comment defines the invariant: "detects when the UI flickers (renders taller than the terminal).
   This is a sign of a rendering bug." When Ink's dynamic output exceeds the viewport it must repaint the
   whole screen (including Static scrollback) — that repaint IS the visible flicker/"off" feel.
   `DebugProfiler.tsx:122-141` surfaces "flicker frames" in `/profile`.

2. **Height budgeting: `constrainHeight` default TRUE + per-item `availableTerminalHeight` + MaxSizedBox.**
   `AppContainer.tsx:329` `useState<boolean>(true)` (constrainHeight); `:1555` computes
   `availableTerminalHeight`; overflowing items are tracked (`overflowingIdsSize`) and the pending/stream
   display is height-capped (MaxSizedBox et al. under ui/components). Expansion is an explicit user action
   (constrainHeight=false), intentionally allowed to overflow — detector then stays silent (`:1378`).

3. **A patched Ink fork, not stock**: `packages/cli/package.json:52` — `"ink": "npm:@jrichman/ink@6.6.9"`
   (maintainer fork of ink 6). We run stock `ink ^5.2.1`. Our U2e root-cause (2026-07-03, sealed) measured
   stock Ink mounting via createContainer in LEGACY un-batched mode — every dispatch = its own paint; the
   16ms coalescer (use-coalesced-dispatch.ts) mitigates on our side, but streaming chunks are deliberately
   IMMEDIATE (one paint per chunk), so a 3-agent burst still paints at chunk rate.

## Gap analysis vs our cockpit (feat/zer0-init @ U2d-c)

- We bound each response's live tail (LIVE_BODY_MAX_LINES=12, U1-T5) but NOT the live region's TOTAL:
  3 in-flight responses + held turns + working line + menus + composer can exceed the viewport →
  exactly the whole-screen repaint gemini-cli calls a flicker frame.
- We have no flicker detector — the failure mode is invisible except to the operator's eye.
- Streaming paints per chunk (immediate path, regression-locked ≥1 frame per chunk in U2e). gemini-cli's
  equivalent pressure is absorbed by the height cap (small dynamic region = cheap frames) + the fork.

## U2e-b design sketch (the unit to spec)

1. **Viewport budget for the live region** (the gemini pattern, highest leverage): compute available rows
   (terminal height − composer/menus/working line − margin); distribute across in-flight/held turns
   (existing per-response 12-line cap becomes the ceiling INSIDE a global budget); drop to tail-only as
   the budget shrinks. Falsifier: render N streaming agents in a small pty — measured root height ≤
   terminal rows, always.
2. **Flicker detector in dev/profile mode** (measureElement > rows → count + log) — makes the invariant
   falsifiable forever (their exact trick).
3. **Stream paint cadence**: keep first-chunk immediate; coalesce subsequent stream chunks per agent into
   the existing 16ms micro-batch (raise streaming latency ceiling from 0 to ≤16ms — imperceptible, cuts
   worst-case paint rate ~6×). Only if 1+2 don't fully settle the feel.
4. **Ink 6 / fork evaluation** (separate, riskiest): stock ink 6 vs @jrichman/ink deltas; upgrade needs
   its own reality-gate pass. Not in U2e-b v1.

Order: 1 → 2 → live ConPTY verify → 3 only if needed → 4 as its own unit.
