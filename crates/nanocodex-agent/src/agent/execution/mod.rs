#[cfg(not(target_family = "wasm"))]
#[path = "native.rs"]
mod platform;

#[cfg(all(target_family = "wasm", target_os = "unknown"))]
#[path = "disabled.rs"]
mod platform;

use std::{future::Future, pin::Pin, sync::Arc};

use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::{
    NanocodexError, Result,
    session::{CommittedSession, SessionSnapshot},
    usage::TurnUsage,
};

#[cfg(not(target_family = "wasm"))]
use crate::rollout::{RolloutConfig, RolloutInfo};

/// Boxed operation returned by an [`ExecutionPolicy`].
#[cfg(not(target_family = "wasm"))]
pub type ExecutionFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Boxed operation returned by an [`ExecutionPolicy`].
#[cfg(target_family = "wasm")]
pub type ExecutionFuture<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;

/// Result of admitting one identified execution into an attached policy.
pub enum ExecutionAdmission {
    /// Execute the newly accepted or previously interrupted operation.
    Execute,
    /// Return an already completed operation without executing it again.
    Completed {
        /// Session boundary committed with the output.
        snapshot: SessionSnapshot,
        /// Previously completed turn output.
        output: ExecutionOutput,
    },
    /// Return an already failed operation without executing it again.
    Failed {
        /// Session boundary committed with the failure.
        snapshot: SessionSnapshot,
        /// Previously retained failure detail.
        error: String,
    },
    /// The operation was explicitly cancelled.
    Cancelled,
}

/// Replay policy for an external effect within one execution.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExecutionRetry {
    /// An interrupted effect may be executed again.
    Idempotent,
    /// An interrupted effect has an ambiguous outcome and must not be repeated.
    Never,
}

/// Result of beginning one externally observable execution step.
pub enum ExecutionStepAdmission {
    /// Perform the effect.
    Execute,
    /// Reuse the exact JSON output retained by a prior attempt.
    Replay(String),
}

/// Serializable result retained at a completed agent boundary.
#[derive(Clone, Deserialize, Serialize)]
pub struct ExecutionOutput {
    /// Final assistant message.
    pub final_message: String,
    /// Exact token and cost accounting for the turn.
    pub usage: TurnUsage,
}

/// Optional higher-layer policy for admitting executions and intercepting effects.
///
/// The core agent invokes this interface at its existing transactional
/// boundaries but does not choose a persistence format, retry policy, storage
/// backend, or recovery algorithm. Higher crates may implement those choices
/// without becoming a dependency of `nanocodex-agent`.
#[cfg(not(target_family = "wasm"))]
pub trait ExecutionPolicy: Send + Sync {
    /// Releases policy-owned lifecycle state after all Agent work has stopped.
    ///
    /// The default is a no-op so existing stateless policies remain source
    /// compatible. Stateful policies should make this operation idempotent.
    fn shutdown<'a>(&'a self) -> ExecutionFuture<'a, Result<()>> {
        Box::pin(async { Ok(()) })
    }

    /// Commits a model-only resumable boundary such as standalone compaction.
    /// The default fails closed so omission cannot acknowledge an uncommitted
    /// boundary.
    fn commit_checkpoint<'a>(
        &'a self,
        _snapshot: SessionSnapshot,
    ) -> ExecutionFuture<'a, Result<()>> {
        Box::pin(async {
            Err(NanocodexError::ExecutionPolicyCapabilityUnsupported {
                capability: "commit_checkpoint",
            })
        })
    }

    /// Fences a model-only external effect immediately before it begins. The
    /// default fails closed so omission cannot authorize an effect.
    fn authorize_model_effect<'a>(
        &'a self,
        _kind: &'static str,
    ) -> ExecutionFuture<'a, Result<()>> {
        Box::pin(async {
            Err(NanocodexError::ExecutionPolicyCapabilityUnsupported {
                capability: "authorize_model_effect",
            })
        })
    }

    /// Admits a caller-identified operation.
    fn admit<'a>(
        &'a self,
        operation_id: String,
        input_json: String,
    ) -> ExecutionFuture<'a, Result<ExecutionAdmission>>;

    /// Admits an automatically identified operation, recovering an unfinished
    /// compatible operation when the policy selects one.
    fn admit_automatic<'a>(
        &'a self,
        candidate_operation_id: String,
        input_json: String,
    ) -> ExecutionFuture<'a, Result<(String, ExecutionAdmission)>>;

    /// Releases a live claim when command acceptance is abandoned.
    fn release<'a>(&'a self, operation_id: String) -> ExecutionFuture<'a, ()>;

    /// Marks an admitted operation as cancelled. The default fails closed so
    /// omission cannot terminalize an operation by merely returning success.
    fn cancel<'a>(
        &'a self,
        _operation_id: String,
        _snapshot: Option<SessionSnapshot>,
    ) -> ExecutionFuture<'a, Result<()>> {
        Box::pin(async {
            Err(NanocodexError::ExecutionPolicyCapabilityUnsupported {
                capability: "cancel",
            })
        })
    }

    /// Starts another attempt for an admitted operation.
    fn begin_attempt<'a>(&'a self, operation_id: String) -> ExecutionFuture<'a, Result<()>>;

    /// Begins or replays one typed external effect.
    fn begin_step<'a>(
        &'a self,
        operation_id: String,
        step_id: String,
        kind: String,
        input_json: String,
        retry: ExecutionRetry,
    ) -> ExecutionFuture<'a, Result<ExecutionStepAdmission>>;

    /// Commits the output of one executed effect.
    fn complete_step<'a>(
        &'a self,
        operation_id: String,
        step_id: String,
        output_json: String,
    ) -> ExecutionFuture<'a, Result<()>>;

    /// Atomically commits a terminal turn output and its resumable boundary.
    fn complete<'a>(
        &'a self,
        operation_id: String,
        snapshot: SessionSnapshot,
        output: ExecutionOutput,
    ) -> ExecutionFuture<'a, Result<()>>;

    /// Records a failed attempt that may be resumed later.
    fn fail_attempt<'a>(
        &'a self,
        operation_id: String,
        error: String,
    ) -> ExecutionFuture<'a, Result<()>>;

    /// Atomically commits a failed turn and its resumable boundary.
    fn fail<'a>(
        &'a self,
        operation_id: String,
        snapshot: SessionSnapshot,
        error: String,
    ) -> ExecutionFuture<'a, Result<()>>;
}

