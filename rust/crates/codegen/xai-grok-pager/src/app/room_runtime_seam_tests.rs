//! The seams three builders are about to work across, pinned before they start.
//!
//! Nothing here proves a feature. Every test in this file locks behaviour that
//! ALREADY ships, so that the refactor which made room for the features cannot
//! move it: one busy predicate where there were two, one owner for the guidance
//! row where three slices each want to paint, and one keyboard namespace where
//! three slices each want a chord.
//!
//! Read the tags. A [PIN] passes on the tree it was written against — that is
//! what it is for — so its evidence is the mutation that breaks it, quoted in
//! the handback. A [FALSIFIER] fails against the tree before the change.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Style};
use ratatui::text::Text;
use ratatui::widgets::{Paragraph, Widget};
use serde_json::json;
use tokio::sync::mpsc;
use xai_ratatui_textarea::{EditCommand, classify_key_event};
use zer0_room_protocol::{LanePhase, RoomReducer};

use super::tests::{apply, event, footer_buffer, row_text};
use super::{
    KeyDisposition, RoomCommand, guidance_row, lane_busy, render_room, room_footer,
    room_prompt_style,
};
use crate::room_composer_menu::RoomCatalogAgent;
use crate::room_theme::{RoomIdentity, RoomTheme};
use crate::room_view::RoomView;

/// A room assembled out of real events, in order.
///
/// The reducer refuses a gap in the event sequence, so the counter lives with
/// the builder: a fixture that has to do its own sequence arithmetic gets it
/// wrong the first time somebody inserts an event in the middle.
struct RoomFixture {
    room: RoomView,
    seq: u64,
}

impl RoomFixture {
    /// One accepted turn with a queued lane for every named agent.
    fn turn(agents: &[&str]) -> Self {
        let mut fixture = Self {
            room: RoomView::new(),
            seq: 0,
        };
        fixture = fixture.emit(
            "turn.accepted",
            json!({"agents":agents,"text":"inspect the room","messageId":"operator-1","ledgerSeq":"1"}),
        );
        fixture = fixture.emit("route.resolved", json!({"agents":agents}));
        for agent in agents {
            fixture = fixture.emit(
                "lane.queued",
                json!({"laneId":format!("lane-{agent}"),"agent":agent,"expectedMessageId":format!("message-{agent}"),"origin":"operator","hopIndex":0}),
            );
        }
        fixture
    }

    fn emit(mut self, kind: &str, payload: serde_json::Value) -> Self {
        self.seq += 1;
        apply(&mut self.room, event(self.seq, kind, payload));
        self
    }

    fn started(self, agent: &str) -> Self {
        self.emit(
            "lane.started",
            json!({"laneId":format!("lane-{agent}"),"streamId":format!("stream-{agent}"),"agent":agent}),
        )
    }

    fn done(self) -> RoomView {
        self.room
    }
}

/// A room where every named agent holds a queued lane on one accepted turn.
fn turn_with(agents: &[&str]) -> RoomView {
    RoomFixture::turn(agents).done()
}

/// One agent working and the other two with no lane at all — the frame the
/// operator actually sees when they address a single agent.
fn one_agent_running(agent: &str) -> RoomView {
    let room = RoomFixture::turn(&[agent]).started(agent).done();
    assert!(
        lane_busy(&room.reducer, Some(agent)),
        "the fixture must really hold a running lane for {agent}"
    );
    room
}

/// Where an agent's footer cell begins, by the arithmetic `room_footer_at` uses
/// to lay the three of them out: each agent gets `min(width, 180) / 3` columns,
/// and the remainder goes to the leftmost cells one column at a time.
fn footer_band_start(width: u16, identity: RoomIdentity) -> u16 {
    let logical_width = width.min(180);
    let base = logical_width / 3;
    let remainder = logical_width % 3;
    let index: u16 = match identity {
        RoomIdentity::Claude => 0,
        RoomIdentity::Codex => 1,
        RoomIdentity::Gemini => 2,
        RoomIdentity::You => panic!("`you` is a speaker, not a footer chip"),
    };
    (0..index).map(|i| base + u16::from(i < remainder)).sum()
}

/// The colour of an agent's footer chip on this frame.
///
/// ⚠ **Located by position, and it must stay that way.** This helper used to
/// search the whole footer for the identity's glyph, on the assumption that a
/// glyph is unique there. It is not — the identities and the metadata row share
/// an alphabet. Codex's ASCII glyph is `#` and the metadata row always prints
/// `m0irai · #{session}`, so on the ASCII glyph set — the default on a legacy
/// Windows console, a **supported render path** — the search found two cells and
/// panicked before reading any colour. Two chip pins failed there while passing
/// everywhere else, which is a pin that does not hold on a path the product
/// ships.
///
/// So: row 0, the identities line, at the agent's own band start — the shape
/// this repo already uses to read a cell's colour, `buf.cell((area.x + 1, y))
/// .and_then(|c| c.style().fg)` at `views/settings_modal/tests.rs:2774`. Indexing
/// a known rect cannot collide with content that happens to share a character,
/// and it keeps working when a suffix changes width.
///
/// The symbol assertion is an addition, not part of that pattern: coordinates
/// are only right while the layout is, so if a band ever moves this would read a
/// neighbour's colour and silently pass. The tripwire is what stops it.
fn chip_fg(footer: &Buffer, identity: RoomIdentity) -> Color {
    let x = footer_band_start(footer.area.width, identity);
    let cell = footer
        .cell((x, 0))
        .unwrap_or_else(|| panic!("{}'s band starts outside the footer", identity.label()));
    assert_eq!(
        cell.symbol(),
        identity.glyph(),
        "{}'s band does not start with its glyph; the footer layout moved",
        identity.label()
    );
    cell.fg
}

// ---------------------------------------------------------------------------
// The busy predicate
// ---------------------------------------------------------------------------

/// The chip's own check, copied verbatim from `room_runtime.rs:1225-1227` as it
/// stood at `6844cca`, before `lane_busy` replaced it.
fn legacy_chip_working(reducer: &RoomReducer, agent: &str) -> bool {
    reducer.ordered_lanes().any(|lane| {
        lane.agent == agent && matches!(lane.phase, LanePhase::Running | LanePhase::Cancelling)
    })
}

/// The redraw pump's own check, copied verbatim from `room_runtime.rs:227-231`
/// as it stood at `6844cca`.
fn legacy_pump_busy(reducer: &RoomReducer) -> bool {
    reducer
        .ordered_lanes()
        .any(|lane| matches!(lane.phase, LanePhase::Running | LanePhase::Cancelling))
}

/// The two ways a lane reaches `Cancelled`, each named by the phase it held on
/// the way in.
///
/// The approach phase is what the fixtures are **built from**, not a label
/// hung on them, and that is the whole point. The property these two rows exist
/// to carry is that they arrive at the terminal phase from opposite sides of
/// `lane_busy`: a cancelling lane IS busy on the way in, a queued one never was.
/// An implementation that treats the terminal phase as busy leaves the chip lit
/// and the redraw pump spinning forever, and only the busy-side route can see
/// that. A check that merely counted two named rows was satisfied by two rows
/// taking the same road — run, and it stayed green — so the road is now the
/// data and the labels are only how failures read.
const CANCELLED_ROUTES: &[(&str, LanePhase)] = &[
    ("claude cancelled from cancelling", LanePhase::Cancelling),
    ("claude cancelled from queued", LanePhase::Queued),
];

/// A claude lane sitting in `approach`, one event short of being cancelled.
fn approaching_cancelled(approach: &LanePhase) -> RoomFixture {
    let fixture = RoomFixture::turn(&["claude"]);
    match approach {
        LanePhase::Queued => fixture,
        LanePhase::Cancelling => fixture.started("claude").emit(
            "lane.cancelling",
            json!({"laneId":"lane-claude","agent":"claude"}),
        ),
        other => panic!("no fixture here reaches Cancelled from {other:?}"),
    }
}

/// That lane, cancelled.
fn cancelled_via(approach: &LanePhase) -> RoomView {
    // A lane that never started has no stream to name, and one that did must
    // name it — so the two routes do not carry the same payload, and cannot.
    let payload = match approach {
        LanePhase::Cancelling => {
            json!({"laneId":"lane-claude","agent":"claude","streamId":"stream-claude"})
        }
        _ => json!({"laneId":"lane-claude","agent":"claude"}),
    };
    approaching_cancelled(approach)
        .emit("lane.cancelled", payload)
        .done()
}

