# Phase 4 — Rust workspace prune to the room: LANE RECORD (branch `rust-prune`)

Completed 2026-08-18. Every number below is quoted from a command run in this
worktree (`D:\m0irai-work-rust`, Windows, Git Bash, rustc 1.94.0 pinned by
`rust/rust-toolchain.toml`, every cargo invocation prefixed `CARGO_BUILD_JOBS=8`).
Nothing here is inferred or predicted.

---

## 1. What shipped

Five commits on `rust-prune`, from `92c8fea`:

| Commit | Contents |
| --- | --- |
| `cf07701` | declarations + lock: 19 optional product declarations pruned (16 `xai-grok-pager`, 3 `xai-grok-pager-render`), dead feature lists removed, `[patch.crates-io] async-openai` dropped, workspace members 83 → 20 |
| `65f13c4` | deletions: 1,956 tracked files — 63 crate directories, `rust/bin/protoc`, `zer0-v2-bin/src/ui` |
| `89ddc1e` | the 20-member closure pin, `verify:rust` scope flip to `--workspace`, rustfmt repair |
| `5ef3adf` | this lane record + `deletions-rust.json` |
| `0e8f955` | follow-ups F2 and F5: 29 `pin_theme()` guards closing the pager theme race, and the `conpty_ui` budgets split into a measured `BOOT` (20 s) and `STEP` (8 s) with `#[track_caller]` wait diagnostics — see §5 |

Inventory of everything removed, with per-directory tracked-file counts and a
one-line reason each: `docs/provenance/deletions-rust.json` (66 entries).

## 2. The measured final workspace — 20 members

From `cargo metadata --locked --format-version 1` on the final tree:

```
dagre_rust graphlib_rust mermaid-to-svg ordered_hashmap
prod-mc-cli-chat-proxy-types ptyctl xai-grok-config xai-grok-markdown
xai-grok-markdown-core xai-grok-mermaid xai-grok-pager xai-grok-pager-render
xai-grok-paths xai-grok-version xai-prompt-queue xai-ratatui-inline
xai-ratatui-textarea xai-tty-utils zer0-room-protocol zer0-v2-bin
```

20 members, 626 resolved packages (was 83 / 1,285), 0 member manifests outside
`rust/`. Lock `(name, version)` pairs 1,306 → 633 with **0** entries that were
not already in the pinned lock — no version drift, only removals.

## 3. Acceptance, as measured on the final tree

| | Result |
| --- | --- |
| A1 `cargo metadata --locked` | exit 0 · 20 members · 626 packages · 0 manifests outside `rust/` |
| A2 `cargo test --locked --workspace` | exit 0 · 57 `test result` lines · **3052 passed, 0 failed, 38 ignored** · 116s |
| A3 `cargo test --locked -p zer0-v2-bin --features test-support --test host_lifecycle` | exit 0 · **9 passed** (ran the real `npm run build` + Node host) |
| A4 `cargo build --locked -p zer0-v2-bin --profile release-dist` | exit 0 · `zer0-v2 0.1.0` · **8,009,216 bytes** (Phase 0 pin: 8,013,312) |
| A5 `node scripts/verify-rust.mjs` | `"ok": true` · members 20 · packages 626 · lifecycleTests 9 |
| A6 `git status --porcelain` | empty |

Re-verified unchanged after the F2/F5 follow-ups (`0e8f955`):
`cargo test --locked --workspace` exit 0, 57 result lines, 3052 passed / 0
failed / 38 ignored; `node scripts/verify-rust.mjs` `{"ok":true,…,"bytes":8009216,
"closure":{"members":20,"packages":626},"lifecycleTests":9}`. The 29 new
`pin_theme()` guards add no tests and the split conpty budgets add none.

Pager test count under the retained features: **774 passed, 17 ignored** —
771 lib unit tests, `selection_model_public_api` 2, `doctor_early_dispatch`
0/11 ignored, `signal_errno_preservation` 0, doctests 1/6 ignored.

## 4. The closure pin proved to bite

`crates/zer0-v2-bin/tests/room_dependency_closure.rs` gained
`zer0_workspace_members_are_exactly_the_room_set`. Three mutations were run,
each reverted, and the tree re-verified green afterwards:

| Mutation | Result |
| --- | --- |
| pin drops `xai-grok-mermaid` | FAILED — `appeared:["xai-grok-mermaid"] vanished:["REMOVED-FOR-MUTATION-TEST"]` |
| real 21st member added (`mutation-probe`) | cargo refuses first: `cannot update the lock file … because --locked was passed`; with the lock regenerated, FAILED — `appeared:["mutation-probe"] pinned 20/found 21` |
| `ptyctl` member + dev-dep removed | FAILED — `vanished:["ptyctl"] pinned 20/found 19` |

