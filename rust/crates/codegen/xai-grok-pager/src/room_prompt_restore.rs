//! FL-126 — the composer gets a cancelled turn's text back, and only that turn's.
//!
//! Its own file rather than more of `room_runtime.rs`: that file is 4,857 lines
//! with no Rust clamp gate (FL-135), three lanes edit it at once this wave, and
//! the first attempt at this behaviour grew it by 74 lines and still shipped a
//! defect that no test could see. Same reasoning, and the same crate-root
//! mount, as `room_ctrl_c_gesture.rs`.
//!
//! # What this owns
//!
//! One queue of prompts that have left the composer but might have to come
//! back. An entry is created by a submission, **bound** to the host turn that
//! submission became, and settled when the host says that turn is over.
//!
//! # Why a turn id and not "the room looks idle"
//!
//! The first attempt asked `lane_busy(&reducer, None)` — no lane is `Running`
//! or `Cancelling` — and read that as "this submission has settled". It is not.
//! Between Enter and the first `lane.started` the room has either no lanes at
//! all (`turn.accepted`) or lanes in `LanePhase::Queued`, which `lane_busy`
//! does not count, so the very first event after a submit made the room look
//! idle and threw the stash away before any lane could be cancelled. Nothing
//! was ever restored in the running app. The same room-wide read made
//! `any_cancelled` sticky for the whole session, because the reducer never
//! removes a lane: one cancel in turn 1 handed every later ANSWERED turn's text
//! back, which is the opposite of the operator's ruling.
//!
//! # Why an id and not "the next `turn.accepted`"
//!
//! ⚠ **This is the round-3 fix and it is the whole reason [`SubmissionId`]
//! exists.** The second attempt bound an entry to the next accepted turn *by
//! position among unbound entries*. That is only correct if every submission
//! queues an entry and every submission becomes a turn, and neither holds:
//!
//! - `/council <topic>` is the one slash command the host accepts as a submit
//!   (`src/room/room-host-support.ts`, `parseRoomInput`'s `slashCommand !==
//!   "council"` throw), so it mints a turn — but it left the pager through a
//!   different arm that queued no entry, so its `turn.accepted` claimed
//!   somebody else's stash. Two harms from one cause: the operator's own
//!   cancelled turn handed back nothing, and cancelling the council handed back
//!   an unrelated prompt whose turn was still running.
//! - A submit the host REJECTS (`src/room/room-host.ts`: empty text, no
//!   dispatch route, the Slice A readiness refusal, oversized text, journal
//!   capacity) emits no `turn.accepted` at all, so its entry stranded and the
//!   next accepted turn bound to it. The readiness refusal is the live one —
//!   `@gemini …` on a machine without the Antigravity CLI hits it every time.
//!
//! Both are the same unanswered question: *what binds a `turn.accepted` to an
//! entry when some submits queue no entry?* Position cannot answer it. So the
//! pager now mints its own id for every submission, the id rides the
//! `zer0/room/submit` RPC's own request/response pair, and the entry is bound
//! (or dropped) by **that id**, on the response, never by arrival order. The
//! two-tasks-on-one-mpsc hazard that ruled out `CancelReachedHost` does not
//! apply: nothing here is ordered against anything, only looked up.
//!
//! # The settle signal
//!
//! [`RoomReducer::turn`]'s `completed_at`, and nothing else. That field is set
//! by the host's own `turn.completed` event, which the reducer refuses unless
//! the route resolved, every routed agent has exactly one root lane, and every
//! lane of the turn is terminal (`crates/zer0-room-protocol/src/reducer.rs`,
//! `complete_turn` — the three `invalid(...)` guards). Deriving that same
//! condition here from `ordered_lanes()` would be a second copy of a rule the
//! reducer already enforces, and two predicates meaning one thing is exactly
//! the drift that `reconcile_quit_arm_at`'s doc comment exists to warn about.
//! It also sees the `Queued → Cancelled` transition (FL-141's "cancelled before
//! it ever started") for free, because the reducer counts that lane as terminal
//! while `lane_busy` never sees it at all.
//!
//! The host emits `turn.completed` for a cancelled turn on the same path as a
//! completed one: every enqueued lane increments `pendingByTurn`
//! (`src/room/room-engine.ts` `enqueue`) and every lane leaves through exactly
//! one `settleTurn` call — the run's `finally`, `cancelQueuedLane`, or the
//! restart-recovery failure sweep — which emits `turn.completed` when the count
//! reaches zero. **One exception, and it is known:** `stopAdmission()` clears
//! `pendingByTurn` outright without emitting, so a turn accepted before it runs
//! never settles and its entry is held until [`MAX_PENDING_RESTORES`] evicts it
//! with a row. Read from source, not observed against a live host; see the
//! handback's residual risk.

