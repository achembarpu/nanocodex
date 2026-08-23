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

test("the resolved default identity is canonical and stable across remounts", async () => {
  const createdThreadIds = [];
  const closed = [];
  const config = createAgentConfig({}, {
    async create(options) {
      createdThreadIds.push(options.threadId);
      return fakeAgent(`agent-${createdThreadIds.length}`, closed);
    },
    async prepare() {},
  });

  const omitted = config.subscribeAgent({}, () => {});
  await waitFor(() => config.getAgent().status === "success");
  const resolvedDefault = createdThreadIds[0];
  const empty = config.subscribeAgent({ threadId: "" }, () => {});
  const matching = config.subscribeAgent({ threadId: resolvedDefault }, () => {});
  await tick();

  assert.equal(typeof resolvedDefault, "string");
  assert.notEqual(resolvedDefault, "");
  assert.deepEqual(createdThreadIds, [resolvedDefault]);
  assert.equal(config.getAgent(), config.getAgent({ threadId: "" }));
  assert.equal(config.getAgent(), config.getAgent({ threadId: resolvedDefault }));

  omitted();
  empty();
  matching();
  await waitFor(() => closed.length === 1);

  const remounted = config.subscribeAgent({}, () => {});
  await waitFor(() => createdThreadIds.length === 2 && config.getAgent().status === "success");
  assert.deepEqual(createdThreadIds, [resolvedDefault, resolvedDefault]);

  remounted();
  await waitFor(() => closed.length === 2);
  await config.destroy();
});

