import { randomUUID } from "node:crypto";

import { deleteWith503Retry } from "./cleanup-resource.mjs";
import { credentialSafeHttpOrigin, credentialSafeUrl } from "./credential-origin.mjs";
import { managedAgentFetch, managedAgentHeaders, managedAgentToken } from "./managed-agent-auth.mjs";

const baseUrl = credentialSafeHttpOrigin(
  process.env.NANOCODEX_WORKER_URL ?? "http://127.0.0.1:8787",
  "NANOCODEX_WORKER_URL",
);
const adminToken = process.env.NANOCODEX_ADMIN_TOKEN ?? "local-admin-token";
const terminalTimeoutMs = numberFromEnv("NANOCODEX_SMOKE_TIMEOUT_MS", 180_000);
const idleTimeoutMs = numberFromEnv("NANOCODEX_SMOKE_IDLE_TIMEOUT_MS", 45_000);
const cleanupTimeoutMs = numberFromEnv("NANOCODEX_SMOKE_CLEANUP_TIMEOUT_MS", 30_000);
const skipIdle = process.env.NANOCODEX_SMOKE_SKIP_IDLE === "true";
let agent;
let stream;
let stage = "health";
let failure;
let result;

try {
  const health = await timedRequest(new URL("/health", baseUrl));
  assert(health.response.ok, `health failed with HTTP ${health.response.status}`);
  assert((await health.response.json()).status === "ok", "health returned an invalid payload");

  stage = "create-agent";
  const created = await timedRequest(new URL("/v1/agents", baseUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  await requireStatus(created.response, 201, "create agent");
  agent = await created.response.json();
  assert(typeof agent.agent_id === "string", "create agent omitted agent_id");
  assert(typeof agent.events_url === "string", "create agent omitted events_url");
  managedAgentToken(agent);
  credentialSafeUrl(agent.events_url, "managed agent events URL");
  assert(agent.agent_token !== agent.agent_id, "agent capability aliases its routing id");
  const agentUrl = agent.events_url.replace(/\/events$/, "");
  const turnsUrl = `${agentUrl}/turns`;

  stage = "open-initial-stream";
  stream = await openEventStream(agent.events_url, { cursor: "0" });
  const createdEvent = await stream.next(terminalTimeoutMs);
  assert(createdEvent.message.type === "agent_created", "first durable event was not agent_created");
  assert(createdEvent.message.agent_id === agent.agent_id, "agent_created used the wrong agent id");

  stage = "cold-turn";
  const coldId = `cold-${randomUUID()}`;
  const coldInput = "Reply with exactly MANAGED_EDGE_OK and nothing else.";
  const coldStarted = performance.now();
  const coldAcceptance = await submitTurn(turnsUrl, coldId, coldInput, `request-${coldId}`);
  const coldAcceptedMs = performance.now() - coldStarted;
  await requireStatus(coldAcceptance.response, 202, "cold acceptance");
  const coldView = await coldAcceptance.response.json();
  assert(coldView.state === "accepted", `cold turn was accepted as ${coldView.state}`);

  const replay = await submitTurn(turnsUrl, coldId, coldInput, `request-${coldId}`);
  assert(replay.response.status === 200, `idempotent replay returned HTTP ${replay.response.status}`);
  assert((await replay.response.json()).accepted_cursor === coldView.accepted_cursor, "replay changed accepted cursor");
  const conflict = await submitTurn(turnsUrl, coldId, `${coldInput} changed`, `request-${coldId}`);
  assert(conflict.response.status === 409, `idempotency conflict returned HTTP ${conflict.response.status}`);

  const cold = await waitForTerminal(stream, coldId, coldStarted, terminalTimeoutMs);
  assert(cold.terminal.type === "turn_completed", terminalFailure("cold turn", cold.terminal));
  assert(String(cold.terminal.final_message).includes("MANAGED_EDGE_OK"), "cold turn returned the wrong answer");

  stage = "tool-turn";
  const toolId = `tools-${randomUUID()}`;
  const toolInput = [
    "E2E_MANAGED_TOOLS.",
    "Call runtimeInfo. Then use exec_command to write MANAGED_WORKSPACE_OK to durable.txt,",
    "read it back, and print the working directory. Reply with exactly MANAGED_TOOLS_OK.",
  ].join(" ");
  const toolStarted = performance.now();
  const toolAcceptance = await submitTurn(turnsUrl, toolId, toolInput, `request-${toolId}`);
  const toolAcceptedMs = performance.now() - toolStarted;
  await requireStatus(toolAcceptance.response, 202, "tool acceptance");
  const tool = await waitForTerminal(stream, toolId, toolStarted, terminalTimeoutMs);
  assert(tool.terminal.type === "turn_completed", terminalFailure("tool turn", tool.terminal));
  assert(String(tool.terminal.final_message).includes("MANAGED_TOOLS_OK"), "tool turn returned the wrong answer");
  const runtimeInfo = requireCompletedTool(tool.messages, toolId, "runtimeInfo");
  requireCompletedTool(tool.messages, toolId, "exec_command");
  const runtimeInfoPayload = JSON.stringify(runtimeInfo.event.payload);
  assert(!runtimeInfoPayload.includes(agent.agent_id), "runtimeInfo exposed the agent routing id");
  assert(!runtimeInfoPayload.includes(agent.agent_token), "runtimeInfo exposed the scoped agent capability");

  const toolStateResponse = await managedAgentFetch(agent, `${turnsUrl}/${toolId}`);
  await requireStatus(toolStateResponse, 200, "tool state");
  const toolState = await toolStateResponse.json();
  assert(toolState.state === "completed", `tool state was ${toolState.state}`);
  assert(toolState.terminal_cursor === tool.terminal.cursor, "terminal state and SSE cursor diverged");

  let idleShutdownMs = null;
  if (!skipIdle) {
    stage = "idle-shutdown";
    const idleStarted = performance.now();
    await poll(async () => {
      const response = await managedAgentFetch(agent, agentUrl);
      if (!response.ok) return false;
      return (await response.json()).agent_loaded === false;
    }, idleTimeoutMs, "agent idle shutdown");
    idleShutdownMs = performance.now() - idleStarted;
  }

  stage = "resume-stream";
  const resumeCursor = tool.terminal.cursor;
  await stream.cancel();
  stream = await openEventStream(`${agent.events_url}?cursor=not-used`, {
    lastEventId: resumeCursor,
  });

  stage = "durable-readback";
  const readbackId = `readback-${randomUUID()}`;
  const readbackInput = [
    "E2E_MANAGED_READBACK.",
    "Use exec_command to read durable.txt and reply with exactly MANAGED_RESTORED_OK.",
  ].join(" ");
  const readbackStarted = performance.now();
  const readbackAcceptance = await submitTurn(
    turnsUrl,
    readbackId,
    readbackInput,
    `request-${readbackId}`,
  );
  const readbackAcceptedMs = performance.now() - readbackStarted;
  await requireStatus(readbackAcceptance.response, 202, "readback acceptance");
  const readback = await waitForTerminal(stream, readbackId, readbackStarted, terminalTimeoutMs);
  assert(readback.terminal.type === "turn_completed", terminalFailure("readback turn", readback.terminal));
  assert(
    String(readback.terminal.final_message).includes("MANAGED_RESTORED_OK"),
    "durable workspace readback failed",
  );
  requireCompletedTool(readback.messages, readbackId, "exec_command");

  stage = "durable-cancel";
  const cancelId = `cancel-${randomUUID()}`;
  const cancelStarted = performance.now();
  const cancelAcceptance = await submitTurn(
    turnsUrl,
    cancelId,
    "E2E_MANAGED_CANCEL. Do not answer before the caller cancels this turn.",
    `request-${cancelId}`,
  );
  await requireStatus(cancelAcceptance.response, 202, "cancel acceptance");
  const cancelResponse = await managedAgentFetch(agent, `${turnsUrl}/${cancelId}/cancel`, {
    method: "POST",
  });
  await requireStatus(cancelResponse, 202, "cancel intent");
  assert((await cancelResponse.json()).state === "cancelling", "cancel intent was not durably acknowledged");
  const cancelled = await waitForTerminal(stream, cancelId, cancelStarted, terminalTimeoutMs);
  assert(cancelled.terminal.type === "turn_cancelled", terminalFailure("cancelled turn", cancelled.terminal));

  stage = "final-state";
  const finalStateResponse = await managedAgentFetch(agent, agentUrl);
  await requireStatus(finalStateResponse, 200, "final state");
  const finalState = await finalStateResponse.json();
  assert(finalState.completed_turns === 3, `expected 3 completed turns, got ${finalState.completed_turns}`);
  assert(finalState.stream_error === null, `event stream is fenced: ${finalState.stream_error}`);

  result = {
    agent_id: agent.agent_id,
    status: "ok",
    health_ms: rounded(health.elapsedMs),
    create_agent_ms: rounded(created.elapsedMs),
    cold_accept_ms: rounded(coldAcceptedMs),
    cold_ttft_ms: rounded(cold.firstOutputMs),
    cold_terminal_ms: rounded(cold.elapsedMs),
    tool_accept_ms: rounded(toolAcceptedMs),
    tool_terminal_ms: rounded(tool.elapsedMs),
    idle_shutdown_ms: idleShutdownMs === null ? null : rounded(idleShutdownMs),
    restored_accept_ms: rounded(readbackAcceptedMs),
    restored_terminal_ms: rounded(readback.elapsedMs),
    cancel_terminal_ms: rounded(cancelled.elapsedMs),
    latest_cursor: finalState.latest_event_cursor,
    completed_turns: finalState.completed_turns,
    tested_tools: ["runtimeInfo", "exec_command"],
  };
} catch (error) {
  console.error(JSON.stringify({ stage, error: errorMessage(error), agent_id: agent?.agent_id }));
  failure = error;
} finally {
  await stream?.cancel().catch(() => {});
  if (agent?.agent_id) {
    try {
      const cleanup = await deleteWith503Retry(
        (signal) => managedAgentFetch(agent, new URL(`/v1/agents/${agent.agent_id}`, baseUrl), {
          method: "DELETE",
          signal,
        }),
        { description: "managed agent cleanup", timeoutMs: cleanupTimeoutMs },
      );
      if (result) result.cleanup_status = cleanup.status === 404 ? "already_absent" : "deleted";
    } catch (error) {
      failure = failure
        ? new AggregateError([failure, error], "Managed API smoke and cleanup failed")
        : error;
    }
  }
}

if (failure) throw failure;
console.log(JSON.stringify(result));

async function submitTurn(turnsUrl, id, input, idempotencyKey) {
  return timedAgentRequest(turnsUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify({ id, input }),
  });
}

async function openEventStream(url, { cursor, lastEventId } = {}) {
  const target = new URL(url);
  if (cursor !== undefined) target.searchParams.set("cursor", cursor);
  const response = await managedAgentFetch(agent, target, {
    headers: lastEventId === undefined ? undefined : { "last-event-id": lastEventId },
  });
  await requireStatus(response, 200, "event stream");
  assert(response.headers.get("content-type")?.startsWith("text/event-stream"), "events endpoint did not return SSE");
  assert(response.body, "events endpoint returned no body");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let lastCursor = lastEventId === undefined ? BigInt(cursor ?? 0) : BigInt(lastEventId);
  return {
    async next(timeoutMs) {
      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = parseSse(frame);
          if (!event) continue;
          const cursorValue = BigInt(event.id);
          assert(cursorValue > lastCursor, `non-monotonic SSE cursor ${event.id} after ${lastCursor}`);
          lastCursor = cursorValue;
          assert(event.message.cursor === event.id, "SSE id and message cursor diverged");
          assert(event.event === event.message.type, "SSE event and message type diverged");
          return event;
        }
        const chunk = await within(reader.read(), timeoutMs, "next SSE frame");
        if (chunk.done) throw new Error("event stream ended before a terminal event");
        buffer += chunk.value.replaceAll("\r\n", "\n");
      }
    },
    cancel: () => reader.cancel(),
  };
}

