//! Shared Zer0 room state hosted by the actual Grok pager crate.
//!
//! The terminal application owns this projection; the Node host remains the
//! source of truth and Rust only retains a reducer-backed display cache.

use std::collections::BTreeSet;
use std::time::Instant;

use crossterm::event::{MouseButton, MouseEvent, MouseEventKind};
use ratatui::layout::{Position, Rect};

use crate::room_composer_menu::{RoomCatalogSnapshot, RoomComposerMenu};
use crate::room_ctrl_c_gesture::CtrlCGesture;
use crate::room_permission_view::RoomPermissionView;
use crate::room_picker::RoomPickerState;
use crate::room_prompt_restore::PendingRestores;
use crate::room_scrollback::{RoomScrollback, RoomSpeaker};
use crate::scrollback::{EntryId, ResolvedSelectionModel};
use crate::views::history_search::HistoryEntry;
use crate::views::prompt_widget::PromptWidget;
use zer0_room_protocol::RoomReducer;

/// One committed answer the operator has not read yet (spec §D.6).
///
/// Identified by `message_id` and nothing else that can go stale: the answer's
/// `EntryId` is reallocated by every snapshot, and its screen position is
/// meaningless outside a laid-out frame. `agent` is carried rather than
/// re-derived so the pill can name agents without a reducer scan per frame,
/// and `commit_event_seq` is what orders the list — commit order, oldest
/// first, which is the order the operator missed them in.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UnseenAnswer {
    pub message_id: String,
    pub agent: RoomSpeaker,
    pub commit_event_seq: String,
}

/// How far the room's last room-wide cancel actually got.
///
/// Three states because the room has three genuinely different things to say
/// and only ever had words for one of them. `Asked` is a local enqueue: real,
/// but it is the room talking to itself. `Reached` is the host having answered
/// the request. The guidance row's wording is derived from this rather than
/// from the fact that a `send` returned `Ok`, which is what let the room paint
/// `agents stopped` over three agents that were still working.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum RoomCancelClaim {
    /// Nothing has been asked for.
    #[default]
    Idle,
    /// The room asked. The host has not answered.
    Asked { seq: u64 },
    /// The host answered the ask numbered `seq`.
    Reached { seq: u64 },
}

impl RoomCancelClaim {
    /// The ask this claim is about. `0` is "none", which no real ask ever uses
    /// because [`Self::ask`] pre-increments.
    pub fn seq(self) -> u64 {
        match self {
            Self::Idle => 0,
            Self::Asked { seq } | Self::Reached { seq } => seq,
        }
    }

    /// The claim after a fresh ask. Always a NEW number, including when the
    /// previous ask was already answered: a second cancel is a second question,
    /// and reusing the number would let the first answer stand in for it.
    pub fn ask(self) -> Self {
        Self::Asked {
            seq: self.seq().saturating_add(1),
        }
    }

    /// The claim after the host answered ask `seq`.
    ///
    /// A mismatched or late answer is DROPPED rather than applied. That is the
    /// whole reason the number is carried: an acknowledgement of a superseded
    /// cancel arriving after a new one was sent is evidence about the old
    /// question, and applying it would say "agents stopped" about agents nobody
    /// has heard from yet.
    pub fn answered(self, seq: u64) -> Self {
        match self {
            Self::Asked { seq: asked } if asked == seq => Self::Reached { seq },
            unchanged => unchanged,
        }
    }

    /// Whether the host has answered the ask this claim is about.
    pub fn host_answered(self) -> bool {
        matches!(self, Self::Reached { .. })
    }
}

/// One agent's boot-sampled readiness, as decided by the host and delivered
/// over `zer0/room/agents`.
///
/// The room holds a decided value and never a probe result: the deciding and
/// the parsing both belong to the host side and to the slice that builds it.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub enum RoomAgentReadiness {
    /// Not sampled yet, or the probe declined to answer.
    ///
    /// Renders exactly as `Ready` does, which is what makes the first frame the
    /// same frame it was before any probe existed: a room that cannot prove an
    /// agent is unavailable does not say that it is.
    #[default]
    Unknown,
    Ready,
    NeedsLogin {
        command: String,
    },
    Unusable {
        reason: String,
        remedy: String,
    },
}

/// Readiness for the room's three seats. Defaults to all-`Unknown`, so a room
/// whose probe never lands renders as it always has.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RoomReadinessSnapshot {
    pub claude: RoomAgentReadiness,
    pub codex: RoomAgentReadiness,
    pub gemini: RoomAgentReadiness,
}

/// How long two clicks on the same row still count as one double-click.
///
/// Grok's own number and grok's own comparison: `MULTI_CLICK_TIMEOUT_MS: u128 = 300`
/// (grok-ref `app/agent_view/mod.rs:447`), compared STRICTLY less-than
/// (grok-ref `app/agent_view/selection.rs:956`). Matched rather than chosen, so
/// the room's double-click feels like every other double-click in this family.
const MULTI_CLICK_TIMEOUT_MS: u128 = 300;

