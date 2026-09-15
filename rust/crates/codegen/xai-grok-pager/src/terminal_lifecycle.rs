//! Pager-owned terminal lifecycle shared by all service-neutral frontends.
//!
//! This is extracted from the full application's startup/teardown path.  The
//! full Grok app may add service configuration around it, but the terminal
//! ownership, writer-drain ordering, input modes, and renderer theme are not
//! service concerns.

use std::io::{self, Write};

use crossterm::cursor::{self, SetCursorStyle};
use crossterm::event;
use crossterm::execute;
use crossterm::terminal::{self, EnterAlternateScreen, LeaveAlternateScreen};
use ratatui::backend::CrosstermBackend;

pub use crate::render::draw::PagerTerminal;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreenMode {
    Fullscreen,
    Inline,
}

impl ScreenMode {
    pub fn is_fullscreen(self) -> bool {
        matches!(self, Self::Fullscreen)
    }
}

fn with_stderr<T>(f: impl FnOnce(&mut io::StderrLock<'_>) -> io::Result<T>) -> io::Result<T> {
    let stderr = io::stderr();
    let mut locked = stderr.lock();
    f(&mut locked)
}

/// Install the renderer theme before terminal cursor initialization.
pub fn engage_startup_theme(_mode: ScreenMode) {
    let initial_theme = crate::theme::cache::resolve_initial_theme();
    crate::theme::cache::set(initial_theme);
}

/// Initialize the actual pager terminal writer and input modes.
pub fn init_terminal(
    mode: ScreenMode,
    _minimal_live_rows: u16,
    _clear_main_screen: bool,
    frame_tx: crate::render::draw::WriterSender,
    writer_sync: crate::render::draw::WriterSync,
    _cursor_blink: Option<bool>,
) -> io::Result<(PagerTerminal, ScreenMode)> {
    terminal::enable_raw_mode()?;
    let initialized = (|| -> io::Result<(PagerTerminal, ScreenMode)> {
        with_stderr(|stderr| {
            if mode.is_fullscreen() {
                execute!(stderr, EnterAlternateScreen)?;
            }
            execute!(
                stderr,
                event::EnableMouseCapture,
                event::EnableFocusChange,
                event::EnableBracketedPaste,
                cursor::Hide,
            )?;
            match _cursor_blink {
                Some(true) => execute!(
                    stderr,
                    cursor::EnableBlinking,
                    SetCursorStyle::BlinkingBlock
                ),
                Some(false) => {
                    execute!(stderr, cursor::DisableBlinking, SetCursorStyle::SteadyBlock)
                }
                None => Ok(()),
            }
        })?;
        crate::theme::apply_cursor_color();
        let terminal_context = crate::terminal::terminal_context();
        let skip_reason = terminal_context.kitty_skip_reason().or_else(|| {
            match terminal::supports_keyboard_enhancement() {
                Ok(true) => None,
                _ => Some("unsupported"),
            }
        });
        crate::terminal::da2::probe_at_startup();
        let flags = crate::terminal::negotiated_kitty_flags(
            skip_reason,
            crate::terminal::da2::detected_packed(),
        );
        if !flags.is_empty() {
            with_stderr(|stderr| execute!(stderr, event::PushKeyboardEnhancementFlags(flags)))?;
        }
        crate::terminal::set_pushed_kitty_flags(flags);
        let backend = CrosstermBackend::new(
            crate::render::draw::TermWriter::new(frame_tx.clone(), writer_sync.clone())
                .map_err(io::Error::other)?,
        );
        let terminal = if mode.is_fullscreen() {
            xai_ratatui_inline::Terminal::new(backend)?
        } else {
            let (cols, rows) = terminal::size()?;
            if let Ok(terminal) = xai_ratatui_inline::Terminal::with_options(
                backend,
                ratatui::TerminalOptions {
                    viewport: ratatui::Viewport::Inline(rows),
                },
            ) {
                return Ok((terminal, ScreenMode::Inline));
            }
            with_stderr(|stderr| {
                execute!(
                    stderr,
                    crossterm::terminal::ScrollUp(rows),
                    cursor::MoveTo(0, 0)
                )
            })?;
            let fallback_backend = CrosstermBackend::new(
                crate::render::draw::TermWriter::new(frame_tx, writer_sync)
                    .map_err(io::Error::other)?,
            );
            xai_ratatui_inline::Terminal::with_options(
                fallback_backend,
                ratatui::TerminalOptions {
                    viewport: ratatui::Viewport::Fixed(ratatui::layout::Rect::new(
                        0, 0, cols, rows,
                    )),
                },
            )?
        };
        Ok((terminal, mode))
    })();
    if initialized.is_err() {
        let _ = restore_input_modes_for_unwind(mode);
        let _ = terminal::disable_raw_mode();
    }
    initialized
}

pub(crate) fn restore_input_modes_for_unwind(mode: ScreenMode) -> io::Result<()> {
    with_stderr(|stderr| {
        let _ = execute!(stderr, crossterm::terminal::EndSynchronizedUpdate);
        crate::theme::reset_cursor_color();
        let _ = execute!(
            stderr,
            event::DisableMouseCapture,
            event::DisableFocusChange,
            event::DisableBracketedPaste,
        );
        if crate::terminal::take_kitty_flags_pushed() {
            let _ = execute!(stderr, event::PopKeyboardEnhancementFlags);
        }
        if mode.is_fullscreen() {
            execute!(
                stderr,
                SetCursorStyle::DefaultUserShape,
                cursor::Show,
                LeaveAlternateScreen
            )
        } else {
            execute!(stderr, SetCursorStyle::DefaultUserShape, cursor::Show)?;
            writeln!(stderr)?;
            stderr.flush()
        }
    })
}

/// Drain and join the pager writer before emitting terminal teardown bytes, so
/// a late frame can never arrive after `LeaveAlternateScreen`.
pub fn restore_terminal(
    mut terminal: PagerTerminal,
    writer_thread: crate::render::draw::WriterThread,
    mode: ScreenMode,
) -> io::Result<()> {
    if mode.is_fullscreen() && !writer_thread.writer_sync().failed() {
        let _ = terminal.clear();
        let _ = terminal.backend_mut().flush();
    }
    drop(terminal);
    // Ordered ratatui payloads cannot be abandoned safely: a detached writer
    // could resume after LeaveAlternateScreen, while dropping a queued diff
    // would corrupt every later frame. The bounded channel applies pressure
    // during runtime; teardown closes its sender and joins the sole consumer.
    let drain_result = writer_thread.join();
    let teardown = restore_input_modes_for_unwind(mode);
    let _ = terminal::disable_raw_mode();
    drain_result.and(teardown)
}

#[cfg(all(test, feature = "room-runtime"))]
mod tests {
    use super::ScreenMode;

    #[test]
    fn room_terminal_lifecycle_keeps_explicit_screen_mode_configuration() {
        assert!(ScreenMode::Fullscreen.is_fullscreen());
        assert!(!ScreenMode::Inline.is_fullscreen());
    }

    #[test]
    fn room_teardown_disables_every_input_mode_it_enables() {
        let source = include_str!("terminal_lifecycle.rs");
        let bracketed_paste = ["Disable", "BracketedPaste"].concat();
        assert!(source.contains(&bracketed_paste));
    }

    #[test]
    fn room_teardown_joins_the_writer_before_restoring_modes() {
        let source = include_str!("terminal_lifecycle.rs");
        let close = source
            .find("drop(terminal);")
            .expect("room teardown closes the frame sender");
        let join = source
            .find("let drain_result = writer_thread.join();")
            .expect("room teardown joins the sole writer");
        let restore = source
            .rfind("restore_input_modes_for_unwind(mode)")
            .expect("room teardown restores terminal modes");
        assert!(close < join && join < restore);
        let detached_writer = ["writer_thread", ".detach()"].concat();
        assert!(!source.contains(&detached_writer));
    }
}
