//! Zer0 event-to-scrollback adapter.
//!
//! This keeps the room as one pager `ScrollbackState`. Provider streams have
//! stable, isolated entry IDs so interleaved Claude/Codex/Gemini chunks mutate
//! only their own native Markdown entry and terminal completion freezes it.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};
use zer0_room_protocol::{
    ApplyDelta, BackendFailure, HopDisposition, HopState, LaneActivity, LanePhase, LaneState,
    RoomEvent, RoomNotice, RoomReducer, RoomStream, TranscriptAuthor, TranscriptEntry, decimal_cmp,
};

use crate::room_steps_block::RoomStepsBlock;
use crate::room_theme::{
    RoomIdentity, RoomSecondaryGlyph, RoomTheme, room_secondary, room_spinner,
};
use crate::scrollback::{
    EntryId, RenderBlock, ResolvedSelectionModel, ScratchBuffer, ScrollbackPane, ScrollbackState,
};

const MAX_FAILURE_DETAIL_WIDTH: usize = 72;

/// The row a notice draws, chosen ENTIRELY by cause.
///
/// Every phrase is a constant owned by this build. Nothing from the event's payload is interpolated,
/// which is what makes "the detail is never painted" a property of this function rather than a rule
/// somebody has to keep remembering — there is no parameter here to leak.
///
/// An UNRECOGNIZED cause is a NEWER HOST talking to this terminal, not a bug and not a reason to
/// drop the row. The operator still learns that something non-fatal went wrong; they just get the
/// generic sentence instead of the specific one, and the specific one is in the journal. Vendor
/// drift loud, never fatal.
///
/// Three of these deliberately do NOT open with "memory briefing unavailable". The brief specifies
/// that prefix, and it is exactly right for the five causes that ARE a lost briefing. It would be a
/// false sentence for the other three: `memory-failure-log-unwritable` means the briefing may well
/// have worked and the RECORD of a failure could not be written, `agy-conversation-lost` is not
/// about the briefing at all, and `room-rebuilt-from-ledger` is about the room's own transcript, not
/// a briefing. A fixed phrase that misdescribes its own cause is worse than a longer list of phrases.
///
/// `room-rebuilt-from-ledger` (SL-A round 2) deliberately carries no restored-message COUNT: this
/// function's own contract is "nothing from the payload is interpolated," and the count lives in the
/// event's own place in the durable journal — a reader who wants the number reads the row there, not
/// a phrase that would need to lie about it the day this build stops recognizing a future variant.
fn notice_phrase(cause: &str) -> &'static str {
    match cause {
        "memory-db-open-failed" => {
            "memory briefing unavailable: the evidence database would not open"
        }
        "memory-project-resolve-failed" => {
            "memory briefing unavailable: this project could not be resolved"
        }
        "memory-compose-failed" => {
            "memory briefing unavailable: the briefing could not be composed"
        }
        "memory-cursor-failed" => "memory briefing unavailable: the lane cursor could not be read",
        "memory-request-files-failed" => {
            "memory briefing unavailable: the files named in the request could not be read"
        }
        "memory-failure-log-unwritable" => {
            // N-3 (MN fix round 2): "journal" is ambiguous in this codebase — the room's own durable
            // event log is ALSO called "the journal" (room-journal.ts), and that one is fine when this
            // row appears. "disk" names the failure without claiming which file.
            "memory failure record could not be written to disk"
        }
        "agy-conversation-lost" => "gemini lost the thread of this conversation and started fresh",
        "room-rebuilt-from-ledger" => {
            // SL-A round 2: the TS side (src/room/room-host-recovery.ts) already emits this cause
            // with the exact restored count in the event's own `detail`, which this function is
            // built never to read (see the module doc above) — the count is a ledger row, not a
            // painted phrase.
            "this room was rebuilt from the evidence ledger; messages that were missing from its transcript were restored"
        }
        _ => {
            tracing::warn!(
                cause,
                "room notice cause is unknown to this build; rendering the generic phrase"
            );
            "the host reported a condition this build does not recognize"
        }
    }
}

/// One feed entry under a mouse click.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RoomFeedHit {
    pub index: usize,
    pub entry_id: EntryId,
    pub foldable: bool,
}

/// Service-neutral presentation metadata attached to every room speaker.
/// It is deliberately separate from provider/model data so the one shared
/// transcript stays stable across hosts.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RoomSpeaker {
    Operator,
    Claude,
    Codex,
    Gemini,
}

impl RoomSpeaker {
    /// Public because slice D's unseen-answer pill names agents on the
    /// guidance row and resolves them from the commit event, outside this
    /// module. One mapping from agent name to speaker, not two.
    pub fn from_agent(agent: &str) -> Self {
        match agent {
            "claude" => Self::Claude,
            "codex" => Self::Codex,
            "gemini" => Self::Gemini,
            _ => Self::Operator,
        }
    }

    fn glyph(self) -> &'static str {
        self.identity().glyph()
    }

    /// The agent's name as the feed spells it. Public for the same reason as
    /// [`RoomSpeaker::from_agent`]: `↑ claude and codex answered` must use the
    /// room's own spelling, not a second table of names.
    pub fn label(self) -> &'static str {
        match self {
            Self::Operator => "you",
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Gemini => "gemini",
        }
    }

    fn color(self) -> ratatui::style::Color {
        self.identity().color()
    }

    fn identity(self) -> RoomIdentity {
        match self {
            Self::Operator => RoomIdentity::You,
            Self::Claude => RoomIdentity::Claude,
            Self::Codex => RoomIdentity::Codex,
            Self::Gemini => RoomIdentity::Gemini,
        }
    }
}

#[derive(Debug)]
struct StreamBinding {
    header_entry_id: EntryId,
    entry_id: EntryId,
    status_entry_id: EntryId,
    cohesion_group: u64,
    text: String,
    completed: bool,
    /// FL-071: the live status row is removed exactly once, by whichever of the
    /// answer, the commit, or the terminal event ends the wait first.
    status_cleared: bool,
    speaker: RoomSpeaker,
    activity_label: Option<String>,
    /// The one folded steps entry for this stream, created the first time the
    /// lane produces a terminal step and mutated in place after that. `None`
    /// until then, which is also the "this lane ran no tools" state — and that
    /// state renders exactly as the room rendered before this block existed.
    steps_entry_id: Option<EntryId>,
    /// §C.6's latch. A lane can both commit AND complete, and each site wants
    /// to fold; whichever arrives first computes the duration and the rest are
    /// no-ops, so the folded row cannot show two different durations for the
    /// same run. Mirrors `status_cleared` directly above.
    steps_folded: bool,
    /// The turn and roster seat this stream's lane occupies. Slice D's
    /// turn-block registry needs them at sites that never hold a `LaneState` —
    /// the steps writer creating its entry, the live-status recycler removing
    /// and re-creating its row — so they ride on the binding rather than
    /// forcing every one of those sites to re-resolve the lane.
    turn_id: String,
    roster_index: u64,
}

/// The room-owned adapter around the pager's real scrollback state.
pub struct RoomScrollback {
    state: ScrollbackState,
    scratch: ScratchBuffer,
    stream_entries: HashMap<String, StreamBinding>,
    content_entries: HashMap<String, EntryId>,
    content_speakers: HashMap<String, RoomSpeaker>,
    lane_streams: HashMap<String, String>,
    lane_speakers: HashMap<String, RoomSpeaker>,
    hop_entries: HashSet<String>,
    terminal_lanes: HashSet<String>,
    /// FL-141 + slice D: per-turn lane-row membership — see [`TurnLaneBlock`].
    /// The room's ONE ordering authority for lane rows; `lane_anchor` and
    /// `relocate_if_displaced` both read it.
    turn_blocks: HashMap<String, TurnLaneBlock>,
    /// Slice D: one presentation group per committed answer, keyed by message
    /// id — see [`AnswerGroup`]. Feeds relocation's back-reference placement
    /// now, and the unseen-answer pill/jump seam later.
    answer_groups: HashMap<String, AnswerGroup>,
    reduced_motion: bool,
    next_cohesion_group: u64,
}

/// One lane's live rows inside its turn's block.
///
/// Membership ONLY, keyed by `EntryId`. The ORDER is read off the scrollback
/// state itself at move time — which is roster+draw order by FL-141's
/// construction, and stays true after a move because a moved block keeps its
/// relative order. A positional copy here would drift the first time
/// `write_live_status` re-created a status row under a new id or
/// `write_steps_block` allocated its entry mid-group.
#[derive(Debug, Default)]
struct TurnLaneRows {
    roster_index: u64,
    entry_ids: HashSet<EntryId>,
}

/// Slice D's ONE ordering authority for lane rows, replacing FL-141's
/// per-lane anchors: every currently live `EntryId` a turn's lanes own,
/// grouped by roster seat and kept sorted by it.
///
/// This is what cross-turn relocation moves as ONE block (memo §1.2), what
/// [`RoomScrollback::lane_anchor`] searches when a late-drawing lane needs
/// its seat, and what a last-roster lane uses to find the entry FOLLOWING its
/// turn block instead of appending blindly past foreign rows (memo §1.3).
#[derive(Debug, Default)]
struct TurnLaneBlock {
    lanes: Vec<TurnLaneRows>,
    /// Set once a qualifying commit has moved this block to the tail. Only a
    /// RELOCATED block may place new rows by tail-successor: before that,
    /// a first row with no higher-roster sibling simply appends, and
    /// inserting before "whatever follows the block" would jump over the
    /// foreign rows that legitimately sit below it.
    relocated: bool,
}

