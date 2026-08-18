import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Actions,
  createMemoryDurabilityStore,
  createSqliteDurabilityStore,
} from "../index.mjs";
import {
  activateHost,
  bindHostSession,
  createAgentClient,
  defineRuntime,
  releaseHostSession,
} from "../internal.mjs";
import {
  own as ownDurabilityHost,
  release as releaseDurabilityHost,
  retain as retainDurabilityHost,
} from "../runtime/durability.mjs";

test("the memory durability store carries opaque Rust batches across host steps", () => {
  const store = createMemoryDurabilityStore("journal-1");
  assert.deepEqual(store.load("journal-1"), { revision: "0", batches: [] });
  assert.deepEqual(store.append("journal-1", {
    expectedRevision: "0",
    payload: "{\"entry\":1}",
  }), { status: "appended", revision: "1" });
  assert.deepEqual(store.append("journal-1", {
    expectedRevision: "0",
    payload: "stale",
  }), { status: "conflict", actualRevision: "1" });
  assert.deepEqual(store.snapshot(), {
    revision: "1",
    batches: [{ revision: "1", payload: "{\"entry\":1}" }],
  });
  assert.throws(() => store.load("other"), /unknown durability journal/);
});

test("the SQLite durability store owns revision validation and compare-and-append", () => {
  const revisions = new Map();
  const batches = [];
  const query = (sql, args) => {
    const [journalId, revision, payload] = args;
    if (sql.startsWith("SELECT revision FROM durability_journals")) {
      const stored = revisions.get(journalId);
      return stored === undefined ? [] : [{ revision: stored }];
    }
    if (sql.startsWith("SELECT revision, payload FROM durability_batches")) {
      return batches.filter((batch) => batch.journalId === journalId);
    }
    if (sql.startsWith("INSERT INTO durability_journals")) {
      revisions.set(journalId, revision);
      return [];
    }
    if (sql.startsWith("INSERT INTO durability_batches")) {
      batches.push({ journalId, revision, payload });
      return [];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  const store = createSqliteDurabilityStore({
    transaction: (callback) => callback(query),
  });

  assert.deepEqual(store.load("journal-1"), { revision: "0", batches: [] });
  assert.deepEqual(store.append("journal-1", {
    expectedRevision: "0",
    payload: "opaque",
  }), { status: "appended", revision: "1" });
  assert.deepEqual(store.append("journal-1", {
    expectedRevision: "0",
    payload: "stale",
  }), { status: "conflict", actualRevision: "1" });
  assert.deepEqual(store.load("journal-1"), {
    revision: "1",
    batches: [{ revision: "1", payload: "opaque" }],
  });
});

test("the headless client exposes matching direct and standalone actions", async () => {
  const events = new Set();
  const runtime = defineRuntime({
    create: () => rawAgent("session-1"),
    subscribe(listener) {
      events.add(listener);
      return () => events.delete(listener);
    },
    decorate: (agent) => agent.extend(Actions.agentActions()),
  });
  const agent = await createAgentClient(runtime);

  const firstTurn = agent.turn.prompt({ input: "first" });
  const first = await firstTurn.result();
  assert.equal(first.finalMessage, "session-1:first");
  assert.deepEqual(Object.getOwnPropertySymbols(agent), []);
  assert.deepEqual(Object.getOwnPropertySymbols(firstTurn), []);
  assert.deepEqual(Object.getOwnPropertySymbols(first), []);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.usage), true);
  assert.equal(Object.isFrozen(first.snapshot), true);
  assert.strictEqual(Actions.turn.getUsage(first), first.usage);
  assert.strictEqual(Actions.turn.getSnapshot(first), first.snapshot);
  const secondTurn = Actions.turn.prompt(agent, { input: "second" });
  const second = await Actions.turn.getResult(secondTurn);
  assert.equal(second.finalMessage, "session-1:second");
  const durable = await agent.turn.prompt({ id: "request-7", input: "durable" }).result();
  assert.equal(durable.finalMessage, "session-1:request-7:durable");

  const seen = [];
  const watch = agent.events.watch();
  const unwatch = watch.onEvent((event) => seen.push(event.type));
  for (const listener of events) {
    listener({ type: "ignored", request_id: "another-session" });
    listener({ type: "accepted", request_id: "session-1" });
  }
  unwatch();
  watch.off();
  assert.deepEqual(seen, ["accepted"]);

  const iterable = Actions.events.watch(agent);
  const iterator = iterable[Symbol.asyncIterator]();
  const next = iterator.next();
  for (const listener of events) listener({ type: "streamed", request_id: "session-1" });
  assert.deepEqual(await next, {
    done: false,
    value: { type: "streamed", request_id: "session-1" },
  });
  await iterator.return();
  iterable.off();

  const branch = await agent.session.fork({ at: first });
  assert.equal(branch.sessionId, "session-1-fork");
  assert.equal(
    (await branch.turn.prompt({ input: "branch" }).result()).finalMessage,
    "session-1-fork:branch",
  );

  const fresh = await agent.session.spawn();
  assert.equal(fresh.sessionId, "session-1-spawn");

  await agent.session.compact();
  await Actions.session.compact(agent);

  const extended = agent.extend((client) => ({ inspect: { session: () => client.sessionId } }));
  assert.equal(extended.inspect.session(), "session-1");
  branch.dispose();
  fresh.dispose();
  agent.dispose();
});

