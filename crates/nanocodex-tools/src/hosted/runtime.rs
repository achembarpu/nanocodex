use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{Arc, RwLock},
};

use nanocodex_oai_api::{
    responses::CustomToolFormat,
    tools::{Tool, ToolContext, ToolDefinition, ToolInput, ToolOutput, ToolOutputBody},
};

use super::{
    CodeModeExecution, CodeModeHost, CodeModeNotification, CodeModeObserver, HostedToolMode,
    NestedToolCall, OwnedToolContext,
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
    session_id: Option<Arc<str>>,
    local: Vec<(Arc<str>, Arc<dyn Tool>)>,
}

/// Invalid composition of Rust extension tools in a hosted runtime.
#[derive(Debug)]
pub struct HostedToolsBuildError(String);

impl std::fmt::Display for HostedToolsBuildError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for HostedToolsBuildError {}

impl HostedTools {
    /// Selects an application-owned Code Mode host.
    #[must_use]
    pub fn new(host: impl CodeModeHost) -> Self {
        Self {
            host: Some(Arc::new(host)),
            session_id: None,
            local: Vec::new(),
        }
    }

    /// Adds a Rust-owned direct tool while retaining the embedding host's tools.
    pub fn with_tool(mut self, tool: impl Tool) -> Result<Self, HostedToolsBuildError> {
        let name = tool.definition().name().trim().to_owned();
        if name.is_empty() {
            return Err(HostedToolsBuildError(
                "tool name cannot be empty".to_owned(),
            ));
        }
        if self
            .local
            .iter()
            .any(|(configured, _)| configured.as_ref() == name)
        {
            return Err(HostedToolsBuildError(format!(
                "tool is already configured: {name}"
            )));
        }
        self.local.push((Arc::from(name), Arc::new(tool)));
        Ok(self)
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
    pub fn for_session(mut self, session_id: &str) -> Self {
        self.session_id = Some(Arc::from(session_id));
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
    session_id: Option<Arc<str>>,
    local: Vec<(Arc<str>, Arc<dyn Tool>)>,
    callable_tool_names: RwLock<HashSet<String>>,
}

/// Cancellation handle for work owned by an embedding host.
#[derive(Clone, Default)]
pub struct HostedToolRuntimeControl {
    host: Option<Arc<dyn CodeModeHost>>,
    session_id: Option<Arc<str>>,
}

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
            session_id: None,
            local: Vec::new(),
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
        self.session_id.clone_from(&tools.session_id);
        self.local.clone_from(&tools.local);
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
    pub fn control(&self) -> HostedToolRuntimeControl {
        HostedToolRuntimeControl {
            host: self.host.clone(),
            session_id: self.session_id.clone(),
        }
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
        definitions.retain(|definition| {
            !self
                .local
                .iter()
                .any(|(name, _)| name.as_ref() == definition.name())
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
            definitions.extend(self.local.iter().map(|(_, tool)| tool.definition()));
            crate::code_mode_order::sort_definitions(&mut definitions);
            return (definitions, Vec::new());
        }
        let has_deferred_tools = definitions.iter().any(|definition| {
            matches!(
                definition,
                ToolDefinition::ToolSearch { .. }
                    | ToolDefinition::Function {
                        defer_loading: Some(true),
                        ..
                    }
                    | ToolDefinition::Custom {
                        defer_loading: Some(true),
                        ..
                    }
            )
        });
        let (mut direct_definitions, code_mode_definitions): (Vec<_>, Vec<_>) =
            definitions.into_iter().partition(|definition| {
                matches!(definition, ToolDefinition::ToolSearch { .. })
                    || is_standard_workspace_tool(definition.name())
            });
        direct_definitions = direct_definitions
            .into_iter()
            .map(crate::code_mode_description::augment_definition_for_code_mode)
            .collect();
        crate::code_mode_order::sort_direct_definitions(&mut direct_definitions);
        direct_definitions.extend(self.local.iter().map(|(_, tool)| tool.definition()));
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
                continue;
            }
            let definition =
                crate::code_mode_description::augment_definition_for_code_mode(definition);
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
        self.local
            .iter()
            .any(|(configured, _)| configured.as_ref() == name)
            || self.host.as_ref().is_some_and(|_| {
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
        if let Some((_, tool)) = self
            .local
            .iter()
            .find(|(configured, _)| configured.as_ref() == name)
        {
            return tool
                .execute(input, context)
                .await
                .unwrap_or_else(|error| ToolOutput::error(error.to_string()));
        }
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

    /// Executes Code Mode and streams nested calls to an observer when the
    /// embedding host supports live updates.
    pub async fn execute_code_owned_with_updates(
        &self,
        source: &str,
        context: OwnedToolContext,
        observer: &mut dyn CodeModeObserver,
    ) -> CodeModeExecution {
        let Some(host) = &self.host else {
            return failed("no hosted Code Mode adapter is configured");
        };
        match host
            .execute_with_updates(source, context.as_context(), observer)
            .await
        {
            Ok(execution) => execution,
            Err(error) => failed(&error.to_string()),
        }
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

    /// Waits for hosted Code Mode, which cannot currently yield nested work.
    pub async fn wait_for_code_with_updates(
        &self,
        input: &str,
        context: ToolContext<'_>,
        _observer: &mut dyn CodeModeObserver,
    ) -> CodeModeExecution {
        self.wait_for_code(input, context).await
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
    pub async fn cancel_turn(&self) {
        self.cancel().await;
    }

    /// Cancels active work.
    pub async fn cancel(&self) {
        if let (Some(host), Some(session_id)) = (&self.host, &self.session_id)
            && let Err(error) = host.cancel(session_id).await
        {
            tracing::warn!(
                target: "nanocodex_tools",
                %error,
                "hosted Code Mode cancellation failed"
            );
        }
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
    use async_trait::async_trait;
    use nanocodex_oai_api::tools::ToolOutputBody;
    use serde_json::json;

    use super::{HostedToolRuntime, HostedTools};
    use crate::{
        Tool, ToolContext, ToolDefinition, ToolInput, ToolOutput, ToolResult,
        hosted::{CodeModeExecution, CodeModeHost, CodeModeHostError, HostFuture, NestedToolCall},
    };

    struct EchoHost;

    struct DeferredHost;

    struct PendingDeferredHost;

    struct ExecHost;

    struct LocalAlpha;

    struct WebHost;

    #[async_trait]
    impl Tool for LocalAlpha {
        fn definition(&self) -> ToolDefinition {
            ToolDefinition::function("alpha", "Rust alpha.", json!({"type": "object"}))
        }

        async fn execute(&self, _input: ToolInput, context: ToolContext<'_>) -> ToolResult {
            Ok(ToolOutput::from_json(
                json!({"session_id": context.session_id()}),
                true,
            ))
        }
    }

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

    impl CodeModeHost for PendingDeferredHost {
        fn tool_definitions(
            &self,
            _session_id: &str,
        ) -> Result<Vec<ToolDefinition>, CodeModeHostError> {
            Ok(vec![ToolDefinition::tool_search(
                "client",
                "Search deferred MCP tools.",
                json!({"type": "object"}),
            )])
        }

        fn execute<'a>(
            &'a self,
            _source: &'a str,
            _context: ToolContext<'a>,
        ) -> HostFuture<'a, Result<CodeModeExecution, CodeModeHostError>> {
            Box::pin(async { unreachable!("pending discovery does not execute code") })
        }
    }

    impl CodeModeHost for ExecHost {
        fn tool_definitions(
            &self,
            _session_id: &str,
        ) -> Result<Vec<ToolDefinition>, CodeModeHostError> {
            Ok(vec![
                ToolDefinition::function(
                    "exec_command",
                    "Run a command.",
                    json!({
                        "type": "object",
                        "properties": { "cmd": { "type": "string" } },
                        "required": ["cmd"]
                    }),
                )
                .with_output_schema(json!({
                    "type": "object",
                    "properties": {
                        "output": { "type": "string" },
                        "wall_time_seconds": { "type": "number" }
                    },
                    "required": ["output", "wall_time_seconds"]
                })),
            ])
        }

        fn execute<'a>(
            &'a self,
            _source: &'a str,
            _context: ToolContext<'a>,
        ) -> HostFuture<'a, Result<CodeModeExecution, CodeModeHostError>> {
            Box::pin(async { unreachable!("this test only inspects the model contract") })
        }
    }

    impl CodeModeHost for WebHost {
        fn tool_definitions(
            &self,
            _session_id: &str,
        ) -> Result<Vec<ToolDefinition>, CodeModeHostError> {
            Ok(vec![ToolDefinition::function(
                "web__run",
                "Search the public internet.",
                json!({
                    "type": "object",
                    "properties": {
                        "search_query": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": { "q": { "type": "string" } },
                                "required": ["q"],
                                "additionalProperties": false
                            }
                        },
                        "response_length": {
                            "type": "string",
                            "enum": ["short", "medium", "long"]
                        }
                    },
                    "additionalProperties": false
                }),
            )])
        }

        fn execute<'a>(
            &'a self,
            _source: &'a str,
            _context: ToolContext<'a>,
        ) -> HostFuture<'a, Result<CodeModeExecution, CodeModeHostError>> {
            Box::pin(async { unreachable!("this test only inspects the model contract") })
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

    #[test]
    fn model_description_includes_hosted_tool_argument_shapes() {
        let specs = HostedToolRuntime::new_with_tools(".", None, None, &HostedTools::new(WebHost))
            .model_specs("session-1");
        let description = specs[0].description();

        assert!(description.contains("web__run(args:"));
        assert!(description.contains("search_query?: Array<{ q: string; }>"));
        assert!(description.contains("response_length?: \"short\" | \"medium\" | \"long\""));
    }

    #[test]
    fn direct_workspace_tool_describes_its_code_mode_return_shape() {
        let specs = HostedToolRuntime::new_with_tools(".", None, None, &HostedTools::new(ExecHost))
            .model_specs("session-1");
        let exec_command = specs
            .iter()
            .find(|definition| definition.name() == "exec_command")
            .unwrap();

        assert!(exec_command.description().contains(
            "exec_command(args: { cmd: string; }): Promise<{ output: string; wall_time_seconds: number; }>"
        ));
    }

    #[tokio::test]
    async fn rust_extension_tools_shadow_host_tools_and_dispatch_directly() {
        let tools = HostedTools::new(EchoHost).with_tool(LocalAlpha).unwrap();
        let runtime = HostedToolRuntime::new_with_tools(".", None, None, &tools);
        let specs = runtime.model_specs("session-1");
        assert_eq!(
            specs.iter().map(ToolDefinition::name).collect::<Vec<_>>(),
            ["exec", "alpha"]
        );
        assert!(!specs[0].description().contains("tools.alpha"));

        let output = runtime
            .execute_tool(
                "alpha",
                ToolInput::Function(serde_json::value::to_raw_value(&json!({})).unwrap()),
                ToolContext::new("gpt-5", "session-1", "call-1", &[], 1_000),
            )
            .await;
        assert!(output.success);
        assert_eq!(output.structured_result()["session_id"], "session-1");
    }

    #[tokio::test]
    async fn code_mode_keeps_tool_search_direct_and_mcp_tools_deferred() {
        let tools = HostedTools::new(DeferredHost);
        let runtime = HostedToolRuntime::new_with_tools(".", None, None, &tools);
        let specs = runtime.model_specs("session-1");
        let pending_tools = HostedTools::new(PendingDeferredHost);
        let pending_runtime = HostedToolRuntime::new_with_tools(".", None, None, &pending_tools);
        let pending_specs = pending_runtime.model_specs("session-1");
        let names = specs.iter().map(ToolDefinition::name).collect::<Vec<_>>();
        assert_eq!(names, ["exec", "tool_search"]);
        assert_eq!(pending_specs[0].description(), specs[0].description());
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
