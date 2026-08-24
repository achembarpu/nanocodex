use super::*;
use nanocodex_oai_api::PromptValidationError;

/// Completion handle for an accepted turn.
///
/// A turn is both a [`Future`] for its final typed result and a [`Stream`] of
/// optional per-turn events. Result readiness is independent from consuming or
/// closing that event stream.
///
/// Dropping this handle does not cancel the accepted turn. Use [`Self::cancel`]
/// before dropping it when the work should stop.
#[must_use = "a turn continues running when dropped; await result(), control it, or explicitly drop it"]
pub struct Turn {
    pub(super) control: TurnControl,
    pub(super) request_id: Option<String>,
    pub(super) events: AgentEvents,
    pub(super) result: oneshot::Receiver<Result<TurnResult>>,
}

/// Outcome of routing live user input into an agent session.
///
/// Live input adapters normally want to steer the current regular turn when
/// one exists and start a new turn only when the agent is idle.
/// [`Nanocodex::route_prompt`](crate::Nanocodex::route_prompt) performs that
/// decision atomically in the agent driver and returns this outcome.
pub enum PromptRoute {
    /// The agent was idle, so the prompt started a new independently awaitable turn.
    Started(Turn),
    /// The prompt was admitted to the current turn's steering queue.
    Steered,
}

impl Turn {
    /// Returns the durable request identity selected during prompt admission.
    ///
    /// A caller-supplied [`PromptRequest::request_id`] is returned unchanged.
    /// When an execution policy generated the identity, this returns the
    /// generated or recovered journal operation ID. Agents without an attached
    /// execution policy do not assign request identities.
    #[must_use]
    pub fn request_id(&self) -> Option<&str> {
        self.request_id.as_deref()
    }

    /// Returns a cheap cloneable capability targeting this exact turn.
    #[must_use]
    pub fn control(&self) -> TurnControl {
        self.control.clone()
    }

    /// Injects additional input into this turn at its next safe model boundary.
    ///
    /// # Errors
    ///
    /// Returns an error for an empty prompt, when this turn is queued or no
    /// longer active, when its steering queue is full, or if the driver stops.
    pub async fn steer(&self, prompt: impl Into<Prompt>) -> Result<()> {
        self.control.steer(prompt).await
    }

    /// Cancels this exact unfinished turn.
    ///
    /// A queued turn is removed before execution and acknowledged immediately;
    /// its result and terminal event retain their FIFO position behind earlier
    /// turns. An active turn waits for its model and tool resources to stop
    /// before cancellation is acknowledged.
    ///
    /// # Errors
    ///
    /// Returns an error when this turn has already finished or if the driver
    /// stops.
    pub async fn cancel(&self) -> Result<()> {
        self.control.cancel().await
    }

    /// Waits for and returns the final typed turn result.
    ///
    /// This is equivalent to awaiting the turn directly. It does not wait for
    /// the per-turn event stream to be consumed or closed. Applications that
    /// need every event should consume the independently returned
    /// [`AgentEvents`] stream.
    ///
    /// # Errors
    ///
    /// Returns the model-run failure or an error if the driver stopped early.
    pub async fn result(self) -> Result<TurnResult> {
        self.await
    }
}

impl Stream for Turn {
    type Item = AgentEvent;

    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Pin::new(&mut self.events).poll_next(context)
    }
}

impl Future for Turn {
    type Output = Result<TurnResult>;

    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.result)
            .poll(context)
            .map(|result| result.map_err(|_| NanocodexError::TurnStopped)?)
    }
}

/// Cheap cloneable control capability for one accepted turn.
#[derive(Clone)]
pub struct TurnControl {
    pub(super) key: TurnKey,
    pub(super) commands: mpsc::Sender<Command>,
    pub(super) shutdown: DriverShutdown,
}

