//! Direct, shell-free lifecycle management for the Zer0 V2 NDJSON host.
//!
//! `HostProcess` is the sole lifecycle owner. `HostClient` is deliberately
//! cloneable: it can issue requests and observe state, but it cannot keep a
//! child alive once its owner has shut down or been dropped.

use std::collections::HashMap;
use std::ffi::OsString;
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, RwLock};
use std::time::Duration;

use futures_util::StreamExt;
use semver::{Version, VersionReq};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{Mutex, broadcast, mpsc, oneshot, watch};
use tokio::time::{Instant, timeout};
use tokio_util::sync::CancellationToken;
use tokio_util::{
    bytes::BytesMut,
    codec::{Decoder, FramedRead},
};
use xai_tty_utils::{ProcessGroup, ProcessScope};
use zer0_room_protocol::{
    JsonRpcId, JsonRpcRequest, JsonRpcResponse, JsonRpcResponseId, JsonRpcVersion, RoomEvent,
    RoomReducer, ServerFrame, decimal_cmp, validate_decimal,
};

use crate::boot_progress::{
    BootFrame, BootProgress, ProgressWait, StallKind, classify_boot_frame, stall_message,
};
use crate::host_shutdown::{
    FAILURE_REAP_GRACE, HostExit, HostExitCause, LauncherTermination, SHUTDOWN_RESPONSE_BOUND,
    SHUTDOWN_TOTAL_BOUND, TerminationBranch, graceful_reap_for, quit_outcome,
};
use crate::transport::{RoomTransport, SyncPhase, TransportAction, classify_frame};

pub const MAX_STDERR_TAIL_BYTES: usize = 64 * 1024;
const EVENT_BROADCAST_CAPACITY: usize = 32;
const WRITER_QUEUE_CAPACITY: usize = 32;
const WRITER_SEND_BOUND: Duration = Duration::from_secs(1);
/// The interpreter's file name: what the packaged sibling is called, and the PATH name used when no
/// sibling was shipped.
const NODE_PROGRAM_NAME: &str = if cfg!(windows) { "node.exe" } else { "node" };
/// What to search PATH for. The STEM, not the file name: on Windows the resolver applies PATHEXT to
/// it, which is how a shell finds `node.exe`, and hard-coding the extension here would skip that.
const NODE_SEARCH_STEM: &str = "node";
/// How many PATH candidates are probed before giving up.
///
/// A bound, because each candidate costs a process spawn: a pathological PATH with fifty `node`
/// entries must not turn a boot into a minute of probing. Five is far past any real machine — a
/// version manager contributes one shim plus at most a couple of shadowed installs.
const MAX_PATH_CANDIDATES: usize = 5;
/// The Node versions this host runs on, in npm range syntax.
///
/// A SECOND COPY of `package.json`'s `engines.node`, and deliberately so: the terminal has to answer
/// "is this interpreter usable" before any Node has run, so it cannot ask the package manager. The
/// copy is held in step by `the_engines_range_matches_package_json`, which parses the real file — if
/// anyone widens the range for the Node half, that test fails until this line follows.
const NODE_ENGINES_RANGE: &str = ">=22.17.0 <23 || >=24.2.0";
/// How long a candidate interpreter gets to answer `--version`.
///
/// Small on purpose. This runs before the startup budget has begun, so it is the one wait in the whole
/// boot that nothing else bounds; a file merely NAMED `node.exe` must not be able to hold the room shut.
const NODE_VERSION_PROBE_BOUND: Duration = Duration::from_secs(5);

/// NDJSON decoder that never accepts an unterminated final frame at EOF.
struct StrictLinesCodec {
    max_length: usize,
}

impl StrictLinesCodec {
    fn new(max_length: usize) -> Self {
        Self { max_length }
    }
}

impl Decoder for StrictLinesCodec {
    type Item = Vec<u8>;
    type Error = io::Error;

    fn decode(&mut self, source: &mut BytesMut) -> Result<Option<Self::Item>, Self::Error> {
        let Some(newline) = source.iter().position(|byte| *byte == b'\n') else {
            if source.len() > self.max_length {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "room host stdout frame exceeds 1 MiB including LF",
                ));
            }
            return Ok(None);
        };
        if newline > self.max_length {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "room host stdout frame exceeds 1 MiB including LF",
            ));
        }
        let mut frame = source.split_to(newline + 1);
        frame.truncate(newline);
        Ok(Some(frame.to_vec()))
    }

    fn decode_eof(&mut self, source: &mut BytesMut) -> Result<Option<Self::Item>, Self::Error> {
        if source.is_empty() {
            return Ok(None);
        }
        if let Some(frame) = self.decode(source)? {
            return Ok(Some(frame));
        }
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "room host stdout closed with an unterminated frame",
        ))
    }
}

#[derive(Clone, Debug)]
pub struct HostProcessOptions {
    /// The operator project, used as the child working directory.
    pub operator_root: PathBuf,
    #[cfg(any(test, feature = "test-support"))]
    test_launcher: Option<TestHostLauncher>,
    /// Test-only opt-out from the close-digest handoff (F10). Production cannot
    /// reach it: outside `test-support` the field does not exist and
    /// `digest_handoff()` is the constant `true`.
    #[cfg(any(test, feature = "test-support"))]
    digest_handoff: bool,
    /// Test-only COMPLETE replacement of the host's environment, so a test can
    /// redirect HOME/APPDATA/LOCALAPPDATA/TEMP/CODEX_HOME and prove the run
    /// touched nothing of the operator's.
    #[cfg(any(test, feature = "test-support"))]
    test_env: Option<Vec<(OsString, OsString)>>,
}

impl HostProcessOptions {
    pub fn new(operator_root: impl Into<PathBuf>) -> Self {
        Self {
            operator_root: operator_root.into(),
            #[cfg(any(test, feature = "test-support"))]
            test_launcher: None,
            #[cfg(any(test, feature = "test-support"))]
            digest_handoff: true,
            #[cfg(any(test, feature = "test-support"))]
            test_env: None,
        }
    }

    /// Explicit test-only launcher injection. Release builds always resolve the
    /// sibling launcher beside the executable and never honor environment or
    /// source-root overrides.
    #[cfg(any(test, feature = "test-support"))]
    pub fn with_test_launcher(
        mut self,
        node: impl Into<OsString>,
        script: impl Into<PathBuf>,
    ) -> Self {
        self.test_launcher = Some(TestHostLauncher {
            node: node.into(),
            script: script.into(),
        });
        self
    }

    /// Launch the host WITHOUT `ZER0_DIGEST_HANDOFF`, so it forks its close
    /// digest in-process and inside the job. Exactly one caller: the F10
    /// falsifier, which has to reproduce the loss for the survival test to be a
    /// proof rather than a tautology.
    #[cfg(any(test, feature = "test-support"))]
    pub fn without_digest_handoff(mut self) -> Self {
        self.digest_handoff = false;
        self
    }

    /// Replace the host's environment entirely with `entries` (test-only). The
    /// handoff flag is applied on top: it states what the launcher is, not what
    /// the caller asked for.
    #[cfg(any(test, feature = "test-support"))]
    pub fn with_test_env(mut self, entries: Vec<(OsString, OsString)>) -> Self {
        self.test_env = Some(entries);
        self
    }

    fn digest_handoff(&self) -> bool {
        #[cfg(any(test, feature = "test-support"))]
        {
            self.digest_handoff
        }
        #[cfg(not(any(test, feature = "test-support")))]
        {
            true
        }
    }
}

/// Test-only process injection used by deterministic lifecycle tests.
#[cfg(any(test, feature = "test-support"))]
#[derive(Clone, Debug)]
pub struct TestHostLauncher {
    pub node: OsString,
    pub script: PathBuf,
}

#[derive(Clone, Debug, PartialEq)]
pub enum HostEvent {
    Readiness(RoomEvent),
    Room(RoomEvent),
    Exited(HostExit),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostError {
    AdmissionClosed,
    Frame(String),
    InvalidArgument(String),
    Io(String),
    Remote(String),
    RequestTimedOut(String),
    Startup(String),
    /// A startup stage stopped making progress. Carries the WHOLE operator sentence rather than an id,
    /// because "zer0-request-2" is what the operator was given last time and it told them nothing.
    StartupStalled(String),
    Stopped(String),
}

impl fmt::Display for HostError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AdmissionClosed => formatter.write_str("host is not accepting requests"),
            Self::Frame(message) => write!(formatter, "fatal host stdout frame: {message}"),
            Self::InvalidArgument(message) => write!(formatter, "invalid host argument: {message}"),
            Self::Io(message) => write!(formatter, "host I/O failure: {message}"),
            Self::Remote(message) => write!(formatter, "host response error: {message}"),
            Self::RequestTimedOut(id) => write!(formatter, "host request timed out: {id}"),
            Self::Startup(message) => write!(formatter, "host startup failed: {message}"),
            // Printed verbatim: the message is already a whole sentence written for the operator, and a
            // prefix in front of it would be the third clause of an apology.
            Self::StartupStalled(message) => formatter.write_str(message),
            Self::Stopped(message) => write!(formatter, "host stopped: {message}"),
        }
    }
}

