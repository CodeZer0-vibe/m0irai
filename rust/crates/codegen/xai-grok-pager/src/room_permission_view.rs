//! Room adapter for the pager's service-neutral permission presentation.
//!
//! The room host owns permission semantics. This adapter keeps the reducer's
//! FIFO order and sends either the original opaque option ID or one explicit
//! fail-closed denial back to that host.

use crossterm::event::{KeyCode, KeyEvent};
use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};
use zer0_room_protocol::RoomReducer;

use crate::room_theme::{RoomIdentity, RoomSecondaryGlyph, RoomTheme, room_secondary};
use crate::views::permission_presentation::{
    PermissionOption, PermissionOptionKind, PermissionViewState,
};
use crate::views::prompt_widget::PromptWidget;

/// A room permission response preserves the semantic distinction between an
/// exact provider option and an explicit local fail-closed denial.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RoomPermissionAction {
    SelectOption { ask_id: String, option_id: String },
    Deny { ask_id: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum LocalPermissionChoice {
    SelectOption(String),
    Deny,
}

struct ActivePermission {
    ask_id: String,
    agent: String,
    submitted: bool,
    focused: bool,
    view: PermissionViewState,
    choices: Vec<LocalPermissionChoice>,
    /// Provider-option indices actually painted in the latest frame. Numeric
    /// shortcuts may never approve a choice the operator cannot currently see.
    visible_choices: Vec<usize>,
}

/// One shared FIFO. The reducer remains authoritative: a resolved, timed-out,
/// or invalidated request disappears only after it leaves `pending_permissions`.
#[derive(Default)]
pub struct RoomPermissionView {
    active: Option<ActivePermission>,
}

impl RoomPermissionView {
    pub fn sync(&mut self, reducer: &RoomReducer, _prompt: &mut PromptWidget) {
        let pending = reducer.pending_permissions().collect::<Vec<_>>();
        if self
            .active
            .as_ref()
            .is_some_and(|active| pending.iter().any(|ask| ask.ask_id == active.ask_id))
        {
            return;
        }
        self.active.take();
        let Some(ask) = pending.first() else { return };

        let (options, choices) = if ask.options.is_empty() {
            (
                vec![PermissionOption {
                    // This ID is intentionally local-and-empty: only the
                    // semantic `Deny` choice may leave this adapter.
                    id: String::new(),
                    label: "Deny".into(),
                    detail: "The provider supplied no options; deny this request.".into(),
                    kind: PermissionOptionKind::RejectOnce,
                }],
                vec![LocalPermissionChoice::Deny],
            )
        } else {
            (
                ask.options
                    .iter()
                    .map(|option| PermissionOption {
                        id: option.option_id.clone(),
                        label: option
                            .name
                            .as_deref()
                            .map(|value| inert_permission_text(value, 120))
                            .or_else(|| {
                                option
                                    .kind
                                    .as_deref()
                                    .map(|value| inert_permission_text(value, 120))
                            })
                            .unwrap_or_else(|| "Choose".into()),
                        detail: option
                            .kind
                            .as_deref()
                            .map(|value| inert_permission_text(value, 120))
                            .unwrap_or_default(),
                        kind: PermissionOptionKind::from_wire_kind(option.kind.as_deref()),
                    })
                    .collect(),
                ask.options
                    .iter()
                    .map(|option| LocalPermissionChoice::SelectOption(option.option_id.clone()))
                    .collect(),
            )
        };
        let mut view = PermissionViewState::new(
            ask.ask_id.clone(),
            format!("{} needs your approval", ask.agent),
            options,
        );
        view.description = ask
            .tool_title
            .iter()
            .map(|title| inert_permission_text(title, 240))
            .collect();
        self.active = Some(ActivePermission {
            ask_id: ask.ask_id.clone(),
            agent: ask.agent.clone(),
            submitted: false,
            focused: false,
            view,
            choices,
            visible_choices: Vec::new(),
        });
    }

    /// Move the current cursor and return either the exact source option ID or
    /// the one explicit local denial allowed when the provider supplied none.
    pub fn handle_key(&mut self, key: &KeyEvent) -> Option<RoomPermissionAction> {
        let active = self.active.as_mut()?;
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => {
                active.view.active_idx = active.view.active_idx.saturating_sub(1);
            }
            KeyCode::Down | KeyCode::Char('j') => {
                let last = active.view.options.len().saturating_sub(1);
                active.view.active_idx = (active.view.active_idx + 1).min(last);
            }
            KeyCode::Enter | KeyCode::Char(' ') => return submit_active(active),
            _ => {}
        }
        None
    }

    /// Select a visible 1-based option while preserving the provider's opaque option ID.
    pub fn select_visible_digit(&mut self, digit: u8) -> Option<RoomPermissionAction> {
        let active = self.active.as_mut()?;
        let index = usize::from(digit.checked_sub(1)?);
        if !active.visible_choices.contains(&index) {
            return None;
        }
        active.view.active_idx = index;
        submit_active(active)
    }

    pub fn has_visible_digit(&self, digit: u8) -> bool {
        digit > 0
            && self
                .active
                .as_ref()
                .is_some_and(|active| active.visible_choices.contains(&usize::from(digit - 1)))
    }

    pub fn is_active(&self) -> bool {
        self.active.is_some()
    }

    pub fn has_pending_for(&self, agent: &str) -> bool {
        self.active
            .as_ref()
            .is_some_and(|active| active.agent == agent)
    }

    pub fn is_focused(&self) -> bool {
        self.active.as_ref().is_some_and(|active| active.focused)
    }

    pub fn focus_shelf(&mut self) -> bool {
        let Some(active) = self.active.as_mut() else {
            return false;
        };
        active.focused = true;
        true
    }

    pub fn focus_composer(&mut self) {
        if let Some(active) = self.active.as_mut() {
            active.focused = false;
        }
    }

    /// The shelf is deliberately bounded: a permission remains visible above
    /// the composer without replacing either the chronological feed or draft.
    pub fn height(&self, terminal_height: u16, content_width: u16) -> u16 {
        let Some(_active) = self.active.as_ref() else {
            return 0;
        };
        let _ = content_width;
        3.min(terminal_height.saturating_sub(3))
    }

    pub fn render(&mut self, area: Rect, buffer: &mut Buffer, tick: u64, reduced_motion: bool) {
        let Some(active) = self.active.as_mut() else {
            return;
        };
        active.visible_choices.clear();
        if area.width == 0 || area.height == 0 {
            return;
        }
        let theme = RoomTheme::current();
        buffer.set_style(area, Style::default().fg(theme.text).bg(theme.canvas));
        let divider = room_secondary(RoomSecondaryGlyph::Divider).repeat(area.width as usize);
        buffer.set_line(
            area.x,
            area.y,
            &Line::from(Span::styled(divider, Style::default().fg(theme.border))),
            area.width,
        );
        if area.height > 1 {
            let identity = identity_for_agent(&active.agent);
            let marker = room_secondary(RoomSecondaryGlyph::PermissionMarker);
            let mut title = vec![
                Span::styled(
                    format!("{marker} "),
                    Style::default().fg(theme.attention_at(tick, reduced_motion)),
                ),
                Span::styled(active.agent.clone(), Style::default().fg(identity.color())),
                Span::raw(" "),
                Span::styled(
                    "needs your approval",
                    Style::default()
                        .fg(theme.attention_at(tick, reduced_motion))
                        .add_modifier(Modifier::BOLD),
                ),
            ];
            if let Some(tool_title) = active.view.description.first() {
                let prefix_width = title
                    .iter()
                    .map(|span| UnicodeWidthStr::width(span.content.as_ref()))
                    .sum::<usize>();
                let available = area.width.saturating_sub(2) as usize;
                let detail_prefix = " — ";
                let detail = truncate_display_width(
                    tool_title,
                    available.saturating_sub(prefix_width + UnicodeWidthStr::width(detail_prefix)),
                );
                if !detail.is_empty() {
                    title.push(Span::styled(
                        format!("{detail_prefix}{detail}"),
                        Style::default().fg(theme.dim),
                    ));
                }
            }
            buffer.set_line(
                area.x + 1,
                area.y + 1,
                &Line::from(title),
                area.width.saturating_sub(2),
            );
        }
        if area.height > 2 {
            let mut options = Vec::new();
            let mut used = 0usize;
            let available = area.width.saturating_sub(2) as usize;
            // Once the shelf owns focus, keep the selected provider option in
            // view even when a narrow terminal cannot fit the whole row.
            let start = if active.focused {
                active
                    .view
                    .active_idx
                    .min(active.view.options.len().saturating_sub(1))
            } else {
                0
            };
            for (visible_index, (index, option)) in active
                .view
                .options
                .iter()
                .enumerate()
                .skip(start)
                .enumerate()
            {
                let gap = if visible_index == 0 { "" } else { "  " };
                let gap_width = UnicodeWidthStr::width(gap);
                let focus = if active.focused && index == active.view.active_idx {
                    room_secondary(RoomSecondaryGlyph::PermissionFocus)
                } else {
                    " "
                };
                let number = format!("[{}]", index + 1);
                let prefix_width =
                    UnicodeWidthStr::width(focus) + UnicodeWidthStr::width(number.as_str()) + 1;
                if used + gap_width + prefix_width > available {
                    break;
                }
                if index > 0 {
                    options.push(Span::raw(gap));
                }
                let number_style = Style::default().fg(theme.attention);
                options.push(Span::styled(focus.to_owned(), number_style));
                options.push(Span::styled(number, number_style));
                options.push(Span::raw(" "));
                let label_style = if active.focused && index == active.view.active_idx {
                    Style::default().fg(theme.text).add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(theme.dim)
                };
                let label = truncate_display_width(
                    &option_label(option),
                    available.saturating_sub(used + gap_width + prefix_width),
                );
                used += gap_width + prefix_width + UnicodeWidthStr::width(label.as_str());
                options.push(Span::styled(label, label_style));
                active.visible_choices.push(index);
            }
            buffer.set_line(
                area.x + 1,
                area.y + 2,
                &Line::from(options),
                area.width.saturating_sub(2),
            );
        }
    }
}

