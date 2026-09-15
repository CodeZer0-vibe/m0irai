# Zer0 V2 dependency boundaries

The production Rust composition root is this Grok-local `crates/zer0-v2-bin`. The top-level `D:\Zer0 Chat V2` Rust crate is a foundation oracle pending final consolidation; it is not a second production composition root.

The live host path uses `zer0-room-protocol` plus `anyhow`, `serde_json`, `tokio`, `tokio-util`, and `futures-util`; `HostProcess` owns the reducer, streams ordinary room events to the terminal consumer, and produces immutable snapshots only on demand for startup or diagnostics. Broadcast lag is repaired from the consumer's last delivered event sequence through the bounded resync protocol. `portable-pty` is test-only and the Windows API binding is target-only.

The Zer0 V2 terminal is an internal fork of the actual `xai-grok-pager` application. Its room
mode must reuse the pager's event loop, terminal guard, scrollback, prompt widget, permission and
queue views, themes, animation cadence, and resize behavior. It must not replace those surfaces
with a local Ratatui lookalike. Grok/xAI cloud authentication, agent runtime, billing, telemetry,
updater, voice, marketplace, and provider-owned model-picker paths are excluded from the Zer0 room
composition. The service-neutral room picker may present strictly validated catalogs returned by the
Node room host; it never discovers providers or mutates sessions itself. The Node room host remains
the only provider/runtime owner.

The existing local `src/ui` implementation is quarantined migration evidence only. It remains
available until real-pager parity is proven by deterministic room fixtures and a Windows PTY run,
but it is not an accepted production frontend and must not receive new behavior. The composition
root may depend on `xai-grok-pager` and `xai-grok-pager-render` at the narrow room seam.
`../codegen/xai-tty-utils` remains the host process lifecycle dependency; ConPTY harness work
remains test-only.

The release sidecar is built and staged from the sibling Node checkout with
`npm run package:zer0-v2-sidecar -- <release-directory>`. That command compiles the host, emits
the sibling `zer0-v2-host.mjs`, and makes it import only
`zer0-v2-node/dist/src/room/zer0-v2-host.js`; it never uses `tsx`, `ts-node`, or source TypeScript
at runtime. The staged Node root owns production dependency installation.
