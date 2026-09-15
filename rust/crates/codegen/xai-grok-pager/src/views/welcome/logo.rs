//! Logo component — renders the braille art logo.
//!
//! Hidden entirely on legacy Windows consoles: the U+2800 braille block is
//! not covered by the ConHost raster fonts and would render as tofu.

use ratatui::buffer::Buffer;
use ratatui::layout::{Alignment, Rect};
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Paragraph, Widget};

use crate::render::color::blend_color;
use crate::theme::Theme;

const LOGO: &str = include_str!("../../../assets/logo/logo07.txt");
const LOGO_SMALL: &str = include_str!("../../../assets/logo/logo05.txt");

/// The room welcome card's hero mark: ONE fixed size, deliberately independent
/// of the height tiers the stacked welcome layout picks between.
///
/// The card is a vertical lockup whose whole point is that the mark dominates
/// the text (operator, 2026-08-19: "make the logo bigger than the text first of
/// all"), so it does not shrink with the window. A window too short for it
/// shows the ordinary quiet room instead — the card refuses to clip.
const CARD_LOGO: &str = include_str!("../../../assets/logo/logo12.txt");

/// U+2800, the blank braille cell. A row of these is padding baked into the
/// asset, not art.
const BRAILLE_BLANK: char = '\u{2800}';

/// Height at or above which the small logo is shown (below it, no logo).
const SMALL_LOGO_MIN_HEIGHT: u16 = 22;
/// Height at or above which the full logo is shown.
const FULL_LOGO_MIN_HEIGHT: u16 = 26;

fn pick_logo(window_height: u16) -> Option<&'static str> {
    pick_logo_for(window_height, logo_hidden())
}

/// Pure tier selection so tests can drive the legacy-console flag directly.
fn pick_logo_for(window_height: u16, hidden: bool) -> Option<&'static str> {
    if hidden || window_height < SMALL_LOGO_MIN_HEIGHT {
        None
    } else if window_height < FULL_LOGO_MIN_HEIGHT {
        Some(LOGO_SMALL)
    } else {
        Some(LOGO)
    }
}

/// The braille art has no ASCII stand-in; see the module doc.
fn logo_hidden() -> bool {
    crate::glyphs::is_legacy_windows_console()
}

fn non_empty_lines(logo: &str) -> impl Iterator<Item = &str> {
    logo.lines().filter(|l| !l.is_empty())
}

fn count_lines(logo: &str) -> u16 {
    non_empty_lines(logo).count() as u16
}

fn visual_width(logo: &str) -> u16 {
    non_empty_lines(logo)
        .map(unicode_width::UnicodeWidthStr::width)
        .max()
        .unwrap_or(24) as u16
}

/// Animation phase in seconds since the first render. Wall-clock based so the
/// shimmer speed is independent of the frame rate.
fn anim_phase_secs() -> f32 {
    use std::sync::OnceLock;
    use std::time::Instant;
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f32()
}

/// Shimmer redraw cadence in frames per second. The sweep is slow, so a few fps
/// looks smooth while sparing the long-lived welcome screen from full-rate
/// repaints.
const SHIMMER_FPS: f32 = 12.0;

/// Quantized shimmer frame for the current wall-clock phase. The welcome screen
/// redraws only when this advances, throttling the animation to ~`SHIMMER_FPS`
/// rather than the full event-loop tick rate. Pinned to 0 when the logo is
/// hidden.
pub fn shimmer_frame() -> u64 {
    if logo_hidden() {
        return 0;
    }
    (anim_phase_secs() * SHIMMER_FPS) as u64
}

