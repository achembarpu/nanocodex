import * as Agent from "./Agent.mjs";
import { prepareWorkerAgent } from "./WorkerAgent.mjs";

const IDLE_SNAPSHOT = Object.freeze({
  data: undefined,
  error: undefined,
  status: "idle",
});

/** Creates the stable browser runtime consumed by framework bindings. */
export function createConfig(options = {}) {
  return createAgentConfig(options, {
    create: Agent.create,
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

  function getEntry(parameters = {}) {
    const key = parameters.threadId ?? "";
    let entry = entries.get(key);
    if (entry) return entry;
    entry = {
      activeSubscribers: 0,
      agent: undefined,
      generation: 0,
      key,
      listeners: new Set(),
      snapshot: IDLE_SNAPSHOT,
      tail: Promise.resolve(),
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

  function enqueue(entry, operation) {
    const result = entry.tail.then(operation);
    entry.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function close(agent) {
    if (agent !== undefined) await agent.session.shutdown();
  }

  function start(entry, force = false) {
    if (destroyed || entry.activeSubscribers === 0) return;
    if (!force && (entry.snapshot.status === "pending" || entry.agent !== undefined)) return;
    const generation = ++entry.generation;
    publish(entry, "pending", undefined, undefined);
    void enqueue(entry, async () => {
      const previous = entry.agent;
      entry.agent = undefined;
      try {
        await close(previous);
      } catch (error) {
        if (generation === entry.generation && entry.activeSubscribers > 0) {
          publish(entry, "error", undefined, error);
        }
        return;
      }
      if (generation !== entry.generation || entry.activeSubscribers === 0 || destroyed) return;

      let candidate;
      for (let attempt = 0; attempt <= retry; attempt += 1) {
        try {
          candidate = await runtime.create({
            ...agentOptions,
            ...(entry.key === "" ? {} : { threadId: entry.key }),
          });
          break;
        } catch (error) {
          if (generation !== entry.generation || entry.activeSubscribers === 0 || destroyed) return;
          if (attempt === retry) {
            publish(entry, "error", undefined, error);
            return;
          }
          const delay = nonNegativeNumber(retryDelay(attempt + 1, error), "retryDelay result");
          if (delay > 0) await wait(delay);
        }
      }
      if (candidate === undefined) return;
      if (generation !== entry.generation || entry.activeSubscribers === 0 || destroyed) {
        await close(candidate).catch(reportError);
        return;
      }
      entry.agent = candidate;
      publish(entry, "success", candidate, undefined);
    });
  }

  function prepare(entry) {
    void runtime.prepare({
      ...(entry.key === "" ? {} : { threadId: entry.key }),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    }).catch(() => {
      // Agent.create reports an actionable error if warmup cannot be reused.
    });
  }

  function release(entry) {
    queueMicrotask(() => {
      if (entry.activeSubscribers > 0 || destroyed) return;
      const generation = ++entry.generation;
      void enqueue(entry, async () => {
        const current = entry.agent;
        entry.agent = undefined;
        await close(current).catch(reportError);
        if (generation !== entry.generation || entry.activeSubscribers > 0) return;
        publish(entry, "idle", undefined, undefined);
        if (entry.listeners.size === 0) entries.delete(entry.key);
      });
    });
  }

  const config = {
    getAgent(parameters = {}) {
      if (parameters.enabled === false || destroyed) return IDLE_SNAPSHOT;
      return getEntry(parameters).snapshot;
    },
    subscribeAgent(parameters = {}, listener) {
      if (typeof listener !== "function") throw new TypeError("subscribeAgent requires a listener");
      if (destroyed) return () => {};
      const entry = getEntry(parameters);
      prepare(entry);
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
        entry.listeners.delete(listener);
        if (!enabled) {
          if (entry.listeners.size === 0 && entry.activeSubscribers === 0) entries.delete(entry.key);
          return;
        }
        entry.activeSubscribers -= 1;
        if (entry.activeSubscribers === 0) release(entry);
      };
    },
    refetchAgent(parameters = {}) {
      if (parameters.enabled === false || destroyed) return;
      start(getEntry(parameters), true);
    },
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      const closures = [];
      for (const entry of entries.values()) {
        entry.generation += 1;
        entry.listeners.clear();
        entry.activeSubscribers = 0;
        closures.push(enqueue(entry, async () => {
          const current = entry.agent;
          entry.agent = undefined;
          await close(current);
        }));
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

function wait(duration) {
  return new Promise((resolve) => setTimeout(resolve, duration));
}
