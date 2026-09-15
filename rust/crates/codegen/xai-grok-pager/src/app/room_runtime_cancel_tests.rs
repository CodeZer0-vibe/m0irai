//! Slice B's proofs: the room's cancel keys, and the quit they arm.
//!
//! Kept beside `room_runtime.rs` rather than inside its `mod tests`, because
//! three lanes edit that file at once and a test module appended to it is the
//! merge conflict nobody sees coming. Read the tags: a `[FALSIFIER]` fails
//! against the tree before this slice, a `[PIN]` passes on the tree it was
//! written against and owes a mutation instead.
//!
//! Everything here drives `route_room_key_at` — the production router — and not
//! `handle_key_at` or an owner directly. That is deliberate and it is the whole
//! reason wave 0 built the router: a test that calls an owner asks one of four
//! participants and reports as free a key the permission shelf ate.

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyEventState, KeyModifiers};
use serde_json::json;
use tokio::sync::mpsc;
use zer0_room_protocol::{LanePhase, RoomReducer};

use super::tests::apply;
use super::{
    KeyDisposition, ParsedRoomCommand, QUIT_CONFIRM_WINDOW, RoomCancelScope, RoomCommand,
    RoomControlCommand, RoomRuntimeExit, apply_room_event_at, apply_room_snapshot_at,
    apply_submit_settled, guidance_row_at, lane_busy, parse_room_command, reconcile_quit_arm_at,
    route_room_key_at,
};
use crate::room_composer_menu::RoomCatalogAgent;
use crate::room_ctrl_c_gesture::CTRL_C_GESTURE_QUIET;
use crate::room_view::RoomView;
use std::time::{Duration, Instant};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/// A room assembled from real events, across as many turns as a case needs.
///
/// `room_runtime_seam_tests.rs` has a fixture of the same shape, and this one is
/// not a copy for the sake of one: that one pins every event to a single
/// `turnId`, and slice B's whole finding-7 case is **two** non-terminal turns at
/// once. Every fixture below asserts the phase it claims to have reached, so a
/// room that quietly stops being busy cannot pass a busy test.
struct RoomFixture {
    room: RoomView,
    seq: u64,
}

impl RoomFixture {
    fn new() -> Self {
        Self {
            room: RoomView::new(),
            seq: 0,
        }
    }

    /// One accepted turn with a queued lane for every named agent.
    fn turn(mut self, turn: &str, agents: &[&str]) -> Self {
        let ledger_seq = format!("{}", self.seq + 1);
        self = self.emit(
            turn,
            "turn.accepted",
            json!({"agents":agents,"text":"inspect the room","messageId":format!("operator-{turn}"),"ledgerSeq":ledger_seq}),
        );
        self = self.emit(turn, "route.resolved", json!({"agents":agents}));
        for agent in agents {
            self = self.emit(
                turn,
                "lane.queued",
                json!({"laneId":format!("lane-{turn}-{agent}"),"agent":agent,"expectedMessageId":format!("message-{turn}-{agent}"),"origin":"operator","hopIndex":0}),
            );
        }
        self
    }

    fn emit(mut self, turn: &str, kind: &str, payload: serde_json::Value) -> Self {
        self.seq += 1;
        let event = zer0_room_protocol::RoomEvent::from_value(json!({
            "protocol": "zer0.room", "version": 1, "sessionId": "cancel-room",
            "eventSeq": self.seq.to_string(), "eventId": format!("cancel-event-{}", self.seq),
            "turnId": turn, "occurredAt": "2026-08-21T00:00:00Z",
            "type": kind, "payload": payload,
        }))
        .expect("test event is protocol-valid");
        apply(&mut self.room, event);
        self
    }

    fn started(self, turn: &str, agent: &str) -> Self {
        self.emit(
            turn,
            "lane.started",
            json!({"laneId":format!("lane-{turn}-{agent}"),"streamId":format!("stream-{turn}-{agent}"),"agent":agent}),
        )
    }

    fn cancelling(self, turn: &str, agent: &str) -> Self {
        self.emit(
            turn,
            "lane.cancelling",
            json!({"laneId":format!("lane-{turn}-{agent}"),"agent":agent}),
        )
    }

    fn cancelled(self, turn: &str, agent: &str) -> Self {
        self.emit(
            turn,
            "lane.cancelled",
            json!({"laneId":format!("lane-{turn}-{agent}"),"agent":agent,"streamId":format!("stream-{turn}-{agent}")}),
        )
    }

    fn done(self) -> RoomView {
        self.room
    }
}

/// The number of lanes in each phase, so a fixture can assert what it built
/// instead of announcing it.
fn phase_count(reducer: &RoomReducer, phase: LanePhase) -> usize {
    reducer
        .ordered_lanes()
        .filter(|lane| lane.phase == phase)
        .count()
}

/// One turn, one agent, actually `Running`.
fn one_running() -> RoomView {
    let room = RoomFixture::new()
        .turn("turn-1", &["claude"])
        .started("turn-1", "claude")
        .done();
    assert_eq!(
        phase_count(&room.reducer, LanePhase::Running),
        1,
        "the fixture must really hold one running lane"
    );
    assert!(
        lane_busy(&room.reducer, None),
        "and the room must read busy"
    );
    room
}

/// One turn, one agent, already `Cancelling` — still busy, which is the whole
/// reason the armed rung has to sit above the busy rung.
fn one_cancelling() -> RoomView {
    let room = RoomFixture::new()
        .turn("turn-1", &["claude"])
        .started("turn-1", "claude")
        .cancelling("turn-1", "claude")
        .done();
    assert_eq!(
        phase_count(&room.reducer, LanePhase::Cancelling),
        1,
        "the fixture must really hold one cancelling lane"
    );
    assert!(
        lane_busy(&room.reducer, None),
        "a cancelling lane is still busy, and this fixture exists to say so"
    );
    room
}

/// Two non-terminal turns at once: turn 1's claude still running while turn 2's
/// two lanes run. The finding-7 room — the one a `Latest` cancel abandons.
fn two_turns_in_flight() -> RoomView {
    let room = RoomFixture::new()
        .turn("turn-1", &["claude"])
        .started("turn-1", "claude")
        .turn("turn-2", &["codex", "gemini"])
        .started("turn-2", "codex")
        .started("turn-2", "gemini")
        .done();
    assert_eq!(
        phase_count(&room.reducer, LanePhase::Running),
        3,
        "the fixture must hold three running lanes across two turns"
    );
    room
}

/// A room with a pending permission shelf — and a **running** lane, because the
/// shelf only exists while an agent is waiting on an answer.
fn shelf_room() -> RoomView {
    let room = RoomFixture::new()
        .turn("turn-1", &["gemini"])
        .started("turn-1", "gemini")
        .emit(
            "turn-1",
            "permission.requested",
            json!({"askId":"ask-gemini","agent":"gemini","options":[
                {"optionId":"allow-opaque","kind":"allow_once","name":"Allow once"},
                {"optionId":"deny-opaque","kind":"reject_once","name":"Deny"}]}),
        )
        .done();
    assert!(
        room.permissions.is_active(),
        "the fixture must really hold a pending permission"
    );
    room
}

fn ctrl_c() -> KeyEvent {
    KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)
}

fn ctrl_c_repeat() -> KeyEvent {
    KeyEvent::new_with_kind(
        KeyCode::Char('c'),
        KeyModifiers::CONTROL,
        KeyEventKind::Repeat,
    )
}

fn esc() -> KeyEvent {
    KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)
}

// ---------------------------------------------------------------------------
// The observable
// ---------------------------------------------------------------------------

/// What a `RoomCommand` IS, to the exact precision these proofs need.
///
/// `RoomCommand` is not `PartialEq`, and the tempting weakening — "a command
/// arrived" — is the one that cannot see this slice's central risk: a cancel
/// emitted with `scope: Latest` arrives just as loudly as one with `All` and
/// leaves the older turn running under the words "agents stopped". So the scope
/// and the agent are in the string. `describes_the_scope_it_is_asked_about`
/// below is this function's own positive control.
fn describe(command: &RoomCommand) -> String {
    match command {
        RoomCommand::Control {
            command: RoomControlCommand::Cancel,
            scope,
            agent,
        } => format!(
            "cancel/{}/{}",
            match scope {
                Some(RoomCancelScope::All) => "all",
                Some(RoomCancelScope::Latest) => "latest",
                Some(RoomCancelScope::Agent) => "agent",
                None => "none",
            },
            agent.as_deref().unwrap_or("-")
        ),
        RoomCommand::Control { command, .. } => format!("control/{command:?}"),
        RoomCommand::Submit { .. } => "submit".to_owned(),
        RoomCommand::CycleMode { .. } => "cycle-mode".to_owned(),
        RoomCommand::PermissionResponse(_) => "permission-response".to_owned(),
        RoomCommand::Picker(_) => "picker".to_owned(),
        RoomCommand::CancelPicker => "cancel-picker".to_owned(),
    }
}

/// The room-wide cancel this slice's keys are supposed to emit, spelled once.
const CANCEL_ALL: &str = "cancel/all/-";

/// A keyboard attached to one room, holding BOTH host channels across presses.
///
/// A fresh channel per press would lose the ordering between them, and the
/// two-press cases are entirely about ordering.
///
/// ⚠ **`drain` reads both wires, and it has to.** BLOCK 2 moved the room-wide
/// cancel onto its own channel so it cannot queue behind a 130-second mode RPC.
/// A `drain` that went on reading only the command wire would report an empty
/// `vec![]` for every cancel in this file — every `assert_eq!(keys.drain(),
/// vec![CANCEL_ALL])` would go red, and the tempting repair (delete the
/// assertion) would leave a suite that cannot see whether the panic button
/// sends anything at all.
struct Keys {
    tx: mpsc::Sender<RoomCommand>,
    rx: mpsc::Receiver<RoomCommand>,
    cancel_tx: mpsc::Sender<super::RoomCancelAll>,
    cancel_rx: mpsc::Receiver<super::RoomCancelAll>,
    /// Every submission id seen on the command wire, oldest first (FL-126).
    ///
    /// Recorded as the wire is read rather than returned by a second reader,
    /// because both readers consume the same mpsc: a case that asserts
    /// `drain() == ["submit"]` would otherwise have thrown the id away.
    submitted: Vec<super::SubmissionId>,
}

impl Keys {
    fn new() -> Self {
        let (tx, rx) = mpsc::channel(16);
        let (cancel_tx, cancel_rx) = mpsc::channel(16);
        Self {
            tx,
            rx,
            cancel_tx,
            cancel_rx,
            submitted: Vec::new(),
        }
    }

    /// A keyboard whose bridge to the host is already gone.
    ///
    /// Both senders' own receivers are dropped, so every send fails; the second,
    /// unrelated pair exists only to give the struct receivers to hold, and they
    /// stay empty for the whole test. Draining them is what proves nothing was
    /// sent.
    fn severed() -> Self {
        let (tx, rx) = mpsc::channel(16);
        drop(rx);
        let (cancel_tx, cancel_rx) = mpsc::channel(16);
        drop(cancel_rx);
        let (_never_written, rx) = mpsc::channel(16);
        let (_never_written_cancel, cancel_rx) = mpsc::channel(16);
        Self {
            tx,
            rx,
            cancel_tx,
            cancel_rx,
            submitted: Vec::new(),
        }
    }

    async fn press_at(&self, room: &mut RoomView, key: KeyEvent, now: Instant) -> KeyDisposition {
        route_room_key_at(room, key, &self.tx, &self.cancel_tx, now)
            .await
            .expect("routing a key must not fail the room")
    }

    async fn try_press_at(
        &self,
        room: &mut RoomView,
        key: KeyEvent,
        now: Instant,
    ) -> anyhow::Result<KeyDisposition> {
        route_room_key_at(room, key, &self.tx, &self.cancel_tx, now).await
    }

    /// Everything sent to the host since the last drain: the command wire first,
    /// then the cancel wire.
    ///
    /// The two wires have no ordering BETWEEN them — they are separate channels,
    /// which is the fix — so this is a set spelled as a stable sequence. Every
    /// case in this file drains after a single key, where at most one wire has
    /// anything on it, so the concatenation order is never load-bearing.
    fn drain(&mut self) -> Vec<String> {
        let mut sent = Vec::new();
        while let Ok(command) = self.rx.try_recv() {
            if let RoomCommand::Submit { submission, .. } = &command {
                self.submitted.push(*submission);
            }
            sent.push(describe(&command));
        }
        while self.cancel_rx.try_recv().is_ok() {
            sent.push(CANCEL_ALL.to_owned());
        }
        sent
    }

    /// The submission ids the room actually put on the wire, oldest first,
    /// and forget them.
    ///
    /// Read off the real `RoomCommand::Submit` the router produced, so a case
    /// answers the room's own question rather than one it invented. Reads the
    /// wire first, so it does not matter whether `drain` has already run.
    fn submissions(&mut self) -> Vec<super::SubmissionId> {
        let _ = self.drain();
        std::mem::take(&mut self.submitted)
    }

    /// The host answering the room's most recent cancel.
    fn host_confirms_the_cancel(&self, room: &mut RoomView) {
        room.cancel_claim = room.cancel_claim.answered(room.cancel_claim.seq());
    }
}

fn exited(disposition: &KeyDisposition) -> bool {
    matches!(disposition, KeyDisposition::Exit(RoomRuntimeExit::Exit))
}

/// [MUTATION] The observable can tell the two scopes apart.
///
/// Site 2 and site 3 both rest on `describe` distinguishing `All` from
/// `Latest`. If it collapsed them — the natural weakening, since neither is
/// `PartialEq` — every scope assertion in this file would pass against the
/// wrong scope, and nothing else here would notice. So the instrument is asked
/// to produce the other answer first, from real commands the room's own parser
/// builds.
#[test]
fn describes_the_scope_it_is_asked_about() {
    let catalog = RoomView::new().catalog.clone();
    let described = |text: &str| match parse_room_command(text, &catalog) {
        Some(ParsedRoomCommand::Host(command)) => describe(&command),
        other => panic!("{text} did not parse to a host command: {other:?}"),
    };
    assert_eq!(described("/cancel all"), CANCEL_ALL);
    assert_eq!(described("/cancel latest"), "cancel/latest/-");
    assert_ne!(
        described("/cancel all"),
        described("/cancel latest"),
        "the observable cannot see the scope, so every scope assertion here is decoration"
    );
}

/// [PIN] The typed `/cancel` keeps its precise meanings. Only the KEY is a
/// panic button.
///
/// MUTATION: change the bare `"/cancel"` arm in `parse_room_command` to
/// `RoomCancelScope::All` — the plausible mistake, since the key next to it now
/// means all — and this goes red on the first row with
/// `cancel/all/- != cancel/latest/-`.
#[test]
fn the_typed_cancel_keeps_its_scopes() {
    let catalog = RoomView::new().catalog.clone();
    let described = |text: &str| match parse_room_command(text, &catalog) {
        Some(ParsedRoomCommand::Host(command)) => describe(&command),
        other => panic!("{text} did not parse to a host command: {other:?}"),
    };
    for (text, expected) in [
        ("/cancel", "cancel/latest/-"),
        ("/cancel latest", "cancel/latest/-"),
        ("/cancel all", CANCEL_ALL),
        ("/cancel claude", "cancel/agent/claude"),
        ("/cancel codex", "cancel/agent/codex"),
        ("/cancel gemini", "cancel/agent/gemini"),
    ] {
        assert_eq!(described(text), expected, "`{text}` changed meaning");
    }
}

// ---------------------------------------------------------------------------
// Site 1 — Esc cancels
// ---------------------------------------------------------------------------

