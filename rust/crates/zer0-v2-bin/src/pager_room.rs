//! Zer0's composition boundary to the actual Grok pager frontend.
//!
//! The Node host owns provider processes, persistence, and the room reducer.
//! The pager owns the terminal, event loop, composer, and rendering. No local
//! terminal implementation is allowed on this production path.

use std::{future::Future, pin::Pin, time::Duration};

use serde_json::json;
use tokio::{sync::mpsc, task::JoinSet};
use xai_grok_pager::room_prompt_restore::SubmissionId;
use xai_grok_pager::room_runtime;
use zer0_room_protocol::RoomReducer;

use crate::host_process::{HostClient, HostError, HostEvent, HostEventReceiveError};

const SUBMIT_TIMEOUT: Duration = Duration::from_secs(30);
// A mode request can first join a bounded eager ACP handshake and then perform one bounded provider
// mode mutation. Claude and Codex run concurrently, so this covers one 60s + one 60s stage plus margin.
const MODE_CYCLE_TIMEOUT: Duration = Duration::from_secs(130);
const CATALOG_TIMEOUT: Duration = Duration::from_secs(3);
/// The boot readiness probe spawns a real CLI (`claude auth status`, measured 0.78 s), so it is given
/// more room than the catalog read and still bounded. Nothing waits for it: the room is already open
/// and rendering by the time this resolves, and a timeout leaves every agent `Unknown`, which renders
/// exactly as `Ready`.
const READINESS_TIMEOUT: Duration = Duration::from_secs(10);
const RESYNC_TIMEOUT: Duration = Duration::from_secs(15);
const MODEL_PICKER_TIMEOUT: Duration = Duration::from_secs(65);
const SESSION_PICKER_TIMEOUT: Duration = Duration::from_secs(15);
/// How long the exit waits for a cancel already in flight to be confirmed.
///
/// Not `SUBMIT_TIMEOUT`: the operator has pressed Ctrl+C twice and wants out, so
/// a room that hangs for thirty seconds on the way to the door is its own defect.
/// Five seconds covers a host that is answering and gives up on one that is not,
/// with the giving-up said out loud rather than swallowed.
const CANCEL_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

trait RoomCommandRequester {
    fn request<'a>(
        &'a self,
        method: &'static str,
        params: serde_json::Value,
        timeout: Duration,
    ) -> Pin<Box<dyn Future<Output = Result<serde_json::Value, HostError>> + Send + 'a>>;
}

#[derive(Clone)]
struct HostRoomCommandRequester {
    client: HostClient,
}

impl RoomCommandRequester for HostRoomCommandRequester {
    fn request<'a>(
        &'a self,
        method: &'static str,
        params: serde_json::Value,
        timeout: Duration,
    ) -> Pin<Box<dyn Future<Output = Result<serde_json::Value, HostError>> + Send + 'a>> {
        Box::pin(async move { self.client.request(method, params, timeout).await })
    }
}

/// Play the empty-room welcome card through the real pager runtime, with no
/// Node host and no agents, so its entrance can be judged on a real terminal.
///
/// This is the SHIPPING card: the same `run_room`, the same `render_room`, the
/// same `room_welcome::render_card`. The only difference from a production boot
/// is that no event ever arrives, so the room stays empty and the card stays up.
/// `r` replays the entrance, `q` / Esc / Ctrl-C quit.
#[cfg(feature = "welcome-demo")]
pub async fn run_welcome_demo() -> Result<(), HostError> {
    let (updates_tx, updates_rx) = mpsc::channel(32);
    let (commands_tx, mut commands_rx) = mpsc::channel(8);
    let (cancels_tx, mut cancels_rx) = mpsc::channel(4);
    tokio::spawn(async move { while commands_rx.recv().await.is_some() {} });
    tokio::spawn(async move { while cancels_rx.recv().await.is_some() {} });
    tokio::spawn(async move {
        // `run_loop` treats a closed update stream as the host dying, so the
        // sender has to outlive the demo. It never sends anything: an empty room
        // is the entire point.
        let _updates_tx = updates_tx;
        loop {
            tokio::time::sleep(Duration::from_secs(3600)).await;
        }
    });
    room_runtime::run_room(room_runtime::RoomRuntimeInput {
        version: crate::cli::version_text(),
        current_session_id: "welcome-demo".into(),
        reducer: RoomReducer::new(),
        catalog: Default::default(),
        updates: updates_rx,
        commands: commands_tx,
        cancels: cancels_tx,
    })
    .await
    .map(|_| ())
    .map_err(|error| HostError::Startup(format!("welcome demo failed: {error:#}")))
}

