import { agentActions } from "../actions/index.mjs";
import { createAgentClient, defineRuntime, reportError } from "../internal.mjs";

const DEFAULT_MAX_PENDING_RPCS = 1_024;
const PREWARM_TIMEOUT_MS = 15_000;
const PREWARM_RETENTION_MS = 30_000;
const PROTOCOL = "nanocodex.worker-agent.v1";
const REALTIME_TAIL_INSTRUCTION = "The user just ended their realtime session. Here is the remaining handoff/transcript tail. You probably do not have to do anything; acknowledge the handoff unless the transcript itself asks for something.";
const recentImages = new Map();
let prewarmedWorker;

/** Creates a DefaultAgent whose owned driver and browser host live in one module Worker. */
export async function createWorkerAgent(options = {}, workerOptions = {}) {
  const config = serializeConfig(options);
  const worker = await claimWorker(config.harness, workerOptions);
  const connection = new WorkerConnection(worker, workerOptions);
  try {
    const root = await connection.boot(config);
    return createAgentClient(connection.runtime(), root);
  } catch (error) {
    connection.fail(error);
    throw error;
  }
}

/** Starts the exact module Worker and browser harness consumed by the next Agent.create. */
export function prepareWorkerAgent(options = {}, workerOptions = {}) {
  const harness = options.harness === false ? false : harnessDescriptor(options);
  const key = harnessKey(harness);
  if (prewarmedWorker?.key === key) return prewarmedWorker.ready;
  prewarmedWorker?.cancel(new Error("Nanocodex Agent Worker prewarm was replaced"));
  const worker = createWorker(workerOptions);
  const channel = randomId();
  let claimed = false;
  let expiryTimer;
  let startupTimer;
  let dispose;
  const ready = new Promise((resolve, reject) => {
    let settled = false;
    dispose = (error) => {
      clearTimeout(expiryTimer);
      clearTimeout(startupTimer);
      if (prewarmedWorker?.worker === worker) prewarmedWorker = undefined;
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate?.();
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    worker.onmessage = ({ data }) => {
      if (data?.protocol !== PROTOCOL || data.channel !== channel) return;
      if (data.type === "prewarmed") {
        if (settled) return;
        settled = true;
        clearTimeout(startupTimer);
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        if (!claimed) {
          expiryTimer = setTimeout(
            () => dispose(new Error("Nanocodex prepared Agent Worker expired")),
            PREWARM_RETENTION_MS,
          );
        }
        resolve();
      } else if (data.type === "fatal") {
        dispose(decodeError(data.error));
      }
    };
    worker.onerror = (event) => dispose(new Error(event?.message || "Nanocodex Agent Worker prewarm failed"));
    worker.onmessageerror = () => dispose(new Error("Nanocodex Agent Worker returned an unreadable prewarm message"));
    startupTimer = setTimeout(() => dispose(new Error("Nanocodex Agent Worker prewarm timed out")), PREWARM_TIMEOUT_MS);
    try { worker.postMessage({ protocol: PROTOCOL, channel, type: "prewarm", harness }); }
    catch (error) { dispose(error); }
  });
  prewarmedWorker = {
    cancel: dispose,
    claim() {
      claimed = true;
      clearTimeout(expiryTimer);
    },
    key,
    ready,
    worker,
  };
  return ready;
}

/**
 * Installs the reusable package RPC runtime in a Worker-like global scope.
 * Tests and advanced integrations may inject the explicitly local Agent creator.
 */
export function installWorkerAgentRuntime(scope = globalThis, options = {}) {
  if (!scope || typeof scope.postMessage !== "function") {
    throw new TypeError("the Worker Agent runtime requires a Worker-like scope");
  }
  const createAgent = options.createAgent ?? loadAgent;
  const prewarmLocal = options.prewarmLocal ?? prewarmLocalRuntime;
  let generation = 0;
  let channel;
  let bootPromise;
  let watcher;
  let watcherAgentId;
  let nextAgent = 1;
  const agents = new Map();
  const turns = new Map();
  const results = new Map();

  const post = (message, expectedGeneration = generation) => {
    if (expectedGeneration !== generation) return;
    scope.postMessage({ protocol: PROTOCOL, channel, ...message });
  };

  const cleanup = () => {
    watcher?.off();
    watcher = undefined;
    watcherAgentId = undefined;
    for (const turn of turns.values()) {
      try { turn.dispose(); } catch (error) { reportError(error); }
    }
    for (const agent of agents.values()) {
      try { agent.dispose(); } catch (error) { reportError(error); }
    }
    turns.clear();
    results.clear();
    agents.clear();
  };

  const boot = async (message) => {
    generation += 1;
    const currentGeneration = generation;
    cleanup();
    channel = message.channel;
    nextAgent = 1;
    try {
      const agent = await createAgent(await hydrateConfig(message.config));
      if (currentGeneration !== generation) {
        agent.dispose();
        return;
      }
      const agentId = `agent-${nextAgent++}`;
      agents.set(agentId, agent);
      watchAgent(agentId, agent, currentGeneration);
      post({ type: "ready", root: describeAgent(agentId, agent) }, currentGeneration);
    } catch (error) {
      post({ type: "fatal", error: encodeError(error) }, currentGeneration);
      cleanup();
    }
  };

  const handle = async (message, currentGeneration) => {
    try {
      const value = await dispatch(message, {
        agents,
        turns,
        results,
        allocateAgent,
        moveWatcherFrom,
      });
      if (!message.noReply) post({ type: "resolve", id: message.id, value }, currentGeneration);
    } catch (error) {
      post({ type: "reject", id: message.id, error: encodeError(error) }, currentGeneration);
    }
  };

  function allocateAgent(agent) {
    const id = `agent-${nextAgent++}`;
    agents.set(id, agent);
    return describeAgent(id, agent);
  }

  function watchAgent(agentId, agent, expectedGeneration = generation) {
    watcherAgentId = agentId;
    watcher = agent.events.watch({ includeAllSessions: true });
    watcher.onEvent((event) => post({ type: "event", event }, expectedGeneration));
  }

  function moveWatcherFrom(agentId) {
    if (watcherAgentId !== agentId) return;
    watcher?.off();
    watcher = undefined;
    watcherAgentId = undefined;
    for (const [candidateId, candidate] of agents) {
      if (candidateId !== agentId) {
        watchAgent(candidateId, candidate);
        break;
      }
    }
  }

  scope.onmessage = ({ data: message }) => {
    if (message?.protocol !== PROTOCOL) return;
    if (message.type === "prewarm") {
      void Promise.resolve().then(() => prewarmLocal(message.harness)).then(
        () => scope.postMessage({ protocol: PROTOCOL, channel: message.channel, type: "prewarmed" }),
        (error) => scope.postMessage({
          protocol: PROTOCOL,
          channel: message.channel,
          type: "fatal",
          error: encodeError(error),
        }),
      );
      return;
    }
    if (message.type === "boot") {
      bootPromise = boot(message);
      return;
    }
    if (message.channel !== channel || !bootPromise) return;
    const currentGeneration = generation;
    void bootPromise.then(() => handle(message, currentGeneration)).catch((error) => {
      post({ type: "reject", id: message.id, error: encodeError(error) }, currentGeneration);
    });
  };

  return Object.freeze({ dispose() { generation += 1; cleanup(); scope.onmessage = null; } });
}

async function dispatch(message, state) {
  const { agents, turns, results } = state;
  switch (message.type) {
    case "prompt": {
      const agent = required(agents, message.agentId, "agent");
      const turn = agent.turn.prompt(message.options);
      if (turns.has(message.turnId)) throw new Error(`duplicate Worker Agent turn: ${message.turnId}`);
      turns.set(message.turnId, turn);
      return undefined;
    }
    case "rpc": break;
    default: throw new Error(`unknown Worker Agent message: ${message.type}`);
  }
  const { method, args = [] } = message;
  if (method === "turn.result") {
    const turn = required(turns, args[0], "turn");
    const result = await turn.result();
    results.set(args[0], result);
    return { finalMessage: result.finalMessage, snapshot: result.snapshot, usage: result.usage, resultId: args[0] };
  }
  if (method === "turn.steer") return required(turns, args[0], "turn").steer(args[1]);
  if (method === "turn.cancel") return required(turns, args[0], "turn").cancel();
  if (method === "turn.dispose") {
    const turn = turns.get(args[0]);
    turns.delete(args[0]);
    results.delete(args[0]);
    turn?.dispose();
    return;
  }
  const agent = required(agents, args[0], "agent");
  if (method === "agent.fork") {
    const at = args[1] === undefined ? undefined : required(results, args[1], "turn result");
    return state.allocateAgent(await agent.session.fork(at === undefined ? {} : { at }));
  }
  if (method === "agent.spawn") return state.allocateAgent(await agent.session.spawn());
  if (method === "agent.compact") return agent.session.compact();
  if (method === "agent.setThinking") return agent.session.setThinking(args[1]);
  if (method === "agent.setFastMode") return agent.session.setFastMode(args[1]);
  if (method === "agent.appendDeveloperMessage") return agent.session.appendDeveloperMessage(args[1]);
  if (method === "agent.realtime.start") return agent.session.realtime.start();
  if (method === "agent.realtime.end") return agent.session.realtime.end();
  if (method === "agent.shutdown") {
    state.moveWatcherFrom(args[0]);
    return agent.session.shutdown();
  }
  if (method === "agent.dispose") {
    state.moveWatcherFrom(args[0]);
    agents.delete(args[0]);
    agent.dispose();
    return;
  }
  throw new Error(`unknown Worker Agent RPC method: ${method}`);
}

function required(map, id, kind) {
  const value = map.get(id);
  if (!value) throw new Error(`unknown Worker Agent ${kind}: ${id}`);
  return value;
}

function describeAgent(agentId, agent) {
  return { agentId, sessionId: agent.sessionId };
}

class WorkerConnection {
  constructor(worker, options) {
    this.worker = worker;
    this.channel = randomId();
    this.maxPending = options.maxPendingRpcs === undefined
      ? DEFAULT_MAX_PENDING_RPCS
      : positiveInteger(options.maxPendingRpcs, "maxPendingRpcs");
    this.nextRpc = 1;
    this.nextTurn = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.agents = 0;
    this.closed = false;
    worker.onmessage = ({ data }) => this.receive(data);
    worker.onerror = (event) => this.fail(new Error(event?.message || "Nanocodex Agent Worker failed"));
    worker.onmessageerror = () => this.fail(new Error("Nanocodex Agent Worker returned an unreadable message"));
  }

  boot(config) {
    const promise = this.pendingCall("boot");
    try { this.send({ type: "boot", config }); }
    catch (error) { this.rejectPending("boot", error); }
    return promise;
  }

  runtime() {
    return defineRuntime({
      key: "browser-worker-wasm",
      name: "Nanocodex Browser Worker WASM",
      type: "browser",
      create: (descriptor) => this.rawAgent(descriptor),
      subscribe: (listener) => { this.listeners.add(listener); return () => this.listeners.delete(listener); },
      adopt: () => { this.agents += 1; },
      dispose: (raw) => {
        if (!raw.released) {
          raw.released = true;
          this.sendBestEffort("agent.dispose", [raw.agentId]);
          this.agents -= 1;
        }
        if (this.agents === 0) this.close(new Error("the Nanocodex Agent Worker has been disposed"));
      },
      decorate: (agent) => agent.extend(agentActions()),
    });
  }

  rawAgent(descriptor) {
    const connection = this;
    const { agentId } = descriptor;
    return {
      agentId,
      sessionId: descriptor.sessionId,
      released: false,
      prompt(input, id) { return connection.prompt(agentId, { input, ...(id === undefined ? {} : { id }) }); },
      promptContent(input, id) { return connection.prompt(agentId, { input: JSON.parse(input), ...(id === undefined ? {} : { id }) }); },
      fork: async () => connection.rawAgent(await connection.rpc("agent.fork", [agentId])),
      forkFrom: async (result) => connection.rawAgent(await connection.rpc("agent.fork", [agentId, result.resultId])),
      spawn: async () => connection.rawAgent(await connection.rpc("agent.spawn", [agentId])),
      compact: () => connection.rpc("agent.compact", [agentId]),
      setThinking: (value) => connection.rpc("agent.setThinking", [agentId, value]),
      setFastMode: (value) => connection.rpc("agent.setFastMode", [agentId, value]),
      appendDeveloperMessage: async (text) => JSON.stringify(await connection.rpc("agent.appendDeveloperMessage", [agentId, text])),
      startRealtimeConversation: async () => JSON.stringify(await connection.rpc("agent.realtime.start", [agentId])),
      endRealtimeConversation: async () => JSON.stringify(await connection.rpc("agent.realtime.end", [agentId])),
      realtimeDelegation: (input, transcript) => formatRealtimeDelegation(input, JSON.parse(transcript)),
      realtimeTailDelegation: (transcript) => formatRealtimeTail(JSON.parse(transcript)),
      shutdown: () => connection.rpc("agent.shutdown", [agentId]),
      free() {},
    };
  }

  prompt(agentId, options) {
    this.assertOpen();
    const connection = this;
    assertCloneable(options, "turn prompt");
    const turnId = `turn-${this.nextTurn++}`;
    const accepted = this.pendingCall(turnId);
    void accepted.catch(() => {});
    try { this.send({ type: "prompt", id: turnId, agentId, turnId, options }); }
    catch (error) { this.rejectPending(turnId, error); }
    let result;
    let disposed = false;
    return {
      result() {
        result ||= accepted.then(() => connectionResult(thisConnection(), turnId));
        return result;
      },
      steer(input) { return accepted.then(() => thisConnection().rpc("turn.steer", [turnId, { input }])); },
      steerContent(input) { return accepted.then(() => thisConnection().rpc("turn.steer", [turnId, { input: JSON.parse(input) }])); },
      cancel() { return accepted.then(() => thisConnection().rpc("turn.cancel", [turnId])); },
      free() {
        if (disposed) return;
        disposed = true;
        thisConnection().sendBestEffort("turn.dispose", [turnId]);
      },
    };
    function thisConnection() { return connection; }
  }

  rpc(method, args) {
    this.assertOpen();
    assertCloneable(args, method);
    const id = `rpc-${this.nextRpc++}`;
    const promise = this.pendingCall(id);
    try { this.send({ type: "rpc", id, method, args }); }
    catch (error) { this.rejectPending(id, error); }
    return promise;
  }

  sendBestEffort(method, args) {
    if (this.closed) return;
    const id = `rpc-${this.nextRpc++}`;
    try { this.send({ type: "rpc", id, method, args, noReply: true }); } catch {}
  }

  pendingCall(id) {
    this.assertOpen();
    if (this.pending.size >= this.maxPending) {
      throw new RangeError(`Worker Agent exceeded its bound of ${this.maxPending} pending RPCs`);
    }
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  send(message) {
    this.assertOpen();
    this.worker.postMessage({ protocol: PROTOCOL, channel: this.channel, ...message });
  }

  receive(message) {
    if (this.closed || message?.protocol !== PROTOCOL || message.channel !== this.channel) return;
    if (message.type === "event") {
      for (const listener of this.listeners) listener(message.event);
      return;
    }
    if (message.type === "ready") return this.resolvePending("boot", message.root);
    if (message.type === "fatal") return this.fail(decodeError(message.error));
    if (message.type === "resolve") return this.resolvePending(message.id, message.value);
    if (message.type === "reject") return this.rejectPending(message.id, decodeError(message.error));
  }

  resolvePending(id, value) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.resolve(value);
  }

  rejectPending(id, error) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.reject(error);
  }

  assertOpen() {
    if (this.closed) throw new Error("the Nanocodex Agent Worker has been disposed");
  }

  fail(error) { this.close(error); }

  close(error) {
    if (this.closed) return;
    this.closed = true;
    const worker = this.worker;
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate?.();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.listeners.clear();
  }
}