fn identity_for_agent(agent: &str) -> RoomIdentity {
    match agent {
        "claude" => RoomIdentity::Claude,
        "codex" => RoomIdentity::Codex,
        "gemini" => RoomIdentity::Gemini,
        _ => RoomIdentity::You,
    }
}

fn option_label(option: &PermissionOption) -> String {
    match option.kind {
        PermissionOptionKind::AllowOnce => "allow once".into(),
        PermissionOptionKind::AllowAlways => "always allow this".into(),
        PermissionOptionKind::RejectOnce | PermissionOptionKind::RejectAlways => "deny".into(),
        PermissionOptionKind::Other => option.label.clone(),
    }
}

fn submit_active(active: &mut ActivePermission) -> Option<RoomPermissionAction> {
    if active.submitted {
        return None;
    }
    if !active.visible_choices.contains(&active.view.active_idx) {
        return None;
    }
    let action = match active.choices.get(active.view.active_idx)? {
        LocalPermissionChoice::SelectOption(option_id) if !option_id.is_empty() => {
            RoomPermissionAction::SelectOption {
                ask_id: active.ask_id.clone(),
                option_id: option_id.clone(),
            }
        }
        LocalPermissionChoice::SelectOption(_) => return None,
        LocalPermissionChoice::Deny => RoomPermissionAction::Deny {
            ask_id: active.ask_id.clone(),
        },
    };
    active.submitted = true;
    Some(action)
}

