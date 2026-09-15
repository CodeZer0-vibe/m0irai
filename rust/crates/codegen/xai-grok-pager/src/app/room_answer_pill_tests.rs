//! Slice D's unseen-answer pill, its two keys, and its click target.
//!
//! Its own file for the reason `room_runtime_seam_tests.rs` and
//! `room_runtime_cancel_tests.rs` beside it have one: `room_runtime.rs` has no
//! Rust clamp gate and a test module appended to it collides with every other
//! lane editing that file.
//!
//! Read the tags. A [PIN] passes on the tree it was written against, so its
//! evidence is the mutation quoted in the handback. A [FALSIFIER] fails
//! against the tree before the change — every one here did, because none of
//! this surface existed: `unseen_answers` was a `Vec<EntryId>` written by
//! nothing, `guidance_row` carried a documented gap where rung 3 is, and
//! `Ctrl+T` was a reserved chord bound to nothing.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use serde_json::json;
use unicode_width::UnicodeWidthStr;
use zer0_room_protocol::{RoomEvent, RoomReducer};

use super::room_answer_pill::{PILL_SUFFIX, answer_pill_text};
use super::tests::{apply, event, row_text};
use super::{handle_scrollback_key, render_room};
use crate::room_scrollback::RoomSpeaker;
use crate::room_theme::{RoomSecondaryGlyph, room_secondary};
use crate::room_view::{RoomView, UnseenAnswer};

/// A deliberately TALL operator prompt.
///
/// The fixtures need a feed whose top holds nothing but the operator's own
/// message, so that "scrolled to the top" means "every answer is below the
/// viewport" at every width these tests render at. Sizing it by wrapping — one
/// long message — rather than by shrinking the viewport keeps the frames big
/// enough for the guidance row and footer to render normally.
const OPERATOR_PROMPT: &str = concat!(
    "look at the thing and tell me what you find, in as much detail as you can, ",
    "because the operator is going to read this from the top and scroll down ",
    "through it slowly while the agents are still working on their answers. ",
    "look at the thing and tell me what you find, in as much detail as you can, ",
    "because the operator is going to read this from the top and scroll down ",
    "through it slowly while the agents are still working on their answers. ",
    "look at the thing and tell me what you find, in as much detail as you can, ",
    "because the operator is going to read this from the top and scroll down ",
    "through it slowly while the agents are still working on their answers. ",
    "look at the thing and tell me what you find, in as much detail as you can, ",
    "because the operator is going to read this from the top and scroll down ",
    "through it slowly while the agents are still working on their answers. ",
    "look at the thing and tell me what you find, in as much detail as you can, ",
    "because the operator is going to read this from the top and scroll down ",
    "through it slowly while the agents are still working on their answers.",
);

/// The three roster agents, in roster order, with their lane and stream ids.
const LANES: [(&str, &str, &str); 3] = [
    ("claude", "claude-lane", "claude-stream"),
    ("codex", "codex-lane", "codex-stream"),
    ("gemini", "gemini-lane", "gemini-stream"),
];

/// One turn dispatched to all three agents, with `answered` committing in the
/// order given — which is the order the pill names them in.
///
/// Returned as EVENTS rather than as a built room so the snapshot case can
/// replay exactly the same history into a second reducer. A fixture that built
/// the reducer twice by two different routes would be comparing two fixtures.
fn replayable_events(answered: &[&str]) -> Vec<RoomEvent> {
    replayable_events_texted(answered, None)
}

/// [`replayable_events`] with the answer body chosen, for the one case that
/// needs an answer taller than the viewport. Threaded as a parameter rather
/// than patched into the built events afterwards, because a fixture that
/// rewrites protocol values is a second event builder.
fn replayable_events_texted(answered: &[&str], answer_text: Option<&str>) -> Vec<RoomEvent> {
    // ONLY the agents that will answer are dispatched. A lane left Running
    // would make `lane_busy` true, and rung 2 (`esc to interrupt`) outranks
    // the pill by design — a fixture that left one running would be testing
    // the ladder's precedence and reporting it as a missing pill.
    //
    // They are queued in ROSTER order regardless of the order they commit in,
    // because roster order is what decides where their rows read (FL-141) and
    // therefore the order Ctrl+T walks.
    let roster: Vec<(&str, &str, &str)> = LANES
        .iter()
        .copied()
        .filter(|(name, _, _)| answered.contains(name))
        .collect();
    let names: Vec<&str> = roster.iter().map(|(name, _, _)| *name).collect();
    let mut events = vec![
        event(
            1,
            "turn.accepted",
            json!({
                "agents": names,
                "text": OPERATOR_PROMPT,
                "messageId": "operator-1",
                "ledgerSeq": "1",
            }),
        ),
        event(2, "route.resolved", json!({ "agents": names })),
    ];
    let mut seq = 3;
    for (agent, lane, _) in &roster {
        events.push(event(
            seq,
            "lane.queued",
            json!({"laneId":lane,"agent":agent,"expectedMessageId":format!("{agent}-message"),"origin":"operator","hopIndex":0}),
        ));
        seq += 1;
    }
    for (agent, lane, stream) in &roster {
        events.push(event(
            seq,
            "lane.started",
            json!({"laneId":lane,"streamId":stream,"agent":agent}),
        ));
        seq += 1;
    }
    for agent in answered {
        let (_, lane, stream) = LANES
            .iter()
            .find(|(name, _, _)| name == agent)
            .expect("the fixture only answers with roster agents");
        events.push(event(
            seq,
            "message.committed",
            json!({"laneId":lane,"agent":agent,"messageId":format!("{agent}-message"),"ledgerSeq":seq.to_string(),"text":answer_text.map_or_else(|| format!("{agent} answered"), str::to_owned),"origin":"operator","hopIndex":0}),
        ));
        seq += 1;
        events.push(event(
            seq,
            "lane.completed",
            json!({"laneId":lane,"streamId":stream,"agent":agent}),
        ));
        seq += 1;
    }
    events
}

