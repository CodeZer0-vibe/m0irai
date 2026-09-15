use std::fmt;

use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::sequence::validate_decimal;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RoomEvent {
    pub protocol: String,
    pub version: u64,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "eventSeq")]
    pub event_seq: String,
    #[serde(rename = "eventId")]
    pub event_id: String,
    #[serde(rename = "turnId")]
    pub turn_id: String,
    #[serde(rename = "occurredAt")]
    pub occurred_at: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub payload: Value,
}

impl RoomEvent {
    pub fn from_value(value: Value) -> Result<Self, ProtocolError> {
        let event: Self = serde_json::from_value(value)
            .map_err(|error| ProtocolError::InvalidEvent(error.to_string()))?;
        event.validate()?;
        Ok(event)
    }

    pub fn validate(&self) -> Result<(), ProtocolError> {
        if self.protocol != "zer0.room" || self.version != 1 {
            return Err(ProtocolError::InvalidEvent(
                "unsupported room protocol".into(),
            ));
        }
        for value in [
            &self.session_id,
            &self.event_id,
            &self.turn_id,
            &self.occurred_at,
            &self.kind,
        ] {
            if value.is_empty() {
                return Err(ProtocolError::InvalidEvent(
                    "room event has an empty required field".into(),
                ));
            }
        }
        validate_decimal(&self.event_seq)?;
        DateTime::parse_from_rfc3339(&self.occurred_at).map_err(|_| {
            ProtocolError::InvalidEvent("occurredAt must be an RFC3339 date-time".into())
        })?;
        if !is_known_event_kind(&self.kind) {
            return Err(ProtocolError::InvalidEvent(format!(
                "unknown room event type: {}",
                self.kind
            )));
        }
        if !self.payload.is_object() {
            return Err(ProtocolError::InvalidEvent(
                "room event payload must be an object".into(),
            ));
        }
        match self.kind.as_str() {
            "lane.started" => validate_lane_started_payload(&self.payload)?,
            "lane.chunk" => validate_lane_chunk_payload(&self.payload)?,
            "lane.activity" => validate_lane_activity_payload(&self.payload)?,
            "agent.status" => validate_agent_status_payload(&self.payload)?,
            "agent.mode" => validate_agent_mode_payload(&self.payload)?,
            "hop.dispatched" | "hop.blocked" => validate_hop_payload(&self.payload)?,
            "permission.requested" => validate_permission_requested_payload(&self.payload)?,
            "permission.resolved" => validate_permission_resolved_payload(&self.payload)?,
            "backend.failed" => validate_backend_failed_payload(&self.payload)?,
            "room.notice" => validate_room_notice_payload(&self.payload)?,
            _ => {}
        }
        Ok(())
    }

    pub fn is_readiness(&self) -> bool {
        self.kind == "session.saved"
            && self.event_seq == "0"
            && self.payload.get("ready") == Some(&Value::Bool(true))
    }
}

fn validate_permission_requested_payload(payload: &Value) -> Result<(), ProtocolError> {
    let payload = payload.as_object().expect("validated object payload");
    if payload
        .keys()
        .any(|field| !matches!(field.as_str(), "agent" | "askId" | "toolTitle" | "options"))
    {
        return Err(ProtocolError::InvalidEvent(
            "permission.requested payload has unknown fields".into(),
        ));
    }
    required_agent(payload)?;
    required_opaque_bounded_string(payload, "askId", 4096, "permission.requested")?;
    if payload.contains_key("toolTitle") {
        required_bounded_string(payload, "toolTitle", 240, "permission.requested")?;
    }
    let Some(options) = payload.get("options") else {
        return Ok(());
    };
    let options = options.as_array().ok_or_else(|| {
        ProtocolError::InvalidEvent("permission.requested options must be an array".into())
    })?;
    if options.len() > 9 {
        return Err(ProtocolError::InvalidEvent(
            "permission.requested options exceeds 9 entries".into(),
        ));
    }
    let mut ids = std::collections::HashSet::new();
    for option in options {
        let option = option.as_object().ok_or_else(|| {
            ProtocolError::InvalidEvent("permission.requested option must be an object".into())
        })?;
        if option
            .keys()
            .any(|field| !matches!(field.as_str(), "optionId" | "kind" | "name"))
        {
            return Err(ProtocolError::InvalidEvent(
                "permission.requested option has unknown fields".into(),
            ));
        }
        let id = required_opaque_bounded_string(option, "optionId", 4096, "permission.requested")?;
        if !ids.insert(id) {
            return Err(ProtocolError::InvalidEvent(
                "permission.requested optionIds must be unique".into(),
            ));
        }
        for field in ["kind", "name"] {
            if option.contains_key(field) {
                required_bounded_string(option, field, 120, "permission.requested")?;
            }
        }
    }
    Ok(())
}