/// A left-button press inside the feed, waiting for its release.
///
/// The decision is made on `Up`, never on `Down` - grok's shape
/// (grok-ref `app/mouse.rs:770` records, `:806-807` decides). A single click
/// must never fold, and a gesture that acted on the press could not tell the
/// difference between one click and the first half of two.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct PendingFeedClick {
    column: u16,
    row: u16,
}

/// The last completed feed click, for multi-click counting.
///
/// Keyed by `EntryId`, NOT by entry index. Upstream compares indices
/// (grok-ref `app/agent_view/selection.rs:955`), which is safe in a
/// single-agent view; here three lanes insert rows into one shared feed
/// between two clicks, so an index would silently move the gesture's subject
/// to whatever row slid under it. Costs one id lookup per release.
#[derive(Clone, Copy, Debug)]
pub(crate) struct RoomFeedClick {
    at: Instant,
    entry_id: EntryId,
    count: u8,
}

/// One shared chronological room projection. Individual agents are speakers
/// in one feed, never separate terminal panes.
pub struct RoomView {
    pub prompt: PromptWidget,
    pub reducer: RoomReducer,
    pub scrollback: RoomScrollback,
    pub permissions: RoomPermissionView,
    pub catalog: RoomCatalogSnapshot,
    pub composer_menu: RoomComposerMenu,
    /// One mutually-exclusive global picker for models, skills, and persisted
    /// conversations. It owns transient UI state, never provider/session data.
    pub picker: RoomPickerState,
    /// Shared render cadence for active room-only animation. Quiet rooms do
    /// not use it, so no idle surface invents motion.
    pub render_tick: u64,
    /// Accessibility motion policy. The room uses one deterministic injected
    /// flag so reduced motion freezes both status glyphs and native rail ticks.
    pub reduced_motion: bool,
    /// Tracks whether the previous terminal frame contained an attached
    /// composer overlay. Closing an overlay forces one full diff frame so
    /// border cells cannot survive in terminals with imperfect damage repair.
    pub(crate) overlay_visible_last_frame: bool,
    /// Local pager history for the existing history-search widget. The room
    /// host remains authoritative for transcript state; this only remembers
    /// operator drafts submitted from this terminal.
    pub history: Vec<HistoryEntry>,
    /// Latched once the room has been observed holding content. The welcome
    /// card is a first-run greeting, not an empty-feed placeholder: a room that
    /// has already had something in it must not re-greet the operator when that
    /// content goes away.
    welcome_retired: bool,
    /// When the welcome card was first painted. The entrance is a function of
    /// elapsed time from here, so a resize re-renders whatever the clock says —
    /// by then, the settled state — instead of replaying the animation.
    welcome_started: Option<Instant>,
    /// Seconds a keystroke added to the card's clock to skip the entrance.
    ///
    /// An OFFSET, not a latch, and not a wound-back `Instant`. A latch that
    /// pinned the clock at `ENTRANCE_SECS` would also stop the shine, and the
    /// operator ruled on 2026-08-19 that the shine keeps going; winding
    /// `welcome_started` backwards instead can underflow on a machine that has
    /// only just booted. Adding a constant does neither: the entrance jumps to
    /// its end and the clock keeps running from there.
    welcome_skip_offset: Option<f32>,
    /// What the shipped binary prints for `--version`, shown on the boot card.
    /// Empty until the composition root supplies it, and the card omits the
    /// line rather than inventing a number.
    pub version: String,
    /// When an armed second `Ctrl+C` stops meaning "quit" again.
    ///
    /// A deadline and not a latch, because the two other ways out of the armed
    /// state — another accepted keypress, and the lanes reaching idle — both
    /// need something to happen, and a lane wedged in `Cancelling` produces
    /// neither. Only the clock is guaranteed to fire.
    ///
    /// Written by nothing yet. It is here so that one commit adds this struct's
    /// fields rather than three commits each rebasing over the others.
    pub quit_armed_until: Option<Instant>,
    /// The `Ctrl+C` the operator is holding down right now, if any.
    ///
    /// Separate from `quit_armed_until` and outliving it on purpose. The arm is
    /// about what the ROOM offers; this is about what the OPERATOR'S HAND is
    /// doing, and the two clear on different events — a lane reaching idle
    /// retires the arm while the key is still held, and handing that same held
    /// key to the next rung is the defect (`room_ctrl_c_gesture`).
    pub ctrl_c_gesture: CtrlCGesture,
    /// How far the room's last room-wide cancel actually got.
    pub cancel_claim: RoomCancelClaim,
    /// The submitted prompts this room might still owe the composer, because
    /// their turn could still be cancelled (FL-126).
    ///
    /// Deliberately upstream's `stash`/`restore` pair and not a new
    /// mechanism — `views/prompt_widget/mod.rs:951,974` — but a deliberate
    /// deviation from upstream's *behaviour*: upstream's cancel path does not
    /// hand a cancelled turn's text back. (It does call `prompt.restore` in
    /// `app/dispatch/turn.rs`'s `cancel_agent_turn`, but for a plan-approval
    /// overlay's stash, not for the submitted turn text — the narrow claim, not
    /// the file.) All behaviour lives in [`crate::room_prompt_restore`]; this
    /// is only where the room keeps it.
    pub pending_cancel_restore: PendingRestores,
    /// Agents last seen carrying an `exhausted` availability, so the footer can
    /// keep saying `out of usage` after the state degrades to `local_blocked`.
    ///
    /// THE WIRE GAP THIS COVERS, and why the memory lives here rather than in
    /// the protocol. `roomAgentStatusPayload` puts only `state` and
    /// `resetsAtMs` on `availability`, and the schema object is
    /// `additionalProperties: false`, so the Node model's `cause` — which knows
    /// whether a blocked lane is spent or unauthenticated — never crosses. The
    /// very NEXT send to a dead lane walks `exhausted -> local_blocked`
    /// (`lane-gate.ts`'s `noteLaneBlockedSend`), so without this the operator
    /// watched the word flip from `out of usage` to `offline` — the word this
    /// room reserves for a dead wire — about one message after codex died, and
    /// stay wrong for the rest of the cooldown.
    ///
    /// Derived, never guessed: an entry is written only when a real
    /// `exhausted` verdict is observed, and dropped the moment the lane reports
    /// `ready` or its reset instant passes. Deriving it from `usage.exhausted`
    /// instead was rejected in the round-2 lane and is still rejected — that
    /// bit belongs to the last usage SNAPSHOT from a different producer, so it
    /// would sometimes tell an out-of-quota operator to sign in.
    pub(crate) spent_lanes: BTreeSet<String>,
    /// The earliest FUTURE reset instant among the agents currently wearing a
    /// health word — the one moment at which the painted room changes with no
    /// event and no keypress behind it.
    ///
    /// ITEM F. A health state expires by the clock alone: `active_availability`
    /// reads a reset that has passed as "this state is over", so at that instant
    /// the red state row retires and the footer shrinks from three rows back to
    /// two, which also gives the transcript a row back. Nothing produced an
    /// event, so nothing marked the frame dirty, and the stale picture stayed on
    /// screen until the operator happened to type. Recomputed by the idle poll
    /// (`reconcile_health_reset_at`), which is the only thing running at all
    /// while a room sits idle. `None` — the ordinary case, every agent healthy —
    /// costs that poll one `Option` compare.
    pub(crate) health_reset_due_ms: Option<u64>,
    /// Per-agent readiness sampled once at boot.
    ///
    /// Written by nothing yet; all-`Unknown` renders as today's room does.
    pub readiness: RoomReadinessSnapshot,
    /// Where the feed was painted on the last frame.
    ///
    /// The rect is computed inside the render pass and, until this field
    /// existed, discarded there — which left the mouse handler with no idea
    /// where the feed is. Written every frame, read by nothing yet.
    pub feed_rect: Rect,
    /// Where the one-row guidance line was painted on the last frame.
    ///
    /// The whole row, not a widget inside it: what will eventually be clickable
    /// there is a pill occupying part of the row, and the slice that adds the
    /// pill is the one that can say how wide it is. Written every frame, read by
    /// nothing yet.
    pub guidance_rect: Rect,
    /// Answers the operator has not read yet, oldest commit first (spec
    /// §D.6).
    ///
    /// **Message ids, never `EntryId`s**, and that is the whole design rather
    /// than a preference. Wave 0 shipped this field as `Vec<EntryId>` written
    /// by nothing, and three separate facts make that shape unusable: there is
    /// no valid geometry at commit time (the layout cache is invalidated by
    /// the commit itself, by C's fold and by D's move, and is rebuilt only
    /// inside `prepare_layout` during render); `is_entry_visible` means
    /// "included in the current view mode", which in the room's `AllTurns` is
    /// every entry; and a snapshot replaces the whole scrollback and
    /// reallocates every id while leaving this field alone, so stored ids
    /// would point at nothing. Nothing stored here can go stale.
    ///
    /// Appended once per committed answer, and RECONCILED against real
    /// geometry every frame — there is no drain-on-activation path, which is
    /// why `Ctrl+T` needs no bookkeeping.
    pub unseen_answers: Vec<UnseenAnswer>,
    /// Exactly where the unseen-answer pill was painted on the last frame, or
    /// `None` when no pill painted.
    ///
    /// Separate from `guidance_rect`, which is the WHOLE row: a click has to
    /// hit the pill, not the empty columns beside it. Written unconditionally
    /// every frame by `render_room`, which is also the clear.
    pub answer_pill_rect: Option<Rect>,
    /// The resolved selection model from the most recent draw.
    ///
    /// Written unconditionally every frame by `render_room`, which is also the
    /// clear: the pane returns `Default::default()` for a zero-area rect. A
    /// model from an older frame would hit-test against a layout that no longer
    /// exists, which is worse than having none.
    pub last_scrollback_selection_model: ResolvedSelectionModel,
    /// A left press inside the feed that has not been released yet.
    pub(crate) pending_feed_click: Option<PendingFeedClick>,
    /// The previous completed feed click, for double-click counting.
    pub(crate) last_feed_click: Option<RoomFeedClick>,
}