use std::collections::VecDeque;

use zer0_room_protocol::{LanePhase, RoomReducer};

use crate::views::prompt_widget::{PromptWidget, StashedPrompt};

/// How many un-settled submissions the queue will hold.
///
/// A bound, not a design point: eight prompts outstanding at once is already
/// pathological (each one costs a separate Enter), and a [`StashedPrompt`] can
/// own pasted image bytes, so an unbounded queue against a host that stopped
/// emitting `turn.completed` would grow without limit. Overflow is surfaced,
/// never silent — see [`PendingRestores::submitted`].
const MAX_PENDING_RESTORES: usize = 8;

/// The pager's own id for one submission, minted before the RPC leaves.
///
/// Deliberately the pager's and not the host's: the host's turn id does not
/// exist until the submit has been persisted and accepted, and the entry has to
/// be identifiable from the moment the composer is cleared. Rides out on
/// `RoomCommand::Submit` and comes back on `RoomUpdate::SubmitSettled`, so the
/// answer is matched to its question by id rather than by arrival order.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, PartialOrd, Ord)]
pub struct SubmissionId(u64);

impl SubmissionId {
    /// For the bridge's own diagnostics and for tests. Not a handle to
    /// anything: an id whose entry has been dropped resolves to nothing.
    pub fn raw(self) -> u64 {
        self.0
    }

    /// A synthetic id, for tests that need a submit command without a room
    /// behind it.
    ///
    /// ⚠ **Compiled out of every production build, and that is the point.**
    /// The mechanism claims a submit with no held prompt is not constructible,
    /// because minting an id and queueing the prompt are one call
    /// ([`PendingRestores::submitted`]). A second, unrestricted constructor
    /// made that claim a convention rather than a property — `#[doc(hidden)]`
    /// hides a function from rustdoc, it does not stop anyone calling it, and
    /// a comment saying "never call this" is exactly the kind of guarantee
    /// this lane has already been caught leaning on. The cfg is the guarantee.
    ///
    /// `test` covers this crate's own tests; `room-test-support` is how the
    /// sibling crate's bridge tests reach it (`zer0-v2-bin` enables it as a
    /// dev-dependency feature), so no shipping build has this symbol at all.
    #[cfg(any(test, feature = "room-test-support"))]
    pub fn synthetic(raw: u64) -> Self {
        Self(raw)
    }
}

/// One submitted prompt held in reserve in case its turn is cancelled.
#[derive(Debug)]
struct PendingRestore {
    id: SubmissionId,
    stash: StashedPrompt,
    /// The host's id for the turn this submission became.
    ///
    /// `None` until the `zer0/room/submit` response comes back naming it. An
    /// unbound entry is inert: [`PendingRestores::settle`] skips it, so a turn
    /// whose events arrive before its own response is simply resolved when the
    /// response lands.
    turn_id: Option<String>,
}

/// What a settle pass did, so the caller can tell the operator about a prompt
/// they might have expected back.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct RestoreOutcome {
    /// A cancelled turn's text reached the composer.
    pub restored: bool,
    /// Cancelled turns whose text settled with nowhere to go, because the
    /// composer already held something. Their text is still in the room's
    /// submission history; their pasted images, if any, are not.
    pub refused: usize,
    /// Submissions pushed out of the queue by [`MAX_PENDING_RESTORES`] before
    /// their turn ever settled. Reaching this means turns are not completing.
    pub evicted: usize,
    /// Turns that settled with a lane that FAILED and none cancelled.
    ///
    /// Its own count and not folded into "answered", because the operator got
    /// no answer AND no text back. See [`RestoreOutcome::notices`].
    pub failed: usize,
}

