#![allow(dead_code)]

use serde_json::{Value, json};
use zer0_room_protocol::{RoomEvent, RoomReducer};

pub const SESSION_ID: &str = "room-1";
pub const TURN_ID: &str = "turn-1";

pub fn event(
    sequence: &str,
    event_id: &str,
    turn_id: &str,
    kind: &str,
    payload: Value,
) -> RoomEvent {
    RoomEvent::from_value(json!({
        "protocol": "zer0.room",
        "version": 1,
        "sessionId": SESSION_ID,
        "eventSeq": sequence,
        "eventId": event_id,
        "turnId": turn_id,
        "occurredAt": "2026-08-01T12:00:00Z",
        "type": kind,
        "payload": payload,
    }))
    .expect("valid room event fixture")
}

pub fn transition_event(
    sequence: &str,
    event_id: &str,
    turn_id: &str,
    kind: &str,
    payload: Value,
) -> RoomEvent {
    let sequence = sequence
        .parse::<u64>()
        .expect("test sequence is a u64")
        .checked_add(2)
        .expect("test sequence does not overflow");
    event(&sequence.to_string(), event_id, turn_id, kind, payload)
}

pub fn primed(agents: &[&str]) -> RoomReducer {
    let mut reducer = RoomReducer::new();
    reducer
        .apply(&event(
            "1",
            "turn-accepted",
            TURN_ID,
            "turn.accepted",
            json!({"agents":agents,"text":"operator","messageId":"operator-message","ledgerSeq":"1"}),
        ))
        .unwrap();
    reducer
        .apply(&event(
            "2",
            "route-resolved",
            TURN_ID,
            "route.resolved",
            json!({"agents":agents}),
        ))
        .unwrap();
    reducer
}

pub fn queued(
    sequence: &str,
    event_id: &str,
    lane: &str,
    agent: &str,
    message_id: &str,
) -> RoomEvent {
    transition_event(
        sequence,
        event_id,
        TURN_ID,
        "lane.queued",
        json!({
            "laneId": lane,
            "agent": agent,
            "expectedMessageId": message_id,
            "origin": "operator",
            "hopIndex": 0,
        }),
    )
}

pub fn started(sequence: &str, event_id: &str, lane: &str, stream: &str, agent: &str) -> RoomEvent {
    transition_event(
        sequence,
        event_id,
        TURN_ID,
        "lane.started",
        json!({"laneId": lane, "streamId": stream, "agent": agent}),
    )
}

pub fn chunk(
    sequence: &str,
    event_id: &str,
    lane: &str,
    stream: &str,
    agent: &str,
    stream_seq: &str,
    chunk_index: u64,
    text: &str,
) -> RoomEvent {
    transition_event(
        sequence,
        event_id,
        TURN_ID,
        "lane.chunk",
        json!({
            "laneId": lane,
            "streamId": stream,
            "agent": agent,
            "streamSeq": stream_seq,
            "chunkIndex": chunk_index,
            "channel": "assistant",
            "text": text,
        }),
    )
}

pub fn commit(
    sequence: &str,
    event_id: &str,
    lane: &str,
    agent: &str,
    message_id: &str,
    text: &str,
) -> RoomEvent {
    transition_event(
        sequence,
        event_id,
        TURN_ID,
        "message.committed",
        json!({
            "laneId": lane,
            "agent": agent,
            "messageId": message_id,
            "ledgerSeq": sequence,
            "text": text,
            "origin": "operator",
            "hopIndex": 0,
        }),
    )
}

pub fn terminal(
    sequence: &str,
    event_id: &str,
    kind: &str,
    lane: &str,
    stream: Option<&str>,
    agent: &str,
) -> RoomEvent {
    let mut payload = json!({"laneId": lane, "agent": agent});
    if let Some(stream) = stream {
        payload["streamId"] = json!(stream);
    }
    transition_event(sequence, event_id, TURN_ID, kind, payload)
}