async function waitForTerminal(reader, turnId, startedAt, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  const messages = [];
  let firstOutputMs = null;
  while (performance.now() < deadline) {
    const event = await reader.next(Math.max(1, deadline - performance.now()));
    const message = event.message;
    messages.push(message);
    if (message.type === "event" && message.turn_id === turnId) {
      if (firstOutputMs === null && ["assistant.delta", "assistant.message"].includes(message.event.type)) {
        firstOutputMs = performance.now() - startedAt;
      }
    }
    if (message.id !== turnId) continue;
    if (["turn_completed", "turn_cancelled", "turn_failed", "turn_blocked"].includes(message.type)) {
      return {
        terminal: message,
        messages,
        firstOutputMs,
        elapsedMs: performance.now() - startedAt,
      };
    }
  }
  throw new Error(`turn ${turnId} did not reach a terminal state`);
}

function requireCompletedTool(messages, turnId, tool) {
  const call = messages.find((message) =>
    message.type === "event"
      && message.turn_id === turnId
      && message.event?.type === "tool.call"
      && message.event.payload?.tool === tool
  );
  assert(call, `${tool} did not emit tool.call`);
  const result = messages.find((message) =>
    message.type === "event"
      && message.event?.type === "tool.result"
      && message.event.payload?.call_id === call.event.payload.call_id
  );
  assert(result, `${tool} did not emit tool.result`);
  assert(result.event.payload.status === "completed", `${tool} finished as ${result.event.payload.status}`);
  return result;
}

