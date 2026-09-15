<!-- M2 research (documents only — operator rule 2026-08-18). Produced by a researcher agent 2026-08-19;
     topic T1 of the M2 research brief; sources opened directly by the agent (curl), quotes verified by it;
     re-measured the call-site counts on today's tree. No code change before checkpoint 2. -->

# T1 — pager-theme-state (FL-025, FL-024)

## 1. The problem as it exists in this repo

The pager remembers which color theme is active (GrokNight, GrokDay, TokyoNight, etc.) in a single value shared by the entire program, rather than a piece of data that gets handed to whichever part of the code needs it. That shared value lives at `rust/crates/codegen/xai-grok-pager-render/src/theme/cache.rs:23`: `static CURRENT: AtomicU8 = AtomicU8::new(ThemeKind::GrokNight as u8);`, alongside a second shared flag for "minimal mode" at line 37: `static TERMINAL_NATIVE_LOCK: AtomicBool = AtomicBool::new(false);`. Anything that wants to draw something on screen calls `Theme::current()` (defined `rust/crates/codegen/xai-grok-pager-render/src/theme/mod.rs:266`), which reads that shared value. Measured today: **639 call sites across 110 files** in two crates (`xai-grok-pager-render`: 7 files; `xai-grok-pager`, the app crate that depends on it: 103 files) — close to, but not exactly, the brief's cited 614; the difference is likely measurement drift between when the brief was written and now, not a real discrepancy.

This is fine while the program is actually running — only one theme is ever active at a time. It breaks the test suite, because Rust runs tests concurrently on multiple threads by default, so two tests that each expect their own theme can trample each other through this one shared value. The fix so far has been a hand-built lock: `cache.rs:338`'s `pin_theme()` function, which a test must remember to call to get exclusive access and a known-clean state before touching anything theme-related. Counted today: **108 actual call sites of `pin_theme()` across 13 files** (FINDINGS.md's FL-024 row cites "40 guards" — likely the count from that specific fix commit, not the current total). FL-025's core point, confirmed by reading the code: this only protects tests that call `pin_theme()` directly — a test can still reach the shared value *indirectly*, through a helper function that doesn't carry the guard, exactly as happened with `quote_bar.rs` (FL-024). No amount of manually adding guards closes that hole; it's a property of the design, not a missing checklist item.

## 2. Prior art

**Ratatui's own official architecture guidance** (docs hub `ratatui.rs`, fetched directly): all three patterns it documents hold state in an explicit struct that gets passed around, never a shared global. The Component pattern: "Each component encapsulates its own state, event handlers, and rendering logic" (`https://ratatui.rs/concepts/application-patterns/component-architecture/`). The Flux pattern: "Stores in Ratatui hold the application's state and its logic," shown as a plain `struct Dispatcher { store: Store }` (`https://ratatui.rs/concepts/application-patterns/flux-architecture/`). Evidence class: primary source (the framework's own docs). Label: verified.

**Ratatui's own flagship example does use a global for its theme** — but a critically different kind. `examples/apps/demo2/src/theme.rs:61` on the ratatui repo: `pub const THEME: Theme = Theme { ... };`, read directly as `THEME.root`, `THEME.tabs`, etc. in `app.rs`. This is a compile-time constant — one theme, fixed forever, no runtime switching, so it can never race. m0irai's `CURRENT` is a runtime-mutable atomic that gets `set()` while the program runs (theme picker, `/theme auto`), which is the categorically different, race-prone case. Source: `https://raw.githubusercontent.com/ratatui/ratatui/main/examples/apps/demo2/src/theme.rs` and `.../app.rs`. Label: verified; the "ratatui apps use globals too" reading would be a false equivalence, flagged explicitly rather than left to stand.

**Upstream `xai-org/grok-build`, checked live today**: fetched `D:\grok-ref`'s `origin/main` (new tip `d92c5b0`, 2026-08-19) and diffed `crates/codegen/xai-grok-pager-render/src/theme/cache.rs` against it — zero-byte diff. Upstream has not changed this file as of today. Could **not** verify the diff against the literal fork pin `82d2524` — that commit isn't reachable in the local clone's history (`git log --oneline -1 82d2524` → `fatal: ambiguous argument`; the clone only has 33 "Synced from monorepo" squash commits, oldest 2026-07-16). So: verified for "unchanged since at least 2026-07-16," inferred (not verified) for "unchanged since the literal pin."

