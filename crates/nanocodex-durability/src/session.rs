use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicU8, AtomicUsize, Ordering},
    },
};

use serde::{Serialize, de::DeserializeOwned};
use tokio::sync::{mpsc, oneshot};

use crate::{
    EncodedPayload, Entry, Error, JournalState, JournalStore, OperationStatus, OwnerId, OwnerToken,
    Result, RetryPolicy, StepStatus, StoreError, StoredJournal, journal::RetainedCheckpoint,
};

const COMMAND_CAPACITY: usize = 64;
const RELEASE_BURST_LIMIT: usize = 32;
const COMPACTION_BATCH_THRESHOLD: usize = 64;

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
    /// The operation already failed after committing a safe checkpoint.
    Failed {
        /// Checkpoint committed with the failure.
        checkpoint: C,
        /// Previously retained failure detail.
        error: String,
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
    Failed {
        checkpoint: EncodedPayload,
        error: String,
    },
    Cancelled,
}

impl StoredAdmission {
    fn into_encoded(self) -> Admission {
        match self {
            Self::Accepted => Admission::Accepted,
            Self::Pending => Admission::Pending,
            Self::Completed { checkpoint, output } => Admission::Completed { checkpoint, output },
            Self::Failed { checkpoint, error } => Admission::Failed { checkpoint, error },
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
            Self::Failed { checkpoint, error } => Ok(Admission::Failed {
                checkpoint: checkpoint.decode()?,
                error,
            }),
            Self::Cancelled => Ok(Admission::Cancelled),
        }
    }
}

enum StoredBeginStep {
    Execute,
    Replay(EncodedPayload),
}

#[derive(Clone, Eq, PartialEq)]
enum Caller {
    Direct(OwnerId),
    Agent(u64),
}

struct AgentAcquisition {
    generation: u64,
    checkpoint: Option<EncodedPayload>,
}

enum Command {
    State {
        result: oneshot::Sender<JournalState>,
    },
    LatestCheckpoint {
        result: oneshot::Sender<Option<EncodedPayload>>,
    },
    AcquireAgent {
        result: oneshot::Sender<Result<AgentAcquisition>>,
    },
    Admit {
        caller: Caller,
        operation_id: String,
        input: EncodedPayload,
        acknowledged: oneshot::Receiver<()>,
        release_commands: mpsc::Sender<Self>,
        result: oneshot::Sender<Result<StoredAdmission>>,
    },
    AdmitAutomatic {
        caller: Caller,
        candidate_operation_id: String,
        input: EncodedPayload,
        acknowledged: oneshot::Receiver<()>,
        release_commands: mpsc::Sender<Self>,
        result: oneshot::Sender<Result<(String, StoredAdmission)>>,
    },
    Release {
        caller: Caller,
        operation_id: String,
        result: oneshot::Sender<Result<()>>,
    },
    BeginAttempt {
        caller: Caller,
        operation_id: String,
        result: oneshot::Sender<Result<u32>>,
    },
    BeginStep {
        caller: Caller,
        operation_id: String,
        step_id: String,
        kind: String,
        input: EncodedPayload,
        retry: RetryPolicy,
        result: oneshot::Sender<Result<StoredBeginStep>>,
    },
    CompleteStep {
        caller: Caller,
        operation_id: String,
        step_id: String,
        output: EncodedPayload,
        result: oneshot::Sender<Result<()>>,
    },
    Complete {
        caller: Caller,
        operation_id: String,
        checkpoint: EncodedPayload,
        output: EncodedPayload,
        result: oneshot::Sender<Result<()>>,
    },
    Fail {
        caller: Caller,
        operation_id: String,
        checkpoint: EncodedPayload,
        error: String,
        result: oneshot::Sender<Result<()>>,
    },
    FailAttempt {
        caller: Caller,
        operation_id: String,
        error: String,
        result: oneshot::Sender<Result<()>>,
    },
    Cancel {
        caller: Caller,
        operation_id: String,
        checkpoint: Option<EncodedPayload>,
        result: oneshot::Sender<Result<()>>,
    },
    CommitCheckpoint {
        caller: Caller,
        checkpoint: EncodedPayload,
        result: oneshot::Sender<Result<()>>,
    },
    AuthorizeModelEffect {
        caller: Caller,
        kind: String,
        result: oneshot::Sender<Result<()>>,
    },
}

struct Driver {
    store: Box<dyn JournalStore>,
    journal_id: Arc<str>,
    state: JournalState,
    retained_batches: usize,
    terminal_receipt_limit: Option<usize>,
    owner: OwnerToken,
    next_agent_generation: u64,
    active_agent_generation: Option<u64>,
    claimed: HashMap<String, Caller>,
    exact_retries: HashMap<String, Entry>,
    poisoned: bool,
    commands: mpsc::Receiver<Command>,
    releases: mpsc::UnboundedReceiver<ReleaseSignal>,
}

const OWNER_ACTIVE: u8 = 0;
const OWNER_RELEASING: u8 = 1;
const OWNER_RELEASED: u8 = 2;

struct OwnerReleaseState {
    state: AtomicU8,
    completed: tokio::sync::watch::Sender<bool>,
}

impl OwnerReleaseState {
    fn new() -> Self {
        let (completed, _) = tokio::sync::watch::channel(false);
        Self {
            state: AtomicU8::new(OWNER_ACTIVE),
            completed,
        }
    }

    fn finish(&self) {
        self.state.store(OWNER_RELEASED, Ordering::Release);
        self.completed.send_replace(true);
    }
}

struct AgentRelease {
    generation: u64,
    state: Arc<OwnerReleaseState>,
}

enum ReleaseSignal {
    Agent(AgentRelease),
    Direct(OwnerId),
}

