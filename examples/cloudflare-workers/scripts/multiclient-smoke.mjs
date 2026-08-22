import { randomUUID } from "node:crypto";
import WebSocket from "ws";

import { managedAgentFetch, managedAgentWebSocketOptions } from "./managed-agent-auth.mjs";

const baseUrl = process.env.NANOCODEX_WORKER_URL ?? "http://127.0.0.1:8787";
const adminToken = process.env.NANOCODEX_ADMIN_TOKEN ?? "local-admin-token";
const clientCount = Number(process.env.NANOCODEX_MULTICLIENT_CLIENTS ?? 2);
const timeoutMs = Number(process.env.NANOCODEX_MULTICLIENT_TIMEOUT_MS ?? 120_000);

if (!Number.isSafeInteger(clientCount) || clientCount < 2 || clientCount > 64) {
  throw new Error("NANOCODEX_MULTICLIENT_CLIENTS must be 2-64");
}

const created = await fetch(`${baseUrl}/sessions`, {
  method: "POST",
  headers: { authorization: `Bearer ${adminToken}` },
});
if (!created.ok) throw new Error(`session creation failed with HTTP ${created.status}: ${await created.text()}`);
const session = await created.json();
const sockets = [];

try {
  const receivers = await Promise.all(Array.from({ length: clientCount }, async () => {
    const socket = new WebSocket(
      session.websocket_url,
      managedAgentWebSocketOptions(session),
    );
    sockets.push(socket);
    const ready = deferred();
    const terminal = deferred();
    let accepted = false;
    let events = 0;
    let text = "";
    socket.on("message", (encoded) => {
      const message = JSON.parse(String(encoded));
      if (message.type === "ready") ready.resolve();
      if (message.type === "turn_accepted") accepted = true;
      if (message.type === "event") {
        events += 1;
        if (message.event?.type === "assistant.delta" && typeof message.event.payload?.text === "string") {
          text += message.event.payload.text;
        }
      }
      if (message.type === "turn_completed" || message.type === "turn_failed") terminal.resolve(message);
    });
    await withTimeout(ready.promise, 10_000, "WebSocket ready timed out");
    return { socket, terminal, accepted: () => accepted, events: () => events, text: () => text };
  }));

  const id = randomUUID();
  receivers[0].socket.send(JSON.stringify({
    type: "prompt",
    id,
    input: "Reply with exactly MULTICLIENT_OK and nothing else.",
  }));
  const terminals = await withTimeout(
    Promise.all(receivers.map(({ terminal }) => terminal.promise)),
    timeoutMs,
    "shared turn timed out",
  );
  const first = terminals[0];
  if (first.type !== "turn_completed" || !first.final_message.includes("MULTICLIENT_OK")) {
    throw new Error(`unexpected terminal: ${JSON.stringify(first)}`);
  }
  if (terminals.some((terminal) => JSON.stringify(terminal) !== JSON.stringify(first))) {
    throw new Error("clients received different terminal results");
  }
  if (receivers.some(({ accepted }) => !accepted())) throw new Error("a client missed turn_accepted");
  const eventCounts = receivers.map(({ events }) => events());
  const streamed = receivers.map(({ text }) => text());
  if (new Set(eventCounts).size !== 1) throw new Error(`event counts diverged: ${eventCounts.join(",")}`);
  if (!streamed[0] || new Set(streamed).size !== 1) throw new Error("assistant streams diverged");
  console.log(JSON.stringify({
    session_id: session.session_id,
    clients: clientCount,
    events_per_client: eventCounts[0],
    streamed_bytes_per_client: Buffer.byteLength(streamed[0]),
    terminal: first.final_message,
    status: "ok",
  }));
} finally {
  for (const socket of sockets) socket.terminate();
  await managedAgentFetch(session, `${baseUrl}/sessions/${session.session_id}`, {
    method: "DELETE",
  }).catch(() => {});
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function withTimeout(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
