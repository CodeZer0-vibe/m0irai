mod support;

use serde_json::json;
use zer0_room_protocol::{HopDisposition, LaneOrigin};

use support::{TURN_ID, commit, primed, queued, transition_event};

fn dispatch(
    sequence: &str,
    event_id: &str,
    from: &str,
    to: &str,
    parent_message_id: &str,
    hop_index: u64,
    hop_budget: u64,
    hop_id: &str,
) -> zer0_room_protocol::RoomEvent {
    transition_event(
        sequence,
        event_id,
        TURN_ID,
        "hop.dispatched",
        json!({"fromAgent":from,"toAgent":to,"parentMessageId":parent_message_id,"hopIndex":hop_index,"maxHop":hop_budget,"hopId":hop_id,"text":"review this"}),
    )
}

fn blocked(
    sequence: &str,
    event_id: &str,
    from: &str,
    to: &str,
    parent_message_id: &str,
    hop_index: u64,
    hop_budget: u64,
    hop_id: &str,
) -> zer0_room_protocol::RoomEvent {
    transition_event(
        sequence,
        event_id,
        TURN_ID,
        "hop.blocked",
        json!({"fromAgent":from,"toAgent":to,"parentMessageId":parent_message_id,"hopIndex":hop_index,"maxHop":hop_budget,"hopId":hop_id,"text":"review again"}),
    )
}

fn agent_queue(
    sequence: &str,
    event_id: &str,
    lane: &str,
    agent: &str,
    expected_message_id: &str,
    parent_message_id: &str,
    from_agent: &str,
    hop_index: u64,
    hop_id: &str,
) -> zer0_room_protocol::RoomEvent {
    transition_event(
        sequence,
        event_id,
        TURN_ID,
        "lane.queued",
        json!({
            "laneId":lane,
            "agent":agent,
            "expectedMessageId":expected_message_id,
            "origin":"agent",
            "hopIndex":hop_index,
            "replyTo":parent_message_id,
            "fromAgent":from_agent,
            "parentMessageId":parent_message_id,
            "hopId":hop_id,
        }),
    )
}

fn agent_commit(
    sequence: &str,
    event_id: &str,
    lane: &str,
    message_id: &str,
    reply_to: Option<&str>,
) -> zer0_room_protocol::RoomEvent {
    let mut payload = json!({
        "laneId":lane,
        "agent":"codex",
        "messageId":message_id,
        "ledgerSeq":sequence,
        "text":"agent result",
        "origin":"agent",
        "hopIndex":1,
    });
    if let Some(reply_to) = reply_to {
        payload["replyTo"] = json!(reply_to);
    }
    transition_event(sequence, event_id, TURN_ID, "message.committed", payload)
}

#[test]
fn operator_commit_dispatches_exact_agent_hop_provenance_and_duplicate_replays() {
    let mut reducer = primed(&["claude"]);
    reducer
        .apply(&queued(
            "1",
            "parent-q",
            "parent-lane",
            "claude",
            "parent-message",
        ))
        .unwrap();
    reducer
        .apply(&commit(
            "2",
            "parent-commit",
            "parent-lane",
            "claude",
            "parent-message",
            "parent",
        ))
        .unwrap();
    let dispatched = dispatch(
        "3",
        "hop-1",
        "claude",
        "codex",
        "parent-message",
        1,
        1,
        "hop-1",
    );
    reducer.apply(&dispatched).unwrap();
    reducer
        .apply(&agent_queue(
            "4",
            "child-q",
            "child-lane",
            "codex",
            "child-message",
            "parent-message",
            "claude",
            1,
            "hop-1",
        ))
        .unwrap();
    let lane = reducer.lane("child-lane").unwrap();
    assert_eq!(lane.origin, LaneOrigin::Agent);
    assert_eq!(lane.hop_index, 1);
    assert_eq!(lane.reply_to.as_deref(), Some("parent-message"));
    assert_eq!(lane.from_agent.as_deref(), Some("claude"));
    assert_eq!(lane.parent_message_id.as_deref(), Some("parent-message"));
    assert_eq!(lane.hop_id.as_deref(), Some("hop-1"));
    assert_eq!(
        reducer
            .ordered_hops()
            .map(|hop| hop.hop_id.as_str())
            .collect::<Vec<_>>(),
        ["hop-1"]
    );
    assert_eq!(
        reducer.hop("hop-1").unwrap().disposition,
        HopDisposition::Dispatched
    );
    assert_eq!(
        reducer.hop("hop-1").unwrap().text.as_deref(),
        Some("review this")
    );
    assert_eq!(
        reducer.apply(&dispatched),
        Ok(zer0_room_protocol::ApplyDelta::None)
    );
    assert_eq!(reducer.ordered_hops().count(), 1);
}

