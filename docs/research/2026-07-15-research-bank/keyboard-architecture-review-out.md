Read-only session; I could not write an output file. Plain-text review follows.

VERDICT: REPLACE.

Do not build the candidate as-is. The invariant is right, but blind-enabling `?9001h` by default is the wrong production posture. Replace with:

1. Always install the firewall chain: raw stdin -> complete win32 INPUT_RECORD decoder -> complete kitty CSI-u decoder -> Ink.
2. Boot-reset both modes before render: `CSI ?9001l`, `CSI <u`.
3. Blind-enable kitty only: `CSI >1u` on interactive TTYs. It is less invasive because normal printable text remains normal bytes per kitty quickstart/spec.
4. Do not actively enable `?9001h` by default. Keep the win32 decoder as a defensive firewall for stale/foreign records and only allow active win32 mode behind an explicit diagnostic/doctor flag until live matrix proves paste/IME/Ctrl+C/shell-stale safety.
5. No passive capability query inside the live Ink stdin unless the transform also drops every expected response. Current kitty transform passes non-`u` CSI through, so a passive `DA1` response can become another input leak.

Q1. Blind `?9001h`: unsupported terminals are expected to ignore it; Microsoft’s spec explicitly relies on that because ConPTY may always emit the request. The real risk is supported terminals after crashes: active win32 mode converts standard keys and `Ctrl+C` into CSI records, making the shell hard to recover. This is why default active win32 mode should be rejected.

Q2. Blind kitty push: acceptable with cleanup, but not harmless. Kitty documents startup `CSI >1u` and exit `CSI <u`; key events are encoded in bounded forms the decoder can parse or drop. Current decoder safely drops unknown final-`u` CSI, but it only understands simple 1-2 field CSI-u, not full colon/event forms. That is acceptable only if “drop unknown, never leak” remains enforced.

Q3. Double encoding: empirically unknown. The Microsoft spec describes nested ConPTY scenarios where win32 records can be translated back into VT/win32 depending on the downstream mode. Cheap proof: one raw-key probe in Cursor, Windows Terminal, conhost, mintty/Git Bash, and tmux, with enable orders `kitty`, `win32`, `kitty->win32`, `win32->kitty`, logging exact hex for `a`, `Ctrl+C`, `Shift+Tab`, paste, arrows, IME text.

Q4. Capability knowledge: not needed for runtime selection if the firewall is correct. A passive log is worth it only in `/doctor` or pre-Ink isolated mode. In live mode it is noise plus risk, because responses like `ESC[?6c` are not currently consumed by `kitty-keyboard-transform.ts`; non-`u` CSI is passed through at lines 99-101.

Q5. Performance: not measured here. It is probably irrelevant versus terminal/render latency, but require a microbench before merge: 100k single-key chunks through win32+kitty under Node 24, plus a live hold-key repeat test. Acceptance target: p95 transform time below 1ms per chunk and no input coalescing leak.

Q6. Double translation/idempotence: chain order is sound only if stage 1 never emits raw protocol. Stage 2 only decodes CSI ending in `u`; legacy `ESC[Z`, arrows, `Ctrl+C` byte `0x03`, printable UTF-8, and paste delimiters pass through. This must be a test, not an argument.

Q7. Ink risk: real. Current wrappers proxy `isTTY`, `isRaw`, `setRawMode`, `ref`, `unref`, but not every TTY surface. Ink is rendered with `{ stdin: keyboard.stdin }` at `src/cli/commands/chat-tui-cockpit-loop.ts:228-241`, and cleanup is only in the loop `finally` at `:264-267` plus fatal cleanup in `src/cli/commands/chat-tui.ts:44-48`. Live tests must cover raw-mode timing, abort, fatal, resize, pause/resume, and input before Ink attaches.

Falsifiers, ranked:

1. Operator leaked win32 string, whole and split at every byte: no `[87;17;119;1;0;1_`-style bytes reach Ink.
2. Win32 printable records for `WASD`, lowercase letters, digits, punctuation, space, Enter, Backspace, Tab.
3. Win32 `Ctrl+C`, `Ctrl+D`, `Ctrl+R`, `Ctrl+Space`, Alt-modified keys, Shift+Tab -> legacy bytes Ink expects.
4. Key-up and modifier-only records: dropped, debug-recorded, never inserted.
5. Repeat counts: emit the intended repeated text/control bytes, never raw records.
6. Optional/default win32 fields from the spec, not only six fully populated numbers.
7. Paste under win32 mode, including bracketed paste delimiters reconstructed safely.
8. Unicode BMP, surrogate pairs, dead-key/IME style inputs.
9. Kitty CSI-u for Ctrl combos, Shift+Tab, arrows/nav/F-keys, unknown/private-use keys.
10. Mixed stream: win32 record, raw kitty CSI-u, legacy ESC sequence, printable UTF-8 in one chunk.
11. Passive query responses, if implemented: DA1, kitty flags, modifyOtherKeys responses must not reach Ink.
12. Cleanup: normal exit, `/quit`, abort signal, fatal surface, SIGINT/SIGTERM/SIGHUP, uncaught exception.

UNVERIFIED / corrected claims:

- “`RECORD_RE` decodes only a chunk that is exactly one whole record” is false for current code. `findRecordEnd` scans records and handles pending chunks at `src/tui/win32-input-mode.ts:160-168`; the leak is because `recordToOutput` returns non-Shift+Tab key-down records unchanged at `:191-194`.
- The cold Cursor probe race is plausible from `DEFAULT_TIMEOUT_MS = 100` and fallback selector at `terminal-keyboard-protocol.ts:37-40`, but I did not reproduce the live race.
- Claude Code’s binary behavior was not independently verified; I only verified the local report claims exist in `.council/terminal-input-fix-report.md`.
- Bare-tab probe result and “worked the day before” are operator evidence, not code-verified.
- Tests were read, not run. This was a hostile read-only architecture review, not a green-gate run.