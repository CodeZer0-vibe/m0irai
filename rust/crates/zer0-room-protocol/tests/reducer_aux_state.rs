mod support;

use serde_json::json;
use zer0_room_protocol::{
    AgentAuthState, AgentAvailabilityState, AgentModeStatus, LaneActivityUpdate, LanePhase,
    PermissionOutcome, RoomReducer,
};

use support::{TURN_ID, event, primed, queued, started, terminal, transition_event};

fn activity(
    sequence: &str,
    event_id: &str,
    lane_id: &str,
    stream_id: &str,
    agent: &str,
    tool_call_id: &str,
    update: &str,
    extra: serde_json::Value,
) -> zer0_room_protocol::RoomEvent {
    let mut payload = json!({
        "laneId": lane_id,
        "streamId": stream_id,
        "agent": agent,
        "toolCallId": tool_call_id,
        "update": update,
    });
    payload
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    transition_event(sequence, event_id, TURN_ID, "lane.activity", payload)
}

#[test]
fn agent_mode_retains_only_real_provider_mode_events_and_replaces_prior_state() {
    let mut reducer = RoomReducer::new();
    reducer
        .apply(&event(
            "1",
            "mode-pending",
            "room-mode",
            "agent.mode",
            json!({
                "agent":"codex", "modeId":"agent-full-access", "word":"auto",
                "status":"pending", "availableModeIds":["read-only","agent","agent-full-access"]
            }),
        ))
        .unwrap();
    let pending = reducer.agent_mode("codex").unwrap();
    assert_eq!(pending.status, AgentModeStatus::Pending);
    assert_eq!(pending.word.as_deref(), Some("auto"));
    reducer
        .apply(&event(
            "2",
            "mode-failed",
            "room-mode",
            "agent.mode",
            json!({
                "agent":"codex", "modeId":"agent", "word":"careful", "status":"failed",
                "error":"bridge rejected"
            }),
        ))
        .unwrap();
    let failed = reducer.agent_mode("codex").unwrap();
    assert_eq!(failed.status, AgentModeStatus::Failed);
    assert_eq!(failed.mode_id, "agent");
    assert_eq!(failed.error.as_deref(), Some("bridge rejected"));
    assert!(failed.available_mode_ids.is_none());
    assert_eq!(reducer.agent_modes().count(), 1);
}

fn permission(
    sequence: &str,
    event_id: &str,
    kind: &str,
    agent: &str,
    ask_id: &str,
    extra: serde_json::Value,
) -> zer0_room_protocol::RoomEvent {
    zer0_room_protocol::RoomEvent::from_value(permission_value(
        sequence, event_id, kind, agent, ask_id, extra,
    ))
    .expect("valid permission fixture")
}

fn permission_value(
    sequence: &str,
    event_id: &str,
    kind: &str,
    agent: &str,
    ask_id: &str,
    extra: serde_json::Value,
) -> serde_json::Value {
    let mut payload = json!({"agent": agent, "askId": ask_id});
    payload
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    let sequence = sequence.parse::<u64>().unwrap() + 2;
    json!({
        "protocol": "zer0.room",
        "version": 1,
        "sessionId": support::SESSION_ID,
        "eventSeq": sequence.to_string(),
        "eventId": event_id,
        "turnId": TURN_ID,
        "occurredAt": "2026-08-01T12:00:00Z",
        "type": kind,
        "payload": payload,
    })
}

#[test]
fn agent_status_partial_merges_real_fields_and_replaces_usage_snapshots() {
    let mut reducer = RoomReducer::new();
    reducer
        .apply(&event(
            "1",
            "status-auth",
            "room-control",
            "agent.status",
            json!({"agent":"codex","auth":"ready"}),
        ))
        .unwrap();
    reducer
        .apply(&event(
            "2",
            "status-usage",
            "room-control",
            "agent.status",
            json!({
                "agent":"codex",
                "usage":{
                    "exhausted":true,
                    "contextUsedPct":61,
                    "fiveHourUsedPct":98,
                    "fiveHourResetsAtMs":9_007_199_254_740_991_u64
                }
            }),
        ))
        .unwrap();
    let status = reducer.agent_status("codex").unwrap();
    assert_eq!(status.auth, Some(AgentAuthState::Limited));
    assert_eq!(status.usage.as_ref().unwrap().context_used_pct, Some(61));
    assert_eq!(status.last_event_seq, "2");

    reducer
        .apply(&event(
            "3",
            "status-ready",
            "room-control",
            "agent.status",
            json!({"agent":"codex","availability":{"state":"ready"}}),
        ))
        .unwrap();
    let status = reducer.agent_status("codex").unwrap();
    assert_eq!(status.availability, Some(AgentAvailabilityState::Ready));
    assert_eq!(status.availability_resets_at_ms, None);
    assert_eq!(status.usage.as_ref().unwrap().five_hour_used_pct, Some(98));

    reducer
        .apply(&event(
            "4",
            "status-new-usage",
            "room-control",
            "agent.status",
            json!({
                "agent":"codex",
                "auth":"ready",
                "usage":{"exhausted":false,"weeklyUsedPct":77}
            }),
        ))
        .unwrap();
    let status = reducer.agent_status("codex").unwrap();
    assert_eq!(status.auth, Some(AgentAuthState::Ready));
    let usage = status.usage.as_ref().unwrap();
    assert_eq!(
        usage.context_used_pct, None,
        "usage snapshots replace, not deep-merge"
    );
    assert_eq!(usage.five_hour_used_pct, None);
    assert_eq!(usage.weekly_used_pct, Some(77));
    assert_eq!(reducer.agent_statuses().count(), 1);
}

