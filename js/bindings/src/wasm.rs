use std::{cell::RefCell, collections::HashMap, path::PathBuf, rc::Rc};

use js_sys::Promise;
use nanocodex::{
    AgentEvents, Model, Nanocodex as RustNanocodex, OpenAi, ReasoningMode, Thinking, TurnControl,
    TurnResult,
    agent::{
        ExecutionEnvironment,
        input::{Prompt, UserInput},
        session::{SessionId, SessionSnapshot},
    },
    oai::auth::{
        ChatGptCredentialSeed, ChatGptLoginStatus, ChatGptSubscription, ChatGptSubscriptionHost,
        SubscriptionCommit, SubscriptionFuture, SubscriptionHostError, SubscriptionHttpRequest,
        SubscriptionHttpResponse, SubscriptionStoreValue,
    },
    tools::{
        ToolContext, ToolDefinition, ToolInput, ToolOutput,
        contract::ToolOutputWire,
        hosted::{
            CodeModeExecution, CodeModeHost, CodeModeHostError, HostFuture, HostedToolMode,
            HostedTools,
        },
        standard::StandardTool,
    },
};
use serde::Deserialize;
use tokio::sync::oneshot;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::{JsFuture, spawn_local};

use nanocodex_subagents::{
    AgentId as SubagentId, AgentStatus as SubagentStatus, AgentUpdate as SubagentUpdate,
    ScopedAgentUpdate, SubagentControl,
};

mod transport;

use transport::JavaScriptResponsesHost;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = ["globalThis", "nanocodexHost"], js_name = emitEvent)]
    fn host_emit_event(event: &str);

    #[wasm_bindgen(catch, js_namespace = ["globalThis", "nanocodexHost"], js_name = executeCode)]
    fn host_execute_code(source: &str, session_id: &str, call_id: &str)
    -> Result<Promise, JsValue>;

    #[wasm_bindgen(catch, js_namespace = ["globalThis", "nanocodexHost"], js_name = executeTool)]
    fn host_execute_tool(
        name: &str,
        input: &str,
        session_id: &str,
        call_id: &str,
    ) -> Result<Promise, JsValue>;

    #[wasm_bindgen(js_namespace = ["globalThis", "nanocodexHost"], js_name = cancelCode)]
    fn host_cancel_code(session_id: &str);

    #[wasm_bindgen(js_namespace = ["globalThis", "nanocodexHost"], js_name = toolMode)]
    fn host_tool_mode(definition_host_id: u32, session_id: &str) -> String;

    #[wasm_bindgen(catch, js_namespace = ["globalThis", "nanocodexHost"], js_name = toolDefinitions)]
    fn host_tool_definitions(definition_host_id: u32, session_id: &str) -> Result<String, JsValue>;

    #[wasm_bindgen(catch, js_namespace = ["globalThis", "nanocodexHost"], js_name = readWorkspaceFile)]
    fn host_read_workspace_file(path: &str, session_id: &str) -> Result<Promise, JsValue>;

    #[wasm_bindgen(catch, js_namespace = ["globalThis", "nanocodexHost"], js_name = writeWorkspaceFile)]
    fn host_write_workspace_file(
        path: &str,
        contents: &str,
        session_id: &str,
    ) -> Result<Promise, JsValue>;

    #[wasm_bindgen(catch, js_namespace = ["globalThis", "nanocodexHost"], js_name = removeWorkspaceFile)]
    fn host_remove_workspace_file(path: &str, session_id: &str) -> Result<Promise, JsValue>;

    #[wasm_bindgen(catch, js_namespace = ["globalThis", "nanocodexHost"], js_name = subscriptionLoad)]
    fn host_subscription_load(subscription_id: &str) -> Result<Promise, JsValue>;

    #[wasm_bindgen(catch, js_namespace = ["globalThis", "nanocodexHost"], js_name = subscriptionCompareAndSwap)]
    fn host_subscription_compare_and_swap(
        subscription_id: &str,
        expected_revision: &str,
        payload: &str,
    ) -> Result<Promise, JsValue>;

    #[wasm_bindgen(catch, js_namespace = ["globalThis", "nanocodexHost"], js_name = subscriptionRequest)]
    fn host_subscription_request(subscription_id: &str, request: &str) -> Result<Promise, JsValue>;

    #[wasm_bindgen(js_namespace = ["globalThis", "nanocodexHost"], js_name = bindSubagentSession)]
    fn host_bind_subagent_session(root_session_id: &str, session_id: &str);

    #[wasm_bindgen(js_namespace = ["globalThis", "nanocodexHost"], js_name = releaseSubagentSession)]
    fn host_release_subagent_session(session_id: &str);
}