/// A room driven through the production event arm.
///
/// Never by writing `unseen_answers` by hand: a fixture that assembled the
/// list directly would stop testing the append half entirely, and the append
/// half is where "one entry per answer, deduplicated, agents not answers" is
/// decided.
fn room_with_answers(answered: &[&str]) -> RoomView {
    let mut room = RoomView::new();
    for next in replayable_events(answered) {
        apply(&mut room, next);
    }
    room
}

/// One answer taller than any viewport these tests render at, for the
/// top-clipped case. Same event shape as [`room_with_answers`]; only the
/// answer text differs, so nothing else about the case changes with it.
fn room_with_tall_answers(answered: &[&str]) -> RoomView {
    let mut room = RoomView::new();
    for next in replayable_events_texted(answered, Some(OPERATOR_PROMPT)) {
        apply(&mut room, next);
    }
    room
}

/// Render one frame and hand back the buffer, so a test can read the guidance
/// row's actual cells rather than trusting the value that produced them.
///
/// Rendering is what reconciles the unseen list (spec §D.6 pins the point), so
/// EVERY assertion about the pill has to follow a real frame. A test that
/// asked `answer_pill_text` directly would be testing the ladder and calling
/// it the pill.
fn frame(room: &mut RoomView, width: u16, height: u16) -> Buffer {
    let area = Rect::new(0, 0, width, height);
    let mut buffer = Buffer::empty(area);
    render_room(area, &mut buffer, room);
    buffer
}

/// The guidance row's painted text on this frame, trailing blanks trimmed.
fn guidance_text(room: &RoomView, buffer: &Buffer) -> String {
    row_text(buffer, room.guidance_rect.y).trim().to_owned()
}

/// Scroll to the very top of the feed, so every answer is below the viewport.
///
/// A large jump to hit the clamp rather than a measured one: the exact row
/// count depends on wrapping at the test's width, and a fixture that computes
/// it is a second layout engine that gets it wrong the first time someone
/// edits the answer text.
fn scroll_to_top(room: &mut RoomView) {
    room.scrollback.scroll_up(500);
}

fn press(room: &mut RoomView, code: KeyCode, modifiers: KeyModifiers) -> bool {
    handle_scrollback_key(room, &KeyEvent::new(code, modifiers))
}

fn click(column: u16, row: u16, kind: MouseEventKind) -> MouseEvent {
    MouseEvent {
        kind,
        column,
        row,
        modifiers: KeyModifiers::NONE,
    }
}

/// [FALSIFIER] memo §2 site 10 — the pill appears only while the answer's own
/// FIRST row is off screen.
///
/// Three states on one room: scrolled away (pill), scrolled so the answer's
/// first row is visible (cleared on that very frame), and scrolled so only a
/// LATER row of the answer shows (still up). The third is finding 18's
/// threshold and is the reason `entry_screen_area`'s `top_clipped` flag is the
/// test rather than `Some(..)`.
///
/// What a weaker assertion would let pass: using `entry_screen_area`'s
/// `Some(..)` alone reads a one-row sliver of a long answer as read, and the
/// operator would lose the pill for something they have not started. Using
/// `is_entry_visible` is worse — in the room's `AllTurns` view mode it is true
/// for every entry, so the pill would never appear at all. The top-clipped
/// case below fails under both.
#[test]
fn the_pill_appears_only_while_the_answer_is_off_screen() {
    let mut room = room_with_answers(&["claude"]);
    let arrow = room_secondary(RoomSecondaryGlyph::UpArrow);

    // Scrolled away: the answer is below the viewport entirely.
    scroll_to_top(&mut room);
    let buffer = frame(&mut room, 100, 16);
    assert_eq!(
        guidance_text(&room, &buffer),
        format!("{arrow} claude answered{PILL_SUFFIX}"),
        "an unread answer below the viewport puts the pill up"
    );
    assert!(room.answer_pill_rect.is_some());

    // Its first row on screen: seen, and cleared on THIS frame.
    room.scrollback.enable_follow_mode();
    let buffer = frame(&mut room, 100, 16);
    assert!(
        !guidance_text(&room, &buffer).contains("answered"),
        "the pill clears on the frame the answer's first row becomes visible: \
         {:?}",
        guidance_text(&room, &buffer)
    );
    assert_eq!(
        room.answer_pill_rect, None,
        "and the click target goes with it"
    );
    assert!(room.unseen_answers.is_empty());
}

