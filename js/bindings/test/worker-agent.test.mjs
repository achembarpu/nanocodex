import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createWorkerAgent,
  installWorkerAgentRuntime,
  prepareWorkerAgent,
  WORKER_EVENT_BATCH_MAX_BYTES,
  WORKER_EVENT_BATCH_MAX_EVENTS,
} from "../browser/WorkerAgent.mjs";
import * as Transport from "../browser/Transport.mjs";

test("Worker Agent preserves synchronous prompt handles, independent results, and ordered events", async () => {
  const fixture = createFixture();
  const worker = new LoopbackWorker(fixture.createAgent);
  const agent = await createWorkerAgent({
    sessionId: "root",
    harness: false,
    transport: Transport.openAi({ apiKey: "test-key" }),
  }, { worker });
  const events = [];
  const watch = agent.events.watch();
  watch.onEvent((event) => events.push(event.seq));
  const iterator = watch[Symbol.asyncIterator]();

  const turn = agent.turn.prompt({ input: "ship", id: "operation-1" });
  assert.equal(typeof turn.result, "function");
  const pending = turn.result();
  await turn.steer({ input: "carefully" });
  fixture.emit("root", 1);
  fixture.emit("root", 2);
  await tick();
  assert.deepEqual(events, [1, 2]);
  assert.equal((await iterator.next()).value.seq, 1);
  assert.equal((await iterator.next()).value.seq, 2);
  assert.deepEqual(fixture.log.slice(0, 2), [
    ["prompt", "root", "ship", "operation-1"],
    ["steer", "root", "carefully"],
  ]);

  fixture.complete("root", "done");
  const result = await pending;
  assert.equal(result.finalMessage, "done");
  assert.equal(result.snapshot.workspace, "/workspace/root");
  assert.equal(result.usage.total_tokens, 3);
  turn.dispose();
  watch.off();
  agent.dispose();
  assert.equal(worker.terminated, 1);
});

test("Worker event forwarding follows first/last demand with filtering, order, and immutable fan-out", async () => {
  const fixture = createFixture();
  const worker = new LoopbackWorker(fixture.createAgent);
  const root = await createWorkerAgent({ sessionId: "root", harness: false }, { worker });
  const child = await root.session.spawn();

  fixture.emit("root", 0);
  await tick();
  assert.equal(fixture.watcherStats.created, 0);
  assert.equal(worker.outgoing.some((message) => message.type === "event.batch"), false);

  const rootEvents = [];
  const allEvents = [];
  const childEvents = [];
  const rootWatch = root.events.watch();
  rootWatch.onEvent((event) => {
    assert.equal(Object.isFrozen(event), true);
    assert.equal(Object.isFrozen(event.payload), true);
    assert.equal(Object.isFrozen(event.payload.nested), true);
    assert.throws(() => { event.payload.nested.value = "changed"; }, TypeError);
  });
  rootWatch.onEvent((event) => rootEvents.push([event.seq, event.payload.nested.value]));
  const allWatch = root.events.watch({ includeAllSessions: true });
  allWatch.onEvent((event) => allEvents.push([event.request_id, event.seq]));
  const childWatch = child.events.watch();
  childWatch.onEvent((event) => childEvents.push(event.seq));
  await tick();

  assert.equal(fixture.watcherStats.created, 1);
  assert.equal(fixture.watcherStats.active, 1);
  assert.deepEqual(fixture.watcherStats.options, [{ includeAllSessions: true }]);
  fixture.emit("root", 1, { nested: { value: "root" } });
  fixture.emit("root-spawn", 2, { nested: { value: "child" } });
  fixture.emit("root", 3, { nested: { value: "root-again" } });
  await tick();

  assert.deepEqual(rootEvents, [[1, "root"], [3, "root-again"]]);
  assert.deepEqual(allEvents, [["root", 1], ["root-spawn", 2], ["root", 3]]);
  assert.deepEqual(childEvents, [2]);

  rootWatch.off();
  allWatch.off();
  await tick();
  assert.equal(fixture.watcherStats.active, 1);
  childWatch.off();
  await tick();
  assert.equal(fixture.watcherStats.active, 0);
  assert.equal(fixture.watcherStats.released, 1);
  const forwardedMessages = worker.outgoing.filter((message) => message.type.startsWith("event.")).length;
  fixture.emit("root", 4, { nested: { value: "unsubscribed" } });
  await tick();
  assert.equal(worker.outgoing.filter((message) => message.type.startsWith("event.")).length, forwardedMessages);

  const resumed = root.events.watch();
  resumed.onEvent(() => {});
  await tick();
  assert.equal(fixture.watcherStats.created, 2);
  assert.equal(fixture.watcherStats.active, 1);
  resumed.off();
  await tick();
  assert.equal(fixture.watcherStats.active, 0);

  child.dispose();
  root.dispose();
  assert.equal(worker.terminated, 1);
});

