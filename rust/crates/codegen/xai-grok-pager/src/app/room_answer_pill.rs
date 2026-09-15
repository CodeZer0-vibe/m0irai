//! Slice D's unseen-answer pill: membership, and the text it renders as.
//!
//! Its own file for the reason `room_runtime_events.rs` and
//! `room_usage_meters.rs` beside it have one: `room_runtime.rs` carries no
//! Rust clamp gate (FL-135), and the standing rule is that growth is paid for
//! by extraction and never by accretion. What stays in `room_runtime.rs` is
//! the WIRING — the one reconciliation point inside the frame, the guidance
//! rung, the key and mouse arms — because those are seams that file owns.
//! What lives here is everything that can be decided from values alone.
//!
//! # Membership, in two halves (spec §D.6)
//!
//! [`record_committed_answer`] appends, unconditionally, when an answer
//! becomes final. No scroll state and no geometry is read at commit time,
//! because there is none to read: the layout cache is invalidated by the
//! commit itself, by C's fold and by D's relocation, and is rebuilt only
//! inside `prepare_layout` during render.
//!
//! [`reconcile_unseen_answers`] drops entries every frame, at exactly one
//! point in `render_room`: after the feed has rendered (which is what makes
//! the layout cache valid for this frame's width and this frame's rect) and
//! before the guidance row is built. That ordering — fold, relocate, lay out,
//! reconcile, then paint the row — is the order `render_room` already runs
//! in, so the pill needs no pipeline of its own.
//!
//! There is deliberately NO drain-on-activation path. `Ctrl+T` and the click
//! both make the target's first row visible; the same frame's reconciliation
//! removes it. A second writer to this list is what the single reconciliation
//! point exists to prevent.

use unicode_width::UnicodeWidthStr;
use zer0_room_protocol::RoomEvent;

use ratatui::layout::Rect;

use crate::room_scrollback::RoomSpeaker;
use crate::room_theme::{RoomSecondaryGlyph, room_secondary};
use crate::room_view::{RoomView, UnseenAnswer};

/// The tail that tells the operator what to do about the pill. Attached only
/// after a FULL form and only when the whole line fits; never truncated, and
/// never attached to one of the shortened rungs, which have no room to be
/// honest about two keys.
pub(super) const PILL_SUFFIX: &str = " · ctrl+t to jump · end for latest";

/// Record one just-committed answer as unread (spec §D.6's append half).
///
/// Called from `apply_room_event_at` — the run loop's own arm — and from the
/// test helper that drives the same arm, for the reason written across
/// `room_runtime_events.rs`: a helper that REPRODUCES an arm is a second copy
/// of it, and the copy is where the truth goes missing.
///
/// Deduplicated by `message_id`. Ordered by arrival, which is commit order,
/// which is what "oldest first" means for a person who looked away.
/// Takes only the room, and reads `room.reducer` itself: passing the reducer
/// beside a `&mut RoomView` does not borrow-check, and threading a clone
/// through would be a second copy of the state the arm just updated.
pub(super) fn record_committed_answer(room: &mut RoomView, event: &RoomEvent) {
    if event.kind != "message.committed" {
        return;
    }
    let Some(message_id) = event.payload["messageId"].as_str() else {
        return;
    };
    if room
        .unseen_answers
        .iter()
        .any(|unseen| unseen.message_id == message_id)
    {
        return;
    }
    // The agent is read from the event rather than looked up by lane, because
    // the event is the record of what committed; a lane lookup would answer
    // for the lane's CURRENT state, which a later event can change.
    let agent = event.payload["agent"]
        .as_str()
        .map(RoomSpeaker::from_agent)
        .unwrap_or(RoomSpeaker::Operator);
    if agent == RoomSpeaker::Operator {
        // Not an agent answer. The operator's own messages are never unread.
        return;
    }
    // Asserted rather than assumed: an answer with no transcript entry behind
    // it has nothing for the pill to point at, and appending it would leave a
    // permanent entry that reconciliation drops on the first frame anyway.
    let known = room
        .reducer
        .transcript()
        .any(|entry| entry.message_id == message_id);
    if !known {
        return;
    }
    room.unseen_answers.push(UnseenAnswer {
        message_id: message_id.to_owned(),
        agent,
        commit_event_seq: event.event_seq.clone(),
    });
}