/// [FALSIFIER] memo §2 site 10's third case, isolated: an answer showing only
/// its LATER rows does not count as read.
///
/// The answer here is taller than the viewport, so following the feed to the
/// bottom leaves its tail on screen and its first row above the top edge. That
/// is a real shape — a long answer arriving while the operator sits at the
/// bottom — and it is the one where a naive threshold clears the pill for
/// something nobody has started reading.
///
/// What a weaker assertion would let pass: `entry_screen_area(..).is_some()`
/// is TRUE here, because the entry does intersect the viewport. So is
/// `is_entry_visible`, which in the room's `AllTurns` mode is true for every
/// entry that exists. Both would clear the pill on this frame. The assertion
/// pins the intersection as present AND the pill as still up, so the two
/// cannot be conflated.
#[test]
fn a_top_clipped_answer_is_not_yet_read() {
    let mut room = room_with_tall_answers(&["claude"]);
    // Following the feed: the newest content is at the bottom.
    room.scrollback.enable_follow_mode();
    let buffer = frame(&mut room, 100, 16);

    let index = room
        .scrollback
        .answer_top_index("claude-message")
        .expect("the answer is in the feed");
    let (offset, height, total) = room.scrollback.scroll_info();
    assert!(
        total > usize::from(height),
        "the fixture must be taller than the viewport: {total} rows in {height}"
    );
    assert_eq!(
        room.scrollback
            .answer_first_row_visible("claude-message", room.feed_rect),
        Some(false),
        "the answer's FIRST row is above the top edge — offset {offset}, entry          {index} — so it has not been read"
    );
    let arrow = room_secondary(RoomSecondaryGlyph::UpArrow);
    assert_eq!(
        guidance_text(&room, &buffer),
        format!("{arrow} claude answered{PILL_SUFFIX}"),
        "so the pill is still up"
    );

    // And Ctrl+T is what resolves it: the jump puts the first row at the top.
    assert!(press(&mut room, KeyCode::Char('t'), KeyModifiers::CONTROL));
    let buffer = frame(&mut room, 100, 16);
    assert_eq!(
        room.scrollback
            .answer_first_row_visible("claude-message", room.feed_rect),
        Some(true)
    );
    assert!(
        !guidance_text(&room, &buffer).contains("answered"),
        "and the pill clears on that frame: {:?}",
        guidance_text(&room, &buffer)
    );
}

/// [FALSIFIER] memo §2 site 11 — exactly ONE pill, counting distinct AGENTS.
///
/// Three cases on the same guidance row: three agents, two agents in commit
/// order, and one agent that committed twice.
///
/// What a weaker assertion would let pass: counting `unseen_answers.len()`
/// gives `↑ 2 agents answered` for one agent that answered twice, which is a
/// lie about who is waiting for the operator. The doubled case is asserted by
/// its exact one-agent text. Asserting only that the row CONTAINS the pill
/// would let a second pill be painted somewhere else on the row, so the row is
/// compared whole.
#[test]
fn the_pill_never_shows_three_of_itself() {
    let arrow = room_secondary(RoomSecondaryGlyph::UpArrow);

    let mut room = room_with_answers(&["claude", "codex", "gemini"]);
    scroll_to_top(&mut room);
    let buffer = frame(&mut room, 100, 16);
    assert_eq!(
        guidance_text(&room, &buffer),
        format!("{arrow} 3 agents answered{PILL_SUFFIX}")
    );

    let mut room = room_with_answers(&["claude", "codex"]);
    scroll_to_top(&mut room);
    let buffer = frame(&mut room, 100, 16);
    assert_eq!(
        guidance_text(&room, &buffer),
        format!("{arrow} claude and codex answered{PILL_SUFFIX}"),
        "two agents are named, in commit order"
    );

    // Commit order, not roster order: codex answers first.
    let mut room = room_with_answers(&["codex", "claude"]);
    scroll_to_top(&mut room);
    let buffer = frame(&mut room, 100, 16);
    assert_eq!(
        guidance_text(&room, &buffer),
        format!("{arrow} codex and claude answered{PILL_SUFFIX}"),
        "and commit order is what decides which name comes first"
    );

    // One agent, two unseen answers: still one agent.
    let unseen = vec![
        UnseenAnswer {
            message_id: "claude-message".to_owned(),
            agent: RoomSpeaker::Claude,
            commit_event_seq: "9".to_owned(),
        },
        UnseenAnswer {
            message_id: "claude-second".to_owned(),
            agent: RoomSpeaker::Claude,
            commit_event_seq: "11".to_owned(),
        },
    ];
    assert_eq!(
        answer_pill_text(&unseen, 100),
        Some(format!("{arrow} claude answered{PILL_SUFFIX}")),
        "agents, not answers (§0.7 R4)"
    );
}