/// Every lane phase the room can hold, each reached through the real reducer
/// rather than by writing a phase into a struct.
fn lane_phase_states() -> Vec<(&'static str, RoomView)> {
    let running_claude = || RoomFixture::turn(&["claude"]).started("claude");
    let committed_claude = || {
        running_claude().emit(
            "message.committed",
            json!({"laneId":"lane-claude","agent":"claude","messageId":"message-claude","text":"an answer","ledgerSeq":"2","origin":"operator","hopIndex":0}),
        )
    };
    let mut states: Vec<(&'static str, RoomView)> = vec![
        ("no lanes at all", RoomView::new()),
        ("claude queued", turn_with(&["claude"])),
        ("claude running", running_claude().done()),
        (
            "all three running",
            RoomFixture::turn(&["claude", "codex", "gemini"])
                .started("claude")
                .started("codex")
                .started("gemini")
                .done(),
        ),
        (
            "claude cancelling",
            running_claude()
                .emit(
                    "lane.cancelling",
                    json!({"laneId":"lane-claude","agent":"claude"}),
                )
                .done(),
        ),
        ("claude committed", committed_claude().done()),
        (
            "claude completed",
            committed_claude()
                .emit(
                    "lane.completed",
                    json!({"laneId":"lane-claude","agent":"claude","streamId":"stream-claude"}),
                )
                .done(),
        ),
        (
            "claude failed",
            running_claude()
                .emit(
                    "lane.failed",
                    json!({"laneId":"lane-claude","agent":"claude","streamId":"stream-claude","error":"provider failed"}),
                )
                .done(),
        ),
        // The two routes into `Cancelled` are generated from the table that
        // declares how each one gets there, so a fixture cannot drift from the
        // road its row names — see `CANCELLED_ROUTES`.
    ];
    states.extend(
        CANCELLED_ROUTES
            .iter()
            .map(|(label, approach)| (*label, cancelled_via(approach))),
    );
    states
}

/// Names every `LanePhase`, exhaustively.
///
/// The match is the load-bearing part: a variant added to the protocol makes it
/// non-exhaustive and **fails the build here**, which routes whoever added it to
/// this file. That is the guarantee, and it is worth being precise about its
/// limit — the compiler forces the arm, it cannot force a fixture that reaches
/// the phase. The test below is what asks for that, and it is only as good as
/// the list it compares against.
fn phase_label(phase: &LanePhase) -> &'static str {
    match phase {
        LanePhase::Queued => "Queued",
        LanePhase::Running => "Running",
        LanePhase::Cancelling => "Cancelling",
        LanePhase::Committed => "Committed",
        LanePhase::Completed => "Completed",
        LanePhase::Failed => "Failed",
        LanePhase::Cancelled => "Cancelled",
    }
}

/// [PIN] The phase fixture reaches every phase a lane can hold.
///
/// `lane_phase_states` is the table every busy-predicate claim rests on, so a
/// phase missing from it is a phase no busy assertion in this file has ever
/// seen. `Cancelled` was missing until the wave-0 review found it: an
/// implementation treating a cancelled lane as busy would have kept its chip
/// lit and the redraw pump running, and the whole fixture would have stayed
/// green.
///
/// MUTATION, all four run against this tree.
///
/// - Delete any singly-covered state — `claude failed`, say — and the first
///   assertion goes red naming the phase that stopped being covered: `Failed`
///   missing from a list that otherwise matches.
/// - Delete a row from `CANCELLED_ROUTES` and the second assertion goes red,
///   `[(true, "Cancelling")]` against both rows. The first assertion cannot see
///   that: the set it compares is deduplicated, so the surviving route keeps
///   `Cancelled` in it.
/// - Point both rows at the same approach and the second assertion goes red,
///   `[(true, "Cancelling"), (true, "Cancelling")]`. **This is the one a check
///   on the two labels missed** — it was run against the round-3 version and
///   stayed green, with the queued side of the busy line silently untested.
/// - Write the two rows in the other order and this stays **green**, which is
///   the point of sorting: the round-3 version failed on that, and a test that
///   fails on two perfectly good rows in a different order teaches people to
///   stop trusting it.
#[test]
fn the_lane_phase_fixture_reaches_every_phase() {
    let mut seen: Vec<&'static str> = lane_phase_states()
        .iter()
        .flat_map(|(_, room)| {
            room.reducer
                .ordered_lanes()
                .map(|lane| phase_label(&lane.phase))
                .collect::<Vec<_>>()
        })
        .collect();
    seen.sort_unstable();
    seen.dedup();
    let mut expected = vec![
        "Queued",
        "Running",
        "Cancelling",
        "Committed",
        "Completed",
        "Failed",
        "Cancelled",
    ];
    expected.sort_unstable();
    assert_eq!(
        seen, expected,
        "the phase fixture does not reach every LanePhase; anything in the second \
         list and not the first is a phase no busy assertion here has tested"
    );

    // Every phase reached, and `Cancelled` reached from both sides of the busy
    // line. The deduplicated set above is blind to the second half: with two
    // states reaching `Cancelled`, losing one leaves the set complete, so the
    // two-route coverage the fixture exists to give could drain away a route at
    // a time with this test still green.
    //
    // Asserted on the approach each route is BUILT from and on `lane_busy` at
    // that approach, not on the two labels — because two rows that keep their
    // names while taking the same road satisfy a label check, and that was run
    // and stayed green. Sorted, so the two rows may be written in either order:
    // an ordered comparison failed on a swap of two perfectly good rows.
    let mut approaches: Vec<(bool, &'static str)> = Vec::new();
    for (label, approach) in CANCELLED_ROUTES {
        let before = approaching_cancelled(approach).done();
        let arrived = lane_phase_of(&before, label);
        assert_eq!(
            arrived,
            phase_label(approach),
            "{label} approaches through {arrived}, not the phase its row declares"
        );
        approaches.push((lane_busy(&before.reducer, None), arrived));

        let after = cancelled_via(approach);
        assert_eq!(
            lane_phase_of(&after, label),
            "Cancelled",
            "{label} does not end in Cancelled"
        );
        assert!(
            !lane_busy(&after.reducer, None),
            "a cancelled lane is not busy, and {label} says otherwise"
        );
    }
    approaches.sort_unstable();
    assert_eq!(
        approaches,
        vec![(false, "Queued"), (true, "Cancelling")],
        "the two routes into Cancelled must approach it from opposite sides of \
         `lane_busy` — one lane that was busy on the way in, one that never was. \
         Two routes on the same side leave the other side untested by every busy \
         assertion in this file."
    );
}

/// The phase of the one lane a single-agent fixture holds.
fn lane_phase_of(room: &RoomView, label: &str) -> &'static str {
    let mut lanes = room.reducer.ordered_lanes();
    let lane = lanes
        .next()
        .unwrap_or_else(|| panic!("the fixture for {label} holds no lane at all"));
    assert!(
        lanes.next().is_none(),
        "the fixture for {label} holds more than one lane, so `the` lane is ambiguous"
    );
    phase_label(&lane.phase)
}

/// [PIN] The extracted predicate answers exactly what the two inline
/// expressions it replaced answered, across every phase a lane can reach.
///
/// The filter is the whole reason this test exists. `lane_busy` was very nearly
/// specified as an unfiltered `any_lane_busy(reducer)`, which agrees with the
/// pump and disagrees with every chip: it would have lit all three identities
/// whenever one agent was working.
///
/// MUTATION: add `LanePhase::Queued` to the matched set in `lane_busy` and this
/// goes red on "claude queued", which is how it says it can see the phase set.
#[test]
fn lane_busy_agrees_with_the_two_predicates_it_replaced() {
    for (label, room) in lane_phase_states() {
        assert_eq!(
            lane_busy(&room.reducer, None),
            legacy_pump_busy(&room.reducer),
            "room-wide busy disagrees with the pump's own check at: {label}"
        );
        for agent in ["claude", "codex", "gemini"] {
            assert_eq!(
                lane_busy(&room.reducer, Some(agent)),
                legacy_chip_working(&room.reducer, agent),
                "{agent}'s busy flag disagrees with the chip's own check at: {label}"
            );
        }
    }
}

/// [PIN] = spec §A.10.5 site 1. A running lane lights ITS chip and no other.
///
/// Three claims in one frame, because the operator's complaint would be about
/// one frame: the working agent is at full brand luminance, that is visibly not
/// what the same agent looks like when idle, and its two colleagues are still
/// dimmed.
///
/// Every seat, paired with the agent name the reducer knows it by.
const SEATS: &[(&str, RoomIdentity)] = &[
    ("claude", RoomIdentity::Claude),
    ("codex", RoomIdentity::Codex),
    ("gemini", RoomIdentity::Gemini),
];

