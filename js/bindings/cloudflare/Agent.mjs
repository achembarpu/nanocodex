import * as HostAgent from "../host/Agent.mjs";
import {
  installHostBridge,
  loadDurabilityRuntime,
  observeAgentRelease,
  routePrompt,
} from "../internal.mjs";
import { pruneDurableReceipts as pruneWasmDurableReceipts } from "../pkg-web/nanocodex.js";
import * as Transport from "../browser/Transport.mjs";
import { initializeBrowserEngine } from "../browser/engine.mjs";
import { createCloudflareDurabilityStore } from "../runtime/cloudflare-durability-store.mjs";
import { durabilityRevision } from "../runtime/durability-store.mjs";
import { cloudflareEgress } from "./egress.mjs";
import { scopeCloudflareEgress } from "./egress-subject.mjs";
import {
  clearCloudflareEventSocket,
  createCloudflareEventSocket,
} from "./event-socket.mjs";

const STARTUP_TIMEOUT_MS = 10_000;
const INTERNAL_RUNTIME = Symbol.for("nanocodex.cloudflare.internalRuntime");
const EPHEMERAL_APPLICATION_OPTIONS = new Set([
  "fastMode",
  "instructions",
  "model",
  "reasoningMode",
  "resume",
  "sessionId",
  "thinking",
  "tools",
  "workspace",
]);
const APPLICATION_OPTIONS = new Set([
  "eventPersistence",
  "instructions",
  "terminalReceiptRetention",
  "tools",
]);
const lifecycles = new WeakMap();

/** @internal Binds the package-owned module to the public Cloudflare namespace. */
export function bindAgent(module, hostAgent = HostAgent) {
  return Object.freeze({
    pruneDurableReceipts: (owner, options) => pruneDurableReceipts(module, owner, options),
    create: (owner, options) => create(module, owner, options, hostAgent),
    createEphemeral: (owner, options) => createEphemeral(module, owner, options),
    destroy,
    route,
  });
}

/** Atomically steers an active Cloudflare Agent turn or starts a new turn. */
export function route(agent, options) {
  return routePrompt(agent, options);
}

/** Removes the package-owned durable history for one Cloudflare Agent. */
export function destroy(owner) {
  const context = resolveContext(owner);
  const lifecycle = lifecycles.get(context);
  if (lifecycle?.creating) {
    throw new Error("Cloudflare Agent creation must settle before destroy");
  }
  if (lifecycle?.active !== undefined) {
    throw new Error("Cloudflare Agent shutdown must complete before destroy");
  }
  const storage = context.storage;
  createCloudflareDurabilityStore(storage);
  initializeAgentStorage(storage);
  const sessionId = storedSessionId(storage);
  storage.transactionSync(() => {
    if (sessionId !== undefined) {
      const stateId = `cloudflare:${sessionId}`;
      const retained = storage.sql.exec(
        "SELECT fence FROM nanocodex_durable_owners WHERE state_id = ?",
        stateId,
      ).toArray();
      const fence = durabilityRevision(
        BigInt(durabilityRevision(retained[0]?.fence ?? "0")) + 1n,
      );
      storage.sql.exec(
        `INSERT INTO nanocodex_durable_owners (state_id, owner_id, fence) VALUES (?, ?, ?)
         ON CONFLICT (state_id) DO UPDATE SET owner_id = excluded.owner_id, fence = excluded.fence`,
        stateId,
        `destroy:${globalThis.crypto.randomUUID()}`,
        fence,
      );
      storage.sql.exec(
        "DELETE FROM nanocodex_durable_chunk_heads WHERE state_id = ?",
        stateId,
      );
      storage.sql.exec(
        "DELETE FROM nanocodex_durable_state_chunks WHERE state_id = ?",
        stateId,
      );
      storage.sql.exec(
        "DELETE FROM nanocodex_durable_states WHERE state_id = ?",
        stateId,
      );
    }
    clearCloudflareEventSocket(context);
  });
}

/** Prunes old terminal receipts before constructing the full Agent runtime. */
export async function pruneDurableReceipts(module, owner, options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Cloudflare durability receipt-pruning options must be an object");
  }
  const terminalReceiptRetention = options.terminalReceiptRetention ?? 512;
  if (!Number.isSafeInteger(terminalReceiptRetention)
    || terminalReceiptRetention < 0
    || terminalReceiptRetention > 4_096) {
    throw new TypeError("terminalReceiptRetention must be an integer from 0 through 4096");
  }
  const context = resolveContext(owner);
  const lifecycle = lifecycleFor(context);
  if (lifecycle.creating) {
    throw new Error("Cloudflare Agent lifecycle operation is already in progress");
  }
  if (lifecycle.active !== undefined) {
    throw new Error("Cloudflare Agent shutdown must complete before pruning durability receipts");
  }
  lifecycle.creating = true;
  try {
    const storage = context.storage;
    const durability = createCloudflareDurabilityStore(storage);
    initializeAgentStorage(storage);
    const sessionId = storedSessionId(storage);
    if (sessionId === undefined) return;
    const stateId = `cloudflare:${sessionId}`;
    const routeHost = {};
    const route = (await loadDurabilityRuntime()).own(
      routeHost,
      durability,
      stateId,
    );
    try {
      installHostBridge();
      await initializeBrowserEngine({ module });
      await pruneWasmDurableReceipts(route.id, stateId, terminalReceiptRetention);
    } finally {
      route.abandon();
    }
  } finally {
    lifecycle.creating = false;
  }
}

