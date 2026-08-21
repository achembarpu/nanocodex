import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const baseUrl = process.env.NANOCODEX_WORKER_URL ?? "http://127.0.0.1:8787";
const adminToken = process.env.NANOCODEX_ADMIN_TOKEN ?? "local-admin-token";
const terminalTimeoutMs = Number(process.env.NANOCODEX_SMOKE_TIMEOUT_MS ?? 180_000);
const idleTimeoutMs = Number(process.env.NANOCODEX_SMOKE_IDLE_TIMEOUT_MS ?? 45_000);
let currentStage = "create-session";

const session = await createSession();
progress("session-created");
const agentEvents = [];
let { socket, inbox } = connectClient();

try {
  currentStage = "websocket-ready";
  await inbox.next((message) => message.type === "ready", 10_000);
  progress("websocket-ready");

  currentStage = "first-turn";
  const firstId = randomUUID();
  const firstInput = "Reply with exactly EDGE_OK and nothing else.";
  const firstStarted = performance.now();
  socket.send(JSON.stringify({
    type: "prompt",
    id: firstId,
    input: firstInput,
  }));
  socket.send(JSON.stringify({
    type: "prompt",
    id: firstId,
    input: firstInput,
  }));
  const first = await terminal(inbox, firstId, terminalTimeoutMs);
  progress("first-turn-completed");
  const firstMs = performance.now() - firstStarted;
  if (!String(first.final_message).includes("EDGE_OK")) {
    throw new Error(`first turn returned an unexpected answer: ${first.final_message}`);
  }

  currentStage = "terminal-replay";
  socket.send(JSON.stringify({ type: "prompt", id: firstId, input: firstInput }));
  const replay = await terminal(inbox, firstId, 10_000);
  if (replay.final_message !== first.final_message) {
    throw new Error("completed turn replay changed its terminal result");
  }
  progress("terminal-replay-verified");

  currentStage = "client-detach";
  inbox.close();
  await disconnect(socket);
  progress("client-detached");

  currentStage = "idle-unload";
  const idleStarted = performance.now();
  const idleState = await pollState(
    (state) => state.completed_turns === 1 && state.agent_loaded === false,
    idleTimeoutMs,
  );
  const idleShutdownMs = performance.now() - idleStarted;
  progress("idle-unload-verified");

  currentStage = "client-reconnect";
  ({ socket, inbox } = connectClient());
  const resumed = await inbox.next((message) => message.type === "ready", 10_000);
  if (resumed.restored !== true) throw new Error("reconnected session was not restored from a snapshot");
  progress("client-reconnected");

  currentStage = "restored-turn";
  const secondId = randomUUID();
  const secondStarted = performance.now();
  socket.send(JSON.stringify({
    type: "prompt",
    id: secondId,
    input: "What exact token did I ask you to return previously? Reply with only that token.",
  }));
  const second = await terminal(inbox, secondId, terminalTimeoutMs);
  progress("restored-turn-completed");
  const restoreMs = performance.now() - secondStarted;
  if (!String(second.final_message).includes("EDGE_OK")) {
    throw new Error(`restored turn lost conversation history: ${second.final_message}`);
  }

  currentStage = "tool-turn";
  const toolId = randomUUID();
  socket.send(JSON.stringify({
    type: "prompt",
    id: toolId,
    input: "E2E_MANAGED_TOOLS. Call runtimeInfo, then use exec_command to write MANAGED_WORKSPACE_OK to durable.txt, read it, and print the working directory. Reply with exactly MANAGED_TOOLS_OK.",
  }));
  const toolTurn = await terminal(inbox, toolId, terminalTimeoutMs);
  progress("tool-turn-completed");
  if (String(toolTurn.final_message).trim() !== "MANAGED_TOOLS_OK") {
    throw new Error(`managed tools returned an unexpected answer: ${toolTurn.final_message}`);
  }
  const requiredTools = ["runtimeInfo", "exec_command"];
  for (const tool of requiredTools) {
    const toolCall = agentEvents.find((event) =>
      event.type === "tool.call" && event.payload?.tool === tool);
    const toolResult = agentEvents.find((event) =>
      event.type === "tool.result" && event.payload?.call_id === toolCall?.payload?.call_id);
    if (!toolCall || !toolResult || toolResult.payload?.status !== "completed") {
      throw new Error(`${tool} did not produce a completed tool.call/tool.result event pair`);
    }
  }

  const finalState = await state();
  if (finalState.completed_turns !== 3 || finalState.has_snapshot !== true) {
    throw new Error(`unexpected final state: ${JSON.stringify(finalState)}`);
  }

  const authStatus = finalState.auth_mode === "chatgpt" ? await subscriptionStatus() : undefined;
  console.log(JSON.stringify({
    session_id: session.session_id,
    first_turn_ms: Math.round(firstMs),
    idle_shutdown_ms: Math.round(idleShutdownMs),
    restored_turn_ms: Math.round(restoreMs),
    agent_events: agentEvents.length,
    tool_calls: requiredTools,
    completed_turns: finalState.completed_turns,
    idle_state: idleState.agent_loaded ? "loaded" : "unloaded",
    ...(authStatus === undefined ? {} : { auth_revision: authStatus.revision }),
    status: "ok",
  }));
} catch (error) {
  const diagnosticState = await state().catch((stateError) => ({ error: errorMessage(stateError) }));
  const eventTypes = Object.entries(Object.groupBy(agentEvents, (event) => event.type))
    .map(([type, events]) => [type, events.length]);
  console.error(JSON.stringify({
    stage: currentStage,
    error: errorMessage(error),
    state: diagnosticState,
    event_types: Object.fromEntries(eventTypes),
    last_event: agentEvents.at(-1)?.type,
  }));
  throw error;
} finally {
  inbox.close();
  socket.close(1000, "smoke complete");
  await fetch(session.session_url, { method: "DELETE" }).catch(() => {});
}

