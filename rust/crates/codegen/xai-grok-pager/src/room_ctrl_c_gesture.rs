//! One physical `Ctrl+C` gesture, so the room can tell a held key from a
//! second tap.
//!
//! The room's `Ctrl+C` ladder cancels on the first press and quits on the
//! second. That is only safe if "second" means *a second deliberate tap*, and
//! nothing in a terminal key event says so:
//!
//! - `KeyEventKind::Repeat` is not the answer. This repository's own module
//!   header says why — *"`KeyEventKind::Repeat` disappears: held keys arrive as
//!   repeated `Press`, as on every non-KKP terminal"*
//!   (`xai-grok-pager-render/src/terminal/kitty_keyboard.rs:28-31`). A guard
//!   that consumes `Repeat` and trusts `Press` is off on the common terminal,
//!   which is where the operator found the bug.
//! - The elapsed time between two events is not the answer either. Autorepeat
//!   intervals and deliberate double-taps overlap: Windows' slowest repeat rate
//!   is ~400 ms (`SPI_SETKEYBOARDSPEED`) and a deliberate tap can be quicker
//!   than that. There is no threshold that separates them.
//!
//! So the gesture is tracked through the **release**, which is the one event
//! that means the operator let go. Everything between a key-down and that
//! release is one gesture and gets one action. A key-down for anything *else*
//! ends it too, and for the same kind of reason: autorepeat repeats only the
//! most recently pressed key, so another key's arrival is positive evidence
//! that the `Ctrl+C` stream stopped.
//!
//! **What happens where releases never arrive.** A terminal that reports no
//! releases would leave a gesture live forever and take the room's escape hatch
//! with it — worse than the bug, because the operator reaches this ladder
//! mid-panic. So a gesture also ends after [`CTRL_C_GESTURE_QUIET`] without any
//! `Ctrl+C` event at all. That is a *release valve*, not the guard: it can only
//! ever end a gesture, and no autorepeat stream on a default configuration
//! reaches a full second of silence while the key is still down (Windows
//! default ~33 ms, X11 default 40 ms, macOS default ~15 ms). The cost of the
//! valve is stated rather than hidden: an operator whose key-repeat interval is
//! configured slower than a second — an accessibility setting, not a default —
//! is back to the unguarded behaviour, and only a real release closes that.
//!
//! Upstream was read first and does not solve this. Its confirm path accepts
//! `Repeat`: `KeyShortcut::matches` rejects only `Release`
//! (`D:\grok-ref\crates\codegen\xai-grok-pager\src\input\key.rs:65-73`), and
//! its `Ctrl+C` ladder escalates to `Quit` as soon as a cancel is pending with
//! nothing stoppable left
//! (`D:\grok-ref\...\app\agent_view\input.rs:1334-1343`), so a held key that
//! outlives the cancel quits there too. The one place upstream *does* guard a
//! destructive arm→confirm uses exactly the `kind == Repeat` test this module
//! exists to replace, with the same hole
//! (`D:\grok-ref\...\src\views\dashboard\state.rs:3522-3526`). What is adopted
//! from upstream is the *shape* of the fix rather than the mechanism: gate the
//! behaviour on whether the terminal reports the event you need, and degrade
//! deliberately when it does not — which is how upstream's hold-to-talk chord
//! reads `releases_reported` and falls back to a tap toggle
//! (`D:\grok-ref\...\app\event_loop.rs:3736-3756`).

use std::time::{Duration, Instant};

/// How long a `Ctrl+C` gesture may go without a key event before the room
/// treats it as over even though no release ever arrived.
///
/// A second, chosen against autorepeat rather than against human timing: every
/// default key-repeat interval is an order of magnitude below it (Windows ~33
/// ms, X11 40 ms, macOS ~15 ms), and the slowest setting any of them exposes —
/// Windows' ~400 ms — is still well inside. It is *not* chosen to be longer
/// than a human double-tap, because that is impossible; a deliberate second tap
/// inside the second is simply carried by the release instead.
pub const CTRL_C_GESTURE_QUIET: Duration = Duration::from_secs(1);

