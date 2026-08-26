use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use futures_util::{SinkExt, StreamExt};
use nanocodex_oai_api::responses::CustomToolFormat;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};

use super::*;
#[cfg(feature = "workspace-runtime")]
use crate::WorkspaceTools;
use crate::{
    Tool, ToolContext, ToolDefinition, ToolInput, ToolOutput, ToolResult, ToolsBuildError,
    contract::async_trait,
};

struct EchoTool;

#[async_trait]
impl Tool for EchoTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::function(
            "echo",
            "echo one exact value",
            json!({
                "type":"object",
                "properties":{"value":{"type":"string"}},
                "required":["value"],
                "additionalProperties":false
            }),
        )
        .with_output_schema(json!({
            "type":"object",
            "properties":{"value":{"type":"string"}},
            "required":["value"],
            "additionalProperties":false
        }))
    }

    fn supports_parallel_tool_calls(&self) -> bool {
        true
    }

    async fn execute(&self, input: ToolInput, _context: ToolContext<'_>) -> ToolResult {
        Ok(ToolOutput::json(&input.decode_json::<Value>()?))
    }
}

struct CustomTool;

#[async_trait]
impl Tool for CustomTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::custom(
            "edit",
            "edit exact text",
            CustomToolFormat::grammar("lark", "start: \"ok\""),
        )
    }

    async fn execute(&self, input: ToolInput, _context: ToolContext<'_>) -> ToolResult {
        Ok(ToolOutput::text(input.into_freeform()?))
    }
}

#[cfg(feature = "native")]
struct HiddenTool(&'static str);

#[cfg(feature = "native")]
#[async_trait]
impl Tool for HiddenTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::function(
            self.0,
            "hidden tool used to verify attachment catalog validation",
            json!({"type":"object","properties":{},"additionalProperties":false}),
        )
    }

    async fn execute(&self, _input: ToolInput, _context: ToolContext<'_>) -> ToolResult {
        Ok(ToolOutput::text("hidden"))
    }
}

#[cfg(feature = "native")]
struct GenericProvider;

#[cfg(feature = "native")]
#[async_trait]
impl crate::DynamicToolProvider for GenericProvider {
    fn start(&self) {}

    fn direct_tools(&self) -> Vec<Arc<dyn Tool>> {
        Vec::new()
    }

    fn available_definitions(&self) -> Vec<ToolDefinition> {
        Vec::new()
    }

    async fn execute(
        &self,
        _name: &str,
        _input: Value,
        _context: ToolContext<'_>,
    ) -> Option<ToolOutput> {
        None
    }
}

struct BlockingTool;

#[async_trait]
impl Tool for BlockingTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::function(
            "block",
            "blocks until its attachment closes",
            json!({
                "type":"object",
                "properties":{},
                "additionalProperties":false
            }),
        )
    }

    fn supports_parallel_tool_calls(&self) -> bool {
        true
    }

    async fn execute(&self, _input: ToolInput, _context: ToolContext<'_>) -> ToolResult {
        std::future::pending().await
    }
}

struct GateTool {
    name: &'static str,
    parallel_safe: bool,
    entered: tokio::sync::mpsc::UnboundedSender<&'static str>,
    release: Arc<tokio::sync::Semaphore>,
    active: Arc<AtomicUsize>,
    max_active: Arc<AtomicUsize>,
}

#[async_trait]
impl Tool for GateTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::function(
            self.name,
            "waits at a test-controlled execution gate",
            json!({"type":"object","properties":{},"additionalProperties":false}),
        )
    }

    fn supports_parallel_tool_calls(&self) -> bool {
        self.parallel_safe
    }

    async fn execute(&self, _input: ToolInput, _context: ToolContext<'_>) -> ToolResult {
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_active.fetch_max(active, Ordering::SeqCst);
        let _ = self.entered.send(self.name);
        Arc::clone(&self.release)
            .acquire_owned()
            .await
            .unwrap()
            .forget();
        self.active.fetch_sub(1, Ordering::SeqCst);
        Ok(ToolOutput::text("released"))
    }
}

