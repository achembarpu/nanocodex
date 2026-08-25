use std::collections::BTreeMap;

use serde::{Serialize, de::DeserializeOwned};
use serde_json::value::RawValue;

use crate::{Error, Result};

/// A typed value erased only for storage in a heterogeneous journal.
///
/// The wrapper preserves the original JSON representation. Consumers recover
/// concrete Rust types with [`Self::decode`]; hosts treat the containing batch
/// as opaque bytes.
#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(transparent)]
pub struct EncodedPayload(Box<RawValue>);

impl EncodedPayload {
    pub(crate) fn encode<T: Serialize + ?Sized>(value: &T) -> Result<Self> {
        serde_json::value::to_raw_value(value)
            .map(Self)
            .map_err(Error::InvalidPayload)
    }

    /// Decodes this payload into its expected concrete type.
    pub fn decode<T: DeserializeOwned>(&self) -> Result<T> {
        serde_json::from_str(self.0.get()).map_err(Error::InvalidPayload)
    }

    /// Returns the exact retained JSON text.
    #[must_use]
    pub fn json(&self) -> &str {
        self.0.get()
    }
}

impl PartialEq for EncodedPayload {
    fn eq(&self, other: &Self) -> bool {
        self.json() == other.json()
    }
}

impl Eq for EncodedPayload {}

/// Recovery policy for a durable step whose start was committed but whose
/// completion was not.
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RetryPolicy {
    /// Never repeat the step automatically because side effects may have happened.
    Never,
    /// Repeating the step with the same identity is safe.
    Idempotent,
}

/// One Rust-owned durable journal entry.
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Entry {
    /// The authoritative owner durably authorized a model-only external effect.
    ///
    /// This append is the effect-start linearization point. A later owner may
    /// fence the stale result, but cannot retract a request that was already
    /// authorized and entered the transport.
    ModelEffectStarted {
        /// Stable semantic effect kind used for recovery diagnostics.
        kind: String,
    },
    /// A host-visible operation was durably accepted.
    OperationAccepted {
        /// Caller-provided idempotency identity.
        operation_id: String,
        /// Opaque typed input encoded by the Rust consumer.
        input: EncodedPayload,
    },
    /// A new execution attempt began for an accepted operation.
    AttemptStarted {
        /// Accepted operation identity.
        operation_id: String,
    },
    /// A live attempt lost its claim before reaching a terminal mutation.
    AttemptReleased {
        /// Accepted operation identity.
        operation_id: String,
    },
    /// A replayable step began.
    StepStarted {
        /// Accepted operation identity.
        operation_id: String,
        /// Stable step identity within the operation.
        step_id: String,
        /// Semantic step kind used for diagnostics.
        kind: String,
        /// Opaque typed step input.
        input: EncodedPayload,
        /// Recovery policy if completion is missing.
        retry: RetryPolicy,
    },
    /// A replayable step completed.
    StepCompleted {
        /// Accepted operation identity.
        operation_id: String,
        /// Stable step identity within the operation.
        step_id: String,
        /// Opaque typed output returned during replay.
        output: EncodedPayload,
    },
    /// An execution attempt failed without terminalizing its operation.
    AttemptFailed {
        /// Accepted operation identity.
        operation_id: String,
        /// Stable diagnostic failure string.
        error: String,
    },
    /// An operation completed and advanced the durable session checkpoint.
    OperationCompleted {
        /// Accepted operation identity.
        operation_id: String,
        /// Opaque resumable agent checkpoint.
        checkpoint: EncodedPayload,
        /// Opaque completed result returned to duplicate submissions.
        output: EncodedPayload,
    },
    /// An operation failed and advanced the durable session checkpoint.
    OperationFailed {
        /// Accepted operation identity.
        operation_id: String,
        /// Opaque resumable agent checkpoint.
        checkpoint: EncodedPayload,
        /// Stable terminal failure detail.
        error: String,
    },
    /// An operation was explicitly cancelled.
    OperationCancelled {
        /// Accepted operation identity.
        operation_id: String,
        /// Safe interrupted checkpoint for an active operation. A queued
        /// cancellation has no new model boundary.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        checkpoint: Option<EncodedPayload>,
    },
    /// A model-only boundary, such as explicit standalone compaction, advanced
    /// the resumable session without terminalizing an operation.
    CheckpointCommitted {
        /// Opaque resumable agent checkpoint.
        checkpoint: EncodedPayload,
    },
}