impl std::error::Error for HostError {}

/// A receiver over the bounded room-event broadcast. A lagging consumer is
/// told exactly what it last observed and can call [`HostClient::resync`] to
/// recover its presentation state.
pub struct HostEventReceiver {
    receiver: broadcast::Receiver<HostEvent>,
    last_delivered_event_seq: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostEventReceiveError {
    Closed,
    Lagged {
        last_delivered_event_seq: Option<String>,
    },
}

impl HostEventReceiver {
    pub async fn recv(&mut self) -> Result<HostEvent, HostEventReceiveError> {
        match self.receiver.recv().await {
            Ok(event) => {
                match &event {
                    HostEvent::Readiness(readiness) | HostEvent::Room(readiness) => {
                        self.last_delivered_event_seq = Some(readiness.event_seq.clone());
                    }
                    HostEvent::Exited(_) => {}
                }
                Ok(event)
            }
            Err(broadcast::error::RecvError::Closed) => Err(HostEventReceiveError::Closed),
            Err(broadcast::error::RecvError::Lagged(_)) => Err(HostEventReceiveError::Lagged {
                last_delivered_event_seq: self.last_delivered_event_seq.clone(),
            }),
        }
    }

    pub fn last_delivered_event_seq(&self) -> Option<&str> {
        self.last_delivered_event_seq.as_deref()
    }
}

/// The unique lifecycle owner for one child process tree.
pub struct HostProcess {
    inner: Arc<HostInner>,
}

/// Cloneable request/subscription handle. Dropping it has no lifecycle effect.
#[derive(Clone)]
pub struct HostClient {
    inner: Arc<HostInner>,
}

struct HostInner {
    accepting: AtomicBool,
    shutdown_started: AtomicBool,
    failure_recorded: AtomicBool,
    next_request: AtomicU64,
    writer: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
    pending: Arc<PendingRequests>,
    events: broadcast::Sender<HostEvent>,
    readiness: watch::Sender<Option<RoomEvent>>,
    room_view_revision: watch::Sender<u64>,
    live: watch::Sender<bool>,
    exit: watch::Sender<Option<HostExit>>,
    transport_failure: watch::Sender<Option<HostError>>,
    /// The last startup stage the host reported. A watch rather than a broadcast on purpose: a waiter
    /// needs to know that progress HAPPENED and what the current stage is, never the history — and a
    /// watch cannot lag, which a bounded broadcast can exactly when the host is at its busiest.
    boot_progress: watch::Sender<Option<BootProgress>>,
    transport: RwLock<RoomTransport>,
    /// The launcher's own terminate decision, stamped by whichever path is about to call
    /// `kill_all()` and read once by `record_exit`. A plain mutex rather than a watch channel
    /// because `HostProcess::drop` is synchronous and cannot await.
    termination: StdMutex<Option<LauncherTermination>>,
    scope: ProcessScope,
    cancellation: CancellationToken,
    stderr_tail: Mutex<Vec<u8>>,
    /// The host's project root, retained solely to find the close-digest
    /// handoff requests after the host is gone (`digest_handoff`).
    operator_root: PathBuf,
}

#[derive(Default)]
struct PendingRequests {
    values: StdMutex<HashMap<String, oneshot::Sender<Result<Value, HostError>>>>,
}

impl PendingRequests {
    fn insert(&self, id: String, sender: oneshot::Sender<Result<Value, HostError>>) {
        self.values
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(id, sender);
    }

    fn remove(&self, id: &str) -> Option<oneshot::Sender<Result<Value, HostError>>> {
        self.values
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(id)
    }

    fn drain(&self) -> Vec<oneshot::Sender<Result<Value, HostError>>> {
        self.values
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .drain()
            .map(|(_, sender)| sender)
            .collect()
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.values
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .len()
    }
}

struct PendingRequestGuard {
    pending: Arc<PendingRequests>,
    id: String,
}

impl PendingRequestGuard {
    fn new(pending: Arc<PendingRequests>, id: String) -> Self {
        Self { pending, id }
    }
}

impl Drop for PendingRequestGuard {
    fn drop(&mut self) {
        self.pending.remove(&self.id);
    }
}

impl HostProcess {
    pub async fn spawn(options: HostProcessOptions) -> Result<Self, HostError> {
        if !options.operator_root.is_dir() {
            return Err(HostError::Startup(format!(
                "operator project does not exist: {}",
                options.operator_root.display()
            )));
        }
        let launcher = resolve_launcher(&options).await?;
        let scope = ProcessScope::new();
        let (mut child, group) =
            spawn_enrolled(&scope, &launcher.node, &launcher.script, &options).await?;
        let stdin = match child.stdin.take() {
            Some(pipe) => pipe,
            None => return Err(startup_pipe_failure("stdin", &scope, &mut child).await),
        };
        let stdout = match child.stdout.take() {
            Some(pipe) => pipe,
            None => return Err(startup_pipe_failure("stdout", &scope, &mut child).await),
        };
        let stderr = match child.stderr.take() {
            Some(pipe) => pipe,
            None => return Err(startup_pipe_failure("stderr", &scope, &mut child).await),
        };

        let (writer, writer_rx) = mpsc::channel(WRITER_QUEUE_CAPACITY);
        let (events, _) = broadcast::channel(EVENT_BROADCAST_CAPACITY);
        let (readiness, _) = watch::channel(None);
        let (room_view_revision, _) = watch::channel(0_u64);
        let (live, _) = watch::channel(false);
        let (exit, _) = watch::channel(None);
        let (transport_failure, _) = watch::channel(None);
        let (boot_progress, _) = watch::channel(None);
        let inner = Arc::new(HostInner {
            accepting: AtomicBool::new(true),
            shutdown_started: AtomicBool::new(false),
            failure_recorded: AtomicBool::new(false),
            next_request: AtomicU64::new(1),
            writer: Mutex::new(Some(writer)),
            pending: Arc::new(PendingRequests::default()),
            events,
            readiness,
            room_view_revision,
            live,
            exit,
            transport_failure,
            boot_progress,
            transport: RwLock::new(RoomTransport::new()),
            termination: StdMutex::new(None),
            scope,
            cancellation: CancellationToken::new(),
            stderr_tail: Mutex::new(Vec::new()),
            operator_root: options.operator_root.clone(),
        });
        spawn_writer(Arc::clone(&inner), stdin, writer_rx);
        spawn_stdout_reader(Arc::clone(&inner), stdout);
        spawn_stderr_reader(Arc::clone(&inner), stderr);
        spawn_monitor(Arc::clone(&inner), child, group);
        Ok(Self { inner })
    }

    pub fn client(&self) -> HostClient {
        HostClient {
            inner: Arc::clone(&self.inner),
        }
    }

    pub async fn shutdown(&self) -> Result<(), HostError> {
        self.inner.shutdown().await
    }

    pub async fn wait_for_exit(&self, wait: Duration) -> Result<HostExit, HostError> {
        self.inner.wait_for_exit(wait).await
    }

    pub async fn stderr_tail(&self) -> String {
        self.client().stderr_tail().await
    }
}

impl Drop for HostProcess {
    fn drop(&mut self) {
        self.inner.accepting.store(false, Ordering::Release);
        self.inner.cancellation.cancel();
        self.inner.note_launcher_termination(LauncherTermination {
            branch: TerminationBranch::OwnerDropped,
            waited: Duration::ZERO,
        });
        self.inner.scope.kill_all();
        // Last moment this process can start a handed-off digest: after this
        // returns the job handle closes and anything still inside it dies. Covers
        // the drop-without-shutdown paths (a transport failure, a panic unwind,
        // a caller that never called `shutdown`). Idempotent after `shutdown`.
        self.inner.consume_digest_handoff();
    }
}

impl HostClient {
    pub async fn request(
        &self,
        method: impl Into<String>,
        params: Value,
        wait: Duration,
    ) -> Result<Value, HostError> {
        if !self.inner.accepting.load(Ordering::Acquire) {
            return Err(HostError::AdmissionClosed);
        }
        let id = self.inner.next_id("zer0-request");
        let _pending_guard = PendingRequestGuard::new(Arc::clone(&self.inner.pending), id.clone());
        let receiver = self
            .inner
            .send_request(id.clone(), method.into(), params)
            .await?;
        self.inner.await_response(id, receiver, wait).await
    }

