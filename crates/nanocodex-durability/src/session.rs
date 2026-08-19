use std::{collections::HashSet, sync::Arc};

use serde::{Serialize, de::DeserializeOwned};
use tokio::sync::{mpsc, oneshot};

use crate::{
    EncodedPayload, Entry, Error, JournalState, JournalStore, OperationStatus, Result, RetryPolicy,
    StepStatus, StoreError,
};

const COMMAND_CAPACITY: usize = 64;

/// Result of submitting one idempotent operation.
#[derive(Clone, Debug)]
pub enum Admission<C = EncodedPayload, O = EncodedPayload> {
    /// This call durably accepted new work.
    Accepted,
    /// The same input was already accepted and remains unfinished.
    Pending,
    /// The operation already completed.
    Completed {
        /// Checkpoint committed with the result.
        checkpoint: C,
        /// Previously completed result.
        output: O,
    },
    /// The operation was explicitly cancelled.
    Cancelled,
}

/// One automatically identified operation and its admission result.
#[derive(Clone, Debug)]
pub struct AutomaticAdmission<C = EncodedPayload, O = EncodedPayload> {
    operation_id: String,
    admission: Admission<C, O>,
}

impl<C, O> AutomaticAdmission<C, O> {
    /// Identity assigned to the admitted operation.
    #[must_use]
    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }

    /// Splits the assigned operation identity from its admission result.
    #[must_use]
    pub fn into_parts(self) -> (String, Admission<C, O>) {
        (self.operation_id, self.admission)
    }
}

/// Result of beginning a replayable step.
#[derive(Clone, Debug)]
pub enum BeginStep<O = EncodedPayload> {
    /// The caller owns this execution attempt and may perform the step.
    Execute,
    /// A prior attempt completed; use this stored output instead of executing.
    Replay(O),
}

enum StoredAdmission {
    Accepted,
    Pending,
    Completed {
        checkpoint: EncodedPayload,
        output: EncodedPayload,
    },
    Cancelled,
}

impl StoredAdmission {
    fn into_encoded(self) -> Admission {
        match self {
            Self::Accepted => Admission::Accepted,
            Self::Pending => Admission::Pending,
            Self::Completed { checkpoint, output } => Admission::Completed { checkpoint, output },
            Self::Cancelled => Admission::Cancelled,
        }
    }

    fn decode<C, O>(self) -> Result<Admission<C, O>>
    where
        C: DeserializeOwned,
        O: DeserializeOwned,
    {
        match self {
            Self::Accepted => Ok(Admission::Accepted),
            Self::Pending => Ok(Admission::Pending),
            Self::Completed { checkpoint, output } => Ok(Admission::Completed {
                checkpoint: checkpoint.decode()?,
                output: output.decode()?,
            }),
            Self::Cancelled => Ok(Admission::Cancelled),
        }
    }
}

enum StoredBeginStep {
    Execute,
    Replay(EncodedPayload),
}

enum Command {
    State {
        result: oneshot::Sender<JournalState>,
    },
    LatestCheckpoint {
        result: oneshot::Sender<Option<EncodedPayload>>,
    },
    Admit {
        operation_id: String,
        input: EncodedPayload,
        result: oneshot::Sender<Result<StoredAdmission>>,
    },
    AdmitAutomatic {
        candidate_operation_id: String,
        input: EncodedPayload,
        result: oneshot::Sender<Result<(String, StoredAdmission)>>,
    },
    Release {
        operation_id: String,
    },
    BeginAttempt {
        operation_id: String,
        result: oneshot::Sender<Result<u32>>,
    },
    BeginStep {
        operation_id: String,
        step_id: String,
        kind: String,
        input: EncodedPayload,
        retry: RetryPolicy,
        result: oneshot::Sender<Result<StoredBeginStep>>,
    },
    CompleteStep {
        operation_id: String,
        step_id: String,
        output: EncodedPayload,
        result: oneshot::Sender<Result<()>>,
    },
    Complete {
        operation_id: String,
        checkpoint: EncodedPayload,
        output: EncodedPayload,
        result: oneshot::Sender<Result<()>>,
    },
    FailAttempt {
        operation_id: String,
        error: String,
        result: oneshot::Sender<Result<()>>,
    },
    Cancel {
        operation_id: String,
        result: oneshot::Sender<Result<()>>,
    },
}

