const agentStates = new WeakMap();
const turnStates = new WeakMap();
const resultStates = new WeakMap();
const hostSessions = new Map();
const hostConnections = new Map();
const definitionHosts = new Map();
let nextHostConnection = 1;
let nextDefinitionHost = 1;
let nextAgentUid = 1;

export function defineRuntime(definition) {
  if (!definition || typeof definition.create !== "function") {
    throw new TypeError("a Nanocodex runtime must define create(options)");
  }
  return Object.freeze({
    key: definition.key ?? "custom",
    name: definition.name ?? "Nanocodex Agent",
    type: definition.type ?? "custom",
    create: definition.create,
    dispose: definition.dispose || ((agent) => agent.free()),
    subscribe: definition.subscribe,
    adopt: definition.adopt,
    release: definition.release,
    decorate: definition.decorate,
  });
}

export async function createAgentClient(runtime, options = {}) {
  if (!runtime || typeof runtime.create !== "function") {
    throw new TypeError("createAgent requires a Nanocodex runtime");
  }
  return createAgent(await runtime.create(options), runtime);
}

export function prompt(agent, options) {
  const state = agentState(agent);
  const input = actionInput(options);
  const operationId = options?.id;
  const raw = typeof input === "string"
    ? state.raw.prompt(input, operationId)
    : state.raw.promptContent(JSON.stringify(input), operationId);
  return createTurn(raw, agent);
}

export function getTurnResult(turn) {
  const state = turnState(turn);
  state.result ||= Promise.resolve()
    .then(() => state.raw.result())
    .then(createTurnResult);
  return state.result;
}

export function getTurnSnapshot(result) {
  return resultState(result).snapshot();
}

export function getTurnUsage(result) {
  return resultState(result).usage();
}

export function steer(turn, options) {
  const state = turnState(turn);
  const input = actionInput(options);
  return typeof input === "string"
    ? state.raw.steer(input)
    : state.raw.steerContent(JSON.stringify(input));
}

export function cancel(turn) {
  return turnState(turn).raw.cancel();
}

export async function fork(agent, options) {
  const state = agentState(agent);
  const at = options?.at;
  const raw = at === undefined
    ? await state.raw.fork()
    : await state.raw.forkFrom(resultState(at).raw);
  return createAgent(raw, state.runtime);
}

export async function spawn(agent) {
  const state = agentState(agent);
  return createAgent(await state.raw.spawn(), state.runtime);
}

export function setThinking(agent, thinking) {
  return agentState(agent).raw.setThinking(thinking);
}

export function setFastMode(agent, enabled) {
  return agentState(agent).raw.setFastMode(enabled);
}

export function compact(agent) {
  return agentState(agent).raw.compact();
}

export async function appendDeveloperMessage(agent, text) {
  if (typeof text !== "string" || !text.trim()) {
    throw new TypeError("non-empty string");
  }
  return parseSessionContext(await agentState(agent).raw.appendDeveloperMessage(text));
}

export async function startRealtimeConversation(agent) {
  return parseSessionContext(await agentState(agent).raw.startRealtimeConversation());
}

export async function endRealtimeConversation(agent) {
  return parseSessionContext(await agentState(agent).raw.endRealtimeConversation());
}

export function realtimeDelegation(agent, input, transcript = []) {
  return agentState(agent).raw.realtimeDelegation(input, JSON.stringify(transcript));
}

export function realtimeTailDelegation(agent, transcript) {
  return agentState(agent).raw.realtimeTailDelegation(JSON.stringify(transcript));
}

export async function shutdown(agent) {
  const state = knownAgentState(agent);
  if (state.shutdownPromise) return state.shutdownPromise;
  if (state.disposed) throw new Error("the Nanocodex agent has been disposed");
  if (typeof state.raw.shutdown !== "function") {
    throw new Error("this Nanocodex runtime does not expose graceful shutdown");
  }
  state.disposed = true;
  state.shutdownPromise = joinAgentShutdown(state);
  return state.shutdownPromise;
}

function parseSessionContext(context) {
  return JSON.parse(context);
}

