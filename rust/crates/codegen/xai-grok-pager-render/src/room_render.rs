//! Service-neutral subset of the upstream renderer used by Alive Room.
//!
//! Keep the pager writer/diff pipeline physically shared with Grok.  Only the
//! service-specific overlays (tools, images and ACP-configured paths) are
//! omitted from this room feature.

#[path = "render/color.rs"]
pub mod color;
#[path = "render/draw.rs"]
pub mod draw;
#[path = "render/line_utils.rs"]
pub mod line_utils;
#[path = "render/safe_buf.rs"]
pub mod safe_buf;
#[path = "render/wrapping.rs"]
pub mod wrapping;