/// [FALSIFIER] Site 1. Esc cancels a running lane.
///
/// RED before this slice: Esc reached no cancel arm at all — the only
/// construction of `RoomControlCommand::Cancel` in the file was inside
/// `parse_room_command`'s `/cancel` arm, so the channel stayed empty.
///
/// What wrong implementation would still pass? One that emits `Latest` — no:
/// the assertion carries the scope. One that also arms the quit — no: the arm
/// is asserted absent, because an Esc that could turn the next Ctrl+C into a
/// quit is an Esc that can end the room.
///
/// ⚠ **The draft assertions were added by the BLOCK-2 fix, and they are not
/// decoration.** The review found (MAJOR 4) that "Esc preserves the draft" had
/// no proof at all — every Esc case started with an empty composer, so adding
/// `room.prompt.set_text("")` to the Esc arm left the whole suite green while
/// the operator lost what they had typed. This fix EDITS that arm, swapping the
/// command send for `request_cancel_all`, which takes `&mut RoomView`. Changing
/// an arm that had no proof, while handing it mutable access to the very thing
/// nothing was watching, is not a change to make and walk away from.
///
/// Non-ASCII text on purpose: a byte-index slip on an editor path shows up here
/// and nowhere else in this file.
#[tokio::test]
async fn esc_cancels_a_running_lane() {
    let mut keys = Keys::new();
    let mut room = one_running();
    let now = Instant::now();
    room.prompt.set_text("héllo — a draft with an em dash");
    room.prompt.set_cursor(6);
    let draft = room.prompt.text().to_owned();
    let cursor = room.prompt.cursor();
    assert!(
        !draft.is_empty() && cursor > 0 && cursor < draft.len(),
        "the fixture must really hold a nonempty draft with a nonterminal caret"
    );

    let routed = keys.press_at(&mut room, esc(), now).await;

    assert_eq!(keys.drain(), vec![CANCEL_ALL.to_owned()]);
    assert!(!exited(&routed), "Esc must never end the room");
    assert_eq!(
        room.quit_armed_until, None,
        "Esc cancels; it must not arm a quit"
    );
    assert_eq!(
        room.prompt.text(),
        draft,
        "Esc stops the agents and leaves the operator's draft byte-for-byte alone"
    );
    assert_eq!(
        room.prompt.cursor(),
        cursor,
        "and it does not move the caret"
    );
}

/// [PIN] Esc while already `Cancelling` re-sends the cancel and still does not
/// arm.
///
/// A lost cancel notification is the case this covers, and upstream keeps the
/// same behaviour for the same reason
/// (`D:\grok-ref\...\app\agent_view\prompt.rs:838-846`: "while already
/// cancelling, so a lost cancel notification is re-sent").
///
/// MUTATION: narrow `lane_busy`'s matched set to `LanePhase::Running` alone —
/// the plausible mistake, since "busy" reads like "running" — and this goes red
/// with an empty channel.
#[tokio::test]
async fn esc_while_cancelling_resends_and_does_not_arm() {
    let mut keys = Keys::new();
    let mut room = one_cancelling();

    keys.press_at(&mut room, esc(), Instant::now()).await;

    assert_eq!(keys.drain(), vec![CANCEL_ALL.to_owned()]);
    assert_eq!(room.quit_armed_until, None);
}

/// [PIN + MUTATION] Bare Esc cancels; a modified Esc does not.
///
/// Upstream makes the same narrowing and tests it
/// (`D:\grok-ref\...\app\agent_view\prompt.rs:797-802`). A modified Esc is a
/// terminal encoding, not a gesture, and a panic button that fires on noise is
/// worse than one key further away.
///
/// MUTATION: relax `is_bare_esc` to `key.code == KeyCode::Esc` — the plausible
/// mistake, and the shape five of the room's six existing Esc consumers already
/// have — and the two modified rows go red with a cancel in the channel.
#[tokio::test]
async fn only_a_bare_esc_cancels() {
    for (label, modifiers, expected) in [
        ("bare", KeyModifiers::NONE, vec![CANCEL_ALL.to_owned()]),
        ("alt", KeyModifiers::ALT, vec![]),
        ("shift", KeyModifiers::SHIFT, vec![]),
    ] {
        let mut keys = Keys::new();
        let mut room = one_running();
        keys.press_at(
            &mut room,
            KeyEvent::new(KeyCode::Esc, modifiers),
            Instant::now(),
        )
        .await;
        assert_eq!(keys.drain(), expected, "{label} Esc");
    }
}

// ---------------------------------------------------------------------------
// Site 2 — the older turn
// ---------------------------------------------------------------------------

/// [FALSIFIER] Site 2, the Rust half. With two non-terminal turns in flight,
/// the key still emits ONE room-wide cancel.
///
/// ⚠ **This is the half Rust can prove, and the boundary is written down rather
/// than implied.** That the older turn's lane actually stops is `RoomEngine`'s
/// behaviour, not the pager's — `cancelTarget` only touches an active lane when
/// `active.turnId === turnId` (`src/room/room-engine.ts:483`) — and it is proved
/// on the Node side by `room-engine.test.ts`, which runs the same two-turn room
/// through `cancel(All)` and `cancel(Latest)` and shows the older lane
/// surviving the second. Neither half is sufficient alone: Rust cannot see the
/// host, and the Node test passes today without any key ever being pressed.
///
/// RED before this slice: no key produced a cancel at all.
#[tokio::test]
async fn a_key_cancel_stops_an_older_turn_too() {
    for (label, key) in [("esc", esc()), ("ctrl+c", ctrl_c())] {
        let mut keys = Keys::new();
        let mut room = two_turns_in_flight();

        keys.press_at(&mut room, key, Instant::now()).await;

        assert_eq!(
            keys.drain(),
            vec![CANCEL_ALL.to_owned()],
            "{label} with two turns in flight must send exactly one room-wide cancel; \
             `latest` resolves one turn and would leave the older lane running"
        );
    }
}

// ---------------------------------------------------------------------------
// Site 3, and the arm's lifecycle
// ---------------------------------------------------------------------------

/// [FALSIFIER] Site 3. The first Ctrl+C cancels and arms; the second quits.
///
/// RED before this slice: the first Ctrl+C on an empty composer exited
/// immediately (`room_runtime.rs:409-413` as it stood), so there was no first
/// press to be the cancel and no second press to be the quit.
///
/// What wrong implementation would still pass? One that arms without cancelling
/// — no: the channel is asserted. One that quits on the first press — no: the
/// first press is asserted not to exit. One that cancels twice and never quits
/// (the rung-order mistake) — no: the second press is asserted to exit and the
/// channel is asserted to hold exactly one cancel.
#[tokio::test]
async fn ctrl_c_while_running_cancels_then_the_second_quits() {
    let mut keys = Keys::new();
    let mut room = one_running();
    let now = Instant::now();

    let first = keys.press_at(&mut room, ctrl_c(), now).await;
    assert!(!exited(&first), "the first Ctrl+C must not end the room");
    assert_eq!(keys.drain(), vec![CANCEL_ALL.to_owned()]);
    assert_eq!(
        room.quit_armed_until,
        Some(now + QUIT_CONFIRM_WINDOW),
        "the first press arms for exactly the confirmation window"
    );

    // The lanes are `Cancelling` now, which is what a real host would report and
    // what makes rung 1's position load-bearing: rung 2 is still true here.
    room = RoomFixture::new()
        .turn("turn-1", &["claude"])
        .started("turn-1", "claude")
        .cancelling("turn-1", "claude")
        .done();
    room.quit_armed_until = Some(now + QUIT_CONFIRM_WINDOW);

    let second = keys
        .press_at(&mut room, ctrl_c(), now + Duration::from_millis(400))
        .await;
    assert!(exited(&second), "the second Ctrl+C must end the room");
    assert_eq!(
        keys.drain(),
        Vec::<String>::new(),
        "the confirming press cancels nothing; it is a confirmation, not a second panic"
    );
}

/// [PIN + MUTATION] A held Ctrl+C cannot confirm the quit.
///
/// The router accepts `KeyEventKind::Press | Repeat` (`accepts_key`,
/// `room_runtime.rs:360-362`), so without the guard a single held Ctrl+C
/// cancels on the first event and quits on the second — the exact bug this
/// slice exists to remove, reintroduced through autorepeat, and invisible to
/// every test that only ever builds `KeyEvent::new` (which is `Press`).
///
/// MUTATION: delete the gesture guard at the top of `route_ctrl_c_at` and the
/// middle assertion goes red — the repeat exits.
///
/// ⚠ **The last assertion changed when BLOCK 1 was fixed, and the change is the
/// point.** It used to press `Ctrl+C` 30 ms after a repeat, with no release in
/// between, and require an exit. That input is a HELD KEY — three key events in
/// 60 ms with the key never coming up — and calling it "a real second tap" was
/// the defect written down as an expectation. The tap it now performs is the
/// one a hand can actually make: let go first.
#[tokio::test]
async fn a_held_ctrl_c_cannot_confirm_the_quit() {
    let mut keys = Keys::new();
    let mut room = one_running();
    let now = Instant::now();

    keys.press_at(&mut room, ctrl_c(), now).await;
    assert_eq!(keys.drain(), vec![CANCEL_ALL.to_owned()]);

    let repeat = keys
        .press_at(&mut room, ctrl_c_repeat(), now + Duration::from_millis(30))
        .await;
    assert!(!exited(&repeat), "autorepeat is one gesture, not two taps");
    assert_eq!(
        keys.drain(),
        Vec::<String>::new(),
        "a repeat inside the window must not re-cancel either"
    );
    assert_eq!(
        room.quit_armed_until,
        Some(now + QUIT_CONFIRM_WINDOW),
        "and it must not disarm what the operator armed"
    );

    keys.press_at(&mut room, ctrl_c_release(), now + Duration::from_millis(45))
        .await;
    let tap = keys
        .press_at(&mut room, ctrl_c(), now + Duration::from_millis(60))
        .await;
    assert!(exited(&tap), "a real second tap still quits");
}

/// [PIN] Autorepeat changes nothing OUTSIDE the confirmation rung.
///
/// The guard above is narrowed to rung 1 on purpose. The blunt version — refuse
/// every repeated Ctrl+C — silently deletes today's behaviour for an idle room,
/// where a held Ctrl+C quits and always has.
///
/// MUTATION: move the repeat guard to the top of `route_ctrl_c_at`, ahead of
/// every rung, and this goes red: the idle room stops quitting.
#[tokio::test]
async fn autorepeat_leaves_the_idle_room_alone() {
    let keys = Keys::new();
    let mut room = RoomView::new();
    let routed = keys
        .press_at(&mut room, ctrl_c_repeat(), Instant::now())
        .await;
    assert!(
        exited(&routed),
        "an idle room with an empty composer quits on Ctrl+C, held or tapped"
    );
}

/// [FALSIFIER] Site 4. The arm expires, at the boundary instant and not a tick
/// later.
///
/// Sampled at three offsets across the window rather than at two convenient
/// ones: just inside, exactly on the deadline, and just past it. The middle
/// sample is the one with an answer to defend — `>=` and `>` differ only there,
/// and upstream's `expired()` is `>=`
/// (`D:\grok-ref\...\app\app_view.rs:530-532`).
///
/// MUTATION: change `now < deadline` in `quit_is_armed_at` to `now <= deadline`
/// — the plausible mistake, and the one a careful reader makes — and the
/// boundary row goes red: the room exits where it should have cancelled.
///
/// ⚠ **That mutation only bites because the rule is written ONCE.** The first
/// version of this slice carried the same comparison twice, negated, in
/// `reconcile_quit_arm_at` as well; `reconcile` runs first on the key route, so
/// each copy hid the other's mutation and BOTH survived this test. `reconcile`
/// now derives from `quit_is_armed_at`. Recorded here because a future reader
/// re-inlining it for clarity would silently un-arm this proof.
#[tokio::test]
async fn the_arm_expires() {
    let window = QUIT_CONFIRM_WINDOW;
    for (label, offset, quits) in [
        (
            "one tick inside the window",
            window - Duration::from_millis(1),
            true,
        ),
        ("exactly on the deadline", window, false),
        ("one tick past it", window + Duration::from_millis(1), false),
    ] {
        let mut keys = Keys::new();
        let mut room = one_running();
        let now = Instant::now();

        keys.press_at(&mut room, ctrl_c(), now).await;
        assert_eq!(
            keys.drain(),
            vec![CANCEL_ALL.to_owned()],
            "{label}: the arming press"
        );

        let routed = keys.press_at(&mut room, ctrl_c(), now + offset).await;
        assert_eq!(
            exited(&routed),
            quits,
            "{label}: whether the second press quits"
        );
        assert_eq!(
            keys.drain(),
            if quits {
                vec![]
            } else {
                vec![CANCEL_ALL.to_owned()]
            },
            "{label}: an expired arm re-cancels rather than quitting"
        );
    }
}

/// [FALSIFIER] The lanes reaching idle clears the arm, even inside the window.
///
/// This is the arm's third clear and it is a real product consequence, not a
/// technicality: a room that cancels fast enough turns the operator's second
/// Ctrl+C back into today's idle behaviour. It is deliberate — upstream gates
/// its own escalation on cancellation still being pending
/// (`D:\grok-ref\...\app\agent_view\input.rs:1339-1341`) and separately
/// invalidates an arm whose meaning the state moved under (`app_view.rs:2477`).
/// An arm that outlives the room it was armed in offers to quit over a room
/// with nothing left to stop.
///
/// MUTATION: drop `&& lane_busy(...)` from `quit_is_armed_at` and this goes red
/// at the `reconcile` assertion, together with the stale-arm row of
/// `the_hint_row_is_the_four_rung_ladder` — the row starts offering a quit over
/// a room with nothing left to stop.
#[tokio::test]
async fn the_lanes_going_idle_clear_the_arm() {
    let now = Instant::now();
    let mut keys = Keys::new();
    let mut room = one_running();
    keys.press_at(&mut room, ctrl_c(), now).await;
    assert!(room.quit_armed_until.is_some(), "armed by the first press");
    keys.drain();

    // The host answers: the lane cancels and settles. Same room, real events.
    let settled = RoomFixture::new()
        .turn("turn-1", &["claude"])
        .started("turn-1", "claude")
        .cancelling("turn-1", "claude")
        .cancelled("turn-1", "claude")
        .done();
    room.reducer = settled.reducer;
    assert!(
        !lane_busy(&room.reducer, None),
        "the room really is idle now"
    );

    assert!(
        reconcile_quit_arm_at(&mut room, now + Duration::from_millis(10)),
        "reconciling an idle room must report that it cleared the arm, so the \
         frame that noticed can repaint"
    );
    assert_eq!(room.quit_armed_until, None);

    // And with a draft, the second press is now rung 4 — it clears the composer
    // rather than ending the room. Stated as an assertion because it is the
    // consequence an operator can feel.
    //
    // ⚠ The release is load-bearing, not decoration. Two Ctrl+C key events 20 ms
    // apart with nothing in between is a HELD key, and a held key gets one
    // action — including at rung 4, where the action destroys a draft. Without
    // the release this case would be asking the room to lose the operator's text
    // to autorepeat.
    room.prompt.set_text("half a question");
    keys.press_at(&mut room, ctrl_c_release(), now + Duration::from_millis(15))
        .await;
    let routed = keys
        .press_at(&mut room, ctrl_c(), now + Duration::from_millis(20))
        .await;
    assert!(!exited(&routed), "an idle room with a draft does not quit");
    assert_eq!(
        room.prompt.text(),
        "",
        "it clears the draft, as it does today"
    );
}

/// [FALSIFIER] Site 5. Any other accepted key disarms — whoever takes it.
///
/// Three owners, because the disarm sits above the routing and a version that
/// sits inside `handle_key_at` would look correct on the composer row and be
/// wrong on the other two. `Ctrl+E` is the feed's; `Esc` over an active shelf is
/// the shelf's; `x` is the composer's.
///
/// MUTATION: move the `room.quit_armed_until = None` line from
/// `route_room_key_at` into `handle_key_at`, below the permission and feed
/// arms, and the first two rows go red — the room quits on a key the shelf ate.
#[tokio::test]
async fn any_other_key_disarms_the_quit() {
    let cases: [(&str, fn() -> RoomView, KeyEvent, KeyDisposition); 3] = [
        (
            "a feed key",
            one_running,
            KeyEvent::new(KeyCode::Char('e'), KeyModifiers::CONTROL),
            KeyDisposition::Feed,
        ),
        (
            "a shelf key",
            shelf_room,
            esc(),
            KeyDisposition::PermissionShelf,
        ),
        (
            "a composer key",
            one_running,
            KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE),
            KeyDisposition::Composer,
        ),
    ];
    for (label, build, key, owner) in cases {
        let mut keys = Keys::new();
        let mut room = build();
        let now = Instant::now();

        keys.press_at(&mut room, ctrl_c(), now).await;
        assert_eq!(keys.drain(), vec![CANCEL_ALL.to_owned()], "{label}: armed");

        let routed = keys
            .press_at(&mut room, key, now + Duration::from_millis(50))
            .await;
        assert_eq!(
            std::mem::discriminant(&routed),
            std::mem::discriminant(&owner),
            "{label}: the disarming key must still reach its own owner"
        );
        assert_eq!(
            room.quit_armed_until, None,
            "{label}: an accepted key that is not the confirmation disarms"
        );
        keys.drain();

        let after = keys
            .press_at(&mut room, ctrl_c(), now + Duration::from_millis(60))
            .await;
        assert!(
            !exited(&after),
            "{label}: after a disarm, Ctrl+C cancels again — it does not quit"
        );
        assert_eq!(
            keys.drain(),
            vec![CANCEL_ALL.to_owned()],
            "{label}: and it re-cancels"
        );
    }
}

