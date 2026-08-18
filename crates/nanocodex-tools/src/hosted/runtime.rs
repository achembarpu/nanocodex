use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{Arc, RwLock},
};

use nanocodex_oai_api::{
    responses::CustomToolFormat,
    tools::{ToolContext, ToolDefinition, ToolInput, ToolOutput, ToolOutputBody},
};

use super::{
    CodeModeExecution, CodeModeHost, CodeModeNotification, CodeModeObserver, CodeModeUpdate,
    HostedToolMode, NestedToolCall, OwnedToolContext,
};
use crate::runtime_config::{ImageGenerationConfig, WebSearchConfig};

const EXEC_GRAMMAR: &str = r"start: /[\s\S]+/";
const EXEC_DESCRIPTION: &str = r"Run JavaScript in the embedded host.
- `tools` contains the application-defined async tools listed below.
- `text(value)` and `image(value)` append output for the model.
- `generatedImage(result)` appends an image-generation result for the model.
- `store(key, value)` and `load(key)` retain serializable values across calls.
- JavaScript runs inside the Node or browser host supplied by the embedding application.";
const DEFERRED_TOOLS_DESCRIPTION: &str = r"Some deferred nested tools are omitted from this description. They remain available on the global `tools` object and are listed in `ALL_TOOLS`. Use `tool_search` to discover remote tools before calling them.";

/// Tool selection backed by an embedding [`CodeModeHost`].
#[derive(Clone, Default)]
pub struct HostedTools {
    host: Option<Arc<dyn CodeModeHost>>,
}

impl HostedTools {
    /// Selects an application-owned Code Mode host.
    #[must_use]
    pub fn new(host: impl CodeModeHost) -> Self {
        Self {
            host: Some(Arc::new(host)),
        }
    }

    /// Returns `false`; direct web search belongs to the embedding host.
    #[must_use]
    pub const fn web_search_enabled(&self) -> bool {
        false
    }

    /// Returns `false`; direct image generation belongs to the embedding host.
    #[must_use]
    pub const fn image_generation_enabled(&self) -> bool {
        false
    }

    /// Returns this hosted tool selection bound to one agent session.
    ///
    /// Hosted tool discovery and execution receive the session ID directly, so
    /// there is no Rust-owned subprocess environment to update here.
    #[must_use]
    pub const fn for_session(self, _session_id: &str) -> Self {
        self
    }

    /// Starts dynamic tool discovery.
    ///
    /// The embedding host owns discovery, so hosted selections have no
    /// background providers to start.
    pub const fn start_providers(&self) {}
}

/// Stateful Code Mode adapter over an application-owned host.
pub struct HostedToolRuntime {
    working_directory: Arc<str>,
    host: Option<Arc<dyn CodeModeHost>>,
    callable_tool_names: RwLock<HashSet<String>>,
}

/// Cancellation handle for a hosted runtime.
///
/// A host call is cancelled by dropping its future. This handle exists so the
/// hosted runtime can satisfy the same lifecycle contract as the native
/// runtime.
#[derive(Clone, Copy)]
pub struct HostedToolRuntimeControl;

impl HostedToolRuntime {
    /// Creates a runtime without an application host.
    ///
    /// Calls return a model-visible failure until [`Self::with_tools`] supplies
    /// a [`HostedTools`] value containing a host. HTTP tool configurations are
    /// accepted for parity with the native runtime and ignored.
    pub fn new(
        workspace: impl Into<PathBuf>,
        _web_search: Option<WebSearchConfig>,
        _image_generation: Option<ImageGenerationConfig>,
    ) -> Self {
        let workspace = workspace.into();
        Self {
            working_directory: Arc::from(workspace.to_string_lossy().into_owned()),
            host: None,
            callable_tool_names: RwLock::new(HashSet::new()),
        }
    }

    /// Builds a runtime from one complete hosted tool selection.
    #[must_use]
    pub fn new_with_tools(
        workspace: impl Into<PathBuf>,
        web_search: Option<WebSearchConfig>,
        image_generation: Option<ImageGenerationConfig>,
        tools: &HostedTools,
    ) -> Self {
        Self::new(workspace, web_search, image_generation).with_tools(tools)
    }

    /// Applies an embedding host to this runtime.
    #[must_use]
    pub fn with_tools(mut self, tools: &HostedTools) -> Self {
        self.host.clone_from(&tools.host);
        self
    }