impl TurnControl {
    /// Injects additional input into the targeted turn.
    ///
    /// # Errors
    ///
    /// Returns an error for an empty prompt, when the turn is not active, when
    /// its steering queue is full, or if the driver stops.
    pub async fn steer(&self, prompt: impl Into<Prompt>) -> Result<()> {
        let prompt = prompt.into();
        prompt.validate().map_err(steer_validation_error)?;
        request_command(&self.commands, &self.shutdown, |result| Command::Steer {
            key: self.key,
            prompt,
            result,
        })
        .await
    }

    /// Cancels the targeted unfinished turn.
    ///
    /// # Errors
    ///
    /// Returns an error when the turn has already finished or if the driver
    /// stops.
    pub async fn cancel(&self) -> Result<()> {
        request_command(&self.commands, &self.shutdown, |result| Command::Cancel {
            key: self.key,
            result,
        })
        .await
    }
}

fn steer_validation_error(error: PromptValidationError) -> NanocodexError {
    let message = match error {
        PromptValidationError::EmptyInstruction => "steer instruction must not be empty".to_owned(),
        error => error.to_string(),
    };
    NanocodexError::InvalidRequest(message)
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(super) struct TurnKey(pub(super) u64);

/// Final result of a completed turn.
#[derive(Clone)]
#[non_exhaustive]
pub struct TurnResult {
    pub(super) request_id: Option<String>,
    pub(super) final_message: String,
    pub(super) usage: TurnUsage,
    pub(super) checkpoint: TurnCheckpoint,
}

#[derive(Clone)]
pub(super) enum TurnCheckpoint {
    Live(Arc<CommittedSession>),
    Replayed(SessionSnapshot),
}

impl TurnResult {
    /// Returns the durable request identity selected during prompt admission.
    #[must_use]
    pub fn request_id(&self) -> Option<&str> {
        self.request_id.as_deref()
    }

    /// Returns the final assistant message for this completed turn.
    #[must_use]
    pub fn final_message(&self) -> &str {
        &self.final_message
    }

    /// Consumes the result and returns its final assistant message.
    #[must_use]
    pub fn into_final_message(self) -> String {
        self.final_message
    }

    /// Returns exact aggregate token usage for this logical agent turn.
    #[must_use]
    pub const fn usage(&self) -> &TurnUsage {
        &self.usage
    }

    /// Copies this completed boundary into a serializable, caller-owned session snapshot.
    ///
    /// The snapshot contains the complete unredacted model-visible conversation,
    /// including reasoning payloads and tool inputs and outputs. Applications are
    /// responsible for protecting and retaining serialized snapshots appropriately.
    #[must_use]
    pub fn snapshot(&self) -> SessionSnapshot {
        match &self.checkpoint {
            TurnCheckpoint::Live(checkpoint) => checkpoint.snapshot(),
            TurnCheckpoint::Replayed(snapshot) => snapshot.clone(),
        }
    }
}

impl fmt::Debug for TurnResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TurnResult")
            .field("final_message", &self.final_message)
            .finish_non_exhaustive()
    }
}

/// One prompt submission with an optional execution identity.
///
/// When an execution policy is attached, the agent automatically assigns an
/// operation ID to requests that omit one. Attach a caller-owned ID when an
/// external job, webhook, or host retry resubmits the same logical operation.
#[derive(Clone, Debug)]
pub struct PromptRequest {
    pub(super) prompt: Prompt,
    pub(super) request_id: Option<String>,
}

impl PromptRequest {
    /// Creates a prompt submission without a caller-owned operation identity.
    ///
    /// A policy-enabled agent assigns a unique operation ID before accepting
    /// this request.
    #[must_use]
    pub fn new(prompt: impl Into<Prompt>) -> Self {
        Self {
            prompt: prompt.into(),
            request_id: None,
        }
    }

    /// Supplies a stable caller-owned request identity.
    ///
    /// When omitted, an execution policy generates an identity before the
    /// prompt is accepted. Resubmitting the same request ID with the same
    /// prompt resumes or replays that durable operation; reusing it for a
    /// different prompt is rejected as a conflict.
    #[must_use]
    pub fn request_id(mut self, request_id: impl Into<String>) -> Self {
        self.request_id = Some(request_id.into());
        self
    }
}

