use std::{io, path::PathBuf, sync::Arc};

use nanocodex_oai_api::ResponseError;
pub use nanocodex_oai_api::transport::ResponsesError;

/// Recovery action attached by a higher-layer execution policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExecutionPolicyDisposition {
    /// The same live policy owner may safely retry the operation.
    Retry,
    /// The operation remains pending but automatic execution is blocked.
    Blocked,
    /// This policy owner must stop and be rebuilt from authoritative state.
    Reopen,
    /// The operation cannot be retried automatically.
    Fatal,
}

/// Error returned by the Nanocodex library boundary.
#[derive(Debug, thiserror::Error)]
pub enum NanocodexError {
    /// Caller input or two configured policies are incompatible.
    #[error("invalid task request: {0}")]
    InvalidRequest(String),

    /// The configured workspace could not be resolved.
    #[error("failed to resolve task workspace {path}: {source}")]
    ResolveWorkspace {
        /// Workspace path supplied by the caller.
        path: PathBuf,
        /// Underlying filesystem failure.
        #[source]
        source: io::Error,
    },

    /// The resolved workspace exists but is not a directory.
    #[error("task workspace is not a directory: {path}")]
    WorkspaceNotDirectory {
        /// Resolved workspace path.
        path: PathBuf,
    },

    /// The resolved workspace cannot be represented as UTF-8.
    #[error("task workspace path is not valid UTF-8: {path}")]
    WorkspaceNotUtf8 {
        /// Resolved workspace path.
        path: PathBuf,
    },

    /// A follow-on prompt attempted to change an owned session's workspace.
    #[error("an active agent session cannot change workspace from {current} to {requested}")]
    WorkspaceChanged {
        /// Workspace already owned by the session.
        current: String,
        /// Conflicting workspace requested by the caller.
        requested: String,
    },

    /// A completed provider response violated an agent-loop invariant.
    #[error("malformed Responses API event: {detail}")]
    MalformedResponse {
        /// Stable invariant failure description.
        detail: &'static str,
    },

    /// A service returned an output for the wrong kind of attempt.
    #[error("invalid Responses attempt state: {detail}")]
    InvalidAttemptState {
        /// Stable invalid-state description.
        detail: &'static str,
    },