/// MUTATION: delete the `agent.is_none_or(...)` filter from `lane_busy` — the
/// precise wrong rewrite this foundation commit was at risk of — and codex and
/// gemini light up with claude.
///
/// **Every seat takes a turn as the working one.** With claude alone it was
/// enough to hard-code claude's chip bright and the other two dim, forever, and
/// pass — a wrong implementation the wave-0 review named. The idle assertion is
/// also exact now rather than merely different: `!=` accepts any wrong colour
/// that happens not to equal the active one.
#[test]
fn a_running_lane_lights_only_its_own_chip() {
    let all_idle = footer_buffer(&RoomView::new(), 100, 1_000);
    for (working_agent, working_identity) in SEATS {
        let running = footer_buffer(&one_agent_running(working_agent), 100, 1_000);

        assert_eq!(
            chip_fg(&running, *working_identity),
            working_identity.color(),
            "{working_agent} is working and its chip must be at full brand luminance"
        );
        assert_eq!(
            chip_fg(&all_idle, *working_identity),
            working_identity.rest_color(),
            "{working_agent}'s idle chip must be exactly its rest colour"
        );
        assert_ne!(
            chip_fg(&running, *working_identity),
            chip_fg(&all_idle, *working_identity),
            "working and idle must not look the same, or {working_agent}'s chip says nothing"
        );
        for (idle_agent, idle_identity) in SEATS {
            if idle_agent == working_agent {
                continue;
            }
            assert_eq!(
                chip_fg(&running, *idle_identity),
                idle_identity.rest_color(),
                "{idle_agent} is not working and must stay dim while {working_agent} is"
            );
        }
    }
}

