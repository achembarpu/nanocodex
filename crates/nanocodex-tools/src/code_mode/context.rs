use nanocodex_core::{
    AgentMessageContent, ContentItem, FunctionOutputBody, FunctionOutputContent, MessagePhase,
    MessageRole, ReasoningContent, ReasoningSummary, ResponseItem,
};
use serde::{Deserialize, Serialize};

/// A stable, semantic projection of one item in the invoking agent's transcript.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContextItem {
    Message {
        role: MessageRole,
        content: Vec<ContextContent>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        phase: Option<MessagePhase>,
    },
    AgentMessage {
        author: Box<str>,
        recipient: Box<str>,
        content: Vec<ContextContent>,
    },
    Reasoning {
        summary: Vec<Box<str>>,
        content: Vec<Box<str>>,
    },
    ToolCall {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        call_id: Option<Box<str>>,
        name: Box<str>,
        input: Box<str>,
    },
    ToolResult {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        call_id: Option<Box<str>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<Box<str>>,
        output: Vec<ContextContent>,
    },
    Compaction,
}

/// Content exposed by [`ContextItem`] inside Code Mode.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContextContent {
    Text { text: Box<str> },
    Image { image_url: Box<str> },
    Audio { audio_url: Box<str> },
}

pub(super) fn project(history: &[ResponseItem]) -> Vec<ContextItem> {
    history.iter().filter_map(project_item).collect()
}

fn project_item(item: &ResponseItem) -> Option<ContextItem> {
    match item {
        ResponseItem::Message {
            role,
            content,
            phase,
            ..
        } => Some(ContextItem::Message {
            role: *role,
            content: content.iter().map(project_content).collect(),
            phase: *phase,
        }),
        ResponseItem::AgentMessage {
            author,
            recipient,
            content,
            ..
        } => Some(ContextItem::AgentMessage {
            author: author.clone(),
            recipient: recipient.clone(),
            content: content.iter().filter_map(project_agent_content).collect(),
        }),
        ResponseItem::Reasoning {
            summary, content, ..
        } => Some(ContextItem::Reasoning {
            summary: summary.iter().map(project_summary).collect(),
            content: content
                .iter()
                .flatten()
                .map(project_reasoning_content)
                .collect(),
        }),
        item => project_tool_item(item),
    }
}

fn project_tool_item(item: &ResponseItem) -> Option<ContextItem> {
    match item {
        ResponseItem::LocalShellCall {
            call_id, action, ..
        } => Some(ContextItem::ToolCall {
            call_id: call_id.clone(),
            name: "local_shell".into(),
            input: serialize_typed(action),
        }),
        ResponseItem::FunctionCall {
            name,
            arguments,
            call_id,
            ..
        } => Some(ContextItem::ToolCall {
            call_id: Some(call_id.clone()),
            name: name.clone(),
            input: arguments.clone(),
        }),
        ResponseItem::FunctionCallOutput {
            call_id, output, ..
        } => Some(ContextItem::ToolResult {
            call_id: Some(call_id.clone()),
            name: None,
            output: project_output(output),
        }),
        ResponseItem::ToolSearchCall {
            call_id, arguments, ..
        } => Some(ContextItem::ToolCall {
            call_id: call_id.clone(),
            name: "tool_search".into(),
            input: serialize_typed(arguments),
        }),
        ResponseItem::CustomToolCall {
            call_id,
            name,
            input,
            ..
        } => Some(ContextItem::ToolCall {
            call_id: Some(call_id.clone()),
            name: name.clone(),
            input: input.clone(),
        }),
        ResponseItem::CustomToolCallOutput {
            call_id,
            name,
            output,
            ..
        } => Some(ContextItem::ToolResult {
            call_id: Some(call_id.clone()),
            name: name.clone(),
            output: project_output(output),
        }),
        ResponseItem::ToolSearchOutput { call_id, tools, .. } => Some(ContextItem::ToolResult {
            call_id: call_id.clone(),
            name: Some("tool_search".into()),
            output: vec![ContextContent::Text {
                text: serialize_typed(tools),
            }],
        }),
        ResponseItem::WebSearchCall { action, .. } => Some(ContextItem::ToolCall {
            call_id: None,
            name: "web_search".into(),
            input: action.as_ref().map_or_else(|| "{}".into(), serialize_typed),
        }),
        ResponseItem::ImageGenerationCall {
            revised_prompt,
            result,
            ..
        } => Some(ContextItem::ToolResult {
            call_id: None,
            name: Some("image_generation".into()),
            output: [
                revised_prompt.as_ref().map(|prompt| ContextContent::Text {
                    text: prompt.clone(),
                }),
                Some(ContextContent::Image {
                    image_url: result.clone(),
                }),
            ]
            .into_iter()
            .flatten()
            .collect(),
        }),
        ResponseItem::Compaction { .. }
        | ResponseItem::CompactionTrigger {}
        | ResponseItem::ContextCompaction { .. } => Some(ContextItem::Compaction),
        ResponseItem::AdditionalTools { .. }
        | ResponseItem::Other(_)
        | ResponseItem::Message { .. }
        | ResponseItem::AgentMessage { .. }
        | ResponseItem::Reasoning { .. } => None,
    }
}