/** @internal Creates one Agent with an explicitly supplied package module. */
export async function create(module, owner, options = {}, hostAgent = HostAgent) {
  const resolved = resolveOwner(owner);
  const lifecycle = lifecycleFor(resolved.context);
  if (lifecycle.creating) {
    throw new Error("Cloudflare Agent creation is already in progress for this Durable Object");
  }
  if (lifecycle.active !== undefined) {
    throw new Error("Cloudflare Agent shutdown must complete before create");
  }
  lifecycle.creating = true;
  try {
    return await createOwned(module, resolved, options, hostAgent, lifecycle);
  } finally {
    lifecycle.creating = false;
  }
}

async function createOwned(module, resolved, options, hostAgent, lifecycle) {
  const { context, egress, subject } = resolved;
  const configured = applicationOptions(options);
  const {
    eventPersistence = "durable",
    [INTERNAL_RUNTIME]: internalRuntime,
    ...agentOptions
  } = configured;
  if (internalRuntime !== undefined
    && (!internalRuntime || typeof internalRuntime !== "object" || Array.isArray(internalRuntime))) {
    throw new TypeError("Cloudflare Agent internal runtime options must be an object");
  }
  const eventSocket = eventPersistence === "durable"
    ? createCloudflareEventSocket(context)
    : undefined;
  if (eventPersistence === "caller") clearCloudflareEventSocket(context);
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
  let watcher;
  let unwatch;
  try {
    agent = await hostAgent.create({
      ...agentOptions,
      module,
      toolMode: internalRuntime?.toolMode ?? "direct",
      codeEvaluator: internalRuntime?.codeEvaluator,
      [Symbol.for("nanocodex.browser.internalRuntime")]: {
        toolProviders: internalRuntime?.toolProviders,
      },
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

    if (eventSocket !== undefined) {
      watcher = agent.events.watch();
      unwatch = watcher.onEvent((event) => {
        try {
          eventSocket.publish(event);
        } catch (error) {
          unwatch?.();
          eventSocket.fail(error);
          console.error("Nanocodex Cloudflare event projection failed", error);
        }
      });
    }
    const exposed = agent.extend((owned) => ({
      events: {
        connect: (request) => eventSocket?.connect(request) ?? Response.json(
          { error: "event_persistence_caller_owned" },
          { status: 409 },
        ),
      },
      turn: {
        ...owned.turn,
        route: (options) => routePrompt(owned, options),
      },
    }));
    const active = {};
    lifecycle.active = active;
    observeAgentRelease(exposed, () => {
      if (lifecycle.active === active) lifecycle.active = undefined;
    });
    return exposed;
  } catch (error) {
    const cleanupErrors = [];
    try { unwatch?.(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    try { watcher?.off(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    if (agent) {
      try { await agent.session.shutdown(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (cleanupErrors.length > 0) {
      const cause = new AggregateError(
        [error, ...cleanupErrors],
        "Cloudflare Agent creation and resource rollback both failed",
      );
      throw Object.assign(
        new Error(
          `Cloudflare Agent creation failed and rollback requires reopen: ${errorMessage(error)}`,
          { cause },
        ),
        { code: "reopen_required" },
      );
    }
    throw error;
  }
}

function lifecycleFor(context) {
  let lifecycle = lifecycles.get(context);
  if (lifecycle === undefined) {
    lifecycle = { active: undefined, creating: false };
    lifecycles.set(context, lifecycle);
  }
  return lifecycle;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @internal Creates one non-durable Agent in the current Cloudflare isolate. */
export async function createEphemeral(module, owner, options = {}) {
  const { egress, subject } = resolveOwner(owner);
  const agentOptions = ephemeralApplicationOptions(options);
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
      toolMode: "direct",
      transport,
    });
    await withTimeout(
      startup.promise,
      STARTUP_TIMEOUT_MS,
      "Cloudflare ephemeral Agent EGRESS startup validation timed out",
    );
    return agent;
  } catch (error) {
    if (agent) await agent.session.shutdown().catch(() => {});
    throw error;
  }
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
        `Cloudflare Agent.create does not accept ${name}; only eventPersistence, instructions, terminalReceiptRetention, and tools are configurable`,
      );
    }
  }
  if (options.eventPersistence !== undefined
    && options.eventPersistence !== "durable"
    && options.eventPersistence !== "caller") {
    throw new TypeError(
      "Cloudflare Agent.create eventPersistence must be durable or caller",
    );
  }
  if (options.terminalReceiptRetention !== undefined
    && (!Number.isSafeInteger(options.terminalReceiptRetention)
      || options.terminalReceiptRetention < 0
      || options.terminalReceiptRetention > 4_096)) {
    throw new TypeError(
      "Cloudflare Agent.create terminalReceiptRetention must be an integer from 0 through 4096",
    );
  }
  return options;
}

function ephemeralApplicationOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Cloudflare Agent.createEphemeral options must be an object");
  }
  for (const name of Object.keys(options)) {
    if (!EPHEMERAL_APPLICATION_OPTIONS.has(name)) {
      throw new TypeError(
        `Cloudflare Agent.createEphemeral does not accept ${name}; transport and runtime policy are owned by the adapter`,
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
  // Preconnect may fail before HostAgent.create returns and installs the
  // startup waiter. Mark the original promise handled without changing what
  // the later await observes.
  void promise.catch(() => {});
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
