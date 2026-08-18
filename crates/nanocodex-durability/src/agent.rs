use std::sync::Arc;

use nanocodex_agent::{
    NanocodexBuilder, NanocodexError, Result as AgentResult,
    execution::{
        ExecutionAdmission, ExecutionFuture, ExecutionOutput, ExecutionPolicy, ExecutionRetry,
        ExecutionStepAdmission,
    },
    session::SessionSnapshot,
};
use serde_json::value::RawValue;

use crate::{Admission, BeginStep, DurableSession, Error, RetryPolicy};

/// Fluent compatibility extension that attaches portable durability to an
/// otherwise independent agent builder.
pub trait DurableAgentExt: Sized {
    /// Restores the journal's latest checkpoint and installs its execution
    /// policy at the agent's neutral lifecycle seam.
    fn durability(self, journal: DurableSession) -> impl Future<Output = AgentResult<Self>>;
}

impl<F> DurableAgentExt for NanocodexBuilder<F> {
    async fn durability(self, journal: DurableSession) -> AgentResult<Self> {
        let mut builder = self;
        if let Some(checkpoint) = journal.latest_checkpoint().await.map_err(agent_error)? {
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
        Ok(builder.execution_policy(Arc::new(DurableExecution { journal })))
    }
}

struct DurableExecution {
    journal: DurableSession,
}

impl ExecutionPolicy for DurableExecution {
    fn admit<'a>(
        &'a self,
        operation_id: String,
        input_json: String,
    ) -> ExecutionFuture<'a, AgentResult<ExecutionAdmission>> {
        Box::pin(async move {
            let input = raw(input_json)?;
            self.journal
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
                .journal
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
            let _ = self.journal.release(operation_id).await;
        })
    }

    fn cancel<'a>(&'a self, operation_id: String) -> ExecutionFuture<'a, AgentResult<()>> {
        Box::pin(async move { self.journal.cancel(operation_id).await.map_err(agent_error) })
    }

    fn begin_attempt<'a>(&'a self, operation_id: String) -> ExecutionFuture<'a, AgentResult<()>> {
        Box::pin(async move {
            self.journal
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
            self.journal
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
            self.journal
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
            self.journal
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
            self.journal
                .fail_attempt(operation_id, error)
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
    RawValue::from_string(json).map_err(|error| NanocodexError::ExecutionPayload(error))
}

fn agent_error(error: Error) -> NanocodexError {
    NanocodexError::execution_policy("durability", error)
}
