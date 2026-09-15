//! Strict JSON-RPC room-frame transport, replay, and gap recovery.

use std::collections::HashMap;
use std::fmt;

use serde_json::Value;
use zer0_room_protocol::{
    ApplyDelta, JsonRpcId, JsonRpcResponse, JsonRpcResponseId, ProtocolError, RoomEvent,
    RoomReducer, decimal_cmp, decode_server_frame,
};

pub use zer0_room_protocol::ServerFrame;

pub const MAX_FRAME_BYTES: usize = 1_048_576;
pub const MAX_FRAME_CONTENT_BYTES: usize = MAX_FRAME_BYTES - 1;
pub const MAX_BUFFERED_RESYNC_EVENTS: usize = 4_096;
pub const MAX_BUFFERED_RESYNC_BYTES: usize = 16 * 1024 * 1024;

pub fn validate_frame_content(bytes: &[u8]) -> Result<(), TransportError> {
    if bytes.len() > MAX_FRAME_CONTENT_BYTES {
        return Err(TransportError::OversizedFrame(bytes.len()));
    }
    std::str::from_utf8(bytes).map_err(|_| TransportError::InvalidUtf8)?;
    serde_json::from_slice::<Value>(bytes)
        .map(|_| ())
        .map_err(|error| TransportError::InvalidFrame(error.to_string()))
}

