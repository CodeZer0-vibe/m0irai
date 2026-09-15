//! Slice D's cross-turn relocation engine, and FL-141's turn-block registry
//! it is built on.
//!
//! Extracted from `room_scrollback.rs` when that file passed 2,300 lines. The
//! seam is a real one rather than a line count: everything here reads or
//! writes exactly two maps — `turn_blocks` and `answer_groups` — and nothing
//! outside this file touches either. `room_scrollback.rs` keeps the room's own
//! surface (events in, rows out); this keeps the answer to one question, which
//! is where a lane's rows belong and when a whole turn's block moves.
//!
//! A child module rather than a sibling crate module, because these are
//! methods on `RoomScrollback` and they need its private fields. That is the
//! same shape `test_support.rs` beside it already uses.
//!
//! Nothing about the behaviour changed in the move. The 1,013-test suite,
//! including all four FL-141 hard gates and every slice-D proof site, is the
//! evidence: it was green before the extraction and green after it, with no
//! test edited.

use super::*;

impl RoomScrollback {
    /// THE ONE CLOCK for lane rows. Every row a lane owns — streamed header,
    /// answer, live status, folded steps group, cancelled marker, failure
    /// outcome — is placed by this, on the live path and the rebuild path
    /// alike, and by nothing else.
    ///
    /// It answers one question: which already-drawn row must this lane sit
    /// ABOVE? That is the first row belonging to a lane of the SAME TURN with a
    /// higher `roster_index`; `None` means this lane belongs at the end.
    ///
    /// Why an anchor rather than a sort key. Two earlier attempts sorted, and
    /// both were wrong for the same reason: the room draws a lane's rows when
    /// its events arrive, and no single event sequence describes when a lane
    /// SHOULD appear. The first keyed a terminal lane on `terminal_event_seq`
    /// and read three cancelled lanes back in settle order. The second keyed a
    /// replayed stream on `lane.started` while a committed answer still keyed
    /// on `message.committed` — two clocks in one sort — and put a cancelled
    /// lane above a lane that had answered. Roster order is not a time at all;
    /// it is a position, and a position needs a neighbour, not a timestamp.
    ///
    /// Turn-scoped deliberately. `roster_index` is monotonic across the whole
    /// session, so an unscoped search would let a late-drawing lane of turn 1
    /// insert above turn 2's lanes — and land under turn 2's prompt, which no
    /// sort of lane rows can fix because the prompt is not a lane row.
    /// Scoping keeps a row inside the turn that produced it.
    /// The entry a new row of `order` must sit above: the earliest member of
    /// the nearest higher-roster sibling that has already drawn.
    ///
    /// Membership only — the position itself is read off the state at query
    /// time, so the answer survives relocations and mid-group insertions
    /// without any bookkeeping of its own.
    pub(super) fn lane_anchor(&self, order: LaneOrder<'_>) -> Option<EntryId> {
        let block = self.turn_blocks.get(order.turn_id)?;
        block
            .lanes
            .iter()
            .filter(|drawn| drawn.roster_index > order.roster_index)
            .flat_map(|drawn| drawn.entry_ids.iter())
            .filter_map(|id| self.state.index_of_id(*id).map(|index| (index, *id)))
            .min_by_key(|(index, _)| *index)
            .map(|(_, id)| id)
    }

    /// The entry immediately AFTER whatever `turn_id` owns: where a first row
    /// belongs when no higher-roster sibling has drawn but the turn already has
    /// a block elsewhere in the feed (its relocation to the tail being the case
    /// memo §1.7 created). `None` when the turn has nothing on screen yet or
    /// nothing follows it — both mean append.
    fn turn_block_tail_successor(&self, turn_id: &str) -> Option<EntryId> {
        let block = self.turn_blocks.get(turn_id)?;
        let max_index = block
            .lanes
            .iter()
            .flat_map(|drawn| drawn.entry_ids.iter())
            .filter_map(|id| self.state.index_of_id(*id))
            .max()?;
        self.state.entry(max_index + 1).map(|entry| entry.id)
    }