/// [PIN] = spec §A.10.5 site 3. Chip luminance is a function of state, never of
/// time.
///
/// Sampled across a full period of the room's one animation clock rather than
/// at two aligned instants: `attention_at` cycles every ten ticks
/// (`room_theme.rs:209-215`), so ticks 0 and 3 sit in its bright half and 7 and
/// 9 in its dim half. A pulse routed through that clock would be invisible to
/// any pair of samples taken from the same half.
///
/// Reduced motion is swept too, and the expected result is that it changes
/// nothing at all: there is no motion here for it to switch off, and a future
/// reader "improving" the active state into a breath is exactly how that stops
/// being true.
///
/// ⚠ **Both clocks, because the room has two.** `render_tick` is the animation
/// counter; `now_ms` is wall time, and it is what `footer_agent_cell` reads for
/// offline and quota staleness. Pinning `now_ms` at a single value — which this
/// test did until the wave-0 review — leaves a pulse driven by elapsed time
/// completely invisible, so "static" was only ever proved against one of the two
/// things that could move it. The wall-clock samples span days, not
/// milliseconds, so a slow drift cannot hide between them either.
///
/// Every seat is swept as the working one for the same reason as the pin above.
///
/// MUTATION: route the working arm of `footer_agent_cell`'s ladder through
/// `theme.attention_at(room.render_tick, room.reduced_motion)` and the samples
/// stop agreeing.
#[test]
fn chip_luminance_is_state_not_animation() {
    #[allow(clippy::type_complexity)]
    let mut samples: Vec<(&str, bool, u64, u64, Color, Color)> = Vec::new();
    for (working_agent, working_identity) in SEATS {
        let mut room = one_agent_running(working_agent);
        let idle_identity = SEATS
            .iter()
            .find(|(agent, _)| agent != working_agent)
            .map(|(_, identity)| *identity)
            .expect("three seats means an idle one exists");
        for reduced_motion in [false, true] {
            for tick in [0_u64, 3, 7, 9] {
                for now_ms in [0_u64, 1_000, 86_400_000, 5_000_000_000] {
                    room.reduced_motion = reduced_motion;
                    room.render_tick = tick;
                    let footer = footer_buffer(&room, 100, now_ms);
                    samples.push((
                        working_agent,
                        reduced_motion,
                        tick,
                        now_ms,
                        chip_fg(&footer, *working_identity),
                        chip_fg(&footer, idle_identity),
                    ));
                }
            }
        }
        let expected_working = working_identity.color();
        let expected_idle = idle_identity.rest_color();
        assert!(
            samples
                .iter()
                .filter(|(agent, ..)| agent == working_agent)
                .all(|(_, _, _, _, working, idle)| {
                    *working == expected_working && *idle == expected_idle
                }),
            "chip colour moved with a clock: {samples:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// The guidance row
// ---------------------------------------------------------------------------

/// The row's whole content, copied verbatim from `room_runtime.rs:1063-1068` as
/// it stood at `6844cca`, before `guidance_row` took ownership.
fn legacy_guidance(room: &RoomView) -> &'static str {
    if room.reducer.transcript().next().is_none() && room.prompt.text().trim().is_empty() {
        "type to start · @claude, @codex, @gemini to route · everyone answers by default"
    } else {
        ""
    }
}

/// The row painted exactly as `render_room` paints it, so the comparison is of
/// cells and their styles and not of two strings that happen to match.
fn painted_row<'a>(content: impl Into<Text<'a>>) -> Buffer {
    let theme = RoomTheme::current();
    let area = Rect::new(0, 0, 96, 1);
    let mut buffer = Buffer::empty(area);
    Paragraph::new(content)
        .style(Style::default().fg(theme.faint).bg(theme.canvas))
        .render(area, &mut buffer);
    buffer
}

/// Every state today's guidance condition can be in: its two terms, both ways,
/// plus the whitespace-only draft that `trim` exists to catch.
fn guidance_states() -> Vec<(&'static str, RoomView)> {
    let mut spoken = turn_with(&["claude"]);
    assert!(
        spoken.reducer.transcript().next().is_some(),
        "the fixture must really have a transcript"
    );
    let mut spoken_with_draft = turn_with(&["claude"]);
    spoken_with_draft.prompt.set_text("another question");

    let mut drafting = RoomView::new();
    drafting.prompt.set_text("half a question");
    let mut whitespace = RoomView::new();
    whitespace.prompt.set_text("   ");

    spoken.prompt.set_text("");
    vec![
        ("empty room, empty composer", RoomView::new()),
        ("empty room, a draft", drafting),
        ("empty room, a whitespace draft", whitespace),
        ("a spoken room, empty composer", spoken),
        ("a spoken room, a draft", spoken_with_draft),
    ]
}

/// [PIN] The extracted row paints, cell for cell, what the inline paragraph
/// painted.
///
/// This is the zero-rendered-difference gate for the guidance row, asserted
/// against the expression that was there rather than against a description of
/// it — including the empty case, where an empty `&str` and an empty `Line` are
/// two different `Text` values and could have painted differently.
///
/// MUTATION: drop the emptiness condition from `guidance_row` so it always
/// returns the guidance, and the two spoken-room states go red.
#[test]
fn guidance_row_paints_what_the_inline_paragraph_painted() {
    for (label, room) in guidance_states() {
        assert_eq!(
            // A width every rung fits in: this site's subject is the four
            // rungs, not slice D's narrow ladder, and none of these states
            // has an unseen answer in it.
            painted_row(guidance_row(&room, 120).line),
            painted_row(legacy_guidance(&room)),
            "the guidance row changed at: {label}"
        );
    }
}

/// The widths the retained-rect proof runs at, all at [`RETAINED_RECT_HEIGHT`].
///
/// `render_room` insets the content column by 2 at width >= 120 and by 1 below
/// it (`room_runtime.rs:1046`). 120 and 119 are the pair that pins **where** that
/// boundary sits: any change to the threshold moves one of them across it and
/// the two derivations disagree. Round 3 sampled 120, 100 and 80, which all fall
/// on the same side of `>= 110` as they do of `>= 120` — so that mutation passed,
/// and the round-3 comment's claim to catch threshold changes was worth less
/// than it sounded. 100 and 80 stay because they are ordinary rooms on the
/// narrow arm, and 80 is where the card boundary sizes below are measured.
const RETAINED_RECT_WIDTHS: &[u16] = &[120, 119, 100, 80];

/// Tall enough that the feed band holds the card on either render path, so the
/// width rows above test width and nothing else.
const RETAINED_RECT_HEIGHT: u16 = 40;

/// The feed band's height at one window size, straight off a real render.
///
/// The point is that it is *asked*, not derived: the two card-boundary sizes are
/// found by searching this rather than by inverting `render_room`'s band
/// arithmetic, so they do not carry a second copy of it.
fn feed_height_at(width: u16, height: u16) -> u16 {
    let mut room = RoomView::new();
    room.force_welcome_settled();
    let area = Rect::new(0, 0, width, height);
    let mut buffer = Buffer::empty(area);
    render_room(area, &mut buffer, &mut room);
    room.feed_rect.height
}

/// Every size the retained-rect proof runs at: the width rows, then the two
/// window heights that sit either side of the card fitting the feed band.
///
/// Those two are **computed, never written down.** The card is 38x18 under the
/// default glyphs and 34x8 on a legacy console, which suppresses the braille
/// mark — so a height that makes the feed one row too short is 24 on one
/// supported render path and 14 on the other. Round 3 wrote a number here and
/// the legacy-glyph step of `npm run verify:rust` failed on it. Searching for
/// the height is what makes the row mean the same thing on both paths.
fn retained_rect_sizes() -> Vec<(u16, u16)> {
    let mut sizes: Vec<(u16, u16)> = RETAINED_RECT_WIDTHS
        .iter()
        .map(|&width| (width, RETAINED_RECT_HEIGHT))
        .collect();
    let (_, card_height) = crate::room_welcome::card_size_for_tests("");
    let tallest = card_height * 4;
    let exact_fit = (card_height..=tallest)
        .find(|&height| feed_height_at(CARD_BOUNDARY_WIDTH, height) >= card_height)
        // Not `expect`: this search reads `feed_rect`, so it is the first thing
        // a wrongly-retained rect breaks, and "no height was tall enough" on its
        // own sends the reader hunting the layout instead of the retention. The
        // observed height is the tell — a one-row feed at any window size is a
        // rect retained from the guidance row.
        .unwrap_or_else(|| {
            panic!(
                "no window up to {CARD_BOUNDARY_WIDTH}x{tallest} retained a feed band \
                 with the {card_height} rows the card needs; at the tallest the \
                 retained feed was {} rows",
                feed_height_at(CARD_BOUNDARY_WIDTH, tallest)
            )
        });
    assert!(
        exact_fit > card_height,
        "a window cannot be shorter than the feed band inside it; the search found {exact_fit}"
    );
    // One row short, then exactly enough. The first is the only size where "the
    // card must not paint" is a live claim, and it is what catches a card handed
    // an area larger than the rect the room retained.
    sizes.push((CARD_BOUNDARY_WIDTH, exact_fit - 1));
    sizes.push((CARD_BOUNDARY_WIDTH, exact_fit));
    sizes
}

/// Wide enough for the card on either render path, so the two boundary sizes
/// vary in height alone.
const CARD_BOUNDARY_WIDTH: u16 = 80;

/// The first and last columns of row `y` holding anything but blank.
///
/// Read off the cells rather than off `row_text`, because a column is the
/// question here and a string index is not the same one.
fn ink_columns(buffer: &Buffer, y: u16) -> Option<(u16, u16)> {
    let inked: Vec<u16> = (0..buffer.area.width)
        .filter(|x| {
            buffer
                .cell((*x, y))
                .is_some_and(|cell| !cell.symbol().trim().is_empty())
        })
        .collect();
    Some((*inked.first()?, *inked.last()?))
}

/// [FALSIFIER] The rects the room painted into survive the frame.
///
/// RED before this commit as a compile error: neither field existed, so the
/// mouse handler had no way to ask where anything was.
///
/// ⚠ **Exact bounds, not containment.** This test used to ask only that
/// `feed_rect` *contain* the welcome card's row and share horizontal bounds with
/// `guidance_rect`. A `feed_rect` spanning the whole content column satisfies
/// both and is wrong in the way that matters: slice C hit-tests clicks against
/// this rect, so a too-tall rect turns clicks in the header, the composer and
/// the footer into feed clicks, and nothing here would have failed.
///
/// ⚠ **What each assertion actually buys, because the round-3 version of this
/// comment claimed more than it delivered.** It said the only line copied from
/// production was `outer_pad`. That was wrong twice over: the block below also
/// asks the two sizing helpers `render_room` asks, and reproduces every fixed
/// band and every subtraction around the feed. So, precisely:
///
/// - **The rect assertions are a re-derivation, not an independent oracle.**
///   They catch a change to the *combination* — a band inserted, an order
///   swapped, a retained field pointing at the wrong section — and they catch a
///   change to the padding threshold only because 120 and 119 straddle it. They
///   do NOT catch a change inside `permissions.height` or `desired_height`, nor
///   a band change made in production and mirrored here in the same edit.
/// - **The ink columns do not depend on that arithmetic.** They answer a
///   different question — where the widgets actually painted — so a retained
///   rect that agrees with a wrong derivation still fails them.
/// - **The card assertions are the only ones that bind the rect the feed's own
///   painters were handed**, as opposed to the rect the room kept. The card
///   paints exactly when the retained rect can hold it, and where it paints it
///   is a `card_width`-wide box centred in that same rect, vertically and
///   horizontally. A card handed a different area than the room retained gives
///   itself away on one of the three.
///
/// A row-set oracle was tried here first and rejected **with a measurement**:
/// assert that every inked row which is not a known chrome row falls inside
/// `feed_rect`. It cannot fail. The bands tile the window with no gap, so every
/// row outside the feed IS a chrome row and the set difference is exactly the
/// feed's own rows. Run against the card-handed-the-content-column mutation it
/// reported `OUTSIDE=[]` at every size and passed, because the card's three
/// spilled rows land on the composer's rows, which the check excludes by
/// construction.
///
/// Not covered, written down rather than implied: wrongness inside `card_size`
/// or the two sizing helpers, since this test asks them the same question
/// production does.
///
/// MUTATION, all nine run against this tree, output quoted from the runs.
///
/// - Swap the two assignments at the end of `render_room` and the size search
///   above panics first, because it reads `feed_rect`: *"no window up to 80x72
///   retained a feed band with the 18 rows the card needs; at the tallest the
///   retained feed was 1 rows"*. A one-row feed at any window size is the tell.
/// - Change `>= 120` to `>= 110` and **119x40** goes red, `x:2 width:115`
///   against `x:1 width:117`. That mutation passed every size round 3 sampled —
///   120, 100 and 80 sit on the same side of both thresholds. `>= 90` lands on
///   119x40 too; `>= 121` lands on 120x40, `x:1 width:118` against
///   `x:2 width:116`.
/// - Paint the header into the whole window row instead of `sections[0]` and the
///   header ink column goes red at 120x40, 119 against 117. Paint the guidance
///   at the window's left edge and the guidance ink column goes red, 0 against 2.
/// - Hand `render_card` the whole content column instead of `sections[1]` and
///   120x40 goes red on the centring, row 11 against row 8 — row 16 against 13
///   on the legacy glyph set, whose card is a different size. Round 3's version
///   of this test passed that mutation on both paths.
/// - Hand `render_card` the retained rect shifted one column right and the
///   horizontal half goes red, `(42, 38)` against `(41, 38)`.
/// - Shrink the window so the feed is one row short of the card while the
///   content column is not, and the iff goes red: *"the card painted=true, but
///   the retained feed rect Rect { x: 1, y: 1, width: 78, height: 17 } cannot
///   hold a 38x18 card, at 80x24"*. That size is searched for, so the same
///   failure lands at 80x14 on the legacy glyph set.
#[test]
fn render_room_retains_the_rects_it_painted_into() {
    for (width, height) in retained_rect_sizes() {
        let at = format!("{width}x{height}");
        let mut room = RoomView::new();
        room.force_welcome_settled();
        assert_eq!(
            (room.feed_rect, room.guidance_rect),
            (Rect::default(), Rect::default()),
            "an unpainted room has painted nothing anywhere, at {at}"
        );

        let area = Rect::new(0, 0, width, height);
        let mut buffer = Buffer::empty(area);
        render_room(area, &mut buffer, &mut room);

        // The content column: `render_room` insets by 2 at width >= 120, else by 1.
        let outer_pad = if area.width >= 120 { 2 } else { 1 };
        let content_x = area.x + outer_pad;
        let content_width = area.width - outer_pad * 2;
        // The bands around the feed: one header row, the permission shelf, the composer, one guidance
        // row, and the footer — whose height is MEASURED, not assumed. It was written as a literal `2`
        // here, which was true of this fixture (a healthy first-run room) and stopped being true of the
        // room in general: the footer grows a third row while any agent carries a health state
        // (`footer_state_row`). Deriving it from the same function `render_room` lays out against means
        // this geometry contract now covers BOTH heights instead of silently pinning one of them.
        let shelf = room.permissions.height(area.height, content_width);
        let composer = room
            .prompt
            .desired_height(content_width, &room_prompt_style(), true, 6);
        let footer_rows = room_footer(&room, content_width).len() as u16;
        let expected_feed = Rect::new(
            content_x,
            area.y + 1,
            content_width,
            area.height - 1 - shelf - composer - 1 - footer_rows,
        );
        let expected_guidance =
            Rect::new(content_x, area.height - footer_rows - 1, content_width, 1);

        assert_eq!(
            room.feed_rect, expected_feed,
            "the retained feed rect is not the band the feed was rendered into, at {at}"
        );
        assert_eq!(
            room.guidance_rect, expected_guidance,
            "the retained guidance rect is not the row the guidance was rendered into, at {at}"
        );

        // And the derivation is checked against paint, so a shared error in both
        // expectations above cannot pass: the guidance text and the header
        // really are where the rects claim.
        let guidance_y = (0..area.height)
            .find(|y| row_text(&buffer, *y).contains("@claude, @codex, @gemini to route"))
            .unwrap_or_else(|| panic!("a first-run room paints its guidance, at {at}"));
        assert_eq!(
            guidance_y, room.guidance_rect.y,
            "the guidance was painted on a different row than the rect retained for it, at {at}"
        );

        // Both edges of the content column, off the paint. The guidance is
        // left-aligned in it and the header is right-aligned in it, so between
        // them they pin the content column at this width without asking the
        // branch that produced it.
        let (guidance_left, _) = ink_columns(&buffer, guidance_y)
            .unwrap_or_else(|| panic!("the guidance row painted nothing, at {at}"));
        assert_eq!(
            guidance_left, room.guidance_rect.x,
            "the guidance was painted at a different column than the rect retained for it, at {at}"
        );
        let (_, header_right) = ink_columns(&buffer, area.y)
            .unwrap_or_else(|| panic!("the header row painted nothing, at {at}"));
        assert_eq!(
            header_right,
            room.guidance_rect.right() - 1,
            "the right-aligned header ends outside the content column the rects claim, at {at}"
        );

        // The card paints exactly when the RETAINED rect can hold it, and where
        // it paints it is centred in that same rect. Together those are the only
        // assertions here that bind the rect the feed's own painters were handed
        // — everything above binds the rect the room *kept*, which is a
        // different claim, and slice C will hit-test clicks against the kept one.
        //
        // `render_card` draws nothing in an area too small for it
        // (`room_welcome.rs:267`) and centres what it does draw
        // (`room_welcome.rs:266`), so a card handed a larger area than the room
        // retained gives itself away twice: it appears at a size whose retained
        // rect cannot hold one, and it sits at the wrong row where both can.
        let (card_width, card_height) = crate::room_welcome::card_size_for_tests(&room.version);
        let feed_holds_card =
            room.feed_rect.width >= card_width && room.feed_rect.height >= card_height;
        let card_y =
            (0..area.height).find(|y| row_text(&buffer, *y).contains(crate::room_welcome::TAGLINE));
        assert_eq!(
            card_y.is_some(),
            feed_holds_card,
            "the card painted={:?}, but the retained feed rect {:?} {} hold a \
             {card_width}x{card_height} card, at {at}",
            card_y.is_some(),
            room.feed_rect,
            if feed_holds_card { "can" } else { "cannot" }
        );
        if card_y.is_some() {
            // The first ink below the header. A first-run feed paints nothing
            // but the card, so this is the card's top border and no search for
            // it is needed.
            let card_top = ((area.y + 1)..area.height)
                .find(|y| ink_columns(&buffer, *y).is_some())
                .unwrap_or_else(|| {
                    panic!("the card painted, so something is inked below the header, at {at}")
                });
            assert_eq!(
                card_top,
                room.feed_rect.y + (room.feed_rect.height - card_height) / 2,
                "the card is not centred in the retained feed rect {:?} at {at}; it starts at \
                 row {card_top}, which is where it would land centred in some other area",
                room.feed_rect
            );
            let (card_left, card_right) = ink_columns(&buffer, card_top)
                .unwrap_or_else(|| panic!("the card's top row painted nothing, at {at}"));
            assert_eq!(
                (card_left, card_right - card_left + 1),
                (
                    room.feed_rect.x + (room.feed_rect.width - card_width) / 2,
                    card_width
                ),
                "the card's top border is not a {card_width}-wide box centred in the retained \
                 feed rect {:?}, at {at}",
                room.feed_rect
            );
        }
    }
}

// ---------------------------------------------------------------------------
// The key namespace
// ---------------------------------------------------------------------------

/// Every chord the room binds, read off its handlers at this pin:
/// `handle_scrollback_key` (`room_runtime.rs:343-362`), `handle_key`'s quit
/// (`:421-425`) and the shared Shift+Tab predicate (`:404`).
const ROOM_CHORDS: &[(&str, KeyCode, KeyModifiers)] = &[
    ("quit", KeyCode::Char('c'), KeyModifiers::CONTROL),
    (
        "fold the selected entry",
        KeyCode::Char('e'),
        KeyModifiers::CONTROL,
    ),
    (
        "show the selected entry raw",
        KeyCode::Char('r'),
        KeyModifiers::CONTROL,
    ),
    (
        "jump to the first unseen answer",
        KeyCode::Char('t'),
        KeyModifiers::CONTROL,
    ),
    (
        "back to the bottom — only with an empty draft and no history browse",
        KeyCode::End,
        KeyModifiers::NONE,
    ),
    ("select the previous entry", KeyCode::Up, KeyModifiers::ALT),
    ("select the next entry", KeyCode::Down, KeyModifiers::ALT),
    ("page the feed up", KeyCode::PageUp, KeyModifiers::NONE),
    ("page the feed down", KeyCode::PageDown, KeyModifiers::NONE),
    (
        "cycle one agent's mode",
        KeyCode::BackTab,
        KeyModifiers::NONE,
    ),
    (
        "cycle one agent's mode",
        KeyCode::BackTab,
        KeyModifiers::SHIFT,
    ),
    ("cycle one agent's mode", KeyCode::Tab, KeyModifiers::SHIFT),
];

/// The slices this wave hands a chord to.
///
/// A typed identifier rather than the free-text label this table used to carry,
/// because of a collision in the names themselves: **this wave has a slice
/// called G and a chord called `Ctrl+G`, and they belong to different slices.**
/// Slice G gets `Ctrl+O`; slice E gets `Ctrl+G`. Anyone writing the table from
/// memory crosses them, and a `(&str, char)` row puts the label's last letter
/// and the chord's letter side by side with nothing defending the pairing.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ReservingSlice {
    D,
    E,
    G,
}