impl RestoreOutcome {
    /// The rows the operator sees, in the order they should be pushed.
    ///
    /// Deliberately silent for the ordinary outcomes. A turn that answered owes
    /// nothing and says nothing; a restore that lands is its own signal, in the
    /// composer. Only a prompt that could NOT be handed back earns a row,
    /// because that is the case where the operator loses something and has no
    /// other way to notice.
    ///
    /// A `Vec` rather than one `Option<String>`: the counts are independent,
    /// and an earlier version asserted a mutual exclusion between two of them
    /// that held only by accident of which method set which field.
    pub fn notices(&self) -> Vec<String> {
        let mut rows = Vec::new();
        if self.evicted > 0 {
            rows.push(format!(
                "{} older submitted prompt(s) can no longer be restored: too many turns are still \
                 unfinished. Find them with /history.",
                self.evicted
            ));
        }
        match self.refused {
            0 => {}
            1 => rows.push(
                "A cancelled prompt was not restored because the composer already has text. Find \
                 it with /history."
                    .to_owned(),
            ),
            count => rows.push(format!(
                "{count} cancelled prompts were not restored because the composer already has \
                 text. Find them with /history."
            )),
        }
        if self.failed > 0 {
            rows.push(
                "That turn failed instead of answering. Your prompt was not put back in the \
                 composer; find it with /history."
                    .to_owned(),
            );
        }
        rows
    }
}

/// The prompts this room might still owe the composer, oldest submission first.
#[derive(Debug, Default)]
pub struct PendingRestores {
    entries: VecDeque<PendingRestore>,
    next_id: u64,
}

impl PendingRestores {
    /// How many submissions are still waiting on their turn to settle.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// A submission just cleared the composer; hold what it cleared, and mint
    /// the id that will claim it back.
    ///
    /// Minting and queueing are one call on purpose: an id with no entry is the
    /// `/council` defect and an entry with no id is unbindable, so neither is
    /// constructible. `RoomCommand::Submit` cannot be built without the id this
    /// returns, which is what makes "every submit the host can accept has an
    /// entry" a property of the type rather than of a comment.
    ///
    /// Appends rather than overwriting. A single slot meant two outstanding
    /// submissions handed back the ANSWERED turn's text instead of the
    /// cancelled one — the wrong text rather than no text, which is the failure
    /// a user cannot detect.
    pub fn submitted(&mut self, stash: StashedPrompt) -> (SubmissionId, RestoreOutcome) {
        let id = SubmissionId(self.next_id);
        self.next_id = self.next_id.wrapping_add(1);
        self.entries.push_back(PendingRestore {
            id,
            stash,
            turn_id: None,
        });
        let mut outcome = RestoreOutcome::default();
        while self.entries.len() > MAX_PENDING_RESTORES {
            self.entries.pop_front();
            outcome.evicted += 1;
        }
        (id, outcome)
    }

    /// The host answered submission `id`: it became `turn_id`.
    ///
    /// By id, never by position. Returns whether an entry was found, so a
    /// caller can tell an answer to a live question from an answer to one this
    /// room has already dropped (a snapshot, or an eviction).
    pub fn bind_submission(&mut self, id: SubmissionId, turn_id: &str) -> bool {
        let Some(entry) = self.entries.iter_mut().find(|entry| entry.id == id) else {
            return false;
        };
        entry.turn_id = Some(turn_id.to_owned());
        true
    }

    /// The host refused submission `id`, or answered it without naming a turn.
    ///
    /// The entry is dropped rather than left unbound. Leaving it is what made a
    /// rejected `@gemini …` hand its own text back on the NEXT turn's cancel.
    /// No row from here: the bridge has already surfaced the rejection itself,
    /// and a second line about a prompt that never reached the room is noise.
    pub fn drop_submission(&mut self, id: SubmissionId) -> bool {
        let Some(index) = self.entries.iter().position(|entry| entry.id == id) else {
            return false;
        };
        self.entries.remove(index);
        true
    }

