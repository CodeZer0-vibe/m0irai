//! Zer0 room composer discovery without a second composer or provider catalog.
//!
//! The Node room host owns loading commands and skills from disk. This module
//! only validates the attached-room snapshot, derives transient menu state,
//! and paints the room-local overlay using the pager's existing prompt state.

use std::ops::Range;

use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Color, Style},
    widgets::{Clear, Widget},
};
use serde_json::Value;

use crate::{
    room_theme::{RoomIdentity, RoomSecondaryGlyph, RoomTheme, room_secondary},
    slash::SlashSnapshot,
    views::file_search::FileSearchState,
};

const MAX_CATALOG_ROWS_PER_AGENT: usize = 64;
const MAX_DESCRIPTION_BYTES: usize = 240;
const MAX_VISIBLE_ROWS: usize = 8;

const ADDRESS_ROWS: [AddressRow; 4] = [
    AddressRow {
        name: "all",
        description: "route to the whole council (claude + codex + gemini)",
    },
    AddressRow {
        name: "claude",
        description: "lead reasoning + orchestration",
    },
    AddressRow {
        name: "codex",
        description: "code architecture + execution",
    },
    AddressRow {
        name: "gemini",
        description: "research, UX, multimodal",
    },
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct AddressRow {
    name: &'static str,
    description: &'static str,
}

/// The only catalog agents a room is allowed to present.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RoomCatalogAgent {
    Claude,
    Codex,
    Gemini,
}

impl RoomCatalogAgent {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            "gemini" => Some(Self::Gemini),
            _ => None,
        }
    }

    pub const fn name(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Gemini => "gemini",
        }
    }

    pub const fn identity(self) -> RoomIdentity {
        match self {
            Self::Claude => RoomIdentity::Claude,
            Self::Codex => RoomIdentity::Codex,
            Self::Gemini => RoomIdentity::Gemini,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CatalogKind {
    Builtin,
    Custom,
    Skill,
}

impl CatalogKind {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "builtin" => Some(Self::Builtin),
            "custom" => Some(Self::Custom),
            "skill" => Some(Self::Skill),
            _ => None,
        }
    }

    fn is_command(self) -> bool {
        matches!(self, Self::Builtin | Self::Custom)
    }
}

/// An already-sanitized presentation row supplied by the Node catalog owner.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CatalogRow {
    pub name: String,
    pub description: String,
    pub kind: CatalogKind,
    pub trusted: bool,
}

/// A bounded immutable catalog snapshot. Rust never discovers provider files.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RoomCatalogSnapshot {
    claude: Vec<CatalogRow>,
    codex: Vec<CatalogRow>,
    gemini: Vec<CatalogRow>,
}

impl RoomCatalogSnapshot {
    pub fn from_host_value(value: &Value) -> Result<Self, String> {
        let root = value
            .as_object()
            .ok_or_else(|| "room catalog must be an object".to_owned())?;
        require_exact_keys(root, &["version", "agents"], "room catalog")?;
        if root.get("version").and_then(Value::as_u64) != Some(1) {
            return Err("room catalog version must be 1".into());
        }
        let agents = root
            .get("agents")
            .and_then(Value::as_object)
            .ok_or_else(|| "room catalog agents must be an object".to_owned())?;
        require_exact_keys(
            agents,
            &["claude", "codex", "gemini"],
            "room catalog agents",
        )?;
        Ok(Self {
            claude: parse_agent_rows(agents.get("claude").expect("exact keys checked"), "claude")?,
            codex: parse_agent_rows(agents.get("codex").expect("exact keys checked"), "codex")?,
            gemini: parse_agent_rows(agents.get("gemini").expect("exact keys checked"), "gemini")?,
        })
    }

    pub fn rows(&self, agent: RoomCatalogAgent) -> &[CatalogRow] {
        match agent {
            RoomCatalogAgent::Claude => &self.claude,
            RoomCatalogAgent::Codex => &self.codex,
            RoomCatalogAgent::Gemini => &self.gemini,
        }
    }

    pub(crate) fn has_command(&self, agent: RoomCatalogAgent, name: &str) -> bool {
        self.rows(agent)
            .iter()
            .any(|row| row.kind.is_command() && row.name == name)
    }
}