struct Driver {
    store: Box<dyn JournalStore>,
    journal_id: Arc<str>,
    state: JournalState,
    claimed: HashSet<String>,
    poisoned: bool,
    commands: mpsc::Receiver<Command>,
}

impl Driver {
    async fn run(mut self) {
        while let Some(command) = self.commands.recv().await {
            match command {
                Command::State { result } => drop(result.send(self.state.clone())),
                Command::LatestCheckpoint { result } => {
                    drop(result.send(self.state.latest_checkpoint().cloned()));
                }
                Command::Admit {
                    operation_id,
                    input,
                    result,
                } => {
                    let outcome = self.admit(operation_id, input).await;
                    drop(result.send(outcome));
                }
                Command::AdmitAutomatic {
                    candidate_operation_id,
                    input,
                    result,
                } => {
                    let outcome = self.admit_automatic(candidate_operation_id, input).await;
                    drop(result.send(outcome));
                }
                Command::Release { operation_id } => {
                    self.claimed.remove(&operation_id);
                }
                Command::BeginAttempt {
                    operation_id,
                    result,
                } => {
                    let outcome = self.begin_attempt(operation_id).await;
                    drop(result.send(outcome));
                }
                Command::BeginStep {
                    operation_id,
                    step_id,
                    kind,
                    input,
                    retry,
                    result,
                } => {
                    let outcome = self
                        .begin_step(operation_id, step_id, kind, input, retry)
                        .await;
                    drop(result.send(outcome));
                }
                Command::CompleteStep {
                    operation_id,
                    step_id,
                    output,
                    result,
                } => {
                    let outcome = self.complete_step(operation_id, step_id, output).await;
                    drop(result.send(outcome));
                }
                Command::Complete {
                    operation_id,
                    checkpoint,
                    output,
                    result,
                } => {
                    let outcome = self.complete(operation_id, checkpoint, output).await;
                    drop(result.send(outcome));
                }
                Command::FailAttempt {
                    operation_id,
                    error,
                    result,
                } => {
                    let outcome = self
                        .append(Entry::AttemptFailed {
                            operation_id: operation_id.clone(),
                            error,
                        })
                        .await;
                    self.claimed.remove(&operation_id);
                    drop(result.send(outcome));
                }
                Command::Cancel {
                    operation_id,
                    result,
                } => {
                    let outcome = self
                        .append(Entry::OperationCancelled {
                            operation_id: operation_id.clone(),
                        })
                        .await;
                    self.claimed.remove(&operation_id);
                    drop(result.send(outcome));
                }
            }
            if self.poisoned {
                break;
            }
        }
    }

    async fn admit(
        &mut self,
        operation_id: String,
        input: EncodedPayload,
    ) -> Result<StoredAdmission> {
        if let Some(operation) = self.state.operation(&operation_id) {
            if operation.input != input {
                return Err(Error::OperationConflict { operation_id });
            }
            return match &operation.status {
                OperationStatus::Pending => {
                    if !self.claimed.insert(operation_id.clone()) {
                        return Err(Error::OperationActive { operation_id });
                    }
                    Ok(StoredAdmission::Pending)
                }
                OperationStatus::Completed { checkpoint, output } => {
                    Ok(StoredAdmission::Completed {
                        checkpoint: checkpoint.clone(),
                        output: output.clone(),
                    })
                }
                OperationStatus::Cancelled => Ok(StoredAdmission::Cancelled),
            };
        }
        self.append(Entry::OperationAccepted {
            operation_id: operation_id.clone(),
            input,
        })
        .await?;
        self.claimed.insert(operation_id);
        Ok(StoredAdmission::Accepted)
    }