    /// Issues one request whose deadline is renewed by boot progress rather than by the clock.
    ///
    /// Used for exactly the startup requests that can legitimately take a long time on a first boot.
    /// The DEADLINE REMAINS A DEADLINE: silence for the whole inactivity budget fails, and the
    /// absolute `ceiling` bounds the whole wait however much progress arrives. `fallback_stage` is
    /// what the failure names before the host has reported anything at all.
    pub async fn request_awaiting_progress(
        &self,
        method: impl Into<String>,
        params: Value,
        wait: ProgressWait,
        fallback_stage: &str,
    ) -> Result<Value, HostError> {
        if !self.inner.accepting.load(Ordering::Acquire) {
            return Err(HostError::AdmissionClosed);
        }
        let id = self.inner.next_id("zer0-request");
        let _pending_guard = PendingRequestGuard::new(Arc::clone(&self.inner.pending), id.clone());
        let receiver = self
            .inner
            .send_request(id.clone(), method.into(), params)
            .await?;
        self.inner
            .await_response_awaiting_progress(id, receiver, wait, fallback_stage)
            .await
    }

    /// The last startup stage the host reported, or none when it has reported nothing.
    pub fn boot_progress(&self) -> Option<BootProgress> {
        self.inner.boot_progress.borrow().clone()
    }

    /// Subscribes to startup stage changes, for a caller that narrates a slow boot.
    pub fn subscribe_boot_progress(&self) -> watch::Receiver<Option<BootProgress>> {
        self.inner.boot_progress.subscribe()
    }

    /// Fetches a complete, ordered replay strictly after the caller's own
    /// delivery frontier. Pass the `last_delivered_event_seq` reported by
    /// [`HostEventReceiveError::Lagged`], rather than the transport reducer's
    /// potentially newer frontier. This deliberately does not mutate the live
    /// reducer; presentation owns applying the recovery snapshot.
    pub async fn resync(
        &self,
        after_event_seq: &str,
        wait: Duration,
    ) -> Result<Vec<RoomEvent>, HostError> {
        validate_decimal(after_event_seq)
            .map_err(|error| HostError::InvalidArgument(format!("after_event_seq: {error}")))?;
        let session_id = {
            let transport = self
                .inner
                .transport
                .read()
                .expect("room transport lock poisoned");
            transport
                .reducer()
                .session_id()
                .ok_or_else(|| HostError::Stopped("room readiness has not bound a session".into()))?
                .to_owned()
        };
        let mut frontier = after_event_seq.to_owned();
        let mut replay = Vec::new();
        let deadline = Instant::now() + wait;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(HostError::RequestTimedOut("room-resync-pagination".into()));
            }
            let result = self
                .request(
                    "zer0/room/resync",
                    json!({"sessionId": session_id, "afterEventSeq": frontier}),
                    remaining,
                )
                .await?;
            let page = parse_resync_page(&result)?;
            if page.has_more && page.events.is_empty() {
                return Err(HostError::Frame(
                    "resync returned an empty non-final page".into(),
                ));
            }
            if let Some(last) = page.events.last() {
                if decimal_cmp(&last.event_seq, &frontier)
                    .map_err(|error| HostError::Frame(error.to_string()))?
                    .is_le()
                {
                    return Err(HostError::Frame(
                        "resync page did not advance the event frontier".into(),
                    ));
                }
                frontier.clone_from(&last.event_seq);
            }
            replay.extend(page.events);
            if !page.has_more {
                return Ok(replay);
            }
        }
    }

    pub fn subscribe_events(&self) -> HostEventReceiver {
        HostEventReceiver {
            receiver: self.inner.events.subscribe(),
            last_delivered_event_seq: None,
        }
    }

    pub fn subscribe_readiness(&self) -> watch::Receiver<Option<RoomEvent>> {
        self.inner.readiness.subscribe()
    }

    /// Returns an immutable reducer snapshot on demand. The host remains the
    /// sole mutable reducer owner; snapshots are copied only for startup or
    /// lag recovery, never for every ordinary live event.
    pub fn room_view(&self) -> Arc<RoomReducer> {
        Arc::new(self.room_snapshot())
    }

    /// Returns one owned reducer snapshot without first wrapping and then
    /// cloning an intermediate `Arc`. The production pager uses this at
    /// startup; ordinary live updates remain event-driven.
    pub fn room_snapshot(&self) -> RoomReducer {
        self.inner
            .transport
            .read()
            .expect("room transport lock poisoned")
            .reducer()
            .clone()
    }

    /// Subscribes to reducer revision changes. Consumers obtain the new
    /// immutable value with [`Self::room_view`] after a revision advances.
    pub fn subscribe_room_view(&self) -> watch::Receiver<u64> {
        self.inner.room_view_revision.subscribe()
    }

    pub async fn wait_until_live(&self, wait: Duration) -> Result<Arc<RoomReducer>, HostError> {
        let mut live = self.inner.live.subscribe();
        let mut failure = self.inner.transport_failure.subscribe();
        let mut exit = self.inner.exit.subscribe();
        timeout(wait, async {
            loop {
                if *live.borrow() {
                    return Ok(self.room_view());
                }
                if let Some(error) = failure.borrow().clone() {
                    return Err(error);
                }
                if let Some(exit) = exit.borrow().clone() {
                    return Err(HostError::Stopped(format!(
                        "host exited before room became live: {:?}",
                        exit.code
                    )));
                }
                tokio::select! {
                    changed = live.changed() => changed.map_err(|_| HostError::Stopped("live state channel closed".into()))?,
                    changed = failure.changed() => changed.map_err(|_| HostError::Stopped("failure state channel closed".into()))?,
                    changed = exit.changed() => changed.map_err(|_| HostError::Stopped("exit state channel closed".into()))?,
                }
            }
        })
        .await
        .map_err(|_| HostError::RequestTimedOut("room initial resync".into()))?
    }

    pub fn subscribe_exit(&self) -> watch::Receiver<Option<HostExit>> {
        self.inner.exit.subscribe()
    }

    pub fn subscribe_transport_failure(&self) -> watch::Receiver<Option<HostError>> {
        self.inner.transport_failure.subscribe()
    }

    pub async fn wait_for_exit(&self, wait: Duration) -> Result<HostExit, HostError> {
        self.inner.wait_for_exit(wait).await
    }

    pub async fn stderr_tail(&self) -> String {
        String::from_utf8_lossy(&self.inner.stderr_tail.lock().await).into_owned()
    }
}

impl HostInner {
    fn next_id(&self, prefix: &str) -> String {
        format!(
            "{prefix}-{}",
            self.next_request.fetch_add(1, Ordering::Relaxed)
        )
    }

    async fn send_request(
        &self,
        id: String,
        method: impl Into<String>,
        params: Value,
    ) -> Result<oneshot::Receiver<Result<Value, HostError>>, HostError> {
        let value = serde_json::to_value(JsonRpcRequest {
            jsonrpc: JsonRpcVersion,
            id: JsonRpcId::String(id.clone()),
            method: method.into(),
            params,
        })
        .map_err(|error| {
            HostError::Io(format!("JSON-RPC request serialization failed: {error}"))
        })?;
        let (sender, receiver) = oneshot::channel();
        self.pending.insert(id.clone(), sender);
        if let Err(error) = self.send_value(value).await {
            self.pending.remove(&id);
            return Err(error);
        }
        Ok(receiver)
    }

    async fn await_response(
        &self,
        id: String,
        receiver: oneshot::Receiver<Result<Value, HostError>>,
        wait: Duration,
    ) -> Result<Value, HostError> {
        match timeout(wait, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(HostError::Stopped("response channel closed".into())),
            Err(_) => {
                self.pending.remove(&id);
                Err(HostError::RequestTimedOut(id))
            }
        }
    }