fn require_exact_keys(
    object: &serde_json::Map<String, Value>,
    expected: &[&str],
    subject: &str,
) -> Result<(), String> {
    if object.len() != expected.len() || object.keys().any(|key| !expected.contains(&key.as_str()))
    {
        return Err(format!("{subject} has unknown or missing fields"));
    }
    Ok(())
}

fn parse_agent_rows(value: &Value, agent: &str) -> Result<Vec<CatalogRow>, String> {
    let rows = value
        .as_array()
        .ok_or_else(|| format!("room catalog {agent} must be an array"))?;
    if rows.len() > MAX_CATALOG_ROWS_PER_AGENT {
        return Err(format!("room catalog {agent} exceeds row limit"));
    }
    let mut names = std::collections::HashSet::new();
    rows.iter()
        .map(|value| {
            let row = value
                .as_object()
                .ok_or_else(|| format!("room catalog {agent} row must be an object"))?;
            require_exact_keys(
                row,
                &["name", "description", "kind", "trusted"],
                "room catalog row",
            )?;
            let name = required_safe_string(row, "name", MAX_DESCRIPTION_BYTES.min(49))?;
            if !is_safe_name(&name) {
                return Err("room catalog name is not a safe command token".into());
            }
            if !names.insert(name.clone()) {
                return Err("room catalog contains duplicate command names".into());
            }
            let description = required_safe_string(row, "description", MAX_DESCRIPTION_BYTES)?;
            let kind = row
                .get("kind")
                .and_then(Value::as_str)
                .and_then(CatalogKind::parse)
                .ok_or_else(|| "room catalog row has an unknown kind".to_owned())?;
            let trusted = row
                .get("trusted")
                .and_then(Value::as_bool)
                .ok_or_else(|| "room catalog row trusted must be a boolean".to_owned())?;
            if trusted != matches!(kind, CatalogKind::Builtin) {
                return Err("room catalog row has an invalid trust/kind pairing".into());
            }
            Ok(CatalogRow {
                name,
                description,
                kind,
                trusted,
            })
        })
        .collect()
}

fn required_safe_string(
    object: &serde_json::Map<String, Value>,
    key: &str,
    max_bytes: usize,
) -> Result<String, String> {
    let text = object
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("room catalog row {key} must be a string"))?;
    if text.len() > max_bytes || contains_unsafe_text(text) {
        return Err(format!("room catalog row {key} contains unsafe text"));
    }
    Ok(text.to_owned())
}

fn is_safe_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 49
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes[1..].iter().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b':' | b'.' | b'_' | b'-')
        })
}