test("disabled consumers stay cold without creating an Agent", async () => {
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
  assert.deepEqual(calls, []);
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
  await tick();
  const second = config.subscribeAgent({ enabled: false }, () => {});
  await tick();
  assert.equal(prepared.length, 0);
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

test("a live Worker failure replaces stale success with the original actionable error", async () => {
  const failures = [];
  const disposals = [];
  const shutdowns = [];
  const statuses = [];
  const config = createAgentConfig({}, {
    async create(_options, { onFailure }) {
      failures.push(onFailure);
      const id = failures.length - 1;
      return {
        dispose() { disposals.push(id); },
        session: {
          async shutdown() { shutdowns.push(id); },
        },
      };
    },
    async prepare() {},
  });
  const unsubscribe = config.subscribeAgent({}, () => statuses.push(config.getAgent().status));
  await waitFor(() => config.getAgent().status === "success");
  const original = new Error("provider websocket rejected the credential");

  failures[0](original);
  await waitFor(() => config.getAgent().status === "error");

  assert.equal(config.getAgent().data, undefined);
  assert.equal(config.getAgent().error, original);
  assert.deepEqual(statuses, ["pending", "success", "error"]);
  assert.deepEqual(disposals, [0]);
  assert.deepEqual(shutdowns, []);

  config.refetchAgent();
  await waitFor(() => failures.length === 2 && config.getAgent().status === "success");
  assert.deepEqual(disposals, [0]);
  assert.deepEqual(shutdowns, []);

  unsubscribe();
  await waitFor(() => shutdowns.length === 1);
  assert.deepEqual(shutdowns, [1]);
  await config.destroy();
});

test("a Worker failure before candidate publication becomes terminal", async () => {
  const failure = new Error("Worker failed during boot");
  const disposals = [];
  const shutdowns = [];
  const statuses = [];
  const config = createAgentConfig({ retry: 0 }, {
    async create(_options, { onFailure }) {
      onFailure(failure);
      return {
        dispose() { disposals.push("candidate"); },
        session: {
          async shutdown() { shutdowns.push("candidate"); },
        },
      };
    },
    async prepare() {},
  });
  const unsubscribe = config.subscribeAgent({}, () => statuses.push(config.getAgent().status));
  await waitFor(() => config.getAgent().status === "error");

  assert.equal(config.getAgent().data, undefined);
  assert.equal(config.getAgent().error, failure);
  assert.deepEqual(statuses, ["pending", "error"]);
  assert.deepEqual(disposals, ["candidate"]);
  assert.deepEqual(shutdowns, []);

  unsubscribe();
  await config.destroy();
});

test("a stale failed startup attempt cannot poison its healthy retry", async () => {
  const failures = [];
  const disposals = [];
  const shutdowns = [];
  const statuses = [];
  const replacement = {
    dispose() { disposals.push("replacement"); },
    session: {
      async shutdown() { shutdowns.push("replacement"); },
    },
  };
  let attempts = 0;
  const config = createAgentConfig({ retry: 1, retryDelay: () => 0 }, {
    async create(_options, { onFailure }) {
      failures.push(onFailure);
      attempts += 1;
      if (attempts === 1) throw new Error("first attempt failed");
      return replacement;
    },
    async prepare() {},
  });
  const unsubscribe = config.subscribeAgent({}, () => statuses.push(config.getAgent().status));
  await waitFor(() => config.getAgent().status === "success");

  failures[0](new Error("late first-attempt failure"));
  await tick();

  assert.equal(config.getAgent().status, "success");
  assert.equal(config.getAgent().data, replacement);
  assert.deepEqual(statuses, ["pending", "success"]);
  assert.deepEqual(disposals, []);

  unsubscribe();
  await waitFor(() => shutdowns.length === 1);
  assert.deepEqual(shutdowns, ["replacement"]);
  await config.destroy();
});

test("a stale Worker failure cannot poison an explicit replacement", async () => {
  const failures = [];
  const closed = [];
  const config = createAgentConfig({}, {
    async create(_options, { onFailure }) {
      const id = failures.length;
      failures.push(onFailure);
      return {
        dispose() {},
        session: {
          async shutdown() { closed.push(id); },
        },
      };
    },
    async prepare() {},
  });
  const unsubscribe = config.subscribeAgent({}, () => {});
  await waitFor(() => config.getAgent().status === "success");
  config.refetchAgent();
  await waitFor(() => failures.length === 2 && config.getAgent().status === "success");
  const replacement = config.getAgent().data;

  failures[0](new Error("late failure from retired Worker"));
  await tick();

  assert.equal(config.getAgent().status, "success");
  assert.equal(config.getAgent().data, replacement);
  unsubscribe();
  await waitFor(() => closed.length === 2);
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

test("refetch aborts a hung generation and starts its replacement immediately", { timeout: 2_000 }, async () => {
  const first = deferred();
  const closed = [];
  const createSignals = [];
  const prepareSignals = [];
  let attempts = 0;
  const config = createAgentConfig({}, {
    create(_options, { signal }) {
      createSignals.push(signal);
      attempts += 1;
      if (attempts === 1) return first.promise;
      return Promise.resolve(fakeAgent("replacement", closed));
    },
    prepare(_options, { signal }) {
      prepareSignals.push(signal);
      return new Promise(() => {});
    },
  });
  const unsubscribe = config.subscribeAgent({}, () => {});
  await waitFor(() => attempts === 1);

  config.refetchAgent();
  assert.equal(createSignals[0].aborted, true);
  assert.equal(prepareSignals[0], createSignals[0]);
  await waitFor(() => config.getAgent().status === "success");

  assert.equal(attempts, 2);
  assert.equal(prepareSignals[1], createSignals[1]);
  assert.equal(createSignals[1].aborted, false);
  first.resolve(fakeAgent("stale", closed));
  await waitFor(() => closed.includes("stale"));
  assert.equal(config.getAgent().data.session !== undefined, true);

  unsubscribe();
  await waitFor(() => closed.includes("replacement"));
  assert.equal(createSignals[1].aborted, true);
  await config.destroy();
});

test("release and destroy promptly abort create calls that never resolve", { timeout: 2_000 }, async (context) => {
  for (const lifecycle of ["release", "destroy"]) {
    await context.test(lifecycle, async () => {
      const started = deferred();
      let signal;
      const config = createAgentConfig({}, {
        create(_options, workerOptions) {
          signal = workerOptions.signal;
          started.resolve();
          return new Promise(() => {});
        },
        async prepare() {},
      });
      const unsubscribe = config.subscribeAgent({}, () => {});
      await started.promise;

      if (lifecycle === "release") {
        unsubscribe();
        assert.equal(signal.aborted, true);
        await waitFor(() => config.getAgent().status === "idle");
        await config.destroy();
      } else {
        await config.destroy();
        assert.equal(signal.aborted, true);
        unsubscribe();
      }
    });
  }
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
    async create(_options, { onFailure }) {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error(`transient ${attempts}`);
        onFailure(error);
        throw error;
      }
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

test("a refetch aborts retry backoff and starts the replacement", { timeout: 2_000 }, async () => {
  const backoffStarted = deferred();
  const closed = [];
  const signals = [];
  let attempts = 0;
  const config = createAgentConfig({
    retry: 1,
    retryDelay() {
      backoffStarted.resolve();
      return 60_000;
    },
  }, {
    async create(_options, { signal }) {
      signals.push(signal);
      attempts += 1;
      if (attempts === 1) throw new Error("transient");
      return fakeAgent("replacement", closed);
    },
    async prepare() {},
  });
  const unsubscribe = config.subscribeAgent({}, () => {});
  await backoffStarted.promise;
  config.refetchAgent();
  await waitFor(() => config.getAgent().status === "success");

  assert.equal(attempts, 2);
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
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

test("destroy notifies duplicate callback subscriptions exactly once each", async () => {
  const closed = [];
  const config = createAgentConfig({}, {
    async create() { return fakeAgent("shared", closed); },
    async prepare() {},
  });
  const statuses = [];
  const listener = () => statuses.push(config.getAgent().status);
  const first = config.subscribeAgent({}, listener);
  const second = config.subscribeAgent({}, listener);
  await waitFor(() => config.getAgent().status === "success");
  statuses.length = 0;

  await config.destroy();

  assert.deepEqual(statuses, ["idle", "idle"]);
  assert.deepEqual(closed, ["shared"]);
  first();
  first();
  second();
  second();
  assert.deepEqual(statuses, ["idle", "idle"]);
});

test("duplicate callback subscriptions unsubscribe independently", async () => {
  const creation = deferred();
  const closed = [];
  const config = createAgentConfig({}, {
    create() { return creation.promise; },
    async prepare() {},
  });
  const statuses = [];
  const listener = () => statuses.push(config.getAgent().status);
  const first = config.subscribeAgent({}, listener);
  const second = config.subscribeAgent({}, listener);

  first();
  first();
  statuses.length = 0;
  creation.resolve(fakeAgent("remaining", closed));
  await waitFor(() => config.getAgent().status === "success");

  assert.deepEqual(statuses, ["success"]);
  second();
  second();
  await waitFor(() => closed.length === 1);
  assert.deepEqual(closed, ["remaining"]);
  await config.destroy();
});

test("concurrent destroy calls join the same Agent shutdown", async () => {
  const shutdown = deferred();
  let notifications = 0;
  let shutdowns = 0;
  const config = createAgentConfig({}, {
    async create() {
      return {
        session: {
          shutdown() {
            shutdowns += 1;
            return shutdown.promise;
          },
        },
      };
    },
    async prepare() {},
  });
  const unsubscribe = config.subscribeAgent({}, () => { notifications += 1; });
  await waitFor(() => config.getAgent().status === "success");
  notifications = 0;

  const first = config.destroy();
  const second = config.destroy();

  assert.equal(first, second);
  assert.equal(notifications, 1);
  let settled = false;
  void second.then(() => { settled = true; });
  await tick();
  assert.equal(shutdowns, 1);
  assert.equal(settled, false);

  shutdown.resolve();
  await first;
  assert.equal(settled, true);
  unsubscribe();
  unsubscribe();
  assert.equal(notifications, 1);
});

test("destroy from a pending notification prevents preparation and creation", async () => {
  const calls = [];
  const config = createAgentConfig({}, {
    async create() { calls.push("create"); },
    async prepare() { calls.push("prepare"); },
  });
  const statuses = [];
  let destruction;
  const unsubscribe = config.subscribeAgent({}, () => {
    const status = config.getAgent().status;
    statuses.push(status);
    if (status === "pending") destruction = config.destroy();
  });

  await destruction;
  await tick();

  assert.deepEqual(statuses, ["pending", "idle"]);
  assert.deepEqual(calls, []);
  unsubscribe();
  unsubscribe();
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