/// Per-glyph shine opacity in `[0, 1]` at normalized diagonal position `diag`
/// (0 = bottom-left .. 1 = top-right) and animation time `secs`. A raised-cosine
/// band sweeps bottom-left → top-right and parks off-screen between sweeps; a
/// gentle global pulse breathes underneath it. 0 keeps the resting gray, 1 is
/// full bright.
fn shine_opacity(diag: f32, secs: f32) -> f32 {
    const BAND: f32 = 0.38; // half-width of the shine band — wider = more gradual falloff
    const CYCLE: f32 = 4.0; // seconds per sweep + rest
    const SWEEP_FRAC: f32 = 0.32; // portion of the cycle spent sweeping (~1.3s glint, rest idles)
    const SHINE: f32 = 0.33; // peak shine strength
    const PULSE: f32 = 0.06; // global breathing amount
    const PULSE_SECS: f32 = 5.0; // breathing period

    let p = (secs % CYCLE) / CYCLE;
    let q = (p / SWEEP_FRAC).min(1.0); // parks the band off-screen during the rest
    let band_pos = -BAND + q * (1.0 + 2.0 * BAND);
    let pulse = PULSE * (0.5 - 0.5 * (std::f32::consts::TAU * secs / PULSE_SECS).cos());

    let d = (diag - band_pos).abs();
    let shine = if d < BAND {
        0.5 * (1.0 + (std::f32::consts::PI * d / BAND).cos())
    } else {
        0.0
    };
    (pulse + SHINE * shine).clamp(0.0, 1.0)
}

fn render_into(area: Rect, buf: &mut Buffer, theme: &Theme, logo: &str) {
    // Blend each glyph from the resting gray toward the bright text color by its
    // shine opacity, so a sheen sweeps across the braille art.
    render_into_shaded(
        area,
        buf,
        logo,
        LogoPalette::settled(theme.gray, theme.text_primary),
        anim_phase_secs(),
    );
}

/// How a caller wants the braille art colored.
///
/// A parameter object rather than five positional arguments — the painter is
/// already at clippy's `too_many_arguments` edge.
#[derive(Clone, Copy, Debug)]
pub struct LogoPalette {
    /// Resting color of an unlit glyph.
    pub base: Color,
    /// Color a fully lit glyph reaches at peak shine.
    pub hilite: Color,
    /// The color the art materializes OUT of during an entrance reveal. Only
    /// consulted while `reveal < 1.0`.
    pub background: Color,
    /// The color the materialize front burns in as it passes a glyph, before
    /// that glyph cools to its settled shade. Only consulted while
    /// `reveal < 1.0`.
    ///
    /// This exists because an entrance that only fades glyphs up out of the
    /// background is invisible on a dark terminal: the operator's verdict on
    /// exactly that build was "literally nothing changed". A front in a color
    /// the background does not contain is what makes the sweep readable.
    pub front: Color,
    /// Entrance progress in `[0, 1]`. `1.0` is fully materialized and paints
    /// exactly what the settled logo has always painted.
    pub reveal: f32,
}

impl LogoPalette {
    /// The palette for art that is already fully on screen.
    ///
    /// `background` and `front` are set to `base` rather than left meaningless:
    /// at `reveal = 1.0` neither is consulted, and a caller reading this should
    /// see two inert values, not two arbitrary ones.
    pub fn settled(base: Color, hilite: Color) -> Self {
        Self {
            base,
            hilite,
            background: base,
            front: base,
            reveal: 1.0,
        }
    }
}

/// How far the materialize front has swept past the glyph at normalized
/// diagonal `diag`: `0.0` before the front arrives, `1.0` once its whole width
/// has gone by and the glyph is settled.
///
/// The art assembles along the SAME bottom-left → top-right diagonal the shine
/// band later sweeps, so the materialize and the first sheen read as one
/// motion. `progress >= 1.0` returns 1.0 everywhere — the settled art.
fn front_passage(diag: f32, progress: f32) -> f32 {
    if progress >= 1.0 {
        return 1.0;
    }
    // The front starts off the leading edge and finishes past the trailing one,
    // so every glyph has been fully passed exactly at progress 1.
    let front = progress * (1.0 + REVEAL_EDGE);
    ((front - diag) / REVEAL_EDGE).clamp(0.0, 1.0)
}

