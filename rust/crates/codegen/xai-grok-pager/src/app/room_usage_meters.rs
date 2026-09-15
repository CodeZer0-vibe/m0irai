//! Which usage meters are worth showing, and what to drop when they do not fit.
//!
//! Both halves are ports of rules V1 already proved, and both exist because a meter that is WRONG is
//! worse than a meter that is missing.
//!
//! **The visible-meter policy** is V1's `visibleMeters`
//! (`D:\Zer0 Chat V2\sources\zer0-agent-ci\src\shared\usage-display-policy.ts:24-44`), ported whole.
//! V2 had carried two of its three rules and dropped the third, which is why a gemini lane showed
//! `wk 1%` next to a live 5-hour window — a weekly that low next to a 5h reading is noise occupying a
//! column that a real number wants. It lives at the RENDER layer, not at the producer, for three
//! reasons: the wire must keep carrying everything the room knows or the Node-side fold is destroyed
//! one layer later; `/status` and the footer share `footer_agent_cell`, so one predicate serves both
//! and cannot drift; and a producer-side filter would make "absent" and "suppressed" the same thing
//! downstream. It takes no agent argument — it is provider-agnostic, exactly as V1's was.
//!
//! **Whole-meter fitting** is V1's `fitCompactMeters`
//! (`…\src\tui\status-cell-text.ts:118-138`). Its own comment names the defect class in rendered
//! frames: `c10…` for a context window at 100% is a FABRICATED READING, where `w…` is honestly
//! absent. This room had the same defect one layer up — an 81% weekly rendered as `wk8…`, captured at
//! width 80 before this module existed:
//!
//! ```text
//! "◆ claude                   ● codex                    ▲ gemini ctx42% 5h71% wk8…"
//! ```
//!
//! ⚠ THE RULE IS PORTED, NOT THE ARITHMETIC. V1 measures `String.length`; this footer measures display
//! columns through `UnicodeWidthStr`, and a verbatim port would be wrong for every wide glyph.
//!
//! Upstream grok was read first for both. `views/agent_status.rs:30-38` builds named status items each
//! carrying its own measured `width: u16`, and that idea — decide what to drop from whole named items,
//! never from a rendered string — is what is adopted here. Its right-aligned separator layout
//! (`:80-133`) is NOT adopted: it lays out a variable dashboard across a full bar, while this is three
//! fixed-width roster cells. `views/context_bar.rs:180` returns `None` when usage is unavailable, and
//! that rule — unknown is not zero — is the one this file never breaks.

use unicode_width::UnicodeWidthStr;

use zer0_room_protocol::AgentUsageState;

/// A weekly reading below this, with a 5-hour reading present, is not worth the column.
///
/// 75 -> 70 by operator ruling (docs/FINDINGS.md FL-127, 2026-08-21): tuned to match the same 70%
/// boundary the colour ramp now uses, so "worth showing" and "worth a warning colour" agree.
const WEEKLY_LOW_THRESHOLD: u8 = 70;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum MeterKind {
    Context,
    FiveHour,
    Weekly,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) struct Meter {
    pub kind: MeterKind,
    pub pct: u8,
}

impl MeterKind {
    /// The label the dense form uses. `ctx`/`5h`/`wk`, unchanged from what the room already rendered.
    pub(super) const fn label(self) -> &'static str {
        match self {
            Self::Context => "ctx",
            Self::FiveHour => "5h",
            Self::Weekly => "wk",
        }
    }
}

/// V1's `visibleMeters`, ported whole. Three rules and two predicates, and each one is load-bearing:
///
/// - **context** renders whenever present, with no reset gate at all. A `0` here is a real reading of
///   an empty context window and renders as one.
/// - **five-hour** renders when present *and* fresh.
/// - **weekly** renders when present *and* fresh *and* worth the width.
///
/// A window with NO reset instant counts FRESH — a missing reset is not a stale window, it is a source
/// that did not say when the window turns over, and hiding a real number for that is the absent-versus-
/// zero mistake pointed the other way. V1 proves this edge in its own tests
/// (`usage-display-policy.test.ts:46-51`).
pub(super) fn visible_meters(usage: &AgentUsageState, now_ms: u64) -> Vec<Meter> {
    let mut meters = Vec::new();
    if let Some(pct) = usage.context_used_pct {
        meters.push(Meter {
            kind: MeterKind::Context,
            pct,
        });
    }
    if let Some(pct) = usage.five_hour_used_pct
        && window_is_fresh(usage.five_hour_resets_at_ms, now_ms)
    {
        meters.push(Meter {
            kind: MeterKind::FiveHour,
            pct,
        });
    }
    if let Some(pct) = usage.weekly_used_pct
        && weekly_is_worth_the_width(usage)
        && window_is_fresh(usage.weekly_resets_at_ms, now_ms)
    {
        meters.push(Meter {
            kind: MeterKind::Weekly,
            pct,
        });
    }
    meters
}