async fn prepared_catalog(
    tools: &Tools,
) -> Result<crate::prepared::runtime::PreparedToolCatalog, AttachmentError> {
    let prepared = PreparedTools::prepare(tools)?;
    Ok(PreparedToolRuntime::initialize(prepared).await?.catalog()?)
}

#[test]
fn target_is_transport_only_and_redacts_the_bearer() {
    let target = AttachmentTarget::new(
        "wss://example.test/final/path?placement=browser",
        "very-secret",
    )
    .unwrap();
    assert!(!format!("{target:?}").contains("very-secret"));
    assert!(AttachmentTarget::new("https://example.test", "secret").is_err());
    assert!(AttachmentTarget::new("ws://example.test", " ").is_err());
}

#[test]
fn attachment_owns_rustls_provider_installation() {
    super::install_default_rustls_crypto_provider();
    assert!(rustls::crypto::CryptoProvider::get_default().is_some());
}

#[tokio::test]
async fn empty_recipe_has_one_exact_empty_catalog() {
    let tools = Tools::builder().without_defaults().build().unwrap();
    let catalog = prepared_catalog(&tools).await.unwrap();
    assert!(catalog.entries().is_empty());
    assert_eq!(catalog.canonical_json(), "[]");
    assert_eq!(catalog.digest().len(), 64);
}

#[tokio::test]
async fn enabled_sources_without_attached_executors_are_rejected() {
    let unpinned_workspace = Tools::builder()
        .without_defaults()
        .workspace(true)
        .build()
        .unwrap();
    let error = prepared_catalog(&unpinned_workspace).await.unwrap_err();
    assert!(
        matches!(error, AttachmentError::Catalog(message) if message.contains("pinned WorkspaceTools"))
    );

    let web_search = Tools::builder()
        .without_defaults()
        .web_search(true)
        .build()
        .unwrap();
    let error = prepared_catalog(&web_search).await.unwrap_err();
    assert!(matches!(error, AttachmentError::Catalog(message) if message.contains("web search")));

    let image_generation = Tools::builder()
        .without_defaults()
        .image_generation(true)
        .build()
        .unwrap();
    let error = prepared_catalog(&image_generation).await.unwrap_err();
    assert!(
        matches!(error, AttachmentError::Catalog(message) if message.contains("image generation"))
    );
}

#[cfg(feature = "native")]
#[tokio::test]
async fn normalized_collisions_fail_before_transport_readiness() {
    let tools = Tools::builder()
        .without_defaults()
        .tool_with_exposure(HiddenTool("read-file"), crate::ToolExposure::Hidden)
        .tool_with_exposure(HiddenTool("read_file"), crate::ToolExposure::Hidden)
        .build()
        .unwrap();
    let target = AttachmentTarget::new("ws://127.0.0.1:1/tools", "secret").unwrap();

    let error = tools.attach(target).connect().await.unwrap_err();
    assert!(
        matches!(error, AttachmentError::Catalog(message) if message.contains("normalize to Code Mode name `read_file`"))
    );
}

#[cfg(feature = "native")]
#[tokio::test]
async fn generic_dynamic_providers_are_rejected_before_transport_readiness() {
    let tools = Tools::builder()
        .without_defaults()
        .provider(GenericProvider)
        .build()
        .unwrap();
    let target = AttachmentTarget::new("ws://127.0.0.1:1/tools", "secret").unwrap();

    let error = tools.attach(target).connect().await.unwrap_err();
    assert!(
        matches!(error, AttachmentError::Catalog(message) if message.contains("generic dynamic provider"))
    );
}

