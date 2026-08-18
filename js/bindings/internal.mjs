const agentStates = new WeakMap();
const turnStates = new WeakMap();
const resultStates = new WeakMap();
const hostSessions = new Map();
const hostConnections = new Map();
let activeHost;
let nextHostConnection = 1;
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
  const raw = typeof input === "string"
    ? state.raw.prompt(input)
    : state.raw.promptContent(JSON.stringify(input));
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
  copy(config, "resume", options.resume);
  return config;
}

export function createEventChannel() {
  const listeners = new Set();
  return Object.freeze({
    emit(eventJson) {
      if (!listeners.size) return;
      const event = typeof eventJson === "string" ? JSON.parse(eventJson) : eventJson;
      const encodedLength = typeof eventJson === "string" ? eventJson.length : undefined;
      for (const listener of listeners) listener(event, encodedLength);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

export function activateHost(host) {
  if (!host || typeof host.connect !== "function") {
    throw new TypeError("a Nanocodex host must define connect()");
  }
  activeHost = host;
  globalThis.nanocodexHost = hostBridge;
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
  executeCode(source, sessionId, callId) {
    return requiredSessionHost(sessionId).executeCode(source, sessionId, callId);
  },
  executeTool(name, input, sessionId, callId) {
    return requiredSessionHost(sessionId).executeTool(name, input, sessionId, callId);
  },
  toolMode(sessionId) {
    // The WASM constructor asks before its session is adopted.
    return (hostSessions.get(sessionId) ?? requiredActiveHost()).toolMode();
  },
  toolDefinitions(sessionId) {
    // ModelRun builds its stable tool prefix inside the WASM constructor,
    // immediately before the returned session can be adopted. Runtime
    // factories activate their host directly around that synchronous step.
    return (hostSessions.get(sessionId) ?? requiredActiveHost()).toolDefinitions();
  },
  emitEvent(eventJson) {
    const event = JSON.parse(eventJson);
    requiredSessionHost(event.request_id).emitEvent(eventJson);
  },
});

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
  return runtime.decorate ? runtime.decorate(agent) : agent;
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

function requiredActiveHost() {
  if (!activeHost) throw new Error("no Nanocodex host is active");
  return activeHost;
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

function freezeJson(value) {
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
