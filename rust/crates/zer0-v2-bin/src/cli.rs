//! Small, strict public CLI surface and cooked-mode room startup.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::boot_progress::{ProgressWait, StallKind, StartupBudget, stall_message};
use crate::host_process::{HostClient, HostError, HostProcess, HostProcessOptions};

/// The longest startup may stay SILENT before the terminal starts naming the stage. Below it the boot
/// is quiet, which is the operator's standing rule for this screen; above it they are looking at a
/// black terminal and silence has stopped being restraint.
const BOOT_NARRATION_DELAY: Duration = Duration::from_secs(3);

/// What a stall names before any stage exists. Two of them, because "the host never started" and "the
/// host started and then said nothing" are different failures with different next moves.
const SPAWN_STAGE: &str = "starting the room host";
const HANDSHAKE_STAGE: &str = "the room host handshake";
const READINESS_STAGE: &str = "the room's first sync";

/// A host whose session has completed the strict startup handshake and initial
/// room resynchronization. The caller owns shutdown and reaping.
pub struct StartedRoom {
    pub host: HostProcess,
    pub session_id: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CliMode {
    New,
    Continue,
    #[cfg(feature = "room-visual-fixture")]
    VisualFixture,
    #[cfg(feature = "welcome-demo")]
    WelcomeDemo,
    Help,
    Version,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum RoomStartup {
    New,
    Continue,
    Load(String),
}

impl RoomStartup {
    fn from_cli(mode: CliMode) -> Self {
        match mode {
            CliMode::New => Self::New,
            CliMode::Continue => Self::Continue,
            CliMode::Help | CliMode::Version => unreachable!("handled before room startup"),
            #[cfg(feature = "room-visual-fixture")]
            CliMode::VisualFixture => unreachable!("fixture bypasses host startup"),
            #[cfg(feature = "welcome-demo")]
            CliMode::WelcomeDemo => unreachable!("welcome demo bypasses host startup"),
        }
    }
}

pub fn parse_args(args: impl IntoIterator<Item = String>) -> Result<CliMode, String> {
    let mut args = args.into_iter();
    let _program = args.next();
    match (args.next().as_deref(), args.next()) {
        (None, None) => Ok(CliMode::New),
        (Some("--continue"), None) => Ok(CliMode::Continue),
        #[cfg(feature = "room-visual-fixture")]
        (Some("--visual-fixture"), None) => Ok(CliMode::VisualFixture),
        #[cfg(feature = "welcome-demo")]
        (Some("--welcome-demo"), None) => Ok(CliMode::WelcomeDemo),
        (Some("--help" | "-h"), None) => Ok(CliMode::Help),
        (Some("--version" | "-V"), None) => Ok(CliMode::Version),
        (Some(argument), _) => Err(format!("unsupported argument: {argument}")),
        (None, Some(argument)) => Err(format!("unsupported argument: {argument}")),
    }
}

#[cfg(feature = "room-visual-fixture")]
pub fn help_text() -> &'static str {
    "Usage: m0irai [--continue | --visual-fixture]\n\n  --continue        load the newest V2 session\n  --visual-fixture  test-only deterministic pager room fixture\n  --help            show this help\n  --version         show version"
}

#[cfg(all(not(feature = "room-visual-fixture"), feature = "welcome-demo"))]
pub fn help_text() -> &'static str {
    "Usage: m0irai [--continue | --welcome-demo]\n\n  --continue      load the newest V2 session\n  --welcome-demo  demo-only boot-branding preview (r replays, q quits)\n  --help          show this help\n  --version       show version"
}

#[cfg(all(not(feature = "room-visual-fixture"), not(feature = "welcome-demo")))]
pub fn help_text() -> &'static str {
    "Usage: m0irai [--continue]\n\n  --continue  load the newest V2 session\n  --help      show this help\n  --version   show version"
}

pub fn version_text() -> String {
    format!("m0irai {}", env!("CARGO_PKG_VERSION"))
}