/// One committed answer's presentation group (memo §1.4): that answer's OWN
/// cohesion rows — never the whole turn — and the row downstream seams target
/// (`top`: this answer's back-reference when one exists, else its header).
///
/// `back_reference` is carried beside `top` rather than derived from
/// `top != header` because the no-duplication pins need the Option itself:
/// "is there already a reference row" is a question about existence, not an
/// inequality between two ids that happen to be equal today.
///
/// It carried `message: EntryId` and `agent: RoomSpeaker` for one round and
/// nothing ever read either — the pill resolves an answer by MESSAGE ID
/// through `answer_top_index`, and names its agents from `UnseenAnswer`, which
/// is view state that has to outlive this map across a snapshot. Both are
/// removed: a field kept "in case a seam wants it" is a claim about the design
/// that the design does not make.
#[derive(Debug)]
struct AnswerGroup {
    cohesion_group: u64,
    ids: Vec<EntryId>,
    top: EntryId,
    back_reference: Option<EntryId>,
}

/// One lane's place in the room: which turn it belongs to, and where it sits
/// in that turn's dispatch order.
///
/// Borrowed rather than owned because every caller already holds the
/// `LaneState` it comes from, and copying two fields out of it at each of the
/// row-drawing sites is how the two of them drift apart.
#[derive(Clone, Copy, Debug)]
struct LaneOrder<'a> {
    turn_id: &'a str,
    roster_index: u64,
}

impl<'a> LaneOrder<'a> {
    fn of(lane: &'a LaneState) -> Self {
        Self {
            turn_id: &lane.turn_id,
            roster_index: lane.roster_index,
        }
    }
}