/// Reduced status of one operation.
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationStatus {
    /// Accepted work may be attempted or resumed.
    Pending,
    /// Work completed with an opaque result and checkpoint.
    Completed {
        /// Resumable checkpoint committed atomically with the result.
        checkpoint: EncodedPayload,
        /// Result returned to duplicate submissions.
        output: EncodedPayload,
    },
    /// Work failed with a resumable checkpoint and retained diagnostic.
    Failed {
        /// Resumable checkpoint committed atomically with the failure.
        checkpoint: EncodedPayload,
        /// Failure returned to duplicate submissions.
        error: String,
    },
    /// Work was explicitly cancelled, optionally after advancing the safe
    /// interrupted checkpoint.
    Cancelled {
        /// Safe checkpoint committed by active cancellation.
        checkpoint: Option<EncodedPayload>,
    },
}

impl OperationStatus {
    /// Returns whether this operation cannot execute again.
    #[must_use]
    pub const fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Completed { .. } | Self::Failed { .. } | Self::Cancelled { .. }
        )
    }
}

/// Reduced status of one step.
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    /// A start exists without a corresponding completion.
    Started,
    /// The step has a replayable output.
    Completed(EncodedPayload),
}

/// Reduced durable step state.
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct StepState {
    /// Semantic kind recorded by the caller.
    pub kind: String,
    /// Original opaque step input.
    pub input: EncodedPayload,
    /// Crash recovery policy.
    pub retry: RetryPolicy,
    /// Current reduced status.
    pub status: StepStatus,
    /// Number of committed starts for this step.
    pub attempts: u32,
}

/// Reduced durable operation state.
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct OperationState {
    /// Original opaque operation input.
    pub input: EncodedPayload,
    /// Current operation status.
    pub status: OperationStatus,
    /// Ordered durable steps by identity.
    pub steps: BTreeMap<String, StepState>,
    /// Number of execution attempts.
    pub attempts: u32,
    /// Whether the latest begun attempt may still mutate this operation.
    pub active_attempt: bool,
    /// Most recent non-terminal failure, when any.
    pub last_error: Option<String>,
    pub(crate) accepted_order: u64,
}

/// Complete state reduced from an append-only journal.
#[derive(Clone, Debug, Default)]
pub struct JournalState {
    revision: u64,
    operations: BTreeMap<String, OperationState>,
    latest_checkpoint: Option<(u64, EncodedPayload)>,
}

#[derive(serde::Deserialize, serde::Serialize)]
pub(crate) struct JournalCheckpoint {
    version: u8,
    operations: BTreeMap<String, OperationState>,
    latest_checkpoint: Option<EncodedPayload>,
}

#[derive(serde::Deserialize, serde::Serialize)]
pub(crate) struct RetainedCheckpoint {
    pub(crate) nanocodex_journal_state: JournalCheckpoint,
}

impl JournalState {
    /// Current optimistic store revision.
    #[must_use]
    pub const fn revision(&self) -> u64 {
        self.revision
    }

    /// Operations keyed by caller-provided identity.
    #[must_use]
    pub const fn operations(&self) -> &BTreeMap<String, OperationState> {
        &self.operations
    }

    /// Looks up one operation.
    #[must_use]
    pub fn operation(&self, operation_id: &str) -> Option<&OperationState> {
        self.operations.get(operation_id)
    }

    /// Returns accepted non-terminal operations in submission order.
    #[must_use]
    pub fn pending_operations(&self) -> Vec<(&str, &OperationState)> {
        let mut operations = self
            .operations
            .iter()
            .filter(|(_, operation)| !operation.status.is_terminal())
            .map(|(id, operation)| (id.as_str(), operation))
            .collect::<Vec<_>>();
        operations.sort_by_key(|(_, operation)| operation.accepted_order);
        operations
    }

    pub(crate) fn first_pending_operation(&self) -> Option<(&str, &OperationState)> {
        self.operations
            .iter()
            .filter(|(_, operation)| !operation.status.is_terminal())
            .min_by_key(|(_, operation)| operation.accepted_order)
            .map(|(id, operation)| (id.as_str(), operation))
    }

