//! Zer0 V2 room transport, host lifecycle, and inline terminal presentation.

pub mod boot_progress;
pub mod cli;
pub mod digest_handoff;
pub mod host_exit_words;
pub mod host_process;
pub mod host_shutdown;
pub mod transport;

/// The actual Grok pager application is the Zer0 V2 frontend seam. The
/// quarantined local renderer that used to live under `ui` was deleted in the
/// m0irai Phase 4 prune together with its `quarantined-local-ui` feature —
/// there is no local fallback renderer any more.
#[cfg(feature = "grok-pager-room")]
pub mod pager_room;