/// [FALSIFIER] memo §2 site 17 / spec §D.8 — the narrow ladder never clips.
///
/// Every rung, at every width, for all three shapes. The assertion is not just
/// "it fits": each output must be one of the rungs the spec wrote down, so a
/// truncation that happens to fit cannot pass.
///
/// What a weaker assertion would let pass: `assert!(width(text) <= budget)`
/// alone is satisfied by `↑ 3 agents answ` — it fits, and it is a lie by
/// mid-word cut. Membership in the rung set is what rejects that.
#[test]
fn the_narrow_pill_never_clips() {
    let arrow = room_secondary(RoomSecondaryGlyph::UpArrow);
    let one = vec![UnseenAnswer {
        message_id: "m1".to_owned(),
        agent: RoomSpeaker::Claude,
        commit_event_seq: "1".to_owned(),
    }];
    let mut two = one.clone();
    two.push(UnseenAnswer {
        message_id: "m2".to_owned(),
        agent: RoomSpeaker::Codex,
        commit_event_seq: "2".to_owned(),
    });
    let mut three = two.clone();
    three.push(UnseenAnswer {
        message_id: "m3".to_owned(),
        agent: RoomSpeaker::Gemini,
        commit_event_seq: "3".to_owned(),
    });

    let ladders: [(&Vec<UnseenAnswer>, Vec<String>); 3] = [
        (
            &one,
            vec![
                format!("{arrow} claude answered{PILL_SUFFIX}"),
                format!("{arrow} claude answered"),
                format!("{arrow} claude"),
                format!("{arrow} 1"),
            ],
        ),
        (
            &two,
            vec![
                format!("{arrow} claude and codex answered{PILL_SUFFIX}"),
                format!("{arrow} claude and codex answered"),
                format!("{arrow} 2 answered"),
                format!("{arrow} 2"),
            ],
        ),
        (
            &three,
            vec![
                format!("{arrow} 3 agents answered{PILL_SUFFIX}"),
                format!("{arrow} 3 agents answered"),
                format!("{arrow} 3 answered"),
                format!("{arrow} 3"),
            ],
        ),
    ];

    for (unseen, rungs) in ladders {
        for width in 0..=80u16 {
            let Some(text) = answer_pill_text(unseen, width) else {
                // Nothing renders. Then nothing MAY have rendered: the
                // shortest rung must genuinely not fit.
                let shortest = rungs.last().expect("every ladder has a last rung");
                assert!(
                    UnicodeWidthStr::width(shortest.as_str()) > usize::from(width),
                    "width {width} dropped the pill while {shortest:?} still fits"
                );
                continue;
            };
            assert!(
                UnicodeWidthStr::width(text.as_str()) <= usize::from(width),
                "width {width} rendered {text:?}, which does not fit"
            );
            assert!(
                rungs.contains(&text),
                "width {width} rendered {text:?}, which is not one of the \
                 spec's rungs {rungs:?} — a truncation that happens to fit"
            );
            // The first form that fits, never a shorter one: dropping a rung
            // the operator's width could have carried is its own defect.
            let best = rungs
                .iter()
                .find(|rung| UnicodeWidthStr::width(rung.as_str()) <= usize::from(width))
                .expect("something fits, since a form was returned");
            assert_eq!(&text, best, "width {width} skipped a rung that fits");
        }
    }
}

/// [PIN] The suffix rides only the FULL form, and only when the whole line
/// fits (spec §D.6).
///
/// Split out from the ladder sweep because it is the rule most likely to be
/// implemented as "append the suffix and truncate", which the sweep above
/// would catch only indirectly.
///
/// MUTATION: attach the suffix to every rung and the shortened forms exceed
/// their widths; quoted in the handback.
#[test]
fn the_suffix_attaches_to_the_full_form_only() {
    let arrow = room_secondary(RoomSecondaryGlyph::UpArrow);
    let one = vec![UnseenAnswer {
        message_id: "m1".to_owned(),
        agent: RoomSpeaker::Claude,
        commit_event_seq: "1".to_owned(),
    }];
    let full = format!("{arrow} claude answered");
    let with_suffix = format!("{full}{PILL_SUFFIX}");
    let exact = u16::try_from(UnicodeWidthStr::width(with_suffix.as_str()))
        .expect("the pill line is far under u16::MAX columns");

    assert_eq!(answer_pill_text(&one, exact), Some(with_suffix));
    assert_eq!(
        answer_pill_text(&one, exact - 1),
        Some(full.clone()),
        "one column short of the whole line drops the suffix ENTIRELY, never \
         truncates it"
    );
    let short = u16::try_from(UnicodeWidthStr::width(full.as_str())).expect("fits in u16") - 1;
    let shortened = answer_pill_text(&one, short).expect("a shorter rung still fits");
    assert!(
        !shortened.contains(PILL_SUFFIX),
        "a shortened rung never carries the suffix: {shortened:?}"
    );
}