fn truncate_display_width(value: &str, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    if UnicodeWidthStr::width(value) <= width {
        return value.to_owned();
    }
    let marker = room_secondary(RoomSecondaryGlyph::Ellipsis);
    let marker_width = UnicodeWidthStr::width(marker);
    if width <= marker_width {
        return marker.to_owned();
    }
    let mut output = String::new();
    let mut used = 0usize;
    for character in value.chars() {
        let character_width = UnicodeWidthChar::width(character).unwrap_or(0);
        if used + character_width + marker_width > width {
            break;
        }
        output.push(character);
        used += character_width;
    }
    format!("{output}{marker}")
}

fn inert_permission_text(value: &str, max_chars: usize) -> String {
    let mut output = String::new();
    let mut truncated = false;
    for (index, character) in value.chars().enumerate() {
        if index >= max_chars {
            truncated = true;
            break;
        }
        let code = character as u32;
        if code <= 0x1f || (0x7f..=0x9f).contains(&code) {
            output.push_str(&format!("\\x{code:02x}"));
        } else if matches!(
            code,
            0x061c
                | 0x200b..=0x200f
                | 0x202a..=0x202e
                | 0x2060
                | 0x2066..=0x2069
                | 0xfeff
        ) {
            output.push_str(&format!("\\u{code:04x}"));
        } else {
            output.push(character);
        }
    }
    if truncated {
        output.push_str(room_secondary(RoomSecondaryGlyph::Ellipsis));
    }
    output
}

