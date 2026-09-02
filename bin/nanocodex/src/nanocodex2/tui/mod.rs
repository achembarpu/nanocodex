//! Tact-derived terminal presentation adapted to the managed Nanocodex driver.
//!
//! Portions of this module tree derive from clabby/tact at revision
//! e20b1584642339546bb2310aad6968edeec66a53 and are modified for Nanocodex2.
//! They remain available under Apache-2.0. The managed service owns agent
//! orchestration and hosted tools; this module owns only presentation, terminal
//! interaction, and the caller-local shell convenience.

mod clipboard;
mod components;
mod context;
mod editor;
mod format;
mod pane;
mod prompt;
mod scheduler;
mod session;
mod shell;
mod spinner;
mod terminal;
mod theme;
mod transcript;

use self::{
    components::{
        AppEffect, AppEvent, AppNode, ComponentUpdate, DraftReset, RenderRequest, RootEffect,
        RootNode,
    },
    pane::PaneId,
    prompt::Submission,
    scheduler::{RenderScheduler, STREAM_FRAME_INTERVAL},
    session::{RecentPrompt, SessionSummary},
    shell::ShellExecution,
    terminal::TerminalSession,
    theme::{Theme, detect_system_scheme},
    transcript::{LocalEvent, ShellId, TranscriptRecord, TurnId},
};
use crate::{config::ReasoningEffort, config::ReasoningMode, host::HostConfig};
use crossterm::event::{Event, EventStream, KeyCode, KeyEventKind, KeyModifiers};
use futures_util::{StreamExt, future::join_all};
use nanocodex::Model;
use nanocodex_agent::{
    AgentEvents, Nanocodex, NanocodexError, Turn, TurnControl, TurnResult, events::AgentEvent,
};
use nanocodex_managed::{
    AgentList, EventCursor, ManagedClient, ManagedError, ManagedEvent, ManagedEventData,
    PromptContent, PromptInput,
};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    future::pending,
    io,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tokio::task::JoinSet;

type Admission = (PaneId, TurnId, Result<Turn, NanocodexError>);
type Completion = (PaneId, TurnId, Result<TurnResult, NanocodexError>);
type SteerCompletion = (PaneId, components::QueueId, Result<(), NanocodexError>);
type CancelCompletion = (PaneId, Vec<TurnId>, Option<String>);
type HistoryProjection = (Vec<Arc<TranscriptRecord>>, u64, Vec<RecentPrompt>);
type ConnectedAgent = (
    Nanocodex,
    AgentEvents,
    String,
    PathBuf,
    Vec<ManagedEvent>,
    Option<String>,
);

#[derive(Clone)]
enum RetryTarget {
    Create,
    Agent(String),
}

struct ConnectionFailure {
    error: ManagedError,
    retry: RetryTarget,
}

#[derive(Clone, Copy)]
enum ConnectionPurpose {
    Startup,
    Resume(PaneId),
    New(PaneId),
}

enum ConnectionResult {
    Agent {
        purpose: ConnectionPurpose,
        result: Result<ConnectedAgent, ConnectionFailure>,
    },
    Sessions {
        pane: PaneId,
        result: Result<AgentList, ManagedError>,
    },
    Disconnected(Result<(), NanocodexError>),
}

struct DriverRuntime {
    client: ManagedClient,
    agent: Option<Nanocodex>,
    events: Option<AgentEvents>,
    events_open: bool,
    agent_id: String,
    workspace: PathBuf,
    sequence: u64,
    next_turn: u64,
    next_shell: u64,
    controls: HashMap<TurnId, TurnControl>,
    admitting: HashSet<TurnId>,
    cancel_after_admission: HashSet<TurnId>,
    cancelling_controls: HashSet<TurnId>,
    cancellation_failed: bool,
    admissions: JoinSet<Admission>,
    completions: JoinSet<Completion>,
    steers: JoinSet<SteerCompletion>,
    cancellations: JoinSet<CancelCompletion>,
    shells: JoinSet<(PaneId, ShellExecution)>,
    active_shells: usize,
    shell_context: Vec<String>,
    pending_submission: Option<(PaneId, TurnId, Submission)>,
    recent_prompts: Vec<RecentPrompt>,
    connection: JoinSet<ConnectionResult>,
    retry_target: Option<RetryTarget>,
}

impl DriverRuntime {
    fn local_record(&mut self, event: LocalEvent) -> Result<Arc<TranscriptRecord>, ManagedError> {
        let record =
            TranscriptRecord::from_local(self.sequence, unix_ms(), event).map_err(|error| {
                ManagedError::Configuration(format!("TUI transcript error: {error}"))
            })?;
        self.sequence = self.sequence.saturating_add(1);
        Ok(Arc::new(record))
    }

    fn agent_record(&mut self, event: AgentEvent) -> Arc<TranscriptRecord> {
        let record = TranscriptRecord::from_agent(self.sequence, unix_ms(), event);
        self.sequence = self.sequence.saturating_add(1);
        Arc::new(record)
    }

    fn start_submission(&mut self, pane: PaneId, id: TurnId, prompt: Submission) {
        let prompt = inject_shell_context(&mut self.shell_context, prompt);
        let Some(agent) = self.agent.clone() else {
            self.pending_submission = Some((pane, id, prompt));
            if self.connection.is_empty()
                && let Some(target) = self.retry_target.take()
            {
                self.spawn_connection(ConnectionPurpose::Startup, target);
            }
            return;
        };
        self.admitting.insert(id);
        self.admissions.spawn(async move {
            let turn = agent.prompt(prompt.agent_prompt()).await;
            (pane, id, turn)
        });
    }

    fn spawn_connection(&mut self, purpose: ConnectionPurpose, target: RetryTarget) {
        if matches!(purpose, ConnectionPurpose::Startup) {
            self.retry_target = Some(target.clone());
        }
        let client = self.client.clone();
        let agent_id = match target {
            RetryTarget::Create => None,
            RetryTarget::Agent(agent_id) => Some(agent_id),
        };
        self.connection.spawn(async move {
            ConnectionResult::Agent {
                purpose,
                result: connect_agent(client, agent_id).await,
            }
        });
    }