fn contains_unsafe_text(text: &str) -> bool {
    text.chars().any(|character| {
        character.is_control()
            || matches!(
                character,
                '\u{061c}'
                    | '\u{200e}'
                    | '\u{200f}'
                    | '\u{202a}'
                    | '\u{202b}'
                    | '\u{202c}'
                    | '\u{202d}'
                    | '\u{202e}'
                    | '\u{2066}'
                    | '\u{2067}'
                    | '\u{2068}'
                    | '\u{2069}'
            )
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentCatalogTab {
    Commands,
    Skills,
}

impl AgentCatalogTab {
    fn title(self) -> &'static str {
        match self {
            Self::Commands => "Commands",
            Self::Skills => "Skills",
        }
    }
}

#[derive(Clone, Debug)]
pub enum RoomMenuKind {
    Address,
    Agent {
        agent: RoomCatalogAgent,
        tab: AgentCatalogTab,
    },
}

#[derive(Clone, Debug)]
pub struct RoomMenuRow {
    pub label: String,
    pub description: String,
    completion: String,
}

#[derive(Clone, Debug)]
pub struct RoomMenuSnapshot {
    pub kind: RoomMenuKind,
    pub rows: Vec<RoomMenuRow>,
    pub selected: usize,
    pub range: Range<usize>,
    pub empty: Option<String>,
}

impl RoomMenuSnapshot {
    pub fn selected_completion(&self) -> Option<(Range<usize>, String)> {
        self.rows
            .get(self.selected)
            .map(|row| (self.range.clone(), row.completion.clone()))
    }
}

/// Mutable selection/dismissal state for room-owned composer discovery.
#[derive(Default)]
pub struct RoomComposerMenu {
    selected: usize,
    tab: AgentCatalogTab,
    dismissed_draft: Option<(String, usize)>,
    last_context: Option<(String, usize, AgentCatalogTab)>,
}

impl Default for AgentCatalogTab {
    fn default() -> Self {
        Self::Commands
    }
}

impl RoomComposerMenu {
    pub fn snapshot(
        &mut self,
        draft: &str,
        cursor: usize,
        catalog: &RoomCatalogSnapshot,
    ) -> Option<RoomMenuSnapshot> {
        if cursor > draft.len() || !draft.is_char_boundary(cursor) {
            return None;
        }
        if self
            .dismissed_draft
            .as_ref()
            .is_some_and(|dismissed| dismissed.0 == draft && dismissed.1 == cursor)
        {
            return None;
        }
        let context = agent_context(draft, cursor).or_else(|| address_context(draft, cursor));
        let context = context?;
        let key = (draft.to_owned(), cursor, self.tab);
        if self.last_context.as_ref() != Some(&key) {
            self.selected = 0;
            self.last_context = Some(key);
        }
        let mut snapshot = match context {
            MenuContext::Address { range, query } => address_snapshot(range, query),
            MenuContext::Agent {
                range,
                agent,
                query,
            } => agent_snapshot(range, agent, query, self.tab, catalog),
        };
        self.selected = if snapshot.rows.is_empty() {
            0
        } else {
            self.selected.min(snapshot.rows.len() - 1)
        };
        snapshot.selected = self.selected;
        Some(snapshot)
    }

    pub fn move_selection(&mut self, row_count: usize, delta: isize) {
        if row_count == 0 {
            self.selected = 0;
            return;
        }
        self.selected = (self.selected as isize + delta).rem_euclid(row_count as isize) as usize;
    }

    pub fn switch_tab(&mut self, direction: isize) {
        self.tab = if direction < 0 {
            AgentCatalogTab::Commands
        } else {
            AgentCatalogTab::Skills
        };
        self.selected = 0;
        self.last_context = None;
    }

    pub fn dismiss(&mut self, draft: &str, cursor: usize) {
        self.dismissed_draft = Some((draft.to_owned(), cursor));
        self.last_context = None;
    }

    pub fn notify_draft_changed(&mut self) {
        self.dismissed_draft = None;
    }
}

enum MenuContext<'a> {
    Address {
        range: Range<usize>,
        query: &'a str,
    },
    Agent {
        range: Range<usize>,
        agent: RoomCatalogAgent,
        query: &'a str,
    },
}

fn address_context(draft: &str, cursor: usize) -> Option<MenuContext<'_>> {
    let before = &draft[..cursor];
    if !before.starts_with('@') || before.chars().any(char::is_whitespace) {
        return None;
    }
    let query = before.strip_prefix('@')?;
    if !ADDRESS_ROWS
        .iter()
        .any(|row| row.name.starts_with(&query.to_ascii_lowercase()))
    {
        return None;
    }
    Some(MenuContext::Address {
        range: 0..cursor,
        query,
    })
}

fn agent_context(draft: &str, cursor: usize) -> Option<MenuContext<'_>> {
    let before = &draft[..cursor];
    let after_at = before.strip_prefix('@')?;
    let (agent_text, rest) = after_at.split_once(char::is_whitespace)?;
    let agent = RoomCatalogAgent::parse(&agent_text.to_ascii_lowercase())?;
    let slash = rest.trim_start().strip_prefix('/')?;
    if slash.chars().any(char::is_whitespace) {
        return None;
    }
    Some(MenuContext::Agent {
        range: 0..cursor,
        agent,
        query: slash,
    })
}

fn address_snapshot(range: Range<usize>, query: &str) -> RoomMenuSnapshot {
    let query = query.to_ascii_lowercase();
    let rows = ADDRESS_ROWS
        .iter()
        .filter(|row| row.name.starts_with(&query))
        .map(|row| RoomMenuRow {
            label: format!("@{}", row.name),
            description: row.description.to_owned(),
            completion: format!("@{} ", row.name),
        })
        .collect();
    RoomMenuSnapshot {
        kind: RoomMenuKind::Address,
        rows,
        selected: 0,
        range,
        empty: None,
    }
}