impl Driver {
    async fn run(mut self) {
        loop {
            for _ in 0..RELEASE_BURST_LIMIT {
                let Ok(release) = self.releases.try_recv() else {
                    break;
                };
                self.handle_release(release);
            }
            let command = tokio::select! {
                biased;
                command = self.commands.recv() => command,
                Some(release) = self.releases.recv() => {
                    self.handle_release(release);
                    continue;
                }
            };
            let Some(command) = command else {
                break;
            };
            // A release may arrive after the pre-select drain but before a
            // simultaneously ready command wins the biased selection. Drain a
            // bounded second burst so a just-dropped claimant is reclaimed
            // before an exact-ID admission, without letting sustained release
            // traffic starve the command itself.
            for _ in 0..RELEASE_BURST_LIMIT {
                let Ok(release) = self.releases.try_recv() else {
                    break;
                };
                self.handle_release(release);
            }
            match command {
                Command::State { result } => drop(result.send(self.state.clone())),
                Command::LatestCheckpoint { result } => {
                    drop(result.send(self.state.latest_checkpoint().cloned()));
                }
                Command::AcquireAgent { result } => {
                    let outcome = self.acquire_agent().await;
                    let generation = outcome.as_ref().ok().map(|owner| owner.generation);
                    if result.send(outcome).is_err()
                        && let Some(generation) = generation
                        && self.active_agent_generation == Some(generation)
                    {
                        self.active_agent_generation = None;
                        self.claimed.clear();
                    }
                }
                Command::Admit {
                    caller,
                    operation_id,
                    input,
                    acknowledged,
                    release_commands,
                    result,
                } => {
                    let admitted_id = operation_id.clone();
                    let outcome = match self.authorize(&caller) {
                        Ok(()) => self.admit(&caller, operation_id, input).await,
                        Err(error) => Err(error),
                    };
                    let claimed = matches!(
                        &outcome,
                        Ok(StoredAdmission::Accepted | StoredAdmission::Pending)
                    );
                    if result.send(outcome).is_err() {
                        self.release_claim_if_owned(&caller, &admitted_id);
                    } else if claimed {
                        spawn_claim_ack(release_commands, acknowledged, caller, admitted_id);
                    }
                }
                Command::AdmitAutomatic {
                    caller,
                    candidate_operation_id,
                    input,
                    acknowledged,
                    release_commands,
                    result,
                } => {
                    let outcome = match self.authorize(&caller) {
                        Ok(()) => {
                            self.admit_automatic(&caller, candidate_operation_id, input)
                                .await
                        }
                        Err(error) => Err(error),
                    };
                    let claimed_id = match &outcome {
                        Ok((
                            operation_id,
                            StoredAdmission::Accepted | StoredAdmission::Pending,
                        )) => Some(operation_id.clone()),
                        _ => None,
                    };
                    if let Err(Ok((operation_id, _))) = result.send(outcome) {
                        self.release_claim_if_owned(&caller, &operation_id);
                    } else if let Some(operation_id) = claimed_id {
                        spawn_claim_ack(release_commands, acknowledged, caller, operation_id);
                    }
                }
                Command::Release {
                    caller,
                    operation_id,
                    result,
                } => {
                    let outcome = self
                        .authorize(&caller)
                        .and_then(|()| self.release_claim(&caller, &operation_id));
                    drop(result.send(outcome));
                }
                Command::BeginAttempt {
                    caller,
                    operation_id,
                    result,
                } => {
                    let outcome = match self.authorize(&caller) {
                        Ok(()) => self.begin_attempt(&caller, operation_id).await,
                        Err(error) => Err(error),
                    };
                    drop(result.send(outcome));
                }
                Command::BeginStep {
                    caller,
                    operation_id,
                    step_id,
                    kind,
                    input,
                    retry,
                    result,
                } => {
                    let outcome = match self.authorize(&caller) {
                        Ok(()) => {
                            self.begin_step(&caller, operation_id, step_id, kind, input, retry)
                                .await
                        }
                        Err(error) => Err(error),
                    };
                    drop(result.send(outcome));
                }
                Command::CompleteStep {
                    caller,
                    operation_id,
                    step_id,
                    output,
                    result,
                } => {
                    let outcome = match self.authorize(&caller) {
                        Ok(()) => {
                            self.complete_step(&caller, operation_id, step_id, output)
                                .await
                        }
                        Err(error) => Err(error),
                    };
                    drop(result.send(outcome));
                }
                Command::Complete {
                    caller,
                    operation_id,
                    checkpoint,
                    output,
                    result,
                } => {
                    let outcome = match self.authorize(&caller) {
                        Ok(()) => {
                            self.complete(&caller, operation_id, checkpoint, output)
                                .await
                        }
                        Err(error) => Err(error),
                    };
                    drop(result.send(outcome));
                }
                Command::Fail {
                    caller,
                    operation_id,
                    checkpoint,
                    error,
                    result,
                } => {
                    let outcome = match self.authorize(&caller) {
                        Ok(()) => self.fail(&caller, operation_id, checkpoint, error).await,
                        Err(error) => Err(error),
                    };
                    drop(result.send(outcome));
                }
                Command::FailAttempt {
                    caller,
                    operation_id,
                    error,
                    result,
                } => {
                    let outcome = match self.authorize(&caller) {
                        Ok(()) => {
                            let outcome = match self.require_claimed(&caller, &operation_id) {
                                Ok(()) => {
                                    let entry = Entry::AttemptFailed {
                                        operation_id: operation_id.clone(),
                                        error,
                                    };
                                    match self.require_active_attempt(&operation_id).and_then(
                                        |()| self.require_exact_retry(&operation_id, &entry),
                                    ) {
                                        Ok(()) => {
                                            let outcome = self.append(entry.clone()).await;
                                            self.track_terminal_attempt(
                                                &operation_id,
                                                entry,
                                                &outcome,
                                            );
                                            outcome
                                        }
                                        Err(error) => Err(error),
                                    }
                                }
                                Err(error) => Err(error),
                            };
                            if finishing_attempt_releases_claim(&outcome) {
                                self.release_claim_if_owned(&caller, &operation_id);
                            }
                            outcome
                        }
                        Err(error) => Err(error),
                    };
                    drop(result.send(outcome));
                }
                Command::Cancel {
                    caller,
                    operation_id,
                    checkpoint,
                    result,
                } => {
                    let outcome = match self.authorize(&caller) {
                        Ok(()) => {
                            let outcome = match self.require_claimed(&caller, &operation_id) {
                                Ok(()) => {
                                    let proposed = Entry::OperationCancelled {
                                        operation_id: operation_id.clone(),
                                        checkpoint,
                                    };
                                    match self.terminal_retry_entry(&operation_id, proposed) {
                                        Ok(entry) => {
                                            let outcome = self.append_terminal(entry.clone()).await;
                                            self.track_terminal_attempt(
                                                &operation_id,
                                                entry,
                                                &outcome,
                                            );
                                            outcome
                                        }
                                        Err(error) => Err(error),
                                    }
                                }
                                Err(error) => Err(error),
                            };
                            if finishing_attempt_releases_claim(&outcome) {
                                self.release_claim_if_owned(&caller, &operation_id);
                            }
                            outcome
                        }
                        Err(error) => Err(error),
                    };
                    drop(result.send(outcome));
                }
                Command::CommitCheckpoint {
                    caller,
                    checkpoint,
                    result,
                } => {
                    let outcome = match self.authorize(&caller) {
                        Ok(()) => match self.state.first_pending_operation() {
                            Some((pending_id, _)) => Err(Error::OperationBlocked {
                                operation_id: "standalone-checkpoint".to_owned(),
                                pending_id: pending_id.to_owned(),
                            }),
                            None => {
                                self.append_terminal(Entry::CheckpointCommitted { checkpoint })
                                    .await
                            }
                        },
                        Err(error) => Err(error),
                    };
                    drop(result.send(outcome));
                }
                Command::AuthorizeModelEffect {
                    caller,
                    kind,
                    result,
                } => {
                    let outcome = match self.authorize(&caller) {
                        Ok(()) if kind == "compaction" => {
                            match self.state.first_pending_operation() {
                                Some((pending_id, _)) => Err(Error::OperationBlocked {
                                    operation_id: "standalone-compaction".to_owned(),
                                    pending_id: pending_id.to_owned(),
                                }),
                                None => self.append(Entry::ModelEffectStarted { kind }).await,
                            }
                        }
                        Ok(()) => self.append(Entry::ModelEffectStarted { kind }).await,
                        Err(error) => Err(error),
                    };
                    drop(result.send(outcome));
                }
            }
            if self.poisoned {
                break;
            }
        }
    }

    fn handle_release(&mut self, release: ReleaseSignal) {
        match release {
            ReleaseSignal::Agent(release) => {
                if self.active_agent_generation == Some(release.generation) {
                    self.active_agent_generation = None;
                    self.claimed.clear();
                }
                release.state.finish();
            }
            ReleaseSignal::Direct(caller_id) => {
                self.claimed
                    .retain(|_, caller| caller != &Caller::Direct(caller_id.clone()));
            }
        }
    }