    fn idle(&self) -> bool {
        self.controls.is_empty()
            && self.admissions.is_empty()
            && self.completions.is_empty()
            && self.steers.is_empty()
            && self.cancellations.is_empty()
            && self.active_shells == 0
            && self.pending_submission.is_none()
            && self.cancel_after_admission.is_empty()
            && self.cancelling_controls.is_empty()
            && self.connection.is_empty()
    }

    fn cancel_controls(&mut self, pane: PaneId, controls: Vec<(TurnId, TurnControl)>) {
        if controls.is_empty() {
            return;
        }
        let ids = controls.iter().map(|(id, _)| *id).collect::<Vec<_>>();
        self.cancelling_controls.extend(ids.iter().copied());
        self.cancellations.spawn(async move {
            let results = join_all(
                controls
                    .into_iter()
                    .map(|(_, control)| async move { control.cancel().await }),
            )
            .await;
            let error = results
                .into_iter()
                .filter_map(Result::err)
                .map(|error| error.to_string())
                .next();
            (pane, ids, error)
        });
    }
}

async fn connect_agent(
    client: ManagedClient,
    agent_id: Option<String>,
) -> Result<ConnectedAgent, ConnectionFailure> {
    let (agent_id, created, initial_state) = match agent_id {
        Some(agent_id) => (agent_id, false, None),
        None => {
            let receipt = client.create().await.map_err(|error| ConnectionFailure {
                error,
                retry: RetryTarget::Create,
            })?;
            (receipt.agent_id, true, receipt.initial_state)
        }
    };
    let state = match (created, initial_state) {
        (_, Some(state)) => state,
        (true, None) => {
            return Err(ConnectionFailure {
                error: ManagedError::InvalidResponse(
                    "created agent receipt is missing initial state",
                ),
                retry: RetryTarget::Create,
            });
        }
        (false, None) => client
            .state(&agent_id)
            .await
            .map_err(|error| ConnectionFailure {
                error,
                retry: RetryTarget::Agent(agent_id.clone()),
            })?,
    };
    let cursor = EventCursor::parse(state.latest_event_cursor.clone()).map_err(|error| {
        ConnectionFailure {
            error,
            retry: RetryTarget::Agent(agent_id.clone()),
        }
    })?;
    let opening = super::open_workspace_agent_from(&client, Some(agent_id.clone()), Some(state));
    let (opened, history) = if created {
        (opening.await, None)
    } else {
        let history = load_event_history(&client, &agent_id, &cursor);
        let (opened, history) = tokio::join!(opening, history);
        (opened, Some(history))
    };
    let (agent, events, agent_id, workspace) = opened.map_err(|error| ConnectionFailure {
        error,
        retry: RetryTarget::Agent(agent_id),
    })?;
    let (history, warning) = match history {
        None => (Vec::new(), None),
        Some(Ok(history)) => (history, None),
        Some(Err(error)) => (
            Vec::new(),
            Some(format!("Durable event history is unavailable: {error}")),
        ),
    };
    Ok((agent, events, agent_id, workspace, history, warning))
}

pub(crate) async fn run(
    client: &ManagedClient,
    agent_id: Option<String>,
) -> Result<(), ManagedError> {
    run_inner(client, Some(agent_id)).await
}

pub(crate) async fn run_new(client: &ManagedClient) -> Result<(), ManagedError> {
    run_inner(client, None).await
}

