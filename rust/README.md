# m0irai — the terminal

This is the Rust half of [m0irai](../README.md): the full-screen terminal that
renders the room. It builds to one executable, `m0irai`, which spawns the
compiled Node room host as a child and talks JSON-RPC to it over stdio.

It is a fork of [`xai-org/grok-build`](https://github.com/xai-org/grok-build).
The pager, its renderer and the terminal plumbing were kept; everything
grok-specific that the room does not run was cut. `SOURCE_REV` records the
upstream commit this tree was taken from (`a51a1dc6`).

**Status: INCOMPLETE — M1 extraction in progress.** `../docs/STATE.md` is the
record of what has actually been proved.

---

## Building

```sh
cargo build --locked -p zer0-v2-bin --profile release-dist
```

Produces `target/release-dist/m0irai.exe`. The toolchain (1.94.0) is pinned by
`rust-toolchain.toml`; `rustup` installs it on first build.

The executable will not start on its own: it requires `zer0-v2-host.mjs` beside
it. See [Running it](../README.md#running-it) for how to stage the host.

## Verifying

From the repository root — never from `rust/` — so the Node half is checked too:

```sh
npm run verify:rust
```

`scripts/verify-rust.mjs` runs, all `--locked`:

1. `cargo metadata`, asserting every workspace member's manifest lives under
   `rust/` (the workspace is closed — nothing resolves outside this tree).
2. `cargo test --workspace`.
3. `cargo test -p xai-grok-pager --lib seam_tests` again with
   `GROK_FORCE_LEGACY_CONSOLE=1` — a legacy Windows console is a supported
   render path with a different glyph set, and the ordinary run is blind to it.
   Re-executes the already-built test binary, so it costs about a second, and
   fails if it reports zero tests executed.
4. `cargo test -p zer0-v2-bin --features test-support --test host_lifecycle` —
   boots a real Node host, and fails if it reports zero tests executed.
5. The same for `--test digest_handoff`.
6. The `release-dist` build, asserting the named binary exists on disk.

## Crates

Twenty workspace members. Nineteen are the room's feature-aware dependency
closure; `ptyctl` is a dev-dependency, used by the ConPTY proof.

### The room

| Crate | What it is |
| --- | --- |
| `crates/zer0-v2-bin` | The composition root and the `m0irai` binary: CLI, host process lifecycle, transport, digest handoff. |
| `crates/zer0-room-protocol` | The validated room event protocol and its deterministic reducer — the contract shared with the Node host. |

### Terminal and rendering (from grok-build)

| Crate | What it is |
| --- | --- |
| `crates/codegen/xai-grok-pager` | The TUI itself: room runtime, scrollback, composer, views. |
| `crates/codegen/xai-grok-pager-render` | Rendering, themes, color support and terminal capability detection. |
| `crates/codegen/xai-grok-markdown` | Streaming markdown renderer for terminal UIs. |
| `crates/codegen/xai-grok-markdown-core` | Headless markdown analysis sharing the same pulldown-cmark config. |
| `crates/codegen/xai-grok-mermaid` | Mermaid source to rasterized PNG, behind a swappable engine trait. |
| `crates/codegen/xai-ratatui-inline` | Forked ratatui `Terminal` — inline / fullscreen / fixed viewports, a `flush()` that reports whether anything was written, and hyperlink spans. |
| `crates/codegen/xai-ratatui-textarea` | The edit buffer and multi-line text area behind the composer. |
| `crates/codegen/xai-tty-utils` | TTY-safe process spawning: detach from the controlling terminal, suppress interactive pagers, process-group lifecycle. |
| `crates/codegen/xai-grok-config` | Config loading and TOML merge (requirements > user > managed). |
| `crates/codegen/xai-grok-paths` | Type-safe absolute/relative UTF-8 path wrappers. |
| `crates/codegen/xai-grok-version` | The version string the CLI reports. |
| `crates/codegen/xai-prompt-queue` | Shared prompt-queue wire types. |
| `crates/codegen/ptyctl` | Headless PTY controller on `alacritty_terminal`. **Dev-dependency only** — it drives the real-ConPTY test. |

### Vendored

| Crate | What it is |
| --- | --- |
| `prod/mc/cli-chat-proxy-types` | Request/response types for the cli-chat-proxy API. |
| `third_party/dagre_rust` | Dagre layout, ported (library-only). |
| `third_party/graphlib_rust` | Dagre's graphlib, ported (library-only). |
| `third_party/mermaid-to-svg` | Mermaid source to SVG via the dagre port (library-only). |
| `third_party/ordered_hashmap` | Insertion-order-preserving HashMap (library-only). |

The workspace membership list in `Cargo.toml` is the authority; a crate that
falls out of the room's closure is caught by
`crates/zer0-v2-bin/tests/room_dependency_closure.rs`.

## Features

`zer0-v2-bin` pulls `xai-grok-pager` with `default-features = false` plus
`room-runtime`. Two feature names matter when reading the pager's source:

* **`room-runtime`** — what the room actually builds. Implies `frontend-runtime`.
* **`grok-runtime`** — **permanently inert.** Its service adapters were deleted
  with their crates, so the feature is never set and every `cfg(feature =
  "grok-runtime")` block is dead code awaiting the M2 prune. Anything gated on it
  (for example the whole of `views/welcome/`) is absent from the shipped binary.

## Development

```sh
cargo check -p <crate>        # target specific crates; full-workspace builds are slow
cargo test -p zer0-v2-bin     # per-crate tests
cargo clippy -p <crate>       # lint config: clippy.toml
cargo fmt --all               # rustfmt.toml
```

> [!WARNING]
> `Cargo.toml` at this root (workspace members, shared dependencies, lints,
> profiles) is **generated**. Prefer editing per-crate `Cargo.toml` files.

## Contributing

> [!NOTE]
> External contributions are not accepted. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

First-party code here is licensed under the **Apache License, Version 2.0** —
see [`LICENSE`](LICENSE). (The Node half of the repository is MIT; see
[`../LICENSE`](../LICENSE) and [`../NOTICE`](../NOTICE).)

Third-party and vendored code remains under its original licenses:

- [`THIRD-PARTY-NOTICES`](THIRD-PARTY-NOTICES) — crates.io / git dependencies,
  bundled UI themes, and in-tree source ports
- [`third_party/NOTICE`](third_party/NOTICE) — vendored Mermaid-stack index
