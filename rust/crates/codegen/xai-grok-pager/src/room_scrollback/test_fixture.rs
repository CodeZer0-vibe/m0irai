use super::*;
use serde_json::json;
use zer0_room_protocol::{RoomEvent, RoomReducer};

/// Apply one event to the reducer and then to the room, in that order -
/// which is the order the runtime uses.
pub(crate) fn apply_live(room: &mut RoomScrollback, reducer: &mut RoomReducer, event: RoomEvent) {
    let delta = reducer
        .apply(&event)
        .expect("scrollback test transition is reducer-valid");
    room.apply_event(&event, reducer, delta);
}

/// Like [`event`], but with a caller-chosen timestamp and turn id.
///
/// The shared helper hard-codes `2026-08-02T00:00:00Z` for every event, so
/// any duration measured across a fixture built with it is exactly zero.
/// A folded steps row whose whole point is `· 12s` needs two instants that
/// differ, which is why this exists.
pub(crate) fn event_at(
    sequence: u64,
    kind: &str,
    payload: serde_json::Value,
    occurred_at: &str,
    turn_id: &str,
) -> RoomEvent {
    RoomEvent::from_value(json!({
        "protocol": "zer0.room",
        "version": 1,
        "sessionId": "scrollback-room",
        "eventSeq": sequence.to_string(),
        "eventId": format!("scrollback-{sequence}"),
        "turnId": turn_id,
        "occurredAt": occurred_at,
        "type": kind,
        "payload": payload,
    }))
    .expect("scrollback test event is reducer-valid")
}

/// One agent's whole turn, from prompt to terminal event.
///
/// `statuses` is one entry per tool call, in first-seen order; the lane
/// starts at `:00` and ends at `:12`, so the folded row reads `· 12s`.
pub(crate) struct StepsTurn {
    pub agent: &'static str,
    pub lane: &'static str,
    pub stream: &'static str,
    pub turn: &'static str,
    pub statuses: Vec<&'static str>,
    pub answer: Option<&'static str>,
    pub ending: &'static str,
}

impl StepsTurn {
    pub fn claude(statuses: &[&'static str]) -> Self {
        Self {
            agent: "claude",
            lane: "lane",
            stream: "stream",
            turn: "turn-1",
            statuses: statuses.to_vec(),
            answer: Some("the answer"),
            ending: "lane.completed",
        }
    }

    pub fn ending(mut self, ending: &'static str) -> Self {
        self.ending = ending;
        self
    }

    pub fn without_answer(mut self) -> Self {
        self.answer = None;
        self
    }

    /// Every event of the turn, in sequence order, starting at `first_seq`.
    pub fn events(&self, first_seq: u64) -> Vec<RoomEvent> {
        let mut seq = first_seq;
        let mut next = || {
            seq += 1;
            seq - 1
        };
        let accepted_seq = next();
        let mut out = vec![
            event_at(
                accepted_seq,
                "turn.accepted",
                json!({
                    "agents": [self.agent],
                    "text": "do the work",
                    "messageId": format!("{}-prompt", self.lane),
                    // The ledger sequence rides the event sequence, so it is
                    // monotonic across every turn a scenario strings together.
                    "ledgerSeq": accepted_seq.to_string(),
                }),
                "2026-08-02T00:00:00Z",
                self.turn,
            ),
            event_at(
                next(),
                "route.resolved",
                json!({ "agents": [self.agent] }),
                "2026-08-02T00:00:00Z",
                self.turn,
            ),
            event_at(
                next(),
                "lane.queued",
                json!({
                    "laneId": self.lane,
                    "agent": self.agent,
                    "expectedMessageId": format!("{}-message", self.lane),
                    "origin": "operator",
                    "hopIndex": 0,
                }),
                "2026-08-02T00:00:00Z",
                self.turn,
            ),
            event_at(
                next(),
                "lane.started",
                json!({ "laneId": self.lane, "streamId": self.stream, "agent": self.agent }),
                "2026-08-02T00:00:00Z",
                self.turn,
            ),
        ];
        for (index, status) in self.statuses.iter().enumerate() {
            out.push(event_at(
                next(),
                "lane.activity",
                json!({
                    "laneId": self.lane,
                    "streamId": self.stream,
                    "agent": self.agent,
                    "toolCallId": format!("tool-{index}"),
                    "update": "tool_call",
                    "title": format!("step {index}"),
                    "status": status,
                }),
                "2026-08-02T00:00:06Z",
                self.turn,
            ));
        }
        if let Some(answer) = self.answer {
            out.push(event_at(
                next(),
                "lane.chunk",
                json!({
                    "laneId": self.lane,
                    "streamId": self.stream,
                    "agent": self.agent,
                    "streamSeq": "1",
                    "chunkIndex": 0,
                    "channel": "assistant",
                    "text": answer,
                }),
                "2026-08-02T00:00:11Z",
                self.turn,
            ));
            let commit_seq = next();
            out.push(event_at(
                commit_seq,
                "message.committed",
                json!({
                    "laneId": self.lane,
                    "agent": self.agent,
                    "messageId": format!("{}-message", self.lane),
                    "ledgerSeq": commit_seq.to_string(),
                    "text": answer,
                    "origin": "operator",
                    "hopIndex": 0,
                }),
                "2026-08-02T00:00:12Z",
                self.turn,
            ));
        }
        let mut ending = json!({
            "laneId": self.lane,
            "streamId": self.stream,
            "agent": self.agent,
        });
        if self.ending == "lane.failed" {
            ending["error"] = json!("provider rejected the request");
        }
        out.push(event_at(
            next(),
            self.ending,
            ending,
            "2026-08-02T00:00:12Z",
            self.turn,
        ));
        out
    }
}

/// Drive a whole turn into a fresh live room, and return it with its reducer
/// so the rebuilt twin can be compared against it.
pub(crate) fn live_room(turns: &[StepsTurn]) -> (RoomScrollback, RoomReducer) {
    let mut reducer = RoomReducer::new();
    let mut room = RoomScrollback::new();
    let mut seq = 1;
    for turn in turns {
        let events = turn.events(seq);
        seq += events.len() as u64;
        for next in events {
            apply_live(&mut room, &mut reducer, next);
        }
    }
    (room, reducer)
}

pub(crate) fn check() -> &'static str {
    crate::glyphs::check_mark()
}
