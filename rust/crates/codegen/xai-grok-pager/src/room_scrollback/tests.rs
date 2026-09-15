// Theme-resolving tests hold `pin_theme()` for their whole body: the theme is
// process-global (`xai-grok-pager-render/src/theme/cache.rs`), and
// `scrollback/blocks/thinking.rs`'s
// `thinking_body_dim_italic_survives_the_terminal_native_palette` flips
// `set_terminal_native_lock(true)` mid-run under `cache::test_lock()`.
// `pin_theme()` takes that same lock, so reader and writer are serialized.
use crate::theme::cache::pin_theme;

use super::test_fixture::{StepsTurn, apply_live, check, event_at, live_room};
use super::{
    MAX_FAILURE_DETAIL_WIDTH, RoomScrollback, RoomSpeaker, RoomTheme, compact_failure_detail,
    notice_phrase,
};
use crate::appearance::AppearanceConfig;
use crate::room_theme::{RoomIdentity, RoomSecondaryGlyph, room_secondary, room_spinner};
use crate::scrollback::{
    BlockContent, BlockContext, DisplayMode, EntryId, RenderBlock, ScrollbackSearchIndex,
    ScrollbackState,
};
use crate::search::{QueryKind, TextMatcher};
use serde_json::json;
use zer0_room_protocol::{LaneActivity, LanePhase, RoomEvent, RoomReducer};

fn event(sequence: u64, kind: &str, payload: serde_json::Value) -> RoomEvent {
    RoomEvent::from_value(json!({
        "protocol": "zer0.room",
        "version": 1,
        "sessionId": "scrollback-room",
        "eventSeq": sequence.to_string(),
        "eventId": format!("scrollback-{sequence}"),
        "turnId": "scrollback-turn",
        "occurredAt": "2026-08-02T00:00:00Z",
        "type": kind,
        "payload": payload,
    }))
    .expect("scrollback test event is reducer-valid")
}

fn durable_history() -> Vec<RoomEvent> {
    vec![
        event(
            1,
            "turn.accepted",
            json!({"agents":["claude","codex","gemini"],"text":"operator durable prompt","messageId":"operator-message","ledgerSeq":"1"}),
        ),
        event(
            2,
            "route.resolved",
            json!({"agents":["claude","codex","gemini"]}),
        ),
        event(
            3,
            "lane.queued",
            json!({"laneId":"claude-lane","agent":"claude","expectedMessageId":"claude-message","origin":"operator","hopIndex":0}),
        ),
        event(
            4,
            "lane.started",
            json!({"laneId":"claude-lane","streamId":"claude-stream","agent":"claude"}),
        ),
        event(
            5,
            "lane.failed",
            json!({"laneId":"claude-lane","streamId":"claude-stream","agent":"claude","error":"provider rejected the request"}),
        ),
        event(
            6,
            "backend.failed",
            json!({"message":"backend unavailable","error":"timeout"}),
        ),
        event(
            7,
            "lane.queued",
            json!({"laneId":"codex-lane","agent":"codex","expectedMessageId":"codex-message","origin":"operator","hopIndex":0}),
        ),
        event(
            8,
            "lane.cancelled",
            json!({"laneId":"codex-lane","agent":"codex"}),
        ),
        event(9, "backend.failed", json!({})),
        event(
            10,
            "lane.queued",
            json!({"laneId":"gemini-lane","agent":"gemini","expectedMessageId":"gemini-message","origin":"operator","hopIndex":0}),
        ),
        event(
            11,
            "lane.started",
            json!({"laneId":"gemini-lane","streamId":"gemini-stream","agent":"gemini"}),
        ),
        event(
            12,
            "message.committed",
            json!({"laneId":"gemini-lane","agent":"gemini","messageId":"gemini-message","ledgerSeq":"2","text":"gemini canonical result","origin":"operator","hopIndex":0}),
        ),
        event(
            13,
            "lane.completed",
            json!({"laneId":"gemini-lane","streamId":"gemini-stream","agent":"gemini"}),
        ),
    ]
}

fn matching_rows<'a>(text: &'a str, needle: &str) -> Vec<&'a str> {
    text.lines().filter(|line| line.contains(needle)).collect()
}

#[test]
fn provider_failures_are_one_safe_bounded_feed_line() {
    use unicode_width::UnicodeWidthStr;

    let raw = "agy exited 1 — output: \x1b[?9001h\x1b[2J\x1b]0;provider\x07\
            ERROR: logging before init: E0812 main.go:437] Failed to redirect output for CLI: \
            creating log file at C:\\Users\\operator\\provider.log: Access is denied.\u{202e}\r\n\
            secondary provider log noise that must not displace the actionable first failure";
    let compact = compact_failure_detail(raw).expect("visible failure detail");

    assert!(!compact.chars().any(char::is_control));
    assert!(!compact.contains("[?9001h"));
    assert!(!compact.contains('\u{202e}'));
    assert!(!compact.contains("logging before init"));
    assert!(compact.starts_with("Failed to redirect output"));
    assert!(compact.contains("Access is denied"));
    assert!(UnicodeWidthStr::width(compact.as_str()) <= MAX_FAILURE_DETAIL_WIDTH);
    assert!(compact.contains(&format!(
        " {} ",
        room_secondary(RoomSecondaryGlyph::Ellipsis)
    )));
}

#[test]
fn durable_snapshot_replays_terminal_and_backend_rows_once_in_decimal_order() {
    let mut reducer = RoomReducer::new();
    let mut live = RoomScrollback::new();
    for next in durable_history() {
        apply_live(&mut live, &mut reducer, next);
    }

    let rebuilt = RoomScrollback::from_reducer(&reducer);
    for text in [live.searchable_text(), rebuilt.searchable_text()] {
        assert_eq!(matching_rows(&text, "claude — failed").len(), 1);
        assert_eq!(matching_rows(&text, "codex — cancelled").len(), 1);
        assert_eq!(matching_rows(&text, "gemini canonical result").len(), 1);
        assert!(matching_rows(&text, "gemini — completed").is_empty());
        assert_eq!(
            matching_rows(&text, "backend failed"),
            vec![
                "backend failed — backend unavailable: timeout",
                "backend failed"
            ]
        );
    }

    let text = rebuilt.searchable_text();
    let failed = text.find("claude — failed").unwrap();
    let detailed_backend = text
        .find("backend failed — backend unavailable: timeout")
        .unwrap();
    let cancelled = text.find("codex — cancelled").unwrap();
    let bare_backend = text.rfind("backend failed").unwrap();
    let committed = text.find("gemini canonical result").unwrap();
    assert!(failed < detailed_backend);
    assert!(detailed_backend < cancelled);
    assert!(cancelled < bare_backend);
    assert!(
        bare_backend < committed,
        "decimal 9 must precede decimal 12"
    );
}

#[test]
fn snapshot_keeps_running_streams_after_durable_history() {
    let mut reducer = RoomReducer::new();
    for next in [
        event(
            1,
            "turn.accepted",
            json!({"agents":["claude"],"text":"operator first","messageId":"operator-message","ledgerSeq":"1"}),
        ),
        event(2, "route.resolved", json!({"agents":["claude"]})),
        event(
            3,
            "lane.queued",
            json!({"laneId":"lane","agent":"claude","expectedMessageId":"message","origin":"operator","hopIndex":0}),
        ),
        event(
            4,
            "lane.started",
            json!({"laneId":"lane","streamId":"stream","agent":"claude"}),
        ),
        event(
            5,
            "lane.chunk",
            json!({"laneId":"lane","streamId":"stream","agent":"claude","streamSeq":"1","chunkIndex":0,"channel":"assistant","text":"still running"}),
        ),
    ] {
        reducer.apply(&next).unwrap();
    }

    let rebuilt = RoomScrollback::from_reducer(&reducer);
    assert!(rebuilt.entry_id_for_stream("stream").is_some());
    let text = rebuilt.searchable_text();
    assert!(text.find("operator first").unwrap() < text.find("still running").unwrap());
}

#[test]
fn activity_updates_drive_one_live_status_and_freeze_terminal_history_on_replay() {
    let mut reducer = RoomReducer::new();
    let mut room = RoomScrollback::new();
    for next in [
        event(
            1,
            "turn.accepted",
            json!({"agents":["claude"],"text":"inspect auth","messageId":"operator-message","ledgerSeq":"1"}),
        ),
        event(2, "route.resolved", json!({"agents":["claude"]})),
        event(
            3,
            "lane.queued",
            json!({"laneId":"lane","agent":"claude","expectedMessageId":"message","origin":"operator","hopIndex":0}),
        ),
        event(
            4,
            "lane.started",
            json!({"laneId":"lane","streamId":"stream","agent":"claude"}),
        ),
        event(
            5,
            "lane.activity",
            json!({"laneId":"lane","streamId":"stream","agent":"claude","toolCallId":"tool-1","update":"tool_call","kind":"read auth.rs","status":"in_progress"}),
        ),
    ] {
        apply_live(&mut room, &mut reducer, next);
    }

    let ellipsis = room_secondary(RoomSecondaryGlyph::Ellipsis);
    assert!(
        room.searchable_text()
            .contains(&format!("{} read auth.rs{ellipsis}", room_spinner(0)))
    );
    let check = crate::glyphs::check_mark();
    assert!(
        !room
            .searchable_text()
            .contains(&format!("{check} read auth.rs"))
    );
    room.refresh_live_status(&reducer, 1);
    assert!(
        room.searchable_text()
            .contains(&format!("{} read auth.rs{ellipsis}", room_spinner(1)))
    );

    for next in [
        event(
            6,
            "lane.activity",
            json!({"laneId":"lane","streamId":"stream","agent":"claude","toolCallId":"tool-1","update":"tool_call_update","status":"completed"}),
        ),
        event(
            7,
            "lane.chunk",
            json!({"laneId":"lane","streamId":"stream","agent":"claude","streamSeq":"1","chunkIndex":0,"channel":"assistant","text":"auth inspection complete"}),
        ),
        event(
            8,
            "message.committed",
            json!({"laneId":"lane","agent":"claude","messageId":"message","ledgerSeq":"2","text":"auth inspection complete","origin":"operator","hopIndex":0}),
        ),
        event(
            9,
            "lane.completed",
            json!({"laneId":"lane","streamId":"stream","agent":"claude"}),
        ),
    ] {
        apply_live(&mut room, &mut reducer, next);
    }

    // DELIBERATE PIN CHANGE, slice C.
    //
    // This block used to assert `matching_rows(text, "{check} read auth.rs")
    // == 1` on both the live and the rebuilt room, because every terminal
    // tool call was its own frozen row carrying its own check mark. Slice C
    // folds those rows into one block whose indexed text is the UNSHORTENED
    // labels plus the summary line, so the glyph moved off the label onto
    // the summary and that count went to zero. Run against the new code, the
    // old assertion fails verbatim:
    //
    //     assertion `left == right` failed
    //       left: 0
    //      right: 1
    //
    // The property being pinned is unchanged and is re-asserted below: the
    // terminal tool call appears EXACTLY ONCE, in the same place on both
    // paths, and it precedes the answer. What changed is where the check
    // mark lives - and that is F-1's fix, because a check on every step row
    // is a claim the room cannot make about a failure.
    //
    // The duration reads `0.0s` because every event this fixture builds
    // shares one hard-coded timestamp (FL-116). It is a measured zero, not
    // an invented one; the absent case is pinned separately by
    // `a_duration_is_absent_when_started_at_is`.
    let step_label = "read auth.rs";
    let summary = format!("{check} 1 step · 0.0s");
    let live_text = room.searchable_text();
    assert_eq!(
        matching_rows(&live_text, step_label).len(),
        1,
        "one row for one terminal tool call: {live_text}"
    );
    assert!(
        !live_text.contains(&format!("{check} {step_label}")),
        "the check moved to the summary, off the step label: {live_text}"
    );
    assert_eq!(matching_rows(&live_text, &summary).len(), 1);
    assert!(
        live_text.find(step_label).unwrap() < live_text.find("auth inspection complete").unwrap(),
        "durable activity history must precede the final answer"
    );

    let rebuilt = RoomScrollback::from_reducer(&reducer);
    let rebuilt_text = rebuilt.searchable_text();
    assert_eq!(
        matching_rows(&rebuilt_text, step_label).len(),
        1,
        "snapshot replay must retain terminal activity without inventing an in-progress row"
    );
    assert_eq!(matching_rows(&rebuilt_text, &summary).len(), 1);
    assert!(
        rebuilt_text.find(step_label).unwrap()
            < rebuilt_text.find("auth inspection complete").unwrap(),
        "snapshot replay must preserve activity-before-answer order"
    );
    assert_eq!(
        live_text, rebuilt_text,
        "and the two paths agree row for row"
    );
}

#[test]
fn latest_activity_update_drives_status_even_when_the_tool_was_not_inserted_last() {
    let mut reducer = RoomReducer::new();
    let mut room = RoomScrollback::new();
    for next in [
        event(
            1,
            "turn.accepted",
            json!({"agents":["claude"],"text":"inspect","messageId":"operator-message","ledgerSeq":"1"}),
        ),
        event(2, "route.resolved", json!({"agents":["claude"]})),
        event(
            3,
            "lane.queued",
            json!({"laneId":"lane","agent":"claude","expectedMessageId":"message","origin":"operator","hopIndex":0}),
        ),
        event(
            4,
            "lane.started",
            json!({"laneId":"lane","streamId":"stream","agent":"claude"}),
        ),
        event(
            5,
            "lane.activity",
            json!({"laneId":"lane","streamId":"stream","agent":"claude","toolCallId":"tool-1","update":"tool_call","title":"Read auth.rs","status":"in_progress"}),
        ),
        event(
            6,
            "lane.activity",
            json!({"laneId":"lane","streamId":"stream","agent":"claude","toolCallId":"tool-2","update":"tool_call","title":"Search tokens","status":"in_progress"}),
        ),
        event(
            7,
            "lane.activity",
            json!({"laneId":"lane","streamId":"stream","agent":"claude","toolCallId":"tool-1","update":"tool_call_update","title":"Read auth.rs · 34 lines","status":"in_progress"}),
        ),
    ] {
        apply_live(&mut room, &mut reducer, next);
    }

    let text = room.searchable_text();
    let ellipsis = room_secondary(RoomSecondaryGlyph::Ellipsis);
    assert!(text.contains(&format!("Read auth.rs · 34 lines{ellipsis}")));
    assert!(!text.contains(&format!("Search tokens{ellipsis}")));
}

#[test]
fn snapshot_merges_an_earlier_running_stream_before_a_later_committed_reply() {
    let mut reducer = RoomReducer::new();
    for next in [
        event(
            1,
            "turn.accepted",
            json!({"agents":["claude","codex"],"text":"parallel","messageId":"operator-message","ledgerSeq":"1"}),
        ),
        event(2, "route.resolved", json!({"agents":["claude","codex"]})),
        event(
            3,
            "lane.queued",
            json!({"laneId":"claude-lane","agent":"claude","expectedMessageId":"claude-message","origin":"operator","hopIndex":0}),
        ),
        event(
            4,
            "lane.started",
            json!({"laneId":"claude-lane","streamId":"claude-stream","agent":"claude"}),
        ),
        event(
            5,
            "lane.chunk",
            json!({"laneId":"claude-lane","streamId":"claude-stream","agent":"claude","streamSeq":"1","chunkIndex":0,"channel":"assistant","text":"claude still running"}),
        ),
        event(
            6,
            "lane.queued",
            json!({"laneId":"codex-lane","agent":"codex","expectedMessageId":"codex-message","origin":"operator","hopIndex":0}),
        ),
        event(
            7,
            "lane.started",
            json!({"laneId":"codex-lane","streamId":"codex-stream","agent":"codex"}),
        ),
        event(
            8,
            "message.committed",
            json!({"laneId":"codex-lane","agent":"codex","messageId":"codex-message","ledgerSeq":"2","text":"codex done","origin":"operator","hopIndex":0}),
        ),
        event(
            9,
            "lane.completed",
            json!({"laneId":"codex-lane","streamId":"codex-stream","agent":"codex"}),
        ),
    ] {
        reducer.apply(&next).unwrap();
    }

    let rebuilt = RoomScrollback::from_reducer(&reducer);
    let text = rebuilt.searchable_text();
    assert!(text.find("claude still running").unwrap() < text.find("codex done").unwrap());
}

#[test]
fn handoff_leash_is_visible_once_live_and_after_snapshot_replay() {
    let mut reducer = RoomReducer::new();
    let mut live = RoomScrollback::new();
    for next in [
        event(
            1,
            "turn.accepted",
            json!({"agents":["claude"],"text":"start","messageId":"operator-message","ledgerSeq":"1"}),
        ),
        event(2, "route.resolved", json!({"agents":["claude"]})),
        event(
            3,
            "lane.queued",
            json!({"laneId":"parent-lane","agent":"claude","expectedMessageId":"parent-message","origin":"operator","hopIndex":0}),
        ),
        event(
            4,
            "lane.started",
            json!({"laneId":"parent-lane","streamId":"parent-stream","agent":"claude"}),
        ),
        event(
            5,
            "message.committed",
            json!({"laneId":"parent-lane","agent":"claude","messageId":"parent-message","ledgerSeq":"2","text":"@codex: review auth","origin":"operator","hopIndex":0}),
        ),
        event(
            6,
            "hop.dispatched",
            json!({"fromAgent":"claude","toAgent":"codex","parentMessageId":"parent-message","hopIndex":1,"hopBudget":1,"hopId":"hop-1","text":"review auth"}),
        ),
    ] {
        apply_live(&mut live, &mut reducer, next);
    }

    for text in [
        live.searchable_text(),
        RoomScrollback::from_reducer(&reducer).searchable_text(),
    ] {
        assert_eq!(matching_rows(&text, "hop 1/1").len(), 1);
        assert!(text.contains(&format!(
            "claude {} {} codex",
            room_secondary(RoomSecondaryGlyph::HopArrow),
            RoomIdentity::Codex.glyph()
        )));
        assert!(text.contains("“review auth”"));
    }
}

#[test]
fn reduced_motion_freezes_status_and_native_rail_ticks() {
    let mut reducer = RoomReducer::new();
    let mut room = RoomScrollback::new();
    for next in [
        event(
            1,
            "turn.accepted",
            json!({"agents":["claude"],"text":"start","messageId":"operator-message","ledgerSeq":"1"}),
        ),
        event(2, "route.resolved", json!({"agents":["claude"]})),
        event(
            3,
            "lane.queued",
            json!({"laneId":"lane","agent":"claude","expectedMessageId":"message","origin":"operator","hopIndex":0}),
        ),
        event(
            4,
            "lane.started",
            json!({"laneId":"lane","streamId":"stream","agent":"claude"}),
        ),
    ] {
        apply_live(&mut room, &mut reducer, next);
    }
    room.refresh_live_status(&reducer, 1);
    assert_eq!(room.animation_tick(), 1);
    let ellipsis = room_secondary(RoomSecondaryGlyph::Ellipsis);
    assert!(
        room.searchable_text()
            .contains(&format!("{} working{ellipsis}", room_spinner(1)))
    );

    room.set_reduced_motion(true);
    room.refresh_live_status(&reducer, 7);
    assert_eq!(room.animation_tick(), 1);
    assert!(
        room.searchable_text()
            .contains(&format!("{} working{ellipsis}", room_spinner(0)))
    );
}

#[test]
fn interleaved_streams_keep_stable_and_isolated_entry_ids() {
    let mut room = RoomScrollback::new();
    room.start_stream_bare("stream-claude", "lane-claude", "claude");
    room.start_stream_bare("stream-codex", "lane-codex", "codex");
    let claude = room.entry_id_for_stream("stream-claude").unwrap();
    let codex = room.entry_id_for_stream("stream-codex").unwrap();
    assert_ne!(claude, codex);

    assert!(room.push_stream_chunk("stream-claude", "first "));
    assert!(room.push_stream_chunk("stream-codex", "second "));
    assert!(room.push_stream_chunk("stream-claude", "third"));
    assert_eq!(room.stream_text("stream-claude"), Some("first third"));
    assert_eq!(room.stream_text("stream-codex"), Some("second "));
}

#[test]
fn content_id_binds_to_its_own_stream_entry_and_completion_is_immutable() {
    let mut room = RoomScrollback::new();
    room.start_stream_bare("stream-a", "lane-a", "claude");
    room.start_stream_bare("stream-b", "lane-b", "codex");
    room.push_stream_chunk("stream-a", "a");
    room.push_stream_chunk("stream-b", "b");
    room.commit_message_without_reducer("lane-a", "content-a", "a");
    room.commit_message_without_reducer("lane-b", "content-b", "b");

    assert_eq!(
        room.entry_id_for_content("content-a"),
        room.entry_id_for_stream("stream-a")
    );
    assert_eq!(
        room.entry_id_for_content("content-b"),
        room.entry_id_for_stream("stream-b")
    );
    assert_ne!(
        room.entry_id_for_content("content-a"),
        room.entry_id_for_content("content-b")
    );
    assert!(!room.push_stream_chunk("stream-a", " late"));
    assert_eq!(room.stream_text("stream-a"), Some("a"));
}

#[test]
fn canonical_commit_replaces_divergent_stream_in_place_without_touching_an_interleaved_stream() {
    use ratatui::style::Color;

    let mut room = RoomScrollback::new();
    room.start_stream_bare("stream-claude", "lane-claude", "claude");
    room.start_stream_bare("stream-codex", "lane-codex", "codex");
    let claude_entry = room.entry_id_for_stream("stream-claude").unwrap();
    let codex_entry = room.entry_id_for_stream("stream-codex").unwrap();
    assert!(room.push_stream_chunk("stream-claude", "draft"));
    assert!(room.push_stream_chunk("stream-codex", "still running"));

    room.commit_message_without_reducer("lane-claude", "message-claude", "canonical");

    assert_eq!(
        room.entry_id_for_content("message-claude"),
        Some(claude_entry)
    );
    assert_eq!(
        room.entry_id_for_stream("stream-claude"),
        Some(claude_entry)
    );
    assert_eq!(room.stream_text("stream-claude"), Some("canonical"));
    assert!(!room.push_stream_chunk("stream-claude", " late"));
    assert!(room.searchable_text().contains("canonical"));
    assert!(!room.searchable_text().contains("draft"));
    let claude = room
        .state
        .get_by_id(claude_entry)
        .and_then(|entry| entry.block.as_agent_message())
        .expect("canonical entry stays a native agent message");
    assert_eq!(claude.text(), "canonical");
    assert_eq!(claude.accent_color(), Some(Color::Rgb(245, 165, 36)));

    assert_eq!(room.entry_id_for_stream("stream-codex"), Some(codex_entry));
    assert_eq!(room.stream_text("stream-codex"), Some("still running"));
    assert!(room.push_stream_chunk("stream-codex", " and appendable"));
    assert_eq!(
        room.stream_text("stream-codex"),
        Some("still running and appendable")
    );
}

#[test]
fn streaming_markdown_uses_native_selection_search_fold_and_raw_paths() {
    let mut room = RoomScrollback::new();
    room.start_stream_bare("stream", "lane", "codex");
    assert!(room.push_stream_chunk("stream", "This is **really** "));
    assert!(room.push_stream_chunk("stream", "important."));
    room.finish_lane_bare("lane", "codex", LanePhase::Completed);
    assert!(!room.searchable_text().contains("completed"));
    room.state.prepare_layout(80, 12);

    let stream_id = room.entry_id_for_stream("stream").unwrap();
    let mut search = ScrollbackSearchIndex::new();
    assert!(search.sync(&room.state));
    let matches = search.find(&TextMatcher::new(
        "is really important",
        QueryKind::Substring,
    ));
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].entry_id, stream_id);

    room.select_next();
    room.select_next();
    assert_eq!(room.state.selected(), Some(1));
    room.toggle_raw_selected();
    assert_eq!(
        room.state
            .entry(1)
            .unwrap()
            .block
            .copy_text(true)
            .as_deref(),
        Some("This is **really** important.")
    );

    room.state
        .push_block(crate::scrollback::RenderBlock::user_prompt(
            "x".repeat(2_000),
        ));
    room.state.prepare_layout(80, 12);
    room.select_next();
    assert_eq!(room.state.selected(), Some(2));
    assert_eq!(
        room.state.entry(2).unwrap().display_mode(),
        DisplayMode::Collapsed
    );
    room.toggle_fold_selected();
    assert_eq!(
        room.state.entry(2).unwrap().display_mode(),
        DisplayMode::Expanded
    );
}

