use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::{Semaphore, mpsc, oneshot, watch};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        Message,
        client::IntoClientRequest,
        protocol::{CloseFrame, frame::coding::CloseCode},
    },
};
use url::Url;

use super::protocol::{self, HostFrame, RemoteFrame};
use super::{
    AttachmentCallOutcome, AttachmentError, AttachmentEvent, AttachmentStatus, CatalogRevision,
};
use crate::prepared::{PreparedToolCall, PreparedToolError, PreparedToolRuntime};

#[cfg(not(test))]
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(test)]
const HANDSHAKE_TIMEOUT: Duration = Duration::from_millis(100);
#[cfg(not(test))]
const PONG_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(test)]
const PONG_TIMEOUT: Duration = Duration::from_millis(50);

pub(crate) struct Config {
    pub(crate) endpoint: Url,
    pub(crate) authorization: Box<str>,
    pub(crate) identity: Box<str>,
    pub(crate) tools: Value,
    pub(crate) catalog_digest: Box<str>,
}

pub(crate) enum Command {
    Detach,
}

pub(crate) async fn run(
    config: Config,
    runtime: Arc<PreparedToolRuntime>,
    mut commands: mpsc::Receiver<Command>,
    events: mpsc::Sender<AttachmentEvent>,
    status: watch::Sender<AttachmentStatus>,
    closed: watch::Sender<Option<Result<(), AttachmentError>>>,
) {
    let mut revision = 1_u64;
    let mut first = true;
    let mut backoff = Duration::from_millis(100);
    let call_event_slots = Arc::new(Semaphore::new(protocol::MAX_RECEIPTS));
    let terminal = loop {
        let _ = status.send(AttachmentStatus::Connecting);
        emit(&events, AttachmentEvent::Connecting);
        let request = match request(&config) {
            Ok(request) => request,
            Err(error) => break Err(error),
        };
        let connected = tokio::select! {
            command = commands.recv() => match command { Some(Command::Detach) | None => break Ok(()) },
            connected = connect_async(request) => connected,
        };
        let socket = match connected {
            Ok((socket, _)) => socket,
            Err(tokio_tungstenite::tungstenite::Error::Http(response))
                if matches!(response.status().as_u16(), 401 | 403) =>
            {
                break Err(AttachmentError::Authentication(
                    "endpoint rejected the bearer credential".into(),
                ));
            }
            Err(error) if first => break Err(AttachmentError::Transport(error.to_string().into())),
            Err(_) => {
                let _ = status.send(AttachmentStatus::Disconnected);
                if wait_backoff(&mut commands, backoff).await {
                    break Ok(());
                }
                backoff = (backoff * 2).min(Duration::from_secs(5));
                continue;
            }
        };
        let end = connection(
            socket,
            ConnectionContext {
                config: &config,
                runtime: &runtime,
                events: &events,
                status: &status,
                event_slots: &call_event_slots,
            },
            &mut commands,
            &mut revision,
        )
        .await;
        if matches!(*status.borrow(), AttachmentStatus::Ready { .. }) {
            first = false;
            backoff = Duration::from_millis(100);
        }
        match end {
            ConnectionEnd::Detached => break Ok(()),
            ConnectionEnd::DetachFailed(error) => break Err(error),
            ConnectionEnd::Fenced(reason) => {
                let _ = status.send(AttachmentStatus::Fenced);
                emit(
                    &events,
                    AttachmentEvent::Fenced {
                        reason: reason.clone(),
                    },
                );
                break Err(AttachmentError::Fenced(reason));
            }
            ConnectionEnd::Failed(error) if first => break Err(error),
            ConnectionEnd::Failed(_) | ConnectionEnd::Disconnected => {
                let _ = status.send(AttachmentStatus::Disconnected);
                if wait_backoff(&mut commands, backoff).await {
                    break Ok(());
                }
                backoff = (backoff * 2).min(Duration::from_secs(5));
            }
        }
        first = false;
    };
    runtime.shutdown().await;
    if terminal.is_ok() {
        emit(
            &events,
            AttachmentEvent::Detached {
                reason: "closed".into(),
            },
        );
    }
    let _ = closed.send(Some(terminal));
}