fn validate_permission_resolved_payload(payload: &Value) -> Result<(), ProtocolError> {
    let payload = payload.as_object().expect("validated object payload");
    if payload
        .keys()
        .any(|field| !matches!(field.as_str(), "agent" | "askId" | "outcome" | "optionId"))
    {
        return Err(ProtocolError::InvalidEvent(
            "permission.resolved payload has unknown fields".into(),
        ));
    }
    required_agent(payload)?;
    required_opaque_bounded_string(payload, "askId", 4096, "permission.resolved")?;
    if !matches!(
        payload.get("outcome").and_then(Value::as_str),
        Some("approved" | "denied" | "timeout" | "invalidated")
    ) {
        return Err(ProtocolError::InvalidEvent(
            "permission.resolved outcome is invalid".into(),
        ));
    }
    if payload.contains_key("optionId") {
        required_opaque_bounded_string(payload, "optionId", 4096, "permission.resolved")?;
    }
    Ok(())
}

fn is_known_event_kind(kind: &str) -> bool {
    matches!(
        kind,
        "turn.accepted"
            | "route.resolved"
            | "lane.queued"
            | "lane.started"
            | "lane.activity"
            | "lane.chunk"
            | "lane.cancelling"
            | "lane.completed"
            | "lane.failed"
            | "lane.cancelled"
            | "agent.status"
            | "agent.mode"
            | "message.committed"
            | "turn.completed"
            | "room.paused"
            | "room.resumed"
            | "permission.requested"
            | "permission.resolved"
            | "hop.dispatched"
            | "hop.blocked"
            | "session.saved"
            | "backend.failed"
            | "room.notice"
    )
}

/// The `cause` is validated as a bounded, control-free, nonempty STRING — deliberately not as a
/// closed enum.
///
/// A newer host will announce conditions this build has no phrase for, and the only two things it
/// can do with one are render it generically or reject the event. Rejecting means the operator loses
/// a row telling them something went wrong, which is exactly backwards for a notice whose whole
/// purpose is to end a silence. The closed set lives at the emission site in the host
/// (src/shared/room-notice.ts), which is the only producer, so nothing unknown can originate here.
///
/// `detail` IS bounded here even though this build never paints it: it rides the wire and lands in
/// the journal, so an unbounded or control-bearing detail is still a cost this half must refuse. The
/// bound is 200 CODE POINTS, counted with `chars()` so it agrees exactly with the schema's
/// `maxLength` and with the host's own code-point clip.
fn validate_room_notice_payload(payload: &Value) -> Result<(), ProtocolError> {
    let payload = payload.as_object().expect("validated object payload");
    if payload
        .keys()
        .any(|field| !matches!(field.as_str(), "cause" | "agent" | "detail"))
    {
        return Err(ProtocolError::InvalidEvent(
            "room.notice payload has unknown fields".into(),
        ));
    }
    required_bounded_string(payload, "cause", 64, "room.notice")?;
    if payload.contains_key("agent") {
        required_agent(payload)?;
    }
    let detail = required_bounded_string(payload, "detail", 800, "room.notice")?;
    if detail.chars().count() > 200 {
        return Err(ProtocolError::InvalidEvent(
            "room.notice detail exceeds 200 code points".into(),
        ));
    }
    Ok(())
}