impl ReservingSlice {
    /// The chord this slice was assigned, or a panic naming the missing row.
    ///
    /// A lookup and not an index, so a reordered or dropped row fails loudly
    /// here instead of silently handing one slice another slice's chord.
    ///
    /// Both tables are searched, because §2.13's assignment does not stop
    /// being the assignment once a slice claims it: a claimed chord moves from
    /// [`RESERVED_CHORDS`] to [`CLAIMED_CHORDS`] and must still answer for the
    /// slice it was given to.
    fn chord_letter(self) -> char {
        RESERVED_CHORDS
            .iter()
            .chain(CLAIMED_CHORDS)
            .find(|(slice, _, _)| *slice == self)
            .map(|(_, letter, _)| *letter)
            .unwrap_or_else(|| panic!("{self:?} has no row in RESERVED_CHORDS or CLAIMED_CHORDS"))
    }
}

/// Chords §2.13 assigned that their slice has now BOUND.
///
/// A separate table rather than a flag on the one above, because the two are
/// asked different questions: a reserved chord must be inert in both keymaps,
/// and a claimed one must not be — asserting inertness on a chord that has
/// been claimed is asserting the slice did not ship. `the_reserved_chords_…`
/// tests read only [`RESERVED_CHORDS`]; the assignment test reads both, so a
/// chord cannot quietly vanish by being "claimed" without a binding.
const CLAIMED_CHORDS: &[(ReservingSlice, char, &str)] = &[(
    ReservingSlice::D,
    't',
    "activate the answered-above pill — bound in handle_scrollback_key",
)];

/// The chords this wave has handed out, and who gets them. Assigned centrally
/// (spec §2.13) rather than surveyed by each builder, because three builders
/// surveying separately is how two of them pick the same key.
///
/// ⚠ This table is a *claim about the spec*, and being free is not the same as
/// being the assigned one. `the_reserved_chords_are_the_assignment_the_spec_made`
/// is what checks the claim; the freeness test below cannot, and must not be
/// read as if it could.
const RESERVED_CHORDS: &[(ReservingSlice, char, &str)] = &[
    (ReservingSlice::E, 'g', "jump to my last message"),
    (ReservingSlice::G, 'o', "toggle mouse capture"),
];

fn chord(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
    KeyEvent::new(code, modifiers)
}