/// [FALSIFIER] memo §2 site 13 — `Ctrl+T` walks FORWARD through the unseen
/// set, in the order the answers read on screen.
///
/// Three answers land while the operator is scrolled away. Each activation
/// lands on the next one down, and when the set empties the row falls through
/// to the next guidance rung.
///
/// What a weaker assertion would let pass: a test that only checked "the
/// viewport moved" is satisfied by an implementation that jumps to the same
/// answer three times. Each step asserts WHICH answer became visible, and that
/// the pill's text shrinks by exactly the agent that was just read — so a jump
/// that landed on the wrong one fails on the name.
///
/// Screen order, not commit order, and that is the memo's amendment: lane rows
/// read in ROSTER order (FL-141), so commit order can run backwards up the
/// feed. This fixture commits gemini, codex, claude — the reverse of roster —
/// and the walk must still go claude, codex, gemini.
#[test]
fn ctrl_t_walks_forward_through_the_unseen_set() {
    let arrow = room_secondary(RoomSecondaryGlyph::UpArrow);
    // Each answer is taller than the viewport, on purpose: with short answers
    // a single jump brings all three on screen at once and the "walk" is over
    // in one press, which would make this test agree with an implementation
    // that only ever jumps to the first.
    let mut room = room_with_tall_answers(&["gemini", "codex", "claude"]);
    scroll_to_top(&mut room);
    let buffer = frame(&mut room, 100, 16);
    assert_eq!(
        guidance_text(&room, &buffer),
        format!("{arrow} 3 agents answered{PILL_SUFFIX}"),
        "all three are unread to begin with"
    );

    // Roster order is claude, codex, gemini — the order they READ, which is
    // the reverse of the order they committed in.
    for (expected_read, remaining) in [
        ("claude", format!("{arrow} gemini and codex answered")),
        ("codex", format!("{arrow} gemini answered")),
        ("gemini", String::new()),
    ] {
        assert!(
            press(&mut room, KeyCode::Char('t'), KeyModifiers::CONTROL),
            "the room claims Ctrl+T"
        );
        let buffer = frame(&mut room, 100, 16);
        assert_eq!(
            room.scrollback
                .answer_first_row_visible(&format!("{expected_read}-message"), room.feed_rect),
            Some(true),
            "Ctrl+T must land on {expected_read}"
        );
        let painted = guidance_text(&room, &buffer);
        if remaining.is_empty() {
            assert!(
                !painted.contains("answered"),
                "with the set empty the row falls through to the next rung: \
                 {painted:?}"
            );
            assert_eq!(room.answer_pill_rect, None);
        } else {
            assert_eq!(
                painted,
                format!("{remaining}{PILL_SUFFIX}"),
                "after reading {expected_read} the pill names exactly the rest"
            );
        }
    }
    assert!(room.unseen_answers.is_empty());
}

/// [FALSIFIER] memo §2 site 14 — `Ctrl+T` leaves a draft byte-identical.
///
/// The viewport is asserted to have MOVED as well, so a green cannot mean the
/// key did nothing at all.
#[test]
fn ctrl_t_leaves_a_draft_untouched() {
    let mut room = room_with_answers(&["claude"]);
    room.prompt
        .set_text("half a sentence the operator is still writing");
    let draft = room.prompt.text().to_owned();
    scroll_to_top(&mut room);
    let _ = frame(&mut room, 100, 16);
    let before = room.scrollback.scroll_info().0;

    assert!(press(&mut room, KeyCode::Char('t'), KeyModifiers::CONTROL));
    let _ = frame(&mut room, 100, 16);

    assert_eq!(room.prompt.text(), draft, "the draft is byte-identical");
    assert_ne!(
        room.scrollback.scroll_info().0,
        before,
        "and the viewport moved, so this case is not vacuous"
    );
}

/// [FALSIFIER] memo §2 site 15 / spec §D.7 — `End` returns to the bottom ONLY
/// when the composer is empty and history browse is inactive.
///
/// Three cases, and the two negative ones are the point: this function runs
/// BEFORE the composer, so an unguarded binding steals "cursor to end of line"
/// from anyone editing.
///
/// What a weaker assertion would let pass: asserting only that follow mode is
/// on in the empty case says nothing about the two states where the key must
/// be declined. Each negative case asserts the room did NOT claim the key, so
/// it reaches the composer.
#[test]
fn end_returns_to_the_bottom_only_when_the_composer_is_empty() {
    // 1. Empty draft — the room takes it and follows again.
    let mut room = room_with_answers(&["claude"]);
    scroll_to_top(&mut room);
    let _ = frame(&mut room, 100, 16);
    assert!(!room.scrollback.is_following());
    assert!(
        press(&mut room, KeyCode::End, KeyModifiers::NONE),
        "an empty composer gives End to the feed"
    );
    assert!(
        room.scrollback.is_following(),
        "and the feed follows the bottom again"
    );

    // 2. A draft in the composer — the room declines, so the textarea's own
    //    End still means cursor-to-end-of-line.
    let mut room = room_with_answers(&["claude"]);
    room.prompt.set_text("still typing");
    scroll_to_top(&mut room);
    let _ = frame(&mut room, 100, 16);
    let before = room.scrollback.scroll_info().0;
    assert!(
        !press(&mut room, KeyCode::End, KeyModifiers::NONE),
        "with text in the draft the room must NOT claim End"
    );
    assert_eq!(
        room.scrollback.scroll_info().0,
        before,
        "and the viewport does not move"
    );
    assert!(!room.scrollback.is_following());

    // 3. History browse active with an empty draft — the history widget owns
    //    the keyboard even though the composer looks empty.
    let mut room = room_with_answers(&["claude"]);
    room.history
        .push(crate::views::history_search::HistoryEntry {
            text: "an earlier prompt".to_owned(),
        });
    room.prompt
        .history_search
        .activate_browse(&room.history, "");
    room.prompt.set_text("");
    assert!(
        room.prompt.history_search.is_active(),
        "the fixture must actually be in browse mode"
    );
    scroll_to_top(&mut room);
    let _ = frame(&mut room, 100, 16);
    let before = room.scrollback.scroll_info().0;
    assert!(
        !press(&mut room, KeyCode::End, KeyModifiers::NONE),
        "browse mode keeps End even with an empty draft"
    );
    assert_eq!(room.scrollback.scroll_info().0, before);
    assert!(!room.scrollback.is_following());
}