/// Run a deterministic, test-only Alive Room visual fixture through the same
/// pager runtime as production. No host process, alternate renderer, or
/// screenshot path is involved.
#[cfg(feature = "room-visual-fixture")]
pub async fn run_visual_fixture() -> Result<(), HostError> {
    let (updates_tx, updates_rx) = mpsc::channel(32);
    let (commands_tx, mut commands_rx) = mpsc::channel(8);
    let (cancels_tx, mut cancels_rx) = mpsc::channel(4);
    tokio::spawn(async move {
        // This is deliberately visual-only: discard outbound commands so a
        // manual keypress cannot block the pager, while the deterministic
        // pending permission remains visible for inspection.
        while commands_rx.recv().await.is_some() {}
    });
    tokio::spawn(async move { while cancels_rx.recv().await.is_some() {} });
    tokio::spawn(async move {
        for event in fixture_events() {
            let delay = fixture_event_delay(&event.kind);
            if updates_tx
                .send(room_runtime::RoomUpdate::Event(event))
                .await
                .is_err()
            {
                return;
            }
            tokio::time::sleep(delay).await;
        }
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
    room_runtime::run_room(room_runtime::RoomRuntimeInput {
        version: crate::cli::version_text(),
        current_session_id: "fixture-room-1".into(),
        reducer: RoomReducer::new(),
        catalog: Default::default(),
        updates: updates_rx,
        commands: commands_tx,
        cancels: cancels_tx,
    })
    .await
    .map(|_| ())
    .map_err(|error| HostError::Startup(format!("visual fixture failed: {error:#}")))
}

#[cfg(feature = "room-visual-fixture")]
fn fixture_event_delay(kind: &str) -> Duration {
    const MAX_TEST_DELAY: Duration = Duration::from_secs(2);
    if let Some(milliseconds) = std::env::var_os("ZER0_ROOM_TEST_FIXTURE_EVENT_DELAY_MS")
        .and_then(|value| value.to_str().and_then(|value| value.parse::<u64>().ok()))
    {
        return Duration::from_millis(milliseconds).min(MAX_TEST_DELAY);
    }
    if kind == "permission.requested" {
        Duration::from_secs(2)
    } else {
        Duration::from_millis(350)
    }
}

#[cfg(feature = "room-visual-fixture")]
fn fixture_events() -> Vec<zer0_room_protocol::RoomEvent> {
    let mut event_seq = 1_u64;
    let turn_id = "fixture-turn-1";
    let agents = ["claude", "codex", "gemini"];
    let mut events = vec![fixture_event(
        &mut event_seq,
        turn_id,
        "turn.accepted",
        json!({
            "agents": agents, "text": "@all verify the room fixture",
            "messageId": "msg-operator-1", "ledgerSeq": "1",
        }),
    )];
    events.push(fixture_event(
        &mut event_seq,
        turn_id,
        "route.resolved",
        json!({"agents": agents}),
    ));
    for agent in agents {
        events.push(fixture_event(&mut event_seq, turn_id, "lane.queued", json!({
            "laneId": format!("lane-{agent}"), "agent": agent, "expectedMessageId": format!("msg-{agent}-1"),
            "origin": "operator", "hopIndex": 0,
        })));
    }
    for agent in agents {
        events.push(fixture_event(&mut event_seq, turn_id, "lane.started", json!({
            "laneId": format!("lane-{agent}"), "streamId": format!("stream-{agent}"), "agent": agent,
        })));
    }
    events.extend([
        fixture_event(&mut event_seq, turn_id, "lane.chunk", json!({"laneId":"lane-claude","streamId":"stream-claude","agent":"claude","streamSeq":"1","chunkIndex":0,"channel":"assistant","text":"Claude traced "})),
        fixture_event(&mut event_seq, turn_id, "lane.chunk", json!({"laneId":"lane-codex","streamId":"stream-codex","agent":"codex","streamSeq":"1","chunkIndex":0,"channel":"assistant","text":"Codex verified "})),
        fixture_event(&mut event_seq, turn_id, "lane.chunk", json!({"laneId":"lane-claude","streamId":"stream-claude","agent":"claude","streamSeq":"2","chunkIndex":1,"channel":"assistant","text":"the protocol."})),
        fixture_event(&mut event_seq, turn_id, "lane.chunk", json!({"laneId":"lane-gemini","streamId":"stream-gemini","agent":"gemini","streamSeq":"1","chunkIndex":0,"channel":"assistant","text":"Gemini is still inspecting the pager bridge..."})),
        fixture_event(&mut event_seq, turn_id, "lane.activity", json!({"laneId":"lane-gemini","streamId":"stream-gemini","agent":"gemini","toolCallId":"tool-gemini-1","update":"tool_call","title":"Inspecting pager bridge","kind":"read","status":"in_progress"})),
        fixture_event(&mut event_seq, turn_id, "message.committed", json!({"laneId":"lane-claude","agent":"claude","messageId":"msg-claude-1","ledgerSeq":"2","text":"Claude traced the protocol.","origin":"operator","hopIndex":0})),
        fixture_event(&mut event_seq, turn_id, "lane.completed", json!({"laneId":"lane-claude","streamId":"stream-claude","agent":"claude"})),
        fixture_event(&mut event_seq, turn_id, "message.committed", json!({"laneId":"lane-codex","agent":"codex","messageId":"msg-codex-1","ledgerSeq":"3","text":"Codex verified deterministic replay.","origin":"operator","hopIndex":0})),
        fixture_event(&mut event_seq, turn_id, "lane.completed", json!({"laneId":"lane-codex","streamId":"stream-codex","agent":"codex"})),
        fixture_event(&mut event_seq, turn_id, "permission.requested", json!({"askId":"ask-gemini-1","agent":"gemini","options":[{"optionId":"opt_7F3A","kind":"allow_once","name":"Allow once"},{"optionId":"opt_B91C","kind":"reject_once","name":"Deny"}]})),
    ]);
    events
}

#[cfg(feature = "room-visual-fixture")]
fn fixture_event(
    event_seq: &mut u64,
    turn_id: &str,
    kind: &str,
    payload: serde_json::Value,
) -> zer0_room_protocol::RoomEvent {
    let sequence = *event_seq;
    *event_seq += 1;
    zer0_room_protocol::RoomEvent::from_value(json!({
        "protocol": "zer0.room", "version": 1, "sessionId": "fixture-room-1",
        "eventSeq": sequence.to_string(), "eventId": format!("fixture-event-{sequence}"),
        "turnId": turn_id, "occurredAt": "2026-08-01T00:00:00Z", "type": kind, "payload": payload,
    }))
    .expect("visual fixture emits protocol-valid deterministic events")
}

/// Run the real pager room loop while bridging only explicit Zer0 protocol
/// inputs and immutable host snapshots across the crate boundary.
pub async fn run(
    client: HostClient,
    session_id: String,
) -> Result<room_runtime::RoomRuntimeExit, HostError> {
    // Catalog discovery is presentation-only. An older host, a slow disk, or
    // one malformed custom command must never prevent the real room and its
    // provider lanes from opening.
    let catalog = client
        .request(
            "zer0/room/catalog",
            json!({"sessionId": session_id}),
            CATALOG_TIMEOUT,
        )
        .await
        .ok()
        .and_then(|value| {
            xai_grok_pager::room_composer_menu::RoomCatalogSnapshot::from_host_value(&value).ok()
        })
        .unwrap_or_default();
    let (update_tx, update_rx) = mpsc::channel(32);
    let (command_tx, mut command_rx) = mpsc::channel(16);
    // Small on purpose. Its consumer does one thing and never blocks on anything
    // else, so a backlog here means the HOST is not answering — and in that state
    // the honest response is to stop stacking copies of the same ask, which is
    // what the room's `try_send` does with a full channel.
    let (cancel_tx, mut cancel_rx) = mpsc::channel(4);
    let mut events = client.subscribe_events();

    // Slice A: boot readiness, DETACHED and never awaited before `run_room`.
    //
    // Same fail-soft discipline the catalog above uses — a timeout, `.ok()`, a malformed response
    // yielding nothing — but delivered on the update channel instead of by value, because the probe
    // spawns a CLI and the room may not wait for one. The room starts with every agent `Unknown`,
    // which renders identically to `Ready`, so the first frame is byte-identical to what it was
    // before any probe existed. That is the whole point: the entrance cannot be delayed by a
    // subprocess.
    //
    // The task is spawned rather than awaited and its handle is dropped: if the room closes first the
    // send fails and the task ends, which is the same lifetime the picker requests already have.
    let readiness_client = client.clone();
    let readiness_updates = update_tx.clone();
    let readiness_session = session_id.clone();
    tokio::spawn(async move {
        let readiness = readiness_client
            .request(
                "zer0/room/agents",
                json!({"sessionId": readiness_session}),
                READINESS_TIMEOUT,
            )
            .await
            .ok()
            .and_then(|value| xai_grok_pager::room_agents::readiness_from_host_value(&value).ok())
            .unwrap_or_default();
        let _ = readiness_updates
            .send(room_runtime::RoomUpdate::AgentReadiness(readiness))
            .await;
    });

    let updates_client = client.clone();
    let event_updates = update_tx.clone();
    let updates = tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(HostEvent::Room(event)) => {
                    if event_updates
                        .send(room_runtime::RoomUpdate::Event(event))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
                Ok(HostEvent::Readiness(_)) => {}
                Ok(HostEvent::Exited(exit)) => {
                    // The room's ONLY reader of a host death, and until 2026-09-12 it forwarded
                    // `exit.code` alone — `room host exited: Some(1)`, which is what
                    // `TerminateJobObject` hands out for a host m0irai killed AND what a host that
                    // crashed reports, with an empty stderr either way. That indistinguishability is
                    // FL-143, and it is why the finding read as a host defect for three weeks. The
                    // launcher now says which, in `HostExit`'s own words.
                    //
                    // `ended_itself_cleanly` requires BOTH that the host ended itself and that it
                    // reported success. A terminate the launcher recorded is never clean here even
                    // when the exit code is the host's own: the only branch that can fire while the
                    // room is still running is the transport-failure reap, and by then the event
                    // stream this room reads is already gone, so the room cannot continue and the
                    // operator has to be told. `cli::run_room` asks the same question of the same
                    // method, which is why it is a method and not a condition written twice.
                    let _ = event_updates
                        .send(room_runtime::RoomUpdate::HostExited {
                            clean: exit.ended_itself_cleanly(),
                            sentence: exit.to_string(),
                        })
                        .await;
                    return;
                }
                Err(HostEventReceiveError::Lagged {
                    last_delivered_event_seq,
                }) => {
                    let frontier = last_delivered_event_seq.as_deref().unwrap_or("0");
                    match updates_client.resync(frontier, RESYNC_TIMEOUT).await {
                        Ok(replay) => {
                            for event in replay {
                                if event_updates
                                    .send(room_runtime::RoomUpdate::Event(event))
                                    .await
                                    .is_err()
                                {
                                    return;
                                }
                            }
                        }
                        Err(error) => {
                            let _ = event_updates
                                .send(room_runtime::RoomUpdate::Failed(format!(
                                    "room event replay failed after receiver lag: {error}"
                                )))
                                .await;
                            return;
                        }
                    }
                }
                Err(HostEventReceiveError::Closed) => {
                    let _ = event_updates
                        .send(room_runtime::RoomUpdate::Failed(
                            "room host event stream closed".into(),
                        ))
                        .await;
                    return;
                }
            }
        }
    });

    let command_updates = update_tx.clone();
    let commands_client = client.clone();
    let command_session_id = session_id.clone();
    let commands = tokio::spawn(async move {
        let requester = HostRoomCommandRequester {
            client: commands_client,
        };
        run_command_bridge(
            requester,
            &command_session_id,
            &mut command_rx,
            &command_updates,
        )
        .await;
    });

    // The panic button's own bridge, and the reason it exists: `run_command_bridge`
    // awaits one host RPC before it will dequeue the next command, and a mode
    // cycle is allowed `MODE_CYCLE_TIMEOUT` — 130 seconds. A cancel behind one is
    // not slow, it is unstarted, while the room paints a row about it. This task
    // has one job and nothing can queue in front of it.
    let cancel_updates = update_tx.clone();
    let cancels_client = client.clone();
    let cancel_session_id = session_id.clone();
    let cancels = tokio::spawn(async move {
        let requester = HostRoomCommandRequester {
            client: cancels_client,
        };
        run_cancel_bridge(
            requester,
            &cancel_session_id,
            &mut cancel_rx,
            &cancel_updates,
        )
        .await;
    });

    let input = room_runtime::RoomRuntimeInput {
        version: crate::cli::version_text(),
        current_session_id: session_id,
        reducer: reducer_snapshot(&client),
        catalog,
        updates: update_rx,
        commands: command_tx,
        cancels: cancel_tx,
    };
    let result = room_runtime::run_room(input)
        .await
        .map_err(|error| HostError::Startup(format!("Grok pager room failed: {error:#}")));

    // ⚠ **Drained, not aborted, and the asymmetry with the two `abort()` calls
    // below is the whole point.** `run_room` has returned, so it has dropped both
    // senders and this task will finish whatever it is holding and stop by
    // itself. Aborting it instead DISCARDS a cancel the operator has already been
    // told about: the fast second Ctrl+C that ends the room arrives while the
    // first one's request is still in flight, and the room would exit having
    // promised to stop agents it never told. When nothing is in flight this
    // returns immediately.
    if tokio::time::timeout(CANCEL_DRAIN_TIMEOUT, cancels)
        .await
        .is_err()
    {
        // The terminal is restored by this point, so this is visible. Said
        // plainly because the operator's next question is whether their agents
        // are still running.
        eprintln!(
            "zer0: exited before the host confirmed the cancel ({}s). Host shutdown \
             stops the agent processes next; if any survive, stop them with your \
             process manager.",
            CANCEL_DRAIN_TIMEOUT.as_secs()
        );
    }
    updates.abort();
    commands.abort();
    result
}