    const fn authorize(&self, caller: &Caller) -> Result<()> {
        match (caller, self.active_agent_generation) {
            (Caller::Direct(_), None) => Ok(()),
            (Caller::Agent(generation), Some(active)) if *generation == active => Ok(()),
            (Caller::Direct(_), Some(_)) => Err(Error::ModelOwnerActive),
            (Caller::Agent(_), _) => Err(Error::ModelOwnerFenced),
        }
    }

    async fn acquire_agent(&mut self) -> Result<AgentAcquisition> {
        let acquired = match self
            .store
            .acquire_owner(&self.journal_id, OwnerId::new())
            .await
        {
            Ok(acquired) => acquired,
            Err(error @ StoreError::NotCommitted(_)) => return Err(error.into()),
            Err(error) => {
                self.poisoned = true;
                return Err(error.into());
            }
        };
        let state = match reduce(acquired.journal) {
            Ok(state) => state,
            Err(error) => {
                self.poisoned = true;
                return Err(error);
            }
        };
        let generation = match self.next_agent_generation.checked_add(1) {
            Some(generation) => generation,
            None => {
                self.poisoned = true;
                return Err(Error::InvalidJournal(
                    "model-owner generation exceeded the u64 range".to_owned(),
                ));
            }
        };
        self.owner = acquired.owner;
        self.state = state;
        self.claimed.clear();
        self.exact_retries.clear();
        self.next_agent_generation = generation;
        self.active_agent_generation = Some(generation);
        Ok(AgentAcquisition {
            generation,
            checkpoint: self.state.latest_checkpoint().cloned(),
        })
    }

    async fn admit(
        &mut self,
        caller: &Caller,
        operation_id: String,
        input: EncodedPayload,
    ) -> Result<StoredAdmission> {
        if let Some(operation) = self.state.operation(&operation_id) {
            if operation.input != input {
                return Err(Error::OperationConflict { operation_id });
            }
            if self.claimed.contains_key(&operation_id) {
                return Err(Error::OperationActive { operation_id });
            }
            if matches!(caller, Caller::Agent(_))
                && let Some(entry @ Entry::AttemptFailed { .. }) =
                    self.exact_retries.get(&operation_id).cloned()
            {
                self.append(entry).await?;
                self.exact_retries.remove(&operation_id);
            }
            let operation = self.state.operation(&operation_id).ok_or_else(|| {
                Error::InvalidJournal(format!("operation `{operation_id}` disappeared"))
            })?;
            if matches!(operation.status, OperationStatus::Pending)
                && operation.active_attempt
                && !self.exact_retries.contains_key(&operation_id)
            {
                self.append(Entry::AttemptReleased {
                    operation_id: operation_id.clone(),
                })
                .await?;
            }
            let operation = self.state.operation(&operation_id).ok_or_else(|| {
                Error::InvalidJournal(format!("operation `{operation_id}` disappeared"))
            })?;
            return match &operation.status {
                OperationStatus::Pending => {
                    self.claimed.insert(operation_id.clone(), caller.clone());
                    Ok(StoredAdmission::Pending)
                }
                OperationStatus::Completed { checkpoint, output } => {
                    Ok(StoredAdmission::Completed {
                        checkpoint: checkpoint.clone(),
                        output: output.clone(),
                    })
                }
                OperationStatus::Failed { checkpoint, error } => Ok(StoredAdmission::Failed {
                    checkpoint: checkpoint.clone(),
                    error: error.clone(),
                }),
                OperationStatus::Cancelled { .. } => Ok(StoredAdmission::Cancelled),
            };
        }
        self.append(Entry::OperationAccepted {
            operation_id: operation_id.clone(),
            input,
        })
        .await?;
        self.claimed.insert(operation_id, caller.clone());
        Ok(StoredAdmission::Accepted)
    }

    async fn admit_automatic(
        &mut self,
        caller: &Caller,
        candidate_operation_id: String,
        input: EncodedPayload,
    ) -> Result<(String, StoredAdmission)> {
        if let Some((pending_id, operation)) = self
            .state
            .pending_operations()
            .into_iter()
            .find(|(pending_id, _)| !self.claimed.contains_key(*pending_id))
        {
            if operation.input != input {
                return Err(Error::OperationBlocked {
                    operation_id: candidate_operation_id,
                    pending_id: pending_id.to_owned(),
                });
            }
            let recovered_operation_id = pending_id.to_owned();
            let admission = self
                .admit(caller, recovered_operation_id.clone(), input)
                .await?;
            return Ok((recovered_operation_id, admission));
        }

        let admission = self
            .admit(caller, candidate_operation_id.clone(), input)
            .await?;
        Ok((candidate_operation_id, admission))
    }

