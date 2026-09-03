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
    Nanocodex, NanocodexError, Turn, TurnControl, TurnResult, events::AgentEvent,
};
use nanocodex_managed::{
    AgentList, AgentSettings, EventCursor, EventHistoryPage, ManagedClient, ManagedError,
    ManagedEvent, ManagedEventData, PromptContent, PromptInput,
    ReasoningMode as ManagedReasoningMode, Thinking,
};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    future::pending,
    io,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{sync::mpsc, task::JoinSet};

type Admission = (PaneId, TurnId, Result<Turn, NanocodexError>);
type Completion = (PaneId, TurnId, Result<TurnResult, NanocodexError>);
type SteerCompletion = (PaneId, components::QueueId, Result<(), NanocodexError>);
type CancelCompletion = (PaneId, Vec<TurnId>, Option<String>);
type SettingsCompletion = (
    PaneId,
    String,
    &'static str,
    Result<AgentSettings, ManagedError>,
);
type HistoryCompletion = (
    PaneId,
    String,
    u64,
    String,
    Result<EventHistoryPage, ManagedError>,
);
type HistoryProjection = (Vec<Arc<TranscriptRecord>>, u64, Vec<RecentPrompt>);
type LiveManagedProjection = (Arc<TranscriptRecord>, Option<RecentPrompt>);
type ConnectedAgent = (
    Nanocodex,
    mpsc::UnboundedReceiver<ManagedEvent>,
    String,
    PathBuf,
    HistoryWindow,
    Option<String>,
    AgentSettings,
    bool,
);

const HISTORY_PAGE_SIZE: u16 = 256;

#[derive(Clone, Default)]
struct HistoryWindow {
    events: Vec<ManagedEvent>,
    before: Option<String>,
    has_more: bool,
}

impl HistoryWindow {
    fn retry_from(before: String) -> Self {
        Self {
            events: Vec::new(),
            before: Some(before),
            has_more: true,
        }
    }

    fn from_page(requested_before: String, page: EventHistoryPage) -> Result<Self, ManagedError> {
        let mut window = Self::retry_from(requested_before);
        window.prepend(page)?;
        Ok(window)
    }

    fn prepend(&mut self, page: EventHistoryPage) -> Result<(), ManagedError> {
        if page.data.is_empty() && page.has_more {
            return Err(ManagedError::InvalidResponse(
                "managed history reports an empty nonterminal page",
            ));
        }
        self.before = page.data.first().map(|event| event.cursor.clone());
        self.has_more = page.has_more;
        let mut events = page.data;
        events.append(&mut self.events);
        self.events = events;
        Ok(())
    }
}

#[derive(Clone)]
enum RetryTarget {
    Create(AgentSettings),
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

#[derive(Clone, Copy)]
enum SettingsMutation {
    Complete(AgentSettings),
    Thinking(Thinking),
    FastMode(bool),
}

impl SettingsMutation {
    fn failure_subject(self) -> &'static str {
        match self {
            Self::Complete(_) => "select model",
            Self::Thinking(_) => "change thinking effort",
            Self::FastMode(_) => "change fast mode",
        }
    }
}