/// The panic button's bridge: room-wide cancels, and nothing else.
///
/// Two properties the ordinary bridge cannot give this traffic:
///
/// 1. **Nothing queues in front of it.** `run_command_bridge` awaits one host
///    RPC before dequeuing the next command, and a mode cycle is allowed 130
///    seconds. This loop's only traffic is cancels.
/// 2. **It answers back.** The room says `agents stopped` only after
///    `RoomUpdate::CancelReachedHost` arrives, so the ack is not telemetry — it
///    is the evidence that sentence rests on, and it is sent only when the host
///    returned success. A failed cancel produces a notice and NO ack, so the
///    room goes on saying `stopping agents` rather than claiming something that
///    did not happen.
///
/// A failure is never fatal to the room. The operator is mid-panic; taking the
/// room down under them because one cancel RPC was rejected replaces a stuck
/// agent with a dead session.
async fn run_cancel_bridge<R>(
    requester: R,
    session_id: &str,
    cancel_rx: &mut mpsc::Receiver<room_runtime::RoomCancelAll>,
    updates: &mpsc::Sender<room_runtime::RoomUpdate>,
) where
    R: RoomCommandRequester + Clone + Send + Sync + 'static,
{
    while let Some(request) = cancel_rx.recv().await {
        let params = control_params(
            session_id,
            room_runtime::RoomControlCommand::Cancel,
            Some(room_runtime::RoomCancelScope::All),
            None,
        );
        match requester
            .request("zer0/room/control", params, SUBMIT_TIMEOUT)
            .await
        {
            Ok(_) => {
                if updates
                    .send(room_runtime::RoomUpdate::CancelReachedHost { seq: request.seq })
                    .await
                    .is_err()
                {
                    return;
                }
            }
            Err(error) => {
                let message = command_failure_message("zer0/room/control", &error);
                if updates
                    .send(room_runtime::RoomUpdate::Notice(message))
                    .await
                    .is_err()
                {
                    return;
                }
            }
        }
    }
}

