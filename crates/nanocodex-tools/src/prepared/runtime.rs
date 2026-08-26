use std::{any::Any, panic::AssertUnwindSafe, sync::Arc};

use futures_util::FutureExt;
use nanocodex_oai_api::tools::ToolOutputWire;
use serde::Serialize;
use serde_json::{Value, value::to_raw_value};
use sha2::{Digest, Sha256};
use tracing::Instrument;

use super::PreparedTools;
use crate::{Tool, ToolContext, ToolDefinition, ToolInput, ToolOutput};

const CATALOG_DIGEST_DOMAIN: &[u8] = b"nanocodex-tools-catalog-v1\0";
const HOSTED_TOOL_CALL_TIMEOUT_MS: u64 = 120_000;

enum PreparedToolHandler {
    Fixed(Arc<dyn Tool>),
    #[cfg(feature = "native")]
    Mcp(crate::mcp::PreparedMcpTool),
    #[cfg(feature = "workspace-runtime")]
    Workspace(Arc<crate::workspace_runtime::WorkspaceToolRuntime>),
}

enum PreparedToolInput {
    Contract(ToolInput),
    #[cfg(feature = "native")]
    Mcp(Value),
}

pub(crate) struct PreparedToolEntry {
    provider: Box<str>,
    remote_name: Box<str>,
    definition: ToolDefinition,
    supports_parallel_tool_calls: bool,
    timeout_ms: u64,
    // Reserved locally until effect-domain semantics have a protocol contract.
    // It must never cause this executor to be replicated.
    _effect_domain: Option<Box<str>>,
    handler: PreparedToolHandler,
}

impl PreparedToolEntry {
    pub(crate) fn fixed(
        definition: ToolDefinition,
        supports_parallel_tool_calls: bool,
        tool: Arc<dyn Tool>,
    ) -> Self {
        let remote_name = definition.name().into();
        Self {
            provider: "fixed".into(),
            remote_name,
            definition,
            supports_parallel_tool_calls,
            timeout_ms: HOSTED_TOOL_CALL_TIMEOUT_MS,
            _effect_domain: None,
            handler: PreparedToolHandler::Fixed(tool),
        }
    }

    #[cfg(feature = "workspace-runtime")]
    pub(crate) fn workspace(
        definition: ToolDefinition,
        workspace: Arc<crate::workspace_runtime::WorkspaceToolRuntime>,
    ) -> Self {
        let remote_name = definition.name().into();
        Self {
            provider: "workspace".into(),
            remote_name,
            definition,
            supports_parallel_tool_calls: false,
            timeout_ms: HOSTED_TOOL_CALL_TIMEOUT_MS,
            _effect_domain: None,
            handler: PreparedToolHandler::Workspace(workspace),
        }
    }

    #[cfg(feature = "native")]
    pub(crate) fn mcp(tool: crate::mcp::PreparedMcpTool) -> Self {
        Self {
            provider: tool.provider().into(),
            remote_name: tool.remote_name().into(),
            definition: tool.definition().clone(),
            supports_parallel_tool_calls: tool.supports_parallel_tool_calls(),
            timeout_ms: u64::try_from(tool.timeout().as_millis()).unwrap_or(u64::MAX),
            _effect_domain: None,
            handler: PreparedToolHandler::Mcp(tool),
        }
    }

    pub(crate) const fn definition(&self) -> &ToolDefinition {
        &self.definition
    }
}

/// Exact language-neutral definition published by an attachment.
#[doc(hidden)]
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum PreparedToolDefinition {
    /// JSON-schema function tool.
    Function {
        name: Box<str>,
        description: Box<str>,
        strict: bool,
        parameters: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        output_schema: Option<Value>,
    },
    /// Grammar-constrained free-form custom tool.
    Custom {
        name: Box<str>,
        description: Box<str>,
        format: PreparedCustomToolFormat,
    },
}

#[cfg(test)]
impl PreparedToolDefinition {
    /// Returns the model-visible tool name.
    #[must_use]
    pub fn name(&self) -> &str {
        match self {
            Self::Function { name, .. } | Self::Custom { name, .. } => name,
        }
    }

    /// Returns the model-visible tool description.
    #[must_use]
    pub fn description(&self) -> &str {
        match self {
            Self::Function { description, .. } | Self::Custom { description, .. } => description,
        }
    }

