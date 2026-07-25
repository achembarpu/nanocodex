use std::path::PathBuf;

use eyre::{Result, eyre};
use futures_util::{SinkExt, StreamExt};
use nanocodex::{Nanocodex, NanocodexError, Responses, Thinking, Tools};
use nanocodex_rlm::TaskRuntime;
use serde_json::{Value, json};
use tokio::{net::TcpListener, time::timeout};
use tokio_tungstenite::{WebSocketStream, accept_async, tungstenite::Message};

const CHILD_SUBMIT_SOURCE: &str = "
const accepted = await tools.submit_result({ output: { answer: 42 } });
text(JSON.stringify(accepted));
";
const CHILD_CONTINUE_SOURCE: &str = "
const accepted = await tools.submit_result({ output: { answer: 43 } });
text(JSON.stringify(accepted));
";
const BATCH_SUBMIT_SOURCE: &str = "
const accepted = await tools.submit_result({ output: { value: 11 } });
text(JSON.stringify(accepted));
";

#[tokio::test]
async fn parent_task_runs_a_clean_child_and_returns_its_submitted_result() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("ws://{}", listener.local_addr()?);
    let server = tokio::spawn(serve_responses(listener));
    let workspace = temporary_workspace();
    std::fs::create_dir_all(&workspace)?;

    let runtime = TaskRuntime::new();
    let task_tools = runtime.tools();
    let responses = Responses::builder().websocket_url(endpoint).build();
    let (agent, events) = Nanocodex::builder("test-key")
        .thinking(Thinking::Low)
        .workspace(&workspace)
        .responses(responses)
        .tools_factory(move |agent| {
            let tools = Tools::builder()
                .web_search(false)
                .image_generation(false)
                .build()?;
            task_tools.install(tools, agent)
        })
        .build()?;

    let turn = agent
        .prompt("PARENT_SECRET: delegate the arithmetic task")
        .await?;
    let result = timeout(std::time::Duration::from_secs(10), turn.result())
        .await
        .map_err(|_| eyre!("root task turn timed out"))??;
    assert_eq!(result.final_message, "root received 42");

    timeout(std::time::Duration::from_secs(5), server)
        .await
        .map_err(|_| eyre!("mock Responses server did not finish"))???;
    runtime.shutdown().await;
    drop((agent, events));
    std::fs::remove_dir_all(workspace)?;
    Ok(())
}

#[tokio::test]
async fn task_batch_preserves_input_order_and_returns_partial_failures() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("ws://{}", listener.local_addr()?);
    let server = tokio::spawn(serve_batch_responses(listener));
    let workspace = temporary_workspace();
    std::fs::create_dir_all(&workspace)?;

    let runtime = TaskRuntime::new();
    let task_tools = runtime.tools();
    let responses = Responses::builder().websocket_url(endpoint).build();
    let (agent, events) = Nanocodex::builder("test-key")
        .thinking(Thinking::Low)
        .workspace(&workspace)
        .responses(responses)
        .tools_factory(move |agent| {
            let tools = Tools::builder()
                .web_search(false)
                .image_generation(false)
                .build()?;
            task_tools.install(tools, agent)
        })
        .build()?;

    let result = timeout(
        std::time::Duration::from_secs(10),
        agent.prompt("Run the ordered batch.").await?.result(),
    )
    .await
    .map_err(|_| eyre!("root batch turn timed out"))??;
    assert_eq!(result.final_message, "batch reduced");

    timeout(std::time::Duration::from_secs(5), server)
        .await
        .map_err(|_| eyre!("batch mock Responses server did not finish"))???;
    runtime.shutdown().await;
    drop((agent, events));
    std::fs::remove_dir_all(workspace)?;
    Ok(())
}

