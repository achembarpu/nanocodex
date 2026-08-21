import assert from "node:assert/strict";
import test from "node:test";

import { createElement } from "react";
import { act, create } from "react-test-renderer";

import { createAgentConfig } from "../../bindings/browser/config.mjs";
import {
  NanocodexProvider,
  useAgent,
  useAgentEvents,
  useConfig,
} from "../index.mjs";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("NanocodexProvider requires one explicit caller-owned config", () => {
  assert.throws(
    () => NanocodexProvider({ children: null }),
    /requires a config/,
  );
});

test("useAgent follows the vanilla external store without duplicating Agent ownership", async () => {
  const store = createStore();
  let resource;
  let resolvedConfig;

  function Consumer({ enabled = true, threadId }) {
    resolvedConfig = useConfig();
    resource = useAgent({ enabled, threadId });
    return null;
  }

  let root;
  await act(async () => {
    root = create(createElement(
      NanocodexProvider,
      { config: store.config },
      createElement(Consumer, { threadId: "thread-1" }),
    ));
  });

  assert.equal(resolvedConfig, store.config);
  assert.deepEqual(store.subscriptions, [{ enabled: true, threadId: "thread-1" }]);
  assert.equal(resource.status, "idle");
  assert.equal(resource.isIdle, true);
  assert.equal(resource.isPending, false);

  store.publish({ status: "pending" });
  await act(async () => store.flush());
  assert.equal(resource.status, "pending");
  assert.equal(resource.isPending, true);

  const agent = Object.freeze({ sessionId: "thread-1" });
  store.publish({ data: agent, status: "success" });
  await act(async () => store.flush());
  assert.equal(resource.data, agent);
  assert.equal(resource.isSuccess, true);
  assert.equal(resource.isError, false);

  resource.refetch();
  assert.deepEqual(store.refetches, [{ enabled: true, threadId: "thread-1" }]);

  await act(async () => {
    root.update(createElement(
      NanocodexProvider,
      { config: store.config },
      createElement(Consumer, { enabled: false, threadId: "thread-1" }),
    ));
  });
  assert.deepEqual(store.subscriptions.at(-1), { enabled: false, threadId: "thread-1" });
  assert.equal(store.unsubscribed, 1);

  await act(async () => root.unmount());
  assert.equal(store.unsubscribed, 2);
});

test("useAgent selectors suppress updates while their selected value stays equal", async () => {
  const store = createStore();
  let renders = 0;
  let selection;

  function Consumer() {
    renders += 1;
    selection = useAgent({
      selector: (resource) => ({ ready: resource.isSuccess }),
      equalityFn: (previous, next) => previous.ready === next.ready,
    });
    return null;
  }

  let root;
  await act(async () => {
    root = create(createElement(
      NanocodexProvider,
      { config: store.config },
      createElement(Consumer),
    ));
  });
  const initialRenders = renders;
  const idleSelection = selection;

  store.publish({ status: "pending" });
  await act(async () => store.flush());
  store.publish({ error: new Error("unavailable"), status: "error" });
  await act(async () => store.flush());

  assert.equal(renders, initialRenders);
  assert.equal(selection, idleSelection);
  assert.deepEqual(selection, { ready: false });

  store.publish({ data: Object.freeze({ sessionId: "thread-1" }), status: "success" });
  await act(async () => store.flush());
  assert.equal(renders, initialRenders + 1);
  assert.deepEqual(selection, { ready: true });
  const successSelection = selection;

  store.publish({ data: Object.freeze({ sessionId: "thread-2" }), status: "success" });
  await act(async () => store.flush());
  assert.equal(renders, initialRenders + 1);
  assert.equal(selection, successSelection);
  assert.equal(store.subscriptions.length, 1);

  await act(async () => root.unmount());
  assert.equal(store.unsubscribed, 1);
});

test("useAgent refetch cancels hung startup and unmount releases its replacement", { timeout: 2_000 }, async () => {
  const signals = [];
  const closed = [];
  let attempts = 0;
  const config = createAgentConfig({}, {
    create(_options, { signal }) {
      signals.push(signal);
      attempts += 1;
      if (attempts === 1) return new Promise(() => {});
      return Promise.resolve({
        session: {
          async shutdown() { closed.push("replacement"); },
        },
      });
    },
    async prepare() {},
  });
  let resource;

  function Consumer() {
    resource = useAgent();
    return null;
  }

  let root;
  await act(async () => {
    root = create(createElement(
      NanocodexProvider,
      { config },
      createElement(Consumer),
    ));
  });
  await waitFor(() => attempts === 1);

  await act(async () => resource.refetch());
  assert.equal(signals[0].aborted, true);
  await act(async () => waitFor(() => resource.isSuccess));
  assert.equal(attempts, 2);
  assert.equal(signals[1].aborted, false);

  await act(async () => root.unmount());
  await waitFor(() => closed.length === 1);
  assert.equal(signals[1].aborted, true);
  assert.deepEqual(closed, ["replacement"]);
  await config.destroy();
});

test("useAgentEvents commits listener changes without resubscribing", async () => {
  const callbacks = new Set();
  const watchOptions = [];
  let releases = 0;
  let offs = 0;
  const agent = {
    events: {
      watch(options) {
        watchOptions.push(options);
        return {
          onEvent(listener) {
            callbacks.add(listener);
            return () => {
              releases += 1;
              callbacks.delete(listener);
            };
          },
          off() { offs += 1; },
        };
      },
    },
  };
  const first = [];
  const second = [];

  function Consumer({ emitDuringRender = false, listener }) {
    useAgentEvents(agent, listener, { includeAllSessions: true });
    if (emitDuringRender) {
      for (const callback of callbacks) callback({ seq: 2 });
    }
    return null;
  }

  let root;
  await act(async () => {
    root = create(createElement(Consumer, { listener: (event) => first.push(event.seq) }));
  });
  for (const callback of callbacks) callback({ seq: 1 });

  await act(async () => {
    root.update(createElement(Consumer, {
      emitDuringRender: true,
      listener: (event) => second.push(event.seq),
    }));
  });
  for (const callback of callbacks) callback({ seq: 3 });

  assert.deepEqual(watchOptions, [{ includeAllSessions: true }]);
  assert.deepEqual(first, [1, 2]);
  assert.deepEqual(second, [3]);
  assert.equal(releases, 0);
  assert.equal(offs, 0);

  await act(async () => root.unmount());
  assert.equal(releases, 1);
  assert.equal(offs, 1);
  assert.equal(callbacks.size, 0);
});

function createStore() {
  let snapshot = Object.freeze({ data: undefined, error: undefined, status: "idle" });
  const listeners = new Set();
  const subscriptions = [];
  const refetches = [];
  let unsubscribed = 0;
  const config = Object.freeze({
    getAgent() { return snapshot; },
    subscribeAgent(parameters, listener) {
      subscriptions.push(parameters);
      listeners.add(listener);
      return () => {
        if (!listeners.delete(listener)) return;
        unsubscribed += 1;
      };
    },
    refetchAgent(parameters) { refetches.push(parameters); },
    async destroy() {},
  });
  return {
    config,
    flush() {
      for (const listener of listeners) listener();
    },
    publish(next) {
      snapshot = Object.freeze({
        data: next.data,
        error: next.error,
        status: next.status,
      });
    },
    refetches,
    subscriptions,
    get unsubscribed() { return unsubscribed; },
  };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.fail("condition was not reached");
}