/// `Some(id)` attaches, `Some(None)` opens the in-TUI picker, and `None` creates.
async fn run_inner(
    client: &ManagedClient,
    attach: Option<Option<String>>,
) -> Result<(), ManagedError> {
    let workspace = HostConfig::load()
        .map_err(|error| ManagedError::Configuration(error.to_string()))?
        .workspace()
        .to_path_buf();
    let mut root = RootNode::new(&workspace, ReasoningEffort::Medium);
    root.set_fork_available(false);
    root.set_reasoning_modes(ReasoningMode::Standard, ReasoningMode::Standard);
    root.set_model(Model::Sol);

    let mut theme = Theme::default();
    if let Some(scheme) = detect_system_scheme() {
        theme.set_system_scheme(scheme);
    }
    let mut app = AppNode::new(theme, workspace.clone(), root);
    let mut terminal = TerminalSession::enter().map_err(terminal_error)?;
    let mut input = EventStream::new();
    let mut scheduler = RenderScheduler::new(STREAM_FRAME_INTERVAL, Instant::now());
    let mut runtime = DriverRuntime {
        client: client.clone(),
        agent: None,
        events: None,
        events_open: false,
        agent_id: String::new(),
        workspace: workspace.clone(),
        sequence: 1,
        next_turn: 1,
        next_shell: 1,
        controls: HashMap::new(),
        admitting: HashSet::new(),
        cancel_after_admission: HashSet::new(),
        cancelling_controls: HashSet::new(),
        cancellation_failed: false,
        admissions: JoinSet::new(),
        completions: JoinSet::new(),
        steers: JoinSet::new(),
        cancellations: JoinSet::new(),
        shells: JoinSet::new(),
        active_shells: 0,
        shell_context: Vec::new(),
        pending_submission: None,
        recent_prompts: Vec::new(),
        connection: JoinSet::new(),
        retry_target: None,
    };
    // Put the complete interface on screen before any managed request starts.
    terminal
        .draw(|frame| app.render(frame))
        .map_err(terminal_error)?;
    scheduler.presented(Instant::now());
    match attach {
        Some(None) => {
            let update = app.open_resume_selector();
            let _ = apply_update(
                update,
                &mut app,
                &mut runtime,
                &mut terminal,
                &mut scheduler,
            )
            .await?;
        }
        Some(Some(agent_id)) => {
            runtime.spawn_connection(ConnectionPurpose::Startup, RetryTarget::Agent(agent_id));
        }
        None => {
            runtime.spawn_connection(ConnectionPurpose::Startup, RetryTarget::Create);
        }
    }
    let mut stopping = false;

    while !stopping {
        if scheduler.is_due(Instant::now()) {
            terminal
                .draw(|frame| app.render(frame))
                .map_err(terminal_error)?;
            scheduler.presented(Instant::now());
        }

        let render_deadline = scheduler.deadline();
        let animation_deadline = app.animation_deadline();
        tokio::select! {
            input_event = input.next() => {
                let event = input_event
                    .transpose()
                    .map_err(terminal_error)?
                    .ok_or_else(|| terminal_error(io::Error::new(io::ErrorKind::UnexpectedEof, "terminal input closed")))?;
                let refresh_cursor = matches!(&event, Event::FocusGained | Event::Mouse(_));
                if refresh_cursor {
                    terminal.invalidate_cursor_visibility();
                }
                let update = if is_image_paste(&event)
                    && let Some(data) = clipboard::image_data_url()
                {
                    app.update(AppEvent::PasteImage(data))
                } else {
                    app.update(AppEvent::Terminal(event))
                };
                stopping = apply_update(update, &mut app, &mut runtime, &mut terminal, &mut scheduler).await?;
            }
            event = async {
                match runtime.events.as_mut() {
                    Some(events) => events.recv().await,
                    None => pending().await,
                }
            }, if runtime.events_open => {
                match event {
                    Some(event) => {
                        let record = runtime.agent_record(event);
                        let update = app.update(AppEvent::Transcript { pane: PaneId::Main, record });
                        stopping = apply_update(update, &mut app, &mut runtime, &mut terminal, &mut scheduler).await?;
                    }
                    None => {
                        runtime.events_open = false;
                        request_render(app.update(AppEvent::AgentStreamClosed(PaneId::Main)), &mut scheduler);
                    }
                }
            }
            result = runtime.connection.join_next(), if !runtime.connection.is_empty() => {
                if let Some(result) = result {
                    let result = match result {
                        Ok(result) => result,
                        Err(error) => {
                            request_render(app.update(AppEvent::NotifyError {
                                pane: PaneId::Main,
                                error: format!("Managed connection task stopped unexpectedly: {error}"),
                            }), &mut scheduler);
                            continue;
                        }
                    };
                    match result {
                        ConnectionResult::Sessions { pane, result } => {
                            let update = match result {
                                Ok(list) => app.update(AppEvent::SessionsLoaded {
                                    pane,
                                    sessions: session_summaries(&list, &runtime.workspace),
                                }),
                                Err(error) => app.update(AppEvent::SessionLoadFailed {
                                    pane,
                                    error: format!("Could not load managed sessions: {error}"),
                                }),
                            };
                            stopping = apply_update(update, &mut app, &mut runtime, &mut terminal, &mut scheduler).await?;
                        }
                        ConnectionResult::Agent { purpose, result: Ok((agent, events, agent_id, workspace, history, warning)) } => {
                            runtime.retry_target = None;
                            let (mut records, mut sequence, mut prompts) =
                                match history_projection(history, &agent_id, &workspace) {
                                    Ok(projection) => projection,
                                    Err(error) => {
                                        request_render(app.update(AppEvent::NotifyError {
                                            pane: PaneId::Main,
                                            error: format!("Durable event history is unavailable: {error}"),
                                        }), &mut scheduler);
                                        (Vec::new(), 1, Vec::new())
                                    }
                                };
                            if matches!(purpose, ConnectionPurpose::Startup)
                                && let Some((_, id, submission)) = runtime.pending_submission.as_ref()
                            {
                                let text = submission.display_text().to_owned();
                                records.push(Arc::new(TranscriptRecord::from_local(
                                    sequence,
                                    unix_ms(),
                                    LocalEvent::UserSubmitted { id: *id, text: text.clone() },
                                ).map_err(|error| ManagedError::Configuration(format!("TUI transcript error: {error}")))?));
                                sequence = sequence.saturating_add(1);
                                prompts.insert(0, RecentPrompt {
                                    text,
                                    recorded_at_unix_ms: unix_ms(),
                                    session_id: agent_id.clone(),
                                    workspace: workspace.clone(),
                                });
                            }
                            if let Some(previous) = runtime.agent.replace(agent) {
                                runtime.connection.spawn(async move {
                                    ConnectionResult::Disconnected(previous.disconnect().await)
                                });
                            }
                            runtime.events = Some(events);
                            runtime.events_open = true;
                            runtime.agent_id = agent_id;
                            runtime.workspace = workspace;
                            runtime.sequence = sequence;
                            runtime.next_turn = runtime.next_turn.max(sequence);
                            runtime.recent_prompts = prompts;
                            let pane = match purpose {
                                ConnectionPurpose::Startup => PaneId::Main,
                                ConnectionPurpose::Resume(pane) | ConnectionPurpose::New(pane) => pane,
                            };
                            let update = match purpose {
                                ConnectionPurpose::New(pane) => app.update(AppEvent::NewSessionReady {
                                    pane,
                                    effort: ReasoningEffort::Medium,
                                    reasoning_mode: ReasoningMode::Standard,
                                    fast_mode: false,
                                    model: Model::Sol,
                                    draft_reset: DraftReset::Clear,
                                    skills: Arc::from([]),
                                }),
                                ConnectionPurpose::Startup | ConnectionPurpose::Resume(_) => {
                                    let projection = RootNode::project_session(ReasoningEffort::Medium, records);
                                    app.update(AppEvent::SessionRestored {
                                        pane,
                                        projection: Box::new(projection),
                                        effort: ReasoningEffort::Medium,
                                        reasoning_mode: ReasoningMode::Standard,
                                        preferred_reasoning_mode: ReasoningMode::Standard,
                                        fast_mode: false,
                                        model: Model::Sol,
                                        skills: Arc::from([]),
                                    })
                                }
                            };
                            request_render(update, &mut scheduler);
                            if let Some(warning) = warning {
                                request_render(app.update(AppEvent::NotifyError {
                                    pane: PaneId::Main,
                                    error: warning,
                                }), &mut scheduler);
                            }
                            if matches!(purpose, ConnectionPurpose::Startup)
                                && runtime.active_shells == 0
                                && let Some((pane, id, prompt)) = runtime.pending_submission.take()
                            {
                                runtime.start_submission(pane, id, prompt);
                            }
                        }
                        ConnectionResult::Agent { purpose, result: Err(failure) } => {
                            let message = format!("Could not connect to the managed agent: {}", failure.error);
                            if matches!(purpose, ConnectionPurpose::Startup) {
                                runtime.retry_target = Some(failure.retry);
                            }
                            let update = match purpose {
                                ConnectionPurpose::Startup => app.update(AppEvent::NotifyError {
                                    pane: PaneId::Main,
                                    error: message.clone(),
                                }),
                                ConnectionPurpose::Resume(pane) => app.update(AppEvent::SessionLoadFailed {
                                    pane,
                                    error: message.clone(),
                                }),
                                ConnectionPurpose::New(pane) => app.update(AppEvent::NewSessionFailed {
                                    pane,
                                    error: message.clone(),
                                }),
                            };
                            request_render(update, &mut scheduler);
                            if matches!(purpose, ConnectionPurpose::Startup)
                                && let Some((pane, id, _)) = runtime.pending_submission.take()
                            {
                                let record = runtime.local_record(LocalEvent::WorkerTurnFinished {
                                    id,
                                    error: Some(message),
                                })?;
                                request_render(app.update(AppEvent::Transcript { pane, record }), &mut scheduler);
                                request_render(app.update(AppEvent::WorkerTurnFinished {
                                    pane,
                                    terminal_expected: false,
                                }), &mut scheduler);
                            }
                        }
                        ConnectionResult::Disconnected(Err(error)) => {
                            request_render(app.update(AppEvent::NotifyError {
                                pane: PaneId::Main,
                                error: format!("Previous managed connection did not detach cleanly: {error}"),
                            }), &mut scheduler);
                        }
                        ConnectionResult::Disconnected(Ok(())) => {}
                    }
                }
            }
            result = runtime.admissions.join_next(), if !runtime.admissions.is_empty() => {
                if let Some(result) = result {
                    let (pane, id, admission) = result.map_err(|error| ManagedError::Configuration(format!("prompt task failed: {error}")))?;
                    runtime.admitting.remove(&id);
                    let cancelled_after_admission = runtime.cancel_after_admission.remove(&id);
                    let mut updates = Vec::new();
                    match admission {
                        Ok(turn) => {
                            let control = turn.control();
                            runtime.controls.insert(id, control.clone());
                            let record = runtime.local_record(LocalEvent::WorkerTurnAccepted { id })?;
                            updates.push(app.update(AppEvent::Transcript { pane, record }));
                            runtime.completions.spawn(async move { (pane, id, turn.await) });
                            if cancelled_after_admission {
                                runtime.cancel_controls(pane, vec![(id, control)]);
                            }
                        }
                        Err(error) => {
                            let record = runtime.local_record(LocalEvent::WorkerTurnFinished {
                                id,
                                error: Some(error.to_string()),
                            })?;
                            updates.push(app.update(AppEvent::Transcript { pane, record }));
                            updates.push(app.update(AppEvent::WorkerTurnFinished { pane, terminal_expected: false }));
                        }
                    }
                    for update in updates {
                        stopping |= apply_update(update, &mut app, &mut runtime, &mut terminal, &mut scheduler).await?;
                    }
                    if cancelled_after_admission
                        && runtime.cancel_after_admission.is_empty()
                        && runtime.cancellations.is_empty()
                        && runtime.cancelling_controls.is_empty()
                    {
                        let update = if runtime.cancellation_failed {
                            runtime.cancellation_failed = false;
                            app.update(AppEvent::NotifyError {
                                pane,
                                error: "One or more managed cancellation requests failed."
                                    .to_owned(),
                            })
                        } else {
                            app.update(AppEvent::TurnsCancelled(pane))
                        };
                        stopping |= apply_update(update, &mut app, &mut runtime, &mut terminal, &mut scheduler).await?;
                    }
                }
            }
            result = runtime.completions.join_next(), if !runtime.completions.is_empty() => {
                if let Some(result) = result {
                    let (pane, id, outcome) = result.map_err(|error| ManagedError::Configuration(format!("turn task failed: {error}")))?;
                    runtime.controls.remove(&id);
                    let error = outcome.err().map(|error| error.to_string());
                    let record = runtime.local_record(LocalEvent::WorkerTurnFinished { id, error })?;
                    request_render(app.update(AppEvent::Transcript { pane, record }), &mut scheduler);
                    let update = app.update(AppEvent::WorkerTurnFinished { pane, terminal_expected: true });
                    stopping = apply_update(update, &mut app, &mut runtime, &mut terminal, &mut scheduler).await?;
                }
            }
            result = runtime.steers.join_next(), if !runtime.steers.is_empty() => {
                if let Some(result) = result {
                    let (pane, id, outcome) = result.map_err(|error| ManagedError::Configuration(format!("steer task failed: {error}")))?;
                    let update = match outcome {
                        Ok(()) => app.update(AppEvent::SteerAdmitted { pane, id }),
                        Err(error) => {
                            request_render(app.update(AppEvent::NotifyError { pane, error: format!("Could not steer turn: {error}") }), &mut scheduler);
                            app.update(AppEvent::SteerFailed { pane, id })
                        }
                    };
                    stopping = apply_update(update, &mut app, &mut runtime, &mut terminal, &mut scheduler).await?;
                }
            }
            result = runtime.cancellations.join_next(), if !runtime.cancellations.is_empty() => {
                if let Some(result) = result {
                    let (pane, ids, error) = result.map_err(|error| ManagedError::Configuration(format!("cancel task failed: {error}")))?;
                    for id in &ids {
                        runtime.cancelling_controls.remove(id);
                    }
                    runtime.cancellation_failed |= error.is_some();
                    let count = ids.len();
                    let record = runtime.local_record(LocalEvent::WorkerTurnsInterrupted {
                        count,
                        error: error.clone(),
                    })?;
                    request_render(app.update(AppEvent::Transcript { pane, record }), &mut scheduler);
                    if runtime.cancel_after_admission.is_empty()
                        && runtime.cancellations.is_empty()
                        && runtime.cancelling_controls.is_empty()
                    {
                        let update = if runtime.cancellation_failed {
                            runtime.cancellation_failed = false;
                            app.update(AppEvent::NotifyError {
                                pane,
                                error: error.unwrap_or_else(|| {
                                    "One or more managed cancellation requests failed.".to_owned()
                                }),
                            })
                        } else {
                            app.update(AppEvent::TurnsCancelled(pane))
                        };
                        stopping = apply_update(update, &mut app, &mut runtime, &mut terminal, &mut scheduler).await?;
                    }
                }
            }
            result = runtime.shells.join_next(), if !runtime.shells.is_empty() => {
                if let Some(result) = result {
                    let (pane, execution) = result.map_err(|error| ManagedError::Configuration(format!("shell task failed: {error}")))?;
                    runtime.active_shells = runtime.active_shells.saturating_sub(1);
                    runtime.shell_context.push(execution.model_context());
                    let record = runtime.local_record(LocalEvent::ShellFinished {
                        id: execution.id,
                        output: execution.output,
                        exit_code: execution.exit_code,
                        duration_ns: execution.duration_ns,
                        truncated: execution.truncated,
                        error: execution.error,
                    })?;
                    request_render(app.update(AppEvent::Transcript { pane, record }), &mut scheduler);
                    request_render(app.update(AppEvent::ShellFinished(pane)), &mut scheduler);
                    if runtime.active_shells == 0
                        && let Some((pane, id, prompt)) = runtime.pending_submission.take()
                    {
                        runtime.start_submission(pane, id, prompt);
                    }
                }
            }
            () = wait_until(render_deadline), if render_deadline.is_some() => {}
            () = wait_until(animation_deadline), if animation_deadline.is_some() => {
                let update = app.update(AppEvent::AnimationFrame(Instant::now()));
                stopping = apply_update(update, &mut app, &mut runtime, &mut terminal, &mut scheduler).await?;
            }
        }
    }

    drop(terminal);
    let Some(agent) = runtime.agent.take() else {
        return Ok(());
    };
    if runtime.idle() {
        agent.shutdown().await.map_err(super::agent_error)
    } else {
        agent.disconnect().await.map_err(super::agent_error)
    }
}