    async fn begin_attempt(&mut self, caller: &Caller, operation_id: String) -> Result<u32> {
        self.require_claimed(caller, &operation_id)?;
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
        if self.exact_retries.contains_key(&operation_id) {
            if !operation.active_attempt {
                return Err(Error::AttemptNotStarted { operation_id });
            }
            return Ok(operation.attempts);
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
        caller: &Caller,
        operation_id: String,
        step_id: String,
        kind: String,
        input: EncodedPayload,
        retry: RetryPolicy,
    ) -> Result<StoredBeginStep> {
        self.require_claimed(caller, &operation_id)?;
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
        if !operation.active_attempt {
            return Err(Error::AttemptNotStarted { operation_id });
        }
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
        let entry = Entry::StepStarted {
            operation_id: operation_id.clone(),
            step_id,
            kind,
            input,
            retry,
        };
        self.require_exact_retry(&operation_id, &entry)?;
        self.append(entry).await?;
        Ok(StoredBeginStep::Execute)
    }

    async fn complete_step(
        &mut self,
        caller: &Caller,
        operation_id: String,
        step_id: String,
        output: EncodedPayload,
    ) -> Result<()> {
        self.require_claimed(caller, &operation_id)?;
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
        self.require_active_attempt(&operation_id)?;
        let entry = Entry::StepCompleted {
            operation_id: operation_id.clone(),
            step_id,
            output,
        };
        self.require_exact_retry(&operation_id, &entry)?;
        self.append(entry).await
    }

    async fn complete(
        &mut self,
        caller: &Caller,
        operation_id: String,
        checkpoint: EncodedPayload,
        output: EncodedPayload,
    ) -> Result<()> {
        self.require_claimed(caller, &operation_id)?;
        self.require_active_attempt(&operation_id)?;
        let proposed = Entry::OperationCompleted {
            operation_id: operation_id.clone(),
            checkpoint,
            output,
        };
        let entry = self.terminal_retry_entry(&operation_id, proposed)?;
        let outcome = self.append_terminal(entry.clone()).await;
        self.track_terminal_attempt(&operation_id, entry, &outcome);
        if finishing_attempt_releases_claim(&outcome) {
            self.release_claim_if_owned(caller, &operation_id);
        }
        outcome
    }

    async fn fail(
        &mut self,
        caller: &Caller,
        operation_id: String,
        checkpoint: EncodedPayload,
        error: String,
    ) -> Result<()> {
        self.require_claimed(caller, &operation_id)?;
        self.require_active_attempt(&operation_id)?;
        let proposed = Entry::OperationFailed {
            operation_id: operation_id.clone(),
            checkpoint,
            error,
        };
        let entry = self.terminal_retry_entry(&operation_id, proposed)?;
        let outcome = self.append_terminal(entry.clone()).await;
        self.track_terminal_attempt(&operation_id, entry, &outcome);
        if finishing_attempt_releases_claim(&outcome) {
            self.release_claim_if_owned(caller, &operation_id);
        }
        outcome
    }

    fn require_claimed(&self, caller: &Caller, operation_id: &str) -> Result<()> {
        if self.claimed.get(operation_id) == Some(caller) {
            Ok(())
        } else {
            Err(Error::OperationNotClaimed {
                operation_id: operation_id.to_owned(),
            })
        }
    }

    fn require_exact_retry(&self, operation_id: &str, entry: &Entry) -> Result<()> {
        if let Some(expected) = self.exact_retries.get(operation_id)
            && expected != entry
        {
            return Err(Error::InvalidJournal(format!(
                "operation `{operation_id}` must retry its definitely uncommitted mutation exactly"
            )));
        }
        Ok(())
    }

    fn terminal_retry_entry(&self, operation_id: &str, proposed: Entry) -> Result<Entry> {
        let Some(expected) = self.exact_retries.get(operation_id) else {
            return Ok(proposed);
        };
        let compatible = match (expected, &proposed) {
            (
                Entry::OperationCompleted {
                    output: expected, ..
                },
                Entry::OperationCompleted {
                    output: proposed, ..
                },
            ) => expected == proposed,
            (
                Entry::OperationFailed {
                    error: expected, ..
                },
                Entry::OperationFailed {
                    error: proposed, ..
                },
            ) => expected == proposed,
            (Entry::OperationCancelled { .. }, Entry::OperationCancelled { .. }) => true,
            _ => false,
        };
        if compatible {
            Ok(expected.clone())
        } else {
            Err(Error::InvalidJournal(format!(
                "operation `{operation_id}` must retry its definitely uncommitted terminal mutation exactly"
            )))
        }
    }

    fn require_active_attempt(&self, operation_id: &str) -> Result<()> {
        let operation = self.state.operation(operation_id).ok_or_else(|| {
            Error::InvalidJournal(format!("operation `{operation_id}` was not accepted"))
        })?;
        if operation.status.is_terminal() {
            return Err(Error::OperationTerminal {
                operation_id: operation_id.to_owned(),
            });
        }
        if !operation.active_attempt {
            return Err(Error::AttemptNotStarted {
                operation_id: operation_id.to_owned(),
            });
        }
        Ok(())
    }

    fn track_terminal_attempt(&mut self, operation_id: &str, entry: Entry, outcome: &Result<()>) {
        match outcome {
            Err(Error::Store(StoreError::NotCommitted(_))) => {
                self.exact_retries.insert(operation_id.to_owned(), entry);
            }
            Ok(()) => {
                self.exact_retries.remove(operation_id);
            }
            Err(_) => {}
        }
    }

    fn release_claim(&mut self, caller: &Caller, operation_id: &str) -> Result<()> {
        self.require_claimed(caller, operation_id)?;
        self.claimed.remove(operation_id);
        Ok(())
    }

    fn release_claim_if_owned(&mut self, caller: &Caller, operation_id: &str) {
        if self.claimed.get(operation_id) == Some(caller) {
            self.claimed.remove(operation_id);
        }
    }

    async fn append(&mut self, entry: Entry) -> Result<()> {
        let expected_revision = self.state.revision().checked_add(1).ok_or_else(|| {
            Error::InvalidJournal("journal revision exceeded the u64 range".to_owned())
        })?;
        self.state.validate_batch(expected_revision, &entry)?;
        let payload = serde_json::to_string(&entry)?;
        let revision = match self
            .store
            .append(
                &self.journal_id,
                &self.owner,
                self.state.revision(),
                &payload,
            )
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
        self.retained_batches = self.retained_batches.saturating_add(1);
        Ok(())
    }

    async fn append_terminal(&mut self, entry: Entry) -> Result<()> {
        self.append(entry).await?;
        if self.retained_batches < COMPACTION_BATCH_THRESHOLD {
            return Ok(());
        }
        let revision = self.state.revision();
        let payload = self.state.checkpoint_payload(self.terminal_receipt_limit)?;
        match self
            .store
            .compact(&self.journal_id, &self.owner, revision, &payload)
            .await
        {
            Ok(compacted_revision) if compacted_revision == revision => {
                if let Some(limit) = self.terminal_receipt_limit {
                    self.state.retain_terminal_receipts(limit);
                }
                self.retained_batches = 1;
                Ok(())
            }
            Ok(compacted_revision) => {
                self.poisoned = true;
                Err(Error::InvalidJournal(format!(
                    "store compacted revision {compacted_revision} while retaining revision {revision}"
                )))
            }
            Err(StoreError::NotCommitted(_)) => Ok(()),
            Err(error) => {
                self.poisoned = true;
                Err(error.into())
            }
        }
    }
}

const fn finishing_attempt_releases_claim(outcome: &Result<()>) -> bool {
    matches!(
        outcome,
        Ok(()) | Err(Error::Store(StoreError::NotCommitted(_)))
    )
}

fn reduce(stored: StoredJournal) -> Result<JournalState> {
    let mut state = JournalState::default();
    for batch in stored.batches {
        match serde_json::from_str::<RetainedCheckpoint>(&batch.payload) {
            Ok(RetainedCheckpoint {
                nanocodex_journal_state,
            }) if state.revision() == 0 => {
                state = JournalState::from_checkpoint(batch.revision, nanocodex_journal_state)?;
            }
            Ok(_) => {
                return Err(Error::InvalidJournal(
                    "a compacted journal checkpoint must be the first retained batch".to_owned(),
                ));
            }
            Err(_) => {
                let entry = serde_json::from_str::<Entry>(&batch.payload).map_err(|source| {
                    Error::Decode {
                        revision: batch.revision,
                        source,
                    }
                })?;
                state.apply_replayed_batch(batch.revision, &entry)?;
            }
        }
    }
    if state.revision() != stored.revision {
        return Err(Error::InvalidJournal(format!(
            "store reported revision {}, but batches reduce to {}",
            stored.revision,
            state.revision()
        )));
    }
    Ok(state)
}

/// Cheap command handle for an owned durable-journal driver.
///
/// The spawned driver is the sole owner of the reduced journal state and all
/// live operation claims. Clones only enqueue commands and await typed replies.
pub struct DurableSession {
    journal_id: Arc<str>,
    commands: mpsc::Sender<Command>,
    releases: mpsc::UnboundedSender<ReleaseSignal>,
    caller_id: OwnerId,
    active_claims: AtomicUsize,
}

impl Clone for DurableSession {
    fn clone(&self) -> Self {
        Self {
            journal_id: Arc::clone(&self.journal_id),
            commands: self.commands.clone(),
            releases: self.releases.clone(),
            caller_id: OwnerId::new(),
            active_claims: AtomicUsize::new(0),
        }
    }
}

impl Drop for DurableSession {
    fn drop(&mut self) {
        if self.active_claims.load(Ordering::Acquire) > 0 {
            let _ = self
                .releases
                .send(ReleaseSignal::Direct(self.caller_id.clone()));
        }
    }
}

impl DurableSession {
    /// Loads and validates a durable session, then spawns its owning driver.
    pub async fn open<S>(store: S, journal_id: impl Into<String>) -> Result<Self>
    where
        S: JournalStore + 'static,
    {
        Self::open_inner(store, journal_id.into(), None).await
    }

