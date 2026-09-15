//! The body of the room run loop's two host-update arms.
//!
//! Its own file for the reason `room_usage_meters.rs` beside it has one:
//! `room_runtime.rs` is 4,857 lines with no Rust clamp gate (FL-135), three
//! lanes are editing it at once this wave, and the brief this answers is
//! explicit that growth is paid for by extraction and never by accretion.
//!
//! # Why these are functions at all
//!
//! They used to be the select-arm bodies themselves, and that is exactly how
//! FL-126 shipped a fix the app never ran. The arm reconciled after EVERY
//! event; the tests reconciled at moments each case picked. Both were "the
//! same" right up until the first event after a submit destroyed the stash,
//! which no test could see because no test drove the arm. A helper that
//! *reproduces* an arm is a second copy of it, and the copy is where the truth
//! goes missing. These ARE the arms: the select branches are one call each,
//! and the cancel tests call the same two functions.

use std::time::Instant;

use anyhow::Context;
use zer0_room_protocol::{RoomEvent, RoomReducer};

use tokio::sync::mpsc;

use crate::room_prompt_restore::SubmissionId;

use super::{
    RoomCommand, RoomView, reconcile_health_reset_at, reconcile_quit_arm_at, reconcile_spent_lanes,
};

/// Everything the room does with one `RoomUpdate::Event`, in one place.
///
/// Extracted from the `run_loop` select arm so that a test can drive the
/// EXACT sequence the running app performs — and it had to be, because the
/// first FL-126 attempt shipped a fix that every test passed and the app
/// never ran: the tests called the reconcile at moments the case chose, the
/// run loop called it after every single event, and the very first event
/// after a submit destroyed the stash. A helper that "does what the arm does"
/// is a second copy of the arm, and the copy is where the truth goes missing.
/// This is the arm.
pub(super) fn apply_room_event_at(
    room: &mut RoomView,
    event: &RoomEvent,
    now: Instant,
    now_ms: u64,
) -> anyhow::Result<()> {
    let duplicate = room.reducer.has_event_id(&event.event_id);
    let delta = room
        .reducer
        .apply(event)
        .context("room host emitted an invalid event")?;
    if !duplicate {
        room.scrollback.apply_event(event, &room.reducer, delta);
        room.permissions.sync(&room.reducer, &mut room.prompt);
        // Slice D §D.6's append half, inside the `!duplicate` guard for the
        // same reason the two calls above are: a replayed event id must not
        // add a second unread entry for an answer that already landed. The
        // list is deduplicated by message id as well, so this is belt AND
        // braces on a list the operator sees.
        super::room_answer_pill::record_committed_answer(room, event);
    }
    // The lanes may have just reached idle, which is the arm's third clear.
    // Done here rather than left to the next key so the field cannot be read
    // as armed by anything between now and then.
    reconcile_quit_arm_at(room, now);
    // An availability may have just changed, and the footer's `out of usage`
    // memory is derived from it. Same reasoning as the arm above: derived here,
    // not at paint time, so nothing can read a stale word in between.
    reconcile_spent_lanes(room);
    // DELTA ITEM 5 — ARM THE HEALTH-RESET DEADLINE WHERE THE STATE IS PAINTED, not only where it is
    // polled. The idle poll can only report an expiry it was already holding a deadline for, and it
    // arms itself from states that are STILL painted — so a reset landing between an availability
    // event and the next 132 ms tick was invisible to it forever: unarmed when the tick ran, and by
    // then already filtered out as past. The repaint never happened and the red row stayed up until
    // the operator typed. Arming here closes that window because this is the moment the room first
    // learns the instant exists.
    //
    // The returned `crossed` is deliberately dropped: this arm redraws unconditionally, so an expiry
    // it consumes on the way past is already being painted.
    let _ = reconcile_health_reset_at(room, now_ms);
    // FL-126. NOTHING here binds an entry to a turn any more. Binding happens
    // on the submit's own response ([`apply_submit_settled`]), by id. Reading
    // `turn.accepted` and claiming the oldest unbound entry was the round-2
    // defect: it assumes every accepted turn has an entry waiting, and both
    // `/council` and a host-rejected submit break that.
    let outcome = room
        .pending_cancel_restore
        .settle(&room.reducer, &mut room.prompt);
    for notice in outcome.notices() {
        room.scrollback.push_local_notice(notice);
    }
    Ok(())
}

