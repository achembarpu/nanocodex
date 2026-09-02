use std::{
    future::Future,
    pin::Pin,
    task::{Context, Poll},
};

use nanocodex_agent::{
    AgentEvents, BuilderBackend, Nanocodex, NanocodexError, backend::BackendRuntime,
};
use tower::{Layer, Service, ServiceExt};

#[cfg(feature = "tools")]
use nanocodex_tools::{Tools, attachment::AttachmentTarget};

#[cfg(feature = "tools")]
use crate::attachment::AttachmentSupervisor;
use crate::{
    AgentReceipt, AgentState, EventCursor, ManagedClient, ManagedError, ManagedEvents, PromptInput,
    TurnAction, TurnView,
    driver::{ManagedAgent, ManagedDriver},
};

/// One owned operation accepted by a managed Tower service.
#[derive(Debug)]
#[non_exhaustive]
pub enum ManagedRequest {
    /// Creates a new account-owned agent.
    Create,
    /// Reads current durable agent state.
    State {
        /// Stable managed agent identifier.
        agent_id: String,
    },
    /// Opens the durable event stream at an exact cursor.
    Events {
        /// Stable managed agent identifier.
        agent_id: String,
        /// Last completely observed durable cursor.
        cursor: EventCursor,
    },
    /// Submits a new server-identified turn.
    Submit {
        /// Stable managed agent identifier.
        agent_id: String,
        /// Stable idempotency key for this logical request.
        idempotency_key: String,
        /// Complete managed prompt input.
        input: PromptInput,
    },
    /// Adds input to an active turn.
    Steer {
        /// Stable managed agent identifier.
        agent_id: String,
        /// Server-owned turn identifier.
        turn_id: String,
        /// Additional managed prompt input.
        input: PromptInput,
    },
    /// Requests cancellation of an active turn.
    Cancel {
        /// Stable managed agent identifier.
        agent_id: String,
        /// Server-owned turn identifier.
        turn_id: String,
    },
    /// Resolves the authenticated reverse-tool attachment target.
    #[cfg(feature = "tools")]
    AttachmentTarget {
        /// Stable managed agent identifier.
        agent_id: String,
    },
}

/// Typed response produced by a managed Tower service.
#[derive(Debug)]
#[non_exhaustive]
pub enum ManagedResponse {
    /// Receipt for a newly created managed agent.
    Created(AgentReceipt),
    /// Current durable agent state.
    State(AgentState),
    /// Opened durable event stream.
    Events(ManagedEvents),
    /// Current view of a submitted turn.
    Submitted(TurnView),
    /// Receipt for a steer operation.
    Steered(TurnAction),
    /// Receipt for a cancel operation.
    Cancelled(TurnAction),
    /// Authenticated reverse-tool attachment target.
    #[cfg(feature = "tools")]
    AttachmentTarget(AttachmentTarget),
}

/// Default concrete managed Tower service backed by [`ManagedClient`].
#[derive(Clone, Debug)]
pub struct ManagedService {
    client: ManagedClient,
}

impl ManagedService {
    const fn new(client: ManagedClient) -> Self {
        Self { client }
    }
}

impl Service<ManagedRequest> for ManagedService {
    type Response = ManagedResponse;
    type Error = ManagedError;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, _context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, request: ManagedRequest) -> Self::Future {
        let client = self.client.clone();
        Box::pin(async move {
            match request {
                ManagedRequest::Create => client.create().await.map(ManagedResponse::Created),
                ManagedRequest::State { agent_id } => {
                    client.state(&agent_id).await.map(ManagedResponse::State)
                }
                ManagedRequest::Events { agent_id, cursor } => {
                    let mut events = client.events(&agent_id, cursor)?;
                    events.open().await?;
                    Ok(ManagedResponse::Events(ManagedEvents::new(events)))
                }
                ManagedRequest::Submit {
                    agent_id,
                    idempotency_key,
                    input,
                } => client
                    .submit(&agent_id, None, &idempotency_key, &input)
                    .await
                    .map(ManagedResponse::Submitted),
                ManagedRequest::Steer {
                    agent_id,
                    turn_id,
                    input,
                } => client
                    .steer(&agent_id, &turn_id, &input)
                    .await
                    .map(ManagedResponse::Steered),
                ManagedRequest::Cancel { agent_id, turn_id } => client
                    .cancel(&agent_id, &turn_id)
                    .await
                    .map(ManagedResponse::Cancelled),
                #[cfg(feature = "tools")]
                ManagedRequest::AttachmentTarget { agent_id } => client
                    .attachment_target(&agent_id)
                    .map(ManagedResponse::AttachmentTarget),
            }
        })
    }
}

