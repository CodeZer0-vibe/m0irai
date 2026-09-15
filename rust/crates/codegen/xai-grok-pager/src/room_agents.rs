//! The strict decoder for `zer0/room/agents` — the host's boot readiness snapshot.
//!
//! ⚠ THE REMEDY COMMAND IS RENDERED TO A TERMINAL, so it is treated as UNTRUSTED TEXT on principle
//! even though we author it. Exact keys, a pinned version, bounded lengths and a control/bidi
//! rejection, the same discipline `RoomCatalogSnapshot::from_host_value` already applies — because the
//! day this stops being a string we wrote is the day nobody remembers it used to be.
//!
//! FAIL-SOFT AT THE CALLER, NOT HERE. This returns a `Result` and the room's probe task maps it to the
//! default snapshot, exactly as the catalog request does. A malformed response costs the operator their
//! chips' readiness detail; it never costs them the room.

use serde_json::Value;

use crate::room_view::{RoomAgentReadiness, RoomReadinessSnapshot};

/// A sign-in command or an install remedy. Long enough for any real command, short enough that a
/// hostile string cannot push the boot card off its own frame.
const MAX_REMEDY_CHARS: usize = 120;

/// Decodes the host's `zer0/room/agents` result. Unknown keys, a wrong version, an unrecognised state
/// or unsafe text are all errors — the caller defaults, and defaulting means every agent `Unknown`,
/// which renders exactly as `Ready`.
pub fn readiness_from_host_value(value: &Value) -> Result<RoomReadinessSnapshot, String> {
    let root = value
        .as_object()
        .ok_or_else(|| "room agents must be an object".to_owned())?;
    require_exact_keys(root, &["version", "agents"], "room agents")?;
    if root.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("room agents version must be 1".into());
    }
    let agents = root
        .get("agents")
        .and_then(Value::as_object)
        .ok_or_else(|| "room agents agents must be an object".to_owned())?;
    require_exact_keys(agents, &["claude", "codex", "gemini"], "room agents agents")?;
    Ok(RoomReadinessSnapshot {
        claude: parse_readiness(agents.get("claude").expect("exact keys checked"), "claude")?,
        codex: parse_readiness(agents.get("codex").expect("exact keys checked"), "codex")?,
        gemini: parse_readiness(agents.get("gemini").expect("exact keys checked"), "gemini")?,
    })
}

fn parse_readiness(value: &Value, agent: &str) -> Result<RoomAgentReadiness, String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("room agents {agent} must be an object"))?;
    let state = object
        .get("state")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("room agents {agent} needs a state"))?;
    match state {
        "ready" => {
            require_exact_keys(object, &["state"], agent)?;
            Ok(RoomAgentReadiness::Ready)
        }
        "unknown" => {
            require_exact_keys(object, &["state"], agent)?;
            Ok(RoomAgentReadiness::Unknown)
        }
        "needs_login" => {
            require_exact_keys(object, &["state", "command"], agent)?;
            Ok(RoomAgentReadiness::NeedsLogin {
                command: safe_text(object.get("command"), agent, "command")?,
            })
        }
        "unusable" => {
            require_exact_keys(object, &["state", "reason", "remedy"], agent)?;
            Ok(RoomAgentReadiness::Unusable {
                reason: safe_text(object.get("reason"), agent, "reason")?,
                remedy: safe_text(object.get("remedy"), agent, "remedy")?,
            })
        }
        // An UNRECOGNISED state is an error and not a silent Unknown. The two look the same on screen,
        // and that is exactly the problem: a host that started sending a fourth state would render as
        // "we did not ask" forever, with nothing anywhere saying the versions had diverged.
        other => Err(format!("room agents {agent} has an unknown state: {other}")),
    }
}

fn safe_text(value: Option<&Value>, agent: &str, field: &str) -> Result<String, String> {
    let text = value
        .and_then(Value::as_str)
        .ok_or_else(|| format!("room agents {agent} {field} must be a string"))?;
    if text.is_empty() {
        return Err(format!("room agents {agent} {field} must not be empty"));
    }
    if text.chars().count() > MAX_REMEDY_CHARS {
        return Err(format!(
            "room agents {agent} {field} exceeds its length limit"
        ));
    }
    if contains_unsafe_text(text) {
        return Err(format!("room agents {agent} {field} contains unsafe text"));
    }
    Ok(text.to_owned())
}

fn require_exact_keys(
    object: &serde_json::Map<String, Value>,
    expected: &[&str],
    subject: &str,
) -> Result<(), String> {
    if object.len() != expected.len() || object.keys().any(|key| !expected.contains(&key.as_str()))
    {
        return Err(format!("{subject} has unknown or missing fields"));
    }
    Ok(())
}