#[tokio::test]
async fn fixed_and_custom_definitions_are_lossless_and_exposure_neutral() {
    let tools = Tools::builder()
        .without_defaults()
        .tool_with_exposure(EchoTool, crate::ToolExposure::Hidden)
        .tool(CustomTool)
        .build()
        .unwrap();
    let catalog = prepared_catalog(&tools).await.unwrap();
    assert_eq!(catalog.entries().len(), 2);
    let echo = catalog
        .entries()
        .iter()
        .find(|entry| entry.definition().name() == "echo")
        .unwrap();
    assert_eq!(echo.provider(), "fixed");
    assert_eq!(echo.remote_name(), "echo");
    assert!(echo.parallel_safe());
    assert_eq!(echo.summary(), None);
    assert_eq!(echo.timeout_ms(), 120_000);
    assert_eq!(
        echo.definition().output_schema().unwrap()["required"],
        json!(["value"])
    );
    let edit = catalog
        .entries()
        .iter()
        .find(|entry| entry.definition().name() == "edit")
        .unwrap();
    assert_eq!(edit.definition().format().unwrap().syntax(), "lark");
    assert_eq!(
        edit.definition().format().unwrap().definition(),
        "start: \"ok\""
    );
    assert!(!catalog.canonical_json().contains("defer_loading"));
}

#[tokio::test]
#[cfg(feature = "workspace-runtime")]
async fn workspace_uses_canonical_contracts_but_omits_agent_state() {
    let workspace = tempfile::tempdir().unwrap();
    let tools = Tools::builder()
        .without_defaults()
        .add(WorkspaceTools::new(workspace.path()))
        .build()
        .unwrap();
    let catalog = prepared_catalog(&tools).await.unwrap();
    let names = catalog
        .entries()
        .iter()
        .map(|entry| entry.definition().name())
        .collect::<Vec<_>>();
    assert_eq!(
        names,
        ["apply_patch", "exec_command", "view_image", "write_stdin"]
    );
    let exec = catalog
        .entries()
        .iter()
        .find(|entry| entry.definition().name() == "exec_command")
        .unwrap();
    assert_eq!(
        exec.definition().description(),
        "Runs a command in a PTY, returning output or a session ID for ongoing interaction."
    );
    assert!(exec.definition().output_schema().is_some());
    assert!(!names.contains(&"update_plan"));
}

#[test]
fn collisions_stay_owned_by_the_single_tools_builder() {
    let error = Tools::builder()
        .tool(EchoTool)
        .tool(EchoTool)
        .build()
        .unwrap_err();
    assert!(matches!(error, ToolsBuildError::DuplicateName(name) if &*name == "echo"));
}

#[test]
#[cfg(feature = "workspace-runtime")]
fn singleton_workspace_source_cannot_be_silently_replaced() {
    let error = Tools::builder()
        .add(WorkspaceTools::new("first"))
        .add(WorkspaceTools::new("second"))
        .build()
        .unwrap_err();
    assert!(matches!(
        error,
        ToolsBuildError::DuplicateSource("workspace")
    ));
}

#[tokio::test]
#[cfg(feature = "native")]
async fn mcp_is_frozen_into_the_same_catalog() {
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/mcp-stdio-server.mjs");
    let mcp = crate::mcp::Mcp::builder()
        .server(
            "fixture",
            crate::mcp::McpServer::stdio("node").arg(fixture.to_string_lossy().into_owned()),
        )
        .build()
        .unwrap();
    let tools = Tools::builder()
        .without_defaults()
        .add(mcp)
        .build()
        .unwrap();
    let catalog = prepared_catalog(&tools).await.unwrap();
    assert_eq!(catalog.entries().len(), 1);
    assert_eq!(catalog.entries()[0].provider(), "mcp__fixture__");
    assert_eq!(catalog.entries()[0].remote_name(), "echo");
    assert!(catalog.entries()[0].definition().output_schema().is_some());
}