#[test]
fn pause_resume_transitions_are_strict_and_retry_without_consuming_the_sequence() {
    let mut reducer = RoomReducer::new();
    reducer
        .apply(&event("1", "pause", TURN_ID, "room.paused", json!({})))
        .unwrap();
    assert!(reducer.is_paused());
    assert!(
        reducer
            .apply(&event(
                "2",
                "second-pause",
                TURN_ID,
                "room.paused",
                json!({})
            ))
            .is_err()
    );
    assert_eq!(reducer.last_event_seq(), "1");
    assert!(!reducer.has_event_id("second-pause"));
    reducer
        .apply(&event("2", "resume", TURN_ID, "room.resumed", json!({})))
        .unwrap();
    assert!(!reducer.is_paused());
    assert!(
        reducer
            .apply(&event(
                "3",
                "second-resume",
                TURN_ID,
                "room.resumed",
                json!({})
            ))
            .is_err()
    );
    reducer
        .apply(&event(
            "3",
            "pause-again",
            TURN_ID,
            "room.paused",
            json!({}),
        ))
        .unwrap();
}

#[test]
fn repeated_cancelling_and_activity_upserts_preserve_identity_and_order() {
    let mut reducer = primed(&["claude"]);
    reducer
        .apply(&queued("1", "q", "lane", "claude", "message"))
        .unwrap();
    reducer
        .apply(&started("2", "s", "lane", "stream", "claude"))
        .unwrap();
    let stream = reducer.stream("stream").unwrap();
    assert_eq!(stream.agent, "claude");
    assert_eq!(stream.turn_id, TURN_ID);
    reducer
        .apply(&terminal(
            "3",
            "c1",
            "lane.cancelling",
            "lane",
            Some("stream"),
            "claude",
        ))
        .unwrap();
    reducer
        .apply(&terminal(
            "4",
            "c2",
            "lane.cancelling",
            "lane",
            Some("stream"),
            "claude",
        ))
        .unwrap();
    assert_eq!(reducer.lane("lane").unwrap().phase, LanePhase::Cancelling);

    reducer
        .apply(&activity(
            "5",
            "a1",
            "lane",
            "stream",
            "claude",
            "tool-1",
            "tool_call",
            json!({"title":"Read", "kind":"read", "status":"in_progress"}),
        ))
        .unwrap();
    reducer
        .apply(&activity(
            "6",
            "a2",
            "lane",
            "stream",
            "claude",
            "tool-2",
            "tool_call",
            json!({"title":"Write"}),
        ))
        .unwrap();
    reducer
        .apply(&activity(
            "7",
            "a3",
            "lane",
            "stream",
            "claude",
            "tool-1",
            "tool_call_update",
            json!({"status":"completed"}),
        ))
        .unwrap();
    let activities = reducer
        .ordered_activity_for_stream("stream")
        .collect::<Vec<_>>();
    assert_eq!(
        activities
            .iter()
            .map(|activity| activity.tool_call_id.as_str())
            .collect::<Vec<_>>(),
        ["tool-1", "tool-2"]
    );
    assert_eq!(activities[0].update, LaneActivityUpdate::ToolCallUpdate);
    assert_eq!(activities[0].title.as_deref(), Some("Read"));
    assert_eq!(activities[0].kind.as_deref(), Some("read"));
    assert_eq!(activities[0].status.as_deref(), Some("completed"));
    assert_eq!(activities[0].last_event_seq, "9");
    assert_eq!(activities[1].last_event_seq, "8");
    assert_eq!(reducer.ordered_activity_for_lane("lane").count(), 2);

    assert!(
        reducer
            .apply(&activity(
                "8",
                "wrong-agent",
                "lane",
                "stream",
                "codex",
                "tool-3",
                "tool_call",
                json!({}),
            ))
            .is_err()
    );
    assert!(
        reducer
            .apply(&activity(
                "8",
                "wrong-stream",
                "lane",
                "other",
                "claude",
                "tool-3",
                "tool_call",
                json!({})
            ))
            .is_err()
    );
    reducer
        .apply(&terminal(
            "8",
            "failed",
            "lane.failed",
            "lane",
            Some("stream"),
            "claude",
        ))
        .unwrap();
    assert!(
        reducer
            .apply(&activity(
                "9",
                "after-terminal",
                "lane",
                "stream",
                "claude",
                "tool-3",
                "tool_call",
                json!({})
            ))
            .is_err()
    );
}