// The pre-BLOCK-2 `a_failed_send_does_not_arm` lived here. It has moved rather
// than gone: the panic button no longer sends on the command wire at all, so its
// scenario is now `a_dead_cancel_wire_arms_nothing`, beside the rest of the
// claim proofs, together with the case it never had — a wire that is FULL, which
// is a different answer from one that is closed.

// ---------------------------------------------------------------------------
// Site 6 — the hint row
// ---------------------------------------------------------------------------

const HINT_ARMED: &str = "agents stopped — press ctrl+c again to quit";
const HINT_STOPPING: &str = "stopping agents — press ctrl+c again to quit";
const HINT_INTERRUPT: &str = "esc to interrupt";
const HINT_FIRST_RUN: &str =
    "type to start · @claude, @codex, @gemini to route · everyone answers by default";

/// A width every rung's full form fits in, so this file's subject stays the
/// LADDER and never quietly becomes slice D's narrow-width behaviour.
const WIDE_ENOUGH: u16 = 120;

fn row_text(room: &RoomView, now: Instant) -> String {
    guidance_row_at(room, now, WIDE_ENOUGH)
        .line
        .spans
        .iter()
        .map(|span| span.content.as_ref())
        .collect()
}

/// [FALSIFIER] Site 6. The guidance row's four rungs, in their order.
///
/// RED before this slice: `guidance_row` had one rung, so every running row
/// below read the empty string.
///
/// ⚠ **The table is asserted, not only its rows.** A table-driven test that
/// checks each row against its own expected value proves nothing about the
/// table: the wrong table passes cheerfully. So the SET of distinct outputs is
/// compared against the ladder's documented contents as well — four rungs, no
/// fifth — and every one of them is required to appear. That closes the hole
/// where a state quietly stops being covered and the remaining rows still pass.
/// Its exact reach, measured rather than claimed: deleting the ONLY row that
/// reaches a rung reddens it, and so does a wrong expected value in any row —
/// but deleting one of TWO rows that reach the same rung does not, and that
/// mutation was run and stayed green. Redundant coverage is not a defect; the
/// limit is written down so nobody reads this as more than it is.
///
/// ⚠ **What the wave-0 zero-drift pin could not see, recorded because it was
/// checked:** `guidance_row_paints_what_the_inline_paragraph_painted` stayed
/// GREEN through this slice, and correctly — its five fixtures reach `Queued`
/// lanes only, and `lane_busy` matches `Running | Cancelling`. It was never
/// able to observe rungs 1 and 2. This test is what observes them.
/// ⚠ **Rung 1 has TWO spellings since BLOCK 2, and both are in the table.** The
/// room is only allowed to say `agents stopped` once the host has answered the
/// cancel; until then it says `stopping agents`. A table that carried only the
/// confirmed spelling would go green against a room that never hedges — which is
/// the defect — so the unconfirmed row below is the one that matters, and the
/// ladder set names five members rather than four.
#[test]
fn the_hint_row_is_the_four_rung_ladder() {
    let now = Instant::now();
    // The arm, with the host's answer NOT yet in. This is the state the room is
    // in for every instant between the keypress and the host replying, and it is
    // the state the old row lied about.
    let armed_unconfirmed = {
        let mut room = one_cancelling();
        room.quit_armed_until = Some(now + QUIT_CONFIRM_WINDOW);
        room.cancel_claim = crate::room_view::RoomCancelClaim::Idle.ask();
        room
    };
    let armed = {
        let mut room = one_cancelling();
        room.quit_armed_until = Some(now + QUIT_CONFIRM_WINDOW);
        let asked = crate::room_view::RoomCancelClaim::Idle.ask();
        room.cancel_claim = asked.answered(asked.seq());
        assert!(
            room.cancel_claim.host_answered(),
            "the fixture must really hold a host-answered cancel"
        );
        room
    };
    let expired_arm = {
        let mut room = one_running();
        room.quit_armed_until = Some(now - Duration::from_millis(1));
        room
    };
    let idle_arm = {
        let mut room = RoomView::new();
        room.quit_armed_until = Some(now + QUIT_CONFIRM_WINDOW);
        room
    };
    let spoken_idle = RoomFixture::new()
        .turn("turn-1", &["claude"])
        .started("turn-1", "claude")
        .cancelling("turn-1", "claude")
        .cancelled("turn-1", "claude")
        .done();
    let drafting = {
        let mut room = RoomView::new();
        room.prompt.set_text("half a question");
        room
    };

    let cases: Vec<(&str, RoomView, &str)> = vec![
        (
            "rung 1 — armed, and the host has answered the cancel",
            armed,
            HINT_ARMED,
        ),
        (
            "rung 1 — armed, but nobody has confirmed anything stopped yet",
            armed_unconfirmed,
            HINT_STOPPING,
        ),
        ("rung 2 — a running lane", one_running(), HINT_INTERRUPT),
        (
            "rung 2 — a cancelling lane is still running work",
            one_cancelling(),
            HINT_INTERRUPT,
        ),
        (
            "rung 2 — an arm past its deadline falls through",
            expired_arm,
            HINT_INTERRUPT,
        ),
        (
            "rung 4 — first run, nothing said, nothing typed",
            RoomView::new(),
            HINT_FIRST_RUN,
        ),
        (
            "rung 4 is not reached — an idle room that has spoken",
            spoken_idle,
            "",
        ),
        ("rung 4 is not reached — a draft", drafting, ""),
        (
            "an arm over an idle room is stale — it falls through to rung 4",
            idle_arm,
            HINT_FIRST_RUN,
        ),
    ];

    let mut painted: Vec<&str> = Vec::new();
    for (label, room, expected) in &cases {
        assert_eq!(&row_text(room, now), expected, "guidance row at: {label}");
        painted.push(expected);
    }

    painted.sort_unstable();
    painted.dedup();
    let mut ladder = vec![
        HINT_ARMED,
        HINT_STOPPING,
        HINT_INTERRUPT,
        HINT_FIRST_RUN,
        "",
    ];
    ladder.sort_unstable();
    assert_eq!(
        painted, ladder,
        "the states above no longer reach every rung of the ladder — a rung this \
         table cannot reach is a rung nothing here asserts. There are four rungs \
         and no fifth: an unavailable agent's remedy is on the boot card. Rung 1 \
         has two spellings, and dropping the unconfirmed one is how the room goes \
         back to claiming the agents stopped before anyone told them."
    );
}

/// [PIN] Rung 1 sits above rung 2, and the order is the whole point.
///
/// After the first Ctrl+C the lanes are `Cancelling`, so rung 2 is still true.
/// A ladder ordered by novelty puts the newest arm last and the notice never
/// paints — the operator is told to press Esc while the room is waiting for
/// their second Ctrl+C.
///
/// MUTATION: swap rungs 1 and 2 in `guidance_row_at` — the plausible mistake,
/// since "while any lane is running" reads like the more general case — and
/// this goes red with `esc to interrupt` where the armed notice belongs.
#[test]
fn the_armed_notice_outranks_the_interrupt_hint() {
    let now = Instant::now();
    let mut room = one_cancelling();
    room.quit_armed_until = Some(now + QUIT_CONFIRM_WINDOW);
    assert!(
        lane_busy(&room.reducer, None),
        "the room must be busy here, or the two rungs are not in competition"
    );
    // Asserted for BOTH spellings of rung 1, because the competition with rung 2
    // is about the rung, not about which words it is currently using — and a
    // version that only outranked rung 2 once the host had answered would show
    // `esc to interrupt` during exactly the window the operator is deciding
    // whether to press Ctrl+C again.
    assert_eq!(row_text(&room, now), HINT_STOPPING);
    let asked = room.cancel_claim.ask();
    room.cancel_claim = asked.answered(asked.seq());
    assert_eq!(row_text(&room, now), HINT_ARMED);
}

// ---------------------------------------------------------------------------
// Sites 7, 8, 10 — the pins
// ---------------------------------------------------------------------------

/// [PIN] Site 7. The permission shelf keeps Esc.
///
/// Driven through `route_room_key_at` and not `route_permission_key`: a test
/// that calls the shelf's own router directly stays green under exactly the
/// production defect this pin exists to catch, because the defect is one of
/// ORDER and a direct call has no order to get wrong.
///
/// MUTATION: move the Esc cancel arm from just above `route_enter` up into
/// `route_room_key_at`, ahead of `route_permission_key` — the shape a reader
/// reaches for when they want "Esc always interrupts" — and this goes red: a
/// `cancel/all/-` appears and the shelf keeps focus.
#[tokio::test]
async fn esc_over_a_permission_shelf_still_dismisses_the_shelf() {
    let mut keys = Keys::new();
    let mut room = shelf_room();
    room.permissions.focus_shelf();
    assert!(
        room.permissions.is_focused(),
        "the shelf must start focused"
    );
    assert!(
        lane_busy(&room.reducer, None),
        "and the room must be busy, or the cancel arm is not even in play"
    );

    let routed = keys.press_at(&mut room, esc(), Instant::now()).await;

    assert_eq!(
        std::mem::discriminant(&routed),
        std::mem::discriminant(&KeyDisposition::PermissionShelf),
        "the shelf owns Esc and takes it before the cancel arm"
    );
    assert!(
        !room.permissions.is_focused(),
        "Esc moves focus to the composer"
    );
    assert_eq!(
        keys.drain(),
        Vec::<String>::new(),
        "dismissing a shelf must not stop the agents"
    );
}

/// [PIN] Site 8. An idle room with an empty composer quits on Ctrl+C, exactly
/// as it does today.
///
/// MUTATION: make the room-wide busy result true for an idle reducer — the real
/// target, since "the idle predicate" names no symbol: give `lane_busy` an
/// `agent.is_none() ||` short-circuit — and this goes red with a
/// `cancel/all/-` in the channel and no exit.
#[tokio::test]
async fn ctrl_c_while_idle_quits_immediately() {
    let mut keys = Keys::new();
    let mut room = RoomView::new();
    assert!(!lane_busy(&room.reducer, None), "the fixture must be idle");

    let routed = keys.press_at(&mut room, ctrl_c(), Instant::now()).await;

    assert!(exited(&routed), "an idle room with an empty composer quits");
    assert_eq!(keys.drain(), Vec::<String>::new(), "and sends nothing");
}

/// [PIN] A whitespace-only draft is an empty composer, here as everywhere.
///
/// Two emptiness rules read the same buffer and they do not agree: the room's
/// guard trims (`route_ctrl_c_at`) and the widget's does not
/// (`views/prompt_widget/mod.rs:1840`). Today a whitespace draft exits at the
/// room's guard and never reaches the widget. Drop the `trim()` and the case
/// silently changes owner — the room stops quitting and the widget clears three
/// spaces instead — with no other test in the tree able to tell.
///
/// MUTATION: delete `.trim()` from rung 3 and this goes red: no exit.
#[tokio::test]
async fn a_whitespace_draft_still_quits() {
    let mut keys = Keys::new();
    let mut room = RoomView::new();
    room.prompt.set_text("   ");

    let routed = keys.press_at(&mut room, ctrl_c(), Instant::now()).await;

    assert!(exited(&routed), "whitespace is not a draft");
    assert_eq!(keys.drain(), Vec::<String>::new());
}

/// [PIN] Site 10, first half. A picker owns Ctrl+C — draft or no draft, running
/// lanes or not.
///
/// ⚠ **This pin records a hole rather than closing it (FL-103): with a picker
/// open while agents run, Ctrl+C quits the room and sends NO cancel.** Repairing
/// the picker's key routing is its own change with its own falsifiers; widening
/// slice B to reach it is how a bounded slice stops being reviewable. The pin is
/// what stops it from being changed by accident.
///
/// MUTATION: move the Ctrl+C ladder above the picker check in `handle_key_at`
/// and this goes red — a `cancel/all/-` appears where the exit belongs.
#[tokio::test]
async fn a_picker_still_owns_ctrl_c() {
    let mut keys = Keys::new();
    let mut room = one_running();
    let catalog = room.catalog.clone();
    room.picker.open_skills(RoomCatalogAgent::Claude, &catalog);
    room.prompt.set_text("a draft that must not matter");
    assert!(
        room.picker.is_open(),
        "the fixture must hold an open picker"
    );
    assert!(lane_busy(&room.reducer, None), "and a running lane");

    let routed = keys.press_at(&mut room, ctrl_c(), Instant::now()).await;

    assert!(exited(&routed), "an open picker quits on Ctrl+C");
    assert_eq!(
        keys.drain(),
        Vec::<String>::new(),
        "FL-103: and it stops nothing on the way out"
    );
}

/// [PIN] Site 10, second half. History search owns Ctrl+C: it closes the search
/// and restores the saved text, and does not quit.
///
/// Separately mutated from the picker half, because the prescribed single
/// picker mutation leaves this assertion dead while the compound test still
/// reddens.
///
/// The saved text is `""` because both production call sites save `""` —
/// `/history` (`ParsedRoomCommand::History`) and `Up` on an empty composer both
/// pass an empty `current_text` to `activate`/`activate_browse`, and the
/// browser then live-populates the composer with the selected entry. So
/// "restores the saved text" means the composer goes back to empty, and the
/// assertion below is what distinguishes that from merely closing the panel and
/// leaving the populated entry sitting in the draft.
///
/// MUTATION: move the Ctrl+C ladder above the history check in `handle_key_at`
/// and this goes red — the room exits and the composer is never restored.
#[tokio::test]
async fn a_history_search_still_owns_ctrl_c() {
    let mut keys = Keys::new();
    let mut room = one_running();
    room.history = vec![crate::views::history_search::HistoryEntry {
        text: "an earlier question".to_owned(),
    }];
    room.prompt.history_search.activate(&room.history, "");
    // What `populate_history_selection` does once the browser has a selection.
    room.prompt.set_text("an earlier question");
    assert!(
        room.prompt.history_search.is_active(),
        "the fixture must hold an active history search"
    );

    let routed = keys.press_at(&mut room, ctrl_c(), Instant::now()).await;

    assert!(
        !exited(&routed),
        "history's Ctrl+C closes the search, it does not quit"
    );
    assert!(!room.prompt.history_search.is_active(), "and it closes it");
    assert_eq!(
        room.prompt.text(),
        "",
        "restoring the saved draft is the behaviour, not merely closing — the \
         populated entry must not be left behind in the composer"
    );
    assert_eq!(keys.drain(), Vec::<String>::new());
}

/// [PIN] A Ctrl+C that history consumed is not a confirmation.
///
/// It never reached the ladder, so by the arm's own rule — any other accepted
/// keypress disarms — it disarms. Without this, opening the history browser
/// between the two taps leaves a quit primed behind a key the operator used for
/// something else.
///
/// MUTATION: delete the `room.quit_armed_until = None` inside the history arm of
/// `handle_key_at` and this goes red: the room exits on the third press.
#[tokio::test]
async fn history_consuming_ctrl_c_disarms_the_quit() {
    let mut keys = Keys::new();
    let mut room = one_running();
    let now = Instant::now();
    room.history = vec![crate::views::history_search::HistoryEntry {
        text: "an earlier question".to_owned(),
    }];

    keys.press_at(&mut room, ctrl_c(), now).await;
    assert!(room.quit_armed_until.is_some(), "armed");
    keys.drain();

    // ⚠ Each press is preceded by the release of the one before it, because
    // three Ctrl+C key events 20 ms apart with the key never coming up is a HELD
    // key, and the room deliberately gives a held key one action. The test is
    // about the ARM, not about autorepeat; spelling the releases keeps the input
    // something a hand can produce so the arm is what it measures.
    keys.press_at(&mut room, ctrl_c_release(), now + Duration::from_millis(10))
        .await;
    room.prompt.history_search.activate(&room.history, "");
    keys.press_at(&mut room, ctrl_c(), now + Duration::from_millis(20))
        .await;
    assert_eq!(room.quit_armed_until, None, "history's Ctrl+C disarmed it");

    keys.press_at(&mut room, ctrl_c_release(), now + Duration::from_millis(30))
        .await;
    let after = keys
        .press_at(&mut room, ctrl_c(), now + Duration::from_millis(40))
        .await;
    assert!(
        !exited(&after),
        "so the next Ctrl+C cancels rather than quitting"
    );
    assert_eq!(keys.drain(), vec![CANCEL_ALL.to_owned()]);
}

