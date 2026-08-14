use std::sync::Arc;

use async_trait::async_trait;
use nanocodex_oai_api::tools::ToolDefinition;
use rmcp::model::{PaginatedRequestParams, ReadResourceRequestParams};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::{Tool, ToolContext, ToolInput, ToolOutput, ToolResult};

use super::catalog::ProviderState;
use super::pagination::collect_paginated;

const LIST_RESOURCES_DESCRIPTION: &str = "Lists resources provided by MCP servers. Resources allow servers to share data that provides context to language models, such as files, database schemas, or application-specific information. Prefer resources over web search when possible.";
const LIST_RESOURCE_TEMPLATES_DESCRIPTION: &str = "Lists resource templates provided by MCP servers. Parameterized resource templates allow servers to share data that takes parameters and provides context to language models, such as files, database schemas, or application-specific information. Prefer resource templates over web search when possible.";
const READ_RESOURCE_DESCRIPTION: &str =
    "Read a specific resource from an MCP server given the server name and resource URI.";

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct ListInput {
    #[serde(default)]
    server: Option<String>,
    #[serde(default)]
    cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadInput {
    server: String,
    uri: String,
}

pub(super) struct ListMcpResources {
    state: Arc<ProviderState>,
}

impl ListMcpResources {
    pub(super) const fn new(state: Arc<ProviderState>) -> Self {
        Self { state }
    }
}

pub(super) struct ListMcpResourceTemplates {
    state: Arc<ProviderState>,
}

impl ListMcpResourceTemplates {
    pub(super) const fn new(state: Arc<ProviderState>) -> Self {
        Self { state }
    }
}

pub(super) struct ReadMcpResource {
    state: Arc<ProviderState>,
}

impl ReadMcpResource {
    pub(super) const fn new(state: Arc<ProviderState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl Tool for ListMcpResources {
    fn definition(&self) -> ToolDefinition {
        list_definition(
            "list_mcp_resources",
            LIST_RESOURCES_DESCRIPTION,
            "resources",
        )
    }

    fn supports_parallel_tool_calls(&self) -> bool {
        true
    }

    async fn execute(&self, input: ToolInput, _context: ToolContext<'_>) -> ToolResult {
        let input = input.decode_json::<ListInput>()?;
        let value = list_resources(&self.state, input).await?;
        Ok(ToolOutput::json(&value))
    }
}

#[async_trait]
impl Tool for ListMcpResourceTemplates {
    fn definition(&self) -> ToolDefinition {
        list_definition(
            "list_mcp_resource_templates",
            LIST_RESOURCE_TEMPLATES_DESCRIPTION,
            "resource templates",
        )
    }

    fn supports_parallel_tool_calls(&self) -> bool {
        true
    }

    async fn execute(&self, input: ToolInput, _context: ToolContext<'_>) -> ToolResult {
        let input = input.decode_json::<ListInput>()?;
        let value = list_resource_templates(&self.state, input).await?;
        Ok(ToolOutput::json(&value))
    }
}

#[async_trait]
impl Tool for ReadMcpResource {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::function(
            "read_mcp_resource",
            READ_RESOURCE_DESCRIPTION,
            json!({
                "type": "object",
                "properties": {
                    "server": {
                        "type": "string",
                        "description": "MCP server name exactly as configured. Must match the 'server' field returned by list_mcp_resources."
                    },
                    "uri": {
                        "type": "string",
                        "description": "Resource URI to read. Must be one of the URIs returned by list_mcp_resources."
                    }
                },
                "required": ["server", "uri"],
                "additionalProperties": false
            }),
        )
    }

    fn supports_parallel_tool_calls(&self) -> bool {
        true
    }

    async fn execute(&self, input: ToolInput, _context: ToolContext<'_>) -> ToolResult {
        let input = input.decode_json::<ReadInput>()?;
        let server = required("server", input.server)?;
        let uri = required("uri", input.uri)?;
        let client = self.state.client(&server).await?;
        let result = client
            .read_resource(ReadResourceRequestParams::new(&uri))
            .await?;
        let mut value = serde_json::to_value(result)?;
        let object = value
            .as_object_mut()
            .ok_or("MCP resources/read returned a non-object result")?;
        object.insert("server".to_owned(), Value::String(server));
        object.insert("uri".to_owned(), Value::String(uri));
        Ok(ToolOutput::json(&value))
    }
}

fn list_definition(name: &str, description: &str, noun: &str) -> ToolDefinition {
    ToolDefinition::function(
        name,
        description,
        json!({
            "type": "object",
            "properties": {
                "cursor": {
                    "type": "string",
                    "description": format!("Opaque cursor from a previous {name} call; omit for the first page.")
                },
                "server": {
                    "type": "string",
                    "description": format!("MCP server name. Omit to list {noun} from every configured server.")
                }
            },
            "additionalProperties": false
        }),
    )
}

async fn list_resources(state: &ProviderState, input: ListInput) -> Result<Value, String> {
    let cursor = normalized(input.cursor);
    if let Some(server) = normalized(input.server) {
        let params =
            cursor.map(|cursor| PaginatedRequestParams::default().with_cursor(Some(cursor)));
        let result = state
            .client(&server)
            .await?
            .list_resources(params)
            .await
            .map_err(|error| format!("resources/list failed: {error}"))?;
        let resources = with_server(result.resources, &server)?;
        let mut payload = json!({ "server": server, "resources": resources });
        if let Some(next_cursor) = result.next_cursor {
            payload["nextCursor"] = Value::String(next_cursor);
        }
        return Ok(payload);
    }
    if cursor.is_some() {
        return Err("cursor can only be used when a server is specified".to_owned());
    }
    let mut resources = Vec::new();
    for (server, client) in state.clients().await {
        let pages = collect_paginated("resources/list", |params| {
            let client = Arc::clone(&client);
            async move {
                let result = client.list_resources(params).await?;
                Ok((result.resources, result.next_cursor))
            }
        })
        .await;
        match pages {
            Ok(items) => resources.extend(with_server(items, &server)?),
            Err(error) => tracing::warn!(%error, %server, "failed to list MCP resources"),
        }
    }
    Ok(json!({ "resources": resources }))
}

async fn list_resource_templates(state: &ProviderState, input: ListInput) -> Result<Value, String> {
    let cursor = normalized(input.cursor);
    if let Some(server) = normalized(input.server) {
        let params =
            cursor.map(|cursor| PaginatedRequestParams::default().with_cursor(Some(cursor)));
        let result = state
            .client(&server)
            .await?
            .list_resource_templates(params)
            .await
            .map_err(|error| format!("resources/templates/list failed: {error}"))?;
        let templates = with_server(result.resource_templates, &server)?;
        let mut payload = json!({ "server": server, "resourceTemplates": templates });
        if let Some(next_cursor) = result.next_cursor {
            payload["nextCursor"] = Value::String(next_cursor);
        }
        return Ok(payload);
    }
    if cursor.is_some() {
        return Err("cursor can only be used when a server is specified".to_owned());
    }
    let mut templates = Vec::new();
    for (server, client) in state.clients().await {
        let pages = collect_paginated("resources/templates/list", |params| {
            let client = Arc::clone(&client);
            async move {
                let result = client.list_resource_templates(params).await?;
                Ok((result.resource_templates, result.next_cursor))
            }
        })
        .await;
        match pages {
            Ok(items) => templates.extend(with_server(items, &server)?),
            Err(error) => {
                tracing::warn!(%error, %server, "failed to list MCP resource templates");
            }
        }
    }
    Ok(json!({ "resourceTemplates": templates }))
}

fn with_server<T: serde::Serialize>(items: Vec<T>, server: &str) -> Result<Vec<Value>, String> {
    items
        .into_iter()
        .map(|item| {
            let value = serde_json::to_value(item).map_err(|error| error.to_string())?;
            let Value::Object(mut object) = value else {
                return Err("MCP resource entry was not an object".to_owned());
            };
            let mut tagged = Map::new();
            tagged.insert("server".to_owned(), Value::String(server.to_owned()));
            tagged.append(&mut object);
            Ok(Value::Object(tagged))
        })
        .collect()
}

fn normalized(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_owned())
    })
}

fn required(name: &str, value: String) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        Err(format!("{name} must not be empty"))
    } else {
        Ok(value.to_owned())
    }
}