    /// Draw one of `order`'s rows in its roster position, registering it with
    /// the turn-block registry.
    ///
    /// Later rows of the same lane resolve to the SAME anchor (a lane is never
    /// its own successor), so each one lands immediately before it and the
    /// group stays in the order it was written.
    pub(super) fn place_lane_block(
        &mut self,
        order: LaneOrder<'_>,
        block: RenderBlock,
        cohesion: Option<u64>,
    ) -> EntryId {
        let anchor = match self.lane_anchor(order) {
            Some(anchor) => Some(anchor),
            // No higher-roster sibling has drawn. A block that has been
            // RELOCATED to the tail still owns the space right after itself -
            // that is where its late rows belong (memo §1.8's open sibling).
            // An unrelocated turn with no successor anchor just appends:
            // jumping before whatever happens to follow it would hoist this
            // row over foreign feed content.
            None => match self.turn_blocks.get(order.turn_id) {
                Some(block) if block.relocated => self.turn_block_tail_successor(order.turn_id),
                _ => None,
            },
        };
        let entry_id = match (anchor, cohesion) {
            (Some(anchor), Some(group)) => self
                .state
                .insert_block_before_with_cohesion(anchor, block, group),
            (Some(anchor), None) => self.state.insert_block_before(anchor, block),
            (None, Some(group)) => self.state.push_block_with_cohesion(block, group),
            (None, None) => self.state.push_block(block),
        };
        self.remember_lane_row(order.turn_id, order.roster_index, entry_id);
        entry_id
    }

    /// Register one drawn row as a member of its lane inside its turn's block.
    ///
    /// Membership only: every row joins (a relocation moves the WHOLE block,
    /// memo §1.2), keyed by roster seat. The lanes vector stays sorted by seat
    /// so `lane_anchor`'s filter scans seats in roster order.
    pub(super) fn remember_lane_row(
        &mut self,
        turn_id: &str,
        roster_index: u64,
        entry_id: EntryId,
    ) {
        let block = self.turn_blocks.entry(turn_id.to_owned()).or_default();
        match block
            .lanes
            .iter_mut()
            .find(|drawn| drawn.roster_index == roster_index)
        {
            Some(drawn) => {
                drawn.entry_ids.insert(entry_id);
            }
            None => {
                let mut drawn = TurnLaneRows {
                    roster_index,
                    entry_ids: HashSet::new(),
                };
                drawn.entry_ids.insert(entry_id);
                let position = block
                    .lanes
                    .partition_point(|drawn| drawn.roster_index < roster_index);
                block.lanes.insert(position, drawn);
            }
        }
    }

    /// Unregister one retired row (the live-status recycler's writer duty).
    pub(super) fn forget_lane_row(&mut self, turn_id: &str, roster_index: u64, entry_id: EntryId) {
        let Some(block) = self.turn_blocks.get_mut(turn_id) else {
            return;
        };
        for drawn in &mut block.lanes {
            if drawn.roster_index == roster_index {
                drawn.entry_ids.remove(&entry_id);
            }
        }
        block.lanes.retain(|drawn| !drawn.entry_ids.is_empty());
        if block.lanes.is_empty() {
            self.turn_blocks.remove(turn_id);
        }
    }

    /// Drop a turn's whole registry entry once nothing more can be drawn FOR it.
    ///
    /// Dropping membership wholesale is safe exactly when no lane of the turn
    /// can still draw: a displacement commit always carries a sequence INSIDE
    /// the source turn's own lifetime (between a later prompt and that later
    /// answer), so a fully settled turn can never again be a relocation source,
    /// and a still-drawing turn keeps its registry here.
    pub(super) fn forget_settled_turn(&mut self, turn_id: &str, reducer: &RoomReducer) {
        // CQ-04: the turn's own lane index, not a filter over the session's.
        let turn_still_drawing = reducer.turn_lanes(turn_id).any(|lane| {
            !matches!(
                lane.phase,
                LanePhase::Completed | LanePhase::Failed | LanePhase::Cancelled
            )
        });
        if !turn_still_drawing {
            self.turn_blocks.remove(turn_id);
        }
    }

