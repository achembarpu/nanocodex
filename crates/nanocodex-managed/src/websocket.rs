use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Message, client::IntoClientRequest as _},
};

use crate::{
    EventCursor, ManagedClient, ManagedError, ManagedEvent, ManagedEventData, ManagedEventFuture,
    ManagedEventSource, PromptInput, TurnState, TurnView,
    client::{agent_path, validate_id, validate_idempotency_key},
};

const EVENT_CAPACITY: usize = 256;
const RECONNECT_MIN: Duration = Duration::from_millis(100);
const RECONNECT_MAX: Duration = Duration::from_secs(5);

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

struct ConnectedSocket {
    socket: Socket,
    replay_through: String,
}

#[derive(Clone, Debug)]
pub(crate) struct ManagedSocket {
    commands: mpsc::Sender<Command>,
}

pub(crate) struct ManagedSocketEvents {
    cursor: EventCursor,
    events: mpsc::Receiver<Result<ManagedEvent, ManagedError>>,
}

enum Command {
    Submit {
        id: String,
        input: PromptInput,
        result: oneshot::Sender<Result<TurnView, ManagedError>>,
    },
}

struct PendingSubmit {
    id: String,
    input: PromptInput,
    result: oneshot::Sender<Result<TurnView, ManagedError>>,
    sent: bool,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMessage<'a> {
    Prompt { id: &'a str, input: &'a PromptInput },
}

#[derive(Deserialize)]
struct MessageKind {
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Deserialize)]
struct ReadyMessage {
    #[serde(rename = "type")]
    kind: String,
    session_id: String,
    latest_event_cursor: String,
}

impl ManagedSocket {
    pub(crate) async fn open(
        client: ManagedClient,
        agent_id: String,
        cursor: EventCursor,
    ) -> Result<(Self, ManagedSocketEvents), ManagedError> {
        validate_id("agent", &agent_id)?;
        let connected = connect(&client, &agent_id, cursor.as_str()).await?;
        let (commands, command_rx) = mpsc::channel(1);
        let (event_tx, events) = mpsc::channel(EVENT_CAPACITY);
        tokio::spawn(run(
            client,
            agent_id,
            cursor.as_str().to_owned(),
            connected,
            command_rx,
            event_tx,
        ));
        Ok((Self { commands }, ManagedSocketEvents { cursor, events }))
    }

    pub(crate) async fn submit(
        &self,
        id: String,
        input: PromptInput,
    ) -> Result<TurnView, ManagedError> {
        validate_idempotency_key(&id)?;
        let id = websocket_turn_id(&id);
        let (result, receiver) = oneshot::channel();
        self.commands
            .send(Command::Submit { id, input, result })
            .await
            .map_err(|_| live_error("managed WebSocket stopped before submission"))?;
        receiver
            .await
            .map_err(|_| live_error("managed WebSocket stopped during submission"))?
    }
}

impl ManagedEventSource for ManagedSocketEvents {
    fn cursor(&self) -> &EventCursor {
        &self.cursor
    }

    fn next(&mut self) -> ManagedEventFuture<'_> {
        Box::pin(async move {
            let event = self
                .events
                .recv()
                .await
                .ok_or_else(|| live_error("managed WebSocket event stream stopped"))??;
            if !self.cursor.observe(event.cursor.clone())? {
                return Err(live_error("managed WebSocket emitted a stale event"));
            }
            Ok(event)
        })
    }
}

async fn run(
    client: ManagedClient,
    agent_id: String,
    mut cursor: String,
    mut connected: ConnectedSocket,
    mut commands: mpsc::Receiver<Command>,
    events: mpsc::Sender<Result<ManagedEvent, ManagedError>>,
) {
    let mut pending = None;
    let mut backoff = RECONNECT_MIN;
    loop {
        let connected_at = tokio::time::Instant::now();
        let disconnected = connection(
            &mut connected.socket,
            &mut commands,
            &events,
            &mut pending,
            &mut cursor,
            &connected.replay_through,
        )
        .await;
        if !disconnected || events.is_closed() {
            return;
        }
        if connected_at.elapsed() >= Duration::from_millis(250) {
            backoff = RECONNECT_MIN;
        }
        tokio::select! {
            () = tokio::time::sleep(backoff) => {}
            () = events.closed() => return,
        }
        backoff = (backoff * 2).min(RECONNECT_MAX);
        loop {
            match connect(&client, &agent_id, &cursor).await {
                Ok(connected_socket) => {
                    connected = connected_socket;
                    if let Some(pending) = pending.as_mut() {
                        pending.sent = false;
                    }
                    break;
                }
                Err(_) => {
                    tokio::select! {
                        () = tokio::time::sleep(backoff) => {}
                        () = events.closed() => return,
                    }
                    backoff = (backoff * 2).min(RECONNECT_MAX);
                }
            }
        }
    }
}