    async fn admit_automatic(
        &mut self,
        candidate_operation_id: String,
        input: EncodedPayload,
    ) -> Result<(String, StoredAdmission)> {
        if let Some((pending_id, operation)) = self
            .state
            .pending_operations()
            .into_iter()
            .find(|(pending_id, _)| !self.claimed.contains(*pending_id))
        {
            if operation.input != input {
                return Err(Error::OperationBlocked {
                    operation_id: candidate_operation_id,
                    pending_id: pending_id.to_owned(),
                });
            }
            let recovered_operation_id = pending_id.to_owned();
            let admission = self.admit(recovered_operation_id.clone(), input).await?;
            return Ok((recovered_operation_id, admission));
        }

        let admission = self.admit(candidate_operation_id.clone(), input).await?;
        Ok((candidate_operation_id, admission))
    }

    async fn begin_attempt(&mut self, operation_id: String) -> Result<u32> {
        if let Some((pending_id, _)) = self.state.first_pending_operation()
            && pending_id != operation_id
        {
            return Err(Error::OperationBlocked {
                operation_id,
                pending_id: pending_id.to_owned(),
            });
        }
        let operation = self.state.operation(&operation_id).ok_or_else(|| {
            Error::InvalidJournal(format!("operation `{operation_id}` was not accepted"))
        })?;
        if operation.status.is_terminal() {
            return Err(Error::OperationTerminal { operation_id });
        }
        self.append(Entry::AttemptStarted {
            operation_id: operation_id.clone(),
        })
        .await?;
        Ok(self
            .state
            .operation(&operation_id)
            .map_or(0, |operation| operation.attempts))
    }

    async fn begin_step(
        &mut self,
        operation_id: String,
        step_id: String,
        kind: String,
        input: EncodedPayload,
        retry: RetryPolicy,
    ) -> Result<StoredBeginStep> {
        if let Some(step) = self
            .state
            .operation(&operation_id)
            .and_then(|operation| operation.steps.get(&step_id))
        {
            if step.kind != kind || step.input != input || step.retry != retry {
                return Err(Error::InvalidJournal(format!(
                    "step `{step_id}` in operation `{operation_id}` changed definition"
                )));
            }
            match &step.status {
                StepStatus::Completed(output) => {
                    return Ok(StoredBeginStep::Replay(output.clone()));
                }
                StepStatus::Started if retry == RetryPolicy::Never => {
                    return Err(Error::AmbiguousStep {
                        operation_id,
                        step_id,
                    });
                }
                StepStatus::Started => {}
            }
        }
        self.append(Entry::StepStarted {
            operation_id,
            step_id,
            kind,
            input,
            retry,
        })
        .await?;
        Ok(StoredBeginStep::Execute)
    }

    async fn complete_step(
        &mut self,
        operation_id: String,
        step_id: String,
        output: EncodedPayload,
    ) -> Result<()> {
        let Some(step) = self
            .state
            .operation(&operation_id)
            .and_then(|operation| operation.steps.get(&step_id))
        else {
            return Err(Error::StepNotStarted {
                operation_id,
                step_id,
            });
        };
        if matches!(step.status, StepStatus::Completed(_)) {
            return Err(Error::InvalidJournal(format!(
                "step `{step_id}` in operation `{operation_id}` already completed"
            )));
        }
        self.append(Entry::StepCompleted {
            operation_id,
            step_id,
            output,
        })
        .await
    }

    async fn complete(
        &mut self,
        operation_id: String,
        checkpoint: EncodedPayload,
        output: EncodedPayload,
    ) -> Result<()> {
        let outcome = self
            .append(Entry::OperationCompleted {
                operation_id: operation_id.clone(),
                checkpoint,
                output,
            })
            .await;
        self.claimed.remove(&operation_id);
        outcome
    }

