//! Service-neutral permission presentation.
//!
//! This owns the reusable part of the pager permission overlay: its FIFO-ready
//! state, height calculation, option ordering, and ratatui rendering.  ACP and
//! workspace-specific request parsing, response senders, bash highlighting,
//! and persistence remain in the Grok runtime adapter.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use crate::theme::Theme;

/// Interaction mode for the permission overlay.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionFocus {
    Options,
    FollowupInput,
}

/// The presentation-relevant disposition of a permission option.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionOptionKind {
    AllowOnce,
    AllowAlways,
    RejectOnce,
    RejectAlways,
    Other,
}

impl PermissionOptionKind {
    /// Map room wire labels conservatively. Unknown labels remain `Other` and
    /// never acquire an approval/rejection meaning locally.
    pub fn from_wire_kind(value: Option<&str>) -> Self {
        match value
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .replace(['-', ' '], "_")
            .as_str()
        {
            "allow_once" | "approve_once" | "approved" => Self::AllowOnce,
            "allow_always" | "approve_always" => Self::AllowAlways,
            "reject_once" | "deny_once" | "denied" => Self::RejectOnce,
            "reject_always" | "deny_always" => Self::RejectAlways,
            _ => Self::Other,
        }
    }
}

/// An ordered, opaque response option. `id` is deliberately never inferred
/// from the label or kind: callers must round-trip it unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionOption {
    pub id: String,
    pub label: String,
    pub detail: String,
    pub kind: PermissionOptionKind,
}

/// Service-neutral permission overlay state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionViewState {
    pub request_id: String,
    pub focus: PermissionFocus,
    pub options: Vec<PermissionOption>,
    pub active_idx: usize,
    pub title: String,
    pub description: Vec<String>,
    pub args_expanded: bool,
    pub desc_scroll: u16,
    pub provenance: Option<String>,
    pub options_area_height: usize,
    pub options_scroll_offset: usize,
}

impl PermissionViewState {
    pub fn new(
        request_id: impl Into<String>,
        title: impl Into<String>,
        options: Vec<PermissionOption>,
    ) -> Self {
        Self {
            request_id: request_id.into(),
            focus: PermissionFocus::Options,
            options,
            active_idx: 0,
            title: title.into(),
            description: Vec::new(),
            args_expanded: false,
            desc_scroll: 0,
            provenance: None,
            options_area_height: 0,
            options_scroll_offset: 0,
        }
    }

    /// Return the selected opaque ID only when it is present. This is the
    /// fail-closed handoff boundary for hosts that own the response protocol.
    pub fn selected_option_id(&self) -> Option<&str> {
        self.options
            .get(self.active_idx)
            .map(|option| option.id.as_str())
            .filter(|id| !id.trim().is_empty())
    }
}

/// Result from rendering the permission view, telling the caller where to
/// render an inline followup editor when it supports that mode.
pub struct PermissionRenderResult {
    pub inline_prompt: Option<InlinePromptArea>,
}

/// Layout info for an inline followup prompt.
pub struct InlinePromptArea {
    pub text_x: u16,
    pub y: u16,
    pub text_w: u16,
    pub content_x: u16,
    pub content_w: u16,
}

pub const MCP_ARGS_COLLAPSED_ROWS: usize = 5;

/// Width available for inline prompt text given the full area width.
pub fn inline_text_width(area_width: u16) -> u16 {
    area_width.saturating_sub(3 + 8)
}

pub fn permission_view_height(state: &PermissionViewState, screen_h: u16, content_w: usize) -> u16 {
    let chrome = permission_chrome_height(state, content_w);
    let total = chrome
        .saturating_add(state.options.len() as u16)
        .saturating_add(1);
    if state.args_expanded {
        return total.min(screen_h);
    }
    total.min(
        (screen_h as u32 / 2)
            .max(10)
            .min(screen_h as u32 * 80 / 100) as u16,
    )
}

