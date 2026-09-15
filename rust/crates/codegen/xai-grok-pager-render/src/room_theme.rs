//! Binding room tokens shared by pager-only presentation without Grok config I/O.
//!
//! These values are deliberately not wired through the Grok theme picker. The
//! Zer0 room is one product surface with a stable HTML contract, while the
//! normal pager remains free to load its own configurable palette.

use ratatui::style::Color;

/// Secondary room-only symbols. Primary identities deliberately live on
/// `RoomIdentity`; every other decorative glyph goes through this one-cell
/// capability boundary so a legacy console cannot distort room geometry.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RoomSecondaryGlyph {
    Divider,
    BorderHorizontal,
    BorderVertical,
    BorderTopLeft,
    BorderTopRight,
    BorderBottomLeft,
    BorderBottomRight,
    PermissionMarker,
    PermissionFocus,
    HopMarker,
    HopArrow,
    Context,
    QuotaFilled,
    QuotaEmpty,
    Ellipsis,
    /// Slice D's unseen-answer pill (spec §D.8). U+2191, ASCII fallback `^`.
    /// `East_Asian_Width=Ambiguous` — one column normally, two in a CJK
    /// context — the same class as [`RoomSecondaryGlyph::HopArrow`], which is
    /// why it goes through this boundary instead of being emitted literally.
    UpArrow,
}

impl RoomSecondaryGlyph {
    /// Every variant, for the width and fallback pin.
    ///
    /// Derived rather than hand-written in the test, because the hand-written
    /// list WAS the hazard: spec §D.8 flags that a variant added to the enum
    /// and not to that loop ships unpinned. The `match` below is exhaustive,
    /// so adding a variant without adding it here is a compile error, and the
    /// pin can no longer silently skip one.
    pub const ALL: &'static [Self] = &[
        Self::Divider,
        Self::BorderHorizontal,
        Self::BorderVertical,
        Self::BorderTopLeft,
        Self::BorderTopRight,
        Self::BorderBottomLeft,
        Self::BorderBottomRight,
        Self::PermissionMarker,
        Self::PermissionFocus,
        Self::HopMarker,
        Self::HopArrow,
        Self::Context,
        Self::QuotaFilled,
        Self::QuotaEmpty,
        Self::Ellipsis,
        Self::UpArrow,
    ];

    /// The compile-time guard behind [`RoomSecondaryGlyph::ALL`]: an
    /// exhaustive match whose only job is to fail to compile when a variant
    /// is added, so the author is forced back to the list above.
    #[cfg(test)]
    const fn is_listed(self) -> bool {
        match self {
            Self::Divider
            | Self::BorderHorizontal
            | Self::BorderVertical
            | Self::BorderTopLeft
            | Self::BorderTopRight
            | Self::BorderBottomLeft
            | Self::BorderBottomRight
            | Self::PermissionMarker
            | Self::PermissionFocus
            | Self::HopMarker
            | Self::HopArrow
            | Self::Context
            | Self::QuotaFilled
            | Self::QuotaEmpty
            | Self::Ellipsis
            | Self::UpArrow => true,
        }
    }
}

pub fn room_secondary(glyph: RoomSecondaryGlyph) -> &'static str {
    room_secondary_for(glyph, crate::glyphs::is_legacy_windows_console())
}

pub fn room_spinner(tick: u64) -> &'static str {
    let frames = crate::glyphs::braille_spinner_frames();
    frames[(tick as usize) % frames.len()]
}

