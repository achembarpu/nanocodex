import WebSocket from "ws";

import {
  managedAccountFetch,
  managedAccountWebSocketOptions,
  parseManagedAgentReceipt,
  requireManagedApiKey,
} from "./managed-account-auth.mjs";

const baseUrl = process.env.NANOCODEX_WORKER_URL ?? "http://127.0.0.1:8787";
const apiKey = requireManagedApiKey();
const clients = Number(process.env.NANOCODEX_STRESS_CLIENTS ?? 32);
const pingsPerClient = Number(process.env.NANOCODEX_STRESS_PINGS ?? 128);
const expected = clients * pingsPerClient;

if (!Number.isSafeInteger(clients) || clients < 1 || clients > 256) throw new Error("clients must be 1-256");
if (!Number.isSafeInteger(pingsPerClient) || pingsPerClient < 1 || pingsPerClient > 10_000) {
  throw new Error("pings per client must be 1-10000");
}

const created = await managedAccountFetch(apiKey, `${baseUrl}/v1/agents`, {
  method: "POST",
});
if (!created.ok) throw new Error(`agent creation failed with HTTP ${created.status}: ${await created.text()}`);
const agent = parseManagedAgentReceipt(await created.json());
const sockets = [];

try {
  await Promise.all(Array.from({ length: clients }, async () => {
    const socket = new WebSocket(
      agent.websocket_url,
      managedAccountWebSocketOptions(apiKey),
    );
    await onceMessage(socket, (message) => message.type === "ready", 10_000);
    sockets.push(socket);
  }));

  let received = 0;
  const seen = new Set();
  const completed = Promise.withResolvers();
  const started = performance.now();
  for (const [client, socket] of sockets.entries()) {
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message.type !== "pong") return;
      seen.add(message.nonce);
      received += 1;
      if (received === expected) completed.resolve();
    });
    for (let ping = 0; ping < pingsPerClient; ping += 1) {
      socket.send(JSON.stringify({ type: "ping", nonce: `${client}:${ping}` }));
    }
  }
  await withTimeout(completed.promise, 30_000, "stress run timed out");
  const elapsedMs = performance.now() - started;
  if (seen.size !== expected) throw new Error(`received ${seen.size} unique nonces, expected ${expected}`);

  console.log(JSON.stringify({
    clients,
    messages: expected,
    elapsed_ms: Math.round(elapsedMs),
    messages_per_second: Math.round(expected / (elapsedMs / 1000)),
    status: "ok",
  }));
} finally {
  for (const socket of sockets) socket.close(1000, "stress complete");
  await managedAccountFetch(apiKey, `${baseUrl}/v1/agents/${agent.agent_id}`, {
    method: "DELETE",
  }).catch(() => {});
}

function onceMessage(socket, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const onError = (error) => finish(() => reject(error));
    const timer = setTimeout(() => finish(() => reject(new Error("WebSocket open timed out"))), timeoutMs);
    const onMessage = (data) => {
      const message = JSON.parse(String(data));
      if (!predicate(message)) return;
      finish(() => resolve(message));
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
    function finish(done) {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("error", onError);
      done();
    }
  });
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