impl Default for RoomView {
    fn default() -> Self {
        Self::new()
    }
}

impl RoomView {
    pub fn new() -> Self {
        let mut prompt = PromptWidget::new();
        prompt.set_frontend_command_catalog([
            crate::slash::FrontendCommand::new(
                "model",
                "Choose a model on a live agent session",
                true,
            ),
            crate::slash::FrontendCommand::new(
                "skills",
                "Browse supported discovered skills",
                true,
            ),
            crate::slash::FrontendCommand::new(
                "resume",
                "Switch to another V2 conversation",
                false,
            ),
            crate::slash::FrontendCommand::new("new", "Start a new conversation", false),
            crate::slash::FrontendCommand::new("mode", "Cycle one agent's native mode", true),
            crate::slash::FrontendCommand::new("pause", "Pause active room work", false),
            crate::slash::FrontendCommand::new("unpause", "Resume paused room work", false),
            crate::slash::FrontendCommand::new(
                "cancel",
                "Cancel latest work, all work, or one agent",
                true,
            ),
            crate::slash::FrontendCommand::new(
                "approve",
                "Answer a pending permission request",
                true,
            ),
            crate::slash::FrontendCommand::new("history", "Search submitted prompts", false),
            crate::slash::FrontendCommand::new(
                "council",
                "Ask all agents for independent answers",
                true,
            ),
            crate::slash::FrontendCommand::new("status", "Show live agent state", false),
            crate::slash::FrontendCommand::new("help", "Show Zer0 room commands", false),
            crate::slash::FrontendCommand::new("exit", "Close the Zer0 room", false),
        ]);
        Self {
            prompt,
            reducer: RoomReducer::new(),
            scrollback: RoomScrollback::new(),
            permissions: RoomPermissionView::default(),
            catalog: RoomCatalogSnapshot::default(),
            composer_menu: RoomComposerMenu::default(),
            picker: RoomPickerState::new(String::new()),
            render_tick: 0,
            reduced_motion: reduced_motion_from_env(),
            overlay_visible_last_frame: false,
            history: Vec::new(),
            welcome_retired: false,
            welcome_started: None,
            welcome_skip_offset: None,
            version: String::new(),
            quit_armed_until: None,
            ctrl_c_gesture: CtrlCGesture::default(),
            cancel_claim: RoomCancelClaim::default(),
            pending_cancel_restore: PendingRestores::default(),
            spent_lanes: BTreeSet::new(),
            health_reset_due_ms: None,
            readiness: RoomReadinessSnapshot::default(),
            feed_rect: Rect::default(),
            guidance_rect: Rect::default(),
            unseen_answers: Vec::new(),
            answer_pill_rect: None,
            last_scrollback_selection_model: ResolvedSelectionModel::default(),
            pending_feed_click: None,
            last_feed_click: None,
        }
    }

