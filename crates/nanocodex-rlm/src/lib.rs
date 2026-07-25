//! Recursive, structured child-task tools for Nanocodex Code Mode.
//!
//! The crate is intentionally a thin consumer of Nanocodex's public agent and
//! tool APIs. Retain a [`TaskRuntime`] for as long as installed tools should
//! remain usable, and capture the weak [`TaskTools`] value in the agent's tools
//! factory so clean children receive fresh agent-relative handlers.

use std::{
    collections::HashMap,
    io,
    sync::{
        Arc, Mutex as StdMutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
};

use futures_util::future::join_all;
use jsonschema::Validator;
use nanocodex::{
    AgentEvents, AgentHandle, Nanocodex, Tool, ToolContext, ToolDefinition, ToolError,
    ToolExecution, ToolInput, ToolResult, Tools, ToolsBuildError, TurnControl, async_trait,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    sync::{Mutex, Semaphore},
    task::JoinHandle,
};
use uuid::Uuid;

const MAX_DEPTH: usize = 4;
const MAX_BATCH_SIZE: usize = 16;
const MAX_ACTIVE_TASKS: usize = 64;

/// Owning lifecycle for one family of retained recursive task tools.
#[derive(Clone)]
pub struct TaskRuntime {
    state: Arc<TaskState>,
}

impl Default for TaskRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl TaskRuntime {
    /// Creates an enabled task runtime with conservative fixed bounds.
    #[must_use]
    pub fn new() -> Self {
        Self {
            state: Arc::new(TaskState {
                enabled: AtomicBool::new(true),
                active: Arc::new(Semaphore::new(MAX_ACTIVE_TASKS)),
                registry: Mutex::new(Registry::default()),
            }),
        }
    }

    /// Returns weak, cycle-free tool installation state for a tools factory.
    #[must_use]
    pub fn tools(&self) -> TaskTools {
        TaskTools {
            state: Arc::downgrade(&self.state),
        }
    }

    /// Enables or disables new task, batch, and continuation calls.
    ///
    /// A task already accepted continues to completion so it can submit its
    /// structured result and commit a safe child transcript boundary.
    pub fn set_enabled(&self, enabled: bool) {
        self.state.enabled.store(enabled, Ordering::Release);
    }

    /// Reports whether new recursive task calls are enabled.
    #[must_use]
    pub fn is_enabled(&self) -> bool {
        self.state.enabled.load(Ordering::Acquire)
    }

    /// Drops all retained children and waits for their event drains to stop.
    pub async fn shutdown(&self) {
        self.set_enabled(false);
        let sessions = {
            let mut registry = self.state.registry.lock().await;
            registry.depths.clear();
            registry.pending.clear();
            std::mem::take(&mut registry.tasks)
        };
        let mut event_tasks = Vec::with_capacity(sessions.len());
        for session in sessions.values() {
            if let Ok(mut event_task) = session.event_task.lock()
                && let Some(event_task) = event_task.take()
            {
                event_tasks.push(event_task);
            }
        }
        drop(sessions);
        for event_task in event_tasks {
            let _ = event_task.await;
        }
    }
}

/// Weak task-tool installer intended to be captured by `tools_factory`.
#[derive(Clone)]
pub struct TaskTools {
    state: Weak<TaskState>,
}

impl TaskTools {
    /// Adds `task`, `task_batch`, `task_continue`, and `submit_result` to a
    /// per-agent tool collection.
    ///
    /// # Errors
    ///
    /// Returns the normal tool-registry validation errors.
    pub fn install(&self, tools: Tools, agent: AgentHandle) -> Result<Tools, ToolsBuildError> {
        tools
            .into_builder()
            .tool(TaskTool {
                agent: agent.clone(),
                state: self.state.clone(),
            })
            .tool(TaskBatchTool {
                agent,
                state: self.state.clone(),
            })
            .tool(TaskContinueTool {
                state: self.state.clone(),
            })
            .tool(SubmitResultTool {
                state: self.state.clone(),
            })
            .build()
    }
}

struct TaskState {
    enabled: AtomicBool,
    active: Arc<Semaphore>,
    registry: Mutex<Registry>,
}

#[derive(Default)]
struct Registry {
    tasks: HashMap<Box<str>, Arc<ChildSession>>,
    depths: HashMap<Box<str>, usize>,
    pending: HashMap<Box<str>, PendingSubmission>,
}

struct ChildSession {
    agent: Nanocodex,
    turn: Mutex<()>,
    event_task: StdMutex<Option<JoinHandle<()>>>,
}

struct PendingSubmission {
    token: Uuid,
    validator: Validator,
    output: Option<Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TaskArgs {
    instruction: String,
    #[serde(default)]
    context: Option<Value>,
    output_schema: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BatchTaskArgs {
    instruction: String,
    #[serde(default)]
    context: Option<Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TaskBatchArgs {
    tasks: Vec<BatchTaskArgs>,
    output_schema: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TaskContinueArgs {
    task_id: Box<str>,
    instruction: String,
    #[serde(default)]
    context: Option<Value>,
    output_schema: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SubmitResultArgs {
    output: Value,
}

#[derive(Serialize)]
struct TaskSuccess {
    task_id: Box<str>,
    output: Value,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum BatchTaskResult {
    Completed { task_id: Box<str>, output: Value },
    Failed { task_id: Box<str>, error: String },
}

#[derive(Clone, Copy)]
enum FailureRetention {
    Drop,
    Retain,
}

struct TaskTool {
    agent: AgentHandle,
    state: Weak<TaskState>,
}

struct TaskBatchTool {
    agent: AgentHandle,
    state: Weak<TaskState>,
}

struct TaskContinueTool {
    state: Weak<TaskState>,
}

struct SubmitResultTool {
    state: Weak<TaskState>,
}

#[async_trait]
impl Tool for TaskTool {
    fn name(&self) -> &'static str {
        "task"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition::function(
            self.name(),
            "Runs one isolated clean-room child task and returns exactly one runtime-schema-validated result. The child receives only the instruction and explicitly supplied context.",
            task_parameters(),
        )
        .with_output_schema(task_success_schema())
    }

    async fn execute(&self, input: ToolInput, context: ToolContext<'_>) -> ToolResult {
        let args: TaskArgs = input.decode_json()?;
        let state = upgrade(&self.state)?;
        ensure_enabled(&state)?;
        validate_instruction(&args.instruction)?;
        let task_id = new_task_id();
        let result = run_new_task(
            Arc::clone(&state),
            &self.agent,
            context.session_id,
            task_id.clone(),
            args,
            None,
            FailureRetention::Drop,
        )
        .await?;
        Ok(ToolExecution::json(&TaskSuccess {
            task_id,
            output: result,
        }))
    }
}

#[async_trait]
impl Tool for TaskBatchTool {
    fn name(&self) -> &'static str {
        "task_batch"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition::function(
            self.name(),
            "Runs a bounded batch of isolated clean-room child tasks concurrently. All tasks share the runtime output schema; results stay in input order and individual failures do not discard successful siblings.",
            task_batch_parameters(),
        )
        .with_output_schema(task_batch_output_schema())
    }

    async fn execute(&self, input: ToolInput, context: ToolContext<'_>) -> ToolResult {
        let args: TaskBatchArgs = input.decode_json()?;
        let state = upgrade(&self.state)?;
        ensure_enabled(&state)?;
        if args.tasks.is_empty() {
            return Err(tool_error("task_batch requires at least one task"));
        }
        if args.tasks.len() > MAX_BATCH_SIZE {
            return Err(tool_error(format!(
                "task_batch accepts at most {MAX_BATCH_SIZE} tasks"
            )));
        }
        for task in &args.tasks {
            validate_instruction(&task.instruction)?;
        }
        let validator = Arc::new(compile_schema(&args.output_schema)?);

        let schema = Arc::new(args.output_schema);
        let parent_session_id = Arc::<str>::from(context.session_id);
        let futures = args.tasks.into_iter().map(|task| {
            let state = Arc::clone(&state);
            let agent = self.agent.clone();
            let schema = Arc::clone(&schema);
            let validator = Arc::clone(&validator);
            let parent_session_id = Arc::clone(&parent_session_id);
            async move {
                let task_id = new_task_id();
                let args = TaskArgs {
                    instruction: task.instruction,
                    context: task.context,
                    output_schema: (*schema).clone(),
                };
                match run_new_task(
                    state,
                    &agent,
                    &parent_session_id,
                    task_id.clone(),
                    args,
                    Some((*validator).clone()),
                    FailureRetention::Retain,
                )
                .await
                {
                    Ok(output) => BatchTaskResult::Completed { task_id, output },
                    Err(error) => BatchTaskResult::Failed {
                        task_id,
                        error: error.to_string(),
                    },
                }
            }
        });
        let results = join_all(futures).await;
        Ok(ToolExecution::json(&results))
    }
}

#[async_trait]
impl Tool for TaskContinueTool {
    fn name(&self) -> &'static str {
        "task_continue"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition::function(
            self.name(),
            "Runs a follow-up turn on one retained child task. Only that child's prior conversation is preserved; optional new context remains explicit.",
            task_continue_parameters(),
        )
        .with_output_schema(task_success_schema())
    }

    async fn execute(&self, input: ToolInput, _context: ToolContext<'_>) -> ToolResult {
        let args: TaskContinueArgs = input.decode_json()?;
        let state = upgrade(&self.state)?;
        ensure_enabled(&state)?;
        validate_instruction(&args.instruction)?;
        let validator = compile_schema(&args.output_schema)?;
        let _active = Arc::clone(&state.active)
            .try_acquire_owned()
            .map_err(|_| tool_error("task concurrency limit reached"))?;
        let child = {
            let registry = state.registry.lock().await;
            registry.tasks.get(&args.task_id).cloned()
        }
        .ok_or_else(|| tool_error(format!("unknown task_id {}", args.task_id)))?;
        let _turn = child.turn.lock().await;
        let output = run_child_turn(
            &state,
            &child.agent,
            &args.instruction,
            args.context.as_ref(),
            &args.output_schema,
            validator,
        )
        .await?;
        Ok(ToolExecution::json(&TaskSuccess {
            task_id: args.task_id,
            output,
        }))
    }
}

#[async_trait]
impl Tool for SubmitResultTool {
    fn name(&self) -> &'static str {
        "submit_result"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition::function(
            self.name(),
            "Returns the current child task's final structured output. This is task-internal plumbing: call it exactly once with an output matching the runtime schema in the task prompt.",
            json!({
                "type": "object",
                "properties": {
                    "output": {
                        "description": "The final JSON value required by the current task's runtime output schema."
                    }
                },
                "required": ["output"],
                "additionalProperties": false
            }),
        )
        .with_output_schema(json!({
            "type": "object",
            "properties": {
                "accepted": { "type": "boolean", "const": true }
            },
            "required": ["accepted"],
            "additionalProperties": false
        }))
    }

    async fn execute(&self, input: ToolInput, context: ToolContext<'_>) -> ToolResult {
        let SubmitResultArgs { output } = input.decode_json()?;
        let state = upgrade(&self.state)?;
        state.submit(context.session_id, output).await?;
        Ok(ToolExecution::from_json(json!({ "accepted": true }), true))
    }
}

async fn run_new_task(
    state: Arc<TaskState>,
    agent: &AgentHandle,
    parent_session_id: &str,
    task_id: Box<str>,
    args: TaskArgs,
    validator: Option<Validator>,
    failure_retention: FailureRetention,
) -> Result<Value, ToolError> {
    ensure_enabled(&state)?;
    let validator = match validator {
        Some(validator) => validator,
        None => compile_schema(&args.output_schema)?,
    };
    let depth = {
        let registry = state.registry.lock().await;
        registry.depths.get(parent_session_id).copied().unwrap_or(0)
    };
    if depth >= MAX_DEPTH {
        return Err(tool_error(format!(
            "task recursion depth limit {MAX_DEPTH} reached"
        )));
    }
    let _active = Arc::clone(&state.active)
        .try_acquire_owned()
        .map_err(|_| tool_error("task concurrency limit reached"))?;
    let (child, events) = agent.spawn().await?;
    let child_session_id: Box<str> = child.session_id().into();
    let event_task = drain_events(events);
    let session = Arc::new(ChildSession {
        agent: child,
        turn: Mutex::new(()),
        event_task: StdMutex::new(Some(event_task)),
    });
    {
        let mut registry = state.registry.lock().await;
        registry
            .depths
            .insert(child_session_id.clone(), depth.saturating_add(1));
        registry.tasks.insert(task_id.clone(), Arc::clone(&session));
    }
    let mut task_guard = NewTaskGuard::new(Arc::downgrade(&state), task_id, child_session_id);
    let _turn = session.turn.lock().await;
    let result = run_child_turn(
        &state,
        &session.agent,
        &args.instruction,
        args.context.as_ref(),
        &args.output_schema,
        validator,
    )
    .await;
    if result.is_ok() || matches!(failure_retention, FailureRetention::Retain) {
        task_guard.disarm();
    }
    result
}

async fn run_child_turn(
    state: &Arc<TaskState>,
    child: &Nanocodex,
    instruction: &str,
    context: Option<&Value>,
    output_schema: &Value,
    validator: Validator,
) -> Result<Value, ToolError> {
    let session_id: Box<str> = child.session_id().into();
    let token = Uuid::now_v7();
    {
        let mut registry = state.registry.lock().await;
        if registry.pending.contains_key(&session_id) {
            return Err(tool_error("child already has a pending structured task"));
        }
        registry.pending.insert(
            session_id.clone(),
            PendingSubmission {
                token,
                validator,
                output: None,
            },
        );
    }
    let mut guard = TaskTurnGuard::new(Arc::downgrade(state), session_id.clone(), token);
    let prompt = task_prompt(instruction, context, output_schema)?;
    let turn = child.prompt(prompt).await?;
    guard.control = Some(turn.control());
    let result = turn.result().await;
    guard.disarm();
    let submitted = state.take_submission(&session_id, token).await;
    result?;
    submitted.ok_or_else(|| {
        tool_error("child task ended without one valid submit_result({ output }) call")
    })
}

impl TaskState {
    async fn submit(&self, session_id: &str, output: Value) -> Result<(), ToolError> {
        let mut registry = self.registry.lock().await;
        let pending = registry
            .pending
            .get_mut(session_id)
            .ok_or_else(|| tool_error("submit_result is only available during a child task"))?;
        if pending.output.is_some() {
            return Err(tool_error(
                "submit_result already accepted one result for this task",
            ));
        }
        let errors = pending
            .validator
            .iter_errors(&output)
            .take(4)
            .map(|error| error.to_string())
            .collect::<Vec<_>>();
        if !errors.is_empty() {
            return Err(tool_error(format!(
                "submitted output does not match the required schema: {}",
                errors.join("; ")
            )));
        }
        pending.output = Some(output);
        Ok(())
    }

    async fn take_submission(&self, session_id: &str, token: Uuid) -> Option<Value> {
        let mut registry = self.registry.lock().await;
        let matches = registry
            .pending
            .get(session_id)
            .is_some_and(|pending| pending.token == token);
        if !matches {
            return None;
        }
        registry
            .pending
            .remove(session_id)
            .and_then(|pending| pending.output)
    }

    async fn clear_submission(&self, session_id: &str, token: Uuid) {
        let mut registry = self.registry.lock().await;
        if registry
            .pending
            .get(session_id)
            .is_some_and(|pending| pending.token == token)
        {
            registry.pending.remove(session_id);
        }
    }

    async fn remove_task(&self, task_id: &str, session_id: &str) {
        let mut registry = self.registry.lock().await;
        registry.tasks.remove(task_id);
        registry.depths.remove(session_id);
        registry.pending.remove(session_id);
    }
}

struct NewTaskGuard {
    state: Weak<TaskState>,
    task_id: Box<str>,
    session_id: Box<str>,
    armed: bool,
}

impl NewTaskGuard {
    fn new(state: Weak<TaskState>, task_id: Box<str>, session_id: Box<str>) -> Self {
        Self {
            state,
            task_id,
            session_id,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for NewTaskGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let state = self.state.clone();
        let task_id = self.task_id.clone();
        let session_id = self.session_id.clone();
        tokio::spawn(async move {
            if let Some(state) = state.upgrade() {
                state.remove_task(&task_id, &session_id).await;
            }
        });
    }
}

struct TaskTurnGuard {
    state: Weak<TaskState>,
    session_id: Box<str>,
    token: Uuid,
    control: Option<TurnControl>,
    armed: bool,
}

impl TaskTurnGuard {
    fn new(state: Weak<TaskState>, session_id: Box<str>, token: Uuid) -> Self {
        Self {
            state,
            session_id,
            token,
            control: None,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
        self.control = None;
    }
}

impl Drop for TaskTurnGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let state = self.state.clone();
        let session_id = self.session_id.clone();
        let token = self.token;
        let control = self.control.take();
        tokio::spawn(async move {
            if let Some(control) = control {
                let _ = control.cancel().await;
            }
            if let Some(state) = state.upgrade() {
                state.clear_submission(&session_id, token).await;
            }
        });
    }
}

fn drain_events(mut events: AgentEvents) -> JoinHandle<()> {
    tokio::spawn(async move { while events.recv().await.is_some() {} })
}

fn compile_schema(schema: &Value) -> Result<Validator, ToolError> {
    jsonschema::validator_for(schema)
        .map_err(|error| tool_error(format!("invalid output_schema: {error}")))
}

fn task_prompt(
    instruction: &str,
    context: Option<&Value>,
    output_schema: &Value,
) -> Result<String, ToolError> {
    let context = serde_json::to_string_pretty(&context.unwrap_or(&Value::Null))?;
    let schema = serde_json::to_string_pretty(output_schema)?;
    Ok(format!(
        "Work as an isolated child agent. You have no inherited parent transcript. Use only the \
         task instruction, the explicit context below, your own conversation, and normally \
         available workspace/tools.\n\nYour contractual result is not prose. Before finishing, \
         use Code Mode to call `await tools.submit_result({{ output: ... }})` exactly once with a \
         JSON value matching the output schema. If validation rejects it, correct the value and \
         retry. After a result is accepted, finish the turn concisely.\n\n\
         <task_instruction>\n{instruction}\n</task_instruction>\n\n\
         <explicit_context>\n{context}\n</explicit_context>\n\n\
         <output_schema>\n{schema}\n</output_schema>"
    ))
}

fn validate_instruction(instruction: &str) -> Result<(), ToolError> {
    if instruction.trim().is_empty() {
        return Err(tool_error("task instruction must not be empty"));
    }
    Ok(())
}

fn ensure_enabled(state: &TaskState) -> Result<(), ToolError> {
    if !state.enabled.load(Ordering::Acquire) {
        return Err(tool_error(
            "recursive task tools are disabled; enable the application task mode first",
        ));
    }
    Ok(())
}

fn upgrade(state: &Weak<TaskState>) -> Result<Arc<TaskState>, ToolError> {
    state
        .upgrade()
        .ok_or_else(|| tool_error("task runtime stopped"))
}

fn new_task_id() -> Box<str> {
    format!("task_{}", Uuid::now_v7()).into_boxed_str()
}

fn tool_error(error: impl Into<String>) -> ToolError {
    Box::new(io::Error::other(error.into()))
}

fn task_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "instruction": {
                "type": "string",
                "description": "A complete focused instruction for the clean child."
            },
            "context": {
                "description": "Optional explicit JSON context selected by the parent, commonly from context()."
            },
            "output_schema": {
                "description": "The runtime JSON Schema that the child's submitted output must satisfy."
            }
        },
        "required": ["instruction", "output_schema"],
        "additionalProperties": false
    })
}

