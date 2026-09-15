//! The room composer's typed slash commands, parsed.
//!
//! A pure function over text: it takes the composer's line and the agent
//! catalog and returns what the room should do, touching no room state and
//! performing no I/O. Its own file because `room_runtime.rs` has no Rust clamp
//! gate (FL-135), three lanes edit it at once this wave, and a parser nobody
//! else touches does not belong in the middle of the seam they share.
//!
//! ⚠ **This module cannot build a `RoomCommand::Submit`, and that is
//! deliberate.** Submitting needs a `SubmissionId`, and minting one is the same
//! call that queues the prompt a later cancel would hand back
//! (`PendingRestores::submitted`). A parser has no room to queue into. So
//! `/council <topic>` — the one slash command the host accepts as a submit —
//! returns [`ParsedRoomCommand::Submit`] and the caller does both. Before
//! FL-126 round 3 it built the command here instead, which is exactly how a
//! council turn came to claim a different submission's prompt.

use super::{RoomCancelScope, RoomCommand, RoomControlCommand};
use crate::room_composer_menu::{RoomCatalogAgent, RoomCatalogSnapshot};

#[derive(Debug)]
pub(super) enum ParsedRoomCommand {
    /// Text the host takes as a submission. Carries nothing: the text is
    /// already in the caller's hand, and the command needs an id the parser
    /// cannot mint.
    Submit,
    Host(RoomCommand),
    Models(RoomCatalogAgent),
    Skills(RoomCatalogAgent),
    Sessions,
    NewSession,
    Exit,
    History,
    Status,
    DebateUnavailable,
    InvalidSlash,
    Help,
}

pub(super) fn parse_room_command(
    text: &str,
    catalog: &RoomCatalogSnapshot,
) -> Option<ParsedRoomCommand> {
    let mut words = text.split_whitespace();
    match words.next()? {
        "/model" | "/models" => parse_picker_agent(words.next(), words.next())
            .map(ParsedRoomCommand::Models)
            .or(Some(ParsedRoomCommand::InvalidSlash)),
        "/skills" => parse_picker_agent(words.next(), words.next())
            .map(ParsedRoomCommand::Skills)
            .or(Some(ParsedRoomCommand::InvalidSlash)),
        "/resume" | "/continue" if words.next().is_none() => Some(ParsedRoomCommand::Sessions),
        "/new" if words.next().is_none() => Some(ParsedRoomCommand::NewSession),
        "/exit" if words.next().is_none() => Some(ParsedRoomCommand::Exit),
        "/history" if words.next().is_none() => Some(ParsedRoomCommand::History),
        "/status" if words.next().is_none() => Some(ParsedRoomCommand::Status),
        "/debate" => Some(ParsedRoomCommand::DebateUnavailable),
        // NOT a `Host(RoomCommand::Submit(..))`: the command cannot be built
        // here, because building it requires the submission id that only
        // queueing the held prompt can mint. The caller does both (FL-126).
        "/council" if words.next().is_some() => Some(ParsedRoomCommand::Submit),
        "/help" if words.next().is_none() => Some(ParsedRoomCommand::Help),
        "/mode" => parse_mode_target(words.next(), words.next())
            .map(|composer_text| ParsedRoomCommand::Host(RoomCommand::CycleMode { composer_text }))
            .or(Some(ParsedRoomCommand::InvalidSlash)),
        "/pause" if words.next().is_none() => Some(ParsedRoomCommand::Host(RoomCommand::Control {
            command: RoomControlCommand::Pause,
            scope: None,
            agent: None,
        })),
        "/unpause" if words.next().is_none() => {
            Some(ParsedRoomCommand::Host(RoomCommand::Control {
                command: RoomControlCommand::Resume,
                scope: None,
                agent: None,
            }))
        }
        "/cancel" => (match words.next() {
            None => Some(ParsedRoomCommand::Host(RoomCommand::Control {
                command: RoomControlCommand::Cancel,
                scope: Some(RoomCancelScope::Latest),
                agent: None,
            })),
            Some("latest") if words.next().is_none() => {
                Some(ParsedRoomCommand::Host(RoomCommand::Control {
                    command: RoomControlCommand::Cancel,
                    scope: Some(RoomCancelScope::Latest),
                    agent: None,
                }))
            }
            Some("all") if words.next().is_none() => {
                Some(ParsedRoomCommand::Host(RoomCommand::Control {
                    command: RoomControlCommand::Cancel,
                    scope: Some(RoomCancelScope::All),
                    agent: None,
                }))
            }
            Some(agent @ ("claude" | "codex" | "gemini")) if words.next().is_none() => {
                Some(ParsedRoomCommand::Host(RoomCommand::Control {
                    command: RoomControlCommand::Cancel,
                    scope: Some(RoomCancelScope::Agent),
                    agent: Some(agent.into()),
                }))
            }
            _ => None,
        })
        .or(Some(ParsedRoomCommand::InvalidSlash)),
        "/approve" => (match (words.next(), words.next(), words.next()) {
            (Some(ask_id), Some(option_id), None) => {
                Some(ParsedRoomCommand::Host(RoomCommand::PermissionResponse(
                    crate::room_permission_view::RoomPermissionAction::SelectOption {
                        ask_id: ask_id.into(),
                        option_id: option_id.into(),
                    },
                )))
            }
            _ => None,
        })
        .or(Some(ParsedRoomCommand::InvalidSlash)),
        addressed @ ("@claude" | "@codex" | "@gemini") => {
            let agent = RoomCatalogAgent::parse(addressed.trim_start_matches('@'))?;
            let command = words.next();
            let has_arguments = words.next().is_some();
            match command {
                Some("/model" | "/models") if !has_arguments => {
                    Some(ParsedRoomCommand::Models(agent))
                }
                Some("/skills") if !has_arguments => Some(ParsedRoomCommand::Skills(agent)),
                Some("/model" | "/models" | "/skills") => Some(ParsedRoomCommand::InvalidSlash),
                Some(command) if command.starts_with('/') => {
                    if catalog.has_command(agent, command.trim_start_matches('/')) {
                        None
                    } else {
                        Some(ParsedRoomCommand::InvalidSlash)
                    }
                }
                _ => None,
            }
        }
        _ if text.trim_start().starts_with('/') => Some(ParsedRoomCommand::InvalidSlash),
        _ => None,
    }
}

fn parse_picker_agent(requested: Option<&str>, trailing: Option<&str>) -> Option<RoomCatalogAgent> {
    if trailing.is_some() {
        return None;
    }
    requested
        .map(|value| value.trim_start_matches('@'))
        .map(RoomCatalogAgent::parse)
        .unwrap_or(Some(RoomCatalogAgent::Claude))
}

fn parse_mode_target(requested: Option<&str>, trailing: Option<&str>) -> Option<String> {
    if trailing.is_some() {
        return None;
    }
    let target = requested.unwrap_or("all").trim_start_matches('@');
    matches!(target, "all" | "claude" | "codex" | "gemini").then(|| format!("@{target}"))
}