#[cfg(feature = "room-visual-fixture")]
fn visual_fixture_post_restore_hold(value: Option<&std::ffi::OsStr>) -> Option<Duration> {
    const MAX_HOLD: Duration = Duration::from_secs(10);
    let milliseconds = value?.to_str()?.parse::<u64>().ok()?;
    (milliseconds > 0).then(|| Duration::from_millis(milliseconds).min(MAX_HOLD))
}

#[cfg(feature = "room-visual-fixture")]
async fn hold_visual_fixture_after_terminal_restore() {
    if let Some(duration) = visual_fixture_post_restore_hold(
        std::env::var_os("ZER0_ROOM_TEST_HOLD_AFTER_RESTORE_MS").as_deref(),
    ) {
        tokio::time::sleep(duration).await;
    }
}

pub async fn run_from_env() -> i32 {
    match parse_args(std::env::args()) {
        Ok(CliMode::Help) => {
            println!("{}", help_text());
            0
        }
        Ok(CliMode::Version) => {
            println!("{}", version_text());
            0
        }
        #[cfg(feature = "welcome-demo")]
        Ok(CliMode::WelcomeDemo) => match crate::pager_room::run_welcome_demo().await {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("m0irai welcome demo: {error}");
                4
            }
        },
        #[cfg(feature = "room-visual-fixture")]
        Ok(CliMode::VisualFixture) => {
            let result = crate::pager_room::run_visual_fixture().await;
            // Fixture-only proof seam: keep the process alive after the pager
            // restores the tty so a detached writer cannot hide behind process
            // exit. The normal feature graph does not compile this path.
            hold_visual_fixture_after_terminal_restore().await;
            match result {
                Ok(()) => 0,
                Err(error) => {
                    eprintln!("m0irai fixture: {error}");
                    4
                }
            }
        }
        Ok(mode) => match run_room(mode).await {
            Ok(()) => 0,
            Err(error) => {
                // Deliberately no raw host stderr or JSON is printed here — with ONE exception, built
                // in `stall_advice`: a startup that stalls has produced no room, no journal and no
                // session folder, so the host's own last lines are the only diagnosis that exists.
                eprintln!("m0irai: {error}");
                exit_code(&error)
            }
        },
        Err(error) => {
            eprintln!("m0irai: {error}\n{}", help_text());
            4
        }
    }
}

#[cfg(feature = "grok-pager-room")]
async fn run_room(mode: CliMode) -> Result<(), HostError> {
    let cwd = std::fs::canonicalize(".").map_err(|error| {
        HostError::Startup(format!("could not resolve current directory: {error}"))
    })?;
    let mut startup = RoomStartup::from_cli(mode);
    loop {
        let StartedRoom { host, session_id } = start_room_for(
            startup,
            &cwd,
            HostProcessOptions::new(&cwd),
            StartupBudget::default(),
            Narration::Stderr,
        )
        .await?;
        let result = crate::pager_room::run(host.client(), session_id).await;
        // Read BEFORE the shutdown, and that order is the whole point: an exit retained HERE is one
        // that happened while the room was still running, which is the only case the operator needs
        // a sentence for. After `shutdown()` every ordinary quit has one too, and printing it then
        // would put a line on the screen after every single quit.
        let ended_while_running = host.client().subscribe_exit().borrow().clone();
        // Session switches never mutate an attached host in place. The pager
        // restores the tty, the old provider/runtime tree is reaped exactly
        // once, and only then is a fresh host bound to the selected session.
        let shutdown = host.shutdown().await;
        let outcome = result?;
        shutdown?;
        // The room ended because its host did, and nothing failed. On the terminal the pager has just
        // restored, this is the difference between that and a screen that simply went quiet. The
        // failing paths do not reach here: `result?` above has already carried their sentence out.
        if let Some(exit) = ended_while_running {
            eprintln!("m0irai: {exit}");
        }
        // CX2: and the case that read `__ZER0_EXIT:0` and nothing else — the operator quit, the host
        // was slow, and m0irai terminated it. `shutdown()` returns Ok because the kill and the reap
        // both worked; `pager_room` has already aborted the task that would have banner-ed it; the
        // `tracing::warn!` in the reap has no subscriber in the shipped path. So the launcher's own
        // record is the last thing that knows, and it is read HERE, after the shutdown, which is the
        // only point at which a kill on this path has happened. A quit that killed nothing leaves a
        // clean exit here and prints nothing, which is the discrimination the comment above wanted
        // and did not have.
        if let Some(exit) = host
            .client()
            .subscribe_exit()
            .borrow()
            .clone()
            .filter(|exit| !exit.ended_itself_cleanly())
        {
            // On the way out the sentence IS the failure, so it leaves as one: that is what makes the
            // process exit non-zero, and `main` prints it exactly once. A session switch keeps the
            // room alive and only needs the line.
            if matches!(outcome, xai_grok_pager::room_runtime::RoomRuntimeExit::Exit) {
                return Err(HostError::Stopped(exit.to_string()));
            }
            eprintln!("m0irai: {exit}");
        }
        match outcome {
            xai_grok_pager::room_runtime::RoomRuntimeExit::Exit => return Ok(()),
            xai_grok_pager::room_runtime::RoomRuntimeExit::LoadSession(session_id) => {
                startup = RoomStartup::Load(session_id);
            }
            xai_grok_pager::room_runtime::RoomRuntimeExit::NewSession => {
                startup = RoomStartup::New;
            }
        }
    }
}