fn validate_agent_mode_payload(payload: &Value) -> Result<(), ProtocolError> {
    let payload = payload.as_object().expect("validated object payload");
    if payload.keys().any(|field| {
        !matches!(
            field.as_str(),
            "agent" | "modeId" | "word" | "status" | "error" | "availableModeIds"
        )
    }) {
        return Err(ProtocolError::InvalidEvent(
            "agent.mode payload has unknown fields".into(),
        ));
    }
    required_agent(payload)?;
    required_bounded_string(payload, "modeId", 128, "agent.mode")?;
    if !matches!(
        payload.get("status").and_then(Value::as_str),
        Some("active" | "pending" | "failed")
    ) {
        return Err(ProtocolError::InvalidEvent(
            "agent.mode status is invalid".into(),
        ));
    }
    if let Some(word) = payload.get("word") {
        let word = word
            .as_str()
            .ok_or_else(|| ProtocolError::InvalidEvent("agent.mode word is invalid".into()))?;
        if !matches!(
            word,
            "plan" | "careful" | "edits" | "auto" | "strict" | "smart"
        ) {
            return Err(ProtocolError::InvalidEvent(
                "agent.mode word is invalid".into(),
            ));
        }
    }
    if payload.contains_key("error") {
        required_bounded_string(payload, "error", 240, "agent.mode")?;
    }
    if let Some(available) = payload.get("availableModeIds") {
        let available = available.as_array().ok_or_else(|| {
            ProtocolError::InvalidEvent("agent.mode availableModeIds must be an array".into())
        })?;
        if available.len() > 32 {
            return Err(ProtocolError::InvalidEvent(
                "agent.mode availableModeIds exceeds 32 entries".into(),
            ));
        }
        let mut unique = std::collections::HashSet::new();
        for mode_id in available {
            let mode_id = mode_id
                .as_str()
                .filter(|mode_id| {
                    !mode_id.is_empty() && mode_id.len() <= 128 && !has_unsafe_control(mode_id)
                })
                .ok_or_else(|| {
                    ProtocolError::InvalidEvent(
                        "agent.mode availableModeIds contains an invalid mode id".into(),
                    )
                })?;
            if !unique.insert(mode_id) {
                return Err(ProtocolError::InvalidEvent(
                    "agent.mode availableModeIds must be unique".into(),
                ));
            }
        }
    }
    Ok(())
}

fn validate_hop_payload(payload: &Value) -> Result<(), ProtocolError> {
    let payload = payload.as_object().expect("validated object payload");
    if payload.keys().any(|field| {
        !matches!(
            field.as_str(),
            "fromAgent"
                | "toAgent"
                | "parentMessageId"
                | "hopIndex"
                | "maxHop"
                | "hopBudget"
                | "hopId"
                | "text"
        )
    }) {
        return Err(ProtocolError::InvalidEvent(
            "hop payload has unknown fields".into(),
        ));
    }
    let from = required_agent_field(payload, "fromAgent")?;
    let to = required_agent_field(payload, "toAgent")?;
    if from == to {
        return Err(ProtocolError::InvalidEvent(
            "hop payload cannot target its source agent".into(),
        ));
    }
    required_bounded_string(payload, "parentMessageId", 256, "hop")?;
    required_bounded_string(payload, "hopId", 256, "hop")?;
    required_positive_safe_integer(payload, "hopIndex", "hop")?;
    let has_max = payload.contains_key("maxHop");
    let has_legacy = payload.contains_key("hopBudget");
    if has_max == has_legacy {
        return Err(ProtocolError::InvalidEvent(
            "hop payload requires exactly one maxHop or hopBudget".into(),
        ));
    }
    required_positive_safe_integer(payload, if has_max { "maxHop" } else { "hopBudget" }, "hop")?;
    if payload.contains_key("text") {
        required_bounded_string(payload, "text", 2048, "hop")?;
    }
    Ok(())
}

fn validate_agent_status_payload(payload: &Value) -> Result<(), ProtocolError> {
    let payload = payload.as_object().expect("validated object payload");
    if payload
        .keys()
        .any(|field| !matches!(field.as_str(), "agent" | "auth" | "usage" | "availability"))
    {
        return Err(ProtocolError::InvalidEvent(
            "agent.status payload has unknown fields".into(),
        ));
    }
    required_agent(payload)?;
    if !payload.contains_key("auth")
        && !payload.contains_key("usage")
        && !payload.contains_key("availability")
    {
        return Err(ProtocolError::InvalidEvent(
            "agent.status requires status data".into(),
        ));
    }
    if let Some(auth) = payload.get("auth")
        && !matches!(auth.as_str(), Some("ready" | "limited" | "down"))
    {
        return Err(ProtocolError::InvalidEvent(
            "agent.status auth is invalid".into(),
        ));
    }
    if let Some(usage) = payload.get("usage") {
        validate_agent_usage(usage)?;
    }
    if let Some(availability) = payload.get("availability") {
        validate_agent_availability(availability)?;
    }
    Ok(())
}