/// The host answered one submit: bind the prompt it was holding to that turn,
/// or drop it because there will never be one.
///
/// Settles immediately afterwards, and that is load-bearing rather than tidy.
/// This update and the room's events reach the run loop on one channel from two
/// different tasks, so a turn can be cancelled AND completed before its own
/// response arrives. An entry with no turn id is skipped by every settle pass
/// in between; without this call the prompt would sit in the queue with its
/// turn already over and nothing left to trigger it.
pub(super) fn apply_submit_settled(
    room: &mut RoomView,
    submission: SubmissionId,
    turn: Option<&str>,
) {
    let Some(turn_id) = turn else {
        // The host refused it, or answered without naming a turn. Either way no
        // turn will ever settle this entry, and leaving it unbound is what let
        // the NEXT accepted turn claim it and hand back this text on a cancel.
        room.pending_cancel_restore.drop_submission(submission);
        return;
    };
    room.pending_cancel_restore
        .bind_submission(submission, turn_id);
    let outcome = room
        .pending_cancel_restore
        .settle(&room.reducer, &mut room.prompt);
    for notice in outcome.notices() {
        room.scrollback.push_local_notice(notice);
    }
}

/// Everything the room does with one `RoomUpdate::Snapshot`. Same reason as
/// [`apply_room_event_at`]: one body, driven by the app and by its tests.
///
/// Nothing in this tree constructs `RoomUpdate::Snapshot` today — the arm is
/// here for the `session/load` that will.
pub(super) fn apply_room_snapshot_at(room: &mut RoomView, snapshot: RoomReducer, now: Instant) {
    room.reducer = snapshot;
    room.scrollback = crate::room_scrollback::RoomScrollback::from_reducer_with_motion(
        &room.reducer,
        room.reduced_motion,
    );
    room.permissions.sync(&room.reducer, &mut room.prompt);
    // A snapshot replaces the whole reducer, so it can retire the lanes the
    // arm was about just as an event can.
    reconcile_quit_arm_at(room, now);
    // ...and it can equally retire, or introduce, a spent lane.
    reconcile_spent_lanes(room);
    // The turn ids the pending restores are bound to belong to the reducer
    // that was just thrown away. See `PendingRestores::invalidate`.
    room.pending_cancel_restore.invalidate();
}

/// Send one submission to the host, holding its prompt against a cancel.
///
/// **The only place `RoomCommand::Submit` is constructed**, and that is the
/// round-3 fix rather than tidiness. There used to be two: this one, which
/// queued a restore entry, and `parse_room_command`'s `/council` arm, which did
/// not — so a council turn's `turn.accepted` claimed a different submission's
/// held prompt. Minting the id and queueing the entry are one call
/// (`PendingRestores::submitted`), so a submit that skips the queue cannot be
/// written: there is no id to put in the command.
///
/// `remember_submission` first, unconditionally, because every notice this
/// mechanism can print points at `/history` for recovery.
pub(super) async fn send_submission(
    room: &mut RoomView,
    text: &str,
    stash: crate::views::prompt_widget::StashedPrompt,
    commands: &mpsc::Sender<RoomCommand>,
) -> anyhow::Result<()> {
    room.remember_submission(text);
    // Queued behind any earlier submission, never on top of it: two outstanding
    // submissions are two turns, and one slot hands back whichever settled last
    // instead of the one that was cancelled (FL-126).
    let (submission, overflow) = room.pending_cancel_restore.submitted(stash);
    for notice in overflow.notices() {
        room.scrollback.push_local_notice(notice);
    }
    commands
        .send(RoomCommand::Submit {
            submission,
            text: room.addressed_submission(text),
        })
        .await
        .context("room host command bridge stopped")
}