test("Worker batches 4,096 ordered events under hard count and encoded-byte message bounds", async () => {
  const fixture = createFixture();
  const worker = new LoopbackWorker(fixture.createAgent);
  const agent = await createWorkerAgent({ sessionId: "root", harness: false }, { worker });
  const received = [];
  const watch = agent.events.watch();
  watch.onEvent((event) => received.push(event));
  await tick();

  const blob = "x".repeat(2_048);
  for (let seq = 0; seq < 4_096; seq += 1) fixture.emit("root", seq, { blob });
  await tick();

  const batches = worker.outgoing.filter((message) => message.type === "event.batch");
  assert.equal(received.length, 4_096);
  assert.deepEqual(received.map((event) => event.seq), Array.from({ length: 4_096 }, (_, index) => index));
  assert.equal(batches.length > 1, true);
  assert.equal(batches.some((message) => message.events.length < WORKER_EVENT_BATCH_MAX_EVENTS), true);
  assert.equal(batches.reduce((count, message) => count + message.events.length, 0), 4_096);
  for (const message of batches) {
    assert.equal(message.events.length <= WORKER_EVENT_BATCH_MAX_EVENTS, true);
    assert.equal(message.encodedBytes <= WORKER_EVENT_BATCH_MAX_BYTES, true);
    assert.equal(
      message.encodedBytes,
      message.events.reduce((bytes, entry) => bytes + entry.encodedBytes, 0),
    );
  }

  const oversized = "y".repeat(WORKER_EVENT_BATCH_MAX_BYTES + 1_024);
  fixture.emit("root", 4_096, { blob: oversized });
  await tick();
  const chunks = worker.outgoing.filter((message) => message.type === "event.chunk");
  assert.equal(chunks.length > 1, true);
  assert.equal(chunks.every((message) => message.chunk.byteLength <= WORKER_EVENT_BATCH_MAX_BYTES), true);
  assert.equal(received.at(-1).seq, 4_096);
  assert.equal(received.at(-1).payload.blob, oversized);
  assert.equal(Object.isFrozen(received.at(-1).payload), true);

  watch.off();
  await tick();
  const eventMessageCount = worker.outgoing.filter((message) => message.type.startsWith("event.")).length;
  fixture.emit("root", 4_097, { blob: "not-forwarded" });
  await tick();
  assert.equal(
    worker.outgoing.filter((message) => message.type.startsWith("event.")).length,
    eventMessageCount,
  );
  agent.dispose();
});

test("turn cancellation followed by graceful shutdown releases Worker event demand", async () => {
  const fixture = createFixture();
  const worker = new LoopbackWorker(fixture.createAgent);
  const agent = await createWorkerAgent({ sessionId: "root", harness: false }, { worker });
  const watch = agent.events.watch();
  watch.onEvent(() => {});
  await tick();
  assert.equal(fixture.watcherStats.active, 1);

  const turn = agent.turn.prompt({ input: "cancel me" });
  await turn.cancel();
  turn.dispose();
  await agent.session.shutdown();
  await tick();

  assert.equal(fixture.log.some(([kind]) => kind === "cancel"), true);
  assert.equal(fixture.log.some(([kind]) => kind === "shutdown"), true);
  assert.equal(fixture.watcherStats.active, 0);
  assert.equal(worker.terminated, 1);
});

