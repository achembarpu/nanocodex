import assert from "node:assert/strict";
import test from "node:test";

import { createAgentConfig } from "../browser/config.mjs";

test("snapshot reads and refetch stay pure until a subscriber creates the entry", async () => {
  const calls = [];
  const closed = [];
  const config = createAgentConfig({}, {
    async create(options) {
      calls.push(["create", options]);
      return fakeAgent("agent", closed);
    },
    async prepare(options) { calls.push(["prepare", options]); },
  });

  const first = config.getAgent({ threadId: "render-only" });
  const second = config.getAgent({ threadId: "render-only" });
  config.refetchAgent({ threadId: "render-only" });
  await tick();

  assert.equal(first, second);
  assert.equal(first.status, "idle");
  assert.deepEqual(calls, []);

  const unsubscribe = config.subscribeAgent({ threadId: "render-only" }, () => {});
  await waitFor(() => config.getAgent({ threadId: "render-only" }).status === "success");
  assert.deepEqual(calls.map(([kind]) => kind), ["prepare", "create"]);

  unsubscribe();
  await waitFor(() => closed.length === 1);
  await config.destroy();
});

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

test("preparation deduplicates and shares the exact stable descriptor with creation", async () => {
  const prepared = [];
  const created = [];
  const closed = [];
  const config = createAgentConfig({
    agent: { thinking: "high" },
    origin: "https://example.test",
  }, {
    async create(options) {
      created.push(options);
      return fakeAgent("shared", closed);
    },
    async prepare(options) { prepared.push(options); },
  });

  const first = config.subscribeAgent({ enabled: false }, () => {});
  await waitFor(() => prepared.length === 1);
  const second = config.subscribeAgent({ enabled: false }, () => {});
  await tick();
  assert.equal(prepared.length, 1);
  assert.equal(created.length, 0);

  const third = config.subscribeAgent({}, () => {});
  await waitFor(() => config.getAgent().status === "success");
  const fourth = config.subscribeAgent({}, () => {});
  await tick();

  assert.equal(prepared.length, 1);
  assert.equal(created.length, 1);
  assert.equal(prepared[0], created[0]);
  assert.equal(Object.isFrozen(created[0]), true);
  assert.equal(created[0].thinking, "high");
  assert.equal(created[0].origin, "https://example.test");
  assert.equal(typeof created[0].threadId, "string");
  assert.notEqual(created[0].threadId, "");

  first();
  second();
  third();
  fourth();
  await waitFor(() => closed.length === 1);
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

test("retry policy failures publish a terminal error", async (context) => {
  const thrown = new Error("retry policy failed");
  const cases = [
    {
      name: "throwing callback",
      retryDelay() { throw thrown; },
      verify(error) { assert.equal(error, thrown); },
    },
    {
      name: "invalid callback result",
      retryDelay() { return Number.POSITIVE_INFINITY; },
      verify(error) { assert.match(error.message, /non-negative finite number/); },
    },
  ];

  for (const current of cases) {
    await context.test(current.name, async () => {
      let attempts = 0;
      const statuses = [];
      const config = createAgentConfig({ retry: 1, retryDelay: current.retryDelay }, {
        async create() {
          attempts += 1;
          throw new Error("startup failed");
        },
        async prepare() {},
      });
      const unsubscribe = config.subscribeAgent({}, () => statuses.push(config.getAgent().status));
      await waitFor(() => config.getAgent().status === "error");

      assert.equal(attempts, 1);
      assert.deepEqual(statuses, ["pending", "error"]);
      current.verify(config.getAgent().error);

      unsubscribe();
      await config.destroy();
    });
  }
});

test("a refetch during retry backoff suppresses the stale generation", async () => {
  const backoffStarted = deferred();
  const closed = [];
  let attempts = 0;
  const config = createAgentConfig({
    retry: 1,
    retryDelay() {
      backoffStarted.resolve();
      return 20;
    },
  }, {
    async create() {
      attempts += 1;
      if (attempts === 1) throw new Error("transient");
      return fakeAgent("replacement", closed);
    },
    async prepare() {},
  });
  const unsubscribe = config.subscribeAgent({}, () => {});
  await backoffStarted.promise;
  config.refetchAgent();
  await sleep(30);
  await waitFor(() => config.getAgent().status === "success");

  assert.equal(attempts, 2);
  unsubscribe();
  await waitFor(() => closed.length === 1);
  await config.destroy();
});

test("the last unsubscribe during retry backoff prevents another creation", async () => {
  const backoffStarted = deferred();
  let attempts = 0;
  const config = createAgentConfig({
    retry: 1,
    retryDelay() {
      backoffStarted.resolve();
      return 20;
    },
  }, {
    async create() {
      attempts += 1;
      throw new Error("transient");
    },
    async prepare() {},
  });
  const unsubscribe = config.subscribeAgent({}, () => {});
  await backoffStarted.promise;
  unsubscribe();
  await sleep(30);
  await waitFor(() => config.getAgent().status === "idle");

  assert.equal(attempts, 1);
  await config.destroy();
});

test("destroy during retry backoff prevents another creation", async () => {
  const backoffStarted = deferred();
  let attempts = 0;
  const config = createAgentConfig({
    retry: 1,
    retryDelay() {
      backoffStarted.resolve();
      return 20;
    },
  }, {
    async create() {
      attempts += 1;
      throw new Error("transient");
    },
    async prepare() {},
  });
  const unsubscribe = config.subscribeAgent({}, () => {});
  await backoffStarted.promise;
  await config.destroy();

  assert.equal(attempts, 1);
  unsubscribe();
  unsubscribe();
});

test("destroy publishes idle once and makes outstanding unsubscribes harmless", async () => {
  const closed = [];
  const config = createAgentConfig({}, {
    async create() { return fakeAgent("active", closed); },
    async prepare() {},
  });
  const firstStatuses = [];
  const secondStatuses = [];
  let first;
  first = config.subscribeAgent({}, () => {
    const status = config.getAgent().status;
    firstStatuses.push(status);
    if (status === "idle") first();
  });
  const second = config.subscribeAgent({}, () => secondStatuses.push(config.getAgent().status));
  await waitFor(() => config.getAgent().status === "success");
  firstStatuses.length = 0;
  secondStatuses.length = 0;

  await config.destroy();

  assert.deepEqual(firstStatuses, ["idle"]);
  assert.deepEqual(secondStatuses, ["idle"]);
  assert.equal(config.getAgent().status, "idle");
  assert.deepEqual(closed, ["active"]);

  first();
  second();
  second();
  await config.destroy();
  assert.deepEqual(firstStatuses, ["idle"]);
  assert.deepEqual(secondStatuses, ["idle"]);
  assert.deepEqual(closed, ["active"]);
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

function sleep(duration) {
  return new Promise((resolve) => setTimeout(resolve, duration));
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.fail("condition was not reached");
}