    /// Slice D's cross-turn hook (memo §1.5, steps 6-8): evaluate the
    /// displacement predicate for a just-committed answer of `turn_id`; if it
    /// qualifies, hang the one back-reference above the answer's header and
    /// move the source turn's WHOLE block to the tail.
    ///
    /// Every id handed to [`ScrollbackState::move_group_to_end`] is a permanent
    /// registry member, so `removable` stays empty — a member that has vanished
    /// from the feed is bookkeeping drift, and the primitive's debug_assert
    /// should stop the run rather than silently skip it.
    pub(super) fn relocate_if_displaced(
        &mut self,
        reducer: &RoomReducer,
        turn_id: &str,
        message_id: &str,
        commit_seq: &str,
    ) {
        // The DISPLACING prompt is only ever a predicate here; the row this
        // writes names the SOURCE turn's own prompt, found below. Binding the
        // displacing one to a name invites the two to be confused.
        if displacement_prompt(reducer, turn_id, commit_seq).is_none() {
            return;
        }
        // The reference names the prompt the answer ACTUALLY answers - the
        // source turn's own operator prompt - not the later prompt whose
        // arrival displaced it (memo §1.6's "source prompt").
        let prompt_at = reducer
            .transcript()
            .find(|entry| {
                matches!(entry.author, TranscriptAuthor::Operator) && entry.turn_id == turn_id
            })
            .map(|entry| entry.occurred_at.clone());
        // VALIDATE, THEN MUTATE. Nothing is written until the block this is
        // about is known to exist.
        //
        // The reference has to be inserted BEFORE the ids are read — it joins
        // the block and must travel with it — so the emptiness check cannot
        // simply guard the move. Checking first and re-reading afterwards costs
        // one extra scan on the rare relocation path and makes the failure
        // structurally impossible instead of merely unlikely.
        //
        // ⚠ **What it prevents.** `forget_settled_turn` drops a turn's whole
        // registry once no lane of it is still drawing. Today it cannot race a
        // commit, and the only reason is an ordering in the OTHER half of the
        // repo: `src/room/room-engine.ts` emits `message.committed` and flushes
        // before the terminal event. The reducer refuses the inversion, so it
        // never arrives — but the room used to depend on that, and with the
        // registry gone it would paint `→ answering your …` above an answer
        // that had not moved: a sentence about something that did not happen.
        // The second term is memo §1.7 step 4, hoisted to the caller: a group
        // whose rows have already been printed into the terminal's own
        // scrollback cannot be reordered, and deciding that AFTER inserting
        // the reference would leave the row explaining a move that then got
        // refused. Without it the run aborts one line below, at
        // `insert_block_before`'s own committed guard.
        let block = self.ordered_block_ids(turn_id);
        if block.is_empty() || self.state.any_committed(&block) {
            return;
        }
        self.ensure_back_reference(message_id, prompt_at.as_deref());
        // Re-read: the reference row just joined the block and moves with it.
        let ids = self.ordered_block_ids(turn_id);
        let moved = self.state.move_group_to_end(&ids, &[]);
        if moved && let Some(block) = self.turn_blocks.get_mut(turn_id) {
            block.relocated = true;
        }
    }

    /// Insert this answer's ONE back-reference row directly above its header
    /// (memo §1.6), dedup-guarded on the group itself: a second qualifying
    /// commit for an already-relocated answer re-runs this and must find the
    /// row already there rather than stack a second one.
    ///
    /// The new row joins BOTH the answer group (as its new top) and the owning
    /// lane's turn-block membership, so it moves with the block now and stays
    /// with it if anything relocates it again later.
    ///
    /// A source stamp that will not resolve to a wall time omits the row
    /// entirely and leaves the group untouched (spec §D.5): the answer still
    /// relocates, it just says nothing it cannot substantiate. Resolving the
    /// time HERE rather than inside [`back_reference_block`] is what makes
    /// that omission expressible — a builder that formats first can only
    /// choose between two sentences, and both would be inventions.
    pub(super) fn ensure_back_reference(&mut self, message_id: &str, prompt_at: Option<&str>) {
        let Some(group) = self.answer_groups.get(message_id) else {
            return;
        };
        if group.back_reference.is_some() {
            return;
        }
        let Some(prompt_time) = prompt_at.and_then(room_time) else {
            return;
        };
        let top = group.top;
        let cohesion_group = group.cohesion_group;
        let block = back_reference_block(&prompt_time);
        let id = self
            .state
            .insert_block_before_with_cohesion(top, block, cohesion_group);
        let Some(group) = self.answer_groups.get_mut(message_id) else {
            return;
        };
        group.ids.insert(0, id);
        group.top = id;
        group.back_reference = Some(id);
        // Which lane owns the row we anchored against decides where the
        // reference itself is registered.
        if let Some((turn_id, roster_index)) = self.lane_owning_entry(top) {
            self.remember_lane_row(&turn_id, roster_index, id);
        }
    }

