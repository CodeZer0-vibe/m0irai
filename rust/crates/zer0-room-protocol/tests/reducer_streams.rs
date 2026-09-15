mod support;

use serde_json::json;
use zer0_room_protocol::{ApplyDelta, LanePhase};

use support::{SESSION_ID, TURN_ID, chunk, event, primed, queued, started};

#[test]
fn start_order_is_stable_while_interleaved_chunks_accumulate_per_stream() {
    let mut reducer = primed(&["claude", "codex", "gemini"]);
    for event in [
        queued("1", "q-c", "lane-c", "claude", "message-c"),
        queued("2", "q-o", "lane-o", "codex", "message-o"),
        queued("3", "q-g", "lane-g", "gemini", "message-g"),
        started("4", "s-c", "lane-c", "stream-c", "claude"),
        started("5", "s-o", "lane-o", "stream-o", "codex"),
        started("6", "s-g", "lane-g", "stream-g", "gemini"),
    ] {
        reducer.apply(&event).expect("setup transition accepted");
    }
    for event in [
        chunk("7", "g-1", "lane-g", "stream-g", "gemini", "1", 0, "G1"),
        chunk("8", "o-1", "lane-o", "stream-o", "codex", "1", 0, "O1"),
        chunk("9", "c-1", "lane-c", "stream-c", "claude", "1", 0, "C1"),
        chunk("10", "g-2", "lane-g", "stream-g", "gemini", "2", 1, "G2"),
        chunk("11", "o-2", "lane-o", "stream-o", "codex", "2", 1, "O2"),
        chunk("12", "c-2", "lane-c", "stream-c", "claude", "2", 1, "C2"),
    ] {
        assert!(matches!(
            reducer.apply(&event),
            Ok(ApplyDelta::Changed { .. })
        ));
    }

    assert_eq!(
        reducer
            .ordered_streams()
            .map(|stream| stream.id.as_str())
            .collect::<Vec<_>>(),
        ["stream-c", "stream-o", "stream-g"]
    );
    for (stream_id, text) in [
        ("stream-c", "C1C2"),
        ("stream-o", "O1O2"),
        ("stream-g", "G1G2"),
    ] {
        let stream = reducer.stream(stream_id).expect("stream exists");
        assert_eq!(stream.text, text);
        assert_eq!(stream.next_chunk_index, 2);
        assert_eq!(stream.next_stream_seq, "3");
    }
}

#[test]
fn duplicate_starts_chunk_before_start_and_identity_or_cursor_mismatches_are_atomic() {
    let mut reducer = primed(&["claude"]);
    reducer
        .apply(&queued("1", "q", "lane", "claude", "message"))
        .unwrap();
    assert!(
        reducer
            .apply(&chunk(
                "2", "before", "lane", "stream", "claude", "1", 0, "x"
            ))
            .is_err()
    );
    reducer
        .apply(&started("2", "s", "lane", "stream", "claude"))
        .unwrap();
    assert_eq!(
        reducer.apply(&started("3", "again", "lane", "stream", "claude")),
        Err(zer0_room_protocol::ProtocolError::InvalidEvent(
            "lane.started requires a queued lane".into()
        ))
    );

    let invalid = [
        chunk("3", "wrong-lane", "other", "stream", "claude", "1", 0, "x"),
        chunk("3", "wrong-agent", "lane", "stream", "codex", "1", 0, "x"),
        chunk("3", "wrong-stream", "lane", "other", "claude", "1", 0, "x"),
        chunk("3", "wrong-seq", "lane", "stream", "claude", "2", 0, "x"),
        chunk("3", "wrong-index", "lane", "stream", "claude", "1", 1, "x"),
        event(
            "3",
            "wrong-turn",
            "turn-other",
            "lane.chunk",
            json!({"laneId":"lane","streamId":"stream","agent":"claude","streamSeq":"1","chunkIndex":0,"channel":"assistant","text":"x"}),
        ),
    ];
    for event in invalid {
        let before = reducer.clone();
        assert!(reducer.apply(&event).is_err(), "{}", event.event_id);
        assert_eq!(
            reducer, before,
            "{} mutated state before rejecting",
            event.event_id
        );
        assert_eq!(reducer.last_event_seq(), "4");
        assert!(!reducer.has_event_id(&event.event_id));
        assert_eq!(
            reducer.lane("lane").expect("lane").phase,
            LanePhase::Running
        );
    }
    reducer
        .apply(&chunk("3", "good", "lane", "stream", "claude", "1", 0, "x"))
        .unwrap();
}