/// [PIN] The room's chords are not also composer edits — with one recorded
/// exception, which is recorded rather than fixed.
///
/// `Ctrl+E` is bound by both: the room's `handle_scrollback_key` runs first
/// (`room_runtime.rs:298-301`), so a `Ctrl+E` in the room folds an entry and
/// never reaches the composer's move-to-line-end. That is pre-existing and out
/// of this wave's scope. It is asserted by its exact shape so that fixing it
/// fails here and the record gets updated with the fix, rather than the
/// exception quietly widening to cover a second collision.
///
/// MUTATION: add `Ctrl+A` (the editor's line-start) to `ROOM_CHORDS` and this
/// goes red, which is how it says it can see a double-bind.
#[test]
fn the_rooms_chords_are_not_also_composer_edits() {
    let mut collisions = Vec::new();
    for (action, code, modifiers) in ROOM_CHORDS {
        let editor = classify_key_event(&chord(*code, *modifiers));
        if *code == KeyCode::Char('e') && *modifiers == KeyModifiers::CONTROL {
            assert_eq!(
                editor,
                Some(EditCommand::MoveLogicalLineEnd),
                "the recorded Ctrl+E double-bind has changed shape; update this record"
            );
            continue;
        }
        if let Some(command) = editor {
            collisions.push(format!(
                "{action} ({code:?} + {modifiers:?}) -> {command:?}"
            ));
        }
    }
    assert!(
        collisions.is_empty(),
        "these room chords are also composer edits, and the room wins silently: {collisions:#?}"
    );
}

/// A draft with the caret in the middle of it, so that EVERY edit the composer
/// keymap can perform is observable.
///
/// The caret placement is load-bearing: `MoveLogicalLineStart` on a caret
/// already at 0 changes nothing, so a sweep drafting from column 0 would read
/// "the composer did not act" for a chord the composer handled perfectly.
const DRAFT: &str = "alpha beta gamma";
const DRAFT_CARET: usize = 8;

fn with_draft(mut room: RoomView) -> RoomView {
    room.prompt.set_text(DRAFT);
    room.prompt.set_cursor(DRAFT_CARET);
    room
}

fn pending_permission() -> RoomView {
    RoomFixture::turn(&["gemini"])
        .started("gemini")
        .emit(
            "permission.requested",
            json!({"askId":"ask-gemini","agent":"gemini","options":[
                {"optionId":"allow-opaque","kind":"allow_once","name":"Allow once"},
                {"optionId":"deny-opaque","kind":"reject_once","name":"Deny"}]}),
        )
        .done()
}

fn state_empty_composer() -> RoomView {
    RoomView::new()
}

fn state_drafting() -> RoomView {
    with_draft(RoomView::new())
}

fn state_shelf_focused() -> RoomView {
    let mut room = with_draft(pending_permission());
    assert!(
        room.permissions.focus_shelf(),
        "the fixture must really hold a permission to focus"
    );
    room
}

fn state_shelf_unfocused() -> RoomView {
    let mut room = with_draft(pending_permission());
    room.permissions.focus_composer();
    assert!(
        !room.permissions.is_focused(),
        "the fixture must really have the shelf unfocused"
    );
    room
}

fn state_picker_open() -> RoomView {
    let mut room = with_draft(RoomView::new());
    let catalog = room.catalog.clone();
    room.picker.open_skills(RoomCatalogAgent::Claude, &catalog);
    assert!(
        room.picker.is_open(),
        "the fixture must really hold an open picker"
    );
    room
}

/// One room state a key can arrive in.
struct RoutingState {
    label: &'static str,
    /// Rebuilt per key, because `RoomView` is not `Clone` and because a key that
    /// mutates the room would otherwise leak into the next key's answer.
    build: fn() -> RoomView,
    /// Whether the composer is live here. A picker is **modal** — it owns every
    /// key by design — so "the room won over the composer" is not a defect in
    /// that state. A permission shelf is not modal: the composer keeps the
    /// caret, which is exactly why a chord eaten there IS a defect.
    composer_is_live: bool,
}

/// The room states a key can arrive in, each built the way the room reaches it.
///
/// Not decoration: production routes a key through `route_permission_key` and an
/// open picker BEFORE the two handlers a naive sweep would ask, so a sweep of the
/// base room alone reports keys as free that the room eats.
fn key_routing_states() -> Vec<RoutingState> {
    vec![
        RoutingState {
            label: "empty composer",
            build: state_empty_composer,
            composer_is_live: true,
        },
        RoutingState {
            label: "drafting",
            build: state_drafting,
            composer_is_live: true,
        },
        RoutingState {
            label: "permission shelf focused",
            build: state_shelf_focused,
            composer_is_live: true,
        },
        RoutingState {
            label: "permission shelf unfocused",
            build: state_shelf_unfocused,
            composer_is_live: true,
        },
        RoutingState {
            label: "picker open",
            build: state_picker_open,
            composer_is_live: false,
        },
    ]
}

/// What became of one keystroke in one room state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Disposition {
    /// Nobody acted: no room effect, and the composer left the draft alone.
    Inert,
    /// The composer received it and edited the draft or moved the caret.
    ComposerEdited,
    /// The room acted — it ended, sent the host a command, or swallowed a key
    /// the composer's own keymap says it would have handled.
    RoomActed,
}

/// Route one key exactly as the room routes it, and report who acted.
///
/// Through `route_room_key`, which is the production router itself rather than a
/// re-implementation of its order — that distinction is the whole finding this
/// helper exists to answer. A sweep that calls `handle_scrollback_key` and
/// `handle_key` directly asks two of the four participants and skips the
/// permission shelf, which sits ahead of both.
///
/// The router NAMES who took the key, which is the only reason this works. A
/// feed binding has no visible effect on the blocks the room builds today, and a
/// shelf that consumes a key sends nothing — inferring "the room took it" from
/// effects alone misses both, and my first attempt at this sweep did exactly
/// that: it lost `Ctrl+R` entirely while appearing to work.
///
/// A command counts too, because `handle_key` can reach the host without ending
/// the room — Shift+Tab's mode cycle is a room binding that lands in the
/// composer's branch.
///
/// ⚠ **What this does NOT see, written down because it was tried and withdrawn.**
/// A binding inside `handle_key` that flips a field, returns `Ok(None)`, sends
/// nothing and leaves the draft alone is invisible here. The wave-0 review named
/// that scenario, and the fix attempted for it compared the whole painted frame
/// against a control room pressed with a key nothing claims. It worked, and it
/// was removed: two renders of the same room differ intermittently under
/// full-suite parallelism — reproduced twice at roughly one run in twenty, on a
/// different arbitrary letter each time, and not root-caused. A foundation gate
/// that goes red at random teaches three builders to re-run until green, which is
/// worse than a gap that is written down. So the gap is written down.
async fn disposition_of(state: &RoutingState, key: KeyEvent) -> Disposition {
    let mut room = (state.build)();
    let before = (room.prompt.text().to_owned(), room.prompt.cursor());
    let (commands, mut received) = mpsc::channel::<RoomCommand>(4);
    let (cancels, mut cancelled) = mpsc::channel::<super::RoomCancelAll>(4);
    let routed = super::route_room_key(&mut room, key, &commands, &cancels)
        .await
        .expect("sweeping a key must not fail the room");
    let after = (room.prompt.text().to_owned(), room.prompt.cursor());
    // BOTH wires. The room-wide cancel has its own channel since BLOCK 2, and a
    // `commanded` that only watched the command wire would report the panic
    // button as a key the room ignores.
    let commanded = received.try_recv().is_ok() || cancelled.try_recv().is_ok();
    match routed {
        KeyDisposition::Exit(_) | KeyDisposition::PermissionShelf | KeyDisposition::Feed => {
            Disposition::RoomActed
        }
        KeyDisposition::Composer if commanded => Disposition::RoomActed,
        KeyDisposition::Composer if after != before => Disposition::ComposerEdited,
        KeyDisposition::Composer => Disposition::Inert,
        // This sweep builds key-DOWNS only, so a release reaching here means the
        // sweep's key construction drifted underneath the table. Folding it into
        // one of the four dispositions would let that drift pass with the whole
        // table still green. Give releases their own table if they are ever
        // wanted; do not widen this arm.
        KeyDisposition::CtrlCRelease => panic!(
            "the Ctrl+<letter> sweep routed a key RELEASE; it constructs key-downs \
             only, so its key builder has changed -- fix the builder, or add a \
             separate release table with its own expectations"
        ),
    }
}