    /// Returns the exact client-owned function output schema.
    #[must_use]
    pub const fn output_schema(&self) -> Option<&Value> {
        match self {
            Self::Function { output_schema, .. } => output_schema.as_ref(),
            Self::Custom { .. } => None,
        }
    }

    /// Returns the exact custom-tool grammar format.
    #[must_use]
    pub const fn format(&self) -> Option<&PreparedCustomToolFormat> {
        match self {
            Self::Function { .. } => None,
            Self::Custom { format, .. } => Some(format),
        }
    }
}

/// Exact language-neutral custom-tool grammar format.
#[doc(hidden)]
#[derive(Clone, Debug, Serialize)]
pub(crate) struct PreparedCustomToolFormat {
    #[serde(rename = "type")]
    kind: &'static str,
    syntax: Box<str>,
    definition: Box<str>,
}

#[cfg(test)]
impl PreparedCustomToolFormat {
    /// Returns the grammar syntax, such as `lark`.
    #[must_use]
    pub fn syntax(&self) -> &str {
        &self.syntax
    }

    /// Returns the complete grammar definition.
    #[must_use]
    pub fn definition(&self) -> &str {
        &self.definition
    }
}

/// Immutable language-neutral attachment catalog entry.
#[doc(hidden)]
#[derive(Clone, Debug, Serialize)]
pub(crate) struct PreparedToolCatalogEntry {
    provider: Box<str>,
    remote_name: Box<str>,
    definition: PreparedToolDefinition,
    parallel_safe: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<Box<str>>,
    timeout_ms: u64,
}

#[cfg(test)]
impl PreparedToolCatalogEntry {
    /// Returns the canonical provider identity.
    #[must_use]
    pub fn provider(&self) -> &str {
        &self.provider
    }

    /// Returns the provider-owned tool identity.
    #[must_use]
    pub fn remote_name(&self) -> &str {
        &self.remote_name
    }

    /// Returns the exact exported language-neutral definition.
    #[must_use]
    pub const fn definition(&self) -> &PreparedToolDefinition {
        &self.definition
    }

    /// Returns whether this exact handler explicitly permits parallel calls.
    #[must_use]
    pub const fn parallel_safe(&self) -> bool {
        self.parallel_safe
    }

    /// Returns the stable deferred-discovery summary, when present.
    #[must_use]
    pub fn summary(&self) -> Option<&str> {
        self.summary.as_deref()
    }

    /// Returns the bounded call timeout in milliseconds.
    #[must_use]
    pub const fn timeout_ms(&self) -> u64 {
        self.timeout_ms
    }
}

/// Complete immutable catalog snapshot and its canonical identity.
#[doc(hidden)]
#[derive(Debug)]
pub(crate) struct PreparedToolCatalog {
    entries: Vec<PreparedToolCatalogEntry>,
    #[cfg(test)]
    canonical_json: String,
    digest: String,
}

impl PreparedToolCatalog {
    /// Returns the catalog entries in stable name order.
    #[must_use]
    pub(crate) fn entries(&self) -> &[PreparedToolCatalogEntry] {
        &self.entries
    }

    #[cfg(test)]
    /// Returns canonical compact JSON with recursively Unicode-scalar-sorted keys.
    #[must_use]
    pub(crate) fn canonical_json(&self) -> &str {
        &self.canonical_json
    }

    /// Returns the lowercase domain-separated SHA-256 catalog digest.
    #[must_use]
    pub(crate) fn digest(&self) -> &str {
        &self.digest
    }
}

/// Owned invocation accepted by the private prepared runtime.
#[doc(hidden)]
pub(crate) struct PreparedToolCall {
    model: String,
    session_id: String,
    call_id: String,
    name: String,
    input: Value,
    output_token_budget: usize,
}

impl PreparedToolCall {
    /// Creates a complete host-side invocation without conversation history.
    #[must_use]
    pub fn new(
        model: impl Into<String>,
        session_id: impl Into<String>,
        call_id: impl Into<String>,
        name: impl Into<String>,
        input: Value,
        output_token_budget: usize,
    ) -> Self {
        Self {
            model: model.into(),
            session_id: session_id.into(),
            call_id: call_id.into(),
            name: name.into(),
            input,
            output_token_budget,
        }
    }
}