/// Optional higher-layer policy for admitting executions and intercepting effects.
///
/// JavaScript host futures remain isolate-local, while the policy handle stays
/// thread-safe so cheap agent capabilities retain their public `Send + Sync`
/// guarantees on every target.
#[cfg(target_family = "wasm")]
pub trait ExecutionPolicy: Send + Sync {
    /// Releases policy-owned lifecycle state after all Agent work has stopped.
    ///
    /// The default is a no-op so existing stateless policies remain source
    /// compatible. Stateful policies should make this operation idempotent.
    fn shutdown<'a>(&'a self) -> ExecutionFuture<'a, Result<()>> {
        Box::pin(async { Ok(()) })
    }

    /// Commits a model-only resumable boundary such as standalone compaction.
    /// The default fails closed.
    fn commit_checkpoint<'a>(
        &'a self,
        _snapshot: SessionSnapshot,
    ) -> ExecutionFuture<'a, Result<()>> {
        Box::pin(async {
            Err(NanocodexError::ExecutionPolicyCapabilityUnsupported {
                capability: "commit_checkpoint",
            })
        })
    }

    /// Fences a model-only external effect immediately before it begins. The
    /// default fails closed.
    fn authorize_model_effect<'a>(
        &'a self,
        _kind: &'static str,
    ) -> ExecutionFuture<'a, Result<()>> {
        Box::pin(async {
            Err(NanocodexError::ExecutionPolicyCapabilityUnsupported {
                capability: "authorize_model_effect",
            })
        })
    }

    /// Admits a caller-identified operation.
    fn admit<'a>(
        &'a self,
        operation_id: String,
        input_json: String,
    ) -> ExecutionFuture<'a, Result<ExecutionAdmission>>;
    /// Admits or recovers an automatically identified operation.
    fn admit_automatic<'a>(
        &'a self,
        candidate_operation_id: String,
        input_json: String,
    ) -> ExecutionFuture<'a, Result<(String, ExecutionAdmission)>>;
    /// Releases an abandoned live claim.
    fn release<'a>(&'a self, operation_id: String) -> ExecutionFuture<'a, ()>;
    /// Marks an operation as cancelled. The default fails closed.
    fn cancel<'a>(
        &'a self,
        _operation_id: String,
        _snapshot: Option<SessionSnapshot>,
    ) -> ExecutionFuture<'a, Result<()>> {
        Box::pin(async {
            Err(NanocodexError::ExecutionPolicyCapabilityUnsupported {
                capability: "cancel",
            })
        })
    }
    /// Starts another operation attempt.
    fn begin_attempt<'a>(&'a self, operation_id: String) -> ExecutionFuture<'a, Result<()>>;
    /// Begins or replays one external effect.
    fn begin_step<'a>(
        &'a self,
        operation_id: String,
        step_id: String,
        kind: String,
        input_json: String,
        retry: ExecutionRetry,
    ) -> ExecutionFuture<'a, Result<ExecutionStepAdmission>>;
    /// Commits one effect output.
    fn complete_step<'a>(
        &'a self,
        operation_id: String,
        step_id: String,
        output_json: String,
    ) -> ExecutionFuture<'a, Result<()>>;
    /// Commits a terminal turn and resumable boundary.
    fn complete<'a>(
        &'a self,
        operation_id: String,
        snapshot: SessionSnapshot,
        output: ExecutionOutput,
    ) -> ExecutionFuture<'a, Result<()>>;
    /// Records a failed attempt.
    fn fail_attempt<'a>(
        &'a self,
        operation_id: String,
        error: String,
    ) -> ExecutionFuture<'a, Result<()>>;
    /// Commits a failed turn and resumable boundary.
    fn fail<'a>(
        &'a self,
        operation_id: String,
        snapshot: SessionSnapshot,
        error: String,
    ) -> ExecutionFuture<'a, Result<()>>;
}

