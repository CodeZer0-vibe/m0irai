//! The room's empty-state welcome card: a bordered vertical lockup — the
//! m0irai mark as hero, the name beneath it in ordinary text, and one dim line
//! of version and tagline. Shown only while the room has never had anything in
//! it.
//!
//! The card opens with a one-time entrance — the mark materializes behind a
//! bright neon front while the name types itself on, character by character —
//! and then settles into the mark's living shine. Four properties govern it:
//!
//! 1. **The entrance is a pure function of elapsed wall-clock**, never of a
//!    frame count. A dropped or late frame shows the state the clock says, so a
//!    slow terminal gets a shorter-looking entrance rather than a queue of
//!    animation steps to work through.
//! 2. **It keeps breathing.** Once [`ENTRANCE_SECS`] have passed the entrance
//!    is over, but the shine sweep does not stop: the empty room is the one
//!    surface here that moves on its own, and the operator ruled on 2026-08-19
//!    that it should keep going ("keep the shining pulsing/going"). That motion
//!    is COLOR ONLY — no glyph ever moves — which is why a text dump cannot see
//!    it and every pin on it asserts on colors.
//! 3. **It never comes back.** Emptiness is latched in [`crate::room_view`], so
//!    a room that has held content does not fall back to a welcome card when
//!    that content is cleared, and a resize re-renders whatever the clock says.
//! 4. **The room never waits for it.** Content arriving mid-entrance retires
//!    the card on that frame, half-drawn — and takes the shine with it, so a
//!    room with anything in it is silent again. Any keypress snaps the entrance
//!    to its end while the keystroke itself goes on to the composer untouched.
//!
//! Reduced motion skips the entrance AND the shine, and draws one still frame
//! at a pinned phase.

use std::time::Duration;

use crate::room_logo as logo;
use crate::room_theme::{RoomSecondaryGlyph, RoomTheme, room_secondary};
use ratatui::buffer::Buffer;
use ratatui::layout::{Alignment, Rect};
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Paragraph, Widget};
use unicode_width::UnicodeWidthStr;

/// The product name, spelled exactly as the shipped command. Rendered as
/// ORDINARY TEXT, one character per palette stop (operator, 2026-08-19: "make
/// the text smaller, just like normal text").
pub const PRODUCT_NAME: &str = "m0irai";

/// The card's closing words, and the only plain text on it that is not also
/// room chrome — which is what makes it the marker every real-terminal test
/// keys on. See the trap recorded in the ConPTY suites.
pub const TAGLINE: &str = "three minds · one thread";

/// Per-character colors: a neon hue path from green to purple that stays
/// saturated the whole way, rather than a linear RGB fade through muted middle
/// tones.
///
/// This is the single swap point for the palette. Replacing these six stops
/// changes the name, the entrance and every test's expectation together, and
/// `the_name_has_one_character_per_palette_stop` keeps the two in step.
pub const LETTER_COLORS: [(u8, u8, u8); 6] = [
    (0x39, 0xFF, 0x14), // #39FF14 neon green
    (0x14, 0xF0, 0x7A), // #14F07A spring
    (0x14, 0xD9, 0xE0), // #14D9E0 cyan
    (0x4E, 0x8B, 0xFF), // #4E8BFF azure
    (0x8A, 0x3D, 0xFF), // #8A3DFF violet
    (0x9D, 0x00, 0xFF), // #9D00FF deep neon purple
];

/// The color the materialize front glows. The entrance has to read as an event
/// at a glance, and a sweep of dim gray over a dark background does not — the
/// operator's verdict on the first build was "literally nothing changed".
const FRONT_COLOR: Color = Color::Rgb(0x39, 0xFF, 0x14);

// ── Box geometry ─────────────────────────────────────────────────────────
//
// A tight vertical lockup. Roomier padding than grok's side-by-side hero used,
// because there is no second column to fill the box out: the border hugs the
// content on all four sides instead of framing a layout.

/// Rows between the box border and its content.
const V_PAD: u16 = 2;
/// Columns between the box border and its content.
const H_INSET: u16 = 4;
/// Blank row between the mark and the name.
const MARK_TEXT_GAP: u16 = 1;
/// Rows of text under the mark: the name, then the version/tagline line.
const TEXT_ROWS: u16 = 2;

// ── Entrance timing ──────────────────────────────────────────────────────
//
// Wall-clock seconds from the card's first frame. The operator tunes the feel
// by editing these three numbers and nothing else.