fn request(config: &Config) -> Result<http::Request<()>, AttachmentError> {
    let mut request = config
        .endpoint
        .as_str()
        .into_client_request()
        .map_err(|error| AttachmentError::Transport(error.to_string().into()))?;
    let mut authorization = http::HeaderValue::from_str(&config.authorization)
        .map_err(|_| AttachmentError::Authentication("invalid bearer credential".into()))?;
    authorization.set_sensitive(true);
    request
        .headers_mut()
        .insert(http::header::AUTHORIZATION, authorization);
    Ok(request)
}

async fn wait_backoff(commands: &mut mpsc::Receiver<Command>, delay: Duration) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(delay) => false,
        command = commands.recv() => matches!(command, Some(Command::Detach) | None),
    }
}

enum ConnectionEnd {
    Detached,
    DetachFailed(AttachmentError),
    Disconnected,
    Failed(AttachmentError),
    Fenced(Box<str>),
}

async fn next_handshake_frame<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    commands: &mut mpsc::Receiver<Command>,
    phase: &'static str,
) -> Result<RemoteFrame, ConnectionEnd>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    tokio::select! {
        command = commands.recv() => match command {
            Some(Command::Detach) | None => Err(ConnectionEnd::Detached),
        },
        frame = tokio::time::timeout(HANDSHAKE_TIMEOUT, next_frame(socket)) => match frame {
            Ok(Ok(frame)) => Ok(frame),
            Ok(Err(end)) => Err(end),
            Err(_) => Err(ConnectionEnd::Failed(AttachmentError::Transport(
                format!("timed out waiting for attachment {phase}").into(),
            ))),
        },
    }
}

enum Completion {
    Result {
        call_id: Box<str>,
        outcome: Value,
        observed: AttachmentCallOutcome,
    },
}

struct InFlight {
    task: tokio::task::JoinHandle<()>,
    identity: CallIdentity,
    parallel_safe: bool,
    events: CallEvents,
}

struct PendingCall {
    identity: CallIdentity,
    tool_timeout: u64,
    parallel_safe: bool,
    events: CallEvents,
}

struct CallEvents {
    completed: oneshot::Sender<AttachmentCallOutcome>,
}

impl CallEvents {
    fn complete(self, outcome: AttachmentCallOutcome) {
        let _ = self.completed.send(outcome);
    }
}

async fn begin_call_events(
    events: &mpsc::Sender<AttachmentEvent>,
    slots: &Arc<Semaphore>,
    commands: &mut mpsc::Receiver<Command>,
    call_id: Box<str>,
    name: Box<str>,
    revision: CatalogRevision,
) -> Option<CallEvents> {
    let permit = tokio::select! {
        permit = Arc::clone(slots).acquire_owned() => permit.ok()?,
        command = commands.recv() => match command {
            Some(Command::Detach) | None => return None,
        },
    };
    let (completed, completion) = oneshot::channel();
    let events = events.clone();
    tokio::spawn(async move {
        if events
            .send(AttachmentEvent::CallStarted {
                call_id: call_id.clone(),
                name,
                revision,
            })
            .await
            .is_ok()
            && let Ok(outcome) = completion.await
        {
            let _ = events
                .send(AttachmentEvent::CallCompleted {
                    call_id,
                    outcome,
                    revision,
                })
                .await;
        }
        drop(permit);
    });
    Some(CallEvents { completed })
}

#[derive(Clone, PartialEq)]
struct CallIdentity {
    host_id: Box<str>,
    lease_id: Box<str>,
    generation: u64,
    catalog_revision: u64,
    session_id: Box<str>,
    call_id: Box<str>,
    model: Box<str>,
    name: Box<str>,
    input: Value,
    output_token_budget: u64,
    output_byte_budget: u64,
    deadline_at: u64,
}

struct Receipt {
    identity: CallIdentity,
    outcome: Value,
}