**`serial_test` is already a dev-dependency of this exact crate**, already used for three other global-state hazards (clipboard mock path, tmux probe path). `rust/crates/codegen/xai-grok-pager-render/Cargo.toml:97`: `serial_test = { workspace = true }`; usages at `src/clipboard/mod.rs:2142,2158,2176` (`#[serial_test::serial(grok_copy_file)]`), `src/terminal/tmux_probe.rs:434`, `src/util.rs:497`. Its README: "Multiple tests with the `serial` attribute are guaranteed to be executed in serial... Both support optional keys for defining subsets of tests to run in serial together." It's built on `parking_lot` (confirmed reading `serial_test/src/rwlock.rs`), and parking_lot's own doc comment states plainly: "No poisoning, the lock is released normally on panic" (`parking_lot/src/mutex.rs:41`). That matters here because the current homegrown `TEST_LOCK` is a `std::sync::Mutex`, which *does* poison on a panicking test, forcing every acquisition site to carry `.unwrap_or_else(|e| e.into_inner())` — `serial_test` would not need that boilerplate. Evidence class: primary source (crate's own code/docs). Label: verified.

**`rusty-fork`** (last commit 2025-10-04 per GitHub API) runs each test in a whole separate OS process, specifically to survive crashes/segfaults, not just to avoid shared-state races. Heavier than the problem calls for. Label: verified, primary source.

**`thread_local!`**: std docs and the `LocalKey` example show each thread gets its own independent copy — a spawned child thread does not see the parent thread's value. That's a real risk here: the render crate uses a multi-threaded tokio runtime (`rt-multi-thread` in Cargo.toml), so if rendering work ever runs on a worker thread different from the test's own thread, a `thread_local!` CURRENT would silently diverge. Whether that specific crossing happens today was not confirmed (only one `tokio::spawn` call site in the whole crate, not individually inspected) — flagged as unresolved, not confirmed either way.

**`--test-threads=1`**: The Rust Book states the trade-off directly: "Running the tests using one thread will take longer than running them in parallel, but the tests won't interfere with each other if they share state" (`https://doc.rust-lang.org/book/ch11-02-running-tests.html`). Label: verified, primary source.

## 3. Options for m0irai M2

- **A. Do nothing further** — keep adding `pin_theme()` guards reactively as new races surface. Zero cost today, but structurally can't close the "indirect reach" hole (the actual FL-025 finding); a new `quote_bar.rs`-style miss stays possible forever.
- **B. Swap the homegrown `TEST_LOCK`/`pin_theme()` for `#[serial_test::serial(theme)]`** on the affected tests. Dependency cost: zero — it's already a dev-dependency, already proven in this crate for three other globals. Removes the manual poison-recovery boilerplate. Windows behavior: no different, pure in-process locking. Blast radius: small, contained to test attributes plus deleting the custom `TEST_LOCK`/`pin_theme` machinery. Does **not** fix the indirect-reach hole — a test that touches the cache through an un-annotated helper is exactly as unguarded as today.
- **C. The architectural fix** — move `ThemeKind`/`Theme` out of a process-global and into the app's explicit state (an `Arc<RwLock<ThemeKind>>` or a plain field threaded through the dispatcher/render context), matching what ratatui's own docs show for all three of its blessed patterns. The only option that removes the hazard by construction rather than by discipline. Honest cost: touches on the order of 639 call sites across 110 files in two crates — a genuinely large, cross-crate refactor, not a contained one.
- **D. `cargo test -- --test-threads=1`** for the crate. Zero code change, but per the Rust Book's own trade-off, it serializes the *entire* test suite (1,076 `#[test]` functions in this crate alone) to fix a hazard that affects a small subset — disproportionate.

## 4. Recommendation

Do B at M2, track C separately as its own scoped M2/M3 item with the real cost stated above (not folded into "fix the race"). B is low-risk, uses a pattern already proven three times over in this exact crate, and removes the poison-boilerplate tax — but say plainly to whoever picks this up that B does not close FL-025's actual root cause, only FL-024's symptom. Falsifier: re-run the FL-024 lane's own control methodology with `#[serial_test::serial(theme)]` replacing `pin_theme()` — it should reproduce 0/400 failures on the guarded set, same as today's guard achieved; if it doesn't, B isn't equivalent and needs a different key scheme.

## 5. What could not be verified

- Diff against the literal fork pin `82d2524` — unreachable in `D:\grok-ref`'s local history. Ran: `git log --oneline -1 82d2524` → `fatal: ambiguous argument '82d2524': unknown revision or path not in the working tree.` Ran: `git log --all --format="%H %ad %s" --date=short` → 33 commits, all "Synced from monorepo," oldest 2026-07-16 — none match. Substituted a diff against fetched `origin/main` (`d92c5b0`, 2026-08-19) vs. the prior local HEAD (`9fabade`, 2026-08-16), which is a real but narrower claim.
- `crates.io`'s API for `serial_test` metadata: request rejected by its API data access policy. Substituted GitHub raw README + this repo's own Cargo.lock (both opened directly).
- Whether the render crate's single `tokio::spawn` call site ever calls `Theme::current()` on a non-test-thread — not individually inspected; relevant only to why `thread_local!` was not shortlisted as a serious option.

## 6. Sources

- In-repo: rust/crates/codegen/xai-grok-pager-render/src/theme/{cache.rs, mod.rs}, docs/FINDINGS.md (FL-024, FL-025), docs/HANDOFF-m0irai.md, docs/STATE.md, rust/Cargo.lock, the render crate's Cargo.toml, src/clipboard/mod.rs, src/terminal/tmux_probe.rs, src/util.rs
- D:\grok-ref (git remote xai-org/grok-build; local HEAD 9fabade; fetched origin/main d92c5b0, 2026-08-19)
- https://raw.githubusercontent.com/palfrey/serial_test/main/README.md (+ serial_test/src/{code_lock.rs, rwlock.rs})
- https://raw.githubusercontent.com/Amanieu/parking_lot/master/src/mutex.rs (+ README.md)
- https://ratatui.rs/concepts/application-patterns/{component-architecture, flux-architecture, the-elm-architecture}/
- https://raw.githubusercontent.com/ratatui/ratatui/main/examples/apps/demo2/src/{theme.rs, app.rs}
- https://doc.rust-lang.org/book/ch11-02-running-tests.html
- https://doc.rust-lang.org/std/macro.thread_local.html and /std/thread/struct.LocalKey.html
- https://raw.githubusercontent.com/altsysrq/rusty-fork/master/README.md (+ GitHub API commit date)
- https://crates.io/api/v1/crates/serial_test (opened, request rejected — see §5)
