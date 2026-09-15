use serde_json::{Number, Value, json};
use zer0_room_protocol::{
    JsonRpcError, JsonRpcId, JsonRpcResponse, JsonRpcResponseId, JsonRpcVersion, RoomEvent,
    RoomEventNotification, ServerFrame,
};
use zer0_v2_bin::transport::{
    MAX_BUFFERED_RESYNC_EVENTS, MAX_FRAME_BYTES, RoomTransport, SyncPhase, TransportAction,
    TransportError, classify_frame, validate_frame_content,
};

const TRACE_IDENTICAL: &[u8] =
    include_bytes!("../../../../protocol/conformance/v1/trace-identical-duplicate.bin");
const TRACE_CONFLICT: &[u8] =
    include_bytes!("../../../../protocol/conformance/v1/trace-conflicting-duplicate.bin");
const TRACE_GAP: &[u8] =
    include_bytes!("../../../../protocol/conformance/v1/trace-gap-resync-repeat.bin");
const RESYNC_NULL: &[u8] = include_bytes!("../../../../protocol/conformance/v1/resync-null.bin");
const FRAME_EXACT: &[u8] =
    include_bytes!("../../../../protocol/conformance/v1/frame-exact-limit.bin");
const FRAME_OVER: &[u8] =
    include_bytes!("../../../../protocol/conformance/v1/frame-over-limit.bin");
const FRAME_INVALID_UTF8: &[u8] =
    include_bytes!("../../../../protocol/conformance/v1/invalid-utf8.bin");
const CORPUS_MANIFEST: &str = include_str!("../../../../protocol/conformance/v1/manifest.json");

const SESSION: &str = "room-1";

fn event(sequence: &str, event_id: &str, session: &str, kind: &str, payload: Value) -> RoomEvent {
    RoomEvent::from_value(json!({
        "protocol":"zer0.room", "version":1, "sessionId":session,
        "eventSeq":sequence, "eventId":event_id, "turnId":"turn-1",
        "occurredAt":"2026-08-01T00:00:00Z", "type":kind, "payload":payload,
    }))
    .expect("valid event fixture")
}

fn readiness(session: &str) -> RoomEvent {
    event(
        "0",
        "ready",
        session,
        "session.saved",
        json!({"ready":true}),
    )
}

fn transition_sequence(sequence: &str) -> String {
    (sequence.parse::<u64>().expect("fixture sequence") + 2).to_string()
}

fn accepted() -> RoomEvent {
    event(
        "1",
        "accepted",
        SESSION,
        "turn.accepted",
        json!({
            "agents":["claude"], "text":"operator", "messageId":"operator-message",
            "ledgerSeq":"1",
        }),
    )
}

fn route() -> RoomEvent {
    event(
        "2",
        "route",
        SESSION,
        "route.resolved",
        json!({"agents":["claude"]}),
    )
}

fn queued(sequence: &str, event_id: &str) -> RoomEvent {
    event(
        &transition_sequence(sequence),
        event_id,
        SESSION,
        "lane.queued",
        json!({
            "laneId":"lane", "agent":"claude", "expectedMessageId":"message",
            "origin":"operator", "hopIndex":0,
        }),
    )
}

fn started(sequence: &str, event_id: &str) -> RoomEvent {
    event(
        &transition_sequence(sequence),
        event_id,
        SESSION,
        "lane.started",
        json!({
            "laneId":"lane", "streamId":"stream", "agent":"claude",
        }),
    )
}

fn recovered_failed(sequence: &str, event_id: &str) -> RoomEvent {
    event(
        &transition_sequence(sequence),
        event_id,
        SESSION,
        "lane.failed",
        json!({"laneId":"lane", "agent":"claude", "recovered":true}),
    )
}

fn chunk(
    sequence: &str,
    event_id: &str,
    stream_seq: &str,
    chunk_index: u64,
    text: &str,
) -> RoomEvent {
    event(
        &transition_sequence(sequence),
        event_id,
        SESSION,
        "lane.chunk",
        json!({
            "laneId":"lane", "streamId":"stream", "agent":"claude", "streamSeq":stream_seq,
            "chunkIndex":chunk_index, "channel":"assistant", "text":text,
        }),
    )
}