/// The invariant the room's `finish_lane` relies on after RP round 2 deleted
/// its unstreamed-steps arm: **a lane cannot have recorded activity without a
/// started stream.**
///
/// That arm existed to draw a lane whose steps reached the screen with no
/// stream binding behind them. Measured unreachable by the whole pager suite
/// once a failed lane's stream began replaying, and an unreachable render arm
/// that would draw a wrong row is a defect with a timer on it, so it was
/// deleted. What replaces it is this: the reducer REFUSES to produce the shape.
///
/// Three refusals, because the arm needed all three to be closed: the lane must
/// be Running or Cancelling (a queued lane has no stream yet), the id must
/// match the lane's own stream, and `streamId` is required — that last one is
/// refused a layer EARLIER than the other two, by `RoomEvent::from_value`,
/// which is why it is asserted against the envelope rather than the reducer.
#[test]
fn a_lane_cannot_record_activity_without_a_started_stream() {
    let activity = |sequence: &str, event_id: &str, payload: serde_json::Value| {
        event(sequence, event_id, TURN_ID, "lane.activity", payload)
    };

    // 1. A QUEUED lane has no stream, and the reducer says so.
    let mut reducer = primed(&["claude"]);
    reducer
        .apply(&queued("1", "q-c", "lane-c", "claude", "message-c"))
        .expect("queue the lane");
    let queued_error = reducer
        .apply(&activity(
            "4",
            "a-1",
            json!({"laneId":"lane-c","streamId":"stream-c","agent":"claude",
                   "toolCallId":"tool-1","update":"tool_call","title":"step","status":"in_progress"}),
        ))
        .expect_err("a queued lane must refuse activity");
    assert!(
        queued_error
            .to_string()
            .contains("requires a running or cancelling lane"),
        "{queued_error}"
    );
    assert!(
        reducer.lane("lane-c").expect("lane").activity.is_empty(),
        "a refused activity event records nothing"
    );

    // 2. Once started, activity for a DIFFERENT stream is refused.
    reducer
        .apply(&started("2", "s-c", "lane-c", "stream-c", "claude"))
        .expect("start the lane");
    let mismatch = reducer
        .apply(&activity(
            "5",
            "a-2",
            json!({"laneId":"lane-c","streamId":"stream-other","agent":"claude",
                   "toolCallId":"tool-1","update":"tool_call","title":"step","status":"in_progress"}),
        ))
        .expect_err("a foreign stream id must be refused");
    assert!(
        mismatch
            .to_string()
            .contains("streamId does not match lane"),
        "{mismatch}"
    );

    // 3. `streamId` is not optional, and the refusal is EARLIER than the
    //    reducer: an activity payload without one is not a well-formed room
    //    event at all, so `from_value` rejects it before `apply` is reachable.
    let malformed = zer0_room_protocol::RoomEvent::from_value(json!({
        "protocol": "zer0.room",
        "version": 1,
        "sessionId": SESSION_ID,
        "eventSeq": "5",
        "eventId": "a-3",
        "turnId": TURN_ID,
        "occurredAt": "2026-08-01T12:00:00Z",
        "type": "lane.activity",
        "payload": {"laneId":"lane-c","agent":"claude","toolCallId":"tool-1",
                    "update":"tool_call","title":"step","status":"in_progress"},
    }));
    assert!(
        malformed.is_err(),
        "activity without a streamId is not even a valid room event"
    );

    // The positive control: the matching stream IS accepted, so the three
    // refusals above are about the shape and not about the fixture being wrong.
    reducer
        .apply(&activity(
            "5",
            "a-4",
            json!({"laneId":"lane-c","streamId":"stream-c","agent":"claude",
                   "toolCallId":"tool-1","update":"tool_call","title":"step","status":"in_progress"}),
        ))
        .expect("the lane's own stream is accepted");
    let lane = reducer.lane("lane-c").expect("lane");
    assert_eq!(lane.activity.len(), 1);
    assert_eq!(lane.stream_id.as_deref(), Some("stream-c"));
    assert_eq!(lane.phase, LanePhase::Running);
}