/// The glyph table itself, with the console capability passed IN rather than
/// detected.
///
/// Public since 2026-09-02 (sealed-lanes finding #4). `is_legacy_windows_console`
/// caches in a `OnceLock`, so a test cannot flip consoles inside one process —
/// which is how four room tests came to hard-code the modern glyph and panic
/// the whole pager suite under `GROK_FORCE_LEGACY_CONSOLE=1`. Those tests now
/// assert the row they expect for the console they are actually running in AND
/// pin both columns of this table directly, so the legacy path is proved on
/// every run rather than only on the one the gate re-executes.
pub fn room_secondary_for(glyph: RoomSecondaryGlyph, legacy: bool) -> &'static str {
    match (glyph, legacy) {
        (RoomSecondaryGlyph::Divider, false) => "─",
        (RoomSecondaryGlyph::BorderHorizontal, false) => "─",
        (RoomSecondaryGlyph::BorderVertical, false) => "│",
        (RoomSecondaryGlyph::BorderTopLeft, false) => "╭",
        (RoomSecondaryGlyph::BorderTopRight, false) => "╮",
        (RoomSecondaryGlyph::BorderBottomLeft, false) => "╰",
        (RoomSecondaryGlyph::BorderBottomRight, false) => "╯",
        (RoomSecondaryGlyph::PermissionMarker, false) => "◇",
        (RoomSecondaryGlyph::PermissionFocus, false) => "›",
        (RoomSecondaryGlyph::HopMarker, false) => "◈",
        (RoomSecondaryGlyph::HopArrow, false) => "→",
        (RoomSecondaryGlyph::Context, false) => "◕",
        (RoomSecondaryGlyph::QuotaFilled, false) => "▰",
        (RoomSecondaryGlyph::QuotaEmpty, false) => "▱",
        (RoomSecondaryGlyph::Ellipsis, false) => "…",
        (RoomSecondaryGlyph::UpArrow, false) => "↑",
        (RoomSecondaryGlyph::Divider, true) => "-",
        (RoomSecondaryGlyph::BorderHorizontal, true) => "-",
        (RoomSecondaryGlyph::BorderVertical, true) => "|",
        (RoomSecondaryGlyph::BorderTopLeft, true)
        | (RoomSecondaryGlyph::BorderTopRight, true)
        | (RoomSecondaryGlyph::BorderBottomLeft, true)
        | (RoomSecondaryGlyph::BorderBottomRight, true) => "+",
        (RoomSecondaryGlyph::PermissionMarker, true) => "!",
        (RoomSecondaryGlyph::PermissionFocus, true) => ">",
        (RoomSecondaryGlyph::HopMarker, true) => "+",
        (RoomSecondaryGlyph::HopArrow, true) => ">",
        (RoomSecondaryGlyph::Context, true) => "o",
        (RoomSecondaryGlyph::QuotaFilled, true) => "#",
        (RoomSecondaryGlyph::QuotaEmpty, true) => "-",
        (RoomSecondaryGlyph::Ellipsis, true) => ".",
        (RoomSecondaryGlyph::UpArrow, true) => "^",
    }
}

/// One speaker identity in the Zer0 room contract.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RoomIdentity {
    You,
    Claude,
    Codex,
    Gemini,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RoomIdentityGlyphSet {
    Brand,
    EditorSafe,
    Ascii,
}

fn room_identity_glyph_set(
    legacy: bool,
    env_brand: crate::terminal::TerminalName,
) -> RoomIdentityGlyphSet {
    use crate::terminal::TerminalName;

    if legacy {
        return RoomIdentityGlyphSet::Ascii;
    }
    match env_brand {
        TerminalName::VsCode | TerminalName::Cursor | TerminalName::Windsurf => {
            RoomIdentityGlyphSet::EditorSafe
        }
        _ => RoomIdentityGlyphSet::Brand,
    }
}

