mod support;

use serde_json::json;
use zer0_room_protocol::{LanePhase, RoomReducer};

use support::{event, primed, queued, started};

#[test]
fn default_matches_new_and_starts_at_zero() {
    let default_reducer = RoomReducer::default();
    let new_reducer = RoomReducer::new();
    assert_eq!(default_reducer.last_event_seq(), "0");
    assert_eq!(new_reducer.last_event_seq(), "0");
    assert_eq!(default_reducer.session_id(), None);
    assert_eq!(new_reducer.session_id(), None);
}

#[test]
fn failed_transition_does_not_consume_sequence_or_event_id_and_can_retry() {
    let mut reducer = primed(&["claude"]);
    reducer
        .apply(&queued("1", "queued", "lane-1", "claude", "message-1"))
        .expect("queue accepted");

    let rejected = started("2", "retry", "lane-1", "stream-1", "codex");
    assert!(reducer.apply(&rejected).is_err());
    assert_eq!(reducer.last_event_seq(), "3");
    assert!(!reducer.has_event_id("retry"));
    assert_eq!(
        reducer.lane("lane-1").expect("lane").phase,
        LanePhase::Queued
    );

    reducer
        .apply(&started("2", "retry", "lane-1", "stream-1", "claude"))
        .expect("same sequence and event id retry accepted after correction");
    assert_eq!(reducer.last_event_seq(), "4");
    assert!(reducer.has_event_id("retry"));
    assert_eq!(
        reducer.lane("lane-1").expect("lane").phase,
        LanePhase::Running
    );
}

#[test]
fn large_turn_history_preserves_constant_time_identity_lookup_and_order() {
    let mut reducer = RoomReducer::new();
    for sequence in 1..=20_000_u64 {
        let turn_id = format!("turn-{sequence}");
        reducer
            .apply(&event(
                &sequence.to_string(),
                &format!("event-{sequence}"),
                &turn_id,
                "turn.accepted",
                json!({
                    "agents": ["claude"],
                    "text": "operator",
                    "messageId": format!("message-{sequence}"),
                    "ledgerSeq": sequence.to_string()
                }),
            ))
            .expect("large valid turn history remains replayable");
    }

    assert_eq!(reducer.ordered_turns().count(), 20_000);
    assert_eq!(reducer.turn("turn-1").unwrap().ledger_seq, "1");
    assert_eq!(reducer.turn("turn-20000").unwrap().ledger_seq, "20000");
}

/// The invariant the room's bounded displacement scan rests on, pinned where it
/// lives rather than assumed at the call site.
///
/// `displacement_prompt` in the pager stops walking the transcript once it
/// reaches the committing answer's own sequence. That is sound only if the
/// transcript is ascending by `event_seq`, and it is — not by convention but by
/// refusal: `apply` demands `event_seq == increment_decimal(last_event_seq)` and
/// returns `EventGap` otherwise, so an entry pushed later cannot carry an
/// earlier sequence.
///
/// Both halves are asserted. The ordering itself, over a history long enough
/// that a decimal-vs-lexicographic mistake would show (row 9 to row 10 is
/// exactly where a string sort breaks), AND the refusal that guarantees it,
/// quoted from the error the reducer actually returns.
#[test]
fn the_transcript_is_ascending_by_event_seq_so_a_bounded_scan_is_sound() {
    let mut reducer = RoomReducer::new();
    for sequence in 1..=40_u64 {
        reducer
            .apply(&event(
                &sequence.to_string(),
                &format!("event-{sequence}"),
                &format!("turn-{sequence}"),
                "turn.accepted",
                json!({
                    "agents": ["claude"],
                    "text": "operator",
                    "messageId": format!("message-{sequence}"),
                    "ledgerSeq": sequence.to_string()
                }),
            ))
            .expect("a consecutive history is replayable");
    }

    let seqs: Vec<&str> = reducer
        .transcript()
        .map(|entry| entry.event_seq.as_str())
        .collect();
    assert_eq!(seqs.len(), 40, "every prompt reached the transcript");
    for pair in seqs.windows(2) {
        assert_eq!(
            zer0_room_protocol::decimal_cmp(pair[0], pair[1]),
            Ok(std::cmp::Ordering::Less),
            "transcript rows must ascend by event_seq: {pair:?}"
        );
    }

    // And WHY they ascend: the reducer refuses anything else. A gap forward is
    // rejected, so a row carrying a sequence out of order can never be pushed.
    let rejected = reducer.apply(&event(
        "99",
        "event-99",
        "turn-99",
        "turn.accepted",
        json!({"agents":["claude"],"text":"operator","messageId":"message-99","ledgerSeq":"99"}),
    ));
    assert!(
        rejected.is_err(),
        "the reducer must refuse a sequence that is not the next one"
    );
    assert_eq!(
        reducer.transcript().count(),
        40,
        "a refused event adds no transcript row"
    );
}