    /// The turn's members, in feed order at THIS moment (memo §1.2's roster +
    /// draw order). Members that fell out of the state are skipped; a member
    /// missing from both is drift the move primitive will assert on.
    pub(super) fn ordered_block_ids(&self, turn_id: &str) -> Vec<EntryId> {
        let Some(block) = self.turn_blocks.get(turn_id) else {
            return Vec::new();
        };
        let mut ids = block
            .lanes
            .iter()
            .flat_map(|drawn| drawn.entry_ids.iter().copied())
            .filter_map(|id| self.state.index_of_id(id).map(|index| (index, id)))
            .collect::<Vec<_>>();
        ids.sort_by_key(|(index, _)| *index);
        ids.into_iter().map(|(_, id)| id).collect()
    }

    /// Which registered lane owns `entry_id`, if any.
    pub(super) fn lane_owning_entry(&self, entry_id: EntryId) -> Option<(String, u64)> {
        self.turn_blocks.iter().find_map(|(turn_id, block)| {
            block
                .lanes
                .iter()
                .find(|drawn| drawn.entry_ids.contains(&entry_id))
                .map(|drawn| (turn_id.clone(), drawn.roster_index))
        })
    }

    /// Has the operator SEEN this answer on this frame? (spec §D.6)
    ///
    /// - `None` — the answer is not in the feed at all, so there is nothing to
    ///   point at and the pill entry should be dropped.
    /// - `Some(true)` — its group's top row has its FIRST screen row visible;
    ///   reading starts there, so it counts as seen.
    /// - `Some(false)` — off-screen, or on screen with its top clipped away.
    ///
    /// The threshold is `entry_screen_area`'s own `top_clipped` flag and not
    /// merely `Some(..)`: that returns `Some` for any one-row intersection, so
    /// a sliver of a long answer showing at the bottom of the viewport would
    /// otherwise clear the pill for something nobody has read. It is
    /// deliberately NOT `is_entry_visible` (which means "included in the view
    /// mode", i.e. every entry in the room's `AllTurns`), NOT
    /// `has_content_below`, and NOT the follow flag.
    ///
    /// **Only valid inside a frame, after `render` has run `prepare_layout`
    /// against this exact `feed` rect.** With no layout cache, or with one
    /// built for another width, `entry_screen_area` answers `None` and the
    /// caller reads "gone from the feed" for an answer that is merely
    /// unmeasured — which is why spec §D.6 pins the one call site.
    pub fn answer_first_row_visible(&self, message_id: &str, feed: Rect) -> Option<bool> {
        let index = self.answer_top_index(message_id)?;
        match self.state.entry_screen_area(index, feed) {
            Some((_, top_clipped, _)) => Some(!top_clipped),
            None => Some(false),
        }
    }

    /// Where this answer's presentation group starts, as a feed index: its
    /// back-reference when it has one, otherwise its own header (memo §1.4).
    ///
    /// `None` once the id no longer resolves — after a snapshot that did not
    /// carry the answer, or a prune. Callers drop the entry rather than
    /// guessing.
    pub fn answer_top_index(&self, message_id: &str) -> Option<usize> {
        let group = self.answer_groups.get(message_id)?;
        self.state.index_of_id(group.top)
    }

    /// Put this answer's first row at the top of the viewport (spec §D.7's
    /// `Ctrl+T`). Clears follow mode and bumps the generation on the way, so
    /// the caller does not have to remember either.
    pub fn scroll_to_answer_top(&mut self, message_id: &str) -> bool {
        let Some(index) = self.answer_top_index(message_id) else {
            return false;
        };
        self.state.scroll_to_entry_top(index);
        true
    }