/// A missing reset is FRESH. See [`visible_meters`] for why.
fn window_is_fresh(resets_at_ms: Option<u64>, now_ms: u64) -> bool {
    resets_at_ms.is_none_or(|reset| reset > now_ms)
}

/// ⚠ READS THE RAW FIVE-HOUR FIELD, NOT THE VISIBLE FIVE-HOUR METER, and that is V1's rule rather than
/// an accident of the port. A 5-hour number whose reset has passed is HIDDEN by [`visible_meters`] and
/// still suppresses a low weekly here: the account has a 5-hour window, so a 12% weekly is still the
/// less interesting of the two things we could spend the column on. V1 proves exactly this edge
/// (`usage-display-policy.test.ts:31-44`, a fresh 44% weekly hidden because a STALE 5h exists).
///
/// The consequence that matters for codex: an account with NO 5-hour window at all — which is codex
/// today, OpenAI removed it — shows its weekly UNCONDITIONALLY, at any percentage. That is the rule V2
/// dropped, and dropping it is why the only meter codex has could vanish.
fn weekly_is_worth_the_width(usage: &AgentUsageState) -> bool {
    usage.five_hour_used_pct.is_none() || usage.weekly_used_pct.unwrap_or(0) >= WEEKLY_LOW_THRESHOLD
}

/// The dense row: `ctx42% 5h71% wk81%`. Space-joined, one label and one percentage each.
pub(super) fn dense_meter_text(meters: &[Meter]) -> String {
    meters
        .iter()
        .map(|meter| format!("{}{}%", meter.kind.label(), meter.pct))
        .collect::<Vec<_>>()
        .join(" ")
}

