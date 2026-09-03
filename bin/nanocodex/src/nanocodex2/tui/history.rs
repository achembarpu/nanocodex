// SPDX-License-Identifier: Apache-2.0

//! Private managed-history state and transcript projection.

use super::{
    session::RecentPrompt,
    transcript::{LocalEvent, TranscriptRecord, TurnId},
};
use nanocodex_agent::events::AgentEvent;
use nanocodex_managed::{
    EventHistoryPage, ManagedError, ManagedEvent, ManagedEventData, PromptContent, PromptInput,
};
use std::{
    collections::HashMap,
    path::Path,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

pub(super) type HistoryProjection = (Vec<Arc<TranscriptRecord>>, u64, Vec<RecentPrompt>);
pub(super) type LiveManagedProjection = (Arc<TranscriptRecord>, Option<RecentPrompt>);

#[derive(Clone, Default)]
pub(super) struct HistoryWindow {
    pub(super) events: Vec<ManagedEvent>,
    pub(super) before: Option<String>,
    pub(super) has_more: bool,
}

impl HistoryWindow {
    pub(super) fn retry_from(before: String) -> Self {
        Self {
            events: Vec::new(),
            before: Some(before),
            has_more: true,
        }
    }

    pub(super) fn from_page(
        requested_before: String,
        page: EventHistoryPage,
    ) -> Result<Self, ManagedError> {
        let mut window = Self::retry_from(requested_before);
        window.prepend(page)?;
        Ok(window)
    }

    pub(super) fn prepend(&mut self, page: EventHistoryPage) -> Result<(), ManagedError> {
        if page.data.is_empty() && page.has_more {
            return Err(ManagedError::InvalidResponse(
                "managed history reports an empty nonterminal page",
            ));
        }
        self.before = page.data.first().map(|event| event.cursor.clone());
        self.has_more = page.has_more;
        let mut events = page.data;
        events.append(&mut self.events);
        self.events = events;
        Ok(())
    }

    pub(super) fn prepend_window(&mut self, mut older: Self) {
        older.events.append(&mut self.events);
        self.events = older.events;
        self.before = older.before;
        self.has_more = older.has_more;
    }
}

pub(super) fn live_managed_projection(
    event: ManagedEvent,
    agent_id: &str,
    workspace: &Path,
    next_sequence: &mut u64,
) -> Result<Option<LiveManagedProjection>, ManagedError> {
    let timestamp = managed_timestamp(event.created_at, 0);
    let (record, prompt) = match event.data {
        ManagedEventData::TurnAccepted { input, .. } => {
            let text = prompt_input_text(&input);
            let record = TranscriptRecord::from_local(
                *next_sequence,
                timestamp,
                LocalEvent::UserSubmitted {
                    id: TurnId::new(*next_sequence),
                    text: text.clone(),
                },
            )
            .map_err(|error| {
                ManagedError::Configuration(format!("TUI managed event error: {error}"))
            })?;
            let prompt = RecentPrompt {
                text,
                recorded_at_unix_ms: timestamp,
                session_id: agent_id.to_owned(),
                workspace: workspace.to_path_buf(),
            };
            (record, Some(prompt))
        }
        ManagedEventData::Event { event } => {
            let event: AgentEvent = serde_json::from_str(event.get()).map_err(|error| {
                ManagedError::Configuration(format!(
                    "invalid live agent event in TUI stream: {error}"
                ))
            })?;
            (
                TranscriptRecord::from_agent(*next_sequence, timestamp, event),
                None,
            )
        }
        ManagedEventData::TurnFailed { error, .. }
        | ManagedEventData::TurnRetryable { error, .. } => {
            let record = TranscriptRecord::from_local(
                *next_sequence,
                timestamp,
                LocalEvent::WorkerTurnFinished {
                    id: TurnId::new(*next_sequence),
                    error: Some(error),
                },
            )
            .map_err(|error| {
                ManagedError::Configuration(format!("TUI managed event error: {error}"))
            })?;
            (record, None)
        }
        ManagedEventData::AgentCreated { .. }
        | ManagedEventData::TurnCancelling { .. }
        | ManagedEventData::TurnCompleted { .. }
        | ManagedEventData::TurnCancelled { .. }
        | ManagedEventData::StreamFailed { .. } => return Ok(None),
    };
    *next_sequence = next_sequence.saturating_add(1);
    Ok(Some((Arc::new(record), prompt)))
}

pub(super) fn history_projection(
    history: Vec<ManagedEvent>,
    agent_id: &str,
    workspace: &Path,
) -> Result<HistoryProjection, ManagedError> {
    let mut sequences = HashMap::new();
    let mut next_sequence = 1;
    let (records, recent) = history_projection_with_sequences(
        &history,
        agent_id,
        workspace,
        &mut sequences,
        &mut next_sequence,
    )?;
    Ok((records, next_sequence, recent))
}

pub(super) fn history_projection_with_sequences(
    history: &[ManagedEvent],
    agent_id: &str,
    workspace: &Path,
    sequences: &mut HashMap<String, u64>,
    next_sequence: &mut u64,
) -> Result<(Vec<Arc<TranscriptRecord>>, Vec<RecentPrompt>), ManagedError> {
    history_projection_range_with_sequences(
        history,
        false,
        agent_id,
        workspace,
        sequences,
        next_sequence,
    )
}

pub(super) fn older_history_projection_with_sequences(
    older: &[ManagedEvent],
    coherent_tail: bool,
    agent_id: &str,
    workspace: &Path,
    sequences: &mut HashMap<String, u64>,
    next_sequence: &mut u64,
) -> Result<(Vec<Arc<TranscriptRecord>>, Vec<RecentPrompt>), ManagedError> {
    history_projection_range_with_sequences(
        older,
        coherent_tail,
        agent_id,
        workspace,
        sequences,
        next_sequence,
    )
}

fn history_projection_range_with_sequences(
    history: &[ManagedEvent],
    coherent_tail: bool,
    agent_id: &str,
    workspace: &Path,
    sequences: &mut HashMap<String, u64>,
    next_sequence: &mut u64,
) -> Result<(Vec<Arc<TranscriptRecord>>, Vec<RecentPrompt>), ManagedError> {
    let mut records = Vec::new();
    let mut recent = Vec::new();
    let initial_next_sequence = *next_sequence;
    let mut inserted_cursors = Vec::new();
    let coherent_start = history
        .iter()
        .position(|event| matches!(event.data, ManagedEventData::TurnAccepted { .. }))
        .unwrap_or(if coherent_tail { history.len() } else { 0 });
    for (index, event) in history.iter().enumerate().skip(coherent_start) {
        let sequence = if let Some(sequence) = sequences.get(&event.cursor) {
            *sequence
        } else {
            let sequence = *next_sequence;
            *next_sequence = next_sequence.saturating_add(1);
            sequences.insert(event.cursor.clone(), sequence);
            inserted_cursors.push(event.cursor.clone());
            sequence
        };
        let timestamp = managed_timestamp(event.created_at, index);
        let projected = (|| -> Result<_, ManagedError> {
            match &event.data {
                ManagedEventData::TurnAccepted { input, .. } => {
                    let text = prompt_input_text(input);
                    let record = TranscriptRecord::from_local(
                        sequence,
                        timestamp,
                        LocalEvent::UserSubmitted {
                            id: TurnId::new(sequence),
                            text: text.clone(),
                        },
                    )
                    .map_err(|error| {
                        ManagedError::Configuration(format!("TUI history error: {error}"))
                    })?;
                    let prompt = RecentPrompt {
                        text,
                        recorded_at_unix_ms: timestamp,
                        session_id: agent_id.to_owned(),
                        workspace: workspace.to_path_buf(),
                    };
                    Ok(Some((Arc::new(record), Some(prompt))))
                }
                ManagedEventData::Event { event } => {
                    let event: AgentEvent = serde_json::from_str(event.get()).map_err(|error| {
                        ManagedError::Configuration(format!(
                            "invalid retained agent event in TUI history: {error}"
                        ))
                    })?;
                    Ok(Some((
                        Arc::new(TranscriptRecord::from_agent(sequence, timestamp, event)),
                        None,
                    )))
                }
                ManagedEventData::TurnFailed { error, .. }
                | ManagedEventData::TurnRetryable { error, .. } => {
                    let record = TranscriptRecord::from_local(
                        sequence,
                        timestamp,
                        LocalEvent::WorkerTurnFinished {
                            id: TurnId::new(sequence),
                            error: Some(error.clone()),
                        },
                    )
                    .map_err(|error| {
                        ManagedError::Configuration(format!("TUI history error: {error}"))
                    })?;
                    Ok(Some((Arc::new(record), None)))
                }
                ManagedEventData::AgentCreated { .. }
                | ManagedEventData::TurnCancelling { .. }
                | ManagedEventData::TurnCompleted { .. }
                | ManagedEventData::TurnCancelled { .. }
                | ManagedEventData::StreamFailed { .. } => Ok(None),
            }
        })();
        match projected {
            Ok(Some((record, prompt))) => {
                records.push(record);
                if let Some(prompt) = prompt {
                    recent.push(prompt);
                }
            }
            Ok(None) => {}
            Err(error) => {
                for cursor in inserted_cursors {
                    sequences.remove(&cursor);
                }
                *next_sequence = initial_next_sequence;
                return Err(error);
            }
        }
    }
    recent.reverse();
    Ok((records, recent))
}

fn prompt_input_text(input: &PromptInput) -> String {
    match input {
        PromptInput::Text(text) => text.clone(),
        PromptInput::Content(content) => content
            .iter()
            .map(|item| match item {
                PromptContent::Text { text } => text.as_str(),
                PromptContent::Image { .. } => "[image attachment]",
                PromptContent::Audio { .. } => "[audio attachment]",
            })
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

fn managed_timestamp(created_at: Option<f64>, fallback_offset: usize) -> u64 {
    let Some(mut timestamp) = created_at.filter(|timestamp| timestamp.is_finite()) else {
        return unix_ms().saturating_add(u64::try_from(fallback_offset).unwrap_or(u64::MAX));
    };
    if timestamp < 10_000_000_000.0 {
        timestamp *= 1_000.0;
    }
    timestamp.max(0.0) as u64
}

pub(super) fn unix_ms() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(u64::MAX)
}