    /// Record one committed answer's presentation group — THE one writer of
    /// `answer_groups`, and the reason it is a method rather than three inline
    /// struct literals.
    ///
    /// The three sites that create a group (a rebuilt transcript entry, a
    /// commit that canonicalizes a streamed lane in place, and a commit with
    /// no stream behind it) each assembled `AnswerGroup` by hand, so a field
    /// added to it had to be found in three places and a field forgotten in
    /// one of them was a compile error only by luck of the struct having no
    /// defaults. `back_reference` starts `None` at every one of them, which is
    /// a fact about the type and not about any call site.
    pub(super) fn remember_answer_group(
        &mut self,
        message_id: &str,
        cohesion_group: u64,
        ids: Vec<EntryId>,
        top: EntryId,
    ) {
        self.answer_groups.insert(
            message_id.to_owned(),
            AnswerGroup {
                cohesion_group,
                ids,
                top,
                back_reference: None,
            },
        );
    }
}

// ---------------------------------------------------------------------------
// The free functions this module is the only caller of, moved here with it.
//
// They stayed in `room_scrollback.rs` for one round after their caller left,
// which is the ordinary way an extraction leaves a seam half-finished: the
// methods move because they are named in an `impl`, and the plain functions
// they call do not.
// ---------------------------------------------------------------------------

thread_local! {
    /// RP round 2's instrument: how many transcript rows this thread has fed to
    /// [`displacement_prompt`]'s predicate.
    ///
    /// Counts CLOSURE EVALUATIONS, which is the work the predicate actually
    /// does. The lane-walk counter next door in `zer0-room-protocol` could not
    /// see this term at all — it counts walks of the LANE list, and the cost
    /// that dominated a rebuild was a walk of the TRANSCRIPT.
    ///
    /// Thread-local for the same two reasons as that one: a field would have to
    /// join `RoomScrollback`, and a global would be shared by tests running at
    /// once.
    static DISPLACEMENT_PROBES: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// How many transcript rows this thread has fed to the displacement predicate.
///
/// Test-only: the counter is WRITTEN on the production path (one `Cell` bump
/// per probe, so the path under test is the path that ships) and read only by
/// the pin. Gated so a release build does not carry an unread accessor.
#[cfg(test)]
pub(crate) fn displacement_probes_on_this_thread() -> u64 {
    DISPLACEMENT_PROBES.with(std::cell::Cell::get)
}

/// Zero this thread's probe count, so a measurement covers one rebuild.
#[cfg(test)]
pub(crate) fn reset_displacement_probes_on_this_thread() {
    DISPLACEMENT_PROBES.with(|probes| probes.set(0));
}

/// The earliest first-draw sequence among `turn_id`'s lanes that HAVE drawn —
/// memo §1.1's `turn_first_draw_seq(T)`. A lane with neither a started stream
/// nor a terminal event has drawn nothing and owns no rows, so it is skipped
/// rather than forced (the strict `lane_first_draw_seq` panics on exactly
/// that shape, which is right at FL-141's call sites and wrong inside a
/// predicate that scans whole turns).
///
/// CQ-04: reads the turn's OWN lane index. A rebuild asks this once per
/// committed answer, and filtering every lane in the session each time is the
/// same rows × lanes shape as the two scan sites CQ-04 named.
fn turn_first_draw_seq<'a>(reducer: &'a RoomReducer, turn_id: &'a str) -> Option<&'a str> {
    reducer
        .turn_lanes(turn_id)
        .filter_map(|lane| {
            lane.stream_id
                .as_deref()
                .and_then(|stream_id| reducer.stream(stream_id))
                .map(|stream| stream.started_event_seq.as_str())
                .or(lane.terminal_event_seq.as_deref())
        })
        .reduce(|earliest, seq| match decimal_cmp(seq, earliest) {
            Ok(Ordering::Less) => seq,
            _ => earliest,
        })
}

/// Slice D's displacement predicate (memo §1.1), evaluated against REDUCER
/// state only — no viewport, no rendering, no room-side memory. An answer
/// committed for `turn_id` at `commit_seq` is displaced iff an operator
/// prompt from a LATER turn arrived after `turn_id` first drew anything and
/// before this commit:
///
/// `turn_first_draw_seq(T) < later_prompt.event_seq < commit_seq`
///
/// Same-turn prompts cannot satisfy the seat test (the operator's own prompt
/// IS its turn), settle order never enters, and if every lane of T first drew
/// after the later prompt there is nothing between the prompt and the answer
/// to displace — the caller leaves the block alone, already at the tail,
/// with no back-reference.
///
/// ## RP round 2: this was the whole cost of a rebuild
///
/// The predicate is evaluated once per committed answer, and it paid its full
/// price even when displacement did NOT fire, which is the ordinary case.
/// Measured in release before this round, relocation ON: 500 rows 71 ms,
/// 2,000 rows 3,036 ms, 4,000 rows 23,478 ms, 8,000 rows 238,567 ms. With the
/// relocation step disabled entirely the same fixtures ran 35 / 57 / 177 ms —
/// so essentially all of a rebuild's superlinear cost was here.
///
/// Two changes, both of which preserve the result exactly:
///
/// 1. **Both seat lookups go through [`RoomReducer::turn_seat`]**, an O(1) read
///    of an index the reducer already maintains. The inner one ran once per
///    operator row of every scan, which is the rows × turns term.
/// 2. **The scan is a WINDOW, not the whole transcript.** The predicate only
///    ever cared about rows strictly between `first_draw` and `commit_seq`, and
///    the transcript is ascending by `event_seq`, so it seeks to the start of
///    that window with `partition_point` and stops at its end with `take_while`.
///    It used to read from row zero to the last row on every one of those
///    evaluations. The window is the room's activity during ONE turn's life,
///    which does not grow with the session.
///
///    That ordering is not an assumption. `RoomReducer::apply` refuses any
///    event whose sequence is not exactly `increment_decimal(last)`, so a row
///    pushed later cannot carry an earlier sequence, and
///    `the_transcript_is_ascending_by_event_seq_so_a_bounded_scan_is_sound` in
///    `zer0-room-protocol` pins both the order and the refusal that produces
///    it. Every row now skipped would have failed one of the old predicate's
///    two sequence terms, so no candidate is lost — which is why the whole
///    relocation suite is byte-identical across this change.
pub(super) fn displacement_prompt<'a>(
    reducer: &'a RoomReducer,
    turn_id: &str,
    commit_seq: &str,
) -> Option<&'a TranscriptEntry> {
    let source_seat = reducer.turn_seat(turn_id)?;
    let first_draw = turn_first_draw_seq(reducer, turn_id)?;
    let rows = reducer.transcript_rows();
    // The first row strictly AFTER `first_draw`. Everything before it fails the
    // `first_draw < entry` term, which is exactly what `partition_point` needs
    // to be a valid split of a sorted slice.
    let window = rows.partition_point(|entry| {
        decimal_cmp(&entry.event_seq, first_draw) != Ok(Ordering::Greater)
    });
    rows[window..]
        .iter()
        .take_while(|entry| decimal_cmp(&entry.event_seq, commit_seq) == Ok(Ordering::Less))
        .find(|entry| {
            DISPLACEMENT_PROBES.with(|probes| probes.set(probes.get().saturating_add(1)));
            matches!(entry.author, TranscriptAuthor::Operator)
                && reducer
                    .turn_seat(&entry.turn_id)
                    .is_some_and(|seat| seat > source_seat)
        })
}

