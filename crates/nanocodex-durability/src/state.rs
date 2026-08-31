use std::collections::BTreeMap;

use crate::{Error, Result};
use serde::{Serialize, de::DeserializeOwned};

const STATE_FORMAT: u8 = 1;

/// A typed value erased only for storage in a heterogeneous state.
///
/// The wrapper preserves the original JSON representation. Consumers recover
/// concrete Rust types with [`Self::decode`]; hosts treat the containing state
/// as opaque bytes.
#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(transparent)]
pub struct EncodedPayload(String);

impl EncodedPayload {
    pub(crate) fn encode<T: Serialize + ?Sized>(value: &T) -> Result<Self> {
        serde_json::to_string(value)
            .map(Self)
            .map_err(Error::InvalidPayload)
    }

    /// Decodes this payload into its expected concrete type.
    pub fn decode<T: DeserializeOwned>(&self) -> Result<T> {
        serde_json::from_str(&self.0).map_err(Error::InvalidPayload)
    }

    /// Returns the exact retained JSON text.
    #[must_use]
    pub fn json(&self) -> &str {
        &self.0
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

/// One Rust-owned durable state entry.
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Transition {
    /// A host-visible operation was durably accepted.
    OperationAccepted {
        /// Caller-provided idempotency identity.
        operation_id: String,
        /// Opaque typed input encoded by the Rust consumer.
        input: EncodedPayload,
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
    /// A newly started at-most-once step was not observed by its executor, so
    /// its effect boundary is removed before any external dispatch can occur.
    StepAbandoned {
        /// Accepted operation identity.
        operation_id: String,
        /// Stable step identity within the operation.
        step_id: String,
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
    /// A retry-safe standalone checkpoint effect crossed its store fence.
    CheckpointEffectStarted,
    /// A model-only boundary, such as explicit standalone compaction, advanced
    /// the resumable session without terminalizing an operation.
    CheckpointCommitted {
        /// Opaque resumable agent checkpoint.
        checkpoint: EncodedPayload,
    },
}

/// Reduced status of one operation.
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
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
    /// The intent committed and the external effect has an unknown outcome.
    EffectPending,
    /// The external effect's exact output settled durably.
    Completed(EncodedPayload),
}

/// Reduced durable step state.
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
pub struct OperationState {
    /// Original opaque operation input.
    pub input: EncodedPayload,
    /// Current operation status.
    pub status: OperationStatus,
    /// Ordered durable steps by identity.
    pub steps: BTreeMap<String, StepState>,
    pub(crate) accepted_order: u64,
}

/// Complete state reduced from an complete retained state.
#[derive(Clone, Debug, Default)]
pub struct DurableState {
    revision: u64,
    operations: BTreeMap<String, OperationState>,
    latest_checkpoint: Option<(u64, EncodedPayload)>,
    checkpoint_effect_pending: bool,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DurableCheckpoint {
    format: u8,
    operations: BTreeMap<String, OperationState>,
    latest_checkpoint: Option<EncodedPayload>,
    checkpoint_effect_pending: bool,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RetainedCheckpoint {
    pub(crate) nanocodex_durable_state: DurableCheckpoint,
}

#[derive(serde::Serialize)]
struct DurableCheckpointRef<'a> {
    format: u8,
    operations: &'a BTreeMap<String, OperationState>,
    latest_checkpoint: Option<&'a EncodedPayload>,
    checkpoint_effect_pending: bool,
}

#[derive(serde::Serialize)]
struct RetainedCheckpointRef<'a> {
    nanocodex_durable_state: DurableCheckpointRef<'a>,
}

impl DurableState {
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
        self.first_pending_operation_where(|_| true)
    }

    pub(crate) fn first_pending_operation_where(
        &self,
        mut predicate: impl FnMut(&str) -> bool,
    ) -> Option<(&str, &OperationState)> {
        self.operations
            .iter()
            .filter(|(id, operation)| !operation.status.is_terminal() && predicate(id.as_str()))
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

    /// Returns whether a retry-safe standalone checkpoint effect has committed
    /// its intent but not its settlement.
    #[must_use]
    pub const fn checkpoint_effect_pending(&self) -> bool {
        self.checkpoint_effect_pending
    }

    pub(crate) fn checkpoint_payload(&self) -> Result<String> {
        serde_json::to_string(&RetainedCheckpointRef {
            nanocodex_durable_state: DurableCheckpointRef {
                format: STATE_FORMAT,
                operations: &self.operations,
                latest_checkpoint: self.latest_checkpoint(),
                checkpoint_effect_pending: self.checkpoint_effect_pending,
            },
        })
        .map_err(Error::InvalidPayload)
    }

    pub(crate) fn retain_terminal_receipts(&mut self, limit: usize) -> bool {
        let before = self.operations.len();
        Self::retain_terminal_operations(&mut self.operations, limit);
        self.operations.len() != before
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

    pub(crate) fn from_checkpoint(revision: u64, checkpoint: DurableCheckpoint) -> Result<Self> {
        if revision == 0 {
            return Err(Error::InvalidState(
                "a compacted state checkpoint must have a positive revision".to_owned(),
            ));
        }
        if checkpoint.format != STATE_FORMAT {
            return Err(Error::InvalidState(format!(
                "unsupported state format {}",
                checkpoint.format
            )));
        }
        let mut accepted_orders = std::collections::BTreeSet::new();
        for (operation_id, operation) in &checkpoint.operations {
            ensure_nonempty(operation_id, "operation ID")?;
            if operation.accepted_order == 0
                || operation.accepted_order > revision
                || !accepted_orders.insert(operation.accepted_order)
            {
                return Err(Error::InvalidState(format!(
                    "operation `{operation_id}` has an invalid compacted acceptance order"
                )));
            }
            for (step_id, step) in &operation.steps {
                ensure_nonempty(step_id, "step ID")?;
                ensure_nonempty(&step.kind, "step kind")?;
                if step.attempts == 0 {
                    return Err(Error::InvalidState(format!(
                        "step `{step_id}` in operation `{operation_id}` has no committed start"
                    )));
                }
                if step.retry == RetryPolicy::Never && step.attempts != 1 {
                    return Err(Error::InvalidState(format!(
                        "at-most-once step `{step_id}` in operation `{operation_id}` has more than one committed start"
                    )));
                }
            }
            if matches!(
                &operation.status,
                OperationStatus::Cancelled { checkpoint: None }
            ) && !operation.steps.is_empty()
            {
                return Err(Error::InvalidState(format!(
                    "started operation `{operation_id}` was cancelled without a checkpoint"
                )));
            }
        }
        let state = Self {
            revision,
            operations: checkpoint.operations,
            latest_checkpoint: checkpoint
                .latest_checkpoint
                .map(|checkpoint| (revision, checkpoint)),
            checkpoint_effect_pending: checkpoint.checkpoint_effect_pending,
        };
        if state.checkpoint_effect_pending
            && let Some((pending_id, _)) = state.first_pending_operation()
        {
            return Err(Error::InvalidState(format!(
                "standalone checkpoint effect crossed pending operation `{pending_id}`"
            )));
        }
        for (operation_id, operation) in &state.operations {
            if matches!(
                &operation.status,
                OperationStatus::Completed { .. }
                    | OperationStatus::Failed { .. }
                    | OperationStatus::Cancelled {
                        checkpoint: Some(_)
                    }
            ) {
                state.ensure_prior_operations_terminal(operation_id)?;
            }
        }
        Ok(state)
    }

    pub(crate) fn validate_transition(&self, revision: u64, entry: &Transition) -> Result<()> {
        let expected_revision = self.revision.checked_add(1).ok_or_else(|| {
            Error::InvalidState("state revision exceeded the u64 range".to_owned())
        })?;
        if revision != expected_revision {
            return Err(Error::InvalidState(format!(
                "expected revision {}, found {revision}",
                expected_revision
            )));
        }
        self.validate(entry)
    }

    pub(crate) fn apply_transition(&mut self, revision: u64, entry: Transition) -> Result<()> {
        self.validate_transition(revision, &entry)?;
        self.apply(revision, entry)?;
        self.revision = revision;
        Ok(())
    }

    pub(crate) fn advance_revision(&mut self, revision: u64) -> Result<()> {
        let expected_revision = self.revision.checked_add(1).ok_or_else(|| {
            Error::InvalidState("state revision exceeded the u64 range".to_owned())
        })?;
        if revision != expected_revision {
            return Err(Error::InvalidState(format!(
                "expected revision {}, found {revision}",
                expected_revision
            )));
        }
        self.revision = revision;
        Ok(())
    }

    fn validate(&self, entry: &Transition) -> Result<()> {
        if let Some(operation_id) = entry.operation_id() {
            ensure_nonempty(operation_id, "operation ID")?;
        }
        match entry {
            Transition::OperationAccepted { operation_id, .. } => {
                if self.operations.contains_key(operation_id) {
                    return Err(Error::InvalidState(format!(
                        "operation `{operation_id}` was accepted more than once"
                    )));
                }
            }
            Transition::StepStarted {
                operation_id,
                step_id,
                kind,
                input,
                retry,
            } => {
                ensure_nonempty(step_id, "step ID")?;
                ensure_nonempty(kind, "step kind")?;
                self.ensure_prior_operations_terminal(operation_id)?;
                let operation = self.pending_operation(operation_id)?;
                if let Some(step) = operation.steps.get(step_id) {
                    if step.kind != *kind || step.input != *input || step.retry != *retry {
                        return Err(Error::InvalidState(format!(
                            "step `{step_id}` in operation `{operation_id}` changed definition"
                        )));
                    }
                    if matches!(step.status, StepStatus::Completed(_)) {
                        return Err(Error::InvalidState(format!(
                            "settled step `{step_id}` in operation `{operation_id}` restarted"
                        )));
                    }
                    if step.retry == RetryPolicy::Never {
                        return Err(Error::InvalidState(format!(
                            "at-most-once step `{step_id}` in operation `{operation_id}` restarted"
                        )));
                    }
                    if step.attempts == u32::MAX {
                        return Err(Error::InvalidState(format!(
                            "step `{step_id}` in operation `{operation_id}` exceeded the attempt counter range"
                        )));
                    }
                }
            }
            Transition::StepCompleted {
                operation_id,
                step_id,
                output: _,
            } => {
                ensure_nonempty(step_id, "step ID")?;
                self.ensure_prior_operations_terminal(operation_id)?;
                let operation = self.pending_operation(operation_id)?;
                let step = operation.steps.get(step_id).ok_or_else(|| {
                    Error::InvalidState(format!(
                        "step `{step_id}` in operation `{operation_id}` completed before start"
                    ))
                })?;
                match &step.status {
                    StepStatus::EffectPending => {}
                    StepStatus::Completed(_) => {
                        return Err(Error::InvalidState(format!(
                            "step `{step_id}` in operation `{operation_id}` completed more than once"
                        )));
                    }
                }
            }
            Transition::StepAbandoned {
                operation_id,
                step_id,
            } => {
                ensure_nonempty(step_id, "step ID")?;
                self.ensure_prior_operations_terminal(operation_id)?;
                let operation = self.pending_operation(operation_id)?;
                let step = operation.steps.get(step_id).ok_or_else(|| {
                    Error::InvalidState(format!(
                        "step `{step_id}` in operation `{operation_id}` was abandoned before start"
                    ))
                })?;
                if step.retry != RetryPolicy::Never
                    || !matches!(step.status, StepStatus::EffectPending)
                    || step.attempts != 1
                {
                    return Err(Error::InvalidState(format!(
                        "step `{step_id}` in operation `{operation_id}` cannot be abandoned after effect authorization"
                    )));
                }
            }
            Transition::OperationCompleted { operation_id, .. } => {
                self.ensure_prior_operations_terminal(operation_id)?;
                let operation = self.pending_operation(operation_id)?;
                if operation
                    .steps
                    .values()
                    .any(|step| !matches!(step.status, StepStatus::Completed(_)))
                {
                    return Err(Error::InvalidState(format!(
                        "operation `{operation_id}` completed with an unfinished step"
                    )));
                }
            }
            Transition::OperationFailed { operation_id, .. } => {
                self.ensure_prior_operations_terminal(operation_id)?;
                self.pending_operation(operation_id)?;
            }
            Transition::OperationCancelled {
                operation_id,
                checkpoint,
            } => {
                let operation = self.pending_operation(operation_id)?;
                if checkpoint.is_some() {
                    self.ensure_prior_operations_terminal(operation_id)?;
                } else if !operation.steps.is_empty() {
                    return Err(Error::InvalidState(format!(
                        "started operation `{operation_id}` was cancelled without a checkpoint"
                    )));
                }
            }
            Transition::CheckpointEffectStarted | Transition::CheckpointCommitted { .. } => {
                if let Some((pending_id, _)) = self.first_pending_operation() {
                    return Err(Error::InvalidState(format!(
                        "standalone checkpoint effect crossed pending operation `{pending_id}`"
                    )));
                }
            }
        }
        Ok(())
    }

    fn apply(&mut self, revision: u64, entry: Transition) -> Result<()> {
        match entry {
            Transition::OperationAccepted {
                operation_id,
                input,
            } => {
                self.operations.insert(
                    operation_id,
                    OperationState {
                        input,
                        status: OperationStatus::Pending,
                        steps: BTreeMap::new(),
                        accepted_order: revision,
                    },
                );
            }
            Transition::StepStarted {
                operation_id,
                step_id,
                kind,
                input,
                retry,
            } => {
                let operation = self.pending_operation_mut(&operation_id)?;
                if let Some(step) = operation.steps.get_mut(&step_id) {
                    step.attempts = step.attempts.checked_add(1).ok_or_else(|| {
                        Error::InvalidState(format!(
                            "step `{step_id}` in operation `{operation_id}` exceeded the attempt counter range"
                        ))
                    })?;
                } else {
                    operation.steps.insert(
                        step_id,
                        StepState {
                            kind,
                            input,
                            retry,
                            status: StepStatus::EffectPending,
                            attempts: 1,
                        },
                    );
                }
            }
            Transition::StepCompleted {
                operation_id,
                step_id,
                output,
            } => {
                let operation = self.pending_operation_mut(&operation_id)?;
                let step = operation.steps.get_mut(&step_id).ok_or_else(|| {
                    Error::InvalidState(format!(
                        "step `{step_id}` in operation `{operation_id}` completed before start"
                    ))
                })?;
                step.status = StepStatus::Completed(output);
            }
            Transition::StepAbandoned {
                operation_id,
                step_id,
            } => {
                self.pending_operation_mut(&operation_id)?
                    .steps
                    .remove(&step_id);
            }
            Transition::OperationCompleted {
                operation_id,
                checkpoint,
                output,
            } => {
                let operation = self.pending_operation_mut(&operation_id)?;
                operation.status = OperationStatus::Completed {
                    checkpoint: checkpoint.clone(),
                    output,
                };
                self.latest_checkpoint = Some((revision, checkpoint));
            }
            Transition::OperationFailed {
                operation_id,
                checkpoint,
                error,
            } => {
                let operation = self.pending_operation_mut(&operation_id)?;
                operation.status = OperationStatus::Failed {
                    checkpoint: checkpoint.clone(),
                    error,
                };
                self.latest_checkpoint = Some((revision, checkpoint));
            }
            Transition::OperationCancelled {
                operation_id,
                checkpoint,
            } => {
                let operation = self.pending_operation_mut(&operation_id)?;
                operation.status = OperationStatus::Cancelled {
                    checkpoint: checkpoint.clone(),
                };
                if let Some(checkpoint) = checkpoint {
                    self.latest_checkpoint = Some((revision, checkpoint));
                }
            }
            Transition::CheckpointEffectStarted => {
                self.checkpoint_effect_pending = true;
            }
            Transition::CheckpointCommitted { checkpoint } => {
                self.latest_checkpoint = Some((revision, checkpoint));
                self.checkpoint_effect_pending = false;
            }
        }
        Ok(())
    }

    fn pending_operation_mut(&mut self, operation_id: &str) -> Result<&mut OperationState> {
        let operation = self.operations.get_mut(operation_id).ok_or_else(|| {
            Error::InvalidState(format!("operation `{operation_id}` was not accepted"))
        })?;
        if operation.status.is_terminal() {
            return Err(Error::InvalidState(format!(
                "terminal operation `{operation_id}` was changed"
            )));
        }
        Ok(operation)
    }

    fn pending_operation(&self, operation_id: &str) -> Result<&OperationState> {
        let operation = self.operations.get(operation_id).ok_or_else(|| {
            Error::InvalidState(format!("operation `{operation_id}` was not accepted"))
        })?;
        if operation.status.is_terminal() {
            return Err(Error::InvalidState(format!(
                "terminal operation `{operation_id}` was changed"
            )));
        }
        Ok(operation)
    }

    fn ensure_prior_operations_terminal(&self, operation_id: &str) -> Result<()> {
        let operation = self.operations.get(operation_id).ok_or_else(|| {
            Error::InvalidState(format!("operation `{operation_id}` was not accepted"))
        })?;
        if let Some((pending_id, _)) = self.operations.iter().find(|(id, candidate)| {
            candidate.accepted_order < operation.accepted_order
                && !candidate.status.is_terminal()
                && id.as_str() != operation_id
        }) {
            return Err(Error::InvalidState(format!(
                "operation `{operation_id}` completed before `{pending_id}`"
            )));
        }
        Ok(())
    }
}

impl Transition {
    fn operation_id(&self) -> Option<&str> {
        match self {
            Self::OperationAccepted { operation_id, .. }
            | Self::StepStarted { operation_id, .. }
            | Self::StepAbandoned { operation_id, .. }
            | Self::StepCompleted { operation_id, .. }
            | Self::OperationCompleted { operation_id, .. }
            | Self::OperationFailed { operation_id, .. }
            | Self::OperationCancelled { operation_id, .. } => Some(operation_id),
            Self::CheckpointEffectStarted | Self::CheckpointCommitted { .. } => None,
        }
    }
}

fn ensure_nonempty(value: &str, name: &str) -> Result<()> {
    if value.trim().is_empty() {
        return Err(Error::InvalidState(format!("{name} must not be empty")));
    }
    Ok(())
}
