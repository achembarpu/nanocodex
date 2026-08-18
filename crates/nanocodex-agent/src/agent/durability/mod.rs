#[cfg(not(target_family = "wasm"))]
#[path = "native.rs"]
mod platform;

#[cfg(all(target_family = "wasm", target_os = "unknown"))]
#[path = "disabled.rs"]
mod platform;

use nanocodex_durability::{Admission, BeginStep, DurableSession, RetryPolicy};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::{
    NanocodexError, Result,
    session::{CommittedSession, SessionSnapshot},
    usage::TurnUsage,
};

#[cfg(not(target_family = "wasm"))]
use crate::rollout::{RolloutConfig, RolloutInfo};

#[derive(Clone, Default)]
pub(crate) struct DurabilityConfig {
    platform: platform::Config,
    journal: Option<DurableSession>,
}

impl DurabilityConfig {
    #[cfg(not(target_family = "wasm"))]
    pub(crate) fn set_rollout(&mut self, rollout: RolloutConfig) {
        self.platform.set_rollout(rollout);
    }

    pub(crate) fn set_journal(&mut self, journal: DurableSession) {
        self.journal = Some(journal);
    }

    #[cfg_attr(target_family = "wasm", allow(clippy::missing_const_for_fn))]
    pub(crate) fn for_new_thread(&self) -> Self {
        Self {
            platform: self.platform.for_new_thread(),
            // A child has another session identity and must be explicitly
            // attached to its own journal by its caller.
            journal: None,
        }
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
    ) -> Result<Durability> {
        Ok(Durability {
            platform: self.platform.start(
                session_id,
                workspace,
                instructions,
                origin_kind,
                parent_session_id,
                resume_history_len,
            )?,
            journal: self.journal.clone(),
        })
    }
}

#[derive(Clone)]
pub(crate) struct Durability {
    platform: platform::Durability,
    journal: Option<DurableSession>,
}

pub(crate) enum DurableAdmission {
    Execute,
    Completed {
        output: DurableTurnOutput,
        snapshot: SessionSnapshot,
    },
    Cancelled,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct DurableTurnOutput {
    pub(crate) final_message: String,
    pub(crate) usage: TurnUsage,
}

impl Durability {
    #[cfg(not(target_family = "wasm"))]
    pub(crate) const fn info(&self) -> Option<&RolloutInfo> {
        self.platform.info()
    }

    pub(crate) const fn journals_prompts(&self) -> bool {
        self.journal.is_some()
    }

    pub(crate) async fn admit<T: Serialize + ?Sized>(
        &self,
        operation_id: &str,
        input: &T,
    ) -> Result<DurableAdmission> {
        let journal = self
            .journal
            .as_ref()
            .ok_or(NanocodexError::DurabilityNotConfigured)?;
        Ok(map_admission(
            journal
                .admit_typed::<_, SessionSnapshot, DurableTurnOutput>(operation_id, input)
                .await?,
        ))
    }

    pub(crate) async fn admit_automatic<T: Serialize + ?Sized>(
        &self,
        candidate_operation_id: String,
        input: &T,
    ) -> Result<(String, DurableAdmission)> {
        let journal = self
            .journal
            .as_ref()
            .ok_or(NanocodexError::DurabilityNotConfigured)?;
        let admission = journal
            .admit_automatic_typed::<_, SessionSnapshot, DurableTurnOutput>(
                candidate_operation_id,
                input,
            )
            .await?;
        let (operation_id, admission) = admission.into_parts();
        Ok((operation_id, map_admission(admission)))
    }

    pub(crate) async fn release_claim(&self, operation_id: &str) {
        if let Some(journal) = &self.journal {
            let _ = journal.release(operation_id).await;
        }
    }

    pub(crate) async fn cancel_operation(&self, operation_id: &str) -> Result<()> {
        let journal = self
            .journal
            .as_ref()
            .ok_or(NanocodexError::DurabilityNotConfigured)?;
        journal.cancel(operation_id).await.map_err(Into::into)
    }

    pub(crate) fn start_turn(
        &self,
        prompt: &nanocodex_oai_api::Prompt,
        effort: nanocodex_oai_api::Thinking,
        operation_id: Option<String>,
    ) -> DurabilityTurn {
        DurabilityTurn {
            platform: self.platform.start_turn(prompt, effort),
            journal: self.journal.clone(),
            operation_id,
            outcome: JournalOutcome::Started,
        }
    }

    #[cfg_attr(target_family = "wasm", allow(clippy::missing_const_for_fn))]
    pub(crate) fn start_compaction(&self, effort: nanocodex_oai_api::Thinking) -> DurabilityTurn {
        DurabilityTurn {
            platform: self.platform.start_compaction(effort),
            journal: None,
            operation_id: None,
            outcome: JournalOutcome::Started,
        }
    }

    pub(crate) async fn persist(
        &self,
        checkpoint: &CommittedSession,
        turn: DurabilityTurn,
    ) -> Result<()> {
        let DurabilityTurn {
            platform,
            journal,
            operation_id,
            outcome,
        } = turn;
        self.platform.persist(checkpoint, platform).await;
        persist_journal(journal, operation_id, outcome, checkpoint).await
    }