fn agent_snapshot(
    range: Range<usize>,
    agent: RoomCatalogAgent,
    query: &str,
    tab: AgentCatalogTab,
    catalog: &RoomCatalogSnapshot,
) -> RoomMenuSnapshot {
    let query = query.to_ascii_lowercase();
    let candidates = catalog
        .rows(agent)
        .iter()
        .filter(|row| match tab {
            AgentCatalogTab::Commands => row.kind.is_command(),
            AgentCatalogTab::Skills => row.kind == CatalogKind::Skill,
        })
        .collect::<Vec<_>>();
    let prefix = candidates
        .iter()
        .copied()
        .filter(|row| row.name.starts_with(&query))
        .collect::<Vec<_>>();
    let matches = if prefix.is_empty() && !query.is_empty() {
        candidates
            .iter()
            .copied()
            .filter(|row| row.name.contains(&query))
            .collect()
    } else {
        prefix
    };
    let rows = matches
        .into_iter()
        .map(|row| RoomMenuRow {
            label: format!("/{}", row.name),
            description: row.description.clone(),
            completion: match tab {
                AgentCatalogTab::Commands => format!("@{} /{} ", agent.name(), row.name),
                AgentCatalogTab::Skills => {
                    format!("@{} use your {} skill: ", agent.name(), row.name)
                }
            },
        })
        .collect::<Vec<_>>();
    let empty = rows.is_empty().then(|| match tab {
        AgentCatalogTab::Commands => "No matching commands".to_owned(),
        AgentCatalogTab::Skills => "No matching skills".to_owned(),
    });
    RoomMenuSnapshot {
        kind: RoomMenuKind::Agent { agent, tab },
        rows,
        selected: 0,
        range,
        empty,
    }
}

/// A service-neutral projection of one visible room dropdown.
#[derive(Clone, Debug)]
pub struct RoomComposerOverlay {
    title: String,
    tabs: Option<AgentCatalogTab>,
    rows: Vec<(String, String, Color)>,
    selected: usize,
    empty: Option<String>,
    footer: Option<String>,
}

/// Build a generic attached picker using the room's existing overlay renderer.
/// Provider/session state stays outside this presentation-only module.
pub fn picker_overlay(
    title: String,
    rows: Vec<(String, String, Color)>,
    selected: usize,
    empty: Option<String>,
    footer: Option<String>,
) -> RoomComposerOverlay {
    RoomComposerOverlay {
        title,
        tabs: None,
        rows,
        selected,
        empty,
        footer,
    }
}

pub fn overlay_for(
    menu: Option<RoomMenuSnapshot>,
    slash: &SlashSnapshot,
    file_search: &FileSearchState,
) -> Option<RoomComposerOverlay> {
    if let Some(menu) = menu {
        let (title, tabs, accent) = match menu.kind {
            RoomMenuKind::Address => ("Route", None, RoomIdentity::You.color()),
            RoomMenuKind::Agent { agent, tab } => {
                (agent.name(), Some(tab), agent.identity().color())
            }
        };
        return Some(RoomComposerOverlay {
            title: title.to_owned(),
            tabs,
            rows: menu
                .rows
                .into_iter()
                .map(|row| (row.label, row.description, accent))
                .collect(),
            selected: menu.selected,
            empty: menu.empty,
            footer: Some(match tabs {
                Some(_) => "←→ tabs · ↑↓ choose · Enter stage · Esc close".into(),
                None => "↑↓ choose · Enter route · Esc close".into(),
            }),
        });
    }
    if slash.open {
        return Some(RoomComposerOverlay {
            title: "Commands".into(),
            tabs: None,
            rows: slash
                .matches
                .iter()
                .map(|row| {
                    (
                        row.display.clone(),
                        row.description.clone(),
                        RoomIdentity::Codex.color(),
                    )
                })
                .collect(),
            selected: slash.selected,
            empty: None,
            footer: Some("↑↓ choose · Enter complete · Esc close".into()),
        });
    }
    if file_search.is_visible() {
        return Some(RoomComposerOverlay {
            title: "Files".into(),
            tabs: None,
            rows: file_search
                .results()
                .topk
                .iter()
                .map(|row| {
                    (
                        format!("@{}", row.path),
                        if row.is_dir { "directory" } else { "file" }.to_owned(),
                        RoomIdentity::Codex.color(),
                    )
                })
                .collect(),
            selected: file_search.selected(),
            empty: None,
            footer: Some("↑↓ choose · Enter complete · Esc close".into()),
        });
    }
    None
}