/// Drop every answer the operator has now seen, and every one the feed no
/// longer holds (spec §D.6's reconcile half).
///
/// `feed` must be the rect the scrollback was just rendered against on THIS
/// frame. Calling it anywhere else reads an invalid layout cache and would
/// clear the pill for answers nobody has looked at.
pub(super) fn reconcile_unseen_answers(room: &mut RoomView, feed: Rect) {
    // Taken out first: the obvious `room.unseen_answers.retain(|u| …
    // room.scrollback …)` borrows `room` mutably and immutably at once. Not
    // solved by cloning the scrollback or by moving the list onto it — this is
    // view state and it has to survive the snapshot that replaces the
    // scrollback (§D.9).
    let mut unseen = std::mem::take(&mut room.unseen_answers);
    unseen.retain(|answer| {
        match room
            .scrollback
            .answer_first_row_visible(&answer.message_id, feed)
        {
            // Its first row is on screen: read.
            Some(true) => false,
            // Off screen, or top-clipped: still owed.
            Some(false) => true,
            // Not in the feed at all — a snapshot that did not carry it, or a
            // prune. Nothing to point at.
            None => false,
        }
    });
    room.unseen_answers = unseen;
}

/// The distinct agents named by the unseen set, in first-commit order.
///
/// Distinct AGENTS, not answers (§0.7 R4): an agent that commits twice while
/// unseen appears once, and the three-or-more form counts agents.
fn distinct_agents(unseen: &[UnseenAnswer]) -> Vec<RoomSpeaker> {
    let mut agents = Vec::new();
    for answer in unseen {
        if !agents.contains(&answer.agent) {
            agents.push(answer.agent);
        }
    }
    agents
}

/// The pill's full text for this frame, or `None` when nothing paints.
///
/// `width` is the guidance row's own width — `W − 2·outer_pad` — and the
/// ladder takes the FIRST form that fits (spec §D.8). Every rung is true;
/// none is a truncation, and nothing is ever clipped. Below the width of the
/// shortest rung the row is empty: absent renders absent.
///
/// | agents | ladder |
/// | --- | --- |
/// | 1 | `↑ claude answered` → `↑ claude` → `↑ 1` → nothing |
/// | 2 | `↑ claude and codex answered` → `↑ 2 answered` → `↑ 2` → nothing |
/// | 3+ | `↑ N agents answered` → `↑ N answered` → `↑ N` → nothing |
///
/// The suffix attaches only to a full form, and only when the whole line
/// including it fits.
pub(super) fn answer_pill_text(unseen: &[UnseenAnswer], width: u16) -> Option<String> {
    let agents = distinct_agents(unseen);
    let arrow = room_secondary(RoomSecondaryGlyph::UpArrow);
    let count = agents.len();
    let rungs: Vec<String> = match count {
        0 => return None,
        1 => vec![
            format!("{arrow} {} answered", agents[0].label()),
            format!("{arrow} {}", agents[0].label()),
            format!("{arrow} 1"),
        ],
        2 => vec![
            format!(
                "{arrow} {} and {} answered",
                agents[0].label(),
                agents[1].label()
            ),
            format!("{arrow} 2 answered"),
            format!("{arrow} 2"),
        ],
        _ => vec![
            format!("{arrow} {count} agents answered"),
            format!("{arrow} {count} answered"),
            format!("{arrow} {count}"),
        ],
    };
    let budget = usize::from(width);
    let mut chosen = None;
    for (rung, form) in rungs.iter().enumerate() {
        if UnicodeWidthStr::width(form.as_str()) <= budget {
            chosen = Some((rung, form.clone()));
            break;
        }
    }
    let (rung, form) = chosen?;
    // The suffix rides only the full form, and only if the WHOLE line fits.
    if rung == 0 {
        let with_suffix = format!("{form}{PILL_SUFFIX}");
        if UnicodeWidthStr::width(with_suffix.as_str()) <= budget {
            return Some(with_suffix);
        }
    }
    Some(form)
}