#[tokio::test]
async fn connect_publishes_executes_replays_receipt_and_detaches() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("ws://{}/attach", listener.local_addr().unwrap());
    let lease_id = uuid::Uuid::new_v4().to_string();
    let (receipt_tx, receipt_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(stream).await.unwrap();
        let attach = recv_json(&mut socket).await;
        let host_id = attach["host_id"].as_str().unwrap().to_owned();
        send_json(
            &mut socket,
            json!({
                "type":"lease","protocol_version":1,"capability":"tools",
                "lease_id":lease_id,"generation":1,"expires_at":now_ms()+60_000,
                "capabilities":[{"name":"tools","version":1}]
            }),
        )
        .await;
        let publish = recv_json(&mut socket).await;
        assert_eq!(publish["tools"].as_array().unwrap().len(), 1);
        send_json(
            &mut socket,
            json!({
                "type":"catalog_ack","protocol_version":1,"capability":"tools",
                "lease_id":lease_id,"generation":1,"catalog_revision":1,
                "catalog_digest":publish["catalog_digest"]
            }),
        )
        .await;
        let call = json!({
            "type":"call","protocol_version":1,"capability":"tools",
            "host_id":host_id,"lease_id":lease_id,"generation":1,"catalog_revision":1,
            "session_id":"session-1","call_id":"call-1","model":"attached","name":"echo",
            "input":{"value":"attached"},"output_token_budget":1000,
            "output_byte_budget":131072,"deadline_at":now_ms()+10_000
        });
        send_json(&mut socket, call.clone()).await;
        let first = recv_json(&mut socket).await;
        assert_eq!(first["outcome"]["status"], "completed");
        send_json(&mut socket, call.clone()).await;
        let replay = recv_json(&mut socket).await;
        assert_eq!(replay["outcome"], first["outcome"]);
        send_json(
            &mut socket,
            json!({
                "type":"result_ack","protocol_version":1,"capability":"tools",
                "lease_id":lease_id,"generation":1,"catalog_revision":1,"call_id":"call-1"
            }),
        )
        .await;
        let mut expired = call;
        expired["call_id"] = json!("call-2");
        expired["deadline_at"] = json!(now_ms().saturating_sub(1));
        send_json(&mut socket, expired.clone()).await;
        let deadline = recv_json(&mut socket).await;
        assert_eq!(deadline["outcome"]["status"], "unavailable");
        send_json(
            &mut socket,
            json!({
                "type":"result_ack","protocol_version":1,"capability":"tools",
                "lease_id":lease_id,"generation":1,"catalog_revision":1,"call_id":"call-2"
            }),
        )
        .await;
        let mut missing = expired;
        missing["call_id"] = json!("call-3");
        missing["name"] = json!("missing");
        missing["deadline_at"] = json!(now_ms() + 10_000);
        send_json(&mut socket, missing).await;
        let unknown = recv_json(&mut socket).await;
        assert_eq!(unknown["outcome"]["status"], "unavailable");
        send_json(
            &mut socket,
            json!({
                "type":"result_ack","protocol_version":1,"capability":"tools",
                "lease_id":lease_id,"generation":1,"catalog_revision":1,"call_id":"call-3"
            }),
        )
        .await;
        let _ = receipt_tx.send(());
        let _ = socket.next().await;
    });

    let tools = Tools::builder()
        .without_defaults()
        .tool(EchoTool)
        .build()
        .unwrap();
    let target = AttachmentTarget::new(endpoint, "sensitive-bearer").unwrap();
    let (attachment, mut events) = tools.attach(target).connect().await.unwrap();
    assert!(matches!(
        attachment.status(),
        AttachmentStatus::Ready { .. }
    ));
    let mut completed = std::collections::HashMap::new();
    while completed.len() != 3 {
        if let Some(AttachmentEvent::CallCompleted {
            call_id, outcome, ..
        }) = events.recv().await
        {
            completed.insert(call_id, outcome);
        }
    }
    assert_eq!(completed["call-1"], AttachmentCallOutcome::Completed);
    assert_eq!(completed["call-2"], AttachmentCallOutcome::Unavailable);
    assert_eq!(completed["call-3"], AttachmentCallOutcome::Unavailable);
    receipt_rx.await.unwrap();
    attachment.detach().await.unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn scheduler_overlaps_safe_calls_and_preserves_unsafe_fifo_barriers() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("ws://{}/attach", listener.local_addr().unwrap());
    let (results_tx, results_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, host_id, lease_id) = ready_server(listener, now_ms() + 60_000).await;
        for (call_id, name) in [
            ("safe-1", "safe"),
            ("safe-2", "safe"),
            ("unsafe-1", "unsafe"),
            ("safe-3", "safe"),
        ] {
            send_json(
                &mut socket,
                call_frame(&host_id, &lease_id, call_id, name, now_ms() + 10_000),
            )
            .await;
        }
        for _ in 0..4 {
            let result = recv_json(&mut socket).await;
            assert_eq!(result["outcome"]["status"], "completed");
            send_json(
                &mut socket,
                json!({
                    "type":"result_ack","protocol_version":1,"capability":"tools",
                    "lease_id":lease_id,"generation":1,"catalog_revision":1,
                    "call_id":result["call_id"]
                }),
            )
            .await;
        }
        let _ = results_tx.send(());
        let _ = socket.next().await;
    });

    let (entered_tx, mut entered_rx) = tokio::sync::mpsc::unbounded_channel();
    let safe_release = Arc::new(tokio::sync::Semaphore::new(0));
    let unsafe_release = Arc::new(tokio::sync::Semaphore::new(0));
    let active = Arc::new(AtomicUsize::new(0));
    let max_active = Arc::new(AtomicUsize::new(0));
    let tools = Tools::builder()
        .without_defaults()
        .tool(GateTool {
            name: "safe",
            parallel_safe: true,
            entered: entered_tx.clone(),
            release: Arc::clone(&safe_release),
            active: Arc::clone(&active),
            max_active: Arc::clone(&max_active),
        })
        .tool(GateTool {
            name: "unsafe",
            parallel_safe: false,
            entered: entered_tx,
            release: Arc::clone(&unsafe_release),
            active: Arc::clone(&active),
            max_active: Arc::clone(&max_active),
        })
        .build()
        .unwrap();
    let (attachment, _events) = tools
        .attach(AttachmentTarget::new(endpoint, "bearer").unwrap())
        .connect()
        .await
        .unwrap();

    assert_eq!(entered_rx.recv().await, Some("safe"));
    assert_eq!(entered_rx.recv().await, Some("safe"));
    assert_eq!(max_active.load(Ordering::SeqCst), 2);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(50), entered_rx.recv())
            .await
            .is_err()
    );
    safe_release.add_permits(1);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(50), entered_rx.recv())
            .await
            .is_err(),
        "unsafe call must wait for every earlier safe call"
    );
    safe_release.add_permits(1);
    assert_eq!(entered_rx.recv().await, Some("unsafe"));
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(50), entered_rx.recv())
            .await
            .is_err(),
        "safe call must not bypass an earlier unsafe call"
    );
    unsafe_release.add_permits(1);
    assert_eq!(entered_rx.recv().await, Some("safe"));
    safe_release.add_permits(1);

    results_rx.await.unwrap();
    attachment.detach().await.unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn explicit_detach_drains_admitted_work_before_websocket_close() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("ws://{}/attach", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, host_id, lease_id) = ready_server(listener, now_ms() + 60_000).await;
        send_json(
            &mut socket,
            call_frame(&host_id, &lease_id, "drain-1", "gate", now_ms() + 10_000),
        )
        .await;
        let result = recv_json(&mut socket).await;
        assert_eq!(result["call_id"], "drain-1");
        assert_eq!(result["outcome"]["status"], "completed");
        assert!(matches!(
            socket.next().await,
            Some(Ok(Message::Close(_))) | None
        ));
    });
    let (entered_tx, mut entered_rx) = tokio::sync::mpsc::unbounded_channel();
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let tools = Tools::builder()
        .without_defaults()
        .tool(GateTool {
            name: "gate",
            parallel_safe: false,
            entered: entered_tx,
            release: Arc::clone(&release),
            active: Arc::new(AtomicUsize::new(0)),
            max_active: Arc::new(AtomicUsize::new(0)),
        })
        .build()
        .unwrap();
    let (attachment, _events) = tools
        .attach(AttachmentTarget::new(endpoint, "bearer").unwrap())
        .connect()
        .await
        .unwrap();
    assert_eq!(entered_rx.recv().await, Some("gate"));
    let detach = tokio::spawn(async move { attachment.detach().await });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(
        !detach.is_finished(),
        "detach returned before admitted work drained"
    );
    release.add_permits(1);
    detach.await.unwrap().unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn malformed_handshake_frame_fences_with_policy_close() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("ws://{}/attach", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(stream).await.unwrap();
        let _ = recv_json(&mut socket).await;
        socket.send(Message::Text("{".into())).await.unwrap();
        let close = socket.next().await.unwrap().unwrap();
        assert!(
            matches!(close, Message::Close(Some(frame)) if frame.code == tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Policy)
        );
    });
    let tools = Tools::builder().without_defaults().build().unwrap();
    let error = tools
        .attach(AttachmentTarget::new(endpoint, "bearer").unwrap())
        .connect()
        .await
        .unwrap_err();
    assert!(matches!(error, AttachmentError::Fenced(_)));
    server.await.unwrap();
}

