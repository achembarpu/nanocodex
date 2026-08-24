import assert from "node:assert/strict";
import test from "node:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { act, create } from "react-test-renderer";

import { createConfig, useConnectAgent } from "../cloud/index.mjs";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("useConnectAgent reopens one persisted durable grant session on mount", async () => {
  const connection = Object.freeze({ grant: Object.freeze({ id: "0x01" }) });
  const agent = Object.freeze({ id: "agent-durable" });
  let reconnects = 0;
  let creates = 0;
  let notifications = 0;
  const config = createConfig({
    client: {
      _hasSession() { return true; },
      connection: {
        async reconnect() {
          reconnects += 1;
          return connection;
        },
      },
      agent: {
        async create(options) {
          creates += 1;
          assert.equal(options.connection, connection);
          return agent;
        },
      },
    },
  });
  const unsubscribe = config.subscribe(() => { notifications += 1; });
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  let snapshot;

  function Consumer() {
    snapshot = useConnectAgent({ config });
    return null;
  }

  let root;
  await act(async () => {
    root = create(createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(Consumer),
    ));
  });
  await waitFor(() => snapshot.connectionStatus === "connected");

  assert.equal(reconnects, 1);
  assert.equal(creates, 1);
  assert.equal(notifications, 1);
  assert.equal(snapshot.connection, connection);
  assert.equal(snapshot.agent, agent);
  await act(async () => root.unmount());
  unsubscribe();
  queryClient.clear();
});

test("useConnectAgent validates a retained agent while refreshing its grant projection", async () => {
  const cached = Object.freeze({ agentId: "agent-durable", grant: Object.freeze({ id: "0x01" }) });
  const fresh = Object.freeze({ agentId: "agent-durable", grant: Object.freeze({ id: "0x01" }) });
  const agent = Object.freeze({ id: "agent-durable" });
  let resolveRefresh;
  const refresh = new Promise((resolve) => { resolveRefresh = resolve; });
  let creates = 0;
  const config = createConfig({
    client: {
      _hasSession() { return true; },
      _resumeConnection() { return cached; },
      connection: { reconnect() { return refresh; } },
      agent: {
        async create(options) {
          creates += 1;
          assert.equal(options.connection, cached);
          return agent;
        },
      },
    },
  });
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  let snapshot;

  function Consumer() {
    snapshot = useConnectAgent({ config });
    return null;
  }

  let root;
  await act(async () => {
    root = create(createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(Consumer),
    ));
  });
  await waitFor(() => snapshot.connection === cached);
  assert.equal(creates, 1);

  await act(async () => resolveRefresh(fresh));
  await waitFor(() => snapshot.connection === fresh);
  assert.equal(snapshot.agent, agent);
  assert.equal(creates, 1);

  await act(async () => root.unmount());
  queryClient.clear();
});

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  throw new Error("condition was not met");
}