async function connectionResult(connection, turnId) {
  const result = await connection.rpc("turn.result", [turnId]);
  return {
    finalMessage: result.finalMessage,
    resultId: result.resultId,
    snapshot: () => JSON.stringify(result.snapshot),
    usage: () => JSON.stringify(result.usage),
    free() {},
  };
}

function createWorker(options) {
  const supplied = options.worker ?? options.workerFactory;
  if (supplied !== undefined) {
    const worker = typeof supplied === "function" ? supplied() : supplied;
    if (!worker || typeof worker.postMessage !== "function") throw new TypeError("worker must be Worker-like");
    return worker;
  }
  if (typeof Worker !== "function") throw new Error("this environment does not provide module Workers");
  return new Worker(new URL("./agent.worker.mjs", import.meta.url), { type: "module", name: "nanocodex-agent" });
}

async function claimWorker(harness, options) {
  if (options.worker !== undefined || options.workerFactory !== undefined) {
    return createWorker(options);
  }
  const entry = prewarmedWorker;
  if (!entry || entry.key !== harnessKey(harness)) return createWorker(options);
  prewarmedWorker = undefined;
  entry.claim();
  await entry.ready;
  return entry.worker;
}

function serializeConfig(options) {
  const config = { ...options };
  const transport = options.transport;
  if (transport !== undefined) {
    const symbols = Object.getOwnPropertySymbols(transport);
    const resolver = symbols.map((symbol) => transport[symbol]).find((value) => typeof value === "function");
    if (!resolver) throw new TypeError("Worker Agent requires a Nanocodex Responses transport");
    const setup = resolver();
    if (setup.subscription !== undefined || setup.mpp !== undefined) {
      throw new TypeError("Worker Agent does not support function-backed ChatGPT or MPP transports");
    }
    const {
      apiKey,
      hostAuth,
      hostManagedProtocol: _hostManagedProtocol,
      ...connection
    } = setup;
    if (hostAuth === true) {
      if (typeof connection.createWebSocket === "function"
        || typeof connection.WebSocketImpl === "function") {
        throw new TypeError("Worker Agent host-managed transport callbacks must live inside a custom Worker");
      }
      config.transport = { kind: "host-managed", options: connection };
    } else {
      config.transport = { kind: "openai", options: { apiKey, ...connection } };
    }
  }
  if (config.harness !== false) config.harness = harnessDescriptor(config);
  delete config.threadId;
  assertNoFunctions(config, "Agent options");
  assertCloneable(config, "Agent options");
  return config;
}

