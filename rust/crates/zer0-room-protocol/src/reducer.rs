use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::{Map, Value};

use crate::{
    AgentAuthState, AgentAvailabilityState, AgentModeState, AgentModeStatus, AgentStatusState,
    AgentUsageState, BackendFailure, HopDisposition, HopState, LaneActivity, LaneActivityUpdate,
    LaneOrigin, LanePhase, LaneState, MessageCommit, PermissionOption, PermissionOutcome,
    PermissionState, ProtocolError, RoomEvent, RoomNotice, RoomStream, RouteState,
    TranscriptAuthor, TranscriptEntry, TurnState, increment_decimal, validate_decimal,
};

thread_local! {
    /// CQ-04's instrument: how many times THIS THREAD has asked for a walk of
    /// the lane list.
    ///
    /// A rebuild that asks once per transcript row costs rows × lanes, because
    /// `lane_order` gains a lane per agent per turn and nothing ever removes
    /// from it. That is not a claim a clock can pin — a wall-clock budget on a
    /// loaded box measures the box — so the room pins the OPERATION COUNT
    /// instead, and asserts it does not move when the transcript grows.
    ///
    /// Thread-local rather than a field on [`RoomReducer`], which derives
    /// `Clone`/`Eq`/`PartialEq` that no counter can honestly take part in, and
    /// rather than a global, which two tests running at once would share. It
    /// counts CALLS, not items: the defect was one call per row and the fix is
    /// none, so calls are the unit the invariant is written in.
    static LANE_SCANS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// How many lane-list walks this thread has asked for. See [`LANE_SCANS`].
pub fn lane_scans_on_this_thread() -> u64 {
    LANE_SCANS.with(std::cell::Cell::get)
}

/// Zero this thread's lane-walk count, so a measurement covers one operation.
pub fn reset_lane_scans_on_this_thread() {
    LANE_SCANS.with(|scans| scans.set(0));
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ApplyDelta {
    None,
    Started { stream_id: String },
    Changed { stream_id: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoomReducer {
    session_id: Option<String>,
    last_event_seq: String,
    events_by_id: HashMap<String, RoomEvent>,
    lanes: HashMap<String, LaneState>,
    lane_order: Vec<String>,
    stream_order: Vec<String>,
    streams: HashMap<String, RoomStream>,
    paused: bool,
    permissions: Vec<PermissionState>,
    permission_indices: HashMap<String, usize>,
    message_lanes: HashMap<String, String>,
    transcript_message_ids: HashSet<String>,
    hops: Vec<HopState>,
    hop_indices: HashMap<String, usize>,
    turns: Vec<TurnState>,
    turn_indices: HashMap<String, usize>,
    turn_lane_ids: HashMap<String, Vec<String>>,
    transcript: Vec<TranscriptEntry>,
    backend_failures: Vec<BackendFailure>,
    room_notices: Vec<RoomNotice>,
    agent_statuses: BTreeMap<String, AgentStatusState>,
    agent_modes: BTreeMap<String, AgentModeState>,
}

impl Default for RoomReducer {
    fn default() -> Self {
        Self {
            session_id: None,
            last_event_seq: "0".into(),
            events_by_id: HashMap::new(),
            lanes: HashMap::new(),
            lane_order: Vec::new(),
            stream_order: Vec::new(),
            streams: HashMap::new(),
            paused: false,
            permissions: Vec::new(),
            permission_indices: HashMap::new(),
            message_lanes: HashMap::new(),
            transcript_message_ids: HashSet::new(),
            hops: Vec::new(),
            hop_indices: HashMap::new(),
            turns: Vec::new(),
            turn_indices: HashMap::new(),
            turn_lane_ids: HashMap::new(),
            transcript: Vec::new(),
            backend_failures: Vec::new(),
            room_notices: Vec::new(),
            agent_statuses: BTreeMap::new(),
            agent_modes: BTreeMap::new(),
        }
    }
}

impl RoomReducer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn bind_session(&mut self, session_id: &str) -> Result<(), ProtocolError> {
        match &self.session_id {
            Some(bound) if bound != session_id => Err(ProtocolError::SessionMismatch {
                expected: bound.clone(),
                received: session_id.into(),
            }),
            Some(_) => Ok(()),
            None => {
                self.session_id = Some(session_id.into());
                Ok(())
            }
        }
    }

    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    pub fn last_event_seq(&self) -> &str {
        &self.last_event_seq
    }

    pub fn has_event_id(&self, event_id: &str) -> bool {
        self.events_by_id.contains_key(event_id)
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    pub fn lane(&self, lane_id: &str) -> Option<&LaneState> {
        self.lanes.get(lane_id)
    }

    pub fn ordered_lanes(&self) -> impl Iterator<Item = &LaneState> {
        LANE_SCANS.with(|scans| scans.set(scans.get().saturating_add(1)));
        self.lane_order
            .iter()
            .filter_map(|lane_id| self.lanes.get(lane_id))
    }

    /// The lane whose committed answer IS this transcript message, in O(1).
    ///
    /// CQ-04. The room's rebuild asked this question once per transcript row
    /// and answered it by scanning `ordered_lanes` for a lane whose
    /// `message_commit.message_id` matched — while `lane_order` grows by one
    /// lane per agent per turn and nothing ever removes from it. So a reload
    /// cost rows × lanes, and the room took 13.3 s to come back at 8,000 rows
    /// (measured in release; 4× the rows cost 25.9× the time).
    ///
    /// The index this reads was already here, built by `commit_message` and
    /// used only by the hop validator. Exposing it is not a new data structure;
    /// it is the removal of two hand-rolled scans over one that already exists.
    ///
    /// `expect` rather than a second `Option`: `message_lanes` and `lanes` are
    /// written together in `commit_message` and neither is ever removed from,
    /// so a missing lane here is index corruption rather than a caller's
    /// mistake — the same reasoning, and the same wording, as the hop
    /// validator uses on the same index.
    pub fn lane_for_message(&self, message_id: &str) -> Option<&LaneState> {
        self.message_lanes.get(message_id).map(|lane_id| {
            self.lanes
                .get(lane_id)
                .expect("message index references an existing lane")
        })
    }

    pub fn ordered_streams(&self) -> impl Iterator<Item = &RoomStream> {
        self.stream_order
            .iter()
            .filter_map(|stream_id| self.streams.get(stream_id))
    }

    pub fn stream(&self, stream_id: &str) -> Option<&RoomStream> {
        self.streams.get(stream_id)
    }

    pub fn ordered_activity_for_lane(&self, lane_id: &str) -> impl Iterator<Item = &LaneActivity> {
        self.lanes
            .get(lane_id)
            .into_iter()
            .flat_map(|lane| lane.activity.iter())
    }

    pub fn ordered_activity_for_stream(
        &self,
        stream_id: &str,
    ) -> impl Iterator<Item = &LaneActivity> {
        self.streams
            .get(stream_id)
            .and_then(|stream| self.lanes.get(&stream.lane_id))
            .into_iter()
            .flat_map(|lane| lane.activity.iter())
    }

    pub fn permission(&self, ask_id: &str) -> Option<&PermissionState> {
        self.permission_indices
            .get(ask_id)
            .and_then(|index| self.permissions.get(*index))
    }

    pub fn pending_permissions(&self) -> impl Iterator<Item = &PermissionState> {
        self.permissions
            .iter()
            .filter(|permission| permission.outcome.is_none())
    }

    pub fn ordered_permissions(&self) -> impl Iterator<Item = &PermissionState> {
        self.permissions.iter()
    }

    pub fn hop(&self, hop_id: &str) -> Option<&HopState> {
        self.hop_indices
            .get(hop_id)
            .and_then(|index| self.hops.get(*index))
    }

    pub fn ordered_hops(&self) -> impl Iterator<Item = &HopState> {
        self.hops.iter()
    }

    pub fn turn(&self, turn_id: &str) -> Option<&TurnState> {
        self.turn_indices
            .get(turn_id)
            .and_then(|index| self.turns.get(*index))
    }

    pub fn ordered_turns(&self) -> impl Iterator<Item = &TurnState> {
        self.turns.iter()
    }

    /// This turn's SEAT — its position in [`RoomReducer::ordered_turns`] — in
    /// O(1).
    ///
    /// Identical to `ordered_turns().position(|turn| turn.id == turn_id)` by
    /// construction: `accept_turn` writes `turn_indices[id] = turns.len()`
    /// immediately before pushing, and nothing ever removes from `turns`, so
    /// the stored index IS the iteration position for the turn's whole life.
    /// `turn_mut` has always relied on exactly that.
    ///
    /// RP round 2. Slice D's displacement predicate ran that `position` scan
    /// once per OPERATOR transcript row inside a scan that itself ran once per
    /// committed answer — a rows × turns term per commit, and the dominant cost
    /// of a rebuild by a wide margin (500 rows 71 ms, 4,000 rows 23,478 ms,
    /// 8,000 rows 238,567 ms in release).
    pub fn turn_seat(&self, turn_id: &str) -> Option<usize> {
        self.turn_indices.get(turn_id).copied()
    }

    pub fn transcript(&self) -> impl Iterator<Item = &TranscriptEntry> {
        self.transcript.iter()
    }

    /// The transcript as an ORDERED slice, ascending by `event_seq`.
    ///
    /// Same rows as [`RoomReducer::transcript`]; what this adds is random
    /// access and the written promise that the order is real, so a caller may
    /// binary-search instead of scanning. The order is not a convention:
    /// `apply` refuses any event whose sequence is not exactly
    /// `increment_decimal(last_event_seq)`, so a row pushed later cannot carry
    /// an earlier sequence. Pinned by
    /// `the_transcript_is_ascending_by_event_seq_so_a_bounded_scan_is_sound`.
    ///
    /// RP round 2. Slice D's displacement predicate ran once per committed
    /// answer and read the transcript from the beginning every time, which made
    /// a rebuild quadratic in the room's own history — 4,000 rows took 23.5 s in
    /// release. It only ever cared about the window between the turn's first
    /// draw and its commit, and with this it can seek straight to it.
    pub fn transcript_rows(&self) -> &[TranscriptEntry] {
        &self.transcript
    }

    pub fn backend_failures(&self) -> impl Iterator<Item = &BackendFailure> {
        self.backend_failures.iter()
    }

    pub fn room_notices(&self) -> impl Iterator<Item = &RoomNotice> {
        self.room_notices.iter()
    }

    pub fn agent_status(&self, agent: &str) -> Option<&AgentStatusState> {
        self.agent_statuses.get(agent)
    }

    pub fn agent_statuses(&self) -> impl Iterator<Item = &AgentStatusState> {
        self.agent_statuses.values()
    }

    pub fn agent_mode(&self, agent: &str) -> Option<&AgentModeState> {
        self.agent_modes.get(agent)
    }

    pub fn agent_modes(&self) -> impl Iterator<Item = &AgentModeState> {
        self.agent_modes.values()
    }

    fn permission_mut(&mut self, ask_id: &str) -> Option<&mut PermissionState> {
        let index = *self.permission_indices.get(ask_id)?;
        self.permissions.get_mut(index)
    }

    fn turn_mut(&mut self, turn_id: &str) -> Option<&mut TurnState> {
        let index = *self.turn_indices.get(turn_id)?;
        self.turns.get_mut(index)
    }

    /// One turn's lanes, through the `turn_id -> lane ids` index rather than a
    /// filter over every lane in the session.
    ///
    /// Public since 2026-09-02 for the same reason as [`RoomReducer::lane_for_message`],
    /// and found by the same instrument. Removing the two per-row lane scans
    /// CQ-04 named left the count still moving with the transcript: slice D's
    /// relocation asks `turn_first_draw_seq` and `forget_settled_turn` once per
    /// committed answer, and both walked the whole lane list to find the
    /// handful belonging to one turn.
    pub fn turn_lanes(&self, turn_id: &str) -> impl Iterator<Item = &LaneState> {
        self.turn_lane_ids
            .get(turn_id)
            .into_iter()
            .flatten()
            .filter_map(|lane_id| self.lanes.get(lane_id))
    }

    pub fn apply(&mut self, event: &RoomEvent) -> Result<ApplyDelta, ProtocolError> {
        event.validate()?;
        self.ensure_session(&event.session_id)?;
        if let Some(previous) = self.events_by_id.get(&event.event_id) {
            return if previous == event {
                Ok(ApplyDelta::None)
            } else {
                Err(ProtocolError::ConflictingEventId(event.event_id.clone()))
            };
        }
        let expected = increment_decimal(&self.last_event_seq);
        if event.event_seq != expected {
            return Err(ProtocolError::EventGap {
                expected,
                received: event.event_seq.clone(),
            });
        }

        // Every transition validates its complete fallible contract before its
        // first mutation. That validate-then-commit boundary preserves atomic
        // rejection without cloning the complete retained room (including all
        // historical events) for every accepted event.
        let delta = self.apply_transition(event)?;
        self.session_id
            .get_or_insert_with(|| event.session_id.clone());
        self.last_event_seq.clone_from(&event.event_seq);
        self.events_by_id
            .insert(event.event_id.clone(), event.clone());
        Ok(delta)
    }

    fn ensure_session(&self, session_id: &str) -> Result<(), ProtocolError> {
        match &self.session_id {
            Some(bound) if bound != session_id => Err(ProtocolError::SessionMismatch {
                expected: bound.clone(),
                received: session_id.into(),
            }),
            _ => Ok(()),
        }
    }

    fn apply_transition(&mut self, event: &RoomEvent) -> Result<ApplyDelta, ProtocolError> {
        match event.kind.as_str() {
            "turn.accepted" => self.accept_turn(event),
            "route.resolved" => self.resolve_route(event),
            "room.paused" => self.pause_room(),
            "room.resumed" => self.resume_room(),
            "lane.queued" => self.queue_lane(event),
            "lane.started" => self.start_lane(event),
            "lane.activity" => self.record_activity(event),
            "lane.chunk" => self.append_chunk(event),
            "lane.cancelling" => self.begin_cancellation(event),
            "message.committed" => self.commit_message(event),
            "lane.completed" => self.complete_lane(event),
            "lane.failed" => self.fail_lane(event),
            "lane.cancelled" => self.cancel_lane(event),
            "agent.status" => self.record_agent_status(event),
            "agent.mode" => self.record_agent_mode(event),
            "permission.requested" => self.request_permission(event),
            "permission.resolved" => self.resolve_permission(event),
            "hop.dispatched" => self.record_hop(event, HopDisposition::Dispatched),
            "hop.blocked" => self.record_hop(event, HopDisposition::Blocked),
            "turn.completed" => self.complete_turn(event),
            "backend.failed" => self.record_backend_failure(event),
            "room.notice" => self.record_room_notice(event),
            _ => Ok(ApplyDelta::None),
        }
    }

    fn pause_room(&mut self) -> Result<ApplyDelta, ProtocolError> {
        if self.paused {
            return Err(invalid("room.paused requires an unpaused room"));
        }
        self.paused = true;
        Ok(ApplyDelta::None)
    }

    fn resume_room(&mut self) -> Result<ApplyDelta, ProtocolError> {
        if !self.paused {
            return Err(invalid("room.resumed requires a paused room"));
        }
        self.paused = false;
        Ok(ApplyDelta::None)
    }

    fn accept_turn(&mut self, event: &RoomEvent) -> Result<ApplyDelta, ProtocolError> {
        let payload = payload(event)?;
        require_exact_fields(
            payload,
            event.kind.as_str(),
            &["agents", "text", "messageId", "ledgerSeq"],
        )?;
        let agents = unique_agents(payload, "agents", event.kind.as_str())?;
        let text = required_text(payload, "text", event.kind.as_str())?;
        let message_id = required_string(payload, "messageId", event.kind.as_str())?;
        let ledger_seq = required_decimal(payload, "ledgerSeq", event.kind.as_str())?;
        if self.turn(&event.turn_id).is_some() {
            return Err(invalid("turn.accepted requires a unique turnId"));
        }
        if self.transcript_message_ids.contains(&message_id) {
            return Err(invalid("turn.accepted messageId is already indexed"));
        }
        self.transcript_message_ids.insert(message_id.clone());
        self.transcript.push(TranscriptEntry {
            event_seq: event.event_seq.clone(),
            occurred_at: event.occurred_at.clone(),
            turn_id: event.turn_id.clone(),
            message_id: message_id.clone(),
            text: text.clone(),
            ledger_seq: ledger_seq.clone(),
            author: TranscriptAuthor::Operator,
            target_agents: agents.clone(),
            reply_to: None,
            origin: LaneOrigin::Operator,
        });
        let turn_index = self.turns.len();
        self.turn_indices.insert(event.turn_id.clone(), turn_index);
        self.turns.push(TurnState {
            id: event.turn_id.clone(),
            agents,
            text,
            message_id,
            ledger_seq,
            accepted_at: event.occurred_at.clone(),
            route: None,
            completed_at: None,
        });
        Ok(ApplyDelta::None)
    }

    fn resolve_route(&mut self, event: &RoomEvent) -> Result<ApplyDelta, ProtocolError> {
        let payload = payload(event)?;
        require_exact_fields(payload, event.kind.as_str(), &["agents"])?;
        let agents = unique_agents(payload, "agents", event.kind.as_str())?;
        let turn = self
            .turn(&event.turn_id)
            .ok_or_else(|| invalid("route.resolved requires an accepted turn"))?;
        if turn.agents != agents {
            return Err(invalid("route.resolved agents do not match turn.accepted"));
        }
        let turn = self
            .turn_mut(&event.turn_id)
            .expect("validated turn exists");
        if turn.route.is_some() {
            return Err(invalid("route.resolved is single-use per turn"));
        }
        turn.route = Some(RouteState {
            agents,
            resolved_at: event.occurred_at.clone(),
        });
        Ok(ApplyDelta::None)
    }

    fn queue_lane(&mut self, event: &RoomEvent) -> Result<ApplyDelta, ProtocolError> {
        let payload = payload(event)?;
        let lane_id = required_string(payload, "laneId", event.kind.as_str())?;
        let agent = required_agent(payload, event.kind.as_str())?;
        let expected_message_id =
            required_string(payload, "expectedMessageId", event.kind.as_str())?;
        let provenance = queue_provenance(payload, event.kind.as_str())?;
        let turn = self
            .turn(&event.turn_id)
            .ok_or_else(|| invalid("lane.queued requires an accepted turn"))?;
        let route = turn
            .route
            .as_ref()
            .ok_or_else(|| invalid("lane.queued requires a resolved route"))?;
        if self.lanes.contains_key(&lane_id) {
            return Err(invalid("lane.queued requires a unique laneId"));
        }
        if provenance.origin == LaneOrigin::Operator {
            if !route.agents.iter().any(|target| target == &agent) {
                return Err(invalid("operator lane.queued agent is not a route target"));
            }
            if provenance
                .parent_message_id
                .as_deref()
                .is_some_and(|parent| parent != turn.message_id)
            {
                return Err(invalid(
                    "operator lane.queued parentMessageId does not match turn.accepted",
                ));
            }
            if self
                .turn_lanes(&event.turn_id)
                .any(|lane| lane.origin == LaneOrigin::Operator && lane.agent == agent)
            {
                return Err(invalid("turn requires one operator lane per routed agent"));
            }
        } else {
            if provenance.reply_to != provenance.parent_message_id {
                return Err(invalid(
                    "agent lane.queued replyTo does not match parentMessageId",
                ));
            }
            let hop = self
                .hop(
                    provenance
                        .hop_id
                        .as_deref()
                        .expect("agent provenance hop id"),
                )
                .ok_or_else(|| invalid("agent lane.queued has no dispatched hop"))?;
            if hop.disposition != HopDisposition::Dispatched
                || hop.turn_id != event.turn_id
                || hop.from_agent != provenance.from_agent.as_deref().expect("agent provenance")
                || hop.to_agent != agent
                || hop.parent_message_id
                    != provenance
                        .parent_message_id
                        .as_deref()
                        .expect("agent provenance")
                || hop.hop_index != provenance.hop_index
            {
                return Err(invalid(
                    "agent lane.queued provenance does not match dispatched hop",
                ));
            }
        }
        self.lanes.insert(
            lane_id.clone(),
            LaneState {
                id: lane_id.clone(),
                turn_id: event.turn_id.clone(),
                agent,
                expected_message_id,
                origin: provenance.origin,
                hop_index: provenance.hop_index,
                parent_message_id: provenance.parent_message_id,
                reply_to: provenance.reply_to,
                from_agent: provenance.from_agent,
                hop_id: provenance.hop_id,
                phase: LanePhase::Queued,
                // Read before the push below, so the first lane of a session
                // is 0 and the value equals this lane's index in `lane_order`
                // for its whole life. Nothing removes from `lane_order`, so
                // the two never drift.
                roster_index: self.lane_order.len() as u64,
                queued_at: event.occurred_at.clone(),
                started_at: None,
                terminal_at: None,
                terminal_event_seq: None,
                failure_reason: None,
                stream_id: None,
                message_commit: None,
                activity: Vec::new(),
            },
        );
        self.turn_lane_ids
            .entry(event.turn_id.clone())
            .or_default()
            .push(lane_id.clone());
        self.lane_order.push(lane_id);
        Ok(ApplyDelta::None)
    }

    fn start_lane(&mut self, event: &RoomEvent) -> Result<ApplyDelta, ProtocolError> {
        let payload = payload(event)?;
        let lane_id = required_string(payload, "laneId", event.kind.as_str())?;
        let stream_id = required_string(payload, "streamId", event.kind.as_str())?;
        let model_id = optional_string(payload, "modelId", event.kind.as_str())?;
        if self.match_lane(event, payload, &lane_id)?.phase != LanePhase::Queued {
            return Err(invalid("lane.started requires a queued lane"));
        }
        if self.streams.contains_key(&stream_id) {
            return Err(invalid("lane.started requires a unique streamId"));
        }
        let (agent, turn_id) = {
            let lane = self.lanes.get_mut(&lane_id).expect("validated lane exists");
            lane.phase = LanePhase::Running;
            lane.started_at = Some(event.occurred_at.clone());
            lane.stream_id = Some(stream_id.clone());
            (lane.agent.clone(), lane.turn_id.clone())
        };
        self.stream_order.push(stream_id.clone());
        self.streams.insert(
            stream_id.clone(),
            RoomStream {
                id: stream_id.clone(),
                lane_id,
                agent,
                turn_id,
                started_event_seq: event.event_seq.clone(),
                started_at: event.occurred_at.clone(),
                model_id,
                text: String::new(),
                next_chunk_index: 0,
                next_stream_seq: "1".into(),
            },
        );
        Ok(ApplyDelta::Started { stream_id })
    }

    fn record_activity(&mut self, event: &RoomEvent) -> Result<ApplyDelta, ProtocolError> {
        let payload = payload(event)?;
        let lane_id = required_string(payload, "laneId", event.kind.as_str())?;
        let stream_id = required_string(payload, "streamId", event.kind.as_str())?;
        let tool_call_id = required_string(payload, "toolCallId", event.kind.as_str())?;
        let update = activity_update(payload, event.kind.as_str())?;
        let title = optional_string(payload, "title", event.kind.as_str())?;
        let kind = optional_string(payload, "kind", event.kind.as_str())?;
        let status = optional_string(payload, "status", event.kind.as_str())?;
        let lane = self.match_lane(event, payload, &lane_id)?;
        if !matches!(lane.phase, LanePhase::Running | LanePhase::Cancelling) {
            return Err(invalid(
                "lane.activity requires a running or cancelling lane",
            ));
        }
        if lane.stream_id.as_deref() != Some(stream_id.as_str()) {
            return Err(invalid("lane.activity streamId does not match lane"));
        }
        let lane = self.lanes.get_mut(&lane_id).expect("validated lane exists");
        if let Some(activity) = lane
            .activity
            .iter_mut()
            .find(|activity| activity.tool_call_id == tool_call_id)
        {
            activity.last_event_seq.clone_from(&event.event_seq);
            activity.update = update;
            if title.is_some() {
                activity.title = title;
            }
            if kind.is_some() {
                activity.kind = kind;
            }
            if status.is_some() {
                activity.status = status;
            }
        } else {
            lane.activity.push(LaneActivity {
                last_event_seq: event.event_seq.clone(),
                tool_call_id,
                update,
                title,
                kind,
                status,
            });
        }
        Ok(ApplyDelta::None)
    }

    fn append_chunk(&mut self, event: &RoomEvent) -> Result<ApplyDelta, ProtocolError> {
        let payload = payload(event)?;
        let lane_id = required_string(payload, "laneId", event.kind.as_str())?;
        let stream_id = required_string(payload, "streamId", event.kind.as_str())?;
        let text = required_text(payload, "text", event.kind.as_str())?;
        let stream_seq = required_string(payload, "streamSeq", event.kind.as_str())?;
        let model_id = optional_string(payload, "modelId", event.kind.as_str())?;
        let chunk_index = payload
            .get("chunkIndex")
            .and_then(Value::as_u64)
            .ok_or_else(|| invalid("lane.chunk requires nonnegative chunkIndex"))?;
        let lane = self.match_lane(event, payload, &lane_id)?;
        if !matches!(lane.phase, LanePhase::Running | LanePhase::Cancelling) {
            return Err(invalid("lane.chunk requires a running or cancelling lane"));
        }
        if lane.stream_id.as_deref() != Some(stream_id.as_str()) {
            return Err(invalid("lane.chunk streamId does not match lane"));
        }
        let stream = self
            .streams
            .get_mut(&stream_id)
            .ok_or_else(|| invalid("lane.chunk has no started stream"))?;
        if stream.lane_id != lane_id {
            return Err(invalid("lane.chunk stream does not belong to lane"));
        }
        if stream.next_chunk_index != chunk_index {
            return Err(invalid("lane.chunk chunkIndex is not the next cursor"));
        }
        if stream.next_stream_seq != stream_seq {
            return Err(ProtocolError::StreamGap {
                stream_id,
                expected: stream.next_stream_seq.clone(),
                received: stream_seq,
            });
        }
        if let Some(model_id) = model_id {
            match &stream.model_id {
                Some(observed) if observed != &model_id => {
                    return Err(invalid(
                        "lane.chunk modelId conflicts with observed stream model",
                    ));
                }
                Some(_) => {}
                None => stream.model_id = Some(model_id),
            }
        }
        stream.text.push_str(&text);
        stream.next_chunk_index += 1;
        stream.next_stream_seq = increment_decimal(&stream.next_stream_seq);
        Ok(ApplyDelta::Changed {
            stream_id: stream.id.clone(),
        })
    }

    fn begin_cancellation(&mut self, event: &RoomEvent) -> Result<ApplyDelta, ProtocolError> {
        let payload = payload(event)?;
        let lane_id = required_string(payload, "laneId", event.kind.as_str())?;
        if !matches!(
            self.match_lane(event, payload, &lane_id)?.phase,
            LanePhase::Running | LanePhase::Cancelling
        ) {
            return Err(invalid(
                "lane.cancelling requires a running or cancelling lane",
            ));
        }
        let lane = self.lanes.get_mut(&lane_id).expect("validated lane exists");
        lane.phase = LanePhase::Cancelling;
        Ok(ApplyDelta::None)
    }

    fn request_permission(&mut self, event: &RoomEvent) -> Result<ApplyDelta, ProtocolError> {
        let payload = payload(event)?;
        let ask_id = required_string(payload, "askId", event.kind.as_str())?;
        let agent = required_agent(payload, event.kind.as_str())?;
        let options = permission_options(payload, event.kind.as_str())?;
        self.match_permission_lane(event, &agent)?;
        if self.permission_indices.contains_key(&ask_id) {
            return Err(invalid("permission.requested requires a unique askId"));
        }
        let permission = PermissionState {
            requested_event_seq: event.event_seq.clone(),
            requested_at: event.occurred_at.clone(),
            resolved_event_seq: None,
            resolved_at: None,
            ask_id: ask_id.clone(),
            turn_id: event.turn_id.clone(),
            agent,
            options,
            tool_title: optional_string(payload, "toolTitle", event.kind.as_str())?,
            outcome: None,
            option_id: None,
        };
        let permission_index = self.permissions.len();
        self.permission_indices.insert(ask_id, permission_index);
        self.permissions.push(permission);
        Ok(ApplyDelta::None)
    }

    fn record_agent_status(&mut self, event: &RoomEvent) -> Result<ApplyDelta, ProtocolError> {
        let payload = payload(event)?;
        let agent = required_agent(payload, event.kind.as_str())?;
        let auth = optional_agent_auth(payload, event.kind.as_str())?;
        let usage = optional_agent_usage(payload, event.kind.as_str())?;
        let availability = optional_agent_availability(payload, event.kind.as_str())?;
        if auth.is_none() && usage.is_none() && availability.is_none() {
            return Err(invalid("agent.status requires status data"));
        }
        let prior = self.agent_statuses.get(&agent);
        let mut merged_auth = auth.or_else(|| prior.and_then(|state| state.auth));
        let merged_usage = usage.or_else(|| prior.and_then(|state| state.usage.clone()));
        if merged_usage.as_ref().is_some_and(|usage| usage.exhausted)
            && merged_auth == Some(AgentAuthState::Ready)
        {
            merged_auth = Some(AgentAuthState::Limited);
        }
        let (merged_availability, availability_resets_at_ms) = match availability {
            Some((state, resets_at_ms)) => (Some(state), resets_at_ms),
            None => (
                prior.and_then(|state| state.availability),
                prior.and_then(|state| state.availability_resets_at_ms),
            ),
        };
        self.agent_statuses.insert(
            agent.clone(),
            AgentStatusState {
                agent,
                last_event_seq: event.event_seq.clone(),
                occurred_at: event.occurred_at.clone(),
                auth: merged_auth,
                usage: merged_usage,
                availability: merged_availability,
                availability_resets_at_ms,
            },
        );
        Ok(ApplyDelta::None)
    }

    fn record_agent_mode(&mut self, event: &RoomEvent) -> Result<ApplyDelta, ProtocolError> {
        let payload = payload(event)?;
        require_allowed_fields(
            payload,
            event.kind.as_str(),
            &[
                "agent",
                "modeId",
                "word",
                "status",
                "error",
                "availableModeIds",
            ],
        )?;
        let agent = required_agent(payload, event.kind.as_str())?;
        let mode_id = required_string(payload, "modeId", event.kind.as_str())?;
        let status = match required_string(payload, "status", event.kind.as_str())?.as_str() {
            "active" => AgentModeStatus::Active,
            "pending" => AgentModeStatus::Pending,
            "failed" => AgentModeStatus::Failed,
            _ => return Err(invalid("agent.mode status is invalid")),
        };
        let word = optional_string(payload, "word", event.kind.as_str())?;
        let error = optional_string(payload, "error", event.kind.as_str())?;
        let available_mode_ids = match payload.get("availableModeIds") {
            None => None,
            Some(Value::Array(values)) => Some(
                values
                    .iter()
                    .map(|value| {
                        value
                            .as_str()
                            .filter(|value| !value.is_empty())
                            .map(str::to_owned)
                            .ok_or_else(|| invalid("agent.mode availableModeIds is invalid"))
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            ),
            Some(_) => return Err(invalid("agent.mode availableModeIds is invalid")),
        };
        self.agent_modes.insert(
            agent.clone(),
            AgentModeState {
                agent,
                mode_id,
                word,
                status,
                error,
                available_mode_ids,
                last_event_seq: event.event_seq.clone(),
                occurred_at: event.occurred_at.clone(),
            },
        );
        Ok(ApplyDelta::None)
    }

    fn resolve_permission(&mut self, event: &RoomEvent) -> Result<ApplyDelta, ProtocolError> {
        let payload = payload(event)?;
        let ask_id = required_string(payload, "askId", event.kind.as_str())?;
        let agent = required_agent(payload, event.kind.as_str())?;
        let outcome = permission_outcome(payload, event.kind.as_str())?;
        let option_id = optional_string(payload, "optionId", event.kind.as_str())?;
        let permission = self
            .permission_mut(&ask_id)
            .ok_or_else(|| invalid("permission.resolved has no pending askId"))?;
        if permission.outcome.is_some() {
            return Err(invalid("permission.resolved requires a pending askId"));
        }
        if permission.turn_id != event.turn_id || permission.agent != agent {
            return Err(invalid(
                "permission.resolved identity does not match request",
            ));
        }
        if option_id.as_ref().is_some_and(|selected| {
            !permission
                .options
                .iter()
                .any(|option| option.option_id == *selected)
        }) {
            return Err(invalid(
                "permission.resolved optionId was not offered by the request",
            ));
        }
        permission.outcome = Some(outcome);
        permission.option_id = option_id;
        permission.resolved_event_seq = Some(event.event_seq.clone());
        permission.resolved_at = Some(event.occurred_at.clone());
        Ok(ApplyDelta::None)
    }

    fn commit_message(&mut self, event: &RoomEvent) -> Result<ApplyDelta, ProtocolError> {
        let payload = payload(event)?;
        let lane_id = required_string(payload, "laneId", event.kind.as_str())?;
        let message_id = required_string(payload, "messageId", event.kind.as_str())?;
        let text = required_text(payload, "text", event.kind.as_str())?;
        let ledger_seq = required_decimal(payload, "ledgerSeq", event.kind.as_str())?;
        let origin = lane_origin(payload, event.kind.as_str())?;
        let hop_index = required_u64(payload, "hopIndex", event.kind.as_str())?;
        let reply_to = optional_string(payload, "replyTo", event.kind.as_str())?;
        let lane = self.match_lane(event, payload, &lane_id)?;
        if !matches!(
            lane.phase,
            LanePhase::Queued | LanePhase::Running | LanePhase::Cancelling
        ) {
            return Err(invalid(
                "message.committed requires a queued, running, or cancelling lane",
            ));
        }
        if message_id != lane.expected_message_id {
            return Err(invalid(
                "message.committed messageId does not match expectedMessageId",
            ));
        }
        if origin != lane.origin || hop_index != lane.hop_index {
            return Err(invalid(
                "message.committed origin or hopIndex does not match lane",
            ));
        }
        if reply_to != lane.reply_to {
            return Err(invalid("message.committed replyTo does not match lane"));
        }
        if self.transcript_message_ids.contains(&message_id) {
            return Err(invalid("message.committed messageId is already indexed"));
        }
        let stream_id = lane.stream_id.clone();
        if let Some(stream_id) = &stream_id {
            let stream = self
                .streams
                .get_mut(stream_id)
                .ok_or_else(|| invalid("message.committed lane stream is missing"))?;
            stream.text.clone_from(&text);
        }
        let lane = self.lanes.get_mut(&lane_id).expect("validated lane exists");
        lane.message_commit = Some(MessageCommit {
            message_id: message_id.clone(),
            text: text.clone(),
            ledger_seq: ledger_seq.clone(),
        });
        lane.phase = LanePhase::Committed;
        self.message_lanes.insert(message_id.clone(), lane_id);
        self.transcript_message_ids.insert(message_id.clone());
        self.transcript.push(TranscriptEntry {
            event_seq: event.event_seq.clone(),
            occurred_at: event.occurred_at.clone(),
            turn_id: event.turn_id.clone(),
            message_id,
            text,
            ledger_seq,
            author: TranscriptAuthor::Agent(lane.agent.clone()),
            target_agents: Vec::new(),
            reply_to: lane.reply_to.clone(),
            origin: lane.origin.clone(),
        });
        Ok(ApplyDelta::None)
    }

    fn record_hop(
        &mut self,
        event: &RoomEvent,
        disposition: HopDisposition,
    ) -> Result<ApplyDelta, ProtocolError> {
        let payload = payload(event)?;
        let hop_id = required_string(payload, "hopId", event.kind.as_str())?;
        let from_agent = required_agent_field(payload, "fromAgent", event.kind.as_str())?;
        let to_agent = required_agent_field(payload, "toAgent", event.kind.as_str())?;
        let parent_message_id = required_string(payload, "parentMessageId", event.kind.as_str())?;
        let hop_index = required_u64(payload, "hopIndex", event.kind.as_str())?;
        let hop_budget = if payload.contains_key("maxHop") {
            required_u64(payload, "maxHop", event.kind.as_str())?
        } else {
            required_u64(payload, "hopBudget", event.kind.as_str())?
        };
        let text = optional_string(payload, "text", event.kind.as_str())?;
        if hop_budget == 0 {
            return Err(invalid("hop event requires a positive hopBudget"));
        }
        if self.hop(&hop_id).is_some() {
            return Err(invalid("hop event requires a unique hopId"));
        }
        let parent_lane_id = self
            .message_lanes
            .get(&parent_message_id)
            .ok_or_else(|| invalid("hop event parentMessageId has no committed lane"))?;
        let parent_lane = self
            .lanes
            .get(parent_lane_id)
            .expect("message index references an existing lane");
        if parent_lane.turn_id != event.turn_id || parent_lane.agent != from_agent {
            return Err(invalid("hop event parent does not match turn or fromAgent"));
        }
        if hop_index != parent_lane.hop_index + 1 {
            return Err(invalid("hop event hopIndex does not follow parent lane"));
        }
        match disposition {
            HopDisposition::Dispatched if hop_index > hop_budget => {
                return Err(invalid("hop.dispatched exceeds hopBudget"));
            }
            HopDisposition::Blocked if hop_index <= hop_budget => {
                return Err(invalid("hop.blocked must exceed hopBudget"));
            }
            _ => {}
        }
        let hop = HopState {
            event_seq: event.event_seq.clone(),
            occurred_at: event.occurred_at.clone(),
            hop_id: hop_id.clone(),
            turn_id: event.turn_id.clone(),
            from_agent,
            to_agent,
            parent_message_id,
            hop_index,
            hop_budget,
            text,
            disposition,
        };
        let hop_index = self.hops.len();
        self.hop_indices.insert(hop_id, hop_index);
        self.hops.push(hop);
        Ok(ApplyDelta::None)
    }

    fn complete_lane(&mut self, event: &RoomEvent) -> Result<ApplyDelta, ProtocolError> {
        let lane_id = self.validate_terminal_identity(event)?;
        let lane = self.lanes.get_mut(&lane_id).expect("validated lane exists");
        if lane.phase != LanePhase::Committed {
            return Err(invalid("lane.completed requires a committed lane"));
        }
        lane.phase = LanePhase::Completed;
        lane.terminal_at = Some(event.occurred_at.clone());
        lane.terminal_event_seq = Some(event.event_seq.clone());
        Ok(ApplyDelta::None)
    }

    fn fail_lane(&mut self, event: &RoomEvent) -> Result<ApplyDelta, ProtocolError> {
        let payload = payload(event)?;
        require_allowed_fields(
            payload,
            event.kind.as_str(),
            &["laneId", "streamId", "agent", "error", "recovered"],
        )?;
        let failure_reason = optional_string(payload, "error", event.kind.as_str())?;
        let recovered = match payload.get("recovered") {
            None => false,
            Some(Value::Bool(true)) => true,
            Some(_) => return Err(invalid("lane.failed recovered must be true when present")),
        };
        let lane_id = self.validate_terminal_identity(event)?;
        let lane = self.lanes.get_mut(&lane_id).expect("validated lane exists");
        if !matches!(lane.phase, LanePhase::Running | LanePhase::Cancelling)
            && !(recovered && lane.phase == LanePhase::Queued)
        {
            return Err(invalid(
                "lane.failed requires a running/cancelling lane or a recovered queued lane",
            ));
        }
        lane.phase = LanePhase::Failed;
        lane.terminal_at = Some(event.occurred_at.clone());
        lane.terminal_event_seq = Some(event.event_seq.clone());
        lane.failure_reason = failure_reason;
        Ok(ApplyDelta::None)
    }

    fn cancel_lane(&mut self, event: &RoomEvent) -> Result<ApplyDelta, ProtocolError> {
        let lane_id = self.validate_terminal_identity(event)?;
        let lane = self.lanes.get_mut(&lane_id).expect("validated lane exists");
        if !matches!(
            lane.phase,
            LanePhase::Queued | LanePhase::Running | LanePhase::Cancelling
        ) {
            return Err(invalid(
                "lane.cancelled requires a queued, running, or cancelling lane",
            ));
        }
        lane.phase = LanePhase::Cancelled;
        lane.terminal_at = Some(event.occurred_at.clone());
        lane.terminal_event_seq = Some(event.event_seq.clone());
        Ok(ApplyDelta::None)
    }

    fn complete_turn(&mut self, event: &RoomEvent) -> Result<ApplyDelta, ProtocolError> {
        let payload = payload(event)?;
        let recovered = match payload.get("recovered") {
            None if payload.is_empty() => false,
            Some(Value::Bool(true)) if payload.len() == 1 => true,
            _ => {
                return Err(invalid(
                    "turn.completed payload must be {} or {recovered:true}",
                ));
            }
        };
        let turn = self
            .turn(&event.turn_id)
            .ok_or_else(|| invalid("turn.completed requires an accepted turn"))?;
        let route = turn
            .route
            .as_ref()
            .ok_or_else(|| invalid("turn.completed requires a resolved route"))?;
        if turn.completed_at.is_some() {
            return Err(invalid("turn.completed is single-use per turn"));
        }
        let root_agents = self
            .turn_lanes(&event.turn_id)
            .filter(|lane| lane.origin == LaneOrigin::Operator)
            .map(|lane| lane.agent.as_str())
            .collect::<Vec<_>>();
        if route.agents.is_empty()
            || route.agents.len() != root_agents.len()
            || route.agents.iter().any(|agent| {
                root_agents
                    .iter()
                    .filter(|candidate| **candidate == agent)
                    .count()
                    != 1
            })
        {
            return Err(invalid(
                "turn.completed requires exactly one root lane for every routed agent",
            ));
        }
        if self.turn_lanes(&event.turn_id).any(|lane| {
            !matches!(
                lane.phase,
                LanePhase::Completed | LanePhase::Failed | LanePhase::Cancelled
            )
        }) {
            return Err(invalid(
                "turn.completed requires every turn lane to be terminal",
            ));
        }
        let turn = self
            .turn_mut(&event.turn_id)
            .expect("validated turn exists");
        turn.completed_at = Some(event.occurred_at.clone());
        let _ = recovered;
        Ok(ApplyDelta::None)
    }

    fn record_backend_failure(&mut self, event: &RoomEvent) -> Result<ApplyDelta, ProtocolError> {
        let payload = payload(event)?;
        require_allowed_fields(payload, event.kind.as_str(), &["message", "error"])?;
        let message = optional_string(payload, "message", event.kind.as_str())?;
        let error = optional_string(payload, "error", event.kind.as_str())?;
        self.backend_failures.push(BackendFailure {
            event_seq: event.event_seq.clone(),
            turn_id: event.turn_id.clone(),
            occurred_at: event.occurred_at.clone(),
            message,
            error,
        });
        Ok(ApplyDelta::None)
    }

    /// Retains one announced condition, dropping `detail` on the floor by design.
    ///
    /// The payload's `detail` is already validated by `RoomEvent::validate`, so refusing to COPY it
    /// here loses no safety and buys the guarantee the render layer cannot break: there is no path
    /// from a notice's diagnostic text to a frame, because the view never receives the text. See
    /// `RoomNotice` in state.rs.
    fn record_room_notice(&mut self, event: &RoomEvent) -> Result<ApplyDelta, ProtocolError> {
        let payload = payload(event)?;
        require_allowed_fields(payload, event.kind.as_str(), &["cause", "agent", "detail"])?;
        let cause = required_string(payload, "cause", event.kind.as_str())?;
        let agent = optional_string(payload, "agent", event.kind.as_str())?;
        self.room_notices.push(RoomNotice {
            event_seq: event.event_seq.clone(),
            turn_id: event.turn_id.clone(),
            occurred_at: event.occurred_at.clone(),
            cause,
            agent,
        });
        Ok(ApplyDelta::None)
    }

    fn validate_terminal_identity(&self, event: &RoomEvent) -> Result<String, ProtocolError> {
        let payload = payload(event)?;
        let lane_id = required_string(payload, "laneId", event.kind.as_str())?;
        let lane = self.match_lane(event, payload, &lane_id)?;
        match lane.stream_id.as_deref() {
            Some(expected_stream_id) => {
                let actual_stream_id = required_string(payload, "streamId", event.kind.as_str())?;
                if actual_stream_id != expected_stream_id {
                    return Err(invalid("terminal lane streamId does not match lane"));
                }
            }
            None => {}
        }
        Ok(lane_id)
    }

    fn match_lane<'a>(
        &'a self,
        event: &RoomEvent,
        payload: &Map<String, Value>,
        lane_id: &str,
    ) -> Result<&'a LaneState, ProtocolError> {
        let agent = required_agent(payload, event.kind.as_str())?;
        let lane = self
            .lanes
            .get(lane_id)
            .ok_or_else(|| invalid("lane event has no queued lane"))?;
        if lane.turn_id != event.turn_id || lane.agent != agent {
            return Err(invalid("lane event identity does not match queued lane"));
        }
        Ok(lane)
    }

    fn match_permission_lane(&self, event: &RoomEvent, agent: &str) -> Result<(), ProtocolError> {
        let matches = self
            .turn_lanes(&event.turn_id)
            .filter(|lane| {
                lane.agent == agent
                    && matches!(lane.phase, LanePhase::Running | LanePhase::Cancelling)
            })
            .count();
        if matches != 1 {
            return Err(invalid(
                "permission.requested requires exactly one matching running or cancelling lane",
            ));
        }
        Ok(())
    }
}

fn payload(event: &RoomEvent) -> Result<&Map<String, Value>, ProtocolError> {
    event
        .payload
        .as_object()
        .ok_or_else(|| invalid("room event payload must be an object"))
}

fn required_agent(payload: &Map<String, Value>, kind: &str) -> Result<String, ProtocolError> {
    match required_string(payload, "agent", kind)?.as_str() {
        "claude" | "codex" | "gemini" => Ok(required_string(payload, "agent", kind)?),
        _ => Err(invalid("lane event requires a supported agent")),
    }
}

fn required_agent_field(
    payload: &Map<String, Value>,
    field: &str,
    kind: &str,
) -> Result<String, ProtocolError> {
    match required_string(payload, field, kind)?.as_str() {
        "claude" | "codex" | "gemini" => required_string(payload, field, kind),
        _ => Err(invalid(format!("{kind} requires a supported {field}"))),
    }
}

fn required_string(
    payload: &Map<String, Value>,
    field: &str,
    kind: &str,
) -> Result<String, ProtocolError> {
    payload
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| invalid(format!("{kind} requires {field}")))
}

fn required_text(
    payload: &Map<String, Value>,
    field: &str,
    kind: &str,
) -> Result<String, ProtocolError> {
    payload
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| invalid(format!("{kind} requires {field}")))
}

fn required_decimal(
    payload: &Map<String, Value>,
    field: &str,
    kind: &str,
) -> Result<String, ProtocolError> {
    let value = required_string(payload, field, kind)?;
    validate_decimal(&value)?;
    Ok(value)
}

fn unique_agents(
    payload: &Map<String, Value>,
    field: &str,
    kind: &str,
) -> Result<Vec<String>, ProtocolError> {
    let agents = payload
        .get(field)
        .and_then(Value::as_array)
        .filter(|agents| !agents.is_empty())
        .ok_or_else(|| invalid(format!("{kind} requires a nonempty {field} array")))?;
    let mut seen = HashSet::new();
    agents
        .iter()
        .map(|agent| {
            let agent = agent
                .as_str()
                .filter(|agent| matches!(*agent, "claude" | "codex" | "gemini"))
                .ok_or_else(|| invalid(format!("{kind} requires supported agents")))?
                .to_owned();
            if !seen.insert(agent.clone()) {
                return Err(invalid(format!("{kind} agents must be unique")));
            }
            Ok(agent)
        })
        .collect()
}

fn require_exact_fields(
    payload: &Map<String, Value>,
    kind: &str,
    fields: &[&str],
) -> Result<(), ProtocolError> {
    require_allowed_fields(payload, kind, fields)?;
    if payload.len() != fields.len() {
        return Err(invalid(format!("{kind} payload has missing fields")));
    }
    Ok(())
}

fn require_allowed_fields(
    payload: &Map<String, Value>,
    kind: &str,
    fields: &[&str],
) -> Result<(), ProtocolError> {
    if payload
        .keys()
        .any(|field| !fields.contains(&field.as_str()))
    {
        return Err(invalid(format!("{kind} payload has unknown fields")));
    }
    Ok(())
}

fn optional_string(
    payload: &Map<String, Value>,
    field: &str,
    kind: &str,
) -> Result<Option<String>, ProtocolError> {
    match payload.get(field) {
        None => Ok(None),
        Some(Value::String(value)) if !value.is_empty() => Ok(Some(value.clone())),
        Some(_) => Err(invalid(format!(
            "{kind} {field} must be a nonempty string when present"
        ))),
    }
}

fn required_u64(
    payload: &Map<String, Value>,
    field: &str,
    kind: &str,
) -> Result<u64, ProtocolError> {
    payload
        .get(field)
        .and_then(Value::as_u64)
        .ok_or_else(|| invalid(format!("{kind} requires nonnegative {field}")))
}

fn lane_origin(payload: &Map<String, Value>, kind: &str) -> Result<LaneOrigin, ProtocolError> {
    match required_string(payload, "origin", kind)?.as_str() {
        "operator" => Ok(LaneOrigin::Operator),
        "agent" => Ok(LaneOrigin::Agent),
        _ => Err(invalid("lane origin must be operator or agent")),
    }
}

struct LaneProvenance {
    origin: LaneOrigin,
    hop_index: u64,
    parent_message_id: Option<String>,
    reply_to: Option<String>,
    from_agent: Option<String>,
    hop_id: Option<String>,
}

fn queue_provenance(
    payload: &Map<String, Value>,
    kind: &str,
) -> Result<LaneProvenance, ProtocolError> {
    let origin = lane_origin(payload, kind)?;
    let hop_index = required_u64(payload, "hopIndex", kind)?;
    match origin {
        LaneOrigin::Operator => {
            if hop_index != 0 {
                return Err(invalid("operator lane.queued requires hopIndex 0"));
            }
            for field in ["replyTo", "fromAgent", "hopId"] {
                if payload.contains_key(field) {
                    return Err(invalid(format!(
                        "operator lane.queued must not contain {field}"
                    )));
                }
            }
            Ok(LaneProvenance {
                origin,
                hop_index,
                parent_message_id: optional_string(payload, "parentMessageId", kind)?,
                reply_to: None,
                from_agent: None,
                hop_id: None,
            })
        }
        LaneOrigin::Agent => {
            if hop_index == 0 {
                return Err(invalid("agent lane.queued requires positive hopIndex"));
            }
            Ok(LaneProvenance {
                origin,
                hop_index,
                reply_to: Some(required_string(payload, "replyTo", kind)?),
                from_agent: Some(required_agent_field(payload, "fromAgent", kind)?),
                parent_message_id: Some(required_string(payload, "parentMessageId", kind)?),
                hop_id: Some(required_string(payload, "hopId", kind)?),
            })
        }
    }
}

fn activity_update(
    payload: &Map<String, Value>,
    kind: &str,
) -> Result<LaneActivityUpdate, ProtocolError> {
    match required_string(payload, "update", kind)?.as_str() {
        "tool_call" => Ok(LaneActivityUpdate::ToolCall),
        "tool_call_update" => Ok(LaneActivityUpdate::ToolCallUpdate),
        _ => Err(invalid(
            "lane.activity update must be tool_call or tool_call_update",
        )),
    }
}

fn optional_agent_auth(
    payload: &Map<String, Value>,
    kind: &str,
) -> Result<Option<AgentAuthState>, ProtocolError> {
    match payload.get("auth") {
        None => Ok(None),
        Some(Value::String(value)) => match value.as_str() {
            "ready" => Ok(Some(AgentAuthState::Ready)),
            "limited" => Ok(Some(AgentAuthState::Limited)),
            "down" => Ok(Some(AgentAuthState::Down)),
            _ => Err(invalid(format!("{kind} auth is invalid"))),
        },
        Some(_) => Err(invalid(format!("{kind} auth is invalid"))),
    }
}

fn optional_agent_usage(
    payload: &Map<String, Value>,
    kind: &str,
) -> Result<Option<AgentUsageState>, ProtocolError> {
    let Some(usage) = payload.get("usage") else {
        return Ok(None);
    };
    let usage = usage
        .as_object()
        .ok_or_else(|| invalid(format!("{kind} usage must be an object")))?;
    let exhausted = usage
        .get("exhausted")
        .and_then(Value::as_bool)
        .ok_or_else(|| invalid(format!("{kind} usage requires exhausted")))?;
    Ok(Some(AgentUsageState {
        exhausted,
        context_used_pct: optional_percent(usage, "contextUsedPct", kind)?,
        five_hour_used_pct: optional_percent(usage, "fiveHourUsedPct", kind)?,
        five_hour_resets_at_ms: optional_safe_u64(usage, "fiveHourResetsAtMs", kind)?,
        weekly_used_pct: optional_percent(usage, "weeklyUsedPct", kind)?,
        weekly_resets_at_ms: optional_safe_u64(usage, "weeklyResetsAtMs", kind)?,
    }))
}

fn optional_agent_availability(
    payload: &Map<String, Value>,
    kind: &str,
) -> Result<Option<(AgentAvailabilityState, Option<u64>)>, ProtocolError> {
    let Some(availability) = payload.get("availability") else {
        return Ok(None);
    };
    let availability = availability
        .as_object()
        .ok_or_else(|| invalid(format!("{kind} availability must be an object")))?;
    let state = match required_string(availability, "state", kind)?.as_str() {
        "ready" => AgentAvailabilityState::Ready,
        "exhausted" => AgentAvailabilityState::Exhausted,
        "needs_auth" => AgentAvailabilityState::NeedsAuth,
        "local_blocked" => AgentAvailabilityState::LocalBlocked,
        "retrying" => AgentAvailabilityState::Retrying,
        _ => return Err(invalid(format!("{kind} availability state is invalid"))),
    };
    Ok(Some((
        state,
        optional_safe_u64(availability, "resetsAtMs", kind)?,
    )))
}

fn optional_percent(
    payload: &Map<String, Value>,
    field: &str,
    kind: &str,
) -> Result<Option<u8>, ProtocolError> {
    match payload.get(field) {
        None => Ok(None),
        Some(value) => value
            .as_u64()
            .filter(|value| *value <= 100)
            .map(|value| Some(value as u8))
            .ok_or_else(|| invalid(format!("{kind} {field} must be an integer from 0 to 100"))),
    }
}

fn optional_safe_u64(
    payload: &Map<String, Value>,
    field: &str,
    kind: &str,
) -> Result<Option<u64>, ProtocolError> {
    match payload.get(field) {
        None => Ok(None),
        Some(value) => value
            .as_u64()
            .filter(|value| *value <= 9_007_199_254_740_991)
            .map(Some)
            .ok_or_else(|| invalid(format!("{kind} {field} must be a nonnegative safe integer"))),
    }
}

fn permission_options(
    payload: &Map<String, Value>,
    kind: &str,
) -> Result<Vec<PermissionOption>, ProtocolError> {
    let Some(options) = payload.get("options") else {
        return Ok(Vec::new());
    };
    let options: Vec<PermissionOption> = options
        .as_array()
        .ok_or_else(|| invalid(format!("{kind} options must be an array")))?
        .iter()
        .map(|option| {
            let option = option
                .as_object()
                .ok_or_else(|| invalid("permission option must be an object"))?;
            require_allowed_fields(option, kind, &["optionId", "kind", "name"])?;
            Ok(PermissionOption {
                option_id: required_string(option, "optionId", kind)?,
                kind: optional_string(option, "kind", kind)?,
                name: optional_string(option, "name", kind)?,
            })
        })
        .collect::<Result<_, ProtocolError>>()?;
    let unique = options
        .iter()
        .map(|option| option.option_id.as_str())
        .collect::<HashSet<_>>();
    if unique.len() != options.len() {
        return Err(invalid("permission.requested optionIds must be unique"));
    }
    Ok(options)
}

fn permission_outcome(
    payload: &Map<String, Value>,
    kind: &str,
) -> Result<PermissionOutcome, ProtocolError> {
    match required_string(payload, "outcome", kind)?.as_str() {
        "approved" => Ok(PermissionOutcome::Approved),
        "denied" => Ok(PermissionOutcome::Denied),
        "timeout" => Ok(PermissionOutcome::Timeout),
        "invalidated" => Ok(PermissionOutcome::Invalidated),
        _ => Err(invalid(
            "permission.resolved outcome must be approved, denied, timeout, or invalidated",
        )),
    }
}

fn invalid(message: impl Into<String>) -> ProtocolError {
    ProtocolError::InvalidEvent(message.into())
}
