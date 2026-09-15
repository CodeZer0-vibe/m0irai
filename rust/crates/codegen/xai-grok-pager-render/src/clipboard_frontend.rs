//! Service-free system clipboard core used by the shared pager frontend.
//!
//! This deliberately owns real text reads/writes.  Grok's richer delivery
//! policy, attachment probes, and telemetry remain in `clipboard/mod.rs`.

pub use xai_ratatui_textarea::{ClipboardProvider, InternalClipboard};

/// Result of a direct OS clipboard write.
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum ClipboardDelivery {
    Confirmed,
    Failed,
}

impl ClipboardDelivery {
    pub fn reported_success(self) -> bool {
        matches!(self, Self::Confirmed)
    }
}

/// The system clipboard implementation used by the real textarea widget.
#[derive(Debug, Default)]
pub struct SystemClipboard;

impl SystemClipboard {
    pub fn try_set(text: &str) -> ClipboardDelivery {
        if set_system_text(text).is_ok() {
            ClipboardDelivery::Confirmed
        } else {
            ClipboardDelivery::Failed
        }
    }
}

impl ClipboardProvider for SystemClipboard {
    fn get(&mut self) -> Option<String> {
        system_clipboard_get()
    }

    fn set(&mut self, text: &str) {
        let _ = Self::try_set(text);
    }
}

/// Read ordinary text from the operating-system clipboard.
pub fn system_clipboard_get() -> Option<String> {
    get_system_text().ok().flatten()
}

/// Non-empty clipboard content is safe to route through a user-initiated paste.
pub fn clipboard_text_is_pasteable(text: Option<&str>) -> bool {
    text.is_some_and(|value| !value.is_empty())
}

/// The shared frontend has no telemetry service. Preserve diagnostics without
/// manufacturing a room-specific service path.
pub fn log_paste_key_empty_host_clipboard(surface: &str) {
    tracing::debug!(
        surface,
        "paste requested with no readable host clipboard text"
    );
}

/// Copy text to the OS clipboard, falling back to a caller-visible file when
/// the host has no clipboard provider (headless SSH/container environments).
pub fn copy_text_or_file(text: &str) -> CopyDelivery {
    if SystemClipboard::try_set(text).reported_success() {
        return CopyDelivery::Clipboard;
    }
    match write_copy_fallback(text) {
        Ok(path) => CopyDelivery::File { path },
        Err(error) => CopyDelivery::Failed {
            error: error.to_string(),
        },
    }
}

pub fn copy_text(text: &str) -> ClipboardDelivery {
    SystemClipboard::try_set(text)
}

#[derive(Debug)]
pub enum CopyDelivery {
    Clipboard,
    File { path: std::path::PathBuf },
    Failed { error: String },
}

/// Persist a copy fallback atomically enough for the single-process room UI.
pub fn write_copy_fallback(text: &str) -> std::io::Result<std::path::PathBuf> {
    let path = std::env::var_os("GROK_COPY_FILE")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("grok-last-copy.txt"));
    std::fs::write(&path, text)?;
    Ok(path)
}

#[cfg(target_os = "macos")]
fn get_system_text() -> std::io::Result<Option<String>> {
    use std::process::Command;
    let output = Command::new("pbpaste").output()?;
    if output.status.success() {
        String::from_utf8(output.stdout)
            .map(|text| (!text.is_empty()).then_some(text))
            .map_err(std::io::Error::other)
    } else {
        Ok(None)
    }
}

#[cfg(target_os = "macos")]
fn set_system_text(text: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let mut child = Command::new("pbcopy").stdin(Stdio::piped()).spawn()?;
    child
        .stdin
        .take()
        .expect("piped stdin")
        .write_all(text.as_bytes())?;
    if child.wait()?.success() {
        Ok(())
    } else {
        Err(std::io::Error::other("pbcopy failed"))
    }
}

#[cfg(not(target_os = "macos"))]
fn get_system_text() -> std::io::Result<Option<String>> {
    let mut clipboard = arboard::Clipboard::new().map_err(std::io::Error::other)?;
    match clipboard.get_text() {
        Ok(text) => Ok((!text.is_empty()).then_some(text)),
        Err(error) => Err(std::io::Error::other(error)),
    }
}

#[cfg(not(target_os = "macos"))]
fn set_system_text(text: &str) -> std::io::Result<()> {
    let mut clipboard = arboard::Clipboard::new().map_err(std::io::Error::other)?;
    clipboard.set_text(text).map_err(std::io::Error::other)
}