fn project_content(content: &ContentItem) -> ContextContent {
    match content {
        ContentItem::InputText { text } | ContentItem::OutputText { text, .. } => {
            ContextContent::Text { text: text.clone() }
        }
        ContentItem::InputImage { image_url, .. } => ContextContent::Image {
            image_url: image_url.clone(),
        },
        ContentItem::InputAudio { audio_url } => ContextContent::Audio {
            audio_url: audio_url.clone(),
        },
    }
}

fn project_agent_content(content: &AgentMessageContent) -> Option<ContextContent> {
    match content {
        AgentMessageContent::InputText { text } => {
            Some(ContextContent::Text { text: text.clone() })
        }
        AgentMessageContent::EncryptedContent { .. } => None,
    }
}

fn project_summary(summary: &ReasoningSummary) -> Box<str> {
    match summary {
        ReasoningSummary::SummaryText { text } => text.clone(),
    }
}

fn project_reasoning_content(content: &ReasoningContent) -> Box<str> {
    match content {
        ReasoningContent::ReasoningText { text } | ReasoningContent::Text { text } => text.clone(),
    }
}

fn project_output(output: &FunctionOutputBody) -> Vec<ContextContent> {
    match output {
        FunctionOutputBody::Text(text) => vec![ContextContent::Text { text: text.clone() }],
        FunctionOutputBody::Content(content) => {
            content.iter().filter_map(project_output_content).collect()
        }
    }
}

fn project_output_content(content: &FunctionOutputContent) -> Option<ContextContent> {
    match content {
        FunctionOutputContent::InputText { text } => {
            Some(ContextContent::Text { text: text.clone() })
        }
        FunctionOutputContent::InputImage { image_url, .. } => Some(ContextContent::Image {
            image_url: image_url.clone(),
        }),
        FunctionOutputContent::InputAudio { audio_url } => Some(ContextContent::Audio {
            audio_url: audio_url.clone(),
        }),
        FunctionOutputContent::EncryptedContent { .. } => None,
    }
}

fn serialize_typed(value: &impl Serialize) -> Box<str> {
    serde_json::to_string(value)
        .unwrap_or_else(|error| format!("failed to serialize context item: {error}"))
        .into_boxed_str()
}

#[cfg(test)]
mod tests {
    use nanocodex_core::{ContentItem, FunctionOutputBody, MessageRole, ResponseItem};

    use super::{ContextContent, ContextItem, project};

    #[test]
    fn projects_semantic_history_without_provider_ids() {
        let history = vec![
            ResponseItem::message(
                MessageRole::User,
                [ContentItem::InputText {
                    text: "question".into(),
                }],
            ),
            ResponseItem::FunctionCall {
                id: Some("fc_provider".into()),
                name: "lookup".into(),
                namespace: None,
                arguments: r#"{"key":"value"}"#.into(),
                call_id: "call_1".into(),
                caller: None,
                status: None,
                created_by: None,
                internal_chat_message_metadata_passthrough: None,
            },
            ResponseItem::function_call_output(
                "call_1".to_owned(),
                FunctionOutputBody::Text("result".into()),
            ),
            ResponseItem::compaction_trigger(),
        ];

        assert_eq!(
            project(&history),
            vec![
                ContextItem::Message {
                    role: MessageRole::User,
                    content: vec![ContextContent::Text {
                        text: "question".into(),
                    }],
                    phase: None,
                },
                ContextItem::ToolCall {
                    call_id: Some("call_1".into()),
                    name: "lookup".into(),
                    input: r#"{"key":"value"}"#.into(),
                },
                ContextItem::ToolResult {
                    call_id: Some("call_1".into()),
                    name: None,
                    output: vec![ContextContent::Text {
                        text: "result".into(),
                    }],
                },
                ContextItem::Compaction,
            ]
        );
    }
}
