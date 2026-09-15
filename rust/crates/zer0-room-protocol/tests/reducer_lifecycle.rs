mod support;

use zer0_room_protocol::LanePhase;

use serde_json::json;

use support::{TURN_ID, chunk, commit, primed, queued, started, terminal, transition_event};

#[test]
fn queued_cancellation_has_no_stream_and_message_id_must_match() {
    let mut reducer = primed(&["claude"]);
    reducer
        .apply(&queued("1", "q", "lane", "claude", "expected"))
        .unwrap();
    assert!(
        reducer
            .apply(&commit(
                "2",
                "wrong-agent",
                "lane",
                "codex",
                "expected",
                "wrong"
            ))
            .is_err()
    );
    assert!(
        reducer
            .apply(&commit("2", "bad", "lane", "claude", "other", "wrong"))
            .is_err()
    );
    assert_eq!(reducer.last_event_seq(), "3");
    reducer
        .apply(&terminal(
            "2",
            "cancel",
            "lane.cancelled",
            "lane",
            None,
            "claude",
        ))
        .unwrap();
    assert_eq!(reducer.lane("lane").unwrap().phase, LanePhase::Cancelled);
    assert!(reducer.stream("stream").is_none());
}

#[test]
fn queued_lane_can_fail_only_as_an_explicit_recovery_terminal() {
    let mut reducer = primed(&["claude"]);
    reducer
        .apply(&queued("1", "q", "lane", "claude", "expected"))
        .unwrap();

    let live_failure = transition_event(
        "2",
        "live-failure",
        TURN_ID,
        "lane.failed",
        json!({"laneId":"lane", "agent":"claude"}),
    );
    assert!(reducer.apply(&live_failure).is_err());
    reducer
        .apply(&transition_event(
            "2",
            "recovered-failure",
            TURN_ID,
            "lane.failed",
            json!({"laneId":"lane", "agent":"claude", "recovered":true}),
        ))
        .expect("durable failed row can reconcile a crash before lane.started was flushed");

    assert_eq!(reducer.lane("lane").unwrap().phase, LanePhase::Failed);
    assert!(reducer.lane("lane").unwrap().stream_id.is_none());
}

#[test]
fn start_chunk_commit_complete_replaces_provisional_text() {
    let mut reducer = primed(&["claude"]);
    for event in [
        queued("1", "q", "lane", "claude", "message"),
        started("2", "s", "lane", "stream", "claude"),
        chunk("3", "c", "lane", "stream", "claude", "1", 0, "draft"),
        commit("4", "m", "lane", "claude", "message", "canonical"),
    ] {
        reducer.apply(&event).expect("valid lifecycle transition");
    }
    assert!(
        reducer
            .apply(&chunk(
                "5",
                "after-commit",
                "lane",
                "stream",
                "claude",
                "2",
                1,
                "no"
            ))
            .is_err()
    );
    assert!(
        reducer
            .apply(&terminal(
                "5",
                "failed-commit",
                "lane.failed",
                "lane",
                Some("stream"),
                "claude"
            ))
            .is_err()
    );
    assert!(
        reducer
            .apply(&terminal(
                "5",
                "wrong-stream",
                "lane.completed",
                "lane",
                Some("other"),
                "claude"
            ))
            .is_err()
    );
    reducer
        .apply(&terminal(
            "5",
            "done",
            "lane.completed",
            "lane",
            Some("stream"),
            "claude",
        ))
        .expect("completed after commit");
    let lane = reducer.lane("lane").expect("lane");
    assert_eq!(lane.phase, LanePhase::Completed);
    assert_eq!(
        lane.message_commit.as_ref().expect("commit").text,
        "canonical"
    );
    assert_eq!(reducer.stream("stream").expect("stream").text, "canonical");
    assert!(
        reducer
            .apply(&terminal(
                "6",
                "again",
                "lane.completed",
                "lane",
                Some("stream"),
                "claude"
            ))
            .is_err()
    );
}