/// V1's `fitCompactMeters`, in display columns — returning WHICH meters survive rather than a
/// formatted string.
///
/// Drops WHOLE meters from the right while what remains still fits, keeping room for the marker that
/// says something is hidden. If not even one whole reading fits, keeps none and still asks for the
/// marker — because "there is a number here you cannot see" is true, and `wk8` for an 81% weekly is
/// not.
///
/// Returns the retained meters (a prefix of `meters`, oldest-first, same order) and whether the
/// marker is still needed. FL-127 is why this is a slice instead of the formatted string it used to
/// be: the caller colours each retained meter by its OWN value, and a pre-joined string cannot be
/// split back into per-meter pieces without re-parsing it.
///
/// The marker is passed in rather than chosen here so the caller supplies the room's own ellipsis,
/// which already carries an ASCII fallback for consoles that cannot draw `…`.
pub(super) fn fit_compact_kept<'a>(
    meters: &'a [Meter],
    available: usize,
    marker: &str,
) -> (&'a [Meter], bool) {
    let full = dense_meter_text(meters);
    if UnicodeWidthStr::width(full.as_str()) <= available {
        return (meters, false);
    }
    for keep in (1..meters.len()).rev() {
        let text = format!("{}{marker}", dense_meter_text(&meters[..keep]));
        if UnicodeWidthStr::width(text.as_str()) <= available {
            return (&meters[..keep], true);
        }
    }
    // Not even ONE whole reading fits. Say that something is hidden rather than show half a number —
    // and if the marker itself does not fit, say nothing at all.
    if UnicodeWidthStr::width(marker) <= available {
        (&meters[..0], true)
    } else {
        (&meters[..0], false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FUTURE: u64 = 4_102_444_800_000;
    const PAST: u64 = 1_000;
    const NOW: u64 = 1_800_000_000_000;

    fn usage(
        context: Option<u8>,
        five: Option<(u8, Option<u64>)>,
        weekly: Option<(u8, Option<u64>)>,
    ) -> AgentUsageState {
        AgentUsageState {
            exhausted: false,
            context_used_pct: context,
            five_hour_used_pct: five.map(|(pct, _)| pct),
            five_hour_resets_at_ms: five.and_then(|(_, reset)| reset),
            weekly_used_pct: weekly.map(|(pct, _)| pct),
            weekly_resets_at_ms: weekly.and_then(|(_, reset)| reset),
        }
    }

    fn kinds(meters: &[Meter]) -> Vec<MeterKind> {
        meters.iter().map(|meter| meter.kind).collect()
    }

    /// Formats `fit_compact_kept`'s (kept meters, needs-marker) pair back into the single string the
    /// boundary tests below were written against, so the arithmetic they pin reads exactly as it did
    /// before the FL-127 split — production never calls this: `room_runtime.rs` renders each retained
    /// meter as its own coloured span and has no use for the joined string.
    fn fitted_text(meters: &[Meter], available: usize, marker: &str) -> String {
        let (kept, needs_marker) = fit_compact_kept(meters, available, marker);
        if needs_marker {
            format!("{}{marker}", dense_meter_text(kept))
        } else {
            dense_meter_text(kept)
        }
    }

    /// F3e. THE OPERATOR'S TUNE, FL-127: 75 -> 70. Below the new floor, still hidden.
    #[test]
    fn a_weekly_at_69_beside_a_live_five_hour_is_still_not_worth_the_column() {
        let meters = visible_meters(
            &usage(Some(42), Some((71, Some(FUTURE))), Some((69, Some(FUTURE)))),
            NOW,
        );
        assert_eq!(
            kinds(&meters),
            vec![MeterKind::Context, MeterKind::FiveHour]
        );
    }

    /// F3f. THE OPERATOR'S TUNE, FL-127: 75 -> 70. AT the new floor, now worth it — this is the exact
    /// value the old 75 threshold would have hidden, so a revert of the tune turns this test red.
    #[test]
    fn a_weekly_at_70_beside_a_live_five_hour_is_now_worth_the_column() {
        let meters = visible_meters(
            &usage(Some(42), Some((71, Some(FUTURE))), Some((70, Some(FUTURE)))),
            NOW,
        );
        assert_eq!(
            kinds(&meters),
            vec![MeterKind::Context, MeterKind::FiveHour, MeterKind::Weekly]
        );
    }

    /// F3a. THE RULE V2 DROPPED. Captured before this module existed, at width 180:
    /// `▲ gemini ◕ ctx 42%  ▰▰▰▰▱ 5h 71%  wk 1%`
    #[test]
    fn a_low_weekly_beside_a_live_five_hour_is_not_worth_the_column() {
        let meters = visible_meters(
            &usage(Some(42), Some((71, Some(FUTURE))), Some((1, Some(FUTURE)))),
            NOW,
        );
        assert_eq!(
            kinds(&meters),
            vec![MeterKind::Context, MeterKind::FiveHour]
        );
    }

    /// F3b. And the half that was already right: codex has NO five-hour window at all — OpenAI removed
    /// it — so its weekly is the only meter it has and shows unconditionally, including at zero. The
    /// operator confirmed twice that a `wk 0%` they saw was REAL data.
    #[test]
    fn a_weekly_with_no_five_hour_shows_at_any_percentage_including_zero() {
        let meters = visible_meters(&usage(Some(9), None, Some((0, Some(FUTURE)))), NOW);
        assert_eq!(kinds(&meters), vec![MeterKind::Context, MeterKind::Weekly]);
        assert_eq!(meters[1].pct, 0, "a real zero is a reading, not an absence");
    }

    /// F3c. THE STALE-5h EDGE, and the reason weekly_is_worth_the_width reads the RAW field. The
    /// 5-hour reading is hidden because its window turned over, and it STILL suppresses a 44% weekly:
    /// the account has a 5-hour window either way. V1 `usage-display-policy.test.ts:31-44`.
    #[test]
    fn a_stale_five_hour_is_hidden_and_still_suppresses_a_low_weekly() {
        let meters = visible_meters(
            &usage(Some(42), Some((71, Some(PAST))), Some((44, Some(FUTURE)))),
            NOW,
        );
        assert_eq!(
            kinds(&meters),
            vec![MeterKind::Context],
            "reading the VISIBLE 5h instead of the raw field shows the weekly here"
        );
    }

    /// F3d. A MISSING RESET COUNTS FRESH. A source that did not say when the window turns over has not
    /// said the window is over. V1 `usage-display-policy.test.ts:46-51`.
    #[test]
    fn a_window_with_no_reset_at_all_is_fresh() {
        let meters = visible_meters(&usage(None, None, Some((44, None))), NOW);
        assert_eq!(kinds(&meters), vec![MeterKind::Weekly]);
    }

    /// Context has no reset gate of its own, and a 0% context is a real reading of an empty window.
    #[test]
    fn context_renders_whenever_present_and_a_zero_is_a_reading() {
        let meters = visible_meters(&usage(Some(0), None, None), NOW);
        assert_eq!(kinds(&meters), vec![MeterKind::Context]);
        assert_eq!(meters[0].pct, 0);
    }

    /// An expired five-hour window disappears; an expired weekly disappears; the context survives both.
    #[test]
    fn expired_windows_never_render_and_context_outlives_them() {
        let meters = visible_meters(
            &usage(Some(42), Some((71, Some(PAST))), Some((99, Some(PAST)))),
            NOW,
        );
        assert_eq!(kinds(&meters), vec![MeterKind::Context]);
    }

    /// The whole boundary table around gemini's real budget at width 80, where FL-095 was captured.
    /// The cell is 26 columns, the mark `▲ gemini` is 8, so the suffix has 18 and the value inside it
    /// has 17. The three legal outputs and their exact widths:
    ///
    /// ```text
    /// ctx42% 5h71% wk81%   18
    /// ctx42% 5h71%…        13
    /// ctx42%…               7
    /// …                     1
    /// ```
    ///
    /// ⚠ THIS TABLE CAUGHT ITS AUTHOR. It was first written with `ctx42% 5h71%…` at 14 columns and the
    /// 13-column row expecting `ctx42%…`, and the test went red against correct code. A boundary table
    /// whose numbers are asserted rather than reasoned about is the difference between a test that
    /// checks arithmetic and one that inherits it.
    #[test]
    fn fitting_drops_whole_meters_and_never_half_a_number() {
        let meters = visible_meters(
            &usage(Some(42), Some((71, Some(FUTURE))), Some((81, Some(FUTURE)))),
            NOW,
        );
        assert_eq!(dense_meter_text(&meters), "ctx42% 5h71% wk81%");
        assert_eq!(fitted_text(&meters, 18, "…"), "ctx42% 5h71% wk81%");
        // One column short of the full row: the weekly goes WHOLE, not to `wk8…`.
        assert_eq!(fitted_text(&meters, 17, "…"), "ctx42% 5h71%…");
        assert_eq!(fitted_text(&meters, 13, "…"), "ctx42% 5h71%…");
        assert_eq!(fitted_text(&meters, 12, "…"), "ctx42%…");
        assert_eq!(fitted_text(&meters, 7, "…"), "ctx42%…");
        // Not even one whole reading fits: say something is hidden rather than show `ctx4`.
        assert_eq!(fitted_text(&meters, 6, "…"), "…");
        assert_eq!(fitted_text(&meters, 1, "…"), "…");
        assert_eq!(fitted_text(&meters, 0, "…"), "");
    }

    /// Every fitted output is a prefix of the full dense row plus the marker, at every width from zero
    /// up. That is the invariant "never half a number" stated so it cannot be satisfied by accident:
    /// a cut inside `42` produces `ctx4`, which is a prefix of no meter list at all.
    #[test]
    fn every_fitted_width_is_whole_meters_plus_a_marker() {
        let meters = visible_meters(
            &usage(Some(42), Some((71, Some(FUTURE))), Some((81, Some(FUTURE)))),
            NOW,
        );
        let legal = (0..=meters.len())
            .map(|keep| {
                if keep == meters.len() {
                    dense_meter_text(&meters)
                } else if keep == 0 {
                    "…".to_owned()
                } else {
                    format!("{}…", dense_meter_text(&meters[..keep]))
                }
            })
            .chain(std::iter::once(String::new()))
            .collect::<Vec<_>>();
        for available in 0..30 {
            let fitted = fitted_text(&meters, available, "…");
            assert!(
                legal.contains(&fitted),
                "width {available} produced {fitted:?}, which is not whole meters plus a marker"
            );
            assert!(
                UnicodeWidthStr::width(fitted.as_str()) <= available,
                "width {available} produced {fitted:?}, which overflows its budget"
            );
        }
    }

    /// The marker is the caller's, so a console with no `…` gets the room's ASCII fallback and the
    /// arithmetic still holds — the marker's own WIDTH is what the fit is measured against, and `..`
    /// is two columns where `…` is one.
    #[test]
    fn an_ascii_fallback_marker_is_measured_at_its_own_width() {
        let meters = visible_meters(
            &usage(Some(42), Some((71, Some(FUTURE))), Some((81, Some(FUTURE)))),
            NOW,
        );
        assert_eq!(fitted_text(&meters, 14, ".."), "ctx42% 5h71%..");
        // One narrower than the two-column marker allows, so the whole 5h meter goes.
        assert_eq!(fitted_text(&meters, 13, ".."), "ctx42%..");
        assert_eq!(fitted_text(&meters, 1, ".."), "");
    }
}