/// [FALSIFIER] memo §2 site 16 / spec §D.6 — the pill's hit rect, EXACTLY, at
/// two widths, and a click on it does what `Ctrl+T` does.
///
/// Following upstream's convention of asserting the rect as a value rather
/// than probing a few columns (grok-ref `views/announcements.rs:922`).
///
/// What a weaker assertion would let pass: `assert!(rect.width > 0)` is
/// satisfied by a rect covering the whole guidance row, which would make the
/// empty columns beside the pill clickable — the exact defect a separate
/// `answer_pill_rect` exists to avoid. Both widths are asserted as whole
/// `Rect` values, and the row's own rect is asserted beside them so the
/// difference between "the pill" and "the row" is visible in the test.
#[test]
fn a_click_on_the_pill_activates_it() {
    let arrow = room_secondary(RoomSecondaryGlyph::UpArrow);
    // Wide: the full form AND the suffix fit.
    let mut room = room_with_answers(&["claude", "codex", "gemini"]);
    scroll_to_top(&mut room);
    let buffer = frame(&mut room, 120, 14);
    let guidance = room.guidance_rect;
    assert_eq!(
        guidance_text(&room, &buffer),
        format!("{arrow} 3 agents answered{PILL_SUFFIX}")
    );
    assert_eq!(
        guidance,
        Rect::new(2, guidance.y, 116, 1),
        "at width 120 the row is inset by 2 and spans the content column"
    );
    assert_eq!(
        room.answer_pill_rect,
        Some(Rect::new(2, guidance.y, 53, 1)),
        "the pill is the rendered line INCLUDING the suffix, not the row"
    );

    // Narrow: the suffix is dropped, and the rect shrinks with the text.
    let mut room = room_with_answers(&["claude", "codex", "gemini"]);
    scroll_to_top(&mut room);
    let buffer = frame(&mut room, 40, 14);
    let guidance = room.guidance_rect;
    assert_eq!(
        guidance_text(&room, &buffer),
        format!("{arrow} 3 agents answered")
    );
    assert_eq!(
        guidance,
        Rect::new(1, guidance.y, 38, 1),
        "below 120 the row is inset by 1"
    );
    assert_eq!(
        room.answer_pill_rect,
        Some(Rect::new(1, guidance.y, 19, 1)),
        "and the rect follows the shorter line"
    );

    // The click. A press inside the rect activates; the release is swallowed.
    let mut room = room_with_answers(&["claude", "codex", "gemini"]);
    scroll_to_top(&mut room);
    let _ = frame(&mut room, 120, 14);
    let rect = room.answer_pill_rect.expect("the pill is up");
    assert!(
        room.handle_answer_pill_mouse(&click(
            rect.x,
            rect.y,
            MouseEventKind::Down(MouseButton::Left)
        )),
        "a press on the pill is consumed"
    );
    assert!(
        room.handle_answer_pill_mouse(&click(
            rect.x,
            rect.y,
            MouseEventKind::Up(MouseButton::Left)
        )),
        "and so is its release, rather than falling through to the composer"
    );
    let _ = frame(&mut room, 120, 14);
    assert_eq!(
        room.scrollback
            .answer_first_row_visible("claude-message", room.feed_rect),
        Some(true),
        "the click lands on the same answer Ctrl+T would"
    );

    // One column past the pill is NOT the pill, even though it is the row.
    let mut room = room_with_answers(&["claude", "codex", "gemini"]);
    scroll_to_top(&mut room);
    let _ = frame(&mut room, 120, 14);
    let rect = room.answer_pill_rect.expect("the pill is up");
    let before = room.scrollback.scroll_info().0;
    assert!(
        !room.handle_answer_pill_mouse(&click(
            rect.right(),
            rect.y,
            MouseEventKind::Down(MouseButton::Left)
        )),
        "the empty columns beside the pill are not the pill"
    );
    assert_eq!(room.scrollback.scroll_info().0, before);
}

/// A CROSS-TURN displaced history: claude starts under a tall first prompt,
/// the operator moves on, and claude commits late — so the snapshot that
/// replays this carries a relocation and a back-reference, not just an answer.
///
/// `replayable_events` deliberately does not: it dispatches one turn, so
/// nothing in it can displace anything. Memo site 12 asks the snapshot to
/// preserve "unseen membership, rebuilt relocation, back-reference, and Ctrl+T
/// target", and only this shape has the middle two in it at all.
fn displaced_replayable_events() -> Vec<RoomEvent> {
    vec![
        event_in_turn(
            1,
            "turn.accepted",
            json!({"agents":["claude"],"text":OPERATOR_PROMPT,"messageId":"q1","ledgerSeq":"1"}),
            "turn-1",
        ),
        event_in_turn(2, "route.resolved", json!({"agents":["claude"]}), "turn-1"),
        event_in_turn(
            3,
            "lane.queued",
            json!({"laneId":"claude-lane","agent":"claude","expectedMessageId":"claude-message","origin":"operator","hopIndex":0}),
            "turn-1",
        ),
        event_in_turn(
            4,
            "lane.started",
            json!({"laneId":"claude-lane","streamId":"claude-stream","agent":"claude"}),
            "turn-1",
        ),
        event_in_turn(
            5,
            "turn.accepted",
            json!({"agents":["codex"],"text":"never mind, look at this instead","messageId":"q2","ledgerSeq":"5"}),
            "turn-2",
        ),
        event_in_turn(
            6,
            "message.committed",
            json!({"laneId":"claude-lane","agent":"claude","messageId":"claude-message","ledgerSeq":"6","text":"claude finally answered","origin":"operator","hopIndex":0}),
            "turn-1",
        ),
        event_in_turn(
            7,
            "lane.completed",
            json!({"laneId":"claude-lane","streamId":"claude-stream","agent":"claude"}),
            "turn-1",
        ),
    ]
}