## 5. Open findings this lane did NOT fix (deliberately out of the brief)

**F1 — `npm run gates` is red on this branch.** `scripts/gate-tracked-surface.mjs`
compares `git ls-files` against `docs/provenance/tracked-surface.json`, an exact
inventory. Measured:

```
GATE FAIL tracked-surface (work):
tracked but not in inventory (unreviewed drift): 1
  docs/provenance/deletions-rust.json
in inventory but no longer tracked: 1956
```

Remedy is one command — `node scripts/gate-tracked-surface.mjs --update` — but
both that script and the inventory were outside this brief's writable set.
`npm run verify:rust` and `scripts/gate-cut-closure.mjs` are unaffected
(cut-closure passes: 340 recorded deletions, 2,347 files scanned, no dangling
reference).

**F2 — an intermittent pager test race, pre-existing, newly executable.**

```
---- scrollback::blocks::user::tests::collapsed_truncation_keeps_teal_on_token_within_last_line ----
panicked at crates\codegen\xai-grok-pager\src\scrollback\blocks\user.rs:815:9:
assertion `left == right` failed
  left: ""
 right: "/do-it"
```

Root cause: the theme is process-global —
`xai-grok-pager-render/src/theme/cache.rs:23` `static CURRENT: AtomicU8` plus
`TERMINAL_NATIVE_LOCK`, read by `Theme::current()`
(`theme/mod.rs:266`). The test `thinking_body_dim_italic_survives_the_terminal_native_palette`
(`src/scrollback/blocks/thinking.rs:651`) flips `set_terminal_native_lock(true)`
for its duration while holding `cache::test_lock()`. The failing test builds its
spans and then compares against `Theme::current()` **without** taking that lock,
so it is not serialized against the writer and can observe the terminal-default
palette, whose `accent_skill` never matches.

The repo already documents both the hazard and the remedy: `cache::pin_theme()`
("Rendered heights are computed under the process-global `Theme::current()`
(which concurrent `set_theme` tests mutate) … Hold the returned guard for the
whole test"). Four files use it — `scrollback/state/layout.rs` (40 sites),
`scrollback/blocks/tool/edit.rs`, `scrollback/wrappers/entry_renderer.rs`,
`views/permission_view.rs`. `user.rs` itself carries two comments naming the
race and avoids being a *writer*, but it has **16** unguarded `Theme::current()`
call sites in its tests — all unsynchronized *readers*.

Not caused by this lane: `git diff 92c8fea..HEAD` over
`blocks/user.rs`, `blocks/thinking.rs` and all of `xai-grok-pager-render/src/theme/`
is **empty**. Phase 0 K2 made the pager's tests uncompilable on Windows, so they
had never executed; `89ddc1e`'s `ROOM_TEST_SCOPE` flip is what puts them into
`npm run verify`.

**RESOLVED in `0e8f955`** (lead-directed follow-up). 29 tests now hold
`pin_theme()` for their whole body — 15 in `blocks/user.rs`, 14 in
`blocks/quote_bar.rs`. `pin_theme()` takes the same `cache::test_lock()` the
writer holds, so reader and writer are serialized. No product code, no writer
test, no theme module touched.

The instrument was calibrated on the known-real case before it was trusted:
running the lib test binary directly, 200 unguarded executions reproduced

```
CONTROL (no guards): 2 failures / 200 runs
  scrollback::blocks::user::tests::all_token_ranges_invalid_renders_plain
  scrollback::blocks::quote_bar::tests::wrapped_quote_continuations_exclude_reinjected_prefix
```

then 400 guarded executions gave `0 failures / 400 runs`. At the measured 1%
control rate, a clean 400-run treatment has ~1.8% chance of being luck; a 40-run
loop would have had ~67%, which is why the loops are this size.

`quote_bar.rs` was found **by the control run, not by inspection** — its tests
never name `Theme::current()`, they reach it through `quote_bar_style()`
(`Theme::current().md_muted`) and then match spans against that exact style.
Guarding only the file named in the original finding would have left it racing.

**Swept for the rest, and 11 more guards added (second follow-up).** Guarding
only the two files that happened to fail is not an argument that nothing else
races, so the remaining readers were enumerated and then measured.

*Static enumeration.* 44 files in the retained crates read `Theme::current()`
directly inside a `#[cfg(test)] mod tests`; 39 were unguarded. Intersecting
those against the 771 tests the binary actually lists (`--list`) leaves **6
unguarded readers that are compiled and run** — the other 33 live in
`grok-runtime`-gated modules (`src/app/`, most of `src/views/`,
`scrollback::render`, …) that are not in this binary at all and therefore cannot
race:

```
room_composer_menu.rs:933,949            views/completion_dropdown.rs:238
room_scrollback.rs:1869                  views/modal_window.rs:1168,1212
scrollback/blocks/credit_limit.rs:197    views/slash_dropdown.rs:553,595,658,717,754
```

All six are now guarded (11 `#[test]` fns; every guard verified to sit in a
`#[test]`, never a shared helper — a helper would self-deadlock on the
non-reentrant `Mutex`). Total guards on the branch: **40**.

*Measurement, with the instrument calibrated first.* A steady forced
`terminal_native_locked() -> true` is the WRONG oracle here — it makes render and
assertion agree, so `quote_bar`'s failure disappears under it (768 passed / 3
failed, all three already-known `user.rs` tests). The race needs a *transition*,
so the writer's window was widened instead: a 750 ms sleep inside
`thinking_body_dim_italic_survives_the_terminal_native_palette` while it holds
the native lock.