// ---------------------------------------------------------------------------
// Site 9 — the draft
// ---------------------------------------------------------------------------

/// [FALSIFIER] Site 9, first half. A running Ctrl+C cancels and leaves the whole
/// composer alone.
///
/// RED before this slice, twice over: the draft short-circuited the arm
/// (`room.prompt.text().trim().is_empty()` was an outer condition, so a draft
/// meant no exit AND no cancel), and the fall-through cleared the composer at
/// `views/prompt_widget/mod.rs:1843`. Both halves are quoted in the handback.
///
/// Split from the idle half below on purpose: one test asserting two
/// independent behaviours reports the first panic and never executes the second
/// observation.
#[tokio::test]
async fn ctrl_c_while_running_cancels_and_leaves_the_draft_alone() {
    let mut keys = Keys::new();
    let mut room = one_running();
    room.prompt.set_text("a question I am still writing");
    room.prompt.set_cursor(9);
    let now = Instant::now();

    let routed = keys.press_at(&mut room, ctrl_c(), now).await;

    assert_eq!(keys.drain(), vec![CANCEL_ALL.to_owned()], "it cancels");
    assert_eq!(
        room.quit_armed_until,
        Some(now + QUIT_CONFIRM_WINDOW),
        "and arms"
    );
    assert!(!exited(&routed), "and does not quit");
    assert_eq!(
        room.prompt.text(),
        "a question I am still writing",
        "the draft survives byte for byte — a panic button a draft can disable \
         is not a panic button, and one that eats the draft is a different bug"
    );
    assert_eq!(room.prompt.cursor(), 9, "and so does the caret");
}

/// [FALSIFIER] Site 9, second half. The instant the lanes are idle, Ctrl+C
/// clears the draft again — rung 4, today's behaviour, which nothing pinned
/// before this slice and which this slice must not delete.
///
/// A fresh idle room, not the room above with its lanes retired, because the
/// first assertion's failure must not be able to hide this one.
///
/// MUTATION: return `CtrlCOutcome::Consumed` instead of `FallThrough` from the
/// last arm of `route_ctrl_c_at` — the plausible tidy-up, since every other arm
/// returns something — and this goes red with the draft still there.
#[tokio::test]
async fn ctrl_c_while_idle_still_clears_the_draft() {
    let mut keys = Keys::new();
    let mut room = RoomView::new();
    room.prompt.set_text("a question I am still writing");
    assert!(!lane_busy(&room.reducer, None), "the fixture must be idle");

    let routed = keys.press_at(&mut room, ctrl_c(), Instant::now()).await;

    assert!(!exited(&routed), "a draft still stops the idle quit");
    assert_eq!(
        room.prompt.text(),
        "",
        "and the composer clears, as it does today"
    );
    assert_eq!(keys.drain(), Vec::<String>::new(), "with nothing sent");
}

// ---------------------------------------------------------------------------
// Site 11 — the file-search dropdown
// ---------------------------------------------------------------------------

/// Make the `@`-completion dropdown really visible, by typing into the room.
///
/// Through `route_room_key_at`, so the dropdown is opened the way an operator
/// opens it and not by writing state into a struct. The search root is
/// retargeted to this crate's own directory — a compile-time path, so the test
/// does not depend on the process's working directory — and the query is a real
/// file in it.
///
/// The draft deliberately does not start with `@`: a leading `@` opens the room's
/// address menu instead, which is a different Esc consumer and would prove the
/// wrong thing.
async fn room_with_a_visible_dropdown(keys: &Keys, room: &mut RoomView) {
    room.prompt
        .file_search
        .retarget(std::path::Path::new(env!("CARGO_MANIFEST_DIR")));
    for ch in "see @Cargo".chars() {
        keys.press_at(
            room,
            KeyEvent::new(KeyCode::Char(ch), KeyModifiers::NONE),
            Instant::now(),
        )
        .await;
    }
    assert!(
        room.prompt.file_search.is_visible(),
        "the dropdown must really be visible, or the gate below is being tested \
         against a state it never sees; draft is {:?}",
        room.prompt.text()
    );
}

/// [FALSIFIER] Site 11. Esc dismisses the file-search dropdown before it
/// cancels anything.
///
/// The dropdown is the one Esc consumer DOWNSTREAM of the cancel arm — it takes
/// Esc through `route_enter`'s pass-through into
/// `views/prompt_widget/mod.rs:2059` — so it is the only one the arm can steal
/// from, and nothing else in the tree catches it.
///
/// Two REDs, both quoted in the handback: against the tree before this slice the
/// SECOND Esc sends no cancel (nothing did), and against an arm written without
/// the `!room.prompt.file_search.is_visible()` gate the FIRST Esc steals the
/// dismiss.
///
/// The visibility assertion before the first press is the positive control: an
/// absent cancel proves nothing if the dropdown was never open.
#[tokio::test]
async fn esc_dismisses_the_file_search_dropdown_before_it_cancels() {
    let mut keys = Keys::new();
    let mut room = one_running();
    room_with_a_visible_dropdown(&keys, &mut room).await;
    keys.drain();

    keys.press_at(&mut room, esc(), Instant::now()).await;
    assert!(
        !room.prompt.file_search.is_visible(),
        "the first Esc dismisses the dropdown"
    );
    assert_eq!(
        keys.drain(),
        Vec::<String>::new(),
        "and stops nothing: an operator half-way through a path did not ask to \
         cancel three agents"
    );

    keys.press_at(&mut room, esc(), Instant::now()).await;
    assert_eq!(
        keys.drain(),
        vec![CANCEL_ALL.to_owned()],
        "the second Esc, with the dropdown closed, cancels"
    );
}

// ---------------------------------------------------------------------------
// The slash menu, and the ConPTY helper that depends on it
// ---------------------------------------------------------------------------

/// [PIN] After a full `/cancel` is typed, the slash menu is still open — so it
/// still owns Esc.
///
/// ⚠ **This is not a curiosity. `conpty_ui.rs`'s `submit_room_command`
/// (`:759-770`) types the command, sends a REAL VK_ESCAPE, then Enter**, and
/// three of its four uses are `/cancel` and `/pause` in a room with lanes in
/// flight. If the slash menu were closed at that point the Esc would fall
/// through to slice B's cancel arm and the helper would emit a cancel nobody
/// asked for, ahead of the command it was about to submit.
///
/// It is open because `refresh_frontend` sets `snap.open = !snap.matches.is_
/// empty()` (`slash_frontend.rs:177`) and `cancel`, `pause` and `unpause` are
/// all in the room's frontend catalog (`room_view.rs:143-180`).
///
/// ⚠ **And the limit of that, which is the finding:** the token before the
/// cursor has to start with `/`. After `/cancel latest` the token is `latest`,
/// the menu is closed, and the Esc WOULD reach the cancel arm. No ConPTY test
/// submits an argument today; one that does must send no Esc.
///
/// MUTATION: remove `cancel` from the room's frontend catalog and the first row
/// goes red.
#[test]
fn the_slash_menu_still_owns_esc_after_a_command_is_typed() {
    for (typed, open) in [
        ("/cancel", true),
        ("/pause", true),
        ("/unpause", true),
        ("/cancel latest", false),
    ] {
        let mut room = RoomView::new();
        room.prompt.set_text(typed);
        room.prompt.set_cursor(typed.len());
        room.prompt.refresh_frontend_slash();
        assert_eq!(
            room.prompt.slash_open(),
            open,
            "slash menu open after typing {typed:?}"
        );
    }
}

/// [PIN] The room's Esc consumers keep their order, and the cancel arm is last.
///
/// One assertion per consumer, driven through the production router, so a
/// reordering shows up as a named row rather than as a mysterious cancel.
/// Upstream states the same ordering as policy — overlays, dropdowns and search
/// steal Esc before cancellation
/// (`D:\grok-ref\...\app\agent_view\mod.rs:10-12`).
///
/// MUTATION: hoist the cancel arm above the slash-menu arm in `handle_key_at`
/// and the slash row goes red with a `cancel/all/-`.
#[tokio::test]
async fn every_earlier_esc_consumer_still_takes_esc_first() {
    // The slash menu, over a busy room.
    let mut keys = Keys::new();
    let mut room = one_running();
    room.prompt.set_text("/cancel");
    room.prompt.set_cursor("/cancel".len());
    room.prompt.refresh_frontend_slash();
    assert!(room.prompt.slash_open(), "the slash menu must be open");
    keys.press_at(&mut room, esc(), Instant::now()).await;
    assert!(!room.prompt.slash_open(), "Esc closes the slash menu");
    assert_eq!(keys.drain(), Vec::<String>::new(), "and cancels nothing");

    // The picker, over a busy room.
    let mut keys = Keys::new();
    let mut room = one_running();
    let catalog = room.catalog.clone();
    room.picker.open_skills(RoomCatalogAgent::Claude, &catalog);
    keys.press_at(&mut room, esc(), Instant::now()).await;
    assert!(!room.picker.is_open(), "Esc closes the picker");
    assert_eq!(
        keys.drain(),
        vec!["cancel-picker".to_owned()],
        "the picker cancels ITS request, not the room's agents"
    );

    // History search, over a busy room.
    let mut keys = Keys::new();
    let mut room = one_running();
    room.history = vec![crate::views::history_search::HistoryEntry {
        text: "an earlier question".to_owned(),
    }];
    room.prompt.set_text("what I was typing");
    room.prompt.history_search.activate(&room.history, "");
    keys.press_at(&mut room, esc(), Instant::now()).await;
    assert!(
        !room.prompt.history_search.is_active(),
        "Esc closes history"
    );
    assert_eq!(keys.drain(), Vec::<String>::new(), "and cancels nothing");

    // The composer's address menu, over a busy room.
    let mut keys = Keys::new();
    let mut room = one_running();
    for ch in "@cl".chars() {
        keys.press_at(
            &mut room,
            KeyEvent::new(KeyCode::Char(ch), KeyModifiers::NONE),
            Instant::now(),
        )
        .await;
    }
    let draft = room.prompt.text().to_owned();
    let cursor = room.prompt.cursor();
    assert!(
        room.composer_menu
            .snapshot(&draft, cursor, &room.catalog)
            .is_some(),
        "the address menu must be open"
    );
    keys.drain();
    keys.press_at(&mut room, esc(), Instant::now()).await;
    assert_eq!(
        keys.drain(),
        Vec::<String>::new(),
        "dismissing the address menu must not stop the agents"
    );
}

/// [PIN] `KeyEventState` is not part of the bare-Esc test.
///
/// ConPTY's own key records carry state bits the room never inspects, and a
/// `key.state.is_empty()` term in `is_bare_esc` would make the real-terminal Esc
/// stop cancelling while every unit test here stayed green. Written down as an
/// assertion because that is a defect a unit suite is structurally blind to.
#[tokio::test]
async fn esc_cancels_whatever_state_bits_the_terminal_attaches() {
    let mut keys = Keys::new();
    let mut room = one_running();
    let key = KeyEvent::new_with_kind_and_state(
        KeyCode::Esc,
        KeyModifiers::NONE,
        KeyEventKind::Press,
        KeyEventState::KEYPAD,
    );
    keys.press_at(&mut room, key, Instant::now()).await;
    assert_eq!(keys.drain(), vec![CANCEL_ALL.to_owned()]);
}

// ---------------------------------------------------------------------------
// The held key — BLOCK 1 of the slice-B review
// ---------------------------------------------------------------------------

/// `one_running`, kept as the LIVE fixture instead of a finished room.
///
/// ⚠ Every case below turns on state the room accumulates ACROSS presses, and
/// `RoomFixture::new()...done()` builds a fresh `RoomView` — which resets that
/// state. A case that rebuilds the room between the two presses is asserting
/// against a room that never saw the first one, and it passes against a
/// completely unguarded implementation. So the lane is moved by emitting into
/// the fixture that already holds the room, and the room is never rebuilt.
fn running_fixture() -> RoomFixture {
    let fixture = RoomFixture::new()
        .turn("turn-1", &["claude"])
        .started("turn-1", "claude");
    assert_eq!(
        phase_count(&fixture.room.reducer, LanePhase::Running),
        1,
        "the fixture must really hold one running lane"
    );
    assert!(
        lane_busy(&fixture.room.reducer, None),
        "and the room must read busy"
    );
    fixture
}

/// The release of the Ctrl+C key.
///
/// **No CONTROL bit, and that is not a shortcut.** Whichever of the two keys
/// the operator lifts first decides what the terminal reports: lift Ctrl first
/// and the `c` release carries no modifier at all. Upstream hit exactly this
/// and matches its own chord release on the key alone for the same reason
/// (`D:\grok-ref\crates\codegen\xai-grok-pager\src\app\event_loop.rs:3779-3787`
/// — *"on Kitty the Ctrl release can precede Space and drop the CONTROL bit"*).
/// A release predicate that demanded CONTROL would never fire for half the ways
/// a human lets go of these two keys, and the room would behave as though the
/// key were still held forever.
fn ctrl_c_release() -> KeyEvent {
    KeyEvent::new_with_kind(
        KeyCode::Char('c'),
        KeyModifiers::NONE,
        KeyEventKind::Release,
    )
}

/// [FALSIFIER] BLOCK 1. A HELD Ctrl+C cannot confirm the quit on a terminal
/// that does not report `Repeat`.
///
/// This is the operator's original bug, still reachable after the slice that
/// exists to fix it. The shipped guard treats `KeyEventKind::Press` as proof of
/// a new tap and consumes `Repeat` — but this repository documents, in its own
/// module header, that `Repeat` is the thing that does not exist off Kitty:
///
/// > `KeyEventKind::Repeat` disappears: held keys arrive as repeated `Press`,
/// > as on every non-KKP terminal
/// > (`xai-grok-pager-render/src/terminal/kitty_keyboard.rs:28-31`)
///
/// So on the common terminal, holding Ctrl+C delivers `Press`, `Press`,
/// `Press` — and the second one confirms. Cancel, then instant exit, from one
/// gesture.
///
/// RED against the tree this test was written on: the second press exits.
///
/// What wrong implementation would still pass this? One that refuses EVERY
/// second Ctrl+C — no: `a_release_between_the_presses_still_quits` and
/// `a_quiet_gesture_can_still_quit_without_any_release` both require the quit
/// to stay reachable. One that keys off the `Repeat` kind — no: both events
/// here are `Press`. One that only guards the armed rung — no:
/// `a_held_ctrl_c_cannot_exit_through_the_idle_rung` closes the other path.
#[tokio::test]
async fn a_held_ctrl_c_cannot_confirm_the_quit_without_a_release() {
    let mut keys = Keys::new();
    let mut fixture = running_fixture();
    let now = Instant::now();

    let first = keys.press_at(&mut fixture.room, ctrl_c(), now).await;
    assert!(!exited(&first), "the first Ctrl+C must not end the room");
    assert_eq!(keys.drain(), vec![CANCEL_ALL.to_owned()]);

    // What a real host reports next, and what keeps rung 2 true so that the
    // armed rung is the one under test.
    fixture = fixture.cancelling("turn-1", "claude");
    assert!(
        lane_busy(&fixture.room.reducer, None),
        "a cancelling lane is still busy, which is why rung 1 is reachable here"
    );

    // Autorepeat, as the common terminal delivers it: another `Press`, with no
    // release in between because the operator never let go.
    let held = keys
        .press_at(
            &mut fixture.room,
            ctrl_c(),
            now + Duration::from_millis(500),
        )
        .await;
    assert!(
        !exited(&held),
        "a held Ctrl+C is one gesture: the terminal calling its autorepeat a `Press` must not turn it into a second tap"
    );
    assert_eq!(
        keys.drain(),
        Vec::<String>::new(),
        "and the held key must not re-cancel either"
    );
}