/// The `Ctrl+C` the operator is holding down right now, if any.
///
/// Deliberately not "is a key held": the room cannot know that. It knows how
/// many `Ctrl+C` key-downs have arrived without an intervening release or a
/// [`CTRL_C_GESTURE_QUIET`] silence, which is the observable the ladder needs.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CtrlCGesture {
    /// The most recent `Ctrl+C` key-down of the live gesture.
    latest: Option<Instant>,
    /// Key-downs recorded in the live gesture. `1` means the one just recorded
    /// opened it; `0` means no gesture is live.
    key_downs: u32,
}

impl CtrlCGesture {
    /// Record a `Ctrl+C` key-down — `Press` or `Repeat`, because off Kitty the
    /// autorepeat of a held key is spelled `Press` and the two cannot be told
    /// apart here.
    pub fn key_down(&mut self, now: Instant) {
        let continues = self
            .latest
            .is_some_and(|latest| now.saturating_duration_since(latest) < CTRL_C_GESTURE_QUIET);
        self.key_downs = if continues {
            self.key_downs.saturating_add(1)
        } else {
            1
        };
        self.latest = Some(now);
    }

    /// The gesture is over. One method and not two, because "the key came up"
    /// and "a different key came down" are the same fact to this type — the
    /// `Ctrl+C` stream has stopped — and two methods that reset the same two
    /// fields is a pair that drifts.
    ///
    /// The second caller is not a convenience. Autorepeat repeats the *most
    /// recently pressed* key on Windows, X11 and macOS alike, so a key event
    /// for anything else is positive evidence that no `Ctrl+C` repeat stream is
    /// running any more. Without it, an operator on a terminal that reports no
    /// releases would have to sit out [`CTRL_C_GESTURE_QUIET`] after every
    /// `Ctrl+C` before the room would listen to another one.
    pub fn ended(&mut self) {
        self.latest = None;
        self.key_downs = 0;
    }

    /// Whether the key-down just recorded is the one that OPENED the gesture —
    /// the only `Ctrl+C` allowed to act.
    ///
    /// Read after [`Self::key_down`], never before: it is a statement about the
    /// event the room is routing, not about the past.
    pub fn opened_the_gesture(&self) -> bool {
        self.key_downs == 1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A held key on a terminal that reports no `Repeat` at all: `Press`,
    /// `Press`, `Press`, at the default repeat interval. Only the first acts.
    #[test]
    fn autorepeat_opens_the_gesture_once() {
        let mut gesture = CtrlCGesture::default();
        let start = Instant::now();
        gesture.key_down(start);
        assert!(gesture.opened_the_gesture(), "the first key-down acts");
        // Windows' *slowest* configurable repeat interval, not its default, so
        // the case is the hardest one the valve has to survive.
        for step in 1..=6 {
            gesture.key_down(start + Duration::from_millis(400 * step));
            assert!(
                !gesture.opened_the_gesture(),
                "key-down {step} of a held key must not act"
            );
        }
    }

    /// The release is what ends it, immediately — no window to wait out.
    #[test]
    fn a_release_ends_the_gesture() {
        let mut gesture = CtrlCGesture::default();
        let start = Instant::now();
        gesture.key_down(start);
        gesture.ended();
        gesture.key_down(start + Duration::from_millis(1));
        assert!(
            gesture.opened_the_gesture(),
            "after a release even a 1 ms-later tap is a new gesture"
        );
    }

    /// The release valve, at its boundary. `>= CTRL_C_GESTURE_QUIET` is a new
    /// gesture and one tick less is not, so a `<=`/`<` slip is visible here.
    #[test]
    fn the_quiet_window_ends_a_gesture_with_no_release() {
        let start = Instant::now();
        for (label, gap, opens) in [
            (
                "one tick inside the window",
                CTRL_C_GESTURE_QUIET - Duration::from_millis(1),
                false,
            ),
            ("exactly the window", CTRL_C_GESTURE_QUIET, true),
            (
                "one tick past it",
                CTRL_C_GESTURE_QUIET + Duration::from_millis(1),
                true,
            ),
        ] {
            let mut gesture = CtrlCGesture::default();
            gesture.key_down(start);
            gesture.key_down(start + gap);
            assert_eq!(gesture.opened_the_gesture(), opens, "{label}");
        }
    }

    /// A gesture nobody has started does not report itself as open. The default
    /// is the state every room boots in, and a `key_downs == 1` predicate that
    /// started life at `1` would wave the first held repeat straight through.
    #[test]
    fn a_fresh_gesture_is_not_open() {
        assert!(!CtrlCGesture::default().opened_the_gesture());
    }
}