/// Account-managed lifecycle recipe accepted by [`Nanocodex::builder`].
#[derive(Clone, Debug)]
pub struct Managed<S = ManagedService> {
    service: S,
    operation: ManagedOperation,
}

#[derive(Clone, Debug)]
enum ManagedOperation {
    Create,
    Open(String),
    OpenFromState(String, AgentState),
}

impl Managed<ManagedService> {
    /// Selects creation of a new account-owned managed agent.
    #[must_use]
    pub const fn create(client: ManagedClient) -> Self {
        Self {
            service: ManagedService::new(client),
            operation: ManagedOperation::Create,
        }
    }

    /// Selects an existing account-owned managed agent by stable identifier.
    #[must_use]
    pub fn open(client: ManagedClient, agent_id: impl Into<String>) -> Self {
        Self {
            service: ManagedService::new(client),
            operation: ManagedOperation::Open(agent_id.into()),
        }
    }

    /// Opens an existing account-owned agent from one already validated state response.
    ///
    /// This preserves the state/event cursor fence without repeating the
    /// authenticated state request when a caller also needs the state for
    /// presentation hydration.
    #[must_use]
    pub fn open_from_state(
        client: ManagedClient,
        agent_id: impl Into<String>,
        state: AgentState,
    ) -> Self {
        Self {
            service: ManagedService::new(client),
            operation: ManagedOperation::OpenFromState(agent_id.into(), state),
        }
    }
}

impl<S> BuilderBackend for Managed<S> {
    type Builder = ManagedBuilder<S>;

    fn into_builder(self) -> Self::Builder {
        ManagedBuilder {
            managed: self,
            #[cfg(feature = "tools")]
            tools: None,
        }
    }
}

/// Builder for one account-managed agent lifecycle.
#[derive(Debug)]
pub struct ManagedBuilder<S = ManagedService> {
    managed: Managed<S>,
    #[cfg(feature = "tools")]
    tools: Option<Tools>,
}

impl<S> ManagedBuilder<S> {
    /// Replaces the managed Tower service while preserving create/open intent.
    #[must_use]
    pub fn service<T>(self, service: T) -> ManagedBuilder<T> {
        ManagedBuilder {
            managed: Managed {
                service,
                operation: self.managed.operation,
            },
            #[cfg(feature = "tools")]
            tools: self.tools,
        }
    }

    /// Wraps the concrete managed Tower service in caller middleware.
    #[must_use]
    pub fn layer<L>(self, layer: L) -> ManagedBuilder<L::Service>
    where
        L: Layer<S>,
    {
        let Self {
            managed,
            #[cfg(feature = "tools")]
            tools,
        } = self;
        ManagedBuilder {
            managed: Managed {
                service: layer.layer(managed.service),
                operation: managed.operation,
            },
            #[cfg(feature = "tools")]
            tools,
        }
    }

    /// Attaches one caller-owned immutable tool recipe to the managed agent.
    #[cfg(feature = "tools")]
    #[cfg_attr(docsrs, doc(cfg(feature = "tools")))]
    #[must_use]
    pub fn tools(mut self, tools: Tools) -> Self {
        self.tools = Some(tools);
        self
    }