#[test]
fn permission_requests_and_resolutions_validate_identity_options_and_pending_state() {
    let mut reducer = primed(&["codex"]);
    reducer
        .apply(&queued("1", "q", "lane", "codex", "message"))
        .unwrap();
    reducer
        .apply(&started("2", "s", "lane", "stream", "codex"))
        .unwrap();
    reducer.apply(&permission("3", "ask", "permission.requested", "codex", "ask-1", json!({"toolTitle":"run sqlx migrate","options":[{"optionId":"approve", "kind":"allow", "name":"Approve"}, {"optionId":"deny"}]}))).unwrap();
    assert_eq!(
        reducer
            .pending_permissions()
            .map(|permission| permission.ask_id.as_str())
            .collect::<Vec<_>>(),
        ["ask-1"]
    );
    assert_eq!(
        reducer.permission("ask-1").unwrap().options[0]
            .name
            .as_deref(),
        Some("Approve")
    );
    assert_eq!(
        reducer.permission("ask-1").unwrap().tool_title.as_deref(),
        Some("run sqlx migrate")
    );

    assert!(
        reducer
            .apply(&permission(
                "4",
                "duplicate",
                "permission.requested",
                "codex",
                "ask-1",
                json!({"options":[]})
            ))
            .is_err()
    );
    assert!(
        reducer
            .apply(&permission(
                "4",
                "unknown",
                "permission.resolved",
                "codex",
                "ask-other",
                json!({"outcome":"approved"})
            ))
            .is_err()
    );
    assert!(
        reducer
            .apply(&permission(
                "4",
                "wrong-agent",
                "permission.resolved",
                "claude",
                "ask-1",
                json!({"outcome":"approved"})
            ))
            .is_err()
    );
    assert!(
        zer0_room_protocol::RoomEvent::from_value(permission_value(
            "4",
            "bad-outcome",
            "permission.resolved",
            "codex",
            "ask-1",
            json!({"outcome":"other"})
        ))
        .is_err()
    );
    assert!(
        reducer
            .apply(&permission(
                "4",
                "unoffered-option",
                "permission.resolved",
                "codex",
                "ask-1",
                json!({"outcome":"approved", "optionId":"not-offered"})
            ))
            .is_err()
    );
    reducer
        .apply(&permission(
            "4",
            "resolved",
            "permission.resolved",
            "codex",
            "ask-1",
            json!({"outcome":"approved", "optionId":"approve"}),
        ))
        .unwrap();
    assert_eq!(reducer.pending_permissions().count(), 0);
    let resolved_permission = reducer.permission("ask-1").unwrap();
    assert_eq!(
        resolved_permission.outcome,
        Some(PermissionOutcome::Approved)
    );
    assert_eq!(resolved_permission.option_id.as_deref(), Some("approve"));

    assert!(
        reducer
            .apply(&permission(
                "5",
                "duplicate-resolve",
                "permission.resolved",
                "codex",
                "ask-1",
                json!({"outcome":"approved"})
            ))
            .is_err()
    );
    assert!(
        zer0_room_protocol::RoomEvent::from_value(permission_value(
            "5",
            "bad-options",
            "permission.requested",
            "codex",
            "ask-2",
            json!({"options":[{"optionId":""}]})
        ))
        .is_err()
    );
    assert!(
        zer0_room_protocol::RoomEvent::from_value(permission_value(
            "5",
            "duplicate-options",
            "permission.requested",
            "codex",
            "ask-2",
            json!({"options":[{"optionId":"same"},{"optionId":"same"}]})
        ))
        .is_err()
    );
    reducer
        .apply(&permission(
            "5",
            "empty-options",
            "permission.requested",
            "codex",
            "ask-2",
            json!({}),
        ))
        .unwrap();
    assert!(reducer.permission("ask-2").unwrap().options.is_empty());
}
