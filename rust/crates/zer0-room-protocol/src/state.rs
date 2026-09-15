/// The durable lifecycle of one room lane.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LanePhase {
    Queued,
    Running,
    Cancelling,
    Committed,
    Completed,
    Failed,
    Cancelled,
}

/// The authority that created a lane.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LaneOrigin {
    Operator,
    Agent,
}

/// Whether a hop was admitted or refused by its budget.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HopDisposition {
    Dispatched,
    Blocked,
}

/// A durable, ordered hop authorization or budget refusal.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HopState {
    pub event_seq: String,
    pub occurred_at: String,
    pub hop_id: String,
    pub turn_id: String,
    pub from_agent: String,
    pub to_agent: String,
    pub parent_message_id: String,
    pub hop_index: u64,
    pub hop_budget: u64,
    /// Exact handoff request when the producer supplied it. Older journals
    /// may omit this; presentation must not invent a quote.
    pub text: Option<String>,
    pub disposition: HopDisposition,
}

/// The canonical message persisted for a lane.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MessageCommit {
    pub message_id: String,
    pub text: String,
    pub ledger_seq: String,
}

/// The author of one immutable chronological transcript row.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TranscriptAuthor {
    Operator,
    Agent(String),
}

/// An immutable, journal-ordered conversation row ready for presentation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TranscriptEntry {
    pub event_seq: String,
    pub occurred_at: String,
    pub turn_id: String,
    pub message_id: String,
    pub text: String,
    pub ledger_seq: String,
    pub author: TranscriptAuthor,
    pub target_agents: Vec<String>,
    pub reply_to: Option<String>,
    pub origin: LaneOrigin,
}

/// Route resolution retained separately from turn acceptance for replay.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RouteState {
    pub agents: Vec<String>,
    pub resolved_at: String,
}

/// A read-only semantic view of one accepted turn.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TurnState {
    pub id: String,
    pub agents: Vec<String>,
    pub text: String,
    pub message_id: String,
    pub ledger_seq: String,
    pub accepted_at: String,
    pub route: Option<RouteState>,
    pub completed_at: Option<String>,
}

/// A retained backend failure marker. Missing detail remains missing rather
/// than being manufactured by the reducer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BackendFailure {
    pub event_seq: String,
    pub turn_id: String,
    pub occurred_at: String,
    pub message: Option<String>,
    pub error: Option<String>,
}

/// One non-fatal condition the host announced, reduced from a `room.notice` event.
///
/// `cause` is kept as the RAW STRING the host sent rather than parsed into an enum. An unrecognized
/// cause from a newer host has to survive reduction and reach the renderer, which answers it with a
/// generic phrase; narrowing to an enum here is precisely how forward compatibility turns into a
/// dropped row, and a dropped row is the silence this event exists to end.
///
/// `detail` is deliberately ABSENT, and its absence is the enforcement rather than a convention. The
/// wire carries a bounded diagnostic string for the journal, and the room renders a FIXED phrase
/// chosen by cause. A `detail` field the view could reach is a field the view eventually paints; not
/// carrying it past the reducer is the only way to make "never painted" a property of the type
/// instead of a rule somebody has to remember.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoomNotice {
    pub event_seq: String,
    pub turn_id: String,
    pub occurred_at: String,
    pub cause: String,
    pub agent: Option<String>,
}

/// Provider account reachability reported by the existing chat status bus.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentAuthState {
    Ready,
    Limited,
    Down,
}

/// Durable dispatch reality for one provider lane.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentAvailabilityState {
    Ready,
    Exhausted,
    NeedsAuth,
    LocalBlocked,
    Retrying,
}

/// A real, provider-reported usage snapshot. Optional values stay optional;
/// the reducer never manufactures a zero for a missing measurement.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentUsageState {
    pub exhausted: bool,
    pub context_used_pct: Option<u8>,
    pub five_hour_used_pct: Option<u8>,
    pub five_hour_resets_at_ms: Option<u64>,
    pub weekly_used_pct: Option<u8>,
    pub weekly_resets_at_ms: Option<u64>,
}