fn notification(event: RoomEvent) -> ServerFrame {
    ServerFrame::Event(RoomEventNotification::new(event))
}

fn success(id: JsonRpcResponseId, result: Value) -> ServerFrame {
    ServerFrame::Response(JsonRpcResponse::Success {
        jsonrpc: JsonRpcVersion,
        id,
        result,
    })
}

fn response(request_id: &str, replayed_events: Vec<RoomEvent>) -> ServerFrame {
    let mut events = vec![accepted(), route()];
    events.extend(replayed_events);
    success(
        JsonRpcResponseId::Id(JsonRpcId::String(request_id.into())),
        json!({"events":events}),
    )
}

fn paged_response(request_id: &str, events: Vec<RoomEvent>, has_more: bool) -> ServerFrame {
    success(
        JsonRpcResponseId::Id(JsonRpcId::String(request_id.into())),
        json!({"events":events,"hasMore":has_more}),
    )
}

fn begin(transport: &mut RoomTransport) -> String {
    let effects = transport
        .ingest_effects(notification(readiness(SESSION)))
        .expect("readiness");
    assert_eq!(effects.readiness, Some(readiness(SESSION)));
    match effects.actions.as_slice() {
        [
            TransportAction::RequestResync {
                request_id,
                session_id,
                after_event_seq,
            },
        ] => {
            assert_eq!(session_id, SESSION);
            assert_eq!(after_event_seq, "0");
            request_id.clone()
        }
        _ => panic!("readiness must request resync"),
    }
}

#[test]
fn classifier_keeps_guards_and_rejects_legacy_or_unknown_envelopes() {
    assert!(matches!(
        classify_frame(&vec![b'x'; MAX_FRAME_BYTES + 1]),
        Err(TransportError::OversizedFrame(_))
    ));
    assert!(matches!(
        classify_frame(&[0xff]),
        Err(TransportError::InvalidUtf8)
    ));
    assert!(matches!(
        classify_frame(b"{"),
        Err(TransportError::InvalidFrame(_))
    ));
    for raw in [
        br#"{"protocol":"zer0.room","version":1}"#.as_slice(),
        br#"{"id":"legacy","result":{}}"#.as_slice(),
        br#"{"jsonrpc":"2.0","method":"other","params":{}}"#.as_slice(),
        br#"{"jsonrpc":"2.0","id":"x","result":null,"error":{"code":1,"message":"no"}}"#.as_slice(),
    ] {
        assert!(matches!(
            classify_frame(raw),
            Err(TransportError::InvalidFrame(_))
        ));
    }
}

#[test]
fn shared_frame_corpus_uses_the_production_frame_validator() {
    let manifest: Value = serde_json::from_str(CORPUS_MANIFEST).expect("shared manifest");
    let cases = manifest["cases"].as_array().expect("cases array");
    let mut count = 0;
    for case in cases.iter().filter(|case| case["kind"] == "frame") {
        let file = case["file"].as_str().expect("file");
        let raw = match file {
            "frame-exact-limit.bin" => FRAME_EXACT,
            "frame-over-limit.bin" => FRAME_OVER,
            "invalid-utf8.bin" => FRAME_INVALID_UTF8,
            unexpected => panic!("frame corpus file is not a literal-byte consumer: {unexpected}"),
        };
        assert_eq!(raw.last(), Some(&b'\n'));
        let expected = case["expect"]["valid"].as_bool().expect("valid");
        assert_eq!(
            validate_frame_content(&raw[..raw.len() - 1]).is_ok(),
            expected,
            "{}",
            case["id"].as_str().expect("id")
        );
        count += 1;
    }
    assert_eq!(count, 3);
}

