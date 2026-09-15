//! Strict JSON-RPC room frames, validated events, decimal sequencing, and lane reduction.

pub mod jsonrpc;

mod event;
mod reducer;
mod sequence;
mod state;

pub use event::{ProtocolError, RoomEvent};
pub use jsonrpc::*;
pub use reducer::{
    ApplyDelta, RoomReducer, lane_scans_on_this_thread, reset_lane_scans_on_this_thread,
};
pub use sequence::{decimal_cmp, increment_decimal, validate_decimal};
pub use state::{
    AgentAuthState, AgentAvailabilityState, AgentModeState, AgentModeStatus, AgentStatusState,
    AgentUsageState, BackendFailure, HopDisposition, HopState, LaneActivity, LaneActivityUpdate,
    LaneOrigin, LanePhase, LaneState, MessageCommit, PermissionOption, PermissionOutcome,
    PermissionState, RoomNotice, RoomStream, RouteState, TranscriptAuthor, TranscriptEntry,
    TurnState,
};
