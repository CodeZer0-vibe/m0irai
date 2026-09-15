//! Strict, bounded host snapshots consumed by the room picker.

use serde_json::Value;

use crate::room_composer_menu::RoomCatalogAgent;

const MAX_MODELS: usize = 128;
const MAX_SESSIONS: usize = 128;
const MAX_MODEL_ID_BYTES: usize = 512;
const MAX_LABEL_BYTES: usize = 240;
const MAX_DESCRIPTION_BYTES: usize = 512;
const MAX_SESSION_ID_BYTES: usize = 160;
const MAX_CWD_BYTES: usize = 1_024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoomModelRow {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoomModelCatalog {
    pub agent: RoomCatalogAgent,
    pub models: Vec<RoomModelRow>,
    pub current_model_id: Option<String>,
}

impl RoomModelCatalog {
    pub fn from_host_value(value: &Value) -> Result<Self, String> {
        let root = required_object(value, "room model catalog")?;
        require_allowed_keys(
            root,
            &["version", "agent", "models", "currentModelId"],
            &["version", "agent", "models"],
            "room model catalog",
        )?;
        if root.get("version").and_then(Value::as_u64) != Some(1) {
            return Err("room model catalog version must be 1".into());
        }
        let agent = root
            .get("agent")
            .and_then(Value::as_str)
            .and_then(RoomCatalogAgent::parse)
            .ok_or_else(|| "room model catalog agent is invalid".to_owned())?;
        let rows = root
            .get("models")
            .and_then(Value::as_array)
            .ok_or_else(|| "room model catalog models must be an array".to_owned())?;
        if rows.len() > MAX_MODELS {
            return Err("room model catalog exceeds row limit".into());
        }
        let mut ids = std::collections::HashSet::new();
        let models = rows
            .iter()
            .map(|value| {
                let row = required_object(value, "room model row")?;
                require_allowed_keys(
                    row,
                    &["id", "label", "description"],
                    &["id", "label"],
                    "room model row",
                )?;
                let id = required_safe_string(row, "id", MAX_MODEL_ID_BYTES)?;
                if !ids.insert(id.clone()) {
                    return Err("room model catalog contains duplicate ids".into());
                }
                let label = required_safe_string(row, "label", MAX_LABEL_BYTES)?;
                let description = optional_safe_string(row, "description", MAX_DESCRIPTION_BYTES)?;
                Ok(RoomModelRow {
                    id,
                    label,
                    description,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let current_model_id = optional_safe_string(root, "currentModelId", MAX_MODEL_ID_BYTES)?;
        if current_model_id
            .as_ref()
            .is_some_and(|current| !models.iter().any(|model| &model.id == current))
        {
            return Err("room model catalog current model is not advertised".into());
        }
        Ok(Self {
            agent,
            models,
            current_model_id,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoomSessionRow {
    pub session_id: String,
    pub cwd: String,
    pub title: String,
    pub updated_at: String,
}

pub fn parse_room_sessions(value: &Value) -> Result<Vec<RoomSessionRow>, String> {
    let root = required_object(value, "room session list")?;
    require_allowed_keys(root, &["sessions"], &["sessions"], "room session list")?;
    let sessions = root
        .get("sessions")
        .and_then(Value::as_array)
        .ok_or_else(|| "room session list sessions must be an array".to_owned())?;
    if sessions.len() > MAX_SESSIONS {
        return Err("room session list exceeds row limit".into());
    }
    let mut ids = std::collections::HashSet::new();
    sessions
        .iter()
        .map(|value| {
            let row = required_object(value, "room session row")?;
            require_allowed_keys(
                row,
                &["sessionId", "cwd", "title", "updatedAt"],
                &["sessionId", "cwd", "title", "updatedAt"],
                "room session row",
            )?;
            let session_id = required_safe_string(row, "sessionId", MAX_SESSION_ID_BYTES)?;
            if !session_id.starts_with("chat-") || !ids.insert(session_id.clone()) {
                return Err("room session list contains an invalid or duplicate id".into());
            }
            Ok(RoomSessionRow {
                session_id,
                cwd: required_safe_string(row, "cwd", MAX_CWD_BYTES)?,
                title: required_safe_string(row, "title", MAX_LABEL_BYTES)?,
                updated_at: required_safe_string(row, "updatedAt", 80)?,
            })
        })
        .collect()
}

fn required_object<'a>(
    value: &'a Value,
    subject: &str,
) -> Result<&'a serde_json::Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("{subject} must be an object"))
}

fn require_allowed_keys(
    object: &serde_json::Map<String, Value>,
    allowed: &[&str],
    required: &[&str],
    subject: &str,
) -> Result<(), String> {
    if object.keys().any(|key| !allowed.contains(&key.as_str()))
        || required.iter().any(|key| !object.contains_key(*key))
    {
        return Err(format!("{subject} has unknown or missing fields"));
    }
    Ok(())
}

fn required_safe_string(
    object: &serde_json::Map<String, Value>,
    key: &str,
    max_bytes: usize,
) -> Result<String, String> {
    let value = object
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{key} must be a string"))?;
    validate_safe_string(value, key, max_bytes)?;
    Ok(value.to_owned())
}

fn optional_safe_string(
    object: &serde_json::Map<String, Value>,
    key: &str,
    max_bytes: usize,
) -> Result<Option<String>, String> {
    match object.get(key) {
        None => Ok(None),
        Some(Value::String(value)) => {
            validate_safe_string(value, key, max_bytes)?;
            Ok(Some(value.clone()))
        }
        Some(_) => Err(format!("{key} must be a string")),
    }
}

fn validate_safe_string(value: &str, subject: &str, max_bytes: usize) -> Result<(), String> {
    if value.is_empty()
        || value.len() > max_bytes
        || value.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '\u{061c}'
                        | '\u{200e}'
                        | '\u{200f}'
                        | '\u{202a}'
                        | '\u{202b}'
                        | '\u{202c}'
                        | '\u{202d}'
                        | '\u{202e}'
                        | '\u{2066}'
                        | '\u{2067}'
                        | '\u{2068}'
                        | '\u{2069}'
                )
        })
    {
        return Err(format!("{subject} contains unsafe or oversized text"));
    }
    Ok(())
}

#[cfg(all(test, feature = "room-runtime"))]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn provider_snapshots_are_strict_and_terminal_safe() {
        assert!(
            RoomModelCatalog::from_host_value(&json!({
                "version":1,"agent":"claude","models":[{"id":"x","label":"bad\u{0007}"}]
            }))
            .is_err()
        );
        assert!(RoomModelCatalog::from_host_value(&json!({
            "version":1,"agent":"claude","currentModelId":"invented","models":[{"id":"x","label":"X"}]
        })).is_err());
        assert!(
            parse_room_sessions(&json!({"sessions":[{
                "sessionId":"chat-a","cwd":"D:/work","title":"Room","updatedAt":"now","extra":true
            }]}))
            .is_err()
        );
    }
}