/// Transport-independent execution owner for one immutable Tools recipe.
#[doc(hidden)]
pub(crate) struct PreparedToolRuntime {
    entries: Vec<PreparedToolEntry>,
    #[cfg(feature = "workspace-runtime")]
    workspaces: Vec<Arc<crate::workspace_runtime::WorkspaceToolRuntime>>,
}

impl PreparedToolRuntime {
    /// Starts native providers, awaits discovery, and captures one immutable execution snapshot.
    ///
    /// # Errors
    ///
    /// Returns an error when MCP discovery fails or the resulting complete catalog is invalid.
    pub async fn initialize(tools: PreparedTools) -> Result<Self, PreparedToolError> {
        let PreparedTools {
            mut entries,
            #[cfg(feature = "native")]
            mcps,
            #[cfg(feature = "workspace-runtime")]
            workspaces,
        } = tools;
        #[cfg(feature = "native")]
        for mcp in mcps {
            let tools = mcp
                .prepared_snapshot(std::time::Duration::from_millis(
                    HOSTED_TOOL_CALL_TIMEOUT_MS,
                ))
                .await
                .map_err(PreparedToolError::McpInitialization)?;
            entries.extend(tools.into_iter().map(PreparedToolEntry::mcp));
        }
        entries.sort_by(|left, right| left.definition().name().cmp(right.definition().name()));
        for pair in entries.windows(2) {
            if pair[0].definition().name() == pair[1].definition().name() {
                return Err(PreparedToolError::DuplicateTool(
                    pair[0].definition().name().into(),
                ));
            }
        }
        Ok(Self {
            entries,
            #[cfg(feature = "workspace-runtime")]
            workspaces,
        })
    }

    pub(crate) fn timeout_ms(&self, name: &str) -> Option<u64> {
        self.entries
            .iter()
            .find(|entry| entry.definition.name() == name)
            .map(|entry| entry.timeout_ms)
    }

    /// Returns one complete immutable language-neutral catalog snapshot.
    ///
    /// # Errors
    ///
    /// Returns an error when the catalog cannot be encoded as canonical JSON.
    pub fn catalog(&self) -> Result<PreparedToolCatalog, PreparedToolError> {
        let entries = self
            .entries
            .iter()
            .map(catalog_entry)
            .collect::<Result<Vec<_>, _>>()?;
        let canonical_json = canonical_json(&entries)?;
        let digest = catalog_digest(&canonical_json);
        Ok(PreparedToolCatalog {
            entries,
            #[cfg(test)]
            canonical_json,
            digest,
        })
    }