    async fn append(&mut self, entry: Entry) -> Result<()> {
        let expected_revision = self.state.revision().checked_add(1).ok_or_else(|| {
            Error::InvalidJournal("journal revision exceeded the u64 range".to_owned())
        })?;
        self.state.validate_batch(expected_revision, &entry)?;
        let payload = serde_json::to_string(&entry)?;
        let revision = match self
            .store
            .append(&self.journal_id, self.state.revision(), &payload)
            .await
        {
            Ok(revision) => revision,
            Err(error @ StoreError::NotCommitted(_)) => return Err(error.into()),
            Err(error) => {
                self.poisoned = true;
                return Err(error.into());
            }
        };
        if revision != expected_revision {
            self.poisoned = true;
            return Err(Error::InvalidJournal(format!(
                "store returned revision {revision} after appending expected revision {expected_revision}"
            )));
        }
        if let Err(error) = self.state.apply_batch(revision, &entry) {
            self.poisoned = true;
            return Err(error);
        }
        Ok(())
    }
}

/// Cheap command handle for an owned durable-journal driver.
///
/// The spawned driver is the sole owner of the reduced journal state and all
/// live operation claims. Clones only enqueue commands and await typed replies.
#[derive(Clone)]
pub struct DurableSession {
    journal_id: Arc<str>,
    commands: mpsc::Sender<Command>,
}

impl DurableSession {
    /// Loads and validates a durable session, then spawns its owning driver.
    pub async fn open<S>(mut store: S, journal_id: impl Into<String>) -> Result<Self>
    where
        S: JournalStore + 'static,
    {
        let journal_id = journal_id.into();
        if journal_id.trim().is_empty() {
            return Err(Error::InvalidJournal(
                "journal identity must not be empty".to_owned(),
            ));
        }
        let stored = store.load(&journal_id).await?;
        let mut state = JournalState::default();
        for batch in stored.batches {
            let entry =
                serde_json::from_str::<Entry>(&batch.payload).map_err(|source| Error::Decode {
                    revision: batch.revision,
                    source,
                })?;
            state.apply_batch(batch.revision, &entry)?;
        }
        if state.revision() != stored.revision {
            return Err(Error::InvalidJournal(format!(
                "store reported revision {}, but batches reduce to {}",
                stored.revision,
                state.revision()
            )));
        }
        let journal_id = Arc::<str>::from(journal_id);
        let (commands, receiver) = mpsc::channel(COMMAND_CAPACITY);
        spawn_driver(Driver {
            store: Box::new(store),
            journal_id: Arc::clone(&journal_id),
            state,
            claimed: HashSet::new(),
            poisoned: false,
            commands: receiver,
        })?;
        Ok(Self {
            journal_id,
            commands,
        })
    }

    /// Stable host-store journal identity.
    #[must_use]
    pub fn journal_id(&self) -> &str {
        &self.journal_id
    }

    /// Copies the current reduced state from the owning driver.
    pub async fn state(&self) -> Result<JournalState> {
        let (result, receiver) = oneshot::channel();
        self.send(Command::State { result }).await?;
        receiver.await.map_err(|_| Error::DriverStopped)
    }

    /// Copies the latest completed checkpoint from the owning driver without
    /// cloning the rest of the reduced journal.
    pub async fn latest_checkpoint(&self) -> Result<Option<EncodedPayload>> {
        let (result, receiver) = oneshot::channel();
        self.send(Command::LatestCheckpoint { result }).await?;
        receiver.await.map_err(|_| Error::DriverStopped)
    }

    /// Durably accepts and claims an operation, retaining terminal payloads in
    /// their encoded journal form.
    pub async fn admit<I>(&self, operation_id: impl Into<String>, input: &I) -> Result<Admission>
    where
        I: Serialize + ?Sized,
    {
        Ok(self
            .admit_encoded(operation_id.into(), EncodedPayload::encode(input)?)
            .await?
            .into_encoded())
    }