struct JavaScriptSubscriptionHost {
    subscription_id: String,
}

#[derive(Deserialize)]
struct JavaScriptSubscriptionValue {
    revision: String,
    #[serde(default)]
    payload: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum JavaScriptSubscriptionCommit {
    Committed { revision: String },
    Conflict { actual_revision: String },
}

#[derive(Deserialize)]
struct JavaScriptSubscriptionResponse {
    status: u16,
    body: String,
}

impl ChatGptSubscriptionHost for JavaScriptSubscriptionHost {
    fn load<'a>(
        &'a self,
        _key: &'a str,
    ) -> SubscriptionFuture<'a, Result<SubscriptionStoreValue, SubscriptionHostError>> {
        Box::pin(async move {
            let promise =
                host_subscription_load(&self.subscription_id).map_err(subscription_host_error)?;
            let stored: JavaScriptSubscriptionValue = await_subscription_json(promise).await?;
            Ok(SubscriptionStoreValue {
                revision: parse_subscription_revision(&stored.revision)?,
                payload: stored.payload,
            })
        })
    }

    fn compare_and_swap<'a>(
        &'a self,
        _key: &'a str,
        expected_revision: u64,
        payload: &'a str,
    ) -> SubscriptionFuture<'a, Result<SubscriptionCommit, SubscriptionHostError>> {
        Box::pin(async move {
            let expected = expected_revision.to_string();
            let promise =
                host_subscription_compare_and_swap(&self.subscription_id, &expected, payload)
                    .map_err(subscription_host_error)?;
            match await_subscription_json::<JavaScriptSubscriptionCommit>(promise).await? {
                JavaScriptSubscriptionCommit::Committed { revision } => Ok(
                    SubscriptionCommit::Committed(parse_subscription_revision(&revision)?),
                ),
                JavaScriptSubscriptionCommit::Conflict { actual_revision } => Ok(
                    SubscriptionCommit::Conflict(parse_subscription_revision(&actual_revision)?),
                ),
            }
        })
    }

    fn request<'a>(
        &'a self,
        request: SubscriptionHttpRequest,
    ) -> SubscriptionFuture<'a, Result<SubscriptionHttpResponse, SubscriptionHostError>> {
        Box::pin(async move {
            let encoded = serde_json::json!({
                "method": request.method(),
                "url": request.url(),
                "contentType": request.content_type(),
                "body": request.body(),
                "maxResponseBytes": request.max_response_bytes(),
            })
            .to_string();
            let promise = host_subscription_request(&self.subscription_id, &encoded)
                .map_err(subscription_host_error)?;
            let response: JavaScriptSubscriptionResponse = await_subscription_json(promise).await?;
            Ok(SubscriptionHttpResponse {
                status: response.status,
                body: response.body,
            })
        })
    }
}

async fn await_subscription_json<T: for<'de> Deserialize<'de>>(
    promise: Promise,
) -> Result<T, SubscriptionHostError> {
    let value = JsFuture::from(promise)
        .await
        .map_err(subscription_host_error)?;
    let encoded = value.as_string().ok_or_else(|| {
        SubscriptionHostError::new("JavaScript subscription host returned a non-string")
    })?;
    serde_json::from_str(&encoded).map_err(|error| {
        SubscriptionHostError::new(format!(
            "JavaScript subscription host returned invalid JSON: {error}"
        ))
    })
}

fn parse_subscription_revision(revision: &str) -> Result<u64, SubscriptionHostError> {
    revision.parse().map_err(|error| {
        SubscriptionHostError::new(format!("invalid subscription revision: {error}"))
    })
}

fn subscription_host_error(error: JsValue) -> SubscriptionHostError {
    SubscriptionHostError::new(host_error_message(&error))
}

struct JavaScriptCodeModeHost {
    definition_host_id: u32,
    mode: HostedToolMode,
}

impl JavaScriptCodeModeHost {
    fn new(definition_host_id: u32) -> Self {
        Self {
            definition_host_id,
            mode: if host_tool_mode(definition_host_id, "") == "direct" {
                HostedToolMode::Direct
            } else {
                HostedToolMode::Code
            },
        }
    }
}

impl CodeModeHost for JavaScriptCodeModeHost {
    fn tool_mode(&self) -> HostedToolMode {
        self.mode
    }

