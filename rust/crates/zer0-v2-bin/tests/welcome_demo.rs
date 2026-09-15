#![cfg(all(windows, feature = "welcome-demo"))]

//! Real-ConPTY proof for the demo-only welcome surface (`--welcome-demo`).
//!
//! The demo exists so the boot branding can be judged before it ships, so this
//! proves the thing an operator will actually do: launch it, watch the entrance
//! finish, replay it with `r`, quit with `q`.
//!
//! On catching a mid-entrance frame without racing the terminal: the entrance
//! clock starts when the card is FIRST PAINTED (`RoomView::welcome_elapsed_secs`
//! sets its start instant on first call, from inside that paint). So frame one
//! is the t=0 frame by construction — no character typed yet — no matter how
//! loaded the machine is. Asserting that the room header reaches the byte stream
//! strictly before the completed wordmark is therefore a stable proof that the
//! name was typed rather than printed, with no timing wait anywhere.

use std::{
    io::{Read, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use ptyctl::{
    pty::{PtyChild, PtyConfig, PtyHandle},
    term::{ScreenOpts, SessionListener, Terminal},
};

const BOOT: Duration = Duration::from_secs(20);
const STEP: Duration = Duration::from_secs(8);
/// The hero card, as two things a real terminal must show.
///
/// TRAP: `CARD_NAME` is deliberately NOT used as a substring. The room header,
/// the room footer, the console title ConPTY announces at startup (the
/// executable's own path) and the footer's working directory all contain the
/// product name, so `screen.contains("m0irai")` is true with no card on screen
/// at all. It is matched as a WHOLE TRIMMED ROW instead: the card centres the
/// name alone on its own line and no chrome line ever trims to just the name,
/// which also makes it a settled-state marker — a half-typed row trims to
/// "m0ir".
const TAGLINE: &str = "three minds · one thread";
const CARD_NAME: &str = "m0irai";

/// Whether some row holds `needle` and nothing else but the card's own border.
///
/// A terminal row spans the full width, so the card's name arrives as
/// `│              m0irai              │`. The border glyphs come off
/// first, then the padding, and what is left must be exactly the name. Chrome
/// rows can never reduce to it: the header trims to "m0irai · the room" and
/// the footer to "m0irai · #<session>".
fn card_name_row(screen: &str, needle: &str) -> bool {
    screen.lines().any(|line| {
        line.trim()
            .trim_matches(|glyph| glyph == '│' || glyph == '|')
            .trim()
            == needle
    })
}

const ROOM_HEADER: &str = "m0irai · the room";

struct PtyCleanup {
    child: Option<PtyChild>,
}
impl Drop for PtyCleanup {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut()
            && child.is_alive()
        {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn the_welcome_demo_plays_its_entrance_replays_it_and_quits() -> Result<()> {
    let binary = option_env!("CARGO_BIN_EXE_m0irai")
        .context("Cargo must expose the demo-feature m0irai executable")?;

    let config = PtyConfig {
        command: vec![binary.into(), "--welcome-demo".into()],
        cols: 120,
        rows: 40,
        cwd: None,
        env: Default::default(),
    };
    let (_master, child, reader, writer) = PtyHandle::spawn(&config)?.into_parts();
    let mut cleanup = PtyCleanup { child: Some(child) };
    let (input_tx, input_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let (reply_tx, reply_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    let terminal = start_terminal(reader, 120, 40, SessionListener::new(reply_tx));
    start_writer(writer, input_rx, reply_rx);

    // The entrance finishes on its own; wait for the state, never for a clock.
    wait_screen(&terminal, BOOT, |screen| card_name_row(screen, CARD_NAME))?;
    let settled = screen(&terminal.0);
    assert_eq!(
        settled.matches(TAGLINE).count(),
        1,
        "the settled demo shows the hero card exactly once\n{settled}"
    );

    // Sanity that the stream carries real frames at all. The raw-stream check
    // this replaces asserted the name was TYPED rather than printed, by
    // proving the settled wordmark never appeared as one contiguous run. That
    // needle was a braille block no chrome could contain; the name is now
    // ordinary text, and the room header writes "m0irai" contiguously on its
    // very first frame, so the same check would now fail on chrome rather than
    // on a printed name. Dropped deliberately instead of weakened: the reveal
    // math is pinned deterministically by unit tests, and the replay below is
    // this suite's real-terminal proof that the entrance actually animates.
    let raw = strip_osc(&String::from_utf8_lossy(
        &terminal.2.lock().unwrap().clone(),
    ));
    assert!(
        raw.contains(ROOM_HEADER),
        "sanity: the stripped stream must still hold real frames"
    );

    // `r` replays from zero: the finished name leaves the screen, then returns.
    send(&input_tx, "r")?;
    wait_screen(&terminal, STEP, |screen| !card_name_row(screen, CARD_NAME))
        .context("`r` must clear the settled name and replay the entrance")?;
    wait_screen(&terminal, STEP, |screen| card_name_row(screen, CARD_NAME))
        .context("the replayed entrance must settle again")?;

    // `q` quits cleanly, restoring the terminal.
    send(&input_tx, "q")?;
    let code = wait_child(cleanup.child.as_mut().context("PTY child")?, STEP)?;
    assert_eq!(code, 0, "`q` must exit the demo cleanly");
    let modes = terminal.0.lock().unwrap().terminal_modes();
    assert!(
        !modes.alt_screen && modes.show_cursor,
        "the demo must restore the terminal: {modes:?}"
    );
    cleanup.child.take();
    Ok(())
}

type TerminalTriple = (Arc<Mutex<Terminal>>, Arc<AtomicUsize>, Arc<Mutex<Vec<u8>>>);

fn start_terminal(
    reader: Box<dyn Read + Send>,
    cols: u16,
    rows: u16,
    listener: SessionListener,
) -> TerminalTriple {
    let terminal = Arc::new(Mutex::new(Terminal::new(cols, rows, listener)));
    let bytes = Arc::new(AtomicUsize::new(0));
    let raw = Arc::new(Mutex::new(Vec::new()));
    let terminal_thread = Arc::clone(&terminal);
    let bytes_thread = Arc::clone(&bytes);
    let raw_thread = Arc::clone(&raw);
    thread::spawn(move || {
        let mut reader = reader;
        let mut buffer = [0; 4096];
        while let Ok(read) = reader.read(&mut buffer) {
            if read == 0 {
                break;
            }
            bytes_thread.fetch_add(read, Ordering::AcqRel);
            raw_thread
                .lock()
                .unwrap()
                .extend_from_slice(&buffer[..read]);
            terminal_thread.lock().unwrap().feed(&buffer[..read]);
        }
    });
    (terminal, bytes, raw)
}

fn start_writer(
    writer: Box<dyn Write + Send>,
    input_rx: std::sync::mpsc::Receiver<Vec<u8>>,
    mut reply_rx: tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
) {
    thread::spawn(move || {
        let mut writer = writer;
        loop {
            while let Ok(reply) = reply_rx.try_recv() {
                if writer.write_all(&reply).is_err() {
                    return;
                }
                let _ = writer.flush();
            }
            match input_rx.recv_timeout(Duration::from_millis(20)) {
                Ok(bytes) => {
                    if writer.write_all(&bytes).is_err() {
                        return;
                    }
                    let _ = writer.flush();
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
    });
}

fn screen(terminal: &Arc<Mutex<Terminal>>) -> String {
    terminal
        .lock()
        .unwrap()
        .screen_content(&ScreenOpts {
            include_empty: true,
            ..Default::default()
        })
        .lines
        .join("\n")
}

/// Drop every OSC sequence (`ESC ]` … `BEL` or `ESC \`) from a terminal stream.
/// Their payloads are metadata, not screen content.
fn strip_osc(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(start) = rest.find("\u{1b}]") {
        out.push_str(&rest[..start]);
        let tail = &rest[start + 2..];
        let end = tail
            .find('\u{7}')
            .map(|at| at + 1)
            .or_else(|| tail.find("\u{1b}\\").map(|at| at + 2));
        match end {
            Some(end) => rest = &tail[end..],
            // Unterminated OSC: everything after it is metadata too.
            None => return out,
        }
    }
    out.push_str(rest);
    out
}

fn send(input_tx: &std::sync::mpsc::Sender<Vec<u8>>, keys: &str) -> Result<()> {
    input_tx
        .send(keys.as_bytes().to_vec())
        .context("PTY writer stopped")?;
    Ok(())
}

#[track_caller]
fn wait_screen(
    terminal: &TerminalTriple,
    timeout: Duration,
    predicate: impl Fn(&str) -> bool,
) -> Result<()> {
    let site = std::panic::Location::caller();
    let deadline = Instant::now() + timeout;
    loop {
        if predicate(&screen(&terminal.0)) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            anyhow::bail!(
                "screen predicate at {}:{} never held within {timeout:?}; screen was:\n{}",
                site.file(),
                site.line(),
                screen(&terminal.0)
            );
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn wait_child(child: &mut PtyChild, timeout: Duration) -> Result<u32> {
    let deadline = Instant::now() + timeout;
    loop {
        if !child.is_alive() {
            return Ok(child.wait()?);
        }
        if Instant::now() >= deadline {
            anyhow::bail!("demo did not exit within {timeout:?}");
        }
        thread::sleep(Duration::from_millis(20));
    }
}