#[cfg(not(feature = "grok-pager-room"))]
async fn run_room(_mode: CliMode) -> Result<(), HostError> {
    Err(HostError::Startup(
        "grok-pager-room feature is disabled".into(),
    ))
}

pub async fn startup_session(
    client: &HostClient,
    mode: CliMode,
    cwd: &PathBuf,
) -> Result<String, HostError> {
    let budget = StartupBudget::default();
    startup_session_for_before(
        client,
        RoomStartup::from_cli(mode),
        cwd,
        Deadlines::new(budget),
    )
    .await
}

/// The bounds a startup is held to, carried together so no stage can silently get a fresh ceiling.
///
/// `handshake` and `inactivity` are per wait; `ceiling` is absolute and armed exactly once, here, at
/// the moment the startup begins.
#[derive(Clone, Copy, Debug)]
struct Deadlines {
    handshake: Duration,
    inactivity: Duration,
    ceiling: Instant,
    /// The ceiling as a LENGTH as well as an instant. Kept because a message about the ceiling has to
    /// report the budget the operator waited out, and the remaining time at that point is zero by
    /// definition — "after 0s" is exactly the uninformative sentence this lane exists to delete.
    ceiling_budget: Duration,
}

impl Deadlines {
    fn new(budget: StartupBudget) -> Self {
        Self {
            handshake: budget.handshake,
            inactivity: budget.inactivity,
            ceiling: Instant::now() + budget.ceiling,
            ceiling_budget: budget.ceiling,
        }
    }

    /// The bound for one step that cannot report progress, whichever of the two it is.
    ///
    /// `bound` is the caller's choice because the two silent steps are not the same measurement. Spawn
    /// and the handshake pay for starting an interpreter; readiness is published by a host that is
    /// already running. Round 2 gave all three `inactivity`, and with a small test budget that made
    /// `initialize` time out before any test reached its subject.
    fn silent_step(&self, stage: &'static str, bound: Duration) -> Result<Duration, HostError> {
        let left = self
            .ceiling
            .checked_duration_since(Instant::now())
            .ok_or_else(|| {
                HostError::StartupStalled(stall_message(
                    stage,
                    StallKind::Ceiling,
                    self.ceiling_budget,
                    self.ceiling_budget,
                ))
            })?;
        Ok(bound.min(left))
    }

    /// Turns a bare transport timeout from a step that owns its own waiting into the same operator
    /// sentence every other step produces.
    ///
    /// `wait_until_live` is the one startup step whose timeout is constructed inside the transport,
    /// where the stage is not known — round 1 left it printing `host request timed out: room initial
    /// resync`, the exact shape this lane exists to delete, and with it went the advice line, which is
    /// gated on the stall variant. Translated here rather than inside the transport because the
    /// transport reports what happened and this file owns what the operator is told.
    fn stalled_step(&self, stage: &'static str, waited: Duration, error: HostError) -> HostError {
        match error {
            HostError::RequestTimedOut(_) => {
                HostError::StartupStalled(stall_message(stage, StallKind::Silent, waited, waited))
            }
            other => other,
        }
    }

