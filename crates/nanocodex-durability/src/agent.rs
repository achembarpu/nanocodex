use std::sync::{Arc, Mutex};

use nanocodex_agent::{
    ExecutionPolicyDisposition, NanocodexBuilder, NanocodexError, Result as AgentResult,
    execution::{
        ExecutionAdmission, ExecutionFuture, ExecutionOutput, ExecutionPolicy, ExecutionRetry,
        ExecutionStepAdmission,
    },
    session::SessionSnapshot,
};
use serde_json::value::RawValue;

use crate::{Admission, BeginStep, DurableSession, Error, RetryPolicy, session::DurableOwner};

/// Fluent compatibility extension that attaches portable durability to an
/// otherwise independent agent builder.
pub trait DurableAgentExt: Sized {
    /// Restores the journal's latest checkpoint and installs its execution
    /// policy at the agent's neutral lifecycle seam.
    fn durability(self, journal: DurableSession) -> impl Future<Output = AgentResult<Self>>;
}

impl<F> DurableAgentExt for NanocodexBuilder<F> {
    async fn durability(self, journal: DurableSession) -> AgentResult<Self> {
        let mut builder = self.default_prompt_cache_key(journal.journal_id().to_owned());
        let (owner, checkpoint) = journal.acquire_agent().await.map_err(agent_error)?;
        if let Some(checkpoint) = checkpoint {
            let restored = checkpoint
                .decode::<SessionSnapshot>()
                .map_err(agent_error)?;
            if let Some(configured) = builder.resume_snapshot()
                && serde_json::to_string(configured)
                    .map_err(|error| NanocodexError::InvalidSessionSnapshot(error.to_string()))?
                    != checkpoint.json()
            {
                return Err(NanocodexError::InvalidSessionSnapshot(
                    "configured resume snapshot does not match the durability journal".to_owned(),
                ));
            }
            builder = builder.resume(restored);
        }
        let owner = Arc::new(Mutex::new(Some(owner)));
        Ok(builder.execution_policy_factory(move || {
            let owner = owner
                .lock()
                .map_err(|_| {
                    NanocodexError::InvalidExecutionPolicy(
                        "the durability-attached builder owner lock was poisoned".to_owned(),
                    )
                })?
                .take()
                .ok_or_else(|| {
                    NanocodexError::InvalidExecutionPolicy(
                        "a durability-attached builder can build only one agent; attach durability again to reopen the journal"
                            .to_owned(),
                    )
                })?;
            let policy: Arc<dyn ExecutionPolicy> = Arc::new(DurableExecution { owner });
            Ok(policy)
        }))
    }
}

struct DurableExecution {
    owner: DurableOwner,
}

impl ExecutionPolicy for DurableExecution {
    fn shutdown<'a>(&'a self) -> ExecutionFuture<'a, AgentResult<()>> {
        Box::pin(async move { self.owner.shutdown().await.map_err(agent_error) })
    }

    fn commit_checkpoint<'a>(
        &'a self,
        snapshot: SessionSnapshot,
    ) -> ExecutionFuture<'a, AgentResult<()>> {
        Box::pin(async move {
            self.owner
                .commit_checkpoint(&snapshot)
                .await
                .map_err(agent_error)
        })
    }

    fn authorize_model_effect<'a>(
        &'a self,
        kind: &'static str,
    ) -> ExecutionFuture<'a, AgentResult<()>> {
        Box::pin(async move {
            self.owner
                .authorize_model_effect(kind)
                .await
                .map_err(agent_error)
        })
    }

    fn admit<'a>(
        &'a self,
        operation_id: String,
        input_json: String,
    ) -> ExecutionFuture<'a, AgentResult<ExecutionAdmission>> {
        Box::pin(async move {
            let input = raw(input_json)?;
            self.owner
                .admit_typed::<_, SessionSnapshot, ExecutionOutput>(operation_id, &input)
                .await
                .map(map_admission)
                .map_err(agent_error)
        })
    }

    fn admit_automatic<'a>(
        &'a self,
        candidate_operation_id: String,
        input_json: String,
    ) -> ExecutionFuture<'a, AgentResult<(String, ExecutionAdmission)>> {
        Box::pin(async move {
            let input = raw(input_json)?;
            let admission = self
                .owner
                .admit_automatic_typed::<_, SessionSnapshot, ExecutionOutput>(
                    candidate_operation_id,
                    &input,
                )
                .await
                .map_err(agent_error)?;
            let (operation_id, admission) = admission.into_parts();
            Ok((operation_id, map_admission(admission)))
        })
    }

    fn release<'a>(&'a self, operation_id: String) -> ExecutionFuture<'a, ()> {
        Box::pin(async move {
            let _ = self.owner.release_claim(operation_id).await;
        })
    }

    fn cancel<'a>(
        &'a self,
        operation_id: String,
        snapshot: Option<SessionSnapshot>,
    ) -> ExecutionFuture<'a, AgentResult<()>> {
        Box::pin(async move {
            self.owner
                .cancel(operation_id, snapshot.as_ref())
                .await
                .map_err(agent_error)
        })
    }

    fn begin_attempt<'a>(&'a self, operation_id: String) -> ExecutionFuture<'a, AgentResult<()>> {
        Box::pin(async move {
            self.owner
                .begin_attempt(operation_id)
                .await
                .map(|_| ())
                .map_err(agent_error)
        })
    }

    fn begin_step<'a>(
        &'a self,
        operation_id: String,
        step_id: String,
        kind: String,
        input_json: String,
        retry: ExecutionRetry,
    ) -> ExecutionFuture<'a, AgentResult<ExecutionStepAdmission>> {
        Box::pin(async move {
            let input = raw(input_json)?;
            self.owner
                .begin_step(operation_id, step_id, kind, &input, map_retry(retry))
                .await
                .map(|admission| match admission {
                    BeginStep::Execute => ExecutionStepAdmission::Execute,
                    BeginStep::Replay(output) => {
                        ExecutionStepAdmission::Replay(output.json().to_owned())
                    }
                })
                .map_err(agent_error)
        })
    }

    fn complete_step<'a>(
        &'a self,
        operation_id: String,
        step_id: String,
        output_json: String,
    ) -> ExecutionFuture<'a, AgentResult<()>> {
        Box::pin(async move {
            let output = raw(output_json)?;
            self.owner
                .complete_step(operation_id, step_id, &output)
                .await
                .map_err(agent_error)
        })
    }

    fn complete<'a>(
        &'a self,
        operation_id: String,
        snapshot: SessionSnapshot,
        output: ExecutionOutput,
    ) -> ExecutionFuture<'a, AgentResult<()>> {
        Box::pin(async move {
            self.owner
                .complete(operation_id, &snapshot, &output)
                .await
                .map_err(agent_error)
        })
    }

    fn fail_attempt<'a>(
        &'a self,
        operation_id: String,
        error: String,
    ) -> ExecutionFuture<'a, AgentResult<()>> {
        Box::pin(async move {
            self.owner
                .fail_attempt(operation_id, error)
                .await
                .map_err(agent_error)
        })
    }

    fn fail<'a>(
        &'a self,
        operation_id: String,
        snapshot: SessionSnapshot,
        error: String,
    ) -> ExecutionFuture<'a, AgentResult<()>> {
        Box::pin(async move {
            self.owner
                .fail(operation_id, &snapshot, error)
                .await
                .map_err(agent_error)
        })
    }
}