/// Slice D (memo §1.6): THE one row that ties a relocated answer back to the
/// prompt it actually answers — `<HopArrow> answering your <time> message`,
/// in `RoomTheme::faint`, inserted directly above the answer's header.
///
/// `prompt_at` is the SOURCE prompt's ALREADY-RESOLVED wall time. Resolving
/// it is the caller's job precisely so an unresolvable stamp omits the whole
/// row rather than reaching here to be papered over: spec §D.5 says *"if it
/// cannot be resolved, omit the line entirely. Do not print 'answering your
/// earlier message'."* Absent renders absent (§3 rule 6). This function used
/// to take an `Option` and print `answering your message` for `None` — an
/// invented sentence, and the exact shape the spec forbids.
///
/// A dim `Stub` like every other room chrome row: a Stub never reaches the
/// markdown parser, so the arrow glyph survives the legacy ASCII set, and
/// faint keeps it from competing with real answers.
fn back_reference_block(prompt_at: &str) -> RenderBlock {
    let arrow = room_secondary(RoomSecondaryGlyph::HopArrow);
    let text = format!("{arrow} answering your {prompt_at} message");
    let faint = RoomTheme::current().faint;
    RenderBlock::stub_styled_compact_non_groupable(
        text.clone(),
        vec![Line::from(Span::styled(text, Style::default().fg(faint)))],
        faint,
    )
}