/// How long the mark takes to materialize.
const LOGO_REVEAL_SECS: f32 = 0.62;
/// When the name starts typing — before the mark finishes, so the two motions
/// overlap instead of reading as two separate events.
const NAME_DELAY_SECS: f32 = 0.45;
/// How long the name takes to type all six characters. Six ordinary characters,
/// so this is snappy where the old block wordmark was stately.
const NAME_TYPE_SECS: f32 = 0.45;

/// Total entrance length: 0.90 s.
pub const ENTRANCE_SECS: f32 = NAME_DELAY_SECS + NAME_TYPE_SECS;

/// Redraw cadence while the card is on screen (~12 fps).
///
/// Matches the pager's own `SLOW_TICK_INTERVAL` and the logo's `SHIMMER_FPS`,
/// which is the rate the shine was designed to be sampled at. Redeclared rather
/// than imported because `app/app_view.rs`, where those live, sits behind the
/// permanently-inert `grok-runtime` feature and is not compiled into the room.
pub const TICK: Duration = Duration::from_millis(83);

// ── Reveal math ──────────────────────────────────────────────────────────

/// Fraction of the mark materialized at `secs`.
fn logo_reveal(secs: f32) -> f32 {
    if LOGO_REVEAL_SECS <= 0.0 {
        return 1.0;
    }
    (secs / LOGO_REVEAL_SECS).clamp(0.0, 1.0)
}

/// Number of name characters typed at `secs`.
///
/// Floor, not round: a character appears when its full dwell has elapsed, so
/// `secs = 0` shows nothing rather than one that was never typed.
fn letters_revealed(secs: f32) -> usize {
    let total = LETTER_COLORS.len();
    if secs < NAME_DELAY_SECS {
        return 0;
    }
    let per_letter = NAME_TYPE_SECS / total as f32;
    if per_letter <= 0.0 {
        return total;
    }
    (((secs - NAME_DELAY_SECS) / per_letter).floor() as usize).min(total)
}

/// Whether the entrance has finished. The card goes on breathing after this:
/// what ends here is the materialize and the type-on, never the shine.
///
/// Test-only. Nothing on a shipping path asks the question any more — the card
/// simply draws whatever the clock says and the redraw pump is armed by the
/// card's visibility — but the boundary is worth a name where it is asserted.
#[cfg(test)]
pub fn entrance_complete(secs: f32) -> bool {
    secs >= ENTRANCE_SECS
}

// ── Text ─────────────────────────────────────────────────────────────────

/// The name as one span per character, each already in its final color.
///
/// `plain` is the legacy-console path: a console that cannot render the braille
/// mark is also one whose color story we will not bet on, so there the name
/// ships in the room's ordinary text color — uncolored but present.
///
/// HAZARD: `plain` is a terminal *capability*, never the absence of the mark. A
/// window too short for the box loses the whole card to arithmetic, not to
/// capability, and the two must never be derived from one another.
///
/// The untyped tail is padded with spaces so the line always occupies the full
/// name's width. Without it, centering re-centers the growing prefix and the
/// characters creep leftwards — which reads as the text sliding, not as typing.
fn name_spans(plain: bool, plain_color: Color, revealed: usize) -> Vec<Span<'static>> {
    let characters: Vec<char> = PRODUCT_NAME.chars().collect();
    let revealed = revealed.min(characters.len());
    let padding = characters.len() - revealed;
    let pad = || (padding > 0).then(|| Span::raw(" ".repeat(padding)));
    if plain {
        let typed: String = characters.iter().take(revealed).collect();
        return vec![Span::styled(typed, Style::default().fg(plain_color))]
            .into_iter()
            .chain(pad())
            .collect();
    }
    characters
        .into_iter()
        .take(revealed)
        .enumerate()
        .map(|(index, character)| {
            let (r, g, b) = LETTER_COLORS[index.min(LETTER_COLORS.len() - 1)];
            Span::styled(
                character.to_string(),
                Style::default().fg(Color::Rgb(r, g, b)),
            )
        })
        .chain(pad())
        .collect()
}

/// The version as shown: the bare number, because the name directly above it
/// already carries the product. Falls back to the whole string when it does not
/// start with the product name, and to nothing when none was supplied — the
/// card omits it rather than inventing a number.
fn version_line_text(version: &str) -> String {
    let trimmed = version.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    match trimmed.strip_prefix(PRODUCT_NAME) {
        Some(rest) if !rest.trim().is_empty() => format!("v{}", rest.trim()),
        _ => trimmed.to_owned(),
    }
}