    /// Creates or opens the managed agent and starts its owned lifecycle driver.
    ///
    /// # Errors
    ///
    /// Returns a managed service, response, event-cursor, or runtime
    /// construction failure.
    pub async fn build(mut self) -> nanocodex_agent::Result<(Nanocodex, AgentEvents)>
    where
        S: Service<ManagedRequest, Response = ManagedResponse> + Send + 'static,
        S::Future: Send + 'static,
        S::Error: std::error::Error + Send + Sync + 'static,
    {
        let (agent_id, expected_session_id, supplied_state) = match self.managed.operation {
            ManagedOperation::Create => {
                match call(&mut self.managed.service, ManagedRequest::Create).await? {
                    ManagedResponse::Created(receipt) => {
                        (receipt.agent_id, Some(receipt.session_id), None)
                    }
                    _ => return Err(unexpected_response()),
                }
            }
            ManagedOperation::Open(agent_id) => (agent_id, None, None),
            ManagedOperation::OpenFromState(agent_id, state) => (agent_id, None, Some(state)),
        };

        let state_and_cursor = async {
            let state = match supplied_state {
                Some(state) => state,
                None => match call(
                    &mut self.managed.service,
                    ManagedRequest::State {
                        agent_id: agent_id.clone(),
                    },
                )
                .await?
                {
                    ManagedResponse::State(state) => state,
                    _ => return Err(unexpected_response()),
                },
            };
            if state.agent_id != agent_id {
                return Err(backend_error(ManagedError::InvalidResponse(
                    "agent state identity does not match the requested agent",
                )));
            }
            if expected_session_id
                .as_deref()
                .is_some_and(|expected| expected != state.session_id)
            {
                return Err(backend_error(ManagedError::InvalidResponse(
                    "created agent receipt and state session identities differ",
                )));
            }
            if state.stream_error.is_some() {
                return Err(backend_error(ManagedError::InvalidResponse(
                    "agent state reports a durable stream failure",
                )));
            }
            crate::sse::validate_numeric_cursor(&state.latest_event_cursor).map_err(|_| {
                backend_error(ManagedError::InvalidResponse(
                    "agent state latest event cursor is invalid",
                ))
            })?;
            let cursor =
                EventCursor::parse(state.latest_event_cursor.clone()).map_err(backend_error)?;
            Ok((state, cursor))
        }
        .await;
        let (state, cursor) = match state_and_cursor {
            Ok(result) => result,
            Err(error) => return Err(error),
        };

        #[cfg(feature = "tools")]
        let attachment = match self.tools {
            Some(tools) => {
                let target = match call(
                    &mut self.managed.service,
                    ManagedRequest::AttachmentTarget {
                        agent_id: agent_id.clone(),
                    },
                )
                .await
                {
                    Ok(ManagedResponse::AttachmentTarget(target)) => target,
                    Ok(_) => return Err(unexpected_response()),
                    Err(error) => return Err(error),
                };
                Some(AttachmentSupervisor::start(tools, target).map_err(backend_error)?)
            }
            None => None,
        };

        let stream_response = match call(
            &mut self.managed.service,
            ManagedRequest::Events {
                agent_id: agent_id.clone(),
                cursor,
            },
        )
        .await
        {
            Ok(response) => response,
            Err(error) => {
                #[cfg(feature = "tools")]
                if let Some(attachment) = attachment.as_ref() {
                    let _ = attachment.shutdown().await;
                }
                return Err(error);
            }
        };

        let stream = match stream_response {
            ManagedResponse::Events(stream) => stream,
            _ => {
                #[cfg(feature = "tools")]
                if let Some(attachment) = attachment {
                    let _ = attachment.shutdown().await;
                }
                return Err(unexpected_response());
            }
        };

        let (runtime, events) =
            BackendRuntime::with_agent_id(agent_id.clone(), state.session_id.clone());
        let (backend, commands, shutdown) = ManagedAgent::new();
        let driver = ManagedDriver::new(
            self.managed.service,
            agent_id,
            stream,
            commands,
            runtime.events(),
            shutdown,
            #[cfg(feature = "tools")]
            attachment,
        );
        tokio::spawn(driver.run());
        Ok((runtime.bind(backend), events))
    }
}

pub(crate) async fn call<S>(
    service: &mut S,
    request: ManagedRequest,
) -> nanocodex_agent::Result<ManagedResponse>
where
    S: Service<ManagedRequest, Response = ManagedResponse> + Send,
    S::Future: Send,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    service
        .ready()
        .await
        .map_err(backend_error)?
        .call(request)
        .await
        .map_err(backend_error)
}

pub(crate) const fn unexpected_response() -> NanocodexError {
    NanocodexError::BackendContract {
        detail: "managed Tower service returned the wrong response variant",
    }
}

pub(crate) fn backend_error(
    error: impl std::error::Error + Send + Sync + 'static,
) -> NanocodexError {
    NanocodexError::Backend {
        backend: "managed",
        source: std::sync::Arc::new(error),
    }
}
