use std::{cell::RefCell, rc::Rc};

use js_sys::Promise;
use nanocodex::{
    AgentEvents, Model, Nanocodex as RustNanocodex, OpenAi, ReasoningMode, Thinking, TurnControl,
    TurnResult,
    agent::{
        input::{Prompt, UserInput},
        session::{SessionId, SessionSnapshot},
    },
    tools::{
        ToolContext, ToolDefinition, ToolInput, ToolOutput,
        contract::ToolOutputWire,
        hosted::{
            CodeModeExecution, CodeModeHost, CodeModeHostError, HostFuture, HostedToolMode,
            HostedTools,
        },
    },
};
use serde::Deserialize;
use tokio::sync::oneshot;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::{JsFuture, spawn_local};

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

    #[wasm_bindgen(js_namespace = ["globalThis", "nanocodexHost"], js_name = toolMode)]
    fn host_tool_mode(session_id: &str) -> String;

    #[wasm_bindgen(catch, js_namespace = ["globalThis", "nanocodexHost"], js_name = toolDefinitions)]
    fn host_tool_definitions(session_id: &str) -> Result<String, JsValue>;
}

struct JavaScriptCodeModeHost {
    mode: HostedToolMode,
}

impl JavaScriptCodeModeHost {
    fn new() -> Self {
        Self {
            mode: if host_tool_mode("") == "direct" {
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
        let encoded = host_tool_definitions(session_id)
            .map_err(|error| CodeModeHostError::new(host_error_message(&error)))?;
        serde_json::from_str(&encoded).map_err(|error| {
            CodeModeHostError::new(format!(
                "JavaScript Code Mode host returned invalid tool definitions: {error}"
            ))
        })
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
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WasmConfig {
    api_key: String,
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
    resume: Option<SessionSnapshot>,
}

/// JavaScript binding over the shared Rust agent lifecycle.
#[wasm_bindgen(js_name = Nanocodex)]
pub struct WasmNanocodex {
    inner: RustNanocodex,
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
        validate(&config)?;

        let model = config.model.parse::<Model>().map_err(js_error)?;
        let thinking = config.thinking.parse::<Thinking>().map_err(js_error)?;
        let reasoning_mode = config
            .reasoning_mode
            .parse::<ReasoningMode>()
            .map_err(js_error)?;
        let openai = OpenAi::builder(config.api_key)
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
        let mut builder =
            RustNanocodex::builder(openai).tools(HostedTools::new(JavaScriptCodeModeHost::new()));
        if let Some(instructions) = config.instructions {
            builder = builder.instructions(instructions);
        }
        if let Some(session_id) = config.session_id {
            builder = builder.session_id(session_id.parse::<SessionId>().map_err(js_error)?);
        }
        if let Some(workspace) = config.workspace {
            builder = builder.workspace(workspace);
        }
        if let Some(resume) = config.resume {
            builder = builder.resume(resume);
        }
        let (inner, events) = builder.build().map_err(js_error)?;
        Ok(Self::from_parts(inner, events))
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
        Ok(Self::from_parts(inner, events))
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
        Ok(Self::from_parts(inner, events))
    }

    /// Starts a clean sibling with the same private agent policy.
    ///
    /// # Errors
    ///
    /// Rejects after the driver stops.
    pub async fn spawn(&self) -> Result<Self, JsValue> {
        let (inner, events) = self.inner.spawn().await.map_err(js_error)?;
        Ok(Self::from_parts(inner, events))
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
        self.inner.shutdown().await.map_err(js_error)
    }
}

impl WasmNanocodex {
    fn from_parts(inner: RustNanocodex, events: AgentEvents) -> Self {
        forward_events(events);
        Self { inner }
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

fn host_error_message(error: &JsValue) -> String {
    error.as_string().unwrap_or_else(|| format!("{error:?}"))
}

#[allow(clippy::needless_pass_by_value)]
fn js_error(error: impl ToString) -> JsValue {
    js_sys::Error::new(&error.to_string()).into()
}