async fn run_command_bridge<R>(
    requester: R,
    session_id: &str,
    command_rx: &mut mpsc::Receiver<room_runtime::RoomCommand>,
    updates: &mpsc::Sender<room_runtime::RoomUpdate>,
) where
    R: RoomCommandRequester + Clone + Send + Sync + 'static,
{
    let mut picker_tasks = JoinSet::new();
    while let Some(command) = command_rx.recv().await {
        if matches!(command, room_runtime::RoomCommand::CancelPicker) {
            picker_tasks.abort_all();
            while picker_tasks.try_join_next().is_some() {}
            continue;
        }
        if let room_runtime::RoomCommand::Picker(request) = command {
            picker_tasks.abort_all();
            while picker_tasks.try_join_next().is_some() {}
            let picker_requester = requester.clone();
            let picker_session_id = session_id.to_owned();
            let picker_updates = updates.clone();
            picker_tasks.spawn(async move {
                run_picker_request(
                    &picker_requester,
                    &picker_session_id,
                    request,
                    &picker_updates,
                )
                .await;
            });
            continue;
        }
        let timeout = room_command_timeout(&command);
        // FL-126: kept across the RPC so the answer can be matched to its own
        // question. This loop already awaits each request before dequeuing the
        // next, so nothing here races anything; the id exists because two OTHER
        // submits — `/council` and one the host rejects — made arrival order an
        // unusable way to say which prompt a turn belongs to.
        let submission = submission_of(&command);
        let (method, params) = room_command_request(session_id, command);
        match requester.request(method, params, timeout).await {
            Ok(value) => {
                if let Some(submission) = submission {
                    let turn = submitted_turn_id(&value);
                    if turn.is_none() {
                        // A submit the host ACCEPTED without naming a turn is
                        // protocol drift, not a refusal, and the room is about
                        // to silently drop the prompt it was holding. Say so.
                        let _ = updates
                            .send(room_runtime::RoomUpdate::Notice(
                                "room host accepted a submit without naming a turn; the prompt was not kept for a cancel"
                                    .to_owned(),
                            ))
                            .await;
                    }
                    if updates
                        .send(room_runtime::RoomUpdate::SubmitSettled { submission, turn })
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
            Err(error) => {
                let message = command_failure_message(method, &error);
                // Before the notice, and unconditionally: a refused submit
                // never becomes a turn, so the prompt the room is holding for
                // it must be released rather than left for the next turn to
                // claim. Sent even on the fatal path -- the room may still
                // paint one last frame.
                if let Some(submission) = submission {
                    let _ = updates
                        .send(room_runtime::RoomUpdate::SubmitSettled {
                            submission,
                            turn: None,
                        })
                        .await;
                }
                if command_failure_is_recoverable(&error) {
                    if updates
                        .send(room_runtime::RoomUpdate::Notice(message))
                        .await
                        .is_err()
                    {
                        break;
                    }
                    continue;
                }
                let _ = updates
                    .send(room_runtime::RoomUpdate::Failed(message))
                    .await;
                break;
            }
        }
    }
    picker_tasks.abort_all();
    while picker_tasks.join_next().await.is_some() {}
}

/// The submission id a command carries, if it is one that holds a prompt.
///
/// `Submit` is the only variant that does. Written as a match with no wildcard
/// on purpose: a future command that also holds a prompt should fail to compile
/// here rather than silently strand an entry.
fn submission_of(command: &room_runtime::RoomCommand) -> Option<SubmissionId> {
    match command {
        room_runtime::RoomCommand::Submit { submission, .. } => Some(*submission),
        room_runtime::RoomCommand::CycleMode { .. }
        | room_runtime::RoomCommand::Control { .. }
        | room_runtime::RoomCommand::PermissionResponse(_)
        | room_runtime::RoomCommand::Picker(_)
        | room_runtime::RoomCommand::CancelPicker => None,
    }
}

/// The turn id out of a `zer0/room/submit` response.
///
/// The host returns it as `turnId` (`src/room/room-host.ts`, `submit`'s return,
/// forwarded verbatim by `zer0-v2-host.ts`). A response without one is drift and
/// is reported by the caller rather than papered over with a default.
fn submitted_turn_id(value: &serde_json::Value) -> Option<String> {
    value
        .get("turnId")
        .and_then(serde_json::Value::as_str)
        .filter(|turn| !turn.is_empty())
        .map(str::to_owned)
}

fn command_failure_is_recoverable(error: &HostError) -> bool {
    matches!(
        error,
        HostError::InvalidArgument(_) | HostError::Remote(_) | HostError::RequestTimedOut(_)
    )
}

fn room_command_timeout(command: &room_runtime::RoomCommand) -> Duration {
    match command {
        room_runtime::RoomCommand::CycleMode { .. } => MODE_CYCLE_TIMEOUT,
        _ => SUBMIT_TIMEOUT,
    }
}

async fn run_picker_request<R: RoomCommandRequester>(
    requester: &R,
    session_id: &str,
    request: xai_grok_pager::room_picker::RoomPickerRequest,
    updates: &mpsc::Sender<room_runtime::RoomUpdate>,
) {
    use xai_grok_pager::room_picker::{RoomModelCatalog, RoomPickerRequest, parse_room_sessions};

    let update = match request {
        RoomPickerRequest::Models { request_id, agent } => {
            let result = requester
                .request(
                    "zer0/room/models",
                    json!({"sessionId":session_id,"agent":agent.name()}),
                    MODEL_PICKER_TIMEOUT,
                )
                .await
                .map_err(|error| command_failure_message("zer0/room/models", &error))
                .and_then(|value| RoomModelCatalog::from_host_value(&value));
            room_runtime::RoomUpdate::PickerModels { request_id, result }
        }
        RoomPickerRequest::SelectModel {
            request_id,
            agent,
            model_id,
        } => {
            let result = requester
                .request(
                    "zer0/room/model_select",
                    json!({"sessionId":session_id,"agent":agent.name(),"modelId":model_id}),
                    MODEL_PICKER_TIMEOUT,
                )
                .await
                .map_err(|error| command_failure_message("zer0/room/model_select", &error))
                .and_then(|value| RoomModelCatalog::from_host_value(&value));
            room_runtime::RoomUpdate::PickerModels { request_id, result }
        }
        RoomPickerRequest::Sessions { request_id } => {
            let result = requester
                .request("session/list", json!({}), SESSION_PICKER_TIMEOUT)
                .await
                .map_err(|error| command_failure_message("session/list", &error))
                .and_then(|value| parse_room_sessions(&value));
            room_runtime::RoomUpdate::PickerSessions { request_id, result }
        }
    };
    let _ = updates.send(update).await;
}

fn room_command_request(
    session_id: &str,
    command: room_runtime::RoomCommand,
) -> (&'static str, serde_json::Value) {
    match command {
        room_runtime::RoomCommand::Submit { text, .. } => (
            "zer0/room/submit",
            json!({"sessionId": session_id, "text": text}),
        ),
        room_runtime::RoomCommand::CycleMode { composer_text } => (
            "zer0/room/mode_cycle",
            json!({"sessionId": session_id, "text": composer_text}),
        ),
        room_runtime::RoomCommand::Control {
            command,
            scope,
            agent,
        } => (
            "zer0/room/control",
            control_params(session_id, command, scope, agent),
        ),
        room_runtime::RoomCommand::PermissionResponse(action) => (
            "zer0/room/permission_response",
            permission_response_params(session_id, action),
        ),
        room_runtime::RoomCommand::Picker(_) | room_runtime::RoomCommand::CancelPicker => {
            unreachable!("picker requests use the nonfatal picker bridge")
        }
    }
}

fn permission_response_params(
    session_id: &str,
    action: xai_grok_pager::room_permission_view::RoomPermissionAction,
) -> serde_json::Value {
    match action {
        xai_grok_pager::room_permission_view::RoomPermissionAction::SelectOption {
            ask_id,
            option_id,
        } => json!({"sessionId": session_id, "askId": ask_id, "optionId": option_id}),
        xai_grok_pager::room_permission_view::RoomPermissionAction::Deny { ask_id } => {
            json!({"sessionId": session_id, "askId": ask_id, "decision": "deny"})
        }
    }
}

fn command_failure_message(method: &str, error: &HostError) -> String {
    let reason = match error {
        HostError::AdmissionClosed => "host is not accepting room commands",
        HostError::Frame(_) => "host transport rejected a protocol frame",
        HostError::InvalidArgument(_) => "host rejected room command parameters",
        HostError::Io(_) => "host I/O failed",
        HostError::Remote(_) => "host rejected the room command",
        HostError::RequestTimedOut(_) => "host request timed out",
        HostError::Startup(_) => "host startup failed",
        // Unreachable in practice — a startup stall is raised before a room exists, and this formats
        // failures of an ATTACHED room's commands — but named rather than defaulted, so the next
        // variant added to `HostError` still fails the build here instead of being mislabelled.
        HostError::StartupStalled(_) => "host startup stalled",
        HostError::Stopped(_) => "host stopped",
    };
    format!("room command {method} failed: {reason}")
}

fn reducer_snapshot(client: &HostClient) -> RoomReducer {
    client.room_snapshot()
}

fn control_command(command: room_runtime::RoomControlCommand) -> &'static str {
    match command {
        room_runtime::RoomControlCommand::Pause => "pause",
        room_runtime::RoomControlCommand::Resume => "resume",
        room_runtime::RoomControlCommand::Cancel => "cancel",
    }
}

fn cancel_scope(scope: room_runtime::RoomCancelScope) -> &'static str {
    match scope {
        room_runtime::RoomCancelScope::Latest => "latest",
        room_runtime::RoomCancelScope::All => "all",
        room_runtime::RoomCancelScope::Agent => "agent",
    }
}

