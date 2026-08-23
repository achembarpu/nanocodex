import * as HostAgent from "../host/Agent.mjs";
import * as Transport from "../browser/Transport.mjs";
import { createCloudflareDurabilityStore } from "../runtime/cloudflare-durability-store.mjs";
import { cloudflareEgress } from "./egress.mjs";
import { createCloudflareEventSocket } from "./event-socket.mjs";

const STARTUP_TIMEOUT_MS = 10_000;
const RESERVED_OPTIONS = new Set([
  "accessToken",
  "apiBaseUrl",
  "apiKey",
  "bearerToken",
  "createWebSocket",
  "credentials",
  "durability",
  "durabilityId",
  "sessionId",
  "subscription",
  "token",
  "transport",
  "websocketPreconnect",
  "websocketUrl",
]);

/** Creates one durable, host-managed Nanocodex Agent in a Cloudflare Durable Object. */
export async function create(options) {
  const { context, egress, authMode, agentOptions } = splitOptions(options);
  const eventSocket = createCloudflareEventSocket(context);
  const durability = createCloudflareDurabilityStore(context.storage);
  const sessionId = durableSessionId(context.storage);
  const endpoint = cloudflareEgress({ binding: egress, authMode });
  const startup = deferred();
  const transport = Transport.hostManaged({
    ...endpoint,
    websocketPreconnect: true,
    async createWebSocket(url, id, request) {
      try {
        const opened = await endpoint.createWebSocket(url, id, request);
        if (request.authorization === "preconnect") startup.resolve();
        return opened;
      } catch (error) {
        if (request.authorization === "preconnect") startup.reject(error);
        throw error;
      }
    },
  });

  let agent;
  try {
    agent = await HostAgent.create({
      ...agentOptions,
      toolMode: agentOptions.toolMode ?? "direct",
      transport,
      sessionId,
      durability,
      durabilityId: `cloudflare:${sessionId}`,
    });
    await withTimeout(
      startup.promise,
      STARTUP_TIMEOUT_MS,
      "Cloudflare Agent EGRESS startup validation timed out",
    );
  } catch (error) {
    if (agent) await agent.session.shutdown().catch(() => {});
    throw error;
  }

  const watcher = agent.events.watch();
  let unwatch;
  unwatch = watcher.onEvent((event) => {
    try {
      eventSocket.publish(event);
    } catch (error) {
      unwatch?.();
      eventSocket.fail(error);
      console.error("Nanocodex Cloudflare event projection failed", error);
    }
  });
  return agent.extend(() => ({
    events: {
      connect: (request) => eventSocket.connect(request),
    },
  }));
}

function splitOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Cloudflare Agent.create requires options");
  }
  for (const name of Object.keys(options)) {
    const credentialLike = /(?:api[_-]?key|access[_-]?token|bearer[_-]?token|refresh[_-]?token|oauth|credential|secret)/i
      .test(name);
    if (RESERVED_OPTIONS.has(name) || credentialLike) {
      throw new TypeError(
        `Cloudflare Agent.create does not accept ${name}; transport, credentials, and durability are managed by the Durable Object adapter`,
      );
    }
  }
  const { context, egress, authMode, ...agentOptions } = options;
  if (!egress || typeof egress.fetch !== "function") {
    throw new TypeError("Cloudflare Agent.create requires a private EGRESS Service Binding");
  }
  if (authMode !== "api_key" && authMode !== "chatgpt") {
    throw new TypeError("Cloudflare Agent.create authMode must be explicitly set to api_key or chatgpt");
  }
  return { context, egress, authMode, agentOptions };
}

function durableSessionId(storage) {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS nanocodex_cloudflare_agent (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      session_id TEXT NOT NULL UNIQUE
    )
  `);
  let sessionId = storage.sql.exec(
    "SELECT session_id FROM nanocodex_cloudflare_agent WHERE singleton = 1",
  ).toArray()[0]?.session_id;
  if (sessionId !== undefined) return sessionId;
  const generated = uuidV7();
  storage.sql.exec(
    "INSERT OR IGNORE INTO nanocodex_cloudflare_agent (singleton, session_id) VALUES (1, ?)",
    generated,
  );
  sessionId = storage.sql.exec(
    "SELECT session_id FROM nanocodex_cloudflare_agent WHERE singleton = 1",
  ).toArray()[0]?.session_id;
  if (typeof sessionId !== "string" || !sessionId) {
    throw new Error("Cloudflare Agent failed to persist its runtime session ID");
  }
  return sessionId;
}

function uuidV7() {
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    throw new Error("Cloudflare Agent requires crypto.getRandomValues()");
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  let timestamp = Date.now();
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp % 256;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const encoded = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  return `${encoded.slice(0, 4).join("")}-${encoded.slice(4, 6).join("")}-${encoded.slice(6, 8).join("")}-${encoded.slice(8, 10).join("")}-${encoded.slice(10).join("")}`;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