/// Opacity of a glyph the front has passed by `passage`: it ignites out of the
/// background over the front's leading [`IGNITE_SHARE`] and is fully opaque
/// after that.
fn ignition_of(passage: f32) -> f32 {
    (passage / IGNITE_SHARE).clamp(0.0, 1.0)
}

/// How far a glyph has cooled out of the front color into its settled shade:
/// `0.0` at the instant it ignites, `1.0` once the front has fully gone by.
fn cooling_of(passage: f32) -> f32 {
    ((passage - IGNITE_SHARE) / (1.0 - IGNITE_SHARE)).clamp(0.0, 1.0)
}

/// Per-glyph entrance opacity. Kept as its own name because the entrance's
/// arrival contract (nothing at 0, everything at 1, never dimming) is about
/// opacity alone and is pinned separately from the color the glyph arrives in.
///
/// Test-only: the painter already has the glyph's `front_passage` in hand and
/// calls [`ignition_of`] with it directly rather than recomputing the sweep.
/// This exists so the two arrival pins read as assertions about opacity.
#[cfg(test)]
fn reveal_opacity(diag: f32, progress: f32) -> f32 {
    ignition_of(front_passage(diag, progress))
}

/// Width of the soft materialize front, in normalized diagonal units.
///
/// Wide on purpose: at any instant this is the share of the art in motion, and
/// a narrow front over a ~0.6 s sweep at 12 fps puts only a sliver of the mark
/// in transition per frame — half the reason the first entrance read as
/// "literally nothing changed". Just over half the art is in flight here.
const REVEAL_EDGE: f32 = 0.55;

/// Share of the front's width spent igniting a glyph out of the background;
/// the remainder cools it from the front color to its settled shade.
///
/// Small, so the burn reads as a flash and the cooling as the long tail behind
/// it. Raising it toward 1.0 turns the entrance back into a fade-up out of the
/// canvas, which is the effect the operator could not see.
const IGNITE_SHARE: f32 = 0.16;

/// The shared painter behind every logo entry point. Split out from
/// [`render_into`] so a caller can pin its own palette and its own animation
/// phase: the room's welcome card uses the room palette (never the configurable
/// Grok theme) and its own card-relative clock.
fn render_into_shaded(area: Rect, buf: &mut Buffer, logo: &str, palette: LogoPalette, secs: f32) {
    let LogoPalette {
        base,
        hilite,
        background,
        front,
        reveal,
    } = palette;
    let lines: Vec<&str> = non_empty_lines(logo).collect();
    let rows = lines.len().max(1) as f32;
    let cols = lines
        .iter()
        .map(|l| l.chars().count())
        .max()
        .unwrap_or(1)
        .max(1) as f32;

    // Adjacent glyphs that land on the same blended color share one Span to
    // hold down the per-frame allocation.
    let logo_lines: Vec<Line> = lines
        .iter()
        .enumerate()
        .map(|(row, line)| {
            let mut spans: Vec<Span> = Vec::new();
            let mut run = String::new();
            let mut run_color: Option<Color> = None;
            for (col, ch) in line.chars().enumerate() {
                // Sweep along the bottom-left → top-right diagonal: the
                // coordinate grows as col increases and row decreases.
                let diag = (col as f32 + (rows - 1.0 - row as f32)) / (cols + rows);
                let lit = blend_color(base, hilite, shine_opacity(diag, secs)).unwrap_or(base);
                // Materialize last, in two stages: the front ignites the
                // already-shaded glyph out of the background, then the glyph
                // cools out of the front color down into `lit`.
                //
                // HAZARD: the settled case short-circuits to `lit` rather than
                // blending at opacity 1.0. On a 256-color terminal the theme
                // hands us `Color::Indexed`, and blend_color quantizes any
                // result touching an indexed input — a round trip that is not
                // guaranteed to land back on the same index. Settled art has to
                // be bit-identical to art that never had an entrance, so it must
                // not go through the blender at all.
                let passage = front_passage(diag, reveal);
                let color = if passage >= 1.0 {
                    lit
                } else {
                    let hot = blend_color(front, lit, cooling_of(passage)).unwrap_or(lit);
                    blend_color(background, hot, ignition_of(passage)).unwrap_or(hot)
                };
                if run_color != Some(color) {
                    if let Some(prev) = run_color {
                        spans.push(Span::styled(
                            std::mem::take(&mut run),
                            Style::default().fg(prev),
                        ));
                    }
                    run_color = Some(color);
                }
                run.push(ch);
            }
            if let Some(prev) = run_color {
                spans.push(Span::styled(run, Style::default().fg(prev)));
            }
            Line::from(spans).alignment(Alignment::Center)
        })
        .collect();
    Paragraph::new(logo_lines).render(area, buf);
}