#[tokio::test]
async fn mismatched_catalog_ack_fences_before_connect_returns() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("ws://{}/attach", listener.local_addr().unwrap());
    let server =
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(stream).await.unwrap();
            let _ = recv_json(&mut socket).await;
            let lease_id = uuid::Uuid::new_v4().to_string();
            send_json(
                &mut socket,
                json!({
                    "type":"lease","protocol_version":1,"capability":"tools",
                    "lease_id":lease_id,"generation":1,"expires_at":now_ms()+60_000,
                    "capabilities":[{"name":"tools","version":1}]
                }),
            )
            .await;
            let _ = recv_json(&mut socket).await;
            send_json(&mut socket, json!({
            "type":"catalog_ack","protocol_version":1,"capability":"tools",
            "lease_id":lease_id,"generation":1,"catalog_revision":1,
            "catalog_digest":"0000000000000000000000000000000000000000000000000000000000000000"
        })).await;
            let _ = socket.next().await;
        });
    let tools = Tools::builder()
        .without_defaults()
        .tool(EchoTool)
        .build()
        .unwrap();
    let error = tools
        .attach(AttachmentTarget::new(endpoint, "bearer").unwrap())
        .connect()
        .await
        .unwrap_err();
    assert!(matches!(error, AttachmentError::Fenced(_)));
    server.await.unwrap();
}

