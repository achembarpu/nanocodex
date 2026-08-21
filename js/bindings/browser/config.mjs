import { createWorkerAgent, prepareWorkerAgent } from "./WorkerAgent.mjs";

const IDLE_SNAPSHOT = Object.freeze({
  data: undefined,
  error: undefined,
  status: "idle",
});

/** Creates the stable browser runtime consumed by framework bindings. */
export function createConfig(options = {}) {
  return createAgentConfig(options, {
    create: createWorkerAgent,
    prepare: prepareWorkerAgent,
  });
}

/** @internal Dependency-injected config constructor used by focused tests. */
export function createAgentConfig(options = {}, runtime) {
  const entries = new Map();
  const agentOptions = Object.freeze({ ...(options.agent ?? {}) });
  const retry = nonNegativeInteger(options.retry ?? 2, "retry");
  const retryDelay = options.retryDelay ?? ((attempt) => 400 * attempt);
  if (typeof retryDelay !== "function") throw new TypeError("retryDelay must be a function");
  let destroyed = false;

  function createEntry(parameters = {}) {
    const key = parameters.threadId ?? "";
    const threadId = nonEmptyString(key)
      ?? nonEmptyString(agentOptions.threadId)
      ?? nonEmptyString(agentOptions.sessionId)
      ?? randomId();
    const createOptions = Object.freeze({
      ...agentOptions,
      threadId,
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    });
    const entry = {
      activeSubscribers: 0,
      agent: undefined,
      closing: Promise.resolve(),
      createOptions,
      generation: 0,
      key,
      listeners: new Set(),
      operation: undefined,
      snapshot: IDLE_SNAPSHOT,
    };
    entries.set(key, entry);
    return entry;
  }

  function publish(entry, status, data, error) {
    const snapshot = Object.freeze({ data, error, status });
    if (
      entry.snapshot.status === snapshot.status
      && entry.snapshot.data === snapshot.data
      && entry.snapshot.error === snapshot.error
    ) return;
    entry.snapshot = snapshot;
    for (const listener of entry.listeners) listener();
  }

  async function close(agent) {
    if (agent !== undefined) await agent.session.shutdown();
  }

  function retireAgent(entry) {
    const agent = entry.agent;
    entry.agent = undefined;
    if (agent === undefined) return entry.closing;
    const closing = entry.closing.then(() => close(agent));
    entry.closing = closing.catch(() => {});
    return closing;
  }

  function cancelGeneration(entry) {
    entry.generation += 1;
    const operation = entry.operation;
    entry.operation = undefined;
    operation?.controller.abort();
  }

  function isCurrent(entry, operation) {
    return !destroyed
      && entry.operation === operation
      && entry.generation === operation.generation
      && entry.activeSubscribers > 0;
  }

  function finishGeneration(entry, operation) {
    if (entry.operation !== operation) return;
    entry.operation = undefined;
    operation.controller.abort();
  }

  function start(entry, force = false) {
    if (destroyed || entry.activeSubscribers === 0) return;
    if (!force && (entry.operation !== undefined || entry.agent !== undefined)) return;
    cancelGeneration(entry);
    const operation = {
      controller: new AbortController(),
      generation: ++entry.generation,
    };
    entry.operation = operation;
    const closing = retireAgent(entry);
    publish(entry, "pending", undefined, undefined);
    try {
      void Promise.resolve(runtime.prepare(entry.createOptions, {
        signal: operation.controller.signal,
      })).catch(() => {
        // Agent.create reports an actionable error if warmup cannot be reused.
      });
    } catch {
      // Agent.create reports an actionable error if warmup cannot be reused.
    }
    void runGeneration(entry, operation, closing);
  }

  async function runGeneration(entry, operation, closing) {
    try {
      try {
        await closing;
      } catch (error) {
        if (isCurrent(entry, operation)) publish(entry, "error", undefined, error);
        finishGeneration(entry, operation);
        return;
      }
      if (!isCurrent(entry, operation)) return;

      let candidate;
      for (let attempt = 0; attempt <= retry; attempt += 1) {
        if (!isCurrent(entry, operation)) return;
        try {
          candidate = await runtime.create(entry.createOptions, {
            signal: operation.controller.signal,
          });
          break;
        } catch (error) {
          if (!isCurrent(entry, operation)) return;
          if (attempt === retry) {
            publish(entry, "error", undefined, error);
            finishGeneration(entry, operation);
            return;
          }
          let delay;
          try {
            delay = nonNegativeNumber(retryDelay(attempt + 1, error), "retryDelay result");
          } catch (retryError) {
            if (isCurrent(entry, operation)) publish(entry, "error", undefined, retryError);
            finishGeneration(entry, operation);
            return;
          }
          if (delay > 0) {
            try {
              await wait(delay, operation.controller.signal);
            } catch {
              return;
            }
          }
        }
      }
      if (candidate === undefined) return;
      if (!isCurrent(entry, operation)) {
        await close(candidate).catch(reportError);
        return;
      }
      entry.agent = candidate;
      publish(entry, "success", candidate, undefined);
    } catch (error) {
      if (isCurrent(entry, operation)) {
        publish(entry, "error", undefined, error);
        finishGeneration(entry, operation);
      }
    }
  }

  function release(entry) {
    queueMicrotask(() => {
      if (entry.activeSubscribers > 0 || destroyed) return;
      const closing = retireAgent(entry);
      publish(entry, "idle", undefined, undefined);
      void closing.catch(reportError).finally(() => {
        if (
          entries.get(entry.key) === entry
          && entry.activeSubscribers === 0
          && entry.listeners.size === 0
        ) entries.delete(entry.key);
      });
    });
  }

  const config = {
    getAgent(parameters = {}) {
      if (parameters.enabled === false || destroyed) return IDLE_SNAPSHOT;
      return entries.get(parameters.threadId ?? "")?.snapshot ?? IDLE_SNAPSHOT;
    },
    subscribeAgent(parameters = {}, listener) {
      if (typeof listener !== "function") throw new TypeError("subscribeAgent requires a listener");
      if (destroyed) return () => {};
      const key = parameters.threadId ?? "";
      const entry = entries.get(key) ?? createEntry(parameters);
      entry.listeners.add(listener);
      const enabled = parameters.enabled !== false;
      if (enabled) {
        entry.activeSubscribers += 1;
        start(entry);
      }
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        if (destroyed) return;
        entry.listeners.delete(listener);
        if (!enabled) {
          if (entry.listeners.size === 0 && entry.activeSubscribers === 0) entries.delete(entry.key);
          return;
        }
        entry.activeSubscribers -= 1;
        if (entry.activeSubscribers === 0) {
          cancelGeneration(entry);
          release(entry);
        }
      };
    },
    refetchAgent(parameters = {}) {
      if (parameters.enabled === false || destroyed) return;
      const entry = entries.get(parameters.threadId ?? "");
      if (entry !== undefined) start(entry, true);
    },
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      const closures = [];
      for (const entry of entries.values()) {
        cancelGeneration(entry);
        entry.snapshot = IDLE_SNAPSHOT;
        const listeners = [...entry.listeners];
        entry.listeners.clear();
        entry.activeSubscribers = 0;
        for (const listener of listeners) {
          try { listener(); } catch (error) { reportError(error); }
        }
        closures.push(retireAgent(entry));
      }
      entries.clear();
      await Promise.all(closures);
    },
  };
  return Object.freeze(config);
}

function reportError(error) {
  try {
    if (typeof globalThis.reportError === "function") globalThis.reportError(error);
    else globalThis.console?.error?.(error);
  } catch {}
}

function nonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`);
  return value;
}

function nonNegativeNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }
  return value;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function randomId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function wait(duration, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => settle(resolve), duration);
    const onAbort = () => settle(reject, signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });

    function settle(complete, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      complete(value);
    }
  });
}