fn admitted_identity<'a>(
    in_flight: &'a HashMap<Box<str>, InFlight>,
    pending: &'a VecDeque<PendingCall>,
    call_id: &str,
) -> Option<&'a CallIdentity> {
    in_flight
        .get(call_id)
        .map(|call| &call.identity)
        .or_else(|| {
            pending
                .iter()
                .find(|call| call.identity.call_id.as_ref() == call_id)
                .map(|call| &call.identity)
        })
}

fn catalog_parallel_safe(tools: &Value, name: &str) -> bool {
    tools.as_array().is_some_and(|tools| {
        tools.iter().any(|tool| {
            tool.get("definition")
                .and_then(|definition| definition.get("name"))
                .and_then(Value::as_str)
                == Some(name)
                && tool.get("parallel_safe").and_then(Value::as_bool) == Some(true)
        })
    })
}

fn start_ready_calls(
    runtime: &Arc<PreparedToolRuntime>,
    pending: &mut VecDeque<PendingCall>,
    in_flight: &mut HashMap<Box<str>, InFlight>,
    completed: &mpsc::Sender<Completion>,
) {
    while in_flight.len() < protocol::MAX_IN_FLIGHT {
        if in_flight.values().any(|call| !call.parallel_safe) {
            break;
        }
        let Some(next) = pending.front() else {
            break;
        };
        if !next.parallel_safe && !in_flight.is_empty() {
            break;
        }
        let Some(PendingCall {
            identity,
            tool_timeout,
            parallel_safe,
            events,
        }) = pending.pop_front()
        else {
            break;
        };
        let runtime = Arc::clone(runtime);
        let tx = completed.clone();
        let id = identity.call_id.clone();
        let id_for_task = id.clone();
        let task_identity = identity.clone();
        let task = tokio::spawn(async move {
            let remaining = task_identity.deadline_at.saturating_sub(now_ms());
            let (outcome, observed) = if remaining == 0 {
                (
                    unavailable("tool deadline elapsed before execution"),
                    AttachmentCallOutcome::Unavailable,
                )
            } else {
                let duration = Duration::from_millis(remaining.min(tool_timeout));
                let call = PreparedToolCall::new(
                    task_identity.model.to_string(),
                    task_identity.session_id.to_string(),
                    task_identity.call_id.to_string(),
                    task_identity.name.to_string(),
                    task_identity.input.clone(),
                    task_identity.output_token_budget as usize,
                );
                match tokio::time::timeout(duration, runtime.execute(call)).await {
                    Ok(Ok(output)) => match serde_json::to_value(output) {
                        Ok(output)
                            if serde_json::to_vec(&output).is_ok_and(|bytes| {
                                bytes.len() as u64 <= task_identity.output_byte_budget
                            }) =>
                        {
                            (
                                json!({"status":"completed", "output":output}),
                                AttachmentCallOutcome::Completed,
                            )
                        }
                        Ok(_) => bounded_completed_failure(
                            "tool output exceeded byte budget",
                            task_identity.output_byte_budget,
                        ),
                        Err(_) => (
                            ambiguous("tool output could not be encoded"),
                            AttachmentCallOutcome::Ambiguous,
                        ),
                    },
                    Ok(Err(error @ PreparedToolError::InvalidOutput(_))) => (
                        ambiguous(&error.to_string()),
                        AttachmentCallOutcome::Ambiguous,
                    ),
                    Ok(Err(error)) => (
                        unavailable(&error.to_string()),
                        AttachmentCallOutcome::Unavailable,
                    ),
                    Err(_) => (
                        ambiguous("tool deadline elapsed"),
                        AttachmentCallOutcome::Ambiguous,
                    ),
                }
            };
            let _ = tx
                .send(Completion::Result {
                    call_id: id_for_task,
                    outcome,
                    observed,
                })
                .await;
        });
        in_flight.insert(
            id,
            InFlight {
                task,
                identity,
                parallel_safe,
                events,
            },
        );
        if !parallel_safe {
            break;
        }
    }
}

struct ConnectionContext<'a> {
    config: &'a Config,
    runtime: &'a Arc<PreparedToolRuntime>,
    events: &'a mpsc::Sender<AttachmentEvent>,
    status: &'a watch::Sender<AttachmentStatus>,
    event_slots: &'a Arc<Semaphore>,
}