fn task_batch_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "tasks": {
                "type": "array",
                "minItems": 1,
                "maxItems": MAX_BATCH_SIZE,
                "items": {
                    "type": "object",
                    "properties": {
                        "instruction": { "type": "string" },
                        "context": {
                            "description": "Optional explicit JSON context for only this child."
                        }
                    },
                    "required": ["instruction"],
                    "additionalProperties": false
                }
            },
            "output_schema": {
                "description": "One runtime JSON Schema shared by every child output in this batch."
            }
        },
        "required": ["tasks", "output_schema"],
        "additionalProperties": false
    })
}

fn task_continue_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "task_id": {
                "type": "string",
                "description": "The opaque task_id returned by task or task_batch."
            },
            "instruction": {
                "type": "string",
                "description": "A complete focused follow-up instruction for the retained child."
            },
            "context": {
                "description": "Optional new explicit JSON context for this child turn."
            },
            "output_schema": {
                "description": "The runtime JSON Schema that this follow-up output must satisfy."
            }
        },
        "required": ["task_id", "instruction", "output_schema"],
        "additionalProperties": false
    })
}

fn task_success_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "task_id": { "type": "string" },
            "output": {}
        },
        "required": ["task_id", "output"],
        "additionalProperties": false
    })
}

fn task_batch_output_schema() -> Value {
    json!({
        "type": "array",
        "items": {
            "oneOf": [
                {
                    "type": "object",
                    "properties": {
                        "status": { "type": "string", "const": "completed" },
                        "task_id": { "type": "string" },
                        "output": {}
                    },
                    "required": ["status", "task_id", "output"],
                    "additionalProperties": false
                },
                {
                    "type": "object",
                    "properties": {
                        "status": { "type": "string", "const": "failed" },
                        "task_id": { "type": "string" },
                        "error": { "type": "string" }
                    },
                    "required": ["status", "task_id", "error"],
                    "additionalProperties": false
                }
            ]
        }
    })
}

