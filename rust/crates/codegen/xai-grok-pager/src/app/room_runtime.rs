//! Shared-room execution inside the real pager terminal.
//!
//! The room host remains the authoritative state owner. This module owns only
//! pager presentation: terminal lifecycle, the existing Grok composer, input
//! editing, and the single chronological transcript viewport.

use std::sync::{
    Arc, Mutex, Once, OnceLock, TryLockError,
    atomic::{AtomicBool, AtomicU8, Ordering},
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::Context;
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::buffer::Buffer;
use ratatui::layout::{Alignment, Constraint, Layout, Rect};
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Clear, Paragraph, Widget};
use tokio::sync::mpsc;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};
use zer0_room_protocol::{
    AgentAuthState, AgentAvailabilityState, AgentStatusState, AgentUsageState, LanePhase,
    RoomEvent, RoomReducer,
};

use crate::render::draw::{CursorState, WriterEvent, WriterSync, draw_frame, spawn_writer_thread};
use crate::room_composer_menu::{
    RoomCatalogAgent, RoomCatalogSnapshot, RoomMenuKind, overlay_for, render_overlay,
};
use crate::room_picker::{
    RoomModelCatalog, RoomPickerChoice, RoomPickerRequest, RoomPickerState, RoomSessionRow,
};
use crate::room_prompt_restore::SubmissionId;
use crate::room_theme::{RoomIdentity, RoomSecondaryGlyph, RoomTheme, room_secondary};
use crate::room_view::{RoomAgentReadiness, RoomReadinessSnapshot, RoomView};
use crate::terminal_lifecycle::{
    PagerTerminal, ScreenMode, engage_startup_theme, init_terminal, restore_terminal,
};
use crate::views::prompt_widget::{
    EnterOutcome, PromptBg, PromptInfo, PromptRenderResult, PromptStyle,
};
use room_usage_meters::{Meter, MeterKind, fit_compact_kept, visible_meters};

/// FL-095 and the weekly display rule. Its own file rather than more of this one: three builders are
/// in room_runtime.rs at once this wave, and a policy nobody else touches does not belong in the
/// middle of the seam they share.
#[path = "room_usage_meters.rs"]
mod room_usage_meters;

/// The two host-update arms of [`run_loop`], extracted so the tests drive the
/// production path and not a copy of it (FL-126).
#[path = "room_runtime_events.rs"]
mod room_runtime_events;
use room_runtime_events::{
    apply_room_event_at, apply_room_snapshot_at, apply_submit_settled, send_submission,
};

/// The composer's typed slash commands, parsed. A pure function over text with
/// no room state, lifted out of this file for the same reason as the arms
/// above: `room_runtime.rs` has no Rust clamp gate (FL-135) and round 3 added
/// real new surface here, which is paid for by extraction and never by growth.
#[path = "room_runtime_commands.rs"]
mod room_runtime_commands;
use room_runtime_commands::{ParsedRoomCommand, parse_room_command};

/// Slice D's unseen-answer pill: what the list holds, when it gains and loses
/// entries, and the width ladder its text follows. Lifted out for the same
/// reason as the three modules above — this file has no clamp gate and pays
/// for new surface by extraction. Its WIRING stays here: one reconciliation
/// point inside the frame, one guidance rung, one mouse arm, one chord.
#[path = "room_answer_pill.rs"]
mod room_answer_pill;
use room_answer_pill::{answer_pill_text, reconcile_unseen_answers};

/// A request emitted by the pager room surface. The composition root translates
/// it to the Zer0 host protocol; the pager has no dependency on that backend.
#[derive(Debug)]
pub enum RoomCommand {
    Submit {
        /// The pager's own id for this submission (FL-126).
        ///
        /// Rides out with the text and comes back on
        /// [`RoomUpdate::SubmitSettled`], which is what binds the held prompt
        /// to the turn this became — or drops it if the host refused. It
        /// cannot be minted without queueing that held prompt, so a submit
        /// with no entry behind it is not constructible.
        submission: SubmissionId,
        text: String,
    },
    CycleMode {
        composer_text: String,
    },
    Control {
        command: RoomControlCommand,
        scope: Option<RoomCancelScope>,
        agent: Option<String>,
    },
    PermissionResponse(crate::room_permission_view::RoomPermissionAction),
    Picker(RoomPickerRequest),
    CancelPicker,
}

#[derive(Debug, Clone, Copy)]
pub enum RoomControlCommand {
    Pause,
    Resume,
    Cancel,
}

#[derive(Debug, Clone, Copy)]
pub enum RoomCancelScope {
    Latest,
    All,
    Agent,
}

/// The panic button's room-wide cancel, on its own wire to the host.
///
/// **A separate type on a separate channel, and that IS the fix.** The ordinary
/// command bridge dequeues one command and awaits its host RPC before touching
/// the next, and one of those RPCs — the mode cycle — is allowed 130 seconds. A
/// cancel behind it is not slow, it is unstarted: the bridge has not dequeued
/// it and will not for two minutes, while the room says the agents stopped. A
/// channel that can carry anything grows a queue in front of the panic button,
/// so this one carries nothing else.
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub struct RoomCancelAll {
    /// Which ask this is.
    ///
    /// Carried so that a late acknowledgement of a SUPERSEDED cancel cannot be
    /// read as evidence about the current one — the room would otherwise say
    /// "agents stopped" on the strength of an answer to a different question.
    pub seq: u64,
}

/// The only backend-facing inputs to the room runtime.
pub struct RoomRuntimeInput {
    /// Exactly what the shipped binary prints for `--version`. Supplied by the
    /// composition root because only it knows its own package version: the
    /// pager's `xai_grok_version::VERSION` is grok's, not this product's, and
    /// showing it on the boot card would print a version nothing reports.
    pub version: String,
    pub current_session_id: String,
    pub reducer: RoomReducer,
    pub catalog: RoomCatalogSnapshot,
    pub updates: mpsc::Receiver<RoomUpdate>,
    pub commands: mpsc::Sender<RoomCommand>,
    /// The panic button's own wire — see [`RoomCancelAll`].
    pub cancels: mpsc::Sender<RoomCancelAll>,
}

/// Presentation updates supplied by the composition root. A snapshot replaces
/// local state after a bounded broadcast receiver reports lag.
#[derive(Debug)]
pub enum RoomUpdate {
    Event(RoomEvent),
    Snapshot(RoomReducer),
    PickerModels {
        request_id: u64,
        result: Result<RoomModelCatalog, String>,
    },
    PickerSessions {
        request_id: u64,
        result: Result<Vec<RoomSessionRow>, String>,
    },
    /// Slice A: the boot readiness sample, delivered to a RUNNING room.
    ///
    /// ⚠ NOT a field on `RoomRuntimeInput`. That struct is passed by value into `run_room` and is
    /// fixed for the room's lifetime, so readiness there forces one of two bad outcomes: await the
    /// probe and delay the first frame, or seed `Unknown` with no way to ever update it. Neither is
    /// acceptable, and the room already has the right channel — this is the same shape
    /// `PickerModels` uses for an async host request whose result reaches a running room.
    AgentReadiness(RoomReadinessSnapshot),
    /// The host answered one `zer0/room/submit`, naming the turn it became.
    ///
    /// `turn: None` means the submit produced no turn — the host refused it, or
    /// answered without naming one — and the prompt this room was holding for
    /// it is dropped rather than left to be claimed by somebody else's turn.
    ///
    /// Unordered against [`RoomUpdate::Event`] and it does not need to be: the
    /// bridge task and the event forwarder hold clones of one sender, so this
    /// can arrive before or after its own turn's events, and the entry is
    /// matched by `submission` either way. An entry whose events ran ahead of
    /// its response is simply resolved the moment the response lands.
    SubmitSettled {
        submission: SubmissionId,
        turn: Option<String>,
    },
    Notice(String),
    Failed(String),
    /// The room host's PROCESS ended while the room was running.
    ///
    /// Its own variant rather than [`RoomUpdate::Failed`], because `Failed` is
    /// unconditionally a runtime failure — its arm ends the room with
    /// `break Err` — and a host that ended NORMALLY is not one: the room is
    /// simply over, and the operator's quit is worth an exit code of 0. Reported
    /// by the H-0 review on 2026-09-12 as "the variant is wrong, not only the
    /// string".
    ///
    /// `sentence` is the launcher's whole description of the death: who ended the
    /// process, why, and the bound it gave up on. The pager does not compose it
    /// and must not try to — only the composition root knows what its own exit
    /// record means. Rendered verbatim, so a launcher that learns a new cause
    /// says so here without this crate being touched.
    HostExited {
        /// True only when the host ended ITSELF and reported success. Anything
        /// else — a non-zero code, or a terminate this launcher had already
        /// decided on — is a failure that carries `sentence` out to stderr.
        clean: bool,
        sentence: String,
    },
    /// The host answered the room-wide cancel numbered `seq`.
    ///
    /// The room's ONE piece of evidence that anyone was actually told to stop.
    /// Everything before this is an ask: a local enqueue, then a request in
    /// flight. The guidance row is not allowed to say "agents stopped" until
    /// this arrives, for the same reason a check mark is not allowed on a tool
    /// call that failed.
    CancelReachedHost {
        seq: u64,
    },
}

/// Terminal-restored outcome consumed by the CLI lifecycle owner.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RoomRuntimeExit {
    Exit,
    LoadSession(String),
    NewSession,
}

/// Start a Zer0 shared room using the pager's normal terminal initialization,
/// writer thread, synchronized drawing, and restoration path.
pub async fn run_room(input: RoomRuntimeInput) -> anyhow::Result<RoomRuntimeExit> {
    let mode = ScreenMode::Fullscreen;
    engage_startup_theme(mode);
    install_room_panic_hook();
    // Arm before initialization: `init_terminal` enables raw mode before it
    // can report a recoverable error, and a panic there must not strand it.
    let mut emergency_restore = EmergencyTerminalRestore::arm(mode)?;
    let (frame_tx, writer_sync, mut writer_events, writer_thread) = spawn_writer_thread();
    emergency_restore.register_writer(writer_sync.clone())?;
    #[cfg(feature = "room-test-support")]
    let proof_writer_sync = writer_sync.clone();
    let (mut terminal, effective_mode) = init_terminal(mode, 4, false, frame_tx, writer_sync, None)
        .context("could not initialize the Grok pager terminal")?;
    emergency_restore.set_mode(effective_mode);

    let result = run_loop(&mut terminal, input, &mut writer_events).await;
    #[cfg(feature = "room-test-support")]
    let result = if result.is_ok()
        && std::env::var_os("ZER0_ROOM_TEST_REQUIRE_WRITER_BACKPRESSURE").is_some()
        && proof_writer_sync.backpressure_count() == 0
    {
        Err(anyhow::anyhow!(
            "writer backpressure was required but the bounded frame queue never filled"
        ))
    } else {
        result
    };
    let restored = restore_terminal(terminal, writer_thread, effective_mode)
        .context("could not restore the Grok pager terminal");
    if restored.is_ok() {
        emergency_restore.disarm_after_restore();
    }
    result.and_then(|outcome| restored.map(|_| outcome))
}

async fn run_loop(
    terminal: &mut PagerTerminal,
    input: RoomRuntimeInput,
    writer_events: &mut mpsc::UnboundedReceiver<WriterEvent>,
) -> anyhow::Result<RoomRuntimeExit> {
    let RoomRuntimeInput {
        version,
        current_session_id,
        reducer,
        catalog,
        mut updates,
        commands,
        cancels,
    } = input;
    let mut room = RoomView::new();
    room.version = version;
    room.picker = RoomPickerState::new(current_session_id);
    room.reducer = reducer;
    room.catalog = catalog;
    room.scrollback = crate::room_scrollback::RoomScrollback::from_reducer_with_motion(
        &room.reducer,
        room.reduced_motion,
    );
    room.permissions.sync(&room.reducer, &mut room.prompt);
    // CQ-09: a thread the OS refuses is a reportable error, not a crash. The
    // `?` hands it to the caller above, which restores the terminal and
    // disarms the emergency guard on exactly this path.
    let (mut input_rx, reader) =
        spawn_input_reader().context("could not start the pager input reader")?;
    let mut file_search_poll = tokio::time::interval(Duration::from_millis(132));
    // The room has no idle animation of its own, so this timer exists solely for
    // the welcome card, and its `if` guard below switches it off for good the
    // moment the card retires. The card is the ONE surface here that moves on
    // its own: its entrance, and then the mark's shine, which the operator ruled
    // on 2026-08-19 must keep going for as long as the room is empty. The moment
    // there is anything to say, the card and the motion go together — and a room
    // that has ever held content never arms this again.
    let mut welcome_tick = tokio::time::interval(crate::room_welcome::TICK);
    // `Skip`, not the default `Burst`: the entrance reads the wall clock, so a
    // tick the loop was too busy to service has nothing left to say by the time
    // it would fire. Bursting would replay those wakeups back-to-back and repaint
    // the same computed frame several times over.
    welcome_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    // Recomputed from the room before every select, so its initial value is
    // never the one that arms the timer.
    let mut welcome_showing;
    let mut cursor = CursorState::new();
    let mut redraw = true;

    let result = loop {
        if redraw {
            draw_room(terminal, &mut cursor, &mut room);
            redraw = false;
            #[cfg(feature = "room-test-support")]
            if std::env::var_os("ZER0_ROOM_TEST_ABORT_WITH_FRAME_IN_FLIGHT").is_some() {
                let writer_sync = terminal.backend_mut().writer_mut().writer_sync();
                let sequence = writer_sync.queued();
                assert!(sequence > 0, "first room draw must submit a pager frame");
                assert!(
                    writer_sync.written() < sequence,
                    "abort trial requires an accepted frame to remain in flight"
                );
                panic!("ZER0_ROOM_TEST_ABORT_WITH_FRAME_IN_FLIGHT requested");
            }
        }
        // Two terms, and the room needs both. Reduced motion opts out of the
        // entrance AND the shine, so the timer never starts. A retired card has
        // nothing left to draw. There is deliberately no third term for "the
        // entrance has finished": the shine outlives the entrance, so the card
        // goes on owing frames until it is gone. Recomputed here rather than
        // latched, so either term can disarm the pump on the frame it flips.
        welcome_showing = !room.reduced_motion && room.welcome_card_visible();

        tokio::select! {
            _ = welcome_tick.tick(), if welcome_showing => {
                redraw = true;
            }
            _ = file_search_poll.tick() => {
                redraw |= room.prompt.poll_file_search();
                redraw |= room.prompt.history_search.poll();
                // The one clear that does not need anything to happen. A lane
                // wedged in `Cancelling` produces no event and no keypress, so
                // without this poll the row would go on offering a quit whose
                // window closed. Upstream sweeps its expired `pending_action`
                // on the same kind of tick
                // (`D:\grok-ref\...\app\app_view.rs:5467-5471`).
                redraw |= reconcile_quit_arm_at(&mut room, Instant::now());
                // The OTHER clear with nothing behind it, and the only one driven by the
                // wall clock: a painted health state whose reset instant has just
                // passed. See reconcile_health_reset_at for why the room changes shape
                // at that instant and why nothing else notices.
                redraw |= reconcile_health_reset_at(&mut room, wall_clock_ms());
                if lane_busy(&room.reducer, None) {
                    if !room.reduced_motion {
                        room.render_tick = room.render_tick.wrapping_add(1);
                    }
                    room.scrollback
                        .refresh_live_status(&room.reducer, room.render_tick);
                    redraw = true;
                }
            }
            update = updates.recv() => match update {
                Some(RoomUpdate::Event(event)) => {
                    apply_room_event_at(&mut room, &event, Instant::now(), wall_clock_ms())?;
                    redraw = true;
                }
                Some(RoomUpdate::Snapshot(snapshot)) => {
                    apply_room_snapshot_at(&mut room, snapshot, Instant::now());
                    redraw = true;
                }
                Some(RoomUpdate::SubmitSettled { submission, turn }) => {
                    apply_submit_settled(&mut room, submission, turn.as_deref());
                    redraw = true;
                }
                Some(RoomUpdate::PickerModels { request_id, result }) => {
                    room.picker.apply_models(request_id, result);
                    redraw = true;
                }
                Some(RoomUpdate::PickerSessions { request_id, result }) => {
                    room.picker.apply_sessions(request_id, result);
                    redraw = true;
                }
                Some(RoomUpdate::AgentReadiness(readiness)) => {
                    room.readiness = readiness;
                    redraw = true;
                }
                Some(RoomUpdate::Notice(message)) => {
                    room.scrollback.push_local_notice(message);
                    redraw = true;
                }
                Some(RoomUpdate::CancelReachedHost { seq }) => {
                    // The one thing that lets the guidance row stop hedging and
                    // say the agents were stopped. `answered` drops a stale or
                    // mismatched number rather than applying it.
                    room.cancel_claim = room.cancel_claim.answered(seq);
                    redraw = true;
                }
                Some(RoomUpdate::Failed(message)) => {
                    apply_runtime_failure(&mut room, &message);
                    draw_room(terminal, &mut cursor, &mut room);
                    break Err(anyhow::anyhow!(message));
                }
                Some(RoomUpdate::HostExited { clean, sentence }) => {
                    // Drawn before the break on BOTH paths: `run_room` restores
                    // the terminal on its way out, so a row pushed without a
                    // frame behind it is a row nobody ever sees.
                    if clean {
                        room.scrollback.push_local_notice(sentence);
                        draw_room(terminal, &mut cursor, &mut room);
                        break Ok(RoomRuntimeExit::Exit);
                    }
                    apply_host_exit(&mut room, &sentence);
                    draw_room(terminal, &mut cursor, &mut room);
                    break Err(anyhow::anyhow!(sentence));
                }
                None => break Err(anyhow::anyhow!("room host update stream closed")),
            },
            input = input_rx.recv() => match input {
                // Its own arm, ABOVE the keystroke arm, because letting go of a
                // key is not a keystroke: it must not settle the welcome
                // entrance and it paints nothing -- the press it belongs to
                // already did both. Routed rather than handled inline so the
                // room keeps ONE key router and the proofs can drive it.
                Some(RoomInput::Event(Event::Key(key))) if is_ctrl_c_release(&key) => {
                    route_room_key(&mut room, key, &commands, &cancels).await?;
                }
                Some(RoomInput::Event(Event::Key(key))) if accepts_key(&key) => {
                    room.skip_welcome_entrance();
                    // Above the routing, not inside one branch of it: an operator who
                    // starts typing has said they are done watching, and that is true of
                    // a permission answer or a scrollback key just as much as a
                    // character. Skipping is a SIDE EFFECT of the keystroke -- the key
                    // goes on to do exactly what it would have done, because eating
                    // someone's first character to deliver an animation is the worse bug.
                    if let KeyDisposition::Exit(outcome) =
                        route_room_key(&mut room, key, &commands, &cancels).await?
                    {
                        break Ok(outcome);
                    }
                    redraw = true;
                }
                Some(RoomInput::Event(Event::Resize(_, _)))
                | Some(RoomInput::Event(Event::FocusGained))
                | Some(RoomInput::Event(Event::FocusLost)) => redraw = true,
                Some(RoomInput::Event(Event::Mouse(mouse))) => {
                    // Rung order, and the reason it is an order rather than a
                    // set: 1 the wheel, 2 [reserved - no overlay owns capture
                    // today], 3 slice D's answer pill, 4 the feed's own
                    // click-to-fold, 5 the composer fall-through. Each arm
                    // answers only inside its own retained rect, so everything
                    // else still reaches the composer exactly as it did.
                    //
                    // The pill runs BEFORE the feed (spec §12.3): the pill is
                    // painted on the guidance row and the feed arm answers
                    // only inside `feed_rect`, so a click on the pill would
                    // otherwise hit-test against nothing and land in the
                    // composer.
                    match mouse.kind {
                        event::MouseEventKind::ScrollUp => room.scrollback.scroll_up(3),
                        event::MouseEventKind::ScrollDown => room.scrollback.scroll_down(3),
                        _ if room.handle_answer_pill_mouse(&mouse) => {}
                        _ if room.handle_feed_mouse_at(&mouse, std::time::Instant::now()) => {}
                        _ => {
                            room.prompt.handle_mouse(&mouse);
                            room.prompt.refresh_frontend_slash();
                        }
                    }
                    redraw = true;
                }
                Some(RoomInput::Event(_)) => {},
                Some(RoomInput::Failed(error)) => break Err(error).context("pager input reader failed"),
                None => break Err(anyhow::anyhow!("pager input reader stopped")),
            },
            writer = writer_events.recv() => match writer {
                Some(WriterEvent::Failed(error)) => break Err(error).context("pager writer failed"),
                Some(WriterEvent::Written(_)) => {},
                None => break Err(anyhow::anyhow!("pager writer stopped")),
            },
        }
    };

    // Closing wakes a reader blocked on the bounded input queue. Joining before
    // this close could deadlock when terminal output has applied backpressure to
    // the room loop and the input queue is full.
    input_rx.close();
    reader.stop();
    result
}

fn handle_scrollback_key(room: &mut RoomView, key: &KeyEvent) -> bool {
    match (key.code, key.modifiers) {
        (KeyCode::PageUp, _) => room.scrollback.scroll_up(12),
        (KeyCode::PageDown, _) => room.scrollback.scroll_down(12),
        // Slice D: jump to the unseen answer that reads first on screen.
        // Nothing is drained — the same frame's reconciliation drops it once
        // its first row is visible, so repeated presses walk forward.
        (KeyCode::Char('t'), modifiers) if modifiers.contains(KeyModifiers::CONTROL) => {
            room.jump_to_first_unseen_answer();
        }
        // Slice D: back to the bottom — but ONLY when taking the key steals
        // nothing. This function runs BEFORE the composer, so an unguarded
        // binding here would rob a person editing a draft of "cursor to end
        // of line".
        //
        // Two conditions, both necessary:
        //   1. an EMPTY draft, where the textarea's own `End` is a provable
        //      no-op (`set_cursor(end_of_current_line())` on empty text);
        //   2. history search INACTIVE, because browse mode can leave the
        //      composer empty while the history widget owns the keyboard.
        //
        // The composer menu needs no third condition: its snapshot requires an
        // `@` context in the draft, so an empty draft can never have it open.
        // Nor does the picker: an open picker routes straight to `handle_key`
        // and never reaches this function.
        //
        // ⚠ `PageUp`/`PageDown` two lines above have exactly this bug and are
        // NOT fixed here — that is FL-102, reported and out of this slice.
        (KeyCode::End, _)
            if room.prompt.text().is_empty() && !room.prompt.history_search.is_active() =>
        {
            room.scrollback.enable_follow_mode();
        }
        (KeyCode::Char('e'), modifiers) if modifiers.contains(KeyModifiers::CONTROL) => {
            room.scrollback.toggle_fold_selected()
        }
        (KeyCode::Char('r'), modifiers) if modifiers.contains(KeyModifiers::CONTROL) => {
            room.scrollback.toggle_raw_selected()
        }
        (KeyCode::Up, modifiers) if modifiers.contains(KeyModifiers::ALT) => {
            room.scrollback.select_prev()
        }
        (KeyCode::Down, modifiers) if modifiers.contains(KeyModifiers::ALT) => {
            room.scrollback.select_next()
        }
        _ => return false,
    }
    true
}

/// Which terminal key events the room takes at all.
///
/// Key-downs, plus **one** release: the `Ctrl+C` key's. Letting go of a key is
/// not a keystroke and the room has never wanted to hear about it — except for
/// this one, where it is the only event that distinguishes a held key from a
/// second deliberate tap, and the room's quit hangs on that distinction
/// (`room_ctrl_c_gesture`). Every other release is still dropped, so nothing
/// downstream has to learn what a release means.
fn accepts_key(key: &KeyEvent) -> bool {
    matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) || is_ctrl_c_release(key)
}

/// Who took a keystroke.
///
/// The room only needs `Exit` to run; the other three exist because **a key the
/// room swallows is otherwise unobservable**. A feed binding today has no
/// visible effect at all — fold and raw are no-ops on every block the room
/// currently builds — and a shelf that consumes a key produces no command and no
/// render change. Without the router saying who took it, the only way to test
/// the room's keymap is to re-implement the routing order in the test, and a
/// second copy of an order is a promise rather than a check.
#[derive(Debug)]
enum KeyDisposition {
    /// The room ended.
    Exit(RoomRuntimeExit),
    /// `route_permission_key` answered it — an action sent to the host, or
    /// consumed by the shelf.
    PermissionShelf,
    /// `handle_scrollback_key` answered it.
    Feed,
    /// The operator let go of `Ctrl+C`. Nothing was routed; the room only
    /// closed the gesture (`room_ctrl_c_gesture`).
    CtrlCRelease,
    /// It reached `handle_key`: the picker, history, the menus, the composer.
    Composer,
}

/// The room's one key route: who gets a keystroke, in what order.
///
/// Lifted out of the event loop unchanged so that the order itself is callable.
/// A test that asks `handle_scrollback_key` and `handle_key` directly is asking
/// two of the four participants and will report a key as free that the room
/// consumes — the permission shelf is ahead of both of them here, and it is
/// where `Ctrl+K` is eaten today (`route_permission_key`'s `Char('k')` arm
/// carries no modifier check).
///
/// The shared Shift+Tab predicate owns every Shift+Tab encoding before a
/// permission shelf, scrollback, completion menu, or composer can reinterpret
/// it; an open picker likewise goes straight to `handle_key`.
async fn route_room_key(
    room: &mut RoomView,
    key: KeyEvent,
    commands: &mpsc::Sender<RoomCommand>,
    cancels: &mpsc::Sender<RoomCancelAll>,
) -> anyhow::Result<KeyDisposition> {
    route_room_key_at(room, key, commands, cancels, Instant::now()).await
}

/// `route_room_key` with the clock supplied.
///
/// The quit arm is a deadline, so a test of it either injects the clock or
/// sleeps, and a sleeping test of a three-second window is a three-second test
/// that still cannot assert the boundary instant. Upstream reaches the same
/// seam through an environment variable that shortens its TTL
/// (`D:\grok-ref\...\app\app_view.rs:540-552`, `esc_double_press_ttl`); a
/// process global is a race between the tests in this binary, which run in
/// parallel in one process, so the clock is a parameter here instead.
async fn route_room_key_at(
    room: &mut RoomView,
    key: KeyEvent,
    commands: &mpsc::Sender<RoomCommand>,
    cancels: &mpsc::Sender<RoomCancelAll>,
    now: Instant,
) -> anyhow::Result<KeyDisposition> {
    // Above EVERYTHING, including the arm's clears. A release is not a
    // keystroke: it must not disarm the quit the matching press armed, must not
    // reach the composer, and must not settle the welcome entrance's animation
    // -- the press it belongs to already did all three. It has exactly one job.
    if is_ctrl_c_release(&key) {
        room.ctrl_c_gesture.ended();
        return Ok(KeyDisposition::CtrlCRelease);
    }
    // Recorded here rather than in the Ctrl+C owner, because the owner is not
    // the only place a Ctrl+C lands: an open picker quits on it and a history
    // search eats it, and a gesture the room failed to notice is a gesture
    // whose NEXT key-down looks like a fresh tap.
    if is_ctrl_c(&key) {
        room.ctrl_c_gesture.key_down(now);
    }
    // Above every owner, because none of the arm's three clears belongs to one
    // of them: the deadline and the lanes reaching idle are both `reconcile`,
    // and "any OTHER accepted keypress" means any -- including one the shelf or
    // the feed eats before `handle_key` is reached. Upstream clears its
    // `pending_action` in the same place, ahead of dispatch, for the same
    // reason (`D:\grok-ref\...\app\app_view.rs:2474-2493`).
    reconcile_quit_arm_at(room, now);
    if !is_ctrl_c(&key) {
        room.quit_armed_until = None;
        // Beside the disarm because it is the same fact about the operator's
        // hand: they pressed something else. Autorepeat repeats only the most
        // recently pressed key, so this key's arrival PROVES no Ctrl+C repeat
        // stream is running -- which is why the next Ctrl+C is a fresh gesture
        // and may act, however soon it comes.
        room.ctrl_c_gesture.ended();
    }
    let handed_to_composer = |outcome: Option<RoomRuntimeExit>| {
        outcome.map_or(KeyDisposition::Composer, KeyDisposition::Exit)
    };
    if crate::input::key::is_shift_tab(&key) || room.picker.is_open() {
        return Ok(handed_to_composer(
            handle_key_at(room, key, commands, cancels, now).await?,
        ));
    }
    match route_permission_key(room, &key) {
        PermissionKeyRoute::Action(action) => {
            commands
                .send(RoomCommand::PermissionResponse(action))
                .await
                .context("room host command bridge stopped")?;
            Ok(KeyDisposition::PermissionShelf)
        }
        PermissionKeyRoute::Consumed => Ok(KeyDisposition::PermissionShelf),
        PermissionKeyRoute::NotHandled if handle_scrollback_key(room, &key) => {
            Ok(KeyDisposition::Feed)
        }
        PermissionKeyRoute::NotHandled => Ok(handed_to_composer(
            handle_key_at(room, key, commands, cancels, now).await?,
        )),
    }
}

/// How long a `Ctrl+C` keeps meaning "press again to quit".
///
/// The ordinary double-tap window, and a deadline rather than a latch: the two
/// other ways out of the armed state both need something to happen, and a lane
/// wedged in `Cancelling` produces neither. Upstream's equivalent is 1000 ms
/// (`D:\grok-ref\...\app\app_view.rs:507`); three seconds here because this arm
/// is reached mid-panic, after the operator has already asked three agents to
/// stop, and a window they can miss turns the second press back into a cancel
/// while the row is still telling them it quits.
const QUIT_CONFIRM_WINDOW: Duration = Duration::from_secs(3);

fn is_ctrl_c(key: &KeyEvent) -> bool {
    key.code == KeyCode::Char('c')
        && key.modifiers.contains(KeyModifiers::CONTROL)
        && key.kind != KeyEventKind::Release
}

/// The operator letting go of the `Ctrl+C` chord.
///
/// **No CONTROL bit is required, and that is the whole point of a separate
/// predicate.** Which of the two keys the hand lifts first decides what the
/// terminal reports: lift Ctrl first and the `c` release carries no modifier at
/// all. Upstream hit exactly this and matches its own chord release on the key
/// alone for the same reason —
/// *"on Kitty the Ctrl release can precede Space and drop the CONTROL bit"*
/// (`D:\grok-ref\crates\codegen\xai-grok-pager\src\app\event_loop.rs:3773-3787`).
/// Demanding CONTROL here would silently never fire for half the ways a human
/// lets go, and the room would behave as though the key were held forever.
fn is_ctrl_c_release(key: &KeyEvent) -> bool {
    key.code == KeyCode::Char('c') && key.kind == KeyEventKind::Release
}