#[cfg(all(test, feature = "room-runtime"))]
mod tests {
    use crossterm::event::{KeyCode, KeyEvent};
    use ratatui::{buffer::Buffer, layout::Rect, style::Color};
    use serde_json::json;
    use zer0_room_protocol::{RoomEvent, RoomReducer};

    use super::{
        ActivePermission, LocalPermissionChoice, RoomPermissionAction, RoomPermissionView,
        inert_permission_text, truncate_display_width,
    };
    use crate::room_theme::{RoomSecondaryGlyph, room_secondary};
    use crate::views::permission_presentation::{
        PermissionOption, PermissionOptionKind, PermissionViewState,
    };
    use crate::views::prompt_widget::PromptWidget;

    fn view_with_options(option_ids: &[&str]) -> RoomPermissionView {
        RoomPermissionView {
            active: Some(ActivePermission {
                ask_id: "ask-7".into(),
                agent: "codex".into(),
                submitted: false,
                focused: false,
                view: PermissionViewState::new(
                    "ask-7",
                    "Codex needs permission",
                    option_ids
                        .iter()
                        .map(|id| PermissionOption {
                            id: (*id).into(),
                            label: format!("label-{id}"),
                            detail: String::new(),
                            kind: PermissionOptionKind::Other,
                        })
                        .collect(),
                ),
                choices: option_ids
                    .iter()
                    .map(|id| LocalPermissionChoice::SelectOption((*id).into()))
                    .collect(),
                visible_choices: Vec::new(),
            }),
        }
    }

    fn render_for_input(view: &mut RoomPermissionView, width: u16) {
        let area = Rect::new(0, 0, width, 3);
        let mut buffer = Buffer::empty(area);
        view.render(area, &mut buffer, 0, false);
    }

    fn reducer_with_empty_options() -> RoomReducer {
        let mut reducer = RoomReducer::new();
        for (sequence, kind, payload) in [
            (
                1,
                "turn.accepted",
                json!({"agents":["codex"],"text":"operator","messageId":"operator-message","ledgerSeq":"1"}),
            ),
            (2, "route.resolved", json!({"agents":["codex"]})),
            (
                3,
                "lane.queued",
                json!({"laneId":"lane","agent":"codex","expectedMessageId":"message","origin":"operator","hopIndex":0}),
            ),
            (
                4,
                "lane.started",
                json!({"laneId":"lane","streamId":"stream","agent":"codex"}),
            ),
            (
                5,
                "permission.requested",
                json!({"askId":"empty-options","agent":"codex","toolTitle":"run sqlx migrate","options":[]}),
            ),
        ] {
            let event = RoomEvent::from_value(json!({
                "protocol":"zer0.room", "version":1, "sessionId":"permission-room",
                "eventSeq":sequence.to_string(), "eventId":format!("permission-{sequence}"),
                "turnId":"permission-turn", "occurredAt":"2026-08-02T00:00:00Z",
                "type":kind, "payload":payload,
            }))
            .expect("permission test event is protocol-valid");
            reducer
                .apply(&event)
                .expect("permission test event is reducer-valid");
        }
        reducer
    }

