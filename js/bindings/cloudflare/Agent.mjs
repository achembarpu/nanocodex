import * as HostAgent from "../host/Agent.mjs";
import * as Transport from "../browser/Transport.mjs";
import { createCloudflareDurabilityStore } from "../runtime/cloudflare-durability-store.mjs";
import { cloudflareEgress } from "./egress.mjs";
import { scopeCloudflareEgress } from "./egress-subject.mjs";
import {
  clearCloudflareEventSocket,
  createCloudflareEventSocket,
} from "./event-socket.mjs";

const STARTUP_TIMEOUT_MS = 10_000;
const APPLICATION_OPTIONS = new Set(["instructions", "tools"]);

/** @internal Binds the package-owned module to the public Cloudflare namespace. */
export function bindAgent(module) {
  return Object.freeze({
    create: (owner, options) => create(module, owner, options),
    destroy,
  });
}

/** Removes the package-owned durable history for one Cloudflare Agent. */
export function destroy(owner) {
  const context = resolveContext(owner);
  const storage = context.storage;
  createCloudflareDurabilityStore(storage);
  initializeAgentStorage(storage);
  const sessionId = storedSessionId(storage);
  storage.transactionSync(() => {
    if (sessionId !== undefined) {
      const journalId = `cloudflare:${sessionId}`;
      storage.sql.exec(
        "DELETE FROM nanocodex_journal_batches WHERE journal_id = ?",
        journalId,
      );
      storage.sql.exec(
        "DELETE FROM nanocodex_journals WHERE journal_id = ?",
        journalId,
      );
    }
    clearCloudflareEventSocket(context);
  });
}

/** @internal Creates one Agent with an explicitly supplied package module. */
export async function create(module, owner, options = {}) {
  const { context, egress, subject } = resolveOwner(owner);
  const agentOptions = applicationOptions(options);
  const eventSocket = createCloudflareEventSocket(context);
  const durability = createCloudflareDurabilityStore(context.storage);
  const sessionId = durableSessionId(context.storage);
  const endpoint = cloudflareEgress({
    binding: scopeCloudflareEgress(egress, subject),
  });
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
      module,
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

function resolveOwner(owner) {
  const context = resolveContext(owner);
  const egress = owner.env?.NANOCODEX;
  if (!egress || typeof egress.fetch !== "function") {
    throw new TypeError(
      "Cloudflare Agent.create requires the private owner.env.NANOCODEX Service Binding",
    );
  }
  const subject = context.id?.toString?.();
  if (typeof subject !== "string" || !subject) {
    throw new TypeError("Cloudflare Agent.create requires owner.ctx.id");
  }
  return { context, egress, subject };
}

function resolveContext(owner) {
  if (!owner || (typeof owner !== "object" && typeof owner !== "function")) {
    throw new TypeError("Cloudflare Agent.create requires a Durable Object instance");
  }
  const context = owner.ctx;
  if (!context || typeof context !== "object") {
    throw new TypeError("Cloudflare Agent.create requires owner.ctx");
  }
  return context;
}

function applicationOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Cloudflare Agent.create options must be an object");
  }
  for (const name of Object.keys(options)) {
    if (!APPLICATION_OPTIONS.has(name)) {
      throw new TypeError(
        `Cloudflare Agent.create does not accept ${name}; only instructions and tools are configurable`,
      );
    }
  }
  return options;
}

function durableSessionId(storage) {
  initializeAgentStorage(storage);
  let sessionId = storedSessionId(storage);
  if (sessionId !== undefined) return sessionId;
  const generated = uuidV7();
  storage.sql.exec(
    "INSERT OR IGNORE INTO nanocodex_cloudflare_agent (singleton, session_id) VALUES (1, ?)",
    generated,
  );
  sessionId = storedSessionId(storage);
  if (typeof sessionId !== "string" || !sessionId) {
    throw new Error("Cloudflare Agent failed to persist its runtime session ID");
  }
  return sessionId;
}

function initializeAgentStorage(storage) {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS nanocodex_cloudflare_agent (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      session_id TEXT NOT NULL UNIQUE
    )
  `);
}

function storedSessionId(storage) {
  return storage.sql.exec(
    "SELECT session_id FROM nanocodex_cloudflare_agent WHERE singleton = 1",
  ).toArray()[0]?.session_id;
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
