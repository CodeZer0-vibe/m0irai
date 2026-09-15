//! The room's folded tool-step block — one keyed, mutable block per stream.
//!
//! Before this existed the room pushed one frozen `StubBlock` per terminal tool
//! call (`room_scrollback.rs`'s `push_frozen_activity`), so a lane that ran
//! eight tools left eight rows above its answer and every one of them wore a
//! check mark whether the tool succeeded or not. This block replaces that wall:
//! one entry per stream, mutated in place, that shows the last two steps while
//! the lane runs and collapses to a single `✓ 8 steps · 12s` summary when it
//! ends. Spec §7 (`docs/specs/2026-08-20-release-polish-wave-spec.md`) is the
//! contract; §C.5's status table is reproduced in [`StepOutcome::classify`].
//!
//! Upstream grok folds a run of tool rows the same way — `VerbRun`/`Truncation`
//! synthetic headers at `scrollback/state/groups.rs:46-61` — but that model is a
//! layout-time grouping over a run of adjacent `ToolCallBlock` entries, and the
//! room has none. What is adopted from it here, rather than invented: the
//! ` · N failed` suffix in the error colour appended only when non-zero
//! (grok-ref `scrollback/state/verb_group.rs:397-401`), count-driven
//! pluralization (`scrollback/blocks/tool/mod.rs:137-151` `noun(count)`), the
//! `+N more` remainder wording (`scrollback/wrappers/entry_renderer.rs:366-368`),
//! and the omit-rather-than-truncate expand hint
//! (`scrollback/blocks/thinking.rs:31-50`).

use std::time::Duration;

use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use unicode_width::UnicodeWidthStr;
use zer0_room_protocol::LaneActivity;

use crate::appearance::AppearanceConfig;
use crate::room_runtime::truncate_width;
use crate::room_scrollback::activity_label;
use crate::room_theme::RoomTheme;
use crate::scrollback::block::BlockContent;
use crate::scrollback::types::{AccentStyle, BlockContext, BlockLine, BlockOutput, DisplayMode};

/// How many terminal steps stay visible while the lane runs and the row is
/// collapsed (§C.3.2). Two, and named rather than repeated: the remainder
/// count, the window slice and the "is there a remainder at all" test all have
/// to agree, and three literals is how they stop agreeing.
const LIVE_WINDOW_STEPS: usize = 2;

/// The gap and the text of the collapsed row's expand affordance.
///
/// `ctrl+e` is hard-coded, exactly as grok's own copy of this string is
/// (`scrollback/blocks/thinking.rs:17-19` carries the same TODO): the room's
/// fold chord is matched literally in `room_runtime.rs`'s
/// `handle_scrollback_key` rather than resolved through a keybinding registry.
/// If the fold chord ever moves, this string is wrong and nothing will say so.
const EXPAND_HINT: &str = "(ctrl+e to expand)";
const EXPAND_HINT_GAP: &str = "  ";

/// What one tool call's latest reported status means for the summary.
///
/// §C.5's table, and the whole of it. `failed` is the only failure — read off
/// the table, never guessed from a name — and anything outside the Agent Client
/// Protocol's four values (`pending | in_progress | completed | failed`,
/// `node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts:217`) is
/// terminal-but-unknown: counted in the step total, never in the failure total,
/// and never given a check mark, because a check over a status the room does
/// not understand is a guess presented as a fact.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StepOutcome {
    /// `pending`, `in_progress`, `running`, or no status at all. Not counted,
    /// not rendered — which is what the room does today, unchanged.
    NonTerminal,
    Completed,
    Failed,
    UnknownTerminal,
}

impl StepOutcome {
    /// Classify one activity's `status` field, case-insensitively.
    ///
    /// `running` is not an ACP value; it is in `activity_is_terminal`'s
    /// exclusion list in `room_scrollback.rs` already and stays there. This
    /// function does not change that terminal/non-terminal split — it adds the
    /// success/failure/unknown split on top of it.
    pub fn classify(status: Option<&str>) -> Self {
        let Some(status) = status else {
            return Self::NonTerminal;
        };
        match status.trim().to_ascii_lowercase().as_str() {
            "pending" | "in_progress" | "running" => Self::NonTerminal,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            _ => Self::UnknownTerminal,
        }
    }

    fn is_terminal(self) -> bool {
        !matches!(self, Self::NonTerminal)
    }
}

/// One tool call, keyed by `tool_call_id` and updated in place.
///
/// The label is stored UNSHORTENED. Shortening happens at render time against
/// `ctx.width` and nowhere else: the sync that builds this list is driven by
/// events and animation ticks, not by paints, so anything it baked in would be
/// wrong after the first resize.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoomStep {
    pub tool_call_id: String,
    pub label: String,
    pub outcome: StepOutcome,
}

/// One stream's tool steps, folded.
///
/// Created the first time a stream produces a terminal step and then mutated in
/// place for the rest of its life through `ScrollbackState::replace_room_steps`.
/// The entry id never changes, so nothing downstream has to track a moving
/// target and the structural scroll anchor is never re-armed by a step arriving.
///
/// `live` deliberately does NOT come from the entry's `is_running` flag: the
/// steps entry is never inserted into `ScrollbackState::running`, so it cannot
/// be swept by `finish_all_running` and cannot have its `display_mode` rewritten
/// by `finish_running_with_time`. That is what lets an operator who expands the
/// row before the answer lands keep it expanded. `output` must therefore never
/// branch on `ctx.is_running`; it is always false for this block.
///
/// `PartialEq` is load-bearing rather than convenience: `sync_lane_steps` runs
/// on every animation tick while a lane is live, and replacing an identical
/// block would bump the content generation and dirty the entry's height sixty
/// times a second for no visible change.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoomStepsBlock {
    live: bool,
    steps: Vec<RoomStep>,
    accent_color: Color,
    /// Wall-clock span of the run, `end − start`. `None` while the lane is
    /// live, and also when either timestamp is absent, unparseable, or the two
    /// are out of order — absent renders absent, and a `0s` invented from a
    /// missing timestamp is a measurement the room never made.
    duration: Option<Duration>,
}