/// [`CARD_LOGO`] with its all-blank top and bottom rows dropped.
///
/// The asset carries three blank rows (one above the mark, two below) as
/// padding for the stacked layout. The card draws its own border and its own
/// padding, so it needs the mark's real extent — otherwise the box frames the
/// asset's whitespace instead of hugging the art.
///
/// Computed once. The asset is baked into the binary, so the answer can never
/// change, and the shine sweep reads its diagonal off these dimensions on every
/// frame.
fn card_logo_art() -> &'static str {
    static TRIMMED: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    TRIMMED
        .get_or_init(|| {
            let has_ink = |line: &&str| {
                line.chars()
                    .any(|glyph| glyph != BRAILLE_BLANK && !glyph.is_whitespace())
            };
            let lines: Vec<&str> = CARD_LOGO.lines().collect();
            match (
                lines.iter().position(has_ink),
                lines.iter().rposition(has_ink),
            ) {
                (Some(first), Some(last)) => lines[first..=last].join("\n"),
                // An all-blank asset has no extent to find; hand back what is
                // there rather than inventing a crop.
                _ => CARD_LOGO.to_owned(),
            }
        })
        .as_str()
}

/// Rows the card's hero mark occupies, or 0 where braille is suppressed.
pub fn card_logo_line_count() -> u16 {
    if logo_hidden() {
        0
    } else {
        count_lines(card_logo_art())
    }
}

/// Columns the card's hero mark occupies, or 0 where braille is suppressed.
pub fn card_logo_visual_width() -> u16 {
    if logo_hidden() {
        0
    } else {
        visual_width(card_logo_art())
    }
}

/// Paint the card's hero mark with a caller-supplied palette and animation
/// phase. Draws nothing where [`logo_hidden`] holds, matching the zero this
/// module's other card entry points report.
pub fn render_card_logo_at(area: Rect, buf: &mut Buffer, palette: LogoPalette, secs: f32) {
    if !logo_hidden() {
        render_into_shaded(area, buf, card_logo_art(), palette, secs);
    }
}

pub fn logo_line_count(window_height: u16) -> u16 {
    pick_logo(window_height).map_or(0, count_lines)
}

pub fn logo_visual_width(window_height: u16) -> u16 {
    pick_logo(window_height).map_or(24, visual_width)
}

pub fn render_logo(area: Rect, buf: &mut Buffer, theme: &Theme, window_height: u16) {
    if let Some(logo) = pick_logo(window_height) {
        render_into(area, buf, theme, logo);
    }
}

/// Height-tiered logo painted with a caller-supplied palette at a caller-chosen
/// animation phase — the entry point for surfaces that are not the welcome
/// screen. Honors the same tiers and the same legacy-console suppression as
/// [`render_logo`]; use [`logo_line_count`] to budget its rows.
///
/// HAZARD: `secs = 0.0` parks the shine band off the bottom-left corner, so the
/// art paints flat in `base` with no sheen at all. That is correct for a caller
/// animating from zero (the sheen arrives on its own at ~0.64 s), and wrong for
/// a caller drawing ONE still frame — that one wants [`FROZEN_SHINE_SECS`].
pub fn render_logo_shaded_at(
    area: Rect,
    buf: &mut Buffer,
    window_height: u16,
    palette: LogoPalette,
    secs: f32,
) {
    if let Some(logo) = pick_logo(window_height) {
        render_into_shaded(area, buf, logo, palette, secs);
    }
}