/// Paint an attached room dropdown in the space immediately above the composer.
/// Returns `false` only when the available viewport is too small to show one.
pub fn render_overlay(
    buffer: &mut Buffer,
    available: Rect,
    overlay: &RoomComposerOverlay,
    theme: RoomTheme,
) -> bool {
    if available.width < 14 || available.height < 4 {
        return false;
    }
    let heading = match overlay.tabs {
        Some(tab) => format!(
            "{}  {} {}",
            overlay.title,
            if tab == AgentCatalogTab::Commands {
                "[Commands]"
            } else {
                "Commands"
            },
            if tab == AgentCatalogTab::Skills {
                "[Skills]"
            } else {
                "Skills"
            },
        ),
        None => overlay.title.clone(),
    };
    let widest_content = overlay
        .rows
        .iter()
        .map(|(label, description, _)| {
            unicode_width::UnicodeWidthStr::width(format!("  {label}  {description}").as_str())
        })
        .chain(
            overlay
                .empty
                .iter()
                .map(|text| unicode_width::UnicodeWidthStr::width(text.as_str())),
        )
        .chain(std::iter::once(unicode_width::UnicodeWidthStr::width(
            heading.as_str(),
        )))
        .chain(
            overlay
                .footer
                .iter()
                .map(|text| unicode_width::UnicodeWidthStr::width(text.as_str())),
        )
        .max()
        .unwrap_or(0);
    // Menus are attached to the composer, not modal dashboards. Content-fit
    // them on wide terminals while retaining a useful floor on narrow ones.
    let desired_width = (widest_content as u16)
        .saturating_add(2)
        .clamp(28, 92)
        .min(available.width);
    let visible = overlay.rows.len().min(MAX_VISIBLE_ROWS);
    let body_rows = visible.max(usize::from(overlay.empty.is_some()));
    let footer_rows = u16::from(overlay.footer.is_some());
    let height = (body_rows as u16 + 3 + footer_rows).min(available.height);
    let area = Rect {
        x: available.x,
        y: available.y + available.height.saturating_sub(height),
        width: desired_width,
        height,
    };
    Clear.render(area, buffer);
    buffer.set_style(area, Style::default().fg(theme.text).bg(theme.panel));
    let border = Style::default().fg(theme.border).bg(theme.panel);
    let horizontal = room_secondary(RoomSecondaryGlyph::BorderHorizontal);
    let vertical = room_secondary(RoomSecondaryGlyph::BorderVertical);
    for x in area.left()..area.right() {
        put_cell(buffer, x, area.top(), horizontal, border);
        put_cell(
            buffer,
            x,
            area.bottom().saturating_sub(1),
            horizontal,
            border,
        );
    }
    for y in area.top()..area.bottom() {
        put_cell(buffer, area.left(), y, vertical, border);
        put_cell(buffer, area.right().saturating_sub(1), y, vertical, border);
    }
    put_cell(
        buffer,
        area.left(),
        area.top(),
        room_secondary(RoomSecondaryGlyph::BorderTopLeft),
        border,
    );
    put_cell(
        buffer,
        area.right().saturating_sub(1),
        area.top(),
        room_secondary(RoomSecondaryGlyph::BorderTopRight),
        border,
    );
    put_cell(
        buffer,
        area.left(),
        area.bottom().saturating_sub(1),
        room_secondary(RoomSecondaryGlyph::BorderBottomLeft),
        border,
    );
    put_cell(
        buffer,
        area.right().saturating_sub(1),
        area.bottom().saturating_sub(1),
        room_secondary(RoomSecondaryGlyph::BorderBottomRight),
        border,
    );

    let inner_x = area.x + 1;
    let inner_width = area.width.saturating_sub(2);
    put_text(
        buffer,
        inner_x,
        area.y + 1,
        inner_width,
        &heading,
        Style::default().fg(theme.dim).bg(theme.panel),
    );
    if let Some(empty) = overlay.empty.as_deref() {
        put_text(
            buffer,
            inner_x,
            area.y + 2,
            inner_width,
            empty,
            Style::default().fg(theme.faint).bg(theme.panel),
        );
        render_overlay_footer(buffer, area, inner_x, inner_width, overlay, theme);
        return true;
    }
    let row_count = overlay.rows.len();
    let start = if row_count <= visible {
        0
    } else {
        overlay
            .selected
            .saturating_sub(visible.saturating_sub(1))
            .min(row_count.saturating_sub(visible))
    };
    for (row_index, (label, description, accent)) in
        overlay.rows.iter().enumerate().skip(start).take(visible)
    {
        let y = area.y + 2 + (row_index - start) as u16;
        let selected = row_index == overlay.selected;
        let row_bg = if selected { theme.border } else { theme.panel };
        let prefix = if selected {
            RoomIdentity::You.glyph()
        } else {
            " "
        };
        let line = format!("{prefix} {label}  {description}");
        put_text(
            buffer,
            inner_x,
            y,
            inner_width,
            &line,
            Style::default()
                .fg(if selected { theme.text } else { *accent })
                .bg(row_bg),
        );
    }
    render_overlay_footer(buffer, area, inner_x, inner_width, overlay, theme);
    true
}