// Control characters and the bidi overrides. A remedy is printed into a roster cell beside two other
// agents' names; a right-to-left override in it rearranges the line around it.
fn contains_unsafe_text(text: &str) -> bool {
    text.chars().any(|character| {
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot(agents: Value) -> Result<RoomReadinessSnapshot, String> {
        readiness_from_host_value(&json!({ "version": 1, "agents": agents }))
    }

    #[test]
    fn decodes_every_state_the_host_can_send() {
        let decoded = snapshot(json!({
            "claude": { "state": "ready" },
            "codex": { "state": "needs_login", "command": "codex login" },
            "gemini": {
                "state": "unusable",
                "reason": "the Antigravity CLI is not installed",
                "remedy": "install the Antigravity CLI"
            }
        }))
        .expect("a well-formed snapshot decodes");
        assert_eq!(decoded.claude, RoomAgentReadiness::Ready);
        assert_eq!(
            decoded.codex,
            RoomAgentReadiness::NeedsLogin {
                command: "codex login".to_owned()
            }
        );
        assert_eq!(
            decoded.gemini,
            RoomAgentReadiness::Unusable {
                reason: "the Antigravity CLI is not installed".to_owned(),
                remedy: "install the Antigravity CLI".to_owned()
            }
        );
    }

    /// The remedy reaches a terminal. It is ours today and that is not a reason to trust it — the day
    /// it stops being ours is the day nobody remembers it used to be.
    #[test]
    fn rejects_untrusted_text_in_a_remedy() {
        for hostile in [
            "codex login\u{202e}",
            "codex login\nrm -rf /",
            "codex login\u{2066}",
            "codex\u{7}login",
        ] {
            let decoded = snapshot(json!({
                "claude": { "state": "ready" },
                "codex": { "state": "needs_login", "command": hostile },
                "gemini": { "state": "ready" }
            }));
            assert!(
                decoded.is_err(),
                "a hostile remedy decoded: {hostile:?} -> {decoded:?}"
            );
        }
        let long = "x".repeat(MAX_REMEDY_CHARS + 1);
        assert!(
            snapshot(json!({
                "claude": { "state": "ready" },
                "codex": { "state": "needs_login", "command": long },
                "gemini": { "state": "ready" }
            }))
            .is_err()
        );
    }

    #[test]
    fn rejects_a_shape_that_does_not_match_its_state() {
        // A needs_login with no command, and a ready carrying one, are both version drift wearing a
        // valid-looking shape. Each would render a chip that states a problem and offers nothing, or
        // one that carries a command it will never show.
        for bad in [
            json!({ "state": "needs_login" }),
            json!({ "state": "ready", "command": "codex login" }),
            json!({ "state": "unusable", "reason": "gone" }),
            json!({ "state": "signed_out" }),
            json!({ "state": "needs_login", "command": "" }),
        ] {
            assert!(
                snapshot(json!({
                    "claude": { "state": "ready" },
                    "codex": bad,
                    "gemini": { "state": "ready" }
                }))
                .is_err(),
                "a malformed agent decoded"
            );
        }
    }

    #[test]
    fn rejects_a_wrong_version_and_unknown_top_level_keys() {
        assert!(
            readiness_from_host_value(&json!({
                "version": 2,
                "agents": { "claude": { "state": "ready" }, "codex": { "state": "ready" }, "gemini": { "state": "ready" } }
            }))
            .is_err()
        );
        assert!(
            readiness_from_host_value(&json!({
                "version": 1,
                "extra": true,
                "agents": { "claude": { "state": "ready" }, "codex": { "state": "ready" }, "gemini": { "state": "ready" } }
            }))
            .is_err()
        );
        // A missing seat is drift too: the room has three, and two is a different protocol.
        assert!(
            readiness_from_host_value(&json!({
                "version": 1,
                "agents": { "claude": { "state": "ready" }, "codex": { "state": "ready" } }
            }))
            .is_err()
        );
    }

    #[test]
    fn a_default_snapshot_is_every_agent_unknown() {
        // What the caller falls back to. It has to be the state that renders exactly as ready, or a
        // malformed response would paint three broken agents.
        let default = RoomReadinessSnapshot::default();
        assert_eq!(default.claude, RoomAgentReadiness::Unknown);
        assert_eq!(default.codex, RoomAgentReadiness::Unknown);
        assert_eq!(default.gemini, RoomAgentReadiness::Unknown);
    }
}