    /// Loads a durable session whose compacted checkpoint retains at most the
    /// newest `limit` terminal replay receipts.
    ///
    /// The embedding application must preserve older exact-ID results before
    /// selecting this policy. Unresolved operations and the latest resumable
    /// model checkpoint are always retained.
    pub async fn open_with_terminal_receipt_limit<S>(
        store: S,
        journal_id: impl Into<String>,
        limit: usize,
    ) -> Result<Self>
    where
        S: JournalStore + 'static,
    {
        if limit == 0 {
            return Err(Error::InvalidJournal(
                "terminal receipt retention limit must be positive".to_owned(),
            ));
        }
        Self::open_inner(store, journal_id.into(), Some(limit)).await
    }

    async fn open_inner<S>(
        mut store: S,
        journal_id: String,
        terminal_receipt_limit: Option<usize>,
    ) -> Result<Self>
    where
        S: JournalStore + 'static,
    {
        if journal_id.trim().is_empty() {
            return Err(Error::InvalidJournal(
                "journal identity must not be empty".to_owned(),
            ));
        }
        let acquired = store.acquire_owner(&journal_id, OwnerId::new()).await?;
        let retained_batches = acquired.journal.batches.len();
        let state = reduce(acquired.journal)?;
        let journal_id = Arc::<str>::from(journal_id);
        let (commands, receiver) = mpsc::channel(COMMAND_CAPACITY);
        let (releases, release_receiver) = mpsc::unbounded_channel();
        spawn_driver(Driver {
            store: Box::new(store),
            journal_id: Arc::clone(&journal_id),
            state,
            retained_batches,
            terminal_receipt_limit,
            owner: acquired.owner,
            next_agent_generation: 0,
            active_agent_generation: None,
            claimed: HashMap::new(),
            exact_retries: HashMap::new(),
            poisoned: false,
            commands: receiver,
            releases: release_receiver,
        })?;
        Ok(Self {
            journal_id,
            commands,
            releases,
            caller_id: OwnerId::new(),
            active_claims: AtomicUsize::new(0),
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

    /// Copies the latest terminal checkpoint from the owning driver without
    /// cloning the rest of the reduced journal.
    pub async fn latest_checkpoint(&self) -> Result<Option<EncodedPayload>> {
        let (result, receiver) = oneshot::channel();
        self.send(Command::LatestCheckpoint { result }).await?;
        receiver.await.map_err(|_| Error::DriverStopped)
    }

    pub(crate) async fn acquire_agent(&self) -> Result<(DurableOwner, Option<EncodedPayload>)> {
        let (result, receiver) = oneshot::channel();
        self.send(Command::AcquireAgent { result }).await?;
        let acquired = receive(receiver).await?;
        let owner = DurableOwner {
            generation: acquired.generation,
            commands: self.commands.clone(),
            releases: self.releases.clone(),
            release: Arc::new(OwnerReleaseState::new()),
        };
        Ok((owner, acquired.checkpoint))
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
        let (acknowledge, acknowledged) = oneshot::channel();
        self.send(Command::Admit {
            caller: Caller::Direct(self.caller_id.clone()),
            operation_id,
            input,
            acknowledged,
            release_commands: self.commands.clone(),
            result,
        })
        .await?;
        let admission = receive(receiver).await?;
        if matches!(
            &admission,
            StoredAdmission::Accepted | StoredAdmission::Pending
        ) {
            self.active_claims.fetch_add(1, Ordering::AcqRel);
        }
        let _ = acknowledge.send(());
        Ok(admission)
    }

    async fn admit_automatic_encoded(
        &self,
        candidate_operation_id: String,
        input: EncodedPayload,
    ) -> Result<(String, StoredAdmission)> {
        let (result, receiver) = oneshot::channel();
        let (acknowledge, acknowledged) = oneshot::channel();
        self.send(Command::AdmitAutomatic {
            caller: Caller::Direct(self.caller_id.clone()),
            candidate_operation_id,
            input,
            acknowledged,
            release_commands: self.commands.clone(),
            result,
        })
        .await?;
        let admission = receive(receiver).await?;
        if matches!(
            &admission.1,
            StoredAdmission::Accepted | StoredAdmission::Pending
        ) {
            self.active_claims.fetch_add(1, Ordering::AcqRel);
        }
        let _ = acknowledge.send(());
        Ok(admission)
    }

    /// Releases a live claim without changing durable journal state.
    pub async fn release(&self, operation_id: impl Into<String>) -> Result<()> {
        let (result, receiver) = oneshot::channel();
        self.send(Command::Release {
            caller: Caller::Direct(self.caller_id.clone()),
            operation_id: operation_id.into(),
            result,
        })
        .await?;
        let outcome = receive(receiver).await;
        if outcome.is_ok() {
            self.release_one_claim();
        }
        outcome
    }

    /// Records that an accepted operation is beginning another attempt.
    pub async fn begin_attempt(&self, operation_id: impl Into<String>) -> Result<u32> {
        let (result, receiver) = oneshot::channel();
        self.send(Command::BeginAttempt {
            caller: Caller::Direct(self.caller_id.clone()),
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
            caller: Caller::Direct(self.caller_id.clone()),
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
            caller: Caller::Direct(self.caller_id.clone()),
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
            caller: Caller::Direct(self.caller_id.clone()),
            operation_id: operation_id.into(),
            checkpoint: EncodedPayload::encode(checkpoint)?,
            output: EncodedPayload::encode(output)?,
            result,
        })
        .await?;
        let outcome = receive(receiver).await;
        if finishing_attempt_releases_claim(&outcome) {
            self.release_one_claim();
        }
        outcome
    }

    /// Atomically terminalizes a failed operation with its safe checkpoint.
    pub async fn fail<C: Serialize + ?Sized>(
        &self,
        operation_id: impl Into<String>,
        checkpoint: &C,
        error: impl Into<String>,
    ) -> Result<()> {
        let (result, receiver) = oneshot::channel();
        self.send(Command::Fail {
            caller: Caller::Direct(self.caller_id.clone()),
            operation_id: operation_id.into(),
            checkpoint: EncodedPayload::encode(checkpoint)?,
            error: error.into(),
            result,
        })
        .await?;
        let outcome = receive(receiver).await;
        if finishing_attempt_releases_claim(&outcome) {
            self.release_one_claim();
        }
        outcome
    }

    /// Records a failed attempt while leaving the operation retryable.
    pub async fn fail_attempt(
        &self,
        operation_id: impl Into<String>,
        error: impl Into<String>,
    ) -> Result<()> {
        let (result, receiver) = oneshot::channel();
        self.send(Command::FailAttempt {
            caller: Caller::Direct(self.caller_id.clone()),
            operation_id: operation_id.into(),
            error: error.into(),
            result,
        })
        .await?;
        let outcome = receive(receiver).await;
        if finishing_attempt_releases_claim(&outcome) {
            self.release_one_claim();
        }
        outcome
    }

    /// Explicitly terminalizes an operation as cancelled.
    pub async fn cancel(&self, operation_id: impl Into<String>) -> Result<()> {
        let (result, receiver) = oneshot::channel();
        self.send(Command::Cancel {
            caller: Caller::Direct(self.caller_id.clone()),
            operation_id: operation_id.into(),
            checkpoint: None,
            result,
        })
        .await?;
        let outcome = receive(receiver).await;
        if finishing_attempt_releases_claim(&outcome) {
            self.release_one_claim();
        }
        outcome
    }

    async fn send(&self, command: Command) -> Result<()> {
        self.commands
            .send(command)
            .await
            .map_err(|_| Error::DriverStopped)
    }

    fn release_one_claim(&self) {
        let _ = self
            .active_claims
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |claims| {
                claims.checked_sub(1)
            });
    }
}

pub(crate) struct DurableOwner {
    generation: u64,
    commands: mpsc::Sender<Command>,
    releases: mpsc::UnboundedSender<ReleaseSignal>,
    release: Arc<OwnerReleaseState>,
}

impl DurableOwner {
    fn caller(&self) -> Result<Caller> {
        if self.release.state.load(Ordering::Acquire) != OWNER_ACTIVE {
            Err(Error::ModelOwnerFenced)
        } else {
            Ok(Caller::Agent(self.generation))
        }
    }

    async fn send(&self, command: Command) -> Result<()> {
        self.commands
            .send(command)
            .await
            .map_err(|_| Error::DriverStopped)
    }

    pub(crate) async fn admit_typed<I, C, O>(
        &self,
        operation_id: String,
        input: &I,
    ) -> Result<Admission<C, O>>
    where
        I: Serialize + ?Sized,
        C: DeserializeOwned,
        O: DeserializeOwned,
    {
        let (result, receiver) = oneshot::channel();
        let (acknowledge, acknowledged) = oneshot::channel();
        self.send(Command::Admit {
            caller: self.caller()?,
            operation_id,
            input: EncodedPayload::encode(input)?,
            acknowledged,
            release_commands: self.commands.clone(),
            result,
        })
        .await?;
        let admission = receive(receiver).await?;
        let _ = acknowledge.send(());
        admission.decode()
    }

    pub(crate) async fn admit_automatic_typed<I, C, O>(
        &self,
        candidate_operation_id: String,
        input: &I,
    ) -> Result<AutomaticAdmission<C, O>>
    where
        I: Serialize + ?Sized,
        C: DeserializeOwned,
        O: DeserializeOwned,
    {
        let (result, receiver) = oneshot::channel();
        let (acknowledge, acknowledged) = oneshot::channel();
        self.send(Command::AdmitAutomatic {
            caller: self.caller()?,
            candidate_operation_id,
            input: EncodedPayload::encode(input)?,
            acknowledged,
            release_commands: self.commands.clone(),
            result,
        })
        .await?;
        let (operation_id, admission) = receive(receiver).await?;
        let _ = acknowledge.send(());
        Ok(AutomaticAdmission {
            operation_id,
            admission: admission.decode()?,
        })
    }

    pub(crate) async fn release_claim(&self, operation_id: String) -> Result<()> {
        let (result, receiver) = oneshot::channel();
        self.send(Command::Release {
            caller: self.caller()?,
            operation_id,
            result,
        })
        .await?;
        receive(receiver).await
    }

    pub(crate) async fn begin_attempt(&self, operation_id: String) -> Result<u32> {
        let (result, receiver) = oneshot::channel();
        self.send(Command::BeginAttempt {
            caller: self.caller()?,
            operation_id,
            result,
        })
        .await?;
        receive(receiver).await
    }

    pub(crate) async fn begin_step<I>(
        &self,
        operation_id: String,
        step_id: String,
        kind: String,
        input: &I,
        retry: RetryPolicy,
    ) -> Result<BeginStep>
    where
        I: Serialize + ?Sized,
    {
        let (result, receiver) = oneshot::channel();
        self.send(Command::BeginStep {
            caller: self.caller()?,
            operation_id,
            step_id,
            kind,
            input: EncodedPayload::encode(input)?,
            retry,
            result,
        })
        .await?;
        match receive(receiver).await? {
            StoredBeginStep::Execute => Ok(BeginStep::Execute),
            StoredBeginStep::Replay(output) => Ok(BeginStep::Replay(output)),
        }
    }

    pub(crate) async fn complete_step<T: Serialize + ?Sized>(
        &self,
        operation_id: String,
        step_id: String,
        output: &T,
    ) -> Result<()> {
        let (result, receiver) = oneshot::channel();
        self.send(Command::CompleteStep {
            caller: self.caller()?,
            operation_id,
            step_id,
            output: EncodedPayload::encode(output)?,
            result,
        })
        .await?;
        receive(receiver).await
    }

    pub(crate) async fn complete<C: Serialize + ?Sized, O: Serialize + ?Sized>(
        &self,
        operation_id: String,
        checkpoint: &C,
        output: &O,
    ) -> Result<()> {
        let (result, receiver) = oneshot::channel();
        self.send(Command::Complete {
            caller: self.caller()?,
            operation_id,
            checkpoint: EncodedPayload::encode(checkpoint)?,
            output: EncodedPayload::encode(output)?,
            result,
        })
        .await?;
        receive(receiver).await
    }

    pub(crate) async fn fail<C: Serialize + ?Sized>(
        &self,
        operation_id: String,
        checkpoint: &C,
        error: String,
    ) -> Result<()> {
        let (result, receiver) = oneshot::channel();
        self.send(Command::Fail {
            caller: self.caller()?,
            operation_id,
            checkpoint: EncodedPayload::encode(checkpoint)?,
            error,
            result,
        })
        .await?;
        receive(receiver).await
    }

    pub(crate) async fn fail_attempt(&self, operation_id: String, error: String) -> Result<()> {
        let (result, receiver) = oneshot::channel();
        self.send(Command::FailAttempt {
            caller: self.caller()?,
            operation_id,
            error,
            result,
        })
        .await?;
        receive(receiver).await
    }

    pub(crate) async fn cancel<C: Serialize + ?Sized>(
        &self,
        operation_id: String,
        checkpoint: Option<&C>,
    ) -> Result<()> {
        let (result, receiver) = oneshot::channel();
        self.send(Command::Cancel {
            caller: self.caller()?,
            operation_id,
            checkpoint: checkpoint.map(EncodedPayload::encode).transpose()?,
            result,
        })
        .await?;
        receive(receiver).await
    }

    pub(crate) async fn commit_checkpoint<C: Serialize + ?Sized>(
        &self,
        checkpoint: &C,
    ) -> Result<()> {
        let (result, receiver) = oneshot::channel();
        self.send(Command::CommitCheckpoint {
            caller: self.caller()?,
            checkpoint: EncodedPayload::encode(checkpoint)?,
            result,
        })
        .await?;
        receive(receiver).await
    }

    pub(crate) async fn authorize_model_effect(&self, kind: &str) -> Result<()> {
        let (result, receiver) = oneshot::channel();
        self.send(Command::AuthorizeModelEffect {
            caller: self.caller()?,
            kind: kind.to_owned(),
            result,
        })
        .await?;
        receive(receiver).await
    }

    pub(crate) async fn shutdown(&self) -> Result<()> {
        match self.release.state.compare_exchange(
            OWNER_ACTIVE,
            OWNER_RELEASING,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(OWNER_ACTIVE) => {
                if self
                    .releases
                    .send(ReleaseSignal::Agent(AgentRelease {
                        generation: self.generation,
                        state: Arc::clone(&self.release),
                    }))
                    .is_err()
                {
                    self.release.finish();
                    return Err(Error::DriverStopped);
                }
            }
            Err(OWNER_RELEASED) => return Ok(()),
            Err(OWNER_RELEASING) => {}
            Ok(_) | Err(_) => {
                return Err(Error::InvalidJournal(
                    "durable owner entered an invalid release state".to_owned(),
                ));
            }
        }
        let mut completed = self.release.completed.subscribe();
        if *completed.borrow() {
            return Ok(());
        }
        tokio::select! {
            changed = completed.changed() => changed.map_err(|_| Error::DriverStopped),
            () = self.commands.closed() => {
                self.release.finish();
                Err(Error::DriverStopped)
            }
        }
    }
}

impl Drop for DurableOwner {
    fn drop(&mut self) {
        if self
            .release
            .state
            .compare_exchange(
                OWNER_ACTIVE,
                OWNER_RELEASING,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
        {
            let _ = self.releases.send(ReleaseSignal::Agent(AgentRelease {
                generation: self.generation,
                state: Arc::clone(&self.release),
            }));
        }
    }
}

async fn receive<T>(receiver: oneshot::Receiver<Result<T>>) -> Result<T> {
    receiver.await.map_err(|_| Error::DriverStopped)?
}

#[cfg(not(target_family = "wasm"))]
fn spawn_claim_ack(
    commands: mpsc::Sender<Command>,
    acknowledged: oneshot::Receiver<()>,
    caller: Caller,
    operation_id: String,
) {
    if let Ok(runtime) = tokio::runtime::Handle::try_current() {
        drop(runtime.spawn(async move {
            if acknowledged.await.is_err() {
                let (result, _receiver) = oneshot::channel();
                drop(
                    commands
                        .send(Command::Release {
                            caller,
                            operation_id,
                            result,
                        })
                        .await,
                );
            }
        }));
    }
}

#[cfg(target_family = "wasm")]
fn spawn_claim_ack(
    commands: mpsc::Sender<Command>,
    acknowledged: oneshot::Receiver<()>,
    caller: Caller,
    operation_id: String,
) {
    wasm_bindgen_futures::spawn_local(async move {
        if acknowledged.await.is_err() {
            let (result, _receiver) = oneshot::channel();
            drop(
                commands
                    .send(Command::Release {
                        caller,
                        operation_id,
                        result,
                    })
                    .await,
            );
        }
    });
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

#[cfg(test)]
mod tests {
    use std::{future::Future, task::Poll};

    use super::*;
    use crate::MemoryStore;

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn owner_drop_releases_without_a_runtime_or_bounded_command_capacity() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let (session, owner) = runtime.block_on(async {
            let store = MemoryStore::new().unwrap();
            let session = DurableSession::open(store, "drop-release-lane")
                .await
                .unwrap();
            let (owner, _) = session.acquire_agent().await.unwrap();
            (session, owner)
        });

        let mut abandoned_results = Vec::new();
        for _ in 0..COMMAND_CAPACITY {
            let (result, receiver) = oneshot::channel();
            session
                .commands
                .try_send(Command::State { result })
                .unwrap();
            abandoned_results.push(receiver);
        }
        drop(owner);

        runtime.block_on(async {
            let (successor, _) = session.acquire_agent().await.unwrap();
            successor.shutdown().await.unwrap();
        });
        drop(abandoned_results);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn cancelled_shutdown_keeps_the_drop_release_lane_armed() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let (session, owner) = runtime.block_on(async {
            let store = MemoryStore::new().unwrap();
            let session = DurableSession::open(store, "cancelled-shutdown-release")
                .await
                .unwrap();
            let (owner, _) = session.acquire_agent().await.unwrap();
            (session, owner)
        });

        let mut abandoned_results = Vec::new();
        for _ in 0..COMMAND_CAPACITY {
            let (result, receiver) = oneshot::channel();
            session
                .commands
                .try_send(Command::State { result })
                .unwrap();
            abandoned_results.push(receiver);
        }

        let mut shutdown = Box::pin(owner.shutdown());
        let waker = std::task::Waker::noop();
        let mut context = std::task::Context::from_waker(waker);
        assert!(matches!(
            shutdown.as_mut().poll(&mut context),
            Poll::Pending
        ));
        drop(shutdown);
        drop(owner);

        runtime.block_on(async {
            assert!(matches!(
                session
                    .admit("turn-after-cancelled-shutdown", &"prompt")
                    .await,
                Ok(Admission::Accepted)
            ));
        });
        drop(abandoned_results);
    }

    #[tokio::test]
    async fn stale_agent_capability_cannot_mutate_or_release_its_successor() {
        let store = MemoryStore::new().unwrap();
        let session = DurableSession::open(store, "local-owner-aba")
            .await
            .unwrap();
        let (older, _) = session.acquire_agent().await.unwrap();
        assert!(matches!(
            older
                .admit_typed::<_, u32, String>("turn-1".to_owned(), &"prompt")
                .await,
            Ok(Admission::Accepted)
        ));
        older.begin_attempt("turn-1".to_owned()).await.unwrap();

        let (newer, _) = session.acquire_agent().await.unwrap();
        let revision = session.state().await.unwrap().revision();
        assert!(matches!(
            older.complete("turn-1".to_owned(), &1, &"stale").await,
            Err(Error::ModelOwnerFenced)
        ));
        assert!(matches!(
            older
                .fail_attempt("turn-1".to_owned(), "stale".to_owned())
                .await,
            Err(Error::ModelOwnerFenced)
        ));
        assert!(matches!(
            older.cancel("turn-1".to_owned(), None::<&u32>).await,
            Err(Error::ModelOwnerFenced)
        ));
        assert!(matches!(
            older.authorize_model_effect("compaction").await,
            Err(Error::ModelOwnerFenced)
        ));
        assert_eq!(session.state().await.unwrap().revision(), revision);

        older.shutdown().await.unwrap();
        assert!(matches!(
            newer
                .admit_typed::<_, u32, String>("turn-1".to_owned(), &"prompt")
                .await,
            Ok(Admission::Pending)
        ));
        newer.begin_attempt("turn-1".to_owned()).await.unwrap();
        newer
            .complete("turn-1".to_owned(), &2, &"authoritative")
            .await
            .unwrap();
        newer.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn direct_mutation_cannot_bypass_a_live_model_owner() {
        let store = MemoryStore::new().unwrap();
        let session = DurableSession::open(store, "direct-owner-bypass")
            .await
            .unwrap();
        let (owner, _) = session.acquire_agent().await.unwrap();
        assert!(matches!(
            session.admit("turn-1", &"prompt").await,
            Err(Error::ModelOwnerActive)
        ));
        assert_eq!(session.state().await.unwrap().revision(), 0);
        owner.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn abandoned_admission_handoff_releases_the_exact_claim() {
        let store = MemoryStore::new().unwrap();
        let session = DurableSession::open(store, "abandoned-admission")
            .await
            .unwrap();
        let caller = Caller::Direct(session.caller_id.clone());
        let (result, receiver) = oneshot::channel();
        let (acknowledge, acknowledged) = oneshot::channel();
        session
            .send(Command::Admit {
                caller,
                operation_id: "turn-1".to_owned(),
                input: EncodedPayload::encode(&"prompt").unwrap(),
                acknowledged,
                release_commands: session.commands.clone(),
                result,
            })
            .await
            .unwrap();
        assert!(matches!(
            receive(receiver).await,
            Ok(StoredAdmission::Accepted)
        ));

        drop(acknowledge);
        let mut reclaimed = false;
        for _ in 0..16 {
            tokio::task::yield_now().await;
            match session.admit("turn-1", &"prompt").await {
                Ok(Admission::Pending) => {
                    reclaimed = true;
                    break;
                }
                Err(Error::OperationActive { .. }) => {}
                outcome => panic!("unexpected reclaim outcome: {outcome:?}"),
            }
        }
        assert!(reclaimed, "the abandoned handoff must release its claim");
    }

    #[tokio::test]
    async fn duplicate_admission_cannot_release_a_live_attempt() {
        let store = MemoryStore::new().unwrap();
        let session = DurableSession::open(store, "duplicate-live-attempt")
            .await
            .unwrap();
        let claimant = session.clone();
        let duplicate = session.clone();
        assert!(matches!(
            claimant.admit("turn-1", &"prompt").await,
            Ok(Admission::Accepted)
        ));
        claimant.begin_attempt("turn-1").await.unwrap();
        let revision = session.state().await.unwrap().revision();

        assert!(matches!(
            duplicate.admit("turn-1", &"prompt").await,
            Err(Error::OperationActive { .. })
        ));
        let state = session.state().await.unwrap();
        assert_eq!(state.revision(), revision);
        assert!(state.operation("turn-1").unwrap().active_attempt);
        claimant.complete("turn-1", &1, &"done").await.unwrap();
    }

    #[tokio::test]
    async fn owner_shutdown_observes_a_dead_journal_driver() {
        let (commands, receiver) = mpsc::channel(1);
        drop(receiver);
        let (releases, _release_receiver) = mpsc::unbounded_channel();
        let owner = DurableOwner {
            generation: 1,
            commands,
            releases,
            release: Arc::new(OwnerReleaseState::new()),
        };

        assert!(matches!(owner.shutdown().await, Err(Error::DriverStopped)));
    }

    #[tokio::test]
    async fn active_cancellation_advances_the_safe_checkpoint() {
        let store = MemoryStore::new().unwrap();
        let session = DurableSession::open(store, "cancel-checkpoint")
            .await
            .unwrap();
        let (owner, _) = session.acquire_agent().await.unwrap();
        owner
            .admit_typed::<_, u32, String>("turn-1".to_owned(), &"prompt")
            .await
            .unwrap();
        owner.begin_attempt("turn-1".to_owned()).await.unwrap();
        owner
            .cancel("turn-1".to_owned(), Some(&41_u32))
            .await
            .unwrap();
        assert_eq!(
            session
                .latest_checkpoint()
                .await
                .unwrap()
                .unwrap()
                .decode::<u32>()
                .unwrap(),
            41
        );
        owner.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn terminal_boundary_compacts_the_prefix_without_rewinding_revision() {
        let store = MemoryStore::new().unwrap();
        let session = DurableSession::open(store.clone(), "bounded-prefix")
            .await
            .unwrap();
        let (owner, _) = session.acquire_agent().await.unwrap();
        for index in 0..22_u32 {
            let operation_id = format!("turn-{index}");
            let prompt = format!("prompt-{index}");
            assert!(matches!(
                owner
                    .admit_typed::<_, u32, String>(operation_id.clone(), &prompt)
                    .await,
                Ok(Admission::Accepted)
            ));
            owner.begin_attempt(operation_id.clone()).await.unwrap();
            owner
                .complete(operation_id, &index, &format!("output-{index}"))
                .await
                .unwrap();
        }
        owner.shutdown().await.unwrap();

        let mut inspector = store.clone();
        let compacted = inspector
            .acquire_owner("bounded-prefix", OwnerId::new())
            .await
            .unwrap();
        assert_eq!(compacted.journal.revision, 66);
        assert_eq!(compacted.journal.batches.len(), 1);
        assert_eq!(compacted.journal.batches[0].revision, 66);

        let reopened = DurableSession::open(store, "bounded-prefix").await.unwrap();
        assert!(matches!(
            reopened
                .admit_typed::<_, u32, String>("turn-0", &"prompt-0")
                .await,
            Ok(Admission::Completed {
                checkpoint: 0,
                output
            }) if output == "output-0"
        ));
        assert_eq!(reopened.state().await.unwrap().revision(), 66);
    }

    #[tokio::test]
    async fn bounded_terminal_receipt_policy_keeps_only_the_newest_compacted_receipts() {
        let store = MemoryStore::new().unwrap();
        let session = DurableSession::open_with_terminal_receipt_limit(
            store.clone(),
            "bounded-terminal-receipts",
            3,
        )
        .await
        .unwrap();
        let (owner, _) = session.acquire_agent().await.unwrap();
        for index in 0..22_u32 {
            let operation_id = format!("turn-{index}");
            assert!(matches!(
                owner
                    .admit_typed::<_, u32, String>(operation_id.clone(), &index)
                    .await,
                Ok(Admission::Accepted)
            ));
            owner.begin_attempt(operation_id.clone()).await.unwrap();
            owner
                .complete(operation_id, &index, &format!("output-{index}"))
                .await
                .unwrap();
        }
        let live = session.state().await.unwrap();
        assert_eq!(live.operations().len(), 3);
        assert!(live.operation("turn-19").is_some());
        assert!(live.operation("turn-18").is_none());
        owner.shutdown().await.unwrap();

        let reopened = DurableSession::open(store, "bounded-terminal-receipts")
            .await
            .unwrap();
        let state = reopened.state().await.unwrap();
        assert_eq!(state.operations().len(), 3);
        assert!(state.operation("turn-19").is_some());
        assert!(state.operation("turn-20").is_some());
        assert!(state.operation("turn-21").is_some());
        assert!(state.operation("turn-18").is_none());
        assert_eq!(
            state.latest_checkpoint().unwrap().decode::<u32>().unwrap(),
            21
        );
    }

    #[tokio::test]
    async fn standalone_checkpoint_supersedes_the_latest_terminal_boundary() {
        let store = MemoryStore::new().unwrap();
        let session = DurableSession::open(store.clone(), "standalone-checkpoint")
            .await
            .unwrap();
        let (owner, _) = session.acquire_agent().await.unwrap();
        owner
            .admit_typed::<_, u32, String>("turn-1".to_owned(), &"prompt")
            .await
            .unwrap();
        owner.begin_attempt("turn-1".to_owned()).await.unwrap();
        owner
            .complete("turn-1".to_owned(), &1_u32, &"done")
            .await
            .unwrap();
        owner.commit_checkpoint(&2_u32).await.unwrap();
        owner.shutdown().await.unwrap();

        let reopened = DurableSession::open(store, "standalone-checkpoint")
            .await
            .unwrap();
        assert_eq!(
            reopened
                .latest_checkpoint()
                .await
                .unwrap()
                .unwrap()
                .decode::<u32>()
                .unwrap(),
            2
        );
    }
}