    /// Executes one invocation against the exact immutable catalog entry.
    ///
    /// # Errors
    ///
    /// Returns an error for an unknown name, an input shape that contradicts
    /// the published definition, or an output that cannot enter the wire form.
    pub async fn execute(
        &self,
        call: PreparedToolCall,
    ) -> Result<ToolOutputWire, PreparedToolError> {
        let entry = self
            .entries
            .iter()
            .find(|entry| entry.definition.name() == call.name)
            .ok_or_else(|| PreparedToolError::UnknownTool(call.name.clone().into()))?;
        let input_content = tracing::enabled!(
            target: "nanocodex_tools",
            tracing::Level::INFO
        )
        .then(|| serde_json::to_string(&call.input))
        .transpose()
        .map_err(PreparedToolError::InvalidOutput)?;
        let input = match &entry.handler {
            #[cfg(feature = "native")]
            PreparedToolHandler::Mcp(_) => {
                if !call.input.is_object() {
                    return Err(PreparedToolError::InvalidInput {
                        name: call.name.into(),
                        expected: "an object",
                    });
                }
                PreparedToolInput::Mcp(call.input)
            }
            _ => PreparedToolInput::Contract(input_for_definition(&entry.definition, call.input)?),
        };
        let context = ToolContext::new(
            &call.model,
            &call.session_id,
            &call.call_id,
            &[],
            call.output_token_budget,
        );
        let started_at = std::time::Instant::now();
        let span = tracing::info_span!(
            target: "nanocodex_tools",
            "attached_tool.execute",
            tool.name = call.name,
            session.id = call.session_id,
            tool.call_id = call.call_id,
            status = tracing::field::Empty,
            duration_ns = tracing::field::Empty,
        );
        if let Some(input_content) = &input_content {
            tracing::event!(
                target: "nanocodex_tools",
                parent: &span,
                tracing::Level::INFO,
                name = "tool.arguments",
                content = %input_content,
                "tool content"
            );
        }
        let dispatch = async {
            match (&entry.handler, input) {
                (PreparedToolHandler::Fixed(tool), PreparedToolInput::Contract(input)) => tool
                    .execute(input, context)
                    .await
                    .unwrap_or_else(|error| ToolOutput::error(error.to_string())),
                #[cfg(feature = "native")]
                (PreparedToolHandler::Mcp(tool), PreparedToolInput::Mcp(input)) => {
                    tool.execute(input).await
                }
                #[cfg(feature = "workspace-runtime")]
                (PreparedToolHandler::Workspace(workspace), PreparedToolInput::Contract(input)) => {
                    workspace.execute_tool(&call.name, input, context).await
                }
                #[cfg(feature = "native")]
                _ => ToolOutput::error("invalid attached tool input routing"),
            }
        }
        .instrument(span.clone());
        let output = match AssertUnwindSafe(dispatch).catch_unwind().await {
            Ok(output) => output,
            Err(payload) => {
                let message = panic_message(payload);
                tracing::event!(
                    target: "nanocodex_tools",
                    parent: &span,
                    tracing::Level::INFO,
                    name = "tool.panic",
                    content = %message,
                    "tool content"
                );
                ToolOutput::error("aborted")
            }
        };
        let wire = output
            .into_wire()
            .map_err(PreparedToolError::InvalidOutput)?;
        span.record("status", if wire.success { "completed" } else { "failed" });
        span.record(
            "duration_ns",
            u64::try_from(started_at.elapsed().as_nanos()).unwrap_or(u64::MAX),
        );
        if tracing::enabled!(target: "nanocodex_tools", tracing::Level::INFO) {
            let output_content =
                serde_json::to_string(&wire).map_err(PreparedToolError::InvalidOutput)?;
            tracing::event!(
                target: "nanocodex_tools",
                parent: &span,
                tracing::Level::INFO,
                name = "tool.output",
                content = %output_content,
                "tool content"
            );
        }
        Ok(wire)
    }

    /// Terminates retained workspace subprocesses owned by this runtime.
    pub async fn shutdown(&self) {
        #[cfg(feature = "workspace-runtime")]
        for workspace in &self.workspaces {
            workspace.control().cancel().await;
        }
    }
}

fn catalog_entry(entry: &PreparedToolEntry) -> Result<PreparedToolCatalogEntry, PreparedToolError> {
    let definition = match &entry.definition {
        ToolDefinition::Function {
            name,
            description,
            strict,
            parameters,
            output_schema,
            ..
        } => PreparedToolDefinition::Function {
            name: name.clone(),
            description: description.clone(),
            strict: *strict,
            parameters: parameters.as_value().clone(),
            output_schema: output_schema
                .as_ref()
                .map(|schema| schema.as_value().clone()),
        },
        ToolDefinition::Custom {
            name,
            description,
            format,
            ..
        } => PreparedToolDefinition::Custom {
            name: name.clone(),
            description: description.clone(),
            format: PreparedCustomToolFormat {
                kind: "grammar",
                syntax: format.syntax.clone(),
                definition: format.definition.clone(),
            },
        },
        definition => {
            return Err(PreparedToolError::UnsupportedDefinition(
                definition.name().into(),
            ));
        }
    };
    Ok(PreparedToolCatalogEntry {
        provider: entry.provider.clone(),
        remote_name: entry.remote_name.clone(),
        definition,
        parallel_safe: entry.supports_parallel_tool_calls,
        summary: None,
        timeout_ms: entry.timeout_ms,
    })
}

pub(super) fn canonical_json<T: Serialize>(value: &T) -> Result<String, PreparedToolError> {
    let value = serde_json::to_value(value).map_err(PreparedToolError::CatalogEncoding)?;
    let mut encoded = String::new();
    write_canonical_value(&value, &mut encoded)?;
    Ok(encoded)
}

