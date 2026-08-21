import assert from "node:assert/strict";
import test from "node:test";

import { createAgentConfig } from "../browser/config.mjs";

test("disabled consumers prewarm without creating an Agent", async () => {
  const calls = [];
  const config = createAgentConfig({}, {
    async create(options) { calls.push(["create", options]); },
    async prepare(options) { calls.push(["prepare", options]); },
  });
  const unsubscribe = config.subscribeAgent({ enabled: false, threadId: "demo" }, () => {});
  await tick();

  assert.deepEqual(config.getAgent({ enabled: false, threadId: "demo" }), {
    data: undefined,
    error: undefined,
    status: "idle",
  });
  assert.deepEqual(calls, [["prepare", { threadId: "demo" }]]);
  unsubscribe();
  await config.destroy();
});

test("the config owns one Agent shared by every subscriber", async () => {
  const created = [];
  const closed = [];
  const config = createAgentConfig({ agent: { thinking: "high" } }, {
    async create(options) {
      const agent = fakeAgent(created.length, closed);
      created.push({ agent, options });
      return agent;
    },
    async prepare() {},
  });
  const changes = [];
  const first = config.subscribeAgent({ threadId: "thread" }, () => {
    changes.push(config.getAgent({ threadId: "thread" }).status);
  });
  const second = config.subscribeAgent({ threadId: "thread" }, () => {});
  await waitFor(() => config.getAgent({ threadId: "thread" }).status === "success");

  const snapshot = config.getAgent({ threadId: "thread" });
  assert.equal(snapshot.data, created[0].agent);
  assert.deepEqual(created[0].options, { thinking: "high", threadId: "thread" });
  assert.equal(created.length, 1);
  assert.deepEqual(changes, ["pending", "success"]);

  first();
  await tick();
  assert.deepEqual(closed, []);
  second();
  await waitFor(() => closed.length === 1);
  assert.deepEqual(closed, [0]);
  await config.destroy();
});

test("refetch serializes shutdown before replacement", async () => {
  const transitions = [];
  const config = createAgentConfig({}, {
    async create() {
      const id = transitions.filter((value) => value.startsWith("create:")).length;
      transitions.push(`create:${id}`);
      return {
        session: {
          async shutdown() { transitions.push(`close:${id}`); },
        },
      };
    },
    async prepare() {},
  });
  const unsubscribe = config.subscribeAgent({}, () => {});
  await waitFor(() => config.getAgent().status === "success");
  config.refetchAgent();
  await waitFor(() => config.getAgent().status === "success" && transitions.includes("create:1"));

  assert.deepEqual(transitions.slice(0, 3), ["create:0", "close:0", "create:1"]);
  unsubscribe();
  await waitFor(() => transitions.includes("close:1"));
  await config.destroy();
});

test("an Agent that resolves after unsubscribe is immediately shut down", async () => {
  const creation = deferred();
  const started = deferred();
  const closed = [];
  const config = createAgentConfig({}, {
    create() {
      started.resolve();
      return creation.promise;
    },
    async prepare() {},
  });
  const unsubscribe = config.subscribeAgent({}, () => {});
  await started.promise;
  unsubscribe();
  creation.resolve(fakeAgent("stale", closed));
  await waitFor(() => closed.length === 1);

  assert.deepEqual(closed, ["stale"]);
  assert.equal(config.getAgent().status, "idle");
  await config.destroy();
});

test("startup retries stay inside config and publish only the exhausted failure", async () => {
  let attempts = 0;
  const config = createAgentConfig({ retry: 2, retryDelay: () => 0 }, {
    async create() {
      attempts += 1;
      if (attempts < 3) throw new Error(`transient ${attempts}`);
      return fakeAgent("ready", []);
    },
    async prepare() {},
  });
  const statuses = [];
  const unsubscribe = config.subscribeAgent({}, () => statuses.push(config.getAgent().status));
  await waitFor(() => config.getAgent().status === "success");

  assert.equal(attempts, 3);
  assert.deepEqual(statuses, ["pending", "success"]);
  unsubscribe();
  await config.destroy();
});

test("startup publishes an error after the configured retry budget", async () => {
  let attempts = 0;
  const config = createAgentConfig({ retry: 1, retryDelay: () => 0 }, {
    async create() {
      attempts += 1;
      throw new Error("unavailable");
    },
    async prepare() {},
  });
  const unsubscribe = config.subscribeAgent({}, () => {});
  await waitFor(() => config.getAgent().status === "error");

  assert.equal(attempts, 2);
  assert.match(config.getAgent().error.message, /unavailable/);
  unsubscribe();
  await config.destroy();
});

function fakeAgent(id, closed) {
  return {
    session: {
      async shutdown() { closed.push(id); },
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
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