/// [FALSIFIER] memo §2 site 12 / spec §D.9 — the pill survives a snapshot,
/// and `Ctrl+T` still lands on the same answer afterwards.
///
/// A snapshot replaces the whole scrollback and reallocates every `EntryId`
/// while leaving every other `RoomView` field alone.
///
/// What a weaker assertion would let pass: asserting the list is non-empty
/// after the snapshot is satisfied by stale entries that resolve to nothing —
/// the pill would name an agent and the jump would do nothing. This asserts
/// the painted NAME and then that the jump actually makes that answer's first
/// row visible. **This test is RED against any implementation storing
/// `EntryId`** (finding 10): the ids in the new scrollback start from zero
/// again, so a stored id points at an unrelated row or at none.
#[test]
fn the_pill_survives_a_snapshot_resync() {
    let arrow = room_secondary(RoomSecondaryGlyph::UpArrow);
    let hop = room_secondary(RoomSecondaryGlyph::HopArrow);
    let mut room = RoomView::new();
    for next in displaced_replayable_events() {
        apply(&mut room, next);
    }
    scroll_to_top(&mut room);
    let buffer = frame(&mut room, 100, 16);
    assert_eq!(
        guidance_text(&room, &buffer),
        format!("{arrow} claude answered{PILL_SUFFIX}")
    );
    assert!(
        room.scrollback
            .searchable_text()
            .contains(&format!("{hop} answering your")),
        "the live room relocated and carries its back-reference — the state          the snapshot below has to reproduce"
    );
    let entry_before = room
        .scrollback
        .answer_top_index("claude-message")
        .expect("the answer is in the feed");

    // The same history, replayed into a fresh reducer, delivered as a
    // snapshot — which is what `session/load` will do.
    let mut source = RoomView::new();
    for next in displaced_replayable_events() {
        apply(&mut source, next);
    }
    super::room_runtime_events::apply_room_snapshot_at(
        &mut room,
        source.reducer,
        std::time::Instant::now(),
    );
    scroll_to_top(&mut room);
    let buffer = frame(&mut room, 100, 16);

    assert_eq!(
        guidance_text(&room, &buffer),
        format!("{arrow} claude answered{PILL_SUFFIX}"),
        "the pill names the same agent after a resync"
    );
    let rebuilt = room.scrollback.searchable_text();
    assert!(
        rebuilt.contains(&format!("{hop} answering your")),
        "the REBUILT relocation carries its back-reference too: {rebuilt:?}"
    );
    let rows: Vec<&str> = rebuilt.lines().collect();
    let reference_at = rows
        .iter()
        .position(|row| row.contains("answering your"))
        .expect("just asserted");
    let later_prompt_at = rows
        .iter()
        .position(|row| row.contains("never mind"))
        .expect("the newer prompt survives the snapshot");
    assert!(
        reference_at > later_prompt_at,
        "and the rebuilt block is still BELOW the prompt that displaced it:          {rows:?}"
    );
    assert!(
        press(&mut room, KeyCode::Char('t'), KeyModifiers::CONTROL),
        "and Ctrl+T is still claimed"
    );
    let _ = frame(&mut room, 100, 16);
    assert_eq!(
        room.scrollback
            .answer_first_row_visible("claude-message", room.feed_rect),
        Some(true),
        "and still lands on the same ANSWER, through a scrollback whose entry \
         ids were all reallocated"
    );
    // Recorded, not asserted as equal: the point of the message-id design is
    // that this number is allowed to change.
    let _ = entry_before;
}

/// [PIN] An answer the snapshot does NOT carry is dropped, not pointed at.
///
/// The other half of §D.9: reconciliation resolves each id or drops it, and
/// "drops it" has to be observable or the pill can outlive its answer.
///
/// MUTATION: make `answer_first_row_visible` return `Some(false)` for an
/// unknown id and the pill stays up forever with nothing to jump to; quoted in
/// the handback.
#[test]
fn an_answer_a_snapshot_dropped_leaves_no_pill() {
    let mut room = room_with_answers(&["claude"]);
    scroll_to_top(&mut room);
    let _ = frame(&mut room, 100, 16);
    assert_eq!(room.unseen_answers.len(), 1);

    // An empty room: the answer is gone from both reducer and scrollback.
    super::room_runtime_events::apply_room_snapshot_at(
        &mut room,
        RoomReducer::new(),
        std::time::Instant::now(),
    );
    let buffer = frame(&mut room, 100, 16);
    assert!(
        room.unseen_answers.is_empty(),
        "an answer the snapshot did not carry is dropped"
    );
    assert_eq!(room.answer_pill_rect, None);
    assert!(!guidance_text(&room, &buffer).contains("answered"));
}