    #[test]
    fn permission_choice_preserves_option_id_order_and_fails_closed_for_empty_id() {
        let mut view = view_with_options(&["allow-once", "deny"]);
        render_for_input(&mut view, 80);
        assert_eq!(
            view.handle_key(&KeyEvent::from(KeyCode::Enter)),
            Some(RoomPermissionAction::SelectOption {
                ask_id: "ask-7".into(),
                option_id: "allow-once".into(),
            })
        );
        assert_eq!(view.handle_key(&KeyEvent::from(KeyCode::Enter)), None);

        let mut empty = view_with_options(&[""]);
        render_for_input(&mut empty, 80);
        assert_eq!(empty.handle_key(&KeyEvent::from(KeyCode::Enter)), None);
    }

    #[test]
    fn empty_provider_options_render_a_usable_local_deny() {
        let reducer = reducer_with_empty_options();
        let mut prompt = PromptWidget::new();
        let mut view = RoomPermissionView::default();
        view.sync(&reducer, &mut prompt);
        assert!(view.focus_shelf());

        let area = Rect::new(0, 0, 80, 12);
        let mut buffer = Buffer::empty(area);
        view.render(area, &mut buffer, 0, false);
        let rendered = buffer
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(rendered.contains("deny"));
        assert!(rendered.contains("needs your approval"));
        assert!(rendered.contains("run sqlx migrate"));
        assert_eq!(
            view.handle_key(&KeyEvent::from(KeyCode::Enter)),
            Some(RoomPermissionAction::Deny {
                ask_id: "empty-options".into(),
            }),
            "an empty provider option list must still expose a safe local denial",
        );
    }

    #[test]
    fn needs_you_marker_breathes_white_and_reduced_motion_freezes_it() {
        let reducer = reducer_with_empty_options();
        let mut prompt = PromptWidget::new();
        let mut view = RoomPermissionView::default();
        view.sync(&reducer, &mut prompt);
        let area = Rect::new(0, 0, 80, 3);

        let mut bright = Buffer::empty(area);
        view.render(area, &mut bright, 0, false);
        let marker = room_secondary(RoomSecondaryGlyph::PermissionMarker);
        assert!(
            bright
                .content
                .iter()
                .any(|cell| { cell.symbol() == marker && cell.fg == Color::Rgb(255, 255, 255) })
        );

        let mut dim = Buffer::empty(area);
        view.render(area, &mut dim, 5, false);
        assert!(
            dim.content
                .iter()
                .any(|cell| { cell.symbol() == marker && cell.fg == Color::Rgb(96, 98, 101) })
        );

        let mut reduced = Buffer::empty(area);
        view.render(area, &mut reduced, 5, true);
        assert!(
            reduced
                .content
                .iter()
                .any(|cell| { cell.symbol() == marker && cell.fg == Color::Rgb(255, 255, 255) })
        );
    }

    #[test]
    fn source_contract_uses_room_attention_tokens_and_never_question_view() {
        let source = include_str!("room_permission_view.rs");
        for required in [
            "PermissionViewState",
            "needs your approval",
            "attention_at",
            "pending_permissions()",
            "option.option_id.clone()",
            "RoomPermissionAction::Deny",
        ] {
            assert!(
                source.contains(required),
                "missing permission bridge contract: {required}"
            );
        }
        let prohibited = ["Question", "View"].concat();
        assert!(!source.contains(&prohibited));
        let _ = RoomPermissionView::is_active as fn(&RoomPermissionView) -> bool;
    }