#[test]
fn second_agent_hop_is_blocked_without_authorizing_a_lane() {
    let mut reducer = primed(&["claude"]);
    reducer
        .apply(&queued(
            "1",
            "parent-q",
            "parent",
            "claude",
            "parent-message",
        ))
        .unwrap();
    reducer
        .apply(&commit(
            "2",
            "parent-c",
            "parent",
            "claude",
            "parent-message",
            "parent",
        ))
        .unwrap();
    reducer
        .apply(&dispatch(
            "3",
            "h1",
            "claude",
            "codex",
            "parent-message",
            1,
            1,
            "h1",
        ))
        .unwrap();
    reducer
        .apply(&agent_queue(
            "4",
            "child-q",
            "child",
            "codex",
            "child-message",
            "parent-message",
            "claude",
            1,
            "h1",
        ))
        .unwrap();
    reducer
        .apply(&agent_commit(
            "5",
            "child-c",
            "child",
            "child-message",
            Some("parent-message"),
        ))
        .unwrap();
    reducer
        .apply(&blocked(
            "6",
            "h2",
            "codex",
            "gemini",
            "child-message",
            2,
            1,
            "h2",
        ))
        .unwrap();
    assert_eq!(
        reducer.hop("h2").unwrap().disposition,
        HopDisposition::Blocked
    );
    assert!(
        reducer
            .apply(&agent_queue(
                "7",
                "blocked-q",
                "blocked",
                "gemini",
                "blocked-message",
                "child-message",
                "codex",
                2,
                "h2"
            ))
            .is_err()
    );
    assert!(reducer.lane("blocked").is_none());
}

#[test]
fn hops_and_commits_reject_bad_parent_budget_provenance_and_reply_without_consuming_sequence() {
    let mut reducer = primed(&["claude"]);
    reducer
        .apply(&queued("1", "q", "parent", "claude", "parent-message"))
        .unwrap();
    assert!(reducer.apply(&transition_event("2", "bad-origin", TURN_ID, "message.committed", json!({"laneId":"parent","agent":"claude","messageId":"parent-message","text":"parent","ledgerSeq":"2","origin":"agent","hopIndex":0}))).is_err());
    assert_eq!(reducer.last_event_seq(), "3");
    reducer
        .apply(&commit(
            "2",
            "parent-commit",
            "parent",
            "claude",
            "parent-message",
            "parent",
        ))
        .unwrap();
    assert!(
        reducer
            .apply(&dispatch(
                "3",
                "missing-parent",
                "claude",
                "codex",
                "missing",
                1,
                1,
                "missing-hop"
            ))
            .is_err()
    );
    assert!(
        reducer
            .apply(&dispatch(
                "3",
                "wrong-parent",
                "codex",
                "gemini",
                "parent-message",
                1,
                1,
                "bad"
            ))
            .is_err()
    );
    assert!(reducer.apply(&transition_event("3", "wrong-turn", "turn-other", "hop.dispatched", json!({"fromAgent":"claude","toAgent":"codex","parentMessageId":"parent-message","hopIndex":1,"maxHop":1,"hopId":"bad-turn"}))).is_err());
    assert!(
        zer0_room_protocol::RoomEvent::from_value(json!({
            "protocol":"zer0.room", "version":1, "sessionId":"room-1", "eventSeq":"5",
            "eventId":"bad-budget", "turnId":TURN_ID, "occurredAt":"2026-08-01T12:00:00Z",
            "type":"hop.dispatched", "payload":{"fromAgent":"claude","toAgent":"codex",
            "parentMessageId":"parent-message","hopIndex":1,"maxHop":0,"hopId":"bad"}
        }))
        .is_err()
    );
    assert!(
        reducer
            .apply(&dispatch(
                "3",
                "bad-index",
                "claude",
                "codex",
                "parent-message",
                2,
                2,
                "bad-index"
            ))
            .is_err()
    );
    reducer
        .apply(&dispatch(
            "3",
            "good-hop",
            "claude",
            "codex",
            "parent-message",
            1,
            1,
            "good-hop",
        ))
        .unwrap();
    assert!(
        reducer
            .apply(&dispatch(
                "4",
                "duplicate-hop",
                "claude",
                "gemini",
                "parent-message",
                1,
                1,
                "good-hop"
            ))
            .is_err()
    );
    assert!(reducer.apply(&transition_event("4", "operator-extra", TURN_ID, "lane.queued", json!({"laneId":"bad-operator","agent":"codex","expectedMessageId":"bad-message","origin":"operator","hopIndex":0,"replyTo":"parent-message"}))).is_err());
    assert!(
        reducer
            .apply(&agent_queue(
                "4",
                "mismatch-hop",
                "child",
                "codex",
                "child-message",
                "parent-message",
                "claude",
                1,
                "other-hop"
            ))
            .is_err()
    );
    assert!(reducer
        .apply(&transition_event(
            "4",
            "mismatch-reply",
            TURN_ID,
            "lane.queued",
            json!({"laneId":"child","agent":"codex","expectedMessageId":"child-message","origin":"agent","hopIndex":1,"replyTo":"other","fromAgent":"claude","parentMessageId":"parent-message","hopId":"good-hop"}),
        ))
        .is_err());
    reducer
        .apply(&agent_queue(
            "4",
            "child-q",
            "child",
            "codex",
            "child-message",
            "parent-message",
            "claude",
            1,
            "good-hop",
        ))
        .unwrap();
    assert!(reducer.apply(&transition_event("5", "bad-hop-index", TURN_ID, "message.committed", json!({"laneId":"child","agent":"codex","messageId":"child-message","text":"agent result","ledgerSeq":"5","origin":"agent","hopIndex":2}))).is_err());
    assert!(
        reducer
            .apply(&agent_commit(
                "5",
                "bad-reply",
                "child",
                "child-message",
                Some("other")
            ))
            .is_err()
    );
    assert!(
        reducer
            .apply(&agent_commit(
                "5",
                "missing-reply",
                "child",
                "child-message",
                None
            ))
            .is_err()
    );
    reducer
        .apply(&agent_commit(
            "5",
            "child-c",
            "child",
            "child-message",
            Some("parent-message"),
        ))
        .unwrap();
}