async function hydrateConfig(config) {
  const { harness, ...options } = config;
  const [Transport, runtime] = await Promise.all([
    import("./Transport.mjs"),
    harness === false || harness === undefined
      ? undefined
      : import("../tools/browser/index.mjs").then(({ browser }) => browser({
          ...harness,
          web: { headers: { "x-nanocodex-request": "1" } },
          images: { headers: { "x-nanocodex-request": "1" } },
          recentImages: (sessionId, count) =>
            (recentImages.get(sessionId) ?? []).slice(-count),
          rememberImage: (sessionId, imageUrl) => {
            const images = recentImages.get(sessionId) ?? [];
            images.push(imageUrl);
            if (images.length > 5) images.splice(0, images.length - 5);
            recentImages.set(sessionId, images);
          },
        })),
  ]);
  if (options.transport?.kind === "openai") {
    options.transport = Transport.openAi(options.transport.options);
  } else if (options.transport?.kind === "host-managed") {
    options.transport = Transport.hostManaged(options.transport.options);
  }
  if (runtime) {
    const now = new Date();
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    Object.assign(options, {
      filesystem: runtime.filesystem,
      filesystemTools: false,
      instructions: options.instructions ?? runtime.instructions,
      tools: runtime.tools,
      executionEnvironment: options.executionEnvironment ?? {
        currentDate: localDate(now),
        timezone,
        ...(runtime.projectInstructions === undefined
          ? {}
          : { projectInstructions: runtime.projectInstructions }),
      },
    });
  }
  return options;
}

