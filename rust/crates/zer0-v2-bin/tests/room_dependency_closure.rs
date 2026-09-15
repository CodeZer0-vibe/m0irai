//! Regression guard for the room-only pager composition.
//!
//! Two independent pins, because they fail for different reasons:
//!
//! 1. `zer0_workspace_members_are_exactly_the_room_set` — the m0irai Phase 4
//!    prune cut this workspace from 83 members to 20. This asserts *set
//!    equality* against `cargo metadata --locked`, so it fails both when a 21st
//!    member appears and when a retained one disappears. Membership is the
//!    cheap, total check: a re-introduced grok crate has to be a path
//!    dependency, and a path dependency is a member.
//! 2. `zer0_room_dependency_closure_excludes_grok_services` — the *activated*
//!    release graph must not reach Grok's service runtime. Kept as a
//!    `cargo tree` test rather than a manifest string match: an optional
//!    dependency can sit in a manifest without entering the activated graph,
//!    so the manifest is the wrong oracle for this property.

use std::path::PathBuf;
use std::process::Command;

/// The measured Phase 4 closure: the room binary's feature-aware dependency
/// closure (`cargo tree -p zer0-v2-bin -e normal,build`, 19 workspace crates)
/// plus `ptyctl`, the dev-dependency `tests/conpty_ui.rs` drives.
///
/// Changing this list is a deliberate act: it must be accompanied by an entry
/// in `docs/provenance/deletions-rust.json` (removals) or by a stated reason
/// the room now needs a new crate (additions).
const ROOM_WORKSPACE_MEMBERS: [&str; 20] = [
    "dagre_rust",
    "graphlib_rust",
    "mermaid-to-svg",
    "ordered_hashmap",
    "prod-mc-cli-chat-proxy-types",
    "ptyctl",
    "xai-grok-config",
    "xai-grok-markdown",
    "xai-grok-markdown-core",
    "xai-grok-mermaid",
    "xai-grok-pager",
    "xai-grok-pager-render",
    "xai-grok-paths",
    "xai-grok-version",
    "xai-prompt-queue",
    "xai-ratatui-inline",
    "xai-ratatui-textarea",
    "xai-tty-utils",
    "zer0-room-protocol",
    "zer0-v2-bin",
];

fn workspace_manifest() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("zer0-v2-bin lives below the workspace root")
        .join("Cargo.toml")
}

fn cargo(args: &[&str]) -> std::process::Output {
    let manifest = workspace_manifest();
    let manifest = manifest.to_str().expect("workspace UTF-8 path");
    let output = Command::new(env!("CARGO"))
        .args(args)
        .args(["--manifest-path", manifest])
        .output()
        .unwrap_or_else(|err| {
            panic!("cargo must be available to the test harness: `cargo {args:?}` failed to spawn: {err}")
        });
    assert!(
        output.status.success(),
        "`cargo {args:?} --manifest-path {manifest}` exited {status:?}:\n{stderr}",
        status = output.status.code(),
        stderr = String::from_utf8_lossy(&output.stderr)
    );
    output
}

#[test]
fn zer0_workspace_members_are_exactly_the_room_set() {
    // `--no-deps` restricts the output to workspace members and skips resolving
    // the 600-package graph; `--locked` still refuses a stale Cargo.lock.
    let output = cargo(&["metadata", "--locked", "--format-version", "1", "--no-deps"]);
    let metadata: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("cargo metadata emits JSON on stdout");

    let packages = metadata["packages"]
        .as_array()
        .expect("cargo metadata always carries a `packages` array");
    let name_of = |id: &serde_json::Value| -> String {
        packages
            .iter()
            .find(|p| p["id"] == *id)
            .and_then(|p| p["name"].as_str())
            .unwrap_or_else(|| panic!("workspace member {id} has no package entry under --no-deps"))
            .to_owned()
    };

    let mut actual: Vec<String> = metadata["workspace_members"]
        .as_array()
        .expect("cargo metadata always carries a `workspace_members` array")
        .iter()
        .map(name_of)
        .collect();
    actual.sort();

    let mut expected: Vec<String> = ROOM_WORKSPACE_MEMBERS
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
    expected.sort();

    let appeared: Vec<&String> = actual.iter().filter(|n| !expected.contains(n)).collect();
    let vanished: Vec<&String> = expected.iter().filter(|n| !actual.contains(n)).collect();

    assert!(
        appeared.is_empty() && vanished.is_empty(),
        "workspace membership drifted from the measured Phase 4 room closure.\n  \
         appeared (not in the pinned set): {appeared:?}\n  \
         vanished (pinned but no longer a member): {vanished:?}\n  \
         pinned {expected_len} / found {actual_len}\n  \
         next action: if the change is intended, edit ROOM_WORKSPACE_MEMBERS in \
         crates/zer0-v2-bin/tests/room_dependency_closure.rs and record the reason in \
         docs/provenance/deletions-rust.json; otherwise a grok crate has been pulled back in.",
        expected_len = expected.len(),
        actual_len = actual.len()
    );
    // Set equality above already implies this, but a duplicate member name
    // would slip past `contains` on both sides.
    assert_eq!(
        actual.len(),
        ROOM_WORKSPACE_MEMBERS.len(),
        "workspace member count {} != pinned {}: {actual:?}",
        actual.len(),
        ROOM_WORKSPACE_MEMBERS.len()
    );
}

#[test]
fn zer0_room_dependency_closure_excludes_grok_services() {
    let output = cargo(&[
        "tree",
        "--locked",
        "-p",
        "zer0-v2-bin",
        "-e",
        "normal",
        "--prefix",
        "none",
    ]);

    let tree = String::from_utf8_lossy(&output.stdout);
    let forbidden = [
        "xai-grok-shell ",
        "xai-grok-agent ",
        "xai-grok-auth ",
        "xai-grok-telemetry ",
        "xai-grok-update ",
        "xai-grok-voice ",
        "xai-grok-plugin-marketplace ",
        "agent-client-protocol ",
        "xai-acp-lib ",
    ];
    let hits = forbidden
        .iter()
        .copied()
        .filter(|name| tree.lines().any(|line| line.starts_with(name)))
        .collect::<Vec<_>>();
    assert!(
        hits.is_empty(),
        "Zer0 room build must not activate Grok service dependencies: {hits:?}\n{tree}"
    );

    // The positive check prevents a "solution" that removes the actual pager
    // and falls back to the rejected local TUI.
    for required in ["xai-grok-pager ", "xai-grok-pager-render "] {
        assert!(
            tree.lines().any(|line| line.starts_with(required)),
            "room build must retain the actual pager primitive: {required}\n{tree}"
        );
    }
}