test("session, branching, realtime, and graceful lifecycle remain DefaultAgent-shaped", async () => {
  const fixture = createFixture();
  const worker = new LoopbackWorker(fixture.createAgent);
  const root = await createWorkerAgent({ sessionId: "root", harness: false }, { worker });

  await root.session.setThinking("high");
  await root.session.setFastMode(true);
  await root.session.compact();
  assert.equal((await root.session.appendDeveloperMessage("voice started")).workspace, "/workspace/root");
  await root.session.realtime.start();
  await root.session.realtime.end();
  assert.equal(
    root.session.realtime.delegation("fix <x>", [{ role: "user", text: "yes & now" }]),
    "<realtime_delegation>\n  <input>fix &lt;x&gt;</input>\n  <transcript_delta>user: yes &amp; now</transcript_delta>\n</realtime_delegation>",
  );
  assert.equal(root.session.realtime.tailDelegation([]), undefined);

  const first = root.turn.prompt({ input: "first" });
  const firstResult = first.result();
  await tick();
  fixture.complete("root", "first done");
  const completed = await firstResult;
  const fork = await root.session.fork({ at: completed });
  const spawn = await root.session.spawn();
  assert.equal(fork.sessionId, "root-fork");
  assert.equal(spawn.sessionId, "root-spawn");
  assert.equal(fixture.log.some(([kind]) => kind === "fork-at"), true);

  const childEvents = [];
  const childWatch = spawn.events.watch();
  childWatch.onEvent((event) => childEvents.push(event.seq));
  fork.dispose();
  first.dispose();
  await root.session.shutdown();
  fixture.emit("root-spawn", 7);
  await tick();
  assert.deepEqual(childEvents, [7]);
  await spawn.session.compact();
  childWatch.off();
  spawn.dispose();
  assert.equal(worker.terminated, 1);
  assert.throws(() => root.turn.prompt({ input: "late" }), /disposed/);
});

test("Worker failures reject every pending operation and stale messages stay isolated", async () => {
  const fixture = createFixture();
  const worker = new LoopbackWorker(fixture.createAgent);
  const agent = await createWorkerAgent({ sessionId: "root", harness: false }, { worker });
  const turn = agent.turn.prompt({ input: "never completes" });
  const pending = turn.result();
  const staleHandler = worker.onmessage;
  await tick();

  worker.crash("worker exploded");
  await assert.rejects(pending, /worker exploded/);
  assert.throws(() => agent.session.compact(), /disposed/);
  staleHandler({ data: { protocol: "nanocodex.worker-agent.v1", channel: "stale", type: "resolve", id: "rpc-1" } });
  assert.equal(worker.terminated, 1);
  agent.dispose();
});

test("pending RPCs and structured-clone configuration fail closed at explicit bounds", async () => {
  await assert.rejects(
    createWorkerAgent({ tools: { custom: () => {} } }, { worker: () => { throw new Error("must not construct"); } }),
    /cannot contain functions.*Worker boundary/,
  );
  await assert.rejects(
    createWorkerAgent({
      transport: Transport.hostManaged({ createWebSocket() {} }),
      harness: false,
    }, { worker: () => { throw new Error("must not construct"); } }),
    /host-managed transport callbacks must live inside a custom Worker/,
  );

  const fixture = createFixture({ holdCompaction: true });
  const worker = new LoopbackWorker(fixture.createAgent);
  const agent = await createWorkerAgent({ sessionId: "root", harness: false }, { worker, maxPendingRpcs: 2 });
  const first = agent.session.compact();
  const second = agent.session.compact();
  void first.catch(() => {});
  void second.catch(() => {});
  assert.throws(() => agent.session.compact(), /bound of 2 pending RPCs/);
  worker.crash("bounded cleanup");
  await assert.rejects(first, /bounded cleanup/);
  await assert.rejects(second, /bounded cleanup/);
});

test("host-managed transport is a clone-safe Worker descriptor without app callbacks", async () => {
  const fixture = createFixture();
  const worker = new LoopbackWorker(fixture.createAgent);
  const agent = await createWorkerAgent({
    sessionId: "hosted",
    harness: false,
    transport: Transport.hostManaged({
      websocketUrl: "wss://nanocodex.example/api/responses",
    }),
  }, { worker });

  assert.equal(agent.sessionId, "hosted");
  agent.dispose();
  assert.equal(worker.terminated, 1);
});

