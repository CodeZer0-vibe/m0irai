# FINDER REPORT — lens: plan-logic
(delivered in full by finder-plan-logic via SendMessage, 2026-08-16; the finder's own partial file write was replaced with this complete copy by main. Text verbatim, formatting condensed.)

**Document reviewed:** `D:\Zer0 Chat V2\.council\review-copy\standalone-v2-spec.md`
**Evidence trees:** `D:\Zer0 Chat V2\sources\zer0-agent-ci` (branch `codex/v2-room-layer`, HEAD `106d5ea`) · `D:\Zer0 Chat V2\sources\grok-build-b13-candidate` · `D:\Zer0 Chat V2\.cache\target\release-dist\zer0-v2.d` · `closure-181-repo.txt`

**Headline — three things in this plan cannot happen as written.**
1. The oracle's positive path cannot pass: `session/new` refuses a non-git directory, and the oracle's project root is "a fresh temp project root".
2. The Rust allow-list is package-granular where the Node one is file-granular. The 19 packages carry **1,012 `.rs` files** of which **292** compile, and copying just those 19 makes `cargo metadata` exit 101 because 20 further local packages are referenced by the retained manifests.
3. The oracle's "`assertProductionJavaScript` over every staged production JS file" fails on **30 of 182** compiled files today — all 30 retained — for reasons unrelated to TypeScript.

## 1. §1 facts
- **F1 · spec:51-52 · nit · CONFIRMED** — the `node` fact cites `host_process.rs:1065` (`OsString::from("node")`), the non-Windows arm; the Windows arm is `:1063` `"node.exe"`. Substance right. The lines above (`:1056-1059`) carry the fact that matters to P2: the launcher hard-fails with `"release host script does not exist beside executable"` — the Rust-side contract for "stage the sidecar beside that exact executable".
- **F2 · §1 + S7 · important · CONFIRMED** — **`git` is a hard runtime prerequisite** and appears nowhere in the spec: `room-host.ts:120-123` throws without a scoped project id; `project-scope.ts:149-152` returns `unscopable` outside a git work tree (executed on a fresh dir → `unscopable`). Also invoked at Rust build time (`xai-grok-pager/build.rs:7` runs `git rev-parse --short HEAD`). Decision 8 names only Node.
- Verified (no finding): compileMemory/buildPrompt claim (four closure importers of prompt-builder.js, `estimateTokens` only; wrapper `prompt-builder.ts:83-85` over `prompt-budgeter.ts:33`); Rust closure 292/215/11/66 → 19 packages, both cargo chains, licences; protocol corpus 39 files, in neither source repo; JSON-RPC zod refs = 0; tracked fixture at `agent-prompt-stack.test.ts:39-44` — read is cwd-relative `readFileSync(".zer0/workflows/…")`, so relocation must change the literal too.

## 2. Allow-list derivation (S3)
- **F3 · §3 rust/ block + P4 · important · CONFIRMED** — package-granular Rust list: the 19 packages hold **1,012 `.rs`** files; **292** compile; **720 dead** (659 in `xai-grok-pager` alone, behind `#[cfg(feature = "grok-runtime")]`, which `zer0-v2-bin` disables: `Cargo.toml:37 default-features = false`, `:15 grok-pager-room = ["dep:xai-grok-pager", "xai-grok-pager/room-runtime"]`). P4 passes with all 720 present.
- **F4 · §3:174 + P1 · important · CONFIRMED** — copying only the 19 makes `cargo metadata --locked` exit 101: retained manifests reference 20 further local packages (`zer0-v2-bin` dev → `ptyctl`; `xai-grok-pager` optional → 16 (`xai-acp-lib, xai-crash-handler, xai-fast-worktree, xai-file-utils, xai-grok-agent, xai-grok-announcements, xai-grok-plugin-marketplace, xai-grok-sandbox, xai-grok-shell, xai-grok-telemetry, xai-grok-tools, xai-grok-update, xai-grok-voice, xai-grok-workspace, xai-hooks-plugins-types, xai-token-estimation`) + dev → 4; `xai-grok-pager-render` optional → 3). A never-enabled optional path dep is fatal to `cargo metadata` (minimal repro executed: exit 101, "failed to load source for dependency").
- **F5 · P1/S0/S3b/S8 · important · CONFIRMED** — the test closure adds 4 local packages (`ptyctl`, `xai-grok-pager-pty-harness`, `xai-grok-test-support`, `common/xai-test-utils`); consumers `zer0-v2-bin/tests/conpty_ui.rs:21` and 21 files under `xai-grok-pager/tests/`. Pruning dev-deps deletes those suites; the spec never states which Rust tests survive. **A `rust/` with zero test targets passes §4 item 6.**
- **F6 · §3 members · important · READ** — `xai-grok-pager`'s `default = ["grok-runtime", "jemalloc", "sandbox-enforce"]`; workspace-wide `cargo test` compiles the whole grok product surface. Removing the feature to satisfy P4 removes that code → the Rust half is a **fork**, not an extraction (F39).
- **F7 · §3 `.cargo/config.toml (own target dir)` · important · CONFIRMED** — rewriting it drops `[target.x86_64-pc-windows-msvc] rustflags = ["-C","force-unwind-tables=yes","-C","target-feature=+crt-static"]` (and the profile comment `Cargo.toml:358` points at them). The outer workspace config also supplies `PROTOC` (relative path); `protoc` not on PATH; no prost/tonic in retained manifests → probably not needed, but it is the exact "hidden dependency on the old workspace" shape.
- **F8 · §3 root block · important · CONFIRMED** — vitest loads `./vitest.setup.ts` and globalSetup `tests/setup/{codex-home-global,worker-store-root,real-store-guard}.ts` (+ `real-store-fingerprint.ts`); none in the map; also missing `vitest.config.live.ts`, `vitest.config.integration.ts`.
- **F9 · §3 src/ + S6(b) · important · CONFIRMED** — `src/memory/digest-runner.ts` in neither closure nor additions (only importers: `cli/commands/chat-tui-boot.ts:29`, `chat-tui-mount.ts:50`).
- **F10 · S3b live-files · important · CONFIRMED** — 7 of 9 rows must go (5 tower + `src/chat/structural-diff.live.test.ts` (prod file not retained) + `tests/e2e/ghost-composer-conpty.test.ts` (Ink CLI)); only `src/memory/digest-extractor.live.test.ts` survives — a real ~250 s codex call, so `test:live` inside `gates` puts a live model call in every gate run.
- **F11 · S3 · nit · CONFIRMED** — `createRequire`/`require.resolve` (`acp-servers.ts:17,56`) is a resolution class S3's list does not name.
- **F12 · §3 `.gitignore` · important · READ** — specified list is a strict subset of what the room writes under repoRoot: `.council/runs/<id>/` (`session-store.ts:18`, `zer0-v2-host.ts:562-568`), `.zer0/blobs/` (`:443`), `.zer0/leases/digest-*.lock` (`digest-failsafe.ts:97`), `.zer0/journal/digest-failures.log` (`:154`), `.zer0/debug/<id>/` (`debug-mode.ts:25`).
- **F13 · P4 vs §3 · nit · READ** — `.zer0/oracle/UNSUPPORTED` both a committed file and gitignored.
- **F14 · P3 vs §3 vs package.json · important · CONFIRMED** — P3 omits `gate-encoding`, `gate-agent-files`; collapses `test`, `test:live`, `test:integration` into "vitest".
- **F15 · "12 dependencies" · important · CONFIRMED** — asserted without derivation; `closure-npm-packages.txt` omits `better-sqlite3`, the two ACP bridges and `@openai/codex` and includes `@types/*` — not a runtime derivation.
- **F16 · "no bin/dev" · nit · READ** — ambiguous; the devDependencies reading makes P3 impossible.

## 3. Sequence
- **F17 · S5 vs S7 · important · READ** — the first live acceptance (S5) precedes `release.mjs` (S7): certifies a hand-assembled artifact. S7 depends only on S3b; move it before S5.
- **F18 · S1 + §4 · important · READ** — the oracle must change at S3b (paths), S6 (schema set), S7 (assembly smoke); G-H's gate audit is scoped before two of the three edits.
- **F19 · S0 vs I1 · nit · READ** — `git worktree add` performs a checkout and writes `.git/worktrees/<name>/` inside the protected tree; I1's wording vs intent.

## 4. Oracle
- **F20 · §4 step 3 · important · CONFIRMED** — positive path cannot pass: `session/new` → `AliveRoomHost.create` → `resolveBootLiveness` → `resolveProjectId` returns `unscopable` for a non-git dir AND for a dir that is not its own git toplevel (executed). Falsifier reports red for the wrong reason (class G on the falsifier itself).
- **F21 · §4 step 3 vs P6/I5/S6 · important · CONFIRMED** — `{14}` vs P6: room-host `openDb` → `{14}`; digest child `openMemoryDb` (`digest-run.ts:80`) → `{14,15}`; `journal_entries` created by v15; `assertSchemaVersion` compares the full ascending row-set; detached child → race. I5 as written is falsified after S6 (`GLOBAL_VERSION_KEYS` tolerates 14,15 functionally).
- **F22 · §4 step 1 + S6(a) · important · CONFIRMED** — `assertProductionJavaScript` regexes over `dist/`: 30/182 fail, all retained, all preserved comments (`.ts's`, `cockpit.tsx's`).
- **F23 · §4 step 3 · important · READ** — no RPC method named for "one write and one read"; every write candidate spawns an agent (`zer0/room/submit`) or writes outside the repo; reads (`session/list`, `catalog`, `resync`) are fine.
- **F24 · §4 step 3 · important · READ** — **not hermetic**: `createRoom()` calls `ensureAgyStatusline()` → `writeAgyStatuslineSettings()` (`zer0-v2-host.ts:405-435`, `agy-statusline-config.ts:76-106`) — writes the operator's global agy settings on every oracle run.
- **F25 · §4 + S6 + §5b · important · READ** — after S6 every gate run fires a real codex call via the digest child (`digest-run.ts:33-36 createCodexDispatch()`); failures go to `.zer0/journal/digest-failures.log`, never stdout. `ZER0_DIGEST_FAKE` (in `CHILD_PASSTHROUGH`, `digest-runner.ts:51`) is the deterministic switch the spec never mentions.

## 5. Digest design (S6)
- **F26 · S6(c) · important · READ** — `bootCatchUp(repoRoot, dbPath, projectId)` needs `projectId`, which exists only after `session/new` (`room-host.ts:120`); `initialize` sets a flag and returns (`zer0-v2-host.ts:242-248`). S6(c) contradicts itself.
- **F27 · S6 vs §3 "no retained file grows" · important · READ** — at least four retained files grow: packager (recursive scan + copy), `digest-runner.ts` (ENTRY/TSX_LOADER/argv), `zer0-v2-host.ts` (state + close owner), `room-host.ts` (close hook, and S7's drain in the same shutdown deadline).
- **F28 · digest-runner.ts:30-34,62 · nit · READ** — `TSX_TSCONFIG_PATH: path.join(REPO_ROOT, "tsconfig.json")` in `digestChildEnv()` is a leftover source-root assumption S6(a) does not name.
- **F29 · §5b "one flag from off" · nit · CONFIRMED** — no flag, no caller: production callers only in the deleted CLI; `memoryEnabled()` default-ON and `digest-run.ts` never consults it. S6 is new wiring, not configuration.

## 6. Fresh-clone failures
- **F30 · packager `npm ci --omit=dev` inside the staged sidecar · important · READ** — the oracle (and thus `npm run gates`) needs the registry and a native toolchain on every run.
- **F31 · P10 Rust · important · CONFIRMED** — `include_str!`/`include_bytes!` are compile-time; nearest mechanism is `env!("CARGO_MANIFEST_DIR")`-anchored (still an ancestor walk, manifest-relative). Node side can do what P10 asks.
- **F32 · rust-toolchain.toml · nit · CONFIRMED** — `targets = ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"]` triggers rustup downloads V2 never builds.
- **F33 · workspace Cargo.toml:3-4 · nit · READ** — `[patch.crates-io] async-openai = { git = "https://github.com/our-forks/async-openai.git", rev = … }`; unused by the retained binary; a private-looking URL in a public repo.

## 7. Postconditions
- **F34 · P5 · important · READ** — the two clauses contradict for the moved seam files: keeping `--follow` history needs the OLD paths in the filter list, which makes `git log --all -- src/tui` non-empty for `status-mode-language.ts`.
- **F35 · P4 · important · READ** — P4 measures directory names, not file counts; passes with 720 dead `.rs` files and untracked `.council/runs/` transcripts.
- **F36 · P6 · important · CONFIRMED** — "≥1 journal row" is model-dependent (`digest.ts:60-92`: empty facts still advance the watermark and write zero rows); the watermark and replay clauses are the deterministic proof.
- **F37 · P7 · important · READ** — satisfied by the empty set; only agy opens a PTY by default (`acp-servers.ts:19`), outside the registry.
- **F38 · P1, P2, P8, P9 · nit · READ** — not machine-checkable as written ("no other zer0 checkout"; live turn; "except for commits it receives"; human re-inventory).

## 8. Risks / Drawbacks / Alternatives
- **F39 · important · READ** — missing risk: **the Rust half is a permanent fork** — `xai-grok-pager` loses 16 optional deps and its default feature set; ~659 non-compiling files stay dead or get deleted; no upstream updates ever again. Framed in §5b as an inventory exercise.
- **F40 · important · READ** — missing risk: **the gates become non-hermetic** (F24 global settings write, F25 live codex call, F30 registry + toolchain, F10 250-s live test).
- **F41 · nit · READ** — the "two repos" rejection is a preference, not a mechanism argument; the fork nature, package-vs-file granularity and mixed licences are the actual case against a monorepo and are unanswered.
- **F42 · nit · READ** — G-E cannot resolve judgement numbers ("12", "19") that have no derivation on disk.

## Checks that came back clean
- Dynamic imports in the closure: all npm/builtin (`evidence.ts:475 await import("execa")`, `shared/config.ts:143`), rest are type positions.
- No cwd-relative `readFile` literals in production closure code (only the test).
- No protoc/prost/tonic in retained manifests; the two retained `build.rs` only read `GROK_VERSION` and shell to `git`.
- Both cargo chains and the third_party licence set verified.
- Decision 6 correct (`agent-bins.ts` not in closure; range is 44–48).
- `childEnv()` viable for the detached child on Windows (PATH/SystemRoot/HOME/APPDATA/TEMP present; no provider keys) — I3 holds.
- `ZER0_MEMORY` not a blocker for the digest child.
- `listSessions` on a fresh root returns `[]` — `bootCatchUp` safe on a new project.
- I1 honoured: no destructive git anywhere; writes only to the scratchpad and this report.