impl From<Prompt> for PromptRequest {
    fn from(prompt: Prompt) -> Self {
        Self::new(prompt)
    }
}

impl From<String> for PromptRequest {
    fn from(prompt: String) -> Self {
        Self::new(prompt)
    }
}

impl From<&str> for PromptRequest {
    fn from(prompt: &str) -> Self {
        Self::new(prompt)
    }
}

/// Optional model policy for a newly spawned clean agent.
///
/// Omitted values inherit the invoking agent's settings at the model boundary
/// where the spawn command is handled.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct SpawnOptions {
    pub(super) model: Option<Model>,
    pub(super) thinking: Option<Thinking>,
}

impl SpawnOptions {
    /// Starts an inherited spawn configuration.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            model: None,
            thinking: None,
        }
    }

    /// Overrides the model for the new agent without changing its parent.
    #[must_use]
    pub const fn model(mut self, model: Model) -> Self {
        self.model = Some(model);
        self
    }

    /// Overrides the reasoning effort for the new agent without changing its parent.
    #[must_use]
    pub const fn thinking(mut self, thinking: Thinking) -> Self {
        self.thinking = Some(thinking);
        self
    }
}

pub(super) enum Command {
    Prompt {
        key: TurnKey,
        prompt: Prompt,
        execution_operation: Option<ExecutionOperation>,
        accepted: Option<oneshot::Sender<Result<String>>>,
        thinking: Option<Thinking>,
        fast_mode: Option<bool>,
        parent: Option<tracing::Span>,
        events: EventSink,
        result: oneshot::Sender<Result<TurnResult>>,
    },
    Steer {
        key: TurnKey,
        prompt: Prompt,
        result: oneshot::Sender<Result<()>>,
    },
    RoutePrompt {
        key: TurnKey,
        prompt: Prompt,
        parent: Option<tracing::Span>,
        events: EventSink,
        turn_result: oneshot::Sender<Result<TurnResult>>,
        route_result: oneshot::Sender<Result<PromptRouteKind>>,
    },
    Cancel {
        key: TurnKey,
        result: oneshot::Sender<Result<()>>,
    },
    Fork {
        checkpoint: Option<Arc<CommittedSession>>,
        result: oneshot::Sender<Result<(Nanocodex, AgentEvents)>>,
    },
    Spawn {
        options: SpawnOptions,
        result: oneshot::Sender<Result<(Nanocodex, AgentEvents)>>,
    },
    SetThinking {
        thinking: Thinking,
        result: oneshot::Sender<Result<()>>,
    },
    SetFastMode {
        enabled: bool,
        result: oneshot::Sender<Result<()>>,
    },
    Compact {
        parent: Option<tracing::Span>,
        result: oneshot::Sender<Result<()>>,
    },
    AppendDeveloperMessage {
        text: String,
        result: oneshot::Sender<Result<AgentSessionContext>>,
    },
    Context {
        result: oneshot::Sender<Result<AgentSessionContext>>,
    },
    Shutdown,
}

pub(super) enum ExecutionOperation {
    Caller(String),
    Automatic(String),
    Admitted(String),
}

impl ExecutionOperation {
    pub(super) fn into_id(self) -> String {
        match self {
            Self::Caller(operation_id)
            | Self::Automatic(operation_id)
            | Self::Admitted(operation_id) => operation_id,
        }
    }
}

#[derive(Clone, Copy)]
pub(super) enum PromptRouteKind {
    Started,
    Steered,
}

pub(super) enum QueuedTurn {
    Pending {
        key: TurnKey,
        prompt: Prompt,
        execution_operation: Option<String>,
        thinking: Thinking,
        fast_mode: bool,
        parent: Option<tracing::Span>,
        events: EventSink,
        result: oneshot::Sender<Result<TurnResult>>,
    },
    Cancelled {
        prompt: Prompt,
        execution_operation: Option<String>,
        cancellation_committed: bool,
        thinking: Thinking,
        fast_mode: bool,
        parent: Option<tracing::Span>,
        events: EventSink,
        result: oneshot::Sender<Result<TurnResult>>,
    },
}
