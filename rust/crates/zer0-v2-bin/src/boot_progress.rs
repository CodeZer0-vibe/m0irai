//! Startup progress: what the host is doing, and how long the terminal is willing to wait for it.
//!
//! The defect this exists for: `initialize` and `session/new` shared ONE fixed twenty-second budget
//! counted from spawn, and `session/new` is answered only after the host has opened the evidence
//! ledger, claimed the project lock, run the carrier migration, opened the session and replayed the
//! journal. On a loaded machine that exceeded twenty seconds, and the executable printed one line —
//! `host request timed out: zer0-request-2` — and quit. The operator could not tell a slow first boot
//! from a hung one, because nothing on the wire distinguished them.
//!
//! So the host now says which stage it is inside, and the deadline becomes an INACTIVITY budget: it is
//! renewed by progress, never by the clock. A host that keeps reporting keeps its terminal, up to an
//! absolute ceiling; a host that goes silent still dies, on the same schedule it always did.
//!
//! WIRE, NOT ROOM PROTOCOL. These frames never reach [`crate::transport`]: the room transport's frame
//! decoder accepts exactly one notification method (`zer0/room/event`) and treats anything else as
//! fatal, which is correct and stays that way. The stdout reader classifies a boot-progress line
//! first and hands everything else on unchanged. Nothing here is journaled, sequenced or replayed.

use std::time::Duration;

use serde_json::Value;

/// The notification method. Under the existing `zer0/room/` namespace and produced by
/// `src/room/room-boot-progress.ts`, which owns the matching stage keys.
pub const BOOT_PROGRESS_METHOD: &str = "zer0/room/boot_progress";

/// Longest a detail may be before it is refused. Matches the producer's own bound; a detail is one
/// short phrase on a cooked-mode line, never a payload.
const MAX_DETAIL_CHARS: usize = 80;
/// Longest a stage key may be. Generous against the five that exist, tight enough that an unknown key
/// printed verbatim cannot become the whole screen.
const MAX_STAGE_CHARS: usize = 40;

/// One stage report from the host.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BootProgress {
    stage: String,
    detail: Option<String>,
}

impl BootProgress {
    /// The machine key, for anything that needs to compare stages rather than show them.
    pub fn stage(&self) -> &str {
        &self.stage
    }

    /// What the operator is told the host is doing, detail included.
    ///
    /// The words live HERE rather than on the wire because the terminal is what puts them on a screen:
    /// a wire string is not a place to keep wording, and a host and a terminal that disagree about a
    /// release should still agree about what a stage IS. An unrecognised key is shown verbatim, which
    /// is how a newer host's extra stage stays useful to an older terminal instead of breaking it.
    pub fn describe(&self) -> String {
        let words = match self.stage.as_str() {
            "evidence" => "opening the evidence ledger",
            "liveness" => "claiming the project lock",
            "migrate" => "migrating the evidence ledger",
            "session" => "opening the session",
            "journal" => "replaying the room journal",
            other => other,
        };
        match &self.detail {
            Some(detail) => format!("{words} ({detail})"),
            None => words.to_owned(),
        }
    }
}

/// What one host stdout line turned out to be.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BootFrame {
    /// A valid stage report. Renews the wait; never reaches the room transport.
    Progress(BootProgress),
    /// Not a boot-progress frame at all — a response or a room event. Hand it to the transport
    /// unchanged, which is what every frame did before this module existed.
    RoomFrame,
    /// Claims to be boot progress and is not valid. Fatal, and deliberately so: the alternative is to
    /// pass it to the room transport, which would report the same failure in less useful words.
    Malformed(String),
}

/// Classifies one host stdout line.
///
/// Cheap on the hot path by construction: the JSON is parsed only for a line that actually contains
/// the method name, so an ordinary room event costs one substring search. Every line the host sends
/// after startup takes that path.
pub fn classify_boot_frame(line: &[u8]) -> BootFrame {
    if !contains_method(line) {
        return BootFrame::RoomFrame;
    }
    let Ok(value) = serde_json::from_slice::<Value>(line) else {
        return BootFrame::RoomFrame;
    };
    let Some(object) = value.as_object() else {
        return BootFrame::RoomFrame;
    };
    if object.get("method").and_then(Value::as_str) != Some(BOOT_PROGRESS_METHOD) {
        return BootFrame::RoomFrame;
    }
    if object.len() != 3 || object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return BootFrame::Malformed(
            "boot progress must be exactly {jsonrpc,method,params}".into(),
        );
    }
    let Some(params) = object.get("params").and_then(Value::as_object) else {
        return BootFrame::Malformed("boot progress params must be an object".into());
    };
    if params.len() > 2 || !params.keys().all(|key| key == "stage" || key == "detail") {
        return BootFrame::Malformed("boot progress params accept only stage and detail".into());
    }
    let Some(stage) = params.get("stage").and_then(Value::as_str).filter(|stage| {
        !stage.is_empty() && stage.chars().count() <= MAX_STAGE_CHARS && printable(stage)
    }) else {
        return BootFrame::Malformed("boot progress stage must be a short printable string".into());
    };
    let detail = match params.get("detail") {
        None => None,
        Some(value) => match value.as_str().filter(|detail| {
            !detail.is_empty() && detail.chars().count() <= MAX_DETAIL_CHARS && printable(detail)
        }) {
            Some(detail) => Some(detail.to_owned()),
            None => {
                return BootFrame::Malformed(
                    "boot progress detail must be a short printable string".into(),
                );
            }
        },
    };
    BootFrame::Progress(BootProgress {
        stage: stage.to_owned(),
        detail,
    })
}