impl RoomStepsBlock {
    /// The live form: the lane is still running, so there is no duration yet.
    pub fn live(activities: &[LaneActivity], accent_color: Color) -> Self {
        Self {
            live: true,
            steps: Self::steps_from(activities),
            accent_color,
            duration: None,
        }
    }

    /// The finalized form. Both the live fold sites and both rebuild paths come
    /// through here — a second construction path is how the two halves drift.
    ///
    /// Liveness is decided by WHICH constructor was called, never by whether a
    /// timestamp happened to be present: a lane that ended without a usable
    /// `terminal_at` has still ended, and inferring `live` from the timestamp
    /// would leave that lane rendering its running window forever.
    pub fn finalized(
        activities: &[LaneActivity],
        accent_color: Color,
        started_at: Option<&str>,
        end_at: Option<&str>,
    ) -> Self {
        Self {
            live: false,
            steps: Self::steps_from(activities),
            accent_color,
            duration: match (started_at, end_at) {
                (Some(start), Some(end)) => span_between(start, end),
                _ => None,
            },
        }
    }

    fn steps_from(activities: &[LaneActivity]) -> Vec<RoomStep> {
        activities
            .iter()
            .filter_map(|activity| {
                let label = activity_label(activity)?;
                Some(RoomStep {
                    tool_call_id: activity.tool_call_id.clone(),
                    label,
                    outcome: StepOutcome::classify(activity.status.as_deref()),
                })
            })
            .collect()
    }

    /// True while this block would paint nothing at all.
    ///
    /// The room asks before creating the entry: a stream with zero terminal
    /// steps gets no block, which is byte-identical to what it renders today.
    pub fn is_empty(&self) -> bool {
        !self.steps.iter().any(|step| step.outcome.is_terminal())
    }

    pub fn is_live(&self) -> bool {
        self.live
    }

    /// Terminal steps only, oldest first — the render order everywhere.
    fn terminal_steps(&self) -> impl Iterator<Item = &RoomStep> {
        self.steps.iter().filter(|step| step.outcome.is_terminal())
    }

    fn counts(&self) -> StepCounts {
        let mut counts = StepCounts::default();
        for step in self.terminal_steps() {
            counts.total += 1;
            match step.outcome {
                StepOutcome::Failed => counts.failed += 1,
                StepOutcome::UnknownTerminal => counts.unknown += 1,
                StepOutcome::Completed | StepOutcome::NonTerminal => {}
            }
        }
        counts
    }

    /// The full, untruncated summary text — what copy and search must see, and
    /// the source the narrow ladders shorten.
    pub fn summary_plain(&self) -> String {
        let counts = self.counts();
        let mut text = String::new();
        if counts.shows_check() {
            text.push_str(crate::glyphs::check_mark());
            text.push(' ');
        }
        text.push_str(&format!("{} {}", counts.total, steps_noun(counts.total)));
        if counts.failed > 0 {
            text.push_str(&format!(" · {} failed", counts.failed));
        }
        if let Some(duration) = self.duration {
            text.push_str(&format!(" · {}", crate::util::format_duration(duration)));
        }
        text
    }

    /// Every step label, unshortened, newline-joined, then the summary line.
    ///
    /// Copy and search must see the truth rather than the folded row: an
    /// operator searching for the tool call they watched run must find it even
    /// though the collapsed row says `✓ 8 steps`.
    pub fn full_text(&self) -> String {
        let mut lines = self
            .terminal_steps()
            .map(|step| step.label.clone())
            .collect::<Vec<_>>();
        lines.push(self.summary_plain());
        lines.join("\n")
    }

    pub fn accent_color(&self) -> Color {
        self.accent_color
    }

    /// The collapsed summary row (§C.3.1), narrowed to fit.
    ///
    /// Three ladders, one per renderable case, and the ladders ARE the rule:
    /// segments are ranked by what they CLAIM, not by position, which is why the
    /// failure ladder's third rung drops the step count on the left and keeps
    /// `2 failed` in the middle. "Something went wrong" is the one thing an
    /// operator must not miss.
    fn summary_line(&self, width: usize) -> Line<'static> {
        let theme = RoomTheme::current();
        let counts = self.counts();
        let duration = self
            .duration
            .map(|duration| crate::util::format_duration(duration));
        let count_text = format!("{} {}", counts.total, steps_noun(counts.total));

        if counts.failed > 0 {
            let failed_text = format!("{} failed", counts.failed);
            let mut rungs: Vec<Vec<Span<'static>>> = Vec::new();
            if let Some(duration) = duration.as_deref() {
                rungs.push(vec![
                    Span::styled(format!("{count_text} · "), Style::default().fg(theme.dim)),
                    Span::styled(failed_text.clone(), Style::default().fg(theme.dead)),
                    Span::styled(format!(" · {duration}"), Style::default().fg(theme.dim)),
                ]);
            }
            rungs.push(vec![
                Span::styled(format!("{count_text} · "), Style::default().fg(theme.dim)),
                Span::styled(failed_text.clone(), Style::default().fg(theme.dead)),
            ]);
            rungs.push(vec![Span::styled(
                failed_text.clone(),
                Style::default().fg(theme.dead),
            )]);
            return first_fitting(rungs, width).unwrap_or_else(|| {
                Line::from(Span::styled(
                    truncate_width(&failed_text, width),
                    Style::default().fg(theme.dead),
                ))
            });
        }