/// The animation phase that centers the shine band on the art's diagonal.
///
/// Derived from [`shine_opacity`]: the band's position is
/// `-BAND + q * (1 + 2 * BAND)` with `q = (secs % CYCLE) / CYCLE / SWEEP_FRAC`,
/// so the band sits at the midpoint (0.5) when `q = 0.5`, i.e. at
/// `secs = CYCLE * SWEEP_FRAC / 2 = 4.0 * 0.32 / 2`. Pinned by
/// `frozen_phase_centers_the_shine_band`.
pub const FROZEN_SHINE_SECS: f32 = 0.64;

/// The hero box always shows the full logo: it is laid out beside the menu, so
/// it fits whenever the box does. These report and render that logo directly,
/// independent of the height-based [`pick_logo`] tiers used by the stacked
/// layout. When [`logo_hidden`], they report 0 and render nothing.
pub fn full_logo_line_count() -> u16 {
    full_logo_line_count_for(logo_hidden())
}

fn full_logo_line_count_for(hidden: bool) -> u16 {
    if hidden { 0 } else { count_lines(LOGO) }
}

pub fn full_logo_visual_width() -> u16 {
    full_logo_visual_width_for(logo_hidden())
}

fn full_logo_visual_width_for(hidden: bool) -> u16 {
    if hidden { 0 } else { visual_width(LOGO) }
}

pub fn render_full_logo(area: Rect, buf: &mut Buffer, theme: &Theme) {
    if !logo_hidden() {
        render_into(area, buf, theme, LOGO);
    }
}

/// Line count of the small logo used in minimal's committed welcome card
/// (0 on a legacy Windows console, where the braille art is suppressed).
pub fn compact_logo_line_count() -> u16 {
    if logo_hidden() {
        0
    } else {
        count_lines(LOGO_SMALL)
    }
}