function progress(stage) {
  currentStage = stage;
  process.stderr.write(`[smoke] ${stage}\n`);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function createSession() {
  const response = await fetch(`${baseUrl}/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  if (!response.ok) throw new Error(`session creation failed with HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

async function state() {
  const response = await fetch(session.session_url);
  if (!response.ok) {
    throw Object.assign(
      new Error(`state failed with HTTP ${response.status}: ${await response.text()}`),
      { status: response.status },
    );
  }
  return response.json();
}

async function subscriptionStatus() {
  const response = await fetch(`${baseUrl}/auth/chatgpt`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  if (!response.ok) throw new Error(`auth status failed with HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

async function pollState(predicate, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  let lastError;
  while (performance.now() < deadline) {
    try {
      const current = await state();
      if (predicate(current)) return current;
      lastError = undefined;
    } catch (error) {
      if (Number(error?.status) < 500) throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `state did not reach the expected condition within ${timeoutMs}ms` +
      (lastError ? `: ${errorMessage(lastError)}` : ""),
  );
}

function connectClient() {
  const socket = new WebSocket(session.websocket_url);
  const inbox = createInbox(socket, (message) => {
    if (message.type === "event") agentEvents.push(message.event);
  });
  return { socket, inbox };
}

function disconnect(socket) {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.terminate();
      resolve();
    }, 2_000);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.close(1000, "smoke detach");
  });
}

async function terminal(inbox, id, timeoutMs) {
  const message = await inbox.next(
    (candidate) => ["turn_completed", "turn_failed"].includes(candidate.type) && candidate.id === id,
    timeoutMs,
  );
  if (message.type === "turn_failed") throw new Error(`turn ${id} failed: ${message.error}`);
  return message;
}

function createInbox(ws, observe = () => {}) {
  const queued = [];
  const waiters = [];
  const onMessage = (data) => {
    const message = JSON.parse(String(data));
    observe(message);
    const index = waiters.findIndex(({ predicate }) => predicate(message));
    if (index === -1) queued.push(message);
    else waiters.splice(index, 1)[0].resolve(message);
  };
  ws.on("message", onMessage);
  return {
    next(predicate, timeoutMs) {
      const index = queued.findIndex(predicate);
      if (index !== -1) return Promise.resolve(queued.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiters.push(waiter);
        const timer = setTimeout(() => {
          const pending = waiters.indexOf(waiter);
          if (pending !== -1) waiters.splice(pending, 1);
          reject(new Error(`WebSocket message timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        waiter.resolve = (message) => {
          clearTimeout(timer);
          resolve(message);
        };
      });
    },
    close() {
      ws.off("message", onMessage);
    },
  };
}