impl RoomIdentity {
    pub const fn label(self) -> &'static str {
        match self {
            Self::You => "you",
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Gemini => "gemini",
        }
    }

    /// Keep legacy Windows-console glyphs single-cell. Do not infer legacy
    /// mode from a PowerShell display; the pager's renderer owns that fact.
    pub fn glyph(self) -> &'static str {
        // Cascadia Mono, the default font in the VS Code family on Windows,
        // lacks the Claude and Gemini brand marks. Use the reference's
        // geometric family so all three identities are drawn by one font at
        // one weight and baseline.
        let set = room_identity_glyph_set(
            crate::glyphs::is_legacy_windows_console(),
            crate::terminal::terminal_context().env_brand,
        );
        self.glyph_for(set)
    }

    /// This identity's glyph on a chosen console, for the same reason
    /// [`room_secondary_for`] is public: the room's composer prefix is
    /// `RoomIdentity::You`, and the footer test that hard-coded `❯` for it
    /// failed under a legacy console where it is `>`.
    pub fn glyph_on_legacy_console(self, legacy: bool) -> &'static str {
        self.glyph_for(room_identity_glyph_set(
            legacy,
            crate::terminal::terminal_context().env_brand,
        ))
    }

    fn glyph_for(self, set: RoomIdentityGlyphSet) -> &'static str {
        match (self, set) {
            (Self::You, RoomIdentityGlyphSet::Brand | RoomIdentityGlyphSet::EditorSafe) => {
                "\u{276f}"
            }
            (Self::Claude, RoomIdentityGlyphSet::Brand) => "\u{273b}",
            (Self::Codex, RoomIdentityGlyphSet::Brand) => "\u{2b21}",
            (Self::Gemini, RoomIdentityGlyphSet::Brand) => "\u{2726}",
            (Self::Claude, RoomIdentityGlyphSet::EditorSafe) => "\u{25c6}",
            (Self::Codex, RoomIdentityGlyphSet::EditorSafe) => "\u{25cf}",
            (Self::Gemini, RoomIdentityGlyphSet::EditorSafe) => "\u{25b2}",
            (Self::You, RoomIdentityGlyphSet::Ascii) => ">",
            (Self::Claude, RoomIdentityGlyphSet::Ascii) => "*",
            (Self::Codex, RoomIdentityGlyphSet::Ascii) => "#",
            (Self::Gemini, RoomIdentityGlyphSet::Ascii) => "+",
        }
    }

    pub fn mark(self) -> String {
        format!("{} {}", self.glyph(), self.label())
    }

    pub const fn color(self) -> Color {
        match self {
            Self::You => Color::Rgb(90, 169, 255),
            Self::Claude => Color::Rgb(245, 165, 36),
            Self::Codex => Color::Rgb(45, 212, 191),
            Self::Gemini => Color::Rgb(199, 125, 255),
        }
    }

    /// The HTML reference dims idle identities to 55% over the room canvas.
    pub const fn rest_color(self) -> Color {
        match self {
            Self::You => Color::Rgb(54, 99, 148),
            Self::Claude => Color::Rgb(140, 97, 28),
            Self::Codex => Color::Rgb(30, 122, 113),
            Self::Gemini => Color::Rgb(114, 75, 148),
        }
    }
}

/// Exact surface tokens from the August 3 V2 HTML reference.
#[derive(Clone, Copy, Debug)]
pub struct RoomTheme {
    pub canvas: Color,
    pub terminal: Color,
    pub panel: Color,
    pub border: Color,
    pub text: Color,
    pub dim: Color,
    pub faint: Color,
    pub dead: Color,
    pub attention: Color,
    pub attention_dim: Color,
    pub warning: Color,
}

impl RoomTheme {
    pub const fn current() -> Self {
        Self {
            canvas: Color::Rgb(11, 13, 18),
            terminal: Color::Rgb(13, 15, 20),
            panel: Color::Rgb(18, 21, 29),
            border: Color::Rgb(35, 40, 56),
            text: Color::Rgb(230, 232, 239),
            dim: Color::Rgb(139, 147, 167),
            faint: Color::Rgb(90, 98, 116),
            dead: Color::Rgb(255, 92, 92),
            attention: Color::Rgb(255, 255, 255),
            attention_dim: Color::Rgb(96, 98, 101),
            warning: Color::Rgb(255, 179, 92),
        }
    }

    /// A deterministic 1.3-second two-level breath at the room's 132ms tick.
    /// Reduced motion freezes the high-contrast needs-you state.
    pub const fn attention_at(self, tick: u64, reduced_motion: bool) -> Color {
        if reduced_motion || tick % 10 < 5 {
            self.attention
        } else {
            self.attention_dim
        }
    }
}