#[test]
fn response_before_readiness_is_harmless_and_initial_request_carries_session() {
    let mut transport = RoomTransport::new();
    let effects = transport
        .ingest_effects(success(
            JsonRpcResponseId::Id(JsonRpcId::String("session-new".into())),
            json!({}),
        ))
        .unwrap();
    assert!(effects.actions.is_empty());
    assert_eq!(transport.phase(), SyncPhase::AwaitingReadiness);
    let _ = begin(&mut transport);
}

#[test]
fn readiness_is_a_singleton_in_resync_and_live_and_conflicts_are_fatal() {
    let mut transport = RoomTransport::new();
    let request_id = begin(&mut transport);
    let duplicate = transport
        .ingest_effects(notification(readiness(SESSION)))
        .unwrap();
    assert!(duplicate.actions.is_empty());
    assert!(duplicate.readiness.is_none());
    transport.ingest(response(&request_id, vec![])).unwrap();
    let duplicate_live = transport
        .ingest_effects(notification(readiness(SESSION)))
        .unwrap();
    assert!(duplicate_live.readiness.is_none());

    let conflict = event(
        "0",
        "different",
        SESSION,
        "session.saved",
        json!({"ready":true}),
    );
    assert!(transport.ingest(notification(conflict)).is_err());
    assert_eq!(transport.phase(), SyncPhase::Fatal);
}

#[test]
fn early_or_noncanonical_readiness_events_are_fatal() {
    for event in [
        queued("1", "early"),
        event("0", "not-ready", SESSION, "turn.accepted", json!({})),
        event(
            "1",
            "saved-late",
            SESSION,
            "session.saved",
            json!({"ready":true}),
        ),
    ] {
        let mut transport = RoomTransport::new();
        assert!(transport.ingest(notification(event)).is_err());
        assert_eq!(transport.phase(), SyncPhase::Fatal);
    }
}

#[test]
fn strict_resync_replays_current_lifecycle_and_result_null_is_invalid() {
    let mut invalid = RoomTransport::new();
    let _request_id = begin(&mut invalid);
    assert!(
        invalid
            .ingest_line(&RESYNC_NULL[..RESYNC_NULL.len() - 1])
            .is_err()
    );
    assert_eq!(invalid.phase(), SyncPhase::Fatal);

    let mut transport = RoomTransport::new();
    let request_id = begin(&mut transport);
    transport
        .ingest(response(
            &request_id,
            vec![
                queued("1", "q"),
                started("2", "s"),
                chunk("3", "c", "1", 0, "hello"),
            ],
        ))
        .unwrap();
    let stream = transport.reducer().stream("stream").unwrap();
    assert_eq!(stream.text, "hello");
    assert_eq!(stream.next_chunk_index, 1);
    assert_eq!(stream.next_stream_seq, "2");
}

#[test]
fn resync_accepts_a_truthful_failure_recovered_before_lane_start_was_flushed() {
    let mut transport = RoomTransport::new();
    let request_id = begin(&mut transport);
    transport
        .ingest(response(
            &request_id,
            vec![queued("1", "q"), recovered_failed("2", "recovered-failure")],
        ))
        .expect("queue-only durable failure is a valid crash recovery trace");

    assert_eq!(transport.phase(), SyncPhase::Live);
    assert_eq!(
        transport.reducer().lane("lane").unwrap().phase,
        zer0_room_protocol::LanePhase::Failed
    );
}

#[test]
fn numeric_null_and_unrelated_responses_never_correlate() {
    let mut transport = RoomTransport::new();
    let request_id = begin(&mut transport);
    for frame in [
        success(
            JsonRpcResponseId::Id(JsonRpcId::Number(Number::from(7))),
            json!({"events":[]}),
        ),
        success(JsonRpcResponseId::Null, json!({"events":[]})),
        success(
            JsonRpcResponseId::Id(JsonRpcId::String("other".into())),
            json!({"events":[]}),
        ),
    ] {
        transport.ingest(frame).unwrap();
        assert_eq!(transport.phase(), SyncPhase::Resyncing);
    }
    transport.ingest(response(&request_id, vec![])).unwrap();
    assert_eq!(transport.phase(), SyncPhase::Live);
}

