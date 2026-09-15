//! Pager presentation primitives.
//!
//! The default `grok-runtime` retains the complete upstream surface.  Zer0's
//! `room-runtime` uses the same frame writer and terminal renderer, but does
//! not compile ACP/config/workspace/telemetry/tool service adapters.

#[cfg(feature = "frontend-runtime")]
pub mod appearance;
// Grok keeps its service-aware delivery/telemetry policy.  The room build
// compiles the same public text clipboard owner with direct OS backends and
// no shared-service dependency.
#[cfg(feature = "grok-runtime")]
pub mod clipboard;
#[cfg(all(feature = "frontend-runtime", not(feature = "grok-runtime")))]
#[path = "clipboard_frontend.rs"]
pub mod clipboard;
#[cfg(feature = "grok-runtime")]
pub mod gboom;
#[cfg(feature = "frontend-runtime")]
pub mod glyphs;
#[cfg(feature = "frontend-runtime")]
pub mod host;
#[cfg(feature = "frontend-runtime")]
pub mod link_opener;
#[cfg(feature = "frontend-runtime")]
pub mod modal_window_state;
#[cfg(feature = "frontend-runtime")]
pub mod prompt_images;
#[cfg(feature = "frontend-runtime")]
pub mod render;
#[cfg(feature = "room-runtime")]
pub mod room_theme;
#[cfg(feature = "frontend-runtime")]
pub mod syntax;
#[cfg(feature = "frontend-runtime")]
pub mod terminal;
#[cfg(feature = "frontend-runtime")]
pub mod theme;
#[cfg(feature = "frontend-runtime")]
pub mod util;
