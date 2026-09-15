use serde_json::{Number, Value, json};
use zer0_room_protocol::{
    JsonRpcError, JsonRpcId, JsonRpcRequest, JsonRpcResponse, JsonRpcResponseId, JsonRpcVersion,
    RoomEvent, RoomEventNotification, RoomEventNotificationMethod, ServerFrame,
    decode_server_frame,
};

fn event_value() -> Value {
    json!({
        "protocol": "zer0.room",
        "version": 1,
        "sessionId": "session-1",
        "eventSeq": "1",
        "eventId": "event-1",
        "turnId": "turn-1",
        "occurredAt": "2026-08-01T12:00:00Z",
        "type": "lane.started",
        "payload": {"laneId": "lane-1", "streamId": "stream-1", "agent": "codex"}
    })
}

fn event() -> RoomEvent {
    RoomEvent::from_value(event_value()).expect("valid shared room event fixture")
}

#[test]
fn request_and_notification_serialize_to_exact_jsonrpc_envelopes() {
    let request = JsonRpcRequest {
        jsonrpc: JsonRpcVersion,
        id: JsonRpcId::String("request-1".into()),
        method: "zer0/room/resync".into(),
        params: json!({"afterEventSeq": "7"}),
    };
    assert_eq!(
        serde_json::to_string(&request).expect("request serializes"),
        r#"{"jsonrpc":"2.0","id":"request-1","method":"zer0/room/resync","params":{"afterEventSeq":"7"}}"#
    );

    let notification = RoomEventNotification::new(event());
    assert_eq!(
        serde_json::to_string(&notification).expect("notification serializes"),
        format!(
            r#"{{"jsonrpc":"2.0","method":"zer0/room/event","params":{}}}"#,
            serde_json::to_string(&event()).expect("event serializes")
        )
    );
    assert_eq!(notification.method, RoomEventNotificationMethod);
}

#[test]
fn ids_preserve_string_numeric_and_explicit_null_response_ids() {
    let numeric_id = JsonRpcId::Number(Number::from(u64::MAX));
    assert!(serde_json::to_string(&numeric_id).is_err());
    assert_eq!(
        serde_json::from_str::<JsonRpcId>("\"string-id\"").expect("string id"),
        JsonRpcId::String("string-id".into())
    );
    assert!(serde_json::from_str::<JsonRpcId>("null").is_err());
    assert!(serde_json::from_str::<JsonRpcId>("true").is_err());
    assert!(
        serde_json::from_str::<JsonRpcRequest>(
            r#"{"jsonrpc":"2.0","id":"request-1","method":"test","params":null}"#
        )
        .is_err()
    );

    let response: JsonRpcResponse =
        serde_json::from_str(r#"{"jsonrpc":"2.0","id":null,"result":null}"#)
            .expect("explicit null response id and result are valid");
    assert_eq!(
        response,
        JsonRpcResponse::Success {
            jsonrpc: JsonRpcVersion,
            id: JsonRpcResponseId::Null,
            result: Value::Null,
        }
    );

    let large_numeric_response =
        decode_server_frame(br#"{"jsonrpc":"2.0","id":9007199254740991,"result":{}}"#)
            .expect("max safe integer response id remains numeric");
    assert_eq!(
        large_numeric_response,
        ServerFrame::Response(JsonRpcResponse::Success {
            jsonrpc: JsonRpcVersion,
            id: JsonRpcResponseId::Id(JsonRpcId::Number(Number::from(9_007_199_254_740_991u64))),
            result: json!({}),
        })
    );
    assert!(
        decode_server_frame(br#"{"jsonrpc":"2.0","id":9007199254740992,"result":{}}"#).is_err()
    );
}

#[test]
fn error_response_serializes_exactly() {
    let response = JsonRpcResponse::Error {
        jsonrpc: JsonRpcVersion,
        id: JsonRpcResponseId::Id(JsonRpcId::Number(Number::from(7))),
        error: JsonRpcError {
            code: -32001,
            message: "room unavailable".into(),
            data: Some(json!({"retry": false})),
        },
    };
    assert_eq!(
        serde_json::to_string(&response).expect("error response serializes"),
        r#"{"jsonrpc":"2.0","id":7,"error":{"code":-32001,"message":"room unavailable","data":{"retry":false}}}"#
    );
}

#[test]
fn server_frame_rejects_noncanonical_envelopes() {
    let invalid = [
        r#"{"jsonrpc":"1.0","id":"a","result":null}"#,
        r#"{"id":"a","result":null}"#,
        r#"{"jsonrpc":"2.0","id":"a","result":null,"extra":true}"#,
        r#"{"jsonrpc":"2.0","id":"a","result":null,"error":{"code":1,"message":"no"}}"#,
        r#"{"jsonrpc":"2.0","id":"a"}"#,
        r#"{"protocol":"zer0.room","version":1}"#,
        r#"{"jsonrpc":"2.0","method":"zer0/room/other","params":{}}"#,
        r#"{"jsonrpc":"2.0","method":"zer0/room/event","params":{},"extra":true}"#,
    ];
    for frame in invalid {
        assert!(decode_server_frame(frame.as_bytes()).is_err(), "{frame}");
    }
    let raw_legacy_event = serde_json::to_vec(&event_value()).expect("fixture serializes");
    assert!(decode_server_frame(&raw_legacy_event).is_err());
}

#[test]
fn server_frame_wraps_only_valid_shared_room_events() {
    let valid = json!({
        "jsonrpc": "2.0",
        "method": "zer0/room/event",
        "params": event_value(),
    });
    assert_eq!(
        decode_server_frame(serde_json::to_string(&valid).expect("json").as_bytes())
            .expect("valid wrapped event"),
        ServerFrame::Event(RoomEventNotification::new(event()))
    );

    let mut invalid_event = event_value();
    invalid_event["eventSeq"] = json!("01");
    let invalid = json!({
        "jsonrpc": "2.0",
        "method": "zer0/room/event",
        "params": invalid_event,
    });
    assert!(
        decode_server_frame(serde_json::to_string(&invalid).expect("json").as_bytes()).is_err()
    );
}