    /// The immutable request prefix could not be serialized for fingerprinting.
    #[error("failed to fingerprint the immutable prompt prefix: {0}")]
    SerializePromptPrefix(#[source] serde_json::Error),

    /// The private driver stopped before accepting a command.
    #[error("the agent stopped before accepting the command")]
    AgentStopped,

    /// An agent with an attached execution policy stopped and must be rebuilt
    /// from that policy's authoritative state before accepting more work.
    #[error("the execution-policy-owned agent stopped and must be reopened")]
    ExecutionPolicyOwnerStopped,

    /// The private driver stopped after accepting a turn but before delivering its result.
    #[error("the agent stopped before the turn completed")]
    TurnStopped,

    /// Shared cleanup failure returned to every caller of an idempotent
    /// shutdown.
    #[error(transparent)]
    Shutdown(Arc<Self>),

    /// Steering targeted a queued or terminal turn.
    #[error("the targeted turn is queued, completed, or otherwise not active for steering")]
    TurnNotSteerable,

    /// The active turn cannot accept more queued steering input.
    #[error("the active turn's steering queue is full")]
    SteerQueueFull,

    /// Cancellation targeted an already terminal turn.
    #[error("the targeted turn has already completed or been cancelled")]
    TurnNotCancellable,

    /// The targeted turn was cancelled after its resources stopped.
    #[error("the turn was cancelled")]
    TurnCancelled,

    /// A fork was requested before any safe committed boundary existed.
    #[error("the agent has no safe conversation boundary to fork")]
    ForkBeforeCompletedTurn,

    /// A historical result came from a different conversation lineage.
    #[error("the completed turn belongs to a different conversation lineage")]
    CheckpointLineageMismatch,

    /// A serialized session snapshot failed structural or policy validation.
    #[error("invalid session snapshot: {0}")]
    InvalidSessionSnapshot(String),

    /// A higher-layer execution policy or its host store failed.
    #[error("{layer} execution policy failed: {source}")]
    ExecutionPolicy {
        /// Human-readable layer identity.
        layer: &'static str,
        /// Action the lifecycle must preserve while handling the failure.
        disposition: ExecutionPolicyDisposition,
        /// Original extension error.
        #[source]
        source: Arc<dyn std::error::Error + Send + Sync>,
    },

    /// An identified prompt was submitted without an execution policy.
    #[error("identified prompt submission requires a configured execution policy")]
    ExecutionPolicyNotConfigured,

    /// An attached execution policy violated the agent integration contract.
    #[error("invalid execution policy state: {0}")]
    InvalidExecutionPolicy(String),

    /// An execution policy relied on a fail-closed default for a capability
    /// that must explicitly acknowledge durable authority.
    #[error("execution policy does not implement required capability `{capability}`")]
    ExecutionPolicyCapabilityUnsupported {
        /// Missing policy capability.
        capability: &'static str,
    },

    /// A child agent was requested from an execution-policy-owned session.
    #[error(
        "cannot {operation} from an agent with an attached execution policy; build the child with its own execution policy"
    )]
    ExecutionPolicyBranchUnsupported {
        /// Requested child operation.
        operation: &'static str,
    },

    /// A typed execution boundary could not be encoded or decoded.
    #[error("execution policy payload is invalid: {0}")]
    ExecutionPayload(#[source] serde_json::Error),

    /// A policy-replayed result does not retain an in-process fork checkpoint.
    #[error("a policy-replayed result cannot be used as an in-process fork checkpoint")]
    ReplayedCheckpointUnavailable,

    /// A previously failed identified operation was replayed from its durable terminal record.
    #[error("durable operation previously failed: {0}")]
    ReplayedExecutionFailed(String),

    /// Agent construction was attempted outside an active Tokio runtime.
    #[error("building an agent requires an active Tokio runtime")]
    TokioRuntimeUnavailable,

    /// Codex-compatible rollout recording could not be initialized.
    #[error("failed to initialize a Codex rollout under {codex_home}: {source}")]
    InitializeRollout {
        /// Codex state directory selected by the caller.
        codex_home: PathBuf,
        /// Underlying filesystem failure.
        #[source]
        source: io::Error,
    },

    /// A committed rollout could not be durably persisted.
    #[error("failed to persist Codex rollout at {path}: {source}")]
    PersistRollout {
        /// Rollout file that could not be written.
        path: PathBuf,
        /// Underlying filesystem failure.
        #[source]
        source: io::Error,
    },

    /// Contractual agent event serialization failed.
    #[error(transparent)]
    Event(#[from] nanocodex_oai_api::events::EventError),

    /// A complete Responses operation failed.
    #[error(transparent)]
    Response(#[from] ResponseError),

    /// The configured tool registry or runtime could not be built.
    #[error("failed to build tools for an agent driver: {0}")]
    Tools(#[from] nanocodex_tools::ToolsBuildError),
}

impl NanocodexError {
    /// Wraps an error returned by a higher-layer execution policy.
    #[doc(hidden)]
    pub fn execution_policy<E>(layer: &'static str, source: E) -> Self
    where
        E: std::error::Error + Send + Sync + 'static,
    {
        Self::ExecutionPolicy {
            layer,
            disposition: ExecutionPolicyDisposition::Fatal,
            source: Arc::new(source),
        }
    }

    /// Wraps an execution-policy error with its required recovery action.
    #[doc(hidden)]
    pub fn execution_policy_with_disposition<E>(
        layer: &'static str,
        disposition: ExecutionPolicyDisposition,
        source: E,
    ) -> Self
    where
        E: std::error::Error + Send + Sync + 'static,
    {
        Self::ExecutionPolicy {
            layer,
            disposition,
            source: Arc::new(source),
        }
    }

    /// Returns the recovery action supplied by an execution policy.
    #[must_use]
    pub fn execution_policy_disposition(&self) -> Option<ExecutionPolicyDisposition> {
        match self {
            Self::ExecutionPolicy { disposition, .. } => Some(*disposition),
            Self::ExecutionPolicyOwnerStopped => Some(ExecutionPolicyDisposition::Reopen),
            Self::Shutdown(source) => source.execution_policy_disposition(),
            _ => None,
        }
    }

    /// Returns the underlying Responses transport/API error, including when a
    /// caller-provided Tower middleware boxed the standard service error.
    #[must_use]
    pub fn responses_error(&self) -> Option<&ResponsesError> {
        match self {
            Self::Response(error) => error.responses_error(),
            Self::Shutdown(error) => error.responses_error(),
            _ => None,
        }
    }
}

/// Result type returned by the owned agent lifecycle.
pub type Result<T> = std::result::Result<T, NanocodexError>;

#[cfg(test)]
mod tests {
    use super::{NanocodexError, ResponsesError};
    use nanocodex_oai_api::{ResponseError, tower::ResponsesServiceError};

    #[test]
    fn response_error_is_the_single_provider_failure_boundary() {
        let service = NanocodexError::Response(ResponseError::from(ResponsesServiceError::from(
            ResponsesError::UnexpectedEnd,
        )));
        assert!(matches!(
            service.responses_error(),
            Some(ResponsesError::UnexpectedEnd)
        ));

        let service = ResponsesServiceError::from(ResponsesError::UnexpectedEnd);
        let error =
            NanocodexError::Response(ResponseError::from(Box::new(service) as tower::BoxError));
        assert!(matches!(
            error.responses_error(),
            Some(ResponsesError::UnexpectedEnd)
        ));
        assert_eq!(
            error.to_string(),
            "Responses WebSocket closed without a close frame"
        );
    }
}