    /// Returns the latest terminal checkpoint in operation order.
    #[must_use]
    pub fn latest_checkpoint(&self) -> Option<&EncodedPayload> {
        self.latest_checkpoint
            .as_ref()
            .map(|(_, checkpoint)| checkpoint)
    }

    pub(crate) fn checkpoint_payload(
        &self,
        terminal_receipt_limit: Option<usize>,
    ) -> Result<String> {
        let mut operations = self.operations.clone();
        if let Some(limit) = terminal_receipt_limit {
            Self::retain_terminal_operations(&mut operations, limit);
        }
        serde_json::to_string(&RetainedCheckpoint {
            nanocodex_journal_state: JournalCheckpoint {
                version: 1,
                operations,
                latest_checkpoint: self.latest_checkpoint().cloned(),
            },
        })
        .map_err(Error::InvalidPayload)
    }

    pub(crate) fn retain_terminal_receipts(&mut self, limit: usize) {
        Self::retain_terminal_operations(&mut self.operations, limit);
    }

    fn retain_terminal_operations(operations: &mut BTreeMap<String, OperationState>, limit: usize) {
        let mut terminal_orders = operations
            .values()
            .filter(|operation| operation.status.is_terminal())
            .map(|operation| operation.accepted_order)
            .collect::<Vec<_>>();
        terminal_orders.sort_unstable_by(|left, right| right.cmp(left));
        terminal_orders.truncate(limit);
        let retained = terminal_orders
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>();
        operations.retain(|_, operation| {
            !operation.status.is_terminal() || retained.contains(&operation.accepted_order)
        });
    }

    pub(crate) fn from_checkpoint(revision: u64, checkpoint: JournalCheckpoint) -> Result<Self> {
        if revision == 0 {
            return Err(Error::InvalidJournal(
                "a compacted journal checkpoint must have a positive revision".to_owned(),
            ));
        }
        if checkpoint.version != 1 {
            return Err(Error::InvalidJournal(format!(
                "unsupported compacted journal checkpoint version {}",
                checkpoint.version
            )));
        }
        let mut accepted_orders = std::collections::BTreeSet::new();
        for (operation_id, operation) in &checkpoint.operations {
            ensure_nonempty(operation_id, "operation ID")?;
            if operation.accepted_order == 0
                || operation.accepted_order > revision
                || !accepted_orders.insert(operation.accepted_order)
            {
                return Err(Error::InvalidJournal(format!(
                    "operation `{operation_id}` has an invalid compacted acceptance order"
                )));
            }
            if operation.status.is_terminal() && operation.active_attempt {
                return Err(Error::InvalidJournal(format!(
                    "terminal operation `{operation_id}` retained an active attempt"
                )));
            }
            for (step_id, step) in &operation.steps {
                ensure_nonempty(step_id, "step ID")?;
                ensure_nonempty(&step.kind, "step kind")?;
                if step.attempts == 0 {
                    return Err(Error::InvalidJournal(format!(
                        "step `{step_id}` in operation `{operation_id}` has no committed start"
                    )));
                }
            }
        }
        Ok(Self {
            revision,
            operations: checkpoint.operations,
            latest_checkpoint: checkpoint
                .latest_checkpoint
                .map(|checkpoint| (revision, checkpoint)),
        })
    }

    pub(crate) fn validate_batch(&self, revision: u64, entry: &Entry) -> Result<()> {
        let expected_revision = self.revision.checked_add(1).ok_or_else(|| {
            Error::InvalidJournal("journal revision exceeded the u64 range".to_owned())
        })?;
        if revision != expected_revision {
            return Err(Error::InvalidJournal(format!(
                "expected revision {}, found {revision}",
                expected_revision
            )));
        }
        self.validate(entry)
    }

    pub(crate) fn apply_batch(&mut self, revision: u64, entry: &Entry) -> Result<()> {
        self.validate_batch(revision, entry)?;
        self.apply(revision, entry)?;
        self.revision = revision;
        Ok(())
    }

    pub(crate) fn apply_replayed_batch(&mut self, revision: u64, entry: &Entry) -> Result<()> {
        let expected_revision = self.revision.checked_add(1).ok_or_else(|| {
            Error::InvalidJournal("journal revision exceeded the u64 range".to_owned())
        })?;
        if revision != expected_revision {
            return Err(Error::InvalidJournal(format!(
                "expected revision {}, found {revision}",
                expected_revision
            )));
        }
        self.validate_replayed(entry)?;
        self.apply(revision, entry)?;
        self.revision = revision;
        Ok(())
    }