enum DurableRow<'a> {
    Transcript(&'a TranscriptEntry),
    TerminalLane(&'a LaneState),
    BackendFailure(&'a BackendFailure),
    Notice(&'a RoomNotice),
    Hop(&'a HopState),
    /// A stream the rebuild re-materializes as the live room built it. Named
    /// for what it does rather than for the lane's phase: since FL-141 it also
    /// carries lanes that have already settled - see `replay_stream_for_lane`.
    ReplayedStream(&'a RoomStream),
}

/// One step of a rebuild's presentation replay: either a row to draw, or -
/// slice D - a synthetic cross-turn relocation.
enum ReplayStep<'a> {
    Row(DurableRow<'a>),
    /// Memo §1.10. Keyed by the committed transcript entry's REAL event
    /// sequence and ranked AFTER row creation at that sequence, so the
    /// relocation executes exactly where the live room executed it: between
    /// the events that came before and after its commit. A post-build
    /// "move everything at the end" pass is invalid here — it would hoist an
    /// answer committed before a still-later prompt BENEATH that prompt, and
    /// the replay-interleaving pin exists precisely to catch that.
    ///
    /// The answer's OWN row is usually NOT at this sequence: it keys on the
    /// lane's first draw (see [`DurableRow::replay_seq`]), which is normally
    /// earlier. That is the point — by the time the relocation runs, every row
    /// the live room had drawn before the commit has been drawn here too, and
    /// the block moves past exactly the same rows it moved past live.
    RelocateTurn(&'a TranscriptEntry),
}

impl<'a> DurableRow<'a> {
    /// The event sequence at which the LIVE room first drew this row, which is
    /// the order a rebuild has to replay ROWS in.
    ///
    /// FL-141: every LANE-bound row answers with the same value — the lane's
    /// first-draw sequence — because live they are all drawn by the one event
    /// that created the lane's block. Asking each row for its own sequence is
    /// what broke: a replayed stream answered `lane.started` while the same
    /// lane's committed answer answered `message.committed`, and a lane that
    /// started first but committed last replayed after a lane that started
    /// later. Rows that belong to no lane keep their own sequence, which is
    /// also where the live room puts them.
    ///
    /// ⚠ **This answers the ROW question only, and slice D made that
    /// distinction load-bearing.** A committed answer's transcript entry is now
    /// the subject of TWO replay steps with TWO keys: the row, keyed here on
    /// the lane's first draw, and the synthetic [`ReplayStep::RelocateTurn`],
    /// keyed on the COMMIT. Those are different facts — where the row was
    /// drawn, and when the relocation ran — and they routinely sort to
    /// different places.
    ///
    /// Slice D's first implementation obtained the second key by giving the
    /// ROW the commit's sequence, which made this arm unreachable: the whole
    /// suite passed with `panic!()` in its place. Two shapes broke in silence —
    /// a backend failure landing mid-stream read last live and third on
    /// reload, and a lane already on screen when an older answer relocated
    /// swapped places with it across a restart. Both are pinned at the end of
    /// `room_scrollback/tests.rs`, and with them present this arm is reached by
    /// DOZENS of tests where it was reached by none — replace it with a
    /// `panic!()` and the suite goes red in bulk.
    ///
    /// The claim is written that way on purpose. An exact count is a number
    /// that rots on the next added test: this comment said 34, measured after
    /// the keying fix but before the rest of that round's tests landed, and it
    /// was already wrong by the time the round ended. Measured 36 at `b24fb19`,
    /// recorded here as a dated observation rather than as the invariant.
    fn replay_seq(&self, reducer: &'a RoomReducer) -> &'a str {
        match self {
            // CQ-04: `lane_for_message`, not a scan. This ran once per
            // transcript row against a lane list that only ever grows, which
            // is what made a rebuild cost rows × lanes.
            Self::Transcript(entry) => reducer
                .lane_for_message(&entry.message_id)
                .map_or(entry.event_seq.as_str(), |lane| {
                    lane_first_draw_seq(reducer, lane)
                }),
            Self::TerminalLane(lane) => lane_first_draw_seq(reducer, lane),
            Self::BackendFailure(failure) => &failure.event_seq,
            Self::Notice(notice) => &notice.event_seq,
            Self::Hop(hop) => &hop.event_seq,
            Self::ReplayedStream(stream) => &stream.started_event_seq,
        }
    }

    /// Breaks a tie on `replay_seq`, which a lane's own rows now share by
    /// construction: the row that CREATES a lane's block replays before the
    /// row that settles it, exactly as live, where the terminal event always
    /// arrives after the one that drew the lane.
    ///
    /// Without this a cancelled lane replayed its terminal row first, found no
    /// stream binding, drew a whole second block from `finalized_steps_block`,
    /// and the reload showed the lane twice.
    fn replay_rank(&self) -> u8 {
        match self {
            Self::TerminalLane(_) => 1,
            _ => 0,
        }
    }
}

/// The commit event's presentation facts, bundled so `commit_message` stays
/// inside this file's parameter clamp: when the answer happened (drives the
/// header's canonical timestamp) and where it sits in the event stream
/// (drives slice D's displacement predicate).
struct CommitFacts<'a> {
    occurred_at: Option<&'a str>,
    commit_seq: &'a str,
}

/// When the live room first put anything on screen for this lane: the
/// `lane.started` sequence if it ever started, otherwise the sequence of the
/// terminal event that drew its one row.
fn lane_first_draw_seq<'a>(reducer: &'a RoomReducer, lane: &'a LaneState) -> &'a str {
    lane.stream_id
        .as_deref()
        .and_then(|stream_id| reducer.stream(stream_id))
        .map(|stream| stream.started_event_seq.as_str())
        .or(lane.terminal_event_seq.as_deref())
        .expect("a durable lane row either started or reached a terminal event")
}

/// Key a rebuilt [`DurableRow`] for the replay sort, through its own
/// `replay_seq`/`replay_rank` — still THE authority for where a row replays,
/// now wrapped in a [`ReplayStep`] so slice D's synthetic relocations can
/// share one sorted list (they key themselves at rank 2, above every row
/// creation at the same sequence).
fn keyed_replay_row<'a>(
    reducer: &'a RoomReducer,
    row: DurableRow<'a>,
) -> ((&'a str, u8), ReplayStep<'a>) {
    (
        (row.replay_seq(reducer), row.replay_rank()),
        ReplayStep::Row(row),
    )
}

/// Whether a session rebuild replays this lane's stream the way the live room
/// built it.
///
/// FL-141: a cancelled lane's stream is the ONLY record of what it had said
/// before the operator stopped it — the reducer keeps the stream (streams are
/// never dropped on cancel) and the live room shows the text, so a reload owes
/// it too. Without this the rebuild had nothing to restyle and drew the lane a
/// fresh row instead, which is how a reload came back in settle order.
///
/// - Running / Cancelling: unchanged, the pre-FL-141 rule.
/// - Cancelled: always. It cannot also have committed —
///   `a_lane_that_committed_can_never_be_cancelled_afterwards` pins that the
///   reducer refuses a cancel for any lane that is not Queued, Running or
///   Cancelling, and `message.committed` moves it to Committed. This arm read
///   `message_commit.is_none()` for one round; the condition was always true
///   and the comment beside it described a lane that cannot exist.
/// - Failed: always, since the 2026-09-02 ruling. Same argument as Cancelled,
///   and until the ruling a reload silently dropped everything a failed agent
///   had already got out. `fail_lane` refuses any lane that is not Running,
///   Cancelling or a recovered Queued one, and `message.committed` moves a
///   lane to Committed first, so a failed lane can never also have committed
///   and replaying can never draw the same text twice —
///   `a_lane_that_committed_can_never_fail_afterwards` pins the reducer half,
///   `every_terminal_mix_reads_in_roster_order_live_and_rebuilt` the room half.
/// - Completed: never. A completed lane's text IS in the transcript, where
///   `push_transcript_entry` draws it, so replaying would draw it twice.
fn replay_stream_for_lane(lane: &LaneState) -> bool {
    matches!(
        lane.phase,
        LanePhase::Running | LanePhase::Cancelling | LanePhase::Cancelled | LanePhase::Failed
    )
}

impl Default for RoomScrollback {
    fn default() -> Self {
        Self::new()
    }
}

impl RoomScrollback {
    pub fn new() -> Self {
        let mut state = ScrollbackState::new();
        let mut appearance = crate::appearance::AppearanceConfig::default();
        // Room time belongs to the identity header. Reserving a generic
        // right-hand timestamp gutter makes short answers wrap and weakens the
        // single-column conversation hierarchy.
        appearance.show_timestamps = false;
        state.set_appearance(appearance);
        Self {
            state,
            scratch: ScratchBuffer::new(),
            stream_entries: HashMap::new(),
            content_entries: HashMap::new(),
            content_speakers: HashMap::new(),
            lane_streams: HashMap::new(),
            lane_speakers: HashMap::new(),
            hop_entries: HashSet::new(),
            terminal_lanes: HashSet::new(),
            turn_blocks: HashMap::new(),
            answer_groups: HashMap::new(),
            reduced_motion: false,
            next_cohesion_group: 1,
        }
    }

    /// Materialize a reducer snapshot without making a parallel transcript.
    /// Completed messages become pager Markdown entries; only still-running
    /// streams remain mutable entries.
    pub fn from_reducer(reducer: &RoomReducer) -> Self {
        Self::from_reducer_with_motion(reducer, false)
    }

    pub fn from_reducer_with_motion(reducer: &RoomReducer, reduced_motion: bool) -> Self {
        let mut room = Self::new();
        room.reduced_motion = reduced_motion;
        room.state.begin_batch();
        let mut steps = Vec::<((&str, u8), ReplayStep)>::new();
        for entry in reducer.transcript() {
            // THE ROW keys through `replay_seq`, exactly as every other row
            // does and exactly as it did before slice D. For a lane's
            // committed answer that is the lane's FIRST-DRAW sequence, not the
            // commit's — FL-141's whole fix, and the thing a reloaded room
            // needs in order to place that answer where the live room drew it.
            steps.push(keyed_replay_row(reducer, DurableRow::Transcript(entry)));
            // THE RELOCATION keys on the COMMIT (memo §1.10), because that is
            // when the live room performed it. Two different facts about one
            // transcript entry, and they must be computed separately.
            //
            // ⚠ The first implementation of this loop got the relocation's key
            // by keying the ROW on the commit too. Nothing in the suite caught
            // it: `replay_seq`'s `Transcript` arm became unreachable, a
            // backend failure landing mid-stream read last live and third on
            // reload, and a lane already on screen when an older answer
            // relocated swapped places with it after a restart. The two tests
            // at the end of `tests.rs` pin both shapes.
            //
            // CQ-04: this used to test membership of a `HashSet` of answered
            // message ids, built by scanning every lane once before the loop.
            // The set was there to keep the per-entry test O(1); the reducer's
            // own index does that without the scan or the allocation.
            if matches!(entry.author, TranscriptAuthor::Agent(_))
                && reducer.lane_for_message(&entry.message_id).is_some()
            {
                steps.push((
                    (entry.event_seq.as_str(), 2),
                    ReplayStep::RelocateTurn(entry),
                ));
            }
        }
        // Every lane-bound row keys itself through its own
        // `replay_seq`/`replay_rank`, exactly as before - the wrapper only adds
        // slice D's synthetic relocations to the same sorted list.
        steps.extend(
            reducer
                .ordered_lanes()
                .filter(|lane| {
                    matches!(&lane.phase, LanePhase::Failed | LanePhase::Cancelled)
                        && lane.terminal_event_seq.is_some()
                })
                .map(|lane| keyed_replay_row(reducer, DurableRow::TerminalLane(lane))),
        );
        steps.extend(
            reducer
                .backend_failures()
                .map(|failure| keyed_replay_row(reducer, DurableRow::BackendFailure(failure))),
        );
        steps.extend(
            reducer
                .room_notices()
                .map(|notice| keyed_replay_row(reducer, DurableRow::Notice(notice))),
        );
        steps.extend(
            reducer
                .ordered_hops()
                .map(|hop| keyed_replay_row(reducer, DurableRow::Hop(hop))),
        );
        steps.extend(
            reducer
                .ordered_streams()
                .filter(|stream| {
                    reducer
                        .lane(&stream.lane_id)
                        .is_some_and(replay_stream_for_lane)
                })
                .map(|stream| keyed_replay_row(reducer, DurableRow::ReplayedStream(stream))),
        );
        // FL-141: this sort decides the order steps are REPLAYED in, not where
        // lane rows land — `lane_anchor` owns that on both paths. Keying every
        // lane-bound row on the moment the live room first drew that lane is
        // what makes the replay order match the live arrival order, so the two
        // rooms fold to the same text and not merely to the same set of rows.
        // The rank breaks ties the way live arrival did: row creation at a
        // sequence first (terminal lanes last among them, rank 1), then slice
        // D's relocation at rank 2 — the commit's own presentation effect.
        steps.sort_by(|((left_seq, left_rank), _), ((right_seq, right_rank), _)| {
            decimal_cmp(left_seq, right_seq)
                .expect("RoomReducer only exposes validated decimal event sequences")
                .then(left_rank.cmp(right_rank))
        });
        for (_, step) in steps {
            match step {
                ReplayStep::Row(DurableRow::Transcript(entry)) => {
                    room.push_transcript_entry(entry, Some(reducer))
                }
                ReplayStep::Row(DurableRow::TerminalLane(lane)) => room.finish_lane(lane),
                ReplayStep::Row(DurableRow::BackendFailure(failure)) => {
                    room.push_backend_failure(failure)
                }
                ReplayStep::Row(DurableRow::Notice(notice)) => room.push_room_notice(notice),
                ReplayStep::Row(DurableRow::Hop(hop)) => room.push_hop(hop),
                ReplayStep::Row(DurableRow::ReplayedStream(stream)) => {
                    let lane = reducer
                        .lane(&stream.lane_id)
                        .expect("a replayed stream's lane was filtered from the reducer");
                    room.start_stream(&stream.id, lane);
                    room.push_stream_chunk(&stream.id, &stream.text);
                    room.sync_lane_activity(&stream.lane_id, reducer, 0);
                }
                ReplayStep::RelocateTurn(entry) => room.relocate_if_displaced(
                    reducer,
                    &entry.turn_id,
                    &entry.message_id,
                    &entry.event_seq,
                ),
            }
        }
        room.state.end_batch();
        room
    }

    /// Apply the visual half of an already-validated reducer event.
    pub fn apply_event(&mut self, event: &RoomEvent, reducer: &RoomReducer, delta: ApplyDelta) {
        if matches!(delta, ApplyDelta::None)
            && !matches!(
                event.kind.as_str(),
                "turn.accepted"
                    | "lane.started"
                    | "lane.chunk"
                    | "lane.activity"
                    | "lane.cancelling"
                    | "message.committed"
                    | "lane.completed"
                    | "lane.failed"
                    | "lane.cancelled"
                    | "hop.dispatched"
                    | "hop.blocked"
                    | "backend.failed"
                    | "room.notice"
            )
        {
            return;
        }
        match event.kind.as_str() {
            "turn.accepted" => {
                if let Some(entry) = reducer.transcript().last() {
                    self.push_transcript_entry(entry, Some(reducer));
                }
            }
            "lane.started" => {
                let stream_id = required_payload_string(event, "streamId");
                let lane_id = required_payload_string(event, "laneId");
                let lane = reducer
                    .lane(lane_id)
                    .expect("RoomReducer accepted lane.started for a known lane");
                self.start_stream(stream_id, lane);
            }
            "lane.chunk" => {
                let stream_id = required_payload_string(event, "streamId");
                let text = required_payload_string(event, "text");
                // FL-071: the answer landing IS the end of the wait, so retire the
                // working row on the chunk that delivers it rather than on the next
                // animation tick - a tick late is a spinner under text the operator
                // is already reading. The `status_cleared` guard keeps a long stream
                // from re-walking the lane's activity once per chunk; it re-opens
                // only while a cancel is holding the row up.
                if self.push_stream_chunk(stream_id, text)
                    && self
                        .stream_entries
                        .get(stream_id)
                        .is_some_and(|binding| !binding.status_cleared)
                {
                    let lane_id = required_payload_string(event, "laneId");
                    self.sync_lane_activity(lane_id, reducer, 0);
                }
            }
            "lane.activity" => {
                let lane_id = required_payload_string(event, "laneId");
                self.sync_lane_activity(lane_id, reducer, 0);
            }
            "lane.cancelling" => {
                let lane_id = required_payload_string(event, "laneId");
                self.sync_lane_activity(lane_id, reducer, 0);
            }
            "message.committed" => {
                let lane_id = required_payload_string(event, "laneId");
                let message_id = required_payload_string(event, "messageId");
                let text = required_payload_string(event, "text");
                self.commit_message(
                    lane_id,
                    message_id,
                    text,
                    reducer,
                    CommitFacts {
                        occurred_at: Some(&event.occurred_at),
                        commit_seq: &event.event_seq,
                    },
                );
            }
            "lane.completed" | "lane.failed" | "lane.cancelled" => {
                let lane_id = required_payload_string(event, "laneId");
                let lane = reducer
                    .lane(lane_id)
                    .expect("RoomReducer accepted a terminal event for a known lane");
                let turn_id = lane.turn_id.clone();
                self.finish_lane(lane);
                self.forget_settled_turn(&turn_id, reducer);
            }
            "hop.dispatched" | "hop.blocked" => {
                let hop_id = required_payload_string(event, "hopId");
                if let Some(hop) = reducer.hop(hop_id) {
                    self.push_hop(hop);
                }
            }
            "backend.failed" => reducer
                .backend_failures()
                .last()
                .map(|failure| self.push_backend_failure(failure))
                .unwrap_or(()),
            "room.notice" => reducer
                .room_notices()
                .last()
                .map(|notice| self.push_room_notice(notice))
                .unwrap_or(()),
            _ => {}
        }
    }

    /// True while the feed would paint nothing at all.
    ///
    /// This is the room's one "has anything ever happened here" observable, and
    /// it is deliberately the *rendered* feed rather than the reducer: every
    /// path that puts a row on screen lands here first — transcript entries,
    /// terminal lanes, backend failures, hops, running streams, local notices,
    /// and runtime failures. Asking the reducer instead would miss the
    /// client-owned rows, which are exactly the ones a resumed or failed room
    /// shows first.
    pub fn is_empty(&self) -> bool {
        self.state.is_empty()
    }

    /// Paint the feed and hand back the frame's resolved selection model.
    ///
    /// The model used to be built here and dropped on the floor, which left the
    /// mouse handler unable to tell a click on selectable text from a click on
    /// an accent bar - the distinction the whole fold gesture rests on. The
    /// caller must store it: a model kept from an OLDER frame is worse than
    /// none, because its screen rows describe a layout that no longer exists.
    ///
    /// `#[must_use]` rather than a trusted convention. Stated plainly because
    /// the lead asked: in this workspace that lint WARNS, it does not deny -
    /// `rust/Cargo.toml`'s `[workspace.lints.rust]` sets only `unexpected_cfgs`,
    /// and `npm run verify` runs no clippy step at all. So this catches a
    /// forgetful caller in `cargo build` output, and nothing fails the gate.
    ///
    /// Writing the return value unconditionally IS the per-frame clear: the pane
    /// returns `Default::default()` on a zero-width or zero-height area, and
    /// `render_room` calls this exactly once per frame with no early return.
    #[must_use]
    pub fn render(
        &mut self,
        area: ratatui::layout::Rect,
        buffer: &mut ratatui::buffer::Buffer,
    ) -> ResolvedSelectionModel {
        self.state.prepare_layout(area.width, area.height);
        ScrollbackPane::new()
            .active(true)
            .render_with_scratch(area, buffer, &self.state, &mut self.scratch)
            .selection_model
    }

    /// Resolve a feed click to the entry under it.
    ///
    /// Returns the entry's index (what selection uses), its STABLE id (what
    /// multi-click identity uses - three lanes insert rows between two clicks,
    /// so an index would move the gesture's subject), and whether it can be
    /// folded at all.
    pub fn feed_hit_at_screen_row(&self, screen_row: u16, feed: Rect) -> Option<RoomFeedHit> {
        let index = self.state.entry_index_at_screen_row(screen_row, feed)?;
        let entry = self.state.entry(index)?;
        Some(RoomFeedHit {
            index,
            entry_id: entry.id,
            foldable: entry.is_foldable(),
        })
    }

    pub fn select_entry(&mut self, index: usize) {
        self.state.set_selected(Some(index));
    }

    /// Back to the bottom and following again (spec §D.7's `End`).
    pub fn enable_follow_mode(&mut self) {
        self.state.enable_follow_mode();
    }

    /// Whether the feed is pinned to the bottom. Read by the tests that
    /// distinguish "`End` was taken" from "`End` fell through to the
    /// composer": the two look identical in the rendered rows of a room that
    /// was already at the bottom.
    pub fn is_following(&self) -> bool {
        self.state.is_follow_mode()
    }

    /// `(scroll offset, viewport height, total rows)` — the viewport's own
    /// numbers, for assertions that need to say the viewport did NOT move.
    pub fn scroll_info(&self) -> (usize, u16, usize) {
        self.state.scroll_info()
    }

    pub fn refresh_live_status(&mut self, reducer: &RoomReducer, tick: u64) {
        if !self.reduced_motion {
            self.state.tick();
            self.state.tick_running();
        }
        let lane_ids = self.lane_streams.keys().cloned().collect::<Vec<_>>();
        for lane_id in lane_ids {
            if reducer.lane(&lane_id).is_some_and(|lane| {
                matches!(lane.phase, LanePhase::Running | LanePhase::Cancelling)
            }) {
                self.sync_lane_activity(&lane_id, reducer, tick);
            }
        }
    }

    pub fn set_reduced_motion(&mut self, reduced_motion: bool) {
        self.reduced_motion = reduced_motion;
    }

    pub fn scroll_up(&mut self, rows: u16) {
        self.state.scroll_up(rows);
    }

    pub fn scroll_down(&mut self, rows: u16) {
        self.state.scroll_down(rows);
    }

    pub fn select_next(&mut self) {
        self.state.select_next();
    }

    pub fn select_prev(&mut self) {
        self.state.select_prev();
    }

    #[cfg(test)]
    pub(crate) fn selected_index(&self) -> Option<usize> {
        self.state.selected()
    }

    pub fn toggle_fold_selected(&mut self) {
        self.state.toggle_fold_selected();
    }

    pub fn toggle_raw_selected(&mut self) {
        self.state.toggle_raw_selected();
    }

    pub fn entry_id_for_stream(&self, stream_id: &str) -> Option<EntryId> {
        self.stream_entries
            .get(stream_id)
            .map(|binding| binding.entry_id)
    }

    pub fn entry_id_for_content(&self, content_id: &str) -> Option<EntryId> {
        self.content_entries.get(content_id).copied()
    }

    #[cfg(test)]
    fn stream_text(&self, stream_id: &str) -> Option<&str> {
        self.stream_entries
            .get(stream_id)
            .map(|binding| binding.text.as_str())
    }

    #[cfg(test)]
    pub(crate) fn searchable_text(&self) -> String {
        (0..self.state.len())
            .filter_map(|index| {
                self.state
                    .entry(index)
                    .and_then(|entry| entry.block.searchable_text())
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[cfg(test)]
    fn animation_tick(&self) -> u64 {
        self.state.animation_tick()
    }

    /// A local runtime failure is terminal presentation, not a second room
    /// transcript or backend state owner.
    pub fn push_runtime_failure(&mut self, message: &str) {
        let detail = compact_failure_detail(message).unwrap_or_else(|| "unknown error".into());
        self.state
            .push_block(RenderBlock::stub_compact_non_groupable(
                format!("room failed — {detail}"),
                RoomTheme::current().dead,
            ));
    }

    /// The room host's process ended, in the launcher's own words.
    ///
    /// Deliberately NOT `push_runtime_failure`. That one salvages one readable
    /// line out of a multi-line CLI error dump and then squeezes it to
    /// `MAX_FAILURE_DETAIL_WIDTH` columns FROM THE MIDDLE, which is right for a
    /// host's stderr and wrong for this: the sentence arrives as one line the
    /// launcher wrote for the operator, with no escapes and nothing to salvage,
    /// and its middle is the clause that says WHY the process ended. FL-143 cost
    /// three weeks because an operator could not tell a host m0irai killed from
    /// a host that crashed, and "m0irai ended the room host itself after
    /// wai … the host's)" is that same blindness with more characters in it.
    pub fn push_host_exit(&mut self, sentence: &str) {
        self.state
            .push_block(RenderBlock::stub_compact_non_groupable(
                format!("room failed — {sentence}"),
                RoomTheme::current().dead,
            ));
    }

    /// A client-owned notice is visible but never becomes durable room transcript state.
    pub fn push_local_notice(&mut self, message: impl Into<String>) {
        self.state
            .push_block(RenderBlock::stub_compact_non_groupable(
                message.into(),
                RoomTheme::current().dim,
            ));
    }

    fn push_transcript_entry(&mut self, entry: &TranscriptEntry, reducer: Option<&RoomReducer>) {
        let speaker = match &entry.author {
            TranscriptAuthor::Operator => RoomSpeaker::Operator,
            TranscriptAuthor::Agent(agent) => RoomSpeaker::from_agent(agent),
        };
        // CQ-04: the second of the two per-row lane scans, now the same O(1)
        // index lookup as `replay_seq`'s.
        let lane = reducer.and_then(|reducer| reducer.lane_for_message(&entry.message_id));
        let cohesion_group = self.allocate_cohesion_group();
        // FL-141: an AGENT entry is a lane row and is placed by roster; the
        // operator's own prompt is not a lane row at all and keeps its
        // chronological append. On a rebuild this is where a committed answer
        // re-enters the room, and keying it on its `message.committed`
        // sequence is exactly what put a cancelled lane above one that had
        // answered - see `lane_anchor`.
        let steps = lane
            .and_then(|lane| self.finalized_steps_block(lane, speaker, Some(&entry.occurred_at)));
        let header = speaker_header_block(speaker, Some(&entry.occurred_at));
        let message = RenderBlock::agent_message_with_accent(entry.text.clone(), speaker.color());
        let mut ids = Vec::new();
        let id = match lane {
            Some(lane) => {
                let order = LaneOrder::of(lane);
                ids.push(self.place_lane_block(order, header, Some(cohesion_group)));
                // One finalized steps block where the wall of frozen rows used
                // to be. The end timestamp is the transcript entry's own
                // `occurred_at`, which the reducer copies from the
                // `message.committed` event — the exact value the live path
                // passes to `commit_message`, so the two paths cannot compute
                // different durations for the same run.
                if let Some(block) = steps {
                    ids.push(self.place_lane_block(
                        order,
                        RenderBlock::RoomSteps(block),
                        Some(cohesion_group),
                    ));
                }
                let id = self.place_lane_block(order, message, Some(cohesion_group));
                ids.push(id);
                id
            }
            None => {
                let header_id = self.state.push_block_with_cohesion(header, cohesion_group);
                ids.push(header_id);
                let id = self.state.push_block_with_cohesion(message, cohesion_group);
                ids.push(id);
                id
            }
        };
        self.content_entries.insert(entry.message_id.clone(), id);
        self.content_speakers
            .insert(entry.message_id.clone(), speaker);
        // Memo §1.4 on the rebuild path too: a reloaded room's answers carry
        // their presentation group so a later rebuilt relocation can hang the
        // back-reference off the group's top row.
        if matches!(entry.author, TranscriptAuthor::Agent(_)) {
            let top = ids[0];
            self.remember_answer_group(&entry.message_id, cohesion_group, ids, top);
        }
    }

    /// Takes the whole `LaneState` rather than the lane id and agent name off
    /// it: FL-141 needs the lane's turn and roster position to place the three
    /// rows this draws, and both call sites already hold the lane.
    fn start_stream(&mut self, stream_id: &str, lane: &LaneState) {
        if self.stream_entries.contains_key(stream_id) {
            return;
        }
        let speaker = RoomSpeaker::from_agent(&lane.agent);
        let order = LaneOrder::of(lane);
        let cohesion_group = self.allocate_cohesion_group();
        // FL-141: placed, not pushed. `start_stream` appending at the end is
        // what let a lane cancelled while queued sit above a lower-roster lane
        // that had not started yet - the marker knew its roster position and
        // the header did not, so there was nothing for the marker to sort
        // against.
        let header_entry_id = self.place_lane_block(
            order,
            speaker_header_block(speaker, None),
            Some(cohesion_group),
        );
        let entry_id = self.place_lane_block(
            order,
            RenderBlock::agent_message_streaming_with_accent(speaker.color()),
            Some(cohesion_group),
        );
        self.state.set_entry_running(entry_id, true);
        // Keep the live line at the bottom of the block. Long streamed answers
        // can push content above the viewport, but the operator must still see
        // that this lane is active and what it is doing.
        let status_entry_id = self.place_lane_block(
            order,
            live_status_block(speaker, "working", Some(0), 0),
            Some(cohesion_group),
        );
        self.state.set_entry_running(status_entry_id, true);
        self.stream_entries.insert(
            stream_id.to_owned(),
            StreamBinding {
                header_entry_id,
                entry_id,
                status_entry_id,
                cohesion_group,
                text: String::new(),
                completed: false,
                status_cleared: false,
                speaker,
                activity_label: None,
                steps_entry_id: None,
                steps_folded: false,
                turn_id: lane.turn_id.clone(),
                roster_index: order.roster_index,
            },
        );
        self.lane_streams
            .insert(lane.id.clone(), stream_id.to_owned());
        self.lane_speakers.insert(lane.id.clone(), speaker);
    }

    fn push_stream_chunk(&mut self, stream_id: &str, text: &str) -> bool {
        let Some(binding) = self.stream_entries.get_mut(stream_id) else {
            return false;
        };
        if binding.completed {
            return false;
        }
        if self.state.push_chunk_to_agent(binding.entry_id, text) {
            binding.text.push_str(text);
            true
        } else {
            false
        }
    }

    fn commit_message(
        &mut self,
        lane_id: &str,
        content_id: &str,
        text: &str,
        reducer: &RoomReducer,
        facts: CommitFacts<'_>,
    ) {
        // Fold site 1 of 2 (SS-C.6). The commit event carries its own
        // `occurred_at`, which is the end of the measured span; the other site
        // is the lane's terminal event. Whichever arrives first wins the latch,
        // so a lane that both commits and completes shows one duration.
        if let Some(lane) = reducer.lane(lane_id) {
            self.fold_lane_steps(lane, facts.occurred_at);
        }
        let existing_stream = self.lane_streams.get(lane_id).cloned();
        if let Some(stream_id) = existing_stream {
            if let Some(binding) = self.stream_entries.get(&stream_id) {
                if let Some(suffix) = text.strip_prefix(&binding.text) {
                    self.push_stream_chunk(&stream_id, suffix);
                } else if binding.text != text {
                    let entry_id = binding.entry_id;
                    let speaker = binding.speaker;
                    // The committed message is canonical. Replace the native
                    // agent block in place so selection/search identity and
                    // stream ordering remain stable.
                    let replaced = self.state.replace_agent_message(
                        entry_id,
                        RenderBlock::agent_message_with_accent(text.to_owned(), speaker.color()),
                    );
                    debug_assert!(replaced, "live room stream must remain an agent message");
                }
            }
            let bound = if let Some(binding) = self.stream_entries.get_mut(&stream_id) {
                binding.text.clear();
                binding.text.push_str(text);
                binding.completed = true;
                self.state.finish_running(binding.entry_id);
                self.content_entries
                    .insert(content_id.to_owned(), binding.entry_id);
                self.content_speakers
                    .insert(content_id.to_owned(), binding.speaker);
                if let Some(occurred_at) = facts.occurred_at {
                    let replaced = self.state.replace_room_status(
                        binding.header_entry_id,
                        speaker_header_block(binding.speaker, Some(occurred_at)),
                    );
                    debug_assert!(replaced, "room speaker header remains a compact stub");
                }
                true
            } else {
                false
            };
            if bound {
                // FL-071: for a lane that commits without ever streaming a chunk,
                // the commit IS the answer's arrival - end the wait here too.
                self.clear_live_status(&stream_id);
                // Memo §1.5's order, from here: materialize the answer group
                // (AFTER the live status clears, so the retired row is not in
                // it), then evaluate the displacement predicate, insert the
                // back-reference if this commit qualifies, and move the whole
                // turn block.
                if let Some(binding) = self.stream_entries.get(&stream_id) {
                    let ids = [
                        Some(binding.header_entry_id),
                        binding.steps_entry_id,
                        Some(binding.entry_id),
                    ]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>();
                    self.remember_answer_group(
                        content_id,
                        binding.cohesion_group,
                        ids,
                        binding.header_entry_id,
                    );
                }
                if let Some(lane) = reducer.lane(lane_id) {
                    let turn_id = lane.turn_id.clone();
                    self.relocate_if_displaced(reducer, &turn_id, content_id, facts.commit_seq);
                }
                return;
            }
        }
        let speaker = reducer
            .transcript()
            .find(|entry| entry.message_id == content_id)
            .and_then(|entry| match &entry.author {
                TranscriptAuthor::Agent(agent) => Some(RoomSpeaker::from_agent(&agent)),
                TranscriptAuthor::Operator => None,
            })
            .or_else(|| self.lane_speakers.get(lane_id).copied())
            .unwrap_or(RoomSpeaker::Operator);
        // The unbound path draws its two rows chronologically, exactly as
        // before - but memo §1.3 names it a registry writer: both ids join the
        // lane's turn block so a LATER qualifying commit relocates them with
        // everything else that turn owns.
        let cohesion_group = self.allocate_cohesion_group();
        let (header_id, id) =
            self.push_agent_message(text.to_owned(), speaker, facts.occurred_at, cohesion_group);
        self.content_entries.insert(content_id.to_owned(), id);
        self.content_speakers.insert(content_id.to_owned(), speaker);
        self.remember_answer_group(content_id, cohesion_group, vec![header_id, id], header_id);
        if let Some(lane) = reducer.lane(lane_id) {
            self.remember_lane_row(&lane.turn_id, LaneOrder::of(lane).roster_index, header_id);
            self.remember_lane_row(&lane.turn_id, LaneOrder::of(lane).roster_index, id);
        }
    }

    /// Takes the whole `LaneState` rather than four fields off it: this now has
    /// to reach `activity`, `started_at` and `terminal_at` as well, and both
    /// call sites already hold the lane.
    fn finish_lane(&mut self, lane: &LaneState) {
        if !self.terminal_lanes.insert(lane.id.clone()) {
            return;
        }
        let speaker = RoomSpeaker::from_agent(&lane.agent);
        let cancelled = lane.phase == LanePhase::Cancelled;
        // A lane with no stream binding draws NOTHING here unless it was
        // cancelled, and there is deliberately no third arm for "no stream but
        // recorded steps" — the reducer cannot produce that lane.
        // `lane.activity` requires a `streamId` that matches the lane's own,
        // and only a Running or Cancelling lane has one, so activity implies a
        // started stream implies a binding (RP round 2;
        // `a_lane_cannot_record_activity_without_a_started_stream` in
        // `zer0-room-protocol` pins all three refusals). The arm that used to
        // sit here drew a fresh header and steps block; it was measured
        // unreachable by the whole suite and deleted rather than kept as a
        // defence, because what it would have drawn for a shape nobody
        // anticipated is a silently wrong row.
        if let Some(stream_id) = self.lane_streams.get(&lane.id).cloned() {
            self.settle_streamed_lane(lane, &stream_id);
        } else if cancelled {
            // FL-141: the arm above drew nothing for this lane - no stream ever
            // started (cancelled while still queued). The ruling still owes it
            // exactly one gray row; this is the only place left that can build
            // it, and there is nothing else in the group for a separate header
            // to be redundant with.
            self.place_lane_block(LaneOrder::of(lane), cancelled_header_block(speaker), None);
        }
        // FL-141: cancelled lanes no longer reach here - both arms above
        // already left one dim row carrying "cancelled" where the lane's own
        // work was (or would have been) drawn. Only a failure still gets a
        // dedicated outcome row; that presentation is unchanged by this slice.
        if lane.phase == LanePhase::Failed {
            self.push_lane_outcome(lane, "failed", lane.failure_reason.as_deref());
        }
    }

    /// Settle a lane that has a live stream binding: the row it already drew
    /// is the row it keeps, restyled where the outcome calls for it.
    fn settle_streamed_lane(&mut self, lane: &LaneState, stream_id: &str) {
        // Fold site 2 of 2 (SS-C.6). A lane can end without ever committing,
        // and that is exactly when an operator most wants to see what it did.
        self.fold_lane_steps(lane, lane.terminal_at.as_deref());
        if let Some(binding) = self.stream_entries.get_mut(stream_id)
            && !binding.completed
        {
            binding.completed = true;
            self.state.finish_running(binding.entry_id);
        }
        // The live line is causal work state, not lifecycle narration.
        // Once a lane settles, its answer timestamp is the success signal.
        self.clear_live_status(stream_id);
        // FL-141 (operator ruling, 2026-08-21, with a capture: "it doesn't
        // look good, the 3 from top should become gray and say cancelled
        // under, why spawn 3 new ones?"). Upstream restyles the one block a
        // lane already drew instead of appending a sibling -
        // `WorkflowBlockStatus::Cancelled` rewrites the same block's verb to
        // "cancelled" and switches its text style to `theme.dim()`
        // (`D:/grok-ref/crates/codegen/xai-grok-pager/src/scrollback/blocks/workflow.rs:98-113`).
        // This file used to diverge on purpose - the row below used to read
        // "explicit failed/cancelled rows below retain terminal truth" - but
        // the operator watched that divergence draw six rows for three
        // agents and overruled it: they are the one reading the screen.
        if lane.phase == LanePhase::Cancelled {
            self.mark_stream_cancelled(stream_id);
        }
    }

    /// FL-141: restyle a streamed lane's own header and message in place
    /// rather than appending a sibling row - both keep their entry id and
    /// position, so roster order is preserved automatically and nothing new
    /// enters the scrollback's own ordering for this arm at all.
    ///
    /// The header is restyled to `RoomTheme::faint` AND rewritten to read
    /// `<glyph> <agent> — cancelled`; the already-streamed answer dims with
    /// it. Two rows for a lane that answered, ONE for a lane that never got a
    /// chunk out — never a header plus a separate marker.
    ///
    /// ON the header, and this OVERRULES the note that used to sit here. That
    /// note argued the word had to go BENEATH the answer because
    /// `conpty_ui.rs`'s `long lane` proof cancels a codex lane after a
    /// 30-plus-line answer, and a header carrying the word scrolls out of the
    /// visible ConPTY viewport before `wait_screen` looks for it. The operator
    /// then ran the merged binary and read the cost of that choice: a header
    /// row AND a marker row, six gray lines for three agents (2026-08-22) —
    /// "it should display just the claude cancelled, codex cancelled and
    /// gemini cancelled that's it no?". Upstream rewrites the block's own
    /// header verb and dims it, appending nothing
    /// (`D:/grok-ref/crates/codegen/xai-grok-pager/src/scrollback/blocks/workflow.rs:98-113`).
    /// The ruling and upstream agree, so the word is back on the header.
    ///
    /// HAZARD the overruled note leaves behind, and it is real: a cancel that
    /// lands after a long answer changes a row the operator may already have
    /// scrolled past. `conpty_ui.rs`'s wait is on the substring
    /// `"codex — cancelled"`, which the header still carries, but a ConPTY
    /// screen only shows the viewport — if that proof starts timing out, this
    /// is why, and the answer is to scroll the assertion to the header, not to
    /// move the word off it again.
    ///
    /// A `Stub`, never text appended into the markdown message: a Stub is
    /// handed pre-built spans and never reaches the markdown parser, so the
    /// identity glyph survives. The markdown path destroys it on the legacy
    /// ASCII glyph set (codex's `#` read as a heading and vanished) —
    /// measured, and `the_cancelled_marker_survives_markdown_on_every_glyph_set`
    /// pins it.
    fn mark_stream_cancelled(&mut self, stream_id: &str) {
        let Some(binding) = self.stream_entries.get(stream_id) else {
            return;
        };
        let speaker = binding.speaker;
        let header_entry_id = binding.header_entry_id;
        let entry_id = binding.entry_id;
        let text = binding.text.clone();
        let replaced_header = self
            .state
            .replace_room_status(header_entry_id, cancelled_header_block(speaker));
        debug_assert!(
            replaced_header,
            "room speaker header remains a compact stub"
        );
        let faint = RoomTheme::current().faint;
        // Rail AND text. `agent_message_with_accent` sets only the rail, which
        // left the answer painted in the pager's default markdown foreground -
        // gray frame, full-colour text - and the test that claimed to pin it
        // was reading `accent_color()`, the rail, so it could not see the
        // difference. Upstream dims the spans (`workflow.rs:109-115`); this is
        // that, over rendered markdown.
        let replaced_message = self.state.replace_agent_message(
            entry_id,
            RenderBlock::agent_message_dimmed_with_accent(text, faint, faint),
        );
        debug_assert!(
            replaced_message,
            "live room stream must remain an agent message"
        );
    }

    /// FL-141: takes the lane, not just its agent name, because a failure row
    /// is a lane row like any other. Appending it put `claude — failed` at the
    /// bottom of the room when claude failed after codex had already drawn,
    /// which is the same settle-order defect the cancel ruling named.
    fn push_lane_outcome(&mut self, lane: &LaneState, outcome: &str, detail: Option<&str>) {
        let speaker = RoomSpeaker::from_agent(&lane.agent);
        let mut text = format!("{} {} — {outcome}", speaker.glyph(), speaker.label());
        if let Some(detail) = detail.and_then(compact_failure_detail) {
            text.push_str(": ");
            text.push_str(&detail);
        }
        let block = RenderBlock::stub_compact_non_groupable(
            text,
            if outcome == "failed" {
                RoomTheme::current().dead
            } else {
                RoomTheme::current().faint
            },
        );
        self.place_lane_block(LaneOrder::of(lane), block, None);
    }

    fn push_backend_failure(&mut self, failure: &BackendFailure) {
        let mut text = "backend failed".to_owned();
        let message = failure.message.as_deref().and_then(compact_failure_detail);
        let error = failure.error.as_deref().and_then(compact_failure_detail);
        if let Some(message) = message.as_deref() {
            text.push_str(" — ");
            text.push_str(message);
        }
        if let Some(error) = error.as_deref() {
            text.push_str(if message.is_some() { ": " } else { " — " });
            text.push_str(error);
        }
        self.state
            .push_block(RenderBlock::stub_compact_non_groupable(
                text,
                RoomTheme::current().dead,
            ));
    }

    /// One dim, compact, non-groupable row at the notice's own place in the transcript.
    ///
    /// Upstream grok puts a durable, copyable, non-fatal notice INTO the transcript as a system
    /// block rather than into transient chrome — `open_url_or_show`
    /// (D:/grok-ref/crates/codegen/xai-grok-pager/src/app/agent_view/notices.rs:350-366) pushes
    /// `RenderBlock::system(...)` (`scrollback/block.rs:770-772`) so the text stays where the user
    /// can find and copy it. This room already had the row primitive in `push_local_notice` above,
    /// but that one is CLIENT-owned: nothing journals it and a reload loses it. This path is the
    /// durable half, modelled on `push_backend_failure` next door, so live and rebuilt agree.
    ///
    /// The text comes ENTIRELY from `notice_phrase`. The event's `detail` never reaches this
    /// function, and cannot: `RoomNotice` does not carry it.
    fn push_room_notice(&mut self, notice: &RoomNotice) {
        self.state
            .push_block(RenderBlock::stub_compact_non_groupable(
                notice_phrase(&notice.cause).to_owned(),
                RoomTheme::current().dim,
            ));
    }

    fn push_hop(&mut self, hop: &HopState) {
        if !self.hop_entries.insert(hop.hop_id.clone()) {
            return;
        }
        let from = RoomSpeaker::from_agent(&hop.from_agent);
        let to = RoomSpeaker::from_agent(&hop.to_agent);
        let blocked = hop.disposition == HopDisposition::Blocked;
        let outcome = if blocked { " · blocked" } else { "" };
        let hop_marker = room_secondary(RoomSecondaryGlyph::HopMarker);
        let hop_arrow = room_secondary(RoomSecondaryGlyph::HopArrow);
        let plain_header = format!(
            "{hop_marker} {} {} {hop_arrow} {} {} · hop {}/{}{}",
            from.glyph(),
            from.label(),
            to.glyph(),
            to.label(),
            hop.hop_index,
            hop.hop_budget,
            outcome
        );
        let mut lines = vec![Line::from(vec![
            Span::styled(format!("{hop_marker} "), Style::default().fg(from.color())),
            Span::styled(
                format!("{} {}", from.glyph(), from.label()),
                Style::default().fg(from.color()),
            ),
            Span::raw(format!(" {hop_arrow} ")),
            Span::styled(
                format!("{} {}", to.glyph(), to.label()),
                Style::default().fg(to.color()),
            ),
            Span::raw(format!(" · hop {}/{}", hop.hop_index, hop.hop_budget)),
            Span::styled(
                outcome,
                Style::default().fg(if blocked {
                    RoomTheme::current().dead
                } else {
                    RoomTheme::current().dim
                }),
            ),
        ])];
        let quote = hop.text.as_deref().map(compact_handoff_text);
        if let Some(quote) = quote.as_deref().filter(|quote| !quote.is_empty()) {
            lines.push(Line::from(Span::styled(
                format!("  “{quote}”"),
                Style::default().fg(RoomTheme::current().dim),
            )));
        }
        let plain = quote
            .map(|quote| format!("{plain_header}\n  “{quote}”"))
            .unwrap_or(plain_header);
        self.state
            .push_block(RenderBlock::stub_styled_compact_non_groupable(
                plain,
                lines,
                from.color(),
            ));
    }

    /// Draws a speaker header plus the agent's message block, both in the
    /// caller's cohesion group, and returns `(header_id, message_id)` so the
    /// caller can register them with the turn-block registry (memo §1.3 names
    /// this site one of its writers).
    fn push_agent_message(
        &mut self,
        text: String,
        speaker: RoomSpeaker,
        occurred_at: Option<&str>,
        cohesion_group: u64,
    ) -> (EntryId, EntryId) {
        let header_id = self.push_speaker_header(speaker, occurred_at, cohesion_group);
        let message_id = self.state.push_block_with_cohesion(
            RenderBlock::agent_message_with_accent(text, speaker.color()),
            cohesion_group,
        );
        (header_id, message_id)
    }

    fn push_speaker_header(
        &mut self,
        speaker: RoomSpeaker,
        occurred_at: Option<&str>,
        cohesion_group: u64,
    ) -> EntryId {
        self.state
            .push_block_with_cohesion(speaker_header_block(speaker, occurred_at), cohesion_group)
    }

    fn sync_lane_activity(&mut self, lane_id: &str, reducer: &RoomReducer, tick: u64) {
        let Some(stream_id) = self.lane_streams.get(lane_id).cloned() else {
            return;
        };
        let activities = reducer
            .ordered_activity_for_lane(lane_id)
            .cloned()
            .collect::<Vec<_>>();
        let latest = activities
            .iter()
            .max_by(|left, right| {
                decimal_cmp(&left.last_event_seq, &right.last_event_seq)
                    .expect("RoomReducer retains validated decimal activity sequences")
            })
            .and_then(|activity| activity_label(activity));
        let cancelling = reducer
            .lane(lane_id)
            .is_some_and(|lane| lane.phase == LanePhase::Cancelling);
        let Some(binding) = self.stream_entries.get_mut(&stream_id) else {
            return;
        };
        let speaker = binding.speaker;
        binding.activity_label = latest;
        // FL-071 (operator, live run 2026-08-19). The working row is the WAITING
        // signal, so it must not outlive the answer. Keying it off lane settle did:
        // across all six lanes of that run the host committed 0.684-7.910 s after
        // the lane's last `lane.chunk`, and the streamed text was byte-identical to
        // the committed text, so a finished answer sat under a counting spinner for
        // seconds. Delivered text ends the wait.
        //
        // Cancelling is the exception, and it is not a "working" animation: it is
        // the room acknowledging the operator's own cancel, and they are owed that
        // even under a delivered answer. `write_live_status` brings the row back
        // for exactly that case.
        //
        // HAZARD: this is the only place the row is retired on the happy path - a
        // lane that streams nothing is retired by `commit_message`, and a failed or
        // cancelled one by `finish_lane`.
        let delivered = binding.completed || !binding.text.is_empty();
        if delivered && !cancelling {
            self.clear_live_status(&stream_id);
        } else {
            let label = if cancelling {
                "cancelling"
            } else {
                binding.activity_label.as_deref().unwrap_or("working")
            };
            let elapsed_seconds = reducer
                .lane(lane_id)
                .and_then(|lane| lane.started_at.as_deref())
                .and_then(elapsed_seconds);
            let motion_tick = if self.reduced_motion { 0 } else { tick };
            let block = live_status_block(speaker, label, elapsed_seconds, motion_tick);
            self.write_live_status(&stream_id, block);
        }
        if let Some(lane) = reducer.lane(lane_id) {
            self.sync_lane_steps(lane, speaker);
        }
    }

    /// Render `block` as the lane's live status row, re-creating the row when a
    /// delivered answer already retired it. Only a cancel reaches the re-create
    /// path: nothing else asks for a status row after the answer is on screen.
    fn write_live_status(&mut self, stream_id: &str, block: RenderBlock) {
        let Some((status_entry_id, cohesion_group, cleared, turn_id, roster_index)) =
            self.stream_entries.get(stream_id).map(|binding| {
                (
                    binding.status_entry_id,
                    binding.cohesion_group,
                    binding.status_cleared,
                    binding.turn_id.clone(),
                    binding.roster_index,
                )
            })
        else {
            return;
        };
        if !cleared {
            let replaced = self.state.replace_room_status(status_entry_id, block);
            debug_assert!(replaced, "room live status remains a compact stub");
            return;
        }
        // The re-created row APPENDS (the old id's slot is gone), so it joins
        // the registry at its lane's seat — the same writer duty the first
        // creation had through `place_lane_block` (memo §1.3).
        let entry = self.state.push_block_with_cohesion(block, cohesion_group);
        self.state.set_entry_running(entry, true);
        self.remember_lane_row(&turn_id, roster_index, entry);
        if let Some(binding) = self.stream_entries.get_mut(stream_id) {
            binding.status_entry_id = entry;
            binding.status_cleared = false;
        }
    }

    /// Retire a lane's live status row exactly once. Three call sites can reach
    /// it - the answer arriving, the commit, the terminal event - and whichever
    /// runs first owns the removal; the rest are no-ops. Idempotence matters
    /// because `sync_lane_activity` runs on every animation tick.
    fn clear_live_status(&mut self, stream_id: &str) {
        let Some(binding) = self.stream_entries.get_mut(stream_id) else {
            return;
        };
        if binding.status_cleared {
            return;
        }
        binding.status_cleared = true;
        let status_entry_id = binding.status_entry_id;
        let turn_id = binding.turn_id.clone();
        let roster_index = binding.roster_index;
        let removed = self.state.remove_entry(status_entry_id);
        debug_assert!(
            removed,
            "a lane's live status row is present until it is cleared"
        );
        // The row is gone from the feed; it leaves the registry with it, or a
        // relocation would move a phantom member (memo §1.3's recycler duty).
        self.forget_lane_row(&turn_id, roster_index, status_entry_id);
    }

    /// This lane's folded steps as a block, or `None` when it produced no
    /// terminal step.
    ///
    /// `None` is load-bearing: the entry is never created, so a stream that ran
    /// no tools renders byte-identically to the way it rendered before this
    /// block existed.
    fn finalized_steps_block(
        &self,
        lane: &LaneState,
        speaker: RoomSpeaker,
        end_at: Option<&str>,
    ) -> Option<RoomStepsBlock> {
        let block = RoomStepsBlock::finalized(
            &lane.activity,
            speaker.color(),
            lane.started_at.as_deref(),
            end_at,
        );
        (!block.is_empty()).then_some(block)
    }

    /// Create-or-replace this stream's live steps entry.
    ///
    /// Runs on every `lane.activity` event and every animation tick while the
    /// lane is running. It never creates a second entry: the id is allocated
    /// once and every later step replaces the block behind that same id, so the
    /// structural scroll anchor is armed once instead of once per step and slice
    /// D has one id to move rather than an unknown number of them.
    fn sync_lane_steps(&mut self, lane: &LaneState, speaker: RoomSpeaker) {
        let Some(stream_id) = self.lane_streams.get(&lane.id).cloned() else {
            return;
        };
        // Once folded it stays folded. A later step for the same stream cannot
        // arrive - the reducer rejects `lane.activity` for a lane that is not
        // Running or Cancelling - so there is no re-open case to handle.
        if self
            .stream_entries
            .get(&stream_id)
            .is_none_or(|binding| binding.steps_folded)
        {
            return;
        }
        let block = RoomStepsBlock::live(&lane.activity, speaker.color());
        if block.is_empty() {
            return;
        }
        self.write_steps_block(&stream_id, block);
    }

    /// Fold this lane's steps into the one summary row, exactly once.
    ///
    /// The latch is set before the block is built, so a lane with no steps still
    /// closes the gate - otherwise the second fold site would rebuild a live
    /// block over a finalized one for a lane whose only step arrived late.
    fn fold_lane_steps(&mut self, lane: &LaneState, end_at: Option<&str>) {
        let Some(stream_id) = self.lane_streams.get(&lane.id).cloned() else {
            return;
        };
        let Some(binding) = self.stream_entries.get_mut(&stream_id) else {
            return;
        };
        if binding.steps_folded {
            return;
        }
        binding.steps_folded = true;
        let speaker = binding.speaker;
        let Some(block) = self.finalized_steps_block(lane, speaker, end_at) else {
            return;
        };
        self.write_steps_block(&stream_id, block);
    }

    /// Put `block` behind this stream's steps entry, allocating that entry the
    /// first time.
    ///
    /// The entry sits immediately above the stream's answer, which is where the
    /// frozen step rows it replaces used to be - so the folded row keeps the
    /// "what it did, then what it said" reading order.
    fn write_steps_block(&mut self, stream_id: &str, block: RoomStepsBlock) {
        let Some((steps_entry_id, entry_id, cohesion_group, turn_id, roster_index)) =
            self.stream_entries.get(stream_id).map(|binding| {
                (
                    binding.steps_entry_id,
                    binding.entry_id,
                    binding.cohesion_group,
                    binding.turn_id.clone(),
                    binding.roster_index,
                )
            })
        else {
            return;
        };
        if let Some(id) = steps_entry_id {
            // An unchanged block is not written. `sync_lane_steps` runs on every
            // animation tick while the lane is live, and `replace_room_steps`
            // bumps the content generation and dirties the entry's height every
            // time it is called - so a room that rebuilt an identical block per
            // tick would invalidate layout sixty times a second to paint the
            // same row. The old frozen-row path was idempotent through its
            // `activity_entries` map; this is what replaces that property.
            if self
                .state
                .get_by_id(id)
                .is_some_and(|entry| matches!(&entry.block, RenderBlock::RoomSteps(current) if current == &block))
            {
                return;
            }
            let replaced = self
                .state
                .replace_room_steps(id, RenderBlock::RoomSteps(block));
            debug_assert!(replaced, "a room steps entry stays a room steps block");
            return;
        }
        let id = self.state.insert_block_before_with_cohesion(
            entry_id,
            RenderBlock::RoomSteps(block),
            cohesion_group,
        );
        // Memo §1.3: this site is one of the registry's writers. The steps row
        // materializes mid-group (above the answer), so it must join the turn
        // block or a later relocation would leave it behind.
        self.remember_lane_row(&turn_id, roster_index, id);
        if let Some(binding) = self.stream_entries.get_mut(stream_id) {
            binding.steps_entry_id = Some(id);
        }
    }

    fn allocate_cohesion_group(&mut self) -> u64 {
        let group = self.next_cohesion_group;
        self.next_cohesion_group = self.next_cohesion_group.saturating_add(1).max(1);
        group
    }
}

fn speaker_header_block(speaker: RoomSpeaker, occurred_at: Option<&str>) -> RenderBlock {
    let timestamp = occurred_at.and_then(room_time);
    let plain = timestamp.as_ref().map_or_else(
        || format!("{} {}", speaker.glyph(), speaker.label()),
        |timestamp| format!("{} {} · {timestamp}", speaker.glyph(), speaker.label()),
    );
    let mut spans = vec![Span::styled(
        format!("{} {}", speaker.glyph(), speaker.label()),
        Style::default()
            .fg(speaker.color())
            .add_modifier(Modifier::BOLD),
    )];
    if let Some(timestamp) = timestamp {
        spans.push(Span::styled(
            format!(" · {timestamp}"),
            Style::default().fg(RoomTheme::current().dim),
        ));
    }
    if speaker == RoomSpeaker::Operator {
        RenderBlock::stub_styled_compact_non_groupable_without_accent(
            plain,
            vec![Line::from(spans)],
            speaker.color(),
        )
    } else {
        RenderBlock::stub_styled_compact_non_groupable(
            plain,
            vec![Line::from(spans)],
            speaker.color(),
        )
    }
}

/// FL-141: the exact wording `push_lane_outcome` used to draw as a separate
/// row, identity glyph included - so every existing "{agent} — cancelled"
/// substring check (this file's own tests, `conpty_ui.rs`) still matches
/// regardless of which entry carries it.
///
/// The glyph left this string for one round and came back. It was dropped
/// because the streamed arm appended the marker into a MARKDOWN message, and
/// under `GROK_FORCE_LEGACY_CONSOLE=1` the identity glyphs are ASCII
/// (`RoomIdentityGlyphSet::Ascii`: claude `*`, codex `#`, gemini `+`) - which
/// markdown reads as syntax. Measured, not reasoned:
///
///   "* claude — cancelled"  ->  "• claude — cancelled"   (bullet list item)
///   "# codex — cancelled"   ->  "codex — cancelled"      (heading, `#` eaten)
///   "+ gemini — cancelled"  ->  "+ gemini — cancelled"   (survived)
///
/// Escaping was measured too and is not available: `\*` renders as a literal
/// `\*`, backslash included.
///
/// HAZARD, and the reason the glyph is safe again: EVERY caller now draws this
/// into a `Stub`, which is handed pre-built spans and never reaches the
/// markdown parser. `mark_stream_cancelled` no longer appends it to the
/// message text. Put this string back inside a markdown block and codex loses
/// its `#` again - silently, and only on the legacy console, so it will look
/// right everywhere you are likely to check.
/// `the_cancelled_marker_survives_markdown_on_every_glyph_set` is the witness.
fn cancelled_row_text(speaker: RoomSpeaker) -> String {
    format!("{} {} — cancelled", speaker.glyph(), speaker.label())
}

/// FL-141b: THE row a cancelled lane owns — `speaker_header_block`'s
/// no-timestamp text with the word appended, in `RoomTheme::faint`. One
/// builder for all three arms, because after the 2026-08-22 ruling the header
/// and the "marker" are the same row: a lane that never streamed draws only
/// this, a lane that did draws this plus its dimmed answer, and a lane
/// rebuilt from steps draws this plus its `RoomSteps` block.
///
/// Built as a `Stub`, matching `speaker_header_block`, so
/// `replace_room_status` (which only accepts Stub-to-Stub) can put it where a
/// real header already sits — which is how the streamed arm restyles in
/// place and keeps its position in roster order.
fn cancelled_header_block(speaker: RoomSpeaker) -> RenderBlock {
    let text = cancelled_row_text(speaker);
    let faint = RoomTheme::current().faint;
    RenderBlock::stub_styled_compact_non_groupable(
        text.clone(),
        vec![Line::from(Span::styled(text, Style::default().fg(faint)))],
        faint,
    )
}

fn live_status_block(
    speaker: RoomSpeaker,
    label: &str,
    elapsed_seconds: Option<i64>,
    tick: u64,
) -> RenderBlock {
    let elapsed = elapsed_seconds.map(|seconds| format!(" ({seconds}s)"));
    let spinner = room_spinner(tick);
    let ellipsis = room_secondary(RoomSecondaryGlyph::Ellipsis);
    let plain = format!(
        "{spinner} {label}{ellipsis}{}",
        elapsed.as_deref().unwrap_or_default()
    );
    let mut spans = vec![Span::styled(
        format!("{spinner} {label}{ellipsis}"),
        Style::default().fg(speaker.color()),
    )];
    if let Some(elapsed) = elapsed {
        spans.push(Span::styled(
            elapsed,
            Style::default().fg(RoomTheme::current().dim),
        ));
    }
    RenderBlock::stub_styled_compact_non_groupable(plain, vec![Line::from(spans)], speaker.color())
}

fn room_time(occurred_at: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(occurred_at)
        .ok()
        .map(|time| {
            time.with_timezone(&chrono::Local)
                .format("%-I:%M %p")
                .to_string()
        })
}

pub(crate) fn activity_label(activity: &LaneActivity) -> Option<String> {
    [
        activity.title.as_deref(),
        activity.kind.as_deref(),
        activity.status.as_deref(),
    ]
    .into_iter()
    .flatten()
    .map(str::trim)
    .find(|value| !value.is_empty())
    .map(|value| value.replace('_', " "))
}

fn elapsed_seconds(started_at: &str) -> Option<i64> {
    let started = chrono::DateTime::parse_from_rfc3339(started_at).ok()?;
    Some(
        chrono::Utc::now()
            .signed_duration_since(started.with_timezone(&chrono::Utc))
            .num_seconds()
            .max(0),
    )
}

fn compact_handoff_text(text: &str) -> String {
    let compact = text.split_whitespace().collect::<Vec<_>>().join(" ");
    compact.chars().take(240).collect()
}

/// Provider failures are durable diagnostics, but their raw terminal output is
/// not room prose. Strip escape sequences, neutralize hidden controls, collapse
/// multi-line logs to one readable sentence, and keep the feed bounded.
fn compact_failure_detail(value: &str) -> Option<String> {
    let stripped = strip_ansi_escapes::strip_str(value);
    let lines = stripped
        .lines()
        .map(|line| {
            line.chars()
                .map(|character| {
                    let code = character as u32;
                    let hidden = character.is_control()
                        || matches!(
                            code,
                            0x061c
                                | 0x200b..=0x200f
                                | 0x202a..=0x202e
                                | 0x2060
                                | 0x2066..=0x2069
                                | 0xfeff
                        );
                    if hidden { ' ' } else { character }
                })
                .collect::<String>()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    let mut compact = lines
        .iter()
        .find(|line| line.to_ascii_lowercase().contains("failed to "))
        .or_else(|| {
            lines
                .iter()
                .find(|line| line.to_ascii_lowercase().contains("error:"))
        })
        .or_else(|| lines.first())?
        .to_string();
    if let Some(index) = compact.to_ascii_lowercase().find("failed to ") {
        compact = compact[index..].to_string();
    }
    Some(truncate_failure_middle(&compact, MAX_FAILURE_DETAIL_WIDTH))
}

fn truncate_failure_middle(value: &str, max_width: usize) -> String {
    if UnicodeWidthStr::width(value) <= max_width {
        return value.to_string();
    }
    let marker = format!(" {} ", room_secondary(RoomSecondaryGlyph::Ellipsis));
    let marker_width = UnicodeWidthStr::width(marker.as_str());
    if max_width <= marker_width {
        return crate::util::truncate_to_width(value, max_width).into_owned();
    }
    let available = max_width - marker_width;
    let head_budget = available * 3 / 5;
    let tail_budget = available - head_budget;
    let mut head = String::new();
    let mut head_width = 0;
    for character in value.chars() {
        let width = UnicodeWidthChar::width(character).unwrap_or(0);
        if head_width + width > head_budget {
            break;
        }
        head.push(character);
        head_width += width;
    }
    let mut tail = Vec::new();
    let mut tail_width = 0;
    for character in value.chars().rev() {
        let width = UnicodeWidthChar::width(character).unwrap_or(0);
        if tail_width + width > tail_budget {
            break;
        }
        tail.push(character);
        tail_width += width;
    }
    tail.reverse();
    format!("{head}{marker}{}", tail.into_iter().collect::<String>())
}

fn required_payload_string<'a>(event: &'a RoomEvent, key: &str) -> &'a str {
    event.payload[key]
        .as_str()
        .expect("RoomReducer accepted a room event with this required payload field")
}

/// Slice D's cross-turn relocation and FL-141's turn-block registry, moved out
/// whole when this file passed 2,300 lines. One seam, two maps, no behaviour
/// change — see that file's own header.
mod relocation;

/// Room fixtures shared by every test module that needs a room with real
/// history in it.
///
/// Test-only and deliberately event-driven: a fixture assembled by hand would
/// be a second implementation of the room, and the first thing it would stop
/// catching is the room changing.
#[cfg(all(test, feature = "room-runtime"))]
pub(crate) mod test_fixture;

/// This file's tests, moved out whole when it reached 4400 lines - 65 % of
/// them test - and the room's production surface stopped being readable
/// inside it. Nothing about them changed in the move: `tests` is every
/// `#[test]` it had, `test_support` is the `#[cfg(test)] impl RoomScrollback`
/// block of helpers those tests drive the room with, and `test_fixture` is
/// the event-driven fixture `room_view.rs` shares.
#[cfg(all(test, feature = "room-runtime"))]
mod tests;

#[cfg(all(test, feature = "room-runtime"))]
mod test_support;