#[test]
fn replay_gap_and_interleaving_merge_deterministically_with_session_bound_actions() {
    let mut transport = RoomTransport::new();
    let request_id = begin(&mut transport);
    transport
        .ingest(notification(chunk("3", "c2", "1", 0, "two")))
        .unwrap();
    transport
        .ingest(response(
            &request_id,
            vec![queued("1", "q"), started("2", "s")],
        ))
        .unwrap();
    assert_eq!(transport.phase(), SyncPhase::Live);
    assert_eq!(transport.reducer().stream("stream").unwrap().text, "two");

    let actions = transport
        .ingest(notification(chunk("5", "c4", "3", 2, "four")))
        .unwrap();
    let request_id = match actions.as_slice() {
        [
            TransportAction::RequestResync {
                request_id,
                session_id,
                after_event_seq,
            },
        ] => {
            assert_eq!(session_id, SESSION);
            assert_eq!(after_event_seq, "5");
            request_id.clone()
        }
        _ => panic!("gap must request resync"),
    };
    transport
        .ingest(response(
            &request_id,
            vec![chunk("4", "c3", "2", 1, "three")],
        ))
        .unwrap();
    assert_eq!(
        transport.reducer().stream("stream").unwrap().text,
        "twothreefour"
    );
}

#[test]
fn paginated_resync_advances_the_frontier_and_retains_live_buffering_until_the_final_page() {
    let mut transport = RoomTransport::new();
    let first_request = begin(&mut transport);
    let first = transport
        .ingest_effects(paged_response(
            &first_request,
            vec![accepted(), route(), queued("1", "q")],
            true,
        ))
        .unwrap();
    assert_eq!(transport.phase(), SyncPhase::Resyncing);
    assert_eq!(first.applied_events.len(), 3);
    let second_request = match first.actions.as_slice() {
        [
            TransportAction::RequestResync {
                request_id,
                after_event_seq,
                ..
            },
        ] => {
            assert_eq!(after_event_seq, "3");
            request_id.clone()
        }
        _ => panic!("non-final page must request the next page"),
    };

    transport
        .ingest(notification(chunk("3", "chunk-live", "1", 0, "live")))
        .unwrap();
    let final_page = transport
        .ingest_effects(paged_response(
            &second_request,
            vec![started("2", "started")],
            false,
        ))
        .unwrap();
    assert_eq!(transport.phase(), SyncPhase::Live);
    assert_eq!(final_page.applied_events.len(), 2);
    assert_eq!(transport.reducer().stream("stream").unwrap().text, "live");
}

#[test]
fn empty_nonfinal_pages_and_unbounded_resync_buffering_fail_closed() {
    let mut empty = RoomTransport::new();
    let request = begin(&mut empty);
    assert!(
        empty
            .ingest(paged_response(&request, vec![], true))
            .is_err()
    );
    assert_eq!(empty.phase(), SyncPhase::Fatal);

    let mut flooded = RoomTransport::new();
    let _request = begin(&mut flooded);
    for index in 0..MAX_BUFFERED_RESYNC_EVENTS {
        flooded
            .ingest(notification(event(
                &(index + 1).to_string(),
                &format!("buffered-{index}"),
                SESSION,
                "room.paused",
                json!({}),
            )))
            .unwrap();
    }
    assert!(
        flooded
            .ingest(notification(event(
                &(MAX_BUFFERED_RESYNC_EVENTS + 1).to_string(),
                "buffer-overflow",
                SESSION,
                "room.paused",
                json!({}),
            )))
            .is_err()
    );
    assert_eq!(flooded.phase(), SyncPhase::Fatal);
}

#[test]
fn replay_conflicts_and_session_mismatches_are_fatal() {
    let mut conflicts = RoomTransport::new();
    let request_id = begin(&mut conflicts);
    assert!(
        conflicts
            .ingest(response(
                &request_id,
                vec![
                    queued("1", "same"),
                    event("2", "same", SESSION, "room.paused", json!({}))
                ]
            ))
            .is_err()
    );
    assert_eq!(conflicts.phase(), SyncPhase::Fatal);

    let mut sessions = RoomTransport::new();
    let request_id = begin(&mut sessions);
    assert!(
        sessions
            .ingest(response(
                &request_id,
                vec![event("1", "foreign", "other", "turn.accepted", json!({}))]
            ))
            .is_err()
    );
    assert_eq!(sessions.phase(), SyncPhase::Fatal);
}