/// One event with a caller-chosen turn id. `tests::event` fixes the turn to
/// `render-turn`, and cross-turn displacement is by definition a fact about
/// two of them.
fn event_in_turn(
    seq: u64,
    kind: &str,
    payload: serde_json::Value,
    turn: &str,
) -> zer0_room_protocol::RoomEvent {
    zer0_room_protocol::RoomEvent::from_value(json!({
        "protocol": "zer0.room", "version": 1, "sessionId": "answer-pill",
        "eventSeq": seq.to_string(), "eventId": format!("answer-pill-{seq}"),
        "turnId": turn, "occurredAt": "2026-08-02T13:00:00Z",
        "type": kind, "payload": payload,
    }))
    .expect("the fixture event is protocol-valid")
}

/// [FALSIFIER] memo §2's scrolled-history scenario, and the one place the two
/// halves of this slice meet.
///
/// A slow first turn commits after a second turn's prompt, WHILE the operator
/// is scrolled up reading. Three things must all hold on the same frame:
/// the answer's whole turn block relocates to the tail; the viewport does not
/// move; and the pill goes up naming the agent whose answer just moved, with
/// `Ctrl+T` landing on it.
///
/// What a weaker assertion would let pass: proving the relocation and the
/// pill separately — which the engine tests and the pill tests above already
/// do — would miss the case this scenario exists for, where relocation
/// reallocates nothing but MOVES the answer under a pill that resolves it by
/// message id at jump time. A pill keyed on a position captured at commit
/// time passes both halves separately and fails here.
#[test]
fn a_relocation_under_a_scrolled_operator_holds_the_viewport_and_raises_the_pill() {
    let arrow_up = room_secondary(RoomSecondaryGlyph::UpArrow);
    let hop = room_secondary(RoomSecondaryGlyph::HopArrow);
    let mut room = RoomView::new();
    let events = vec![
        event_in_turn(
            1,
            "turn.accepted",
            json!({"agents":["claude"],"text":OPERATOR_PROMPT,"messageId":"q1","ledgerSeq":"1"}),
            "turn-1",
        ),
        event_in_turn(2, "route.resolved", json!({"agents":["claude"]}), "turn-1"),
        event_in_turn(
            3,
            "lane.queued",
            json!({"laneId":"claude-lane","agent":"claude","expectedMessageId":"claude-message","origin":"operator","hopIndex":0}),
            "turn-1",
        ),
        event_in_turn(
            4,
            "lane.started",
            json!({"laneId":"claude-lane","streamId":"claude-stream","agent":"claude"}),
            "turn-1",
        ),
        event_in_turn(
            5,
            "turn.accepted",
            json!({"agents":["codex"],"text":"never mind, look at this instead","messageId":"q2","ledgerSeq":"5"}),
            "turn-2",
        ),
    ];
    for next in events {
        apply(&mut room, next);
    }
    // Scrolled up to the top, reading the first question back. The entry at
    // the viewport top is the operator's own prompt, which never moves.
    scroll_to_top(&mut room);
    let buffer = frame(&mut room, 100, 16);
    let top_before = room.feed_rect;
    let first_row_before = row_text(&buffer, room.feed_rect.y);
    let offset_before = room.scrollback.scroll_info().0;
    assert!(
        !guidance_text(&room, &buffer).contains("answered"),
        "no answer has landed yet"
    );

    // The slow answer lands. This is a cross-turn displacement: turn-1 first
    // drew at 4, turn-2's prompt arrived at 5, the commit is at 6.
    apply(
        &mut room,
        event_in_turn(
            6,
            "message.committed",
            json!({"laneId":"claude-lane","agent":"claude","messageId":"claude-message","ledgerSeq":"6","text":"claude finally answered","origin":"operator","hopIndex":0}),
            "turn-1",
        ),
    );
    let buffer = frame(&mut room, 100, 16);

    // 1. It relocated, and it says what it is answering.
    let feed = room.scrollback.searchable_text();
    assert!(
        feed.contains(&format!("{hop} answering your")),
        "the displaced answer carries its back-reference: {feed:?}"
    );
    let answer_at = feed
        .lines()
        .position(|line| line.contains("claude finally answered"))
        .expect("the answer is in the feed");
    let later_prompt_at = feed
        .lines()
        .position(|line| line.contains("never mind"))
        .expect("the newer prompt is in the feed");
    assert!(
        answer_at > later_prompt_at,
        "the whole block moved below the newer prompt: {feed:?}"
    );

    // 2. The viewport did not move.
    assert_eq!(
        room.feed_rect, top_before,
        "the feed's own rect is unchanged"
    );
    assert_eq!(
        room.scrollback.scroll_info().0,
        offset_before,
        "and the operator's scroll position with it"
    );
    assert_eq!(
        row_text(&buffer, room.feed_rect.y),
        first_row_before,
        "so the row they were reading still paints the same cells"
    );

    // 3. The pill points at the answer that moved, and Ctrl+T lands on it.
    assert_eq!(
        guidance_text(&room, &buffer),
        format!("{arrow_up} claude answered{PILL_SUFFIX}"),
        "the pill names the agent whose answer just relocated"
    );
    assert!(press(&mut room, KeyCode::Char('t'), KeyModifiers::CONTROL));
    let buffer = frame(&mut room, 100, 16);
    assert_eq!(
        room.scrollback
            .answer_first_row_visible("claude-message", room.feed_rect),
        Some(true),
        "and Ctrl+T resolves the message id to wherever relocation left it"
    );
    assert!(
        !guidance_text(&room, &buffer).contains("answered"),
        "which clears the pill on that frame"
    );
}