    /// Whether this frame should paint the empty-room welcome card.
    ///
    /// Observed, never intended: the latch flips off the rendered feed's own
    /// emptiness, so a resumed session — whose reducer and scrollback are
    /// installed after `RoomView::new` — retires the card on its very first
    /// frame without anyone having to remember to call something.
    pub fn welcome_card_visible(&mut self) -> bool {
        if self.welcome_retired {
            return false;
        }
        if !self.scrollback.is_empty() {
            self.welcome_retired = true;
            return false;
        }
        true
    }

    /// Seconds into the card's life for the frame about to be painted, starting
    /// the clock on the first call. Only meaningful while
    /// [`Self::welcome_card_visible`] holds.
    ///
    /// Keeps advancing forever: past [`crate::room_welcome::ENTRANCE_SECS`] the
    /// entrance is over but the mark's shine is not, so the card needs a clock
    /// that goes on running, not one that parks.
    pub fn welcome_elapsed_secs(&mut self) -> f32 {
        let elapsed = self
            .welcome_started
            .get_or_insert_with(Instant::now)
            .elapsed()
            .as_secs_f32();
        elapsed + self.welcome_skip_offset.unwrap_or(0.0)
    }

    /// End the entrance now, leaving the settled card still breathing.
    ///
    /// Called for EVERY accepted keystroke, and deliberately not a consumption
    /// of one: the key goes on to whatever would have handled it. An operator
    /// who starts typing has said they are done watching, and swallowing their
    /// first character to deliver that would be the worse bug by a distance.
    ///
    /// Jumps the clock exactly to the end of the entrance rather than past it,
    /// so the shine picks up where the entrance left it instead of lurching.
    /// Idempotent, and harmless before the card has ever been painted.
    pub fn skip_welcome_entrance(&mut self) {
        if self.welcome_skip_offset.is_some() {
            return;
        }
        let elapsed = self
            .welcome_started
            .map(|started| started.elapsed().as_secs_f32())
            .unwrap_or(0.0);
        self.welcome_skip_offset = Some((crate::room_welcome::ENTRANCE_SECS - elapsed).max(0.0));
    }