#[cfg(test)]
mod tests {
    use nanocodex::{Tool, ToolContext, ToolInput};
    use serde_json::{Value, json, value::to_raw_value};

    use super::{SubmitResultArgs, SubmitResultTool, TaskRuntime, compile_schema};

    #[test]
    fn compiles_runtime_output_schema() {
        let validator = compile_schema(&json!({
            "type": "object",
            "properties": { "answer": { "type": "integer" } },
            "required": ["answer"],
            "additionalProperties": false
        }))
        .expect("schema should compile");
        assert!(validator.is_valid(&json!({ "answer": 42 })));
        assert!(!validator.is_valid(&json!({ "answer": "42" })));
    }

    #[tokio::test]
    async fn submit_result_rejects_invalid_and_duplicate_values() {
        let runtime = TaskRuntime::new();
        let token = uuid::Uuid::now_v7();
        runtime.state.registry.lock().await.pending.insert(
            "child".into(),
            super::PendingSubmission {
                token,
                validator: compile_schema(&json!({
                    "type": "object",
                    "properties": { "answer": { "type": "integer" } },
                    "required": ["answer"],
                    "additionalProperties": false
                }))
                .expect("schema should compile"),
                output: None,
            },
        );
        let tool = SubmitResultTool {
            state: std::sync::Arc::downgrade(&runtime.state),
        };
        let history = Vec::new();
        let context = ToolContext {
            model: "test",
            session_id: "child",
            call_id: "call",
            history: &history,
            output_token_budget: 100,
        };

        let invalid = input(&json!({ "output": { "answer": "nope" } }));
        assert!(tool.execute(invalid, context).await.is_err());

        let valid = input(&json!({ "output": { "answer": 42 } }));
        assert!(tool.execute(valid, context).await.is_ok());

        let duplicate = input(&json!({ "output": { "answer": 43 } }));
        assert!(tool.execute(duplicate, context).await.is_err());
        assert_eq!(
            runtime.state.take_submission("child", token).await,
            Some(json!({ "answer": 42 }))
        );
    }

    fn input(value: &Value) -> ToolInput {
        let args: SubmitResultArgs =
            serde_json::from_value(value.clone()).expect("test input should decode");
        drop(args);
        ToolInput::Function(to_raw_value(value).expect("test input should encode"))
    }
}
