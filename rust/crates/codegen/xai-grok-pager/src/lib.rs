//! xai-grok-pager — Grok Build TUI.
//!
//! A clean-room implementation built on the v3 pager rendering engine.

#[cfg(feature = "grok-runtime")]
pub mod acp;
#[cfg(feature = "grok-runtime")]
pub mod actions;
#[cfg(feature = "grok-runtime")]
pub mod app;
#[cfg(feature = "grok-runtime")]
pub mod client_identity;
#[cfg(feature = "grok-runtime")]
pub mod completions_cmd;
#[cfg(feature = "grok-runtime")]
mod config_toml_edit;
#[cfg(feature = "grok-runtime")]
pub mod diagnostics;
#[cfg(feature = "grok-runtime")]
pub mod diff;
#[cfg(feature = "grok-runtime")]
pub mod disk_usage_cmd;
#[cfg(feature = "grok-runtime")]
pub mod docs;
#[cfg(feature = "grok-runtime")]
pub mod doctor_cmd;
#[cfg(feature = "grok-runtime")]
pub mod export_cmd;
#[cfg(feature = "grok-runtime")]
pub(crate) mod fs_size;
#[cfg(feature = "grok-runtime")]
pub mod git_info;
#[cfg(feature = "grok-runtime")]
pub mod headless;
#[cfg(feature = "grok-runtime")]
pub mod hyperlink_route;
#[cfg(feature = "grok-runtime")]
pub mod inline_media_ffmpeg;
#[cfg(feature = "frontend-runtime")]
pub mod input;
#[cfg(feature = "frontend-runtime")]
pub mod input_log;
#[cfg(feature = "grok-runtime")]
pub mod mcp_cmd;
#[cfg(feature = "grok-runtime")]
pub mod memory_cmd;
#[cfg(feature = "grok-runtime")]
pub mod memory_release;
#[cfg(feature = "grok-runtime")]
pub mod memory_trace;
// ── Minimal (scrollback-native) mode seam ────────────────────────────────────
// The *only* minimal-specific surface in this (the "full pager") crate. Both
// modules are grouped under `src/minimal/` so a full-pager contributor sees one
// folder to ignore, not files scattered through the module list. All the actual
// minimal rendering lives in the sibling `xai-grok-pager-minimal` crate; these
// are just the two narrow seams it connects through:
//   - `minimal_hook` — pager → minimal dispatch (fn-pointer IoC seam).
//   - `minimal_api`  — minimal → pager read surface (facade over `pub(crate)`s).
// Module names are kept flat (via `#[path]`) so existing references and
// every `crate::minimal_{api,hook}` call site stay valid.
#[cfg(feature = "grok-runtime")]
#[path = "minimal/api.rs"]
pub mod minimal_api;
#[cfg(feature = "grok-runtime")]
#[path = "minimal/hook.rs"]
pub mod minimal_hook;
#[cfg(feature = "grok-runtime")]
pub mod models;
#[cfg(feature = "grok-runtime")]
pub mod notifications;
#[cfg(feature = "grok-runtime")]
#[allow(unused_imports, unused_macros)]
pub mod obf;
#[cfg(feature = "grok-runtime")]
pub mod plugin_cmd;
#[cfg(feature = "grok-runtime")]
pub mod pty_wrap;
#[cfg(feature = "grok-runtime")]
pub mod recent_dirs;
#[cfg(feature = "frontend-runtime")]
pub mod scrollback;
#[cfg(feature = "frontend-runtime")]
pub mod search;
#[cfg(feature = "grok-runtime")]
pub mod sessions_cmd;
#[cfg(feature = "grok-runtime")]
pub mod settings;
#[cfg(feature = "grok-runtime")]
pub mod share_cmd;
#[cfg(feature = "grok-runtime")]
pub mod slash;
#[cfg(all(feature = "frontend-runtime", not(feature = "grok-runtime")))]
#[path = "slash_frontend.rs"]
pub mod slash;
#[cfg(feature = "grok-runtime")]
pub mod startup;
#[cfg(feature = "frontend-runtime")]
pub mod terminal_lifecycle;
#[cfg(all(test, feature = "grok-runtime"))]
pub mod test_util;
#[cfg(feature = "grok-runtime")]
pub mod tips;
#[cfg(feature = "grok-runtime")]
pub mod tutorial_docs;
#[cfg(feature = "grok-runtime")]
pub mod wrap_clipboard_image;
#[cfg(feature = "grok-runtime")]
pub mod wrap_cmd;
#[cfg(feature = "grok-runtime")]
pub(crate) mod wrap_filter;
#[cfg(feature = "grok-runtime")]
pub(crate) mod wrap_restore;