#[test]
fn speaker_headers_are_distinct_and_terminal_outcomes_are_attributed() {
    let mut room = RoomScrollback::new();
    room.start_stream_bare("stream-c", "lane-c", "claude");
    room.start_stream_bare("stream-x", "lane-x", "codex");
    room.finish_lane_bare("lane-c", "claude", LanePhase::Failed);
    room.finish_lane_bare("lane-x", "codex", LanePhase::Cancelled);

    let text = (0..room.state.len())
        .filter_map(|index| {
            room.state
                .entry(index)
                .and_then(|entry| entry.block.searchable_text())
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(text.contains("claude"));
    assert!(text.contains("codex"));
    assert!(text.contains("claude — failed"));
    assert!(text.contains("codex — cancelled"));
}

/// FL-141 (operator ruling, 2026-08-21, with a capture: "it doesn't look
/// good, the 3 from top should become gray and say cancelled under, why
/// spawn 3 new ones?"). A cancel used to leave the three original rows on
/// screen empty and in full agent colour, then APPEND three more reading
/// "agent — cancelled" below them in whichever order the lanes happened
/// to settle, rather than roster order. The ruling: one row per agent,
/// gray, carrying "cancelled", in roster order - restyled, never
/// appended.
///
/// FL-141b (2026-08-22) moved the word ONTO the header, so the marker row
/// this test used to pin is gone; every assertion below that named it now
/// names the header instead. The entry count drops from nine to six for
/// the same reason - header and message per lane, nothing appended.
///
/// The "not six" half of the name is carried by the ENTRY COUNT, not by
/// counting lines that contain the word. A review of the first fix caught
/// that: three appended rows contain the word too, so the line count read
/// 3 on the buggy tree as well and the assertion could not fail. Six rows
/// is six entries; three is three.
#[test]
fn a_cancel_of_three_lanes_restyles_the_row_in_roster_order_not_six_new_ones() {
    let mut room = RoomScrollback::new();
    room.start_stream_bare("stream-claude", "lane-claude", "claude");
    room.start_stream_bare("stream-codex", "lane-codex", "codex");
    room.start_stream_bare("stream-gemini", "lane-gemini", "gemini");

    // Settle out of roster order - gemini, then claude, then codex - the
    // exact shape the operator's capture showed (settle order, not
    // dispatch order). A fix that gets the wording right but rebuilds the
    // rows by APPENDING them as they settle would still fail the order
    // assertion below.
    room.finish_lane_bare("lane-gemini", "gemini", LanePhase::Cancelled);
    room.finish_lane_bare("lane-claude", "claude", LanePhase::Cancelled);
    room.finish_lane_bare("lane-codex", "codex", LanePhase::Cancelled);

    let text = room.searchable_text();
    let cancelled_rows: Vec<&str> = text
        .lines()
        .filter(|line| line.contains("cancelled"))
        .collect();
    assert_eq!(
        cancelled_rows.len(),
        3,
        "three cancelled lanes must draw three rows, not six: {text:?}"
    );

    // The bite, and it is per-lane rather than a total count: the word has
    // to be on the lane's OWN header, in that lane's own block. Three rows
    // collected at the bottom of the room pass every wording, count and
    // roster-order assertion and fail this one.
    let rows: Vec<String> = (0..room.state.len())
        .filter_map(|index| room.state.entry(index))
        .map(|entry| entry.block.searchable_text().unwrap_or_default())
        .collect();
    assert_eq!(
        rows.len(),
        6,
        "one header and one (empty, never-streamed) message for each of \
             the three lanes, and nothing appended: {rows:?}"
    );
    for (offset, agent) in ["claude", "codex", "gemini"].into_iter().enumerate() {
        let glyph = RoomSpeaker::from_agent(agent).glyph();
        assert_eq!(
            rows[offset * 2],
            format!("{glyph} {agent} — cancelled"),
            "{agent}'s block opens with its own header, and that header IS \
                 the row carrying the word: {rows:?}"
        );
        assert_eq!(
            rows[offset * 2 + 1],
            "",
            "with only {agent}'s own empty message under it - no second \
                 row saying the same thing: {rows:?}"
        );
    }
    for agent in ["claude", "codex", "gemini"] {
        assert_eq!(
            matching_rows(&text, &format!("{agent} — cancelled")).len(),
            1,
            "exactly one row carrying the word for {agent}: {text:?}"
        );
    }

    let claude_at = text.find("claude — cancelled").expect("claude's row");
    let codex_at = text.find("codex — cancelled").expect("codex's row");
    let gemini_at = text.find("gemini — cancelled").expect("gemini's row");
    assert!(
        claude_at < codex_at && codex_at < gemini_at,
        "rows must stay in roster (dispatch) order, not settle order: {text:?}"
    );

    // Every part of the row goes gray: the header stub and the message's
    // rail. Restyled means gray, not the agent's own identity colour, for
    // the whole block.
    let faint = RoomTheme::current().faint;
    let mut dim_stubs = 0;
    let mut dim_messages = 0;
    for index in 0..room.state.len() {
        let Some(entry) = room.state.entry(index) else {
            continue;
        };
        match &entry.block {
            RenderBlock::Stub(stub) => {
                assert_eq!(
                    stub.accent_color, faint,
                    "a cancelled lane's rows must be gray, not its identity colour: {}",
                    stub.text
                );
                dim_stubs += 1;
            }
            RenderBlock::AgentMessage(message) => {
                assert_eq!(
                    message.accent_color(),
                    Some(faint),
                    "a cancelled lane's message rail must be gray too: {}",
                    message.text()
                );
                dim_messages += 1;
            }
            _ => {}
        }
    }
    assert_eq!(
        dim_stubs, 3,
        "one dim header for each of the three lanes, and no marker stub \
             beside it"
    );
    assert_eq!(
        dim_messages, 3,
        "and each lane's own message entry, kept and dimmed rather than \
             replaced by an appended row"
    );
}

/// FL-141's trap, re-aimed by the fix round. It used to assert that a
/// reload draws a cancelled lane FRESH - a dim header stub plus a separate
/// dim marker stub - because a terminal lane was never re-materialized as
/// a stream, so `finish_lane` had nothing to restyle and every rebuilt row
/// was an append. Appending is what put three cancelled lanes back in
/// settle order after a reload, so `replay_stream_for_lane` now replays
/// the stream and the rebuild takes the SAME restyle-in-place arm the live
/// room takes.
///
/// What this still guards is unchanged in substance: exactly one row
/// carries the word, the lane's recorded steps survive the restyle, and
/// every part of the row - header stub, message rail, message text - reads
/// gray. What moved (FL-141b) is which entity carries the word: the header
/// itself, so the stub list below is one entry, not a header plus a
/// marker.
#[test]
fn a_cancel_with_no_commit_rebuilds_as_one_gray_row_carrying_its_steps() {
    let (live, reducer) = live_room(&[StepsTurn {
        agent: "codex",
        lane: "lane-codex",
        stream: "stream-codex",
        turn: "turn-codex",
        statuses: vec!["completed"],
        answer: None,
        ending: "lane.cancelled",
    }]);

    let rebuilt = RoomScrollback::from_reducer(&reducer);
    let text = rebuilt.searchable_text();
    assert_eq!(
        text,
        live.searchable_text(),
        "a reload of a cancelled lane must fold to the live room's own rows"
    );

    let cancelled_rows: Vec<&str> = text
        .lines()
        .filter(|line| line.contains("cancelled"))
        .collect();
    assert_eq!(
        cancelled_rows.len(),
        1,
        "the rebuild must carry the word exactly once, not on a bare header \
             plus a separate outcome row: {text:?}"
    );
    assert!(
        cancelled_rows[0].contains("codex"),
        "that one row must still say which agent: {cancelled_rows:?}"
    );
    assert!(
        text.contains("step"),
        "the lane's one recorded step must not be dropped by the restyle: {text:?}"
    );

    // Scoped to codex's own entries - the fixture also carries the
    // operator's "you" prompt header, in its own (unrelated) colour.
    let faint = RoomTheme::current().faint;
    let glyph = RoomSpeaker::Codex.glyph();
    let mut codex_stubs: Vec<String> = Vec::new();
    for index in 0..rebuilt.state.len() {
        let Some(entry) = rebuilt.state.entry(index) else {
            continue;
        };
        if let RenderBlock::Stub(stub) = &entry.block
            && stub.text.contains("codex")
        {
            assert_eq!(
                stub.accent_color, faint,
                "every row a cancelled lane draws must be gray, not its own colour: {}",
                stub.text
            );
            codex_stubs.push(stub.text.clone());
        }
    }
    assert_eq!(
        codex_stubs,
        vec![format!("{glyph} codex — cancelled")],
        "exactly one dim stub - the header, carrying the word - and no bare \
             header beside it: {text:?}"
    );
}

/// FL-141 fix round. One turn that dispatches all three agents in roster
/// order (claude, codex, gemini), lets each stream a chunk, and then
/// cancels them in `cancel_order` - which every caller deliberately sets
/// to something OTHER than the roster order, because settle order is the
/// exact thing the operator's ruling forbids.
///
/// `started` false drops `lane.started` and `lane.chunk` entirely: that is
/// the cancel that lands while every lane is still queued, which reaches a
/// different arm of `finish_lane` and used to append in settle order too.
fn three_lane_cancel_history(cancel_order: [&str; 3], started: bool) -> Vec<RoomEvent> {
    three_lane_cancel_history_with_chunks(cancel_order, started, started)
}

/// FL-141b: the operator's own capture is a lane that STARTED and then was
/// cancelled before a single chunk arrived (`@all hi`, then Esc). That shape
/// has a header on screen and nothing under it, which is exactly where a
/// header-plus-marker pair reads as two gray rows for one agent, so it needs
/// its own history - `started` alone always brought chunks with it.
///
/// `chunks` is only meaningful when `started` is true; a lane that never
/// started cannot have streamed.
fn three_lane_cancel_history_with_chunks(
    cancel_order: [&str; 3],
    started: bool,
    chunks: bool,
) -> Vec<RoomEvent> {
    const ROSTER: [(&str, &str, &str); 3] = [
        ("claude", "claude-lane", "claude-stream"),
        ("codex", "codex-lane", "codex-stream"),
        ("gemini", "gemini-lane", "gemini-stream"),
    ];
    let mut events = vec![
        event(
            1,
            "turn.accepted",
            json!({"agents":["claude","codex","gemini"],"text":"do the work","messageId":"operator-message","ledgerSeq":"1"}),
        ),
        event(
            2,
            "route.resolved",
            json!({"agents":["claude","codex","gemini"]}),
        ),
    ];
    let mut seq = 3;
    for (agent, lane, _) in ROSTER {
        events.push(event(
                seq,
                "lane.queued",
                json!({"laneId":lane,"agent":agent,"expectedMessageId":format!("{agent}-message"),"origin":"operator","hopIndex":0}),
            ));
        seq += 1;
    }
    if started {
        for (agent, lane, stream) in ROSTER {
            events.push(event(
                seq,
                "lane.started",
                json!({"laneId":lane,"streamId":stream,"agent":agent}),
            ));
            seq += 1;
        }
        for (agent, lane, stream) in ROSTER {
            if !chunks {
                break;
            }
            events.push(event(
                    seq,
                    "lane.chunk",
                    json!({"laneId":lane,"streamId":stream,"agent":agent,"streamSeq":"1","chunkIndex":0,"channel":"assistant","text":format!("{agent} was working on it")}),
                ));
            seq += 1;
        }
    }
    for agent in cancel_order {
        let (_, lane, stream) = ROSTER
            .iter()
            .copied()
            .find(|(name, _, _)| *name == agent)
            .expect("cancel order names a roster agent");
        let mut payload = json!({"laneId":lane,"agent":agent});
        if started {
            payload["streamId"] = json!(stream);
        }
        events.push(event(seq, "lane.cancelled", payload));
        seq += 1;
    }
    events
}

/// Drive a hand-built event list into a fresh live room, keeping the
/// reducer so the reloaded twin can be rebuilt from the same state.
fn live_room_from(events: Vec<RoomEvent>) -> (RoomScrollback, RoomReducer) {
    let mut reducer = RoomReducer::new();
    let mut room = RoomScrollback::new();
    for next in events {
        apply_live(&mut room, &mut reducer, next);
    }
    (room, reducer)
}

/// A long session: `turns` turns, each one operator prompt and one committed
/// claude answer, so the transcript holds `2 × turns` rows over `turns` lanes.
///
/// Built for CQ-04, whose whole question is what a REBUILD costs as the
/// transcript grows. Each turn settles before the next prompt arrives, so no
/// commit is displaced and slice D's relocation never fires — this measures
/// the replay path and nothing else.
fn long_session(turns: u64) -> Vec<RoomEvent> {
    let mut events = Vec::new();
    let mut seq = 1;
    for turn in 0..turns {
        let turn_id = format!("turn-{turn}");
        let lane = format!("lane-{turn}");
        let stream = format!("stream-{turn}");
        let message = format!("m-{turn}");
        for (kind, payload) in [
            (
                "turn.accepted",
                json!({"agents":["claude"],"text":"do the work","messageId":format!("p-{turn}"),"ledgerSeq":seq.to_string()}),
            ),
            ("route.resolved", json!({"agents":["claude"]})),
            (
                "lane.queued",
                json!({"laneId":lane,"agent":"claude","expectedMessageId":message,"origin":"operator","hopIndex":0}),
            ),
            (
                "lane.started",
                json!({"laneId":lane,"streamId":stream,"agent":"claude"}),
            ),
            (
                "lane.chunk",
                json!({"laneId":lane,"streamId":stream,"agent":"claude","streamSeq":"1","chunkIndex":0,"channel":"assistant","text":"partial"}),
            ),
            (
                "message.committed",
                json!({"laneId":lane,"agent":"claude","messageId":message,"ledgerSeq":"PLACEHOLDER","text":"the answer","origin":"operator","hopIndex":0}),
            ),
            (
                "lane.completed",
                json!({"laneId":lane,"streamId":stream,"agent":"claude"}),
            ),
        ] {
            let mut payload = payload;
            // The ledger sequence rides the event sequence so it stays
            // monotonic across every turn, exactly as `StepsTurn` does it.
            if payload.get("ledgerSeq").is_some() {
                payload["ledgerSeq"] = json!(seq.to_string());
            }
            events.push(event_at(
                seq,
                kind,
                payload,
                "2026-08-02T00:00:00Z",
                &turn_id,
            ));
            seq += 1;
        }
    }
    events
}

/// The same session, PIPELINED so every answer is displaced.
///
/// Turn `t` starts and streams, then turn `t+1`'s prompt arrives, and only then
/// does turn `t` commit. That is exactly slice D's displacement shape
/// (`turn_first_draw_seq(T) < later_prompt < commit_seq`), so the predicate
/// finds a prompt on EVERY commit and the whole turn block relocates to the
/// tail every time.
///
/// RP round 2 needed this because `long_session` cannot measure the predicate at
/// all: with each turn settling before the next prompt, the window between a
/// turn's first draw and its commit holds no transcript rows, so the bounded
/// scan examines nothing and the probe counter reads zero. A benchmark on that
/// shape also never exercises the relocation MOVE, which the round-1 report
/// named as a gap in its own numbers. This is the worst case for both.
fn long_session_with_displacement(turns: u64) -> Vec<RoomEvent> {
    let mut events = Vec::new();
    let mut seq = 1;
    let mut push = |seq: &mut u64, kind: &str, mut payload: serde_json::Value, turn_id: &str| {
        if payload.get("ledgerSeq").is_some() {
            payload["ledgerSeq"] = json!(seq.to_string());
        }
        events.push(event_at(
            *seq,
            kind,
            payload,
            "2026-08-02T00:00:00Z",
            turn_id,
        ));
        *seq += 1;
    };
    let settle = |seq: &mut u64,
                  push: &mut dyn FnMut(&mut u64, &str, serde_json::Value, &str),
                  turn: u64| {
        let turn_id = format!("turn-{turn}");
        let lane = format!("lane-{turn}");
        let stream = format!("stream-{turn}");
        let message = format!("m-{turn}");
        push(
            seq,
            "message.committed",
            json!({"laneId":lane,"agent":"claude","messageId":message,"ledgerSeq":"0","text":"the answer","origin":"operator","hopIndex":0}),
            &turn_id,
        );
        push(
            seq,
            "lane.completed",
            json!({"laneId":lane,"streamId":stream,"agent":"claude"}),
            &turn_id,
        );
    };
    for turn in 0..turns {
        let turn_id = format!("turn-{turn}");
        let lane = format!("lane-{turn}");
        let stream = format!("stream-{turn}");
        let message = format!("m-{turn}");
        push(
            &mut seq,
            "turn.accepted",
            json!({"agents":["claude"],"text":"do the work","messageId":format!("p-{turn}"),"ledgerSeq":"0"}),
            &turn_id,
        );
        push(
            &mut seq,
            "route.resolved",
            json!({"agents":["claude"]}),
            &turn_id,
        );
        push(
            &mut seq,
            "lane.queued",
            json!({"laneId":lane,"agent":"claude","expectedMessageId":message,"origin":"operator","hopIndex":0}),
            &turn_id,
        );
        push(
            &mut seq,
            "lane.started",
            json!({"laneId":lane,"streamId":stream,"agent":"claude"}),
            &turn_id,
        );
        push(
            &mut seq,
            "lane.chunk",
            json!({"laneId":lane,"streamId":stream,"agent":"claude","streamSeq":"1","chunkIndex":0,"channel":"assistant","text":"partial"}),
            &turn_id,
        );
        // The PREVIOUS turn settles only now, under this turn's prompt.
        if turn > 0 {
            settle(&mut seq, &mut push, turn - 1);
        }
    }
    if turns > 0 {
        settle(&mut seq, &mut push, turns - 1);
    }
    events
}

/// The agents whose rows carry the word, top to bottom. This is the whole
/// operator ruling in one value: three names, in dispatch order.
fn cancelled_row_order(text: &str) -> Vec<&'static str> {
    text.lines()
        .filter(|line| line.contains("cancelled"))
        .filter_map(|line| {
            ["claude", "codex", "gemini"]
                .into_iter()
                .find(|agent| line.contains(agent))
        })
        .collect()
}

/// Every painted row of a real frame as (text, one foreground per cell).
/// Asserting on this rather than on `accent_color()` is the point: the
/// rail is not the text, and only the frame can tell them apart.
fn painted_rows(
    room: &mut RoomScrollback,
    width: u16,
    height: u16,
) -> Vec<(String, Vec<ratatui::style::Color>)> {
    use ratatui::buffer::Buffer;
    use ratatui::layout::Rect;

    let area = Rect::new(0, 0, width, height);
    let mut buffer = Buffer::empty(area);
    let _ = room.render(area, &mut buffer);
    (0..height)
        .map(|y| {
            let mut text = String::new();
            let mut colours = Vec::new();
            for x in 0..width {
                let cell = buffer.cell((x, y)).expect("cell inside the rendered area");
                text.push(cell.symbol().chars().next().unwrap_or(' '));
                colours.push(cell.fg);
            }
            (text, colours)
        })
        .collect()
}

/// FL-141 P1 (review of e950144): after a session reload the same three
/// cancelled lanes came back in SETTLE order - gemini, claude, codex -
/// which is the operator's original complaint verbatim. `from_reducer`
/// sorts a terminal lane by `terminal_event_seq`, the moment it settled,
/// and no arm that runs on a rebuild restyles anything in place, so every
/// row was freshly appended in the order the cancels landed.
#[test]
fn a_reloaded_room_shows_three_cancelled_lanes_in_roster_order() {
    let (live, reducer) = live_room_from(three_lane_cancel_history(
        ["gemini", "claude", "codex"],
        true,
    ));
    let rebuilt = RoomScrollback::from_reducer(&reducer);

    assert_eq!(
        cancelled_row_order(&live.searchable_text()),
        vec!["claude", "codex", "gemini"],
        "the live room already reads in roster order: {:?}",
        live.searchable_text()
    );
    assert_eq!(
        cancelled_row_order(&rebuilt.searchable_text()),
        vec!["claude", "codex", "gemini"],
        "a reloaded session must show the same roster order the live room did: {:?}",
        rebuilt.searchable_text()
    );

    let rebuilt_text = rebuilt.searchable_text();
    for agent in ["claude", "codex", "gemini"] {
        assert!(
            rebuilt_text.contains(&format!("{agent} was working on it")),
            "the reload must keep what the lane had already streamed: {rebuilt_text:?}"
        );
        // Count bite. Each lane owes exactly one header row, and since
        // FL-141b that header is the row carrying the word; a regression
        // that draws the lane a second time - even in roster order - shows
        // up here as a duplicate, and the FL-141b regression (a bare
        // header left beside it) shows up as a non-zero second count.
        // Matched as whole lines, because the cancelled row also contains
        // the bare header's text.
        let glyph = RoomSpeaker::from_agent(agent).glyph();
        let bare_header = format!("{glyph} {agent}");
        let header = format!("{glyph} {agent} — cancelled");
        assert_eq!(
            rebuilt_text.lines().filter(|line| *line == header).count(),
            1,
            "exactly one header row for {agent} after a reload, carrying \
                 the word: {rebuilt_text:?}"
        );
        assert_eq!(
            rebuilt_text
                .lines()
                .filter(|line| *line == bare_header)
                .count(),
            0,
            "and no bare header row left beside it: {rebuilt_text:?}"
        );
    }
}

/// FL-141 P1 (review of e950144): `a_rebuilt_room_folds_identically_to_a_live_one`
/// uses exactly ONE cancelled lane, last in roster and last to settle, so
/// it structurally cannot see an ordering divergence. Three lanes can.
#[test]
fn a_three_lane_cancel_folds_identically_live_and_rebuilt() {
    let (live, reducer) = live_room_from(three_lane_cancel_history(
        ["gemini", "claude", "codex"],
        true,
    ));
    let rebuilt = RoomScrollback::from_reducer(&reducer);
    assert_eq!(
        live.searchable_text(),
        rebuilt.searchable_text(),
        "live and rebuilt rooms must fold to the same rows in the same order"
    );
}

/// FL-141 P1 (review of e950144): `finish_lane`'s third arm - the cancel
/// that lands before `lane.started` ever fires - has no row to restyle, so
/// it pushes one, and a push lands in settle order. The ruling's order arm
/// is unconditional, so this shape owes roster order too.
#[test]
fn a_cancel_that_lands_before_any_lane_starts_still_reads_in_roster_order() {
    let (live, reducer) = live_room_from(three_lane_cancel_history(
        ["gemini", "claude", "codex"],
        false,
    ));
    let rebuilt = RoomScrollback::from_reducer(&reducer);

    assert_eq!(
        cancelled_row_order(&live.searchable_text()),
        vec!["claude", "codex", "gemini"],
        "a cancel that lands before any lane started must still read in \
             roster order: {:?}",
        live.searchable_text()
    );
    assert_eq!(
        cancelled_row_order(&rebuilt.searchable_text()),
        vec!["claude", "codex", "gemini"],
        "and it must survive a reload in that order: {:?}",
        rebuilt.searchable_text()
    );
    assert_eq!(
        live.searchable_text(),
        rebuilt.searchable_text(),
        "live and rebuilt rooms must fold to the same rows in the same order"
    );
}

/// FL-141b (operator ruling, 2026-08-22 15:5x, screenshot
/// `WindowsTerminal_aBlfEhQjMI.png`): after `@all hi` + Esc the room showed
/// TWO gray rows per agent - the original header, now gray and empty, and a
/// separate marker row beneath it. Verbatim: "the previous claude codex and
/// gemini are still displayed, it should display just the claude cancelled,
/// codex cancelled and gemini cancelled that's it no?"
///
/// So: exactly ONE row per cancelled agent, and the row is the HEADER
/// itself. This asserts on a PAINTED frame and on every row the agent's name
/// reaches, not on rows containing the word "cancelled" - the count of rows
/// carrying the word was already 3 on the six-row tree, which is precisely
/// why the older count assertion could not see this defect.
#[test]
fn a_cancel_before_any_text_paints_exactly_one_row_per_agent() {
    let _theme = pin_theme();
    let (mut live, _reducer) = live_room_from(three_lane_cancel_history_with_chunks(
        ["gemini", "claude", "codex"],
        true,
        false,
    ));
    let rows = painted_rows(&mut live, 100, 40);
    let visible: Vec<&str> = rows
        .iter()
        .map(|(text, _)| text.trim_end())
        .filter(|text| !text.is_empty())
        .collect();
    let faint = RoomTheme::current().faint;
    for agent in ["claude", "codex", "gemini"] {
        let glyph = RoomSpeaker::from_agent(agent).glyph();
        // The painted row carries the turn's quote bar, so this matches on the
        // row's END rather than the whole cell run - the bar is not this
        // slice's business and pinning it would break on any quoting change.
        let expected = format!("{glyph} {agent} \u{2014} cancelled");
        let owned: Vec<&(String, Vec<ratatui::style::Color>)> = rows
            .iter()
            .filter(|(text, _)| text.contains(agent))
            .collect();
        assert_eq!(
            owned.len(),
            1,
            "a cancelled {agent} owes ONE painted row, the header carrying \
                 the word - not a gray empty header plus a marker beneath it. \
                 whole frame: {visible:?}"
        );
        let (text, colours) = owned[0];
        assert!(
            text.trim_end().ends_with(&expected),
            "and that row IS the header, reading {expected:?}: {visible:?}"
        );
        // Colour PER PAINTED CELL, over the header's own text only - the
        // quote bar in front of it belongs to the turn, not to this lane.
        // The rail is not the text: an earlier round of FL-141 passed a
        // colour assertion that read `accent_color()` while the glyphs were
        // still painted in the agent's own hue.
        // `painted_rows` pushes one char per cell, so a char index into the
        // trimmed row is a cell index into `colours`.
        let trimmed = text.trim_end();
        let start = trimmed.chars().count() - expected.chars().count();
        for (index, ch) in trimmed.chars().enumerate().skip(start) {
            if ch == ' ' {
                continue;
            }
            assert_eq!(
                colours[index],
                faint,
                "every painted glyph of {agent}'s cancelled header must be \
                     gray, not its identity colour: {:?}",
                text.trim_end()
            );
        }
    }

    // Same shape after a reload. `from_reducer` draws a cancelled lane through
    // the same restyle arm, and a fix applied to only one of the two paths
    // would show up here as the six-row frame coming back on the rebuild.
    let mut rebuilt = RoomScrollback::from_reducer(&_reducer);
    assert_eq!(
        rebuilt.searchable_text(),
        live.searchable_text(),
        "a reload of three text-less cancelled lanes must fold to the live \
             room's own rows"
    );
    let rebuilt_rows = painted_rows(&mut rebuilt, 100, 40);
    assert_eq!(
        rebuilt_rows
            .iter()
            .map(|(text, _)| text.trim_end())
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>(),
        visible,
        "and it must PAINT the same frame, not just carry the same text"
    );
}

/// FL-141: an earlier round appended the word into a MARKDOWN message, so
/// it had to survive being parsed as markdown - and the identity glyphs it
/// starts with do not. This is the FL-107 shape: green on the modern glyph
/// set, wrong under `GROK_FORCE_LEGACY_CONSOLE=1`, where the glyphs are
/// ASCII and `*` is a bullet and `#` is a heading. Codex's row came out as
/// "codex — cancelled" with its `#` eaten; claude's `*` became `•`.
///
/// Still the witness after FL-141b moved the word onto the header: the
/// header is a `Stub` too, and this test would catch any future round that
/// routed the string back through the markdown parser. It compares the row
/// the room actually renders against `cancelled_row_text` itself, so it
/// fails for any glyph set whose mark the renderer rewrites.
/// `verify-rust.mjs` runs this crate a second time with that variable set,
/// which is the run that catches it.
///
/// THE NAME IS PINNED. `scripts/verify-rust.mjs:32` holds it as
/// `LEGACY_GLYPH_WITNESS` and fails the gate if the legacy run's output never
/// shows this exact test executing - that is the guard against a filter that
/// quietly stops matching. FL-141b left the name alone for that reason even
/// though the row it witnesses is now the header; rename it only together
/// with that constant.
#[test]
fn the_cancelled_marker_survives_markdown_on_every_glyph_set() {
    let (live, _reducer) = live_room_from(three_lane_cancel_history(
        ["gemini", "claude", "codex"],
        true,
    ));
    let text = live.searchable_text();
    for (agent, speaker) in [
        ("claude", RoomSpeaker::Claude),
        ("codex", RoomSpeaker::Codex),
        ("gemini", RoomSpeaker::Gemini),
    ] {
        let expected = super::cancelled_row_text(speaker);
        assert!(
            text.lines().any(|line| line == expected),
            "{agent}'s cancelled row must reach the screen exactly as built - a \
                 glyph the markdown renderer claims as syntax is rewritten or \
                 swallowed on the way. expected {expected:?} in: {text:?}"
        );
    }
}

/// FL-141 P1 (review of e950144): the line carrying the word was painted
/// `Rgb(200,200,200)` - the pager's default markdown text - while gray is
/// `RoomTheme::faint`. The old test could not see it: it asserted
/// `accent_color()`, which is the entry RAIL, not the text. Upstream puts
/// the dim on the SPANS
/// (`D:/grok-ref/.../scrollback/blocks/workflow.rs:109-115`), and only a
/// painted frame can tell the two apart.
#[test]
fn a_cancelled_lane_paints_its_text_gray_on_a_real_frame() {
    let _theme = pin_theme();
    let (mut live, _reducer) = live_room_from(three_lane_cancel_history(
        ["gemini", "claude", "codex"],
        true,
    ));
    let faint = RoomTheme::current().faint;
    let rows = painted_rows(&mut live, 100, 40);

    let carrying: Vec<&(String, Vec<ratatui::style::Color>)> = rows
        .iter()
        .filter(|(text, _)| text.contains("cancelled"))
        .collect();
    assert_eq!(
        carrying.len(),
        3,
        "three cancelled lanes owe three painted rows carrying the word: {:?}",
        rows.iter()
            .map(|(text, _)| text.trim_end())
            .collect::<Vec<_>>()
    );
    for (text, colours) in carrying {
        for (index, ch) in text.chars().enumerate() {
            if ch == ' ' {
                continue;
            }
            assert_eq!(
                colours[index],
                faint,
                "every painted glyph of the row carrying the word must be gray, \
                     not the pager's default text colour: {:?}",
                text.trim_end()
            );
        }
    }

    let streamed: Vec<&(String, Vec<ratatui::style::Color>)> = rows
        .iter()
        .filter(|(text, _)| text.contains("was working on it"))
        .collect();
    assert_eq!(
        streamed.len(),
        3,
        "the three lanes' streamed text is still on screen: {:?}",
        rows.iter()
            .map(|(text, _)| text.trim_end())
            .collect::<Vec<_>>()
    );
    for (text, colours) in streamed {
        for (index, ch) in text.chars().enumerate() {
            if ch == ' ' {
                continue;
            }
            assert_eq!(
                colours[index],
                faint,
                "the answer a cancelled lane had already streamed goes gray with \
                     the rest of its row: {:?}",
                text.trim_end()
            );
        }
    }
}

#[test]
fn render_buffer_exposes_identity_glyphs_and_hues_without_provider_columns() {
    use ratatui::{buffer::Buffer, layout::Rect, style::Color};

    for (stream, lane, agent, identity, hue) in [
        (
            "stream-c",
            "lane-c",
            "claude",
            RoomIdentity::Claude,
            Color::Rgb(245, 165, 36),
        ),
        (
            "stream-x",
            "lane-x",
            "codex",
            RoomIdentity::Codex,
            Color::Rgb(45, 212, 191),
        ),
        (
            "stream-g",
            "lane-g",
            "gemini",
            RoomIdentity::Gemini,
            Color::Rgb(199, 125, 255),
        ),
    ] {
        let mut room = RoomScrollback::new();
        room.start_stream_bare(stream, lane, agent);
        assert!(room.push_stream_chunk(stream, "body line one  \nbody line two"));
        room.finish_lane_bare(lane, agent, LanePhase::Completed);
        let entry = room
            .state
            .get_by_id(room.entry_id_for_stream(stream).unwrap())
            .and_then(|entry| entry.block.as_agent_message())
            .expect("stream remains a native AgentMessage entry");
        assert_eq!(entry.accent_color(), Some(hue));
        let area = Rect::new(0, 0, 80, 32);
        let mut buffer = Buffer::empty(area);
        // Painted cells only; the hit-test model is not this test's subject.
        let _ = room.render(area, &mut buffer);
        let rendered = buffer
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(rendered.contains(identity.glyph()), "missing {agent} glyph");
        assert!(
            buffer.content.iter().any(|cell| cell.fg == hue),
            "missing {agent} hue"
        );
        let longest_rail = (0..area.width)
            .map(|x| {
                (0..area.height)
                    .filter_map(|y| buffer.cell((x, y)))
                    .filter(|cell| cell.fg == hue && cell.symbol() == crate::glyphs::accent_bar())
                    .count()
            })
            .max()
            .unwrap_or_default();
        assert!(
            longest_rail >= 2,
            "{agent} body must carry a continuous native accent rail, longest run: {longest_rail}"
        );
    }
}

#[test]
fn visual_contract_groups_each_speaker_without_internal_blank_rows() {
    use ratatui::{buffer::Buffer, layout::Rect};

    let mut reducer = RoomReducer::new();
    let mut room = RoomScrollback::new();
    for next in [
        event(
            1,
            "turn.accepted",
            json!({"agents":["claude"],"text":"tight operator prompt","messageId":"operator-message","ledgerSeq":"1"}),
        ),
        event(2, "route.resolved", json!({"agents":["claude"]})),
        event(
            3,
            "lane.queued",
            json!({"laneId":"claude-lane","agent":"claude","expectedMessageId":"claude-message","origin":"operator","hopIndex":0}),
        ),
        event(
            4,
            "lane.started",
            json!({"laneId":"claude-lane","streamId":"claude-stream","agent":"claude"}),
        ),
        event(
            5,
            "lane.chunk",
            json!({"laneId":"claude-lane","streamId":"claude-stream","agent":"claude","streamSeq":"1","chunkIndex":0,"channel":"assistant","text":"tight claude answer"}),
        ),
        event(
            6,
            "message.committed",
            json!({"laneId":"claude-lane","agent":"claude","messageId":"claude-message","ledgerSeq":"2","text":"tight claude answer","origin":"operator","hopIndex":0}),
        ),
        event(
            7,
            "lane.completed",
            json!({"laneId":"claude-lane","streamId":"claude-stream","agent":"claude"}),
        ),
    ] {
        apply_live(&mut room, &mut reducer, next);
    }

    let area = Rect::new(0, 0, 100, 24);
    let mut buffer = Buffer::empty(area);
    // Painted cells only; the hit-test model is not this test's subject.
    let _ = room.render(area, &mut buffer);
    let rows = (0..area.height)
        .map(|y| {
            (0..area.width)
                .filter_map(|x| buffer.cell((x, y)))
                .map(|cell| cell.symbol())
                .collect::<String>()
        })
        .collect::<Vec<_>>();
    let row_of = |needle: &str| {
        rows.iter()
            .position(|row| row.contains(needle))
            .unwrap_or_else(|| panic!("missing {needle:?} in {rows:#?}"))
    };

    let you = row_of("you");
    let operator_body = row_of("tight operator prompt");
    let claude = row_of("claude");
    let claude_body = row_of("tight claude answer");
    assert_eq!(
        operator_body,
        you + 1,
        "speaker header and body are one block"
    );
    assert_eq!(
        claude,
        operator_body + 2,
        "speakers retain one separating row"
    );
    assert_eq!(
        claude_body,
        claude + 1,
        "agent header and body are one block"
    );
    assert!(
        rows[you].contains('·'),
        "operator time belongs in its header"
    );
    assert!(
        rows[claude].contains('·'),
        "finished-agent time belongs in its header"
    );
}

/// The live verb is the lane's colour, the elapsed count is dim metadata, and
/// the row sits at the bottom of the transcript. This pins the WAITING state
/// only: FL-071 retired the row the moment answer text lands, so a version of
/// this test that streamed a chunk first would be pinning the defect.
#[test]
fn visual_contract_styles_live_verb_by_agent_and_elapsed_as_metadata() {
    let _theme = pin_theme();
    use ratatui::{buffer::Buffer, layout::Rect};

    let mut reducer = RoomReducer::new();
    let mut room = RoomScrollback::new();
    for next in [
        event(
            1,
            "turn.accepted",
            json!({"agents":["claude"],"text":"draft the release note","messageId":"operator-message","ledgerSeq":"1"}),
        ),
        event(2, "route.resolved", json!({"agents":["claude"]})),
        event(
            3,
            "lane.queued",
            json!({"laneId":"claude-lane","agent":"claude","expectedMessageId":"claude-message","origin":"operator","hopIndex":0}),
        ),
        event(
            4,
            "lane.started",
            json!({"laneId":"claude-lane","streamId":"claude-stream","agent":"claude"}),
        ),
    ] {
        apply_live(&mut room, &mut reducer, next);
    }
    room.refresh_live_status(&reducer, 0);

    let area = Rect::new(0, 0, 100, 24);
    let mut buffer = Buffer::empty(area);
    // This test reads the painted cells, not the hit-test model.
    let _ = room.render(area, &mut buffer);
    let working_y = (0..area.height)
        .find(|&y| {
            (0..area.width)
                .filter_map(|x| buffer.cell((x, y)))
                .map(|cell| cell.symbol())
                .collect::<String>()
                .contains("working")
        })
        .expect("live status row");
    let working_cell = (0..area.width)
        .filter_map(|x| buffer.cell((x, working_y)))
        .find(|cell| cell.symbol() == "w")
        .expect("working verb cell");
    let elapsed_cell = (0..area.width)
        .filter_map(|x| buffer.cell((x, working_y)))
        .find(|cell| cell.symbol() == "(")
        .expect("elapsed metadata cell");
    let body_y = (0..area.height)
        .find(|&y| {
            (0..area.width)
                .filter_map(|x| buffer.cell((x, y)))
                .map(|cell| cell.symbol())
                .collect::<String>()
                .contains("draft the release note")
        })
        .expect("operator prompt row");
    assert_eq!(working_cell.fg, RoomIdentity::Claude.color());
    assert_eq!(elapsed_cell.fg, crate::room_theme::RoomTheme::current().dim);
    assert!(
        working_y > body_y,
        "the active status stays at the bottom of the transcript so it remains visible"
    );
}

/// FL-071 (operator, live run 2026-08-19). The operator's contract: the
/// working animation shows while waiting and must DISAPPEAR the moment the
/// answer arrives — answer and working animation must never render
/// together. Replays the shape of that run's codex lane
/// (`.council/runs/chat-1787120261445-e2e950be…/room-events.jsonl`), where
/// the concatenated `lane.chunk` text was byte-identical to the committed
/// text 3.263 s before `message.committed` and 3.265 s before
/// `lane.completed`, so the finished answer and a counting `working… (Ns)`
/// row shared the screen for that whole window.
#[test]
fn a_delivered_answer_never_renders_beside_its_working_row() {
    let ellipsis = room_secondary(RoomSecondaryGlyph::Ellipsis);
    let mut reducer = RoomReducer::new();
    let mut room = RoomScrollback::new();
    for next in [
        event(
            1,
            "turn.accepted",
            json!({"agents":["codex"],"text":"can you write files?","messageId":"operator-message","ledgerSeq":"1"}),
        ),
        event(2, "route.resolved", json!({"agents":["codex"]})),
        event(
            3,
            "lane.queued",
            json!({"laneId":"lane","agent":"codex","expectedMessageId":"message","origin":"operator","hopIndex":0}),
        ),
        event(
            4,
            "lane.started",
            json!({"laneId":"lane","streamId":"stream","agent":"codex"}),
        ),
    ] {
        apply_live(&mut room, &mut reducer, next);
    }

    // Waiting, nothing delivered: the animation is the only liveness the
    // operator has. In the captured run this window was 17.0 s.
    room.refresh_live_status(&reducer, 1);
    let waiting = room.searchable_text();
    assert!(
        waiting.contains(&format!("working{ellipsis}")),
        "a lane that has delivered nothing keeps its working row
{waiting}"
    );

    apply_live(
        &mut room,
        &mut reducer,
        event(
            5,
            "lane.chunk",
            json!({"laneId":"lane","streamId":"stream","agent":"codex","streamSeq":"1","chunkIndex":0,"channel":"stdout","text":"Yes. I can create, edit, rename, and delete files."}),
        ),
    );
    // The host's `message.committed` is still 3.263 s away; the answer is
    // already whole on the operator's screen, so the row goes NOW - not on
    // the next animation tick.
    let delivered = room.searchable_text();
    assert!(
        delivered.contains("Yes. I can create, edit, rename, and delete files."),
        "the streamed answer is on screen
{delivered}"
    );
    assert!(
        !delivered.contains(&format!("working{ellipsis}")),
        "FL-071: a delivered answer must never render beside its working row
{delivered}"
    );

    for next in [
        event(
            6,
            "message.committed",
            json!({"laneId":"lane","agent":"codex","messageId":"message","ledgerSeq":"2","text":"Yes. I can create, edit, rename, and delete files.","origin":"operator","hopIndex":0}),
        ),
        event(
            7,
            "lane.completed",
            json!({"laneId":"lane","streamId":"stream","agent":"codex"}),
        ),
    ] {
        apply_live(&mut room, &mut reducer, next);
        let settled = room.searchable_text();
        assert!(
            !settled.contains(&format!("working{ellipsis}")),
            "FL-071: the working row stays gone once the answer is committed
{settled}"
        );
    }
}

/// The one exception FL-071 leaves standing. `cancelling` is not a working
/// animation - it is the room telling the operator their own cancel landed -
/// so it must reach the screen even for a lane whose answer is already there,
/// and it must still disappear when the lane actually settles.
#[test]
fn a_cancel_is_acknowledged_even_under_a_delivered_answer() {
    let ellipsis = room_secondary(RoomSecondaryGlyph::Ellipsis);
    let mut reducer = RoomReducer::new();
    let mut room = RoomScrollback::new();
    for next in [
        event(
            1,
            "turn.accepted",
            json!({"agents":["codex"],"text":"can you write files?","messageId":"operator-message","ledgerSeq":"1"}),
        ),
        event(2, "route.resolved", json!({"agents":["codex"]})),
        event(
            3,
            "lane.queued",
            json!({"laneId":"lane","agent":"codex","expectedMessageId":"message","origin":"operator","hopIndex":0}),
        ),
        event(
            4,
            "lane.started",
            json!({"laneId":"lane","streamId":"stream","agent":"codex"}),
        ),
        event(
            5,
            "lane.chunk",
            json!({"laneId":"lane","streamId":"stream","agent":"codex","streamSeq":"1","chunkIndex":0,"channel":"stdout","text":"Partial answer so far"}),
        ),
    ] {
        apply_live(&mut room, &mut reducer, next);
    }
    room.refresh_live_status(&reducer, 1);
    let delivered = room.searchable_text();
    assert!(
        !delivered.contains(&format!("working{ellipsis}")),
        "the delivered answer retired the working row first: {delivered}"
    );

    apply_live(
        &mut room,
        &mut reducer,
        event(
            6,
            "lane.cancelling",
            json!({"laneId":"lane","agent":"codex"}),
        ),
    );
    let cancelling = room.searchable_text();
    assert!(
        cancelling.contains(&format!("cancelling{ellipsis}")),
        "a cancel is acknowledged even under a delivered answer: {cancelling}"
    );
    assert!(
        cancelling.contains("Partial answer so far"),
        "the answer is still on screen: {cancelling}"
    );

    // A tick must not lose the acknowledgement, and settling must retire it.
    room.refresh_live_status(&reducer, 2);
    assert!(
        room.searchable_text()
            .contains(&format!("cancelling{ellipsis}")),
        "the acknowledgement survives an animation tick"
    );
    apply_live(
        &mut room,
        &mut reducer,
        event(
            7,
            "lane.cancelled",
            json!({"laneId":"lane","streamId":"stream","agent":"codex"}),
        ),
    );
    let settled = room.searchable_text();
    assert!(
        !settled.contains(&format!("cancelling{ellipsis}")),
        "the acknowledgement retires with the lane: {settled}"
    );
    assert!(
        settled.contains("codex — cancelled"),
        "the terminal outcome row carries the truth: {settled}"
    );
}

/// SS-C.12 site 1, all three readings — and it is the anti-vacuity test, so
/// it is the one written first.
///
/// (a) The NAIVE assertion passes against a `StubBlock`: `is_foldable` is
/// the trait default `true`, so `toggle_fold_selected` really does flip
/// `display_mode` — while the screen does not change at all, because
/// `StubBlock::output` takes `_ctx` and ignores it entirely
/// (`scrollback/block.rs:408`). That is what a fold test looks like when it
/// cannot see its subject.
///
/// (b) The REAL assertion is line counts. Against the same stub the two
/// renders are byte-identical, so a "counts differ" assertion fails with a
/// difference of ZERO — asserted here as equality, with the verbatim RED of
/// the `assert_ne!` form quoted in the handback.
///
/// (c) Against `RoomStepsBlock` the counts really do differ and no step
/// label survives the fold. The fixture is FINALIZED, deliberately: a live
/// collapsed block shows its last two labels on purpose, so a live fixture
/// would fail (c) correctly and look like a defect.
#[test]
fn a_folded_steps_row_actually_hides_its_steps() {
    let appearance = AppearanceConfig::default();
    let stub = RenderBlock::stub_compact_non_groupable(
        "read auth.rs".to_owned(),
        RoomTheme::current().dim,
    );

    // (a) the trap
    let mut state = ScrollbackState::new();
    let stub_id = state.push_block(stub.clone());
    state.set_selected(state.index_of_id(stub_id));
    let before = state
        .get_by_id(stub_id)
        .expect("the stub is in the state")
        .display_mode();
    state.toggle_fold_selected();
    let after = state
        .get_by_id(stub_id)
        .expect("the stub is in the state")
        .display_mode();
    assert_ne!(
        before, after,
        "the naive fold assertion PASSES against a stub - this is the trap"
    );

    // (b) the same stub, rendered, does not move a single line
    let ctx_at = |mode| BlockContext {
        mode,
        is_running: false,
        width: 80,
        raw: false,
        max_lines: None,
        appearance: appearance.clone(),
        is_selected: false,
        cwd: None,
    };
    assert_eq!(
        stub.output(&ctx_at(DisplayMode::Collapsed)).lines.len(),
        stub.output(&ctx_at(DisplayMode::Expanded)).lines.len(),
        "a stub renders identically in both modes, so the difference is ZERO"
    );

    // (c) the real block, finalized
    let steps = RenderBlock::RoomSteps(crate::room_steps_block::RoomStepsBlock::finalized(
        &[
            lane_activity("tool-0", "read auth.rs", "completed"),
            lane_activity("tool-1", "search tokens", "completed"),
            lane_activity("tool-2", "edit auth.rs", "completed"),
        ],
        RoomSpeaker::Claude.color(),
        Some("2026-08-02T00:00:00Z"),
        Some("2026-08-02T00:00:12Z"),
    ));
    let collapsed = steps.output(&ctx_at(DisplayMode::Collapsed));
    let expanded = steps.output(&ctx_at(DisplayMode::Expanded));
    assert_eq!(collapsed.lines.len(), 1);
    assert_eq!(expanded.lines.len(), 4);
    let collapsed_text = block_text(&collapsed);
    for label in ["read auth.rs", "search tokens", "edit auth.rs"] {
        assert!(
            !collapsed_text.contains(label),
            "a folded row hides {label}: {collapsed_text:?}"
        );
    }
    assert_eq!(collapsed_text, format!("{} 3 steps · 12s", check()));
}

fn lane_activity(tool_call_id: &str, title: &str, status: &str) -> LaneActivity {
    LaneActivity {
        last_event_seq: "1".to_owned(),
        tool_call_id: tool_call_id.to_owned(),
        update: zer0_room_protocol::LaneActivityUpdate::ToolCall,
        title: Some(title.to_owned()),
        kind: None,
        status: Some(status.to_owned()),
    }
}

fn block_text(output: &crate::scrollback::BlockOutput) -> String {
    output
        .lines
        .iter()
        .map(|line| {
            line.content
                .spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// SS-C.12 site 4.
///
/// RED against a block that inherits `has_vpad_for`'s `true` default, which
/// the renderer turns into one blank row above and one below — three screen
/// rows where the contract says one. Measured through the real layout pass,
/// not by counting `BlockLine`s, because the padding is added by the entry
/// renderer and a `BlockLine` count cannot see it.
#[test]
fn a_collapsed_steps_entry_occupies_exactly_one_screen_row() {
    let (mut room, _reducer) = live_room(&[StepsTurn::claude(&["completed"; 5])]);
    let steps_id = room
        .steps_entry_id_for_stream("stream")
        .expect("a lane that ran five tools has a steps entry");
    room.state.prepare_layout(100, 40);
    let index = room
        .state
        .index_of_id(steps_id)
        .expect("the steps entry is in the state");
    assert_eq!(
        room.state.get_cached_entry_height(index),
        Some(1),
        "the folded row is one screen row, vertical padding included"
    );
}

/// SS-C.12 site 6, the finding-11 trap.
///
/// `ensure_cached` normalizes `is_selected` to `false` for every block
/// outside a named list, so a block can read `ctx.is_selected` perfectly and
/// be handed `false` forever — no compile error, no visible failure, and
/// nothing else in the suite catches it. Run RED against the tree WITHOUT
/// the `entry.rs` edit; the verbatim failure is in the handback.
///
/// Deliberately goes through `ensure_cached` rather than calling `output`
/// with `is_selected: true` directly, which would bypass the very
/// normalization the edit fixes.
#[test]
fn the_expand_hint_renders_only_on_the_selected_row() {
    let (room, _reducer) = live_room(&[
        StepsTurn::claude(&["completed"; 3]),
        StepsTurn {
            agent: "codex",
            lane: "lane-2",
            stream: "stream-2",
            turn: "turn-2",
            statuses: vec!["completed"; 3],
            answer: Some("the second answer"),
            ending: "lane.completed",
        },
    ]);
    let first = room
        .steps_entry_id_for_stream("stream")
        .expect("claude has a steps entry");
    let second = room
        .steps_entry_id_for_stream("stream-2")
        .expect("codex has a steps entry");

    let hint = "(ctrl+e to expand)";
    let selected = room.entry_text_when_selected(first, 80, true);
    let unselected = room.entry_text_when_selected(second, 80, false);
    assert!(
        selected.contains(hint),
        "the selected row advertises the chord: {selected:?}"
    );
    assert!(
        !unselected.contains(hint),
        "an unselected row does not: {unselected:?}"
    );
    // And the same entry, unselected, loses it — so the assertion is about
    // selection rather than about which of the two entries it happens to be.
    assert!(
        !room
            .entry_text_when_selected(first, 80, false)
            .contains(hint)
    );
}

/// SS-C.12 site 10: unchanged behaviour, pinned.
///
/// Mutation this catches: counting non-terminal activities, which inflates
/// the count to 4 and paints a row for a tool that never finished.
#[test]
fn a_step_still_running_at_commit_is_not_counted_and_not_rendered() {
    let (room, _reducer) = live_room(&[StepsTurn::claude(&[
        "completed",
        "completed",
        "in_progress",
        "pending",
    ])]);
    let text = room.steps_text("stream", 80, DisplayMode::Expanded);
    assert_eq!(
        text,
        format!(
            "{check} step 0\n{check} step 1\n{check} 2 steps · 12s",
            check = check()
        ),
        "two terminal steps, and the two unfinished ones are neither counted \
             nor painted"
    );
}

/// SS-C.12 site 13: SS-C.6's latch.
///
/// A lane that commits AND completes reaches both fold sites. Without the
/// latch the second one recomputes the duration from a different end
/// timestamp and the row silently changes under the operator.
#[test]
fn folding_twice_is_the_same_as_folding_once_and_keeps_one_duration() {
    let mut reducer = RoomReducer::new();
    let mut room = RoomScrollback::new();
    let turn = StepsTurn::claude(&["completed"; 5]);
    let events = turn.events(1);
    let (before_end, end) = events.split_at(events.len() - 1);
    for next in before_end {
        apply_live(&mut room, &mut reducer, next.clone());
    }
    let after_commit = room.steps_text("stream", 80, DisplayMode::Collapsed);
    assert_eq!(after_commit, format!("{} 5 steps · 12s", check()));

    for next in end {
        apply_live(&mut room, &mut reducer, next.clone());
    }
    assert_eq!(
        room.steps_text("stream", 80, DisplayMode::Collapsed),
        after_commit,
        "the terminal event after a commit changes nothing"
    );
    assert_eq!(room.steps_entry_count(), 1, "one summary row, not two");
}

/// SS-C.12 site 14, both halves.
///
/// First half: a `tool_call` followed by a `tool_call_update` for the same
/// `tool_call_id` is ONE step, not two.
///
/// Second half, and the one a natural implementation gets wrong: a single
/// update for a fresh id that is ALREADY terminal — no in-progress sighting
/// at all — must count and render. Measured on the agy stream, a tool that
/// finishes inside one millisecond emits both states in the same instant, so
/// requiring a lifecycle is wrong against real data. RED against the
/// sequence-expecting implementation; the failure is quoted in the handback.
#[test]
fn a_repeated_tool_call_update_does_not_double_the_count() {
    let mut reducer = RoomReducer::new();
    let mut room = RoomScrollback::new();
    let mut seq = 1;
    let mut next_seq = || {
        seq += 1;
        seq - 1
    };
    for next in [
        event_at(
            next_seq(),
            "turn.accepted",
            json!({"agents":["claude"],"text":"go","messageId":"prompt","ledgerSeq":"1"}),
            "2026-08-02T00:00:00Z",
            "turn-1",
        ),
        event_at(
            next_seq(),
            "route.resolved",
            json!({"agents":["claude"]}),
            "2026-08-02T00:00:00Z",
            "turn-1",
        ),
        event_at(
            next_seq(),
            "lane.queued",
            json!({"laneId":"lane","agent":"claude","expectedMessageId":"message","origin":"operator","hopIndex":0}),
            "2026-08-02T00:00:00Z",
            "turn-1",
        ),
        event_at(
            next_seq(),
            "lane.started",
            json!({"laneId":"lane","streamId":"stream","agent":"claude"}),
            "2026-08-02T00:00:00Z",
            "turn-1",
        ),
        // A tool with an observable middle.
        event_at(
            next_seq(),
            "lane.activity",
            json!({"laneId":"lane","streamId":"stream","agent":"claude","toolCallId":"slow","update":"tool_call","title":"slow tool","status":"in_progress"}),
            "2026-08-02T00:00:01Z",
            "turn-1",
        ),
        event_at(
            next_seq(),
            "lane.activity",
            json!({"laneId":"lane","streamId":"stream","agent":"claude","toolCallId":"slow","update":"tool_call_update","status":"completed"}),
            "2026-08-02T00:00:02Z",
            "turn-1",
        ),
        // A tool with none: first and only sighting, already terminal.
        event_at(
            next_seq(),
            "lane.activity",
            json!({"laneId":"lane","streamId":"stream","agent":"claude","toolCallId":"instant","update":"tool_call","title":"instant tool","status":"completed"}),
            "2026-08-02T00:00:03Z",
            "turn-1",
        ),
    ] {
        apply_live(&mut room, &mut reducer, next);
    }

    assert_eq!(
        room.steps_text("stream", 80, DisplayMode::Expanded),
        format!("{check} slow tool\n{check} instant tool", check = check()),
        "one record per tool call, and a first-and-only terminal update counts"
    );
}

/// SS-C.12 site 15: the `finish_lane` fold path, live.
#[test]
fn a_lane_that_fails_without_committing_still_folds() {
    let (room, _reducer) = live_room(&[StepsTurn::claude(&["completed", "failed", "completed"])
        .without_answer()
        .ending("lane.failed")]);
    assert_eq!(
        room.steps_text("stream", 80, DisplayMode::Collapsed),
        "3 steps · 1 failed · 12s",
        "a lane that never answered still says what it did"
    );
    assert!(
        room.searchable_text().contains("claude — failed"),
        "and the outcome row is still there"
    );
}

/// SS-C.12 site 16: SS-C.7's gap.
///
/// A failed-no-commit lane has no transcript entry and is not materialized
/// as a running stream, so on rebuild the `TerminalLane` arm is the only
/// place its steps can reach the screen at all. RED today AND RED against a
/// naive implementation that only folds the transcript path, which is why it
/// is separate from the parity test below.
#[test]
fn a_failed_lane_rebuilds_its_steps_from_a_snapshot() {
    let (_live, reducer) = live_room(&[StepsTurn::claude(&["completed", "failed", "completed"])
        .without_answer()
        .ending("lane.failed")]);
    let rebuilt = RoomScrollback::from_reducer(&reducer);
    let text = rebuilt.searchable_text();
    assert!(
        text.contains("3 steps · 1 failed · 12s"),
        "the rebuilt room carries the folded summary: {text}"
    );
    assert!(
        text.contains("claude"),
        "and a speaker header, so the steps are attributed: {text}"
    );
    assert!(
        text.find("claude").unwrap() < text.find("3 steps").unwrap(),
        "header first, then the summary: {text}"
    );
}

/// An animation tick that brings no new step must not touch the entry.
///
/// `refresh_live_status` calls `sync_lane_activity` - and therefore
/// `sync_lane_steps` - on every tick while a lane runs, and
/// `replace_room_steps` invalidates the entry's render cache and dirties its
/// height every time it is called. Rebuilding an identical block per tick
/// would throw away that cache sixty times a second to paint the same row.
///
/// The old frozen-row path got this free from its `activity_entries` dedup
/// map, which slice C deleted. This is what replaces that property.
///
/// The observable is the STEPS ENTRY'S own cache, not the state's
/// `content_generation`: that counter moves once per tick anyway, because
/// the live status row is a spinner and `replace_room_status` rewrites it
/// unconditionally. Measured, not assumed - five ticks move it by exactly
/// five, and asserting on it would have passed while the steps block was
/// being rewritten too.
///
/// The second half is what stops the first from being satisfied by a block
/// that never updates at all: a REAL new step must still invalidate.
#[test]
fn an_animation_tick_with_no_new_step_does_not_rewrite_the_block() {
    let mut reducer = RoomReducer::new();
    let mut room = RoomScrollback::new();
    let turn = StepsTurn::claude(&["completed", "completed", "completed"]);
    let events = turn.events(1);
    for next in events.iter().take(4 + 2) {
        apply_live(&mut room, &mut reducer, next.clone());
    }
    let steps_id = room
        .steps_entry_id_for_stream("stream")
        .expect("two terminal steps created the entry");
    let cached = |room: &RoomScrollback| -> bool {
        let entry = room
            .state
            .get_by_id(steps_id)
            .expect("the entry is present");
        entry.has_cached_output()
    };

    room.state.prepare_layout(100, 40);
    assert!(cached(&room), "the painted entry starts cached");

    let generation_before = room.state.content_generation();
    for tick in 1..=5 {
        room.refresh_live_status(&reducer, tick);
    }
    assert!(
        cached(&room),
        "five ticks with no new step must leave the steps block untouched"
    );
    assert_eq!(
        room.state.content_generation() - generation_before,
        5,
        "exactly one bump per tick, and it is the live status row's - which is \
             why that counter is the wrong instrument for this assertion"
    );

    apply_live(&mut room, &mut reducer, events[6].clone());
    assert!(
        !cached(&room),
        "but a real third step does rewrite it - otherwise the assertion above \
             would be satisfied by a block that never updates at all"
    );
    assert_eq!(
        room.steps_text("stream", 80, DisplayMode::Collapsed)
            .lines()
            .count(),
        3,
        "and the third step is on screen: one remainder line plus the last two"
    );
}

/// The invariant that keeps the two rebuild arms from BOTH emitting the same
/// lane's steps, now that the dedup map is gone.
///
/// Slice C deleted `activity_entries`, the `{lane_id}:{tool_call_id}` map
/// that used to make `push_frozen_activity` idempotent across every call
/// site. Nothing replaces it, and nothing needs to - but only because a lane
/// cannot be in the transcript AND in the `TerminalLane` set at the same
/// time. `from_reducer` would emit its steps twice if it could: once through
/// `push_transcript_entry` and once through `finish_lane`'s no-binding arm.
///
/// So the reducer's phase guards are load-bearing for slice C, and they are
/// pinned here rather than trusted: `lane.failed` requires
/// Running/Cancelling (`zer0-room-protocol/src/reducer.rs:945-950`) and
/// `lane.cancelled` requires Queued/Running/Cancelling (`:960-966`), while
/// `message.committed` sets `Committed` (`:834`). Relax either guard and the
/// duplicate becomes reachable — this test is what says so.
#[test]
fn a_committed_lane_can_never_also_become_a_terminal_lane_row() {
    for ending in ["lane.failed", "lane.cancelled"] {
        let mut reducer = RoomReducer::new();
        let mut room = RoomScrollback::new();
        let turn = StepsTurn::claude(&["completed", "completed"]);
        let events = turn.events(1);
        // Everything except the trailing terminal event.
        for next in events.iter().take(events.len() - 1) {
            apply_live(&mut room, &mut reducer, next.clone());
        }

        let seq = events.len() as u64;
        let rejected = reducer.apply(&event_at(
            seq,
            ending,
            json!({"laneId":"lane","streamId":"stream","agent":"claude"}),
            "2026-08-02T00:00:13Z",
            "turn-1",
        ));
        assert!(
            rejected.is_err(),
            "{ending} after a commit must be a protocol error, or the rebuilt \
                 room would print this lane's steps twice"
        );

        // Positive control: the same event IS accepted on a lane that never
        // committed, so the assertion above is about the commit and not
        // about the event being malformed.
        let mut fresh_reducer = RoomReducer::new();
        let mut fresh_room = RoomScrollback::new();
        let uncommitted = StepsTurn::claude(&["completed", "completed"]).without_answer();
        let uncommitted_events = uncommitted.events(1);
        for next in uncommitted_events.iter().take(uncommitted_events.len() - 1) {
            apply_live(&mut fresh_room, &mut fresh_reducer, next.clone());
        }
        assert!(
            fresh_reducer
                .apply(&event_at(
                    uncommitted_events.len() as u64,
                    ending,
                    json!({"laneId":"lane","streamId":"stream","agent":"claude"}),
                    "2026-08-02T00:00:13Z",
                    "turn-1",
                ))
                .is_ok(),
            "{ending} is accepted on a lane that never committed"
        );
    }
}

/// SS-C.12 site 17: full live-vs-rebuild parity over a mixed sequence.
///
/// What wrong implementation would still pass a looser version? One that
/// folded on the live path only, or that reproduced the summary but lost the
/// order — so this compares row for row rather than asserting that some
/// string is present in both.
#[test]
fn a_rebuilt_room_folds_identically_to_a_live_one() {
    let (live, reducer) = live_room(&[
        StepsTurn {
            agent: "claude",
            lane: "lane-committed",
            stream: "stream-committed",
            turn: "turn-1",
            statuses: vec!["completed", "completed", "failed"],
            answer: Some("claude answered"),
            ending: "lane.completed",
        },
        StepsTurn {
            agent: "codex",
            lane: "lane-failed",
            stream: "stream-failed",
            turn: "turn-2",
            statuses: vec!["completed", "aborted"],
            answer: None,
            ending: "lane.failed",
        },
        StepsTurn {
            agent: "gemini",
            lane: "lane-cancelled",
            stream: "stream-cancelled",
            turn: "turn-3",
            statuses: vec!["completed"],
            answer: None,
            ending: "lane.cancelled",
        },
    ]);
    let rebuilt = RoomScrollback::from_reducer(&reducer);
    let live_rows = live.searchable_text();
    let rebuilt_rows = rebuilt.searchable_text();

    // The live path additionally holds an EMPTY streaming AgentMessageBlock
    // for each lane that never committed (`start_stream` pushes it, and the
    // rebuild has nothing to reproduce it from). Its measured rendered
    // height is reported in the handback. It contributes no searchable text,
    // so it does not appear here — and that is exactly what makes this
    // comparison honest rather than tolerant.
    let live_lines = live_rows.lines().collect::<Vec<_>>();
    let rebuilt_lines = rebuilt_rows.lines().collect::<Vec<_>>();
    assert_eq!(
        live_lines, rebuilt_lines,
        "live and rebuilt rooms fold to the same rows in the same order"
    );
    assert!(
        live_rows.contains("3 steps · 1 failed · 12s"),
        "the committed lane's failure survives the fold: {live_rows}"
    );
    assert!(
        live_rows.contains("2 steps · 12s"),
        "the unknown-terminal lane claims nothing it cannot prove: {live_rows}"
    );
}

/// Every painted cell of the feed - symbol, foreground, background and
/// modifier - in wave 0's dump format.
fn frame_dump(room: &mut RoomScrollback, width: u16, height: u16) -> String {
    use ratatui::buffer::Buffer;
    use ratatui::layout::Rect;

    let area = Rect::new(0, 0, width, height);
    let mut buffer = Buffer::empty(area);
    let _ = room.render(area, &mut buffer);
    let mut out = String::new();
    for y in 0..height {
        let mut text = String::new();
        let mut styles = String::new();
        for x in 0..width {
            let cell = buffer.cell((x, y)).expect("every cell is in the area");
            text.push_str(cell.symbol());
            styles.push_str(&format!("{:?},{:?},{:?}|", cell.fg, cell.bg, cell.modifier));
        }
        out.push_str(&format!("{y:03}T|{text}|\n"));
        out.push_str(&format!("{y:03}S|{styles}\n"));
    }
    out
}

/// SS-C.12 site 19: SS-C.10's narrowed byte-identity promise.
///
/// A run of 1 or 2 completed steps, live and collapsed - what an operator
/// who has not touched the row sees while the lane runs - must paint exactly
/// the cells it painted before slice C: same glyph, same text, same
/// `theme.dim`, same speaker accent, one screen row per step, no vertical
/// padding.
///
/// Uses wave 0's frame-dump METHOD (every cell's symbol, fg, bg and
/// modifier - `D:/m0irai-evidence/wave0/harness.rs.txt`), which is proven to
/// see a cell change, rather than a new instrument. The "before" side is the
/// real pre-C code, restored verbatim from `a993624` as
/// `push_frozen_activity_as_it_was_before_slice_c`, so this compares against
/// what shipped and not against a description of it.
///
/// ONE room, dumped twice - built with the block, then downgraded in place
/// to the old rows - rather than two rooms. Two rooms would each bake their
/// own `elapsed_seconds` into the live status row, which is measured against
/// `Utc::now()`, and two `Utc::now()` calls can straddle a second. That is a
/// flake, not a defect, and it belongs designed out rather than re-run.
///
/// The mutation that proves it bites is changing the check glyph; the diff
/// is quoted in the handback.
#[test]
fn one_or_two_completed_steps_render_byte_identically_to_today() {
    for count in [1usize, 2] {
        for (width, height) in [(60u16, 24u16), (100, 40)] {
            let mut reducer = RoomReducer::new();
            let mut room = RoomScrollback::new();
            let turn = StepsTurn::claude(&vec!["completed"; count]);
            let events = turn.events(1);
            // Everything up to the answer chunk: the lane is still running,
            // which is the state SS-C.10's promise is about.
            for next in events.iter().take(4 + count) {
                apply_live(&mut room, &mut reducer, next.clone());
            }
            let folded_dump = frame_dump(&mut room, width, height);

            room.downgrade_steps_to_pre_slice_c_rows(
                "stream",
                &(0..count).map(|i| format!("step {i}")).collect::<Vec<_>>(),
            );
            let before_dump = frame_dump(&mut room, width, height);

            // Report the first differing ROW rather than two 50 KB strings:
            // a diff nobody can read is a diff nobody acts on.
            let first_difference = before_dump
                .lines()
                .zip(folded_dump.lines())
                .find(|(old, new)| old != new);
            assert_eq!(
                first_difference, None,
                "{count} completed step(s) at {width}x{height}"
            );
            assert_eq!(before_dump.lines().count(), folded_dump.lines().count());
        }
    }
}

/// SS-C.7's last live-vs-rebuild divergence, CLOSED — and closed toward what
/// the operator actually sees.
///
/// Live, `start_stream` pushes an empty streaming `AgentMessageBlock` for
/// every lane, and a lane that fails without committing never fills it. It
/// paints as one blank row directly under the speaker header, measured here
/// rather than assumed (SS-C.7 asked for the measurement and it is NOT zero).
/// Until the 2026-09-02 ruling the rebuild had nothing to reproduce it from,
/// so the live feed was one row taller per failed-no-commit lane, and CQ-07
/// named the fact that this test PINNED that gap instead of closing it.
///
/// **Which side to converge, and why this one.** The two candidates were
/// suppressing the blank row live and reproducing it on rebuild. Live is what
/// the operator has already read, and the whole ruling behind
/// `replay_stream_for_lane` is that a reload owes them what they saw — so the
/// rebuild moves, not the live room. Suppressing it live is also not the
/// small change it sounds like: `start_stream` cannot know whether a chunk is
/// ever coming, so the row would have to be retracted at settle time, and
/// while the lane is still running that same row is where the chunks land.
///
/// So the row is now drawn on BOTH paths, by the same `start_stream` call,
/// and this asserts the heights are equal. It stays RED against a rebuild
/// that drops a failed lane's stream: revert `replay_stream_for_lane` and the
/// rebuilt feed measures one row short again.
#[test]
fn a_failed_lane_leaves_the_same_blank_streaming_row_live_and_rebuilt() {
    let (mut live, reducer) = live_room(&[StepsTurn::claude(&["completed", "failed"])
        .without_answer()
        .ending("lane.failed")]);
    let mut rebuilt = RoomScrollback::from_reducer(&reducer);

    live.state.prepare_layout(100, 40);
    rebuilt.state.prepare_layout(100, 40);
    let blank_streaming_row = |room: &RoomScrollback| -> Option<u16> {
        let id = room.entry_id_for_stream("stream")?;
        let index = room.state.index_of_id(id)?;
        room.state.get_cached_entry_height(index)
    };
    assert_eq!(
        blank_streaming_row(&live),
        Some(1),
        "the empty streaming block is one blank row, not zero"
    );
    assert_eq!(
        blank_streaming_row(&rebuilt),
        Some(1),
        "a reload draws the same one blank row, not nothing"
    );

    let painted = |state: &ScrollbackState| -> u16 {
        (0..state.len())
            .filter_map(|i| state.get_cached_entry_height(i))
            .sum()
    };
    assert_eq!(
        painted(&live.state),
        painted(&rebuilt.state),
        "the two feeds are exactly the same height, blank row included"
    );
    assert_eq!(live.searchable_text(), rebuilt.searchable_text());
}

/// SS-C.12 site 21: all four cells of SS-C.1 item 6's table, across a real
/// lifecycle.
///
/// The defect it guards is a MISSING case, not a wrong value. RED against
/// any implementation that caps an expanded live row at three rows, and RED
/// against one that lets the commit reset `display_mode` — both quoted in
/// the handback.
#[test]
fn live_and_expanded_shows_every_step_and_keeps_showing_them() {
    let mut reducer = RoomReducer::new();
    let mut room = RoomScrollback::new();
    // Six tool calls in the turn, but only five are delivered before the
    // operator expands the row - the sixth is the one that has to render
    // WITHOUT collapsing what they opened.
    let turn = StepsTurn::claude(&["completed"; 6]);
    let events = turn.events(1);
    let live_prefix = 4 + 5;
    for next in events.iter().take(live_prefix) {
        apply_live(&mut room, &mut reducer, next.clone());
    }

    // live && Collapsed
    assert_eq!(
        room.steps_text("stream", 80, DisplayMode::Collapsed),
        format!(
            "+3 earlier steps\n{check} step 3\n{check} step 4",
            check = check()
        )
    );

    // live && Expanded — the operator asked, so no cap and no remainder line
    room.select_steps_entry("stream");
    room.toggle_fold_selected();
    let expanded = room.steps_text("stream", 80, DisplayMode::Expanded);
    assert_eq!(expanded.lines().count(), 5);
    assert!(!expanded.contains('+'));

    // A sixth step arrives while expanded: it renders, still expanded.
    apply_live(&mut room, &mut reducer, events[live_prefix].clone());
    assert_eq!(
        room.steps_display_mode("stream"),
        Some(DisplayMode::Expanded),
        "a step arriving must not collapse the row the operator opened"
    );
    assert_eq!(
        room.steps_text("stream", 80, DisplayMode::Expanded)
            .lines()
            .count(),
        6
    );

    // !live && Expanded — the commit must not reset the mode
    for next in events.iter().skip(live_prefix + 1) {
        apply_live(&mut room, &mut reducer, next.clone());
    }
    assert_eq!(
        room.steps_display_mode("stream"),
        Some(DisplayMode::Expanded),
        "the lane ending must not reset the operator's manual expand"
    );
    let done = room.steps_text("stream", 80, DisplayMode::Expanded);
    assert_eq!(
        done.lines().count(),
        7,
        "six steps then the summary: {done}"
    );
    assert_eq!(
        done.lines().last(),
        Some(format!("{} 6 steps · 12s", check()).as_str())
    );

    // !live && Collapsed
    room.toggle_fold_selected();
    assert_eq!(
        room.steps_text("stream", 80, DisplayMode::Collapsed),
        format!("{} 6 steps · 12s", check())
    );
}

/// The THREE-AGENTS law, as a guard rather than a promise.
///
/// Three lanes interleave their tool calls into one shared feed. Each lane's
/// steps must land in its own block and no lane may wait on another — the
/// block is per-stream by construction, and this is what proves the
/// construction holds when the events actually interleave.
#[test]
fn interleaved_three_lane_steps_never_cross_streams() {
    let mut reducer = RoomReducer::new();
    let mut room = RoomScrollback::new();
    let lanes = [
        ("claude", "lane-c", "stream-c"),
        ("codex", "lane-x", "stream-x"),
        ("gemini", "lane-g", "stream-g"),
    ];
    let mut seq = 1;
    let mut next_seq = || {
        seq += 1;
        seq - 1
    };
    let agents = lanes.iter().map(|(agent, _, _)| *agent).collect::<Vec<_>>();
    for next in [
        event_at(
            next_seq(),
            "turn.accepted",
            json!({"agents": agents, "text":"go","messageId":"prompt","ledgerSeq":"1"}),
            "2026-08-02T00:00:00Z",
            "turn-1",
        ),
        event_at(
            next_seq(),
            "route.resolved",
            json!({"agents": agents}),
            "2026-08-02T00:00:00Z",
            "turn-1",
        ),
    ] {
        apply_live(&mut room, &mut reducer, next);
    }
    for (agent, lane, stream) in lanes {
        for next in [
            event_at(
                next_seq(),
                "lane.queued",
                json!({"laneId":lane,"agent":agent,"expectedMessageId":format!("{lane}-message"),"origin":"operator","hopIndex":0}),
                "2026-08-02T00:00:00Z",
                "turn-1",
            ),
            event_at(
                next_seq(),
                "lane.started",
                json!({"laneId":lane,"streamId":stream,"agent":agent}),
                "2026-08-02T00:00:00Z",
                "turn-1",
            ),
        ] {
            apply_live(&mut room, &mut reducer, next);
        }
    }
    // Round-robin the tool calls, so no lane's steps are contiguous.
    for round in 0..3 {
        for (agent, lane, stream) in lanes {
            apply_live(
                &mut room,
                &mut reducer,
                event_at(
                    next_seq(),
                    "lane.activity",
                    json!({"laneId":lane,"streamId":stream,"agent":agent,"toolCallId":format!("{lane}-{round}"),"update":"tool_call","title":format!("{agent} step {round}"),"status":"completed"}),
                    "2026-08-02T00:00:05Z",
                    "turn-1",
                ),
            );
        }
    }

    for (agent, _lane, stream) in lanes {
        let text = room.steps_text(stream, 80, DisplayMode::Expanded);
        assert_eq!(
            text,
            format!(
                "{check} {agent} step 0\n{check} {agent} step 1\n{check} {agent} step 2",
                check = check()
            ),
            "{agent}'s block holds {agent}'s steps and nobody else's"
        );
        for (other, _, _) in lanes {
            if other != agent {
                assert!(
                    !text.contains(other),
                    "{agent}'s block must not carry {other}'s steps: {text}"
                );
            }
        }
    }
    assert_eq!(room.steps_entry_count(), 3, "one block per stream");
}

/// The block is REPLACED, never removed and re-inserted.
///
/// The entry id is what slice D will move and slice E will save, and the
/// display mode is the operator's manual expand. A replacement that lost
/// either would look identical on screen the moment it happened and break
/// something a week later.
#[test]
fn room_steps_replacement_preserves_id_and_display_mode() {
    let mut reducer = RoomReducer::new();
    let mut room = RoomScrollback::new();
    let turn = StepsTurn::claude(&["completed"; 3]);
    let events = turn.events(1);
    for next in events.iter().take(5) {
        apply_live(&mut room, &mut reducer, next.clone());
    }
    let first_id = room
        .steps_entry_id_for_stream("stream")
        .expect("the first terminal step creates the entry");
    room.select_steps_entry("stream");
    room.toggle_fold_selected();
    assert_eq!(
        room.steps_display_mode("stream"),
        Some(DisplayMode::Expanded)
    );

    for next in events.iter().skip(5) {
        apply_live(&mut room, &mut reducer, next.clone());
    }
    assert_eq!(
        room.steps_entry_id_for_stream("stream"),
        Some(first_id),
        "every later step replaces the block behind the same id"
    );
    assert_eq!(
        room.steps_display_mode("stream"),
        Some(DisplayMode::Expanded),
        "and the operator's expand survives the whole lifecycle"
    );
    assert_eq!(room.steps_entry_count(), 1);
}

/// FL-141 round 3. A scripted turn: all three agents are queued in roster
/// order (claude, codex, gemini), then `script` says what each one does and
/// WHEN, so a test can build any mix of answered, failed, cancelled and
/// cancelled-while-queued in any arrival order.
///
/// Adapted from the re-reviewer's own probe helper, extended with the
/// commit/complete/fail actions the mixed-outcome cases need.
fn scripted_history(script: &[(&str, &str)]) -> Vec<RoomEvent> {
    const ROSTER: [(&str, &str, &str); 3] = [
        ("claude", "claude-lane", "claude-stream"),
        ("codex", "codex-lane", "codex-stream"),
        ("gemini", "gemini-lane", "gemini-stream"),
    ];
    let mut events = vec![
        event(
            1,
            "turn.accepted",
            json!({"agents":["claude","codex","gemini"],"text":"do the work","messageId":"operator-message","ledgerSeq":"1"}),
        ),
        event(
            2,
            "route.resolved",
            json!({"agents":["claude","codex","gemini"]}),
        ),
    ];
    let mut seq = 3;
    for (agent, lane, _) in ROSTER {
        events.push(event(
                seq,
                "lane.queued",
                json!({"laneId":lane,"agent":agent,"expectedMessageId":format!("{agent}-message"),"origin":"operator","hopIndex":0}),
            ));
        seq += 1;
    }
    let mut started: Vec<&str> = Vec::new();
    for (agent, action) in script {
        let (_, lane, stream) = ROSTER
            .iter()
            .copied()
            .find(|(name, _, _)| name == agent)
            .expect("script names a roster agent");
        match *action {
            "start" => {
                events.push(event(
                    seq,
                    "lane.started",
                    json!({"laneId":lane,"streamId":stream,"agent":agent}),
                ));
                seq += 1;
                events.push(event(
                        seq,
                        "lane.chunk",
                        json!({"laneId":lane,"streamId":stream,"agent":agent,"streamSeq":"1","chunkIndex":0,"channel":"assistant","text":format!("{agent} was working on it")}),
                    ));
                seq += 1;
                started.push(agent);
            }
            "commit" => {
                events.push(event(
                        seq,
                        "message.committed",
                        json!({"laneId":lane,"agent":agent,"messageId":format!("{agent}-message"),"ledgerSeq":seq.to_string(),"text":format!("{agent} answered"),"origin":"operator","hopIndex":0}),
                    ));
                seq += 1;
            }
            "complete" => {
                events.push(event(
                    seq,
                    "lane.completed",
                    json!({"laneId":lane,"streamId":stream,"agent":agent}),
                ));
                seq += 1;
            }
            "fail" => {
                let mut payload =
                    json!({"laneId":lane,"agent":agent,"error":"provider rejected the request"});
                if started.contains(agent) {
                    payload["streamId"] = json!(stream);
                }
                events.push(event(seq, "lane.failed", payload));
                seq += 1;
            }
            "cancel" => {
                let mut payload = json!({"laneId":lane,"agent":agent});
                if started.contains(agent) {
                    payload["streamId"] = json!(stream);
                }
                events.push(event(seq, "lane.cancelled", payload));
                seq += 1;
            }
            other => panic!("unknown scripted action {other}"),
        }
    }
    events
}

/// The agents in the order their FIRST row appears, top to bottom - the
/// operator's actual reading order, whatever each lane's outcome was.
/// `cancelled_row_order` can only see cancelled lanes; a turn that mixes an
/// answer with a cancel needs this one.
fn lane_row_order(text: &str) -> Vec<&'static str> {
    let mut seen: Vec<&'static str> = Vec::new();
    for line in text.lines() {
        if line.starts_with("do the work") || line.contains(" you ") {
            continue;
        }
        for agent in ["claude", "codex", "gemini"] {
            if line.contains(agent) && !seen.contains(&agent) {
                seen.push(agent);
            }
        }
    }
    seen
}

/// FL-141 round 3, P1 REGRESSION introduced by `3e0ac56` (re-review of
/// `1cc5d5a`, the reviewer's PROBE9). `from_reducer` keyed a replayed
/// stream on `lane.started` and a committed answer on `message.committed`
/// - two different clocks in one sort - so a lane that started FIRST but
/// committed LAST sorted below a lane that started later and was cancelled.
/// The base `e950144` got this right; the fix for the reload broke it.
///
/// The operator sees their answer move below a cancelled lane when they
/// reopen the session, which is their original complaint wearing a
/// different hat.
#[test]
fn a_reload_keeps_an_answer_above_a_lane_cancelled_after_it() {
    let (live, reducer) = live_room_from(scripted_history(&[
        ("claude", "start"),
        ("codex", "start"),
        ("claude", "commit"),
        ("claude", "complete"),
        ("codex", "cancel"),
    ]));
    let rebuilt = RoomScrollback::from_reducer(&reducer);
    assert_eq!(
        lane_row_order(&rebuilt.searchable_text()),
        vec!["claude", "codex"],
        "after a reload claude (roster 0) must still sit above codex \
             (roster 1): {:?}",
        rebuilt.searchable_text()
    );
    assert_eq!(
        lane_row_order(&live.searchable_text()),
        vec!["claude", "codex"],
        "and the live room already reads that way: {:?}",
        live.searchable_text()
    );
}

/// FL-141 round 3, P1 (re-review of `1cc5d5a`, the reviewer's PROBE1).
/// `push_queued_cancel_marker` ordered a queued cancel only against OTHER
/// queued cancels. A streamed lane's header is pushed at the END by
/// `start_stream` with no roster reference at all, so gemini cancelled
/// while queued - before claude and codex had even started - sat above
/// both of them forever, live and rebuilt alike.
#[test]
fn a_queued_cancel_never_outranks_a_lane_dispatched_before_it() {
    let (live, reducer) = live_room_from(scripted_history(&[
        ("gemini", "cancel"),
        ("claude", "start"),
        ("claude", "cancel"),
        ("codex", "start"),
        ("codex", "cancel"),
    ]));
    let rebuilt = RoomScrollback::from_reducer(&reducer);
    let live_text = live.searchable_text();
    let rebuilt_text = rebuilt.searchable_text();
    assert_eq!(
        cancelled_row_order(&live_text),
        vec!["claude", "codex", "gemini"],
        "a lane cancelled while queued does not outrank the lanes \
             dispatched before it: {live_text:?}"
    );
    assert_eq!(
        cancelled_row_order(&rebuilt_text),
        vec!["claude", "codex", "gemini"],
        "and a reload reads the same: {rebuilt_text:?}"
    );
    assert_eq!(
        live_text, rebuilt_text,
        "live and rebuilt rooms must fold to the same rows in the same order"
    );
}

/// FL-141 round 3, P1 (re-review of `1cc5d5a`, the reviewer's PROBE2). The
/// same defect with the mix the other way round: two lanes cancelled while
/// queued, one streaming between them.
#[test]
fn a_turn_mixing_queued_and_streamed_cancels_reads_in_roster_order() {
    let (live, reducer) = live_room_from(scripted_history(&[
        ("gemini", "cancel"),
        ("codex", "start"),
        ("codex", "cancel"),
        ("claude", "cancel"),
    ]));
    let rebuilt = RoomScrollback::from_reducer(&reducer);
    let live_text = live.searchable_text();
    let rebuilt_text = rebuilt.searchable_text();
    assert_eq!(
        cancelled_row_order(&live_text),
        vec!["claude", "codex", "gemini"],
        "roster order holds when a streamed lane sits between two queued \
             cancels: {live_text:?}"
    );
    assert_eq!(
        cancelled_row_order(&rebuilt_text),
        vec!["claude", "codex", "gemini"],
        "and a reload reads the same: {rebuilt_text:?}"
    );
    assert_eq!(
        live_text, rebuilt_text,
        "live and rebuilt rooms must fold to the same rows in the same order"
    );
}

/// FL-141 round 3: the contract's own list, one test per terminal mix.
/// Each arm settles in an order that is deliberately NOT roster order, and
/// each one must read claude, codex, gemini both live and after a reload.
/// The previous round's tests all cancelled every lane the same way, which
/// is exactly the shape that cannot see a cross-outcome ordering bug.
#[test]
fn every_terminal_mix_reads_in_roster_order_live_and_rebuilt() {
    for (name, script) in [
        (
            "answered + cancelled + queued-cancel",
            vec![
                ("gemini", "cancel"),
                ("codex", "start"),
                ("claude", "start"),
                ("codex", "cancel"),
                ("claude", "commit"),
                ("claude", "complete"),
            ],
        ),
        (
            "failed + cancelled",
            vec![
                ("codex", "start"),
                ("claude", "start"),
                ("codex", "cancel"),
                ("claude", "fail"),
            ],
        ),
        (
            "queued-cancel + streamed cancel",
            vec![
                ("gemini", "cancel"),
                ("codex", "start"),
                ("codex", "cancel"),
                ("claude", "start"),
                ("claude", "cancel"),
            ],
        ),
        (
            "all three answered, committed out of roster order",
            vec![
                ("gemini", "start"),
                ("claude", "start"),
                ("codex", "start"),
                ("gemini", "commit"),
                ("gemini", "complete"),
                ("codex", "commit"),
                ("codex", "complete"),
                ("claude", "commit"),
                ("claude", "complete"),
            ],
        ),
    ] {
        let (live, reducer) = live_room_from(scripted_history(&script));
        let rebuilt = RoomScrollback::from_reducer(&reducer);
        let live_text = live.searchable_text();
        let rebuilt_text = rebuilt.searchable_text();
        let expected: Vec<&str> = ["claude", "codex", "gemini"]
            .into_iter()
            .filter(|agent| live_text.contains(agent))
            .collect();
        assert_eq!(
            lane_row_order(&live_text),
            expected,
            "[{name}] live rows must read in roster order: {live_text:?}"
        );
        assert_eq!(
            lane_row_order(&rebuilt_text),
            expected,
            "[{name}] rebuilt rows must read in roster order: {rebuilt_text:?}"
        );
        // Full-text parity for EVERY mix, with no exception. FL-141 round 3
        // carried one — the failed mix — because a FAILED lane's streamed
        // text was dropped by a reload, and that comment recorded the
        // divergence as the operator's to decide rather than this lane's.
        // Decided (2026-09-02): the partial text a failed agent got out is
        // KEPT after reload, so `replay_stream_for_lane` replays a failed
        // lane's stream and the exemption is gone. If it comes back, a
        // reload has started losing text the operator saw live.
        assert_eq!(
            live_text, rebuilt_text,
            "[{name}] live and rebuilt rooms must fold to the same rows \
                 in the same order"
        );
    }
}

/// FL-141 round 3: the reducer invariant two comments in `room_scrollback`
/// lean on. `replay_stream_for_lane` holds a cancelled lane's stream back
/// when the lane committed, and `draw_unstreamed_lane_steps` used to say a
/// committed-then-cancelled lane was what still reached it. The re-review
/// said that lane cannot exist. It cannot: `message.committed` moves the
/// lane to `Committed`, and `cancel_lane` accepts only Queued, Running or
/// Cancelling. Pinned here so the next reader gets the invariant from a
/// test rather than from prose that has already been wrong once.
#[test]
fn a_lane_that_committed_can_never_be_cancelled_afterwards() {
    let mut reducer = RoomReducer::new();
    for next in scripted_history(&[("claude", "start"), ("claude", "commit")]) {
        reducer.apply(&next).expect("the fixture is reducer-valid");
    }
    let lane = reducer.lane("claude-lane").expect("the lane exists");
    assert_eq!(lane.phase, LanePhase::Committed);
    assert!(lane.message_commit.is_some());

    let rejected = reducer.apply(&event(
        9,
        "lane.cancelled",
        json!({"laneId":"claude-lane","agent":"claude","streamId":"claude-stream"}),
    ));
    let message = rejected
        .expect_err("a committed lane must refuse a cancel")
        .to_string();
    assert!(
        message.contains("requires a queued, running, or cancelling lane"),
        "the reducer refuses it for the stated reason: {message}"
    );
}

/// The FAILURE half of the invariant above, and the load-bearing half of the
/// 2026-09-02 ruling.
///
/// `replay_stream_for_lane` now replays a FAILED lane's stream. That is only
/// safe because a failed lane can never also have committed: if it could, the
/// rebuild would draw the answer once from the transcript entry and a second
/// time from the replayed stream, which is exactly the reason `Completed` is
/// still excluded. `fail_lane` accepts Running, Cancelling, or a Queued lane
/// only when `recovered` is set, and `message.committed` moves the lane to
/// `Committed` before any of those — so the shape cannot arise.
///
/// Pinned from the reducer rather than argued in a comment, because the
/// comment that made the equivalent claim about cancels was wrong once
/// already.
#[test]
fn a_lane_that_committed_can_never_fail_afterwards() {
    let mut reducer = RoomReducer::new();
    for next in scripted_history(&[("claude", "start"), ("claude", "commit")]) {
        reducer.apply(&next).expect("the fixture is reducer-valid");
    }
    let lane = reducer.lane("claude-lane").expect("the lane exists");
    assert_eq!(lane.phase, LanePhase::Committed);

    for payload in [
        json!({"laneId":"claude-lane","agent":"claude","streamId":"claude-stream","error":"boom"}),
        // The recovered escape hatch does not open it either: that arm is for
        // a lane still QUEUED, and this one is past that.
        json!({"laneId":"claude-lane","agent":"claude","streamId":"claude-stream","recovered":true}),
    ] {
        let message = reducer
            .apply(&event(9, "lane.failed", payload))
            .expect_err("a committed lane must refuse a failure")
            .to_string();
        assert!(
            message.contains("requires a running/cancelling lane or a recovered queued lane"),
            "the reducer refuses it for the stated reason: {message}"
        );
    }

    // The consequence the room depends on, stated as the room states it: no
    // lane in the reducer is both failed and committed, so replaying a failed
    // lane's stream cannot duplicate a transcript entry.
    assert!(
        !reducer
            .ordered_lanes()
            .any(|lane| lane.phase == LanePhase::Failed && lane.message_commit.is_some())
    );
}

/// The ruling's own scope question: EVERY terminal phase, not just the failed
/// one the exemption named.
///
/// Each arm drives one lane to one terminal phase with partial streamed text
/// already on screen, then rebuilds from the same reducer and demands the two
/// feeds read identically. Before the ruling only the cancelled arm passed;
/// the failed arm was the exempted mix. The completed arm is the control that
/// keeps the fix honest — a completed lane's text lives in the transcript, so
/// if `replay_stream_for_lane` ever started replaying it too, this arm would
/// see the answer twice in the rebuilt feed.
#[test]
fn every_terminal_phase_keeps_its_streamed_text_across_a_reload() {
    for (phase, script) in [
        (
            LanePhase::Failed,
            vec![("claude", "start"), ("claude", "fail")],
        ),
        (
            LanePhase::Cancelled,
            vec![("claude", "start"), ("claude", "cancel")],
        ),
        (
            LanePhase::Completed,
            vec![
                ("claude", "start"),
                ("claude", "commit"),
                ("claude", "complete"),
            ],
        ),
    ] {
        let (live, reducer) = live_room_from(scripted_history(&script));
        let lane = reducer.lane("claude-lane").expect("the lane exists");
        assert_eq!(lane.phase, phase, "the script reaches the phase it names");
        let rebuilt = RoomScrollback::from_reducer(&reducer);
        let live_text = live.searchable_text();
        let rebuilt_text = rebuilt.searchable_text();
        assert_eq!(
            live_text, rebuilt_text,
            "[{phase:?}] a reload must read exactly as the live room did"
        );
        // Not merely equal — equal AND non-empty about this lane, so an arm
        // cannot pass by both rooms drawing nothing at all.
        assert!(
            live_text.contains("claude"),
            "[{phase:?}] the lane reached the feed: {live_text:?}"
        );
        // The control: the answer text appears exactly once, never twice.
        let needle = if phase == LanePhase::Completed {
            "claude answered"
        } else {
            "claude was working on it"
        };
        assert_eq!(
            rebuilt_text.matches(needle).count(),
            1,
            "[{phase:?}] {needle:?} is drawn once on reload: {rebuilt_text:?}"
        );
    }
}

/// CQ-04, pinned as an OPERATION COUNT rather than a clock.
///
/// A rebuild used to ask "which lane committed this message?" once per
/// transcript row, and answer it by walking `lane_order` — which gains a lane
/// per agent per turn and is never pruned. So `from_reducer` cost rows × lanes,
/// and codex measured the room taking 13.3 s to come back at 8,000 rows, with
/// 4× the rows costing 25.9× the time.
///
/// **No wall-clock assertion here, deliberately.** A time budget on a loaded
/// box measures the box, which is the FL-175 class of flake. What is actually
/// invariant is the number of lane walks: after the fix `from_reducer` walks
/// the list a FIXED number of times whatever the transcript's length, because
/// the per-row question is answered by the reducer's own message index. The
/// benchmark lives in the RP report, measured, not asserted.
///
/// RED against the scans: put any one of the four rewired call sites back and
/// the count moves with the transcript, which is the whole defect. The
/// instrument found the fourth site itself — removing the two CQ-04 named left
/// the count at `turns + 1`, because slice D's relocation asks
/// `turn_first_draw_seq` once per committed answer and that walked the whole
/// lane list to find one turn's handful.
///
/// ⚠ **WHAT THIS DOES NOT COVER.** It counts walks of the LANE list and nothing
/// else. The cost that actually dominated a rebuild was a walk of the
/// TRANSCRIPT, inside `displacement_prompt`, and this pin was blind to it —
/// green here while a 4,000-row reload took 23 seconds. Round 2 fixed that term
/// and gave it its OWN counter next door
/// (`a_rebuild_probes_the_transcript_no_more_than_a_constant_per_row`). Neither
/// pin alone says a rebuild is linear; they bound two different scans.
#[test]
fn a_rebuild_walks_the_lane_list_the_same_number_of_times_however_long_the_session_is() {
    let walks_to_rebuild = |turns: u64| -> (u64, usize) {
        let mut reducer = RoomReducer::new();
        for next in long_session(turns) {
            reducer.apply(&next).expect("the fixture is reducer-valid");
        }
        let rows = reducer.transcript().count();
        zer0_room_protocol::reset_lane_scans_on_this_thread();
        let room = RoomScrollback::from_reducer(&reducer);
        let walks = zer0_room_protocol::lane_scans_on_this_thread();
        // The room really was built, so a rebuild that silently did nothing
        // cannot answer zero and pass.
        assert!(room.state.len() >= rows, "the rebuild drew every row");
        (walks, rows)
    };

    let (small_walks, small_rows) = walks_to_rebuild(4);
    let (large_walks, large_rows) = walks_to_rebuild(64);
    assert_eq!(
        small_rows * 16,
        large_rows,
        "the fixture scales the way it says"
    );
    // THE POSITIVE CONTROL for the instrument itself. A counter wired to
    // nothing reads zero for both sizes and the equality below passes on an
    // absent signal — which is the failure this repo pays for most often.
    assert!(
        small_walks > 0,
        "the lane-walk counter is not wired to `ordered_lanes`"
    );
    assert_eq!(
        small_walks, large_walks,
        "a 16× longer transcript must not cost one extra walk of the lane list: \
         {small_rows} rows took {small_walks}, {large_rows} rows took {large_walks}"
    );
}

/// RP item 5, REPORTED NOT FIXED: a rebuilt running lane counts its spinner
/// off the wall clock, not off the record it was rebuilt from.
///
/// This is a CHARACTERIZATION test. It passes because the defect is present
/// and it goes RED the day someone fixes it, which is the point — whoever
/// fixes it has to come here, read why it was left, and say what a rebuilt
/// "working for Ns" should show. That is a ruling nobody has made:
/// `elapsed_seconds` subtracts `lane.started_at` from `Utc::now()`, so a
/// session reopened an hour later says the lane has been working for an hour,
/// while the events say six seconds and stop. Found by the slice D reviewer;
/// pre-existing at `6024ff2`, untouched by this lane.
///
/// The two numbers below are the whole finding. The event record describes a
/// lane that started at `:00` and last spoke at `:06` — six seconds of work,
/// and nothing after it. The rebuilt row shows the distance from that fixture
/// date to the machine's clock instead, which is millions of seconds and grows
/// every day this test is run.
///
/// It does assume the clock is later than the fixture's own August 2026, which
/// is the same assumption every dated fixture in this file already makes.
#[test]
fn a_rebuilt_running_lane_counts_its_spinner_from_the_wall_clock_not_the_record() {
    // Up to the activity and no further: a chunk would retire the status row
    // (`sync_lane_activity` treats delivered text as the end of the wait), and
    // the spinner is what this is about.
    let events = StepsTurn::claude(&["in_progress"])
        .without_answer()
        .events(1);
    let mut reducer = RoomReducer::new();
    let mut live = RoomScrollback::new();
    for next in events.iter().take(5) {
        apply_live(&mut live, &mut reducer, next.clone());
    }
    let lane = reducer.lane("lane").expect("the lane exists");
    assert_eq!(lane.phase, LanePhase::Running, "the lane is still working");

    // What the RECORD says: started at :00, last spoke at :06.
    let started = lane.started_at.as_deref().expect("a running lane started");
    assert_eq!(started, "2026-08-02T00:00:00Z");
    let last_event = events[4].occurred_at.as_str();
    assert_eq!(last_event, "2026-08-02T00:00:06Z");

    // What the ROOM shows, on both paths.
    let spinner_seconds = |room: &RoomScrollback| -> i64 {
        room.searchable_text()
            .lines()
            .find_map(|line| {
                let open = line.rfind(" (")?;
                let inner = line[open + 2..].strip_suffix("s)")?;
                inner.parse::<i64>().ok()
            })
            .expect("a working lane paints its elapsed counter")
    };
    let rebuilt = RoomScrollback::from_reducer(&reducer);
    let shown = spinner_seconds(&rebuilt);
    assert!(
        shown > 1_000_000,
        "the rebuilt spinner reads the wall clock, so it is the distance from \
         {started} to now, not the 6 seconds between {started} and {last_event}: \
         it showed {shown}"
    );
    // The live room has the same source, which is exactly why the two agree
    // inside one process and diverge across a real reload: live drew its number
    // when the event arrived, and the rebuild draws a fresh one now.
    assert!(spinner_seconds(&live) > 1_000_000);
}

/// RP round 2: the OTHER scan, bounded and pinned.
///
/// `displacement_prompt` runs once per committed answer, and it used to walk
/// the whole transcript doing an `ordered_turns` search for every operator row
/// it passed — rows × turns of work per commit, which is where a rebuild's
/// whole superlinear cost lived (4,000 rows took 23,478 ms in release; with the
/// relocation step disabled the same fixture took 177 ms).
///
/// Two changes bound it: both seat lookups go through `RoomReducer::turn_seat`,
/// and the scan stops at the commit's own sequence instead of running to the
/// end. This counts what remains — one probe per transcript row the predicate
/// actually examines — and demands it stay proportional to the ROWS, with the
/// same constant at both fixture sizes.
///
/// The constant is the assertion. Before the fix the inner seat search made the
/// real work per probe grow with the turn count; a probe count that stayed
/// proportional to rows while each probe cost more would have looked fine, so
/// the seat lookup being O(1) is what makes this counter mean anything, and
/// `RoomReducer::turn_seat` is a HashMap read whose cost cannot grow.
///
/// ⚠ **WHAT THIS DOES NOT PROVE.** It bounds the number of transcript rows the
/// predicate looks at per rebuild. It does NOT prove a rebuild is linear: the
/// scan is still run once per committed answer, so the product is rows × answers
/// in the worst shape — a session where every answer is displaced late. It says
/// nothing about the row-drawing cost, the sort, or the relocation MOVE itself,
/// and it is not a clock. The wall-clock table lives in `rebuild_cost_table` and
/// in the RP report, measured rather than asserted.
#[test]
fn a_rebuild_probes_the_transcript_no_more_than_a_constant_per_row() {
    // BOTH SHAPES, and each one catches a different half of the fix.
    //
    // DISPLACED: every commit finds a prompt in its window, so the predicate
    // returns on its first probe. This is the positive control — it is the only
    // shape where the counter moves at all — and it catches a lost window seek,
    // because without it the scan starts at row zero and walks up to the commit.
    //
    // UNDISPLACED: no commit finds anything, so the predicate runs to the end of
    // whatever range it was given. Its window is empty and it should probe
    // NOTHING. This is the shape that catches a lost `take_while`: without the
    // bound the scan runs from the turn's first draw to the end of the
    // transcript on every commit, and the displaced shape cannot see that
    // because it always matches on the first row and returns.
    let probes_to_rebuild = |turns: u64, displaced: bool| -> (u64, u64) {
        let mut reducer = RoomReducer::new();
        let events = if displaced {
            long_session_with_displacement(turns)
        } else {
            long_session(turns)
        };
        for next in events {
            reducer.apply(&next).expect("the fixture is reducer-valid");
        }
        let rows = reducer.transcript().count() as u64;
        super::relocation::reset_displacement_probes_on_this_thread();
        let room = RoomScrollback::from_reducer(&reducer);
        let probes = super::relocation::displacement_probes_on_this_thread();
        assert!(
            room.state.len() as u64 >= rows,
            "the rebuild drew every row"
        );
        (probes, rows)
    };

    let (small_probes, small_rows) = probes_to_rebuild(4, true);
    let (large_probes, large_rows) = probes_to_rebuild(64, true);
    // The positive control: a counter wired to nothing reads zero everywhere
    // and every bound below holds vacuously.
    assert!(
        small_probes > 0,
        "the probe counter is not wired to the predicate"
    );
    // ONE SMALL CONSTANT PER ROW, and the SAME constant at both sizes. That is
    // the whole assertion, and it is deliberately not a ratio-monotonicity
    // check: the true count here is `rows - 2`, so probes-per-row rises toward
    // 1 from below as the session grows and a "must not increase" test would
    // fail on correct linear behaviour.
    //
    // Measured 2026-09-02 on this fixture: 6 probes over 8 rows, 126 over 128 —
    // one per row, less a constant. Before the fix the same fixture at 128 rows
    // ran 4,160 probes (the RP reviewer reconstructed the pre-fix shape; ~32 per
    // row), and that number grows without bound with the session, so ANY
    // constant bound catches the regression. What this pin catches and what it
    // does NOT (RP review r1, measured): reverting the window seek alone puts
    // the displaced shape back at 4,159 probes — RED here. Reverting the
    // `take_while` bound alone leaves every shape here GREEN (the undisplaced
    // shape reads 127 probes over 128 rows, under the budget); that regression
    // is a correctness defect, not a cost one — the scan runs past the commit
    // into the next turn's prompt and relocates turns that must not move — and
    // it is pinned by the relocation-correctness tests, not by this counter.
    const MAX_PROBES_PER_ROW: u64 = 4;
    let (quiet_probes, quiet_rows) = probes_to_rebuild(64, false);
    for (probes, rows, label) in [
        (small_probes, small_rows, "displaced/small"),
        (large_probes, large_rows, "displaced/large"),
        (quiet_probes, quiet_rows, "undisplaced/large"),
    ] {
        assert!(
            probes <= rows * MAX_PROBES_PER_ROW,
            "[{label}] {probes} probes over {rows} rows is more than \
             {MAX_PROBES_PER_ROW} per row"
        );
    }
}

/// CQ-04's benchmark, and it ASSERTS NOTHING — it prints.
///
/// The measurement the operator cares about is wall-clock, and a wall-clock
/// budget is exactly the assertion this repo has been burned by: on a loaded
/// box it measures the box. So the invariant is pinned next door as an
/// operation count, and this exists to produce the numbers a human compares.
///
/// Ignored by default and meaningless in a debug build. Run it with:
/// `cargo test --release -p xai-grok-pager --lib rebuild_cost_table -- --ignored --nocapture`
/// BOTH SHAPES since round 2. The round-1 table used only the quiet one, where
/// displacement never fires, and its own report named that as a gap: it never
/// exercised the relocation MOVE. The displaced column is the worst case — every
/// answer relocates — and it is the honest number to judge a reload by.
#[test]
#[ignore = "benchmark: prints a table, asserts nothing; run with --release --ignored --nocapture"]
fn rebuild_cost_table() {
    println!("shape\trows\tturns\tms\tlane_walks\tprobes");
    for (label, displaced) in [("quiet", false), ("displaced", true)] {
        for turns in [250_u64, 1_000, 2_000, 4_000] {
            let mut reducer = RoomReducer::new();
            let events = if displaced {
                long_session_with_displacement(turns)
            } else {
                long_session(turns)
            };
            for next in events {
                reducer.apply(&next).expect("the fixture is reducer-valid");
            }
            let rows = reducer.transcript().count();
            zer0_room_protocol::reset_lane_scans_on_this_thread();
            super::relocation::reset_displacement_probes_on_this_thread();
            let started = std::time::Instant::now();
            let room = RoomScrollback::from_reducer(&reducer);
            let elapsed = started.elapsed();
            println!(
                "{label}\t{rows}\t{turns}\t{}\t{}\t{}\t(entries {})",
                elapsed.as_millis(),
                zer0_room_protocol::lane_scans_on_this_thread(),
                super::relocation::displacement_probes_on_this_thread(),
                room.state.len()
            );
        }
    }
}

/// FL-141 round 3: a cancelled lane's code fence stays readable.
///
/// `dim_spans` repaints foregrounds and deliberately leaves backgrounds, so
/// a code fence inside a cancelled answer ends up dim-on-fill. Measured on
/// a painted frame: `Rgb(90,98,116)` on `Rgb(44,44,44)`, a WCAG contrast
/// ratio of 2.28:1, against 3.43:1 for the same gray on the terminal's own
/// background. That is low, and it is reported to the operator rather than
/// hidden — but the failure mode worth a GATE is not "low", it is
/// "invisible", and that is what this pins: no cell may end with its
/// foreground equal to its background.
///
/// Upstream dims markdown bodies including their fences, so this is not a
/// local invention: `ThinkingBlock` blends every wrapped markdown line
/// toward the base colour
/// (`D:/grok-ref/.../scrollback/blocks/thinking.rs:296-301` calling
/// `blend_line_with_default`,
/// `D:/grok-ref/.../render/color.rs:245-263`). The deviation is the
/// mechanism: upstream BLENDS each span's own colour toward the base, this
/// FLATTENS every span to one gray. Flat is what the ruling asked for
/// ("the 3 from top should become gray") and it is what
/// `a_cancelled_lane_paints_its_text_gray_on_a_real_frame` can assert
/// cell by cell; a blend would leave every cell a different colour and
/// there would be nothing exact left to pin.
#[test]
fn a_cancelled_lanes_code_fence_never_paints_text_onto_its_own_colour() {
    use ratatui::buffer::Buffer;
    use ratatui::layout::Rect;

    let _theme = pin_theme();
    let mut reducer = RoomReducer::new();
    let mut room = RoomScrollback::new();
    let mut events = scripted_history(&[("claude", "start")]);
    events.push(event(
            8,
            "lane.chunk",
            json!({"laneId":"claude-lane","streamId":"claude-stream","agent":"claude","streamSeq":"2","chunkIndex":1,"channel":"assistant","text":"\n\n```rust\nfn main() { println!(\"hi\"); }\n```\n"}),
        ));
    events.push(event(
        9,
        "lane.cancelled",
        json!({"laneId":"claude-lane","agent":"claude","streamId":"claude-stream"}),
    ));
    for next in events {
        apply_live(&mut room, &mut reducer, next);
    }

    let area = Rect::new(0, 0, 90, 30);
    let mut buffer = Buffer::empty(area);
    let _ = room.render(area, &mut buffer);

    let mut fenced_cells = 0;
    for y in 0..area.height {
        for x in 0..area.width {
            let cell = buffer.cell((x, y)).expect("cell inside the rendered area");
            if cell.symbol().trim().is_empty() {
                continue;
            }
            assert_ne!(
                cell.fg,
                cell.bg,
                "a dimmed cancelled answer must never paint a glyph onto its \
                     own colour at ({x}, {y}): {:?}",
                cell.symbol()
            );
            if cell.bg != ratatui::style::Color::Reset {
                fenced_cells += 1;
            }
        }
    }
    assert!(
        fenced_cells > 0,
        "the fixture must actually render a filled code fence, or this \
             proves nothing"
    );
}

/// FL-141 round 4 (re-review of `63b69b2`, probe RP-F). Two turns, and the
/// first turn's answer arrives LAST: claude streams under question one,
/// the operator asks question two and gemini draws under it, and only then
/// does claude commit.
///
/// This is the shape that guards `DurableRow::replay_seq`'s `Transcript`
/// arm — the line that re-keys a committed answer onto its lane's
/// first-draw sequence instead of onto `message.committed`. The reviewer
/// put the round-2 two-clock bug back and the ENTIRE suite stayed green,
/// including `a_reload_keeps_an_answer_above_a_lane_cancelled_after_it`,
/// the test written for that very regression: once `lane_anchor` owns
/// placement, a single-turn shape comes out right whether the replay sort
/// is fixed or not. Only a CROSS-TURN late commit can see it, because
/// turn 2's prompt is not a lane row and no anchor can move it.
///
/// MUTATED for the slice D rebuild (memo §2 site 2): claude's cross-turn
/// commit now DISPLACES — its whole turn block moves to the tail with the
/// D.5 back-reference naming the prompt it answers. Distinct per-event
/// times make the reference name the FIRST question specifically: a bug
/// that picked the displacing prompt's time (or any other) fails. The
/// replay_seq property this history was built for is untouched — rebuild
/// parity below still dies if a reload files the answer by commit clock.
fn two_turn_late_commit_history() -> Vec<RoomEvent> {
    const TURN_ONE_TIME: &str = "2026-08-02T16:04:00Z";
    const TURN_TWO_TIME: &str = "2026-08-02T16:05:00Z";
    const COMMIT_TIME: &str = "2026-08-02T16:06:00Z";
    vec![
        event_at(
            1,
            "turn.accepted",
            json!({"agents":["claude"],"text":"first question","messageId":"first-prompt","ledgerSeq":"1"}),
            TURN_ONE_TIME,
            "turn-1",
        ),
        event_at(
            2,
            "route.resolved",
            json!({"agents":["claude"]}),
            TURN_ONE_TIME,
            "turn-1",
        ),
        event_at(
            3,
            "lane.queued",
            json!({"laneId":"claude-lane","agent":"claude","expectedMessageId":"claude-message","origin":"operator","hopIndex":0}),
            TURN_ONE_TIME,
            "turn-1",
        ),
        event_at(
            4,
            "lane.started",
            json!({"laneId":"claude-lane","streamId":"claude-stream","agent":"claude"}),
            TURN_ONE_TIME,
            "turn-1",
        ),
        event_at(
            5,
            "lane.chunk",
            json!({"laneId":"claude-lane","streamId":"claude-stream","agent":"claude","streamSeq":"1","chunkIndex":0,"channel":"assistant","text":"claude thinking"}),
            TURN_ONE_TIME,
            "turn-1",
        ),
        event_at(
            6,
            "turn.accepted",
            json!({"agents":["gemini"],"text":"second question","messageId":"second-prompt","ledgerSeq":"6"}),
            TURN_TWO_TIME,
            "turn-2",
        ),
        event_at(
            7,
            "route.resolved",
            json!({"agents":["gemini"]}),
            TURN_TWO_TIME,
            "turn-2",
        ),
        event_at(
            8,
            "lane.queued",
            json!({"laneId":"gemini-lane","agent":"gemini","expectedMessageId":"gemini-message","origin":"operator","hopIndex":0}),
            TURN_TWO_TIME,
            "turn-2",
        ),
        event_at(
            9,
            "lane.started",
            json!({"laneId":"gemini-lane","streamId":"gemini-stream","agent":"gemini"}),
            TURN_TWO_TIME,
            "turn-2",
        ),
        event_at(
            10,
            "lane.chunk",
            json!({"laneId":"gemini-lane","streamId":"gemini-stream","agent":"gemini","streamSeq":"1","chunkIndex":0,"channel":"assistant","text":"gemini answering"}),
            TURN_TWO_TIME,
            "turn-2",
        ),
        event_at(
            11,
            "message.committed",
            json!({"laneId":"claude-lane","agent":"claude","messageId":"claude-message","ledgerSeq":"11","text":"claude thinking then answered","origin":"operator","hopIndex":0}),
            COMMIT_TIME,
            "turn-1",
        ),
        event_at(
            12,
            "lane.completed",
            json!({"laneId":"claude-lane","streamId":"claude-stream","agent":"claude"}),
            COMMIT_TIME,
            "turn-1",
        ),
    ]
}

#[test]
fn a_cross_turn_commit_moves_its_whole_turn_block_to_the_tail() {
    let (live, reducer) = live_room_from(two_turn_late_commit_history());
    let rebuilt = RoomScrollback::from_reducer(&reducer);
    let live_order = rendered_row_order(&live);
    let rebuilt_order = rendered_row_order(&rebuilt);

    assert_eq!(
        live_order, rebuilt_order,
        "live and rebuilt rooms must fold to the same rows in the same order"
    );

    // Glyphs ASKED FOR, never written down: verify:rust re-runs this module
    // under GROK_FORCE_LEGACY_CONSOLE=1 where these read `>`/`*`/`>`.
    let arrow = room_secondary(RoomSecondaryGlyph::HopArrow);
    let back_reference = format!("{arrow} answering your 7:04 PM message");

    let ref_idx = live_order
        .iter()
        .position(|row| *row == back_reference)
        .expect("the displaced answer carries exactly one back-reference row");
    assert_eq!(
        live_order
            .iter()
            .filter(|row| **row == back_reference)
            .count(),
        1,
        "D.6: exactly one back-reference per qualifying answer"
    );

    // The moved unit is claude's whole turn block: every claude-owned row
    // sits AT or BELOW the back-reference, nothing claude-owned remains in
    // the chronological segment above it.
    let claude_header_idx = live_order
        .iter()
        .position(|row| row.contains("claude · 7:06 PM"))
        .expect("claude's canonicalized header is on screen");
    assert_eq!(
        claude_header_idx,
        ref_idx + 1,
        "D.5: the reference sits immediately before the answer's own header"
    );
    assert!(
        !live_order[..ref_idx]
            .iter()
            .any(|row| row.contains("claude")),
        "no claude fragment may stay behind at the source: {live_order:?}"
    );

    // The original prompts NEVER move (memo §4), and gemini — whose own turn
    // drew after the second question — stays exactly where FL-141 put it,
    // between the two prompts and the relocated block.
    let first_question_idx = position_of(&live_order, "first question");
    let second_question_idx = position_of(&live_order, "second question");
    let gemini_idx = position_of(&live_order, "gemini answering");
    assert!(
        first_question_idx < second_question_idx
            && second_question_idx < gemini_idx
            && gemini_idx < ref_idx,
        "prompts keep their chronological seats and gemini keeps its own: \
             {live_order:?}"
    );
}

/// Index of the first rendered row containing `needle`, failing loudly when
/// absent so an assertion about ordering can never silently pass on a row
/// that stopped rendering.
fn position_of(rows: &[String], needle: &str) -> usize {
    rows.iter()
        .position(|row| row.contains(needle))
        .unwrap_or_else(|| panic!("row {needle:?} must be on screen: {rows:?}"))
}

/// FL-141 round 4 (re-review of `63b69b2`): `forget_settled_turn` and
/// `lane_rows` had no test at all — `grep -c` over this file returned 0.
/// Two properties, observed through row order rather than through the
/// private field, plus a direct anchor count so the pruning is proven to
/// have HAPPENED rather than inferred from rows that would look the same
/// either way.
///
/// Property 1: pruning must not eat an anchor a lane still needs. Turn 1
/// cancels gemini(2) and claude(0) while codex(1) is still running — the
/// turn is not settled, the anchors stay, and codex lands between them.
#[test]
fn pruning_never_drops_an_anchor_a_running_lane_still_needs() {
    let mut reducer = RoomReducer::new();
    let mut room = RoomScrollback::new();
    let events = scripted_history(&[
        ("gemini", "cancel"),
        ("codex", "start"),
        ("claude", "cancel"),
        ("codex", "cancel"),
    ]);
    let (before_codex_settles, rest) = events.split_at(events.len() - 1);
    for next in before_codex_settles.iter().cloned() {
        apply_live(&mut room, &mut reducer, next);
    }

    // Slice D replaced FL-141's one-anchor-per-lane table with full
    // per-turn MEMBERSHIP, so the count is rows now, not lanes: gemini's
    // cancelled-while-queued row, claude's cancelled row, and codex's
    // header+answer (its STATUS row was retired by its own delivered chunk
    // and unregistered with it - that removal is §1.3's recycler duty, not
    // pruning). The property under test is unchanged: while codex runs, the
    // turn is unsettled and everything still registered stays registered.
    assert_eq!(
        room.lane_anchor_count(),
        4,
        "codex is still Running, so turn 1 is unsettled and every member \
             row its lanes still own remains registered"
    );
    assert_eq!(
        lane_row_order(&room.searchable_text()),
        vec!["claude", "codex", "gemini"],
        "and the running lane sits between the two cancelled ones: {:?}",
        room.searchable_text()
    );

    for next in rest.iter().cloned() {
        apply_live(&mut room, &mut reducer, next);
    }
    assert_eq!(
        room.lane_anchor_count(),
        0,
        "once nothing of the turn can draw again, its anchors are dropped"
    );
    assert_eq!(
        lane_row_order(&room.searchable_text()),
        vec!["claude", "codex", "gemini"],
        "and dropping them disturbs not one already-drawn row: {:?}",
        room.searchable_text()
    );
}

/// Property 2: a later turn anchors its own lanes correctly from an empty
/// table. Turn 1 settles completely (so `forget_settled_turn` clears it),
/// then turn 2 dispatches claude(3) and codex(4) but starts codex FIRST —
/// which is precisely the case that needs an anchor, and the case that
/// would break if pruning had left stale entries behind or if the search
/// were not turn-scoped.
#[test]
fn a_later_turn_still_anchors_after_the_earlier_turn_is_forgotten() {
    let mut reducer = RoomReducer::new();
    let mut room = RoomScrollback::new();
    for next in scripted_history(&[
        ("claude", "start"),
        ("codex", "start"),
        ("gemini", "start"),
        ("gemini", "cancel"),
        ("claude", "cancel"),
        ("codex", "cancel"),
    ]) {
        apply_live(&mut room, &mut reducer, next);
    }
    assert_eq!(
        room.lane_anchor_count(),
        0,
        "turn 1 is fully settled, so its anchors are gone"
    );

    let mut seq = 15;
    let mut next_seq = || {
        seq += 1;
        seq - 1
    };
    let accepted = next_seq();
    let second_turn = vec![
        event_at(
            accepted,
            "turn.accepted",
            json!({"agents":["claude","codex"],"text":"second question","messageId":"second-prompt","ledgerSeq":accepted.to_string()}),
            "2026-08-02T00:00:00Z",
            "turn-2",
        ),
        event_at(
            next_seq(),
            "route.resolved",
            json!({"agents":["claude","codex"]}),
            "2026-08-02T00:00:00Z",
            "turn-2",
        ),
        event_at(
            next_seq(),
            "lane.queued",
            json!({"laneId":"claude-lane-2","agent":"claude","expectedMessageId":"claude-message-2","origin":"operator","hopIndex":0}),
            "2026-08-02T00:00:00Z",
            "turn-2",
        ),
        event_at(
            next_seq(),
            "lane.queued",
            json!({"laneId":"codex-lane-2","agent":"codex","expectedMessageId":"codex-message-2","origin":"operator","hopIndex":0}),
            "2026-08-02T00:00:00Z",
            "turn-2",
        ),
        // codex starts FIRST, out of roster order. Without a working
        // anchor its header appends and claude lands underneath it.
        event_at(
            next_seq(),
            "lane.started",
            json!({"laneId":"codex-lane-2","streamId":"codex-stream-2","agent":"codex"}),
            "2026-08-02T00:00:00Z",
            "turn-2",
        ),
        event_at(
            next_seq(),
            "lane.chunk",
            json!({"laneId":"codex-lane-2","streamId":"codex-stream-2","agent":"codex","streamSeq":"1","chunkIndex":0,"channel":"assistant","text":"codex second answer"}),
            "2026-08-02T00:00:00Z",
            "turn-2",
        ),
        event_at(
            next_seq(),
            "lane.started",
            json!({"laneId":"claude-lane-2","streamId":"claude-stream-2","agent":"claude"}),
            "2026-08-02T00:00:00Z",
            "turn-2",
        ),
        event_at(
            next_seq(),
            "lane.chunk",
            json!({"laneId":"claude-lane-2","streamId":"claude-stream-2","agent":"claude","streamSeq":"1","chunkIndex":0,"channel":"assistant","text":"claude second answer"}),
            "2026-08-02T00:00:00Z",
            "turn-2",
        ),
    ];
    for next in second_turn {
        apply_live(&mut room, &mut reducer, next);
    }

    let text = room.searchable_text();
    let claude_at = text
        .find("claude second answer")
        .expect("claude's turn-2 row");
    let codex_at = text
        .find("codex second answer")
        .expect("codex's turn-2 row");
    assert!(
        claude_at < codex_at,
        "turn 2 must read in its own roster order even though codex drew \
             first and turn 1's anchors are gone: {text:?}"
    );
    assert_eq!(
        text,
        RoomScrollback::from_reducer(&reducer).searchable_text(),
        "and a reload of both turns folds to the same rows in the same order"
    );
}

// ---------------------------------------------------------------------------
// SLICE D — task ZERO (spec §D.2). The characterization lock.
// ---------------------------------------------------------------------------

/// The four events of §D.2, verbatim: an operator question, the lane that
/// answers it, a SECOND operator question, and only then the commit.
///
/// This is the whole of FL-090's shape — an answer that becomes final after a
/// later operator message already sits below the block it will land in.
fn late_answer_history() -> Vec<RoomEvent> {
    vec![
        event_at(
            1,
            "turn.accepted",
            json!({
                "agents": ["claude"],
                "text": "Q1",
                "messageId": "q1",
                "ledgerSeq": "1",
            }),
            "2026-08-02T15:04:00Z",
            "turn-1",
        ),
        event_at(
            2,
            "route.resolved",
            json!({ "agents": ["claude"] }),
            "2026-08-02T15:04:00Z",
            "turn-1",
        ),
        event_at(
            3,
            "lane.queued",
            json!({
                "laneId": "lane-claude",
                "agent": "claude",
                "expectedMessageId": "m-claude",
                "origin": "operator",
                "hopIndex": 0,
            }),
            "2026-08-02T15:04:00Z",
            "turn-1",
        ),
        event_at(
            4,
            "lane.started",
            json!({ "laneId": "lane-claude", "streamId": "stream-claude", "agent": "claude" }),
            "2026-08-02T15:04:01Z",
            "turn-1",
        ),
        event_at(
            5,
            "turn.accepted",
            json!({
                "agents": ["codex"],
                "text": "Q2",
                "messageId": "q2",
                "ledgerSeq": "5",
            }),
            "2026-08-02T15:05:00Z",
            "turn-2",
        ),
        event_at(
            6,
            "message.committed",
            json!({
                "laneId": "lane-claude",
                "agent": "claude",
                "messageId": "m-claude",
                "ledgerSeq": "6",
                "text": "the late answer",
                "origin": "operator",
                "hopIndex": 0,
            }),
            "2026-08-02T15:06:00Z",
            "turn-1",
        ),
    ]
}

/// The rendered row order, one entry per line, as a list rather than one blob
/// so a divergence names the row that moved instead of dumping two paragraphs.
fn rendered_row_order(room: &RoomScrollback) -> Vec<String> {
    room.searchable_text()
        .lines()
        .map(|line| line.trim().to_owned())
        .collect()
}

/// Task ZERO of slice D (spec §D.2), run 2026-08-25 at `6024ff2`. **Verdict:
/// AGREE** — the two paths already agreed, because FL-141 remaps every
/// lane-bound row onto its lane's first-draw sequence (`room_scrollback.rs`
/// `DurableRow::replay_seq`). Task zero retired slice D's original premise
/// (a live-versus-rebuilt divergence) but confirmed the SYMPTOM: both paths
/// bury the late answer above the operator's later question.
///
/// This test has now been MUTATED to the rebuild contract (memo §2 site 1):
/// the agreement stands, and the position both agree on is the TAIL, with the
/// D.5 back-reference naming the displaced prompt immediately before the
/// answer's header. Written out row-for-row so the order is a deliberate
/// decision rather than an accident.
///
/// What a weaker assertion would let pass: an equality-only check would be
/// satisfied by BOTH paths burying the answer under Q2 — that is why the
/// exact tail order with the back-reference row is spelled out. An assertion
/// that only checked "answer after Q2" would accept a move of the operator's
/// own Q1/Q2 prompts to the tail too; the full vector pins that the prompts
/// stay put (§4: the original operator prompt never moves) and that exactly
/// one back-reference row sits between Q2 and the answer header.
///
/// History kept from task zero: **the instrument was shown able to return the
/// other answer** (§3 rule 7). With `replay_seq`'s `Transcript` arm reduced to
/// `entry.event_seq` — the pre-FL-141 key — this same assertion separates:
///
/// ```text
///  live:    ["❯ you · 6:04 PM", "Q1", "◆ claude · 6:06 PM",
///            "the late answer", "❯ you · 6:05 PM", "Q2"]
///  rebuilt: ["❯ you · 6:04 PM", "Q1", "❯ you · 6:05 PM", "Q2",
///            "◆ claude · 6:06 PM", "the late answer"]
/// ```
#[test]
fn live_and_rebuilt_agree_on_a_late_answers_position() {
    let mut reducer = RoomReducer::new();
    let mut live = RoomScrollback::new();
    for next in late_answer_history() {
        apply_live(&mut live, &mut reducer, next);
    }
    let rebuilt = RoomScrollback::from_reducer(&reducer);

    let live_order = rendered_row_order(&live);
    let rebuilt_order = rendered_row_order(&rebuilt);

    assert_eq!(
        live_order, rebuilt_order,
        "the live path and the rebuild path must place a late answer at the \
         same position"
    );
    // The identity glyphs are ASKED FOR, not written down: a legacy Windows
    // console renders `>` and `*` where a modern one renders `❯` and `◆`, and
    // `verify:rust` re-runs this module under `GROK_FORCE_LEGACY_CONSOLE=1`
    // for exactly that reason. Hard-coding the modern pair here failed that
    // step — the same defect class the step was added for after FL-141. The
    // subject of this assertion is the ORDER, so the glyph set is whatever the
    // console reports. The hop arrow comes from `room_secondary` for the same
    // reason (legacy consoles draw `>`, not `→`).
    let you = RoomIdentity::You.glyph();
    let claude = RoomIdentity::Claude.glyph();
    let arrow = room_secondary(RoomSecondaryGlyph::HopArrow);
    assert_eq!(
        live_order,
        vec![
            format!("{you} you · 6:04 PM"),
            "Q1".to_owned(),
            format!("{you} you · 6:05 PM"),
            "Q2".to_owned(),
            format!("{arrow} answering your 6:04 PM message"),
            format!("{claude} claude · 6:06 PM"),
            "the late answer".to_owned(),
        ],
        "the turn block moved whole to the tail — both prompts still in \
         chronological place, then the back-reference naming the displaced \
         prompt, then the answer's own header and body"
    );
}

// ---------------------------------------------------------------------------
// SLICE D rebuild — cross-turn displacement (memo §2 sites 2/4 and the
// required scenarios). Every falsifier here was captured RED against the
// pre-rebuild tree at `e436207`; the verbatim outputs are retained in
// out/d-report.md under `# REBUILD (memo-bound)`.
//
// Rendering facts these expectations stand on (read, not assumed):
// - a lane renders exactly ONE body row; a commit either suffix-appends into
//   it or replaces it in place (`commit_message`, room_scrollback.rs);
// - a commit canonicalizes the lane header's timestamp to the COMMIT event's
//   `occurred_at` (`replace_room_status` in `commit_message`);
// - `searchable_text` joins one line per non-empty entry.
// ---------------------------------------------------------------------------

/// Index of the first row naming `agent` together with the `label · time`
/// header shape — the lane's header wherever relocation put it. Prompt rows
/// carry `you ·` and the back-reference carries neither an agent name nor
/// `· `, so neither can be mistaken for a lane header.
fn header_index_of(rows: &[String], agent: &str) -> usize {
    rows.iter()
        .position(|row| row.contains(agent) && row.contains("· "))
        .unwrap_or_else(|| panic!("{agent}'s header must be on screen: {rows:?}"))
}

/// One three-lane turn ("do the work"), all lanes streaming BEFORE the
/// operator's second prompt arrives, then exactly ONE lane committing after
/// it while its siblings stay open. `late_agent` names the committer.
/// First draws land at sequences 6/7/8, the second prompt at 9, the commit
/// at 10 — so the strict predicate `first_draw < 9 < commit` holds for all
/// three variants and the whole turn qualifies for relocation.
fn three_lane_displacement_history(late_agent: &str) -> Vec<RoomEvent> {
    // UTC stamps are the intended LOCAL wall times (this suite pins local
    // renders; the machine here runs UTC+3, proven by the committed site-1
    // expectations) minus three hours.
    const TURN_ONE_TIME: &str = "2026-08-02T13:00:00Z";
    const PROMPT_TWO_TIME: &str = "2026-08-02T13:01:00Z";
    const COMMIT_TIME: &str = "2026-08-02T13:02:00Z";
    let lanes = [
        ("claude", "claude-lane", "claude-stream"),
        ("codex", "codex-lane", "codex-stream"),
        ("gemini", "gemini-lane", "gemini-stream"),
    ];
    let mut events = vec![
        event_at(
            1,
            "turn.accepted",
            json!({"agents":["claude","codex","gemini"],"text":"do the work","messageId":"operator-message","ledgerSeq":"1"}),
            TURN_ONE_TIME,
            "turn-1",
        ),
        event_at(
            2,
            "route.resolved",
            json!({"agents":["claude","codex","gemini"]}),
            TURN_ONE_TIME,
            "turn-1",
        ),
    ];
    let mut seq = 3;
    for (agent, lane, _) in lanes {
        events.push(event_at(
            seq,
            "lane.queued",
            json!({"laneId":lane,"agent":agent,"expectedMessageId":format!("{agent}-message"),"origin":"operator","hopIndex":0}),
            TURN_ONE_TIME,
            "turn-1",
        ));
        seq += 1;
    }
    for (agent, lane, stream) in lanes {
        events.push(event_at(
            seq,
            "lane.started",
            json!({"laneId":lane,"streamId":stream,"agent":agent}),
            TURN_ONE_TIME,
            "turn-1",
        ));
        seq += 1;
    }
    events.push(event_at(
        9,
        "turn.accepted",
        json!({"agents":["claude"],"text":"hurry up","messageId":"second-prompt","ledgerSeq":"9"}),
        PROMPT_TWO_TIME,
        "turn-2",
    ));
    let (_, lane, _) = lanes
        .iter()
        .find(|(name, _, _)| *name == late_agent)
        .expect("late_agent names a roster agent");
    events.push(event_at(
        10,
        "message.committed",
        json!({"laneId":lane,"agent":late_agent,"messageId":format!("{late_agent}-message"),"ledgerSeq":"10","text":format!("{late_agent} answered"),"origin":"operator","hopIndex":0}),
        COMMIT_TIME,
        "turn-1",
    ));
    events
}

/// The atomicity falsifier, three ways: whichever roster position commits
/// late, EVERY lane travels. A weaker assertion — checking only that the
/// committer moved — would pass an implementation that relocates just the
/// committing lane's rows and strands its siblings at the source, which is
/// exactly the lane-only move memo §1.2 rejects (it would break FL-141's
/// roster read for a slow roster-first lane).
///
/// Same-turn sibling commits are covered by the PIN further down; this test
/// fires strictly across turns (prompt at sequence 12 sits between every
/// first draw and the commit), so the settle-order exemption cannot explain
/// a green.
#[test]
fn every_lane_of_the_moved_turn_travels_as_one_roster_ordered_block() {
    let arrow = room_secondary(RoomSecondaryGlyph::HopArrow);
    let reference = format!("{arrow} answering your 4:00 PM message");
    for late in ["claude", "codex", "gemini"] {
        let (live, reducer) = live_room_from(three_lane_displacement_history(late));
        let rebuilt = RoomScrollback::from_reducer(&reducer);
        // Live/rebuilt parity on PLACEMENT, not on the running lanes' elapsed
        // counters: a reloaded RUNNING lane renders its spinner duration from
        // a different clock than the live room (pre-existing at this base —
        // `(1979538s)` vs `(0s)` — observed while writing this falsifier and
        // out of slice D's scope). The status rows are filtered so the
        // assertion stays on what slice D owns.
        let drop_status = |rows: &[String]| -> Vec<String> {
            rows.iter()
                .filter(|row| !row.contains("working"))
                .cloned()
                .collect()
        };
        let order = drop_status(&rendered_row_order(&live));
        assert_eq!(
            order,
            drop_status(&rendered_row_order(&rebuilt)),
            "[{late}] live and rebuilt must fold the relocated block identically"
        );

        // Nothing of the turn stays behind: the segment between the source
        // prompt and the displacing prompt holds no lane row at all.
        let source_segment =
            &order[position_of(&order, "do the work")..position_of(&order, "hurry up")];
        assert!(
            !source_segment
                .iter()
                .any(|row| ["claude", "codex", "gemini"]
                    .iter()
                    .any(|a| row.contains(a))),
            "[{late}] not one lane row may stay behind at the source: {source_segment:?}"
        );

        // Every lane now sits below the displacing prompt, in roster order.
        // First row NAMING an agent, not `header_index_of`: a still-running
        // sibling's header carries no `· time` suffix to find.
        let hurry_idx = position_of(&order, "hurry up");
        let (claude_idx, codex_idx, gemini_idx) = (
            position_of(&order, "claude"),
            position_of(&order, "codex"),
            position_of(&order, "gemini"),
        );
        assert!(
            claude_idx > hurry_idx && codex_idx > hurry_idx && gemini_idx > hurry_idx,
            "[{late}] the whole block travelled below the new prompt: {order:?}"
        );
        assert!(
            claude_idx < codex_idx && codex_idx < gemini_idx,
            "[{late}] and it still reads in roster order: {order:?}"
        );

        // The reference annotates ITS OWN answer: immediately before the
        // committer's header, exactly once, naming the DISPLACED prompt's
        // 4:00 PM stamp (not the 4:01 PM one). The committer's own header is
        // canonicalized to the commit time, so it does carry `· time`.
        let ref_idx = order
            .iter()
            .position(|row| *row == reference)
            .unwrap_or_else(|| panic!("[{late}] carries its back-reference: {order:?}"));
        assert_eq!(
            header_index_of(&order, late),
            ref_idx + 1,
            "[{late}] D.5: the reference sits immediately before the answer's \
                 own header, mid-block when roster puts siblings above it"
        );
        assert_eq!(
            order.iter().filter(|row| **row == reference).count(),
            1,
            "[{late}] D.6: exactly one reference for one qualifying answer"
        );
    }
}

/// §1.8: the sibling that never commits keeps updating INSIDE the relocated
/// block. A weaker "somewhere below the new prompt" assertion would accept
/// an implementation that re-anchors the open sibling at the global tail or
/// back at the vacated source seat.
#[test]
fn an_open_sibling_keeps_updating_inside_the_moved_block() {
    let (mut live, mut reducer) = live_room_from(three_lane_displacement_history("claude"));
    let update = event_at(
        11,
        "lane.chunk",
        json!({"laneId":"gemini-lane","streamId":"gemini-stream","agent":"gemini","streamSeq":"1","chunkIndex":0,"channel":"assistant","text":"gemini kept going"}),
        "2026-08-02T13:03:00Z",
        "turn-1",
    );
    apply_live(&mut live, &mut reducer, update);

    let order = rendered_row_order(&live);
    let hurry_idx = position_of(&order, "hurry up");
    let reference_idx = position_of(&order, "answering your");
    let update_idx = position_of(&order, "gemini kept going");
    assert!(
        update_idx > reference_idx && reference_idx > hurry_idx,
        "the open sibling's post-move row landed inside the relocated block \
             (below the reference), not back at the source or at some \
             re-seated tail beyond it: {order:?}"
    );
    // Same parity rule as the atomicity falsifier above: placement, not the
    // running lanes' elapsed counters, which a reloaded RUNNING lane reads
    // off a different clock than the live room (pre-existing at this base).
    let drop_status = |rows: &[String]| -> Vec<String> {
        rows.iter()
            .filter(|row| !row.contains("working"))
            .cloned()
            .collect()
    };
    assert_eq!(
        drop_status(&order),
        drop_status(&rendered_row_order(&RoomScrollback::from_reducer(&reducer))),
        "and a reload folds the updated relocated block identically"
    );
}

/// Two OLD turns; their answers arrive in the OPPOSITE of turn order
/// (turn-2's codex first, then turn-1's lanes). Tail stacking must follow
/// ANSWER ARRIVAL (memo §1.9), while each moved block stays internally
/// roster-ordered — claude(roster 0) above gemini(roster 2) even though
/// gemini's commit triggered the move and arrived first.
///
/// Weaker assertions this kills: "both blocks at the bottom" would accept
/// original-turn ordering (T1 below T2 reversed); "each block contiguous"
/// alone would accept the two blocks interleaved with each other.
#[test]
fn consecutive_old_turns_stack_in_answer_arrival_order() {
    let events = vec![
        event_at(
            1,
            "turn.accepted",
            json!({"agents":["claude","gemini"],"text":"old one","messageId":"q1","ledgerSeq":"1"}),
            "2026-08-02T14:00:00Z",
            "turn-1",
        ),
        event_at(
            2,
            "route.resolved",
            json!({"agents":["claude","gemini"]}),
            "2026-08-02T14:00:00Z",
            "turn-1",
        ),
        event_at(
            3,
            "lane.queued",
            json!({"laneId":"claude-lane","agent":"claude","expectedMessageId":"claude-message","origin":"operator","hopIndex":0}),
            "2026-08-02T14:00:00Z",
            "turn-1",
        ),
        event_at(
            4,
            "lane.queued",
            json!({"laneId":"gemini-lane","agent":"gemini","expectedMessageId":"gemini-message","origin":"operator","hopIndex":0}),
            "2026-08-02T14:00:00Z",
            "turn-1",
        ),
        event_at(
            5,
            "lane.started",
            json!({"laneId":"claude-lane","streamId":"claude-stream","agent":"claude"}),
            "2026-08-02T14:00:00Z",
            "turn-1",
        ),
        event_at(
            6,
            "lane.started",
            json!({"laneId":"gemini-lane","streamId":"gemini-stream","agent":"gemini"}),
            "2026-08-02T14:00:00Z",
            "turn-1",
        ),
        event_at(
            7,
            "turn.accepted",
            json!({"agents":["codex"],"text":"older two","messageId":"q2","ledgerSeq":"7"}),
            "2026-08-02T14:01:00Z",
            "turn-2",
        ),
        event_at(
            8,
            "route.resolved",
            json!({"agents":["codex"]}),
            "2026-08-02T14:01:00Z",
            "turn-2",
        ),
        event_at(
            9,
            "lane.queued",
            json!({"laneId":"codex-lane","agent":"codex","expectedMessageId":"codex-message","origin":"operator","hopIndex":0}),
            "2026-08-02T14:01:00Z",
            "turn-2",
        ),
        event_at(
            10,
            "lane.started",
            json!({"laneId":"codex-lane","streamId":"codex-stream","agent":"codex"}),
            "2026-08-02T14:01:00Z",
            "turn-2",
        ),
        event_at(
            11,
            "message.committed",
            json!({"laneId":"codex-lane","agent":"codex","messageId":"codex-message","ledgerSeq":"11","text":"codex answered","origin":"operator","hopIndex":0}),
            "2026-08-02T14:02:00Z",
            "turn-2",
        ),
        event_at(
            12,
            "message.committed",
            json!({"laneId":"gemini-lane","agent":"gemini","messageId":"gemini-message","ledgerSeq":"12","text":"gemini answered","origin":"operator","hopIndex":0}),
            "2026-08-02T14:03:00Z",
            "turn-1",
        ),
        event_at(
            13,
            "message.committed",
            json!({"laneId":"claude-lane","agent":"claude","messageId":"claude-message","ledgerSeq":"13","text":"claude answered","origin":"operator","hopIndex":0}),
            "2026-08-02T14:04:00Z",
            "turn-1",
        ),
    ];
    let (live, reducer) = live_room_from(events);
    let rebuilt = RoomScrollback::from_reducer(&reducer);
    let order = rendered_row_order(&live);

    assert_eq!(
        order,
        rendered_row_order(&rebuilt),
        "arrival-order stacking must rebuild identically"
    );

    // Turn-2 was never displaced (its own prompt precedes its first draw),
    // so codex stays in chronological place; turn-1's whole block stacks
    // BELOW it, in arrival order, internally roster-ordered, each answer
    // carrying its own reference to the same 5:00 PM question.
    let arrow = room_secondary(RoomSecondaryGlyph::HopArrow);
    let reference = format!("{arrow} answering your 5:00 PM message");
    let you = RoomIdentity::You.glyph();
    let claude = RoomIdentity::Claude.glyph();
    let codex = RoomIdentity::Codex.glyph();
    let gemini = RoomIdentity::Gemini.glyph();
    assert_eq!(
        order,
        vec![
            format!("{you} you · 5:00 PM"),
            "old one".to_owned(),
            format!("{you} you · 5:01 PM"),
            "older two".to_owned(),
            format!("{codex} codex · 5:02 PM"),
            "codex answered".to_owned(),
            reference.clone(),
            format!("{claude} claude · 5:04 PM"),
            "claude answered".to_owned(),
            reference.clone(),
            format!("{gemini} gemini · 5:03 PM"),
            "gemini answered".to_owned(),
        ],
        "tail reads T2 then T1 by arrival, T1 internally in roster order, \
             one reference per answer"
    );
}

/// §1.8's second half plus §1.9 together: a turn already relocated moves
/// AGAIN when a second answer of the same turn commits, gaining only its own
/// new reference — no duplicated rows, no duplicated prior references, and
/// whatever prompts arrived since stay ABOVE the re-moved block.
///
/// Shares its fixture with the interleaving falsifier below deliberately:
/// the same history must satisfy both contracts, and two readings of one
/// fixture cannot drift apart.
#[test]
fn a_second_answer_from_a_moved_turn_moves_it_again_without_duplicates() {
    let (live, reducer) = live_room_from(interleaved_relocation_history());
    let order = rendered_row_order(&live);

    let arrow = room_secondary(RoomSecondaryGlyph::HopArrow);
    let reference = format!("{arrow} answering your 6:00 PM message");
    assert_eq!(
        order.iter().filter(|row| **row == reference).count(),
        2,
        "one reference PER QUALIFYING ANSWER (two answers), never one per \
             move (three moves happened) nor one per turn: {order:?}"
    );
    for body in ["claude answered", "gemini answered"] {
        assert_eq!(
            order.iter().filter(|row| row.contains(body)).count(),
            1,
            "{body} must not duplicate across the re-moves: {order:?}"
        );
    }
    for agent in ["claude", "gemini"] {
        assert_eq!(
            order
                .iter()
                .filter(|row| row.contains(agent) && row.contains("· "))
                .count(),
            1,
            "{agent}'s header must not duplicate across the re-moves: {order:?}"
        );
    }
    // The re-moved block ends below everything that has arrived, prompts
    // included, still internally roster-ordered.
    let q3_idx = position_of(&order, "third question");
    let claude_header = header_index_of(&order, "claude");
    let gemini_header = header_index_of(&order, "gemini");
    assert!(
        q3_idx < claude_header && claude_header < gemini_header,
        "the re-moved block lands below the newest prompt in roster order: \
             {order:?}"
    );
    assert_eq!(
        order,
        rendered_row_order(&RoomScrollback::from_reducer(&reducer)),
        "and the double move rebuilds identically"
    );
}

/// The replay-interleaving falsifier (memo §2 site 4 / required scenario).
/// `Q1 → lane start → Q2 → commit → Q3` must finish
/// `Q1, Q2, relocated-T1, Q3` on BOTH paths.
///
/// This is the test that kills a post-build "move everything at the end"
/// pass: such a pass would hoist the relocated block beneath Q3 on the
/// rebuild, because it acts after ALL rows exist rather than at the commit's
/// own position in the sorted replay. It also kills blind global tail
/// appends during rebuild: gemini's commit arrives at sequence 10, AFTER Q3
/// (sequence 9) exists, and its rows must join the relocated block ABOVE
/// Q3, not fall off the bottom.
///
/// Why the synthetic action is needed at all: `DurableRow::replay_seq`
/// remaps the committed answer onto its LANE'S FIRST-DRAW sequence (FL-141),
/// so in pure replay order the answer materializes at sequence 5 — before
/// the displacing prompt at 7 is even drawn. Only a separate action keyed at
/// the REAL commit sequence (8), ranked after same-sequence row creation,
/// gives the rebuild a step where the live path's trigger exists.
#[test]
fn replay_interleaving_finishes_q1_q2_relocated_t1_q3() {
    let (live, reducer) = live_room_from(interleaved_relocation_history());
    let order = rendered_row_order(&live);

    let arrow = room_secondary(RoomSecondaryGlyph::HopArrow);
    let reference = format!("{arrow} answering your 6:00 PM message");
    let you = RoomIdentity::You.glyph();
    let claude = RoomIdentity::Claude.glyph();
    let gemini = RoomIdentity::Gemini.glyph();
    assert_eq!(
        order,
        vec![
            format!("{you} you · 6:00 PM"),
            "first question".to_owned(),
            format!("{you} you · 6:01 PM"),
            "second question".to_owned(),
            format!("{you} you · 6:03 PM"),
            "third question".to_owned(),
            reference.clone(),
            format!("{claude} claude · 6:02 PM"),
            "claude answered".to_owned(),
            reference.clone(),
            format!("{gemini} gemini · 6:04 PM"),
            "gemini answered".to_owned(),
        ],
        "the relocated turn sits between the second and third questions on \
             BOTH paths, in arrival order, references before their own \
             answers"
    );
    assert_eq!(
        order,
        rendered_row_order(&RoomScrollback::from_reducer(&reducer)),
        "the rebuild must interleave the relocation AT THE COMMIT SEQUENCE — \
             an after-all-rows pass would hoist the block under Q3 and this \
             equality would fail"
    );
}

/// Shared fixture for the two tests above: turn-1 runs claude and gemini,
/// both start (first draws at sequences 5 and 6), the second prompt arrives
/// at 7, claude commits at 8 (displacing the whole turn), a THIRD prompt
/// arrives at 9, and gemini commits at 10 — moving the turn a second time,
/// from underneath an already-newer prompt.
fn interleaved_relocation_history() -> Vec<RoomEvent> {
    vec![
        event_at(
            1,
            "turn.accepted",
            json!({"agents":["claude","gemini"],"text":"first question","messageId":"q1","ledgerSeq":"1"}),
            "2026-08-02T15:00:00Z",
            "turn-1",
        ),
        event_at(
            2,
            "route.resolved",
            json!({"agents":["claude","gemini"]}),
            "2026-08-02T15:00:00Z",
            "turn-1",
        ),
        event_at(
            3,
            "lane.queued",
            json!({"laneId":"claude-lane","agent":"claude","expectedMessageId":"claude-message","origin":"operator","hopIndex":0}),
            "2026-08-02T15:00:00Z",
            "turn-1",
        ),
        event_at(
            4,
            "lane.queued",
            json!({"laneId":"gemini-lane","agent":"gemini","expectedMessageId":"gemini-message","origin":"operator","hopIndex":0}),
            "2026-08-02T15:00:00Z",
            "turn-1",
        ),
        event_at(
            5,
            "lane.started",
            json!({"laneId":"claude-lane","streamId":"claude-stream","agent":"claude"}),
            "2026-08-02T15:00:00Z",
            "turn-1",
        ),
        event_at(
            6,
            "lane.started",
            json!({"laneId":"gemini-lane","streamId":"gemini-stream","agent":"gemini"}),
            "2026-08-02T15:00:00Z",
            "turn-1",
        ),
        event_at(
            7,
            "turn.accepted",
            json!({"agents":["claude"],"text":"second question","messageId":"q2","ledgerSeq":"7"}),
            "2026-08-02T15:01:00Z",
            "turn-2",
        ),
        event_at(
            8,
            "message.committed",
            json!({"laneId":"claude-lane","agent":"claude","messageId":"claude-message","ledgerSeq":"8","text":"claude answered","origin":"operator","hopIndex":0}),
            "2026-08-02T15:02:00Z",
            "turn-1",
        ),
        event_at(
            9,
            "turn.accepted",
            json!({"agents":["codex"],"text":"third question","messageId":"q3","ledgerSeq":"9"}),
            "2026-08-02T15:03:00Z",
            "turn-3",
        ),
        event_at(
            10,
            "message.committed",
            json!({"laneId":"gemini-lane","agent":"gemini","messageId":"gemini-message","ledgerSeq":"10","text":"gemini answered","origin":"operator","hopIndex":0}),
            "2026-08-02T15:04:00Z",
            "turn-1",
        ),
    ]
}

/// [PIN] The already-tail case (memo §2): when every lane of the answering
/// turn FIRST DRAWS after the later prompt, the block is already where the
/// predicate would put it — it must not move and must gain NO back-reference.
///
/// Passing by definition today (nothing relocates); it becomes load-bearing
/// the moment relocation exists, and its mutation proof — loosening the
/// predicate to fire on this shape — is quoted in the report after GREEN.
#[test]
fn an_already_tail_answer_neither_moves_nor_gains_a_reference() {
    let events = vec![
        event_at(
            1,
            "turn.accepted",
            json!({"agents":["claude"],"text":"old question","messageId":"q1","ledgerSeq":"1"}),
            "2026-08-02T16:00:00Z",
            "turn-1",
        ),
        event_at(
            2,
            "route.resolved",
            json!({"agents":["claude"]}),
            "2026-08-02T16:00:00Z",
            "turn-1",
        ),
        event_at(
            3,
            "lane.queued",
            json!({"laneId":"claude-lane","agent":"claude","expectedMessageId":"claude-message","origin":"operator","hopIndex":0}),
            "2026-08-02T16:00:00Z",
            "turn-1",
        ),
        event_at(
            4,
            "turn.accepted",
            json!({"agents":["codex"],"text":"newer question","messageId":"q2","ledgerSeq":"4"}),
            "2026-08-02T16:01:00Z",
            "turn-2",
        ),
        event_at(
            5,
            "lane.started",
            json!({"laneId":"claude-lane","streamId":"claude-stream","agent":"claude"}),
            "2026-08-02T16:01:30Z",
            "turn-1",
        ),
        event_at(
            6,
            "message.committed",
            json!({"laneId":"claude-lane","agent":"claude","messageId":"claude-message","ledgerSeq":"6","text":"claude answered","origin":"operator","hopIndex":0}),
            "2026-08-02T16:02:00Z",
            "turn-1",
        ),
    ];
    let (live, reducer) = live_room_from(events);
    let rebuilt = RoomScrollback::from_reducer(&reducer);
    let order = rendered_row_order(&live);

    assert_eq!(order, rendered_row_order(&rebuilt));
    let you = RoomIdentity::You.glyph();
    let claude = RoomIdentity::Claude.glyph();
    assert_eq!(
        order,
        vec![
            format!("{you} you · 7:00 PM"),
            "old question".to_owned(),
            format!("{you} you · 7:01 PM"),
            "newer question".to_owned(),
            format!("{claude} claude · 7:02 PM"),
            "claude answered".to_owned(),
        ],
        "first draw AFTER the later prompt means already-tail: no move, and \
             the feed reads plain chronology"
    );
    assert!(
        !live.searchable_text().contains("answering your"),
        "an already-tail answer gains no back-reference: {order:?}"
    );
}

/// [PIN] memo §2 site 3: same-turn out-of-order COMMITS never relocate and
/// never gain references — settle order inside one turn is FL-141's own
/// jurisdiction and stays exactly as it reads today. Dies as a falsifier the
/// moment someone makes ANY commit displace: treating a sibling answer as
/// displacement would scramble this roster order, and the mutation proof
/// (predicate without its later-turn requirement) is quoted in the report
/// after GREEN.
#[test]
fn same_turn_out_of_order_commits_stay_roster_ordered_without_references() {
    let (live, reducer) = live_room_from(scripted_history(&[
        ("codex", "start"),
        ("claude", "start"),
        ("gemini", "start"),
        ("codex", "commit"),
        ("claude", "commit"),
        ("gemini", "commit"),
        ("codex", "complete"),
        ("claude", "complete"),
        ("gemini", "complete"),
    ]));
    let rebuilt = RoomScrollback::from_reducer(&reducer);
    let order = rendered_row_order(&live);

    assert_eq!(order, rendered_row_order(&rebuilt));
    assert_eq!(
        lane_row_order(&live.searchable_text()),
        vec!["claude", "codex", "gemini"],
        "commits landing codex→claude→gemini must not disturb the roster \
             read: {:?}",
        order
    );
    assert!(
        !live.searchable_text().contains("answering your"),
        "no same-turn commit may grow a back-reference: {order:?}"
    );
}

/// [PIN] memo §2 site 6: a turn that answers BEFORE any later prompt — the
/// overwhelmingly common shape — renders byte-for-byte what it renders
/// today: plain chronology, roster-ordered, zero reference rows. Written as
/// an exact vector so ANY added row (a stray reference, a spacer, a moved
/// header) fails it, and so the post-rebuild suite proves the feature is
/// silent in rooms it has nothing to say about.
#[test]
fn an_undisplaced_room_gains_no_back_reference_and_keeps_its_exact_rows() {
    let events = vec![
        event_at(
            1,
            "turn.accepted",
            json!({"agents":["claude","codex","gemini"],"text":"do the work","messageId":"operator-message","ledgerSeq":"1"}),
            "2026-08-02T17:00:00Z",
            "turn-1",
        ),
        event_at(
            2,
            "route.resolved",
            json!({"agents":["claude","codex","gemini"]}),
            "2026-08-02T17:00:00Z",
            "turn-1",
        ),
    ];
    let mut events = events;
    let lanes = [
        ("claude", "claude-lane", "claude-stream"),
        ("codex", "codex-lane", "codex-stream"),
        ("gemini", "gemini-lane", "gemini-stream"),
    ];
    let mut seq = 3;
    for (agent, lane, stream) in lanes {
        events.push(event_at(
            seq,
            "lane.queued",
            json!({"laneId":lane,"agent":agent,"expectedMessageId":format!("{agent}-message"),"origin":"operator","hopIndex":0}),
            "2026-08-02T17:00:00Z",
            "turn-1",
        ));
        seq += 1;
        events.push(event_at(
            seq,
            "lane.started",
            json!({"laneId":lane,"streamId":stream,"agent":agent}),
            "2026-08-02T17:00:00Z",
            "turn-1",
        ));
        seq += 1;
    }
    for (agent, lane, stream) in lanes {
        events.push(event_at(
            seq,
            "message.committed",
            json!({"laneId":lane,"agent":agent,"messageId":format!("{agent}-message"),"ledgerSeq":seq.to_string(),"text":format!("{agent} answered"),"origin":"operator","hopIndex":0}),
            "2026-08-02T17:01:00Z",
            "turn-1",
        ));
        seq += 1;
        events.push(event_at(
            seq,
            "lane.completed",
            json!({"laneId":lane,"streamId":stream,"agent":agent}),
            "2026-08-02T17:01:00Z",
            "turn-1",
        ));
        seq += 1;
    }

    let (live, reducer) = live_room_from(events);
    let rebuilt = RoomScrollback::from_reducer(&reducer);
    let order = rendered_row_order(&live);
    assert_eq!(order, rendered_row_order(&rebuilt));
    let you = RoomIdentity::You.glyph();
    let claude = RoomIdentity::Claude.glyph();
    let codex = RoomIdentity::Codex.glyph();
    let gemini = RoomIdentity::Gemini.glyph();
    assert_eq!(
        order,
        vec![
            format!("{you} you · 8:00 PM"),
            "do the work".to_owned(),
            format!("{claude} claude · 8:01 PM"),
            "claude answered".to_owned(),
            format!("{codex} codex · 8:01 PM"),
            "codex answered".to_owned(),
            format!("{gemini} gemini · 8:01 PM"),
            "gemini answered".to_owned(),
        ],
        "an undisplaced room keeps its exact historical rows"
    );
    assert!(
        !live.searchable_text().contains("answering your"),
        "and gains no back-reference: {order:?}"
    );
}

// ---------------------------------------------------------------------------
// SLICE D rebuild — BATCH 2: memo §2 sites 4, 5, 7, 8, 9, 18, 19 and the
// operator's own story.
//
// Batch 1 above asks WHERE rows land. This batch asks what the move does to
// IDENTITY — entry ids, display modes, cohesion, the viewport anchor, the
// selection — and where the predicate reads its facts from. The engine landed
// before these were written, so each one states what a weaker assertion would
// let pass AND names the mutation that proves it bites; the mutation outputs
// are quoted in the lane report.
// ---------------------------------------------------------------------------

/// One turn that draws early, runs two tools, and commits AFTER a second
/// turn's prompt arrives — the smallest history that displaces a block which
/// owns a folded steps row.
///
/// Sequences: first draw 4, terminal steps 5 and 6, streamed text 7, the
/// later operator prompt 8, the commit 9. `4 < 8 < 9` satisfies the
/// predicate exactly once, so anything that moves here moved because of the
/// cross-turn prompt and not because of settle order.
///
/// Local wall time is UTC+3 in this suite (see
/// `three_lane_displacement_history`), so `13:00:00Z` reads `4:00 PM`.
fn displaced_steps_history() -> Vec<RoomEvent> {
    const TURN_ONE_TIME: &str = "2026-08-02T13:00:00Z";
    const PROMPT_TWO_TIME: &str = "2026-08-02T13:01:00Z";
    const COMMIT_TIME: &str = "2026-08-02T13:02:00Z";
    let mut events = vec![
        event_at(
            1,
            "turn.accepted",
            json!({"agents":["claude"],"text":"do the work","messageId":"operator-message","ledgerSeq":"1"}),
            TURN_ONE_TIME,
            "turn-1",
        ),
        event_at(
            2,
            "route.resolved",
            json!({"agents":["claude"]}),
            TURN_ONE_TIME,
            "turn-1",
        ),
        event_at(
            3,
            "lane.queued",
            json!({"laneId":"claude-lane","agent":"claude","expectedMessageId":"claude-message","origin":"operator","hopIndex":0}),
            TURN_ONE_TIME,
            "turn-1",
        ),
        event_at(
            4,
            "lane.started",
            json!({"laneId":"claude-lane","streamId":"claude-stream","agent":"claude"}),
            TURN_ONE_TIME,
            "turn-1",
        ),
    ];
    for index in 0..2u64 {
        events.push(event_at(
            5 + index,
            "lane.activity",
            json!({
                "laneId": "claude-lane",
                "streamId": "claude-stream",
                "agent": "claude",
                "toolCallId": format!("tool-{index}"),
                "update": "tool_call",
                "title": format!("step {index}"),
                "status": "completed",
            }),
            TURN_ONE_TIME,
            "turn-1",
        ));
    }
    events.push(event_at(
        7,
        "lane.chunk",
        json!({
            "laneId":"claude-lane","streamId":"claude-stream","agent":"claude",
            "streamSeq":"1","chunkIndex":0,"channel":"assistant","text":"claude answered",
        }),
        TURN_ONE_TIME,
        "turn-1",
    ));
    events.push(event_at(
        8,
        "turn.accepted",
        json!({"agents":["codex"],"text":"hurry up","messageId":"second-prompt","ledgerSeq":"8"}),
        PROMPT_TWO_TIME,
        "turn-2",
    ));
    events.push(event_at(
        9,
        "message.committed",
        json!({"laneId":"claude-lane","agent":"claude","messageId":"claude-message","ledgerSeq":"9","text":"claude answered","origin":"operator","hopIndex":0}),
        COMMIT_TIME,
        "turn-1",
    ));
    events
}

/// Every entry in the feed as `(id, display mode)`, top to bottom — the
/// identity ledger sites 7 and 9 compare across a move.
fn entry_identities(room: &RoomScrollback) -> Vec<(EntryId, DisplayMode)> {
    (0..room.state.len())
        .filter_map(|index| room.state.entry(index))
        .map(|entry| (entry.id, entry.display_mode()))
        .collect()
}

/// Which adjacent pairs of entries the renderer treats as one visually
/// contiguous block — cohesion, read off the entries themselves rather than
/// inferred from blank rows in a dump.
fn cohesion_runs(room: &RoomScrollback) -> Vec<(EntryId, EntryId)> {
    (0..room.state.len().saturating_sub(1))
        .filter_map(|index| {
            let this = room.state.entry(index)?;
            let next = room.state.entry(index + 1)?;
            this.is_visually_contiguous_with(next)
                .then_some((this.id, next.id))
        })
        .collect()
}

/// Which turns the room has actually MOVED, read off the registry rather than
/// inferred from row order — sorted, because the registry is a `HashMap`.
///
/// A "did not relocate" pin that only reads rendered rows is weak wherever
/// the pre-existing placement of a lane row already resembles a move; this
/// answers the question the flag itself decides.
fn room_relocated_turns(room: &RoomScrollback) -> Vec<String> {
    let mut turns: Vec<String> = room
        .turn_blocks
        .iter()
        .filter(|(_, block)| block.relocated)
        .map(|(turn, _)| turn.clone())
        .collect();
    turns.sort();
    turns
}

/// The id of the first entry with any part of itself on screen: the row the
/// operator's eye is anchored to.
fn viewport_top_entry(room: &RoomScrollback, area: ratatui::layout::Rect) -> Option<EntryId> {
    (0..room.state.len()).find_map(|index| {
        room.state
            .entry_screen_area(index, area)
            .and(room.state.entry(index))
            .map(|entry| entry.id)
    })
}

/// One painted row's symbols, for a cell-level pin that does not depend on
/// the whole frame.
fn painted_row(buffer: &ratatui::buffer::Buffer, y: u16, width: u16) -> String {
    (0..width)
        .map(|x| {
            buffer
                .cell((x, y))
                .expect("every cell is inside the area")
                .symbol()
                .to_owned()
        })
        .collect()
}

/// memo §2 site 4 — the rebuild replays the relocation through its SYNTHETIC
/// commit-sequence action and lands row-for-row where the live room did,
/// back-reference included and at the same index.
///
/// What a weaker assertion would let pass: comparing the two row SETS, or
/// only asserting that both contain a reference row, is satisfied by a
/// rebuild that appends the reference in the wrong place — or by a rebuild
/// that never relocates at all but happens to draw the same rows in the
/// arrival order the reducer stores them in. Both paths are pinned to one
/// explicit vector, and the reference's INDEX is compared as a number so a
/// row that drifted one place still fails.
#[test]
fn a_rebuilt_room_shows_the_same_back_reference_in_the_same_place() {
    let _theme = pin_theme();
    let (live, reducer) = live_room_from(displaced_steps_history());
    let rebuilt = RoomScrollback::from_reducer(&reducer);

    let live_order = rendered_row_order(&live);
    let rebuilt_order = rendered_row_order(&rebuilt);
    assert_eq!(
        live_order, rebuilt_order,
        "the rebuild must reproduce the live room row for row"
    );

    let you = RoomIdentity::You.glyph();
    let claude = RoomIdentity::Claude.glyph();
    let arrow = room_secondary(RoomSecondaryGlyph::HopArrow);
    let reference = format!("{arrow} answering your 4:00 PM message");
    assert_eq!(
        live_order,
        vec![
            format!("{you} you · 4:00 PM"),
            "do the work".to_owned(),
            format!("{you} you · 4:01 PM"),
            "hurry up".to_owned(),
            reference.clone(),
            format!("{claude} claude · 4:02 PM"),
            "step 0".to_owned(),
            "step 1".to_owned(),
            format!("{check} 2 steps · 2m0s", check = check()),
            "claude answered".to_owned(),
        ],
        "live: both operator prompts stay in chronological place, then the \
         whole turn block — reference, header, C's folded steps rows, answer"
    );
    assert_eq!(
        position_of(&live_order, &reference),
        position_of(&rebuilt_order, &reference),
        "the reference must occupy the same index on both paths, not merely \
         exist on both"
    );
}

/// memo §2 site 5 — the displacement predicate is answered from REDUCER
/// state, never from what is currently on screen.
///
/// Construction: the later operator prompt is applied to the reducer ONLY.
/// The room never draws it, so a predicate that scanned the rendered feed
/// would find no later prompt and leave the answer where it was. A rendered
/// backend-failure row IS applied between the lane's first draw and the
/// commit, so "already at the tail" cannot explain a pass either — the block
/// has to travel past a row it did not own.
///
/// What a weaker assertion would let pass: asserting only that the
/// back-reference appeared would be satisfied by an implementation that
/// inserts the reference but never moves anything. The row order is pinned
/// too, so the block is proven to have crossed the failure row.
#[test]
fn displacement_is_decided_from_reducer_state_not_from_the_screen() {
    let _theme = pin_theme();
    let mut reducer = RoomReducer::new();
    let mut room = RoomScrollback::new();
    for next in displaced_steps_history().into_iter().take(4) {
        apply_live(&mut room, &mut reducer, next);
    }
    // The one event the ROOM never sees. Applied straight to the reducer, so
    // the state knows about turn-2 and the feed does not.
    let hidden_prompt = event_at(
        5,
        "turn.accepted",
        json!({"agents":["codex"],"text":"hurry up","messageId":"second-prompt","ledgerSeq":"5"}),
        "2026-08-02T13:01:00Z",
        "turn-2",
    );
    reducer
        .apply(&hidden_prompt)
        .expect("the hidden prompt is reducer-valid");
    // A row the feed DOES draw, landing after the lane's first draw. Without
    // a real move the claude block stays above it.
    apply_live(
        &mut room,
        &mut reducer,
        event_at(
            6,
            "backend.failed",
            json!({"message":"backend unavailable","error":"timeout"}),
            "2026-08-02T13:01:30Z",
            "turn-2",
        ),
    );
    apply_live(
        &mut room,
        &mut reducer,
        event_at(
            7,
            "message.committed",
            json!({"laneId":"claude-lane","agent":"claude","messageId":"claude-message","ledgerSeq":"7","text":"claude answered","origin":"operator","hopIndex":0}),
            "2026-08-02T13:02:00Z",
            "turn-1",
        ),
    );

    let order = rendered_row_order(&room);
    assert!(
        !order.iter().any(|row| row.contains("hurry up")),
        "the construction requires the later prompt to be OFF the feed: \
         {order:?}"
    );
    let arrow = room_secondary(RoomSecondaryGlyph::HopArrow);
    let reference = format!("{arrow} answering your 4:00 PM message");
    assert!(
        order.contains(&reference),
        "the predicate must fire on a prompt that exists only in the reducer: \
         {order:?}"
    );
    let failure_row = order
        .iter()
        .position(|row| row.contains("backend unavailable"))
        .unwrap_or_else(|| panic!("the backend failure row must be on screen: {order:?}"));
    assert!(
        position_of(&order, &reference) > failure_row,
        "the block must travel PAST the rendered failure row, not merely gain \
         a reference in place: {order:?}"
    );
}

/// memo §2 site 7 — a move is a move, not a rebuild. Every entry id, every
/// display mode and every cohesion pair survives it, including C's steps row
/// left EXPANDED by the operator before the relocation.
///
/// What a weaker assertion would let pass: comparing only the rendered text
/// is satisfied by an implementation that deletes the group and re-pushes
/// equivalent blocks — new ids, a steps row snapped back to Collapsed, and
/// every downstream seam (selection, the pill's `answer_groups[..].top`,
/// C's fold state) silently broken. Ids and modes are compared as VALUES,
/// and the expanded mode is asserted by name so a reset cannot hide behind a
/// row that happens to render the same at this width.
#[test]
fn relocation_preserves_every_entry_id_and_every_display_mode() {
    let _theme = pin_theme();
    let mut reducer = RoomReducer::new();
    let mut room = RoomScrollback::new();
    let events = displaced_steps_history();
    // Everything up to and including the later prompt: the block is drawn,
    // its steps row exists, and nothing has relocated yet.
    for next in events.iter().take(8) {
        apply_live(&mut room, &mut reducer, next.clone());
    }
    room.select_steps_entry("claude-stream");
    room.toggle_fold_selected();
    assert_eq!(
        room.steps_display_mode("claude-stream"),
        Some(DisplayMode::Expanded),
        "the operator opened the steps row before the move"
    );
    let steps_id = room
        .steps_entry_id_for_stream("claude-stream")
        .expect("the terminal steps created an entry");
    let before = entry_identities(&room);
    let before_cohesion = cohesion_runs(&room);

    apply_live(
        &mut room,
        &mut reducer,
        events.last().expect("the commit is the last event").clone(),
    );

    let after = entry_identities(&room);
    assert_eq!(
        before.len() + 1,
        after.len(),
        "the move adds exactly one row — the back-reference — and removes none"
    );
    let before_ids: std::collections::HashSet<EntryId> = before.iter().map(|(id, _)| *id).collect();
    let after_ids: std::collections::HashSet<EntryId> = after.iter().map(|(id, _)| *id).collect();
    assert!(
        before_ids.is_subset(&after_ids),
        "every id that existed before the move still exists after it"
    );
    let before_modes: std::collections::HashMap<EntryId, DisplayMode> =
        before.iter().copied().collect();
    for (id, mode) in &after {
        if let Some(was) = before_modes.get(id) {
            assert_eq!(
                was, mode,
                "entry {id:?} changed display mode across the relocation"
            );
        }
    }
    assert_eq!(
        room.steps_entry_id_for_stream("claude-stream"),
        Some(steps_id),
        "the steps row travelled behind the same id"
    );
    assert_eq!(
        room.steps_display_mode("claude-stream"),
        Some(DisplayMode::Expanded),
        "and the operator's expand survived the move"
    );
    let after_cohesion = cohesion_runs(&room);
    for pair in &before_cohesion {
        assert!(
            after_cohesion.contains(pair),
            "cohesion pair {pair:?} was broken by the relocation: \
             {after_cohesion:?}"
        );
    }
}

/// memo §2 site 8 — a manually scrolled viewport never follows a relocation
/// to the bottom. Two cases, because the design answers them differently
/// (memo §1.7 step 7 and §3):
///
/// - the anchored row is NOT in the moved block: identity and cells unchanged;
/// - the anchored row IS in the moved block: the content the operator was
///   looking at has legitimately left this position, so the viewport
///   re-anchors to the first SURVIVING row at the vacated index. It does not
///   chase the block down, and follow mode stays off.
///
/// The assertion is on the viewport-top entry's identity and on the cells it
/// paints, never on the whole `scroll_info()` tuple: the back-reference is a
/// deliberate new row and changes total height, so a tuple compare would fail
/// for the one reason the design intends.
///
/// What a weaker assertion would let pass: checking only `scroll_offset` is
/// satisfied by an implementation whose offset survives while the content
/// under it slides by a row — the operator's eye is on an ENTRY, not on an
/// offset. Checking only "the offset is not the bottom" would be satisfied by
/// a viewport that jumped somewhere else arbitrary. Case B therefore names the
/// exact survivor it must land on, and asserts it is not the relocated answer.
#[test]
fn a_scrolled_up_viewport_does_not_jump_when_an_answer_relocates() {
    let _theme = pin_theme();
    let area = ratatui::layout::Rect::new(0, 0, 60, 4);

    // Case A — anchored above the moved block.
    let mut reducer = RoomReducer::new();
    let mut room = RoomScrollback::new();
    let events = displaced_steps_history();
    for next in events.iter().take(8) {
        apply_live(&mut room, &mut reducer, next.clone());
    }
    // A short viewport so there is somewhere to scroll to, and one render to
    // build the layout cache the anchor and `entry_screen_area` both need.
    let mut buffer = ratatui::buffer::Buffer::empty(area);
    let _ = room.render(area, &mut buffer);
    // All the way up: the top row is the operator's FIRST prompt, which the
    // move never touches.
    room.scroll_up(12);
    let mut buffer = ratatui::buffer::Buffer::empty(area);
    let _ = room.render(area, &mut buffer);
    let top_before = viewport_top_entry(&room, area).expect("the viewport shows something");
    let row_before = painted_row(&buffer, 0, area.width);
    let moved_block: Vec<EntryId> = room.ordered_block_ids("turn-1");
    assert!(
        !moved_block.contains(&top_before),
        "case A requires the anchored row to be OUTSIDE the block that moves"
    );

    apply_live(
        &mut room,
        &mut reducer,
        events.last().expect("the commit is the last event").clone(),
    );
    let mut buffer = ratatui::buffer::Buffer::empty(area);
    let _ = room.render(area, &mut buffer);
    assert_eq!(
        viewport_top_entry(&room, area),
        Some(top_before),
        "an anchor above the moved block keeps its identity"
    );
    assert_eq!(
        painted_row(&buffer, 0, area.width),
        row_before,
        "and paints the same cells"
    );
    assert!(
        room.searchable_text().contains("answering your"),
        "case A is only meaningful because the relocation happened"
    );

    // Case B — anchored INSIDE the moved block.
    let mut reducer = RoomReducer::new();
    let mut room = RoomScrollback::new();
    for next in events.iter().take(8) {
        apply_live(&mut room, &mut reducer, next.clone());
    }
    let mut buffer = ratatui::buffer::Buffer::empty(area);
    let _ = room.render(area, &mut buffer);
    room.scroll_up(2);
    let mut buffer = ratatui::buffer::Buffer::empty(area);
    let _ = room.render(area, &mut buffer);
    let top_before = viewport_top_entry(&room, area).expect("the viewport shows something");
    let block = room.ordered_block_ids("turn-1");
    assert!(
        block.contains(&top_before),
        "case B requires the anchored row to be INSIDE the block that moves"
    );
    // The row that will slide into the vacated position: the first entry
    // below the whole block, read before the move.
    let vacated_index = block
        .iter()
        .filter_map(|id| room.state.index_of_id(*id))
        .min()
        .expect("the block is in the feed");
    let survivor = (0..room.state.len())
        .filter_map(|index| room.state.entry(index))
        .find(|entry| {
            !block.contains(&entry.id) && {
                room.state
                    .index_of_id(entry.id)
                    .is_some_and(|index| index > vacated_index)
            }
        })
        .map(|entry| entry.id)
        .expect("something survives below the moved block");

    apply_live(
        &mut room,
        &mut reducer,
        events.last().expect("the commit is the last event").clone(),
    );
    let mut buffer = ratatui::buffer::Buffer::empty(area);
    let _ = room.render(area, &mut buffer);

    let top_after = viewport_top_entry(&room, area).expect("the viewport still shows something");
    assert_eq!(
        top_after, survivor,
        "the viewport re-anchors to the first surviving row at the vacated \
         index (memo §3), rather than following the block down"
    );
    let answer_id = room
        .entry_id_for_content("claude-message")
        .expect("the committed answer has an entry");
    assert_ne!(
        top_after, answer_id,
        "and it emphatically does not chase the relocated answer to the bottom"
    );
    let (offset, _, total) = room.state.scroll_info();
    assert!(
        offset + usize::from(area.height) < total,
        "the operator is still scrolled up — content remains below them: \
         offset {offset}, height {}, total {total}",
        area.height
    );
}

/// memo §2 site 9 — the selection follows the ENTRY, not the index, when a
/// relocation crosses it.
///
/// `move_group_to_end` records the selected id before the move and re-resolves
/// it afterwards (steps 3 and 8). `remove_entry` clamps an index instead, and
/// that difference is the whole point of this site.
///
/// What a weaker assertion would let pass: asserting `selected.is_some()`, or
/// that the index is unchanged, is satisfied by an implementation that left
/// the index alone while the content beneath it slid — which would silently
/// select a different row. The id is resolved through the state and compared,
/// and the index is asserted to have MOVED so the case cannot go vacuous.
#[test]
fn selection_survives_a_relocation_that_crosses_it() {
    let _theme = pin_theme();
    let mut reducer = RoomReducer::new();
    let mut room = RoomScrollback::new();
    let events = displaced_steps_history();
    for next in events.iter().take(8) {
        apply_live(&mut room, &mut reducer, next.clone());
    }
    // The newer prompt's own body row — NOT part of the block that is about
    // to move, and sitting below it, so the move must cross it.
    let target_index = room.state.len() - 1;
    let target_id = room
        .state
        .entry(target_index)
        .expect("the last entry exists")
        .id;
    room.select_entry(target_index);

    apply_live(
        &mut room,
        &mut reducer,
        events.last().expect("the commit is the last event").clone(),
    );

    let selected_index = room
        .state
        .selected()
        .expect("the selection survives the move");
    assert_eq!(
        room.state
            .entry(selected_index)
            .expect("the selected index resolves")
            .id,
        target_id,
        "the selection must still point at the SAME ENTRY after a block moved \
         across it, not at whatever slid into its old index"
    );
    assert_ne!(
        selected_index, target_index,
        "and this case is only meaningful because the index did move"
    );
}

/// memo §2 site 18 — an unresolvable source prompt omits the back-reference
/// ENTIRELY. Absent renders absent (spec §D.5, §3 rule 6): the answer still
/// relocates, it just carries no line.
///
/// What a weaker assertion would let pass: checking that the row does not say
/// one specific placeholder ("answering your earlier message") is satisfied by
/// any OTHER invented wording. This asserts the row COUNT is unchanged and
/// that no row contains "answering your" at all, so no substitute sentence
/// can pass.
#[test]
fn an_unresolvable_source_prompt_omits_the_back_reference() {
    let _theme = pin_theme();
    let mut reducer = RoomReducer::new();
    let mut room = RoomScrollback::new();
    for next in displaced_steps_history() {
        apply_live(&mut room, &mut reducer, next);
    }
    let before = rendered_row_order(&room);
    let arrow = room_secondary(RoomSecondaryGlyph::HopArrow);
    assert!(
        before.contains(&format!("{arrow} answering your 4:00 PM message")),
        "the resolvable case is this test's positive control: {before:?}"
    );

    // The same seam, asked for an answer whose source prompt cannot be
    // resolved. `ensure_back_reference` is the ONE writer of that row, so a
    // stamp it cannot read is the only shape a live room can reach.
    //
    // The room here is UNDISPLACED — the later prompt is dropped — so the
    // answer group exists with no reference on it yet and the guarded early
    // return for "already referenced" cannot make this vacuous.
    let mut unresolved = RoomScrollback::new();
    let mut unresolved_reducer = RoomReducer::new();
    let events = displaced_steps_history();
    for next in events.iter().take(7) {
        apply_live(&mut unresolved, &mut unresolved_reducer, next.clone());
    }
    apply_live(
        &mut unresolved,
        &mut unresolved_reducer,
        event_at(
            8,
            "message.committed",
            json!({"laneId":"claude-lane","agent":"claude","messageId":"claude-message","ledgerSeq":"8","text":"claude answered","origin":"operator","hopIndex":0}),
            "2026-08-02T13:02:00Z",
            "turn-1",
        ),
    );
    let rows_before = unresolved.state.len();
    // POSITIVE CONTROL, and it runs FIRST: an absent row proves nothing
    // unless the same call with a readable stamp is shown to write one. This
    // one is undone by hand so the omission cases below start from the same
    // feed the control did.
    unresolved.ensure_back_reference("claude-message", Some("2026-08-02T13:00:00Z"));
    assert_eq!(
        unresolved.state.len(),
        rows_before + 1,
        "control: a RESOLVABLE stamp writes exactly one row through this seam"
    );
    assert!(
        unresolved
            .searchable_text()
            .contains(&format!("{arrow} answering your 4:00 PM message")),
        "control: and it is the D.5 line"
    );

    // Rebuild the same undisplaced room, clean, for the omission cases.
    let mut unresolved = RoomScrollback::new();
    let mut unresolved_reducer = RoomReducer::new();
    for next in events.iter().take(7) {
        apply_live(&mut unresolved, &mut unresolved_reducer, next.clone());
    }
    apply_live(
        &mut unresolved,
        &mut unresolved_reducer,
        event_at(
            8,
            "message.committed",
            json!({"laneId":"claude-lane","agent":"claude","messageId":"claude-message","ledgerSeq":"8","text":"claude answered","origin":"operator","hopIndex":0}),
            "2026-08-02T13:02:00Z",
            "turn-1",
        ),
    );
    let rows_before = unresolved.state.len();
    unresolved.ensure_back_reference("claude-message", None);
    assert_eq!(
        unresolved.state.len(),
        rows_before,
        "an unresolvable source prompt must add NO row: {:?}",
        rendered_row_order(&unresolved)
    );
    assert!(
        !unresolved.searchable_text().contains("answering your"),
        "and must invent no sentence in its place: {:?}",
        rendered_row_order(&unresolved)
    );
    unresolved.ensure_back_reference("claude-message", Some("not-a-timestamp"));
    assert_eq!(
        unresolved.state.len(),
        rows_before,
        "an unparseable stamp is equally unresolvable: {:?}",
        rendered_row_order(&unresolved)
    );
    assert!(
        !unresolved.searchable_text().contains("answering your"),
        "and equally silent: {:?}",
        rendered_row_order(&unresolved)
    );
}

/// memo §2 site 19, first half — a lane that FAILS without answering moves
/// only because a SIBLING's answer relocated their shared turn, and its red
/// outcome row stays immediately below its own lane group on both paths.
///
/// What a weaker assertion would let pass: asserting the failure row is
/// somewhere in the tail block is satisfied by an implementation that appends
/// every failure at the feed's end — which is precisely what FL-141 was filed
/// against. The assertion is on POSITION relative to the relocated block and
/// to its own lane's rows, computed as indices, on each path separately.
///
/// ⚠ **RELATIVE order on both paths, deliberately not frame equality**
/// (spec §D.12 site 19). The two paths do not draw the same rows for a FAILED
/// lane and did not before slice D: the live room keeps the lane's streaming
/// header (`▲ gemini`), and the rebuild drops it, because
/// `replay_stream_for_lane` does not replay a failed lane's stream. Proved
/// foreign by running this shape against `6024ff2` with no slice-D code
/// present — the same asymmetry appears there, quoted in the lane report.
#[test]
fn a_failed_lanes_outcome_lands_below_its_own_group() {
    let _theme = pin_theme();
    let mut events = three_lane_displacement_history("claude");
    // gemini fails, without ever committing, after the cross-turn commit.
    events.push(event_at(
        11,
        "lane.failed",
        json!({"laneId":"gemini-lane","streamId":"gemini-stream","agent":"gemini","error":"provider rejected the request"}),
        "2026-08-02T13:03:00Z",
        "turn-1",
    ));
    let (live, reducer) = live_room_from(events);
    let rebuilt = RoomScrollback::from_reducer(&reducer);

    for (label, room) in [("live", &live), ("rebuilt", &rebuilt)] {
        let order = rendered_row_order(room);
        let failure = order
            .iter()
            .position(|row| row.contains("provider rejected the request"))
            .unwrap_or_else(|| panic!("[{label}] the failure row must render: {order:?}"));
        // The lane's own group starts at the first row naming it. Live that
        // is the streaming header `▲ gemini`; rebuilt the outcome row is the
        // lane's only row, so the group starts there. Either way the outcome
        // may not precede its own group.
        let gemini = RoomIdentity::Gemini.glyph();
        let gemini_group = position_of(&order, &format!("{gemini} gemini"));
        assert!(
            failure >= gemini_group,
            "[{label}] the outcome belongs inside its own lane's group, never \
             above it: {order:?}"
        );
        let claude_answer = position_of(&order, "claude answered");
        assert!(
            failure > claude_answer,
            "[{label}] and below the sibling answer that dragged the turn — \
             roster order, not settle order: {order:?}"
        );
        let newer_prompt = position_of(&order, "hurry up");
        assert!(
            failure > newer_prompt,
            "[{label}] and inside the relocated block, not stranded above the \
             newer prompt: {order:?}"
        );
        assert_eq!(
            failure,
            order.len() - 1,
            "[{label}] gemini is the last roster seat, so its outcome closes \
             the moved block: {order:?}"
        );
    }
}

/// memo §2 site 19, second half — a turn whose ONLY late terminal event is a
/// FAILURE never relocates. The ruling is about answers (memo §3); a
/// failure-only move would be unruled product expansion.
///
/// What a weaker assertion would let pass: asserting the failure row's text
/// is present says nothing about position, and asserting only that the
/// searchable text lacks "answering your" would be satisfied by a room that
/// moved the block silently. The LANE'S OWN HEADER is pinned above the newer
/// prompt, which is the observable a relocation would destroy — a move takes
/// the whole block, header first.
///
/// ⚠ **The outcome row's own position is NOT this test's subject, and it is
/// not slice D's.** At `6024ff2`, with no slice-D code present, this exact
/// history already places a last-roster lane's terminal row at the feed's end
/// (`place_lane_block` appends when the lane has no higher-roster sibling) and
/// already disagrees with its own rebuild about it. Both halves reproduce at
/// base; the outputs are quoted in the lane report. Pinning that here would
/// pin a defect this slice may not touch.
#[test]
fn a_failure_only_old_turn_never_relocates() {
    let _theme = pin_theme();
    let events = vec![
        event_at(
            1,
            "turn.accepted",
            json!({"agents":["claude"],"text":"do the work","messageId":"operator-message","ledgerSeq":"1"}),
            "2026-08-02T13:00:00Z",
            "turn-1",
        ),
        event_at(
            2,
            "route.resolved",
            json!({"agents":["claude"]}),
            "2026-08-02T13:00:00Z",
            "turn-1",
        ),
        event_at(
            3,
            "lane.queued",
            json!({"laneId":"claude-lane","agent":"claude","expectedMessageId":"claude-message","origin":"operator","hopIndex":0}),
            "2026-08-02T13:00:00Z",
            "turn-1",
        ),
        event_at(
            4,
            "lane.started",
            json!({"laneId":"claude-lane","streamId":"claude-stream","agent":"claude"}),
            "2026-08-02T13:00:00Z",
            "turn-1",
        ),
        event_at(
            5,
            "turn.accepted",
            json!({"agents":["codex"],"text":"hurry up","messageId":"second-prompt","ledgerSeq":"5"}),
            "2026-08-02T13:01:00Z",
            "turn-2",
        ),
        event_at(
            6,
            "lane.failed",
            json!({"laneId":"claude-lane","streamId":"claude-stream","agent":"claude","error":"provider rejected the request"}),
            "2026-08-02T13:02:00Z",
            "turn-1",
        ),
    ];
    let (live, reducer) = live_room_from(events);
    let rebuilt = RoomScrollback::from_reducer(&reducer);
    for (label, room) in [("live", &live), ("rebuilt", &rebuilt)] {
        let order = rendered_row_order(room);
        assert!(
            !order.iter().any(|row| row.contains("answering your")),
            "[{label}] a failure-only turn gains no back-reference: {order:?}"
        );
    }
    let order = rendered_row_order(&live);
    let claude = RoomIdentity::Claude.glyph();
    let lane_header = position_of(&order, &format!("{claude} claude"));
    let later_prompt = position_of(&order, "hurry up");
    assert!(
        lane_header < later_prompt,
        "the failed lane's block was never moved: its header stays ABOVE the \
         newer prompt, where FL-141 put it: {order:?}"
    );
    assert_eq!(
        room_relocated_turns(&live),
        Vec::<String>::new(),
        "and no turn was marked relocated: {order:?}"
    );
}

/// The operator's own story, memo §2: agent A starts turn 1; turns 2 and 3
/// run with other agents and answer; A commits last. A's whole turn-1 block
/// must be the FINAL block, carrying its back-reference, live and rebuilt.
///
/// What a weaker assertion would let pass: asserting A's answer is below
/// turn 3's prompt is satisfied by an implementation that moves the answer
/// alone and strands A's header above it. The exact whole-feed vector is
/// pinned, so the reference, the header and the body have to travel together,
/// land after turn 3's own answer, and leave all three operator prompts in
/// chronological place.
#[test]
fn the_operators_story_puts_the_slow_first_turn_last() {
    let _theme = pin_theme();
    let events = vec![
        event_at(
            1,
            "turn.accepted",
            json!({"agents":["claude"],"text":"first question","messageId":"q1","ledgerSeq":"1"}),
            "2026-08-02T13:00:00Z",
            "turn-1",
        ),
        event_at(
            2,
            "route.resolved",
            json!({"agents":["claude"]}),
            "2026-08-02T13:00:00Z",
            "turn-1",
        ),
        event_at(
            3,
            "lane.queued",
            json!({"laneId":"claude-lane","agent":"claude","expectedMessageId":"claude-message","origin":"operator","hopIndex":0}),
            "2026-08-02T13:00:00Z",
            "turn-1",
        ),
        event_at(
            4,
            "lane.started",
            json!({"laneId":"claude-lane","streamId":"claude-stream","agent":"claude"}),
            "2026-08-02T13:00:00Z",
            "turn-1",
        ),
        event_at(
            5,
            "turn.accepted",
            json!({"agents":["codex"],"text":"second question","messageId":"q2","ledgerSeq":"5"}),
            "2026-08-02T13:01:00Z",
            "turn-2",
        ),
        event_at(
            6,
            "route.resolved",
            json!({"agents":["codex"]}),
            "2026-08-02T13:01:00Z",
            "turn-2",
        ),
        event_at(
            7,
            "lane.queued",
            json!({"laneId":"codex-lane","agent":"codex","expectedMessageId":"codex-message","origin":"operator","hopIndex":0}),
            "2026-08-02T13:01:00Z",
            "turn-2",
        ),
        event_at(
            8,
            "lane.started",
            json!({"laneId":"codex-lane","streamId":"codex-stream","agent":"codex"}),
            "2026-08-02T13:01:00Z",
            "turn-2",
        ),
        event_at(
            9,
            "message.committed",
            json!({"laneId":"codex-lane","agent":"codex","messageId":"codex-message","ledgerSeq":"9","text":"codex answered","origin":"operator","hopIndex":0}),
            "2026-08-02T13:01:30Z",
            "turn-2",
        ),
        event_at(
            10,
            "lane.completed",
            json!({"laneId":"codex-lane","streamId":"codex-stream","agent":"codex"}),
            "2026-08-02T13:01:30Z",
            "turn-2",
        ),
        event_at(
            11,
            "turn.accepted",
            json!({"agents":["gemini"],"text":"third question","messageId":"q3","ledgerSeq":"11"}),
            "2026-08-02T13:02:00Z",
            "turn-3",
        ),
        event_at(
            12,
            "route.resolved",
            json!({"agents":["gemini"]}),
            "2026-08-02T13:02:00Z",
            "turn-3",
        ),
        event_at(
            13,
            "lane.queued",
            json!({"laneId":"gemini-lane","agent":"gemini","expectedMessageId":"gemini-message","origin":"operator","hopIndex":0}),
            "2026-08-02T13:02:00Z",
            "turn-3",
        ),
        event_at(
            14,
            "lane.started",
            json!({"laneId":"gemini-lane","streamId":"gemini-stream","agent":"gemini"}),
            "2026-08-02T13:02:00Z",
            "turn-3",
        ),
        event_at(
            15,
            "message.committed",
            json!({"laneId":"gemini-lane","agent":"gemini","messageId":"gemini-message","ledgerSeq":"15","text":"gemini answered","origin":"operator","hopIndex":0}),
            "2026-08-02T13:02:30Z",
            "turn-3",
        ),
        event_at(
            16,
            "lane.completed",
            json!({"laneId":"gemini-lane","streamId":"gemini-stream","agent":"gemini"}),
            "2026-08-02T13:02:30Z",
            "turn-3",
        ),
        event_at(
            17,
            "message.committed",
            json!({"laneId":"claude-lane","agent":"claude","messageId":"claude-message","ledgerSeq":"17","text":"claude answered at last","origin":"operator","hopIndex":0}),
            "2026-08-02T13:03:00Z",
            "turn-1",
        ),
    ];
    let (live, reducer) = live_room_from(events);
    let rebuilt = RoomScrollback::from_reducer(&reducer);
    let order = rendered_row_order(&live);
    assert_eq!(
        order,
        rendered_row_order(&rebuilt),
        "the operator's story must read the same after a reload"
    );

    let you = RoomIdentity::You.glyph();
    let claude = RoomIdentity::Claude.glyph();
    let codex = RoomIdentity::Codex.glyph();
    let gemini = RoomIdentity::Gemini.glyph();
    let arrow = room_secondary(RoomSecondaryGlyph::HopArrow);
    assert_eq!(
        order,
        vec![
            format!("{you} you · 4:00 PM"),
            "first question".to_owned(),
            format!("{you} you · 4:01 PM"),
            "second question".to_owned(),
            format!("{codex} codex · 4:01 PM"),
            "codex answered".to_owned(),
            format!("{you} you · 4:02 PM"),
            "third question".to_owned(),
            format!("{gemini} gemini · 4:02 PM"),
            "gemini answered".to_owned(),
            format!("{arrow} answering your 4:00 PM message"),
            format!("{claude} claude · 4:03 PM"),
            "claude answered at last".to_owned(),
        ],
        "the slow first turn's whole block is the LAST block, naming the \
         prompt it answers; every operator prompt stayed put"
    );
}

// ---------------------------------------------------------------------------
// FL-141's replay keying, pinned where slice D nearly lost it.
//
// Slice D needed a synthetic relocation step keyed on the COMMIT's sequence
// (memo §1.10). The first implementation got there by keying the transcript
// ROW on the commit too, which is a different fact and the exact one FL-141
// exists to correct: a lane-bound row replays where the LIVE room first DREW
// that lane, never where its answer settled. The two keys belong to two steps
// and are computed separately.
//
// Neither of these tests needs relocation to fail. They assert only that a
// reloaded room renders what the live one rendered — the property this whole
// slice claims — and they are the two shapes the lane's own suite could not
// see. Both were RED at `9147933`; the outputs are quoted in the fix-round
// report.
// ---------------------------------------------------------------------------

/// `Q1` → claude starts → `Q2` → codex starts → claude commits (displaced,
/// relocates) → codex commits. The NEWER turn's lane is already on screen when
/// the older answer relocates beneath it.
fn newer_lane_streaming_history() -> Vec<RoomEvent> {
    vec![
        event_at(
            1,
            "turn.accepted",
            json!({"agents":["claude"],"text":"Q1","messageId":"q1","ledgerSeq":"1"}),
            "2026-08-02T15:04:00Z",
            "turn-1",
        ),
        event_at(
            2,
            "route.resolved",
            json!({"agents":["claude"]}),
            "2026-08-02T15:04:00Z",
            "turn-1",
        ),
        event_at(
            3,
            "lane.queued",
            json!({"laneId":"lane-claude","agent":"claude","expectedMessageId":"m-claude","origin":"operator","hopIndex":0}),
            "2026-08-02T15:04:00Z",
            "turn-1",
        ),
        event_at(
            4,
            "lane.started",
            json!({"laneId":"lane-claude","streamId":"stream-claude","agent":"claude"}),
            "2026-08-02T15:04:01Z",
            "turn-1",
        ),
        event_at(
            5,
            "turn.accepted",
            json!({"agents":["codex"],"text":"Q2","messageId":"q2","ledgerSeq":"5"}),
            "2026-08-02T15:05:00Z",
            "turn-2",
        ),
        event_at(
            6,
            "route.resolved",
            json!({"agents":["codex"]}),
            "2026-08-02T15:05:00Z",
            "turn-2",
        ),
        event_at(
            7,
            "lane.queued",
            json!({"laneId":"lane-codex","agent":"codex","expectedMessageId":"m-codex","origin":"operator","hopIndex":0}),
            "2026-08-02T15:05:00Z",
            "turn-2",
        ),
        event_at(
            8,
            "lane.started",
            json!({"laneId":"lane-codex","streamId":"stream-codex","agent":"codex"}),
            "2026-08-02T15:05:01Z",
            "turn-2",
        ),
        event_at(
            9,
            "message.committed",
            json!({"laneId":"lane-claude","agent":"claude","messageId":"m-claude","ledgerSeq":"9","text":"the late claude answer","origin":"operator","hopIndex":0}),
            "2026-08-02T15:06:00Z",
            "turn-1",
        ),
        event_at(
            10,
            "message.committed",
            json!({"laneId":"lane-codex","agent":"codex","messageId":"m-codex","ledgerSeq":"10","text":"the codex answer","origin":"operator","hopIndex":0}),
            "2026-08-02T15:06:10Z",
            "turn-2",
        ),
        event_at(
            11,
            "lane.completed",
            json!({"laneId":"lane-claude","streamId":"stream-claude","agent":"claude"}),
            "2026-08-02T15:06:20Z",
            "turn-1",
        ),
        event_at(
            12,
            "lane.completed",
            json!({"laneId":"lane-codex","streamId":"stream-codex","agent":"codex"}),
            "2026-08-02T15:06:21Z",
            "turn-2",
        ),
    ]
}

/// A lane that is ALREADY DRAWN when an older turn's answer relocates keeps
/// its seat on reload.
///
/// Live, codex drew its rows at sequence 8, before claude relocated at 9, so
/// claude's block lands beneath codex. A rebuild that keys claude's answer row
/// on its COMMIT has no codex row on screen yet when the relocation runs, so
/// claude's block moves into an empty tail and codex lands underneath it — the
/// two answers swap places across a reload.
///
/// What a weaker assertion would let pass: asserting that claude's answer is
/// below `Q2` on both paths is TRUE in both renders, because both put it after
/// the prompt. The defect is in the order of the two ANSWERS relative to each
/// other, so the whole feed is compared row for row.
#[test]
fn a_newer_streaming_lane_keeps_its_seat_when_an_older_answer_relocates() {
    let _theme = pin_theme();
    let mut reducer = RoomReducer::new();
    let mut room = RoomScrollback::new();
    for next in newer_lane_streaming_history() {
        apply_live(&mut room, &mut reducer, next);
    }
    let live = rendered_row_order(&room);
    let rebuilt = rendered_row_order(&RoomScrollback::from_reducer(&reducer));
    assert_eq!(
        live, rebuilt,
        "a reloaded room must render what the live room rendered"
    );

    // Pinned explicitly as well as compared, so a future change that breaks
    // BOTH paths the same way cannot pass by agreeing with itself.
    let you = RoomIdentity::You.glyph();
    let claude = RoomIdentity::Claude.glyph();
    let codex = RoomIdentity::Codex.glyph();
    let arrow = room_secondary(RoomSecondaryGlyph::HopArrow);
    assert_eq!(
        live,
        vec![
            format!("{you} you · 6:04 PM"),
            "Q1".to_owned(),
            format!("{you} you · 6:05 PM"),
            "Q2".to_owned(),
            format!("{codex} codex · 6:06 PM"),
            "the codex answer".to_owned(),
            format!("{arrow} answering your 6:04 PM message"),
            format!("{claude} claude · 6:06 PM"),
            "the late claude answer".to_owned(),
        ],
        "the relocated block goes BELOW the rows that were already on screen \
         when it moved, and stays there on reload"
    );
}

/// A backend failure that lands while a lane streams, with NO later prompt —
/// so slice D's predicate never fires and nothing relocates.
fn failure_between_start_and_commit_history() -> Vec<RoomEvent> {
    vec![
        event_at(
            1,
            "turn.accepted",
            json!({"agents":["claude"],"text":"Q1","messageId":"q1","ledgerSeq":"1"}),
            "2026-08-02T15:04:00Z",
            "turn-1",
        ),
        event_at(
            2,
            "route.resolved",
            json!({"agents":["claude"]}),
            "2026-08-02T15:04:00Z",
            "turn-1",
        ),
        event_at(
            3,
            "lane.queued",
            json!({"laneId":"lane-claude","agent":"claude","expectedMessageId":"m-claude","origin":"operator","hopIndex":0}),
            "2026-08-02T15:04:00Z",
            "turn-1",
        ),
        event_at(
            4,
            "lane.started",
            json!({"laneId":"lane-claude","streamId":"stream-claude","agent":"claude"}),
            "2026-08-02T15:04:01Z",
            "turn-1",
        ),
        event_at(
            5,
            "backend.failed",
            json!({"message":"backend unavailable","error":"timeout"}),
            "2026-08-02T15:04:30Z",
            "turn-1",
        ),
        event_at(
            6,
            "message.committed",
            json!({"laneId":"lane-claude","agent":"claude","messageId":"m-claude","ledgerSeq":"6","text":"the answer","origin":"operator","hopIndex":0}),
            "2026-08-02T15:05:00Z",
            "turn-1",
        ),
        event_at(
            7,
            "lane.completed",
            json!({"laneId":"lane-claude","streamId":"stream-claude","agent":"claude"}),
            "2026-08-02T15:05:01Z",
            "turn-1",
        ),
    ]
}

/// A chronological row keeps its seat across a reload, with no relocation
/// anywhere in the history.
///
/// `push_backend_failure` and `push_hop` both APPEND, so their position is
/// decided purely by replay ORDER. Memo §4 requires them to stay
/// chronological. Live, the failure at sequence 5 lands after claude's block,
/// which was drawn at 4; a rebuild that keys the answer row on its commit (6)
/// replays the failure first and the answer beneath it.
///
/// This case is GREEN at `9f03907` — it is a straight regression check on the
/// base contract, and it needs none of slice D's own machinery to fail.
///
/// What a weaker assertion would let pass: checking that both rows are
/// PRESENT on both paths passes in both renders. Only the order separates them.
#[test]
fn a_backend_failure_that_lands_mid_stream_keeps_its_seat_on_reload() {
    let _theme = pin_theme();
    let mut reducer = RoomReducer::new();
    let mut room = RoomScrollback::new();
    for next in failure_between_start_and_commit_history() {
        apply_live(&mut room, &mut reducer, next);
    }
    let live = rendered_row_order(&room);
    let rebuilt = rendered_row_order(&RoomScrollback::from_reducer(&reducer));
    assert_eq!(
        live, rebuilt,
        "a reloaded room must render what the live room rendered"
    );

    let you = RoomIdentity::You.glyph();
    let claude = RoomIdentity::Claude.glyph();
    assert_eq!(
        live,
        vec![
            format!("{you} you · 6:04 PM"),
            "Q1".to_owned(),
            format!("{claude} claude · 6:05 PM"),
            "the answer".to_owned(),
            "backend failed — backend unavailable: timeout".to_owned(),
        ],
        "the failure row stays where it arrived, below the lane that was \
         already drawing when it landed"
    );
    assert!(
        !live.iter().any(|row| row.contains("answering your")),
        "and no relocation happened here at all: {live:?}"
    );
}

/// The room's answer to a terminal event that arrives BEFORE its own commit.
///
/// `forget_settled_turn` drops a turn's whole block registry once no lane of
/// it is still drawing, and `relocate_if_displaced` needs that registry to
/// find what to move. Today the two cannot collide, and the reason has been
/// living in the OTHER half of the repo: `src/room/room-engine.ts` emits
/// `message.committed` and flushes before it emits the terminal event.
///
/// This pins the defence that actually holds, measured rather than assumed:
/// the REDUCER refuses the inverted order outright, so it never reaches the
/// presentation layer at all. The refusal is recorded with its exact message,
/// so a protocol change that starts accepting it fails here and sends the
/// reader to `relocate_if_displaced` instead of quietly widening what the room
/// can be handed.
///
/// The second half then proves the room is safe even if that refusal ever
/// goes away, by driving the collision directly: a turn whose registry has
/// been dropped must paint NO back-reference, because a reference row above a
/// block that did not move is a sentence about something that did not happen.
///
/// What a weaker assertion would let pass: asserting only that the room does
/// not panic is satisfied by exactly that orphan row.
#[test]
fn a_terminal_event_that_beats_its_own_commit_paints_no_orphan_reference() {
    let _theme = pin_theme();
    let mut reducer = RoomReducer::new();
    let mut room = RoomScrollback::new();
    let events = displaced_steps_history();
    // Everything up to and including the later prompt: the block is drawn and
    // nothing has relocated yet.
    for next in events.iter().take(8) {
        apply_live(&mut room, &mut reducer, next.clone());
    }

    // THE INVERSION, offered to the reducer exactly as a host would send it.
    let completed = event_at(
        9,
        "lane.completed",
        json!({"laneId":"claude-lane","streamId":"claude-stream","agent":"claude"}),
        "2026-08-02T13:02:00Z",
        "turn-1",
    );
    let refusal = reducer
        .apply(&completed)
        .expect_err("the reducer must refuse a terminal event before its commit");
    assert!(
        format!("{refusal:?}").contains("lane.completed"),
        "the refusal must name the event it refused, so an operator-visible          host bug is diagnosable: {refusal:?}"
    );

    // The room never saw it, so the ordinary order still works afterwards —
    // the refusal is a rejection, not a wedged reducer.
    apply_live(
        &mut room,
        &mut reducer,
        events.last().expect("the commit is the last event").clone(),
    );
    let order = rendered_row_order(&room);
    let arrow = room_secondary(RoomSecondaryGlyph::HopArrow);
    assert!(
        order
            .iter()
            .any(|row| row.starts_with(&format!("{arrow} answering your"))),
        "and the normal path still relocates: {order:?}"
    );

    // SECOND HALF: the collision itself, forced. The registry is dropped out
    // from under a turn that then tries to relocate — the shape the host's
    // ordering is currently the only thing preventing.
    //
    // Every precondition is established deliberately, because each one has its
    // own early return and any of them would make this vacuous: the answer
    // group must EXIST (so it is committed first, undisplaced, and therefore
    // carries no reference yet), the displacement predicate must FIRE (so the
    // later prompt is applied to the reducer, and the commit sequence handed in
    // sits after it), and only THEN is the registry removed.
    let mut orphan_room = RoomScrollback::new();
    let mut orphan_reducer = RoomReducer::new();
    for next in events.iter().take(7) {
        apply_live(&mut orphan_room, &mut orphan_reducer, next.clone());
    }
    apply_live(
        &mut orphan_room,
        &mut orphan_reducer,
        event_at(
            8,
            "message.committed",
            json!({"laneId":"claude-lane","agent":"claude","messageId":"claude-message","ledgerSeq":"8","text":"claude answered","origin":"operator","hopIndex":0}),
            "2026-08-02T13:02:00Z",
            "turn-1",
        ),
    );
    assert!(
        orphan_room.answer_groups.contains_key("claude-message"),
        "precondition: the answer group exists"
    );
    assert!(
        !orphan_room.searchable_text().contains("answering your"),
        "precondition: and carries no reference yet"
    );
    orphan_reducer
        .apply(&event_at(
            9,
            "turn.accepted",
            json!({"agents":["codex"],"text":"hurry up","messageId":"second-prompt","ledgerSeq":"9"}),
            "2026-08-02T13:03:00Z",
            "turn-2",
        ))
        .expect("the later prompt is reducer-valid");
    assert!(
        super::relocation::displacement_prompt(&orphan_reducer, "turn-1", "10").is_some(),
        "precondition: the predicate fires, so the early return is not what          this case is measuring"
    );
    orphan_room.turn_blocks.remove("turn-1");
    let rows_before = orphan_room.state.len();
    orphan_room.relocate_if_displaced(&orphan_reducer, "turn-1", "claude-message", "10");
    assert_eq!(
        orphan_room.state.len(),
        rows_before,
        "with no block to move, NOTHING is written — least of all a reference          row naming a move that did not happen: {:?}",
        rendered_row_order(&orphan_room)
    );
    assert!(
        !orphan_room.searchable_text().contains("answering your"),
        "no orphan back-reference: {:?}",
        rendered_row_order(&orphan_room)
    );
}

/// A turn whose rows have already been printed into the terminal's own
/// scrollback is NOT relocated, and gains no back-reference either.
///
/// Memo §1.7 step 4. Text that has reached native scrollback cannot be
/// un-printed, so reordering it leaves the feed and the terminal disagreeing
/// about what the operator read. The room cannot reach this state today —
/// `mark_committed` is driven only by `crate::minimal`, which the room does
/// not use — but the move primitive lives on the shared `ScrollbackState`
/// where that pipeline does run.
///
/// The guard is at the CALLER, before anything is written, for the same
/// reason as the empty-registry case beside it: `move_group_to_end` refusing
/// the move is not enough on its own, because by then the back-reference row
/// has already been inserted and would be left explaining a move that did not
/// happen. The primitive's own `debug_assert` stays as a tripwire for any
/// other caller.
///
/// What a weaker assertion would let pass: checking only that the rows did not
/// move is satisfied by a feed that gained an orphan reference row and then
/// declined to move. Both are asserted.
#[test]
fn a_turn_already_printed_to_native_scrollback_is_not_relocated() {
    let _theme = pin_theme();
    let mut reducer = RoomReducer::new();
    let mut room = RoomScrollback::new();
    let events = displaced_steps_history();
    // Committed undisplaced first, so the answer group exists with no
    // reference on it — otherwise the dedup guard makes this vacuous.
    for next in events.iter().take(7) {
        apply_live(&mut room, &mut reducer, next.clone());
    }
    apply_live(
        &mut room,
        &mut reducer,
        event_at(
            8,
            "message.committed",
            json!({"laneId":"claude-lane","agent":"claude","messageId":"claude-message","ledgerSeq":"8","text":"claude answered","origin":"operator","hopIndex":0}),
            "2026-08-02T13:02:00Z",
            "turn-1",
        ),
    );
    reducer
        .apply(&event_at(
            9,
            "turn.accepted",
            json!({"agents":["codex"],"text":"hurry up","messageId":"second-prompt","ledgerSeq":"9"}),
            "2026-08-02T13:03:00Z",
            "turn-2",
        ))
        .expect("the later prompt is reducer-valid");
    assert!(
        super::relocation::displacement_prompt(&reducer, "turn-1", "10").is_some(),
        "precondition: the predicate fires, so the early return being measured          is the COMMITTED one"
    );

    let ids = room.ordered_block_ids("turn-1");
    assert!(!ids.is_empty(), "precondition: the block is registered");
    let first = room
        .state
        .index_of_id(ids[0])
        .expect("the block's first row is in the feed");
    room.state.mark_committed(first);
    let before = rendered_row_order(&room);

    room.relocate_if_displaced(&reducer, "turn-1", "claude-message", "10");

    assert_eq!(
        rendered_row_order(&room),
        before,
        "nothing moved and nothing was written"
    );
    assert!(
        !room.searchable_text().contains("answering your"),
        "least of all a reference row above a block that stayed put: {:?}",
        rendered_row_order(&room)
    );
}

// ---------------------------------------------------------------------------
// Lane MN — the memory notice. One quiet row, at the event's own place in the
// transcript, identical live and rebuilt, with the payload's `detail` nowhere
// on screen.
// ---------------------------------------------------------------------------

fn notice_history() -> Vec<RoomEvent> {
    vec![
        event(
            1,
            "turn.accepted",
            json!({"agents":["claude"],"text":"operator prompt","messageId":"operator-message","ledgerSeq":"1"}),
        ),
        event(2, "route.resolved", json!({"agents":["claude"]})),
        event(
            3,
            "room.notice",
            json!({
                "cause": "memory-compose-failed",
                "agent": "claude",
                "detail": "SQLITE_CORRUPT: the briefing exploded on disk"
            }),
        ),
        event(
            4,
            "lane.queued",
            json!({"laneId":"claude-lane","agent":"claude","expectedMessageId":"claude-message","origin":"operator","hopIndex":0}),
        ),
        event(
            5,
            "lane.started",
            json!({"laneId":"claude-lane","streamId":"claude-stream","agent":"claude"}),
        ),
        event(
            6,
            "message.committed",
            json!({"laneId":"claude-lane","agent":"claude","messageId":"claude-message","ledgerSeq":"2","text":"the answer arrived anyway","origin":"operator","hopIndex":0}),
        ),
        event(
            7,
            "lane.completed",
            json!({"laneId":"claude-lane","streamId":"claude-stream","agent":"claude"}),
        ),
    ]
}

#[test]
fn a_memory_notice_draws_exactly_one_row_and_a_reload_draws_it_in_the_same_place() {
    let _theme = pin_theme();
    let mut reducer = RoomReducer::new();
    let mut live = RoomScrollback::new();
    for next in notice_history() {
        apply_live(&mut live, &mut reducer, next);
    }
    let rebuilt = RoomScrollback::from_reducer(&reducer);

    let phrase = "memory briefing unavailable: the briefing could not be composed";
    for text in [live.searchable_text(), rebuilt.searchable_text()] {
        assert_eq!(
            matching_rows(&text, phrase).len(),
            1,
            "one condition is one row, live and rebuilt alike: {text}"
        );
        let notice = text.find(phrase).expect("the notice row is in the feed");
        let prompt = text
            .find("operator prompt")
            .expect("the prompt row is in the feed");
        let answer = text
            .find("the answer arrived anyway")
            .expect("the answer row is in the feed");
        assert!(
            prompt < notice && notice < answer,
            "the notice sits at its own event sequence, not at the end: {text}"
        );
    }

    // The whole point of the parity harness: the two feeds are the same text.
    assert_eq!(live.searchable_text(), rebuilt.searchable_text());
}

#[test]
fn the_notice_detail_never_reaches_a_painted_frame() {
    let _theme = pin_theme();
    let mut reducer = RoomReducer::new();
    let mut live = RoomScrollback::new();
    for next in notice_history() {
        apply_live(&mut live, &mut reducer, next);
    }
    let rebuilt = RoomScrollback::from_reducer(&reducer);

    for text in [live.searchable_text(), rebuilt.searchable_text()] {
        // The row has to BE there for its absence of detail to mean anything: without this the
        // assertions below pass on a feed that drew no notice at all.
        assert_eq!(
            matching_rows(
                &text,
                "memory briefing unavailable: the briefing could not be composed"
            )
            .len(),
            1,
            "precondition: the notice row is on screen: {text}"
        );
        assert!(
            !text.contains("SQLITE_CORRUPT"),
            "the detail is journal diagnostics and must never be painted: {text}"
        );
        assert!(
            !text.contains("exploded on disk"),
            "not in any fragment either: {text}"
        );
    }
    // Structural, not incidental: the reducer does not carry the detail at all, so no future
    // rendering change can start painting it by accident.
    let notice = reducer
        .room_notices()
        .next()
        .expect("the notice reached reducer state");
    assert_eq!(notice.cause, "memory-compose-failed");
    assert_eq!(notice.agent.as_deref(), Some("claude"));
}

#[test]
fn a_cause_from_a_newer_host_renders_the_generic_phrase_instead_of_vanishing() {
    let _theme = pin_theme();
    let mut reducer = RoomReducer::new();
    let mut live = RoomScrollback::new();
    apply_live(
        &mut live,
        &mut reducer,
        event(
            1,
            "room.notice",
            json!({"cause": "some-future-condition", "detail": "from a newer host"}),
        ),
    );

    let generic = "the host reported a condition this build does not recognize";
    let rebuilt = RoomScrollback::from_reducer(&reducer);
    for text in [live.searchable_text(), rebuilt.searchable_text()] {
        assert_eq!(matching_rows(&text, generic).len(), 1, "{text}");
        assert!(
            !text.contains("from a newer host"),
            "an unknown cause still never paints its detail: {text}"
        );
    }
    assert_eq!(live.searchable_text(), rebuilt.searchable_text());
}

// ---------------------------------------------------------------------------
// SL-A round 2 — the rebuild notice. Same shape as the memory notice above: one
// static, truthful row, live and rebuilt alike, with the ledger's own restored
// count nowhere on screen (that count is a journal fact, not a painted one —
// see the doc comment on `notice_phrase`'s `room-rebuilt-from-ledger` arm).
// ---------------------------------------------------------------------------

#[test]
fn a_rebuild_notice_draws_its_static_phrase_with_the_ledger_count_left_unpainted() {
    let _theme = pin_theme();
    let mut reducer = RoomReducer::new();
    let mut live = RoomScrollback::new();
    apply_live(
        &mut live,
        &mut reducer,
        event(
            1,
            "room.notice",
            json!({
                "cause": "room-rebuilt-from-ledger",
                "detail": "zer0: room chat-recovery-host was rebuilt from the evidence ledger: 3 messages restored to its transcript."
            }),
        ),
    );

    let phrase = "this room was rebuilt from the evidence ledger; messages that were missing from its transcript were restored";
    let rebuilt = RoomScrollback::from_reducer(&reducer);
    for text in [live.searchable_text(), rebuilt.searchable_text()] {
        assert_eq!(
            matching_rows(&text, phrase).len(),
            1,
            "one condition is one row, live and rebuilt alike: {text}"
        );
        assert!(
            !text.contains("3 messages restored"),
            "the restored COUNT is journal diagnostics and must never be painted: {text}"
        );
        assert!(
            !text.contains("chat-recovery-host"),
            "the session id in `detail` must never be painted either: {text}"
        );
    }
    assert_eq!(live.searchable_text(), rebuilt.searchable_text());
}

#[test]
fn every_known_cause_has_its_own_phrase_and_none_is_the_generic_one() {
    let generic = "the host reported a condition this build does not recognize";
    let causes = [
        "memory-db-open-failed",
        "memory-project-resolve-failed",
        "memory-compose-failed",
        "memory-cursor-failed",
        "memory-request-files-failed",
        "memory-failure-log-unwritable",
        "agy-conversation-lost",
        "room-rebuilt-from-ledger",
    ];
    let mut phrases = Vec::new();
    for cause in causes {
        let phrase = notice_phrase(cause);
        assert_ne!(phrase, generic, "{cause} fell through to the generic arm");
        assert!(!phrase.is_empty());
        phrases.push(phrase);
    }
    phrases.sort_unstable();
    let distinct = phrases.len();
    phrases.dedup();
    assert_eq!(
        phrases.len(),
        distinct,
        "two causes share a phrase, so the row cannot say which condition fired"
    );
}

#[test]
fn a_notice_with_an_oversized_or_missing_detail_never_becomes_a_row() {
    let envelope = |payload: serde_json::Value| {
        RoomEvent::from_value(json!({
            "protocol": "zer0.room",
            "version": 1,
            "sessionId": "scrollback-room",
            "eventSeq": "1",
            "eventId": "scrollback-1",
            "turnId": "scrollback-turn",
            "occurredAt": "2026-08-02T00:00:00Z",
            "type": "room.notice",
            "payload": payload,
        }))
    };
    assert!(
        envelope(json!({"cause": "memory-compose-failed"})).is_err(),
        "detail is required"
    );
    assert!(
        envelope(json!({"cause": "memory-compose-failed", "detail": "x".repeat(201)})).is_err(),
        "201 code points is over the bound"
    );
    assert!(
        envelope(json!({"cause": "memory-compose-failed", "detail": "x".repeat(200)})).is_ok(),
        "200 code points is exactly the bound"
    );
    assert!(
        envelope(json!({"cause": "memory-compose-failed", "detail": "\u{1f600}".repeat(200)}))
            .is_ok(),
        "the bound counts CODE POINTS, so 200 astral characters still fit"
    );
    assert!(
        envelope(json!({"cause": "", "detail": "d"})).is_err(),
        "an empty cause names nothing"
    );
    assert!(
        envelope(json!({"cause": "c", "detail": "d", "extra": 1})).is_err(),
        "unknown fields are refused like every other payload"
    );
}