/// Every `Ctrl+<letter>` the room takes, in every non-modal state, with why.
///
/// Discovered from `route_room_key` and written down here — the record, not the
/// source. The test below asks production and compares, so a wave-1 slice that
/// binds a chord without adding its row fails, and so does one that removes a
/// binding without removing its row.
///
/// ⚠ The two rows marked FINDING are **live defects recorded, not fixed.**
/// `route_permission_key`'s navigation arm matches `KeyCode::Char('j')` and
/// `KeyCode::Char('k')` with **no modifier check**, so with the shelf focused the
/// room eats `Ctrl+J` and `Ctrl+K`. `Ctrl+K` is also the composer's
/// kill-to-line-end, so that one is a live double-bind. Fixing it is a behaviour
/// change and belongs to the slice that owns the permission surface; recording
/// it here means the fix shows up as a failure that forces this record to be
/// updated, rather than passing silently.
///
/// ⚠ **The two shelf `'c'` rows are a DELIBERATE pin change, landed by slice B**
/// (state-aware cancel), and they are here because this test went red and was
/// made to tell the truth rather than made to pass. The old record held exactly
/// one `'c'` row and no shelf row; slice B's `Ctrl+C` ladder cancels whenever a
/// lane is `Running | Cancelling`, and `pending_permission()` — the fixture
/// under both shelf states — holds a **running** gemini lane, so the shelf
/// states are busy rooms and the key now sends a cancel there. The RED, quoted
/// verbatim in B's handback, discovered exactly `("permission shelf focused",
/// 'c')` and `("permission shelf unfocused", 'c')` and nothing else. The sweep
/// was NOT narrowed: the assertion still spans `'a'..='z'` across every
/// `composer_is_live` state.
const ROOM_TAKES_CTRL_LETTERS: &[(&str, char, &str)] = &[
    (
        "empty composer",
        'c',
        "quit — reachable only with an empty draft AND an idle room",
    ),
    ("empty composer", 'e', "the feed folds the selected entry"),
    (
        "empty composer",
        'r',
        "the feed shows the selected entry raw",
    ),
    (
        "empty composer",
        't',
        "slice D: Ctrl+T jumps to the unseen answer that reads first on screen",
    ),
    ("drafting", 'e', "the feed folds the selected entry"),
    ("drafting", 'r', "the feed shows the selected entry raw"),
    (
        "drafting",
        't',
        "slice D: Ctrl+T jumps to the unseen answer that reads first on screen",
    ),
    (
        "permission shelf focused",
        'c',
        "slice B: the shelf fixture holds a RUNNING lane, so Ctrl+C cancels the room",
    ),
    (
        "permission shelf focused",
        'e',
        "the feed folds the selected entry",
    ),
    (
        "permission shelf focused",
        'j',
        "FINDING: the shelf's Char('j') arm carries no modifier check",
    ),
    (
        "permission shelf focused",
        'k',
        "FINDING: the shelf's Char('k') arm carries no modifier check, and Ctrl+K is the composer's kill-to-line-end",
    ),
    (
        "permission shelf focused",
        'r',
        "the feed shows the selected entry raw",
    ),
    (
        "permission shelf focused",
        't',
        "slice D: Ctrl+T jumps to the unseen answer that reads first on screen",
    ),
    (
        "permission shelf unfocused",
        'c',
        "slice B: the shelf fixture holds a RUNNING lane, so Ctrl+C cancels the room",
    ),
    (
        "permission shelf unfocused",
        'e',
        "the feed folds the selected entry",
    ),
    (
        "permission shelf unfocused",
        'r',
        "the feed shows the selected entry raw",
    ),
    (
        "permission shelf unfocused",
        't',
        "slice D: Ctrl+T jumps to the unseen answer that reads first on screen",
    ),
];

/// [PIN] The room's Ctrl+letter bindings are what this file says they are, in
/// every state a key can arrive in.
///
/// The declared-list test above can only check what is in `ROOM_CHORDS`, so an
/// unlisted binding is invisible to it — the same shape of hole that let a
/// wrong-but-free chord through the reservation test. This closes it by asking
/// production rather than the list: every letter, every non-modal state, routed
/// through `route_room_key` itself.
///
/// The first version of this sweep called `handle_scrollback_key` and
/// `handle_key` directly, and was wrong twice over: it skipped
/// `route_permission_key`, which sits ahead of both, and it inferred "the room
/// took it" from effects, which cannot see a feed binding because fold and raw
/// are no-ops on every block the room builds today. It reported `Ctrl+K` as free
/// while the shelf ate it, and lost `Ctrl+R` entirely.
///
/// **What this sweep covers, precisely, so nobody reads it as more:**
/// - `Ctrl+a` … `Ctrl+z`. The seven non-letter rows in `ROOM_CHORDS` —
///   `Alt+Up`/`Alt+Down`, `PageUp`/`PageDown`, the three Shift+Tab shapes — are
///   outside this alphabet and remain a hand-written promise, as does
///   `Alt+<letter>`, which no row claims today.
/// - Non-modal states only. A picker owns every key by design, so "the room won"
///   is not a defect there; `state_picker_open` exists to keep that exclusion
///   visible rather than implicit.
/// - History-search state is not built here, so a binding that exists only while
///   the history browser is open would pass.
///
/// MUTATION, and it is only half of what this note used to claim. Bind an
/// unlisted letter in `handle_scrollback_key` — a one-line arm — and this goes
/// red naming the state and the letter: adding `Ctrl+L` there discovered
/// `("empty composer", 'l')`, `("drafting", 'l')` and both shelf states against
/// a recorded set that has none of them.
///
/// ⚠ **The same arm in `handle_key` does NOT go red, and that was run.** A
/// `Ctrl+L` arm that flips a room field, sends no command, leaves the draft and
/// caret alone and returns `Ok(None)` classifies as
/// `KeyDisposition::Composer` with nothing observed, which `disposition_of`
/// reports as `Disposition::Inert` — indistinguishable from a key nobody
/// claimed. Both this sweep and `the_reserved_chords_are_unbound_in_both_keymaps`
/// stayed green with that arm in the tree. It is the same hole those tests
/// already record, reached from the other side, and naming it here matters
/// because "a wave-1 slice adds a one-line arm" is exactly the shape that hides
/// in it.
///
/// ⚠ Two further limits of the observable, so the paragraph above is not read as
/// the whole of it: `disposition_of` collapses `Exit`, `PermissionShelf` and
/// `Feed` into one `RoomActed`, so a binding that moves between those three
/// owners reads the same; and it records only *whether* a command was sent, not
/// which or how many, so an arm sending the wrong command — or two — is
/// `RoomActed` either way.
#[tokio::test]
async fn room_chords_lists_every_ctrl_letter_the_room_binds() {
    let mut discovered: Vec<(String, char)> = Vec::new();
    for state in key_routing_states() {
        if !state.composer_is_live {
            continue;
        }
        for letter in 'a'..='z' {
            let key = chord(KeyCode::Char(letter), KeyModifiers::CONTROL);
            if disposition_of(&state, key).await == Disposition::RoomActed {
                discovered.push((state.label.to_owned(), letter));
            }
        }
    }
    let recorded: Vec<(String, char)> = ROOM_TAKES_CTRL_LETTERS
        .iter()
        .map(|(state, letter, _)| ((*state).to_owned(), *letter))
        .collect();
    assert_eq!(
        discovered, recorded,
        "the room takes a different set of Ctrl+letters than ROOM_TAKES_CTRL_LETTERS records; \
         anything discovered and not recorded is a binding no collision test can see"
    );

    // Every letter the room takes must either be a declared room chord or carry
    // a FINDING note. Without this, a new binding could be waved through by
    // appending a row with a comfortable-sounding reason.
    let declared: Vec<char> = ROOM_CHORDS
        .iter()
        .filter(|(_, _, modifiers)| *modifiers == KeyModifiers::CONTROL)
        .filter_map(|(_, code, _)| match code {
            KeyCode::Char(letter) => Some(*letter),
            _ => None,
        })
        .collect();
    let undeclared: Vec<&(&str, char, &str)> = ROOM_TAKES_CTRL_LETTERS
        .iter()
        .filter(|(_, letter, note)| !declared.contains(letter) && !note.starts_with("FINDING:"))
        .collect();
    assert!(
        undeclared.is_empty(),
        "these bindings are neither in ROOM_CHORDS nor recorded as a finding: {undeclared:#?}"
    );
}