    /// The wait that progress renews.
    ///
    /// Two bounds, both enforced every time round the loop: `inactivity` is re-armed whenever the
    /// host reports a stage, and `ceiling` is not re-armed by anything. A stage change is observed
    /// through a watch channel, so a burst of stage reports collapses into one wakeup and the loop
    /// costs nothing while the host is working.
    async fn await_response_awaiting_progress(
        &self,
        id: String,
        receiver: oneshot::Receiver<Result<Value, HostError>>,
        wait: ProgressWait,
        fallback_stage: &str,
    ) -> Result<Value, HostError> {
        let mut progress = self.boot_progress.subscribe();
        // Start the inactivity clock from NOW, not from whatever stage a previous request left behind:
        // the wait is about this request making headway, not about the channel having a value.
        drop(progress.borrow_and_update());
        let mut watching = true;
        let started = Instant::now();
        tokio::pin!(receiver);
        loop {
            let elapsed = started.elapsed();
            let Some(ceiling_left) = wait.ceiling.checked_sub(elapsed) else {
                return Err(self.stalled(&id, fallback_stage, StallKind::Ceiling, elapsed, wait));
            };
            let slice = wait.inactivity.min(ceiling_left);
            let kind = if slice == ceiling_left {
                StallKind::Ceiling
            } else {
                StallKind::Silent
            };
            tokio::select! {
                result = &mut receiver => {
                    return match result {
                        Ok(result) => result,
                        Err(_) => Err(HostError::Stopped("response channel closed".into())),
                    };
                }
                changed = progress.changed(), if watching => {
                    // The sender lives in this same `HostInner`, so a closed channel is unreachable
                    // while `&self` is held. Handled anyway, and handled by stopping the re-arming
                    // rather than by returning: the deadline must survive a channel that does not.
                    if changed.is_err() {
                        watching = false;
                    }
                }
                () = tokio::time::sleep(slice) => {
                    return Err(self.stalled(&id, fallback_stage, kind, started.elapsed(), wait));
                }
            }
        }
    }

    /// Builds the stall error and drops the pending request, so a late response cannot be delivered
    /// to a caller that has already been told the startup failed.
    ///
    /// The budget named in the message is the one that was actually exceeded — the inactivity bound
    /// for a silent host, the remaining ceiling for one that kept talking — never the elapsed time
    /// wearing a budget's label.
    fn stalled(
        &self,
        id: &str,
        fallback_stage: &str,
        kind: StallKind,
        waited: Duration,
        wait: ProgressWait,
    ) -> HostError {
        self.pending.remove(id);
        let stage = self
            .boot_progress
            .borrow()
            .as_ref()
            .map_or_else(|| fallback_stage.to_owned(), BootProgress::describe);
        let budget = match kind {
            StallKind::Silent => wait.inactivity,
            StallKind::Ceiling => wait.ceiling,
        };
        HostError::StartupStalled(stall_message(&stage, kind, waited, budget))
    }

    async fn send_resync(
        &self,
        request_id: String,
        session_id: String,
        after_event_seq: String,
    ) -> Result<(), HostError> {
        let value = serde_json::to_value(JsonRpcRequest {
            jsonrpc: JsonRpcVersion,
            id: JsonRpcId::String(request_id),
            method: "zer0/room/resync".into(),
            params: json!({"sessionId": session_id, "afterEventSeq": after_event_seq}),
        })
        .map_err(|error| HostError::Io(format!("resync request serialization failed: {error}")))?;
        self.send_value(value).await
    }

    async fn send_value(&self, value: Value) -> Result<(), HostError> {
        let mut line =
            serde_json::to_vec(&value).map_err(|error| HostError::Io(error.to_string()))?;
        if line.len() + 1 > crate::transport::MAX_FRAME_BYTES {
            return Err(HostError::Frame("outbound request exceeds 1 MiB".into()));
        }
        line.push(b'\n');
        let sender = self
            .writer
            .lock()
            .await
            .clone()
            .ok_or(HostError::AdmissionClosed)?;
        match timeout(WRITER_SEND_BOUND, sender.send(line)).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(_)) => Err(HostError::Stopped("stdin writer stopped".into())),
            Err(_) => Err(HostError::RequestTimedOut(
                "stdin writer backpressure".into(),
            )),
        }
    }

    async fn close_writer(&self) {
        self.writer.lock().await.take();
    }

    async fn process_frame(&self, frame: ServerFrame) -> Result<(), HostError> {
        let (effects, is_live) = {
            let mut transport = self
                .transport
                .write()
                .expect("room transport lock poisoned");
            let effects = transport
                .ingest_effects(frame.clone())
                .map_err(|error| HostError::Frame(error.to_string()))?;
            (effects, transport.phase() == SyncPhase::Live)
        };
        if effects.readiness.is_some() || !effects.applied_events.is_empty() {
            self.room_view_revision.send_modify(|revision| {
                *revision = revision.wrapping_add(1);
            });
        }
        self.live.send_replace(is_live);
        if let Some(readiness) = effects.readiness {
            self.readiness.send_replace(Some(readiness.clone()));
            let _ = self.events.send(HostEvent::Readiness(readiness));
        }
        for event in effects.applied_events {
            let _ = self.events.send(HostEvent::Room(event));
        }
        for action in effects.actions {
            let TransportAction::RequestResync {
                request_id,
                session_id,
                after_event_seq,
            } = action;
            self.send_resync(request_id, session_id, after_event_seq)
                .await?;
        }
        if let Some((id, result)) = response_for_pending(&frame) {
            if let Some(sender) = self.pending.remove(id) {
                let _ = sender.send(result);
            }
        }
        Ok(())
    }

    async fn current_session_id(&self) -> Option<String> {
        self.transport
            .read()
            .expect("room transport lock poisoned")
            .reducer()
            .session_id()
            .map(str::to_owned)
    }

    async fn record_transport_failure(&self, error: HostError) -> bool {
        if self
            .failure_recorded
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return false;
        }
        self.accepting.store(false, Ordering::Release);
        self.transport_failure.send_replace(Some(error.clone()));
        self.fail_pending(error);
        self.close_writer().await;
        true
    }

    fn fail_pending(&self, error: HostError) {
        for sender in self.pending.drain() {
            let _ = sender.send(Err(error.clone()));
        }
    }

    /// Record that THIS launcher is about to terminate the process tree, so the exit the monitor is
    /// about to observe is not read as the host's own failure.
    ///
    /// Call it immediately BEFORE `kill_all()`. Of the decisions that get READ, the first wins:
    /// `HostProcess::drop` kills again after `shutdown()` may already have, and the branch that
    /// actually gave up on the host is the one worth reporting.
    ///
    /// The guard is `exit` being PUBLISHED, not the exit being decided (A7, H-0 review 2026-09-12):
    /// `record_exit` takes the note, awaits `close_writer()`, and publishes after that, so a decision
    /// arriving inside that window is stored and never taken. Left that way deliberately: reaching
    /// `record_exit` means `child.wait()` already resolved, so `cause: Host` is truthful and the
    /// concurrent `kill_all()` lands on a dead tree. A FOURTH kill site drops its note here.
    fn note_launcher_termination(&self, termination: LauncherTermination) {
        if self.exit.borrow().is_some() {
            return;
        }
        self.termination
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get_or_insert(termination);
    }

    /// The terminate decision, if one was taken, cleared as it is read.
    fn take_launcher_termination(&self) -> Option<LauncherTermination> {
        self.termination
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
    }

    async fn record_exit(&self, code: Option<i32>, success: bool) {
        let exit = HostExit {
            code,
            success,
            cause: self
                .take_launcher_termination()
                .map_or(HostExitCause::Host, HostExitCause::LauncherTerminated),
        };
        self.accepting.store(false, Ordering::Release);
        let pending_error = self
            .transport_failure
            .borrow()
            .clone()
            .unwrap_or_else(|| HostError::Stopped(format!("host exited with {:?}", exit.code)));
        self.fail_pending(pending_error);
        self.close_writer().await;
        self.exit.send_replace(Some(exit.clone()));
        let _ = self.events.send(HostEvent::Exited(exit));
        self.cancellation.cancel();
    }

    async fn record_reap_failure(&self, error: HostError) {
        self.accepting.store(false, Ordering::Release);
        let _ = self.record_transport_failure(error).await;
        self.cancellation.cancel();
    }

    async fn wait_for_exit(&self, wait: Duration) -> Result<HostExit, HostError> {
        let mut exit = self.exit.subscribe();
        timeout(wait, async move {
            loop {
                if let Some(status) = exit.borrow().clone() {
                    return status;
                }
                if exit.changed().await.is_err() {
                    // Every sender lives in `HostInner`, which every waiter holds through an `Arc`, so
                    // this is unreachable while anyone can wait. A defensive value, not an
                    // observation: nothing in the launcher terminated anything here.
                    return HostExit {
                        code: None,
                        success: false,
                        cause: HostExitCause::Host,
                    };
                }
            }
        })
        .await
        .map_err(|_| HostError::Stopped("timed out waiting for host reaping".into()))
    }

    async fn shutdown(&self) -> Result<(), HostError> {
        if self
            .shutdown_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(HostError::AdmissionClosed);
        }
        self.accepting.store(false, Ordering::Release);
        // A host that has ALREADY exited is not a failure to shut down: nothing is left to ask and the
        // process the caller wanted gone is gone. Without this the sequence runs into a closed writer,
        // `send_value` answers `AdmissionClosed`, and `cli::run_room`'s `shutdown?` turns a host that
        // quit cleanly into exit code 4 with "host is not accepting requests" (A3, H-0 r2). What the
        // exit WAS is reported on its own channel as a `HostExit`. The handoff consume is the same
        // reason as the returns below: an exited host may still have left a digest request on disk.
        if self.exit.borrow().is_some() {
            self.consume_digest_handoff();
            return Ok(());
        }
        let started = Instant::now();
        // Carried to the reap's branch so its sentence cannot claim an ack that never came; what false
        // covers is documented on `TerminationBranch::ShutdownReap` (CX3).
        let mut acknowledged = false;
        let graceful = if let Some(session_id) = self.current_session_id().await {
            let id = self.next_id("zer0-shutdown");
            let _pending_guard = PendingRequestGuard::new(Arc::clone(&self.pending), id.clone());
            match self
                .send_request(
                    id.clone(),
                    "zer0/room/shutdown",
                    json!({"sessionId": session_id}),
                )
                .await
            {
                Ok(receiver) => {
                    let answer = self
                        .await_response(id, receiver, remaining(started, SHUTDOWN_RESPONSE_BOUND))
                        .await;
                    acknowledged = answer.is_ok();
                    answer.map(|_| ())
                }
                Err(error) => Err(error),
            }
        } else {
            Ok(())
        };
        self.close_writer().await;
        // The clamp (CX1) and the verdict both live in `host_shutdown`, with their reasoning.
        let graceful_reap = graceful_reap_for(started.elapsed());
        let reap_started = Instant::now();
        if let Ok(exit) = self.wait_for_exit(graceful_reap).await {
            self.cancellation.cancel();
            self.consume_digest_handoff();
            return quit_outcome(&exit, graceful);
        }
        // Said BEFORE the terminate, so the exit the monitor is about to see carries the reason rather
        // than `TerminateJobObject`'s bare code 1 with an empty stderr (FL-143).
        let termination = LauncherTermination {
            branch: TerminationBranch::ShutdownReap { acknowledged },
            waited: reap_started.elapsed(),
        };
        self.note_launcher_termination(termination);
        tracing::warn!(bound = ?graceful_reap, "{termination}; terminating the process tree");
        self.scope.kill_all();
        let reaped = self
            .wait_for_exit(remaining(started, SHUTDOWN_TOTAL_BOUND))
            .await;
        self.cancellation.cancel();
        // Also on the kill branch: the host fsyncs its request before the close completes, so a host
        // we had to kill afterwards may still have left one.
        self.consume_digest_handoff();
        match reaped {
            // Same verdict as the branch above, and `quit_outcome` is where it is explained: a kill the
            // caller can only learn about from here, and an acknowledgement that never came back must
            // not reach the operator as this request's timeout (codex r3 R2-2, reviewer CX-2).
            Ok(exit) => quit_outcome(&exit, graceful),
            Err(error) => Err(error),
        }
    }

    /// Spawn whatever close digest the host handed off, now that it has exited.
    ///
    /// SYNCHRONOUS ON PURPOSE. A `tokio::spawn`ed task here would race this
    /// process's own exit: the runtime is dropped while the task is still
    /// queued, the task is cancelled, no child is ever created, and the operator
    /// loses that session's memory with nothing on disk to say so. The work is
    /// one file read plus at most a couple of `CreateProcess` calls
    /// (`crate::digest_handoff`, finding F10).
    ///
    /// NOT a race against the job handle, which by this point is usually already
    /// closed: `spawn_monitor` holds the only strong `Arc<ProcessGroup>` and
    /// drops it the moment it reaps the host, and `wait_for_exit` returns off
    /// that same reap. That costs nothing, because the child is created by THIS
    /// process — which is never assigned to the job — so there is no window in
    /// which it could inherit one. The ordering that matters is only that this
    /// runs at all, on every path out.
    ///
    /// Called after `wait_for_exit` on both shutdown branches and once more from
    /// `HostProcess::drop`; the consumer is idempotent, so the extra calls are
    /// a no-op read of a file that is no longer there.
    fn consume_digest_handoff(&self) {
        let _ = crate::digest_handoff::consume_digest_requests(&self.operator_root);
    }
}