function parseSse(frame) {
  let id;
  let event;
  const data = [];
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (id === undefined || event === undefined || data.length === 0) return undefined;
  return { id, event, message: JSON.parse(data.join("\n")) };
}

async function timedRequest(url, init) {
  const startedAt = performance.now();
  const response = await fetch(url, init);
  return { response, elapsedMs: performance.now() - startedAt };
}

async function timedAgentRequest(url, init) {
  const startedAt = performance.now();
  const response = await fetch(url, {
    ...init,
    headers: managedAgentHeaders(agent, init?.headers),
  });
  return { response, elapsedMs: performance.now() - startedAt };
}

async function poll(check, timeoutMs, description) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${description} did not finish within ${timeoutMs}ms`);
}

async function within(promise, timeoutMs, description) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${description} timed out after ${Math.round(timeoutMs)}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function responseFailure(action, response) {
  return `${action} failed with HTTP ${response.status}: ${await response.clone().text()}`;
}

async function requireStatus(response, expected, action) {
  if (response.status !== expected) throw new Error(await responseFailure(action, response));
}

function terminalFailure(action, terminal) {
  return `${action} ended as ${terminal.type}: ${terminal.error ?? "no error detail"}`;
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function rounded(value) {
  return value === null ? null : Math.round(value * 10) / 10;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