#[test]
fn queued_commit_repair_can_complete_without_a_stream_but_completion_before_commit_cannot() {
    let mut repair = primed(&["codex"]);
    repair
        .apply(&queued("1", "q", "lane", "codex", "message"))
        .unwrap();
    repair
        .apply(&commit("2", "m", "lane", "codex", "message", "repaired"))
        .unwrap();
    assert_eq!(repair.lane("lane").unwrap().phase, LanePhase::Committed);
    repair
        .apply(&terminal(
            "3",
            "done",
            "lane.completed",
            "lane",
            None,
            "codex",
        ))
        .unwrap();
    assert_eq!(repair.lane("lane").unwrap().phase, LanePhase::Completed);

    let mut incomplete = primed(&["codex"]);
    incomplete
        .apply(&queued("1", "q", "lane", "codex", "message"))
        .unwrap();
    incomplete
        .apply(&started("2", "s", "lane", "stream", "codex"))
        .unwrap();
    assert!(
        incomplete
            .apply(&terminal(
                "3",
                "early",
                "lane.completed",
                "lane",
                Some("stream"),
                "codex"
            ))
            .is_err()
    );
    incomplete
        .apply(&commit("3", "m", "lane", "codex", "message", "done"))
        .unwrap();
    incomplete
        .apply(&terminal(
            "4",
            "done",
            "lane.completed",
            "lane",
            Some("stream"),
            "codex",
        ))
        .unwrap();
}

#[test]
fn failed_and_cancelled_lanes_are_terminal_and_reject_follow_up_work() {
    let mut failed = primed(&["gemini"]);
    failed
        .apply(&queued("1", "q", "lane", "gemini", "message"))
        .unwrap();
    failed
        .apply(&started("2", "s", "lane", "stream", "gemini"))
        .unwrap();
    failed
        .apply(&terminal(
            "3",
            "f",
            "lane.failed",
            "lane",
            Some("stream"),
            "gemini",
        ))
        .unwrap();
    assert_eq!(failed.lane("lane").unwrap().phase, LanePhase::Failed);
    assert!(
        failed
            .apply(&chunk(
                "4",
                "after-failed",
                "lane",
                "stream",
                "gemini",
                "1",
                0,
                "no"
            ))
            .is_err()
    );

    let mut cancelled = primed(&["gemini"]);
    cancelled
        .apply(&queued("1", "q", "lane", "gemini", "message"))
        .unwrap();
    cancelled
        .apply(&started("2", "s", "lane", "stream", "gemini"))
        .unwrap();
    cancelled
        .apply(&terminal(
            "3",
            "x",
            "lane.cancelled",
            "lane",
            Some("stream"),
            "gemini",
        ))
        .unwrap();
    assert_eq!(cancelled.lane("lane").unwrap().phase, LanePhase::Cancelled);
    assert!(
        cancelled
            .apply(&commit(
                "4",
                "after-cancel",
                "lane",
                "gemini",
                "message",
                "no"
            ))
            .is_err()
    );

    let mut cancelling = primed(&["gemini"]);
    cancelling
        .apply(&queued("1", "q", "lane", "gemini", "message"))
        .unwrap();
    cancelling
        .apply(&started("2", "s", "lane", "stream", "gemini"))
        .unwrap();
    cancelling
        .apply(&terminal(
            "3",
            "c",
            "lane.cancelling",
            "lane",
            Some("stream"),
            "gemini",
        ))
        .unwrap();
    cancelling
        .apply(&terminal(
            "4",
            "x",
            "lane.cancelled",
            "lane",
            Some("stream"),
            "gemini",
        ))
        .unwrap();
    assert_eq!(cancelling.lane("lane").unwrap().phase, LanePhase::Cancelled);

    let mut cancelling_commit = primed(&["gemini"]);
    cancelling_commit
        .apply(&queued("1", "q", "lane", "gemini", "message"))
        .unwrap();
    cancelling_commit
        .apply(&started("2", "s", "lane", "stream", "gemini"))
        .unwrap();
    cancelling_commit
        .apply(&terminal(
            "3",
            "c",
            "lane.cancelling",
            "lane",
            Some("stream"),
            "gemini",
        ))
        .unwrap();
    cancelling_commit
        .apply(&commit("4", "m", "lane", "gemini", "message", "canonical"))
        .unwrap();
    assert_eq!(
        cancelling_commit.lane("lane").unwrap().phase,
        LanePhase::Committed
    );
}