/// Bare `Esc` — no modifiers at all.
///
/// Upstream's cancellation policy makes the same narrowing and tests it
/// (`D:\grok-ref\...\app\agent_view\prompt.rs:797-802`): a modified Esc is a
/// terminal-specific encoding nobody presses on purpose, and a panic button
/// that fires on those fires on noise.
fn is_bare_esc(key: &KeyEvent) -> bool {
    key.code == KeyCode::Esc && key.modifiers.is_empty()
}

/// Whether a second `Ctrl+C` right now means "quit".
///
/// Two terms, and the second is upstream's shape rather than the deadline
/// alone. Upstream escalates `Ctrl+C` to a quit only while a cancel is still
/// pending (`D:\grok-ref\...\app\agent_view\input.rs:1339-1341`, predicate at
/// `agent_view/session.rs:705-708`) and separately invalidates an arm whose
/// meaning the state changed under (`app_view.rs:2477-2487`). Here those are
/// one predicate: once the lanes are idle the arm is stale, because the room
/// the operator armed — one with agents in it to stop — is gone.
fn quit_is_armed_at(room: &RoomView, now: Instant) -> bool {
    room.quit_armed_until.is_some_and(|deadline| now < deadline) && lane_busy(&room.reducer, None)
}

/// Drop an arm that is no longer live, reporting whether it cleared anything so
/// a caller that owns a frame can ask for a repaint.
///
/// ⚠ **Defined as the negation of `quit_is_armed_at`, and it must stay that
/// way.** The obvious spelling — `now >= deadline || !lane_busy(...)` — is a
/// second copy of the same rule, and the two copies MASK EACH OTHER'S BUGS:
/// this one runs first on the key route, so a wrong comparison here is hidden
/// by the right one there, and the other way round on the render path. That is
/// not a guess. Both mutations were run against the whole proof module and both
/// stayed GREEN (`D:\m0irai-evidence\wave1\slice-b\MUTATIONS.log`) — two
/// predicates meaning one thing, which is exactly the drift `lane_busy` exists
/// to prevent. With one comparison in the tree, `the_arm_expires` sees it.
///
/// The comparison lives in `quit_is_armed_at` as `now < deadline`, so the
/// deadline instant itself is already past — matching upstream's `expired()`,
/// which is `>=` (`D:\grok-ref\...\app\app_view.rs:530-532`).
fn reconcile_quit_arm_at(room: &mut RoomView, now: Instant) -> bool {
    let stale = room.quit_armed_until.is_some() && !quit_is_armed_at(room, now);
    if stale {
        room.quit_armed_until = None;
    }
    stale
}

/// One room-wide cancel.
///
/// `All`, never `Latest`: `latest` resolves exactly one turn
/// (`src/room/room-engine.ts:516-520`), so with two non-terminal turns in
/// flight it leaves the older lane running underneath the words "agents
/// stopped". The typed `/cancel latest` keeps its precise meaning; only the key
/// is a panic button.
///
/// **Sends on the dedicated cancel wire, and does not `await`.** Both halves are
/// the BLOCK 2 fix. The wire keeps the cancel out from behind a 130-second mode
/// RPC; `try_send` keeps this call from parking the key route inside a channel
/// that is full, which is where the caller's `now` — already read, and about to
/// become a deadline — goes stale.
///
/// A full channel is not an error. It means an earlier cancel is still queued
/// on a wire that carries nothing else, so the room has already asked and the
/// standing `Asked` claim is the true one; sending a second copy would only
/// deepen a queue in front of the host. A CLOSED channel is an error: there is
/// no bridge left, nothing was asked, and the caller must not arm a quit or
/// paint a claim on top of it.
fn request_cancel_all(
    room: &mut RoomView,
    cancels: &mpsc::Sender<RoomCancelAll>,
) -> anyhow::Result<()> {
    let asked = room.cancel_claim.ask();
    match cancels.try_send(RoomCancelAll { seq: asked.seq() }) {
        Ok(()) => {
            room.cancel_claim = asked;
            Ok(())
        }
        Err(mpsc::error::TrySendError::Full(_)) => Ok(()),
        Err(mpsc::error::TrySendError::Closed(_)) => {
            Err(anyhow::anyhow!("room host cancel bridge stopped"))
        }
    }
}

/// What the `Ctrl+C` ladder decided.
///
/// Three answers and not `Option<RoomRuntimeExit>`, because "the room ends",
/// "the key is spent" and "the composer gets it after all" are three different
/// things and the third one is the live affordance the ladder is most likely to
/// delete by accident.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CtrlCOutcome {
    Exit,
    Consumed,
    FallThrough,
}

/// The room's `Ctrl+C`, as an ordered arm. First match wins.
///
/// ```text
/// 1. the quit is armed and still live   -> Exit
/// 2. any lane Running | Cancelling      -> Cancel{scope: All} + arm
/// 3. the composer trims to empty        -> Exit                  (today's)
/// 4. otherwise                          -> the composer, which clears the
///                                          draft                 (today's)
/// ```
///
/// **Rung 1 is above rung 2 deliberately, and the instinct to order these by
/// novelty is what breaks it.** After the first press the lanes are
/// `Cancelling`, which is still busy, so a rung 2 that ran first would cancel
/// again on every press and the quit could never fire.
///
/// **Rung 2 ignores the draft, and that is the decision.** A panic button a
/// draft can disable is not a panic button. The cost, stated rather than
/// hidden: while agents are running, `Ctrl+C` no longer clears the composer.
/// The affordance is not gone — it returns the instant the lanes go idle (rung
/// 4), `Esc` cancels without touching the composer at all, and the editor's own
/// `Ctrl+U` clears a draft in every state
/// (`xai-ratatui-textarea/src/editor_keys.rs:102-105`). Rung 2 must not touch
/// `room.prompt`.
///
/// **Above rung 1: one gesture gets one action.** A held key produces a stream
/// of events and only the first of them may reach the ladder at all — not just
/// the confirmation. Guarding rung 1 alone leaves the second door open: the arm
/// clears the moment the lanes reach idle, so a cancellation that settles
/// mid-hold drops the SAME held key onto rung 3, which exits. That is the
/// operator's original bug arriving by a different route, and it is why the
/// suppression is written once, at the top, rather than per rung.
///
/// Two pre-existing handlers run before this one and are unchanged: an open
/// picker quits immediately and sends no cancel — a real hole in the panic
/// button, recorded as FL-103, not fixed here — and an active history search
/// closes and restores the saved text.
async fn route_ctrl_c_at(
    room: &mut RoomView,
    cancels: &mpsc::Sender<RoomCancelAll>,
    now: Instant,
) -> anyhow::Result<CtrlCOutcome> {
    if !room.ctrl_c_gesture.opened_the_gesture() {
        return Ok(CtrlCOutcome::Consumed);
    }
    if quit_is_armed_at(room, now) {
        room.quit_armed_until = None;
        return Ok(CtrlCOutcome::Exit);
    }
    if lane_busy(&room.reducer, None) {
        // The ask has to succeed before anything is armed or claimed: a closed
        // cancel wire returns the error and leaves the room unarmed, so no row
        // is painted on top of a cancel that reached nothing.
        //
        // ⚠ **The arm is set here, on the keypress, and NOT on the host's
        // answer — a deliberate deviation from the review's prescription.** The
        // arm is a statement about the next keystroke, not about the agents:
        // "press ctrl+c again and this room ends." Deferring it until the host
        // answers would put the room's only escape hatch behind the very party
        // that is failing to respond, which is exactly the situation an operator
        // reaches this ladder in. What the host's answer gates is the CLAIM, in
        // `guidance_row_at` — the words "agents stopped" — and that is the half
        // that was dishonest.
        //
        // `now` cannot be stale here: `request_cancel_all` does not await.
        request_cancel_all(room, cancels)?;
        room.quit_armed_until = Some(now + QUIT_CONFIRM_WINDOW);
        return Ok(CtrlCOutcome::Consumed);
    }
    if room.prompt.text().trim().is_empty() {
        return Ok(CtrlCOutcome::Exit);
    }
    Ok(CtrlCOutcome::FallThrough)
}

/// Whether work is in flight — for one agent when `agent` is `Some`, for the
/// whole room when it is `None`.
///
/// One definition with one optional filter, because two predicates that both
/// mean "busy" drift apart, and this room has both meanings: the redraw pump
/// asks about the room, and a footer chip asks about ITS agent. The filter is
/// the load-bearing half. Drop it from the chip's call and every chip lights up
/// whenever any one agent runs, which is the room claiming three agents are
/// working when one is.
fn lane_busy(reducer: &RoomReducer, agent: Option<&str>) -> bool {
    reducer.ordered_lanes().any(|lane| {
        agent.is_none_or(|agent| lane.agent == agent)
            && matches!(lane.phase, LanePhase::Running | LanePhase::Cancelling)
    })
}

async fn handle_key_at(
    room: &mut RoomView,
    key: KeyEvent,
    commands: &mpsc::Sender<RoomCommand>,
    cancels: &mpsc::Sender<RoomCancelAll>,
    now: Instant,
) -> anyhow::Result<Option<RoomRuntimeExit>> {
    // The welcome demo's only two controls. Gated on a feature that no shipping
    // build enables, so in the room these keys reach the composer exactly as
    // they always have: `r` types an r.
    #[cfg(feature = "welcome-demo")]
    {
        if matches!(key.code, KeyCode::Char('q') | KeyCode::Esc) {
            return Ok(Some(RoomRuntimeExit::Exit));
        }
        if key.code == KeyCode::Char('r') {
            room.restart_welcome();
            return Ok(None);
        }
    }
    // Check the shared Shift+Tab predicate before history, menus, slash completion, or the composer.
    // One accepted mode key must never become a literal tab or alter the draft/history surface.
    if crate::input::key::is_shift_tab(&key) {
        commands
            .send(RoomCommand::CycleMode {
                composer_text: room.prompt.text().to_owned(),
            })
            .await
            .context("room host command bridge stopped")?;
        return Ok(None);
    }
    if room.picker.is_open() {
        return handle_picker_key(room, key, commands).await;
    }
    if room.prompt.history_search.is_active() {
        // History owns this Ctrl+C — it closes the search and restores the
        // saved draft (`handle_history_key`, below). It therefore never reached
        // the confirmation owner, so it is "any other accepted keypress" and it
        // disarms, exactly as an `x` would.
        if is_ctrl_c(&key) {
            room.quit_armed_until = None;
        }
        handle_history_key(room, &key);
        return Ok(None);
    }

    if is_ctrl_c(&key) {
        match route_ctrl_c_at(room, cancels, now).await? {
            CtrlCOutcome::Exit => return Ok(Some(RoomRuntimeExit::Exit)),
            CtrlCOutcome::Consumed => return Ok(None),
            // Rung 4: idle, with a draft. Falls through to the composer, whose
            // own Ctrl+C arm clears it (`views/prompt_widget/mod.rs:1838-1846`).
            CtrlCOutcome::FallThrough => {}
        }
    }

    if key.code == KeyCode::Up
        && room.prompt.text().is_empty()
        && !room.history.is_empty()
        && room.prompt.history_search.is_available()
    {
        room.prompt
            .history_search
            .activate_browse(&room.history, "");
        populate_history_selection(room);
        room.prompt.refresh_frontend_slash();
        return Ok(None);
    }

    let menu_snapshot = {
        let draft = room.prompt.text().to_owned();
        let cursor = room.prompt.cursor();
        room.composer_menu.snapshot(&draft, cursor, &room.catalog)
    };
    if let Some(snapshot) = menu_snapshot {
        match key.code {
            KeyCode::Up => {
                room.composer_menu.move_selection(snapshot.rows.len(), -1);
                return Ok(None);
            }
            KeyCode::Down => {
                room.composer_menu.move_selection(snapshot.rows.len(), 1);
                return Ok(None);
            }
            KeyCode::Left if matches!(snapshot.kind, RoomMenuKind::Agent { .. }) => {
                room.composer_menu.switch_tab(-1);
                return Ok(None);
            }
            KeyCode::Right if matches!(snapshot.kind, RoomMenuKind::Agent { .. }) => {
                room.composer_menu.switch_tab(1);
                return Ok(None);
            }
            KeyCode::Tab | KeyCode::Enter => {
                if let Some((range, completion)) = snapshot.selected_completion() {
                    if room.prompt.apply_completion_fill(range, &completion) {
                        room.prompt.refresh_frontend_slash();
                        room.composer_menu.notify_draft_changed();
                        return Ok(None);
                    }
                }
            }
            KeyCode::Esc => {
                room.composer_menu
                    .dismiss(room.prompt.text(), room.prompt.cursor());
                room.prompt.slash_close();
                room.prompt.file_search.clear_context();
                return Ok(None);
            }
            // While the room route/catalog menu owns the composer, do not let
            // a simultaneously detected @file context consume hidden keys.
            KeyCode::Right | KeyCode::PageUp | KeyCode::PageDown | KeyCode::Home | KeyCode::End => {
                return Ok(None);
            }
            _ => {}
        }
    }

    if room.prompt.slash_open() {
        match key.code {
            KeyCode::Up => {
                room.prompt.slash_move_selection(-1);
                return Ok(None);
            }
            KeyCode::Down => {
                room.prompt.slash_move_selection(1);
                return Ok(None);
            }
            KeyCode::Tab | KeyCode::Enter if room.prompt.accept_slash_completion() => {
                return Ok(None);
            }
            KeyCode::Esc => {
                room.prompt.slash_close();
                return Ok(None);
            }
            _ => {}
        }
    }

    // Esc interrupts — after every consumer that already wants it, and gated on
    // the one that is DOWNSTREAM of this line.
    //
    // Five of the six return before reaching here: the permission shelf
    // (`route_permission_key`), the picker, history search, the composer menu
    // and the slash menu. The sixth is the file-search dropdown, which takes
    // Esc through `route_enter`'s pass-through arm into
    // `views/prompt_widget/mod.rs:2059` and returns `Dismissed` — so it is
    // BELOW this arm and needs an explicit gate, or the room steals the dismiss
    // key from an operator half-way through completing a path. Upstream states
    // the same ordering as policy: overlays, dropdowns and search steal Esc
    // before cancellation (`D:\grok-ref\...\app\agent_view\mod.rs:10-12`).
    //
    // No arm, unlike Ctrl+C: Esc is the affordance that stops the agents
    // without ending the room, and an Esc that could quit would be one.
    if is_bare_esc(&key) && !room.prompt.file_search.is_visible() && lane_busy(&room.reducer, None)
    {
        // The same dedicated wire as Ctrl+C's: Esc is the other spelling of the
        // same panic button, and a panic button that queues behind a mode RPC
        // is not one.
        request_cancel_all(room, cancels)?;
        return Ok(None);
    }

    match room.prompt.route_enter(&key) {
        EnterOutcome::Submit => {
            if let Some(text) = room.prompt.try_send() {
                // Captured before the clear, whatever the text turns out to
                // be — `views/prompt_widget/mod.rs:1007` says to pair `stash`
                // with `set_text("")`, and the clear was draining that state
                // anyway. Kept by the two arms that reach the host as a
                // SUBMIT and dropped by every other, which is not the same as
                // "kept unless it starts with a slash": `/council <topic>` is
                // a slash command that mints a turn (FL-126, round 3).
                let submitted_stash = room.prompt.stash();
                room.prompt.set_text("");
                room.prompt.refresh_frontend_slash();
                room.composer_menu.notify_draft_changed();
                match parse_room_command(&text, &room.catalog) {
                    // `/council <topic>` is a submit like any other: the host
                    // accepts exactly this one slash command as one
                    // (`src/room/room-host-support.ts`, `parseRoomInput`), so
                    // it mints a turn and a cancel of that turn owes the
                    // operator their topic back.
                    Some(ParsedRoomCommand::Submit) => {
                        send_submission(room, &text, submitted_stash, commands).await?;
                    }
                    Some(ParsedRoomCommand::Host(command)) => {
                        commands
                            .send(command)
                            .await
                            .context("room host command bridge stopped")?;
                    }
                    Some(ParsedRoomCommand::Models(agent)) => {
                        let request = room.picker.open_models(agent);
                        send_picker_request(commands, request).await?;
                    }
                    Some(ParsedRoomCommand::Skills(agent)) => {
                        room.picker.open_skills(agent, &room.catalog);
                    }
                    Some(ParsedRoomCommand::Sessions) => {
                        let request = room.picker.open_sessions();
                        send_picker_request(commands, request).await?;
                    }
                    Some(ParsedRoomCommand::NewSession) => {
                        return Ok(Some(RoomRuntimeExit::NewSession));
                    }
                    Some(ParsedRoomCommand::Exit) => {
                        return Ok(Some(RoomRuntimeExit::Exit));
                    }
                    Some(ParsedRoomCommand::History) => {
                        room.prompt.history_search.activate(&room.history, "");
                    }
                    Some(ParsedRoomCommand::Status) => {
                        room.scrollback.push_local_notice(room_status_summary(room));
                    }
                    Some(ParsedRoomCommand::DebateUnavailable) => {
                        room.scrollback.push_local_notice(
                            "Structured debate is not available in Alive Room yet; use /council for independent multi-agent answers.",
                        );
                    }
                    Some(ParsedRoomCommand::InvalidSlash) => {
                        room.scrollback.push_local_notice(
                            "Unknown or invalid room command. Type /help to see available commands.",
                        );
                    }
                    Some(ParsedRoomCommand::Help) => {
                        room.prompt.set_text("/");
                        room.prompt.set_cursor(1);
                        room.prompt.refresh_frontend_slash();
                    }
                    None => {
                        send_submission(room, &text, submitted_stash, commands).await?;
                    }
                }
            }
        }
        EnterOutcome::NewlineInserted => {
            room.prompt.refresh_frontend_slash();
            room.composer_menu.notify_draft_changed();
        }
        EnterOutcome::PassThrough => {
            room.prompt.handle_key(&key);
            room.prompt.refresh_frontend_slash();
            room.composer_menu.notify_draft_changed();
        }
    }
    Ok(None)
}

async fn handle_picker_key(
    room: &mut RoomView,
    key: KeyEvent,
    commands: &mpsc::Sender<RoomCommand>,
) -> anyhow::Result<Option<RoomRuntimeExit>> {
    if is_ctrl_c(&key) {
        // The gesture guard reaches here too. This is the picker's own exit,
        // and it is the room's LAST door: a held Ctrl+C whose first event
        // opened a picker (or landed anywhere else) must not walk out of the
        // room through it on the next autorepeat. The pre-existing hole in this
        // arm — it quits without cancelling anything — is FL-103 and is
        // untouched.
        if !room.ctrl_c_gesture.opened_the_gesture() {
            return Ok(None);
        }
        return Ok(Some(RoomRuntimeExit::Exit));
    }
    match key.code {
        KeyCode::Esc => {
            room.picker.close();
            commands
                .send(RoomCommand::CancelPicker)
                .await
                .context("room host picker bridge stopped")?;
        }
        KeyCode::Up => room.picker.move_selection(-1),
        KeyCode::Down => room.picker.move_selection(1),
        KeyCode::PageUp => room.picker.move_selection(-8),
        KeyCode::PageDown => room.picker.move_selection(8),
        KeyCode::Left => {
            if let Some(request) = room.picker.switch_agent(-1, &room.catalog) {
                send_picker_request(commands, request).await?;
            }
        }
        KeyCode::Right => {
            if let Some(request) = room.picker.switch_agent(1, &room.catalog) {
                send_picker_request(commands, request).await?;
            }
        }
        KeyCode::Char('r' | 'R') => {
            if let Some(request) = room.picker.retry(&room.catalog) {
                send_picker_request(commands, request).await?;
            }
        }
        KeyCode::Enter => match room.picker.selected_choice() {
            Some(RoomPickerChoice::Model { agent, model_id }) => {
                let request = room.picker.begin_model_select(agent, model_id);
                send_picker_request(commands, request).await?;
            }
            Some(RoomPickerChoice::Skill { agent, name }) => {
                let completion = format!("@{} use your {} skill: ", agent.name(), name);
                room.picker.close();
                commands
                    .send(RoomCommand::CancelPicker)
                    .await
                    .context("room host picker bridge stopped")?;
                room.prompt.set_text(&completion);
                room.prompt.set_cursor(completion.len());
                room.prompt.refresh_frontend_slash();
                room.composer_menu.notify_draft_changed();
            }
            Some(RoomPickerChoice::Session {
                session_id,
                current: false,
            }) => return Ok(Some(RoomRuntimeExit::LoadSession(session_id))),
            Some(RoomPickerChoice::Session { current: true, .. }) => {
                room.picker.close();
                commands
                    .send(RoomCommand::CancelPicker)
                    .await
                    .context("room host picker bridge stopped")?;
            }
            None => {}
        },
        _ => {}
    }
    Ok(None)
}

async fn send_picker_request(
    commands: &mpsc::Sender<RoomCommand>,
    request: RoomPickerRequest,
) -> anyhow::Result<()> {
    commands
        .send(RoomCommand::Picker(request))
        .await
        .context("room host picker bridge stopped")
}

fn populate_history_selection(room: &mut RoomView) {
    let Some(text) = room
        .prompt
        .history_search
        .selected_text()
        .map(str::to_owned)
    else {
        return;
    };
    room.prompt.set_text(&text);
    room.prompt.set_cursor(text.len());
    room.prompt.file_search.clear_context();
}

fn close_history_restoring_saved(room: &mut RoomView) {
    let saved = room.prompt.history_search.saved_text().to_owned();
    room.prompt.history_search.deactivate();
    room.prompt.set_text(&saved);
    room.prompt.refresh_frontend_slash();
}

fn handle_history_key(room: &mut RoomView, key: &KeyEvent) {
    let browse = room.prompt.history_search.is_browse();
    if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
        close_history_restoring_saved(room);
        return;
    }
    match key.code {
        KeyCode::Esc => return close_history_restoring_saved(room),
        KeyCode::Enter | KeyCode::Tab => {
            if let Some(text) = room
                .prompt
                .history_search
                .selected_text()
                .map(str::to_owned)
            {
                room.prompt.history_search.deactivate();
                room.prompt.set_text(&text);
                room.prompt.set_cursor(text.len());
                room.prompt.file_search.clear_context();
            } else {
                close_history_restoring_saved(room);
            }
            room.prompt.refresh_frontend_slash();
            return;
        }
        KeyCode::Up => {
            if room.prompt.history_search.move_up() && browse {
                populate_history_selection(room);
            }
            return;
        }
        KeyCode::Down => {
            if room.prompt.history_search.move_down() {
                if browse {
                    populate_history_selection(room);
                }
            } else {
                close_history_restoring_saved(room);
            }
            return;
        }
        KeyCode::PageUp => {
            room.prompt.history_search.page_move(-1, 8);
            if browse {
                populate_history_selection(room);
            }
            return;
        }
        KeyCode::PageDown => {
            room.prompt.history_search.page_move(1, 8);
            if browse {
                populate_history_selection(room);
            }
            return;
        }
        _ => {}
    }

    if browse {
        room.prompt.history_search.deactivate();
        room.prompt.handle_key(key);
        room.prompt.refresh_frontend_slash();
    } else {
        room.prompt.handle_key(key);
        let query = room.prompt.text().to_owned();
        room.prompt.history_search.update_query(&query);
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum PermissionKeyRoute {
    NotHandled,
    Consumed,
    Action(crate::room_permission_view::RoomPermissionAction),
}

fn route_permission_key(room: &mut RoomView, key: &KeyEvent) -> PermissionKeyRoute {
    if !room.permissions.is_active() {
        return PermissionKeyRoute::NotHandled;
    }
    if crate::input::key::is_shift_tab(key) {
        return PermissionKeyRoute::NotHandled;
    }
    if key.code == KeyCode::Esc {
        room.permissions.focus_composer();
        return PermissionKeyRoute::Consumed;
    }
    if matches!(key.code, KeyCode::Up | KeyCode::Down) && key.modifiers.contains(KeyModifiers::ALT)
    {
        room.permissions.focus_shelf();
    }
    let digit = permission_digit(key);
    if room.permissions.is_focused() {
        if let Some(digit) = digit {
            return room
                .permissions
                .select_visible_digit(digit)
                .map(PermissionKeyRoute::Action)
                .unwrap_or(PermissionKeyRoute::Consumed);
        }
    } else if room.prompt.text().is_empty() {
        if let Some(digit) = digit {
            if room.permissions.has_visible_digit(digit) {
                return room
                    .permissions
                    .select_visible_digit(digit)
                    .map(PermissionKeyRoute::Action)
                    .unwrap_or(PermissionKeyRoute::Consumed);
            }
        }
    }
    if room.permissions.is_focused()
        && matches!(
            key.code,
            KeyCode::Up
                | KeyCode::Down
                | KeyCode::Enter
                | KeyCode::Char(' ')
                | KeyCode::Char('j')
                | KeyCode::Char('k')
        )
    {
        return room
            .permissions
            .handle_key(key)
            .map(PermissionKeyRoute::Action)
            .unwrap_or(PermissionKeyRoute::Consumed);
    }
    if room.permissions.is_focused() {
        room.permissions.focus_composer();
    }
    PermissionKeyRoute::NotHandled
}

fn permission_digit(key: &KeyEvent) -> Option<u8> {
    if !key.modifiers.is_empty() {
        return None;
    }
    match key.code {
        KeyCode::Char(character @ '1'..='9') => Some((character as u8) - b'0'),
        _ => None,
    }
}

fn draw_room(terminal: &mut PagerTerminal, cursor: &mut CursorState, room: &mut RoomView) {
    let overlay_visible = room_overlay_visible(room);
    if room.overlay_visible_last_frame && !overlay_visible {
        // A dismissed overlay leaves pixels that the underlying blank feed
        // cells must actively overwrite. Ordinary back-buffer reset is wrong
        // here because blank-to-blank cells disappear from the terminal diff.
        terminal.invalidate_back_buffer();
    }
    room.overlay_visible_last_frame = overlay_visible;
    draw_frame(terminal, cursor, |frame, _links| {
        let output = render_room(frame.area(), frame.buffer_mut(), room);
        (output.cursor_pos, output.post_flush_escapes.map(Into::into))
    });
}

fn room_overlay_visible(room: &mut RoomView) -> bool {
    if room.picker.is_open() {
        return true;
    }
    let draft = room.prompt.text().to_owned();
    let cursor = room.prompt.cursor();
    room.composer_menu
        .snapshot(&draft, cursor, &room.catalog)
        .is_some()
        || room.prompt.slash_open()
        || room.prompt.file_search.is_visible()
}

fn apply_runtime_failure(room: &mut RoomView, message: &str) {
    room.scrollback.push_runtime_failure(message);
}

/// The host's death, on the room's own feed.
///
/// Separate from [`apply_runtime_failure`] for the same reason the update
/// variant is separate: this sentence is one line the launcher wrote for the
/// operator, and the salvage-and-squeeze that a host's multi-line stderr needs
/// would cut the middle out of it — the middle being WHY the process ended.
fn apply_host_exit(room: &mut RoomView, sentence: &str) {
    room.scrollback.push_host_exit(sentence);
}

/// Shared production/test composition seam for the room's one chronological
/// feed, permission shelf, composer, and stable footer.
fn render_room(area: Rect, buffer: &mut Buffer, room: &mut RoomView) -> PromptRenderResult {
    let theme = RoomTheme::current();
    Clear.render(area, buffer);
    buffer.set_style(area, Style::default().fg(theme.text).bg(theme.canvas));

    let outer_pad = if area.width >= 120 { 2 } else { 1 };
    let content = Layout::horizontal([
        Constraint::Length(outer_pad),
        Constraint::Min(1),
        Constraint::Length(outer_pad),
    ])
    .split(area)[1];
    // Built BEFORE the layout so its height is measured rather than assumed. The footer is two rows
    // while every agent is healthy and three while one is not (footer_state_row), and a hard-coded 2
    // here would clip the state row off the bottom of the screen on exactly the frame that needs it.
    let footer = room_footer(room, content.width);
    let sections = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(1),
        Constraint::Length(room.permissions.height(content.height, content.width)),
        Constraint::Length(room.prompt.desired_height(
            content.width,
            &room_prompt_style(),
            true,
            6,
        )),
        Constraint::Length(1),
        Constraint::Length(footer.len() as u16),
    ])
    .split(content);

    Paragraph::new("m0irai · the room")
        .alignment(Alignment::Right)
        .style(Style::default().fg(theme.faint).bg(theme.canvas))
        .render(sections[0], buffer);
    // The card shares the feed's real estate, but it can only ever cover a feed
    // that paints nothing — `welcome_card_visible` is false the moment the
    // scrollback holds a row, and latched false forever after. The feed still
    // renders first so its own layout pass is unconditional; the card is an
    // overlay on an empty one, not a replacement for it.
    // Retained, not dropped: the mouse arm needs this frame's hit-test model to
    // tell a click on selectable text from a click on an accent bar. The write
    // is unconditional, which is also the per-frame clear.
    let scrollback_selection_model = room.scrollback.render(sections[1], buffer);
    room.last_scrollback_selection_model = scrollback_selection_model;
    // THE one reconciliation point for the unseen-answer pill (spec §D.6).
    // Here and nowhere else, because the call above is what runs
    // `prepare_layout`: the layout cache is valid for this frame's width and
    // was built against `sections[1]`, which is the rect asked about. This
    // also fixes the ordering finding 3 required — fold, relocate, lay out,
    // reconcile membership, then paint the guidance row — without a new
    // pipeline, since that is the order this function already runs in.
    reconcile_unseen_answers(room, sections[1]);
    if room.welcome_card_visible() {
        let reduced_motion = room.reduced_motion;
        // Read before the mutable borrow the clock needs, and cloned rather
        // than borrowed: the card is handed the version the binary reports, not
        // a number this crate could invent.
        let version = room.version.clone();
        let secs = room.welcome_elapsed_secs();
        let card =
            crate::room_welcome::render_card(sections[1], buffer, &version, secs, reduced_motion);
        render_boot_remedies(sections[1], card, buffer, &room.readiness);
    }
    room.permissions
        .render(sections[2], buffer, room.render_tick, room.reduced_motion);

    let menu_snapshot = {
        let draft = room.prompt.text().to_owned();
        let cursor = room.prompt.cursor();
        room.composer_menu.snapshot(&draft, cursor, &room.catalog)
    };
    let slash_snapshot = room.prompt.slash_snapshot();
    let overlay = room
        .picker
        .overlay()
        .or_else(|| overlay_for(menu_snapshot, &slash_snapshot, &room.prompt.file_search));
    if let Some(overlay) = overlay {
        render_overlay(buffer, sections[1], &overlay, theme);
    }

    let info = PromptInfo {
        model_name: "",
        flags: &[],
        multiline: false,
        usage_warning: None,
        usage_warning_critical: false,
    };
    let prompt = room.prompt.draw(
        buffer,
        sections[3],
        None,
        &room_prompt_style(),
        Some(&info),
        None,
    );
    let guidance = guidance_row(room, sections[4].width);
    // Unconditional, which is also the per-frame clear: a rect from an older
    // frame would arm a click on a pill that is no longer painted.
    room.answer_pill_rect = guidance.pill_width.map(|width| Rect {
        x: sections[4].x,
        y: sections[4].y,
        width,
        height: 1,
    });
    Paragraph::new(guidance.line)
        .style(Style::default().fg(theme.faint).bg(theme.canvas))
        .render(sections[4], buffer);
    Paragraph::new(footer)
        .style(Style::default().bg(theme.canvas))
        .render(sections[5], buffer);
    // Retained at the end of the pass, out of the same layout the widgets were
    // handed: a click can only be resolved against what was actually painted,
    // and until now both rects were computed here and dropped on the floor.
    room.feed_rect = sections[1];
    room.guidance_rect = sections[4];
    prompt
}