#[cfg(test)]
mod tests {
    use ratatui::style::Color;

    use unicode_width::UnicodeWidthStr;

    use super::{
        RoomIdentity, RoomIdentityGlyphSet, RoomSecondaryGlyph, RoomTheme, room_identity_glyph_set,
        room_secondary_for, room_spinner,
    };

    #[test]
    fn room_tokens_match_the_binding_and_reduced_motion_freezes_attention() {
        let theme = RoomTheme::current();
        assert_eq!(theme.canvas, Color::Rgb(11, 13, 18));
        assert_eq!(theme.panel, Color::Rgb(18, 21, 29));
        assert_eq!(theme.dead, Color::Rgb(255, 92, 92));
        assert_eq!(RoomIdentity::Claude.color(), Color::Rgb(245, 165, 36));
        assert_ne!(theme.attention_at(0, false), theme.attention_at(5, false));
        assert_eq!(theme.attention_at(0, true), theme.attention_at(5, true));
    }

    /// Every secondary glyph, on both console generations, is exactly one
    /// column — and the legacy one is ASCII.
    ///
    /// Driven from `RoomSecondaryGlyph::ALL` rather than a list retyped here:
    /// the hand-written list was itself the defect spec §D.8 names, because a
    /// variant added to the enum and forgotten here shipped unpinned. Adding
    /// a variant now fails to compile in `is_listed` until it joins `ALL`.
    ///
    /// The MODERN half is new with slice D and is not decoration: `↑` is
    /// `East_Asian_Width=Ambiguous`, and the whole reason this boundary
    /// exists is that a two-column glyph shifts every cell on the row.
    #[test]
    fn forced_legacy_room_symbols_and_spinners_are_ascii_one_column_fallbacks() {
        for glyph in RoomSecondaryGlyph::ALL.iter().copied() {
            assert!(glyph.is_listed());
            let legacy = room_secondary_for(glyph, true);
            assert!(legacy.is_ascii(), "{glyph:?} legacy fallback is not ASCII");
            assert_eq!(
                UnicodeWidthStr::width(legacy),
                1,
                "{glyph:?} legacy fallback is not one column"
            );
            assert_eq!(
                UnicodeWidthStr::width(room_secondary_for(glyph, false)),
                1,
                "{glyph:?} modern glyph is not one column"
            );
        }
        assert_eq!(RoomSecondaryGlyph::ALL.len(), 16);
        assert_eq!(room_secondary_for(RoomSecondaryGlyph::UpArrow, false), "↑");
        assert_eq!(room_secondary_for(RoomSecondaryGlyph::UpArrow, true), "^");
        assert_eq!(UnicodeWidthStr::width(room_spinner(0)), 1);
    }

    #[test]
    fn editor_safe_identity_family_is_consistent_and_one_column() {
        let expected = ["\u{276f}", "\u{25c6}", "\u{25cf}", "\u{25b2}"];
        for (identity, expected) in [
            RoomIdentity::You,
            RoomIdentity::Claude,
            RoomIdentity::Codex,
            RoomIdentity::Gemini,
        ]
        .into_iter()
        .zip(expected)
        {
            let glyph = identity.glyph_for(RoomIdentityGlyphSet::EditorSafe);
            assert_eq!(glyph, expected);
            assert_eq!(UnicodeWidthStr::width(glyph), 1);
        }
        for brand in [
            crate::terminal::TerminalName::VsCode,
            crate::terminal::TerminalName::Cursor,
            crate::terminal::TerminalName::Windsurf,
        ] {
            assert_eq!(
                room_identity_glyph_set(false, brand),
                RoomIdentityGlyphSet::EditorSafe
            );
        }
        assert_eq!(
            room_identity_glyph_set(true, crate::terminal::TerminalName::VsCode),
            RoomIdentityGlyphSet::Ascii
        );
    }
}
