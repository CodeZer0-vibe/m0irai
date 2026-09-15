//! Filesystem-backed `@` completion for service-free pager consumers.
//!
//! The Grok service build retains its indexed workspace daemon. This owner
//! keeps the same prompt state/replacement contract while walking the actual
//! room working tree directly, without importing workspace/session services.

use std::path::{Path, PathBuf};

use super::context::{self, AtContext, normalize_display_path};

const MAX_RESULTS: usize = 1000;
const MAX_SCAN_ENTRIES: usize = 10_000;

#[derive(Debug, Clone)]
pub struct FuzzyMatchResult {
    pub path: String,
    pub is_dir: bool,
    pub indices: Vec<u32>,
}

#[derive(Debug, Clone, Default)]
pub struct FileSearchResults {
    pub topk: Vec<FuzzyMatchResult>,
    pub num_items: usize,
}

#[derive(Debug, Clone)]
pub struct FileSearchReplacement {
    pub range: std::ops::Range<usize>,
    pub text: String,
    pub cursor: usize,
    pub dismiss: bool,
}

pub struct FileSearchState {
    root: PathBuf,
    results: FileSearchResults,
    context: Option<AtContext>,
    selected: usize,
    hovered: Option<usize>,
    scroll_offset: usize,
    drill_prefix: Option<String>,
}

impl FileSearchState {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.to_owned(),
            results: FileSearchResults::default(),
            context: None,
            selected: 0,
            hovered: None,
            scroll_offset: 0,
            drill_prefix: None,
        }
    }

    pub fn retarget(&mut self, root: &Path) {
        *self = Self::new(root);
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn is_visible(&self) -> bool {
        self.context.is_some() && !self.results.topk.is_empty()
    }
    pub fn context(&self) -> Option<&AtContext> {
        self.context.as_ref()
    }
    pub fn results(&self) -> &FileSearchResults {
        &self.results
    }
    pub fn selected(&self) -> usize {
        self.selected
    }
    pub fn scroll_offset(&self) -> usize {
        self.scroll_offset
    }
    pub fn hovered(&self) -> Option<usize> {
        self.hovered
    }
    pub fn is_dir_mode(&self) -> bool {
        self.context.as_ref().is_some_and(AtContext::is_dir_mode)
    }
    pub fn result_count(&self) -> usize {
        self.results.topk.len()
    }
    pub fn total_items(&self) -> usize {
        self.results.num_items
    }
    pub fn poll(&mut self) -> bool {
        false
    }
    pub fn set_drill_prefix(&mut self, prefix: Option<String>) {
        self.drill_prefix = prefix;
    }

    pub fn set_hovered(&mut self, index: Option<usize>) -> bool {
        let next = index.filter(|&index| index < self.results.topk.len());
        let changed = self.hovered != next;
        self.hovered = next;
        changed
    }

    pub fn update_context(&mut self, text: &str, cursor: usize) {
        self.context = context::detect_with_drill(text, cursor, self.drill_prefix.as_deref());
        self.selected = 0;
        self.hovered = None;
        self.scroll_offset = 0;
        self.results = self
            .context
            .as_ref()
            .map_or_else(FileSearchResults::default, |context| {
                scan_matches(
                    &self.root,
                    context.matcher_query(),
                    context.is_hidden_mode(),
                )
            });
    }

    pub fn clear_context(&mut self) {
        self.context = None;
        self.drill_prefix = None;
        self.results = FileSearchResults::default();
    }

    pub fn move_selection(&mut self, delta: isize) {
        let len = self.results.topk.len();
        if len != 0 {
            self.selected = (self.selected as isize + delta).clamp(0, len as isize - 1) as usize;
        }
    }

    pub fn page_move(&mut self, delta: isize, visible_rows: usize) {
        self.move_selection(delta * (visible_rows / 2).max(1) as isize);
    }

    pub fn ensure_visible(&mut self, visible_rows: usize) {
        if visible_rows == 0 {
            return;
        }
        if self.selected < self.scroll_offset {
            self.scroll_offset = self.selected;
        } else if self.selected >= self.scroll_offset + visible_rows {
            self.scroll_offset = self.selected + 1 - visible_rows;
        }
    }

    pub fn select_hovered(&mut self) -> bool {
        if let Some(index) = self
            .hovered
            .filter(|&index| index < self.results.topk.len())
        {
            self.selected = index;
            true
        } else {
            false
        }
    }

    pub fn selected_result(&self) -> Option<&FuzzyMatchResult> {
        self.results.topk.get(self.selected)
    }

    pub fn try_replace(&self, src: &str) -> Option<FileSearchReplacement> {
        let context = self.context.as_ref()?;
        let result = self.selected_result()?;
        if !result.is_dir || !context.is_dir_mode() {
            return None;
        }
        let range = context.path_range();
        let path = normalize_display_path(&result.path).to_owned();
        let at_end = range.end == src.len();
        let existing = format!("{path}/");
        let dismiss = src.get(range.clone()) == Some(existing.as_str());
        let text = if dismiss && at_end {
            format!("{existing} ")
        } else {
            existing
        };
        let mut cursor = range.start + text.len();
        if dismiss && !at_end {
            cursor += src[range.end..].chars().next().map_or(1, char::len_utf8);
        }
        Some(FileSearchReplacement {
            range,
            text,
            cursor,
            dismiss,
        })
    }
}

fn scan_matches(root: &Path, query: &str, include_hidden: bool) -> FileSearchResults {
    let mut candidates = Vec::new();
    let mut pending = vec![root.to_owned()];
    let mut seen = 0usize;
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if seen >= MAX_SCAN_ENTRIES {
                break;
            }
            seen += 1;
            let path = entry.path();
            let name_hidden = entry.file_name().to_string_lossy().starts_with('.');
            if name_hidden && !include_hidden {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let is_dir = kind.is_dir();
            if is_dir {
                pending.push(path.clone());
            }
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            if let Some(indices) = fuzzy_indices(&relative, query) {
                candidates.push(FuzzyMatchResult {
                    path: relative,
                    is_dir,
                    indices,
                });
            }
        }
        if seen >= MAX_SCAN_ENTRIES {
            break;
        }
    }
    candidates.sort_by(|left, right| {
        left.path
            .len()
            .cmp(&right.path.len())
            .then_with(|| left.path.cmp(&right.path))
    });
    candidates.truncate(MAX_RESULTS);
    let num_items = candidates.len();
    FileSearchResults {
        topk: candidates,
        num_items,
    }
}

fn fuzzy_indices(candidate: &str, query: &str) -> Option<Vec<u32>> {
    if query.is_empty() {
        return Some(Vec::new());
    }
    let mut query = query.chars().flat_map(char::to_lowercase);
    let mut wanted = query.next()?;
    let mut indices = Vec::new();
    for (index, character) in candidate.chars().enumerate() {
        if character.to_lowercase().any(|lower| lower == wanted) {
            indices.push(index as u32);
            if let Some(next) = query.next() {
                wanted = next;
            } else {
                return Some(indices);
            }
        }
    }
    None
}