#[test]
fn matching_error_response_is_fatal() {
    let mut transport = RoomTransport::new();
    let request_id = begin(&mut transport);
    let frame = ServerFrame::Response(JsonRpcResponse::Error {
        jsonrpc: JsonRpcVersion,
        id: JsonRpcResponseId::Id(JsonRpcId::String(request_id)),
        error: JsonRpcError {
            code: -32000,
            message: "no replay".into(),
            data: None,
        },
    });
    assert!(transport.ingest(frame).is_err());
    assert_eq!(transport.phase(), SyncPhase::Fatal);
}

#[test]
fn corpus_trace_bytes_preserve_duplicate_and_gap_resync_semantics() {
    let parse = |raw: &[u8]| {
        raw.split_inclusive(|byte| *byte == b'\n')
            .map(|frame| {
                assert_eq!(frame.last(), Some(&b'\n'));
                notification(
                    RoomEvent::from_value(
                        serde_json::from_slice(&frame[..frame.len() - 1])
                            .expect("literal trace JSON"),
                    )
                    .expect("literal trace event"),
                )
            })
            .collect::<Vec<_>>()
    };
    let traces = parse(TRACE_IDENTICAL);
    let base = traces[0].clone();
    let identical = traces[1].clone();
    let conflict = parse(TRACE_CONFLICT)[1].clone();
    let gap_trace = parse(TRACE_GAP);
    let gap = gap_trace[1].clone();
    let event_two_frame = gap_trace[2].clone();
    let repeated_gap = gap_trace[3].clone();
    let base_event = match &base {
        ServerFrame::Event(notification) => notification.params.clone(),
        _ => panic!("event"),
    };
    let session = base_event.session_id.clone();
    let mut duplicate = RoomTransport::new();
    let ready = readiness(&session);
    let request = match duplicate.ingest(notification(ready)).unwrap().as_slice() {
        [TransportAction::RequestResync { request_id, .. }] => request_id.clone(),
        _ => panic!("resync"),
    };
    duplicate
        .ingest(success(
            JsonRpcResponseId::Id(JsonRpcId::String(request)),
            json!({"events":[base_event.clone()]}),
        ))
        .unwrap();
    assert!(duplicate.ingest(identical).unwrap().is_empty());
    assert!(duplicate.ingest(conflict).is_err());
    assert_eq!(duplicate.phase(), SyncPhase::Fatal);

    let mut resync = RoomTransport::new();
    let request = match resync
        .ingest(notification(readiness(&session)))
        .unwrap()
        .as_slice()
    {
        [TransportAction::RequestResync { request_id, .. }] => request_id.clone(),
        _ => panic!("resync"),
    };
    resync
        .ingest(success(
            JsonRpcResponseId::Id(JsonRpcId::String(request)),
            json!({"events":[base_event]}),
        ))
        .unwrap();
    let request = match resync.ingest(gap.clone()).unwrap().as_slice() {
        [
            TransportAction::RequestResync {
                request_id,
                after_event_seq,
                ..
            },
        ] => {
            assert_eq!(after_event_seq, "1");
            request_id.clone()
        }
        _ => panic!("gap resync"),
    };
    let gap_event = match repeated_gap {
        ServerFrame::Event(notification) => notification.params,
        _ => panic!("event"),
    };
    let event_two = match event_two_frame {
        ServerFrame::Event(notification) => notification.params,
        _ => panic!("event"),
    };
    let effects = resync
        .ingest_effects(success(
            JsonRpcResponseId::Id(JsonRpcId::String(request)),
            json!({"events":[event_two, gap_event]}),
        ))
        .unwrap();
    assert_eq!(resync.phase(), SyncPhase::Live);
    assert_eq!(effects.applied_events.len(), 2);
}
