import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { test } from "node:test";

import { Actions } from "../index.mjs";
import { Agent as BrowserAgent, Transport as BrowserTransport } from "../browser/index.mjs";
import {
  createAgentClient,
  defineRuntime,
} from "../internal.mjs";
import { Agent as NodeAgent, Transport as NodeTransport } from "../node/index.mjs";
import { createCodeRuntime } from "../runtime/code-runtime.mjs";

const LIMITS = Object.freeze({
  coldNodeAgentMs: 250,
  warmAgentP50Ms: 1.5,
  warmAgentP95Ms: 10,
  actionNanoseconds: 5_000,
  bufferedEventsMs: 50,
  codeModeMicroseconds: 250,
});
const nodeTransport = NodeTransport.openAi({ apiKey: "performance-test" });
const browserTransport = BrowserTransport.openAi({
  apiKey: "performance-test",
  WebSocketImpl: class {},
});

test("Node reuses one compiled WASM instance and keeps warm agent creation sub-millisecond", async (context) => {
  const OriginalModule = WebAssembly.Module;
  const OriginalInstance = WebAssembly.Instance;
  let modules = 0;
  let instances = 0;
  WebAssembly.Module = class extends OriginalModule {
    constructor(...arguments_) {
      super(...arguments_);
      modules += 1;
    }
  };
  WebAssembly.Instance = class extends OriginalInstance {
    constructor(...arguments_) {
      super(...arguments_);
      instances += 1;
    }
  };
  try {
    const coldStarted = performance.now();
    const cold = await NodeAgent.create({ transport: nodeTransport });
    const coldMs = performance.now() - coldStarted;
    cold.dispose();

    const samples = [];
    for (let index = 0; index < 64; index += 1) {
      const started = performance.now();
      const agent = await NodeAgent.create({ transport: nodeTransport });
      samples.push(performance.now() - started);
      agent.dispose();
    }
    const p50 = percentile(samples, 0.5);
    const p95 = percentile(samples, 0.95);
    context.diagnostic(JSON.stringify({
      cold_ms: round(coldMs),
      module_compilations: modules,
      module_instantiations: instances,
      warm_p50_ms: round(p50),
      warm_p95_ms: round(p95),
    }));

    assert.equal(modules, 1);
    assert.equal(instances, 1);
    assert.ok(coldMs <= LIMITS.coldNodeAgentMs, `cold Node Agent.create took ${coldMs} ms`);
    assert.ok(p50 <= LIMITS.warmAgentP50Ms, `warm Node Agent.create p50 was ${p50} ms`);
    assert.ok(p95 <= LIMITS.warmAgentP95Ms, `warm Node Agent.create p95 was ${p95} ms`);
  } finally {
    WebAssembly.Module = OriginalModule;
    WebAssembly.Instance = OriginalInstance;
  }
});

test("a precompiled browser module instantiates once across isolated agents", async (context) => {
  const bytes = await readFile(new URL("../pkg-web/nanocodex_bg.wasm", import.meta.url));
  const module = await WebAssembly.compile(bytes);
  const originalInstantiate = WebAssembly.instantiate;
  let instantiations = 0;
  WebAssembly.instantiate = (...arguments_) => {
    instantiations += 1;
    return originalInstantiate(...arguments_);
  };
  try {
    const coldStarted = performance.now();
    const cold = await BrowserAgent.createInline({
      transport: browserTransport,
      module,
    });
    const coldMs = performance.now() - coldStarted;
    cold.dispose();
    for (let index = 0; index < 16; index += 1) {
      const agent = await BrowserAgent.createInline({
        transport: browserTransport,
        module,
      });
      agent.dispose();
    }

    const samples = [];
    for (let index = 0; index < 64; index += 1) {
      const started = performance.now();
      const agent = await BrowserAgent.createInline({
        transport: browserTransport,
        module,
      });
      samples.push(performance.now() - started);
      agent.dispose();
    }
    const p50 = percentile(samples, 0.5);
    const p95 = percentile(samples, 0.95);
    context.diagnostic(JSON.stringify({
      cold_ms: round(coldMs),
      module_instantiations: instantiations,
      warm_p50_ms: round(p50),
      warm_p95_ms: round(p95),
    }));

    assert.equal(instantiations, 1);
    assert.ok(coldMs <= LIMITS.coldNodeAgentMs, `cold browser Agent.create took ${coldMs} ms`);
    assert.ok(p50 <= LIMITS.warmAgentP50Ms, `warm browser Agent.create p50 was ${p50} ms`);
    assert.ok(p95 <= LIMITS.warmAgentP95Ms, `warm browser Agent.create p95 was ${p95} ms`);
  } finally {
    WebAssembly.instantiate = originalInstantiate;
  }
});

