use serde_json::json;
use zer0_room_protocol::{LaneOrigin, LanePhase, RoomEvent, RoomReducer, TranscriptAuthor};

const SESSION: &str = "room-view";
const TURN: &str = "turn-view";

fn event(sequence: &str, id: &str, kind: &str, payload: serde_json::Value) -> RoomEvent {
    RoomEvent::from_value(json!({
        "protocol":"zer0.room", "version":1, "sessionId":SESSION,
        "eventSeq":sequence, "eventId":id, "turnId":TURN,
        "occurredAt":"2026-08-01T12:00:00Z", "type":kind, "payload":payload,
    }))
    .unwrap()
}

fn accepted(sequence: &str, id: &str, agents: &[&str]) -> RoomEvent {
    event(
        sequence,
        id,
        "turn.accepted",
        json!({
            "agents":agents,"text":"operator text","messageId":"operator-1","ledgerSeq":"41"
        }),
    )
}

fn route(sequence: &str, id: &str, agents: &[&str]) -> RoomEvent {
    event(sequence, id, "route.resolved", json!({"agents":agents}))
}

fn queued(sequence: &str, id: &str, lane: &str, agent: &str, message: &str) -> RoomEvent {
    event(
        sequence,
        id,
        "lane.queued",
        json!({
            "laneId":lane,"agent":agent,"expectedMessageId":message,"origin":"operator","hopIndex":0
        }),
    )
}

fn started(sequence: &str, id: &str, lane: &str, stream: &str, agent: &str) -> RoomEvent {
    event(
        sequence,
        id,
        "lane.started",
        json!({"laneId":lane,"streamId":stream,"agent":agent}),
    )
}

fn committed(sequence: &str, id: &str, lane: &str, agent: &str, message: &str) -> RoomEvent {
    event(
        sequence,
        id,
        "message.committed",
        json!({
            "laneId":lane,"agent":agent,"messageId":message,"ledgerSeq":sequence,"text":format!("{agent} text"),"origin":"operator","hopIndex":0
        }),
    )
}

fn terminal(
    sequence: &str,
    id: &str,
    kind: &str,
    lane: &str,
    stream: &str,
    agent: &str,
) -> RoomEvent {
    event(
        sequence,
        id,
        kind,
        json!({"laneId":lane,"streamId":stream,"agent":agent}),
    )
}

#[test]
fn operator_queue_accepts_the_host_parent_identity_and_rejects_a_mismatch() {
    let mut reducer = RoomReducer::new();
    reducer
        .apply(&accepted("1", "accepted", &["claude"]))
        .unwrap();
    reducer.apply(&route("2", "route", &["claude"])).unwrap();
    reducer
        .apply(&event(
            "3",
            "queued",
            "lane.queued",
            json!({
                "laneId":"lane-claude",
                "agent":"claude",
                "expectedMessageId":"claude-message",
                "origin":"operator",
                "hopIndex":0,
                "parentMessageId":"operator-1",
                "text":"operator text",
                "paused":false,
                "busy":false
            }),
        ))
        .unwrap();
    assert_eq!(
        reducer
            .lane("lane-claude")
            .and_then(|lane| lane.parent_message_id.as_deref()),
        Some("operator-1")
    );

    let mut mismatch = RoomReducer::new();
    mismatch
        .apply(&accepted("1", "accepted", &["claude"]))
        .unwrap();
    mismatch.apply(&route("2", "route", &["claude"])).unwrap();
    assert!(
        mismatch
            .apply(&event(
                "3",
                "queued-mismatch",
                "lane.queued",
                json!({
                    "laneId":"lane-claude",
                    "agent":"claude",
                    "expectedMessageId":"claude-message",
                    "origin":"operator",
                    "hopIndex":0,
                    "parentMessageId":"some-other-message"
                }),
            ))
            .is_err()
    );
}