fn map_admission(admission: Admission<SessionSnapshot, ExecutionOutput>) -> ExecutionAdmission {
    match admission {
        Admission::Accepted | Admission::Pending => ExecutionAdmission::Execute,
        Admission::Completed { checkpoint, output } => ExecutionAdmission::Completed {
            snapshot: checkpoint,
            output,
        },
        Admission::Failed { checkpoint, error } => ExecutionAdmission::Failed {
            snapshot: checkpoint,
            error,
        },
        Admission::Cancelled => ExecutionAdmission::Cancelled,
    }
}

const fn map_retry(retry: ExecutionRetry) -> RetryPolicy {
    match retry {
        ExecutionRetry::Idempotent => RetryPolicy::Idempotent,
        ExecutionRetry::Never => RetryPolicy::Never,
    }
}

fn raw(json: String) -> AgentResult<Box<RawValue>> {
    RawValue::from_string(json).map_err(NanocodexError::ExecutionPayload)
}

fn agent_error(error: Error) -> NanocodexError {
    let disposition = match &error {
        Error::Store(crate::StoreError::NotCommitted(_))
        | Error::OperationBlocked { .. }
        | Error::OperationActive { .. } => ExecutionPolicyDisposition::Retry,
        Error::AmbiguousStep { .. } => ExecutionPolicyDisposition::Blocked,
        Error::Store(
            crate::StoreError::Fenced
            | crate::StoreError::Conflict { .. }
            | crate::StoreError::Backend(_),
        )
        | Error::ModelOwnerFenced
        | Error::DriverStopped => ExecutionPolicyDisposition::Reopen,
        _ => ExecutionPolicyDisposition::Fatal,
    };
    NanocodexError::execution_policy_with_disposition("durability", disposition, error)
}

#[cfg(test)]
mod tests {
    use nanocodex_agent::ExecutionPolicyDisposition;

    use super::*;

    #[test]
    fn durability_errors_preserve_their_required_recovery_action() {
        let cases = [
            (
                Error::Store(crate::StoreError::NotCommitted("retry".to_owned())),
                ExecutionPolicyDisposition::Retry,
            ),
            (
                Error::AmbiguousStep {
                    operation_id: "turn".to_owned(),
                    step_id: "tool".to_owned(),
                },
                ExecutionPolicyDisposition::Blocked,
            ),
            (
                Error::Store(crate::StoreError::Fenced),
                ExecutionPolicyDisposition::Reopen,
            ),
            (
                Error::InvalidJournal("broken".to_owned()),
                ExecutionPolicyDisposition::Fatal,
            ),
        ];
        for (error, expected) in cases {
            assert_eq!(
                agent_error(error).execution_policy_disposition(),
                Some(expected)
            );
        }
    }
}