fn remaining(started: Instant, bound: Duration) -> Duration {
    bound.saturating_sub(started.elapsed())
}

fn response_for_pending(frame: &ServerFrame) -> Option<(&str, Result<Value, HostError>)> {
    match frame {
        ServerFrame::Response(JsonRpcResponse::Success {
            id: JsonRpcResponseId::Id(JsonRpcId::String(id)),
            result,
            ..
        }) => Some((id, Ok(result.clone()))),
        ServerFrame::Response(JsonRpcResponse::Error {
            id: JsonRpcResponseId::Id(JsonRpcId::String(id)),
            error,
            ..
        }) => Some((id, Err(HostError::Remote(error.message.clone())))),
        _ => None,
    }
}

struct ResyncPage {
    events: Vec<RoomEvent>,
    has_more: bool,
}

fn parse_resync_page(value: &Value) -> Result<ResyncPage, HostError> {
    let object = value
        .as_object()
        .filter(|object| {
            object.len() == 1
                || (object.len() == 2
                    && object.contains_key("events")
                    && object.contains_key("hasMore"))
        })
        .ok_or_else(|| {
            HostError::Frame(
                "resync result must be exactly {events:[...]} or {events:[...],hasMore:boolean}"
                    .into(),
            )
        })?;
    let events = object
        .get("events")
        .and_then(Value::as_array)
        .ok_or_else(|| HostError::Frame("resync events must be an array".into()))?;
    let events = events
        .iter()
        .cloned()
        .map(RoomEvent::from_value)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| HostError::Frame(format!("invalid resync event: {error}")))?;
    let has_more = object
        .get("hasMore")
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| HostError::Frame("resync hasMore must be a boolean".into()))
        })
        .transpose()?
        .unwrap_or(false);
    Ok(ResyncPage { events, has_more })
}

async fn record_transport_failure(inner: Arc<HostInner>, error: HostError) {
    if !inner.record_transport_failure(error).await {
        return;
    }
    let reaper = Arc::clone(&inner);
    tokio::spawn(async move {
        let reap_started = Instant::now();
        if reaper.wait_for_exit(FAILURE_REAP_GRACE).await.is_err() {
            reaper.note_launcher_termination(LauncherTermination {
                branch: TerminationBranch::TransportFailureReap,
                waited: reap_started.elapsed(),
            });
            reaper.scope.kill_all();
        }
        reaper.cancellation.cancel();
    });
}

fn spawn_writer(
    inner: Arc<HostInner>,
    mut stdin: ChildStdin,
    mut receiver: mpsc::Receiver<Vec<u8>>,
) {
    tokio::spawn(async move {
        loop {
            let next = tokio::select! {
                _ = inner.cancellation.cancelled() => return,
                next = receiver.recv() => next,
            };
            let Some(line) = next else {
                return;
            };
            let write = async {
                stdin.write_all(&line).await?;
                stdin.flush().await
            }
            .await;
            if let Err(error) = write {
                record_transport_failure(
                    Arc::clone(&inner),
                    HostError::Io(format!("stdin write failed: {error}")),
                )
                .await;
                return;
            }
        }
    });
}

fn spawn_stdout_reader(inner: Arc<HostInner>, stdout: ChildStdout) {
    tokio::spawn(async move {
        let mut lines = FramedRead::new(
            stdout,
            StrictLinesCodec::new(crate::transport::MAX_FRAME_CONTENT_BYTES),
        );
        loop {
            let line = tokio::select! {
                _ = inner.cancellation.cancelled() => return,
                line = lines.next() => line,
            };
            match line {
                // Boot progress is classified BEFORE the room transport sees the bytes. It has to be:
                // the transport's decoder accepts exactly one notification method and treats every
                // other as fatal, which is the property the durable protocol is built on and is not
                // being widened for a startup concern.
                Some(Ok(line)) => match classify_boot_frame(line.as_slice()) {
                    BootFrame::Progress(progress) => {
                        inner.boot_progress.send_replace(Some(progress));
                    }
                    BootFrame::Malformed(reason) => {
                        record_transport_failure(Arc::clone(&inner), HostError::Frame(reason))
                            .await;
                        return;
                    }
                    BootFrame::RoomFrame => match classify_frame(line.as_slice()) {
                        Ok(frame) => {
                            if let Err(error) = inner.process_frame(frame).await {
                                record_transport_failure(Arc::clone(&inner), error).await;
                                return;
                            }
                        }
                        Err(error) => {
                            record_transport_failure(
                                Arc::clone(&inner),
                                HostError::Frame(error.to_string()),
                            )
                            .await;
                            return;
                        }
                    },
                },
                Some(Err(error)) => {
                    record_transport_failure(
                        Arc::clone(&inner),
                        HostError::Frame(error.to_string()),
                    )
                    .await;
                    return;
                }
                None => {
                    if !inner.shutdown_started.load(Ordering::Acquire)
                        && inner.exit.borrow().is_none()
                    {
                        record_transport_failure(
                            Arc::clone(&inner),
                            HostError::Stopped("stdout closed before host reaping".into()),
                        )
                        .await;
                    }
                    return;
                }
            }
        }
    });
}