    /// Resolve every entry whose turn the host has finished with.
    ///
    /// Scans the whole queue, not just the front: a later turn can settle
    /// before an earlier one, and the entry that settled is the one that has an
    /// answer. At most one restore per pass, because there is one composer.
    pub fn settle(&mut self, reducer: &RoomReducer, prompt: &mut PromptWidget) -> RestoreOutcome {
        let mut outcome = RestoreOutcome::default();
        let mut kept = VecDeque::with_capacity(self.entries.len());
        while let Some(entry) = self.entries.pop_front() {
            let Some(turn_id) = entry.turn_id.as_deref() else {
                kept.push_back(entry);
                continue;
            };
            if !turn_settled(reducer, turn_id) {
                kept.push_back(entry);
                continue;
            }
            if !turn_was_cancelled(reducer, turn_id) {
                // The operator's ruling: "If we just call a model, and it
                // answers, and we didn't get to cancel — that's it." Dropped
                // here rather than held, so it cannot surface on some later,
                // unrelated cancel.
                //
                // A turn whose lane FAILED is not that case: no answer arrived
                // and no cancel was asked for, and the ruling does not reach
                // it. Un-ruled, so it is reported rather than decided in
                // silence — the text is in `/history` either way.
                if turn_lane_failed(reducer, turn_id) {
                    outcome.failed += 1;
                }
                continue;
            }
            // The draft always wins. Overwriting live typing with an older
            // submission destroys work the operator cannot get back, which is
            // strictly worse than the bug this fixes. Upstream's collision
            // pattern (`app/queue_edit.rs`, stash the draft and hand it back on
            // exit) is not available here: it depends on a mode the operator
            // leaves, and a cancel has no such exit to hand anything back at.
            // So the refusal is reported instead of hidden.
            //
            // ⚠ The `outcome.restored` term is DEFENSIVE and, as the code
            // stands, unreachable: binding happens one id at a time and every
            // bind is followed by its own settle, so two entries cannot become
            // settled inside one pass. It is kept because this loop's contract
            // is "one composer, one restore" and that must not depend on a
            // caller's cadence. Only the draft term is covered by a test.
            if outcome.restored || !prompt.text().trim().is_empty() {
                outcome.refused += 1;
                continue;
            }
            prompt.restore(entry.stash);
            outcome.restored = true;
        }
        self.entries = kept;
        outcome
    }

    /// A wholesale reducer replacement invalidated everything held here.
    ///
    /// Turn ids are per session and start at `turn-1` every time
    /// (`src/room/room-host.ts`, `turn-${turn}`), so an entry bound to
    /// `turn-3` in this session would silently match a DIFFERENT `turn-3` in a
    /// loaded one and hand back text from a turn it never named. Nothing
    /// constructs `RoomUpdate::Snapshot` in the tree today; this exists so the
    /// first sender does not inherit that collision.
    pub fn invalidate(&mut self) {
        self.entries.clear();
    }
}

/// Whether the host has declared this turn over.
fn turn_settled(reducer: &RoomReducer, turn_id: &str) -> bool {
    reducer
        .turn(turn_id)
        .is_some_and(|turn| turn.completed_at.is_some())
}

/// Whether any lane OF THIS TURN reached `Cancelled`.
///
/// Scoped by `turn_id` and that scope is the P0-2 fix: the reducer never
/// removes a lane, so a room-wide `any(...)` stays true for the rest of the
/// session once anything is cancelled.
fn turn_was_cancelled(reducer: &RoomReducer, turn_id: &str) -> bool {
    reducer
        .ordered_lanes()
        .any(|lane| lane.turn_id == turn_id && lane.phase == LanePhase::Cancelled)
}

/// Whether any lane OF THIS TURN reached `Failed`.
fn turn_lane_failed(reducer: &RoomReducer, turn_id: &str) -> bool {
    reducer
        .ordered_lanes()
        .any(|lane| lane.turn_id == turn_id && lane.phase == LanePhase::Failed)
}