fn control_params(
    session_id: &str,
    command: room_runtime::RoomControlCommand,
    scope: Option<room_runtime::RoomCancelScope>,
    agent: Option<String>,
) -> serde_json::Value {
    let mut params = json!({"sessionId": session_id, "command": control_command(command)});
    let object = params.as_object_mut().expect("literal is an object");
    if let Some(scope) = scope {
        object.insert("scope".into(), json!(cancel_scope(scope)));
    }
    if let Some(agent) = agent {
        object.insert("agent".into(), json!(agent));
    }
    params
}

#[cfg(test)]
mod tests {
    use std::{
        future::Future,
        pin::Pin,
        sync::{Arc, Mutex},
        time::Duration,
    };

    use serde_json::{Value, json};
    use tokio::sync::{Notify, mpsc};
    use xai_grok_pager::{
        room_composer_menu::RoomCatalogAgent,
        room_permission_view::RoomPermissionAction,
        room_picker::RoomPickerRequest,
        room_runtime::{RoomCommand, RoomUpdate},
    };

    use super::{
        MODE_CYCLE_TIMEOUT, RoomCommandRequester, command_failure_message,
        permission_response_params, reducer_snapshot, room_command_request, room_command_timeout,
        run_cancel_bridge, run_command_bridge, run_picker_request,
    };
    use crate::host_process::HostError;
    use xai_grok_pager::room_prompt_restore::SubmissionId;
    use xai_grok_pager::room_runtime::RoomCancelAll;

    #[derive(Clone)]
    struct ControlledRequester {
        calls: Arc<Mutex<Vec<(&'static str, Value, Duration)>>>,
        result: Result<Value, HostError>,
    }