        // The clean and unknown-terminal ladders differ by exactly one thing: the
        // check mark, present at every rung of one and at no rung of the other.
        // A narrow rung must never grow a glyph its full form did not have — the
        // check is precisely what the room cannot honestly claim over a status it
        // does not understand, so it is the one thing that must not reappear as
        // the row gets shorter.
        let mark = if counts.shows_check() {
            format!("{} ", crate::glyphs::check_mark())
        } else {
            String::new()
        };
        let mut rungs: Vec<Vec<Span<'static>>> = Vec::new();
        if let Some(duration) = duration.as_deref() {
            rungs.push(vec![dim_span(format!("{mark}{count_text} · {duration}"))]);
        }
        rungs.push(vec![dim_span(format!("{mark}{count_text}"))]);
        rungs.push(vec![dim_span(format!("{mark}{}", counts.total))]);
        let last = format!("{mark}{}", counts.total);
        first_fitting(rungs, width)
            .unwrap_or_else(|| Line::from(dim_span(truncate_width(&last, width))))
    }

    /// One step row (§C.3.3): `✓ {label}` for a success, a bare label in the
    /// failure colour for a failure, a bare label in `dim` for a status the room
    /// does not understand.
    ///
    /// F-1's fix reuses the room's existing failure vocabulary and adds no
    /// glyph: `push_lane_outcome` already says "failed" with colour alone. The
    /// absence of the check plus red IS the room's failure language.
    fn step_line(&self, step: &RoomStep, width: usize) -> Line<'static> {
        let theme = RoomTheme::current();
        match step.outcome {
            StepOutcome::Completed => Line::from(dim_span(truncate_width(
                &format!("{} {}", crate::glyphs::check_mark(), step.label),
                width,
            ))),
            StepOutcome::Failed => Line::from(Span::styled(
                truncate_width(&step.label, width),
                Style::default().fg(theme.dead),
            )),
            // Unknown-terminal renders exactly as a success does minus the
            // check. Non-terminal never reaches here (`terminal_steps` filters
            // it) but the arm has to exist and rendering it as a plain label is
            // the least surprising thing it could do.
            StepOutcome::UnknownTerminal | StepOutcome::NonTerminal => {
                Line::from(dim_span(truncate_width(&step.label, width)))
            }
        }
    }

    /// The live window: `+N earlier steps` (only when N ≥ 1) then the last two
    /// terminal step rows.
    fn live_window(&self, width: usize) -> Vec<Line<'static>> {
        let theme = RoomTheme::current();
        let terminal = self.terminal_steps().collect::<Vec<_>>();
        let remainder = terminal.len().saturating_sub(LIVE_WINDOW_STEPS);
        let mut lines = Vec::new();
        if remainder >= 1 {
            let text = format!(
                "+{remainder} earlier {}",
                if remainder == 1 { "step" } else { "steps" }
            );
            lines.push(Line::from(Span::styled(
                // A very large remainder on a very small terminal is the one way
                // this line can overflow; the spec gives it no behaviour, so it
                // takes the room's own truncator and stays one row.
                truncate_width(&text, width),
                Style::default().fg(theme.faint),
            )));
        }
        for step in terminal.iter().skip(remainder) {
            lines.push(self.step_line(step, width));
        }
        lines
    }

    fn all_step_lines(&self, width: usize) -> Vec<Line<'static>> {
        self.terminal_steps()
            .map(|step| self.step_line(step, width))
            .collect()
    }
}

impl BlockContent for RoomStepsBlock {
    /// §C.1 item 6's four cases, as one expression with no wildcard.
    ///
    /// `DisplayMode` has THREE variants (`scrollback/types.rs:53-60`), so the
    /// spec's literal "four arms" would not compile. `Truncated` takes the
    /// collapsed presentation through an or-pattern. It is not reachable for
    /// this block at runtime — `default_display_mode` is `Collapsed`,
    /// `next_fold_mode`'s default never PRODUCES `Truncated`, the room binds no
    /// collapse key that would reach `collapse_mode`, and this entry is never in
    /// `ScrollbackState::running` — so the arm is a compile requirement rather
    /// than a behaviour, and it is pinned as one.
    ///
    /// Width is `ctx.width`, never `ctx.content_width()`: the latter subtracts
    /// `bullet_indent()` for the configured tool bullet, and no room block ever
    /// paints a bullet (`has_bullet` is false everywhere in the room), so it
    /// would silently give up two columns.
    fn output(&self, ctx: &BlockContext) -> BlockOutput {
        let width = ctx.width as usize;
        let mut lines = match (self.live, ctx.mode) {
            (true, DisplayMode::Collapsed | DisplayMode::Truncated) => self.live_window(width),
            (true, DisplayMode::Expanded) => self.all_step_lines(width),
            (false, DisplayMode::Collapsed | DisplayMode::Truncated) => {
                vec![self.summary_line(width)]
            }
            (false, DisplayMode::Expanded) => {
                let mut lines = self.all_step_lines(width);
                lines.push(self.summary_line(width));
                lines
            }
        };
        if let Some(last) = lines.last_mut() {
            append_expand_hint(last, ctx);
        }
        BlockOutput {
            lines: lines.into_iter().map(BlockLine::styled).collect(),
        }
    }

    /// Static, never animated. Today's frozen step rows already have a static
    /// rail; an animated one would be a rendered-output change nobody asked for.
    fn accent(&self, _ctx: &BlockContext) -> Option<AccentStyle> {
        Some(AccentStyle::static_color(self.accent_color))
    }

    /// `true` plus `Collapsed` makes the renderer grow a SECOND summary row
    /// above this one once a run passes `group_max_visible`, which would leave
    /// the operator reading two different counts of the same thing.
    fn is_groupable(&self) -> bool {
        false
    }

    /// The trait default is `true`, and the renderer turns that into one blank
    /// row above and one below. The room's step rows have never had them and the
    /// collapsed summary must occupy exactly one screen row.
    fn has_vpad_for(&self, _appearance: &AppearanceConfig) -> bool {
        false
    }

    /// `ScrollbackEntry::with_id` seeds `display_mode` from this, so the row is
    /// folded from birth and the fold needs no write.
    fn default_display_mode(&self) -> DisplayMode {
        DisplayMode::Collapsed
    }
}