/// [PIN] A chord the room takes from a live composer is a collision, and there
/// are exactly two today.
///
/// Separate from the table above because the severity is different: an extra
/// room binding is a namespace question, while a room binding that shadows a
/// composer edit means the operator presses a key, sees nothing happen, and has
/// no way to find out why. Both are recorded rather than fixed — `Ctrl+E` is
/// pre-existing and out of this wave's scope, and `Ctrl+K` belongs to the slice
/// that owns the permission surface.
///
/// MUTATION: give `route_permission_key`'s navigation arm a modifier check and
/// this goes red on `Ctrl+K`, which is how the record gets updated when the fix
/// lands rather than the exception quietly widening.
#[tokio::test]
async fn the_room_shadows_exactly_the_recorded_composer_chords() {
    let mut shadowed: Vec<(String, char)> = Vec::new();
    for state in key_routing_states() {
        if !state.composer_is_live {
            continue;
        }
        for letter in 'a'..='z' {
            let key = chord(KeyCode::Char(letter), KeyModifiers::CONTROL);
            if classify_key_event(&key).is_some()
                && disposition_of(&state, key).await == Disposition::RoomActed
            {
                shadowed.push((state.label.to_owned(), letter));
            }
        }
    }
    let expected: Vec<(String, char)> = vec![
        ("empty composer".to_owned(), 'e'),
        ("drafting".to_owned(), 'e'),
        ("permission shelf focused".to_owned(), 'e'),
        ("permission shelf focused".to_owned(), 'k'),
        ("permission shelf unfocused".to_owned(), 'e'),
    ];
    assert_eq!(
        shadowed, expected,
        "the set of composer chords the room shadows has changed; Ctrl+E is the \
         pre-existing fold binding and Ctrl+K is the permission shelf's \
         modifier-blind navigation arm"
    );
}

/// [PIN] The reservation table IS the assignment §2.13 made — not merely three
/// chords that happen to be available.
///
/// This test exists because the freeness test below could not see its own
/// subject, and the way it could not is worth writing down: it iterates
/// whatever `RESERVED_CHORDS` happens to hold and proves each letter is
/// unbound. **Free is not the same as assigned.** Change slice E's chord from
/// `Ctrl+G` to `Ctrl+L` — a letter the spec's own reserve list calls free — and
/// every assertion in that test still passes, green, while slice E inherits a
/// chord nobody reserved. It went red on the one wrong letter it was tried with
/// only because that letter was independently bound; a test that catches the
/// wrong answer only when the wrong answer is also broken some other way is not
/// a gate. (This repo's FL-078/081/082/093 class, fifth instance.)
///
/// The four claims below are stated one spec fact per line rather than as a
/// second copy of the table, so a one-character slip in `RESERVED_CHORDS`
/// contradicts a readable sentence instead of travelling alongside a duplicate
/// nobody re-reads.
///
/// **What this does and does not defend.** It defends against a slip in one
/// place — a mistyped letter, a swap between two slices, a dropped or duplicated
/// row. It does not make the file independent of itself: both statements live
/// here, so a writer who edits both consistently gets no warning. The only
/// genuinely independent oracle in this section is the freeness half, which asks
/// the real keymaps. Fixing that fully would mean parsing §2.13 out of the spec
/// at test time, which couples this crate to a repo path outside `rust/` and to
/// a document that gets archived when the wave ends — a worse trade.
///
/// MUTATION: set slice E's chord to `'l'` — **free**, so the freeness test stays
/// green — and this goes red. That is the mutation that proves this test sees
/// the assignment rather than the collision.
#[test]
fn the_reserved_chords_are_the_assignment_the_spec_made() {
    // §2.13's reservation table, one row per line, quoting its own wording.
    assert_eq!(
        ReservingSlice::E.chord_letter(),
        'g',
        "§2.13 gives slice E `Ctrl+G` — jump to my last message (\"go to\")"
    );
    assert_eq!(
        ReservingSlice::D.chord_letter(),
        't',
        "§2.13 gives slice D `Ctrl+T` — activate the answered-above pill"
    );
    assert_eq!(
        ReservingSlice::G.chord_letter(),
        'o',
        "§2.13 gives slice G `Ctrl+O` — toggle mouse capture; grok used `Ctrl+R` and the room has taken it"
    );

    // Three rows and no fourth, ACROSS BOTH TABLES: without this, an extra
    // reservation could be appended and every per-slice claim above would
    // still hold. Reading both is also what stops a chord disappearing by
    // being moved to the claimed table without a binding behind it.
    let assigned: Vec<(ReservingSlice, char)> = RESERVED_CHORDS
        .iter()
        .chain(CLAIMED_CHORDS)
        .map(|(slice, letter, _)| (*slice, *letter))
        .collect();
    let mut letters: Vec<char> = assigned.iter().map(|(_, letter)| *letter).collect();
    letters.sort_unstable();
    assert_eq!(
        letters,
        vec!['g', 'o', 't'],
        "the assigned set is exactly Ctrl+G, Ctrl+O and Ctrl+T (§2.13),          however the rows are split between reserved and claimed"
    );

    // Slice D's row moved to CLAIMED_CHORDS when this slice bound the chord,
    // exactly as `the_reserved_chords_are_unbound_in_both_keymaps` instructs.
    // Asserted by shape rather than left implicit, so a later slice cannot
    // park a chord there to dodge the freeness test.
    assert_eq!(
        CLAIMED_CHORDS
            .iter()
            .map(|(slice, letter, _)| (*slice, *letter))
            .collect::<Vec<_>>(),
        vec![(ReservingSlice::D, 't')],
        "only slice D has claimed its chord in this wave"
    );

    // Distinct on both sides. Two slices sharing a chord, or one slice holding
    // two rows, is the copy-paste that the per-slice lookup would resolve to
    // whichever came first.
    let mut seen_letters = letters.clone();
    seen_letters.dedup();
    assert_eq!(
        seen_letters.len(),
        assigned.len(),
        "two slices are assigned the same chord: {assigned:?}"
    );
    let mut seen_slices: Vec<String> = assigned
        .iter()
        .map(|(slice, _)| format!("{slice:?}"))
        .collect();
    seen_slices.sort_unstable();
    seen_slices.dedup();
    assert_eq!(
        seen_slices.len(),
        assigned.len(),
        "one slice holds two assignments: {assigned:?}"
    );
}

/// [PIN] The three reserved chords are unbound in both keymaps, in every state.
///
/// Both keymaps, because a chord is only free if neither owner wants it: the
/// composer's editor must not classify it, and the room must not act on it.
/// Every non-modal state, because the room's answer depends on which one it is
/// in — the shelf eats `Ctrl+K` only while focused, and a reservation checked in
/// the base room alone would not have found that.
///
/// ⚠ **Observability, and the hole that is still open.** The observable is
/// `disposition_of`: which of the four participants the production router says
/// took the key, whether a command reached the host, and whether the draft or
/// the caret moved. A wrong handler that flips a field on the room, returns
/// `Ok(None)`, sends nothing and leaves the draft alone satisfies every one of
/// those and still passes here as "unbound". That is the wave-0 review's
/// finding and **it is not fixed** — the whole-frame comparison written for it
/// was withdrawn for flaking under full-suite parallelism, and the reasoning
/// for that withdrawal is written down on `disposition_of` itself.
///
/// This paragraph used to describe that frame comparison as though it were
/// still here. It is not, and a comment describing a test that does not exist
/// is the exact defect this wave exists to remove — worse than the gap it was
/// covering, because a reader trusts it.
///
/// ⚠ **This test proves freeness and nothing else.** It cannot tell `Ctrl+G`
/// from `Ctrl+L`, because both are free; the assignment is checked above, and
/// reading a green here as "the chords are right" is the mistake that let a
/// wrong reservation through once already.
///
/// **This test is designed to fail when a slice claims its chord**, and that is
/// the handoff, not a defect: E binding `Ctrl+G` makes the room act on it, which
/// is red here by construction. The slice moves its row out of
/// `RESERVED_CHORDS` and into `ROOM_CHORDS` and `ROOM_TAKES_CTRL_LETTERS` in the
/// same commit. A reservation that outlives its claim is the thing worth
/// failing on.
///
/// MUTATION: swap a reserved letter for `'e'` and the editor half goes red;
/// swap it for `'r'` and the room half does. Note what those two letters have
/// in common — they are already bound, which is the only reason they work as
/// mutations here; `'l'` is the mutation that tests the assignment instead.
#[tokio::test]
async fn the_reserved_chords_are_unbound_in_both_keymaps() {
    for (slice, letter, action) in RESERVED_CHORDS {
        let owner = format!("slice {slice:?} — {action}");
        let key = chord(KeyCode::Char(*letter), KeyModifiers::CONTROL);

        assert_eq!(
            classify_key_event(&key),
            None,
            "Ctrl+{letter} is a composer edit and cannot be reserved for {owner}"
        );

        for state in key_routing_states() {
            if !state.composer_is_live {
                continue;
            }
            let where_ = state.label;
            assert_eq!(
                disposition_of(&state, key).await,
                Disposition::Inert,
                "Ctrl+{letter} is not inert in the room while {where_}; it is not free for {owner}"
            );
        }
    }
}