/// The one row below the composer, and its one owner.
///
/// Three separate pieces of work want to speak here — an interrupt hint, a
/// notice that the agents were stopped, a pill saying an answer landed above —
/// and the failure mode is not that the wrong one wins. It is that each arrives
/// as its own `Paragraph::render` onto the same rect, the last one painted
/// wins by accident, and no reader can tell which that is. So the precedence is
/// decided once, here, and everything that wants the row states its case as a
/// rung of this ladder:
///
/// 1. the quit-armed notice — `stopping agents…` until the host answers the
///    cancel, `agents stopped` after it does; both offer `press ctrl+c again to
///    quit`
/// 2. `esc to interrupt`, while any lane is running
/// 3. the answered-above pill, drawn from `room.unseen_answers`
/// 4. the first-run guidance below
///
/// **Four rungs. There is no rung 5.** An earlier draft of this comment listed
/// an unavailable agent's remedy line as one; that line went to the boot card
/// and `/status` instead, because a remedy is per-agent — up to three of them,
/// each with a state and an exact command — and this row is one line of
/// `width − 2·outer_pad` columns. Three remedies cannot render here honestly,
/// and picking one of the three is worse than none.
///
/// All four rungs land here. Rung 3 reads `room.unseen_answers`, which
/// `render_room` reconciled against real geometry earlier in this same frame.
///
/// Rungs 2 and 4 look like they compete and never do: rung 4 needs an empty
/// transcript, and a lane cannot be running in a room where nobody has spoken.
/// Rungs 2 and 3 genuinely can, and rung 2 wins deliberately: while an agent
/// is working, the operator's more urgent affordance is stopping it.
///
/// `width` is the row's own width THIS frame, passed rather than read off
/// `room.guidance_rect`, which is written at the end of the render pass and
/// would therefore be one frame stale on the first paint after a resize —
/// exactly the frame where the narrow ladder matters.
fn guidance_row(room: &RoomView, width: u16) -> GuidanceRow {
    guidance_row_at(room, Instant::now(), width)
}

/// What the guidance row painted, and how much of it was the clickable pill.
///
/// One value rather than two calls, so the rect can only ever describe the
/// row that was actually painted. Deriving the rect from a second, independent
/// "is there a pill" test is how a click target outlives the thing it points
/// at — the ladder decides once, here.
struct GuidanceRow {
    line: Line<'static>,
    /// Columns of the pill, when rung 3 won. `None` on every other rung,
    /// including a rung-3 room whose width cannot honestly render any form.
    pill_width: Option<u16>,
}

impl GuidanceRow {
    /// A rung that is not the pill.
    fn plain(text: &'static str) -> Self {
        Self {
            line: Line::from(Span::raw(text)),
            pill_width: None,
        }
    }
}

/// `guidance_row` with the clock supplied — see `route_room_key_at`.
///
/// The row reads the arm through the same `quit_is_armed_at` the key ladder
/// does, rather than through the raw field. That is what makes the notice
/// un-paint itself when the window closes or the lanes settle without anyone
/// having to remember to clear anything: the render is derived from the state
/// and the clock, never from a latch someone set.
/// Rung 1 once the host has answered the cancel.
const HINT_AGENTS_STOPPED: &str = "agents stopped — press ctrl+c again to quit";
/// Rung 1 while the cancel is still an ask.
const HINT_STOPPING_AGENTS: &str = "stopping agents — press ctrl+c again to quit";

fn guidance_row_at(room: &RoomView, now: Instant, width: u16) -> GuidanceRow {
    // Rung 1 — the quit is armed. Above rung 2 because the lanes are
    // `Cancelling` at this point, so rung 2 is still true and would hide it.
    //
    // ⚠ **Two spellings, and the difference is the honesty fix.** This row used
    // to say `agents stopped` the instant a local `mpsc::Sender::send` returned
    // `Ok` — an enqueue, which is the room talking to itself. With an unrelated
    // host RPC in flight the bridge had not even dequeued it, and the agents
    // went on working underneath the words. The claim is now derived from the
    // one observable that means anyone was told: the host answering the cancel
    // (`RoomUpdate::CancelReachedHost`). Before that it says what is true — the
    // room is stopping them. The offer of the quit is unconditional either way,
    // because that half is about the next keystroke and the room owns it.
    if quit_is_armed_at(room, now) {
        return GuidanceRow::plain(if room.cancel_claim.host_answered() {
            HINT_AGENTS_STOPPED
        } else {
            HINT_STOPPING_AGENTS
        });
    }
    // Rung 2 — something is in flight and Esc will stop it.
    if lane_busy(&room.reducer, None) {
        return GuidanceRow::plain("esc to interrupt");
    }
    // Rung 3 — an answer landed above where the operator is looking, and they
    // have not read it. ONE pill for the whole unseen set, never one per
    // answer (§0.7 R4): the text is a count of distinct AGENTS.
    //
    // The pill's own text is `theme.text`, not the row's `theme.faint` — it
    // is the one thing on this row the operator is meant to notice, and faint
    // would bury it. The suffix stays faint, because it is instruction rather
    // than news.
    if let Some(text) = answer_pill_text(&room.unseen_answers, width) {
        let pill_width = u16::try_from(UnicodeWidthStr::width(text.as_str())).unwrap_or(u16::MAX);
        let theme = RoomTheme::current();
        let line = match text.split_once(room_answer_pill::PILL_SUFFIX) {
            Some((head, "")) => Line::from(vec![
                Span::styled(head.to_owned(), Style::default().fg(theme.text)),
                Span::styled(
                    room_answer_pill::PILL_SUFFIX,
                    Style::default().fg(theme.faint),
                ),
            ]),
            _ => Line::from(Span::styled(text, Style::default().fg(theme.text))),
        };
        return GuidanceRow {
            line,
            pill_width: Some(pill_width),
        };
    }
    // Rung 4 — the first-run guidance. It is the composer's supporting chrome,
    // not a placeholder, so it stays out of the edit surface and goes quiet the
    // moment the operator types a character or the room has any history.
    if room.reducer.transcript().next().is_none() && room.prompt.text().trim().is_empty() {
        return GuidanceRow::plain(
            "type to start · @claude, @codex, @gemini to route · everyone answers by default",
        );
    }
    GuidanceRow::plain("")
}

fn room_prompt_style() -> PromptStyle {
    let theme = RoomTheme::current();
    PromptStyle {
        bg: PromptBg::Canvas(theme.terminal),
        accent_color_override: Some(RoomIdentity::You.color()),
        border_color_override: Some(theme.border),
        prefix_override: Some((RoomIdentity::You.glyph(), RoomIdentity::You.color())),
        placeholder_override: Some(""),
        placeholder_when_focused: false,
        show_accent_line: false,
        show_borders: true,
        ..PromptStyle::default()
    }
}

/// Wall-clock epoch ms, saturating rather than panicking on a clock the platform cannot represent.
/// Every health and meter rule in this file is a function of an absolute instant, and each is split
/// into an `*_at` seam that takes one so it can be asserted without the wall clock; this is the one
/// place production reads it. Extracted when the idle poll became a third caller - three copies of a
/// saturating conversion is how one of them quietly stops saturating.
fn wall_clock_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn room_footer(room: &RoomView, width: u16) -> Vec<Line<'static>> {
    let now_ms = wall_clock_ms();
    room_footer_at(room, width, now_ms)
}

fn room_footer_at(room: &RoomView, width: u16, now_ms: u64) -> Vec<Line<'static>> {
    let theme = RoomTheme::current();
    let agents = [
        ("claude", RoomIdentity::Claude),
        ("codex", RoomIdentity::Codex),
        ("gemini", RoomIdentity::Gemini),
    ];
    // Spend desktop width on truthful quota detail: each agent keeps its mode while rich cells can
    // show the segmented five-hour gauge and weekly window. The cap still prevents an ultrawide
    // terminal from stretching the roster into three disconnected islands.
    let logical_width = width.min(180);
    let mut identity_spans = Vec::new();
    let base = logical_width / 3;
    let remainder = logical_width % 3;
    for (index, (agent, identity)) in agents.into_iter().enumerate() {
        let cell_width = base + u16::from((index as u16) < remainder);
        let mut cell = footer_agent_cell(room, agent, identity, cell_width, now_ms);
        identity_spans.append(&mut cell.spans);
        identity_spans.push(Span::raw(
            " ".repeat(cell_width.saturating_sub(cell.width) as usize),
        ));
    }
    identity_spans.push(Span::raw(
        " ".repeat(width.saturating_sub(logical_width) as usize),
    ));
    let identities = Line::from(identity_spans);
    let state_row = footer_state_row(room, &agents, logical_width, width, now_ms);
    let session = room
        .reducer
        .session_id()
        .map(|id| id.rsplit('-').next().unwrap_or(id))
        .unwrap_or("room");
    let cwd = std::env::current_dir()
        .ok()
        .map(|path| path.display().to_string())
        .unwrap_or_default();
    let mut metadata_text = format!("m0irai · #{session}");
    if width >= 120 && !cwd.is_empty() {
        metadata_text.push_str(" · ");
        metadata_text.push_str(&truncate_width(&cwd, width.saturating_sub(48) as usize));
    }
    if let Some(mode) = footer_mode_metadata(room) {
        metadata_text.push_str(" · ");
        metadata_text.push_str(mode);
    }
    let metadata = Line::from(Span::styled(
        truncate_width(&metadata_text, width as usize),
        Style::default().fg(theme.faint),
    ));
    match state_row {
        Some(row) => vec![identities, row, metadata],
        None => vec![identities, metadata],
    }
}

/// The footer's THIRD row, and it exists ONLY while somebody needs it.
///
/// OPERATOR RULING, 2026-08-22: the word goes "under it". A chip is one row, so a word underneath
/// needs a row of its own — and a row that is always there is permanent furniture for an empty state,
/// which is exactly the info glut the minimum-at-the-right-time rule forbids. So the footer is two
/// rows while every agent is healthy and three while any one of them is not, and it shrinks back on
/// its own the moment the last reset passes.
///
/// ALIGNED UNDER ITS OWN CHIP, using the same cell arithmetic the roster row uses, because "which
/// agent" is the entire question the word exists to answer — a state row that did not line up would
/// make the operator count columns. Each cell is padded to its full width so the columns cannot drift
/// when one word is shorter than another.
fn footer_state_row(
    room: &RoomView,
    agents: &[(&str, RoomIdentity)],
    logical_width: u16,
    width: u16,
    now_ms: u64,
) -> Option<Line<'static>> {
    let theme = RoomTheme::current();
    let base = logical_width / 3;
    let remainder = logical_width % 3;
    let mut spans = Vec::new();
    let mut anyone_unusable = false;
    for (index, (agent, _identity)) in agents.iter().enumerate() {
        let cell_width = base + u16::from((index as u16) < remainder);
        // The second `agent_status` lookup this used to do went with the reset clause: the phrase is
        // a function of the health word and the budget now, and `agent_footer_health` already
        // returned None for an agent with no status at all.
        let phrase = agent_footer_health(room, agent, now_ms)
            .map(|health| health_phrase(health, cell_width))
            .unwrap_or_default();
        anyone_unusable = anyone_unusable || !phrase.is_empty();
        let phrase = truncate_width(&phrase, cell_width as usize);
        let used = UnicodeWidthStr::width(phrase.as_str()) as u16;
        spans.push(Span::styled(phrase, Style::default().fg(theme.dead)));
        spans.push(Span::raw(
            " ".repeat(cell_width.saturating_sub(used) as usize),
        ));
    }
    spans.push(Span::raw(
        " ".repeat(width.saturating_sub(logical_width) as usize),
    ));
    anyone_unusable.then(|| Line::from(spans))
}

struct FooterCell {
    spans: Vec<Span<'static>>,
    width: u16,
}

fn footer_mode_metadata(room: &RoomView) -> Option<&'static str> {
    let modes = ["claude", "codex", "gemini"]
        .into_iter()
        .filter_map(|agent| room.reducer.agent_mode(agent))
        .collect::<Vec<_>>();
    if modes.is_empty() {
        return None;
    }
    if modes.len() != 3 || modes.iter().any(|mode| mode.word.is_none()) {
        // A global mode label is a statement about the whole council. Missing
        // agents or provider words remain unknown and stay visually absent.
        return None;
    }
    let first = modes.first()?.word.as_deref()?;
    if modes.iter().all(|mode| mode.word.as_deref() == Some(first)) {
        // The protocol limits words to the shared room vocabulary, so these are the only durable
        // metadata labels the pager may claim.
        return match first {
            "plan" => Some("plan mode"),
            "careful" => Some("careful mode"),
            "edits" => Some("edits mode"),
            "auto" => Some("auto mode"),
            "strict" => Some("strict mode"),
            "smart" => Some("smart mode"),
            _ => Some("mixed modes"),
        };
    }
    Some("mixed modes")
}

fn room_status_summary(room: &RoomView) -> String {
    let now_ms = wall_clock_ms();
    room_status_summary_at(room, now_ms)
}

/// `/status` at a fixed instant. Split out for the same reason room_footer_at is: every meter rule is
/// a function of `now_ms`, and a surface that can only be asserted against the wall clock cannot be
/// asserted against a reset boundary at all.
fn room_status_summary_at(room: &RoomView, now_ms: u64) -> String {
    [
        ("claude", RoomIdentity::Claude),
        ("codex", RoomIdentity::Codex),
        ("gemini", RoomIdentity::Gemini),
    ]
    .into_iter()
    .map(|(agent, identity)| {
        let chip = footer_agent_cell(room, agent, identity, 72, now_ms)
            .spans
            .into_iter()
            .map(|span| span.content.into_owned())
            .collect::<String>()
            .trim()
            .to_owned();
        // `/status` is ONE line per agent with nothing underneath it, so the word that moved to the
        // footer's state row is appended INLINE here. Without this the durable diagnostic surface
        // would be the only place in the room that cannot say why an agent is red. The CLASSIFIER is
        // shared (`footer_health`) and so is the word (`health_phrase`) — only the placement differs,
        // which is what stops the two surfaces drifting. STATUS_PHRASE_WIDTH is wide enough that the
        // word never has to be dropped, because this surface has no cell to fit it into. The
        // separator is explicit — without one the word ran straight into the meters and read as a
        // single run (`wk 100% out of usage`).
        match agent_footer_health(room, agent, now_ms)
            .map(|health| health_phrase(health, STATUS_PHRASE_WIDTH))
        {
            Some(phrase) => format!("{chip} — {phrase}"),
            None => chip,
        }
    })
    .collect::<Vec<_>>()
    .join("  ·  ")
}

fn footer_agent_cell(
    room: &RoomView,
    agent: &str,
    identity: RoomIdentity,
    cell_width: u16,
    now_ms: u64,
) -> FooterCell {
    let theme = RoomTheme::current();
    let status = room.reducer.agent_status(agent);
    let mode = room.reducer.agent_mode(agent);
    let pending = room.permissions.has_pending_for(agent);
    let health = agent_footer_health(room, agent, now_ms);
    let working = lane_busy(&room.reducer, Some(agent));
    let readiness = agent_readiness(room, agent);
    // ONE LADDER, and the ranking is the design rather than the order things were written in.
    //
    //   1 pending permission   -> attention          the room is asking the operator something
    //   2 unusable, LIVE wire  -> RED                a real failed attempt outranks a boot sample
    //   3 readiness not usable -> faint              [slice A]
    //   4 THIS agent's lane running -> full brand    active luminance
    //   5 otherwise            -> rest colour        idle luminance
    //
    // Row 3 sits ABOVE row 4 so an agent that cannot work can never reach active luminance: the §14 Q8
    // ruling DISPATCHES a needs_login agent through `@all`, so it really does hold a Running lane for
    // the seconds before it fails, and the old ladder would have lit it at full brand — the room
    // asserting an agent is working when it is not signed in.
    //
    // And BELOW row 2, because a live agent.status outranks a stale boot sample. The next reader's
    // instinct will be to put readiness last because it is the newest; that would let a chip go bright
    // while its own suffix says "sign in".
    let identity_color = if pending {
        theme.attention_at(room.render_tick, room.reduced_motion)
    } else if health.is_some() {
        // OPERATOR RULING: RED, not faint. This row used to dim an unusable agent, and dim reads as
        // "idle" — the room whispering about the one agent that cannot work. The word for WHICH of
        // the three it is lives on the footer's state row directly underneath (footer_state_row).
        theme.dead
    } else if readiness_suffix(readiness, status).is_some() {
        theme.faint
    } else if working {
        identity.color()
    } else {
        identity.rest_color()
    };
    let mark = identity.mark();
    let mut spans = vec![Span::styled(
        mark.clone(),
        Style::default().fg(identity_color),
    )];
    let mut width = UnicodeWidthStr::width(mark.as_str()) as u16;
    // The chip's own word — for the two states that STILL DISPATCH only. An unusable agent gets None
    // here on purpose: its word moved to the state row, and printing it in both places is the info
    // glut the row was added to avoid. `None` also matters for what comes next — see the ladder below.
    let health_suffix = if health.is_some() {
        None
    } else if status.is_some_and(|status| status_is_limited(status, now_ms)) {
        Some((" limited".to_owned(), theme.warning))
    } else if status.is_some_and(|status| {
        active_availability(status, now_ms) == Some(AgentAvailabilityState::Retrying)
    }) {
        Some((" retrying".to_owned(), theme.warning))
    } else {
        None
    };
    // Mode is the primary roster state. Health and usage may enrich it, but
    // must never replace a provider-confirmed mode word.
    if let Some(suffix) = mode_suffix(mode) {
        append_footer_suffix(&mut spans, &mut width, cell_width, suffix);
    }
    // AN UNUSABLE AGENT FALLS THROUGH TO ITS METERS, and that is the operator's ruling too: `wk 100%`
    // is the EVIDENCE for `out of usage`, and answering "what" while deleting the "why" is the trade
    // the old ladder made silently — a health word replaced the meters outright. `health` being None
    // in `health_suffix` above is what routes it here; a readiness word is likewise suppressed,
    // because a red chip with `sign in` beside it contradicts the row underneath it.
    let chip_word = match health {
        Some(_) => None,
        None => health_suffix.or_else(|| readiness_suffix(readiness, status)),
    };
    if let Some(word) = chip_word {
        append_footer_suffix(&mut spans, &mut width, cell_width, word);
    } else if let Some(usage) = status.and_then(|status| status.usage.as_ref())
        && let Some(parts) = usage_suffix(usage, cell_width.saturating_sub(width), now_ms)
    {
        append_footer_suffix_parts(&mut spans, &mut width, cell_width, parts);
    }
    FooterCell { spans, width }
}

/// The boot card's remedy lines: one per agent that cannot work, with its exact command.
///
/// ⚠ PLACEMENT IS §14 Q2 AND IT IS UNRULED. This builds option (a) — BELOW the card's border, in the
/// same band, under the box. The card's 45×18 hero geometry and its minimum-window pin are untouched,
/// so no size pin moves and Seam 5 closes with a measurement rather than a renegotiation. Option (b),
/// inside the border under the meta row, reads as one object and costs the card up to three extra rows
/// against a pinned size — a deliberate pin change, not a render-site swap.
///
/// WHY HERE AND NOT THE GUIDANCE ROW. The remedy is not a one-line message: it is per-agent, up to
/// three agents each with a state and an exact command, and `sections[4]` is ONE row whose width is 18
/// columns at W20. Three remedies cannot render there honestly, and one of three chosen arbitrarily is
/// worse than none.
///
/// AND ONLY WHILE THE CARD IS VISIBLE. The card disappears the moment the operator types, so this can
/// never accumulate into permanent furniture — `/status` is the durable surface after it retires.
fn render_boot_remedies(
    area: Rect,
    card: Option<Rect>,
    buffer: &mut Buffer,
    readiness: &RoomReadinessSnapshot,
) {
    let lines = boot_remedy_lines(readiness);
    if lines.is_empty() || area.height == 0 {
        return;
    }
    // BELOW the card, which means BELOW ITS BORDER — asked of the card rather than recomputed. The
    // first version anchored to the bottom of the BAND, and because the card is CENTRED in that band
    // the remedy lines painted straight over its closing border. A rendered frame caught that;
    // reading the code did not.
    let bottom = area.y.saturating_add(area.height);
    let top = card.map_or(area.y, |box_area| {
        box_area.y.saturating_add(box_area.height)
    });
    // WHICH LINE LOSES WHEN THE BAND IS SHORT, decided rather than discovered. The per-agent remedies
    // come first and the reassurance line last, so the band gives up the sentence BEFORE it gives up
    // any command the operator can actually run.
    //
    // ⚠ THE ORDER IS THE PROMISE, NOT THE OUTCOME, and the earlier wording here overstated it. A tight
    // enough terminal drops commands too — it just drops them after the sentence and from the bottom
    // up. Measured 2026-09-02 with all three agents unready, width 100: the sentence is gone while all
    // three commands survive at heights 26..=31 on a capable console and 20..=21 on a legacy one (its
    // card is shorter, having no braille mark), and at height 26 modern the sentence AND `codex login`
    // are both gone. That is accepted: a shorter list of runnable commands beats none, and the ordering
    // is what `the_remedy_lines_sit_under_the_card_and_never_through_it` pins across the whole range —
    // if the sentence is on screen then every command is.
    let height = (lines.len() as u16).min(bottom.saturating_sub(top));
    if height == 0 {
        // No room under the card. Silence beats a line drawn through the box.
        return;
    }
    let theme = RoomTheme::current();
    let band = Rect::new(area.x, top, area.width, height);
    let rendered = lines
        .into_iter()
        .map(|line| {
            Line::from(Span::styled(
                truncate_width(&line, area.width as usize),
                Style::default().fg(theme.faint),
            ))
        })
        .collect::<Vec<_>>();
    Paragraph::new(rendered)
        .alignment(Alignment::Center)
        .style(Style::default().bg(theme.canvas))
        .render(band, buffer);
}

/// One line per agent that cannot work, plus the line that is always true when none can.
///
/// ⚠ CONTENT IS §14 Q3 AND IT IS UNRULED. This builds option (a) — ALL THREE ways in, easiest first —
/// on the grounds that an operator with a Codex subscription and no Claude one must not be told to buy
/// the wrong thing. Option (b), the single easiest path only, silently assumes which subscription the
/// reader has.
///
/// ABSENT RENDERS ABSENT still governs: an agent that is READY or UNKNOWN is not named here at all. A
/// room whose probe has not landed shows nothing, which is the same screen it showed before any probe
/// existed.
fn boot_remedy_lines(readiness: &RoomReadinessSnapshot) -> Vec<String> {
    let mut lines = Vec::new();
    for (agent, state) in [
        ("claude", &readiness.claude),
        ("codex", &readiness.codex),
        ("gemini", &readiness.gemini),
    ] {
        match state {
            RoomAgentReadiness::NeedsLogin { command } => {
                lines.push(format!("{agent} needs a sign-in — run: {command}"));
            }
            RoomAgentReadiness::Unusable { reason, remedy } => {
                lines.push(format!("{agent}: {reason} — {remedy}"));
            }
            RoomAgentReadiness::Ready | RoomAgentReadiness::Unknown => {}
        }
    }
    // The line that is ALWAYS present when nobody can answer, regardless of how Q3 is ruled. m0irai
    // has no account of its own and never asks for one, and an operator staring at three sign-in
    // commands is exactly the person who might think otherwise.
    if lines.len() == 3 {
        lines.push("m0irai itself needs no account.".to_owned());
    }
    lines
}

fn agent_readiness<'a>(room: &'a RoomView, agent: &str) -> &'a RoomAgentReadiness {
    match agent {
        "claude" => &room.readiness.claude,
        "codex" => &room.readiness.codex,
        _ => &room.readiness.gemini,
    }
}

/// The chip's readiness word, or `None` when there is nothing to say.
///
/// ⚠ A STALE BOOT SAMPLE LOSES TO A LIVE WIRE. If `agent.status` has since reported this lane
/// authenticated, the sample is out of date and says nothing — the operator may have signed in while
/// the room was open, and readiness is sampled once, at boot. That is why the wording is "sign in" and
/// not "is signed out": one is an instruction that stays true, the other is a claim that expires.
///
/// `Ready` and `Unknown` both render NOTHING, which is what makes the boot frame byte-identical to
/// what it was before any probe existed. A room that cannot prove an agent is unavailable does not say
/// that it is.
fn readiness_suffix(
    readiness: &RoomAgentReadiness,
    status: Option<&AgentStatusState>,
) -> Option<(String, ratatui::style::Color)> {
    if status.is_some_and(|status| status.auth == Some(AgentAuthState::Ready)) {
        return None;
    }
    let theme = RoomTheme::current();
    match readiness {
        RoomAgentReadiness::NeedsLogin { .. } => Some((" sign in".to_owned(), theme.warning)),
        RoomAgentReadiness::Unusable { .. } => Some((" unavailable".to_owned(), theme.dead)),
        RoomAgentReadiness::Ready | RoomAgentReadiness::Unknown => None,
    }
}

fn append_footer_suffix(
    spans: &mut Vec<Span<'static>>,
    width: &mut u16,
    cell_width: u16,
    suffix: (String, ratatui::style::Color),
) {
    let (suffix, color) = suffix;
    let suffix = truncate_width(&suffix, cell_width.saturating_sub(*width) as usize);
    *width = width.saturating_add(UnicodeWidthStr::width(suffix.as_str()) as u16);
    spans.push(Span::styled(suffix, Style::default().fg(color)));
}

/// [`append_footer_suffix`] for a suffix made of several independently-coloured fragments (FL-127:
/// usage is the one caller with more than one colour in a single suffix). Appends one `Span` per
/// fragment, truncating and stopping at the cell's own budget the same way the single-fragment path
/// does — by construction the fragments `usage_suffix` returns already fit inside `available`, so this
/// truncation is the same defensive floor `append_footer_suffix` already carried, not a new behaviour.
fn append_footer_suffix_parts(
    spans: &mut Vec<Span<'static>>,
    width: &mut u16,
    cell_width: u16,
    parts: Vec<(String, ratatui::style::Color)>,
) {
    for (text, color) in parts {
        let remaining = cell_width.saturating_sub(*width);
        if remaining == 0 {
            break;
        }
        let text = truncate_width(&text, remaining as usize);
        if text.is_empty() {
            continue;
        }
        *width = width.saturating_add(UnicodeWidthStr::width(text.as_str()) as u16);
        spans.push(Span::styled(text, Style::default().fg(color)));
    }
}

fn active_availability(status: &AgentStatusState, now_ms: u64) -> Option<AgentAvailabilityState> {
    if status
        .availability_resets_at_ms
        .is_some_and(|reset| reset <= now_ms)
    {
        None
    } else {
        status.availability
    }
}

/// The three states in which an agent CANNOT WORK RIGHT NOW, and the only three words the room uses
/// for them.
///
/// OPERATOR RULING, 2026-08-22, verbatim: "with red and under it out of usage". `out of usage` is not
/// `offline` and never was: codex at its quota is reachable, signed in, and answering — it is spent.
/// Before this, `Exhausted` fell through `status_is_limited` to a YELLOW ` limited` suffix, the same
/// word an `auth: limited` boot sample earns, so the one state that stops a lane dead looked like the
/// one that does not. Collapsing all three into `offline` is the information loss this undoes.
///
/// `limited` and `retrying` are deliberately NOT here: both still dispatch, so neither earns a red
/// name or a row. This enum is exactly "the operator cannot use this agent until something changes".
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FooterHealth {
    OutOfUsage,
    NeedsSignIn,
    Offline,
}

impl FooterHealth {
    const fn word(self) -> &'static str {
        match self {
            Self::OutOfUsage => "out of usage",
            Self::NeedsSignIn => "needs sign-in",
            Self::Offline => "offline",
        }
    }
}