async fn apply_update(
    update: ComponentUpdate<AppEffect>,
    app: &mut AppNode,
    runtime: &mut DriverRuntime,
    terminal: &mut TerminalSession,
    scheduler: &mut RenderScheduler,
) -> Result<bool, ManagedError> {
    let mut effects = VecDeque::from(update.effects);
    request_render_only(update.render, scheduler);
    let mut stopping = false;
    while let Some(effect) = effects.pop_front() {
        match effect {
            AppEffect::Shutdown => stopping = true,
            AppEffect::SetTheme(_) => scheduler.request_immediate(Instant::now()),
            AppEffect::OpenFork { pane, .. } => {
                absorb(
                    app.update(AppEvent::ForkFailed {
                        pane,
                        error: "Hosted agents do not expose client-side forks.".to_owned(),
                    }),
                    &mut effects,
                    scheduler,
                );
            }
            AppEffect::ClosePane(_) => {}
            AppEffect::Pane { pane, effect } => {
                match effect {
                    RootEffect::Submit(prompt) | RootEffect::ContinueSubagent(prompt) => {
                        let id = TurnId::new(runtime.next_turn);
                        runtime.next_turn = runtime.next_turn.saturating_add(1);
                        let text = prompt.display_text().to_owned();
                        let recorded_at_unix_ms = unix_ms();
                        runtime.recent_prompts.insert(
                            0,
                            RecentPrompt {
                                text: text.clone(),
                                recorded_at_unix_ms,
                                session_id: runtime.agent_id.clone(),
                                workspace: runtime.workspace.clone(),
                            },
                        );
                        runtime.recent_prompts.truncate(100);
                        let record =
                            runtime.local_record(LocalEvent::UserSubmitted { id, text })?;
                        absorb(
                            app.update(AppEvent::Transcript { pane, record }),
                            &mut effects,
                            scheduler,
                        );
                        if runtime.active_shells == 0 {
                            runtime.start_submission(pane, id, prompt);
                        } else {
                            runtime.pending_submission = Some((pane, id, prompt));
                        }
                    }
                    RootEffect::RunShell(command) => {
                        let id = ShellId::new(runtime.next_shell);
                        runtime.next_shell = runtime.next_shell.saturating_add(1);
                        runtime.active_shells = runtime.active_shells.saturating_add(1);
                        let record = runtime.local_record(LocalEvent::ShellStarted {
                            id,
                            command: command.clone(),
                            workspace: runtime.workspace.clone(),
                        })?;
                        absorb(
                            app.update(AppEvent::Transcript { pane, record }),
                            &mut effects,
                            scheduler,
                        );
                        let workspace = runtime.workspace.clone();
                        runtime.shells.spawn(async move {
                            (pane, shell::execute(id, command, workspace).await)
                        });
                    }
                    RootEffect::Steer { id, prompt } => {
                        if let Some(control) = runtime.controls.values().next().cloned() {
                            runtime.steers.spawn(async move {
                                let result = control.steer(prompt.agent_prompt()).await;
                                (pane, id, result)
                            });
                        } else {
                            let turn_id = TurnId::new(runtime.next_turn);
                            runtime.next_turn = runtime.next_turn.saturating_add(1);
                            let record = runtime.local_record(LocalEvent::UserSubmitted {
                                id: turn_id,
                                text: prompt.display_text().to_owned(),
                            })?;
                            absorb(
                                app.update(AppEvent::Transcript { pane, record }),
                                &mut effects,
                                scheduler,
                            );
                            absorb(
                                app.update(AppEvent::SteerPromoted { pane, id }),
                                &mut effects,
                                scheduler,
                            );
                            runtime.start_submission(pane, turn_id, prompt);
                        }
                    }
                    RootEffect::PersistSteer(text) => {
                        let record = runtime.local_record(LocalEvent::UserSteered { text })?;
                        absorb(
                            app.update(AppEvent::Transcript { pane, record }),
                            &mut effects,
                            scheduler,
                        );
                    }
                    RootEffect::CancelTurns => {
                        if runtime.cancellations.is_empty()
                            && runtime.cancelling_controls.is_empty()
                        {
                            runtime.cancellation_failed = false;
                        }
                        if let Some((pending_pane, id, _)) = runtime.pending_submission.take() {
                            let record = runtime.local_record(LocalEvent::WorkerTurnFinished {
                                id,
                                error: Some("cancelled before managed admission".to_owned()),
                            })?;
                            absorb(
                                app.update(AppEvent::Transcript {
                                    pane: pending_pane,
                                    record,
                                }),
                                &mut effects,
                                scheduler,
                            );
                            absorb(
                                app.update(AppEvent::WorkerTurnFinished {
                                    pane: pending_pane,
                                    terminal_expected: false,
                                }),
                                &mut effects,
                                scheduler,
                            );
                        }
                        runtime
                            .cancel_after_admission
                            .extend(runtime.admitting.iter().copied());
                        let controls = runtime
                            .controls
                            .iter()
                            .filter(|(id, _)| !runtime.cancelling_controls.contains(id))
                            .map(|(id, control)| (*id, control.clone()))
                            .collect::<Vec<_>>();
                        runtime.cancel_controls(pane, controls);
                        if runtime.cancel_after_admission.is_empty()
                            && runtime.cancellations.is_empty()
                            && runtime.cancelling_controls.is_empty()
                        {
                            absorb(
                                app.update(AppEvent::TurnsCancelled(pane)),
                                &mut effects,
                                scheduler,
                            );
                        }
                    }
                    RootEffect::Copy(text) => {
                        if terminal.copy_to_clipboard(&text).is_err() {
                            let _ = clipboard::copy_text(&text);
                        }
                    }
                    RootEffect::SetTheme(_) => {}
                    RootEffect::LoadSessions(_) => {
                        let client = runtime.client.clone();
                        runtime.connection.spawn(async move {
                            ConnectionResult::Sessions {
                                pane,
                                result: client.list().await,
                            }
                        });
                    }
                    RootEffect::LoadRecentPrompts(_) => {
                        absorb(
                            app.update(AppEvent::RecentPromptsLoaded {
                                pane,
                                session_id: runtime.agent_id.clone(),
                                prompts: runtime.recent_prompts.clone(),
                            }),
                            &mut effects,
                            scheduler,
                        );
                    }
                    RootEffect::ResumeSession(agent_id) => {
                        if !runtime.idle() {
                            absorb(app.update(AppEvent::SessionLoadFailed {
                            pane,
                            error: "Finish or interrupt the active work before switching agents.".to_owned(),
                        }), &mut effects, scheduler);
                            continue;
                        }
                        let client = runtime.client.clone();
                        runtime.connection.spawn(async move {
                            ConnectionResult::Agent {
                                purpose: ConnectionPurpose::Resume(pane),
                                result: connect_agent(client, Some(agent_id)).await,
                            }
                        });
                    }
                    RootEffect::NewSession(_) => {
                        if !runtime.idle() {
                            absorb(
                                app.update(AppEvent::NewSessionFailed {
                                    pane,
                                    error: "Finish or interrupt the active work first.".to_owned(),
                                }),
                                &mut effects,
                                scheduler,
                            );
                            continue;
                        }
                        let client = runtime.client.clone();
                        runtime.connection.spawn(async move {
                            ConnectionResult::Agent {
                                purpose: ConnectionPurpose::New(pane),
                                result: connect_agent(client, None).await,
                            }
                        });
                    }
                    RootEffect::Reflect(prompt) => {
                        let id = TurnId::new(runtime.next_turn);
                        runtime.next_turn = runtime.next_turn.saturating_add(1);
                        let prompt = prompt.prepend_text(
                        "Reflect on this managed conversation and return a concise, actionable report.".to_owned(),
                    );
                        runtime.start_submission(pane, id, prompt);
                    }
                    RootEffect::OpenLink(destination) => open_link(&destination),
                    RootEffect::OpenDraftEditor => {
                        if !runtime.idle() {
                            absorb(
                                app.update(AppEvent::NotifyError {
                                    pane,
                                    error:
                                        "Finish or interrupt active work before opening $EDITOR."
                                            .to_owned(),
                                }),
                                &mut effects,
                                scheduler,
                            );
                            continue;
                        }
                        if app
                            .root(pane)
                            .is_some_and(|root| root.composer().has_images())
                        {
                            absorb(
                                app.update(AppEvent::NotifyError {
                                    pane,
                                    error: "$EDITOR is unavailable for drafts containing images."
                                        .to_owned(),
                                }),
                                &mut effects,
                                scheduler,
                            );
                            continue;
                        }
                        let draft = app
                            .root(pane)
                            .expect("editor pane must exist")
                            .composer()
                            .draft()
                            .to_owned();
                        terminal.suspend().map_err(terminal_error)?;
                        let outcome = editor::edit(&draft, &runtime.workspace).await;
                        terminal.resume().map_err(terminal_error)?;
                        terminal.invalidate_cursor_visibility();
                        app.refresh_terminal_images();
                        match outcome {
                            Ok(editor::EditorOutcome::Updated(draft)) => absorb(
                                app.update(AppEvent::EditorDraft { pane, draft }),
                                &mut effects,
                                scheduler,
                            ),
                            Ok(editor::EditorOutcome::Unchanged) => {
                                scheduler.request_immediate(Instant::now());
                            }
                            Err(error) => absorb(
                                app.update(AppEvent::NotifyError {
                                    pane,
                                    error: format!("Could not edit draft: {error}"),
                                }),
                                &mut effects,
                                scheduler,
                            ),
                        }
                    }
                    RootEffect::OpenConfigEditor | RootEffect::ReloadConfig => {
                        absorb(app.update(AppEvent::ConfigReloadFailed {
                        pane,
                        error: "Nanocodex2 is configured by the hosted account and environment.".to_owned(),
                    }), &mut effects, scheduler);
                    }
                    RootEffect::SetModel(_)
                    | RootEffect::SetEffort { .. }
                    | RootEffect::SetFastMode(_)
                    | RootEffect::SetMaxSubagents(_) => {
                        absorb(
                            app.update(AppEvent::NotifyError {
                                pane,
                                error: "This setting is controlled by the hosted agent.".to_owned(),
                            }),
                            &mut effects,
                            scheduler,
                        );
                    }
                    RootEffect::Handoff => absorb(
                        app.update(AppEvent::HandoffFailed {
                            pane,
                            error: "Hosted handoff is not exposed by this client.".to_owned(),
                        }),
                        &mut effects,
                        scheduler,
                    ),
                    RootEffect::Review { .. } => absorb(
                        app.update(AppEvent::ReviewFailed {
                            pane,
                            error: "Hosted review is not exposed by this client.".to_owned(),
                        }),
                        &mut effects,
                        scheduler,
                    ),
                    RootEffect::CancelReview => absorb(
                        app.update(AppEvent::ReviewCancelled(pane)),
                        &mut effects,
                        scheduler,
                    ),
                    RootEffect::CancelHandoff => absorb(
                        app.update(AppEvent::HandoffCancelled(pane)),
                        &mut effects,
                        scheduler,
                    ),
                    RootEffect::Fork | RootEffect::Shutdown => {
                        unreachable!("application-level effects are mapped by AppNode")
                    }
                }
            }
        }
    }
    Ok(stopping)
}