async fn connection(
    socket: &mut Socket,
    commands: &mut mpsc::Receiver<Command>,
    events: &mpsc::Sender<Result<ManagedEvent, ManagedError>>,
    pending: &mut Option<PendingSubmit>,
    cursor: &mut String,
    replay_through: &str,
) -> bool {
    loop {
        if let Some(submission) = pending.as_mut()
            && !submission.sent
            && !crate::sse::cursor_before(cursor, replay_through)
        {
            if send_prompt(socket, submission).await.is_err() {
                return true;
            }
            submission.sent = true;
        }
        tokio::select! {
            command = commands.recv(), if pending.is_none() => match command {
                Some(Command::Submit { id, input, result }) => {
                    *pending = Some(PendingSubmit { id, input, result, sent: false });
                }
                None => return false,
            },
            message = socket.next() => match message {
                Some(Ok(Message::Text(encoded))) => {
                    if handle_message(encoded.as_str(), events, pending, cursor).await.is_err() {
                        return false;
                    }
                }
                Some(Ok(Message::Ping(payload))) => {
                    if socket.send(Message::Pong(payload)).await.is_err() {
                        return true;
                    }
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return true,
                Some(Ok(_)) => {}
            }
        }
    }
}

async fn handle_message(
    encoded: &str,
    events: &mpsc::Sender<Result<ManagedEvent, ManagedError>>,
    pending: &mut Option<PendingSubmit>,
    cursor: &mut String,
) -> Result<(), ()> {
    let kind: MessageKind = match serde_json::from_str(encoded) {
        Ok(kind) => kind,
        Err(error) => {
            let _ = events
                .send(Err(live_error(format!(
                    "managed WebSocket sent invalid JSON: {error}"
                ))))
                .await;
            return Err(());
        }
    };
    if matches!(kind.kind.as_str(), "ready" | "status" | "pong") {
        return Ok(());
    }
    if kind.kind == "error" {
        #[derive(Deserialize)]
        struct ErrorMessage {
            code: String,
            message: String,
        }
        let error = serde_json::from_str::<ErrorMessage>(encoded)
            .map(|error| live_error(format!("{}: {}", error.code, error.message)))
            .unwrap_or_else(|_| live_error("managed WebSocket command failed"));
        if let Some(submission) = pending.take() {
            let _ = submission.result.send(Err(error));
            return Ok(());
        }
        let _ = events.send(Err(error)).await;
        return Err(());
    }
    let event: ManagedEvent = match serde_json::from_str(encoded) {
        Ok(event) => event,
        Err(error) => {
            let _ = events
                .send(Err(live_error(format!(
                    "managed WebSocket event is malformed: {error}"
                ))))
                .await;
            return Err(());
        }
    };
    let is_new = crate::sse::cursor_before(cursor, &event.cursor);
    if let Some(submission) = pending.as_ref()
        && event.data.turn_id() == Some(submission.id.as_str())
        && matches!(
            event.data,
            ManagedEventData::TurnAccepted { .. }
                | ManagedEventData::TurnCancelling { .. }
                | ManagedEventData::TurnCompleted { .. }
                | ManagedEventData::TurnCancelled { .. }
                | ManagedEventData::TurnRetryable { .. }
                | ManagedEventData::TurnFailed { .. }
        )
    {
        let submission = pending
            .take()
            .expect("pending submission was just observed");
        let view = turn_view(&event, submission.input);
        let _ = submission.result.send(Ok(view));
    }
    if is_new {
        cursor.clone_from(&event.cursor);
        events.send(Ok(event)).await.map_err(|_| ())?;
    }
    Ok(())
}

fn turn_view(event: &ManagedEvent, input: PromptInput) -> TurnView {
    let (state, terminal, error, retry_at) = match &event.data {
        ManagedEventData::TurnCancelling {
            error, retry_at, ..
        } => (TurnState::Cancelling, None, error.clone(), *retry_at),
        ManagedEventData::TurnCompleted { .. } => {
            (TurnState::Completed, Some(event.data.clone()), None, None)
        }
        ManagedEventData::TurnCancelled { .. } => {
            (TurnState::Cancelled, Some(event.data.clone()), None, None)
        }
        ManagedEventData::TurnFailed { error, .. } => (
            TurnState::Failed,
            Some(event.data.clone()),
            Some(error.clone()),
            None,
        ),
        ManagedEventData::TurnRetryable { error, .. } => {
            (TurnState::Accepted, None, Some(error.clone()), None)
        }
        _ => (TurnState::Accepted, None, None, None),
    };
    let terminal_cursor = terminal.as_ref().map(|_| event.cursor.clone());
    TurnView {
        turn_id: event.data.turn_id().unwrap_or_default().to_owned(),
        state,
        input,
        accepted_cursor: event.cursor.clone(),
        terminal_cursor,
        created_at: event.created_at.unwrap_or_default(),
        accepted_at: event.created_at.unwrap_or_default(),
        updated_at: event.created_at.unwrap_or_default(),
        attempt_count: 1,
        retry_at,
        error,
        terminal,
    }
}

fn websocket_turn_id(request_id: &str) -> String {
    if validate_id("turn", request_id).is_ok() {
        return request_id.to_owned();
    }
    uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_URL, request_id.as_bytes()).to_string()
}