#[cfg(feature = "grok-runtime")]
pub mod tool_usage;

// Presentation-primitives layer extracted into the sibling crate
// `xai-grok-pager-render`. Re-exported at the crate root so existing
// `crate::<module>::...` references throughout the pager keep resolving.
#[cfg(feature = "grok-runtime")]
pub use xai_grok_pager_render::gboom;
#[cfg(feature = "frontend-runtime")]
pub use xai_grok_pager_render::glyphs;
#[cfg(feature = "room-runtime")]
pub use xai_grok_pager_render::room_theme;
#[cfg(feature = "frontend-runtime")]
pub use xai_grok_pager_render::{
    appearance, clipboard, host, link_opener, modal_window_state, prompt_images, syntax, util,
};
#[cfg(feature = "frontend-runtime")]
pub use xai_grok_pager_render::{render, terminal, theme};
#[cfg(feature = "grok-runtime")]
pub mod trace_cmd;
#[cfg(feature = "grok-runtime")]
pub mod tracing;
#[cfg(feature = "grok-runtime")]
pub mod unified_log;
#[cfg(feature = "frontend-runtime")]
pub mod views;
#[cfg(feature = "grok-runtime")]
pub mod voice;
#[cfg(feature = "grok-runtime")]
pub mod worktree_cmd;

/// The strict decoder for the host boot readiness snapshot (`zer0/room/agents`).
#[cfg(feature = "room-runtime")]
pub mod room_agents;
#[cfg(feature = "room-runtime")]
pub mod room_composer_menu;
#[cfg(feature = "room-runtime")]
pub mod room_ctrl_c_gesture;
#[cfg(feature = "room-runtime")]
pub mod room_permission_view;
#[cfg(feature = "room-runtime")]
pub mod room_picker;
#[cfg(feature = "room-runtime")]
mod room_picker_contract;
/// FL-126: the prompts a cancelled turn still owes the composer.
#[cfg(feature = "room-runtime")]
pub mod room_prompt_restore;
#[cfg(feature = "room-runtime")]
#[path = "app/room_runtime.rs"]
pub mod room_runtime;
#[cfg(feature = "room-runtime")]
pub mod room_scrollback;
#[cfg(feature = "room-runtime")]
pub mod room_steps_block;
#[cfg(feature = "room-runtime")]
pub mod room_view;
// The braille logo renderer physically lives under `views/welcome/`, but that
// whole subtree is declared behind `grok-runtime` (views/mod.rs:114) — a
// feature this workspace no longer sets and never will; see the note on
// xai-grok-pager-render's `unexpected_cfgs` lint, which calls those ~62 cfg
// sites "permanently inert (M2 removes the code itself)". The room needs the
// renderer and nothing else from that subtree, so it is mounted here directly,
// the same way `room_runtime` above is mounted out of `app/`. Leaving the file
// where it is keeps its `include_str!` asset paths and its history intact.
#[cfg(feature = "room-runtime")]
#[path = "views/welcome/logo.rs"]
pub mod room_logo;
#[cfg(feature = "room-runtime")]
pub mod room_welcome;