fn absorb(
    update: ComponentUpdate<AppEffect>,
    effects: &mut VecDeque<AppEffect>,
    scheduler: &mut RenderScheduler,
) {
    effects.extend(update.effects);
    request_render_only(update.render, scheduler);
}

fn request_render(update: ComponentUpdate<AppEffect>, scheduler: &mut RenderScheduler) {
    debug_assert!(update.effects.is_empty());
    request_render_only(update.render, scheduler);
}

fn request_render_only(request: RenderRequest, scheduler: &mut RenderScheduler) {
    match request {
        RenderRequest::None => {}
        RenderRequest::Streaming => scheduler.request_streaming(Instant::now()),
        RenderRequest::Immediate => scheduler.request_immediate(Instant::now()),
    }
}

async fn wait_until(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline.into()).await,
        None => pending::<()>().await,
    }
}

async fn load_event_history(
    client: &ManagedClient,
    agent_id: &str,
    through: &EventCursor,
) -> Result<Vec<ManagedEvent>, ManagedError> {
    let mut pages = Vec::new();
    let mut before = None;
    loop {
        let page = client.history(agent_id, before.as_deref(), 256).await?;
        if page.data.is_empty() {
            if page.has_more {
                return Err(ManagedError::InvalidResponse(
                    "managed history reports an empty nonterminal page",
                ));
            }
            break;
        }
        before = page.data.first().map(|event| event.cursor.clone());
        pages.push(page.data);
        if !page.has_more {
            break;
        }
    }
    pages.reverse();
    Ok(pages
        .into_iter()
        .flatten()
        .filter(|event| cursor_at_or_before(&event.cursor, through.as_str()))
        .collect())
}