    /// Replay the entrance from zero. The demo surface's `r` key; nothing on a
    /// shipping path calls this.
    pub fn restart_welcome(&mut self) {
        self.welcome_retired = false;
        self.welcome_started = None;
        self.welcome_skip_offset = None;
    }

    /// Wind the card's clock back so the next frame renders the SETTLED state.
    ///
    /// Tests assert on the settled card constantly, and the honest alternative —
    /// sleeping out a 1.38 s entrance in each one — would make them both slow and
    /// timing-dependent, which is the failure mode FL-070 already cost this
    /// project once.
    #[cfg(test)]
    pub(crate) fn force_welcome_settled(&mut self) {
        let entrance = std::time::Duration::from_secs_f32(crate::room_welcome::ENTRANCE_SECS + 1.0);
        self.welcome_started = Some(Instant::now() - entrance);
    }

    pub fn remember_submission(&mut self, text: &str) {
        let text = text.trim();
        if text.is_empty() || self.history.first().is_some_and(|entry| entry.text == text) {
            return;
        }
        self.history.insert(
            0,
            HistoryEntry {
                text: text.to_owned(),
            },
        );
        self.history.truncate(100);
        self.prompt.history_search.refresh_items(&self.history);
    }

    /// The feed's own mouse arm: single click selects, double click folds.
    ///
    /// Runs before the composer fall-through and only inside the retained feed
    /// rect; everything outside it still reaches `prompt.handle_mouse`. Returns
    /// whether the event was consumed.
    ///
    /// `now` is a parameter rather than an `Instant::now()` inside, because the
    /// only thing separating a double-click from two single clicks is the gap
    /// between two instants, and a test that cannot choose both of them is
    /// testing the clock.
    ///
    /// Guard order is grok's (grok-ref `app/mouse.rs:807-861`): an exact text
    /// hit consumes the click first, and only then does the row resolve to an
    /// entry. The reason is written down at grok-ref
    /// `scrollback/text_selection.rs:415-419` - a hit is returned only when the
    /// click is directly on selectable columns, so clicks on accent bars,
    /// borders and padding fall through to block-level handling.
    pub fn handle_feed_mouse_at(&mut self, mouse: &MouseEvent, now: Instant) -> bool {
        match mouse.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                if !self
                    .feed_rect
                    .contains(Position::new(mouse.column, mouse.row))
                {
                    self.pending_feed_click = None;
                    return false;
                }
                self.pending_feed_click = Some(PendingFeedClick {
                    column: mouse.column,
                    row: mouse.row,
                });
                true
            }
            MouseEventKind::Up(MouseButton::Left) => {
                // The press decided this gesture belongs to the feed, so the
                // feed owns its release too - including a release that drifted
                // off the row it started on. No pending press means the press
                // was somewhere else and this release is not ours.
                let Some(pending) = self.pending_feed_click.take() else {
                    return false;
                };
                if self
                    .last_scrollback_selection_model
                    .hit_test_text_exact(pending.column, pending.row)
                    .is_some()
                {
                    self.last_feed_click = None;
                    return true;
                }
                let Some(hit) = self
                    .scrollback
                    .feed_hit_at_screen_row(pending.row, self.feed_rect)
                else {
                    // Inside the feed but on a gap between entries. Consumed,
                    // and the click chain is broken: the next click on a row
                    // starts a fresh count rather than inheriting this one.
                    self.last_feed_click = None;
                    return true;
                };
                let count = match self.last_feed_click {
                    Some(last)
                        if last.entry_id == hit.entry_id
                            && now.duration_since(last.at).as_millis() < MULTI_CLICK_TIMEOUT_MS =>
                    {
                        last.count.saturating_add(1)
                    }
                    _ => 1,
                };
                // Always select, on every click, exactly as upstream does
                // (grok-ref `app/agent_view/selection.rs:988`) - the selection
                // is what makes the expand hint appear, so a click that folded
                // without selecting would leave the operator no way back.
                self.scrollback.select_entry(hit.index);
                if count == 2 && hit.foldable {
                    self.scrollback.toggle_fold_selected();
                }
                self.last_feed_click = (count < 3).then_some(RoomFeedClick {
                    at: now,
                    entry_id: hit.entry_id,
                    count,
                });
                true
            }
            _ => false,
        }
    }

    /// The unseen-answer pill's click arm (spec §D.6).
    ///
    /// Runs BEFORE the feed hit-test, because the pill lives on the guidance
    /// row and C's feed arm only answers inside `feed_rect` — a click here
    /// would otherwise hit-test against nothing and fall through to the
    /// composer. It answers only inside the exact rect the pill painted, never
    /// the whole guidance row.
    ///
    /// The press activates and the release is swallowed: a jump has no drag
    /// or double-click meaning, and leaving the release to fall through would
    /// hand the composer a mouse-up it has no business seeing.
    pub fn handle_answer_pill_mouse(&mut self, mouse: &MouseEvent) -> bool {
        let Some(rect) = self.answer_pill_rect else {
            return false;
        };
        if !rect.contains(Position::new(mouse.column, mouse.row)) {
            return false;
        }
        match mouse.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                self.jump_to_first_unseen_answer();
                true
            }
            MouseEventKind::Up(MouseButton::Left) => true,
            _ => false,
        }
    }

    /// Scroll to the unseen answer that reads FIRST on screen, top to bottom
    /// (spec §D.7's `Ctrl+T`, as amended by the design memo).
    ///
    /// Screen order, not commit order, and the difference is FL-141: lane rows
    /// read in roster order, so an answer committed second can sit above one
    /// committed first. Walking commit order would send the operator backwards
    /// up the feed.
    ///
    /// Nothing is drained. The jump makes the target's first row visible, and
    /// the SAME frame's reconciliation drops it from the list — so repeated
    /// activation walks forward with no bookkeeping. Ids that no longer
    /// resolve are dropped here rather than jumped to, per §D.7.
    ///
    /// Returns whether the viewport moved, so a caller can tell "nothing to
    /// jump to" from "jumped".
    pub fn jump_to_first_unseen_answer(&mut self) -> bool {
        // Taken out first: `retain` over the vector while asking the
        // scrollback about each entry borrows `self` twice.
        let unseen = std::mem::take(&mut self.unseen_answers);
        let mut kept = Vec::with_capacity(unseen.len());
        let mut target: Option<(usize, String)> = None;
        for answer in unseen {
            let Some(index) = self.scrollback.answer_top_index(&answer.message_id) else {
                continue;
            };
            if target.as_ref().is_none_or(|(best, _)| index < *best) {
                target = Some((index, answer.message_id.clone()));
            }
            kept.push(answer);
        }
        self.unseen_answers = kept;
        let Some((_, message_id)) = target else {
            return false;
        };
        self.scrollback.scroll_to_answer_top(&message_id)
    }

    /// Normalize unaddressed operator input to the room while preserving an
    /// explicit leading address. There is no hidden selected target.
    pub fn addressed_submission(&self, text: &str) -> String {
        let trimmed = text.trim();
        if is_explicit_room_address(trimmed) || trimmed.starts_with('/') {
            trimmed.to_owned()
        } else {
            format!("@all {trimmed}")
        }
    }
}