fn permission_chrome_height(state: &PermissionViewState, content_w: usize) -> u16 {
    let args_rows = mcp_args_visible_rows(state, content_w);
    1u16.saturating_add(state.provenance.is_some() as u16)
        .saturating_add(1)
        .saturating_add(
            args_rows
                .0
                .saturating_add(args_rows.1 as usize)
                .min(u16::MAX as usize) as u16,
        )
        .saturating_add(1)
}

fn mcp_args_visible_rows(state: &PermissionViewState, content_w: usize) -> (usize, bool) {
    let total = state
        .description
        .iter()
        .map(|line| char_wrap_row_count(line, content_w))
        .sum::<usize>();
    if !state.args_expanded && total > MCP_ARGS_COLLAPSED_ROWS {
        (MCP_ARGS_COLLAPSED_ROWS - 1, true)
    } else {
        (total, false)
    }
}

fn char_wrap_row_count(value: &str, width: usize) -> usize {
    let width = width.max(1);
    let mut rows = 1;
    let mut current = 0;
    let mut empty = true;
    for ch in value.chars() {
        let char_width = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
        if current + char_width > width && !empty {
            rows += 1;
            current = 0;
        }
        current += char_width;
        empty = false;
    }
    rows
}

/// Render the pager's actual permission-panel structure: background, accent
/// rail, title/provenance chrome, planned arguments, and ordered radio rows.
pub fn render_permission_view(
    buffer: &mut Buffer,
    area: Rect,
    state: &PermissionViewState,
    followup_text: &str,
    hovered_item: Option<usize>,
    theme: &Theme,
    focused: bool,
) -> PermissionRenderResult {
    if area.width == 0 || area.height == 0 {
        return PermissionRenderResult {
            inline_prompt: None,
        };
    }
    let bg = Style::default().bg(theme.bg_light);
    buffer.set_style(area, bg);
    let accent_style = Style::default().fg(theme.accent_user);
    for row in area.y..area.y + area.height {
        if let Some(cell) = buffer.cell_mut((area.x, row)) {
            cell.set_symbol(crate::glyphs::accent_bar());
            cell.set_style(accent_style);
        }
    }

    let content_x = area.x + 3;
    let content_w = area.width.saturating_sub(5);
    let bottom = area.y + area.height;
    let mut y = area.y + 1;
    if let Some(provenance) = &state.provenance {
        if y < bottom {
            buffer.set_line(
                content_x,
                y,
                &Line::from(Span::styled(provenance, Style::default().fg(theme.gray))),
                content_w,
            );
        }
        y += 1;
    }
    if y < bottom {
        buffer.set_line(
            content_x,
            y,
            &Line::from(Span::styled(
                &state.title,
                Style::default()
                    .fg(theme.text_primary)
                    .add_modifier(Modifier::BOLD),
            )),
            content_w,
        );
    }
    y += 1;

    let (visible_args, truncated) = mcp_args_visible_rows(state, content_w as usize);
    for line in state.description.iter().take(visible_args) {
        for row in wrap_line(line, content_w as usize) {
            if y >= bottom {
                break;
            }
            buffer.set_line(
                content_x,
                y,
                &Line::from(Span::styled(row, Style::default().fg(theme.text_secondary))),
                content_w,
            );
            y += 1;
        }
        if y >= bottom {
            break;
        }
    }
    if truncated && y < bottom {
        buffer.set_line(
            content_x,
            y,
            &Line::from(vec![
                Span::styled("... ", Style::default().fg(theme.gray)),
                Span::styled("Ctrl-F", Style::default().fg(theme.accent_user)),
                Span::styled(" to expand", Style::default().fg(theme.gray)),
            ]),
            content_w,
        );
        y += 1;
    }
    y += 1;

    for (index, option) in state.options.iter().enumerate() {
        if y >= bottom {
            break;
        }
        let selected = index == state.active_idx;
        let hovered = hovered_item == Some(index);
        let row_bg = if selected && focused {
            theme.bg_visual
        } else if hovered {
            theme.bg_hover
        } else {
            theme.bg_light
        };
        let row = Rect {
            x: content_x,
            y,
            width: content_w,
            height: 1,
        };
        buffer.set_style(row, Style::default().bg(row_bg));
        buffer.set_line(
            content_x,
            y,
            &option_line(option, index, selected, row_bg, followup_text, theme),
            content_w,
        );
        y += 1;
    }
    if !focused {
        crate::render::color::blend_area(buffer, area, Some((theme.bg_light, 0.66)), None);
    }
    PermissionRenderResult {
        inline_prompt: None,
    }
}