test("the WASM host bridge preserves typed decimal durability revisions", async () => {
  const batches = [];
  const host = {
    connect() {},
    durability: {
      load: () => ({ revision: String(batches.length), batches }),
      append(_journalId, { expectedRevision, payload }) {
        if (expectedRevision !== String(batches.length)) {
          return { status: "conflict", actualRevision: String(batches.length) };
        }
        const revision = String(batches.length + 1);
        batches.push({ revision, payload });
        return { status: "appended", revision };
      },
    },
  };
  activateHost(host);
  ownDurabilityHost(host, host.durability, "journal-1");
  retainDurabilityHost(host, "journal-1");
  retainDurabilityHost(host, "journal-1");
  try {
    assert.deepEqual(
      JSON.parse(await globalThis.nanocodexHost.durabilityLoad("journal-1")),
      { revision: "0", batches: [] },
    );
    assert.deepEqual(
      JSON.parse(await globalThis.nanocodexHost.durabilityAppend(
        "journal-1",
        "0",
        "opaque-rust-batch",
      )),
      { status: "appended", revision: "1" },
    );
    assert.deepEqual(
      JSON.parse(await globalThis.nanocodexHost.durabilityAppend(
        "journal-1",
        "0",
        "stale",
      )),
      { status: "conflict", actual_revision: "1" },
    );
    releaseDurabilityHost(host, "journal-1");
    assert.equal(
      JSON.parse(await globalThis.nanocodexHost.durabilityLoad("journal-1")).revision,
      "1",
      "releasing a child host reference must preserve its parent's journal binding",
    );
  } finally {
    releaseDurabilityHost(host, "journal-1");
  }
  await assert.rejects(
    globalThis.nanocodexHost.durabilityLoad("journal-1"),
    /no Nanocodex host owns durability journal/,
  );
});

test("concurrent graceful shutdown defers exactly-once release until the join completes", async () => {
  let shutdowns = 0;
  let releases = 0;
  let disposals = 0;
  let resolveShutdown;
  const shutdownGate = new Promise((resolve) => { resolveShutdown = resolve; });
  const subscriptions = new Set();
  const raw = rawAgent("session-shutdown");
  raw.shutdown = async () => {
    shutdowns += 1;
    await shutdownGate;
  };
  const runtime = defineRuntime({
    create: () => raw,
    subscribe(listener) {
      subscriptions.add(listener);
      return () => subscriptions.delete(listener);
    },
    release() {
      releases += 1;
    },
    dispose() {
      disposals += 1;
    },
    decorate: (agent) => agent.extend(Actions.agentActions()),
  });
  const agent = await createAgentClient(runtime);
  const extended = agent.extend(() => ({ inspect: true }));
  const watcher = agent.events.watch();
  const pendingEvent = watcher[Symbol.asyncIterator]().next();

  const first = agent.session.shutdown();
  const second = Actions.session.shutdown(extended);
  const joined = Promise.all([first, second]);
  void joined.catch(() => {});
  agent.dispose();
  await Promise.resolve();

  assert.equal(shutdowns, 1);
  assert.equal(releases, 0);
  assert.equal(disposals, 0);
  assert.equal(subscriptions.size, 1);
  assert.throws(
    () => extended.turn.prompt({ input: "too late" }),
    /agent has been disposed/,
  );

  resolveShutdown();
  await joined;
  assert.deepEqual(await pendingEvent, { done: true, value: undefined });
  assert.equal(subscriptions.size, 0);
  assert.equal(releases, 1);
  assert.equal(disposals, 1);

  await agent.session.shutdown();
  agent.dispose();
  assert.equal(shutdowns, 1);
  assert.equal(releases, 1);
  assert.equal(disposals, 1);
});