fn history_projection(
    history: Vec<ManagedEvent>,
    agent_id: &str,
    workspace: &Path,
) -> Result<HistoryProjection, ManagedError> {
    let mut records = Vec::new();
    let mut sequence = 1_u64;
    let mut recent = Vec::new();
    for (index, event) in history.into_iter().enumerate() {
        let timestamp = managed_timestamp(event.created_at, index);
        match event.data {
            ManagedEventData::TurnAccepted { input, .. } => {
                let text = prompt_input_text(&input);
                let record = TranscriptRecord::from_local(
                    sequence,
                    timestamp,
                    LocalEvent::UserSubmitted {
                        id: TurnId::new(sequence),
                        text: text.clone(),
                    },
                )
                .map_err(|error| {
                    ManagedError::Configuration(format!("TUI history error: {error}"))
                })?;
                recent.push(RecentPrompt {
                    text,
                    recorded_at_unix_ms: timestamp,
                    session_id: agent_id.to_owned(),
                    workspace: workspace.to_path_buf(),
                });
                records.push(Arc::new(record));
                sequence = sequence.saturating_add(1);
            }
            ManagedEventData::Event { event } => {
                let event: AgentEvent = serde_json::from_str(event.get()).map_err(|error| {
                    ManagedError::Configuration(format!(
                        "invalid retained agent event in TUI history: {error}"
                    ))
                })?;
                records.push(Arc::new(TranscriptRecord::from_agent(
                    sequence, timestamp, event,
                )));
                sequence = sequence.saturating_add(1);
            }
            ManagedEventData::TurnFailed { error, .. }
            | ManagedEventData::TurnRetryable { error, .. } => {
                let record = TranscriptRecord::from_local(
                    sequence,
                    timestamp,
                    LocalEvent::WorkerTurnFinished {
                        id: TurnId::new(sequence),
                        error: Some(error),
                    },
                )
                .map_err(|error| {
                    ManagedError::Configuration(format!("TUI history error: {error}"))
                })?;
                records.push(Arc::new(record));
                sequence = sequence.saturating_add(1);
            }
            ManagedEventData::AgentCreated { .. }
            | ManagedEventData::TurnCancelling { .. }
            | ManagedEventData::TurnCompleted { .. }
            | ManagedEventData::TurnCancelled { .. }
            | ManagedEventData::StreamFailed { .. } => {}
        }
    }
    recent.reverse();
    Ok((records, sequence, recent))
}