async fn connection<S>(
    mut socket: tokio_tungstenite::WebSocketStream<S>,
    context: ConnectionContext<'_>,
    commands: &mut mpsc::Receiver<Command>,
    revision: &mut u64,
) -> ConnectionEnd
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let ConnectionContext {
        config,
        runtime,
        events,
        status,
        event_slots,
    } = context;
    if let Err(error) = send(
        &mut socket,
        &HostFrame::Attach {
            protocol_version: 1,
            capability: "tools",
            host_id: &config.identity,
            capabilities: protocol::capabilities(),
        },
    )
    .await
    {
        return ConnectionEnd::Failed(error);
    }

    let (lease_id, generation, expires_at) =
        match next_handshake_frame(&mut socket, commands, "lease").await {
            Ok(RemoteFrame::Lease {
                lease_id,
                generation,
                expires_at,
                ..
            }) => (lease_id, generation, expires_at),
            Ok(_) => {
                policy_close(&mut socket).await;
                return ConnectionEnd::Fenced("expected lease after attach".into());
            }
            Err(ConnectionEnd::Fenced(reason)) => {
                policy_close(&mut socket).await;
                return ConnectionEnd::Fenced(reason);
            }
            Err(end) => return end,
        };
    if expires_at <= now_ms() {
        policy_close(&mut socket).await;
        return ConnectionEnd::Fenced("endpoint granted an expired lease".into());
    }
    emit(events, AttachmentEvent::Attached);
    if let Err(error) = publish(&mut socket, config, &lease_id, generation, *revision).await {
        return ConnectionEnd::Failed(error);
    }
    match next_handshake_frame(&mut socket, commands, "catalog acknowledgement").await {
        Ok(RemoteFrame::CatalogAck {
            lease_id: ack_lease,
            generation: ack_generation,
            catalog_revision,
            catalog_digest,
            ..
        }) if ack_lease == lease_id
            && ack_generation == generation
            && catalog_revision == *revision
            && catalog_digest == config.catalog_digest.as_ref() => {}
        Ok(_) => {
            policy_close(&mut socket).await;
            return ConnectionEnd::Fenced(
                "catalog acknowledgement did not match publication".into(),
            );
        }
        Err(ConnectionEnd::Fenced(reason)) => {
            policy_close(&mut socket).await;
            return ConnectionEnd::Fenced(reason);
        }
        Err(end) => return end,
    }
    let current = CatalogRevision(*revision);
    let _ = status.send(AttachmentStatus::Ready { revision: current });
    emit(
        events,
        AttachmentEvent::CatalogPublished {
            revision: current,
            tool_count: config.tools.as_array().map_or(0, Vec::len),
        },
    );

    let (completed_tx, mut completed_rx) = mpsc::channel::<Completion>(protocol::MAX_IN_FLIGHT);
    let mut in_flight: HashMap<Box<str>, InFlight> = HashMap::new();
    let mut pending = VecDeque::<PendingCall>::new();
    let mut receipts: HashMap<Box<str>, Receipt> = HashMap::new();
    let mut heartbeat = tokio::time::interval_at(
        tokio::time::Instant::now() + protocol::HEARTBEAT_INTERVAL,
        protocol::HEARTBEAT_INTERVAL,
    );
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut lease_expiry = Box::pin(tokio::time::sleep_until(lease_deadline(expires_at)));
    let mut pong_timeout = Box::pin(tokio::time::sleep(PONG_TIMEOUT));
    let mut awaiting_pong: Option<String> = None;
    let mut detaching = false;

    let end = loop {
        start_ready_calls(runtime, &mut pending, &mut in_flight, &completed_tx);
        if detaching && pending.is_empty() && in_flight.is_empty() {
            break ConnectionEnd::Detached;
        }
        tokio::select! {
            command = commands.recv(), if !detaching => match command { Some(Command::Detach) | None => detaching = true },
            _ = &mut lease_expiry, if !detaching => break ConnectionEnd::Disconnected,
            _ = &mut pong_timeout, if !detaching && awaiting_pong.is_some() => break ConnectionEnd::Disconnected,
            _ = heartbeat.tick(), if !detaching => {
                if awaiting_pong.is_some() { break ConnectionEnd::Disconnected; }
                let nonce = uuid::Uuid::new_v4().to_string();
                if let Err(error) = send(&mut socket, &HostFrame::Ping { protocol_version:1, capability:"tools", lease_id:&lease_id, generation, nonce:&nonce }).await { break ConnectionEnd::Failed(error); }
                awaiting_pong = Some(nonce);
                pong_timeout.as_mut().reset(tokio::time::Instant::now() + PONG_TIMEOUT);
            }
            completion = completed_rx.recv() => if let Some(Completion::Result { call_id, outcome, observed }) = completion {
                let Some(call) = in_flight.remove(&call_id) else { continue; };
                let _ = call.task.await;
                call.events.complete(observed);
                if receipts.len() >= protocol::MAX_RECEIPTS { break ConnectionEnd::Fenced("result receipt capacity exceeded".into()); }
                receipts.insert(call_id.clone(), Receipt { identity: call.identity, outcome: outcome.clone() });
                if let Err(error) = send_result(&mut socket, &lease_id, generation, *revision, &call_id, &outcome).await {
                    break if detaching { ConnectionEnd::DetachFailed(error) } else { ConnectionEnd::Failed(error) };
                }
            },
            incoming = socket.next(), if !detaching => {
                let frame = match incoming {
                    Some(Ok(Message::Text(text))) => match RemoteFrame::parse(&text) { Ok(frame) => frame, Err(reason) => break ConnectionEnd::Fenced(reason.into()) },
                    Some(Ok(Message::Ping(payload))) => { if socket.send(Message::Pong(payload)).await.is_err() { break ConnectionEnd::Disconnected; } continue; }
                    Some(Ok(Message::Close(frame))) => {
                        if frame.as_ref().is_some_and(|frame| frame.code == CloseCode::Policy) { break ConnectionEnd::Fenced("endpoint closed the lease".into()); }
                        break ConnectionEnd::Disconnected;
                    }
                    Some(Ok(_)) => break ConnectionEnd::Fenced("endpoint sent a non-text frame".into()),
                    Some(Err(_)) | None => break ConnectionEnd::Disconnected,
                };
                match frame {
                    RemoteFrame::Call { host_id, lease_id: pin_lease, generation: pin_generation, catalog_revision, session_id, call_id, model, name, input, output_token_budget, output_byte_budget, deadline_at, .. } => {
                        if host_id != config.identity.as_ref() || pin_lease != lease_id || pin_generation != generation || catalog_revision != *revision {
                            break ConnectionEnd::Fenced("call pin did not match active catalog".into());
                        }
                        let identity = CallIdentity { host_id:host_id.clone().into(), lease_id:pin_lease.clone().into(), generation:pin_generation, catalog_revision, session_id:session_id.clone().into(), call_id:call_id.clone().into(), model:model.into(), name:name.clone().into(), input:input.clone(), output_token_budget, output_byte_budget, deadline_at };
                        if let Some(receipt) = receipts.get(call_id.as_str()) {
                            if receipt.identity != identity { break ConnectionEnd::Fenced("duplicate call changed immutable fields".into()); }
                            if let Err(error) = send_result(&mut socket, &lease_id, generation, *revision, &call_id, &receipt.outcome).await { break ConnectionEnd::Failed(error); }
                            continue;
                        }
                        if let Some(admitted) = admitted_identity(&in_flight, &pending, call_id.as_str()) {
                            if admitted != &identity { break ConnectionEnd::Fenced("duplicate in-flight call changed immutable fields".into()); }
                            continue;
                        }
                        let Some(call_events) = begin_call_events(events, event_slots, commands, call_id.clone().into(), name.clone().into(), CatalogRevision(*revision)).await else {
                            detaching = true;
                            continue;
                        };
                        if receipts.len().saturating_add(in_flight.len()).saturating_add(pending.len()) >= protocol::MAX_RECEIPTS {
                            call_events.complete(AttachmentCallOutcome::Unavailable);
                            break ConnectionEnd::Fenced("result receipt capacity exhausted".into());
                        }
                        if in_flight.len().saturating_add(pending.len()) >= protocol::MAX_IN_FLIGHT {
                            let outcome = unavailable("attachment execution capacity is exhausted");
                            call_events.complete(AttachmentCallOutcome::Unavailable);
                            if let Err(error) = send_result(&mut socket, &lease_id, generation, *revision, &call_id, &outcome).await { break ConnectionEnd::Failed(error); }
                            receipts.insert(call_id.into(), Receipt { identity, outcome });
                            continue;
                        }
                        let now = now_ms();
                        let tool_timeout = runtime.timeout_ms(&name).unwrap_or(0);
                        if deadline_at <= now || tool_timeout == 0 {
                            let outcome = unavailable(if tool_timeout == 0 { "tool is not in the pinned catalog" } else { "tool deadline elapsed before execution" });
                            call_events.complete(AttachmentCallOutcome::Unavailable);
                            if let Err(error) = send_result(&mut socket, &lease_id, generation, *revision, &call_id, &outcome).await { break ConnectionEnd::Failed(error); }
                            receipts.insert(call_id.into(), Receipt { identity, outcome });
                            continue;
                        }
                        let parallel_safe = catalog_parallel_safe(&config.tools, &name);
                        pending.push_back(PendingCall { identity, tool_timeout, parallel_safe, events:call_events });
                    }
                    RemoteFrame::Cancel { lease_id:pin_lease, generation:pin_generation, catalog_revision, call_id, .. } => {
                        if pin_lease != lease_id || pin_generation != generation || catalog_revision != *revision { break ConnectionEnd::Fenced("cancel pin did not match active catalog".into()); }
                        if let Err(error) = send(&mut socket, &HostFrame::CancelAck { protocol_version:1, capability:"tools", lease_id:&lease_id, generation, catalog_revision:*revision, call_id:&call_id, outcome:"too_late" }).await { break ConnectionEnd::Failed(error); }
                    }
                    RemoteFrame::ResultAck { lease_id:pin_lease, generation:pin_generation, catalog_revision, call_id, .. } => {
                        if pin_lease != lease_id || pin_generation != generation || catalog_revision != *revision || receipts.remove(call_id.as_str()).is_none() { break ConnectionEnd::Fenced("result acknowledgement did not match a retained result".into()); }
                    }
                    RemoteFrame::CatalogAck { .. } => break ConnectionEnd::Fenced("unexpected catalog acknowledgement".into()),
                    RemoteFrame::Pong { lease_id:pin_lease, generation:pin_generation, expires_at, nonce, .. } => {
                        if pin_lease != lease_id || pin_generation != generation { break ConnectionEnd::Fenced("pong pin did not match active lease".into()); }
                        let Some(expected_nonce) = awaiting_pong.take() else { break ConnectionEnd::Fenced("unexpected pong without an outstanding ping".into()); };
                        if nonce.as_deref() != Some(expected_nonce.as_str()) { break ConnectionEnd::Fenced("pong nonce did not match the outstanding ping".into()); }
                        if expires_at <= now_ms() { break ConnectionEnd::Disconnected; }
                        lease_expiry.as_mut().reset(lease_deadline(expires_at));
                    },
                    RemoteFrame::Fenced { lease_id:pin_lease, generation:pin_generation, reason, .. } => {
                        if pin_lease != lease_id || pin_generation != generation { break ConnectionEnd::Fenced("fence pin did not match active lease".into()); }
                        break ConnectionEnd::Fenced(reason.into());
                    }
                    RemoteFrame::Lease { .. } => break ConnectionEnd::Fenced("unexpected lease".into()),
                }
            }
        }
    };
    match &end {
        ConnectionEnd::Detached => {
            let _ = socket.close(None).await;
        }
        ConnectionEnd::Fenced(_) => {
            let _ = socket
                .close(Some(CloseFrame {
                    code: CloseCode::Policy,
                    reason: "attachment protocol violation".into(),
                }))
                .await;
        }
        ConnectionEnd::Disconnected | ConnectionEnd::Failed(_) | ConnectionEnd::DetachFailed(_) => {
        }
    }
    for call in pending {
        call.events.complete(AttachmentCallOutcome::Ambiguous);
    }
    for (_, call) in in_flight {
        call.task.abort();
        let _ = call.task.await;
        call.events.complete(AttachmentCallOutcome::Ambiguous);
    }
    end
}