async function loadAgent(options) {
  const Agent = await import("./InlineAgent.mjs");
  if (typeof Agent.create !== "function") {
    throw new Error("browser/InlineAgent.mjs must expose create(options) for the package Worker entry");
  }
  return Agent.create(options);
}

async function prewarmLocalRuntime(harness) {
  const [{ initializeBrowserEngine }] = await Promise.all([
    import("./engine.mjs"),
    import("../tools/browser/index.mjs").then(({ prepareBrowser }) =>
      prepareBrowser(harness)),
  ]);
  await initializeBrowserEngine();
}

function assertNoFunctions(value, label, seen = new Set(), path = label) {
  if (typeof value === "function") throw new TypeError(`${path} cannot contain functions across the Worker boundary`);
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") continue;
    assertNoFunctions(value[key], label, seen, `${path}.${key}`);
  }
}

function assertCloneable(value, label) {
  try { structuredClone(value); }
  catch (error) { throw new TypeError(`${label} must be structured-clone-safe`, { cause: error }); }
}

function formatRealtimeDelegation(input, transcript = []) {
  if (typeof input !== "string") throw new TypeError("realtime delegation input must be a string");
  const escapedInput = escapeXml(input);
  const delta = transcriptText(transcript);
  return delta
    ? `<realtime_delegation>\n  <input>${escapedInput}</input>\n  <transcript_delta>${delta}</transcript_delta>\n</realtime_delegation>`
    : `<realtime_delegation>\n  <input>${escapedInput}</input>\n</realtime_delegation>`;
}