| configuration | result |
| --- | --- |
| amplifier ON, guards OFF (calibration) | **5 failing runs / 5** — 3 `user.rs` readers |
| amplifier ON, 29 guards | 0 failing runs / 12 |
| amplifier ON, all 40 guards | **0 failing runs / 20** |
| no amplifier, all 40 guards, `cargo test --locked -p xai-grok-pager -q` | **40 passed / 40, 0 failed** (937 s) |

The same amplifier was applied to the render crate's own writer
(`syntax.rs` `with_native_lock`, a second independent writer in a second test
binary): 0 failing runs / 12. That null was calibrated too — a deliberately
unguarded probe reader added to the same module failed 3 runs / 5 under the
amplifier, so the instrument does bite in that binary.

Still true and still unfixed: the general shape. The pager has 614
`Theme::current()` call sites, and a test can reach the theme *indirectly*
(`quote_bar` did) — which no static sweep finds. The process-global theme is the
root defect and remains an M2 item; what is established here is that no reader
in the retained, compiled test set is exposed by the two writers that exist.

**F3 — `rust/README.md` is still grok's.** It instructs
`cargo run -p xai-grok-pager-bin` (lines 76-78), lists deleted crates in its
crate table (lines 99-103) and links a deleted
`crates/codegen/xai-grok-tools/THIRD_PARTY_NOTICES.md` (line 137). Following it
cannot start this project. Left alone because what the m0irai Rust README should
say is a content decision, not an engineering one.

**F4 — Windows `FileIdentity` in `xai-grok-config::managed_text` is still
broken** (11 tests `#[cfg_attr(windows, ignore)]`d in `cf07701`; they still run
and must pass on unix CI). `FileIdentity` is `(dev, ino)` on unix but
`(len, modified)` elsewhere, applied to the target's *parent directory*; NTFS
bumps a directory's mtime when any child is created, including the `grok.lock`
the transaction itself writes, so every `apply()` returns `ParentChanged`.
Nothing in the room reaches this module. M2 item.

**F5 — the `conpty_ui` 8 s deadline. RESOLVED in `0e8f955`** (lead-directed
follow-up).

The finding as originally written was slightly wrong: `STEP` was not "the first
screen deadline" — it was **one constant shared by 23 structurally different
waits**, from "the whole world boots" to "the word `cancelling` appears". That
conflation was the defect; the margin was the symptom.

Measured with `ZER0_CONPTY_TIMING=1` (added in the same commit; every wait
helper is now `#[track_caller]` and reports its call-site line and elapsed):

First-screen latency, 17 successful runs (plus 2 that the old budget truncated):

| set | n | min | median | max |
| --- | --- | --- | --- | --- |
| all runs | 17 | 2,925 ms | 3,969 ms | **8,236 ms** |
| idle | 10 | 2,925 ms | 3,559 ms | 4,533 ms |
| with a concurrent `CARGO_BUILD_JOBS=8 cargo build` | 7 | 3,933 ms | 6,252 ms | **8,236 ms** |

The other waits, same runs:

| wait | idle | loaded |
| --- | --- | --- |
| post-shutdown screen | 1.04 s | 1.10 s |
| all 20 other sites | ≤ 0.31 s | ≤ 0.45 s |

The old 8 s sat *inside* the loaded boot range — **2 of 6 loaded runs timed out
at 8.02 s**, screen still on PowerShell filler, host not yet at its `START`
checkpoint. That is not a tight margin, it is a budget below the measured
distribution.

Decided by design, not by nudging. Neither budget is a product latency contract
(this is a ConPTY correctness proof), so both are harness budgets set from the
measurement, with the derivation written into the file:

- `BOOT = 20 s` for the first frame — worst observed 8.24 s × 2.4. Covers
  PowerShell spawn, 49 filler lines, the **debug-profile** binary starting, the
  Node host spawn, a four-round-trip JSON-RPC handshake and the first render.
- `STEP = 8 s` **unchanged** for the 22 post-boot reaction waits — worst
  observed 1.10 s, so 7.3× headroom. Deliberately not tightened: these budgets
  only spend wall-clock when the test is already failing, and a slower CI host
  has no measured headroom to give back.

After: **0 failures / 8 runs** (3 under the same build load, boot 3.51 – 6.67 s).
A timeout now reads
`screen predicate at …conpty_ui.rs:156 timed out after 8.02s (budget 8s) and
1311 PTY bytes` instead of naming neither the site nor the budget.

## 6. Decisions that deviate from the brief's stated expectation

1. **Pager `default = ["room-runtime"]`, not `[]`.** The brief expected `[]`.
   `cargo check -p xai-grok-pager --no-default-features` exits 0, so `[]`
   compiles — but then the crate's surviving test targets only build through
   workspace feature unification and `cargo test -p xai-grok-pager` alone fails.
   The room build is unaffected either way: `zer0-v2-bin` pulls the pager with
   `default-features = false`. Reversible in one line.
2. **More than the 19 named declarations were removed** — every optional
   dependency whose sole activator was a deleted feature went too, because an
   unactivated optional dep still pins packages in `Cargo.lock`.
3. **`[workspace.lints.rust] unexpected_cfgs check-cfg`** declares
   `grok-runtime` / `local-workspace` as known-but-never-set rather than
   re-adding them as empty features (an empty feature would be a declared
   feature that cannot compile). Without it the ~500 surviving cfg sites in the
   pager emit 445 `unexpected 'cfg' condition value` warnings; with it, 0, and
   the pager lib is back to its baseline 42 warnings.
4. **Four files outside the brief's anticipated list were touched**, all under
   `rust/` (which the brief allows): `xai-grok-config/src/managed_text/tests.rs`
   and `xai-grok-paths/src/lib.rs` (F4 and two Windows-only path literals —
   without them the `--workspace` flip installs an infinite hang into
   `npm run verify`), plus rustfmt over the two files this lane had left
   unformatted. Measured: those two were the **only** files in the whole
   workspace failing `cargo fmt --check`, i.e. the tree was fmt-clean at the pin
   and this lane had regressed it. There is no fmt gate in `package.json` today.

## 7. C2 — the four pager dev declarations: all four pruned, by measurement

- **`xai-grok-agent`** — `cargo test -p xai-grok-pager --no-run` exits 101:
  `bin/protoc found at ..\..\..\bin/protoc but failed to execute: %1 is not a
  valid Win32 application. (os error 193)` → `xai-grok-tools-api/build.rs:49`
  panics. Zero references from the pager's `tests/` or `benches/`; its four
  `src/` users are all `grok-runtime`-gated.
- **`xai-grok-shell`** — same protoc closure
  (`xai-grok-tools → xai-grok-agent → xai-grok-shell`); its only consumer
  `tests/settings_e2e.rs` also needs `grok-runtime`-gated pager modules.
- **`xai-grok-pager-pty-harness`** — compiles, but its own 3 test targets fail
  10/10: they shell out to build `xai-grok-pager-bin`, grok's composition root,
  which this prune deletes —
  `package ID specification 'xai-grok-pager-bin' did not match any packages`.
- **`xai-grok-test-support`** — compiles, but 2 of its own lib tests fail here
  (`sandbox::tests::windows_platform_essentials_are_allowlisted` → `SystemRoot`;
  `process::tests::windows_job_kill_reaps_spawned_grandchild` → `pid file
  timeout`). Its only surviving pager consumer `tests/pty_auto_mode.rs` has all
  `TestSandbox` cases `#[ignore]`d.

Pruning the last two also drops `xai-acp-lib`, giving the 20-package set.

**Cost, stated plainly.** Four pager tests that ran under the keep-the-harness
option are gone: `pty_auto_mode::pty_harness_api_surface_for_auto_mode_e2e` and
`scripted_scenarios::{scenarios_parse, ansi_execute_output_scenario_parses,
vim_modal_command_palette_scenario_parses}`, plus 56 `#[ignore]`d PTY cases.
*(These four names and the 56 count are carried from the measurement taken
before `cf07701`, when the harness still existed; they cannot be re-derived from
the current tree.)* The pager crate itself is kept **whole** — verified on the
final tree: `git ls-files` counts **867** tracked files / **731** `.rs`, none
deleted; only target declarations were pruned, with `autotests`/`autobenches`
off so grok's product roots are not auto-discovered.