fn cursor_at_or_before(cursor: &str, through: &str) -> bool {
    through == "latest"
        || cursor.len() < through.len()
        || (cursor.len() == through.len() && cursor <= through)
}

fn prompt_input_text(input: &PromptInput) -> String {
    match input {
        PromptInput::Text(text) => text.clone(),
        PromptInput::Content(content) => content
            .iter()
            .map(|item| match item {
                PromptContent::Text { text } => text.as_str(),
                PromptContent::Image { .. } => "[image attachment]",
                PromptContent::Audio { .. } => "[audio attachment]",
            })
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

fn managed_timestamp(created_at: Option<f64>, fallback_offset: usize) -> u64 {
    let Some(mut timestamp) = created_at.filter(|timestamp| timestamp.is_finite()) else {
        return unix_ms().saturating_add(u64::try_from(fallback_offset).unwrap_or(u64::MAX));
    };
    if timestamp < 10_000_000_000.0 {
        timestamp *= 1_000.0;
    }
    timestamp.max(0.0) as u64
}

fn session_summaries(list: &AgentList, workspace: &Path) -> Vec<SessionSummary> {
    list.data
        .iter()
        .filter_map(|agent_id| {
            let summary = list.summaries.get(agent_id)?;
            let timestamp = if summary.created_at < 10_000_000_000.0 {
                summary.created_at * 1_000.0
            } else {
                summary.created_at
            };
            Some(SessionSummary {
                session_id: agent_id.clone(),
                started_at_unix_ms: timestamp.max(0.0) as u64,
                model: Model::Sol.to_string(),
                effort: ReasoningEffort::Medium,
                reasoning_mode: ReasoningMode::Standard,
                workspace: workspace.to_path_buf(),
                preview: summary.title.clone(),
            })
        })
        .collect()
}

fn inject_shell_context(context: &mut Vec<String>, prompt: Submission) -> Submission {
    if context.is_empty() {
        return prompt;
    }
    let prefix = context.join("\n\n");
    context.clear();
    prompt.prepend_text(prefix)
}

fn is_image_paste(event: &Event) -> bool {
    matches!(
        event,
        Event::Key(key)
            if matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat)
                && key.code == KeyCode::Char('v')
                && key.modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::SUPER)
    )
}