fn spawn_stderr_reader(inner: Arc<HostInner>, mut stderr: ChildStderr) {
    tokio::spawn(async move {
        let mut chunk = [0_u8; 4096];
        loop {
            let read = tokio::select! {
                _ = inner.cancellation.cancelled() => return,
                read = stderr.read(&mut chunk) => read,
            };
            match read {
                Ok(0) => return,
                Ok(read) => {
                    let mut tail = inner.stderr_tail.lock().await;
                    tail.extend_from_slice(&chunk[..read]);
                    if tail.len() > MAX_STDERR_TAIL_BYTES {
                        let excess = tail.len() - MAX_STDERR_TAIL_BYTES;
                        tail.drain(..excess);
                    }
                }
                Err(error) => {
                    record_transport_failure(
                        Arc::clone(&inner),
                        HostError::Io(format!("stderr read failed: {error}")),
                    )
                    .await;
                    return;
                }
            }
        }
    });
}

fn spawn_monitor(inner: Arc<HostInner>, mut child: Child, group: Arc<ProcessGroup>) {
    tokio::spawn(async move {
        // The strong group reference remains live until the direct child is
        // actually reaped, keeping ProcessScope's weak registration effective.
        let _group = group;
        match child.wait().await {
            Ok(status) => {
                inner.record_exit(status.code(), status.success()).await;
            }
            Err(error) => {
                inner
                    .record_reap_failure(HostError::Io(format!("child reap failed: {error}")))
                    .await;
            }
        }
    });
}

#[derive(Debug)]
struct Launcher {
    node: OsString,
    script: PathBuf,
}

async fn resolve_launcher(_options: &HostProcessOptions) -> Result<Launcher, HostError> {
    #[cfg(any(test, feature = "test-support"))]
    if let Some(launcher) = &_options.test_launcher {
        if !launcher.script.is_file() {
            return Err(HostError::Startup(format!(
                "test host script does not exist: {}",
                launcher.script.display()
            )));
        }
        return Ok(Launcher {
            node: launcher.node.clone(),
            script: launcher.script.clone(),
        });
    }
    let executable = std::env::current_exe().map_err(|error| {
        HostError::Startup(format!("could not resolve current executable: {error}"))
    })?;
    launcher_beside_executable(&executable).await
}

async fn launcher_beside_executable(executable: &Path) -> Result<Launcher, HostError> {
    let parent = executable.parent().ok_or_else(|| {
        HostError::Startup(format!(
            "current executable has no parent directory: {}",
            executable.display()
        ))
    })?;
    let script = parent.join("zer0-v2-host.mjs");
    if !script.is_file() {
        return Err(HostError::Startup(format!(
            "release host script does not exist beside executable: {}",
            script.display()
        )));
    }
    Ok(Launcher {
        node: choose_node(parent).await?,
        script,
    })
}

/// Which interpreter this launch will use, and why — the whole decision in one value so the log line
/// and the chosen path cannot disagree.
#[derive(Clone, Debug, Eq, PartialEq)]
enum NodeChoice {
    /// The packaged sibling, inside the supported range.
    Sibling(PathBuf),
    /// A sibling exists and was refused. Carries the reason, which is the only thing that explains a
    /// packaged build quietly running the operator's own Node.
    Rejected(PathBuf, String),
    /// No sibling: a developer checkout, which is the ordinary case outside a release artifact.
    Absent,
}

/// Picks the interpreter and says so at debug level.
///
/// The RELEASE artifact ships `node.exe` FLAT beside the executable — verified against the artifact
/// from `afa82b0` (`m0irai.exe`, `node.exe`, `node-LICENSE.txt`, `zer0-v2-host.mjs`,
/// `SHA256SUMS.json`, `zer0-v2-node/`) and against `scripts/release.mjs`, which copies
/// `process.execPath` to `assertContained(artifactRoot, "node.exe")`. So the sibling is the file
/// directly beside us, not one inside `zer0-v2-node/`.
///
/// Preferring it matters because a PATH `node` is an unpinned dependency on the operator's machine: a
/// different major, a version-manager shim that is not on PATH for a double-clicked process, or
/// nothing at all. Falling back to the bare name keeps a developer checkout, which ships no sibling,
/// working exactly as it did.
///
/// The version check is what stops the preference from becoming its own trap. A sibling outside the
/// supported range would otherwise be preferred over a PERFECTLY GOOD PATH Node and fail later, inside
/// the host, as a Node syntax or API error with nothing pointing back at the launcher.
/// NEVER RETURNS A BARE PROGRAM NAME. Every success is an absolute path, and that is the whole point
/// of this function, not a detail of it.
///
/// Round 2 returned the literal `"node.exe"` when it refused a sibling, and called that "falling back
/// to PATH". On Windows it is not. Microsoft's documented search order for an unqualified program
/// name, `CreateProcessW`, `lpCommandLine`:
///
/// > If the file name does not contain a directory path, the system searches for the executable file
/// > in the following sequence:
/// > 1. The directory from which the application loaded.
/// > 2. The current directory for the parent process.
/// > 3. The 32-bit Windows system directory. …
/// > 6. The directories that are listed in the PATH environment variable.
///
/// The directory the application loaded from is item ONE and PATH is item SIX — and item one is
/// exactly where the refused file sits. So the refusal ran, and then the same file ran. Observed on
/// the shipped binary with an 18-byte stub beside it: `os error 216`, boot dead, while the identical
/// binary with the stub removed reached the room.
///
/// The fix is here rather than at the probe: whatever this returns must be a path that cannot resolve
/// back into the application directory by accident. When nothing usable exists anywhere, it refuses to
/// start and says what it found where — a named refusal is a better outcome than an interpreter chosen
/// by a search order nobody intended.
async fn choose_node(parent: &Path) -> Result<OsString, HostError> {
    match sibling_choice(parent).await {
        NodeChoice::Sibling(path) => {
            tracing::debug!(node = %path.display(), "using the Node packaged beside the executable");
            Ok(path.into_os_string())
        }
        NodeChoice::Rejected(path, reason) => {
            tracing::debug!(
                node = %path.display(),
                reason = %reason,
                "refused the Node packaged beside the executable; searching PATH"
            );
            resolve_node_on_path(Some((path, reason))).await
        }
        NodeChoice::Absent => {
            tracing::debug!("no Node beside the executable; searching PATH");
            resolve_node_on_path(None).await
        }
    }
}

/// Walks PATH in order and returns the first entry that IS a usable interpreter, as a full path.
///
/// Every candidate is version-probed, not just the first: a machine with an old Node early on PATH and
/// a good one later should boot, and — the case that matters — a refused sibling that also happens to
/// sit on PATH is refused again here rather than slipping through.
///
/// `which_all_global` rather than `which_all`: the global form ignores the current directory, so the
/// search cannot pick up a `node.exe` that merely happens to be in whatever folder the operator
/// launched from. PATHEXT is the crate's business on Windows, which is why this searches the stem.
async fn resolve_node_on_path(
    refused_sibling: Option<(PathBuf, String)>,
) -> Result<OsString, HostError> {
    let mut examined: Vec<String> = Vec::new();
    if let Some((path, reason)) = &refused_sibling {
        examined.push(format!(
            "  beside the executable: {} — {reason}",
            path.display()
        ));
    }
    let candidates: Vec<PathBuf> = which::which_all_global(NODE_SEARCH_STEM)
        .map(|found| found.take(MAX_PATH_CANDIDATES).collect())
        .unwrap_or_default();
    for candidate in candidates {
        if refused_sibling
            .as_ref()
            .is_some_and(|(refused, _)| refused == &candidate)
        {
            // Already probed a moment ago, and the answer cannot have changed. Skipping saves a second
            // probe timeout; a near-miss (a different spelling of the same file) costs one probe and is
            // still refused, so correctness does not depend on this matching.
            continue;
        }
        match probe_node_version(&candidate).await {
            Ok(version) if engines_allow(NODE_ENGINES_RANGE, &version) => {
                tracing::debug!(
                    node = %candidate.display(),
                    version = %version,
                    "using the first usable Node found on PATH"
                );
                return Ok(candidate.into_os_string());
            }
            Ok(version) => examined.push(format!(
                "  on PATH: {} — v{version} is outside {NODE_ENGINES_RANGE}",
                candidate.display()
            )),
            Err(reason) => examined.push(format!("  on PATH: {} — {reason}", candidate.display())),
        }
    }
    Err(HostError::Startup(no_usable_node_message(&examined)))
}