/// [FALSIFIER] BLOCK 1, second path. A settling lane must not hand the held key
/// to the idle-exit rung.
///
/// Even where `Repeat` is real, the arm is not the only way out of this ladder.
/// The arm clears the moment the lanes reach idle (`reconcile_quit_arm_at`), so
/// a cancellation that settles between the two events leaves rung 1 false and
/// rung 3 — idle room, empty composer — true. The same held key then exits
/// through a different door, and the room is gone.
///
/// RED against the tree this test was written on: the second press exits.
///
/// What wrong implementation would still pass? One that guards only the armed
/// rung — no: there is no arm left by the time the second event arrives, which
/// is the whole point. The `quit_armed_until.is_none()` assertion below is what
/// makes that non-negotiable rather than incidental.
#[tokio::test]
async fn a_held_ctrl_c_cannot_exit_through_the_idle_rung() {
    let mut keys = Keys::new();
    let mut fixture = running_fixture();
    let now = Instant::now();

    keys.press_at(&mut fixture.room, ctrl_c(), now).await;
    assert_eq!(keys.drain(), vec![CANCEL_ALL.to_owned()]);

    // The cancel lands. The room is idle, and the composer is empty.
    fixture = fixture.cancelled("turn-1", "claude");
    assert!(
        !lane_busy(&fixture.room.reducer, None),
        "the fixture must really have settled"
    );
    assert!(
        fixture.room.prompt.text().trim().is_empty(),
        "and the composer must really be empty, which is what makes rung 3 live"
    );

    let held = keys
        .press_at(
            &mut fixture.room,
            ctrl_c(),
            now + Duration::from_millis(500),
        )
        .await;
    assert!(
        !exited(&held),
        "the lane settling between the two events must not open a second door for the SAME held key"
    );
    assert!(
        fixture.room.quit_armed_until.is_none(),
        "sanity: there is no arm left here — the suppression under test is not the arm's, and a test that let the arm survive would prove the wrong thing"
    );
}

/// [FALSIFIER] BLOCK 1, second path, on a terminal that DOES report `Repeat`.
///
/// The same settle-then-exit hole, reached the other way: Kitty reports the
/// autorepeat as `Repeat`, the shipped guard consumes it at rung 1 — but by now
/// there is no rung 1, and nothing consumes it at rung 3.
///
/// RED against the tree this test was written on: the repeat exits.
#[tokio::test]
async fn a_held_ctrl_c_repeat_cannot_exit_through_the_idle_rung() {
    let mut keys = Keys::new();
    let mut fixture = running_fixture();
    let now = Instant::now();

    keys.press_at(&mut fixture.room, ctrl_c(), now).await;
    assert_eq!(keys.drain(), vec![CANCEL_ALL.to_owned()]);

    fixture = fixture.cancelled("turn-1", "claude");
    assert!(!lane_busy(&fixture.room.reducer, None));

    let held = keys
        .press_at(
            &mut fixture.room,
            ctrl_c_repeat(),
            now + Duration::from_millis(500),
        )
        .await;
    assert!(
        !exited(&held),
        "an autorepeat must not exit through the idle rung either"
    );
}

/// [PIN] The quit is still one keypress away — after the operator lets go.
///
/// The positive control for all three falsifiers above, and the assertion that
/// stops the cheapest wrong fix in this area: refusing every Ctrl+C that is not
/// the first would close the defect and delete the escape hatch with it. The
/// operator's room is mid-panic here; a room they cannot leave is not safer.
///
/// MUTATION: delete the release arm from the router so the gesture never ends,
/// and this goes red while every falsifier above stays green.
#[tokio::test]
async fn a_release_between_the_presses_still_quits() {
    let mut keys = Keys::new();
    let mut fixture = running_fixture();
    let now = Instant::now();

    keys.press_at(&mut fixture.room, ctrl_c(), now).await;
    assert_eq!(keys.drain(), vec![CANCEL_ALL.to_owned()]);
    fixture = fixture.cancelling("turn-1", "claude");

    // The operator lets go. This is the event the whole fix turns on.
    let lifted = keys
        .press_at(
            &mut fixture.room,
            ctrl_c_release(),
            now + Duration::from_millis(200),
        )
        .await;
    assert!(!exited(&lifted), "letting go of a key never ends the room");
    assert_eq!(
        keys.drain(),
        Vec::<String>::new(),
        "and it sends nothing to the host"
    );
    assert_eq!(
        fixture.room.quit_armed_until,
        Some(now + QUIT_CONFIRM_WINDOW),
        "letting go must not disarm what the press armed — it is not `any other accepted keypress`, it is the same key"
    );

    let second = keys
        .press_at(
            &mut fixture.room,
            ctrl_c(),
            now + Duration::from_millis(400),
        )
        .await;
    assert!(
        exited(&second),
        "a deliberate second tap, after a real release, still quits"
    );
}

/// [PIN] A terminal that reports no release at all still has an escape hatch.
///
/// The fail-safe has a cost, and this is where it is paid rather than hidden.
/// If the room only ever ended a gesture on a release, then on a terminal that
/// reports none — every non-KKP unix terminal — a `Ctrl+C` would arm a quit
/// that no later `Ctrl+C` could ever confirm. The operator would be locked into
/// a room they reached by panicking. So a gesture also ends after
/// `CTRL_C_GESTURE_QUIET` of silence, and this is the case that says the hatch
/// is really there.
///
/// The two presses below are **the whole sequence**: no release, no other key.
///
/// MUTATION: delete the quiet-window term from `CtrlCGesture::key_down` — make
/// `continues` just `self.latest.is_some()` — and this goes red while every
/// held-key falsifier stays green, which is the shape of the trade: the guard
/// alone is safe and unusable.
#[tokio::test]
async fn a_quiet_gesture_can_still_quit_without_any_release() {
    let mut keys = Keys::new();
    let mut fixture = running_fixture();
    let now = Instant::now();

    keys.press_at(&mut fixture.room, ctrl_c(), now).await;
    assert_eq!(keys.drain(), vec![CANCEL_ALL.to_owned()]);
    fixture = fixture.cancelling("turn-1", "claude");

    // The valve has to open INSIDE the confirmation window or it opens onto a
    // room that has already disarmed, which is not an escape hatch at all.
    assert!(
        CTRL_C_GESTURE_QUIET < QUIT_CONFIRM_WINDOW,
        "the quiet window must fit inside the arm, or the hatch it opens is shut"
    );

    let second = keys
        .press_at(&mut fixture.room, ctrl_c(), now + CTRL_C_GESTURE_QUIET)
        .await;
    assert!(
        exited(&second),
        "after a second of silence the next Ctrl+C is a new gesture, even on a \
         terminal that never said the key came up"
    );
}

/// [PIN] Another key ends the gesture, so the very next Ctrl+C acts.
///
/// The third way out, and the one that keeps the room usable between the other
/// two: autorepeat repeats the most recently pressed key, so a key event for
/// anything else is proof the Ctrl+C stream stopped. Without it an operator on
/// a release-less terminal would have to wait out `CTRL_C_GESTURE_QUIET` after
/// every Ctrl+C before the room would listen to another one — including after
/// typing.
///
/// MUTATION: delete `room.ctrl_c_gesture.ended()` from the disarm block in
/// `route_room_key_at` and this goes red, together with the three rows of
/// `any_other_key_disarms_the_quit`.
#[tokio::test]
async fn another_key_ends_the_gesture() {
    let mut keys = Keys::new();
    let mut fixture = running_fixture();
    let now = Instant::now();

    keys.press_at(&mut fixture.room, ctrl_c(), now).await;
    assert_eq!(keys.drain(), vec![CANCEL_ALL.to_owned()]);
    fixture = fixture.cancelling("turn-1", "claude");

    // A plain character, which also disarms the quit — so the Ctrl+C after it
    // is back at rung 2 and must CANCEL. That is the observable: a suppressed
    // gesture sends nothing at all.
    keys.press_at(
        &mut fixture.room,
        KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE),
        now + Duration::from_millis(20),
    )
    .await;
    keys.drain();

    let after = keys
        .press_at(&mut fixture.room, ctrl_c(), now + Duration::from_millis(30))
        .await;
    assert!(
        !exited(&after),
        "the arm was cleared by the typed character"
    );
    assert_eq!(
        keys.drain(),
        vec![CANCEL_ALL.to_owned()],
        "and the Ctrl+C after another key is a new gesture, so it acts"
    );
}

/// [PIN] The release predicate does not need the CONTROL bit.
///
/// Which of the two keys the hand lifts first decides what the terminal
/// reports, and a release predicate that demanded CONTROL would simply never
/// fire for the operators who lift Ctrl first — leaving the gesture live and
/// the quit unreachable for a whole second, on every tap, forever. Upstream
/// makes the same narrowing for the same reason
/// (`D:\grok-ref\crates\codegen\xai-grok-pager\src\app\event_loop.rs:3779-3787`).
///
/// MUTATION: add `&& key.modifiers.contains(KeyModifiers::CONTROL)` to
/// `is_ctrl_c_release` and the bare row goes red.
#[tokio::test]
async fn either_spelling_of_the_release_ends_the_gesture() {
    for (label, release) in [
        ("Ctrl lifted first, so no CONTROL bit", ctrl_c_release()),
        (
            "c lifted first, so CONTROL still held",
            KeyEvent::new_with_kind(
                KeyCode::Char('c'),
                KeyModifiers::CONTROL,
                KeyEventKind::Release,
            ),
        ),
    ] {
        let mut keys = Keys::new();
        let mut fixture = running_fixture();
        let now = Instant::now();

        keys.press_at(&mut fixture.room, ctrl_c(), now).await;
        keys.drain();
        fixture = fixture.cancelling("turn-1", "claude");

        keys.press_at(&mut fixture.room, release, now + Duration::from_millis(50))
            .await;
        assert_eq!(
            fixture.room.quit_armed_until,
            Some(now + QUIT_CONFIRM_WINDOW),
            "{label}: a release is not `any other accepted keypress` and must not disarm"
        );

        let second = keys
            .press_at(&mut fixture.room, ctrl_c(), now + Duration::from_millis(80))
            .await;
        assert!(exited(&second), "{label}: the tap after it confirms");
    }
}

/// [PIN] The room takes exactly one release and drops the rest.
///
/// `accepts_key` is the room's whole filter on terminal key events, and
/// widening it is how a release starts reaching owners that have never seen one
/// — the composer, the shelf, the feed. It was widened by exactly one key.
///
/// MUTATION: replace `is_ctrl_c_release(key)` in `accepts_key` with
/// `key.kind == KeyEventKind::Release` and the second row goes red.
#[test]
fn only_the_ctrl_c_release_is_accepted() {
    for (label, key, accepted) in [
        ("the Ctrl+C release", ctrl_c_release(), true),
        (
            "any other release",
            KeyEvent::new_with_kind(
                KeyCode::Char('x'),
                KeyModifiers::NONE,
                KeyEventKind::Release,
            ),
            false,
        ),
        (
            "the Esc release",
            KeyEvent::new_with_kind(KeyCode::Esc, KeyModifiers::NONE, KeyEventKind::Release),
            false,
        ),
        ("a press", ctrl_c(), true),
        ("a repeat", ctrl_c_repeat(), true),
    ] {
        assert_eq!(super::accepts_key(&key), accepted, "{label}");
    }
}

// ---------------------------------------------------------------------------
// The claim — BLOCK 2 of the slice-B review
// ---------------------------------------------------------------------------

/// [FALSIFIER] BLOCK 2. The room does not say the agents stopped until it has
/// evidence they were told.
///
/// A successful `mpsc::Sender::send` is a local enqueue. It does not mean the
/// bridge dequeued it, and it certainly does not mean the host acted — with an
/// unrelated 130-second mode RPC in flight the bridge has not even looked at the
/// channel. The room nevertheless painted `agents stopped` on the strength of
/// it, over three agents that were still working. This is the same class of
/// defect as a check mark on a tool call that failed: the UI asserting something
/// the system has not done.
///
/// RED against the tree this test was written on: the row reads `agents stopped
/// — press ctrl+c again to quit` one millisecond after the keypress, with
/// nothing on the other end of the channel at all.
///
/// What wrong implementation would still pass the first half? One that never
/// says `agents stopped` at all — no: the second half requires the confirmed
/// wording, from the same room, after the host answers.
#[tokio::test]
async fn the_row_waits_for_the_host_before_claiming_the_agents_stopped() {
    let mut keys = Keys::new();
    let mut room = one_running();
    let now = Instant::now();

    keys.press_at(&mut room, ctrl_c(), now).await;
    assert_eq!(
        keys.drain(),
        vec![CANCEL_ALL.to_owned()],
        "the cancel really was asked for; this is not a room that sent nothing"
    );
    assert!(
        room.quit_armed_until.is_some(),
        "and the quit really is armed — the escape hatch does not wait for the host"
    );
    assert_eq!(
        row_text(&room, now + Duration::from_millis(1)),
        HINT_STOPPING,
        "nothing has dequeued the ask, let alone acted on it, so the room says \
         what is true: it is stopping them"
    );

    keys.host_confirms_the_cancel(&mut room);
    assert_eq!(
        row_text(&room, now + Duration::from_millis(2)),
        HINT_ARMED,
        "and once the host has answered, the room says so"
    );
}

/// [PIN] An answer to a superseded cancel is not evidence about the current one.
///
/// The room asks twice — the operator pressed the panic button, it did not seem
/// to work, they pressed it again — and the FIRST ask's answer arrives after the
/// second was sent. Applying it would put `agents stopped` on screen on the
/// strength of a reply to a different question.
///
/// MUTATION: drop the `seq` comparison from `RoomCancelClaim::answered` — make
/// it `Self::Reached { seq }` unconditionally — and this goes red.
#[tokio::test]
async fn a_late_answer_to_an_older_cancel_is_dropped() {
    let mut keys = Keys::new();
    let mut room = one_running();
    let now = Instant::now();

    keys.press_at(&mut room, ctrl_c(), now).await;
    let first_ask = room.cancel_claim.seq();
    keys.drain();

    // The operator lets go and presses again. Same panic button, second ask.
    keys.press_at(&mut room, ctrl_c_release(), now + Duration::from_millis(50))
        .await;
    // The arm is still live, so this second press would confirm the quit rather
    // than re-ask. Disarm it the way the room itself does when the window shuts.
    room.quit_armed_until = None;
    keys.press_at(&mut room, ctrl_c(), now + Duration::from_millis(100))
        .await;
    let second_ask = room.cancel_claim.seq();
    assert_ne!(
        first_ask, second_ask,
        "a second cancel must be a second question, or the first answer can \
         stand in for it"
    );

    room.cancel_claim = room.cancel_claim.answered(first_ask);
    assert_eq!(
        row_text(&room, now + Duration::from_millis(101)),
        HINT_STOPPING,
        "the host answered the FIRST ask; the room has heard nothing about the second"
    );

    room.cancel_claim = room.cancel_claim.answered(second_ask);
    assert_eq!(
        row_text(&room, now + Duration::from_millis(102)),
        HINT_ARMED,
        "the answer to the ask actually outstanding is the one that counts"
    );
}

/// [PIN] A cancel wire with nothing on the other end arms nothing and claims
/// nothing.
///
/// The `severed` keyboard's receivers are dropped, so `try_send` returns
/// `Closed` — there is no bridge, the ask reached nobody, and the room must not
/// arm a quit or paint a row on top of it. This replaces the pre-BLOCK-2
/// `a_failed_send_does_not_arm`, whose failure mode was a full/closed `send`.
///
/// MUTATION: treat `Closed` like `Full` in `request_cancel_all` — return `Ok`
/// for both — and this goes red at the error assertion.
#[tokio::test]
async fn a_dead_cancel_wire_arms_nothing() {
    let keys = Keys::severed();
    let mut room = one_running();
    let now = Instant::now();

    let result = keys.try_press_at(&mut room, ctrl_c(), now).await;

    assert!(
        result.is_err(),
        "a dead cancel wire must surface as an error"
    );
    assert_eq!(
        room.quit_armed_until, None,
        "nothing was asked, so nothing is armed"
    );
    assert_eq!(
        room.cancel_claim,
        crate::room_view::RoomCancelClaim::Idle,
        "and nothing is claimed"
    );
}