test("JavaScript actions, event buffering, and Code Mode stay below binding-owned budgets", async (context) => {
  const subscriptions = new Set();
  const rawTurn = {
    async result() { return "done"; },
    free() {},
  };
  const rawAgent = {
    sessionId: "performance-session",
    prompt() { return rawTurn; },
    free() {},
  };
  const agent = await createAgentClient(defineRuntime({
    create: () => rawAgent,
    subscribe(listener) {
      subscriptions.add(listener);
      return () => subscriptions.delete(listener);
    },
    decorate: (client) => client.extend(Actions.agentActions()),
  }));

  const actionIterations = 50_000;
  const actionStarted = performance.now();
  for (let index = 0; index < actionIterations; index += 1) {
    agent.turn.prompt({ input: "measure wrapper overhead" }).dispose();
  }
  const actionNanoseconds = (
    (performance.now() - actionStarted) * 1_000_000 / actionIterations
  );

  const watch = agent.events.watch();
  const iterator = watch[Symbol.asyncIterator]();
  const eventCount = 4_096;
  const eventsStarted = performance.now();
  for (let seq = 1; seq <= eventCount; seq += 1) {
    for (const listener of subscriptions) {
      listener({ request_id: agent.sessionId, seq, type: "api.event" });
    }
  }
  for (let seq = 1; seq <= eventCount; seq += 1) {
    assert.equal((await iterator.next()).value.seq, seq);
  }
  const bufferedEventsMs = performance.now() - eventsStarted;
  await iterator.return();
  watch.off();
  agent.dispose();

  const code = createCodeRuntime({
    increment: {
      description: "Increment an integer.",
      parameters: {
        type: "object",
        properties: { value: { type: "integer" } },
        required: ["value"],
      },
      handler: ({ value }) => value + 1,
    },
  });
  const codeIterations = 1_000;
  const codeStarted = performance.now();
  for (let index = 0; index < codeIterations; index += 1) {
    const result = JSON.parse(await code.executeCode(
      `text(await tools.increment({ value: ${index} }));`,
      "performance-session",
      `call-${index}`,
    ));
    assert.equal(result.success, true);
  }
  const codeModeMicroseconds = (
    (performance.now() - codeStarted) * 1_000 / codeIterations
  );
  context.diagnostic(JSON.stringify({
    action_ns_per_prompt: round(actionNanoseconds),
    buffered_events: eventCount,
    buffered_events_ms: round(bufferedEventsMs),
    code_mode_us_per_execution: round(codeModeMicroseconds),
  }));

  assert.ok(
    actionNanoseconds <= LIMITS.actionNanoseconds,
    `prompt action wrapper took ${actionNanoseconds} ns per call`,
  );
  assert.ok(
    bufferedEventsMs <= LIMITS.bufferedEventsMs,
    `${eventCount} buffered events took ${bufferedEventsMs} ms`,
  );
  assert.ok(
    codeModeMicroseconds <= LIMITS.codeModeMicroseconds,
    `Code Mode host took ${codeModeMicroseconds} µs per execution`,
  );
});

function percentile(values, quantile) {
  const ordered = values.toSorted((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * quantile))];
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}
