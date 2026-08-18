use std::{path::PathBuf, sync::Arc};

use eyre::{Result, eyre};
use nanocodex_agent::{Nanocodex, OpenAi, PromptRequest, ResponseError, Tools, session::SessionId};
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

#[derive(Clone)]
struct DurableToolService {
    generations: Arc<std::sync::atomic::AtomicUsize>,
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

    let result = agent
        .prompt("journal this automatically")
        .await?
        .result()
        .await?;
    assert_eq!(result.final_message(), "durably replayed");
    let state = journal_state.state().await?;
    assert_eq!(state.operations().len(), 1);
    let generated_id = state
        .operations()
        .keys()
        .next()
        .ok_or_else(|| eyre!("automatic durable operation is missing"))?;
    assert!(generated_id.parse::<SessionId>().is_ok());
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
    let error = agent
        .prompt("replay this exact turn")
        .await?
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
    let result = resumed
        .prompt("replay this exact turn")
        .await?
        .result()
        .await?;
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
    let first = agent
        .prompt(PromptRequest::new("run the counter").id("turn-1"))
        .await?
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
    let recovered = resumed
        .prompt(PromptRequest::new("run the counter").id("turn-1"))
        .await?
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