    /// Returns the fixed model-visible runtime name.
    #[must_use]
    pub const fn default_shell_name(&self) -> &'static str {
        "javascript"
    }

    /// Returns the model-visible working directory supplied at construction.
    #[must_use]
    pub fn working_directory(&self) -> &str {
        &self.working_directory
    }

    /// Returns a cancellation handle for the runtime.
    #[must_use]
    pub const fn control(&self) -> HostedToolRuntimeControl {
        HostedToolRuntimeControl
    }

    /// Builds the `exec` definition from the host's current tool definitions.
    #[must_use]
    pub fn model_specs(&self, session_id: &str) -> Vec<ToolDefinition> {
        self.model_contract(session_id).0
    }

    pub(crate) fn model_contract(
        &self,
        session_id: &str,
    ) -> (Vec<ToolDefinition>, Vec<(String, String)>) {
        let mode = self
            .host
            .as_ref()
            .map_or(HostedToolMode::Code, |host| host.tool_mode());
        let mut definitions = self.host.as_ref().map_or_else(Vec::new, |host| {
            match host.tool_definitions(session_id) {
                Ok(definitions) => definitions,
                Err(error) => {
                    tracing::warn!(
                        target: "nanocodex_tools",
                        %error,
                        "hosted Code Mode tool discovery failed"
                    );
                    Vec::new()
                }
            }
        });
        crate::code_mode_order::sort_definitions(&mut definitions);
        if let Ok(mut names) = self.callable_tool_names.write() {
            names.clear();
            names.extend(
                definitions
                    .iter()
                    .map(|definition| definition.name().to_owned()),
            );
        } else {
            tracing::warn!(
                target: "nanocodex_tools",
                "hosted callable-tool registry lock was poisoned"
            );
        }
        if mode == HostedToolMode::Direct {
            return (definitions, Vec::new());
        }
        let (mut direct_definitions, code_mode_definitions): (Vec<_>, Vec<_>) =
            definitions.into_iter().partition(|definition| {
                matches!(definition, ToolDefinition::ToolSearch { .. })
                    || is_standard_workspace_tool(definition.name())
            });
        crate::code_mode_order::sort_direct_definitions(&mut direct_definitions);
        let code_mode_tool_names = code_mode_definitions
            .iter()
            .map(|definition| {
                (
                    normalize_identifier(definition.name()),
                    definition.name().to_owned(),
                )
            })
            .collect();
        let mut description = EXEC_DESCRIPTION.to_owned();
        let mut has_deferred_tools = false;
        for definition in code_mode_definitions {
            if matches!(
                definition,
                ToolDefinition::Function {
                    defer_loading: Some(true),
                    ..
                } | ToolDefinition::Custom {
                    defer_loading: Some(true),
                    ..
                }
            ) {
                has_deferred_tools = true;
                continue;
            }
            description.push_str("\n\n- `tools.");
            description.push_str(definition.name());
            description.push_str("`: ");
            description.push_str(definition.description().trim());
        }
        if has_deferred_tools {
            description.push_str("\n\n");
            description.push_str(DEFERRED_TOOLS_DESCRIPTION);
        }
        let mut model_definitions = vec![ToolDefinition::custom(
            "exec",
            description,
            CustomToolFormat::grammar("lark", EXEC_GRAMMAR),
        )];
        model_definitions.extend(direct_definitions);
        (model_definitions, code_mode_tool_names)
    }

    /// Returns `false`; hosted definitions execute inside one Code Mode cell.
    ///
    /// The embedding host owns any concurrency policy below that cell.
    #[must_use]
    pub const fn supports_parallel_tool_calls(&self, _name: &str) -> bool {
        false
    }

    /// Returns whether the embedding host registered a callable definition.
    ///
    /// Deferred exposure controls model-visible schemas, not dispatch. This
    /// matches the native and Codex runtimes: a tool loaded by `tool_search`
    /// remains registered even though its schema was omitted from the initial
    /// request.
    #[must_use]
    pub fn contains(&self, name: &str) -> bool {
        self.host.as_ref().is_some_and(|_| {
            self.callable_tool_names
                .read()
                .is_ok_and(|names| names.contains(name))
        })
    }

    /// Dispatches a direct hosted definition or returns a model-visible failure.
    #[allow(
        clippy::unused_async,
        reason = "matches the native tool-runtime contract"
    )]
    pub async fn execute_tool(
        &self,
        name: &str,
        input: ToolInput,
        context: ToolContext<'_>,
    ) -> ToolOutput {
        let Some(host) = &self.host else {
            return ToolOutput::error("no hosted tool adapter is configured");
        };
        if !self.contains(name) {
            return ToolOutput::error(format!("direct hosted tool `{name}` is unavailable"));
        }
        match host.execute_tool(name, input, context).await {
            Ok(output) => output,
            Err(error) => ToolOutput::error(error.to_string()),
        }
    }

    /// Executes one Code Mode cell through the embedding host.
    pub async fn execute_code(&self, source: &str, context: ToolContext<'_>) -> CodeModeExecution {
        let Some(host) = &self.host else {
            return failed("no hosted Code Mode adapter is configured");
        };
        match host.execute(source, context).await {
            Ok(execution) => execution,
            Err(error) => failed(&error.to_string()),
        }
    }

    /// Executes Code Mode from independently owned invocation state.
    pub async fn execute_code_owned(
        &self,
        source: &str,
        context: OwnedToolContext,
    ) -> CodeModeExecution {
        self.execute_code(source, context.as_context()).await
    }

    /// Executes Code Mode and replays its nested calls to an observer.
    pub async fn execute_code_owned_with_updates(
        &self,
        source: &str,
        context: OwnedToolContext,
        observer: &mut dyn CodeModeObserver,
    ) -> CodeModeExecution {
        let execution = self.execute_code_owned(source, context).await;
        replay_nested_updates(&execution, observer);
        execution
    }

    /// Returns a failed result because hosted cells cannot currently yield.
    #[allow(
        clippy::unused_async,
        reason = "matches the native tool-runtime contract"
    )]
    pub async fn wait_for_code(
        &self,
        _input: &str,
        _context: ToolContext<'_>,
    ) -> CodeModeExecution {
        failed("background code-mode cells are unavailable in a hosted runtime")
    }

    /// Waits for Code Mode and replays nested calls to an observer.
    pub async fn wait_for_code_with_updates(
        &self,
        input: &str,
        context: ToolContext<'_>,
        observer: &mut dyn CodeModeObserver,
    ) -> CodeModeExecution {
        let execution = self.wait_for_code(input, context).await;
        replay_nested_updates(&execution, observer);
        execution
    }
}