#[tokio::test]
async fn initial_lease_handshake_is_bounded() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("ws://{}/attach", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(stream).await.unwrap();
        let _ = recv_json(&mut socket).await;
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    });
    let tools = Tools::builder().without_defaults().build().unwrap();
    let error = tools
        .attach(AttachmentTarget::new(endpoint, "bearer").unwrap())
        .connect()
        .await
        .unwrap_err();
    assert!(
        matches!(&error, AttachmentError::Transport(message) if message.contains("timed out waiting for attachment lease")),
        "unexpected error: {error:?}"
    );
    server.await.unwrap();
}

#[tokio::test]
async fn catalog_acknowledgement_handshake_is_bounded() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("ws://{}/attach", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(stream).await.unwrap();
        let _ = recv_json(&mut socket).await;
        let lease_id = uuid::Uuid::new_v4().to_string();
        send_json(&mut socket, lease_frame(&lease_id, now_ms() + 60_000)).await;
        let _ = recv_json(&mut socket).await;
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    });
    let tools = Tools::builder().without_defaults().build().unwrap();
    let error = tools
        .attach(AttachmentTarget::new(endpoint, "bearer").unwrap())
        .connect()
        .await
        .unwrap_err();
    assert!(
        matches!(&error, AttachmentError::Transport(message) if message.contains("timed out waiting for attachment catalog acknowledgement")),
        "unexpected error: {error:?}"
    );
    server.await.unwrap();
}