async fn send_prompt(socket: &mut Socket, submission: &PendingSubmit) -> Result<(), ManagedError> {
    let encoded = serde_json::to_string(&ClientMessage::Prompt {
        id: &submission.id,
        input: &submission.input,
    })
    .map_err(|_| live_error("failed to encode managed WebSocket prompt"))?;
    socket
        .send(Message::Text(encoded.into()))
        .await
        .map_err(|error| live_error(format!("managed WebSocket send failed: {error}")))
}

async fn connect(
    client: &ManagedClient,
    agent_id: &str,
    cursor: &str,
) -> Result<ConnectedSocket, ManagedError> {
    let mut endpoint = client.url(&format!("{}/ws", agent_path(agent_id)))?;
    endpoint
        .set_scheme(match endpoint.scheme() {
            "http" => "ws",
            "https" => "wss",
            _ => return Err(live_error("managed WebSocket origin is not HTTP(S)")),
        })
        .map_err(|_| live_error("failed to derive managed WebSocket endpoint"))?;
    endpoint.query_pairs_mut().append_pair("cursor", cursor);
    let mut request = endpoint
        .as_str()
        .into_client_request()
        .map_err(|error| live_error(format!("invalid managed WebSocket request: {error}")))?;
    let mut authorization = format!("Bearer {}", client.bearer)
        .parse::<tokio_tungstenite::tungstenite::http::HeaderValue>()
        .map_err(|_| live_error("managed bearer credential cannot form a WebSocket header"))?;
    authorization.set_sensitive(true);
    request.headers_mut().insert(
        tokio_tungstenite::tungstenite::http::header::AUTHORIZATION,
        authorization,
    );
    let (mut socket, _) = connect_async(request)
        .await
        .map_err(|error| live_error(format!("managed WebSocket handshake failed: {error}")))?;
    match socket.next().await {
        Some(Ok(Message::Text(encoded))) => {
            let ready: ReadyMessage = serde_json::from_str(encoded.as_str())
                .map_err(|_| live_error("managed WebSocket ready frame is malformed"))?;
            if ready.kind != "ready" {
                return Err(live_error("managed WebSocket did not begin with ready"));
            }
            if ready.session_id != agent_id {
                return Err(live_error(
                    "managed WebSocket ready session does not match agent",
                ));
            }
            crate::sse::validate_numeric_cursor(&ready.latest_event_cursor)?;
            if crate::sse::cursor_before(&ready.latest_event_cursor, cursor) {
                return Err(live_error(
                    "managed WebSocket ready cursor is behind request",
                ));
            }
            Ok(ConnectedSocket {
                socket,
                replay_through: ready.latest_event_cursor,
            })
        }
        _ => Err(live_error("managed WebSocket closed before ready")),
    }
}

fn live_error(message: impl Into<String>) -> ManagedError {
    ManagedError::InvalidEvent(message.into())
}