    /// The bound for a step that DOES report progress.
    fn progress_step(&self) -> ProgressWait {
        ProgressWait {
            inactivity: self.inactivity,
            ceiling: self
                .ceiling
                .checked_duration_since(Instant::now())
                .unwrap_or(Duration::ZERO),
        }
    }
}

/// Spawn and initialize one room within a single end-to-end startup budget.
/// This is public so lifecycle integration tests and non-terminal callers use
/// precisely the same protocol validation and cleanup path as the CLI.
pub async fn start_room(
    mode: CliMode,
    cwd: &PathBuf,
    options: HostProcessOptions,
) -> Result<StartedRoom, HostError> {
    start_room_for(
        RoomStartup::from_cli(mode),
        cwd,
        options,
        StartupBudget::default(),
        Narration::Silent,
    )
    .await
}

/// Start one room under a caller-chosen budget, without narration.
///
/// Exists so a test can exercise the progress-renewed wait in a second rather than in two minutes.
/// It changes only the two bounds — the same code path, the same protocol validation, the same
/// cleanup — because a wait proven under different machinery is not the wait that ships.
#[cfg(any(test, feature = "test-support"))]
pub async fn start_room_with_budget(
    mode: CliMode,
    cwd: &PathBuf,
    options: HostProcessOptions,
    budget: StartupBudget,
) -> Result<StartedRoom, HostError> {
    start_room_for(
        RoomStartup::from_cli(mode),
        cwd,
        options,
        budget,
        Narration::Silent,
    )
    .await
}

/// Whether a slow startup says out loud what it is waiting for.
///
/// Only the CLI narrates. Every library caller — the lifecycle tests, the digest proofs — stays
/// silent, so a test suite is never judged on stderr it did not ask for.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Narration {
    Silent,
    Stderr,
}

async fn start_room_for(
    startup: RoomStartup,
    cwd: &PathBuf,
    options: HostProcessOptions,
    budget: StartupBudget,
    narration: Narration,
) -> Result<StartedRoom, HostError> {
    let deadlines = Deadlines::new(budget);
    let spawn_wait = deadlines.silent_step(SPAWN_STAGE, deadlines.handshake)?;
    let host = tokio::time::timeout(spawn_wait, HostProcess::spawn(options))
        .await
        .map_err(|_| {
            HostError::StartupStalled(stall_message(
                SPAWN_STAGE,
                StallKind::Silent,
                spawn_wait,
                spawn_wait,
            ))
        })??;
    let client = host.client();
    let narrator = spawn_narrator(&client, narration);
    let startup = async {
        let session_id = startup_session_for_before(&client, startup, cwd, deadlines).await?;
        // Readiness normally follows the response the host has just sent, which is why this step
        // reports no stage of its own. It still gets the full stall sentence: "normally immediate" is
        // the assumption a deadline exists to survive, and a boot that dies here with a bare request
        // id is the defect this lane was opened for, one step further along.
        let readiness_wait = deadlines.silent_step(READINESS_STAGE, deadlines.inactivity)?;
        client
            .wait_until_live(readiness_wait)
            .await
            .map_err(|error| deadlines.stalled_step(READINESS_STAGE, readiness_wait, error))?;
        Ok(session_id)
    }
    .await;
    if let Some(narrator) = narrator {
        narrator.abort();
    }
    match startup {
        Ok(session_id) => Ok(StartedRoom { host, session_id }),
        Err(error) => {
            let stderr_tail = matches!(error, HostError::StartupStalled(_))
                .then(|| host.stderr_tail())
                .map(std::future::IntoFuture::into_future);
            let advice = match stderr_tail {
                Some(tail) => Some(stall_advice(tail.await.as_str())),
                None => None,
            };
            let _ = host.shutdown().await;
            Err(match (error, advice) {
                (HostError::StartupStalled(message), Some(advice)) => {
                    HostError::StartupStalled(format!("{message}.\n{advice}"))
                }
                (error, _) => error,
            })
        }
    }
}