    fn validate_replayed(&self, entry: &Entry) -> Result<()> {
        if let Some(operation_id) = entry.operation_id() {
            ensure_nonempty(operation_id, "operation ID")?;
        }
        match entry {
            Entry::AttemptStarted { operation_id } | Entry::AttemptFailed { operation_id, .. } => {
                self.pending_operation(operation_id)?;
            }
            Entry::StepStarted {
                operation_id,
                step_id,
                kind,
                input,
                retry,
            } => {
                ensure_nonempty(step_id, "step ID")?;
                ensure_nonempty(kind, "step kind")?;
                let operation = self.pending_operation(operation_id)?;
                if let Some(step) = operation.steps.get(step_id) {
                    if step.kind != *kind || step.input != *input || step.retry != *retry {
                        return Err(Error::InvalidJournal(format!(
                            "step `{step_id}` in operation `{operation_id}` changed definition"
                        )));
                    }
                    if matches!(step.status, StepStatus::Completed(_)) {
                        return Err(Error::InvalidJournal(format!(
                            "completed step `{step_id}` in operation `{operation_id}` restarted"
                        )));
                    }
                }
            }
            Entry::StepCompleted {
                operation_id,
                step_id,
                ..
            } => {
                ensure_nonempty(step_id, "step ID")?;
                let operation = self.pending_operation(operation_id)?;
                let step = operation.steps.get(step_id).ok_or_else(|| {
                    Error::InvalidJournal(format!(
                        "step `{step_id}` in operation `{operation_id}` completed before start"
                    ))
                })?;
                if matches!(step.status, StepStatus::Completed(_)) {
                    return Err(Error::InvalidJournal(format!(
                        "step `{step_id}` in operation `{operation_id}` completed more than once"
                    )));
                }
            }
            Entry::OperationCompleted { operation_id, .. }
            | Entry::OperationFailed { operation_id, .. } => {
                self.ensure_prior_operations_terminal(operation_id)?;
                self.pending_operation(operation_id)?;
            }
            _ => return self.validate(entry),
        }
        Ok(())
    }

    fn validate(&self, entry: &Entry) -> Result<()> {
        if let Some(operation_id) = entry.operation_id() {
            ensure_nonempty(operation_id, "operation ID")?;
        }
        match entry {
            Entry::OperationAccepted { operation_id, .. } => {
                if self.operations.contains_key(operation_id) {
                    return Err(Error::InvalidJournal(format!(
                        "operation `{operation_id}` was accepted more than once"
                    )));
                }
            }
            Entry::AttemptStarted { operation_id } => {
                self.ensure_prior_operations_terminal(operation_id)?;
                let operation = self.pending_operation(operation_id)?;
                if operation.active_attempt {
                    return Err(Error::AttemptActive {
                        operation_id: operation_id.clone(),
                    });
                }
            }
            Entry::AttemptReleased { operation_id } => {
                self.active_attempt(operation_id)?;
            }
            Entry::AttemptFailed { operation_id, .. } => {
                self.attempted_operation(operation_id)?;
            }
            Entry::StepStarted {
                operation_id,
                step_id,
                kind,
                input,
                retry,
            } => {
                ensure_nonempty(step_id, "step ID")?;
                ensure_nonempty(kind, "step kind")?;
                let operation = self.attempted_operation(operation_id)?;
                if let Some(step) = operation.steps.get(step_id) {
                    if step.kind != *kind || step.input != *input || step.retry != *retry {
                        return Err(Error::InvalidJournal(format!(
                            "step `{step_id}` in operation `{operation_id}` changed definition"
                        )));
                    }
                    if matches!(step.status, StepStatus::Completed(_)) {
                        return Err(Error::InvalidJournal(format!(
                            "completed step `{step_id}` in operation `{operation_id}` restarted"
                        )));
                    }
                }
            }
            Entry::StepCompleted {
                operation_id,
                step_id,
                ..
            } => {
                ensure_nonempty(step_id, "step ID")?;
                let operation = self.attempted_operation(operation_id)?;
                let step = operation.steps.get(step_id).ok_or_else(|| {
                    Error::InvalidJournal(format!(
                        "step `{step_id}` in operation `{operation_id}` completed before start"
                    ))
                })?;
                if matches!(step.status, StepStatus::Completed(_)) {
                    return Err(Error::InvalidJournal(format!(
                        "step `{step_id}` in operation `{operation_id}` completed more than once"
                    )));
                }
            }
            Entry::OperationCompleted { operation_id, .. }
            | Entry::OperationFailed { operation_id, .. } => {
                self.attempted_operation(operation_id)?;
            }
            Entry::OperationCancelled { operation_id, .. } => {
                let operation = self.pending_operation(operation_id)?;
                if operation.attempts > 0 {
                    self.ensure_prior_operations_terminal(operation_id)?;
                }
            }
            Entry::ModelEffectStarted { kind } => ensure_nonempty(kind, "model effect kind")?,
            Entry::CheckpointCommitted { .. } => {}
        }
        Ok(())
    }