test("rebooting a runtime disposes the replaced Agent and suppresses stale completion", async () => {
  const created = [];
  const outgoing = [];
  const scope = { onmessage: null, postMessage: (message) => outgoing.push(message) };
  const runtime = installWorkerAgentRuntime(scope, {
    async createAgent({ sessionId }) {
      const fixture = createFixture();
      const agent = await fixture.createAgent({ sessionId });
      created.push({ agent, fixture });
      return agent;
    },
  });
  scope.onmessage({ data: { protocol: "nanocodex.worker-agent.v1", channel: "old", type: "boot", config: { sessionId: "old", harness: false } } });
  await tick();
  scope.onmessage({ data: { protocol: "nanocodex.worker-agent.v1", channel: "new", type: "boot", config: { sessionId: "new", harness: false } } });
  await tick();
  assert.equal(created[0].agent.disposed, true);
  assert.equal(outgoing.at(-1).channel, "new");
  runtime.dispose();
  assert.equal(created[1].agent.disposed, true);
});

test("Worker runtime prewarms the engine and exact browser harness before boot", async () => {
  const outgoing = [];
  const warmed = [];
  const scope = { onmessage: null, postMessage: (message) => outgoing.push(message) };
  const runtime = installWorkerAgentRuntime(scope, {
    prewarmLocal(harness) { warmed.push(harness); },
  });

  scope.onmessage({ data: {
    protocol: "nanocodex.worker-agent.v1",
    channel: "warm",
    type: "prewarm",
    harness: { threadId: "thread-1", origin: "https://nanocodex.test" },
  } });
  await tick();

  assert.deepEqual(warmed, [{ threadId: "thread-1", origin: "https://nanocodex.test" }]);
  assert.equal(outgoing.at(-1).type, "prewarmed");
  runtime.dispose();
});

test("private Worker preparation replaces stale ownership and is claimed by Agent.create", async () => {
  const firstFixture = createFixture();
  const first = new LoopbackWorker(firstFixture.createAgent, { prewarmLocal() {} });
  await prepareWorkerAgent({ harness: false }, { worker: first });
  assert.equal(first.terminated, 0);

  const secondFixture = createFixture();
  const second = new LoopbackWorker(secondFixture.createAgent, { prewarmLocal() {} });
  await prepareWorkerAgent({
    origin: "https://nanocodex.test",
    threadId: "00000000-0000-4000-8000-000000000002",
  }, { worker: second });
  assert.equal(first.terminated, 1);

  const claimedFixture = createFixture();
  const claimed = new LoopbackWorker(claimedFixture.createAgent, { prewarmLocal() {} });
  await prepareWorkerAgent({ harness: false }, { worker: claimed });
  assert.equal(second.terminated, 1);

  const agent = await createWorkerAgent({ harness: false });
  assert.equal(agent.sessionId, "root");
  agent.dispose();
  assert.equal(claimed.terminated, 1);
});

class LoopbackWorker {
  constructor(createAgent, runtimeOptions = {}) {
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
    this.terminated = 0;
    this.incoming = [];
    this.outgoing = [];
    this.scope = {
      onmessage: null,
      postMessage: (data, transfer) => {
        const cloned = cloneMessage(data, transfer);
        this.outgoing.push(cloned);
        queueMicrotask(() => this.onmessage?.({ data: cloned }));
      },
    };
    this.runtime = installWorkerAgentRuntime(this.scope, { createAgent, ...runtimeOptions });
  }

  postMessage(data) {
    const cloned = cloneMessage(data);
    this.incoming.push(cloned);
    queueMicrotask(() => this.scope.onmessage?.({ data: cloned }));
  }
  terminate() {
    if (this.terminated) return;
    this.terminated += 1;
    this.runtime.dispose();
  }
  crash(message) { this.onerror?.({ message }); }
}