fn open_link(destination: &str) {
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("cmd");
        command.args(["/C", "start", ""]);
        command
    };
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    return;
    let _ = command.arg(destination).spawn();
}

fn unix_ms() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(u64::MAX)
}

fn terminal_error(error: io::Error) -> ManagedError {
    ManagedError::Configuration(format!("terminal error: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{cursor_at_or_before, history_projection, session_summaries};
    use nanocodex_managed::{AgentList, AgentSummary, ManagedEvent, ManagedEventData, PromptInput};
    use serde_json::{json, value::to_raw_value};
    use std::{collections::BTreeMap, path::Path};

    #[test]
    fn managed_history_projects_into_tact_user_and_assistant_records() {
        let agent_event = to_raw_value(&json!({
            "protocol_version": 1,
            "request_id": "request-1",
            "seq": 2,
            "type": "assistant.message",
            "payload": {
                "model_call_index": 0,
                "item_id": null,
                "phase": null,
                "text": "done"
            }
        }))
        .unwrap();
        let history = vec![
            ManagedEvent {
                cursor: "1".to_owned(),
                created_at: Some(1_750_000_000.0),
                turn_id: Some("turn-1".to_owned()),
                data: ManagedEventData::TurnAccepted {
                    id: "turn-1".to_owned(),
                    input: PromptInput::Text("inspect the tree".to_owned()),
                    replayed: false,
                },
            },
            ManagedEvent {
                cursor: "2".to_owned(),
                created_at: Some(1_750_000_001.0),
                turn_id: Some("turn-1".to_owned()),
                data: ManagedEventData::Event { event: agent_event },
            },
        ];

        let (records, next_sequence, recent) =
            history_projection(history, "agent-1", Path::new("/workspace")).unwrap();

        assert_eq!(records.len(), 2);
        assert_eq!(
            (records[0].source(), records[0].kind()),
            ("tact", "user.submitted")
        );
        assert_eq!(
            (records[1].source(), records[1].kind()),
            ("agent", "assistant.message")
        );
        assert_eq!(next_sequence, 3);
        assert_eq!(recent[0].text, "inspect the tree");
    }

    #[test]
    fn durable_history_is_fenced_through_the_live_stream_cursor() {
        assert!(cursor_at_or_before("9", "10"));
        assert!(cursor_at_or_before("10", "10"));
        assert!(!cursor_at_or_before("11", "10"));
        assert!(cursor_at_or_before("999", "latest"));
    }

    #[test]
    fn managed_agent_ids_remain_the_resume_picker_identity() {
        let list = AgentList {
            data: vec!["agent-1".to_owned()],
            summaries: BTreeMap::from([(
                "agent-1".to_owned(),
                AgentSummary {
                    title: "A durable task".to_owned(),
                    created_at: 1_750_000_000.0,
                    updated_at: 1_750_000_100.0,
                    turn_count: 2,
                },
            )]),
        };

        let sessions = session_summaries(&list, Path::new("/workspace"));

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "agent-1");
        assert_eq!(sessions[0].preview, "A durable task");
        assert_eq!(sessions[0].started_at_unix_ms, 1_750_000_000_000);
    }
}