#[derive(Clone, Default)]
pub(crate) struct ExecutionConfig {
    platform: platform::Config,
    policy: Option<ExecutionPolicyRecipe>,
}

#[derive(Clone)]
enum ExecutionPolicyRecipe {
    Shared(Arc<dyn ExecutionPolicy>),
    PerAgent(Arc<dyn Fn() -> Result<Arc<dyn ExecutionPolicy>> + Send + Sync>),
}

impl ExecutionPolicyRecipe {
    fn instantiate(&self) -> Result<Arc<dyn ExecutionPolicy>> {
        match self {
            Self::Shared(policy) => Ok(Arc::clone(policy)),
            Self::PerAgent(factory) => factory(),
        }
    }
}

impl ExecutionConfig {
    #[cfg(not(target_family = "wasm"))]
    pub(crate) fn set_rollout(&mut self, rollout: RolloutConfig) {
        self.platform.set_rollout(rollout);
    }

    pub(crate) fn set_policy(&mut self, policy: Arc<dyn ExecutionPolicy>) {
        self.policy = Some(ExecutionPolicyRecipe::Shared(policy));
    }

    pub(crate) fn set_policy_factory(
        &mut self,
        factory: Arc<dyn Fn() -> Result<Arc<dyn ExecutionPolicy>> + Send + Sync>,
    ) {
        self.policy = Some(ExecutionPolicyRecipe::PerAgent(factory));
    }