fn validate_agent_usage(value: &Value) -> Result<(), ProtocolError> {
    let usage = value.as_object().ok_or_else(|| {
        ProtocolError::InvalidEvent("agent.status usage must be an object".into())
    })?;
    if usage.keys().any(|field| {
        !matches!(
            field.as_str(),
            "exhausted"
                | "contextUsedPct"
                | "fiveHourUsedPct"
                | "fiveHourResetsAtMs"
                | "weeklyUsedPct"
                | "weeklyResetsAtMs"
        )
    }) || usage.get("exhausted").and_then(Value::as_bool).is_none()
    {
        return Err(ProtocolError::InvalidEvent(
            "agent.status usage is invalid".into(),
        ));
    }
    for field in ["contextUsedPct", "fiveHourUsedPct", "weeklyUsedPct"] {
        if let Some(value) = usage.get(field)
            && value.as_u64().filter(|value| *value <= 100).is_none()
        {
            return Err(ProtocolError::InvalidEvent(format!(
                "agent.status {field} must be an integer from 0 to 100"
            )));
        }
    }
    for field in ["fiveHourResetsAtMs", "weeklyResetsAtMs"] {
        validate_optional_safe_integer(usage, field)?;
    }
    Ok(())
}

fn validate_agent_availability(value: &Value) -> Result<(), ProtocolError> {
    let availability = value.as_object().ok_or_else(|| {
        ProtocolError::InvalidEvent("agent.status availability must be an object".into())
    })?;
    if availability
        .keys()
        .any(|field| !matches!(field.as_str(), "state" | "resetsAtMs"))
        || !matches!(
            availability.get("state").and_then(Value::as_str),
            Some("ready" | "exhausted" | "needs_auth" | "local_blocked" | "retrying")
        )
    {
        return Err(ProtocolError::InvalidEvent(
            "agent.status availability is invalid".into(),
        ));
    }
    validate_optional_safe_integer(availability, "resetsAtMs")
}

fn validate_optional_safe_integer(
    payload: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<(), ProtocolError> {
    if let Some(value) = payload.get(field)
        && value
            .as_u64()
            .filter(|value| *value <= 9_007_199_254_740_991)
            .is_none()
    {
        return Err(ProtocolError::InvalidEvent(format!(
            "agent.status {field} must be a nonnegative safe integer"
        )));
    }
    Ok(())
}

fn validate_lane_started_payload(payload: &Value) -> Result<(), ProtocolError> {
    let payload = payload.as_object().expect("validated object payload");
    required_string(payload, "laneId")?;
    required_string(payload, "streamId")?;
    required_agent(payload)?;
    validate_optional_model_id(payload)?;
    Ok(())
}

fn validate_lane_chunk_payload(payload: &Value) -> Result<(), ProtocolError> {
    let payload = payload.as_object().expect("validated object payload");
    required_string(payload, "laneId")?;
    required_string(payload, "streamId")?;
    required_agent(payload)?;
    validate_decimal(&required_string(payload, "streamSeq")?)?;
    let chunk_index = payload
        .get("chunkIndex")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            ProtocolError::InvalidEvent("lane.chunk requires nonnegative chunkIndex".into())
        })?;
    if chunk_index > 9_007_199_254_740_991 {
        return Err(ProtocolError::InvalidEvent(
            "lane.chunk chunkIndex exceeds max safe integer".into(),
        ));
    }
    required_string(payload, "channel")?;
    required_text(payload)?;
    validate_optional_model_id(payload)?;
    Ok(())
}

fn validate_lane_activity_payload(payload: &Value) -> Result<(), ProtocolError> {
    let payload = payload.as_object().expect("validated object payload");
    required_string(payload, "laneId")?;
    required_string(payload, "streamId")?;
    required_string(payload, "toolCallId")?;
    match payload.get("update").and_then(Value::as_str) {
        Some("tool_call" | "tool_call_update") => Ok(()),
        _ => Err(ProtocolError::InvalidEvent(
            "lane.activity update must be tool_call or tool_call_update".into(),
        )),
    }
}

fn validate_backend_failed_payload(payload: &Value) -> Result<(), ProtocolError> {
    let payload = payload.as_object().expect("validated object payload");
    for (key, value) in payload {
        if !matches!(key.as_str(), "message" | "error")
            || value.as_str().filter(|value| !value.is_empty()).is_none()
        {
            return Err(ProtocolError::InvalidEvent(
                "backend.failed accepts only optional nonempty message/error".into(),
            ));
        }
    }
    Ok(())
}