    fn tool_definitions(&self, session_id: &str) -> Result<Vec<ToolDefinition>, CodeModeHostError> {
        let encoded = host_tool_definitions(self.definition_host_id, session_id)
            .map_err(|error| CodeModeHostError::new(host_error_message(&error)))?;
        let mut definitions =
            serde_json::from_str::<Vec<ToolDefinition>>(&encoded).map_err(|error| {
                CodeModeHostError::new(format!(
                    "JavaScript Code Mode host returned invalid tool definitions: {error}"
                ))
            })?;
        for definition in &mut definitions {
            let standard = match definition.name() {
                name if name == StandardTool::WriteStdin.name() => Some(StandardTool::WriteStdin),
                name if name == StandardTool::UpdatePlan.name() => Some(StandardTool::UpdatePlan),
                name if name == StandardTool::ApplyPatch.name() => Some(StandardTool::ApplyPatch),
                name if name == StandardTool::ViewImage.name() => Some(StandardTool::ViewImage),
                _ => None,
            };
            if let Some(standard) = standard {
                *definition = standard.definition();
            }
        }
        Ok(definitions)
    }

    fn execute<'a>(
        &'a self,
        source: &'a str,
        context: ToolContext<'a>,
    ) -> HostFuture<'a, Result<CodeModeExecution, CodeModeHostError>> {
        Box::pin(async move {
            let promise = host_execute_code(source, context.session_id(), context.call_id())
                .map_err(|error| CodeModeHostError::new(host_error_message(&error)))?;
            let value = JsFuture::from(promise)
                .await
                .map_err(|error| CodeModeHostError::new(host_error_message(&error)))?;
            let encoded = value.as_string().ok_or_else(|| {
                CodeModeHostError::new("JavaScript Code Mode host returned a non-string result")
            })?;
            serde_json::from_str(&encoded).map_err(|error| {
                CodeModeHostError::new(format!(
                    "JavaScript Code Mode host returned invalid execution JSON: {error}"
                ))
            })
        })
    }

    fn execute_tool<'a>(
        &'a self,
        name: &'a str,
        input: ToolInput,
        context: ToolContext<'a>,
    ) -> HostFuture<'a, Result<ToolOutput, CodeModeHostError>> {
        Box::pin(async move {
            if name == StandardTool::ApplyPatch.name() {
                return execute_browser_apply_patch(input, context.session_id()).await;
            }
            let input = match input {
                ToolInput::Function(input) => input.get().to_owned(),
                ToolInput::Freeform(input) => serde_json::to_string(&input).map_err(|error| {
                    CodeModeHostError::new(format!("failed to encode hosted tool input: {error}"))
                })?,
            };
            let promise = host_execute_tool(name, &input, context.session_id(), context.call_id())
                .map_err(|error| CodeModeHostError::new(host_error_message(&error)))?;
            let value = JsFuture::from(promise)
                .await
                .map_err(|error| CodeModeHostError::new(host_error_message(&error)))?;
            let encoded = value.as_string().ok_or_else(|| {
                CodeModeHostError::new("JavaScript tool host returned a non-string result")
            })?;
            let wire = serde_json::from_str::<ToolOutputWire>(&encoded).map_err(|error| {
                CodeModeHostError::new(format!(
                    "JavaScript tool host returned invalid execution JSON: {error}"
                ))
            })?;
            ToolOutput::from_wire(wire).map_err(|error| {
                CodeModeHostError::new(format!("JavaScript tool result was invalid: {error}"))
            })
        })
    }

    fn cancel<'a>(&'a self, session_id: &'a str) -> HostFuture<'a, Result<(), CodeModeHostError>> {
        Box::pin(async move {
            host_cancel_code(session_id);
            Ok(())
        })
    }
}

async fn execute_browser_apply_patch(
    input: ToolInput,
    session_id: &str,
) -> Result<ToolOutput, CodeModeHostError> {
    use nanocodex::tools::apply_patch::{PatchOperation, plan, required_files};

    let patch = input
        .into_freeform()
        .map_err(|error| CodeModeHostError::new(format!("invalid apply_patch input: {error}")))?;
    let mut files = HashMap::new();
    for path in required_files(&patch).map_err(CodeModeHostError::new)? {
        let display = path.to_string_lossy().into_owned();
        let promise = host_read_workspace_file(&display, session_id)
            .map_err(|error| CodeModeHostError::new(host_error_message(&error)))?;
        let value = JsFuture::from(promise)
            .await
            .map_err(|error| CodeModeHostError::new(host_error_message(&error)))?;
        let contents = value.as_string().ok_or_else(|| {
            CodeModeHostError::new(format!(
                "browser workspace returned non-text data for {display}"
            ))
        })?;
        files.insert(PathBuf::from(display), contents);
    }
    let plan = plan(&patch, &files).map_err(CodeModeHostError::new)?;
    for operation in plan.operations() {
        let promise = match operation {
            PatchOperation::Write { path, contents } => {
                host_write_workspace_file(&path.to_string_lossy(), contents, session_id)
            }
            PatchOperation::Delete { path } => {
                host_remove_workspace_file(&path.to_string_lossy(), session_id)
            }
        }
        .map_err(|error| CodeModeHostError::new(host_error_message(&error)))?;
        JsFuture::from(promise)
            .await
            .map_err(|error| CodeModeHostError::new(host_error_message(&error)))?;
    }
    Ok(ToolOutput::text(plan.summary().to_owned()).with_structured_result(serde_json::json!({})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WasmConfig {
    api_key: String,
    host_definition_id: u32,
    #[serde(default = "default_model")]
    model: String,
    #[serde(default = "default_thinking")]
    thinking: String,
    #[serde(default = "default_reasoning_mode")]
    reasoning_mode: String,
    #[serde(default)]
    fast_mode: bool,
    #[serde(default)]
    websocket_warmup: bool,
    #[serde(default = "default_websocket_url")]
    websocket_url: String,
    #[serde(default = "default_api_base_url")]
    api_base_url: String,
    #[serde(default)]
    instructions: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default)]
    execution_environment: Option<WasmExecutionEnvironment>,
    #[serde(default)]
    resume: Option<SessionSnapshot>,
    #[serde(default)]
    subagents: Option<WasmSubagentsConfig>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields)]
