use super::*;

impl RoomScrollback {
    /// The stream's folded steps entry, if the lane ever produced a terminal
    /// step.
    pub(crate) fn steps_entry_id_for_stream(&self, stream_id: &str) -> Option<EntryId> {
        self.stream_entries
            .get(stream_id)
            .and_then(|binding| binding.steps_entry_id)
    }

    /// The stream's steps block rendered at `mode`, rows newline-joined.
    ///
    /// Renders the block directly rather than through the entry cache, so a test
    /// can ask for a mode without first driving the fold. The cache path has its
    /// own test - `the_expand_hint_renders_only_on_the_selected_row` - because
    /// the cache is exactly what normalizes selection away.
    pub(crate) fn steps_text(
        &self,
        stream_id: &str,
        width: u16,
        mode: crate::scrollback::DisplayMode,
    ) -> String {
        let id = self
            .steps_entry_id_for_stream(stream_id)
            .expect("the stream has a steps entry");
        let entry = self.state.get_by_id(id).expect("the entry is in the state");
        let ctx = crate::scrollback::BlockContext {
            mode,
            is_running: false,
            width,
            raw: false,
            max_lines: None,
            appearance: self.state.appearance().clone(),
            is_selected: false,
            cwd: None,
        };
        crate::scrollback::BlockContent::output(&entry.block, &ctx)
            .lines
            .iter()
            .map(|line| {
                line.content
                    .spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    pub(crate) fn steps_display_mode(
        &self,
        stream_id: &str,
    ) -> Option<crate::scrollback::DisplayMode> {
        let id = self.steps_entry_id_for_stream(stream_id)?;
        self.state.get_by_id(id).map(|entry| entry.display_mode())
    }

    pub(crate) fn steps_entry_count(&self) -> usize {
        (0..self.state.len())
            .filter_map(|index| self.state.entry(index))
            .filter(|entry| entry.block.is_room_steps())
            .count()
    }

    /// How many registered lane rows the room is holding, summed across turns.
    ///
    /// FL-141: `forget_settled_turn`'s effect is invisible in the rendered
    /// rows — a pruned turn looks exactly like an unpruned one, because
    /// pruning only removes the room's ability to place FUTURE rows. So the
    /// pruning test asserts on this directly rather than inferring it from
    /// output that would be identical either way. Slice D replaced the one
    /// anchor per lane with full membership (see [`TurnLaneBlock`]), so this
    /// now counts members across every turn's block.
    pub(super) fn lane_anchor_count(&self) -> usize {
        self.turn_blocks
            .values()
            .map(|block| {
                block
                    .lanes
                    .iter()
                    .map(|drawn| drawn.entry_ids.len())
                    .sum::<usize>()
            })
            .sum()
    }

    pub(crate) fn select_steps_entry(&mut self, stream_id: &str) {
        let id = self
            .steps_entry_id_for_stream(stream_id)
            .expect("the stream has a steps entry");
        let index = self
            .state
            .index_of_id(id)
            .expect("the entry is in the state");
        self.state.set_selected(Some(index));
    }

    /// One entry's rendered text THROUGH the entry cache, at a chosen selection
    /// state. This is the path that normalizes `is_selected` away for blocks
    /// outside `ensure_cached`'s named list.
    pub(crate) fn entry_text_when_selected(
        &self,
        id: EntryId,
        width: u16,
        is_selected: bool,
    ) -> String {
        let entry = self.state.get_by_id(id).expect("the entry is in the state");
        entry.ensure_cached(width, self.state.appearance(), is_selected, None);
        entry
            .cached_output_ref()
            .lines
            .iter()
            .map(|line| {
                line.content
                    .spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The PRE-SLICE-C frozen activity row, restored verbatim from `a993624`
    /// so the byte-identity pin compares against the real old code rather than
    /// against a reconstruction of it.
    ///
    /// Copied unchanged from the deleted `push_frozen_activity` and
    /// `frozen_activity_block`, minus the `activity_entries` dedup map that went
    /// with them (the caller here feeds each tool call once). Test-only, never
    /// reachable from a running room.
    pub(super) fn downgrade_steps_to_pre_slice_c_rows(
        &mut self,
        stream_id: &str,
        labels: &[String],
    ) {
        let id = self
            .steps_entry_id_for_stream(stream_id)
            .expect("the stream has a steps entry to downgrade");
        assert!(self.state.remove_entry(id));
        if let Some(binding) = self.stream_entries.get_mut(stream_id) {
            binding.steps_entry_id = None;
        }
        let lane_id = self
            .lane_streams
            .iter()
            .find(|(_, bound)| bound.as_str() == stream_id)
            .map(|(lane, _)| lane.clone())
            .expect("the stream is bound to a lane");
        let speaker = self
            .stream_entries
            .get(stream_id)
            .map(|binding| binding.speaker)
            .expect("the stream has a binding");
        for label in labels {
            self.push_frozen_activity_as_it_was_before_slice_c(&lane_id, label, speaker);
        }
    }

    fn push_frozen_activity_as_it_was_before_slice_c(
        &mut self,
        lane_id: &str,
        label: &str,
        speaker: RoomSpeaker,
    ) {
        let text = format!("{} {label}", crate::glyphs::check_mark());
        let block = RenderBlock::stub_styled_compact_non_groupable(
            text.clone(),
            vec![Line::from(Span::styled(
                text,
                Style::default().fg(RoomTheme::current().dim),
            ))],
            speaker.color(),
        );
        self.lane_streams
            .get(lane_id)
            .and_then(|stream_id| self.stream_entries.get(stream_id))
            .filter(|binding| !binding.completed)
            .map(|binding| {
                self.state.insert_block_before_with_cohesion(
                    binding.entry_id,
                    block.clone(),
                    binding.cohesion_group,
                )
            })
            .unwrap_or_else(|| self.state.push_block(block.clone()));
    }

    /// Settle a lane that these tests built by hand, with no reducer behind it.
    ///
    /// `finish_lane` takes the whole `LaneState` because it now reads the lane's
    /// activity and timestamps; a test that drives the room directly has no such
    /// value, so this synthesizes the empty one — no steps, no timestamps —
    /// which is exactly the shape these tests were asserting on before the
    /// signature changed.
    ///
    /// `roster_index` comes from the agent's own place in the room's roster
    /// (claude 0, codex 1, gemini 2), which is the order every one of these
    /// hand-driven tests dispatches in. It has to be a real index rather than
    /// a constant: since FL-141 the room places every lane row by roster, so a
    /// fixture that gave all three lanes index 0 would collapse them into one
    /// lane's anchor and stop exercising the ordering path at all.
    pub(super) fn finish_lane_bare(&mut self, lane_id: &str, agent: &str, phase: LanePhase) {
        self.finish_lane(&bare_lane(lane_id, agent, phase));
    }

    /// `start_stream` takes the whole `LaneState` because it places the three
    /// rows it draws by roster; a test that drives the room with no reducer
    /// behind it gets the same synthesized lane `finish_lane_bare` uses.
    pub(super) fn start_stream_bare(&mut self, stream_id: &str, lane_id: &str, agent: &str) {
        self.start_stream(stream_id, &bare_lane(lane_id, agent, LanePhase::Running));
    }

    pub(super) fn commit_message_without_reducer(
        &mut self,
        lane_id: &str,
        content_id: &str,
        text: &str,
    ) {
        let stream_id = self.lane_streams.get(lane_id).cloned().unwrap();
        if let Some(binding) = self.stream_entries.get(&stream_id) {
            if let Some(suffix) = text.strip_prefix(&binding.text) {
                self.push_stream_chunk(&stream_id, suffix);
            } else if binding.text != text {
                let entry_id = binding.entry_id;
                let speaker = binding.speaker;
                assert!(self.state.replace_agent_message(
                    entry_id,
                    RenderBlock::agent_message_with_accent(text.to_owned(), speaker.color()),
                ));
            }
        }
        let binding = self.stream_entries.get_mut(&stream_id).unwrap();
        binding.text.clear();
        binding.text.push_str(text);
        binding.completed = true;
        self.state.finish_running(binding.entry_id);
        self.content_entries
            .insert(content_id.into(), binding.entry_id);
    }
}

/// The `LaneState` a hand-driven test stands in for the reducer's.
///
/// No steps and no timestamps, which is exactly the shape these tests were
/// asserting on before `finish_lane` took the whole lane. The one field that
/// carries real meaning is `roster_index`.
fn bare_lane(lane_id: &str, agent: &str, phase: LanePhase) -> LaneState {
    LaneState {
        id: lane_id.to_owned(),
        turn_id: "turn".to_owned(),
        agent: agent.to_owned(),
        expected_message_id: "message".to_owned(),
        origin: zer0_room_protocol::LaneOrigin::Operator,
        hop_index: 0,
        parent_message_id: None,
        reply_to: None,
        from_agent: None,
        hop_id: None,
        phase,
        roster_index: match agent {
            "claude" => 0,
            "codex" => 1,
            "gemini" => 2,
            _ => 3,
        },
        queued_at: "2026-08-02T00:00:00Z".to_owned(),
        started_at: None,
        terminal_at: None,
        terminal_event_seq: None,
        failure_reason: None,
        stream_id: None,
        message_commit: None,
        activity: Vec::new(),
    }
}