    /// Durably accepts and claims an operation with typed replay values.
    pub async fn admit_typed<I, C, O>(
        &self,
        operation_id: impl Into<String>,
        input: &I,
    ) -> Result<Admission<C, O>>
    where
        I: Serialize + ?Sized,
        C: DeserializeOwned,
        O: DeserializeOwned,
    {
        self.admit_encoded(operation_id.into(), EncodedPayload::encode(input)?)
            .await?
            .decode()
    }

    /// Durably admits automatically identified work, retaining terminal
    /// payloads in their encoded journal form.
    ///
    /// The candidate identity is used for new work. If the oldest unclaimed
    /// pending operation has identical input, that operation is reclaimed and
    /// its previously stored identity is returned instead.
    pub async fn admit_automatic<I>(
        &self,
        candidate_operation_id: impl Into<String>,
        input: &I,
    ) -> Result<AutomaticAdmission>
    where
        I: Serialize + ?Sized,
    {
        let (operation_id, admission) = self
            .admit_automatic_encoded(
                candidate_operation_id.into(),
                EncodedPayload::encode(input)?,
            )
            .await?;
        Ok(AutomaticAdmission {
            operation_id,
            admission: admission.into_encoded(),
        })
    }

    /// Durably admits automatically identified work, reclaiming the oldest
    /// unclaimed pending operation when its input is identical.
    ///
    /// `candidate_operation_id` is used for new work. Recovered work retains
    /// its previously stored identity, which is returned with the admission.
    pub async fn admit_automatic_typed<I, C, O>(
        &self,
        candidate_operation_id: impl Into<String>,
        input: &I,
    ) -> Result<AutomaticAdmission<C, O>>
    where
        I: Serialize + ?Sized,
        C: DeserializeOwned,
        O: DeserializeOwned,
    {
        let (operation_id, admission) = self
            .admit_automatic_encoded(
                candidate_operation_id.into(),
                EncodedPayload::encode(input)?,
            )
            .await?;
        let admission = admission.decode()?;
        Ok(AutomaticAdmission {
            operation_id,
            admission,
        })
    }

    async fn admit_encoded(
        &self,
        operation_id: String,
        input: EncodedPayload,
    ) -> Result<StoredAdmission> {
        let (result, receiver) = oneshot::channel();
        self.send(Command::Admit {
            operation_id,
            input,
            result,
        })
        .await?;
        receive(receiver).await
    }

    async fn admit_automatic_encoded(
        &self,
        candidate_operation_id: String,
        input: EncodedPayload,
    ) -> Result<(String, StoredAdmission)> {
        let (result, receiver) = oneshot::channel();
        self.send(Command::AdmitAutomatic {
            candidate_operation_id,
            input,
            result,
        })
        .await?;
        receive(receiver).await
    }

    /// Releases a live claim without changing durable journal state.
    pub async fn release(&self, operation_id: impl Into<String>) -> Result<()> {
        self.send(Command::Release {
            operation_id: operation_id.into(),
        })
        .await
    }

    /// Records that an accepted operation is beginning another attempt.
    pub async fn begin_attempt(&self, operation_id: impl Into<String>) -> Result<u32> {
        let (result, receiver) = oneshot::channel();
        self.send(Command::BeginAttempt {
            operation_id: operation_id.into(),
            result,
        })
        .await?;
        receive(receiver).await
    }

    /// Begins or replays one stable step, retaining replay output in its
    /// encoded journal form.
    pub async fn begin_step<I>(
        &self,
        operation_id: impl Into<String>,
        step_id: impl Into<String>,
        kind: impl Into<String>,
        input: &I,
        retry: RetryPolicy,
    ) -> Result<BeginStep>
    where
        I: Serialize + ?Sized,
    {
        match self
            .begin_step_encoded(
                operation_id.into(),
                step_id.into(),
                kind.into(),
                EncodedPayload::encode(input)?,
                retry,
            )
            .await?
        {
            StoredBeginStep::Execute => Ok(BeginStep::Execute),
            StoredBeginStep::Replay(output) => Ok(BeginStep::Replay(output)),
        }
    }

