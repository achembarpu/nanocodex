// Derived from clabby/tact; modified for Nanocodex2.
// SPDX-License-Identifier: Apache-2.0

//! Durable transcript records and their structured projection.

mod entry;
mod model;
mod record;

pub(crate) use entry::{
    DirectedMessageEntry, EntryId, EntryKind, MessageDelivery, MessagePhase, ToolEntry, ToolState,
    TranscriptEntry, TransientStatus, is_subagent_tool,
};
pub(crate) use model::TranscriptModel;
pub(crate) use record::{
    LocalEvent, SCHEMA_VERSION, SessionEnded, SessionOutcome, SessionStarted, ShellId,
    TranscriptRecord, TurnId,
};