async fn publish<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    config: &Config,
    lease_id: &str,
    generation: u64,
    revision: u64,
) -> Result<(), AttachmentError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    send(
        socket,
        &HostFrame::CatalogPublish {
            protocol_version: 1,
            capability: "tools",
            lease_id,
            generation,
            catalog_revision: revision,
            catalog_digest: &config.catalog_digest,
            tools: &config.tools,
        },
    )
    .await
}

async fn send_result<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    lease_id: &str,
    generation: u64,
    revision: u64,
    call_id: &str,
    outcome: &Value,
) -> Result<(), AttachmentError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    send(
        socket,
        &HostFrame::Result {
            protocol_version: 1,
            capability: "tools",
            lease_id,
            generation,
            catalog_revision: revision,
            call_id,
            outcome,
        },
    )
    .await
}

async fn send<S, T: serde::Serialize>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    frame: &T,
) -> Result<(), AttachmentError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let text = serde_json::to_string(frame)
        .map_err(|error| AttachmentError::Transport(error.to_string().into()))?;
    if text.len() > protocol::MAX_FRAME_BYTES {
        return Err(AttachmentError::Transport(
            "outbound frame exceeds 256 KiB".into(),
        ));
    }
    socket
        .send(Message::Text(text.into()))
        .await
        .map_err(|error| AttachmentError::Transport(error.to_string().into()))
}