fn option_line(
    option: &PermissionOption,
    index: usize,
    selected: bool,
    bg: ratatui::style::Color,
    followup_text: &str,
    theme: &Theme,
) -> Line<'static> {
    let shortcut = if index < 9 {
        char::from(b'1' + index as u8)
    } else {
        ' '
    };
    let number = Style::default().fg(theme.accent_user).bg(bg);
    let marker = if selected {
        crate::glyphs::filled_dot()
    } else {
        "○"
    };
    let marker_style = if selected {
        Style::default()
            .fg(theme.text_primary)
            .bg(bg)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(theme.gray).bg(bg)
    };
    let label =
        if option.kind == PermissionOptionKind::RejectOnce && !followup_text.trim().is_empty() {
            followup_text.lines().next().unwrap_or_default().to_owned()
        } else {
            option.label.clone()
        };
    let label_style =
        if option.kind == PermissionOptionKind::RejectOnce && followup_text.trim().is_empty() {
            Style::default().fg(theme.gray).bg(bg)
        } else {
            Style::default()
                .fg(theme.text_primary)
                .bg(bg)
                .add_modifier(if selected {
                    Modifier::BOLD
                } else {
                    Modifier::empty()
                })
        };
    Line::from(vec![
        Span::styled(format!("{shortcut} "), number),
        Span::styled(format!("({marker}) "), marker_style),
        Span::styled(label, label_style),
    ])
    .style(Style::default().bg(bg))
}

fn wrap_line(value: &str, width: usize) -> Vec<String> {
    let width = width.max(1);
    let mut lines = Vec::new();
    let mut current = String::new();
    let mut current_width = 0;
    for ch in value.chars() {
        let char_width = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
        if current_width + char_width > width && !current.is_empty() {
            lines.push(std::mem::take(&mut current));
            current_width = 0;
        }
        current.push(ch);
        current_width += char_width;
    }
    lines.push(current);
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> Vec<PermissionOption> {
        vec![
            PermissionOption {
                id: "opaque-deny".into(),
                label: "Reject".into(),
                detail: String::new(),
                kind: PermissionOptionKind::RejectOnce,
            },
            PermissionOption {
                id: "opaque-allow".into(),
                label: "Allow".into(),
                detail: String::new(),
                kind: PermissionOptionKind::AllowOnce,
            },
        ]
    }

    #[test]
    fn selection_round_trips_opaque_id_in_source_order() {
        let mut state = PermissionViewState::new("ask-7", "Agent needs permission", options());
        assert_eq!(state.selected_option_id(), Some("opaque-deny"));
        state.active_idx = 1;
        assert_eq!(state.selected_option_id(), Some("opaque-allow"));
    }

    #[test]
    fn missing_id_fails_closed() {
        let state = PermissionViewState::new(
            "ask-7",
            "Agent needs permission",
            vec![PermissionOption {
                id: "  ".into(),
                label: "Allow".into(),
                detail: String::new(),
                kind: PermissionOptionKind::AllowOnce,
            }],
        );
        assert_eq!(state.selected_option_id(), None);
    }

    #[test]
    fn room_selected_id_preserves_opaque_whitespace_byte_for_byte() {
        let state = PermissionViewState::new(
            "ask-7",
            "Agent needs permission",
            vec![PermissionOption {
                id: "  opaque-id\t".into(),
                label: "Allow".into(),
                detail: String::new(),
                kind: PermissionOptionKind::AllowOnce,
            }],
        );
        assert_eq!(state.selected_option_id(), Some("  opaque-id\t"));
    }
}