function formatRealtimeTail(transcript) {
  const delta = transcriptText(transcript);
  return delta
    ? `<realtime_delegation>\n  <source>transcript_tail_flush</source>\n  <input>${escapeXml(REALTIME_TAIL_INSTRUCTION)}</input>\n  <transcript_delta>${delta}</transcript_delta>\n</realtime_delegation>`
    : undefined;
}

function transcriptText(transcript) {
  if (!Array.isArray(transcript)) throw new TypeError("realtime transcript must be an array");
  return escapeXml(transcript.map((entry) => {
    if (!entry || (entry.role !== "user" && entry.role !== "assistant") || typeof entry.text !== "string") {
      throw new TypeError("realtime transcript entries require a user/assistant role and string text");
    }
    return `${entry.role}: ${entry.text}`;
  }).join("\n"));
}

function escapeXml(value) { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer`);
  return value;
}
function randomId() { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`; }
function nonEmptyString(value) { return typeof value === "string" && value ? value : undefined; }
function harnessDescriptor(options = {}) {
  return {
    threadId: nonEmptyString(options.threadId) ?? nonEmptyString(options.sessionId) ?? randomId(),
    origin: nonEmptyString(options.origin) ?? globalThis.location?.origin,
  };
}
function harnessKey(harness) { return `${harness?.origin ?? ""}\n${harness?.threadId ?? ""}`; }
function localDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function encodeError(error) { return { name: error?.name || "Error", message: error?.message || String(error), stack: error?.stack }; }
function decodeError(encoded = {}) { const error = encoded.name === "RangeError" ? new RangeError(encoded.message) : encoded.name === "TypeError" ? new TypeError(encoded.message) : new Error(encoded.message || "Worker Agent failed"); if (encoded.stack) error.stack = encoded.stack; return error; }