async fn next_frame<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
) -> Result<RemoteFrame, ConnectionEnd>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        match socket.next().await {
            Some(Ok(Message::Text(text))) => {
                return RemoteFrame::parse(&text)
                    .map_err(|error| ConnectionEnd::Fenced(error.into()));
            }
            Some(Ok(Message::Ping(payload))) => {
                socket.send(Message::Pong(payload)).await.map_err(|error| {
                    ConnectionEnd::Failed(AttachmentError::Transport(error.to_string().into()))
                })?
            }
            Some(Ok(_)) => {
                return Err(ConnectionEnd::Fenced(
                    "unexpected websocket frame during handshake".into(),
                ));
            }
            Some(Err(error)) => {
                return Err(ConnectionEnd::Failed(AttachmentError::Transport(
                    error.to_string().into(),
                )));
            }
            None => {
                return Err(ConnectionEnd::Failed(AttachmentError::Transport(
                    "websocket closed".into(),
                )));
            }
        }
    }
}

async fn policy_close<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let _ = socket
        .close(Some(CloseFrame {
            code: CloseCode::Policy,
            reason: "attachment protocol violation".into(),
        }))
        .await;
}

fn unavailable(message: &str) -> Value {
    json!({"status":"unavailable", "message":bounded(message)})
}
fn ambiguous(message: &str) -> Value {
    json!({"status":"ambiguous", "message":bounded(message)})
}
fn bounded_completed_failure(
    message: &str,
    output_byte_budget: u64,
) -> (Value, AttachmentCallOutcome) {
    let output = json!({"output":bounded(message),"success":false,"structured_result":null,"metadata":null,"process_trace":null});
    if serde_json::to_vec(&output).is_ok_and(|bytes| bytes.len() as u64 <= output_byte_budget) {
        (
            json!({"status":"completed", "output":output}),
            AttachmentCallOutcome::Completed,
        )
    } else {
        (
            ambiguous("tool output exceeded byte budget"),
            AttachmentCallOutcome::Ambiguous,
        )
    }
}
fn bounded(message: &str) -> &str {
    message
        .get(..message.len().min(2048))
        .unwrap_or("tool failed")
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            duration.as_millis().try_into().unwrap_or(u64::MAX)
        })
}
fn lease_deadline(expires_at: u64) -> tokio::time::Instant {
    tokio::time::Instant::now() + Duration::from_millis(expires_at.saturating_sub(now_ms()))
}
fn emit(events: &mpsc::Sender<AttachmentEvent>, event: AttachmentEvent) {
    let _ = events.try_send(event);
}