    impl RoomCommandRequester for ControlledRequester {
        fn request<'a>(
            &'a self,
            method: &'static str,
            params: Value,
            timeout: Duration,
        ) -> Pin<Box<dyn Future<Output = Result<Value, HostError>> + Send + 'a>> {
            self.calls.lock().unwrap().push((method, params, timeout));
            Box::pin(async move { self.result.clone() })
        }
    }

    #[test]
    fn production_cli_enters_the_actual_grok_pager_room_loop() {
        let cli = include_str!("cli.rs");
        let manifest = include_str!("../Cargo.toml");
        assert!(cli.contains("crate::pager_room::run(host.client(), session_id).await"));
        assert!(cli.contains("RoomRuntimeExit::LoadSession(session_id)"));
        assert!(cli.contains("startup = RoomStartup::New"));
        assert!(!cli.contains("crate::ui::run("));
        assert!(!cli.contains("InlineTerminal"));
        assert!(manifest.contains("default = [\"grok-pager-room\"]"));
        // The quarantined local TUI is not merely non-default any more: Phase 4
        // deleted src/ui/ and both features that reached it. Pin the stronger
        // property so a re-introduction has to change this test on purpose.
        assert!(!manifest.contains("quarantined-local-ui"));
        assert!(!manifest.contains("terminal-ui"));
        assert!(
            !std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("src")
                .join("ui")
                .exists()
        );
        let _ = reducer_snapshot
            as fn(&crate::host_process::HostClient) -> zer0_room_protocol::RoomReducer;
    }

    #[test]
    fn permission_payloads_preserve_normal_opaque_ids_and_deny_without_an_option_id() {
        let selected = permission_response_params(
            "session-1",
            RoomPermissionAction::SelectOption {
                ask_id: "ask-1".into(),
                option_id: "  opaque-option\t".into(),
            },
        );
        assert_eq!(
            selected,
            json!({"sessionId":"session-1","askId":"ask-1","optionId":"  opaque-option\t"})
        );

        let denied = permission_response_params(
            "session-1",
            RoomPermissionAction::Deny {
                ask_id: "ask-2".into(),
            },
        );
        assert_eq!(
            denied,
            json!({"sessionId":"session-1","askId":"ask-2","decision":"deny"})
        );
        assert!(denied.get("optionId").is_none());
    }

    #[test]
    fn shift_tab_mode_cycle_preserves_the_current_composer_text_in_one_dedicated_rpc() {
        let command = RoomCommand::CycleMode {
            composer_text: "@codex inspect this".into(),
        };
        assert_eq!(room_command_timeout(&command), MODE_CYCLE_TIMEOUT);
        let (method, params) = room_command_request("session-1", command);
        assert_eq!(method, "zer0/room/mode_cycle");
        assert_eq!(
            params,
            json!({"sessionId":"session-1","text":"@codex inspect this"})
        );
    }

    #[tokio::test]
    async fn recoverable_command_failure_is_shown_without_stopping_later_commands() {
        let requester = ControlledRequester {
            calls: Arc::new(Mutex::new(Vec::new())),
            result: Err(HostError::Remote("\x1b[2Juntrusted host detail".into())),
        };
        let observed = requester.clone();
        let (command_tx, mut command_rx) = mpsc::channel(2);
        let (update_tx, mut update_rx) = mpsc::channel(2);
        let bridge = tokio::spawn(async move {
            run_command_bridge(requester, "session-1", &mut command_rx, &update_tx).await;
        });

        for (index, text) in ["first command", "second command"].into_iter().enumerate() {
            let submission = SubmissionId::synthetic(index as u64);
            command_tx
                .send(RoomCommand::Submit {
                    submission,
                    text: text.into(),
                })
                .await
                .unwrap();
            // TWO updates per refused submit, in this order, and the order is
            // the point. FL-126 has the room holding the submitted prompt
            // against a possible cancel; a submit the host REFUSES never
            // becomes a turn, so that prompt has to be released or the NEXT
            // turn's cancel hands it back instead of its own text. Released
            // first, then the notice, so a room that stops reading after the
            // notice has already been told.
            let released = tokio::time::timeout(Duration::from_secs(1), update_rx.recv())
                .await
                .expect("a refused submit must wake the runtime")
                .expect("command bridge must release the held prompt");
            assert!(
                matches!(
                    released,
                    RoomUpdate::SubmitSettled { submission: settled, turn: None }
                        if settled == submission
                ),
                "the refused submission must be released by its own id, got {released:?}"
            );
            let update = tokio::time::timeout(Duration::from_secs(1), update_rx.recv())
                .await
                .expect("command RPC failure must wake the runtime")
                .expect("command bridge must publish a recoverable notice");
            assert!(matches!(
                update,
                RoomUpdate::Notice(message)
                    if message == "room command zer0/room/submit failed: host rejected the room command"
            ));
        }
        drop(command_tx);
        bridge.await.unwrap();
        assert_eq!(
            observed.calls.lock().unwrap().clone(),
            vec![
                (
                    "zer0/room/submit",
                    json!({"sessionId":"session-1","text":"first command"}),
                    super::SUBMIT_TIMEOUT,
                ),
                (
                    "zer0/room/submit",
                    json!({"sessionId":"session-1","text":"second command"}),
                    super::SUBMIT_TIMEOUT,
                ),
            ]
        );
        assert!(
            !command_failure_message(
                "zer0/room/submit",
                &HostError::Remote("\x1b[2Juntrusted host detail".into()),
            )
            .contains("untrusted host detail")
        );
    }

    #[tokio::test]
    async fn picker_rpc_returns_strict_provider_data_without_terminating_the_room() {
        let requester = ControlledRequester {
            calls: Arc::new(Mutex::new(Vec::new())),
            result: Ok(json!({
                "version":1,
                "agent":"codex",
                "currentModelId":"gpt-5.6-codex",
                "models":[{"id":"gpt-5.6-codex","label":"GPT-5.6 Codex"}]
            })),
        };
        let (update_tx, mut update_rx) = mpsc::channel(1);
        run_picker_request(
            &requester,
            "session-1",
            RoomPickerRequest::Models {
                request_id: 7,
                agent: RoomCatalogAgent::Codex,
            },
            &update_tx,
        )
        .await;

        assert!(matches!(
            update_rx.recv().await,
            Some(RoomUpdate::PickerModels { request_id: 7, result: Ok(catalog) })
                if catalog.agent == RoomCatalogAgent::Codex
                    && catalog.current_model_id.as_deref() == Some("gpt-5.6-codex")
        ));
        assert_eq!(
            requester.calls.lock().unwrap().clone(),
            vec![(
                "zer0/room/models",
                json!({"sessionId":"session-1","agent":"codex"}),
                super::MODEL_PICKER_TIMEOUT,
            )]
        );
    }

    #[derive(Clone)]
    struct DelayedPickerRequester {
        calls: Arc<Mutex<Vec<&'static str>>>,
        picker_started: Arc<Notify>,
        release_picker: Arc<Notify>,
    }

    impl RoomCommandRequester for DelayedPickerRequester {
        fn request<'a>(
            &'a self,
            method: &'static str,
            _params: Value,
            _timeout: Duration,
        ) -> Pin<Box<dyn Future<Output = Result<Value, HostError>> + Send + 'a>> {
            self.calls.lock().unwrap().push(method);
            Box::pin(async move {
                if method == "zer0/room/models" {
                    self.picker_started.notify_one();
                    self.release_picker.notified().await;
                    return Ok(json!({
                        "version":1,
                        "agent":"codex",
                        "models":[{"id":"gpt-5.6-codex","label":"GPT-5.6 Codex"}]
                    }));
                }
                if method == "zer0/room/submit" {
                    // What the real host returns (`src/room/room-host.ts`,
                    // `submit`). A fixture that answered {} would exercise the
                    // protocol-drift branch instead of the ordinary one.
                    return Ok(json!({"turnId": "turn-7"}));
                }
                Ok(json!({}))
            })
        }
    }

    /// A host that ACCEPTS a submit without naming a turn is protocol drift,
    /// not a refusal, and the room is about to drop the prompt it was holding.
    ///
    /// Both halves are asserted because either alone is a defect: releasing the
    /// prompt silently loses it with no signal, and a notice without the
    /// release leaves the entry to be claimed by the next turn's cancel
    /// (FL-126). `ControlledRequester` is given `{}` as its answer, which is
    /// exactly the drift shape.
    #[tokio::test]
    async fn a_submit_accepted_without_a_turn_id_is_reported_and_released() {
        let requester = ControlledRequester {
            calls: Arc::new(Mutex::new(Vec::new())),
            // An empty object: accepted, with no turnId. Exactly the drift.
            result: Ok(json!({})),
        };
        let (command_tx, mut command_rx) = mpsc::channel(2);
        let (update_tx, mut update_rx) = mpsc::channel(4);
        let bridge = tokio::spawn(async move {
            run_command_bridge(requester, "session-1", &mut command_rx, &update_tx).await;
        });

        let submission = SubmissionId::synthetic(42);
        command_tx
            .send(RoomCommand::Submit {
                submission,
                text: "a prompt whose turn is never named".into(),
            })
            .await
            .unwrap();

        let drift = tokio::time::timeout(Duration::from_secs(1), update_rx.recv())
            .await
            .expect("drift must wake the runtime")
            .expect("the bridge must say the response named no turn");
        assert!(
            matches!(drift, RoomUpdate::Notice(ref message) if message.contains("without naming a turn")),
            "protocol drift is reported, not papered over, got {drift:?}"
        );

        let released = tokio::time::timeout(Duration::from_secs(1), update_rx.recv())
            .await
            .expect("the release must follow")
            .expect("the bridge must release the held prompt");
        assert!(
            matches!(
                released,
                RoomUpdate::SubmitSettled { submission: settled, turn: None }
                    if settled == submission
            ),
            "and the prompt is released by its own id, got {released:?}"
        );

        drop(command_tx);
        bridge.await.unwrap();
    }

    #[tokio::test]
    async fn a_slow_picker_does_not_block_commands_and_can_be_cancelled() {
        let requester = DelayedPickerRequester {
            calls: Arc::new(Mutex::new(Vec::new())),
            picker_started: Arc::new(Notify::new()),
            release_picker: Arc::new(Notify::new()),
        };
        let observed = requester.clone();
        let (command_tx, mut command_rx) = mpsc::channel(2);
        let (update_tx, mut update_rx) = mpsc::channel(2);
        let bridge = tokio::spawn(async move {
            run_command_bridge(requester, "session-1", &mut command_rx, &update_tx).await;
        });

        command_tx
            .send(RoomCommand::Picker(RoomPickerRequest::Models {
                request_id: 9,
                agent: RoomCatalogAgent::Codex,
            }))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), observed.picker_started.notified())
            .await
            .expect("picker request must start");
        command_tx
            .send(RoomCommand::Submit {
                submission: SubmissionId::synthetic(2),
                text: "continue while picker loads".into(),
            })
            .await
            .unwrap();

        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if observed.calls.lock().unwrap().contains(&"zer0/room/submit") {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("submit must bypass the pending picker request");

        // The accepted submit publishes the turn it became (FL-126), so this
        // wire is no longer expected to be silent. Asserted explicitly rather
        // than skipped: narrowing the question below to "no PICKER result"
        // would otherwise hide a bridge that had stopped publishing anything.
        let settled = tokio::time::timeout(Duration::from_secs(1), update_rx.recv())
            .await
            .expect("an accepted submit must wake the runtime")
            .expect("command bridge must name the turn the submit became");
        assert!(
            matches!(
                settled,
                RoomUpdate::SubmitSettled { turn: Some(ref turn), .. } if turn == "turn-7"
            ),
            "the submit's own response carries its turn id, got {settled:?}"
        );

        command_tx.send(RoomCommand::CancelPicker).await.unwrap();
        observed.release_picker.notify_one();
        // Unchanged in subject: a dismissed picker must not publish its late
        // result. Only the shape moved, because the wire now legitimately
        // carries something else.
        let late = tokio::time::timeout(Duration::from_millis(50), update_rx.recv()).await;
        assert!(
            !matches!(
                late,
                Ok(Some(
                    RoomUpdate::PickerModels { .. } | RoomUpdate::PickerSessions { .. }
                ))
            ),
            "a dismissed picker must not publish its late result, got {late:?}"
        );
        drop(command_tx);
        bridge.await.unwrap();
    }

    #[cfg(feature = "room-visual-fixture")]
    #[test]
    fn visual_fixture_replays_through_the_same_reducer_with_opaque_permission_ids() {
        let mut reducer = zer0_room_protocol::RoomReducer::new();
        let events = super::fixture_events();
        assert_eq!(events.len(), 18);
        for event in &events {
            reducer
                .apply(event)
                .expect("fixture event must be reducer-valid");
        }
        let permission = reducer
            .permission("ask-gemini-1")
            .expect("fixture retains the pending permission");
        assert_eq!(permission.ask_id, "ask-gemini-1");
        assert_eq!(permission.options[0].option_id, "opt_7F3A");
        assert!(permission.outcome.is_none());
    }

    /// A requester that parks the first `zer0/room/mode_cycle` until released,
    /// recording every method it is asked for.
    ///
    /// Not a contrivance: `MODE_CYCLE_TIMEOUT` is **130 seconds**, and
    /// `room_command_timeout` hands it to every `CycleMode`, because one mode
    /// request can join a bounded eager ACP handshake and then perform a
    /// provider mode mutation. Parking one is the deterministic stand-in for the
    /// two minutes a real one is allowed to take.
    #[derive(Clone)]
    struct ParkedModeRequester {
        calls: Arc<Mutex<Vec<&'static str>>>,
        mode_started: Arc<Notify>,
        release_mode: Arc<Notify>,
    }

    impl RoomCommandRequester for ParkedModeRequester {
        fn request<'a>(
            &'a self,
            method: &'static str,
            _params: Value,
            _timeout: Duration,
        ) -> Pin<Box<dyn Future<Output = Result<Value, HostError>> + Send + 'a>> {
            self.calls.lock().unwrap().push(method);
            Box::pin(async move {
                if method == "zer0/room/mode_cycle" {
                    self.mode_started.notify_one();
                    self.release_mode.notified().await;
                }
                Ok(json!({}))
            })
        }
    }

    impl ParkedModeRequester {
        fn new() -> Self {
            Self {
                calls: Arc::new(Mutex::new(Vec::new())),
                mode_started: Arc::new(Notify::new()),
                release_mode: Arc::new(Notify::new()),
            }
        }

        async fn wait_for(&self, method: &'static str, within: Duration) -> bool {
            tokio::time::timeout(within, async {
                loop {
                    if self
                        .calls
                        .lock()
                        .unwrap()
                        .iter()
                        .any(|call| *call == method)
                    {
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .is_ok()
        }
    }

    /// [FALSIFIER] BLOCK 2. A room-wide cancel does not wait behind an unrelated
    /// mode RPC.
    ///
    /// The room paints a row about the cancel as soon as it is asked for. A
    /// successful `mpsc::Sender::send` is a local enqueue and nothing more: with
    /// a mode RPC in flight the ordinary bridge is parked inside
    /// `requester.request(...).await` and will not even DEQUEUE the cancel, let
    /// alone dispatch it — for up to `MODE_CYCLE_TIMEOUT`.
    ///
    /// RED against the single-bridge tree, run with the cancel on the command
    /// channel exactly as the room sent it before this fix:
    ///
    /// > the cancel must reach the host while the mode RPC is still in flight;
    /// > calls so far: ["zer0/room/mode_cycle"]
    ///
    /// What wrong implementation would still pass? One that dispatches the
    /// cancel by ABANDONING the mode RPC — no: the mode call is asserted to
    /// still be first, and it is released and completed at the end. One that
    /// simply reorders the whole command stream — no:
    /// `the_ordinary_command_stream_stays_in_order` pins the rest.
    #[tokio::test]
    async fn a_room_wide_cancel_does_not_wait_behind_a_mode_cycle() {
        let requester = ParkedModeRequester::new();
        let observed = requester.clone();
        let (command_tx, mut command_rx) = mpsc::channel(4);
        let (cancel_tx, mut cancel_rx) = mpsc::channel(4);
        let (update_tx, mut update_rx) = mpsc::channel(4);

        let bridge_updates = update_tx.clone();
        let bridge_requester = requester.clone();
        let bridge = tokio::spawn(async move {
            run_command_bridge(
                bridge_requester,
                "session-1",
                &mut command_rx,
                &bridge_updates,
            )
            .await;
        });
        let cancel_requester = requester.clone();
        let cancels = tokio::spawn(async move {
            run_cancel_bridge(cancel_requester, "session-1", &mut cancel_rx, &update_tx).await;
        });

        command_tx
            .send(RoomCommand::CycleMode {
                composer_text: String::new(),
            })
            .await
            .unwrap();
        // Waited on rather than slept past, so the case cannot pass by racing.
        tokio::time::timeout(Duration::from_secs(5), requester.mode_started.notified())
            .await
            .expect("the mode RPC must really be in flight before the cancel is sent");

        cancel_tx.send(RoomCancelAll { seq: 7 }).await.unwrap();

        assert!(
            observed
                .wait_for("zer0/room/control", Duration::from_secs(5))
                .await,
            "the cancel must reach the host while the mode RPC is still parked; \
             calls so far: {:?}",
            observed.calls.lock().unwrap().clone()
        );

        // And the room is told, with the number it asked under — the evidence
        // the `agents stopped` row rests on.
        let update = tokio::time::timeout(Duration::from_secs(5), update_rx.recv())
            .await
            .expect("the cancel bridge must answer the room")
            .expect("with an update, not a closed channel");
        assert!(
            matches!(update, RoomUpdate::CancelReachedHost { seq: 7 }),
            "the acknowledgement must carry the ask it answers, got {update:?}"
        );

        requester.release_mode.notify_one();
        drop(command_tx);
        drop(cancel_tx);
        bridge.await.unwrap();
        cancels.await.unwrap();
        let calls = observed.calls.lock().unwrap().clone();
        assert_eq!(
            calls.first(),
            Some(&"zer0/room/mode_cycle"),
            "the mode RPC was not abandoned to make room: it was still first, and \
             it ran to completion"
        );
    }

    /// [PIN] A cancel the host REJECTS produces a notice and no acknowledgement.
    ///
    /// The acknowledgement is not telemetry — it is the only evidence the room's
    /// `agents stopped` rests on. Sending one for a cancel that failed would put
    /// the sentence back on screen with nothing behind it, which is the defect
    /// this whole block is about. And the failure must not take the room down:
    /// the operator is mid-panic, and replacing a stuck agent with a dead session
    /// is not an improvement.
    ///
    /// MUTATION: send `CancelReachedHost` from the error arm of
    /// `run_cancel_bridge` as well and this goes red.
    #[tokio::test]
    async fn a_rejected_cancel_is_reported_and_never_acknowledged() {
        let requester = ControlledRequester {
            calls: Arc::new(Mutex::new(Vec::new())),
            result: Err(HostError::Remote("host said no".into())),
        };
        let (cancel_tx, mut cancel_rx) = mpsc::channel(4);
        let (update_tx, mut update_rx) = mpsc::channel(4);
        let bridge = tokio::spawn(async move {
            run_cancel_bridge(requester, "session-1", &mut cancel_rx, &update_tx).await;
        });

        cancel_tx.send(RoomCancelAll { seq: 3 }).await.unwrap();
        let update = tokio::time::timeout(Duration::from_secs(1), update_rx.recv())
            .await
            .expect("a rejected cancel must wake the room")
            .expect("with an update");
        assert!(
            matches!(
                &update,
                RoomUpdate::Notice(message)
                    if message == "room command zer0/room/control failed: host rejected the room command"
            ),
            "a rejected cancel is a notice, got {update:?}"
        );

        // The bridge is still alive and still serving: a second ask is taken.
        cancel_tx
            .send(RoomCancelAll { seq: 4 })
            .await
            .expect("one rejected cancel must not close the panic button");
        drop(cancel_tx);
        bridge.await.unwrap();
    }

    /// [PIN] The room-wide cancel carries the scope that actually stops
    /// everything.
    ///
    /// `latest` resolves exactly one turn (`src/room/room-engine.ts:516-520`), so
    /// with two non-terminal turns in flight it leaves the older lane running
    /// underneath the words the room is painting. The dedicated bridge builds
    /// this request itself rather than receiving a `RoomCommand`, so the scope is
    /// now ITS decision and needs its own pin.
    ///
    /// MUTATION: build the params with `RoomCancelScope::Latest` and this goes
    /// red.
    #[tokio::test]
    async fn the_dedicated_cancel_is_room_wide() {
        let requester = ControlledRequester {
            calls: Arc::new(Mutex::new(Vec::new())),
            result: Ok(json!({})),
        };
        let observed = requester.clone();
        let (cancel_tx, mut cancel_rx) = mpsc::channel(4);
        let (update_tx, _update_rx) = mpsc::channel(4);
        let bridge = tokio::spawn(async move {
            run_cancel_bridge(requester, "session-9", &mut cancel_rx, &update_tx).await;
        });

        cancel_tx.send(RoomCancelAll { seq: 1 }).await.unwrap();
        drop(cancel_tx);
        bridge.await.unwrap();

        assert_eq!(
            observed.calls.lock().unwrap().clone(),
            vec![(
                "zer0/room/control",
                json!({"sessionId":"session-9","command":"cancel","scope":"all"}),
                super::SUBMIT_TIMEOUT,
            )],
            "the panic button is room-wide, and it is not allowed the 130-second \
             budget a mode cycle gets"
        );
    }

    /// [PIN] The ordinary command stream is still strictly ordered.
    ///
    /// The fix gave the panic button its own wire; it did not loosen anything
    /// else. Submit-then-mode-cycle-then-submit has to reach the host in that
    /// order, because a submit that overtakes the mode change it was typed after
    /// runs under the wrong mode.
    ///
    /// MUTATION: spawn each command in `run_command_bridge` onto a task instead
    /// of awaiting it — the tempting alternative fix for BLOCK 2 — and this goes
    /// red.
    #[tokio::test]
    async fn the_ordinary_command_stream_stays_in_order() {
        let requester = ParkedModeRequester::new();
        let observed = requester.clone();
        let (command_tx, mut command_rx) = mpsc::channel(8);
        let (update_tx, _update_rx) = mpsc::channel(4);
        let bridge_requester = requester.clone();
        let bridge = tokio::spawn(async move {
            run_command_bridge(bridge_requester, "session-1", &mut command_rx, &update_tx).await;
        });

        command_tx
            .send(RoomCommand::Submit {
                submission: SubmissionId::synthetic(3),
                text: "first".into(),
            })
            .await
            .unwrap();
        command_tx
            .send(RoomCommand::CycleMode {
                composer_text: String::new(),
            })
            .await
            .unwrap();
        command_tx
            .send(RoomCommand::Submit {
                submission: SubmissionId::synthetic(4),
                text: "second".into(),
            })
            .await
            .unwrap();

        tokio::time::timeout(Duration::from_secs(5), requester.mode_started.notified())
            .await
            .expect("the mode RPC must be reached");
        assert_eq!(
            observed.calls.lock().unwrap().clone(),
            vec!["zer0/room/submit", "zer0/room/mode_cycle"],
            "the second submit must NOT have overtaken the parked mode cycle"
        );

        requester.release_mode.notify_one();
        drop(command_tx);
        bridge.await.unwrap();
        assert_eq!(
            observed.calls.lock().unwrap().clone(),
            vec![
                "zer0/room/submit",
                "zer0/room/mode_cycle",
                "zer0/room/submit",
            ]
        );
    }

    /// [PIN] Teardown drains a cancel that is still in flight instead of
    /// dropping it.
    ///
    /// The review's scenario: the operator's first Ctrl+C queues the cancel, the
    /// room arms and paints a row about it, and a fast second Ctrl+C ends the
    /// room while the request is still going. The old teardown called
    /// `commands.abort()`, which discarded the queued cancel outright — the room
    /// exited having told the operator it stopped agents it never told.
    ///
    /// This is the drain in isolation: the room's senders are dropped (which is
    /// what `run_room` returning does), and the bridge is AWAITED rather than
    /// aborted, so the request that was already in flight finishes.
    ///
    /// MUTATION: replace the await with `cancels.abort()` and this goes red —
    /// the control RPC never appears.
    #[tokio::test]
    async fn teardown_drains_a_cancel_that_is_still_in_flight() {
        let requester = ParkedModeRequester::new();
        let observed = requester.clone();
        let (cancel_tx, mut cancel_rx) = mpsc::channel(4);
        let (update_tx, _update_rx) = mpsc::channel(4);
        let bridge_requester = requester.clone();
        let cancels = tokio::spawn(async move {
            run_cancel_bridge(bridge_requester, "session-1", &mut cancel_rx, &update_tx).await;
        });

        // Queued but not yet dequeued, then the room ends and drops its sender.
        cancel_tx.send(RoomCancelAll { seq: 1 }).await.unwrap();
        drop(cancel_tx);

        tokio::time::timeout(super::CANCEL_DRAIN_TIMEOUT, cancels)
            .await
            .expect("the drain must not time out on a host that answers")
            .expect("the cancel bridge must not panic");

        assert_eq!(
            observed.calls.lock().unwrap().clone(),
            vec!["zer0/room/control"],
            "the queued cancel must have been dispatched before the room let go"
        );
    }

    /// [PIN] The room's teardown really is a drain, and really is only for the
    /// cancel wire.
    ///
    /// The test above proves the drain works in isolation; this one proves
    /// production performs it. `run` is not callable without a live host, so the
    /// wiring is read from the source — index-based, because this file is its own
    /// `include_str!` and a `contains` needle finds its own literal.
    #[test]
    fn production_teardown_awaits_the_cancel_bridge_and_aborts_the_others() {
        let source = include_str!("pager_room.rs");
        let run = source
            .find("let result = room_runtime::run_room(input)")
            .expect("the production room call");
        // ⚠ Bounded ABOVE the test module, and that bound is load-bearing.
        // `include_str!` pulls in this file, so a `contains` check over the rest
        // of the source finds the needle written in THIS test and passes with
        // the production code deleted. The first version of the last assertion
        // below did exactly that and failed on its own literal, which is how the
        // bound got written.
        let module = source
            .find("mod tests {")
            .expect("this file's own test module");
        assert!(run < module, "the production call must precede the tests");
        let tail = &source[run..module];
        let drain = tail
            .find("tokio::time::timeout(CANCEL_DRAIN_TIMEOUT, cancels)")
            .expect("teardown must WAIT for the cancel bridge, not abort it");
        let abort_updates = tail
            .find("updates.abort();")
            .expect("the event bridge is still aborted");
        let abort_commands = tail
            .find("commands.abort();")
            .expect("the ordinary command bridge is still aborted");
        assert!(
            drain < abort_updates && drain < abort_commands,
            "the drain must come FIRST: aborting the other bridges tears down the \
             update channel the cancel bridge answers on"
        );
        assert!(
            !tail.contains("cancels.abort()"),
            "a queued cancel dropped at teardown is the room exiting on a promise \
             it did not keep"
        );
    }
}
