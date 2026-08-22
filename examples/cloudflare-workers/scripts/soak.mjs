import { randomUUID } from "node:crypto";
import WebSocket from "ws";

import { managedAgentFetch, managedAgentWebSocketOptions } from "./managed-agent-auth.mjs";

const baseUrl = process.env.NANOCODEX_WORKER_URL ?? "http://127.0.0.1:8787";
const adminToken = process.env.NANOCODEX_ADMIN_TOKEN ?? "local-admin-token";
const sessionCount = Number(process.env.NANOCODEX_SOAK_SESSIONS ?? 16);
const timeoutMs = Number(process.env.NANOCODEX_SOAK_TIMEOUT_MS ?? 60_000);

if (!Number.isSafeInteger(sessionCount) || sessionCount < 1 || sessionCount > 128) {
  throw new Error("sessions must be 1-128");
}

const sessions = [];
const sockets = [];
const started = performance.now();
try {
  await Promise.all(Array.from({ length: sessionCount }, async () => {
    sessions.push(await createSession());
  }));
  const clients = await Promise.all(sessions.map(async (session, index) => {
    const socket = new WebSocket(
      session.websocket_url,
      managedAgentWebSocketOptions(session),
    );
    sockets.push(socket);
    const inbox = createInbox(socket);
    await inbox.next((message) => message.type === "ready", 10_000);
    return { inbox, index, session, socket };
  }));

  await Promise.all(clients.map(async ({ inbox, index, socket }) => {
    const id = randomUUID();
    const token = `SESSION_${String(index).padStart(3, "0")}`;
    socket.send(JSON.stringify({ type: "prompt", id, input: `Reply with exactly ${token}` }));
    socket.send(JSON.stringify({
      type: "prompt",
      id,
      input: "Reply with exactly DUPLICATE_MUST_NOT_RUN",
    }));
    const result = await inbox.next(
      (message) => ["turn_completed", "turn_failed"].includes(message.type) && message.id === id,
      timeoutMs,
    );
    if (result.type === "turn_failed") throw new Error(`session ${index} failed: ${result.error}`);
    if (result.final_message !== token) {
      throw new Error(`session ${index} crossed streams: expected ${token}, got ${result.final_message}`);
    }
  }));

  const states = await Promise.all(sessions.map(async (session) => {
    const response = await managedAgentFetch(
      session,
      `${baseUrl}/sessions/${session.session_id}`,
    );
    if (!response.ok) throw new Error(`state failed with HTTP ${response.status}`);
    return response.json();
  }));
  if (states.some((state) => state.completed_turns !== 1 || state.has_snapshot !== true)) {
    throw new Error(`unexpected durable states: ${JSON.stringify(states)}`);
  }

  const elapsedMs = performance.now() - started;
  console.log(JSON.stringify({
    sessions: sessionCount,
    completed_turns: states.reduce((sum, state) => sum + state.completed_turns, 0),
    elapsed_ms: Math.round(elapsedMs),
    turns_per_second: Math.round(sessionCount / (elapsedMs / 1000)),
    status: "ok",
  }));
} finally {
  for (const socket of sockets) socket.terminate();
  await Promise.all(sessions.map((session) => managedAgentFetch(
    session,
    `${baseUrl}/sessions/${session.session_id}`,
    { method: "DELETE" },
  ).catch(() => {})));
}

async function createSession() {
  const response = await fetch(`${baseUrl}/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  if (!response.ok) throw new Error(`session creation failed with HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

function createInbox(socket) {
  const messages = [];
  const waiters = [];
  const onMessage = (data) => {
    const message = JSON.parse(String(data));
    const index = waiters.findIndex(({ predicate }) => predicate(message));
    if (index === -1) messages.push(message);
    else waiters.splice(index, 1)[0].resolve(message);
  };
  socket.on("message", onMessage);
  return {
    next(predicate, timeout) {
      const index = messages.findIndex(predicate);
      if (index !== -1) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiters.push(waiter);
        const timer = setTimeout(() => {
          const pending = waiters.indexOf(waiter);
          if (pending !== -1) waiters.splice(pending, 1);
          reject(new Error(`WebSocket message timed out after ${timeout}ms`));
        }, timeout);
        waiter.resolve = (message) => {
          clearTimeout(timer);
          resolve(message);
        };
      });
    },
  };
}