/// Render the small braille logo (centered) into `area` for minimal's welcome
/// card. No-op when the logo is hidden.
pub fn render_compact_logo(area: Rect, buf: &mut Buffer, theme: &Theme) {
    if !logo_hidden() {
        render_into(area, buf, theme, LOGO_SMALL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logo_sizes_by_height() {
        assert!(pick_logo_for(SMALL_LOGO_MIN_HEIGHT - 1, false).is_none());
        assert_eq!(
            pick_logo_for(SMALL_LOGO_MIN_HEIGHT, false),
            Some(LOGO_SMALL)
        );
        assert_eq!(
            pick_logo_for(FULL_LOGO_MIN_HEIGHT - 1, false),
            Some(LOGO_SMALL)
        );
        assert_eq!(pick_logo_for(FULL_LOGO_MIN_HEIGHT, false), Some(LOGO));
    }

    // The braille art has no legacy-safe stand-in, so every height tier must
    // collapse to no logo when the legacy-console flag is set.
    #[test]
    fn logo_hidden_on_legacy_console_at_every_height() {
        for h in [0, SMALL_LOGO_MIN_HEIGHT, FULL_LOGO_MIN_HEIGHT, u16::MAX] {
            assert!(pick_logo_for(h, true).is_none(), "height {h}");
        }
    }

    #[test]
    fn hero_box_always_uses_full_logo() {
        // The box renders the full logo regardless of height (it's laid out
        // beside the menu), and it's the large variant — never the small one.
        assert_eq!(full_logo_line_count_for(false), count_lines(LOGO));
        assert_eq!(full_logo_visual_width_for(false), visual_width(LOGO));
        assert!(full_logo_line_count_for(false) > count_lines(LOGO_SMALL));
        assert!(full_logo_visual_width_for(false) > visual_width(LOGO_SMALL));
    }

    #[test]
    fn full_logo_helpers_collapse_when_hidden() {
        assert_eq!(full_logo_line_count_for(true), 0);
        assert_eq!(full_logo_visual_width_for(true), 0);
    }

    #[test]
    fn compact_logo_line_count_matches_small_logo_when_visible() {
        // The minimal welcome card budgets exactly the small logo's rows. When
        // the logo isn't hidden, the count equals the small art's line count and
        // is strictly shorter than the full logo.
        if !logo_hidden() {
            assert_eq!(compact_logo_line_count(), count_lines(LOGO_SMALL));
            assert!(compact_logo_line_count() < count_lines(LOGO));
            assert!(compact_logo_line_count() > 0);
        } else {
            assert_eq!(compact_logo_line_count(), 0);
        }
    }

    #[test]
    fn shine_opacity_stays_in_unit_range() {
        let mut secs = 0.0;
        while secs < 10.0 {
            for i in 0..=20 {
                let diag = i as f32 / 20.0;
                let op = shine_opacity(diag, secs);
                assert!(
                    (0.0..=1.0).contains(&op),
                    "opacity {op} out of range at diag {diag}, secs {secs}"
                );
            }
            secs += 0.13;
        }
    }

    #[test]
    fn shine_band_sweeps_across() {
        // The brightest point along the diagonal advances left → right as the
        // sweep progresses through its active phase.
        let brightest = |secs: f32| -> f32 {
            (0..=100)
                .map(|i| i as f32 / 100.0)
                .max_by(|a, b| {
                    shine_opacity(*a, secs)
                        .partial_cmp(&shine_opacity(*b, secs))
                        .unwrap()
                })
                .unwrap()
        };
        let early = brightest(0.1);
        let mid = brightest(0.4);
        let late = brightest(0.7);
        assert!(early < mid, "early {early} should precede mid {mid}");
        assert!(mid < late, "mid {mid} should precede late {late}");
    }

    // A surface that draws the logo exactly once picks its own phase, and the
    // obvious choice — 0.0 — is the one phase that renders the art completely
    // flat. Pin both halves: zero is dead, FROZEN_SHINE_SECS peaks mid-art.
    #[test]
    fn frozen_phase_centers_the_shine_band() {
        assert!(
            shine_opacity(0.5, 0.0) < 0.01,
            "phase 0 parks the band off-art, so a one-shot draw at 0.0 has no sheen"
        );

        let brightest = (0..=100)
            .map(|i| i as f32 / 100.0)
            .max_by(|a, b| {
                shine_opacity(*a, FROZEN_SHINE_SECS)
                    .partial_cmp(&shine_opacity(*b, FROZEN_SHINE_SECS))
                    .unwrap()
            })
            .unwrap();
        assert!(
            (brightest - 0.5).abs() < 0.02,
            "frozen phase should peak at the art's midpoint, peaked at {brightest}"
        );
        assert!(
            shine_opacity(0.5, FROZEN_SHINE_SECS) > 0.3,
            "frozen phase must be a visible sheen, not a resting pulse"
        );
    }

    // The materialize front: nothing at progress 0, everything at progress 1,
    // and never a glyph that dims as the entrance advances.
    #[test]
    fn the_reveal_front_sweeps_the_art_in_exactly_once() {
        for i in 0..=20 {
            let diag = i as f32 / 20.0;
            assert_eq!(
                reveal_opacity(diag, 0.0),
                0.0,
                "nothing is materialized at progress 0 (diag {diag})"
            );
            assert_eq!(
                reveal_opacity(diag, 1.0),
                1.0,
                "everything is materialized at progress 1 (diag {diag})"
            );

            let mut previous = 0.0;
            let mut step = 0.0;
            while step <= 1.0 {
                let now = reveal_opacity(diag, step);
                assert!(
                    now >= previous - f32::EPSILON,
                    "glyph at diag {diag} dimmed from {previous} to {now} at progress {step}"
                );
                assert!((0.0..=1.0).contains(&now), "opacity {now} out of range");
                previous = now;
                step += 0.05;
            }
        }
    }

    // The front really is a front: mid-entrance the leading corner is further
    // along than the trailing one. Without this, a constant would pass the
    // monotonicity check above.
    #[test]
    fn the_reveal_front_leads_at_the_sweep_origin() {
        let progress = 0.5;
        let leading = reveal_opacity(0.0, progress);
        let trailing = reveal_opacity(1.0, progress);
        assert!(
            leading > trailing,
            "the bottom-left corner must materialize first: {leading} vs {trailing}"
        );
        assert!(
            trailing < 1.0,
            "the far corner cannot already be complete at half-way"
        );
    }

    // The materialize has to be VISIBLE. The first build faded glyphs up out of
    // the canvas and nothing else; on a dark terminal that is indistinguishable
    // from an unchanged screen, which is exactly what the operator reported
    // ("literally nothing changed"). So the front burns in the caller's `front`
    // color as it passes, and every glyph cools out of it into the shade it
    // settles at.
    #[test]
    fn the_reveal_front_burns_in_the_front_color_then_cools_out_of_it() {
        let area = Rect::new(0, 0, 40, 12);
        let base = Color::Rgb(90, 98, 116);
        let hilite = Color::Rgb(230, 232, 239);
        let background = Color::Rgb(11, 13, 18);
        let front = Color::Rgb(57, 255, 20);

        let frame = |reveal: f32| {
            let mut buf = Buffer::empty(area);
            render_into_shaded(
                area,
                &mut buf,
                LOGO,
                LogoPalette {
                    base,
                    hilite,
                    background,
                    front,
                    reveal,
                },
                FROZEN_SHINE_SECS,
            );
            buf
        };

        // "Burning" is measured, not assumed: a cell whose green channel
        // dominates the way the front's does and the way neither the neutral
        // base, the neutral hilite, nor the near-black background ever can.
        let burning = |buf: &Buffer| {
            buf.content
                .iter()
                .filter(|cell| match cell.fg {
                    Color::Rgb(r, g, b) => {
                        g > 0xB0 && g > r.saturating_add(0x40) && g > b.saturating_add(0x40)
                    }
                    _ => false,
                })
                .count()
        };

        assert!(
            burning(&frame(0.5)) > 0,
            "the front must burn mid-sweep; an entrance nobody can see is not an entrance"
        );
        assert_eq!(
            burning(&frame(1.0)),
            0,
            "the front must cool into the settled shade, not stay lit"
        );

        let mut settled = Buffer::empty(area);
        render_into_shaded(
            area,
            &mut settled,
            LOGO,
            LogoPalette::settled(base, hilite),
            FROZEN_SHINE_SECS,
        );
        assert_eq!(
            frame(1.0),
            settled,
            "a completed entrance must land exactly on the art it settles into"
        );
    }

    // A settled palette must paint exactly what the logo painted before there
    // was any entrance at all.
    #[test]
    fn a_settled_palette_is_the_pre_entrance_render() {
        let area = Rect::new(0, 0, 40, 12);
        let base = Color::Rgb(90, 98, 116);
        let hilite = Color::Rgb(230, 232, 239);

        let mut settled = Buffer::empty(area);
        render_into_shaded(
            area,
            &mut settled,
            LOGO,
            LogoPalette::settled(base, hilite),
            FROZEN_SHINE_SECS,
        );

        let mut complete = Buffer::empty(area);
        render_into_shaded(
            area,
            &mut complete,
            LOGO,
            LogoPalette {
                base,
                hilite,
                background: Color::Rgb(11, 13, 18),
                front: Color::Rgb(57, 255, 20),
                reveal: 1.0,
            },
            FROZEN_SHINE_SECS,
        );

        assert_eq!(
            settled, complete,
            "a completed entrance must be indistinguishable from no entrance"
        );
    }

    #[test]
    fn shine_rests_dim_between_sweeps() {
        // During the rest phase the band is parked off-screen, so an interior
        // glyph falls back to at most the gentle pulse — never full bright.
        let op = shine_opacity(0.5, 6.0); // secs % 4.0 = 2.0 → past SWEEP_FRAC, in the rest phase
        assert!(op < 0.2, "resting opacity {op} should stay dim");
    }
}