export function subscribeAgentEvents(agent, listener, options = {}, onRelease) {
  const state = agentState(agent);
  if (typeof state.runtime.subscribe !== "function") {
    throw new Error("this Nanocodex runtime does not expose agent events");
  }
  if (typeof listener !== "function") {
    throw new TypeError("watchAgentEvents requires a listener");
  }
  const unsubscribe = state.runtime.subscribe((event, encodedLength) => {
    if (options.includeAllSessions || !event?.request_id || event.request_id === agent.sessionId) {
      listener(event, encodedLength);
    }
  });
  let active = true;
  const subscription = {
    close(notify) {
      if (!active) return;
      active = false;
      state.subscriptions.delete(subscription);
      const errors = [];
      runCleanup(errors, () => unsubscribe?.());
      if (notify) runCleanup(errors, () => onRelease?.());
      throwCleanupErrors(errors);
    },
  };
  state.subscriptions.add(subscription);
  return () => subscription.close(false);
}

export function toWasmConfig(options = {}) {
  const apiKey = options.apiKey;
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new TypeError("apiKey must be a non-empty string");
  }
  const config = { api_key: apiKey };
  copy(config, "model", options.model);
  copy(config, "thinking", options.thinking);
  copy(config, "reasoning_mode", options.reasoningMode);
  copy(config, "fast_mode", options.fastMode);
  copy(config, "websocket_warmup", options.websocketWarmup);
  copy(config, "websocket_url", options.websocketUrl);
  copy(config, "api_base_url", options.apiBaseUrl);
  copy(config, "instructions", options.instructions);
  copy(config, "session_id", options.sessionId);
  copy(config, "workspace", options.workspace);
  if (options.executionEnvironment !== undefined) {
    const environment = options.executionEnvironment;
    if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
      throw new TypeError("executionEnvironment must be an object");
    }
    config.execution_environment = {
      current_date: environment.currentDate,
      timezone: environment.timezone,
    };
    copy(
      config.execution_environment,
      "project_instructions",
      environment.projectInstructions,
    );
  }
  copy(config, "resume", options.resume);
  copy(config, "durability_id", options.durabilityId);
  copy(config, "subagents", options.subagents);
  copy(config, "host_definition_id", options.hostDefinitionId);
  return config;
}

export function createEventChannel() {
  const listeners = new Set();
  const sources = new Set();
  return Object.freeze({
    emit(eventJson, encodedBytes) {
      if (!listeners.size) return;
      const event = freezeJson(typeof eventJson === "string" ? JSON.parse(eventJson) : eventJson);
      const encodedLength = Number.isSafeInteger(encodedBytes) && encodedBytes >= 0
        ? encodedBytes
        : undefined;
      for (const listener of listeners) listener(event, encodedLength, eventJson);
    },
    subscribe(listener) {
      const activate = listeners.size === 0;
      listeners.add(listener);
      if (activate) {
        for (const source of sources) source.setEventForwarding?.(true);
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
        if (listeners.size === 0) {
          for (const source of sources) source.setEventForwarding?.(false);
        }
      };
    },
    addSource(source) {
      sources.add(source);
      if (listeners.size) source.setEventForwarding?.(true);
    },
    removeSource(source) {
      if (!sources.delete(source)) return;
      source.setEventForwarding?.(false);
    },
  });
}

export function activateHost(host) {
  if (!host || typeof host.connect !== "function") {
    throw new TypeError("a Nanocodex host must define connect()");
  }
  installHostBridge();
}

export function installHostBridge() {
  globalThis.nanocodexHost = hostBridge;
}

export function loadDurabilityRuntime() {
  return import("./runtime/durability.mjs");
}

export function reportError(error) {
  try {
    if (typeof globalThis.reportError === "function") globalThis.reportError(error);
    else globalThis.console?.error?.(error);
  } catch {}
}

export function bindHostSession(host, sessionId) {
  const existing = hostSessions.get(sessionId);
  if (existing && existing !== host) {
    throw new Error(`Nanocodex session ID is already active: ${sessionId}`);
  }
  hostSessions.set(sessionId, host);
}