fn render_overlay_footer(
    buffer: &mut Buffer,
    area: Rect,
    x: u16,
    width: u16,
    overlay: &RoomComposerOverlay,
    theme: RoomTheme,
) {
    let Some(footer) = overlay.footer.as_deref() else {
        return;
    };
    put_text(
        buffer,
        x,
        area.bottom().saturating_sub(2),
        width,
        footer,
        Style::default().fg(theme.faint).bg(theme.panel),
    );
}

fn put_cell(buffer: &mut Buffer, x: u16, y: u16, symbol: &str, style: Style) {
    if let Some(cell) = buffer.cell_mut((x, y)) {
        cell.set_symbol(symbol);
        cell.set_style(style);
    }
}

fn put_text(buffer: &mut Buffer, x: u16, y: u16, width: u16, text: &str, style: Style) {
    if width == 0 || contains_unsafe_text(text) {
        return;
    }
    let text = crate::render::line_utils::truncate_str(text, width as usize);
    buffer.set_string(x, y, text, style);
}

#[cfg(all(test, feature = "room-runtime"))]
mod tests {
    // Theme-resolving tests hold `pin_theme()` for their whole body: the theme is
    // process-global (`xai-grok-pager-render/src/theme/cache.rs`), and
    // `scrollback/blocks/thinking.rs`'s
    // `thinking_body_dim_italic_survives_the_terminal_native_palette` flips
    // `set_terminal_native_lock(true)` mid-run under `cache::test_lock()`.
    // `pin_theme()` takes that same lock, so reader and writer are serialized.
    use crate::theme::cache::pin_theme;

    use ratatui::{buffer::Buffer, layout::Rect};
    use serde_json::json;

    use super::{
        AgentCatalogTab, RoomCatalogSnapshot, RoomComposerMenu, contains_unsafe_text, overlay_for,
        render_overlay,
    };
    use crate::{
        room_theme::{RoomSecondaryGlyph, RoomTheme, room_secondary},
        slash::SlashSnapshot,
        views::file_search::FileSearchState,
    };

    fn catalog() -> RoomCatalogSnapshot {
        RoomCatalogSnapshot::from_host_value(&json!({
            "version": 1,
            "agents": {
                "claude": [
                    {"name":"plan","description":"make a plan","kind":"builtin","trusted":true},
                    {"name":"repair","description":"repair code","kind":"custom","trusted":false},
                    {"name":"review","description":"review a change","kind":"skill","trusted":false}
                ],
                "codex": [],
                "gemini": []
            }
        }))
        .unwrap()
    }

