use std::{path::PathBuf, sync::Arc};

use eyre::{Result, eyre};
use nanocodex_agent::{
    Nanocodex, NanocodexError, OpenAi, PromptRequest, ResponseError, Tools, session::SessionId,
};
use serde_json::json;

use nanocodex_durability::{
    DurableAgentExt, DurableSession, JournalStore, MemoryStore, StoreError, StoreFuture,
    StoredJournal,
};

fn temporary_workspace(label: &str) -> Result<PathBuf> {
    let path = std::env::temp_dir().join(format!("{label}-{}", SessionId::default()));
    std::fs::create_dir_all(&path)?;
    Ok(path)
}

fn test_session_id() -> SessionId {
    SessionId::default()
}

#[derive(Clone)]
struct FailAppendOnce {
    inner: crate::MemoryStore,
    expected_revision: u64,
    failed: Arc<std::sync::atomic::AtomicBool>,
}

impl crate::JournalStore for FailAppendOnce {
    fn load<'a>(
        &'a mut self,
        journal_id: &'a str,
    ) -> crate::StoreFuture<'a, std::result::Result<crate::StoredJournal, crate::StoreError>> {
        self.inner.load(journal_id)
    }

    fn append<'a>(
        &'a mut self,
        journal_id: &'a str,
        expected_revision: u64,
        payload: &'a str,
    ) -> crate::StoreFuture<'a, std::result::Result<u64, crate::StoreError>> {
        if expected_revision == self.expected_revision
            && !self.failed.swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            return Box::pin(async {
                Err(crate::StoreError::NotCommitted(
                    "injected append failure".to_owned(),
                ))
            });
        }
        self.inner.append(journal_id, expected_revision, payload)
    }
}

#[derive(Clone)]
struct DurableReplayService {
    generations: Arc<std::sync::atomic::AtomicUsize>,
}

struct CountingDurableTool {
    calls: Arc<std::sync::atomic::AtomicUsize>,
}

struct EphemeralSpawnTool {
    calls: Arc<std::sync::atomic::AtomicUsize>,
}

#[nanocodex_tools::contract::async_trait]
impl nanocodex_agent::Tool for CountingDurableTool {
    fn definition(&self) -> nanocodex_tools::ToolDefinition {
        nanocodex_tools::ToolDefinition::function(
            "count_once",
            "Increment a test-side effect exactly once.",
            json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        )
    }

    async fn execute(
        &self,
        _input: nanocodex_tools::ToolInput,
        _context: nanocodex_tools::ToolContext<'_>,
    ) -> nanocodex_tools::ToolResult {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(nanocodex_tools::ToolOutput::text("counted"))
    }
}

#[nanocodex_tools::contract::async_trait]
impl nanocodex_agent::Tool for EphemeralSpawnTool {
    fn definition(&self) -> nanocodex_tools::ToolDefinition {
        nanocodex_tools::ToolDefinition::function(
            "spawn_agent",
            "Create one process-owned child for the recovery regression.",
            json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        )
    }

    async fn execute(
        &self,
        _input: nanocodex_tools::ToolInput,
        _context: nanocodex_tools::ToolContext<'_>,
    ) -> nanocodex_tools::ToolResult {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(nanocodex_tools::ToolOutput::from_json(
            json!({
                "agent_id": 41,
                "role": "recovery probe",
                "status": { "state": "running" }
            }),
            true,
        ))
    }
}

#[derive(Clone)]
struct DurableToolService {
    generations: Arc<std::sync::atomic::AtomicUsize>,
}

#[derive(Clone)]
struct RemovedSpawnRecoveryService {
    generations: Arc<std::sync::atomic::AtomicUsize>,
}

impl tower::Service<nanocodex_oai_api::tower::ResponsesAttempt> for RemovedSpawnRecoveryService {
    type Response = nanocodex_oai_api::tower::ResponsesServiceResponse;
    type Error = ResponseError;
    type Future = std::future::Ready<std::result::Result<Self::Response, Self::Error>>;

