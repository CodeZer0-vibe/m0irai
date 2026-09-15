<!-- M2 research (documents only — operator rule 2026-08-18). Produced by a researcher agent 2026-08-19;
     topic T2 of the M2 research brief; sources opened directly by the agent (curl), quotes verified by it.
     No code change before checkpoint 2. -->

# T2 — Windows file identity (FL-022 / K3)

## 1. The problem as it exists in this repo

In plain words: this module tries to make sure nobody swapped a folder out from under it while it was safely editing a config file — a "did the directory I'm writing into get replaced" check. On Windows it currently does that check by watching the folder's last-modified time. But Windows updates a folder's modified time every time anything inside it is created or deleted — including the module's own temporary lock file. So the check trips itself on every single run, even though nothing was actually swapped.

Technical detail: `FileIdentity` is `(dev, ino)` on unix but `(len, modified)` on Windows (`rust/crates/codegen/xai-grok-config/src/managed_text/source.rs:185-195`), compared in `revalidate_existing` (`source.rs:118`) across every ancestor directory a target file sits under. The module's own test file states the mechanism precisely: "NTFS bumps a directory's mtime whenever a child is created or removed - including the `grok.lock` file the transaction itself creates - so `ensure_and_anchor`/`revalidate` see a changed identity and every `apply()` fails `ParentChanged`" (`managed_text/tests.rs:8-13`). `mod.rs:254` is where that `grok.lock` gets created inside the very directory being watched. One test doesn't just fail red, it HANGS, because the defect makes `apply_with_observer` return before the phase a test barrier is waiting on (`tests.rs:20-23`). 11 `#[cfg_attr(` occurrences in `tests.rs`, matching the "11 tests ignored" claim in docs/FINDINGS.md (FL-022, MAJOR, "M2 (mitigated)"). Mitigated because, per `tests.rs:25-26`, "Nothing in the m0irai room reaches this module: its only consumer is `xai-grok-pager::diagnostics::fix`, behind the `grok-runtime` feature that Phase 4 removed" — independently corroborated by `rust/Cargo.toml:295-301`, where `grok-runtime` is declared "known-but-never-set."