/// WHY AVAILABILITY IS READ BEFORE AUTH. `availability` is dispatch REALITY — what happened when this
/// room last actually sent to this lane. `auth` can still be a boot-probe sample, and this footer
/// already rules that a live verdict outranks a stale one (the identity ladder in
/// [`footer_agent_cell`] says so at length). Reading auth first would let a boot probe overwrite the
/// verdict of a real send.
///
/// ⚠ `LocalBlocked` CANNOT BE TOLD APART, and that is a WIRE GAP rather than a choice made here. The
/// Node model knows the cause — `lane-availability.ts`'s `cause` field carries `exhausted` or
/// `needs_auth` through the `local_blocked` transition — but `roomAgentStatusPayload`
/// (`src/room/room-host-support.ts:228-232`) puts only `state` and `resetsAtMs` on the wire, and the
/// `availability` object in `protocol/zer0-room-v1.schema.json` is `additionalProperties: false`. So a
/// spent lane says `out of usage` when it dies and `offline` from its next blocked send onward. The
/// COLOUR is red across both, so the operator never watches it flip healthy — but the word degrades
/// from specific to generic, and the only honest fix is to carry the cause on the wire. Guessing it
/// from `usage.exhausted` was considered and rejected: that bit belongs to the last usage SNAPSHOT,
/// written by a different producer at a different time, so it is a proxy — it would sometimes say
/// `needs sign-in` to an operator who is merely out of quota.
/// Keep [`RoomView::spent_lanes`] in step with what the reducer now says.
///
/// Called from the room's event arm and its snapshot arm — the two places a status can change — so
/// there is exactly one rule and no second copy of it. Cheap by construction: three agents, two set
/// operations.
///
/// WRITE on a live `exhausted` verdict. DROP on `ready`, which is the only edge back to a dispatchable
/// lane (`lane-availability.ts`'s `onDispatchSuccess`), and the operator's own proof that the account
/// is spending again. Everything else — `local_blocked`, `retrying`, `needs_auth` — leaves the memory
/// alone, because those are the states the memory exists to survive.
pub(super) fn reconcile_spent_lanes(room: &mut RoomView) {
    let mut spent = Vec::new();
    let mut recovered = Vec::new();
    for agent in ["claude", "codex", "gemini"] {
        match room
            .reducer
            .agent_status(agent)
            .map(|status| status.availability)
        {
            Some(Some(AgentAvailabilityState::Exhausted)) => spent.push(agent),
            Some(Some(AgentAvailabilityState::Ready)) => recovered.push(agent),
            _ => {}
        }
    }
    for agent in spent {
        room.spent_lanes.insert(agent.to_owned());
    }
    for agent in recovered {
        room.spent_lanes.remove(agent);
    }
}

/// ITEM F — THE ONE MOMENT THE PAINTED ROOM CHANGES WITH NOTHING BEHIND IT.
///
/// Every other repaint in this loop has a cause: an event arrives, a key is pressed, a lane is busy.
/// A health state's expiry has none. `active_availability` reads a reset instant that has passed as
/// "this state is over", so at that instant `footer_health` returns `None`, `footer_state_row`'s
/// `anyone_unusable` goes false, the red row retires and the footer drops from three rows to two —
/// which hands the transcript its row back and changes the feed's geometry. With a non-empty
/// transcript and no busy lane, the 132 ms poll left `redraw` false, so the operator kept looking at
/// a red `out of usage` row for an agent the room had already stopped believing was spent, until
/// they happened to type.
///
/// LATCHED, so the repaint happens ONCE. Returning "a reset has passed" on every tick would pin the
/// render loop at the poll rate forever after the first expiry — the same cost as a spinner, with
/// nothing moving.
///
/// COST WHEN NOTHING IS PAINTED, which is the ordinary case: one `Option` compare plus the recompute
/// below. The recompute is deliberately unconditional rather than skipped while the latch is empty —
/// a health state that becomes painted needs its instant recorded, and the event that painted it does
/// not know the wall clock. It is three map lookups with no allocation and no formatting; the
/// formatting or string building at all - the painted phrase is a static word (`health_phrase`).
pub(super) fn reconcile_health_reset_at(room: &mut RoomView, now_ms: u64) -> bool {
    let crossed = room.health_reset_due_ms.is_some_and(|due| now_ms >= due);
    room.health_reset_due_ms = painted_health_reset_due(room, now_ms);
    crossed
}

/// The earliest FUTURE reset instant among the agents currently wearing a health word.
///
/// Read through [`agent_footer_health`] rather than off the reducer directly, for the reason that
/// function's own header gives: it is THE entry point, and a fourth reader of "is this agent
/// unusable" is how the surfaces start disagreeing. An agent that is unusable with no reset instant
/// contributes nothing — its state never expires by the clock, which since item B is the ordinary
/// shape of a death the vendor reported no window for. The roster mirrors `room_footer_at`'s, because
/// this answers a question about what that function painted.
fn painted_health_reset_due(room: &RoomView, now_ms: u64) -> Option<u64> {
    ["claude", "codex", "gemini"]
        .into_iter()
        .filter(|agent| agent_footer_health(room, agent, now_ms).is_some())
        .filter_map(|agent| {
            room.reducer
                .agent_status(agent)
                .and_then(|status| status.availability_resets_at_ms)
        })
        .filter(|reset| *reset > now_ms)
        .min()
}

/// One agent's footer health, memory included. THE ONE ENTRY POINT — the chip, the state row and
/// `/status` all read health through here, so the three surfaces cannot disagree about which word an
/// agent is wearing.
fn agent_footer_health(room: &RoomView, agent: &str, now_ms: u64) -> Option<FooterHealth> {
    let status = room.reducer.agent_status(agent)?;
    let health = footer_health(status, now_ms)?;
    // The degraded case, and the ONLY thing the memory is allowed to change: a lane the room has seen
    // spend itself, now reporting the generic `local_blocked` the wire cannot qualify. A reset instant
    // that has already passed retires the memory's authority here rather than waiting for `ready`,
    // because past that moment the room genuinely does not know whether the account recovered.
    if health == FooterHealth::Offline
        && active_availability(status, now_ms) == Some(AgentAvailabilityState::LocalBlocked)
        && room.spent_lanes.contains(agent)
        && status
            .availability_resets_at_ms
            .is_none_or(|reset| reset > now_ms)
    {
        return Some(FooterHealth::OutOfUsage);
    }
    Some(health)
}

fn footer_health(status: &AgentStatusState, now_ms: u64) -> Option<FooterHealth> {
    match active_availability(status, now_ms) {
        Some(AgentAvailabilityState::Exhausted) => return Some(FooterHealth::OutOfUsage),
        Some(AgentAvailabilityState::NeedsAuth) => return Some(FooterHealth::NeedsSignIn),
        Some(AgentAvailabilityState::LocalBlocked) => return Some(FooterHealth::Offline),
        _ => {}
    }
    (status.auth == Some(AgentAuthState::Down)).then_some(FooterHealth::Offline)
}

/// A width `/status` can never exceed: that surface is one line per agent, joined with a separator,
/// so the word below always fits there.
const STATUS_PHRASE_WIDTH: u16 = u16::MAX;

/// The phrase for one unusable agent: THE WORD, and nothing else.
///
/// OPERATOR RULING, 2026-08-24: "keep it simple, just show out of usage and that's it — stop trying
/// to complicate stuff." So there is no reset clause of any kind here, and there is no source of one
/// that would be acceptable — not a fallback cooldown, not a vendor-reported window. `out of usage`,
/// `needs sign-in`, `offline`. That is the whole surface.
///
/// WHAT THIS REPLACED, so the next person does not rebuild it. The phrase used to degrade down a
/// four-rung ladder — `out of usage · resets Aug 27 8:54 AM`, then `· resets in 4d 2h`, then
/// `· in 4d 2h`, then the bare word — because at 36 columns the absolute form got hard-truncated by
/// the row into `resets Oct 2 10:0…`, a half-printed clock that could be 10:04 or 10:09 and still
/// looked like information. The ladder was a correct fix for a problem that only existed because the
/// clause was there. Deleting the clause deletes the problem, and one rung cannot degrade wrongly.
///
/// The reset instant has NOT stopped mattering — it still retires a health state once it passes
/// (`active_availability`) and still drives the internal cooldown on the host side. It simply never
/// reaches a painted string.
///
/// THE WORD STILL HAS TO FIT. Below a 12-column cell — a terminal narrower than ~36 — this returns
/// NOTHING rather than `out of usa…`. The chip above is still painted `theme.dead`, so the operator
/// still sees which agent is unusable; a shredded word adds nothing to that and costs the row. An
/// empty phrase for every agent also retires the state row itself (`footer_state_row`'s
/// `anyone_unusable`), which is the same minimum-info rule that made the row conditional.
///
/// Shared by the footer's state row and `/status` so the two surfaces cannot word the same fact
/// differently — the placement and the budget differ, the word does not.
fn health_phrase(health: FooterHealth, available: u16) -> String {
    let word = health.word();
    if UnicodeWidthStr::width(word) <= available as usize {
        return word.to_owned();
    }
    String::new()
}

/// The one word an agent can wear while STILL DISPATCHING. `Exhausted` used to be the first branch
/// here; it moved to [`footer_health`] under the operator's ruling, because a lane that refuses work
/// must not share a word with one that merely reports a spent-looking boot sample.
fn status_is_limited(status: &AgentStatusState, now_ms: u64) -> bool {
    if status.auth != Some(AgentAuthState::Limited) {
        return false;
    }
    let resets = [
        status.availability_resets_at_ms,
        status
            .usage
            .as_ref()
            .and_then(|usage| usage.five_hour_resets_at_ms),
        status
            .usage
            .as_ref()
            .and_then(|usage| usage.weekly_resets_at_ms),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    resets.is_empty() || resets.into_iter().any(|reset| reset > now_ms)
}

fn mode_suffix(
    mode: Option<&zer0_room_protocol::AgentModeState>,
) -> Option<(String, ratatui::style::Color)> {
    let mode = mode?;
    let theme = RoomTheme::current();
    let word = mode.word.as_deref()?;
    // The footer is the stable roster, not the provider handshake log. Keep
    // showing the selected mode while confirmation is pending or reverting;
    // the protocol retains the real status for diagnostics and recovery.
    Some((format!(" {word}"), theme.dim))
}

/// The meters for one roster cell, already fitted to the columns it has — one coloured fragment PER
/// METER rather than one colour for the whole suffix.
///
/// ⚠ FL-127: the old signature returned one `(String, Color)` for the entire row, decided by a single
/// `warning = exhausted || any(pct >= 90)` check. One meter over 90 dragged every other meter on that
/// row yellow with it — captured live: claude's `wk 92%` turned `ctx 4%` yellow beside it. A threshold
/// tweak cannot fix a signature that cannot express per-meter colour, so the return type changed to a
/// `Vec` of fragments, one per visible meter (plus, in the narrow path, one more for the hidden-meter
/// marker), each carrying its OWN colour from [`meter_color`]. The caller (`footer_agent_cell`) renders
/// each fragment as its own [`Span`], so two meters on one row can finally disagree.
///
/// WHICH meters is [`visible_meters`]'s call (V1's policy, ported whole — see room_usage_meters.rs).
/// WHAT TO DROP when they do not fit is [`fit_compact_kept`]'s, and it drops WHOLE meters: the
/// pre-FL-095 version built one dense string and let append_footer_suffix cut it by column, which
/// turned an 81% weekly into `wk8…` — a wrong number wearing a truncation mark, captured at width 80.
///
/// The rich form (gauge, spaced labels) is unchanged and still preferred whenever it fits. Only the
/// narrow path changed, and the fragments it returns are ALREADY within budget, so the truncation in
/// `append_footer_suffix_parts` has nothing left to cut on the width axis — it exists there only as the
/// same defensive floor `append_footer_suffix` already carried for the other suffix kinds.
fn usage_suffix(
    usage: &AgentUsageState,
    available: u16,
    now_ms: u64,
) -> Option<Vec<(String, ratatui::style::Color)>> {
    let meters = visible_meters(usage, now_ms);
    if meters.is_empty() {
        return None;
    }
    let theme = RoomTheme::current();
    let exhausted = usage_exhausted_now(usage, now_ms);
    let rich = rich_usage_parts(&meters, exhausted, &theme);
    if parts_width(&rich) <= available as usize {
        return Some(rich);
    }
    // Narrow cells retain every real number they can still show WHOLE. Labels and percentages carry
    // meaning without color; the decorative gauge and separators fold away first, and only then does
    // an entire meter go — never half of one. The budget passed down is the suffix's own, one column
    // short of `available` because the rendered form is ` {value}`.
    let ellipsis = room_secondary(RoomSecondaryGlyph::Ellipsis);
    let (kept, needs_marker) =
        fit_compact_kept(&meters, (available as usize).saturating_sub(1), ellipsis);
    if kept.is_empty() && !needs_marker {
        return None;
    }
    Some(compact_usage_parts(
        kept,
        needs_marker,
        ellipsis,
        exhausted,
        &theme,
    ))
}

/// Per-meter colour: a pure step ramp on the value, upstream's PATTERN 1 —
/// `D:/grok-ref/.../src/views/credit_bar.rs:269-275`, `credit_bar_line_for_session`:
/// `if pct >= 100.0 { accent_error } else if pct >= 80.0 { warning } else { accent_success }`.
/// PATTERN 2, the blended gradient in `context_bar.rs`'s `ColorBreakpoint`/`blend_color`, is
/// deliberately NOT taken: the operator ruled the meters read plainly gray until a rule fires, and a
/// gradient is never plainly gray — it is always some blend (FL-127).
///
/// Three deviations from upstream, all operator-ruled (FL-127, docs/FINDINGS.md):
///   - numbers 80/100 -> 70/85;
///   - low end `accent_success` (green) -> `theme.dim` (gray) — three green rows in a footer that
///     already carries identity colour is noise;
///   - `exhausted` forces red regardless of `pct`. `AgentUsageState::exhausted` is ONE bool for the
///     whole agent, not per meter, so this is not really a fourth pct tier — it is the same row-level
///     signal the pre-FL-127 code already forced to `warning` for the whole row, generalised here to
///     every visible meter on that row rather than dropped. `theme.dead` — the room's existing red,
///     already used for " offline" and " unavailable" — is reused rather than adding a new token: the
///     room's theme has no separate "critical" red and this is the same severity those two already
///     mean.
fn meter_color(pct: u8, exhausted: bool, theme: &RoomTheme) -> ratatui::style::Color {
    if exhausted || pct >= 85 {
        theme.dead
    } else if pct >= 70 {
        theme.warning
    } else {
        theme.dim
    }
}

/// The rich form's per-meter fragments: gauge, spaced labels, one colour each. Byte-identical to the
/// pre-FL-127 joined string once concatenated — `" {frag0}{frag1}..."` — so callers that only read the
/// concatenated text (`/status`, the width-fit check here) see no change at all.
fn rich_usage_parts(
    meters: &[Meter],
    exhausted: bool,
    theme: &RoomTheme,
) -> Vec<(String, ratatui::style::Color)> {
    meters
        .iter()
        .enumerate()
        .map(|(index, meter)| {
            // First fragment carries the suffix's own leading space; the rest reproduce the original
            // `.join("  ")` two-space separator, now attached to each meter instead of glued between.
            let prefix = if index == 0 { " " } else { "  " };
            let text = match meter.kind {
                MeterKind::Context => format!(
                    "{prefix}{} ctx {}%",
                    room_secondary(RoomSecondaryGlyph::Context),
                    meter.pct
                ),
                MeterKind::FiveHour => {
                    format!("{prefix}{} 5h {}%", quota_bar(meter.pct), meter.pct)
                }
                MeterKind::Weekly => format!("{prefix}wk {}%", meter.pct),
            };
            (text, meter_color(meter.pct, exhausted, theme))
        })
        .collect()
}

/// The narrow form's per-meter fragments, plus the hidden-meter marker as its own (dim) fragment when
/// [`fit_compact_kept`] says one is needed. Same byte-identical-when-joined property as
/// [`rich_usage_parts`]: `dense_meter_text`'s separator is a single space, so every kept meter's
/// fragment gets a leading `" "` — for the first kept meter that space IS the suffix's own leading
/// space, and for the rest it reproduces the join. The marker gets no leading space of its own (it
/// follows the last kept meter's `%` directly, e.g. `wk81%…`) unless no meter survived at all, in which
/// case the marker alone carries the suffix's leading space.
fn compact_usage_parts(
    kept: &[Meter],
    needs_marker: bool,
    marker: &str,
    exhausted: bool,
    theme: &RoomTheme,
) -> Vec<(String, ratatui::style::Color)> {
    let mut parts = Vec::with_capacity(kept.len() + usize::from(needs_marker));
    for meter in kept {
        parts.push((
            format!(" {}{}%", meter.kind.label(), meter.pct),
            meter_color(meter.pct, exhausted, theme),
        ));
    }
    if needs_marker {
        let prefix = if kept.is_empty() { " " } else { "" };
        // The marker itself is not a value — it says a value is hidden, not what it is — so it never
        // earns a severity colour of its own; it stays the same dim the whole row used to default to.
        parts.push((format!("{prefix}{marker}"), theme.dim));
    }
    parts
}

/// Total display-column width of a fragment list, for the same fits-or-falls-back check the old single
/// joined string used — summed rather than measured on a re-joined string because the fragments ARE
/// the thing being rendered now, and re-joining them just to measure would be building the string this
/// whole change exists to avoid building.
fn parts_width(parts: &[(String, ratatui::style::Color)]) -> usize {
    parts
        .iter()
        .map(|(text, _)| UnicodeWidthStr::width(text.as_str()))
        .sum()
}

fn usage_exhausted_now(usage: &AgentUsageState, now_ms: u64) -> bool {
    if !usage.exhausted {
        return false;
    }
    let reset_times = [usage.five_hour_resets_at_ms, usage.weekly_resets_at_ms]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    reset_times.is_empty() || reset_times.into_iter().any(|reset| reset > now_ms)
}

fn quota_bar(value: u8) -> String {
    let filled = usize::from(value).div_ceil(20).min(5);
    format!(
        "{}{}",
        room_secondary(RoomSecondaryGlyph::QuotaFilled).repeat(filled),
        room_secondary(RoomSecondaryGlyph::QuotaEmpty).repeat(5 - filled)
    )
}

pub(crate) fn truncate_width(value: &str, width: usize) -> String {
    if UnicodeWidthStr::width(value) <= width {
        return value.to_owned();
    }
    if width == 0 {
        return String::new();
    }
    let ellipsis = room_secondary(RoomSecondaryGlyph::Ellipsis);
    let ellipsis_width = UnicodeWidthStr::width(ellipsis);
    let target = width.saturating_sub(ellipsis_width);
    let mut result = String::new();
    let mut used = 0;
    for ch in value.chars() {
        let char_width = UnicodeWidthChar::width(ch).unwrap_or(0);
        if used + char_width > target {
            break;
        }
        result.push(ch);
        used += char_width;
    }
    result.push_str(ellipsis);
    result
}

struct InputReader {
    alive: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

enum RoomInput {
    Event(Event),
    Failed(std::io::Error),
}

/// crossterm can transiently fail while a terminal is resizing or being
/// reattached. A bounded streak is tolerated, but a permanent failure must
/// reach the runtime rather than turning the room into an idle, unresponsive
/// terminal forever.
const MAX_CONSECUTIVE_INPUT_ERRORS: u8 = 50;
/// Input remains ordered but cannot grow without bound while terminal output
/// is applying backpressure to the room loop.
const ROOM_INPUT_QUEUE_CAPACITY: usize = 128;

#[derive(Default)]
struct InputErrorBudget {
    consecutive: u8,
}

impl InputErrorBudget {
    fn success(&mut self) {
        self.consecutive = 0;
    }

    fn failure(&mut self, operation: &str, error: std::io::Error) -> Option<std::io::Error> {
        self.consecutive = self.consecutive.saturating_add(1);
        (self.consecutive >= MAX_CONSECUTIVE_INPUT_ERRORS).then(|| {
            std::io::Error::new(
                error.kind(),
                format!(
                    "terminal input {operation} failed {} consecutive times: {error}",
                    self.consecutive
                ),
            )
        })
    }
}

impl InputReader {
    fn shutdown(&mut self) {
        self.alive.store(false, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }

    fn stop(mut self) {
        self.shutdown();
    }
}

impl Drop for InputReader {
    fn drop(&mut self) {
        self.shutdown();
    }
}

const ROOM_TERMINAL_INACTIVE: u8 = 0;
const ROOM_TERMINAL_FULLSCREEN: u8 = 1;
const ROOM_TERMINAL_INLINE: u8 = 2;

static ROOM_PANIC_HOOK_INSTALL: Once = Once::new();
static ACTIVE_ROOM_SCREEN_MODE: AtomicU8 = AtomicU8::new(ROOM_TERMINAL_INACTIVE);
static ACTIVE_ROOM_WRITER: OnceLock<Mutex<Option<WriterSync>>> = OnceLock::new();

fn active_room_writer_slot() -> &'static Mutex<Option<WriterSync>> {
    ACTIVE_ROOM_WRITER.get_or_init(|| Mutex::new(None))
}

fn register_active_room_writer(writer: WriterSync) -> anyhow::Result<()> {
    let mut active = active_room_writer_slot()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if active.is_some() {
        return Err(anyhow::anyhow!(
            "concurrent room writers are unsupported because terminal state is process-global"
        ));
    }
    *active = Some(writer);
    Ok(())
}

fn clear_active_room_writer() {
    let mut active = active_room_writer_slot()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    *active = None;
}

/// Clone the panic fence without waiting on the registry lock. The only
/// contended sections are registration before terminal initialization and
/// clearing after terminal restoration, where no frame can be in flight.
fn active_room_writer() -> Option<WriterSync> {
    match active_room_writer_slot().try_lock() {
        Ok(active) => active.clone(),
        Err(TryLockError::Poisoned(error)) => error.into_inner().clone(),
        Err(TryLockError::WouldBlock) => None,
    }
}

fn quiesce_active_room_writer() {
    let Some(writer) = active_room_writer() else {
        return;
    };
    writer.stop_accepting();
    // Panic profiles abort after the hook returns. The bound prevents a broken
    // terminal device from trapping the process in its panic hook forever;
    // healthy and deliberately delayed writers are fenced and drained here.
    let _ = writer.wait_quiesced(Duration::from_secs(10));
}

fn install_room_panic_hook() {
    ROOM_PANIC_HOOK_INSTALL.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if let Some(mode) = active_room_screen_mode() {
                restore_active_room_terminal(mode);
            }
            previous(info);
        }));
    });
}

fn active_room_screen_mode() -> Option<ScreenMode> {
    match ACTIVE_ROOM_SCREEN_MODE.load(Ordering::Acquire) {
        ROOM_TERMINAL_FULLSCREEN => Some(ScreenMode::Fullscreen),
        ROOM_TERMINAL_INLINE => Some(ScreenMode::Inline),
        _ => None,
    }
}

fn screen_mode_code(mode: ScreenMode) -> u8 {
    match mode {
        ScreenMode::Fullscreen => ROOM_TERMINAL_FULLSCREEN,
        ScreenMode::Inline => ROOM_TERMINAL_INLINE,
    }
}

fn activate_room_terminal(mode: ScreenMode) -> anyhow::Result<()> {
    ACTIVE_ROOM_SCREEN_MODE
        .compare_exchange(
            ROOM_TERMINAL_INACTIVE,
            screen_mode_code(mode),
            Ordering::AcqRel,
            Ordering::Acquire,
        )
        .map_err(|_| {
            anyhow::anyhow!(
                "concurrent room terminals are unsupported because terminal state is process-global"
            )
        })?;
    Ok(())
}

fn deactivate_room_terminal() {
    ACTIVE_ROOM_SCREEN_MODE.store(ROOM_TERMINAL_INACTIVE, Ordering::Release);
}

/// Best-effort cleanup shared by the abort-capable panic hook and the unwind
/// guard. The hook must use direct terminal teardown because dev/release use
/// `panic = "abort"`, where Drop cannot run.
fn restore_active_room_terminal(mode: ScreenMode) {
    quiesce_active_room_writer();
    let _ = crate::terminal_lifecycle::restore_input_modes_for_unwind(mode);
    let _ = crossterm::terminal::disable_raw_mode();
}

/// RAII fallback for recoverable initialization errors and unwind builds. The
/// process hook handles aborting builds; this guard clears active state after
/// local cleanup so caught unwinds cannot leave a stale room terminal behind.
struct EmergencyTerminalRestore {
    mode: ScreenMode,
    armed: bool,
    restore: fn(ScreenMode),
}

impl EmergencyTerminalRestore {
    fn arm(mode: ScreenMode) -> anyhow::Result<Self> {
        activate_room_terminal(mode)?;
        Ok(Self {
            mode,
            armed: true,
            restore: restore_active_room_terminal,
        })
    }

    fn set_mode(&mut self, mode: ScreenMode) {
        self.mode = mode;
        ACTIVE_ROOM_SCREEN_MODE.store(screen_mode_code(mode), Ordering::Release);
    }

    fn register_writer(&mut self, writer: WriterSync) -> anyhow::Result<()> {
        register_active_room_writer(writer)
    }

    /// Only call after `restore_terminal` succeeds. A panic or error during
    /// writer drain or direct terminal teardown still needs the RAII fallback
    /// and process hook to see active room state.
    fn disarm_after_restore(&mut self) {
        clear_active_room_writer();
        deactivate_room_terminal();
        self.armed = false;
    }
}

impl Drop for EmergencyTerminalRestore {
    fn drop(&mut self) {
        if self.armed {
            (self.restore)(self.mode);
            clear_active_room_writer();
            deactivate_room_terminal();
        }
    }
}

fn room_input_channel() -> (mpsc::Sender<RoomInput>, mpsc::Receiver<RoomInput>) {
    mpsc::channel(ROOM_INPUT_QUEUE_CAPACITY)
}

/// The reader thread's whole body, as a value the spawn seam can carry.
///
/// A named struct rather than a boxed closure so [`InputThreadSpawn`] can stay
/// an ordinary `fn` pointer, which is the shape this file already uses for an
/// injectable seam (`EmergencyTerminalRestore::restore`).
struct InputReaderLoop {
    alive: Arc<AtomicBool>,
    tx: mpsc::Sender<RoomInput>,
}

impl InputReaderLoop {
    fn run(self) {
        let mut errors = InputErrorBudget::default();
        while self.alive.load(Ordering::Acquire) {
            match event::poll(Duration::from_millis(50)) {
                Ok(false) => errors.success(),
                Ok(true) => match event::read() {
                    Ok(input) => {
                        errors.success();
                        if self.tx.blocking_send(RoomInput::Event(input)).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        if let Some(error) = errors.failure("read", error) {
                            let _ = self.tx.blocking_send(RoomInput::Failed(error));
                            break;
                        }
                    }
                },
                Err(error) => {
                    if let Some(error) = errors.failure("poll", error) {
                        let _ = self.tx.blocking_send(RoomInput::Failed(error));
                        break;
                    }
                }
            }
        }
    }
}

/// How the input reader's OS thread is started. Production passes
/// [`spawn_named_input_thread`]; the CQ-09 proof passes one that always fails,
/// because thread exhaustion cannot be produced on demand without hurting the
/// machine the suite is running on.
type InputThreadSpawn = fn(InputReaderLoop) -> std::io::Result<std::thread::JoinHandle<()>>;

fn spawn_named_input_thread(
    reader: InputReaderLoop,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    std::thread::Builder::new()
        .name("zer0-pager-input".into())
        .spawn(move || reader.run())
}

/// CQ-09. This used to `.expect("could not start pager input reader")`.
///
/// The panic did not strand the terminal — `install_room_panic_hook` runs
/// before `EmergencyTerminalRestore::arm`, so by the time `run_loop` reaches
/// here the hook restores input modes and clears raw mode on the way down.
/// What it DID cost is everything after that: dev and release both build with
/// `panic = "abort"`, so the process died on a thread-spawn failure that the
/// caller is perfectly able to report, `restore_terminal`'s join of the writer
/// thread never ran, and the operator got a Rust panic and a backtrace instead
/// of a sentence naming what failed. A recoverable OS error is not a crash.
///
/// Now it returns the error, `run_loop` propagates it with `?`, and the one
/// exit path at the top of this module restores the terminal and disarms the
/// guard exactly as it does for every other run failure.
fn spawn_input_reader() -> std::io::Result<(mpsc::Receiver<RoomInput>, InputReader)> {
    spawn_input_reader_with(spawn_named_input_thread)
}

fn spawn_input_reader_with(
    spawn: InputThreadSpawn,
) -> std::io::Result<(mpsc::Receiver<RoomInput>, InputReader)> {
    let (tx, rx) = room_input_channel();
    let alive = Arc::new(AtomicBool::new(true));
    let thread = spawn(InputReaderLoop {
        alive: Arc::clone(&alive),
        tx,
    })?;
    Ok((
        rx,
        InputReader {
            alive,
            thread: Some(thread),
        },
    ))
}

/// The seam proofs: what the foundation commit locked so that three builders
/// can work in this file at once. Kept out of `mod tests` below, and out of
/// this file, because that is the point of them.
#[cfg(test)]
#[path = "room_runtime_seam_tests.rs"]
mod seam_tests;

/// Slice B's proofs: the cancel keys and the quit they arm. Its own file for
/// the same reason as the seam proofs above — three lanes edit `room_runtime.rs`
/// at once, and a test module appended to it collides with all of them.
#[cfg(test)]
#[path = "room_runtime_cancel_tests.rs"]
mod cancel_tests;