pub fn classify_frame(bytes: &[u8]) -> Result<ServerFrame, TransportError> {
    validate_frame_content(bytes)?;
    decode_server_frame(bytes).map_err(|error| TransportError::InvalidFrame(error.to_string()))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SyncPhase {
    AwaitingReadiness,
    Resyncing,
    Live,
    Fatal,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TransportAction {
    RequestResync {
        request_id: String,
        session_id: String,
        after_event_seq: String,
    },
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct TransportEffects {
    pub actions: Vec<TransportAction>,
    pub applied_events: Vec<RoomEvent>,
    pub readiness: Option<RoomEvent>,
}

#[derive(Debug)]
pub struct RoomTransport {
    reducer: RoomReducer,
    phase: SyncPhase,
    readiness: Option<RoomEvent>,
    buffered: Vec<RoomEvent>,
    buffered_bytes: usize,
    request_counter: u64,
    pending_resync_id: Option<String>,
}

impl Default for RoomTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl RoomTransport {
    pub fn new() -> Self {
        Self {
            reducer: RoomReducer::new(),
            phase: SyncPhase::AwaitingReadiness,
            readiness: None,
            buffered: Vec::new(),
            buffered_bytes: 0,
            request_counter: 0,
            pending_resync_id: None,
        }
    }

    pub fn phase(&self) -> SyncPhase {
        self.phase.clone()
    }

    pub fn reducer(&self) -> &RoomReducer {
        &self.reducer
    }

    pub fn ingest_line(&mut self, bytes: &[u8]) -> Result<Vec<TransportAction>, TransportError> {
        self.ingest(classify_frame(bytes)?)
    }

    pub fn ingest(&mut self, frame: ServerFrame) -> Result<Vec<TransportAction>, TransportError> {
        Ok(self.ingest_effects(frame)?.actions)
    }

    pub fn ingest_effects(
        &mut self,
        frame: ServerFrame,
    ) -> Result<TransportEffects, TransportError> {
        if self.phase == SyncPhase::Fatal {
            return Err(TransportError::Fatal(
                "transport is frozen after a fatal protocol error".into(),
            ));
        }
        match frame {
            ServerFrame::Event(notification) => self.ingest_event(notification.params),
            ServerFrame::Response(response) => self.ingest_response(response),
        }
    }

    fn ingest_event(&mut self, event: RoomEvent) -> Result<TransportEffects, TransportError> {
        if event.is_readiness() {
            return self.ingest_readiness(event);
        }
        if event.event_seq == "0" {
            return self.fatal("event sequence zero is reserved for exact readiness");
        }
        if event.kind == "session.saved" {
            return self.fatal("session.saved must be the exact sequence-zero readiness event");
        }
        match self.phase {
            SyncPhase::AwaitingReadiness => {
                self.fatal("ordinary room event arrived before readiness")
            }
            SyncPhase::Resyncing => {
                self.ensure_event_session(&event)?;
                self.buffer_event(event)?;
                Ok(TransportEffects::default())
            }
            SyncPhase::Live => self.apply_live_event(event),
            SyncPhase::Fatal => unreachable!("fatal phase returned before dispatch"),
        }
    }

    fn ingest_readiness(&mut self, event: RoomEvent) -> Result<TransportEffects, TransportError> {
        if let Some(previous) = &self.readiness {
            return if previous == &event {
                Ok(TransportEffects::default())
            } else {
                self.fatal("readiness differs from the canonical sequence-zero event")
            };
        }
        if self.phase != SyncPhase::AwaitingReadiness {
            return self.fatal("readiness arrived outside startup");
        }
        self.reducer
            .bind_session(&event.session_id)
            .map_err(TransportError::Protocol)?;
        self.readiness = Some(event.clone());
        Ok(TransportEffects {
            actions: vec![self.begin_resync()?],
            readiness: Some(event),
            ..TransportEffects::default()
        })
    }

    fn ingest_response(
        &mut self,
        response: JsonRpcResponse,
    ) -> Result<TransportEffects, TransportError> {
        let Some(response_id) = response_string_id(&response) else {
            return Ok(TransportEffects::default());
        };
        if self.phase != SyncPhase::Resyncing
            || self.pending_resync_id.as_deref() != Some(response_id)
        {
            return Ok(TransportEffects::default());
        }
        let result = match response {
            JsonRpcResponse::Error { .. } => {
                return self.fatal("room resync returned an error response");
            }
            JsonRpcResponse::Success { result, .. } => result,
        };
        let page =
            resync_page_from_result(&result).or_else(|error| self.fatal(&error.to_string()))?;
        if page.has_more {
            if page.events.is_empty() {
                return self.fatal("paginated room resync returned an empty non-final page");
            }
            let previous_frontier = self.reducer.last_event_seq().to_owned();
            let events = merge_events(page.events, Vec::new())
                .or_else(|error| self.fatal(&error.to_string()))?;
            let applied_events = self.apply_replay_events(events)?;
            if decimal_cmp(self.reducer.last_event_seq(), &previous_frontier)
                .expect("validated decimal reducer frontiers")
                .is_le()
            {
                return self.fatal("paginated room resync did not advance the event frontier");
            }
            self.prune_buffered_events_already_applied();
            return Ok(TransportEffects {
                actions: vec![self.begin_resync()?],
                applied_events,
                ..TransportEffects::default()
            });
        }
        let buffered = std::mem::take(&mut self.buffered);
        self.buffered_bytes = 0;
        let events =
            merge_events(page.events, buffered).or_else(|error| self.fatal(&error.to_string()))?;
        let applied_events = self.apply_replay_events(events)?;
        self.phase = SyncPhase::Live;
        self.pending_resync_id = None;
        Ok(TransportEffects {
            applied_events,
            ..TransportEffects::default()
        })
    }

    fn apply_live_event(&mut self, event: RoomEvent) -> Result<TransportEffects, TransportError> {
        self.ensure_event_session(&event)?;
        let is_new = !self.reducer.has_event_id(&event.event_id);
        match self.reducer.apply(&event) {
            Ok(ApplyDelta::None | ApplyDelta::Started { .. } | ApplyDelta::Changed { .. }) => {
                Ok(TransportEffects {
                    applied_events: is_new.then_some(event).into_iter().collect(),
                    ..TransportEffects::default()
                })
            }
            Err(ProtocolError::EventGap { .. }) => {
                self.buffer_event(event)?;
                Ok(TransportEffects {
                    actions: vec![self.begin_resync()?],
                    ..TransportEffects::default()
                })
            }
            Err(error) => self.fatal(&error.to_string()),
        }
    }

    fn apply_replay_events(
        &mut self,
        events: Vec<RoomEvent>,
    ) -> Result<Vec<RoomEvent>, TransportError> {
        let mut applied_events = Vec::new();
        for event in events {
            self.validate_ordinary_event(&event)?;
            self.ensure_event_session(&event)?;
            let is_new = !self.reducer.has_event_id(&event.event_id);
            if let Err(error) = self.reducer.apply(&event) {
                return self.fatal(&format!("resync did not repair the journal: {error}"));
            }
            if is_new {
                applied_events.push(event);
            }
        }
        Ok(applied_events)
    }

    fn buffer_event(&mut self, event: RoomEvent) -> Result<(), TransportError> {
        let event_bytes = serde_json::to_vec(&event)
            .expect("validated RoomEvent serialization cannot fail")
            .len();
        if self.buffered.len() >= MAX_BUFFERED_RESYNC_EVENTS {
            return self.fatal("room resync event buffer exceeded its event limit");
        }
        let next_bytes = self
            .buffered_bytes
            .checked_add(event_bytes)
            .ok_or_else(|| TransportError::Fatal("room resync byte counter overflowed".into()))?;
        if next_bytes > MAX_BUFFERED_RESYNC_BYTES {
            return self.fatal("room resync event buffer exceeded its byte limit");
        }
        self.buffered.push(event);
        self.buffered_bytes = next_bytes;
        Ok(())
    }

    fn prune_buffered_events_already_applied(&mut self) {
        self.buffered
            .retain(|event| !self.reducer.has_event_id(&event.event_id));
        self.buffered_bytes = self
            .buffered
            .iter()
            .map(|event| {
                serde_json::to_vec(event)
                    .expect("validated RoomEvent serialization cannot fail")
                    .len()
            })
            .sum();
    }

    fn begin_resync(&mut self) -> Result<TransportAction, TransportError> {
        self.phase = SyncPhase::Resyncing;
        self.request_counter += 1;
        let request_id = format!("room-resync-{}", self.request_counter);
        self.pending_resync_id = Some(request_id.clone());
        let session_id = self
            .reducer
            .session_id()
            .map(str::to_owned)
            .ok_or_else(|| {
                TransportError::Fatal("resync requested without readiness session".into())
            })?;
        Ok(TransportAction::RequestResync {
            request_id,
            session_id,
            after_event_seq: self.reducer.last_event_seq().to_owned(),
        })
    }

    fn validate_ordinary_event(&mut self, event: &RoomEvent) -> Result<(), TransportError> {
        if event.event_seq == "0" || event.kind == "session.saved" {
            return self.fatal("resync cannot contain readiness or session.saved events");
        }
        Ok(())
    }

    fn ensure_event_session(&mut self, event: &RoomEvent) -> Result<(), TransportError> {
        let Some(session_id) = self.reducer.session_id() else {
            return self.fatal("room event arrived before session readiness");
        };
        if session_id != event.session_id {
            return self.fatal(&format!(
                "room event session mismatch: expected {session_id}, got {}",
                event.session_id
            ));
        }
        Ok(())
    }

    fn fatal<T>(&mut self, message: &str) -> Result<T, TransportError> {
        self.phase = SyncPhase::Fatal;
        Err(TransportError::Fatal(message.into()))
    }
}

fn response_string_id(response: &JsonRpcResponse) -> Option<&str> {
    let id = match response {
        JsonRpcResponse::Success { id, .. } | JsonRpcResponse::Error { id, .. } => id,
    };
    match id {
        JsonRpcResponseId::Id(JsonRpcId::String(id)) => Some(id),
        JsonRpcResponseId::Id(JsonRpcId::Number(_)) | JsonRpcResponseId::Null => None,
    }
}

struct ResyncPage {
    events: Vec<RoomEvent>,
    has_more: bool,
}

fn resync_page_from_result(value: &Value) -> Result<ResyncPage, TransportError> {
    let object = value
        .as_object()
        .filter(|result| {
            result.len() == 1
                || (result.len() == 2
                    && result.contains_key("events")
                    && result.contains_key("hasMore"))
        })
        .ok_or_else(|| {
            TransportError::InvalidResponse(
                "resync result must be exactly {events:[...]} or {events:[...],hasMore:boolean}"
                    .into(),
            )
        })?;
    let events = object
        .get("events")
        .and_then(Value::as_array)
        .ok_or_else(|| TransportError::InvalidResponse("resync events must be an array".into()))?;
    let events = events
        .iter()
        .cloned()
        .map(RoomEvent::from_value)
        .collect::<Result<Vec<_>, _>>()
        .map_err(TransportError::Protocol)?;
    let has_more = object
        .get("hasMore")
        .map(|value| {
            value.as_bool().ok_or_else(|| {
                TransportError::InvalidResponse("resync hasMore must be a boolean".into())
            })
        })
        .transpose()?
        .unwrap_or(false);
    Ok(ResyncPage { events, has_more })
}

fn merge_events(
    replay: Vec<RoomEvent>,
    buffered: Vec<RoomEvent>,
) -> Result<Vec<RoomEvent>, TransportError> {
    let mut events = replay;
    events.extend(buffered);
    events.sort_by(|left, right| {
        decimal_cmp(&left.event_seq, &right.event_seq)
            .expect("RoomEvent validation already checked decimal event sequences")
    });
    let mut events_by_id = HashMap::new();
    let mut merged = Vec::new();
    for event in events {
        match events_by_id.get(&event.event_id) {
            Some(previous) if previous == &event => {}
            Some(_) => return Err(TransportError::ConflictingEventId(event.event_id)),
            None => {
                events_by_id.insert(event.event_id.clone(), event.clone());
                merged.push(event);
            }
        }
    }
    Ok(merged)
}

#[derive(Debug)]
pub enum TransportError {
    ConflictingEventId(String),
    Fatal(String),
    InvalidFrame(String),
    InvalidResponse(String),
    InvalidUtf8,
    OversizedFrame(usize),
    Protocol(ProtocolError),
}

impl fmt::Display for TransportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ConflictingEventId(event_id) => {
                write!(formatter, "conflicting duplicate room event id: {event_id}")
            }
            Self::Fatal(message) => write!(formatter, "fatal room transport error: {message}"),
            Self::InvalidFrame(message) => {
                write!(formatter, "invalid strict stdout frame: {message}")
            }
            Self::InvalidResponse(message) => write!(formatter, "invalid room response: {message}"),
            Self::InvalidUtf8 => formatter.write_str("stdout frame is not UTF-8"),
            Self::OversizedFrame(size) => write!(formatter, "stdout frame exceeds 1 MiB: {size}"),
            Self::Protocol(error) => write!(formatter, "room protocol error: {error}"),
        }
    }
}

impl std::error::Error for TransportError {}