fn reduced_motion_from_env() -> bool {
    std::env::var("ZER0_REDUCED_MOTION").is_ok_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

fn is_explicit_room_address(text: &str) -> bool {
    text.split_whitespace().next().is_some_and(|token| {
        matches!(
            token.to_ascii_lowercase().as_str(),
            "@all" | "@claude" | "@codex" | "@gemini"
        )
    })
}

#[cfg(all(test, feature = "room-runtime"))]
mod tests {
    use std::time::Duration;

    use crossterm::event::{KeyCode, KeyEvent, MouseButton, MouseEvent, MouseEventKind};
    use ratatui::buffer::Buffer;
    use ratatui::layout::Rect;

    use super::{MULTI_CLICK_TIMEOUT_MS, RoomView};
    use crate::room_scrollback::test_fixture::{StepsTurn, live_room};
    use crate::scrollback::DisplayMode;

    fn type_into_prompt(room: &mut RoomView, text: &str) {
        for ch in text.chars() {
            room.prompt.handle_key(&KeyEvent::from(KeyCode::Char(ch)));
        }
    }

    #[test]
    fn room_owns_one_real_pager_composer_and_defaults_to_all() {
        let mut room = RoomView::new();
        assert_eq!(
            room.addressed_submission("inspect this"),
            "@all inspect this"
        );
        assert_eq!(
            room.addressed_submission("@codex inspect this"),
            "@codex inspect this"
        );
        assert_eq!(
            room.addressed_submission("@file src/main.rs"),
            "@all @file src/main.rs"
        );
        type_into_prompt(&mut room, "/ca");
        room.prompt.refresh_frontend_slash();
        assert_eq!(
            room.prompt
                .slash_snapshot()
                .selection()
                .map(|row| row.command_name()),
            Some("cancel")
        );
    }

    /// A room whose feed holds one finished claude lane and its folded steps
    /// row, painted once so the hit-test model describes a real layout.
    fn room_with_a_painted_feed() -> (RoomView, Rect) {
        let (scrollback, reducer) = live_room(&[StepsTurn::claude(&["completed"; 3])]);
        let mut room = RoomView::new();
        room.scrollback = scrollback;
        room.reducer = reducer;
        let feed = Rect::new(0, 0, 80, 20);
        let mut buffer = Buffer::empty(feed);
        room.feed_rect = feed;
        room.last_scrollback_selection_model = room.scrollback.render(feed, &mut buffer);
        (room, feed)
    }

    fn mouse(kind: MouseEventKind, column: u16, row: u16) -> MouseEvent {
        MouseEvent {
            kind,
            column,
            row,
            modifiers: crossterm::event::KeyModifiers::NONE,
        }
    }

    fn click(room: &mut RoomView, column: u16, row: u16, at: std::time::Instant) -> bool {
        let down = room.handle_feed_mouse_at(
            &mouse(MouseEventKind::Down(MouseButton::Left), column, row),
            at,
        );
        let up = room.handle_feed_mouse_at(
            &mouse(MouseEventKind::Up(MouseButton::Left), column, row),
            at,
        );
        down && up
    }

    /// The screen row the folded steps entry was painted on, and a column that
    /// is NOT selectable text - the accent bar, which is what SS-C.8 says must
    /// fall through to block-level handling.
    fn steps_row(room: &RoomView, feed: Rect) -> u16 {
        let id = room
            .scrollback
            .steps_entry_id_for_stream("stream")
            .expect("the fixture lane ran three tools");
        (feed.y..feed.y + feed.height)
            .find(|row| {
                room.scrollback
                    .feed_hit_at_screen_row(*row, feed)
                    .is_some_and(|hit| hit.entry_id == id)
            })
            .expect("the steps entry is on screen")
    }

    /// SS-C.12 site 18, all three halves in one test.
    ///
    /// What wrong implementation would still pass a looser version? One that
    /// folded on every click — so the single-click case asserts the mode is
    /// UNCHANGED, not merely that something was selected. And one that acted on
    /// `Down`, which cannot tell one click from the first half of two; the
    /// gesture here is always a Down/Up pair.
    #[test]
    fn a_double_click_toggles_the_row_and_a_single_click_does_not() {
        for width in [80u16, 40] {
            let (scrollback, reducer) = live_room(&[StepsTurn::claude(&["completed"; 3])]);
            let mut room = RoomView::new();
            room.scrollback = scrollback;
            room.reducer = reducer;
            let feed = Rect::new(0, 0, width, 20);
            let mut buffer = Buffer::empty(feed);
            room.feed_rect = feed;
            room.last_scrollback_selection_model = room.scrollback.render(feed, &mut buffer);

            let row = steps_row(&room, feed);
            let folded = room
                .scrollback
                .steps_display_mode("stream")
                .expect("the steps entry exists");
            assert_eq!(folded, DisplayMode::Collapsed, "at width {width}");

            // Column 0 is the accent bar: inside the entry, never selectable
            // text, which is the case SS-C.8 routes to block-level handling.
            let start = std::time::Instant::now();
            assert!(click(&mut room, 0, row, start), "the feed consumed it");
            assert_eq!(
                room.scrollback.steps_display_mode("stream"),
                Some(DisplayMode::Collapsed),
                "a single click must never fold, at width {width}"
            );
            assert!(
                room.scrollback.selected_index().is_some(),
                "but it does select, at width {width}"
            );

            // The second click, inside the window.
            let second = start + Duration::from_millis(MULTI_CLICK_TIMEOUT_MS as u64 - 1);
            assert!(click(&mut room, 0, row, second));
            assert_eq!(
                room.scrollback.steps_display_mode("stream"),
                Some(DisplayMode::Expanded),
                "the double click folds, at width {width}"
            );
        }
    }

    /// Two clicks further apart than the multi-click window are two single
    /// clicks, and the comparison is STRICTLY less-than, matching grok-ref
    /// `app/agent_view/selection.rs:956`.
    #[test]
    fn two_clicks_outside_the_window_are_two_single_clicks() {
        let (mut room, feed) = room_with_a_painted_feed();
        let row = steps_row(&room, feed);
        let start = std::time::Instant::now();
        assert!(click(&mut room, 0, row, start));
        // Exactly the timeout: `<` says this is NOT a double click.
        let boundary = start + Duration::from_millis(MULTI_CLICK_TIMEOUT_MS as u64);
        assert!(click(&mut room, 0, row, boundary));
        assert_eq!(
            room.scrollback.steps_display_mode("stream"),
            Some(DisplayMode::Collapsed),
            "300ms apart is two single clicks, not a double click"
        );
    }

    /// A click on selectable text is consumed before the fold, and it never
    /// touches the composer.
    ///
    /// The two rows this exercises are different on purpose, and the difference
    /// is the whole design: the room's ANSWER body is an `AgentMessageBlock`,
    /// which marks its lines selectable (`scrollback/blocks/agent.rs:289` pins
    /// `selection_range == Some(0)`), so a click on it is a text click. The
    /// folded STEPS row does not mark its lines selectable — no room-owned block
    /// does, `StubBlock::output` (`scrollback/block.rs:407-423`) leaves the
    /// field at its `None` default and `RoomStepsBlock` follows it — so a click
    /// on it falls through to block-level handling and folds. That is exactly
    /// the split grok's design note describes at grok-ref
    /// `scrollback/text_selection.rs:415-419`, reached here through data rather
    /// than through a special case.
    ///
    /// Reported rather than hidden: it means the folded summary's text cannot be
    /// dragged out with the mouse. `searchable_text` and `copy_text` carry it,
    /// and making room rows selectable is a wave of its own.
    #[test]
    fn a_click_on_selectable_text_is_consumed_before_the_fold() {
        let (mut room, feed) = room_with_a_painted_feed();
        let steps = steps_row(&room, feed);

        assert!(
            (0..feed.width).all(|col| room
                .last_scrollback_selection_model
                .hit_test_text_exact(col, steps)
                .is_none()),
            "no column of the folded steps row is selectable text"
        );
        let (text_row, text_col) = (feed.y..feed.y + feed.height)
            .flat_map(|row| (0..feed.width).map(move |col| (row, col)))
            .find(|(row, col)| {
                room.last_scrollback_selection_model
                    .hit_test_text_exact(*col, *row)
                    .is_some()
            })
            .expect("the answer body IS selectable, so the guard has data to hit");
        assert_ne!(text_row, steps);

        room.prompt.handle_paste("an unfinished thought");
        let draft = room.prompt.text().to_owned();

        let start = std::time::Instant::now();
        assert!(
            click(&mut room, text_col, text_row, start),
            "the feed consumed it"
        );
        let second = start + Duration::from_millis(10);
        assert!(click(&mut room, text_col, text_row, second));

        assert_eq!(
            room.scrollback.steps_display_mode("stream"),
            Some(DisplayMode::Collapsed),
            "a text click never folds anything, however many times it repeats"
        );
        assert_eq!(room.prompt.text(), draft, "and never edits the composer");

        // The folded row, clicked twice, DOES fold — so the assertion above is
        // about the text hit and not about the gesture being broken.
        let third = second + Duration::from_millis(500);
        assert!(click(&mut room, 0, steps, third));
        let fourth = third + Duration::from_millis(10);
        assert!(click(&mut room, 0, steps, fourth));
        assert_eq!(
            room.scrollback.steps_display_mode("stream"),
            Some(DisplayMode::Expanded)
        );
        assert_eq!(room.prompt.text(), draft, "still no composer edit");
    }

    /// Outside the feed rect the arm declines, so the composer still owns every
    /// mouse event it owned before slice C.
    #[test]
    fn a_click_outside_the_feed_is_not_the_feeds_to_take() {
        let (mut room, feed) = room_with_a_painted_feed();
        let below = feed.y + feed.height + 2;
        assert!(!room.handle_feed_mouse_at(
            &mouse(MouseEventKind::Down(MouseButton::Left), 4, below),
            std::time::Instant::now()
        ));
        assert!(!room.handle_feed_mouse_at(
            &mouse(MouseEventKind::Up(MouseButton::Left), 4, below),
            std::time::Instant::now()
        ));
        assert!(!room.handle_feed_mouse_at(
            &mouse(MouseEventKind::Moved, 4, 4),
            std::time::Instant::now()
        ));
    }

    /// A frame with no area to paint clears the model rather than leaving the
    /// previous frame's rows behind.
    ///
    /// A model kept from an older frame hit-tests against a layout that no
    /// longer exists, which is worse than having none — the click would land on
    /// whatever used to be there. The observable is `visible_blocks`, not
    /// `ranges`: the room paints no selectable text yet (see the finding on
    /// `a_click_on_selectable_text_is_consumed_before_the_fold`), but it does
    /// paint blocks, and `visible_blocks` is what the geometry half of the model
    /// is made of.
    #[test]
    fn a_zero_area_frame_clears_the_previous_selection_model() {
        let (mut room, _feed) = room_with_a_painted_feed();
        assert!(
            !room
                .last_scrollback_selection_model
                .visible_blocks
                .is_empty(),
            "a painted frame produces a model describing what it painted"
        );
        assert!(
            !room.last_scrollback_selection_model.ranges.is_empty(),
            "and the answer body's selectable ranges are in it"
        );

        let empty = Rect::new(0, 0, 0, 0);
        let mut buffer = Buffer::empty(Rect::new(0, 0, 1, 1));
        room.last_scrollback_selection_model = room.scrollback.render(empty, &mut buffer);
        assert_eq!(
            room.last_scrollback_selection_model,
            crate::scrollback::ResolvedSelectionModel::default(),
            "a zero-area frame leaves nothing behind to hit"
        );
    }

    #[test]
    fn room_reuses_prompt_file_paste_and_history_pipelines() {
        let mut room = RoomView::new();

        type_into_prompt(&mut room, "@Cargo");
        assert!(room.prompt.file_search.context().is_some());

        room.prompt.handle_paste("first line\nsecond line");
        assert!(room.prompt.text().contains("first line\nsecond line"));

        room.remember_submission("inspect the current room state");
        room.prompt
            .history_search
            .activate_browse(&room.history, "");
        assert!(room.prompt.history_search.is_active());
        assert!(room.prompt.history_search.is_browse());
    }
}