/// Rejects C0 and DEL. The stage and its detail are printed onto a cooked-mode terminal line, so an
/// escape sequence smuggled through here would be EXECUTED by the terminal rather than shown. The
/// producer is our own host, which makes this a defence against a bug rather than an attacker — and a
/// bug that repaints the operator's screen during a failed boot is exactly the one nobody would find.
fn printable(value: &str) -> bool {
    !value
        .chars()
        .any(|character| character.is_control() || character == '\u{7f}')
}

/// A substring test before the JSON parse. The method name cannot occur in a room event: event types
/// are a closed set and no payload string is echoed onto the wire unescaped, so a false positive costs
/// one parse and a false negative is impossible for a frame we produce.
fn contains_method(line: &[u8]) -> bool {
    line.windows(BOOT_PROGRESS_METHOD.len())
        .any(|window| window == BOOT_PROGRESS_METHOD.as_bytes())
}

/// How long startup waits, expressed as the three bounds that actually matter.
///
/// MEASURED, not chosen. On this machine at ~100 % CPU (seven other agents resident), a first boot's
/// stages cost: evidence open 36–93 ms, project lock 345–965 ms, session open 195–637 ms. The slowest
/// single stage is therefore about one second.
///
/// `handshake` bounds the two steps that pay for STARTING AN INTERPRETER — spawning the host and
/// getting `initialize` back — and it is separate from `inactivity` because those two costs differ by
/// an order of magnitude and are not the same measurement. Spawning Node on the mock host and reading
/// its first response measured 398–1,640 ms across 52 samples at 100 % CPU; once the host is running,
/// the gap between two of its own reports is a scheduled timer, measured at most 283 ms for a 150 ms
/// step across 80 samples on the same box. One number for both jobs is either too tight for the first
/// or needlessly slow for the second, and it was too tight: a 700 ms test budget made four
/// process-level tests a coin flip, because `initialize` timed out before the subject was reached.
///
/// `inactivity` is 20 s — twenty times the slowest measured boot stage, and deliberately the SAME
/// number as the fixed budget this whole mechanism replaces. That equality is the point: a host that
/// reports nothing at all is given exactly the rope it had before, so nothing about a genuinely dead
/// host gets slower. What changed is that the rope is now renewed by evidence of life.
///
/// `ceiling` is 120 s: about seventy times the measured total, and the point past which relaunching is
/// faster than waiting. It exists so a host that reports progress forever — a migration in a loop, a
/// lock retried without end — cannot hold the terminal open indefinitely. A budget with no ceiling is
/// not a deadline, it is a promise.
///
/// The SHIPPED numbers are unchanged by the split: `handshake` and `inactivity` are both 20 s, which is
/// exactly what `min(inactivity, ceiling_left)` gave the handshake before. Only a caller that sets its
/// own budget can now tell the two apart.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StartupBudget {
    /// Longest the spawn and the `initialize` handshake may take. Pays interpreter startup.
    pub handshake: Duration,
    /// Longest silence tolerated once the host is running: no progress, no response.
    pub inactivity: Duration,
    /// Absolute bound on the whole startup, however much progress arrives.
    pub ceiling: Duration,
}

impl Default for StartupBudget {
    fn default() -> Self {
        Self {
            handshake: Duration::from_secs(20),
            inactivity: Duration::from_secs(20),
            ceiling: Duration::from_secs(120),
        }
    }
}

/// One request's share of a [`StartupBudget`]: the same inactivity bound, and whatever is left of the
/// absolute ceiling by the time this request starts. Derived per request rather than stored, so a
/// startup that has already spent ninety seconds cannot hand the next stage a fresh two minutes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProgressWait {
    pub inactivity: Duration,
    pub ceiling: Duration,
}

/// Why a startup stopped waiting. Separate from the stage so the message can say which bound was hit
/// without the caller re-deriving it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StallKind {
    /// Nothing arrived for the whole inactivity budget.
    Silent,
    /// Progress kept arriving but the absolute ceiling ran out.
    Ceiling,
}

/// The sentence the operator reads when startup gives up.
///
/// It carries THREE quantities, not one: the stage, how long the whole step had been running, and the
/// bound that was actually exceeded. The first round reported a single duration, and which duration it
/// was depended on the path — the review found "did not finish X within 70s" printed against a 20 s
/// budget, because 70 s was the elapsed time and 20 s was the rule. Both numbers are true and neither
/// is the sentence on its own, so both are named and labelled.
///
/// `stage` is the last thing the host reported, or a description of the step when nothing was reported.
pub fn stall_message(stage: &str, kind: StallKind, waited: Duration, budget: Duration) -> String {
    let waited = waited.as_secs();
    let budget = budget.as_secs();
    match kind {
        StallKind::Silent => format!(
            "the room host stopped reporting during \"{stage}\": nothing for {budget}s, {waited}s into startup"
        ),
        StallKind::Ceiling => format!(
            "the room host was still working on \"{stage}\" after {waited}s, and startup waits at most {budget}s"
        ),
    }
}

#[cfg(test)]
mod tests;