fn validate_optional_model_id(
    payload: &serde_json::Map<String, Value>,
) -> Result<(), ProtocolError> {
    if let Some(model_id) = payload.get("modelId")
        && model_id
            .as_str()
            .filter(|model_id| !model_id.is_empty())
            .is_none()
    {
        return Err(ProtocolError::InvalidEvent(
            "lane modelId must be nonempty when present".into(),
        ));
    }
    Ok(())
}

fn required_agent(payload: &serde_json::Map<String, Value>) -> Result<(), ProtocolError> {
    match payload.get("agent").and_then(Value::as_str) {
        Some("claude" | "codex" | "gemini") => Ok(()),
        _ => Err(ProtocolError::InvalidEvent(
            "lane event requires a supported agent".into(),
        )),
    }
}

fn required_agent_field(
    payload: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<String, ProtocolError> {
    match payload.get(field).and_then(Value::as_str) {
        Some("claude" | "codex" | "gemini") => Ok(payload[field].as_str().unwrap().to_owned()),
        _ => Err(ProtocolError::InvalidEvent(format!(
            "hop requires a supported {field}"
        ))),
    }
}

fn required_bounded_string(
    payload: &serde_json::Map<String, Value>,
    field: &str,
    max_bytes: usize,
    kind: &str,
) -> Result<String, ProtocolError> {
    let value = payload
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= max_bytes && !has_unsafe_control(value))
        .map(str::to_owned)
        .ok_or_else(|| ProtocolError::InvalidEvent(format!("{kind} requires safe {field}")))?;
    Ok(value)
}

fn required_opaque_bounded_string(
    payload: &serde_json::Map<String, Value>,
    field: &str,
    max_bytes: usize,
    kind: &str,
) -> Result<String, ProtocolError> {
    payload
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= max_bytes)
        .map(str::to_owned)
        .ok_or_else(|| ProtocolError::InvalidEvent(format!("{kind} requires bounded {field}")))
}

fn required_positive_safe_integer(
    payload: &serde_json::Map<String, Value>,
    field: &str,
    kind: &str,
) -> Result<u64, ProtocolError> {
    payload
        .get(field)
        .and_then(Value::as_u64)
        .filter(|value| *value > 0 && *value <= 9_007_199_254_740_991)
        .ok_or_else(|| ProtocolError::InvalidEvent(format!("{kind} requires positive {field}")))
}

fn has_unsafe_control(value: &str) -> bool {
    value.chars().any(|character| {
        let code = character as u32;
        code <= 0x1f
            || (0x7f..=0x9f).contains(&code)
            || matches!(
                code,
                0x061c
                    | 0x200b..=0x200f
                    | 0x202a..=0x202e
                    | 0x2060
                    | 0x2066..=0x2069
                    | 0xfeff
            )
    })
}

fn required_text(payload: &serde_json::Map<String, Value>) -> Result<String, ProtocolError> {
    let text = payload
        .get("text")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| ProtocolError::InvalidEvent("lane.chunk requires text".into()))?;
    if text.len() > 32 * 1024 {
        return Err(ProtocolError::InvalidEvent(
            "lane.chunk text exceeds 32 KiB UTF-8 byte limit".into(),
        ));
    }
    Ok(text)
}

fn required_string(
    payload: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<String, ProtocolError> {
    payload
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| ProtocolError::InvalidEvent(format!("lane.chunk requires {field}")))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProtocolError {
    ConflictingEventId(String),
    EventGap {
        expected: String,
        received: String,
    },
    InvalidEvent(String),
    InvalidSequence(String),
    SessionMismatch {
        expected: String,
        received: String,
    },
    StreamGap {
        stream_id: String,
        expected: String,
        received: String,
    },
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ConflictingEventId(event_id) => {
                write!(formatter, "conflicting duplicate room event id: {event_id}")
            }
            Self::EventGap { expected, received } => {
                write!(formatter, "event gap: expected {expected}, got {received}")
            }
            Self::InvalidEvent(message) => write!(formatter, "invalid room event: {message}"),
            Self::InvalidSequence(sequence) => {
                write!(formatter, "invalid decimal sequence: {sequence}")
            }
            Self::SessionMismatch { expected, received } => write!(
                formatter,
                "session mismatch: expected {expected}, got {received}"
            ),
            Self::StreamGap {
                stream_id,
                expected,
                received,
            } => write!(
                formatter,
                "stream {stream_id} gap: expected {expected}, got {received}"
            ),
        }
    }
}

impl std::error::Error for ProtocolError {}