    fn apply(&mut self, revision: u64, entry: &Entry) -> Result<()> {
        match entry {
            Entry::OperationAccepted {
                operation_id,
                input,
            } => {
                if self.operations.contains_key(operation_id) {
                    return Err(Error::InvalidJournal(format!(
                        "operation `{operation_id}` was accepted more than once"
                    )));
                }
                self.operations.insert(
                    operation_id.clone(),
                    OperationState {
                        input: input.clone(),
                        status: OperationStatus::Pending,
                        steps: BTreeMap::new(),
                        attempts: 0,
                        active_attempt: false,
                        last_error: None,
                        accepted_order: revision,
                    },
                );
            }
            Entry::AttemptStarted { operation_id } => {
                let operation = self.pending_operation_mut(operation_id)?;
                operation.attempts = operation.attempts.saturating_add(1);
                operation.active_attempt = true;
                operation.last_error = None;
            }
            Entry::AttemptReleased { operation_id } => {
                self.pending_operation_mut(operation_id)?.active_attempt = false;
            }
            Entry::StepStarted {
                operation_id,
                step_id,
                kind,
                input,
                retry,
            } => {
                let operation = self.pending_operation_mut(operation_id)?;
                if let Some(step) = operation.steps.get_mut(step_id) {
                    if step.kind != *kind || step.input != *input || step.retry != *retry {
                        return Err(Error::InvalidJournal(format!(
                            "step `{step_id}` in operation `{operation_id}` changed definition"
                        )));
                    }
                    if matches!(step.status, StepStatus::Completed(_)) {
                        return Err(Error::InvalidJournal(format!(
                            "completed step `{step_id}` in operation `{operation_id}` restarted"
                        )));
                    }
                    step.attempts = step.attempts.saturating_add(1);
                } else {
                    operation.steps.insert(
                        step_id.clone(),
                        StepState {
                            kind: kind.clone(),
                            input: input.clone(),
                            retry: *retry,
                            status: StepStatus::Started,
                            attempts: 1,
                        },
                    );
                }
            }
            Entry::StepCompleted {
                operation_id,
                step_id,
                output,
            } => {
                let operation = self.pending_operation_mut(operation_id)?;
                let step = operation.steps.get_mut(step_id).ok_or_else(|| {
                    Error::InvalidJournal(format!(
                        "step `{step_id}` in operation `{operation_id}` completed before start"
                    ))
                })?;
                if matches!(step.status, StepStatus::Completed(_)) {
                    return Err(Error::InvalidJournal(format!(
                        "step `{step_id}` in operation `{operation_id}` completed more than once"
                    )));
                }
                step.status = StepStatus::Completed(output.clone());
            }
            Entry::AttemptFailed {
                operation_id,
                error,
            } => {
                let operation = self.pending_operation_mut(operation_id)?;
                operation.active_attempt = false;
                operation.last_error = Some(error.clone());
            }
            Entry::OperationCompleted {
                operation_id,
                checkpoint,
                output,
            } => {
                self.ensure_prior_operations_terminal(operation_id)?;
                let operation = self.pending_operation_mut(operation_id)?;
                operation.active_attempt = false;
                operation.status = OperationStatus::Completed {
                    checkpoint: checkpoint.clone(),
                    output: output.clone(),
                };
                self.latest_checkpoint = Some((revision, checkpoint.clone()));
            }
            Entry::OperationFailed {
                operation_id,
                checkpoint,
                error,
            } => {
                self.ensure_prior_operations_terminal(operation_id)?;
                let operation = self.pending_operation_mut(operation_id)?;
                operation.active_attempt = false;
                operation.status = OperationStatus::Failed {
                    checkpoint: checkpoint.clone(),
                    error: error.clone(),
                };
                self.latest_checkpoint = Some((revision, checkpoint.clone()));
            }
            Entry::OperationCancelled {
                operation_id,
                checkpoint,
            } => {
                if self.pending_operation(operation_id)?.attempts > 0 {
                    self.ensure_prior_operations_terminal(operation_id)?;
                }
                let operation = self.pending_operation_mut(operation_id)?;
                operation.active_attempt = false;
                operation.status = OperationStatus::Cancelled {
                    checkpoint: checkpoint.clone(),
                };
                if let Some(checkpoint) = checkpoint {
                    self.latest_checkpoint = Some((revision, checkpoint.clone()));
                }
            }
            Entry::ModelEffectStarted { .. } => {}
            Entry::CheckpointCommitted { checkpoint } => {
                self.latest_checkpoint = Some((revision, checkpoint.clone()));
            }
        }
        Ok(())
    }