test("a failing release hook still frees the raw agent exactly once", async () => {
  const releaseError = new Error("release failed");
  let shutdowns = 0;
  let releases = 0;
  let disposals = 0;
  const raw = rawAgent("session-release-failure");
  raw.shutdown = async () => {
    shutdowns += 1;
  };
  const runtime = defineRuntime({
    create: () => raw,
    release() {
      releases += 1;
      throw releaseError;
    },
    dispose() {
      disposals += 1;
    },
    decorate: (agent) => agent.extend(Actions.agentActions()),
  });
  const agent = await createAgentClient(runtime);

  await assert.rejects(agent.session.shutdown(), releaseError);
  agent.dispose();

  assert.equal(shutdowns, 1);
  assert.equal(releases, 1);
  assert.equal(disposals, 1);
});

test("shutdown preserves driver and cleanup failures in causal order", async () => {
  const shutdownError = new Error("driver shutdown failed");
  const releaseError = new Error("release failed");
  const disposeError = new Error("dispose failed");
  const raw = rawAgent("session-multiple-shutdown-errors");
  raw.shutdown = async () => {
    throw shutdownError;
  };
  const runtime = defineRuntime({
    create: () => raw,
    release() {
      throw releaseError;
    },
    dispose() {
      throw disposeError;
    },
    decorate: (agent) => agent.extend(Actions.agentActions()),
  });
  const agent = await createAgentClient(runtime);

  await assert.rejects(
    agent.session.shutdown(),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.deepEqual(error.errors, [shutdownError, releaseError, disposeError]);
      return true;
    },
  );
});

test("a lone driver shutdown failure retains its exact identity", async () => {
  const shutdownError = new Error("driver shutdown failed");
  let releases = 0;
  let disposals = 0;
  const raw = rawAgent("session-driver-shutdown-error");
  raw.shutdown = async () => {
    throw shutdownError;
  };
  const runtime = defineRuntime({
    create: () => raw,
    release() {
      releases += 1;
    },
    dispose() {
      disposals += 1;
    },
    decorate: (agent) => agent.extend(Actions.agentActions()),
  });
  const agent = await createAgentClient(runtime);

  await assert.rejects(agent.session.shutdown(), (error) => error === shutdownError);
  assert.equal(releases, 1);
  assert.equal(disposals, 1);
});

test("the host bridge keeps retry timing and handshake detail session-scoped", async () => {
  const sleeps = [];
  const left = {
    connect(_endpoint, _apiKey, sessionId, metadata) {
      const error = new Error(`rejected ${sessionId}`);
      error.status = 429;
      error.body = "slow down";
      error.retryAfter = 3;
      assert.deepEqual(metadata, {
        accountId: "acct-left",
        fedramp: true,
        turnState: "turn-left",
      });
      throw error;
    },
    sleep(milliseconds) {
      sleeps.push(["left", milliseconds]);
      return Promise.resolve();
    },
  };
  const right = {
    connect() {
      throw new Error("unused");
    },
    sleep(milliseconds) {
      sleeps.push(["right", milliseconds]);
      return Promise.resolve();
    },
  };

  activateHost(left);
  bindHostSession(left, "session-left");
  bindHostSession(right, "session-right");
  await globalThis.nanocodexHost.sleep("session-left", 7);
  await globalThis.nanocodexHost.sleep("session-right", 11);
  assert.deepEqual(sleeps, [["left", 7], ["right", 11]]);

  await assert.rejects(
    globalThis.nanocodexHost.connect(
      "wss://api.test",
      "secret",
      "acct-left",
      true,
      "session-left",
      "turn-left",
    ),
    (error) => {
      assert.deepEqual(JSON.parse(error), {
        kind: "handshake_rejected",
        status: 429,
        body: "slow down",
        retry_after: 3,
      });
      return true;
    },
  );

  releaseHostSession(left, "session-left");
  releaseHostSession(right, "session-right");
});