fn is_standard_workspace_tool(name: &str) -> bool {
    [
        crate::StandardTool::ExecCommand,
        crate::StandardTool::WriteStdin,
        crate::StandardTool::UpdatePlan,
        crate::StandardTool::ApplyPatch,
        crate::StandardTool::ViewImage,
    ]
    .into_iter()
    .any(|tool| tool.name() == name)
}

fn normalize_identifier(name: &str) -> String {
    let mut identifier = String::new();
    for (index, character) in name.chars().enumerate() {
        let valid = if index == 0 {
            character == '_' || character == '$' || character.is_ascii_alphabetic()
        } else {
            character == '_' || character == '$' || character.is_ascii_alphanumeric()
        };
        identifier.push(if valid { character } else { '_' });
    }
    if identifier.is_empty() {
        "_".to_owned()
    } else {
        identifier
    }
}

impl HostedToolRuntimeControl {
    /// Begins a new logical agent turn.
    pub const fn begin_turn(&self) {}

    /// Cancels work owned by the current logical turn.
    #[allow(
        clippy::unused_async,
        reason = "matches the native tool-runtime control contract"
    )]
    pub async fn cancel_turn(&self) {}

    /// Cancels active work.
    ///
    /// Hosted calls are cancelled by dropping their futures, so no additional
    /// control message is required.
    #[allow(
        clippy::unused_async,
        reason = "matches the native tool-runtime control contract"
    )]
    pub async fn cancel(&self) {}
}

fn replay_nested_updates(execution: &CodeModeExecution, observer: &mut dyn CodeModeObserver) {
    for call in &execution.nested_calls {
        observer.update(CodeModeUpdate::NestedCallStarted {
            call_id: &call.call_id,
            name: &call.name,
            input: &call.input,
        });
        observer.update(CodeModeUpdate::NestedCallCompleted(call));
    }
}

fn failed(message: &str) -> CodeModeExecution {
    CodeModeExecution {
        output: ToolOutputBody::Text(format!("Script failed\nOutput:\n{message}")),
        success: false,
        nested_calls: Vec::<NestedToolCall>::new(),
        notifications: Vec::<CodeModeNotification>::new(),
    }
}

#[cfg(all(test, not(target_family = "wasm")))]
mod tests {
    use nanocodex_oai_api::tools::ToolOutputBody;
    use serde_json::json;

    use super::{HostedToolRuntime, HostedTools};
    use crate::{
        ToolContext, ToolDefinition, ToolInput,
        hosted::{CodeModeExecution, CodeModeHost, CodeModeHostError, HostFuture, NestedToolCall},
    };

    struct EchoHost;

    struct DeferredHost;