#[tokio::test]
async fn cancelling_the_parent_cell_stops_its_clean_child() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("ws://{}", listener.local_addr()?);
    let (child_started, child_started_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(serve_cancel_responses(listener, child_started));
    let workspace = temporary_workspace();
    std::fs::create_dir_all(&workspace)?;

    let runtime = TaskRuntime::new();
    let task_tools = runtime.tools();
    let responses = Responses::builder().websocket_url(endpoint).build();
    let (agent, events) = Nanocodex::builder("test-key")
        .thinking(Thinking::Low)
        .workspace(&workspace)
        .responses(responses)
        .tools_factory(move |agent| {
            let tools = Tools::builder()
                .web_search(false)
                .image_generation(false)
                .build()?;
            task_tools.install(tools, agent)
        })
        .build()?;

    let turn = agent.prompt("Start a cancellable child task.").await?;
    timeout(std::time::Duration::from_secs(5), child_started_rx)
        .await
        .map_err(|_| eyre!("child task did not start"))??;
    turn.cancel().await?;
    assert!(matches!(
        turn.result().await,
        Err(NanocodexError::TurnCancelled)
    ));
    timeout(std::time::Duration::from_secs(5), server)
        .await
        .map_err(|_| eyre!("cancel mock Responses server did not finish"))???;

    runtime.shutdown().await;
    drop((agent, events));
    std::fs::remove_dir_all(workspace)?;
    Ok(())
}

async fn serve_responses(listener: TcpListener) -> Result<()> {
    let (root_stream, _) = listener.accept().await?;
    let mut root = accept_async(root_stream).await?;
    let root_warmup = next_json(&mut root).await?;
    assert!(
        root_warmup.to_string().contains("task_batch"),
        "root warmup omitted recursive task tools: {root_warmup}"
    );
    send_completed(&mut root, "root-warmup", &[]).await?;

    let root_generation = next_json(&mut root).await?;
    assert!(root_generation.to_string().contains("PARENT_SECRET"));
    send_completed(
        &mut root,
        "root-task-call",
        &[json!({
            "type": "custom_tool_call",
            "call_id": "root-exec",
            "name": "exec",
            "input": r#"
const delegated = await tools.task({
  instruction: "Compute six times seven.",
  context: { operands: [6, 7] },
  output_schema: {
    type: "object",
    properties: { answer: { type: "integer" } },
    required: ["answer"],
    additionalProperties: false
  }
});
const refined = await tools.task_continue({
  task_id: delegated.task_id,
  instruction: "Add one to the prior answer.",
  context: { prior: delegated.output },
  output_schema: {
    type: "object",
    properties: { answer: { type: "integer" } },
    required: ["answer"],
    additionalProperties: false
  }
});
text(JSON.stringify({ delegated, refined }));
"#
        })],
    )
    .await?;

    let (child_stream, _) = listener.accept().await?;
    let mut child = accept_async(child_stream).await?;
    serve_child(&mut child).await?;

    let root_continuation = next_json(&mut root).await?;
    assert_eq!(
        root_continuation["input"][0]["type"],
        "custom_tool_call_output"
    );
    let root_output = root_continuation.to_string();
    assert!(root_output.contains("\\\"answer\\\":42"));
    assert!(root_output.contains("\\\"answer\\\":43"));
    send_completed(
        &mut root,
        "root-final",
        &[json!({
            "type": "message",
            "role": "assistant",
            "content": [{ "type": "output_text", "text": "root received 42" }]
        })],
    )
    .await
}