/// The card's one dim line: version and tagline, or just the tagline when the
/// binary reported no version.
fn meta_line_text(version: &str) -> String {
    let version = version_line_text(version);
    if version.is_empty() {
        TAGLINE.to_owned()
    } else {
        format!("{version}  ·  {TAGLINE}")
    }
}

// ── Layout ───────────────────────────────────────────────────────────────

/// Outer size of the card for this version string.
///
/// Independent of the window: the mark is one fixed size, so a window too small
/// for the box gets no card at all rather than a shrunken one. Private —
/// callers hand the card an area and it either fits or draws nothing, so
/// nobody outside this module has to budget rows for it.
fn card_size(version: &str) -> (u16, u16) {
    let mark_rows = logo::card_logo_line_count();
    let mark_cols = logo::card_logo_visual_width();
    let gap = if mark_rows == 0 { 0 } else { MARK_TEXT_GAP };

    // Terminal columns, not character counts: the meta line carries middle dots
    // and the mark is braille, and those are not the same question.
    let content_width = mark_cols
        .max(UnicodeWidthStr::width(PRODUCT_NAME) as u16)
        .max(UnicodeWidthStr::width(meta_line_text(version).as_str()) as u16);
    let content_height = mark_rows + gap + TEXT_ROWS;
    (
        content_width + H_INSET * 2 + 2,
        content_height + V_PAD * 2 + 2,
    )
}

/// [`card_size`], for tests that must reason about whether a band can hold the
/// card without hard-coding a number for it.
///
/// Test-only on purpose. The privacy above is a real constraint on production —
/// a caller hands the card an area and it either fits or draws nothing, so
/// nobody on a render path budgets rows for it — and this does not relax that.
/// It exists because the size is **not a constant across render paths**: a
/// legacy console suppresses the braille mark and the card shrinks, so a test
/// that writes down 18 rows is pinned to one of the two paths the gate runs.
#[cfg(test)]
pub(crate) fn card_size_for_tests(version: &str) -> (u16, u16) {
    card_size(version)
}

// ── Rendering ────────────────────────────────────────────────────────────

/// Paint the card centered inside `area`, `secs` into its life.
///
/// Renders nothing when `area` cannot hold the box, so a small window shows the
/// ordinary quiet room rather than a clipped frame. `reduced_motion` draws one
/// still frame: no entrance, and no shine either.
///
/// Returns the box it actually painted, or `None` when it painted nothing. A caller that wants to put
/// something UNDER the card asks the card where it ended rather than recomputing the centring — the
/// first version of slice A's remedy lines anchored to the bottom of the BAND instead and painted over
/// the card's closing border. Found by looking at a rendered frame, not by reading the code.
pub fn render_card(
    area: Rect,
    buf: &mut Buffer,
    version: &str,
    secs: f32,
    reduced_motion: bool,
) -> Option<Rect> {
    let theme = RoomTheme::current();
    let (width, height) = card_size(version);
    if area.width < width || area.height < height || width == 0 || height == 0 {
        return None;
    }

    // Reduced motion has no entrance and no shine, so it needs the one phase
    // that renders the mark with a visible sheen rather than flat.
    let (reveal, letters, shine) = if reduced_motion {
        (1.0, LETTER_COLORS.len(), logo::FROZEN_SHINE_SECS)
    } else {
        (logo_reveal(secs), letters_revealed(secs), secs)
    };

    let box_area = Rect::new(
        area.x + (area.width - width) / 2,
        area.y + (area.height - height) / 2,
        width,
        height,
    );
    draw_border(box_area, buf, theme.border, theme.canvas);

    let inner = Rect::new(
        box_area.x + 1 + H_INSET,
        box_area.y + 1 + V_PAD,
        width - 2 - H_INSET * 2,
        height - 2 - V_PAD * 2,
    );

    let mark_rows = logo::card_logo_line_count();
    let mut y = inner.y;
    if mark_rows > 0 {
        logo::render_card_logo_at(
            Rect::new(inner.x, y, inner.width, mark_rows),
            buf,
            logo::LogoPalette {
                base: theme.faint,
                hilite: theme.text,
                background: theme.canvas,
                front: FRONT_COLOR,
                reveal,
            },
            shine,
        );
        y += mark_rows + MARK_TEXT_GAP;
    }

    let spans = name_spans(
        crate::glyphs::is_legacy_windows_console(),
        theme.text,
        letters,
    );
    Paragraph::new(Line::from(spans).alignment(Alignment::Center))
        .render(Rect::new(inner.x, y, inner.width, 1), buf);
    y += 1;

    Paragraph::new(
        Line::from(Span::styled(
            meta_line_text(version),
            Style::default().fg(theme.dim),
        ))
        .alignment(Alignment::Center),
    )
    .render(Rect::new(inner.x, y, inner.width, 1), buf);
    Some(box_area)
}