fn write_canonical_value(value: &Value, encoded: &mut String) -> Result<(), PreparedToolError> {
    match value {
        Value::Null => encoded.push_str("null"),
        Value::Bool(value) => encoded.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => {
            let value = value.as_f64().ok_or_else(|| {
                PreparedToolError::UnsupportedCatalogNumber(value.to_string().into())
            })?;
            encoded.push_str(ryu_js::Buffer::new().format_finite(value));
        }
        Value::String(value) => encoded
            .push_str(&serde_json::to_string(value).map_err(PreparedToolError::CatalogEncoding)?),
        Value::Array(values) => {
            encoded.push('[');
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    encoded.push(',');
                }
                write_canonical_value(value, encoded)?;
            }
            encoded.push(']');
        }
        Value::Object(values) => {
            let mut values = values.iter().collect::<Vec<_>>();
            values.sort_by(|(left, _), (right, _)| left.chars().cmp(right.chars()));
            encoded.push('{');
            for (index, (key, value)) in values.into_iter().enumerate() {
                if index != 0 {
                    encoded.push(',');
                }
                encoded.push_str(
                    &serde_json::to_string(key).map_err(PreparedToolError::CatalogEncoding)?,
                );
                encoded.push(':');
                write_canonical_value(value, encoded)?;
            }
            encoded.push('}');
        }
    }
    Ok(())
}

fn catalog_digest(canonical_json: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(CATALOG_DIGEST_DOMAIN);
    hasher.update(canonical_json.as_bytes());
    let mut encoded = String::with_capacity(64);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in hasher.finalize() {
        encoded.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    encoded
}

fn panic_message(payload: Box<dyn Any + Send>) -> String {
    match payload.downcast::<String>() {
        Ok(message) => *message,
        Err(payload) => payload.downcast::<&'static str>().map_or_else(
            |_| "non-string panic payload".to_owned(),
            |message| (*message).to_owned(),
        ),
    }
}

fn input_for_definition(
    definition: &ToolDefinition,
    input: Value,
) -> Result<ToolInput, PreparedToolError> {
    match definition {
        ToolDefinition::Function { name, .. } if !input.is_object() => {
            Err(PreparedToolError::InvalidInput {
                name: name.clone(),
                expected: "an object",
            })
        }
        ToolDefinition::Function { .. } => to_raw_value(&input)
            .map(ToolInput::Function)
            .map_err(PreparedToolError::InvalidOutput),
        ToolDefinition::Custom { name, .. } => input
            .as_str()
            .map(|input| ToolInput::Freeform(input.to_owned()))
            .ok_or_else(|| PreparedToolError::InvalidInput {
                name: name.clone(),
                expected: "a string",
            }),
        ToolDefinition::Namespace { name, .. } => {
            Err(PreparedToolError::UnsupportedDefinition(name.clone()))
        }
        ToolDefinition::ToolSearch { .. } => Err(PreparedToolError::UnsupportedDefinition(
            "tool_search".into(),
        )),
    }
}

/// Failed prepared-tool invocation contract.
#[doc(hidden)]
#[derive(Debug, thiserror::Error)]
pub(crate) enum PreparedToolError {
    /// A selected local tool has no pinned attachment executor.
    #[error("tool selection is not attachable: {0}")]
    NonAttachable(Box<str>),
    /// Two static or discovered tools produced the same canonical name.
    #[error("attached tool name `{0}` is present more than once after discovery")]
    DuplicateTool(Box<str>),
    /// A configured native MCP provider failed initial connection or discovery.
    #[cfg(feature = "native")]
    #[error("failed to initialize attached MCP: {0}")]
    McpInitialization(String),
    /// The immutable catalog does not contain this tool.
    #[error("unknown attached tool `{0}`")]
    UnknownTool(Box<str>),
    /// The input shape contradicted the published definition.
    #[error("attached tool `{name}` requires {expected} input")]
    InvalidInput {
        /// Published tool name.
        name: Box<str>,
        /// Required JSON shape.
        expected: &'static str,
    },
    /// The selected catalog entry is not executable.
    #[error("attached tool `{0}` has a non-executable definition")]
    UnsupportedDefinition(Box<str>),
    /// The immutable catalog could not enter its canonical JSON wire form.
    #[error("failed to encode attached tool catalog: {0}")]
    CatalogEncoding(#[source] serde_json::Error),
    /// A catalog number could not be represented as an ECMAScript number.
    #[error("attached tool catalog contains an unsupported number: {0}")]
    UnsupportedCatalogNumber(Box<str>),
    /// The completed output could not enter the lossless wire form.
    #[error("failed to encode attached tool output: {0}")]
    InvalidOutput(#[source] serde_json::Error),
}