async fn serve_cancel_responses(
    listener: TcpListener,
    child_started: tokio::sync::oneshot::Sender<()>,
) -> Result<()> {
    let (root_stream, _) = listener.accept().await?;
    let mut root = accept_async(root_stream).await?;
    let root_warmup = next_json(&mut root).await?;
    assert!(root_warmup.to_string().contains("task"));
    send_completed(&mut root, "cancel-root-warmup", &[]).await?;

    let root_generation = next_json(&mut root).await?;
    assert!(root_generation.to_string().contains("cancellable"));
    send_completed(
        &mut root,
        "cancel-root-call",
        &[json!({
            "type": "custom_tool_call",
            "call_id": "cancel-root-exec",
            "name": "exec",
            "input": r#"
const result = await tools.task({
  instruction: "Wait for further input without submitting.",
  output_schema: { type: "object" }
});
text(JSON.stringify(result));
"#
        })],
    )
    .await?;

    let (child_stream, _) = listener.accept().await?;
    let mut child = accept_async(child_stream).await?;
    let child_warmup = next_json(&mut child).await?;
    assert!(child_warmup.to_string().contains("submit_result"));
    send_completed(&mut child, "cancel-child-warmup", &[]).await?;
    let child_generation = next_json(&mut child).await?;
    assert!(
        child_generation
            .to_string()
            .contains("Wait for further input")
    );
    child_started
        .send(())
        .map_err(|()| eyre!("cancellation test receiver dropped"))?;

    loop {
        match child.next().await {
            Some(Ok(Message::Close(_)) | Err(_)) | None => break,
            Some(Ok(_)) => {}
        }
    }
    drop(root);
    Ok(())
}

async fn serve_batch_responses(listener: TcpListener) -> Result<()> {
    let (root_stream, _) = listener.accept().await?;
    let mut root = accept_async(root_stream).await?;
    let root_warmup = next_json(&mut root).await?;
    assert!(root_warmup.to_string().contains("task_batch"));
    send_completed(&mut root, "batch-root-warmup", &[]).await?;

    let root_generation = next_json(&mut root).await?;
    assert!(root_generation.to_string().contains("ordered batch"));
    send_completed(
        &mut root,
        "batch-root-call",
        &[json!({
            "type": "custom_tool_call",
            "call_id": "batch-root-exec",
            "name": "exec",
            "input": r#"
const outcomes = await tools.task_batch({
  tasks: [
    { instruction: "Return the first value.", context: { ordinal: 1 } },
    { instruction: "Finish without submitting.", context: { ordinal: 2 } }
  ],
  output_schema: {
    type: "object",
    properties: { value: { type: "integer" } },
    required: ["value"],
    additionalProperties: false
  }
});
text(JSON.stringify(outcomes));
"#
        })],
    )
    .await?;

    let (first_stream, _) = listener.accept().await?;
    let first = tokio::spawn(serve_batch_child(first_stream, "batch-child-a"));
    let (second_stream, _) = listener.accept().await?;
    let second = tokio::spawn(serve_batch_child(second_stream, "batch-child-b"));
    let (first, second) = tokio::join!(first, second);
    first??;
    second??;

    let root_continuation = next_json(&mut root).await?;
    let output = root_continuation.to_string();
    let completed = output
        .find("completed")
        .ok_or_else(|| eyre!("batch output omitted completed outcome: {output}"))?;
    let failed = output
        .find("failed")
        .ok_or_else(|| eyre!("batch output omitted failed outcome: {output}"))?;
    assert!(
        completed < failed,
        "batch output lost input order: {output}"
    );
    assert!(output.contains("11"));
    assert!(output.contains("without one valid submit_result"));
    send_completed(
        &mut root,
        "batch-root-final",
        &[json!({
            "type": "message",
            "role": "assistant",
            "content": [{ "type": "output_text", "text": "batch reduced" }]
        })],
    )
    .await
}

async fn serve_batch_child(stream: tokio::net::TcpStream, response_prefix: &str) -> Result<()> {
    let mut child = accept_async(stream).await?;
    let warmup = next_json(&mut child).await?;
    assert!(warmup.to_string().contains("submit_result"));
    send_completed(&mut child, &format!("{response_prefix}-warmup"), &[]).await?;

    let generation = next_json(&mut child).await?;
    let request = generation.to_string();
    if request.contains("Return the first value.") {
        send_completed(
            &mut child,
            &format!("{response_prefix}-submit-call"),
            &[json!({
                "type": "custom_tool_call",
                "call_id": format!("{response_prefix}-exec"),
                "name": "exec",
                "input": BATCH_SUBMIT_SOURCE
            })],
        )
        .await?;
        let continuation = next_json(&mut child).await?;
        assert!(continuation.to_string().contains("accepted"));
    } else {
        assert!(request.contains("Finish without submitting."));
    }
    send_completed(
        &mut child,
        &format!("{response_prefix}-final"),
        &[json!({
            "type": "message",
            "role": "assistant",
            "content": [{ "type": "output_text", "text": "child finished" }]
        })],
    )
    .await
}