export function releaseHostSession(host, sessionId) {
  if (hostSessions.get(sessionId) === host) hostSessions.delete(sessionId);
}

export function registerDefinitionHost(host) {
  const id = nextDefinitionHost++;
  definitionHosts.set(id, host);
  return id;
}

export function releaseDefinitionHost(id) {
  definitionHosts.delete(id);
}

const hostBridge = Object.freeze({
  async connect(endpoint, apiKey, accountId, fedramp, sessionId, turnState) {
    const host = requiredSessionHost(sessionId);
    let result;
    try {
      result = JSON.parse(await host.connect(endpoint, apiKey, sessionId, {
        accountId: accountId ?? undefined,
        fedramp,
        turnState: turnState ?? undefined,
      }));
    } catch (error) {
      throw JSON.stringify(connectFailure(error));
    }
    const handle = nextHostConnection++;
    hostConnections.set(handle, { host, handle: result.handle });
    hostSessions.set(sessionId, host);
    return JSON.stringify({ ...result, handle });
  },
  send(handle, message) {
    const connection = hostConnections.get(handle);
    return connection
      ? connection.host.send(connection.handle, message)
      : Promise.resolve(JSON.stringify({ ok: false, reconnectable: true, error: "unknown WebSocket handle" }));
  },
  next(handle, timeoutMs) {
    const connection = hostConnections.get(handle);
    return connection
      ? connection.host.next(connection.handle, timeoutMs)
      : Promise.resolve(JSON.stringify({ kind: "closed", detail: "for an unknown WebSocket handle" }));
  },
  close(handle) {
    const connection = hostConnections.get(handle);
    if (!connection) return;
    hostConnections.delete(handle);
    connection.host.close(connection.handle);
  },
  sleep(sessionId, milliseconds) {
    const host = requiredSessionHost(sessionId);
    if (typeof host.sleep !== "function") {
      throw new TypeError("the selected Nanocodex host must define sleep(milliseconds)");
    }
    return host.sleep(milliseconds);
  },
  bindSubagentSession(rootSessionId, sessionId) {
    const host = requiredSessionHost(rootSessionId);
    const existing = hostSessions.get(sessionId);
    if (existing && existing !== host) {
      throw new Error(`Nanocodex subagent session ID is already active: ${sessionId}`);
    }
    hostSessions.set(sessionId, host);
  },
  releaseSubagentSession(sessionId) {
    const host = hostSessions.get(sessionId);
    if (!host) return;
    host.releaseSession(sessionId);
    hostSessions.delete(sessionId);
  },
  executeCode(source, sessionId, callId) {
    return requiredSessionHost(sessionId).executeCode(source, sessionId, callId);
  },
  executeTool(name, input, sessionId, callId) {
    return requiredSessionHost(sessionId).executeTool(name, input, sessionId, callId);
  },
  cancelCode(sessionId) {
    hostSessions.get(sessionId)?.cancelCode?.(sessionId);
  },
  readWorkspaceFile(path, sessionId) {
    return requiredSessionHost(sessionId).readWorkspaceFile(path);
  },
  writeWorkspaceFile(path, contents, sessionId) {
    return requiredSessionHost(sessionId).writeWorkspaceFile(path, contents);
  },
  removeWorkspaceFile(path, sessionId) {
    return requiredSessionHost(sessionId).removeWorkspaceFile(path);
  },
  async subscriptionLoad(subscriptionId) {
    return (await loadSubscriptionRuntime()).load(subscriptionId);
  },
  async subscriptionCompareAndSwap(subscriptionId, expectedRevision, payload) {
    return (await loadSubscriptionRuntime()).compareAndSwap(
      subscriptionId,
      expectedRevision,
      payload,
    );
  },
  async subscriptionRequest(subscriptionId, request) {
    return (await loadSubscriptionRuntime()).request(subscriptionId, request);
  },
  toolMode(definitionHostId, sessionId) {
    return requiredDefinitionHost(definitionHostId).toolMode(sessionId);
  },
  toolDefinitions(definitionHostId, sessionId) {
    // ModelRun builds its stable tool prefix inside the WASM constructor,
    // before the returned session can be adopted. The private definition host
    // keeps that lookup instance-scoped for roots and Rust-spawned children.
    return requiredDefinitionHost(definitionHostId).toolDefinitions(sessionId);
  },
  async durabilityLoad(journalId) {
    return (await loadDurabilityRuntime()).load(journalId);
  },
  async durabilityAppend(journalId, expectedRevision, payload) {
    return (await loadDurabilityRuntime()).append(
      journalId,
      expectedRevision,
      payload,
    );
  },
  emitEvent(sessionId, eventJson, encodedBytes) {
    requiredSessionHost(sessionId).emitEvent(eventJson, encodedBytes);
  },
});