#[test]
fn accepted_route_lanes_transcript_and_nonvacuous_completion_are_chronological() {
    let mut reducer = RoomReducer::new();
    for event in [
        accepted("1", "accepted", &["claude", "codex", "gemini"]),
        route("2", "route", &["claude", "codex", "gemini"]),
        queued("3", "q-c", "c", "claude", "claude-message"),
        queued("4", "q-o", "o", "codex", "codex-message"),
        queued("5", "q-g", "g", "gemini", "gemini-message"),
        started("6", "s-o", "o", "stream-o", "codex"),
        started("7", "s-c", "c", "stream-c", "claude"),
        started("8", "s-g", "g", "stream-g", "gemini"),
        committed("9", "m-o", "o", "codex", "codex-message"),
        terminal("10", "done-o", "lane.completed", "o", "stream-o", "codex"),
        committed("11", "m-c", "c", "claude", "claude-message"),
        terminal("12", "done-c", "lane.completed", "c", "stream-c", "claude"),
        event(
            "13",
            "failed-g",
            "lane.failed",
            json!({"laneId":"g","streamId":"stream-g","agent":"gemini","error":"provider failed"}),
        ),
        event("14", "complete", "turn.completed", json!({})),
    ] {
        reducer.apply(&event).unwrap();
    }
    assert_eq!(
        reducer
            .ordered_streams()
            .map(|stream| stream.id.as_str())
            .collect::<Vec<_>>(),
        ["stream-o", "stream-c", "stream-g"]
    );
    assert_eq!(
        reducer
            .ordered_lanes()
            .map(|lane| lane.id.as_str())
            .collect::<Vec<_>>(),
        ["c", "o", "g"]
    );
    let turn = reducer.turn(TURN).unwrap();
    assert_eq!(turn.agents, ["claude", "codex", "gemini"]);
    assert_eq!(turn.route.as_ref().unwrap().agents, turn.agents);
    assert!(turn.completed_at.is_some());
    let transcript = reducer.transcript().collect::<Vec<_>>();
    assert_eq!(
        transcript
            .iter()
            .map(|entry| entry.message_id.as_str())
            .collect::<Vec<_>>(),
        ["operator-1", "codex-message", "claude-message"]
    );
    assert_eq!(transcript[0].author, TranscriptAuthor::Operator);
    assert_eq!(transcript[0].target_agents, ["claude", "codex", "gemini"]);
    assert_eq!(transcript[1].event_seq, "9");
    assert_eq!(transcript[2].event_seq, "11");
    assert_eq!(
        reducer.lane("g").unwrap().failure_reason.as_deref(),
        Some("provider failed")
    );
}

#[test]
fn route_and_completion_failures_are_atomic_and_retryable() {
    let mut reducer = RoomReducer::new();
    reducer
        .apply(&accepted("1", "accepted", &["claude"]))
        .unwrap();
    assert!(
        reducer
            .apply(&accepted("2", "duplicate-accepted", &["claude"]))
            .is_err()
    );
    assert_eq!(reducer.last_event_seq(), "1");
    assert!(reducer.apply(&route("2", "bad-route", &["codex"])).is_err());
    assert_eq!(reducer.last_event_seq(), "1");
    assert_eq!(reducer.transcript().count(), 1);
    reducer.apply(&route("2", "route", &["claude"])).unwrap();
    assert!(
        reducer
            .apply(&event("3", "early-empty", "turn.completed", json!({})))
            .is_err()
    );
    assert_eq!(reducer.last_event_seq(), "2");
    reducer
        .apply(&queued("3", "q", "lane", "claude", "message"))
        .unwrap();
    reducer
        .apply(&started("4", "s", "lane", "stream", "claude"))
        .unwrap();
    reducer
        .apply(&committed("5", "m", "lane", "claude", "message"))
        .unwrap();
    assert!(
        reducer
            .apply(&event("6", "early-committed", "turn.completed", json!({})))
            .is_err()
    );
    assert_eq!(reducer.last_event_seq(), "5");
    reducer
        .apply(&terminal(
            "6",
            "done",
            "lane.completed",
            "lane",
            "stream",
            "claude",
        ))
        .unwrap();
    reducer
        .apply(&event("7", "complete", "turn.completed", json!({})))
        .unwrap();
    assert!(
        reducer
            .apply(&event("8", "again", "turn.completed", json!({})))
            .is_err()
    );
    assert_eq!(reducer.last_event_seq(), "7");
}

#[test]
fn operator_lanes_require_a_route_target_and_exact_replay_does_not_duplicate_transcript() {
    let mut reducer = RoomReducer::new();
    let accepted_event = accepted("1", "accepted", &["claude"]);
    reducer.apply(&accepted_event).unwrap();
    assert!(
        reducer
            .apply(&queued(
                "2",
                "pre-route",
                "pre-route",
                "claude",
                "pre-route-message"
            ))
            .is_err()
    );
    assert_eq!(reducer.last_event_seq(), "1");

    reducer.apply(&route("2", "route", &["claude"])).unwrap();
    assert!(
        reducer
            .apply(&queued(
                "3",
                "wrong-target",
                "wrong-target",
                "codex",
                "wrong-message"
            ))
            .is_err()
    );
    assert_eq!(reducer.last_event_seq(), "2");
    reducer
        .apply(&queued("3", "queued", "lane", "claude", "message"))
        .unwrap();

    let before_replay = reducer.clone();
    assert_eq!(
        reducer.apply(&accepted_event).unwrap(),
        zer0_room_protocol::ApplyDelta::None
    );
    assert_eq!(reducer, before_replay);
    assert_eq!(reducer.transcript().count(), 1);
}