    fn poll_ready(
        &mut self,
        _context: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::result::Result<(), Self::Error>> {
        std::task::Poll::Ready(Ok(()))
    }

    fn call(&mut self, request: nanocodex_oai_api::tower::ResponsesAttempt) -> Self::Future {
        use nanocodex_oai_api::{
            responses::{
                ContentItem, FunctionOutputBody, MessageRole, ResponseItem, WarmupResponse,
            },
            tower::{
                CodeCall, CodeCallKind, GenerationOutput, ResponsePipelineStats,
                ResponsesAttemptKind, ResponsesOutput, ResponsesServiceResponse,
            },
        };

        let output = match request.kind() {
            ResponsesAttemptKind::Warmup => ResponsesOutput::Warmup(WarmupResponse {
                id: "warmup".to_owned(),
                usage: None,
            }),
            ResponsesAttemptKind::Generation => {
                let generation = self
                    .generations
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if generation == 0 {
                    let item = serde_json::from_value(json!({
                        "type": "function_call",
                        "call_id": "call-spawn-agent",
                        "name": "spawn_agent",
                        "arguments": "{}"
                    }))
                    .expect("spawn tool call item decodes");
                    ResponsesOutput::Generation(GenerationOutput {
                        id: "spawn-response".to_owned(),
                        status: "completed".to_owned(),
                        end_turn: Some(false),
                        final_message: None,
                        output_items: vec![item],
                        code_calls: vec![CodeCall {
                            call_id: "call-spawn-agent".to_owned(),
                            name: "spawn_agent".to_owned(),
                            namespace: None,
                            input: "{}".to_owned(),
                            kind: CodeCallKind::Function,
                        }],
                        usage: None,
                        time_to_first_event_ns: 0,
                        time_to_first_output_ns: None,
                        pipeline_stats: ResponsePipelineStats::default(),
                    })
                } else {
                    let recovered_output = request.input_items().find_map(|item| match item {
                        ResponseItem::FunctionCallOutput {
                            call_id,
                            output: FunctionOutputBody::Text(output),
                            ..
                        } if &**call_id == "call-spawn-agent" => Some(output.as_ref()),
                        _ => None,
                    });
                    let recovered_output =
                        recovered_output.expect("recovery must return a failed spawn tool result");
                    assert!(recovered_output.contains(
                        "cannot replay completed tool call `spawn_agent` because the tool is unavailable"
                    ));
                    assert!(
                        !recovered_output.contains("agent_id"),
                        "the recovered model must not receive the dead child identity"
                    );
                    ResponsesOutput::Generation(GenerationOutput {
                        id: "recovered-response".to_owned(),
                        status: "completed".to_owned(),
                        end_turn: Some(true),
                        final_message: Some("recovered without a ghost child".to_owned()),
                        output_items: vec![ResponseItem::message(
                            MessageRole::Assistant,
                            [ContentItem::output_text("recovered without a ghost child")],
                        )],
                        code_calls: Vec::new(),
                        usage: None,
                        time_to_first_event_ns: 0,
                        time_to_first_output_ns: None,
                        pipeline_stats: ResponsePipelineStats::default(),
                    })
                }
            }
            kind => panic!("unexpected recovered-spawn attempt: {kind:?}"),
        };
        std::future::ready(Ok(ResponsesServiceResponse::new(output)))
    }
}

impl tower::Service<nanocodex_oai_api::tower::ResponsesAttempt> for DurableToolService {
    type Response = nanocodex_oai_api::tower::ResponsesServiceResponse;
    type Error = ResponseError;
    type Future = std::future::Ready<std::result::Result<Self::Response, Self::Error>>;

    fn poll_ready(
        &mut self,
        _context: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::result::Result<(), Self::Error>> {
        std::task::Poll::Ready(Ok(()))
    }

    fn call(&mut self, request: nanocodex_oai_api::tower::ResponsesAttempt) -> Self::Future {
        use nanocodex_oai_api::{
            responses::WarmupResponse,
            tower::{
                CodeCall, CodeCallKind, GenerationOutput, ResponsePipelineStats,
                ResponsesAttemptKind, ResponsesOutput, ResponsesServiceResponse,
            },
        };
        let output = match request.kind() {
            ResponsesAttemptKind::Warmup => ResponsesOutput::Warmup(WarmupResponse {
                id: "warmup".to_owned(),
                usage: None,
            }),
            ResponsesAttemptKind::Generation => {
                self.generations
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let item = serde_json::from_value(json!({
                    "type": "function_call",
                    "call_id": "call-count-once",
                    "name": "count_once",
                    "arguments": "{}"
                }))
                .expect("durable tool call item decodes");
                ResponsesOutput::Generation(GenerationOutput {
                    id: "durable-tool-response".to_owned(),
                    status: "completed".to_owned(),
                    end_turn: Some(false),
                    final_message: None,
                    output_items: vec![item],
                    code_calls: vec![CodeCall {
                        call_id: "call-count-once".to_owned(),
                        name: "count_once".to_owned(),
                        namespace: None,
                        input: "{}".to_owned(),
                        kind: CodeCallKind::Function,
                    }],
                    usage: None,
                    time_to_first_event_ns: 0,
                    time_to_first_output_ns: None,
                    pipeline_stats: ResponsePipelineStats::default(),
                })
            }
            kind => panic!("unexpected durable tool attempt: {kind:?}"),
        };
        std::future::ready(Ok(ResponsesServiceResponse::new(output)))
    }
}

impl tower::Service<nanocodex_oai_api::tower::ResponsesAttempt> for DurableReplayService {
    type Response = nanocodex_oai_api::tower::ResponsesServiceResponse;
    type Error = ResponseError;
    type Future = std::future::Ready<std::result::Result<Self::Response, Self::Error>>;