/// The refusal the operator reads when no interpreter anywhere can run the host.
///
/// Names what was found and where, then what to do about it. Refusing beats guessing: the alternative
/// is handing an unqualified name to the OS and letting its search order decide, which is the defect
/// this whole function exists to remove.
fn no_usable_node_message(examined: &[String]) -> String {
    let found = if examined.is_empty() {
        "  no Node was found beside the executable or anywhere on PATH.".to_owned()
    } else {
        examined.join("\n")
    };
    format!(
        "no usable Node was found, so the room host cannot be started.\n{found}\n  m0irai needs a Node matching {NODE_ENGINES_RANGE}; the release artifact bundles v24.18.0.\n  Install Node 24 and put it on PATH, or place a matching node{} beside m0irai{}.",
        if cfg!(windows) { ".exe" } else { "" },
        if cfg!(windows) { ".exe" } else { "" },
    )
}

async fn sibling_choice(parent: &Path) -> NodeChoice {
    let sibling = parent.join(NODE_PROGRAM_NAME);
    if !sibling.is_file() {
        return NodeChoice::Absent;
    }
    match probe_node_version(&sibling).await {
        Ok(version) if engines_allow(NODE_ENGINES_RANGE, &version) => NodeChoice::Sibling(sibling),
        Ok(version) => NodeChoice::Rejected(
            sibling,
            format!("v{version} is outside the supported range {NODE_ENGINES_RANGE}"),
        ),
        Err(reason) => NodeChoice::Rejected(sibling, reason),
    }
}

/// Asks the candidate what version it is.
///
/// Bounded, and the bound is the point: a sibling that is a corrupt binary, a stub, or a file that
/// merely happens to be named `node.exe` must not be able to hang a boot before the boot has a
/// deadline of its own. `kill_on_drop` means the timeout actually reaps it rather than orphaning it,
/// which is the same rule the process scope enforces for the host itself.
async fn probe_node_version(candidate: &Path) -> Result<Version, String> {
    let mut command = Command::new(candidate);
    command
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let output = timeout(NODE_VERSION_PROBE_BOUND, command.output())
        .await
        .map_err(|_| {
            format!(
                "it did not answer --version within {}s",
                NODE_VERSION_PROBE_BOUND.as_secs()
            )
        })?
        .map_err(|error| format!("it could not be run: {error}"))?;
    if !output.status.success() {
        return Err(format!("--version exited with {:?}", output.status.code()));
    }
    parse_node_version(&String::from_utf8_lossy(&output.stdout))
        .ok_or_else(|| "--version did not print a version".to_owned())
}

/// `node --version` prints `v24.18.0` and a newline.
fn parse_node_version(stdout: &str) -> Option<Version> {
    Version::parse(stdout.trim().trim_start_matches('v')).ok()
}

/// Whether `version` satisfies an npm-style range.
///
/// `semver::VersionReq` parses comparator sets (`>=22.17.0, <23`) but deliberately does NOT implement
/// npm's `||` union, so the union is split here and each side handed to the crate. That split is the
/// whole of the hand-rolling: comparator parsing, prerelease rules and matching stay with the library.
fn engines_allow(range: &str, version: &Version) -> bool {
    range.split("||").any(|clause| {
        VersionReq::parse(&clause.split_whitespace().collect::<Vec<_>>().join(","))
            .is_ok_and(|requirement| requirement.matches(version))
    })
}

async fn startup_pipe_failure(name: &str, scope: &ProcessScope, child: &mut Child) -> HostError {
    scope.kill_all();
    let _ = timeout(Duration::from_secs(2), child.wait()).await;
    HostError::Startup(format!("host {name} was not piped"))
}

async fn spawn_enrolled(
    scope: &ProcessScope,
    node: &OsString,
    script: &Path,
    options: &HostProcessOptions,
) -> Result<(Child, Arc<ProcessGroup>), HostError> {
    let mut retried_without_breakaway = false;
    loop {
        let mut command = host_command(node, script, options, scope, !retried_without_breakaway);
        match command.spawn() {
            Ok(mut child) => match scope.enroll(&child) {
                Ok(group) => return Ok((child, group)),
                Err(error) => {
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                    return Err(HostError::Startup(format!(
                        "process-scope enrollment failed: {error}"
                    )));
                }
            },
            Err(error)
                if cfg!(windows)
                    && !retried_without_breakaway
                    && error.raw_os_error() == Some(5) =>
            {
                retried_without_breakaway = true;
            }
            Err(error) => {
                // Naming the interpreter is the whole diagnostic: "could not spawn node host" is the
                // same sentence whether the packaged sibling is missing, the PATH `node` is absent, or
                // a shim refused, and those need three different fixes.
                return Err(HostError::Startup(format!(
                    "could not spawn the room host with {}: {error}",
                    node.to_string_lossy()
                )));
            }
        }
    }
}

fn host_command(
    node: &OsString,
    script: &Path,
    options: &HostProcessOptions,
    scope: &ProcessScope,
    breakaway: bool,
) -> Command {
    let mut command = Command::new(node);
    command
        .arg(script)
        .current_dir(&options.operator_root)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    apply_host_env(&mut command, options);
    configure_process_group(&mut command, scope, breakaway);
    command
}

/// The host's environment. Production changes exactly one variable from what
/// this process inherited: `ZER0_DIGEST_HANDOFF=1`, which tells the host to hand
/// its CLOSE digest to us instead of forking it inside the job (F10 — see
/// `crate::digest_handoff`). Every other spawn the host makes is unaffected.
fn apply_host_env(command: &mut Command, options: &HostProcessOptions) {
    #[cfg(any(test, feature = "test-support"))]
    if let Some(entries) = options.test_env.as_ref() {
        command.env_clear();
        for (key, value) in entries {
            command.env(key, value);
        }
    }
    if options.digest_handoff() {
        command.env(crate::digest_handoff::HANDOFF_FLAG, "1");
    }
}

#[cfg(windows)]
fn configure_process_group(command: &mut Command, _scope: &ProcessScope, breakaway: bool) {
    use windows::Win32::System::Threading::{
        CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW,
    };
    let mut flags = CREATE_NO_WINDOW.0 | CREATE_NEW_PROCESS_GROUP.0;
    if breakaway {
        flags |= CREATE_BREAKAWAY_FROM_JOB.0;
    }
    command.creation_flags(flags);
}

#[cfg(not(windows))]
fn configure_process_group(command: &mut Command, scope: &ProcessScope, _breakaway: bool) {
    scope.prepare(command);
}

#[cfg(test)]
mod launcher_tests {
    use super::*;

    #[tokio::test]
    async fn aborting_a_request_future_synchronously_removes_its_pending_id() {
        let pending = Arc::new(PendingRequests::default());
        let (inserted_tx, inserted_rx) = oneshot::channel();
        let task_pending = Arc::clone(&pending);
        let task = tokio::spawn(async move {
            let _guard = PendingRequestGuard::new(Arc::clone(&task_pending), "picker-1".into());
            let (sender, _receiver) = oneshot::channel();
            task_pending.insert("picker-1".into(), sender);
            let _ = inserted_tx.send(());
            std::future::pending::<()>().await;
        });
        inserted_rx.await.expect("request was inserted");
        assert_eq!(pending.len(), 1);

        task.abort();
        let error = task.await.expect_err("aborted task cannot complete");
        assert!(error.is_cancelled());
        assert_eq!(pending.len(), 0);
        assert!(pending.remove("picker-1").is_none());
    }

    #[tokio::test]
    async fn release_launcher_is_only_the_sibling_of_the_executable() {
        let temp = tempfile::tempdir().unwrap();
        let executable = temp.path().join(if cfg!(windows) {
            "m0irai.exe"
        } else {
            "m0irai"
        });
        let missing = launcher_beside_executable(&executable).await.unwrap_err();
        assert!(
            matches!(missing, HostError::Startup(message) if message.contains("beside executable"))
        );

        let relocated = temp.path().join("relocated");
        std::fs::create_dir(&relocated).unwrap();
        std::fs::write(relocated.join("zer0-v2-host.mjs"), "// wrong directory").unwrap();
        assert!(launcher_beside_executable(&executable).await.is_err());

        let script = temp.path().join("zer0-v2-host.mjs");
        std::fs::write(&script, "// test launcher").unwrap();
        let resolved = launcher_beside_executable(&executable).await.unwrap();
        assert_eq!(resolved.script, script);
    }

