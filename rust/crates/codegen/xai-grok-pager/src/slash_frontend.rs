//! Service-neutral slash completion catalog used by the shared frontend.
//!
//! Grok's full slash registry owns ACP and application actions.  The prompt
//! only needs a catalog, a parser, and dropdown state, so room mode supplies
//! its semantic commands through this narrow model instead of importing that
//! registry or its service dependency closure.

use std::ops::Range;

pub const MAX_VISIBLE_SUGGESTIONS: usize = 6;

/// Presentation-only origin badge for slash suggestions.
///
/// The room frontend does not own a service command registry, but it shares
/// the b13 dropdown renderer with the full pager. Keeping this small data
/// model here preserves that renderer's collision-badge contract without
/// importing ACP, plugin, or provider runtime ownership into room mode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandProvenance {
    Builtin,
    Shell,
    Skill { source: String },
}

impl CommandProvenance {
    /// Right-aligned badge text used by the shared slash dropdown renderer.
    pub fn badge(&self) -> std::borrow::Cow<'static, str> {
        match self {
            Self::Builtin | Self::Shell => std::borrow::Cow::Borrowed("built-in"),
            Self::Skill { source } => std::borrow::Cow::Owned(format!("skill · {source}")),
        }
    }
}

#[derive(Debug, Clone)]
pub struct SuggestionRow {
    pub display: String,
    pub description: String,
    pub insert_text: String,
    pub indices: Vec<u32>,
    pub tag: Option<String>,
    /// Present only when a caller needs the shared renderer to distinguish
    /// colliding command origins. Room-native commands leave this unset.
    pub provenance: Option<CommandProvenance>,
}

impl SuggestionRow {
    pub(crate) fn command_name(&self) -> &str {
        self.display.strip_prefix('/').unwrap_or(&self.display)
    }
}

#[derive(Debug, Clone, Default)]
pub struct SlashSnapshot {
    pub active: bool,
    pub open: bool,
    pub query: String,
    pub matches: Vec<SuggestionRow>,
    pub selected: usize,
    pub command_range: Option<Range<usize>>,
    pub args_range: Option<Range<usize>>,
    pub cursor_in_command: bool,
    pub args_placeholder: Option<String>,
    pub args_query_is_empty: bool,
    pub is_skill: bool,
    pub command_recognized: bool,
    pub inline_ghost: Option<InlineGhost>,
    pub recognized_tokens: Vec<Range<usize>>,
}

#[derive(Debug, Clone)]
pub struct InlineGhost {
    pub text: String,
    pub token_range: Range<usize>,
    pub full_name: String,
}

impl SlashSnapshot {
    pub fn selection(&self) -> Option<&SuggestionRow> {
        self.matches.get(self.selected)
    }
}

#[derive(Debug, Clone, Default)]
pub struct SlashState {
    snapshot: SlashSnapshot,
}

impl SlashState {
    pub fn snapshot(&self) -> SlashSnapshot {
        self.snapshot.clone()
    }
    pub fn update(&mut self, update: impl FnOnce(&mut SlashSnapshot)) {
        update(&mut self.snapshot);
    }
    pub fn replace(&mut self, snapshot: SlashSnapshot) -> SlashSnapshot {
        std::mem::replace(&mut self.snapshot, snapshot)
    }
    pub fn close(&mut self) {
        self.snapshot.open = false;
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontendCommand {
    pub name: String,
    pub description: String,
    pub takes_arguments: bool,
}

impl FrontendCommand {
    pub fn new(
        name: impl Into<String>,
        description: impl Into<String>,
        takes_arguments: bool,
    ) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            takes_arguments,
        }
    }
}

#[derive(Debug, Default)]
pub struct SlashController {
    catalog: Vec<FrontendCommand>,
}

impl SlashController {
    pub fn with_builtins(_cwd: std::path::PathBuf) -> Self {
        Self::default()
    }
    pub fn set_frontend_catalog(&mut self, catalog: impl IntoIterator<Item = FrontendCommand>) {
        self.catalog = catalog.into_iter().collect();
    }
    pub fn refresh_frontend(&self, state: &mut SlashState, text: &str, cursor: usize) {
        let mut snap = SlashSnapshot::default();
        let token_end = cursor.min(text.len());
        let before = &text[..token_end];
        let token_start = before.rfind(char::is_whitespace).map_or(0, |i| i + 1);
        let token = &before[token_start..];
        if !token.starts_with('/') {
            state.replace(snap);
            return;
        }
        let query = token.trim_start_matches('/');
        snap.active = true;
        snap.open = true;
        snap.query = query.to_owned();
        snap.command_range = Some(token_start..token_end);
        snap.cursor_in_command = true;
        snap.matches = self
            .catalog
            .iter()
            .filter(|command| {
                command.name.starts_with(query)
                    || command
                        .name
                        .to_ascii_lowercase()
                        .starts_with(&query.to_ascii_lowercase())
            })
            .map(|command| SuggestionRow {
                display: format!("/{}", command.name),
                description: command.description.clone(),
                insert_text: format!(
                    "/{}{}",
                    command.name,
                    if command.takes_arguments { " " } else { "" }
                ),
                indices: Vec::new(),
                tag: None,
                provenance: None,
            })
            .collect();
        snap.command_recognized = self.catalog.iter().any(|command| command.name == query);
        snap.open = !snap.matches.is_empty();
        state.replace(snap);
    }
    pub fn move_selection(&self, state: &mut SlashState, delta: isize) {
        state.update(|snap| move_selection(snap, delta, true));
    }
    pub fn scroll_selection(&self, state: &mut SlashState, delta: isize) {
        state.update(|snap| move_selection(snap, delta, false));
    }
    pub fn record_command_use(&self, _prefix: &str, _name: &str) {}
}

fn move_selection(snapshot: &mut SlashSnapshot, delta: isize, wrap: bool) {
    let len = snapshot.matches.len();
    if len == 0 {
        return;
    }
    let next = snapshot.selected as isize + delta;
    snapshot.selected = if wrap {
        next.rem_euclid(len as isize) as usize
    } else {
        next.clamp(0, len as isize - 1) as usize
    };
}

pub struct Invocation<'a> {
    pub token: &'a str,
}
pub fn parse_invocation(text: &str) -> Option<Invocation<'_>> {
    let token = text.split_whitespace().next()?;
    token.strip_prefix('/').map(|token| Invocation { token })
}