/// [PIN] A full cancel wire is not a failure, and does not re-ask.
///
/// The wire carries nothing but cancels and its consumer never blocks on
/// anything else, so a backlog means the HOST is not answering. Stacking another
/// copy of the same ask behind four that are already waiting helps nobody; the
/// standing `Asked` claim is already the true one. What must NOT happen is the
/// room treating it as a failure and refusing to arm — that is the state the
/// operator most needs the escape hatch in.
///
/// MUTATION: fold `TrySendError::Full` into the error arm of
/// `request_cancel_all` and this goes red at the arm assertion.
#[tokio::test]
async fn a_full_cancel_wire_still_arms_the_quit() {
    let mut room = one_running();
    let now = Instant::now();
    // Capacity one, already occupied: the next `try_send` cannot land.
    let (cancel_tx, _cancel_rx) = mpsc::channel::<super::RoomCancelAll>(1);
    cancel_tx
        .try_send(super::RoomCancelAll { seq: 1 })
        .expect("the fixture must really fill the wire");
    let (command_tx, _command_rx) = mpsc::channel::<RoomCommand>(4);

    let routed = route_room_key_at(&mut room, ctrl_c(), &command_tx, &cancel_tx, now)
        .await
        .expect("a full cancel wire is not a room failure");

    assert!(!exited(&routed), "the first Ctrl+C never ends the room");
    assert_eq!(
        room.quit_armed_until,
        Some(now + QUIT_CONFIRM_WINDOW),
        "the escape hatch is armed even though the ask could not be queued"
    );
    assert_eq!(
        row_text(&room, now),
        HINT_STOPPING,
        "and the room does not claim anything stopped"
    );
}

// ---------------------------------------------------------------------------
// FL-126 — a cancelled turn hands its prompt back, and only that turn does
//
// Every case below drives `apply_room_event_at` — the body of the run loop's
// own `RoomUpdate::Event` arm — for every event, in the order the reducer
// requires. That is the whole point of this section. The first attempt at
// FL-126 called the reconcile at moments each case chose; the run loop calls it
// after EVERY event, and the very first event after a submit (`turn.accepted`,
// which has created no lanes yet) destroyed the stash. Three tests were green
// and the app never restored anything. A test that picks its own cadence is
// asking a question the operator's room never asks.
// ---------------------------------------------------------------------------

/// A protocol-valid event pushed through the run loop's own event arm.
///
/// `apply_room_event_at` is not a copy of that arm — it IS that arm; the select
/// branch is one call to it. So a case built out of this helper performs the
/// reducer apply, the scrollback and permission sync, the quit-arm reconcile
/// and the restore settle in the exact order and at the exact cadence the
/// running app does.
fn emit_on(room: &mut RoomView, seq: &mut u64, turn: &str, kind: &str, payload: serde_json::Value) {
    *seq += 1;
    let event = zer0_room_protocol::RoomEvent::from_value(json!({
        "protocol": "zer0.room", "version": 1, "sessionId": "restore-room",
        "eventSeq": seq.to_string(), "eventId": format!("restore-event-{seq}"),
        "turnId": turn, "occurredAt": "2026-08-21T00:00:00Z",
        "type": kind, "payload": payload,
    }))
    .expect("test event is protocol-valid");
    apply_room_event_at(room, &event, Instant::now(), 0)
        .expect("the room must accept a valid event");
}

/// Type `text` through the real router, one character at a time, then press
/// Enter — an operator's own keystrokes, not a struct written into directly.
async fn type_and_submit(keys: &Keys, room: &mut RoomView, text: &str) {
    for ch in text.chars() {
        keys.press_at(
            room,
            KeyEvent::new(KeyCode::Char(ch), KeyModifiers::NONE),
            Instant::now(),
        )
        .await;
    }
    keys.press_at(
        room,
        KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
        Instant::now(),
    )
    .await;
}

/// The two events every submission produces before any lane exists.
///
/// Split out from [`advance_to_running`] because the whole P0-1 defect lives in
/// this window: after `turn.accepted` the room holds zero lanes, and after
/// `lane.queued` it holds one in `LanePhase::Queued`, which `lane_busy` does
/// not count. A room that reads "not busy" as "this submission settled" throws
/// the stash away right here.
fn accept_turn(room: &mut RoomView, seq: &mut u64, turn: &str, agents: &[&str]) {
    emit_on(
        room,
        seq,
        turn,
        "turn.accepted",
        json!({"agents":agents,"text":"placeholder","messageId":format!("operator-{turn}"),"ledgerSeq":format!("{}", *seq + 1)}),
    );
    emit_on(room, seq, turn, "route.resolved", json!({"agents":agents}));
}

fn queue_lane(room: &mut RoomView, seq: &mut u64, turn: &str, agent: &str) {
    emit_on(
        room,
        seq,
        turn,
        "lane.queued",
        json!({"laneId":format!("lane-{turn}-{agent}"),"agent":agent,"expectedMessageId":format!("message-{turn}-{agent}"),"origin":"operator","hopIndex":0}),
    );
}

fn start_lane(room: &mut RoomView, seq: &mut u64, turn: &str, agent: &str) {
    emit_on(
        room,
        seq,
        turn,
        "lane.started",
        json!({"laneId":format!("lane-{turn}-{agent}"),"streamId":format!("stream-{turn}-{agent}"),"agent":agent}),
    );
}

fn cancel_lane(room: &mut RoomView, seq: &mut u64, turn: &str, agent: &str) {
    emit_on(
        room,
        seq,
        turn,
        "lane.cancelling",
        json!({"laneId":format!("lane-{turn}-{agent}"),"agent":agent}),
    );
    emit_on(
        room,
        seq,
        turn,
        "lane.cancelled",
        json!({"laneId":format!("lane-{turn}-{agent}"),"agent":agent,"streamId":format!("stream-{turn}-{agent}")}),
    );
}

fn answer_lane(room: &mut RoomView, seq: &mut u64, turn: &str, agent: &str) {
    emit_on(
        room,
        seq,
        turn,
        "message.committed",
        json!({"laneId":format!("lane-{turn}-{agent}"),"agent":agent,"messageId":format!("message-{turn}-{agent}"),"ledgerSeq":format!("{}", 900 + *seq),"text":"an answer","origin":"operator","hopIndex":0}),
    );
    emit_on(
        room,
        seq,
        turn,
        "lane.completed",
        json!({"laneId":format!("lane-{turn}-{agent}"),"streamId":format!("stream-{turn}-{agent}"),"agent":agent}),
    );
}

/// The host's own "this turn is over".
///
/// The settle signal the restore is keyed on, and the reducer refuses it unless
/// the route resolved, every routed agent owns exactly one root lane, and every
/// lane of the turn is terminal (`reducer.rs`, `complete_turn`). So a fixture
/// that gets this far has proved the turn really finished, rather than
/// announcing it.
fn complete_turn(room: &mut RoomView, seq: &mut u64, turn: &str) {
    emit_on(room, seq, turn, "turn.completed", json!({}));
}

/// Advance a single-agent turn from nothing to `Running` in the given room,
/// asserting the fixture really got there before any case relies on it.
fn advance_to_running(room: &mut RoomView, seq: &mut u64, turn: &str, agent: &str) {
    accept_turn(room, seq, turn, &[agent]);
    queue_lane(room, seq, turn, agent);
    start_lane(room, seq, turn, agent);
    assert!(
        lane_busy(&room.reducer, None),
        "the fixture must really be running before a case can cancel or complete it"
    );
}

/// Every row the feed actually paints.
///
/// Rendered, not read off a field: a notice nobody renders is not a notice, and
/// this is the only observable that can tell the difference. Wide enough that a
/// one-line notice cannot wrap into two rows and defeat a `contains`.
fn feed_lines(room: &mut RoomView) -> Vec<String> {
    let area = ratatui::layout::Rect::new(0, 0, 200, 40);
    let mut buffer = ratatui::buffer::Buffer::empty(area);
    let _ = room.scrollback.render(area, &mut buffer);
    (0..area.height)
        .map(|y| {
            (0..area.width)
                .filter_map(|x| buffer.cell((x, y)))
                .map(|cell| cell.symbol())
                .collect::<String>()
                .trim_end()
                .to_owned()
        })
        .filter(|line| !line.is_empty())
        .collect()
}

/// The rows the operator sees about a prompt that did NOT come back.
fn refusal_notices(room: &mut RoomView) -> Vec<String> {
    feed_lines(room)
        .into_iter()
        .filter(|line| line.contains("was not restored") || line.contains("were not restored"))
        .collect()
}

/// [FALSIFIER · P0-1] Submit, cancel, and the composer gets the prompt back —
/// at the cadence the run loop actually uses.
///
/// RED against `7870390`, reproduced in this session on a scratch export of
/// that commit before any of this was written:
///
/// ```text
/// after turn.accepted: stash present = false
/// after lane.queued: stash present = false
/// after lane.started: stash present = false
/// assertion `left == right` failed: at the run_loop's own cadence the
///   cancelled turn's text must come back
///   left: ""
///  right: "hello world"
/// ```
///
/// The stash was destroyed by the first event after the submit, so the running
/// app never restored anything. This case exists to keep the cadence in the
/// test, not just the outcome.
#[tokio::test]
async fn a_cancelled_turn_hands_its_text_back_at_the_run_loops_own_cadence() {
    let mut keys = Keys::new();
    let mut room = RoomView::new();

    type_and_submit(&keys, &mut room, "hello world").await;
    assert_eq!(
        keys.drain(),
        vec!["submit".to_owned()],
        "the room must really have sent the prompt"
    );
    assert_eq!(
        room.prompt.text(),
        "",
        "and cleared the composer the way it does today"
    );

    let mut seq = 0u64;
    host_accepts_latest(&mut keys, &mut room, "turn-1");
    accept_turn(&mut room, &mut seq, "turn-1", &["claude"]);
    assert_eq!(
        room.pending_cancel_restore.len(),
        1,
        "the stash must survive turn.accepted — the room holds no lanes at all \
         here, which is precisely when it looks idle and is not"
    );
    queue_lane(&mut room, &mut seq, "turn-1", "claude");
    assert!(
        !lane_busy(&room.reducer, None),
        "a Queued lane is not `busy`, which is the trap this case is built on"
    );
    assert_eq!(
        room.pending_cancel_restore.len(),
        1,
        "and it must survive lane.queued for the same reason"
    );
    start_lane(&mut room, &mut seq, "turn-1", "claude");
    assert_eq!(room.prompt.text(), "", "nothing has been cancelled yet");

    cancel_lane(&mut room, &mut seq, "turn-1", "claude");
    assert_eq!(
        room.prompt.text(),
        "",
        "the lane is cancelled but the host has not settled the turn yet"
    );
    complete_turn(&mut room, &mut seq, "turn-1");

    assert_eq!(
        room.prompt.text(),
        "hello world",
        "the cancelled turn's own text comes back"
    );
    assert!(
        room.pending_cancel_restore.is_empty(),
        "claimed exactly once, not left to answer a later, unrelated cancel"
    );
    assert!(
        refusal_notices(&mut room).is_empty(),
        "a restore that lands is its own signal; it must not also print a row"
    );
}

/// [FALSIFIER · P0-2] An answered turn hands nothing back, even after an
/// earlier turn in the same session was cancelled.
///
/// RED against `7870390`, reproduced in this session:
///
/// ```text
/// composer after an ANSWERED turn-2 = "first prompt"
/// assertion `left == right` failed: operator's ruling: an answered turn must
///   NOT hand its text back
///   left: "first prompt"
///  right: ""
/// ```
///
/// The old predicate asked the whole room whether ANY lane had ever reached
/// `Cancelled`, and the reducer never removes a lane, so one cancel armed every
/// later turn for the rest of the session. The operator's ruling is the exact
/// opposite: *"If we just call a model, and it answers, and we didn't get to
/// cancel — that's it."*
#[tokio::test]
async fn an_answered_turn_after_an_earlier_cancel_hands_nothing_back() {
    let mut keys = Keys::new();
    let mut room = RoomView::new();
    let mut seq = 0u64;

    // Turn 1 is submitted and cancelled. Its text comes back, as designed.
    type_and_submit(&keys, &mut room, "first prompt").await;
    keys.drain();
    host_accepts_latest(&mut keys, &mut room, "turn-1");
    advance_to_running(&mut room, &mut seq, "turn-1", "claude");
    cancel_lane(&mut room, &mut seq, "turn-1", "claude");
    complete_turn(&mut room, &mut seq, "turn-1");
    assert_eq!(room.prompt.text(), "first prompt", "turn 1 restores");

    // The operator presses Enter on the restored text. Turn 2 ANSWERS.
    type_and_submit(&keys, &mut room, "").await;
    keys.drain();
    assert_eq!(
        room.prompt.text(),
        "",
        "the composer cleared on the resubmit"
    );
    host_accepts_latest(&mut keys, &mut room, "turn-2");
    advance_to_running(&mut room, &mut seq, "turn-2", "codex");
    answer_lane(&mut room, &mut seq, "turn-2", "codex");
    complete_turn(&mut room, &mut seq, "turn-2");

    assert_eq!(
        room.prompt.text(),
        "",
        "an answered turn must NOT hand its text back, however many earlier \
         turns in this session were cancelled"
    );
    assert!(
        room.pending_cancel_restore.is_empty(),
        "and its stash is dropped, not left to surface on a later cancel"
    );
}

/// [FALSIFIER · P1-3] Two submissions outstanding: the CANCELLED one is what
/// comes back, not whichever settled last.
///
/// RED against `7870390`, reproduced in this session:
///
/// ```text
/// composer after cancel(turn1) + answer(turn2) = "prompt two"
/// assertion `left == right` failed: the CANCELLED turn's text is what the
///   operator asked to get back
///   left: "prompt two"
///  right: "prompt one"
/// ```
///
/// The old field was a single slot that the second submit overwrote, so the
/// room handed back the ANSWERED turn's text — the wrong text rather than no
/// text, which is the failure a user cannot detect. A queue keyed by turn id
/// answers per submission instead.
#[tokio::test]
async fn the_cancelled_turn_wins_when_two_submissions_are_outstanding() {
    let mut keys = Keys::new();
    let mut room = RoomView::new();
    let mut seq = 0u64;

    type_and_submit(&keys, &mut room, "prompt one").await;
    keys.drain();
    type_and_submit(&keys, &mut room, "prompt two").await;
    keys.drain();
    assert_eq!(
        room.pending_cancel_restore.len(),
        2,
        "both submissions are outstanding; neither may evict the other"
    );

    // Both turns are accepted, in submission order, before either settles.
    let ids = keys.submissions();
    host_accepts(&mut room, ids[0], "turn-1");
    host_accepts(&mut room, ids[1], "turn-2");
    advance_to_running(&mut room, &mut seq, "turn-1", "claude");
    advance_to_running(&mut room, &mut seq, "turn-2", "codex");

    // Turn 1 is cancelled; turn 2 answers.
    cancel_lane(&mut room, &mut seq, "turn-1", "claude");
    complete_turn(&mut room, &mut seq, "turn-1");
    answer_lane(&mut room, &mut seq, "turn-2", "codex");
    complete_turn(&mut room, &mut seq, "turn-2");

    assert_eq!(
        room.prompt.text(),
        "prompt one",
        "the CANCELLED turn's text is what the operator asked to get back"
    );
    assert!(
        room.pending_cancel_restore.is_empty(),
        "and turn 2's answered stash is dropped rather than queued behind it"
    );
}

/// [FALSIFIER · order-independence] The same two outstanding submissions, with
/// the ANSWERED turn settling FIRST.
///
/// The companion to the case above, and it fails against any implementation
/// that resolves only the front of the queue: turn 2 answers and is removed
/// from the middle, then turn 1's cancel must still find its own stash.
#[tokio::test]
async fn a_later_turn_settling_first_does_not_strand_the_cancelled_one() {
    let mut keys = Keys::new();
    let mut room = RoomView::new();
    let mut seq = 0u64;

    type_and_submit(&keys, &mut room, "prompt one").await;
    keys.drain();
    type_and_submit(&keys, &mut room, "prompt two").await;
    keys.drain();

    let ids = keys.submissions();
    host_accepts(&mut room, ids[0], "turn-1");
    host_accepts(&mut room, ids[1], "turn-2");
    advance_to_running(&mut room, &mut seq, "turn-1", "claude");
    advance_to_running(&mut room, &mut seq, "turn-2", "codex");

    // Turn 2 finishes first, out of submission order.
    answer_lane(&mut room, &mut seq, "turn-2", "codex");
    complete_turn(&mut room, &mut seq, "turn-2");
    assert_eq!(
        room.prompt.text(),
        "",
        "the answered turn hands nothing back even though it settled first"
    );
    assert_eq!(
        room.pending_cancel_restore.len(),
        1,
        "and turn 1's stash is still held, not dropped with its neighbour"
    );

    cancel_lane(&mut room, &mut seq, "turn-1", "claude");
    complete_turn(&mut room, &mut seq, "turn-1");
    assert_eq!(
        room.prompt.text(),
        "prompt one",
        "turn 1's own text still comes back after its neighbour left the queue"
    );
}