    pub(crate) async fn persist_compaction(
        &self,
        checkpoint: &CommittedSession,
        turn: DurabilityTurn,
    ) -> Result<()> {
        self.platform
            .persist_compaction(checkpoint, turn.platform)
            .await;
        Ok(())
    }

    pub(crate) async fn fail_without_checkpoint(&self, turn: DurabilityTurn) -> Result<()> {
        let DurabilityTurn {
            journal,
            operation_id,
            ..
        } = turn.failed();
        let (Some(journal), Some(operation_id)) = (journal, operation_id) else {
            return Ok(());
        };
        journal
            .fail_attempt(&operation_id, "agent turn failed before checkpointing")
            .await
            .map_err(Into::into)
    }

    #[cfg(not(target_family = "wasm"))]
    pub(crate) async fn flush(&self) -> Result<()> {
        self.platform.flush().await
    }

    pub(crate) async fn shutdown(&self) -> Result<()> {
        self.platform.shutdown().await
    }
}

fn map_admission(admission: Admission<SessionSnapshot, DurableTurnOutput>) -> DurableAdmission {
    match admission {
        Admission::Accepted | Admission::Pending => DurableAdmission::Execute,
        Admission::Completed { checkpoint, output } => DurableAdmission::Completed {
            output,
            snapshot: checkpoint,
        },
        Admission::Cancelled => DurableAdmission::Cancelled,
    }
}

#[derive(Clone)]
pub(crate) struct DurableSteps {
    journal: DurableSession,
    operation_id: String,
}

pub(crate) enum DurableStep<O> {
    Execute,
    Replay(O),
}

impl DurableSteps {
    pub(crate) async fn begin<I, O>(
        &self,
        step_id: impl Into<String>,
        kind: impl Into<String>,
        input: &I,
        retry: RetryPolicy,
    ) -> Result<DurableStep<O>>
    where
        I: Serialize + ?Sized,
        O: DeserializeOwned,
    {
        match self
            .journal
            .begin_step_typed(&self.operation_id, step_id, kind, input, retry)
            .await?
        {
            BeginStep::Execute => Ok(DurableStep::Execute),
            BeginStep::Replay(output) => Ok(DurableStep::Replay(output)),
        }
    }

    pub(crate) async fn complete<O: Serialize + ?Sized>(
        &self,
        step_id: impl Into<String>,
        output: &O,
    ) -> Result<()> {
        self.journal
            .complete_step(&self.operation_id, step_id, output)
            .await
            .map_err(Into::into)
    }
}

enum JournalOutcome {
    Started,
    Completed(DurableTurnOutput),
    Interrupted,
    Failed,
}

pub(crate) struct DurabilityTurn {
    platform: platform::Turn,
    journal: Option<DurableSession>,
    operation_id: Option<String>,
    outcome: JournalOutcome,
}

impl DurabilityTurn {
    pub(crate) async fn begin(&self) -> Result<()> {
        if let (Some(journal), Some(operation_id)) = (&self.journal, &self.operation_id) {
            journal.begin_attempt(operation_id).await?;
        }
        Ok(())
    }

    pub(crate) fn steps(&self) -> Option<DurableSteps> {
        Some(DurableSteps {
            journal: self.journal.clone()?,
            operation_id: self.operation_id.clone()?,
        })
    }

    pub(crate) fn completed(mut self, final_message: String, usage: TurnUsage) -> Self {
        self.platform = self.platform.completed(final_message.clone());
        self.outcome = JournalOutcome::Completed(DurableTurnOutput {
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
        self.outcome = JournalOutcome::Interrupted;
        self
    }

    #[cfg_attr(target_family = "wasm", allow(clippy::missing_const_for_fn))]
    pub(crate) fn replaced(mut self) -> Self {
        self.platform = self.platform.replaced();
        self
    }

    pub(crate) fn failed(mut self) -> Self {
        self.platform = self.platform.failed();
        self.outcome = JournalOutcome::Failed;
        self
    }
}

async fn persist_journal(
    journal: Option<DurableSession>,
    operation_id: Option<String>,
    outcome: JournalOutcome,
    checkpoint: &CommittedSession,
) -> Result<()> {
    let (Some(journal), Some(operation_id)) = (journal, operation_id) else {
        return Ok(());
    };
    let outcome = match outcome {
        JournalOutcome::Completed(output) => {
            journal
                .complete(&operation_id, &checkpoint.snapshot(), &output)
                .await
        }
        JournalOutcome::Interrupted => journal.cancel(&operation_id).await,
        JournalOutcome::Failed => {
            journal
                .fail_attempt(&operation_id, "agent turn failed")
                .await
        }
        JournalOutcome::Started => {
            return Err(NanocodexError::from(
                nanocodex_durability::Error::InvalidJournal(format!(
                    "operation `{operation_id}` persisted without a terminal attempt outcome"
                )),
            ));
        }
    };
    outcome.map_err(Into::into)
}
