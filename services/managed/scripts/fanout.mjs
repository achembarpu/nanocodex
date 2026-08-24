import { randomUUID } from "node:crypto";
import WebSocket from "ws";

import {
  managedAccountFetch,
  managedAccountWebSocketOptions,
  parseManagedAgentReceipt,
  requireManagedApiKey,
} from "./managed-account-auth.mjs";

const baseUrl = process.env.NANOCODEX_WORKER_URL ?? "http://127.0.0.1:8787";
const apiKey = requireManagedApiKey();
const clients = Number(process.env.NANOCODEX_FANOUT_CLIENTS ?? 64);
const burst = Number(process.env.NANOCODEX_FANOUT_EVENTS ?? 512);
const timeoutMs = Number(process.env.NANOCODEX_FANOUT_TIMEOUT_MS ?? 60_000);

if (!Number.isSafeInteger(clients) || clients < 1 || clients > 64) throw new Error("clients must be 1-64");
if (!Number.isSafeInteger(burst) || burst < 1 || burst > 4_096) throw new Error("events must be 1-4096");

const created = await managedAccountFetch(apiKey, `${baseUrl}/v1/agents`, {
  method: "POST",
});
if (!created.ok) throw new Error(`agent creation failed with HTTP ${created.status}: ${await created.text()}`);
const agent = parseManagedAgentReceipt(await created.json());
const sockets = [];

try {
  const receivers = await Promise.all(Array.from({ length: clients }, async () => {
    const socket = new WebSocket(
      agent.websocket_url,
      managedAccountWebSocketOptions(apiKey),
    );
    sockets.push(socket);
    let events = 0;
    const ready = deferred();
    const terminal = deferred();
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message.type === "ready") ready.resolve();
      if (message.type === "event") events += 1;
      if (message.type === "turn_completed" || message.type === "turn_failed") terminal.resolve(message);
    });
    await withTimeout(ready.promise, 10_000, "WebSocket ready timed out");
    return { socket, terminal, eventCount: () => events };
  }));

  const id = randomUUID();
  const started = performance.now();
  receivers[0].socket.send(JSON.stringify({ type: "prompt", id, input: `Emit BURST_${burst}` }));
  const terminals = await withTimeout(
    Promise.all(receivers.map(({ terminal }) => terminal.promise)),
    timeoutMs,
    "fanout terminal timed out",
  );
  const elapsedMs = performance.now() - started;
  for (const terminal of terminals) {
    if (terminal.type !== "turn_completed" || terminal.final_message !== "BURST_OK") {
      throw new Error(`unexpected terminal: ${JSON.stringify(terminal)}`);
    }
  }
  const counts = receivers.map(({ eventCount }) => eventCount());
  if (new Set(counts).size !== 1 || counts[0] < burst) {
    throw new Error(`clients observed inconsistent event streams: ${JSON.stringify(counts)}`);
  }
  const deliveries = counts.reduce((sum, count) => sum + count, 0);
  console.log(JSON.stringify({
    clients,
    upstream_events: counts[0],
    websocket_deliveries: deliveries,
    elapsed_ms: Math.round(elapsedMs),
    deliveries_per_second: Math.round(deliveries / (elapsedMs / 1000)),
    status: "ok",
  }));
} finally {
  for (const socket of sockets) socket.terminate();
  await managedAccountFetch(apiKey, `${baseUrl}/v1/agents/${agent.agent_id}`, {
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