export function loadSubscriptionRuntime() {
  return import("./runtime/chatgpt-subscription.mjs");
}

function createAgent(raw, runtime) {
  if (!raw || typeof raw.prompt !== "function") {
    throw new TypeError("the runtime returned an invalid Nanocodex agent handle");
  }
  const state = {
    raw,
    runtime,
    disposed: false,
    released: false,
    shutdownPromise: undefined,
    subscriptions: new Set(),
    sessionId: raw.sessionId,
    uid: `agent-${nextAgentUid++}`,
  };
  try {
    runtime.adopt?.(raw);
  } catch (error) {
    runtime.dispose(raw);
    throw error;
  }
  const agent = agentView(state, {});
  const decorated = runtime.decorate ? runtime.decorate(agent) : agent;
  return decorated;
}

function agentView(state, extensions) {
  let agent;
  const base = {
    uid: state.uid,
    key: state.runtime.key,
    name: state.runtime.name,
    type: state.runtime.type,
    get sessionId() { return state.sessionId; },
    extend(fn) {
      if (typeof fn !== "function") throw new TypeError("agent.extend requires a decorator function");
      const value = fn(agent);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("an agent decorator must return an object");
      }
      const extension = { ...value };
      for (const key of Object.keys(base)) delete extension[key];
      return agentView(state, deepMerge(extensions, extension));
    },
    dispose() {
      if (state.shutdownPromise) return;
      releaseAgentState(state);
    },
  };
  agent = Object.assign(base, extensions);
  agentStates.set(agent, state);
  return agent;
}

function requiredSessionHost(sessionId) {
  const host = hostSessions.get(sessionId);
  if (!host) throw new Error(`no Nanocodex host is active for session: ${sessionId}`);
  return host;
}

function requiredDefinitionHost(id) {
  const host = definitionHosts.get(id);
  if (!host) throw new Error(`no Nanocodex definition host is active: ${id}`);
  return host;
}

function releaseAgentState(state) {
  if (state.released) return;
  state.disposed = true;
  state.released = true;
  const errors = [];
  for (const subscription of [...state.subscriptions]) {
    runCleanup(errors, () => subscription.close(true));
  }
  runCleanup(errors, () => state.runtime.release?.(state.raw));
  runCleanup(errors, () => state.runtime.dispose(state.raw));
  throwCleanupErrors(errors);
}

async function joinAgentShutdown(state) {
  await Promise.resolve();
  let shutdownFailed = false;
  let shutdownError;
  try {
    await state.raw.shutdown();
  } catch (error) {
    shutdownFailed = true;
    shutdownError = error;
  }

  let cleanupFailed = false;
  let cleanupError;
  try {
    releaseAgentState(state);
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }

  if (shutdownFailed && cleanupFailed) {
    const cleanupErrors = cleanupError instanceof AggregateError
      ? cleanupError.errors
      : [cleanupError];
    throw new AggregateError(
      [shutdownError, ...cleanupErrors],
      "Nanocodex driver shutdown and resource release both failed",
    );
  }
  if (shutdownFailed) throw shutdownError;
  if (cleanupFailed) throw cleanupError;
}