#[tokio::test]
async fn lease_expiry_forces_disconnect_and_reconnect() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("ws://{}/attach", listener.local_addr().unwrap());
    let (disconnected_tx, disconnected_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _, _) = ready_server(listener, now_ms() + 80).await;
        let _ = socket.next().await;
        let _ = disconnected_tx.send(());
    });
    let tools = Tools::builder().without_defaults().build().unwrap();
    let (attachment, _events) = tools
        .attach(AttachmentTarget::new(endpoint, "bearer").unwrap())
        .connect()
        .await
        .unwrap();
    disconnected_rx.await.unwrap();
    attachment.detach().await.unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn unanswered_ping_forces_disconnect() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("ws://{}/attach", listener.local_addr().unwrap());
    let (disconnected_tx, disconnected_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _, _) = ready_server(listener, now_ms() + 60_000).await;
        let ping = recv_json(&mut socket).await;
        assert_eq!(ping["type"], "ping");
        let _ = socket.next().await;
        let _ = disconnected_tx.send(());
    });
    let tools = Tools::builder().without_defaults().build().unwrap();
    let (attachment, _events) = tools
        .attach(AttachmentTarget::new(endpoint, "bearer").unwrap())
        .connect()
        .await
        .unwrap();
    disconnected_rx.await.unwrap();
    attachment.detach().await.unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn sixty_fifth_call_is_retained_unavailable_without_execution() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("ws://{}/attach", listener.local_addr().unwrap());
    let (capacity_tx, capacity_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, host_id, lease_id) = ready_server(listener, now_ms() + 60_000).await;
        let mut calls = Vec::new();
        for index in 0..=64 {
            let call = call_frame(
                &host_id,
                &lease_id,
                &format!("call-{index}"),
                "block",
                now_ms() + 2_000,
            );
            send_json(&mut socket, call.clone()).await;
            calls.push(call);
        }
        let first = recv_call_result(&mut socket, &lease_id, "call-64").await;
        assert_eq!(first["outcome"]["status"], "unavailable");
        send_json(&mut socket, calls.pop().unwrap()).await;
        let replay = recv_call_result(&mut socket, &lease_id, "call-64").await;
        assert_eq!(replay["outcome"], first["outcome"]);
        send_json(
            &mut socket,
            json!({
                "type":"result_ack","protocol_version":1,"capability":"tools",
                "lease_id":lease_id,"generation":1,"catalog_revision":1,"call_id":"call-64"
            }),
        )
        .await;
        let _ = capacity_tx.send(());
        socket.close(None).await.unwrap();
    });
    let tools = Tools::builder()
        .without_defaults()
        .tool(BlockingTool)
        .build()
        .unwrap();
    let (attachment, mut events) = tools
        .attach(AttachmentTarget::new(endpoint, "bearer").unwrap())
        .connect()
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), capacity_rx)
        .await
        .expect("capacity result timed out")
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut saw_start = false;
        let mut saw_completion = false;
        while !(saw_start && saw_completion) {
            match events.recv().await {
                Some(AttachmentEvent::CallStarted { call_id, .. }) if &*call_id == "call-64" => {
                    saw_start = true;
                }
                Some(AttachmentEvent::CallCompleted {
                    call_id, outcome, ..
                }) if &*call_id == "call-64" => {
                    assert_eq!(outcome, AttachmentCallOutcome::Unavailable);
                    saw_completion = true;
                }
                Some(_) => {}
                None => panic!("event stream closed before the capacity rejection was paired"),
            }
        }
    })
    .await
    .expect("capacity events timed out");
    drop(attachment);
    server.await.unwrap();
}