/// The latest partial-merge status for one room agent.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentStatusState {
    pub agent: String,
    pub last_event_seq: String,
    pub occurred_at: String,
    pub auth: Option<AgentAuthState>,
    pub usage: Option<AgentUsageState>,
    pub availability: Option<AgentAvailabilityState>,
    pub availability_resets_at_ms: Option<u64>,
}

/// The latest provider-owned native mode state. A missing entry means no persisted or live mode event
/// exists; renderers must not substitute an invented default word.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentModeStatus {
    Active,
    Pending,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentModeState {
    pub agent: String,
    pub mode_id: String,
    pub word: Option<String>,
    pub status: AgentModeStatus,
    pub error: Option<String>,
    pub available_mode_ids: Option<Vec<String>>,
    pub last_event_seq: String,
    pub occurred_at: String,
}

/// A provider tool activity update associated with one lane and stream.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LaneActivityUpdate {
    ToolCall,
    ToolCallUpdate,
}

/// The latest merged view of one provider tool call.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LaneActivity {
    /// Decimal sequence of the most recent update merged into this tool call.
    pub last_event_seq: String,
    pub tool_call_id: String,
    pub update: LaneActivityUpdate,
    pub title: Option<String>,
    pub kind: Option<String>,
    pub status: Option<String>,
}

/// One option presented by a pending permission request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PermissionOption {
    pub option_id: String,
    pub kind: Option<String>,
    pub name: Option<String>,
}

/// A resolved permission outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PermissionOutcome {
    Approved,
    Denied,
    Timeout,
    Invalidated,
}

/// A permission request, retained after resolution for replay and inspection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PermissionState {
    pub requested_event_seq: String,
    pub requested_at: String,
    pub resolved_event_seq: Option<String>,
    pub resolved_at: Option<String>,
    pub ask_id: String,
    pub turn_id: String,
    pub agent: String,
    pub options: Vec<PermissionOption>,
    pub tool_title: Option<String>,
    pub outcome: Option<PermissionOutcome>,
    pub option_id: Option<String>,
}

/// A read-only view of a lane's validated identity and lifecycle state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LaneState {
    pub id: String,
    pub turn_id: String,
    pub agent: String,
    pub expected_message_id: String,
    pub origin: LaneOrigin,
    pub hop_index: u64,
    pub parent_message_id: Option<String>,
    pub reply_to: Option<String>,
    pub from_agent: Option<String>,
    pub hop_id: Option<String>,
    pub phase: LanePhase,
    /// This lane's position in `lane.queued` order, counted from 0 across the
    /// whole session. Roster order, in other words: the order the operator
    /// dispatched the agents, which is the order the room draws them.
    ///
    /// It is the same information `ordered_lanes()` carries as a sequence,
    /// exposed per lane because a consumer holding one `LaneState` - the room's
    /// `finish_lane` does - otherwise has no way to place it. `queued_at` is
    /// not a substitute: several lanes of one turn are queued inside the same
    /// millisecond and share a timestamp.
    pub roster_index: u64,
    pub queued_at: String,
    pub started_at: Option<String>,
    pub terminal_at: Option<String>,
    pub terminal_event_seq: Option<String>,
    pub failure_reason: Option<String>,
    pub stream_id: Option<String>,
    pub message_commit: Option<MessageCommit>,
    pub activity: Vec<LaneActivity>,
}

/// One started lane's accumulated output and monotonic cursors.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoomStream {
    pub id: String,
    pub lane_id: String,
    pub agent: String,
    pub turn_id: String,
    /// Decimal sequence of the `lane.started` event, used for replay ordering.
    pub started_event_seq: String,
    pub started_at: String,
    pub model_id: Option<String>,
    pub text: String,
    pub next_chunk_index: u64,
    pub next_stream_seq: String,
}