    impl CodeModeHost for EchoHost {
        fn tool_definitions(
            &self,
            session_id: &str,
        ) -> Result<Vec<ToolDefinition>, CodeModeHostError> {
            assert_eq!(session_id, "session-1");
            Ok(vec![
                ToolDefinition::function("zeta", "Zeta.", json!({"type": "object"})),
                ToolDefinition::function("alpha", "Alpha.", json!({"type": "object"})),
            ])
        }

        fn execute<'a>(
            &'a self,
            source: &'a str,
            context: ToolContext<'a>,
        ) -> HostFuture<'a, Result<CodeModeExecution, CodeModeHostError>> {
            Box::pin(async move {
                Ok(CodeModeExecution {
                    output: ToolOutputBody::Text(format!(
                        "{source}:{}:{}",
                        context.session_id(),
                        context.call_id()
                    )),
                    success: true,
                    nested_calls: Vec::<NestedToolCall>::new(),
                    notifications: Vec::new(),
                })
            })
        }
    }

    impl CodeModeHost for DeferredHost {
        fn tool_definitions(
            &self,
            _session_id: &str,
        ) -> Result<Vec<ToolDefinition>, CodeModeHostError> {
            Ok(vec![
                ToolDefinition::tool_search(
                    "client",
                    "Search deferred MCP tools.",
                    json!({"type": "object"}),
                ),
                ToolDefinition::function(
                    "mcp__mercator__search",
                    "Search Mercator.",
                    json!({"type": "object"}),
                )
                .with_deferred_loading(),
            ])
        }

        fn execute<'a>(
            &'a self,
            _source: &'a str,
            _context: ToolContext<'a>,
        ) -> HostFuture<'a, Result<CodeModeExecution, CodeModeHostError>> {
            Box::pin(async { unreachable!("this test dispatches tool_search directly") })
        }

        fn execute_tool<'a>(
            &'a self,
            name: &'a str,
            _input: ToolInput,
            _context: ToolContext<'a>,
        ) -> HostFuture<'a, Result<crate::ToolOutput, CodeModeHostError>> {
            Box::pin(async move { Ok(crate::ToolOutput::from_json(json!({"name": name}), true)) })
        }
    }

    #[test]
    fn model_description_orders_host_definitions() {
        let tools = HostedTools::new(EchoHost).for_session("session-1");
        tools.start_providers();
        let specs =
            HostedToolRuntime::new_with_tools(".", None, None, &tools).model_specs("session-1");
        let description = specs[0].description();
        assert!(description.find("tools.alpha").unwrap() < description.find("tools.zeta").unwrap());
    }

    #[tokio::test]
    async fn code_mode_keeps_tool_search_direct_and_mcp_tools_deferred() {
        let tools = HostedTools::new(DeferredHost);
        let runtime = HostedToolRuntime::new_with_tools(".", None, None, &tools);
        let specs = runtime.model_specs("session-1");
        let names = specs.iter().map(ToolDefinition::name).collect::<Vec<_>>();
        assert_eq!(names, ["exec", "tool_search"]);
        assert!(
            !specs[0]
                .description()
                .contains("tools.mcp__mercator__search")
        );
        assert!(specs[0].description().contains("deferred nested tools"));
        assert!(runtime.contains("tool_search"));
        assert!(runtime.contains("mcp__mercator__search"));

        let output = runtime
            .execute_tool(
                "tool_search",
                ToolInput::Function(
                    serde_json::value::to_raw_value(&json!({"query": "mercator"})).unwrap(),
                ),
                ToolContext::new("gpt-5", "session-1", "call-1", &[], 1_000),
            )
            .await;
        assert!(output.success);

        let output = runtime
            .execute_tool(
                "mcp__mercator__search",
                ToolInput::Function(serde_json::value::to_raw_value(&json!({})).unwrap()),
                ToolContext::new("gpt-5", "session-1", "call-2", &[], 1_000),
            )
            .await;
        assert!(output.success);
        assert_eq!(output.structured_result()["name"], "mcp__mercator__search");
    }

    #[tokio::test]
    async fn execution_receives_the_standard_tool_context() {
        let tools = HostedTools::new(EchoHost);
        let runtime = HostedToolRuntime::new_with_tools(".", None, None, &tools);
        let execution = runtime
            .execute_code(
                "echo",
                ToolContext::new("gpt-5", "session-1", "call-1", &[], 1_000),
            )
            .await;
        let ToolOutputBody::Text(output) = execution.output else {
            panic!("expected text output");
        };
        assert_eq!(output, "echo:session-1:call-1");
    }
}