#[tokio::test]
async fn ignored_event_stream_never_blocks_protocol_progress() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("ws://{}/attach", listener.local_addr().unwrap());
    let (completed_tx, completed_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, host_id, lease_id) = ready_server(listener, now_ms() + 60_000).await;
        for index in 0..600 {
            let call_id = format!("ignored-events-{index}");
            send_json(
                &mut socket,
                call_frame(&host_id, &lease_id, &call_id, "echo", now_ms() + 10_000),
            )
            .await;
            let result = recv_call_result(&mut socket, &lease_id, &call_id).await;
            assert_eq!(result["outcome"]["status"], "completed");
            send_json(
                &mut socket,
                json!({
                    "type":"result_ack","protocol_version":1,"capability":"tools",
                    "lease_id":lease_id,"generation":1,"catalog_revision":1,
                    "call_id":call_id
                }),
            )
            .await;
        }
        let _ = completed_tx.send(());
        let _ = socket.next().await;
    });
    let tools = Tools::builder()
        .without_defaults()
        .tool(EchoTool)
        .build()
        .unwrap();
    let (attachment, _ignored_events) = tools
        .attach(AttachmentTarget::new(endpoint, "bearer").unwrap())
        .connect()
        .await
        .unwrap();
    let second_handle = attachment.clone();
    drop(attachment);
    tokio::time::timeout(Duration::from_secs(10), completed_rx)
        .await
        .expect("protocol stalled behind the ignored event stream")
        .unwrap();
    second_handle.detach().await.unwrap();
    server.await.unwrap();
}

async fn ready_server(
    listener: TcpListener,
    expires_at: u64,
) -> (
    tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    String,
    String,
) {
    let (stream, _) = listener.accept().await.unwrap();
    let mut socket = accept_async(stream).await.unwrap();
    let attach = recv_json(&mut socket).await;
    let host_id = attach["host_id"].as_str().unwrap().to_owned();
    let lease_id = uuid::Uuid::new_v4().to_string();
    send_json(&mut socket, lease_frame(&lease_id, expires_at)).await;
    let publish = recv_json(&mut socket).await;
    send_json(
        &mut socket,
        json!({
            "type":"catalog_ack","protocol_version":1,"capability":"tools",
            "lease_id":lease_id,"generation":1,"catalog_revision":1,
            "catalog_digest":publish["catalog_digest"]
        }),
    )
    .await;
    (socket, host_id, lease_id)
}

fn lease_frame(lease_id: &str, expires_at: u64) -> Value {
    json!({
        "type":"lease","protocol_version":1,"capability":"tools",
        "lease_id":lease_id,"generation":1,"expires_at":expires_at,
        "capabilities":[{"name":"tools","version":1}]
    })
}

fn call_frame(host_id: &str, lease_id: &str, call_id: &str, name: &str, deadline_at: u64) -> Value {
    json!({
        "type":"call","protocol_version":1,"capability":"tools",
        "host_id":host_id,"lease_id":lease_id,"generation":1,"catalog_revision":1,
        "session_id":"session-1","call_id":call_id,"model":"attached","name":name,"input":{},
        "output_token_budget":1000,"output_byte_budget":131072,"deadline_at":deadline_at
    })
}

async fn recv_json<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>) -> Value
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        match socket.next().await.unwrap().unwrap() {
            Message::Text(text) => return serde_json::from_str(&text).unwrap(),
            Message::Ping(payload) => socket.send(Message::Pong(payload)).await.unwrap(),
            frame => panic!("expected text, got {frame:?}"),
        }
    }
}

async fn recv_call_result<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    lease_id: &str,
    call_id: &str,
) -> Value
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        let frame = recv_json(socket).await;
        if frame["type"] == "ping" {
            send_json(
                socket,
                json!({
                    "type":"pong","protocol_version":1,"capability":"tools",
                    "lease_id":lease_id,"generation":1,"expires_at":now_ms() + 60_000,
                    "nonce":frame["nonce"]
                }),
            )
            .await;
            continue;
        }
        if frame["type"] == "result" && frame["call_id"] == call_id {
            return frame;
        }
    }
}

async fn send_json<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>, value: Value)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