struct WasmSubagentsConfig {
    #[serde(default = "default_max_subagents")]
    max_concurrency: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WasmExecutionEnvironment {
    current_date: String,
    timezone: String,
    #[serde(default)]
    project_instructions: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WasmSubscriptionConfig {
    id: String,
    #[serde(default)]
    issuer: Option<String>,
    #[serde(default)]
    seed: Option<WasmSubscriptionSeed>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WasmSubscriptionSeed {
    access_token: String,
    #[serde(default)]
    refresh_token: String,
    account_id: String,
    #[serde(default)]
    fedramp: bool,
}

/// JavaScript binding over the Rust-owned hosted ChatGPT credential lifecycle.
#[wasm_bindgen(js_name = ChatGptSubscription)]
pub struct WasmChatGptSubscription {
    inner: ChatGptSubscription,
}

#[wasm_bindgen(js_class = ChatGptSubscription)]
impl WasmChatGptSubscription {
    /// Opens a subscription over the currently registered generic host capabilities.
    #[wasm_bindgen(js_name = open)]
    pub async fn open(config_json: &str) -> Result<Self, JsValue> {
        let config = serde_json::from_str::<WasmSubscriptionConfig>(config_json)
            .map_err(|error| js_error(format!("invalid ChatGPT subscription config: {error}")))?;
        let seed = config.seed.map(|seed| {
            ChatGptCredentialSeed::new(
                seed.access_token,
                seed.refresh_token,
                seed.account_id,
                seed.fedramp,
            )
        });
        let host = JavaScriptSubscriptionHost {
            subscription_id: config.id.clone(),
        };
        let inner = if let Some(issuer) = config.issuer {
            ChatGptSubscription::open_with_issuer(host, config.id, seed, issuer).await
        } else {
            ChatGptSubscription::open(host, config.id, seed).await
        }
        .map_err(js_error)?;
        Ok(Self { inner })
    }

    /// Starts a ChatGPT device login and returns public pending state as JSON.
    #[wasm_bindgen(js_name = startLogin)]
    pub async fn start_login(&self) -> Result<String, JsValue> {
        encode_login_status(self.inner.start_login().await)
    }

    /// Polls device login and returns public state as JSON.
    pub async fn status(&self) -> Result<String, JsValue> {
        encode_login_status(self.inner.status().await)
    }

    /// Resolves one credential generation for a host-owned outbound request.
    pub async fn credential(&self) -> Result<String, JsValue> {
        encode_subscription_credential(self.inner.credential().await)
    }

    /// Refreshes a rejected generation and returns the credential now current.
    pub async fn recover(&self, rejected_revision: &str) -> Result<String, JsValue> {
        let revision = rejected_revision
            .parse::<u64>()
            .map_err(|error| js_error(format!("invalid credential revision: {error}")))?;
        encode_subscription_credential(self.inner.recover(revision).await)
    }

    /// Clears the persisted credential and pending login.
    pub async fn logout(&self) -> Result<(), JsValue> {
        self.inner.logout().await.map_err(js_error)
    }
}

fn encode_login_status<E: ToString>(
    status: Result<ChatGptLoginStatus, E>,
) -> Result<String, JsValue> {
    serde_json::to_string(&status.map_err(js_error)?).map_err(js_error)
}

fn encode_subscription_credential(
    credential: Result<nanocodex::oai::auth::ChatGptCredential, impl ToString>,
) -> Result<String, JsValue> {
    let credential = credential.map_err(js_error)?;
    Ok(serde_json::json!({
        "kind": "chatgpt",
        "accessToken": credential.access_token(),
        "accountId": credential.account_id(),
        "fedramp": credential.is_fedramp(),
        "revision": credential.revision().to_string(),
    })
    .to_string())
}

/// JavaScript binding over the shared Rust agent lifecycle.
#[wasm_bindgen(js_name = Nanocodex)]
pub struct WasmNanocodex {
    inner: RustNanocodex,
    subagents: Option<WasmSubagents>,
}

#[derive(Clone)]
struct WasmSubagents {
    control: SubagentControl,
    sessions: Rc<RefCell<HashMap<(String, SubagentId), String>>>,
}

impl WasmSubagents {
    fn new(
        control: SubagentControl,
        updates: tokio::sync::mpsc::UnboundedReceiver<ScopedAgentUpdate>,
    ) -> Self {
        let sessions = Rc::new(RefCell::new(HashMap::new()));
        forward_subagent_updates(updates, Rc::clone(&sessions));
        Self { control, sessions }
    }

    async fn close_all(&self, root_session_id: &str) -> std::io::Result<()> {
        self.control.close_all(root_session_id).await?;
        release_subagent_scope(&self.sessions, root_session_id);
        Ok(())
    }
}

#[wasm_bindgen(js_class = Nanocodex)]
impl WasmNanocodex {
    /// Builds an agent from its JavaScript JSON configuration.
    ///
    /// # Errors
    ///
    /// Throws when the JSON or agent policy is invalid.
    #[wasm_bindgen(constructor)]
    pub fn new(config_json: &str) -> Result<Self, JsValue> {
        let config = serde_json::from_str::<WasmConfig>(config_json)
            .map_err(|error| js_error(format!("invalid Nanocodex configuration: {error}")))?;
        let auth = nanocodex::oai::auth::OpenAiAuth::api_key(config.api_key.clone());
        Self::create_with_auth(config, auth)
    }

    /// Builds an agent whose ChatGPT credential lifecycle is owned by Rust.
    #[wasm_bindgen(js_name = createWithChatGpt)]
    pub async fn create_with_chat_gpt(
        config_json: &str,
        subscription: &WasmChatGptSubscription,
    ) -> Result<Self, JsValue> {
        let config = serde_json::from_str::<WasmConfig>(config_json)
            .map_err(|error| js_error(format!("invalid Nanocodex configuration: {error}")))?;
        let auth = subscription.inner.authorization().await.map_err(js_error)?;
        Self::create_with_auth(config, auth)
    }

    fn create_with_auth(
        config: WasmConfig,
        auth: nanocodex::oai::auth::OpenAiAuth,
    ) -> Result<Self, JsValue> {
        validate(&config)?;

        let model = config.model.parse::<Model>().map_err(js_error)?;
        let thinking = config.thinking.parse::<Thinking>().map_err(js_error)?;
        let reasoning_mode = config
            .reasoning_mode
            .parse::<ReasoningMode>()
            .map_err(js_error)?;
        let openai = OpenAi::builder(auth)
            .model(model)
            .thinking(thinking)
            .reasoning_mode(reasoning_mode)
            .fast_mode(config.fast_mode)
            .websocket_warmup(config.websocket_warmup)
            .websocket_url(config.websocket_url)
            .api_base_url(config.api_base_url)
            .host_transport(JavaScriptResponsesHost)
            .build()
            .map_err(js_error)?;
        let hosted_tools = HostedTools::new(JavaScriptCodeModeHost::new(config.host_definition_id));
        let (mut builder, subagents) = if let Some(subagents) = config.subagents {
            let (registry, control, updates) =
                nanocodex_subagents::channel(subagents.max_concurrency);
            (
                RustNanocodex::builder(openai).tools_factory(move |agent| {
                    nanocodex_subagents::install_tools(
                        hosted_tools.clone(),
                        agent,
                        registry.clone(),
                    )
                }),
                Some(WasmSubagents::new(control, updates)),
            )
        } else {
            (RustNanocodex::builder(openai).tools(hosted_tools), None)
        };
        if let Some(instructions) = config.instructions {
            builder = builder.instructions(instructions);
        }
        if let Some(session_id) = config.session_id {
            builder = builder.session_id(session_id.parse::<SessionId>().map_err(js_error)?);
        }
        if let Some(workspace) = config.workspace {
            builder = builder.workspace(workspace);
        }
        if let Some(configured) = config.execution_environment {
            let mut environment =
                ExecutionEnvironment::new(configured.current_date, configured.timezone);
            if let Some(project_instructions) = configured.project_instructions {
                environment = environment.project_instructions(project_instructions);
            }
            builder = builder.execution_environment(environment);
        }
        if let Some(resume) = config.resume {
            builder = builder.resume(resume);
        }
        let (inner, events) = builder.build().map_err(js_error)?;
        Ok(Self::from_parts(inner, events, subagents))
    }

    /// Returns the stable `UUIDv7` session identity.
    #[wasm_bindgen(getter, js_name = sessionId)]
    #[must_use]
    pub fn session_id(&self) -> String {
        self.inner.session_id().to_string()
    }

    /// Accepts a text prompt and returns its independently awaitable turn.
    ///
    /// # Errors
    ///
    /// Throws when the prompt is empty.
    pub fn prompt(&self, instruction: &str) -> Result<WasmTurn, JsValue> {
        if instruction.trim().is_empty() {
            return Err(js_error("prompt instruction must not be empty"));
        }
        Ok(WasmTurn::accept(
            self.inner.clone(),
            Prompt::new(instruction),
        ))
    }

    /// Accepts browser-safe multimodal input encoded as JSON.
    ///
    /// # Errors
    ///
    /// Throws for malformed, empty, or local-filesystem input.
    #[wasm_bindgen(js_name = promptContent)]
    pub fn prompt_content(&self, content_json: &str) -> Result<WasmTurn, JsValue> {
        Ok(WasmTurn::accept(
            self.inner.clone(),
            parse_browser_prompt(content_json)?,
        ))
    }

    /// Forks the latest safe committed model boundary.
    ///
    /// # Errors
    ///
    /// Rejects before the first safe boundary or after the driver stops.
    pub async fn fork(&self) -> Result<Self, JsValue> {
        let (inner, events) = self.inner.fork().await.map_err(js_error)?;
        Ok(Self::from_parts(inner, events, self.subagents.clone()))
    }

    /// Forks from an exact completed historical turn.
    ///
    /// # Errors
    ///
    /// Rejects if the result belongs to another agent or the driver stopped.
    #[wasm_bindgen(js_name = forkFrom)]
    pub async fn fork_from(&self, result: &WasmTurnResult) -> Result<Self, JsValue> {
        let (inner, events) = self
            .inner
            .fork_from(&result.inner)
            .await
            .map_err(js_error)?;
        Ok(Self::from_parts(inner, events, self.subagents.clone()))
    }

    /// Starts a clean sibling with the same private agent policy.
    ///
    /// # Errors
    ///
    /// Rejects after the driver stops.
    pub async fn spawn(&self) -> Result<Self, JsValue> {
        let (inner, events) = self.inner.spawn().await.map_err(js_error)?;
        Ok(Self::from_parts(inner, events, self.subagents.clone()))
    }

    /// Changes the reasoning effort for subsequently accepted turns.
    ///
    /// # Errors
    ///
    /// Rejects an invalid effort or a stopped driver.
    #[wasm_bindgen(js_name = setThinking)]
    pub async fn set_thinking(&self, thinking: &str) -> Result<(), JsValue> {
        self.inner
            .set_thinking(thinking.parse::<Thinking>().map_err(js_error)?)
            .await
            .map_err(js_error)
    }

    /// Enables or disables priority processing for subsequently accepted turns.
    ///
    /// # Errors
    ///
    /// Rejects after the driver stops.
    #[wasm_bindgen(js_name = setFastMode)]
    pub async fn set_fast_mode(&self, enabled: bool) -> Result<(), JsValue> {
        self.inner.set_fast_mode(enabled).await.map_err(js_error)
    }

    /// Compacts retained history immediately without fabricating a user prompt.
    ///
    /// # Errors
    ///
    /// Throws when compaction or the agent driver fails.
    pub async fn compact(&self) -> Result<(), JsValue> {
        self.inner.compact().await.map_err(js_error)
    }

    /// Gracefully stops the driver and joins every resource owned by this agent.
    ///
    /// # Errors
    ///
    /// Rejects when the driver had already stopped or cleanup fails.
    pub async fn shutdown(&self) -> Result<(), JsValue> {
        if let Some(subagents) = &self.subagents {
            subagents
                .close_all(&self.inner.session_id().to_string())
                .await
                .map_err(js_error)?;
        }
        self.inner.shutdown().await.map_err(js_error)
    }
}

impl WasmNanocodex {
    fn from_parts(
        inner: RustNanocodex,
        events: AgentEvents,
        subagents: Option<WasmSubagents>,
    ) -> Self {
        forward_events(events);
        Self { inner, subagents }
    }
}

struct TurnState {
    control: Option<TurnControl>,
    completed: Option<Result<TurnResult, String>>,
    waiters: Vec<oneshot::Sender<()>>,
}

impl TurnState {
    fn notify(&mut self) {
        for waiter in self.waiters.drain(..) {
            let _ = waiter.send(());
        }
    }
}

/// JavaScript binding over one shared Rust turn.
#[wasm_bindgen(js_name = Turn)]
pub struct WasmTurn {
    state: Rc<RefCell<TurnState>>,
}

#[wasm_bindgen(js_class = Turn)]
impl WasmTurn {
    /// Injects text input at the active turn's next safe model boundary.
    ///
    /// # Errors
    ///
    /// Rejects if the turn is not active or its driver stopped.
    pub async fn steer(&self, instruction: &str) -> Result<(), JsValue> {
        if instruction.trim().is_empty() {
            return Err(js_error("steer instruction must not be empty"));
        }
        self.control()
            .await
            .map_err(js_error)?
            .steer(Prompt::new(instruction))
            .await
            .map_err(js_error)
    }

    /// Injects browser-safe multimodal input at the active turn's next boundary.
    ///
    /// # Errors
    ///
    /// Rejects malformed input or a turn that is no longer active.
    #[wasm_bindgen(js_name = steerContent)]
    pub async fn steer_content(&self, content_json: &str) -> Result<(), JsValue> {
        let prompt = parse_browser_prompt(content_json)?;
        self.control()
            .await
            .map_err(js_error)?
            .steer(prompt)
            .await
            .map_err(js_error)
    }

    /// Cancels this exact active or queued turn.
    ///
    /// # Errors
    ///
    /// Rejects if the turn is already terminal or its driver stopped.
    pub async fn cancel(&self) -> Result<(), JsValue> {
        self.control()
            .await
            .map_err(js_error)?
            .cancel()
            .await
            .map_err(js_error)
    }

    /// Waits for the final assistant message.
    ///
    /// # Errors
    ///
    /// Rejects when the model run or driver fails.
    pub async fn result(&self) -> Result<WasmTurnResult, JsValue> {
        self.completion()
            .await
            .map(|inner| WasmTurnResult { inner })
            .map_err(js_error)
    }
}

impl WasmTurn {
    fn accept(agent: RustNanocodex, prompt: Prompt) -> Self {
        let state = Rc::new(RefCell::new(TurnState {
            control: None,
            completed: None,
            waiters: Vec::new(),
        }));
        let task_state = Rc::clone(&state);
        spawn_local(async move {
            let completed = match agent.prompt(prompt).await {
                Ok(turn) => {
                    {
                        let mut state = task_state.borrow_mut();
                        state.control = Some(turn.control());
                        state.notify();
                    }
                    turn.await.map_err(|error| error.to_string())
                }
                Err(error) => Err(error.to_string()),
            };
            let mut state = task_state.borrow_mut();
            state.control = None;
            state.completed = Some(completed);
            state.notify();
        });
        Self { state }
    }

    async fn control(&self) -> Result<TurnControl, String> {
        loop {
            let notified = {
                let mut state = self.state.borrow_mut();
                if let Some(control) = &state.control {
                    return Ok(control.clone());
                }
                if let Some(completed) = &state.completed {
                    return Err(completed
                        .as_ref()
                        .err()
                        .cloned()
                        .unwrap_or_else(|| "the turn is already complete".to_owned()));
                }
                let (notify, notified) = oneshot::channel();
                state.waiters.push(notify);
                notified
            };
            notified
                .await
                .map_err(|_| "the turn stopped before it was accepted".to_owned())?;
        }
    }

    async fn completion(&self) -> Result<TurnResult, String> {
        loop {
            let notified = {
                let mut state = self.state.borrow_mut();
                if let Some(completed) = &state.completed {
                    return completed.clone();
                }
                let (notify, notified) = oneshot::channel();
                state.waiters.push(notify);
                notified
            };
            notified
                .await
                .map_err(|_| "the turn stopped before it completed".to_owned())?;
        }
    }
}

/// JavaScript binding over one completed Rust turn result.
#[wasm_bindgen(js_name = TurnResult)]
pub struct WasmTurnResult {
    inner: TurnResult,
}

#[wasm_bindgen(js_class = TurnResult)]
impl WasmTurnResult {
    /// Returns the final assistant message.
    #[wasm_bindgen(getter, js_name = finalMessage)]
    #[must_use]
    pub fn final_message(&self) -> String {
        self.inner.final_message().to_owned()
    }

    /// Serializes this completed boundary's resumable session snapshot.
    ///
    /// # Errors
    ///
    /// Throws when serialization fails.
    pub fn snapshot(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner.snapshot()).map_err(js_error)
    }

    /// Serializes exact aggregate usage for this completed logical turn.
    ///
    /// # Errors
    ///
    /// Throws when serialization fails.
    pub fn usage(&self) -> Result<String, JsValue> {
        serde_json::to_string(self.inner.usage()).map_err(js_error)
    }
}

fn forward_events(mut events: AgentEvents) {
    spawn_local(async move {
        while let Some(event) = events.recv().await {
            if let Ok(encoded) = serde_json::to_string(&event) {
                host_emit_event(&encoded);
            }
        }
    });
}

fn forward_subagent_updates(
    mut updates: tokio::sync::mpsc::UnboundedReceiver<ScopedAgentUpdate>,
    sessions: Rc<RefCell<HashMap<(String, SubagentId), String>>>,
) {
    spawn_local(async move {
        while let Some(scoped) = updates.recv().await {
            let root_session_id = scoped.root_session_id;
            match scoped.update {
                SubagentUpdate::Added(descriptor) => {
                    host_bind_subagent_session(&root_session_id, &descriptor.session_id);
                    sessions
                        .borrow_mut()
                        .insert((root_session_id, descriptor.id), descriptor.session_id);
                }
                SubagentUpdate::Event { event, .. } => {
                    if let Ok(encoded) = serde_json::to_string(&event) {
                        host_emit_event(&encoded);
                    }
                }
                SubagentUpdate::Status {
                    id,
                    status: SubagentStatus::Closed,
                } => {
                    let session_id = sessions.borrow_mut().remove(&(root_session_id, id));
                    if let Some(session_id) = session_id {
                        host_release_subagent_session(&session_id);
                    }
                }
                SubagentUpdate::Status { .. } | SubagentUpdate::Message(_) => {}
            }
        }
        let session_ids = sessions
            .borrow_mut()
            .drain()
            .map(|(_, session_id)| session_id)
            .collect::<Vec<_>>();
        for session_id in session_ids {
            host_release_subagent_session(&session_id);
        }
    });
}

fn release_subagent_scope(
    sessions: &Rc<RefCell<HashMap<(String, SubagentId), String>>>,
    root_session_id: &str,
) {
    let session_ids = {
        let mut sessions = sessions.borrow_mut();
        let keys = sessions
            .keys()
            .filter(|(root, _)| root == root_session_id)
            .cloned()
            .collect::<Vec<_>>();
        keys.into_iter()
            .filter_map(|key| sessions.remove(&key))
            .collect::<Vec<_>>()
    };
    for session_id in session_ids {
        host_release_subagent_session(&session_id);
    }
}

fn parse_browser_prompt(content_json: &str) -> Result<Prompt, JsValue> {
    let content = serde_json::from_str::<Vec<UserInput>>(content_json)
        .map_err(|error| js_error(format!("invalid prompt content: {error}")))?;
    if content.iter().any(|input| {
        matches!(
            input,
            UserInput::LocalImage { .. } | UserInput::LocalAudio { .. }
        )
    }) {
        return Err(js_error(
            "browser prompt content cannot reference local filesystem paths",
        ));
    }
    let prompt = Prompt::content(content);
    if prompt.instruction.is_empty() {
        return Err(js_error("prompt content must not be empty"));
    }
    Ok(prompt)
}

fn validate(config: &WasmConfig) -> Result<(), JsValue> {
    if config.host_definition_id == 0 {
        return Err(js_error("host_definition_id must be at least 1"));
    }
    for (name, value) in [
        ("api_key", config.api_key.as_str()),
        ("websocket_url", config.websocket_url.as_str()),
        ("api_base_url", config.api_base_url.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(js_error(format!("{name} must not be empty")));
        }
    }
    if config
        .session_id
        .as_deref()
        .is_some_and(|session_id| session_id.trim().is_empty())
    {
        return Err(js_error("session_id must not be empty"));
    }
    if config
        .subagents
        .is_some_and(|subagents| subagents.max_concurrency == 0)
    {
        return Err(js_error("subagents.max_concurrency must be at least 1"));
    }
    Ok(())
}

fn default_thinking() -> String {
    "high".to_owned()
}

fn default_model() -> String {
    Model::default().to_string()
}

fn default_reasoning_mode() -> String {
    "standard".to_owned()
}

fn default_websocket_url() -> String {
    "wss://api.openai.com/v1/responses".to_owned()
}

fn default_api_base_url() -> String {
    "https://api.openai.com/v1".to_owned()
}

const fn default_max_subagents() -> usize {
    nanocodex_subagents::DEFAULT_MAX_SUBAGENTS
}

fn host_error_message(error: &JsValue) -> String {
    error.as_string().unwrap_or_else(|| format!("{error:?}"))
}

#[allow(clippy::needless_pass_by_value)]
fn js_error(error: impl ToString) -> JsValue {
    js_sys::Error::new(&error.to_string()).into()
}