    /// THE SHIPPED LAYOUT, staged from the artifact the RELEASE lane actually produces at `afa82b0`:
    /// `m0irai.exe`, `node.exe`, `node-LICENSE.txt`, `zer0-v2-host.mjs`, `SHA256SUMS.json` and a
    /// `zer0-v2-node/` directory, with the interpreter FLAT beside the executable rather than inside
    /// that directory. Pinned as a layout so a repackaging that moves Node one level down fails here
    /// instead of silently falling back to the operator's PATH.
    ///
    /// The sibling is a real `node.exe` — the one running this test — because the version check is
    /// part of the decision now and a stub file cannot answer `--version`.
    #[tokio::test]
    async fn the_launcher_prefers_the_real_node_in_the_release_layout() {
        let temp = tempfile::tempdir().unwrap();
        let executable = temp.path().join(if cfg!(windows) {
            "m0irai.exe"
        } else {
            "m0irai"
        });
        std::fs::write(temp.path().join("zer0-v2-host.mjs"), "// test launcher").unwrap();
        std::fs::create_dir(temp.path().join("zer0-v2-node")).unwrap();
        std::fs::write(temp.path().join("node-LICENSE.txt"), "licence").unwrap();

        let from_path = launcher_beside_executable(&executable).await.unwrap();
        assert_usable_interpreter(&from_path.node).await;

        let sibling = temp.path().join(NODE_PROGRAM_NAME);
        link_or_copy(&real_node(), &sibling);
        let beside = launcher_beside_executable(&executable).await.unwrap();
        assert_eq!(beside.node, OsString::from(sibling.as_os_str()));
    }

    /// THE BLOCKER, as a test that can observe it.
    ///
    /// Round 2 refused a stub sibling and then returned the bare name `node.exe`, which Windows
    /// resolves against the application directory BEFORE PATH — straight back to the stub. The test
    /// that certified this compared an `OsString` to the literal `"node.exe"` and never spawned
    /// anything, so it could not see that the literal did not mean what its own message claimed.
    ///
    /// This one refuses to be satisfied by a string. It plants an 18-byte stub, resolves the launcher,
    /// and then RUNS whatever came back: the result must be a real interpreter inside the supported
    /// range, or the launcher must have refused to start and said what it found where. Either way the
    /// stub is never what gets executed.
    #[tokio::test]
    async fn a_stub_sibling_is_never_the_interpreter_that_gets_executed() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("zer0-v2-host.mjs"), "// test launcher").unwrap();
        let stub = temp.path().join(NODE_PROGRAM_NAME);
        std::fs::write(&stub, "not an interpreter").unwrap();

        let choice = sibling_choice(temp.path()).await;
        let NodeChoice::Rejected(path, reason) = choice else {
            panic!("a stub sibling must be refused, got {choice:?}");
        };
        assert_eq!(path, stub);
        assert!(!reason.is_empty(), "a refusal must say why");

        let executable = temp.path().join(if cfg!(windows) {
            "m0irai.exe"
        } else {
            "m0irai"
        });
        match launcher_beside_executable(&executable).await {
            Ok(resolved) => {
                assert_ne!(
                    resolved.node,
                    OsString::from(stub.as_os_str()),
                    "the refused stub must never be the chosen interpreter"
                );
                assert_ne!(
                    resolved.node,
                    OsString::from(NODE_PROGRAM_NAME),
                    "a bare program name resolves against the application directory before PATH, which is where the refused stub lives"
                );
                assert!(
                    Path::new(&resolved.node).is_absolute(),
                    "only an absolute path cannot be redirected by the OS search order, got {:?}",
                    resolved.node
                );
                assert_usable_interpreter(&resolved.node).await;
            }
            Err(HostError::Startup(message)) => {
                assert!(
                    message.contains("no usable Node")
                        && message.contains(&stub.display().to_string()),
                    "a refusal must name what it found where, got: {message}"
                );
            }
            Err(other) => panic!("unexpected launcher failure: {other:?}"),
        }
    }

    /// Runs the resolved interpreter and insists it really is one, inside the supported range. This is
    /// what makes the test above a behaviour check rather than a string comparison.
    async fn assert_usable_interpreter(node: &OsString) {
        let version = probe_node_version(Path::new(node))
            .await
            .unwrap_or_else(|reason| panic!("resolved node {node:?} is not runnable: {reason}"));
        assert!(
            engines_allow(NODE_ENGINES_RANGE, &version),
            "resolved node {node:?} reported v{version}, outside {NODE_ENGINES_RANGE}"
        );
    }

    /// A hard link where the filesystem allows one, a copy otherwise. The release interpreter is
    /// ~92 MB and this runs on every `cargo test` of the crate; the review flagged the copy.
    fn link_or_copy(from: &Path, to: &Path) {
        if std::fs::hard_link(from, to).is_ok() {
            return;
        }
        std::fs::copy(from, to).expect("the test needs a real interpreter beside the executable");
    }

    /// The range check itself, without spawning anything. `24.18.0` is what the release artifact
    /// ships; the rejects are the versions the range exists to keep out.
    #[test]
    fn the_engines_range_admits_the_shipped_node_and_refuses_the_gaps() {
        let allowed = ["22.17.0", "22.20.5", "24.2.0", "24.18.0", "25.0.0"];
        let refused = ["18.0.0", "22.16.9", "23.0.0", "23.11.0", "24.1.9"];
        for version in allowed {
            let parsed = Version::parse(version).unwrap();
            assert!(
                engines_allow(NODE_ENGINES_RANGE, &parsed),
                "{version} must satisfy {NODE_ENGINES_RANGE}"
            );
        }
        for version in refused {
            let parsed = Version::parse(version).unwrap();
            assert!(
                !engines_allow(NODE_ENGINES_RANGE, &parsed),
                "{version} must NOT satisfy {NODE_ENGINES_RANGE}"
            );
        }
        assert_eq!(
            parse_node_version("v24.18.0\n"),
            Version::parse("24.18.0").ok()
        );
        assert_eq!(
            parse_node_version("24.18.0"),
            Version::parse("24.18.0").ok()
        );
        assert_eq!(parse_node_version("not a version"), None);
        assert_eq!(parse_node_version(""), None);
    }

    /// THE DRIFT GATE. The range is a second copy of `package.json`'s `engines.node`, and this is what
    /// keeps the copy honest: it reads the real file, so widening the range for the Node half without
    /// following here turns red.
    #[test]
    fn the_engines_range_matches_package_json() {
        let package_json = Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(3)
            .expect("the crate sits three levels below the repository root")
            .join("package.json");
        let declared: Value =
            serde_json::from_str(&std::fs::read_to_string(&package_json).unwrap()).unwrap();
        let engines = declared["engines"]["node"]
            .as_str()
            .expect("package.json must declare engines.node");
        assert_eq!(
            engines, NODE_ENGINES_RANGE,
            "package.json declares {engines}; NODE_ENGINES_RANGE says {NODE_ENGINES_RANGE}"
        );
    }

    /// The interpreter running this test, which is a real Node only when the suite was started by one.
    /// Cargo runs the test binary directly, so this resolves Node from PATH the same way the launcher's
    /// fallback does.
    fn real_node() -> PathBuf {
        let found = std::process::Command::new(if cfg!(windows) { "where" } else { "which" })
            .arg(NODE_PROGRAM_NAME)
            .output()
            .expect("a Node on PATH is a prerequisite of this suite");
        let first = String::from_utf8_lossy(&found.stdout)
            .lines()
            .next()
            .expect("PATH must contain node")
            .trim()
            .to_owned();
        PathBuf::from(first)
    }

    #[test]
    fn strict_lines_codec_rejects_an_unterminated_eof_frame() {
        let mut codec = StrictLinesCodec::new(crate::transport::MAX_FRAME_CONTENT_BYTES);
        let mut source = BytesMut::from(&b"{\"jsonrpc\":\"2.0\""[..]);
        assert!(codec.decode_eof(&mut source).is_err());

        let mut complete = BytesMut::from(&b"{}\n"[..]);
        assert_eq!(
            codec.decode_eof(&mut complete).unwrap(),
            Some(b"{}".to_vec())
        );
        assert!(complete.is_empty());
    }
}