/// Slice D's proofs: the unseen-answer pill, its two keys and its click
/// target. Its own file for the same reason as the two above.
#[cfg(test)]
#[path = "room_answer_pill_tests.rs"]
mod answer_pill_tests;

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    };
    use std::time::Duration;

    use ratatui::{
        buffer::Buffer,
        layout::Rect,
        style::Color,
        widgets::{Paragraph, Widget},
    };
    use serde_json::json;
    use unicode_width::UnicodeWidthStr;

    use super::{
        EmergencyTerminalRestore, InputErrorBudget, InputReader, MAX_CONSECUTIVE_INPUT_ERRORS,
        ROOM_INPUT_QUEUE_CAPACITY, RoomInput, apply_host_exit, apply_runtime_failure,
        footer_agent_cell, lane_busy, meter_color, render_room, room_footer_at, room_input_channel,
        room_status_summary_at, route_permission_key,
    };
    use crate::room_theme::{
        RoomIdentity, RoomSecondaryGlyph, RoomTheme, room_secondary, room_secondary_for,
    };
    use crate::room_view::RoomView;
    use crate::room_view::{RoomAgentReadiness, RoomReadinessSnapshot};

    static ROOM_STATE_TEST_LOCK: Mutex<()> = Mutex::new(());

    /// `handle_key_at` with a real clock.
    ///
    /// Slice B gave the key route an injected clock, because the quit arm is a
    /// deadline and a test of a deadline that sleeps cannot assert its boundary.
    /// Every pin below predates that arm and none of them can reach it, so they
    /// call through this shim rather than each carrying an `Instant` that has
    /// nothing to do with what it is pinning. The shim lives here, in the test
    /// module, so it cannot be mistaken for a production entry point.
    ///
    /// BLOCK 2 gave the panic button its own wire. None of the pins below press
    /// it, so the shim supplies a live cancel channel whose receiver it keeps
    /// alive for the call: a dropped receiver would turn `request_cancel_all`
    /// into an error and these pins would start failing for a reason that has
    /// nothing to do with what they pin.
    async fn handle_key(
        room: &mut RoomView,
        key: crossterm::event::KeyEvent,
        commands: &tokio::sync::mpsc::Sender<super::RoomCommand>,
    ) -> anyhow::Result<Option<super::RoomRuntimeExit>> {
        let (cancels, _cancel_rx) = tokio::sync::mpsc::channel(4);
        super::handle_key_at(room, key, commands, &cancels, std::time::Instant::now()).await
    }

    pub(super) fn event(
        seq: u64,
        kind: &str,
        payload: serde_json::Value,
    ) -> zer0_room_protocol::RoomEvent {
        zer0_room_protocol::RoomEvent::from_value(json!({
            "protocol": "zer0.room", "version": 1, "sessionId": "render-room",
            "eventSeq": seq.to_string(), "eventId": format!("render-event-{seq}"),
            "turnId": "render-turn", "occurredAt": "2026-08-02T00:00:00Z",
            "type": kind, "payload": payload,
        }))
        .expect("test event is protocol-valid")
    }

    pub(super) fn apply(room: &mut RoomView, event: zer0_room_protocol::RoomEvent) {
        apply_at(room, event, 0);
    }

    /// `apply` with the wall clock the production arm reads. DELTA ITEM 5 made that clock matter: the
    /// arm now arms the health-reset deadline from the event that PAINTS the state, so a case about an
    /// expiry has to say when its event arrived. Every other case passes 0, which arms the deadline
    /// from an instant before any fixture's reset and therefore changes nothing about it.
    pub(super) fn apply_at(room: &mut RoomView, event: zer0_room_protocol::RoomEvent, now_ms: u64) {
        let delta = room
            .reducer
            .apply(&event)
            .expect("test event is reducer-valid");
        room.scrollback.apply_event(&event, &room.reducer, delta);
        room.permissions.sync(&room.reducer, &mut room.prompt);
        // The SAME derivations the production arm runs (room_runtime_events.rs). A test helper that
        // skipped either would let every footer test paint from a memory production keeps and this one
        // does not — the "second copy of the arm" that file's own header warns about.
        super::room_answer_pill::record_committed_answer(room, &event);
        super::reconcile_spent_lanes(room);
        let _ = super::reconcile_health_reset_at(room, now_ms);
    }

    fn parse_room_command(text: &str) -> Option<super::ParsedRoomCommand> {
        let room = RoomView::new();
        super::parse_room_command(text, &room.catalog)
    }

    fn seeded_room(with_permission: bool, fail_gemini: bool) -> RoomView {
        let mut room = RoomView::new();
        apply(
            &mut room,
            event(
                1,
                "turn.accepted",
                json!({"agents":["claude","codex","gemini"],"text":"inspect the room","messageId":"operator-1","ledgerSeq":"1"}),
            ),
        );
        apply(
            &mut room,
            event(
                2,
                "route.resolved",
                json!({"agents":["claude","codex","gemini"]}),
            ),
        );
        for (seq, agent) in [(3, "claude"), (4, "codex"), (5, "gemini")] {
            apply(
                &mut room,
                event(
                    seq,
                    "lane.queued",
                    json!({"laneId":format!("lane-{agent}"),"agent":agent,"expectedMessageId":format!("message-{agent}"),"origin":"operator","hopIndex":0}),
                ),
            );
        }
        for (seq, agent) in [(6, "claude"), (7, "codex"), (8, "gemini")] {
            apply(
                &mut room,
                event(
                    seq,
                    "lane.started",
                    json!({"laneId":format!("lane-{agent}"),"streamId":format!("stream-{agent}"),"agent":agent}),
                ),
            );
        }
        for (seq, agent) in [(9, "claude"), (10, "codex"), (11, "gemini")] {
            apply(
                &mut room,
                event(
                    seq,
                    "lane.chunk",
                    json!({"laneId":format!("lane-{agent}"),"streamId":format!("stream-{agent}"),"agent":agent,"streamSeq":"1","chunkIndex":0,"channel":"assistant","text":format!("{agent} body") }),
                ),
            );
        }
        if with_permission {
            apply(
                &mut room,
                event(
                    12,
                    "permission.requested",
                    json!({"askId":"ask-gemini","agent":"gemini","options":[{"optionId":"allow-opaque","kind":"allow_once","name":"Allow once"},{"optionId":"deny-opaque","kind":"reject_once","name":"Deny"}]}),
                ),
            );
        }
        if fail_gemini {
            apply(
                &mut room,
                event(
                    if with_permission { 13 } else { 12 },
                    "lane.failed",
                    json!({"laneId":"lane-gemini","streamId":"stream-gemini","agent":"gemini","error":"provider failed"}),
                ),
            );
        }
        room
    }

    fn rendered_text(buffer: &Buffer) -> String {
        buffer.content.iter().map(|cell| cell.symbol()).collect()
    }

    pub(super) fn row_text(buffer: &Buffer, y: u16) -> String {
        (0..buffer.area.width)
            .filter_map(|x| buffer.cell((x, y)))
            .map(|cell| cell.symbol())
            .collect()
    }

    /// The WHOLE room frame as text, so an assertion about the boot screen is an assertion about what
    /// the operator sees rather than about one widget in isolation.
    pub(super) fn render_room_frame(room: &mut RoomView, width: u16, height: u16) -> String {
        let area = Rect::new(0, 0, width, height);
        let mut buffer = Buffer::empty(area);
        render_room(area, &mut buffer, room);
        (0..height)
            .map(|y| row_text(&buffer, y))
            .collect::<Vec<_>>()
            .join("\n")
    }

    pub(super) fn footer_buffer(room: &RoomView, width: u16, now_ms: u64) -> Buffer {
        // Height comes from the footer itself rather than a constant, for the same reason render_room
        // takes it from there: the state row is conditional, and a fixed 2 here would silently clip it.
        let lines = room_footer_at(room, width, now_ms);
        let area = Rect::new(0, 0, width, lines.len() as u16);
        let mut buffer = Buffer::empty(area);
        Paragraph::new(lines).render(area, &mut buffer);
        buffer
    }
    #[test]
    fn runtime_uses_the_pager_owned_terminal_and_composer_paths() {
        let source = include_str!("room_runtime.rs");
        for required in [
            "init_terminal(",
            "restore_terminal(",
            "spawn_writer_thread()",
            "draw_frame(terminal",
            "room.prompt.draw(",
            "room.prompt.route_enter(&key)",
            "room.prompt.accept_slash_completion()",
            "room.prompt.poll_file_search()",
        ] {
            assert!(
                source.contains(required),
                "missing pager integration: {required}"
            );
        }
    }

    /// A3: a host death the launcher caused reaches the room's own failure row WHOLE.
    ///
    /// The composition root owns the sentence; this crate's only job is to show all of it. That has a
    /// LENGTH in it, because this row clips at the terminal width instead of wrapping — measured
    /// here, in the second half of this test, rather than assumed. 96 columns is the budget
    /// `zer0-v2-bin`'s `every_termination_sentence_fits_the_room_banner_row` holds the producer to,
    /// and this is the other side of that contract: the two tests fail together or not at all.
    ///
    /// Why it matters at all: the row used to be fed `room host exited: Some(1)`, which is what
    /// `TerminateJobObject` reports for a host m0irai killed AND what a host that crashed reports.
    /// FL-143 spent three weeks looking like a host defect because of that one row.
    #[test]
    fn a_host_exit_reaches_the_failure_row_whole() {
        // The longest sentence the launcher can produce today: the transport-failure reap with a
        // five-digit wait. Written out rather than imported, because this crate cannot depend on the
        // composition root — which is exactly why the length is pinned on both sides.
        let longest = "m0irai ended the room host after waiting 12345 ms: its transport had failed \
                       and it did not exit";
        assert!(
            longest.chars().count() <= 96,
            "sample is {} columns; the producer's own pin allows 96",
            longest.chars().count()
        );
        assert!(
            frame_text(longest).contains(longest),
            "the room's failure row must carry the launcher's whole sentence"
        );

        // And the clip is real, which is what makes the budget a budget rather than a habit. Six
        // columns past it, the tail is not ellipsised — it is absent from the frame.
        let overrun = format!("{longest} and six more");
        let frame = frame_text(&overrun);
        assert!(
            !frame.contains(&overrun),
            "this row clips instead of wrapping; if it ever starts wrapping, the 96-column budget on \
             the producer's side is no longer needed and should come off"
        );
        assert!(
            !frame.contains("six more"),
            "clipped text is GONE, not moved to another row: {frame:?}"
        );
    }

    /// One room frame, at the 120 columns this repo's real-terminal proof uses.
    fn frame_text(sentence: &str) -> String {
        let mut room = RoomView::new();
        apply_host_exit(&mut room, sentence);
        let area = Rect::new(0, 0, 120, 32);
        let mut buffer = Buffer::empty(area);
        render_room(area, &mut buffer, &mut room);
        rendered_text(&buffer)
    }

    #[test]
    fn fatal_room_update_enters_the_native_room_presentation() {
        let mut room = RoomView::new();
        apply_runtime_failure(
            &mut room,
            "room command zer0/room/submit failed: host rejected the room command",
        );
        let area = Rect::new(0, 0, 120, 32);
        let mut buffer = Buffer::empty(area);
        render_room(area, &mut buffer, &mut room);
        assert!(rendered_text(&buffer).contains(
            "room failed — room command zer0/room/submit failed: host rejected the room command"
        ));
    }

    /// The room's redraw-pump guard, as one whitespace-normalized statement.
    ///
    /// Two hazards live here and both have already bitten this file.
    ///
    /// `include_str!` pulls in the test module, so a needle written as a plain
    /// `contains` matches ITS OWN literal and passes with the real code gone.
    /// `find` returns the first occurrence — the real loop, far above
    /// `mod tests` — and the offset assertion below makes that explicit.
    ///
    /// And rustfmt reflows this assignment depending on how many terms it
    /// carries: adding the entrance term moved it onto its own line and turned
    /// two pins red on a pure formatting pass. Whitespace is normalized here so
    /// a pin asserts on the guard's TERMS and never on its layout.
    fn pump_guard() -> String {
        let source = include_str!("room_runtime.rs");
        let module = source
            .find("mod tests {")
            .expect("this file has a test module");
        let assign = source
            .find("welcome_showing =")
            .expect("the room's redraw-pump guard");
        assert!(
            assign < module,
            "matched a test's own literal, not the guard: {assign} vs {module}"
        );
        let end = assign
            + source[assign..]
                .find(';')
                .expect("the guard is one statement");
        source[assign..end]
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// How many of the name's six characters are painted on this frame.
    ///
    /// Counted by COLOUR, not by glyph. The name is ordinary text now, so the
    /// characters themselves are searchable — but "m0irai" is also room chrome
    /// on every frame, and each character carries its own palette stop, which
    /// nothing else on screen does.
    fn letters_painted(buffer: &Buffer) -> usize {
        crate::room_welcome::LETTER_COLORS
            .iter()
            .filter(|(r, g, b)| {
                buffer
                    .content
                    .iter()
                    .any(|cell| cell.fg == Color::Rgb(*r, *g, *b))
            })
            .count()
    }

    /// The same question as [`letters_painted`], asked in a way a legacy console
    /// can answer: how many of the name's characters the entrance has typed.
    ///
    /// `letters_painted` counts by COLOUR and is therefore modern-console only.
    /// `room_welcome`'s `name_spans` drops the per-character gradient when the
    /// console cannot be trusted with truecolor and ships the name in the room's
    /// ordinary text colour instead, so on that path the colour count is zero
    /// however settled the card is — which is exactly how two tests here came to
    /// abort the whole pager suite under `GROK_FORCE_LEGACY_CONSOLE=1`
    /// (sealed-lanes #4).
    ///
    /// This reads the NAME ROW instead: `draw` paints the name one row above the
    /// meta line, and the meta line is the only plain-text signature the card
    /// has. Counting there is true on both consoles, and it cannot be satisfied
    /// by the room chrome that also spells `m0irai`, because it is anchored to
    /// the tagline rather than searching the frame.
    ///
    /// The row arrives full terminal width and carries the card's own side
    /// borders, so those come off first — through the same `room_secondary` seam
    /// that drew them, which is `│` here and `|` on a legacy console. Without
    /// that the count is the width of the card, not the length of the name.
    fn name_characters_typed(buffer: &Buffer) -> usize {
        let rows: Vec<String> = (0..buffer.area.height)
            .map(|y| row_text(buffer, y))
            .collect();
        let Some(tagline) = rows.iter().position(|row| row.contains(CARD_MARKER)) else {
            return 0;
        };
        let vertical = room_secondary(RoomSecondaryGlyph::BorderVertical);
        tagline
            .checked_sub(1)
            .and_then(|name_row| rows.get(name_row))
            .map_or(0, |row| row.replace(vertical, " ").trim().chars().count())
    }

    /// The card's own text, and the only string on it that is not also room
    /// chrome.
    ///
    /// TRAP: `"m0irai"` cannot be this marker, and the boot tuning that turned
    /// the card's name back into ordinary text did not change that. The Phase 6
    /// rename put the product name in the header (`m0irai . the room`) and in
    /// the footer (`m0irai . #room`), so `contains("m0irai")` is true on every
    /// frame the room ever draws -- including one with no card at all. Both
    /// directions of the assertions below were broken by that at once: the
    /// absence checks failed outright, and the presence check passed for the
    /// wrong reason. The same trap bites the ConPTY suites through the console
    /// title, which is the executable's own path.
    ///
    /// The tagline is the card's only plain-text signature. Where a test needs
    /// the NAME specifically, the ConPTY suites match it as a whole row inside
    /// the card's border, which no chrome line can reduce to.
    const CARD_MARKER: &str = crate::room_welcome::TAGLINE;

    // The welcome card's whole contract in one test: it greets an untouched
    // room, it is gone on the frame that first carries content, and it does not
    // come back when that content is cleared. The last clause is the one a
    // plain "is the feed empty" check gets wrong.
    #[test]
    fn the_welcome_card_greets_an_empty_room_once_and_never_returns() {
        let area = Rect::new(0, 0, 120, 40);

        let mut fresh = RoomView::new();
        // Assert the settled card: at t=0 the entrance has typed nothing
        // yet, which is its own contract (pinned in room_welcome), not this one.
        fresh.force_welcome_settled();
        let mut buffer = Buffer::empty(area);
        render_room(area, &mut buffer, &mut fresh);
        assert!(
            rendered_text(&buffer).contains(CARD_MARKER),
            "an untouched room must show the m0irai wordmark:\n{}",
            rendered_text(&buffer)
        );

        // Content lands: the card is gone on that very frame.
        apply(
            &mut fresh,
            event(
                1,
                "turn.accepted",
                json!({"agents":["claude"],"text":"inspect the room","messageId":"operator-1","ledgerSeq":"1"}),
            ),
        );
        let mut after = Buffer::empty(area);
        render_room(area, &mut after, &mut fresh);
        assert!(
            !rendered_text(&after).contains(CARD_MARKER),
            "the card must not survive the first row of content:\n{}",
            rendered_text(&after)
        );

        // The trap CARD_MARKER exists to dodge, kept as a live assertion rather
        // than a comment: the product name really is on a card-less frame, so a
        // name-based marker would pass here with nothing drawn.
        assert!(
            rendered_text(&after).contains("m0irai"),
            "the product name is room chrome, not card"
        );

        // Clearing the feed must not re-greet: this room has a history now.
        fresh.scrollback = crate::room_scrollback::RoomScrollback::new();
        assert!(
            fresh.scrollback.is_empty(),
            "the feed really is empty again"
        );
        let mut cleared = Buffer::empty(area);
        render_room(area, &mut cleared, &mut fresh);
        assert!(
            !rendered_text(&cleared).contains(CARD_MARKER),
            "an emptied room is not a new room:\n{}",
            rendered_text(&cleared)
        );

        // A room that boots already populated (a resumed session installs its
        // reducer and scrollback after `new`) is never greeted at all.
        let mut resumed = seeded_room(false, false);
        let mut resumed_buffer = Buffer::empty(area);
        render_room(area, &mut resumed_buffer, &mut resumed);
        assert!(
            !rendered_text(&resumed_buffer).contains(CARD_MARKER),
            "a resumed room has nothing to introduce:\n{}",
            rendered_text(&resumed_buffer)
        );
    }

    // The room's redraw pump is armed by the card and by nothing else. This is
    // the invariant the entrance animation trades against: the empty room is
    // now the ONE surface here that moves on its own, and it must stop dead the
    // moment there is anything to say. A pump that outlives the card is a
    // wakeup nobody asked for, forever.
    #[test]
    fn only_the_welcome_card_arms_the_rooms_redraw_pump() {
        let source = include_str!("room_runtime.rs");
        let module = source
            .find("mod tests {")
            .expect("this file has a test module");
        let guarded = source
            .find("_ = welcome_tick.tick(), if welcome_showing =>")
            .expect("the pump must stay guarded; an unguarded interval wakes a settled room");
        let recomputed = source
            .find("welcome_showing =")
            .expect("the guard must be recomputed from the room, not latched at startup");
        assert!(
            guarded < module && recomputed < module,
            "both sites must be the real loop above the test module, not this              test's own literals: guard {guarded}, recompute {recomputed},              tests start at {module}"
        );
        assert!(
            recomputed < guarded,
            "the guard is recomputed before every select, not after the arm reads it"
        );
        assert!(
            pump_guard().contains("room.welcome_card_visible()"),
            "the guard must read the room's own emptiness latch every iteration,              not a value cached at startup: {}",
            pump_guard()
        );

        // The guard's own truth table, through the real state transitions.
        let mut room = RoomView::new();
        assert!(room.welcome_card_visible(), "a fresh room shows the card");
        apply(
            &mut room,
            event(
                1,
                "turn.accepted",
                json!({"agents":["claude"],"text":"inspect the room","messageId":"operator-1","ledgerSeq":"1"}),
            ),
        );
        assert!(
            !room.welcome_card_visible(),
            "content disarms the pump on the frame it lands"
        );
        room.scrollback = crate::room_scrollback::RoomScrollback::new();
        assert!(
            !room.welcome_card_visible(),
            "and it stays disarmed once the room has had a history"
        );
    }

    // Content arriving mid-entrance kills the card on that frame. The room
    // never waits for an animation it started.
    #[test]
    fn content_landing_mid_entrance_kills_the_card_immediately() {
        let area = Rect::new(0, 0, 120, 40);
        let mut room = RoomView::new();

        // One frame in, deliberately partway through the type-on.
        let mut opening = Buffer::empty(area);
        render_room(area, &mut opening, &mut room);
        assert!(
            !crate::room_welcome::entrance_complete(0.0),
            "this test is only meaningful while the entrance is still running"
        );

        apply(
            &mut room,
            event(
                1,
                "turn.accepted",
                json!({"agents":["claude"],"text":"inspect the room","messageId":"operator-1","ledgerSeq":"1"}),
            ),
        );
        let mut interrupted = Buffer::empty(area);
        render_room(area, &mut interrupted, &mut room);
        assert!(
            !rendered_text(&interrupted).contains(CARD_MARKER),
            "a half-drawn card must vanish, not finish:
{}",
            rendered_text(&interrupted)
        );

        // And it does not come back on the next frames while the entrance clock
        // would still have been running.
        let mut after = Buffer::empty(area);
        render_room(area, &mut after, &mut room);
        assert!(
            !rendered_text(&after).contains(CARD_MARKER),
            "the killed entrance must not resume:
{}",
            rendered_text(&after)
        );
    }

    // The neon path ON SCREEN, not just in the constant array: every one of the
    // six character colors is painted, and they run left to right in palette
    // order. A gradient that exists only in `LETTER_COLORS` is a gradient
    // nobody can see, and a name whose characters are painted out of order is
    // not the path the operator picked.
    //
    // Column-based rather than glyph-based: the product name is also room
    // chrome, so searching the frame for its characters would find the header
    // and the footer. The colour is what makes a cell the CARD's.
    ///
    /// BOTH CONSOLES, explicitly. The gradient is a capability, not a promise: a console that cannot
    /// render the braille mark is one whose colour story `name_spans` will not bet on, so there the
    /// name ships in the room's ordinary text colour. This test asserted the gradient unconditionally
    /// and panicked under `GROK_FORCE_LEGACY_CONSOLE=1` with "letter 0 (Rgb(57, 255, 20)) is not
    /// painted anywhere on the frame" (sealed-lanes #4). Now each console gets its own assertion and
    /// neither is a skip: the modern one proves the path runs left to right in palette order, and the
    /// legacy one proves the name is still THERE, in the plain colour, with no palette stop leaking
    /// onto a screen that cannot show it.
    #[test]
    fn the_name_paints_its_neon_path_onto_the_frame() {
        let area = Rect::new(0, 0, 120, 40);
        let mut room = RoomView::new();
        room.version = "m0irai 0.1.0".to_owned();
        room.force_welcome_settled();
        let mut buffer = Buffer::empty(area);
        render_room(area, &mut buffer, &mut room);

        // The settled card spells the whole name on either console.
        assert_eq!(
            name_characters_typed(&buffer),
            crate::room_welcome::PRODUCT_NAME.chars().count(),
            "the settled card must spell the name in full:\n{}",
            rendered_text(&buffer)
        );

        if crate::glyphs::is_legacy_windows_console() {
            assert_eq!(
                letters_painted(&buffer),
                0,
                "a legacy console must get NO palette stop, not a partial gradient:\n{}",
                rendered_text(&buffer)
            );
            let rows: Vec<String> = (0..area.height).map(|y| row_text(&buffer, y)).collect();
            let tagline = rows
                .iter()
                .position(|row| row.contains(CARD_MARKER))
                .expect("the settled card is on screen");
            let name_row = u16::try_from(tagline - 1).expect("the name row is on screen");
            let text = RoomTheme::current().text;
            assert!(
                (0..area.width).any(|x| buffer
                    .cell((x, name_row))
                    .is_some_and(|cell| cell.fg == text && cell.symbol() != " ")),
                "the plain name must be painted in the room's text colour:\n{}",
                rendered_text(&buffer)
            );
            return;
        }

        let mut previous: Option<(usize, u16)> = None;
        for (index, (r, g, b)) in crate::room_welcome::LETTER_COLORS.iter().enumerate() {
            let want = Color::Rgb(*r, *g, *b);
            let column = (0..area.width)
                .find(|x| {
                    (0..area.height).any(|y| {
                        buffer
                            .cell((*x, y))
                            .is_some_and(|cell| cell.fg == want && cell.symbol() != " ")
                    })
                })
                .unwrap_or_else(|| {
                    panic!(
                        "letter {index} ({want:?}) is not painted anywhere on the frame:
{}",
                        rendered_text(&buffer)
                    )
                });
            if let Some((before, at)) = previous {
                assert!(
                    column > at,
                    "letter {index} must be painted right of letter {before}: {column} vs {at}"
                );
            }
            previous = Some((index, column));
        }
    }

    // Any keypress ends the entrance on the spot AND still does whatever that
    // key was for. Skipping is a side effect of typing, never a consumption of
    // the keystroke: an operator who starts typing has said they are done
    // watching, and swallowing their first character to deliver that would be
    // the worse bug by a distance.
    #[tokio::test]
    async fn a_keystroke_settles_the_entrance_and_still_reaches_the_composer() {
        // The wiring, first: a skip nothing calls is a dead method, and the
        // room's key arm is the one place that covers EVERY accepted key --
        // composer, scrollback and permission routes alike, which is why it
        // sits above the routing rather than inside one branch of it.
        //
        // HAZARD: `include_str!` pulls in THIS file, so a pin written as
        // `source.contains("<the needle>")` finds its own literal and passes
        // with the real code deleted. Every pin here is therefore index-based:
        // `find` returns the first occurrence, which is the real site far above
        // the test module, and the assertion is about ORDER.
        let source = include_str!("room_runtime.rs");
        let arm = source
            .find("Some(RoomInput::Event(Event::Key(key))) if accepts_key(&key) => {")
            .expect("the room's accepted-key arm");
        let skip = source[arm..]
            .find("room.skip_welcome_entrance();")
            .expect("every accepted key must settle the entrance");
        let routing = source[arm..]
            .find("let outcome = if crate::input::key::is_shift_tab(&key)")
            .expect("the key-routing branch");
        assert!(
            skip < routing,
            "the entrance must settle BEFORE the key is routed, not after:              a branch that consumes the key would otherwise never reach the skip"
        );

        let area = Rect::new(0, 0, 120, 40);

        let mut room = RoomView::new();
        let (command_tx, mut command_rx) = tokio::sync::mpsc::channel(1);

        // One frame starts the entrance clock. Nothing is typed on it -- no
        // sleep, no timing wait: the clock starts inside this paint, so this
        // IS the t=0 frame however loaded the machine is.
        let mut opening = Buffer::empty(area);
        render_room(area, &mut opening, &mut room);
        // Counted off the NAME ROW, not by colour. The colour count is zero on a legacy console
        // whatever the entrance has typed, so it cannot tell "nothing typed yet" from "no gradient
        // on this console" — and reading the settled frame with it is what aborted this test under
        // `GROK_FORCE_LEGACY_CONSOLE=1` (sealed-lanes #4).
        assert_eq!(
            name_characters_typed(&opening),
            0,
            "sanity: the entrance has typed no letter on its opening frame"
        );

        // Exactly what the key arm does, in its order.
        room.skip_welcome_entrance();
        let outcome = handle_key(
            &mut room,
            crossterm::event::KeyEvent::new(
                crossterm::event::KeyCode::Char('h'),
                crossterm::event::KeyModifiers::NONE,
            ),
            &command_tx,
        )
        .await
        .unwrap();
        assert_eq!(
            outcome, None,
            "an ordinary character does not exit the room"
        );

        let mut after = Buffer::empty(area);
        render_room(area, &mut after, &mut room);
        assert_eq!(
            room.prompt.text(),
            "h",
            "the keystroke that skipped the entrance must still reach the composer"
        );
        let settled = crate::room_welcome::PRODUCT_NAME.chars().count();
        assert_eq!(
            name_characters_typed(&after),
            settled,
            "the card must be settled on the very frame after the key:
{}",
            rendered_text(&after)
        );
        // BOTH CONSOLES, and neither branch is a skip: the modern one settles every palette stop,
        // the legacy one settles the name with no palette stop at all.
        assert_eq!(
            letters_painted(&after),
            if crate::glyphs::is_legacy_windows_console() {
                0
            } else {
                crate::room_welcome::LETTER_COLORS.len()
            },
            "the settled card's colour story must match the console it is on:
{}",
            rendered_text(&after)
        );
        assert!(
            command_rx.try_recv().is_err(),
            "typing a character sends the host nothing"
        );

        // And it stays settled: the clock is not resumed behind the skip.
        let mut later = Buffer::empty(area);
        render_room(area, &mut later, &mut room);
        assert_eq!(
            name_characters_typed(&later),
            settled,
            "a skipped entrance must not creep back to mid-animation"
        );
    }

    #[test]
    fn room_canvas_replaces_hostile_and_shrunk_frame_cells() {
        let area = Rect::new(0, 0, 96, 28);
        let mut buffer = Buffer::empty(area);
        for cell in &mut buffer.content {
            cell.set_char('\u{00a4}');
            cell.set_bg(Color::Blue);
        }

        let mut quiet = RoomView::new();
        render_room(area, &mut buffer, &mut quiet);
        assert!(
            !rendered_text(&buffer).contains('\u{00a4}'),
            "quiet redraw must erase every hostile cell"
        );
        assert!(
            buffer.content.iter().all(|cell| cell.bg != Color::Blue),
            "quiet redraw must replace every hostile background"
        );

        let mut populated = seeded_room(false, false);
        populated.prompt.set_text("stale room body sentinel");
        render_room(area, &mut buffer, &mut populated);
        assert!(rendered_text(&buffer).contains("stale room body sentinel"));

        let mut quiet_again = RoomView::new();
        render_room(area, &mut buffer, &mut quiet_again);
        assert!(
            !rendered_text(&buffer).contains("stale room body sentinel"),
            "a populated-to-quiet redraw must not retain old content"
        );
    }

    #[test]
    fn controls_and_permission_answers_preserve_exact_backend_ids() {
        assert!(matches!(
            parse_room_command("/cancel codex"),
            Some(super::ParsedRoomCommand::Host(super::RoomCommand::Control { scope: Some(super::RoomCancelScope::Agent), agent: Some(agent), .. })) if agent == "codex"
        ));
        assert!(matches!(
            parse_room_command("/approve ask-17 option-4"),
            Some(super::ParsedRoomCommand::Host(super::RoomCommand::PermissionResponse(crate::room_permission_view::RoomPermissionAction::SelectOption { ask_id, option_id }))) if ask_id == "ask-17" && option_id == "option-4"
        ));
    }

    #[test]
    fn room_commands_separate_session_resume_scheduler_unpause_and_scoped_modes() {
        assert!(matches!(
            parse_room_command("/resume"),
            Some(super::ParsedRoomCommand::Sessions)
        ));
        assert!(matches!(
            parse_room_command("/continue"),
            Some(super::ParsedRoomCommand::Sessions)
        ));
        assert!(matches!(
            parse_room_command("/new"),
            Some(super::ParsedRoomCommand::NewSession)
        ));
        assert!(matches!(
            parse_room_command("/exit"),
            Some(super::ParsedRoomCommand::Exit)
        ));
        assert!(matches!(
            parse_room_command("/status"),
            Some(super::ParsedRoomCommand::Status)
        ));
        assert!(matches!(
            parse_room_command("/debate compare both designs"),
            Some(super::ParsedRoomCommand::DebateUnavailable)
        ));
        assert!(matches!(
            parse_room_command("/model"),
            Some(super::ParsedRoomCommand::Models(
                crate::room_composer_menu::RoomCatalogAgent::Claude
            ))
        ));
        assert!(matches!(
            parse_room_command("/models @codex"),
            Some(super::ParsedRoomCommand::Models(
                crate::room_composer_menu::RoomCatalogAgent::Codex
            ))
        ));
        assert!(matches!(
            parse_room_command("@gemini /skills"),
            Some(super::ParsedRoomCommand::Skills(
                crate::room_composer_menu::RoomCatalogAgent::Gemini
            ))
        ));
        assert!(matches!(
            parse_room_command("/unpause"),
            Some(super::ParsedRoomCommand::Host(
                super::RoomCommand::Control {
                    command: super::RoomControlCommand::Resume,
                    scope: None,
                    agent: None,
                }
            ))
        ));
        assert!(matches!(
            parse_room_command("/mode @codex"),
            Some(super::ParsedRoomCommand::Host(super::RoomCommand::CycleMode { composer_text }))
                if composer_text == "@codex"
        ));
        assert!(matches!(
            parse_room_command("/mode codex plan"),
            Some(super::ParsedRoomCommand::InvalidSlash)
        ));
        assert!(matches!(
            parse_room_command("/skills codex extra"),
            Some(super::ParsedRoomCommand::InvalidSlash)
        ));
        // Deliberately NOT a `Host(RoomCommand::Submit(..))` any more: the
        // command needs a submission id, and minting one queues the prompt
        // that a cancel would hand back. The parser cannot do either, so it
        // says only "this is a submission" and the caller does both (FL-126).
        assert!(matches!(
            parse_room_command("/council inspect the transport"),
            Some(super::ParsedRoomCommand::Submit)
        ));
        assert!(matches!(
            parse_room_command("/council"),
            Some(super::ParsedRoomCommand::InvalidSlash)
        ));
    }

    #[test]
    fn addressed_slashes_are_local_or_catalog_valid_and_never_leak_unknown_commands() {
        let catalog = crate::room_composer_menu::RoomCatalogSnapshot::from_host_value(&json!({
            "version": 1,
            "agents": {
                "claude": [{
                    "name": "lint", "description": "Provider lint", "kind": "custom",
                    "trusted": false
                }],
                "codex": [],
                "gemini": []
            }
        }))
        .expect("catalog fixture is valid");

        assert!(super::parse_room_command("@claude /lint src", &catalog).is_none());
        assert!(matches!(
            super::parse_room_command("@claude /bogus", &catalog),
            Some(super::ParsedRoomCommand::InvalidSlash)
        ));
        assert!(matches!(
            super::parse_room_command("@codex /skills extra", &catalog),
            Some(super::ParsedRoomCommand::InvalidSlash)
        ));
        assert!(super::parse_room_command("@claude use your lint skill: ", &catalog).is_none());
    }

    #[test]
    fn room_input_reader_drop_stops_and_joins_an_early_return_worker() {
        let alive = Arc::new(AtomicBool::new(true));
        let observed_stop = Arc::new(AtomicBool::new(false));
        let worker_alive = Arc::clone(&alive);
        let worker_observed_stop = Arc::clone(&observed_stop);
        let thread = std::thread::spawn(move || {
            while worker_alive.load(Ordering::Acquire) {
                std::thread::yield_now();
            }
            worker_observed_stop.store(true, Ordering::Release);
        });
        let reader = InputReader {
            alive: Arc::clone(&alive),
            thread: Some(thread),
        };
        drop(reader);
        assert!(!alive.load(Ordering::Acquire));
        assert!(observed_stop.load(Ordering::Acquire));
    }

    #[test]
    fn room_input_error_budget_tolerates_transients_then_surfaces_a_runtime_error() {
        let mut budget = InputErrorBudget::default();
        for _ in 0..MAX_CONSECUTIVE_INPUT_ERRORS - 1 {
            assert!(
                budget
                    .failure("poll", std::io::Error::other("temporary terminal fault"))
                    .is_none()
            );
        }
        let fatal = budget
            .failure("poll", std::io::Error::other("terminal is gone"))
            .expect("persistent polling failure reaches the room runtime");
        assert!(
            fatal
                .to_string()
                .contains("terminal input poll failed 50 consecutive times")
        );
    }

    #[test]
    fn room_input_error_budget_resets_after_a_successful_terminal_operation() {
        let mut budget = InputErrorBudget::default();
        for _ in 0..MAX_CONSECUTIVE_INPUT_ERRORS - 1 {
            assert!(
                budget
                    .failure("read", std::io::Error::other("transient"))
                    .is_none()
            );
        }
        budget.success();
        assert!(
            budget
                .failure("read", std::io::Error::other("new transient"))
                .is_none()
        );
    }

    #[test]
    fn room_emergency_terminal_restore_runs_during_unwind() {
        static RESTORED: AtomicBool = AtomicBool::new(false);
        fn record_restore(_: crate::terminal_lifecycle::ScreenMode) {
            RESTORED.store(true, Ordering::Release);
        }

        RESTORED.store(false, Ordering::Release);
        let unwind = std::panic::catch_unwind(|| {
            let _restore = EmergencyTerminalRestore {
                mode: crate::terminal_lifecycle::ScreenMode::Fullscreen,
                armed: true,
                restore: record_restore,
            };
            panic!("test-only unwind");
        });
        assert!(unwind.is_err());
        assert!(RESTORED.load(Ordering::Acquire));
    }

    #[test]
    fn room_raii_cleanup_clears_active_terminal_state_after_unwind() {
        let _lock = ROOM_STATE_TEST_LOCK.lock().expect("room state test lock");
        fn no_op_restore(_: crate::terminal_lifecycle::ScreenMode) {}

        super::deactivate_room_terminal();
        super::activate_room_terminal(crate::terminal_lifecycle::ScreenMode::Fullscreen)
            .expect("inactive test terminal state");
        let unwind = std::panic::catch_unwind(|| {
            let _restore = EmergencyTerminalRestore {
                mode: crate::terminal_lifecycle::ScreenMode::Fullscreen,
                armed: true,
                restore: no_op_restore,
            };
            panic!("test-only unwind");
        });
        assert!(unwind.is_err());
        assert!(super::active_room_screen_mode().is_none());
    }

    #[test]
    fn room_normal_cleanup_clears_active_terminal_state_only_after_restore_returns() {
        static RESTORED: AtomicBool = AtomicBool::new(false);
        fn record_restore(_: crate::terminal_lifecycle::ScreenMode) {
            RESTORED.store(true, Ordering::Release);
        }

        let _lock = ROOM_STATE_TEST_LOCK.lock().expect("room state test lock");
        super::deactivate_room_terminal();
        super::activate_room_terminal(crate::terminal_lifecycle::ScreenMode::Fullscreen)
            .expect("inactive test terminal state");
        RESTORED.store(false, Ordering::Release);
        let mut guard = EmergencyTerminalRestore {
            mode: crate::terminal_lifecycle::ScreenMode::Fullscreen,
            armed: true,
            restore: record_restore,
        };
        assert!(super::active_room_screen_mode().is_some());
        guard.disarm_after_restore();
        assert!(super::active_room_screen_mode().is_none());
        drop(guard);
        assert!(!RESTORED.load(Ordering::Acquire));
    }

    #[test]
    fn room_panic_hook_contract_covers_abort_profiles_and_full_lifecycle() {
        let source = include_str!("room_runtime.rs");
        let install_call = ["    install_room_", "panic_hook();"].concat();
        let arm_call = ["EmergencyTerminalRestore", "::arm(mode)"].concat();
        let init_call = ["init_terminal", "(mode, 4, false"].concat();
        let restore_call = ["let restored = restore_", "terminal("].concat();
        let restore_success_call = "if restored.is_ok() {";
        let disarm_call = ["emergency_restore.", "disarm_after_restore();"].concat();
        let register_call = [
            "emergency_restore.",
            "register_writer(writer_sync.clone())?;",
        ]
        .concat();
        let install = source
            .find(&install_call)
            .expect("room panic hook is installed");
        let arm = source
            .find(&arm_call)
            .expect("room terminal state is armed");
        let init = source.find(&init_call).expect("room terminal initializes");
        let register = source
            .find(&register_call)
            .expect("panic fence registers the active writer");
        let restore = source
            .find(&restore_call)
            .expect("room terminal restores normally");
        let restore_success = source
            .find(restore_success_call)
            .expect("room terminal disarms only after successful restoration");
        let disarm = source
            .find(&disarm_call)
            .expect("room terminal clears only after restore");
        assert!(
            install < arm
                && arm < register
                && register < init
                && restore < restore_success
                && restore_success < disarm
        );

        let chained_previous_hook = ["previous", "(info);"].concat();
        let hook_restore = ["restore_active_room_", "terminal(mode);"].concat();
        assert!(source.contains(&chained_previous_hook));
        assert!(source.contains(&hook_restore));
        assert!(source.contains("quiesce_active_room_writer();"));
        assert!(source.contains("writer.stop_accepting();"));
        assert!(source.contains("writer.wait_quiesced(Duration::from_secs(10))"));
        assert!(source.contains("ROOM_PANIC_HOOK_INSTALL.call_once"));
        assert!(source.contains("concurrent room terminals are unsupported"));

        let workspace = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../Cargo.toml"));
        for profile in ["[profile.dev]", "[profile.release]"] {
            let section = workspace
                .split(profile)
                .nth(1)
                .expect("workspace profile exists");
            assert!(
                section
                    .lines()
                    .take_while(|line| !line.trim_start().starts_with('['))
                    .any(|line| line.trim() == "panic = \"abort\""),
                "{profile} must use the abort-aware room panic hook"
            );
        }
    }

    #[cfg(feature = "room-test-support")]
    #[test]
    fn room_fixture_abort_trigger_requires_a_frame_to_remain_in_flight() {
        let source = include_str!("room_runtime.rs");
        let activation = source.find("EmergencyTerminalRestore::arm(mode)").unwrap();
        let initialized = source.find("init_terminal(mode, 4, false").unwrap();
        let first_draw = source
            .find("draw_room(terminal, &mut cursor, &mut room);")
            .expect("room submits its first pager frame");
        let trigger = source
            .find("ZER0_ROOM_TEST_ABORT_WITH_FRAME_IN_FLIGHT")
            .expect("fixture-only abort trigger is compiled");
        let in_flight = source
            .find("writer_sync.written() < sequence")
            .expect("fixture proves its submitted frame is still in flight");
        let abort = source
            .rfind("panic!(\"ZER0_ROOM_TEST_ABORT_WITH_FRAME_IN_FLIGHT requested\")")
            .expect("fixture aborts with accepted output still pending");
        assert!(activation < initialized && initialized < first_draw && first_draw < trigger);
        assert!(trigger < in_flight && in_flight < abort);
    }

    #[test]
    fn room_input_queue_is_bounded_and_close_releases_a_blocked_reader() {
        let (tx, mut rx) = room_input_channel();
        for _ in 0..ROOM_INPUT_QUEUE_CAPACITY {
            tx.try_send(RoomInput::Event(crossterm::event::Event::FocusGained))
                .expect("fill bounded input queue");
        }
        assert!(matches!(
            tx.try_send(RoomInput::Event(crossterm::event::Event::FocusGained)),
            Err(tokio::sync::mpsc::error::TrySendError::Full(_))
        ));

        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let blocked = std::thread::spawn(move || {
            let result = tx.blocking_send(RoomInput::Event(crossterm::event::Event::FocusGained));
            done_tx.send(result).expect("publish blocked send result");
        });
        assert!(matches!(
            done_rx.recv_timeout(Duration::from_millis(20)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));

        rx.close();
        assert!(
            done_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("closing the receiver wakes the blocked reader")
                .is_err()
        );
        blocked.join().expect("reader sender thread joins");
    }

    /// CQ-09: the OS refusing a thread is an error the room reports, not a
    /// crash that takes the process with it.
    ///
    /// The spawn seam exists for this one test and says so. Thread exhaustion
    /// is a real condition and there is no honest way to produce it on demand
    /// — the only route is to actually exhaust the box's thread table, which
    /// would take the other suites down with it and prove nothing about this
    /// code path. So the refusal is injected, in the same `fn`-pointer shape
    /// this file already uses for `EmergencyTerminalRestore::restore`.
    ///
    /// RED against `.expect("could not start pager input reader")`: with the
    /// panic restored this test aborts the harness instead of failing.
    #[test]
    fn a_refused_input_thread_is_returned_as_an_error_and_never_panics() {
        fn refuse(_: super::InputReaderLoop) -> std::io::Result<std::thread::JoinHandle<()>> {
            Err(std::io::Error::new(
                std::io::ErrorKind::OutOfMemory,
                "EAGAIN: could not create OS thread",
            ))
        }

        let error = super::spawn_input_reader_with(refuse)
            .err()
            .expect("a refused spawn is an error, not a panic");
        assert_eq!(error.kind(), std::io::ErrorKind::OutOfMemory);
        assert!(
            error.to_string().contains("could not create OS thread"),
            "the OS reason survives to the caller: {error}"
        );
    }

    /// The positive control for the test above, and the reason it is not
    /// merely asserting that a function which always fails fails.
    ///
    /// It also pins the thing the refusal test cannot see: the `Arc` handed to
    /// the thread and the one kept in the `InputReader` are the SAME flag.
    /// `stop` sets it and then JOINS, so a seam that cloned the wrong side
    /// hangs here rather than passing quietly. The body is a sleep loop, not
    /// the crossterm poll loop, because whether this box has a console is not
    /// what is under test.
    #[test]
    fn an_accepted_input_thread_yields_a_reader_whose_stop_actually_stops_it() {
        fn accept(reader: super::InputReaderLoop) -> std::io::Result<std::thread::JoinHandle<()>> {
            std::thread::Builder::new().spawn(move || {
                while reader.alive.load(Ordering::Acquire) {
                    std::thread::sleep(Duration::from_millis(1));
                }
            })
        }

        let (rx, reader) =
            super::spawn_input_reader_with(accept).expect("an accepted spawn yields a live reader");
        reader.stop();
        drop(rx);
    }

    #[test]
    fn composed_wide_and_narrow_layout_keep_feed_live_work_target_and_footer_truthful() {
        let mut quiet = RoomView::new();
        let quiet_area = Rect::new(0, 0, 120, 40);
        let mut quiet_buffer = Buffer::empty(quiet_area);
        let quiet_output = render_room(quiet_area, &mut quiet_buffer, &mut quiet);
        let quiet_text = rendered_text(&quiet_buffer);
        // Phase 6: the header is operator-visible, so it carries the product
        // name. Deliberate pin change -- it failed here on "zer0 · the room"
        // before the rename landed.
        assert!(quiet_text.contains("m0irai · the room"));
        assert!(quiet_text.contains("@claude, @codex, @gemini to route"));
        for fabricated in ["Alive Room", "shared room", "idle", "connecting", "0%"] {
            assert!(
                !quiet_text.contains(fabricated),
                "quiet boot contains {fabricated}"
            );
        }
        assert!(row_text(&quiet_buffer, quiet_area.bottom() - 2).contains("claude"));
        assert!(
            quiet_output
                .cursor_pos
                .is_some_and(|(_, y)| y < quiet_area.bottom() - 1)
        );

        let mut wide = seeded_room(false, false);
        let wide_area = Rect::new(0, 0, 120, 40);
        let mut wide_buffer = Buffer::empty(wide_area);
        render_room(wide_area, &mut wide_buffer, &mut wide);
        let wide_text = rendered_text(&wide_buffer);
        for label in ["claude", "codex", "gemini"] {
            assert!(wide_text.contains(label), "wide layout loses {label}");
        }
        assert!(wide_buffer.content.iter().any(|cell| {
            cell.fg == Color::Rgb(245, 165, 36) && cell.symbol() == crate::glyphs::accent_bar()
        }));
        assert!(wide_buffer.content.iter().any(|cell| {
            cell.fg == Color::Rgb(45, 212, 191) && cell.symbol() == crate::glyphs::accent_bar()
        }));
        assert!(wide_buffer.content.iter().any(|cell| {
            cell.fg == Color::Rgb(199, 125, 255) && cell.symbol() == crate::glyphs::accent_bar()
        }));

        // FL-071: every seeded lane has streamed a body, so none of them keeps an
        // inline spinner and the frame is identical across ticks. The idle-redraw
        // budget depends on this: a spinner nobody needs is a wakeup nobody asked for.
        let mut delivered_first_frame = Buffer::empty(wide_area);
        wide.render_tick = 0;
        wide.scrollback
            .refresh_live_status(&wide.reducer, wide.render_tick);
        render_room(wide_area, &mut delivered_first_frame, &mut wide);
        let mut delivered_later_frame = Buffer::empty(wide_area);
        wide.render_tick = 1;
        wide.scrollback
            .refresh_live_status(&wide.reducer, wide.render_tick);
        render_room(wide_area, &mut delivered_later_frame, &mut wide);
        assert_eq!(
            rendered_text(&delivered_first_frame),
            rendered_text(&delivered_later_frame),
            "FL-071: a delivered answer leaves no spinner to advance"
        );

        // Waiting work still animates on the same tick step: a lane that has
        // started and delivered nothing is exactly what the animation is for.
        let mut waiting = RoomView::new();
        for next in [
            event(
                1,
                "turn.accepted",
                json!({"agents":["claude"],"text":"inspect the room","messageId":"operator-1","ledgerSeq":"1"}),
            ),
            event(2, "route.resolved", json!({"agents":["claude"]})),
            event(
                3,
                "lane.queued",
                json!({"laneId":"lane-claude","agent":"claude","expectedMessageId":"message-claude","origin":"operator","hopIndex":0}),
            ),
            event(
                4,
                "lane.started",
                json!({"laneId":"lane-claude","streamId":"stream-claude","agent":"claude"}),
            ),
        ] {
            apply(&mut waiting, next);
        }
        let mut working_first_frame = Buffer::empty(wide_area);
        waiting.render_tick = 0;
        waiting
            .scrollback
            .refresh_live_status(&waiting.reducer, waiting.render_tick);
        render_room(wide_area, &mut working_first_frame, &mut waiting);
        let mut working_later_frame = Buffer::empty(wide_area);
        waiting.render_tick = 1;
        waiting
            .scrollback
            .refresh_live_status(&waiting.reducer, waiting.render_tick);
        render_room(wide_area, &mut working_later_frame, &mut waiting);
        assert_ne!(
            rendered_text(&working_first_frame),
            rendered_text(&working_later_frame),
            "only reducer-running work may advance the inline spinner"
        );

        let mut narrow = seeded_room(false, false);
        let narrow_area = Rect::new(0, 0, 80, 24);
        let mut narrow_buffer = Buffer::empty(narrow_area);
        render_room(narrow_area, &mut narrow_buffer, &mut narrow);
        let narrow_text = rendered_text(&narrow_buffer);
        let narrow_feed_text = (0..narrow_area.bottom() - 1)
            .map(|y| row_text(&narrow_buffer, y))
            .collect::<String>();
        assert!(!narrow_text.contains("+2 working"));
        for identity in ["claude", "codex", "gemini"] {
            assert!(
                narrow_feed_text.contains(identity),
                "narrow feed loses {identity}"
            );
        }
    }

    #[test]
    fn quiet_composer_keeps_the_edit_surface_empty_and_places_guidance_below_it() {
        let mut room = RoomView::new();
        let area = Rect::new(0, 0, 120, 40);
        let mut buffer = Buffer::empty(area);
        render_room(area, &mut buffer, &mut room);
        let rows = (0..area.height)
            .map(|y| row_text(&buffer, y))
            .collect::<Vec<_>>();
        let top = rows
            .iter()
            .position(|row| row.contains('╭'))
            .expect("composer top border");
        let bottom = rows
            .iter()
            .enumerate()
            .skip(top + 1)
            .find_map(|(index, row)| row.contains('╰').then_some(index))
            .expect("composer bottom border");
        let guidance = rows
            .iter()
            .position(|row| row.contains("@claude, @codex, @gemini to route"))
            .expect("quiet guidance");
        assert!(
            guidance > bottom,
            "guidance is supporting chrome below the input, not placeholder content: {rows:#?}"
        );
        assert!(
            rows[top + 1..bottom]
                .iter()
                .all(|row| !row.contains("@claude, @codex, @gemini to route"))
        );
    }

    /// Slice A site 6 [FALSIFIER] — ZERO READY AGENTS PAINT THE WAY IN, AND THE ROOM STILL OPENS.
    ///
    /// ⚠ TWO OPERATOR QUESTIONS ARE UNRULED HERE AND THIS TEST IS BUILT TO THE RECOMMENDED ANSWER OF
    /// EACH. §14 Q2 (placement) is built as (a), BELOW the card's border, so the 45×18 hero geometry
    /// and the minimum-window pin are untouched. §14 Q3 (content) is built as (a), all three ways in,
    /// so an operator with a Codex subscription and no Claude one is not told to buy the wrong thing.
    /// If either is ruled the other way, this test's assertions are where that shows up.
    #[test]
    fn zero_ready_agents_paint_the_way_in_and_the_room_still_opens() {
        let mut room = RoomView::new();
        room.readiness = RoomReadinessSnapshot {
            claude: RoomAgentReadiness::NeedsLogin {
                command: "claude auth login".to_owned(),
            },
            codex: RoomAgentReadiness::NeedsLogin {
                command: "codex login".to_owned(),
            },
            gemini: RoomAgentReadiness::Unusable {
                reason: "the Antigravity CLI is not installed".to_owned(),
                remedy: "install the Antigravity CLI".to_owned(),
            },
        };
        let frame = render_room_frame(&mut room, 100, 40);

        for command in [
            "claude auth login",
            "codex login",
            "install the Antigravity CLI",
        ] {
            assert!(
                frame.contains(command),
                "{command:?} is not on the boot screen"
            );
        }
        // m0irai has no login, ever. Someone reading three sign-in commands is exactly the person who
        // might conclude otherwise.
        assert!(
            frame.contains("m0irai itself needs no account."),
            "{frame:?}"
        );
        // AND THE ROOM STILL OPENS. An operator with no agents can still read /help and quit, so the
        // composer has to be there — an onboarding screen that swallowed the room would be a second
        // screen, which is the thing this is deliberately not.
        assert!(
            frame.contains("m0irai · the room"),
            "the room chrome vanished behind the onboarding text"
        );
    }

    /// The remedy lines go UNDER the card, never through it, and the reassurance line is the first
    /// casualty when the band is short.
    ///
    /// ⚠ THE OVERLAP WAS REAL AND A RENDERED FRAME IS WHAT CAUGHT IT. The first version anchored the
    /// lines to the bottom of the BAND; the card is CENTRED in that band, so on a short terminal the
    /// remedies painted straight over its closing border. Reading the code did not show it.
    ///
    /// ⚠ AND IT USED TO PANIC ON A LEGACY CONSOLE (sealed-lanes #4). It hard-coded `╰` and `╯`, which
    /// the card draws only where the console can render them; under `GROK_FORCE_LEGACY_CONSOLE=1` its
    /// corners are `+`, and the first line carrying both ROUNDED corners is the composer's box far
    /// below — `closing` came back 36 against a first remedy at 21, and the test read that as the
    /// remedies painting through the card. The corners now resolve through the same `room_secondary`
    /// seam the card draws through, and the search starts at the card's own tagline, because in a
    /// console where every corner is `+` the card's TOP border answers the glyph test just as well
    /// and only position tells the two apart.
    #[test]
    fn the_remedy_lines_sit_under_the_card_and_never_through_it() {
        // BOTH COLUMNS OF THE TABLE, so the legacy path is proved on every run of this test rather
        // than only on the one `verify-rust.mjs` re-executes with the variable set.
        for (glyph, modern, legacy) in [
            (RoomSecondaryGlyph::BorderBottomLeft, "╰", "+"),
            (RoomSecondaryGlyph::BorderBottomRight, "╯", "+"),
        ] {
            assert_eq!(room_secondary_for(glyph, false), modern);
            assert_eq!(room_secondary_for(glyph, true), legacy);
        }
        let bottom_left = room_secondary(RoomSecondaryGlyph::BorderBottomLeft);
        let bottom_right = room_secondary(RoomSecondaryGlyph::BorderBottomRight);
        let card_closing_border = |frame: &str| -> Option<usize> {
            let tagline = frame
                .lines()
                .position(|line| line.contains("three minds · one thread"))?;
            frame
                .lines()
                .skip(tagline)
                .position(|line| line.contains(bottom_left) && line.contains(bottom_right))
                .map(|offset| tagline + offset)
        };

        let mut room = RoomView::new();
        room.readiness = RoomReadinessSnapshot {
            claude: RoomAgentReadiness::NeedsLogin {
                command: "claude auth login".to_owned(),
            },
            codex: RoomAgentReadiness::NeedsLogin {
                command: "codex login".to_owned(),
            },
            gemini: RoomAgentReadiness::Unusable {
                reason: "not installed".to_owned(),
                remedy: "install the Antigravity CLI".to_owned(),
            },
        };

        // Tall enough for everything: the card is whole and all four lines are present.
        let roomy = render_room_frame(&mut room, 100, 40);
        let closing =
            card_closing_border(&roomy).expect("the card's closing border is on screen: {roomy}");
        let first_remedy = roomy
            .lines()
            .position(|line| line.contains("claude auth login"))
            .expect("the first remedy is on screen");
        assert!(
            closing < first_remedy,
            "the remedies are above the card's closing border: closing={closing} \
             first_remedy={first_remedy}"
        );
        assert!(roomy.contains("m0irai itself needs no account."));

        // Short enough that not everything fits. The card stays WHOLE and the reassurance sentence is
        // what goes — never a command.
        //
        // ⚠ THE CRAMPED HEIGHT IS SEARCHED, NOT HARD-CODED, and that is a MEASURED console
        // difference rather than caution. This used to say 30, which is cramped on a modern console
        // and roomy on a legacy one: the legacy card suppresses the braille mark, so it is far
        // shorter and the band still has room for the sentence at 30. Measured 2026-09-02 across
        // heights 20..=34 with all three agents unready — the sentence is dropped while every
        // command survives at 26..=31 modern and at 20..=21 legacy. Pinning one number pins one
        // console; the contract is the ORDERING, so the test finds a height where the sentence has
        // gone and then asks what survived it.
        let mut cramped_room = RoomView::new();
        cramped_room.readiness = room.readiness.clone();
        let commands = [
            "claude auth login",
            "codex login",
            "install the Antigravity CLI",
        ];
        let frame_at = |height: u16| -> String {
            let mut probe = RoomView::new();
            probe.readiness = room.readiness.clone();
            render_room_frame(&mut probe, 100, height)
        };
        // THE ORDERING ITSELF, over the whole range rather than at one chosen height: if the
        // sentence is still on screen then every command is too. That is what "the sentence is the
        // first casualty, never a command" means, and it is the assertion a height-specific test
        // could only sample. It is also the one that survives a console whose card is a different
        // size.
        for height in 20_u16..=40 {
            let frame = frame_at(height);
            if frame.contains("needs no account") {
                for command in commands {
                    assert!(
                        frame.contains(command),
                        "height {height}: {command:?} went before the reassurance sentence"
                    );
                }
            }
        }
        // And the sentence really is dropped first, rather than everything going at once: some
        // height keeps all three commands with the sentence already gone.
        let cramped_height = (20_u16..=40)
            .find(|height| {
                let frame = frame_at(*height);
                !frame.contains("needs no account")
                    && commands.iter().all(|command| frame.contains(command))
            })
            .expect("some height drops the reassurance sentence while every command survives");
        let cramped = render_room_frame(&mut cramped_room, 100, cramped_height);
        assert!(
            card_closing_border(&cramped).is_some(),
            "the card lost its closing border at height {cramped_height}: {cramped}"
        );
        for command in commands {
            assert!(
                cramped.contains(command),
                "{command:?} was dropped before the sentence at height {cramped_height}"
            );
        }
        assert!(!cramped.contains("needs no account"));
    }

    /// ABSENT RENDERS ABSENT, at the boot card. A room whose probe has not landed — or whose agents are
    /// all fine — shows the screen it showed before any probe existed. This is the control for the
    /// site above: without it, a remedy surface that rendered unconditionally would pass that one.
    #[test]
    fn a_room_with_nothing_wrong_shows_no_remedy_lines() {
        let mut unprobed = RoomView::new();
        let before = render_room_frame(&mut unprobed, 100, 40);

        let mut all_ready = RoomView::new();
        all_ready.readiness = RoomReadinessSnapshot {
            claude: RoomAgentReadiness::Ready,
            codex: RoomAgentReadiness::Ready,
            gemini: RoomAgentReadiness::Ready,
        };
        let ready_frame = render_room_frame(&mut all_ready, 100, 40);

        assert!(
            !before.contains("needs a sign-in"),
            "an unprobed room offered a remedy"
        );
        assert!(!before.contains("needs no account"));
        // Byte-for-byte the same screen. `Unknown` renders exactly as `Ready` is the law this makes
        // structural rather than aspirational.
        assert_eq!(
            before, ready_frame,
            "an unprobed room and an all-ready room render differently"
        );
    }

    /// Slice A site 7 — READINESS ARRIVES WITHOUT DELAYING THE FIRST FRAME.
    ///
    /// This is the test that would have caught the design where readiness was a field on
    /// `RoomRuntimeInput`: that struct is passed by value into `run_room` and fixed for the room's
    /// lifetime, so putting readiness there forces either awaiting a subprocess before the first frame
    /// or seeding `Unknown` with no way to ever update it.
    #[test]
    fn readiness_arrives_without_delaying_the_first_frame() {
        let mut room = RoomView::new();
        // FRAME 1, with no readiness update delivered. This is what the operator sees while a probe is
        // still running, and it must be the frame they saw before any probe existed.
        let first = row_text(&footer_buffer(&room, 180, 1_000), 0);
        assert!(first.contains("gemini"));
        assert!(
            !first.contains("unavailable"),
            "an unprobed room claimed an agent was broken"
        );
        assert!(!first.contains("sign in"));

        // The update lands on the channel a RUNNING room already consumes.
        room.readiness = RoomReadinessSnapshot {
            claude: RoomAgentReadiness::NeedsLogin {
                command: "claude auth login".to_owned(),
            },
            codex: RoomAgentReadiness::Ready,
            gemini: RoomAgentReadiness::Unusable {
                reason: "the Antigravity CLI is not installed".to_owned(),
                remedy: "install the Antigravity CLI".to_owned(),
            },
        };
        let second = row_text(&footer_buffer(&room, 180, 1_000), 0);
        assert!(second.contains("claude sign in"), "{second:?}");
        assert!(second.contains("gemini unavailable"), "{second:?}");
        assert_eq!(
            second.width(),
            180,
            "the footer is still one fixed-width row"
        );
    }

    /// Slice A site 8 [PIN] — AN UNPROBEABLE AGENT RENDERS EXACTLY AS READY.
    ///
    /// Not "similarly": the spans are compared for equality, content and style. `Unknown` is the state
    /// a room starts in and the state a malformed response falls back to, so if it ever rendered
    /// anything at all, every room would open saying something about three agents it had not measured.
    /// Mutation obligation: give `Unknown` a suffix in readiness_suffix and quote the failure.
    #[test]
    fn an_unprobeable_agent_renders_exactly_as_ready() {
        let mut unknown = RoomView::new();
        unknown.readiness = RoomReadinessSnapshot::default();
        let mut ready = RoomView::new();
        ready.readiness = RoomReadinessSnapshot {
            claude: RoomAgentReadiness::Ready,
            codex: RoomAgentReadiness::Ready,
            gemini: RoomAgentReadiness::Ready,
        };

        let unknown_cell = footer_agent_cell(&unknown, "claude", RoomIdentity::Claude, 40, 1_000);
        let ready_cell = footer_agent_cell(&ready, "claude", RoomIdentity::Claude, 40, 1_000);

        assert_eq!(unknown_cell.width, ready_cell.width);
        assert_eq!(
            unknown_cell
                .spans
                .iter()
                .map(|span| span.content.to_string())
                .collect::<Vec<_>>(),
            ready_cell
                .spans
                .iter()
                .map(|span| span.content.to_string())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            unknown_cell
                .spans
                .iter()
                .map(|span| span.style)
                .collect::<Vec<_>>(),
            ready_cell
                .spans
                .iter()
                .map(|span| span.style)
                .collect::<Vec<_>>(),
            "unknown and ready differ in STYLE, which the operator can see"
        );
    }

    /// Slice A site 9 [PIN] — A LIVE LANE OUTRANKS A STALE BOOT SAMPLE.
    ///
    /// Readiness is sampled once, at boot. An operator who signs in while the room is open is not
    /// noticed until the next send succeeds — and when it does, the chip must stop saying "sign in".
    /// Mutation obligation: invert the precedence in readiness_suffix and quote the failure.
    #[test]
    fn a_live_lane_outranks_a_stale_boot_sample() {
        let mut room = RoomView::new();
        room.readiness = RoomReadinessSnapshot {
            claude: RoomAgentReadiness::NeedsLogin {
                command: "claude auth login".to_owned(),
            },
            ..RoomReadinessSnapshot::default()
        };
        apply(
            &mut room,
            event(1, "agent.status", json!({"agent":"claude","auth":"ready"})),
        );

        let row = row_text(&footer_buffer(&room, 180, 1_000), 0);
        assert!(
            !row.contains("sign in"),
            "a stale boot sample beat a live ready lane: {row:?}"
        );
        // And the chip is NOT dimmed by row 3 either: the colour and the word are one ladder, and a
        // chip that reads normally while rendering at faint is this rule half-applied.
        let cell = footer_agent_cell(&room, "claude", RoomIdentity::Claude, 40, 1_000);
        assert_eq!(
            cell.spans[0].style.fg,
            Some(RoomIdentity::Claude.rest_color())
        );
    }

    /// A.10.5 site 2 [FALSIFIER] — AN UNAVAILABLE AGENT NEVER LIGHTS UP.
    ///
    /// ⚠ THE TWO HALVES ARE NOT EQUALLY REACHABLE AND THIS COMMENT SAYS WHICH IS WHICH. The
    /// `needs_login` half is PRODUCTION-REACHABLE and is why this site exists: the §14 Q8 ruling
    /// dispatches such an agent through `@all`, so it genuinely holds a Running lane until it fails,
    /// and the old ladder lit it at full brand luminance — the room asserting an agent is working when
    /// it is not signed in. The `unusable` half is an INVARIANT, not a scenario: §A.9's routing means
    /// an unusable agent should never be given a lane at all, so that combination is constructed
    /// directly against footer_agent_cell rather than driven through the reducer. It is worth
    /// asserting anyway — it is the guard that survives a future routing change — but dressing it up
    /// as a scenario it cannot currently be would be the same class of lie pointed the other way.
    #[test]
    fn an_unavailable_agent_never_lights_up() {
        let mut room = RoomView::new();
        room.readiness = RoomReadinessSnapshot {
            claude: RoomAgentReadiness::NeedsLogin {
                command: "claude auth login".to_owned(),
            },
            codex: RoomAgentReadiness::Ready,
            gemini: RoomAgentReadiness::Unusable {
                reason: "not installed".to_owned(),
                remedy: "install the Antigravity CLI".to_owned(),
            },
        };
        // A REAL running lane for each, through the reducer's own admission path: a lane must be
        // ACCEPTED and QUEUED before it can start, and building the state any other way would be
        // asserting against a projection the room cannot actually reach.
        let agents = ["claude", "codex", "gemini"];
        apply(
            &mut room,
            event(
                1,
                "turn.accepted",
                json!({"agents":agents,"text":"inspect","messageId":"operator-1","ledgerSeq":"1"}),
            ),
        );
        apply(
            &mut room,
            event(2, "route.resolved", json!({ "agents": agents })),
        );
        let mut sequence = 2_u64;
        for agent in agents {
            sequence += 1;
            apply(
                &mut room,
                event(
                    sequence,
                    "lane.queued",
                    json!({
                        "laneId": format!("lane-{agent}"),
                        "agent": agent,
                        "expectedMessageId": format!("message-{agent}"),
                        "origin": "operator",
                        "hopIndex": 0
                    }),
                ),
            );
            sequence += 1;
            apply(
                &mut room,
                event(
                    sequence,
                    "lane.started",
                    json!({
                        "laneId": format!("lane-{agent}"),
                        "streamId": format!("stream-{agent}"),
                        "agent": agent
                    }),
                ),
            );
        }
        for agent in agents {
            assert!(
                lane_busy(&room.reducer, Some(agent)),
                "the fixture must really hold a running lane for {agent}"
            );
        }

        for (agent, identity) in [
            ("claude", RoomIdentity::Claude),
            ("gemini", RoomIdentity::Gemini),
        ] {
            let cell = footer_agent_cell(&room, agent, identity, 40, 1_000);
            assert_ne!(
                cell.spans[0].style.fg,
                Some(identity.color()),
                "{agent} reached ACTIVE luminance while it cannot work"
            );
            assert_eq!(cell.spans[0].style.fg, Some(RoomTheme::current().faint));
        }
        // The positive control in the SAME frame: codex is ready and running, and it DOES light. A
        // ladder that dimmed everything would pass the two assertions above and be wrong.
        let codex = footer_agent_cell(&room, "codex", RoomIdentity::Codex, 40, 1_000);
        assert_eq!(codex.spans[0].style.fg, Some(RoomIdentity::Codex.color()));
    }

    /// F4 / FL-095 — WIDTH 80, THE NARROWEST CELL, AND THE ONE THE FOOTER TESTS NEVER COVERED.
    ///
    /// Captured before the fix, from this exact fixture:
    ///
    /// ```text
    /// "◆ claude                   ● codex                    ▲ gemini ctx42% 5h71% wk8…"
    /// ```
    ///
    /// `wk8…` is an 81% weekly cut mid-number: a WRONG reading wearing a truncation mark, which is a
    /// different and worse thing than a missing one. The narrowest footer test in this file was width
    /// 100, where every cell has room, so 80 columns went untested.
    ///
    /// ⚠ THE FIXTURE IS GEMINI FOR A MEASURED REASON, and a claude fixture would pass vacuously. At
    /// width 80 the cells are 27/27/26 and the marks are 8/7/8 columns, so the suffix budgets are
    /// 19/20/18. claude's dense row is exactly 19 and fits with nothing to cut; gemini's 18-column
    /// budget is the only one that forces the decision.
    #[test]
    fn width_80_drops_a_weekly_whole_rather_than_cutting_its_number() {
        let future = 4_102_444_800_000_u64;
        let mut room = RoomView::new();
        for agent in ["claude", "gemini"] {
            apply(
                &mut room,
                event(
                    if agent == "claude" { 1 } else { 2 },
                    "agent.status",
                    json!({
                        "agent":agent,
                        "auth":"ready",
                        "usage":{
                            "exhausted":false,
                            "contextUsedPct":42,
                            "fiveHourUsedPct":71,
                            "fiveHourResetsAtMs":future,
                            "weeklyUsedPct":81,
                            "weeklyResetsAtMs":future
                        }
                    }),
                ),
            );
        }

        let row = row_text(&footer_buffer(&room, 80, 1_000), 0);
        let ellipsis = room_secondary(RoomSecondaryGlyph::Ellipsis);
        assert!(
            !row.contains(&format!("wk8{ellipsis}")),
            "an 81% weekly is being cut mid-number: {row:?}"
        );
        // No cut number of any kind: every percentage in the row is followed by its own `%`.
        assert!(
            !row.contains(&format!("8{ellipsis}")) && !row.contains(&format!("4{ellipsis}")),
            "a reading was cut mid-number: {row:?}"
        );
        // claude fits whole at 19 columns; gemini drops its weekly whole and says so.
        assert!(
            row.contains("ctx42% 5h71% wk81%"),
            "claude's cell fits and must be intact"
        );
        assert!(
            row.contains(&format!("ctx42% 5h71%{ellipsis}")),
            "gemini must drop the weekly WHOLE and mark it hidden: {row:?}"
        );
        assert_eq!(row.width(), 80, "footer is one fixed-width row");
    }

    /// FL-127 [FALSIFIER]. THE STRUCTURAL DEFECT: one colour for the WHOLE ROW. Before this fix,
    /// `usage_suffix` returned a single `(String, Color)`, and one `any(pct >= 90)` check picked ONE
    /// colour for every meter on the cell — captured live: claude's `ctx 4%` rendered yellow beside its
    /// own `wk 92%`, because the row's single `warning` flag could not tell them apart. Revert the fix
    /// (`warning = exhausted || meters.iter().any(|m| m.pct >= 90)`, `theme.warning`/`theme.dim`) and
    /// this goes RED: ctx and wk collapse onto the SAME colour, and the `assert_ne!` below fails.
    #[test]
    fn two_meters_on_one_row_render_different_colours_by_their_own_value() {
        let future = 4_102_444_800_000_u64;
        let mut room = RoomView::new();
        apply(
            &mut room,
            event(
                1,
                "agent.status",
                json!({
                    "agent":"claude",
                    "auth":"ready",
                    "usage":{
                        "exhausted":false,
                        "contextUsedPct":4,
                        "fiveHourUsedPct":40,
                        "fiveHourResetsAtMs":future,
                        "weeklyUsedPct":92,
                        "weeklyResetsAtMs":future
                    }
                }),
            ),
        );
        let theme = RoomTheme::current();
        let cell = footer_agent_cell(&room, "claude", RoomIdentity::Claude, 72, 1_000);
        let colour_of = |needle: &str| -> Option<Color> {
            cell.spans
                .iter()
                .find(|span| span.content.contains(needle))
                .unwrap_or_else(|| {
                    panic!(
                        "no span contains {needle:?}: {:?}",
                        cell.spans
                            .iter()
                            .map(|span| span.content.to_string())
                            .collect::<Vec<_>>()
                    )
                })
                .style
                .fg
        };
        let ctx_color = colour_of("ctx 4%");
        let five_hour_color = colour_of("5h 40%");
        let weekly_color = colour_of("wk 92%");
        assert_eq!(ctx_color, Some(theme.dim), "4% context must render GRAY");
        assert_eq!(
            five_hour_color,
            Some(theme.dim),
            "40% five-hour must render GRAY"
        );
        assert_eq!(
            weekly_color,
            Some(theme.dead),
            "92% weekly must render RED, not the row's colour"
        );
        assert_ne!(
            ctx_color, weekly_color,
            "two meters on the SAME row wore the SAME colour — the structural defect FL-127 names"
        );
    }

    /// FL-127 boundary table for [`meter_color`], asserted rather than reasoned about — the same
    /// discipline `fitting_drops_whole_meters_and_never_half_a_number` (room_usage_meters.rs) uses for
    /// the same reason: a boundary table that is REASONED about is a table that inherits its author's
    /// arithmetic mistakes instead of catching them.
    #[test]
    fn meter_colour_ramp_matches_the_operators_ruling() {
        let theme = RoomTheme::current();
        for (pct, expected, label) in [
            (0, theme.dim, "0% is gray"),
            (69, theme.dim, "69% is still gray"),
            (70, theme.warning, "70% crosses into yellow"),
            (84, theme.warning, "84% is still yellow"),
            (85, theme.dead, "85% crosses into red"),
            (100, theme.dead, "100% is red"),
        ] {
            assert_eq!(meter_color(pct, false, &theme), expected, "{label}");
        }
        // `exhausted` forces red at ANY pct, including a 0% that would otherwise be plainly gray — the
        // account cannot be used right now, and the row says so regardless of what one meter reads.
        assert_eq!(
            meter_color(0, true, &theme),
            theme.dead,
            "exhausted forces red even at 0%"
        );
    }

    /// F3a at the render, and the same rule through `/status` (Seam 3): both surfaces are
    /// `footer_agent_cell`, so a policy that lived in only one of them would drift the moment either
    /// changed. Captured before the fix, at width 180:
    /// `▲ gemini ◕ ctx 42%  ▰▰▰▰▱ 5h 71%  wk 1%`
    #[test]
    fn a_low_weekly_is_hidden_in_the_footer_and_in_status_alike() {
        let future = 4_102_444_800_000_u64;
        let mut room = RoomView::new();
        apply(
            &mut room,
            event(
                1,
                "agent.status",
                json!({
                    "agent":"gemini",
                    "auth":"ready",
                    "usage":{
                        "exhausted":false,
                        "contextUsedPct":42,
                        "fiveHourUsedPct":71,
                        "fiveHourResetsAtMs":future,
                        "weeklyUsedPct":1,
                        "weeklyResetsAtMs":future
                    }
                }),
            ),
        );
        // codex has no five-hour window at all — the shape OpenAI actually ships — so its weekly shows
        // unconditionally, at 0%. Asserted in the SAME room as the hidden one: a predicate that simply
        // suppressed every low weekly would pass the first assertion and fail this one.
        apply(
            &mut room,
            event(
                2,
                "agent.status",
                json!({
                    "agent":"codex",
                    "auth":"ready",
                    "usage":{"exhausted":false,"contextUsedPct":9,"weeklyUsedPct":0,"weeklyResetsAtMs":future}
                }),
            ),
        );

        let row = row_text(&footer_buffer(&room, 180, 1_000), 0);
        assert!(
            row.contains("5h 71%"),
            "gemini's five-hour reading is real and shows"
        );
        assert!(
            !row.contains("wk 1%"),
            "a 1% weekly beside a live 5h is not worth the column: {row:?}"
        );
        assert!(
            row.contains("wk 0%"),
            "codex has no 5h, so its only meter shows even at zero: {row:?}"
        );

        let status = room_status_summary_at(&room, 1_000);
        assert!(status.contains("5h 71%"));
        assert!(
            !status.contains("wk 1%"),
            "/status kept a meter the footer hides: {status:?}"
        );
        assert!(
            status.contains("wk 0%"),
            "/status dropped codex's only meter: {status:?}"
        );
    }

    #[test]
    fn footer_uses_only_real_usage_folds_at_100_and_expires_stale_windows() {
        let future = 4_102_444_800_000_u64;
        let mut room = RoomView::new();
        apply(
            &mut room,
            event(
                1,
                "agent.status",
                json!({
                    "agent":"claude",
                    "auth":"ready",
                    "usage":{
                        "exhausted":false,
                        "contextUsedPct":42,
                        "fiveHourUsedPct":71,
                        "fiveHourResetsAtMs":future,
                        "weeklyUsedPct":81,
                        "weeklyResetsAtMs":future
                    }
                }),
            ),
        );
        apply(
            &mut room,
            event(2, "agent.status", json!({"agent":"gemini","auth":"down"})),
        );

        let wide = footer_buffer(&room, 180, 1_000);
        let wide_row = row_text(&wide, 0);
        assert!(wide_row.contains("claude"));
        let context = room_secondary(RoomSecondaryGlyph::Context);
        assert!(wide_row.contains(&format!("{context} ctx 42%")));
        assert!(wide_row.contains("5h 71%"));
        assert!(wide_row.contains("wk 81%"));
        assert!(wide_row.contains("codex"));
        assert!(
            !wide_row.contains("codex auto"),
            "a mode label must come from a real agent.mode event"
        );
        // `auth: down` is a DEAD WIRE, still the `offline` class — but under the operator's 2026-08-22
        // ruling the word moved off the chip onto the footer's state row, and the NAME went red.
        assert!(wide_row.contains("gemini"));
        assert!(
            !wide_row.contains("gemini offline"),
            "the health word is on the chip AND the row: {wide_row:?}"
        );
        assert!(row_text(&wide, 1).contains("offline"));
        assert_eq!(wide_row.width(), 180, "footer is one fixed-width row");
        assert!(
            wide.content
                .iter()
                .any(|cell| { cell.symbol() == "o" && cell.fg == Color::Rgb(255, 92, 92) })
        );

        let narrow = footer_buffer(&room, 100, 1_000);
        let narrow_row = row_text(&narrow, 0);
        for identity in ["claude", "codex", "gemini"] {
            assert!(narrow_row.contains(identity));
        }
        assert!(narrow_row.contains("ctx42% 5h71% wk81%"));
        assert_eq!(narrow_row.width(), 100);
        // Phase 6: same rename, session metadata line — read as the LAST row rather than row 1. The
        // footer's height is no longer fixed: gemini is `auth: down` in this room, so the state row
        // sits between the roster and the metadata (footer_state_row). A hard-coded index here was
        // reading `offline` and calling it the session line.
        assert_eq!(
            row_text(&narrow, narrow.area.height.saturating_sub(1)).trim_end(),
            "m0irai · #room"
        );

        let expired = footer_buffer(&room, 180, future + 1);
        let expired_row = row_text(&expired, 0);
        assert!(
            expired_row.contains(&format!("{context} ctx 42%")),
            "context is not a reset window"
        );
        assert!(!expired_row.contains("71%"));
        assert!(!expired_row.contains("wk 81%"));
        assert!(!expired_row.contains("0%"));
    }

    /// The fg of the first cell of `word` on row `y`, or None when the row does not spell it. The
    /// index into the symbol run IS the column, because the run is built by walking x from 0.
    fn word_fg(buffer: &Buffer, y: u16, word: &str) -> Option<ratatui::style::Color> {
        let symbols = (0..buffer.area.width)
            .filter_map(|x| buffer.cell((x, y)))
            .map(|cell| cell.symbol().to_owned())
            .collect::<Vec<_>>();
        let target = word.chars().map(|c| c.to_string()).collect::<Vec<_>>();
        symbols
            .windows(target.len())
            .position(|window| window == target.as_slice())
            .and_then(|index| buffer.cell((index as u16, y)))
            .map(|cell| cell.fg)
    }

    /// THE OPERATOR'S RULING, 2026-08-22, verbatim: "with red and under it out of usage".
    ///
    /// Two facts in one frame, because either alone is the bug. RED alone is the room saying
    /// "something is wrong with codex" and making the operator guess which of three things; the WORD
    /// alone is a sentence in a footer that still looks healthy. On `ad2dde9` neither holds: an
    /// `exhausted` availability rendered a YELLOW ` limited` suffix, because `agent_is_offline` never
    /// included `Exhausted` and `status_is_limited` did.
    #[test]
    fn an_out_of_usage_agent_paints_red_and_says_so_on_its_own_row() {
        let mut room = RoomView::new();
        apply(
            &mut room,
            event(
                1,
                "agent.status",
                json!({
                    "agent":"codex",
                    "availability":{"state":"exhausted","resetsAtMs":9_000}
                }),
            ),
        );

        let footer = footer_buffer(&room, 120, 1_000);
        let chips = row_text(&footer, 0);
        let states = row_text(&footer, 1);

        assert!(
            chips.contains("codex"),
            "the roster lost its codex chip: {chips:?}"
        );
        assert!(
            states.contains("out of usage"),
            "an agent out of usage must say so under its own chip: {states:?}"
        );
        assert_eq!(
            word_fg(&footer, 0, "codex"),
            Some(RoomTheme::current().dead),
            "the operator ruled RED for this class and the name is not painted red: {chips:?}"
        );
        // `offline` is a DEAD WIRE and `needs sign-in` is auth. Reusing either here is the loss of
        // information this ruling exists to undo — codex is reachable and signed in, it is spent.
        assert!(
            !states.contains("offline") && !states.contains("sign-in"),
            "out of usage was rendered with another class's word: {states:?}"
        );
        // The WORD moved to the row; leaving it on the chip too is the info glut the row replaces.
        assert!(
            !chips.contains("out of usage") && !chips.contains("limited"),
            "the health word is on the chip AND the row: {chips:?}"
        );
    }

    /// The row is minimum-info: it exists only while somebody needs it. A footer that permanently
    /// carries an empty third row spends a terminal row on nothing, every frame, forever.
    #[test]
    fn the_state_row_appears_only_while_an_agent_carries_a_health_state() {
        let mut healthy = RoomView::new();
        apply(
            &mut healthy,
            event(1, "agent.status", json!({"agent":"codex","auth":"ready"})),
        );
        assert_eq!(
            room_footer_at(&healthy, 120, 1_000).len(),
            2,
            "a healthy room grew a state row it has nothing to put in"
        );

        let mut spent = RoomView::new();
        apply(
            &mut spent,
            event(
                1,
                "agent.status",
                json!({
                    "agent":"codex",
                    "availability":{"state":"exhausted","resetsAtMs":9_000}
                }),
            ),
        );
        assert_eq!(
            room_footer_at(&spent, 120, 1_000).len(),
            3,
            "an agent out of usage got no row to say so on"
        );
        // AND IT SHRINKS BACK. The reset instant passing is the same event as the lane recovering;
        // a row that only ever grows is a leak with a slow fuse.
        assert_eq!(
            room_footer_at(&spent, 120, 9_001).len(),
            2,
            "the state row outlived the state it was reporting"
        );
    }

    /// The meters stay. `wk 100%` is the WHY behind `out of usage`, and dropping it to make room for
    /// the word would answer "what" while deleting the evidence.
    #[test]
    fn an_out_of_usage_agent_keeps_the_meters_the_vendor_actually_sent() {
        let mut room = RoomView::new();
        apply(
            &mut room,
            event(
                1,
                "agent.status",
                json!({
                    "agent":"codex",
                    "usage":{"exhausted":true,"contextUsedPct":12,"weeklyUsedPct":100,"weeklyResetsAtMs":9_000},
                    "availability":{"state":"exhausted","resetsAtMs":9_000}
                }),
            ),
        );

        let footer = footer_buffer(&room, 180, 1_000);

        assert!(
            row_text(&footer, 0).contains("wk 100%"),
            "the evidence for `out of usage` was dropped to make room for the words"
        );
        assert!(row_text(&footer, 1).contains("out of usage"));
    }

    /// ITEM F — THE RED ROW OUTLIVED ITS OWN RESET UNTIL THE OPERATOR HAPPENED TO TYPE.
    ///
    /// A health state expires by the clock alone. Nothing emits an event at that instant, no key is
    /// pressed, and with a non-empty transcript and no busy lane the 132 ms poll left `redraw`
    /// false — so the room kept painting `out of usage` for an agent it had already stopped
    /// believing was spent, and kept the taller three-row footer that costs the transcript a row.
    ///
    /// The two halves are asserted separately: that the picture GENUINELY differs across the
    /// instant (otherwise a repaint would be pointless), and that the poll asks for one.
    #[test]
    fn an_expiring_health_reset_asks_the_idle_poll_for_one_repaint() {
        let mut room = RoomView::new();
        apply(
            &mut room,
            event(
                1,
                "agent.status",
                json!({"agent":"codex","availability":{"state":"exhausted","resetsAtMs":9_000}}),
            ),
        );

        // The picture really does change with nothing behind it: three rows and a red word before
        // the instant, two rows and no word after it.
        assert!(row_text(&footer_buffer(&room, 120, 8_000), 1).contains("out of usage"));
        assert_eq!(super::room_footer_at(&room, 120, 8_000).len(), 3);
        assert_eq!(
            super::room_footer_at(&room, 120, 9_001).len(),
            2,
            "the state row is supposed to retire at the reset - if it does not, this test is pinning the wrong thing"
        );

        // The poll, tick by tick. Nothing has expired yet, so nothing is asked for.
        assert!(
            !super::reconcile_health_reset_at(&mut room, 8_000),
            "a repaint was demanded while the state was still current"
        );
        assert!(
            super::reconcile_health_reset_at(&mut room, 9_001),
            "the reset passed with no event and no keypress and the poll did not ask for a repaint - the red row and the reduced transcript geometry stay on screen until the operator types"
        );
        // ...exactly once. A signal that re-fired every tick would pin the render loop at the poll
        // rate for the rest of the session with nothing moving on screen.
        assert!(
            !super::reconcile_health_reset_at(&mut room, 9_002),
            "the expiry signal latched on and asks for a frame every tick forever"
        );
    }

    /// DELTA ITEM 5 — THE EXPIRY THAT LANDS BEFORE THE FIRST POLL EVER SEES THE STATE.
    ///
    /// The test above arms the deadline with a poll BEFORE the instant and then crosses it, which is
    /// the ordinary sequence and the one item F was built against. This is the sequence it never
    /// covers: the availability arrives at 8999 with its window at 9000, and the first idle poll runs
    /// at 9001. Nothing on the event arm reconciles the health deadline
    /// (`room_runtime_events.rs`'s `apply_room_event_at` calls the quit arm and the spent-lane
    /// memory and nothing else), so `health_reset_due_ms` is still `None` when that poll runs — and
    /// the poll's own arming then filters the already-past instant out, so no later poll can ever
    /// notice it either. The red row and the three-row footer stay on screen until the operator types.
    ///
    /// 132 ms is the poll interval, so this window is not exotic: any state whose reset lands inside
    /// one tick of its own arrival takes this path.
    #[test]
    fn first_poll_after_near_reset_repaints() {
        let mut room = RoomView::new();
        // 8999: one millisecond before its own window, and one whole poll interval before any tick.
        apply_at(
            &mut room,
            event(
                1,
                "agent.status",
                json!({"agent":"codex","availability":{"state":"exhausted","resetsAtMs":9_000}}),
            ),
            8_999,
        );

        // The picture really does differ across the instant, so a repaint is genuinely owed — the same
        // control the ordinary-sequence test above makes, at this test's own instants.
        assert!(row_text(&footer_buffer(&room, 120, 8_999), 1).contains("out of usage"));
        assert_eq!(super::room_footer_at(&room, 120, 8_999).len(), 3);
        assert_eq!(
            super::room_footer_at(&room, 120, 9_001).len(),
            2,
            "the state row is supposed to retire at the reset - if it does not, this test is pinning the wrong thing"
        );

        assert!(
            super::reconcile_health_reset_at(&mut room, 9_001),
            "the reset passed between the availability event and the FIRST poll, and the poll did not ask for a repaint - the red row and the reduced transcript geometry stay on screen until the operator types"
        );
        // ...and still exactly once. The latch has to survive a deadline that was never armed.
        assert!(
            !super::reconcile_health_reset_at(&mut room, 9_002),
            "the never-armed expiry now asks for a frame every tick forever"
        );
    }

    /// The cost side of the same rule: a healthy room arms nothing, so the poll stays one compare.
    #[test]
    fn a_healthy_room_arms_no_expiry_timer() {
        let mut room = RoomView::new();
        apply(
            &mut room,
            event(
                1,
                "agent.status",
                json!({"agent":"codex","availability":{"state":"ready"}}),
            ),
        );

        for now in [1_000, 9_001, 100_000] {
            assert!(
                !super::reconcile_health_reset_at(&mut room, now),
                "a room with every agent healthy demanded a repaint at {now}"
            );
        }
        assert!(
            room.health_reset_due_ms.is_none(),
            "a healthy room armed a redraw timer for a state nobody is painting"
        );
    }

    /// ITEM B'S SHAPE, SEEN FROM HERE. Since only a VENDOR-sourced reset instant crosses the wire,
    /// the common death now carries none at all — and a state with no instant never expires by the
    /// clock. It must stay painted and arm nothing, or the room would either drop a red word that is
    /// still true or spin the poll looking for an instant that will never arrive.
    #[test]
    fn a_health_state_with_no_reset_instant_stays_painted_and_arms_nothing() {
        let mut room = RoomView::new();
        apply(
            &mut room,
            event(
                1,
                "agent.status",
                json!({"agent":"codex","availability":{"state":"exhausted"}}),
            ),
        );

        assert!(
            row_text(&footer_buffer(&room, 120, 9_000_000), 1).contains("out of usage"),
            "a death the vendor gave no window for stopped being painted at all"
        );
        assert!(!super::reconcile_health_reset_at(&mut room, 9_000_000));
        assert!(
            room.health_reset_due_ms.is_none(),
            "a state with no reset instant armed an expiry timer"
        );
    }

    /// F4. THE OPERATOR'S RULING SURVIVES THE NEXT MESSAGE THEY SEND.
    ///
    /// `gateLaneOrBlock` calls `noteLaneBlockedSend` on the very next send to a dead lane, walking
    /// `exhausted -> local_blocked`. The wire cannot qualify `local_blocked` — `roomAgentStatusPayload`
    /// puts only state and resetsAtMs on an `availability` object that is `additionalProperties: false`
    /// — so the footer used to repaint the word as `offline`, which this room reserves for a dead wire,
    /// roughly one message after codex died and for the rest of the cooldown.
    #[test]
    fn a_spent_lane_keeps_saying_out_of_usage_when_the_next_send_is_blocked() {
        let mut room = RoomView::new();
        apply(
            &mut room,
            event(
                1,
                "agent.status",
                json!({"agent":"codex","availability":{"state":"exhausted","resetsAtMs":9_000}}),
            ),
        );
        assert!(
            row_text(&footer_buffer(&room, 120, 1_000), 1).contains("out of usage"),
            "the spent lane never said it in the first place"
        );

        // The next send to the dead lane. Same room, same reset, generic state.
        apply(
            &mut room,
            event(
                2,
                "agent.status",
                json!({"agent":"codex","availability":{"state":"local_blocked","resetsAtMs":9_000}}),
            ),
        );
        let blocked = row_text(&footer_buffer(&room, 120, 1_000), 1);
        assert!(
            blocked.contains("out of usage"),
            "one blocked send repainted a spent lane as a dead wire: {blocked:?}"
        );
        assert!(
            !blocked.contains("offline"),
            "`offline` is the dead-wire word and codex is reachable: {blocked:?}"
        );
        // Still red either way — the colour was never the part that was wrong.
        assert_eq!(
            word_fg(&footer_buffer(&room, 120, 1_000), 0, "codex"),
            Some(RoomTheme::current().dead)
        );
    }

    /// The memory is DERIVED and it expires. Two ways out, both pinned: the account recovers, or the
    /// reset instant passes and the room stops claiming to know.
    #[test]
    fn the_out_of_usage_memory_is_dropped_on_recovery_and_at_the_reset() {
        let mut room = RoomView::new();
        for (seq, state) in [(1, "exhausted"), (2, "local_blocked")] {
            apply(
                &mut room,
                event(
                    seq,
                    "agent.status",
                    json!({"agent":"codex","availability":{"state":state,"resetsAtMs":9_000}}),
                ),
            );
        }
        // PAST the reset: the room no longer knows whether the account recovered, so it stops saying so.
        let expired = row_text(&footer_buffer(&room, 120, 9_001), 1);
        assert!(
            !expired.contains("out of usage"),
            "the memory outlived the window it was about: {expired:?}"
        );

        // A REAL success is the only edge back to a dispatchable lane, and it clears the memory outright.
        apply(
            &mut room,
            event(
                3,
                "agent.status",
                json!({"agent":"codex","availability":{"state":"ready"}}),
            ),
        );
        apply(
            &mut room,
            event(
                4,
                "agent.status",
                json!({"agent":"codex","availability":{"state":"local_blocked","resetsAtMs":9_000}}),
            ),
        );
        let after_recovery = row_text(&footer_buffer(&room, 120, 1_000), 1);
        assert!(
            !after_recovery.contains("out of usage"),
            "a lane that recovered still claimed to be spent: {after_recovery:?}"
        );
    }

    /// OPERATOR RULING, 2026-08-24 — THE PAINTED STATE IS THE WORD AND NOTHING ELSE.
    ///
    /// Verbatim intent: "keep it simple, just show out of usage and that's it — stop trying to
    /// complicate stuff." So no reset clause reaches a painted string on any surface, from any
    /// source: not the fallback cooldown, not a vendor-reported window, not at any width.
    ///
    /// THIS TEST REPLACED `the_reset_clock_is_never_printed_half_way_and_the_word_never_truncates`,
    /// which pinned the four-rung degrade ladder (`out of usage · resets Aug 27 8:54 AM` down to the
    /// bare word). That ladder existed because the absolute clause was 36 columns wide and the row
    /// hard-truncated it into a half-printed clock. With the clause gone the whole failure mode is
    /// gone, and a test still pinning those rungs would be pinning deleted behaviour.
    ///
    /// The reset instant is fed in deliberately — a real, far-future, VENDOR-shaped one, the exact
    /// input that used to produce the longest rung. It must change nothing on screen.
    #[test]
    fn no_painted_surface_shows_a_reset_clause_whatever_the_reset_says() {
        for (state, word) in [
            ("exhausted", "out of usage"),
            ("needs_auth", "needs sign-in"),
            ("local_blocked", "offline"),
        ] {
            let mut room = RoomView::new();
            apply(
                &mut room,
                event(
                    1,
                    "agent.status",
                    json!({
                        "agent":"codex",
                        "availability":{"state":state,"resetsAtMs":1_787_810_040_000_u64}
                    }),
                ),
            );
            let now = 1_787_000_000_000_u64; // ~9 days before the reset: the longest rung's input

            for width in [180_u16, 120, 100, 80, 60, 40] {
                let row = row_text(&footer_buffer(&room, width, now), 1);
                assert!(
                    row.contains(word),
                    "width {width}: {state} lost its word entirely: {row:?}"
                );
                for banned in [
                    "resets",
                    "in 9d",
                    "AM",
                    "PM",
                    room_secondary(RoomSecondaryGlyph::Ellipsis),
                ] {
                    assert!(
                        !row.contains(banned),
                        "width {width}: {state} painted {banned:?} - the operator asked for the word and nothing else: {row:?}"
                    );
                }
            }

            // `/status` is the other painted surface and shares the same function, so it cannot drift.
            let status = super::room_status_summary_at(&room, now);
            assert!(
                status.contains(word),
                "/status lost the word for {state}: {status:?}"
            );
            assert!(
                !status.contains("resets"),
                "/status painted a reset clause for {state}: {status:?}"
            );
        }
    }

    /// The word FITS WHOLE or prints nothing — the one rung left has to obey the same rule the last
    /// rung of the old ladder did, because a shredded `out of usa…` is the failure this surface has
    /// always refused. Below a 12-column cell nothing is claimed at all and the state row retires
    /// itself; the red chip above still says which agent it is.
    #[test]
    fn the_health_word_fits_whole_or_prints_nothing_at_any_width() {
        let mut room = RoomView::new();
        apply(
            &mut room,
            event(
                1,
                "agent.status",
                json!({
                    "agent":"codex",
                    "availability":{"state":"exhausted","resetsAtMs":1_787_810_040_000_u64}
                }),
            ),
        );
        let now = 1_787_000_000_000_u64;
        let ellipsis = room_secondary(RoomSecondaryGlyph::Ellipsis);

        for width in [120_u16, 100, 80, 60, 40, 30, 20] {
            let row = row_text(&footer_buffer(&room, width, now), 1);
            let cell = width.min(180) / 3;
            if cell >= 12 {
                assert!(
                    row.contains("out of usage"),
                    "width {width}: the word fits in {cell} columns and was lost anyway: {row:?}"
                );
            } else {
                // Nothing fits, so nothing is claimed — and with every phrase empty the state ROW
                // retires itself, which is why row 1 is the session line again here.
                assert_eq!(
                    room_footer_at(&room, width, now).len(),
                    2,
                    "width {width}: a {cell}-column cell kept a state row it cannot put anything in"
                );
                let whole = (0..footer_buffer(&room, width, now).area.height)
                    .map(|y| row_text(&footer_buffer(&room, width, now), y))
                    .collect::<String>();
                assert!(
                    !whole.contains("out of us"),
                    "width {width}: a shredded word survived somewhere in the footer: {whole:?}"
                );
            }
            assert!(
                !row.contains(ellipsis),
                "width {width}: the word was truncated instead of dropped: {row:?}"
            );
        }
    }

    /// A3 — THE ONE PRODUCTION LINE THAT PUTS THE THIRD ROW ON SCREEN.
    ///
    /// Every other footer test in this file calls `room_footer_at(...).len()` directly, so none of them
    /// goes through `render_room` at all. Reverting `Constraint::Length(footer.len() as u16)` back to
    /// `Length(2)` therefore left 964 lib tests and 61 seam tests green while the operator's state row
    /// vanished off the bottom of the screen — the layout believed the footer was two rows and gave the
    /// third one nowhere to live.
    ///
    /// Three heights, because the interesting question is what the extra row costs: the composer keeps
    /// its rows and the FEED absorbs the line. Height 10 is the tight case where a wrong answer clips.
    #[test]
    fn a_full_room_paints_all_three_footer_rows_on_screen() {
        // BOTH COLUMNS of the identity table for the composer's prefix, pinned here rather than
        // inferred from whichever console this run happens to be in.
        assert_eq!(RoomIdentity::You.glyph_on_legacy_console(false), "\u{276f}");
        assert_eq!(RoomIdentity::You.glyph_on_legacy_console(true), ">");
        for height in [10_u16, 14, 18] {
            let mut room = RoomView::new();
            apply(
                &mut room,
                event(
                    1,
                    "agent.status",
                    json!({
                        "agent":"codex",
                        "availability":{"state":"exhausted","resetsAtMs":4_102_444_800_000_u64}
                    }),
                ),
            );
            let area = Rect::new(0, 0, 120, height);
            let mut buffer = Buffer::empty(area);
            render_room(area, &mut buffer, &mut room);
            let rows: Vec<String> = (0..height).map(|y| row_text(&buffer, y)).collect();

            // THE THREE ROWS, in order, at the bottom of the screen. The state row must sit BETWEEN the
            // roster and the session line — that adjacency is the whole point of "under it".
            // Anchored on the STATE ROW rather than on the roster: the guidance line also names
            // `@codex`, so searching for the agent finds the wrong row and would have made this test
            // pass for the wrong reason.
            let state = rows
                .iter()
                .position(|row| row.contains("out of usage"))
                .unwrap_or_else(|| {
                    panic!("height {height}: the state row never reached the screen: {rows:#?}")
                });
            assert!(
                state >= 1 && rows[state - 1].contains("codex"),
                "height {height}: the state row is not directly under the roster: {rows:#?}"
            );
            // ON SCREEN, not merely computed, and checked BEFORE indexing so the failure names the
            // defect instead of panicking on a bounds check: a footer laid out two rows tall paints the
            // roster and the state row and CLIPS the session line, leaving the state row last.
            assert!(
                state + 1 < usize::from(height),
                "height {height}: the state row was painted as the LAST row - the footer was given two rows for three, so the session line fell off the bottom: {rows:#?}"
            );
            assert!(
                rows[state + 1].contains("m0irai"),
                "height {height}: the session line did not follow the state row: {rows:#?}"
            );
            assert_eq!(
                state + 1,
                usize::from(height - 1),
                "height {height}: the footer's rows are not flush with the bottom: {rows:#?}"
            );
            // The composer survived the extra line — the feed is what gives the row up.
            //
            // The prefix comes from the identity seam, not a literal. `room_prompt_style` sets it to
            // `RoomIdentity::You.glyph()`, which is `❯` on a capable console and `>` on a legacy one;
            // the literal `\u{276f}` failed here under `GROK_FORCE_LEGACY_CONSOLE=1` and read as the
            // composer having lost its row (sealed-lanes #4). Both columns are pinned just below.
            let prompt_prefix = RoomIdentity::You.glyph();
            assert!(
                rows.iter().any(|row| row.contains(prompt_prefix)),
                "height {height}: the composer lost its prompt row to the footer: {rows:#?}"
            );
        }
    }

    #[test]
    fn footer_never_fabricates_zero_and_needs_you_owns_white_attention() {
        let mut room = RoomView::new();
        apply(
            &mut room,
            event(
                1,
                "agent.status",
                json!({
                    "agent":"claude",
                    "auth":"ready",
                    "usage":{
                        "exhausted":true,
                        "fiveHourResetsAtMs":10,
                        "weeklyResetsAtMs":10
                    }
                }),
            ),
        );
        apply(
            &mut room,
            event(
                2,
                "agent.status",
                json!({
                    "agent":"codex",
                    "auth":"limited",
                    "availability":{"state":"exhausted","resetsAtMs":10}
                }),
            ),
        );
        apply(
            &mut room,
            event(
                3,
                "agent.mode",
                json!({
                    "agent":"codex",
                    "modeId":"read-only",
                    "word":"plan",
                    "status":"active"
                }),
            ),
        );
        // WAS `codex plan limited`, and the operator overruled exactly that. This codex carries BOTH
        // `auth: limited` (a boot sample) and a live `availability: exhausted`; the live verdict wins,
        // so the chip keeps its provider mode and loses the yellow word, and the state row says which
        // of the three unusable states it is. `limited` survives only for an agent that still
        // dispatches — pinned by the expired case below, where the same room has no word at all.
        let limited = footer_buffer(&room, 100, 9);
        let limited_row = row_text(&limited, 0);
        // BOTH SIDES OF THE DISTINCTION, IN ONE FRAME, and this is why the assertion names codex's
        // whole cell instead of scanning the row for the word. CLAUDE is `limited` and must stay so:
        // its usage snapshot says exhausted, which reducer.rs:673-678 coerces to `auth: Limited`, but
        // it carries no availability verdict — nothing has refused a send, so it still dispatches and
        // keeps its yellow word. CODEX has a LIVE `availability: exhausted`: a real send was refused,
        // so it is unusable, and under the operator's ruling it loses the yellow word and gets a red
        // name plus its own row. Same word, two states, and collapsing them is the defect.
        assert!(limited_row.contains("claude"));
        assert!(
            limited_row.contains("limited"),
            "a spent-but-dispatching lane lost its `limited`: {limited_row:?}"
        );
        assert!(limited_row.contains("codex plan"));
        assert!(
            !limited_row.contains("codex plan limited"),
            "an exhausted lane is not `limited`: it refuses work"
        );
        assert!(row_text(&limited, 1).contains("out of usage"));
        let expired = footer_buffer(&room, 100, 11);
        let expired_row = row_text(&expired, 0);
        assert!(expired_row.contains("claude"));
        assert!(expired_row.contains("codex"));
        assert!(
            !expired_row.contains("auto"),
            "the footer cannot invent a provider mode when no agent.mode event exists"
        );
        assert!(!expired_row.contains('%'));
        assert!(!expired_row.contains("limited"));

        let mut pending = seeded_room(true, false);
        pending.render_tick = 0;
        let bright = footer_buffer(&pending, 120, 1_000);
        assert!(row_text(&bright, 0).contains("gemini"));
        assert!(!row_text(&bright, 0).contains("needs you"));
        assert!(
            bright
                .content
                .iter()
                .any(|cell| { cell.symbol() == "n" && cell.fg == Color::Rgb(255, 255, 255) })
        );
        pending.render_tick = 5;
        let breathed = footer_buffer(&pending, 120, 1_000);
        assert!(
            breathed
                .content
                .iter()
                .any(|cell| { cell.symbol() == "n" && cell.fg == Color::Rgb(96, 98, 101) })
        );
        pending.reduced_motion = true;
        let frozen = footer_buffer(&pending, 120, 1_000);
        assert!(
            frozen
                .content
                .iter()
                .any(|cell| { cell.symbol() == "n" && cell.fg == Color::Rgb(255, 255, 255) })
        );
    }

    #[test]
    fn footer_shows_only_provider_confirmed_modes_and_summarizes_a_shared_mode() {
        let mut room = RoomView::new();
        for (sequence, agent) in [(1, "claude"), (2, "codex"), (3, "gemini")] {
            apply(
                &mut room,
                event(
                    sequence,
                    "agent.mode",
                    json!({
                        "agent": agent,
                        "modeId": "agent-full-access",
                        "word": "auto",
                        "status": "active",
                        "availableModeIds": ["read-only", "agent", "agent-full-access"]
                    }),
                ),
            );
        }

        let footer = footer_buffer(&room, 132, 1_000);
        let identities = row_text(&footer, 0);
        for agent in ["claude", "codex", "gemini"] {
            assert!(identities.contains(&format!("{agent} auto")));
        }
        assert!(row_text(&footer, 1).contains("auto mode"));
    }

    #[test]
    fn footer_keeps_selected_mode_stable_while_provider_confirmation_is_pending() {
        let mut room = RoomView::new();
        apply(
            &mut room,
            event(
                1,
                "agent.mode",
                json!({
                    "agent":"claude",
                    "modeId":"agent-full-access",
                    "word":"auto",
                    "status":"active"
                }),
            ),
        );
        apply(
            &mut room,
            event(
                2,
                "agent.status",
                json!({"agent":"claude","auth":"ready","usage":{"exhausted":false}}),
            ),
        );
        apply(
            &mut room,
            event(
                3,
                "agent.mode",
                json!({
                    "agent":"codex",
                    "modeId":"careful",
                    "word":"careful",
                    "status":"pending"
                }),
            ),
        );
        apply(
            &mut room,
            event(
                4,
                "agent.status",
                json!({
                    "agent":"codex",
                    "auth":"ready",
                    "usage":{"exhausted":false,"contextUsedPct":10}
                }),
            ),
        );

        let footer = footer_buffer(&room, 132, 1_000);
        let identities = row_text(&footer, 0);
        assert!(identities.contains("claude auto"));
        assert!(identities.contains("codex careful"));
        assert!(!identities.contains("pending"));
        assert!(identities.contains("codex careful"));
        assert!(identities.contains(&format!(
            "{} ctx 10%",
            room_secondary(RoomSecondaryGlyph::Context)
        )));
        assert!(!row_text(&footer, 1).contains("modes pending"));
        assert!(!row_text(&footer, 1).contains("mixed modes"));

        let claude_glyph = RoomIdentity::Claude.glyph();
        assert!(footer.content.iter().any(|cell| {
            cell.symbol() == claude_glyph && cell.fg == RoomIdentity::Claude.rest_color()
        }));
    }

    #[test]
    fn footer_keeps_each_real_mode_visible_when_usage_differs_across_agents() {
        let future = 4_102_444_800_000_u64;
        let mut room = RoomView::new();
        for (sequence, agent, mode_id, word) in [
            (1, "claude", "plan", "careful"),
            (2, "codex", "read-only", "plan"),
            (3, "gemini", "edits", "edits"),
        ] {
            apply(
                &mut room,
                event(
                    sequence,
                    "agent.mode",
                    json!({
                        "agent":agent,
                        "modeId":mode_id,
                        "word":word,
                        "status":"active"
                    }),
                ),
            );
        }
        apply(
            &mut room,
            event(
                4,
                "agent.status",
                json!({
                    "agent":"codex",
                    "auth":"ready",
                    "usage":{
                        "exhausted":false,
                        "contextUsedPct":47,
                        "fiveHourUsedPct":5,
                        "fiveHourResetsAtMs":future,
                        "weeklyUsedPct":44,
                        "weeklyResetsAtMs":future
                    }
                }),
            ),
        );

        let wide = footer_buffer(&room, 180, 1_000);
        let identities = row_text(&wide, 0);
        assert!(identities.contains("claude careful"));
        assert!(identities.contains("codex plan"));
        assert!(identities.contains(&format!(
            "{} ctx 47%",
            room_secondary(RoomSecondaryGlyph::Context)
        )));
        assert!(identities.contains(&format!("{} 5h 5%", super::quota_bar(5))));
        assert!(identities.contains("gemini edits"));
        // DELIBERATE PIN CHANGE. This line was `assert!(identities.contains("wk 44%"));` and against
        // the ported policy it fails with:
        //   assertion failed: identities.contains("wk 44%")
        // A 44% weekly beside a five-hour reading is below V1's threshold and no longer earns the
        // column — V1 proves the same edge in its own suite (usage-display-policy.test.ts:31-44). This
        // test's subject is that every real MODE stays visible while usage differs across agents, and
        // that subject is untouched; the weekly was incidental to it. Asserted as an absence rather
        // than deleted, so the rule has a pin here too.
        assert!(
            !identities.contains("wk 44%"),
            "a 44% weekly beside a live 5h is not worth the column: {identities:?}"
        );
        assert!(row_text(&wide, 1).contains("mixed modes"));

        let compact = footer_buffer(&room, 100, 1_000);
        let compact_identities = row_text(&compact, 0);
        assert!(compact_identities.contains("claude careful"));
        assert!(compact_identities.contains("codex plan"));
        assert!(compact_identities.contains("gemini edits"));
        // Same change, dense form: was `contains("ctx47% 5h5% wk44%")`, which fails the same way.
        assert!(compact_identities.contains("ctx47% 5h5%"));
        assert!(!compact_identities.contains("wk44%"));
    }

    #[test]
    fn quiet_footer_renders_auto_without_exposing_no_session_handshake_state() {
        let mut room = RoomView::new();
        for (sequence, agent, mode_id) in [
            (1, "claude", "bypassPermissions"),
            (2, "codex", "agent-full-access"),
            (3, "gemini", "auto"),
        ] {
            apply(
                &mut room,
                event(
                    sequence,
                    "agent.mode",
                    json!({
                        "agent": agent,
                        "modeId": mode_id,
                        "word": "auto",
                        "status": if agent == "gemini" { "active" } else { "pending" }
                    }),
                ),
            );
        }

        let footer = footer_buffer(&room, 132, 1_000);
        let identities = row_text(&footer, 0);
        for agent in ["claude", "codex", "gemini"] {
            assert!(identities.contains(&format!("{agent} auto")));
        }
        assert!(!identities.contains("pending"));
        assert_eq!(row_text(&footer, 1).matches("auto mode").count(), 1);
        assert!(!row_text(&footer, 1).contains("modes pending"));
    }

    #[tokio::test]
    async fn every_shift_tab_encoding_cycles_mode_once_without_mutating_the_draft() {
        for (code, modifiers) in [
            (
                crossterm::event::KeyCode::BackTab,
                crossterm::event::KeyModifiers::NONE,
            ),
            (
                crossterm::event::KeyCode::BackTab,
                crossterm::event::KeyModifiers::SHIFT,
            ),
            (
                crossterm::event::KeyCode::Tab,
                crossterm::event::KeyModifiers::SHIFT,
            ),
        ] {
            let mut room = RoomView::new();
            room.prompt.set_text("@codex preserve this draft");
            let (command_tx, mut command_rx) = tokio::sync::mpsc::channel(1);

            handle_key(
                &mut room,
                crossterm::event::KeyEvent::new(code, modifiers),
                &command_tx,
            )
            .await
            .expect("Shift+Tab remains a room command");

            assert_eq!(room.prompt.text(), "@codex preserve this draft");
            match command_rx.recv().await {
                Some(super::RoomCommand::CycleMode { composer_text }) => {
                    assert_eq!(composer_text, "@codex preserve this draft");
                }
                other => panic!("expected one mode-cycle command, got {other:?}"),
            }
            assert!(command_rx.try_recv().is_err(), "one key emits one command");
        }
    }

    #[tokio::test]
    async fn local_status_debate_notice_and_exit_never_leak_into_the_host_submit_bridge() {
        let (command_tx, mut command_rx) = tokio::sync::mpsc::channel(1);

        let mut status = RoomView::new();
        status.prompt.set_text("/status");
        status.prompt.set_cursor(status.prompt.text().len());
        let result = handle_key(
            &mut status,
            crossterm::event::KeyEvent::new(
                crossterm::event::KeyCode::Enter,
                crossterm::event::KeyModifiers::NONE,
            ),
            &command_tx,
        )
        .await
        .unwrap();
        assert_eq!(result, None);
        assert!(status.scrollback.searchable_text().contains("claude"));
        assert!(command_rx.try_recv().is_err());

        let mut debate = RoomView::new();
        debate.prompt.set_text("/debate architecture");
        debate.prompt.set_cursor(debate.prompt.text().len());
        handle_key(
            &mut debate,
            crossterm::event::KeyEvent::new(
                crossterm::event::KeyCode::Enter,
                crossterm::event::KeyModifiers::NONE,
            ),
            &command_tx,
        )
        .await
        .unwrap();
        assert!(debate.scrollback.searchable_text().contains("use /council"));
        assert!(command_rx.try_recv().is_err());

        let mut invalid = RoomView::new();
        invalid.prompt.set_text("/mode codex plan");
        invalid.prompt.set_cursor(invalid.prompt.text().len());
        handle_key(
            &mut invalid,
            crossterm::event::KeyEvent::new(
                crossterm::event::KeyCode::Enter,
                crossterm::event::KeyModifiers::NONE,
            ),
            &command_tx,
        )
        .await
        .unwrap();
        assert!(
            invalid
                .scrollback
                .searchable_text()
                .contains("invalid room command")
        );
        assert!(command_rx.try_recv().is_err());

        let mut exit = RoomView::new();
        exit.prompt.set_text("/exit");
        exit.prompt.set_cursor(exit.prompt.text().len());
        let result = handle_key(
            &mut exit,
            crossterm::event::KeyEvent::new(
                crossterm::event::KeyCode::Enter,
                crossterm::event::KeyModifiers::NONE,
            ),
            &command_tx,
        )
        .await
        .unwrap();
        assert_eq!(result, Some(super::RoomRuntimeExit::Exit));
        assert!(command_rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn permission_shelf_preserves_feed_draft_and_explicit_composer_focus_with_failure_history()
     {
        use super::PermissionKeyRoute;
        let mut room = seeded_room(true, false);
        room.prompt.set_text("draft remains editable");
        room.prompt.set_cursor(room.prompt.text().len());
        let area = Rect::new(0, 0, 120, 40);
        let mut buffer = Buffer::empty(area);
        render_room(area, &mut buffer, &mut room);
        let text = rendered_text(&buffer);
        assert!(text.contains("allow once"));
        assert!(text.contains("gemini body"));
        assert!(text.contains("draft remains editable"));
        assert_eq!(
            route_permission_key(
                &mut room,
                &crossterm::event::KeyEvent::new(
                    crossterm::event::KeyCode::Enter,
                    crossterm::event::KeyModifiers::NONE
                )
            ),
            PermissionKeyRoute::NotHandled
        );
        assert_eq!(
            route_permission_key(
                &mut room,
                &crossterm::event::KeyEvent::new(
                    crossterm::event::KeyCode::Up,
                    crossterm::event::KeyModifiers::ALT
                )
            ),
            PermissionKeyRoute::Consumed
        );
        assert!(room.permissions.is_focused());
        let selected_before = room.scrollback.selected_index();
        assert_eq!(
            route_permission_key(
                &mut room,
                &crossterm::event::KeyEvent::new(
                    crossterm::event::KeyCode::Down,
                    crossterm::event::KeyModifiers::NONE,
                ),
            ),
            PermissionKeyRoute::Consumed
        );
        assert_eq!(
            room.scrollback.selected_index(),
            selected_before,
            "permission navigation must never leak into scrollback selection",
        );
        assert_eq!(
            route_permission_key(
                &mut room,
                &crossterm::event::KeyEvent::new(
                    crossterm::event::KeyCode::Esc,
                    crossterm::event::KeyModifiers::NONE
                )
            ),
            PermissionKeyRoute::Consumed
        );
        assert!(!room.permissions.is_focused());
        let composer_key = crossterm::event::KeyEvent::new(
            crossterm::event::KeyCode::Char('!'),
            crossterm::event::KeyModifiers::NONE,
        );
        let (command_tx, mut command_rx) = tokio::sync::mpsc::channel(1);
        if route_permission_key(&mut room, &composer_key) == PermissionKeyRoute::NotHandled {
            handle_key(&mut room, composer_key, &command_tx)
                .await
                .expect("composer key remains routable");
        }
        assert!(room.prompt.text().ends_with('!'));
        assert!(
            command_rx.try_recv().is_err(),
            "editing must not approve a permission"
        );

        let mut numeric = seeded_room(true, false);
        assert!(numeric.prompt.text().is_empty());
        let numeric_area = Rect::new(0, 0, 120, 40);
        let mut numeric_buffer = Buffer::empty(numeric_area);
        render_room(numeric_area, &mut numeric_buffer, &mut numeric);
        assert_eq!(
            route_permission_key(
                &mut numeric,
                &crossterm::event::KeyEvent::new(
                    crossterm::event::KeyCode::Char('1'),
                    crossterm::event::KeyModifiers::NONE,
                ),
            ),
            PermissionKeyRoute::Action(
                crate::room_permission_view::RoomPermissionAction::SelectOption {
                    ask_id: "ask-gemini".into(),
                    option_id: "allow-opaque".into(),
                }
            ),
            "the visible [1] affordance must dispatch its opaque provider option before submit",
        );
        assert!(numeric.prompt.text().is_empty());

        let mut out_of_range = seeded_room(true, false);
        out_of_range.permissions.focus_shelf();
        assert_eq!(
            route_permission_key(
                &mut out_of_range,
                &crossterm::event::KeyEvent::new(
                    crossterm::event::KeyCode::Char('9'),
                    crossterm::event::KeyModifiers::NONE,
                ),
            ),
            PermissionKeyRoute::Consumed,
            "an invalid shelf digit cannot leak into scrollback or the composer",
        );
        assert!(out_of_range.prompt.text().is_empty());

        let mut normal_draft = seeded_room(true, false);
        normal_draft.prompt.set_text("draft");
        normal_draft
            .prompt
            .set_cursor(normal_draft.prompt.text().len());
        assert_eq!(
            route_permission_key(
                &mut normal_draft,
                &crossterm::event::KeyEvent::new(
                    crossterm::event::KeyCode::Char('1'),
                    crossterm::event::KeyModifiers::NONE,
                ),
            ),
            PermissionKeyRoute::NotHandled,
            "a nonempty normal draft retains numeric typing ownership",
        );
        let (draft_tx, mut draft_rx) = tokio::sync::mpsc::channel(1);
        handle_key(
            &mut normal_draft,
            crossterm::event::KeyEvent::new(
                crossterm::event::KeyCode::Char('1'),
                crossterm::event::KeyModifiers::NONE,
            ),
            &draft_tx,
        )
        .await
        .unwrap();
        assert_eq!(normal_draft.prompt.text(), "draft1");
        assert!(draft_rx.try_recv().is_err());

        let mut failed = seeded_room(false, true);
        apply(
            &mut failed,
            event(
                13,
                "message.committed",
                json!({"laneId":"lane-claude","agent":"claude","messageId":"message-claude","ledgerSeq":"2","text":"claude body","origin":"operator","hopIndex":0}),
            ),
        );
        apply(
            &mut failed,
            event(
                14,
                "lane.completed",
                json!({"laneId":"lane-claude","streamId":"stream-claude","agent":"claude"}),
            ),
        );
        apply(
            &mut failed,
            event(
                15,
                "message.committed",
                json!({"laneId":"lane-codex","agent":"codex","messageId":"message-codex","ledgerSeq":"3","text":"codex body","origin":"operator","hopIndex":0}),
            ),
        );
        apply(
            &mut failed,
            event(
                16,
                "lane.completed",
                json!({"laneId":"lane-codex","streamId":"stream-codex","agent":"codex"}),
            ),
        );
        assert!(
            failed
                .scrollback
                .searchable_text()
                .contains("gemini — failed"),
            "terminal lifecycle must reach the chronology before layout"
        );
        let mut failed_buffer = Buffer::empty(area);
        failed.render_tick = 0;
        render_room(area, &mut failed_buffer, &mut failed);
        let failed_text = rendered_text(&failed_buffer);
        assert!(
            failed_text.contains("gemini — failed"),
            "failed row is not visible in the composed feed: {failed_text}"
        );
        let mut failed_later_buffer = Buffer::empty(area);
        failed.render_tick = 4;
        render_room(area, &mut failed_later_buffer, &mut failed);
        assert_eq!(
            rendered_text(&failed_buffer),
            rendered_text(&failed_later_buffer),
            "failed and permission-only rows must not animate"
        );
    }
}