/// Narrates a startup that has gone on long enough to look broken.
///
/// QUIET FIRST: nothing is printed for [`BOOT_NARRATION_DELAY`], which covers every ordinary boot on
/// every machine this was measured on. After that the current stage is named, and each new stage is
/// named as it arrives — one line each, no meter, no progress bar, nothing that redraws. This is
/// cooked-mode stderr before the pager owns the terminal; the pager's alternate screen covers it the
/// moment the room opens.
fn spawn_narrator(
    client: &HostClient,
    narration: Narration,
) -> Option<tokio::task::JoinHandle<()>> {
    if narration == Narration::Silent {
        return None;
    }
    let mut progress = client.subscribe_boot_progress();
    Some(tokio::spawn(async move {
        tokio::time::sleep(BOOT_NARRATION_DELAY).await;
        let mut said: Option<String> = None;
        loop {
            let line = progress
                .borrow_and_update()
                .as_ref()
                .map(|stage| stage.describe());
            if let Some(line) = line
                && said.as_deref() != Some(line.as_str())
            {
                eprintln!("m0irai: {line}...");
                said = Some(line);
            }
            if progress.changed().await.is_err() {
                return;
            }
        }
    }))
}

/// What the operator should do about a stalled startup, and the only place the host's own last words
/// are shown.
///
/// The host's stderr is deliberately withheld from every OTHER failure path (see `run_from_env`), and
/// this is the one case that earns it: at a stall there is no room, no journal and no session folder,
/// so the tail is the only diagnosis that exists. Bounded to the last few lines because the operator
/// is reading a terminal, not a log viewer.
fn stall_advice(stderr_tail: &str) -> String {
    let mut advice = String::from(
        "  What to do: relaunch m0irai. The first start of a project pays for its evidence\n  migration and later ones skip it, so a repeat is a real fault rather than a slow disk.",
    );
    let tail: Vec<&str> = stderr_tail
        .lines()
        .filter(|line| !line.trim().is_empty())
        .rev()
        .take(5)
        .collect();
    if tail.is_empty() {
        advice.push_str("\n  The host wrote nothing before it stopped.");
        return advice;
    }
    advice.push_str("\n  The host's last words:");
    for line in tail.into_iter().rev() {
        advice.push_str("\n    ");
        advice.push_str(line.trim_end());
    }
    advice
}

async fn startup_session_for_before(
    client: &HostClient,
    startup: RoomStartup,
    cwd: &PathBuf,
    deadlines: Deadlines,
) -> Result<String, HostError> {
    // `clientInfo.name` deliberately keeps the pre-rename spelling: it is a wire
    // field, not an operator-visible string, and renaming persisted/wire
    // identifiers is an M2 decision — the same reservation that holds the
    // `zer0.room` protocol id and the `.zer0/` journal directory.
    let initialized = client
        .request(
            "initialize",
            json!({"protocolVersion":1,"clientInfo":{"name":"zer0-v2","version":env!("CARGO_PKG_VERSION")},"clientCapabilities":{}}),
            deadlines.silent_step(HANDSHAKE_STAGE, deadlines.handshake)?,
        )
        .await
        .map_err(|error| handshake_stall(error, deadlines))?;
    validate_initialize_result(&initialized)?;
    // Everything below opens or migrates something on disk and reports stages while it does. These are
    // the waits that are renewed by progress; the handshake above is not, because a host that cannot
    // answer it from memory is not slow, it is broken.
    match startup {
        RoomStartup::New => {
            let result = client
                .request_awaiting_progress(
                    "session/new",
                    json!({"cwd":cwd,"mcpServers":[]}),
                    deadlines.progress_step(),
                    "opening a new room",
                )
                .await?;
            session_id_from_result(&result)
        }
        RoomStartup::Continue => {
            let sessions = client
                .request_awaiting_progress(
                    "session/list",
                    json!({}),
                    deadlines.progress_step(),
                    "listing this project's rooms",
                )
                .await?;
            let session_id = newest_v2_session(&sessions).ok_or_else(|| {
                HostError::Startup("no V2 session is available to continue".into())
            })?;
            load_session(client, &session_id, cwd, deadlines).await?;
            Ok(session_id)
        }
        RoomStartup::Load(session_id) => {
            if !valid_session_id(&session_id) {
                return Err(HostError::InvalidArgument(
                    "selected session id is invalid".into(),
                ));
            }
            load_session(client, &session_id, cwd, deadlines).await?;
            Ok(session_id)
        }
    }
}