On design intent: the check exists to catch real directory substitution mid-transaction (rename, symlink swap, delete-and-recreate) between planning an edit and publishing it — legitimate. The Windows PRIMITIVE is wrong for that goal: mtime conflates "the directory itself was replaced" (should alarm) with "a file inside it changed" (should not — that's the transaction working as intended).

## 2. Prior art

**Win32 `BY_HANDLE_FILE_INFORMATION`** — volume serial number + 64-bit file index. "In the NTFS file system, a file keeps the same file ID until it is deleted." Also: "File IDs are not guaranteed to be unique over time, because file systems are free to reuse them." — learn.microsoft.com/.../ns-fileapi-by_handle_file_information (updated 2021-04-02). Verified, vendor spec.

**`GetFileInformationByHandleEx` + `FILE_ID_INFO`** — the ReFS-safe upgrade, 128-bit ID. "The 128-bit file identifier for the file... combined with the volume serial number, uniquely identify a file" — .../ns-winbase-file_id_info (Windows Server 2012+). Both by-handle functions take an open `HANDLE`, not a path. Verified, vendor spec.

**[MS-FSCC] protocol spec** on how the 64-bit ID is built: "the low 48 bits are the index of the file's primary record in the master file table (MFT); the remaining 16 bits are a sequence number. Therefore, it is possible, though rare, that a different file can have the same 64-bit file ID as a file on that volume had in the past." — learn.microsoft.com/.../ms-fscc/d4bc551b... Verified, formal spec. Note: this same spec's summary table separately marks NTFS's 64-bit ID "Unique: Yes" — the table is the coarse claim, the prose right under it is the caveat; both reported rather than picking one.

**Rust `std::os::windows::fs::MetadataExt`** — the load-bearing finding: `volume_serial_number()`/`file_index()` are still nightly-only. Read at the exact rustc version this repo pins: "fn volume_serial_number (&self) -> Option < u32 > 🔬 This is a nightly-only experimental API. ( windows_by_handle #63010 )" — doc.rust-lang.org/1.94.0/std/os/windows/fs/trait.MetadataExt.html, matching the `#[unstable(feature = "windows_by_handle", issue = "63010")]` in the std source itself. Verified. Rust's std cannot supply this on stable.

**`same-file` crate** (BurntSushi, MIT/Unlicense) — does exactly this comparison. Its own source states the constraint: "it is critical that both file handles remain open while their attributes are checked for equality... the file index numbers on a Windows stat object are not guaranteed to remain stable over time," and admits it never added the 128-bit path: "It seems straight-forward enough to modify this code to use FILE_ID_INFO when available..., but I don't have access to such Windows machines" (raw.githubusercontent.com/BurntSushi/same-file/master/src/win.rs:9-25). Verified against its actual `Key{volume:u64,index:u64}` struct, same file lines 64-68.

**`winapi-util` crate** (BurntSushi) — what `same-file` is built on; wraps `GetFileInformationByHandle` via raw FFI since std won't expose it stably (.../winapi-util/master/src/file.rs:17-23). Its docs also warn a directory handle needs `FILE_FLAG_BACKUP_SEMANTICS` or "subsequent queries using that handle will fail" (.../win.rs:40-65), which Microsoft's `CreateFile` docs confirm: "To open a directory using CreateFile, specify the FILE_FLAG_BACKUP_SEMANTICS flag." Verified.

**Already in this workspace**: `walkdir`'s and ripgrep's `ignore` crate both depend on `same-file`/`winapi-util` directly (their GitHub Cargo.tomls, both read). More directly: `rust/Cargo.lock:2126-2136, 3685-3690, 5261-5263` already resolves `same-file 1.0.6` and `winapi-util 0.1.11` as transitive deps of `ignore` in THIS workspace. Verified by reading the lockfile.

## 3. Options for m0irai M2

**Option 1 — swap the primitive, keep the architecture.** Change the Windows branch of `FileIdentity` to `(volume_serial_number, file_index)` via `winapi-util::file::information()` on a handle opened with `.custom_flags(FILE_FLAG_BACKUP_SEMANTICS)`. Dependency cost near zero (already resolved in this workspace's Cargo.lock). Fixes the measured false positive while still catching real substitution. The 11 ignored tests become the falsifier directly. Diff stays contained to `source.rs`. Residual risk: still stat-then-close per check rather than holding the handle open across the whole revalidation window, the exact gap `same-file`'s own comment flags.

**Option 2 — hold every ancestor directory open** for the plan's lifetime (extend what `ParentAnchor` already does for the immediate parent to the whole chain), closing that residual risk completely. Cost: `ParentPlan` currently stores lightweight, cloneable snapshots; this replaces that with N held-open handles, a materially bigger diff across `source.rs`/`mod.rs`/`transaction.rs`.

**Option 3 — do nothing now.** FL-022 is already M2 "mitigated": 11 tests `ignore`d (not deleted, not silently passing), zero live consumers today. Zero engineering cost; downside is the ignored tests prove nothing on Windows CI indefinitely, and the hang returns unmodified if `grok-runtime` is ever revived.

## 4. Recommendation

Option 1. It fixes the measured defect with a dependency the workspace already builds, at the smallest diff, and gets a built-in falsifier for free. It leaves one theoretical gap that Option 2 would close — but that's the same residual risk `same-file`'s maintainer accepts in a crate ripgrep and walkdir ship at far larger scale, so accepting it here, for a module with zero live consumers, matches how the ecosystem itself treats it rather than inventing a shortcut.

Falsifier: with the fix applied, un-ignore the 11 `#[cfg_attr(windows, ignore = "K3...")]` tests and run them on windows-x86_64. Proof is two-sided: (a) `transaction_lock_blocks_second_apply_then_stale_revalidation_wins` completes instead of hanging, and creating `grok.lock` no longer trips `ParentChanged`; (b) a new negative test that renames or delete-and-recreates the parent mid-transaction still DOES trip `ParentChanged` — proving the fix narrowed the false positive without turning the check into a no-op.

## 5. What could not be verified

No measured collision-rate study for NTFS 64-bit file ID reuse was found. Search run: `WebSearch("ReFS 128-bit file ID vs 64-bit NTFS file index collision rate measured study")` — returned general ReFS/NTFS comparison articles and the [MS-FSCC] spec page (then opened directly); none contained a quantitative rate. Labeled unknown, not filled with a number.

Real ancestor-directory depth at an actual install path was not probed — sizing Option 2's "N handles" cost concretely would require a live measurement, out of scope for a documents-only brief.

## 6. Sources

- In-repo: rust/crates/codegen/xai-grok-config/src/managed_text/{source.rs, mod.rs, tests.rs}, docs/FINDINGS.md, rust/Cargo.toml, rust/Cargo.lock
- https://learn.microsoft.com/en-us/windows/win32/api/fileapi/ns-fileapi-by_handle_file_information
- https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileinformationbyhandle
- https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getfileinformationbyhandleex
- https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info
- https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilea
- https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fscc/d4bc551b-7aaf-4b4f-ba0e-3a75e7c528f0
- https://doc.rust-lang.org/1.94.0/std/os/windows/fs/trait.MetadataExt.html
- https://doc.rust-lang.org/stable/std/os/windows/fs/trait.MetadataExt.html
- https://raw.githubusercontent.com/rust-lang/rust/master/library/std/src/os/windows/fs.rs
- https://raw.githubusercontent.com/BurntSushi/same-file/master/src/win.rs
- https://raw.githubusercontent.com/BurntSushi/winapi-util/master/src/file.rs
- https://raw.githubusercontent.com/BurntSushi/winapi-util/master/src/win.rs
- https://raw.githubusercontent.com/BurntSushi/walkdir/master/Cargo.toml
- https://raw.githubusercontent.com/BurntSushi/ripgrep/master/crates/ignore/Cargo.toml
