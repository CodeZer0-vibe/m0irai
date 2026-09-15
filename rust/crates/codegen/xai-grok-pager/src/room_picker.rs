//! Keyboard-first pickers for the attached Zer0 room.
//!
//! The Node host owns provider/session discovery. This module validates those
//! bounded snapshots and owns only transient terminal selection state.

use crate::room_composer_menu::{
    CatalogKind, RoomCatalogAgent, RoomCatalogSnapshot, RoomComposerOverlay, picker_overlay,
};
pub use crate::room_picker_contract::{RoomModelCatalog, RoomSessionRow, parse_room_sessions};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RoomPickerKind {
    Models(RoomCatalogAgent),
    Skills(RoomCatalogAgent),
    Sessions,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RoomPickerRequest {
    Models {
        request_id: u64,
        agent: RoomCatalogAgent,
    },
    SelectModel {
        request_id: u64,
        agent: RoomCatalogAgent,
        model_id: String,
    },
    Sessions {
        request_id: u64,
    },
}

impl RoomPickerRequest {
    pub const fn request_id(&self) -> u64 {
        match self {
            Self::Models { request_id, .. }
            | Self::SelectModel { request_id, .. }
            | Self::Sessions { request_id } => *request_id,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RoomPickerChoice {
    Model {
        agent: RoomCatalogAgent,
        model_id: String,
    },
    Skill {
        agent: RoomCatalogAgent,
        name: String,
    },
    Session {
        session_id: String,
        current: bool,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PickerRow {
    id: String,
    label: String,
    description: String,
    current: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum PickerStatus {
    Closed,
    Loading { request_id: u64, applying: bool },
    Ready { notice: Option<String> },
    Error(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoomPickerState {
    kind: Option<RoomPickerKind>,
    status: PickerStatus,
    rows: Vec<PickerRow>,
    selected: usize,
    next_request_id: u64,
    current_session_id: String,
}

impl RoomPickerState {
    pub fn new(current_session_id: String) -> Self {
        Self {
            kind: None,
            status: PickerStatus::Closed,
            rows: Vec::new(),
            selected: 0,
            next_request_id: 1,
            current_session_id,
        }
    }

    pub fn is_open(&self) -> bool {
        self.kind.is_some()
    }

    pub fn close(&mut self) {
        self.kind = None;
        self.status = PickerStatus::Closed;
        self.rows.clear();
        self.selected = 0;
    }

    pub fn open_models(&mut self, agent: RoomCatalogAgent) -> RoomPickerRequest {
        self.kind = Some(RoomPickerKind::Models(agent));
        self.rows.clear();
        self.selected = 0;
        let request_id = self.next_request();
        self.status = PickerStatus::Loading {
            request_id,
            applying: false,
        };
        RoomPickerRequest::Models { request_id, agent }
    }

    pub fn open_skills(&mut self, agent: RoomCatalogAgent, catalog: &RoomCatalogSnapshot) {
        self.kind = Some(RoomPickerKind::Skills(agent));
        self.rows = skill_rows(agent, catalog);
        self.selected = 0;
        self.status = PickerStatus::Ready { notice: None };
    }

    pub fn open_sessions(&mut self) -> RoomPickerRequest {
        self.kind = Some(RoomPickerKind::Sessions);
        self.rows.clear();
        self.selected = 0;
        let request_id = self.next_request();
        self.status = PickerStatus::Loading {
            request_id,
            applying: false,
        };
        RoomPickerRequest::Sessions { request_id }
    }

    pub fn move_selection(&mut self, delta: isize) {
        if self.rows.is_empty() || matches!(self.status, PickerStatus::Loading { .. }) {
            return;
        }
        let len = self.rows.len() as isize;
        self.selected = (self.selected as isize + delta).rem_euclid(len) as usize;
    }

    pub fn switch_agent(
        &mut self,
        delta: isize,
        catalog: &RoomCatalogSnapshot,
    ) -> Option<RoomPickerRequest> {
        let kind = self.kind?;
        let agent = match kind {
            RoomPickerKind::Models(agent) | RoomPickerKind::Skills(agent) => agent,
            RoomPickerKind::Sessions => return None,
        };
        let agent = shifted_agent(agent, delta);
        match kind {
            RoomPickerKind::Models(_) => Some(self.open_models(agent)),
            RoomPickerKind::Skills(_) => {
                self.open_skills(agent, catalog);
                None
            }
            RoomPickerKind::Sessions => None,
        }
    }

    pub fn retry(&mut self, catalog: &RoomCatalogSnapshot) -> Option<RoomPickerRequest> {
        match self.kind? {
            RoomPickerKind::Models(agent) => Some(self.open_models(agent)),
            RoomPickerKind::Skills(agent) => {
                self.open_skills(agent, catalog);
                None
            }
            RoomPickerKind::Sessions => Some(self.open_sessions()),
        }
    }

    pub fn selected_choice(&self) -> Option<RoomPickerChoice> {
        if !matches!(self.status, PickerStatus::Ready { .. }) {
            return None;
        }
        let row = self.rows.get(self.selected)?;
        match self.kind? {
            RoomPickerKind::Models(agent) => Some(RoomPickerChoice::Model {
                agent,
                model_id: row.id.clone(),
            }),
            RoomPickerKind::Skills(agent) => Some(RoomPickerChoice::Skill {
                agent,
                name: row.id.clone(),
            }),
            RoomPickerKind::Sessions => Some(RoomPickerChoice::Session {
                session_id: row.id.clone(),
                current: row.current,
            }),
        }
    }

    pub fn begin_model_select(
        &mut self,
        agent: RoomCatalogAgent,
        model_id: String,
    ) -> RoomPickerRequest {
        let request_id = self.next_request();
        self.status = PickerStatus::Loading {
            request_id,
            applying: true,
        };
        RoomPickerRequest::SelectModel {
            request_id,
            agent,
            model_id,
        }
    }

    pub fn apply_models(&mut self, request_id: u64, result: Result<RoomModelCatalog, String>) {
        let Some(RoomPickerKind::Models(expected_agent)) = self.kind else {
            return;
        };
        let PickerStatus::Loading {
            request_id: expected_request,
            applying,
        } = self.status
        else {
            return;
        };
        if request_id != expected_request {
            return;
        }
        match result {
            Ok(catalog) if catalog.agent == expected_agent => {
                self.rows = catalog
                    .models
                    .into_iter()
                    .map(|model| PickerRow {
                        current: catalog.current_model_id.as_deref() == Some(model.id.as_str()),
                        id: model.id,
                        label: model.label,
                        description: model.description.unwrap_or_default(),
                    })
                    .collect();
                self.selected = self.rows.iter().position(|row| row.current).unwrap_or(0);
                self.status = PickerStatus::Ready {
                    notice: applying.then(|| "Applied to the live session".to_owned()),
                };
            }
            Ok(_) => {
                self.status = PickerStatus::Error("Host returned the wrong agent catalog".into())
            }
            Err(message) => self.status = PickerStatus::Error(message),
        }
    }

    pub fn apply_sessions(&mut self, request_id: u64, result: Result<Vec<RoomSessionRow>, String>) {
        if self.kind != Some(RoomPickerKind::Sessions) {
            return;
        }
        let PickerStatus::Loading {
            request_id: expected_request,
            ..
        } = self.status
        else {
            return;
        };
        if request_id != expected_request {
            return;
        }
        match result {
            Ok(sessions) => {
                self.rows = sessions
                    .into_iter()
                    .map(|session| {
                        let current = session.session_id == self.current_session_id;
                        PickerRow {
                            id: session.session_id,
                            label: session.title,
                            description: if current {
                                format!("current · {}", session.cwd)
                            } else {
                                format!("{} · {}", session.updated_at, session.cwd)
                            },
                            current,
                        }
                    })
                    .collect();
                self.selected = self.rows.iter().position(|row| !row.current).unwrap_or(0);
                self.status = PickerStatus::Ready { notice: None };
            }
            Err(message) => self.status = PickerStatus::Error(message),
        }
    }

    pub fn overlay(&self) -> Option<RoomComposerOverlay> {
        let kind = self.kind?;
        let (title, accent, empty_text) = match kind {
            RoomPickerKind::Models(agent) => (
                format!("Models  {}", agent_tabs(agent)),
                agent.identity().color(),
                format!("No models advertised by {}", agent.name()),
            ),
            RoomPickerKind::Skills(agent) => (
                format!("Skills  {}", agent_tabs(agent)),
                agent.identity().color(),
                format!("No supported skills for {}", agent.name()),
            ),
            RoomPickerKind::Sessions => (
                "Resume conversation".to_owned(),
                crate::room_theme::RoomIdentity::You.color(),
                "No other V2 conversations found".to_owned(),
            ),
        };
        let empty = match &self.status {
            PickerStatus::Loading { applying, .. } if self.rows.is_empty() => Some(
                if *applying {
                    "Applying model…"
                } else {
                    "Loading…"
                }
                .to_owned(),
            ),
            PickerStatus::Error(message) if self.rows.is_empty() => {
                Some(format!("Error: {message}"))
            }
            PickerStatus::Ready { .. } if self.rows.is_empty() => Some(empty_text),
            _ => None,
        };
        let footer = match &self.status {
            PickerStatus::Loading { applying, .. } => Some(
                if *applying {
                    "Applying to live session… · Esc close"
                } else {
                    "Loading provider data… · Esc close"
                }
                .to_owned(),
            ),
            PickerStatus::Error(message) => Some(format!("{message} · R retry · Esc close")),
            PickerStatus::Ready { notice } => Some(match kind {
                RoomPickerKind::Models(_) => format!(
                    "{}{}",
                    notice
                        .as_deref()
                        .map(|value| format!("{value} · "))
                        .unwrap_or_default(),
                    "←→ agent · ↑↓ choose · Enter apply · Esc close"
                ),
                RoomPickerKind::Skills(_) => {
                    "←→ agent · ↑↓ choose · Enter stage · Esc close".to_owned()
                }
                RoomPickerKind::Sessions => "↑↓ choose · Enter resume · Esc close".to_owned(),
            }),
            PickerStatus::Closed => None,
        };
        Some(picker_overlay(
            title,
            self.rows
                .iter()
                .map(|row| {
                    let label = if row.current {
                        format!("● {}", row.label)
                    } else {
                        row.label.clone()
                    };
                    (label, row.description.clone(), accent)
                })
                .collect(),
            self.selected,
            empty,
            footer,
        ))
    }

    fn next_request(&mut self) -> u64 {
        let request_id = self.next_request_id;
        self.next_request_id = self.next_request_id.wrapping_add(1).max(1);
        request_id
    }
}

fn skill_rows(agent: RoomCatalogAgent, catalog: &RoomCatalogSnapshot) -> Vec<PickerRow> {
    catalog
        .rows(agent)
        .iter()
        .filter(|row| row.kind == CatalogKind::Skill)
        .map(|row| PickerRow {
            id: row.name.clone(),
            label: row.name.clone(),
            description: row.description.clone(),
            current: false,
        })
        .collect()
}

fn shifted_agent(agent: RoomCatalogAgent, delta: isize) -> RoomCatalogAgent {
    let index = match agent {
        RoomCatalogAgent::Claude => 0,
        RoomCatalogAgent::Codex => 1,
        RoomCatalogAgent::Gemini => 2,
    };
    match (index as isize + delta).rem_euclid(3) {
        0 => RoomCatalogAgent::Claude,
        1 => RoomCatalogAgent::Codex,
        _ => RoomCatalogAgent::Gemini,
    }
}

fn agent_tabs(selected: RoomCatalogAgent) -> String {
    [
        RoomCatalogAgent::Claude,
        RoomCatalogAgent::Codex,
        RoomCatalogAgent::Gemini,
    ]
    .into_iter()
    .map(|agent| {
        if agent == selected {
            format!("[{}]", agent.name())
        } else {
            agent.name().to_owned()
        }
    })
    .collect::<Vec<_>>()
    .join(" ")
}

#[cfg(all(test, feature = "room-runtime"))]
mod tests {
    use serde_json::json;

    use super::*;

    fn catalog() -> RoomCatalogSnapshot {
        RoomCatalogSnapshot::from_host_value(&json!({
            "version": 1,
            "agents": {
                "claude": [{"name":"review","description":"review changes","kind":"skill","trusted":false}],
                "codex": [],
                "gemini": []
            }
        }))
        .unwrap()
    }

    #[test]
    fn model_picker_rejects_stale_results_and_marks_provider_selection() {
        let mut picker = RoomPickerState::new("chat-current".into());
        let request = picker.open_models(RoomCatalogAgent::Claude);
        picker.apply_models(
            request.request_id() + 1,
            Ok(RoomModelCatalog::from_host_value(&json!({
                "version":1,"agent":"claude","models":[{"id":"sonnet","label":"Sonnet"}]
            }))
            .unwrap()),
        );
        assert!(matches!(picker.status, PickerStatus::Loading { .. }));
        picker.apply_models(
            request.request_id(),
            Ok(RoomModelCatalog::from_host_value(&json!({
                "version":1,"agent":"claude","currentModelId":"sonnet",
                "models":[{"id":"sonnet","label":"Sonnet"},{"id":"opus","label":"Opus","description":"Most capable"}]
            })).unwrap()),
        );
        assert_eq!(picker.rows.len(), 2);
        assert!(picker.rows[0].current);
        assert!(
            matches!(picker.selected_choice(), Some(RoomPickerChoice::Model { model_id, .. }) if model_id == "sonnet")
        );
    }

    #[test]
    fn skills_stage_only_real_catalog_rows_and_sessions_mark_current() {
        let mut picker = RoomPickerState::new("chat-current".into());
        picker.open_skills(RoomCatalogAgent::Claude, &catalog());
        assert!(
            matches!(picker.selected_choice(), Some(RoomPickerChoice::Skill { name, .. }) if name == "review")
        );

        let request = picker.open_sessions();
        picker.apply_sessions(request.request_id(), parse_room_sessions(&json!({"sessions":[
            {"sessionId":"chat-current","cwd":"D:/work","title":"Current","updatedAt":"2026-08-13T00:00:00Z"},
            {"sessionId":"chat-other","cwd":"D:/work","title":"Other","updatedAt":"2026-08-12T00:00:00Z"}
        ]})));
        assert_eq!(
            picker.selected, 1,
            "resume defaults to another conversation"
        );
        assert!(
            matches!(picker.selected_choice(), Some(RoomPickerChoice::Session { session_id, current: false }) if session_id == "chat-other")
        );
    }
}