    #[test]
    fn address_completion_wraps_and_does_not_claim_file_contexts() {
        let mut menu = RoomComposerMenu::default();
        let all = menu.snapshot("@", 1, &catalog()).unwrap();
        assert_eq!(all.rows.len(), 4);
        menu.move_selection(all.rows.len(), -1);
        let wrapped = menu.snapshot("@", 1, &catalog()).unwrap();
        assert_eq!(wrapped.selected_completion().unwrap().1, "@gemini ");
        assert!(menu.snapshot("@file", 5, &catalog()).is_none());
        assert!(menu.snapshot("@Cargo", 6, &catalog()).is_none());
        assert!(menu.snapshot("mail@example.com", 16, &catalog()).is_none());
    }

    #[test]
    fn agent_tabs_match_prefix_then_substring_and_stage_without_execution() {
        let mut menu = RoomComposerMenu::default();
        let commands = menu.snapshot("@claude /pl", 11, &catalog()).unwrap();
        assert_eq!(commands.selected_completion().unwrap().1, "@claude /plan ");
        menu.switch_tab(1);
        let skills = menu.snapshot("@claude /vie", 12, &catalog()).unwrap();
        assert_eq!(
            skills.selected_completion().unwrap().1,
            "@claude use your review skill: "
        );
        menu.switch_tab(-1);
        let substring = menu.snapshot("@claude /air", 12, &catalog()).unwrap();
        assert_eq!(
            substring.selected_completion().unwrap().1,
            "@claude /repair "
        );
        menu.dismiss("@claude /air", 12);
        assert!(menu.snapshot("@claude /air", 12, &catalog()).is_none());
    }

    #[test]
    fn catalog_rejects_unsafe_and_unknown_shapes() {
        assert_eq!(catalog().rows(super::RoomCatalogAgent::Claude).len(), 3);
        let mut invalid = json!({
            "version": 1,
            "agents": {"claude": [], "codex": [], "gemini": []}
        });
        invalid["agents"]["unknown"] = json!([]);
        assert!(RoomCatalogSnapshot::from_host_value(&invalid).is_err());
        let control = json!({
            "version":1,
            "agents":{"claude":[{"name":"bad\u{001b}","description":"x","kind":"builtin","trusted":true}],"codex":[],"gemini":[]}
        });
        assert!(RoomCatalogSnapshot::from_host_value(&control).is_err());
        assert!(contains_unsafe_text("bad\u{202e}"));
    }

    #[test]
    fn room_overlays_paint_above_composer_at_wide_and_narrow_sizes() {
        let _theme = pin_theme();
        let mut menu = RoomComposerMenu::default();
        let snapshot = menu.snapshot("@", 1, &catalog());
        let files = FileSearchState::new(std::path::Path::new("."));
        let overlay = overlay_for(snapshot, &SlashSnapshot::default(), &files).unwrap();
        for area in [Rect::new(0, 0, 96, 18), Rect::new(0, 0, 28, 10)] {
            let mut buffer = Buffer::empty(area);
            assert!(render_overlay(
                &mut buffer,
                area,
                &overlay,
                RoomTheme::current()
            ));
            let text = buffer
                .content
                .iter()
                .map(|cell| cell.symbol())
                .collect::<String>();
            assert!(text.contains("@claude"));
        }

        let wide = Rect::new(0, 0, 120, 18);
        let mut buffer = Buffer::empty(wide);
        assert!(render_overlay(
            &mut buffer,
            wide,
            &overlay,
            RoomTheme::current()
        ));
        let right_border = buffer
            .content
            .iter()
            .enumerate()
            .filter(|(_, cell)| cell.symbol() == room_secondary(RoomSecondaryGlyph::BorderTopRight))
            .map(|(index, _)| (index as u16) % wide.width)
            .max()
            .expect("overlay right border");
        assert!(
            right_border < wide.right().saturating_sub(8),
            "a dropdown should fit its content instead of reading as a full-width panel"
        );
    }

    #[test]
    fn empty_agent_tab_is_honest() {
        let mut menu = RoomComposerMenu::default();
        menu.switch_tab(1);
        let snapshot = menu.snapshot("@claude /missing", 16, &catalog()).unwrap();
        assert_eq!(snapshot.empty.as_deref(), Some("No matching skills"));
        assert!(matches!(
            snapshot.kind,
            super::RoomMenuKind::Agent {
                tab: AgentCatalogTab::Skills,
                ..
            }
        ));
    }
}