#[test]
fn fresh_reducer_replay_produces_the_same_final_room_view() {
    let events = vec![
        accepted("1", "accepted", &["claude"]),
        route("2", "route", &["claude"]),
        queued("3", "queued", "lane", "claude", "message"),
        started("4", "started", "lane", "stream", "claude"),
        event(
            "5",
            "chunk",
            "lane.chunk",
            json!({"laneId":"lane","streamId":"stream","agent":"claude","streamSeq":"1","chunkIndex":0,"channel":"assistant","text":"reply"}),
        ),
        committed("6", "committed", "lane", "claude", "message"),
        terminal(
            "7",
            "completed",
            "lane.completed",
            "lane",
            "stream",
            "claude",
        ),
        event("8", "turn-completed", "turn.completed", json!({})),
        event("9", "backend", "backend.failed", json!({})),
    ];
    let mut live = RoomReducer::new();
    let mut replayed = RoomReducer::new();
    for event in &events {
        live.apply(event).unwrap();
    }
    for event in events {
        replayed.apply(&event).unwrap();
    }

    assert_eq!(replayed, live);
    assert_eq!(replayed.ordered_turns().count(), 1);
    assert_eq!(replayed.transcript().count(), 2);
    assert_eq!(replayed.backend_failures().count(), 1);
}

#[test]
fn models_timestamps_backend_and_agent_hop_transcript_identity_are_retained() {
    let mut reducer = RoomReducer::new();
    for event in [
        accepted("1", "accepted", &["claude"]),
        route("2", "route", &["claude"]),
        queued("3", "q", "parent", "claude", "parent-message"),
        started("4", "s", "parent", "parent-stream", "claude"),
        event(
            "5",
            "chunk-model",
            "lane.chunk",
            json!({"laneId":"parent","streamId":"parent-stream","agent":"claude","streamSeq":"1","chunkIndex":0,"channel":"assistant","text":"draft","modelId":"model-a"}),
        ),
        committed("6", "m", "parent", "claude", "parent-message"),
        event(
            "7",
            "hop",
            "hop.dispatched",
            json!({"fromAgent":"claude","toAgent":"codex","parentMessageId":"parent-message","hopIndex":1,"hopBudget":1,"hopId":"hop-1"}),
        ),
        event(
            "8",
            "child-q",
            "lane.queued",
            json!({"laneId":"child","agent":"codex","expectedMessageId":"child-message","origin":"agent","hopIndex":1,"replyTo":"parent-message","fromAgent":"claude","parentMessageId":"parent-message","hopId":"hop-1"}),
        ),
        started("9", "child-s", "child", "child-stream", "codex"),
        event(
            "10",
            "child-m",
            "message.committed",
            json!({"laneId":"child","agent":"codex","messageId":"child-message","ledgerSeq":"10","text":"child text","origin":"agent","hopIndex":1,"replyTo":"parent-message"}),
        ),
        event(
            "11",
            "backend",
            "backend.failed",
            json!({"message":"backend unavailable","error":"timeout"}),
        ),
    ] {
        reducer.apply(&event).unwrap();
    }
    let stream = reducer.stream("parent-stream").unwrap();
    assert_eq!(stream.model_id.as_deref(), Some("model-a"));
    assert!(stream.started_at.ends_with('Z'));
    let lane = reducer.lane("parent").unwrap();
    assert!(lane.queued_at.ends_with('Z'));
    assert!(lane.started_at.is_some());
    assert_eq!(
        reducer.backend_failures().next().unwrap().error.as_deref(),
        Some("timeout")
    );
    let child = reducer.transcript().last().unwrap();
    assert_eq!(child.author, TranscriptAuthor::Agent("codex".into()));
    assert_eq!(child.reply_to.as_deref(), Some("parent-message"));
    assert_eq!(child.origin, LaneOrigin::Agent);
    assert!(reducer.apply(&event("12", "conflict-model", "lane.chunk", json!({"laneId":"parent","streamId":"parent-stream","agent":"claude","streamSeq":"2","chunkIndex":1,"channel":"assistant","text":"more","modelId":"model-b"}))).is_err());
    assert_eq!(reducer.last_event_seq(), "11");
    assert_eq!(
        reducer.stream("parent-stream").unwrap().model_id.as_deref(),
        Some("model-a")
    );
    assert_eq!(reducer.lane("parent").unwrap().phase, LanePhase::Committed);
}

#[test]
fn model_from_start_is_preserved_when_later_chunk_omits_it() {
    let mut reducer = RoomReducer::new();
    for event in [
        accepted("1", "accepted", &["claude"]),
        route("2", "route", &["claude"]),
        queued("3", "queued", "lane", "claude", "message"),
        event(
            "4",
            "started",
            "lane.started",
            json!({"laneId":"lane","streamId":"stream","agent":"claude","modelId":"model-a"}),
        ),
        event(
            "5",
            "chunk-without-model",
            "lane.chunk",
            json!({"laneId":"lane","streamId":"stream","agent":"claude","streamSeq":"1","chunkIndex":0,"channel":"assistant","text":"text"}),
        ),
    ] {
        reducer.apply(&event).unwrap();
    }

    assert_eq!(
        reducer.stream("stream").unwrap().model_id.as_deref(),
        Some("model-a")
    );
}