async fn load_session(
    client: &HostClient,
    session_id: &str,
    cwd: &PathBuf,
    deadlines: Deadlines,
) -> Result<(), HostError> {
    let loaded = client
        .request_awaiting_progress(
            "session/load",
            json!({"sessionId":session_id,"cwd":cwd,"mcpServers":[]}),
            deadlines.progress_step(),
            "reopening the room",
        )
        .await?;
    validate_load_result(&loaded)
}

/// A handshake that times out is a stall like any other, and has to say so in the same words. The
/// underlying client reports a request id, which is precisely the message the operator was given the
/// day this lane was written and could do nothing with.
fn handshake_stall(error: HostError, deadlines: Deadlines) -> HostError {
    deadlines.stalled_step(HANDSHAKE_STAGE, deadlines.handshake, error)
}

fn valid_session_id(id: &str) -> bool {
    id.starts_with("chat-")
        && id.len() > "chat-".len()
        && id.len() <= 160
        && !id.chars().any(char::is_control)
}

fn session_id_from_result(result: &Value) -> Result<String, HostError> {
    result
        .as_object()
        .filter(|object| object.len() == 1)
        .and_then(|object| object.get("sessionId"))
        .and_then(Value::as_str)
        .filter(|id| valid_session_id(id))
        .map(str::to_owned)
        .ok_or_else(|| {
            HostError::Frame("session/new result must be exactly {sessionId:<chat-id>}".into())
        })
}

fn validate_initialize_result(result: &Value) -> Result<(), HostError> {
    let valid = result.as_object().is_some_and(|object| {
        object.get("protocolVersion") == Some(&json!(1))
            && object
                .get("_meta")
                .and_then(Value::as_object)
                .and_then(|meta| meta.get("zer0.room"))
                .and_then(Value::as_object)
                .and_then(|room| room.get("version"))
                == Some(&json!(1))
    });
    valid.then_some(()).ok_or_else(|| {
        HostError::Frame("initialize result does not identify zer0.room protocol v1".into())
    })
}

fn validate_load_result(result: &Value) -> Result<(), HostError> {
    (result == &json!({}))
        .then_some(())
        .ok_or_else(|| HostError::Frame("session/load result must be exactly {}".into()))
}

pub fn newest_v2_session(result: &Value) -> Option<String> {
    let sessions = result
        .as_object()
        .filter(|result| result.len() == 1)
        .and_then(|result| result.get("sessions"))
        .and_then(Value::as_array)?;
    sessions
        .first()?
        .as_object()
        .filter(|session| {
            session.len() == 4
                && ["sessionId", "cwd", "title", "updatedAt"]
                    .iter()
                    .all(|field| {
                        session
                            .get(*field)
                            .and_then(Value::as_str)
                            .is_some_and(|value| !value.is_empty())
                    })
        })
        .and_then(|session| session.get("sessionId"))
        .and_then(Value::as_str)
        .filter(|id| valid_session_id(id))
        .map(str::to_owned)
}

fn exit_code(error: &HostError) -> i32 {
    match error {
        HostError::Frame(_) | HostError::Remote(_) => 3,
        _ => 4,
    }
}