    /// Begins or replays one stable step with a typed replay output.
    pub async fn begin_step_typed<I, O>(
        &self,
        operation_id: impl Into<String>,
        step_id: impl Into<String>,
        kind: impl Into<String>,
        input: &I,
        retry: RetryPolicy,
    ) -> Result<BeginStep<O>>
    where
        I: Serialize + ?Sized,
        O: DeserializeOwned,
    {
        match self
            .begin_step_encoded(
                operation_id.into(),
                step_id.into(),
                kind.into(),
                EncodedPayload::encode(input)?,
                retry,
            )
            .await?
        {
            StoredBeginStep::Execute => Ok(BeginStep::Execute),
            StoredBeginStep::Replay(output) => Ok(BeginStep::Replay(output.decode()?)),
        }
    }

    async fn begin_step_encoded(
        &self,
        operation_id: String,
        step_id: String,
        kind: String,
        input: EncodedPayload,
        retry: RetryPolicy,
    ) -> Result<StoredBeginStep> {
        let (result, receiver) = oneshot::channel();
        self.send(Command::BeginStep {
            operation_id,
            step_id,
            kind,
            input,
            retry,
            result,
        })
        .await?;
        receive(receiver).await
    }

    /// Commits a step output for future replay.
    pub async fn complete_step<T: Serialize + ?Sized>(
        &self,
        operation_id: impl Into<String>,
        step_id: impl Into<String>,
        output: &T,
    ) -> Result<()> {
        let (result, receiver) = oneshot::channel();
        self.send(Command::CompleteStep {
            operation_id: operation_id.into(),
            step_id: step_id.into(),
            output: EncodedPayload::encode(output)?,
            result,
        })
        .await?;
        receive(receiver).await
    }

    /// Atomically terminalizes an operation with its checkpoint and result.
    pub async fn complete<C: Serialize + ?Sized, O: Serialize + ?Sized>(
        &self,
        operation_id: impl Into<String>,
        checkpoint: &C,
        output: &O,
    ) -> Result<()> {
        let (result, receiver) = oneshot::channel();
        self.send(Command::Complete {
            operation_id: operation_id.into(),
            checkpoint: EncodedPayload::encode(checkpoint)?,
            output: EncodedPayload::encode(output)?,
            result,
        })
        .await?;
        receive(receiver).await
    }

    /// Records a failed attempt while leaving the operation retryable.
    pub async fn fail_attempt(
        &self,
        operation_id: impl Into<String>,
        error: impl Into<String>,
    ) -> Result<()> {
        let (result, receiver) = oneshot::channel();
        self.send(Command::FailAttempt {
            operation_id: operation_id.into(),
            error: error.into(),
            result,
        })
        .await?;
        receive(receiver).await
    }

    /// Explicitly terminalizes an operation as cancelled.
    pub async fn cancel(&self, operation_id: impl Into<String>) -> Result<()> {
        let (result, receiver) = oneshot::channel();
        self.send(Command::Cancel {
            operation_id: operation_id.into(),
            result,
        })
        .await?;
        receive(receiver).await
    }

    async fn send(&self, command: Command) -> Result<()> {
        self.commands
            .send(command)
            .await
            .map_err(|_| Error::DriverStopped)
    }
}

async fn receive<T>(receiver: oneshot::Receiver<Result<T>>) -> Result<T> {
    receiver.await.map_err(|_| Error::DriverStopped)?
}

#[cfg(not(target_family = "wasm"))]
fn spawn_driver(driver: Driver) -> Result<()> {
    let runtime = tokio::runtime::Handle::try_current().map_err(|_| Error::RuntimeUnavailable)?;
    drop(runtime.spawn(driver.run()));
    Ok(())
}

#[cfg(target_family = "wasm")]
fn spawn_driver(driver: Driver) -> Result<()> {
    wasm_bindgen_futures::spawn_local(driver.run());
    Ok(())
}