/// The box chrome: a single-line rounded frame in the room's border color.
///
/// Drawn from [`room_secondary`] rather than a ratatui `Block` so the glyphs go
/// through the room's one capability boundary — a legacy console gets `+ - |`
/// instead of box-drawing tofu, exactly as every other room border does.
fn draw_border(area: Rect, buf: &mut Buffer, color: Color, background: Color) {
    if area.width < 2 || area.height < 2 {
        return;
    }
    let style = Style::default().fg(color).bg(background);
    let horizontal = room_secondary(RoomSecondaryGlyph::BorderHorizontal);
    let vertical = room_secondary(RoomSecondaryGlyph::BorderVertical);
    let right = area.x + area.width - 1;
    let bottom = area.y + area.height - 1;

    for x in area.x..=right {
        for (y, glyph) in [(area.y, horizontal), (bottom, horizontal)] {
            if let Some(cell) = buf.cell_mut((x, y)) {
                cell.set_symbol(glyph);
                cell.set_style(style);
            }
        }
    }
    for y in area.y + 1..bottom {
        for (x, glyph) in [(area.x, vertical), (right, vertical)] {
            if let Some(cell) = buf.cell_mut((x, y)) {
                cell.set_symbol(glyph);
                cell.set_style(style);
            }
        }
    }
    for (x, y, corner) in [
        (area.x, area.y, RoomSecondaryGlyph::BorderTopLeft),
        (right, area.y, RoomSecondaryGlyph::BorderTopRight),
        (area.x, bottom, RoomSecondaryGlyph::BorderBottomLeft),
        (right, bottom, RoomSecondaryGlyph::BorderBottomRight),
    ] {
        if let Some(cell) = buf.cell_mut((x, y)) {
            cell.set_symbol(room_secondary(corner));
            cell.set_style(style);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VERSION: &str = "m0irai 0.1.0";
    const AREA: Rect = Rect {
        x: 0,
        y: 0,
        width: 90,
        height: 30,
    };

    fn painted(buf: &Buffer) -> String {
        buf.content.iter().map(|cell| cell.symbol()).collect()
    }

    fn render(secs: f32) -> Buffer {
        let mut buf = Buffer::empty(AREA);
        let _ = render_card(AREA, &mut buf, VERSION, secs, false);
        buf
    }

    fn colors(secs: f32) -> Vec<Color> {
        render(secs).content.iter().map(|cell| cell.fg).collect()
    }

    fn row_text(buf: &Buffer, y: u16) -> String {
        (0..AREA.width)
            .filter_map(|x| buf.cell((x, y)).map(|cell| cell.symbol().to_owned()))
            .collect()
    }

    /// The screen row the name is painted on, found from the settled frame.
    fn name_row() -> u16 {
        let settled = render(ENTRANCE_SECS);
        (0..AREA.height)
            .find(|y| row_text(&settled, *y).contains(PRODUCT_NAME))
            .expect("the settled card paints the name")
    }

    // ── The operator's verdict, as assertions ─────────────────────────────

    // "make the logo bigger than the text first of all" and "make the text
    // smaller, just like normal text" — the whole point of this layout, so it
    // is pinned rather than left to the eye.
    #[test]
    fn the_mark_is_the_hero_and_the_name_is_ordinary_text() {
        if logo::card_logo_line_count() == 0 {
            return; // legacy console: no mark to be hero of anything
        }
        let mark_rows = logo::card_logo_line_count();
        assert!(
            mark_rows >= TEXT_ROWS * 4,
            "the mark must dominate the text block: {mark_rows} rows vs {TEXT_ROWS}"
        );
        assert_eq!(
            UnicodeWidthStr::width(PRODUCT_NAME),
            6,
            "the name is six ordinary characters on one row, not an art block"
        );
    }

    #[test]
    fn the_name_has_one_character_per_palette_stop() {
        assert_eq!(
            PRODUCT_NAME.chars().count(),
            LETTER_COLORS.len(),
            "every character of the name gets exactly one palette stop"
        );
    }

    #[test]
    fn the_neon_path_stays_saturated_end_to_end() {
        assert_eq!(LETTER_COLORS[0], (0x39, 0xFF, 0x14), "starts neon green");
        assert_eq!(
            LETTER_COLORS[5],
            (0x9D, 0x00, 0xFF),
            "ends deep neon purple"
        );
        for (index, &(r, g, b)) in LETTER_COLORS.iter().enumerate() {
            let max = r.max(g).max(b);
            let min = r.min(g).min(b);
            assert!(
                max >= 0xD9,
                "letter {index} is too dark to read as neon: {r},{g},{b}"
            );
            assert!(
                u16::from(max) - u16::from(min) >= 0xB0,
                "letter {index} is washed out, not neon: {r},{g},{b}"
            );
        }
    }

    // ── Entrance ──────────────────────────────────────────────────────────

    #[test]
    fn the_entrance_starts_empty_ends_complete_and_fits_its_budget() {
        assert_eq!(logo_reveal(0.0), 0.0, "no mark at t=0");
        assert_eq!(letters_revealed(0.0), 0, "no characters at t=0");
        assert!(!entrance_complete(0.0));

        assert_eq!(logo_reveal(ENTRANCE_SECS), 1.0);
        assert_eq!(letters_revealed(ENTRANCE_SECS), LETTER_COLORS.len());
        assert!(entrance_complete(ENTRANCE_SECS));
        assert_eq!(logo_reveal(600.0), 1.0);
        assert_eq!(letters_revealed(600.0), LETTER_COLORS.len());

        // Snappier than the block wordmark it replaces: six ordinary
        // characters do not need a stately reveal.
        assert!(
            (0.40..=0.50).contains(&NAME_TYPE_SECS),
            "the type-on budget is 0.4-0.5 s, got {NAME_TYPE_SECS}"
        );
        assert!(
            ENTRANCE_SECS <= 1.0,
            "the whole entrance stays inside a second, got {ENTRANCE_SECS}"
        );
    }

    #[test]
    fn the_entrance_only_moves_forward_and_shows_every_character_count() {
        let total = LETTER_COLORS.len();
        let mut previous_reveal = 0.0;
        let mut previous_letters = 0;
        let mut seen = std::collections::BTreeSet::new();
        let mut secs = 0.0;
        while secs <= ENTRANCE_SECS + 0.2 {
            let reveal = logo_reveal(secs);
            let letters = letters_revealed(secs);
            assert!(
                reveal >= previous_reveal - f32::EPSILON,
                "mark un-revealed at {secs}"
            );
            assert!(letters >= previous_letters, "characters un-typed at {secs}");
            seen.insert(letters);
            previous_reveal = reveal;
            previous_letters = letters;
            secs += 0.005;
        }
        assert_eq!(
            seen.len(),
            total + 1,
            "every count 0..={total} must appear, saw {seen:?}"
        );
    }

    // Typing means characters ARRIVE; it does not mean the line slides. The
    // name is centered, so a growing prefix would re-center every frame and
    // creep leftwards.
    #[test]
    fn the_typed_name_is_anchored_and_does_not_slide() {
        // Scoped to the NAME's row on purpose. Searching the whole frame for an
        // "m" finds the one in "three minds" on the meta line the moment the
        // name row is still blank, and reports that as the name having moved --
        // which is exactly how this test failed when the meta line was added.
        let row = name_row();
        let column_of_m = |secs: f32| -> Option<u16> {
            let buf = render(secs);
            (0..AREA.width).find(|x| buf.cell((*x, row)).is_some_and(|c| c.symbol() == "m"))
        };

        let settled = column_of_m(ENTRANCE_SECS).expect("the finished name is on screen");
        let mut secs = NAME_DELAY_SECS;
        while secs <= ENTRANCE_SECS {
            if let Some(column) = column_of_m(secs) {
                assert_eq!(
                    column, settled,
                    "the name drifted at {secs}s: column {column} vs settled {settled}"
                );
            }
            secs += 0.02;
        }
    }

    #[test]
    fn each_character_arrives_already_in_its_final_color() {
        let plain_color = RoomTheme::current().text;
        for revealed in 1..=LETTER_COLORS.len() {
            let spans = name_spans(false, plain_color, revealed);
            let colored: Vec<Color> = spans.iter().filter_map(|span| span.style.fg).collect();
            assert_eq!(
                colored.len(),
                revealed,
                "one colored span per typed character"
            );
            for (index, color) in colored.iter().enumerate() {
                let (r, g, b) = LETTER_COLORS[index];
                assert_eq!(
                    *color,
                    Color::Rgb(r, g, b),
                    "character {index} must arrive in its final color, not fade into it"
                );
            }
        }
    }

    // The legacy console hides the braille mark; the name still has to be
    // there, just without a truecolor gradient to bet on.
    #[test]
    fn the_legacy_console_keeps_the_name_and_drops_the_gradient() {
        let plain_color = RoomTheme::current().text;
        let plain = name_spans(true, plain_color, PRODUCT_NAME.chars().count());
        assert_eq!(plain.len(), 1, "the plain name is one span");
        assert_eq!(plain[0].content, PRODUCT_NAME);
        assert_eq!(plain[0].style.fg, Some(plain_color));

        let colored = name_spans(false, plain_color, PRODUCT_NAME.chars().count());
        let rendered: String = colored.iter().map(|span| span.content.as_ref()).collect();
        assert_eq!(rendered, PRODUCT_NAME, "both paths spell the same name");
    }

    // ── The shine, which the operator ruled must keep going ───────────────

    /// A cell the materialize front has recently burned, or a name character in
    /// the neon end of the palette. Neutral grays and the dim meta line can
    /// never satisfy it: they carry no green dominance.
    fn burning(color: Color) -> bool {
        match color {
            Color::Rgb(r, g, b) => {
                g > 0x90 && g > r.saturating_add(0x30) && g > b.saturating_add(0x30)
            }
            _ => false,
        }
    }

    fn burning_rows(secs: f32) -> std::collections::BTreeSet<u16> {
        let buf = render(secs);
        let mut rows = std::collections::BTreeSet::new();
        for y in 0..AREA.height {
            for x in 0..AREA.width {
                if buf.cell((x, y)).is_some_and(|cell| burning(cell.fg)) {
                    rows.insert(y);
                    break;
                }
            }
        }
        rows
    }

    // The operator overruled freeze on 2026-08-19 ("keep the shining
    // pulsing/going"), so the settled card must still be moving.
    //
    // This replaces `the_settled_card_is_frozen`, which asserted the opposite
    // AND could not see its own subject: it compared ENTRANCE_SECS against
    // ENTRANCE_SECS + 30 s, and at those two moments the shine band is parked
    // off the art in both frames while the 5 s pulse sits at an identical
    // point — measured bit-identical, ZERO cells different, so it passed with a
    // fully live shimmer underneath it. Sampling across the whole cycle is what
    // makes this one bite.
    #[test]
    fn the_settled_card_keeps_breathing() {
        if logo::card_logo_line_count() == 0 {
            return; // legacy console: no mark to shine
        }
        let early = ENTRANCE_SECS;
        let later = ENTRANCE_SECS + 0.5;

        assert_eq!(
            painted(&render(early)),
            painted(&render(later)),
            "the shine is a color sweep; no glyph may move, which is exactly why \
             a text-based pin cannot see it"
        );
        assert_ne!(
            colors(early),
            colors(later),
            "a settled card whose colors stop changing has stopped breathing"
        );

        // And it keeps moving across a whole cycle, not at one lucky pair of
        // offsets.
        let base = colors(ENTRANCE_SECS);
        let samples = 48;
        let moved = (1..=samples)
            .filter(|step| colors(ENTRANCE_SECS + *step as f32 * 0.1) != base)
            .count();
        assert!(
            moved >= samples - 4,
            "the shine must move for essentially its whole cycle, moved on \
             {moved}/{samples} samples"
        );
    }

    // Reduced motion opts out of BOTH the entrance and the shine: one still
    // frame, forever.
    #[test]
    fn reduced_motion_settles_at_once_and_does_not_breathe() {
        let mut first = Buffer::empty(AREA);
        let _ = render_card(AREA, &mut first, VERSION, 0.0, true);
        let mut later = Buffer::empty(AREA);
        let _ = render_card(AREA, &mut later, VERSION, 99.0, true);
        assert_eq!(first, later, "reduced motion must not animate, ever");
        assert!(
            painted(&first).contains(PRODUCT_NAME),
            "and the whole name is present on its very first frame"
        );
    }

    // The entrance has to be VISIBLE, and a raw count of green cells cannot
    // show that: the name is neon by design and would carry the assertion on
    // its own. The settled frame is therefore the CONTROL — the entrance has to
    // light green in rows the settled card does not have, which can only be the
    // mark burning.
    #[test]
    fn the_materialize_front_burns_across_the_mark_and_cools_out_of_it() {
        if logo::card_logo_line_count() == 0 {
            return; // legacy console: no mark to materialize
        }
        let settled = burning_rows(ENTRANCE_SECS);
        assert!(
            !settled.is_empty(),
            "sanity: the settled name's own characters are neon"
        );

        let swept: std::collections::BTreeSet<u16> = (1..=10)
            .flat_map(|step| burning_rows(LOGO_REVEAL_SECS * step as f32 / 10.0))
            .collect();
        assert!(
            swept.difference(&settled).next().is_some(),
            "the front never lit a row the settled card does not already have, \
             so the sweep is invisible: swept {swept:?} vs settled {settled:?}"
        );
    }

    // ── Layout ────────────────────────────────────────────────────────────

    #[test]
    fn the_card_is_a_bordered_vertical_lockup() {
        let frame = render(ENTRANCE_SECS);
        let text = painted(&frame);
        for corner in [
            RoomSecondaryGlyph::BorderTopLeft,
            RoomSecondaryGlyph::BorderTopRight,
            RoomSecondaryGlyph::BorderBottomLeft,
            RoomSecondaryGlyph::BorderBottomRight,
        ] {
            assert!(
                text.contains(room_secondary(corner)),
                "the box is missing a corner: {text:?}"
            );
        }
        assert!(text.contains(TAGLINE), "the tagline is on the card");
        assert!(text.contains("v0.1.0"), "the version is on the card");
        assert!(text.contains(PRODUCT_NAME), "the name is on the card");

        // Vertical, not side by side: the meta line sits directly BELOW the
        // name, and both below the mark.
        let row_of = |needle: &str| -> Option<u16> {
            (0..AREA.height).find(|y| row_text(&frame, *y).contains(needle))
        };
        let name_row = row_of(PRODUCT_NAME).expect("the name is on a row");
        let meta_row = row_of(TAGLINE).expect("the meta line is on a row");
        assert_eq!(meta_row, name_row + 1, "the meta line sits under the name");
    }

    // The version shown is the one the binary reports, never a number this
    // module made up.
    #[test]
    fn the_version_line_is_derived_from_what_the_binary_prints() {
        assert_eq!(version_line_text("m0irai 0.1.0"), "v0.1.0");
        assert_eq!(version_line_text("  m0irai 2.5.1  "), "v2.5.1");
        assert_eq!(version_line_text("something-else 9"), "something-else 9");
        assert_eq!(version_line_text(""), "");
        assert_eq!(version_line_text("m0irai"), "m0irai");

        // No version means no version half — never an empty "v" or a stray dot.
        assert_eq!(meta_line_text(""), TAGLINE);
        assert_eq!(
            meta_line_text("m0irai 0.1.0"),
            format!("v0.1.0  ·  {TAGLINE}")
        );
    }

    #[test]
    fn a_window_too_small_for_the_box_paints_nothing() {
        let (width, height) = card_size(VERSION);
        for area in [
            Rect::new(0, 0, width - 1, height),
            Rect::new(0, 0, width, height - 1),
        ] {
            let mut buf = Buffer::empty(Rect::new(0, 0, width, height));
            let _ = render_card(area, &mut buf, VERSION, ENTRANCE_SECS, false);
            assert!(
                painted(&buf).trim().is_empty(),
                "a box that does not fit must not clip: {area:?}"
            );
        }

        // The exact minimum DOES render, so the assertion above is about the
        // boundary and not about a box nothing could ever satisfy.
        let exact = Rect::new(0, 0, width, height);
        let mut fits = Buffer::empty(exact);
        let _ = render_card(exact, &mut fits, VERSION, ENTRANCE_SECS, false);
        assert!(
            painted(&fits).contains(TAGLINE),
            "the exact minimum size must render the card"
        );
    }
}