#[cfg(test)]
async fn cleanup_after_terminal<F, R>(
    result: Result<(), HostError>,
    shutdown: F,
    restore: R,
) -> Result<(), HostError>
where
    F: Future<Output = Result<(), HostError>>,
    R: FnOnce() -> Result<(), HostError>,
{
    let shutdown = shutdown.await;
    let restored = restore();
    result.and(shutdown).and(restored)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn cli_is_small_and_continue_selects_the_newest_v2_session() {
        assert_eq!(parse_args(["m0irai".into()]).unwrap(), CliMode::New);
        assert_eq!(
            parse_args(["m0irai".into(), "--continue".into()]).unwrap(),
            CliMode::Continue
        );
        assert!(parse_args(["m0irai".into(), "--bad".into()]).is_err());
        assert_eq!(
            newest_v2_session(
                &json!({"sessions":[{"sessionId":"chat-new","cwd":"C:/work","title":"Room","updatedAt":"2026-08-01T00:00:00Z"},{"sessionId":"chat-older","cwd":"C:/old","title":"Old","updatedAt":"2026-07-01T00:00:00Z"}]})
            ),
            Some("chat-new".into())
        );
        assert!(newest_v2_session(&json!({"sessions":[{"sessionId":"bad"}]})).is_none());
        assert_eq!(exit_code(&HostError::Frame("schema".into())), 3);
        assert_eq!(exit_code(&HostError::Remote("protocol".into())), 3);
    }

    // Phase 6: the shipped command is `m0irai`, so every string the operator can
    // read from it says m0irai. The manifest assertion is the load-bearing half —
    // the help/version copy is only honest while the binary Cargo emits actually
    // carries that name.
    #[test]
    fn the_cli_introduces_itself_by_the_name_it_ships_under() {
        assert!(
            version_text().starts_with("m0irai "),
            "--version must name the shipped command: {}",
            version_text()
        );
        assert!(
            help_text().starts_with("Usage: m0irai"),
            "--help must name the shipped command: {}",
            help_text()
        );
        let manifest = include_str!("../Cargo.toml");
        assert!(
            manifest.contains("[[bin]]\nname = \"m0irai\""),
            "the bin target must emit m0irai; manifest says:\n{manifest}"
        );
        // The package name is internal and deliberately unchanged: `-p
        // zer0-v2-bin` still selects this crate.
        assert!(manifest.contains("name = \"zer0-v2-bin\""));
    }

    #[cfg(not(feature = "room-visual-fixture"))]
    #[test]
    fn default_cli_rejects_the_test_only_visual_fixture_flag() {
        assert!(parse_args(["m0irai".into(), "--visual-fixture".into()]).is_err());
        assert!(!help_text().contains("visual-fixture"));
        let manifest = include_str!("../Cargo.toml");
        assert!(manifest.contains("default = [\"grok-pager-room\"]"));
        assert!(manifest.contains(
            "room-visual-fixture = [\"grok-pager-room\", \"xai-grok-pager/room-test-support\"]"
        ));
        assert!(
            !manifest
                .lines()
                .find(|line| line.starts_with("default ="))
                .expect("default feature closure is declared")
                .contains("room-visual-fixture"),
            "normal CLI closure must exclude the fixture-only abort trigger"
        );
    }

    #[cfg(feature = "room-visual-fixture")]
    #[test]
    fn fixture_flag_is_explicit_when_the_test_only_feature_is_enabled() {
        assert_eq!(
            parse_args(["m0irai".into(), "--visual-fixture".into()]).unwrap(),
            CliMode::VisualFixture
        );
        assert!(help_text().contains("test-only"));
        assert_eq!(
            visual_fixture_post_restore_hold(Some(std::ffi::OsStr::new("2500"))),
            Some(Duration::from_millis(2500))
        );
        assert_eq!(
            visual_fixture_post_restore_hold(Some(std::ffi::OsStr::new("999999"))),
            Some(Duration::from_secs(10))
        );
        assert_eq!(
            visual_fixture_post_restore_hold(Some(std::ffi::OsStr::new("invalid"))),
            None
        );
    }

    #[tokio::test]
    async fn host_cleanup_precedes_terminal_restoration_on_runtime_failure() {
        let order = Arc::new(Mutex::new(Vec::new()));
        let shutdown_order = Arc::clone(&order);
        let restore_order = Arc::clone(&order);
        let result = cleanup_after_terminal(
            Err(HostError::Stopped("runtime failed".into())),
            async move {
                shutdown_order.lock().unwrap().push("host");
                Ok(())
            },
            move || {
                assert_eq!(&*restore_order.lock().unwrap(), &["host"]);
                restore_order.lock().unwrap().push("terminal");
                Ok(())
            },
        )
        .await;
        assert!(matches!(result, Err(HostError::Stopped(_))));
        assert_eq!(&*order.lock().unwrap(), &["host", "terminal"]);
    }
}