    // The WASM platform configuration is const, while native rollout cloning is not.
    #[cfg_attr(target_family = "wasm", allow(clippy::missing_const_for_fn))]
    pub(crate) fn for_new_thread(&self, operation: &'static str) -> Result<Self> {
        if self.policy.is_some() {
            return Err(NanocodexError::ExecutionPolicyBranchUnsupported { operation });
        }
        Ok(Self {
            platform: self.platform.for_new_thread(),
            policy: None,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn start(
        &self,
        session_id: &str,
        workspace: Option<&str>,
        instructions: &str,
        origin_kind: &'static str,
        parent_session_id: Option<&str>,
        resume_history_len: Option<usize>,
    ) -> Result<Execution> {
        Ok(Execution {
            platform: self.platform.start(
                session_id,
                workspace,
                instructions,
                origin_kind,
                parent_session_id,
                resume_history_len,
            )?,
            policy: self
                .policy
                .as_ref()
                .map(ExecutionPolicyRecipe::instantiate)
                .transpose()?,
        })
    }
}

#[derive(Clone)]
pub(crate) struct Execution {
    platform: platform::Execution,
    policy: Option<Arc<dyn ExecutionPolicy>>,
}

pub(crate) enum AdmittedExecution {
    Execute,
    Completed {
        output: ExecutionOutput,
        snapshot: SessionSnapshot,
    },
    Failed {
        error: String,
    },
    Cancelled,
}

impl Execution {
    #[cfg(not(target_family = "wasm"))]
    pub(crate) const fn info(&self) -> Option<&RolloutInfo> {
        self.platform.info()
    }

    pub(crate) const fn identifies_prompts(&self) -> bool {
        self.policy.is_some()
    }

    pub(crate) async fn admit<T: Serialize + ?Sized>(
        &self,
        operation_id: &str,
        input: &T,
    ) -> Result<AdmittedExecution> {
        let policy = self
            .policy
            .as_ref()
            .ok_or(NanocodexError::ExecutionPolicyNotConfigured)?;
        let input = encode(input)?;
        Ok(map_admission(
            policy.admit(operation_id.to_owned(), input).await?,
        ))
    }

    pub(crate) async fn admit_automatic<T: Serialize + ?Sized>(
        &self,
        candidate_operation_id: String,
        input: &T,
    ) -> Result<(String, AdmittedExecution)> {
        let policy = self
            .policy
            .as_ref()
            .ok_or(NanocodexError::ExecutionPolicyNotConfigured)?;
        let (operation_id, admission) = policy
            .admit_automatic(candidate_operation_id, encode(input)?)
            .await?;
        Ok((operation_id, map_admission(admission)))
    }

    pub(crate) async fn release_claim(&self, operation_id: &str) {
        if let Some(policy) = &self.policy {
            policy.release(operation_id.to_owned()).await;
        }
    }

    pub(crate) async fn cancel_operation<T: Serialize + ?Sized>(
        &self,
        operation_id: &str,
        input: &T,
    ) -> Result<()> {
        let policy = self
            .policy
            .as_ref()
            .ok_or(NanocodexError::ExecutionPolicyNotConfigured)?;
        cancel_with_reclaim(policy, operation_id.to_owned(), Some(encode(input)?), None).await
    }

    pub(crate) fn start_turn(
        &self,
        prompt: &nanocodex_oai_api::Prompt,
        effort: nanocodex_oai_api::Thinking,
        operation_id: Option<String>,
    ) -> ExecutionTurn {
        ExecutionTurn {
            platform: self.platform.start_turn(prompt, effort),
            policy: self.policy.clone(),
            operation_id,
            operation_input: Some(prompt.clone()),
            outcome: ExecutionOutcome::Started,
        }
    }

    #[cfg_attr(target_family = "wasm", allow(clippy::missing_const_for_fn))]
    pub(crate) fn start_compaction(&self, effort: nanocodex_oai_api::Thinking) -> ExecutionTurn {
        ExecutionTurn {
            platform: self.platform.start_compaction(effort),
            policy: self.policy.clone(),
            operation_id: None,
            operation_input: None,
            outcome: ExecutionOutcome::Started,
        }
    }

    pub(crate) async fn authorize_compaction(&self) -> Result<()> {
        if let Some(policy) = &self.policy {
            policy.authorize_model_effect("compaction").await?;
        }
        Ok(())
    }

    pub(crate) async fn persist(
        &self,
        checkpoint: &CommittedSession,
        turn: ExecutionTurn,
    ) -> Result<()> {
        let ExecutionTurn {
            platform,
            policy,
            operation_id,
            operation_input,
            outcome,
        } = turn;
        persist_operation(policy, operation_id, operation_input, outcome, checkpoint).await?;
        self.platform.persist(checkpoint, platform).await;
        Ok(())
    }

    pub(crate) async fn persist_compaction(
        &self,
        checkpoint: &CommittedSession,
        turn: ExecutionTurn,
    ) -> Result<()> {
        if let Some(policy) = &self.policy {
            policy.commit_checkpoint(checkpoint.snapshot()).await?;
        }
        self.platform
            .persist_compaction(checkpoint, turn.platform)
            .await;
        Ok(())
    }

    pub(crate) async fn commit_checkpoint(&self, checkpoint: &CommittedSession) -> Result<()> {
        if let Some(policy) = &self.policy {
            policy.commit_checkpoint(checkpoint.snapshot()).await?;
        }
        Ok(())
    }

    pub(crate) async fn fail_without_checkpoint(&self, turn: ExecutionTurn) -> Result<()> {
        let ExecutionTurn {
            policy,
            operation_id,
            ..
        } = turn.failed("agent turn failed before checkpointing", true);
        let (Some(policy), Some(operation_id)) = (policy, operation_id) else {
            return Ok(());
        };
        policy
            .fail_attempt(
                operation_id,
                "agent turn failed before checkpointing".to_owned(),
            )
            .await
    }

    pub(crate) async fn release_turn(&self, turn: ExecutionTurn) {
        let ExecutionTurn {
            policy,
            operation_id,
            ..
        } = turn;
        if let (Some(policy), Some(operation_id)) = (policy, operation_id) {
            policy.release(operation_id).await;
        }
    }

    #[cfg(not(target_family = "wasm"))]
    pub(crate) async fn flush(&self) -> Result<()> {
        self.platform.flush().await
    }

    pub(crate) async fn shutdown(&self) -> Result<()> {
        let platform = self.platform.shutdown().await;
        let policy = match &self.policy {
            Some(policy) => policy.shutdown().await,
            None => Ok(()),
        };
        match (platform, policy) {
            (Err(error), _) => Err(error),
            (Ok(()), policy) => policy,
        }
    }
}

fn map_admission(admission: ExecutionAdmission) -> AdmittedExecution {
    match admission {
        ExecutionAdmission::Execute => AdmittedExecution::Execute,
        ExecutionAdmission::Completed { snapshot, output } => {
            AdmittedExecution::Completed { output, snapshot }
        }
        ExecutionAdmission::Failed { snapshot: _, error } => AdmittedExecution::Failed { error },
        ExecutionAdmission::Cancelled => AdmittedExecution::Cancelled,
    }
}

#[derive(Clone)]
pub(crate) struct ExecutionSteps {
    policy: Arc<dyn ExecutionPolicy>,
    operation_id: String,
}

pub(crate) enum ExecutionStep<O> {
    Execute,
    Replay(O),
}

impl ExecutionSteps {
    /// Durably authorizes an operation-owned model effect immediately before
    /// entering the transport.
    ///
    /// Authorization fences owners that were already stale. Once it returns,
    /// takeover can still fence the result but cannot retract an in-flight call.
    pub(crate) async fn authorize_model_effect(&self, kind: &'static str) -> Result<()> {
        self.policy.authorize_model_effect(kind).await
    }

    pub(crate) async fn begin<I, O>(
        &self,
        step_id: impl Into<String>,
        kind: impl Into<String>,
        input: &I,
        retry: ExecutionRetry,
    ) -> Result<ExecutionStep<O>>
    where
        I: Serialize + ?Sized,
        O: DeserializeOwned,
    {
        match self
            .policy
            .begin_step(
                self.operation_id.clone(),
                step_id.into(),
                kind.into(),
                encode(input)?,
                retry,
            )
            .await?
        {
            ExecutionStepAdmission::Execute => Ok(ExecutionStep::Execute),
            ExecutionStepAdmission::Replay(output) => Ok(ExecutionStep::Replay(decode(&output)?)),
        }
    }

    pub(crate) async fn complete<O: Serialize + ?Sized>(
        &self,
        step_id: impl Into<String>,
        output: &O,
    ) -> Result<()> {
        self.policy
            .complete_step(self.operation_id.clone(), step_id.into(), encode(output)?)
            .await
    }
}

enum ExecutionOutcome {
    Started,
    Completed(ExecutionOutput),
    Interrupted,
    Failed { error: String, retryable: bool },
}

pub(crate) struct ExecutionTurn {
    platform: platform::Turn,
    policy: Option<Arc<dyn ExecutionPolicy>>,
    operation_id: Option<String>,
    operation_input: Option<nanocodex_oai_api::Prompt>,
    outcome: ExecutionOutcome,
}

impl ExecutionTurn {
    pub(crate) async fn begin(&self) -> Result<()> {
        if let (Some(policy), Some(operation_id)) = (&self.policy, &self.operation_id) {
            policy.begin_attempt(operation_id.clone()).await?;
        }
        Ok(())
    }

    pub(crate) fn steps(&self) -> Option<ExecutionSteps> {
        Some(ExecutionSteps {
            policy: self.policy.clone()?,
            operation_id: self.operation_id.clone()?,
        })
    }

    pub(crate) fn completed(mut self, final_message: String, usage: TurnUsage) -> Self {
        self.platform = self.platform.completed(final_message.clone());
        self.outcome = ExecutionOutcome::Completed(ExecutionOutput {
            final_message,
            usage,
        });
        self
    }

    #[cfg_attr(target_family = "wasm", allow(clippy::missing_const_for_fn))]
    pub(crate) fn completed_without_message(mut self) -> Self {
        self.platform = self.platform.completed_without_message();
        self
    }

    pub(crate) fn interrupted(mut self) -> Self {
        self.platform = self.platform.interrupted();
        self.outcome = ExecutionOutcome::Interrupted;
        self
    }

    #[cfg_attr(target_family = "wasm", allow(clippy::missing_const_for_fn))]
    pub(crate) fn replaced(mut self) -> Self {
        self.platform = self.platform.replaced();
        self
    }

    pub(crate) fn failed(mut self, error: impl Into<String>, retryable: bool) -> Self {
        self.platform = self.platform.failed();
        self.outcome = ExecutionOutcome::Failed {
            error: error.into(),
            retryable,
        };
        self
    }
}

async fn persist_operation(
    policy: Option<Arc<dyn ExecutionPolicy>>,
    operation_id: Option<String>,
    operation_input: Option<nanocodex_oai_api::Prompt>,
    outcome: ExecutionOutcome,
    checkpoint: &CommittedSession,
) -> Result<()> {
    let Some(policy) = policy else {
        return Ok(());
    };
    let Some(operation_id) = operation_id else {
        return policy.commit_checkpoint(checkpoint.snapshot()).await;
    };
    match outcome {
        ExecutionOutcome::Completed(output) => {
            policy
                .complete(operation_id, checkpoint.snapshot(), output)
                .await
        }
        ExecutionOutcome::Interrupted => {
            let input = operation_input.as_ref().map(encode).transpose()?;
            cancel_with_reclaim(&policy, operation_id, input, Some(checkpoint.snapshot())).await
        }
        ExecutionOutcome::Failed { error, retryable } => {
            if retryable {
                policy.fail_attempt(operation_id, error).await
            } else {
                policy
                    .fail(operation_id, checkpoint.snapshot(), error)
                    .await
            }
        }
        ExecutionOutcome::Started => Err(NanocodexError::InvalidExecutionPolicy(
            "an operation reached persistence without a terminal attempt outcome".to_owned(),
        )),
    }
}

async fn cancel_with_reclaim(
    policy: &Arc<dyn ExecutionPolicy>,
    operation_id: String,
    input_json: Option<String>,
    snapshot: Option<SessionSnapshot>,
) -> Result<()> {
    let outcome = policy.cancel(operation_id.clone(), snapshot.clone()).await;
    if !outcome.as_ref().is_err_and(|error| {
        matches!(
            error.execution_policy_disposition(),
            Some(crate::ExecutionPolicyDisposition::Retry)
        )
    }) {
        return outcome;
    }

    let input_json = input_json.ok_or_else(|| {
        NanocodexError::InvalidExecutionPolicy(format!(
            "cancel retry for operation `{operation_id}` did not retain its admission input"
        ))
    })?;
    let admission = policy
        .admit(operation_id.clone(), input_json)
        .await
        .map_err(reopen_after_cancel_retry)?;
    match admission {
        ExecutionAdmission::Execute => policy
            .cancel(operation_id, snapshot)
            .await
            .map_err(reopen_after_cancel_retry),
        ExecutionAdmission::Cancelled => Ok(()),
        ExecutionAdmission::Completed { .. } | ExecutionAdmission::Failed { .. } => {
            Err(NanocodexError::InvalidExecutionPolicy(format!(
                "cancel retry for operation `{operation_id}` replayed an incompatible terminal outcome"
            )))
        }
    }
}

fn reopen_after_cancel_retry(error: NanocodexError) -> NanocodexError {
    if matches!(
        error.execution_policy_disposition(),
        Some(crate::ExecutionPolicyDisposition::Retry)
    ) {
        NanocodexError::execution_policy_with_disposition(
            "cancellation recovery",
            crate::ExecutionPolicyDisposition::Reopen,
            error,
        )
    } else {
        error
    }
}

fn encode<T: Serialize + ?Sized>(value: &T) -> Result<String> {
    serde_json::to_string(value).map_err(NanocodexError::ExecutionPayload)
}

fn decode<T: DeserializeOwned>(value: &str) -> Result<T> {
    serde_json::from_str(value).map_err(NanocodexError::ExecutionPayload)
}