async fn serve_child(child: &mut WebSocketStream<tokio::net::TcpStream>) -> Result<()> {
    let child_warmup = next_json(child).await?;
    assert!(
        child_warmup.to_string().contains("submit_result"),
        "child warmup omitted submit_result: {child_warmup}"
    );
    assert!(
        !child_warmup.to_string().contains("PARENT_SECRET"),
        "clean child inherited the parent prompt: {child_warmup}"
    );
    send_completed(child, "child-warmup", &[]).await?;

    let child_generation = next_json(child).await?;
    let child_request = child_generation.to_string();
    assert!(child_request.contains("Compute six times seven."));
    assert!(child_request.contains("operands"));
    assert!(!child_request.contains("PARENT_SECRET"));
    send_completed(
        child,
        "child-submit-call",
        &[json!({
            "type": "custom_tool_call",
            "call_id": "child-exec",
            "name": "exec",
            "input": CHILD_SUBMIT_SOURCE
        })],
    )
    .await?;

    let child_continuation = next_json(child).await?;
    assert_eq!(
        child_continuation["input"][0]["type"],
        "custom_tool_call_output"
    );
    assert!(
        child_continuation.to_string().contains("accepted"),
        "child continuation omitted submit_result acceptance: {child_continuation}"
    );
    send_completed(
        child,
        "child-final",
        &[json!({
            "type": "message",
            "role": "assistant",
            "content": [{ "type": "output_text", "text": "submitted" }]
        })],
    )
    .await?;

    let continued_generation = next_json(child).await?;
    assert_eq!(continued_generation["previous_response_id"], "child-final");
    let continued_request = continued_generation.to_string();
    assert!(continued_request.contains("Add one to the prior answer."));
    assert!(continued_request.contains("prior"));
    assert!(continued_request.contains("42"));
    assert!(!continued_request.contains("PARENT_SECRET"));
    send_completed(
        child,
        "child-continue-submit-call",
        &[json!({
            "type": "custom_tool_call",
            "call_id": "child-continue-exec",
            "name": "exec",
            "input": CHILD_CONTINUE_SOURCE
        })],
    )
    .await?;

    let continued_submission = next_json(child).await?;
    assert_eq!(
        continued_submission["input"][0]["type"],
        "custom_tool_call_output"
    );
    assert!(continued_submission.to_string().contains("accepted"));
    send_completed(
        child,
        "child-continue-final",
        &[json!({
            "type": "message",
            "role": "assistant",
            "content": [{ "type": "output_text", "text": "continued result submitted" }]
        })],
    )
    .await
}

async fn next_json<S>(socket: &mut WebSocketStream<S>) -> Result<Value>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        let message = socket
            .next()
            .await
            .ok_or_else(|| eyre!("client closed before sending a request"))??;
        if let Message::Text(text) = message {
            return Ok(serde_json::from_str(text.as_str())?);
        }
    }
}

async fn send_completed<S>(
    socket: &mut WebSocketStream<S>,
    response_id: &str,
    output: &[Value],
) -> Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    socket
        .send(Message::Text(
            json!({
                "type": "response.completed",
                "response": {
                    "id": response_id,
                    "status": "completed",
                    "output": output,
                    "usage": {
                        "input_tokens": 10,
                        "input_tokens_details": { "cached_tokens": 5 },
                        "output_tokens": 2,
                        "output_tokens_details": { "reasoning_tokens": 1 },
                        "total_tokens": 12
                    }
                }
            })
            .to_string()
            .into(),
        ))
        .await?;
    Ok(())
}

fn temporary_workspace() -> PathBuf {
    std::env::temp_dir().join(format!(
        "nanocodex-rlm-e2e-{}-{}",
        std::process::id(),
        uuid::Uuid::now_v7()
    ))
}