struct DriverRuntime {
    client: ManagedClient,
    agent: Option<Nanocodex>,
    managed_events: Option<mpsc::UnboundedReceiver<ManagedEvent>>,
    managed_events_open: bool,
    agent_id: String,
    settings: AgentSettings,
    pending_settings: Option<AgentSettings>,
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
    settings_updates: JoinSet<SettingsCompletion>,
    settings_queue: VecDeque<(PaneId, String, SettingsMutation)>,
    shells: JoinSet<(PaneId, ShellExecution)>,
    history_loads: JoinSet<HistoryCompletion>,
    history_generation: u64,
    history: HistoryWindow,
    history_sequences: HashMap<String, u64>,
    live_records: Vec<Arc<TranscriptRecord>>,
    live_prompts: Vec<RecentPrompt>,
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
        let record = Arc::new(record);
        self.live_records.push(Arc::clone(&record));
        Ok(record)
    }

    fn start_submission(&mut self, pane: PaneId, id: TurnId, prompt: Submission) {
        let prompt = inject_shell_context(&mut self.shell_context, prompt);
        if !self.settings_updates.is_empty() || !self.settings_queue.is_empty() {
            self.pending_submission = Some((pane, id, prompt));
            return;
        }
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

    fn queue_settings(&mut self, pane: PaneId, mutation: SettingsMutation) {
        self.settings_queue
            .push_back((pane, self.agent_id.clone(), mutation));
        self.start_next_settings_update();
    }

    fn start_next_settings_update(&mut self) {
        if !self.settings_updates.is_empty() {
            return;
        }
        let Some((pane, agent_id, mutation)) = self.settings_queue.pop_front() else {
            return;
        };
        let client = self.client.clone();
        self.settings_updates.spawn(async move {
            let result = match mutation {
                SettingsMutation::Complete(settings) => {
                    client.set_settings(&agent_id, settings).await
                }
                SettingsMutation::Thinking(thinking) => {
                    client.set_thinking(&agent_id, thinking).await
                }
                SettingsMutation::FastMode(enabled) => {
                    client.set_fast_mode(&agent_id, enabled).await
                }
            };
            (pane, agent_id, mutation.failure_subject(), result)
        });
    }

    fn spawn_connection(&mut self, purpose: ConnectionPurpose, target: RetryTarget) {
        if matches!(purpose, ConnectionPurpose::Startup) {
            self.retry_target = Some(target.clone());
        }
        let client = self.client.clone();
        let (agent_id, settings) = match target {
            RetryTarget::Create(settings) => (None, settings),
            RetryTarget::Agent(agent_id) => (Some(agent_id), AgentSettings::default()),
        };
        self.connection.spawn(async move {
            ConnectionResult::Agent {
                purpose,
                result: connect_agent(client, agent_id, settings).await,
            }
        });
    }

    fn idle(&self) -> bool {
        self.controls.is_empty()
            && self.admissions.is_empty()
            && self.completions.is_empty()
            && self.steers.is_empty()
            && self.cancellations.is_empty()
            && self.settings_updates.is_empty()
            && self.settings_queue.is_empty()
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
    create_settings: AgentSettings,
) -> Result<ConnectedAgent, ConnectionFailure> {
    let created = agent_id.is_none();
    let (managed_event_sender, managed_events) = mpsc::unbounded_channel();
    let (opened, history, history_before, retry, settings) = match agent_id {
        None => {
            let opened = super::open_workspace_agent_with_settings(
                &client,
                None,
                None,
                create_settings,
                Some(managed_event_sender),
            )
            .await;
            (
                opened,
                None,
                None,
                RetryTarget::Create(create_settings),
                create_settings,
            )
        }
        Some(agent_id) => {
            let state = client
                .state(&agent_id)
                .await
                .map_err(|error| ConnectionFailure {
                    error,
                    retry: RetryTarget::Agent(agent_id.clone()),
                })?;
            let cursor =
                EventCursor::parse(state.latest_event_cursor.clone()).map_err(|error| {
                    ConnectionFailure {
                        error,
                        retry: RetryTarget::Agent(agent_id.clone()),
                    }
                })?;
            let settings = state.settings;
            let opening = super::open_workspace_agent_from(
                &client,
                Some(agent_id.clone()),
                Some(state),
                Some(managed_event_sender),
            );
            let before = decimal_successor(cursor.as_str());
            let history = async {
                let page = client
                    .history(&agent_id, Some(&before), HISTORY_PAGE_SIZE)
                    .await?;
                HistoryWindow::from_page(before.clone(), page)
            };
            let (opened, history) = tokio::join!(opening, history);
            (
                opened,
                Some(history),
                Some(before),
                RetryTarget::Agent(agent_id),
                settings,
            )
        }
    };
    let (agent, _events, agent_id, workspace) =
        opened.map_err(|error| ConnectionFailure { error, retry })?;
    let (history, warning) = match history {
        None => (HistoryWindow::default(), None),
        Some(Ok(history)) => (history, None),
        Some(Err(error)) => {
            let before = history_before.expect("existing agents have a history cursor");
            (
                HistoryWindow::retry_from(before),
                Some(format!("Durable event history is unavailable: {error}")),
            )
        }
    };
    Ok((
        agent,
        managed_events,
        agent_id,
        workspace,
        history,
        warning,
        settings,
        created,
    ))
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
    let initial_settings = AgentSettings::default();
    let initial_effort = effort_from_thinking(initial_settings.thinking);
    let initial_reasoning_mode = reasoning_mode_from_managed(initial_settings.reasoning_mode);
    let mut root = RootNode::new(&workspace, initial_effort);
    root.set_fork_available(false);
    root.set_reasoning_modes(initial_reasoning_mode, initial_reasoning_mode);
    root.set_fast_mode(initial_settings.fast_mode);
    root.set_model(initial_settings.model);

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
        managed_events: None,
        managed_events_open: false,
        agent_id: String::new(),
        settings: initial_settings,
        pending_settings: None,
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
        settings_updates: JoinSet::new(),
        settings_queue: VecDeque::new(),
        shells: JoinSet::new(),
        history_loads: JoinSet::new(),
        history_generation: 0,
        history: HistoryWindow::default(),
        history_sequences: HashMap::new(),
        live_records: Vec::new(),
        live_prompts: Vec::new(),
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
            runtime.spawn_connection(
                ConnectionPurpose::Startup,
                RetryTarget::Create(AgentSettings::default()),
            );
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
                match runtime.managed_events.as_mut() {
                    Some(events) => events.recv().await,
                    None => pending().await,
                }
            }, if runtime.managed_events_open => {
                match event {
                    Some(event) => {
                        if let Some((record, prompt)) = live_managed_projection(
                            event,
                            &runtime.agent_id,
                            &runtime.workspace,
                            &mut runtime.sequence,
                        )? {
                            runtime.live_records.push(Arc::clone(&record));
                            if let Some(prompt) = prompt {
                                runtime.live_prompts.insert(0, prompt.clone());
                                runtime.live_prompts.truncate(100);
                                runtime.recent_prompts.insert(0, prompt);
                                runtime.recent_prompts.truncate(100);
                            }
                            let update = app.update(AppEvent::Transcript {
                                pane: PaneId::Main,
                                record,
                            });
                            stopping = apply_update(
                                update,
                                &mut app,
                                &mut runtime,
                                &mut terminal,
                                &mut scheduler,
                            )
                            .await?;
                        }
                    }
                    None => {
                        runtime.managed_events_open = false;
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
                        ConnectionResult::Agent { purpose, result: Ok((agent, managed_events, agent_id, workspace, history, warning, settings, created)) } => {
                            runtime.retry_target = None;
                            let requested_startup_settings = if created {
                                runtime.pending_settings.take()
                            } else {
                                None
                            };
                            let display_settings = requested_startup_settings.unwrap_or(settings);
                            runtime.history_generation = runtime.history_generation.wrapping_add(1);
                            runtime.history_loads.abort_all();
                            if !matches!(purpose, ConnectionPurpose::Startup) {
                                runtime.history_sequences.clear();
                                runtime.live_records.clear();
                                runtime.live_prompts.clear();
                                runtime.sequence = 1;
                            }
                            let (mut records, mut prompts) =
                                match history_projection_with_sequences(
                                    history.events.clone(),
                                    &agent_id,
                                    &workspace,
                                    &mut runtime.history_sequences,
                                    &mut runtime.sequence,
                                ) {
                                    Ok(projection) => projection,
                                    Err(error) => {
                                        request_render(app.update(AppEvent::NotifyError {
                                            pane: PaneId::Main,
                                            error: format!("Durable event history is unavailable: {error}"),
                                        }), &mut scheduler);
                                        (Vec::new(), Vec::new())
                                    }
                                };
                            if matches!(purpose, ConnectionPurpose::Startup) {
                                records.extend(runtime.live_records.iter().cloned());
                                let mut live_prompts = runtime.live_prompts.clone();
                                live_prompts.append(&mut prompts);
                                prompts = live_prompts;
                            }
                            if let Some(previous) = runtime.agent.replace(agent) {
                                runtime.connection.spawn(async move {
                                    ConnectionResult::Disconnected(previous.disconnect().await)
                                });
                            }
                            runtime.managed_events = Some(managed_events);
                            runtime.managed_events_open = true;
                            runtime.agent_id = agent_id;
                            runtime.settings = settings;
                            runtime.workspace = workspace;
                            runtime.next_turn = runtime.next_turn.max(runtime.sequence);
                            runtime.recent_prompts = prompts;
                            runtime.history = history;
                            let pane = match purpose {
                                ConnectionPurpose::Startup => PaneId::Main,
                                ConnectionPurpose::Resume(pane) | ConnectionPurpose::New(pane) => pane,
                            };
                            let update = match purpose {
                                ConnectionPurpose::New(pane) => app.update(AppEvent::NewSessionReady {
                                    pane,
                                    effort: effort_from_thinking(display_settings.thinking),
                                    reasoning_mode: reasoning_mode_from_managed(display_settings.reasoning_mode),
                                    fast_mode: display_settings.fast_mode,
                                    model: display_settings.model,
                                    draft_reset: DraftReset::Clear,
                                    skills: Arc::from([]),
                                }),
                                ConnectionPurpose::Startup
                                    if created && runtime.pending_submission.is_none() =>
                                {
                                    app.update(AppEvent::NewSessionReady {
                                        pane,
                                        effort: effort_from_thinking(display_settings.thinking),
                                        reasoning_mode: reasoning_mode_from_managed(
                                            display_settings.reasoning_mode,
                                        ),
                                        fast_mode: display_settings.fast_mode,
                                        model: display_settings.model,
                                        draft_reset: DraftReset::Preserve,
                                        skills: Arc::from([]),
                                    })
                                }
                                ConnectionPurpose::Startup | ConnectionPurpose::Resume(_) => {
                                    let effort = effort_from_thinking(settings.thinking);
                                    let reasoning_mode =
                                        reasoning_mode_from_managed(settings.reasoning_mode);
                                    let projection = RootNode::project_session(effort, records);
                                    app.update(AppEvent::SessionRestored {
                                        pane,
                                        projection: Box::new(projection),
                                        effort,
                                        reasoning_mode,
                                        preferred_reasoning_mode: reasoning_mode,
                                        fast_mode: settings.fast_mode,
                                        model: settings.model,
                                        skills: Arc::from([]),
                                    })
                                }
                            };
                            request_render(update, &mut scheduler);
                            if let Some(requested) = requested_startup_settings
                                && requested != settings
                            {
                                runtime.queue_settings(
                                    pane,
                                    SettingsMutation::Complete(requested),
                                );
                            }
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
                                if runtime.pending_settings.is_some() {
                                    request_render(
                                        app.update(AppEvent::SettingsHydrated {
                                            pane: PaneId::Main,
                                            effort: effort_from_thinking(
                                                runtime.settings.thinking,
                                            ),
                                            fast_mode: runtime.settings.fast_mode,
                                            model: runtime.settings.model,
                                        }),
                                        &mut scheduler,
                                    );
                                }
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
            result = runtime.settings_updates.join_next(), if !runtime.settings_updates.is_empty() => {
                if let Some(result) = result {
                    let (pane, agent_id, failure_subject, outcome) = result.map_err(|error| {
                        ManagedError::Configuration(format!("settings task failed: {error}"))
                    })?;
                    if agent_id == runtime.agent_id {
                        match outcome {
                            Ok(settings) => runtime.settings = settings,
                            Err(error) => request_render(
                                app.update(AppEvent::NotifyError {
                                    pane,
                                    error: format!("Could not {failure_subject}: {error}"),
                                }),
                                &mut scheduler,
                            ),
                        }
                    }
                    runtime.start_next_settings_update();
                    if runtime.settings_updates.is_empty() && runtime.settings_queue.is_empty() {
                        request_render(
                            app.update(AppEvent::SettingsHydrated {
                                pane,
                                effort: effort_from_thinking(runtime.settings.thinking),
                                fast_mode: runtime.settings.fast_mode,
                                model: runtime.settings.model,
                            }),
                            &mut scheduler,
                        );
                        if runtime.active_shells == 0
                            && let Some((pane, id, prompt)) = runtime.pending_submission.take()
                        {
                            runtime.start_submission(pane, id, prompt);
                        }
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
            result = runtime.history_loads.join_next(), if !runtime.history_loads.is_empty() => {
                if let Some(result) = result {
                    match result {
                        Err(error) => {
                            request_render(app.update(AppEvent::NotifyError {
                                pane: PaneId::Main,
                                error: format!("Older durable history task stopped unexpectedly: {error}"),
                            }), &mut scheduler);
                        }
                        Ok((pane, agent_id, generation, requested_before, result))
                            if agent_id == runtime.agent_id
                                && generation == runtime.history_generation
                                && runtime.history.before.as_deref() == Some(&requested_before) => match result {
                            Err(error) => {
                                request_render(app.update(AppEvent::NotifyError {
                                    pane,
                                    error: format!("Could not load older durable history: {error}"),
                                }), &mut scheduler);
                            }
                            Ok(page) => {
                                let mut candidate_history = runtime.history.clone();
                                match candidate_history.prepend(page) {
                                Err(error) => {
                                    request_render(app.update(AppEvent::NotifyError {
                                        pane,
                                        error: format!("Could not load older durable history: {error}"),
                                    }), &mut scheduler);
                                }
                                Ok(()) => {
                                    let mut candidate_sequences = runtime.history_sequences.clone();
                                    let mut candidate_sequence = runtime.sequence;
                                    match history_projection_with_sequences(
                                        candidate_history.events.clone(),
                                        &runtime.agent_id,
                                        &runtime.workspace,
                                        &mut candidate_sequences,
                                        &mut candidate_sequence,
                                    ) {
                                        Err(error) => request_render(app.update(AppEvent::NotifyError {
                                            pane,
                                            error: format!("Could not replay older durable history: {error}"),
                                        }), &mut scheduler),
                                        Ok((mut records, mut prompts)) => {
                                            runtime.history = candidate_history;
                                            runtime.history_sequences = candidate_sequences;
                                            runtime.sequence = candidate_sequence;
                                            runtime.next_turn = runtime.next_turn.max(runtime.sequence);
                                            records.extend(runtime.live_records.iter().cloned());
                                            let mut live_prompts = runtime.live_prompts.clone();
                                            live_prompts.append(&mut prompts);
                                            runtime.recent_prompts = live_prompts;
                                            let projection = RootNode::project_open_session(
                                                effort_from_thinking(runtime.settings.thinking),
                                                records,
                                            );
                                            request_render(app.update(AppEvent::HistoryReplayed {
                                                pane,
                                                projection: Box::new(projection),
                                            }), &mut scheduler);
                                        }
                                    }
                                }
                            }
                            },
                        },
                        Ok(_) => {}
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
                // Keep the hosted effect boundary visually separate from app-level routing.
                match effect {
                    RootEffect::Submit(prompt) | RootEffect::ContinueSubagent(prompt) => {
                        let id = TurnId::new(runtime.next_turn);
                        runtime.next_turn = runtime.next_turn.saturating_add(1);
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
                    RootEffect::LoadOlderHistory => {
                        if runtime.history.has_more
                            && runtime.history_loads.is_empty()
                            && let Some(before) = runtime.history.before.clone()
                        {
                            let client = runtime.client.clone();
                            let agent_id = runtime.agent_id.clone();
                            let generation = runtime.history_generation;
                            runtime.history_loads.spawn(async move {
                                let result = client
                                    .history(&agent_id, Some(&before), HISTORY_PAGE_SIZE)
                                    .await;
                                (pane, agent_id, generation, before, result)
                            });
                        }
                    }
                    RootEffect::ResumeSession(agent_id) => {
                        if !runtime.idle() {
                            absorb(
                            app.update(AppEvent::SessionLoadFailed {
                                pane,
                                error:
                                    "Finish or interrupt the active work before switching agents."
                                        .to_owned(),
                            }),
                            &mut effects,
                            scheduler,
                        );
                            continue;
                        }
                        let client = runtime.client.clone();
                        runtime.connection.spawn(async move {
                            ConnectionResult::Agent {
                                purpose: ConnectionPurpose::Resume(pane),
                                result: connect_agent(
                                    client,
                                    Some(agent_id),
                                    AgentSettings::default(),
                                )
                                .await,
                            }
                        });
                    }
                    RootEffect::NewSession(model) => {
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
                        let root = app.root(pane).expect("new-session pane must exist");
                        let settings = AgentSettings {
                            model,
                            thinking: thinking_from_effort(root.composer().effort()),
                            reasoning_mode: managed_reasoning_mode(root.preferred_reasoning_mode()),
                            fast_mode: root.composer().fast_mode(),
                        };
                        let client = runtime.client.clone();
                        runtime.connection.spawn(async move {
                            ConnectionResult::Agent {
                                purpose: ConnectionPurpose::New(pane),
                                result: connect_agent(client, None, settings).await,
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
                        absorb(
                        app.update(AppEvent::ConfigReloadFailed {
                            pane,
                            error:
                                "Nanocodex2 is configured by the hosted account and environment."
                                    .to_owned(),
                        }),
                        &mut effects,
                        scheduler,
                    );
                    }
                    RootEffect::SetModel(model) => {
                        let root = app.root(pane).expect("model-selection pane must exist");
                        let requested = AgentSettings {
                            model,
                            thinking: thinking_from_effort(root.composer().effort()),
                            reasoning_mode: managed_reasoning_mode(root.preferred_reasoning_mode()),
                            fast_mode: root.composer().fast_mode(),
                        };
                        if runtime.agent.is_none() {
                            runtime.settings = requested;
                            runtime.pending_settings = Some(requested);
                            if let Some(RetryTarget::Create(settings)) =
                                runtime.retry_target.as_mut()
                            {
                                *settings = requested;
                            }
                            continue;
                        }
                        runtime.queue_settings(pane, SettingsMutation::Complete(requested));
                    }
                    RootEffect::SetEffort { effort, .. } => {
                        let thinking = thinking_from_effort(effort);
                        if runtime.agent.is_none() {
                            runtime.settings.thinking = thinking;
                            runtime.pending_settings = Some(runtime.settings);
                            if let Some(RetryTarget::Create(settings)) =
                                runtime.retry_target.as_mut()
                            {
                                settings.thinking = thinking;
                            }
                            continue;
                        }
                        runtime.queue_settings(pane, SettingsMutation::Thinking(thinking));
                    }
                    RootEffect::SetFastMode(enabled) => {
                        if runtime.agent.is_none() {
                            runtime.settings.fast_mode = enabled;
                            runtime.pending_settings = Some(runtime.settings);
                            if let Some(RetryTarget::Create(settings)) =
                                runtime.retry_target.as_mut()
                            {
                                settings.fast_mode = enabled;
                            }
                            continue;
                        }
                        runtime.queue_settings(pane, SettingsMutation::FastMode(enabled));
                    }
                    RootEffect::SetMaxSubagents(_) => {
                        absorb(
                            app.update(AppEvent::NotifyError {
                                pane,
                                error: "Hosted subagent limits are not exposed by this client."
                                    .to_owned(),
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

fn decimal_successor(cursor: &str) -> String {
    let mut digits = cursor.as_bytes().to_vec();
    for digit in digits.iter_mut().rev() {
        if *digit < b'9' {
            *digit += 1;
            return String::from_utf8(digits).expect("decimal cursor remains UTF-8");
        }
        *digit = b'0';
    }
    let mut successor = String::with_capacity(digits.len().saturating_add(1));
    successor.push('1');
    successor.extend(digits.into_iter().map(char::from));
    successor
}

fn live_managed_projection(
    event: ManagedEvent,
    agent_id: &str,
    workspace: &Path,
    next_sequence: &mut u64,
) -> Result<Option<LiveManagedProjection>, ManagedError> {
    let timestamp = managed_timestamp(event.created_at, 0);
    let (record, prompt) = match event.data {
        ManagedEventData::TurnAccepted { input, .. } => {
            let text = prompt_input_text(&input);
            let record = TranscriptRecord::from_local(
                *next_sequence,
                timestamp,
                LocalEvent::UserSubmitted {
                    id: TurnId::new(*next_sequence),
                    text: text.clone(),
                },
            )
            .map_err(|error| {
                ManagedError::Configuration(format!("TUI managed event error: {error}"))
            })?;
            let prompt = RecentPrompt {
                text,
                recorded_at_unix_ms: timestamp,
                session_id: agent_id.to_owned(),
                workspace: workspace.to_path_buf(),
            };
            (record, Some(prompt))
        }
        ManagedEventData::Event { event } => {
            let event: AgentEvent = serde_json::from_str(event.get()).map_err(|error| {
                ManagedError::Configuration(format!(
                    "invalid live agent event in TUI stream: {error}"
                ))
            })?;
            (
                TranscriptRecord::from_agent(*next_sequence, timestamp, event),
                None,
            )
        }
        ManagedEventData::TurnFailed { error, .. }
        | ManagedEventData::TurnRetryable { error, .. } => {
            let record = TranscriptRecord::from_local(
                *next_sequence,
                timestamp,
                LocalEvent::WorkerTurnFinished {
                    id: TurnId::new(*next_sequence),
                    error: Some(error),
                },
            )
            .map_err(|error| {
                ManagedError::Configuration(format!("TUI managed event error: {error}"))
            })?;
            (record, None)
        }
        ManagedEventData::AgentCreated { .. }
        | ManagedEventData::TurnCancelling { .. }
        | ManagedEventData::TurnCompleted { .. }
        | ManagedEventData::TurnCancelled { .. }
        | ManagedEventData::StreamFailed { .. } => return Ok(None),
    };
    *next_sequence = next_sequence.saturating_add(1);
    Ok(Some((Arc::new(record), prompt)))
}

fn history_projection(
    history: Vec<ManagedEvent>,
    agent_id: &str,
    workspace: &Path,
) -> Result<HistoryProjection, ManagedError> {
    let mut sequences = HashMap::new();
    let mut next_sequence = 1;
    let (records, recent) = history_projection_with_sequences(
        history,
        agent_id,
        workspace,
        &mut sequences,
        &mut next_sequence,
    )?;
    Ok((records, next_sequence, recent))
}

fn history_projection_with_sequences(
    history: Vec<ManagedEvent>,
    agent_id: &str,
    workspace: &Path,
    sequences: &mut HashMap<String, u64>,
    next_sequence: &mut u64,
) -> Result<(Vec<Arc<TranscriptRecord>>, Vec<RecentPrompt>), ManagedError> {
    let mut records = Vec::new();
    let mut recent = Vec::new();
    let coherent_start = history
        .iter()
        .position(|event| matches!(event.data, ManagedEventData::TurnAccepted { .. }))
        .unwrap_or(0);
    for (index, event) in history.into_iter().enumerate().skip(coherent_start) {
        let sequence = *sequences.entry(event.cursor.clone()).or_insert_with(|| {
            let sequence = *next_sequence;
            *next_sequence = next_sequence.saturating_add(1);
            sequence
        });
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
            }
            ManagedEventData::AgentCreated { .. }
            | ManagedEventData::TurnCancelling { .. }
            | ManagedEventData::TurnCompleted { .. }
            | ManagedEventData::TurnCancelled { .. }
            | ManagedEventData::StreamFailed { .. } => {}
        }
    }
    recent.reverse();
    Ok((records, recent))
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

const fn thinking_from_effort(effort: ReasoningEffort) -> Thinking {
    match effort {
        ReasoningEffort::Low => Thinking::Low,
        ReasoningEffort::Medium => Thinking::Medium,
        ReasoningEffort::High => Thinking::High,
        ReasoningEffort::Xhigh => Thinking::Xhigh,
        ReasoningEffort::Max => Thinking::Max,
    }
}

const fn effort_from_thinking(thinking: Thinking) -> ReasoningEffort {
    match thinking {
        Thinking::None | Thinking::Low => ReasoningEffort::Low,
        Thinking::Medium => ReasoningEffort::Medium,
        Thinking::High => ReasoningEffort::High,
        Thinking::Xhigh => ReasoningEffort::Xhigh,
        Thinking::Max => ReasoningEffort::Max,
    }
}

const fn managed_reasoning_mode(mode: ReasoningMode) -> ManagedReasoningMode {
    match mode {
        ReasoningMode::Standard => ManagedReasoningMode::Standard,
        ReasoningMode::Pro => ManagedReasoningMode::Pro,
    }
}

const fn reasoning_mode_from_managed(mode: ManagedReasoningMode) -> ReasoningMode {
    match mode {
        ManagedReasoningMode::Standard => ReasoningMode::Standard,
        ManagedReasoningMode::Pro => ReasoningMode::Pro,
    }
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
    use super::{
        HistoryWindow, cursor_at_or_before, decimal_successor, history_projection,
        history_projection_with_sequences, live_managed_projection, session_summaries,
    };
    use nanocodex_managed::{
        AgentList, AgentSummary, EventHistoryPage, ManagedEvent, ManagedEventData, PromptInput,
    };
    use serde_json::{json, value::to_raw_value};
    use std::{
        collections::{BTreeMap, HashMap},
        path::Path,
    };

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
    fn live_managed_acceptance_projects_the_remote_user_prompt() {
        let mut next_sequence = 7;
        let (record, prompt) = live_managed_projection(
            managed_turn("42", "sent from another client"),
            "agent-1",
            Path::new("/workspace"),
            &mut next_sequence,
        )
        .unwrap()
        .expect("turn acceptance should project");

        let prompt = prompt.expect("turn acceptance should update prompt history");
        assert_eq!((record.source(), record.kind()), ("tact", "user.submitted"));
        assert_eq!(record.sequence(), 7);
        assert_eq!(prompt.text, "sent from another client");
        assert_eq!(prompt.session_id, "agent-1");
        assert_eq!(prompt.workspace, Path::new("/workspace"));
        assert_eq!(next_sequence, 8);
    }

    #[test]
    fn live_managed_projection_preserves_agent_output_after_the_prompt() {
        let mut next_sequence = 7;
        let event = ManagedEvent {
            cursor: "43".to_owned(),
            created_at: Some(1_750_000_000.0),
            turn_id: Some("turn-42".to_owned()),
            data: ManagedEventData::Event {
                event: to_raw_value(&json!({
                    "protocol_version": 1,
                    "request_id": "request-1",
                    "seq": 1,
                    "type": "assistant.message",
                    "payload": {
                        "model_call_index": 0,
                        "item_id": null,
                        "phase": null,
                        "text": "done"
                    }
                }))
                .unwrap(),
            },
        };

        let (record, prompt) = live_managed_projection(
            event,
            "agent-1",
            Path::new("/workspace"),
            &mut next_sequence,
        )
        .unwrap()
        .expect("agent output should project");

        assert_eq!(
            (record.source(), record.kind()),
            ("agent", "assistant.message")
        );
        assert!(prompt.is_none());
        assert_eq!(next_sequence, 8);
    }

    #[test]
    fn durable_history_is_fenced_through_the_live_stream_cursor() {
        assert!(cursor_at_or_before("9", "10"));
        assert!(cursor_at_or_before("10", "10"));
        assert!(!cursor_at_or_before("11", "10"));
        assert!(cursor_at_or_before("999", "latest"));
    }

    #[test]
    fn snapshot_cursor_successor_is_unbounded_and_canonical() {
        assert_eq!(decimal_successor("0"), "1");
        assert_eq!(decimal_successor("1299"), "1300");
        assert_eq!(
            decimal_successor("99999999999999999999"),
            "100000000000000000000"
        );
    }

    #[test]
    fn replay_keeps_loaded_event_sequences_stable_when_older_events_arrive() {
        let mut sequences = HashMap::new();
        let mut next_sequence = 1;
        let (recent, _) = history_projection_with_sequences(
            vec![managed_turn("5", "recent")],
            "agent-1",
            Path::new("/workspace"),
            &mut sequences,
            &mut next_sequence,
        )
        .unwrap();
        let recent_sequence = recent[0].sequence();

        let (replayed, _) = history_projection_with_sequences(
            vec![managed_turn("3", "older"), managed_turn("5", "recent")],
            "agent-1",
            Path::new("/workspace"),
            &mut sequences,
            &mut next_sequence,
        )
        .unwrap();

        assert_eq!(replayed[1].sequence(), recent_sequence);
        assert_ne!(replayed[0].sequence(), recent_sequence);
        assert_eq!(next_sequence, 3);
    }

    #[test]
    fn replay_ignores_a_partial_turn_before_the_first_loaded_prompt() {
        let partial = ManagedEvent {
            cursor: "4".to_owned(),
            created_at: Some(1_750_000_000.0),
            turn_id: Some("older-turn".to_owned()),
            data: ManagedEventData::Event {
                event: to_raw_value(&json!({ "not": "an agent event" })).unwrap(),
            },
        };

        let (records, _, recent) = history_projection(
            vec![partial, managed_turn("5", "complete turn")],
            "agent-1",
            Path::new("/workspace"),
        )
        .unwrap();

        assert_eq!(records.len(), 1);
        assert_eq!(recent[0].text, "complete turn");
    }

    #[test]
    fn history_window_prepends_one_page_and_stops_at_exhaustion() {
        let mut window = HistoryWindow::from_page(
            "7".to_owned(),
            EventHistoryPage {
                data: vec![managed_created("5"), managed_created("6")],
                has_more: true,
                latest_cursor: "6".to_owned(),
            },
        )
        .unwrap();
        assert_eq!(window.before.as_deref(), Some("5"));
        assert!(window.has_more);

        window
            .prepend(EventHistoryPage {
                data: vec![managed_created("3"), managed_created("4")],
                has_more: false,
                latest_cursor: "6".to_owned(),
            })
            .unwrap();

        assert_eq!(
            window
                .events
                .iter()
                .map(|event| event.cursor.as_str())
                .collect::<Vec<_>>(),
            ["3", "4", "5", "6"]
        );
        assert_eq!(window.before.as_deref(), Some("3"));
        assert!(!window.has_more);
    }

    #[test]
    fn empty_nonterminal_history_page_does_not_advance_the_retry_cursor() {
        let mut window = HistoryWindow::retry_from("9".to_owned());
        let result = window.prepend(EventHistoryPage {
            data: Vec::new(),
            has_more: true,
            latest_cursor: "8".to_owned(),
        });

        assert!(result.is_err());
        assert_eq!(window.before.as_deref(), Some("9"));
        assert!(window.has_more);
    }

    fn managed_created(cursor: &str) -> ManagedEvent {
        ManagedEvent {
            cursor: cursor.to_owned(),
            created_at: Some(1_750_000_000.0),
            turn_id: None,
            data: ManagedEventData::AgentCreated {
                agent_id: "agent-1".to_owned(),
                capabilities: json!({}),
            },
        }
    }

    fn managed_turn(cursor: &str, prompt: &str) -> ManagedEvent {
        ManagedEvent {
            cursor: cursor.to_owned(),
            created_at: Some(1_750_000_000.0),
            turn_id: Some(format!("turn-{cursor}")),
            data: ManagedEventData::TurnAccepted {
                id: format!("turn-{cursor}"),
                input: PromptInput::Text(prompt.to_owned()),
                replayed: false,
            },
        }
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