function connectFailure(error) {
  if (typeof error === "string") {
    try {
      const encoded = JSON.parse(error);
      if (encoded?.kind === "handshake_rejected" || encoded?.kind === "transport") {
        return encoded;
      }
    } catch {}
  }
  const status = Number(error?.status);
  if (Number.isInteger(status) && status >= 100 && status <= 599) {
    const retryAfter = Number(error?.retryAfter);
    return {
      kind: "handshake_rejected",
      status,
      body: typeof error?.body === "string" ? error.body : errorDetail(error),
      ...(Number.isFinite(retryAfter) && retryAfter >= 0 ? { retry_after: retryAfter } : {}),
    };
  }
  return {
    kind: "transport",
    detail: errorDetail(error),
    reconnectable: true,
  };
}

function errorDetail(error) {
  return error && (error.stack || error.message) || String(error);
}

function createTurn(raw, agent) {
  if (!raw || typeof raw.result !== "function") {
    throw new TypeError("the runtime returned an invalid Nanocodex turn handle");
  }
  const state = { raw, agent, result: undefined, disposed: false };
  const turn = {
    get agent() { return state.agent; },
    result: () => getTurnResult(turn),
    steer: (input) => steer(turn, input),
    cancel: () => cancel(turn),
    dispose() {
      if (state.disposed) return;
      state.disposed = true;
      state.raw.free();
    },
  };
  turnStates.set(turn, state);
  return Object.freeze(turn);
}

function createTurnResult(raw) {
  if (
    !raw
    || typeof raw.finalMessage !== "string"
    || typeof raw.snapshot !== "function"
    || typeof raw.usage !== "function"
  ) {
    raw?.free?.();
    throw new TypeError("the runtime returned an invalid Nanocodex turn result");
  }
  const state = {
    raw,
    snapshotValue: undefined,
    usageValue: undefined,
    snapshot() {
      state.snapshotValue ||= freezeJson(JSON.parse(raw.snapshot()));
      return state.snapshotValue;
    },
    usage() {
      state.usageValue ||= freezeJson(JSON.parse(raw.usage()));
      return state.usageValue;
    },
  };
  const result = {
    finalMessage: raw.finalMessage,
    get snapshot() { return state.snapshot(); },
    get usage() { return state.usage(); },
  };
  resultStates.set(result, state);
  return Object.freeze(result);
}

function agentState(agent) {
  const state = knownAgentState(agent);
  if (state.disposed) throw new Error("the Nanocodex agent has been disposed");
  return state;
}

function knownAgentState(agent) {
  const state = agentStates.get(agent);
  if (!state) throw new TypeError("expected a Nanocodex agent");
  return state;
}

function turnState(turn) {
  const state = turnStates.get(turn);
  if (!state) throw new TypeError("expected a Nanocodex turn");
  if (state.disposed) throw new Error("the Nanocodex turn has been disposed");
  return state;
}

function resultState(result) {
  const state = resultStates.get(result);
  if (!state) throw new TypeError("expected a completed Nanocodex turn result");
  return state;
}

function actionInput(options) {
  const input = options?.input;
  if (typeof input !== "string" && !Array.isArray(input)) {
    throw new TypeError("turn input must be a string or ordered content array");
  }
  return input;
}

function deepMerge(left, right) {
  const merged = { ...left };
  for (const [key, value] of Object.entries(right)) {
    merged[key] = isObject(merged[key]) && isObject(value)
      ? deepMerge(merged[key], value)
      : value;
  }
  return merged;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function copy(target, key, value) {
  if (value !== undefined) target[key] = value;
}

function runCleanup(errors, cleanup) {
  try {
    cleanup();
  } catch (error) {
    errors.push(error);
  }
}

function throwCleanupErrors(errors) {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "multiple Nanocodex resources failed to release");
  }
}

export function freezeJson(value) {
  if (!value || typeof value !== "object") return value;
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (Object.isFrozen(current)) continue;
    for (const child of Object.values(current)) {
      if (child && typeof child === "object" && !Object.isFrozen(child)) pending.push(child);
    }
    Object.freeze(current);
  }
  return value;
}