    fn pending_operation_mut(&mut self, operation_id: &str) -> Result<&mut OperationState> {
        let operation = self.operations.get_mut(operation_id).ok_or_else(|| {
            Error::InvalidJournal(format!("operation `{operation_id}` was not accepted"))
        })?;
        if operation.status.is_terminal() {
            return Err(Error::InvalidJournal(format!(
                "terminal operation `{operation_id}` was changed"
            )));
        }
        Ok(operation)
    }

    fn pending_operation(&self, operation_id: &str) -> Result<&OperationState> {
        let operation = self.operations.get(operation_id).ok_or_else(|| {
            Error::InvalidJournal(format!("operation `{operation_id}` was not accepted"))
        })?;
        if operation.status.is_terminal() {
            return Err(Error::InvalidJournal(format!(
                "terminal operation `{operation_id}` was changed"
            )));
        }
        Ok(operation)
    }

    fn attempted_operation(&self, operation_id: &str) -> Result<&OperationState> {
        self.ensure_prior_operations_terminal(operation_id)?;
        self.active_attempt(operation_id)
    }

    fn active_attempt(&self, operation_id: &str) -> Result<&OperationState> {
        let operation = self.pending_operation(operation_id)?;
        if !operation.active_attempt {
            return Err(Error::InvalidJournal(format!(
                "operation `{operation_id}` does not have an active attempt"
            )));
        }
        Ok(operation)
    }

    fn ensure_prior_operations_terminal(&self, operation_id: &str) -> Result<()> {
        let operation = self.operations.get(operation_id).ok_or_else(|| {
            Error::InvalidJournal(format!("operation `{operation_id}` was not accepted"))
        })?;
        if let Some((pending_id, _)) = self.operations.iter().find(|(id, candidate)| {
            candidate.accepted_order < operation.accepted_order
                && !candidate.status.is_terminal()
                && id.as_str() != operation_id
        }) {
            return Err(Error::InvalidJournal(format!(
                "operation `{operation_id}` completed before `{pending_id}`"
            )));
        }
        Ok(())
    }
}

impl Entry {
    fn operation_id(&self) -> Option<&str> {
        match self {
            Self::OperationAccepted { operation_id, .. }
            | Self::AttemptStarted { operation_id }
            | Self::AttemptReleased { operation_id }
            | Self::StepStarted { operation_id, .. }
            | Self::StepCompleted { operation_id, .. }
            | Self::AttemptFailed { operation_id, .. }
            | Self::OperationCompleted { operation_id, .. }
            | Self::OperationFailed { operation_id, .. }
            | Self::OperationCancelled { operation_id, .. } => Some(operation_id),
            Self::ModelEffectStarted { .. } | Self::CheckpointCommitted { .. } => None,
        }
    }
}

fn ensure_nonempty(value: &str, name: &str) -> Result<()> {
    if value.trim().is_empty() {
        return Err(Error::InvalidJournal(format!("{name} must not be empty")));
    }
    Ok(())
}