/// [PIN] A lane cancelled before it ever started still hands its text back.
///
/// Contract item 4, and FL-141's third case: `Queued → Cancelled` with no
/// `lane.started` in between (`reducer.rs`'s `cancel_lane` accepts `Queued`
/// directly). This is the transition `lane_busy` cannot see at all, so an
/// implementation that asks "is the room busy" instead of "did the host settle
/// this turn" gets it wrong in both directions.
#[tokio::test]
async fn a_lane_cancelled_before_it_ever_started_still_restores() {
    let mut keys = Keys::new();
    let mut room = RoomView::new();
    let mut seq = 0u64;

    type_and_submit(&keys, &mut room, "never started").await;
    keys.drain();
    host_accepts_latest(&mut keys, &mut room, "turn-1");

    accept_turn(&mut room, &mut seq, "turn-1", &["gemini"]);
    queue_lane(&mut room, &mut seq, "turn-1", "gemini");
    emit_on(
        &mut room,
        &mut seq,
        "turn-1",
        "lane.cancelled",
        json!({"laneId":"lane-turn-1-gemini","agent":"gemini","queued":true}),
    );
    assert_eq!(
        phase_count(&room.reducer, LanePhase::Cancelled),
        1,
        "the fixture must really hold a lane that went Queued -> Cancelled"
    );
    complete_turn(&mut room, &mut seq, "turn-1");

    assert_eq!(
        room.prompt.text(),
        "never started",
        "a lane cancelled before it ran is still a cancel the operator asked for"
    );
}

/// [PIN] One turn, three agents, one cancelled and two answered: the text comes
/// back once.
///
/// The operator's ruling, verbatim: *"yes it should come back, as the intention
/// of the user was to cancel all 3 if we use @all."* One composer and three
/// lanes, so the restore happens once, not once per lane.
#[tokio::test]
async fn one_cancelled_lane_out_of_three_earns_the_text_back_once() {
    let mut keys = Keys::new();
    let mut room = RoomView::new();
    let mut seq = 0u64;

    type_and_submit(&keys, &mut room, "@all do the thing").await;
    keys.drain();
    host_accepts_latest(&mut keys, &mut room, "turn-1");

    let agents = ["claude", "codex", "gemini"];
    accept_turn(&mut room, &mut seq, "turn-1", &agents);
    for agent in agents {
        queue_lane(&mut room, &mut seq, "turn-1", agent);
        start_lane(&mut room, &mut seq, "turn-1", agent);
    }
    cancel_lane(&mut room, &mut seq, "turn-1", "claude");
    answer_lane(&mut room, &mut seq, "turn-1", "codex");
    answer_lane(&mut room, &mut seq, "turn-1", "gemini");
    complete_turn(&mut room, &mut seq, "turn-1");

    assert_eq!(
        room.prompt.text(),
        "@all do the thing",
        "any cancelled lane in the turn earns the text back"
    );
    assert!(
        room.pending_cancel_restore.is_empty(),
        "restored once for the turn, not once per lane"
    );
}

/// [PIN] `@all`, then the panic button stops every one of the three: the text
/// comes back once.
///
/// The operator's own case, verbatim: *"the intention of the user was to cancel
/// all 3 if we use @all."* Three cancelled lanes, one composer, one restore —
/// not three, and not none.
#[tokio::test]
async fn every_lane_cancelled_hands_the_text_back_exactly_once() {
    let mut keys = Keys::new();
    let mut room = RoomView::new();
    let mut seq = 0u64;

    type_and_submit(&keys, &mut room, "@all stop everything").await;
    keys.drain();
    host_accepts_latest(&mut keys, &mut room, "turn-1");

    let agents = ["claude", "codex", "gemini"];
    accept_turn(&mut room, &mut seq, "turn-1", &agents);
    for agent in agents {
        queue_lane(&mut room, &mut seq, "turn-1", agent);
        start_lane(&mut room, &mut seq, "turn-1", agent);
    }

    // The panic button, through the real router.
    keys.press_at(&mut room, esc(), Instant::now()).await;
    assert_eq!(
        keys.drain(),
        vec![CANCEL_ALL.to_owned()],
        "the panic button must really have asked the host to stop everything"
    );

    for agent in agents {
        cancel_lane(&mut room, &mut seq, "turn-1", agent);
    }
    assert_eq!(
        phase_count(&room.reducer, LanePhase::Cancelled),
        3,
        "all three lanes must really have reached Cancelled"
    );
    complete_turn(&mut room, &mut seq, "turn-1");

    assert_eq!(
        room.prompt.text(),
        "@all stop everything",
        "the whole submission comes back when the whole turn was stopped"
    );
    assert!(
        room.pending_cancel_restore.is_empty(),
        "once for the turn, not once per cancelled lane"
    );
    assert!(
        refusal_notices(&mut room).is_empty(),
        "and nothing was refused, so nothing is announced"
    );
}

/// [PIN] A typed `/cancel all` restores exactly like the panic button does.
///
/// `docs/FINDINGS.md:189` claims the opposite — *"the typed `/cancel
/// latest|all|agent` commands do not restore — only the Ctrl+C/Esc panic button
/// does"* — and that claim is false, both before this change and after it. The
/// mechanism is keyed on what the lanes did, never on which key was pressed.
/// Pinned here so the true behaviour is in the suite rather than only in a
/// document; the document is the lead's to correct.
///
/// The typed command's own text (`"/cancel all"`) is correctly NOT the thing
/// restored: it is stashed on Enter and dropped by the `Host` arm, because a
/// slash command has no turn for a later cancel to be about.
#[tokio::test]
async fn a_typed_cancel_all_restores_exactly_like_the_panic_button() {
    let mut keys = Keys::new();
    let mut room = RoomView::new();
    let mut seq = 0u64;

    type_and_submit(&keys, &mut room, "the real prompt").await;
    keys.drain();
    host_accepts_latest(&mut keys, &mut room, "turn-1");
    advance_to_running(&mut room, &mut seq, "turn-1", "claude");

    type_and_submit(&keys, &mut room, "/cancel all").await;
    assert_eq!(
        keys.drain(),
        vec!["cancel/all/-".to_owned()],
        "the typed command must really have asked the host to cancel"
    );
    assert_eq!(
        room.pending_cancel_restore.len(),
        1,
        "the slash command itself is not a submission and holds no stash"
    );

    cancel_lane(&mut room, &mut seq, "turn-1", "claude");
    complete_turn(&mut room, &mut seq, "turn-1");

    assert_eq!(
        room.prompt.text(),
        "the real prompt",
        "the submitted prompt comes back, not the slash command that stopped it"
    );
}

/// [PIN] A draft typed after the cancel is never overwritten, and the operator
/// is TOLD the cancelled prompt did not come back.
///
/// The brief's stated hazard: a blind `restore()` destroys typing the operator
/// can never recover, which is strictly worse than the bug being fixed. So the
/// draft wins. What is new here is the second half — the refusal is announced
/// rather than silent (review finding P2-9). Upstream's collision pattern
/// (`app/queue_edit.rs`, stash the live draft and hand it back on exit) is not
/// available: it depends on a mode the operator leaves, and a cancel has no
/// such exit.
#[tokio::test]
async fn a_draft_typed_after_the_cancel_survives_and_the_refusal_is_announced() {
    let mut keys = Keys::new();
    let mut room = RoomView::new();
    let mut seq = 0u64;

    type_and_submit(&keys, &mut room, "hello world").await;
    keys.drain();
    host_accepts_latest(&mut keys, &mut room, "turn-1");
    advance_to_running(&mut room, &mut seq, "turn-1", "claude");
    emit_on(
        &mut room,
        &mut seq,
        "turn-1",
        "lane.cancelling",
        json!({"laneId":"lane-turn-1-claude","agent":"claude"}),
    );

    // The operator does not wait for the ack — they start typing something new
    // while the cancel is still in flight.
    for ch in "new thought".chars() {
        keys.press_at(
            &mut room,
            KeyEvent::new(KeyCode::Char(ch), KeyModifiers::NONE),
            Instant::now(),
        )
        .await;
    }
    keys.drain();

    emit_on(
        &mut room,
        &mut seq,
        "turn-1",
        "lane.cancelled",
        json!({"laneId":"lane-turn-1-claude","agent":"claude","streamId":"stream-turn-1-claude"}),
    );
    complete_turn(&mut room, &mut seq, "turn-1");

    assert_eq!(
        room.prompt.text(),
        "new thought",
        "the operator's live draft survives byte-for-byte — the old submission \
         must never overwrite it"
    );
    assert!(
        room.pending_cancel_restore.is_empty(),
        "the refused stash is dropped rather than left to surface on a later, \
         unrelated cancel"
    );
    let told = refusal_notices(&mut room);
    assert_eq!(
        told.len(),
        1,
        "exactly one row, not one per event that re-ran the settle: {told:?}"
    );
    assert!(
        told[0].contains("A cancelled prompt was not restored because the composer already has"),
        "the operator is told: this is the one case where something they might expect back does not arrive: {told:?}"
    );
}

/// [PIN] Two cancelled turns settle together: the first restores, the second is
/// refused out loud rather than silently overwriting it.
///
/// There is one composer, so a second cancelled prompt has nowhere to go even
/// with an empty draft. That is a loss, so it gets a row.
#[tokio::test]
async fn a_second_cancelled_turn_cannot_overwrite_the_first_restore() {
    let mut keys = Keys::new();
    let mut room = RoomView::new();
    let mut seq = 0u64;

    type_and_submit(&keys, &mut room, "prompt one").await;
    keys.drain();
    type_and_submit(&keys, &mut room, "prompt two").await;
    keys.drain();

    let ids = keys.submissions();
    host_accepts(&mut room, ids[0], "turn-1");
    host_accepts(&mut room, ids[1], "turn-2");
    advance_to_running(&mut room, &mut seq, "turn-1", "claude");
    advance_to_running(&mut room, &mut seq, "turn-2", "codex");

    cancel_lane(&mut room, &mut seq, "turn-1", "claude");
    cancel_lane(&mut room, &mut seq, "turn-2", "codex");
    complete_turn(&mut room, &mut seq, "turn-1");
    complete_turn(&mut room, &mut seq, "turn-2");

    assert_eq!(
        room.prompt.text(),
        "prompt one",
        "the older cancelled submission is the one the composer gets back"
    );
    let told = refusal_notices(&mut room);
    assert_eq!(told.len(), 1, "exactly one refusal row: {told:?}");
    assert!(
        told[0].contains("A cancelled prompt was not restored because the composer already has"),
        "and the newer one is reported, not dropped in silence: {told:?}"
    );
}

/// [PIN] A turn that completes on its own leaves nothing behind for a later,
/// unrelated cancel to hand back.
///
/// The brief's other named hazard: *"a stash that is never claimed must not
/// leak into the next turn."* Two turns in one room deliberately — an
/// implementation with no per-submission scope has nothing to tell "this cancel
/// is about the completed turn" from "this cancel is about whatever is running
/// now."
#[tokio::test]
async fn a_turn_that_completes_on_its_own_leaves_no_stale_text_behind() {
    let mut keys = Keys::new();
    let mut room = RoomView::new();
    let mut seq = 0u64;

    type_and_submit(&keys, &mut room, "hello world").await;
    keys.drain();
    host_accepts_latest(&mut keys, &mut room, "turn-1");
    advance_to_running(&mut room, &mut seq, "turn-1", "claude");
    answer_lane(&mut room, &mut seq, "turn-1", "claude");
    complete_turn(&mut room, &mut seq, "turn-1");

    assert_eq!(
        room.prompt.text(),
        "",
        "an answered turn must never hand its text back"
    );
    assert!(
        room.pending_cancel_restore.is_empty(),
        "and the stash must not survive to answer some later, unrelated cancel"
    );

    // A second, unrelated turn now runs and is cancelled, with nothing
    // resubmitted since "hello world" completed.
    advance_to_running(&mut room, &mut seq, "turn-2", "codex");
    cancel_lane(&mut room, &mut seq, "turn-2", "codex");
    complete_turn(&mut room, &mut seq, "turn-2");

    assert_eq!(
        room.prompt.text(),
        "",
        "the already-completed turn's text must not resurface on a LATER, \
         unrelated cancel"
    );
}

/// [PIN] A cancel that lands after the turn already settled restores nothing.
///
/// The turn completed, so its entry left the queue at that moment. There is no
/// stash for a later cancel to find, which is what the operator ruled: a turn
/// that answered is finished with.
#[tokio::test]
async fn a_cancel_after_everything_finished_restores_nothing() {
    let mut keys = Keys::new();
    let mut room = RoomView::new();
    let mut seq = 0u64;

    type_and_submit(&keys, &mut room, "hello world").await;
    keys.drain();
    host_accepts_latest(&mut keys, &mut room, "turn-1");
    advance_to_running(&mut room, &mut seq, "turn-1", "claude");
    answer_lane(&mut room, &mut seq, "turn-1", "claude");
    complete_turn(&mut room, &mut seq, "turn-1");
    assert!(
        room.pending_cancel_restore.is_empty(),
        "the answered turn's entry left the queue when the host settled it"
    );

    // Now the operator presses the panic button on an idle room.
    keys.press_at(&mut room, esc(), Instant::now()).await;
    assert!(
        keys.drain().is_empty(),
        "an idle room has nothing to cancel, so nothing is sent"
    );
    assert_eq!(room.prompt.text(), "", "and nothing comes back");
}

/// [PIN] A wholesale reducer replacement invalidates every pending restore.
///
/// Turn ids restart at `turn-1` in every session, so an entry bound to `turn-3`
/// here would silently match a DIFFERENT `turn-3` in a loaded session and hand
/// back text from a turn it never named — the review's session/load half of
/// P0-2. Nothing constructs `RoomUpdate::Snapshot` in the tree today; this
/// pins the behaviour so the first sender does not inherit the collision.
#[tokio::test]
async fn a_snapshot_invalidates_every_pending_restore() {
    let mut keys = Keys::new();
    let mut room = RoomView::new();
    let mut seq = 0u64;

    type_and_submit(&keys, &mut room, "before the load").await;
    keys.drain();
    host_accepts_latest(&mut keys, &mut room, "turn-1");
    advance_to_running(&mut room, &mut seq, "turn-1", "claude");
    assert_eq!(
        room.pending_cancel_restore.len(),
        1,
        "the submission is outstanding before the snapshot arrives"
    );

    // A loaded session whose OWN turn-1 was cancelled — the exact collision.
    let mut loaded = RoomView::new();
    let mut loaded_seq = 0u64;
    advance_to_running(&mut loaded, &mut loaded_seq, "turn-1", "claude");
    cancel_lane(&mut loaded, &mut loaded_seq, "turn-1", "claude");
    complete_turn(&mut loaded, &mut loaded_seq, "turn-1");

    apply_room_snapshot_at(&mut room, loaded.reducer.clone(), Instant::now());

    assert!(
        room.pending_cancel_restore.is_empty(),
        "every entry is invalidated: its turn ids belong to the reducer that \
         was just thrown away"
    );
    assert_eq!(
        room.prompt.text(),
        "",
        "and the loaded session's own cancelled turn must not hand this \
         session's text back"
    );
}