function createFixture(options = {}) {
  const watchers = new Set();
  const completions = new Map();
  const log = [];
  const watcherStats = { active: 0, created: 0, released: 0, options: [] };
  const fixture = {
    log,
    watcherStats,
    emit(requestId, seq, payload = {}) {
      const event = { protocol_version: 1, request_id: requestId, seq, type: "test", payload };
      const encoded = JSON.stringify(event);
      const encodedBytes = Buffer.byteLength(encoded);
      for (const watcher of watchers) {
        for (const listener of watcher.listeners) listener(event, encodedBytes, encoded);
      }
    },
    complete(sessionId, finalMessage) {
      const completion = completions.get(sessionId);
      if (!completion) throw new Error(`no pending turn for ${sessionId}`);
      completions.delete(sessionId);
      completion({
        finalMessage,
        snapshot: Object.freeze({
          version: 1,
          model: "gpt-5.6-sol",
          lineage_id: sessionId,
          prompt_cache_key: sessionId,
          workspace: `/workspace/${sessionId}`,
          canonical_context: {},
          history: [],
        }),
        usage: Object.freeze({
          input_tokens: 1,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 2,
          reasoning_output_tokens: 0,
          total_tokens: 3,
          estimated_cost: null,
          cost_status: "usage_not_reported",
        }),
      });
    },
    async createAgent({ sessionId = "root" } = {}) { return fakeAgent(sessionId); },
  };

  function fakeAgent(sessionId) {
    const agent = {
      sessionId,
      disposed: false,
      events: {
        watch(watchOptions = {}) {
          let active = true;
          const watcher = { listeners: new Set() };
          watchers.add(watcher);
          watcherStats.active += 1;
          watcherStats.created += 1;
          watcherStats.options.push(watchOptions);
          return {
            onEvent(listener) {
              watcher.listeners.add(listener);
              return () => watcher.listeners.delete(listener);
            },
            off() {
              if (!active) return;
              active = false;
              watcher.listeners.clear();
              watchers.delete(watcher);
              watcherStats.active -= 1;
              watcherStats.released += 1;
            },
            async *[Symbol.asyncIterator]() {},
          };
        },
      },
      turn: {
        prompt({ input, id }) {
          log.push(["prompt", sessionId, typeof input === "string" ? input : input[0].text, id]);
          let resolve;
          const result = new Promise((accept) => { resolve = accept; });
          completions.set(sessionId, resolve);
          return {
            result: () => result,
            async steer({ input: steering }) { log.push(["steer", sessionId, typeof steering === "string" ? steering : steering[0].text]); },
            async cancel() { log.push(["cancel", sessionId]); },
            dispose() { log.push(["turn-dispose", sessionId]); },
          };
        },
      },
      session: {
        async fork({ at } = {}) { log.push([at ? "fork-at" : "fork", sessionId]); return fakeAgent(`${sessionId}-fork`); },
        async spawn() { log.push(["spawn", sessionId]); return fakeAgent(`${sessionId}-spawn`); },
        compact() { log.push(["compact", sessionId]); return options.holdCompaction ? new Promise(() => {}) : Promise.resolve(); },
        async setThinking(value) { log.push(["thinking", sessionId, value]); },
        async setFastMode(value) { log.push(["fast", sessionId, value]); },
        async appendDeveloperMessage(text) { log.push(["developer", sessionId, text]); return { workspace: `/workspace/${sessionId}`, history: [] }; },
        async shutdown() { log.push(["shutdown", sessionId]); agent.dispose(); },
        realtime: {
          async start() { log.push(["realtime-start", sessionId]); return { workspace: `/workspace/${sessionId}`, history: [] }; },
          async end() { log.push(["realtime-end", sessionId]); return { workspace: `/workspace/${sessionId}`, history: [] }; },
        },
      },
      dispose() { if (!agent.disposed) { agent.disposed = true; log.push(["agent-dispose", sessionId]); } },
    };
    return agent;
  }
  return fixture;
}

function cloneMessage(data, transfer) {
  return transfer?.length
    ? structuredClone(data, { transfer })
    : structuredClone(data);
}

function tick() { return new Promise((resolve) => setImmediate(resolve)); }
