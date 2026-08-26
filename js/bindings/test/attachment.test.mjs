import assert from "node:assert/strict";
import test from "node:test";

import {
  providerSource,
  ToolRouter,
  toolRouterBrand,
  toolRouterRuntime,
} from "../runtime/tool-router.mjs";
import { createTools } from "../tools/Tools.mjs";
import { createAttachment } from "../tools/attachment.mjs";

const LEASE_ID = "22222222-2222-4222-8222-222222222222";
const base = { protocol_version: 1, capability: "tools" };

function reverseTarget(connect, endpoint = "wss://managed.test/") {
  return { endpoint, transport: { connect } };
}

test("reverse attachment uses canonical attach, lease, catalog digest, call, result, and ack frames", async () => {
  const socket = new FakeSocket();
  let context;
  const tools = await createTools({ tools: {
    echo: {
      description: "Echo one value.",
      strict: true,
      parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
      outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
      supportsParallelToolCalls: true,
      handler: ({ value }, received) => { context = received; return { value }; },
    },
  } });
  const connecting = tools.attach(reverseTarget(async (target) => {
    assert.equal(target, "wss://managed.test/tools");
    return socket;
  }, "wss://managed.test/tools"), {
    reconnect: false,
  }).connect();
  await tick();
  const hostId = socket.frames()[0].host_id;
  assert.match(hostId, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(socket.frames()[0], {
    ...base,
    type: "attach",
    host_id: hostId,
    capabilities: [{ name: "tools", version: 1 }],
  });
  socket.receive({
    ...base,
    type: "lease",
    lease_id: LEASE_ID,
    generation: 7,
    expires_at: Date.now() + 60_000,
    capabilities: [{ name: "tools", version: 1 }],
  });
  await waitFor(() => socket.frames().some(({ type }) => type === "catalog_publish"));
  const catalog = socket.frames().find(({ type }) => type === "catalog_publish");
  assert.match(catalog.catalog_digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(catalog.tools[0], {
    provider: "javascript",
    remote_name: "echo",
    definition: {
      type: "function",
      name: "echo",
      description: "Echo one value.",
      strict: true,
      parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
      output_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    },
    parallel_safe: true,
    timeout_ms: 120_000,
  });
  socket.receive({
    ...base,
    type: "catalog_ack",
    lease_id: LEASE_ID,
    generation: 7,
    catalog_revision: 1,
    catalog_digest: catalog.catalog_digest,
  });
  const client = await connecting;
  assert.equal(client.connected, true);
  assert.deepEqual(Object.keys(client), ["connected", "closed", "close"]);
  socket.receive(callFrame({ value: "hello" }, socket));
  await waitFor(() => socket.frames().some(({ type }) => type === "result"));
  const result = socket.frames().find(({ type }) => type === "result");
  assert.equal(context.model, "gpt-5.6-sol");
  assert.deepEqual(result.outcome, {
    status: "completed",
    output: {
      output: '{"value":"hello"}',
      success: true,
      structured_result: { value: "hello" },
      metadata: null,
      process_trace: null,
    },
  });
  socket.receive({ ...base, type: "result_ack", lease_id: LEASE_ID, generation: 7, catalog_revision: 1, call_id: "call:1" });
  client.close();
  await tools.close();
});

test("numeric schema keys use the Rust catalog digest", async () => {
  const socket = new FakeSocket();
  const tools = await createTools({ tools: {
    numeric_keys: {
      description: "numeric object keys",
      parameters: {
        type: "object",
        properties: { 2: { type: "string" }, 10: { type: "string" } },
        additionalProperties: false,
      },
      provider: "fixed",
      handler: (input) => input,
    },
  } });
  const connecting = tools.attach(reverseTarget(async () => socket), { reconnect: false }).connect();
  await tick();
  socket.receive({
    ...base,
    type: "lease",
    lease_id: LEASE_ID,
    generation: 7,
    expires_at: Date.now() + 60_000,
    capabilities: [{ name: "tools", version: 1 }],
  });
  await waitFor(() => socket.frames().some(({ type }) => type === "catalog_publish"));
  const catalog = socket.frames().find(({ type }) => type === "catalog_publish");
  assert.equal(catalog.catalog_digest, "a90cd50d8abe0572db8a87a359ea5b3429b14cb1f425c8d345b21c6db404146a");
  socket.receive({
    ...base,
    type: "catalog_ack",
    lease_id: LEASE_ID,
    generation: 7,
    catalog_revision: 1,
    catalog_digest: catalog.catalog_digest,
  });
  const client = await connecting;
  client.close();
  await tools.close();
});

test("duplicate identity is idempotent, changed identity and unknown result ack fence", async () => {
  let finish;
  let calls = 0;
  const fixture = await readyAttachment({
    async handler() { calls++; return new Promise((resolve) => { finish = resolve; }); },
  });
  const first = callFrame({ id: 1 }, fixture.socket);
  fixture.socket.receive(first);
  fixture.socket.receive(first);
  await tick();
  assert.equal(calls, 1);
  fixture.socket.receive({ ...first, input: { id: 2 } });
  await waitFor(() => fixture.socket.closed?.code === 1008);
  finish?.("late");
  fixture.client.close();
  await fixture.tools.close();

  const unknown = await readyAttachment({ handler: () => "ok" });
  unknown.socket.receive({ ...base, type: "result_ack", lease_id: LEASE_ID, generation: 7, catalog_revision: 1, call_id: "unknown" });
  await waitFor(() => unknown.socket.closed?.code === 1008);
  await unknown.tools.close();
});

test("post-dispatch cancellation is too_late and does not suppress the result", async () => {
  let finish;
  const fixture = await readyAttachment({ handler: () => new Promise((resolve) => { finish = resolve; }) });
  fixture.socket.receive(callFrame({ value: 1 }, fixture.socket));
  await tick();
  fixture.socket.receive({ ...base, type: "cancel", lease_id: LEASE_ID, generation: 7, catalog_revision: 1, call_id: "call:1" });
  await waitFor(() => fixture.socket.frames().some(({ type }) => type === "cancel_ack"));
  assert.equal(fixture.socket.frames().find(({ type }) => type === "cancel_ack").outcome, "too_late");
  finish("done");
  await waitFor(() => fixture.socket.frames().some(({ type }) => type === "result"));
  assert.equal(fixture.socket.frames().find(({ type }) => type === "result").outcome.status, "completed");
  fixture.client.close();
  await fixture.tools.close();
});

test("invalid post-dispatch output is ambiguous, not an ordinary tool failure", async () => {
  const fixture = await readyAttachment({ handler: () => 1n });
  fixture.socket.receive(callFrame({ value: 1 }, fixture.socket));
  await waitFor(() => fixture.socket.frames().some(({ type }) => type === "result"));
  const outcome = fixture.socket.frames().find(({ type }) => type === "result").outcome;
  assert.equal(outcome.status, "ambiguous");
  assert.match(outcome.message, /not valid bounded wire output/);
  fixture.client.close();
  await fixture.tools.close();
});

test("expired calls are rejected before handler admission and model is immutable identity", async () => {
  let calls = 0;
  const fixture = await readyAttachment({ handler: () => { calls++; return "unexpected"; } });
  fixture.socket.receive({ ...callFrame({}, fixture.socket), deadline_at: Date.now() - 1 });
  await waitFor(() => fixture.socket.frames().some(({ type }) => type === "result"));
  assert.equal(calls, 0);
  assert.equal(fixture.socket.frames().find(({ type }) => type === "result").outcome.status, "unavailable");
  fixture.client.close();
  await fixture.tools.close();

  const changed = await readyAttachment({ handler: () => "ok" });
  const first = callFrame({}, changed.socket);
  changed.socket.receive(first);
  await waitFor(() => changed.socket.frames().some(({ type }) => type === "result"));
  changed.socket.receive({ ...first, model: "gpt-5.6-terra" });
  await waitFor(() => changed.socket.closed?.code === 1008);
  await changed.tools.close();
});

test("attachment targets are validated before transport and plaintext is loopback-only", async () => {
  const tools = await createTools();
  for (const target of [
    "https://managed.test/tools",
    "wss://user:secret@managed.test/tools",
    "wss://managed.test/tools#secret",
    "ws://managed.test/tools",
  ]) assert.throws(() => tools.attach(target), /tool attachment target|plaintext ws/);
  assert.throws(
    () => tools.attach("wss://managed.test", { transport: { connect() {} } }),
    /unsupported tool attachment option/,
  );
  assert.throws(
    () => tools.attach({ url: "wss://managed.test" }),
    /unsupported tool attachment target field/,
  );
  assert.throws(
    () => tools.attach("wss://managed.test", { reconnectDelayMs: 0 }),
    /positive safe integer/,
  );
  const connector = tools.attach(reverseTarget(async (target) => {
    assert.equal(target, "ws://127.0.0.1:8787/tools");
    throw new Error("expected stop");
  }, "ws://127.0.0.1:8787/tools"));
  await assert.rejects(connector.connect(), /expected stop/);
  await tools.close();
});

test("attachment waits for settled providers and dispatches through its published snapshot", async () => {
  let settle;
  let entries = [];
  const settled = new Promise((resolve) => { settle = resolve; });
  const router = new ToolRouter();
  router.addSource(providerSource("late", {
    id: "late",
    kind: "cloud",
    definitions: () => entries.map(({ definition }) => definition),
    resolve: (name) => entries.find(({ definition }) => definition.name === name)?.tool,
    settled: () => settled,
  }));
  const owner = { [toolRouterBrand]: true, [toolRouterRuntime]: router };
  const socket = new FakeSocket();
  const connector = createAttachment(owner, reverseTarget(async () => socket), {
    reconnect: false,
  });
  const connecting = connector.connect();
  await tick();
  assert.deepEqual(socket.frames(), []);
  entries = [{
    definition: { type: "function", name: "late", description: "Late.", strict: false, parameters: { type: "object" } },
    tool: { name: "late", parallelSafe: false, handler: () => "published" },
  }];
  settle();
  await waitFor(() => socket.frames().some(({ type }) => type === "attach"));
  socket.receive({ ...base, type: "lease", lease_id: LEASE_ID, generation: 7, expires_at: Date.now() + 60_000, capabilities: [{ name: "tools", version: 1 }] });
  await waitFor(() => socket.frames().some(({ type }) => type === "catalog_publish"));
  const catalog = socket.frames().find(({ type }) => type === "catalog_publish");
  assert.equal(catalog.tools[0].definition.name, "late");
  socket.receive({ ...base, type: "catalog_ack", lease_id: LEASE_ID, generation: 7, catalog_revision: 1, catalog_digest: catalog.catalog_digest });
  const client = await connecting;
  await router.detachSource("late");
  socket.receive({ ...callFrame({}, socket), name: "late" });
  await waitFor(() => socket.frames().some(({ type }) => type === "result"));
  assert.equal(socket.frames().find(({ type }) => type === "result").outcome.output.output, "published");
  client.close();
  connector.close();
});

test("callbacks from a replaced socket cannot fence the reconnected generation", async () => {
  const first = new FakeSocket();
  const second = new FakeSocket();
  const sockets = [first, second];
  const tools = await createTools({ tools: { echo: { handler: () => "ok" } } });
  const connecting = tools.attach(reverseTarget(async () => sockets.shift()), {
    reconnectDelayMs: 1,
  }).connect();
  await acknowledge(first, LEASE_ID, 7);
  const client = await connecting;
  first.close(1012, "reconnect");
  await waitFor(() => second.frames().some(({ type }) => type === "attach"));
  await acknowledge(second, "33333333-3333-4333-8333-333333333333", 8);
  await waitFor(() => client.connected);

  first.emit("open", {});
  first.receive({ unexpected: true });
  first.emit("error", { error: new Error("stale") });
  await tick();
  assert.equal(second.closed, undefined);
  assert.equal(client.connected, true);
  client.close();
  await tools.close();
});

test("initial transport failure rejects without reconnecting", async () => {
  const tools = await createTools();
  let attempts = 0;
  await assert.rejects(
    tools.attach(reverseTarget(async () => { attempts++; throw new Error("offline"); })).connect(),
    /offline/,
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(attempts, 1);
  await tools.close();
});

test("an opened socket that never leases or acknowledges the catalog times out", async () => {
  const socket = new FakeSocket();
  const tools = await createTools();
  await assert.rejects(
    tools.attach(reverseTarget(async () => socket), {
      handshakeTimeoutMs: 5,
      reconnect: false,
    }).connect(),
    /handshake timed out/,
  );
  assert.equal(socket.closed.code, 1012);
  await tools.close();
});

test("Node-style ws text buffers remain text while binary messages are rejected", async () => {
  const socket = new NodeStyleSocket();
  const tools = await createTools();
  const connecting = tools.attach(reverseTarget(async () => socket), {
    reconnect: false,
  }).connect();
  await tick();
  socket.receive({
    ...base,
    type: "lease",
    lease_id: LEASE_ID,
    generation: 7,
    expires_at: Date.now() + 60_000,
    capabilities: [{ name: "tools", version: 1 }],
  });
  await waitFor(() => socket.frames().some(({ type }) => type === "catalog_publish"));
  const catalog = socket.frames().find(({ type }) => type === "catalog_publish");
  socket.receive({
    ...base,
    type: "catalog_ack",
    lease_id: LEASE_ID,
    generation: 7,
    catalog_revision: 1,
    catalog_digest: catalog.catalog_digest,
  });
  const client = await connecting;
  assert.equal(client.connected, true);
  socket.receive({ ...base, type: "pong" }, true);
  await waitFor(() => socket.closed?.code === 1008);
  await tools.close();
});

test("lease expiry watchdog closes a ready generation", async () => {
  const socket = new FakeSocket();
  const tools = await createTools({ tools: { echo: { description: "Echo.", handler: () => "ok" } } });
  const connecting = tools.attach(reverseTarget(async () => socket), {
    reconnect: false,
    heartbeatMs: 5,
  }).connect();
  await tick();
  socket.receive({ ...base, type: "lease", lease_id: LEASE_ID, generation: 7, expires_at: Date.now() + 20, capabilities: [{ name: "tools", version: 1 }] });
  await waitFor(() => socket.frames().some(({ type }) => type === "catalog_publish"));
  const catalog = socket.frames().find(({ type }) => type === "catalog_publish");
  socket.receive({ ...base, type: "catalog_ack", lease_id: LEASE_ID, generation: 7, catalog_revision: 1, catalog_digest: catalog.catalog_digest });
  await connecting;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(socket.closed.code, 1012);
  await tools.close();
});

test("Tools.close owns live and not-yet-connected attachment connectors", async () => {
  const tools = await createTools();
  const socket = new FakeSocket();
  const connector = tools.attach(reverseTarget(async () => socket), { reconnect: false });
  await tools.close();
  await assert.rejects(connector.connect(), /connector is closed/);

  let openSocket;
  const opening = new Promise((resolve) => { openSocket = resolve; });
  const racingTools = await createTools();
  const racingConnect = racingTools.attach(reverseTarget(() => opening), {
  }).connect();
  await racingTools.close();
  await assert.rejects(racingConnect, /connector is closed/);
  openSocket(new FakeSocket());

  const live = await readyAttachment({ handler: () => "ok" });
  await live.tools.close();
  assert.equal(live.socket.closed.code, 1000);
});

test("detach exposes one repeatable boundary that waits for WebSocket retirement", async () => {
  const socket = new DelayedCloseSocket();
  const fixture = await readyAttachment({ handler: () => "ok" }, socket);
  const closing = fixture.connector.close();
  let settled = false;
  void closing.then(() => { settled = true; });
  await tick();
  assert.equal(settled, false);
  assert.equal(fixture.client.connected, false);
  socket.finishClose();
  await closing;
  await fixture.connector.closed();
  await fixture.client.closed();
  assert.equal(await fixture.connector.close(), undefined);
  await fixture.tools.close();
});

test("Tools.close joins delayed WebSocket retirement", async () => {
  const socket = new DelayedCloseSocket();
  const fixture = await readyAttachment({ handler: () => "ok" }, socket);
  const closing = fixture.tools.close();
  let settled = false;
  void closing.then(() => { settled = true; });
  await tick();
  assert.equal(settled, false);
  assert.equal(fixture.client.connected, false);
  socket.finishClose();
  await closing;
  assert.equal(settled, true);
  await fixture.connector.closed();
  await fixture.client.closed();
});

test("Cloudflare self-fencing settles terminal attachment truth", async () => {
  const socket = new CloudflareSocket();
  const fixture = await readyAttachment({ handler: () => "ok" }, socket);
  socket.receive({ ...base, type: "unknown" });
  await fixture.client.closed();
  await fixture.connector.closed();
  assert.equal(fixture.client.connected, false);
  assert.equal(socket.closed.code, 1008);
  assert(Buffer.byteLength(socket.closed.reason) <= 123);
  await fixture.tools.close();
});

async function readyAttachment(tool, socket = new FakeSocket()) {
  const tools = await createTools({ tools: { echo: {
    description: "Echo.", parameters: { type: "object", additionalProperties: true }, ...tool,
  } } });
  const connector = tools.attach(reverseTarget(async () => socket), { reconnect: false });
  const connecting = connector.connect();
  await tick();
  socket.receive({ ...base, type: "lease", lease_id: LEASE_ID, generation: 7, expires_at: Date.now() + 60_000, capabilities: [{ name: "tools", version: 1 }] });
  await waitFor(() => socket.frames().some(({ type }) => type === "catalog_publish"));
  const catalog = socket.frames().find(({ type }) => type === "catalog_publish");
  socket.receive({ ...base, type: "catalog_ack", lease_id: LEASE_ID, generation: 7, catalog_revision: 1, catalog_digest: catalog.catalog_digest });
  return { socket, tools, connector, client: await connecting };
}

async function acknowledge(socket, leaseId, generation) {
  await waitFor(() => socket.frames().some(({ type }) => type === "attach"));
  socket.receive({ ...base, type: "lease", lease_id: leaseId, generation, expires_at: Date.now() + 60_000, capabilities: [{ name: "tools", version: 1 }] });
  await waitFor(() => socket.frames().some(({ type }) => type === "catalog_publish"));
  const catalog = socket.frames().find(({ type }) => type === "catalog_publish");
  socket.receive({ ...base, type: "catalog_ack", lease_id: leaseId, generation, catalog_revision: 1, catalog_digest: catalog.catalog_digest });
}

function callFrame(input, socket) {
  return {
    ...base,
    type: "call",
    host_id: socket.frames().find(({ type }) => type === "attach").host_id,
    lease_id: LEASE_ID,
    generation: 7,
    catalog_revision: 1,
    session_id: "session:1",
    call_id: "call:1",
    model: "gpt-5.6-sol",
    name: "echo",
    input,
    output_token_budget: 10_000,
    output_byte_budget: 128 * 1024,
    deadline_at: Date.now() + 30_000,
  };
}

class FakeSocket {
  readyState = 1;
  sent = [];
  listeners = new Map();
  send(value) { this.sent.push(value); }
  close(code, reason) { this.closed = { code, reason }; this.readyState = 3; this.emit("close", { code, reason }); }
  addEventListener(type, listener) { const list = this.listeners.get(type) ?? []; list.push(listener); this.listeners.set(type, list); }
  receive(frame) { this.emit("message", { data: JSON.stringify(frame) }); }
  emit(type, event) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  frames() { return this.sent.map((value) => JSON.parse(value)); }
}

class DelayedCloseSocket extends FakeSocket {
  close(code, reason) { this.closed = { code, reason }; this.readyState = 2; }
  finishClose() { this.readyState = 3; this.emit("close", this.closed); }
}

class CloudflareSocket extends FakeSocket {
  accept() {}
  close(code, reason) { this.closed = { code, reason }; this.readyState = 2; }
}

class NodeStyleSocket {
  readyState = 1;
  sent = [];
  listeners = new Map();
  send(value) { this.sent.push(value); }
  close(code, reason) { this.closed = { code, reason }; this.readyState = 3; this.emit("close", code, reason); }
  on(type, listener) { const list = this.listeners.get(type) ?? []; list.push(listener); this.listeners.set(type, list); }
  receive(frame, binary = false) { this.emit("message", Buffer.from(JSON.stringify(frame)), binary); }
  emit(type, ...args) { for (const listener of this.listeners.get(type) ?? []) listener(...args); }
  frames() { return this.sent.map((value) => JSON.parse(value)); }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor(predicate) {
  for (let index = 0; index < 100; index++) { if (predicate()) return; await tick(); }
  throw new Error("condition did not become true");
}
