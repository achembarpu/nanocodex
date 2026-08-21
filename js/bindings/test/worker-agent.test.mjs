import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createWorkerAgent,
  installWorkerAgentRuntime,
  prepareWorkerAgent,
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
    this.scope = {
      onmessage: null,
      postMessage: (data) => queueMicrotask(() => this.onmessage?.({ data })),
    };
    this.runtime = installWorkerAgentRuntime(this.scope, { createAgent, ...runtimeOptions });
  }

  postMessage(data) { queueMicrotask(() => this.scope.onmessage?.({ data })); }
  terminate() {
    if (this.terminated) return;
    this.terminated += 1;
    this.runtime.dispose();
  }
  crash(message) { this.onerror?.({ message }); }
}

function createFixture(options = {}) {
  const listeners = new Set();
  const completions = new Map();
  const log = [];
  const fixture = {
    log,
    emit(requestId, seq) {
      const event = { protocol_version: 1, request_id: requestId, seq, type: "test", payload: {} };
      for (const listener of listeners) listener(event);
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
        watch() {
          let active = true;
          return {
            onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
            off() { if (!active) return; active = false; listeners.clear(); },
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

function tick() { return new Promise((resolve) => setImmediate(resolve)); }