test("event iterators release subscriptions and fail closed before buffering without bound", async () => {
  const subscriptions = new Set();
  const runtime = defineRuntime({
    create: () => rawAgent("session-events"),
    subscribe(listener) {
      subscriptions.add(listener);
      return () => subscriptions.delete(listener);
    },
    decorate: (agent) => agent.extend(Actions.agentActions()),
  });
  const agent = await createAgentClient(runtime);
  const watch = agent.events.watch();
  const iterator = watch[Symbol.asyncIterator]();

  assert.equal(subscriptions.size, 1);
  for (let seq = 1; seq <= 4_097; seq += 1) {
    for (const listener of subscriptions) {
      listener({ type: "api.event", request_id: agent.sessionId, seq });
    }
  }
  for (let seq = 1; seq <= 4_096; seq += 1) {
    assert.equal((await iterator.next()).value.seq, seq);
  }
  await assert.rejects(iterator.next(), /event iterator exceeded its private buffer/);
  assert.equal(subscriptions.size, 0);

  const restarted = watch[Symbol.asyncIterator]();
  assert.equal(subscriptions.size, 1);
  const firstPending = restarted.next();
  const secondPending = restarted.next();
  for (const listener of subscriptions) {
    listener({ type: "api.event", request_id: agent.sessionId, seq: 4_098 });
    listener({ type: "api.event", request_id: agent.sessionId, seq: 4_099 });
  }
  assert.deepEqual(
    (await Promise.all([firstPending, secondPending])).map(({ value }) => value.seq),
    [4_098, 4_099],
  );
  await restarted.return();
  assert.equal(subscriptions.size, 0);

  watch.off();
  agent.dispose();
});

test("a failing event listener is reported without interrupting other observers", async () => {
  const subscriptions = new Set();
  const reported = [];
  const previousReportError = globalThis.reportError;
  globalThis.reportError = (error) => reported.push(error);
  try {
    const runtime = defineRuntime({
      create: () => rawAgent("session-observers"),
      subscribe(listener) {
        subscriptions.add(listener);
        return () => subscriptions.delete(listener);
      },
      decorate: (agent) => agent.extend(Actions.agentActions()),
    });
    const agent = await createAgentClient(runtime);
    const watch = agent.events.watch();
    watch.onEvent(() => { throw new Error("observer failed"); });
    const seen = [];
    watch.onEvent((event) => seen.push(event.seq));
    const iterator = watch[Symbol.asyncIterator]();
    const next = iterator.next();

    for (const listener of subscriptions) {
      listener({ type: "api.event", request_id: agent.sessionId, seq: 1 });
    }
    assert.deepEqual(seen, [1]);
    assert.equal((await next).value.seq, 1);
    assert.match(reported[0]?.message, /observer failed/);

    watch.off();
    agent.dispose();
  } finally {
    if (previousReportError === undefined) delete globalThis.reportError;
    else globalThis.reportError = previousReportError;
  }
});

function rawAgent(sessionId) {
  return {
    sessionId,
    prompt(input, id) {
      return rawTurn(id === undefined
        ? `${sessionId}:${input}`
        : `${sessionId}:${id}:${input}`);
    },
    promptContent(input, id) {
      const text = JSON.parse(input)[0].text;
      return rawTurn(id === undefined ? `${sessionId}:${text}` : `${sessionId}:${id}:${text}`);
    },
    async fork() {
      return rawAgent(`${sessionId}-fork`);
    },
    async forkFrom() {
      return rawAgent(`${sessionId}-fork`);
    },
    async spawn() {
      return rawAgent(`${sessionId}-spawn`);
    },
    async compact() {},
    free() {},
  };
}

function rawTurn(value) {
  return {
    async result() {
      return {
        finalMessage: value,
        snapshot() {
          return JSON.stringify({
            version: 1,
            model: "gpt-5.6-sol",
            lineage_id: "test-lineage",
            prompt_cache_key: "test-cache-key",
            workspace: ".",
            canonical_context: {},
            history: [],
          });
        },
        usage() {
          return JSON.stringify({
            input_tokens: 0,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: 0,
            estimated_cost: null,
            cost_status: "usage_not_reported",
          });
        },
        free() {},
      };
    },
    async steer() {},
    async steerContent() {},
    async cancel() {},
    free() {},
  };
}