    fn poll_ready(
        &mut self,
        _context: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::result::Result<(), Self::Error>> {
        std::task::Poll::Ready(Ok(()))
    }

    fn call(&mut self, request: nanocodex_oai_api::tower::ResponsesAttempt) -> Self::Future {
        use nanocodex_oai_api::responses::WarmupResponse;
        use nanocodex_oai_api::tower::{
            GenerationOutput, ResponsePipelineStats, ResponsesAttemptKind, ResponsesOutput,
            ResponsesServiceResponse,
        };
        let output = match request.kind() {
            ResponsesAttemptKind::Warmup => ResponsesOutput::Warmup(WarmupResponse {
                id: "warmup".to_owned(),
                usage: None,
            }),
            ResponsesAttemptKind::Generation => {
                self.generations
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                ResponsesOutput::Generation(GenerationOutput {
                    id: "durable-response".to_owned(),
                    status: "completed".to_owned(),
                    end_turn: Some(true),
                    final_message: Some("durably replayed".to_owned()),
                    output_items: vec![nanocodex_oai_api::responses::ResponseItem::message(
                        nanocodex_oai_api::responses::MessageRole::Assistant,
                        [nanocodex_oai_api::responses::ContentItem::output_text(
                            "durably replayed",
                        )],
                    )],
                    code_calls: Vec::new(),
                    usage: None,
                    time_to_first_event_ns: 0,
                    time_to_first_output_ns: None,
                    pipeline_stats: ResponsePipelineStats::default(),
                })
            }
            kind => panic!("unexpected durable replay attempt: {kind:?}"),
        };
        std::future::ready(Ok(ResponsesServiceResponse::new(output)))
    }
}

#[tokio::test]
async fn configured_durability_automatically_journals_plain_prompts() -> Result<()> {
    let store = crate::MemoryStore::new()?;
    let journal = crate::DurableSession::open(store, "automatic-prompt").await?;
    let journal_state = journal.clone();
    let generations = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let openai = OpenAi::builder("test-key")
        .service({
            let generations = Arc::clone(&generations);
            move || DurableReplayService {
                generations: Arc::clone(&generations),
            }
        })
        .build()?;
    let workspace = temporary_workspace("automatic-portable-durability")?;
    let builder = Nanocodex::builder(openai)
        .workspace(&workspace)
        .session_id(test_session_id())
        .durability(journal)
        .await?;
    let (agent, events) = builder.build()?;

    let turn = agent.prompt("journal this automatically").await?;
    let generated_request_id = turn
        .request_id()
        .ok_or_else(|| eyre!("automatic durable request ID is missing"))?
        .to_owned();
    let result = turn.result().await?;
    assert_eq!(result.final_message(), "durably replayed");
    assert_eq!(result.request_id(), Some(generated_request_id.as_str()));
    let state = journal_state.state().await?;
    assert_eq!(state.operations().len(), 1);
    let generated_id = state
        .operations()
        .keys()
        .next()
        .ok_or_else(|| eyre!("automatic durable operation is missing"))?;
    assert_eq!(generated_id, &generated_request_id);
    assert!(generated_request_id.parse::<SessionId>().is_ok());
    assert!(journal_state.latest_checkpoint().await?.is_some());

    agent.shutdown().await?;
    drop((agent, events));
    std::fs::remove_dir_all(workspace)?;
    Ok(())
}

#[tokio::test]
async fn portable_journal_replays_a_completed_model_step_after_terminal_commit_failure()
-> Result<()> {
    let store = crate::MemoryStore::new()?;
    let failing_store = FailAppendOnce {
        inner: store.clone(),
        expected_revision: 4,
        failed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
    };
    let generations = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let openai = || {
        let generations = Arc::clone(&generations);
        OpenAi::builder("test-key")
            .service(move || DurableReplayService {
                generations: Arc::clone(&generations),
            })
            .build()
    };
    let workspace = temporary_workspace("portable-durability-model-replay")?;
    let journal = crate::DurableSession::open(failing_store, "portable-model-replay").await?;
    let builder = Nanocodex::builder(openai()?)
        .workspace(&workspace)
        .session_id(test_session_id())
        .durability(journal)
        .await?;
    let (agent, events) = builder.build()?;
    let first_turn = agent.prompt("replay this exact turn").await?;
    let first_request_id = first_turn
        .request_id()
        .ok_or_else(|| eyre!("first durable request ID is missing"))?
        .to_owned();
    let error = first_turn
        .result()
        .await
        .expect_err("the injected terminal append must fail the first attempt");
    assert!(error.to_string().contains("injected append failure"));
    agent.shutdown().await?;
    drop((agent, events));

    let journal = crate::DurableSession::open(store, "portable-model-replay").await?;
    let builder = Nanocodex::builder(openai()?)
        .workspace(&workspace)
        .session_id(test_session_id())
        .durability(journal)
        .await?;
    let (resumed, resumed_events) = builder.build()?;
    let recovered_turn = resumed.prompt("replay this exact turn").await?;
    assert_eq!(recovered_turn.request_id(), Some(first_request_id.as_str()));
    let result = recovered_turn.result().await?;
    assert_eq!(result.request_id(), Some(first_request_id.as_str()));
    assert_eq!(result.final_message(), "durably replayed");
    assert_eq!(
        generations.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "the recovered operation must use the Rust-journaled model output",
    );
    resumed.shutdown().await?;
    drop((resumed, resumed_events));
    std::fs::remove_dir_all(workspace)?;
    Ok(())
}

#[tokio::test]
async fn portable_journal_restores_the_live_owner_before_retrying_a_failed_commit() -> Result<()> {
    let store = crate::MemoryStore::new()?;
    let failing_store = FailAppendOnce {
        inner: store,
        expected_revision: 4,
        failed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
    };
    let generations = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let openai = {
        let generations = Arc::clone(&generations);
        OpenAi::builder("test-key")
            .service(move || DurableReplayService {
                generations: Arc::clone(&generations),
            })
            .build()?
    };
    let workspace = temporary_workspace("portable-durability-live-retry")?;
    let journal = crate::DurableSession::open(failing_store, "portable-model-live-retry").await?;
    let builder = Nanocodex::builder(openai)
        .workspace(&workspace)
        .session_id(test_session_id())
        .durability(journal)
        .await?;
    let (agent, events) = builder.build()?;

    let first = agent
        .prompt("replay this exact turn")
        .await?
        .result()
        .await
        .expect_err("the injected terminal append must fail the first attempt");
    assert!(first.to_string().contains("injected append failure"));

    let recovered = agent
        .prompt("replay this exact turn")
        .await?
        .result()
        .await?;
    assert_eq!(recovered.final_message(), "durably replayed");
    assert_eq!(
        generations.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "the live owner must roll back before replaying the journaled model output",
    );

    agent.shutdown().await?;
    drop((agent, events));
    std::fs::remove_dir_all(workspace)?;
    Ok(())
}

#[tokio::test]
async fn portable_journal_refuses_to_repeat_a_tool_with_an_ambiguous_completion() -> Result<()> {
    let store = crate::MemoryStore::new()?;
    let failing_store = FailAppendOnce {
        inner: store.clone(),
        expected_revision: 5,
        failed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
    };
    let generations = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let tool_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let openai = || {
        let generations = Arc::clone(&generations);
        OpenAi::builder("test-key")
            .service(move || DurableToolService {
                generations: Arc::clone(&generations),
            })
            .build()
    };
    let tools = || {
        Tools::builder()
            .without_defaults()
            .tool(CountingDurableTool {
                calls: Arc::clone(&tool_calls),
            })
            .build()
    };
    let workspace = temporary_workspace("portable-durability-ambiguous-tool")?;
    let journal = crate::DurableSession::open(failing_store, "ambiguous-tool").await?;
    let builder = Nanocodex::builder(openai()?)
        .workspace(&workspace)
        .session_id(test_session_id())
        .tools(tools()?)
        .durability(journal)
        .await?;
    let (agent, events) = builder.build()?;
    let first_turn = agent
        .prompt(PromptRequest::new("run the counter").request_id("turn-1"))
        .await?;
    assert_eq!(first_turn.request_id(), Some("turn-1"));
    let first = first_turn
        .result()
        .await
        .expect_err("the injected tool completion append must fail");
    assert!(first.to_string().contains("injected append failure"));
    agent.shutdown().await?;
    drop((agent, events));

    let journal = crate::DurableSession::open(store, "ambiguous-tool").await?;
    let builder = Nanocodex::builder(openai()?)
        .workspace(&workspace)
        .session_id(test_session_id())
        .tools(tools()?)
        .durability(journal)
        .await?;
    let (resumed, resumed_events) = builder.build()?;
    let recovered_turn = resumed
        .prompt(PromptRequest::new("run the counter").request_id("turn-1"))
        .await?;
    assert_eq!(recovered_turn.request_id(), Some("turn-1"));
    let recovered = recovered_turn
        .result()
        .await
        .expect_err("an unsafe unfinished tool must remain ambiguous");
    assert!(recovered.to_string().contains("ambiguous outcome"));
    assert_eq!(tool_calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(generations.load(std::sync::atomic::Ordering::SeqCst), 1);
    resumed.shutdown().await?;
    drop((resumed, resumed_events));
    std::fs::remove_dir_all(workspace)?;
    Ok(())
}

#[tokio::test]
async fn crash_after_spawn_before_wait_recovers_without_a_ghost_or_duplicate_child() -> Result<()> {
    let store = crate::MemoryStore::new()?;
    let failing_store = FailAppendOnce {
        inner: store.clone(),
        expected_revision: 6,
        failed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
    };
    let generations = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let spawn_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let openai = || {
        let generations = Arc::clone(&generations);
        OpenAi::builder("test-key")
            .service(move || RemovedSpawnRecoveryService {
                generations: Arc::clone(&generations),
            })
            .build()
    };
    let workspace = temporary_workspace("durability-spawn-recovery")?;
    let first_tools = Tools::builder()
        .without_defaults()
        .tool(EphemeralSpawnTool {
            calls: Arc::clone(&spawn_calls),
        })
        .build()?;
    let journal = crate::DurableSession::open(failing_store, "spawn-recovery").await?;
    let builder = Nanocodex::builder(openai()?)
        .workspace(&workspace)
        .session_id(test_session_id())
        .tools(first_tools)
        .durability(journal)
        .await?;
    let (agent, events) = builder.build()?;

    let first = agent
        .prompt(PromptRequest::new("delegate once").request_id("turn-1"))
        .await?
        .result()
        .await
        .expect_err("the injected crash boundary must stop before the wait model call");
    assert!(first.to_string().contains("injected append failure"));
    assert_eq!(
        spawn_calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "the first runtime must create exactly one ephemeral child"
    );
    assert_eq!(
        generations.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "the crash must happen after spawn completion and before the next model call"
    );
    agent.shutdown().await?;
    drop((agent, events));

    let journal = crate::DurableSession::open(store, "spawn-recovery").await?;
    let recovered_tools = Tools::builder().without_defaults().build()?;
    let builder = Nanocodex::builder(openai()?)
        .workspace(&workspace)
        .session_id(test_session_id())
        .tools(recovered_tools)
        .durability(journal)
        .await?;
    let (recovered, recovered_events) = builder.build()?;
    let result = recovered
        .prompt(PromptRequest::new("delegate once").request_id("turn-1"))
        .await?
        .result()
        .await?;
    assert_eq!(result.final_message(), "recovered without a ghost child");
    assert_eq!(
        spawn_calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "recovery must not rerun the missing spawn handler"
    );
    assert_eq!(
        generations.load(std::sync::atomic::Ordering::SeqCst),
        2,
        "recovery must replay the first model step and continue only after the failed tool output"
    );

    recovered.shutdown().await?;
    drop((recovered, recovered_events));
    std::fs::remove_dir_all(workspace)?;
    Ok(())
}

#[tokio::test]
async fn attached_execution_policy_rejects_spawn_before_creating_a_child() -> Result<()> {
    let store = crate::MemoryStore::new()?;
    let journal = crate::DurableSession::open(store, "spawn-policy").await?;
    let service_factories = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let generations = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let openai = OpenAi::builder("test-key")
        .service({
            let service_factories = Arc::clone(&service_factories);
            let generations = Arc::clone(&generations);
            move || {
                service_factories.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                DurableReplayService {
                    generations: Arc::clone(&generations),
                }
            }
        })
        .build()?;
    let workspace = temporary_workspace("durability-spawn-policy")?;
    let builder = Nanocodex::builder(openai)
        .workspace(&workspace)
        .session_id(test_session_id())
        .durability(journal)
        .await?;
    let (agent, events) = builder.build()?;

    assert!(matches!(
        agent.spawn().await,
        Err(NanocodexError::ExecutionPolicyBranchUnsupported { operation: "spawn" })
    ));
    assert_eq!(
        service_factories.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "rejecting spawn must not construct a child service or driver"
    );

    agent.shutdown().await?;
    drop((agent, events));
    std::fs::remove_dir_all(workspace)?;
    Ok(())
}