#[derive(Default)]
struct StepCounts {
    total: usize,
    failed: usize,
    unknown: usize,
}

impl StepCounts {
    /// The check mark appears only when every counted step is `completed`. A
    /// check over a run containing a failure is the F-1 lie in summary form; a
    /// check over a run containing a status the room does not understand is a
    /// guess.
    fn shows_check(&self) -> bool {
        self.total > 0 && self.failed == 0 && self.unknown == 0
    }
}

fn dim_span(text: String) -> Span<'static> {
    Span::styled(text, Style::default().fg(RoomTheme::current().dim))
}

fn line_width(spans: &[Span<'static>]) -> usize {
    spans
        .iter()
        .map(|span| UnicodeWidthStr::width(span.content.as_ref()))
        .sum()
}

/// The first rung that fits, or `None` when even the shortest overflows.
fn first_fitting(rungs: Vec<Vec<Span<'static>>>, width: usize) -> Option<Line<'static>> {
    rungs
        .into_iter()
        .find(|spans| line_width(spans) <= width)
        .map(Line::from)
}

/// Append `  (ctrl+e to expand)` to a collapsed row, and only ever to a
/// collapsed row of a SELECTED entry.
///
/// Omitted entirely rather than truncated or wrapped when it does not fit — the
/// shape grok uses at `scrollback/blocks/thinking.rs:31-50`. The reason is a
/// cache invariant, not taste: `desired_height` caches with `is_selected: false`
/// while `render` caches with the real value, so a hint that added a row would
/// thrash the height cache every time the selection moved.
///
/// Exact `Collapsed`, not the `Collapsed | Truncated` group `output` matches on:
/// the hint claims a specific key produces a specific change, and `Truncated`
/// is not a state this block's fold can reach.
fn append_expand_hint(line: &mut Line<'static>, ctx: &BlockContext) {
    if !ctx.is_selected || ctx.mode != DisplayMode::Collapsed {
        return;
    }
    let hint = format!("{EXPAND_HINT_GAP}{EXPAND_HINT}");
    if line_width(&line.spans) + UnicodeWidthStr::width(hint.as_str()) > ctx.width as usize {
        return;
    }
    line.spans.push(Span::styled(
        hint,
        Style::default().fg(RoomTheme::current().faint),
    ));
}

/// Pluralize by count, the shape grok's `noun(count)` uses
/// (`scrollback/blocks/tool/mod.rs:137-151`).
fn steps_noun(count: usize) -> &'static str {
    if count == 1 { "step" } else { "steps" }
}

/// `end − start`, both RFC3339.
///
/// Deliberately NOT `elapsed_seconds`, which measures against `Utc::now()` — a
/// folded row using that would keep counting up while the operator looked at it.
/// An unparseable timestamp or a negative span yields `None`, and the caller
/// omits the segment rather than printing `0s`: the protocol validates each
/// timestamp as RFC3339 but never validates that one precedes the other.
fn span_between(started_at: &str, end_at: &str) -> Option<Duration> {
    let started = chrono::DateTime::parse_from_rfc3339(started_at).ok()?;
    let ended = chrono::DateTime::parse_from_rfc3339(end_at).ok()?;
    ended.signed_duration_since(started).to_std().ok()
}

#[cfg(all(test, feature = "room-runtime"))]
mod tests {
    use super::*;
    use crate::room_theme::{RoomSecondaryGlyph, room_secondary};
    use ratatui::style::Color;
    use zer0_room_protocol::LaneActivityUpdate;

    const ACCENT: Color = Color::Rgb(1, 2, 3);

    fn activity(tool_call_id: &str, title: &str, status: Option<&str>) -> LaneActivity {
        LaneActivity {
            last_event_seq: "1".to_owned(),
            tool_call_id: tool_call_id.to_owned(),
            update: LaneActivityUpdate::ToolCall,
            title: Some(title.to_owned()),
            kind: None,
            status: status.map(str::to_owned),
        }
    }

    fn completed(n: usize) -> Vec<LaneActivity> {
        (0..n)
            .map(|i| {
                activity(
                    &format!("tool-{i}"),
                    &format!("step {i}"),
                    Some("completed"),
                )
            })
            .collect()
    }

    fn ctx(mode: DisplayMode, width: u16, is_selected: bool) -> BlockContext {
        BlockContext {
            mode,
            // Always false for this block: the steps entry is never inserted
            // into `ScrollbackState::running`. A test that set it true would be
            // asserting on a state the room cannot produce.
            is_running: false,
            width,
            raw: false,
            max_lines: None,
            appearance: AppearanceConfig::default(),
            is_selected,
            cwd: None,
        }
    }

    fn line_text(line: &BlockLine) -> String {
        line.content
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect()
    }

    fn rows(block: &RoomStepsBlock, mode: DisplayMode, width: u16) -> Vec<String> {
        block
            .output(&ctx(mode, width, false))
            .lines
            .iter()
            .map(line_text)
            .collect()
    }

    fn check() -> &'static str {
        crate::glyphs::check_mark()
    }

    fn ellipsis() -> &'static str {
        room_secondary(RoomSecondaryGlyph::Ellipsis)
    }

    /// SS-C.5's table, pinned as a table.
    ///
    /// What wrong implementation would still pass this? One that got a single
    /// row right — so every row of the published table is here, INCLUDING the
    /// rows that must classify the same way, and including the case-folding and
    /// the unknown default. `activity_is_terminal` used to own the
    /// terminal/non-terminal half of this split; its last two call sites went
    /// away with the frozen-row wall, so the split lives here now and this test
    /// is what keeps it from drifting.
    #[test]
    fn the_status_table_is_the_one_in_the_spec_and_failed_is_the_only_failure() {
        let table: &[(Option<&str>, StepOutcome)] = &[
            (Some("completed"), StepOutcome::Completed),
            (Some("failed"), StepOutcome::Failed),
            (Some("pending"), StepOutcome::NonTerminal),
            (Some("in_progress"), StepOutcome::NonTerminal),
            (Some("running"), StepOutcome::NonTerminal),
            (None, StepOutcome::NonTerminal),
            (Some("aborted"), StepOutcome::UnknownTerminal),
            (Some("cancelled"), StepOutcome::UnknownTerminal),
            (Some("error"), StepOutcome::UnknownTerminal),
            // Case-insensitive, per SS-C.5's column header.
            (Some("FAILED"), StepOutcome::Failed),
            (Some("Completed"), StepOutcome::Completed),
            (Some("In_Progress"), StepOutcome::NonTerminal),
        ];
        for (status, expected) in table {
            assert_eq!(
                StepOutcome::classify(*status),
                *expected,
                "status {status:?} must classify as {expected:?}"
            );
        }
        // The table's CONTENT, not only its rows: exactly one string in it is a
        // failure. A table that quietly gained a second failure vocabulary
        // (`"error"`, say) would satisfy every row above and still be wrong.
        let failures = table
            .iter()
            .filter(|(_, outcome)| *outcome == StepOutcome::Failed)
            .map(|(status, _)| status.expect("a failure status is a string"))
            .collect::<Vec<_>>();
        assert_eq!(failures, vec!["failed", "FAILED"]);
    }

    /// SS-C.12 site 2. Asserts the TABLE of remainder forms, not one row of it:
    /// a per-row loop over a fixture proves nothing about the fixture.
    ///
    /// What wrong implementation would still pass a per-row version? One that
    /// always printed the plural, or always printed a `+N` line, or capped at
    /// three rows unconditionally. All three are caught here because the three
    /// cases are asserted against each other.
    #[test]
    fn only_the_last_two_steps_are_live_with_a_named_remainder() {
        let cases: &[(usize, Option<&str>, usize)] = &[
            (5, Some("+3 earlier steps"), 3),
            (3, Some("+1 earlier step"), 3),
            (2, None, 2),
            (1, None, 1),
        ];
        for (count, remainder, expected_rows) in cases {
            let block = RoomStepsBlock::live(&completed(*count), ACCENT);
            let painted = rows(&block, DisplayMode::Collapsed, 80);
            assert_eq!(
                painted.len(),
                *expected_rows,
                "{count} live steps must paint {expected_rows} rows: {painted:?}"
            );
            match remainder {
                Some(text) => assert_eq!(&painted[0], text, "{count} steps"),
                None => assert!(
                    !painted.iter().any(|row| row.starts_with('+')),
                    "{count} steps must have no remainder row: {painted:?}"
                ),
            }
            // The window is the LAST two, not the first two.
            assert_eq!(
                painted.last().expect("at least one row"),
                &format!("{} step {}", check(), count - 1)
            );
        }
    }

    /// SS-C.12 site 3, plus the `content_width()` trap.
    ///
    /// The spec's 60/200 pair cannot see the trap: at both widths a 400-char
    /// label truncates either way, so a block that shortened against
    /// `content_width()` would pass. The first fixture is a boundary — the row
    /// is EXACTLY `width` columns — so it fits against `ctx.width` and does not
    /// fit against `content_width()`, which is `width - 2` for the default
    /// diamond tool bullet.
    #[test]
    fn a_long_step_renders_as_exactly_one_line_that_tracks_the_width() {
        let width = 40u16;
        let label = "x".repeat(usize::from(width) - 2);
        let block = RoomStepsBlock::live(&[activity("tool-0", &label, Some("completed"))], ACCENT);
        let painted = rows(&block, DisplayMode::Collapsed, width);
        assert_eq!(painted.len(), 1);
        assert_eq!(
            painted[0],
            format!("{} {label}", check()),
            "a row that exactly fills ctx.width must not be shortened - \
             shortening against content_width() loses two columns here"
        );

        let long = "y".repeat(400);
        let block = RoomStepsBlock::live(&[activity("tool-0", &long, Some("completed"))], ACCENT);
        let narrow = rows(&block, DisplayMode::Collapsed, 60);
        assert_eq!(narrow.len(), 1, "one line, never wrapped: {narrow:?}");
        assert!(
            narrow[0].ends_with(ellipsis()),
            "a sheared label must say so: {:?}",
            narrow[0]
        );
        let wide = rows(&block, DisplayMode::Collapsed, 200);
        assert_eq!(wide.len(), 1);
        assert!(
            UnicodeWidthStr::width(wide[0].as_str()) > UnicodeWidthStr::width(narrow[0].as_str()),
            "a wider terminal must show strictly more of the label"
        );
    }

    /// SS-C.12 site 5.
    ///
    /// What wrong implementation would still pass? One that hard-coded the
    /// plural, so the 1-step case is here too; and one that measured against
    /// `Utc::now()` instead of `end - start`, which would produce years rather
    /// than `12s` for these fixed 2026 timestamps.
    #[test]
    fn the_summary_names_its_count_and_its_duration() {
        let block = RoomStepsBlock::finalized(
            &completed(5),
            ACCENT,
            Some("2026-08-02T00:00:00Z"),
            Some("2026-08-02T00:00:12.300Z"),
        );
        assert_eq!(
            rows(&block, DisplayMode::Collapsed, 80),
            vec![format!("{} 5 steps · 12s", check())]
        );

        let block = RoomStepsBlock::finalized(
            &completed(1),
            ACCENT,
            Some("2026-08-02T00:00:00Z"),
            Some("2026-08-02T00:00:04.200Z"),
        );
        assert_eq!(
            rows(&block, DisplayMode::Collapsed, 80),
            vec![format!("{} 1 step · 4.2s", check())]
        );
    }

    /// SS-C.12 site 7.
    ///
    /// What wrong implementation would still pass? One that truncated the hint
    /// instead of omitting it — hence the assertion that the row is byte-equal
    /// to the unselected row, not merely that it is one line.
    #[test]
    fn the_expand_hint_is_omitted_rather_than_truncated() {
        let block = RoomStepsBlock::finalized(
            &completed(8),
            ACCENT,
            Some("2026-08-02T00:00:00Z"),
            Some("2026-08-02T00:00:12Z"),
        );
        let bare = rows(&block, DisplayMode::Collapsed, 80);

        let wide = block.output(&ctx(DisplayMode::Collapsed, 80, true));
        assert_eq!(wide.lines.len(), 1);
        assert!(
            line_text(&wide.lines[0]).ends_with("  (ctrl+e to expand)"),
            "a wide selected row carries the hint: {:?}",
            line_text(&wide.lines[0])
        );

        // 20 columns: the summary fits, the hint cannot.
        let tight = block.output(&ctx(DisplayMode::Collapsed, 20, true));
        assert_eq!(tight.lines.len(), 1, "never a second row");
        assert_eq!(
            line_text(&tight.lines[0]),
            rows(&block, DisplayMode::Collapsed, 20)[0],
            "a hint that will not fit leaves the row exactly as it was"
        );
        assert!(!bare[0].contains("ctrl+e"));
    }

    /// SS-C.12 site 8. This is F-1: today every frozen step row wears a check
    /// mark, failures included, so the room tells the operator a failed call
    /// succeeded.
    ///
    /// What wrong implementation would still pass? One that dropped the check
    /// from the summary but kept it on the individual failed row — so the
    /// expanded rows are asserted too, by colour as well as by glyph.
    #[test]
    fn a_failed_step_wears_no_check_and_the_summary_drops_its_check() {
        let mut activities = completed(8);
        activities[2].status = Some("failed".to_owned());
        activities[5].status = Some("failed".to_owned());
        let block = RoomStepsBlock::finalized(
            &activities,
            ACCENT,
            Some("2026-08-02T00:00:00Z"),
            Some("2026-08-02T00:00:12Z"),
        );

        let summary = block.output(&ctx(DisplayMode::Collapsed, 80, false));
        assert_eq!(summary.lines.len(), 1);
        let text = line_text(&summary.lines[0]);
        assert_eq!(text, "8 steps · 2 failed · 12s");
        assert!(!text.contains(check()), "no check over a run that failed");
        let failure_span = summary.lines[0]
            .content
            .spans
            .iter()
            .find(|span| span.content.as_ref() == "2 failed")
            .expect("the failure count is its own span");
        assert_eq!(failure_span.style.fg, Some(RoomTheme::current().dead));

        let expanded = block.output(&ctx(DisplayMode::Expanded, 80, false));
        assert_eq!(expanded.lines.len(), 9, "eight step rows then the summary");
        // The summary is the last line and it carries a failure-coloured span
        // of its own; the step rows are everything before it.
        let failed_rows = expanded.lines[..8]
            .iter()
            .filter(|line| {
                line.content
                    .spans
                    .iter()
                    .any(|span| span.style.fg == Some(RoomTheme::current().dead))
            })
            .collect::<Vec<_>>();
        assert_eq!(
            failed_rows.len(),
            2,
            "two failed rows, in the failure colour"
        );
        for row in failed_rows {
            let text = line_text(row);
            assert!(
                !text.contains(check()),
                "a failed step wears no check: {text}"
            );
        }

        // The exactly-one-failure form is singular.
        let mut one = completed(3);
        one[1].status = Some("failed".to_owned());
        let block = RoomStepsBlock::finalized(
            &one,
            ACCENT,
            Some("2026-08-02T00:00:00Z"),
            Some("2026-08-02T00:00:09.400Z"),
        );
        assert_eq!(
            rows(&block, DisplayMode::Collapsed, 80),
            vec!["3 steps · 1 failed · 9.4s".to_owned()]
        );
    }

    /// SS-C.12 site 9.
    ///
    /// What wrong implementation would still pass? One that counted the unknown
    /// step as a failure — so `failed` is asserted absent as well as the check.
    #[test]
    fn an_unknown_terminal_status_counts_but_claims_nothing() {
        let block = RoomStepsBlock::finalized(
            &[activity("tool-0", "unusual step", Some("aborted"))],
            ACCENT,
            Some("2026-08-02T00:00:00Z"),
            Some("2026-08-02T00:00:12Z"),
        );
        let painted = rows(&block, DisplayMode::Collapsed, 80);
        assert_eq!(painted, vec!["1 step · 12s".to_owned()]);
        assert!(!painted[0].contains(check()));
        assert!(!painted[0].contains("failed"));

        let expanded = rows(&block, DisplayMode::Expanded, 80);
        assert_eq!(
            expanded,
            vec!["unusual step".to_owned(), "1 step · 12s".to_owned()]
        );
    }

    /// SS-C.12 site 11.
    ///
    /// What wrong implementation would still pass? One that passed the whole
    /// row through `truncate_width` at every rung, which fits and is one line
    /// and still cuts `failed` in half. The `failed` word is asserted COMPLETE
    /// at every width, and the rung is asserted to be one of the published
    /// forms rather than merely short enough.
    #[test]
    fn the_narrow_ladder_never_clips_the_failure_count() {
        let mut activities = completed(8);
        activities[1].status = Some("failed".to_owned());
        activities[4].status = Some("failed".to_owned());
        let block = RoomStepsBlock::finalized(
            &activities,
            ACCENT,
            Some("2026-08-02T00:00:00Z"),
            Some("2026-08-02T00:00:12Z"),
        );
        let ladder = ["8 steps · 2 failed · 12s", "8 steps · 2 failed", "2 failed"];
        for width in [33u16, 20, 13] {
            let painted = rows(&block, DisplayMode::Collapsed, width);
            assert_eq!(painted.len(), 1, "one row at {width}");
            let row = &painted[0];
            assert!(
                UnicodeWidthStr::width(row.as_str()) <= usize::from(width),
                "{row:?} overflows {width}"
            );
            assert!(
                ladder.contains(&row.as_str()),
                "{row:?} at {width} is not one of the published rungs"
            );
            assert!(
                row.contains("2 failed"),
                "the failure count survives every rung: {row:?} at {width}"
            );
        }

        let clean = RoomStepsBlock::finalized(
            &completed(8),
            ACCENT,
            Some("2026-08-02T00:00:00Z"),
            Some("2026-08-02T00:00:12Z"),
        );
        let clean_ladder = [
            format!("{} 8 steps · 12s", check()),
            format!("{} 8 steps", check()),
            format!("{} 8", check()),
        ];
        for width in [33u16, 20, 13] {
            let painted = rows(&clean, DisplayMode::Collapsed, width);
            assert_eq!(painted.len(), 1);
            assert!(
                clean_ladder.contains(&painted[0]),
                "{:?} at {width} is not one of the clean rungs",
                painted[0]
            );
            assert!(
                painted[0].starts_with(check()),
                "the clean ladder keeps its check at every rung: {:?}",
                painted[0]
            );
        }
    }

    /// SS-C.12 site 12: absent renders absent.
    ///
    /// Mutation this is built to catch: substituting a zero when a timestamp is
    /// missing, which makes the row claim `0.0s` — a measurement the room never
    /// made. Both directions are covered, plus the out-of-order case the
    /// protocol does not validate.
    #[test]
    fn a_duration_is_absent_when_started_at_is() {
        let missing_start =
            RoomStepsBlock::finalized(&completed(2), ACCENT, None, Some("2026-08-02T00:00:12Z"));
        assert_eq!(
            rows(&missing_start, DisplayMode::Collapsed, 80),
            vec![format!("{} 2 steps", check())]
        );

        let missing_end =
            RoomStepsBlock::finalized(&completed(2), ACCENT, Some("2026-08-02T00:00:00Z"), None);
        assert_eq!(
            rows(&missing_end, DisplayMode::Collapsed, 80),
            vec![format!("{} 2 steps", check())]
        );

        let unparseable = RoomStepsBlock::finalized(
            &completed(2),
            ACCENT,
            Some("not a timestamp"),
            Some("2026-08-02T00:00:12Z"),
        );
        assert_eq!(
            rows(&unparseable, DisplayMode::Collapsed, 80),
            vec![format!("{} 2 steps", check())]
        );

        let backwards = RoomStepsBlock::finalized(
            &completed(2),
            ACCENT,
            Some("2026-08-02T00:00:12Z"),
            Some("2026-08-02T00:00:00Z"),
        );
        assert_eq!(
            rows(&backwards, DisplayMode::Collapsed, 80),
            vec![format!("{} 2 steps", check())],
            "a negative span is not a duration"
        );

        // A genuinely zero span IS measured, and says so.
        let instant = RoomStepsBlock::finalized(
            &completed(2),
            ACCENT,
            Some("2026-08-02T00:00:00Z"),
            Some("2026-08-02T00:00:00Z"),
        );
        assert_eq!(
            rows(&instant, DisplayMode::Collapsed, 80),
            vec![format!("{} 2 steps · 0.0s", check())]
        );
    }

    /// SS-C.12 site 22.
    ///
    /// RED against an implementation that reuses the clean ladder for the
    /// unknown case, which is what a builder does when the case has no ladder of
    /// its own. Its sibling half — the clean case keeping its check at every
    /// rung — lives in `the_narrow_ladder_never_clips_the_failure_count`.
    #[test]
    fn the_unknown_terminal_narrow_ladder_never_grows_a_check_mark() {
        let mut activities = completed(8);
        activities[3].status = Some("aborted".to_owned());
        let block = RoomStepsBlock::finalized(
            &activities,
            ACCENT,
            Some("2026-08-02T00:00:00Z"),
            Some("2026-08-02T00:00:12Z"),
        );
        let ladder = ["8 steps · 12s", "8 steps", "8"];
        for width in [33u16, 20, 13] {
            let painted = rows(&block, DisplayMode::Collapsed, width);
            assert_eq!(painted.len(), 1);
            assert!(
                ladder.contains(&painted[0].as_str()),
                "{:?} at {width} is not one of the unknown rungs",
                painted[0]
            );
            assert!(
                !painted[0].contains(check()),
                "no rung may grow a check the full form did not have: {:?} at {width}",
                painted[0]
            );
            assert!(UnicodeWidthStr::width(painted[0].as_str()) <= usize::from(width));
        }
    }

    /// A producer that regresses a tool call from terminal back to non-terminal
    /// must hide the step without destroying anything.
    ///
    /// The spec says a record is created or updated from whatever state ARRIVES
    /// and the block renders that record's CURRENT state; it does not say what
    /// happens when the current state goes backwards. Latest-state wins, so the
    /// step stops being counted and stops being rendered — and the block is
    /// still a block, which is what keeps the entry alive.
    #[test]
    fn terminal_to_nonterminal_latest_state_is_hidden_without_removing_the_entry() {
        let mut activities = completed(2);
        let live = RoomStepsBlock::live(&activities, ACCENT);
        assert_eq!(rows(&live, DisplayMode::Collapsed, 80).len(), 2);

        activities[1].status = Some("in_progress".to_owned());
        let regressed = RoomStepsBlock::live(&activities, ACCENT);
        let painted = rows(&regressed, DisplayMode::Collapsed, 80);
        assert_eq!(painted, vec![format!("{} step 0", check())]);
        assert!(
            !regressed.is_empty(),
            "the surviving step keeps the block alive"
        );

        activities[0].status = Some("in_progress".to_owned());
        let all_gone = RoomStepsBlock::live(&activities, ACCENT);
        assert!(
            all_gone.is_empty(),
            "with nothing terminal left the block reports itself empty, and the \
             room's create-guard is what keeps an empty entry off the screen"
        );
    }

    /// SS-C.4: a repeated update for the same `tool_call_id` updates in place.
    ///
    /// The reducer is what does the upserting, so this is the block half: two
    /// records with the SAME id must count once. A `Vec<String>` implementation
    /// would count twice, which is what finding 14 was about.
    #[test]
    fn the_step_list_keeps_first_seen_order_and_one_record_per_tool_call() {
        let block = RoomStepsBlock::live(
            &[
                activity("tool-b", "second seen", Some("completed")),
                activity("tool-a", "first seen", Some("completed")),
            ],
            ACCENT,
        );
        assert_eq!(
            rows(&block, DisplayMode::Expanded, 80),
            vec![
                format!("{} second seen", check()),
                format!("{} first seen", check()),
            ],
            "render order is first-seen order, not sorted and not reversed"
        );
    }

    /// The compile-required `Truncated` arm.
    ///
    /// `DisplayMode` has three variants, so `match (live, ctx.mode)` cannot have
    /// four arms; `Truncated` joins `Collapsed` through an or-pattern. It is
    /// UNREACHABLE at runtime for this block — `default_display_mode` is
    /// `Collapsed`, the trait's `next_fold_mode` never produces `Truncated`, the
    /// room binds no key that reaches `collapse_mode`, and this entry is never
    /// in `ScrollbackState::running` so `finish_running_with_time` cannot rewrite
    /// its mode. This pins the arm as a TOTAL-FUNCTION requirement, not as a
    /// behaviour anyone can reach; it is deliberately a direct `output` call
    /// against a synthesized context rather than a claim about the room.
    #[test]
    fn the_truncated_arm_renders_the_collapsed_form() {
        let block = RoomStepsBlock::finalized(
            &completed(4),
            ACCENT,
            Some("2026-08-02T00:00:00Z"),
            Some("2026-08-02T00:00:12Z"),
        );
        assert_eq!(
            rows(&block, DisplayMode::Truncated, 80),
            rows(&block, DisplayMode::Collapsed, 80)
        );

        let live = RoomStepsBlock::live(&completed(5), ACCENT);
        assert_eq!(
            rows(&live, DisplayMode::Truncated, 80),
            rows(&live, DisplayMode::Collapsed, 80)
        );
    }

    /// SS-C.1 item 6's four cells, at the block level.
    ///
    /// The defect this guards is a MISSING case, not a wrong value, so all four
    /// cells are asserted against each other in one test. The room-level
    /// lifecycle version of this is `live_and_expanded_shows_every_step_and_keeps_showing_them`
    /// in `room_scrollback`.
    #[test]
    fn all_four_display_cases_render_their_own_shape() {
        let live = RoomStepsBlock::live(&completed(5), ACCENT);
        let collapsed_live = rows(&live, DisplayMode::Collapsed, 80);
        assert_eq!(collapsed_live.len(), 3);
        assert_eq!(collapsed_live[0], "+3 earlier steps");

        let expanded_live = rows(&live, DisplayMode::Expanded, 80);
        assert_eq!(expanded_live.len(), 5, "no cap under an explicit expand");
        assert!(
            !expanded_live.iter().any(|row| row.starts_with('+')),
            "no remainder line when nothing is hidden: {expanded_live:?}"
        );

        let done = RoomStepsBlock::finalized(
            &completed(5),
            ACCENT,
            Some("2026-08-02T00:00:00Z"),
            Some("2026-08-02T00:00:12Z"),
        );
        assert_eq!(
            rows(&done, DisplayMode::Collapsed, 80),
            vec![format!("{} 5 steps · 12s", check())]
        );

        let expanded_done = rows(&done, DisplayMode::Expanded, 80);
        assert_eq!(expanded_done.len(), 6);
        assert_eq!(
            expanded_done[5],
            format!("{} 5 steps · 12s", check()),
            "the summary follows the full list, it does not replace it"
        );
    }

    /// Copy and search see the truth, not the folded row.
    #[test]
    fn search_and_copy_carry_the_unshortened_labels_and_the_summary() {
        let long = "z".repeat(400);
        let block = RoomStepsBlock::finalized(
            &[
                activity("tool-0", &long, Some("completed")),
                activity("tool-1", "quick step", Some("failed")),
            ],
            ACCENT,
            Some("2026-08-02T00:00:00Z"),
            Some("2026-08-02T00:00:12Z"),
        );
        let text = block.full_text();
        assert!(
            text.contains(&long),
            "the index holds the whole label, not the sheared one"
        );
        assert!(!text.contains(ellipsis()));
        assert_eq!(
            text.lines().last(),
            Some("2 steps · 1 failed · 12s"),
            "the summary is the last indexed line"
        );
    }

    /// The trait surface SS-C.2 decided, asserted rather than assumed.
    ///
    /// What wrong implementation would still pass a looser version? One that
    /// left `has_vpad_for` at the trait's `true` default, which turns one
    /// collapsed row into three screen rows — so the DEFAULTS are asserted to
    /// be overridden, not merely present.
    #[test]
    fn the_trait_surface_is_the_one_the_spec_decided() {
        let block = RoomStepsBlock::live(&completed(1), ACCENT);
        assert_eq!(block.default_display_mode(), DisplayMode::Collapsed);
        assert!(!block.is_groupable());
        assert!(!block.has_vpad_for(&AppearanceConfig::default()));
        assert!(block.is_foldable(), "Ctrl+E needs this");
        assert_eq!(block.finished_display_mode(), None);
        assert!(!block.has_bullet(&ctx(DisplayMode::Collapsed, 80, false)));
        let accent = block
            .accent(&ctx(DisplayMode::Collapsed, 80, false))
            .expect("the steps row keeps the speaker's rail");
        assert_eq!(accent.color, ACCENT);
        assert!(!accent.animated, "never animated");
    }
}