    #[test]
    fn shelf_focus_is_explicit_and_composer_focus_does_not_submit_an_option() {
        let mut view = view_with_options(&["allow-once", "deny"]);
        assert!(!view.is_focused());
        assert!(view.focus_shelf());
        assert!(view.is_focused());
        view.focus_composer();
        assert!(!view.is_focused());
        // The runtime routes Enter to the composer while this is false; only
        // explicit shelf focus may invoke this opaque-ID adapter.
        assert!(view.focus_shelf());
        render_for_input(&mut view, 80);
        assert_eq!(
            view.handle_key(&KeyEvent::from(KeyCode::Enter)),
            Some(RoomPermissionAction::SelectOption {
                ask_id: "ask-7".into(),
                option_id: "allow-once".into(),
            })
        );
    }

    #[test]
    fn visible_digit_selects_the_original_opaque_option_and_out_of_range_does_not_submit() {
        let mut view = view_with_options(&["opaque-a", "opaque-b", "opaque-c"]);
        render_for_input(&mut view, 80);
        assert!(view.has_visible_digit(3));
        assert!(!view.has_visible_digit(4));
        assert_eq!(view.select_visible_digit(4), None);
        assert_eq!(
            view.select_visible_digit(2),
            Some(RoomPermissionAction::SelectOption {
                ask_id: "ask-7".into(),
                option_id: "opaque-b".into(),
            })
        );
        assert_eq!(view.select_visible_digit(1), None, "one response only");
    }

    #[test]
    fn narrow_shelf_never_accepts_an_option_until_that_option_is_painted() {
        let mut view = view_with_options(&["opaque-a", "opaque-b", "opaque-c"]);
        render_for_input(&mut view, 14);
        assert!(view.has_visible_digit(1));
        assert!(!view.has_visible_digit(2));
        assert_eq!(view.select_visible_digit(2), None);

        assert!(view.focus_shelf());
        assert_eq!(view.handle_key(&KeyEvent::from(KeyCode::Down)), None);
        render_for_input(&mut view, 14);
        assert!(view.has_visible_digit(2));
        assert_eq!(
            view.select_visible_digit(2),
            Some(RoomPermissionAction::SelectOption {
                ask_id: "ask-7".into(),
                option_id: "opaque-b".into(),
            })
        );
    }

    #[test]
    fn permission_render_truncates_fullwidth_provider_text_without_overrunning_the_shelf() {
        let mut view = view_with_options(&["opaque-a", "opaque-b"]);
        let active = view.active.as_mut().unwrap();
        active.view.description = vec!["审批数据库迁移审批数据库迁移".into()];
        active.view.options[0].kind = PermissionOptionKind::Other;
        active.view.options[0].label = "允许执行非常非常长的操作".into();
        active.focused = true;
        let area = Rect::new(0, 0, 24, 3);
        let backing = Rect::new(0, 0, 28, 3);
        let mut buffer = Buffer::empty(backing);
        for y in 0..backing.height {
            for x in area.width..backing.width {
                buffer[(x, y)].set_symbol("X");
            }
        }
        view.render(area, &mut buffer, 0, false);
        for y in 0..area.height {
            assert!(
                (area.width..backing.width).all(|x| buffer[(x, y)].symbol() == "X"),
                "full-width provider text must not paint outside the shelf"
            );
        }
        let clipped = truncate_display_width("允许执行非常非常长的操作", 8);
        assert!(unicode_width::UnicodeWidthStr::width(clipped.as_str()) <= 8);
        assert!(!clipped.is_empty());
        assert!(clipped.ends_with(room_secondary(RoomSecondaryGlyph::Ellipsis)));
        assert!(
            buffer.content.iter().any(|cell| cell.symbol() == "["),
            "numbered choice remains visible"
        );
    }

    #[test]
    fn provider_permission_text_cannot_emit_controls_or_hidden_directionality() {
        let hostile = "run\u{1b}[31m\u{202e}txt.exe\u{200b}";
        let rendered = inert_permission_text(hostile, 240);
        assert_eq!(rendered, "run\\x1b[31m\\u202etxt.exe\\u200b");
        assert!(!rendered.chars().any(char::is_control));
    }
}
