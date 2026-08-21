import assert from "node:assert/strict";
import test from "node:test";

import { createElement } from "react";
import { act, create } from "react-test-renderer";

import {
  NanocodexProvider,
  useAgent,
  useAgentEvents,
  useConfig,
} from "../index.mjs";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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

test("useAgentEvents keeps the latest listener without resubscribing", async () => {
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

  function Consumer({ listener }) {
    useAgentEvents(agent, listener, { includeAllSessions: true });
    return null;
  }

  let root;
  await act(async () => {
    root = create(createElement(Consumer, { listener: (event) => first.push(event.seq) }));
  });
  for (const callback of callbacks) callback({ seq: 1 });

  await act(async () => {
    root.update(createElement(Consumer, { listener: (event) => second.push(event.seq) }));
  });
  for (const callback of callbacks) callback({ seq: 2 });

  assert.deepEqual(watchOptions, [{ includeAllSessions: true }]);
  assert.deepEqual(first, [1]);
  assert.deepEqual(second, [2]);
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