/// [MUTATION] The queue is bounded, and overflow is reported.
///
/// Reaching the cap means turns stopped settling, which is a host defect the
/// operator should hear about rather than a silent eviction — and a
/// [`StashedPrompt`] can own pasted image bytes, so an unbounded queue against
/// such a host grows without limit.
#[tokio::test]
async fn the_pending_queue_is_bounded_and_says_so_when_it_overflows() {
    let mut keys = Keys::new();
    let mut room = RoomView::new();

    for index in 0..9 {
        type_and_submit(&keys, &mut room, &format!("prompt {index}")).await;
        keys.drain();
    }

    assert_eq!(
        room.pending_cancel_restore.len(),
        8,
        "the queue holds at most MAX_PENDING_RESTORES entries"
    );
    assert!(
        feed_lines(&mut room)
            .iter()
            .any(|line| line.contains("can no longer be restored")),
        "and the eviction is announced rather than silent"
    );
}

// ---------------------------------------------------------------------------
// FL-126 round 3 — what binds a turn to an entry when a submit queues none
//
// The round-2 mechanism bound an entry to the next `turn.accepted` BY POSITION.
// Two submits break that assumption, and both are reproduced below as the RED
// they were: `/council <topic>`, which the host accepts as a submit but which
// left the pager through an arm that queued no entry; and a submit the host
// REJECTS, which queues an entry and never produces a turn at all. Binding now
// happens on the submit's own response, by id, so neither can misdirect.
// ---------------------------------------------------------------------------

/// The host accepting the room's most recent submission as `turn`.
///
/// Every case that expects a restore has to do this, and that is the point: the
/// prompt is bound to a turn by the submit's own RESPONSE, so a case that never
/// lets the host answer is a case whose prompt is correctly still in limbo.
/// Round 2 bound on `turn.accepted` instead, which is why `/council` and a
/// refused submit could claim a stranger's prompt.
fn host_accepts_latest(keys: &mut Keys, room: &mut RoomView, turn: &str) {
    let ids = keys.submissions();
    let id = *ids
        .last()
        .expect("a submission must have reached the command wire");
    host_accepts(room, id, turn);
}

/// The host answering the submit the room most recently sent, through the run
/// loop's own `SubmitSettled` arm.
///
/// `apply_submit_settled` IS that arm — the select branch is one call to it —
/// so a case built out of this drives the production path and not a copy.
fn host_accepts(room: &mut RoomView, submission: super::SubmissionId, turn: &str) {
    apply_submit_settled(room, submission, Some(turn));
}

/// The host REFUSING a submit: the Slice A readiness refusal, an unroutable
/// address, oversized text, or journal capacity. No turn is ever minted.
fn host_refuses(room: &mut RoomView, submission: super::SubmissionId) {
    apply_submit_settled(room, submission, None);
}

/// [FALSIFIER · P1-A] `/council <topic>` is a submission and holds its own
/// prompt, so a later submit's turn cannot claim it.
///
/// RED against `6479bbf`, reproduced in this session before the fix:
///
/// ```text
/// entries after /council = 0
/// composer after cancelling the operator's OWN turn = ""
/// assertion `left == right` failed: the cancelled turn's own text comes back
///   left: ""
///  right: "prompt one"
/// ```
///
/// `/council` minted a turn but queued nothing, so its `turn.accepted` claimed
/// the next submission's stash and the operator's own cancelled turn handed
/// back nothing.
#[tokio::test]
async fn a_council_submission_holds_its_own_prompt() {
    let mut keys = Keys::new();
    let mut room = RoomView::new();
    let mut seq = 0u64;

    type_and_submit(&keys, &mut room, "/council pick a database").await;
    assert_eq!(
        room.pending_cancel_restore.len(),
        1,
        "/council is a submit the host accepts, so it holds a prompt like any \
         other — this is the count that was 0"
    );
    type_and_submit(&keys, &mut room, "prompt one").await;
    let ids = keys.submissions();
    assert_eq!(ids.len(), 2, "both submissions really reached the wire");

    // The council's response comes back first, and it names the council's turn.
    host_accepts(&mut room, ids[0], "turn-council");
    host_accepts(&mut room, ids[1], "turn-1");

    accept_turn(&mut room, &mut seq, "turn-council", &["claude"]);
    queue_lane(&mut room, &mut seq, "turn-council", "claude");
    start_lane(&mut room, &mut seq, "turn-council", "claude");
    advance_to_running(&mut room, &mut seq, "turn-1", "codex");

    cancel_lane(&mut room, &mut seq, "turn-1", "codex");
    complete_turn(&mut room, &mut seq, "turn-1");

    assert_eq!(
        room.prompt.text(),
        "prompt one",
        "the cancelled turn's own text comes back — the council's turn cannot \
         claim it"
    );
    assert_eq!(
        room.pending_cancel_restore.len(),
        1,
        "and the council's own prompt is still held, its turn still running"
    );
}

/// [FALSIFIER · P1-A] A cancelled `/council` hands its topic back.
///
/// RED against `6479bbf`:
///
/// ```text
/// composer after cancelling the COUNCIL = ""
/// assertion `left == right` failed: a cancelled council hands its topic back
///   left: ""
///  right: "/council pick a database"
/// ```
///
/// Under the operator's ruling a cancel is a cancel: they asked to stop it, so
/// they get their text back. Nothing about `/council` makes it different.
#[tokio::test]
async fn a_cancelled_council_hands_its_topic_back() {
    let mut keys = Keys::new();
    let mut room = RoomView::new();
    let mut seq = 0u64;

    type_and_submit(&keys, &mut room, "/council pick a database").await;
    let ids = keys.submissions();
    assert_eq!(ids.len(), 1, "/council really reached the host as a submit");
    host_accepts(&mut room, ids[0], "turn-council");

    advance_to_running(&mut room, &mut seq, "turn-council", "claude");
    cancel_lane(&mut room, &mut seq, "turn-council", "claude");
    complete_turn(&mut room, &mut seq, "turn-council");

    assert_eq!(
        room.prompt.text(),
        "/council pick a database",
        "a cancelled council hands its topic back like any other submission"
    );
}

/// [FALSIFIER · P1-B] A submit the host REFUSES releases its prompt, so the
/// next turn's cancel returns its own text.
///
/// RED against `6479bbf`, reproduced in this session:
///
/// ```text
/// composer after cancelling the RUNNING turn = "@gemini the refused prompt"
/// entries still stranded = 1
/// assertion `left == right` failed: the cancelled turn's OWN text is what the
///   operator asked to get back
///   left: "@gemini the refused prompt"
///  right: "the prompt that is really running"
/// ```
///
/// The live trigger is the Slice A readiness refusal: `@gemini …` on a machine
/// without the Antigravity CLI is refused by the host every time
/// (`src/room/room-host.ts`, `resolved.kind === "refused"`). The refused entry
/// stranded unbound and the NEXT accepted turn claimed it.
#[tokio::test]
async fn a_refused_submit_releases_its_prompt_instead_of_stranding_it() {
    let mut keys = Keys::new();
    let mut room = RoomView::new();
    let mut seq = 0u64;

    type_and_submit(&keys, &mut room, "@gemini the refused prompt").await;
    type_and_submit(&keys, &mut room, "the prompt that is really running").await;
    let ids = keys.submissions();
    assert_eq!(ids.len(), 2);
    assert_eq!(
        room.pending_cancel_restore.len(),
        2,
        "both are held until the host answers each"
    );

    host_refuses(&mut room, ids[0]);
    assert_eq!(
        room.pending_cancel_restore.len(),
        1,
        "the refused submission's prompt is released, not left to be claimed"
    );
    host_accepts(&mut room, ids[1], "turn-1");

    advance_to_running(&mut room, &mut seq, "turn-1", "claude");
    cancel_lane(&mut room, &mut seq, "turn-1", "claude");
    complete_turn(&mut room, &mut seq, "turn-1");

    assert_eq!(
        room.prompt.text(),
        "the prompt that is really running",
        "the cancelled turn's OWN text is what the operator asked to get back"
    );
}

/// [FALSIFIER · ordering] The submit's response may arrive AFTER its own turn
/// has already been cancelled and completed, and the prompt still comes back.
///
/// The response and the room's events reach the run loop on one channel from
/// two different tasks, so nothing orders them. This is the case that makes
/// `apply_submit_settled`'s trailing `settle` load-bearing: every settle pass
/// before the response skips the entry for having no turn id, and without that
/// call the prompt would sit in the queue with its turn already over.
#[tokio::test]
async fn a_late_submit_response_still_restores_an_already_cancelled_turn() {
    let mut keys = Keys::new();
    let mut room = RoomView::new();
    let mut seq = 0u64;

    type_and_submit(&keys, &mut room, "the whole turn beat the response").await;
    let ids = keys.submissions();

    // Every event for the turn, start to finish, before the response.
    advance_to_running(&mut room, &mut seq, "turn-1", "claude");
    cancel_lane(&mut room, &mut seq, "turn-1", "claude");
    complete_turn(&mut room, &mut seq, "turn-1");
    assert_eq!(
        room.prompt.text(),
        "",
        "nothing can restore yet: the room does not know which turn is which"
    );
    assert_eq!(room.pending_cancel_restore.len(), 1, "and it is still held");

    host_accepts(&mut room, ids[0], "turn-1");

    assert_eq!(
        room.prompt.text(),
        "the whole turn beat the response",
        "the response resolves a turn that is already over"
    );
}

/// [MUTATION] An answer to a submission this room no longer holds cannot claim
/// a different one's prompt.
///
/// ⚠ **This case is why binding is by id and not by position, and it exists
/// because a mutant proved the rest of the suite could not tell the two
/// apart.** With every submit queueing an entry and the bridge answering them
/// in order, "the oldest entry with no turn yet" is the right entry — right up
/// until an entry LEAVES the queue without a response: the cap evicts one
/// (`the_pending_queue_is_bounded_…`), or a snapshot invalidates all of them
/// (`a_snapshot_invalidates_…`). After either, a response still in flight
/// arrives with no entry of its own, and position hands it the next
/// submission's prompt — which is then restored against a turn the operator
/// never submitted it to.
///
/// Replacing `find(|entry| entry.id == id)` with
/// `find(|entry| entry.turn_id.is_none())` leaves every other case in this file
/// green and fails this one.
#[tokio::test]
async fn a_response_for_a_forgotten_submission_cannot_claim_another_prompt() {
    let mut keys = Keys::new();
    let mut room = RoomView::new();
    let mut seq = 0u64;

    type_and_submit(&keys, &mut room, "the survivor").await;
    let ids = keys.submissions();
    assert_eq!(
        room.pending_cancel_restore.len(),
        1,
        "one prompt is held, and it has NOT been bound yet — which is the \
         state a stray response can corrupt"
    );

    // A response for a submission this room no longer holds, naming a turn
    // that is nothing to do with the prompt above.
    host_accepts(&mut room, super::SubmissionId::synthetic(9_999), "turn-999");
    assert_eq!(
        room.pending_cancel_restore.len(),
        1,
        "the stray answer neither bound nor dropped anything"
    );

    // That turn now runs and is cancelled. Nothing may come back: no prompt in
    // this room belongs to it.
    advance_to_running(&mut room, &mut seq, "turn-999", "gemini");
    cancel_lane(&mut room, &mut seq, "turn-999", "gemini");
    complete_turn(&mut room, &mut seq, "turn-999");
    assert_eq!(
        room.prompt.text(),
        "",
        "a turn this room never submitted to must not hand back a prompt it \
         is holding for something else"
    );

    // And the real submission still answers for its own turn.
    host_accepts(&mut room, ids[0], "turn-1");
    advance_to_running(&mut room, &mut seq, "turn-1", "claude");
    cancel_lane(&mut room, &mut seq, "turn-1", "claude");
    complete_turn(&mut room, &mut seq, "turn-1");
    assert_eq!(
        room.prompt.text(),
        "the survivor",
        "the prompt was still there, still bindable, still its own"
    );
}

/// [MUTATION] A refusal releases the submission it names, not whichever is
/// oldest.
///
/// The companion to the case above for the other id lookup. Refusing the SECOND
/// of two outstanding submissions must leave the FIRST alone; a
/// `drop_submission` that popped the front instead would pass every other case
/// in this file, because they all refuse the oldest.
#[tokio::test]
async fn a_refusal_releases_the_submission_it_names() {
    let mut keys = Keys::new();
    let mut room = RoomView::new();
    let mut seq = 0u64;

    type_and_submit(&keys, &mut room, "the accepted one").await;
    type_and_submit(&keys, &mut room, "@gemini the refused one").await;
    let ids = keys.submissions();
    assert_eq!(ids.len(), 2);

    // The SECOND submission is the one the host refuses.
    host_refuses(&mut room, ids[1]);
    assert_eq!(
        room.pending_cancel_restore.len(),
        1,
        "exactly one released, and it must be the named one"
    );

    host_accepts(&mut room, ids[0], "turn-1");
    advance_to_running(&mut room, &mut seq, "turn-1", "claude");
    cancel_lane(&mut room, &mut seq, "turn-1", "claude");
    complete_turn(&mut room, &mut seq, "turn-1");

    assert_eq!(
        room.prompt.text(),
        "the accepted one",
        "the surviving submission is the one that was never refused"
    );
}

/// [FALSIFIER · P2-D] A turn whose lane FAILS says so, instead of dropping the
/// prompt in silence.
///
/// RED against `6479bbf`:
///
/// ```text
/// composer after a FAILED lane = ""
/// entries held = 0
/// rows pointing at /history = []
/// ```
///
/// ⚠ **Un-ruled, and deliberately not decided here.** The operator ruled on
/// "it answers" and on "we didn't get to cancel". A lane that died is neither:
/// no answer arrived and no cancel was asked for. Restoring would put text back
/// the operator never asked for; dropping in silence loses it with no signal.
/// This takes the third option — say so, point at `/history` — which leaves the
/// real decision open. If the operator rules "restore it", that is one branch.
#[tokio::test]
async fn a_failed_turn_says_the_prompt_is_recoverable() {
    let mut keys = Keys::new();
    let mut room = RoomView::new();
    let mut seq = 0u64;

    type_and_submit(&keys, &mut room, "the prompt that never got an answer").await;
    let ids = keys.submissions();
    host_accepts(&mut room, ids[0], "turn-1");

    advance_to_running(&mut room, &mut seq, "turn-1", "claude");
    emit_on(
        &mut room,
        &mut seq,
        "turn-1",
        "lane.failed",
        json!({"laneId":"lane-turn-1-claude","agent":"claude","streamId":"stream-turn-1-claude","error":"agent process exited"}),
    );
    complete_turn(&mut room, &mut seq, "turn-1");

    assert_eq!(
        room.prompt.text(),
        "",
        "a failure is not a cancel: the composer is not written over"
    );
    let told = feed_lines(&mut room)
        .into_iter()
        .filter(|line| line.contains("failed instead of answering"))
        .collect::<Vec<_>>();
    assert_eq!(
        told.len(),
        1,
        "and the operator is told once where to find it: {told:?}"
    );
    assert!(
        told[0].contains("/history"),
        "the row must name the recovery route: {told:?}"
    );
}

/// [PIN] A turn with BOTH a failed lane and a cancelled one restores, and says
/// nothing.
///
/// The cancel is what the operator asked for, so it wins outright; a "that
/// failed" row on top of a restore that landed would be noise about a prompt
/// they can already see in the composer.
#[tokio::test]
async fn a_cancel_outranks_a_failure_in_the_same_turn() {
    let mut keys = Keys::new();
    let mut room = RoomView::new();
    let mut seq = 0u64;

    type_and_submit(&keys, &mut room, "@all try this").await;
    let ids = keys.submissions();
    host_accepts(&mut room, ids[0], "turn-1");

    accept_turn(&mut room, &mut seq, "turn-1", &["claude", "codex"]);
    for agent in ["claude", "codex"] {
        queue_lane(&mut room, &mut seq, "turn-1", agent);
        start_lane(&mut room, &mut seq, "turn-1", agent);
    }
    emit_on(
        &mut room,
        &mut seq,
        "turn-1",
        "lane.failed",
        json!({"laneId":"lane-turn-1-claude","agent":"claude","streamId":"stream-turn-1-claude","error":"agent process exited"}),
    );
    cancel_lane(&mut room, &mut seq, "turn-1", "codex");
    complete_turn(&mut room, &mut seq, "turn-1");

    assert_eq!(
        room.prompt.text(),
        "@all try this",
        "the cancel the operator asked for decides the turn"
    );
    assert!(
        feed_lines(&mut room)
            .iter()
            .all(|line| !line.contains("failed instead of answering")),
        "and no failure row is printed over a restore that landed"
    );
}
